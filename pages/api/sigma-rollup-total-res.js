// pages/api/sigma-rollup-total-res.js

const ADDON_TABLE = "SIGMA_BAR3_ADDONS";   // <-- change to your real addon source table
const ADDON_TOTAL_FIELD = "Total";         // <-- field to sum on addons
const ADDON_RESID_FIELD = "RES_ID";        // <-- addon table's RES_ID field

let _tokenCache = { token: null, exp: 0 };
const nowSec = () => Math.floor(Date.now() / 1000);

async function getCaspioToken() {
  if (_tokenCache.token && _tokenCache.exp > nowSec() + 30) return _tokenCache.token;

  const base = process.env.CASPIO_BASE_URL;
  const tokenUrl = process.env.CASPIO_AUTH_TOKEN_URL || `${base}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.CASPIO_CLIENT_ID,
    client_secret: process.env.CASPIO_CLIENT_SECRET,
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) throw new Error(`Caspio token error (${resp.status}): ${await resp.text()}`);

  const json = await resp.json();
  _tokenCache.token = json.access_token;
  _tokenCache.exp = nowSec() + (json.expires_in || 3600);
  return _tokenCache.token;
}

async function caspioFetch(path, { method = "GET", body } = {}) {
  const token = await getCaspioToken();
  const base = process.env.CASPIO_BASE_URL;

  const resp = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Caspio ${method} failed (${resp.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

const esc = (v) => String(v).replace(/'/g, "''");
const toNum = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

export default async function handler(req, res) {
  try {
    // Security
    const auth = req.headers.authorization || "";
    const expected = `Bearer ${process.env.SIGMA_WEBHOOK_SECRET}`;
    if (!process.env.SIGMA_WEBHOOK_SECRET || auth !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body || {};
    const data = payload.Data || payload.data || payload.record || {};

    const RES_ID = data.RES_ID;
    if (!RES_ID) return res.status(400).json({ error: "Missing RES_ID" });

    // Pull core values from the reservation update itself
    const IDKEY = data.IDKEY ?? null;
    const Business_Unit = data.Business_Unit ?? null;
    const Status = data.Status ?? null;
    const Subtotal_Primary = toNum(data.Total);

    // Sum addon totals from addon table (change to your real source)
    const addonWhere = `${ADDON_RESID_FIELD}='${esc(RES_ID)}'`;
    const addonResp = await caspioFetch(
      `/rest/v2/tables/${ADDON_TABLE}/records?q.where=${encodeURIComponent(addonWhere)}&q.limit=1000`
    );
    const addonRows = addonResp?.Result || [];
    const Subtotal_Addon = addonRows.reduce((s, r) => s + toNum(r[ADDON_TOTAL_FIELD]), 0);

    const Total = Subtotal_Primary + Subtotal_Addon;

    // Upsert into SIGMA_BAR3_TOTAL_RES by RES_ID
    const where = `RES_ID='${esc(RES_ID)}'`;
    const existing = await caspioFetch(
      `/rest/v2/tables/SIGMA_BAR3_TOTAL_RES/records?q.where=${encodeURIComponent(where)}&q.limit=1`
    );
    const exists = (existing?.Result || [])[0];

    const body = {
      RES_ID,
      IDKEY,
      Business_Unit,
      Status,
      Subtotal_Primary,
      Subtotal_Addon,
      Total,
    };

    if (exists) {
      await caspioFetch(
        `/rest/v2/tables/SIGMA_BAR3_TOTAL_RES/records?q.where=${encodeURIComponent(where)}`,
        { method: "PUT", body }
      );
      return res.status(200).json({ ok: true, upsert: "updated", RES_ID, Total });
    } else {
      await caspioFetch(`/rest/v2/tables/SIGMA_BAR3_TOTAL_RES/records`, { method: "POST", body });
      return res.status(200).json({ ok: true, upsert: "inserted", RES_ID, Total });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", detail: String(err.message || err) });
  }
}
