import { getCaspioAccessToken } from "../../lib/caspio";

async function fetchText(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  return { status: resp.status, text, headers: Object.fromEntries(resp.headers.entries()) };
}

export default async function handler(req, res) {
  try {
    const base = process.env.CASPIO_INTEGRATION_URL?.replace(/\/+$/, "");
    const table = process.env.CASPIO_TABLE;
    if (!base) return res.status(500).json({ error: "Missing CASPIO_INTEGRATION_URL" });
    if (!table) return res.status(500).json({ error: "Missing CASPIO_TABLE" });

    const token = await getCaspioAccessToken();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // Hit the exact same endpoint with GET vs PUT to see what Caspio supports
    const getUrl = `${base}/rest/v2/tables/${encodeURIComponent(table)}/records?q.limit=1`;
    const putUrl = `${base}/rest/v2/tables/${encodeURIComponent(table)}/records?q.where=IDKEY='B9Q9PN8L1M'`;

    const getResp = await fetchText(getUrl, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    const putResp = await fetchText(putUrl, { method: "PUT", headers, body: JSON.stringify({ __probe: "1" }) });

    return res.status(200).json({
      base,
      table,
      get: { url: getUrl, status: getResp.status, bodySnippet: getResp.text.slice(0, 200) },
      put: { url: putUrl, status: putResp.status, bodySnippet: putResp.text.slice(0, 200) },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
