// pages/api/reserve.js
//
// Creates a new reservation row in Caspio (BAR2_Reservations_SIGMA).
// Called by your front-end booking UI.
// Flow: UI -> POST /api/reserve -> returns {idkey} -> redirect to /api/paystart?idkey=...
//
// Key behaviors:
// ✅ Status forced to "In Process"
// ✅ Type forced to "Reservation"
// ✅ DOES NOT set StripeCheckoutSessionId / StripePaymentIntentId (avoids unique/blank issues)
// ✅ CORS for reservebarsandrec.com
// ✅ Resilient retry if Caspio says ColumnNotFound or read-only fields

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

function setCors(res, origin) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://reservebarsandrec.com";
  const allowOrigin = origin && origin === allowed ? origin : allowed;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function safeString(s, max = 255) {
  const v = String(s ?? "").trim();
  return v.length > max ? v.slice(0, max) : v;
}

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function caspioAccountBase() {
  // Prefer explicit CASPIO_BASE, else build from CASPIO_ACCOUNT
  const base =
    process.env.CASPIO_BASE ||
    (process.env.CASPIO_ACCOUNT ? `https://${process.env.CASPIO_ACCOUNT}.caspio.com` : "");
  if (!base) throw new Error("Missing CASPIO_BASE or CASPIO_ACCOUNT env var.");
  return base.replace(/\/+$/, "");
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    // non-json error
  }
  if (!r.ok) {
    const msg = j?.Message || j?.error_description || j?.error || text || `${r.status}`;
    throw new Error(String(msg).slice(0, 800));
  }
  return j;
}

async function getCaspioToken() {
  const clientId = process.env.CASPIO_CLIENT_ID;
  const clientSecret = process.env.CASPIO_CLIENT_SECRET;
  if (!clientId) throw new Error("Missing CASPIO_CLIENT_ID");
  if (!clientSecret) throw new Error("Missing CASPIO_CLIENT_SECRET");

  const base = caspioAccountBase();
  const tokenUrl = `${base}/oauth/token`;

  // Caspio OAuth client_credentials
  const form = new URLSearchParams();
  form.set("grant_type", "client_credentials");
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);

  const j = await fetchJson(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!j.access_token) throw new Error("Caspio token response missing access_token");
  return j.access_token;
}

function stripDangerousFields(payload) {
  // Fields you never want to write from the browser at insert time
  const deny = new Set([
    "IDKEY",
    "Confirmation_Number",

    "StripeCheckoutSessionId",
    "StripePaymentIntentId",
    "StripeChargeId",
    "StripeRefundId",

    "BookingFeePaidAt",

    "Transaction_ID",
    "Transaction_date",

    "CreatedAt",
    "UpdatedAt",

    // if you have any computed/readonly variants
    "StripePolicyPaymentIntentId",
  ]);

  const out = { ...payload };
  for (const k of Object.keys(out)) {
    if (deny.has(k)) delete out[k];
  }
  return out;
}

/**
 * If Caspio responds with ColumnNotFound, remove missing fields and retry once.
 * If Caspio responds with read-only, remove known computed fields and retry once.
 */
async function caspioInsertResilient({ table, token, payload }) {
  const base = caspioAccountBase();
  const restBase = `${base}/rest/v2`;

  async function doInsert(body) {
    return await fetchJson(`${restBase}/tables/${table}/records`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  try {
    return await doInsert(payload);
  } catch (err) {
    const msg = String(err?.message || "");

    // 1) ColumnNotFound parsing
    if (/ColumnNotFound/i.test(msg) || /do not exist/i.test(msg)) {
      const after = msg.split("do not exist:")[1] || "";
      const missing = [];
      for (const m of after.matchAll(/'([^']+)'/g)) missing.push(m[1]);

      if (!missing.length) throw err;

      const trimmed = { ...payload };
      for (const f of missing) delete trimmed[f];

      if (Object.keys(trimmed).length === 0) throw err;

      console.warn("⚠️ Caspio ColumnNotFound. Retrying without fields:", missing);
      return await doInsert(trimmed);
    }

    // 2) read-only hint (Caspio often doesn't list fields)
    if (/read-?only/i.test(msg)) {
      // Remove a broader set of typical computed fields and retry once
      const trimmed = { ...payload };
      const commonComputed = [
        "IDKEY",
        "Confirmation_Number",
        "StripeCheckoutSessionId",
        "StripePaymentIntentId",
        "BookingFeePaidAt",
        "Transaction_ID",
        "Transaction_date",
        "CreatedAt",
        "UpdatedAt",
      ];
      for (const f of commonComputed) delete trimmed[f];

      // also strip anything starting with "cb" if somehow present
      for (const k of Object.keys(trimmed)) {
        if (/^cb/i.test(k)) delete trimmed[k];
      }

      if (Object.keys(trimmed).length === 0) throw err;

      console.warn("⚠️ Caspio read-only error. Retrying with trimmed payload.");
      return await doInsert(trimmed);
    }

    throw err;
  }
}

function buildInsertPayload(body) {
  // Only accept what you expect from the booking UI.
  // Everything else is ignored.

  const payload = {
    // Force the workflow fields
    Status: "In Process",
    Type: "Reservation",

    // Contact
    First_Name: safeString(body.First_Name, 80),
    Last_Name: safeString(body.Last_Name, 80),
    Email: safeString(body.Email, 160),
    Phone_Number: safeString(body.Phone_Number, 40),

    // Booking choices
    Business_Unit: safeString(body.Business_Unit, 40),
    Session_Date: safeString(body.Session_Date, 10),
    Session_ID: safeString(body.Session_ID, 80),

    Item: safeString(body.Item, 120),
    Price_Class: safeString(body.Price_Class, 80),
    Sessions_Title: safeString(body.Sessions_Title, 255),

    C_Quant: safeString(body.C_Quant, 40),
    Units: safeString(body.Units, 40),
    Unit_Price: safeString(body.Unit_Price, 40),

    People_Text: safeString(body.People_Text, 255),

    // Policy / payment selection
    Cancelation_Policy: safeString(body.Cancelation_Policy, 60), // e.g. "Agreed"
    Charge_Type: safeString(body.Charge_Type, 120),              // "Pay Now" or "24 Hour Hold Fee"
    Cust_Notes: safeString(body.Cust_Notes, 4000),

    // This is what paystart uses as BookingFeeAmount
    BookingFeeAmount: safeNumber(body.BookingFeeAmount),
  };

  // Remove empties (Caspio is usually fine either way, but this helps)
  for (const [k, v] of Object.entries(payload)) {
    if (v === "" || v === null || v === undefined) delete payload[k];
  }

  // Strip fields that must never be written at insert time
  return stripDangerousFields(payload);
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "reserve" });
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const table = process.env.CASPIO_TABLE || "BAR2_Reservations_SIGMA";

    const body = req.body || {};
    const payload = buildInsertPayload(body);

    // Basic validation (keep it tight—UI already validates, but don't trust it)
    if (!payload.Email) return res.status(400).json({ ok: false, error: "Missing Email" });
    if (!payload.First_Name) return res.status(400).json({ ok: false, error: "Missing First_Name" });
    if (!payload.Last_Name) return res.status(400).json({ ok: false, error: "Missing Last_Name" });
    if (!payload.Phone_Number) return res.status(400).json({ ok: false, error: "Missing Phone_Number" });

    if (!payload.Session_Date) return res.status(400).json({ ok: false, error: "Missing Session_Date" });
    if (!payload.Business_Unit) return res.status(400).json({ ok: false, error: "Missing Business_Unit" });
    if (!payload.Session_ID) return res.status(400).json({ ok: false, error: "Missing Session_ID" });

    if (!payload.Charge_Type) return res.status(400).json({ ok: false, error: "Missing Charge_Type" });

    // Paystart requires BookingFeeAmount > 0
    if (!Number.isFinite(payload.BookingFeeAmount) || payload.BookingFeeAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Missing/invalid BookingFeeAmount" });
    }

    const token = await getCaspioToken();

    const inserted = await caspioInsertResilient({
      table,
      token,
      payload,
    });

    // Caspio POST usually returns created record fields; try common shapes
    const idkey =
      inserted?.IDKEY ||
      inserted?.IdKey ||
      inserted?.idkey ||
      inserted?.Result?.IDKEY ||
      inserted?.Result?.[0]?.IDKEY ||
      null;

    if (!idkey) {
      // If Caspio doesn't return IDKEY, you can still succeed,
      // but your front-end needs idkey to continue. So we fail loudly.
      return res.status(500).json({
        ok: false,
        error:
          "Insert succeeded but IDKEY was not returned. Ensure Caspio REST insert returns IDKEY, or fetch it by another key.",
        inserted,
      });
    }

    return res.status(200).json({
      ok: true,
      idkey: String(idkey),
    });
  } catch (err) {
    console.error("❌ /api/reserve failed:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: oneLine(err?.message || "Server error"),
    });
  }
}
