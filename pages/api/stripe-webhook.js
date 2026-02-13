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

function escapeWhereValue(v) {
  return String(v ?? "").replaceAll("'", "''");
}

/**
 * If Caspio responds with ColumnNotFound, drop those fields and retry once.
 * This makes the webhook robust while you roll out new columns like StripePaymentMethodId.
 */
async function updateReservationResilient(where, payload) {
  try {
    return await updateReservationByWhere(where, payload);
  } catch (err) {
    const msg = String(err?.message || "");
    const m = msg.match(/field\(s\) do not exist:\s*'([^']+)'(?:,\s*'([^']+)')*/i);

    // If we can’t parse, just rethrow
    if (!/ColumnNotFound/i.test(msg) && !m) throw err;

    // Try to extract all quoted field names after "do not exist:"
    const missing = [];
    const after = msg.split("do not exist:")[1] || "";
    for (const match of after.matchAll(/'([^']+)'/g)) missing.push(match[1]);

    if (!missing.length) throw err;

    const trimmed = { ...payload };
    for (const f of missing) delete trimmed[f];

    // If removing fields leaves nothing meaningful, skip retry
    if (Object.keys(trimmed).length === 0) throw err;

    console.warn("⚠️ Caspio ColumnNotFound. Retrying without fields:", missing);
    return await updateReservationByWhere(where, trimmed);
  }
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

  // Only handle the event we care about right now
  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;

  // ✅ Accept BOTH your new metadata and legacy
  const idkey =
    session?.metadata?.IDKEY ||
    session?.metadata?.reservation_id ||
    session?.metadata?.idkey ||
    null;

  if (!idkey) return res.status(200).json({ received: true });

  // Optional
  const metaChargeType = session?.metadata?.Charge_Type || null;
  const metaSessionsTitle = session?.metadata?.Sessions_Title || null;
  const metaPeopleText = session?.metadata?.People_Text || null;

  try {
    // Expand customer + payment_intent
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["customer", "payment_intent"],
    });

    let paymentIntent = fullSession.payment_intent;
    if (typeof paymentIntent === "string") {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent, {
        expand: ["payment_method", "charges.data.payment_method_details"],
      });
    }

    // --- Derive card details for your existing fields
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

    // --- NEW: stored-payment identifiers for off-session charging
    const stripeCustomerId =
      typeof fullSession.customer === "string"
        ? fullSession.customer
        : fullSession.customer?.id || null;

    const stripePaymentMethodId =
      typeof paymentIntent?.payment_method === "string"
        ? paymentIntent.payment_method
        : paymentIntent?.payment_method?.id || charge?.payment_method || null;

    const where = `IDKEY='${escapeWhereValue(idkey)}'`;

    // -----------------------------------------
    // VIEW LOOKUP (non-blocking)
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

      // Existing field name you already write:
      StripeCustomerId: stripeCustomerId,

      // ✅ NEW (for off-session charging)
      // IMPORTANT: you must have a matching column in Caspio.
      // If you name it differently, change the key below.
      StripePaymentMethodId: stripePaymentMethodId,

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

    // Preserve your metadata overwrites
    if (metaChargeType) payload.Charge_Type = metaChargeType;
    if (metaSessionsTitle) payload.Sessions_Title = metaSessionsTitle;
    if (metaPeopleText) payload.People_Text = metaPeopleText;

    // Apply view-derived email branding fields (existing behavior)
    if (viewRow) {
      if (viewRow.BAR2_Email_Design_Email_Content) {
        const maxLen = 64000;
        const val = String(viewRow.BAR2_Email_Design_Email_Content);
        payload.Email_Design = val.length > maxLen ? val.slice(0, maxLen) : val;
      }

      payload.Logo_Graphic_Email_String =
        viewRow.GEN_Business_Units_Logo_Graphic_Email_String || null;

      payload.Units_DBA = viewRow.GEN_Business_Units_DBA || null;

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

    // ✅ Resilient update: retries without missing columns if needed
    await updateReservationResilient(where, payload);

    // -----------------------------------------
    // TRANSACTION INSERT (idempotent)
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
      StripeCustomerId: stripeCustomerId,

      // NOTE: only add this if you ALSO created the column in SIGMA_BAR3_Transactions.
      // Leaving it OUT keeps this 100% backward compatible with your current schema.
      // StripePaymentMethodId: stripePaymentMethodId,

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
