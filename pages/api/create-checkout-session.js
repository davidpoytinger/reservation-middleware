// pages/api/create-checkout-session.js
//
// Version A (recommended): client sends ONLY { idkey }.
// Server pulls Email + BookingFeeAmount from Caspio, creates Stripe Checkout,
// saves card for later off-session charges, and writes "pending" info back to Caspio.
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   SITE_BASE_URL
//   CASPIO_INTEGRATION_URL=https://c0gfs257.caspio.com
//   CASPIO_TOKEN_URL=https://c0gfs257.caspio.com/oauth/token
//   CASPIO_CLIENT_ID
//   CASPIO_CLIENT_SECRET
//   CASPIO_TABLE=BAR2_Reservations_SIGMA
//   CASPIO_KEY_FIELD=IDKEY
//
// Caspio fields assumed (as you confirmed):
//   Email
//   BookingFeeAmount
//
// IMPORTANT:
// - The Caspio update payload keys (PaymentStatus, StripeCheckoutSessionId) must exist in your table.
//   If you don't have them, remove those lines or rename to your actual column names.

import Stripe from "stripe";
import { getReservationByIdKey, updateReservationByWhere, buildWhereForIdKey } from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

export default async function handler(req, res) {
  // Handy browser sanity check (optional)
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

    // 1) Pull reservation data from Caspio
    const reservation = await getReservationByIdKey(idkey);

    const customerEmail = reservation.Email;
    const bookingFeeAmount = Number(reservation.BookingFeeAmount);

    if (!customerEmail) return res.status(400).json({ error: "Missing Email on reservation" });
    if (!bookingFeeAmount || bookingFeeAmount <= 0) {
      return res.status(400).json({ error: "Missing/invalid BookingFeeAmount on reservation" });
    }

    // 2) Create Stripe Checkout Session
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

      // Save card for later off-session policy enforcement
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: { reservation_id: String(idkey), purpose: "booking_fee" },
      },
      metadata: { reservation_id: String(idkey), purpose: "booking_fee" },

      // You can change these to whatever Weebly pages you want
      success_url: `${process.env.SITE_BASE_URL}/barresv5confirmed?idkey=${encodeURIComponent(idkey)}`,
      cancel_url: `${process.env.SITE_BASE_URL}/barresv5cancelled?idkey=${encodeURIComponent(idkey)}`,
    });

    // 3) Optional: write "pending" status + session id back to Caspio for traceability
    // Remove/rename these fields if they don't exist in your Caspio table.
    const where = buildWhereForIdKey(idkey);

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
