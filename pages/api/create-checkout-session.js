import Stripe from "stripe";
import { getReservationByIdKey, updateReservationByWhere } from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

function escapeCaspioValue(v) {
  return String(v).replaceAll("'", "''");
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "create-checkout-session" });
  }
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    if (!process.env.SITE_BASE_URL) return res.status(500).json({ error: "Missing SITE_BASE_URL" });
    if (!process.env.CASPIO_TABLE) return res.status(500).json({ error: "Missing CASPIO_TABLE" });

    const { idkey } = req.body || {};
    if (!idkey) return res.status(400).json({ error: "Missing idkey" });

    // ---- CONFIG: change these to your real Caspio column names ----
    const CASPIO_EMAIL_FIELD = "Email";           // <-- change if different
    const CASPIO_BOOKING_FEE_FIELD = "BookingFeeAmount"; // <-- change if different
    // --------------------------------------------------------------

    const reservation = await getReservationByIdKey(idkey);

    const customerEmail = reservation[CASPIO_EMAIL_FIELD];
    const bookingFeeAmount = Number(reservation[CASPIO_BOOKING_FEE_FIELD]);

    if (!customerEmail) return res.status(400).json({ error: `Missing ${CASPIO_EMAIL_FIELD} on reservation` });
    if (!bookingFeeAmount || bookingFeeAmount <= 0)
      return res.status(400).json({ error: `Missing/invalid ${CASPIO_BOOKING_FEE_FIELD} on reservation` });

    const session = await stripe.checkout.sessions.create({
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

      // Save card for later (off-session policy enforcement)
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: { reservation_id: String(idkey), purpose: "booking_fee" },
      },
      metadata: { reservation_id: String(idkey), purpose: "booking_fee" },

      success_url: `${process.env.SITE_BASE_URL}/barresv5confirmed?idkey=${encodeURIComponent(idkey)}`,
      cancel_url: `${process.env.SITE_BASE_URL}/barresv5cancelled?idkey=${encodeURIComponent(idkey)}`,
    });

    // Optional: record the session id immediately in Caspio so you can trace attempts
    const keyField = process.env.CASPIO_KEY_FIELD || "IDKEY";
    const where = `${keyField}='${escapeCaspioValue(idkey)}'`;

    // Rename these fields to match your Caspio schema, or remove if not created yet
    await updateReservationByWhere(where, {
      PaymentStatus: "PendingBookingFee",
      StripeCheckoutSessionId: session.id,
    });

    return res.status(200).json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
