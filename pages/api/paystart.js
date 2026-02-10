import Stripe from "stripe";
import { getReservationByIdKey, updateReservationByWhere, buildWhereForIdKey } from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

export default async function handler(req, res) {
  // Allow GET only (simple redirect endpoint)
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).send("Missing STRIPE_SECRET_KEY");
    if (!process.env.SITE_BASE_URL) return res.status(500).send("Missing SITE_BASE_URL");
    if (!process.env.CASPIO_TABLE) return res.status(500).send("Missing CASPIO_TABLE");

    const idkey = req.query.idkey || req.query.IDKEY;
    if (!idkey) return res.status(400).send("Missing idkey");

    // 1) Pull reservation data from Caspio
    const reservation = await getReservationByIdKey(idkey);
    const customerEmail = reservation.Email;
    const bookingFeeAmount = Number(reservation.BookingFeeAmount);

    if (!customerEmail) return res.status(400).send("Missing Email on reservation");
    if (!bookingFeeAmount || bookingFeeAmount <= 0) return res.status(400).send("Missing/invalid BookingFeeAmount");

    // 2) Create Stripe Checkout Session (idempotent)
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: customerEmail,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              product_data: { name: "Booking Fee" },
              unit_amount: Math.round(bookingFeeAmount * 100),
            },
          },
        ],
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: { reservation_id: String(idkey), purpose: "booking_fee" },
        },
        metadata: { reservation_id: String(idkey), purpose: "booking_fee" },

        success_url: `${process.env.SITE_BASE_URL}/barresv5confirmed?idkey=${encodeURIComponent(idkey)}`,
        cancel_url: `${process.env.SITE_BASE_URL}/barresv5cancelled?idkey=${encodeURIComponent(idkey)}`,
      },
      {
        idempotencyKey: `RES_${idkey}_checkout_v1`,
      }
    );

    // 3) Optional Caspio “pending” writeback
    const where = buildWhereForIdKey(idkey);
    await updateReservationByWhere(where, {
      PaymentStatus: "PendingBookingFee",
      StripeCheckoutSessionId: session.id,
    });

    // ✅ Redirect the browser straight to Stripe Checkout
    // 303 is safest for “go to this URL” after server processing
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(303, session.url);
  } catch (err) {
    console.error(err);
    return res.status(500).send(err.message || "Server error");
  }
}
