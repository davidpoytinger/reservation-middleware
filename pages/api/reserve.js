// pages/api/reserve.js
//
// Inserts reservation into Caspio BAR2_Reservations_SIGMA.
// If Caspio doesn't return IDKEY on insert, we lookup by RES_ID and return IDKEY.
//
// Fixes:
// ✅ CORS for POST + OPTIONS (preflight) -> prevents "Failed to fetch"
// ✅ Generates RES_ID (12 chars alnum) if missing
// ✅ Leaves StripeCheckoutSessionId blank (omits field) to avoid unique constraints
// ✅ Does NOT send Confirmation_Number (auto-number in Caspio)
// ✅ Robustly returns IDKEY via lookup by RES_ID

export const config = {
  api: { bodyParser: true },
};

const CASPIO_BASE = "https://c0gfs257.caspio.com/rest/v2";
const CASPIO_OAUTH = "https://c0gfs257.caspio.com/oauth/token";

// ---- CORS ----
function setCors(res, origin) {
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

function escWhere(v) {
  return String(v ?? "").replace(/'/g, "''");
}

function genResId12() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // avoids 0/1/O/I confusion
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
    throw new Error(String(msg).slice(0, 700));
  }
  return j;
}

async function getCaspioToken() {
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
  const row =
    insertJson?.Result?.[0] ||
    insertJson?.result?.[0] ||
    insertJson?.Result ||
    insertJson?.result ||
    null;

  const idkey = row?.IDKEY || row?.IdKey || row?.idkey || null;
  return idkey ? String(idkey) : null;
}

async function caspioGet(path, token) {
  return await fetchJson(`${CASPIO_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function lookupIdKeyByResId(table, resId, token) {
  // We expect RES_ID to be unique (we generate a random 12-char).
  const where = `RES_ID='${escWhere(resId)}'`;
  const path =
    `/tables/${encodeURIComponent(table)}/records` +
    `?q.where=${encodeURIComponent(where)}` +
    `&q.select=${encodeURIComponent("IDKEY,RES_ID")}` +
    `&q.limit=1`;

  const j = await caspioGet(path, token);
  const row = j?.Result?.[0] || null;
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
    const b = req.body || {};

    const RES_ID = oneLine(b.RES_ID) || genResId12();

    const payload = {
      // Always set these for insert
      Status: "In Process",
      Type: "Reservation",

      // Required identifiers / selection
      RES_ID,

      Business_Unit: oneLine(b.Business_Unit),
      Session_Date: oneLine(b.Session_Date),
      Session_ID: oneLine(b.Session_ID),
      Item: oneLine(b.Item),
      Price_Class: oneLine(b.Price_Class),
      Sessions_Title: oneLine(b.Sessions_Title),

      // Pricing option
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

      Cust_Notes: oneLine(b.Cust_Notes),

      // This is used by paystart (must be > 0)
      BookingFeeAmount: b.BookingFeeAmount,
    };

    // Do NOT send StripeCheckoutSessionId / StripePaymentIntentId placeholders.
    // Do NOT send Confirmation_Number (auto-number).

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

    const token = await getCaspioToken();

    // INSERT
    let insertJson = null;
    try {
      insertJson = await fetchJson(
        `${CASPIO_BASE}/tables/${encodeURIComponent(table)}/records`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify(payload),
        }
      );
    } catch (e) {
      // If Caspio returns something odd, surface it
      throw new Error(`Insert failed: ${e.message}`);
    }

    // Try to read IDKEY from insert response
    let idkey = pickIdKeyFromInsertResponse(insertJson);

    // Fallback: lookup by RES_ID
    if (!idkey) {
      idkey = await lookupIdKeyByResId(table, RES_ID, token);
    }

    if (!idkey) {
      // We inserted, but couldn't read it back
      // This usually means RES_ID isn't actually written, or table name mismatch, or permissions.
      return res.status(200).json({
        ok: false,
        error: "Reservation insert succeeded but IDKEY lookup failed.",
        res_id: RES_ID,
        debug_note:
          "Check that RES_ID exists in BAR2_Reservations_SIGMA and is not read-only, and that API role can read it.",
      });
    }

    return res.status(200).json({ ok: true, idkey, res_id: RES_ID });
  } catch (err) {
    console.error("RESERVE_FAILED:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
