// pages/api/refund.js
//
// Caspio -> /api/refund?txn_id=...&idkey=...&charge_id=...&amount=...&note=...
// Creates a Stripe refund and writes a negative transaction row into SIGMA_BAR3_Transactions.

import Stripe from "stripe";
import {
  insertTransactionIfMissingByRawEventId,
  getReservationByIdKey,
  // YOU WILL ADD THIS:
  // listTransactionsByChargeId,
} from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function dollarsToCents(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function centsToDollars(cents) {
  return typeof cents === "number" ? Number((cents / 100).toFixed(2)) : null;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).send("Missing STRIPE_SECRET_KEY");

    // Inputs from Caspio button
    const idkey = req.query.idkey || req.query.IDKEY;
    const txnId = req.query.txn_id || req.query.TXN_ID;
    const chargeId = req.query.charge_id || req.query.StripeChargeId;
    const paymentIntentId = req.query.pi_id || req.query.StripePaymentIntentId;
    const amountStr = req.query.amount;
    const reason = oneLine(req.query.reason || "requested_by_customer");
    const note = oneLine(req.query.note || "");

    if (!idkey) return res.status(400).send("Missing idkey");
    if (!chargeId && !paymentIntentId) return res.status(400).send("Missing charge_id or pi_id");
    if (!amountStr) return res.status(400).send("Missing amount");

    const refundCents = dollarsToCents(amountStr);
    if (!refundCents || refundCents <= 0) return res.status(400).send("Invalid refund amount");

    // Pull reservation for context (optional but helpful)
    const reservation = await getReservationByIdKey(idkey).catch(() => null);

    // Resolve charge + PI
    let charge = null;
    let pi = null;

    if (chargeId) {
      charge = await stripe.charges.retrieve(chargeId);
      if (charge?.payment_intent) {
        pi = await stripe.paymentIntents.retrieve(String(charge.payment_intent));
      }
    } else {
      pi = await stripe.paymentIntents.retrieve(String(paymentIntentId));
      const chId = pi?.charges?.data?.[0]?.id;
      if (chId) charge = await stripe.charges.retrieve(chId);
    }

    const resolvedChargeId = charge?.id || null;
    const resolvedPiId = pi?.id || (charge?.payment_intent ? String(charge.payment_intent) : null);

    if (!resolvedChargeId) return res.status(400).send("Could not resolve Stripe charge id");
    if (!resolvedPiId) return res.status(400).send("Could not resolve Stripe payment_intent id");

    // ------------------------------------------------------------
    // Prevent over-refunds by computing remaining refundable
    // You will implement listTransactionsByChargeId in lib/caspio.
    // It should return all rows from SIGMA_BAR3_Transactions where
    // StripeChargeId == resolvedChargeId OR ParentStripeChargeId == resolvedChargeId.
    // ------------------------------------------------------------

    // const txns = await listTransactionsByChargeId(resolvedChargeId);

    // For now, we can compute remaining from Stripe directly (simple + reliable):
    // remaining = charge.amount - alreadyRefunded (from Stripe)
    const chargeAmountCents = charge?.amount ?? null;
    const alreadyRefundedCents = charge?.amount_refunded ?? 0;

    if (typeof chargeAmountCents !== "number") {
      return res.status(400).send("Charge has no amount");
    }

    const remainingCents = Math.max(0, chargeAmountCents - alreadyRefundedCents);
    if (refundCents > remainingCents) {
      return res
        .status(400)
        .send(`Refund exceeds remaining refundable. Remaining: $${centsToDollars(remainingCents)}`);
    }

    // ------------------------------------------------------------
    // Create Stripe refund (idempotent-ish key)
    // ------------------------------------------------------------
    const idemKey = [
      "refund",
      String(idkey),
      String(resolvedChargeId),
      String(refundCents),
      String(txnId || ""),
    ].join("_");

    const refund = await stripe.refunds.create(
      {
        charge: resolvedChargeId,
        amount: refundCents,
        reason: "requested_by_customer", // Stripe only allows specific enums; keep stable.
        metadata: {
          IDKEY: String(idkey),
          TXN_ID: String(txnId || ""),
          note: note.slice(0, 450),
        },
      },
      { idempotencyKey: idemKey }
    );

    // ------------------------------------------------------------
    // Insert a negative transaction row immediately
    // We set RawEventId deterministically so the same refund can’t be inserted twice.
    // (You already enforce RawEventId unique)
    // ------------------------------------------------------------
    const createdIso = new Date((refund?.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const currency = (refund?.currency || charge?.currency || "usd").toLowerCase();

    const chargeType = oneLine(reservation?.Charge_Type || "refund");
    const desc = note ? `Refund - ${chargeType} - ${note}` : `Refund - ${chargeType}`;

    const txnPayload = {
      IDKEY: String(idkey),

      TxnType: "refund",
      Amount: -Math.abs(Number((refundCents / 100).toFixed(2))),
      Currency: currency,

      PaymentStatus: "Refunded",
      Status: refund?.status || "succeeded",

      StripeCheckoutSessionId: null,
      StripePaymentIntentId: resolvedPiId,
      StripeChargeId: resolvedChargeId,
      StripeRefundId: refund?.id || null,

      ParentStripeChargeId: resolvedChargeId,

      StripeCustomerId: charge?.customer || reservation?.StripeCustomerId || null,

      Charge_Type: chargeType,
      Description: desc,

      RawEventId: `api_refund_${refund.id}`, // unique + stable
      Transaction_date: createdIso,
      CreatedAt: new Date().toISOString(),
    };

    await insertTransactionIfMissingByRawEventId(txnPayload);

    // Respond in a way Caspio can use
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      refund_id: refund.id,
      refunded_amount: centsToDollars(refundCents),
      remaining_refundable: centsToDollars(remainingCents - refundCents),
    });
  } catch (err) {
    console.error("REFUND_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Refund failed");
  }
}
