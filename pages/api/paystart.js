// pages/api/paystart.js
//
// Purpose:
// - Browser lands here from Caspio after form submit:
//     https://reservation-middleware2.vercel.app/api/paystart?idkey=@IDKEY
// - Server looks up the reservation in Caspio, creates a Stripe Checkout Session (idempotent),
//   optionally writes "pending" status back to Caspio, then shows a short branded
//   "Redirecting to secure payment..." page and navigates to Stripe Checkout.
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   SITE_BASE_URL                  e.g. https://reservebarsandrec.com
//   CASPIO_INTEGRATION_URL         e.g. https://c0gfs257.caspio.com
//   CASPIO_TOKEN_URL               e.g. https://c0gfs257.caspio.com/oauth/token
//   CASPIO_CLIENT_ID
//   CASPIO_CLIENT_SECRET
//   CASPIO_TABLE                   e.g. BAR2_Reservations_SIGMA
//   CASPIO_KEY_FIELD               e.g. IDKEY
//
// Assumed Caspio fields:
//   Email
//   BookingFeeAmount
//
// Optional Caspio fields (only if you have them):
//   PaymentStatus
//   StripeCheckoutSessionId

import Stripe from "stripe";
import {
  getReservationByIdKey,
  updateReservationByWhere,
  buildWhereForIdKey,
} from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

export default async function handler(req, res) {
  // We only want simple GET navigations here (Caspio/browser redirect)
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).send("Missing STRIPE_SECRET_KEY");
    if (!process.env.SITE_BASE_URL) return res.status(500).send("Missing SITE_BASE_URL");
    if (!process.env.CASPIO_TABLE) return res.status(500).send("Missing CASPIO_TABLE");

    const idkey = req.query.idkey || req.query.IDKEY || req.query.IdKey;
    if (!idkey) return res.status(400).send("Missing idkey");

    // 1) Pull reservation data from Caspio
    const reservation = await getReservationByIdKey(idkey);

    const customerEmail = reservation.Email;
    const bookingFeeAmount = Number(reservation.BookingFeeAmount);

    if (!customerEmail) return res.status(400).send("Missing Email on reservation");
    if (!bookingFeeAmount || bookingFeeAmount <= 0) {
      return res.status(400).send("Missing/invalid BookingFeeAmount on reservation");
    }

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

        // Save card for later off-session policy enforcement
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: { reservation_id: String(idkey), purpose: "booking_fee" },
        },
        metadata: { reservation_id: String(idkey), purpose: "booking_fee" },

        success_url: `${process.env.SITE_BASE_URL}/barresv5confirmed?idkey=${encodeURIComponent(
          idkey
        )}`,
        cancel_url: `${process.env.SITE_BASE_URL}/barresv5cancelled?idkey=${encodeURIComponent(
          idkey
        )}`,
      },
      {
        idempotencyKey: `RES_${idkey}_checkout_v1`,
      }
    );

    // 3) Optional Caspio "pending" writeback
    // If these columns don't exist, either add them or remove this update block.
    try {
      const where = buildWhereForIdKey(idkey);
      await updateReservationByWhere(where, {
        PaymentStatus: "PendingBookingFee",
        StripeCheckoutSessionId: session.id,
      });
    } catch (e) {
      // Don't block payment if the "pending writeback" fails
      console.warn("Caspio pending writeback skipped/failed:", e?.message || e);
    }

    // 4) Polished handoff page (briefly) then redirect to Stripe Checkout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

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
    setTimeout(function () {
      window.location.replace(${JSON.stringify(session.url)});
    }, 250);
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
