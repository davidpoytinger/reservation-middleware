// pages/api/booking-summary.js
//
// ✅ Browser-safe Booking Summary proxy
// Browser calls this route; server calls Caspio using CASPIO_INTEGRATION_URL + cached token.
//
// GET /api/booking-summary?idkey=XXXX
// Optional: &nocache=1

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

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const idkey = String(req.query.idkey || req.query.IDKEY || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });

    // Caching:
    // Default: short edge cache for speed; allow bypass with ?nocache=1
    const nocache = String(req.query.nocache || "") === "1";
    if (nocache) {
      res.setHeader("Cache-Control", "no-store");
    } else {
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

    const json = await caspioFetch(path);

    const row = json?.Result?.[0] || null;
    return res.status(200).json({ ok: true, row });
  } catch (e) {
    console.error("booking-summary error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
