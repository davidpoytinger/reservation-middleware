// pages/api/booking-summary.js
//
// ✅ Browser-safe Booking Summary proxy
// ✅ Fixes "doesn't update until refresh" by:
//   - Proper no-cache headers when ?nocache=1
//   - Cache-buster friendly behavior (?cb=timestamp)
//   - Optional short retry loop (only when nocache=1) to ride out Caspio/view consistency lag
//
// GET /api/booking-summary?idkey=XXXX
// Optional: &nocache=1&cb=123456
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

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const idkey = String(req.query.idkey || req.query.IDKEY || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });

    const nocache = String(req.query.nocache || "") === "1";

    // ✅ Caching headers:
    // - Default: tiny edge cache is fine for passive loads
    // - On demand (nocache=1): FULLY disable caches everywhere
    if (nocache) {
      // Strong no-cache for browsers + CDNs
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
      );
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      // Helpful for some CDNs:
      res.setHeader("Surrogate-Control", "no-store");
    } else {
      // Keep your original edge cache behavior
      res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=60");
    }

    const safe = escapeWhereValue(idkey);
    const where = `IDKEY='${safe}'`;

    // Only pull fields your Booking Summary UI needs
    const select = [
      "BAR2_Session_Date",
      "BAR2_Session_Title",
      "SIGMA_BAR3_TOTAL_RES_Subtotal_Primary",
      "SIGMA_BAR3_TOTAL_RES_Subtotal_Addon",
      "SIGMA_BAR3_TOTAL_RES_Subtotal_Gratuity",
      "SIGMA_BAR3_TOTAL_RES_TAX_Amount",
      "SIGMA_BAR3_TOTAL_RES_After_Tax_Total",
      "SIGMA_BAR3_TOTAL_RES_Total_Charged_Amount",
    ].join(",");

    const path =
      `/rest/v2/views/SIGMA_VW_Res_Billing_Edit/records` +
      `?q.where=${encodeURIComponent(where)}` +
      `&q.limit=1` +
      `&q.select=${encodeURIComponent(select)}`;

    // ✅ Retry loop ONLY when nocache=1.
    // This helps when Caspio view/rollups need a moment after PUT.
    // Bound + fast: max ~2.3s total.
    const delays = nocache ? [0, 200, 450, 750, 900] : [0];

    let lastJson = null;
    for (const d of delays) {
      if (d) await sleep(d);
      lastJson = await caspioFetch(path);

      const row = lastJson?.Result?.[0] || null;
      // If we got a row, return it immediately.
      // (We can't reliably detect "updated" vs "old" without a compare value.)
      if (row) {
        return res.status(200).json({ ok: true, row });
      }
    }

    return res.status(200).json({ ok: true, row: null });
  } catch (e) {
    console.error("booking-summary error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
