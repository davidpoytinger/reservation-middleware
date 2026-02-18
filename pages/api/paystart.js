// pages/api/paystart.js
//
// Caspio -> /api/paystart?idkey=@IDKEY
// Creates a Stripe Checkout Session and redirects to Stripe.
//
// ✅ Passes BOTH IDKEY and RES_ID through Stripe + success/cancel URLs.
// ✅ Ensures a Stripe Customer exists and is used for Checkout
// ✅ Uses setup_future_usage=off_session so the payment method can be reused later
// ❌ Does NOT use payment_method_collection (not allowed for one-time payment Checkout)
//
// ✅ UPDATED: redirects to barresv5custmanage.html (not after.html)

import Stripe from "stripe";
import {
  getReservationByIdKey,
  updateReservationByWhere,
  buildWhereForIdKey,
} from "../../lib/caspio";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// Deterministic short hash (not crypto, just stable)
function shortHash(input) {
  const s = String(input || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).slice(0, 12);
}

// Keep idempotency keys ASCII + <=255 chars.
function idemKeyForCheckout({ idkey, amountCents, resId }) {
  const base = `paystart|${idkey}|${resId || ""}|${amountCents}`;
  return `paystart_${shortHash(base)}`.slice(0, 255);
}

function setCors(res, origin) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://www.reservebarsandrec.com";
  const allowOrigin = origin && origin === allowed ? origin : allowed;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  try {
    const idkey = oneLine(req.query.idkey);
    if (!idkey) return res.status(400).send("Missing idkey");

    // 1) Pull reservation data
    const reservation = await getReservationByIdKey(idkey);

    const customerEmail = oneLine(reservation.Email);
    const bookingFeeAmount = Number(reservation.BookingFeeAmount);

    // ---- 4-part charge breakdown (Base / Auto Gratuity / Tax / Fee) ----
    // Optional query params:
    //   base_amount, auto_gratuity, tax_amount, fee_amount  (all in dollars)
    // If none provided, defaults to Fee-only = BookingFeeAmount.
    function num2(v) {
      const n = Number(v);
      return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
    }

    const q = req.query || {};
    let baseAmt = num2(q.base_amount);
    let gratAmt = num2(q.auto_gratuity);
    let taxAmt = num2(q.tax_amount);
    let feeAmt = num2(q.fee_amount);

    const anyBreakdown = baseAmt != null || gratAmt != null || taxAmt != null || feeAmt != null;

    if (!anyBreakdown) {
      baseAmt = 0;
      gratAmt = 0;
      taxAmt = 0;
      feeAmt = Number(bookingFeeAmount);
    }

    const totalChargeAmount = Number(
      ((baseAmt ?? 0) + (gratAmt ?? 0) + (taxAmt ?? 0) + (feeAmt ?? 0)).toFixed(2)
    );

    const sessionsTitle = oneLine(reservation.Sessions_Title);
    const peopleText = oneLine(reservation.People_Text);
    const chargeTypeRaw = oneLine(reservation.Charge_Type);

    const resIdRaw =
      reservation.RES_ID ??
      reservation.Res_ID ??
      reservation.res_id ??
      reservation.resId ??
      "";

    const resId = oneLine(resIdRaw);

    if (!customerEmail) return res.status(400).send("Missing Email on reservation");
    if (!totalChargeAmount || totalChargeAmount <= 0) {
      return res.status(400).send("Missing/invalid charge amount (breakdown or BookingFeeAmount)");
    }

    const unitAmount = Math.round(totalChargeAmount * 100);
    const displayChargeType = chargeTypeRaw || "Booking Fee";
    const belowAmountText = [sessionsTitle, peopleText].filter(Boolean).join("  |  ").slice(0, 500);

    const sharedMetadata = {
      IDKEY: String(idkey),
      RES_ID: resId || "",
      reservation_id: String(idkey),
      purpose: "booking_fee",
      Charge_Type: displayChargeType,
      Sessions_Title: sessionsTitle || "",
      People_Text: peopleText || "",

      // 4-part breakdown for webhook -> SIGMA_BAR3_Transactions
      base_amount: String(baseAmt ?? 0),
      grat_amount: String(gratAmt ?? 0),
      tax_amount: String(taxAmt ?? 0),
      fee_amount: String(feeAmt ?? 0),
      total_amount: String(totalChargeAmount),
    };

    const idemKey = idemKeyForCheckout({
      idkey,
      amountCents: unitAmount,
      resId,
    });

    // 2) Ensure Stripe Customer exists
    let stripeCustomerId = oneLine(reservation.StripeCustomerId);
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: customerEmail,
        metadata: {
          IDKEY: String(idkey),
          RES_ID: String(resId || ""),
        },
      });

      stripeCustomerId = customer.id;

      // Save StripeCustomerId back to Caspio (resilient)
      const where = buildWhereForIdKey(idkey);
      await updateReservationByWhere(where, {
        StripeCustomerId: stripeCustomerId,
        UpdatedAt: new Date().toISOString(),
      }).catch(() => {});
    }

    // 3) Create Checkout Session
    // ✅ UPDATED redirect pages:
    const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://www.reservebarsandrec.com";
    const successUrl = `${allowedOrigin}/barresv5custmanage.html?idkey=${encodeURIComponent(
      idkey
    )}&res_id=${encodeURIComponent(resId || "")}`;
    const cancelUrl = `${allowedOrigin}/barresv5custmanage.html?idkey=${encodeURIComponent(
      idkey
    )}&res_id=${encodeURIComponent(resId || "")}`;

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer: stripeCustomerId,

        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: displayChargeType,
                description: belowAmountText || undefined,
              },
              unit_amount: unitAmount,
            },
            quantity: 1,
          },
        ],

        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: sharedMetadata,
        },
        metadata: sharedMetadata,

        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      { idempotencyKey: idemKey }
    );

    // Save StripeCheckoutSessionId + StripePaymentIntentId on reservation (best-effort)
    const where = buildWhereForIdKey(idkey);
    await updateReservationByWhere(where, {
      StripeCheckoutSessionId: session?.id || null,
      StripePaymentIntentId: session?.payment_intent || null,
      UpdatedAt: new Date().toISOString(),
    }).catch(() => {});

    // 4) Redirect user to Stripe Checkout
    return res.redirect(303, session.url);
  } catch (err) {
    console.error("PAYSTART_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Server error");
  }
}
