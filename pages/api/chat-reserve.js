// pages/api/chat-reserve.js
//
// Stateless SIGMA reservation chatbot endpoint.
// Fixes "Thread not found" by NOT using in-memory Maps.
// We store state in a signed token returned to the client.
//
// Env var (recommended):
//   CHAT_STATE_SECRET = long random string
//
// Uses existing routes:
//   GET  /api/sessions?date=YYYY-MM-DD&bu=optional
//   GET  /api/pricing?price_status=...
//   POST /api/reserve
//
// Returns: { ok, threadToken, reply, choices, next, state }

import crypto from "crypto";

const BASE = "https://reservation-middleware2.vercel.app"; // or process.env.MIDDLEWARE_BASE
const SESSIONS_URL = `${BASE}/api/sessions`;
const PRICING_URL = `${BASE}/api/pricing`;
const RESERVE_URL = `${BASE}/api/reserve`;
const PAYSTART_URL = `${BASE}/api/paystart`;

const SECRET = process.env.CHAT_STATE_SECRET || ""; // strongly recommended

function json(res, code, obj) {
  res.status(code).setHeader("Content-Type", "application/json").end(JSON.stringify(obj));
}
function setCors(req, res) {
  const origin = req.headers.origin || "*";

  // If you don't use cookies/credentials, you can allow "*".
  // Safer option: allow just your Weebly domains:
  // const allow = new Set(["https://www.yoursite.com", "https://yoursite.weebly.com"]);
  // const useOrigin = allow.has(origin) ? origin : "https://www.yoursite.com";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysISO(iso, add) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + add);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeBU(s) {
  return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

function parseTaxPercentToRate(val, fallback = 0.055) {
  const raw = String(val ?? "").trim().replace("%", "");
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n > 1) return n / 100;
  return n;
}

function parseAutoGrat(val) {
  const n = Number(String(val ?? "").trim());
  if (!Number.isFinite(n) || n < 0) return { type: "rate", rate: 0 };
  if (n > 0 && n <= 1) return { type: "rate", rate: n };
  if (n > 1 && n <= 100) return { type: "rate", rate: n / 100 };
  return { type: "flat", amount: n };
}

function round2(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Number(x.toFixed(2)) : 0;
}

function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "$0.00";
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function base64urlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64urlDecode(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return Buffer.from(s + pad, "base64");
}

function sign(data) {
  if (!SECRET) return ""; // will still work, just unsigned
  return base64urlEncode(crypto.createHmac("sha256", SECRET).update(data).digest());
}

function encodeThread(state) {
  const payload = JSON.stringify({
    v: 1,
    iat: Date.now(),
    state,
  });
  const body = base64urlEncode(payload);
  const sig = sign(body);
  return sig ? `${body}.${sig}` : body; // unsigned fallback
}

function decodeThread(token) {
  const t = oneLine(token);
  if (!t) return null;

  // Signed token: body.sig
  const parts = t.split(".");
  const body = parts[0];
  const sig = parts[1] || "";

  // Verify signature if we have a secret and token is signed
  if (SECRET && sig) {
    const expected = sign(body);
    // timingSafeEqual requires same length buffers
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
  }

  try {
    const payload = base64urlDecode(body).toString("utf8");
    const obj = JSON.parse(payload);
    return obj?.state || null;
  } catch {
    return null;
  }
}

async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, cache: "no-store" });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) throw new Error(j?.error || j?.Message || text || `HTTP ${r.status}`);
  return j;
}

// ---- Caspio view field names ----
const V_DATE = "BAR2_Sessions_Date";
const V_BU = "BAR2_Sessions_Business_Unit";
const V_DBA = "GEN_Business_Units_DBA";
const V_ITEM = "BAR2_Primary_Config_Primary_Name";
const V_START = "BAR2_Sessions_Start_Time";
const V_PRICE_STATUS = "BAR2_Sessions_Price_Status";
const V_SESSION_ID = "BAR2_Sessions_Session_ID";
const V_AVAIL_CQ = "BAR2_Sessions_C_Quant";
const V_PRICE_CLASS = "BAR2_Sessions_Price_Class";
const V_TITLE = "BAR2_Sessions_Title";
const V_BOOKING_FEE = "BAR2_Primary_Config_BookingFee";
const V_AUTO_GRAT = "BAR2_Primary_Config_Auto_Gratuity_SIGMA";
const V_TAX_PCT = "GEN_Business_Units_Tax_Percentage";

function isSoldOut(row) {
  const n = Number(row?.[V_AVAIL_CQ]);
  return Number.isFinite(n) ? n === 0 : false;
}

// ---- Lightweight parsing helpers ----
function parseChargeType(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("pay now") || t.includes("pay full") || t.includes("paid")) return "Pay Now";
  if (t.includes("hold") || t.includes("24") || t.includes("fee")) return "24 Hour Hold Fee";
  return "";
}

function parseDate(text) {
  const t = String(text || "").toLowerCase().trim();
  const today = todayISO();
  if (t.includes("today")) return today;
  if (t.includes("tomorrow")) return addDaysISO(today, 1);

  // Accept "Saturday" etc: pick next occurrence
  const dow = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const idx = dow.findIndex(d => t.includes(d));
  if (idx >= 0) {
    const now = new Date();
    const cur = now.getDay();
    let add = (idx - cur + 7) % 7;
    if (add === 0) add = 7; // "saturday" means next saturday, not today
    return addDaysISO(today, add);
  }

  const m = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

function parseEmail(text) {
  const m = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : "";
}

function parsePhone(text) {
  const digits = String(text || "").replace(/\D/g, "");
  if (digits.length >= 10) return digits;
  return "";
}

function parseName(text) {
  const t = oneLine(text);
  const m = t.match(/(?:i am|i'm|this is)?\s*([A-Za-z'-]{2,})\s+([A-Za-z'-]{2,})/i);
  if (!m) return { first: "", last: "" };
  return { first: m[1], last: m[2] };
}

function computeAmounts({ units, unitPrice, taxRate, autoGratRaw, chargeType, bookingFee }) {
  const u = Number(units);
  const p = Number(unitPrice);
  const base = (Number.isFinite(u) ? u : 0) * (Number.isFinite(p) ? p : 0);

  const tr = Number.isFinite(Number(taxRate)) ? Number(taxRate) : 0.055;
  const ag = parseAutoGrat(autoGratRaw);

  const gratuity = ag.type === "flat" ? ag.amount : base * ag.rate;
  const tax = (base + gratuity) * tr; // tax on base + gratuity (your requirement)

  let due = 0;
  if (chargeType === "24 Hour Hold Fee") due = Number(bookingFee || 0);
  if (chargeType === "Pay Now") due = base + gratuity + tax;

  return {
    base: round2(base),
    gratuity: round2(gratuity),
    tax: round2(tax),
    dueToday: round2(due),
  };
}

function stepName(state) {
  if (!state.date) return "date";
  if (!state.bu) return "business";
  if (!state.type) return "type";
  if (!state.time) return "time";
  if (!state.package) return "package";
  if (!state.chargeType) return "chargeType";
  if (!state.policyAgreed) return "policy";
  if (!state.first || !state.last) return "name";
  if (!state.email) return "email";
  if (!state.phone) return "phone";
  return "confirm";
}

function summarize(state) {
  const bits = [];
  if (state.type) bits.push(state.type);
  if (state.date) bits.push(state.date);
  if (state.dba) bits.push(state.dba);
  if (state.time) bits.push(state.time);
  if (state.packageLabel) bits.push(state.packageLabel);
  return bits.join(" • ");
}

function defaultState() {
  return {
    date: "",
    bu: "",
    dba: "",
    type: "",
    time: "",
    sessionId: "",
    priceStatus: "",
    priceClass: "",
    sessionsTitle: "",
    bookingFee: 0,
    autoGratRaw: 0,
    taxRate: 0.055,

    package: "",
    packageLabel: "",
    units: "",
    cQuant: "",
    unitPrice: 0,

    chargeType: "",
    policyAgreed: false,
    first: "",
    last: "",
    email: "",
    phone: "",
    notes: "",
  };
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  // Simple GET health check
  if (req.method === "GET") {
    return json(res, 200, { ok: true, route: "chat-reserve", stateless: true });
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  try {
    const body = req.body || {};
    const message = oneLine(body.message);
    const action = body.action; // may be JSON string or object
    const threadToken = oneLine(body.threadToken);

    // Decode existing state or start new
    const state = decodeThread(threadToken) || defaultState();

    // ---- Apply quick parses from free-text ----
    if (message) {
      const dt = parseDate(message);
      if (dt) state.date = dt;

      const ct = parseChargeType(message);
      if (ct) state.chargeType = ct;

      const em = parseEmail(message);
      if (em) state.email = em;

      const ph = parsePhone(message);
      if (ph) state.phone = ph;

      const nm = parseName(message);
      if (nm.first && nm.last) { state.first = nm.first; state.last = nm.last; }

      if (message.toLowerCase().includes("agree")) state.policyAgreed = true;
    }

    // ---- Handle structured button actions ----
    let act = null;
    try { act = typeof action === "string" ? JSON.parse(action) : action; } catch { act = null; }

    if (act?.kind === "pickBusiness") {
      state.bu = normalizeBU(act.bu);
      state.dba = oneLine(act.dba);
      state.type = ""; state.time = ""; state.sessionId = ""; state.priceStatus = "";
      state.package = ""; state.packageLabel = ""; state.units = ""; state.cQuant = ""; state.unitPrice = 0;
    }

    if (act?.kind === "pickType") {
      state.type = oneLine(act.type);
      state.time = ""; state.sessionId = ""; state.priceStatus = "";
      state.package = ""; state.packageLabel = ""; state.units = ""; state.cQuant = ""; state.unitPrice = 0;
    }

    if (act?.kind === "pickTime") {
      state.time = oneLine(act.time);
      state.sessionId = oneLine(act.sessionId);
      state.priceStatus = oneLine(act.priceStatus);
      state.priceClass = oneLine(act.priceClass);
      state.sessionsTitle = oneLine(act.sessionsTitle);
      state.bookingFee = Number(act.bookingFee || 0) || 0;
      state.autoGratRaw = act.autoGratRaw ?? 0;
      state.taxRate = parseTaxPercentToRate(act.taxPct, 0.055);
      state.package = ""; state.packageLabel = ""; state.units = ""; state.cQuant = ""; state.unitPrice = 0;
    }

    if (act?.kind === "pickPackage") {
      state.package = oneLine(act.key || `${act.cQuant}|${act.units}|${act.unitPrice}`);
      state.packageLabel = oneLine(act.label);
      state.units = oneLine(act.units);
      state.cQuant = oneLine(act.cQuant);
      state.unitPrice = Number(act.unitPrice || 0) || 0;
    }

    if (act?.kind === "setChargeType") state.chargeType = oneLine(act.chargeType);
    if (act?.kind === "agreePolicy") state.policyAgreed = true;
    if (act?.kind === "setNotes") state.notes = oneLine(act.notes);

    const next = stepName(state);
    let reply = "";
    let choices = [];

    const btn = (label, actionObj) => ({ label, action: JSON.stringify(actionObj) });

    // date
    if (next === "date") {
      reply = "What date are you booking for? (Say “today”, “tomorrow”, “Saturday”, or type YYYY-MM-DD.)";
      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
    }

    // business
    if (next === "business") {
      const sess = await fetchJSON(`${SESSIONS_URL}?date=${encodeURIComponent(state.date)}`);
      const rows = sess?.rows || [];

      const map = new Map();
      for (const r of rows) {
        const bu = oneLine(r?.[V_BU]);
        const dba = oneLine(r?.[V_DBA]);
        if (bu && dba && !map.has(bu)) map.set(bu, dba);
      }

      const list = Array.from(map.entries()).map(([bu, dba]) => ({ bu, dba }))
        .sort((a, b) => a.dba.localeCompare(b.dba));

      reply = `Got it — ${state.date}. Which location/business?`;
      choices = list.slice(0, 12).map((x) => btn(x.dba, { kind: "pickBusiness", bu: x.bu, dba: x.dba }));

      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
    }

    // type
    if (next === "type") {
      const bu = state.bu ? `&bu=${encodeURIComponent(state.bu)}` : "";
      const sess = await fetchJSON(`${SESSIONS_URL}?date=${encodeURIComponent(state.date)}${bu}`);
      const rows = (sess?.rows || []).filter((r) => !isSoldOut(r));

      const counts = new Map();
      for (const r of rows) {
        const type = oneLine(r?.[V_ITEM]);
        if (!type) continue;
        counts.set(type, (counts.get(type) || 0) + 1);
      }

      const types = Array.from(counts.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => a.type.localeCompare(b.type));

      reply = `Great — ${state.dba || state.bu}. What experience are you booking?`;
      choices = types.slice(0, 12).map((t) => btn(`${t.type} (${t.count})`, { kind: "pickType", type: t.type }));

      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
    }

    // time
    if (next === "time") {
      const bu = state.bu ? `&bu=${encodeURIComponent(state.bu)}` : "";
      const sess = await fetchJSON(`${SESSIONS_URL}?date=${encodeURIComponent(state.date)}${bu}`);
      const rows = (sess?.rows || []).filter((r) => oneLine(r?.[V_ITEM]) === state.type);

      const times = rows
        .map((r) => ({
          time: oneLine(r?.[V_START]),
          sessionId: oneLine(r?.[V_SESSION_ID]),
          priceStatus: oneLine(r?.[V_PRICE_STATUS]),
          priceClass: oneLine(r?.[V_PRICE_CLASS]),
          sessionsTitle: oneLine(r?.[V_TITLE]),
          bookingFee: Number(r?.[V_BOOKING_FEE] || 0) || 0,
          autoGratRaw: r?.[V_AUTO_GRAT],
          taxPct: r?.[V_TAX_PCT],
          soldOut: isSoldOut(r),
        }))
        .filter((x) => x.time && x.sessionId)
        .sort((a, b) => a.time.localeCompare(b.time));

      reply = `Which start time for ${state.type} on ${state.date}?`;
      choices = times.filter((x) => !x.soldOut).slice(0, 14).map((x) =>
        btn(x.time, {
          kind: "pickTime",
          time: x.time,
          sessionId: x.sessionId,
          priceStatus: x.priceStatus,
          priceClass: x.priceClass,
          sessionsTitle: x.sessionsTitle,
          bookingFee: x.bookingFee,
          autoGratRaw: x.autoGratRaw,
          taxPct: x.taxPct,
        })
      );

      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
    }

    // package
    if (next === "package") {
      const pr = await fetchJSON(`${PRICING_URL}?price_status=${encodeURIComponent(state.priceStatus)}`);
      const rows = pr?.rows || [];

      const options = rows
        .map((r) => ({
          label: oneLine(r.Description) || `${r.Unit} people`,
          units: oneLine(r.Unit),
          cQuant: oneLine(r.C_Quant),
          unitPrice: Number(r.Price || 0) || 0,
          key: `${r.C_Quant}|${r.Unit}|${r.Price}`,
        }))
        .filter((o) => o.units && o.cQuant && Number.isFinite(o.unitPrice))
        .sort((a, b) => Number(a.units) - Number(b.units));

      reply = "How many people?";
      choices = options.slice(0, 12).map((o) =>
        btn(`${o.label} — ${money(o.unitPrice)} / person`, {
          kind: "pickPackage",
          key: o.key,
          label: o.label,
          units: o.units,
          cQuant: o.cQuant,
          unitPrice: o.unitPrice,
        })
      );

      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
    }

    // charge type
    if (next === "chargeType") {
      reply = "Payment choice?";
      choices = [
        btn("24 Hour Hold Fee", { kind: "setChargeType", chargeType: "24 Hour Hold Fee" }),
        btn("Pay Now", { kind: "setChargeType", chargeType: "Pay Now" }),
      ];
      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
    }

    // policy
    if (next === "policy") {
      reply =
        state.chargeType === "Pay Now"
          ? "Pay Now policy: non-refundable after booking. Reply “I agree” to continue."
          : "Hold Fee policy: cancel up to 24 hours prior without penalty. Reply “I agree” to continue.";
      choices = [btn("I agree", { kind: "agreePolicy" })];

      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
    }

    if (next === "name") {
      reply = "What’s your first and last name?";
      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
    }
    if (next === "email") {
      reply = "What email should we send the confirmation to?";
      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
    }
    if (next === "phone") {
      reply = "What’s the best phone number for the reservation?";
      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
    }

    // confirm -> reserve + pay url
    if (next === "confirm") {
      const amounts = computeAmounts({
        units: state.units,
        unitPrice: state.unitPrice,
        taxRate: state.taxRate,
        autoGratRaw: state.autoGratRaw,
        chargeType: state.chargeType,
        bookingFee: state.bookingFee,
      });

      if (!(amounts.dueToday > 0)) throw new Error("Due today must be > 0.");

      const peopleText = state.units ? `${state.units} people` : "";

      const reserveBody = {
        First_Name: state.first,
        Last_Name: state.last,
        Email: state.email,
        Phone_Number: state.phone,

        Cancelation_Policy: "Agreed",
        Charge_Type: state.chargeType,
        Cust_Notes: state.notes || "",

        Business_Unit: state.bu,
        Session_Date: state.date,
        Session_ID: state.sessionId,
        Item: state.type,
        Price_Class: state.priceClass,
        Sessions_Title: state.sessionsTitle,

        C_Quant: state.cQuant,
        Units: state.units,
        Unit_Price: String(state.unitPrice),

        People_Text: peopleText,
        BookingFeeAmount: amounts.dueToday,

        Tax_Rate: Number.isFinite(Number(state.taxRate)) ? Number(state.taxRate) : 0.055,
      };

      const created = await fetchJSON(RESERVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reserveBody),
      });

      if (!created?.ok || !created?.idkey) throw new Error("Reservation insert failed.");

      const idkey = created.idkey;

      const params = new URLSearchParams();
      params.set("idkey", idkey);

      if (state.chargeType === "Pay Now") {
        params.set("base_amount", String(amounts.base.toFixed(2)));
        params.set("tax_amount", String(amounts.tax.toFixed(2)));
        params.set("auto_gratuity", String(amounts.gratuity.toFixed(2)));
        params.set("fee_amount", "0");
      } else {
        params.set("base_amount", "0");
        params.set("tax_amount", "0");
        params.set("auto_gratuity", "0");
        params.set("fee_amount", String(Number(state.bookingFee || 0).toFixed(2)));
      }

      const payUrl = `${PAYSTART_URL}?${params.toString()}`;

      reply =
        `Perfect. Here’s what I’m booking:\n` +
        `• ${summarize(state)}\n` +
        `• Due today: ${money(amounts.dueToday)}\n\n` +
        `Tap “Proceed to payment” to complete it.`;

      choices = [{ label: "Proceed to payment", href: payUrl }];

      // New token (state can be kept, but booking is done)
      const newToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next: "done", state: { ...state, amounts, idkey } });
    }

    // fallback
    reply = "Tell me what you’re trying to book (date, location, experience), and I’ll guide you.";
    const newToken = encodeThread(state);
    return json(res, 200, { ok: true, threadToken: newToken, reply, choices, next, state });
  } catch (err) {
    return json(res, 200, { ok: false, error: String(err?.message || err) });
  }
}
