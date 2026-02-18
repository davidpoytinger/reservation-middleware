// pages/api/caspio-token.js
//
// Returns a Caspio OAuth token for client-side calls.
// CORS-safe for site + sandboxed embeds (Origin: null).

export default async function handler(req, res) {
  // ---- CORS ----
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
  ]);

  const origin = req.headers.origin || "";

  // Sandbox/preview embeds sometimes send Origin: null.
  // This route does not use cookies/credentials, so wildcard is OK.
  let allowOrigin;
  if (!origin || origin === "null") {
    allowOrigin = "*";
  } else if (allowed.has(origin)) {
    allowOrigin = origin;
  } else {
    allowOrigin = "https://www.reservebarsandrec.com";
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  if (allowOrigin !== "*") res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const clientId = process.env.CASPIO_CLIENT_ID;
    const clientSecret = process.env.CASPIO_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res
        .status(500)
        .json({ error: "Missing CASPIO_CLIENT_ID or CASPIO_CLIENT_SECRET" });
    }

    const tokenUrl = "https://c0gfs257.caspio.com/oauth/token";

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });

    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const j = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({
        error: "Caspio token request failed",
        details: j,
      });
    }

    return res.status(200).json({
      access_token: j.access_token,
      expires_in: j.expires_in,
      token_type: j.token_type,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      details: String(e?.message || e),
    });
  }
}
