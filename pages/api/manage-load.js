// pages/api/manage-load.js
import {
  getReservationByIdKey,
  getResBillingEditViewRowByIdKey,
  listRecordsByWhere,
  escapeWhereValue,
} from "../../lib/caspio";

// CONFIG
const V_SESS = "SIGMA_VW_Active_Sessions_Manage";
const T_SUBS = "BAR2_PricingV2_Subs";
const T_PRICING = "BAR2_PricingV2";
const CASPIO_BASE = process.env.CASPIO_INTEGRATION_URL || "https://c0gfs257.caspio.com";

function setCors(req, res) {
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
  ]);
  const origin = req.headers.origin || "";
  const allowOrigin = allowed.has(origin) ? origin : "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// simple tokenized fetch via caspio token helper
async function getToken() {
  // use caspio.js internal token cache by calling any exported function is awkward,
  // so we do a small local token fetch through your existing oauth env.
  // But since your lib/caspio.js already handles auth, we’ll reuse it indirectly:
  // We'll call Caspio REST through CASPIO_BASE and Authorization using a token we fetch here.
  const tokenUrl = process.env.CASPIO_TOKEN_URL;
  const clientId = process.env.CASPIO_CLIENT_ID;
  const clientSecret = process.env.CASPIO_CLIENT_SECRET;

  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error("Missing CASPIO_TOKEN_URL / CASPIO_CLIENT_ID / CASPIO_CLIENT_SECRET");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const ct = resp.headers.get("content-type") || "";
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`Token error ${resp.status}: ${text}`);

  if (!ct.includes("application/json")) {
    throw new Error(`Token endpoint not JSON (ct=${ct}): ${text.slice(0, 200)}`);
  }

  const j = JSON.parse(text);
  if (!j?.access_token) throw new Error("Token response missing access_token");
  return j.access_token;
}

async function caspioViewSelect(view, where, selectCsv, limit = 2000, token) {
  const url =
    `${CASPIO_BASE}/rest/v2/views/${encodeURIComponent(view)}/records` +
    `?q.where=${encodeURIComponent(where)}` +
    `&q.limit=${Number(limit)}` +
    `&q.select=${encodeURIComponent(selectCsv)}`;

  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const ct = r.headers.get("content-type") || "";
  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`Caspio view error ${r.status}: ${text.slice(0, 250)}`);
  if (!ct.includes("application/json")) throw new Error(`Caspio view not JSON: ${text.slice(0, 250)}`);

  const j = JSON.parse(text);
  return Array.isArray(j?.Result) ? j.Result : [];
}

async function getPriceStatusSub(priceStatus) {
  const ps = String(priceStatus || "").trim();
  if (!ps) return "";
  const where = `Price_Status='${escapeWhereValue(ps)}'`;
  const rows = await listRecordsByWhere(T_SUBS, where, 1);
  return String(rows?.[0]?.Price_Status_Sub || "").trim();
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const idkey = String(req.query.idkey || req.query.IDKEY || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "MISSING_IDKEY" });

    const reservation = await getReservationByIdKey(idkey);
    if (!reservation) return res.status(404).json({ ok: false, error: "RESERVATION_NOT_FOUND" });

    const billing = await getResBillingEditViewRowByIdKey(idkey).catch(() => null);

    const sessionDate = String(reservation.Session_Date || "").slice(0, 10);
    const whereSess = `BAR2_Sessions_Date='${escapeWhereValue(sessionDate)}'`;

    // ✅ IMPORTANT: explicitly request the fields the UI uses (includes Calendar_Graphic)
    const viewSelect = [
      "BAR2_Sessions_Session_ID",
      "BAR2_Sessions_Date",
      "BAR2_Sessions_Business_Unit",
      "GEN_Business_Units_DBA",
      "BAR2_Primary_Config_Primary_Name",
      "BAR2_Primary_Config_Calendar_Graphic",
      "BAR2_Sessions_Start_Time",
      "BAR2_Sessions_Price_Status",
      "BAR2_Sessions_C_Quant",
      "BAR2_Sessions_Price_Class",
      "BAR2_Sessions_Title",
      "BAR2_Sessions_Supplemental_Text",
      "BAR2_Custom_Session_Info_Content_File",
      "BAR2_Custom_Session_Info_Title",
    ].join(",");

    const token = await getToken();
    const sessionsForDateAll = await caspioViewSelect(V_SESS, whereSess, viewSelect, 2000, token);

    const resBU = String(reservation.Business_Unit || "").trim();
    const sessionsAll = (sessionsForDateAll || []).filter(
      (r) => String(r.BAR2_Sessions_Business_Unit || "").trim() === resBU
    );

    // pricing preload (optional)
    let pricingOptions = [];
    try {
      const curSid = String(reservation.Session_ID || "").trim();
      const curRow = sessionsAll.find((r) => String(r.BAR2_Sessions_Session_ID || "").trim() === curSid);
      const sessPS = String(curRow?.BAR2_Sessions_Price_Status || "").trim();

      let pss = await getPriceStatusSub(sessPS);
      if (!pss && billing) {
        const fallbackPS = String(billing.BAR2_Reservations_SIGMA_C_Price_Status || "").trim();
        pss = await getPriceStatusSub(fallbackPS);
      }

      if (pss) {
        const wherePricing = `Price_Status_Sub='${escapeWhereValue(pss)}'`;
        pricingOptions = await listRecordsByWhere(T_PRICING, wherePricing, 1000);
      }
    } catch {
      pricingOptions = [];
    }

    return res.status(200).json({
      ok: true,
      reservation,
      billing: billing || null,
      sessionsAll,
      pricingOptions,
    });
  } catch (e) {
    console.error("manage-load error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "SERVER_ERROR" });
  }
}
