// energie-heute-karte v1.0.1
// Einzeln installierbares Modul (Home Assistant Marketplace / HACS, Kategorie Dashboard).
window.customCards = window.customCards || [];
window.customCardFeatures = window.customCardFeatures || [];
// Eigener Block: Namen bleiben lokal, auch wenn mehrere Karten zusammen geladen werden.
{

// Gemeinsame Hilfen fuer die Energie-Karten. Sensoren kommen aus der Kartenkonfiguration (keine Vorbelegung).
const EN = (() => {
  const STD = {
    pv: "",
    bezug: "",
    einspeisung: "",
    laden: "",
    entladen: "",
    soc: "",
    prognose_heute: "",
    prognose_rest: "",
    prognose_morgen: "",
    batterie_kwh: null, batterie_name: "Batterie",
    preis_bezug: 0, preis_einspeisung: 0,
  };
  const zahl = (hass, id) => { const v = Number(hass?.states[id]?.state); return isNaN(v) ? null : v; };
  const f = (v, st = 1) => (v == null || isNaN(v) ? "–" : v.toLocaleString("de-DE", { minimumFractionDigits: st, maximumFractionDigits: st }));
  // Kennzahlen aus Rohwerten (kWh)
  const kenn = (w) => {
    const pv = w.pv || 0, bez = w.bezug || 0, ein = w.einspeisung || 0, la = w.laden || 0, ent = w.entladen || 0;
    const haus = Math.max(0, pv + bez + ent - la - ein);
    const eigen = Math.max(0, pv - ein);
    return { pv, bez, ein, la, ent, haus, eigen,
      autarkie: haus > 0 ? Math.max(0, Math.min(100, (1 - bez / haus) * 100)) : null,
      evq: pv > 0 ? Math.min(100, (eigen / pv) * 100) : null };
  };
  // Sonnenauf-/untergang (NOAA-Naeherung), lokale Zeit
  const sonne = (datum, lat, lon) => {
    const rad = Math.PI / 180, tag = Math.floor((Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate()) - Date.UTC(datum.getFullYear(), 0, 0)) / 864e5);
    const g = (2 * Math.PI / 365) * (tag - 1);
    const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const dek = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(dek)) - Math.tan(lat * rad) * Math.tan(dek)) / rad;
    const mitt = new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate()));
    const zu = (min) => new Date(mitt.getTime() + min * 60000);
    return { auf: zu(720 - 4 * (lon + ha) - eqt), unter: zu(720 - 4 * (lon - ha) - eqt) };
  };
  const css = `
    :host { display: block; }
    ha-card { padding: 14px 16px 16px; box-sizing: border-box; }
    .h { font-size: 16px; font-weight: 600; color: var(--primary-text-color); margin: 0 0 10px; display: flex; align-items: center; gap: 6px; }
    .h small { font-weight: 400; color: var(--secondary-text-color); font-size: 12px; }
    .kacheln { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .k { border-radius: 10px; padding: 9px 12px; background: color-mix(in srgb, var(--fb, #888) 13%, transparent); cursor: default; }
    .k .t { font-size: 12.5px; color: var(--secondary-text-color); }
    .k .w { font-size: 22px; font-weight: 700; color: var(--fb, var(--primary-text-color)); line-height: 1.25; white-space: nowrap; }
    .k .w small { font-size: 12px; font-weight: 500; margin-left: 2px; }
    .k .u { font-size: 11px; color: var(--secondary-text-color); margin-top: 1px; }
    :host([schmal]) .k { padding: 8px 10px; } :host([schmal]) .k .w { font-size: 18px; } :host([schmal]) .k .t { font-size: 12px; }
    .rot { color: #e53935; } .gruen { color: #43a047; }
  `;
  return { STD, zahl, f, kenn, sonne, css };
})();


// ---------------------------------------------------------------------------
// Energie-heute-Karte: Tageskacheln, Tageslicht, Solar-Aussicht (Forecast.Solar), Ladezustand
//   type: custom:energie-heute-karte
//   (alle Sensoren optional ueberschreibbar: pv, bezug, einspeisung, laden, entladen, soc,
//    prognose_heute, prognose_rest, prognose_morgen, batterie_name)
class EnergieHeuteKarte extends HTMLElement {
  setConfig(c) { this._config = { ...EN.STD, ...(c || {}) }; this._prog = null; this._progZeit = 0; this._verbrauch = null; this._tag = 0; this._alt = {}; this._render(); }

  // Werte eines vergangenen Tages aus der Langzeitstatistik (Tagesaenderung, Ruecksetzungen beachtet)
  async _ladeTag(n) {
    const c = this._config, h = this._hass;
    if (!h?.connection || this._alt[n]) return;
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - n);
    const ende = new Date(start); ende.setDate(ende.getDate() + 1);
    const ids = { pv: c.pv, bezug: c.bezug, einspeisung: c.einspeisung, laden: c.laden, entladen: c.entladen };
    this._alt[n] = { laedt: true };
    try {
      const r = await h.connection.sendMessagePromise({ type: "recorder/statistics_during_period", start_time: start.toISOString(), end_time: ende.toISOString(),
        statistic_ids: Object.values(ids).filter((x) => h.states[x]), period: "day", types: ["change", "sum"] });
      const w = {}; let da = false;
      for (const [art, id] of Object.entries(ids)) {
        const z = ((r && r[id]) || [])[0];
        if (z) da = true;
        w[art] = z ? ((z.change || 0) < 0 ? Math.max(0, z.sum || 0) : (z.change || 0)) : 0;
      }
      this._alt[n] = da ? w : { leer: true };
    } catch (e) { this._alt[n] = { leer: true }; }
    this._update();
  }
  _blaettern(d) {
    this._tag = Math.max(0, this._tag + d);
    if (this._tag > 0) this._ladeTag(this._tag);
    this._update();
  }
  set hass(h) {
    this._hass = h; this._update();
    if (Date.now() - this._progZeit > 900000) this._lade();
  }
  connectedCallback() {
    this._takt = setInterval(() => this._update(), 60000);
    this._ro = this._ro || new ResizeObserver(([e]) => this.toggleAttribute("schmal", e.contentRect.width < 440));
    this._ro.observe(this);
  }
  disconnectedCallback() { clearInterval(this._takt); this._ro?.disconnect(); }

  async _lade() {
    if (!this._hass?.connection) return;
    this._progZeit = Date.now();
    const c = this._config;
    try {
      const r = await this._hass.connection.sendMessagePromise({ type: "energy/solar_forecast" });
      const tage = {};
      for (const e of Object.values(r || {})) for (const [t, wh] of Object.entries(e.wh_hours || {})) {
        const d = new Date(new Date(t).getTime() - 1800000);
        const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        tage[k] = tage[k] || { vm: 0, nm: 0 };
        tage[k][d.getHours() < 12 ? "vm" : "nm"] += wh / 1000;
      }
      this._prog = tage;
    } catch (e) { this._prog = null; }
    try {
      // Verbrauchsprognose: Mittel des Hausverbrauchs der letzten 7 vollen Tage
      const ende = new Date(); ende.setHours(0, 0, 0, 0);
      const start = new Date(ende.getTime() - 7 * 864e5);
      const ids = [c.pv, c.bezug, c.einspeisung, c.laden, c.entladen].filter((x) => this._hass.states[x]);
      const r = await this._hass.connection.sendMessagePromise({ type: "recorder/statistics_during_period",
        start_time: start.toISOString(), end_time: ende.toISOString(), statistic_ids: ids, period: "day", types: ["change"] });
      const sum = (id) => ((r && r[id]) || []).reduce((s, z) => s + Math.max(0, z.change || 0), 0);
      const n = Math.max(1, ((r && r[c.pv]) || []).length);
      const k = EN.kenn({ pv: sum(c.pv), bezug: sum(c.bezug), einspeisung: sum(c.einspeisung), laden: sum(c.laden), entladen: sum(c.entladen) });
      this._verbrauch = k.haus / n;
    } catch (e) { this._verbrauch = null; }
    this._update();
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${EN.css}
      .k { padding: 8px 11px; } .k .w { font-size: 18px; } .k .t { font-size: 12px; }
      :host([schmal]) .k .w { font-size: 16px; } :host([schmal]) .zeile .v { font-size: 16px; } :host([schmal]) .zeile .n { font-size: 14px; }
      .licht { margin: 16px 0 6px; }
      .nav { gap: 4px; } .nav .tt { min-width: 0; }
      .pfeil { display: inline-flex; width: 30px; height: 30px; align-items: center; justify-content: center; border-radius: 50%; cursor: pointer; color: var(--secondary-text-color); }
      .pfeil:hover { background: color-mix(in srgb, var(--primary-text-color) 8%, transparent); }
      .pfeil.aus { opacity: .25; pointer-events: none; }
      .nav .heute { margin-left: auto; font-size: 12px; font-weight: 500; color: var(--primary-color); cursor: pointer; padding: 3px 10px; border-radius: 12px;
        background: color-mix(in srgb, var(--primary-color) 14%, transparent); display: none; }
      :host([vergangen]) .nav .heute { display: inline-block; }
      :host([vergangen]) .licht, :host([vergangen]) .aus, :host([vergangen]) .soc { display: none !important; }
      .hinweis { font-size: 12px; color: #ffa726; margin: -4px 0 8px; display: none; } .hinweis.an { display: block; }
      .bahn { position: relative; height: 10px; border-radius: 5px; background: var(--divider-color, rgba(127,127,127,.3)); }
      .bahn .f { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; background: linear-gradient(90deg, #fdd835, #fb8c00); }
      .bahn .p { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: #fdd835; border: 2px solid var(--card-background-color, #222); box-sizing: border-box; }
      .lz { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--secondary-text-color); margin-top: 4px; align-items: center; }
      .lz b { color: #fbc02d; font-weight: 600; }
      .lz ha-icon { --mdc-icon-size: 14px; color: #fbc02d; }
      .aus { margin-top: 14px; }
      .zeile { display: grid; grid-template-columns: 1fr auto 92px; gap: 8px; align-items: center; padding: 9px 12px; border-radius: 10px; margin-bottom: 6px;
        background: color-mix(in srgb, #fbc02d 9%, transparent); }
      .zeile.klein { padding: 5px 12px; background: color-mix(in srgb, var(--primary-text-color) 5%, transparent); }
      .zeile .n { font-size: 15px; font-weight: 600; color: var(--primary-text-color); }
      .zeile.klein .n { font-size: 12.5px; font-weight: 400; color: var(--secondary-text-color); }
      .zeile .v { text-align: right; font-size: 18px; font-weight: 700; color: #fbc02d; white-space: nowrap; }
      .zeile.klein .v { font-size: 13px; color: #ff9800; }
      .zeile .v small { font-size: 11.5px; font-weight: 500; }
      .zeile .v .ist { color: #ba68c8; font-size: 12px; margin-left: 4px; }
      .zeile .v .rest { display: block; font-size: 11px; color: #9ccc65; font-weight: 500; }
      .zeile .vn { text-align: right; font-size: 13px; color: #ffa726; white-space: nowrap; }
      .kopfz { display: grid; grid-template-columns: 1fr auto 92px; font-size: 11px; color: #ffa726; padding: 0 12px 3px; }
      .kopfz span:last-child { text-align: right; }
      .soc { margin-top: 14px; }
      .soc .z { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--secondary-text-color); margin-bottom: 4px; }
      .soc .z b { color: var(--primary-text-color); }
      .soc .b { height: 10px; border-radius: 5px; background: var(--divider-color, rgba(127,127,127,.3)); overflow: hidden; }
      .soc .b div { height: 100%; border-radius: 5px; background: #2ecc71; transition: width .6s; }
    </style>
    <ha-card>
      <div class="h nav"><span class="pfeil zur" title="Tag zurück"><ha-icon icon="mdi:chevron-left"></ha-icon></span>
        <span class="tt">Heute</span><span class="pfeil vor" title="Tag vor"><ha-icon icon="mdi:chevron-right"></ha-icon></span>
        <span class="heute" title="Zurück zu heute">Heute</span></div>
      <div class="hinweis"></div>
      <div class="kacheln"></div>
      <div class="licht"><div class="bahn"><div class="f"></div><div class="p"></div></div>
        <div class="lz"><span class="la"></span><b class="lm"></b><span class="lu"></span></div></div>
      <div class="aus"><div class="h">Solar-Aussicht <small>Forecast.Solar</small></div>
        <div class="kopfz"><span></span><span></span><span>VM / NM</span></div><div class="zeilen"></div></div>
      <div class="soc"><div class="h">Ladezustand</div><div class="z"><span class="sn"></span><b class="sw"></b></div><div class="b"><div></div></div></div>
    </ha-card>`;
    const r = this.shadowRoot;
    r.querySelector(".zur").onclick = () => this._blaettern(1);
    r.querySelector(".vor").onclick = () => this._blaettern(-1);
    r.querySelector(".heute").onclick = () => this._blaettern(-this._tag);
    this._update();
  }

  _update() {
    const h = this._hass, r = this.shadowRoot, c = this._config;
    if (!h || !r || !c) return;
    const n = this._tag || 0, alt = n > 0 ? this._alt[n] : null;
    this.toggleAttribute("vergangen", n > 0);
    const datum = new Date(); datum.setDate(datum.getDate() - n);
    r.querySelector(".tt").textContent = n === 0 ? "Heute" : n === 1 ? "Gestern"
      : datum.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: datum.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
    r.querySelector(".vor").classList.toggle("aus", n === 0);
    const hin = r.querySelector(".hinweis");
    hin.classList.toggle("an", !!(alt && (alt.leer || alt.laedt)));
    hin.textContent = alt?.laedt ? "Lade Tageswerte …" : alt?.leer ? "Für diesen Tag gibt es keine Daten in der Statistik." : "";
    const w = n > 0 ? (alt && !alt.laedt && !alt.leer ? alt : {}) :
      { pv: EN.zahl(h, c.pv), bezug: EN.zahl(h, c.bezug), einspeisung: EN.zahl(h, c.einspeisung), laden: EN.zahl(h, c.laden), entladen: EN.zahl(h, c.entladen) };
    const k = EN.kenn(w);
    const kach = [
      ["PV-Erzeugung", `${EN.f(k.pv)}<small>kWh</small>`, "#fbc02d", c.pv],
      ["Eigenverbrauch", `${EN.f(k.eigen)}<small>kWh</small>`, "#42a5f5", null, "PV minus Einspeisung"],
      ["Einspeisung", `${EN.f(k.ein)}<small>kWh</small>`, "#26a69a", c.einspeisung],
      ["Batterie", `▲${EN.f(k.la)} ▼${EN.f(k.ent)}<small>kWh</small>`, "#4db6ac", c.soc, "▲ geladen · ▼ entladen"],
      ["Hausverbrauch", `${EN.f(k.haus)}<small>kWh</small>`, "#7e8cff", null, "PV + Bezug + Entladen − Laden − Einspeisung"],
      ["Netzbezug", `${EN.f(k.bez)}<small>kWh</small>`, "#ef5350", c.bezug],
      ["Autarkie", `${EN.f(k.autarkie, 0)}<small>%</small>`, "#43a047", null, "Anteil des Verbrauchs ohne Netzbezug"],
      ["Eigenverbr.-Quote", `${EN.f(k.evq, 0)}<small>%</small>`, "#29b6f6", null, "Anteil der PV, der selbst verbraucht wurde"]];
    const box = r.querySelector(".kacheln");
    box.innerHTML = kach.map(([t, w, col, , tip]) => `<div class="k" style="--fb:${col}" title="${tip || ""}"><div class="t">${t}</div><div class="w">${w}</div></div>`).join("");
    [...box.children].forEach((el, i) => { const id = kach[i][3]; if (id) { el.style.cursor = "pointer"; el.onclick = () => this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: id }, bubbles: true, composed: true })); } });

    // Tageslicht
    const lat = h.config?.latitude, lon = h.config?.longitude, jetzt = new Date();
    if (lat != null) {
      const { auf, unter } = EN.sonne(jetzt, lat, lon);
      const hm = (d) => d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      const ant = Math.min(1, Math.max(0, (jetzt - auf) / (unter - auf)));
      r.querySelector(".bahn .f").style.width = `${ant * 100}%`;
      r.querySelector(".bahn .p").style.left = `${ant * 100}%`;
      r.querySelector(".la").innerHTML = `<ha-icon icon="mdi:weather-sunset-up"></ha-icon> ${hm(auf)}`;
      r.querySelector(".lu").innerHTML = `${hm(unter)} <ha-icon icon="mdi:weather-sunset-down"></ha-icon>`;
      const rest = unter - jetzt, bis = auf - jetzt;
      const dauer = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
      r.querySelector(".lm").textContent = bis > 0 ? `Sonnenaufgang in ${dauer(bis)}` : rest > 0 ? `noch ${dauer(rest)} Tageslicht` : "Sonne untergegangen";
    }

    // Solar-Aussicht
    const key = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const morgen = new Date(jetzt.getTime() + 864e5);
    const ph = EN.zahl(h, c.prognose_heute), pr = EN.zahl(h, c.prognose_rest), pm = EN.zahl(h, c.prognose_morgen);
    const vn = (d) => { const t = this._prog?.[key(d)]; return t ? `${EN.f(t.vm)} / ${EN.f(t.nm)}` : ""; };
    let z = "";
    if (ph != null) z += `<div class="zeile"><span class="n">Heute</span><span class="v">${EN.f(ph)}<small> kWh</small>${k.pv ? `<span class="ist">${EN.f(k.pv)} ist</span>` : ""}${pr != null ? `<span class="rest">~${EN.f(pr)} verbl.</span>` : ""}</span><span class="vn">${vn(jetzt)}</span></div>`;
    if (this._verbrauch != null) z += `<div class="zeile klein"><span class="n">Verbrauchsprognose (Ø 7 Tage)</span><span class="v">~${EN.f(this._verbrauch)} kWh</span><span></span></div>`;
    if (pm != null) z += `<div class="zeile"><span class="n">Morgen</span><span class="v">${EN.f(pm)}<small> kWh</small></span><span class="vn">${vn(morgen)}</span></div>`;
    r.querySelector(".zeilen").innerHTML = z || `<div class="zeile klein"><span class="n">keine Prognose verfügbar</span></div>`;
    r.querySelector(".aus").style.display = z ? "" : "none";

    // Ladezustand
    const soc = EN.zahl(h, c.soc);
    r.querySelector(".soc").style.display = soc == null ? "none" : "";
    if (soc != null) {
      r.querySelector(".sn").textContent = `${c.batterie_name} ${EN.f(c.batterie_kwh, 1)} kWh`;
      r.querySelector(".sw").textContent = `${Math.round(soc)} %`;
      const b = r.querySelector(".soc .b div");
      b.style.width = `${Math.max(0, Math.min(100, soc))}%`;
      b.style.background = soc < 20 ? "#ef5350" : soc < 40 ? "#ffa726" : "#2ecc71";
    }
  }
  getCardSize() { return 9; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }
  static getStubConfig() { return {}; }
  static getConfigForm() {
    const ent = { entity: { filter: { domain: "sensor" } } };
    const L = { pv: "PV heute (kWh)", bezug: "Netzbezug heute", einspeisung: "Einspeisung heute", laden: "Batterie geladen heute", entladen: "Batterie entladen heute",
      soc: "Batterie-Ladezustand (%)", prognose_heute: "Prognose heute", prognose_rest: "Prognose Resttag", prognose_morgen: "Prognose morgen",
      batterie_name: "Name der Batterie", batterie_kwh: "Batteriegröße (kWh)" };
    return { schema: [
      { type: "expandable", name: "s", flatten: true, title: "Sensoren (vorbelegt mit SolaX / Forecast.Solar)", schema:
        ["pv", "bezug", "einspeisung", "laden", "entladen", "soc", "prognose_heute", "prognose_rest", "prognose_morgen"].map((n) => ({ name: n, selector: ent })) },
      { type: "grid", name: "", schema: [{ name: "batterie_name", selector: { text: {} } }, { name: "batterie_kwh", selector: { number: { min: 0, max: 100, step: 0.1, mode: "box" } } }] },
    ], computeLabel: (s) => L[s.name] ?? s.name };
  }
}
if (!customElements.get("energie-heute-karte")) customElements.define("energie-heute-karte", EnergieHeuteKarte);
if (!window.customCards.some((c) => c.type === "energie-heute-karte"))
  window.customCards.push({ type: "energie-heute-karte", name: "Energie heute", description: "PV, Verbrauch, Batterie, Autarkie heute, Tageslicht und Solar-Prognose", preview: true });
}

console.info("%c energie-heute-karte %c v1.0.0 ", "color:#fff;background:#03a9f4;font-weight:700", "color:#03a9f4");
