// pages/api/reservation-totals.js
//
// ✅ Browser calls ONLY this endpoint
// ✅ Server calls Caspio (token cached in lib/caspio.js)
// ✅ Includes a small "freshness retry" to reduce stale totals right after updates
//
// GET /api/reservation-totals?idkey=XXXX
//

import { caspioFetch, escapeWhereValue } from "../../lib/caspio";

function setCors(req, res) {
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
  ]);

  const origin = req.headers.origin || "";
  const allowOrigin = allowed.has(origin)
    ? origin
    : "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickTotalsFingerprint(row) {
  // Compare a few key numbers to detect if the rollup changed
  // (If Caspio adds an Updated_At field later, we can use that too.)
  const keys = [
    "SIGMA_BAR3_TOTAL_RES_Subtotal_Primary",
    "SIGMA_BAR3_TOTAL_RES_Subtotal_Addon",
    "SIGMA_BAR3_TOTAL_RES_Subtotal_Gratuity",
    "SIGMA_BAR3_TOTAL_RES_TAX_Amount",
    "SIGMA_BAR3_TOTAL_RES_After_Tax_Total",
    "SIGMA_BAR3_TOTAL_RES_Total_Charged_Amount",
  ];

  return keys.map((k) => String(row?.[k] ?? "")).join("|");
}

async function fetchTotalsRow(idkey) {
  const safe = escapeWhereValue(idkey);

  // IMPORTANT: this is a VIEW, so use /views not /tables
  const view = "SIGMA_VW_Res_Billing_Edit";

  // Keep this tight: select only what the UI needs
  const select = [
    "IDKEY",
    "BAR2_Session_Date",
    "BAR2_Session_Title",
    "BAR2_Sessions_Start_Time",          // if present in the view (nice for display)
    "BAR2_Sessions_Date_Start_Time",     // if present (more robust)
    "SIGMA_BAR3_TOTAL_RES_Subtotal_Primary",
    "SIGMA_BAR3_TOTAL_RES_Subtotal_Addon",
    "SIGMA_BAR3_TOTAL_RES_Subtotal_Gratuity",
    "SIGMA_BAR3_TOTAL_RES_TAX_Amount",
    "SIGMA_BAR3_TOTAL_RES_After_Tax_Total",
    "SIGMA_BAR3_TOTAL_RES_Total_Charged_Amount",
  ].join(",");

  const where = `IDKEY='${safe}'`;

  const path =
    `/rest/v2/views/${encodeURIComponent(view)}/records` +
    `?q.where=${encodeURIComponent(where)}` +
    `&q.limit=1` +
    `&q.select=${encodeURIComponent(select)}`;

  const json = await caspioFetch(path);
  return json?.Result?.[0] || null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  // Prevent edge/browser caching
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const idkey = String(req.query.idkey || req.query.IDKEY || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });

    // 1) First read
    const row1 = await fetchTotalsRow(idkey);

    if (!row1) {
      return res.status(404).json({ ok: false, error: "Reservation totals not found" });
    }

    // 2) Freshness retry (helps when rollup/trigger finishes a moment later)
    // Keep it small so we don’t add noticeable latency.
    // If totals change, return the updated row.
    const fp1 = pickTotalsFingerprint(row1);

    await sleep(450);

    const row2 = await fetchTotalsRow(idkey);
    const fp2 = pickTotalsFingerprint(row2);

    const row = row2 && fp2 !== fp1 ? row2 : row1;

    return res.status(200).json({
      ok: true,
      row,
      refreshed: row2 && fp2 !== fp1,
    });
  } catch (err) {
    console.error("reservation-totals error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Server error",
    });
  }
}
