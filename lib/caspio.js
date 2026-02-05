function caspioBaseUrl() {
  // Prefer the Web Services Profile Integration URL (most reliable)
  const integrationUrl = process.env.CASPIO_INTEGRATION_URL;
  if (integrationUrl) return integrationUrl.replace(/\/+$/, "");

  // Fallback to subdomain style
  const acct = process.env.CASPIO_ACCOUNT;
  if (!acct) throw new Error("Missing CASPIO_ACCOUNT (or CASPIO_INTEGRATION_URL)");
  return `https://${acct}.caspio.com`;
}


function basicAuthHeader() {
  const id = process.env.CASPIO_CLIENT_ID;
  const secret = process.env.CASPIO_CLIENT_SECRET;
  if (!id) throw new Error("Missing CASPIO_CLIENT_ID");
  if (!secret) throw new Error("Missing CASPIO_CLIENT_SECRET");
  const token = Buffer.from(`${id}:${secret}`).toString("base64");
  return `Basic ${token}`;
}

export async function getCaspioAccessToken() {
  const url = `${caspioBaseUrl()}/oauth/token`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Caspio token error ${resp.status}: ${text}`);
  }

  const json = JSON.parse(text);
  if (!json.access_token) throw new Error("Caspio token response missing access_token");
  return json.access_token;
}

export async function updateReservationByWhere(whereClause, payload) {
  const table = process.env.CASPIO_TABLE;
  if (!table) throw new Error("Missing CASPIO_TABLE");

  // REST API v3 uses /rest/v3/tables/{table}/records and q.where params. :contentReference[oaicite:6]{index=6}
  const url =
    `${caspioBaseUrl()}/rest/v3/tables/${encodeURIComponent(table)}/records` +
    `?q.where=${encodeURIComponent(whereClause)}`;

  const accessToken = await getCaspioAccessToken();

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Caspio update error ${resp.status}: ${text}`);
  }

  // Caspio often returns empty body on PUT; if it returns JSON, parse it.
  try {
    return text ? JSON.parse(text) : { ok: true };
  } catch {
    return { ok: true, raw: text };
  }
}
export async function getReservationByIdKey(idKey) {
  const table = process.env.CASPIO_TABLE;
  if (!table) throw new Error("Missing CASPIO_TABLE");

  const keyField = process.env.CASPIO_KEY_FIELD || "IDKEY";
  const where = `${keyField}='${String(idKey).replaceAll("'", "''")}'`;

  const url =
    `${caspioBaseUrl()}/rest/v3/tables/${encodeURIComponent(table)}/records` +
    `?q.where=${encodeURIComponent(where)}&q.limit=1`;

  const accessToken = await getCaspioAccessToken();

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Caspio GET error ${resp.status}: ${text}`);

  const json = JSON.parse(text);
  const row = json?.Result?.[0];
  if (!row) throw new Error(`No reservation found for ${where}`);

  return row;
}

