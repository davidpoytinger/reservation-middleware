// pages/api/sigma-rollup-total-res.js

/**
 * Caspio Outgoing URL webhook -> roll up totals per RES_ID
 *
 * Auth: query string token (?token=...)
 *
 * IMPORTANT FIX:
 * - Caspio payload structure varies. This version finds RES_ID by:
 *    1) checking common Caspio fields
 *    2) deep-searching payload for a key named "RES_ID"
 *
 * ADDITIONS:
 * - Enrichment moved here (from stripe-webhook):
 *   - Lookup SIGMA_VW_Res_Billing_Edit by IDKEY
 *   - Write email/branding fields to BAR2_Reservations_SIGMA
 * - Also write Tax_SIGMA and Auto_Gratuity_SIGMA to SIGMA_BAR3_TOTAL_RES
 *   based on fields from SIGMA_VW_Res_Billing_Edit
 */

const SOURCE_TABLE = "BAR2_Reservations_SIGMA";
const ROLLUP_TABLE = "SIGMA_BAR3_TOTAL_RES";
const BILLING_VIEW = "SIGMA_VW_Res_Billing_Edit"; // ✅ uses IDKEY

const RES_ID_FIELD = "RES_ID";
const TYPE_FIELD = "Type";
const LINE_TOTAL_FIELD = "Total";

const ROLLUP_KEY_FIELD = "RES_ID";
const TOTAL_FIELD = "Total";

// New rollup fields you want to populate:
const ROLLUP_TAX_FIELD = "Tax_SIGMA";
const ROLLUP_AUTOGRAT_FIELD = "Auto_Gratuity_SIGMA";

// Billing view source fields:
const V_TAX_PCT = "GEN_Business_Units_Tax_Percentage";
const V_AUTO_GRAT = "BAR2_Primary_Config_Auto_Gratuity_SIGMA";

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
  return String(v ?? "").replace(/'/g, "''");
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
    throw new Error(`Caspio ${method} failed ${resp.status}: ${text}`);
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function caspioWriteResilient(path, method, bodyObj) {
  try {
    return await caspioFetch(path, { method, body: bodyObj });
  } catch (err) {
    const msg = String(err?.message || "");
    if (!/ColumnNotFound/i.test(msg) && !/do not exist/i.test(msg)) throw err;

    // Parse "...field(s) do not exist: 'A', 'B'..."
    const missing = [];
    for (const m of msg.matchAll(/'([^']+)'/g)) missing.push(m[1]);
    if (!missing.length) throw err;

    const trimmed = { ...bodyObj };
    for (const f of missing) delete trimmed[f];

    if (Object.keys(trimmed).length === 0) throw err;

    console.warn("⚠️ ColumnNotFound. Retrying without fields:", missing);
    return await caspioFetch(path, { method, body: trimmed });
  }
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function num2(v) {
  const n = Number(String(v ?? "").trim().replace("%", ""));
  return Number.isFinite(n) ? Number(n.toFixed(4)) : null;
}

// Converts tax “percent” or “rate” to a rate (0.055)
function parseTaxToRate(val) {
  const n = num2(val);
  if (n == null || n < 0) return null;
  if (n > 1) return Number((n / 100).toFixed(6));
  return Number(n.toFixed(6));
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

// ---------- handler ----------
export default async function handler(req, res) {
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
        // unknown -> proceed for correctness
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

      // 4) Billing view lookup by IDKEY (for Tax_SIGMA + Auto_Gratuity_SIGMA AND reservation enrichment)
      let taxRate = null;
      let autoGrat = null;
      let viewRow = null;

      if (IDKEY) {
        try {
          viewRow = await getBillingViewRowByIdKey(String(IDKEY));
        } catch (e) {
          console.warn("⚠️ Billing view lookup failed (non-blocking):", e?.message || e);
        }

        if (viewRow) {
          taxRate = parseTaxToRate(viewRow?.[V_TAX_PCT]);
          autoGrat = viewRow?.[V_AUTO_GRAT] ?? null;

          // ---- Reservation enrichment writeback (to BAR2_Reservations_SIGMA) ----
          // Only do this if we found a view row.
          const emailHtml = pickFirst(viewRow, [
            "BAR2_Email_Design_Email_Content",
            "Email_Design_Email_Content",
            "Email_Design",
            "Email_Content",
            "BAR2_Email_Design",
            "EmailHTML",
          ]);

          const reservationUpdatePayload = {};

          if (emailHtml) {
            const maxLen = 64000;
            const val = String(emailHtml);
            reservationUpdatePayload.Email_Design = val.length > maxLen ? val.slice(0, maxLen) : val;
          }

          reservationUpdatePayload.Logo_Graphic_Email_String = pickFirst(viewRow, [
            "GEN_Business_Units_Logo_Graphic_Email_String",
            "Logo_Graphic_Email_String",
            "LogoEmailString",
          ]);

          reservationUpdatePayload.Units_DBA = pickFirst(viewRow, ["GEN_Business_Units_DBA", "Units_DBA", "DBA"]);

          reservationUpdatePayload.Sessions_Title = pickFirst(viewRow, ["BAR2_Sessions_Title", "Sessions_Title"]);

          reservationUpdatePayload.Event_Email_Preheader = pickFirst(viewRow, [
            "GEN_Business_Units_Event_Email_Preheader",
            "Event_Email_Preheader",
          ]);

          reservationUpdatePayload.Primary_Color_1 = pickFirst(viewRow, [
            "GEN_Business_Units_Primary_Color_1",
            "Primary_Color_1",
          ]);
          reservationUpdatePayload.Primary_Color_2 = pickFirst(viewRow, [
            "GEN_Business_Units_Primary_Color_2",
            "Primary_Color_2",
          ]);
          reservationUpdatePayload.Facility = pickFirst(viewRow, ["GEN_Business_Units_Facility", "Facility"]);

          // Strip null/empty fields so we don't overwrite with blanks
          for (const k of Object.keys(reservationUpdatePayload)) {
            const v = reservationUpdatePayload[k];
            if (v === undefined || v === null || String(v).trim() === "") delete reservationUpdatePayload[k];
          }

          if (Object.keys(reservationUpdatePayload).length) {
            const where = `IDKEY='${escWhereValue(String(IDKEY))}'`;
            const path =
              `/rest/v2/tables/${SOURCE_TABLE}/records?q.where=` +
              encodeURIComponent(where);

            try {
              await caspioWriteResilient(path, "PUT", reservationUpdatePayload);
            } catch (e) {
              console.warn("⚠️ Reservation enrichment write failed (non-blocking):", e?.message || e);
            }
          }
        }
      }

      // 5) Upsert rollup row (RES_ID keyed) with totals + tax/grat
      const upsertBody = {
        [ROLLUP_KEY_FIELD]: RES_ID,
        IDKEY,
        Business_Unit,
        Status,
        Subtotal_Primary,
        Subtotal_Addon,
        Total,

        // ✅ New fields
        ...(taxRate != null ? { [ROLLUP_TAX_FIELD]: taxRate } : {}),
        ...(autoGrat != null ? { [ROLLUP_AUTOGRAT_FIELD]: autoGrat } : {}),
      };

      if (existing) {
        await caspioWriteResilient(
          `/rest/v2/tables/${ROLLUP_TABLE}/records?q.where=${encodeURIComponent(rollupWhere)}`,
          "PUT",
          upsertBody
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
            resIdPath: norm.resIdPath,
            billingViewFound: !!viewRow,
            Tax_SIGMA: taxRate,
            Auto_Gratuity_SIGMA: autoGrat,
          },
        };
      } else {
        await caspioWriteResilient(`/rest/v2/tables/${ROLLUP_TABLE}/records`, "POST", upsertBody);
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
            resIdPath: norm.resIdPath,
            billingViewFound: !!viewRow,
            Tax_SIGMA: taxRate,
            Auto_Gratuity_SIGMA: autoGrat,
          },
        };
      }
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
