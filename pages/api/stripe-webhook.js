import Stripe from "stripe";
import { updateReservationByWhere } from "../../lib/caspio";

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

function escapeCaspioValue(v) {
  // Caspio q.where uses single quotes for text.
  // Escape embedded single quotes by doubling them.
  return String(v).replaceAll("'", "''");
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

    // 1) Get the Session
    const session = event.data.object;

    // 2) Pull the IDKEY out of Stripe metadata
    // IMPORTANT: This must be the Caspio IDKEY value you passed into create-checkout-session as "reservationId"
    const reservationId = session?.metadata?.reservation_id;
    if (!reservationId) {
      console.error("❌ Missing metadata.reservation_id on Stripe session");
      return res.status(200).json({ received: true, skipped: "missing_reservation_id" });
    }

    // 3) Retrieve expanded session so we can get payment_intent + card details
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["payment_intent", "customer"],
    });

    const paymentIntent =
      typeof fullSession.payment_intent === "string"
        ? await stripe.paymentIntents.retrieve(fullSession.payment_intent, {
            expand: ["payment_method"],
          })
        : fullSession.payment_intent;

    const customerId =
      typeof fullSession.customer === "string" ? fullSession.customer : fullSession.customer?.id;

    const paymentIntentId = paymentIntent?.id || null;

    // Card details (optional but helpful)
    const pm = paymentIntent?.payment_method;
    const card = pm && typeof pm !== "string" ? pm.card : null;

    const cardBrand = card?.brand || null;
    const cardLast4 = card?.last4 || null;
    const cardExp = card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null;

    // Stripe event/session timestamps are seconds
    const paidAtIso = new Date((fullSession.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();

    // 4) Build Caspio WHERE clause using IDKEY
    const keyField = process.env.CASPIO_KEY_FIELD || "IDKEY";
    const where = `${keyField}='${escapeCaspioValue(reservationId)}'`;

    // 5) Build payload to update Caspio
    // IMPORTANT: Field names MUST match your Caspio column names exactly.
    // Keep the "Stripe*" fields if you created them. The others are optional.
    const payload = {
      // --- Recommended internal tracking fields (rename if your columns differ) ---
      BookingFeePaid: 1,                 // If your field is Yes/No, you can use true instead
      BookingFeePaidAt: paidAtIso,
      StripeCheckoutSessionId: fullSession.id,
      StripePaymentIntentId: paymentIntentId,
      StripeCustomerId: customerId,

      // --- Optional: mirror the "Native Caspio Stripe Payment" fields you listed ---
      // Rename these keys to match your exact Caspio column names.
      Payment_processor: "Stripe",
      Mode: fullSession.livemode ? "live" : "test",
      Payment_service: "Checkout",
      Token_ID: customerId, // Often best to store Stripe Customer ID as your "token" for later charges
      Card_brand: cardBrand,
      Card_number_masked: cardLast4 ? `**** **** **** ${cardLast4}` : null,
      Card_expiration: cardExp,
      Transaction_ID: paymentIntentId,
      Transaction_date: paidAtIso,
    };

    // 6) Write to Caspio
    const result = await updateReservationByWhere(where, payload);

    console.log("✅ Caspio updated reservation (booking fee paid)", {
      reservationId,
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
