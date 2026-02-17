// pages/api/sessions.js
import { listViewRecordsByWhere, escapeWhereValue } from "../../lib/caspio";

function setCors(res, origin) {
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
    // If you ever test in Weebly preview, add those here:
    // "https://editor.weebly.com",
    // "https://www.weebly.com",
  ]);

  const allowOrigin = allowed.has(origin) ? origin : "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// --- Stale-While-Revalidate tuning ---
// Fresh enough: return immediately
const SOFT_TTL_MS = 30 * 1000; // 30s (recommended)
// Stale but acceptable: return cached immediately, revalidate in background
const HARD_TTL_MS = 2 * 60 * 1000; // 2 min hard max

// Cache: key -> { data, fetchedAt }
const cache = new Map();
// In-flight refresh guard: key -> Promise
const inFlight = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  return hit; // { data, fetchedAt }
}

function cacheSet(key, data) {
  cache.set(key, { data, fetchedAt: Date.now() });
}

function ageMs(entry) {
  return Date.now() - (entry?.fetchedAt || 0);
}

async function fetchSessionsFromCaspio(date, bu) {
  const view = process.env.CASPIO_SESSIONS_VIEW || "SIGMA_VW_Active_Sessions_Manage";

  // Field names used in your UI / view
  const V_DATE = "BAR2_Sessions_Date";
  const V_BU = "BAR2_Sessions_Business_Unit";

  let where = `${V_DATE}='${escapeWhereValue(date)}'`;
  if (bu) where += ` AND ${V_BU}='${escapeWhereValue(bu)}'`;

  // Pull rows (UI expects full session rows; we can trim later if you want)
  const rows = await listViewRecordsByWhere(view, where, 2000);
  return rows || [];
}

function refreshKey(key, date, bu) {
  // stampede protection
  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    try {
      const rows = await fetchSessionsFromCaspio(date, bu);
      cacheSet(key, rows);
      return rows;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const date = String(req.query.date || "").trim();
    const bu = String(req.query.bu || "").trim(); // optional

    if (!date) return res.status(400).json({ ok: false, error: "Missing date" });

    const key = `sessions:${date}:${bu || "__ANY__"}`;

    const entry = cacheGet(key);
    if (entry) {
      const age = ageMs(entry);

      // ✅ Fresh: serve cached
      if (age <= SOFT_TTL_MS) {
        return res.status(200).json({
          ok: true,
          cached: true,
          freshness: "fresh",
          age_ms: age,
          rows: entry.data,
        });
      }

      // ✅ Stale-but-acceptable: serve cached immediately + best-effort refresh
      if (age <= HARD_TTL_MS) {
        // kick off refresh (do not await)
        refreshKey(key, date, bu).catch((e) => {
          console.error("SESSIONS_REVALIDATE_FAILED:", e?.message || e);
        });

        return res.status(200).json({
          ok: true,
          cached: true,
          freshness: "stale",
          age_ms: age,
          rows: entry.data,
        });
      }

      // Too old: fall through to forced refresh
    }

    // ✅ No cache or too old: do a live fetch (await)
    const rows = await refreshKey(key, date, bu);

    return res.status(200).json({
      ok: true,
      cached: false,
      freshness: "live",
      age_ms: 0,
      rows,
    });
  } catch (err) {
    console.error("SESSIONS_ERROR:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
