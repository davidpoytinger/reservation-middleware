// pages/api/caspio-token.js
export default async function handler(req, res) {
  // ---- CORS (set FIRST, even before any logic) ----
  const allowed = new Set([
    "https://reservebarsandrec.com",
    "https://www.reservebarsandrec.com",
    // Add your Weebly domains if you test there:
    // "https://www.weebly.com",
    // "https://editor.weebly.com",
  ]);

  const origin = req.headers.origin;
  const allowOrigin = allowed.has(origin) ? origin : "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const tokenUrl = process.env.CASPIO_TOKEN_URL;
    const clientId = process.env.CASPIO_CLIENT_ID;
    const clientSecret = process.env.CASPIO_CLIENT_SECRET;

    if (!tokenUrl || !clientId || !clientSecret) {
      return res.status(500).json({
        ok: false,
        error: "CASPIO_ENV_MISSING",
        missing: {
          CASPIO_TOKEN_URL: !tokenUrl,
          CASPIO_CLIENT_ID: !clientId,
          CASPIO_CLIENT_SECRET: !clientSecret,
        },
      });
    }

    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);

    const upstream = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const ct = upstream.headers.get("content-type") || "";
    const text = await upstream.text().catch(() => "");

    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        error: "CASPIO_TOKEN_UPSTREAM_NOT_OK",
        upstream_status: upstream.status,
        upstream_content_type: ct,
        upstream_body_preview: text.slice(0, 400),
      });
    }

    const looksJson = ct.includes("application/json") || text.trim().startsWith("{");
    if (!looksJson) {
      const isMaint =
        /down for maintenance/i.test(text) ||
        /maintenance/i.test(text) ||
        /caspio is down/i.test(text);

      return res.status(503).json({
        ok: false,
        error: isMaint ? "CASPIO_MAINTENANCE" : "CASPIO_TOKEN_UPSTREAM_NOT_JSON",
        token_url: tokenUrl,
        upstream_status: upstream.status,
        upstream_content_type: ct,
        upstream_body_preview: text.slice(0, 400),
      });
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: "CASPIO_TOKEN_JSON_PARSE_FAILED",
        upstream_content_type: ct,
        upstream_body_preview: text.slice(0, 400),
      });
    }

    if (!json?.access_token) {
      return res.status(502).json({
        ok: false,
        error: "CASPIO_TOKEN_MISSING_ACCESS_TOKEN",
        upstream_json_preview: json,
      });
    }

    // ✅ Success
    return res.status(200).json(json);
  } catch (err) {
    // ✅ Important: still returns JSON with CORS headers already set
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      details: String(err?.message || err),
    });
  }
}
