import Stripe from "stripe";
import {
  updateReservationByWhere,
  insertTransactionIfMissingByRawEventId,
  getReservationByIdKey,
  getResBillingEditViewRowByIdKey,
} from "../../lib/caspio";

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
    console.error("❌ Stripe signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;

  const idkey = session?.metadata?.reservation_id;
  if (!idkey) return res.status(200).json({ received: true });

  // ✅ Pull metadata sent from create-checkout-session
  const metaChargeType = session?.metadata?.Charge_Type || null;
  const metaSessionsTitle = session?.metadata?.Sessions_Title || null;
  const metaPeopleText = session?.metadata?.People_Text || null;

  try {
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["customer", "payment_intent"],
    });

    let paymentIntent = fullSession.payment_intent;
    if (typeof paymentIntent === "string") {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent, {
        expand: ["payment_method", "charges.data.payment_method_details"],
      });
    }

    const charge = paymentIntent?.charges?.data?.[0];
    const card =
      charge?.payment_method_details?.card ||
      (typeof paymentIntent?.payment_method !== "string"
        ? paymentIntent?.payment_method?.card
        : null);

    const amountCents = paymentIntent?.amount_received ?? paymentIntent?.amount ?? null;
    const amountDollars =
      typeof amountCents === "number" ? Number((amountCents / 100).toFixed(2)) : null;

    const currency = paymentIntent?.currency?.toLowerCase() || "usd";

    const paidAtUnix =
      charge?.created ||
      paymentIntent?.created ||
      fullSession.created ||
      Math.floor(Date.now() / 1000);

    const paidAtIso = new Date(paidAtUnix * 1000).toISOString();

    const where = `IDKEY='${String(idkey).replaceAll("'", "''")}'`;

    // -----------------------------------------
    // VIEW LOOKUP
    // -----------------------------------------
    let viewRow = null;
    try {
      viewRow = await getResBillingEditViewRowByIdKey(idkey);
    } catch (e) {
      console.warn("⚠️ VIEW_LOOKUP_FAILED (non-blocking)", e?.message);
    }

    // -----------------------------------------
    // RESERVATION UPDATE
    // -----------------------------------------
    const payload = {
      BookingFeePaidAt: paidAtIso,
      StripeCheckoutSessionId: fullSession.id,
      StripePaymentIntentId: paymentIntent?.id || null,
      StripeCustomerId:
        typeof fullSession.customer === "string"
          ? fullSession.customer
          : fullSession.customer?.id || null,

      Payment_processor: "Stripe",
      Mode: fullSession.livemode ? "live" : "test",
      Status: "Booked",
      Payment_service: "Checkout",

      Card_brand: card?.brand || null,
      Card_number_masked: card?.last4 ? `**** **** **** ${card.last4}` : null,
      Card_expiration:
        card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null,

      Transaction_ID: paymentIntent?.id || null,
      Transaction_date: paidAtIso,
    };

    // ✅ Update reservation with Stripe metadata (if present)
    if (metaChargeType) payload.Charge_Type = metaChargeType;
    if (metaSessionsTitle) payload.Sessions_Title = metaSessionsTitle;
    if (metaPeopleText) payload.People_Text = metaPeopleText;

    if (viewRow) {
      if (viewRow.BAR2_Email_Design_Email_Content) {
        const maxLen = 64000;
        const val = String(viewRow.BAR2_Email_Design_Email_Content);
        payload.Email_Design = val.length > maxLen ? val.slice(0, maxLen) : val;
      }

      payload.Logo_Graphic_Email_String =
        viewRow.GEN_Business_Units_Logo_Graphic_Email_String || null;

      payload.Units_DBA =
        viewRow.GEN_Business_Units_DBA || null;

      payload.Sessions_Title =
        viewRow.BAR2_Sessions_Title || payload.Sessions_Title || null;

      payload.Event_Email_Preheader =
        viewRow.GEN_Business_Units_Event_Email_Preheader || null;

      payload.Primary_Color_1 =
        viewRow.GEN_Business_Units_Primary_Color_1 || null;

      payload.Primary_Color_2 =
        viewRow.GEN_Business_Units_Primary_Color_2 || null;

      payload.Facility =
        viewRow.GEN_Business_Units_Facility || null;
    }

    await updateReservationByWhere(where, payload);

    // -----------------------------------------
    // TRANSACTION INSERT
    // -----------------------------------------
    let reservationChargeType = metaChargeType;
    if (!reservationChargeType) {
      const reservationRow = await getReservationByIdKey(idkey).catch(() => null);
      reservationChargeType = reservationRow?.Charge_Type || "booking_fee";
    }

    const txnPayload = {
      IDKEY: String(idkey),
      Amount: amountDollars,
      Currency: currency,
      PaymentStatus: "PaidBookingFee",
      Status: paymentIntent?.status || "succeeded",
      StripeCheckoutSessionId: fullSession.id,
      StripePaymentIntentId: paymentIntent?.id || null,
      StripeChargeId: charge?.id || null,
      StripeCustomerId:
        typeof fullSession.customer === "string"
          ? fullSession.customer
          : fullSession.customer?.id || null,

      Charge_Type: reservationChargeType,
      Description: reservationChargeType,

      RawEventId: String(event.id),
      Transaction_date: paidAtIso,
      CreatedAt: new Date().toISOString(),
    };

    await insertTransactionIfMissingByRawEventId(txnPayload).catch((e) =>
      console.error("⚠️ TXN_INSERT_FAILED", e?.message)
    );

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ WEBHOOK_FAILED", err?.message);
    return res.status(200).json({ received: true });
  }
}
