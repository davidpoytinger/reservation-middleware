// pages/api/reserve.js
//
// Weebly booking UI -> POST /api/reserve
// Inserts a new Reservation row in BAR2_Reservations_SIGMA with:
//   - Status: "In Process"
//   - Type:   "Reservation"
// Returns: { ok:true, idkey:"..." }
//
// ✅ Fixes "Failed to fetch" by handling CORS + OPTIONS preflight
// ✅ Allows both https://reservebarsandrec.com and https://www.reservebarsandrec.com
// ✅ Retries once if Caspio returns ColumnNotFound (drops missing fields)
// ✅ Generates IDKEY server-side if not provided
//
// NOTE: This file uses Caspio REST + OAuth client credentials.
// Ensure these env vars exist in Vercel:
//   CASPIO_CLIENT_ID
//   CASPIO_CLIENT_SECRET
//   CASPIO_BASE   (optional; default https://c0gfs257.caspio.com)
//   CASPIO_TABLE  (optional; default BAR2_Reservations_SIGMA)

const CASPIO_OAUTH_PATH = "/oauth/token";
const DEFAULT_CASPIO_BASE = "https://c0gfs257.caspio.com";
const DEFAULT_TABLE = "BAR2_Reservations_SIGMA";

function setCors(res, origin) {
  const allowed = [
    "https://reservebarsandrec.com",
    "https://www.reservebarsandrec.com",
  ];

  const allowOrigin = allowed.includes(origin) ? origin : allowed[0];

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function escWhereValue(v) {
  return String(v ?? "").replaceAll("'", "''");
}

function safeJsonParse(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function makeIdKey(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoid O/0, I/1
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function fetchText(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  return { r, text };
}

async function getCaspioToken() {
  const base = String(process.env.CASPIO_BASE || DEFAULT_CASPIO_BASE).replace(/\/+$/, "");
  const clientId = process.env.CASPIO_CLIENT_ID;
  const clientSecret = process.env.CASPIO_CLIENT_SECRET;

  if (!clientId) throw new Error("Missing CASPIO_CLIENT_ID");
  if (!clientSecret) throw new Error("Missing CASPIO_CLIENT_SECRET");

  const url = base + CASPIO_OAUTH_PATH;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const { r, text } = await fetchText(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const j = safeJsonParse(text) || {};
  if (!r.ok || !j.access_token) {
    const msg = j.error_description || j.error || text || `Token error ${r.status}`;
    throw new Error(String(msg).slice(0, 500));
  }
  return { token: j.access_token, base };
}

async function caspioRequest(base, token, path, opts = {}) {
  const url = base.replace(/\/+$/, "") + "/rest/v2" + path;
  const { r, text } = await fetchText(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });

  const j = safeJsonParse(text);
  if (!r.ok) {
    const msg =
      (j && (j.Message || j.message)) ||
      text ||
      `${r.status} ${r.statusText}`;
    throw new Error(String(msg).slice(0, 800));
  }
  return j ?? {};
}

/**
 * If Caspio responds with ColumnNotFound, drop those fields and retry once.
 */
async function insertResilient({ base, token, table, payload }) {
  try {
    return await caspioRequest(base, token, `/tables/${encodeURIComponent(table)}/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (!/ColumnNotFound/i.test(msg) && !/do not exist/i.test(msg)) throw err;

    const after = msg.split("do not exist:")[1] || "";
    const missing = [];
    for (const m of after.matchAll(/'([^']+)'/g)) missing.push(m[1]);
    if (!missing.length) throw err;

    const trimmed = { ...payload };
    for (const f of missing) delete trimmed[f];
    if (Object.keys(trimmed).length === 0) throw err;

    console.warn("⚠️ Caspio ColumnNotFound. Retrying insert without fields:", missing);

    return await caspioRequest(base, token, `/tables/${encodeURIComponent(table)}/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trimmed),
    });
  }
}

async function getReservationByIdKey({ base, token, table, idkey }) {
  const where = `IDKEY='${escWhereValue(idkey)}' AND Type='Reservation'`;
  const select = [
    "IDKEY",
    "RES_ID",
    "Confirmation_Number",
    "Status",
    "Type",
    "Email",
    "BookingFeeAmount",
    "StripeCheckoutSessionId",
  ].join(",");

  return await caspioRequest(
    base,
    token,
    `/tables/${encodeURIComponent(table)}/records?q.where=${encodeURIComponent(where)}&q.limit=1&q.select=${encodeURIComponent(select)}`,
    { method: "GET" }
  );
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "reserve" });
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const table = process.env.CASPIO_TABLE || DEFAULT_TABLE;

    // Accept JSON body (Vercel parses automatically for POST w/ application/json)
    const body = req.body || {};

    // Required (from your booking widget)
    const First_Name = oneLine(body.First_Name);
    const Last_Name = oneLine(body.Last_Name);
    const Email = oneLine(body.Email);
    const Phone_Number = oneLine(body.Phone_Number);

    const Business_Unit = oneLine(body.Business_Unit);
    const Session_Date = oneLine(body.Session_Date);
    const Session_ID = oneLine(body.Session_ID);

    const Item = oneLine(body.Item);
    const Price_Class = oneLine(body.Price_Class);
    const Sessions_Title = oneLine(body.Sessions_Title);

    const C_Quant = oneLine(body.C_Quant);
    const Units = oneLine(body.Units);
    const Unit_Price = body.Unit_Price ?? "";

    const People_Text = oneLine(body.People_Text);
    const Charge_Type = oneLine(body.Charge_Type);

    // BookingFeeAmount is "due today" and MUST be > 0 for your /api/paystart logic
    const BookingFeeAmount = Number(body.BookingFeeAmount);

    // Optional
    const Cust_Notes = String(body.Cust_Notes ?? "").trim();
    const Cancelation_Policy = oneLine(body.Cancelation_Policy) || "";
    const idkeyIncoming = oneLine(body.IDKEY || body.idkey || "");

    // Server-side enforcement of your business rules
    if (!First_Name) return res.status(400).json({ ok: false, error: "Missing First_Name" });
    if (!Last_Name) return res.status(400).json({ ok: false, error: "Missing Last_Name" });
    if (!Email) return res.status(400).json({ ok: false, error: "Missing Email" });
    if (!Phone_Number) return res.status(400).json({ ok: false, error: "Missing Phone_Number" });

    if (!Business_Unit) return res.status(400).json({ ok: false, error: "Missing Business_Unit" });
    if (!Session_Date) return res.status(400).json({ ok: false, error: "Missing Session_Date" });
    if (!Session_ID) return res.status(400).json({ ok: false, error: "Missing Session_ID" });

    if (!Item) return res.status(400).json({ ok: false, error: "Missing Item" });
    if (!Price_Class) return res.status(400).json({ ok: false, error: "Missing Price_Class" });
    if (!Sessions_Title) return res.status(400).json({ ok: false, error: "Missing Sessions_Title" });

    if (!C_Quant) return res.status(400).json({ ok: false, error: "Missing C_Quant" });
    if (!Units) return res.status(400).json({ ok: false, error: "Missing Units" });

    if (!Charge_Type) return res.status(400).json({ ok: false, error: "Missing Charge_Type" });
    if (!Number.isFinite(BookingFeeAmount) || BookingFeeAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Missing/invalid BookingFeeAmount" });
    }

    // Policy checkbox gate (you can loosen this if needed)
    if (!Cancelation_Policy) {
      return res.status(400).json({ ok: false, error: "Missing Cancelation_Policy" });
    }

    const { token, base } = await getCaspioToken();

    const idkey = idkeyIncoming || makeIdKey(10);

    const payload = {
      // Core identity
      IDKEY: idkey,
      Type: "Reservation",
      Status: "In Process",

      // Contact
      First_Name,
      Last_Name,
      Email,
      Phone_Number,

      // Booking details
      Business_Unit,
      Session_Date,
      Session_ID,
      Item,
      Price_Class,
      Sessions_Title,

      C_Quant,
      Units,
      Unit_Price,

      People_Text,

      // Money due today (used by /api/paystart)
      BookingFeeAmount,

      // Policy / payment choice
      Charge_Type,
      Cancelation_Policy,

      // Notes
      Cust_Notes,
    };

    // Insert into Caspio
    await insertResilient({ base, token, table, payload });

    // Best-effort lookup to confirm insert + return RES_ID if available
    let lookup = null;
    try {
      lookup = await getReservationByIdKey({ base, token, table, idkey });
    } catch (e) {
      console.warn("⚠️ Post-insert lookup failed (non-blocking):", e?.message);
    }

    const row = lookup?.Result?.[0] || null;

    return res.status(200).json({
      ok: true,
      idkey,
      res_id: row?.RES_ID ?? null,
      confirmation: row?.Confirmation_Number ?? null,
      status: row?.Status ?? "In Process",
    });
  } catch (err) {
    console.error("❌ /api/reserve failed:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message || "Server error").slice(0, 600),
    });
  }
}
