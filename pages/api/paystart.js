// pages/api/paystart.js
import { getReservationByIdKey } from "../../lib/caspio"; // optional sanity check; can remove

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    if (!process.env.SITE_BASE_URL) return res.status(500).send("Missing SITE_BASE_URL");

    const idkey = req.query.idkey || req.query.IDKEY || req.query.IdKey;
    if (!idkey) return res.status(400).send("Missing idkey");

    // Optional: quick sanity check that reservation exists (non-required)
    await getReservationByIdKey(idkey);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    // Calls create-checkout-session and redirects to returned URL
    return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Redirecting to secure payment…</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background: #ffffff;
    }
    .box { text-align: center; padding: 24px; }
    .title { font-size: 20px; font-weight: 600; }
    .sub { margin-top: 8px; opacity: .7; }
    .spinner {
      width: 36px;
      height: 36px;
      margin: 20px auto 0;
      border: 3px solid rgba(0,0,0,.15);
      border-top-color: rgba(0,0,0,.6);
      border-radius: 50%;
      animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="box">
    <div class="title">Redirecting to secure payment…</div>
    <div class="sub">This usually takes just a moment.</div>
    <div class="spinner"></div>
  </div>

  <script>
    (async function () {
      try {
        const resp = await fetch("/api/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idkey: ${JSON.stringify(String(idkey))} })
        });

        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || "Could not start checkout");

        window.location.replace(data.url);
      } catch (e) {
        document.body.innerHTML =
          "<pre style='white-space:pre-wrap;font-family:system-ui;padding:16px;'>"
          + "We couldn’t start your payment.\\n"
          + (e && e.message ? e.message : String(e))
          + "</pre>";
      }
    })();
  </script>
</body>
</html>`);
  } catch (err) {
    console.error(err);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).send(err?.message || "Server error");
  }
}
