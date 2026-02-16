// pages/api/refund.js
//
// Admin refund endpoint for the Transactions app.
//
// POST /api/refund
// Headers:
//   x-refund-key: <ADMIN_REFUND_KEY>
// Body (JSON):
//   { txn_id: "12345", amount: 12.34 (optional; blank = full), reason: "note" (optional) }
//
// This route:
//  1) Looks up the original transaction by TXN_ID in SIGMA_BAR3_Transactions
//  2) Creates a Stripe refund (full/partial)
//  3) Inserts a NEGATIVE refund transaction row into SIGMA_BAR3_Transactions
//
// Also responds to OPTIONS for CORS preflight.

import Stripe from "stripe";
import { findOneByWhere, insertRecord, escapeWhereValue } from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// ---- CORS ----
function setCors(req, res) {
  const allowed = new Set([
    "https://reservebarsandrec.com",
    "https://www.reservebarsandrec.com",
  ]);

  const origin = req.headers.origin;
  const allowOrigin = allowed.has(origin) ? origin : "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-refund-key");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function dollarsToCents(d) {
  if (d === null || d === undefined || d === "") return null;
  const n = Number(d);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function centsToDollars(cents) {
  return typeof cents === "number" ? Number((cents / 100).toFixed(2)) : null;
}

export default async function handler(req, res) {
  setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  // Only POST for admin tool
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).send("Missing STRIPE_SECRET_KEY");
    if (!process.env.ADMIN_REFUND_KEY) return res.status(500).send("Missing ADMIN_REFUND_KEY");

    // Auth
    const adminKey = req.headers["x-refund-key"];
    if (!adminKey || adminKey !== process.env.ADMIN_REFUND_KEY) {
      return res.status(401).send("Unauthorized");
    }

    // Parse body
    const body = req.body || {};
    const txnId = oneLine(body.txn_id);
    const reason = oneLine(body.reason || body.note || "");
    const amountCents = dollarsToCents(body.amount);

    if (!txnId) return res.status(400).send("Missing txn_id");

    // Look up original transaction row
    const txnTable = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
    const where = `TXN_ID='${escapeWhereValue(txnId)}'`;
    const orig = await findOneByWhere(txnTable, where);

    if (!orig) return res.status(404).send("Transaction not found");

    // Prevent refunding a refund row
    const origType = String(orig.TxnType || "charge").toLowerCase();
    if (origType === "refund") return res.status(400).send("Cannot refund a refund transaction");

    // We refund based on charge or payment_intent
    const stripeChargeId = orig.StripeChargeId || orig.Stripe_Charge_ID || null;
    const stripePaymentIntentId = orig.StripePaymentIntentId || orig.Stripe_PaymentIntent_ID || null;

    if (!stripeChargeId && !stripePaymentIntentId) {
      return res.status(400).send("Transaction missing StripeChargeId / StripePaymentIntentId");
    }

    // Check remaining refundable (best via charge when possible)
    let charge = null;
    if (stripeChargeId) {
      charge = await stripe.charges.retrieve(String(stripeChargeId));
    } else if (stripePaymentIntentId) {
      // fallback: get latest charge from PI
      const pi = await stripe.paymentIntents.retrieve(String(stripePaymentIntentId), {
        expand: ["charges.data"],
      });
      charge = pi?.charges?.data?.[0] || null;
    }

    if (!charge) return res.status(400).send("Unable to locate Stripe charge for this transaction");

    const chargeAmountCents = charge?.amount ?? null;
    const alreadyRefundedCents = charge?.amount_refunded ?? 0;
    if (typeof chargeAmountCents !== "number") return res.status(400).send("Stripe charge has no amount");

    const remainingCents = Math.max(0, chargeAmountCents - alreadyRefundedCents);

    // If amount omitted => full remaining refund
    const refundCents = amountCents == null ? remainingCents : amountCents;

    if (!refundCents || refundCents <= 0) return res.status(400).send("Nothing left to refund");
    if (refundCents > remainingCents) {
      return res
        .status(400)
        .send(`Refund exceeds remaining refundable. Remaining: $${centsToDollars(remainingCents)}`);
    }

    // Idempotency: same txn + same cents + same charge
    const idemKey = ["refund", String(txnId), String(charge.id), String(refundCents)].join("_");

    const refund = await stripe.refunds.create(
      {
        charge: String(charge.id),
        amount: refundCents,
        reason: "requested_by_customer",
        metadata: {
          TXN_ID: String(txnId),
          IDKEY: String(orig.IDKEY || ""),
          Confirmation_Number: String(orig.Confirmation_Number || ""),
          note: reason.slice(0, 450),
        },
      },
      { idempotencyKey: idemKey }
    );

    // Insert refund transaction row (negative amount)
    const createdIso = new Date((refund?.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const currency = (refund?.currency || charge?.currency || orig.Currency || "usd").toLowerCase();

    const descBase = orig.Description || orig.Charge_Type || "charge";
    const desc = reason ? `Refund - ${descBase} - ${reason}` : `Refund - ${descBase}`;

    const refundTxnPayload = {
      IDKEY: String(orig.IDKEY || ""),

      TxnType: "refund",
      Amount: -Math.abs(Number((refundCents / 100).toFixed(2))),
      Currency: currency,

      PaymentStatus: "Refunded",
      Status: refund?.status || "succeeded",

      StripeCheckoutSessionId: orig.StripeCheckoutSessionId || null,
      StripePaymentIntentId: charge?.payment_intent ? String(charge.payment_intent) : (stripePaymentIntentId || null),
      StripeChargeId: String(charge.id),
      StripeRefundId: refund?.id || null,

      ParentStripeChargeId: String(charge.id),

      StripeCustomerId: charge?.customer || orig.StripeCustomerId || null,
      StripePaymentMethodId: orig.StripePaymentMethodId || null,

      Charge_Type: orig.Charge_Type || "refund",
      Description: oneLine(desc).slice(0, 250),

      // ✅ carry through
      Confirmation_Number: orig.Confirmation_Number || null,

      // Unique
      RawEventId: `api_refund_${refund.id}`,
      Transaction_date: createdIso,
      CreatedAt: new Date().toISOString(),
    };

    await insertRecord(txnTable, refundTxnPayload);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      refund_id: refund.id,
      refunded_amount: centsToDollars(refundCents),
      remaining_refundable: centsToDollars(remainingCents - refundCents),
      charge_id: charge.id,
    });
  } catch (err) {
    console.error("REFUND_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Refund failed");
  }
}
