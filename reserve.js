// pages/api/reserve.js
//
// Creates a NEW reservation record in BAR2_Reservations_SIGMA
// - Status = "In Process" (pre-payment)
// - Type   = "Reservation"
// Returns { ok, idkey, res_id }.
// Front-end then redirects to /api/paystart?idkey=...

const CASPIO_BASE = "https://c0gfs257.caspio.com/rest/v2";
const TABLE = "BAR2_Reservations_SIGMA";

function setCors(res, origin) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://reservebarsandrec.com";
  const allowOrigin = origin && origin === allowed ? origin : allowed;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function randIdKey(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
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

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) {
    const msg = j?.Message || j?.error_description || j?.error || text || `${r.status}`;
    throw new Error(oneLine(msg).slice(0, 500));
  }
  return j;
}

async function getCaspioToken() {
  // Uses Client Credentials flow
  if (!process.env.CASPIO_CLIENT_ID) throw new Error("Missing CASPIO_CLIENT_ID");
  if (!process.env.CASPIO_CLIENT_SECRET) throw new Error("Missing CASPIO_CLIENT_SECRET");

  const tokenUrl = "https://c0gfs257.caspio.com/oauth/token";
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", process.env.CASPIO_CLIENT_ID);
  params.set("client_secret", process.env.CASPIO_CLIENT_SECRET);

  const j = await fetchJson(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!j.access_token) throw new Error("Token response missing access_token.");
  return j.access_token;
}

async function caspioPost(path, token, body) {
  return await fetchJson(`${CASPIO_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * If Caspio returns ColumnNotFound, drop those fields and retry once.
 * (Same spirit as your webhook resilient updater.)
 */
async function caspioPostResilient(path, token, body) {
  try {
    return await caspioPost(path, token, body);
  } catch (err) {
    const msg = String(err?.message || "");
    if (!/ColumnNotFound/i.test(msg) && !/do not exist/i.test(msg)) throw err;

    const after = msg.split("do not exist:")[1] || "";
    const missing = [];
    for (const m of after.matchAll(/'([^']+)'/g)) missing.push(m[1]);
    if (!missing.length) throw err;

    const trimmed = { ...body };
    for (const f of missing) delete trimmed[f];
    if (Object.keys(trimmed).length === 0) throw err;

    console.warn("⚠️ Caspio ColumnNotFound on INSERT. Retrying without fields:", missing);
    return await caspioPost(path, token, trimmed);
  }
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const b = req.body || {};

    // Customer-visible fields
    const First_Name = String(b.First_Name ?? "").trim();
    const Last_Name = String(b.Last_Name ?? "").trim();
    const Email = String(b.Email ?? "").trim();
    const Phone_Number = String(b.Phone_Number ?? "").trim();

    const Charge_Type = String(b.Charge_Type ?? "").trim(); // required
    const Cancelation_Policy = String(b.Cancelation_Policy ?? "").trim(); // required
    const Cust_Notes = String(b.Cust_Notes ?? "").trim(); // optional

    // Selected session/package fields
    const Business_Unit = String(b.Business_Unit ?? "").trim();
    const Session_Date = String(b.Session_Date ?? "").trim().slice(0, 10);
    const Session_ID = String(b.Session_ID ?? "").trim();

    const Item = String(b.Item ?? "").trim();
    const Price_Class = String(b.Price_Class ?? "").trim();
    const Sessions_Title = String(b.Sessions_Title ?? "").trim();

    const C_Quant = String(b.C_Quant ?? "").trim();
    const Units = String(b.Units ?? "").trim();
    const Unit_Price = String(b.Unit_Price ?? "").trim();

    // Helpers for Stripe/paystart
    const People_Text = String(b.People_Text ?? "").trim();
    const BookingFeeAmount = Number(b.BookingFeeAmount);

    // ---- validation (match what your Caspio page enforces) ----
    if (!First_Name || !Last_Name) return res.status(400).json({ error: "First/Last name required." });
    if (!Email || !isValidEmail(Email)) return res.status(400).json({ error: "Valid email required." });

    const phoneDigits = normalizePhone(Phone_Number).replace(/\D/g, "");
    if (!phoneDigits || phoneDigits.length < 10) return res.status(400).json({ error: "Valid phone required." });

    if (!Charge_Type) return res.status(400).json({ error: "Charge Type is required." });
    if (!Cancelation_Policy) return res.status(400).json({ error: "Please accept the cancellation policy." });

    if (!Business_Unit || !Session_Date || !Session_ID) {
      return res.status(400).json({ error: "Session selection incomplete." });
    }
    if (!Units || !C_Quant || !Unit_Price) {
      return res.status(400).json({ error: "Group option incomplete." });
    }

    // paystart requires BookingFeeAmount > 0
    if (!Number.isFinite(BookingFeeAmount) || BookingFeeAmount <= 0) {
      return res.status(400).json({ error: "BookingFeeAmount missing/invalid." });
    }

    const idkey = randIdKey(10);

    const payload = {
      IDKEY: idkey,
      Type: "Reservation",
      Status: "In Process",

      // session/package mapping
      Business_Unit,
      Session_Date,
      Session_ID,
      Item,
      Price_Class,
      Sessions_Title,
      C_Quant,
      Units,
      Unit_Price,

      // customer fields
      First_Name,
      Last_Name,
      Email,
      Phone_Number,
      Charge_Type,
      Cancelation_Policy,
      Cust_Notes,

      // stripe helpers
      People_Text,
      BookingFeeAmount,
    };

    const token = await getCaspioToken();
    const created = await caspioPostResilient(`/tables/${TABLE}/records`, token, payload);

    const res_id =
      created?.Result?.RES_ID ??
      created?.Result?.ID ??
      created?.Result?.PK_ID ??
      null;

    return res.status(200).json({ ok: true, idkey, res_id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: oneLine(e?.message || "Reserve failed") });
  }
}
