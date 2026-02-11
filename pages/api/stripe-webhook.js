import Stripe from "stripe";
import {
  updateReservationByWhere,
  buildWhereForIdKey,
  insertTransactionIfMissingByRawEventId,
  getReservationByIdKey,
  getResBillingEditViewRowByIdKey, // view helper: SIGMA_VW_Res_Billing_Edit by IDKEY
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
  console.log("WEBHOOK_HIT", {
    host: req.headers.host,
    url: req.url,
    caspioIntegrationUrlSet: !!process.env.CASPIO_INTEGRATION_URL,
    caspioIntegrationUrlHost: process.env.CASPIO_INTEGRATION_URL || null,
    caspioTable: process.env.CASPIO_TABLE || null,
    caspioKeyField: process.env.CASPIO_KEY_FIELD || null,
    caspioTxnTable: process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions",
    caspioResBillingView: process.env.CASPIO_RES_BILLING_VIEW || "SIGMA_VW_Res_Billing_Edit",
  });

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

  if (!idkey) {
    console.error("❌ Missing metadata.reservation_id on Stripe session", { sessionId: session?.id });
    return res.status(200).json({ received: true });
  }

  try {
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["customer", "payment_intent"],
    });

    let paymentIntent = fullSession.payment_intent;
    if (typeof paymentIntent === "string") {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent, {
        expand: ["payment_method", "charges.data.payment_method_details"],
      });
    } else if (paymentIntent && typeof paymentIntent !== "string") {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent.id, {
        expand: ["payment_method", "charges.data.payment_method_details"],
      });
    }

    const customerId =
      typeof fullSession.customer === "string"
        ? fullSession.customer
        : fullSession.customer?.id || null;

    const paymentIntentId = paymentIntent?.id || null;

    const pm = paymentIntent?.payment_method;
    const cardFromPM = pm && typeof pm !== "string" ? pm.card : null;

    const charge = paymentIntent?.charges?.data?.[0];
    const cardFromCharge = charge?.payment_method_details?.card || null;

    const card = cardFromCharge || cardFromPM;

    const amountCents = paymentIntent?.amount_received ?? paymentIntent?.amount ?? null;
    const amountDollars =
      typeof amountCents === "number" ? Number((amountCents / 100).toFixed(2)) : null;

    const currency = paymentIntent?.currency ? String(paymentIntent.currency).toLowerCase() : "usd";
    const chargeId = charge?.id || null;

    const paidAtIso = new Date(
      (fullSession.created || Math.floor(Date.now() / 1000)) * 1000
    ).toISOString();

    const where = buildWhereForIdKey(idkey);

    // -------------------------
    // Pull Email_Design from VIEW (so we only update once)
    // Map: SIGMA_VW_Res_Billing_Edit.BAR2_Email_Design_Email_Content -> BAR2_Reservations_SIGMA.Email_Design
    // -------------------------
    let emailDesignFromView = null;
    try {
      const viewRow = await getResBillingEditViewRowByIdKey(idkey);
      emailDesignFromView = viewRow?.BAR2_Email_Design_Email_Content || null;

      if (emailDesignFromView) {
        console.log("✅ VIEW_EMAIL_DESIGN_FOUND", { idkey });
      } else {
        console.log("ℹ️ VIEW_EMAIL_DESIGN_EMPTY", { idkey });
      }
    } catch (e) {
      console.warn("⚠️ VIEW_EMAIL_DESIGN_LOOKUP_FAILED (non-blocking)", {
        idkey,
        message: e?.message || String(e),
      });
    }

    // -------------------------
    // 1) Update reservation row (single update)
    // -------------------------
    const payload = {
      BookingFeePaidAt: paidAtIso,
      StripeCheckoutSessionId: fullSession.id,
      StripePaymentIntentId: paymentIntentId,
      StripeCustomerId: customerId,

      Payment_processor: "Stripe",
      Mode: fullSession.livemode ? "live" : "test",
      Status: "Booked",
      Payment_service: "Checkout",
      Token_ID: customerId,
      Card_brand: card?.brand || null,
      Card_number_masked: card?.last4 ? `**** **** **** ${card.last4}` : null,
      Card_expiration:
        card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null,
      Transaction_ID: paymentIntentId,
      Transaction_date: paidAtIso,
    };

    // ✅ Only set Email_Design if we actually got a non-empty value from the view
    if (emailDesignFromView && emailDesignFromView !== "") {
      payload.Email_Design = emailDesignFromView;
    }

    const result = await updateReservationByWhere(where, payload);
    console.log("✅ CASPIO_UPDATE_OK", { idkey, where, result });

    // ✅ Load reservation to read Charge_Type for Description
    let reservationRow = null;
    try {
      reservationRow = await getReservationByIdKey(idkey);
    } catch (e) {
      console.warn("⚠️ Could not load reservation row for Charge_Type:", e?.message || String(e));
    }

    const reservationChargeType = reservationRow?.Charge_Type || "booking_fee";

    // -------------------------
    // 2) Insert Transaction History record (Description from reservation Charge_Type)
    // -------------------------
    const txnPayload = {
      IDKEY: String(idkey),

      BookingFee: amountDollars,
      Amount: amountDollars,
      Currency: currency,

      PaymentStatus: "PaidBookingFee",
      Status: String(paymentIntent?.status || "succeeded"),

      StripeCheckoutSessionId: String(fullSession.id),
      StripePaymentIntentId: String(paymentIntentId || ""),
      StripeChargeId: String(chargeId || ""),
      StripeCustomerId: String(customerId || ""),

      Payment_processor: "stripe",
      Payment_service: "checkout",
      Mode: fullSession.livemode ? "live" : "test",

      Charge_Type: reservationChargeType,
      Description: reservationChargeType,

      PaymentMethodBrand: card?.brand || null,
      PaymentMethodLast4: card?.last4 || null,
      Card_brand: card?.brand || null,
      Card_number_masked: card?.last4 ? `**** **** **** ${card.last4}` : null,
      Card_expiration:
        card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null,

      Transaction_ID: chargeId || paymentIntentId || null,
      Transaction_date: paidAtIso,
      BookingFeePaidAt: paidAtIso,
      CreatedAt: new Date().toISOString(),

      RawEventId: String(event.id),
    };

    try {
      const txnResult = await insertTransactionIfMissingByRawEventId(txnPayload);
      console.log("✅ TXN_INSERT_OK", { idkey, eventId: event.id, txnResult });
    } catch (e) {
      console.error("⚠️ TXN_INSERT_FAILED (non-blocking)", {
        idkey,
        eventId: event.id,
        message: e?.message || String(e),
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ CASPIO_UPDATE_FAILED", { idkey, message: err?.message || String(err) });
    return res.status(200).json({ received: true });
  }
}
