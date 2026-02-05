import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method not allowed");

    const { reservationId, bookingFeeAmount, customerEmail } = req.body || {};
    if (!reservationId) return res.status(400).json({ error: "Missing reservationId" });
    if (!customerEmail) return res.status(400).json({ error: "Missing customerEmail" });

    const amt = Number(bookingFeeAmount);
    if (!amt || amt <= 0) return res.status(400).json({ error: "Missing/invalid bookingFeeAmount" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: customerEmail,

      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            product_data: { name: "Booking Fee" },
            unit_amount: Math.round(amt * 100),
          },
        },
      ],

      // KEY: save card for later (policy enforcement)
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: { reservation_id: String(reservationId), purpose: "booking_fee" },
      },
      metadata: { reservation_id: String(reservationId), purpose: "booking_fee" },

      success_url: `${process.env.SITE_BASE_URL}/reservation-confirmed?resId=${encodeURIComponent(reservationId)}`,
      cancel_url: `${process.env.SITE_BASE_URL}/reservation-payment-cancelled?resId=${encodeURIComponent(reservationId)}`,
    });

    return res.status(200).json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
