<script>
(function(){
  /* =========================
     Booking Summary Script (PROXY)
     - No Caspio calls in browser
     - Calls Vercel: /api/booking-summary
  ========================= */

  const API_BASE = "https://reservation-middleware2.vercel.app";
  const money = (n) => {
    const v = Number(n || 0);
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
  };
  const safeText = (v) => (v == null ? "" : String(v));

  const prettyDate = (v) => {
    if (!v) return "";
    const s = String(v);
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });
  };

  function getIdkeyFromUrl() {
    const p = new URLSearchParams(window.location.search);
    return p.get("IDKEY") || p.get("idkey") || p.get("Idkey") || p.get("id") || "";
  }

  async function fetchSummary(idkey, opts={}) {
    const nocache = opts.nocache ? "&nocache=1" : "";
    const url = `${API_BASE}/api/booking-summary?idkey=${encodeURIComponent(idkey)}${nocache}`;
    const r = await fetch(url, { cache: "no-store" });
    const text = await r.text();
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch {}
    if (!r.ok || !j.ok) throw new Error(j?.error || text || "Summary fetch failed");
    return j.row || null;
  }

  function render(row) {
    const el = document.getElementById("sigmaBookingSummary");
    if (!row) { if (el) el.style.display = "none"; return; }
    if (el) el.style.display = "block";

    document.getElementById("bs_session_date").textContent = prettyDate(row.BAR2_Session_Date);
    document.getElementById("bs_session_title").textContent = safeText(row.BAR2_Session_Title);

    document.getElementById("bs_primary_subtotal").textContent = money(row.SIGMA_BAR3_TOTAL_RES_Subtotal_Primary);
    document.getElementById("bs_addon_subtotal").textContent = money(row.SIGMA_BAR3_TOTAL_RES_Subtotal_Addon);
    document.getElementById("bs_gratuity").textContent = money(row.SIGMA_BAR3_TOTAL_RES_Subtotal_Gratuity);
    document.getElementById("bs_tax").textContent = money(row.SIGMA_BAR3_TOTAL_RES_TAX_Amount);
    document.getElementById("bs_total").textContent = money(row.SIGMA_BAR3_TOTAL_RES_After_Tax_Total);
    document.getElementById("bs_paid").textContent = money(row.SIGMA_BAR3_TOTAL_RES_Total_Charged_Amount);
  }

  async function load(nocache=false) {
    const idkey = getIdkeyFromUrl();
    if (!idkey) return;
    try {
      const row = await fetchSummary(idkey, { nocache });
      render(row);
    } catch (e) {
      console.error("Booking Summary proxy error:", e);
      // leave visible but stale rather than hiding; comment out if you prefer hiding
      // document.getElementById("sigmaBookingSummary").style.display = "none";
    }
  }

  // Initial load
  document.addEventListener("DOMContentLoaded", () => load(false));

  // Optional: let other scripts refresh us without reloading the page
  window.addEventListener("sigma:refreshTotals", () => load(true));

  // Optional: expose a tiny manual hook
  window.SIGMA_REFRESH_BOOKING_SUMMARY = () => load(true);
})();
</script>
