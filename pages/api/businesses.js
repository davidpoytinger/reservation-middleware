// pages/api/businesses.js
import { listViewRecordsByWhere, escapeWhereValue } from "../../lib/caspio";

function setCors(res, origin) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://www.reservebarsandrec.com";
  const allowOrigin = origin && origin === allowed ? origin : allowed;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
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
    if (!date) return res.status(400).json({ ok: false, error: "Missing date" });

    const cacheKey = `biz:${date}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.status(200).json({ ok: true, cached: true, pairs: cached });

    const view = process.env.CASPIO_SESSIONS_VIEW || "SIGMA_VW_Active_Sessions_Manage";

    // Field names from your UI
    const V_DATE = "BAR2_Sessions_Date";
    const V_BU = "BAR2_Sessions_Business_Unit";
    const V_DBA = "GEN_Business_Units_DBA";

    const where = `${V_DATE}='${escapeWhereValue(date)}'`;
    const rows = await listViewRecordsByWhere(view, where, 2000);

    const pairs = [];
    const seen = new Set();
    for (const r of rows) {
      const bu = String(r?.[V_BU] ?? "").trim();
      const dba = String(r?.[V_DBA] ?? "").trim();
      if (!bu || !dba) continue;
      if (seen.has(bu)) continue;
      seen.add(bu);
      pairs.push({ bu, dba });
    }
    pairs.sort((a, b) => a.dba.localeCompare(b.dba));

    cacheSet(cacheKey, pairs);
    return res.status(200).json({ ok: true, cached: false, pairs });
  } catch (err) {
    console.error("BUSINESSES_ERROR:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
