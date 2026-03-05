// pages/api/customer-cancel-eligibility.js

import { getReservationByIdKey } from "../../lib/caspio";

/**
 * Tiny in-memory cache per lambda instance (best-effort).
 * Helps reduce duplicate Caspio hits if a tab/script calls repeatedly.
 */
const CACHE_TTL_MS = 30 * 1000;
const cache = globalThis.__sigmaCancelEligCache || (globalThis.__sigmaCancelEligCache = new Map());

function setCors(req, res) {
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
  ]);

  const origin = req.headers.origin || "";
  const allowOrigin = allowed.has(origin) ? origin : "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
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

  // ISO / RFC fallback
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;

  return null;
}

function truthyLocked(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "locked" || s === "lock" || s === "true" || s === "yes" || s === "1";
}

function getCancelWindowHours(reservation) {
  // Try a few likely field names; fall back to 24.
  const candidates = [
    reservation.BAR2_Primary_Config_Cancel_Hour_Window,
    reservation.Cancel_Hour_Window,
    reservation.Cancel_Window_Hours,
    reservation.Cancel_Window_Hrs,
    reservation.CANCEL_WINDOW_HRS,
  ];

  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 24;
}

function getStartTime(reservation) {
  // Try likely candidates
  const candidates = [
    reservation.BAR2_Sessions_Date_Start_Time,
    reservation.Session_Start,
    reservation.Session_Date_Start_Time,
    reservation.Session_Date,
    reservation.Start_Time,
    reservation.Sessions_Start,
  ];

  for (const c of candidates) {
    const d = parseCaspioDateTime(c);
    if (d && !Number.isNaN(d.getTime())) return { raw: c, date: d };
  }
  return { raw: null, date: null };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const idkey = String(req.query.idkey || req.query.IDKEY || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });

    // Best-effort cache
    const cacheKey = `elig:${idkey}`;
    const cached = getCached(cacheKey);
    if (cached) return res.status(200).json(cached);

    const reservation = await getReservationByIdKey(idkey);

    if (!reservation) {
      const payload = { ok: true, eligible: false, reason: "NOT_FOUND" };
      setCached(cacheKey, payload);
      return res.status(200).json(payload);
    }

    // --------- Hard blocks ---------
    const status = String(reservation.Status || reservation.BAR2_Reservations_SIGMA_Status || "")
      .trim()
      .toLowerCase();

    if (status === "cancelled") {
      const payload = { ok: true, eligible: false, reason: "ALREADY_CANCELLED" };
      setCached(cacheKey, payload);
      return res.status(200).json(payload);
    }

    const chargeType = String(reservation.Charge_Type || reservation.BAR2_Reservations_SIGMA_Charge_Type || "")
      .trim()
      .toLowerCase();

    if (chargeType === "pay now") {
      const payload = { ok: true, eligible: false, reason: "PAY_NOW" };
      setCached(cacheKey, payload);
      return res.status(200).json(payload);
    }

    // Support multiple lock field variants
    const lockVal =
      reservation.BAR2_Reservations_SIGMA_Lock ??
      reservation.Lock ??
      reservation.BAR2_Reservations_SIGMA_Lock_Flag ??
      reservation.Lock_Flag ??
      "";

    if (truthyLocked(lockVal)) {
      const payload = { ok: true, eligible: false, reason: "LOCKED" };
      setCached(cacheKey, payload);
      return res.status(200).json(payload);
    }

    // --------- Window check ---------
    const { raw: startTimeRaw, date: startDt } = getStartTime(reservation);
    if (!startDt) {
      const payload = { ok: true, eligible: false, reason: "NO_START_TIME" };
      setCached(cacheKey, payload);
      return res.status(200).json(payload);
    }

    const now = new Date();
    const hoursUntilStart = (startDt.getTime() - now.getTime()) / 36e5;

    // If already started/past
    if (!Number.isFinite(hoursUntilStart) || hoursUntilStart <= 0) {
      const payload = {
        ok: true,
        eligible: false,
        reason: "PAST_START",
        hoursUntilStart: Number((hoursUntilStart || 0).toFixed(2)),
        startTime: startTimeRaw,
      };
      setCached(cacheKey, payload);
      return res.status(200).json(payload);
    }

    const windowHrs = getCancelWindowHours(reservation);

    // Eligible only if OUTSIDE window (strictly greater)
    const eligible = hoursUntilStart > windowHrs;

    const payload = {
      ok: true,
      eligible,
      reason: eligible ? "ELIGIBLE" : "WITHIN_WINDOW",
      cancelWindowHours: windowHrs,
      hoursUntilStart: Number(hoursUntilStart.toFixed(2)),
      startTime: startTimeRaw,
    };

    setCached(cacheKey, payload);
    return res.status(200).json(payload);
  } catch (err) {
    console.error("customer-cancel-eligibility error:", err);

    // Fail-closed (ok:true, eligible:false) so UI can show “unavailable” without blowing up
    return res.status(200).json({
      ok: true,
      eligible: false,
      reason: "ERROR",
      error: err?.message || "Server error",
    });
  }
}
