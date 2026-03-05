// pages/api/manage-save-contact.js
import { escapeWhereValue, updateReservationByWhere, getReservationByIdKey } from "../../lib/caspio";

function setCors(req, res) {
  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
  ]);
  const origin = req.headers.origin || "";
  const allowOrigin = allowed.has(origin) ? origin : "https://www.reservebarsandrec.com";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const body = req.body || {};
    const idkey = String(body.idkey || body.IDKEY || "").trim();
    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });

    // Ensure reservation exists
    const reservation = await getReservationByIdKey(idkey);
    if (!reservation) return res.status(404).json({ ok: false, error: "Reservation Not Found" });

    const where = `IDKEY='${escapeWhereValue(idkey)}' AND Type='Reservation'`;

    const payload = {
      First_Name: String(body.First_Name || "").trim(),
      Last_Name: String(body.Last_Name || "").trim(),
      Email: String(body.Email || "").trim(),
      Phone_Number: String(body.Phone_Number || "").trim(),
      Cust_Notes: String(body.Cust_Notes || "").trim(),
    };

    await updateReservationByWhere(where, payload);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("manage-save-contact error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
