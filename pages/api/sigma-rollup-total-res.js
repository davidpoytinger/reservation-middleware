// pages/api/sigma-rollup-total-res.js

/**
 * Caspio Outgoing URL webhook -> roll up totals per RES_ID
 *
 * Auth: query string token (?token=...)
 *
 * IMPORTANT FIX (kept):
 * - Caspio payload structure varies. This version finds RES_ID by:
 *    1) checking common Caspio fields
 *    2) deep-searching payload for a key named "RES_ID"
 *
 * ✅ ADDITIONS:
 * - Look up SIGMA_VW_Res_Billing_Edit by IDKEY (from the Reservation row)
 * - Write:
 *    Tax_SIGMA <- GEN_Business_Units_Tax_Percentage
 *    Auto_Gratuity_SIGMA <- BAR2_Primary_Config_Auto_Gratuity_SIGMA
 * - Move Stripe-webhook-style "enrichment mapping" into the rollup row (optional columns)
 */

const SOURCE_TABLE = "BAR2_Reservations_SIGMA";
const ROLLUP_TABLE = "SIGMA_BAR3_TOTAL_RES";
const BILLING_VIEW = "SIGMA_VW_Res_Billing_Edit";

const RES_ID_FIELD = "RES_ID";
const TYPE_FIELD = "Type";
const LINE_TOTAL_FIELD = "Total";

const ROLLUP_KEY_FIELD = "RES_ID";
const TOTAL_FIELD = "Total";

// Rollup table additional targets
const R_TAX_SIGMA = "Tax_SIGMA";
const R_AUTO_GRAT_SIGMA = "Auto_Gratuity_SIGMA";

// View fields to pull
const V_TAX_PCT = "GEN_Business_Units_Tax_Percentage";
const V_AUTO_GRAT = "BAR2_Primary_Config_Auto_Gratuity_SIGMA";

// Optional enrichment columns (same values your webhook used to write to BAR2_Reservations_SIGMA)
// If these columns don't exist in SIGMA_BAR3_TOTAL_RES, we will auto-trim and still succeed.
const R_EMAIL_DESIGN = "Email_Design";
const R_LOGO = "Logo_Graphic_Email_String";
const R_UNITS_DBA = "Units_DBA";
const R_SESSIONS_TITLE = "Sessions_Title";
const R_PREHEADER = "Event_Email_Preheader";
const R_PCOLOR1 = "Primary_Color_1";
const R_PCOLOR2 = "Primary_Color_2";
const R_FACILITY = "Facility";

// Keys in view row (alias drift tolerant)
const EMAIL_HTML_KEYS = [
  "BAR2_Email_Design_Email_Content",
  "Email_Design_Email_Content",
  "Email_Design",
  "Email_Content",
  "BAR2_Email_Design",
  "EmailHTML",
];
const LOGO_KEYS = [
  "GEN_Business_Units_Logo_Graphic_Email_String",
  "Logo_Graphic_Email_String",
  "LogoEmailString",
];
const DBA_KEYS = ["GEN_Business_Units_DBA", "Units_DBA", "DBA"];
const SESS_TITLE_KEYS = ["BAR2_Sessions_Title", "Sessions_Title"];
const PREHEADER_KEYS = ["GEN_Business_Units_Event_Email_Preheader", "Event_Email_Preheader"];
const PC1_KEYS = ["GEN_Business_Units_Primary_Color_1", "Primary_Color_1"];
const PC2_KEYS = ["GEN_Business_Units_Primary_Color_2", "Primary_Color_2"];
const FACILITY_KEYS = ["GEN_Business_Units_Facility", "Facility"];

// Storm guard
const INFLIGHT_BY_RESID = new Map();
const CACHE_BY_RESID = new Map();
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

// ---------- helpers ----------
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

/**
 * Deep-find first occurrence of keyName within an object (bounded depth).
 * Returns { value, path } or null.
 */
function deepFindKey(obj, keyName, maxDepth = 6) {
  const seen = new Set();

  function helper(cur, path, depth) {
    if (cur === null || cur === undefined) return null;
    if (typeof cur !== "object") return null;
    if (seen.has(cur)) return null;
    seen.add(cur);

    // Direct key hit
    if (Object.prototype.hasOwnProperty.call(cur, keyName)) {
      return { value: cur[keyName], path: path ? `${path}.${keyName}` : keyName };
    }

    if (depth >= maxDepth) return null;

    // Arrays
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) {
        const hit = helper(cur[i], `${path}[${i}]`, depth + 1);
        if (hit) return hit;
      }
      return null;
    }

    // Objects
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      const nextPath = path ? `${path}.${k}` : k;
      const hit = helper(v, nextPath, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  return helper(obj, "", 0);
}

/**
 * Try common Caspio webhook shapes first, then deep-search.
 * Returns { resId, resIdPath, eventTypeRaw, eventType, newData, oldData }
 */
function normalizeWebhook(payload) {
  const p = payload || {};

  const eventTypeRaw = (p.EventType || p.eventType || p.Event || p.event || p.type || "").toString();
  const eventType = eventTypeRaw.toLowerCase();

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

  // 1) Direct tries
  const directResId =
    newData?.[RES_ID_FIELD] ??
    oldData?.[RES_ID_FIELD] ??
    p?.[RES_ID_FIELD] ??
    null;

  if (directResId !== null && directResId !== undefined && String(directResId).length > 0) {
    return {
      resId: directResId,
      resIdPath: newData?.[RES_ID_FIELD] != null
        ? "newData.RES_ID"
        : oldData?.[RES_ID_FIELD] != null
          ? "oldData.RES_ID"
          : "payload.RES_ID",
      eventTypeRaw,
      eventType,
      newData: newData || {},
      oldData: oldData || null,
    };
  }

  // 2) Deep search the whole payload
  const deepHit = deepFindKey(p, RES_ID_FIELD, 6);
  return {
    resId: deepHit?.value ?? null,
    resIdPath: deepHit?.path ?? null,
    eventTypeRaw,
    eventType,
    newData: newData || {},
    oldData: oldData || null,
  };
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function parseTaxPercentToRate(val) {
  // Accepts: 0.055, 5.5, "5.5%", "0.055"
  const raw = String(val ?? "").trim().replace("%", "");
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;

  // If >1 assume percent (e.g. 5.5 => 0.055)
  if (n > 1) return Number((n / 100).toFixed(6));
  return Number(n.toFixed(6));
}

function parseAutoGrat(val) {
  const raw = String(val ?? "").trim().replace("%", "");
  const n = Number(raw);
  // keep as numeric; interpretation (flat vs rate) is up to downstream usage
  return Number.isFinite(n) ? n : null;
}

// ---------- Caspio REST helpers ----------
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

  const url = `${base}${path}`;
  console.log("CASPIO_FETCH:", method, url);

  const resp = await fetch(url, {
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
    console.error("CASPIO_ERR:", method, url, resp.status, text);
    throw new Error(`Caspio ${method} failed ${resp.status}: ${text}`);
  }

  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
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

async function getBillingViewRowByIdKey(idkey) {
  if (!idkey) return null;
  const where = `IDKEY='${escWhereValue(idkey)}'`;
  const url = `/rest/v2/views/${BILLING_VIEW}/records?q.where=${encodeURIComponent(where)}&q.limit=1`;
  const resp = await caspioFetch(url);
  return (resp?.Result || [])[0] || null;
}

/**
 * If Caspio responds with ColumnNotFound / "do not exist" / invalid column,
 * drop those fields and retry once.
 */
async function upsertRollupResilient(existing, rollupWhere, body) {
  const whereParam = encodeURIComponent(rollupWhere);
  const putUrl = `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${whereParam}`;
  const postUrl = `/rest/v2/tables/${ROLLUP_TABLE}/records`;

  const attempt = async (payload) => {
    if (existing) {
      await caspioFetch(putUrl, { method: "PUT", body: payload });
      return { action: "updated" };
    }
    await caspioFetch(postUrl, { method: "POST", body: payload });
    return { action: "inserted" };
  };

  try {
    return await attempt(body);
  } catch (err) {
    const msg = String(err?.message || "");
    const isMissing =
      /ColumnNotFound/i.test(msg) ||
      /do not exist/i.test(msg) ||
      /Invalid column/i.test(msg);

    if (!isMissing) throw err;

    const missing = [];
    for (const m of msg.matchAll(/'([^']+)'/g)) missing.push(m[1]);

    const trimmed = { ...body };
    for (const f of missing) delete trimmed[f];

    // If we couldn't parse which fields, conservatively drop optional enrichments
    if (!missing.length) {
      [
        R_EMAIL_DESIGN,
        R_LOGO,
        R_UNITS_DBA,
        R_SESSIONS_TITLE,
        R_PREHEADER,
        R_PCOLOR1,
        R_PCOLOR2,
        R_FACILITY,
        R_TAX_SIGMA,
        R_AUTO_GRAT_SIGMA,
      ].forEach((k) => delete trimmed[k]);
    }

    if (Object.keys(trimmed).length === 0) throw err;

    const r = await attempt(trimmed);
    return { ...r, trimmed: true, missingFields: missing.length ? missing : "unknown" };
  }
}

// ---------- handler ----------



export default async function handler(req, res) {
  console.log("ROLLUP_HIT:", {
  method: req.method,
  hasBody: !!req.body && Object.keys(req.body || {}).length > 0,
  query: req.query,
  contentType: req.headers["content-type"],
});
  try {
    // Auth via query token (Caspio-friendly)
    const token = req.query?.token;
    if (!process.env.SIGMA_WEBHOOK_SECRET || token !== process.env.SIGMA_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body || {};
    const norm = normalizeWebhook(payload);

    const eventTypeRaw = norm.eventTypeRaw || "unknown";
    const eventType = norm.eventType || "";
    const newData = norm.newData || {};
    const oldData = norm.oldData || null;

    const RES_ID = norm.resId;

    if (!RES_ID) {
      // Return 200 so Caspio doesn't keep retrying; include breadcrumbs.
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "Missing RES_ID",
        eventType: eventTypeRaw,
        debug: {
          topLevelKeys: Object.keys(payload || {}),
          resIdPath: norm.resIdPath,
        },
      });
    }

    // Gate UPDATE events: only run if Total changed WHEN verifiable
    if (eventType.includes("update")) {
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
        // unknown -> proceed
      }
    }

    // Storm guard cache
    const cached = getCached(String(RES_ID));
    if (cached) return res.status(200).json({ ...cached, coalesced: "cache" });

    // Coalesce in-flight
    if (INFLIGHT_BY_RESID.has(String(RES_ID))) {
      const shared = await INFLIGHT_BY_RESID.get(String(RES_ID));
      return res.status(200).json({ ...shared, coalesced: "inflight" });
    }

    const workPromise = (async () => {
      // 1) Pull all source rows for RES_ID
      const rows = await getAllSourceRowsForResId(RES_ID);

      const typeOf = (r) => String(r?.[TYPE_FIELD] ?? "").trim().toLowerCase();
      const reservationRow = rows.find((r) => typeOf(r) === "reservation") || null;
      const addonRows = rows.filter((r) => typeOf(r) === "addon");

      // 2) If nothing remains, delete rollup if exists
      const existing = await getRollupRow(RES_ID);
      const rollupWhere = `${ROLLUP_KEY_FIELD}='${escWhereValue(RES_ID)}'`;

      if (rows.length === 0) {
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
          debug: { sourceRowCount: 0, resIdPath: norm.resIdPath },
        };
      }

      // 3) Compute totals + copy fields from reservation row
      const IDKEY = reservationRow?.IDKEY ?? null;
      const Business_Unit = reservationRow?.Business_Unit ?? null;
      const Status = reservationRow?.Status ?? null;

      const Subtotal_Primary = toNum(reservationRow?.[LINE_TOTAL_FIELD]);
      const Subtotal_Addon = addonRows.reduce((sum, r) => sum + toNum(r?.[LINE_TOTAL_FIELD]), 0);
      const Total = Subtotal_Primary + Subtotal_Addon;

      // 4) ✅ Billing view enrichment (LOOKUP BY IDKEY)
      let viewRow = null;
      if (IDKEY) {
        try {
          viewRow = await getBillingViewRowByIdKey(String(IDKEY));
        } catch (e) {
          // Non-blocking: keep totals correct even if view fails
          viewRow = null;
        }
      }

      // Build upsert body
      const upsertBody = {
        [ROLLUP_KEY_FIELD]: RES_ID,
        IDKEY,
        Business_Unit,
        Status,
        Subtotal_Primary,
        Subtotal_Addon,
        Total,
      };

      // ✅ Add Tax_SIGMA / Auto_Gratuity_SIGMA
      if (viewRow) {
        const taxRate = parseTaxPercentToRate(viewRow?.[V_TAX_PCT]);
        const autoGrat = parseAutoGrat(viewRow?.[V_AUTO_GRAT]);

        if (taxRate != null) upsertBody[R_TAX_SIGMA] = taxRate;
        if (autoGrat != null) upsertBody[R_AUTO_GRAT_SIGMA] = autoGrat;

        // ✅ Move webhook enrichment mapping into rollup row (optional cols)
        const emailHtml = pickFirst(viewRow, EMAIL_HTML_KEYS);
        if (emailHtml) {
          const maxLen = 64000;
          const val = String(emailHtml);
          upsertBody[R_EMAIL_DESIGN] = val.length > maxLen ? val.slice(0, maxLen) : val;
        }

        upsertBody[R_LOGO] = pickFirst(viewRow, LOGO_KEYS);
        upsertBody[R_UNITS_DBA] = pickFirst(viewRow, DBA_KEYS);

        upsertBody[R_SESSIONS_TITLE] =
          pickFirst(viewRow, SESS_TITLE_KEYS) || reservationRow?.Sessions_Title || null;

        upsertBody[R_PREHEADER] = pickFirst(viewRow, PREHEADER_KEYS);
        upsertBody[R_PCOLOR1] = pickFirst(viewRow, PC1_KEYS);
        upsertBody[R_PCOLOR2] = pickFirst(viewRow, PC2_KEYS);
        upsertBody[R_FACILITY] = pickFirst(viewRow, FACILITY_KEYS);
      }

      // 5) Upsert rollup row (resilient)
      const r = await upsertRollupResilient(existing, rollupWhere, upsertBody);

      return {
        ok: true,
        action: r.action,
        trimmed: !!r.trimmed,
        missingFields: r.missingFields,
        RES_ID,
        Total,
        debug: {
          sourceRowCount: rows.length,
          reservationFound: !!reservationRow,
          addonCount: addonRows.length,
          Subtotal_Primary,
          Subtotal_Addon,
          resIdPath: norm.resIdPath,
          viewLookup: IDKEY ? (viewRow ? "found" : "null") : "skipped_no_idkey",
        },
      };
    })();

    INFLIGHT_BY_RESID.set(String(RES_ID), workPromise);

    try {
      const result = await workPromise;
      setCached(String(RES_ID), result);
      return res.status(200).json({ ...result, coalesced: "fresh" });
    } finally {
      INFLIGHT_BY_RESID.delete(String(RES_ID));
    }
  } catch (err) {
    console.error("sigma-rollup-total-res error:", err);
    // Return 200 so Caspio doesn't retry forever; error still visible in logs.
    return res.status(200).json({
      ok: false,
      error: "rollup_failed",
      detail: String(err?.message || err),
    });
  }
}
