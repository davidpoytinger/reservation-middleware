// pages/api/txns.js
//
// Customer portal -> /api/txns?idkey=...
// Returns transaction history for the given IDKEY.
// Includes CORS so it can be called from reservebarsandrec.com (Weebly).

import { listTransactionsByIdKey } from "../../lib/caspio";

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
    const idkey = req.query.idkey || req.query.IDKEY || req.query.IdKey;
    if (!idkey) return res.status(400).send("Missing idkey");

    const txns = await listTransactionsByIdKey(String(idkey), 500);

    // newest first
    txns.sort((a, b) => {
      const da = Date.parse(a.Transaction_date || a.CreatedAt || "") || 0;
      const db = Date.parse(b.Transaction_date || b.CreatedAt || "") || 0;
      return db - da;
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ txns });
  } catch (err) {
    console.error("TXNS_FAILED", err?.message || err);
    return res.status(500).send(err?.message || "Server error");
  }
}
