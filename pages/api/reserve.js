// pages/api/reserve.js
//
// Receives reservation fields from your Weebly booking UI,
// inserts into Caspio BAR2_Reservations_SIGMA,
// returns { ok:true, idkey:"..." } so the front-end can redirect to /api/paystart?idkey=...
//
// ✅ Handles Caspio "read-only" errors by retrying with smaller payloads (allowlist).
// ✅ Includes CORS for reservebarsandrec.com
// ✅ Uses /api/caspio-token to obtain Caspio access token (server-side)

function setCors(res, origin) {
  // IMPORTANT: If your Weebly site sometimes hits with/without www,
  // you can set ALLOWED_ORIGIN to one canonical value, OR extend this.
  const allowed = process.env.ALLOWED_ORIGIN || "https://reservebarsandrec.com";

  // If you want to allow both, set env var like:
  // ALLOWED_ORIGINS="https://reservebarsandrec.com,https://www.reservebarsandrec.com"
  const allowedList = String(process.env.ALLOWED_ORIGINS || allowed)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin = allowedList.includes(origin) ? origin : allowedList[0];

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    // ignore
  }
  if (!r.ok) {
    const msg =
      j?.Message ||
      j?.error_description ||
      j?.error ||
      text ||
      `${r.status}`;
    throw new Error(String(msg).slice(0, 500));
  }
  return j;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function cleanString(v) {
  const s = String(v ?? "").trim();
  return s === "" ? "" : s;
}

function normalizeBody(raw) {
  // Only keep keys we expect from the front-end (prevents accidental read-only fields)
  const b = raw && typeof raw === "object" ? raw : {};
  return {
    // Contact
    First_Name: cleanString(b.First_Name),
    Last_Name: cleanString(b.Last_Name),
    Email: cleanString(b.Email),
    Phone_Number: cleanString(b.Phone_Number),
    Cust_Notes: cleanString(b.Cust_Notes),

    // Booking choice
    Cancelation_Policy: cleanString(b.Cancelation_Policy), // e.g. "Agreed"
    Charge_Type: cleanString(b.Charge_Type),               // "Pay Now" or "24 Hour Hold Fee"

    // Session selection
    Business_Unit: cleanString(b.Business_Unit),
    Session_Date: cleanString(b.Session_Date),
    Session_ID: cleanString(b.Session_ID),
    Item: cleanString(b.Item),
    Price_Class: cleanString(b.Price_Class),
    Sessions_Title: cleanString(b.Sessions_Title),

    // Pricing selection
    C_Quant: cleanString(b.C_Quant),
    Units: cleanString(b.Units),
    Unit_Price: cleanString(b.Unit_Price),

    // Helpful text
    People_Text: cleanString(b.People_Text),

    // Due today (used by paystart)
    BookingFeeAmount: b.BookingFeeAmount,

    // System status/type
    Status: cleanString(b.Status || "In Process"),
    Type: cleanString(b.Type || "Reservation"),
  };
}

function looksLikeReadOnlyError(msg) {
  const s = String(msg || "").toLowerCase();
  return s.includes("read-only") || s.includes("read only");
}

function looksLikeColumnNotFound(msg) {
  const s = String(msg || "").toLowerCase();
  return s.includes("columnnotfound") || s.includes("do not exist");
}

function dropMissingColumnsFromMessage(payload, msg) {
  // If Caspio returns:
  // "Cannot perform operation because the following field(s) do not exist: 'X','Y'"
  const after = String(msg).split("do not exist:")[1] || "";
  const missing = [];
  for (const m of after.matchAll(/'([^']+)'/g)) missing.push(m[1]);

  if (!missing.length) return payload;

  const trimmed = { ...payload };
  for (const f of missing) delete trimmed[f];
  return trimmed;
}

async function getCaspioTokenFromLocalRoute(req) {
  // Use the SAME deployment base URL if available; fall back to absolute env.
  const host =
    process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : (process.env.MIDDLEWARE_BASE_URL || "");

  // If host not present, we can call relative route inside Vercel runtime:
  const tokenUrl = host ? `${host}/api/caspio-token` : `http://localhost:3000/api/caspio-token`;

  // In Vercel serverless, relative fetch can be flaky; absolute is safer.
  const j = await fetchJson(tokenUrl, { cache: "no-store" });
  if (!j?.access_token) throw new Error("Token endpoint missing access_token.");
  return j.access_token;
}

async function caspioInsertReservation(token, payload) {
  const CASPIO_BASE = "https://c0gfs257.caspio.com/rest/v2";
  const table = process.env.CASPIO_TABLE || "BAR2_Reservations_SIGMA";

  // Caspio insert endpoint
  const url = `${CASPIO_BASE}/tables/${encodeURIComponent(table)}/records`;

  return await fetchJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function extractIdKey(insertResponse) {
  // Caspio insert responses can vary.
  // Try a few common shapes.
  if (!insertResponse) return null;

  // Sometimes { Result: [ { IDKEY: "..." } ] }
  const r0 = insertResponse?.Result?.[0];
  if (r0?.IDKEY) return r0.IDKEY;

  // Sometimes { Result: { IDKEY: "..." } }
  const r1 = insertResponse?.Result;
  if (r1?.IDKEY) return r1.IDKEY;

  // Sometimes the object itself includes fields
  if (insertResponse?.IDKEY) return insertResponse.IDKEY;

  return null;
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "reserve" });
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const token = await getCaspioTokenFromLocalRoute(req);

    const body = normalizeBody(req.body);

    // Attempt 1: Full payload (but already sanitized to expected keys)
    let payload1 = { ...body };

    // Some people prefer not sending BookingFeeAmount/People_Text if those are computed.
    // If you KNOW they're computed/read-only, comment them out here.
    // delete payload1.BookingFeeAmount;
    // delete payload1.People_Text;

    // Attempt 2: "Safe allowlist" (very likely writable fields)
    const payload2 = pick(body, [
      "First_Name",
      "Last_Name",
      "Email",
      "Phone_Number",
      "Cust_Notes",
      "Cancelation_Policy",
      "Charge_Type",
      "Business_Unit",
      "Session_Date",
      "Session_ID",
      "Item",
      "Price_Class",
      "Sessions_Title",
      "C_Quant",
      "Units",
      "Unit_Price",
      "Status",
      "Type",
      // optionally:
      "People_Text",
      "BookingFeeAmount",
    ]);

    // Attempt 3: Minimal payload (gets the row created; lets computed fields fill if applicable)
    const payload3 = pick(body, [
      "First_Name",
      "Last_Name",
      "Email",
      "Phone_Number",
      "Business_Unit",
      "Session_Date",
      "Session_ID",
      "Charge_Type",
      "Status",
      "Type",
    ]);

    const attempts = [
      { name: "full", payload: payload1 },
      { name: "safe", payload: payload2 },
      { name: "minimal", payload: payload3 },
    ];

    let lastErr = null;
    let insertJson = null;

    for (const a of attempts) {
      try {
        insertJson = await caspioInsertReservation(token, a.payload);
        lastErr = null;
        break;
      } catch (e) {
        const msg = e?.message || String(e);

        // If columns missing, trim them and retry this same attempt once
        if (looksLikeColumnNotFound(msg)) {
          const trimmed = dropMissingColumnsFromMessage(a.payload, msg);
          if (Object.keys(trimmed).length && JSON.stringify(trimmed) !== JSON.stringify(a.payload)) {
            try {
              insertJson = await caspioInsertReservation(token, trimmed);
              lastErr = null;
              break;
            } catch (e2) {
              lastErr = e2;
              continue;
            }
          }
        }

        // If read-only, move to next attempt
        if (looksLikeReadOnlyError(msg)) {
          lastErr = e;
          continue;
        }

        // Other errors: stop immediately (likely real validation)
        throw e;
      }
    }

    if (lastErr) {
      throw lastErr;
    }

    const idkey = extractIdKey(insertJson);
    if (!idkey) {
      // Still return ok but warn; your front-end needs idkey for paystart.
      // If this happens, we can add a follow-up lookup query to fetch the row.
      return res.status(200).json({
        ok: false,
        error: "Inserted, but could not read IDKEY from Caspio response. Tell me what Caspio returned.",
        raw: insertJson,
      });
    }

    return res.status(200).json({ ok: true, idkey });
  } catch (err) {
    console.error("RESERVE_FAILED", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Server error",
    });
  }
}
