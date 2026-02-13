// pages/api/charge-adjustment.js
//
// Charges a customer a supplemental fee.
// - If we have stored Stripe customer + payment method -> off-session charge (one-click)
// - Otherwise -> creates a Stripe Checkout Session and returns checkout_url
//
// Writes to Caspio: SIGMA_BAR3_Transactions (via insertTransactionIfMissingByRawEventId).
// NO "adjustments" table required.

import Stripe from "stripe";
import {
  getReservationByIdKey,
  insertTransactionIfMissingByRawEventId,
  updateReservationByWhere,
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
function clampStr(s, max = 250) {
  const v = oneLine(s);
  return v.length > max ? v.slice(0, max) : v;
}

function setCors(req, res) {
  const originHeader = req.headers.origin;
  const origin = typeof originHeader === "string" ? originHeader : "";
  const allowAny = String(process.env.CORS_ALLOW_ANY || "").toLowerCase() === "true";

  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const isNullOrigin = origin === "null";
  const isAllowedStrict =
    (origin && allowed.includes(origin)) || (isNullOrigin && allowed.includes("null"));

  const isAllowed = allowAny || isAllowedStrict;

  if (allowAny) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (isAllowedStrict) {
    res.setHeader("Access-Control-Allow-Origin", isNullOrigin ? "null" : origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  return { isAllowed, origin: origin || null, allowAny, allowed };
}

// Pull Customer/PM from reservation; attempt derive from PI if present.
// NOTE: If you don’t store StripePaymentMethodId yet, the “derive” step may still fail,
// in which case we fall back to Checkout.
async function deriveStripeBillingFromReservation(reservation) {
  const existingCustomer =
    reservation?.StripeCustomerId ||
    reservation?.Stripe_Customer_ID ||
    reservation?.stripeCustomerId ||
    null;

  const existingPm =
    reservation?.StripePaymentMethodId ||
    reservation?.Stripe_PaymentMethod_ID ||
    reservation?.stripePaymentMethodId ||
    null;

  if (existingCustomer && existingPm) {
    return { stripeCustomerId: existingCustomer, stripePaymentMethodId: existingPm, source: "reservation" };
  }

  const piId =
    reservation?.StripePaymentIntentId ||
    reservation?.Stripe_PaymentIntent_ID ||
    reservation?.stripePaymentIntentId ||
    null;

  if (piId) {
    const pi = await stripe.paymentIntents.retrieve(String(piId), {
      expand: ["payment_method", "latest_charge"],
    });

    const stripeCustomerId =
      (typeof pi.customer === "string" ? pi.customer : pi.customer?.id) || existingCustomer || null;

    const pmFromPI =
      (typeof pi.payment_method === "string" && pi.payment_method) ||
      (typeof pi.payment_method !== "string" ? pi.payment_method?.id : null) ||
      null;

    const pmFromCharge =
      (typeof pi.latest_charge === "string" ? null : pi.latest_charge?.payment_method) || null;

    const stripePaymentMethodId = pmFromPI || pmFromCharge || existingPm || null;

    return { stripeCustomerId, stripePaymentMethodId, source: "payment_intent" };
  }

  return { stripeCustomerId: existingCustomer, stripePaymentMethodId: existingPm, source: "none" };
}

export default async function handler(req, res) {
  const cors = setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  if (!cors.isAllowed) {
    return res.status(403).json({
      ok: false,
      error:
        "CORS blocked. Add this origin to ALLOWED_ORIGINS (or set CORS_ALLOW_ANY=true temporarily).",
      origin: cors.origin,
      allowedOriginsConfigured: cors.allowed,
    });
  }

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "Missing STRIPE_SECRET_KEY" });
    }
    if (!process.env.SITE_BASE_URL) {
      return res.status(500).json({ ok: false, error: "Missing SITE_BASE_URL" });
    }

    const {
      IDKEY,
      baseAmount,
      taxPct = 6.1,
      gratPct = 15,
      adjustmentType,
      description,
      reason,
    } = req.body || {};

    const idkey = oneLine(IDKEY);
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing IDKEY" });

    const base = num(baseAmount, null);
    if (base === null || base <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid baseAmount" });
    }

    const type = clampStr(adjustmentType || "Supplemental Fee", 60);
    const descRaw = clampStr(description, 180);
    if (!descRaw) return res.status(400).json({ ok: false, error: "Description is required" });

    const formattedDescription = clampStr(`${type} – ${descRaw}`, 250);
    const why = clampStr(reason || "", 500);

    const taxRate = num(taxPct, null);
    const gratRate = num(gratPct, null);
    if (taxRate === null || taxRate < 0 || taxRate > 25) {
      return res.status(400).json({ ok: false, error: "Invalid taxPct (expected 0–25)" });
    }
    if (gratRate === null || gratRate < 0 || gratRate > 50) {
      return res.status(400).json({ ok: false, error: "Invalid gratPct (expected 0–50)" });
    }

    const taxAmount = round2(base * (taxRate / 100));
    const gratAmount = round2(base * (gratRate / 100));
    const totalAmount = round2(base + taxAmount + gratAmount);
    const totalCents = toCents(totalAmount);

    if (!totalCents || totalCents < 50) {
      return res.status(400).json({ ok: false, error: "Total too small" });
    }

    // Load reservation
    const reservation = await getReservationByIdKey(idkey);

    const resId =
      oneLine(
        reservation?.RES_ID ??
          reservation?.Res_ID ??
          reservation?.res_id ??
          reservation?.resId ??
          ""
      ) || null;

    const customerEmail = oneLine(reservation?.Email || "") || null;

    // Try to derive stored billing
    const derived = await deriveStripeBillingFromReservation(reservation);
    const stripeCustomerId = derived.stripeCustomerId;
    const stripePaymentMethodId = derived.stripePaymentMethodId;

    // If we *can* off-session charge -> do it
    if (stripeCustomerId && stripePaymentMethodId) {
      // Optional writeback to reservation for future speed
      try {
        const where = `IDKEY='${String(idkey).replaceAll("'", "''")}'`;
        await updateReservationByWhere(where, {
          StripeCustomerId: stripeCustomerId,
          StripePaymentMethodId: stripePaymentMethodId,
        });
      } catch (e) {
        console.warn("⚠️ Stripe billing writeback skipped/failed:", e?.message || e);
      }

      const idemKey = `supp_${idkey}_${totalCents}_${Date.now()}`; // unique per click; you can make it deterministic if you prefer

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
              total_amount: String(round2(totalAmount)),
              source: "off_session",
            },
            expand: ["latest_charge"],
          },
          { idempotencyKey: idemKey }
        );
      } catch (err) {
        const msg = err?.raw?.message || err?.message || "Stripe error";

        // Log failure to transactions table (best-effort)
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

        return res.status(402).json({ ok: false, error: msg });
      }

      const piStatus = pi?.status || "unknown";
      const latestChargeId =
        (typeof pi?.latest_charge === "string" ? pi.latest_charge : pi?.latest_charge?.id) || null;

      // Log success to transactions table (best-effort)
      await insertTransactionIfMissingByRawEventId({
        IDKEY: String(idkey),
        Amount: totalAmount,
        Currency: "usd",
        PaymentStatus: piStatus === "succeeded" ? "AdjustmentCharged" : "AdjustmentCreated",
        Status: piStatus,
        StripeCheckoutSessionId: null,
        StripePaymentIntentId: pi.id,
        StripeChargeId: latestChargeId,
        StripeCustomerId: String(stripeCustomerId),
        Charge_Type: type,
        Description: formattedDescription,
        RawEventId: `pi_${pi.id}`,
        Transaction_date: new Date().toISOString(),
        CreatedAt: new Date().toISOString(),
      }).catch(() => {});

      return res.status(200).json({
        ok: true,
        mode: "off_session",
        idkey,
        res_id: resId,
        description: formattedDescription,
        derivedStripeBillingSource: derived.source,
        breakdown: {
          base: round2(base),
          taxPct: round2(taxRate),
          taxAmount: round2(taxAmount),
          gratPct: round2(gratRate),
          gratAmount: round2(gratAmount),
          total: round2(totalAmount),
        },
        payment_intent: { id: pi.id, status: piStatus },
        charge_id: latestChargeId,
      });
    }

    // Otherwise fallback: create a Checkout session (customer pays)
    const baseUrl = String(process.env.SITE_BASE_URL).replace(/\/+$/, "");
    const successUrl =
      `${baseUrl}/barresv5custmanage.html?idkey=${encodeURIComponent(idkey)}` +
      (resId ? `&res_id=${encodeURIComponent(resId)}` : "");
    const cancelUrl =
      `${baseUrl}/barresv5custmanage.html?idkey=${encodeURIComponent(idkey)}` +
      (resId ? `&res_id=${encodeURIComponent(resId)}` : "");

    const checkoutMeta = {
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
      total_amount: String(round2(totalAmount)),
      source: "checkout_fallback",
    };

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      client_reference_id: String(idkey),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            product_data: {
              name: type,
              description: formattedDescription,
            },
            unit_amount: totalCents,
          },
        },
      ],
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: checkoutMeta,
      },
      metadata: checkoutMeta,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    // Log "checkout created" to transactions (best-effort)
    await insertTransactionIfMissingByRawEventId({
      IDKEY: String(idkey),
      Amount: totalAmount,
      Currency: "usd",
      PaymentStatus: "AdjustmentCheckoutCreated",
      Status: "pending",
      StripeCheckoutSessionId: checkoutSession.id,
      StripePaymentIntentId: null,
      StripeChargeId: null,
      StripeCustomerId: null,
      Charge_Type: type,
      Description: formattedDescription,
      RawEventId: `checkout_${checkoutSession.id}`,
      Transaction_date: new Date().toISOString(),
      CreatedAt: new Date().toISOString(),
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      mode: "checkout",
      idkey,
      res_id: resId,
      description: formattedDescription,
      checkout_session_id: checkoutSession.id,
      checkout_url: checkoutSession.url,
      breakdown: {
        base: round2(base),
        taxPct: round2(taxRate),
        taxAmount: round2(taxAmount),
        gratPct: round2(gratRate),
        gratAmount: round2(gratAmount),
        total: round2(totalAmount),
      },
    });
  } catch (err) {
    console.error("❌ CHARGE_ADJUSTMENT_FAILED", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
