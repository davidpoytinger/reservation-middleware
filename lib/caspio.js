// lib/caspio.js
//
// Drop-in Caspio helper:
// - OAuth client_credentials token
// - Uses CASPIO_INTEGRATION_URL / CASPIO_TOKEN_URL (recommended)
// - Falls back to CASPIO_ACCOUNT if integration URL not set
// - GET: tries REST v3 then v2
// - UPDATE: updates by IDKEY using path-based PUT (more compatible than PUT-with-where)
//
// Required env vars:
//   CASPIO_INTEGRATION_URL = https://c0gfs257.caspio.com   (recommended)
//   CASPIO_TOKEN_URL       = https://c0gfs257.caspio.com/oauth/token (recommended)
//   CASPIO_ACCOUNT         = headspacetrivia (fallback only)
//   CASPIO_CLIENT_ID
//   CASPIO_CLIENT_SECRET
//   CASPIO_TABLE           = BAR2_Reservations_SIGMA
//   CASPIO_KEY_FIELD       = IDKEY   (this file assumes IDKEY updates)

function normalizeBase(url) {
  return String(url).replace(/\/+$/, "");
}

function caspioIntegrationBaseUrl() {
  const integration = process.env.CASPIO_INTEGRATION_URL;
  if (integration) return normalizeBase(integration);

  const acct = process.env.CASPIO_ACCOUNT;
  if (!acct) {
    throw new Error("Missing CASPIO_INTEGRATION_URL (or CASPIO_ACCOUNT fallback)");
  }
  return `https://${acct}.caspio.com`;
}

function caspioTokenUrl() {
  const tokenUrl = process.env.CASPIO_TOKEN_URL;
  if (tokenUrl) return tokenUrl;
  return `${caspioIntegrationBaseUrl()}/oauth/token`;
}

function basicAuthHeader() {
  const id = process.env.CASPIO_CLIENT_ID;
  const secret = process.env.CASPIO_CLIENT_SECRET;
  if (!id) throw new Error("Missing CASPIO_CLIENT_ID");
  if (!secret) throw new Error("Missing CASPIO_CLIENT_SECRET");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

function escapeWhereValue(v) {
  // Caspio q.where uses single quotes for text values; escape embedded quotes by doubling them.
  return String(v).replaceAll("'", "''");
}

function recordsBase(table, version) {
  return `${caspioIntegrationBaseUrl()}/rest/${version}/tables/${encodeURIComponent(table)}/records`;
}

async function fetchText(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  return { resp, text };
}

// Small in-memory token cache (works on warm Vercel instances)
let cachedToken = null;
let cachedTokenExpMs = 0;

export async function getCaspioAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpMs) return cachedToken;

  const { resp, text } = await fetchText(caspioTokenUrl(), {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });

  if (!resp.ok) {
    throw new Error(`Caspio token error ${resp.status}: ${text}`);
  }

  const json = JSON.parse(text);
  if (!json.access_token) throw new Error("Caspio token response missing access_token");

  cachedToken = json.access_token;
  const expiresInSec = Number(json.expires_in || 900);
  cachedTokenExpMs = Date.now() + Math.max(0, (expiresInSec - 60)) * 1000;

  return cachedToken;
}

export async function getReservationByIdKey(idKey) {
  const table = process.env.CASPIO_TABLE;
  if (!table) throw new Error("Missing CASPIO_TABLE");

  const keyField = process.env.CASPIO_KEY_FIELD || "IDKEY";
  const where = `${keyField}='${escapeWhereValue(idKey)}'`;
  const qp = `q.where=${encodeURIComponent(where)}&q.limit=1`;

  const accessToken = await getCaspioAccessToken();

  for (const version of ["v3", "v2"]) {
    const url = `${recordsBase(table, version)}?${qp}`;

    const { resp, text } = await fetchText(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (resp.status === 404) continue;
    if (!resp.ok) throw new Error(`Caspio GET error ${resp.status}: ${text}`);

    const json = JSON.parse(text);
    const row = json?.Result?.[0];
    if (!row) throw new Error(`No reservation found for ${where}`);
    return row;
  }

  throw new Error(
    "Caspio GET error 404: REST endpoint not found. Check CASPIO_INTEGRATION_URL / CASPIO_TOKEN_URL."
  );
}

/**
 * Update by IDKEY using path-based endpoint:
 *   PUT /rest/v3/tables/{table}/records/{idkey}
 * Falls back to v2 if needed.
 */
export async function updateReservationByIdKey(idKey, payload) {
  const table = process.env.CASPIO_TABLE;
  if (!table) throw new Error("Missing CASPIO_TABLE");

  const keyField = process.env.CASPIO_KEY_FIELD || "IDKEY";
  if (keyField !== "IDKEY") {
    throw new Error(`updateReservationByIdKey expects CASPIO_KEY_FIELD=IDKEY (got ${keyField})`);
  }

  const accessToken = await getCaspioAccessToken();

  for (const version of ["v3", "v2"]) {
    const url = `${recordsBase(table, version)}/${encodeURIComponent(String(idKey))}`;

    const { resp, text } = await fetchText(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (resp.status === 404) continue;
    if (!resp.ok) throw new Error(`Caspio update error ${resp.status}: ${text}`);

    try {
      return text ? JSON.parse(text) : { ok: true };
    } catch {
      return { ok: true, raw: text };
    }
  }

  throw new Error(
    "Caspio update error 404: update endpoint not found. Check CASPIO_INTEGRATION_URL / CASPIO_TOKEN_URL."
  );
}
