// pages/api/manage-save.js
import {
  escapeWhereValue,
  updateReservationByWhere,
  getReservationByIdKey,
  listViewRecordsByWhere,
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function dateOnly(v) {
  const s = String(v || "").trim();
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const body = req.body || {};
    const idkey = String(body.idkey || body.IDKEY || "").trim();
    const sessionId = String(body.sessionId || "").trim();
    const packageValue = String(body.packageValue || "").trim();
    const packageLabel = String(body.packageLabel || "").trim();

    if (!idkey) return res.status(400).json({ ok: false, error: "Missing idkey" });
    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });
    if (!packageValue) return res.status(400).json({ ok: false, error: "Missing packageValue" });

    const reservation = await getReservationByIdKey(idkey);
    if (!reservation) return res.status(404).json({ ok: false, error: "Reservation Not Found" });

    // Load the session row (from view) to map derived fields
    const sessWhere = `BAR2_Sessions_Session_ID='${escapeWhereValue(sessionId)}'`;
    const sessRows = await listViewRecordsByWhere("SIGMA_VW_Active_Sessions_Manage", sessWhere, 1);
    const sess = sessRows?.[0] || null;
    if (!sess) return res.status(404).json({ ok: false, error: "Session Not Found" });

    const [newCQ, newUnits, newUnitPrice] = packageValue.split("|");

    const mappedItem = String(sess?.BAR2_Primary_Config_Primary_Name || "").trim();
    const mappedPriceClass = String(sess?.BAR2_Sessions_Price_Class || "").trim();
    const mappedTitle = String(sess?.BAR2_Sessions_Title || "").trim();
    const newBU = String(sess?.BAR2_Sessions_Business_Unit || "").trim();
    const newDate = dateOnly(sess?.BAR2_Sessions_Date);

    const where = `IDKEY='${escapeWhereValue(idkey)}' AND Type='Reservation'`;

    const payload = {
      // contact fields
      First_Name: String(body.First_Name || "").trim(),
      Last_Name: String(body.Last_Name || "").trim(),
      Email: String(body.Email || "").trim(),
      Phone_Number: String(body.Phone_Number || "").trim(),
      Cust_Notes: String(body.Cust_Notes || "").trim(),

      // session + pricing
      Session_ID: sessionId,
      C_Quant: newCQ,
      Units: newUnits,
      Unit_Price: newUnitPrice,

      Item: mappedItem,
      Price_Class: mappedPriceClass,
      Sessions_Title: mappedTitle,

      Session_Date: newDate,
      Business_Unit: newBU,
    };

    // only write People_Text if nonblank
    if (packageLabel) payload.People_Text = packageLabel;

    await updateReservationByWhere(where, payload);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("manage-save error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
