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
//   CASPIO_ACCOUNT         = headspacetrivia
//
// Transactions (optional):
//   CASPIO_TXN_TABLE       = SIGMA_BAR3_Transactions
//
// Views (optional):
//   CASPIO_RES_BILLING_VIEW = SIGMA_VW_Res_Billing_Edit
//
// Adjustments (optional / new):
//   CASPIO_ADJ_TABLE        = BAR2_Reservation_Adjustments
//   CASPIO_ADJ_PK_FIELD     = PK_ID
//
// Reservation RES_ID lookup (optional / new):
//   CASPIO_RES_ID_FIELD     = RES_ID

function normalizeBase(url) {
  return String(url).replace(/\/+$/, "");
}

function caspioIntegrationBaseUrl() {
  const integration = process.env.CASPIO_INTEGRATION_URL;
  if (integration) return normalizeBase(integration);

  const acct = process.env.CASPIO_ACCOUNT;
  if (!acct) throw new Error("Missing CASPIO_INTEGRATION_URL (or CASPIO_ACCOUNT fallback)");
  return `https://${acct}.caspio.com`;
}

function caspioTokenUrl() {
  const tokenUrl = process.env.CASPIO_TOKEN_URL;
  if (tokenUrl) return tokenUrl;
  return `${caspioIntegrationBaseUrl()}/oauth/token`;
}

function basicAuthHeader() {
  const id = process.env.CASPIO_CLIENT_ID;
  const secret = process.env.CASPIO_CLIENT_SECRET;
  if (!id) throw new Error("Missing CASPIO_CLIENT_ID");
  if (!secret) throw new Error("Missing CASPIO_CLIENT_SECRET");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

function escapeWhereValue(v) {
  return String(v).replaceAll("'", "''");
}

function recordsUrl(table, version, qp) {
  const base = caspioIntegrationBaseUrl();
  const q = qp ? `?${qp}` : "";
  return `${base}/rest/${version}/tables/${encodeURIComponent(table)}/records${q}`;
}

function viewRecordsUrl(view, version, qp) {
  const base = caspioIntegrationBaseUrl();
  const q = qp ? `?${qp}` : "";
  return `${base}/rest/${version}/views/${encodeURIComponent(view)}/records${q}`;
}

async function fetchText(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  return { resp, text };
}

// small in-memory token cache
let cachedToken = null;
let cachedTokenExpMs = 0;

export async function getCaspioAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpMs) return cachedToken;

  const { resp, text } = await fetchText(caspioTokenUrl(), {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });

  if (!resp.ok) throw new Error(`Caspio token error ${resp.status}: ${text}`);

  const json = JSON.parse(text);
  if (!json.access_token) throw new Error("Caspio token response missing access_token");

  cachedToken = json.access_token;
  const expiresInSec = Number(json.expires_in || 900);
  cachedTokenExpMs = Date.now() + Math.max(0, (expiresInSec - 60)) * 1000;

  return cachedToken;
}

/**
 * Generic: find first record in a table by where clause.
 * Returns row object or null if not found.
 */
export async function findOneByWhere(table, whereClause) {
  if (!table) throw new Error("Missing table name");

  const qp = `q.where=${encodeURIComponent(whereClause)}&q.limit=1`;
  const accessToken = await getCaspioAccessToken();

  for (const version of ["v3", "v2"]) {
    const url = recordsUrl(table, version, qp);

    const { resp, text } = await fetchText(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (resp.status === 404) {
      // If Caspio returns a JSON error body, surface it
      if (text && text.trim().length > 0) {
        throw new Error(`Caspio GET 404 for ${table} (${version}) where [${whereClause}]: ${text}`);
      }
      continue;
    }

    if (!resp.ok) {
      throw new Error(
        `Caspio GET error ${resp.status} for ${table} (${version}) where [${whereClause}]: ${text}`
      );
    }

    const json = JSON.parse(text);
    return json?.Result?.[0] || null;
  }

  throw new Error(
    `Caspio GET 404 for ${table} (tried v3,v2). Most common causes: the table name is wrong OR it is not allowed in your Caspio REST API Profile.`
  );
}

/**
 * Generic: find first record in a VIEW by where clause.
 * Returns row object or null if not found.
 */
export async function findOneViewByWhere(view, whereClause) {
  if (!view) throw new Error("Missing view name");

  const qp = `q.where=${encodeURIComponent(whereClause)}&q.limit=1`;
  const accessToken = await getCaspioAccessToken();

  for (const version of ["v3", "v2"]) {
    const url = viewRecordsUrl(view, version, qp);

    const { resp, text } = await fetchText(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (resp.status === 404) {
      if (text && text.trim().length > 0) {
        throw new Error(`Caspio VIEW GET 404 for ${view} (${version}) where [${whereClause}]: ${text}`);
      }
      continue;
    }

    if (!resp.ok) {
      throw new Error(
        `Caspio VIEW GET error ${resp.status} for ${view} (${version}) where [${whereClause}]: ${text}`
      );
    }

    const json = JSON.parse(text);
    return json?.Result?.[0] || null;
  }

  throw new Error(
    `Caspio VIEW GET 404 for ${view} (tried v3,v2). Most common causes: view name is wrong OR not allowed in your REST API Profile.`
  );
}

/**
 * Convenience: read one row from the Billing/Edit view by IDKEY.
 * ENV:
 *   CASPIO_RES_BILLING_VIEW (defaults to SIGMA_VW_Res_Billing_Edit)
 */
export async function getResBillingEditViewRowByIdKey(idKey) {
  const view = process.env.CASPIO_RES_BILLING_VIEW || "SIGMA_VW_Res_Billing_Edit";
  const where = `IDKEY='${escapeWhereValue(idKey)}'`;
  return await findOneViewByWhere(view, where);
}

/**
 * Generic: insert record into a table. Returns parsed response when possible.
 */
export async function insertRecord(table, payload) {
  if (!table) throw new Error("Missing table name");

  const accessToken = await getCaspioAccessToken();

  for (const version of ["v3", "v2"]) {
    const url = recordsUrl(table, version, "");

    const { resp, text } = await fetchText(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (resp.status === 404) continue;
    if (!resp.ok) throw new Error(`Caspio INSERT error ${resp.status}: ${text}`);

    try {
      return text ? JSON.parse(text) : { ok: true };
    } catch {
      return { ok: true, raw: text };
    }
  }

  throw new Error("Caspio INSERT error 404: REST endpoint not found (check CASPIO_* env vars)");
}

/**
 * Generic: update records in any table by q.where (PUT).
 * Returns parsed response when possible.
 */
export async function updateRecordByWhere(table, whereClause, payload) {
  if (!table) throw new Error("Missing table name");

  const accessToken = await getCaspioAccessToken();

  for (const version of ["v3", "v2"]) {
    const qp = `q.where=${encodeURIComponent(whereClause)}`;
    const url = recordsUrl(table, version, qp);

    const { resp, text } = await fetchText(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (resp.status === 404) {
      // If body exists, it's a real error (ColumnNotFound etc.)
      if (text && text.trim().length > 0) {
        throw new Error(`Caspio update error ${resp.status} for ${table}: ${text}`);
      }
      continue;
    }

    if (!resp.ok) throw new Error(`Caspio update error ${resp.status} for ${table}: ${text}`);

    try {
      return text ? JSON.parse(text) : { ok: true };
    } catch {
      return { ok: true, raw: text };
    }
  }

  throw new Error("Caspio update error 404: REST endpoint not found (check CASPIO_* env vars)");
}

/**
 * Generic: find first record in any table by where clause (alias for clarity).
 */
export async function findOneByWhereInTable(table, whereClause) {
  return await findOneByWhere(table, whereClause);
}

/**
 * Transactions: insert transaction row only if RawEventId not already present.
 * This makes webhook processing idempotent.
 *
 * ENV:
 *   CASPIO_TXN_TABLE (defaults to SIGMA_BAR3_Transactions)
 */
export async function insertTransactionIfMissingByRawEventId(txnPayload) {
  const table = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
  const rawEventId = txnPayload?.RawEventId;

  if (!rawEventId) throw new Error("Transaction payload missing RawEventId");

  const where = `RawEventId='${escapeWhereValue(rawEventId)}'`;
  const existing = await findOneByWhere(table, where);
  if (existing) return { ok: true, skipped: true, reason: "already_exists" };

  const inserted = await insertRecord(table, txnPayload);
  return { ok: true, inserted };
}

export async function getReservationByIdKey(idKey) {
  const table = process.env.CASPIO_TABLE;
  if (!table) throw new Error("Missing CASPIO_TABLE");

  const keyField = process.env.CASPIO_KEY_FIELD || "IDKEY";
  const where = `${keyField}='${escapeWhereValue(idKey)}'`;
  const row = await findOneByWhere(table, where);

  if (!row) throw new Error(`No reservation found for ${where}`);
  return row;
}

/**
 * NEW: get reservation by RES_ID (or alternate field name).
 * ENV:
 *   CASPIO_RES_ID_FIELD (defaults to RES_ID)
 */
export async function getReservationByResId(resId) {
  const table = process.env.CASPIO_TABLE;
  if (!table) throw new Error("Missing CASPIO_TABLE");

  const resField = process.env.CASPIO_RES_ID_FIELD || "RES_ID";
  const where = `${resField}='${escapeWhereValue(resId)}'`;
  const row = await findOneByWhere(table, where);

  if (!row) throw new Error(`No reservation found for ${where}`);
  return row;
}

/**
 * Existing: update reservation by where clause (uses CASPIO_TABLE).
 */
export async function updateReservationByWhere(whereClause, payload) {
  const table = process.env.CASPIO_TABLE;
  if (!table) throw new Error("Missing CASPIO_TABLE");
  return await updateRecordByWhere(table, whereClause, payload);
}

// Convenience: update by IDKEY without relying on path-based endpoints
export function buildWhereForIdKey(idKey) {
  const keyField = process.env.CASPIO_KEY_FIELD || "IDKEY";
  return `${keyField}='${escapeWhereValue(idKey)}'`;
}

/**
 * NEW: build where clause for RES_ID (or alternate field).
 */
export function buildWhereForResId(resId) {
  const resField = process.env.CASPIO_RES_ID_FIELD || "RES_ID";
  return `${resField}='${escapeWhereValue(resId)}'`;
}

/**
 * NEW: Convenience to update Stripe-related fields by IDKEY.
 * Usage:
 *   await updateReservationStripeByIdKey(idKey, {
 *     Stripe_Customer_ID: "...",
 *     Stripe_PaymentMethod_ID: "...",
 *     Stripe_PaymentIntent_ID: "...",
 *   });
 */
export async function updateReservationStripeByIdKey(idKey, stripeFields) {
  const where = buildWhereForIdKey(idKey);
  return await updateReservationByWhere(where, stripeFields);
}

/**
 * NEW: Insert an adjustment record into adjustments table.
 * ENV:
 *   CASPIO_ADJ_TABLE (defaults to BAR2_Reservation_Adjustments)
 */
export async function insertAdjustment(payload) {
  const table = process.env.CASPIO_ADJ_TABLE || "BAR2_Reservation_Adjustments";
  return await insertRecord(table, payload);
}

/**
 * NEW: Update adjustment record by PK_ID (or alternate pk field).
 * ENV:
 *   CASPIO_ADJ_TABLE (defaults to BAR2_Reservation_Adjustments)
 *   CASPIO_ADJ_PK_FIELD (defaults to PK_ID)
 */
export async function updateAdjustmentByPkId(pkId, payload) {
  const table = process.env.CASPIO_ADJ_TABLE || "BAR2_Reservation_Adjustments";
  const pkField = process.env.CASPIO_ADJ_PK_FIELD || "PK_ID";
  const where = `${pkField}=${Number(pkId)}`;
  if (!Number.isFinite(Number(pkId))) throw new Error("updateAdjustmentByPkId requires numeric pkId");
  return await updateRecordByWhere(table, where, payload);
}

// Export escapeWhereValue too (useful in webhook scripts)
export { escapeWhereValue };
