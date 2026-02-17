// pages/api/reserve.js
//
// Creates a NEW reservation row in Caspio (BAR2_Reservations_SIGMA) and returns { idkey, res_id }.
// - Sets Status = "In Process"
// - Sets Type = "Reservation"
// - Generates RES_ID (12-char alphanumeric) on insert
// - Optionally writes placeholder StripeCheckoutSessionId / StripePaymentIntentId (unique “correlation”)
//   If those fields are read-only or missing, it retries without them.
//
// REQUIRED ENVs (recommended):
//   CASPIO_CLIENT_ID
//   CASPIO_CLIENT_SECRET
// Optional ENVs:
//   CASPIO_ACCOUNT_DOMAIN   (default: c0gfs257.caspio.com)
//   CASPIO_TABLE            (default: BAR2_Reservations_SIGMA)
//   ALLOWED_ORIGIN          (default: https://www.reservebarsandrec.com)

const CASPIO_ACCOUNT_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN || "c0gfs257.caspio.com";
const CASPIO_BASE = `https://${CASPIO_ACCOUNT_DOMAIN}/rest/v2`;
const CASPIO_TOKEN_URL = `https://${CASPIO_ACCOUNT_DOMAIN}/oauth/token`;

const TABLE = process.env.CASPIO_TABLE || "BAR2_Reservations_SIGMA";

function setCors(res, origin) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://www.reservebarsandrec.com";
  const allowOrigin = origin && origin === allowed ? origin : allowed;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizePhone(v) {
  const s = String(v || "").trim();
  const plus = s.startsWith("+") ? "+" : "";
  const digits = s.replace(/\D/g, "");
  return plus + digits;
}

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

function makeResId(len = 12) {
  // excludes 0,1,I,O for readability
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function makeCorrelationId() {
  // 24 chars-ish: time + random, safe for unique placeholder fields
  const a = Date.now().toString(36);
  const b = Math.random().toString(36).slice(2, 10);
  const c = Math.random().toString(36).slice(2, 10);
  return `init_${a}_${b}${c}`.slice(0, 48);
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {}
  if (!r.ok) {
    const msg =
      j?.Message ||
      j?.message ||
      j?.error_description ||
      j?.error ||
      text ||
      `${r.status}`;
    const err = new Error(String(msg).slice(0, 700));
    err.status = r.status;
    err.raw = { text, json: j };
    throw err;
  }
  return j;
}

async function getCaspioToken() {
  if (!process.env.CASPIO_CLIENT_ID) throw new Error("Missing CASPIO_CLIENT_ID");
  if (!process.env.CASPIO_CLIENT_SECRET) throw new Error("Missing CASPIO_CLIENT_SECRET");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.CASPIO_CLIENT_ID,
    client_secret: process.env.CASPIO_CLIENT_SECRET,
  });

  const j = await fetchJson(CASPIO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!j.access_token) throw new Error("Caspio token response missing access_token");
  return j.access_token;
}

async function caspioInsertRecord(token, payload) {
  return await fetchJson(`${CASPIO_BASE}/tables/${encodeURIComponent(TABLE)}/records`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Insert with resilience:
 * - If Caspio complains about read-only fields, retry once WITHOUT Stripe placeholder fields.
 * - If Caspio complains about ColumnNotFound, retry once removing the named fields (if included).
 * - If Caspio complains about duplicate RES_ID, regenerate RES_ID and retry (up to 5 tries).
 */
async function insertReservationResilient(token, basePayload) {
  let payload = { ...basePayload };

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await caspioInsertRecord(token, payload);
    } catch (err) {
      const msg = String(err?.message || "");

      // Duplicate RES_ID (or some other unique) -> regenerate RES_ID and retry
      if (/duplicate/i.test(msg) && /RES_ID/i.test(msg)) {
        payload.RES_ID = makeResId(12);
        continue;
      }

      // Read-only fields -> retry once dropping Stripe placeholders
      if (/read-only/i.test(msg)) {
        const trimmed = { ...payload };
        delete trimmed.StripeCheckoutSessionId;
        delete trimmed.StripePaymentIntentId;

        // If we already removed them, stop looping
        const alreadyRemoved =
          payload.StripeCheckoutSessionId == null && payload.StripePaymentIntentId == null;

        if (alreadyRemoved) throw err;

        payload = trimmed;
        // retry immediately (don’t consume a RES_ID regeneration attempt)
        continue;
      }

      // ColumnNotFound -> try to strip named fields if Caspio tells us which
      if (/ColumnNotFound/i.test(msg) || /do not exist/i.test(msg)) {
        const after = msg.split("do not exist:")[1] || "";
        const missing = [];
        for (const m of after.matchAll(/'([^']+)'/g)) missing.push(m[1]);

        if (missing.length) {
          const trimmed = { ...payload };
          for (const f of missing) delete trimmed[f];
          if (Object.keys(trimmed).length === 0) throw err;
          payload = trimmed;
          continue;
        }
      }

      // Otherwise, fail
      throw err;
    }
  }

  throw new Error("Insert failed after multiple attempts (RES_ID collisions).");
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "reserve" });
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const b = req.body || {};

    // ---- Required from UI ----
    const First_Name = oneLine(b.First_Name);
    const Last_Name = oneLine(b.Last_Name);
    const Email = oneLine(b.Email);
    const Phone_Number = oneLine(b.Phone_Number);

    const Business_Unit = oneLine(b.Business_Unit);
    const Session_Date = oneLine(b.Session_Date);
    const Session_ID = oneLine(b.Session_ID);

    const Item = oneLine(b.Item);
    const Price_Class = oneLine(b.Price_Class);
    const Sessions_Title = oneLine(b.Sessions_Title);

    const C_Quant = oneLine(b.C_Quant);
    const Units = oneLine(b.Units);
    const Unit_Price = oneLine(b.Unit_Price);

    const Charge_Type = oneLine(b.Charge_Type); // must be "Pay Now" or "24 Hour Hold Fee" per your UI
    const BookingFeeAmount = Number(b.BookingFeeAmount);

    // ---- Basic validation (keep it light) ----
    if (!First_Name) return res.status(400).json({ ok: false, error: "Missing First_Name" });
    if (!Last_Name) return res.status(400).json({ ok: false, error: "Missing Last_Name" });
    if (!Email || !isValidEmail(Email)) return res.status(400).json({ ok: false, error: "Missing/invalid Email" });

    const phoneNorm = normalizePhone(Phone_Number);
    if (!phoneNorm || phoneNorm.replace(/\D/g, "").length < 10) {
      return res.status(400).json({ ok: false, error: "Missing/invalid Phone_Number" });
    }

    if (!Business_Unit) return res.status(400).json({ ok: false, error: "Missing Business_Unit" });
    if (!Session_Date) return res.status(400).json({ ok: false, error: "Missing Session_Date" });
    if (!Session_ID) return res.status(400).json({ ok: false, error: "Missing Session_ID" });

    if (!Charge_Type) return res.status(400).json({ ok: false, error: "Missing Charge_Type" });
    if (!Number.isFinite(BookingFeeAmount) || BookingFeeAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Missing/invalid BookingFeeAmount (> 0 required)" });
    }

    // ---- Generate IDs ----
    const RES_ID = makeResId(12);
    const correlation = makeCorrelationId();

    // ---- Build payload (ONLY fields you intend to write) ----
    const payload = {
      RES_ID,

      Status: "In Process",
      Type: "Reservation",

      First_Name,
      Last_Name,
      Email,
      Phone_Number: phoneNorm,

      Cancelation_Policy: oneLine(b.Cancelation_Policy || "Agreed"),
      Charge_Type,
      Cust_Notes: oneLine(b.Cust_Notes),

      Business_Unit,
      Session_Date,
      Session_ID,

      Item,
      Price_Class,
      Sessions_Title,

      C_Quant,
      Units,
      Unit_Price,

      People_Text: oneLine(b.People_Text),
      BookingFeeAmount,

      // Placeholders to avoid blank/duplicate issues on unique fields
      StripeCheckoutSessionId: correlation,
      StripePaymentIntentId: correlation,
    };

    const token = await getCaspioToken();
    const insertJson = await insertReservationResilient(token, payload);

    // Caspio insert response shape varies; try common patterns
    const inserted = insertJson?.Result || insertJson?.result || insertJson;

    const idkey =
      inserted?.IDKEY ||
      inserted?.IdKey ||
      inserted?.idkey ||
      inserted?.IDKey ||
      null;

    // If IDKEY isn’t returned, still return RES_ID so you can debug,
    // but typically Caspio will return computed/generated fields.
    if (!idkey) {
      return res.status(200).json({
        ok: true,
        idkey: null,
        res_id: RES_ID,
        note: "Inserted, but IDKEY was not returned by Caspio response.",
        raw: inserted || null,
      });
    }

    return res.status(200).json({
      ok: true,
      idkey: String(idkey),
      res_id: RES_ID,
    });
  } catch (err) {
    console.error("RESERVE_FAILED:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Server error",
    });
  }
}
