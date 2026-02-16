// pages/api/txns.js
//
// Weebly -> /api/txns?idkey=...
// Returns transaction history for the given IDKEY.

import { listTransactionsByIdKey } from "../../lib/caspio";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const idkey = req.query.idkey || req.query.IDKEY;
    if (!idkey) return res.status(400).send("Missing idkey");

    const txns = await listTransactionsByIdKey(String(idkey), 500);

    // newest first
    txns.sort((a, b) => {
      const da = Date.parse(a.Transaction_date || a.CreatedAt || "") || 0;
      const db = Date.parse(b.Transaction_date || b.CreatedAt || "") || 0;
      return db - da;
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ txns });
  } catch (err) {
    console.error("TXNS_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Server error");
  }
}
