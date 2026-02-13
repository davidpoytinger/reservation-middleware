// pages/api/sigma-rollup-total-res.js

/**
 * ENV VARS REQUIRED
 * CASPIO_BASE_URL=https://c0gfs257.caspio.com
 * CASPIO_CLIENT_ID=...
 * CASPIO_CLIENT_SECRET=...
 * (optional) CASPIO_AUTH_TOKEN_URL=https://c0gfs257.caspio.com/oauth/token
 * SIGMA_WEBHOOK_SECRET=...
 */

// ---- BAR2_Reservations_SIGMA line item structure ----
const SOURCE_TABLE = "BAR2_Reservations_SIGMA";
const TYPE_FIELD = "Type";              // field in BAR2_Reservations_SIGMA
const RES_ID_FIELD = "RES_ID";          // field in BAR2_Reservations_SIGMA
const LINE_TOTAL_FIELD = "Total";       // numeric field to sum

const RESERVATION_TYPE_VALUE = "Reservation";
const ADDON_TYPE_VALUE = "addon";

// ---- Rollup table ----
const ROLLUP_TABLE = "SIGMA_BAR3_TOTAL_RES";
const ROLLUP_KEY_FIELD = "RES_ID";      // one row per RES_ID

// Optional: if you want to avoid loops when updating rollup table,
// do NOT set an Outgoing URL on SIGMA_BAR3_TOTAL_RES that calls back here.

let tokenCache = { token: null, exp: 0 };
const nowSec = () => Math.floor(Date.now() / 1000);

function escWhereValue(v) {
  return String(v).replace(/'/g, "''");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

async function getCaspioToken() {
  if (tokenCache.token && tokenCache.exp > nowSec() + 30) return tokenCache.token;

  const base = process.env.CASPIO_BASE_URL;
  const tokenUrl = process.env.CASPIO_AUTH_TOKEN_URL || `${base}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.CASPIO_CLIENT_ID,
    client_secret: process.env.CASPIO_CLIENT_SECRET,
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) throw new Error(`Token error ${resp.status}: ${await resp.text()}`);

  const json = await resp.json();
  tokenCache.token = json.access_token;
  tokenCache.exp = nowSec() + (json.expires_in || 3600);
  return tokenCache.token;
}

async function caspioFetch(path, { method = "GET", body } = {}) {
  const token = await getCaspioToken();
  const base = process.env.CASPIO_BASE_URL;

  const resp = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Caspio ${method} failed ${resp.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getAllRecordsByWhere(table, where, limit = 1000) {
  // Most reservations won't exceed this; if you might, we can add paging.
  const url =
    `/rest/v2/tables/${table}/records?q.where=${encodeURIComponent(where)}&q.limit=${limit}`;
  const resp = await caspioFetch(url);
  return resp?.Result || [];
}

export default async function handler(req, res) {
  try {
    // ---- Security ----
    const auth = req.headers.authorization || "";
    const expected = `Bearer ${process.env.SIGMA_WEBHOOK_SECRET}`;
    if (!process.env.SIGMA_WEBHOOK_SECRET || auth !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Caspio Outgoing URLs payload often looks like { EventType, Data: { ...fields... } }
    const payload = req.body || {};
    const data = payload.Data || payload.data || payload.record || {};

    const RES_ID = data[RES_ID_FIELD];
    if (!RES_ID) return res.status(400).json({ error: `Missing ${RES_ID_FIELD} in payload` });

    const resIdWhereVal = escWhereValue(RES_ID);

    // 1) Find the single Reservation row
    const reservationWhere =
      `${RES_ID_FIELD}='${resIdWhereVal}' AND ${TYPE_FIELD}='${escWhereValue(RESERVATION_TYPE_VALUE)}'`;

    const reservationRows = await getAllRecordsByWhere(SOURCE_TABLE, reservationWhere, 1);
    const reservationRow = reservationRows[0] || null;

    // Pull fields from Reservation row (as you specified)
    const IDKEY = reservationRow?.IDKEY ?? null;
    const Business_Unit = reservationRow?.Business_Unit ?? null;
    const Status = reservationRow?.Status ?? null;

    const Subtotal_Primary = toNum(reservationRow?.[LINE_TOTAL_FIELD]);

    // 2) Sum all addon rows
    const addonWhere =
      `${RES_ID_FIELD}='${resIdWhereVal}' AND ${TYPE_FIELD}='${escWhereValue(ADDON_TYPE_VALUE)}'`;

    const addonRows = await getAllRecordsByWhere(SOURCE_TABLE, addonWhere, 1000);
    const Subtotal_Addon = addonRows.reduce((sum, r) => sum + toNum(r[LINE_TOTAL_FIELD]), 0);

    // 3) Total = primary + addon
    const Total = Subtotal_Primary + Subtotal_Addon;

    // 4) Upsert into rollup table (one row per RES_ID)
    const rollupWhere = `${ROLLUP_KEY_FIELD}='${resIdWhereVal}'`;

    const existingRollup = await caspioFetch(
      `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}&q.limit=1`
    );
    const exists = (existingRollup?.Result || [])[0];

    const upsertBody = {
      [ROLLUP_KEY_FIELD]: RES_ID,
      IDKEY,
      Business_Unit,
      Status,
      Subtotal_Primary,
      Subtotal_Addon,
      Total,
    };

    if (exists) {
      await caspioFetch(
        `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}`,
        { method: "PUT", body: upsertBody }
      );
      return res.status(200).json({
        ok: true,
        action: "updated",
        RES_ID,
        Subtotal_Primary,
        Subtotal_Addon,
        Total,
      });
    } else {
      await caspioFetch(`/rest/v2/tables/${ROLLUP_TABLE}/records`, {
        method: "POST",
        body: upsertBody,
      });
      return res.status(200).json({
        ok: true,
        action: "inserted",
        RES_ID,
        Subtotal_Primary,
        Subtotal_Addon,
        Total,
      });
    }
  } catch (err) {
    console.error("sigma-rollup-total-res error:", err);
    return res.status(500).json({ error: "Server error", detail: String(err.message || err) });
  }
}
