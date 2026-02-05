// lib/caspio.js
//
// Caspio REST helper with:
// - OAuth client_credentials token
// - Integration URL support (recommended)
// - Automatic REST version fallback (v3 -> v2) to avoid 404 surprises
//
// ENV VARS:
//   CASPIO_INTEGRATION_URL (recommended) e.g. https://c2xxxx.caspio.com
//   CASPIO_TOKEN_URL       (recommended) e.g. https://c2xxxx.caspio.com/oauth/token
//   CASPIO_ACCOUNT         (fallback)    e.g. headspacetrivia
//   CASPIO_CLIENT_ID
//   CASPIO_CLIENT_SECRET
//   CASPIO_TABLE           e.g. BAR2_Reservations_SIGMA
//   CASPIO_KEY_FIELD       e.g. IDKEY

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
  const token = Buffer.from(`${id}:${secret}`).toString("base64");
  return `Basic ${token}`;
}

function escapeWhereValue(v) {
  // Caspio uses single quotes for text values in q.where
  return String(v).replaceAll("'", "''");
}

function recordsUrl(table, version, queryParams) {
  const base = caspioIntegrationBaseUrl();
  const qp = queryParams ? `?${queryParams}` : "";
  return `${base}/rest/${version}/tables/${encodeURIComponent(table)}/records${qp}`;
}

async function fetchText(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  return { resp, text };
}

let cachedToken = null;
let cachedTokenExpMs = 0;

export async function getCaspioAccessToken() {
  // Simple in-memory cache (persists for warm Vercel instances)
  if (cachedToken && Date.now() < cachedTokenExpMs) return cachedToken;

  const url = caspioTokenUrl();

  const { resp, text } = await fetchText(url, {
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
  // expires_in is seconds; subtract 60s as a safety margin
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

  // Try v3 first, then v2 if v3 isn't available on this account/host
  for (const version of ["v3", "v2"]) {
    const url = recordsUrl(table, version, qp);

    const { resp, text } = await fetchText(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (resp.status === 404) {
      // This REST version/host combo doesn't exist; try the next version
      continue;
    }

    if (!resp.ok) {
      throw new Error(`Caspio GET error ${resp.status}: ${text}`);
    }

    const json = JSON.parse(text);
    const row = json?.Result?.[0];
    if (!row) throw new Error(`No reservation found for ${where}`);
    return row;
  }

  // If both versions 404, your base URL is wrong.
  throw new Error(
    "Caspio GET error 404: REST endpoint not found. Set CASPIO_INTEGRATION_URL and CASPIO_TOKEN_URL from your Caspio Web Services Profile."
  );
}

export async function updateReservationByWhere(whereClause, payload) {
  const table = process.env.CASPIO_TABLE;
  if (!table) throw new Error("Missing CASPIO_TABLE");

  const qp = `q.where=${encodeURIComponent(whereClause)}`;
  const accessToken = await getCaspioAccessToken();

  // Try v3 first, then v2
  for (const version of ["v3", "v2"]) {
    const url = recordsUrl(table, version, qp);

    const { resp, text } = await fetchText(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (resp.status === 404) continue;

    if (!resp.ok) {
      throw new Error(`Caspio update error ${resp.status}: ${text}`);
    }

    // Caspio often returns empty body on PUT; parse if present
    try {
      return text ? JSON.parse(text) : { ok: true };
    } catch {
      return { ok: true, raw: text };
    }
  }

  throw new Error(
    "Caspio update error 404: REST endpoint not found. Set CASPIO_INTEGRATION_URL and CASPIO_TOKEN_URL from your Caspio Web Services Profile."
  );
}
