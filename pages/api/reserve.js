// pages/api/reserve.js
//
// Insert booking into Caspio BAR2_Reservations_SIGMA,
// then read back the generated IDKEY by using a unique placeholder token.
//
// Fixes:
// ✅ CORS allows both www and non-www
// ✅ OPTIONS preflight handled
// ✅ Does NOT write IDKEY (often read-only / computed in Caspio)
// ✅ Writes a unique placeholder StripeCheckoutSessionId as correlation token
// ✅ Reads back IDKEY by querying for StripeCheckoutSessionId placeholder
// ✅ Retries once if Caspio reports "read-only fields" by trimming them

export const config = { api: { bodyParser: true } };

const CASPIO_BASE = "https://c0gfs257.caspio.com/rest/v2";
const CASPIO_OAUTH = "https://c0gfs257.caspio.com/oauth/token";

const TABLE = process.env.CASPIO_TABLE || "BAR2_Reservations_SIGMA";

// Allow both origins (your site is currently www)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || [
  "https://reservebarsandrec.com",
  "https://www.reservebarsandrec.com",
]).toString().split(",").map(s => s.trim()).filter(Boolean);

function setCors(res, origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

function normalizePhone(v) {
  const s = String(v || "").trim();
  const plus = s.startsWith("+") ? "+" : "";
  const digits = s.replace(/\D/g, "");
  return plus + digits;
}

function escWhereValue(v) {
  return String(v ?? "").replace(/'/g, "''");
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) {
    const msg = j?.Message || j?.error_description || j?.error || text || `${r.status}`;
    throw new Error(String(msg).slice(0, 800));
  }
  return j;
}

async function getCaspioToken() {
  if (!process.env.CASPIO_CLIENT_ID) throw new Error("Missing CASPIO_CLIENT_ID");
  if (!process.env.CASPIO_CLIENT_SECRET) throw new Error("Missing CASPIO_CLIENT_SECRET");

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", process.env.CASPIO_CLIENT_ID);
  body.set("client_secret", process.env.CASPIO_CLIENT_SECRET);

  const tok = await fetchJson(CASPIO_OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!tok?.access_token) throw new Error("Caspio token missing access_token");
  return tok.access_token;
}

async function caspioInsert(table, token, payload) {
  return await fetchJson(`${CASPIO_BASE}/tables/${encodeURIComponent(table)}/records`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function caspioGet(table, token, where, select) {
  const qWhere = encodeURIComponent(where);
  const qSel = encodeURIComponent(select);
  const url =
    `${CASPIO_BASE}/tables/${encodeURIComponent(table)}/records` +
    `?q.where=${qWhere}&q.select=${qSel}&q.limit=1`;
  return await fetchJson(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * If Caspio says some fields are read-only, attempt to infer field names (best-effort),
 * remove them, and retry ONCE.
 *
 * Caspio errors are not always consistent about listing names, so we also allow
 * an explicit "hard blocklist" if needed later.
 */
function extractPossibleReadOnlyFields(message) {
  const msg = String(message || "");
  const fields = new Set();

  // Sometimes Caspio includes quoted field names in the message
  for (const m of msg.matchAll(/'([^']+)'/g)) {
    const name = m[1];
    if (name && name.length < 80) fields.add(name);
  }

  return Array.from(fields);
}

async function insertResilient(table, token, payload) {
  try {
    return await caspioInsert(table, token, payload);
  } catch (err) {
    const msg = String(err?.message || "");
    if (!/read-only/i.test(msg)) throw err;

    // Try trimming any mentioned fields
    const ro = extractPossibleReadOnlyFields(msg);
    const trimmed = { ...payload };
    for (const f of ro) delete trimmed[f];

    // If message didn’t name fields, we still do a safe fallback trim set
    // based on the most common read-only culprits in reservation schemas.
    // (This does NOT move your UI around; it just makes insert succeed.)
    const fallbackTrim = [
      "IDKEY",
      "Confirmation_Number",
      "Transaction_ID",
      "Transaction_date",
      "BookingFeePaidAt",
      "CreatedAt",
      "UpdatedAt",
    ];
    for (const f of fallbackTrim) delete trimmed[f];

    // If we didn't remove anything, rethrow original
    if (Object.keys(trimmed).length === Object.keys(payload).length) throw err;

    return await caspioInsert(table, token, trimmed);
  }
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "reserve" });
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const b = req.body || {};

    // ---- Validate required fields (minimal + your flow requirements) ----
    const First_Name = oneLine(b.First_Name);
    const Last_Name  = oneLine(b.Last_Name);
    const Email      = oneLine(b.Email);
    const Phone_Number = oneLine(b.Phone_Number);

    if (!First_Name) return res.status(400).json({ ok:false, error:"Missing First_Name" });
    if (!Last_Name)  return res.status(400).json({ ok:false, error:"Missing Last_Name" });
    if (!Email || !isValidEmail(Email)) return res.status(400).json({ ok:false, error:"Missing/invalid Email" });

    const phoneNorm = normalizePhone(Phone_Number);
    if (!Phone_Number || phoneNorm.replace(/\D/g, "").length < 10) {
      return res.status(400).json({ ok:false, error:"Missing/invalid Phone_Number" });
    }

    const Business_Unit = oneLine(b.Business_Unit);
    const Session_Date  = oneLine(b.Session_Date);
    const Session_ID    = oneLine(b.Session_ID);

    if (!Business_Unit) return res.status(400).json({ ok:false, error:"Missing Business_Unit" });
    if (!Session_Date)  return res.status(400).json({ ok:false, error:"Missing Session_Date" });
    if (!Session_ID)    return res.status(400).json({ ok:false, error:"Missing Session_ID" });

    const Charge_Type = oneLine(b.Charge_Type);
    if (!Charge_Type) return res.status(400).json({ ok:false, error:"Missing Charge_Type" });

    const BookingFeeAmount = Number(b.BookingFeeAmount);
    if (!Number.isFinite(BookingFeeAmount) || BookingFeeAmount <= 0) {
      return res.status(400).json({ ok:false, error:"Missing/invalid BookingFeeAmount" });
    }

    // ---- Correlation token used to find the inserted row ----
    // Must be UNIQUE (so Caspio unique constraint is satisfied and lookup is reliable)
    const correlation = `pending_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    // ---- Build insert payload (avoid IDKEY) ----
    const payload = {
      // DO NOT send IDKEY here — let Caspio generate it if it's computed.

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

      Item: oneLine(b.Item),
      Price_Class: oneLine(b.Price_Class),
      Sessions_Title: oneLine(b.Sessions_Title),

      C_Quant: oneLine(b.C_Quant),
      Units: oneLine(b.Units),
      Unit_Price: oneLine(b.Unit_Price),

      People_Text: oneLine(b.People_Text),
      BookingFeeAmount,

      // placeholder fields (if writable) — used for uniqueness + lookup
      StripeCheckoutSessionId: correlation,
      StripePaymentIntentId: correlation,
    };

    const token = await getCaspioToken();

    // Insert (resilient to read-only fields)
    await insertResilient(TABLE, token, payload);

    // Read back the generated IDKEY using the correlation token
    const where = `StripeCheckoutSessionId='${escWhereValue(correlation)}'`;
    const got = await caspioGet(TABLE, token, where, "IDKEY,RES_ID,Session_ID,Session_Date,Email");

    const row = got?.Result?.[0] || null;
    const idkey = row?.IDKEY || null;

    if (!idkey) {
      // If Caspio stripped StripeCheckoutSessionId as read-only, lookup will fail.
      // In that case, throw a clear message so you know which field is read-only.
      throw new Error(
        "Insert succeeded but could not read back IDKEY. " +
        "This usually means StripeCheckoutSessionId is read-only OR Caspio did not save it. " +
        "Make StripeCheckoutSessionId writable (not computed) or provide a dedicated writable correlation field."
      );
    }

    return res.status(200).json({ ok: true, idkey });
  } catch (err) {
    console.error("reserve.js error:", err?.message || err);
    return res.status(500).json({ ok:false, error: err?.message || "Server error" });
  }
}
