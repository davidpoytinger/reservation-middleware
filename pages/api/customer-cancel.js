// pages/api/customer-cancel.js
//
// Customer-facing cancellation endpoint (SAFE)
// - Browser never receives Caspio token
// - Enforces eligibility rules server-side
//
// Expects: POST { idkey: "..." }
//
// Behavior:
// - Blocks Pay Now
// - Blocks within cancel window (hours) before start time
// - Blocks if already cancelled
// - If eligible: sets BAR2_Reservations_SIGMA.Status = "Cancelled"

import { getCaspioAccessToken } from "../../lib/caspio"; // <-- if you have this helper
// If you DON'T have getCaspioAccessToken, swap this import to your existing token helper.

const CASPIO_BASE = "https://c0gfs257.caspio.com/rest/v2";

const ALLOWED_ORIGINS = new Set([
  "https://reservebarsandrec.com",
  "https://www.reservebarsandrec.com",
]);

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function escWhereValue(s) {
  return String(s || "").replace(/'/g, "''");
}

function parseDateAny(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  // ISO
  if (s.includes("T")) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // "YYYY-MM-DD HH:mm:ss"
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)) {
    const d = new Date(s.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function caspioFetchJson(path, token, options = {}) {
  const r = await fetch(`${CASPIO_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  const text = await r.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {}

  if (!r.ok) {
    const msg = j?.Message || j?.error_description || j?.error || text || String(r.status);
    throw new Error(String(msg).slice(0, 500));
  }

  return j;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const idkey = String(body.idkey || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });

    // 1) Get Caspio token server-side
    const token =
      typeof getCaspioAccessToken === "function"
        ? await getCaspioAccessToken()
        : null;

    if (!token) {
      // If your helper is named differently, replace the import & logic above.
      return res.status(500).json({ ok: false, error: "Server token helper not configured" });
    }

    // 2) Fetch billing view fields needed for eligibility
    const V_BILL = "SIGMA_VW_Res_Billing_Edit";
    const VB_IDKEY = "IDKEY";
    const VB_CHARGE_TYPE = "BAR2_Reservations_SIGMA_Charge_Type";
    const VB_CANCEL_HOUR_WIN = "BAR2_Primary_Config_Cancel_Hour_Window";
    const VB_DATE_START_TIME = "BAR2_Sessions_Date_Start_Time";

    const whereBill = `${VB_IDKEY}='${escWhereValue(idkey)}'`;
    const selectBill = [VB_CHARGE_TYPE, VB_CANCEL_HOUR_WIN, VB_DATE_START_TIME].join(",");
    const billPath =
      `/views/${V_BILL}/records` +
      `?q.where=${encodeURIComponent(whereBill)}` +
      `&q.limit=1` +
      `&q.select=${encodeURIComponent(selectBill)}`;

    const billJ = await caspioFetchJson(billPath, token);
    const billing = billJ.Result?.[0];
    if (!billing) return res.status(404).json({ ok: false, error: "Reservation not found (billing view)" });

    // 3) Fetch reservation row fields needed for status checks + update WHERE
    const T_RES = "BAR2_Reservations_SIGMA";
    const F_IDKEY = "IDKEY";
    const F_TYPE = "Type";
    const TYPE_RESERVATION = "Reservation";
    const F_RES_STATUS = "Status";

    const whereRes =
      `${F_IDKEY}='${escWhereValue(idkey)}' AND ${F_TYPE}='${escWhereValue(TYPE_RESERVATION)}'`;

    const resPath =
      `/tables/${T_RES}/records` +
      `?q.where=${encodeURIComponent(whereRes)}` +
      `&q.limit=1` +
      `&q.select=${encodeURIComponent(F_RES_STATUS)}`;

    const resJ = await caspioFetchJson(resPath, token);
    const reservation = resJ.Result?.[0];
    if (!reservation) return res.status(404).json({ ok: false, error: "Reservation not found" });

    // 4) Eligibility
    const status = String(reservation?.[F_RES_STATUS] || "").trim().toLowerCase();
    if (status === "cancelled") {
      return res.status(200).json({ ok: true, cancelled: true, message: "Already cancelled." });
    }

    const chargeType = String(billing?.[VB_CHARGE_TYPE] || "").trim().toLowerCase();
    if (chargeType === "pay now") {
      return res.status(403).json({ ok: false, error: "Paid in advance — cannot cancel online." });
    }

    const startDt = parseDateAny(billing?.[VB_DATE_START_TIME]);
    if (!startDt) {
      return res.status(403).json({ ok: false, error: "Missing start time — cannot evaluate cancellation window." });
    }

    const winHrsNum = Number(billing?.[VB_CANCEL_HOUR_WIN]);
    const winHours = Number.isFinite(winHrsNum) ? winHrsNum : 0;

    const now = new Date();
    const cutoffMs = startDt.getTime() - winHours * 60 * 60 * 1000;
    if (now.getTime() >= cutoffMs) {
      return res.status(403).json({
        ok: false,
        error: `Within ${winHours} hour cancellation window — please call.`,
      });
    }

    // 5) Perform cancellation
    const putPath = `/tables/${T_RES}/records?q.where=${encodeURIComponent(whereRes)}`;
    await caspioFetchJson(putPath, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [F_RES_STATUS]: "Cancelled" }),
    });

    return res.status(200).json({ ok: true, cancelled: true });

  } catch (e) {
    console.error("customer-cancel error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
