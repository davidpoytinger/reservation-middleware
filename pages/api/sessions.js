// pages/api/sessions.js
import { listViewRecordsByWhere, escapeWhereValue } from "../../lib/caspio";

function setCors(res, origin) {
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
  ]);

  // Optional: if you test in Weebly preview, uncomment these:
  // allowed.add("https://www.weebly.com");
  // allowed.add("https://editor.weebly.com");

  const allowOrigin = allowed.has(origin) ? origin : "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}


// Sessions/availability change more often → short TTL
const TTL_MS = 45 * 1000; // 45 seconds
const cache = new Map();

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) { cache.delete(key); return null; }
  return v.data;
}
function cacheSet(key, data) {
  cache.set(key, { exp: Date.now() + TTL_MS, data });
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const date = String(req.query.date || "").trim();
    const bu = String(req.query.bu || "").trim(); // optional

    if (!date) return res.status(400).json({ ok: false, error: "Missing date" });

    const cacheKey = `sessions:${date}:${bu || "__ANY__"}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.status(200).json({ ok: true, cached: true, rows: cached });

    const view = process.env.CASPIO_SESSIONS_VIEW || "SIGMA_VW_Active_Sessions_Manage";

    // Field names used in your UI
    const V_DATE = "BAR2_Sessions_Date";
    const V_BU = "BAR2_Sessions_Business_Unit";
    const V_DBA = "GEN_Business_Units_DBA";
    const V_ITEM_SRC = "BAR2_Primary_Config_Primary_Name";
    const V_GRAPHIC = "BAR2_Primary_Config_Calendar_Graphic";
    const V_START = "BAR2_Sessions_Start_Time";
    const V_PRICE_STATUS = "BAR2_Sessions_Price_Status";
    const V_SESSION_ID = "BAR2_Sessions_Session_ID";
    const V_AVAIL_CQ = "BAR2_Sessions_C_Quant";
    const V_PRICE_CLASS = "BAR2_Sessions_Price_Class";
    const V_TITLE = "BAR2_Sessions_Title";
    const V_BOOKING_FEE = "BAR2_Primary_Config_BookingFee";
    const V_AUTO_GRAT = "BAR2_Primary_Config_Auto_Gratuity_SIGMA";
    const V_SUPP_TEXT  = "BAR2_Sessions_Supplemental_Text";
    const V_SUPP_FILE  = "BAR2_Custom_Session_Info_Content_File";
    const V_SUPP_TITLE = "BAR2_Custom_Session_Info_Title";

    let where = `${V_DATE}='${escapeWhereValue(date)}'`;
    if (bu) where += ` AND ${V_BU}='${escapeWhereValue(bu)}'`;

    const rows = await listViewRecordsByWhere(view, where, 2000);

    // We return full rows (the UI relies on these fields). If you ever want to reduce payload size,
    // we can transform/trim here.
    cacheSet(cacheKey, rows);
    return res.status(200).json({ ok: true, cached: false, rows });
  } catch (err) {
    console.error("SESSIONS_ERROR:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
