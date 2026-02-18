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
//  3) DOES NOT insert a refund transaction row anymore
//     -> Stripe webhook (refund.created/refund.updated) writes the negative txn + triggers rollup
//
// Also responds to OPTIONS for CORS preflight.

import Stripe from "stripe";
import { findOneByWhereInTable, escapeWhereValue } from "../../lib/caspio";

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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-refund-key");
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

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).send("Missing STRIPE_SECRET_KEY");
    if (!process.env.ADMIN_REFUND_KEY) return res.status(500).send("Missing ADMIN_REFUND_KEY");

    const adminKey = String(req.headers["x-refund-key"] || "");
    if (!adminKey || adminKey !== process.env.ADMIN_REFUND_KEY) {
      return res.status(401).send("Unauthorized");
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const txnId = oneLine(body.txn_id);
    const reason = oneLine(body.reason || body.note || "");
    const amountCents = dollarsToCents(body.amount);

    if (!txnId) return res.status(400).send("Missing txn_id");

    // 1) Look up original transaction (by TXN_ID) in the TXN table
    const txnTable = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
    const where = `TXN_ID='${escapeWhereValue(txnId)}'`;
    const orig = await findOneByWhereInTable(txnTable, where);

    if (!orig) return res.status(404).send("Transaction not found");

    // Prevent refunding a refund row
    const origType = String(orig.TxnType || "charge").toLowerCase();
    if (origType === "refund") return res.status(400).send("Cannot refund a refund transaction");

    const stripeChargeId = orig.StripeChargeId || orig.Stripe_Charge_ID || null;
    const stripePaymentIntentId = orig.StripePaymentIntentId || orig.Stripe_PaymentIntent_ID || null;

    if (!stripeChargeId && !stripePaymentIntentId) {
      return res.status(400).send("Transaction missing StripeChargeId / StripePaymentIntentId");
    }

    // 2) Locate Stripe charge to determine remaining refundable
    let charge = null;
    if (stripeChargeId) {
      charge = await stripe.charges.retrieve(String(stripeChargeId));
    } else {
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

    const refundCents = amountCents == null ? remainingCents : amountCents;

    if (!refundCents || refundCents <= 0) return res.status(400).send("Nothing left to refund");
    if (refundCents > remainingCents) {
      return res
        .status(400)
        .send(`Refund exceeds remaining refundable. Remaining: $${centsToDollars(remainingCents)}`);
    }

    // Idempotency: same txn + same cents + same charge
    const idemKey = ["refund", String(txnId), String(charge.id), String(refundCents)].join("_").slice(0, 255);

    // 3) Create the refund in Stripe
    const refund = await stripe.refunds.create(
      {
        charge: String(charge.id),
        amount: refundCents,
        reason: "requested_by_customer",
        metadata: {
          txn_id: String(txnId),
          IDKEY: String(orig.IDKEY || ""),
          Confirmation_Number: String(orig.Confirmation_Number || ""),
          note: reason.slice(0, 450),
        },
      },
      { idempotencyKey: idemKey }
    );

    // IMPORTANT:
    // We DO NOT insert a refund txn row here.
    // The Stripe webhook (refund.created/refund.updated) will:
    // - insert the negative Base_Amount / Auto_Gratuity / Tax / Fee + Amount row
    // - roll up into SIGMA_BAR3_TOTAL_RES

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      refund_id: refund.id,
      refunded_amount: centsToDollars(refund.amount),
      remaining_refundable: centsToDollars(remainingCents - refundCents),
      charge_id: charge.id,
      status: refund.status,
    });
  } catch (err) {
    console.error("REFUND_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Refund failed");
  }
}
