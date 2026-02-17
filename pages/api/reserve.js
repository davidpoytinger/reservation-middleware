// pages/api/reserve.js
//
// Receives booking payload from your Weebly UI and inserts into Caspio:
// BAR2_Reservations_SIGMA
//
// Fixes:
// ✅ CORS for POST + OPTIONS (preflight) -> prevents "Failed to fetch"
// ✅ Generates RES_ID (12 chars alnum)
// ✅ Leaves StripeCheckoutSessionId BLANK (omit field) to avoid unique-blank rules
// ✅ Does NOT send Confirmation_Number (now auto-number in Caspio)

export const config = {
  api: { bodyParser: true }, // We want JSON body parsing
};

const CASPIO_BASE = "https://c0gfs257.caspio.com/rest/v2";
const CASPIO_OAUTH = "https://c0gfs257.caspio.com/oauth/token";

// ---- CORS ----
function setCors(res, origin) {
  // Allow both www + non-www for reservebarsandrec.com
  const ok =
    typeof origin === "string" &&
    /^https:\/\/(www\.)?reservebarsandrec\.com$/i.test(origin);

  const fallback = "https://www.reservebarsandrec.com";
  const allowOrigin = ok ? origin : fallback;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ---- Helpers ----
function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function genResId12() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no confusing 0/1/O/I
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) {
    const msg = j?.Message || j?.error_description || j?.error || text || `${r.status}`;
    throw new Error(String(msg).slice(0, 500));
  }
  return j;
}

async function getCaspioToken() {
  // Requires env vars used by your existing token route
  const clientId = process.env.CASPIO_CLIENT_ID;
  const clientSecret = process.env.CASPIO_CLIENT_SECRET;

  if (!clientId) throw new Error("Missing CASPIO_CLIENT_ID");
  if (!clientSecret) throw new Error("Missing CASPIO_CLIENT_SECRET");

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const j = await fetchJson(CASPIO_OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!j.access_token) throw new Error("Caspio token missing access_token");
  return j.access_token;
}

function pickIdKeyFromInsertResponse(insertJson) {
  // Caspio with Prefer:return=representation usually returns:
  // { Result: [ { IDKEY: "..." , ... } ] }
  const row =
    insertJson?.Result?.[0] ||
    insertJson?.result?.[0] ||
    insertJson?.Result ||
    insertJson?.result ||
    null;

  const idkey = row?.IDKEY || row?.IdKey || row?.idkey || null;
  return idkey ? String(idkey) : null;
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "reserve" });
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const table = process.env.CASPIO_TABLE || "BAR2_Reservations_SIGMA";

    // ---- validate incoming payload ----
    const b = req.body || {};

    // Required by your flow
    const payload = {
      // Always set these for insert
      Status: "In Process",
      Type: "Reservation",

      // Session selection / pricing
      Business_Unit: oneLine(b.Business_Unit),
      Session_Date: oneLine(b.Session_Date),
      Session_ID: oneLine(b.Session_ID),
      Item: oneLine(b.Item),
      Price_Class: oneLine(b.Price_Class),
      Sessions_Title: oneLine(b.Sessions_Title),

      C_Quant: oneLine(b.C_Quant),
      Units: oneLine(b.Units),
      Unit_Price: oneLine(b.Unit_Price),

      People_Text: oneLine(b.People_Text),

      // Payment choice
      Charge_Type: oneLine(b.Charge_Type),
      Cancelation_Policy: oneLine(b.Cancelation_Policy || "Agreed"),

      // Contact
      First_Name: oneLine(b.First_Name),
      Last_Name: oneLine(b.Last_Name),
      Email: oneLine(b.Email),
      Phone_Number: oneLine(b.Phone_Number),

      // Notes
      Cust_Notes: oneLine(b.Cust_Notes),

      // Booking fee amount used by paystart
      BookingFeeAmount: b.BookingFeeAmount,
    };

    // Generate RES_ID if missing
    payload.RES_ID = oneLine(b.RES_ID) || genResId12();

    // IMPORTANT:
    // Do NOT send StripeCheckoutSessionId / StripePaymentIntentId placeholders.
    // Leave them absent so they remain NULL in Caspio until paystart/webhook writes them.

    // Basic required checks
    const required = [
      "Business_Unit","Session_Date","Session_ID","Item","Price_Class","Sessions_Title",
      "Units","Unit_Price","Charge_Type",
      "First_Name","Last_Name","Email","Phone_Number",
      "BookingFeeAmount"
    ];
    for (const k of required) {
      if (payload[k] === "" || payload[k] == null) {
        throw new Error(`Missing required field: ${k}`);
      }
    }
    const fee = Number(payload.BookingFeeAmount);
    if (!Number.isFinite(fee) || fee <= 0) {
      throw new Error("BookingFeeAmount must be > 0");
    }

    // ---- Insert into Caspio ----
    const token = await getCaspioToken();

    const insertJson = await fetchJson(`${CASPIO_BASE}/tables/${encodeURIComponent(table)}/records`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // This asks Caspio to return the created row so we can grab IDKEY
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    const idkey = pickIdKeyFromInsertResponse(insertJson);
    if (!idkey) {
      // Still return ok, but include debug so you can see response shape
      return res.status(200).json({
        ok: true,
        idkey: null,
        res_id: payload.RES_ID,
        note: "Insert succeeded but IDKEY not found in response",
        raw: insertJson,
      });
    }

    return res.status(200).json({ ok: true, idkey, res_id: payload.RES_ID });
  } catch (err) {
    console.error("RESERVE_FAILED:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
