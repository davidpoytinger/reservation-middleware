// pages/api/caspio-health.js
import { listRecordsByWhere } from "../../lib/caspio";

export default async function handler(req, res) {
  try {
    // read-only, smallest possible call
    const rows = await listRecordsByWhere("BAR2_Reservations_SIGMA", "IDKEY<>''", 1);
    return res.status(200).json({ ok: true, sample: rows?.[0] || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
