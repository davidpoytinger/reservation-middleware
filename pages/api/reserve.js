// pages/api/reserve.js
//
// Receives booking payload from reservebarsandrec.com UI,
// inserts into Caspio BAR2_Reservations_SIGMA,
// returns { ok:true, idkey }.
//
// Key fixes:
// ✅ CORS allows both www and non-www
// ✅ OPTIONS preflight handled
// ✅ Generates IDKEY server-side
// ✅ Writes unique placeholder StripeCheckoutSessionId to avoid Caspio "duplicate blank" unique constraint issues
// ✅ Sets Status="In Process", Type="Reservation"

export const config = {
  api: { bodyParser: true },
};

const CASPIO_BASE = "https://c0gfs257.caspio.com/rest/v2";
const CASPIO_OAUTH = "https://c0gfs257.caspio.com/oauth/token";

// ---- CONFIG ----
const TABLE = process.env.CASPIO_TABLE || "BAR2_Reservations_SIGMA";

// Put BOTH here (Weebly usually serves from www)
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

// Simple, URL-safe ID key
function makeIdKey(len = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/1/I/O
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) {
    const msg = j?.Message || j?.error_description || j?.error || text || `${r.status}`;
    throw new Error(String(msg).slice(0, 600));
  }
  return j;
}

async function getCaspioToken() {
  if (!process.env.CASPIO_CLIENT_ID) throw new Error("Missing CASPIO_CLIENT_ID");
  if (!process.env.CASPIO_CLIENT_SECRET) throw new Error("Missing CASPIO_CLIENT_SECRET");

  // Caspio OAuth client credentials
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
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "reserve" });
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const b = req.body || {};

    // ---- Validate basics ----
    const First_Name = oneLine(b.First_Name);
    const Last_Name  = oneLine(b.Last_Name);
    const Email      = oneLine(b.Email);
    const Phone_Number = oneLine(b.Phone_Number);

    if (!First_Name) return res.status(400).json({ ok:false, error:"Missing First_Name" });
    if (!Last_Name)  return res.status(400).json({ ok:false, error:"Missing Last_Name" });
    if (!Email || !isValidEmail(Email)) return res.status(400).json({ ok:false, error:"Missing/invalid Email" });
    if (!Phone_Number || normalizePhone(Phone_Number).replace(/\D/g,"").length < 10) {
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

    // ---- Generate IDKEY here so we can return it immediately ----
    const IDKEY = makeIdKey(10);

    // IMPORTANT:
    // If Caspio treats blank as duplicate on unique fields,
    // set unique placeholder values until paystart overwrites them.
    const stripePlaceholder = `pending_${IDKEY}_${Date.now()}`;

    // ---- Build insert payload (only writable fields) ----
    const payload = {
      IDKEY,

      // Required booking fields
      Status: "In Process",
      Type: "Reservation",

      First_Name,
      Last_Name,
      Email,
      Phone_Number,

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
      Cust_Notes: oneLine(b.Cust_Notes),

      Cancelation_Policy: oneLine(b.Cancelation_Policy || "Agreed"),
      Charge_Type,

      BookingFeeAmount,

      // placeholders to satisfy uniqueness (paystart will overwrite)
      StripeCheckoutSessionId: stripePlaceholder,
      StripePaymentIntentId: stripePlaceholder,
    };

    const token = await getCaspioToken();

    // Insert
    await caspioInsert(TABLE, token, payload);

    return res.status(200).json({ ok: true, idkey: IDKEY });
  } catch (err) {
    console.error("reserve.js error:", err?.message || err);
    return res.status(500).json({ ok:false, error: err?.message || "Server error" });
  }
}
