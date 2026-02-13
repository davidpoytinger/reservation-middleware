// pages/api/paystart.js
//
// Caspio -> /api/paystart?idkey=@IDKEY
// Creates a Stripe Checkout Session and redirects to Stripe.
//
// ✅ Passes BOTH IDKEY and RES_ID through Stripe + success/cancel URLs.
// ✅ Ensures a Stripe Customer exists and is used for Checkout
// ✅ Uses setup_future_usage=off_session so the payment method can be reused later
// ❌ Does NOT use payment_method_collection (not allowed for one-time payment Checkout)

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

// Deterministic short hash (not crypto, just stable)
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

    // 1) Pull reservation data
    const reservation = await getReservationByIdKey(idkey);

    const customerEmail = oneLine(reservation.Email);
    const bookingFeeAmount = Number(reservation.BookingFeeAmount);

    const sessionsTitle = oneLine(reservation.Sessions_Title);
    const peopleText = oneLine(reservation.People_Text);
    const chargeTypeRaw = oneLine(reservation.Charge_Type);

    const resIdRaw =
      reservation.RES_ID ??
      reservation.Res_ID ??
      reservation.res_id ??
      reservation.resId ??
      "";

    const resId = oneLine(resIdRaw);

    if (!customerEmail) return res.status(400).send("Missing Email on reservation");
    if (!bookingFeeAmount || bookingFeeAmount <= 0) {
      return res.status(400).send("Missing/invalid BookingFeeAmount on reservation");
    }

    const unitAmount = Math.round(bookingFeeAmount * 100);
    const displayChargeType = chargeTypeRaw || "Booking Fee";
    const belowAmountText = [sessionsTitle, peopleText].filter(Boolean).join("  |  ").slice(0, 500);

    const sharedMetadata = {
      IDKEY: String(idkey),
      RES_ID: resId || "",
      reservation_id: String(idkey),
      purpose: "booking_fee",
      Charge_Type: displayChargeType,
      Sessions_Title: sessionsTitle || "",
      People_Text: peopleText || "",
    };

    const idemKey = [
      "RES",
      String(idkey),
      unitAmount,
      shortHash(displayChargeType),
      shortHash(belowAmountText),
      shortHash(resId || ""),
    ].join("_");

    const base = String(process.env.SITE_BASE_URL).replace(/\/+$/, "");
    const encodedIdKey = encodeURIComponent(idkey);

    const successUrl =
      `${base}/barresv5custmanage.html?idkey=${encodedIdKey}` +
      (resId ? `&res_id=${encodeURIComponent(resId)}` : "");

    const cancelUrl =
      `${base}/barresv5cancelled.html?idkey=${encodedIdKey}` +
      (resId ? `&res_id=${encodeURIComponent(resId)}` : "");

    // 2) Ensure we have a Stripe Customer
    // Prefer existing saved value from Caspio if present
    let stripeCustomerId =
      reservation?.StripeCustomerId ||
      reservation?.Stripe_Customer_ID ||
      reservation?.stripeCustomerId ||
      null;

    if (!stripeCustomerId) {
      // Create a customer (idempotent-ish by using a deterministic key)
      // Stripe doesn't support true idempotency on customers by email, but this is fine operationally.
      const cust = await stripe.customers.create({
        email: customerEmail,
        metadata: {
          IDKEY: String(idkey),
          RES_ID: String(resId || ""),
        },
      });

      stripeCustomerId = cust.id;

      // Write back so future flows have cus_...
      try {
        const where = buildWhereForIdKey(idkey);
        await updateReservationByWhere(where, { StripeCustomerId: stripeCustomerId });
      } catch (e) {
        console.warn("Caspio StripeCustomerId writeback skipped/failed:", e?.message || e);
      }
    }

    // 3) Create Checkout Session (idempotent)
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",

        // ✅ Use the customer so the payment method can attach and be reused off-session
        customer: stripeCustomerId,

        // Helpful for dashboard / recovery
        client_reference_id: String(idkey),

        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              product_data: {
                name: displayChargeType,
                description: belowAmountText,
              },
              unit_amount: unitAmount,
            },
          },
        ],

        // ✅ This is what makes the payment method reusable later
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: sharedMetadata,
        },
        metadata: sharedMetadata,

        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      { idempotencyKey: idemKey }
    );

    // 4) Optional "pending" writeback
    try {
      const where = buildWhereForIdKey(idkey);
      await updateReservationByWhere(where, {
        PaymentStatus: "PendingBookingFee",
        StripeCheckoutSessionId: session.id,
        ...(resId ? { RES_ID: resId } : {}),
      });
    } catch (e) {
      console.warn("Caspio pending writeback skipped/failed:", e?.message || e);
    }

    // 5) Redirect HTML
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
