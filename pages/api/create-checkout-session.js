import Stripe from "stripe";
import { getReservationByIdKey, updateReservationByWhere, buildWhereForIdKey } from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

function setCors(res, origin) {
  // Weebly site origin
  const allowed = process.env.ALLOWED_ORIGIN || "https://reservebarsandrec.com";

  // If request comes from allowed origin, echo it back; otherwise still allow the configured origin.
  const allowOrigin = origin && origin === allowed ? origin : allowed;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function formatUsd(amountNumber) {
  const n = Number(amountNumber);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default async function handler(req, res) {
  // ✅ CORS for browser calls (Weebly -> Vercel is cross-origin)
  setCors(res, req.headers.origin);

  // ✅ Preflight (this is what fixes "Failed to fetch")
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Handy browser sanity check (optional)
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "create-checkout-session" });
  }

  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    if (!process.env.SITE_BASE_URL) return res.status(500).json({ error: "Missing SITE_BASE_URL" });
    if (!process.env.CASPIO_TABLE) return res.status(500).json({ error: "Missing CASPIO_TABLE" });

    // Accept either casing from client
    const body = req.body || {};
    const idkey = body.idkey || body.IDKEY || body.IdKey;

    if (!idkey) return res.status(400).json({ error: "Missing idkey" });

    // 1) Pull reservation data from Caspio
    const reservation = await getReservationByIdKey(idkey);

    const customerEmail = reservation.Email;
    const bookingFeeAmount = Number(reservation.BookingFeeAmount);

    // ✅ Pull the fields you want shown/passed to Stripe
    const peopleText = (reservation.People_Text ?? "").toString().trim();
    const sessionsTitle = (reservation.Sessions_Title ?? "").toString().trim();
    const chargeType = (reservation.Charge_Type ?? "").toString().trim();

    if (!customerEmail) return res.status(400).json({ error: "Missing Email on reservation" });
    if (!bookingFeeAmount || bookingFeeAmount <= 0) {
      return res.status(400).json({ error: "Missing/invalid BookingFeeAmount on reservation" });
    }

    // Stripe amounts
    const unitAmount = Math.round(bookingFeeAmount * 100);
    const amountDisplay = formatUsd(bookingFeeAmount);

    // Display strings (safe fallbacks)
    const displaySessionsTitle = sessionsTitle || "Your Reservation";
    const displayPeopleText = peopleText || "";
    const displayChargeType = chargeType || "Amount Due Now";

    // -----
    // DISPLAY IN STRIPE CHECKOUT (best approximation of your requested layout)
    // -----
    // Line item name shows next to the amount, so make it Charge_Type.
    // Description shows right under the line item name.
    const lineItemName = displayChargeType;

    const lineItemDescription = [
      "What You Are Booking",
      displaySessionsTitle,
      displayPeopleText,
    ]
      .filter(Boolean)
      .join("\n");

    const submitMessage = [
      "What You Are Booking",
      displaySessionsTitle,
      displayPeopleText,
      "",
      "What You Owe Now",
      `${displayChargeType}: ${amountDisplay}`,
    ]
      .filter((v) => v !== undefined && v !== null)
      .join("\n");

    // Metadata for webhook/reporting
    const sharedMetadata = {
      reservation_id: String(idkey),
      purpose: "booking_fee",
      Charge_Type: displayChargeType,
      Sessions_Title: displaySessionsTitle,
      People_Text: displayPeopleText,
    };

    // 2) Create Stripe Checkout Session (with idempotency)
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
  // This becomes the BIG title on the left
  name: displayChargeType,  // e.g. "Booking Fee", "Deposit", "Balance Due"

  // This becomes the smaller text under it (Stripe may show it, depending on layout)
  description: [
    "What You Are Booking",
    displaySessionsTitle,
    displayPeopleText,
    "",
    "What You Owe Now",
    `${displayChargeType}: ${amountDisplay}`,
  ].filter(Boolean).join("\n"),
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

        // Also attach to Checkout Session itself (easy to read in webhook)
        metadata: sharedMetadata,

        // Message near the pay button
        custom_text: {
          submit: { message: submitMessage },
        },

        // Weebly pages
        success_url: `${process.env.SITE_BASE_URL}/barresv5confirmed?idkey=${encodeURIComponent(idkey)}`,
        cancel_url: `${process.env.SITE_BASE_URL}/barresv5cancelled?idkey=${encodeURIComponent(idkey)}`,
      },
      {
        // ✅ prevents duplicate sessions on retry/double-click
        - idempotencyKey: `RES_${idkey}_checkout_v2`,
+ idempotencyKey: `RES_${idkey}_checkout_v3`,

      }
    );

    // 3) Optional: write "pending" status + session id back to Caspio for traceability
    const where = buildWhereForIdKey(idkey);

    await updateReservationByWhere(where, {
      PaymentStatus: "PendingBookingFee",
      StripeCheckoutSessionId: session.id,
    });

    // ✅ Return both keys so your front-end can use either
    return res.status(200).json({
      url: session.url,
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
