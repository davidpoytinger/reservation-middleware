// pages/api/manage-load.js
import {
  escapeWhereValue,
  listViewRecordsByWhere,
  listRecordsByWhere,
  getReservationByIdKey,
  updateReservationByWhere,
} from "../../lib/caspio";

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

function dateOnly(v) {
  const s = String(v || "").trim();
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function parseCaspioDateTime(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  if (!s) return null;

  // MM/DD/YYYY [HH:MM[:SS] [AM|PM]]
  const m = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i
  );
  if (m) {
    const mo = parseInt(m[1], 10);
    const da = parseInt(m[2], 10);
    const yr = parseInt(m[3], 10);

    let hr = parseInt(m[4] || "0", 10);
    const mi = parseInt(m[5] || "0", 10);
    const se = parseInt(m[6] || "0", 10);
    const ap = (m[7] || "").toUpperCase();

    if (ap) {
      if (ap === "AM" && hr === 12) hr = 0;
      if (ap === "PM" && hr !== 12) hr += 12;
    }
    return new Date(yr, mo - 1, da, hr, mi, se, 0);
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- Pricing mapping helpers (same logic as your front-end used) ---
async function priceStatusHasMapping(priceStatus) {
  const ps = String(priceStatus || "").trim();
  if (!ps) return false;
  const where = `Price_Status='${escapeWhereValue(ps)}'`;
  const rows = await listRecordsByWhere("BAR2_PricingV2_Subs", where, 1);
  return !!rows?.[0]?.Price_Status_Sub;
}

async function getPriceStatusSub(priceStatus) {
  const ps = String(priceStatus || "").trim();
  if (!ps) return "";
  const where = `Price_Status='${escapeWhereValue(ps)}'`;
  const rows = await listRecordsByWhere("BAR2_PricingV2_Subs", where, 1);
  return String(rows?.[0]?.Price_Status_Sub || "").trim();
}

async function loadPricingOptions(priceStatus, capCQ = null) {
  const pss = await getPriceStatusSub(priceStatus);
  if (!pss) return [];

  const where = `Price_Status_Sub='${escapeWhereValue(pss)}'`;
  const rows = await listRecordsByWhere(
    "BAR2_PricingV2",
    where,
    1000
  );

  // map -> UI options
  const opts = (rows || [])
    .map((r) => {
      const cq = r.C_Quant;
      const unit = r.Unit;
      const price = r.Price;
      const label = String(r.Description || "").trim() || `${cq} / ${unit} / ${price}`;
      const value = `${cq}|${unit}|${price}`;
      return { label, value, C_Quant: cq, Unit: unit, Price: price };
    })
    .filter((o) => {
      if (capCQ == null) return true;
      const n = Number(o.C_Quant);
      return Number.isFinite(n) ? n <= capCQ : true;
    });

  // sort by Unit numeric if possible
  opts.sort((a, b) => {
    const au = Number(String(a.Unit));
    const bu = Number(String(b.Unit));
    if (Number.isFinite(au) && Number.isFinite(bu)) return au - bu;
    return String(a.label).localeCompare(String(b.label));
  });

  return opts;
}

// --- lock rules server-side (mirrors your JS) ---
function computeLocks({ reservation, billing }) {
  const locks = {
    lockMain: false,
    lockContact: false,
    lockMessage: "",
    lockSubMessage: "",
  };

  const rs = String(reservation?.Status || "").trim().toLowerCase();
  const billingLockVal = String(billing?.Lock || "").trim().toLowerCase();
  const chargeType = String(reservation?.Charge_Type || "").trim().toLowerCase();

  const startRaw = billing?.BAR2_Sessions_Date_Start_Time || null;
  const startDt = parseCaspioDateTime(startRaw);

  let hrsUntil = null;
  if (startDt && !Number.isNaN(startDt.getTime())) {
    hrsUntil = (startDt.getTime() - Date.now()) / 36e5;
  }

  if (rs === "cancelled") {
    locks.lockMain = true;
    locks.lockContact = true;
    locks.lockMessage = "This reservation has been cancelled and may not be edited.";
    return locks;
  }

  if (billingLockVal === "locked") {
    locks.lockMain = true;
    locks.lockContact = true;
    locks.lockMessage =
      "This reservation has been locked and can no longer be edited. Please contact our sales team for support.";
    return locks;
  }

  if (chargeType === "pay now") {
    locks.lockMain = true;
    locks.lockMessage = "This reservation has been paid for in advance and may not be edited.";

    const allowContact =
      typeof hrsUntil === "number" && Number.isFinite(hrsUntil) ? hrsUntil > 24 : true;

    locks.lockContact = !allowContact;
    locks.lockSubMessage = allowContact
      ? "You may update your contact information until 24 hours prior to the start time."
      : "Contact information changes are not available within 24 hours of the start time.";

    return locks;
  }

  const windowHrs = Number(billing?.BAR2_Primary_Config_Cancel_Hour_Window);
  if (
    Number.isFinite(windowHrs) &&
    windowHrs >= 0 &&
    typeof hrsUntil === "number" &&
    Number.isFinite(hrsUntil) &&
    hrsUntil <= windowHrs
  ) {
    locks.lockMain = true;
    locks.lockContact = true;
    locks.lockMessage = `This reservation is within the ${windowHrs}-hour edit cutoff and is locked.`;
    return locks;
  }

  return locks;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const idkey = String(req.query.idkey || req.query.IDKEY || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });

    // Optional lightweight mode for pricing refresh (used by UI when time changes)
    const mode = String(req.query.mode || "").trim().toLowerCase();
    const sessionIdQ = String(req.query.sessionId || "").trim();

    // Always load reservation (for original CQ + fallback price status)
    const reservation = await getReservationByIdKey(idkey);
    if (!reservation) return res.status(404).json({ ok: false, error: "Reservation Not Found" });

    const originalCQ = Number(reservation?.C_Quant ?? 0) || 0;
    const originalPackageKey = `${reservation?.C_Quant}|${reservation?.Units}|${reservation?.Unit_Price}`;

    // Billing view row (for start time, cancel window, lock flag, concept label, People_Text, etc.)
    const billWhere = `IDKEY='${escapeWhereValue(idkey)}'`;
    const billingRows = await listViewRecordsByWhere("SIGMA_VW_Res_Billing_Edit", billWhere, 1);
    const billing = billingRows?.[0] || null;

    const locks = computeLocks({ reservation, billing });

    // If pricing mode: just return pricing options for sessionId
    if (mode === "pricing") {
      if (!sessionIdQ) return res.status(400).json({ ok: false, error: "Missing sessionId" });

      const sessWhere = `BAR2_Sessions_Session_ID='${escapeWhereValue(sessionIdQ)}'`;
      const sessRows = await listViewRecordsByWhere("SIGMA_VW_Active_Sessions_Manage", sessWhere, 1);
      const sess = sessRows?.[0] || null;
      if (!sess) return res.status(404).json({ ok: false, error: "Session Not Found" });

      // determine price status (same-session fallback uses reservation C price status if needed)
      let ps = String(sess?.BAR2_Sessions_Price_Status || "").trim();
      const fallback = String(billing?.BAR2_Reservations_SIGMA_C_Price_Status || "").trim();

      if (!(await priceStatusHasMapping(ps))) {
        if (fallback && (await priceStatusHasMapping(fallback))) ps = fallback;
      }

      if (!(await priceStatusHasMapping(ps))) {
        return res.status(200).json({ ok: true, pricingOptions: [] });
      }

      // cap logic: if selecting current session, allow original CQ even if session is "full"
      const sessCQ = Number(sess?.BAR2_Sessions_C_Quant ?? 0);
      const cap = sessionIdQ === String(reservation?.Session_ID || "").trim()
        ? Math.max(originalCQ, Number.isFinite(sessCQ) ? sessCQ : 0)
        : (Number.isFinite(sessCQ) ? sessCQ : 0);

      const pricingOptions = await loadPricingOptions(ps, cap);
      return res.status(200).json({ ok: true, pricingOptions });
    }

    // Full load (sessions + initial pricing)
    const resDate = dateOnly(reservation?.Session_Date);
    const resBU = String(reservation?.Business_Unit || "").trim();
    const sessWhereAll = `BAR2_Sessions_Date='${escapeWhereValue(resDate)}'`;
    const sessRowsAll = await listViewRecordsByWhere("SIGMA_VW_Active_Sessions_Manage", sessWhereAll, 2000);

    const sessionsForBU = (sessRowsAll || []).filter(
      (r) => String(r?.BAR2_Sessions_Business_Unit || "").trim() === resBU
    );

    const currentSid = String(reservation?.Session_ID || "").trim();

    const sessions = sessionsForBU.map((r) => {
      const soldOut = Number(r?.BAR2_Sessions_C_Quant) === 0;
      const sessionId = String(r?.BAR2_Sessions_Session_ID || "").trim();
      return {
        sessionId,
        type: String(r?.BAR2_Primary_Config_Primary_Name || "").trim(),
        startTime: String(r?.BAR2_Sessions_Start_Time || "").trim(),
        priceStatus: String(r?.BAR2_Sessions_Price_Status || "").trim(),
        soldOut,
        isCurrent: sessionId && sessionId === currentSid,
        graphicUrl: String(r?.BAR2_Primary_Config_Calendar_Graphic || "").trim() || "",
        // extras if you want later:
        title: String(r?.BAR2_Sessions_Title || "").trim(),
      };
    });

    // Determine initial selection from current session
    const curSess = sessions.find((s) => s.sessionId === currentSid) || null;
    const selection = {
      type: curSess?.type || "",
      startTime: curSess?.startTime || "",
      sessionId: curSess?.sessionId || "",
      priceStatus: curSess?.priceStatus || "",
    };

    // Initial pricing options
    let initialPS = selection.priceStatus || "";
    const fallback = String(billing?.BAR2_Reservations_SIGMA_C_Price_Status || "").trim();

    if (!(await priceStatusHasMapping(initialPS))) {
      if (fallback && (await priceStatusHasMapping(fallback))) initialPS = fallback;
    }

    let pricingOptions = [];
    if (await priceStatusHasMapping(initialPS)) {
      // cap logic for current session
      const curRowRaw = sessionsForBU.find(
        (r) => String(r?.BAR2_Sessions_Session_ID || "").trim() === currentSid
      );
      const sessCQ = Number(curRowRaw?.BAR2_Sessions_C_Quant ?? 0);
      const cap = Math.max(originalCQ, Number.isFinite(sessCQ) ? sessCQ : 0);
      pricingOptions = await loadPricingOptions(initialPS, cap);
    }

    const conceptLabel = String(billing?.GEN_Business_Units_DBA || "").trim();

    return res.status(200).json({
      ok: true,
      conceptLabel,
      locks,
      reservation: {
        RES_ID: reservation?.RES_ID,
        Status: reservation?.Status,
        Charge_Type: reservation?.Charge_Type,
        Session_ID: reservation?.Session_ID,
        Session_Date: reservation?.Session_Date,
        Business_Unit: reservation?.Business_Unit,

        First_Name: reservation?.First_Name,
        Last_Name: reservation?.Last_Name,
        Email: reservation?.Email,
        Phone_Number: reservation?.Phone_Number,
        Cust_Notes: reservation?.Cust_Notes,

        originalPackageKey,
        originalCQ,
      },
      billing: {
        People_Text: billing?.BAR2_Reservations_SIGMA_People_Text || "",
        Lock: billing?.Lock || "",
        BAR2_Sessions_Date_Start_Time: billing?.BAR2_Sessions_Date_Start_Time || "",
        BAR2_Primary_Config_Cancel_Hour_Window: billing?.BAR2_Primary_Config_Cancel_Hour_Window ?? null,
        BAR2_Reservations_SIGMA_C_Price_Status: billing?.BAR2_Reservations_SIGMA_C_Price_Status || "",
      },
      sessions,
      selection,
      pricingOptions,
    });
  } catch (e) {
    console.error("manage-load error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
