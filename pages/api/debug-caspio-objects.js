// pages/api/debug-caspio-objects.js
//
// Lists table/view objects available via Caspio REST for your OAuth profile.
// Usage:
//   GET /api/debug-caspio-objects
//   GET /api/debug-caspio-objects?contains=billing
//
// Delete this after debugging.

import { getCaspioAccessToken } from "../../lib/caspio";

function normalizeBase(url) {
  return String(url).replace(/\/+$/, "");
}

function caspioIntegrationBaseUrl() {
  const integration = process.env.CASPIO_INTEGRATION_URL;
  if (integration) return normalizeBase(integration);
  const acct = process.env.CASPIO_ACCOUNT;
  if (!acct) throw new Error("Missing CASPIO_INTEGRATION_URL (or CASPIO_ACCOUNT fallback)");
  return `https://${acct}.caspio.com`;
}

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { resp, text, json };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const contains = String(req.query?.contains || "").toLowerCase();

  try {
    const token = await getCaspioAccessToken();
    const base = caspioIntegrationBaseUrl();

    // Try v2 then v3 (your other endpoints use both)
const candidates = [
  `${base}/rest/v2/tables`,
  `${base}/rest/v3/tables`,
  `${base}/rest/v2/views`,  // ✅ NEW
  `${base}/rest/v3/views`,  // ✅ NEW
];

    let lastErr = null;

    for (const url of candidates) {
      const { resp, text, json } = await fetchJson(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!resp.ok) {
        lastErr = { url, status: resp.status, text };
        continue;
      }

      // Caspio returns a structure like { Result: [ { Name: "...", ... }, ... ] } (commonly)
      const resultArr = json?.Result || json?.result || json?.Results || [];

      const names = resultArr
        .map((x) => x?.Name || x?.name || x?.TableName || x?.tableName)
        .filter(Boolean);

      const filtered = contains
        ? names.filter((n) => String(n).toLowerCase().includes(contains))
        : names;

      return res.status(200).json({
        ok: true,
        tried: url,
        contains: contains || null,
        count: filtered.length,
        names: filtered.slice(0, 250),
        note: "Use ?contains=billing (or vw) to narrow. Delete this endpoint after debugging.",
      });
    }

    return res.status(200).json({
      ok: false,
      error: "Could not list tables from Caspio REST",
      lastErr,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
