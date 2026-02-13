// pages/api/sigma-rollup-total-res.js

/**
 * Rollup recalculation endpoint
 * Triggered by Caspio Outgoing URL from BAR2_Reservations_SIGMA
 *
 * Requires query string:
 *   ?token=YOUR_SECRET
 *
 * ENV VARS:
 *   CASPIO_BASE_URL
 *   CASPIO_CLIENT_ID
 *   CASPIO_CLIENT_SECRET
 *   SIGMA_WEBHOOK_SECRET
 */

// ---------- CONFIG ----------
const SOURCE_TABLE = "BAR2_Reservations_SIGMA";
const ROLLUP_TABLE = "SIGMA_BAR3_TOTAL_RES";

const TYPE_FIELD = "Type";
const RES_ID_FIELD = "RES_ID";
const LINE_TOTAL_FIELD = "Total";

const RESERVATION_TYPE_VALUE = "Reservation";
const ADDON_TYPE_VALUE = "addon";

const ROLLUP_KEY_FIELD = "RES_ID";

// Storm guard
const INFLIGHT = new Map();
const CACHE = new Map();
const CACHE_TTL = 1500;

// ---------- HELPERS ----------
function esc(v) {
  return String(v).replace(/'/g, "''");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function getCached(id) {
  const entry = CACHE.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    CACHE.delete(id);
    return null;
  }
  return entry.data;
}

function setCached(id, data) {
  CACHE.set(id, { ts: Date.now(), data });
}

let tokenCache = { token: null, exp: 0 };
const nowSec = () => Math.floor(Date.now() / 1000);

async function getToken() {
  if (tokenCache.token && tokenCache.exp > nowSec() + 30) return tokenCache.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.CASPIO_CLIENT_ID,
    client_secret: process.env.CASPIO_CLIENT_SECRET,
  });

  const resp = await fetch(`${process.env.CASPIO_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) throw new Error("Caspio token failed");

  const json = await resp.json();
  tokenCache.token = json.access_token;
  tokenCache.exp = nowSec() + (json.expires_in || 3600);
  return tokenCache.token;
}

async function caspioFetch(path, { method = "GET", body } = {}) {
  const token = await getToken();

  const resp = await fetch(`${process.env.CASPIO_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(text);
  return text ? JSON.parse(text) : null;
}

async function getRows(where, limit = 1000) {
  const url =
    `/rest/v2/tables/${SOURCE_TABLE}/records?q.where=${encodeURIComponent(where)}&q.limit=${limit}`;
  const resp = await caspioFetch(url);
  return resp?.Result || [];
}

// ---------- HANDLER ----------
export default async function handler(req, res) {
  try {
    // ---- TOKEN AUTH (query string) ----
    const token = req.query.token;
    if (!process.env.SIGMA_WEBHOOK_SECRET || token !== process.env.SIGMA_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body || {};
    const data =
      payload.Data ||
      payload.data ||
      payload.record ||
      payload.OldData ||
      payload.oldData ||
      {};

    const eventType = (payload.EventType || payload.eventType || "").toLowerCase();
    const RES_ID = data[RES_ID_FIELD];

    if (!RES_ID) return res.status(400).json({ error: "Missing RES_ID" });

    // Storm guard - cache
    const cached = getCached(RES_ID);
    if (cached) return res.status(200).json({ ...cached, coalesced: "cache" });

    // Storm guard - coalesce
    if (INFLIGHT.has(RES_ID)) {
      const shared = await INFLIGHT.get(RES_ID);
      return res.status(200).json({ ...shared, coalesced: "inflight" });
    }

    const work = (async () => {
      const resIdEsc = esc(RES_ID);

      // 1) Reservation row
      const reservationWhere =
        `${RES_ID_FIELD}='${resIdEsc}' AND ${TYPE_FIELD}='${RESERVATION_TYPE_VALUE}'`;

      const reservationRows = await getRows(reservationWhere, 1);
      const reservation = reservationRows[0] || null;

      const IDKEY = reservation?.IDKEY ?? null;
      const Business_Unit = reservation?.Business_Unit ?? null;
      const Status = reservation?.Status ?? null;
      const Subtotal_Primary = toNum(reservation?.[LINE_TOTAL_FIELD]);

      // 2) Addons
      const addonWhere =
        `${RES_ID_FIELD}='${resIdEsc}' AND ${TYPE_FIELD}='${ADDON_TYPE_VALUE}'`;

      const addonRows = await getRows(addonWhere, 1000);
      const Subtotal_Addon = addonRows.reduce(
        (sum, r) => sum + toNum(r[LINE_TOTAL_FIELD]),
        0
      );

      const Total = Subtotal_Primary + Subtotal_Addon;

      // 3) Rollup upsert
      const rollupWhere = `${ROLLUP_KEY_FIELD}='${resIdEsc}'`;
      const existingResp = await caspioFetch(
        `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}&q.limit=1`
      );
      const existing = existingResp?.Result?.[0];

      const body = {
        [ROLLUP_KEY_FIELD]: RES_ID,
        IDKEY,
        Business_Unit,
        Status,
        Subtotal_Primary,
        Subtotal_Addon,
        Total,
      };

      if (!reservation && addonRows.length === 0) {
        if (existing) {
          await caspioFetch(
            `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}`,
            { method: "DELETE" }
          );
        }
        return { ok: true, action: "deleted_rollup", RES_ID };
      }

      if (existing) {
        await caspioFetch(
          `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}`,
          { method: "PUT", body }
        );
        return { ok: true, action: "updated", RES_ID, Total };
      } else {
        await caspioFetch(`/rest/v2/tables/${ROLLUP_TABLE}/records`, {
          method: "POST",
          body,
        });
        return { ok: true, action: "inserted", RES_ID, Total };
      }
    })();

    INFLIGHT.set(RES_ID, work);

    try {
      const result = await work;
      setCached(RES_ID, result);
      return res.status(200).json({ ...result, coalesced: "fresh" });
    } finally {
      INFLIGHT.delete(RES_ID);
    }
  } catch (err) {
    console.error("sigma-rollup-total-res error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
}
