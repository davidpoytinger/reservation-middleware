import Stripe from "stripe";
import { getReservationByIdKey, updateReservationByWhere, buildWhereForIdKey } from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

function setCors(res, origin) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://reservebarsandrec.com";
  const allowOrigin = origin && origin === allowed ? origin : allowed;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function shortHash(input) {
  const s = String(input || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "create-checkout-session" });
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    if (!process.env.SITE_BASE_URL) return res.status(500).json({ error: "Missing SITE_BASE_URL" });
    if (!process.env.CASPIO_TABLE) return res.status(500).json({ error: "Missing CASPIO_TABLE" });

    const body = req.body || {};
    const idkey = body.idkey || body.IDKEY || body.IdKey;
    if (!idkey) return res.status(400).json({ error: "Missing idkey" });

    const reservation = await getReservationByIdKey(idkey);

    const customerEmail = reservation.Email;
    const bookingFeeAmount = Number(reservation.BookingFeeAmount);

    const chargeType = (reservation.Charge_Type ?? "").toString().trim();
    const sessionsTitle = (reservation.Sessions_Title ?? "").toString().trim();
    const peopleText = (reservation.People_Text ?? "").toString().trim();

    if (!customerEmail) return res.status(400).json({ error: "Missing Email on reservation" });
    if (!bookingFeeAmount || bookingFeeAmount <= 0) {
      return res.status(400).json({ error: "Missing/invalid BookingFeeAmount on reservation" });
    }

    const unitAmount = Math.round(bookingFeeAmount * 100);

    // ✅ LEFT column title on Stripe Checkout
    const productName = chargeType || "Booking Fee";

    const sharedMetadata = {
      reservation_id: String(idkey),
      purpose: "booking_fee",
      Charge_Type: productName,
      Sessions_Title: sessionsTitle || "",
      People_Text: peopleText || "",
    };

    const idemKey = [
      "RES",
      String(idkey),
      unitAmount,
      shortHash(productName),
      shortHash(sessionsTitle),
      shortHash(peopleText),
    ].join("_");

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: customerEmail,

        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              product_data: { name: productName },
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

    // Optional "pending" writeback
    const where = buildWhereForIdKey(idkey);
    await updateReservationByWhere(where, {
      PaymentStatus: "PendingBookingFee",
      StripeCheckoutSessionId: session.id,
    });

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

