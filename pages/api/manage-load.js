// pages/api/manage-load.js
import {
  getReservationByIdKey,
  getResBillingEditViewRowByIdKey,
  listViewRecordsByWhere,
  escapeWhereValue,
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function dateOnly(v) {
  if (!v) return "";
  const s = String(v).trim();
  // ISO: 2026-03-07T00:00:00 -> 2026-03-07
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // MM/DD/YYYY -> YYYY-MM-DD
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    const yy = String(m[3]);
    return `${yy}-${mm}-${dd}`;
  }
  return s;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const idkey = String(req.query.idkey || req.query.IDKEY || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });

    // 1) Reservation row (table)
    const reservation = await getReservationByIdKey(idkey);
    if (!reservation) return res.status(404).json({ ok: false, error: "RES_NOT_FOUND" });

    const resDate = dateOnly(reservation.Session_Date);
    const resBU = String(reservation.Business_Unit || "").trim();

    // 2) Billing view row (view) - for People_Text, DBA label, window hours, etc.
    const billing = await getResBillingEditViewRowByIdKey(idkey).catch(() => null);

    // Prefer People_Text snapshot from billing view; fall back to reservation.People_Text if you store it there
    const peopleText =
      String(billing?.BAR2_Reservations_SIGMA_People_Text || "").trim() ||
      String(reservation?.People_Text || "").trim();

    const dbaLabel =
      String(billing?.GEN_Business_Units_DBA || "").trim() ||
      String(billing?.BAR2_Reservations_SIGMA_Business_Unit_DBA || "").trim(); // optional fallback if you have one

    // 3) Sessions for that date (view)
    const V_SESS = process.env.CASPIO_SESSIONS_VIEW || "SIGMA_VW_Active_Sessions_Manage";
    if (!resDate) {
      return res.status(200).json({
        ok: true,
        reservation,
        billing,
        meta: {
          resDate,
          resBU,
          warning: "Missing Session_Date on reservation; sessions not loaded.",
        },
        sessions: [],
        peopleText,
        dbaLabel,
      });
    }

    // IMPORTANT: escape for where clause
    const safeDate = escapeWhereValue(resDate);

    // First: date-only query
    const baseWhere = `BAR2_Sessions_Date='${safeDate}'`;
    const sessionsAllForDate = await listViewRecordsByWhere(V_SESS, baseWhere, 2000);

    // Try BU filter if BU exists
    let sessionsForRes = sessionsAllForDate;
    if (resBU) {
      const bu = String(resBU).trim();
      sessionsForRes = sessionsAllForDate.filter(
        (r) => String(r.BAR2_Sessions_Business_Unit || "").trim() === bu
      );

      // ✅ Fallback: if BU-filter resulted in nothing, revert to all sessions for the date
      if (!sessionsForRes.length) {
        sessionsForRes = sessionsAllForDate;
      }
    }

    return res.status(200).json({
      ok: true,
      reservation,
      billing,
      peopleText,
      dbaLabel,
      meta: {
        resDate,
        resBU,
        sessionsForDate: sessionsAllForDate.length,
        sessionsAfterBUFilter: sessionsForRes.length,
        usedBUFilter: !!resBU,
      },
      sessions: sessionsForRes,
    });
  } catch (e) {
    console.error("manage-load error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
