export default async function handler(req, res) {
  const base = `https://${req.headers.host}`;

  const response = await fetch(`${base}/api/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reservationId: "TEST-RES-123",
      bookingFeeAmount: 10,
      customerEmail: "test@example.com"
    }),
  });

  const data = await response.json();
  res.status(200).json(data);
}
