import Stripe from "stripe";
import {
  updateReservationByWhere,
  insertTransactionIfMissingByRawEventId,
  getReservationByIdKey,
  getResBillingEditViewRowByIdKey,
  rollupTotalsForIdKey,
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

function dollarsFromCents(cents) {
  return typeof cents === "number" ? Number((cents / 100).toFixed(2)) : null;
}

function n2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

/**
 * Pull 4-part breakdown from Stripe metadata.
 * Expected keys (strings): base_amount, grat_amount, tax_amount, fee_amount
 * If missing, defaults to Fee-only = total.
 */
function parseBreakdownFromMetadata(meta, fallbackTotalDollars) {
  const base = n2(meta?.base_amount);
  const grat = n2(meta?.grat_amount);
  const tax = n2(meta?.tax_amount);
  const fee = n2(meta?.fee_amount);

  const hasAny =
    meta?.base_amount != null ||
    meta?.grat_amount != null ||
    meta?.tax_amount != null ||
    meta?.fee_amount != null;

  if (hasAny) {
    return { base, grat, tax, fee, amount: n2(base + grat + tax + fee) };
  }

  const total = n2(fallbackTotalDollars);
  return { base: 0, grat: 0, tax: 0, fee: total, amount: total };
}

async function safeRollup(idkey) {
  try {
    await rollupTotalsForIdKey(String(idkey));
  } catch (e) {
    console.warn("⚠️ ROLLUP_FAILED", e?.message || e);
  }
}

function getIdKeyFromMetadata(meta) {
  return (
    meta?.IDKEY ||
    meta?.idkey ||
    meta?.reservation_id ||
    meta?.Reservation_ID ||
    meta?.ReservationId ||
    null
  );
}

function getResIdFromMetadata(meta) {
  return meta?.RES_ID || meta?.res_id || meta?.Res_ID || null;
}

function getConfirmationNumberFromReservationRow(row) {
  return (
    row?.Confirmation_Number ||
    row?.CONFIRMATION_NUMBER ||
    row?.confirmation_number ||
    null
  );
}

/**
 * If Caspio responds with ColumnNotFound, drop those fields and retry once.
 */
async function updateReservationResilient(where, payload) {
  try {
    return await updateReservationByWhere(where, payload);
  } catch (err) {
    const msg = String(err?.message || "");
    if (!/ColumnNotFound/i.test(msg) && !/do not exist/i.test(msg)) throw err;

    const after = msg.split("do not exist:")[1] || "";
    const missing = [];
    for (const m of after.matchAll(/'([^']+)'/g)) missing.push(m[1]);
    if (!missing.length) throw err;

    const trimmed = { ...payload };
    for (const k of missing) delete trimmed[k];

    return await updateReservationByWhere(where, trimmed);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");

  let event;
  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("WEBHOOK_SIGNATURE_FAILED", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err?.message || "Bad signature"}`);
  }

  try {
    // Small cache to avoid double Caspio reads within one webhook
    let reservationCache = null;

    async function getReservationCached(idkey) {
      if (reservationCache?.IDKEY === idkey) return reservationCache;
      const row = await getReservationByIdKey(idkey).catch(() => null);
      reservationCache = row ? { ...row, IDKEY: idkey } : { IDKEY: idkey };
      return row;
    }

    // ------------------------------------------------------------
    // 1) CHECKOUT COMPLETED (writes txn breakdown + rollup)
    // ------------------------------------------------------------
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const idkey = getIdKeyFromMetadata(session?.metadata);
      if (!idkey) return res.status(200).json({ received: true });

      const metaChargeType = session?.metadata?.Charge_Type || null;
      const metaSessionsTitle = session?.metadata?.Sessions_Title || null;

      // Expand payment intent to get charge/card details
      let paymentIntent = session?.payment_intent;
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

      const amountDollars = dollarsFromCents(
        paymentIntent?.amount_received ?? paymentIntent?.amount ?? null
      );

      const currency = String(paymentIntent?.currency || session?.currency || "usd").toLowerCase();
      const paidAtIso = new Date(
        ((paymentIntent?.created || session?.created || Math.floor(Date.now() / 1000)) * 1000)
      ).toISOString();

      // If this reservation has a Charge_Type we want to prefer it
      const reservationRow = await getReservationCached(idkey);
      let reservationChargeType =
        metaChargeType ||
        reservationRow?.Charge_Type ||
        "booking_fee";

      const confirmationNumber = getConfirmationNumberFromReservationRow(reservationRow);

      const breakdown = parseBreakdownFromMetadata(
        paymentIntent?.metadata || session?.metadata || {},
        amountDollars
      );

      const txnPayload = {
        IDKEY: String(idkey),

        TxnType: "charge",

        Base_Amount: breakdown.base,
        Auto_Gratuity: breakdown.grat,
        Tax: breakdown.tax,
        Fee: breakdown.fee,

        Amount: breakdown.amount,
        Currency: currency,

        PaymentStatus: "PaidBookingFee",
        Status: paymentIntent?.status || "succeeded",

        StripeCheckoutSessionId: session?.id || null,
        StripePaymentIntentId: paymentIntent?.id || null,
        StripeChargeId: charge?.id || null,
        StripeCustomerId: session?.customer || paymentIntent?.customer || null,

        Card_Brand: card?.brand || null,
        Card_Last4: card?.last4 || null,
        Card_Exp_Month: card?.exp_month || null,
        Card_Exp_Year: card?.exp_year || null,

        Sessions_Title: metaSessionsTitle || reservationRow?.Sessions_Title || null,
        Description: reservationChargeType,

        // ✅ NEW FIELD
        Confirmation_Number: confirmationNumber,

        RawEventId: String(event.id),
        Transaction_date: paidAtIso,
        CreatedAt: new Date().toISOString(),
      };

      await insertTransactionIfMissingByRawEventId(txnPayload).catch((e) =>
        console.error("⚠️ TXN_INSERT_FAILED", e?.message)
      );

      await safeRollup(idkey);

      return res.status(200).json({ received: true });
    }

    // ------------------------------------------------------------
    // 2) PAYMENT INTENT SUCCEEDED (off-session charges)
    // ------------------------------------------------------------
    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;

      const idkey = getIdKeyFromMetadata(paymentIntent?.metadata);
      if (!idkey) return res.status(200).json({ received: true });

      const resId = getResIdFromMetadata(paymentIntent?.metadata);

      // Expand PI to get card data if available
      const piFull = await stripe.paymentIntents.retrieve(paymentIntent.id, {
        expand: ["payment_method", "charges.data.payment_method_details"],
      });

      const charge = piFull?.charges?.data?.[0];
      const card =
        charge?.payment_method_details?.card ||
        (typeof piFull?.payment_method !== "string" ? piFull?.payment_method?.card : null);

      const amountDollars = dollarsFromCents(
        piFull?.amount_received ?? piFull?.amount ?? null
      );
      const currency = String(piFull?.currency || "usd").toLowerCase();
      const paidAtIso = new Date(((piFull?.created || Math.floor(Date.now() / 1000)) * 1000)).toISOString();

      const reservationRow = await getReservationCached(idkey);
      const confirmationNumber = getConfirmationNumberFromReservationRow(reservationRow);

      const breakdown = parseBreakdownFromMetadata(
        piFull?.metadata || paymentIntent?.metadata || {},
        amountDollars
      );

      const txnPayload = {
        IDKEY: String(idkey),

        TxnType: "charge",

        Base_Amount: breakdown.base,
        Auto_Gratuity: breakdown.grat,
        Tax: breakdown.tax,
        Fee: breakdown.fee,

        Amount: breakdown.amount,
        Currency: currency,

        PaymentStatus: "AdjustmentCharged",
        Status: piFull?.status || "succeeded",

        StripeCheckoutSessionId: null,
        StripePaymentIntentId: piFull?.id || null,
        StripeChargeId: charge?.id || null,
        StripeCustomerId: piFull?.customer || null,

        Card_Brand: card?.brand || null,
        Card_Last4: card?.last4 || null,
        Card_Exp_Month: card?.exp_month || null,
        Card_Exp_Year: card?.exp_year || null,

        Charge_Type: piFull?.metadata?.Charge_Type || null,
        Description: piFull?.metadata?.Description || null,

        RES_ID: resId || null,
        Confirmation_Number: confirmationNumber,

        RawEventId: String(event.id),
        Transaction_date: paidAtIso,
        CreatedAt: new Date().toISOString(),
      };

      await insertTransactionIfMissingByRawEventId(txnPayload).catch((e) =>
        console.error("⚠️ TXN_INSERT_FAILED", e?.message)
      );

      await safeRollup(idkey);

      return res.status(200).json({ received: true });
    }

    // ------------------------------------------------------------
    // 3) REFUNDS (create NEGATIVE txn rows + rollup)
    // ------------------------------------------------------------
    if (event.type === "refund.created" || event.type === "refund.updated") {
      const refund = event.data.object;

      const paymentIntentId = refund?.payment_intent || null;
      const chargeId = refund?.charge || null;
      const currency = String(refund?.currency || "usd").toLowerCase();

      const amountDollars = dollarsFromCents(refund?.amount ?? null);
      const createdIso = new Date(((refund?.created || Math.floor(Date.now() / 1000)) * 1000)).toISOString();

      // Pull PI to get metadata (IDKEY + breakdown)
      let pi = null;
      if (paymentIntentId) {
        pi = await stripe.paymentIntents.retrieve(paymentIntentId).catch(() => null);
      }

      const idkey = getIdKeyFromMetadata(pi?.metadata);
      if (!idkey) return res.status(200).json({ received: true });

      const reservationRow = await getReservationCached(idkey);
      const confirmationNumber = getConfirmationNumberFromReservationRow(reservationRow);

      const original = parseBreakdownFromMetadata(pi?.metadata || {}, null);
      const refundTotal = n2(amountDollars);
      const originalTotal = n2(original.amount);
      const ratio = originalTotal > 0 ? Math.min(1, refundTotal / originalTotal) : 1;

      const rb = {
        base: n2(original.base * ratio),
        grat: n2(original.grat * ratio),
        tax: n2(original.tax * ratio),
        fee: n2(original.fee * ratio),
      };

      const txnPayload = {
        IDKEY: String(idkey),

        TxnType: "refund",

        Base_Amount: -Math.abs(rb.base),
        Auto_Gratuity: -Math.abs(rb.grat),
        Tax: -Math.abs(rb.tax),
        Fee: -Math.abs(rb.fee),

        // negative amount
        Amount: typeof amountDollars === "number" ? -Math.abs(refundTotal) : null,
        Currency: currency,

        PaymentStatus: "Refunded",
        Status: refund?.status || "succeeded",

        StripeCheckoutSessionId: null,
        StripePaymentIntentId: paymentIntentId || null,
        StripeChargeId: chargeId,
        StripeRefundId: refund?.id || null,
        StripeCustomerId: pi?.customer || null,

        Charge_Type: pi?.metadata?.Charge_Type || null,
        Description: pi?.metadata?.Description || null,

        Confirmation_Number: confirmationNumber,

        RawEventId: String(event.id),
        Transaction_date: createdIso,
        CreatedAt: new Date().toISOString(),
      };

      await insertTransactionIfMissingByRawEventId(txnPayload).catch((e) =>
        console.error("⚠️ REFUND_TXN_INSERT_FAILED", e?.message)
      );

      await safeRollup(idkey);

      return res.status(200).json({ received: true });
    }

    // Anything else: just ACK
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("WEBHOOK_HANDLER_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Webhook handler error");
  }
}
