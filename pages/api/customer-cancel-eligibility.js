// pages/api/customer-cancel-eligibility.js
export default async function handler(req, res) {
  // CORS (optional)
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
  ]);
  const origin = req.headers.origin || "";
  const allowOrigin = allowed.has(origin) ? origin : "https://www.reservebarsandrec.com";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const idkey = String(req.query.idkey || req.query.IDKEY || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });

    // ✅ Get Caspio token by calling YOUR existing token endpoint
    const tokenUrl =
      process.env.CASPIO_TOKEN_URL ||
      "https://reservation-middleware2.vercel.app/api/caspio-token";

    const tokenResp = await fetch(tokenUrl, { cache: "no-store" });
    const tokenJson = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenJson.access_token) {
      return res.status(500).json({
        ok: false,
        error: "Failed to get Caspio token",
        detail: tokenJson?.error || tokenJson?.Message || tokenResp.status,
      });
    }

    const accessToken = tokenJson.access_token;

    // ✅ Call Caspio REST (example: read billing view / config needed for cancel eligibility)
    const CASPIO_BASE = "https://c0gfs257.caspio.com/rest/v2";
    const view = process.env.CASPIO_BILLING_VIEW || "SIGMA_VW_Res_Billing_Edit";
    const where = `IDKEY='${String(idkey).replace(/'/g, "''")}'`;
    const url =
      `${CASPIO_BASE}/views/${view}/records` +
      `?q.where=${encodeURIComponent(where)}` +
      `&q.limit=1`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: "Caspio request failed",
        detail: j?.Message || j?.error || r.status,
      });
    }

    const row = j.Result?.[0] || null;

    // TODO: Apply your eligibility logic here.
    // For now just return the row so you can confirm it works end-to-end.
    return res.status(200).json({ ok: true, row });
  } catch (e) {
    console.error("customer-cancel-eligibility error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
