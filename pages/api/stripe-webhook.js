// pages/api/stripe-webhook.js
//
// Stripe webhook that updates Caspio by IDKEY (metadata.reservation_id).
// Uses path-based updateReservationByIdKey to avoid PUT-with-where routing issues.
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   CASPIO_INTEGRATION_URL / CASPIO_TOKEN_URL (recommended)
//   CASPIO_TABLE=BAR2_Reservations_SIGMA
//   CASPIO_KEY_FIELD=IDKEY
//
// IMPORTANT:
// - Field names in payload MUST exactly match your Caspio column names.
// - If you haven't created some of these columns yet, remove them or rename accordingly.

import Stripe from "stripe";
import { updateReservationByIdKey } from "../../lib/caspio";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

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

    // This should be your Caspio IDKEY (you passed it as idkey into create-checkout-session)
    const idkey = session?.metadata?.reservation_id;
    if (!idkey) {
      console.error("❌ Missing metadata.reservation_id on Stripe session");
      return res.status(200).json({ received: true, skipped: "missing_reservation_id" });
    }

    // Expand session => get customer + payment_intent
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["customer", "payment_intent"],
    });

    // Pull payment details
    let paymentIntent = fullSession.payment_intent;
    if (typeof paymentIntent === "string") {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ["payment_method"] });
    } else if (paymentIntent && typeof paymentIntent !== "string") {
      // ensure payment_method expanded if possible
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
    const cardExp =
      card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null;

    const paidAtIso = new Date(
      (fullSession.created || Math.floor(Date.now() / 1000)) * 1000
    ).toISOString();

    // ---- Caspio payload (rename fields to match YOUR schema) ----
    const payload = {
      BookingFeePaid: 1,
      BookingFeePaidAt: paidAtIso,

      StripeCheckoutSessionId: fullSession.id,
      StripePaymentIntentId: paymentIntentId,
      StripeCustomerId: customerId,

      // Optional “native-ish” fields (remove/rename if not present in Caspio)
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
    // ------------------------------------------------------------

    const result = await updateReservationByIdKey(idkey, payload);

    console.log("✅ Caspio updated reservation (booking fee paid)", {
      idkey,
      sessionId: fullSession.id,
      paymentIntentId,
      customerId,
      result,
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    // If you prefer Stripe to always show green deliveries even if Caspio fails,
    // you can return 200 here instead of 500. For now, keep it strict:
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
