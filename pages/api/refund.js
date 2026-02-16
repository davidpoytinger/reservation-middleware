// pages/api/refund.js
//
// Caspio -> /api/refund?idkey=@IDKEY&txn_id=@TXN_ID&charge_id=@StripeChargeId&amount=12.34&note=...
// Creates a Stripe refund and inserts a negative transaction row into SIGMA_BAR3_Transactions.

import Stripe from "stripe";
import { insertTransactionIfMissingByRawEventId, getReservationByIdKey } from "../../lib/caspio";

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

    const idkey = req.query.idkey || req.query.IDKEY;
    const txnId = req.query.txn_id || req.query.TXN_ID;
    const chargeId = req.query.charge_id || req.query.StripeChargeId;
    const amountStr = req.query.amount;
    const note = oneLine(req.query.note || "");

    if (!idkey) return res.status(400).send("Missing idkey");
    if (!chargeId) return res.status(400).send("Missing charge_id");
    if (!amountStr) return res.status(400).send("Missing amount");

    const refundCents = dollarsToCents(amountStr);
    if (!refundCents || refundCents <= 0) return res.status(400).send("Invalid refund amount");

    // Reservation context (for Charge_Type / Description)
    const reservation = await getReservationByIdKey(idkey).catch(() => null);

    // Retrieve charge to check remaining refundable
    const charge = await stripe.charges.retrieve(String(chargeId));

    const chargeAmountCents = charge?.amount ?? null;
    const alreadyRefundedCents = charge?.amount_refunded ?? 0;

    if (typeof chargeAmountCents !== "number") return res.status(400).send("Charge has no amount");

    const remainingCents = Math.max(0, chargeAmountCents - alreadyRefundedCents);

    if (refundCents > remainingCents) {
      return res
        .status(400)
        .send(`Refund exceeds remaining refundable. Remaining: $${centsToDollars(remainingCents)}`);
    }

    // Idempotency key prevents double-refund if Caspio retries
    const idemKey = ["refund", String(idkey), String(chargeId), String(refundCents), String(txnId || "")].join("_");

    const refund = await stripe.refunds.create(
      {
        charge: String(chargeId),
        amount: refundCents,
        // Stripe "reason" must be one of Stripe's enums; keep stable:
        reason: "requested_by_customer",
        metadata: {
          IDKEY: String(idkey),
          TXN_ID: String(txnId || ""),
          note: note.slice(0, 450),
        },
      },
      { idempotencyKey: idemKey }
    );

    // Insert refund transaction row (negative amount)
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
      StripePaymentIntentId: charge?.payment_intent ? String(charge.payment_intent) : null,
      StripeChargeId: String(chargeId),
      StripeRefundId: refund?.id || null,

      ParentStripeChargeId: String(chargeId),

      StripeCustomerId: charge?.customer || reservation?.StripeCustomerId || null,

      Charge_Type: chargeType,
      Description: desc,

      // RawEventId is UNIQUE in your table; make it deterministic per refund
      RawEventId: `api_refund_${refund.id}`,
      Transaction_date: createdIso,
      CreatedAt: new Date().toISOString(),
    };

    await insertTransactionIfMissingByRawEventId(txnPayload);

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
