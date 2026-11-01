import * as C from './pulse-core.js?v=mvxyn4sh';
import * as Ops from './ops.js?v=mvxyn4sh';
import * as E from './pulse-econ.js?v=mvxyn4sh';
import * as K from './pulse-calib.js?v=mvxyn4sh';
import * as Rp from './report.js?v=mvxyn4sh';
import * as R from './pulse-report.js?v=mvxyn4sh';
import * as Fl from './flows.js?v=mvxyn4sh';
const { initOps, renderOps, opsFleet, applyOpsParams } = Ops;

const QS = new URLSearchParams(location.search);
const DEMO = QS.get('demo') === '1'; // eingefrorener Demo-Stand (Branch demo), ohne Live-Abruf und ohne Nachladen
const DATA_DEFAULT = DEMO ? 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/demo/' : 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/';
// ?data=… nur von erlaubter Herkunft: absoluter Pfad gleicher Herkunft, localhost/127.0.0.1 (Tests) oder ein Branch dieses Repos auf raw.githubusercontent.com
function dataOrigin(d) {
  if (!d) return null;
  try {
    const u = new URL(d, location.href);
    if (/^\/[^/\\]/.test(d) && u.origin === location.origin) return d;
    if (/^https?:$/.test(u.protocol) && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return d;
    if (u.origin === 'https://raw.githubusercontent.com' && u.pathname.startsWith('/fcou1005/mobility-pulse/')) return u.href;
  } catch { /* keine URL */ }
  console.warn(`?data=${d} hat keine erlaubte Herkunft – Standard-Datenstand wird verwendet.`);
  return null;
}
const DATA_PARAM = dataOrigin(QS.get('data'));
const CFG = {
  DATA: DATA_PARAM || DATA_DEFAULT,
  DATA_OK: !!DATA_PARAM, // ?data= darf nur dann in Links bleiben
  // Repo-Dateien (sources.json, reference.json): bei lokalem ?data=/pfad/ aus dem ausgelieferten Repo (../data/), sonst vom Branch main
  MAIN: DATA_PARAM && !/^https?:/i.test(DATA_PARAM) ? new URL('../data/', location.href).href : 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/main/data/',
  REPO: 'https://github.com/fcou1005/mobility-pulse',
  WFS: 'https://api.mobidata-bw.de/geoserver/MobiData-BW/ows',
  OVERPASS: ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'],
  OSRM_FOOT: 'https://routing.openstreetmap.de/routed-foot',
  VALHALLA: 'https://valhalla1.openstreetmap.de',
  MAX_POINTS: 6000,
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// nur http(s)-Links aus Feeds werden zu Links; alles andere bleibt Text. label ist bereits escapetes HTML.
const link = (url, label, cls = '') => /^https?:\/\//i.test(String(url || '').trim()) ? `<a href="${esc(String(url).trim())}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${label}</a>` : String(label).replace(/<[^>]+>/g, '');
const NF = new Map(); // Intl.NumberFormat je Nachkommastellen (Aufbau ist teuer)
const nf = (d) => NF.get(d) || (NF.set(d, new Intl.NumberFormat('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d })), NF.get(d));
const fmt = (n, d = 0) => n == null || !Number.isFinite(n) ? '—' : nf(d).format(n);
const pctf = (a, b) => b ? `${fmt((a / b) * 100, a / b < 0.1 ? 1 : 0)} %` : 'k. A.';
const ageText = (ms) => ms == null ? '–' : ms < 90e3 ? 'gerade' : ms < 3600e3 ? `${Math.round(ms / 60e3)} Min.` : ms < 48 * 3600e3 ? `${(ms / 3600e3).toFixed(1).replace('.', ',')} Std.` : `${Math.round(ms / 86400e3)} Tg.`;
// Uhrzeiten immer in Europe/Berlin (Sammler, Ereignistage und Tagesgang rechnen in Berliner Zeit), unabhängig von der Zeitzone des Browsers
const BERLIN_HM = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
const timeText = (ms) => ms ? BERLIN_HM.format(new Date(ms)) : '–';
const TYPE = C.VEHICLE_TYPE_LABEL;
const STATUS = { ...C.FRESHNESS_LABEL, collector: 'Sammler-Stand' };
const DIRS = { mobilitydata: 'MobilityData / Betreiber', mobidata_bw: 'MobiData BW', mobidrom_nrw: 'MOBIDROM NRW', citybikes: 'CityBikes', dott_direct: 'Dott · Direktfeed', lime_direct: 'Lime · Direktfeed', zeus_direct: 'Zeus · Direktfeed', bird_direct: 'Bird · Direktfeed', db_api: 'DB API Marketplace' };
// Anbieterfarben: 8 Farben der geprüften Palette (Validator hell/dunkel bestanden) plus 4 Nebenfarben. Die Farbe folgt dem Anbieter, nie seinem Rang:
// feste Plätze für die acht größten Anbieter, so gewählt, dass Anbieter, die in denselben Gemeinden fahren, gewichtet nach gemeinsamer Flotte möglichst
// weit auseinanderliegen (Suche über alle 8! Zuordnungen mit validate_palette, Datenstand 01.11.2026). Vorher waren Lime, Bolt und RegioRad drei Grüntöne.
const PAL8 = { light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'], dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] };
const PAL_MORE = { light: ['#0f8fa8', '#a0652b', '#b05090', '#5b8f2b'], dark: ['#2aa3bd', '#c48244', '#cc6fae', '#6fa02a'] };
const OP_SLOT = { 'DB Connect': 0, Zeus: 1, nextbike: 2, Dott: 3, Donkey: 4, Bolt: 5, Voi: 6, Lime: 7 };
const OP_MORE = { 'swabi - augsburg': 0, 'RegioRad Stuttgart': 1, Yoio: 2, 'esel.ac': 3 };
const DISABLED_COL = '#7d8794'; // gesperrt: neutrales Grau statt Rot (Rot ist eine Anbieterfarbe)
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
const palette = (i) => PAL8[isDark() ? 'dark' : 'light'][i % 8];
function opColor(op) {
  const m = isDark() ? 'dark' : 'light';
  if (op in OP_SLOT) return PAL8[m][OP_SLOT[op]];
  return PAL_MORE[m][op in OP_MORE ? OP_MORE[op] : parseInt(C.hashStr(String(op)), 36) % PAL_MORE[m].length];
}
// Rand der Kartenpunkte in der Hintergrundfarbe (1,5 px), damit sich Punkte voneinander absetzen
const bgColor = () => getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || (isDark() ? '#161d26' : '#ffffff');
// Begriffe, die eine kurze Erklärung brauchen (als <abbr title>)
const GLOSS = {
  rvd: 'Rides per Vehicle per Day: Fahrten je Fahrzeug und Tag (Fahrten/Tag ÷ Ø Flotte auf der Straße)',
  util: 'Anteil der Zeit, in der ein Fahrzeug fährt (Rides/Fzg./Tag × Ø Fahrtdauer ÷ 24 h)',
  real: 'Anteil des Listenpreises, der tatsächlich bezahlt wird (Pässe, Rabatte, Freiminuten)',
  rot: 'Fahrzeug taucht am selben Ort (≤ 40 m) mit neuer Kennung auf, ohne gefahren zu sein; zählt nicht als Fahrt',
  reloc: 'Gleiche Kennung, nie verschwunden, aber über 150 m versetzt: vom Betreiber transportiert',
  pickup: 'Gesperrte oder fast leere Fahrzeuge, die aus dem Feed verschwinden (Werkstatt, Laden)',
  cell: 'Raster von etwa 250 × 250 m; Starts, Ziele und Bestand werden je Zelle gezählt',
  calib: 'Eigener Faktor auf die gemessenen Fahrten dieses Anbieters, z. B. aus bekannten Betreiberzahlen; ersetzt den Kalibrierfaktor. Wirkt auf Rides/Fzg./Tag, Auslastung und Umsatz. Nur in diesem Browser gespeichert, 1 = keine eigene Korrektur.',
  empty: 'Leer = kein buchbares Fahrzeug und keins desselben Anbieters im Umkreis von 50 m',
  score: 'Gleich gewichtetes Mittel der vorhandenen Teilwerte (je 0–100): Verfügbar-Anteil, 100 − Sperrquote, 100 − Anteil Energie niedrig, 100 − Anteil leerer Stationen, Quellenqualität. Fehlt ein Teilwert, zählt er nicht mit.',
  fresh: 'Datenalter jetzt = Feedalter bei der Messung + Zeit seit der Messung. Aktuell bis 30 Min. (Sammler-Takt 20 Min. + 10), verzögert bis 60 Min., darüber veraltet.',
  point: 'Ein Sammler-Punkt je Lauf (alle 20 Min.), in dem die Quelle für diese Auswahl Daten lieferte. Läufe, in denen die Quelle ausfiel, fehlen als Punkt.',
  gap: 'Stunde ohne Sammler-Lauf oder mit einem Lauf nach über 45 Min. Pause: Bewegungen dieser Stunde sind nicht zuordenbar und fehlen in Hochrechnung und Rides/Fzg./Tag.',
};
// Kundenansicht: Alltagsbegriffe statt Methodik (Sammler, Takt, Zellen, Kennungen)
const GLOSS_CLIENT = {
  fresh: 'Wie alt die Daten gerade sind: aktuell bis 30 Minuten, verzögert bis 60 Minuten, danach veraltet.',
  point: 'Ein Messpunkt etwa alle 20 Minuten.',
  empty: 'Leer = kein Fahrzeug an der Station und keins in den nächsten 50 Metern',
  score: 'Mittel aus Verfügbarkeit, wenigen Sperren, genug Energie, besetzten Stationen und Datenqualität (alle gleich gewichtet)',
  gap: 'Zeit ohne Messung',
};
const gl = (key) => (isClient() && GLOSS_CLIENT[key]) || GLOSS[key] || key;
const abbr = (text, key) => `<abbr title="${esc(gl(key))}">${text}</abbr>`;
const cl = (internal, client) => isClient() ? client : internal; // Text je Ansicht
// Leere Stationen: „effektiv leer“ = gemeldet leer und kein Fahrzeug ≤ 50 m; ältere Sammler-Stände kennen nur den gemeldeten Wert
const emptyTip = (s) => { const rep = s.stationsEmptyReported || s.stationsEmpty || 0, near = s.stationsEmptyNearby || 0; return near ? `als leer gemeldet: ${fmt(rep)} · davon ${fmt(near)} mit verfügbaren Fahrzeugen ≤ ${C.STATION_NEAR_M ?? 50} m (Fahrzeuge der Station nicht zugeordnet)` : `als leer gemeldet: ${fmt(rep)}`; };
const isClient = () => document.body.classList.contains('mode-client');
const sig2 = (x) => { const p = 10 ** Math.max(0, Math.floor(Math.log10(Math.abs(x) || 1)) - 1); return Math.round(x / p) * p; };

const state = {
  latest: null, catalog: null, status: null, histIndex: null, hist: {}, boundaries: null, bIndex: null,
  scope: 'DE', operator: 'all', type: 'all', mode: 'collector',
  live: null, // {at, systems: Map(id→sys), groups, vehicles, stations, recs: Map}
  thresholds: { charge: 20, range: 5 },
  map: null, layers: {}, supply: null, histDay: null,
};

// ---------- Laden ----------
// raw.githubusercontent cacht bis zu 5 Min.; ein eindeutiger Parameter holt den aktuellen Stand
const fresh = (file) => `${CFG.DATA}${file}?t=${Date.now()}`;
const MAX_BYTES = 40 * 1024 * 1024; // Größenlimit je Antwort
// Timeout gilt bis zum Ende des Lesens; Antworten über 40 MB werden abgebrochen
async function getJson(url, { timeout = 25000 } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
    let json = null, error = null;
    if (r.ok) {
      if (+(r.headers.get('content-length') || 0) > MAX_BYTES) { ctrl.abort(); error = 'zu groß'; }
      else {
        try {
          let text;
          if (r.body?.getReader) {
            const reader = r.body.getReader(), dec = new TextDecoder(); let size = 0; text = '';
            for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { ctrl.abort(); throw new Error('zu groß'); } text += dec.decode(value, { stream: true }); }
            text += dec.decode();
          } else text = await r.text();
          json = JSON.parse(text);
        } catch (e) { error = e.message === 'zu groß' ? 'zu groß' : e.name === 'AbortError' ? 'Timeout' : 'kein JSON'; }
      }
    }
    return { ok: r.ok && !!json, status: r.status, json, error, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) { return { ok: false, status: 0, json: null, error: e.name === 'AbortError' ? 'Timeout' : 'Netz/CORS', latencyMs: Math.round(performance.now() - t0) }; }
  finally { clearTimeout(t); }
}
// Jede Datei des Datenstands nur einmal laden: das Promise wird sofort gemerkt (parallele Aufrufer teilen sich den Download).
// Fehlende Dateien (404) bleiben gemerkt bis zum nächsten Datenstand; Netzfehler/Timeouts dürfen nach 30 s erneut versucht werden.
const REQ = new Map(); const FAILED = new Map(); // Datei → HTTP-Status/Fehler des letzten Versuchs
function cached(file, timeout = 60000) {
  let p = REQ.get(file);
  if (!p) {
    p = getJson(CFG.DATA + file, { timeout }).then(r => {
      if (!r.ok) { FAILED.set(file, r.status || r.error); if (!r.status || r.status >= 500) setTimeout(() => { if (REQ.get(file) === p) REQ.delete(file); }, 30e3); } else FAILED.delete(file);
      return r;
    });
    REQ.set(file, p);
  }
  return p;
}
const resetCache = () => { REQ.clear(); FAILED.clear(); };
// getJson für ops.js (und künftige Module): Dateien des Datenstands laufen über denselben Cache, fremde URLs direkt
const getJsonShared = (url, opt = {}) => typeof url === 'string' && url.startsWith(CFG.DATA) && !url.includes('?') ? cached(url.slice(CFG.DATA.length), opt.timeout) : getJson(url, opt);
const failedText = (file) => { const f = FAILED.get(file); return f === 404 ? `Datei fehlt: ${file}` : f ? `Datei nicht ladbar: ${file} (${f})` : 'Keine Daten'; };
const emptyRow = (cols, msg, hint = '') => `<tr><td colspan="${cols}" class="empty"><b>${esc(msg)}</b>${esc(hint)}</td></tr>`;
function notice(html, kind = '', id = null) {
  const box = $('#notice');
  const el = id && $(`#notice [data-id="${id}"]`) || document.createElement('div');
  el.className = `note ${kind}`; if (id) el.dataset.id = id; el.innerHTML = html; if (!el.parentNode) box.appendChild(el); return el;
}
const clearNotice = (id) => $(`#notice [data-id="${id}"]`)?.remove();

async function loadBase() {
  const [status, latest, sources, hist] = await Promise.all([getJson(fresh('status.json')), getJson(fresh('latest.json')), cached('sources.json', 25000), cached('history/index.json', 25000)]);
  state.status = status.json; state.latest = latest.json; state.histIndex = hist.json;
  if (!latest.ok) FAILED.set('latest.json', latest.status || latest.error); // für die Leerzeilen der Tabellen
  state.catalog = sources.json || (await getJson(CFG.MAIN + 'sources.json')).json;
  const standTxt = state.status?.at ? new Date(state.status.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }) : '';
  if (!DEMO && state.status?.at && Date.now() - state.status.at > 45 * 60e3) notice(cl(`Der letzte Sammler-Lauf ist ${ageText(Date.now() - state.status.at)} alt (Plan: alle 20 Min.). Zahlen gelten für ${standTxt}; <a href="${CFG.REPO}/actions">Läufe ansehen</a>.`, `Die Zahlen sind ${ageText(Date.now() - state.status.at)} alt (Stand ${standTxt}); die nächste Aktualisierung kommt automatisch.`), 'warn', 'stale');
  if (DEMO) {
    const at = state.status?.at || state.latest?.at;
    const b = $('#demo-badge'); b.hidden = false; b.textContent = at ? `Demo-Stand vom ${new Date(at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Demo-Stand';
    b.title = 'Eingefrorener Datenstand: kein Live-Abruf, kein Nachladen';
    if (!state.latest) notice('Der Demo-Stand ist gerade nicht ladbar. Seite später neu laden oder ohne <span class="mono">?demo=1</span> öffnen.', 'warn', 'nolatest');
    return;
  }
  if (!state.latest) {
    notice(`Der Sammler hat noch keinen Datenstand veröffentlicht (<a href="${CFG.REPO}/actions">Actions</a>). Live-Abruf funktioniert trotzdem; Ortszuordnung erst nach dem ersten Lauf.`, 'warn', 'nolatest');
    state.mode = 'live'; $('#sel-mode').value = 'live';
  }
}
// Gemeindegrenzen (2,5 MB) nur, wenn sie gebraucht werden: Grenz-Ebene, Live-Zuordnung, Haltestellen; Mittelpunkte kommen aus latest.json (municipalities[].c)
let boundariesReq = null;
function loadBoundaries() {
  if (state.bIndex) return Promise.resolve(state.bIndex);
  return boundariesReq ??= cached('boundaries-active.json', 60000).then(r => {
    if (!r.ok) return null;
    for (const f of r.json.features || []) if (!f.bbox) { const c = JSON.stringify(f.geometry?.coordinates || []).match(/-?\d+(\.\d+)?/g) || []; let x0 = 999, y0 = 999, x1 = -999, y1 = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } f.bbox = [x0, y0, x1, y1]; }
    state.boundaries = r.json; state.bIndex = C.buildMunicipalityIndex(r.json);
    return state.bIndex;
  });
}
const hasCenters = () => Object.values(state.latest?.municipalities || {}).some(m => Array.isArray(m.c));
async function loadHistory(day) {
  if (state.hist[day]) return state.hist[day];
  const r = await cached(`history/${day}.json`, 60000);
  state.hist[day] = r.json || null; return state.hist[day];
}
// Tagesmittel über bis zu 30 Tage (history/daily.json, Vertrag 6); null bei altem Datenstand
let dailyReq = null;
const loadDaily = () => dailyReq ??= cached('history/daily.json', 60000).then(r => r.ok && r.json?.days && r.json?.series ? r.json : null);
// Mittel je Gemeinde|Anbieter über die vorigen Tage (ohne den gezeigten Tag): Anteil gesperrt und Anteil Energie niedrig am Bestand
function dailyBaseline(daily, ags, op, excludeDay) {
  if (!daily) return null;
  const fi = Object.fromEntries((daily.fields || []).map((f, i) => [f, i]));
  if (fi.total == null) return null;
  const days = (daily.days || []).filter(d => d !== excludeDay).slice(-7);
  if (!days.length) return null;
  let total = 0, disabled = 0, low = 0, stations = 0, emptyDock = 0, n = 0;
  for (const [k, ser] of Object.entries(daily.series)) {
    const [a, o] = k.split('|'); if (a !== ags || o !== op) continue;
    for (const d of days) { const v = ser[d]; if (!v) continue; n++; total += v[fi.total] || 0; disabled += v[fi.disabled] || 0; low += v[fi.lowBattery] || 0; if (fi.stations != null) { stations += v[fi.stations] || 0; emptyDock += v[fi.stationsEmptyDock ?? fi.stationsEmpty] || 0; } }
  }
  if (!n || !total) return null;
  return { days: days.length, disabled: disabled / total, low: low / total, emptyDock: stations ? emptyDock / stations : null };
}

// ---------- Scope ----------
const muniName = (ags) => state.latest?.municipalities?.[ags]?.name || state.boundaries?.features.find(f => f.properties.ags === ags)?.properties.name || ags;
const muniInfo = (ags) => state.latest?.municipalities?.[ags] || null;
function scopeLabel() { return state.scope === 'DE' ? 'Deutschlandweit' : `${muniName(state.scope)} (${muniInfo(state.scope)?.state || ''})`; }
function keyMatches(key) {
  const [ags, op, ty] = key.split('|');
  if (state.scope === 'DE' ? ags === 'DE' : ags !== state.scope) return false;
  if (state.operator !== 'all' && op !== state.operator) return false;
  if (state.type !== 'all' && ty !== state.type) return false;
  return true;
}
// Gruppen der aktuellen Datenbasis (Sammler oder Live) auf den Scope gefiltert
function scopeGroups() {
  const src = state.mode === 'live' && state.live ? state.live.groups : new Map(Object.entries(state.latest?.groups || {}));
  const out = new Map();
  for (const [k, st] of src) {
    const [ags, op, ty] = k.split('|');
    if (ags === 'DE') continue;
    if (state.scope !== 'DE' && ags !== state.scope) continue;
    if (state.operator !== 'all' && op !== state.operator) continue;
    if (state.type !== 'all' && ty !== state.type) continue;
    out.set(k, st);
  }
  return out;
}
function sourcesForScope() {
  const recs = state.latest?.sources || [];
  if (state.scope === 'DE') return recs;
  return recs.filter(r => (r.municipalities || []).includes(state.scope));
}
function liveRec(id) { return state.live?.recs.get(id) || null; }
// Eine Frische-Definition für Kachel, Tabelle und Ampel der Übersicht: Datenalter jetzt = Feedalter bei der Messung + Zeit seit der Messung.
// aktuell ≤ Sammler-Takt (20 Min.) + 10 Min., verzögert ≤ 60 Min., sonst veraltet. Im Demo-Stand zählt der Zeitpunkt des Laufs als „jetzt“.
const FRESH_MS = 30 * 60e3, DELAY_MS = 60 * 60e3;
const nowRef = () => DEMO && state.latest?.at ? state.latest.at : Date.now();
function effStatus(r) {
  if (!['live', 'delayed', 'stale', 'collector'].includes(r.status)) return { status: r.status, age: r.feedAgeMs ?? null };
  if (r.feedAgeMs == null) return { status: 'unknown', age: null };
  const age = Math.max(0, r.feedAgeMs) + Math.max(0, nowRef() - (r.checkedAt || state.latest?.at || nowRef()));
  return { status: age <= FRESH_MS ? 'live' : age <= DELAY_MS ? 'delayed' : 'stale', age };
}
const USABLE = new Set(['live', 'delayed']);
// Statistik-Summe inkl. der neuen Stationsfelder (Vertrag 3), auch wenn die Kernbibliothek sie noch nicht kennt
const STAT_EXTRA = ['stationsVirtual', 'stationsEmptyVirtual', 'stationsEmptyDock'];
function sumStats(list) {
  const out = C.sumStats(list);
  for (const f of STAT_EXTRA) { let n = 0, any = false; for (const st of list) if (st[f] != null) { any = true; n += st[f]; } if (any) out[f] = n; else delete out[f]; }
  return out;
}
// Anbieter-Übersicht für den Scope
function operatorRows() {
  const groups = scopeGroups();
  const byOp = new Map();
  for (const [k, st] of groups) { const op = k.split('|')[1]; if (!byOp.has(op)) byOp.set(op, []); byOp.get(op).push(st); }
  const recs = sourcesForScope();
  const rows = [];
  for (const [op, list] of byOp) {
    const st = sumStats(list);
    const ops = recs.filter(r => r.operator === op);
    const effective = ops.map(r => liveRec(r.id) || r);
    const eff = effective.map(effStatus);
    const usable = eff.filter(e => USABLE.has(e.status));
    const age = usable.length ? Math.max(...usable.map(e => e.age ?? 0)) : (eff[0]?.age ?? null);
    const status = usable.some(e => e.status === 'live') ? 'live' : usable.length ? 'delayed' : (eff[0]?.status || 'unknown');
    const dirs = [...new Set(effective.flatMap(r => r.directories || []))];
    const license = effective.map(r => r.license).find(Boolean) || null;
    const quality = usable.length ? Math.round(effective.filter((r, i) => USABLE.has(eff[i].status)).reduce((a, r) => a + (r.quality || 0), 0) / usable.length) : null;
    const changed = effective.some(r => r.sourceChanged);
    rows.push({ op, st, sources: effective, status, age, dirs, license, quality, changed, delta: deltaVsCollector(op) });
  }
  // Bekannte Lücken im Scope
  for (const g of state.latest?.gaps || []) {
    const ags = state.scope === 'DE' ? null : state.scope;
    if (ags && muniName(ags) !== g.city) continue;
    if (state.operator !== 'all' && g.operator !== state.operator) continue;
    if (byOp.has(g.operator) && ags) continue;
    rows.push({ op: g.operator, st: C.emptyStats(), sources: [], status: 'gap', age: null, dirs: [], license: null, quality: null, gap: g, delta: null });
  }
  rows.sort((a, b) => b.st.available - a.st.available || a.op.localeCompare(b.op));
  return rows;
}
// Δ gegenüber letztem Sammler-Punkt (nur sinnvoll im Live-Modus, gleicher Fingerabdruck)
function deltaVsCollector(op) {
  if (state.mode !== 'live' || !state.live || !state.latest) return null;
  const recs = sourcesForScope().filter(r => r.operator === op);
  if (!recs.length || recs.some(r => { const l = liveRec(r.id); return l && r.fingerprint && l.fingerprint && l.fingerprint !== r.fingerprint; })) return null;
  let a = 0, b = 0;
  for (const [k, st] of state.live.groups) if (keyMatchesOp(k, op)) a += st.available;
  for (const [k, st] of Object.entries(state.latest.groups)) if (keyMatchesOp(k, op)) b += st.available;
  return { diff: a - b, sinceMs: Date.now() - state.latest.at };
}
function keyMatchesOp(k, op) { const [ags, o, ty] = k.split('|'); if (ags === 'DE') return false; if (state.scope !== 'DE' && ags !== state.scope) return false; if (o !== op) return false; if (state.type !== 'all' && ty !== state.type) return false; return true; }

// ---------- Live-Abruf ----------
// Automatischer Live-Abruf nach Gebietswahl/Deep-Link nur in der Übersicht (dort sind Positionen zu sehen); in anderen Ansichten erst beim
// Öffnen der Übersicht – spart Grenzen (2,4 MB) und Feed-Abrufe, wenn z. B. direkt „Nutzung“ geöffnet wird. „Live abrufen“ wirkt sofort.
let pendingLive = false;
function autoLive() {
  if (DEMO || !state.latest || state.scope === 'DE') return;
  if (currentView === 'live') { pendingLive = false; liveFetch(); } else pendingLive = true;
}
async function liveFetch() {
  if (DEMO) return; // Demo-Stand bleibt eingefroren
  const cat = state.catalog?.sources || [];
  const recs = sourcesForScope();
  const idSet = new Set(recs.map(r => r.id));
  // Katalogquellen für den Scope; ohne Sammler-Stand: alles (mit Fortschritt)
  let targets = cat.filter(s => !s.disabled && (state.scope === 'DE' && !state.latest ? true : idSet.has(s.id) || idSet.has(`${s.id}`) || recs.some(r => r.parent === s.id)));
  if (state.scope !== 'DE' && !targets.length) targets = cat.filter(s => !s.disabled);
  const btn = $('#btn-live'); btn.disabled = true;
  const n = notice(`Live-Abruf: <span class="mono" id="live-prog">0 / ${targets.length}</span> Quellen <div class="progress"><i></i></div>`, '', 'live');
  await loadBoundaries();
  const systems = new Map(), recsOut = new Map();
  let done = 0; const now = Date.now();
  const worker = async (src) => {
    try {
      const subs = recs.filter(r => r.parent === src.id);
      if (src.auth || subs.length) {
        // Zugangsquellen (MOBIDROM): Momentaufnahme des Sammlers
        for (const r of subs.length ? subs : [src]) {
          const snap = await getJson(CFG.DATA + `snapshot/${r.id.replace(/[^\w.-]+/g, '_')}.json`);
          if (snap.ok) { systems.set(r.id, snapshotToSystem(snap.json, r)); recsOut.set(r.id, summarizeSnapshot(src, r, snap.json, now)); }
          else recsOut.set(r.id, { ...r, status: 'collector', checkedAt: r.checkedAt });
        }
        return;
      }
      const known = recs.find(x => x.id === src.id);
      if (known?.cors === false) {
        // Sammler hat festgestellt: kein CORS-Header → gar nicht erst im Browser versuchen
        const snap = await getJson(CFG.DATA + `snapshot/${src.id.replace(/[^\w.-]+/g, '_')}.json`);
        if (snap.ok) { systems.set(src.id, snapshotToSystem(snap.json, src)); recsOut.set(src.id, summarizeSnapshot(src, known, snap.json, now)); return; }
        if (['live', 'delayed'].includes(known.status)) { recsOut.set(src.id, { ...known, status: 'collector', corsBlocked: true }); return; }
      }
      if (known?.candidate && !['live', 'delayed', 'stale', 'unknown'].includes(known.status)) { recsOut.set(src.id, known); return; }
      const sys = src.api === 'citybikes' ? await C.readCityBikesNetwork(src, getJson, { now }) : await C.readGbfsSystem(src, getJson, { now });
      if (sys.httpStatus === 0 && !sys.vehicles.length && !sys.stations.length) {
        // Browser darf die Quelle nicht lesen (kein CORS): Momentaufnahme des Sammlers
        const r = recs.find(x => x.id === src.id);
        const snap = await getJson(CFG.DATA + `snapshot/${src.id.replace(/[^\w.-]+/g, '_')}.json`);
        if (snap.ok) { systems.set(src.id, snapshotToSystem(snap.json, src)); recsOut.set(src.id, summarizeSnapshot(src, r, snap.json, now)); return; }
        if (r && ['live', 'delayed'].includes(r.status)) { recsOut.set(src.id, { ...r, status: 'collector', corsBlocked: true }); return; }
      }
      systems.set(src.id, sys);
      recsOut.set(src.id, summarize(src, sys, now));
    } finally { done++; const p = $('#live-prog'); if (p) p.textContent = `${done} / ${targets.length}`; const bar = $('#notice [data-id=live] .progress i'); if (bar) bar.style.width = `${(done / targets.length) * 100}%`; }
  };
  let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < targets.length) await worker(targets[i++]); }));
  // Zusammenführen
  const vehicles = [], stations = [];
  for (const [id, sys] of systems) {
    const rec = recsOut.get(id); const usable = rec.status === 'live' || rec.status === 'delayed';
    if (!usable) continue;
    const src = cat.find(s => s.id === id) || recs.find(r => r.id === id) || {};
    const agsSet = new Set();
    for (const v of sys.vehicles) {
      if (v.geoStatus !== 'ok') continue;
      const m = state.bIndex ? C.assignMunicipality(state.bIndex, v.lat, v.lon) : null;
      const ags = m?.ags || 'unbekannt'; agsSet.add(ags);
      vehicles.push({ ...v, operator: rec.operator, sourceId: id, priority: src.priority ?? 2, ags, feedAgeMs: rec.vehicleFeedAgeMs });
    }
    for (const s of sys.stations) {
      if (!C.validLatLon(s.lat, s.lon)) continue;
      const m = state.bIndex ? C.assignMunicipality(state.bIndex, s.lat, s.lon) : null;
      const ags = m?.ags || 'unbekannt'; agsSet.add(ags);
      stations.push({ ...s, operator: rec.operator, sourceId: id, priority: src.priority ?? 2, ags, hasVehicleList: !!sys.vehicleListPresent, feedAgeMs: rec.stationFeedAgeMs });
    }
    rec.municipalities = [...agsSet];
  }
  vehicles.sort((a, b) => a.priority - b.priority);
  const dv = C.dedupeVehicles(vehicles), ds = C.dedupeStations(stations);
  const groups = C.aggregateGroups(dv.vehicles, ds.stations, { chargeThreshold: state.thresholds.charge, rangeThreshold: state.thresholds.range });
  // Quellen ohne Browserzugang und ohne Momentaufnahme: Sammler-Summen übernehmen
  const have = new Set([...groups.keys()].map(k => k.split('|').slice(0, 2).join('|')));
  for (const r of recsOut.values()) {
    if (r.status !== 'collector') continue;
    for (const ags of r.municipalities || []) { if (have.has(`${ags}|${r.operator}`)) continue; for (const [k, st] of Object.entries(state.latest?.groups || {})) if (k.startsWith(`${ags}|${r.operator}|`)) groups.set(k, { ...st }); }
  }
  state.live = { at: now, systems, groups, vehicles: dv.vehicles, stations: ds.stations, recs: recsOut, dedupe: { ...dv.stats, stationDuplicates: ds.duplicates }, targets: targets.length };
  clearNotice('live'); btn.disabled = false;
  const failed = [...recsOut.values()].filter(r => !['live', 'delayed', 'collector'].includes(r.status));
  if (failed.length) notice(`${failed.length} von ${recsOut.size} Quellen lieferten keine verwertbaren Live-Daten (${esc([...new Set(failed.map(r => STATUS[r.status] || r.status))].join(', '))}). Fehlende Anbieter bleiben aus dem Sammler-Stand sichtbar.`, 'warn', 'livefail'); else clearNotice('livefail');
  if (!state.bIndex) notice('Ohne Gemeindegrenzen (erster Sammler-Lauf fehlt) werden Live-Bestände nicht nach Ort getrennt.', 'warn', 'nob');
  state.mode = 'live'; $('#sel-mode').value = 'live';
  renderAll();
}
function summarize(src, sys, now) {
  const rec = { id: src.id, operator: src.operator, name: src.name, api: src.api, url: src.url, directories: src.directories, priority: src.priority ?? 2, status: 'error', httpStatus: sys.httpStatus, latencyMs: sys.latencyMs, errors: sys.errors, license: sys.systemInfo?.licenseId || sys.systemInfo?.licenseUrl || src.license || null, version: sys.version || null, feedAgeMs: null, vehicleFeedAgeMs: null, stationFeedAgeMs: null, fingerprint: null, quality: null, counts: { vehicles: sys.vehicles.length, stations: sys.stations.length }, municipalities: [], checkedAt: now };
  if (sys.httpStatus === 404 || sys.httpStatus === 410) rec.status = 'gone';
  else if (sys.httpStatus === 401 || sys.httpStatus === 403) rec.status = 'auth';
  else if (!sys.vehicles.length && !sys.stations.length) rec.status = sys.errors.length ? 'error' : 'empty';
  else {
    const vAge = sys.feedAges.vehicle_status ?? sys.feedAges.free_bike_status ?? null, sAge = sys.feedAges.station_status ?? null;
    const ages = [vAge, sAge].filter(a => a != null);
    rec.vehicleFeedAgeMs = vAge; rec.stationFeedAgeMs = sAge; rec.feedAgeMs = ages.length ? Math.max(...ages) : (sys.lastUpdated != null ? now - sys.lastUpdated : null);
    rec.status = C.freshness(rec.feedAgeMs);
  }
  rec.fingerprint = C.fingerprint(sys); rec.quality = C.qualityScore(sys, now).score;
  const prev = state.latest?.sources.find(r => r.id === src.id); rec.sourceChanged = !!(prev?.fingerprint && prev.fingerprint !== rec.fingerprint);
  return rec;
}
function summarizeSnapshot(src, rec, snap, now) {
  const age = (now - snap.at) + (snap.feedAgeMs || 0);
  return { ...(rec || {}), id: src.id, operator: rec?.operator || snap.operator || src.operator, name: src.name || rec?.name, api: src.api, url: src.url, directories: src.directories || rec?.directories || [], priority: src.priority ?? 2,
    status: C.freshness(age), feedAgeMs: age, vehicleFeedAgeMs: age, stationFeedAgeMs: age, snapshot: true, snapshotAt: snap.at, errors: [], httpStatus: rec?.httpStatus ?? null, quality: rec?.quality ?? null, fingerprint: rec?.fingerprint ?? null, license: rec?.license ?? null, checkedAt: snap.at, counts: { vehicles: (snap.vehicles || []).length, stations: (snap.stations || []).length } };
}
function snapshotToSystem(snap, rec) {
  return {
    vehicles: (snap.vehicles || []).map(([lat, lon, type, flags, battery, range], i) => ({ rawId: `${rec.id}#${i}`, lat, lon, type, reserved: !!(flags & 1), disabled: !!(flags & 2), batteryPct: battery, rangeKm: range, geoStatus: 'ok', geoOrigin: 'vehicle', reportedAt: snap.at, positionAgeMs: Date.now() - snap.at })),
    stations: (snap.stations || []).map(([lat, lon, name, phys, bookable, docks, renting, returning], i) => ({ id: `${rec.id}#s${i}`, name, lat, lon, physicalAvailable: phys, bookable, docksAvailable: docks, renting: !!renting, returning: !!returning, installed: true, reportedAt: snap.at, typeHint: 'unknown' })),
    vehicleListPresent: (snap.vehicles || []).length > 0, feedAges: {}, errors: [], systemInfo: {},
  };
}

// ---------- Rendering ----------
// Drei Hauptbereiche; die alten Ansichten bleiben Sections und werden als Segmente gezeigt. Alte Hashes funktionieren weiter.
const VIEWS = ['live', 'lab', 'usage', 'ops', 'signals', 'coverage', 'bericht', 'sources'];
const GROUPS = [
  { id: 'markt', label: 'Marktbild', segs: [['live', 'Übersicht'], ['lab', 'Leistung'], ['usage', 'Nutzung'], ['coverage', 'Anbieter'], ['bericht', 'Bericht']] },
  { id: 'ops', label: 'Disposition', segs: [['ops', 'Disposition']] },
  { id: 'vertrauen', label: 'Datenvertrauen', segs: [['sources', 'Quellen'], ['signals', 'Signale']] },
];
const VIEW_ALIAS = { report: 'bericht', kommune: 'bericht', markt: 'live', marktbild: 'live', uebersicht: 'live', disposition: 'ops', vertrauen: 'sources', datenvertrauen: 'sources' };
const CLIENT_HIDDEN = new Set(['usage', 'sources', 'signals']); // Kundenansicht: ohne Schätzungen und Datenvertrauen
let currentView = 'live', urlReady = false;
const resolveView = (h) => { let n = VIEW_ALIAS[h] || h; if (!VIEWS.includes(n)) n = 'live'; if (isClient() && CLIENT_HIDDEN.has(n)) n = 'live'; return n; };
function setView(name) {
  name = resolveView(name);
  if (name !== 'usage') { const fl = document.getElementById('fl-panel'); if (fl) Fl.abortFlows?.(fl); }
  const group = GROUPS.find(g => g.segs.some(([v]) => v === name));
  currentView = name;
  $$('section.view').forEach(s => s.classList.toggle('active', s.id === `view-${name}`));
  $$('#nav a').forEach(a => { const on = a.dataset.group === group.id; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#crumb-group').textContent = group.label;
  renderSegments(group, name);
  const segLabel = group.segs.length > 1 ? group.segs.find(([v]) => v === name)?.[1] : null;
  document.title = `${segLabel ? `${segLabel} · ` : ''}${group.label} · Mobility Pulse`;
  if (name === 'live') setTimeout(() => { state.map?.invalidateSize(); if (!dirty.has('live')) fitMap(); }, 50);
  // nur die aktive Ansicht ist gerendert; beim Wechsel wird sie nachgezogen, wenn sich seit dem letzten Zeichnen etwas geändert hat
  if (dirty.has(name)) renderView(name);
  else if (name === 'ops') renderOps(); // prüft selbst, ob der Plan neu gerechnet werden muss
  if (name === 'live' && pendingLive && dataReady) { pendingLive = false; liveFetch(); }
  syncUrl();
}
// ---------- Ansichten zeichnen: nur die sichtbare ----------
// Hook für weitere Module (z. B. web/report.js): VIEW_RENDER[name] = [fn, …] ergänzen; renderAll() markiert alle Ansichten als veraltet
// und zeichnet die aktive, setView() zeichnet eine veraltete Ansicht beim Öffnen.
const VIEW_RENDER = { live: [() => renderLive()], lab: [() => renderLab(), () => renderPricing(), () => renderShareChart()], usage: [() => renderUsage()], ops: [() => renderOps()], signals: [() => renderSignals()], coverage: [() => renderCoverage()], sources: [() => renderSources()] };
const dirty = new Set(VIEWS); let dataReady = false;
// Ein fehlerhaftes Panel darf die übrigen nicht mitreißen
const safe = (f) => { try { const r = f(); if (r?.catch) r.catch(e => console.error(f.name, e)); } catch (e) { console.error(f.name, e); } };
function renderView(name) {
  if (!dataReady) return; // vor dem ersten Datenstand nichts zeichnen (sonst kurz „keine Daten“)
  dirty.delete(name); (VIEW_RENDER[name] || []).forEach(safe);
}
const markDirty = (...names) => { for (const n of names) if (n === currentView) renderView(n); else dirty.add(n); };
function renderSegments(group, name) {
  const seg = $('#seg');
  const segs = group.segs.filter(([v]) => !(isClient() && CLIENT_HIDDEN.has(v)));
  if (segs.length < 2) { seg.hidden = true; seg.dataset.key = ''; return; }
  const key = `${group.id}|${isClient()}`;
  if (seg.dataset.key !== key) { seg.innerHTML = segs.map(([v, l]) => `<a href="#${v}" data-v="${v}">${l}</a>`).join(''); seg.dataset.key = key; seg.classList.add('instant'); }
  seg.hidden = false;
  $$('a', seg).forEach(a => { if (a.dataset.v === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  placeSeg();
  requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('instant')));
}
// Gleitender Indikator: Position und Breite des aktiven Segments; ohne Messung bleibt der schlichte Hintergrund
function placeSeg() {
  const seg = $('#seg'); const a = seg && !seg.hidden && seg.querySelector('a[aria-current]');
  if (!a || !a.offsetWidth) { seg?.classList.remove('ready'); return; }
  seg.style.setProperty('--seg-x', `${a.offsetLeft}px`); seg.style.setProperty('--seg-w', `${a.offsetWidth}px`); seg.style.setProperty('--seg-o', '1');
  seg.classList.add('ready');
}
// Gebiet, Anbieter, Fahrzeugart (und Kundenansicht) in der URL halten: ?scope=…&op=…&type=…#ansicht
function syncUrl() {
  if (!urlReady) return;
  const q = new URLSearchParams(location.search);
  const inOps = currentView === 'ops';
  const op = inOps ? (opsFleet() || state.operator) : state.operator;
  const ty = inOps ? $('#ops-type').value : state.type;
  const put = (k, v) => v && v !== 'all' && v !== 'DE' ? q.set(k, v) : q.delete(k);
  put('scope', state.scope); put('op', op); put('type', ty); put('kunde', isClient() ? '1' : null);
  if (!CFG.DATA_OK) q.delete('data'); // abgelehntes ?data= nicht weitergeben
  const s = q.toString().replace(/%2F/g, '/');
  try { history.replaceState(history.state, '', `${location.pathname}${s ? `?${s}` : ''}#${currentView}`); } catch { /* file:// o. Ä. */ }
}
function applyUrlParams() {
  const has = (sel, v) => v != null && [...$(sel).options].some(o => o.value === v);
  const sc = QS.get('scope');
  if (has('#sel-scope', sc)) { state.scope = sc; $('#sel-scope').value = sc; }
  else if (sc && sc !== 'DE') notice(`Gebiet <span class="mono">${esc(sc)}</span> aus dem Link ist im aktuellen Sammler-Stand nicht enthalten (Gemeindeschlüssel unbekannt oder dort kein Angebot) – gezeigt wird Deutschlandweit.`, 'warn', 'scope');
  populateOperators();
  const op = QS.get('op'), ty = QS.get('type');
  if (resolveView(location.hash.slice(1)) === 'ops') applyOpsParams({ op, type: ty });
  else {
    if (has('#sel-operator', op)) { state.operator = op; $('#sel-operator').value = op; }
    if (has('#sel-type', ty)) { state.type = ty; $('#sel-type').value = ty; }
  }
  urlReady = true;
  return state.scope !== 'DE';
}
function setClient(on) {
  document.body.classList.toggle('mode-client', on);
  $('#btn-client').setAttribute('aria-pressed', String(on));
  $('#btn-share').textContent = on ? 'Kundenlink kopieren' : 'Link kopieren';
  $$('abbr[data-gloss]').forEach(a => { a.title = gl(a.dataset.gloss); });
  setView(currentView); if (dataReady) renderAll(); // alle Texte in der passenden Sprache (Kunde: ohne Methodik-Begriffe)
}
async function copyLink() {
  syncUrl();
  const btn = $('#btn-share'), url = location.href; let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch {
    try { const t = document.createElement('textarea'); t.value = url; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(t); t.select(); ok = document.execCommand('copy'); t.remove(); } catch { ok = false; }
  }
  btn.textContent = ok ? 'Kopiert ✓' : 'Kopieren nicht möglich'; btn.classList.toggle('done', ok);
  clearTimeout(copyLink.t); copyLink.t = setTimeout(() => { btn.textContent = isClient() ? 'Kundenlink kopieren' : 'Link kopieren'; btn.classList.remove('done'); }, 1600);
}
// Nach neuem Datenstand oder Filterwechsel: Kopf sofort, Ansichten als veraltet markieren, nur die aktive zeichnen
// Berichtsmodul (web/report.js): bekommt die Helfer und Lader der Seite, teilt deren Cache
const rpCtx = () => ({ state, CFG, esc, fmt, getJson: getJsonShared, opColor, muniName, loadUsageIndex, loadEvents, loadHistory, loadCells,
  setScope: (ags) => { const sel = $('#sel-scope'); if (![...sel.options].some(o => o.value === ags)) return; sel.value = ags; sel.dispatchEvent(new Event('change')); } });
const rp = (fn, id) => () => { const el = document.getElementById(id); if (el) return fn(el, rpCtx()); };
VIEW_RENDER.bericht = [rp(Rp.renderReport, 'rp-report'), rp(Rp.renderRegulationProfile, 'rp-reg'), rp(Rp.renderCaps, 'rp-caps'), rp(Rp.renderFeeCalculator, 'rp-fees'), rp(Rp.renderWeekHeatmap, 'rp-week'), rp(Rp.renderHotspotStability, 'rp-hot')];
VIEW_RENDER.lab.push(rp(Rp.renderAvailability, 'rp-avail'), rp(Rp.renderCityRanking, 'rp-rank'), rp(Rp.renderDensityScatter, 'rp-scatter'));
VIEW_RENDER.usage.push(rp(Fl.renderFlows, 'fl-panel'));
VIEW_RENDER.sources.push(rp(Rp.renderFeedChecks, 'rp-feedchecks'), rp(Rp.renderPriceLog, 'rp-pricelog'), () => renderCalibPanel());
function renderAll() {
  dataReady = true;
  safe(renderHeader);
  for (const v of VIEWS) dirty.add(v);
  renderView(currentView);
}
// Ein Stand oben: „Sammler 09:26 · vor 7 Min.“ bzw. „Live 09:33“; die Seitenleiste nennt nur den Umfang
function renderStamp() {
  const live = state.mode === 'live' && state.live;
  const at = live ? state.live.at : state.latest?.at;
  const pill = $('#stand-pill');
  if (pill) { pill.textContent = !at ? 'Stand –' : live ? `Live ${timeText(at)}` : `${cl('Sammler', 'Stand')} ${timeText(at)} · vor ${ageText(Date.now() - at)}`; pill.classList.toggle('stale', !live && !DEMO && !!at && Date.now() - at > 45 * 60e3); pill.title = at ? `Datenstand ${new Date(at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' })}` : ''; }
  const el = $('#side-stamp'); if (!el) return;
  el.textContent = state.latest ? `${fmt(state.latest.counts?.sources)} Quellen · ${fmt(state.latest.counts?.municipalities)} Gemeinden` : cl('Sammler: noch kein Lauf', 'Noch keine Daten');
}
function renderHeader() {
  $('#crumb-scope').textContent = scopeLabel();
  // Auswahl zeigt den tatsächlich gezeigten Stand samt Uhrzeit
  const sm = $('#sel-mode'); sm.value = state.mode === 'live' && state.live ? 'live' : 'collector';
  sm.options[0].textContent = state.latest ? `Sammler-Stand ${timeText(state.latest.at)}` : 'Sammler-Stand (alle 20 Min.)';
  sm.options[1].textContent = state.live ? `Live-Abruf ${timeText(state.live.at)}` : 'Live-Abruf im Browser';
  renderStamp();
  const h = dataHealth();
  const el = $('#filter-count');
  el.innerHTML = isClient() ? `<span class="health ${h.level}"><i></i>${h.label}${h.staleRun ? ` · Daten ${ageText(Date.now() - state.latest.at)} alt` : ''}</span>`
    : `<span class="health ${h.level}"><i></i>${h.label}${h.counted ? ` · ${fmt(h.fresh)} von ${fmt(h.counted)} erreichbaren Quellen aktuell` : ''}${h.staleRun ? ` · Sammler-Lauf ${ageText(Date.now() - state.latest.at)} alt` : ''}</span>`;
  el.title = isClient() ? gl('fresh') : h.detail;
  renderAttribution();
}
// Ampel zur Datenlage im Gebiet: nicht erreichbare Quellen und geprüfte Kandidaten ohne Feed zählen nicht als Fehler; ebenso Dubletten
// (gleiches System über eine zweite Adresse) und länger als 14 Tage verschwundene Quellen (retired)
const NOT_COUNTED = new Set(['gone', 'foreign', 'duplicate', 'retired']);
function dataHealth() {
  const recs = sourcesForScope().map(r => liveRec(r.id) || r);
  const eff = recs.map(effStatus);
  const by = {}; for (const e of eff) by[e.status] = (by[e.status] || 0) + 1;
  const counted = eff.filter((e, i) => { const r = recs[i]; return !NOT_COUNTED.has(e.status) && !(r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(e.status)); });
  const fresh = counted.filter(e => e.status === 'live').length;
  const usable = counted.filter(e => USABLE.has(e.status)).length;
  const staleRun = !DEMO && !!state.latest && !(state.mode === 'live' && state.live) && Date.now() - state.latest.at > 45 * 60e3;
  const ratio = counted.length ? usable / counted.length : 0;
  let level = !counted.length ? 'none' : ratio >= 0.8 ? 'ok' : ratio >= 0.5 ? 'warn' : 'bad';
  if (staleRun && level === 'ok') level = 'warn';
  const label = { ok: 'Datenlage gut', warn: 'Datenlage eingeschränkt', bad: 'Datenlage schwach', none: state.latest ? cl('Keine Quellen im Gebiet', 'Keine Daten im Gebiet') : cl('Noch kein Sammler-Stand', 'Noch keine Daten') }[level];
  const detail = `${recs.length} Quellen im Gebiet · ${Object.entries(by).map(([k, v]) => `${v} ${STATUS[k] || k}`).join(' · ')}${state.live ? ` · Live-Dubletten bereinigt: ${state.live.dedupe.duplicates}` : ''}\nAktuell = Datenalter bis 30 Min. (Sammler-Takt 20 Min. + 10), verzögert bis 60 Min., sonst veraltet. Nicht erreichbare Quellen und Direktfeed-Kandidaten ohne Daten zählen nicht als Fehler.`;
  return { level, label, fresh, usable, counted: counted.length, staleRun, detail };
}
// Namensnennung: Anbieter/Attribution und Lizenzen der Quellen im Gebiet (Vertrag 2), Verzeichnisse und BKG – kompakt für Karte und Fußzeile
const LIC_SHORT = (l) => { if (!l) return null; const s = String(l); const m = s.match(/creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/i); if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`; if (/publicdomain\/zero|CC0/i.test(s)) return 'CC0'; if (/dl-de\/by-2-0|DL-DE.?BY.?2/i.test(s)) return 'dl-de/by-2-0'; if (/odbl/i.test(s)) return 'ODbL'; if (/^https?:/.test(s)) { try { return new URL(s).hostname.replace(/^www\./, ''); } catch { return s; } } return s.length > 24 ? `${s.slice(0, 22)}…` : s; };
function attributionParts() {
  const recs = sourcesForScope().filter(r => !(r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status)) && !NOT_COUNTED.has(r.status));
  const by = new Map();
  for (const r of recs) { const name = r.attribution || r.operator; if (!name) continue; const e = by.get(name) || { lic: new Set(), n: 0 }; e.n++; const l = LIC_SHORT(r.licenseId || r.license); if (l) e.lic.add(l); by.set(name, e); }
  const names = [...by].sort((a, b) => b[1].n - a[1].n).map(([n, e]) => `${n}${e.lic.size ? ` (${[...e.lic].join(', ')})` : ''}`);
  const dirs = new Set(recs.flatMap(r => r.directories || []));
  const extra = [dirs.has('mobidata_bw') ? 'MobiData BW' : null, dirs.has('mobidrom_nrw') ? 'MOBIDROM NRW' : null, dirs.has('citybikes') ? 'CityBikes' : null, 'BKG (dl-de/by-2-0)'].filter(Boolean);
  return { names, extra };
}
// Fußzeile in allen Ansichten (auch Kundenansicht): Anbieter/Lizenzen der Quellen im Gebiet, Verzeichnisse, BKG VG250, OSM
function renderAttribution() {
  const { names, extra } = attributionParts();
  const shown = names.slice(0, 8), rest = names.length - shown.length;
  const dirs = extra.filter(x => !/^BKG/.test(x));
  const foot = $('#page-foot');
  if (foot) {
    foot.innerHTML = `<span><b>Daten</b> ${esc([...shown, rest > 0 ? `+${rest} weitere` : null].filter(Boolean).join(', ') || 'Sammler-Stand wird geladen')}${dirs.length ? ` · über ${esc(dirs.join(', '))}` : ''} · ${cl('Lizenz je Quelle unter Datenvertrauen › Quellen', 'Nutzung gemäß den Lizenzen der Anbieter')}</span>`
      + `<span><b>Gemeindegrenzen</b> ${esc(state.latest?.boundaries?.attribution?.replace(/\s*\(.*\)\s*$/, '') || '© GeoBasis-DE / BKG')}, VG250, <a href="https://www.govdata.de/dl-de/by-2-0" target="_blank" rel="noopener">dl-de/by-2-0</a></span>`
      + `<span><b>Karten</b> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende (ODbL) · Wetter <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0) · Routing FOSSGIS/OSRM · Adressen Nominatim</span>`;
    foot.title = names.join('\n');
  }
  if (state.map?.attributionControl) {
    const short = `Daten: ${[...names.slice(0, 4), names.length > 4 ? `+${names.length - 4}` : null, ...extra].filter(Boolean).map(esc).join(', ')}`;
    if (state.mapAttrib) state.map.attributionControl.removeAttribution(state.mapAttrib);
    state.mapAttrib = short; state.map.attributionControl.addAttribution(short);
  }
}
function tile(l, v, s, cls = '', title = '') { return `<div class="tile ${cls}"${title ? ` title="${esc(title)}"` : ''}><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
// Kernaussage über den Kacheln der Übersicht
function renderLede() {
  const el = $('#live-lede'); if (!el) return;
  if (!state.latest && !state.live) { el.textContent = 'Noch kein Datenstand geladen.'; return; }
  const st = sumStats([...scopeGroups().values()]); const h = dataHealth();
  const sig = computeSignals().filter(s => s.sev !== 'info').length;
  const place = state.scope === 'DE' ? 'Deutschland' : muniName(state.scope);
  const filt = [state.operator !== 'all' ? state.operator : null, state.type !== 'all' ? TYPE[state.type] : null].filter(Boolean).join(', ');
  const dataTxt = h.level === 'ok' ? 'Daten aktuell' : h.staleRun ? `${cl('Sammler-Stand', 'Daten')} ${ageText(Date.now() - state.latest.at)} alt` : h.level === 'warn' ? 'Daten teils verzögert' : h.level === 'bad' ? 'Daten lückenhaft' : cl('keine Quellen', 'keine Daten');
  const sigTxt = `${fmt(sig)} Auffälligkeit${sig === 1 ? '' : 'en'}`;
  el.innerHTML = `<b>${esc(place)}${filt ? ` · ${esc(filt)}` : ''}:</b> <strong>${fmt(st.available)}</strong> Fahrzeuge verfügbar · ${st.total ? `<strong>${pctf(st.disabled, st.total)}</strong> gesperrt` : 'keine Fahrzeugdaten'} · ${isClient() ? sigTxt : `<a href="#signals">${sigTxt}</a>`} · <span class="health ${h.level}" title="${esc(isClient() ? gl('fresh') : h.detail)}"><i></i>${dataTxt}</span>`;
}
const dirLabel = (d) => esc(DIRS[d] || d);
const pillStatus = (s) => `<span class="pill ${esc(s)}">${esc(STATUS[s] || s)}</span>`;
function renderLive() {
  const groups = scopeGroups(); const st = sumStats([...groups.values()]);
  const rows = operatorRows();
  const recs = sourcesForScope().map(r => liveRec(r.id) || r);
  const eff = recs.map(effStatus);
  const usable = eff.filter(e => USABLE.has(e.status));
  const gaps = rows.filter(r => r.gap).length;
  const en = energyFor(), lowE = !en.pending && en.known ? en.low / en.known : null;
  const dockKnown = st.stationsEmptyDock != null;
  $('#live-tiles').innerHTML = [
    tile('Verfügbar · buchbar', fmt(st.available), `${fmt(st.total)} gemeldet · ${fmt(st.reserved)} reserviert`),
    tile('Gesperrt', fmt(st.disabled), `${st.total ? `${pctf(st.disabled, st.total)} des Bestands` : 'keine Fahrzeugdaten'}${ghostsInScope() ? ` · <abbr title="Gesperrt und seit über 7 Tagen kein Signal: verwaiste Einträge im Feed (z. B. eingelagerte oder verlorene Fahrzeuge). Nicht im Bestand gezählt.">+${fmt(ghostsInScope())} verwaist</abbr>` : ''}`, st.total && st.disabled / st.total > 0.15 ? 'warn' : ''),
    tile('Stationen mit Angebot', `${fmt(st.stationsRenting - st.stationsEmpty)} / ${fmt(st.stations)}`, st.stations ? `${fmt(st.stationsEmpty)} leer${dockKnown ? ` (${fmt(st.stationsEmptyDock)} Docks, ${fmt(st.stationsEmptyVirtual)} Abstellzonen)` : ''} · ${fmt(st.stationsFull)} voll` : 'keine Stationen im Gebiet', '', st.stations ? emptyTip(st) : ''),
    tile('Energie niedrig', energyVal(en), energySub(en), lowE > 0.3 ? 'warn' : ''),
    tile(cl('Quellen', 'Datenaktualität'), `${fmt(usable.length)} / ${fmt(recs.length)}`, `${eff.filter(e => e.status === 'live').length} aktuell · ${eff.filter(e => e.status === 'delayed').length} verzögert · ${eff.filter(e => e.status === 'stale').length} veraltet${gaps ? ` · ${gaps} ${cl('Datenlücke', 'Anbieter ohne Daten')}${gaps > 1 && !isClient() ? 'n' : ''}` : ''}`, recs.length && usable.length / recs.length < 0.7 ? 'warn' : '', gl('fresh')),
  ].join('');
  // Tabelle: „Δ Sammler“ nur, wenn es etwas zeigt (Live-Abruf mit Abweichung); Lizenzen stehen unter Datenvertrauen › Quellen
  const showDelta = rows.some(r => r.delta && r.delta.diff !== 0);
  const tbl = $('#tbl-operators'); tbl.classList.toggle('no-delta', !showDelta);
  $$('th', tbl).forEach((th, i) => { if (i === 4) th.hidden = !showDelta; });
  const cols = 9 - (showDelta ? 0 : 1);
  $('#tbl-operators tbody').innerHTML = rows.map(r => {
    const s = r.st;
    const d = r.delta ? `<span style="color:var(--${r.delta.diff > 0 ? 'ok' : r.delta.diff < 0 ? 'bad' : 'muted'})">${r.delta.diff > 0 ? '+' : ''}${fmt(r.delta.diff)}</span><div class="sub-line">${ageText(r.delta.sinceMs)}</div>` : '—';
    if (r.gap) return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line">${esc(r.gap.city)} · seit ${esc(r.gap.since)}</div></td><td colspan="${cols - 2}" class="sub-line">${esc(r.gap.note)}</td><td><span class="pill gap">Datenlücke</span></td></tr>`;
    const e = energyOfOp(r.op);
    const eCell = e.pending ? '…' : !e.known ? 'k. A.' : `${energyVal(e)}<div class="sub-line">${fmt(e.known)} mit Angabe${e.rangeOnly === e.known ? ' · nur Reichweite' : e.rangeOnly ? ` · ${fmt(e.rangeOnly)} nur Reichweite` : ''}</div>`;
    return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line internal">${r.sources.length} Quelle${r.sources.length === 1 ? '' : 'n'}${r.changed ? ' · Quellenwechsel' : ''}${r.sources.some(x => x.snapshot) ? ' · Momentaufnahme Sammler' : ''}${r.sources.some(x => x.status === 'collector') ? ' · Sammler-Stand' : ''}</div></td>
      <td class="internal">${r.dirs.map(dirLabel).join(' · ') || '–'}<div class="sub-line">Qualität ${esc(r.quality ?? '–')}/100</div></td>
      <td class="n">${fmt(s.available)}<div class="sub-line">${fmt(s.total)} gemeldet</div></td><td class="n">${fmt(s.disabled)}</td>${showDelta ? `<td class="n">${d}</td>` : ''}
      <td class="n">${eCell}</td>
      <td class="n"${s.stations ? ` title="${esc(emptyTip(s))}"` : ''}>${s.stations ? `${fmt(s.stationsEmpty)} / ${fmt(s.stations)}` : '—'}</td><td class="n">${ageText(r.age)}</td>
      <td>${isClient() && r.status === 'collector' ? '<span class="pill live">Stand</span>' : pillStatus(r.status)}</td></tr>`;
  }).join('') || emptyRow(cols, 'Keine Anbieter im gewählten Filter.', state.operator !== 'all' || state.type !== 'all' ? 'Anbieter und Fahrzeugart auf „Alle“ stellen.' : state.scope === 'DE' ? (state.latest ? cl('Keine Daten im Sammler-Stand.', 'Keine Daten.') : failedText('latest.json')) : cl('Anderes Gebiet wählen oder „Live abrufen“.', 'Anderes Gebiet wählen.'));
  renderBriefing(rows, st);
  renderLede();
  renderMap();
}
// Verwaiste Einträge (gesperrt, > 7 Tage ohne Signal) der Quellen im Gebiet/Anbieter-Filter
function ghostsInScope() { return sourcesForScope().filter(r => state.operator === 'all' || r.operator === state.operator).reduce((a, r) => a + (r.counts?.ghosts || 0), 0); }
// Briefing: je Karte Zahl + eine Zeile, Begründung unter „Warum?“
function renderBriefing() {
  const items = computeSignals().slice(0, 4);
  $('#briefing').innerHTML = items.length ? items.map(s => sigCard(s, true)).join('') : '<div class="empty"><b>Keine auffälligen Signale im Gebiet.</b>Bestand, Sperren, Energie und Quellen sind unauffällig.</div>';
}

// ---------- Karte ----------
const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function initMap() {
  const map = L.map('map', { preferCanvas: true, zoomControl: true, zoomAnimation: !REDUCED(), fadeAnimation: !REDUCED(), markerZoomAnimation: !REDUCED() }).setView([51.1, 10.4], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende' }).addTo(map);
  state.map = map;
  state.layers = { vehicles: L.layerGroup().addTo(map), stations: L.layerGroup().addTo(map), muni: L.layerGroup().addTo(map), wfs: L.layerGroup().addTo(map), supply: L.layerGroup().addTo(map), bubbles: L.layerGroup().addTo(map), grid: L.layerGroup().addTo(map), zones: L.layerGroup().addTo(map) };
  map.on('moveend', () => { if ($('#chk-wfs').checked) loadWfs(); });
}
function livePoints() {
  if (!state.live) return { vehicles: [], stations: [] };
  const f = (x) => (state.scope === 'DE' || x.ags === state.scope) && (state.operator === 'all' || x.operator === state.operator);
  return { vehicles: state.live.vehicles.filter(v => f(v) && (state.type === 'all' || v.type === state.type)), stations: state.live.stations.filter(f) };
}
// Fahrzeugpositionen aus dem Sammler-Stand (ops/<Land>.json, 1–6 MB je Land, einmal je Datenstand): bei gewählter Gemeinde statt der einen Blase.
// Rückgabe null, solange die Datei noch lädt (die Karte zeichnet sich danach neu) oder wenn sie fehlt.
state.fleet = new Map();
function decodeFleetDoc(doc) {
  const at = doc?.at ?? null, pos = Date.now() - (at || Date.now());
  const vehicles = (doc?.vehicles || []).map(([lat, lon, op, ty, flags, bat, range, idle, m]) => ({ lat, lon, operator: doc.ops?.[op], type: doc.types?.[ty] ?? 'unknown', reserved: !!(flags & 1), disabled: !!(flags & 2), batteryPct: bat ?? null, rangeKm: range ?? null, idleMin: idle, ags: doc.munis?.[m], positionAgeMs: pos, geoOrigin: 'vehicle' })).filter(v => C.validLatLon(v.lat, v.lon));
  const stations = (doc?.stations || []).map(([lat, lon, op, name, bookable, docks, capacity, m, renting, returning, physical]) => ({ lat, lon, operator: doc.ops?.[op], name, bookable, docksAvailable: docks, capacity, ags: doc.munis?.[m], renting: !!renting, returning: !!returning, physicalAvailable: physical })).filter(s => C.validLatLon(s.lat, s.lon));
  return { at, vehicles, stations };
}
function collectorPoints() {
  if (state.scope === 'DE' || !state.latest) return null;
  const stCode = scopeState(); if (!stCode) return null;
  if (!state.fleet.has(stCode)) {
    state.fleet.set(stCode, 'loading');
    cached(`ops/${stCode}.json`, 90000).then(r => { const d = r.ok ? decodeFleetDoc(r.json) : null; state.fleet.set(stCode, d); if (d && !state.live?.vehicles.some(v => v.ags === state.scope) && scopeState() === stCode) renderMap(); });
    return null;
  }
  const doc = state.fleet.get(stCode); if (!doc || doc === 'loading') return null;
  const f = (x) => x.ags === state.scope && (state.operator === 'all' || x.operator === state.operator);
  return { at: doc.at, vehicles: doc.vehicles.filter(v => f(v) && (state.type === 'all' || v.type === state.type)), stations: doc.stations.filter(f) };
}
function renderMap() {
  if (!state.map) return;
  if (currentView !== 'live') { dirty.add('live'); return; } // verdeckte Karte nicht zeichnen (Größe 0); beim Öffnen der Übersicht nachziehen
  const L_ = state.layers; Object.values(L_).forEach(l => l.clearLayers());
  const layerMode = $('#sel-layer').value;
  const bg = bgColor(); // Punktrand in der Hintergrundfarbe
  if (['flow', 'served', 'idle'].includes(layerMode)) {
    $('#map-title').textContent = `Karte ${scopeLabel()}`;
    $('#map-sub').textContent = layerMode === 'flow' ? 'Fahrtbeginne und -enden je Zelle (Sammler)' : layerMode === 'served' ? 'Zellen mit verfügbarem Fahrzeug, letzte 7 Tage' : 'Verfügbare Fahrzeuge, die seit über 2 Tagen unbewegt stehen';
    renderMuniLayer();
    fitMap(); renderZonesLayer();
    (layerMode === 'flow' ? renderFlowLayer : layerMode === 'served' ? renderServedLayer : renderIdleLayer)();
    renderOpLegend([]);
    return;
  }
  clearNotice('flow');
  const live = state.live ? livePoints() : null;
  const coll = !(live && (live.vehicles.length || live.stations.length)) ? collectorPoints() : null; // Live-Abruf ohne Positionen (kein CORS, keine Momentaufnahme): Sammler-Positionen
  const src = live && (live.vehicles.length || live.stations.length) ? live : coll && (coll.vehicles.length || coll.stations.length) ? coll : null;
  const { vehicles, stations } = src || { vehicles: [], stations: [] };
  const legend = [];
  const inScope = state.scope !== 'DE';
  if (src) {
    $('#map-title').textContent = `Karte ${scopeLabel()}`;
    const step = Math.max(1, Math.ceil(vehicles.length / CFG.MAX_POINTS));
    let drawn = 0;
    if (layerMode === 'points') {
      if ($('#chk-vehicles').checked) for (let i = 0; i < vehicles.length; i += step) {
        const v = vehicles[i]; drawn++;
        const col = v.disabled ? DISABLED_COL : opColor(v.operator);
        L.circleMarker([v.lat, v.lon], { radius: 4.5, weight: 2, color: bg, fillColor: col, fillOpacity: v.disabled ? .7 : .95, opacity: 1 })
          .bindPopup(`<b>${esc(v.operator)}</b> · ${esc(TYPE[v.type] || v.type)}<br>${v.disabled ? 'gesperrt' : v.reserved ? 'reserviert' : 'verfügbar'}${v.batteryPct != null ? ` · Akku ${fmt(v.batteryPct)} %` : ''}${v.rangeKm != null ? ` · ${fmt(v.rangeKm, 1)} km` : ''}${v.idleMin != null ? ` · steht seit ${durText(v.idleMin * 60e3)}` : ''}<br><span class="muted">Position ${ageText(v.positionAgeMs)}${isClient() ? '' : ` · ${v.geoOrigin === 'station' ? 'Stationsersatz' : 'GPS'}${v.reusedId ? ' · Kennung wiederverwendet' : ''}${src === coll ? ' · Sammler-Stand' : ''}`}</span>`).addTo(L_.vehicles);
      }
      if ($('#chk-stations').checked) for (const s of stations) {
        // gemeldet leer, aber Fahrzeuge desselben Anbieters ≤ 50 m daneben: faktisch versorgt, also in Anbieterfarbe
        const near = s.nearbyVehicles || 0, empty = s.renting !== false && (s.bookable ?? 0) === 0 && !near;
        L.rectangle([[s.lat - .00035, s.lon - .0005], [s.lat + .00035, s.lon + .0005]], { weight: 2, color: empty ? '#e3b341' : opColor(s.operator), fillOpacity: .2 })
          .bindPopup(`<b>${esc(s.name || 'Station')}</b> · ${esc(s.operator)}<br>physisch ${fmt(s.physicalAvailable)} · buchbar ${fmt(s.bookable)} · Plätze ${fmt(s.docksAvailable)}${near ? `<br>${fmt(near)} Fahrzeug${near === 1 ? '' : 'e'} im Umkreis ${C.STATION_NEAR_M ?? 50} m` : ''}${s.nearbyOther ? `<br><span class="muted">dazu ${fmt(s.nearbyOther)} anderer Anbieter (${esc((s.nearbyOtherOps || []).join(', '))})</span>` : ''}<br><span class="muted">${s.renting === false ? 'Ausleihe gesperrt' : 'vermietend'} · ${s.returning === false ? 'Rückgabe gesperrt' : 'Rückgabe möglich'}</span>`).addTo(L_.stations);
      }
      const ops = [...new Set(vehicles.map(v => v.operator))].slice(0, 12);
      legend.push(...ops.map(o => `<span><i class="dot" style="background:${opColor(o)}"></i>${esc(o)}</span>`), `<span><i class="dot" style="background:${DISABLED_COL}"></i>gesperrt</span>`, `<span><i class="sq"></i>Station</span>`, `<span><i class="sq" style="border-color:#e3b341"></i>Station leer (kein Fahrzeug ≤ ${C.STATION_NEAR_M ?? 50} m)</span>`, `<span class="muted">${fmt(drawn)} / ${fmt(vehicles.length)} Fahrzeuge gezeichnet${step > 1 ? ' (ausgedünnt)' : ''}</span>`);
    } else {
      // Rasterzellen ca. 500 m
      const cells = new Map();
      // Energie niedrig wie überall (energyLow): Grenzen des Live-Abrufs bzw. des Sammlers, je nachdem woher die Positionen stammen
      const lim = src === coll ? { charge: state.latest?.thresholds?.chargeThreshold ?? R.ENERGY_CHARGE, range: state.latest?.thresholds?.rangeThreshold ?? R.ENERGY_RANGE_KM } : { charge: state.thresholds.charge, range: state.thresholds.range };
      for (const v of vehicles) { if (v.disabled) continue; const k = `${Math.round(v.lat / 0.0045)}:${Math.round(v.lon / 0.007)}`; const c = cells.get(k) || { lat: Math.round(v.lat / 0.0045) * 0.0045, lon: Math.round(v.lon / 0.007) * 0.007, n: 0, low: 0, known: 0 }; c.n++; const lw = R.energyLow(v.batteryPct, v.rangeKm, { ...lim, rangeOnly: rangeOnly(v.operator) }); if (lw != null) { c.known++; if (lw) c.low++; } cells.set(k, c); }
      const max = Math.max(1, ...[...cells.values()].map(c => layerMode === 'energy' ? c.low : c.n));
      for (const c of cells.values()) {
        const val = layerMode === 'energy' ? c.low : c.n; if (!val) continue;
        const a = 0.15 + 0.7 * (val / max);
        L.rectangle([[c.lat - .00225, c.lon - .0035], [c.lat + .00225, c.lon + .0035]], { weight: 0, fillColor: layerMode === 'energy' ? '#e3b341' : '#49c7b0', fillOpacity: a })
          .bindPopup(layerMode === 'energy' ? `${fmt(c.low)} Fahrzeuge mit niedriger Energie (Ladestand &lt; ${fmt(lim.charge)} % und Reichweite &lt; ${fmt(lim.range)} km) von ${fmt(c.known)} mit Angabe` : `${fmt(c.n)} verfügbare Fahrzeuge in dieser Zelle`).addTo(L_.grid);
      }
      legend.push(`<span>${layerMode === 'energy' ? `Energie niedrig (Ladestand &lt; ${fmt(lim.charge)} % und Reichweite &lt; ${fmt(lim.range)} km; Lime über die Reichweite)` : 'Verfügbare Fahrzeuge'} je ${cl('~500-m-Zelle', 'Fläche von etwa 500 × 500 m')}, dunkler = mehr (max ${fmt(max)})</span>`);
    }
    if (src === coll) legend.push(`<span class="muted">${cl(`Sammler-Stand ${timeText(coll.at)} – „Live abrufen“ ersetzt die Positionen.`, `Stand ${timeText(coll.at)}`)}</span>`);
  } else {
    // Sammler-Stand ohne Positionen: Gemeinde-Blasen (Mittelpunkte aus latest.json, sonst aus den Grenzen)
    $('#map-title').textContent = state.scope === 'DE' ? 'Karte Deutschlandweit' : `Karte ${scopeLabel()}`;
    const munis = state.latest?.municipalities || {};
    const groups = scopeGroups();
    const perMuni = new Map();
    for (const [k, st] of groups) { const [ags, op] = k.split('|'); const m = perMuni.get(ags) || { ags, available: 0, total: 0, ops: {} }; m.available += st.available; m.total += st.total; m.ops[op] = (m.ops[op] || 0) + st.available; perMuni.set(ags, m); }
    const centers = muniCenters();
    if (!centers.size && perMuni.size && !hasCenters() && !boundariesReq) loadBoundaries().then(() => renderMap()); // alter Datenstand ohne Mittelpunkte
    const max = Math.max(1, ...[...perMuni.values()].map(m => m.available));
    for (const m of perMuni.values()) {
      const c = centers.get(m.ags); if (!c) continue;
      const top = Object.entries(m.ops).sort((a, b) => b[1] - a[1])[0]?.[0];
      L.circleMarker(c, { radius: 4 + Math.sqrt(m.available / max) * 26, weight: 1.5, color: bg, fillColor: opColor(top), fillOpacity: .5 })
        .bindPopup(`<b>${esc(munis[m.ags]?.name || m.ags)}</b> (${esc(munis[m.ags]?.state || '')})<br>${fmt(m.available)} verfügbar · ${fmt(m.total)} gemeldet<br>${Object.entries(m.ops).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${esc(o)} ${fmt(n)}`).join(' · ')}<br><a href="#live" data-ags="${esc(m.ags)}" class="pick-muni">Ort öffnen</a>`).addTo(L_.bubbles);
    }
    const loading = state.scope !== 'DE' && state.fleet.get(scopeState()) === 'loading';
    legend.push(`<span>Blase = verfügbare Fahrzeuge je Gemeinde (${cl('Sammler-Stand', 'Stand')} ${timeText(state.latest?.at)}), Farbe = größter Anbieter</span>`, `<span class="muted">${loading ? 'Fahrzeugpositionen werden geladen …' : state.scope === 'DE' ? 'Gemeinde wählen für Fahrzeugpositionen.' : cl('Für Fahrzeugpositionen „Live abrufen“.', '')}</span>`);
  }
  renderMuniLayer();
  $('#map-legend').innerHTML = legend.join('');
  renderOpLegend(vehicles);
  $('#map-sub').textContent = src ? `${fmt(vehicles.length)} Fahrzeuge · ${fmt(stations.length)} Stationen · ${src === live ? `Live ${timeText(state.live.at)}` : `${cl('Sammler-Stand', 'Stand')} ${timeText(coll.at)}`}` : 'Fahrzeuge und Stationen';
  fitMap();
  if ($('#chk-wfs').checked) loadWfs();
  renderZonesLayer();
  if (state.supply && $('#chk-supply-on')) renderSupplyLayer();
}
// Gemeindegrenze nur auf Wunsch (lädt die 2,5-MB-Datei erst dann)
function renderMuniLayer() {
  const L_ = state.layers; L_.muni.clearLayers();
  if (!$('#chk-muni').checked || state.scope === 'DE') return;
  if (!state.boundaries) { loadBoundaries().then(b => { if (b && $('#chk-muni').checked) renderMuniLayer(); }); return; }
  const f = state.boundaries.features.find(x => x.properties.ags === state.scope);
  if (f) L.geoJSON(f, { style: { color: '#6aa9ff', weight: 1.5, fillOpacity: .04 } }).addTo(L_.muni);
}
// Mittelpunkte: aus latest.json (municipalities[].c, Vertrag 1), sonst aus den Grenzen
function muniCenters() {
  const out = new Map();
  for (const [ags, m] of Object.entries(state.latest?.municipalities || {})) if (Array.isArray(m.c) && C.validLatLon(m.c[0], m.c[1])) out.set(ags, [m.c[0], m.c[1]]);
  if (state.boundaries) for (const f of state.boundaries.features) if (!out.has(f.properties.ags)) { const b = f.bbox; out.set(f.properties.ags, [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2]); }
  return out;
}
let lastFitKey = null;
// Einpassen: Gemeindegrenze, sonst Fahrzeugpunkte (Live oder Sammler), sonst Mittelpunkt; Grundlage steckt im Schlüssel, damit ein späterer Nachlader neu einpasst
function fitMap(force = false) {
  const map = state.map;
  let basis = 'n', bounds = null, center = null;
  if (state.scope !== 'DE') {
    const f = state.boundaries?.features.find(x => x.properties.ags === state.scope);
    const lp = state.live ? livePoints() : null;
    const pts = (lp?.vehicles.length ? lp : collectorPoints())?.vehicles || [];
    if (f) { const b = f.bbox; basis = 'b'; bounds = [[b[1], b[0]], [b[3], b[2]]]; }
    else if (pts.length) { basis = 'p'; bounds = L.latLngBounds(pts.slice(0, 2000).map(v => [v.lat, v.lon])); }
    else { const c = muniCenters().get(state.scope); if (c) { basis = 'c'; center = c; } }
  }
  const key = `${state.scope}|${state.mode}|${state.operator}|${basis}`;
  if (!force && key === lastFitKey) return; lastFitKey = key;
  if (bounds) map.fitBounds(bounds, { padding: [10, 10] });
  else if (center) map.setView(center, 12);
  else map.setView([51.1, 10.4], 6);
}
async function loadWfs() {
  const L_ = state.layers; L_.wfs.clearLayers();
  const map = state.map; if (map.getZoom() < 11) { notice('MobiData-Karte: ab Stadtzoom (Zoom ≥ 11) laden.', '', 'wfs'); return; }
  const b = map.getBounds();
  const url = `${CFG.WFS}?service=WFS&version=2.0.0&request=GetFeature&typeName=MobiData-BW:sharing_vehicles&outputFormat=application/json&srsName=EPSG:4326&count=4000&bbox=${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()},EPSG:4326`;
  const r = await getJson(url, { timeout: 30000 });
  if (!r.ok || !r.json?.features) { notice(`MobiData-Kartenquelle nicht erreichbar (${r.error || r.status}). <a href="https://www.mobidata-bw.de/karten/ipl/sharing/" target="_blank" rel="noopener">Originalkarte ↗</a>`, 'warn', 'wfs'); return; }
  clearNotice('wfs');
  const now = Date.now(); let n = 0, fresh = 0, old = 0, unk = 0;
  for (const f of r.json.features) {
    const [lon, lat] = f.geometry?.coordinates || []; if (!C.validLatLon(lat, lon)) continue;
    const p = f.properties || {};
    if (state.operator !== 'all' && !String(p.provider_name || p.operator || p.system_id || '').toLowerCase().includes(state.operator.toLowerCase())) continue;
    const ts = C.toMs(p.last_reported || p.last_updated || p.timestamp || p.updated_at);
    const age = ts != null ? now - ts : null;
    const cls = age == null ? 'unk' : age <= 30 * 60e3 ? 'fresh' : 'old';
    if (cls === 'fresh') fresh++; else if (cls === 'old') { old++; if (!$('#chk-wfs-old')?.checked) continue; } else unk++;
    n++;
    L.circleMarker([lat, lon], { radius: 3, weight: 1, color: cls === 'fresh' ? '#2dd4bf' : cls === 'old' ? '#8b949e' : '#e3b341', fillOpacity: .7 })
      .bindPopup(`<b>MobiData-Karte</b><br>${esc(p.provider_name || p.operator || p.system_id || '')} · ${esc(p.form_factor || p.vehicle_type || '')}<br><span class="muted">${age == null ? 'Aktualität ungeklärt' : `Meldung ${ageText(age)}`}</span>`).addTo(L_.wfs);
  }
  notice(`MobiData-Karte: ${fmt(n)} Punkte im Ausschnitt (${fresh} zeitlich bestätigt, ${unk} Aktualität ungeklärt, ${old} älter${r.json.features.length >= 4000 ? ', Antwort begrenzt' : ''}). Nicht in Kennzahlen enthalten.`, '', 'wfs');
}

// ---------- Energie niedrig: eine Regel für Übersicht, Briefing, Leistung, Karte und CSV (lib/pulse-report.js energyLow) ----------
// Wie die Disposition (lib/pulse-ops.js needsSwap): Ladestand < 20 % UND Reichweite < 5 km, wo beides gemeldet ist; sonst entscheidet die
// gemeldete Angabe. Anbieter, deren Feeds nur Reichweite melden (Lime; die Kernbibliothek leitet für sie einen Ladestand aus Reichweite ÷
// Maximalreichweite ab), zählen nur über die Reichweite. Gezählt je Fahrzeug: Live-Abruf (state.live.vehicles) oder Sammler-Stand
// (ops/<Land>.json; für Deutschland alle Länder, geteilter Cache mit Karte und Disposition). Fehlt die Datei: Rückfall auf die Zähler der
// Gruppe – genau, wo nur eine Angabe vorliegt; mit beiden Angaben höchstens min(Ladestand niedrig, Reichweite niedrig), als „≈“ markiert.
const RANGE_ONLY_OPS = new Set(R.RANGE_ONLY_OPS);
const rangeOnly = (op) => RANGE_ONLY_OPS.has(op) || (state.latest?.sources || []).some(r => r.operator === op && r.counts?.batteryNative === 0 && r.counts?.vehicles > 0);
const energyLimits = () => (state.mode === 'live' && state.live ? { charge: state.thresholds.charge, range: state.thresholds.range } : { charge: state.latest?.thresholds?.chargeThreshold ?? R.ENERGY_CHARGE, range: state.latest?.thresholds?.rangeThreshold ?? R.ENERGY_RANGE_KM });
const ENERGY = new Map(); let energyWait = 0; // `${Stand}|${Land}` → Map(Gruppe → Zähler) | 'loading' | null (Datei fehlt)
function energyLand(land) {
  const k = `${state.latest?.at}|${land}`;
  if (!ENERGY.has(k)) {
    ENERGY.set(k, 'loading'); energyWait++;
    const lim = { charge: state.latest?.thresholds?.chargeThreshold ?? R.ENERGY_CHARGE, range: state.latest?.thresholds?.rangeThreshold ?? R.ENERGY_RANGE_KM }; // Sammler-Stand: Grenzen des Sammlers
    cached(`ops/${land}.json`, 90000).then(r => { ENERGY.set(k, r.ok && r.json?.vehicles ? R.energyFromOps(r.json, { charge: lim.charge, range: lim.range, rangeOnly }) : null); }, () => ENERGY.set(k, null))
      .finally(() => { if (--energyWait === 0) markDirty('live', 'lab', 'signals'); });
  }
  return ENERGY.get(k);
}
let liveEnergy = null;
function liveEnergyGroups() {
  if (!(state.mode === 'live' && state.live?.vehicles?.length)) return null;
  const lim = energyLimits(), key = `${state.live.at}|${lim.charge}|${lim.range}|${state.live.vehicles.length}`;
  if (liveEnergy?.key !== key) {
    const m = new Map();
    for (const v of state.live.vehicles) { const k = `${v.ags}|${v.operator}|${v.type}`; const e = m.get(k) || R.emptyEnergy(); R.addEnergy(e, v.batteryPct, v.rangeKm, { ...lim, rangeOnly: rangeOnly(v.operator) }); m.set(k, e); }
    liveEnergy = { key, map: m };
  }
  return liveEnergy.map;
}
// Rückfall ohne Einzelfahrzeuge: aus den Zählern der Gruppe
function energyFromStats(op, st) {
  if (rangeOnly(op) || !st.batteryKnown) return { known: st.rangeKnown || 0, low: st.lowRange || 0, rangeOnly: st.rangeKnown || 0, rangeOnlyLow: st.lowRange || 0 };
  if (!st.rangeKnown) return { known: st.batteryKnown, low: st.lowBattery, rangeOnly: 0, rangeOnlyLow: 0 };
  return { known: Math.max(st.batteryKnown, st.rangeKnown), low: Math.min(st.lowBattery, st.lowRange), rangeOnly: Math.max(0, st.rangeKnown - st.batteryKnown), rangeOnlyLow: 0, approx: true };
}
function groupEnergy(k, st) {
  const live = liveEnergyGroups(); if (live?.has(k)) return live.get(k);
  const land = state.latest?.municipalities?.[k.split('|')[0]]?.state;
  const m = land ? energyLand(land) : null;
  if (m === 'loading') return { pending: true };
  if (m instanceof Map) return m.get(k) || R.emptyEnergy(); // Gruppe ohne Fahrzeugliste (z. B. nur Stationen): keine Energieangabe
  return energyFromStats(k.split('|')[1], st);
}
// Energie über die Gruppen im Gebiet und Filter; keep(key) wählt zusätzlich aus (Anbieter, Art)
function energyFor(keep = null) {
  const out = { ...R.emptyEnergy(), pending: false, approx: false };
  for (const [k, st] of scopeGroups()) { if (keep && !keep(k)) continue; const e = groupEnergy(k, st); if (e.pending) { out.pending = true; continue; } if (e.approx) out.approx = true; for (const f of ['known', 'low', 'rangeOnly', 'rangeOnlyLow']) out[f] += e[f] || 0; }
  return out;
}
const energyOfOp = (op) => energyFor(k => k.split('|')[1] === op);
const energyRule = () => { const l = energyLimits(); return `Ladestand < ${fmt(l.charge)} % und Reichweite < ${fmt(l.range)} km`; };
const energyVal = (e) => (e.pending ? '…' : e.known ? `${e.approx ? '≈ ' : ''}${pctf(e.low, e.known)}` : 'k. A.');
const energySub = (e) => (e.pending ? 'Energie wird je Fahrzeug ausgewertet …' : e.known ? `${energyRule()} · ${fmt(e.low)} von ${fmt(e.known)} mit Energieangabe${e.rangeOnly ? ` (davon ${fmt(e.rangeOnly)} nur Reichweite)` : ''}${e.approx ? ' · ≈ Obergrenze ohne Einzelfahrzeuge' : ''}` : 'keine Energieangabe');
function renderLab() {
  const groups = scopeGroups(); const st = sumStats([...groups.values()]);
  // Energie niedrig je Fahrzeug nach der Regel der Disposition; Anbieter nur mit Reichweite (Lime) zählen über die Reichweite mit
  const en = energyFor(); const lim = energyLimits();
  $('#lab-tiles').innerHTML = [
    tile('Buchbare Fahrzeuge', fmt(st.available), `${pctf(st.available, st.total)} von ${fmt(st.total)} gemeldeten`),
    tile('Energie niedrig', energyVal(en), energySub(en), !en.pending && en.known && en.low / en.known > 0.3 ? 'warn' : ''),
    tile(`Reichweite unter ${fmt(lim.range)} km`, st.rangeKnown ? pctf(st.lowRange, st.rangeKnown) : 'k. A.', st.rangeKnown ? `${fmt(st.lowRange)} von ${fmt(st.rangeKnown)} mit Reichweite, unabhängig vom Ladestand` : 'keine Reichweitenangabe'),
    tile('Stationen mit Angebot', st.stations ? `${fmt(st.stationsRenting - st.stationsEmpty)} / ${fmt(st.stations)}` : '—', st.stations ? `${fmt(st.stationBookable)} buchbar · ${fmt(st.stationDocks)} freie Plätze` : 'keine Stationen im Filter', '', st.stations ? emptyTip(st) : ''),
  ].join('');
  // Fahrzeugarten
  const byType = new Map();
  for (const [k, s] of groups) { const ty = k.split('|')[2]; byType.set(ty, [...(byType.get(ty) || []), s]); }
  $('#tbl-types tbody').innerHTML = [...byType].map(([ty, list]) => { const s = sumStats(list); const e = energyFor(k => k.split('|')[2] === ty); return `<tr><td>${esc(TYPE[ty] || ty)}</td><td class="n">${fmt(s.total)}</td><td class="n">${fmt(s.available)}<div class="sub-line">${pctf(s.available, s.total)}</div></td><td class="n">${fmt(s.disabled)}</td><td class="n">${energyVal(e)}<div class="sub-line">${!e.pending && e.known ? `n = ${fmt(e.known)}${e.rangeOnly ? ` · ${fmt(e.rangeOnly)} nur Reichweite` : ''}` : ''}</div></td><td class="n">${s.rangeKnown ? pctf(s.lowRange, s.rangeKnown) : 'k. A.'}</td></tr>`; }).sort().join('') || emptyRow(6, 'Keine Fahrzeuge im Filter.', 'Fahrzeugart oder Anbieter auf „Alle“ stellen.');
  // Stationen je Anbieter
  const byOp = new Map();
  for (const [k, s] of groups) { const op = k.split('|')[1]; byOp.set(op, [...(byOp.get(op) || []), s]); }
  $('#tbl-stations tbody').innerHTML = [...byOp].map(([op, list]) => ({ op, s: sumStats(list) })).filter(x => x.s.stations).map(({ op, s }) => `<tr><td><span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span></td><td class="n">${fmt(s.stations)}</td><td class="n">${fmt(s.stationsRenting)}</td><td class="n" title="${esc(emptyTip(s))}">${fmt(s.stationsEmpty)}${s.stationsEmptyDock != null ? `<div class="sub-line">${fmt(s.stationsEmptyDock)} Docks · ${fmt(s.stationsEmptyVirtual)} Abstellzonen</div>` : ''}</td><td class="n">${fmt(s.stationsFull)}</td><td class="n">${fmt(s.stationPhysical)}</td><td class="n">${fmt(s.stationBookable)}</td><td class="n">${fmt(s.stationDocks)}</td></tr>`).join('') || emptyRow(8, 'Keine Stationen im Filter.', 'Stationen melden vor allem Bikesharing-Anbieter; Fahrzeugart „Alle“ zeigt sie.');
  // Scorecard
  const rows = operatorRows().filter(r => !r.gap);
  // Score = gleich gewichtetes Mittel der vorhandenen Teilwerte; die Gewichte stehen im Kopf, die genutzten Teile je Zeile im Tooltip
  $('#tbl-score tbody').innerHTML = rows.map(r => { const s = r.st; const avail = s.total ? s.available / s.total : null; const dis = s.total ? s.disabled / s.total : null; const e = energyOfOp(r.op); const low = !e.pending && e.known ? e.low / e.known : null; const emp = s.stations ? s.stationsEmpty / s.stations : null;
    const named = [['Verfügbar', avail != null ? avail * 100 : null], ['100 − Sperrquote', dis != null ? 100 - dis * 100 : null], ['100 − Energie niedrig', low != null ? 100 - low * 100 : null], ['100 − leere Stationen', emp != null ? 100 - emp * 100 : null], ['Quellenqualität', r.quality]].filter(x => x[1] != null);
    const score = named.length ? Math.round(named.reduce((a, x) => a + x[1], 0) / named.length) : null;
    const how = named.length ? `${named.map(([l, v]) => `${l} ${fmt(v)}`).join(' · ')} → je ${fmt(100 / named.length)} % Gewicht` : '';
    return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span></td><td class="n">${fmt(s.total)}</td><td class="n">${avail == null ? '—' : pctf(s.available, s.total)}</td><td class="n">${dis == null ? '—' : pctf(s.disabled, s.total)}</td><td class="n">${e.pending ? '…' : low == null ? 'k. A.' : energyVal(e)}</td><td class="n"${emp == null ? '' : ` title="${esc(emptyTip(s))}"`}>${emp == null ? '—' : pctf(s.stationsEmpty, s.stations)}</td><td class="n">${esc(r.quality ?? '—')}</td><td class="n" title="${esc(how)}"><b>${score ?? '—'}</b><div class="sub-line">${named.length} Teilwerte</div></td></tr>`; }).join('') || emptyRow(8, 'Keine Anbieter im Filter.', 'Gebiet mit Angebot wählen.');
  // Städtevergleich
  const munis = state.latest?.municipalities || {};
  const src = new Map(Object.entries(state.latest?.groups || {})); // Gebietsvergleich immer aus dem Sammler-Stand (vollständig)
  const per = new Map();
  for (const [k, s] of src) { const [ags, op, ty] = k.split('|'); if (ags === 'DE' || ags === 'unbekannt') continue; if (state.operator !== 'all' && op !== state.operator) continue; if (state.type !== 'all' && ty !== state.type) continue; const m = per.get(ags) || { ags, available: 0, ops: new Set(), scooter: 0, bikes: 0 }; m.available += s.available; m.ops.add(op); if (ty === 'scooter') m.scooter += s.available; else m.bikes += s.available; per.set(ags, m); }
  const list = [...per.values()].sort((a, b) => b.available - a.available).slice(0, 25);
  $('#cities-title').textContent = state.scope === 'DE' ? 'Stadt- und Gebietsvergleich' : `Gebietsvergleich · ${muniName(state.scope)} im Kontext`;
  renderHistory();
  $('#tbl-cities tbody').innerHTML = list.map(m => { const mi = munis[m.ags]; const pop = mi?.pop; return `<tr${m.ags === state.scope ? ' style="font-weight:600"' : ''}><td><a href="#live" class="pick-muni" data-ags="${esc(m.ags)}">${esc(mi?.name || m.ags)}</a> <span class="muted">${esc(mi?.state || '')}</span></td><td class="n">${fmt(m.available)}</td><td class="n">${pop ? fmt((m.available / pop) * 1e4, 1) : '—'}</td><td class="n">${m.ops.size}</td><td class="n">${fmt(m.scooter)}</td><td class="n">${fmt(m.bikes)}</td></tr>`; }).join('') || emptyRow(6, 'Keine Gemeinden im Filter.', state.latest ? 'Anbieter oder Fahrzeugart auf „Alle“ stellen.' : failedText('latest.json'));
}
async function renderHistory() {
  const idx = state.histIndex; const box = $('#chart-hist');
  if (!idx?.days?.length) { box.innerHTML = '<div class="empty"><b>Noch keine Sammler-Punkte.</b>Der Verlauf beginnt mit dem ersten Sammler-Lauf.</div>'; return; }
  const day = state.histDay || idx.days[idx.days.length - 1];
  $('#hist-days').innerHTML = idx.days.slice(-7).map(d => `<button class="chip ${d === day ? 'on' : ''}" aria-pressed="${d === day}" data-day="${esc(d)}">${esc(d.slice(8))}.${esc(d.slice(5, 7))}.</button>`).join('');
  const h = await loadHistory(day);
  if (!h) { box.innerHTML = `<div class="empty"><b>Verlauf nicht ladbar.</b>${esc(failedText(`history/${day}.json`))} – anderen Tag wählen oder die Seite später neu laden.</div>`; return; }
  const byOp = new Map();
  for (const [k, ser] of Object.entries(h.series)) {
    const [ags, op, ty] = k.split('|');
    if (state.scope === 'DE' ? ags !== 'DE' : ags !== state.scope) continue;
    if (state.scope === 'DE' && state.operator !== 'all') continue; // DE-Totale je Art, kein Anbieter
    if (state.operator !== 'all' && op !== state.operator) continue;
    if (state.type !== 'all' && ty !== state.type) continue;
    const name = state.scope === 'DE' ? (TYPE[ty] || ty) : op;
    const arr = byOp.get(name) || new Array(h.t.length).fill(null);
    alignSeries(ser.available, h.t.length).forEach((v, i) => { if (v != null) arr[i] = (arr[i] || 0) + v; });
    byOp.set(name, arr);
  }
  const series = [...byOp].map(([name, values]) => ({ name, values, color: state.scope === 'DE' ? null : opColor(name) })).sort((a, b) => Math.max(...b.values.filter(x => x != null), 0) - Math.max(...a.values.filter(x => x != null), 0)).slice(0, 8);
  const changes = (state.latest?.sources || []).filter(r => r.sourceChanged && (state.scope === 'DE' || (r.municipalities || []).includes(state.scope)));
  // Verlaufsdateien laufen nach UTC-Tag (ab 01:00 bzw. 02:00 Uhr), Ereignisdateien unter Nutzung nach Berliner Tag – daher andere Laufzahlen je Tag
  const utcStart = timeText(Date.parse(`${day}T00:00:00Z`));
  const sub = $('#hist-sub'); sub.innerHTML = isClient() ? `Verfügbare Fahrzeuge am ${esc(day.split('-').reverse().join('.'))}, ${timeText(h.t[0])}–${timeText(h.t[h.t.length - 1])} Uhr, ${abbr(`${fmt(h.t.length)} Messpunkte`, 'point')}`
    : `${abbr(`${fmt(h.t.length)} Sammler-Punkte`, 'point')} am ${esc(day.split('-').reverse().join('.'))} · ${timeText(h.t[0])}–${timeText(h.t[h.t.length - 1])} Uhr · Verlaufstag beginnt ${utcStart} Uhr (UTC), Nutzung zählt ab 00:00 Uhr${changes.length ? ` · ${changes.length} Quellenwechsel (Vergleich unterbrochen)` : ''}`;
  box.innerHTML = lineChart(h.t, series);
  $('#chart-legend').innerHTML = series.map((s, i) => `<span><i class="dot" style="background:${s.color || palette(i)}"></i>${esc(s.name)} <span class="mono">${fmt(s.values.filter(x => x != null).pop())}</span></span>`).join('');
}
// Verlaufsreihe auf die Länge von t bringen: Die DE-Summen (DE||Art) haben im aktuellen Datenstand je Lauf einen zusätzlichen null-Eintrag
// (Sammler schreibt null und den Wert); dann die Werte rechtsbündig auf die Läufe legen. Gleich lange Reihen bleiben unverändert.
function alignSeries(arr, n) {
  if (!Array.isArray(arr) || arr.length === n) return arr || [];
  const v = arr.filter(x => x != null);
  return v.length >= n ? v.slice(-n) : [...new Array(n - v.length).fill(null), ...v];
}
// Achsenwerte auf runde Schritte (1, 2, 2,5, 5 × 10^k): z. B. 0/100/200/300/400 statt 96/191/287/383
function niceTicks(max, n = 4) {
  if (!(max > 0)) return { step: 1, top: n, ticks: Array.from({ length: n + 1 }, (_, i) => i) };
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  const top = Math.ceil(max / step) * step;
  return { step, top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}
function lineChart(t, series) {
  const W = 900, H = 260, P = { l: 48, r: 12, t: 12, b: 26 };
  const vals = series.flatMap(s => s.values).filter(x => x != null);
  if (!vals.length) return '<div class="empty"><b>Keine Punkte für diesen Filter.</b>Anbieter oder Fahrzeugart auf „Alle“ stellen.</div>';
  const nt = niceTicks(Math.max(...vals) * 1.04 || 1), max = nt.top, min = 0;
  // Zeitachse statt Punktindex: Pausen über 45 Min. bleiben sichtbar (grau) und die Linie wird dort unterbrochen
  const t0 = t[0], t1 = Math.max(t[t.length - 1], t0 + 3600e3), GAP = 45 * 60e3;
  const x = (i) => P.l + ((t[i] - t0) / (t1 - t0)) * (W - P.l - P.r), xt = (ms) => P.l + ((ms - t0) / (t1 - t0)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  let g = '';
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > GAP) { const w = x(i) - x(i - 1); g += `<rect class="gap" x="${x(i - 1).toFixed(1)}" y="${P.t}" width="${w.toFixed(1)}" height="${H - P.t - P.b}"><title>kein Sammler-Lauf ${timeText(t[i - 1])}–${timeText(t[i])} Uhr</title></rect>${w > 60 ? `<text x="${(x(i - 1) + w / 2).toFixed(1)}" y="${P.t + 12}" text-anchor="middle">nicht gemessen</text>` : ''}`; }
  for (const v of nt.ticks) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${P.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v, nt.step < 1 ? 1 : 0)}</text>`;
  // volle Stunden (Berliner Zeit; Stundengrenzen fallen mit UTC zusammen)
  const span = t1 - t0, stepH = span > 12 * 3600e3 ? 3 : span > 5 * 3600e3 ? 2 : 1;
  for (let ms = Math.ceil(t0 / 3600e3) * 3600e3; ms <= t1; ms += 3600e3) if (!(hourOf(ms) % stepH)) g += `<text x="${xt(ms).toFixed(1)}" y="${H - 8}" text-anchor="middle">${timeText(ms)}</text>`;
  if (span <= 3600e3 * 1.5) g += `<text x="${x(0).toFixed(1)}" y="${H - 8}" text-anchor="start">${timeText(t0)}</text>`;
  series.forEach(s => { if (s.values.length > t.length) s.values = s.values.slice(0, t.length); }); // nie über die Zeitachse hinaus
  const paths = series.map((s, i) => { let d = '', open = false; s.values.forEach((v, j) => { if (v == null || (j && t[j] - t[j - 1] > GAP)) open = false; if (v == null) return; d += `${open ? 'L' : 'M'}${x(j).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); const last = s.values.map((v, j) => [v, j]).filter(([v]) => v != null).pop(); const dots = t.length <= 12 ? s.values.map((v, j) => v == null ? '' : `<circle cx="${x(j).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${s.color || palette(i)}"/>`).join('') : ''; return `<path d="${d}" fill="none" stroke="${s.color || palette(i)}" stroke-width="2" stroke-linejoin="round"/>${dots}${last ? `<circle cx="${x(last[1]).toFixed(1)}" cy="${y(last[0]).toFixed(1)}" r="3.5" fill="${s.color || palette(i)}"/>` : ''}`; }).join('');
  // Trefferflächen je Sammler-Punkt (von Mitte zu Mitte) mit allen Werten als Tooltip
  let hits = '';
  for (let i = 0; i < t.length; i++) { const a = i ? (x(i - 1) + x(i)) / 2 : P.l, b = i < t.length - 1 ? (x(i) + x(i + 1)) / 2 : W - P.r; const lines = series.filter(s => s.values[i] != null).sort((p, q) => q.values[i] - p.values[i]).map(s => `${s.name} ${fmt(s.values[i])}`); hits += `<rect class="hit" x="${a.toFixed(1)}" y="${P.t}" width="${Math.max(1, b - a).toFixed(1)}" height="${H - P.t - P.b}"><title>${timeText(t[i])} Uhr\n${esc(lines.join('\n') || 'keine Daten')}</title></rect>`; }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verlauf verfügbarer Fahrzeuge">${g}${paths}${hits}</svg>`;
}

// ---------- Signale ----------
let sigFilter = 'all';
// Schwere der drei Bestandsalarme (gesperrt, Energie, Stationen): „kritisch“ nur, wenn der Anteil ≥ 15 Punkte über dem Mittel der vorigen Tage liegt
// (history/daily.json, Vertrag 6); liegt er darunter: „auffällig“; ohne Vergleichswert: „Hinweis“.
// Ab 5 Punkten über dem Mittel „auffällig“, ab 15 „kritisch“; im üblichen Rahmen (dauerhaft hoher Anteil) nur „Hinweis“.
function severity(share, baseline, src = 'Vortage') {
  if (baseline == null) return { sev: 'info', foot: 'ohne Vergleichswert (noch kein Tagesmittel)' };
  const d = (share - baseline) * 100;
  return { sev: d >= 15 ? 'bad' : d >= 5 ? 'warn' : 'info', foot: `Ø ${src === 'Tag' ? 'des Tages bisher' : 'der Vortage'} ${fmt(baseline * 100)} % · ${d >= 0 ? '+' : ''}${fmt(d)} Punkte${d < 5 ? ' (üblich)' : ''}` };
}
// Rückfall ohne history/daily.json (bzw. für Stationen, die dort fehlen): Mittel der früheren Sammler-Punkte des geladenen Verlaufstags
function histBaseline(ags, op) {
  const h = state.hist[state.histIndex?.days?.slice(-1)[0]]; if (!h || h.t.length < 3) return null;
  const n = h.t.length - 1; let tot = 0, dis = 0, low = 0, sta = 0, emp = 0;
  for (const [k, ser] of Object.entries(h.series)) { if (!k.startsWith(`${ags}|${op}|`)) continue; for (let i = 0; i < n; i++) { tot += ser.total?.[i] || 0; dis += ser.disabled?.[i] || 0; low += ser.lowBattery?.[i] || 0; sta += ser.stations?.[i] || 0; emp += ser.stationsEmptyDock?.[i] ?? ser.stationsEmpty?.[i] ?? 0; } }
  return tot || sta ? { src: 'Tag', disabled: tot ? dis / tot : null, low: tot ? low / tot : null, emptyDock: sta ? emp / sta : null } : null;
}
function computeSignals() {
  const groups = scopeGroups(); const munis = state.latest?.municipalities || {};
  const by = new Map();
  const ebk = new Map(); // Energie je Gemeinde|Anbieter (Einzelfahrzeuge, Regel energyLow)
  for (const [k, s] of groups) {
    const [ags, op] = k.split('|'); const key = `${ags}|${op}`; by.set(key, [...(by.get(key) || []), s]);
    const g = groupEnergy(k, s), e = ebk.get(key) || { ...R.emptyEnergy(), pending: false, approx: false };
    if (g.pending) e.pending = true; else { if (g.approx) e.approx = true; for (const f of ['known', 'low', 'rangeOnly', 'rangeOnlyLow']) e[f] += g[f] || 0; }
    ebk.set(key, e);
  }
  const out = [];
  const place = (ags) => state.scope === 'DE' ? ` · ${munis[ags]?.name || ags}` : '';
  const daily = state.daily || null, today = BERLIN_DAY.format(state.latest?.at || Date.now());
  for (const [key, list] of by) {
    const [ags, op] = key.split('|'); const s = sumStats(list);
    const db = dailyBaseline(daily, ags, op, today), hb = histBaseline(ags, op);
    // Tagesmittel der Vortage, wo vorhanden; Stationen (nicht in daily.json) und alter Datenstand: Mittel des Tages bisher
    const base = { disabled: db?.disabled ?? hb?.disabled, low: db?.low ?? hb?.low, emptyDock: db?.emptyDock ?? hb?.emptyDock, src: db ? 'Vortage' : 'Tag', srcSt: db?.emptyDock != null ? 'Vortage' : 'Tag' };
    if (s.total >= 5 && s.disabled / s.total >= 0.25) { const sv = severity(s.disabled / s.total, base.disabled, base.src); out.push({ cat: 'disabled', sev: sv.sev, w: s.disabled, n: fmt(s.disabled), title: `${op}${place(ags)}: ${fmt(s.disabled)} gesperrt (${pctf(s.disabled, s.total)})`, text: 'Der Feed markiert Fahrzeuge als nicht nutzbar. Ein konkreter Wartungsauftrag ist daraus nicht ableitbar.', foot: `Gemeldetes is_disabled / Stationsfeld · ${sv.foot}` }); }
    // Energie niedrig: feste Regel für alle Anbieter (auch Lime über die Reichweite), wie Kacheln und Disposition. Die Stufe misst die
    // Abweichung vom Vortagesmittel am Ladestand-Anteil am Bestand – die Tageswerte (history/daily.json) kennen nur diesen Zähler.
    const e = ebk.get(key);
    if (!e.pending && e.known >= 5 && e.low / e.known >= 0.3) {
      const sv = severity(s.total ? s.lowBattery / s.total : 0, base.low, base.src); const ro = e.rangeOnly === e.known;
      out.push({ cat: 'energy', sev: sv.sev, w: e.low, n: energyVal(e), title: `${op}${place(ags)}: ${energyVal(e)} niedrige Energie`, text: `${fmt(e.low)} von ${fmt(e.known)} Fahrzeugen mit Energieangabe: ${energyRule()}${ro ? ' (Feed meldet nur Reichweite: unter der Reichweiten-Grenze)' : e.rangeOnly ? `; ${fmt(e.rangeOnly)} nur mit Reichweite` : ''}. Möglicher Ladebedarf.`, foot: `Energie je Fahrzeug · Arbeitsauftrag nicht bestätigt · Trend am Ladestand-Anteil: ${sv.foot}` });
    }
    // Leer zählt nur effektiv: gemeldet leer und kein verfügbares Fahrzeug desselben Anbieters ≤ 50 m. Alarm nur für Docks; virtuelle Stationen getrennt (Vertrag 3)
    const nearM = C.STATION_NEAR_M ?? 50, nearN = s.stationsEmptyNearby || 0;
    const otherN = s.stationsEmptyOtherNearby || 0;
    const nearTxt = (nearN ? ` Weitere ${fmt(nearN)} als leer gemeldet, aber Fahrzeuge ≤ ${nearM} m daneben (Fahrzeuge der Station nicht zugeordnet).` : '') + (otherN ? ` Bei ${fmt(otherN)} der leeren stehen Fahrzeuge anderer Anbieter ≤ ${nearM} m daneben (Marktsicht: dort findet man trotzdem ein Fahrzeug).` : '');
    const dockKnown = s.stationsEmptyDock != null;
    const docks = dockKnown ? s.stations - (s.stationsVirtual || 0) : s.stations, emptyDock = dockKnown ? s.stationsEmptyDock : s.stationsEmpty;
    if (docks >= 3 && emptyDock / docks >= 0.3) { const sv = severity(emptyDock / docks, base.emptyDock, base.srcSt); out.push({ cat: 'stations', sev: sv.sev, w: emptyDock, n: fmt(emptyDock), title: `${op}${place(ags)}: ${fmt(emptyDock)} leere ${dockKnown ? 'Dock-' : ''}Stationen (${pctf(emptyDock, docks)})`, text: `${fmt(emptyDock)} von ${fmt(docks)} gemeldeten ${dockKnown ? 'Dock-' : ''}Stationen bieten derzeit kein Fahrzeug, auch keins im Umkreis von ${nearM} m.${nearTxt}`, foot: `Stationsstatus und Fahrzeugpositionen · ${sv.foot}` }); }
    else if (docks >= 3 && nearN / s.stations >= 0.3) out.push({ cat: 'data', sev: 'info', w: nearN, n: fmt(nearN), title: `${op}${place(ags)}: ${fmt(nearN)} Stationen als leer gemeldet, Fahrzeuge daneben`, text: `Der Stationsfeed meldet kein buchbares Fahrzeug, aber ≤ ${nearM} m stehen verfügbare Fahrzeuge desselben Anbieters. Die Fahrzeuge sind der Station im Feed nicht zugeordnet; effektiv leer sind ${fmt(s.stationsEmpty)}.`, foot: 'Stationsstatus und Fahrzeugpositionen' });
    if (dockKnown && s.stationsEmptyVirtual > 0) out.push({ cat: 'stations', sev: 'info', w: s.stationsEmptyVirtual, n: fmt(s.stationsEmptyVirtual), title: `${op}${place(ags)}: ${fmt(s.stationsEmptyVirtual)} Abstellzonen ohne Fahrzeug`, text: `${fmt(s.stationsEmptyVirtual)} von ${fmt(s.stationsVirtual)} virtuellen Stationen (Abstellzonen ohne Dock) melden kein Fahrzeug. Bei Free-Floating-Angeboten ist das kein Versorgungsmangel.`, foot: 'is_virtual_station im Stationsfeed' });
    if (s.stations >= 3 && s.stationsFull / s.stations >= 0.3) out.push({ cat: 'stations', sev: 'info', w: s.stationsFull, n: fmt(s.stationsFull), title: `${op}${place(ags)}: ${fmt(s.stationsFull)} volle Stationen`, text: 'Rückgabe an diesen Stationen ist nicht möglich (keine freien Plätze).', foot: 'num_docks_available = 0' });
    if (s.total >= 5 && s.geoStation / s.total >= 0.5) out.push({ cat: 'data', sev: 'info', w: s.geoStation, n: fmt(s.geoStation), title: `${op}${place(ags)}: Positionen überwiegend Stationsersatz`, text: `${fmt(s.geoStation)} von ${fmt(s.total)} Fahrzeugen ohne eigene Koordinaten; Stationsposition wird als Ersatz gezeigt.`, foot: 'Geo-Prüfung' });
  }
  // Quellenzustand; geprüfte Direktfeed-Kandidaten ohne Feed sind kein Ausfall (wie in der Ampel)
  const recs = sourcesForScope().map(r => liveRec(r.id) || r);
  for (const r of recs) {
    if (r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status)) continue;
    if (['stale', 'gone', 'error', 'auth'].includes(r.status)) out.push({ cat: 'data', sev: r.status === 'stale' ? 'warn' : 'bad', w: 1, n: STATUS[r.status], title: `${r.operator}: Quelle ${(STATUS[r.status] || r.status).toLowerCase()}`, text: `${r.name || r.id}${r.feedAgeMs != null ? ` · Feed ${ageText(r.feedAgeMs)} alt` : ''}${r.errors?.length ? ` · ${r.errors[0]}` : ''}`, foot: `${(r.directories || []).map(d => DIRS[d] || d).join(' · ')}` });
    if (r.sourceChanged) out.push({ cat: 'data', sev: 'info', w: 1, n: '1', title: `${r.operator}: Quellenwechsel erkannt`, text: `${r.name || r.id}: Endpunkt, Version, Feeds oder Fahrzeugarten haben sich geändert. Zeitvergleiche beginnen neu.`, foot: 'Fingerabdruck' });
  }
  for (const e of state.usage?.consistency?.systems || []) { if (e.verdict !== 'divergent') continue; const r = (state.latest?.sources || []).find(x => x.id === e.sourceId); if (!r || (state.scope !== 'DE' && !(r.municipalities || []).includes(state.scope)) || (state.operator !== 'all' && e.operator !== state.operator)) continue; out.push({ cat: 'data', sev: 'warn', w: Math.abs((e.primary?.vehicles || 0) - (e.alt?.vehicles || 0)), n: fmt(Math.abs((e.primary?.vehicles || 0) - (e.alt?.vehicles || 0))), title: `${e.operator}: Landes- und Betreiberfeed weichen ab`, text: `${e.sourceId}: ${fmt(e.primary?.vehicles)} vs. ${fmt(e.alt?.vehicles)} Fahrzeuge, ${e.idOverlap == null ? '' : pctf(e.idOverlap, 1) + ' gemeinsame Kennungen, '}Median-Abstand ${e.medianDistM == null ? '—' : fmt(e.medianDistM) + ' m'}.`, foot: 'Konsistenzprüfung' }); }
  for (const g of state.latest?.gaps || []) if (state.scope === 'DE' || muniName(state.scope) === g.city) out.push({ cat: 'data', sev: 'info', w: 1, n: 'Lücke', title: `${g.operator} · ${g.city}: öffentliche Daten fehlen seit ${String(g.since || '').split('-').reverse().join('.')}`, text: g.note, foot: g.probeOk ? 'Feed wieder erreichbar' : `Feed geprüft: ${g.probeStatus ?? '–'}` });
  // Bestandssprung gegen Verlauf
  const h = state.histDay ? state.hist[state.histDay] : state.hist[state.histIndex?.days?.slice(-1)[0]];
  if (h && h.t.length >= 3) {
    for (const [key, list] of by) {
      const [ags, op] = key.split('|'); let prev = 0, cur = 0, n = 0;
      for (const [k, ser] of Object.entries(h.series)) { if (!k.startsWith(`${ags}|${op}|`)) continue; const a = ser.available; const lastIdx = a.length - 1; if (a[lastIdx] == null || a[lastIdx - 3] == null) continue; cur += a[lastIdx]; prev += a[lastIdx - 3]; n++; }
      if (n && prev >= 20 && Math.abs(cur - prev) / prev >= 0.3) out.push({ cat: 'jump', sev: 'warn', w: Math.abs(cur - prev), n: `${cur > prev ? '+' : ''}${fmt(cur - prev)}`, title: `${op}${place(ags)}: Bestand ${cur > prev ? '+' : ''}${fmt(cur - prev)} in einer Stunde`, text: `Verfügbar ${fmt(prev)} → ${fmt(cur)} über die letzten drei Sammler-Punkte. Ausleihen, Umverteilung oder ein Quellenproblem können dahinterstehen.`, foot: 'Sammler-Verlauf' });
    }
  }
  out.push(...groupSignals());
  const sevW = { bad: 3, warn: 2, info: 1 };
  return out.sort((a, b) => sevW[b.sev] - sevW[a.sev] || b.w - a.w);
}
// Tagesmittel für die Alarm-Schwere einmal je Datenstand laden; danach Briefing und Signale neu zeichnen
// Dazu der letzte Verlaufstag (Bestandssprung, Rückfall-Mittel); Briefing/Signale werden danach neu gezeichnet, je nach aktiver Ansicht
let dailyLoaded = false;
function ensureDaily() {
  if (dailyLoaded) return; dailyLoaded = true;
  const last = state.histIndex?.days?.slice(-1)[0];
  Promise.all([loadDaily(), last && !state.hist[last] ? loadHistory(last) : null]).then(([d, h]) => { state.daily = d; if (!d && !h) return; if (currentView === 'live') { renderBriefing(); renderLede(); } else dirty.add('live'); markDirty('signals'); });
}
// Gruppen-Ausbringungen (groups.json): einmal je Sammler-Stand anfragen, auch wenn die Datei fehlt; danach Briefing neu zeichnen
let groupsReq = null;
const loadGroups = () => groupsReq ??= loadOnce('groups', 'groups.json', 30000);
const BERLIN_DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });
function groupSignals() {
  ensureDaily();
  if (!groupsReq) loadGroups().then(d => { if (!d?.events?.length) return; renderBriefing(); if (currentView === 'signals') renderSignals(); });
  const d = state.usage.groups; if (!d?.events?.length) return [];
  const ix = Object.fromEntries((d.fields || ['at', 'art', 'anbieter', 'gemeinde', 'lat', 'lon', 'anzahl', 'arten']).map((f, i) => [f, i]));
  const ref = DEMO && state.latest?.at ? state.latest.at : Date.now(), today = BERLIN_DAY.format(ref);
  const by = new Map();
  for (const e of d.events) {
    if (e[ix.art] !== 'deploy' || !(e[ix.at] > ref - 30 * 3600e3) || BERLIN_DAY.format(e[ix.at]) !== today) continue;
    const ags = e[ix.gemeinde], op = e[ix.anbieter];
    if ((state.scope !== 'DE' && ags !== state.scope) || (state.operator !== 'all' && op !== state.operator) || (state.type !== 'all' && !(e[ix.arten]?.[state.type] > 0))) continue;
    const a = by.get(`${ags}|${op}`) || { n: 0, veh: 0 }; a.n++; a.veh += e[ix.anzahl] || 0; by.set(`${ags}|${op}`, a);
  }
  return [...by].map(([k, a]) => { const [ags, op] = k.split('|'); return { cat: 'deploy', sev: 'info', w: a.n, n: `${fmt(a.n)}×`, title: `${op} · ${muniName(ags)}: heute ${fmt(a.n)}× Gruppen ausgebracht (Ø ${fmt(a.veh / a.n)} Fahrzeuge)`, text: 'Mindestens 5 Fahrzeuge des Anbieters tauchten in einem Sammler-Lauf gemeinsam innerhalb von 40 m auf (Transporter-Ausbringung). Orte unter Disposition → „Vermutete Deploy-Spots“.', foot: 'Abgeleitet aus Beobachtung, keine Anbieterdaten' }; });
}
const CATS = { all: 'Alle', disabled: 'Gesperrt', energy: 'Energie', stations: 'Stationen', jump: 'Bestandssprung', deploy: 'Ausbringung', data: 'Datenqualität' };
const SEV_LABEL = { bad: 'kritisch', warn: 'auffällig', info: 'Hinweis' };
// compact: Briefing-Karte mit Zahl + einer Zeile; Begründung und Grundlage unter „Warum?“
function sigCard(s, compact = false) {
  const head = `<div class="k">${esc(CATS[s.cat] || s.cat)} · ${SEV_LABEL[s.sev] || esc(s.sev)}</div>`;
  if (compact) return `<div class="card ${esc(s.sev)}">${head}<b><span class="num">${esc(s.n ?? '')}</span> ${esc(s.title)}</b><details><summary>Warum?</summary><p>${esc(s.text)}</p><div class="foot">${esc(s.foot)}</div></details></div>`;
  return `<div class="card ${esc(s.sev)}">${head}<b>${esc(s.title)}</b><p>${esc(s.text)}</p><div class="foot">${esc(s.foot)}</div></div>`;
}
function renderSignals() {
  const all = computeSignals();
  const counts = {}; for (const s of all) counts[s.cat] = (counts[s.cat] || 0) + 1;
  $('#sig-filter').innerHTML = Object.entries(CATS).map(([k, l]) => `<button class="chip ${sigFilter === k ? 'on' : ''}" aria-pressed="${sigFilter === k}" data-cat="${k}">${l} <span class="mono">${k === 'all' ? all.length : counts[k] || 0}</span></button>`).join('');
  const list = (sigFilter === 'all' ? all : all.filter(s => s.cat === sigFilter)).slice(0, 60);
  $('#signals').innerHTML = list.length ? list.map(s => sigCard(s)).join('') : `<div class="empty" style="grid-column:1/-1"><b>Keine Signale im gewählten Filter.</b>${sigFilter !== 'all' ? 'Kategorie „Alle“ wählen.' : 'Im Gebiet ist derzeit nichts auffällig.'}</div>`;
  renderStability();
}
async function renderStability() {
  const day = state.histDay || state.histIndex?.days?.slice(-1)[0];
  const tb = $('#tbl-stability tbody');
  if (!day) { tb.innerHTML = emptyRow(7, 'Noch kein Verlauf.', 'Er beginnt mit dem ersten Sammler-Lauf.'); return; }
  const h = await loadHistory(day); if (!h) { tb.innerHTML = emptyRow(7, 'Verlauf nicht ladbar.', `${failedText(`history/${day}.json`)} – Seite später neu laden.`); return; }
  const byOp = new Map();
  for (const [k, ser] of Object.entries(h.series)) { const [ags, op, ty] = k.split('|'); if (state.scope === 'DE' ? ags !== 'DE' : ags !== state.scope) continue; if (state.operator !== 'all' && op !== state.operator) continue; if (state.type !== 'all' && ty !== state.type) continue; const name = state.scope === 'DE' ? (TYPE[ty] || ty) : op; const arr = byOp.get(name) || new Array(h.t.length).fill(null); alignSeries(ser.available, h.t.length).forEach((v, i) => { if (v != null) arr[i] = (arr[i] || 0) + v; }); byOp.set(name, arr); }
  tb.innerHTML = [...byOp].map(([name, arr]) => { const v = arr.filter(x => x != null); if (!v.length) return ''; const min = Math.min(...v), max = Math.max(...v), last = v[v.length - 1], first = v[0]; const d = last - first; const drop = max && (max - last) / max; return `<tr><td>${esc(name)}</td><td class="n">${v.length}</td><td class="n">${fmt(min)}</td><td class="n">${fmt(max)}</td><td class="n">${fmt(last)}</td><td class="n">${d > 0 ? '+' : ''}${fmt(d)}</td><td class="small">${drop >= 0.3 ? `<span class="pill stale">${pctf(max - last, max)} unter Tagesmaximum</span>` : v.length < 3 ? '<span class="muted">zu wenige Punkte</span>' : '<span class="muted">stabil</span>'}</td></tr>`; }).join('') || emptyRow(7, 'Keine Punkte im Filter.', 'Anbieter oder Fahrzeugart auf „Alle“ stellen.');
}

// ---------- Abdeckung ----------
function renderCoverage() {
  const munis = state.latest?.municipalities || {}; const q = ($('#cov-search').value || '').toLowerCase(); const dir = $('#cov-dir').value;
  const recs = state.latest?.sources || [];
  const rows = [];
  for (const [ags, m] of Object.entries(munis)) {
    for (const [op, o] of Object.entries(m.operators || {})) {
      const srcs = recs.filter(r => r.operator === op && (r.municipalities || []).includes(ags));
      const dirs = [...new Set(srcs.flatMap(r => r.directories || []))];
      if (dir !== 'all' && !dirs.includes(dir)) continue;
      if (q && !`${m.name} ${op} ${m.state}`.toLowerCase().includes(q)) continue;
      const status = srcs.some(r => r.status === 'live') ? 'live' : srcs.some(r => r.status === 'delayed') ? 'delayed' : srcs[0]?.status || 'unknown';
      rows.push({ ags, m, op, o, srcs, dirs, status });
    }
  }
  rows.sort((a, b) => a.m.name.localeCompare(b.m.name, 'de') || a.op.localeCompare(b.op));
  const opsAll = new Set(rows.map(r => r.op)), places = new Set(rows.map(r => r.ags));
  $('#cov-tiles').innerHTML = [tile('Anbieter vor Ort', fmt(rows.length), cl('Anbieter × Gemeinde mit bestätigter Zuordnung', 'Anbieter je Gemeinde')), tile(cl('Anbietergruppen', 'Anbieter'), fmt(opsAll.size), cl('über alle Quellen', 'deutschlandweit')), tile('Gemeinden', fmt(places.size), 'mit verfügbarem Angebot'), isClient() ? '' : tile('Ohne Zuordnung', fmt(recs.filter(r => ['foreign', 'empty'].includes(r.status)).length), 'Quellen außerhalb DE oder ohne Bestand')].join('');
  $('#cov-sub').textContent = `${fmt(rows.length)} Zeilen · ${cl('Sammler-Stand', 'Stand')} ${timeText(state.latest?.at)}`;
  const { show, rest } = pageRows('cov', rows, `${q}|${dir}|${state.latest?.at}`);
  $('#tbl-cov tbody').innerHTML = show.map(r => `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line">${Object.entries(r.o.types || {}).filter(([, n]) => n).map(([t, n]) => `${esc(TYPE[t] || t)} ${fmt(n)}`).join(' · ')}</div></td><td>${esc(r.m.name)} <span class="muted">${esc(r.m.state)}</span></td><td class="n">${fmt(r.o.total)}</td><td class="n">${fmt(r.o.available)}</td><td class="small internal">${r.dirs.map(dirLabel).join(' · ')}<div class="sub-line">${r.srcs.length} Quelle${r.srcs.length === 1 ? '' : 'n'}</div></td><td>${pillStatus(r.status)}</td><td><a href="#live" class="pick-muni" data-ags="${esc(r.ags)}">Ort öffnen ↗</a></td></tr>`).join('') || emptyRow(7, 'Keine Treffer.', q || dir !== 'all' ? 'Suche leeren oder „Alle Verzeichnisse“ wählen.' : state.latest ? 'Keine Anbieter im Sammler-Stand.' : failedText('latest.json'));
  $('#cov-more').innerHTML = moreBtn('cov', rest, ' – oder Suche eingrenzen');
  $('#gaps').innerHTML = (state.latest?.gaps || []).map(g => `<div class="card info"><div class="k">Datenlücke</div><b>${esc(g.operator)} · ${esc(g.city)}</b><p>${esc(g.note)}</p><div class="foot">seit ${esc(g.since)} · zuletzt geprüft ${timeText(g.checkedAt)} · Feed ${g.probeOk ? 'erreichbar' : `nicht erreichbar (${esc(g.probeStatus ?? '–')})`}</div></div>`).join('') || '<div class="empty"><b>Keine bekannten Lücken.</b>Alle bekannten Betreiber liefern offene Daten.</div>';
}
// Lange Tabellen: erst 100 Zeilen, je Klick 100 weitere; neuer Filter (Schlüssel) setzt auf 100 zurück
const MORE = {};
function pageRows(key, rows, filterKey) {
  const m = MORE[key]?.f === filterKey ? MORE[key] : (MORE[key] = { f: filterKey, n: 100 });
  return { show: rows.slice(0, m.n), rest: Math.max(0, rows.length - m.n) };
}
const moreBtn = (key, rest, hint = '') => rest ? `<button class="more-rows" data-more="${esc(key)}">${fmt(Math.min(100, rest))} weitere zeigen</button> <span class="muted">${fmt(rest)} nicht gezeigt${esc(hint)}</span>` : '';
const MORE_RENDER = { cov: () => renderCoverage(), src: () => renderSourceTable() };

// ---------- Quellen ----------
function renderSources() {
  const recs = state.latest?.sources || []; const cat = state.catalog;
  const by = {}; for (const r of recs) by[r.status] = (by[r.status] || 0) + 1;
  $('#src-tiles').innerHTML = [tile('Quellen geprüft', fmt(recs.length), `Katalog ${cat?.count ?? '–'} Einträge · ${state.latest ? new Date(state.latest.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–'}`), tile('Aktuell', fmt(by.live || 0), `${fmt(by.delayed || 0)} verzögert · ${fmt(by.stale || 0)} veraltet`, (by.live || 0) / Math.max(1, recs.length) < 0.6 ? 'warn' : 'ok'), tile('Nicht nutzbar', fmt((by.gone || 0) + (by.error || 0) + (by.auth || 0) + (by.empty || 0) + (by.unknown || 0)), `${fmt(by.gone || 0)} weg · ${fmt(by.error || 0)} Fehler · ${fmt(by.unknown || 0)} Zeit unklar · ${fmt(by.empty || 0)} leer${by.duplicate || by.retired ? ` · nicht gezählt: ${fmt(by.duplicate || 0)} Dubletten, ${fmt(by.retired || 0)} länger weg` : ''}`), tile('Dubletten bereinigt', fmt(state.latest?.dedupe?.duplicates), `${fmt(state.latest?.dedupe?.stationDuplicates)} Stationsdubletten · ${fmt(state.latest?.dedupe?.reusedIds)} Kennungen wiederverwendet`)].join('');
  const dirCount = {}; for (const r of recs) for (const d of r.directories || []) dirCount[d] = (dirCount[d] || 0) + 1;
  const dirInfo = {
    mobilitydata: ['angebunden', 'Alle als Deutschland gelisteten Systeme des GBFS-Katalogs (Bike, Lastenrad, E-Scooter). Carsharing wird ausgeschlossen, Erreichbarkeit je Lauf geprüft.', 'https://github.com/MobilityData/gbfs/blob/master/systems.csv'],
    mobidata_bw: ['angebunden · bevorzugt', 'Landesfeeds Baden-Württemberg; bei gleichem System vor dem Betreiberfeed verwendet. Die Kartenebene der offiziellen MobiData-Karte ist als Zusatzebene im Live-Modus verfügbar.', 'https://mobidata-bw.de/sk/dataset/bikesh'],
    mobidrom_nrw: ['angebunden · Dienstzugang', 'Konflationierte Landesfeeds NRW (E-Scooter, Bikesharing, Lastenräder). Der allgemeine OAuth-Dienstzugang aus der Datensatzbeschreibung wird zur Laufzeit gelesen; Positionen kommen über Momentaufnahmen des Sammlers in die Karte.', 'https://www.mobilitaetsdaten.nrw/api/ckan/organization/angemeldet'],
    citybikes: ['angebunden · Ergänzung', 'Stationszähler ohne Fahrzeugliste; nur mit belastbarem Zeitstempel. Dubletten zu GBFS-Stationen werden über Name und Position zusammengeführt.', 'https://api.citybik.es/v2/networks'],
    dott_direct: ['Kandidaten geprüft', 'Direktfeeds gbfs.api.ridedott.com je Stadt; Kandidaten ohne Feed bleiben als „nicht erreichbar“ sichtbar, Tübingen als Datenlücke.', 'https://gbfs.api.ridedott.com/public/v2/stuttgart/gbfs.json'],
  };
  $('#dirs').innerHTML = Object.entries(dirInfo).map(([k, [st, txt, url]]) => `<div class="card ok"><div class="k">${esc(st)}</div><b>${esc(DIRS[k])}</b><p>${esc(txt)}</p><div class="foot">${fmt(dirCount[k] || 0)} Quellen · <a href="${url}" target="_blank" rel="noopener">Originalquelle ↗</a></div></div>`).join('') +
    `<div class="card info"><div class="k">Grundlage</div><b>Gemeindegrenzen · BKG</b><p>${esc(state.latest?.boundaries?.attribution || '© GeoBasis-DE / BKG, VG250')}, Lizenz dl-de/by-2-0. GPS entscheidet die Gemeinde; unklare Grenzfälle bleiben ohne Zuordnung.</p><div class="foot">${fmt(state.latest?.boundaries?.count)} Gemeinden · <a href="https://gdz.bkg.bund.de" target="_blank" rel="noopener">Originalquelle ↗</a></div></div>
     <div class="card warn"><div class="k">Nicht verwendet</div><b>DB API Marketplace · Voi Partner-API</b><p>Beide erfordern persönliche Zugangsdaten. Call-a-Bike-Daten kommen über MobiData BW und MOBIDROM NRW, Voi-Daten über beide Landesverzeichnisse.</p><div class="foot">kein Partnerzugang</div></div>`;
  loadOnce('reliability', 'reliability.json').then(() => renderSourceTable());
  renderConsistency(); renderMonitor().catch(e => console.error('Monitor', e)); renderQuality(); renderLicenses();
  $('#method').innerHTML = METHOD;
}
// ---------- Datenvertrauen: Sammler-Monitor, Datenqualität, Lizenzen ----------
const TRIGGER = { schedule: 'geplant', workflow_dispatch: 'manuell', lokal: 'lokal', push: 'Push' };
async function renderMonitor() {
  const box = $('#monitor'); const doc = await loadOnce('runs', 'runs.json');
  const F = doc?.fields || ['at', 'dauer_ms', 'quellen', 'aktuell', 'verzoegert', 'veraltet', 'fehler', 'fahrzeuge', 'stationen', 'fahrten', 'fahrtenden', 'kennungswechsel', 'ausloeser'];
  const ix = Object.fromEntries(F.map((f, i) => [f, i]));
  const runs = (doc?.runs || []).filter(r => Number.isFinite(r[ix.at])).sort((a, b) => a[ix.at] - b[ix.at]);
  if (!runs.length) { box.innerHTML = '<div class="empty"><b>Monitor startet mit dem nächsten Sammler-Lauf.</b>Danach stehen hier Laufzeiten, Lücken und Auslöser der letzten 7 Tage.</div>'; return; }
  const share = (r) => r[ix.quellen] ? (r[ix.aktuell] || 0) / r[ix.quellen] : null;
  const shares = runs.map(share).filter(x => x != null).sort((a, b) => a - b);
  const med = shares.length ? shares[Math.floor(shares.length / 2)] : null;
  const lvl = (v) => v == null || med == null ? 'warn' : v >= med - 0.05 ? 'ok' : v >= med - 0.15 ? 'warn' : 'bad';
  const GAP = 45 * 60e3, now = Date.now(), last = runs[runs.length - 1];
  const gaps = []; for (let i = 1; i < runs.length; i++) { const a = runs[i - 1][ix.at], b = runs[i][ix.at]; if (b - a > GAP) gaps.push([a, b, false]); }
  if (!DEMO && now - last[ix.at] > GAP && now - last[ix.at] < 7 * 86400e3) gaps.push([last[ix.at], now, true]);
  const t0 = runs[0][ix.at], t1 = Math.max(gaps.some(g => g[2]) ? now : last[ix.at], t0 + 3600e3);
  const W = 900, H = 150, P = { l: 40, r: 12, t: 14, b: 24 };
  const lo = Math.max(0, Math.floor(((shares[0] ?? 0) - 0.05) * 10) / 10), hi = Math.min(1, Math.ceil(((shares[shares.length - 1] ?? 1) + 0.02) * 10) / 10) || 1;
  const x = (t) => P.l + ((t - t0) / (t1 - t0)) * (W - P.l - P.r), y = (v) => P.t + (1 - ((v ?? lo) - lo) / Math.max(0.05, hi - lo)) * (H - P.t - P.b);
  const dt = (t) => new Date(t).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  let g = '';
  for (const v of [lo, (lo + hi) / 2, hi]) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${P.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v * 100)} %</text>`;
  const span = t1 - t0;
  if (span > 30 * 3600e3) { const d = new Date(t0); d.setHours(24, 0, 0, 0); for (let t = +d; t < t1; t += 86400e3) g += `<line class="grid" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${P.t}" y2="${H - P.b}"/><text x="${(x(t) + 4).toFixed(1)}" y="${H - 8}">${new Date(t).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}</text>`; }
  else { const step = span > 12 * 3600e3 ? 6 : span > 4 * 3600e3 ? 2 : 1; for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t < t1; t += 3600e3) { if (hourOf(t) % step) continue; g += `<text x="${x(t).toFixed(1)}" y="${H - 8}" text-anchor="middle">${timeText(t)}</text>`; } }
  for (const [a, b, open] of gaps) { const w = Math.max(2, x(b) - x(a)); g += `<rect class="mon-gap" x="${x(a).toFixed(1)}" y="${P.t}" width="${w.toFixed(1)}" height="${H - P.t - P.b}"><title>Lücke: ${dt(a)} bis ${open ? 'jetzt' : dt(b)} (${durText(b - a)} ohne Lauf)</title></rect>${w > 34 ? `<text class="mon-gap-t" x="${(x(a) + w / 2).toFixed(1)}" y="${P.t + 10}" text-anchor="middle">Lücke</text>` : ''}`; }
  // Linie zwischen Läufen, an Lücken unterbrochen
  let d = ''; runs.forEach((r, i) => { const v = share(r); if (v == null) return; const brk = i === 0 || r[ix.at] - runs[i - 1][ix.at] > GAP; d += `${brk ? 'M' : 'L'}${x(r[ix.at]).toFixed(1)} ${y(v).toFixed(1)} `; });
  g += `<path class="mon-line" d="${d}"/>`;
  g += runs.map(r => { const v = share(r); return `<circle class="mon-pt ${lvl(v)}" cx="${x(r[ix.at]).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${runs.length > 300 ? 2 : 3}"><title>${dt(r[ix.at])} · ${esc(TRIGGER[r[ix.ausloeser]] || r[ix.ausloeser] || '–')}\n${fmt(r[ix.aktuell])} von ${fmt(r[ix.quellen])} Quellen aktuell (${v == null ? '–' : fmt(v * 100) + ' %'}) · ${fmt(r[ix.fehler])} Fehler\n${fmt(r[ix.fahrzeuge])} Fahrzeuge · ${fmt(r[ix.fahrten])} Fahrten · Dauer ${r[ix.dauer_ms] == null ? '–' : fmt(r[ix.dauer_ms] / 1000, 1) + ' s'}</title></circle>`; }).join('');
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const today = runs.filter(r => r[ix.at] >= +midnight).length;
  const trig = {}; for (const r of runs) { const k = r[ix.ausloeser] || 'unbekannt'; trig[k] = (trig[k] || 0) + 1; }
  const closed = gaps.filter(gp => !gp[2]); const longest = closed.length ? Math.max(...closed.map(([a, b]) => b - a)) : 0;
  const lastAge = now - last[ix.at];
  box.innerHTML = `<div class="mon-stats">
    <div>Letzter Lauf<b style="color:var(--${!DEMO && lastAge > GAP ? 'warn' : 'fg'})">${timeText(last[ix.at])}</b>${DEMO ? new Date(last[ix.at]).toLocaleDateString('de-DE') : `vor ${ageText(lastAge)}`} · ${last[ix.dauer_ms] == null ? '' : `${fmt(last[ix.dauer_ms] / 1000, 1)} s · `}${fmt(last[ix.aktuell])} von ${fmt(last[ix.quellen])} Quellen aktuell</div>
    <div>Läufe heute<b>${fmt(today)}</b>${fmt(runs.length)} in ${fmt(Math.max(1, Math.round((last[ix.at] - t0) / 86400e3)))} Tag${Math.round((last[ix.at] - t0) / 86400e3) > 1 ? 'en' : ''} · Plan alle 20 Min.</div>
    <div>Auslöser<b>${fmt(trig.schedule || 0)} · ${fmt(trig.workflow_dispatch || 0)}</b>geplant (schedule) · manuell (workflow_dispatch)${Object.keys(trig).filter(k => !['schedule', 'workflow_dispatch'].includes(k)).map(k => ` · ${fmt(trig[k])} ${esc(TRIGGER[k] || k)}`).join('')}</div>
    <div>Lücken über 45 Min.<b style="color:var(--${gaps.length ? 'warn' : 'fg'})">${fmt(gaps.length)}</b>${gaps.length ? `längste ${durText(Math.max(longest, ...gaps.filter(gp => gp[2]).map(([a, b]) => b - a)))}${gaps.some(gp => gp[2]) ? ' · seit dem letzten Lauf offen' : ''}` : 'Sammler lief lückenlos'}</div>
  </div>
  <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sammler-Läufe der letzten 7 Tage">${g}</svg>
  <div class="legend"><span><i class="dot" style="background:var(--ok)"></i>üblicher Anteil aktueller Quellen (Median ${med == null ? '–' : fmt(med * 100) + ' %'})</span><span><i class="dot" style="background:var(--warn)"></i>5–15 Punkte darunter</span><span><i class="dot" style="background:var(--bad)"></i>mehr als 15 Punkte darunter</span><span><i class="sq" style="background:color-mix(in srgb,var(--bad) 14%,transparent);border-color:transparent"></i>Lücke über 45 Min. ohne Lauf</span></div>`;
}
function renderQuality() {
  const L0 = state.latest; const box = $('#quality');
  if (!L0) { box.innerHTML = '<div class="empty"><b>Noch kein Sammler-Stand.</b>Die Bereinigung erscheint nach dem ersten Lauf.</div>'; return; }
  const d = L0.dedupe || {}; const recs = L0.sources || [];
  const tot = { unassigned: 0, outside: 0, missing: 0, repaired: 0, stationFallback: 0, ghosts: 0 };
  for (const r of recs) for (const k in tot) tot[k] += r.counts?.[k] || 0;
  const worst = recs.map(r => ({ r, n: (r.counts?.unassigned || 0) + (r.counts?.outside || 0) + (r.counts?.missing || 0) + (r.counts?.ghosts || 0) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 8);
  box.innerHTML = `<dl class="kv">
    <dt>Fahrzeug-Dubletten entfernt<small>gleiches Fahrzeug in mehreren Quellen${d.prefixVariants ? `, davon ${fmt(d.prefixVariants)} nur mit anderem Kennungs-Präfix` : ''}</small></dt><dd>${fmt(d.duplicates)}</dd>
    <dt>Stations-Dubletten<small>gleiche Kennung oder gleicher Name ≤ 60 m</small></dt><dd>${fmt(d.stationDuplicates)}</dd>
    <dt>Kennungen wiederverwendet<small>gleiche Kennung an weit entfernten Orten, als Prüffall behalten</small></dt><dd>${fmt(d.reusedIds)}</dd>
    <dt>Ohne Gemeinde<small>Position in Deutschland, aber keiner Gemeinde zuordenbar</small></dt><dd>${fmt(tot.unassigned)}</dd>
    <dt>Außerhalb Deutschlands</dt><dd>${fmt(tot.outside)}</dd>
    <dt>Ohne Koordinaten<small>${tot.stationFallback ? `${fmt(tot.stationFallback)} über Stationsposition ersetzt` : 'ohne Ersatzposition'}</small></dt><dd>${fmt(tot.missing)}</dd>
    ${tot.ghosts ? `<dt>Verwaiste Einträge<small>gesperrt und seit über 7 Tagen ohne Signal (z. B. eingelagert, verloren); nicht im Bestand und nicht als gesperrt gezählt</small></dt><dd>${fmt(tot.ghosts)}</dd>` : ''}
    ${tot.repaired ? `<dt>Koordinaten repariert<small>vertauschte Breite/Länge, Zahlenformat</small></dt><dd>${fmt(tot.repaired)}</dd>` : ''}
  </dl>${worst.length ? `<div class="tbl" tabindex="0" role="region" aria-label="Quellen mit den meisten Ausschlüssen" style="margin-top:var(--s3)"><table><thead><tr><th>Quelle</th><th class="n">ohne Gemeinde</th><th class="n">außerhalb</th><th class="n">ohne Koord.</th><th class="n" title="gesperrt und über 7 Tage ohne Signal, nicht im Bestand">verwaist</th></tr></thead><tbody>${worst.map(({ r }) => `<tr><td>${esc(r.name || r.id)}<div class="sub-line mono">${esc(r.id)}</div></td><td class="n">${fmt(r.counts?.unassigned || 0)}</td><td class="n">${fmt(r.counts?.outside || 0)}</td><td class="n">${fmt(r.counts?.missing || 0)}</td><td class="n">${fmt(r.counts?.ghosts || 0)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
function renderLicenses() {
  const box = $('#licenses'); const recs = (state.latest?.sources || []).filter(r => !(r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status)));
  if (!recs.length) { box.innerHTML = '<div class="empty"><b>Noch keine Quellen.</b>Die Übersicht erscheint nach dem ersten Sammler-Lauf.</div>'; return; }
  // Lizenz-Kennung (licenseId, z. B. CC0-1.0) vor URL; die URL bleibt Link
  const by = new Map(); for (const r of recs) { const k = r.licenseId || r.license || r.licenseUrl || ''; const e = by.get(k) || { n: 0, ops: new Set(), url: r.licenseUrl || (/^https?:/i.test(r.license || '') ? r.license : null) }; e.n++; e.ops.add(r.operator); by.set(k, e); }
  const rows = [...by].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  const label = (l, url) => !l ? '<span class="muted">k. A.</span>' : /^https?:\/\//i.test(l) ? link(l, `${esc(String(l).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''))} ↗`) : url ? link(url, `${esc(l)} ↗`) : esc(l);
  box.innerHTML = `<div class="tbl" tabindex="0" role="region" aria-label="Lizenzen"><table><thead><tr><th>Lizenz</th><th class="n">Quellen</th><th>Anbieter</th></tr></thead><tbody>${rows.slice(0, 20).map(([l, e]) => `<tr><td>${label(l, e.url)}</td><td class="n">${fmt(e.n)}</td><td class="small">${esc([...e.ops].sort((a, b) => a.localeCompare(b, 'de')).slice(0, 5).join(', '))}${e.ops.size > 5 ? ` +${e.ops.size - 5}` : ''}</td></tr>`).join('')}</tbody></table></div><div class="muted small" style="margin-top:var(--s2)">Kommerzielle Nutzung je Lizenz prüfen. „k. A.“ heißt: Der Feed nennt keine Lizenz.${rows.length > 20 ? ` ${rows.length - 20} weitere Lizenzangaben.` : ''}</div>`;
}
function relCell(id) { const r = state.usage?.reliability?.sources?.[id]; if (!r || !r.runs) return '<span class="muted">–</span>'; const ok = (r.live + r.delayed) / r.runs; return `<span style="color:var(--${ok >= 0.95 ? 'ok' : ok >= 0.8 ? 'warn' : 'bad'})">${pctf(r.live + r.delayed, r.runs)}</span><div class="sub-line">${r.runs} Läufe · Ø ${fmt(r.latencyAvg)} ms</div>`; }
function renderSourceTable() {
  const q = ($('#src-search').value || '').toLowerCase(); const stf = $('#src-status').value;
  const all = (state.latest?.sources || []).filter(r => (stf === 'all' || r.status === stf) && (!q || `${r.id} ${r.name} ${r.operator} ${r.url}`.toLowerCase().includes(q)));
  const hidden = all.filter(r => r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status) && !q);
  // Dubletten und länger verschwundene Quellen bilden eine eigene Gruppe am Ende (kein Fehler)
  const recs = all.filter(r => !hidden.includes(r)).sort((a, b) => (['duplicate', 'retired'].includes(a.status) ? 1 : 0) - (['duplicate', 'retired'].includes(b.status) ? 1 : 0));
  const munis = state.latest?.municipalities || {};
  const { show, rest } = pageRows('src', recs, `${q}|${stf}|${state.latest?.at}`);
  $('#tbl-src tbody').innerHTML = show.map(r => `<tr><td>${link(r.url, esc(r.name || r.id))}${r.attribution && r.attribution !== r.name ? `<div class="sub-line">${esc(r.attribution)}</div>` : ''}<div class="sub-line mono">${esc(r.id)}${r.sourceChanged ? ' · Quellenwechsel' : ''}</div></td><td>${esc(r.operator)}</td><td class="small">${(r.directories || []).map(dirLabel).join(' · ')}</td><td class="n">${esc(r.version || '–')}</td><td class="n">${fmt(r.counts?.vehicles)}<div class="sub-line">${[r.counts?.unassigned ? `${fmt(r.counts.unassigned)} o. Gemeinde` : '', r.counts?.outside ? `${fmt(r.counts.outside)} außerhalb` : '', r.counts?.missing ? `${fmt(r.counts.missing)} o. Koord.` : ''].filter(Boolean).join(' · ')}</div></td><td class="n">${fmt(r.counts?.stations)}</td><td class="n" title="${esc((r.municipalities || []).slice(0, 12).map(a => munis[a]?.name || a).join(', '))}">${fmt((r.municipalities || []).length)}</td><td class="n">${ageText(r.feedAgeMs)}</td><td class="n">${esc(r.quality ?? '–')}</td><td class="n">${relCell(r.id)}</td><td>${pillStatus(r.status)}${r.status === 'duplicate' && r.duplicateOf ? `<div class="sub-line">gleich wie ${esc(r.duplicateOf)}${r.duplicateShare != null ? ` (${pctf(r.duplicateShare, 1)})` : ''}</div>` : r.errorCause ? `<div class="sub-line">${esc(String(r.errorCause).slice(0, 60))}</div>` : r.errors?.length ? `<div class="sub-line">${esc(String(r.errors[0]).slice(0, 60))}</div>` : ''}</td><td class="small">${r.licenseId ? (r.licenseUrl ? link(r.licenseUrl, `${esc(r.licenseId)} ↗`) : esc(r.licenseId)) : r.license ? (/^https?:\/\//i.test(r.license) ? link(r.license, 'Lizenz ↗') : esc(r.license)) : '<span class="muted">k. A.</span>'}</td></tr>`).join('') || emptyRow(12, 'Keine Treffer.', q || stf !== 'all' ? 'Suche leeren oder „Alle Zustände“ wählen.' : state.latest ? 'Keine Quellen im Sammler-Stand.' : failedText('latest.json'));
  $('#src-more').innerHTML = [moreBtn('src', rest, ' – oder Suche eingrenzen'), hidden.length ? `${fmt(hidden.length)} geprüfte Direktfeed-Kandidaten ohne Daten ausgeblendet (Suche nach Anbieter zeigt sie).` : ''].filter(Boolean).join(' ');
}
// ---------- Nutzung & Bewegung ----------
state.usage = { index: null, day: null, docs: {}, cells: {}, idle: null, idleLong: null, quota: null, pricing: null, zonesIndex: null, zones: {}, reliability: null, consistency: null, weather: {} };
// Alle Lader über den Promise-Cache: parallele Aufrufer teilen sich einen Download, fehlende Dateien werden nicht je Aufruf neu angefragt
async function loadUsageIndex() { if (!state.usage.index) { const r = await cached('events/index.json', 25000); state.usage.index = r.json || { days: [], cellDays: [] }; } return state.usage.index; }
async function loadEvents(day) { if (!(day in state.usage.docs)) { const r = await cached(`events/${day}.json`, 60000); state.usage.docs[day] = r.json || null; } return state.usage.docs[day]; }
async function loadCells(day, st) { const k = `${day}/${st}`; if (!(k in state.usage.cells)) { const r = await cached(`cells/${day}/${st}.json`, 60000); state.usage.cells[k] = r.json || null; } return state.usage.cells[k]; }
async function loadOnce(name, file, timeout = 60000) { if (state.usage[name] === undefined || state.usage[name] === null) { const r = await cached(file, timeout); state.usage[name] = r.json || null; } return state.usage[name]; }
const scopeState = () => state.latest?.municipalities?.[state.scope]?.state || null;
const groupInScope = (k) => { const [ags, op, ty] = k.split('|'); if (ags === 'DE') return false; if (state.scope !== 'DE' && ags !== state.scope) return false; if (state.operator !== 'all' && op !== state.operator) return false; if (state.type !== 'all' && ty !== state.type) return false; return true; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const durText = (ms) => ms == null || !Number.isFinite(ms) ? '—' : ms < 3600e3 ? `${fmt(ms / 60e3)} Min.` : `${(ms / 3600e3).toFixed(1).replace('.', ',')} Std.`;

async function renderUsage() {
  const idx = await loadUsageIndex();
  const days = idx.days || [];
  const box = $('#usage-tiles');
  renderArchive().catch(() => {});
  if (!days.length) { box.innerHTML = ''; $('#usage-note').textContent = 'Noch keine Ereignisdaten – der Sammler braucht zwei Läufe, bevor Bewegungen erkennbar sind.'; $('#chart-usage').innerHTML = '<div class="empty"><b>Noch keine Bewegungen gemessen.</b>Sie erscheinen nach zwei Sammler-Läufen.</div>'; $('#tbl-usage tbody').innerHTML = '<tr><td colspan="6" class="empty"><b>Noch keine Daten.</b>Bewegungen erscheinen nach zwei Sammler-Läufen.</td></tr>'; $('#tbl-usage-more tbody').innerHTML = '<tr><td colspan="7" class="empty">Noch keine Daten.</td></tr>'; return; }
  const day = state.usage.day && days.includes(state.usage.day) ? state.usage.day : days[days.length - 1];
  state.usage.day = day;
  $('#usage-days').innerHTML = days.slice(-7).map(d => { const note = dayNote(d); return `<button class="chip ${d === day ? 'on' : ''}${note ? ' special' : ''}" aria-pressed="${d === day}" data-uday="${esc(d)}"${note ? ` title="${esc(note)}"` : ''}>${esc(d.slice(8))}.${esc(d.slice(5, 7))}.${note ? '<span aria-hidden="true"> ✱</span>' : ''}</button>`; }).join('');
  const doc = await loadEvents(day);
  if (!doc) {
    box.innerHTML = ''; $('#usage-note').textContent = `${failedText(`events/${day}.json`)} – anderen Tag wählen oder später neu laden.`;
    $('#chart-usage').innerHTML = '<div class="empty"><b>Ereignisdatei nicht ladbar.</b>Anderen Tag wählen.</div>';
    for (const [id, n] of [['#tbl-usage', 6], ['#tbl-usage-more', 7], ['#tbl-cells', 5], ['#tbl-econ', 6], ['#tbl-econ-more', 7]]) { const tb = $(`${id} tbody`); if (tb) tb.innerHTML = emptyRow(n, 'Keine Ereignisdaten für diesen Tag.', 'Anderen Tag wählen.'); }
    return;
  }
  const runs = doc.runs || [];
  // Messlücken: Stunden ohne Lauf oder mit Lauf nach > 45 Min. Pause zählen weder in Summen noch im Tagesgang (Vertrag 5, doc.gapHours)
  const mask = hourMask(runs, doc.gapHours);
  const observedMs = runs.filter(r => r[1] != null && !isGapRun(r) && mask.ok[hourOf(r[0])]).reduce((a, r) => a + Math.min(r[1], GAP_MS), 0);
  const gapH = mask.gap.filter(Boolean).length;
  const note = dayNote(day);
  $('#usage-note').innerHTML = `${note ? `<b>${esc(note)}</b> · ` : ''}${fmt(runs.length)} Sammler-Läufe am ${esc(day.split('-').reverse().join('.'))} (00–24 Uhr) · beobachtet ${durText(observedMs)} · ${timeText(runs[0]?.[0])}–${timeText(runs[runs.length - 1]?.[0])} Uhr${gapH ? ` · ${abbr(`${gapH} Std. nach Messlücke`, 'gap')} nicht gezählt` : ''}`;
  // Gruppen im Scope aggregieren
  const byOp = new Map(); const tot = T_empty();
  for (const [k, g] of Object.entries(doc.groups || {})) {
    if (!groupInScope(k)) continue;
    const [, op, ty] = k.split('|'); const name = state.scope === 'DE' && state.operator === 'all' ? (TYPE[ty] || ty) : op;
    const a = byOp.get(name) || T_empty(); T_add(a, g, mask.ok); byOp.set(name, a); T_add(tot, g, mask.ok);
  }
  // Eine Fahrten-Definition: gemessene Fahrtbeginne im Beobachtungszeitraum (Hochrechnung und RVD stehen unter Umsatz & Kennzahlen)
  const starts = sum(tot.start), ends = sum(tot.end), reloc = sum(tot.reloc), swaps = sum(tot.swap), pickups = sum(tot.pickup);
  box.innerHTML = [
    tile('Fahrten gemessen', fmt(starts), `in ${durText(observedMs)} Beobachtung · ${fmt(ends)} Fahrtenden${gapH ? ` · ohne ${gapH} Std. nach Messlücke` : ''}`),
    tile(abbr('Umsetzungen', 'reloc'), fmt(reloc), 'gleiche Kennung, > 150 m versetzt, nicht verschwunden'),
    tile('Akkutausch', fmt(swaps), tot.swapWaitN ? `Ø ${durText(tot.swapWaitSum / tot.swapWaitN)} unter 20 % bis zum Tausch` : 'Sprung von < 40 % auf ≥ 85 % am selben Ort'),
    tile(abbr('Abholungen', 'pickup'), fmt(pickups), 'gesperrte oder fast leere Fahrzeuge verschwunden'),
    tile('Sperrdauer', tot.disDurN ? durText(tot.disDurSum / tot.disDurN) : '—', `${fmt(sum(tot.disOff))} Fahrzeuge wieder freigegeben`),
  ].join('');
  // Tagesgang: eigene Filter im Panel (Vorgabe aus den globalen Filtern); Änderung zeichnet nur das Diagramm neu
  let weather = null;
  if ($('#chk-weather').checked) weather = await loadWeather(day);
  state.usage.chartData = { doc, weather, runs, mask };
  usageChartOptions(doc); renderUsageChart();
  // Standzeiten
  const idle = await loadOnce('idle', 'idle.json');
  const ib = [0, 0, 0, 0, 0]; let in_ = 0;
  for (const [k, a] of Object.entries(idle?.groups || {})) { if (!groupInScope(k)) continue; for (let i = 0; i < 5; i++) ib[i] += a[i]; in_ += a[5]; }
  const labels = idle?.buckets || ['<2 h', '2–8 h', '8–24 h', '1–2 Tage', '>2 Tage'];
  const imax = Math.max(1, ...ib);
  $('#idle-bars').innerHTML = in_ ? labels.map((l, i) => `<div class="hbar"><span>${esc(l)}</span><div class="bar"><i style="width:${(ib[i] / imax) * 100}%;background:${i >= 3 ? 'var(--warn)' : 'var(--accent)'}"></i></div><span class="n mono">${pctf(ib[i], in_)}</span></div>`).join('') + `<div class="muted small" style="margin-top:6px">${fmt(in_)} verfügbare Fahrzeuge · Stand ${timeText(idle.at)} · Zeit seit letzter Bewegung, höchstens seit erstem Sammler-Kontakt (${esc(days[0].split('-').reverse().join('.'))})</div>` : '<div class="empty"><b>Keine Standzeiten im Filter.</b>Anbieter oder Fahrzeugart auf „Alle“ stellen.</div>';
  // Tabelle je Anbieter: sechs Standardspalten, der Rest unter „Weitere Spalten“
  const list = [...byOp].sort((a, b) => sum(b[1].start) - sum(a[1].start));
  const opCell = (name) => `<td><span class="op"><i style="background:${opColor(name)}"></i>${esc(name)}</span></td>`;
  $('#tbl-usage tbody').innerHTML = list.map(([name, a]) => `<tr>${opCell(name)}<td class="n">${fmt(sum(a.start))}</td><td class="n">${fmt(sum(a.end))}</td><td class="n">${fmt(sum(a.reloc))}</td><td class="n">${fmt(sum(a.swap))}</td><td class="n">${fmt(sum(a.pickup))}</td></tr>`).join('') || '<tr><td colspan="6" class="empty"><b>Keine Ereignisse im Filter.</b>Anbieter oder Fahrzeugart auf „Alle“ stellen oder anderen Tag wählen.</td></tr>';
  $('#tbl-usage-more tbody').innerHTML = list.map(([name, a]) => { const modes = Object.entries(doc.srcModes || {}).filter(([id]) => (state.latest?.sources || []).some(r => r.id === id && r.operator === name && (state.scope === 'DE' || (r.municipalities || []).includes(state.scope)))).map(([, m]) => m); const mode = modes.includes('stable') ? 'stabil' : modes.includes('rotating') ? 'rotierend' : 'offen';
    return `<tr>${opCell(name)}<td class="n">${a.tripDurN ? durText(a.tripDurSum / a.tripDurN) : '—'}</td><td class="n">${a.tripDistN ? `${fmt(a.tripDistSum / a.tripDistN / 1000, 1)} km` : '—'}</td><td class="n">${a.swapWaitN ? durText(a.swapWaitSum / a.swapWaitN) : '—'}</td><td class="n">${fmt(sum(a.disOff))}</td><td class="n">${a.disDurN ? durText(a.disDurSum / a.disDurN) : '—'}</td><td class="small">${mode}<div class="sub-line">${mode === 'stabil' ? 'Dauer/Distanz messbar' : mode === 'rotierend' ? 'nur Start/Ziel-Zählung' : 'noch zu wenige Läufe'}</div></td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">Keine Ereignisse im Filter.</td></tr>';
  renderCellsTable(day); renderQuota(); if (!isClient()) { renderEcon(day, doc).catch(e => console.error('Umsatz', e)); renderCalibPanel().catch(e => console.error('Kalibrierung', e)); }
}
// Tagesgang-Filter: Anbieter und Arten mit Ereignissen im Gebiet am Tag; eigene Wahl bleibt, bis sich oben Gebiet, Anbieter oder Art ändern
const inArea = (ags) => ags !== 'DE' && (state.scope === 'DE' || ags === state.scope);
function usageChartOptions(doc) {
  const key = `${state.scope}|${state.operator}|${state.type}`;
  if (state.usage.chartSel?.key !== key) state.usage.chartSel = { key, op: state.operator, type: state.type };
  const s = state.usage.chartSel, ops = new Set(), types = new Set();
  for (const [k, g] of Object.entries(doc.groups || {})) {
    const [ags, op, ty] = k.split('|');
    if (!inArea(ags) || !['start', 'end', 'reloc', 'swap', 'pickup'].some(f => sum(g[f] || []) > 0)) continue;
    ops.add(op); types.add(ty);
  }
  if (s.op !== 'all') ops.add(s.op); if (s.type !== 'all') types.add(s.type);
  const order = Object.keys(TYPE), rank = (t) => order.includes(t) ? order.indexOf(t) : 99;
  $('#usage-op').innerHTML = '<option value="all">Alle</option>' + [...ops].sort((a, b) => a.localeCompare(b, 'de')).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  $('#usage-type').innerHTML = '<option value="all">Alle</option>' + [...types].sort((a, b) => rank(a) - rank(b)).map(t => `<option value="${esc(t)}">${esc(TYPE[t] || t)}</option>`).join('');
  $('#usage-op').value = s.op; $('#usage-type').value = s.type;
}
// Ein Anbieter gewählt: eine Linie je Fahrzeugart; sonst eine Linie je Anbieter (gefiltert nach Art, Top 8)
function renderUsageChart() {
  const c = state.usage.chartData, s = state.usage.chartSel; if (!c || !s) return;
  const { op, type } = s, perType = op !== 'all';
  const by = new Map();
  for (const [k, g] of Object.entries(c.doc.groups || {})) {
    const [ags, o, ty] = k.split('|');
    if (!inArea(ags) || (perType && o !== op) || (type !== 'all' && ty !== type)) continue;
    const name = perType ? ty : o; const a = by.get(name) || new Array(24).fill(0);
    for (let h = 0; h < 24; h++) a[h] += g.start?.[h] || 0;
    by.set(name, a);
  }
  const order = Object.keys(TYPE), ok = c.mask?.ok || new Array(24).fill(true);
  // nicht gemessene Stunden und Stunden nach Messlücke: null (Linie unterbrochen), nicht 0
  const all = [...by].map(([name, raw]) => { const values = raw.map((v, h) => ok[h] ? v : null); return perType ? { name: TYPE[name] || name, values, color: palette(Math.max(0, order.indexOf(name))) } : { name, values, color: opColor(name) }; }).sort((x, y) => sum(y.values) - sum(x.values));
  const series = all.slice(0, 8), tyLabel = TYPE[type] || type;
  $('#chart-usage').innerHTML = series.length ? hourChart(series, c.weather, c.runs, c.mask, dayNote(state.usage.day)) : '<div class="empty"><b>Keine Fahrtbeginne für diese Auswahl.</b>Anbieter oder Fahrzeugart im Tagesgang auf „Alle“ stellen.</div>';
  $('#usage-chart-sub').textContent = (perType ? `Fahrtbeginne je Stunde · ${op} nach Fahrzeugart${type !== 'all' ? ` (nur ${tyLabel})` : ''}` : `Fahrtbeginne je Stunde und Anbieter${type !== 'all' ? ` · ${tyLabel}` : ''}${all.length > 8 ? ` · Top 8 von ${all.length}` : ''}`) + (c.weather ? ` · Wetter ${c.weather.name}` : '');
  $('#usage-legend').innerHTML = series.map((x, i) => `<span><i class="dot" style="background:${x.color || palette(i)}"></i>${esc(x.name)} <span class="mono">${fmt(sum(x.values))}</span></span>`).join('') + (c.weather && series.length ? `<span><i class="sq rain-key"></i>Niederschlag (Balken) · Temperatur °C im Wetterband</span>` : '') +(series.length && ok.some(v => !v) ? `<span><i class="sq gap-key"></i>${abbr('nicht gemessen / nach Messlücke', 'gap')}</span>` : '');
}
// ---------- Umsatz & Kennzahlen ----------
function econOpts() {
  const m = +$('#econ-min')?.value;
  return { rideMin: Number.isFinite(m) && m > 0 ? m : null, realization: Math.min(1, Math.max(0.1, (+$('#econ-real')?.value || 85) / 100)), net: $('#econ-net') ? $('#econ-net').checked : true };
}
async function econProfile() {
  if (state.usage.profile) return state.usage.profile;
  const idx = await loadUsageIndex(); const days = (idx.days || []).slice(-8, -1); // abgeschlossene Tage
  state.usage.profile = E.hourProfile(await Promise.all(days.map(loadEvents)));
  return state.usage.profile;
}
// Kennzahlen je Gruppe (Gemeinde|Anbieter|Art) eines Tages; Ergebnis je Schlüssel.
// Je Gruppe: m = gemessen (Ø Fahrt aus der Kalibrierung: E-Scooter Berliner Quartalswerte, sonst Annahme), cal = × Faktor (pulse-calib factorFor:
// eigene Korrektur übersteuert, sonst k für E-Scooter), lo/hi = Spanne des Faktors; die Gruppe selbst trägt die Werte des gewählten Modus.
async function econGroups(day, keep) {
  const [doc, pricing, hist, prof, calib] = await Promise.all([loadEvents(day), loadOnce('pricing', 'pricing.json'), loadHistory(day), econProfile(), getCalib()]);
  if (!doc) return null;
  // Fahrzeugminuten nur nutzen, wenn alle Läufe des Tages sie gezählt haben (Umstellungstag: Ø Bestand aus dem Verlauf)
  // Stunden ohne Messung oder mit Lücken-Lauf (> 45 Min. Pause, Flag 0) fallen aus Beobachtungszeit, Fahrten und Fahrzeugminuten: keine Hochrechnung aus Lücken
  const runs = doc.runs || [], mask = hourMask(runs, doc.gapHours);
  // Fahrzeugminuten gelten, wenn jeder Lauf ein Flag trägt (1 = zählt, 0 = Lücke); ältere Tage ohne Flag: Ø Bestand aus dem Verlauf
  const vminOk = runs.every(r => r[1] == null || r[2] === 1 || r[2] === 0 || isGapRun(r));
  const obsMin = E.observedMinutes(runs).map((m, h) => mask.ok[h] ? m : 0), obsMinV = vminOk ? obsMin : new Array(24).fill(0); const o = econOpts();
  const maskG = (g) => { const out = { ...g }; for (const f of ['start', 'end', 'rot', 'vmin', 'vminTot']) if (Array.isArray(g[f])) out[f] = g[f].map((v, h) => mask.ok[h] ? (v || 0) : 0); return out; };
  const assume = calib?.assume || null, mode = calibMode();
  const planCache = new Map(); const out = new Map();
  for (const [k, g] of Object.entries(doc.groups || {})) {
    if (!keep(k)) continue;
    const [ags, op, ty] = k.split('|');
    const pk = `${op}|${ags}|${ty}`; if (!planCache.has(pk)) planCache.set(pk, E.planFor(pricing, op, ags, ty, assume?.[ty] || undefined));
    const pl = planCache.get(pk);
    const series = hist?.series?.[k]?.total?.filter(x => x != null) || [];
    const fleetFallback = series.length ? series.reduce((a, b) => a + b, 0) / series.length : (state.latest?.groups?.[k]?.total ?? null);
    // Messung über der Plausibilitätsgrenze (Überzählung): nicht kalibrieren, nicht in Summen
    const chk = K.checkMeasured(E.kpis({ g: maskG(g), obsMin, obsMinV, profile: prof.profile, plan: pl?.plan || null, type: ty, fleetFallback, ride: o.rideMin ? { min: o.rideMin } : null, assume, realization: o.realization, net: o.net, hourMin: doc.hourMin || null }), ty, calib?.limits);
    const m = chk.kpi;
    const fac = K.factorFor(ty, { manual: calibFor(op), k: calib?.k, mode: 'kal', suspended: chk.suspended });
    const cal = K.applyFactor(m, fac.f);
    out.set(k, { ...(mode === 'kal' ? cal : m), m, cal, lo: K.applyFactor(m, fac.lo), hi: K.applyFactor(m, fac.hi), fac, plan: pl, op, ty, ags });
  }
  return { out, doc, obsMin, profile: prof, gapH: mask.gap.filter(Boolean).length, calib };
}
// für die Disposition: Kennzahlen eines Anbieters in einer Gemeinde (letzter Tag, Werte des gewählten Modus)
async function econFor(ags, op, type) {
  const idx = await loadUsageIndex(); const day = (idx.days || []).slice(-1)[0]; if (!day) return null;
  const r = await econGroups(day, (k) => { const [a, o, t] = k.split('|'); return a === ags && o === op && (type === 'all' || t === type); });
  return r ? E.combine([...r.out.values()]) : null;
}
// Kalibrierung: geteilt mit dem Bericht (report.js loadCalibration), Modus „kalibriert“ / „gemessen“ je Browser gemerkt
const getCalib = () => Rp.loadCalibration(rpCtx());
const MODE_KEY = 'mp-calib-mode';
function calibMode() { try { return localStorage.getItem(MODE_KEY) === 'mess' ? 'mess' : 'kal'; } catch { return 'kal'; } }
function setCalibMode(m) { try { localStorage.setItem(MODE_KEY, m === 'mess' ? 'mess' : 'kal'); } catch { /* privates Fenster: Standard „kalibriert“ */ } }
function syncCalibToggle() { const m = calibMode(); $$('#econ-mode button[data-cmode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cmode === m))); }
async function renderEcon(day) {
  const r = await econGroups(day, groupInScope);
  syncCalibToggle();
  if (!r) { $('#econ-tiles').innerHTML = ''; $('#econ-excl').innerHTML = ''; $('#econ-calib').innerHTML = ''; $('#econ-badge').textContent = 'Schätzung'; $('#tbl-econ tbody').innerHTML = emptyRow(6, 'Keine Ereignisdaten für diesen Tag.', 'Anderen Tag wählen.'); $('#tbl-econ-more tbody').innerHTML = emptyRow(7, 'Keine Ereignisdaten für diesen Tag.', 'Anderen Tag wählen.'); return; }
  const kal = calibMode() === 'kal', k = r.calib?.k, sc = r.calib?.assume?.scooter;
  const byName = new Map();
  for (const x of r.out.values()) { const name = `${x.op}|${x.ty}`; if (!byName.has(name)) byName.set(name, []); byName.get(name).push(x); }
  // je Anbieter × Art: Gemeinden mit unplausibler Messung (Überzählung, > 15) fallen aus der Zeile; sind alle unplausibel, ist die Zeile es
  const rows = [...byName].map(([name, list0]) => { const [op, ty] = name.split('|'); const okL = list0.filter(x => x.m.plausible); const list = okL.length ? okL : list0; const dropped = okL.length ? list0.filter(x => !x.m.plausible) : [];
    const c = E.combine(list); const plans = [...new Set(list.map(x => x.plan?.plan ? E.planLabel(x.plan.plan) : null).filter(Boolean))];
    return { op, ty, c, cm: E.combine(list.map(x => x.m)), cc: E.combine(list.map(x => x.cal)), lo: E.combine(list.map(x => x.lo)), hi: E.combine(list.map(x => x.hi)), fac: list[0].fac, dur: [...new Set(list.map(x => x.m.durationSource))], list, dropped, plans, planScope: list.find(x => x.plan)?.plan?.scope }; })
    .filter(x => x.c && x.c.fleet > 0).sort((a, b) => (b.c.revDay || 0) - (a.c.revDay || 0) || b.c.rides - a.c.rides);
  const good = rows.filter(x => x.c.plausible);
  const T = { cm: E.combine(good.map(x => x.cm)), cc: E.combine(good.map(x => x.cc)), lo: E.combine(good.map(x => x.lo)), hi: E.combine(good.map(x => x.hi)) };
  const tot = kal ? T.cc : T.cm;
  const cov = Math.max(0, ...rows.map(x => x.c.coverage || 0));
  const o = econOpts(); const euro = (v, d = 0) => v == null ? '—' : `${fmt(v, d)} €`;
  // Reifegrad: Läufe und Messbeginn am Panel; unter 3 vollen Messtagen Hochrechnungen nur als Spanne
  const idx = await loadUsageIndex(); const first = (idx.days || [])[0]; const runsN = (r.doc.runs || []).length;
  const dd = (d) => d ? `${d.slice(8)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '–';
  $('#econ-badge').textContent = first && first !== day ? `Schätzung · ${fmt(runsN)} Läufe am ${dd(day)} · Daten seit ${dd(first)}` : `Schätzung · ${fmt(runsN)} Läufe seit ${dd(first || day)}`;
  const prelim = r.profile.source === 'Standardkurve' || (r.profile.days ?? 0) < 3;
  const pb = $('#econ-prelim'); pb.hidden = !prelim; pb.title = `Erst ${fmt(r.profile.days ?? 0)} volle Messtage; ab 3 wird der Tagesgang gemessen statt angenommen. Bis dahin gemessene Hochrechnungen als Spanne (× 0,7 bis × 1,3), kalibrierte mit der Spanne der Berliner Quartalswerte.`;
  const rng = (v, d = 0, unit = '') => { if (v == null || !Number.isFinite(v)) return '—'; if (!prelim || v === 0) return `${fmt(v, d)}${unit}`; const f = (x) => x >= 100 ? fmt(sig2(x)) : fmt(x, d); return `${f(v * 0.7)}–${f(v * 1.3)}${unit}`; };
  const fu = (v, d = 0, unit = '') => (v == null || !Number.isFinite(v) ? '—' : `${v >= 1000 && d === 0 ? fmt(sig2(v)) : fmt(v, d)}${unit}`);
  // gemessen und kalibriert nebeneinander: Hauptwert nach Modus, der andere darunter; ohne Faktor wie bisher
  const pair = (x, key, { d = 0, unit = '', scale = 1 } = {}) => {
    const g = (o2) => (o2?.[key] == null ? null : o2[key] * scale);
    const m = g(x.cm), c = g(x.cc), lo = g(x.lo), hi = g(x.hi);
    if (m == null || c == null || Math.abs(c - m) <= 1e-9 * Math.max(1, Math.abs(m))) return { main: rng(m, d, unit), sub: '' };
    const span = lo != null && hi != null && Math.abs(hi - lo) > 1e-9 ? `${fu(lo, d)}–${fu(hi, d, unit)}` : null;
    return kal ? { main: fu(c, d, unit), sub: `${span ? `Spanne ${span} · ` : ''}gemessen ${rng(m, d, unit)}`, lines: [span ? `Spanne ${span}` : null, `gemessen ${rng(m, d, unit)}`].filter(Boolean) } : { main: rng(m, d, unit), sub: `kalibriert ${fu(c, d, unit)}`, lines: [`kalibriert ${fu(c, d, unit)}`] };
  };
  // Tabellenzelle: Hauptwert, darunter Spanne und Vergleichswert je eine Zeile (schmale Spalten)
  const cell = (p, bold = false) => `${bold ? '<b>' : ''}${p.main}${bold ? '</b>' : ''}${(p.lines || []).map(l => `<div class="sub-line">${l}</div>`).join('')}`;
  const tsub = (p, base) => [p.sub, base].filter(Boolean).join(' · ');
  $('#econ-tiles').classList.toggle('prelim', prelim);
  const pR = pair(T, 'ridesDay'), pV = pair(T, 'rvd', { d: 2 }), pU = pair(T, 'utilization', { d: 1, unit: ' %', scale: 100 }), pD = pair(T, 'revDay', { unit: ' €' }), pF = pair(T, 'revPerVehicleDay', { d: 2, unit: ' €' });
  $('#econ-tiles').innerHTML = tot ? [
    tile('Fahrten / Tag', pR.main, tsub(pR, `aus ${fmt(T.cm.rides)} gemessenen · ${fmt(cov * 100)} % des Tagesgangs beobachtet`)),
    tile(abbr('Rides / Fzg. / Tag', 'rvd'), pV.main, tsub(pV, `Ø ${fmt(tot.fleet)} Fahrzeuge auf der Straße`)),
    tile(abbr('Auslastung', 'util'), pU.main, tsub(pU, `Zeit in Fahrt · Ø ${fmt(tot.avgMin, 1)} Min. je Fahrt`)),
    tile(`Umsatz / Tag ${o.net ? 'netto' : 'brutto'}`, pD.main, tsub(pD, `${abbr('Realisierung', 'real')} ${fmt(o.realization * 100)} % · Listenpreise der Feeds`)),
    tile('Umsatz / Fzg. / Tag', pF.main, tsub(pF, `${euro(tot.perRide, 2)} je Fahrt`)),
  ].join('') : '<div class="empty" style="grid-column:1/-1"><b>Keine belastbare Zeile im Filter.</b>Alle Zeilen sind unplausibel oder ohne Flotte; anderen Tag oder Anbieter wählen.</div>';
  // Unplausible Zeilen sind aus den Summen raus – sichtbar machen
  const bad = [...rows.filter(x => !x.c.plausible), ...rows.flatMap(x => (x.dropped || []).map(d => ({ ...x, c: d.m, where: muniName(d.ags) })))]; const names = bad.map(x => `${x.op} ${TYPE[x.ty] || x.ty}${x.where ? ` ${x.where}` : ''}`);
  const ex = $('#econ-excl'); ex.innerHTML = bad.length ? `Summen ohne ${esc(names.slice(0, 4).join(', '))}${names.length > 4 ? ` und ${names.length - 4} weitere` : ''} <span class="muted">(nicht belastbar)</span>` : '';
  ex.title = bad.map(x => `${x.op} ${TYPE[x.ty] || x.ty}: ${x.c.flags[0] || 'unplausibel'}`).join('\n');
  const cal = calibAll();
  const facTxt = (x) => (x.fac.source === 'Korrektur' ? `Korrektur × ${fmt(x.fac.f, 2)}` : x.fac.source === 'kalibriert' ? `kalibriert × ${fmt(x.fac.f, 2)}` : '');
  const DUR = { kalibriert: 'Berliner Mittel', gemessen: 'gemessen', Annahme: 'Annahme', Vorgabe: 'Vorgabe' };
  // Sechs Standardspalten; Korrektur, Auslastung, Dauer, Tarif und Einzelpreise unter „Weitere Spalten“. Nicht belastbare Zeilen: Kennzeichnung statt Ausgrauen.
  const nameCell = (x) => { const c = x.c; const dr = x.dropped || []; return `<td><span class="op"><i style="background:${opColor(x.op)}"></i>${esc(x.op)}</span><div class="sub-line">${esc(TYPE[x.ty] || x.ty)}${state.scope === 'DE' ? ` · ${x.list.length} Gemeinde${x.list.length === 1 ? '' : 'n'}` : ''}</div>${!c.plausible ? '<span class="pill excl-tag">nicht in Summe</span>' : ''}${c.flags.length ? `<div class="sub-line warn-text flag-line">${esc(c.flags[0])}</div>` : ''}${dr.length ? `<div class="sub-line warn-text flag-line">ohne ${esc(dr.slice(0, 3).map(d => muniName(d.ags)).join(', '))}${dr.length > 3 ? ` +${dr.length - 3}` : ''}: ${esc(dr[0].m.flags[0] || 'unplausibel')}</div>` : ''}</td>`; };
  $('#tbl-econ tbody').innerHTML = rows.map(x => { const c = x.cm;
    return `<tr${!x.c.plausible ? ' class="row-excl"' : ''}>${nameCell(x)}
      <td class="n">${fmt(c.fleet)}</td><td class="n">${fmt(c.rides)}<div class="sub-line">${kal && x.fac.source === 'ausgesetzt' ? 'nicht kalibriert' : kal && facTxt(x) ? esc(facTxt(x)) : c.rot ? `${fmt(c.rot)} ${abbr('Kennungswechsel', 'rot')}` : ''}</div></td>
      <td class="n">${cell(pair(x, 'ridesDay'))}</td><td class="n">${cell(pair(x, 'rvd', { d: 2 }), true)}</td><td class="n">${cell(pair(x, 'revDay', { unit: ' €' }), true)}</td></tr>`; }).join('') || emptyRow(6, 'Keine Fahrten im Filter.', 'Anbieter oder Fahrzeugart auf „Alle“ stellen.');
  $('#tbl-econ-more tbody').innerHTML = rows.map(x => { const c = x.cm; const fac = calibFor(x.op);
    return `<tr${!x.c.plausible ? ' class="row-excl"' : ''}>${nameCell(x)}
      <td class="n"><input type="number" class="calib" data-op="${esc(x.op)}" value="${fac}" min="0.1" max="5" step="0.05" style="width:4.8em${fac !== 1 ? ';border-color:var(--accent)' : ''}" aria-label="Korrekturfaktor Fahrten ${esc(x.op)}" title="${esc(GLOSS.calib)}">${fac !== 1 ? '<div class="sub-line">übersteuert</div>' : x.fac.source === 'kalibriert' ? `<div class="sub-line">kalibriert ${fmt(x.fac.f, 2)}</div>` : x.fac.source === 'ausgesetzt' ? '<div class="sub-line">ausgesetzt</div>' : ''}</td>
      <td class="n">${cell(pair(x, 'utilization', { d: 1, unit: ' %', scale: 100 }))}</td><td class="n">${fmt(c.avgMin, 1)} min<div class="sub-line">${esc(x.dur.map(d => DUR[d] || d).join(', '))}</div></td>
      <td class="small">${x.plans.slice(0, 2).map(esc).join('<br>') || '<span class="muted">kein Tarif im Feed</span>'}${x.planScope === 'Anbieter' ? '<div class="sub-line">Tarif anderer Stadt</div>' : ''}</td>
      <td class="n">${euro(c.perRide, 2)}</td><td class="n">${cell(pair(x, 'revPerVehicleDay', { d: 2, unit: ' €' }))}</td></tr>`; }).join('') || emptyRow(7, 'Keine Fahrten im Filter.', 'Anbieter oder Fahrzeugart auf „Alle“ stellen.');
  // Kalibrierung in zwei Zeilen; Einzelheiten im Panel „Kalibrierung“
  const calOps = Object.keys(cal);
  const kTxt = k?.applied ? `E-Scooter-Fahrten × <b class="mono">${fmt(k.k, 2)}</b> <span class="muted">(Spanne ${fmt(k.kLow, 2)}–${fmt(k.kHigh, 2)})</span> = amtlich Berlin ${esc(k.quarter)} <b class="mono">${fmt(k.ref.wert, 2)}</b> ÷ gemessen Berlin <b class="mono">${fmt(k.measured.rvd, 2)}</b> ${abbr('Rides/Fzg./Tag', 'rvd')} <span class="muted">(${esc(k.source)})</span>${k.prelim ? ' <span class="pill prelim badge" title="' + esc(k.prelimWhy.join(', ')) + '">vorläufig</span>' : ''}${k.single ? ` <span class="muted">· nur ein Anbieter</span>` : ''}` : `Fahrten nicht kalibriert: ${esc(k?.reason || 'Referenzwerte nicht ladbar')}`;
  const aTxt = sc?.calibrated ? `Ø Fahrt E-Scooter <b class="mono">${fmt(sc.min, 1)} Min.</b> statt ${fmt(sc.previous.min)} (Mittel Berlin ${esc(sc.from)}–${esc(sc.to)})` : `Ø Fahrt E-Scooter ${fmt(sc?.min ?? 12)} Min. (Annahme, Referenz fehlt)`;
  $('#econ-calib').innerHTML = `<div><b>${kal ? 'Kalibriert' : 'Gemessen'}</b> · ${kTxt}</div><div>${aTxt} · Räder, E-Bikes, Lastenräder: bisherige Annahmen, nicht kalibriert${r.calib?.limits?.scooter ? ` · über ${fmt(r.calib.limits.scooter, 2)} Rides/Fzg./Tag: Kalibrierung ausgesetzt (Überzählung)` : ''}${calOps.length ? ` · <b>Korrektur ×</b> übersteuert für ${esc(calOps.join(', '))}` : ''} · <span class="muted">Herleitung im Panel „Kalibrierung“</span></div>`;
  const excludedN = rows.length - good.length;
  $('#econ-note').innerHTML = `Fahrten = verschwundene verfügbare Fahrzeuge (${abbr('Kennungswechsel', 'rot')} ≤ 40 m am selben Ort zählen nicht). Hochrechnung auf 24 h über den Tagesgang (${esc(r.profile.source)}${prelim ? '; gemessen unter 3 vollen Messtagen als Spanne × 0,7 bis × 1,3' : ''}). <b>Kalibriert</b> = gemessene E-Scooter-Fahrten × Methodenfaktor aus amtlichen Berliner Zahlen (Spanne aus den Quartalswerten); Räder und E-Bikes bleiben gemessen. Flotte = Ø Fahrzeuge auf der Straße inkl. gesperrter. Ø Fahrtdauer: ${o.rideMin ? `Vorgabe ${fmt(o.rideMin)} Min.` : `gemessen, wo Kennungen stabil sind (≥ 20 Fahrten; 20-Min.-Raster = Obergrenze), sonst Annahme: E-Scooter ${sc?.calibrated ? `${fmt(sc.min, 1)} Min. aus den Berliner Quartalswerten (bisher 12)` : '12 Min.'}, E-Bike 16, Rad 18, Lastenrad 40 (ohne Belege)`}. Umsatz zu Listenpreisen des Standardtarifs, ${o.net ? 'ohne 19 % MwSt., ' : ''}mal ${abbr('Realisierungsquote', 'real')}. Betreiber-Umsetzungen, die das Fahrzeug aus dem Feed nehmen, zählen als Fahrt.${r.gapH ? ` ${r.gapH} Stunde${r.gapH === 1 ? '' : 'n'} nach einer Messlücke (über 45 Min. ohne Lauf) zählen weder als Beobachtung noch mit ihren Fahrten.` : ''}${excludedN ? ` ${excludedN} Zeile${excludedN === 1 ? '' : 'n'} mit unplausibler Fahrtenzahl sind mit „nicht in Summe“ markiert.` : ''} <b>Korrektur ×</b> ersetzt für einen Anbieter den Kalibrierfaktor (wirkt auf Rides/Fzg./Tag, Auslastung und Umsatz); die Faktoren gelten nur in diesem Browser${calOps.length ? ` – aktiv für ${esc(calOps.join(', '))}` : ''}.`;
}
// ---------- Kalibrierung: Referenzwerte (data/reference.json, Branch main) gegen die eigene Messung, Regeln in lib/pulse-calib.js ----------
// Voi: Umsatz je Fahrzeug und Tag (gemessen, netto × Realisierung) über die Tage der Kalibrierung, Flotte-Tage gewichtet
async function voiRevenue(days) {
  let rev = 0, fleet = 0, n = 0;
  for (const d of days || []) {
    const r = await econGroups(d, (key) => { const [a, op, t] = key.split('|'); return a !== 'DE' && op === 'Voi' && t === 'scooter'; }); if (!r) continue;
    const c = E.combine([...r.out.values()].map(x => x.m).filter(x => x.plausible)); if (c?.revDay != null && c.fleet > 0) { rev += c.revDay; fleet += c.fleet; n++; }
  }
  return fleet > 0 ? { revPerVehicleDay: rev / fleet, days: n } : null;
}
async function renderCalibPanel() {
  const els = ['calib-panel', 'calib-src'].map(id => document.getElementById(id)).filter(Boolean); if (!els.length) return;
  const head = `<div class="panel-head"><div><h2>Kalibrierung</h2><div class="sub">Öffentliche Referenzwerte mit Quelle, eigene Messung, Verhältnis und Wirkung auf die Schätzungen</div></div></div>`;
  const calib = await getCalib(); const k = calib.k, a = calib.assume?.scooter, ref = calib.ref;
  if (!ref) { for (const el of els) el.innerHTML = head + '<div class="empty"><b>Referenzwerte nicht ladbar.</b>reference.json fehlt oder ist nicht erreichbar; es gelten die bisherigen Annahmen (E-Scooter 12 Min.), keine Kalibrierung.</div>'; return; }
  const voi = await voiRevenue(calib.days).catch(() => null);
  const checks = K.plausibilityChecks(ref, { ...calib.own, voi: { ...(calib.own?.voi || {}), revPerVehicleDay: voi?.revPerVehicleDay ?? null } }, k);
  const src = (e) => (e?.url ? link(e.url, `${esc(e.quelle || 'Quelle')} ↗`) : esc(e?.quelle || '—'));
  const dd = (d) => d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '–';
  const f2 = (v) => fmt(v, 2);
  const rows = [];
  // 1. Fahrtdauer
  if (a?.calibrated) rows.push([`Ø Fahrt E-Scooter<div class="sub-line">Berlin, ${esc(a.from)}–${esc(a.to)} (${a.n} Quartale)</div>`, `Ø <b>${fmt(a.min, 1)} Min.</b> · Ø ${f2(a.km)} km<div class="sub-line">Quartale ${fmt(a.minRange[0], 1)}–${fmt(a.minRange[1], 1)} Min. · ${fmt(a.kmRange[0], 1)}–${fmt(a.kmRange[1], 1)} km</div>`, src(a),
    'nicht messbar<div class="sub-line">Kennungen wechseln je Fahrt; stabile Kennungen nur im 20-Min.-Raster (Obergrenze)</div>', `${f2(a.min / a.previous.min)}<div class="sub-line">gegen bisher ${fmt(a.previous.min)} Min.</div>`, `Annahme ${fmt(a.previous.min)} → ${fmt(a.min, 1)} Min.: Auslastung × ${f2(a.min / a.previous.min)}, Umsatz je Fahrt sinkt (Minutenpreise); gemessene Dauer gilt nur darunter`]);
  for (const e of (ref.fahrt || []).filter(x => x.ags !== K.BERLIN && x.type === 'scooter')) rows.push([`Fahrt E-Scooter<div class="sub-line">${esc(e.ort)}, ${esc(e.zeitraum)}</div>`, [e.minMedian != null ? `Median ${fmt(e.minMedian, 1)} Min.` : '', e.minMittel != null ? `Ø ${fmt(e.minMittel, 1)} Min.` : '', e.kmMedian != null ? `Median ${f2(e.kmMedian)} km` : '', e.kmMittel != null ? `Ø ${f2(e.kmMittel)} km` : ''].filter(Boolean).join(' · '), src(e), '—', a?.calibrated && e.minMittel ? `${f2(a.min / e.minMittel)}<div class="sub-line">Berliner Ø ÷ Ø hier</div>` : '—', 'Gegenprobe, nicht in der Regel (ein Betreiber, eine Stadt)']);
  // 2. Methodenfaktor
  const kr = k?.ref || (ref.rvd || []).filter(e => e.ags === K.BERLIN).slice(-1)[0];
  if (kr) rows.push([`Fahrten je Fzg. und Tag, E-Scooter<div class="sub-line">Berlin, ${esc(k?.applied ? `${k.quarter} (${k.rule})` : kr.zeitraum)}</div>`, `<b>${f2(kr.wert)}</b>${k?.refMin != null ? `<div class="sub-line">Quartale ${f2(k.refMin)}–${f2(k.refMax)}</div>` : ''}`, src(kr),
    k?.measured?.rvd ? `${f2(k.measured.rvd)}<div class="sub-line">${esc(k.source || '')}; ${dd(k.measured.from)}–${dd(k.measured.to)} · ${k.measured.days} Tag${k.measured.days === 1 ? '' : 'e'} (${fmt(k.obsShare * 100)} % der Stunden beobachtet)</div>${(k.measured.excluded || []).length ? `<div class="sub-line">ausgeschlossen (Überzählung): ${esc(k.measured.excluded.map(x => `${x.op} ${f2(x.rvd)}`).join(', '))}</div>` : ''}` : '—',
    k?.applied ? `k = <b>${f2(k.k)}</b><div class="sub-line">${f2(k.kLow)}–${f2(k.kHigh)}</div>` : '—',
    k?.applied ? `E-Scooter-Fahrten bundesweit × ${f2(k.k)} (kalibriert, ${esc(Rp.calibLabel(k))}), außer Zeilen über ${f2(calib.limits?.scooter)}${k.prelim ? `<div class="sub-line">vorläufig: ${esc(k.prelimWhy.join(', '))}</div>` : ''}${k.single ? `<div class="sub-line">Einschränkung: ${esc(k.single)}</div>` : ''}` : `keine Kalibrierung: ${esc(k?.reason || '')}`]);
  // 3. Abdeckung (+ Hochrechnung nur hier)
  for (const c of calib.coverage || []) {
    const rv = calib.own?.byAgs?.[c.ags]?.rvd; const rvdCal = k?.applied && rv != null && !(rv > (calib.limits?.scooter ?? Infinity)) ? rv * k.k : null;
    rows.push([`${esc(c.label[0].toUpperCase() + c.label.slice(1))} E-Scooter<div class="sub-line">${esc(c.ort)}, ${c.stand ? `Stand ${dd(c.stand)}` : ''}</div>`, `<b>${c.art === 'aktiv' ? 'rund ' : ''}${fmt(c.official)}</b><div class="sub-line">${esc(c.label)}</div>`, src(c), `${fmt(c.ours)}<div class="sub-line">in offenen Feeds${c.operators.length ? ` (${esc(c.operators.map(o => o.op).join(', '))})` : ''}</div>`, `<b>${fmt(c.share * 100, 1)} %</b>`,
      `${esc(c.shareLabel)}${rvdCal != null ? `<div class="sub-line">Hochrechnung nur hier: ${f2(rvdCal)} × ${fmt(c.official)} ≈ ${fmt(sig2(rvdCal * c.official))} Fahrten/Tag${c.art === 'genehmigt' ? ' (auf die genehmigte Flotte, daher Obergrenze)' : ' (auf die aktive Flotte)'}</div>` : ''}`]);
  }
  // 4. Prüfwerte ohne Faktor
  for (const x of checks) {
    const u = x.unit === '€' ? ' €' : '';
    const mv = x.measured == null ? '—' : `${f2(x.measured)}${u}${x.calibrated != null ? `<div class="sub-line">kalibriert ${f2(x.calibrated)}${u}</div>` : x.suspended ? `<div class="sub-line warn-text">${esc(Rp.SUSPENDED_TXT)}</div>` : ''}<div class="sub-line">${esc(x.kind === 'Untergrenze' ? `${x.ref.ort}, offene Feeds` : x.scope || '')}${x.unit === '€' && voi ? `, ${voi.days} Tag${voi.days === 1 ? '' : 'e'}` : ''}</div>`;
    const ratio = x.ratioCal ?? x.ratio;
    rows.push([`${esc(x.label.replace(/: .*/, ''))}<div class="sub-line">${esc(x.label.replace(/^[^:]*: /, ''))} · ${esc(x.ref.zeitraum || '')}</div>`, `<b>${x.kind === 'Untergrenze' ? '≥ ' : ''}${f2(x.refValue)}${u}</b>${x.how ? `<div class="sub-line">${esc(`${fmt(x.trips / 1e6, 2)} Mio. Fahrten ÷ ${x.year % 4 ? 365 : 366} ÷ Obergrenze ${fmt(x.limit)}`)}</div>` : x.ref.hinweis ? `<div class="sub-line">${esc(x.ref.hinweis)}</div>` : ''}`, `${src(x.ref)}${x.cap && x.cap.url !== x.ref.url ? ` · ${src(x.cap)}` : ''}`, mv,
      ratio == null ? '—' : `${f2(ratio)}<div class="sub-line">${x.ratioCal != null ? 'kalibriert' : 'gemessen'} ÷ Referenz</div>`, x.suspended ? `Messung über ${f2(calib.limits?.scooter)} (1,5 × größter Berliner Quartalswert): Überzählung wahrscheinlich, Kalibrierung ausgesetzt, Zeile nicht in Summen` : x.kind === 'Untergrenze' ? 'Prüfung, kein Faktor; Untergrenze gilt nur, wenn die Flotte die Obergrenze nicht überschreitet' : 'Vergleich, kein Faktor']);
  }
  const rules = `<ol class="calib-rules small"><li><b>Fahrtdauer.</b> Ø Fahrt E-Scooter = Mittel der Berliner Quartalswerte${a?.calibrated ? ` (${fmt(a.min, 1)} Min., ${f2(a.km)} km)` : ''}; gemessene Dauer (20-Min.-Raster) gilt nur darunter. Räder, E-Bikes, Lastenräder: keine amtlichen Belege, bisherige Annahmen.</li>
    <li><b>Methodenfaktor k.</b> Amtliche Fahrten je E-Scooter und Tag in Berlin (gleiches Quartal, sonst Vorjahresquartal, sonst jüngstes) ÷ unsere Berliner Messung über die letzten bis zu ${Rp.CALIB_DAYS} Tagesdateien; k gleicht verschluckte Fahrten zwischen zwei Abrufen und Kennungswechsel aus und gilt für E-Scooter bundesweit, die Spanne folgt aus dem kleinsten und größten Quartalswert.</li>
    <li><b>Plausibilität.</b> Liegt die gemessene Zahl der Fahrten je E-Scooter und Tag eines Anbieters in einem Gebiet über ${calib.limits?.scooter ? f2(calib.limits.scooter) : '–'} (${fmt(K.CALIB.overFactor, 1)} × größter Berliner Quartalswert), gilt sie als Überzählung: keine Kalibrierung, nicht in Summen. k stammt nur aus plausiblen Berliner Anbietern${k?.source ? ` (${esc(k.source)})` : ''}${k?.single ? '; nur ein Anbieter, andere können anders zählen' : ''}.</li>
    <li><b>Vorläufig</b> unter ${K.CALIB.minDays} Messtagen oder unter ${K.CALIB.minObsShare * 100} % beobachteter Tagesstunden; ohne Berliner Messung oder bei k außerhalb ${fmt(K.CALIB.kMin, 1)}–${fmt(K.CALIB.kMax)} keine Kalibrierung. Eigene „Korrektur ×“ ersetzt k je Anbieter.</li>
    <li><b>Abdeckung und Prüfung.</b> Eigene E-Scooter ÷ amtliche Flotte: in Berlin Anteil an der genehmigten Flotte (Untergrenze der Feed-Abdeckung, nicht alle genehmigten Fahrzeuge fahren), in München an der aktiven Flotte; Frankfurt (Untergrenze aus Jahresfahrten und Obergrenze), Europa und Voi dienen nur dem Vergleich.</li></ol>`;
  const table = `<div class="tbl" tabindex="0" role="region" aria-label="Kalibrierung: Referenzwerte und eigene Messung"><table class="calib-tbl"><thead><tr><th>Referenz</th><th class="n">Wert</th><th>Quelle</th><th class="n">unser Messwert</th><th class="n">Verhältnis</th><th>Wirkung</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="n">${r[1]}</td><td class="small">${r[2]}</td><td class="n">${r[3]}</td><td class="n">${r[4]}</td><td class="small">${r[5]}</td></tr>`).join('')}</tbody></table></div>`;
  const foot = `<div class="muted small" style="margin-top:var(--s2)">Messzeitraum ${calib.days.length ? `${dd(calib.days[0])}–${dd(calib.days[calib.days.length - 1])}` : '–'} · Voi-Umsatz als Schätzung ${econOpts().net ? 'netto' : 'brutto'} × Realisierung ${fmt(econOpts().realization * 100)} % zu Listenpreisen (Konzernwert: tatsächlicher Umsatz aller Märkte, inkl. E-Bikes) · Referenzen in data/reference.json, Stand ${esc(ref.updatedAt || '–')}</div>`;
  for (const el of els) el.innerHTML = head + rules + table + foot;
}
// Korrekturfaktoren je Anbieter, lokal im Browser (localStorage, fehlertolerant)
const CALIB_KEY = 'mp-calib';
function calibAll() { try { const v = JSON.parse(localStorage.getItem(CALIB_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function calibFor(op) { const v = +calibAll()[op]; return Number.isFinite(v) && v > 0 ? v : 1; }
function setCalib(op, v) { try { const all = calibAll(); if (!Number.isFinite(v) || v <= 0 || Math.abs(v - 1) < 1e-9) delete all[op]; else all[op] = Math.min(5, Math.max(0.1, v)); localStorage.setItem(CALIB_KEY, JSON.stringify(all)); } catch { /* privates Fenster: Faktor gilt nicht */ } }
// Langzeit-Archiv (Tageswerte je Monat): nur Hinweis auf Umfang
async function renderArchive() {
  const el = $('#usage-archive'); if (!el) return;
  const idx = await loadOnce('archiveIndex', 'archive/index.json');
  const months = (idx?.months || []).filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
  if (!months.length) { el.textContent = ''; return; }
  // Tage und erster Tag stehen im Index (Vertrag 7); nur bei altem Datenstand die Monatsdateien zum Zählen laden
  if (state.usage.archiveDays == null) {
    if (Number.isFinite(idx.days)) state.usage.archiveDays = idx.days;
    else { const docs = await Promise.all(months.map(m => cached(`archive/${m}.json`, 60000))); state.usage.archiveDays = docs.reduce((a, d) => a + Object.keys(d.json?.days || {}).length, 0); }
  }
  const n = state.usage.archiveDays; const first = /^\d{4}-\d{2}-\d{2}$/.test(idx.firstDay || '') ? idx.firstDay : null; const m0 = months[0];
  el.textContent = `· Archiv seit ${first ? new Date(`${first}T12:00:00`).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) : new Date(+m0.slice(0, 4), +m0.slice(5, 7) - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}, ${fmt(n)} Tag${n === 1 ? '' : 'e'}`;
}
function T_empty() { return { start: new Array(24).fill(0), end: new Array(24).fill(0), reloc: new Array(24).fill(0), swap: new Array(24).fill(0), pickup: new Array(24).fill(0), disOn: new Array(24).fill(0), disOff: new Array(24).fill(0), swapWaitSum: 0, swapWaitN: 0, disDurSum: 0, disDurN: 0, tripDurSum: 0, tripDurN: 0, tripDistSum: 0, tripDistN: 0 }; }
function T_add(a, g, ok = null) { for (const f of ['start', 'end', 'reloc', 'swap', 'pickup', 'disOn', 'disOff']) for (let i = 0; i < 24; i++) if (!ok || ok[i]) a[f][i] += g[f]?.[i] || 0; for (const f of ['swapWaitSum', 'swapWaitN', 'disDurSum', 'disDurN', 'tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN']) a[f] += g[f] || 0; }
async function loadWeather(day) {
  const c = state.scope === 'DE' ? [51.16, 10.45] : muniCenters().get(state.scope); if (!c) return null;
  const key = `${day}|${c[0].toFixed(2)},${c[1].toFixed(2)}`;
  if (!(key in state.usage.weather)) {
    const r = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${c[0].toFixed(3)}&longitude=${c[1].toFixed(3)}&hourly=temperature_2m,precipitation&start_date=${day}&end_date=${day}&timezone=Europe%2FBerlin`, { timeout: 15000 });
    state.usage.weather[key] = r.ok ? { temp: r.json.hourly.temperature_2m, rain: r.json.hourly.precipitation, name: state.scope === 'DE' ? 'Deutschland-Mitte' : muniName(state.scope) } : null;
  }
  return state.usage.weather[key];
}
// Messlücken (Vertrag 5): Lauf mit Flag 0 oder über 45 Min. nach dem vorigen zählt nicht; seine Stunde (Berliner Zeit) gilt als Lücke
const GAP_MS = 45 * 60e3;
const BERLIN_HOUR = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
const hourOf = (ms) => +BERLIN_HOUR.format(new Date(ms)) % 24;
const isGapRun = (r) => r[2] === 0 || (r[1] != null && r[1] > GAP_MS);
// ok[h] = Stunde gemessen und ohne Lücken-Lauf; gap[h] = Stunde mit Lücken-Lauf (aus runs und, falls vorhanden, doc.gapHours des Sammlers)
function hourMask(runs, gapHours = null) {
  const measured = new Array(24).fill(false), gap = new Array(24).fill(false);
  for (const r of runs || []) { const h = hourOf(r[0]); if (isGapRun(r)) gap[h] = true; else if (r[1] != null) measured[h] = true; }
  for (const h of Array.isArray(gapHours) ? gapHours : []) if (h >= 0 && h < 24) gap[h] = true;
  return { ok: measured.map((m, h) => m && !gap[h]), gap, measured };
}
// Eine Achse: Wetter steht als eigenes Band unter dem Diagramm (Regenbalken und Temperatur als Text), nicht als zweite Skala im Diagramm.
// Je Stunde eine unsichtbare Trefferfläche mit Tooltip (alle Werte der Stunde); Feiertag oben rechts.
function hourChart(series, weather, runs, mask = null, holiday = null) {
  const WB = weather ? 58 : 0, HT = holiday ? 16 : 0, W = 900, H = 260 + WB + HT, P = { l: 44, r: 12, t: 12 + HT, b: 26 + WB };
  const vals = series.flatMap(s => s.values).filter(v => v != null);
  const nt = niceTicks(Math.max(1, ...vals) * 1.05), max = nt.top; // runde Achsenwerte statt 96/191/287/383
  const x = (h) => P.l + ((h + 0.5) / 24) * (W - P.l - P.r), cw = (W - P.l - P.r) / 24;
  const y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
  let g = '';
  // nicht gemessene Stunden und Stunden nach Messlücke grau hinterlegen (statt einer Nulllinie)
  const m = mask || hourMask(runs);
  for (let h = 0; h < 24; h++) if (!m.ok[h]) g += `<rect class="gap" x="${(x(h) - cw / 2).toFixed(1)}" y="${P.t}" width="${cw.toFixed(1)}" height="${H - P.t - P.b}"><title>${h}–${h + 1} Uhr: ${m.gap[h] ? 'Lauf nach über 45 Min. Pause – Bewegungen nicht zuordenbar, nicht gezählt' : 'kein Sammler-Lauf – nicht gemessen'}</title></rect>`;
  for (let h = 0; h < 24; h++) if (!m.ok[h] && (h === 0 || m.ok[h - 1])) { let e = h; while (e < 23 && !m.ok[e + 1]) e++; if (e - h >= 2) g += `<text x="${((x(h) + x(e)) / 2).toFixed(1)}" y="${P.t + 12}" text-anchor="middle">nicht gemessen</text>`; }
  for (const v of nt.ticks) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${P.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v, nt.step < 1 ? 1 : 0)}</text>`;
  const yAx = H - WB - 8;
  for (let h = 0; h < 24; h += 3) g += `<text x="${x(h).toFixed(1)}" y="${yAx}" text-anchor="middle">${h} Uhr</text>`;
  if (holiday) g += `<text class="hol" x="${W - P.r}" y="${P.t - 6}" text-anchor="end">${esc(holiday)}</text>`; // über der Fläche, kollidiert nicht mit „nicht gemessen“
  let wx = '';
  if (weather) {
    // eigenes Band: Regen als Balken (eigene Höhe, kein Bezug zur y-Achse), Temperatur als Zahl alle 3 Stunden
    const b0 = H - WB + 6, bh = 26, rmax = Math.max(1, ...weather.rain.map(v => v || 0));
    wx += `<text x="${P.l - 6}" y="${b0 + 12}" text-anchor="end">Wetter</text><line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${b0 + bh}" y2="${b0 + bh}"/>`;
    for (let h = 0; h < 24; h++) if (weather.rain[h] > 0) { const hh = Math.max(2, (weather.rain[h] / rmax) * bh); wx += `<rect class="rain" x="${(x(h) - cw / 2 + 2).toFixed(1)}" y="${(b0 + bh - hh).toFixed(1)}" width="${(cw - 4).toFixed(1)}" height="${hh.toFixed(1)}"><title>${h} Uhr: ${fmt(weather.rain[h], 1)} mm Niederschlag</title></rect>`; }
    for (let h = 0; h < 24; h += 3) if (weather.temp[h] != null) wx += `<text x="${x(h).toFixed(1)}" y="${b0 + bh + 14}" text-anchor="middle">${fmt(weather.temp[h])}°</text>`;
  }
  // Linie an fehlenden Stunden unterbrochen; einzelne gemessene Stunden als Punkt (≥ 8 px)
  const paths = series.map((s, i) => { const col = s.color || palette(i); let d = '', open = false, dots = ''; s.values.forEach((v, h) => { if (v == null) { open = false; return; } const alone = (h === 0 || s.values[h - 1] == null) && (h === 23 || s.values[h + 1] == null); if (alone) dots += `<circle cx="${x(h).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${col}" stroke="var(--panel)" stroke-width="2"/>`; d += `${open ? 'L' : 'M'}${x(h).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>${dots}`; }).join('');
  // Trefferflächen je Stunde mit allen Werten (Tooltip)
  let hits = '';
  for (let h = 0; h < 24; h++) { const lines = m.ok[h] ? series.filter(s => s.values[h] != null).sort((a, b) => b.values[h] - a.values[h]).map(s => `${s.name} ${fmt(s.values[h])}`) : [m.gap[h] ? 'nach Messlücke – nicht gezählt' : 'nicht gemessen']; if (weather && weather.temp[h] != null) lines.push(`${fmt(weather.temp[h])} °C · ${fmt(weather.rain[h] || 0, 1)} mm`); hits += `<rect class="hit" x="${(x(h) - cw / 2).toFixed(1)}" y="${P.t}" width="${cw.toFixed(1)}" height="${H - P.t - 8}"><title>${h}–${h + 1} Uhr\n${esc(lines.join('\n'))}</title></rect>`; }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fahrtbeginne je Stunde; grau = nicht gemessen${holiday ? `; ${esc(holiday)}` : ''}">${g}${wx}${paths}${hits}</svg>`;
}
// Feiertage lokal berechnet (kein Abruf): Ostern nach Gauß/Meeus, dazu feste und bewegliche Feiertage je Bundesland
const easter = (y) => { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1; return Date.UTC(y, mo - 1, da); };
const ALL_DE = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'];
function holidaysOf(day) {
  const y = +day.slice(0, 4), E = easter(y), dd = (ms) => new Date(ms).toISOString().slice(0, 10), fx = (md) => `${y}-${md}`, off = (n) => dd(E + n * 86400e3);
  const bub = dd(Date.UTC(y, 10, 22) - ((new Date(Date.UTC(y, 10, 22)).getUTCDay() + 4) % 7) * 86400e3); // Mittwoch vor dem 23. November
  return [
    [fx('01-01'), 'Neujahr', ALL_DE], [fx('01-06'), 'Heilige Drei Könige', ['BW', 'BY', 'ST']], [fx('03-08'), 'Frauentag', ['BE', 'MV']],
    [off(-2), 'Karfreitag', ALL_DE], [off(0), 'Ostersonntag', ['BB']], [off(1), 'Ostermontag', ALL_DE], [fx('05-01'), 'Tag der Arbeit', ALL_DE],
    [off(39), 'Christi Himmelfahrt', ALL_DE], [off(49), 'Pfingstsonntag', ['BB']], [off(50), 'Pfingstmontag', ALL_DE], [off(60), 'Fronleichnam', ['BW', 'BY', 'HE', 'NW', 'RP', 'SL']],
    [fx('08-15'), 'Mariä Himmelfahrt', ['SL', 'BY*']], [fx('09-20'), 'Weltkindertag', ['TH']], [fx('10-03'), 'Tag der Deutschen Einheit', ALL_DE],
    [fx('10-31'), 'Reformationstag', ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH']], [fx('11-01'), 'Allerheiligen', ['BW', 'BY', 'NW', 'RP', 'SL']],
    [bub, 'Buß- und Bettag', ['SN']], [fx('12-25'), '1. Weihnachtstag', ALL_DE], [fx('12-26'), '2. Weihnachtstag', ALL_DE],
  ].filter(([d]) => d === day);
}
// Text für den gewählten Tag und das Gebiet: Feiertag im Land der Gemeinde, deutschlandweit mit Zahl der Länder; sonst Sonntag
function dayNote(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
  const st = state.scope === 'DE' ? null : scopeState();
  const hits = holidaysOf(day).map(([, name, lands]) => ({ name, lands: lands.map(l => l.replace('*', '')), part: lands.some(l => l.endsWith('*') && (!st || l.startsWith(st))) })).filter(h => !st || h.lands.includes(st));
  const sunday = new Date(`${day}T12:00:00Z`).getUTCDay() === 0;
  if (hits.length) return `Feiertag: ${hits.map(h => `${h.name}${st ? ` (${st}${h.part ? ', teilweise' : ''})` : h.lands.length === 16 ? ' (bundesweit)' : ` (${h.lands.length} Länder)`}`).join(', ')}${sunday ? ' · Sonntag' : ''}`;
  return sunday ? 'Sonntag' : null;
}
async function cellsForScope(day) {
  if (state.scope === 'DE') return null;
  const st = scopeState(); if (!st) return null;
  const doc = await loadCells(day, st); return doc?.munis?.[state.scope] || null;
}
async function renderCellsTable(day) {
  const tb = $('#tbl-cells tbody');
  const cells = await cellsForScope(day);
  if (!cells) { tb.innerHTML = state.scope === 'DE' ? emptyRow(5, 'Zellen gibt es je Gemeinde.', 'Oben ein Gebiet wählen.') : emptyRow(5, 'Noch keine Zellen für diesen Tag.', 'Anderen Tag wählen.'); return; }
  // Präsenz (fast immer 100 %) entfällt; Lage als Straße/Stadtteil (Nominatim, nur die gezeigten Top 20)
  const rows = Object.entries(cells).map(([cell, v]) => ({ cell, start: v[0], end: v[1], present: v[2], reloc: v[3], net: v[1] - v[0] })).filter(r => r.start + r.end + r.reloc > 0).sort((a, b) => b.start - a.start).slice(0, 20);
  const pts = rows.map(r => { const [lat, lon] = cellCenterOf(r.cell); return { ...r, lat, lon, k: geoKey(lat, lon) }; });
  tb.innerHTML = pts.map(r => `<tr><td><a href="#live" class="pick-cell" data-lat="${r.lat}" data-lon="${r.lon}"><span data-geo="${r.k}">${esc(GEO.get(r.k) || 'Zelle')}</span></a><div class="sub-line mono">${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</div></td><td class="n">${fmt(r.start)}</td><td class="n">${fmt(r.end)}</td><td class="n" style="color:var(--${r.net > 0 ? 'ok' : r.net < 0 ? 'bad' : 'muted'})">${r.net > 0 ? '+' : ''}${fmt(r.net)}</td><td class="n">${fmt(r.reloc)}</td></tr>`).join('') || emptyRow(5, 'Keine Bewegungen in diesem Gebiet.', 'Anderen Tag wählen.');
  queueGeo(pts);
}
// Straße/Stadtteil per Nominatim wie in der Disposition: höchstens 1 Anfrage je Sekunde, Cache (Sitzung), nur gezeigte Zeilen (≤ 20)
const GEO = new Map(); const geoQueue = []; let geoBusy = false;
const geoKey = (lat, lon) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
try { for (const [k, v] of Object.entries(JSON.parse(sessionStorage.getItem('mp-geo') || '{}'))) GEO.set(k, v); } catch { /* ohne Sitzungsspeicher */ }
function geoText(j) { const a = j?.address || {}; const street = a.road || a.pedestrian || a.footway || a.square || a.path || a.cycleway || a.place || j?.name || null; const area = a.suburb || a.city_district || a.quarter || a.neighbourhood || a.village || a.town || null; return [street, area].filter(Boolean).join(' · ') || null; }
function queueGeo(points) { for (const p of points.slice(0, 20)) if (!GEO.has(p.k) && !geoQueue.some(q => q.k === p.k)) geoQueue.push({ k: p.k, lat: p.lat, lon: p.lon }); pumpGeo(); }
async function pumpGeo() {
  if (geoBusy) return; geoBusy = true;
  try {
    while (geoQueue.length) {
      const q = geoQueue.shift(); if (GEO.has(q.k)) continue;
      const r = await getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${q.lat.toFixed(6)}&lon=${q.lon.toFixed(6)}&accept-language=de`, { timeout: 15000 });
      if (!r.status) { geoQueue.length = 0; break; } // Dienst nicht erreichbar: nicht weiter anfragen (nächster Aufruf versucht es erneut)
      GEO.set(q.k, r.ok ? geoText(r.json) : null);
      try { sessionStorage.setItem('mp-geo', JSON.stringify(Object.fromEntries(GEO))); } catch { /* voll/privat */ }
      $$(`[data-geo="${q.k}"]`).forEach(el => { const t = GEO.get(q.k); if (t) el.textContent = t; });
      if (geoQueue.length) await new Promise(res => setTimeout(res, 1100)); // Nominatim-Nutzungsregel: höchstens 1 Anfrage je Sekunde
    }
  } finally { geoBusy = false; }
}
const CELL_LAT = 0.0025, CELL_LON = 0.0035;
function cellCenterOf(cell) { const [a, b] = cell.split(':').map(Number); return [a * CELL_LAT, b * CELL_LON]; }
async function renderQuota() {
  const q = await loadOnce('quota', 'stations-quota.json'); const tb = $('#tbl-quota tbody');
  if (!q) { tb.innerHTML = '<tr><td colspan="5" class="empty"><b>Keine Stationsdaten.</b>Die Quote entsteht aus den Sammler-Läufen der letzten 7 Tage.</td></tr>'; return; }
  // virtuelle Stationen (Abstellzonen ohne Dock, Feld „virtual“) sind kein Versorgungsmangel, wenn leer → nicht in der Leer-Quote
  const vi = (q.fields || []).indexOf('virtual');
  let rows = q.stations.filter(s => (state.scope === 'DE' || s[0] === state.scope) && (state.operator === 'all' || s[1] === state.operator) && s[5] >= 3 && !(vi >= 0 && s[vi]));
  rows.sort((a, b) => (b[6] / b[5]) - (a[6] / a[5]) || b[5] - a[5]);
  rows = rows.slice(0, 25);
  tb.innerHTML = rows.map(s => `<tr><td>${esc(s[2] || 'Station')}${state.scope === 'DE' ? `<div class="sub-line">${esc(muniName(s[0]))}</div>` : ''}</td><td>${esc(s[1])}</td><td class="n">${fmt(s[5])}</td><td class="n"><span style="color:var(--${s[6] / s[5] >= 0.5 ? 'bad' : s[6] / s[5] >= 0.25 ? 'warn' : 'fg'})">${pctf(s[6], s[5])}</span></td><td class="n">${pctf(s[7], s[5])}</td></tr>`).join('') || '<tr><td colspan="5" class="empty"><b>Keine Stationen mit genug Läufen im Filter.</b>Stationen brauchen mindestens 3 Sammler-Läufe.</td></tr>';
}

// ---------- Karten-Ebenen: Start/Ziel, bediente Zellen, lange Standzeiten, Betriebszonen ----------
async function renderFlowLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const idx = await loadUsageIndex(); const day = state.usage.day || idx.days?.slice(-1)[0]; if (!day) { notice('Noch keine Ereignisdaten für die Start/Ziel-Ebene.', '', 'flow'); return; }
  const cells = await cellsForScope(day); if (!cells) { notice('Start/Ziel-Ebene: bitte eine Gemeinde wählen.', '', 'flow'); return; }
  clearNotice('flow');
  const list = Object.entries(cells).map(([cell, v]) => ({ cell, start: v[0], end: v[1], net: v[1] - v[0], reloc: v[3] })).filter(r => r.start + r.end > 0);
  const max = Math.max(1, ...list.map(r => Math.abs(r.net)), ...list.map(r => r.start));
  for (const r of list) {
    const [lat, lon] = cellCenterOf(r.cell);
    const col = r.net > 0 ? '#6aa9ff' : r.net < 0 ? '#ef6b6b' : '#8b949e';
    L.rectangle([[lat - CELL_LAT / 2, lon - CELL_LON / 2], [lat + CELL_LAT / 2, lon + CELL_LON / 2]], { weight: 0, fillColor: col, fillOpacity: 0.15 + 0.65 * (Math.max(Math.abs(r.net), r.start * 0.5) / max) })
      .bindPopup(`<b>Zelle</b><br>${fmt(r.start)} Fahrtbeginne · ${fmt(r.end)} Fahrtenden<br>Netto ${r.net > 0 ? '+' : ''}${fmt(r.net)} · ${fmt(r.reloc)} Umsetzungen`).addTo(L_.grid);
  }
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:#ef6b6b"></i>Netto-Abfluss (mehr Starts)</span><span><i class="dot" style="background:#6aa9ff"></i>Netto-Zufluss (mehr Ziele)</span><span class="muted">${day.split('-').reverse().join('.')} · ${fmt(list.length)} Zellen mit Bewegung</span>`;
}
async function renderServedLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const idx = await loadUsageIndex(); const st = scopeState();
  if (state.scope === 'DE' || !st) { notice('Bediente Zellen: bitte eine Gemeinde wählen.', '', 'flow'); return; }
  const days = (idx.cellDays || []).slice(-7); if (!days.length) { notice('Noch keine Zellen-Daten.', '', 'flow'); return; }
  clearNotice('flow');
  const agg = new Map();
  for (const d of days) { const doc = await loadCells(d, st); const cells = doc?.munis?.[state.scope]; if (!cells) continue; for (const [cell, v] of Object.entries(cells)) { if (!v[2]) continue; const a = agg.get(cell) || { present: 0, days: 0 }; a.present += v[2]; a.days++; agg.set(cell, a); } }
  const maxP = Math.max(1, ...[...agg.values()].map(a => a.present));
  for (const [cell, a] of agg) { const [lat, lon] = cellCenterOf(cell); L.rectangle([[lat - CELL_LAT / 2, lon - CELL_LON / 2], [lat + CELL_LAT / 2, lon + CELL_LON / 2]], { weight: 0, fillColor: '#49c7b0', fillOpacity: 0.12 + 0.6 * (a.present / maxP) }).bindPopup(`an ${a.days} von ${days.length} Tagen bedient · ${fmt(a.present)} Fahrzeug-Beobachtungen`).addTo(L_.grid); }
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:#49c7b0"></i>Zelle mit verfügbarem Fahrzeug in den letzten ${days.length} Tagen, dunkler = häufiger</span><span class="muted">${fmt(agg.size)} Zellen ≈ ${fmt(agg.size * 0.07, 1)} km²</span>`;
}
async function renderIdleLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const d = await loadOnce('idleLong', 'idle-long.json'); if (!d) return;
  const pts = d.points.filter(p => (state.scope === 'DE' || p.ags === state.scope) && (state.operator === 'all' || p.op === state.operator) && (state.type === 'all' || p.ty === state.type));
  for (const p of pts) L.circleMarker([p.lat, p.lon], { radius: 5, weight: 2, color: bgColor(), fillColor: '#e3b341', fillOpacity: .85 }).bindPopup(`<b>${esc(p.op)}</b> · ${esc(TYPE[p.ty] || p.ty)}<br>steht seit ${fmt(p.hours)} h${p.bat != null ? ` · Akku ${fmt(p.bat)} %` : ''}`).addTo(L_.grid);
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:#e3b341"></i>verfügbar, aber seit über 2 Tagen unbewegt</span><span class="muted">${fmt(pts.length)} gezeigt${d.total > d.points.length ? ` (je Gemeinde ausgedünnt, gesamt ${fmt(d.total)})` : ''} · Stand ${timeText(d.at)}</span>`;
}
// Welche Farbe gehört zu welchem Anbieter: immer unter der Karte, sortiert nach verfügbaren Fahrzeugen im Gebiet
function renderOpLegend(vehicles) {
  const n = new Map();
  if (vehicles?.length) for (const v of vehicles) { if (!v.disabled) n.set(v.operator, (n.get(v.operator) || 0) + 1); }
  if (!n.size) for (const [k, st] of Object.entries(state.latest?.groups || {})) { if (!groupInScope(k)) continue; const op = k.split('|')[1]; n.set(op, (n.get(op) || 0) + st.available); }
  const ops = [...n].sort((a, b) => b[1] - a[1]);
  $('#map-legend-ops').innerHTML = ops.length ? `<span class="muted">Anbieter</span>${ops.slice(0, 14).map(([o, c]) => `<span><i class="dot" style="background:${opColor(o)}"></i>${esc(o)} <span class="muted mono">${fmt(c)}</span></span>`).join('')}${ops.length > 14 ? `<span class="muted">+${ops.length - 14} weitere</span>` : ''}` : '';
}
async function renderZonesLayer() {
  const L_ = state.layers; L_.zones.clearLayers();
  if (!$('#chk-zones').checked) { clearNotice('zones'); $('#map-legend-zones').innerHTML = ''; return; }
  const idx = await loadOnce('zonesIndex', 'zones/index.json'); if (!idx?.zones?.length) { notice('Keine Betriebszonen in den Feeds gefunden.', '', 'zones'); return; }
  let list = idx.zones.filter(z => (state.scope === 'DE' || (z.municipalities || []).includes(state.scope)) && (state.operator === 'all' || z.operator === state.operator));
  if (state.scope === 'DE') { notice('Betriebszonen: bitte eine Gemeinde wählen (sonst zu viele Polygone).', '', 'zones'); return; }
  list = list.slice(0, 8);
  let n = 0;
  for (const z of list) {
    if (!(z.file in state.usage.zones)) { const r = await cached(`zones/${z.file}`, 60000); state.usage.zones[z.file] = r.json || null; }
    const fc = state.usage.zones[z.file]; if (!fc) continue;
    const b = state.boundaries?.features.find(x => x.properties.ags === state.scope)?.bbox;
    const inB = (f) => { if (!b) return true; const c = JSON.stringify(f.geometry.coordinates).match(/-?\d+\.\d+/g); if (!c) return true; let minX = 999, maxX = -999, minY = 999, maxY = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } return !(maxX < b[0] - .05 || minX > b[2] + .05 || maxY < b[1] - .05 || minY > b[3] + .05); };
    for (const f of fc.features.filter(inB)) {
      const ru = f.properties.rules || [];
      // GBFS 2.x: ride_allowed = Fahrt darf hier beginnen/enden; ride_through_allowed = Durchfahrt; station_parking = nur an Stationen abstellen
      const mpz = ru.some(r => r.parking === true), noRide = ru.some(r => r.rideThrough === false), noEnd = !mpz && ru.some(r => r.endAllowed === false || r.rideAllowed === false), slow = ru.find(r => r.maxSpeed != null)?.maxSpeed;
      const col = noRide ? '#ef6b6b' : noEnd ? '#e3b341' : mpz ? '#60a5fa' : slow != null ? '#c084fc' : opColor(z.operator);
      L.geoJSON(f, { style: { color: opColor(z.operator), weight: 1.5, opacity: .9, fillColor: col, fillOpacity: noRide ? .16 : .1, dashArray: (noEnd || mpz) && !noRide ? '4 3' : null } })
        .bindPopup(`<b>${esc(z.operator)}</b> · ${esc(f.properties.name || 'Zone')}<br>${noRide ? 'Fahren verboten' : 'Fahren erlaubt'}${noEnd ? ' · Abstellen verboten' : ''}${mpz ? ' · Abstellen nur an Stationen' : ''}${slow != null ? ` · max. ${fmt(slow)} km/h` : ''}`).addTo(L_.zones);
      n++;
    }
  }
  clearNotice('zones');
  const zops = [...new Set(list.map(z => z.operator))];
  $('#map-legend-zones').innerHTML = `<span class="muted">Zonen (${fmt(n)})</span><span><i class="sq" style="background:#ef6b6b55;border-color:#ef6b6b"></i>Fahrverbot</span><span><i class="sq" style="background:#e3b34133;border-color:#e3b341;border-style:dashed"></i>Abstellverbot</span><span><i class="sq" style="background:#60a5fa33;border-color:#60a5fa;border-style:dashed"></i>nur an Stationen abstellen</span><span><i class="sq" style="background:#c084fc33;border-color:#c084fc"></i>Tempolimit</span><span class="muted">Rand = Anbieter:</span>${zops.map(o => `<span><i class="sq" style="background:transparent;border-color:${opColor(o)}"></i>${esc(o)}</span>`).join('')}`;
}

// ---------- Preise, Anteile an erfassten Fahrzeugen, Zuverlässigkeit ----------
async function renderPricing() {
  const p = await loadOnce('pricing', 'pricing.json'); const tb = $('#tbl-pricing tbody');
  if (!p?.plans?.length) { tb.innerHTML = '<tr><td colspan="6" class="empty"><b>Noch keine Preisfeeds gelesen.</b>Preise erscheinen nach dem nächsten Sammler-Lauf.</td></tr>'; return; }
  let list = p.plans.filter(x => (state.scope === 'DE' || (x.municipalities || []).includes(state.scope)) && (state.operator === 'all' || x.operator === state.operator));
  const seen = new Set(); const rows = [];
  for (const src of list) for (const pl of src.plans) { const key = `${src.operator}|${pl.name}|${pl.unlock}|${pl.perMin[0]?.rate}`; if (seen.has(key)) continue; seen.add(key); rows.push({ op: src.operator, pl, src }); }
  rows.sort((a, b) => a.op.localeCompare(b.op) || (a.pl.unlock ?? 0) - (b.pl.unlock ?? 0));
  const money = (v, cur) => v == null ? '—' : esc(`${fmt(v, 2)} ${cur || '€'}`.replace(' EUR', ' €')); // Währung kommt aus dem Feed
  tb.innerHTML = rows.slice(0, 60).map(({ op, pl, src }) => `<tr><td><span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span>${state.scope === 'DE' ? `<div class="sub-line">${esc(src.sourceId)}</div>` : ''}</td><td>${esc(pl.name || pl.id)}</td><td class="n">${money(pl.unlock, pl.currency)}</td><td class="n">${pl.perMin.length ? pl.perMin.map(x => `${money(x.rate, pl.currency)}${x.interval && x.interval !== 1 ? ` je ${x.interval} Min.` : ''}${x.start ? ` ab Min. ${x.start}` : ''}`).join('<br>') : '—'}</td><td class="n">${pl.perKm.length ? pl.perKm.map(x => money(x.rate, pl.currency)).join('<br>') : '—'}</td><td class="small">${esc(pl.desc || '')}${pl.surge ? ' · dynamisch' : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty"><b>Keine Preisangaben für diesen Filter.</b>Nicht jeder Anbieter veröffentlicht Tarife; Anbieter auf „Alle“ stellen.</td></tr>';
  $('#pricing-note').textContent = rows.length > 60 ? `${rows.length - 60} weitere Tarife – Gebiet oder Anbieter wählen.` : `${rows.length} Tarife · Stand ${timeText(p.at)}`;
}
async function renderShareChart() {
  const idx = state.histIndex; const box = $('#chart-share');
  // Tagesmittel aus history/daily.json (eine Datei statt sieben Verlaufstage, Vertrag 6); alter Datenstand: Verlaufstage einzeln
  const daily = await loadDaily();
  if (daily) {
    const fi = (daily.fields || []).indexOf('available'), days = (daily.days || []).slice(-7);
    const perDay = days.map(d => { const m = new Map(); for (const [k, ser] of Object.entries(daily.series)) { const [ags, op, ty] = k.split('|'); if (ags === 'DE' || !op) continue; if (state.scope !== 'DE' && ags !== state.scope) continue; if (state.type !== 'all' && ty !== state.type) continue; const v = ser[d]; if (!v || v[fi] == null) continue; m.set(op, (m.get(op) || 0) + v[fi]); } return m.size ? m : null; });
    if (days.length && fi >= 0) return drawShare(box, days, perDay);
  }
  const days = (idx?.days || []).slice(-7);
  if (!days.length) { box.innerHTML = '<div class="empty"><b>Noch kein Verlauf.</b>Er beginnt mit dem ersten Sammler-Lauf.</div>'; return; }
  const perDay = [];
  for (const d of days) { const h = await loadHistory(d); if (!h) { perDay.push(null); continue; } const byOp = new Map(); for (const [k, ser] of Object.entries(h.series)) { const [ags, op, ty] = k.split('|'); if (ags === 'DE') continue; if (state.scope !== 'DE' && ags !== state.scope) continue; if (state.type !== 'all' && ty !== state.type) continue; const v = ser.available.filter(x => x != null); if (!v.length) continue; byOp.set(op, (byOp.get(op) || 0) + v.reduce((a, b) => a + b, 0) / v.length); } perDay.push(byOp); }
  drawShare(box, days, perDay);
}
function drawShare(box, days, perDay) {
  const ops = [...new Set(perDay.flatMap(m => m ? [...m.keys()] : []))];
  const totals = perDay.map(m => m ? [...m.values()].reduce((a, b) => a + b, 0) : 0);
  const series = ops.map(op => ({ name: op, color: opColor(op), values: perDay.map((m, i) => m && totals[i] ? ((m.get(op) || 0) / totals[i]) * 100 : null) })).sort((a, b) => (b.values.at(-1) || 0) - (a.values.at(-1) || 0)).slice(0, 8);
  const W = 900, H = 220, P = { l: 44, r: 12, t: 12, b: 26 };
  const x = (i) => P.l + (i / Math.max(1, days.length - 1)) * (W - P.l - P.r), y = (v) => P.t + (1 - v / 100) * (H - P.t - P.b);
  let g = ''; for (let k = 0; k <= 4; k++) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(k * 25)}" y2="${y(k * 25)}"/><text x="${P.l - 6}" y="${y(k * 25) + 3}" text-anchor="end">${k * 25} %</text>`;
  days.forEach((d, i) => { g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${d.slice(8)}.${d.slice(5, 7)}.</text>`; });
  const paths = series.map(s => { let d = '', open = false; s.values.forEach((v, i) => { if (v == null) { open = false; return; } d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>` + s.values.map((v, i) => v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"/>`).join(''); }).join('');
  box.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Anteil an erfassten Fahrzeugen">${g}${paths}</svg>`;
  $('#share-legend').innerHTML = series.map(s => `<span><i class="dot" style="background:${s.color}"></i>${esc(s.name)} <span class="mono">${s.values.at(-1) == null ? '—' : fmt(s.values.at(-1), 1) + ' %'}</span></span>`).join('');
}

// ---------- Konsistenz ----------
const CONS_LABEL = { consistent: ['Stimmig', 'ok'], minor: ['Kleine Abweichung', 'warn'], divergent: ['Abweichend', 'bad'], disjoint: ['Getrennte Flotten', 'info'], alt_unreachable: ['Alternative nicht erreichbar', 'muted'], error: ['Fehler', 'bad'] };
const CONS_KIND = { version: 'v2 ↔ v3 (gleicher Host)', land_vs_betreiber: 'Landesfeed ↔ Betreiber', betreiber_vs_land: 'Betreiber ↔ Landesfeed' };
const shortSrc = (id) => String(id).replace(/^mobidrom_[^:]+:source-/, 'NRW · ').replace(/^citybikes_/, 'CityBikes · ');
async function renderConsistency() {
  const c = await loadOnce('consistency', 'consistency.json'); const tb = $('#tbl-cons tbody');
  if (!c) { tb.innerHTML = '<tr><td colspan="9" class="empty"><b>Noch keine Konsistenzprüfung.</b>Sie läuft mit jedem Sammler-Lauf.</td></tr>'; return; }
  const inScope = (ids, ags) => state.scope === 'DE' ? true : (ags ? ags === state.scope : ids.some(id => (state.latest?.sources || []).find(r => r.id === id)?.municipalities?.includes(state.scope)));
  const rows = [];
  for (const e of c.systems) { if (!inScope([e.sourceId]) || (state.operator !== 'all' && e.operator !== state.operator)) continue; rows.push({ kind: `${esc(CONS_KIND[e.kind] || e.kind || 'Alternativ-Feed')}${e.idsRekeyed ? ' · Kennungen umgeschlüsselt' : ''}${e.stationsOnly ? ' · Stationen' : ''}<div class="sub-line mono">${esc(e.sourceId)}</div>`, op: e.operator, a: e.stationsOnly ? e.primary?.stations : e.primary?.vehicles, b: e.stationsOnly ? e.alt?.stations : e.alt?.vehicles, diff: e.countDiff, overlap: e.idOverlap, pm: e.posMatch, med: e.medianDistM, verdict: e.verdict, w: e.verdict === 'divergent' ? 3 : e.verdict === 'minor' ? 2 : e.verdict === 'alt_unreachable' ? 1 : 0 }); }
  for (const p of c.pairs) { if (!inScope([p.a.sourceId, p.b.sourceId], p.ags) || (state.operator !== 'all' && p.operator !== state.operator)) continue; rows.push({ kind: `Zwei Quellen · ${esc(muniName(p.ags))}${p.idsRekeyed ? ' · Kennungen umgeschlüsselt' : ''}<div class="sub-line mono">${esc(shortSrc(p.a.sourceId))} ↔ ${esc(shortSrc(p.b.sourceId))}</div>`, op: p.operator, a: p.a.vehicles, b: p.b.vehicles, diff: p.countDiff, overlap: p.idOverlap, pm: p.posMatch, med: p.medianDistM, verdict: p.verdict, w: p.verdict === 'divergent' ? 3 : p.verdict === 'minor' ? 2 : p.verdict === 'disjoint' ? 1.5 : 0 }); }
  rows.sort((x, y) => y.w - x.w || (y.a || 0) - (x.a || 0));
  const seenRow = new Set(); const uniq = rows.filter(r => { const k = r.kind.replace(/<[^>]+>/g, '') + '|' + r.op; if (seenRow.has(k)) return false; seenRow.add(k); return true; });
  rows.length = 0; rows.push(...uniq);
  const show = rows.slice(0, 80);
  tb.innerHTML = show.map(r => { const [label, cls] = CONS_LABEL[r.verdict] || [r.verdict, '']; return `<tr><td>${r.kind}</td><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span></td><td class="n">${fmt(r.a)}</td><td class="n">${fmt(r.b)}</td><td class="n">${r.diff == null ? '—' : pctf(r.diff, 1)}</td><td class="n">${r.overlap == null ? '—' : pctf(r.overlap, 1)}</td><td class="n">${r.pm == null ? '—' : pctf(r.pm, 1)}</td><td class="n">${r.med == null ? '—' : `${fmt(r.med)} m`}</td><td><span class="pill plain"${cls ? ` style="color:var(--${cls === 'muted' ? 'muted' : cls})"` : ''}>${esc(label)}</span></td></tr>`; }).join('') || emptyRow(9, 'Keine Vergleiche im Filter.', 'Vergleiche gibt es nur, wo ein System zwei Quellen hat.');
  const vc = {}; for (const r of rows) vc[r.verdict] = (vc[r.verdict] || 0) + 1;
  $('#cons-note').textContent = `${rows.length} Vergleiche · ${Object.entries(vc).map(([k, v]) => `${v} ${(CONS_LABEL[k] || [k])[0].toLowerCase()}`).join(' · ')} · Stand ${timeText(c.at)}${rows.length > show.length ? ` · ${rows.length - show.length} weitere` : ''}`;
}

const METHOD = `
<h2>Die Auswertung im Detail</h2>
<h3>Zählweise</h3><p>Verfügbar heißt buchbar: nicht reserviert, nicht gesperrt. Bei Stationen werden physischer Bestand, buchbarer Bestand (<span class="mono">is_installed</span> und <span class="mono">is_renting</span>) und Rückgabeplätze getrennt geführt; eine geschlossene Station zählt ihre Fahrzeuge nicht als verfügbar. Stationäre Quellen werden nur dann als Fahrzeugbestand addiert, wenn die Quelle keine Fahrzeugliste liefert.</p>
<h3>Frische</h3><p>Der Sammler bewertet jeden Feed beim Lauf: bis fünf Minuten Alter aktuell, bis 30 Minuten verzögert, darüber veraltet (Spalte „Status“ unter Einzelquellen). Die Übersicht zeigt das Datenalter <em>jetzt</em> – Feedalter bei der Messung plus Zeit seit dem Lauf – mit einer Definition für Kachel, Tabelle und Ampel: aktuell bis 30 Minuten (Sammler-Takt 20 Minuten plus 10), verzögert bis 60 Minuten, darüber veraltet. Veraltete und zeitlich unklare Quellen fließen nicht in Kennzahlen ein, bleiben aber als Lücke sichtbar. Positionsalter (je Fahrzeug) und Quellenalter (je Feed) sind getrennte Merkmale.</p>
<h3>Geo-Prüfung und Ortszuordnung</h3><p>Zahlenformate werden normalisiert, eindeutig vertauschte Breiten- und Längengrade korrigiert. Fehlt ein Koordinatenpaar, dient eine referenzierte Stationsposition als gekennzeichneter Ersatz. Positionen außerhalb Deutschlands oder ohne Gemeinde bleiben außen vor. Die Gemeinde ergibt sich aus GPS und BKG-Gemeindegrenze (VG250, vereinfacht ca. 30 m); ein Sammelfeed kann mehrere Orte beliefern. Die Anbieterauswahl folgt der tatsächlichen GPS-Abdeckung des gewählten Orts.</p>
<h3>Dubletten und Quellenwechsel</h3><p>Fahrzeuge desselben Anbieters werden über alle Quellen zusammengeführt: UUIDs und Quellenpräfixe werden vereinheitlicht, der jüngste Stand gewinnt, bei Gleichstand die direkte Position vor dem Stationsersatz. Gleiche Kennungen an weit entfernten Positionen (über 300 m) bleiben als Prüffälle erhalten. Stationen gelten als gleich bei gleicher Kennung oder gleichem Namen innerhalb von 60 m. Ein Fingerabdruck aus Endpunkt, Version, Feeds und Fahrzeugarten erkennt Quellenwechsel; danach beginnen Zeitvergleiche neu.</p>
<h3>Energie</h3><p>„Energie niedrig“ folgt überall derselben Regel wie die Disposition: Ladestand unter 20 % <i>und</i> Reichweite unter 5 km, wo ein Feed beides meldet; meldet er nur eines, entscheidet dieses. Anbieter, die nur Reichweite melden (Lime), zählen über die Reichweite unter 5 km; ihr aus Reichweite ÷ Maximalreichweite abgeleiteter Ladestand zählt nicht. Nenner sind die Fahrzeuge mit Energieangabe, gesperrte eingeschlossen; gezählt wird je Fahrzeug aus dem Sammler-Stand (bzw. dem Live-Abruf). Alarme ab 30 % niedriger Energie werden nach der Abweichung vom Mittel der Vortage (sonst des Tages bisher) gestuft, gemessen am Ladestand-Anteil, den die Tageswerte führen: ab 5 Punkten darüber auffällig, ab 15 kritisch, ein dauerhaft hoher Anteil bleibt ein Hinweis. Grenzen lassen sich unter Marktbild › Leistung einstellen und gelten im Live-Abruf; der Sammler rechnet mit 20 % und 5 km.</p>
<h3>Verlauf</h3><p>Der Sammler läuft alle 20 Minuten unabhängig vom Browser (GitHub Actions) und speichert bereinigte Summen je Gemeinde, Anbieter und Fahrzeugart für 30 Tage. Individuelle Fahrzeugwege werden nicht archiviert. Der Live-Abruf im Browser liest die offenen Feeds direkt; Zugangsquellen (MOBIDROM NRW) kommen als Momentaufnahme des letzten Sammler-Laufs. Δ Sammler vergleicht den Live-Stand mit dem letzten Sammler-Punkt desselben Quellen-Fingerabdrucks.</p>
<h3>Qualität</h3><p>Der Qualitätswert einer Quelle beurteilt Frische (70 %) und vorhandene Merkmale wie Energie, Zeitstempel und Fahrzeugart (30 %). Er bewertet die Quelle, nicht den Betrieb des Unternehmens. Gesperrte Fahrzeuge, leere Stationen und Niedrigakku sind Hinweise aus dem Feed; was ein Betreiber gerade bearbeitet, ist ohne internen Zugang nicht bekannt.</p>
<h3>Nutzung und Bewegung</h3><p>Der Sammler merkt sich je Fahrzeug eine gehashte Kennung mit gerundeter Position, Ladestand und Sperrstatus. Verschwindet eine Kennung zwischen zwei Läufen, zählt das als Fahrtbeginn (bei gesperrtem oder fast leerem Fahrzeug als Abholung); eine neue Kennung zählt als Fahrtende. GBFS schreibt vor, Kennungen nach jeder Fahrt zu wechseln, deshalb sind das Zählungen ohne Zuordnung von Start zu Ziel. Bei Systemen mit stabilen Kennungen (etwa stationsbasierte Räder) kehrt die Kennung zurück; dann sind Dauer und Luftlinien-Distanz messbar und werden als Ø ausgewiesen.</p>
<p><b>Fahrten.</b> Fahrten entstehen aus aufeinanderfolgenden Sammler-Läufen (≈ 20 Min.). Verschwundene und neue Kennungen eines Anbieters werden global nach Abstand und Ladestand gepaart: gleicher Ladestand (± 2 Prozentpunkte) bis 100 m, ohne Ladestand bis 40 m ist ein Kennungswechsel; ein Sprung von &lt; 40 auf ≥ 85 % am Ort ist ein Akkutausch – beides keine Fahrt. Bei stabilen Kennungen ist ein Versatz ≥ 150 m eine Fahrt, wenn Luftlinie/Laufintervall 3,5–24 km/h ergibt (sonst gesondert gezählt), außer bei Sammeltransport (≥ 3 Ankünfte ≤ 40 m), Sperrung oder ≥ 2 km ohne Ladestandverlust. Läufe nach Lücken &gt; 45 Min. zählen nicht (nach Xu et al. 2020; Ladestand-Abgleich nach Das &amp; Nicklas 2026). Stunden mit einem solchen Lauf sind im Tagesgang grau und gehen nicht in Hochrechnung und Rides/Fzg./Tag ein.</p>
<p>Ladestand springt von unter 40 % auf mindestens 85 % am selben Ort: Akkutausch; die Wartezeit misst die Zeit unter 20 % bis zum Tausch. Standzeit ist die Zeit seit der letzten Positionsänderung über 50 m (höchstens seit dem ersten Sammler-Kontakt). Quellenausfälle erzeugen keine Fahrten. Alle Werte sind Schätzungen aus 20-Minuten-Momentaufnahmen und keine Betreiberzahlen.</p>
<h3>Zellen, Zonen, Preise</h3><p>Start- und Zielzellen sind etwa 250 m groß und werden je Gemeinde und Tag gezählt; „bedient“ ist eine Zelle, in der innerhalb von 7 Tagen ein verfügbares Fahrzeug stand. Betriebszonen stammen aus <span class="mono">geofencing_zones.json</span> der Anbieterfeeds, Preise aus <span class="mono">system_pricing_plans.json</span>; beides wird je Lauf neu gelesen. Wetter kommt stündlich von Open-Meteo für den Gemeindemittelpunkt. Stations-Verfügbarkeitsquoten zählen Läufe der letzten 7 Tage, in denen eine vermietende Station kein buchbares Fahrzeug bzw. keinen freien Platz hatte.</p>
<h3>Konsistenz und Fußwege</h3><p>Hat ein System im Katalog eine zweite Adresse (Landesfeed und Betreiberfeed oder zwei GBFS-Versionen), liest der Sammler beide und vergleicht Bestand, Kennungs-Überlappung (gemeinsame ÷ alle Kennungen) und den Median-Abstand gleicher Kennungen; schlüsselt ein Verzeichnis die Kennungen um (Landesfeeds tun das), zählt stattdessen der Anteil der Fahrzeuge, zu denen in der anderen Quelle ein Fahrzeug innerhalb von 10 m steht. Liefern zwei Quellen desselben Anbieters Fahrzeuge in derselben Gemeinde, werden sie paarweise genauso verglichen; „getrennte Flotten“ heißt, dass sich die Kennungen kaum überschneiden. Fußwege in der Haltestellen-Analyse kommen vom Fußgängerprofil der FOSSGIS-Routingdienste (Valhalla, bei Ausfall OSRM auf routing.openstreetmap.de); je Haltestelle werden die zwei nächsten Fahrzeuge geroutet, der Umweg-Faktor ist Fußweg ÷ Luftlinie.</p>
<h3>Kalibrierung</h3><p>Schätzungen werden an öffentlichen Referenzwerten mit Quelle ausgerichtet (<span class="mono">data/reference.json</span>, Regeln in <span class="mono">lib/pulse-calib.js</span>); gemessene Werte bleiben immer daneben sichtbar. <b>Fahrtdauer:</b> Die Ø Fahrt eines E-Scooters ist das Mittel der Berliner Quartalswerte Q1/2025–Q1/2026 (<a href="https://www.parlament-berlin.de/adosservice/19/Haupt/vorgang/h19-2915-v.pdf" target="_blank" rel="noopener">Abgeordnetenhaus Berlin, Vorgang h19-2915</a>: 7,3 · 8,0 · 7,4 · 6,4 · 6,5 Min., Ø 7,1 Min. und 1,5 km) statt pauschal 12 Min.; die Heilbronner Dott-Daten (<a href="https://arxiv.org/abs/2606.25484" target="_blank" rel="noopener">arXiv 2606.25484</a>: Median 6,9, Mittel 8,7 Min.) dienen als Gegenprobe. Gemessene Dauer (20-Min.-Raster) gilt nur, wenn sie darunter liegt. Für Räder, E-Bikes und Lastenräder fehlen amtliche Belege; dort gelten die bisherigen Annahmen. <b>Fahrten:</b> Zwischen zwei Abrufen verschluckte Kettenfahrten und Kennungswechsel lassen die Messung zu niedrig ausfallen. Der Methodenfaktor k ist der amtliche Berliner Wert der Fahrten je E-Scooter und Tag im passenden Quartal (gleiches Quartal, sonst gleiches Kalenderquartal des Vorjahres, sonst das jüngste) geteilt durch unsere Berliner Messung über die letzten bis zu 14 Tagesdateien. k gilt für E-Scooter bundesweit und wird als „kalibriert (Berlin Qn/JJJJ)“ ausgewiesen; die Spanne folgt aus dem kleinsten und größten Berliner Quartalswert. Unter 7 Messtagen oder unter 50 % beobachteter Tagesstunden ist k vorläufig, ohne Berliner Messung entfällt die Kalibrierung. Eine eigene „Korrektur ×“ ersetzt k je Anbieter. <b>Plausibilität:</b> Liegt die gemessene Zahl der Fahrten je E-Scooter und Tag eines Anbieters in einem Gebiet über dem 1,5-Fachen des größten Berliner Quartalswerts (2,31 × 1,5 ≈ 3,5), gilt sie als Überzählung: Kalibrierung ausgesetzt, Zeile nicht in Summen. k stammt nur aus Berliner Anbietern mit plausibler Messung; aus welchen, steht am Faktor (derzeit nur Dott, eine Einschränkung). <b>Abdeckung:</b> Eigene E-Scooter ÷ amtliche Flotte – in Berlin Anteil an der genehmigten Flotte (46.450 genehmigte Fahrzeuge zum 01.04.2026; Untergrenze der Feed-Abdeckung, weil nicht alle genehmigten Fahrzeuge auf der Straße stehen), in München an der aktiven Flotte (rund 21.000 aktiv, Stand 04.11.2025; München vergibt keine Genehmigungen) – zeigt, welcher Teil des Markts in offenen Feeds steckt; eine Hochrechnung auf die amtliche Flotte steht nur im Panel „Kalibrierung“. <b>Prüfwerte ohne Faktor:</b> Frankfurt (10,49 Mio. Fahrten 2025 ÷ 365 ÷ Obergrenze 12.000 ≈ 2,4 als Untergrenze, falls die Flotte die Grenze einhält), Europa 1,6 (Fluctuo 2024) und der Voi-Konzern (2,40 Fahrten und 3,64 € Umsatz je Fahrzeug und Tag in Q4/2025, alle Märkte, inkl. E-Bikes).</p>
<h3>Grenzen</h3><p>Die offenen Feeds decken nicht alle Anbieter ab; Anteile beziehen sich immer auf die erfassten Fahrzeuge. Die Nettobilanz über zehn Minuten misst Aufbau oder Rückgang des verfügbaren Bestands; Ausleihen, Rückgaben, Reservierungen und Umverteilung haben denselben Effekt, eine Tripzahl ist daraus nicht ableitbar. Versorgungsentfernungen sind Luftlinien, sofern das Fußweg-Routing nicht aktiviert ist. Basiskarte © OpenStreetMap-Mitwirkende; Haltestellen aus OpenStreetMap (ODbL).</p>`;

// ---------- Versorgung an Haltestellen ----------
async function checkSupply() {
  const box = $('#supply');
  if (state.scope === 'DE') { box.innerHTML = '<div class="empty">Bitte eine Gemeinde wählen.</div>'; return; }
  if (!state.live) { box.innerHTML = '<div class="empty">Zuerst „Live abrufen“, damit Fahrzeugpositionen vorliegen.</div>'; return; }
  await loadBoundaries();
  const f = state.boundaries?.features.find(x => x.properties.ags === state.scope); if (!f) { box.innerHTML = '<div class="empty">Gemeindegrenze fehlt.</div>'; return; }
  const b = f.bbox; const radius = +$('#sel-radius').value; const useWalk = $('#chk-walk').checked;
  box.innerHTML = '<div class="muted small">Haltestellen werden geladen …</div>';
  const q = `[out:json][timeout:25];(node["highway"="bus_stop"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="tram_stop"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="station"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="halt"](${b[1]},${b[0]},${b[3]},${b[2]}););out body 800;`;
  let r = null;
  for (const ep of CFG.OVERPASS) { r = await getJson(`${ep}?data=${encodeURIComponent(q)}`, { timeout: 40000 }); if (r.ok && r.json?.elements) break; }
  if (!r?.ok || !r.json?.elements) { box.innerHTML = `<div class="empty">Overpass nicht erreichbar (${esc(r?.error || r?.status)}) – alle Spiegel versucht, bitte später erneut.</div>`; return; }
  const rawStops = (r.json.elements || []).filter(e => C.assignMunicipality(state.bIndex, e.lat, e.lon)?.ags === state.scope).map(e => ({ id: e.id, name: e.tags?.name || 'Haltestelle', lat: e.lat, lon: e.lon, kind: e.tags?.railway ? 'Bahn/Tram' : 'Bus' }));
  // Gegenüberliegende Haltepunkte gleichen Namens (innerhalb 80 m) zu einer Haltestelle zusammenfassen
  const stops = [];
  for (const st of rawStops) { const twin = stops.find(o => o.name === st.name && C.haversineM(o.lat, o.lon, st.lat, st.lon) <= 80); if (twin) { twin.n = (twin.n || 1) + 1; twin.lat = (twin.lat * (twin.n - 1) + st.lat) / twin.n; twin.lon = (twin.lon * (twin.n - 1) + st.lon) / twin.n; continue; } stops.push({ ...st, n: 1 }); }
  const { vehicles } = livePoints(); const avail = vehicles.filter(v => !v.disabled && !v.reserved);
  // Luftlinie: drei nächste Kandidaten je Haltestelle
  for (const s of stops) {
    const cands = [];
    for (const v of avail) { const d = C.haversineM(s.lat, s.lon, v.lat, v.lon); if (cands.length < 2 || d < cands[1].d) { cands.push({ d, v }); cands.sort((a, b) => a.d - b.d); if (cands.length > 2) cands.pop(); } }
    s.cands = cands; s.dist = cands.length ? Math.round(cands[0].d) : null; s.op = cands[0]?.v.operator || null; s.walk = null; s.walkMin = null; s.walkOp = null;
  }
  // Fußweg (OSRM, Fußgänger-Profil der FOSSGIS-Instanz): nur Haltestellen, die per Luftlinie überhaupt in Reichweite sein könnten
  let routed = 0, routeFail = 0;
  if (useWalk && stops.length) {
    const limit = Math.max(radius * 2, 1500);
    const todo = stops.filter(s => s.dist != null && s.dist <= limit).slice(0, 600);
    const batchSize = 6; // 6 Haltestellen × ≤ 12 Ziele = ein Valhalla-Aufruf (Quellen × Ziele ≤ 100)
    const batches = []; for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
    let done = 0;
    for (const batch of batches) {
      box.innerHTML = `<div class="muted small">Fußwege werden berechnet … ${done} / ${todo.length} Haltestellen (${state.walkProvider || 'Valhalla'})</div><div class="progress"><i style="width:${(done / todo.length) * 100}%"></i></div>`;
      const targets = [], targetIdx = new Map();
      batch.forEach(s => s.cands.forEach(c => { const k = `${c.v.lon.toFixed(5)},${c.v.lat.toFixed(5)}`; if (!targetIdx.has(k)) { targetIdx.set(k, targets.length); targets.push({ lat: c.v.lat, lon: c.v.lon }); } }));
      const m = await walkMatrix(batch, targets);
      if (!m) { routeFail += batch.length; done += batch.length; continue; }
      batch.forEach((s, i) => {
        let best = Infinity, bestSec = null, bestOp = null;
        for (const c of s.cands) { const j = targetIdx.get(`${c.v.lon.toFixed(5)},${c.v.lat.toFixed(5)}`); const d = m.dist?.[i]?.[j]; if (d != null && d < best) { best = d; bestSec = m.sec?.[i]?.[j]; bestOp = c.v.operator; } }
        if (Number.isFinite(best)) { s.walk = Math.round(best); s.walkMin = bestSec != null ? Math.round(bestSec / 60) : null; s.walkOp = bestOp; routed++; }
      });
      done += batch.length;
      await new Promise(res => setTimeout(res, 40));
    }
  }
  // Fußweg, sonst Luftlinie (nicht geroutet oder außerhalb des Routing-Limits)
  const eff = (s) => useWalk ? (s.walk ?? s.dist) : s.dist;
  stops.sort((a, b) => (eff(b) ?? 1e9) - (eff(a) ?? 1e9));
  const gaps = stops.filter(s => eff(s) == null || eff(s) > radius);
  state.supply = { stops, radius, useWalk, eff };
  const vals = stops.map(eff).filter(v => v != null).sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  const ratio = (() => { const pairs = stops.filter(s => s.walk != null && s.dist); return pairs.length ? pairs.reduce((a, s) => a + s.walk / s.dist, 0) / pairs.length : null; })();
  box.innerHTML = `<div class="tiles" style="margin-bottom:10px">${tile('Haltestellen', fmt(stops.length), `OSM, innerhalb ${esc(muniName(state.scope))} · ${fmt(rawStops.length)} Haltepunkte zusammengefasst`)}${tile(`Ohne Fahrzeug in ${radius} m ${useWalk ? 'Fußweg' : 'Luftlinie'}`, fmt(gaps.length), pctf(gaps.length, stops.length) + ' der Haltestellen', gaps.length / Math.max(1, stops.length) > 0.4 ? 'warn' : '')}${tile(`Median ${useWalk ? 'Fußweg' : 'Luftlinie'}`, med == null ? '—' : `${fmt(med)} m`, 'zum nächsten verfügbaren Fahrzeug')}${useWalk ? tile('Umweg-Faktor', ratio == null ? '—' : fmt(ratio, 2), `${fmt(routed)} Haltestellen geroutet (${state.walkProvider || 'Valhalla'})${routeFail ? ` · ${fmt(routeFail)} ohne Route` : ''} · Fußweg ÷ Luftlinie`) : ''}</div>
  <div class="tbl" tabindex="0" role="region" aria-label="Haltestellen ohne Fahrzeug im Radius"><table><thead><tr><th>Haltestelle</th><th>Art</th><th class="n">Luftlinie</th>${useWalk ? '<th class="n">Fußweg</th><th class="n">Gehzeit</th>' : ''}<th>Anbieter</th></tr></thead><tbody>${gaps.slice(0, 40).map(s => `<tr><td>${esc(s.name)}</td><td>${s.kind}</td><td class="n">${s.dist == null ? '—' : `${fmt(s.dist)} m`}</td>${useWalk ? `<td class="n">${s.walk == null ? `<span class="muted">${s.dist != null && s.dist > Math.max(radius * 2, 1500) ? 'außer Reichweite' : 'nicht geroutet'}</span>` : `${fmt(s.walk)} m`}</td><td class="n">${s.walkMin == null ? '—' : `${fmt(s.walkMin)} Min.`}</td>` : ''}<td>${esc((useWalk && s.walkOp) || s.op || '–')}</td></tr>`).join('')}</tbody></table></div>${gaps.length > 40 ? `<div class="muted small">${gaps.length - 40} weitere Haltestellen ohne Fahrzeug im Radius.</div>` : ''}<div class="muted small" style="margin-top:6px">${useWalk ? 'Fußwege über das Fußgängerprofil von valhalla1.openstreetmap.de, bei Ausfall routing.openstreetmap.de/OSRM (beide FOSSGIS); je Haltestelle die zwei nächsten Fahrzeuge geprüft. Haltestellen mit Luftlinie über ' + fmt(Math.max(radius * 2, 1500)) + ' m werden nicht geroutet.' : 'Luftlinie; Fußweg-Routing per Häkchen aktivierbar.'}</div>`;
}

// Fußweg-Matrix: OSRM (FOSSGIS, Fußgängerprofil), bei Ausfall Valhalla (FOSSGIS, pedestrian). Rückgabe {dist[i][j] m, sec[i][j]} oder null.
async function walkMatrix(sources, targets) {
  if (!targets.length) return null;
  const osrm = async () => {
    const coords = [...sources.map(s => `${s.lon.toFixed(6)},${s.lat.toFixed(6)}`), ...targets.map(t => `${t.lon.toFixed(6)},${t.lat.toFixed(6)}`)];
    const url = `${CFG.OSRM_FOOT}/table/v1/driving/${coords.join(';')}?sources=${sources.map((_, i) => i).join(';')}&destinations=${targets.map((_, j) => sources.length + j).join(';')}&annotations=distance,duration`;
    const r = await getJson(url, { timeout: 25000 });
    return r.ok && r.json?.code === 'Ok' ? { dist: r.json.distances, sec: r.json.durations } : null;
  };
  if (state.walkProvider === 'OSRM') return osrm();
  // Valhalla zuerst (schnelle Matrix, Quellen × Ziele ≤ 100 je Aufruf → Teilaufrufe); bei Ausfall OSRM
  const dist = [], sec = [];
  const per = Math.max(1, Math.floor(100 / targets.length));
  for (let i = 0; i < sources.length; i += per) {
    const part = sources.slice(i, i + per);
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(CFG.VALHALLA + '/sources_to_targets', { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources: part.map(s => ({ lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6) })), targets: targets.map(t => ({ lat: +t.lat.toFixed(6), lon: +t.lon.toFixed(6) })), costing: 'pedestrian', units: 'kilometers' }) });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Valhalla ${r.status}`);
      const j = await r.json();
      for (const row of j.sources_to_targets || []) { dist.push(row.map(c => c.distance == null ? null : c.distance * 1000)); sec.push(row.map(c => c.time ?? null)); }
    } catch { const m = await osrm(); if (m) state.walkProvider = 'OSRM'; return m; }
    if (i + per < sources.length) await new Promise(res => setTimeout(res, 60));
  }
  state.walkProvider = 'Valhalla';
  return { dist, sec };
}
function renderSupplyLayer() {
  const L_ = state.layers; L_.supply.clearLayers(); if (!state.supply) return;
  for (const s of state.supply.stops) { const d = state.supply.eff ? state.supply.eff(s) : s.dist; const gap = d == null || d > state.supply.radius; L.circleMarker([s.lat, s.lon], { radius: gap ? 6 : 4, weight: 2, color: gap ? '#ef6b6b' : '#6aa9ff', fillOpacity: .5 }).bindPopup(`<b>${esc(s.name)}</b> (${s.kind})<br>nächstes verfügbares Fahrzeug: ${s.dist == null ? '—' : `${fmt(s.dist)} m Luftlinie`}${s.walk != null ? ` · ${fmt(s.walk)} m Fußweg (${fmt(s.walkMin)} Min.)` : ''} ${esc(s.walkOp || s.op || '')}`).addTo(L_.supply); }
}

// ---------- Steuerung ----------
function populateScope() {
  const sel = $('#sel-scope'); const munis = state.latest?.municipalities || {};
  const byState = {};
  for (const m of Object.values(munis)) { (byState[m.state] ??= []).push(m); }
  const STATES = { BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen' };
  sel.innerHTML = '<option value="DE">Deutschlandweit</option>' + Object.keys(byState).sort((a, b) => (STATES[a] || a).localeCompare(STATES[b] || b)).map(st => `<optgroup label="${esc(STATES[st] || st)}">${byState[st].sort((a, b) => String(a.name).localeCompare(String(b.name), 'de')).map(m => `<option value="${esc(m.ags)}">${esc(m.name)}</option>`).join('')}</optgroup>`).join('');
  sel.value = state.scope;
}
function populateOperators() {
  const sel = $('#sel-operator'); const prev = state.operator;
  let ops;
  if (state.scope === 'DE') ops = [...new Set((state.latest?.sources || []).filter(r => ['live', 'delayed'].includes(r.status)).map(r => r.operator))];
  else ops = Object.keys(muniInfo(state.scope)?.operators || {});
  if (state.live) for (const [k] of state.live.groups) { const [ags, op] = k.split('|'); if (state.scope === 'DE' || ags === state.scope) ops.push(op); }
  for (const g of state.latest?.gaps || []) if (state.scope === 'DE' || muniName(state.scope) === g.city) ops.push(g.operator);
  ops = [...new Set(ops)].sort((a, b) => a.localeCompare(b, 'de'));
  sel.innerHTML = '<option value="all">Alle Anbieter vor Ort</option>' + ops.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  state.operator = ops.includes(prev) ? prev : 'all'; sel.value = state.operator;
}
function bind() {
  // Gebietswahl: Grenzen lädt erst der Live-Abruf (Ortszuordnung) bzw. die Grenz-Ebene; die Karte zeigt bis dahin die Sammler-Positionen
  $('#sel-scope').addEventListener('change', async (e) => { state.scope = e.target.value; state.live = null; state.supply = null; pendingLive = false; clearNotice('scope'); if (state.mode === 'live') state.mode = 'collector', $('#sel-mode').value = 'collector'; populateOperators(); syncUrl(); renderAll(); autoLive(); });
  $('#sel-operator').addEventListener('change', (e) => { state.operator = e.target.value; syncUrl(); renderAll(); });
  $('#sel-type').addEventListener('change', (e) => { state.type = e.target.value; syncUrl(); renderAll(); });
  $('#btn-share').addEventListener('click', copyLink);
  $('#btn-client').addEventListener('click', () => setClient(!isClient()));
  $('#econ-panel').addEventListener('change', (e) => { const i = e.target.closest('input.calib'); if (!i) return; setCalib(i.dataset.op, parseFloat(String(i.value).replace(',', '.'))); renderEcon(state.usage.day); });
  // Umschalter „kalibriert / gemessen“ (Standard kalibriert, im Browser gemerkt)
  $('#econ-panel').addEventListener('click', (e) => {
    const b = e.target.closest('#econ-mode button[data-cmode]'); if (!b) return;
    setCalibMode(b.dataset.cmode); renderEcon(state.usage.day);
  });
  window.addEventListener('resize', () => placeSeg());
  document.fonts?.ready?.then(() => placeSeg());
  // Drucken: zugeklappte Bereiche öffnen, danach wieder schließen
  window.addEventListener('beforeprint', () => $$('details:not([open])').forEach(d => { d.open = true; d.dataset.printOpened = '1'; }));
  window.addEventListener('afterprint', () => $$('details[data-print-opened]').forEach(d => { d.open = false; delete d.dataset.printOpened; }));
  $('#sel-mode').addEventListener('change', (e) => { state.mode = e.target.value; if (state.mode === 'live' && !state.live) liveFetch(); else renderAll(); });
  $('#btn-live').addEventListener('click', () => liveFetch());
  $('#btn-fit').addEventListener('click', () => fitMap(true));
  ['chk-vehicles', 'chk-stations', 'chk-muni', 'sel-layer'].forEach(id => $(`#${id}`).addEventListener('change', () => renderMap()));
  $('#chk-wfs').addEventListener('change', (e) => e.target.checked ? loadWfs() : (state.layers.wfs.clearLayers(), clearNotice('wfs')));
  $('#chk-zones').addEventListener('change', () => renderZonesLayer());
  $('#chk-weather').addEventListener('change', () => renderUsage());
  ['usage-op', 'usage-type'].forEach(id => $(`#${id}`).addEventListener('change', () => { const s = state.usage.chartSel; if (!s) return; s.op = $('#usage-op').value; s.type = $('#usage-type').value; renderUsageChart(); }));
  ['econ-min', 'econ-real', 'econ-net'].forEach(id => $(`#${id}`).addEventListener('change', () => { renderEcon(state.usage.day); renderCalibPanel().catch(e => console.error('Kalibrierung', e)); }));
  $('#usage-days').addEventListener('click', (e) => { const b = e.target.closest('[data-uday]'); if (!b) return; state.usage.day = b.dataset.uday; renderUsage(); });
  $('#btn-flow-map').addEventListener('click', () => { $('#sel-layer').value = 'flow'; location.hash = '#live'; renderMap(); window.scrollTo({ top: 0 }); });
  document.addEventListener('click', (e) => { const a = e.target.closest('.pick-cell'); if (!a) return; e.preventDefault(); $('#sel-layer').value = 'flow'; location.hash = '#live'; renderMap(); setTimeout(() => state.map.setView([+a.dataset.lat, +a.dataset.lon], 16), 300); });
  $('#in-charge').addEventListener('change', (e) => { state.thresholds.charge = +e.target.value || 20; if (state.live) recomputeLive(); renderAll(); });
  $('#in-range').addEventListener('change', (e) => { state.thresholds.range = +e.target.value || 5; if (state.live) recomputeLive(); renderAll(); });
  $('#hist-days').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (!b) return; state.histDay = b.dataset.day; renderHistory(); markDirty('signals', 'live'); });
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-more]'); if (!b || !MORE[b.dataset.more]) return; MORE[b.dataset.more].n += 100; MORE_RENDER[b.dataset.more]?.(); });
  $('#sig-filter').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; sigFilter = b.dataset.cat; renderSignals(); });
  $('#cov-search').addEventListener('input', renderCoverage); $('#cov-dir').addEventListener('change', renderCoverage);
  $('#src-search').addEventListener('input', renderSourceTable); $('#src-status').addEventListener('change', renderSourceTable);
  $('#btn-supply').addEventListener('click', checkSupply);
  $('#btn-supply-map').addEventListener('click', () => { renderSupplyLayer(); location.hash = '#live'; });
  $('#btn-csv').addEventListener('click', exportCsv);
  $('#btn-theme').addEventListener('click', () => { const cur = document.documentElement.dataset.theme; const next = cur === 'light' ? 'dark' : cur === 'dark' ? '' : 'light'; if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme; try { localStorage.setItem('mp-theme', next); } catch {} });
  document.addEventListener('click', (e) => { const a = e.target.closest('.pick-muni'); if (!a) return; e.preventDefault(); $('#sel-scope').value = a.dataset.ags; $('#sel-scope').dispatchEvent(new Event('change')); location.hash = '#live'; window.scrollTo({ top: 0 }); });
  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
}
function recomputeLive() { if (!state.live) return; state.live.groups = C.aggregateGroups(state.live.vehicles, state.live.stations, { chargeThreshold: state.thresholds.charge, rangeThreshold: state.thresholds.range }); }
function exportCsv() {
  const rows = operatorRows(); const head = ['Anbieter', 'Gebiet', 'Verfuegbar', 'Gemeldet', 'Gesperrt', 'Reserviert', 'EnergieNiedrig', 'MitEnergieangabe', 'Stationen', 'LeereStationen', 'Status', 'Datenalter_min', 'Quellen', 'Lizenz'];
  // Zellen, die mit = + - @ (oder Tab/CR) beginnen, würden in Tabellenprogrammen als Formel laufen: Text mit ' davor
  const cell = (v) => { let s = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const en = (op) => { const e = energyOfOp(op); return e.pending ? ['', ''] : [e.low, e.known]; }; // Energie niedrig nach energyLow (wie Kacheln und Disposition)
  const lines = rows.map(r => [r.op, scopeLabel(), r.st.available, r.st.total, r.st.disabled, r.st.reserved, ...en(r.op), r.st.stations, r.st.stationsEmpty, STATUS[r.status] || r.status, r.age == null ? '' : Math.round(r.age / 60e3), r.dirs.map(d => DIRS[d] || d).join('|'), r.license || ''].map(cell).join(';'));
  const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mobility-pulse_${state.scope}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function init() {
  try { const t = localStorage.getItem('mp-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  if (QS.get('kunde') === '1') { document.body.classList.add('mode-client'); $('#btn-client').setAttribute('aria-pressed', 'true'); $('#btn-share').textContent = 'Kundenlink kopieren'; }
  if (DEMO) document.body.classList.add('mode-demo');
  initMap(); bind();
  // getJsonShared: ops.js lädt ops/<Land>.json, Zonen, Zellen usw. über denselben Promise-Cache wie die Übersichtskarte
  initOps({ state, CFG, getJson: getJsonShared, esc, fmt, opColor, muniName, notice, clearNotice, loadBoundaries, loadUsageIndex, loadCells, loadOnce, loadGroups, TYPE, econFor, syncUrl });
  $$('abbr[data-gloss]').forEach(a => { a.title = GLOSS[a.dataset.gloss] || a.title; }); // Glossar-Tooltips aus einer Quelle
  // Platzhalter-Kacheln in der späteren Anzahl: die Seite springt nicht, wenn die Zahlen kommen (CLS)
  for (const [id, n] of [['#live-tiles', 5], ['#lab-tiles', 4], ['#usage-tiles', 5], ['#econ-tiles', 5], ['#cov-tiles', isClient() ? 3 : 4], ['#src-tiles', 4]]) { const el = $(id); if (el && !el.children.length) el.innerHTML = '<div class="tile skel" aria-hidden="true"><div class="l">&nbsp;</div><div class="v">–</div><div class="s">&nbsp;</div></div>'.repeat(n); }
  setView(location.hash.slice(1) || 'live');
  await loadBase();
  populateScope();
  const deep = applyUrlParams(); // Deep-Link: Gebiet, Anbieter, Fahrzeugart aus der URL
  renderAll(); syncUrl();
  if (deep) autoLive();
  if (DEMO) return; // Demo-Stand: kein Nachladen
  // Sammler-Stand alle 2 Min. prüfen; bei neuem Lauf alles neu laden (Ereignis-, Zonen- und Flottendateien inklusive)
  setInterval(async () => {
    const s = await getJson(fresh('status.json')); if (!s.ok || s.json.at === state.status?.at) return;
    const l = await getJson(fresh('latest.json')); if (!l.ok) return;
    state.status = s.json; state.latest = l.json; state.hist = {}; state.usage.docs = {}; state.usage.index = null; state.usage.cells = {}; state.usage.profile = null; state.usage.archiveDays = null; state.usage.zones = {};
    for (const k of ['idle', 'idleLong', 'quota', 'reliability', 'consistency', 'zonesIndex', 'pricing', 'runs', 'archiveIndex', 'groups']) state.usage[k] = null;
    const keepB = REQ.get('boundaries-active.json'); resetCache(); if (keepB && state.bIndex) REQ.set('boundaries-active.json', keepB); // Grenzen ändern sich nicht je Lauf
    groupsReq = null; dailyReq = null; dailyLoaded = false; state.daily = null; state.fleet.clear(); ENERGY.clear(); Ops.resetCaches?.(); Rp.resetReportCaches?.();
    const hi = await cached('history/index.json', 25000); if (hi.ok) state.histIndex = hi.json;
    populateScope(); populateOperators(); clearNotice('stale'); renderAll();
  }, 2 * 60e3);
  setInterval(renderStamp, 30e3);
}
init();
