// pages/api/debug-view.js
//
// Quick sanity check endpoint to confirm your Vercel -> Caspio OAuth -> VIEW read is working.
// Usage:
//   GET /api/debug-view?idkey=O6TROMB27K
//
// Optional:
//   &fields=IDKEY,BAR2_Email_Design_Email_Content
//   &includeRow=1   (returns a redacted row payload)
//
// Env (uses your existing caspio.js):
//   CASPIO_RES_BILLING_VIEW = SIGMA_VW_Res_Billing_Edit (optional; default is that)
//   CASPIO_INTEGRATION_URL / CASPIO_TOKEN_URL / CASPIO_CLIENT_ID / CASPIO_CLIENT_SECRET
//
// IMPORTANT:
// - Keep this endpoint private. It can reveal structure/values.
// - Delete/disable it after debugging.

import {
  getResBillingEditViewRowByIdKey,
  getCaspioAccessToken,
} from "../../lib/caspio";

function setCors(res, origin) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://reservebarsandrec.com";
  const allowOrigin = origin && origin === allowed ? origin : allowed;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function redactValue(v) {
  if (v === null || v === undefined) return v;

  // Keep numbers/booleans as-is
  if (typeof v === "number" || typeof v === "boolean") return v;

  const s = String(v);

  // Redact emails
  if (s.includes("@")) {
    const [u, d] = s.split("@");
    return `${(u || "").slice(0, 2)}***@${d || "***"}`;
  }

  // Redact long strings (keep short preview)
  if (s.length > 80) return `${s.slice(0, 40)}…(len=${s.length})`;

  // Redact card-like sequences (very rough)
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 12) return `***REDACTED_DIGITS(len=${digits.length})***`;

  return s;
}

function redactObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = redactValue(v);
  }
  return out;
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const idkey = req.query?.idkey || req.query?.IDKEY || req.query?.IdKey;
  const viewName = process.env.CASPIO_RES_BILLING_VIEW || "SIGMA_VW_Res_Billing_Edit";

  if (!idkey) {
    return res.status(200).json({
      ok: true,
      hint: "Add ?idkey=YOUR_IDKEY",
      example: "/api/debug-view?idkey=O6TROMB27K",
      viewName,
    });
  }

  // Optional: fields=comma,separated,list
  const fieldsParam = req.query?.fields;
  const fields = fieldsParam
    ? String(fieldsParam)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const includeRow = String(req.query?.includeRow || "") === "1";

  try {
    // Token test (helps isolate OAuth issues)
    await getCaspioAccessToken();

    const row = await getResBillingEditViewRowByIdKey(idkey);

    if (!row) {
      return res.status(200).json({
        ok: true,
        viewName,
        idkey,
        found: false,
        message:
          "No row returned. If you expect a row, verify the view has an IDKEY column and that it matches this IDKEY exactly. Also confirm the REST API profile has permission to this view.",
      });
    }

    const allKeys = Object.keys(row);
    const selected =
      fields && fields.length
        ? Object.fromEntries(fields.map((f) => [f, row[f]]))
        : null;

    const payload = {
      ok: true,
      viewName,
      idkey,
      found: true,
      keysCount: allKeys.length,
      keysPreview: allKeys.slice(0, 50),
      // Always show these two useful bits if present
      important: {
        IDKEY: row.IDKEY ?? null,
        BAR2_Email_Design_Email_Content:
          row.BAR2_Email_Design_Email_Content ? redactValue(row.BAR2_Email_Design_Email_Content) : null,
      },
    };

    if (selected) payload.selected = redactObject(selected);
    if (includeRow) payload.row = redactObject(row);

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(200).json({
      ok: false,
      viewName,
      idkey,
      error: e?.message || String(e),
      note:
        "If the error mentions 403/404 for the view, update your Caspio REST API profile permissions to include the view SIGMA_VW_Res_Billing_Edit.",
    });
  }
}
