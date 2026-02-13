// pages/api/sigma-rollup-total-res.js

/**
 * Caspio Outgoing URL webhook -> roll up totals per RES_ID
 *
 * Source: BAR2_Reservations_SIGMA
 *   - multiple rows per RES_ID
 *   - one row where Type = "Reservation"
 *   - zero+ rows where Type = "addon"
 *   - numeric field "Total" on each row
 *
 * Target: SIGMA_BAR3_TOTAL_RES
 *   - exactly one row per RES_ID (rollup row)
 *   - fields updated: IDKEY, Business_Unit, Status, Subtotal_Primary, Subtotal_Addon, Total
 *
 * Events:
 *   - Insert: always recalc
 *   - Update: recalc ONLY if Total changed WHEN verifiable; otherwise proceed for correctness
 *   - Delete: always recalc; if nothing remains for RES_ID, delete rollup row
 *
 * Auth:
 *   - token passed via query string: ?token=YOUR_SECRET
 *   - compare to env SIGMA_WEBHOOK_SECRET
 *
 * Storm guard:
 *   - coalesce concurrent requests per RES_ID
 *   - short TTL cache per RES_ID to absorb bursts
 *
 * ENV VARS REQUIRED:
 *   CASPIO_BASE_URL (e.g. https://c0gfs257.caspio.com)
 *   CASPIO_CLIENT_ID
 *   CASPIO_CLIENT_SECRET
 *   SIGMA_WEBHOOK_SECRET
 * Optional:
 *   CASPIO_AUTH_TOKEN_URL (defaults to `${CASPIO_BASE_URL}/oauth/token`)
 */

// ---------------- CONFIG ----------------
const SOURCE_TABLE = "BAR2_Reservations_SIGMA";
const ROLLUP_TABLE = "SIGMA_BAR3_TOTAL_RES";

const TYPE_FIELD = "Type";
const RES_ID_FIELD = "RES_ID";
const LINE_TOTAL_FIELD = "Total";

const RESERVATION_TYPE_VALUE = "Reservation";
const ADDON_TYPE_VALUE = "addon";

const ROLLUP_KEY_FIELD = "RES_ID";

// Update-gating field
const TOTAL_FIELD = LINE_TOTAL_FIELD;

// Storm guard
const INFLIGHT_BY_RESID = new Map(); // RES_ID -> Promise<result>
const CACHE_BY_RESID = new Map(); // RES_ID -> { ts, result }
const CACHE_TTL_MS = 1500;

// ---------------- HELPERS ----------------
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

  // prevent unbounded growth on warm instances
  if (CACHE_BY_RESID.size > 500) {
    const keys = Array.from(CACHE_BY_RESID.keys()).slice(0, 100);
    keys.forEach((k) => CACHE_BY_RESID.delete(k));
  }
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

// ---------------- CASPIO AUTH + FETCH ----------------
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
  if (!resp.ok) {
    // throw raw response for visibility
    throw new Error(`Caspio ${method} ${path} failed ${resp.status}: ${text}`);
  }

  // Some responses may be empty on DELETE
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // Always return something usable
    return { raw: text };
  }
}

async function getRecords(table, where, limit = 1000) {
  const url = `/rest/v2/tables/${table}/records?q.where=${encodeURIComponent(where)}&q.limit=${limit}`;
  const resp = await caspioFetch(url);
  return resp?.Result || [];
}

// ---------------- PAYLOAD NORMALIZER ----------------
function normalizeCaspioWebhook(payload) {
  const p = payload || {};

  const eventTypeRaw = (p.EventType || p.eventType || p.Event || p.event || p.type || "").toString();
  const eventType = eventTypeRaw.toLowerCase();

  // Try common placements for "new" and "old" record snapshots
  const newData =
    p.Data ||
    p.data ||
    p.NewData ||
    p.newData ||
    p.After ||
    p.after ||
    p.Record ||
    p.record ||
    p.Row ||
    p.row ||
    null;

  const oldData =
    p.OldData ||
    p.oldData ||
    p.Before ||
    p.before ||
    p.Previous ||
    p.previous ||
    null;

  // Some Caspio payloads may put everything at the top level (rare but seen)
  const fallbackData =
    (!newData && typeof p === "object" && p !== null && (RES_ID_FIELD in p || TYPE_FIELD in p || TOTAL_FIELD in p))
      ? p
      : null;

  return {
    eventTypeRaw,
    eventType,
    newData: newData || fallbackData || {},
    oldData: oldData || null,
  };
}

// ---------------- HANDLER ----------------
export default async function handler(req, res) {
  try {
    // Caspio sends POST; still handle accidental GET so you can test endpoint quickly.
    // But require auth either way.
    const token = req.query?.token;

    if (!process.env.SIGMA_WEBHOOK_SECRET || token !== process.env.SIGMA_WEBHOOK_SECRET) {
      // Return JSON + 401 (Caspio will log this; your browser test will show it too)
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body || {};
    const { eventTypeRaw, eventType, newData, oldData } = normalizeCaspioWebhook(payload);

    // Pull RES_ID from whichever snapshot has it
    const RES_ID = newData?.[RES_ID_FIELD] ?? oldData?.[RES_ID_FIELD] ?? null;

    if (!RES_ID) {
      // IMPORTANT: return 200 so Caspio doesn't retry forever on malformed payloads
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "Missing RES_ID in webhook payload",
        eventType: eventTypeRaw,
      });
    }

    // ---- Gate UPDATE events: only run if Total changed WHEN verifiable ----
    if (eventType.includes("update")) {
      // Case 1: have old + new Total -> compare
      if (oldData && (TOTAL_FIELD in oldData) && (TOTAL_FIELD in newData)) {
        if (sameNumber(oldData[TOTAL_FIELD], newData[TOTAL_FIELD])) {
          return res.status(200).json({
            ok: true,
            skipped: true,
            reason: "Total unchanged on update",
            RES_ID,
            eventType: eventTypeRaw,
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
            eventType: eventTypeRaw,
          });
        }
        // Case 3: unknown -> proceed for correctness
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

      // 1) Find the Reservation row
      const reservationWhere =
        `${RES_ID_FIELD}='${resIdEsc}' AND ${TYPE_FIELD}='${escWhereValue(RESERVATION_TYPE_VALUE)}'`;
      const reservationRows = await getRecords(SOURCE_TABLE, reservationWhere, 1);
      const reservationRow = reservationRows[0] || null;

      // 2) Find addon rows
      const addonWhere =
        `${RES_ID_FIELD}='${resIdEsc}' AND ${TYPE_FIELD}='${escWhereValue(ADDON_TYPE_VALUE)}'`;
      const addonRows = await getRecords(SOURCE_TABLE, addonWhere, 1000);

      // If NOTHING remains in source table for this RES_ID, delete rollup row (if it exists)
      const nothingRemains = !reservationRow && addonRows.length === 0;

      const rollupWhere = `${ROLLUP_KEY_FIELD}='${resIdEsc}'`;
      const existingRollupResp = await caspioFetch(
        `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}&q.limit=1`
      );
      const existing = (existingRollupResp?.Result || [])[0];

      if (nothingRemains) {
        if (existing) {
          await caspioFetch(
            `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}`,
            { method: "DELETE" }
          );
          return { ok: true, action: "deleted_rollup", RES_ID, eventType: eventTypeRaw };
        }
        return { ok: true, action: "no_rollup_to_delete", RES_ID, eventType: eventTypeRaw };
      }

      // Compute totals
      const IDKEY = reservationRow?.IDKEY ?? null;
      const Business_Unit = reservationRow?.Business_Unit ?? null;
      const Status = reservationRow?.Status ?? null;

      const Subtotal_Primary = toNum(reservationRow?.[LINE_TOTAL_FIELD]);
      const Subtotal_Addon = addonRows.reduce((sum, r) => sum + toNum(r?.[LINE_TOTAL_FIELD]), 0);
      const Total = Subtotal_Primary + Subtotal_Addon;

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

    // IMPORTANT: Return 200 so Caspio doesn't keep retrying and spamming logs.
    // Include error details for your own diagnosis.
    return res.status(200).json({
      ok: false,
      error: "rollup_failed",
      detail: String(err?.message || err),
    });
  }
}
