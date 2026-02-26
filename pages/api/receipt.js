// pages/api/receipt.js
//
// Weebly -> /api/receipt?txn_id=...
// Looks up a transaction by TXN_ID (stored as text in Caspio).
// Includes CORS for reservebarsandrec.com.

import { findOneByWhereInTable, escapeWhereValue } from "../../lib/caspio";

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
    const txnIdRaw = req.query.txn_id || req.query.TXN_ID || req.query.txnid || "";
    const txnId = String(txnIdRaw).trim();

    if (!txnId) return res.status(400).send("Missing txn_id");

    // TXN_ID is NVARCHAR in Caspio, so ALWAYS quote it.
    const table = process.env.CASPIO_TXN_TABLE || "SIGMA_BAR3_Transactions";
    const where = `TXN_ID='${escapeWhereValue(txnId)}'`;

    const row = await findOneByWhereInTable(table, where);
    if (!row) return res.status(404).send("Transaction not found");

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ txn: row });
  } catch (err) {
    console.error("RECEIPT_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Server error");
  }
}
