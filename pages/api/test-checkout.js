// pages/api/test-checkout.js
//
// Browser-friendly tester for your middleware.
// Hit: https://YOUR-VERCEL-DOMAIN.vercel.app/api/test-checkout?idkey=YOUR_IDKEY
//
// If you don't pass ?idkey=..., it will fall back to TEST_IDKEY below.
// IMPORTANT: Replace TEST_IDKEY with a real Caspio IDKEY when testing for real.

export default async function handler(req, res) {
  const base = `https://${req.headers.host}`;

  // You can pass ?idkey=... in the URL to test different reservations quickly
  const idkeyFromQuery = Array.isArray(req.query?.idkey) ? req.query.idkey[0] : req.query?.idkey;

  // Fallback for convenience (replace with a real IDKEY)
  const TEST_IDKEY = "B9Q9PN8L1M";

  const idkey = idkeyFromQuery || TEST_IDKEY;

  try {
    const response = await fetch(`${base}/api/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idkey }),
    });

    const contentType = response.headers.get("content-type") || "";
    const bodyText = await response.text();

    // Return a helpful debug view in the browser
    res.status(200).send(
      `Downstream status: ${response.status}\n` +
        `Downstream content-type: ${contentType}\n` +
        `Using idkey: ${idkey}\n\n` +
        bodyText
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
