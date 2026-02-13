// pages/api/charge-adjustment.js
//
// Off-session adjustment charge using stored payment method.
// Uses IDKEY as authoritative identifier for transaction logging.
//
// Required body fields:
// {
//   "IDKEY": "B9Q9PN8L1M",
//   "baseAmount": 100,
//   "description": "Added 5 guests at check-in",
//   "taxPct": 6.1,
//   "gratPct": 15,
//   "adjustmentType": "Added People",
//   "reason": "Internal notes",
//   "createdBy": "Kevin"
// }

import Stripe from "stripe";
import {
  getReservationByIdKey,
  insertAdjustment,
  updateAdjustmentByPkId,
  insertTransactionIfMissingByRawEventId,
} from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function round2(n) {
  return Number(Number(n).toFixed(2));
}
function toCents(n) {
  return Math.round(n * 100);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      IDKEY,
      baseAmount,
      taxPct = 6.1,
      gratPct = 15,
      adjustmentType,
      description,
      reason,
      createdBy,
    } = req.body || {};

    const idkey = oneLine(IDKEY);
    if (!idkey) return res.status(400).json({ error: "Missing IDKEY" });

    const desc = oneLine(description);
    if (!desc) return res.status(400).json({ error: "Description is required" });

    const base = num(baseAmount);
    if (!base || base <= 0) {
      return res.status(400).json({ error: "Invalid baseAmount" });
    }

    const taxRate = num(taxPct) / 100;
    const gratRate = num(gratPct) / 100;

    const taxAmount = round2(base * taxRate);
    const gratAmount = round2(base * gratRate);
    const totalAmount = round2(base + taxAmount + gratAmount);
    const totalCents = toCents(totalAmount);

    if (!totalCents || totalCents < 50) {
      return res.status(400).json({ error: "Total too small" });
    }

    const type = oneLine(adjustmentType) || "Adjustment";
    const why = oneLine(reason || "");
    const who = oneLine(createdBy || "");

    // -----------------------------------------
    // 1) Load reservation
    // -----------------------------------------
    const reservation = await getReservationByIdKey(idkey);

    const resId =
      oneLine(
        reservation?.RES_ID ??
          reservation?.Res_ID ??
          reservation?.res_id ??
          reservation?.resId ??
          ""
      ) || null;

    const stripeCustomerId =
      reservation?.StripeCustomerId || reservation?.Stripe_Customer_ID || null;

    const stripePaymentMethodId =
      reservation?.StripePaymentMethodId || reservation?.Stripe_PaymentMethod_ID || null;

    if (!stripeCustomerId || !stripePaymentMethodId) {
      return res.status(409).json({
        error: "Reservation missing StripeCustomerId or StripePaymentMethodId",
      });
    }

    // -----------------------------------------
    // 2) Insert adjustment row
    // -----------------------------------------
    const nowIso = new Date().toISOString();

    const adjInsert = await insertAdjustment({
      RES_ID: resId,
      IDKEY: idkey,
      Adjustment_Type: type,
      Description: desc,
      Adjustment_Reason: why,
      Amount: totalAmount,
      Base_Amount: base,
      Tax_Pct: round2(taxPct),
      Tax_Amount: taxAmount,
      Grat_Pct: round2(gratPct),
      Grat_Amount: gratAmount,
      Status: "Pending",
      Created_By: who,
      Created_Date: nowIso,
    });

    const adjPk =
      adjInsert?.Result?.[0]?.PK_ID ??
      adjInsert?.PK_ID ??
      adjInsert?.id ??
      null;

    // -----------------------------------------
    // 3) Charge Stripe
    // -----------------------------------------
    const idemKey = `adj_${idkey}_${adjPk || "nopk"}_${totalCents}`;

    let pi;
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: totalCents,
          currency: "usd",
          customer: stripeCustomerId,
          payment_method: stripePaymentMethodId,
          off_session: true,
          confirm: true,

          description: desc, // 👈 Stripe-visible description

          metadata: {
            IDKEY: idkey,
            RES_ID: String(resId || ""),
            adjustment_pk: String(adjPk || ""),
            adjustment_type: type,
            description: desc,
            base_amount: String(base),
            tax_pct: String(taxPct),
            grat_pct: String(gratPct),
            total_amount: String(totalAmount),
          },

          expand: ["latest_charge"],
        },
        { idempotencyKey: idemKey }
      );
    } catch (err) {
      const msg = err?.raw?.message || err?.message || "Stripe error";

      if (adjPk) {
        await updateAdjustmentByPkId(adjPk, {
          Status: "Failed",
          Stripe_Error: msg,
        }).catch(() => {});
      }

      return res.status(402).json({ ok: false, error: msg });
    }

    const piStatus = pi?.status || "unknown";
    const latestChargeId =
      (typeof pi?.latest_charge === "string"
        ? pi.latest_charge
        : pi?.latest_charge?.id) || null;

    if (adjPk) {
      await updateAdjustmentByPkId(adjPk, {
        Status: piStatus === "succeeded" ? "Charged" : "Pending",
        Stripe_PaymentIntent_ID: pi.id,
        Stripe_Charge_ID: latestChargeId,
        Charged_At: piStatus === "succeeded" ? new Date().toISOString() : null,
      }).catch(() => {});
    }

    // -----------------------------------------
    // 4) Transaction table insert (IDKEY based)
    // -----------------------------------------
    const txnRawEventId = `pi_${pi.id}`;

    await insertTransactionIfMissingByRawEventId({
      IDKEY: String(idkey),
      Amount: totalAmount,
      Currency: "usd",
      PaymentStatus:
        piStatus === "succeeded" ? "AdjustmentCharged" : "AdjustmentCreated",
      Status: piStatus,
      StripeCheckoutSessionId: null,
      StripePaymentIntentId: pi.id,
      StripeChargeId: latestChargeId,
      StripeCustomerId: String(stripeCustomerId),

      Charge_Type: type,
      Description: desc, // 👈 passes into transaction table

      RawEventId: txnRawEventId,
      Transaction_date: new Date().toISOString(),
      CreatedAt: new Date().toISOString(),
    });

    return res.status(200).json({
      ok: true,
      idkey,
      breakdown: {
        base,
        taxAmount,
        gratAmount,
        total: totalAmount,
      },
      payment_intent: { id: pi.id, status: piStatus },
    });
  } catch (err) {
    console.error("❌ CHARGE_ADJUSTMENT_FAILED", err?.message);
    return res.status(500).json({ ok: false, error: err?.message });
  }
}
