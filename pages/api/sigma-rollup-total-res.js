// pages/api/sigma-rollup-total-res.js

/**
 * Recalculate and upsert a rollup row in SIGMA_BAR3_TOTAL_RES whenever BAR2_Reservations_SIGMA changes.
 *
 * - BAR2_Reservations_SIGMA has multiple rows per RES_ID:
 *    * one row where Type = "Reservation"
 *    * zero+ rows where Type = "addon"
 *   Each row has a numeric field Total.
 *
 * - SIGMA_BAR3_TOTAL_RES has exactly one row per RES_ID (rollup row).
 *
 * Behavior:
 *  - INSERT: always recalc + upsert rollup
 *  - DELETE: always recalc; if nothing remains for RES_ID, delete rollup
 *  - UPDATE: only recalc if the row's Total changed (when we can verify); otherwise proceed for correctness
 *
 * Storm guard:
 *  - Coalesce concurrent requests per RES_ID
 *  - Short TTL cache per RES_ID to absorb bursts
 *
 * ENV VARS REQUIRED
 *  - CASPIO_BASE_URL=https://c0gfs257.caspio.com
 *  - CASPIO_CLIENT_ID=...
 *  - CASPIO_CLIENT_SECRET=...
 *  - (optional) CASPIO_AUTH_TOKEN_URL=https://c0gfs257.caspio.com/oauth/token
 *  - SIGMA_WEBHOOK_SECRET=...
 */

// ---- BAR2_Reservations_SIGMA line item structure ----
const SOURCE_TABLE = "BAR2_Reservations_SIGMA";
const TYPE_FIELD = "Type";
const RES_ID_FIELD = "RES_ID";
const LINE_TOTAL_FIELD = "Total";

const RESERVATION_TYPE_VALUE = "Reservation";
const ADDON_TYPE_VALUE = "addon";

// ---- Rollup table ----
const ROLLUP_TABLE = "SIGMA_BAR3_TOTAL_RES";
const ROLLUP_KEY_FIELD = "RES_ID";

// ---- "Only run when Total changes" gate ----
const TOTAL_FIELD = LINE_TOTAL_FIELD; // the field we care about for Update events

// ---- Storm guard: coalesce + short cache per RES_ID ----
const INFLIGHT_BY_RESID = new Map(); // RES_ID -> Promise<result>
const CACHE_BY_RESID = new Map(); // RES_ID -> { ts, result }
const CACHE_TTL_MS = 1500; // burst window

function getCached(resId) {
  const entry = CACHE_BY_RESID.get(resId);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    CACHE_BY_RESID.delete(resId);
    return null;
  }
  return entry.result;
}

function setCached(resId, result) {
  CACHE_BY_RESID.set(resId, { ts: Date.now(), result });

  // keep cache from growing forever
  if (CACHE_BY_RESID.size > 500) {
    const keys = Array.from(CACHE_BY_RESID.keys()).slice(0, 100);
    keys.forEach((k) => CACHE_BY_RESID.delete(k));
  }
}

// ---- Caspio auth/token helpers ----
let tokenCache = { token: null, exp: 0 };
const nowSec = () => Math.floor(Date.now() / 1000);

function escWhereValue(v) {
  return String(v).replace(/'/g, "''");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function sameNumber(a, b) {
  const na = Number(a);
  const nb = Number(b);
  const A = Number.isFinite(na) ? na : 0;
  const B = Number.isFinite(nb) ? nb : 0;
  return A === B;
}

function fieldChanged(payload, fieldName) {
  // Some webhook payloads include a list of changed fields
  const candidates = [
    payload?.ChangedFields,
    payload?.changedFields,
    payload?.ModifiedFields,
    payload?.modifiedFields,
    payload?.FieldsChanged,
    payload?.fieldsChanged,
  ].filter(Boolean);

  for (const list of candidates) {
    if (Array.isArray(list) && list.some((f) => String(f).toLowerCase() === fieldName.toLowerCase())) {
      return true;
    }
    if (typeof list === "string" && list.toLowerCase().includes(fieldName.toLowerCase())) {
      return true;
    }
  }
  return null; // unknown
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

async function getRecords(table, where, limit = 1000) {
  const url = `/rest/v2/tables/${table}/records?q.where=${encodeURIComponent(where)}&q.limit=${limit}`;
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

    // ---- Parse payload (covers common Caspio shapes) ----
    const payload = req.body || {};

    // current record (for insert/update) OR deleted record snapshot
    const data =
      payload.Data ||
      payload.data ||
      payload.record ||
      payload.NewData ||
      payload.newData ||
      payload.After ||
      payload.after ||
      payload.OldData ||
      payload.oldData ||
      payload.Before ||
      payload.before ||
      {};

    // best-effort old snapshot for updates
    const oldData =
      payload.OldData ||
      payload.oldData ||
      payload.Before ||
      payload.before ||
      payload.Previous ||
      payload.previous ||
      null;

    const eventTypeRaw = (payload.EventType || payload.eventType || payload.Event || payload.event || "").toString();
    const eventType = eventTypeRaw.toLowerCase();

    const RES_ID = data[RES_ID_FIELD];
    if (!RES_ID) return res.status(400).json({ error: `Missing ${RES_ID_FIELD} in payload` });

    // ---- Gate UPDATE events: only run if Total changed (when we can verify) ----
    if (eventType.includes("update")) {
      // Case 1: compare old vs new Total when available
      if (oldData && (TOTAL_FIELD in oldData) && (TOTAL_FIELD in data)) {
        if (sameNumber(oldData[TOTAL_FIELD], data[TOTAL_FIELD])) {
          return res.status(200).json({
            ok: true,
            skipped: true,
            reason: "Total unchanged on update",
            RES_ID,
          });
        }
      } else {
        // Case 2: changed-fields list
        const changed = fieldChanged(payload, TOTAL_FIELD);
        if (changed === false) {
          return res.status(200).json({
            ok: true,
            skipped: true,
            reason: "Total not in changed-fields list",
            RES_ID,
          });
        }
        // Case 3: unknown (no OldData/ChangedFields) -> proceed for correctness
      }
    }

    // ---- Storm guard: cache ----
    const cached = getCached(RES_ID);
    if (cached) {
      return res.status(200).json({ ...cached, coalesced: "cache" });
    }

    // ---- Storm guard: coalesce in-flight work ----
    if (INFLIGHT_BY_RESID.has(RES_ID)) {
      const shared = await INFLIGHT_BY_RESID.get(RES_ID);
      return res.status(200).json({ ...shared, coalesced: "inflight" });
    }

    const workPromise = (async () => {
      const resIdEsc = escWhereValue(RES_ID);

      // 1) Pull the Reservation row (if it exists)
      const reservationWhere =
        `${RES_ID_FIELD}='${resIdEsc}' AND ${TYPE_FIELD}='${escWhereValue(RESERVATION_TYPE_VALUE)}'`;

      const reservationRows = await getRecords(SOURCE_TABLE, reservationWhere, 1);
      const reservationRow = reservationRows[0] || null;

      const IDKEY = reservationRow?.IDKEY ?? null;
      const Business_Unit = reservationRow?.Business_Unit ?? null;
      const Status = reservationRow?.Status ?? null;
      const Subtotal_Primary = toNum(reservationRow?.[LINE_TOTAL_FIELD]);

      // 2) Pull addon rows and sum
      const addonWhere =
        `${RES_ID_FIELD}='${resIdEsc}' AND ${TYPE_FIELD}='${escWhereValue(ADDON_TYPE_VALUE)}'`;

      const addonRows = await getRecords(SOURCE_TABLE, addonWhere, 1000);
      const Subtotal_Addon = addonRows.reduce((sum, r) => sum + toNum(r[LINE_TOTAL_FIELD]), 0);

      const Total = Subtotal_Primary + Subtotal_Addon;

      // 3) Upsert/Delete rollup row
      const rollupWhere = `${ROLLUP_KEY_FIELD}='${resIdEsc}'`;
      const existingRollupResp = await caspioFetch(
        `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}&q.limit=1`
      );
      const existing = (existingRollupResp?.Result || [])[0];

      // If NOTHING remains for this RES_ID, remove the rollup row (useful on deletes)
      const nothingRemains = !reservationRow && addonRows.length === 0;

      if (nothingRemains) {
        if (existing) {
          await caspioFetch(
            `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}`,
            { method: "DELETE" }
          );
          return {
            ok: true,
            action: "deleted_rollup",
            RES_ID,
            eventType: eventTypeRaw,
          };
        }
        return {
          ok: true,
          action: "no_rollup_to_delete",
          RES_ID,
          eventType: eventTypeRaw,
        };
      }

      const upsertBody = {
        [ROLLUP_KEY_FIELD]: RES_ID,
        IDKEY,
        Business_Unit,
        Status,
        Subtotal_Primary,
        Subtotal_Addon,
        Total,
      };

      if (existing) {
        await caspioFetch(
          `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}`,
          { method: "PUT", body: upsertBody }
        );
        return {
          ok: true,
          action: "updated",
          RES_ID,
          Subtotal_Primary,
          Subtotal_Addon,
          Total,
          eventType: eventTypeRaw,
        };
      } else {
        await caspioFetch(`/rest/v2/tables/${ROLLUP_TABLE}/records`, {
          method: "POST",
          body: upsertBody,
        });
        return {
          ok: true,
          action: "inserted",
          RES_ID,
          Subtotal_Primary,
          Subtotal_Addon,
          Total,
          eventType: eventTypeRaw,
        };
      }
    })();

    INFLIGHT_BY_RESID.set(RES_ID, workPromise);

    try {
      const result = await workPromise;
      setCached(RES_ID, result);
      return res.status(200).json({ ...result, coalesced: "fresh" });
    } finally {
      INFLIGHT_BY_RESID.delete(RES_ID);
    }
  } catch (err) {
    console.error("sigma-rollup-total-res error:", err);
    return res.status(500).json({ error: "Server error", detail: String(err.message || err) });
  }
}
