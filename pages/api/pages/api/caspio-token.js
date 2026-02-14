export default async function handler(req, res) {
  try {
    // Lock down CORS if you want (recommended)
    const allowed = process.env.ALLOWED_ORIGIN || "https://www.reservebarsandrec.com";
    const origin = req.headers.origin || "";
    res.setHeader("Access-Control-Allow-Origin", origin === allowed ? origin : allowed);
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const tokenUrl = "https://c0gfs257.caspio.com/oauth/token";

    const clientId = process.env.CASPIO_CLIENT_ID;
    const clientSecret = process.env.CASPIO_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: "Missing CASPIO_CLIENT_ID or CASPIO_CLIENT_SECRET" });
    }

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

    // Return only what the browser needs
    return res.status(200).json({
      access_token: j.access_token,
      expires_in: j.expires_in,
      token_type: j.token_type,
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  }
}
