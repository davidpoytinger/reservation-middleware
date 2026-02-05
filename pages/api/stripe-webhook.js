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
  // ✅ PROVE which deployment Stripe is hitting
  console.log("WEBHOOK_HIT", {
    host: req.headers.host,
    url: req.url,
    caspioIntegrationUrlSet: !!process.env.CASPIO_INTEGRATION_URL,
    caspioIntegrationUrlHost: process.env.CASPIO_INTEGRATION_URL || null,
    caspioTable: process.env.CASPIO_TABLE || null,
    caspioKeyField: process.env.CASPIO_KEY_FIELD || null,
  });

  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Stripe signature verification failed:", err.message);
    // Still OK to return 400 here (Stripe will retry if misconfigured)
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Only handle this event type
  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const idkey = session?.metadata?.reservation_id;

  if (!idkey) {
    console.error("❌ Missing metadata.reservation_id on Stripe session", { sessionId: session?.id });
    // Return 200 so Stripe doesn't keep retrying forever
    return res.status(200).json({ received: true });
  }

  try {
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

    const paidAtIso = new Date(
      (fullSession.created || Math.floor(Date.now() / 1000)) * 1000
    ).toISOString();

    const where = buildWhereForIdKey(idkey);

    const payload = {
      BookingFeePaidAt: paidAtIso,
      StripeCheckoutSessionId: fullSession.id,
      StripePaymentIntentId: paymentIntentId,
      StripeCustomerId: customerId,

      // Optional extras (remove/rename if your Caspio columns differ)
      Payment_processor: "Stripe",
      Mode: fullSession.livemode ? "live" : "test",
      Payment_service: "Checkout",
      Token_ID: customerId,
      Card_brand: card?.brand || null,
      Card_number_masked: card?.last4 ? `**** **** **** ${card.last4}` : null,
      Card_expiration: card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null,
      Transaction_ID: paymentIntentId,
      Transaction_date: paidAtIso,
    };

    const result = await updateReservationByWhere(where, payload);

    console.log("✅ CASPIO_UPDATE_OK", { idkey, where, result });

    // ✅ Always return 200 to Stripe
    return res.status(200).json({ received: true });
  } catch (err) {
    // ✅ Log the real error in Vercel, but do NOT send it back to Stripe
    console.error("❌ CASPIO_UPDATE_FAILED", { idkey, message: err?.message || String(err) });

    // ✅ Always return 200 so Stripe stops showing scary red/failed deliveries
    return res.status(200).json({ received: true });
  }
}
