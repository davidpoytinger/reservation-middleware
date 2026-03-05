// pages/api/customer-cancel-eligibility.js

import { getReservationByIdKey } from "../../lib/caspio";

export default async function handler(req, res) {

  // ---------- CORS ----------
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
  ]);

  const origin = req.headers.origin || "";
  const allowOrigin = allowed.has(origin)
    ? origin
    : "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  // ---------- Request ----------
  try {

    const idkey = String(req.query.idkey || req.query.IDKEY || "").trim();

    if (!idkey) {
      return res.status(400).json({
        ok: false,
        error: "Missing idkey",
      });
    }

    // ---------- Load Reservation ----------
    const reservation = await getReservationByIdKey(idkey);

    if (!reservation) {
      return res.status(404).json({
        ok: false,
        error: "Reservation not found",
      });
    }

    // ---------- Cancel Logic ----------
    // Adjust field name if needed
    const startTime =
      reservation.Session_Start ||
      reservation.Session_Date ||
      reservation.Start_Time ||
      null;

    if (!startTime) {
      return res.status(200).json({
        ok: true,
        eligible: false,
        reason: "NO_START_TIME",
      });
    }

    const start = new Date(startTime);
    const now = new Date();

    const hoursUntilStart = (start - now) / (1000 * 60 * 60);

    const eligible = hoursUntilStart >= 24;

    // ---------- Response ----------
    return res.status(200).json({
      ok: true,
      eligible,
      hoursUntilStart: Number(hoursUntilStart.toFixed(2)),
      startTime,
    });

  } catch (err) {

    console.error("customer-cancel-eligibility error:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "Server error",
    });

  }
}
