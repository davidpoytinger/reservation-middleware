// pages/api/caspio-token.js
export default async function handler(req, res) {
  // CORS (optional)
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const CASPIO_TOKEN_URL = process.env.CASPIO_TOKEN_URL;
    const CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID;
    const CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;

    // Hard fail with JSON (never HTML)
    const missing = [];
    if (!CASPIO_TOKEN_URL) missing.push("CASPIO_TOKEN_URL");
    if (!CASPIO_CLIENT_ID) missing.push("CASPIO_CLIENT_ID");
    if (!CASPIO_CLIENT_SECRET) missing.push("CASPIO_CLIENT_SECRET");
    if (missing.length) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_ENV",
        missing,
      });
    }

    // Caspio token endpoint MUST end with /oauth/token
    // (we won't force it, but we will report it)
    const url = String(CASPIO_TOKEN_URL).trim();

    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", CASPIO_CLIENT_ID);
    body.set("client_secret", CASPIO_CLIENT_SECRET);

    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const ct = upstream.headers.get("content-type") || "";
    const text = await upstream.text();

    // Try parse only if it looks like JSON
    const looksJson = ct.includes("application/json") || text.trim().startsWith("{");

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        error: "CASPIO_TOKEN_UPSTREAM_NOT_OK",
        token_url: url,
        token_url_endswith_oauth_token: url.endsWith("/oauth/token"),
        upstream_status: upstream.status,
        upstream_content_type: ct,
        upstream_body_preview: text.slice(0, 600),
      });
    }

    if (!looksJson) {
      return res.status(502).json({
        ok: false,
        error: "CASPIO_TOKEN_UPSTREAM_NOT_JSON",
        token_url: url,
        token_url_endswith_oauth_token: url.endsWith("/oauth/token"),
        upstream_status: upstream.status,
        upstream_content_type: ct,
        upstream_body_preview: text.slice(0, 600),
      });
    }

    const json = JSON.parse(text);

    // standard success payload
    return res.status(200).json({
      ...json,
      ok: true,
    });
  } catch (err) {
    console.error("CASPIO_TOKEN_ROUTE_ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}
