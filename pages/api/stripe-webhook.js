import Stripe from "stripe";
import {
  updateReservationByWhere,
  insertTransactionIfMissingByRawEventId,
  getReservationByIdKey,
  getResBillingEditViewRowByIdKey,
  rollupTotalsForIdKey,
} from "../../lib/caspio";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function escapeWhereValue(v) {
  return String(v ?? "").replaceAll("'", "''");
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function dollarsFromCents(cents) {
  return typeof cents === "number" ? Number((cents / 100).toFixed(2)) : null;
}

function n2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

/**
 * If Caspio responds with ColumnNotFound / "do not exist", drop those fields and retry once.
 */
async function updateReservationResilient(where, payload) {
  try {
    return await updateReservationByWhere(where, payload);
  } catch (err) {
    const msg = String(err?.message || "");
    if (!/ColumnNotFound/i.test(msg) && !/do not exist/i.test(msg)) throw err;

    const after = msg.split("do not exist:")[1] || "";
    const missing = [];
    for (const m of after.matchAll(/'([^']+)'/g)) missing.push(m[1]);
    if (!missing.length) throw err;

    const trimmed = { ...payload };
    for (const f of missing) delete trimmed[f];
    if (Object.keys(trimmed).length === 0) throw err;

    console.warn("⚠️ Caspio ColumnNotFound. Retrying without fields:", missing);
    return await updateReservationByWhere(where, trimmed);
  }
}

function getIdKeyFromMetadata(meta) {
  return meta?.IDKEY || meta?.reservation_id || meta?.idkey || meta?.IdKey || null;
}

function getResIdFromMetadata(meta) {
  return meta?.RES_ID || meta?.res_id || meta?.Res_ID || null;
}

// Safely read Confirmation_Number from reservation row
function getConfirmationNumberFromReservationRow(row) {
  return row?.Confirmation_Number || row?.ConfirmationNumber || row?.CONFIRMATION_NUMBER || null;
}

/**
 * Parse 4-part breakdown from Stripe metadata.
 * Expected keys: base_amount, grat_amount, tax_amount, fee_amount (strings)
 * Fallback: Fee-only = totalAmountDollars (e.g., booking fee legacy)
 */
function parseBreakdown(meta, totalAmountDollars) {
  const hasAny =
    meta?.base_amount != null ||
    meta?.grat_amount != null ||
    meta?.tax_amount != null ||
    meta?.fee_amount != null;

  if (hasAny) {
    const base = n2(meta?.base_amount);
    const grat = n2(meta?.grat_amount);
    const tax = n2(meta?.tax_amount);
    const fee = n2(meta?.fee_amount);
    const amount = n2(base + grat + tax + fee);
    return { base, grat, tax, fee, amount };
  }

  const total = n2(totalAmountDollars);
  return { base: 0, grat: 0, tax: 0, fee: total, amount: total };
}

async function safeRollup(idkey) {
  try {
    await rollupTotalsForIdKey(String(idkey));
  } catch (e) {
    console.warn("⚠️ ROLLUP_FAILED (non-blocking)", e?.message || e);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Stripe signature verification failed:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err?.message || "bad signature"}`);
  }

  try {
    // Cache reservation row per webhook execution
    let reservationCache = null;

    async function getReservationCached(idkey) {
      if (reservationCache && reservationCache.IDKEY === idkey) return reservationCache;
      const row = await getReservationByIdKey(idkey).catch(() => null);
      reservationCache = row ? { ...row, IDKEY: idkey } : { IDKEY: idkey };
      return row;
    }

    // ------------------------------------------------------------
    // 1) CHECKOUT COMPLETED  (ONLY source for checkout payments)
    // ------------------------------------------------------------
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const idkey = getIdKeyFromMetadata(session?.metadata);
      if (!idkey) return res.status(200).json({ received: true });

      const metaChargeType = session?.metadata?.Charge_Type || null;
      const metaSessionsTitle = session?.metadata?.Sessions_Title || null;
      const metaPeopleText = session?.metadata?.People_Text || null;

      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["customer", "payment_intent"],
      });

      let paymentIntent = fullSession.payment_intent;
      if (typeof paymentIntent === "string") {
        paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent, {
          expand: ["payment_method", "charges.data.payment_method_details"],
        });
      }

      const charge = paymentIntent?.charges?.data?.[0];
      const card =
        charge?.payment_method_details?.card ||
        (typeof paymentIntent?.payment_method !== "string" ? paymentIntent?.payment_method?.card : null);

      const amountDollars = dollarsFromCents(paymentIntent?.amount_received ?? paymentIntent?.amount ?? null);
      const currency = paymentIntent?.currency?.toLowerCase() || "usd";

      const paidAtUnix =
        charge?.created || paymentIntent?.created || fullSession.created || Math.floor(Date.now() / 1000);
      const paidAtIso = new Date(paidAtUnix * 1000).toISOString();

      const stripeCustomerId =
        typeof fullSession.customer === "string" ? fullSession.customer : fullSession.customer?.id || null;

      const stripePaymentMethodId =
        typeof paymentIntent?.payment_method === "string"
          ? paymentIntent.payment_method
          : paymentIntent?.payment_method?.id || charge?.payment_method || null;

      const where = `IDKEY='${escapeWhereValue(idkey)}'`;

      // VIEW LOOKUP (non-blocking)
      let viewRow = null;
      try {
        viewRow = await getResBillingEditViewRowByIdKey(idkey);
      } catch (e) {
        console.warn("⚠️ VIEW_LOOKUP_FAILED (non-blocking)", e?.message || e);
      }

      // Reservation update payload (keep your existing behavior)
      const payload = {
        BookingFeePaidAt: paidAtIso,
        StripeCheckoutSessionId: fullSession.id,
        StripePaymentIntentId: paymentIntent?.id || null,
        StripeCustomerId: stripeCustomerId,
        StripePaymentMethodId: stripePaymentMethodId,
        Payment_processor: "Stripe",
        Mode: fullSession.livemode ? "live" : "test",
        Status: "Booked",
        Payment_service: "Checkout",
        Card_brand: card?.brand || null,
        Card_number_masked: card?.last4 ? `**** **** **** ${card.last4}` : null,
        Card_expiration: card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null,
        Transaction_ID: paymentIntent?.id || null,
        Transaction_date: paidAtIso,
      };

      if (metaChargeType) payload.Charge_Type = metaChargeType;
      if (metaSessionsTitle) payload.Sessions_Title = metaSessionsTitle;
      if (metaPeopleText) payload.People_Text = metaPeopleText;

      if (viewRow) {
        if (viewRow.BAR2_Email_Design_Email_Content) {
          const maxLen = 64000;
          const val = String(viewRow.BAR2_Email_Design_Email_Content);
          payload.Email_Design = val.length > maxLen ? val.slice(0, maxLen) : val;
        }
        payload.Logo_Graphic_Email_String = viewRow.GEN_Business_Units_Logo_Graphic_Email_String || null;
        payload.Units_DBA = viewRow.GEN_Business_Units_DBA || null;
        payload.Sessions_Title = viewRow.BAR2_Sessions_Title || payload.Sessions_Title || null;
        payload.Event_Email_Preheader = viewRow.GEN_Business_Units_Event_Email_Preheader || null;
        payload.Primary_Color_1 = viewRow.GEN_Business_Units_Primary_Color_1 || null;
        payload.Primary_Color_2 = viewRow.GEN_Business_Units_Primary_Color_2 || null;
        payload.Facility = viewRow.GEN_Business_Units_Facility || null;
      }

      await updateReservationResilient(where, payload);

      // Pull reservation once for Charge_Type fallback + Confirmation_Number
      const reservationRow = await getReservationCached(idkey);
      const confirmationNumber = getConfirmationNumberFromReservationRow(reservationRow);

      // 4-part breakdown for ledger insert
      const breakdown = parseBreakdown(
        paymentIntent?.metadata || fullSession?.metadata || session?.metadata || {},
        amountDollars
      );

      // Transaction insert (now includes components + confirmation)
      let reservationChargeType = metaChargeType;
      if (!reservationChargeType) reservationChargeType = reservationRow?.Charge_Type || "booking_fee";

      const txnPayload = {
        IDKEY: String(idkey),
        TxnType: "charge",

        Base_Amount: breakdown.base,
        Auto_Gratuity: breakdown.grat,
        Tax: breakdown.tax,
        Fee: breakdown.fee,
        Amount: breakdown.amount,

        Currency: currency,
        PaymentStatus: "PaidBookingFee",
        Status: paymentIntent?.status || "succeeded",

        StripeCheckoutSessionId: fullSession.id,
        StripePaymentIntentId: paymentIntent?.id || null,
        StripeChargeId: charge?.id || null,
        StripeCustomerId: stripeCustomerId,
        StripePaymentMethodId: stripePaymentMethodId,

        RES_ID: getResIdFromMetadata(session?.metadata) || getResIdFromMetadata(paymentIntent?.metadata) || null,
        Charge_Type: reservationChargeType,
        Description: reservationChargeType,

        Confirmation_Number: confirmationNumber,

        RawEventId: String(event.id),
        Transaction_date: paidAtIso,
        CreatedAt: new Date().toISOString(),
      };

      await insertTransactionIfMissingByRawEventId(txnPayload).catch((e) =>
        console.error("⚠️ TXN_INSERT_FAILED", e?.message || e)
      );

      await safeRollup(idkey);

      return res.status(200).json({ received: true });
    }

    // ------------------------------------------------------------
    // 2) PAYMENT INTENT SUCCEEDED (ONLY for off-session charge tool)
    // ------------------------------------------------------------
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;

      // ✅ Gate: ONLY log off-session charge tool payments
      const source = String(pi?.metadata?.source || "").toLowerCase();
      if (source !== "off_session" && source !== "off-session") {
        return res.status(200).json({ received: true, skipped: "not_off_session" });
      }

      const idkey = getIdKeyFromMetadata(pi?.metadata);
      if (!idkey) return res.status(200).json({ received: true });

      const piFull = await stripe.paymentIntents.retrieve(pi.id, {
        expand: ["payment_method", "charges.data.payment_method_details"],
      });

      const charge = piFull?.charges?.data?.[0];
      const card =
        charge?.payment_method_details?.card ||
        (typeof piFull?.payment_method !== "string" ? piFull?.payment_method?.card : null);

      const amountDollars = dollarsFromCents(piFull?.amount_received ?? piFull?.amount ?? null);
      const currency = piFull?.currency?.toLowerCase() || "usd";
      const createdIso = new Date((piFull?.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();

      const stripeCustomerId = piFull?.customer || null;
      const stripePaymentMethodId =
        typeof piFull?.payment_method === "string"
          ? piFull.payment_method
          : piFull?.payment_method?.id || charge?.payment_method || null;

      const chargeType = piFull?.metadata?.Charge_Type || "supplemental_charge";
      const description = piFull?.metadata?.Description || chargeType;

      // Confirmation_Number
      const reservationRow = await getReservationCached(idkey);
      const confirmationNumber = getConfirmationNumberFromReservationRow(reservationRow);

      const breakdown = parseBreakdown(piFull?.metadata || {}, amountDollars);

      const txnPayload = {
        IDKEY: String(idkey),
        TxnType: "charge",

        Base_Amount: breakdown.base,
        Auto_Gratuity: breakdown.grat,
        Tax: breakdown.tax,
        Fee: breakdown.fee,
        Amount: breakdown.amount,

        Currency: currency,
        PaymentStatus: "Paid",
        Status: piFull?.status || "succeeded",

        StripeCheckoutSessionId: null,
        StripePaymentIntentId: piFull?.id || null,
        StripeChargeId: charge?.id || null,
        StripeCustomerId: stripeCustomerId,
        StripePaymentMethodId: stripePaymentMethodId,

        Charge_Type: chargeType,
        Description: description,

        Confirmation_Number: confirmationNumber,

        // Optional: store card snapshot too (non-critical)
        Card_brand: card?.brand || null,
        Card_number_masked: card?.last4 ? `**** **** **** ${card.last4}` : null,
        Card_expiration: card?.exp_month && card?.exp_year ? `${card.exp_month}/${card.exp_year}` : null,

        RawEventId: String(event.id),
        Transaction_date: createdIso,
        CreatedAt: new Date().toISOString(),
      };

      await insertTransactionIfMissingByRawEventId(txnPayload).catch((e) =>
        console.error("⚠️ TXN_INSERT_FAILED", e?.message || e)
      );

      await safeRollup(idkey);

      return res.status(200).json({ received: true });
    }

    // ------------------------------------------------------------
    // 3) REFUNDS (create/update) → insert negative txn rows
    // ------------------------------------------------------------
    if (event.type === "refund.created" || event.type === "refund.updated") {
      const refund = event.data.object;

      const chargeId = refund?.charge || null;
      if (!chargeId) return res.status(200).json({ received: true });

      const charge = await stripe.charges.retrieve(chargeId);
      const paymentIntentId = charge?.payment_intent || null;

      let pi = null;
      if (paymentIntentId) {
        pi = await stripe.paymentIntents.retrieve(paymentIntentId).catch(() => null);
      }

      const idkey = getIdKeyFromMetadata(pi?.metadata);
      if (!idkey) return res.status(200).json({ received: true });

      const amountDollars = dollarsFromCents(refund?.amount ?? null);
      const currency = refund?.currency?.toLowerCase() || "usd";
      const createdIso = new Date((refund?.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();

      const chargeType = pi?.metadata?.Charge_Type || "refund";
      const description = `Refund - ${chargeType}`;

      // Confirmation_Number
      const reservationRow = await getReservationCached(idkey);
      const confirmationNumber = getConfirmationNumberFromReservationRow(reservationRow);

      // Pro-rate refund across components (based on original breakdown)
      const original = parseBreakdown(pi?.metadata || {}, null);
      const refundTotal = n2(amountDollars);
      const originalTotal = n2(original.amount);
      const ratio = originalTotal > 0 ? Math.min(1, refundTotal / originalTotal) : 1;

      const rb = {
        base: n2(original.base * ratio),
        grat: n2(original.grat * ratio),
        tax: n2(original.tax * ratio),
        fee: n2(original.fee * ratio),
      };

      const txnPayload = {
        IDKEY: String(idkey),
        TxnType: "refund",

        Base_Amount: -Math.abs(rb.base),
        Auto_Gratuity: -Math.abs(rb.grat),
        Tax: -Math.abs(rb.tax),
        Fee: -Math.abs(rb.fee),
        Amount: typeof amountDollars === "number" ? -Math.abs(refundTotal) : null,

        Currency: currency,
        PaymentStatus: "Refunded",
        Status: refund?.status || "succeeded",

        StripeCheckoutSessionId: null,
        StripePaymentIntentId: paymentIntentId || null,
        StripeChargeId: chargeId,
        StripeRefundId: refund?.id || null,
        ParentStripeChargeId: chargeId,
        StripeCustomerId: charge?.customer || null,

        Charge_Type: chargeType,
        Description: description,

        Confirmation_Number: confirmationNumber,

        RawEventId: String(event.id),
        Transaction_date: createdIso,
        CreatedAt: new Date().toISOString(),
      };

      await insertTransactionIfMissingByRawEventId(txnPayload).catch((e) =>
        console.error("⚠️ TXN_INSERT_FAILED", e?.message || e)
      );

      await safeRollup(idkey);

      return res.status(200).json({ received: true });
    }

    // Default: ACK everything else
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ WEBHOOK_FAILED", err?.message || err);

    // Keep your current behavior: 200 so Stripe doesn't retry endlessly
    return res.status(200).json({ received: true });
  }
}
