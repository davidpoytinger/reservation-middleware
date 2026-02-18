// lib/caspio.js
//
// Caspio REST helper for SIGMA middleware (Next.js / Vercel).
// Named exports (ESM) so API routes can do:
//   import { insertRecord, getReservationByResId, ... } from "../../lib/caspio";
//
// Required env vars:
//   CASPIO_INTEGRATION_URL   e.g. https://c0xxxx.caspio.com
//   CASPIO_TOKEN_URL         e.g. https://c0xxxx.caspio.com/oauth/token
//   CASPIO_CLIENT_ID
//   CASPIO_CLIENT_SECRET
//
// Optional env vars:
//   CASPIO_TABLE             default: BAR2_Reservations_SIGMA
//   CASPIO_KEY_FIELD         default: IDKEY
//   CASPIO_RES_ID_FIELD      default: RES_ID
//   CASPIO_TXN_TABLE         default: SIGMA_BAR3_Transactions
//   CASPIO_TOTAL_RES_TABLE   default: SIGMA_BAR3_TOTAL_RES

function normalizeBase(url) {
  return String(url || "").replace(/\/+$/, "");
}

function integrationBase() {
  const v = process.env.CASPIO_INTEGRATION_URL;
  if (!v) throw new Error("Missing CASPIO_INTEGRATION_URL");
  return normalizeBase(v);
}

function tokenUrl() {
  const v = process.env.CASPIO_TOKEN_URL;
  if (!v) throw new Error("Missing CASPIO_TOKEN_URL");
  return v;
}

function clientId() {
  const v = process.env.CASPIO_CLIENT_ID;
  if (!v) throw new Error("Missing CASPIO_CLIENT_ID");
  return v;
}

function clientSecret() {
  const v = process.env.CASPIO_CLIENT_SECRET;
  if (!v) throw new Error("Missing CASPIO_CLIENT_SECRET");
  return v;
}

function defaultTable() {
  return process.env.CASPIO_TABLE || "BAR2_Reservations_SIGMA";
}

function keyField() {
  return process.env.CASPIO_KEY_FIELD || "IDKEY";
}

function resIdField() {
  return process.env.CASPIO_RES_ID_FIELD || "RES_ID";
}

function txnTable() {
  return process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
}

function totalResTable() {
  return process.env.CASPIO_TOTAL_RES_TABLE || "SIGMA_BAR3_TOTAL_RES";
}

function encodeWhere(where) {
  return encodeURIComponent(where);
}

export function escapeWhereValue(value) {
  // Escape single quotes for Caspio SQL-like where strings
  return String(value ?? "").replace(/'/g, "''");
}

// -------------------- Token cache --------------------
let cachedToken = null;
let cachedTokenExp = 0;

async function getCaspioAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExp - 30_000) return cachedToken;

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId());
  body.set("client_secret", clientSecret());

  const resp = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Caspio token error ${resp.status}: ${t}`);
  }

  const json = await resp.json();
  const accessToken = json?.access_token;
  const expiresIn = Number(json?.expires_in || 3600);

  if (!accessToken) throw new Error("Caspio token response missing access_token");

  cachedToken = accessToken;
  cachedTokenExp = now + expiresIn * 1000;
  return cachedToken;
}

async function caspioFetch(path, { method = "GET", headers = {}, body } = {}) {
  const token = await getCaspioAccessToken();
  const url = `${integrationBase()}${path}`;

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body,
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Caspio error ${resp.status}: ${t}`);
  }

  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await resp.json();
  return await resp.text();
}

// -------------------- Core table helpers --------------------
export async function listRecordsByWhere(table, where, limit = 100) {
  const q = `q.where=${encodeWhere(where)}&q.limit=${Number(limit)}`;
  const path = `/rest/v2/tables/${encodeURIComponent(table)}/records?${q}`;
  const json = await caspioFetch(path);
  const rows = json?.Result || json?.result || [];
  return Array.isArray(rows) ? rows : [];
}

export async function findOneByWhereInTable(table, where) {
  const rows = await listRecordsByWhere(table, where, 1);
  return rows[0] || null;
}

// Backward-friendly helper (default table)
export async function findOneByWhere(where) {
  return await findOneByWhereInTable(defaultTable(), where);
}

export async function insertRecord(table, payload) {
  const path = `/rest/v2/tables/${encodeURIComponent(table)}/records`;
  return await caspioFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateRecordByWhere(table, where, payload) {
  const q = `q.where=${encodeWhere(where)}`;
  const path = `/rest/v2/tables/${encodeURIComponent(table)}/records?${q}`;
  return await caspioFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// -------------------- Reservations --------------------
export function buildWhereForIdKey(idkey) {
  const safe = escapeWhereValue(idkey);
  return `${keyField()}='${safe}'`;
}

export async function getReservationByIdKey(idkey) {
  const where = buildWhereForIdKey(idkey);
  return await findOneByWhereInTable(defaultTable(), where);
}

export async function getReservationByResId(resId) {
  const safe = escapeWhereValue(resId);
  const where = `${resIdField()}='${safe}'`;
  return await findOneByWhereInTable(defaultTable(), where);
}

export async function updateReservationByWhere(where, payload) {
  return await updateRecordByWhere(defaultTable(), where, payload);
}
// ---- Optional view lookup used by Stripe webhook to enrich reservation email/branding ----
// Set this env var to your Caspio View name:
//   CASPIO_RES_BILLING_EDIT_VIEW=YOUR_VIEW_NAME
//
// Example: "SIGMA_VW_ResBillingEdit" (use your real view name)

function resBillingEditViewName() {
  const v = process.env.CASPIO_RES_BILLING_EDIT_VIEW;
  if (!v) throw new Error("Missing CASPIO_RES_BILLING_EDIT_VIEW");
  return v;
}

export async function getResBillingEditViewRowByIdKey(idkey) {
  const view = resBillingEditViewName();
  const safe = escapeWhereValue(idkey);
  const where = `IDKEY='${safe}'`;
  return await findOneByWhereInTable(view, where);
}

// -------------------- Transactions: idempotent insert --------------------
export async function insertTransactionIfMissingByRawEventId(txnPayload) {
  const table = txnTable();
  const txntype = String(txnPayload?.TxnType || "").toLowerCase().trim();

  // 0) Required event-id idempotency (Stripe retry safe)
  const rawEventId = txnPayload?.RawEventId;
  if (!rawEventId) throw new Error("Transaction payload missing RawEventId");

  const safeEvent = escapeWhereValue(rawEventId);
  {
    const where = `RawEventId='${safeEvent}'`;
    const existing = await findOneByWhereInTable(table, where).catch(() => null);
    if (existing) return { ok: true, skipped: true, reason: "raw_event_exists" };
  }

  // 1) Belt-and-suspenders dedupe by Stripe IDs
  const pi = txnPayload?.StripePaymentIntentId ? String(txnPayload.StripePaymentIntentId) : "";
  const ch = txnPayload?.StripeChargeId ? String(txnPayload.StripeChargeId) : "";
  const rf = txnPayload?.StripeRefundId ? String(txnPayload.StripeRefundId) : "";

  const clauses = [];

  if (txntype === "charge") {
    if (pi) clauses.push(`(TxnType='charge' AND StripePaymentIntentId='${escapeWhereValue(pi)}')`);
    if (ch) clauses.push(`(TxnType='charge' AND StripeChargeId='${escapeWhereValue(ch)}')`);
  } else if (txntype === "refund") {
    if (rf) clauses.push(`(TxnType='refund' AND StripeRefundId='${escapeWhereValue(rf)}')`);
    // backups (if refund id missing in some edge path)
    if (pi) clauses.push(`(TxnType='refund' AND StripePaymentIntentId='${escapeWhereValue(pi)}')`);
    if (ch) clauses.push(`(TxnType='refund' AND StripeChargeId='${escapeWhereValue(ch)}')`);
  }

  if (clauses.length) {
    const where = clauses.join(" OR ");
    const existing = await findOneByWhereInTable(table, where).catch(() => null);
    if (existing) return { ok: true, skipped: true, reason: "stripe_id_exists", existing };
  }

  // 2) Insert
  const inserted = await insertRecord(table, txnPayload);
  return { ok: true, inserted };
}

// -------------------- Rollup charged totals: SIGMA_BAR3_TOTAL_RES by IDKEY --------------------
export async function rollupTotalsForIdKey(idKey) {
  const tTable = txnTable();
  const rTable = totalResTable();
  const safeId = escapeWhereValue(idKey);

  // Pull txns for this IDKEY (cap 500)
  const txns = await listRecordsByWhere(tTable, `IDKEY='${safeId}'`, 500);

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const sums = txns.reduce(
    (a, t) => {
      const tt = String(t.TxnType || "").toLowerCase();
      if (tt !== "charge" && tt !== "refund") return a;

      a.base += toNum(t.Base_Amount);
      a.grat += toNum(t.Auto_Gratuity);
      a.tax += toNum(t.Tax);
      a.fee += toNum(t.Fee);
      a.amount += toNum(t.Amount);
      return a;
    },
    { base: 0, grat: 0, tax: 0, fee: 0, amount: 0 }
  );

  // If you prefer Amount to be strictly the sum of components, uncomment:
  // sums.amount = sums.base + sums.grat + sums.tax + sums.fee;

  const payload = {
    IDKEY: String(idKey),

    Total_Charged_Base_Amount: Number(sums.base.toFixed(2)),
    Total_Charged_Auto_Gratuity: Number(sums.grat.toFixed(2)),
    Total_Charged_Tax: Number(sums.tax.toFixed(2)),
    Total_Charged_Fee: Number(sums.fee.toFixed(2)),
    Total_Charged_Amount: Number(sums.amount.toFixed(2)),

    UpdatedAt: new Date().toISOString(),
  };

  const existing = await findOneByWhereInTable(rTable, `IDKEY='${safeId}'`).catch(() => null);

  if (existing) {
    await updateRecordByWhere(rTable, `IDKEY='${safeId}'`, payload);
    return { ok: true, action: "updated", payload };
  } else {
    await insertRecord(rTable, payload);
    return { ok: true, action: "inserted", payload };
  }
}
