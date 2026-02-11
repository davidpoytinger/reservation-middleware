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
//   SITE_BASE_URL
//   CASPIO_TABLE
//
// Assumed Caspio fields:
//   Email
//   BookingFeeAmount
//
// Optional (used for display/metadata):
//   Sessions_Title
//   People_Text
//   Charge_Type
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

function formatUsd(amountNumber) {
  const n = Number(amountNumber);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
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

    // Optional display fields
    const sessionsTitleRaw = (reservation.Sessions_Title ?? "").toString().trim();
    const peopleTextRaw = (reservation.People_Text ?? "").toString().trim();
    const chargeTypeRaw = (reservation.Charge_Type ?? "").toString().trim();

    if (!customerEmail) return res.status(400).send("Missing Email on reservation");
    if (!bookingFeeAmount || bookingFeeAmount <= 0) {
      return res.status(400).send("Missing/invalid BookingFeeAmount on reservation");
    }

    const unitAmount = Math.round(bookingFeeAmount * 100);
    const amountDisplay = formatUsd(bookingFeeAmount);

    const displaySessionsTitle = sessionsTitleRaw || "";
    const displayPeopleText = peopleTextRaw ? peopleTextRaw.replace(/\s+/g, " ").trim() : "";
    const displayChargeType = chargeTypeRaw || "Booking Fee";

    // ✅ LEFT COLUMN TITLE (Stripe always shows this):
    // Sessions_Title  |  People_Text   (fallback to Charge_Type if blank)
    const combinedTitle = [displaySessionsTitle, displayPeopleText]
      .filter(Boolean)
      .join("  |  ")
      .slice(0, 120);

    const productName = combinedTitle || displayChargeType;

    // Metadata for webhook/reporting
    const sharedMetadata = {
      reservation_id: String(idkey),
      purpose: "booking_fee",
      Charge_Type: displayChargeType,
      Sessions_Title: displaySessionsTitle,
      People_Text: displayPeopleText,
      Amount_Display: amountDisplay,
    };

    // Smart idempotency: changes if amount/title/text changes
    const idemKey = [
      "RES",
      String(idkey),
      unitAmount,
      shortHash(productName),
      shortHash(displayChargeType),
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
                name: productName,
              },
              unit_amount: unitAmount,
            },
          },
        ],

        // Save card for later off-session policy enforcement
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: sharedMetadata,
        },
        metadata: sharedMetadata,

        success_url: `${process.env.SITE_BASE_URL}/barresv5confirmed?idkey=${encodeURIComponent(idkey)}`,
        cancel_url: `${process.env.SITE_BASE_URL}/barresv5cancelled?idkey=${encodeURIComponent(idkey)}`,
      },
      {
        idempotencyKey: idemKey,
      }
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
