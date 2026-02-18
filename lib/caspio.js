// lib/caspio.js
//
// Caspio REST helper that works in environments where:
// - GET by q.where works
// - PUT by q.where works
// - BUT path-based PUT /records/{id} does NOT exist (404)
//
// ENV VARS (recommended):
//   CASPIO_INTEGRATION_URL = https://c0gfs257.caspio.com
//   CASPIO_TOKEN_URL       = https://c0gfs257.caspio.com/oauth/token
//   CASPIO_CLIENT_ID
//   CASPIO_CLIENT_SECRET
//   CASPIO_TABLE           = BAR2_Reservations_SIGMA
//   CASPIO_KEY_FIELD       = IDKEY
//
// Optional fallback:
//
//   CASPIO_VW_ACTIVE_SESSIONS = SIGMA_VW_Active_Sessions_Manage
//   CASPIO_RESERVATION_VIEW   = SIGMA_VW_Reservation_Billing_Edit
//   CASPIO_PRICING_VIEW      = SIGMA_VW_Pricing
//
// Adjustments (optional):
//   CASPIO_ADJ_TABLE        = BAR2_Reservation_Adjustments
//   CASPIO_ADJ_PK_FIELD     = PK_ID
//
// Reservation RES_ID lookup (optional):
//   CASPIO_RES_ID_FIELD     = RES_ID

function normalizeBase(url) {
  return String(url).replace(/\/+$/, "");
}

function caspioIntegrationBaseUrl() {
  const integration = process.env.CASPIO_INTEGRATION_URL;
  if (!integration) throw new Error("Missing CASPIO_INTEGRATION_URL");
  return normalizeBase(integration);
}

function caspioTokenUrl() {
  const tokenUrl = process.env.CASPIO_TOKEN_URL;
  if (!tokenUrl) throw new Error("Missing CASPIO_TOKEN_URL");
  return tokenUrl;
}

function caspioClientId() {
  const v = process.env.CASPIO_CLIENT_ID;
  if (!v) throw new Error("Missing CASPIO_CLIENT_ID");
  return v;
}

function caspioClientSecret() {
  const v = process.env.CASPIO_CLIENT_SECRET;
  if (!v) throw new Error("Missing CASPIO_CLIENT_SECRET");
  return v;
}

let cachedToken = null;
let cachedTokenExp = 0;

export async function getCaspioAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExp - 30_000) return cachedToken;

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", caspioClientId());
  body.set("client_secret", caspioClientSecret());

  const resp = await fetch(caspioTokenUrl(), {
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
  return accessToken;
}

function encodeWhere(where) {
  return encodeURIComponent(where);
}

function escapeWhereValue(value) {
  return String(value).replace(/'/g, "''");
}

async function caspioFetch(path, { method = "GET", headers = {}, body } = {}) {
  const token = await getCaspioAccessToken();

  const url = `${caspioIntegrationBaseUrl()}${path}`;
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

function defaultTable() {
  return process.env.CASPIO_TABLE || "BAR2_Reservations_SIGMA";
}

function keyField() {
  return process.env.CASPIO_KEY_FIELD || "IDKEY";
}

export async function findOneByWhere(where) {
  const table = defaultTable();
  return await findOneByWhereInTable(table, where);
}

export async function listRecordsByWhere(table, where, limit = 100) {
  const q = `q.where=${encodeWhere(where)}&q.limit=${Number(limit)}`;
  const path = `/rest/v2/tables/${encodeURIComponent(table)}/records?${q}`;
  const json = await caspioFetch(path);
  const rows = json?.Result || json?.result || [];
  return Array.isArray(rows) ? rows : [];
}

export async function findOneViewByWhere(viewName, where) {
  const rows = await listViewRecordsByWhere(viewName, where, 1);
  return rows[0] || null;
}

export async function listViewRecordsByWhere(viewName, where, limit = 100) {
  const q = `q.where=${encodeWhere(where)}&q.limit=${Number(limit)}`;
  const path = `/rest/v2/views/${encodeURIComponent(viewName)}/records?${q}`;
  const json = await caspioFetch(path);
  const rows = json?.Result || json?.result || [];
  return Array.isArray(rows) ? rows : [];
}

export async function getResBillingEditViewRowByIdKey(idkey) {
  const view = process.env.CASPIO_RESERVATION_VIEW || "SIGMA_VW_Reservation_Billing_Edit";
  const safe = escapeWhereValue(idkey);
  return await findOneViewByWhere(view, `${keyField()}='${safe}'`);
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

export async function findOneByWhereInTable(table, where) {
  const rows = await listRecordsByWhere(table, where, 1);
  return rows[0] || null;
}

/**
 * Insert txn row if RawEventId is not already present (idempotency).
 * Uses SIGMA_BAR3_Transactions by default.
 */
export async function insertTransactionIfMissingByRawEventId(payload) {
  const txnTable = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
  const raw = payload?.RawEventId;
  if (!raw) throw new Error("insertTransactionIfMissingByRawEventId requires RawEventId");

  const safe = escapeWhereValue(raw);
  const existing = await findOneByWhereInTable(txnTable, `RawEventId='${safe}'`).catch(() => null);
  if (existing) return { ok: true, already: true, existing };

  await insertRecord(txnTable, payload);
  return { ok: true, inserted: true };
}

export async function listTransactionsByIdKey(idkey) {
  const txnTable = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
  const safe = escapeWhereValue(idkey);
  return await listRecordsByWhere(txnTable, `IDKEY='${safe}'`, 200);
}

export async function listTransactionsByChargeId(chargeId) {
  const txnTable = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
  const safe = escapeWhereValue(chargeId);
  return await listRecordsByWhere(txnTable, `StripeChargeId='${safe}'`, 50);
}

export async function getReservationByIdKey(idkey) {
  const safe = escapeWhereValue(idkey);
  return await findOneByWhere(`${keyField()}='${safe}'`);
}

export async function getReservationByResId(resId) {
  const table = defaultTable();
  const resIdField = process.env.CASPIO_RES_ID_FIELD || "RES_ID";
  const safe = escapeWhereValue(resId);
  return await findOneByWhereInTable(table, `${resIdField}='${safe}'`);
}

export async function updateReservationByWhere(where, payload) {
  const table = defaultTable();
  return await updateRecordByWhere(table, where, payload);
}

export function buildWhereForIdKey(idkey) {
  const safe = escapeWhereValue(idkey);
  return `${keyField()}='${safe}'`;
}

export async function updateReservationStripeByIdKey(idkey, payload) {
  const where = buildWhereForIdKey(idkey);
  return await updateReservationByWhere(where, payload);
}

export async function insertAdjustment(payload) {
  const table = process.env.CASPIO_ADJ_TABLE || "BAR2_Reservation_Adjustments";
  return await insertRecord(table, payload);
}

export async function updateAdjustmentByPkId(pkId, payload) {
  const table = process.env.CASPIO_ADJ_TABLE || "BAR2_Reservation_Adjustments";
  const pkField = process.env.CASPIO_ADJ_PK_FIELD || "PK_ID";
  const where = `${pkField}=${Number(pkId)}`;
  if (!Number.isFinite(Number(pkId))) throw new Error("updateAdjustmentByPkId requires numeric pkId");
  return await updateRecordByWhere(table, where, payload);
}

// Export escapeWhereValue too (useful in webhook scripts)
export { escapeWhereValue };

// ------------------------------------------------------------
// Rollup totals into SIGMA_BAR3_TOTAL_RES by IDKEY
// Sums ONLY TxnType in ("charge","refund") so "log"/"error" rows won't affect totals.
// ------------------------------------------------------------
export async function rollupTotalsForIdKey(idKey) {
  const txnTable = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
  const rollupTable = process.env.CASPIO_TOTAL_RES_TABLE || "SIGMA_BAR3_TOTAL_RES";
  const safeId = escapeWhereValue(idKey);

  // Pull all txns for this IDKEY (cap to 500; increase if needed)
  const txns = await listRecordsByWhere(txnTable, `IDKEY='${safeId}'`, 500);

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

  // If you want Amount to be strictly the sum of components, uncomment:
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

  const existing = await findOneByWhereInTable(rollupTable, `IDKEY='${safeId}'`).catch(() => null);

  if (existing) {
    await updateRecordByWhere(rollupTable, `IDKEY='${safeId}'`, payload);
    return { ok: true, action: "updated", ...payload };
  } else {
    await insertRecord(rollupTable, payload);
    return { ok: true, action: "inserted", ...payload };
  }
}
