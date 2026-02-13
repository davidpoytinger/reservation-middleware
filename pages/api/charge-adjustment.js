// pages/api/charge-adjustment.js

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
function clampStr(s, max = 250) {
  const v = oneLine(s);
  return v.length > max ? v.slice(0, max) : v;
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // If allowlist empty, do NOT open CORS. Force you to configure it.
  const isAllowed = allowed.includes(origin);

  if (isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  return isAllowed;
}

export default async function handler(req, res) {
  const isAllowed = setCors(req, res);

  if (req.method === "OPTIONS") {
    // If origin not in allowlist, still return 204 but without Allow-Origin
    return res.status(204).end();
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Hard block non-allowed origins (recommended)
  if (!isAllowed) {
    return res.status(403).json({
      ok: false,
      error:
        "CORS blocked. Add this request origin to ALLOWED_ORIGINS in Vercel env vars.",
      origin: req.headers.origin || null,
    });
  }

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
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing IDKEY" });

    const base = num(baseAmount, null);
    if (base === null || base <= 0) return res.status(400).json({ ok: false, error: "Invalid baseAmount" });

    const type = clampStr(adjustmentType || "Adjustment", 60);
    const descRaw = clampStr(description, 180);
    if (!descRaw) return res.status(400).json({ ok: false, error: "Description is required" });

    const formattedDescription = clampStr(`${type} – ${descRaw}`, 250);

    const why = clampStr(reason || "", 500);
    const who = clampStr(createdBy || "", 80);

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
    if (!totalCents || totalCents < 50) return res.status(400).json({ ok: false, error: "Total too small" });

    // Load reservation by IDKEY
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
        ok: false,
        error: "Reservation missing StripeCustomerId or StripePaymentMethodId",
      });
    }

    // Insert adjustment row
    const nowIso = new Date().toISOString();

    const adjInsert = await insertAdjustment({
      RES_ID: resId,
      IDKEY: idkey,
      Adjustment_Type: type,
      Description: formattedDescription,
      Adjustment_Reason: why,
      Amount: totalAmount,
      Base_Amount: base,
      Tax_Pct: round2(taxRate),
      Tax_Amount: taxAmount,
      Grat_Pct: round2(gratRate),
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

    // Charge off-session
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
          description: formattedDescription,
          metadata: {
            IDKEY: idkey,
            RES_ID: String(resId || ""),
            adjustment_pk: String(adjPk || ""),
            adjustment_type: type,
            description: formattedDescription,
            base_amount: String(round2(base)),
            tax_pct: String(round2(taxRate)),
            tax_amount: String(round2(taxAmount)),
            grat_pct: String(round2(gratRate)),
            grat_amount: String(round2(gratAmount)),
            total_amount: String(round2(totalAmount)),
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
          Updated_At: new Date().toISOString(),
        }).catch(() => {});
      }

      // Log failed attempt
      const failedRawEventId = `adj_fail_${idkey}_${adjPk || "nopk"}_${totalCents}`;
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
        RawEventId: failedRawEventId,
        Transaction_date: new Date().toISOString(),
        CreatedAt: new Date().toISOString(),
      }).catch(() => {});

      return res.status(402).json({ ok: false, error: msg, adjustmentPk: adjPk });
    }

    const piStatus = pi?.status || "unknown";
    const latestChargeId =
      (typeof pi?.latest_charge === "string" ? pi.latest_charge : pi?.latest_charge?.id) || null;

    if (adjPk) {
      await updateAdjustmentByPkId(adjPk, {
        Status: piStatus === "succeeded" ? "Charged" : "Pending",
        Stripe_PaymentIntent_ID: pi.id,
        Stripe_Charge_ID: latestChargeId,
        Stripe_Error: "",
        Charged_At: piStatus === "succeeded" ? new Date().toISOString() : null,
        Updated_At: new Date().toISOString(),
      }).catch(() => {});
    }

    // Transaction insert (success)
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
      idkey,
      res_id: resId,
      description: formattedDescription,
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
      adjustmentPk: adjPk,
      idempotencyKey: idemKey,
    });
  } catch (err) {
    console.error("❌ CHARGE_ADJUSTMENT_FAILED", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
