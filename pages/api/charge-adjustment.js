// pages/api/charge-adjustment.js
//
// POST /api/charge-adjustment
// Admin endpoint to charge a saved payment method off-session (or create a Checkout Session fallback).
//
// IMPORTANT:
// - We DO NOT insert a "success" transaction row here anymore.
//   Stripe webhook (payment_intent.succeeded) is the single source of truth for successful charges.

import Stripe from "stripe";
import {
  getReservationByIdKey,
  updateReservationByWhere,
  buildWhereForIdKey,
  insertTransactionIfMissingByRawEventId,
} from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-charge-key");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).send(JSON.stringify(payload));
}

function round2(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Number(x.toFixed(2)) : 0;
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method Not Allowed" });

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return json(res, 500, { ok: false, error: "Missing STRIPE_SECRET_KEY" });
    }

    const adminKey = String(process.env.ADMIN_CHARGE_KEY || "").trim();
    const provided = String(req.headers["x-charge-key"] || "").trim();

    if (!adminKey || provided !== adminKey) {
      return json(res, 401, { ok: false, error: "Unauthorized (missing/invalid x-charge-key)" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const idkey = oneLine(body.idkey);
    const type = oneLine(body.type || "Supplemental Fee") || "Supplemental Fee";
    const why = oneLine(body.why || "");
    const base = round2(body.base_amount);
    const taxRate = round2(body.tax_pct);
    const gratRate = round2(body.grat_pct);

    if (!idkey) return json(res, 400, { ok: false, error: "Missing idkey" });
    if (!base || base <= 0) return json(res, 400, { ok: false, error: "Missing/invalid base_amount" });

    const reservation = await getReservationByIdKey(idkey);
    if (!reservation) return json(res, 404, { ok: false, error: "Reservation not found for IDKEY" });

    const stripeCustomerId = oneLine(reservation.StripeCustomerId);
    const stripePaymentMethodId = oneLine(reservation.StripePaymentMethodId);

    const resId =
      reservation.RES_ID ??
      reservation.Res_ID ??
      reservation.res_id ??
      reservation.resId ??
      "";

    const taxAmount = round2(base * (taxRate / 100));
    const gratAmount = round2(base * (gratRate / 100));
    const totalAmount = round2(base + taxAmount + gratAmount);
    const totalCents = Math.round(totalAmount * 100);

    const formattedDescription = [type, why].filter(Boolean).join(" - ").slice(0, 500);

    // touch reservation (optional)
    const where = buildWhereForIdKey(idkey);
    await updateReservationByWhere(where, { UpdatedAt: new Date().toISOString() }).catch(() => {});

    // Prefer off-session charge if we have a saved payment method
    if (stripeCustomerId && stripePaymentMethodId) {
      // Stable idempotency: same IDKEY + cents + description
      const idemKey = [
        "offsession",
        idkey,
        String(totalCents),
        formattedDescription.slice(0, 60).replace(/\s+/g, "_")
      ].join("_").slice(0, 255);

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
            description: formattedDescription,
            metadata: {
              IDKEY: String(idkey),
              RES_ID: String(resId || ""),
              purpose: "supplemental_fee",
              Charge_Type: type,
              Description: formattedDescription,
              Reason: why,
              base_amount: String(round2(base)),
              tax_pct: String(round2(taxRate)),
              tax_amount: String(round2(taxAmount)),
              grat_pct: String(round2(gratRate)),
              grat_amount: String(round2(gratAmount)),
              fee_amount: "0",
              total_amount: String(round2(totalAmount)),
              source: "off_session",
            },
            expand: ["latest_charge"],
          },
          { idempotencyKey: idemKey }
        );
      } catch (err) {
        const msg = err?.raw?.message || err?.message || "Stripe error";

        // Optional: log failure (does NOT roll up, since TxnType isn't charge/refund)
        await insertTransactionIfMissingByRawEventId({
          IDKEY: String(idkey),
          Amount: totalAmount,
          Currency: "usd",
          PaymentStatus: "AdjustmentFailed",
          Status: "failed",
          StripeCheckoutSessionId: null,
          StripePaymentIntentId: null,
          StripeChargeId: null,
          StripeCustomerId: String(stripeCustomerId),
          Charge_Type: type,
          Description: formattedDescription,
          RawEventId: `supp_fail_${idkey}_${totalCents}_${Date.now()}`,
          Transaction_date: new Date().toISOString(),
          CreatedAt: new Date().toISOString(),
        }).catch(() => {});

        return json(res, 402, { ok: false, error: msg });
      }

      return json(res, 200, {
        ok: true,
        mode: "off_session",
        payment_intent_id: pi?.id || null,
        status: pi?.status || "unknown",
        amount: totalAmount,
      });
    }

    // Fallback: Checkout Session if no saved payment method
    const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://reservebarsandrec.com";
    const successUrl = `${allowedOrigin}/charge-tool-success.html?idkey=${encodeURIComponent(idkey)}`;
    const cancelUrl = `${allowedOrigin}/charge-tool-cancel.html?idkey=${encodeURIComponent(idkey)}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: stripeCustomerId || undefined,

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: type,
              description: formattedDescription || undefined,
            },
            unit_amount: totalCents,
          },
          quantity: 1,
        },
      ],

      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: {
          IDKEY: String(idkey),
          RES_ID: String(resId || ""),
          purpose: "supplemental_fee",
          Charge_Type: type,
          Description: formattedDescription,
          Reason: why,
          base_amount: String(round2(base)),
          tax_pct: String(round2(taxRate)),
          tax_amount: String(round2(taxAmount)),
          grat_pct: String(round2(gratRate)),
          grat_amount: String(round2(gratAmount)),
          fee_amount: "0",
          total_amount: String(round2(totalAmount)),
          source: "checkout_fallback",
        },
      },
      metadata: {
        IDKEY: String(idkey),
        RES_ID: String(resId || ""),
      },

      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return json(res, 200, {
      ok: true,
      mode: "checkout",
      checkout_url: session.url,
      session_id: session.id,
      amount: totalAmount,
    });
  } catch (err) {
    const msg = err?.message || String(err || "Server error");
    console.error("CHARGE_ADJUSTMENT_FAILED", msg);
    return json(res, 500, { ok: false, error: msg });
  }
}
