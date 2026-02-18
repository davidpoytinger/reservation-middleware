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
// Also responds to
// OPTIONS preflight.

import Stripe from "stripe";
import { findOneByWhere, escapeWhereValue } from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// ---- CORS ----
function setCors(req, res) {
  const allowed = [
    "https://reservebarsandrec.com",
    "https://www.reservebarsandrec.com",
  ];

  const origin = req.headers.origin;
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0];

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-refund-key");
}

function centsToDollars(cents) {
  return typeof cents === "number" ? Number((cents / 100).toFixed(2)) : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const adminKey = process.env.ADMIN_REFUND_KEY || "";
  const provided = String(req.headers["x-refund-key"] || "");
  if (!adminKey || provided !== adminKey) return res.status(401).send("Unauthorized");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const txnId = String(body.txn_id || "").trim();
    const amount = body.amount == null || body.amount === "" ? null : Number(body.amount);
    const reasonNote = String(body.reason || "").trim();

    if (!txnId) return res.status(400).send("Missing txn_id");

    // 1) Look up original transaction (by TXN_ID)
    const txnTable = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
    const safeTxnId = escapeWhereValue(txnId);

    const orig = await findOneByWhere(`TXN_ID='${safeTxnId}'`).catch(async () => {
      // findOneByWhere defaults to BAR2_Reservations_SIGMA; so fallback to direct table query
      // If you have a dedicated helper, use it; otherwise this catch preserves current behavior.
      throw new Error("Original transaction lookup failed (check TXN table query)");
    });

    // If your environment requires direct txn table lookup, replace above with:
    // const orig = await findOneByWhereInTable(txnTable, `TXN_ID='${safeTxnId}'`);

    const piId = orig?.StripePaymentIntentId || null;
    const chargeId = orig?.StripeChargeId || null;

    if (!piId && !chargeId) return res.status(400).send("Transaction missing StripePaymentIntentId/StripeChargeId");

    // 2) Create Stripe refund
    const refundParams = {
      reason: "requested_by_customer",
      metadata: {
        txn_id: String(txnId),
        note: reasonNote || "",
      },
    };

    if (piId) refundParams.payment_intent = String(piId);
    else refundParams.charge = String(chargeId);

    let refundCents = null;
    if (amount != null && Number.isFinite(amount) && amount > 0) {
      refundCents = Math.round(amount * 100);
      refundParams.amount = refundCents;
    }

    const refund = await stripe.refunds.create(refundParams);

    // NOTE: We no longer insert a refund row here.
    // The Stripe webhook (refund.created/refund.updated) writes the negative transaction and triggers rollup.

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      refund_id: refund.id,
      refunded_amount: centsToDollars(refund.amount),
      status: refund.status,
    });
  } catch (err) {
    console.error("REFUND_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Server error");
  }
}
