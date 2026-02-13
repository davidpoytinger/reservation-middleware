// pages/api/charge-adjustment.js
//
// Staff/system endpoint to charge an off-session "adjustment" using stored payment method.
// Creates an adjustment record (Pending), charges via Stripe, updates adjustment to Charged/Failed,
// and logs into SIGMA_BAR3_Transactions (idempotent).
//
// Body (POST JSON):
// {
//   "RES_ID": "AMP....",
//   "amount": 25.00,
//   "adjustmentType": "Late Cancel",
//   "reason": "Cancelled inside 24 hours",
//   "createdBy": "David"
// }
//
// Notes:
// - Requires reservation has StripeCustomerId + StripePaymentMethodId
// - Uses idempotency key to avoid double-charging on retries
// - Logs transaction with RawEventId = `pi_${paymentIntent.id}`

import Stripe from "stripe";
import {
  getReservationByResId,
  getReservationByIdKey,
  insertAdjustment,
  updateAdjustmentByPkId,
  insertTransactionIfMissingByRawEventId,
} from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

function setCors(res, origin) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://reservebarsandrec.com";
  const allowOrigin = origin && origin === allowed ? origin : allowed;
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });

    const {
      RES_ID,
      IDKEY, // optional fallback
      amount,
      adjustmentType,
      reason,
      createdBy,
    } = req.body || {};

    const resId = oneLine(RES_ID);
    const idkey = oneLine(IDKEY);
    const type = oneLine(adjustmentType) || "Adjustment";
    const why = oneLine(reason || "");
    const who = oneLine(createdBy || "");

    if (!resId && !idkey) {
      return res.status(400).json({ error: "Missing RES_ID (preferred) or IDKEY (fallback)" });
    }

    const amountCents = toCents(amount);
    if (!amountCents || amountCents < 50) {
      return res.status(400).json({ error: "Invalid amount (min $0.50)" });
    }

    // -----------------------------------------
    // 1) Load reservation (prefer RES_ID)
    // -----------------------------------------
    let reservation = null;
    if (resId) {
      reservation = await getReservationByResId(resId);
    } else {
      reservation = await getReservationByIdKey(idkey);
    }

    const finalResId = oneLine(
      reservation?.RES_ID ?? reservation?.Res_ID ?? reservation?.res_id ?? reservation?.resId ?? resId
    );
    const finalIdKey = oneLine(
      reservation?.IDKEY ?? reservation?.IdKey ?? reservation?.idkey ?? idkey
    );

    // Stored-payment identifiers (from webhook)
    const stripeCustomerId = reservation?.StripeCustomerId || reservation?.Stripe_Customer_ID || null;
    const stripePaymentMethodId =
      reservation?.StripePaymentMethodId || reservation?.Stripe_PaymentMethod_ID || null;

    if (!stripeCustomerId || !stripePaymentMethodId) {
      return res.status(409).json({
        error: "Reservation missing StripeCustomerId and/or StripePaymentMethodId. Ensure webhook writes these after checkout.",
        StripeCustomerId: stripeCustomerId,
        StripePaymentMethodId: stripePaymentMethodId,
      });
    }

    // -----------------------------------------
    // 2) Create adjustment row (Pending)
    // -----------------------------------------
    const nowIso = new Date().toISOString();

    const adjInsert = await insertAdjustment({
      RES_ID: finalResId || null,
      IDKEY: finalIdKey || null,
      Adjustment_Type: type,
      Adjustment_Reason: why,
      Amount: Number(Number(amount).toFixed(2)),
      Status: "Pending",
      Created_By: who,
      Created_Date: nowIso, // if column exists; if not, Caspio ignores/ColumnNotFound (depends)
    });

    // Caspio insert responses vary; handle common shapes
    const adjPk =
      adjInsert?.Result?.[0]?.PK_ID ??
      adjInsert?.Result?.PK_ID ??
      adjInsert?.PK_ID ??
      adjInsert?.pk_id ??
      adjInsert?.id ??
      null;

    // If you can’t reliably get PK_ID from insert response, the endpoint still works;
    // it just won’t update that row with Stripe IDs/status.
    // (But most Caspio inserts return created record info.)
    // We'll still try.

    // -----------------------------------------
    // 3) Charge off-session (idempotent)
    // -----------------------------------------
    const idemKey = `adj_${finalResId || finalIdKey}_${adjPk || "nopk"}_${amountCents}`;

    let pi;
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: amountCents,
          currency: "usd",
          customer: stripeCustomerId,
          payment_method: stripePaymentMethodId,
          off_session: true,
          confirm: true,

          description: `${type}${finalResId ? ` for ${finalResId}` : ""}`,
          metadata: {
            RES_ID: String(finalResId || ""),
            IDKEY: String(finalIdKey || ""),
            adjustment_pk: String(adjPk || ""),
            adjustment_type: String(type || ""),
          },

          // Expand charge info so we can log StripeChargeId without a second call
          expand: ["latest_charge"],
        },
        { idempotencyKey: idemKey }
      );
    } catch (err) {
      // Stripe errors for off-session charges often land here (authentication_required, card_declined, etc.)
      const msg = err?.raw?.message || err?.message || "Stripe error";
      const code = err?.raw?.code || err?.code || null;
      const decline = err?.raw?.decline_code || null;

      // Update adjustment row to Failed (if we have PK)
      if (adjPk) {
        await updateAdjustmentByPkId(adjPk, {
          Status: "Failed",
          Stripe_Error: `${msg}${code ? ` (${code})` : ""}${decline ? ` [${decline}]` : ""}`,
          Updated_At: new Date().toISOString(), // optional if column exists
        }).catch(() => {});
      }

      // Log transaction as failed attempt (idempotent by synthetic RawEventId)
      const failedRawEventId = `adj_fail_${finalResId || finalIdKey}_${adjPk || "nopk"}_${amountCents}`;
      await insertTransactionIfMissingByRawEventId({
        IDKEY: String(finalIdKey || ""),
        Amount: Number(Number(amount).toFixed(2)),
        Currency: "usd",
        PaymentStatus: "AdjustmentFailed",
        Status: "failed",
        StripeCheckoutSessionId: null,
        StripePaymentIntentId: null,
        StripeChargeId: null,
        StripeCustomerId: String(stripeCustomerId),

        Charge_Type: type,
        Description: why || type,

        RawEventId: failedRawEventId,
        Transaction_date: new Date().toISOString(),
        CreatedAt: new Date().toISOString(),
      }).catch(() => {});

      return res.status(402).json({
        ok: false,
        error: msg,
        code,
        decline_code: decline,
        adjustmentPk: adjPk,
      });
    }

    // -----------------------------------------
    // 4) Update adjustment row (Charged / Pending / etc.)
    // -----------------------------------------
    const piStatus = pi?.status || "unknown";
    const latestChargeId =
      (typeof pi?.latest_charge === "string" ? pi.latest_charge : pi?.latest_charge?.id) || null;

    // Map Stripe PI status to your preferred adjustment status
    const adjStatus =
      piStatus === "succeeded"
        ? "Charged"
        : piStatus === "processing"
        ? "Pending"
        : piStatus === "requires_action"
        ? "Requires_Action"
        : "Pending";

    if (adjPk) {
      await updateAdjustmentByPkId(adjPk, {
        Status: adjStatus,
        Stripe_PaymentIntent_ID: pi.id,
        Stripe_Charge_ID: latestChargeId,
        Stripe_Error: "",
        Charged_At: piStatus === "succeeded" ? new Date().toISOString() : null, // optional if column exists
        Updated_At: new Date().toISOString(), // optional if column exists
      }).catch(() => {});
    }

    // -----------------------------------------
    // 5) Insert transaction row (idempotent)
    // -----------------------------------------
    const paidAtIso = new Date().toISOString();
    const amountDollars = Number((amountCents / 100).toFixed(2));

    // Use PI id as stable unique event id for the txn table
    const txnRawEventId = `pi_${pi.id}`;

    await insertTransactionIfMissingByRawEventId({
      IDKEY: String(finalIdKey || ""),
      Amount: amountDollars,
      Currency: "usd",
      PaymentStatus: piStatus === "succeeded" ? "AdjustmentCharged" : "AdjustmentCreated",
      Status: piStatus,
      StripeCheckoutSessionId: null,
      StripePaymentIntentId: pi.id,
      StripeChargeId: latestChargeId,
      StripeCustomerId: String(stripeCustomerId),

      Charge_Type: type,
      Description: why || type,

      RawEventId: txnRawEventId,
      Transaction_date: paidAtIso,
      CreatedAt: new Date().toISOString(),
    }).catch((e) => console.error("⚠️ TXN_INSERT_FAILED", e?.message));

    // If PI ever comes back requires_action, you can't finish off-session. Your fallback is a payment link.
    if (piStatus === "requires_action") {
      return res.status(409).json({
        ok: false,
        status: piStatus,
        message: "Card requires authentication; cannot complete off-session. Use a payment link fallback for this case.",
        payment_intent: { id: pi.id, status: piStatus },
        adjustmentPk: adjPk,
      });
    }

    return res.status(200).json({
      ok: true,
      status: piStatus,
      payment_intent: { id: pi.id, status: piStatus },
      charge_id: latestChargeId,
      adjustmentPk: adjPk,
      idempotencyKey: idemKey,
    });
  } catch (err) {
    console.error("❌ CHARGE_ADJUSTMENT_FAILED", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
