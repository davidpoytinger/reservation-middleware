// lib/caspio.js
export async function insertTransactionIfMissingByRawEventId(txnPayload) {
  const table = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";

  const txntype = String(txnPayload?.TxnType || "").toLowerCase().trim();

  // ---------
  // 0) Required event-id idempotency (Stripe retry safe)
  // ---------
  const rawEventId = txnPayload?.RawEventId;
  if (!rawEventId) throw new Error("Transaction payload missing RawEventId");

  const safeEvent = escapeWhereValue(rawEventId);
  {
    const where = `RawEventId='${safeEvent}'`;
    const existing = await findOneByWhere(table, where).catch(() => null);
    if (existing) return { ok: true, skipped: true, reason: "raw_event_exists" };
  }

  // ---------
  // 1) Belt-and-suspenders dedupe by Stripe IDs
  //    (prevents duplicates across different Stripe event types)
  // ---------
  const pi = txnPayload?.StripePaymentIntentId ? String(txnPayload.StripePaymentIntentId) : "";
  const ch = txnPayload?.StripeChargeId ? String(txnPayload.StripeChargeId) : "";
  const rf = txnPayload?.StripeRefundId ? String(txnPayload.StripeRefundId) : "";

  // Only run these if we have relevant Stripe identifiers
  const clauses = [];

  if (txntype === "charge") {
    if (pi) clauses.push(`(TxnType='charge' AND StripePaymentIntentId='${escapeWhereValue(pi)}')`);
    if (ch) clauses.push(`(TxnType='charge' AND StripeChargeId='${escapeWhereValue(ch)}')`);
  } else if (txntype === "refund") {
    if (rf) clauses.push(`(TxnType='refund' AND StripeRefundId='${escapeWhereValue(rf)}')`);
    // backups (in case refund id missing in some edge path)
    if (pi) clauses.push(`(TxnType='refund' AND StripePaymentIntentId='${escapeWhereValue(pi)}')`);
    if (ch) clauses.push(`(TxnType='refund' AND StripeChargeId='${escapeWhereValue(ch)}')`);
  }

  if (clauses.length) {
    const where = clauses.join(" OR ");
    const existing = await findOneByWhere(table, where).catch(() => null);
    if (existing) {
      return { ok: true, skipped: true, reason: "stripe_id_exists", existing };
    }
  }

  // ---------
  // 2) Insert
  // ---------
  const inserted = await insertRecord(table, txnPayload);
  return { ok: true, inserted };
}
