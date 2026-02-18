// pages/api/reserve.js
//
// POST /api/reserve
// Body: JSON payload from booking form
// Inserts a record into BAR2_Reservations_SIGMA (or CASPIO_TABLE)
// Ensures Tax_Rate is stored as a number

import { insertRecord } from "../../lib/caspio";

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Simple, URL-safe ID key generator
function makeIdKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/1/0
  const bytes = new Uint32Array(4);
  // Web crypto in Node 18+:
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 12; i++) {
    const x = bytes[i % bytes.length] >>> ((i % 4) * 8);
    out += alphabet[x % alphabet.length];
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    const table = process.env.CASPIO_TABLE || "BAR2_Reservations_SIGMA";

    // Required-ish fields
    const first = oneLine(body.First_Name);
    const last = oneLine(body.Last_Name);
    const email = oneLine(body.Email);
    const phone = oneLine(body.Phone_Number);

    const sessionId = oneLine(body.Session_ID);
    const sessionDate = oneLine(body.Session_Date);
    const businessUnit = oneLine(body.Business_Unit);

    if (!first || !last || !email || !phone) return res.status(400).send("Missing contact fields");
    if (!sessionId || !sessionDate || !businessUnit) return res.status(400).send("Missing session fields");

    // ✅ Tax_Rate: number field in Caspio
    // Expecting rate like 0.055 (not 5.5)
    let taxRate = toNumberOrNull(body.Tax_Rate);
    if (taxRate !== null) {
      // guard rails: if someone sends 5.5 instead of 0.055, convert
      if (taxRate > 1) taxRate = taxRate / 100;
      // clamp to sane range
      if (taxRate < 0) taxRate = 0;
      if (taxRate > 0.25) taxRate = 0.25;
      taxRate = Number(taxRate.toFixed(6));
    }

    const idkey = oneLine(body.IDKEY || body.idkey) || makeIdKey();

    // Build payload for Caspio insert
    const payload = {
      IDKEY: idkey,

      First_Name: first,
      Last_Name: last,
      Email: email,
      Phone_Number: phone,

      Cancelation_Policy: oneLine(body.Cancelation_Policy || ""),
      Charge_Type: oneLine(body.Charge_Type || ""),
      Cust_Notes: oneLine(body.Cust_Notes || ""),

      Business_Unit: businessUnit,
      Session_Date: sessionDate,
      Session_ID: sessionId,

      Item: oneLine(body.Item || ""),
      Price_Class: oneLine(body.Price_Class || ""),
      Sessions_Title: oneLine(body.Sessions_Title || ""),

      C_Quant: oneLine(body.C_Quant || ""),
      Units: oneLine(body.Units || ""),
      Unit_Price: oneLine(body.Unit_Price || ""),

      People_Text: oneLine(body.People_Text || ""),

      BookingFeeAmount: toNumberOrNull(body.BookingFeeAmount),

      // ✅ NEW FIELD
      Tax_Rate: taxRate,
    };

    // Remove nulls (Caspio is fine either way, but this keeps it clean)
    for (const k of Object.keys(payload)) {
      if (payload[k] === null) delete payload[k];
    }

    await insertRecord(table, payload);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({ ok: true, idkey });
  } catch (err) {
    console.error("RESERVE_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Reserve failed");
  }
}
