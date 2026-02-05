// pages/api/stripe-webhook.js
//
// Stripe webhook -> updates Caspio using PUT with q.where (NOT /records/{id})
//
// Requires env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   CASPIO_INTEGRATION_URL=https://c0gfs257.caspio.com
//   CASPIO_TOKEN_URL=https://c0gfs257.caspio.com/oauth/token
//   CASPIO_TABLE=BAR2_Reservations_SIGMA
//   CASPIO_KEY_FIELD=IDKEY
//   CASPIO_CLIENT_ID / CASPIO_CLIENT_SECRET

import Stripe from "stripe";
import { updateReservationByWhere, buildWhereForIdKey } from "../../lib/caspio";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ received: true, ignored: event.type });
    }

    const session = event.data.object;

    // We store Caspio IDKEY here when creating checkout session
    const idkey = session?.metadata?.reservation_id;
    if (!idkey) {
      console.error("❌ Missing metadata.reservation_id on Stripe session");
      return res.status(200).json({ received: true, skipped: "missing_reservation_id" });
    }

    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["customer", "payment_intent"],
    });

    let paymentIntent = fullSession.payment_intent;
    if (typeof paymentIntent === "string") {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ["payment_method"] });
    } else if (paymentIntent && typeof paymentIntent !== "string") {
      if (typeof paymentIntent.payment_method === "string") {
        paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent.id, { expand: ["payment_method"] });
      }
    }

    const customerId =
      typeof fullSession.customer === "string" ? fullSession.customer : fullSession.customer?.id || null;

    const paymentIntentId = paymentIntent?.id || null;

    const pm = paymentIntent?.payment_method;
    const card = pm && typeof pm !== "string" ? pm.card : null;

    const cardBrand = card?.brand || null;
    const cardLast4 = card?.last4 || null;
    const cardExp = card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null;

    const paidAtIso = new Date(
      (fullSession.created || Math.floor(Date.now() / 1000)) * 1000
    ).toISOString();

    const where = buildWhereForIdKey(idkey);

    // IMPORTANT: These field names MUST match your Caspio columns exactly.
    // If Caspio throws "Unknown column", rename/remove that key.
    const payload = {
      BookingFeePaid: 1,
      BookingFeePaidAt: paidAtIso,
      StripeCheckoutSessionId: fullSession.id,
      StripePaymentIntentId: paymentIntentId,
      StripeCustomerId: customerId,

      // Optional fields (remove/rename if they don't exist in Caspio)
      Payment_processor: "Stripe",
      Mode: fullSession.livemode ? "live" : "test",
      Payment_service: "Checkout",
      Token_ID: customerId,
      Card_brand: cardBrand,
      Card_number_masked: cardLast4 ? `**** **** **** ${cardLast4}` : null,
      Card_expiration: cardExp,
      Transaction_ID: paymentIntentId,
      Transaction_date: paidAtIso,
    };

    const result = await updateReservationByWhere(where, payload);

    console.log("✅ Caspio updated reservation (booking fee paid)", {
      idkey,
      where,
      sessionId: fullSession.id,
      paymentIntentId,
      customerId,
      result,
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
