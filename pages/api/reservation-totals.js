// pages/api/reservation-totals.js
//
// DROP-IN REPLACEMENT ✅
// ✅ Browser calls ONLY this endpoint (no Caspio calls in browser)
// ✅ Pulls Booking Summary fields from SIGMA_VW_Res_Billing_Edit
// ✅ FIX: uses BAR2_Sessions_Date + BAR2_Sessions_Title (plural)
// ✅ CORS for reservebarsandrec + weebly editors
//

import { caspioFetch, escapeWhereValue } from "../../lib/caspio";

export default async function handler(req, res) {
  // ---------- CORS ----------
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
    "https://www.weebly.com",
    "https://editor.weebly.com",
  ]);

  const origin = req.headers.origin || "";
  const allowOrigin = allowed.has(origin)
    ? origin
    : "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const idkey = String(req.query.idkey || req.query.IDKEY || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });

    const safe = escapeWhereValue(idkey);
    const where = `IDKEY='${safe}'`;

    // ✅ Must match your view columns
    const select = [
      "IDKEY",
      "BAR2_Sessions_Date",
      "BAR2_Sessions_Title",
      "SIGMA_BAR3_TOTAL_RES_Subtotal_Primary",
      "SIGMA_BAR3_TOTAL_RES_Subtotal_Addon",
      "SIGMA_BAR3_TOTAL_RES_Subtotal_Gratuity",
      "SIGMA_BAR3_TOTAL_RES_TAX_Amount",
      "SIGMA_BAR3_TOTAL_RES_After_Tax_Total",
      "SIGMA_BAR3_TOTAL_RES_Total_Charged_Amount",
    ].join(",");

    const path =
      `/rest/v2/views/${encodeURIComponent("SIGMA_VW_Res_Billing_Edit")}/records` +
      `?q.where=${encodeURIComponent(where)}` +
      `&q.limit=1` +
      `&q.select=${encodeURIComponent(select)}`;

    const json = await caspioFetch(path);
    const row = json?.Result?.[0] || null;

    if (!row) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    return res.status(200).json({ ok: true, row });
  } catch (err) {
    console.error("reservation-totals error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Server error",
    });
  }
}
