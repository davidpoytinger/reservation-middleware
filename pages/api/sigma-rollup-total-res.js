// pages/api/sigma-rollup-total-res.js

/**
 * Rollup recalculation endpoint for SIGMA:
 * - Source table BAR2_Reservations_SIGMA has multiple rows per RES_ID
 *   * one row: Type = "Reservation" (case-insensitive)
 *   * many rows: Type = "addon" (case-insensitive)
 *   * numeric field Total on each row
 *
 * - Target table SIGMA_BAR3_TOTAL_RES has exactly one row per RES_ID (rollup)
 *   * fields: IDKEY, Business_Unit, Status, Subtotal_Primary, Subtotal_Addon, Total
 *
 * Auth via query string:
 *   ?token=YOUR_SECRET  (must match SIGMA_WEBHOOK_SECRET env var)
 *
 * Storm guard:
 *  - coalesce concurrent requests per RES_ID
 *  - short TTL cache
 *
 * IMPORTANT:
 * - This version avoids querying by Type in Caspio (which is brittle) and instead:
 *   fetches all rows for RES_ID then splits by Type in JS (case-insensitive).
 */

const SOURCE_TABLE = "BAR2_Reservations_SIGMA";
const ROLLUP_TABLE = "SIGMA_BAR3_TOTAL_RES";

const RES_ID_FIELD = "RES_ID";
const TYPE_FIELD = "Type";
const LINE_TOTAL_FIELD = "Total";

const ROLLUP_KEY_FIELD = "RES_ID";

// Update gating
const TOTAL_FIELD = LINE_TOTAL_FIELD;

// Storm guard
const INFLIGHT_BY_RESID = new Map(); // RES_ID -> Promise
const CACHE_BY_RESID = new Map(); // RES_ID -> { ts, result }
const CACHE_TTL_MS = 1500;

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
  if (CACHE_BY_RESID.size > 500) {
    const keys = Array.from(CACHE_BY_RESID.keys()).slice(0, 100);
    keys.forEach((k) => CACHE_BY_RESID.delete(k));
  }
}

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
  return null;
}

let tokenCache = { token: null, exp: 0 };
const nowSec = () => Math.floor(Date.now() / 1000);

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
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Caspio ${method} failed ${resp.status}: ${text}`);

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function getAllSourceRowsForResId(resId) {
  const where = `${RES_ID_FIELD}='${escWhereValue(resId)}'`;
  const url = `/rest/v2/tables/${SOURCE_TABLE}/records?q.where=${encodeURIComponent(where)}&q.limit=1000`;
  const resp = await caspioFetch(url);
  return resp?.Result || [];
}

async function getRollupRow(resId) {
  const where = `${ROLLUP_KEY_FIELD}='${escWhereValue(resId)}'`;
  const url = `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(where)}&q.limit=1`;
  const resp = await caspioFetch(url);
  return (resp?.Result || [])[0] || null;
}

function normalizeWebhook(payload) {
  const p = payload || {};
  const eventTypeRaw = (p.EventType || p.eventType || p.Event || p.event || "").toString();
  const eventType = eventTypeRaw.toLowerCase();

  const newData =
    p.Data || p.data || p.NewData || p.newData || p.After || p.after || p.record || p.Record || null;

  const oldData =
    p.OldData || p.oldData || p.Before || p.before || p.Previous || p.previous || null;

  return { eventTypeRaw, eventType, newData: newData || {}, oldData };
}

export default async function handler(req, res) {
  try {
    // Auth via query param (Caspio-friendly)
    const token = req.query?.token;
    if (!process.env.SIGMA_WEBHOOK_SECRET || token !== process.env.SIGMA_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body || {};
    const { eventTypeRaw, eventType, newData, oldData } = normalizeWebhook(payload);

    const RES_ID = newData?.[RES_ID_FIELD] ?? oldData?.[RES_ID_FIELD];
    if (!RES_ID) {
      // return 200 so Caspio doesn’t mark as failed/retry
      return res.status(200).json({ ok: true, skipped: true, reason: "Missing RES_ID", eventType: eventTypeRaw });
    }

    // Gate UPDATE events: only run if Total changed when verifiable
    if (eventType.includes("update")) {
      if (oldData && (TOTAL_FIELD in oldData) && (TOTAL_FIELD in newData)) {
        if (sameNumber(oldData[TOTAL_FIELD], newData[TOTAL_FIELD])) {
          return res.status(200).json({ ok: true, skipped: true, reason: "Total unchanged on update", RES_ID });
        }
      } else {
        const changed = fieldChanged(payload, TOTAL_FIELD);
        if (changed === false) {
          return res.status(200).json({ ok: true, skipped: true, reason: "Total not in changed-fields list", RES_ID });
        }
        // unknown -> proceed for correctness
      }
    }

    // Storm guard cache
    const cached = getCached(RES_ID);
    if (cached) return res.status(200).json({ ...cached, coalesced: "cache" });

    // Coalesce in-flight
    if (INFLIGHT_BY_RESID.has(RES_ID)) {
      const shared = await INFLIGHT_BY_RESID.get(RES_ID);
      return res.status(200).json({ ...shared, coalesced: "inflight" });
    }

    const workPromise = (async () => {
      // 1) Pull ALL source rows for RES_ID (no brittle where Type='addon' etc)
      const rows = await getAllSourceRowsForResId(RES_ID);

      // Split by Type case-insensitively + trim
      const typeOf = (r) => String(r?.[TYPE_FIELD] ?? "").trim().toLowerCase();

      const reservationRow = rows.find((r) => typeOf(r) === "reservation") || null;
      const addonRows = rows.filter((r) => typeOf(r) === "addon");

      // 2) Compute totals
      const IDKEY = reservationRow?.IDKEY ?? null;
      const Business_Unit = reservationRow?.Business_Unit ?? null;
      const Status = reservationRow?.Status ?? null;

      const Subtotal_Primary = toNum(reservationRow?.[LINE_TOTAL_FIELD]);
      const Subtotal_Addon = addonRows.reduce((sum, r) => sum + toNum(r?.[LINE_TOTAL_FIELD]), 0);
      const Total = Subtotal_Primary + Subtotal_Addon;

      // 3) Upsert/Delete rollup row
      const existing = await getRollupRow(RES_ID);
      const rollupWhere = `${ROLLUP_KEY_FIELD}='${escWhereValue(RES_ID)}'`;

      // If nothing remains for RES_ID, delete rollup if exists
      const nothingRemains = rows.length === 0;
      if (nothingRemains) {
        if (existing) {
          await caspioFetch(
            `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}`,
            { method: "DELETE" }
          );
        }
        return {
          ok: true,
          action: existing ? "deleted_rollup" : "no_rollup_to_delete",
          RES_ID,
          debug: { sourceRowCount: rows.length },
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
          Total,
          debug: {
            sourceRowCount: rows.length,
            reservationFound: !!reservationRow,
            addonCount: addonRows.length,
            Subtotal_Primary,
            Subtotal_Addon,
          },
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
          Total,
          debug: {
            sourceRowCount: rows.length,
            reservationFound: !!reservationRow,
            addonCount: addonRows.length,
            Subtotal_Primary,
            Subtotal_Addon,
          },
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
    // Return 200 so Caspio doesn't keep retrying; error is still visible in logs.
    return res.status(200).json({ ok: false, error: "rollup_failed", detail: String(err?.message || err) });
  }
}
