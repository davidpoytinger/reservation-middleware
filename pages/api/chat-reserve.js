// pages/api/chat-reserve.js
//
// Hybrid “AI concierge + deterministic SIGMA booking” chat endpoint.
//
// Key upgrades vs the old version:
// 1) **Stateless threads** (no in-memory Map) to eliminate “Thread not found” after deploys.
//    - We store chat state in a signed token (threadToken) returned to the browser.
//    - Browser sends threadToken back each message.
//    - Uses HMAC signing with CHAT_THREAD_SECRET.
//
// 2) Optional **real AI extraction** (OPENAI_API_KEY) to make it feel “AI” without letting AI book.
//    - AI only extracts hints (date/business/type/party size/charge type).
//    - Final choices still come from /api/sessions + /api/pricing buttons.
//
// 3) **Tax fix**: when Pay Now, tax is calculated on (base + gratuity), per your request.
//
// Required env (Vercel):
// - CHAT_THREAD_SECRET   (random long string)
// Optional env:
// - OPENAI_API_KEY       (enables real AI extraction)
// - MIDDLEWARE_BASE      (defaults to https://reservation-middleware2.vercel.app)
// - CORS_ORIGIN          (optional; defaults to '*')
//
// This endpoint uses your existing middleware routes:
//   GET  /api/sessions?date=YYYY-MM-DD&bu=optional
//   GET  /api/pricing?price_status=...
//   POST /api/reserve
//   (returns paystart URL)

// ----------------------------- imports -----------------------------
import crypto from "crypto";

// ----------------------------- config -----------------------------
const BASE = process.env.MIDDLEWARE_BASE || "https://reservation-middleware2.vercel.app";
const SESSIONS_URL = `${BASE}/api/sessions`;
const PRICING_URL = `${BASE}/api/pricing`;
const RESERVE_URL = `${BASE}/api/reserve`;
const PAYSTART_URL = `${BASE}/api/paystart`;

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const THREAD_SECRET = process.env.CHAT_THREAD_SECRET || ""; // REQUIRED for tamper-proof tokens

// ----------------------------- helpers -----------------------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res, code, obj) {
  setCors(res);
  res.status(code).setHeader("Content-Type", "application/json").end(JSON.stringify(obj));
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function base64urlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlDecode(s) {
  const b64 = String(s || "").replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s || "").length + 3) % 4);
  return Buffer.from(b64, "base64");
}

function hmacSign(payloadB64u) {
  if (!THREAD_SECRET) return "";
  return base64urlEncode(crypto.createHmac("sha256", THREAD_SECRET).update(payloadB64u).digest());
}

function encodeThread(state) {
  const payload = base64urlEncode(Buffer.from(JSON.stringify(state)));
  const sig = hmacSign(payload);
  // If no secret, we still return a token (but it’s not tamper-proof).
  return sig ? `${payload}.${sig}` : payload;
}

function decodeThread(token) {
  const t = oneLine(token);
  if (!t) return null;

  const parts = t.split(".");
  const payload = parts[0] || "";
  const sig = parts[1] || "";

  if (THREAD_SECRET) {
    const expect = hmacSign(payload);
    if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  }

  try {
    const raw = base64urlDecode(payload).toString("utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
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

function normText(s) {
  return oneLine(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function bestFuzzyMatch(hint, options, getLabel) {
  const h = normText(hint);
  if (!h) return null;

  // exact normalized match
  const exact = options.filter((o) => normText(getLabel(o)) === h);
  if (exact.length === 1) return exact[0];

  // contains match
  const contains = options.filter((o) => normText(getLabel(o)).includes(h) || h.includes(normText(getLabel(o))));
  if (contains.length === 1) return contains[0];

  // token overlap score
  const hTokens = new Set(h.split(" ").filter(Boolean));
  let best = null;
  let bestScore = 0;
  for (const o of options) {
    const t = normText(getLabel(o));
    const tokens = t.split(" ").filter(Boolean);
    let score = 0;
    for (const tok of tokens) if (hTokens.has(tok)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  // only accept if it's meaningfully better
  if (best && bestScore >= 2) return best;
  return null;
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

// IMPORTANT: tax = taxRate * (base + gratuity) when Pay Now
function computeAmounts({ units, unitPrice, taxRate, autoGratRaw, chargeType, bookingFee }) {
  const u = Number(units);
  const p = Number(unitPrice);
  const base = (Number.isFinite(u) ? u : 0) * (Number.isFinite(p) ? p : 0);

  const tr = Number.isFinite(Number(taxRate)) ? Number(taxRate) : 0.055;

  const ag = parseAutoGrat(autoGratRaw);
  const gratuity = ag.type === "flat" ? ag.amount : base * ag.rate;

  let tax = 0;
  if (chargeType === "Pay Now") {
    tax = (base + gratuity) * tr;
  }

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

async function fetchJSON(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);

  const r = await fetch(url, { ...opts, cache: "no-store", signal: ac.signal });
  const text = await r.text();
  clearTimeout(t);

  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = {};
  }
  if (!r.ok) throw new Error(j?.error || j?.Message || text || `HTTP ${r.status}`);
  return j;
}

// ----------------------------- optional AI extraction -----------------------------
async function aiExtract(message) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const msg = oneLine(message);
  if (!msg) return null;

  // keep it tiny & deterministic
  const payload = {
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content:
          "Extract reservation hints from user text for a booking chatbot. " +
          "Return ONLY strict JSON with keys: date_text, business_hint, type_hint, party_size, charge_type. " +
          "date_text can be 'today','tomorrow','YYYY-MM-DD', or ''. " +
          "charge_type must be 'Pay Now','24 Hour Hold Fee', or ''. " +
          "party_size must be a number or ''.",
      },
      { role: "user", content: msg },
    ],
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });

  const j = await r.json();

  const text =
    j?.output?.[0]?.content?.[0]?.text ||
    j?.output_text ||
    "";

  try {
    const out = JSON.parse(text);
    if (!out || typeof out !== "object") return null;
    return out;
  } catch {
    return null;
  }
}

// ----------------------------- lightweight parsing fallbacks -----------------------------
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

// ----------------------------- Caspio view field names -----------------------------
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

// ----------------------------- flow control -----------------------------
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

function newState() {
  return {
    v: 1,
    createdAt: Date.now(),

    // booking state
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

    // package
    package: "",
    packageLabel: "",
    units: "",
    cQuant: "",
    unitPrice: 0,

    // payment + contact
    chargeType: "",
    policyAgreed: false,
    first: "",
    last: "",
    email: "",
    phone: "",
    notes: "",

    // AI hints (safe)
    _buHint: "",
    _typeHint: "",
    _partySizeHint: "",
  };
}

// ----------------------------- handler -----------------------------
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(204).end();
  }

  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  try {
    // If you want tamper-proof state, require secret:
    if (!THREAD_SECRET) {
      // Still works without it, but I'd rather you set it.
      // Comment out the next line if you insist on unsigned threads.
      throw new Error("Missing env CHAT_THREAD_SECRET (required).");
    }

    const body = req.body || {};
    const message = oneLine(body.message);
    const actionRaw = body.action;
    const threadTokenIn = oneLine(body.threadToken);

    let state = threadTokenIn ? decodeThread(threadTokenIn) : null;
    if (!state) state = newState();

    // ---- Parse action (button clicks) ----
    let act = null;
    try {
      act = typeof actionRaw === "string" ? JSON.parse(actionRaw) : actionRaw;
    } catch {
      act = null;
    }

    // ---- Apply AI extraction + fallbacks from free-text ----
    if (message) {
      const extracted = await aiExtract(message);

      if (extracted) {
        const dt = parseDate(extracted.date_text);
        if (dt) state.date = dt;

        const ct = oneLine(extracted.charge_type);
        if (ct === "Pay Now" || ct === "24 Hour Hold Fee") state.chargeType = ct;

        state._buHint = oneLine(extracted.business_hint);
        state._typeHint = oneLine(extracted.type_hint);

        const ps = Number(extracted.party_size);
        if (Number.isFinite(ps) && ps > 0) state._partySizeHint = ps;
      }

      // fallbacks
      const dt2 = parseDate(message);
      if (dt2) state.date = dt2;

      const ct2 = parseChargeType(message);
      if (ct2) state.chargeType = ct2;

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

    // ---- Handle structured actions (preferred) ----
    const resetDownstreamFromBusiness = () => {
      state.type = "";
      state.time = "";
      state.sessionId = "";
      state.priceStatus = "";
      state.priceClass = "";
      state.sessionsTitle = "";
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

      // package resets
      state.package = "";
      state.packageLabel = "";
      state.units = "";
      state.cQuant = "";
      state.unitPrice = 0;
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

    // ---- Drive next step (with safe auto-advance when unambiguous) ----
    const btn = (label, actionObj) => ({ label, action: JSON.stringify(actionObj) });

    let reply = "";
    let choices = [];
    let next = stepName(state);

    // Step: date
    if (next === "date") {
      reply = "What date are you booking for? You can say “today”, “tomorrow”, or type YYYY-MM-DD.";
      const threadToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken, reply, choices, next });
    }

    // Step: business
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

      // safe auto-pick if AI hint matches uniquely
      const auto = bestFuzzyMatch(state._buHint, list, (x) => x.dba) || bestFuzzyMatch(state._buHint, list, (x) => x.bu);
      if (auto) {
        state.bu = normalizeBU(auto.bu);
        state.dba = oneLine(auto.dba);
        resetDownstreamFromBusiness();
        next = stepName(state);
      } else {
        reply = `Got it — ${state.date}. Which location/business?`;
        choices = list.slice(0, 12).map((x) => btn(x.dba, { kind: "pickBusiness", bu: x.bu, dba: x.dba }));
        const threadToken = encodeThread(state);
        return json(res, 200, { ok: true, threadToken, reply, choices, next });
      }
    }

    // Step: type
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

      // safe auto-pick if hint matches uniquely
      const auto = bestFuzzyMatch(state._typeHint, types, (x) => x.type);
      if (auto) {
        state.type = oneLine(auto.type);
        resetDownstreamFromType();
        next = stepName(state);
      } else {
        reply = `Great — ${state.dba || state.bu}. What experience are you booking?`;
        choices = types.slice(0, 12).map((t) => btn(`${t.type} (${t.count} times)`, { kind: "pickType", type: t.type }));
        const threadToken = encodeThread(state);
        return json(res, 200, { ok: true, threadToken, reply, choices, next });
      }
    }

    // Step: time
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

      reply = `Which start time for **${state.type}** on ${state.date}?`;
      choices = times
        .filter((x) => !x.soldOut)
        .slice(0, 14)
        .map((x) =>
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

      const threadToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken, reply, choices, next });
    }

    // Step: package
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

      // optional auto-select based on party size hint (only if exact match exists)
      if (state._partySizeHint) {
        const exact = options.find((o) => Number(o.units) === Number(state._partySizeHint));
        if (exact) {
          state.package = exact.key;
          state.packageLabel = exact.label;
          state.units = exact.units;
          state.cQuant = exact.cQuant;
          state.unitPrice = exact.unitPrice;
          next = stepName(state);
        }
      }

      if (next === "package") {
        reply = "How many people? Pick a group option:";
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
        const threadToken = encodeThread(state);
        return json(res, 200, { ok: true, threadToken, reply, choices, next });
      }
    }

    // Step: charge type
    if (next === "chargeType") {
      reply = "Payment choice?";
      choices = [
        btn("24 Hour Hold Fee", { kind: "setChargeType", chargeType: "24 Hour Hold Fee" }),
        btn("Pay Now", { kind: "setChargeType", chargeType: "Pay Now" }),
      ];
      const threadToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken, reply, choices, next });
    }

    // Step: policy
    if (next === "policy") {
      reply =
        state.chargeType === "Pay Now"
          ? "Pay Now policy: non-refundable after booking. Reply “I agree” to continue."
          : "Hold Fee policy: cancel up to 24 hours prior without penalty. Reply “I agree” to continue.";
      choices = [btn("I agree", { kind: "agreePolicy" })];
      const threadToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken, reply, choices, next });
    }

    // Step: name/email/phone
    if (next === "name") {
      reply = "What’s your first and last name?";
      const threadToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken, reply, choices, next });
    }
    if (next === "email") {
      reply = "What email should we send the confirmation to?";
      const threadToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken, reply, choices, next });
    }
    if (next === "phone") {
      reply = "What’s the best phone number for the reservation?";
      const threadToken = encodeThread(state);
      return json(res, 200, { ok: true, threadToken, reply, choices, next });
    }

    // Step: confirm -> create reservation + return pay url
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

      // We can return a fresh token (not necessary now that booking is created, but fine)
      const threadToken = encodeThread(state);

      return json(res, 200, {
        ok: true,
        threadToken,
        reply,
        choices,
        next: "done",
        state: { ...state, amounts, idkey },
      });
    }

    // fallback
    reply = "Tell me what you’re trying to book (date, location, experience), and I’ll guide you.";
    const threadToken = encodeThread(state);
    return json(res, 200, { ok: true, threadToken, reply, choices, next });
  } catch (err) {
    return json(res, 200, { ok: false, error: String(err?.message || err) });
  }
}
