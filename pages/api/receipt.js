// pages/api/receipt.js
//
// Weebly -> /api/receipt?txn_id=123
// Returns one transaction row by TXN_ID.

import { findOneByWhere } from "../../lib/caspio";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const txnId = req.query.txn_id || req.query.TXN_ID;
    if (!txnId) return res.status(400).send("Missing txn_id");

    const table = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
    const where = `TXN_ID=${Number(txnId)}`;
    if (!Number.isFinite(Number(txnId))) return res.status(400).send("Invalid txn_id");

    const row = await findOneByWhere(table, where);
    if (!row) return res.status(404).send("Transaction not found");

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ txn: row });
  } catch (err) {
    console.error("RECEIPT_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Server error");
  }
}
