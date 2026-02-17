// pages/api/pricing.js
import { listViewRecordsByWhere, escapeWhereValue } from "../../lib/caspio";

function setCors(res, origin) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://www.reservebarsandrec.com";
  const allowOrigin = origin && origin === allowed ? origin : allowed;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const cache = new Map(); // key -> { exp:number, data:any }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data) {
  cache.set(key, { exp: Date.now() + CACHE_TTL_MS, data });
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const priceStatus = String(req.query.price_status || "").trim();
    if (!priceStatus) {
      return res.status(400).json({ ok: false, error: "Missing price_status" });
    }

    const cacheKey = `pricing:${priceStatus}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return res.status(200).json({ ok: true, cached: true, rows: cached });
    }

    const view = process.env.CASPIO_PRICING_VIEW || "SIGMA_VW_Pricing";
    const where = `Price_Status='${escapeWhereValue(priceStatus)}'`;

    // multi-row view read (you'll add listViewRecordsByWhere below if not present yet)
    const rows = await listViewRecordsByWhere(view, where, 1000);

    // normalize/sort so UI is stable
    rows.sort((a, b) => {
      const as = String(a.Price_Status_Sub ?? "");
      const bs = String(b.Price_Status_Sub ?? "");
      if (as !== bs) return as.localeCompare(bs);

      const aq = Number(a.C_Quant ?? 0);
      const bq = Number(b.C_Quant ?? 0);
      if (aq !== bq) return aq - bq;

      const au = Number(a.Unit ?? NaN);
      const bu = Number(b.Unit ?? NaN);
      if (!Number.isNaN(au) && !Number.isNaN(bu) && au !== bu) return au - bu;

      const ap = Number(a.Price ?? 0);
      const bp = Number(b.Price ?? 0);
      return ap - bp;
    });

    cacheSet(cacheKey, rows);
    return res.status(200).json({ ok: true, cached: false, rows });
  } catch (err) {
    console.error("PRICING_ERROR:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
