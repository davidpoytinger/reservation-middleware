// pages/api/stripe-webhook.js
//
// Debug-enabled Stripe webhook for SIGMA
// - "one transaction per successful checkout" behavior
// - Off-session PI logging gated by metadata.source === "off_session"
// - Rolls up totals
//
// FIXES:
// ✅ Resilient transaction insert (ColumnNotFound -> drop fields -> retry)
// ✅ PaymentStatus set by metadata.purpose (booking_fee vs supplemental)
// ✅ Better Description selection from metadata

import Stripe from "stripe";
import {
  updateReservationByWhere,
  insertTransactionIfMissingByRawEventId,
  getReservationByIdKey,
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

function escapeWhereValue(v) {
  return String(v ?? "").replaceAll("'", "''");
}

function dollarsFromCents(cents) {
  return typeof cents === "number" ? Number((cents / 100).toFixed(2)) : null;
}

function n2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

/**
 * If Caspio responds with ColumnNotFound / "do not exist", drop those fields and retry once.
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
    for (const f of missing) delete trimmed[f];
    if (Object.keys(trimmed).length === 0) throw err;

    console.warn("⚠️ Reservation ColumnNotFound. Retrying without fields:", missing);
    return await updateReservationByWhere(where, trimmed);
  }
}

/**
 * ✅ NEW: Resilient TXN insert wrapper (same ColumnNotFound retry pattern).
 * This prevents “success but no row” when your TXN table lacks certain columns.
 */
async function insertTxnResilient(txnPayload) {
  try {
    return await insertTransactionIfMissingByRawEventId(txnPayload);
  } catch (err) {
    const msg = String(err?.message || "");
    if (!/ColumnNotFound/i.test(msg) && !/do not exist/i.test(msg)) throw err;

    const after = msg.split("do not exist:")[1] || "";
    const missing = [];
    for (const m of after.matchAll(/'([^']+)'/g)) missing.push(m[1]);
    if (!missing.length) throw err;

    const trimmed = { ...txnPayload };
    for (const f of missing) delete trimmed[f];
    if (Object.keys(trimmed).length === 0) throw err;

    console.warn("⚠️ TXN ColumnNotFound. Retrying without fields:", missing);
    return await insertTransactionIfMissingByRawEventId(trimmed);
  }
}

function getIdKeyFromMetadata(meta) {
  return meta?.IDKEY || meta?.reservation_id || meta?.idkey || meta?.IdKey || null;
}

function getConfirmationNumberFromReservationRow(row) {
  return row?.Confirmation_Number || row?.ConfirmationNumber || row?.CONFIRMATION_NUMBER || null;
}

/**
 * Parse 4-part breakdown from Stripe metadata.
 * Accepts BOTH:
 *  - snake_case (base_amount, grat_amount, tax_amount, fee_amount)
 *  - Caspio-style (Base_Amount, Auto_Gratuity, Tax, Fee)
 *
 * Fallback:
 *  - If no breakdown found: treat entire totalAmountDollars as Fee (legacy behavior)
 */
function parseBreakdown(meta, totalAmountDollars) {
  const m = meta || {};
  const baseRaw = m.base_amount ?? m.baseAmount ?? m.Base_Amount ?? m.base ?? m.Base ?? null;

  const gratRaw =
    m.grat_amount ??
    m.gratAmount ??
    m.Auto_Gratuity ??
    m.auto_gratuity ??
    m.grat ??
    m.Gratuity ??
    null;

  const taxRaw = m.tax_amount ?? m.taxAmount ?? m.Tax ?? m.tax ?? null;
  const feeRaw = m.fee_amount ?? m.feeAmount ?? m.Fee ?? m.fee ?? null;

  const hasAny = baseRaw != null || gratRaw != null || taxRaw != null || feeRaw != null;

  if (hasAny) {
    const base = n2(baseRaw);
    const grat = n2(gratRaw);
    const tax = n2(taxRaw);
    const fee = n2(feeRaw);
    const amount = n2(base + grat + tax + fee);
    return { base, grat, tax, fee, amount };
  }

  const total = n2(totalAmountDollars);
  return { base: 0, grat: 0, tax: 0, fee: total, amount: total };
}

function pickDescription(meta = {}, fallback = "") {
  return String(
    meta.Description ||
    meta.description ||
    meta.why ||
    meta.Reason ||
    meta.reason ||
    meta.Sessions_Title ||
    meta.People_Text ||
    fallback ||
    ""
  ).slice(0, 500);
}

function paymentStatusFromPurpose(purpose, defaultPaid = "Paid") {
  const p = String(purpose || "").toLowerCase();
  if (p === "booking_fee") return "PaidBookingFee";
  return defaultPaid;
}

async function safeRollup(idkey) {
  try {
    await rollupTotalsForIdKey(String(idkey));
    console.log("ROLLUP_OK:", String(idkey));
  } catch (e) {
    console.warn("⚠️ ROLLUP_FAILED (non-blocking)", e?.message || e);
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
    console.error("❌ Stripe signature verification failed:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err?.message || "bad signature"}`);
  }

  console.log("STRIPE_EVENT:", event?.type, "EVENT_ID:", event?.id);

  try {
    let reservationCache = null;

    async function getReservationCached(idkey) {
      if (reservationCache && reservationCache.IDKEY === idkey) return reservationCache;
      const row = await getReservationByIdKey(idkey).catch(() => null);
      reservationCache = row ? { ...row, IDKEY: idkey } : { IDKEY: idkey };
      return row;
    }

    // ------------------------------------------------------------
    // 1) CHECKOUT COMPLETED  (source for checkout payments)
    // ------------------------------------------------------------
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const idkey = getIdKeyFromMetadata(session?.metadata);
      if (!idkey) return res.status(200).json({ received: true });

      console.log("CHECKOUT_COMPLETED_IDKEY:", String(idkey));

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
        (typeof paymentIntent?.payment_method !== "string" ? paymentIntent?.payment_method?.card : null);

      const amountDollars = dollarsFromCents(paymentIntent?.amount_received ?? paymentIntent?.amount ?? null);
      const currency = paymentIntent?.currency?.toLowerCase() || "usd";

      const paidAtUnix =
        charge?.created || paymentIntent?.created || fullSession.created || Math.floor(Date.now() / 1000);
      const paidAtIso = new Date(paidAtUnix * 1000).toISOString();

      const stripeCustomerId =
        typeof fullSession.customer === "string" ? fullSession.customer : fullSession.customer?.id || null;

      const stripePaymentMethodId =
        typeof paymentIntent?.payment_method === "string"
          ? paymentIntent.payment_method
          : paymentIntent?.payment_method?.id || charge?.payment_method || null;

      const where = `IDKEY='${escapeWhereValue(idkey)}'`;

      // Update reservation record (best-effort)
      const mdSession = fullSession?.metadata || session?.metadata || {};
      const metaChargeType = mdSession?.Charge_Type || null;

      const payload = {
        BookingFeePaidAt: paidAtIso,
        StripeCheckoutSessionId: fullSession.id,
        StripePaymentIntentId: paymentIntent?.id || null,
        StripeCustomerId: stripeCustomerId,
        StripePaymentMethodId: stripePaymentMethodId,
        Payment_processor: "Stripe",
        Mode: fullSession.livemode ? "live" : "test",
        Status: "Booked",
        Payment_service: "Checkout",
        Card_brand: card?.brand || null,
        Card_number_masked: card?.last4 ? `**** **** **** ${card.last4}` : null,
        Card_expiration: card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null,
        Transaction_ID: paymentIntent?.id || null,
        Transaction_date: paidAtIso,
      };

      // Carry optional metadata fields
      if (metaChargeType) payload.Charge_Type = metaChargeType;
      if (mdSession?.Sessions_Title) payload.Sessions_Title = mdSession.Sessions_Title;
      if (mdSession?.People_Text) payload.People_Text = mdSession.People_Text;

      await updateReservationResilient(where, payload);

      // Reservation row for Confirmation_Number fallback
      const reservationRow = await getReservationCached(idkey);
      const confirmationNumber = getConfirmationNumberFromReservationRow(reservationRow);

      const breakdown = parseBreakdown(mdSession, amountDollars);

      const purpose = mdSession?.purpose || mdSession?.Purpose || null;
      const paymentStatus = paymentStatusFromPurpose(purpose, "Paid");

      const chargeType =
        metaChargeType ||
        mdSession?.Charge_Type ||
        reservationRow?.Charge_Type ||
        String(purpose || "checkout_charge");

      const description = pickDescription(mdSession, chargeType);

      const txnPayload = {
        IDKEY: String(idkey),
        TxnType: "charge",

        Base_Amount: breakdown.base,
        Auto_Gratuity: breakdown.grat,
        Tax: breakdown.tax,
        Fee: breakdown.fee,
        Amount: breakdown.amount,

        Currency: currency,
        PaymentStatus: paymentStatus,
        Status: paymentIntent?.status || "succeeded",

        StripeCheckoutSessionId: fullSession.id,
        StripePaymentIntentId: paymentIntent?.id || null,
        StripeChargeId: charge?.id || null,
        StripeCustomerId: stripeCustomerId,
        StripePaymentMethodId: stripePaymentMethodId,

        Charge_Type: String(chargeType).slice(0, 250),
        Description: description,

        Confirmation_Number: confirmationNumber,

        // optional card fields (will be dropped if columns don't exist)
        Card_brand: card?.brand || null,
        Card_number_masked: card?.last4 ? `**** **** **** ${card.last4}` : null,
        Card_expiration: card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null,

        RawEventId: String(event.id),
        Transaction_date: paidAtIso,
        CreatedAt: new Date().toISOString(),
      };

      await insertTxnResilient(txnPayload).catch((e) =>
        console.error("⚠️ TXN_INSERT_FAILED", e?.message || e)
      );

      await safeRollup(idkey);

      return res.status(200).json({ received: true });
    }

    // ------------------------------------------------------------
    // 2) PAYMENT INTENT SUCCEEDED (ONLY for off-session charge tool)
    // ------------------------------------------------------------
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;

      const source = String(pi?.metadata?.source || "").toLowerCase();
      if (source !== "off_session" && source !== "off-session") {
        console.log("PI_SUCCEEDED_SKIPPED_SOURCE:", source || "(missing)");
        return res.status(200).json({ received: true, skipped: "not_off_session" });
      }

      const idkey = getIdKeyFromMetadata(pi?.metadata);
      if (!idkey) return res.status(200).json({ received: true });

      console.log("PI_SUCCEEDED_OFFSESSION_IDKEY:", String(idkey));

      const piFull = await stripe.paymentIntents.retrieve(pi.id, {
        expand: ["payment_method", "charges.data.payment_method_details"],
      });

      const charge = piFull?.charges?.data?.[0];
      const card =
        charge?.payment_method_details?.card ||
        (typeof piFull?.payment_method !== "string" ? piFull?.payment_method?.card : null);

      const amountDollars = dollarsFromCents(piFull?.amount_received ?? piFull?.amount ?? null);
      const currency = piFull?.currency?.toLowerCase() || "usd";
      const createdIso = new Date((piFull?.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();

      const stripeCustomerId = piFull?.customer || null;
      const stripePaymentMethodId =
        typeof piFull?.payment_method === "string"
          ? piFull.payment_method
          : piFull?.payment_method?.id || charge?.payment_method || null;

      const reservationRow = await getReservationCached(idkey);
      const confirmationNumber = getConfirmationNumberFromReservationRow(reservationRow);

      const md = piFull?.metadata || {};
      const breakdown = parseBreakdown(md, amountDollars);

      const purpose = md?.purpose || md?.Purpose || null;
      const paymentStatus = paymentStatusFromPurpose(purpose, "Paid");

      const chargeType = md?.Charge_Type || "supplemental_charge";
      const description = pickDescription(md, chargeType);

      const txnPayload = {
        IDKEY: String(idkey),
        TxnType: "charge",

        Base_Amount: breakdown.base,
        Auto_Gratuity: breakdown.grat,
        Tax: breakdown.tax,
        Fee: breakdown.fee,
        Amount: breakdown.amount,

        Currency: currency,
        PaymentStatus: paymentStatus,
        Status: piFull?.status || "succeeded",

        StripeCheckoutSessionId: null,
        StripePaymentIntentId: piFull?.id || null,
        StripeChargeId: charge?.id || null,
        StripeCustomerId: stripeCustomerId,
        StripePaymentMethodId: stripePaymentMethodId,

        Charge_Type: String(chargeType).slice(0, 250),
        Description: description,

        Confirmation_Number: confirmationNumber,

        // optional card fields (will be dropped if columns don't exist)
        Card_brand: card?.brand || null,
        Card_number_masked: card?.last4 ? `**** **** **** ${card.last4}` : null,
        Card_expiration: card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null,

        RawEventId: String(event.id),
        Transaction_date: createdIso,
        CreatedAt: new Date().toISOString(),
      };

      await insertTxnResilient(txnPayload).catch((e) =>
        console.error("⚠️ TXN_INSERT_FAILED", e?.message || e)
      );

      await safeRollup(idkey);

      return res.status(200).json({ received: true });
    }

    // ------------------------------------------------------------
    // 3) REFUNDS (create/update) → insert negative txn rows
    // ------------------------------------------------------------
    if (event.type === "refund.created" || event.type === "refund.updated") {
      const refund = event.data.object;

      const chargeId = refund?.charge || null;
      if (!chargeId) return res.status(200).json({ received: true });

      const charge = await stripe.charges.retrieve(chargeId);
      const paymentIntentId = charge?.payment_intent || null;

      let pi = null;
      if (paymentIntentId) {
        pi = await stripe.paymentIntents.retrieve(paymentIntentId).catch(() => null);
      }

      const idkey = getIdKeyFromMetadata(pi?.metadata) || getIdKeyFromMetadata(refund?.metadata);
      if (!idkey) return res.status(200).json({ received: true });

      console.log("REFUND_EVENT_IDKEY:", String(idkey), "REFUND_ID:", refund?.id);

      const amountDollars = dollarsFromCents(refund?.amount ?? null);
      const currency = refund?.currency?.toLowerCase() || "usd";
      const createdIso = new Date((refund?.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();

      const chargeType = pi?.metadata?.Charge_Type || refund?.metadata?.Charge_Type || "refund";
      const description = `Refund - ${chargeType}`;

      const reservationRow = await getReservationCached(idkey);
      const confirmationNumber = getConfirmationNumberFromReservationRow(reservationRow);

      const original = parseBreakdown(pi?.metadata || {}, null);
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
        Amount: typeof amountDollars === "number" ? -Math.abs(refundTotal) : null,

        Currency: currency,
        PaymentStatus: "Refunded",
        Status: refund?.status || "succeeded",

        StripeCheckoutSessionId: null,
        StripePaymentIntentId: paymentIntentId || null,
        StripeChargeId: chargeId,
        StripeRefundId: refund?.id || null,
        ParentStripeChargeId: chargeId,
        StripeCustomerId: charge?.customer || null,

        Charge_Type: chargeType,
        Description: description,

        Confirmation_Number: confirmationNumber,

        RawEventId: String(event.id),
        Transaction_date: createdIso,
        CreatedAt: new Date().toISOString(),
      };

      await insertTxnResilient(txnPayload).catch((e) =>
        console.error("⚠️ TXN_INSERT_FAILED", e?.message || e)
      );

      await safeRollup(idkey);

      return res.status(200).json({ received: true });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    // Still returning 200 to avoid Stripe retries, but now you'll see the true error in logs.
    console.error("❌ WEBHOOK_FAILED", err?.message || err);
    return res.status(200).json({ received: true });
  }
}
