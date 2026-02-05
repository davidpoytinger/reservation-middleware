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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const reservationId = session?.metadata?.reservation_id;
      if (!reservationId) {
        console.error("❌ Missing reservation_id in Stripe metadata");
        return res.status(200).json({ received: true, skipped: "missing_reservation_id" });
      }

      const keyField = process.env.CASPIO_KEY_FIELD || "ReservationID";

      // IMPORTANT: If your ReservationID is numeric, remove the quotes below.
      const where = `${keyField}='${String(reservationId).replaceAll("'", "''")}'`;

      const payload = {
        BookingFeePaid: 1, // or true (depends on your Caspio field type)
        BookingFeePaidAt: new Date((session.created || Math.floor(Date.now()/1000)) * 1000).toISOString(),
        StripeCheckoutSessionId: session.id,
        StripePaymentIntentId: session.payment_intent || null,
        StripeCustomerId: session.customer || null,
      };

      const result = await updateReservationByWhere(where, payload);

      console.log("✅ Caspio updated reservation", { reservationId, where, result });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
