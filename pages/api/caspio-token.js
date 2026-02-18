export default async function handler(req, res) {
  // ---- CORS ----
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
  ]);

  const origin = req.headers.origin || "";

  // Weebly embeds / previews sometimes send Origin: null.
  // Since this endpoint does NOT use cookies/credentials, it's safe to allow "*".
  let allowOrigin;
  if (!origin || origin === "null") {
    allowOrigin = "*";
  } else {
    allowOrigin = allowed.has(origin) ? origin : "https://www.reservebarsandrec.com";
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
      return res.status(500).json({ error: "Missing CASPIO_CLIENT_ID or CASPIO_CLIENT_SECRET" });
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
