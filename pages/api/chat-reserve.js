// pages/api/chat-reserve.js
//
// Hybrid “translator + concierge” chat endpoint:
// - NO OpenAI key required
// - Deterministic: calls your existing /api/sessions, /api/pricing, /api/reserve, /api/paystart
// - Always returns { ok:true, reply:string, choices:[] } so UI never renders "undefined"

import crypto from "crypto";

// In-memory thread store (fine for v1 on serverless; resets across cold starts)
const THREADS = globalThis.__SIGMA_CHAT_THREADS__ || new Map();
globalThis.__SIGMA_CHAT_THREADS__ = THREADS;

// ---- CORS ----
function setCors(res, origin) {
  const envAllowed = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowed = new Set([
    "https://www.reservebarsandrec.com",
    "https://reservebarsandrec.com",
    ...envAllowed,
  ]);

  let allowOrigin;
  if (!origin || origin === "null") allowOrigin = "*";
  else if (allowed.has(origin)) allowOrigin = origin;
  else allowOrigin = "https://www.reservebarsandrec.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  if (allowOrigin !== "*") res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

function json(res, code, obj) {
  res.status(code).setHeader("Content-Type", "application/json").end(JSON.stringify(obj));
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizeBU(s) {
  return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
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

function makeThreadId() {
  return crypto.randomBytes(10).toString("hex");
}

function getThread(threadId) {
  const id = String(threadId || "").trim();
  if (!id) return null;
  return THREADS.get(id) || null;
}

function setThread(threadId, data) {
  THREADS.set(threadId, data);
}

// Build absolute base URL for internal same-app calls (no hardcoding)
function baseFromReq(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`;
}

async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, cache: "no-store" });
  const text = await r.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = {};
  }
  if (!r.ok) throw new Error(j?.error || j?.Message || text || `HTTP ${r.status}`);
  return j;
}

// ---- Caspio view field names (match your UI) ----
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

// ---- Minimal free-text parsing (buttons do most work) ----
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
  const tax = base * tr;

  const ag = parseAutoGrat(autoGratRaw);
  const gratuity = ag.type === "flat" ? ag.amount : base * ag.rate;

  let due = 0;
  if (chargeType === "24 Hour Hold Fee") due = Number(bookingFee || 0);
  if (chargeType === "Pay Now") due = base + tax + gratuity;

  return {
    base: round2(base),
    tax: round2(tax),
    gratuity: round2(gratuity),
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

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") {
    return json(res, 200, { ok: true, route: "chat-reserve" });
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  const BASE = baseFromReq(req);
  const SESSIONS_URL = `${BASE}/api/sessions`;
  const PRICING_URL = `${BASE}/api/pricing`;
  const RESERVE_URL = `${BASE}/api/reserve`;
  const PAYSTART_URL = `${BASE}/api/paystart`;

  try {
    const body = req.body || {};
    const message = oneLine(body.message);
    let action = body.action; // may be JSON string
    let threadId = oneLine(body.threadId);

    // Create thread if needed
    if (!threadId) {
      threadId = makeThreadId();
      setThread(threadId, {
        threadId,
        createdAt: Date.now(),

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
      });
    }

    const state = getThread(threadId);
    if (!state) throw new Error("Thread not found");

    // quick parse free-text
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
      if (nm.first && nm.last) {
        state.first = nm.first;
        state.last = nm.last;
      }

      if (message.toLowerCase().includes("agree")) state.policyAgreed = true;
    }

    // Parse structured actions
    let act = null;
    try {
      act = typeof action === "string" ? JSON.parse(action) : action;
    } catch {
      act = null;
    }

    const resetDownstreamFromBusiness = () => {
      state.type = "";
      state.time = "";
      state.sessionId = "";
      state.priceStatus = "";
      state.priceClass = "";
      state.sessionsTitle = "";
      state.bookingFee = 0;
      state.autoGratRaw = 0;
      state.taxRate = 0.055;

      state.package = "";
      state.packageLabel = "";
      state.units = "";
      state.cQuant = "";
      state.unitPrice = 0;
    };

    const resetDownstreamFromType = () => {
      state.time = "";
      state.sessionId = "";
      state.priceStatus = "";
      state.priceClass = "";
      state.sessionsTitle = "";
      state.bookingFee = 0;
      state.autoGratRaw = 0;
      state.taxRate = 0.055;

      state.package = "";
      state.packageLabel = "";
      state.units = "";
      state.cQuant = "";
      state.unitPrice = 0;
    };

    const resetDownstreamFromTime = () => {
      state.package = "";
      state.packageLabel = "";
      state.units = "";
      state.cQuant = "";
      state.unitPrice = 0;
    };

    if (act?.kind === "pickBusiness") {
      state.bu = normalizeBU(act.bu);
      state.dba = oneLine(act.dba);
      resetDownstreamFromBusiness();
    }
    if (act?.kind === "pickType") {
      state.type = oneLine(act.type);
      resetDownstreamFromType();
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
      resetDownstreamFromTime();
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

    // Ensure saved
    setThread(threadId, state);

    // Helpers for response shape (prevents undefined)
    const respond = ({ reply = "", choices = [], next = "", extraState = null }) => {
      return json(res, 200, {
        ok: true,
        threadId,
        reply: String(reply ?? "OK"),
        choices: Array.isArray(choices) ? choices : [],
        next: String(next || ""),
        state: extraState ? extraState : { ...state },
      });
    };

    const btn = (label, actionObj) => ({ label, action: JSON.stringify(actionObj) });

    const next = stepName(state);

    // 0) If user just opened chat (empty message/action), start properly
    if (!message && !act) {
      return respond({
        reply: "Hi! I can book your reservation. What date are you looking for? (Say “today”, “tomorrow”, or YYYY-MM-DD.)",
        choices: [],
        next: "date",
      });
    }

    // 1) DATE
    if (next === "date") {
      return respond({
        reply: "What date are you booking for? You can say “today”, “tomorrow”, or type YYYY-MM-DD.",
        choices: [],
        next,
      });
    }

    // 2) BUSINESS
    if (next === "business") {
      const sess = await fetchJSON(`${SESSIONS_URL}?date=${encodeURIComponent(state.date)}`);
      const rows = sess?.rows || [];

      const map = new Map();
      for (const r of rows) {
        const bu = oneLine(r?.[V_BU]);
        const dba = oneLine(r?.[V_DBA]);
        if (bu && dba && !map.has(bu)) map.set(bu, dba);
      }

      const list = Array.from(map.entries())
        .map(([bu, dba]) => ({ bu, dba }))
        .sort((a, b) => a.dba.localeCompare(b.dba));

      return respond({
        reply: `Got it — ${state.date}. Which location/business?`,
        choices: list.slice(0, 12).map((x) => btn(x.dba, { kind: "pickBusiness", bu: x.bu, dba: x.dba })),
        next,
      });
    }

    // 3) TYPE
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

      return respond({
        reply: `Great — ${state.dba || state.bu}. What experience are you booking?`,
        choices: types.slice(0, 12).map((t) => btn(`${t.type} (${t.count} times)`, { kind: "pickType", type: t.type })),
        next,
      });
    }

    // 4) TIME
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
        .filter((x) => x.time && x.sessionId && !x.soldOut)
        .sort((a, b) => a.time.localeCompare(b.time));

      return respond({
        reply: `Which start time for ${state.type} on ${state.date}?`,
        choices: times.slice(0, 14).map((x) =>
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
        ),
        next,
      });
    }

    // 5) PACKAGE
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

      return respond({
        reply: "How many people? Pick a group option:",
        choices: options.slice(0, 12).map((o) =>
          btn(`${o.label} — ${money(o.unitPrice)} / person`, {
            kind: "pickPackage",
            key: o.key,
            label: o.label,
            units: o.units,
            cQuant: o.cQuant,
            unitPrice: o.unitPrice,
          })
        ),
        next,
      });
    }

    // 6) CHARGE TYPE
    if (next === "chargeType") {
      return respond({
        reply: "Payment choice?",
        choices: [
          btn("24 Hour Hold Fee", { kind: "setChargeType", chargeType: "24 Hour Hold Fee" }),
          btn("Pay Now", { kind: "setChargeType", chargeType: "Pay Now" }),
        ],
        next,
      });
    }

    // 7) POLICY
    if (next === "policy") {
      const policy =
        state.chargeType === "Pay Now"
          ? "Pay Now policy: you pay today (base + tax + auto gratuity). Non-refundable after booking."
          : "Hold Fee policy: you only pay the 24-hour hold fee today. You can cancel up to 24 hours prior without penalty.";

      return respond({
        reply: `${policy}\n\nReply “I agree” to continue.`,
        choices: [btn("I agree", { kind: "agreePolicy" })],
        next,
      });
    }

    // 8) CONTACT
    if (next === "name") return respond({ reply: "What’s your first and last name?", choices: [], next });
    if (next === "email") return respond({ reply: "What email should we send the confirmation to?", choices: [], next });
    if (next === "phone") return respond({ reply: "What’s the best phone number for the reservation?", choices: [], next });

    // 9) CONFIRM -> RESERVE -> PAYSTART LINK
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

      return respond({
        reply:
          `Perfect. Here’s what I’m booking:\n` +
          `• ${summarize(state)}\n` +
          `• Due today: ${money(amounts.dueToday)}\n\n` +
          `Tap “Proceed to payment” to complete it.`,
        choices: [{ label: "Proceed to payment", href: payUrl }],
        next: "done",
        extraState: { ...state, amounts, idkey },
      });
    }

    // Fallback (shouldn’t happen)
    return respond({
      reply: "Tell me what you’re trying to book (date, location, experience), and I’ll guide you.",
      choices: [],
      next: "date",
    });
  } catch (err) {
    return json(res, 200, { ok: false, error: String(err?.message || err) || "Unknown error" });
  }
}
