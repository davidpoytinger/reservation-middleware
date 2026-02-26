// pages/api/charge-adjustment.js
//
// POST /api/charge-adjustment
// Admin endpoint to charge a saved payment method off-session (or create a Checkout Session fallback).
//
// ✅ Updates included:
// 1) Stripe client hardened: maxNetworkRetries + timeout
// 2) Safety-net: on successful off-session PI, insert a Caspio TXN row immediately (idempotent)
// 3) Recovery: if Stripe returns a "connection" error, attempt to find the PI via Stripe Search
//    (using metadata.idem_key) and treat as success if found.
// 4) Failure logging preserved: inserts AdjustmentFailed row when unrecoverable.
//
// Notes:
// - Webhook can still insert; dedupe prevents duplicates (RawEventId pi_<pi.id> + Stripe IDs).
// - Requires Stripe Search API (enabled on most accounts).
// - Your UI should still handle mode === "checkout" by redirecting to checkout_url.

import Stripe from "stripe";
import {
  getReservationByIdKey,
  updateReservationByWhere,
  buildWhereForIdKey,
  insertTransactionIfMissingByRawEventId,
} from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  maxNetworkRetries: 3,
  timeout: 30000,
});

function setCors(req, res) {
  const allowed = ["https://reservebarsandrec.com", "https://www.reservebarsandrec.com"];

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

function safeStripeErrorMessage(err) {
  return err?.raw?.message || err?.message || "Stripe error";
}

function looksLikeConnectionError(err, msg) {
  const m = String(msg || "");
  return (
    err?.type === "StripeConnectionError" ||
    /connection to stripe/i.test(m) ||
    /socket/i.test(m) ||
    /timeout/i.test(m) ||
    /ecconnreset/i.test(m) ||
    /econnreset/i.test(m) ||
    /etimedout/i.test(m)
  );
}

function escapeStripeSearchString(s) {
  // Stripe search uses single quotes; escape them
  return String(s || "").replace(/'/g, "\\'");
}

async function safetyNetInsertCharge({
  idkey,
  base,
  taxAmount,
  gratAmount,
  totalAmount,
  stripeCustomerId,
  stripePaymentMethodId,
  chargeType,
  description,
  piFull,
}) {
  await insertTransactionIfMissingByRawEventId({
    IDKEY: String(idkey),
    TxnType: "charge",

    Base_Amount: round2(base),
    Auto_Gratuity: round2(gratAmount),
    Tax: round2(taxAmount),
    Fee: 0,
    Amount: round2(totalAmount),

    Currency: "usd",
    PaymentStatus: "Paid",
    Status: piFull?.status || "succeeded",

    StripeCheckoutSessionId: null,
    StripePaymentIntentId: piFull?.id || null,
    StripeChargeId: piFull?.latest_charge?.id || null,
    StripeCustomerId: String(stripeCustomerId || ""),
    StripePaymentMethodId: String(stripePaymentMethodId || ""),

    Charge_Type: String(chargeType || "").slice(0, 250),
    Description: String(description || "").slice(0, 500),

    // Stable per-PI idempotency key
    RawEventId: `pi_${piFull?.id}`,
    Transaction_date: new Date().toISOString(),
    CreatedAt: new Date().toISOString(),
  });
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

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
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
      const idemKey = ["offsession", idkey, String(totalCents), formattedDescription.slice(0, 60).replace(/\s+/g, "_")]
        .join("_")
        .slice(0, 255);

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

              // ✅ used for recovery search
              idem_key: idemKey,
            },
            expand: ["latest_charge"],
          },
          { idempotencyKey: idemKey }
        );

        // ✅ safety-net insert (idempotent)
        await safetyNetInsertCharge({
          idkey,
          base,
          taxAmount,
          gratAmount,
          totalAmount,
          stripeCustomerId,
          stripePaymentMethodId,
          chargeType: type,
          description: formattedDescription,
          piFull: pi,
        }).catch((e) => console.warn("SAFETY_NET_TXN_INSERT_FAILED", e?.message || e));

        return json(res, 200, {
          ok: true,
          mode: "off_session",
          payment_intent_id: pi?.id || null,
          status: pi?.status || "unknown",
          amount: totalAmount,
          idem_key: idemKey,
        });
      } catch (err) {
        const msg = safeStripeErrorMessage(err);

        // ✅ Recovery path for connection errors: search for PI by metadata.idem_key
        if (looksLikeConnectionError(err, msg)) {
          try {
            const q = [
              `metadata['idem_key']:'${escapeStripeSearchString(idemKey)}'`,
              `customer:'${escapeStripeSearchString(stripeCustomerId)}'`,
              `amount:${totalCents}`,
            ].join(" AND ");

            const found = await stripe.paymentIntents.search({ query: q, limit: 1 });
            const piFound = found?.data?.[0] || null;

            if (piFound?.id) {
              const piFull = await stripe.paymentIntents.retrieve(piFound.id, { expand: ["latest_charge"] });

              await safetyNetInsertCharge({
                idkey,
                base,
                taxAmount,
                gratAmount,
                totalAmount,
                stripeCustomerId,
                stripePaymentMethodId,
                chargeType: type,
                description: formattedDescription,
                piFull,
              }).catch((e) => console.warn("SAFETY_NET_TXN_INSERT_FAILED", e?.message || e));

              return json(res, 200, {
                ok: true,
                mode: "off_session",
                recovered: true,
                payment_intent_id: piFull?.id || null,
                status: piFull?.status || "unknown",
                amount: totalAmount,
                idem_key: idemKey,
              });
            }
          } catch (e) {
            console.warn("STRIPE_RECOVERY_SEARCH_FAILED", e?.message || e);
          }
        }

        // Optional: log failure (does NOT roll up, since TxnType isn't charge/refund)
        await insertTransactionIfMissingByRawEventId({
          IDKEY: String(idkey),
          TxnType: "log",
          Amount: totalAmount,
          Currency: "usd",
          PaymentStatus: "AdjustmentFailed",
          Status: "failed",
          StripeCheckoutSessionId: null,
          StripePaymentIntentId: null,
          StripeChargeId: null,
          StripeCustomerId: String(stripeCustomerId),
          StripePaymentMethodId: String(stripePaymentMethodId),
          Charge_Type: type,
          Description: formattedDescription,
          RawEventId: `supp_fail_${idkey}_${totalCents}_${Date.now()}`,
          Transaction_date: new Date().toISOString(),
          CreatedAt: new Date().toISOString(),
        }).catch(() => {});

        return json(res, 402, { ok: false, error: msg, idem_key: idemKey });
      }
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
            product_data: { name: type, description: formattedDescription || undefined },
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
      metadata: { IDKEY: String(idkey), RES_ID: String(resId || "") },
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
