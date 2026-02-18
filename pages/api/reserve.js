// pages/api/reserve.js
//
// Inserts reservation into Caspio BAR2_Reservations_SIGMA.
// Returns IDKEY via insert response or lookup by RES_ID.
//
// Uses lib/caspio.js for token + REST logic (v3/v2 fallback, etc).

import { insertRecord, getReservationByResId } from "../../lib/caspio";

export const config = { api: { bodyParser: true } };

// ---- CORS ----
function setCors(res, origin) {
  // Prefer env var so you can update without code changes
  const envAllowed = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
    ...envAllowed,
    // Optional if you ever embed directly on these:
    // "https://www.weebly.com",
    // "https://editor.weebly.com",
  ]);

  // IMPORTANT: sandboxed iframes (common in editors/previews) often send Origin: null
  // If you aren't using cookies/credentials, you can safely allow "*" or "null".
  let allowOrigin;

  if (!origin || origin === "null") {
    allowOrigin = "*"; // simplest: works for null-origin embeds, no credentials
  } else if (allowed.has(origin)) {
    allowOrigin = origin;
  } else {
    // Fall back to your canonical site (keeps behavior predictable)
    allowOrigin = "https://www.reservebarsandrec.com";
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);

  // Only set Vary when not wildcard (wildcard doesn't vary by origin)
  if (allowOrigin !== "*") res.setHeader("Vary", "Origin");

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

// ---- Helpers ----
function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function genResId12() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
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

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  // Preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  // Health check
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "reserve" });

  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const table = process.env.CASPIO_TABLE || "BAR2_Reservations_SIGMA";
    const b = req.body || {};

    const RES_ID = oneLine(b.RES_ID) || genResId12();

    const payload = {
      Status: "In Process",
      Type: "Reservation",
      RES_ID,

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

      Charge_Type: oneLine(b.Charge_Type),
      Cancelation_Policy: oneLine(b.Cancelation_Policy || "Agreed"),

      First_Name: oneLine(b.First_Name),
      Last_Name: oneLine(b.Last_Name),
      Email: oneLine(b.Email),
      Phone_Number: oneLine(b.Phone_Number),

      Cust_Notes: oneLine(b.Cust_Notes),

      BookingFeeAmount: b.BookingFeeAmount,

      // If your Caspio table now requires Tax_Rate, uncomment:
      // Tax_Rate: b.Tax_Rate,
    };

    const required = [
      "Business_Unit",
      "Session_Date",
      "Session_ID",
      "Item",
      "Price_Class",
      "Sessions_Title",
      "Units",
      "Unit_Price",
      "Charge_Type",
      "First_Name",
      "Last_Name",
      "Email",
      "Phone_Number",
      "BookingFeeAmount",
    ];

    for (const k of required) {
      if (payload[k] === "" || payload[k] == null) throw new Error(`Missing required field: ${k}`);
    }

    const fee = Number(payload.BookingFeeAmount);
    if (!Number.isFinite(fee) || fee <= 0) throw new Error("BookingFeeAmount must be > 0");

    const insertJson = await insertRecord(table, payload);

    // Try IDKEY from insert response
    let idkey = pickIdKeyFromInsertResponse(insertJson);

    // Fallback lookup by RES_ID
    if (!idkey) {
      const row = await getReservationByResId(RES_ID);
      idkey = row?.IDKEY ? String(row.IDKEY) : null;
    }

    if (!idkey) {
      return res.status(200).json({
        ok: false,
        error: "Reservation insert succeeded but IDKEY lookup failed.",
        res_id: RES_ID,
      });
    }

    return res.status(200).json({ ok: true, idkey, res_id: RES_ID });
  } catch (err) {
    console.error("RESERVE_FAILED:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
