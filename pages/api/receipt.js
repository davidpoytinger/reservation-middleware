// pages/api/receipt.js
//
// Customer receipt -> /api/receipt?txn_id=123
// Includes CORS so it can be called from reservebarsandrec.com (Weebly).

import { findOneByWhere } from "../../lib/caspio";

function setCors(req, res) {
  const allowed = [
    "https://reservebarsandrec.com",
    "https://www.reservebarsandrec.com",
  ];

  const origin = req.headers.origin;
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0];

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const txnId = req.query.txn_id || req.query.TXN_ID;
    if (!txnId) return res.status(400).send("Missing txn_id");

    const n = Number(txnId);
    if (!Number.isFinite(n)) return res.status(400).send("Invalid txn_id");

    const table = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
    const row = await findOneByWhere(table, `TXN_ID=${n}`);
    if (!row) return res.status(404).send("Transaction not found");

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ txn: row });
  } catch (err) {
    console.error("RECEIPT_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Server error");
  }
}
