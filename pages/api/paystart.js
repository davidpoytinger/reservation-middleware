// pages/api/paystart.js
//
// Caspio -> /api/paystart?idkey=@IDKEY
// This route creates the Stripe Checkout Session and redirects to Stripe.

import Stripe from "stripe";
import {
  getReservationByIdKey,
  updateReservationByWhere,
  buildWhereForIdKey,
} from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// Keep idempotency keys ASCII + <=255 chars.
// Deterministic short hash (not crypto, just stable).
function shortHash(input) {
  const s = String(input || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export default async function handler(req, res) {
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

    const sessionsTitle = oneLine(reservation.Sessions_Title);
    const peopleText = oneLine(reservation.People_Text);
    const chargeTypeRaw = oneLine(reservation.Charge_Type);

    if (!customerEmail) return res.status(400).send("Missing Email on reservation");
    if (!bookingFeeAmount || bookingFeeAmount <= 0) {
      return res.status(400).send("Missing/invalid BookingFeeAmount on reservation");
    }

    const unitAmount = Math.round(bookingFeeAmount * 100);

    // ✅ TOP TITLE (left side): Charge_Type (fallback Booking Fee)
    const displayChargeType = chargeTypeRaw || "Booking Fee";

    // ✅ Text below the amount: Sessions_Title | People_Text
    // Keep it one-line so it reads clean even when Stripe wraps.
    const belowAmountText = [sessionsTitle, peopleText].filter(Boolean).join("  |  ").slice(0, 500);

    // Metadata for webhook/reporting
    const sharedMetadata = {
      reservation_id: String(idkey),
      purpose: "booking_fee",
      Charge_Type: displayChargeType,
      Sessions_Title: sessionsTitle || "",
      People_Text: peopleText || "",
    };

    // ✅ Smart idempotency: changes if amount or visible text changes
    const idemKey = [
      "RES",
      String(idkey),
      unitAmount,
      shortHash(displayChargeType),
      shortHash(belowAmountText),
    ].join("_");

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
              product_data: {
                name: displayChargeType,       // ✅ title at top
                description: belowAmountText,  // ✅ shows below amount (as your screenshot proved)
              },
              unit_amount: unitAmount,
            },
          },
        ],

        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: sharedMetadata,
        },
        metadata: sharedMetadata,

        success_url: `${process.env.SITE_BASE_URL}/barresv5custmanage?idkey=${encodeURIComponent(idkey)}`,
        cancel_url: `${process.env.SITE_BASE_URL}/barresv5cancelled?idkey=${encodeURIComponent(idkey)}`,
      },
      { idempotencyKey: idemKey }
    );

    // 3) Optional Caspio "pending" writeback
    try {
      const where = buildWhereForIdKey(idkey);
      await updateReservationByWhere(where, {
        PaymentStatus: "PendingBookingFee",
        StripeCheckoutSessionId: session.id,
      });
    } catch (e) {
      console.warn("Caspio pending writeback skipped/failed:", e?.message || e);
    }

    // 4) Redirect to Stripe Checkout
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
