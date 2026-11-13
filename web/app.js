import * as C from './pulse-core.js';
import * as Ops from './ops.js';
import * as E from './pulse-econ.js';
import * as K from './pulse-calib.js';
import * as Rp from './report.js';
import * as R from './pulse-report.js';
import * as Fl from './flows.js';
import * as Cov from './coverage.js';
import * as Cmp from './compare.js';
import * as Sp from './spots.js';
import * as Fv from './forecast.js';
import { mapKeys } from './mapkeys.js';
import { weatherFor } from './weather.js';
import { GROUP_MIN, GROUP_M } from './pulse-track.js';
import { t, tx, tMap, lang, setLang, onLang, applyStatic, numFmt, dateFmt, fmtLocale, suggestLang, dismissSuggestion, tIn } from './i18n.js';
import { idleClassText } from './pulse-ops.js';
const flagText = (f) => (f == null ? f : tx(f)); // Flags/Hinweise aus lib/* (deutsche Kennungstexte) in der Sprache der Seite
const { initOps, renderOps, opsFleet, applyOpsParams } = Ops;

const QS = new URLSearchParams(location.search);
const DEMO = QS.get('demo') === '1'; // eingefrorener Demo-Stand (Branch demo), ohne Live-Abruf und ohne Nachladen
const DATA_DEFAULT = DEMO ? 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/demo/' : 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/';
// ?data=… nur von erlaubter Herkunft: absoluter Pfad gleicher Herkunft, localhost/127.0.0.1 nur, wenn die Seite selbst lokal läuft (Tests),
// oder die Branches data/demo dieses Repos auf raw.githubusercontent.com (keine Commit-SHAs: GitHub liefert über den Repo-Pfad auch Commits aus Forks aus).
// Ein abweichender Datenstand steht dauerhaft als Hinweisband über den Ansichten (auch im Druck).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;
function dataOrigin(d) {
  if (!d) return null;
  try {
    const u = new URL(d, location.href);
    if (/^\/[^/\\]/.test(d) && u.origin === location.origin) return d;
    if (/^https?:$/.test(u.protocol) && LOCAL_HOST.test(u.hostname) && LOCAL_HOST.test(location.hostname)) return d;
    if (u.origin === 'https://raw.githubusercontent.com' && /^\/fcou1005\/mobility-pulse\/(data|demo)\//.test(u.pathname) && !u.search && !u.hash) return u.href;
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
// Zahlen und Zeiten im Format der Sprache (de-DE / en-GB); Formatierer je Sprache gecacht (web/i18n.js)
const fmt = (n, d = 0) => n == null || !Number.isFinite(n) ? '—' : numFmt(d).format(n);
const pctf = (a, b) => b ? `${fmt((a / b) * 100, a / b < 0.1 ? 1 : 0)} %` : t('common.na');
const ageText = (ms) => ms == null ? '–' : ms < 90e3 ? t('app.justNow') : ms < 3600e3 ? t('app.min', { v0: Math.round(ms / 60e3) }) : ms < 48 * 3600e3 ? t('app.h', { v0: fmt(ms / 3600e3, 1) }) : t('common.days', { n: Math.round(ms / 86400e3) });
// Uhrzeiten immer in Europe/Berlin (Sammler, Ereignistage und Tagesgang rechnen in Berliner Zeit), unabhängig von der Zeitzone des Browsers
const BERLIN = 'Europe/Berlin';
const timeText = (ms) => ms ? dateFmt({ hour: '2-digit', minute: '2-digit', timeZone: BERLIN }).format(new Date(ms)) : '–';
const dateTimeText = (ms, opts = { dateStyle: 'medium', timeStyle: 'short' }) => dateFmt({ timeZone: BERLIN, ...opts }).format(new Date(ms));
// Beschriftungen aus lib/pulse-core.js je Code in der Sprache der Seite (Fahrzeugart, Frische)
const TYPE = tMap('type', C.VEHICLE_TYPE_LABEL);
const STATUS = tMap('fresh', { ...C.FRESHNESS_LABEL, collector: 1 });
const DIRS = { get mobilitydata() { return t('app.mobilitydataOperators'); }, mobidata_bw: 'MobiData BW', mobidrom_nrw: 'MOBIDROM NRW', citybikes: 'CityBikes', get dott_direct() { return t('app.dottDirectFeed'); }, get lime_direct() { return t('app.limeDirectFeed'); }, get zeus_direct() { return t('app.zeusDirectFeed'); }, get bird_direct() { return t('app.birdDirectFeed'); }, db_api: 'DB API Marketplace' };
// Anbieterfarben [hell, dunkel], je Anbieter ein Farbton in beiden Themen. Auf Karten und im Streudiagramm stehen alle Anbieter einer Gemeinde
// nebeneinander, deshalb gilt dort „alle Paare“: Für jedes Paar, das in einer Gemeinde gemeinsam fährt (≥ 5 Fahrzeuge je Anbieter, latest.json
// vom 01.11.2026), besteht validate_palette.js --pairs all (Normalsicht ΔE ≥ 15, Protan/Deutan ΔE ≥ 8) hell und dunkel; Kontrast ≥ 3:1 gegen
// Fläche (#fff / #161d26) und entsättigten Kartengrund (#efefef / #1a1a1a). Anbieter, die nie zusammen fahren, dürfen sich eine Farbe teilen
// (Bolt/Zeus). Abstand zu den Statusfarben als Nebenbedingung. Suche: scratchpad pal/opt2.mjs. Unbekannte Anbieter: PAL_MORE (Hash).
const OP_COLORS = { nextbike: ['#de5778', '#f4517e'], Dott: ['#9e3a93', '#ab46a0'], Voi: ['#5d1fbe', '#9a7bf9'], Lime: ['#5285f8', '#2b62ef'], Donkey: ['#1f600c', '#258101'], Bolt: ['#15959b', '#04a3aa'], 'DB Connect': ['#7a4306', '#a35e16'], Zeus: ['#15959b', '#04a3aa'], Yoio: ['#5633a3', '#795bce'], 'swabi - augsburg': ['#9b54b6', '#9654af'], 'RegioRad Stuttgart': ['#839007', '#869225'], 'Hopp Konstanz': ['#703485', '#9a4eb6'], 'LastenVelo Freiburg': ['#9c8a04', '#9c8a04'], zeo: ['#854494', '#9c4fae'], sigo: ['#978c0d', '#9d921a'], 'LaRa to go': ['#ab63c6', '#b367d1'], 'esel.ac': ['#9c8a04', '#7e6f08'], 'AB mit Lara': ['#c066c9', '#ad53b5'], 'ALF - das Affstätter Lastenfahrrad': ['#8c1060', '#ad4d83'], 'FaRe - das Bananologen Lastenrad': ['#6a9708', '#5e8221'], 'Gülf - das Gültsteiner Lastenrad': ['#4e4092', '#7260cb'], StadtRAD: ['#be5ebc', '#cb6ac9'] };
// Reihen ohne Anbieter (Fahrzeugarten im Deutschland-Verlauf): Nachbarpaare reichen; hell die Stufen ≥ 3:1 auf Weiß (Gelb, Aqua, Magenta, Orange dunkler)
const PAL8 = { light: ['#2a78d6', '#d4572a', '#118a5f', '#a87200', '#c4517f', '#008300', '#6250d6', '#e34948'], dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] };
const PAL_MORE = { light: ['#0f8fa8', '#a0652b', '#b05090', '#5b8f2b'], dark: ['#2aa3bd', '#c48244', '#cc6fae', '#6fa02a'] };
const DISABLED_COL = '#7d8794'; // gesperrt: neutrales Grau statt Rot (Rot ist eine Anbieterfarbe)
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
const palette = (i) => PAL8[isDark() ? 'dark' : 'light'][i % 8];
function opColor(op) {
  const m = isDark() ? 1 : 0;
  if (Object.hasOwn(OP_COLORS, op)) return OP_COLORS[op][m];
  const more = PAL_MORE[m ? 'dark' : 'light'];
  return more[parseInt(C.hashStr(String(op)), 36) % more.length];
}
// Rand der Kartenpunkte in der Hintergrundfarbe (1,5 px), damit sich Punkte voneinander absetzen
const bgColor = () => getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || (isDark() ? '#161d26' : '#ffffff');
// Farbe aus einem Themen-Token (index.html :root), damit Kartenebenen hell und dunkel die passende Stufe tragen
const tok = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';
// Begriffe, die eine kurze Erklärung brauchen (als <abbr title>)
const GLOSS = {
  get rvd() { return t('app.tripsPerVehiclePerDayTvd'); },
  get util() { return t('app.shareOfTimeVehicleIsOnTrip'); },
  get real() { return t('app.shareOfListPriceThatIs'); },
  get rot() { return t('app.vehicleReappearsAtSameSpot40'); },
  get reloc() { return t('app.sameIdNeverDisappearedBut'); },
  get pickup() { return t('app.disabledOrNearlyEmpty'); },
  get cell() { return t('app.gridOfAbout250250MStarts'); },
  get calib() { return t('app.yourOwnFactorOnThisOperatorS'); },
  get empty() { return t('app.emptyNoBookableVehicleAnd'); },
  get score() { return t('app.equallyWeightedMeanOf'); },
  get fresh() { return t('app.dataAgeNowFeedAgeAt'); },
  get point() { return t('app.oneCollectorPointPerRunEvery'); },
  get gap() { return t('app.hourWithoutCollectorRunOr'); },
};
// Kundenansicht: Alltagsbegriffe statt Methodik (Sammler, Takt, Zellen, Kennungen)
const GLOSS_CLIENT = {
  get fresh() { return t('app.howOldDataIsRightNowCurrent'); },
  get point() { return t('app.oneDataPointAboutEvery20'); },
  get empty() { return t('app.emptyNoVehicleAtStationAnd'); },
  get score() { return t('app.meanOfAvailabilityFew'); },
  get gap() { return t('app.timeWithoutMeasurement'); },
};
const gl = (key) => (isClient() && GLOSS_CLIENT[key]) || GLOSS[key] || key;
const abbr = (text, key) => `<abbr title="${esc(gl(key))}">${text}</abbr>`;
const cl = (internal, client) => isClient() ? client : internal; // Text je Ansicht
// Leere Stationen: „effektiv leer“ = gemeldet leer und kein Fahrzeug ≤ 50 m; ältere Sammler-Stände kennen nur den gemeldeten Wert
const emptyTip = (s) => { const rep = s.stationsEmptyReported || s.stationsEmpty || 0, near = s.stationsEmptyNearby || 0; return near ? t('app.reportedEmptyOfWhichWith', { rep: fmt(rep), near: fmt(near), v2: C.STATION_NEAR_M ?? 50 }) : t('app.reportedEmpty', { rep: fmt(rep) }); };
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
  const ctrl = new AbortController(); const tq = setTimeout(() => ctrl.abort(), timeout);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
    let json = null, error = null;
    if (r.ok) {
      if (+(r.headers.get('content-length') || 0) > MAX_BYTES) { ctrl.abort(); error = t('app.tooLarge'); }
      else {
        try {
          let text;
          if (r.body?.getReader) {
            const reader = r.body.getReader(), dec = new TextDecoder(); let size = 0; text = '';
            for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { ctrl.abort(); throw new Error(t('app.tooLarge')); } text += dec.decode(value, { stream: true }); }
            text += dec.decode();
          } else text = await r.text();
          json = C.parseJsonSafe(text); // Fremdtext ohne HTML-Wirkung (lib/pulse-core.js safeText)
        } catch (e) { error = e.message === t('app.tooLarge') ? t('app.tooLarge') : e.name === 'AbortError' ? 'Timeout' : t('app.notJson'); }
      }
    }
    return { ok: r.ok && !!json, status: r.status, json, error, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) { return { ok: false, status: 0, json: null, error: e.name === 'AbortError' ? 'Timeout' : t('common.netCors'), latencyMs: Math.round(performance.now() - t0) }; }
  finally { clearTimeout(tq); }
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
const failedText = (file) => { const f = FAILED.get(file); return f === 404 ? t('app.fileMissing', { file }) : f ? t('app.fileNotLoadable', { file, f }) : t('app.noData'); };
const emptyRow = (cols, msg, hint = '') => `<tr><td colspan="${cols}" class="empty"><b>${esc(msg)}</b>${esc(hint)}</td></tr>`;
// Chip-Gruppe neu aufbauen, ohne dass der Tastaturfokus auf <body> fällt: der Knopf mit demselben Wert (attr) bekommt den Fokus zurück
function setChips(el, attr, html) {
  if (!el) return;
  const a = document.activeElement, v = a && el.contains(a) ? a.getAttribute(attr) : null;
  el.innerHTML = html;
  if (v != null) el.querySelector(`[${attr}="${CSS.escape(v)}"]`)?.focus();
}
// html: Text oder Funktion, die den Text liefert (Funktion = beim Sprachwechsel neu erzeugt)
// #notice ist eine höfliche Live-Region (index.html); Fehler (kind 'bad') werden zusätzlich als role="alert" sofort angesagt
function notice(html, kind = '', id = null) {
  const box = $('#notice');
  const el = id && $(`#notice [data-id="${id}"]`) || document.createElement('div');
  el.className = `note ${kind}`; if (id) el.dataset.id = id; if (kind === 'bad') el.setAttribute('role', 'alert'); else el.removeAttribute('role');
  el._html = typeof html === 'function' ? html : null; el.innerHTML = el._html ? el._html() : html; if (!el.parentNode) box.appendChild(el); return el;
}
const refreshNotices = () => $$('#notice .note').forEach(el => { if (el._html) try { el.innerHTML = el._html(); } catch (e) { console.error('Hinweis', e); } });
const clearNotice = (id) => $(`#notice [data-id="${id}"]`)?.remove();

// latest.json mit dem Zeitpunkt aus status.json als Anhang: unveränderter Lauf = gleiche Adresse, der Browser fragt nur nach (304) statt 1 MB neu zu laden
const latestUrl = (status) => (status?.at ? `${CFG.DATA}latest.json?t=${encodeURIComponent(status.at)}` : fresh('latest.json'));
async function loadBase() {
  const pSrc = cached('sources.json', 25000), pHist = cached('history/index.json', 25000);
  const pCal = cached('calendar.json', 25000).then(r => { state.calendar = r.json?.version === 1 ? r.json : null; }); // Tagtyp-Kalender (Sammler, OpenHolidays); fehlt er: lokale Feiertagsrechnung
  const status = await getJson(fresh('status.json'));
  const [latest, sources, hist] = await Promise.all([getJson(latestUrl(status.json)), pSrc, pHist]);
  state.status = status.json; state.latest = latest.json; state.histIndex = hist.json; await pCal;
  if (!latest.ok) FAILED.set('latest.json', latest.status || latest.error); // für die Leerzeilen der Tabellen
  state.catalog = sources.json || (await getJson(CFG.MAIN + 'sources.json')).json;
  const standTxt = state.status?.at ? new Date(state.status.at).toLocaleString(fmtLocale(), { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }) : '';
  if (!DEMO && state.status?.at && Date.now() - state.status.at > 45 * 60e3) notice(() => cl(t('app.lastCollectorRunIsOld', { v0: ageText(Date.now() - state.status.at), standTxt, REPO: CFG.REPO }), t('app.figuresAreOldAsOfNextUpdate', { v0: ageText(Date.now() - state.status.at), standTxt })), 'warn', 'stale');
  // Audit OPS-02: Verzeichnis ausgefallen, Quellen aus dem vorigen Katalog übernommen (Sammler: catalogFallback)
  { const cf = (state.catalog?.catalogFallback || state.latest?.catalogFallback || []).filter(x => x?.dir);
    if (cf.length && !isClient()) notice(() => t('app.catalogFallback', { dirs: esc(cf.map(x => ({ mobidrom_nrw: 'MOBIDROM NRW', mobidata_bw: 'MobiData BW', citybikes: 'CityBikes', mobilitydata: 'MobilityData' }[x.dir] || x.dir)).join(', ')), n: fmt(cf.reduce((a, x) => a + (x.n || 0), 0)), since: cf[0].since ? new Date(cf[0].since).toLocaleString(fmtLocale(), { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }) : '–' }), 'warn', 'catfb'); }
  if (DEMO) {
    const at = state.status?.at || state.latest?.at;
    const b = $('#demo-badge'); b.hidden = false; b.textContent = at ? t('app.demoSnapshotOf', { v0: new Date(at).toLocaleString(fmtLocale(), { dateStyle: 'medium', timeStyle: 'short' }) }) : t('app.demoSnapshot');
    b.title = t('app.frozenDataSnapshotNoLive');
    if (!state.latest) notice(() => t('app.demoSnapshotCannotBeLoaded'), 'warn', 'nolatest');
    return;
  }
  if (!state.latest) {
    // Ursache nennen: 404 = noch kein Stand, 200 ohne JSON = Datei beschädigt, sonst Netz/Timeout
    const f = FAILED.get('latest.json');
    notice(() => f === 404 ? t('app.collectorHasNotPublishedData', { REPO: CFG.REPO }) : f === t('app.notJson') || latest.status === 200 ? t('app.latestBroken') : t('app.latestUnreachable', { err: esc(String(f ?? latest.error ?? '')) }), f === 404 ? 'warn' : 'bad', 'nolatest');
    state.mode = 'live'; $('#sel-mode').value = 'live';
  }
}
// Gemeindegrenzen (2,5 MB) nur, wenn sie gebraucht werden: Grenz-Ebene, Live-Zuordnung, Haltestellen; Mittelpunkte kommen aus latest.json (municipalities[].c)
// Je Bundesland (boundaries/<Land>.json, bbox je Gemeinde vom Sammler vorberechnet, ≈ 1/15 der Größe): für ein Gebiet reicht sein Land;
// Gemeinden eines Landes kommen zum Bestand dazu, der Index wird neu gebaut. Ohne boundaries/index.json (älterer Datenstand) oder für
// „Deutschlandweit“: die ganze Datei wie bisher.
let boundariesReq = null; const bLands = new Map();
const bboxOf = (f) => { if (!f.bbox) { const c = JSON.stringify(f.geometry?.coordinates || []).match(/-?\d+(\.\d+)?/g) || []; let x0 = 999, y0 = 999, x1 = -999, y1 = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } f.bbox = [x0, y0, x1, y1]; } return f; };
function loadAllBoundaries() {
  return boundariesReq ??= cached('boundaries-active.json', 60000).then(r => {
    if (!r.ok) return state.bIndex || null;
    for (const f of r.json.features || []) bboxOf(f);
    state.boundaries = r.json; state.bIndex = C.buildMunicipalityIndex(r.json); state.bFull = true;
    return state.bIndex;
  });
}
function loadBoundaries(land = state.scope !== 'DE' ? scopeState() : null) {
  if (state.bFull) return Promise.resolve(state.bIndex);
  if (!land) return loadAllBoundaries();
  if (!bLands.has(land)) bLands.set(land, cached('boundaries/index.json', 25000).then(ix => {
    if (!ix.ok || !ix.json?.states?.[land]) return loadAllBoundaries();
    return cached(`boundaries/${land}.json`, 60000).then(r => {
      if (!r.ok || !Array.isArray(r.json?.features)) return loadAllBoundaries();
      if (state.bFull) return state.bIndex;
      const fc = state.boundaries || { type: 'FeatureCollection', attribution: r.json.attribution, features: [] };
      const have = new Set(fc.features.map(f => f.properties?.ags));
      for (const f of r.json.features) if (!have.has(f.properties?.ags)) fc.features.push(bboxOf(f));
      state.boundaries = fc; state.bIndex = C.buildMunicipalityIndex(fc);
      return state.bIndex;
    });
  }));
  return bLands.get(land);
}
const hasCenters = () => Object.values(state.latest?.municipalities || {}).some(m => Array.isArray(m.c));
const FC_dayOfNow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
async function loadHistory(day) {
  if (state.hist[day]) return state.hist[day];
  const r = await cached(`history/${day}.json`, 60000);
  state.hist[day] = r.json || null; return state.hist[day];
}
// Tagesmittel über bis zu 30 Tage (history/daily.json, Vertrag 6); null bei altem Datenstand
let dailyReq = null;
const loadDaily = () => dailyReq ??= cached('history/daily.json', 60000).then(r => r.ok && r.json?.days && r.json?.series ? r.json : null);
// Reihen je „Gemeinde|Anbieter“ einmal je Datei indizieren (daily.json, history/<Tag>.json; Schlüssel Gemeinde|Anbieter|Art): Signale fragen je Paar
// nach, und ein Durchlauf über alle Reihen je Paar war quadratisch (Deutschland: 723 Paare × 1.400 Reihen)
const SER_IX = new WeakMap(), SER_KEY = new WeakMap(); // SER_KEY: Reihe → Schlüssel Gemeinde|Anbieter|Art (Bruchmarken)
function seriesOf(doc, ags, op) {
  let m = SER_IX.get(doc);
  if (!m) { m = new Map(); for (const [k, ser] of Object.entries(doc?.series || {})) { const j = k.indexOf('|', k.indexOf('|') + 1); const key = j < 0 ? k : k.slice(0, j); (m.get(key) || m.set(key, []).get(key)).push(ser); if (ser && typeof ser === 'object') SER_KEY.set(ser, k); } SER_IX.set(doc, m); }
  return m.get(`${ags}|${op}`) || [];
}
// Mittel je Gemeinde|Anbieter über die vorigen Tage (ohne den gezeigten Tag): Anteil gesperrt und Anteil Energie niedrig am Bestand.
// Bruchmarke (daily.json → breaks, Zählregel geändert): Tage vor dem Bruch zählen für diese Reihe nicht im Mittel.
function dailyBaseline(daily, ags, op, excludeDay) {
  if (!daily) return null;
  const fi = Object.fromEntries((daily.fields || []).map((f, i) => [f, i]));
  if (fi.total == null) return null;
  const days = (daily.days || []).filter(d => d !== excludeDay).slice(-7);
  if (!days.length) return null;
  let total = 0, disabled = 0, low = 0, stations = 0, emptyDock = 0, n = 0;
  for (const ser of seriesOf(daily, ags, op)) {
    const bd = daily.breaks?.[SER_KEY.get(ser)] || '';
    for (const d of days) { const v = ser[d]; if (!v || d < bd) continue; n++; total += v[fi.total] || 0; disabled += v[fi.disabled] || 0; low += v[fi.lowBattery] || 0; if (fi.stations != null) { stations += v[fi.stations] || 0; emptyDock += v[fi.stationsEmptyDock ?? fi.stationsEmpty] || 0; } }
  }
  if (!n || !total) return null;
  return { days: days.length, disabled: disabled / total, low: low / total, emptyDock: stations ? emptyDock / stations : null };
}

// ---------- Scope ----------
const muniName = (ags) => state.latest?.municipalities?.[ags]?.name || state.boundaries?.features.find(f => f.properties.ags === ags)?.properties.name || ags;
const muniInfo = (ags) => state.latest?.municipalities?.[ags] || null;
function scopeLabel() { return state.scope === 'DE' ? t('app.allOfGermany') : `${muniName(state.scope)} (${muniInfo(state.scope)?.state || ''})`; }
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
    if (!gapFitsType(g)) continue; // gewählte Fahrzeugart: Lücke nur bei Anbietern dieser Art
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
// Momentaufnahme des Sammlers (snapshot/<id>.json) gibt es nur für Zugangsquellen und Quellen ohne CORS-Freigabe, die beim Lauf aktuell oder
// verzögert waren (scripts/collect.mjs); für alle anderen nicht anfragen (sonst 404 je ausgefallenem Feed)
const snapshotOf = (r, auth = false) => (r && (auth || r.auth || r.cors !== true) && (r.status == null || ['live', 'delayed'].includes(r.status))
  ? getJson(CFG.DATA + `snapshot/${r.id.replace(/[^\w.-]+/g, '_')}.json`) : Promise.resolve({ ok: false, status: 0, json: null }));
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
  const n = notice(() => `${t('app.liveFetch')} <span class="mono" id="live-prog" aria-live="off">0 / ${targets.length}</span> ${t('app.sources')} <div class="progress"><i></i></div>`, '', 'live');
  await loadBoundaries();
  const systems = new Map(), recsOut = new Map();
  let done = 0; const now = Date.now();
  const worker = async (src) => {
    try {
      const subs = recs.filter(r => r.parent === src.id);
      if (src.auth || subs.length) {
        // Zugangsquellen (MOBIDROM): Momentaufnahme des Sammlers
        for (const r of subs.length ? subs : [src]) {
          const snap = await snapshotOf(r, true);
          if (snap.ok) { systems.set(r.id, snapshotToSystem(snap.json, r)); recsOut.set(r.id, summarizeSnapshot(src, r, snap.json, now)); }
          else recsOut.set(r.id, { ...r, status: 'collector', checkedAt: r.checkedAt });
        }
        return;
      }
      const known = recs.find(x => x.id === src.id);
      if (known?.cors === false) {
        // Sammler hat festgestellt: kein CORS-Header → gar nicht erst im Browser versuchen
        const snap = await snapshotOf(known);
        if (snap.ok) { systems.set(src.id, snapshotToSystem(snap.json, src)); recsOut.set(src.id, summarizeSnapshot(src, known, snap.json, now)); return; }
        if (['live', 'delayed'].includes(known.status)) { recsOut.set(src.id, { ...known, status: 'collector', corsBlocked: true }); return; }
      }
      if (known?.candidate && !['live', 'delayed', 'stale', 'unknown'].includes(known.status)) { recsOut.set(src.id, known); return; }
      const sys = src.api === 'citybikes' ? await C.readCityBikesNetwork(src, getJson, { now }) : await C.readGbfsSystem(src, getJson, { now });
      if (sys.httpStatus === 0 && !sys.vehicles.length && !sys.stations.length) {
        // Browser darf die Quelle nicht lesen (kein CORS): Momentaufnahme des Sammlers
        const r = recs.find(x => x.id === src.id);
        const snap = await snapshotOf(r || src);
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
      const ags = m?.ags || t('app.unknown'); agsSet.add(ags);
      vehicles.push({ ...v, operator: rec.operator, sourceId: id, priority: src.priority ?? 2, ags, feedAgeMs: rec.vehicleFeedAgeMs });
    }
    for (const s of sys.stations) {
      if (!C.validLatLon(s.lat, s.lon)) continue;
      const m = state.bIndex ? C.assignMunicipality(state.bIndex, s.lat, s.lon) : null;
      const ags = m?.ags || t('app.unknown'); agsSet.add(ags);
      stations.push({ ...s, operator: rec.operator, sourceId: id, priority: src.priority ?? 2, ags, hasVehicleList: !!sys.vehicleListPresent, feedAgeMs: rec.stationFeedAgeMs });
    }
    rec.municipalities = [...agsSet];
  }
  vehicles.sort((a, b) => a.priority - b.priority);
  const dv = C.dedupeVehicles(vehicles), ds = C.dedupeStations(stations);
  // Spiegelquellen mit umgeschlüsselten Kennungen (z. B. MOBIDROM ↔ nextbike direkt): wie der Sammler die schwächere Quelle verwerfen;
  // bekannte Paare aus latest.mirrors, Paare der Konsistenzprüfung, falls geladen
  if (typeof C.dropMirrorVehicles === 'function') {
    const recOf = new Map((state.latest?.sources || []).map(r => [r.id, r]));
    const rank = (id) => { const r = recOf.get(id) || recsOut.get(id) || {}; return [r.priority ?? 2, r.parent ? 1 : 0, (r.directories || []).includes('citybikes') ? 1 : 0]; };
    const mr = C.dropMirrorVehicles(dv.vehicles, { pairs: state.usage.consistency?.pairs || [], rank, extra: state.latest?.mirrors || [] });
    dv.vehicles = mr.vehicles; dv.stats.mirrorDropped = mr.dropped.length;
  }
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
  // Kundenansicht: ohne „Sammler“ und Quellenzustände, nur wie viele Anbieter gerade keine aktuellen Daten haben
  if (failed.length) notice(() => cl(t('app.ofSourcesDeliveredNoUsable', { length: failed.length, size: recsOut.size, join: esc([...new Set(failed.map(r => STATUS[r.status] || r.status))].join(', ')) }), t('app.someOperatorsNoCurrentData', { n: fmt(new Set(failed.map(r => r.operator)).size) })), 'warn', 'livefail'); else clearNotice('livefail');
  if (!state.bIndex) notice(() => t('app.withoutMunicipalBoundaries'), 'warn', 'nob');
  state.mode = 'live'; $('#sel-mode').value = 'live';
  populateOperators(); // Live-Gruppen können Anbieter/Arten ergänzen
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
  const vehicles = (snap.vehicles || []).map(([lat, lon, type, flags, battery, range], i) => ({ rawId: `${rec.id}#${i}`, lat, lon, type, reserved: !!(flags & 1), disabled: !!(flags & 2), batteryPct: battery, rangeKm: range, geoStatus: 'ok', geoOrigin: 'vehicle', reportedAt: snap.at, positionAgeMs: Date.now() - snap.at }));
  // Reichweite wie C.readGbfsSystem für Live-Feeds (C.applyRangeChecks): konstant → unbekannt (v.rangeFlat), aus dem Ladestand gerechnet → nur der
  // Ladestand (v.rangeDerived, M-16), kleine Skala → Schwelle der Quelle (v.rangeLimitKm); der Ladestand im Schnappschuss ist schon skalengeprüft
  C.applyRangeChecks?.(vehicles);
  return {
    vehicles,
    stations: (snap.stations || []).map(([lat, lon, name, phys, bookable, docks, renting, returning], i) => ({ id: `${rec.id}#s${i}`, name, lat, lon, physicalAvailable: phys, bookable, docksAvailable: docks, renting: !!renting, returning: !!returning, installed: true, reportedAt: snap.at, typeHint: 'unknown' })),
    vehicleListPresent: (snap.vehicles || []).length > 0, feedAges: {}, errors: [], systemInfo: {},
  };
}

// ---------- Rendering ----------
// Vier Hauptbereiche; die alten Ansichten bleiben Sections und werden als Segmente gezeigt. Alte Hashes funktionieren weiter.
// „Städte“: die bundesweiten Vergleiche (Gebietsvergleich, Verfügbarkeit je Stadt, Rangliste, Dichte) aus „Leistung“ ausgelagert
const VIEWS = ['live', 'lab', 'staedte', 'usage', 'ops', 'prognose', 'prognose-spots', 'prognose-basis', 'spots', 'signals', 'coverage', 'vergleich', 'bericht', 'sources'];
const GROUPS_DEF = () => [
  { id: 'markt', label: t('app.marketView'), segs: [['live', t('app.overview')], ['lab', t('app.performance')], ['staedte', t('app.citiesSeg')], ['usage', t('app.usage')], ['coverage', t('app.coverageSeg')], ['vergleich', t('app.compare')], ['bericht', t('app.report')]] },
  { id: 'prognose', label: t('app.forecast'), segs: [['prognose', t('fv.segVerlauf')], ['prognose-spots', t('fv.segSpots')], ['prognose-basis', t('fv.segBasis')]] },
  { id: 'ops', label: t('app.operations'), segs: [['ops', t('app.operations')], ['spots', t('app.spots')]] },
  { id: 'vertrauen', label: t('app.dataTrust'), segs: [['sources', t('app.sources2')], ['signals', t('app.signals')]] },
];
const VIEW_ALIAS = { cities: 'staedte', städte: 'staedte', abdeckung: 'coverage', compare: 'vergleich', anbietervergleich: 'vergleich', report: 'bericht', kommune: 'bericht', markt: 'live', marktbild: 'live', uebersicht: 'live', disposition: 'ops', forecast: 'prognose', vorhersage: 'prognose', forecastdashboard: 'prognose', 'forecast-spots': 'prognose-spots', 'prognose-spot': 'prognose-spots', 'forecast-basis': 'prognose-basis', grundlagen: 'prognose-basis', kontrolle: 'prognose-basis', 'spot-abgleich': 'spots', spotabgleich: 'spots', vertrauen: 'sources', datenvertrauen: 'sources', datenqualität: 'sources', datenqualitaet: 'sources', qualitaet: 'sources' };
const CLIENT_HIDDEN = new Set(['usage', 'sources', 'signals', 'prognose-basis']); // Kundenansicht: ohne Schätzungen und Datenvertrauen
let currentView = 'live', urlReady = false;
const resolveView = (h) => { try { h = decodeURIComponent(h); } catch { /* Hash nicht dekodierbar: roh verwenden */ } let n = VIEW_ALIAS[h] || h; if (!VIEWS.includes(n)) n = 'live'; if (isClient() && CLIENT_HIDDEN.has(n)) n = 'live'; return n; };
// Welche Filter der Leiste in welcher Ansicht wirken; die übrigen werden ausgeblendet (Disposition und Vergleich haben eigene Auswahl im Panel)
const FILTERS = { live: 'scope op type mode', lab: 'scope op type mode', staedte: 'scope op type', usage: 'scope op type', coverage: 'scope op type', vergleich: 'scope', bericht: 'scope op type', ops: 'scope', prognose: 'scope op type', 'prognose-spots': 'scope op type', 'prognose-basis': 'scope op type', spots: 'scope', sources: 'scope op', signals: 'scope op type mode' };
let viewShown = false;
function setView(name) {
  name = resolveView(name);
  if (name !== 'usage') { const fl = document.getElementById('fl-panel'); if (fl) Fl.abortFlows?.(fl); }
  const group = GROUPS_DEF().find(g => g.segs.some(([v]) => v === name));
  const changed = viewShown && name !== currentView; viewShown = true;
  currentView = name;
  const fs = (FILTERS[name] || 'scope op type mode').split(' ');
  $$('.filters label[data-f]').forEach(l => { l.hidden = !fs.includes(l.dataset.f); });
  renderFilterSum();
  $$('section.view').forEach(s => s.classList.toggle('active', s.id === `view-${name}`));
  $$('#nav a').forEach(a => { const on = a.dataset.group === group.id; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#crumb-group').textContent = group.label;
  renderSegments(group, name);
  const segLabel = group.segs.length > 1 ? group.segs.find(([v]) => v === name)?.[1] : null;
  // Titel ohne Dopplung: gleicher Name von Gruppe und Teilansicht nur einmal
  document.title = `${segLabel && segLabel.toLowerCase() !== group.label.toLowerCase() ? `${segLabel} · ` : ''}${group.label} · Mobility Pulse`;
  if (name === 'live') setTimeout(() => { state.map?.invalidateSize(); if (!dirty.has('live')) fitMap(); }, 50);
  // nur die aktive Ansicht ist gerendert; beim Wechsel wird sie nachgezogen, wenn sich seit dem letzten Zeichnen etwas geändert hat
  if (dirty.has(name)) renderView(name);
  else if (name === 'ops') renderOps(); // prüft selbst, ob der Plan neu gerechnet werden muss
  if (name === 'live' && pendingLive && dataReady) { pendingLive = false; liveFetch(); }
  syncUrl(); scheduleToc();
  // echter Wechsel: an den Anfang der neuen Ansicht und Fokus auf ihre Überschrift (Screenreader hören den Namen der Ansicht)
  if (changed) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const h = $(`#view-${name} h1`); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }
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
  const key = `${group.id}|${isClient()}|${lang()}`;
  if (seg.dataset.key !== key) { seg.innerHTML = segs.map(([v, l]) => `<a href="#${v}" data-v="${v}">${l}</a>`).join(''); seg.dataset.key = key; seg.classList.add('instant'); }
  seg.hidden = false;
  $$('a', seg).forEach(a => { if (a.dataset.v === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  placeSeg();
  // schmale Leiste, die scrollt (statt umzubrechen): aktives Segment in den sichtbaren Bereich holen
  const cur = seg.querySelector('a[aria-current]');
  if (cur && seg.scrollWidth > seg.clientWidth + 1) seg.scrollLeft = Math.max(0, cur.offsetLeft - (seg.clientWidth - cur.offsetWidth) / 2);
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
// push: neuer Verlaufseintrag (Wechsel von Gebiet, Anbieter, Art – „Zurück“ macht ihn rückgängig); sonst wird der aktuelle Eintrag ersetzt
function syncUrl(push = false) {
  if (!urlReady) return;
  const q = new URLSearchParams(location.search);
  const inOps = currentView === 'ops';
  const op = inOps ? (opsFleet() || state.operator) : state.operator;
  const ty = inOps ? $('#ops-type').value : state.type;
  const put = (k, v) => v && v !== 'all' && v !== 'DE' ? q.set(k, v) : q.delete(k);
  put('scope', state.scope); put('op', op); put('type', ty); put('kunde', isClient() ? '1' : null); put('lang', lang() === 'de' ? null : lang());
  if (!CFG.DATA_OK) q.delete('data'); // abgelehntes ?data= nicht weitergeben
  const s = q.toString().replace(/%2F/g, '/');
  const url = `${location.pathname}${s ? `?${s}` : ''}#${currentView}`;
  try { if (push && url !== `${location.pathname}${location.search}${location.hash}`) history.pushState(null, '', url); else history.replaceState(history.state, '', url); } catch { /* file:// o. Ä. */ }
}
// Deep-Link (q = Start-URL) bzw. Zurück/Vorwärts (back: fehlende Parameter heißen Standard – Deutschland, alle Anbieter, alle Arten)
function applyUrlParams(q = QS, back = false) {
  const has = (sel, v) => v != null && [...$(sel).options].some(o => o.value === v);
  const sc = q.get('scope') ?? (back ? 'DE' : null);
  // Gebiet mit nur vereinzelten Fahrzeugen (in der Gebietswahl ausgeblendet): per Link trotzdem wählbar
  if (sc && !has('#sel-scope', sc) && state.latest?.municipalities?.[sc]) { state.scope = sc; populateScope(); }
  if (has('#sel-scope', sc)) { state.scope = sc; $('#sel-scope').value = sc; }
  else if (!back && sc && sc !== 'DE' && state.latest) notice(() => t('app.areaFromLinkIsNotInCurrent', { sc: esc(sc) }), 'warn', 'scope'); // ohne Datenstand ist der Schlüssel nicht prüfbar (Meldung dazu: nolatest)
  populateOperators();
  const op = q.get('op') ?? (back ? 'all' : null), ty = q.get('type') ?? (back ? 'all' : null);
  if (resolveView(location.hash.slice(1)) === 'ops') applyOpsParams({ op, type: ty });
  else {
    if (has('#sel-operator', op)) { state.operator = op; $('#sel-operator').value = op; }
    if (ty != null && (ty === 'all' || TYPE_FILTER.includes(ty))) state.type = ty;
    populateOperators('op'); // Liste der Arten passend zum Anbieter; passt die Art aus dem Link nicht, gilt „alle Arten“
  }
  urlReady = true;
  return state.scope !== 'DE';
}
function setClient(on) {
  document.body.classList.toggle('mode-client', on);
  $('#btn-client').setAttribute('aria-pressed', String(on));
  $('#btn-share').textContent = on ? t('app.copyClientLink') : t('app.copyLink');
  $$('abbr[data-gloss]').forEach(a => { a.title = gl(a.dataset.gloss); });
  setView(currentView); if (dataReady) renderAll(); // alle Texte in der passenden Sprache (Kunde: ohne Methodik-Begriffe)
}
// Glossar auch per Touch und Tastatur: Kürzel (abbr mit Erklärung) antippen oder mit Enter öffnen; Esc oder außerhalb tippen schließt
function bindGlossTips() {
  const mark = () => $$('abbr[title], abbr[data-gloss]').forEach(a => { if (!a.hasAttribute('tabindex')) { a.tabIndex = 0; a.setAttribute('role', 'button'); } });
  let pop = null; const close = () => { pop?.remove(); pop = null; };
  const open = (a) => {
    const txt = a.getAttribute('title') || (a.dataset.gloss ? gl(a.dataset.gloss) : ''); if (!txt) return; close();
    pop = document.createElement('div'); pop.id = 'gloss-pop'; pop.setAttribute('role', 'tooltip'); pop.textContent = txt; document.body.appendChild(pop);
    const r = a.getBoundingClientRect(), w = pop.offsetWidth;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`; pop.style.top = `${r.bottom + 6 + (r.bottom + 6 + pop.offsetHeight > innerHeight ? -(r.height + 12 + pop.offsetHeight) : 0)}px`;
  };
  document.addEventListener('click', (e) => { const a = e.target.closest('abbr[title], abbr[data-gloss]'); if (a) { e.preventDefault(); pop && pop._for === a ? close() : (open(a), pop && (pop._for = a)); } else close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('abbr')) { e.preventDefault(); e.target.click(); } });
  let tm = 0; new MutationObserver(() => { clearTimeout(tm); tm = setTimeout(mark, 200); }).observe(document.querySelector('main') || document.body, { childList: true, subtree: true }); mark();
}
// CSV für jede Tabelle (.tbl) ohne eigenen Export: Zellen als Text, Sprache wie die Oberfläche; Berichtstabellen haben eigene Exporte
function bindTableCsv() {
  const add = () => $$('.tbl:not([data-csv])').forEach(box => {
    const tb = box.querySelector('table'); if (!tb || tb.rows.length < 6 || box.closest('.rp-report')) return; box.dataset.csv = '1';
    // Panel mit eigenem CSV-Export: kein zweiter Knopf (Audit 11.11.2026, DES-16)
    const own = [...(box.closest('.panel')?.querySelectorAll('button, a[download]') || [])].some(x => !x.classList.contains('tbl-csv') && /csv/i.test(`${x.id} ${x.textContent}`));
    if (own) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tbl-csv'; b.style.cssText = 'margin:var(--s2) 0'; b.textContent = t('app.tableCsv');
    b.addEventListener('click', () => {
      // nur sichtbare Zellen (ausgeblendete Spalten wie „Δ Sammler“ oder interne Spalten der Kundenansicht fehlen sonst nur in einzelnen
      // Zeilen und verschieben alles dahinter), ohne Unterzeilen; kürzere Zeilen werden auf die Breite des Kopfs aufgefüllt (Audit UXM-01)
      const shown = (c) => !c.hidden && getComputedStyle(c).display !== 'none';
      const text = (c) => { let s = c.innerText || ''; for (const x of c.querySelectorAll('.sub-line')) s = s.replace(x.innerText || '', ' '); return s.replace(/\s+/g, ' ').trim(); };
      const rows = [...tb.rows].filter(shown).map(r => [...r.cells].filter(shown).map(text)), w = Math.max(0, ...rows.map(r => r.length));
      for (const r of rows) while (r.length < w) r.push('');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + R.toCsv(rows, lang())], { type: 'text/csv;charset=utf-8' }));
      a.download = `${(box.closest('section,[role=tabpanel]')?.id || 'tabelle')}_${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    box.before(b);
  });
  let tm = 0; new MutationObserver(() => { clearTimeout(tm); tm = setTimeout(add, 200); }).observe(document.querySelector('main') || document.body, { childList: true, subtree: true }); add();
}
async function copyLink() {
  syncUrl();
  const btn = $('#btn-share'), url = location.href; let ok = false;
  if (navigator.share && matchMedia('(pointer:coarse)').matches) { try { await navigator.share({ title: document.title, url }); return; } catch (e) { if (e?.name === 'AbortError') return; } } // Handy: nativer Teilen-Dialog, sonst Zwischenablage
  try { await navigator.clipboard.writeText(url); ok = true; } catch {
    try { const tq = document.createElement('textarea'); tq.value = url; tq.setAttribute('readonly', ''); tq.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(tq); tq.select(); ok = document.execCommand('copy'); tq.remove(); } catch { ok = false; }
  }
  btn.textContent = ok ? t('app.copied') : t('app.copyingNotPossible'); btn.classList.toggle('done', ok);
  clearTimeout(copyLink.t); copyLink.t = setTimeout(() => { btn.textContent = isClient() ? t('app.copyClientLink') : t('app.copyLink'); btn.classList.remove('done'); }, 1600);
}
// ---------- Sprache (DE | EN) ----------
// Umschalter in der Kopfleiste (auch Kundenansicht). Wechsel ohne Neuladen der Daten: statische Texte (data-i18n), Kopf, Hinweise,
// Auswahllisten, Seitentitel; alle Ansichten werden als veraltet markiert und die aktive neu gezeichnet (Karten-Popups und Legenden inklusive).
function renderLangSwitch() {
  const box = $('#lang-switch'); if (!box) return;
  box.setAttribute('aria-label', t('common.language'));
  $$('button[data-lang]', box).forEach(b => { const on = b.dataset.lang === lang(); b.setAttribute('aria-pressed', String(on)); b.tabIndex = on ? 0 : -1; });
}
function bindLangSwitch() {
  const box = $('#lang-switch'); if (!box) return;
  box.addEventListener('click', (e) => { const b = e.target.closest('button[data-lang]'); if (!b) return; setLang(b.dataset.lang); renderLangSwitch(); });
  // Pfeiltasten wie in einer Segmentgruppe: Fokus und Wahl wandern zur anderen Sprache
  box.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const bs = $$('button[data-lang]', box); const i = bs.indexOf(document.activeElement); if (i < 0) return;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length;
    e.preventDefault(); bs[j].focus(); setLang(bs[j].dataset.lang); renderLangSwitch();
  });
}
// Englischer Browser, noch keine Wahl: Vorschlag in der anderen Sprache, ablehnbar
function renderLangHint() {
  const sug = suggestLang();
  if (!sug) { clearNotice('lang'); return; }
  const el = notice(() => `<span lang="${sug}">${tIn(sug, 'common.langHint')}</span> <button type="button" class="chip" data-lang-yes="${sug}" lang="${sug}">${tIn(sug, 'common.langSwitch')}</button> <button type="button" class="chip" data-lang-no lang="${sug}">${tIn(sug, 'common.langKeep')}</button>`, '', 'lang');
  el.onclick = (e) => { const y = e.target.closest('[data-lang-yes]'); if (y) { clearNotice('lang'); setLang(y.dataset.langYes); renderLangSwitch(); } else if (e.target.closest('[data-lang-no]')) { dismissSuggestion(); clearNotice('lang'); } };
}
function onLanguage() {
  applyStatic();
  $$('abbr[data-gloss]').forEach(a => { a.title = gl(a.dataset.gloss); });
  const share = $('#btn-share'); clearTimeout(copyLink.t); share.classList.remove('done'); share.textContent = isClient() ? t('app.copyClientLink') : t('app.copyLink');
  renderLangSwitch(); clearNotice('lang'); refreshNotices();
  if (state.map && state.tiles) { const prev = state.tiles.options.attribution, next = t('app.openstreetmapContributors'); if (prev !== next) { state.tiles.options.attribution = next; state.map.attributionControl?.removeAttribution(prev).addAttribution(next); } }
  if (state.latest) { populateScope(); populateOperators(); }
  safe(() => Ops.relabelOps?.()); safe(() => Fl.relabelFlows?.()); safe(() => Cmp.relabelCompare?.(document.getElementById('cmp-panel'))); safe(() => Sp.relabelSpots?.(document.getElementById('spots-panel'))); // Disposition behält den Plan, Fahrtrouten bauen ihr Gerüst neu
  if (dataReady) { safe(renderHeader); for (const v of VIEWS) dirty.add(v); }
  setView(currentView); // Kopf, Seitentitel, Segmente; zeichnet die aktive Ansicht neu
}
// Nach neuem Datenstand oder Filterwechsel: Kopf sofort, Ansichten als veraltet markieren, nur die aktive zeichnen
// Berichtsmodul (web/report.js): bekommt die Helfer und Lader der Seite, teilt deren Cache
const rpCtx = () => ({ state, CFG, esc, fmt, getJson: getJsonShared, sharedCache: true, opColor, muniName, loadUsageIndex, loadEvents, loadHistory, loadCells,
  setScope: (ags) => { const sel = $('#sel-scope'); if (![...sel.options].some(o => o.value === ags)) return; sel.value = ags; sel.dispatchEvent(new Event('change')); },
  // einzelnen Filter der Leiste setzen (kind: scope | op | type) bzw. alle zurücksetzen; wirkt wie die Auswahl in der Leiste
  setFilter: (kind, v) => { const sel = $(kind === 'scope' ? '#sel-scope' : kind === 'op' ? '#sel-operator' : '#sel-type'); if (!sel || sel.value === v || ![...sel.options].some(o => o.value === v)) return; sel.value = v; sel.dispatchEvent(new Event('change')); },
  resetFilters: () => { for (const [id, v] of [['#sel-type', 'all'], ['#sel-operator', 'all'], ['#sel-scope', 'DE']]) { const sel = $(id); if (sel && sel.value !== v && [...sel.options].some(o => o.value === v)) { sel.value = v; sel.dispatchEvent(new Event('change')); } } } });
const rp = (fn, id) => () => { const el = document.getElementById(id); if (el) return fn(el, rpCtx()); };
VIEW_RENDER.bericht = [rp(Rp.renderReport, 'rp-report'), rp(Rp.renderForecast, 'rp-fc'), rp(Rp.renderRegulationProfile, 'rp-reg'), rp(Rp.renderCaps, 'rp-caps'), rp(Rp.renderZoneWatch, 'rp-zones'), rp(Rp.renderFeeCalculator, 'rp-fees'), rp(Rp.renderWeekHeatmap, 'rp-week'), rp(Rp.renderHotspotStability, 'rp-hot')];
VIEW_RENDER.staedte = [() => renderCities(), rp(Rp.renderAvailability, 'rp-avail'), rp(Rp.renderCityRanking, 'rp-rank'), rp(Rp.renderDensityScatter, 'rp-scatter')];
VIEW_RENDER.usage.push(rp(Fl.renderFlows, 'fl-panel'));
VIEW_RENDER.vergleich = [rp(Cmp.renderCompare, 'cmp-panel')];
const fvCtx = () => ({ ...rpCtx(), loadOnce });
VIEW_RENDER.prognose = [() => { const el = document.getElementById('fv-panel'); if (el) return Fv.renderForecastView(el, fvCtx(), { part: 'verlauf' }); }];
VIEW_RENDER['prognose-spots'] = [() => { const el = document.getElementById('fv-spots-panel'); if (el) return Fv.renderForecastView(el, fvCtx(), { part: 'spots' }); }];
VIEW_RENDER['prognose-basis'] = [() => { const el = document.getElementById('fv-basis-panel'); if (el) return Fv.renderForecastView(el, fvCtx(), { part: 'basis' }); }];
VIEW_RENDER.spots = [() => { const el = document.getElementById('spots-panel'); if (el) return Sp.renderSpots(el, { ...rpCtx(), loadOnce }); }]; // Spot-Abgleich braucht dazu stations-quota und Zonen-Index
VIEW_RENDER.sources.push(rp(Cov.renderCoverage, 'cov-panel'), rp(Rp.renderFeedChecks, 'rp-feedchecks'), rp(Rp.renderPriceLog, 'rp-pricelog'), () => renderCalibPanel());
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
  if (pill) { pill.textContent = !at ? t('app.asOf') : live ? `Live ${timeText(at)}` : t('app.ago', { v0: cl(t('app.collector'), t('app.asOf2')), at: timeText(at), v2: ageText(Date.now() - at) }); pill.classList.toggle('stale', !live && !DEMO && !!at && Date.now() - at > 45 * 60e3); pill.title = at ? t('app.dataAsOf', { v0: new Date(at).toLocaleString(fmtLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }) }) : ''; }
  const el = $('#side-stamp'); if (!el) return;
  el.textContent = state.latest ? t('app.sourcesMunicipalities', { v0: fmt(state.latest.counts?.sources), v1: fmt(state.latest.counts?.municipalitiesShown ?? state.latest.counts?.municipalities) }) : cl(t('app.collectorNoRunYet'), t('app.noDataYet'));
}
function renderHeader() {
  $('#crumb-scope').textContent = scopeLabel();
  // Auswahl zeigt den tatsächlich gezeigten Stand samt Uhrzeit
  const sm = $('#sel-mode'); sm.value = state.mode === 'live' && state.live ? 'live' : 'collector';
  sm.options[0].textContent = state.latest ? t('app.collectorSnapshot2', { v0: timeText(state.latest.at) }) : t('app.collectorSnapshotEvery20Min');
  sm.options[1].textContent = state.live ? t('app.liveFetch2', { v0: timeText(state.live.at) }) : t('app.liveFetchInBrowser');
  renderStamp();
  const h = dataHealth();
  const el = $('#filter-count');
  const showAge = h.staleRun && !$('#notice [data-id="stale"]'); // das Hinweisband „Sammler-Lauf alt“ nennt das Alter schon; die Zeile wiederholt es nur ohne Band
  // Veralteter Stand: keine Abdeckungszahlen („0 von 290 nutzbar“ wäre nur das Alter in anderer Form), sondern eine klare Aussage; ab 6 Std. rot
  const lvl = h.staleRun ? (Date.now() - state.latest.at > 6 * 36e5 ? 'bad' : 'warn') : h.level, head = h.staleRun ? t('ux.dataStale') : h.label;
  const age = showAge ? ` · ${t(isClient() ? 'app.dataOld' : 'app.collectorRunOld', { v0: ageText(Date.now() - state.latest.at) })}` : '';
  const counts = !isClient() && !h.staleRun && h.counted ? ` · ${t('app.ofReachableSourcesCurrent', { usable: fmt(h.usable), fresh: fmt(h.fresh), counted: fmt(h.counted) })}` : '';
  el.innerHTML = `<span class="health ${lvl}"><i></i>${head}${counts}${age}</span>`;
  el.title = isClient() ? gl('fresh') : h.detail;
  renderAttribution(); renderFilterSum();
}
// Ampel zur Datenlage im Gebiet: nicht erreichbare Quellen und geprüfte Kandidaten ohne Feed zählen nicht als Fehler; ebenso Dubletten
// (gleiches System über eine zweite Adresse) und länger als 14 Tage verschwundene Quellen (retired)
const NOT_COUNTED = new Set(['gone', 'foreign', 'duplicate', 'retired']);
function dataHealth() {
  const recs = sourcesForScope().map(r => liveRec(r.id) || r);
  const eff = recs.map(effStatus);
  const by = {}; for (const e of eff) by[e.status] = (by[e.status] || 0) + 1;
  const counted = eff.filter((e, i) => { const r = recs[i]; return !NOT_COUNTED.has(e.status) && !(r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(e.status)); });
  const fresh = counted.filter(e => e.status === 'live').length, delayed = counted.filter(e => e.status === 'delayed').length, stale = counted.filter(e => e.status === 'stale').length;
  const usable = counted.filter(e => USABLE.has(e.status)).length;
  const staleRun = !DEMO && !!state.latest && !(state.mode === 'live' && state.live) && Date.now() - state.latest.at > 45 * 60e3;
  const ratio = counted.length ? usable / counted.length : 0;
  let level = !counted.length ? 'none' : ratio >= 0.8 ? 'ok' : ratio >= 0.5 ? 'warn' : 'bad';
  if (staleRun && level === 'ok') level = 'warn';
  const label = { ok: t('app.dataCoverageGood'), warn: t('app.dataCoverageLimited'), bad: t('app.dataCoverageWeak'), none: state.latest ? cl(t('app.noSourcesInArea'), t('app.noDataInArea')) : cl(t('app.noCollectorSnapshotYet'), t('app.noDataYet')) }[level];
  const detail = t('app.sourcesInAreaCurrentDataAge', { length: recs.length, v1: Object.entries(by).map(([k, v]) => `${v} ${STATUS[k] || k}`).join(' · '), v2: state.live ? ` · ${t('app.liveDuplicatesRemoved', { duplicates: state.live.dedupe.duplicates })}` : '' });
  return { level, label, fresh, delayed, stale, usable, counted: counted.length, staleRun, detail };
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
    foot.innerHTML = `<span>${t('app.data', { v0: esc([...shown, rest > 0 ? t('app.more', { rest }) : null].filter(Boolean).join(', ') || t('app.loadingCollectorSnapshot')), v1: dirs.length ? ` · ${t('app.via', { join: esc(dirs.join(', ')) })}` : '', v2: cl(t('app.licencePerSourceUnderData'), t('app.useSubjectToOperators')) })}</span>`
      + `<span>${t('app.municipalBoundariesVg250DlDe', { v0: esc(state.latest?.boundaries?.attribution?.replace(/\s*\(.*\)\s*$/, '') || '© GeoBasis-DE / BKG') })}</span>`
      + `<span>${t('app.mapsOpenstreetmap')}</span>`
      + `<span class="foot-legal">${t('app.legalLinks')}</span>`
      + `<details class="foot-privacy"><summary>${t('app.privacyTitle')}</summary><div class="foot-privacy-body">${t('app.privacyBody', { flowMin: 5, cellMin: 3 })}</div></details>`;
    foot.title = names.join('\n');
  }
  if (state.map?.attributionControl) {
    const short = t('maps.attribData', { src: [...names.slice(0, 4), names.length > 4 ? `+${names.length - 4}` : null, ...extra].filter(Boolean).map(esc).join(', ') });
    if (state.mapAttrib) state.map.attributionControl.removeAttribution(state.mapAttrib);
    state.mapAttrib = short; state.map.attributionControl.addAttribution(short);
  }
}
function tile(l, v, s, cls = '', title = '') { return `<div class="tile ${cls}"${title ? ` title="${esc(title)}"` : ''}><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
// Kernaussage über den Kacheln der Übersicht
function renderLede() {
  const el = $('#live-lede'); if (!el) return;
  if (!state.latest && !state.live) { el.textContent = t('app.noDataSnapshotLoadedYet'); return; }
  const st = sumStats([...scopeGroups().values()]); const h = dataHealth();
  const sig = computeSignals().filter(s => s.sev !== 'info').length;
  const place = state.scope === 'DE' ? t('app.germany') : muniName(state.scope);
  const filt = [state.operator !== 'all' ? state.operator : null, state.type !== 'all' ? TYPE[state.type] : null].filter(Boolean).join(', ');
  const dataTxt = h.level === 'ok' ? t('app.dataCurrent') : h.staleRun ? t('app.old', { v0: cl(t('app.collectorSnapshot'), t('app.data2')), v1: ageText(Date.now() - state.latest.at) }) : h.level === 'warn' ? t('app.dataPartlyDelayed') : h.level === 'bad' ? t('app.dataIncomplete') : cl(t('app.noSources'), t('app.noData2'));
  const sigTxt = `${fmt(sig)} ${sig === 1 ? t('app.anomaly') : t('app.anomalies')}`;
  el.innerHTML = `${t('app.vehiclesAvailable', { place: esc(place), v1: filt ? ` · ${esc(filt)}` : '', available: fmt(st.available), v3: st.total ? t('app.disabled', { disabled: pctf(st.disabled, st.total) }) : t('app.noVehicleData'), v4: isClient() ? sigTxt : `<a href="#signals">${sigTxt}</a>` })} · <span class="health ${h.level}" title="${esc(isClient() ? gl('fresh') : h.detail)}"><i></i>${dataTxt}</span>`;
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
    tile(t('app.availableBookable'), fmt(st.available), t('app.reportedReserved', { total: fmt(st.total), reserved: fmt(st.reserved) })),
    tile(t('app.disabled2'), fmt(st.disabled), `${st.total ? t('app.ofFleet', { disabled: pctf(st.disabled, st.total) }) : t('app.noVehicleData')}${ghostsInScope() ? ` · ${t('app.orphaned', { ghostsInScope: fmt(ghostsInScope()) })}` : ''}`, st.total && st.disabled / st.total > 0.15 ? 'warn' : ''),
    tile(t('app.stationsWithVehicles'), `${fmt(st.stationsRenting - st.stationsEmpty)} <small>/ ${fmt(st.stations)}</small>`, st.stations ? t('app.emptyFull', { stationsEmpty: fmt(st.stationsEmpty), v1: dockKnown ? ` ${t('app.docksZonesParen', { docks: fmt(st.stationsEmptyDock), zones: fmt(st.stationsEmptyVirtual) })}` : '', stationsFull: fmt(st.stationsFull) }) : t('app.noStationsInArea'), '', st.stations ? emptyTip(st) : ''),
    tile(t('app.lowEnergy'), energyVal(en), energySub(en), lowE > 0.3 ? 'warn' : ''),
    // ein Nenner mit der Kopfzeile (dataHealth: ohne Dubletten, verschwundene, Ausland), Farbe aus derselben Ampel (Audit UXM-08/DES-11)
    (() => { const hh = dataHealth(), notCounted = recs.length - hh.counted;
      return tile(cl(t('app.sources2'), t('app.dataFreshness')), `${fmt(hh.usable)} <small>/ ${fmt(hh.counted)}</small>`, t('app.currentDelayedStale', { length: hh.fresh, length2: hh.delayed, length3: hh.stale, v3: (gaps ? ` · ${gaps} ${cl(gaps > 1 ? t('app.dataGaps') : t('app.dataGap'), t('app.operatorsWithoutData'))}` : '') + (notCounted > 0 && !isClient() ? ` · ${t('app.sourcesNotCounted', { all: fmt(recs.length), n: fmt(notCounted) })}` : '') }), hh.level === 'bad' ? 'bad' : hh.level === 'warn' ? 'warn' : '', gl('fresh')); })(),
  ].join('');
  // Tabelle: „Δ Sammler“ nur, wenn es etwas zeigt (Live-Abruf mit Abweichung); Lizenzen stehen unter Datenvertrauen › Quellen
  const showDelta = rows.some(r => r.delta && r.delta.diff !== 0);
  const tbl = $('#tbl-operators'); tbl.classList.toggle('no-delta', !showDelta);
  $$('th', tbl).forEach((th, i) => { if (i === 4) th.hidden = !showDelta; });
  const cols = 9 - (showDelta ? 0 : 1);
  $('#tbl-operators tbody').innerHTML = rows.map(r => {
    const s = r.st;
    const d = r.delta ? `<span style="color:var(--${r.delta.diff > 0 ? 'ok' : r.delta.diff < 0 ? 'bad' : 'muted'})">${r.delta.diff > 0 ? '+' : ''}${fmt(r.delta.diff)}</span><div class="sub-line">${ageText(r.delta.sinceMs)}</div>` : '—';
    if (r.gap) return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line">${t('app.since', { city: esc(r.gap.city), since: esc(r.gap.since) })}</div></td><td colspan="${cols - 2}" class="sub-line">${esc(r.gap.note)}</td><td><span class="pill gap">${t('app.dataGap2')}</span></td></tr>`;
    const e = energyOfOp(r.op);
    const eCell = e.pending ? '…' : !e.known ? t('common.na') : `${energyVal(e)}<div class="sub-line">${t('app.withData', { known: fmt(e.known), v1: e.rangeOnly === e.known ? ` · ${t('app.rangeOnly')}` : e.rangeOnly ? ` · ${t('app.rangeOnly2', { rangeOnly: fmt(e.rangeOnly) })}` : '' })}</div>`;
    return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line internal">${r.sources.length} ${r.sources.length === 1 ? t('app.source') : t('app.sources')}${r.changed ? ` · ${t('app.sourceChange')}` : ''}${r.sources.some(x => x.snapshot) ? ` · ${t('app.collectorSnapshot3')}` : ''}${r.sources.some(x => x.status === 'collector') ? ` · ${t('app.collectorSnapshot')}` : ''}</div></td>
      <td class="internal">${r.dirs.map(dirLabel).join(' · ') || '–'}<div class="sub-line">${t('app.quality100', { v0: esc(r.quality ?? '–') })}</div></td>
      <td class="n">${fmt(s.available)}<div class="sub-line">${t('app.reported', { total: fmt(s.total) })}</div></td><td class="n">${fmt(s.disabled)}</td>${showDelta ? `<td class="n">${d}</td>` : ''}
      <td class="n">${eCell}</td>
      <td class="n"${s.stations ? ` title="${esc(emptyTip(s))}"` : ''}>${s.stations ? `${fmt(s.stationsEmpty)} / ${fmt(s.stations)}` : '—'}</td><td class="n">${ageText(r.age)}</td>
      <td>${isClient() && r.status === 'collector' ? `<span class="pill live">${t('app.asOf2')}</span>` : pillStatus(r.status)}</td></tr>`;
  }).join('') || emptyRow(cols, t('app.noOperatorsInSelectedFilter'), state.operator !== 'all' || state.type !== 'all' ? t('app.setOperatorAndVehicleTypeTo') : state.scope === 'DE' ? (state.latest ? cl(t('app.noDataInCollectorSnapshot'), t('app.noData3')) : failedText('latest.json')) : cl(t('app.chooseAnotherAreaOrFetchLive'), t('app.chooseAnotherArea')));
  renderBriefing(rows, st);
  renderLede();
  renderMap();
}
// Verwaiste Einträge (gesperrt, > 7 Tage ohne Signal) der Quellen im Gebiet/Anbieter-Filter
function ghostsInScope() { return sourcesForScope().filter(r => state.operator === 'all' || r.operator === state.operator).reduce((a, r) => a + (r.counts?.ghosts || 0), 0); }
// Briefing: je Karte Zahl + eine Zeile, Begründung unter „Warum?“
// Handlungsbedarf zuerst: kritisch/auffällig; Hinweise füllen nur auf, wenn weniger als vier übrig sind. Kundenansicht ohne Datenqualität (interne Quellenlage).
function renderBriefing() {
  const all = computeSignals().filter(s => !(isClient() && s.cat === 'data'));
  const act = all.filter(s => s.sev !== 'info');
  const items = [...act, ...all.filter(s => s.sev === 'info')].slice(0, 4);
  $('#briefing').innerHTML = items.length ? items.map(s => sigCard(s, true)).join('') : `<div class="empty">${t('app.noNotableSignalsInAreaFleet')}</div>`;
}

// ---------- Karte ----------
const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function initMap() {
  const map = L.map('map', { preferCanvas: true, zoomControl: true, zoomAnimation: !REDUCED(), fadeAnimation: !REDUCED(), markerZoomAnimation: !REDUCED() }).setView([51.1, 10.4], 6);
  state.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('app.openstreetmapContributors') }).addTo(map);
  state.map = map; mapKeys(map); // Tastatur: N/P durch die Objekte im Ausschnitt, Enter wie Klick (web/mapkeys.js)
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
  // Felder 10–13 wie lib/pulse-ops.js decodeFleet: reichweiteAbgeleitet, reichweiteSchwelleKm, reichweiteKonstant, standzeitMindestens (fehlend am Zeilenende = null)
  const vehicles = (doc?.vehicles || []).map(([lat, lon, op, ty, flags, bat, range, idle, m, rd, rl, rf, ic]) => ({ lat, lon, operator: doc.ops?.[op], type: doc.types?.[ty] ?? 'unknown', reserved: !!(flags & 1), disabled: !!(flags & 2), batteryPct: bat ?? null, rangeKm: range ?? null, idleMin: idle, idleCensored: ic === 1, ags: doc.munis?.[m], positionAgeMs: pos, geoOrigin: 'vehicle', rangeDerived: rd === 1, rangeLimitKm: Number.isFinite(rl) ? rl : null, rangeFlat: rf === 1 })).filter(v => C.validLatLon(v.lat, v.lon));
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
    $('#map-title').textContent = t('app.map', { v0: scopeLabel() });
    $('#map-sub').textContent = layerMode === 'flow' ? t('app.tripStartsAndEndsPerCell') : layerMode === 'served' ? t('app.cellsWithAvailableVehicle') : t('app.availableVehiclesThatHaveNot');
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
    $('#map-title').textContent = t('app.map', { v0: scopeLabel() });
    const step = Math.max(1, Math.ceil(vehicles.length / CFG.MAX_POINTS));
    let drawn = 0;
    if (layerMode === 'points') {
      if ($('#chk-vehicles').checked) for (let i = 0; i < vehicles.length; i += step) {
        const v = vehicles[i]; drawn++;
        const col = v.disabled ? DISABLED_COL : opColor(v.operator), dim = state.mapFocus && state.mapFocus !== v.operator; // Legende: ein Anbieter hervorgehoben
        L.circleMarker([v.lat, v.lon], { radius: 4.5, weight: 2, color: bg, fillColor: col, fillOpacity: dim ? .12 : v.disabled ? .7 : .95, opacity: dim ? .2 : 1 })
          .bindPopup(`<b>${esc(v.operator)}</b> · ${esc(TYPE[v.type] || v.type)}<br>${v.disabled ? t('app.disabled3') : v.reserved ? t('common.reservedLc') : t('app.available')}${v.batteryPct != null ? ` · ${t('app.battery', { batteryPct: fmt(v.batteryPct) })}` : ''}${v.rangeKm != null ? ` · ${fmt(v.rangeKm, 1)} km` : ''}${v.idleMin != null ? ` · ${t(v.idleCensored ? 'trk.idleForAtLeast' : 'app.idleFor', { v0: idleClassText(v.idleMin, { en: lang() === 'en', atLeast: v.idleCensored }) })}` : ''}<br><span class="muted">${t('app.position', { v0: ageText(v.positionAgeMs), v1: isClient() ? '' : ` · ${v.geoOrigin === 'station' ? t('app.stationPositionAsFallback') : 'GPS'}${v.reusedId ? ` · ${t('app.idReused')}` : ''}${src === coll ? ` · ${t('app.collectorSnapshot')}` : ''}` })}</span>`).addTo(L_.vehicles);
      }
      if ($('#chk-stations').checked) for (const s of stations) {
        // gemeldet leer, aber Fahrzeuge desselben Anbieters ≤ 50 m daneben: faktisch versorgt. Leer = gestrichelter Rand ohne Füllung (Form statt
        // eigener Farbe: die Anbieterfarbe bleibt die Identität, die Warnfarbe kollidierte mit Dott)
        const near = s.nearbyVehicles || 0, empty = s.renting !== false && (s.bookable ?? 0) === 0 && !near, dim = state.mapFocus && state.mapFocus !== s.operator;
        L.rectangle([[s.lat - .00035, s.lon - .0005], [s.lat + .00035, s.lon + .0005]], { weight: 2, color: opColor(s.operator), opacity: dim ? .2 : 1, dashArray: empty ? '3 3' : null, fillOpacity: empty || dim ? 0 : .25 })
          .bindPopup(`${t('app.physicalBookableDocks', { v0: esc(s.name || t('app.station')), operator: esc(s.operator), physicalAvailable: fmt(s.physicalAvailable), bookable: fmt(s.bookable), docksAvailable: fmt(s.docksAvailable), v5: near ? t('app.withinM', { near: fmt(near), v1: near === 1 ? t('app.vehicle') : t('app.vehicles'), v2: C.STATION_NEAR_M ?? 50 }) : '', v6: s.nearbyOther ? `<br><span class="muted">${t('app.plusFromOtherOperators', { nearbyOther: fmt(s.nearbyOther), join: esc((s.nearbyOtherOps || []).join(', ')) })}</span>` : '' })}<span class="muted">${s.renting === false ? t('app.rentalDisabled') : t('app.renting')} · ${s.returning === false ? t('app.returnDisabled') : t('app.returnPossible')}</span>`).addTo(L_.stations);
      }
      // Anbieterfarben stehen einmal, nach Bestand sortiert, in #map-legend-ops (renderOpLegend); hier nur Zustände und Formen
      legend.push(`<span><i class="dot" style="background:${DISABLED_COL}"></i>${t('app.disabled3')}</span>`, `<span><i class="sq"></i>${t('app.station')}</span>`, `<span><i class="sq" style="border-style:dashed;background:transparent"></i>${t('app.stationEmptyNoVehicleM', { v0: C.STATION_NEAR_M ?? 50 })}</span>`, `<span class="muted">${t('app.vehiclesDrawn', { drawn: fmt(drawn), length: fmt(vehicles.length), v2: step > 1 ? ` ${t('app.thinnedOut')}` : '' })}</span>`);
    } else {
      // grobes Raster 0,0045° × 0,007° ≈ 500 × 500 m (Text: i18n FIXED.CELL500)
      const cells = new Map();
      // Energie niedrig wie überall (energyLow): Grenzen des Live-Abrufs bzw. des Sammlers, je nachdem woher die Positionen stammen
      const lim = src === coll ? { charge: state.latest?.thresholds?.chargeThreshold ?? R.ENERGY_CHARGE, range: state.latest?.thresholds?.rangeThreshold ?? R.ENERGY_RANGE_KM } : { charge: state.thresholds.charge, range: state.thresholds.range };
      for (const v of vehicles) { if (v.disabled) continue; const k = `${Math.round(v.lat / 0.0045)}:${Math.round(v.lon / 0.007)}`; const c = cells.get(k) || { lat: Math.round(v.lat / 0.0045) * 0.0045, lon: Math.round(v.lon / 0.007) * 0.007, n: 0, low: 0, known: 0 }; c.n++; const lw = R.energyLow(v.batteryPct, v.rangeKm, { ...lim, rangeOnly: rangeOnly(v.operator) || !!v.batteryDerived, rangeDerived: !!v.rangeDerived, rangeLimit: v.rangeLimitKm ?? null, rangeFlat: !!v.rangeFlat, type: v.type }); if (lw != null) { c.known++; if (lw) c.low++; } cells.set(k, c); }
      const max = Math.max(1, ...[...cells.values()].map(c => layerMode === 'energy' ? c.low : c.n));
      for (const c of cells.values()) {
        const val = layerMode === 'energy' ? c.low : c.n; if (!val) continue;
        const a = 0.15 + 0.7 * (val / max);
        L.rectangle([[c.lat - .00225, c.lon - .0035], [c.lat + .00225, c.lon + .0035]], { weight: 0, fillColor: layerMode === 'energy' ? tok('--warn') : tok('--accent'), fillOpacity: a })
          .bindPopup(layerMode === 'energy' ? t('app.vehiclesWithLowEnergyCharge', { low: fmt(c.low), charge: fmt(lim.charge), range: fmt(lim.range), known: fmt(c.known) }) : t('app.availableVehiclesInThisCell', { n: fmt(c.n) })).addTo(L_.grid);
      }
      legend.push(`<span>${t('app.perDarkerMoreMax', { v0: layerMode === 'energy' ? t('app.lowEnergyChargeAndRangeKm', { charge: fmt(lim.charge), range: fmt(lim.range) }) : t('app.availableVehicles'), v1: cl(t('app.cellCoarse'), t('app.areaOfAbout500500M')), max: fmt(max) })}</span>`);
    }
    if (src === coll) legend.push(`<span class="muted">${cl(t('app.collectorSnapshotFetchLive', { v0: timeText(coll.at) }), t('app.asOf3', { v0: timeText(coll.at) }))}</span>`);
  } else {
    // Sammler-Stand ohne Positionen: Gemeinde-Blasen (Mittelpunkte aus latest.json, sonst aus den Grenzen)
    $('#map-title').textContent = state.scope === 'DE' ? t('app.mapOfGermany') : t('app.map', { v0: scopeLabel() });
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
        .bindPopup(`${t('app.availableReported', { v0: esc(munis[m.ags]?.name || m.ags), v1: esc(munis[m.ags]?.state || ''), available: fmt(m.available), total: fmt(m.total), v4: Object.entries(m.ops).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${esc(o)} ${fmt(n)}`).join(' · ') })}<a href="#live" data-ags="${esc(m.ags)}" class="pick-muni">${t('app.openPlace')}</a>`).addTo(L_.bubbles);
    }
    const loading = state.scope !== 'DE' && state.fleet.get(scopeState()) === 'loading';
    legend.push(`<span>${t('app.bubbleAvailableVehiclesPer', { v0: cl(t('app.collectorSnapshot'), t('app.asOf2')), v1: timeText(state.latest?.at) })}</span>`, `<span class="muted">${loading ? t('app.loadingVehiclePositions') : state.scope === 'DE' ? t('app.chooseMunicipalityForVehicle') : cl(t('app.fetchLiveForVehiclePositions'), '')}</span>`);
  }
  renderMuniLayer();
  $('#map-legend').innerHTML = legend.join('');
  renderOpLegend(vehicles);
  $('#map-sub').textContent = src ? t('app.vehiclesStations', { length: fmt(vehicles.length), length2: fmt(stations.length), v2: src === live ? `Live ${timeText(state.live.at)}` : `${cl(t('app.collectorSnapshot'), t('app.asOf2'))} ${timeText(coll.at)}` }) : t('app.vehiclesAndStations');
  fitMap();
  if ($('#chk-wfs').checked) loadWfs();
  renderZonesLayer();
  if (state.supply && $('#chk-supply-on')) renderSupplyLayer();
}
// Gemeindegrenze nur auf Wunsch (lädt die 2,5-MB-Datei erst dann)
function renderMuniLayer() {
  const L_ = state.layers; L_.muni.clearLayers();
  if (!$('#chk-muni').checked || state.scope === 'DE') return;
  const f = state.boundaries?.features.find(x => x.properties.ags === state.scope);
  if (!f) { const sc = state.scope; if (!renderMuniLayer.tried?.has(sc)) { (renderMuniLayer.tried ??= new Set()).add(sc); loadBoundaries().then(b => { if (b && $('#chk-muni').checked && state.scope === sc) renderMuniLayer(); }); } return; }
  if (f) L.geoJSON(f, { style: { color: tok('--info'), weight: 1.5, fillOpacity: .04 } }).addTo(L_.muni);
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
  const map = state.map; if (map.getZoom() < 11) { notice(() => t('app.mobidataMapLoadsFromCityZoom'), '', 'wfs'); return; }
  const b = map.getBounds();
  const url = `${CFG.WFS}?service=WFS&version=2.0.0&request=GetFeature&typeName=MobiData-BW:sharing_vehicles&outputFormat=application/json&srsName=EPSG:4326&count=4000&bbox=${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()},EPSG:4326`;
  const r = await getJson(url, { timeout: 30000 });
  if (!r.ok || !r.json?.features) { notice(() => t('app.mobidataMapSourceNot', { v0: r.error || r.status }), 'warn', 'wfs'); return; }
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
    L.circleMarker([lat, lon], { radius: 3, weight: 1, color: cls === 'fresh' ? tok('--accent') : cls === 'old' ? DISABLED_COL : tok('--warn'), fillOpacity: .7 })
      .bindPopup(`${t('app.mobidataMap', { v0: esc(p.provider_name || p.operator || p.system_id || ''), v1: esc(p.form_factor || p.vehicle_type || '') })}<span class="muted">${age == null ? t('app.freshnessUnclear') : t('app.reported2', { age: ageText(age) })}</span>`).addTo(L_.wfs);
  }
  notice(() => t('app.mobidataMapPointsInView', { n: fmt(n), fresh, unk, old, v4: r.json.features.length >= 4000 ? t('app.responseCapped') : '' }), '', 'wfs');
}

// ---------- Energie niedrig: eine Regel für Übersicht, Briefing, Leistung, Karte und CSV (lib/pulse-report.js energyLow) ----------
// Wie die Disposition (lib/pulse-ops.js needsSwap): Ladestand < 20 % UND Reichweite < 5 km, wo beides gemeldet ist; sonst entscheidet die
// gemeldete Angabe. Anbieter, deren Feeds nur Reichweite melden (Lime; die Kernbibliothek leitet für sie einen Ladestand aus Reichweite ÷
// Maximalreichweite ab), zählen nur über die Reichweite. Gezählt je Fahrzeug: Live-Abruf (state.live.vehicles) oder Sammler-Stand
// (ops/<Land>.json; für Deutschland alle Länder, geteilter Cache mit Karte und Disposition). Fehlt die Datei: Rückfall auf die Zähler der
// Gruppe – genau, wo nur eine Angabe vorliegt; mit beiden Angaben höchstens min(Ladestand niedrig, Reichweite niedrig), als „≈“ markiert.
const RANGE_ONLY_OPS = new Set(R.RANGE_ONLY_OPS);
// Nur Reichweite je Anbieter: dieselbe Regel wie der Sammler (R.rangeOnlyOperators über latest.sources, = latest.energy.rangeOnlyOps); je Fahrzeug
// zusätzlich, wenn der Ladestand nur abgeleitet ist (v.batteryDerived; ops/<Land>.json und Momentaufnahmen tragen dann keinen Ladestand)
let roCache = null;
const rangeOnly = (op) => { if (roCache?.at !== state.latest?.at) roCache = { at: state.latest?.at, set: R.rangeOnlyOperators(state.latest?.sources) }; return roCache.set.has(op); };
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
    for (const v of state.live.vehicles) { const k = `${v.ags}|${v.operator}|${v.type}`; const e = m.get(k) || R.emptyEnergy(); R.addEnergy(e, v.batteryPct, v.rangeKm, { ...lim, rangeOnly: rangeOnly(v.operator) || !!v.batteryDerived, rangeDerived: !!v.rangeDerived, rangeLimit: v.rangeLimitKm ?? null, rangeFlat: !!v.rangeFlat, type: v.type }); m.set(k, e); }
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
  // Sammler zählt Energie je Gruppe selbst (latest.energy gesetzt: fehlendes Feld = 0) → keine ops/<Land>.json mehr für Kacheln, Signale, Leistung
  if (state.latest?.energy) { const g = state.latest.groups?.[k] || st || {}; return { known: g.energyKnown || 0, low: g.energyLow || 0, rangeOnly: g.energyRangeOnly || 0, rangeOnlyLow: g.energyRangeOnlyLow || 0 }; }
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
const energyRule = () => { const l = energyLimits(); return t('app.chargeAndRangeKm', { charge: fmt(l.charge), range: fmt(l.range) }); };
const energyVal = (e) => (e.pending ? '…' : e.known ? `${e.approx ? '≈ ' : ''}${pctf(e.low, e.known)}` : t('common.na'));
const energySub = (e) => (e.pending ? t('app.evaluatingEnergyPerVehicle') : e.known ? t('app.ofWithEnergyData', { v0: energyRule(), low: fmt(e.low), known: fmt(e.known), v3: e.rangeOnly ? ` ${t('app.ofWhichRangeOnly', { rangeOnly: fmt(e.rangeOnly) })}` : '', v4: e.approx ? ` · ${t('app.upperBoundWithoutIndividual')}` : '' }) : t('app.noEnergyData'));
function renderLab() {
  const groups = scopeGroups(); const st = sumStats([...groups.values()]);
  // Energie niedrig je Fahrzeug nach der Regel der Disposition; Anbieter nur mit Reichweite (Lime) zählen über die Reichweite mit
  const en = energyFor(); const lim = energyLimits();
  // Kacheln ohne Doppelung zur Übersicht (dort: verfügbar, gesperrt, Stationen, Energie niedrig, Quellen): Reichweite, Rückgabeplätze, Datenalter, Quellenqualität
  const recs = sourcesForScope().filter(r => state.operator === 'all' || r.operator === state.operator).map(r => liveRec(r.id) || r);
  const eff = recs.map(effStatus), use = eff.filter(e => USABLE.has(e.status) && e.age != null).map(e => e.age).sort((a, b) => a - b);
  const qual = recs.filter((r, i) => USABLE.has(eff[i].status) && Number.isFinite(r.quality)).map(r => r.quality);
  $('#lab-tiles').innerHTML = [
    tile(t('app.rangeBelowKm', { range: fmt(lim.range) }), st.rangeKnown ? pctf(st.lowRange, st.rangeKnown) : t('common.na'), st.rangeKnown ? t('app.ofWithRangeRegardlessOf', { lowRange: fmt(st.lowRange), rangeKnown: fmt(st.rangeKnown) }) : t('app.noRangeData')),
    tile(t('app.labFreeDocks'), st.stations ? fmt(st.stationDocks) : '—', st.stations ? t('app.labFreeDocksSub', { n: fmt(st.stations), full: fmt(st.stationsFull) }) + (st.stationDocksBad ? ` · ${t('app.docksBad', { n: fmt(st.stationDocksBad) })}` : '') : t('app.noStationsInFilter')),
    tile(abbr(t('app.labDataAge'), 'fresh'), use.length ? ageText(use[Math.floor(use.length / 2)]) : '—', use.length ? t('app.labDataAgeSub', { n: fmt(use.length) }) : t('app.noSourcesInArea')),
    tile(t('app.labQuality'), qual.length ? fmt(qual.reduce((a, b) => a + b, 0) / qual.length) : '—', qual.length ? t('app.labQualitySub', { n: fmt(qual.length) }) : t('app.noSourcesInArea')),
  ].join('');
  // Fahrzeugarten
  const byType = new Map();
  for (const [k, s] of groups) { const ty = k.split('|')[2]; byType.set(ty, [...(byType.get(ty) || []), s]); }
  $('#tbl-types tbody').innerHTML = [...byType].map(([ty, list]) => { const s = sumStats(list); const e = energyFor(k => k.split('|')[2] === ty); return `<tr><td>${esc(TYPE[ty] || ty)}</td><td class="n">${fmt(s.total)}</td><td class="n">${fmt(s.available)}<div class="sub-line">${pctf(s.available, s.total)}</div></td><td class="n">${fmt(s.disabled)}</td><td class="n">${energyVal(e)}<div class="sub-line">${!e.pending && e.known ? `n = ${fmt(e.known)}${e.rangeOnly ? ` · ${t('app.rangeOnly2', { rangeOnly: fmt(e.rangeOnly) })}` : ''}` : ''}</div></td><td class="n">${s.rangeKnown ? pctf(s.lowRange, s.rangeKnown) : t('common.na')}</td></tr>`; }).sort().join('') || emptyRow(6, t('app.noVehiclesInFilter'), t('app.setVehicleTypeOrOperatorTo'));
  // Stationen je Anbieter
  const byOp = new Map();
  for (const [k, s] of groups) { const op = k.split('|')[1]; byOp.set(op, [...(byOp.get(op) || []), s]); }
  $('#tbl-stations tbody').innerHTML = [...byOp].map(([op, list]) => ({ op, s: sumStats(list) })).filter(x => x.s.stations).map(({ op, s }) => `<tr><td><span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span></td><td class="n">${fmt(s.stations)}</td><td class="n">${fmt(s.stationsRenting)}</td><td class="n" title="${esc(emptyTip(s))}">${fmt(s.stationsEmpty)}${s.stationsEmptyDock != null ? `<div class="sub-line">${t('app.docksParkingZones', { stationsEmptyDock: fmt(s.stationsEmptyDock), v1: fmt(s.stationsEmptyVirtual) })}</div>` : ''}</td><td class="n">${fmt(s.stationsFull)}</td><td class="n">${fmt(s.stationPhysical)}</td><td class="n">${fmt(s.stationBookable)}</td><td class="n">${fmt(s.stationDocks)}</td></tr>`).join('') || emptyRow(8, t('app.noStationsInFilter2'), t('app.stationsAreMostlyReportedBy'));
  // Scorecard
  const rows = operatorRows().filter(r => !r.gap);
  // Score = gleich gewichtetes Mittel der vorhandenen Teilwerte; die Gewichte stehen im Kopf, die genutzten Teile je Zeile im Tooltip
  $('#tbl-score tbody').innerHTML = rows.map(r => { const s = r.st; const avail = s.total ? s.available / s.total : null; const dis = s.total ? s.disabled / s.total : null; const e = energyOfOp(r.op); const low = !e.pending && e.known ? e.low / e.known : null; const emp = s.stations ? s.stationsEmpty / s.stations : null;
    const named = [[t('app.available2'), avail != null ? avail * 100 : null], [t('app.n100DisabledRate'), dis != null ? 100 - dis * 100 : null], [t('app.n100LowEnergy'), low != null ? 100 - low * 100 : null], [t('app.n100EmptyStations'), emp != null ? 100 - emp * 100 : null], [t('app.sourceQuality'), r.quality]].filter(x => x[1] != null);
    const score = named.length ? Math.round(named.reduce((a, x) => a + x[1], 0) / named.length) : null;
    const how = named.length ? t('app.weightEach', { v0: named.map(([l, v]) => `${l} ${fmt(v)}`).join(' · '), v1: fmt(100 / named.length) }) : '';
    return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span></td><td class="n">${fmt(s.total)}</td><td class="n">${avail == null ? '—' : pctf(s.available, s.total)}</td><td class="n">${dis == null ? '—' : pctf(s.disabled, s.total)}</td><td class="n">${e.pending ? '…' : low == null ? t('common.na') : energyVal(e)}</td><td class="n"${emp == null ? '' : ` title="${esc(emptyTip(s))}"`}>${emp == null ? '—' : pctf(s.stationsEmpty, s.stations)}</td><td class="n">${esc(r.quality ?? '—')}</td><td class="n" title="${esc(how)}"><b>${score ?? '—'}</b><div class="sub-line">${t('app.partialScores', { length: named.length })}</div></td></tr>`; }).join('') || emptyRow(8, t('app.noOperatorsInFilter'), t('app.chooseAreaWithService'));
  renderHistory();
}
// Ansicht „Städte“: Gebietsvergleich aller Gemeinden (Sammler-Stand); das gewählte Gebiet steht fett und immer in der Liste
function renderCities() {
  const munis = state.latest?.municipalities || {};
  const src = new Map(Object.entries(state.latest?.groups || {})); // Gebietsvergleich immer aus dem Sammler-Stand (vollständig)
  const per = new Map();
  for (const [k, s] of src) { const [ags, op, ty] = k.split('|'); if (ags === 'DE' || ags === 'unbekannt') continue; if (state.operator !== 'all' && op !== state.operator) continue; if (state.type !== 'all' && ty !== state.type) continue; const m = per.get(ags) || { ags, available: 0, ops: new Set(), scooter: 0, bikes: 0, other: 0 }; m.available += s.available; m.ops.add(op); if (ty === 'scooter') m.scooter += s.available; else if (ty === 'bike' || ty === 'ebike' || ty === 'cargo') m.bikes += s.available; else m.other += s.available; per.set(ags, m); } // Audit UXM-03: Autos und Roller nicht als Räder
  const sorted = [...per.values()].sort((a, b) => b.available - a.available), list = sorted.slice(0, 25);
  if (state.scope !== 'DE' && per.has(state.scope) && !list.includes(per.get(state.scope))) list.push(per.get(state.scope));
  $('#cities-title').textContent = state.scope === 'DE' ? t('app.cityAndAreaComparison') : t('app.areaComparisonInContext', { v0: muniName(state.scope) });
  $('#tbl-cities tbody').innerHTML = list.map(m => { const mi = munis[m.ags]; const pop = mi?.pop; return `<tr${m.ags === state.scope ? ' style="font-weight:600"' : ''}><td><a href="#live" class="pick-muni" data-ags="${esc(m.ags)}">${esc(mi?.name || m.ags)}</a> <span class="muted">${esc(mi?.state || '')}</span></td><td class="n">${fmt(m.available)}</td><td class="n">${pop ? fmt((m.available / pop) * 1e4, 1) : '—'}</td><td class="n">${m.ops.size}</td><td class="n">${fmt(m.scooter)}</td><td class="n">${fmt(m.bikes)}</td><td class="n">${fmt(m.other)}</td></tr>`; }).join('') || emptyRow(7, t('app.noMunicipalitiesInFilter'), state.latest ? t('app.setOperatorOrVehicleTypeTo') : failedText('latest.json'));
}
async function renderHistory() {
  const idx = state.histIndex; const box = $('#chart-hist');
  if (!idx?.days?.length) { box.innerHTML = `<div class="empty">${t('app.noCollectorPointsYetHistory')}</div>`; return; }
  const day = state.histDay || idx.days[idx.days.length - 1];
  setChips($('#hist-days'), 'data-day', idx.days.slice(-7).map(d => `<button class="chip ${d === day ? 'on' : ''}" aria-pressed="${d === day}" data-day="${esc(d)}">${esc(d.slice(8))}.${esc(d.slice(5, 7))}.</button>`).join(''));
  const h = await loadHistory(day);
  if (!h) { box.innerHTML = `<div class="empty">${t('app.historyNotLoadableChoose', { failedText: esc(failedText(`history/${day}.json`)) })}</div>`; return; }
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
  const sub = $('#hist-sub'); sub.innerHTML = isClient() ? t('app.availableVehiclesOn', { join: esc(day.split('-').reverse().join('.')), v1: timeText(h.t[0]), v2: timeText(h.t[h.t.length - 1]), v3: abbr(t('app.dataPoints', { length: fmt(h.t.length) }), 'point') })
    : t('app.onHistoryDayStartsUtcUsage', { v0: abbr(t('app.collectorPoints', { length: fmt(h.t.length) }), 'point'), join: esc(day.split('-').reverse().join('.')), v2: timeText(h.t[0]), v3: timeText(h.t[h.t.length - 1]), utcStart, v5: changes.length ? ` · ${t('app.sourceChangesComparison', { length: changes.length })}` : '' });
  box.innerHTML = lineChart(h.t, series, chartWidth(box, () => renderHistory()));
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
// Diagramme in echten Pixeln: Breite = Breite des Kastens, Schrift bleibt 11 px (statt mit dem viewBox auf 4–15 px zu skalieren).
// Ändert sich die Breite um mehr als 24 px (Fenster, Drehen), zeichnet der Kasten sich neu.
const CHART_RO = typeof ResizeObserver === 'function' ? new ResizeObserver((es) => { for (const e of es) { const el = e.target, w = Math.round(e.contentRect.width); if (w > 0 && el._cw && Math.abs(el._cw - w) > 24) { el._cw = w; try { el._redraw?.(); } catch (err) { console.error('Diagramm', err); } } } }) : null;
function chartWidth(box, redraw) {
  const w = Math.round(box?.clientWidth || 0) || 900;
  if (box) { box._cw = w; box._redraw = redraw; CHART_RO?.observe(box); }
  return Math.max(280, w);
}
// Kurzfassung für Screenreader: je Reihe letzter Wert sowie Min/Max (die Werte stecken sonst nur in den Hover-Flächen)
const seriesSummary = (series, f = (v) => fmt(v)) => series.map(s => { const v = s.values.filter(x => x != null); return v.length ? t('app.chartSeriesSummary', { name: s.name, last: f(v[v.length - 1]), min: f(Math.min(...v)), max: f(Math.max(...v)) }) : null; }).filter(Boolean).join('; ');
function lineChart(tq, series, W = 900) {
  const H = W < 520 ? 200 : 260, P = { l: 48, r: 12, t: 12, b: 26 };
  const vals = series.flatMap(s => s.values).filter(x => x != null);
  if (!vals.length) return `<div class="empty">${t('app.noPointsForThisFilterSet')}</div>`;
  const nt = niceTicks(Math.max(...vals) * 1.04 || 1), max = nt.top, min = 0;
  // Zeitachse statt Punktindex: Pausen über 45 Min. bleiben sichtbar (grau) und die Linie wird dort unterbrochen
  const t0 = tq[0], t1 = Math.max(tq[tq.length - 1], t0 + 3600e3), GAP = 45 * 60e3;
  const x = (i) => P.l + ((tq[i] - t0) / (t1 - t0)) * (W - P.l - P.r), xt = (ms) => P.l + ((ms - t0) / (t1 - t0)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  let g = '';
  for (let i = 1; i < tq.length; i++) if (tq[i] - tq[i - 1] > GAP) { const w = x(i) - x(i - 1); g += `<rect class="gap" x="${x(i - 1).toFixed(1)}" y="${P.t}" width="${w.toFixed(1)}" height="${H - P.t - P.b}"><title>${t('app.noCollectorRun', { v0: timeText(tq[i - 1]), v1: timeText(tq[i]) })}</title></rect>${w > 60 ? `<text x="${(x(i - 1) + w / 2).toFixed(1)}" y="${P.t + 12}" text-anchor="middle">${t('app.notMeasured')}</text>` : ''}`; }
  for (const v of nt.ticks) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${P.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v, nt.step < 1 ? 1 : 0)}</text>`;
  // volle Stunden (Berliner Zeit; Stundengrenzen fallen mit UTC zusammen)
  // Abstand der Stundenmarken nach Breite: höchstens eine Beschriftung je ≈ 56 px
  const span = t1 - t0, fit = Math.max(1, Math.floor((W - P.l - P.r) / 56)), stepH = [1, 2, 3, 4, 6, 12, 24].find(s => span / (s * 3600e3) <= fit) || 24;
  for (let ms = Math.ceil(t0 / 3600e3) * 3600e3; ms <= t1; ms += 3600e3) if (!(hourOf(ms) % stepH)) g += `<text x="${xt(ms).toFixed(1)}" y="${H - 8}" text-anchor="middle">${timeText(ms)}</text>`;
  if (span <= 3600e3 * 1.5) g += `<text x="${x(0).toFixed(1)}" y="${H - 8}" text-anchor="start">${timeText(t0)}</text>`;
  series.forEach(s => { if (s.values.length > tq.length) s.values = s.values.slice(0, tq.length); }); // nie über die Zeitachse hinaus
  const paths = series.map((s, i) => { let d = '', open = false; s.values.forEach((v, j) => { if (v == null || (j && tq[j] - tq[j - 1] > GAP)) open = false; if (v == null) return; d += `${open ? 'L' : 'M'}${x(j).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); const last = s.values.map((v, j) => [v, j]).filter(([v]) => v != null).pop(); const dots = tq.length <= 12 ? s.values.map((v, j) => v == null ? '' : `<circle cx="${x(j).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${s.color || palette(i)}"/>`).join('') : ''; return `<path d="${d}" fill="none" stroke="${s.color || palette(i)}" stroke-width="2" stroke-linejoin="round"/>${dots}${last ? `<circle cx="${x(last[1]).toFixed(1)}" cy="${y(last[0]).toFixed(1)}" r="3.5" fill="${s.color || palette(i)}"/>` : ''}`; }).join('');
  // Trefferflächen je Sammler-Punkt (von Mitte zu Mitte) mit allen Werten als Tooltip
  let hits = '';
  for (let i = 0; i < tq.length; i++) { const a = i ? (x(i - 1) + x(i)) / 2 : P.l, b = i < tq.length - 1 ? (x(i) + x(i + 1)) / 2 : W - P.r; const lines = series.filter(s => s.values[i] != null).sort((p, q) => q.values[i] - p.values[i]).map(s => `${s.name} ${fmt(s.values[i])}`); hits += `<rect class="hit" x="${a.toFixed(1)}" y="${P.t}" width="${Math.max(1, b - a).toFixed(1)}" height="${H - P.t - P.b}"><title>${t('app.text', { v0: timeText(tq[i]), v1: esc(lines.join('\n') || t('app.noData2')) })}</title></rect>`; }
  return `<svg class="chart" data-px="1" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${t('app.historyOfAvailableVehicles')}. ${seriesSummary(series)}`)}">${g}${paths}${hits}</svg>`;
}

// ---------- Signale ----------
let sigFilter = 'all';
// Schwere der drei Bestandsalarme (gesperrt, Energie, Stationen): „kritisch“ nur, wenn der Anteil ≥ 15 Punkte über dem Mittel der vorigen Tage liegt
// (history/daily.json, Vertrag 6); liegt er darunter: „auffällig“; ohne Vergleichswert: „Hinweis“.
// Ab 5 Punkten über dem Mittel „auffällig“, ab 15 „kritisch“; im üblichen Rahmen (dauerhaft hoher Anteil) nur „Hinweis“.
function severity(share, baseline, src = 'Vortage') { // src: Kennung 'Tag' | 'Vortage'
  if (baseline == null) return { sev: 'info', foot: t('app.noComparisonValueNoDailyMean') };
  const d = (share - baseline) * 100;
  return { sev: d >= 15 ? 'bad' : d >= 5 ? 'warn' : 'info', foot: t('app.avgPoints', { v0: src === 'Tag' ? t('app.ofDaySoFar') : t('app.ofPreviousDays'), v1: fmt(baseline * 100), v2: d >= 0 ? '+' : '', d: fmt(d), v4: d < 5 ? ` ${t('app.usual')}` : '' }) };
}
// Rückfall ohne history/daily.json (bzw. für Stationen, die dort fehlen): Mittel der früheren Sammler-Punkte des geladenen Verlaufstags
function histBaseline(ags, op) {
  const h = state.hist[state.histIndex?.days?.slice(-1)[0]]; if (!h || h.t.length < 3) return null;
  const n = h.t.length - 1; let tot = 0, dis = 0, low = 0, sta = 0, emp = 0;
  for (const ser of seriesOf(h, ags, op)) { for (let i = 0; i < n; i++) { tot += ser.total?.[i] || 0; dis += ser.disabled?.[i] || 0; low += ser.lowBattery?.[i] || 0; sta += ser.stations?.[i] || 0; emp += ser.stationsEmptyDock?.[i] ?? ser.stationsEmpty?.[i] ?? 0; } }
  return tot || sta ? { src: 'Tag', disabled: tot ? dis / tot : null, low: tot ? low / tot : null, emptyDock: sta ? emp / sta : null } : null;
}
// Lede, Briefing und Signale lesen dasselbe Ergebnis: neu gerechnet nur, wenn sich Datenstand, Filter, Verlaufstag, Tagesmittel, Gruppen,
// Energie-Stand, Live-Abruf, Kundenansicht oder Sprache geändert haben
let sigMemo = null;
function computeSignals() {
  const key = [state.latest?.at, state.scope, state.operator, state.type, state.mode, state.live?.at, state.histDay, Object.keys(state.hist).length, !!state.daily, !!state.usage?.groups, !!state.usage?.consistency, ENERGY.size, energyWait, lang(), state.thresholds.charge, state.thresholds.range].join('|');
  if (sigMemo?.key === key) return sigMemo.out;
  const out = computeSignalsNow();
  sigMemo = { key, out };
  return out;
}
function computeSignalsNow() {
  const groups = scopeGroups(); const munis = state.latest?.municipalities || {};
  const by = new Map();
  const ebk = new Map(); // Energie je Gemeinde|Anbieter (Einzelfahrzeuge, Regel energyLow)
  for (const [k, s] of groups) {
    const [ags, op] = k.split('|'); const key = `${ags}|${op}`; (by.get(key) || by.set(key, []).get(key)).push(s);
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
    // short: Titel ohne die Zahl für die kompakte Briefing-Karte (dort steht n daneben)
    const who = { op, ags: place(ags) };
    if (s.total >= 5 && s.disabled / s.total >= 0.25) { const sv = severity(s.disabled / s.total, base.disabled, base.src); out.push({ cat: 'disabled', sev: sv.sev, w: s.disabled, n: fmt(s.disabled), short: t('app.sigShortDisabled', who), title: t('app.disabled4', { op, ags: place(ags), disabled: fmt(s.disabled), disabled2: pctf(s.disabled, s.total) }), text: t('app.feedMarksVehiclesAsUnusable'), foot: t('app.reportedIsdisabledStation', { foot: sv.foot }) }); }
    // Energie niedrig: feste Regel für alle Anbieter (auch Lime über die Reichweite), wie Kacheln und Disposition. Die Stufe misst die
    // Abweichung vom Vortagesmittel am Ladestand-Anteil am Bestand – die Tageswerte (history/daily.json) kennen nur diesen Zähler.
    const e = ebk.get(key);
    if (!e.pending && e.known >= 5 && e.low / e.known >= 0.3) {
      const sv = severity(s.total ? s.lowBattery / s.total : 0, base.low, base.src); const ro = e.rangeOnly === e.known;
      out.push({ cat: 'energy', sev: sv.sev, w: e.low, n: energyVal(e), short: t('app.sigShortEnergy', who), title: `${op}${place(ags)}: ${t('app.nLowEnergy', { n: energyVal(e) })}`, text: t('app.ofVehiclesWithEnergyData', { low: fmt(e.low), known: fmt(e.known), v2: energyRule(), v3: ro ? ` ${t('app.feedReportsRangeOnlyBelow')}` : e.rangeOnly ? t('app.withRangeOnly', { rangeOnly: fmt(e.rangeOnly) }) : '' }), foot: t('app.energyPerVehicleWorkOrderNot', { foot: sv.foot }) });
    }
    // Leer zählt nur effektiv: gemeldet leer und kein verfügbares Fahrzeug desselben Anbieters ≤ 50 m. Alarm nur für Docks; virtuelle Stationen getrennt (Vertrag 3)
    const nearM = C.STATION_NEAR_M ?? 50, nearN = s.stationsEmptyNearby || 0;
    const otherN = s.stationsEmptyOtherNearby || 0;
    const nearTxt = (nearN ? ` ${t('app.anotherReportedEmptyBut', { nearN: fmt(nearN), nearM })}` : '') + (otherN ? ` ${t('app.atOfEmptyOnesVehiclesOfOther', { otherN: fmt(otherN), nearM })}` : '');
    const dockKnown = s.stationsEmptyDock != null;
    const docks = dockKnown ? s.stations - (s.stationsVirtual || 0) : s.stations, emptyDock = dockKnown ? s.stationsEmptyDock : s.stationsEmpty;
    if (docks >= 3 && emptyDock / docks >= 0.3) { const sv = severity(emptyDock / docks, base.emptyDock, base.srcSt); out.push({ cat: 'stations', sev: sv.sev, w: emptyDock, n: fmt(emptyDock), short: t('app.sigShortEmpty', who), title: t('app.emptyStations', { op, ags: place(ags), emptyDock: fmt(emptyDock), v3: dockKnown ? 'Dock-' : '', emptyDock2: pctf(emptyDock, docks) }), text: t('app.ofReportedStationsCurrently', { emptyDock: fmt(emptyDock), docks: fmt(docks), v2: dockKnown ? 'Dock-' : '', nearM, nearTxt }), foot: t('app.stationStatusAndVehicle', { foot: sv.foot }) }); }
    else if (docks >= 3 && nearN / s.stations >= 0.3) out.push({ cat: 'data', sev: 'info', w: nearN, n: fmt(nearN), short: t('app.sigShortReportedEmpty', who), title: t('app.stationsReportedEmpty', { op, ags: place(ags), nearN: fmt(nearN) }), text: t('app.stationFeedReportsNoBookable', { nearM, stationsEmpty: fmt(s.stationsEmpty) }), foot: t('app.stationStatusAndVehicle2') });
    if (dockKnown && s.stationsEmptyVirtual > 0) out.push({ cat: 'stations', sev: 'info', w: s.stationsEmptyVirtual, n: fmt(s.stationsEmptyVirtual), short: t('app.sigShortZones', who), title: t('app.parkingZonesWithoutVehicle', { op, ags: place(ags), v2: fmt(s.stationsEmptyVirtual) }), text: t('app.ofVirtualStationsParking', { v0: fmt(s.stationsEmptyVirtual), stationsVirtual: fmt(s.stationsVirtual) }), foot: t('app.isvirtualstationInStation') });
    if (s.stations >= 3 && s.stationsFull / s.stations >= 0.3) out.push({ cat: 'stations', sev: 'info', w: s.stationsFull, n: fmt(s.stationsFull), short: t('app.sigShortFull', who), title: `${op}${place(ags)}: ${t('app.nFullStations', { n: fmt(s.stationsFull) })}`, text: t('app.returningVehiclesToThese'), foot: 'num_docks_available = 0' });
    if (s.total >= 5 && s.geoStation / s.total >= 0.5) out.push({ cat: 'data', sev: 'info', w: s.geoStation, n: fmt(s.geoStation), short: t('app.sigShortGeo', who), title: t('app.positionsMostlyStation', { op, ags: place(ags) }), text: t('app.ofVehiclesWithoutOwn', { geoStation: fmt(s.geoStation), total: fmt(s.total) }), foot: t('app.geoCheck') });
  }
  // Quellenzustand; geprüfte Direktfeed-Kandidaten ohne Feed sind kein Ausfall (wie in der Ampel)
  const recs = sourcesForScope().map(r => liveRec(r.id) || r);
  for (const r of recs) {
    if (r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status)) continue;
    // Audit UXM-04: Anbieter- und Art-Filter gelten auch für Quellen-Signale (vorher meldete „Voi · E-Scooter“ RegioRad als kritisch)
    if (state.operator !== 'all' && r.operator !== state.operator) continue;
    if (state.type !== 'all' && Array.isArray(r.vehicleTypes) && r.vehicleTypes.length && !r.vehicleTypes.includes(state.type)) continue;
    // Zustand statt Zahl: die Karte zeigt ein Zeichen, der Titel nennt den Zustand („Quelle: Fehler“)
    if (['stale', 'gone', 'error', 'auth'].includes(r.status)) out.push({ cat: 'data', sev: r.status === 'stale' ? 'warn' : 'bad', w: 1, n: null, icon: true, title: t('app.source2', { operator: r.operator, v1: STATUS[r.status] || r.status }), text: `${r.name || r.id}${r.feedAgeMs != null ? ` · ${t('app.feedOld', { v0: ageText(r.feedAgeMs) })}` : ''}${r.errors?.length ? ` · ${esc(tx(r.errors[0]))}` : ''}`, foot: `${(r.directories || []).map(d => DIRS[d] || d).join(' · ')}` });
    if (r.sourceChanged) out.push({ cat: 'data', sev: 'info', w: 1, n: null, icon: true, title: t('app.sourceChangeDetected', { operator: r.operator }), text: t('app.endpointVersionFeedsOr', { v0: r.name || r.id }), foot: t('app.fingerprint') });
  }
  for (const e of state.usage?.consistency?.systems || []) { if (e.verdict !== 'divergent') continue; const r = (state.latest?.sources || []).find(x => x.id === e.sourceId); if (!r || (state.scope !== 'DE' && !(r.municipalities || []).includes(state.scope)) || (state.operator !== 'all' && e.operator !== state.operator)) continue; out.push({ cat: 'data', sev: 'warn', w: Math.abs((e.primary?.vehicles || 0) - (e.alt?.vehicles || 0)), n: fmt(Math.abs((e.primary?.vehicles || 0) - (e.alt?.vehicles || 0))), short: t('app.sigShortDivergent', { op: e.operator }), title: t('app.stateAndOperatorFeedDiffer', { operator: e.operator }), text: t('app.vsVehiclesMedianDistance', { sourceId: e.sourceId, v1: fmt(e.primary?.vehicles), v2: fmt(e.alt?.vehicles), v3: e.idOverlap == null ? '' : pctf(e.idOverlap, 1) + ` ${t('app.sharedIds')} `, v4: e.medianDistM == null ? '—' : fmt(e.medianDistM) + ' m' }), foot: t('app.consistencyCheck') }); }
  for (const g of state.latest?.gaps || []) if ((state.scope === 'DE' || muniName(state.scope) === g.city) && (state.operator === 'all' || g.operator === state.operator) && gapFitsType(g)) out.push({ cat: 'data', sev: 'info', w: 1, n: null, icon: true, title: t('app.publicDataMissingSince', { operator: g.operator, city: g.city, v2: String(g.since || '').split('-').reverse().join('.') }), text: (lang() === 'en' && g.note_en) || g.note, foot: g.probeOk ? t('app.feedReachableAgain') : t('app.feedChecked', { v0: g.probeStatus ?? '–' }) });
  // Bestandssprung gegen Verlauf
  const h = state.histDay ? state.hist[state.histDay] : state.hist[state.histIndex?.days?.slice(-1)[0]];
  if (h && h.t.length >= 3) {
    for (const [key, list] of by) {
      const [ags, op] = key.split('|'); let prev = 0, cur = 0, n = 0;
      for (const ser of seriesOf(h, ags, op)) { const a = ser.available; const lastIdx = a.length - 1; if (a[lastIdx] == null || a[lastIdx - 3] == null) continue; cur += a[lastIdx]; prev += a[lastIdx - 3]; n++; }
      if (n && prev >= 20 && Math.abs(cur - prev) / prev >= 0.3) out.push({ cat: 'jump', sev: 'warn', w: Math.abs(cur - prev), n: `${cur > prev ? '+' : ''}${fmt(cur - prev)}`, short: t('app.sigShortJump', { op, ags: place(ags) }), title: t('app.fleetWithinHour', { op, ags: place(ags), v2: cur > prev ? '+' : '', v3: fmt(cur - prev) }), text: t('app.availableOverLastThree', { prev: fmt(prev), cur: fmt(cur) }), foot: t('app.collectorHistory') });
    }
  }
  // Ampel der Ereignisregeln je Gruppe (latest.json → eventChecks, letzter vollständiger Tag): gelb und rot als Datenhinweis
  for (const [k, v] of Object.entries(state.latest?.eventChecks?.groups || {})) {
    if (v?.level !== 'warn' && v?.level !== 'bad' || !groupInScope(k)) continue; const [ags, op, ty] = k.split('|');
    out.push({ cat: 'data', sev: v.level, w: v.checks?.rides || 1, n: null, icon: true, short: t('mb.sigShort', { op, ags: place(ags) }), title: t('mb.sigTitle', { op, ty: TYPE[ty] || ty, ags: place(ags), lv: v.level === 'bad' ? t('mb.red') : t('mb.yellow') }),
      text: `${Rp.mbChecksText(v.checks)}. ${v.level === 'bad' ? t('mb.sigRed') : t('mb.sigYellow')}`, foot: t('mb.sigFoot', { day: state.latest.eventChecks.day || '–' }) });
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
  return [...by].map(([k, a]) => { const [ags, op] = k.split('|'); return { cat: 'deploy', sev: 'info', w: a.n, n: `${fmt(a.n)}×`, short: t('app.sigShortDeploy', { op, ags: ` · ${muniName(ags)}` }), title: t('app.groupsDeployedTodayAvg', { op, ags: muniName(ags), n: fmt(a.n), v3: fmt(a.veh / a.n) }), text: t('app.atLeast5OfOperatorSVehicles', { n: GROUP_MIN, m: GROUP_M }), foot: t('app.derivedFromObservationNo') }; });
}
const CATS = { get all() { return t('app.all'); }, get disabled() { return t('app.disabled2'); }, get energy() { return t('app.energy'); }, get stations() { return t('app.stations'); }, get jump() { return t('app.fleetJump'); }, get deploy() { return t('app.deployment'); }, get data() { return t('app.dataQuality'); } };
const SEV_LABEL = { get bad() { return t('app.critical'); }, get warn() { return t('app.notable'); }, get info() { return t('app.note'); } };
// compact: Briefing-Karte mit Zahl + einer Zeile; Begründung und Grundlage unter „Warum?“
function sigCard(s, compact = false) {
  const head = `<div class="k">${esc(CATS[s.cat] || s.cat)} · ${SEV_LABEL[s.sev] || esc(s.sev)}</div>`;
  // kompakt: Zahl + Kurztitel (ohne die Zahl ein zweites Mal); Zustandsmeldungen ohne Zahl tragen ein Zeichen
  const lead = s.icon || s.n == null ? `<span class="num ico" aria-hidden="true">${s.sev === 'bad' ? '!' : s.sev === 'warn' ? '!' : 'i'}</span>` : `<span class="num">${esc(s.n)}</span>`;
  if (compact) return `<div class="card ${esc(s.sev)}">${head}<b>${lead} ${esc(s.short || s.title)}</b><details><summary>${t('app.why')}</summary><p>${esc(s.text)}</p><div class="foot">${esc(s.foot)}</div></details></div>`;
  return `<div class="card ${esc(s.sev)}">${head}<b>${esc(s.title)}</b><p>${esc(s.text)}</p><div class="foot">${esc(s.foot)}</div></div>`;
}
function renderSignals() {
  const all = computeSignals();
  const counts = {}; for (const s of all) counts[s.cat] = (counts[s.cat] || 0) + 1;
  setChips($('#sig-filter'), 'data-cat', Object.entries(CATS).map(([k, l]) => `<button class="chip ${sigFilter === k ? 'on' : ''}" aria-pressed="${sigFilter === k}" data-cat="${k}">${l} <span class="mono">${k === 'all' ? all.length : counts[k] || 0}</span></button>`).join(''));
  const list = (sigFilter === 'all' ? all : all.filter(s => s.cat === sigFilter)).slice(0, 60);
  $('#sig-cards').innerHTML = list.length ? list.map(s => sigCard(s)).join('') : `<div class="empty" style="grid-column:1/-1">${t('app.noSignalsInSelectedFilter', { v0: sigFilter !== 'all' ? t('app.chooseCategoryAll') : t('app.nothingNotableInAreaRightNow') })}</div>`;
  renderStability();
}
async function renderStability() {
  const day = state.histDay || state.histIndex?.days?.slice(-1)[0];
  const tb = $('#tbl-stability tbody');
  if (!day) { tb.innerHTML = emptyRow(7, t('app.noHistoryYet'), t('app.itStartsWithFirstCollector')); return; }
  const h = await loadHistory(day); if (!h) { tb.innerHTML = emptyRow(7, t('app.historyNotLoadable'), t('app.reloadPageLater', { v0: failedText(`history/${day}.json`) })); return; }
  const byOp = new Map();
  for (const [k, ser] of Object.entries(h.series)) { const [ags, op, ty] = k.split('|'); if (state.scope === 'DE' ? ags !== 'DE' : ags !== state.scope) continue; if (state.operator !== 'all' && op !== state.operator) continue; if (state.type !== 'all' && ty !== state.type) continue; const name = state.scope === 'DE' ? (TYPE[ty] || ty) : op; const arr = byOp.get(name) || new Array(h.t.length).fill(null); alignSeries(ser.available, h.t.length).forEach((v, i) => { if (v != null) arr[i] = (arr[i] || 0) + v; }); byOp.set(name, arr); }
  tb.innerHTML = [...byOp].map(([name, arr]) => { const v = arr.filter(x => x != null); if (!v.length) return ''; const min = Math.min(...v), max = Math.max(...v), last = v[v.length - 1], first = v[0]; const d = last - first; const drop = max && (max - last) / max; return `<tr><td>${esc(name)}</td><td class="n">${v.length}</td><td class="n">${fmt(min)}</td><td class="n">${fmt(max)}</td><td class="n">${fmt(last)}</td><td class="n">${d > 0 ? '+' : ''}${fmt(d)}</td><td class="small">${drop >= 0.3 ? `<span class="pill stale">${t('app.belowDailyMaximum', { v0: pctf(max - last, max) })}</span>` : v.length < 3 ? `<span class="muted">${t('app.tooFewPoints')}</span>` : `<span class="muted">${t('app.stable')}</span>`}</td></tr>`; }).join('') || emptyRow(7, t('app.noPointsInFilter'), t('app.setOperatorOrVehicleTypeTo'));
}

// ---------- Abdeckung ----------
// Abdeckung folgt dem Gebiet und dem Anbieter oben; „Ganz Deutschland“ hebt die Gebietswahl für diese Tabelle auf (gilt, bis das Gebiet wechselt)
let covAllFor = null;
function renderCoverage() {
  const munis = state.latest?.municipalities || {}; const q = ($('#cov-search').value || '').toLowerCase(); const dir = $('#cov-dir').value;
  const recs = state.latest?.sources || [];
  const local = state.scope !== 'DE' && covAllFor !== state.scope;
  const rows = [];
  for (const [ags, m] of Object.entries(munis)) {
    if (local && ags !== state.scope) continue;
    for (const [op, o] of Object.entries(m.operators || {})) {
      if (state.operator !== 'all' && op !== state.operator) continue;
      if (state.type !== 'all' && !(o.types?.[state.type] > 0)) continue; // gewählte Fahrzeugart (verknüpfte Filter)
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
  $('#cov-tiles').innerHTML = [tile(t('app.operatorsOnSite'), fmt(rows.length), cl(t('app.operatorMunicipalityWith'), t('app.operatorsPerMunicipality'))), tile(cl(t('app.operatorGroups'), t('app.operator')), fmt(opsAll.size), cl(t('app.acrossAllSources'), t('app.nationwide'))), tile(t('app.municipalities'), fmt(places.size), t('app.withAvailableVehicles')), isClient() ? '' : tile(t('app.unassigned'), fmt(recs.filter(r => ['foreign', 'empty'].includes(r.status)).length), t('app.sourcesOutsideGermanyOr'))].join('');
  $('#cov-sub').innerHTML = `${esc(t('app.rows', { length: fmt(rows.length), v1: cl(t('app.collectorSnapshot'), t('app.asOf2')), v2: timeText(state.latest?.at) }))}${state.scope !== 'DE' ? ` · <button type="button" class="chip" data-cov-all aria-pressed="${!local}">${esc(local ? t('app.covShowGermany') : t('app.covShowOnly', { place: muniName(state.scope) }))}</button>` : ''}`;
  const { show, rest } = pageRows('cov', rows, `${q}|${dir}|${state.latest?.at}|${local}|${state.operator}`);
  $('#tbl-cov tbody').innerHTML = show.map(r => `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line">${Object.entries(r.o.types || {}).filter(([, n]) => n).map(([tq, n]) => `${esc(TYPE[tq] || tq)} ${fmt(n)}`).join(' · ')}</div></td><td>${esc(r.m.name)} <span class="muted">${esc(r.m.state)}</span></td><td class="n">${fmt(r.o.total)}</td><td class="n">${fmt(r.o.available)}</td><td class="small internal">${r.dirs.map(dirLabel).join(' · ')}<div class="sub-line">${r.srcs.length} ${r.srcs.length === 1 ? t('app.source') : t('app.sources')}</div></td><td>${pillStatus(r.status)}</td><td><a href="#live" class="pick-muni" data-ags="${esc(r.ags)}">${t('app.openPlace2')}</a></td></tr>`).join('') || emptyRow(7, t('app.noMatches'), q || dir !== 'all' ? t('app.clearSearchOrChooseAll') : state.latest ? t('app.noOperatorsInCollector') : failedText('latest.json'));
  $('#cov-more').innerHTML = moreBtn('cov', rest, ` ${t('app.orNarrowSearch')}`);
  // Lücken mit gleichem Anbieter und gleichem Text als eine Karte mit Städteliste (z. B. Ryde in zehn NRW-Städten)
  // Hinweistext der Datenlücke: englisch, wo gepflegt (data/sources-manual.json → known_gaps[].note_en), sonst deutsch mit lang="de"
  const gapNote = (g) => lang() === 'en' && g.note_en ? `<p>${esc(g.note_en)}</p>` : `<p lang="de">${esc(g.note)}</p>`;
  const gb = new Map(); for (const g of state.latest?.gaps || []) { const k = `${g.operator}|${g.note}`; (gb.get(k) || gb.set(k, []).get(k)).push(g); }
  $('#gaps').innerHTML = [...gb.values()].map(list => { const g = list[0]; const cities = [...new Set(list.map(x => x.city))].sort((a, b) => a.localeCompare(b, 'de')); const since = list.map(x => x.since).filter(Boolean).sort()[0] || g.since; const ok = list.filter(x => x.probeOk).length;
    return `<div class="card info"><div class="k">${t('app.dataGap2')}</div><b>${esc(g.operator)} · ${cities.length > 1 ? esc(t('app.gapCities', { n: fmt(cities.length) })) : esc(g.city)}</b>${cities.length > 1 ? `<p translate="no">${esc(cities.join(', '))}</p>` : ''}${gapNote(g)}<div class="foot">${cities.length > 1 ? t('app.gapGroupFoot', { since: esc(since), v1: timeText(Math.max(...list.map(x => x.checkedAt || 0)) || null), ok: fmt(ok), n: fmt(list.length) }) : t('app.sinceLastCheckedFeed', { since: esc(g.since), v1: timeText(g.checkedAt), v2: g.probeOk ? t('app.reachable') : t('app.notReachable', { v0: esc(g.probeStatus ?? '–') }) })}</div></div>`; }).join('') || `<div class="empty">${t('app.noKnownGapsAllKnownOperators')}</div>`;
}
// Lange Tabellen: erst 100 Zeilen, je Klick 100 weitere; neuer Filter (Schlüssel) setzt auf 100 zurück
const MORE = {};
function pageRows(key, rows, filterKey) {
  const m = MORE[key]?.f === filterKey ? MORE[key] : (MORE[key] = { f: filterKey, n: 100 });
  return { show: rows.slice(0, m.n), rest: Math.max(0, rows.length - m.n) };
}
// eine Formulierung für „weitere Zeilen“ in allen Tabellen: bis 100 Rest alle auf einmal, sonst 100 und der verbleibende Rest
const moreText = (rest) => (rest <= 100 ? t('common.showAllMore', { n: fmt(rest) }) : t('common.show100More', { n: fmt(rest - 100) }));
const moreBtn = (key, rest, hint = '') => rest ? `<button class="more-rows" data-more="${esc(key)}">${moreText(rest)}</button>${hint ? ` <span class="muted">${esc(hint.trim())}</span>` : ''}` : '';
const MORE_RENDER = { cov: () => renderCoverage(), src: () => renderSourceTable() };

// ---------- Quellen ----------
function renderSources() {
  const recs = state.latest?.sources || []; const cat = state.catalog;
  const by = {}; for (const r of recs) by[r.status] = (by[r.status] || 0) + 1;
  $('#src-tiles').innerHTML = [tile(t('app.sourcesChecked'), fmt(recs.length), t('app.catalogueEntries', { v0: cat?.count ?? '–', v1: state.latest ? new Date(state.latest.at).toLocaleString(fmtLocale(), { dateStyle: 'short', timeStyle: 'short' }) : '–' })), tile(t('app.current'), fmt(by.live || 0), t('app.delayedStale', { v0: fmt(by.delayed || 0), v1: fmt(by.stale || 0) }), (by.live || 0) / Math.max(1, recs.length) < 0.6 ? 'warn' : 'ok'), tile(t('app.notUsable'), fmt((by.gone || 0) + (by.error || 0) + (by.auth || 0) + (by.empty || 0) + (by.unknown || 0)), t('app.goneErrorsTimeUnclearEmpty', { v0: fmt(by.gone || 0), v1: fmt(by.error || 0), v2: fmt(by.unknown || 0), v3: fmt(by.empty || 0), v4: by.duplicate || by.retired ? ` · ${t('app.notCountedDuplicatesGoneFor', { v0: fmt(by.duplicate || 0), v1: fmt(by.retired || 0) })}` : '' })), tile(t('app.duplicatesRemoved'), fmt(state.latest?.dedupe?.duplicates), t('app.stationDuplicatesIdsReused', { v0: fmt(state.latest?.dedupe?.stationDuplicates), v1: fmt(state.latest?.dedupe?.reusedIds) }))].join('');
  const dirCount = {}; for (const r of recs) for (const d of r.directories || []) dirCount[d] = (dirCount[d] || 0) + 1;
  const dirInfo = {
    mobilitydata: [t('app.connected'), t('app.allSystemsOfGbfsCatalogue'), 'https://github.com/MobilityData/gbfs/blob/master/systems.csv'],
    mobidata_bw: [t('app.connectedPreferred'), t('app.stateFeedsOfBadenWuRttemberg'), 'https://mobidata-bw.de/sk/dataset/bikesh'],
    mobidrom_nrw: [t('app.connectedServiceAccess'), t('app.conflatedStateFeedsOfNorth'), 'https://www.mobilitaetsdaten.nrw/api/ckan/organization/angemeldet'],
    citybikes: [t('app.connectedSupplement'), t('app.stationCountersWithout'), 'https://api.citybik.es/v2/networks'],
    dott_direct: [t('app.candidatesChecked'), t('app.directFeedsGbfsApiRidedott'), 'https://gbfs.api.ridedott.com/public/v2/stuttgart/gbfs.json'],
  };
  $('#dirs').innerHTML = Object.entries(dirInfo).map(([k, [st, txt, url]]) => `<div class="card ok"><div class="k">${esc(st)}</div><b>${esc(DIRS[k])}</b><p>${esc(txt)}</p><div class="foot">${t('app.sourcesOriginalSource', { v0: fmt(dirCount[k] || 0), url })}</div></div>`).join('') +
    `<div class="card info"><div class="k">${t('app.basis')}</div>${t('app.municipalBoundariesBkg')}<p>${t('app.licenceDlDeBy20GpsDecides', { v0: `<span translate="no">${esc(state.latest?.boundaries?.attribution || '© GeoBasis-DE / BKG, VG250')}</span>` })}</p><div class="foot">${t('app.municipalitiesOriginalSource', { v0: fmt(state.latest?.boundaries?.count) })}</div></div>
     <div class="card warn"><div class="k">${t('app.notUsed')}</div>${t('app.dbApiMarketplaceVoiPartner')}<p>${t('app.bothRequirePersonal')}</p><div class="foot">${t('app.noPartnerAccess')}</div></div>`;
  loadOnce('reliability', 'reliability.json').then(() => renderSourceTable());
  renderConsistency(); renderMonitor().catch(e => console.error('Monitor', e)); renderQuality(); renderLicenses();
  // Methodik eingeklappt wie in der Disposition: sichtbar bleibt ein Satz, geöffnet bleibt geöffnet
  const mOpen = $('#method details')?.open;
  $('#method').innerHTML = `<h2>${t('app.analysisInDetail')}</h2><p>${t('app.methodLead')}</p><details class="more"${mOpen ? ' open' : ''}><summary>${t('app.methodSummary')}</summary>${METHOD()}</details>`;
}
// ---------- Datenvertrauen: Sammler-Monitor, Datenqualität, Lizenzen ----------
const TRIGGER = { get schedule() { return t('app.scheduled'); }, get workflow_dispatch() { return t('app.manual'); }, get lokal() { return t('app.local'); }, push: 'Push' };
async function renderMonitor() {
  const box = $('#monitor'); const doc = await loadOnce('runs', 'runs.json');
  const F = doc?.fields || ['at', 'dauer_ms', 'quellen', t('app.current2'), 'verzoegert', t('app.stale'), t('app.error'), 'fahrzeuge', 'stationen', 'fahrten', 'fahrtenden', 'kennungswechsel', 'ausloeser'];
  const ix = Object.fromEntries(F.map((f, i) => [f, i]));
  const runs = (doc?.runs || []).filter(r => Number.isFinite(r[ix.at])).sort((a, b) => a[ix.at] - b[ix.at]);
  if (!runs.length) { box.innerHTML = `<div class="empty">${t('app.monitorStartsWithNext')}</div>`; return; }
  const share = (r) => r[ix.quellen] ? (r[ix.aktuell] || 0) / r[ix.quellen] : null;
  const shares = runs.map(share).filter(x => x != null).sort((a, b) => a - b);
  const med = shares.length ? shares[Math.floor(shares.length / 2)] : null;
  const lvl = (v) => v == null || med == null ? 'warn' : v >= med - 0.05 ? 'ok' : v >= med - 0.15 ? 'warn' : 'bad';
  const GAP = 45 * 60e3, now = Date.now(), last = runs[runs.length - 1];
  const gaps = []; for (let i = 1; i < runs.length; i++) { const a = runs[i - 1][ix.at], b = runs[i][ix.at]; if (b - a > GAP) gaps.push([a, b, false]); }
  if (!DEMO && now - last[ix.at] > GAP && now - last[ix.at] < 7 * 86400e3) gaps.push([last[ix.at], now, true]);
  const W = chartWidth(box, () => renderMonitor().catch(e => console.error('Monitor', e))), H = W < 520 ? 170 : 150, P = { l: 44, r: 12, t: 12, b: 24 }, plotW = W - P.l - P.r;
  // Statt eines Punkts je Lauf (gut 500 in 7 Tagen) ein Wert je Zeitabschnitt: Median der Läufe als Linie; Punkt nur, wo ein Lauf deutlich unter
  // dem Üblichen lag (am niedrigsten Lauf). Abschnitt 1 Stunde, auf schmalen Bildschirmen länger (mind. 4 px je Abschnitt).
  const span0 = Math.max((gaps.some(g => g[2]) ? now : last[ix.at]) - runs[0][ix.at], 3600e3);
  const B = [1, 2, 3, 4, 6].find(b => plotW / (span0 / (b * 3600e3)) >= 4) || 6, BMS = B * 3600e3;
  const bStart = (tq) => { const hs = Math.floor(tq / 3600e3) * 3600e3; return B > 1 ? hs - (hourOf(hs) % B) * 3600e3 : hs; };
  const bk = new Map(); for (const r of runs) { const s = bStart(r[ix.at]); let b = bk.get(s); if (!b) bk.set(s, b = { s, runs: [] }); b.runs.push(r); }
  const buckets = [...bk.values()].sort((a, b) => a.s - b.s).map(b => {
    const v = b.runs.map(share).filter(x => x != null).sort((p, q) => p - q), n = v.length;
    const low = b.runs.reduce((m, r) => (share(r) != null && (m == null || share(r) < share(m)) ? r : m), null);
    return { ...b, med: n ? (v[(n - 1) >> 1] + v[n >> 1]) / 2 : null, min: n ? v[0] : null, low };
  });
  const t0 = buckets[0].s, t1 = Math.max(buckets[buckets.length - 1].s + BMS, gaps.some(g => g[2]) ? now : 0, t0 + 3600e3), span = t1 - t0;
  const lo = Math.max(0, Math.floor(((shares[0] ?? 0) - 0.05) * 10) / 10), hi = Math.min(1, Math.ceil(((shares[shares.length - 1] ?? 1) + 0.02) * 10) / 10) || 1;
  const x = (tq) => P.l + ((tq - t0) / span) * plotW, y = (v) => P.t + (1 - ((v ?? lo) - lo) / Math.max(0.05, hi - lo)) * (H - P.t - P.b);
  const dt = (tq) => dateTimeText(tq, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const pct = (v) => (v == null ? '–' : `${fmt(v * 100)} %`);
  let g = '';
  // y: unten, oben und der übliche Wert (gestrichelt) – Beschriftung entfällt, wo sie sich überdecken würde
  for (const v of [lo, hi]) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>${med != null && Math.abs(y(v) - y(med)) < 12 ? '' : `<text x="${P.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v * 100)} %</text>`}`;
  // Tagesmarken: Wochentag nur, wenn ein Tag ≥ 90 px breit ist; unter 48 px nur jeder zweite Tag
  const dayPx = plotW / Math.max(1, span / 86400e3), dayOpt = dayPx >= 90 ? { weekday: 'short', day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit' };
  if (span > 30 * 3600e3) { const d = new Date(t0); d.setHours(24, 0, 0, 0); let k = 0; for (let tq = +d; tq < t1; tq += 86400e3, k++) { const lab = new Date(tq).toLocaleDateString(fmtLocale(), dayOpt); g += `<line class="grid" x1="${x(tq).toFixed(1)}" x2="${x(tq).toFixed(1)}" y1="${P.t}" y2="${H - P.b}"/>${(dayPx >= 48 || !(k % 2)) && x(tq) + 4 + lab.length * 6.8 <= W ? `<text x="${(x(tq) + 4).toFixed(1)}" y="${H - 8}">${lab}</text>` : ''}`; } }
  else { const fit = Math.max(1, Math.floor(plotW / 56)), step = [1, 2, 3, 4, 6, 12].find(s => span / (s * 3600e3) <= fit) || 12; for (let tq = Math.ceil(t0 / 3600e3) * 3600e3; tq < t1; tq += 3600e3) { if (hourOf(tq) % step) continue; g += `<text x="${x(tq).toFixed(1)}" y="${H - 8}" text-anchor="middle">${timeText(tq)}</text>`; } }
  for (const [a, b, open] of gaps) g += `<rect class="gap" x="${x(a).toFixed(1)}" y="${P.t}" width="${Math.max(2, x(b) - x(a)).toFixed(1)}" height="${H - P.t - P.b}"><title>${t('app.gapToWithoutRun', { a: dt(a), v1: open ? t('app.now') : dt(b), v2: durText(b - a) })}</title></rect>`;
  if (med != null) g += `<line class="mon-med" x1="${P.l}" x2="${W - P.r}" y1="${y(med).toFixed(1)}" y2="${y(med).toFixed(1)}"/><text class="mon-med-t" x="${P.l - 6}" y="${(y(med) + 3).toFixed(1)}" text-anchor="end">${fmt(med * 100)} %</text>`;
  // Linie durch die Abschnittsmitten, unterbrochen, wo ein Abschnitt ohne Lauf dazwischen liegt
  const xc = (b) => x(b.s + BMS / 2);
  let d = '', prev = null; for (const b of buckets) { if (b.med == null) { prev = null; continue; } d += `${!prev || b.s - prev.s > BMS ? 'M' : 'L'}${xc(b).toFixed(1)} ${y(b.med).toFixed(1)} `; prev = b; }
  g += `<path class="mon-line" d="${d}"/>`;
  // Einbrüche: Stiel vom Abschnittswert zum niedrigsten Lauf, Punkt mit Rand in Flächenfarbe
  for (const b of buckets) { const l = b.min == null ? 'ok' : lvl(b.min); if (l === 'ok') continue; const cx = xc(b).toFixed(1); g += `<line class="mon-stem ${l}" x1="${cx}" x2="${cx}" y1="${y(b.med).toFixed(1)}" y2="${y(b.min).toFixed(1)}"/><circle class="mon-pt ${l}" cx="${cx}" cy="${y(b.min).toFixed(1)}" r="4"/>`; }
  // Trefferflächen je Abschnitt: Zusammenfassung und der niedrigste Lauf mit allen Werten
  const runTip = (r) => t('app.ofSourcesCurrentErrors', { v0: dt(r[ix.at]), v1: esc(TRIGGER[r[ix.ausloeser]] || r[ix.ausloeser] || '–'), v2: fmt(r[ix.aktuell]), v3: fmt(r[ix.quellen]), v4: pct(share(r)), v5: fmt(r[ix.fehler]), v6: fmt(r[ix.fahrzeuge]), v7: fmt(r[ix.fahrten]), v8: r[ix.dauer_ms] == null ? '–' : fmt(r[ix.dauer_ms] / 1000, 1) + ' s' });
  for (const b of buckets) g += `<rect class="hit" x="${x(b.s).toFixed(1)}" y="${P.t}" width="${(x(b.s + BMS) - x(b.s)).toFixed(1)}" height="${H - P.t - P.b}"><title>${t('app.monBucketTip', { when: `${dt(b.s)}–${timeText(b.s + BMS)}`, n: fmt(b.runs.length), med: pct(b.med), min: pct(b.min) })}${b.low ? `\n\n${runTip(b.low)}` : ''}</title></rect>`;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const today = runs.filter(r => r[ix.at] >= +midnight).length;
  const trig = {}; for (const r of runs) { const k = r[ix.ausloeser] || t('app.unknown'); trig[k] = (trig[k] || 0) + 1; }
  const trigTxt = Object.entries(trig).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${fmt(n)} ${esc(TRIGGER[k] || k)}`).join(' · ');
  const closed = gaps.filter(gp => !gp[2]); const longest = closed.length ? Math.max(...closed.map(([a, b]) => b - a)) : 0;
  const lastAge = now - last[ix.at], dips = buckets.filter(b => b.min != null && lvl(b.min) !== 'ok').length;
  box.innerHTML = `<div class="mon-stats">
    <div>${t('app.lastRun')}<b style="color:var(--${!DEMO && lastAge > GAP ? 'warn' : 'fg'})">${timeText(last[ix.at])}</b>${t('app.ofSourcesCurrent', { v0: DEMO ? new Date(last[ix.at]).toLocaleDateString(fmtLocale()) : t('app.ago2', { lastAge: ageText(lastAge) }), v1: last[ix.dauer_ms] == null ? '' : `${fmt(last[ix.dauer_ms] / 1000, 1)} s · `, v2: fmt(last[ix.aktuell]), v3: fmt(last[ix.quellen]) })}</div>
    <div>${t('app.runsTodayInScheduleEvery20', { today: fmt(today), length: fmt(runs.length), max: fmt(Math.max(1, Math.round((last[ix.at] - runs[0][ix.at]) / 86400e3))), v3: Math.round((last[ix.at] - runs[0][ix.at]) / 86400e3) > 1 ? t('app.days') : t('app.day2') })}<span class="mon-sub">${trigTxt}</span></div>
    <div>${t('app.gapsOver45Min')}<b style="color:var(--${gaps.length ? 'warn' : 'fg'})">${fmt(gaps.length)}</b>${gaps.length ? t('app.longest', { v0: durText(Math.max(longest, ...gaps.filter(gp => gp[2]).map(([a, b]) => b - a))), v1: gaps.some(gp => gp[2]) ? ` · ${t('app.openSinceLastRun')}` : '' }) : t('app.collectorRanWithoutGaps')}</div>
  </div>
  <svg class="chart mon-chart" data-px="1" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${t('app.collectorRunsOfLast7Days')}. ${t('app.monitorSummary', { n: fmt(runs.length), med: med == null ? '–' : fmt(med * 100), gaps: fmt(gaps.length) })}`)}">${g}</svg>
  <div class="legend"><span><i class="lnk"></i>${t('app.monLineKey', { b: B === 1 ? t('app.monHour') : t('app.monHours', { n: B }) })}</span><span><i class="lnk dash"></i>${t('app.usualShareOfCurrentSources', { v0: pct(med) })}</span>${dips ? `<span><i class="dot" style="background:var(--warn)"></i>${t('app.n515PointsBelow')}</span><span><i class="dot" style="background:var(--bad)"></i>${t('app.moreThan15PointsBelow')}</span>` : ''}${gaps.length ? `<span><i class="sq gap-key"></i>${t('app.gapOver45MinWithoutRun')}</span>` : ''}</div>`;
}
function renderQuality() {
  const L0 = state.latest; const box = $('#quality');
  if (!L0) { box.innerHTML = `<div class="empty">${t('app.noCollectorSnapshotYetClean')}</div>`; return; }
  const d = L0.dedupe || {}; const recs = L0.sources || [];
  const tot = { unassigned: 0, outside: 0, missing: 0, repaired: 0, stationFallback: 0, ghosts: 0 };
  for (const r of recs) for (const k in tot) tot[k] += r.counts?.[k] || 0;
  const worst = recs.map(r => ({ r, n: (r.counts?.unassigned || 0) + (r.counts?.outside || 0) + (r.counts?.missing || 0) + (r.counts?.ghosts || 0) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 8);
  box.innerHTML = `<dl class="kv">
    <dt>${t('app.vehicleDuplicatesRemovedSame', { v0: d.prefixVariants ? t('app.ofWhichOnlyWithDifferentId', { prefixVariants: fmt(d.prefixVariants) }) : '' })}</dt><dd>${fmt(d.duplicates)}</dd>
    <dt>${t('app.stationDuplicatesSameIdOr')}</dt><dd>${fmt(d.stationDuplicates)}</dd>
    <dt>${t('app.idsReusedSameIdAtDistant')}</dt><dd>${fmt(d.reusedIds)}</dd>
    <dt>${t('app.noMunicipalityPositionIn')}</dt><dd>${fmt(tot.unassigned)}</dd>
    <dt>${t('app.outsideGermany')}</dt><dd>${fmt(tot.outside)}</dd>
    <dt>${t('app.noCoordinates', { v0: tot.stationFallback ? t('app.replacedByStationPosition', { stationFallback: fmt(tot.stationFallback) }) : t('app.withoutFallbackPosition') })}</dt><dd>${fmt(tot.missing)}</dd>
    ${tot.ghosts ? `<dt>${t('app.orphanedEntriesDisabledAnd')}</dt><dd>${fmt(tot.ghosts)}</dd>` : ''}
    ${tot.repaired ? `<dt>${t('app.coordinatesRepairedSwapped')}</dt><dd>${fmt(tot.repaired)}</dd>` : ''}
  </dl>${worst.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${t('app.sourcesWithMostExclusions')}" style="margin-top:var(--s3)"><table><thead><tr><th>${t('app.source3')}</th><th class="n">${t('app.noMunicipality')}</th><th class="n">${t('app.outside')}</th><th class="n">${t('app.noCoord')}</th><th class="n" title="${t('app.disabledAndWithoutSignalFor')}">${t('app.orphaned2')}</th></tr></thead><tbody>${worst.map(({ r }) => `<tr><td>${esc(r.name || r.id)}<div class="sub-line mono">${esc(r.id)}</div></td><td class="n">${fmt(r.counts?.unassigned || 0)}</td><td class="n">${fmt(r.counts?.outside || 0)}</td><td class="n">${fmt(r.counts?.missing || 0)}</td><td class="n">${fmt(r.counts?.ghosts || 0)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
function renderLicenses() {
  const box = $('#licenses'); const recs = (state.latest?.sources || []).filter(r => !(r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status)));
  if (!recs.length) { box.innerHTML = `<div class="empty">${t('app.noSourcesYetOverviewAppears')}</div>`; return; }
  // Lizenz-Kennung (licenseId, z. B. CC0-1.0) vor URL; die URL bleibt Link
  const by = new Map(); for (const r of recs) { const k = r.licenseId || r.license || r.licenseUrl || ''; const e = by.get(k) || { n: 0, ops: new Set(), url: r.licenseUrl || (/^https?:/i.test(r.license || '') ? r.license : null) }; e.n++; e.ops.add(r.operator); by.set(k, e); }
  const rows = [...by].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  const label = (l, url) => !l ? `<span class="muted">${t('common.na')}</span>` : /^https?:\/\//i.test(l) ? link(l, `${esc(String(l).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''))} ↗`) : url ? link(url, `${esc(l)} ↗`) : esc(l);
  box.innerHTML = `<div class="tbl" tabindex="0" role="region" aria-label="${t('app.licences')}"><table><thead><tr><th>${t('app.licence')}</th><th class="n">${t('app.sources2')}</th><th>${t('app.operator')}</th></tr></thead><tbody>${rows.slice(0, 20).map(([l, e]) => `<tr><td>${label(l, e.url)}</td><td class="n">${fmt(e.n)}</td><td class="small">${esc([...e.ops].sort((a, b) => a.localeCompare(b, 'de')).slice(0, 5).join(', '))}${e.ops.size > 5 ? ` +${e.ops.size - 5}` : ''}</td></tr>`).join('')}</tbody></table></div><div class="muted small" style="margin-top:var(--s2)">${t('app.checkCommercialUsePerLicence', { v0: rows.length > 20 ? ` ${t('app.moreLicenceEntries', { v0: rows.length - 20 })}` : '' })}</div>`;
}
function relCell(id) { const r = state.usage?.reliability?.sources?.[id]; if (!r || !r.runs) return '<span class="muted">–</span>'; const ok = (r.live + r.delayed) / r.runs; return `<span style="color:var(--${ok >= 0.95 ? 'ok' : ok >= 0.8 ? 'warn' : 'bad'})">${pctf(r.live + r.delayed, r.runs)}</span><div class="sub-line">${t('app.runsAvgMs', { runs: r.runs, latencyAvg: fmt(r.latencyAvg) })}</div>`; }
function renderSourceTable() {
  const q = ($('#src-search').value || '').toLowerCase(); const stf = $('#src-status').value;
  const all = (state.latest?.sources || []).filter(r => (stf === 'all' || r.status === stf) && (!q || `${r.id} ${r.name} ${r.operator} ${r.url}`.toLowerCase().includes(q)));
  const hidden = all.filter(r => r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status) && !q);
  // Dubletten und länger verschwundene Quellen bilden eine eigene Gruppe am Ende (kein Fehler)
  const recs = all.filter(r => !hidden.includes(r)).sort((a, b) => (['duplicate', 'retired'].includes(a.status) ? 1 : 0) - (['duplicate', 'retired'].includes(b.status) ? 1 : 0));
  const munis = state.latest?.municipalities || {};
  const { show, rest } = pageRows('src', recs, `${q}|${stf}|${state.latest?.at}`);
  $('#tbl-src tbody').innerHTML = show.map(r => `<tr><td>${link(r.url, esc(r.name || r.id))}${r.attribution && r.attribution !== r.name ? `<div class="sub-line">${esc(r.attribution)}</div>` : ''}<div class="sub-line mono">${esc(r.id)}${r.sourceChanged ? ` · ${t('app.sourceChange2')}` : ''}</div></td><td>${esc(r.operator)}</td><td class="small">${(r.directories || []).map(dirLabel).join(' · ')}</td><td class="n">${esc(r.version || '–')}</td><td class="n">${fmt(r.counts?.vehicles)}<div class="sub-line">${[r.counts?.unassigned ? t('app.noMunicipality2', { unassigned: fmt(r.counts.unassigned) }) : '', r.counts?.outside ? t('app.outside2', { outside: fmt(r.counts.outside) }) : '', r.counts?.missing ? t('app.noCoord2', { missing: fmt(r.counts.missing) }) : ''].filter(Boolean).join(' · ')}</div></td><td class="n">${fmt(r.counts?.stations)}</td><td class="n" title="${esc((r.municipalities || []).slice(0, 12).map(a => munis[a]?.name || a).join(', '))}">${fmt((r.municipalities || []).length)}</td><td class="n">${ageText(r.feedAgeMs)}</td><td class="n">${esc(r.quality ?? '–')}</td><td class="n">${relCell(r.id)}</td><td>${pillStatus(r.status)}${r.status === 'duplicate' && r.duplicateOf ? `<div class="sub-line">${t('app.sameAs', { duplicateOf: esc(r.duplicateOf), v1: r.duplicateShare != null ? ` (${pctf(r.duplicateShare, 1)})` : '' })}</div>` : r.errorCause ? `<div class="sub-line">${esc(String(r.errorCause).slice(0, 60))}</div>` : r.errors?.length ? `<div class="sub-line">${esc(tx(String(r.errors[0])).slice(0, 60))}</div>` : ''}</td><td class="small">${r.licenseId ? (r.licenseUrl ? link(r.licenseUrl, `${esc(r.licenseId)} ↗`) : esc(r.licenseId)) : r.license ? (/^https?:\/\//i.test(r.license) ? link(r.license, t('app.licence2')) : esc(r.license)) : `<span class="muted">${t('common.na')}</span>`}</td></tr>`).join('') || emptyRow(12, t('app.noMatches'), q || stf !== 'all' ? t('app.clearSearchOrChooseAllStates') : state.latest ? t('app.noSourcesInCollectorSnapshot') : failedText('latest.json'));
  $('#src-more').innerHTML = [moreBtn('src', rest, ` ${t('app.orNarrowSearch')}`), hidden.length ? t('app.checkedDirectFeedCandidates', { length: fmt(hidden.length) }) : ''].filter(Boolean).join(' ');
}
// ---------- Nutzung & Bewegung ----------
state.usage = { index: null, day: /^\d{4}-\d{2}-\d{2}$/.test(QS.get('day') || '') ? QS.get('day') : null, docs: {}, cells: {}, idle: null, idleLong: null, quota: null, pricing: null, zonesIndex: null, zones: {}, reliability: null, consistency: null, weather: {} };
// Alle Lader über den Promise-Cache: parallele Aufrufer teilen sich einen Download, fehlende Dateien werden nicht je Aufruf neu angefragt
async function loadUsageIndex() { if (!state.usage.index) { const r = await cached('events/index.json', 25000); state.usage.index = r.json || { days: [], cellDays: [] }; } return state.usage.index; }
async function loadEvents(day) { if (!(day in state.usage.docs)) { const r = await cached(`events/${day}.json`, 60000); state.usage.docs[day] = r.json || null; } return state.usage.docs[day]; }
async function loadCells(day, st) { const k = `${day}/${st}`; if (!(k in state.usage.cells)) { const r = await cached(`cells/${day}/${st}.json`, 60000); state.usage.cells[k] = r.json || null; } return state.usage.cells[k]; }
async function loadOnce(name, file, timeout = 60000) { if (state.usage[name] === undefined || state.usage[name] === null) { const r = await cached(file, timeout); state.usage[name] = r.json || null; } return state.usage[name]; }
const scopeState = () => state.latest?.municipalities?.[state.scope]?.state || null;
const groupInScope = (k) => { const [ags, op, ty] = k.split('|'); if (ags === 'DE') return false; if (state.scope !== 'DE' && ags !== state.scope) return false; if (state.operator !== 'all' && op !== state.operator) return false; if (state.type !== 'all' && ty !== state.type) return false; return true; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const durText = (ms) => ms == null || !Number.isFinite(ms) ? '—' : ms < 3600e3 ? t('app.min', { v0: fmt(ms / 60e3) }) : t('app.h', { v0: fmt(ms / 3600e3, 1) });

// Vorauswahl Nutzung (und Umsatz der Disposition): letzter voller Messtag (≥ R.FULL_DAY_HOURS Stunden mit ≥ R.FULL_HOUR_MIN Min. Beobachtung,
// wie Bericht und Tagesgang-Profil), sonst der letzte abgeschlossene Tag. Der laufende Tag (Tag des jüngsten Sammler-Laufs) bleibt wählbar.
const runningDay = (days) => { const d = days[days.length - 1]; return d && state.latest?.at && BERLIN_DAY.format(state.latest.at) === d ? d : null; };
const partialHour = () => String(hourOf(state.latest.at)).padStart(2, '0'); // Ereignisse des laufenden Tages reichen bis zum Beginn dieser Stunde
async function defaultUsageDay(days) {
  const run = runningDay(days), cand = days.slice(-7).filter(d => d !== run).reverse();
  for (const d of cand) { const doc = await loadEvents(d); if (doc && R.hourQuality(doc.runs, doc.gapHours).full) return d; }
  return cand[0] || days[days.length - 1];
}
async function renderUsage() {
  const idx = await loadUsageIndex();
  const days = idx.days || [];
  const box = $('#usage-tiles');
  renderArchive().catch(() => {});
  if (!days.length) { renderIdle(days).catch(() => {}); renderQuota().catch(() => {}); box.innerHTML = ''; $('#usage-note').textContent = t('app.noEventDataYetCollectorNeeds'); $('#chart-usage').innerHTML = `<div class="empty">${t('app.noMovementsMeasuredYetThey')}</div>`; $('#tbl-usage tbody').innerHTML = `<tr><td colspan="6" class="empty">${t('app.noDataYetMovementsAppear')}</td></tr>`; $('#tbl-usage-more tbody').innerHTML = `<tr><td colspan="7" class="empty">${t('app.noDataYet2')}</td></tr>`; return; }
  const day = state.usage.day && days.includes(state.usage.day) ? state.usage.day : await defaultUsageDay(days);
  state.usage.day = day;
  // laufender Tag: „02.11. bis 08 Uhr“ (Ereignisse nur aus abgeschlossenen Stunden)
  const run = runningDay(days), runH = run ? partialHour() : null;
  setChips($('#usage-days'), 'data-uday', days.slice(-7).map(d => { const note = dayNote(d), dm = `${esc(d.slice(8))}.${esc(d.slice(5, 7))}.`, tip = [d === run ? t('app.usagePartialDayTip', { h: runH }) : '', note || ''].filter(Boolean).join(' · '); return `<button class="chip ${d === day ? 'on' : ''}${note ? ' special' : ''}" aria-pressed="${d === day}" data-uday="${esc(d)}"${tip ? ` title="${esc(tip)}"` : ''}>${d === run ? t('app.usageDayUntil', { d: dm, h: runH }) : dm}${note ? '<span aria-hidden="true"> ✱</span>' : ''}</button>`; }).join(''));
  const doc = await loadEvents(day);
  // Standzeiten (idle.json) und Stationsquote (stations-quota.json) hängen nicht an der Ereignisdatei: auch ohne sie zeichnen
  renderIdle(days).catch(e => console.error('Standzeiten', e)); renderQuota().catch(e => console.error('Stationsquote', e));
  if (!doc) {
    box.innerHTML = ''; $('#usage-note').textContent = t('app.chooseAnotherDayOrReload', { v0: failedText(`events/${day}.json`) });
    $('#chart-usage').innerHTML = `<div class="empty">${t('app.eventFileNotLoadableChoose')}</div>`;
    for (const [id, n] of [['#tbl-usage', 6], ['#tbl-usage-more', 7], ['#tbl-cells', 5], ['#tbl-econ', 6], ['#tbl-econ-more', 7]]) { const tb = $(`${id} tbody`); if (tb) tb.innerHTML = emptyRow(n, t('app.noEventDataForThisDay'), t('app.chooseAnotherDay')); }
    for (const id of ['#econ-tiles', '#econ-calib', '#econ-excl']) { const el = $(id); if (el) el.innerHTML = ''; }
    return;
  }
  const runs = doc.runs || [];
  // Messlücken: Stunden ohne Lauf oder mit Lauf nach > 45 Min. Pause zählen weder in Summen noch im Tagesgang (Vertrag 5, doc.gapHours)
  const mask = hourMask(runs, doc.gapHours);
  const observedMs = runs.filter(r => r[1] != null && !isGapRun(r) && mask.ok[hourOf(r[0])]).reduce((a, r) => a + Math.min(r[1], GAP_MS), 0);
  const gapH = mask.gap.filter(Boolean).length;
  const note = dayNote(day);
  $('#usage-note').innerHTML = t('app.collectorRunsOn0024Observed', { v0: note ? `<b>${esc(note)}</b> · ` : '', length: fmt(runs.length), join: esc(day.split('-').reverse().join('.')), observedMs: durText(observedMs), v4: timeText(runs[0]?.[0]), v5: timeText(runs[runs.length - 1]?.[0]), v6: gapH ? ` · ${t('app.notCounted', { v0: abbr(t('app.hAfterMeasurementGap', { gapH }), 'gap') })}` : '' });
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
    tile(t('app.tripsMeasured'), fmt(starts), (day === run ? `${t('app.usagePartialDay', { h: runH })} · ` : '') + t('app.inOfObservationTripEnds', { observedMs: durText(observedMs), ends: fmt(ends), v2: gapH ? ` · ${t('app.excludingHAfterMeasurement', { gapH })}` : '' })),
    tile(abbr(t('app.rebalancing'), 'reloc'), fmt(reloc), t('app.sameIdMoved150MDidNot')),
    tile(t('app.batterySwaps'), fmt(swaps), tot.swapWaitN ? t('app.avgBelow20UntilSwap', { v0: atLeast(tot.swapWaitCens, durText(tot.swapWaitSum / tot.swapWaitN)) }) + (tot.swapWaitCens ? ` · ${t('trk.censoredOf', { n: fmt(tot.swapWaitCens), of: fmt(tot.swapWaitN) })}` : '') : t('app.jumpFrom40To85AtSameSpot')),
    tile(abbr(t('app.pickups'), 'pickup'), fmt(pickups), t('app.disabledOrNearlyEmpty2')),
    tile(t('app.disabledDuration'), tot.disDurN ? atLeast(tot.disDurCens, durText(tot.disDurSum / tot.disDurN)) : '—', t('app.vehiclesReleasedAgain', { sum: fmt(sum(tot.disOff)) }) + (tot.disDurCens ? ` · ${t('trk.censoredOf', { n: fmt(tot.disDurCens), of: fmt(tot.disDurN) })}` : '')),
  ].join('');
  // Tagesgang: eigene Filter im Panel (Vorgabe aus den globalen Filtern); Änderung zeichnet nur das Diagramm neu
  let weather = null;
  if ($('#chk-weather').checked) weather = await loadWeather(day);
  state.usage.chartData = { doc, weather, runs, mask };
  usageChartOptions(doc); renderUsageChart(); renderMbMatrix();
  // Tabelle je Anbieter: sechs Standardspalten, der Rest unter „Weitere Spalten“
  const list = [...byOp].sort((a, b) => sum(b[1].start) - sum(a[1].start));
  const opCell = (name) => `<td><span class="op"><i style="background:${opColor(name)}"></i>${esc(name)}</span></td>`;
  $('#tbl-usage tbody').innerHTML = list.map(([name, a]) => `<tr>${opCell(name)}<td class="n">${fmt(sum(a.start))}</td><td class="n">${fmt(sum(a.end))}</td><td class="n">${fmt(sum(a.reloc))}</td><td class="n">${fmt(sum(a.swap))}</td><td class="n">${fmt(sum(a.pickup))}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">${t('app.noEventsInFilterSetOperator')}</td></tr>`;
  $('#tbl-usage-more tbody').innerHTML = list.map(([name, a]) => { const modes = Object.entries(doc.srcModes || {}).filter(([id]) => (state.latest?.sources || []).some(r => r.id === id && r.operator === name && (state.scope === 'DE' || (r.municipalities || []).includes(state.scope)))).map(([, m]) => m); const mk = modes.includes('stable') ? 'stable' : modes.includes('rotating') ? 'rotating' : 'open', mode = { stable: t('app.stableIds'), rotating: t('app.rotatingIds'), open: t('app.open') }[mk];
    return `<tr>${opCell(name)}<td class="n">${a.tripDurN ? durText(a.tripDurSum / a.tripDurN) : '—'}</td><td class="n">${a.tripDistN ? `${fmt(a.tripDistSum / a.tripDistN / 1000, 1)} km` : '—'}</td><td class="n">${a.swapWaitN ? atLeast(a.swapWaitCens, durText(a.swapWaitSum / a.swapWaitN)) : '—'}</td><td class="n">${fmt(sum(a.disOff))}</td><td class="n">${a.disDurN ? atLeast(a.disDurCens, durText(a.disDurSum / a.disDurN)) : '—'}</td><td class="small">${mode}<div class="sub-line">${mk === 'stable' ? t('app.durationDistanceMeasurable') : mk === 'rotating' ? t('app.startDestinationCountsOnly') : t('app.tooFewRunsYet')}</div></td></tr>`; }).join('') || `<tr><td colspan="7" class="empty">${t('app.noEventsInFilter')}</td></tr>`;
  renderCellsTable(day); if (!isClient()) renderEcon(day, doc).catch(e => console.error('Umsatz', e)); // Kalibrierung steht nur unter Datenvertrauen › Quellen
}
// Standzeiten der verfügbaren Fahrzeuge (idle.json, Sammler-Stand), unabhängig vom gewählten Tag
async function renderIdle(days) {
  const idle = await loadOnce('idle', 'idle.json');
  if (!idle) { $('#idle-bars').innerHTML = `<div class="empty">${esc(failedText('idle.json'))}</div>`; return; }
  // Klassen aus idle.json (ab 02.11.2026 sechs mit „> 72 h“, die Summe steht dahinter); censored = davon Mindestwerte (seit Beginn der Verfolgung unbewegt, Z6)
  const labels0 = idle.buckets || ['<2 h', '2–8 h', '8–24 h', '1–2 Tage', '>2 Tage'], nb = labels0.length;
  const ib = new Array(nb).fill(0), ic = new Array(nb).fill(0); let in_ = 0;
  for (const [k, a] of Object.entries(idle.groups || {})) { if (!groupInScope(k)) continue; for (let i = 0; i < nb; i++) ib[i] += a[i] || 0; in_ += a[nb] || 0; const c = idle.censored?.[k]; if (c) for (let i = 0; i < nb; i++) ic[i] += c[i] || 0; }
  const labels = labels0.map(l => l === '2–3 Tage' ? t('trk.idle23d') : l === '> 72 h' ? t('trk.idle72h') : tx(l)); // Beschriftungen aus idle.json (Sammler, deutsch)
  const imax = Math.max(1, ...ib), cn = ic.reduce((a, b) => a + b, 0);
  // Anteil der Mindestwerte hell am Ende des Balkens
  const bg = (i) => { const col = i >= 3 ? 'var(--warn)' : 'var(--accent)', cs = ib[i] ? ic[i] / ib[i] : 0, p = ((1 - cs) * 100).toFixed(1); return cs ? `linear-gradient(90deg,${col} ${p}%,color-mix(in srgb,${col} 35%,transparent) ${p}%)` : col; };
  const dt2 = (ms) => dateTimeText(ms, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), ts = idle.trackStart;
  // Quellen ohne Standzeit (Z5) im Gebiet und für den Anbieter der Auswahl
  const unus = (idle.unusable || []).filter(id => { const r = (state.latest?.sources || []).find(x => x.id === id); return r && (state.scope === 'DE' || (r.municipalities || []).includes(state.scope)) && (state.operator === 'all' || r.operator === state.operator); });
  const cnote = ts ? `<div class="muted small" style="margin-top:4px">${t('trk.idleMeasurable', { start: dt2(ts), d48: dt2(ts + 48 * 3600e3), d72: dt2(ts + 72 * 3600e3), share: pctf(cn, in_) })}</div>` : '';
  $('#idle-bars').innerHTML = in_ ? labels.map((l, i) => `<div class="hbar"${ic[i] ? ` title="${esc(t('trk.idleClassCensored', { share: pctf(ic[i], ib[i]) }))}"` : ''}><span>${esc(l)}</span><div class="bar"><i style="width:${(ib[i] / imax) * 100}%;background:${bg(i)}"></i></div><span class="n mono">${pctf(ib[i], in_)}</span></div>`).join('') + `<div class="muted small" style="margin-top:6px">${t('app.availableVehiclesAsOfTime', { in_: fmt(in_), v1: timeText(idle.at), join: esc((days[0] || '').split('-').reverse().join('.')) })}</div>${cnote}${unus.length ? `<div class="muted small" style="margin-top:4px">${t('trk.idleUnusableNote', { n: fmt(unus.length) })}</div>` : ''}` : `<div class="empty">${t('app.noIdleTimesInFilterSet')}</div>`;
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
  const order = Object.keys(TYPE), rank = (tq) => order.includes(tq) ? order.indexOf(tq) : 99;
  $('#usage-op').innerHTML = `<option value="all">${t('app.all')}</option>` + [...ops].sort((a, b) => a.localeCompare(b, 'de')).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  $('#usage-type').innerHTML = `<option value="all">${t('app.all')}</option>` + [...types].sort((a, b) => rank(a) - rank(b)).map(tq => `<option value="${esc(tq)}">${esc(TYPE[tq] || tq)}</option>`).join('');
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
  const box = $('#chart-usage');
  box.innerHTML = series.length ? hourChart(series, c.weather, c.runs, c.mask, dayNote(state.usage.day), chartWidth(box, () => renderUsageChart())) : `<div class="empty">${t('app.noTripStartsForThisSelection')}</div>`;
  $('#usage-chart-sub').textContent = (perType ? t('app.tripStartsPerHourByVehicle', { op, v1: type !== 'all' ? ` ${t('app.only', { tyLabel })}` : '' }) : t('app.tripStartsPerHourAndOperator', { v0: type !== 'all' ? ` · ${tyLabel}` : '', v1: all.length > 8 ? ` · ${t('app.top8Of', { length: all.length })}` : '' })) + (c.weather ? ` · ${t('app.weather', { name: c.weather.name })}` : '');
  $('#usage-legend').innerHTML = series.map((x, i) => `<span><i class="dot" style="background:${x.color || palette(i)}"></i>${esc(x.name)} <span class="mono">${fmt(sum(x.values))}</span></span>`).join('') + (c.weather && series.length ? `<span><i class="sq rain-key"></i>${t('app.precipitationBarsTemperature')}</span>` : '') +(series.length && ok.some(v => !v) ? `<span><i class="sq gap-key"></i>${abbr(t('app.notMeasuredAfterMeasurement'), 'gap')}</span>` : '');
}
// ---------- Umsatz & Kennzahlen ----------
function econOpts() {
  const m = +$('#econ-min')?.value;
  return { rideMin: Number.isFinite(m) && m > 0 ? m : null, realization: Math.min(1, Math.max(0.1, (+$('#econ-real')?.value || 85) / 100)), net: $('#econ-net') ? $('#econ-net').checked : true };
}
// Tagesgang je Tagtyp des gewählten Tags im Land des Gebiets (lib/pulse-econ.js dayType, calendar.json): geladen werden nur volle Tage
// desselben Typs laut Messbasis (latest.json → measure, die jüngsten 7); ohne Messbasis die letzten 7 abgeschlossenen Tage wie bisher
async function econProfile(day) {
  const land = state.scope === 'DE' ? null : scopeState(), cal = state.calendar || null, ty = E.dayType(day, land, cal), key = `${ty}|${land}|${state.latest?.at}`;
  const P = (econProfile.cache ??= new Map()); if (P.has(key)) return (state.usage.profile = P.get(key)); // state.usage.profile: zuletzt genutzte Kurve (Disposition)
  const idx = await loadUsageIndex(); const all = (idx.days || []).slice(0, -1); // abgeschlossene Tage
  const md = state.latest?.measure?.version >= 1 ? state.latest.measure.days || {} : null;
  const pick = md ? all.filter(d => md[d]?.full && E.dayType(d, land, cal) === ty).slice(-7) : all.slice(-7);
  const prof = E.hourProfile(await Promise.all(pick.map(loadEvents)), { dayType: ty, land, calendar: cal });
  P.set(key, prof); return (state.usage.profile = prof);
}
// Kennzahlen je Gruppe (Gemeinde|Anbieter|Art) eines Tages; Ergebnis je Schlüssel.
// Je Gruppe: m = gemessen (Ø Fahrt aus der Kalibrierung: E-Scooter Berliner Quartalswerte, sonst Annahme), cal = × Faktor (pulse-calib factorFor:
// eigene Korrektur übersteuert, sonst k für E-Scooter), lo/hi = Spanne des Faktors; die Gruppe selbst trägt die Werte des gewählten Modus.
async function econGroups(day, keep) {
  // Audit OPS-04: für abgeschlossene Tage reicht das Tagesmittel aus history/daily.json (Ø Bestand als Rückfall), statt je Tag history/<Tag>.json (3–5 MB)
  const histDay = async (d) => { if (d < FC_dayOfNow()) { const dl = await loadDaily(); const h = dl ? R.histFromDaily(dl, d) : null; if (h) return h; } return loadHistory(d); };
  const [doc, pricing, hist, prof, calib] = await Promise.all([loadEvents(day), loadOnce('pricing', 'pricing.json'), histDay(day), econProfile(day), getCalib()]);
  if (!doc) return null;
  // Fahrzeugminuten nur nutzen, wenn alle Läufe des Tages sie gezählt haben (Umstellungstag: Ø Bestand aus dem Verlauf)
  // Stunden ohne Messung oder mit Lücken-Lauf (> 45 Min. Pause, Flag 0) fallen aus Beobachtungszeit, Fahrten und Fahrzeugminuten: keine Hochrechnung aus Lücken
  const runs = doc.runs || [], mask = hourMask(runs, doc.gapHours);
  // Fahrzeugminuten gelten, wenn jeder Lauf ein Flag trägt (1 = zählt, 0 = Lücke); ältere Tage ohne Flag: Ø Bestand aus dem Verlauf
  const vminOk = runs.every(r => r[1] == null || r[2] === 1 || r[2] === 0 || isGapRun(r));
  const obsMin = E.observedMinutes(runs).map((m, h) => mask.ok[h] ? m : 0), obsMinV = vminOk ? E.observedMinutesEnd(runs).map((m, h) => mask.ok[h] ? m : 0) : new Array(24).fill(0); const o = econOpts(); // S1.1: Abdeckung anteilig, Fahrzeugminuten in der Endstunde
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
    const fac = K.factorFor(ty, { manual: calibFor(op), k: calib?.k, mode: 'kal', suspended: chk.suspended, kind: calib?.kinds?.[k] ?? null, op }); // k nur für die Kennungsart der Berliner Referenz
    // kalibrierte Fahrten je Fahrzeug und Tag höchstens bis zur Plausibilitätsgrenze der Art (lib/pulse-calib.js cappedFactor)
    const lim = { limit: calib?.limits?.[ty] ?? null };
    const cal = K.applyFactor(m, fac.f, lim);
    out.set(k, { ...(mode === 'kal' ? cal : m), m, cal, lo: K.applyFactor(m, fac.lo, lim), hi: K.applyFactor(m, fac.hi, lim), fac, plan: pl, op, ty, ags });
  }
  return { out, doc, obsMin, profile: prof, gapH: mask.gap.filter(Boolean).length, calib };
}
// für die Disposition: Kennzahlen eines Anbieters in einer Gemeinde (letzter voller Tag wie die Vorauswahl der Nutzung, Werte des gewählten Modus)
async function econFor(ags, op, type) {
  const idx = await loadUsageIndex(); if (!idx.days?.length) return null; const day = await defaultUsageDay(idx.days);
  const r = await econGroups(day, (k) => { const [a, o, tq] = k.split('|'); return a === ags && o === op && (type === 'all' || tq === type); });
  return r ? E.combine([...r.out.values()]) : null;
}
// Kalibrierung: geteilt mit dem Bericht (report.js loadCalibration), Modus „kalibriert“ / „gemessen“ je Browser gemerkt
const getCalib = () => Rp.loadCalibration(rpCtx());
const MODE_KEY = 'mp-calib-mode';
function calibMode() { try { return localStorage.getItem(MODE_KEY) === 'mess' ? 'mess' : 'kal'; } catch { return 'kal'; } }
function setCalibMode(m) { try { localStorage.setItem(MODE_KEY, m === 'mess' ? 'mess' : 'kal'); } catch { /* privates Fenster: Standard „kalibriert“ */ } }
// Schalter zeigt den wirksamen Zustand (B3): „kalibriert“ gedrückt nur, wenn ein Faktor tatsächlich wirkt (k angewandt oder eigene Korrektur);
// sonst gesperrt (aria-disabled, Klick ohne Wirkung), Zustand im Knopftext („gesperrt“, „vorläufig“ …), Grund per aria-describedby (#econ-calib-state).
function syncCalibToggle(st = null) {
  const m = calibMode(), eff = st ? st.effective : true;
  $$('#econ-mode button[data-cmode]').forEach(b => {
    const kalB = b.dataset.cmode === 'kal';
    b.setAttribute('aria-pressed', String(kalB ? m === 'kal' && eff : m === 'mess' || !eff));
    if (!kalB || !st) return;
    const lock = eff ? '' : st.label;
    b.textContent = lock ? `${t('html.calibrated')} · ${lock}` : t('html.calibrated');
    if (lock) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-describedby', 'econ-calib-state'); } else { b.removeAttribute('aria-disabled'); b.removeAttribute('aria-describedby'); }
  });
}
async function renderEcon(day) {
  const r = await econGroups(day, groupInScope);
  syncCalibToggle(r ? null : { effective: false, label: t('cal.btnOff') });
  if (!r) { $('#econ-tiles').innerHTML = ''; $('#econ-excl').innerHTML = ''; $('#econ-calib').innerHTML = ''; $('#econ-badge').textContent = t('app.estimate'); $('#tbl-econ tbody').innerHTML = emptyRow(6, t('app.noEventDataForThisDay'), t('app.chooseAnotherDay')); $('#tbl-econ-more tbody').innerHTML = emptyRow(7, t('app.noEventDataForThisDay'), t('app.chooseAnotherDay')); return; }
  const kal = calibMode() === 'kal', k = r.calib?.k, sc = r.calib?.assume?.scooter;
  const byName = new Map();
  for (const x of r.out.values()) { const name = `${x.op}|${x.ty}`; if (!byName.has(name)) byName.set(name, []); byName.get(name).push(x); }
  // je Anbieter × Art: Gemeinden mit unplausibler Messung (Überzählung, > 15) fallen aus der Zeile; sind alle unplausibel, ist die Zeile es
  const rows = [...byName].map(([name, list0]) => { const [op, ty] = name.split('|'); const okL = list0.filter(x => x.m.plausible); const list = okL.length ? okL : list0; const dropped = okL.length ? list0.filter(x => !x.m.plausible) : [];
    const c = E.combine(list); const plans = [...new Set(list.map(x => x.plan?.plan ? E.planLabel(x.plan.plan) : null).filter(Boolean))];
    return { op, ty, c, cm: E.combine(list.map(x => x.m)), cc: E.combine(list.map(x => x.cal)), lo: E.combine(list.map(x => x.lo)), hi: E.combine(list.map(x => x.hi)), fac: list[0].fac, dur: [...new Set(list.map(x => x.m.durationSource))], list, dropped, plans, planScope: list.find(x => x.plan)?.plan?.scope, planUnclear: list.find(x => x.plan?.unclear)?.plan || null }; })
    .filter(x => x.c && x.c.fleet > 0).sort((a, b) => (b.c.revDay || 0) - (a.c.revDay || 0) || b.c.rides - a.c.rides);
  const good = rows.filter(x => x.c.plausible);
  const T = { cm: E.combine(good.map(x => x.cm)), cc: E.combine(good.map(x => x.cc)), lo: E.combine(good.map(x => x.lo)), hi: E.combine(good.map(x => x.hi)) };
  const tot = kal ? T.cc : T.cm;
  // Wirksamer Faktor (B3): k angewandt und für eine Zeile passend (Kennungsart) bzw. eigene Korrektur; sonst gemessen mit Zustand von k
  const facs = rows.flatMap(x => x.list.map(y => y.fac)), anyK = facs.some(f => f.source === 'kalibriert'), anyCorr = facs.some(f => f.source === 'Korrektur');
  const skipOps = [...new Set(rows.filter(x => x.list.some(y => y.fac.skip === 'kind')).map(x => `${x.op} (${K.kindText(x.list.find(y => y.fac.skip === 'kind').fac.kind, lang())})`))];
  const kShort = !k ? t('cal.btnOff') : k.applied ? (anyK ? '' : t('cal.btnNoEffect')) : { locked: t('cal.btnLocked'), prelim: t('cal.btnPrelim') }[k.status] || t('cal.btnOff');
  const effective = kal && (anyK || anyCorr);
  syncCalibToggle({ effective: anyK || anyCorr, label: kShort });
  const facTag = effective ? (anyK ? t('cal.tileK', { k: fmt(k.k, 2) }) : t('cal.tileCorr')) : t('cal.tileNoK', { v0: kal && kShort ? ` (k ${kShort})` : '' });
  const cov = Math.max(0, ...rows.map(x => x.c.coverage || 0));
  const o = econOpts(); const euro = (v, d = 0) => v == null ? '—' : `${fmt(v, d)} €`;
  // Reifegrad: Läufe und Messbeginn am Panel; unter 3 vollen Messtagen Hochrechnungen nur als Spanne
  const idx = await loadUsageIndex(); const first = (idx.days || [])[0]; const runsN = (r.doc.runs || []).length;
  const dd = (d) => d ? dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T12:00:00Z`)) : '–';
  $('#econ-badge').textContent = first && first !== day ? t('app.estimateRunsOnDataSince', { runsN: fmt(runsN), day: dd(day), first: dd(first) }) : t('app.estimateRunsSince', { runsN: fmt(runsN), v1: dd(first || day) });
  const prelim = r.profile.source === 'Standardkurve' || (r.profile.days ?? 0) < 3;
  const pb = $('#econ-prelim'); pb.hidden = !prelim; pb.title = t('app.onlyFullMeasurementDaysSoFar', { v0: fmt(r.profile.days ?? 0) });
  const rng = (v, d = 0, unit = '') => { if (v == null || !Number.isFinite(v)) return '—'; if (!prelim || v === 0) return `${fmt(v, d)}${unit}`; const f = (x) => x >= 100 ? fmt(sig2(x)) : fmt(x, d); return `${f(v * 0.7)}–${f(v * 1.3)}${unit}`; };
  const fu = (v, d = 0, unit = '') => (v == null || !Number.isFinite(v) ? '—' : `${v >= 1000 && d === 0 ? fmt(sig2(v)) : fmt(v, d)}${unit}`);
  // gemessen und kalibriert nebeneinander: Hauptwert nach Modus, der andere darunter; ohne Faktor wie bisher
  const pair = (x, key, { d = 0, unit = '', scale = 1, mKey = 'app.measured', m2Key = 'app.measured2' } = {}) => {
    const g = (o2) => (o2?.[key] == null ? null : o2[key] * scale);
    const m = g(x.cm), c = g(x.cc), lo = g(x.lo), hi = g(x.hi);
    if (m == null || c == null || Math.abs(c - m) <= 1e-9 * Math.max(1, Math.abs(m))) return { main: rng(m, d, unit), sub: '' };
    const span = lo != null && hi != null && Math.abs(hi - lo) > 1e-9 ? `${fu(lo, d)}–${fu(hi, d, unit)}` : null;
    return kal ? { main: fu(c, d, unit), sub: t(mKey, { v0: span ? `${t('app.range', { span })} · ` : '', v1: rng(m, d, unit) }), lines: [span ? t('app.range', { span }) : null, t(m2Key, { v0: rng(m, d, unit) })].filter(Boolean) } : { main: rng(m, d, unit), sub: t('app.calibrated', { v0: fu(c, d, unit) }), lines: [t('app.calibrated', { v0: fu(c, d, unit) })] };
  };
  // Tabellenzelle: Hauptwert, darunter Spanne und Vergleichswert je eine Zeile (schmale Spalten)
  const cell = (p, bold = false) => `${bold ? '<b>' : ''}${p.main}${bold ? '</b>' : ''}${(p.lines || []).map(l => `<div class="sub-line">${l}</div>`).join('')}`;
  const tsub = (p, base) => [p.sub, base, facTag].filter(Boolean).join(' · '); // Fahrten-Kacheln nennen, ob ein Faktor drin ist (B3)
  $('#econ-tiles').classList.toggle('prelim', prelim);
  // Einheiten mit geschütztem Leerzeichen: Spanne „a–b €“ bricht nie zwischen Zahl und Einheit
  const pR = pair(T, 'ridesDay', { mKey: 'app.measuredDayFill', m2Key: 'app.measuredDayFill2' }), pV = pair(T, 'rvd', { d: 2 }), pU = pair(T, 'utilization', { d: 1, unit: ' %', scale: 100 }), pD = pair(T, 'revDay', { unit: ' €' }), pF = pair(T, 'revPerVehicleDay', { d: 2, unit: ' €' });
  // „Fahrten je Tag“ mit Basis (gewählter Tag, mit Faktor oder gemessen); der Kommunal-Bericht nennt dort „Ø n Tage“
  const run = runningDay(idx.days || []), dayLbl = `${day.slice(8)}.${day.slice(5, 7)}.`;
  $('#econ-tiles').innerHTML = tot ? [
    tile(t('app.tripsDay', { d: day === run ? t('app.usageDayUntil', { d: dayLbl, h: partialHour() }) : dayLbl }), pR.main, [facTag, pR.sub, t('app.fromMeasuredOfDailyProfile', { rides: fmt(T.cm.rides), v1: fmt(cov * 100) })].filter(Boolean).join(' · ')),
    tile(abbr(t('app.tripsVehDay'), 'rvd'), pV.main, tsub(pV, t('app.avgVehiclesOnStreet', { fleet: fmt(tot.fleet) }))),
    tile(abbr(t('app.utilisation'), 'util'), pU.main, tsub(pU, t('app.timeOnTripsAvgMinPerTrip', { avgMin: fmt(tot.avgMin, 1) }))),
    tile(t('app.revenueDay', { v0: o.net ? t('common.net') : t('common.gross') }), pD.main, tsub(pD, t('app.listPricesOfFeeds', { v0: abbr(t('app.realisation'), 'real'), v1: fmt(o.realization * 100) }))),
    tile(t('app.revenueVehDay'), pF.main, tsub(pF, t('app.perTrip', { v0: euro(tot.perRide, 2) }))),
  ].join('') : `<div class="empty" style="grid-column:1/-1">${t('app.noReliableRowInFilterAllRows')}</div>`;
  // Reifegrad an den Hochrechnungen (Fahrten/Tag, je Fahrzeug, Auslastung, Umsatz): Tagtyp des gewählten Tags, Tagesgang dieses Typs
  { const land = state.scope === 'DE' ? null : scopeState(); Rp.mbTiles($('#econ-tiles'), Rp.mbBadge(Rp.mbBase(state, { land }), 'full3', { dayType: E.dayType(day, land, state.calendar), curve: t('mb.curve', { v: `${esc(tx(r.profile.source))} (${Rp.mbTypeName(r.profile.dayType || 'W')})` }) })); }
  // Unplausible Zeilen sind aus den Summen raus – sichtbar machen
  const bad = [...rows.filter(x => !x.c.plausible), ...rows.flatMap(x => (x.dropped || []).map(d => ({ ...x, c: d.m, where: muniName(d.ags) })))]; const names = bad.map(x => `${x.op} ${TYPE[x.ty] || x.ty}${x.where ? ` ${x.where}` : ''}`);
  const ex = $('#econ-excl'); ex.innerHTML = bad.length ? `${t('app.totalsWithout', { join: esc(names.slice(0, 4).join(', ')), v1: names.length > 4 ? ` ${t('app.andMore', { v0: names.length - 4 })}` : '' })} <span class="muted">${t('app.notReliable')}</span>` : '';
  ex.title = bad.map(x => `${x.op} ${TYPE[x.ty] || x.ty}: ${flagText(x.c.flags[0]) || t('app.implausible')}`).join('\n');
  const cal = calibAll();
  const facTxt = (x) => (x.fac.source === 'Korrektur' ? t('app.correction', { f: fmt(x.fac.f, 2) }) : x.fac.source === 'kalibriert' ? t('app.calibrated2', { f: fmt(x.fac.f, 2) }) : '');
  const DUR = { kalibriert: t('app.berlinMean'), gemessen: t('app.measured3'), Annahme: t('app.assumption'), Vorgabe: t('app.default') };
  // Sechs Standardspalten; Korrektur, Auslastung, Dauer, Tarif und Einzelpreise unter „Weitere Spalten“. Nicht belastbare Zeilen: Kennzeichnung statt Ausgrauen.
  const nameCell = (x) => { const c = x.c; const dr = x.dropped || []; return `<td><span class="op"><i style="background:${opColor(x.op)}"></i>${esc(x.op)}</span><div class="sub-line">${esc(TYPE[x.ty] || x.ty)}${state.scope === 'DE' ? ` · ${x.list.length} ${x.list.length === 1 ? t('app.municipality') : t('app.municipalities2')}` : ''}</div>${!c.plausible ? `<span class="pill excl-tag">${t('app.notInTotal')}</span>` : ''}${c.flags.length ? `<div class="sub-line warn-text flag-line">${esc(flagText(c.flags[0]))}</div>` : ''}${dr.length ? `<div class="sub-line warn-text flag-line">${t('app.without', { join: esc(dr.slice(0, 3).map(d => muniName(d.ags)).join(', ')), v1: dr.length > 3 ? ` +${dr.length - 3}` : '', v2: esc(flagText(dr[0].m.flags[0]) || t('app.implausible')) })}</div>` : ''}</td>`; };
  $('#tbl-econ tbody').innerHTML = rows.map(x => { const c = x.cm;
    return `<tr${!x.c.plausible ? ' class="row-excl"' : ''}>${nameCell(x)}
      <td class="n">${fmt(c.fleet)}</td><td class="n">${fmt(c.rides)}<div class="sub-line">${kal && x.fac.source === 'ausgesetzt' ? t('app.notCalibrated') : kal && x.fac.skip === 'op' ? esc(t('cal.notOp', { ops: (x.fac.ops || []).join(', ') })) : kal && x.fac.skip ? esc(t('cal.notKind', { v0: K.kindText(x.fac.kind, lang()) })) : kal && facTxt(x) ? esc(facTxt(x)) : c.rot ? `${fmt(c.rot)} ${abbr(t('app.idRotation'), 'rot')}` : ''}</div></td>
      <td class="n">${cell(pair(x, 'ridesDay'))}</td><td class="n">${cell(pair(x, 'rvd', { d: 2 }), true)}</td><td class="n">${cell(pair(x, 'revDay', { unit: ' €' }), true)}</td></tr>`; }).join('') || emptyRow(6, t('app.noTripsInFilter'), t('app.setOperatorOrVehicleTypeTo'));
  $('#tbl-econ-more tbody').innerHTML = rows.map(x => { const c = x.cm; const fac = calibFor(x.op);
    return `<tr${!x.c.plausible ? ' class="row-excl"' : ''}>${nameCell(x)}
      <td class="n"><input type="number" class="calib" data-op="${esc(x.op)}" value="${fac}" min="0.1" max="5" step="0.05" style="width:4.8em${fac !== 1 ? ';border-color:var(--accent)' : ''}" aria-label="${t('app.tripCorrectionFactor', { op: esc(x.op) })}" title="${esc(GLOSS.calib)}">${fac !== 1 ? `<div class="sub-line">${t('app.overridden')}</div>` : x.fac.source === 'kalibriert' ? `<div class="sub-line">${t('app.calibrated3', { f: fmt(x.fac.f, 2) })}</div>` : x.fac.source === 'ausgesetzt' ? `<div class="sub-line">${t('app.suspended')}</div>` : ''}</td>
      <td class="n">${cell(pair(x, 'utilization', { d: 1, unit: ' %', scale: 100 }))}</td><td class="n">${fmt(c.avgMin, 1)} min<div class="sub-line">${esc(x.dur.map(d => DUR[d] || d).join(', '))}</div></td>
      <td class="small">${x.plans.slice(0, 2).map(esc).join('<br>') || `<span class="muted">${t('app.noTariffInFeed')}</span>`}${x.planScope === 'Anbieter' ? `<div class="sub-line">${t('app.tariffOfAnotherCity')}</div>` : ''}${x.planUnclear ? `<div class="sub-line warn-text" title="${esc(t('econ.tariffUnclearTip'))}">${t('econ.tariffUnclear', { lo: fmt(x.planUnclear.fareMin, 2), hi: fmt(x.planUnclear.fareMax, 2) })}</div>` : ''}</td>
      <td class="n">${euro(c.perRide, 2)}</td><td class="n">${cell(pair(x, 'revPerVehicleDay', { d: 2, unit: ' €' }))}</td></tr>`; }).join('') || emptyRow(7, t('app.noTripsInFilter'), t('app.setOperatorOrVehicleTypeTo'));
  // Kalibrierung in zwei Zeilen; Einzelheiten im Panel „Kalibrierung“
  const calOps = Object.keys(cal);
  const kTxt = k?.applied ? `${t('app.eScooterTrips', { k: fmt(k.k, 2) })} <span class="muted">${t('app.range2', { kLow: fmt(k.kLow, 2), kHigh: fmt(k.kHigh, 2) })}</span> ${t('app.officialBerlinMeasuredBerlin', { quarter: esc(k.quarter), wert: fmt(k.ref.wert, 2), rvd: fmt(k.measured.rvd, 2), v3: abbr(t('app.tripsVehDay2'), 'rvd') })} <span class="muted">(${esc(k.source)})</span>${k.prelim ? ` <span class="pill prelim badge" title="${esc(k.prelimWhy.join(', '))}">${t('app.preliminary')}</span>` : ''}${k.single ? ` <span class="muted">· ${t('app.onlyOneOperator')}</span>` : ''} · ${esc(k.statusText || '')}${k.onlyKind ? ` · <span class="muted">${esc(k.onlyKind)}</span>` : ''}${skipOps.length ? ` · ${t('cal.skipped', { v0: esc(skipOps.join(', ')) })}` : ''}` : t('app.tripsNotCalibrated', { v0: esc(k?.reason || t('app.referenceValuesNotLoadable')) });
  const aTxt = sc?.calibrated ? t('app.avgEScooterTripMinInsteadOf', { min: fmt(sc.min, 1), min2: fmt(sc.previous.min), from: esc(sc.from), to: esc(sc.to) }) : t('app.avgEScooterTripMinAssumption', { v0: fmt(sc?.min ?? 12) });
  $('#econ-calib').innerHTML = `<div id="econ-calib-state"><b>${effective ? t('app.calibrated4') : t('app.measured4')}</b> · ${kTxt}</div><div>${t('app.bikesEBikesCargoBikes', { aTxt, v1: r.calib?.limits?.scooter ? ` · ${t('app.aboveTripsVehDayCalibration', { scooter: fmt(r.calib.limits.scooter, 2) })}` : '', v2: calOps.length ? ` · ${t('app.correctionOverriddenFor', { join: esc(calOps.join(', ')) })}` : '' })} · <span class="muted">${t('app.derivationInCalibrationPanel')}</span></div>`;
  const excludedN = rows.length - good.length;
  // sichtbar bleibt der erste Satz (was als Fahrt zählt), die Methodik steht aufklappbar darunter
  const noteHtml = t('app.tripsDisappearedAvailable', { v0: abbr(t('app.idRotation'), 'rot'), source: esc(tx(r.profile.source)), v2: prelim ? t('app.measuredValuesUnder3Full') : '', v3: o.rideMin ? t('app.defaultMin', { rideMin: fmt(o.rideMin) }) : t('app.measuredWhereIdsAreStable20', { v0: sc?.calibrated ? t('app.minFromBerlinQuarterlyValues', { min: fmt(sc.min, 1) }) : t('app.n12Min') }), v4: o.net ? `${t('app.excluding19Vat')} ` : '', v5: abbr(t('app.realisationRate'), 'real'), v6: r.gapH ? ` ${t('app.afterMeasurementGapOver45Min', { gapH: r.gapH, v1: r.gapH === 1 ? t('app.hour') : t('app.hours') })}` : '', v7: excludedN ? ` ${t('app.withImplausibleTripCountAre', { excludedN, v1: excludedN === 1 ? t('app.row') : t('app.rows2') })}` : '', v8: calOps.length ? ` ${t('app.activeFor', { join: esc(calOps.join(', ')) })}` : '' });
  const m = noteHtml.match(/^([\s\S]*?\)\.)\s+([\s\S]+)$/);
  const keepOpen = $('#econ-note details')?.open;
  $('#econ-note').innerHTML = m ? `${m[1]} <details class="more"${keepOpen ? ' open' : ''}><summary>${t('app.methodSummary')}</summary><p style="margin:0">${m[2]}</p></details>` : noteHtml;
}
// ---------- Kalibrierung: Referenzwerte (data/reference.json, Branch main) gegen die eigene Messung, Regeln in lib/pulse-calib.js ----------
// Voi: Umsatz je Fahrzeug und Tag (gemessen, netto × Realisierung) über die Tage der Kalibrierung, Flotte-Tage gewichtet
async function voiRevenue(days) {
  let rev = 0, fleet = 0, n = 0, rides = 0;
  for (const d of days || []) {
    const r = await econGroups(d, (key) => { const [a, op, tq] = key.split('|'); return a !== 'DE' && op === 'Voi' && tq === 'scooter'; }); if (!r) continue;
    const c = E.combine([...r.out.values()].map(x => x.m).filter(x => x.plausible)); if (c?.revDay != null && c.fleet > 0) { rev += c.revDay; fleet += c.fleet; rides += c.ridesDay || 0; n++; }
  }
  // Umsatz je Fahrt (Vergleich mit Voi FY2025 1,54 €): vom Faktor unabhängig, weil Umsatz und Fahrten gleich skalieren
  return fleet > 0 ? { revPerVehicleDay: rev / fleet, revPerRide: rides > 0 ? rev / rides : null, days: n } : null;
}
async function renderCalibPanel() {
  const els = ['calib-panel', 'calib-src'].map(id => document.getElementById(id)).filter(Boolean); if (!els.length) return;
  const head = `<div class="panel-head"><div><h2>${t('app.calibration')}</h2><div class="sub">${t('app.publicReferenceValuesWith')}</div></div></div>`;
  const calib = await getCalib(); const k = calib.k, a = calib.assume?.scooter, ref = calib.ref;
  if (!ref) { for (const el of els) el.innerHTML = head + `<div class="empty">${t('app.referenceValuesNotLoadable2')}</div>`; return; }
  const voi = await voiRevenue(calib.days).catch(() => null);
  const checks = K.plausibilityChecks(ref, { ...calib.own, voi: { ...(calib.own?.voi || {}), revPerVehicleDay: voi?.revPerVehicleDay ?? null, revPerRide: voi?.revPerRide ?? null } }, k, lang());
  const src = (e) => (e?.url ? link(e.url, `${esc(e.quelle || t('app.source3'))} ↗`) : esc(e?.quelle || '—'));
  const dd = (d) => d ? dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T12:00:00Z`)) : '–';
  const f2 = (v) => fmt(v, 2);
  const rows = [];
  // 1. Fahrtdauer
  if (a?.calibrated) rows.push([`${t('app.avgEScooterTrip')}<div class="sub-line">${t('app.berlinQuarters', { from: esc(a.from), to: esc(a.to), n: a.n })}</div>`, `${t('app.avgMinAvgKm', { min: fmt(a.min, 1), v1: f2(a.km) })}<div class="sub-line">${t('app.quartersMinKm', { v0: fmt(a.minRange[0], 1), v1: fmt(a.minRange[1], 1), v2: fmt(a.kmRange[0], 1), v3: fmt(a.kmRange[1], 1) })}</div>`, src(a),
    `${t('app.notMeasurable')}<div class="sub-line">${t('app.idsChangeWithEveryTripStable')}</div>`, `${f2(a.min / a.previous.min)}<div class="sub-line">${t('app.versusPreviouslyMin', { min: fmt(a.previous.min) })}</div>`, t('app.assumptionMinUtilisation', { min: fmt(a.previous.min), min2: fmt(a.min, 1), v2: f2(a.min / a.previous.min) })]);
  for (const e of (ref.fahrt || []).filter(x => x.ags !== K.BERLIN && x.type === 'scooter')) rows.push([`${t('app.eScooterTrip')}<div class="sub-line">${esc(tx(e.ort))}, ${esc(e.zeitraum)}</div>`, [e.minMedian != null ? t('app.medianMin', { minMedian: fmt(e.minMedian, 1) }) : '', e.minMittel != null ? t('app.avgMin', { minMittel: fmt(e.minMittel, 1) }) : '', e.kmMedian != null ? t('app.medianKm', { v0: f2(e.kmMedian) }) : '', e.kmMittel != null ? `Ø ${f2(e.kmMittel)} km` : ''].filter(Boolean).join(' · '), src(e), '—', a?.calibrated && e.minMittel ? `${f2(a.min / e.minMittel)}<div class="sub-line">${t('app.berlinAvgAvgHere')}</div>` : '—', t('app.crossCheckNotPartOfRuleOne')]);
  // 2. Methodenfaktor
  const kr = k?.ref || (ref.rvd || []).filter(e => e.ags === K.BERLIN && e.type === 'scooter').slice(-1)[0];
  if (kr) rows.push([`${t('app.tripsPerVehAndDayEScooter')}<div class="sub-line">${t('app.berlin', { v0: esc(k?.applied ? `${k.quarter} (${k.rule})` : kr.zeitraum) })}</div>`, `<b>${f2(kr.wert)}</b>${k?.refMin != null ? `<div class="sub-line">${t('app.quarters', { v0: f2(k.refMin), v1: f2(k.refMax) })}</div>` : ''}`, src(kr),
    k?.measured?.rvd ? `${f2(k.measured.rvd)}<div class="sub-line">${t('app.ofHoursObserved', { v0: esc(k.source || ''), v1: dd(k.measured.from), v2: dd(k.measured.to), days: k.measured.days, v4: k.measured.days === 1 ? t('app.day2') : t('app.days2'), v5: fmt(k.obsShare * 100) })}</div>${(k.measured.excluded || []).length ? `<div class="sub-line">${t('app.excludedOvercount', { join: esc(k.measured.excluded.map(x => `${x.op} ${f2(x.rvd)}`).join(', ')) })}</div>` : ''}` : '—',
    k?.applied ? `k = <b>${f2(k.k)}</b><div class="sub-line">${f2(k.kLow)}–${f2(k.kHigh)}</div>` : '—',
    k?.applied ? t('app.eScooterTripsNationwide', { v0: f2(k.k), calibLabel: esc(Rp.calibLabel(k)), v2: f2(calib.limits?.scooter), v3: k.prelim ? `<div class="sub-line">${t('app.preliminary2', { join: esc(k.prelimWhy.join(', ')) })}</div>` : '', v4: (k.single ? `<div class="sub-line">${t('app.limitation', { single: esc(k.single) })}</div>` : '') + `<div class="sub-line">${esc(k.statusText || '')}${k.onlyKind ? ` · ${esc(k.onlyKind)}` : ''}</div>` }) : t('app.noCalibration', { v0: esc(k?.reason || '') })]);
  // 3. Abdeckung (+ Hochrechnung nur hier)
  for (const c of calib.coverage || []) {
    // k nur bei angewandtem k und Kennungsart der Stadt wie die Referenz, höchstens bis zur Grenze (K.calibratedRvd); sonst gemessen mit Hinweis
    const ob = calib.own?.byAgs?.[c.ags]; const cr = K.calibratedRvd(ob?.rvd, k, { kind: ob?.kind ?? null, limit: calib.limits?.scooter ?? null }); const rvdCal = cr.rvd;
    const crNote = cr.skip === 'op' ? `<div class="sub-line">${esc(t('cal.notOp', { ops: (cr.ops || []).join(', ') }))}</div>` : cr.skip === 'kind' ? `<div class="sub-line">${esc(t('cal.notKind', { v0: K.kindText(cr.kind, lang()) }))}</div>` : cr.skip === 'suspended' ? `<div class="sub-line warn-text">${esc(tx(Rp.SUSPENDED_TXT))}</div>` : cr.capped ? `<div class="sub-line">${t('rep.cappedAtLimit')}</div>` : '';
    rows.push([`${t('app.eScooters', { v0: esc(c.label[0].toUpperCase() + c.label.slice(1)) })}<div class="sub-line">${esc(c.ort)}, ${c.stand ? t('app.asOf3', { v0: dd(c.stand) }) : ''}</div>`, `<b>${c.art === 'aktiv' ? `${t('app.approx')} ` : ''}${fmt(c.official)}</b><div class="sub-line">${esc(c.label)}</div>`, src(c), `${fmt(c.ours)}<div class="sub-line">${t('app.inOpenFeeds', { v0: c.operators.length ? ` (${esc(c.operators.map(o => o.op).join(', '))})` : '' })}</div>`, `<b>${fmt(c.share * 100, 1)} %</b>`,
      `${esc(c.shareLabel)}${rvdCal != null ? `<div class="sub-line">${t('app.extrapolationOnlyHereTrips', { rvdCal: f2(rvdCal), official: fmt(c.official), sig2: fmt(sig2(rvdCal * c.official)), v3: c.art === 'genehmigt' ? ` ${t('app.ofLicensedFleetHenceUpper')}` : ` ${t('app.ofActiveFleet')}` })}</div>` : ''}${crNote}`]);
  }
  // 4. Prüfwerte ohne Faktor
  for (const x of checks) {
    const u = x.unit === '€' ? ' €' : '';
    const mv = x.measured == null ? '—' : `${f2(x.measured)}${u}${x.calibrated != null ? `<div class="sub-line">${t('app.calibrated5', { v0: f2(x.calibrated), u })}</div>` : x.suspended ? `<div class="sub-line warn-text">${esc(tx(Rp.SUSPENDED_TXT))}</div>` : x.notOp?.length ? `<div class="sub-line">${esc(t('cal.notOp', { ops: x.notOp.join(', ') }))}</div>` : ''}<div class="sub-line">${esc(x.kind === 'Untergrenze' ? t('app.openFeeds', { ort: tx(x.ref.ort) }) : x.scope || '')}${x.unit === '€' && voi ? `, ${voi.days} ${voi.days === 1 ? t('app.day2') : t('app.days2')}` : ''}</div>`;
    const ratio = x.ratioCal ?? x.ratio;
    rows.push([`${esc(tx(x.label.replace(/: .*/, '')))}<div class="sub-line">${esc(x.label.replace(/^[^:]*: /, ''))} · ${esc(x.ref.zeitraum || '')}</div>`, `<b>${x.kind === 'Untergrenze' ? '≥ ' : ''}${f2(x.refValue)}${u}</b>${x.how ? `<div class="sub-line">${esc(t('app.mTripsFleetCap', { v0: fmt(x.trips / 1e6, 2), v1: x.year % 4 ? 365 : 366, limit: fmt(x.limit) }))}</div>` : x.ref.hinweis ? `<div class="sub-line"><span translate="no">${esc(x.ref.hinweis)}</span></div>` : ''}`, `${src(x.ref)}${x.cap && x.cap.url !== x.ref.url ? ` · ${src(x.cap)}` : ''}`, mv,
      ratio == null ? '—' : `${f2(ratio)}<div class="sub-line">${t('app.reference', { v0: x.ratioCal != null ? t('app.calibrated6') : t('app.measured3') })}</div>`, x.suspended ? t('app.measurementAbove15Largest', { v0: f2(calib.limits?.scooter) }) : x.kind === 'Untergrenze' ? t('app.checkNoFactorLowerBound') : t('app.comparisonNoFactor')]);
  }
  const rules = `<ol class="calib-rules small"><li>${t('app.tripDurationAvgEScooterTrip', { v0: a?.calibrated ? ` (${fmt(a.min, 1)} Min., ${f2(a.km)} km)` : '' })}</li>
    <li>${t('cal.methodFactorK', { CALIB_DAYS: Rp.CALIB_DAYS, minDays: K.CALIB.minDays })}</li>
    <li>${t('app.plausibilityIfOperatorS', { v0: calib.limits?.scooter ? f2(calib.limits.scooter) : '–', overFactor: fmt(K.CALIB.overFactor, 1), v2: k?.source ? ` (${esc(k.source)})` : '', v3: k?.single ? t('app.onlyOneOperatorOthersMay') : '' })}</li>
    <li>${t('app.preliminaryBelowMeasurement', { minDays: K.CALIB.minDays, v1: K.CALIB.minObsShare * 100, kMin: fmt(K.CALIB.kMin, 1), kMax: fmt(K.CALIB.kMax) })}</li>
    <li>${t('cal.ruleRelease', { minDays: K.CALIB.minDays, v1: esc(k?.statusText || '–'), v2: esc(k?.refKindText || K.kindText('unknown', lang())) })}</li>
    <li>${t('app.coverageAndCheckOwnEScooters')}</li></ol>`;
  const table = `<div class="tbl" tabindex="0" role="region" aria-label="${t('app.calibrationReferenceValues')}"><table class="calib-tbl"><thead><tr><th>${t('app.reference2')}</th><th class="n">${t('app.value')}</th><th>${t('app.source3')}</th><th class="n">${t('app.ourMeasurement')}</th><th class="n">${t('app.ratio')}</th><th>${t('app.effect')}</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="n">${r[1]}</td><td class="small">${r[2]}</td><td class="n">${r[3]}</td><td class="n">${r[4]}</td><td class="small">${r[5]}</td></tr>`).join('')}</tbody></table></div>`;
  const foot = `<div class="muted small" style="margin-top:var(--s2)">${t('app.measurementPeriodVoiRevenue', { v0: calib.days.length ? `${dd(calib.days[0])}–${dd(calib.days[calib.days.length - 1])}` : '–', v1: econOpts().net ? t('common.net') : t('common.gross'), v2: fmt(econOpts().realization * 100), v3: esc(ref.updatedAt || '–') })}</div>`;
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
  el.textContent = `· ${t('app.archiveSince', { v0: first ? new Date(`${first}T12:00:00`).toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) : new Date(+m0.slice(0, 4), +m0.slice(5, 7) - 1, 1).toLocaleDateString(fmtLocale(), { month: 'long', year: 'numeric' }), n: fmt(n), v2: n === 1 ? t('app.day2') : t('app.days2') })}`;
}
function T_empty() { return { start: new Array(24).fill(0), end: new Array(24).fill(0), reloc: new Array(24).fill(0), swap: new Array(24).fill(0), pickup: new Array(24).fill(0), disOn: new Array(24).fill(0), disOff: new Array(24).fill(0), swapWaitSum: 0, swapWaitN: 0, disDurSum: 0, disDurN: 0, tripDurSum: 0, tripDurN: 0, tripDistSum: 0, tripDistN: 0, swapWaitCens: 0, disDurCens: 0 }; }
// swapWaitCens/disDurCens (ab 02.11.2026): davon Mindestwerte (unter 20 % bzw. gesperrt seit erster Sichtung zu Beginn der Verfolgung, Z6) → Anzeige „≥“
function T_add(a, g, ok = null) { for (const f of ['start', 'end', 'reloc', 'swap', 'pickup', 'disOn', 'disOff']) for (let i = 0; i < 24; i++) if (!ok || ok[i]) a[f][i] += g[f]?.[i] || 0; for (const f of ['swapWaitSum', 'swapWaitN', 'disDurSum', 'disDurN', 'tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN', 'swapWaitCens', 'disDurCens']) a[f] += g[f] || 0; }
const atLeast = (cens, text) => cens > 0 ? `≥ ${text}` : text; // Mittel mit zensierten Werten ist ein Mindestwert
// Wetter aus dem Cache des Sammlers (weather/<UTC-Tag>.json, DWD über Bright Sky), derselbe Stand wie in Bericht und Prognose;
// kein Abruf bei Drittanbietern (Open-Meteo erlaubt die kostenlose Nutzung nur nicht-kommerziell). Ganz Deutschland: Mittel aller Wetterzellen.
async function loadWeather(day) {
  const scope = state.scope === 'DE' ? null : state.scope, key = `${day}|${scope || 'DE'}`;
  if (!(key in state.usage.weather)) {
    const vals = await weatherFor(Array.from({ length: 24 }, (_, h) => [day, h]), scope, getJsonShared, CFG.DATA).catch(() => null);
    state.usage.weather[key] = vals?.some(Boolean) ? { temp: vals.map(v => (v ? v.t : null)), rain: vals.map(v => v?.p ?? null), name: scope ? muniName(scope) : t('app.centreOfGermany') } : null;
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
function hourChart(series, weather, runs, mask = null, holiday = null, W = 900) {
  const WB = weather ? 58 : 0, HT = holiday ? 16 : 0, H = (W < 520 ? 200 : 260) + WB + HT, P = { l: 54, r: 12, t: 12 + HT, b: 26 + WB }, HS = W < 520 ? 6 : 3; // Stundenmarken alle 3 h, schmal alle 6 h
  const vals = series.flatMap(s => s.values).filter(v => v != null);
  const nt = niceTicks(Math.max(1, ...vals) * 1.05), max = nt.top; // runde Achsenwerte statt 96/191/287/383
  const x = (h) => P.l + ((h + 0.5) / 24) * (W - P.l - P.r), cw = (W - P.l - P.r) / 24;
  const y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
  let g = '';
  // nicht gemessene Stunden und Stunden nach Messlücke grau hinterlegen (statt einer Nulllinie)
  const m = mask || hourMask(runs);
  for (let h = 0; h < 24; h++) if (!m.ok[h]) g += `<rect class="gap" x="${(x(h) - cw / 2).toFixed(1)}" y="${P.t}" width="${cw.toFixed(1)}" height="${H - P.t - P.b}"><title>${t('app.text2', { h, v1: h + 1, v2: m.gap[h] ? t('app.runAfterPauseOfMoreThan45Min') : t('app.noCollectorRunNotMeasured') })}</title></rect>`;
  for (let h = 0; h < 24; h++) if (!m.ok[h] && (h === 0 || m.ok[h - 1])) { let e = h; while (e < 23 && !m.ok[e + 1]) e++; if (e - h >= 2) g += `<text x="${((x(h) + x(e)) / 2).toFixed(1)}" y="${P.t + 12}" text-anchor="middle">${t('app.notMeasured')}</text>`; }
  for (const v of nt.ticks) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${P.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v, nt.step < 1 ? 1 : 0)}</text>`;
  const yAx = H - WB - 8;
  for (let h = 0; h < 24; h += HS) g += `<text x="${x(h).toFixed(1)}" y="${yAx}" text-anchor="middle">${t('app.n00', { h })}</text>`;
  if (holiday) g += `<text class="hol" x="${W - P.r}" y="${P.t - 6}" text-anchor="end">${esc(holiday)}</text>`; // über der Fläche, kollidiert nicht mit „nicht gemessen“
  let wx = '';
  if (weather) {
    // eigenes Band: Regen als Balken (eigene Höhe, kein Bezug zur y-Achse), Temperatur als Zahl alle 3 Stunden
    const b0 = H - WB + 6, bh = 26, rmax = Math.max(1, ...weather.rain.map(v => v || 0));
    wx += `<text x="${P.l - 6}" y="${b0 + 12}" text-anchor="end">${t('app.weather2')}</text><line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${b0 + bh}" y2="${b0 + bh}"/>`;
    for (let h = 0; h < 24; h++) if (weather.rain[h] > 0) { const hh = Math.max(2, (weather.rain[h] / rmax) * bh); wx += `<rect class="rain" x="${(x(h) - cw / 2 + 2).toFixed(1)}" y="${(b0 + bh - hh).toFixed(1)}" width="${(cw - 4).toFixed(1)}" height="${hh.toFixed(1)}"><title>${t('app.n00MmPrecipitation', { h, v1: fmt(weather.rain[h], 1) })}</title></rect>`; }
    for (let h = 0; h < 24; h += HS) if (weather.temp[h] != null) wx += `<text x="${x(h).toFixed(1)}" y="${b0 + bh + 14}" text-anchor="middle">${fmt(weather.temp[h])}°</text>`;
  }
  // Linie an fehlenden Stunden unterbrochen; einzelne gemessene Stunden als Punkt (≥ 8 px)
  const paths = series.map((s, i) => { const col = s.color || palette(i); let d = '', open = false, dots = ''; s.values.forEach((v, h) => { if (v == null) { open = false; return; } const alone = (h === 0 || s.values[h - 1] == null) && (h === 23 || s.values[h + 1] == null); if (alone) dots += `<circle cx="${x(h).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${col}" stroke="var(--panel)" stroke-width="2"/>`; d += `${open ? 'L' : 'M'}${x(h).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>${dots}`; }).join('');
  // Trefferflächen je Stunde mit allen Werten (Tooltip)
  let hits = '';
  for (let h = 0; h < 24; h++) { const lines = m.ok[h] ? series.filter(s => s.values[h] != null).sort((a, b) => b.values[h] - a.values[h]).map(s => `${s.name} ${fmt(s.values[h])}`) : [m.gap[h] ? t('app.afterMeasurementGapNot') : t('app.notMeasured')]; if (weather && weather.temp[h] != null) lines.push(`${fmt(weather.temp[h])} °C · ${fmt(weather.rain[h] || 0, 1)} mm`); hits += `<rect class="hit" x="${(x(h) - cw / 2).toFixed(1)}" y="${P.t}" width="${cw.toFixed(1)}" height="${H - P.t - 8}"><title>${t('app.text3', { h, v1: h + 1, join: esc(lines.join('\n')) })}</title></rect>`; }
  return `<svg class="chart" data-px="1" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('app.tripStartsPerHourGreyNot', { v0: holiday ? `; ${esc(holiday)}` : '' })}. ${esc(seriesSummary(series))}">${g}${wx}${paths}${hits}</svg>`;
}
// Feiertage: lokal gerechnet (lib/pulse-econ.js localHolidays, Ostern nach Gauß/Meeus); wo calendar.json (OpenHolidays) den Tag abdeckt,
// gilt je Land der Kalender – Länder mit Feiertag laut Kalender ohne lokalen Namen erscheinen als „Feiertag“
const HOL_NAME = { newYear: () => t('app.newYearSDay'), epiphany: () => t('app.epiphany'), womensDay: () => t('app.womenSDay'), goodFriday: () => t('app.goodFriday'), easterSunday: () => t('app.easterSunday'),
  easterMonday: () => t('app.easterMonday'), labourDay: () => t('app.labourDay'), ascension: () => t('app.ascensionDay'), whitSunday: () => t('app.whitSunday'), whitMonday: () => t('app.whitMonday'),
  corpusChristi: () => t('app.corpusChristi'), assumption: () => t('app.assumptionDay'), childrensDay: () => t('app.worldChildrenSDay'), unity: () => t('app.germanUnityDay'), reformation: () => t('app.reformationDay'),
  allSaints: () => t('app.allSaintsDay'), repentance: () => t('app.dayOfRepentanceAndPrayer'), christmas: () => t('app.christmasDay'), boxingDay: () => t('app.boxingDay') };
function holidaysOf(day) {
  const loc = E.localHolidays(day).map(h => [day, HOL_NAME[h.id]?.() || h.id, h.lands]);
  if (!E.calendarCovers(state.calendar, day)) return loc;
  const H = new Set(E.calendarLands(state.calendar, day, 'H'));
  const out = loc.map(([d, n, lands]) => [d, n, lands.filter(l => l.endsWith('*') || H.has(l))]).filter(x => x[2].length);
  const rest = [...H].filter(l => !out.some(x => x[2].includes(l)));
  if (rest.length) out.push([day, t('mb.publicHoliday'), rest]);
  return out;
}
// Schulferien laut Kalender (Tagtyp F, nur Mo–Fr): im Land des Gebiets bzw. Zahl der Länder
function schoolNote(day) {
  const L = E.calendarLands(state.calendar, day, 'F'); if (!L.length) return null;
  const st = state.scope === 'DE' ? null : scopeState();
  return st ? (L.includes(st) ? t('mb.schoolHolidaysIn', { st }) : null) : t('mb.schoolHolidaysStates', { n: L.length });
}
// Messbasis unter dem Tagesgang: Matrix Stunde × Tagtyp mit Messminuten (latest.json → measure, Tagtyp im Land des Gebiets), damit sichtbar
// ist, welche Stunden an welchen Tagtypen gemessen sind. Nicht gemessen = Zeichen „·“ (nicht nur Farbe), Minuten im Text für Screenreader.
function renderMbMatrix() {
  let box = $('#mb-matrix');
  if (!box) { const lg = $('#usage-legend'); if (!lg) return; lg.insertAdjacentHTML('afterend', '<div id="mb-matrix" class="mb-matrix"></div>'); box = $('#mb-matrix'); }
  const land = state.scope === 'DE' ? null : scopeState(), b = Rp.mbBase(state, { land });
  const lvl = (m) => (m <= 0 ? 0 : m < 50 ? 1 : m < 120 ? 2 : m < 240 ? 3 : 4), hh = (h) => String(h).padStart(2, '0');
  const head = `<tr><th scope="col"><span class="vh">${t('mb.dayType')}</span></th>${Array.from({ length: 24 }, (_, h) => `<th scope="col" class="mb-hh">${h % 3 === 0 ? hh(h) : `<span class="vh">${hh(h)}</span>`}</th>`).join('')}<th scope="col" class="n">${t('mb.sum')}</th></tr>`;
  const rows = E.DAY_TYPES.map(k => `<tr><th scope="row" title="${esc(Rp.mbTypeName(k))}">${k}<span class="vh"> ${esc(Rp.mbTypeName(k))}</span></th>${b.matrix[k].map((m, h) => `<td class="mb-c mb-l${lvl(m)}" title="${esc(t('mb.cellTitle', { type: Rp.mbTypeName(k), h: hh(h), h2: hh((h + 1) % 24), m: fmt(m) }))}">${m > 0 ? `<span class="vh">${fmt(m)}</span>` : '<span aria-hidden="true">·</span><span class="vh">0</span>'}</td>`).join('')}<td class="n mono">${fmt(b.byType[k], 1)}&nbsp;h<div class="sub-line">${t(b.days[k] === 1 ? 'mb.nDay' : 'mb.nDays', { n: b.days[k] })}</div></td></tr>`).join('');
  const never = Array.from({ length: 24 }, (_, h) => h).filter(h => E.DAY_TYPES.every(k => !b.matrix[k][h]));
  box.innerHTML = `<div class="mb-mh"><b>${t('mb.matrixTitle')}</b> <span class="muted">${t('mb.matrixSub', { h: fmt(b.hours, 1), never: never.length ? never.map(hh).join(', ') : '–' })}</span></div>
    <div class="tbl" tabindex="0" role="region" aria-label="${t('mb.matrixAria')}"><table class="mb-mx"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    <div class="legend mb-leg"><span>${E.DAY_TYPES.map(k => `${k} ${esc(Rp.mbTypeName(k))}`).join(' · ')}</span><span><span aria-hidden="true">·</span> ${t('mb.lv0')}</span>${[1, 2, 3, 4].map(l => `<span><i class="sq mb-c mb-l${l}"></i>${t(`mb.lv${l}`)}</span>`).join('')}</div>`;
}
// Text für den gewählten Tag und das Gebiet: Feiertag im Land der Gemeinde, deutschlandweit mit Zahl der Länder; sonst Sonntag
function dayNote(day) { const a = dayNoteHol(day), f = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? schoolNote(day) : null; return a && f ? `${a} · ${f}` : a || f; }
function dayNoteHol(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
  const st = state.scope === 'DE' ? null : scopeState();
  const hits = holidaysOf(day).map(([, name, lands]) => ({ name, lands: lands.map(l => l.replace('*', '')), part: lands.some(l => l.endsWith('*') && (!st || l.startsWith(st))) })).filter(h => !st || h.lands.includes(st));
  const sunday = new Date(`${day}T12:00:00Z`).getUTCDay() === 0;
  if (hits.length) return `Feiertag: ${hits.map(h => `${h.name}${st ? ` (${st}${h.part ? t('app.partly') : ''})` : h.lands.length === 16 ? ' (bundesweit)' : ` ${t('app.states', { length: h.lands.length })}`}`).join(', ')}${sunday ? ` · ${t('app.sunday')}` : ''}`;
  return sunday ? t('app.sunday') : null;
}
async function cellsForScope(day) {
  if (state.scope === 'DE') return null;
  const st = scopeState(); if (!st) return null;
  const doc = await loadCells(day, st); return doc?.munis?.[state.scope] || null;
}
async function renderCellsTable(day) {
  const tb = $('#tbl-cells tbody');
  const cells = await cellsForScope(day);
  if (!cells) { tb.innerHTML = state.scope === 'DE' ? emptyRow(5, t('app.cellsExistPerMunicipality'), t('app.chooseAreaAbove')) : emptyRow(5, t('app.noCellsForThisDayYet'), t('app.chooseAnotherDay')); return; }
  // Präsenz (fast immer 100 %) entfällt; Lage als Straße/Stadtteil (Nominatim, nur die gezeigten Top 20)
  const rows = Object.entries(cells).map(([cell, v]) => ({ cell, start: v[0], end: v[1], present: v[2], reloc: v[3], net: v[1] - v[0] })).filter(r => r.start + r.end + r.reloc > 0).sort((a, b) => b.start - a.start).slice(0, 20);
  const pts = rows.map(r => { const [lat, lon] = cellCenterOf(r.cell); return { ...r, lat, lon, k: geoKey(lat, lon) }; });
  tb.innerHTML = pts.map(r => `<tr><td><a href="#live" class="pick-cell" data-lat="${r.lat}" data-lon="${r.lon}"><span translate="no" data-geo="${r.k}">${esc(GEO.get(r.k) || t('app.cell'))}</span></a><div class="sub-line mono">${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</div></td><td class="n">${fmt(r.start)}</td><td class="n">${fmt(r.end)}</td><td class="n" style="color:var(--${r.net > 0 ? 'ok' : r.net < 0 ? 'bad' : 'muted'})">${r.net > 0 ? '+' : ''}${fmt(r.net)}</td><td class="n">${fmt(r.reloc)}</td></tr>`).join('') || emptyRow(5, t('app.noMovementsInThisArea'), t('app.chooseAnotherDay'));
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
      $$(`[data-geo="${q.k}"]`).forEach(el => { const tq = GEO.get(q.k); if (tq) el.textContent = tq; });
      if (geoQueue.length) await new Promise(res => setTimeout(res, 1100)); // Nominatim-Nutzungsregel: höchstens 1 Anfrage je Sekunde
    }
  } finally { geoBusy = false; }
}
const CELL_LAT = 0.0025, CELL_LON = 0.0035;
function cellCenterOf(cell) { const [a, b] = cell.split(':').map(Number); return [a * CELL_LAT, b * CELL_LON]; }
async function renderQuota() {
  const q = await loadOnce('quota', 'stations-quota.json'); const tb = $('#tbl-quota tbody');
  if (!q) { tb.innerHTML = `<tr><td colspan="5" class="empty">${t('app.noStationDataRateIsBuiltFrom')}</td></tr>`; return; }
  // virtuelle Stationen (Abstellzonen ohne Dock, Feld „virtual“) sind kein Versorgungsmangel, wenn leer → nicht in der Leer-Quote
  const vi = (q.fields || []).indexOf('virtual');
  let rows = q.stations.filter(s => (state.scope === 'DE' || s[0] === state.scope) && (state.operator === 'all' || s[1] === state.operator) && s[5] >= 3 && !(vi >= 0 && s[vi]));
  rows.sort((a, b) => (b[6] / b[5]) - (a[6] / a[5]) || b[5] - a[5]);
  rows = rows.slice(0, 25);
  tb.innerHTML = rows.map(s => `<tr><td translate="no">${esc(s[2] || t('app.station'))}${state.scope === 'DE' ? `<div class="sub-line">${esc(muniName(s[0]))}</div>` : ''}</td><td>${esc(s[1])}</td><td class="n">${fmt(s[5])}</td><td class="n"><span style="color:var(--${s[6] / s[5] >= 0.5 ? 'bad' : s[6] / s[5] >= 0.25 ? 'warn' : 'fg'})">${pctf(s[6], s[5])}</span></td><td class="n">${pctf(s[7], s[5])}</td></tr>`).join('') || `<tr><td colspan="5" class="empty">${t('app.noStationsWithEnoughRunsIn')}</td></tr>`;
}

// ---------- Karten-Ebenen: Start/Ziel, bediente Zellen, lange Standzeiten, Betriebszonen ----------
async function renderFlowLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const idx = await loadUsageIndex(); const day = state.usage.day || idx.days?.slice(-1)[0]; if (!day) { notice(() => t('app.noEventDataForStart'), '', 'flow'); return; }
  const cells = await cellsForScope(day); if (!cells) { notice(() => t('app.startDestinationLayerPlease'), '', 'flow'); return; }
  clearNotice('flow');
  const list = Object.entries(cells).map(([cell, v]) => ({ cell, start: v[0], end: v[1], net: v[1] - v[0], reloc: v[3] })).filter(r => r.start + r.end > 0);
  const max = Math.max(1, ...list.map(r => Math.abs(r.net)), ...list.map(r => r.start));
  const flowIn = tok('--info'), flowOut = tok('--bad'); // Farben aus den Themen-Tokens (hell/dunkel), divergierend Blau ↔ Rot
  for (const r of list) {
    const [lat, lon] = cellCenterOf(r.cell);
    const col = r.net > 0 ? flowIn : r.net < 0 ? flowOut : DISABLED_COL;
    L.rectangle([[lat - CELL_LAT / 2, lon - CELL_LON / 2], [lat + CELL_LAT / 2, lon + CELL_LON / 2]], { weight: 0, fillColor: col, fillOpacity: 0.15 + 0.65 * (Math.max(Math.abs(r.net), r.start * 0.5) / max) })
      .bindPopup(t('app.cellTripStartsTripEndsNet', { start: fmt(r.start), end: fmt(r.end), v2: r.net > 0 ? '+' : '', net: fmt(r.net), reloc: fmt(r.reloc) })).addTo(L_.grid);
  }
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:var(--bad)"></i>${t('app.netOutflowMoreStarts')}</span><span><i class="dot" style="background:var(--info)"></i>${t('app.netInflowMoreDestinations')}</span><span class="muted">${t('app.cellsWithMovement', { v0: day.split('-').reverse().join('.'), length: fmt(list.length) })}</span>`;
}
async function renderServedLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const idx = await loadUsageIndex(); const st = scopeState();
  if (state.scope === 'DE' || !st) { notice(() => t('app.servedCellsPleaseChoose'), '', 'flow'); return; }
  const days = (idx.cellDays || []).slice(-7); if (!days.length) { notice(() => t('app.noCellDataYet'), '', 'flow'); return; }
  clearNotice('flow');
  const agg = new Map();
  for (const d of days) { const doc = await loadCells(d, st); const cells = doc?.munis?.[state.scope]; if (!cells) continue; for (const [cell, v] of Object.entries(cells)) { if (!v[2]) continue; const a = agg.get(cell) || { present: 0, days: 0 }; a.present += v[2]; a.days++; agg.set(cell, a); } }
  const maxP = Math.max(1, ...[...agg.values()].map(a => a.present));
  for (const [cell, a] of agg) { const [lat, lon] = cellCenterOf(cell); L.rectangle([[lat - CELL_LAT / 2, lon - CELL_LON / 2], [lat + CELL_LAT / 2, lon + CELL_LON / 2]], { weight: 0, fillColor: tok('--accent'), fillOpacity: 0.12 + 0.6 * (a.present / maxP) }).bindPopup(t('app.servedOnOfDaysVehicle', { days: a.days, length: days.length, present: fmt(a.present) })).addTo(L_.grid); }
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:var(--accent)"></i>${t('app.cellWithAvailableVehicleIn', { length: days.length })}</span><span class="muted">${t('app.cellsKm2', { size: fmt(agg.size), v1: fmt(agg.size * 0.07, 1) })}</span>`;
}
async function renderIdleLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const d = await loadOnce('idleLong', 'idle-long.json'); if (!d) return;
  const pts = d.points.filter(p => (state.scope === 'DE' || p.ags === state.scope) && (state.operator === 'all' || p.op === state.operator) && (state.type === 'all' || p.ty === state.type));
  for (const p of pts) L.circleMarker([p.lat, p.lon], { radius: 5, weight: 2, color: bgColor(), fillColor: tok('--warn'), fillOpacity: .85 }).bindPopup(t('app.idleForH', { op: esc(p.op), v1: esc(TYPE[p.ty] || p.ty), hours: idleClassText(p.hours * 60, { en: lang() === 'en', atLeast: !!p.censored }), v3: (p.bat != null ? ` · ${t('app.battery2', { bat: fmt(p.bat) })}` : '') + (p.censored ? ` · ${t('trk.sinceTrackStart')}` : '') })).addTo(L_.grid);
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:var(--warn)"></i>${t('app.availableButNotMovedForMore')}</span><span class="muted">${t('app.shownAsOf', { length: fmt(pts.length), v1: d.total > d.points.length ? ` ${t('app.thinnedOutPerMunicipality', { total: fmt(d.total) })}` : '', v2: timeText(d.at) })}</span>`;
}
// Welche Farbe gehört zu welchem Anbieter: immer unter der Karte, sortiert nach verfügbaren Fahrzeugen im Gebiet
function renderOpLegend(vehicles) {
  const n = new Map();
  if (vehicles?.length) for (const v of vehicles) { if (!v.disabled) n.set(v.operator, (n.get(v.operator) || 0) + 1); }
  if (!n.size) for (const [k, st] of Object.entries(state.latest?.groups || {})) { if (!groupInScope(k)) continue; const op = k.split('|')[1]; n.set(op, (n.get(op) || 0) + st.available); }
  const ops = [...n].sort((a, b) => b[1] - a[1]);
  if (state.mapFocus && !n.has(state.mapFocus)) state.mapFocus = null;
  // Einträge sind Knöpfe: ein Klick hebt den Anbieter auf der Karte hervor und blendet die übrigen ab (zweite Kodierung neben der Farbe)
  $('#map-legend-ops').innerHTML = ops.length ? `<span class="muted">${t('app.operator')}</span>${ops.slice(0, 14).map(([o, c]) => `<button type="button" class="leg-hl" data-map-hl="${esc(o)}" aria-pressed="${state.mapFocus === o}" title="${esc(t('cmp.highlightTip', { op: o }))}"><i class="dot" style="background:${opColor(o)}"></i>${esc(o)} <span class="muted mono">${fmt(c)}</span></button>`).join('')}${ops.length > 14 ? `<span class="muted">${t('app.more2', { v0: ops.length - 14 })}</span>` : ''}` : '';
}
async function renderZonesLayer() {
  const L_ = state.layers; L_.zones.clearLayers();
  if (!$('#chk-zones').checked) { clearNotice('zones'); $('#map-legend-zones').innerHTML = ''; return; }
  const idx = await loadOnce('zonesIndex', 'zones/index.json'); if (!idx?.zones?.length) { notice(() => t('app.noOperatingZonesFoundInFeeds'), '', 'zones'); return; }
  let list = idx.zones.filter(z => (state.scope === 'DE' || (z.municipalities || []).includes(state.scope)) && (state.operator === 'all' || z.operator === state.operator));
  if (state.scope === 'DE') { notice(() => t('app.operatingZonesPleaseChoose'), '', 'zones'); return; }
  list = list.slice(0, 8);
  let n = 0;
  // Zonenarten aus den Themen-Tokens (hell ≥ 4,5:1 auf Weiß, dunkel die hellen Stufen); Tempolimit Violett je Thema
  const zc = { noRide: tok('--bad'), noEnd: tok('--warn'), mpz: tok('--info'), slow: isDark() ? '#c084fc' : '#7c3aed' };
  for (const z of list) {
    if (!(z.file in state.usage.zones)) { const r = await cached(`zones/${z.file}`, 60000); state.usage.zones[z.file] = r.json || null; }
    const fc = state.usage.zones[z.file]; if (!fc) continue;
    const b = state.boundaries?.features.find(x => x.properties.ags === state.scope)?.bbox;
    const inB = (f) => { if (!b) return true; const c = JSON.stringify(f.geometry.coordinates).match(/-?\d+\.\d+/g); if (!c) return true; let minX = 999, maxX = -999, minY = 999, maxY = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } return !(maxX < b[0] - .05 || minX > b[2] + .05 || maxY < b[1] - .05 || minY > b[3] + .05); };
    for (const f of fc.features.filter(inB)) {
      const ru = f.properties.rules || [];
      // GBFS 2.x: ride_allowed = Fahrt darf hier beginnen/enden; ride_through_allowed = Durchfahrt; station_parking = nur an Stationen abstellen
      const mpz = ru.some(r => r.parking === true), noRide = ru.some(r => r.rideThrough === false), noEnd = !mpz && ru.some(r => r.endAllowed === false || r.rideAllowed === false), slow = ru.find(r => r.maxSpeed != null)?.maxSpeed;
      const col = noRide ? zc.noRide : noEnd ? zc.noEnd : mpz ? zc.mpz : slow != null ? zc.slow : opColor(z.operator);
      L.geoJSON(f, { style: { color: opColor(z.operator), weight: 1.5, opacity: .9, fillColor: col, fillOpacity: noRide ? .16 : .1, dashArray: (noEnd || mpz) && !noRide ? '4 3' : null } })
        .bindPopup(`<b>${esc(z.operator)}</b> · ${esc(f.properties.name || t('app.zone'))}<br>${noRide ? t('app.ridingProhibited') : t('app.ridingAllowed')}${noEnd ? ` · ${t('app.parkingProhibited')}` : ''}${mpz ? ` · ${t('app.parkingOnlyAtStations')}` : ''}${slow != null ? ` · ${t('app.maxKmH', { slow: fmt(slow) })}` : ''}`).addTo(L_.zones);
      n++;
    }
  }
  clearNotice('zones');
  const zops = [...new Set(list.map(z => z.operator))];
  $('#map-legend-zones').innerHTML = `<span class="muted">${t('app.zones', { n: fmt(n) })}</span><span><i class="sq" style="background:color-mix(in srgb,${zc.noRide} 33%,transparent);border-color:${zc.noRide}"></i>${t('app.noRidingZone')}</span><span><i class="sq" style="background:color-mix(in srgb,${zc.noEnd} 20%,transparent);border-color:${zc.noEnd};border-style:dashed"></i>${t('app.noParkingZone')}</span><span><i class="sq" style="background:color-mix(in srgb,${zc.mpz} 20%,transparent);border-color:${zc.mpz};border-style:dashed"></i>${t('app.parkOnlyAtStations')}</span><span><i class="sq" style="background:color-mix(in srgb,${zc.slow} 20%,transparent);border-color:${zc.slow}"></i>${t('app.speedLimit')}</span><span class="muted">${t('app.outlineOperator')}</span>${zops.map(o => `<span><i class="sq" style="background:transparent;border-color:${opColor(o)}"></i>${esc(o)}</span>`).join('')}`;
}

// ---------- Preise, Anteile an erfassten Fahrzeugen, Zuverlässigkeit ----------
async function renderPricing() {
  const p = await loadOnce('pricing', 'pricing.json'); const tb = $('#tbl-pricing tbody');
  if (!p?.plans?.length) { tb.innerHTML = `<tr><td colspan="6" class="empty">${t('app.noPricingFeedsReadYetPrices')}</td></tr>`; return; }
  const tyIdx = state.type === 'all' ? null : opTypeIndex().inScope; // gewählte Fahrzeugart: nur Tarife von Anbietern mit dieser Art
  let list = p.plans.filter(x => (state.scope === 'DE' || (x.municipalities || []).includes(state.scope)) && (state.operator === 'all' || x.operator === state.operator) && (!tyIdx || tyIdx.get(x.operator)?.has(state.type)));
  const seen = new Set(); const rows = [];
  for (const src of list) for (const pl of src.plans) { const key = `${src.operator}|${pl.name}|${pl.unlock}|${pl.perMin[0]?.rate}`; if (seen.has(key)) continue; seen.add(key); rows.push({ op: src.operator, pl, src }); }
  rows.sort((a, b) => a.op.localeCompare(b.op) || (a.pl.unlock ?? 0) - (b.pl.unlock ?? 0));
  const money = (v, cur) => v == null ? '—' : esc(`${fmt(v, 2)} ${cur || '€'}`.replace(' EUR', ' €')); // Währung kommt aus dem Feed
  // Feed-Kennungen („LMG:PricingPlan:…“, „plan-scooter-EUR“) sind kein Tarifname: Fahrzeugart aus der Kennung („Tarif E-Scooter“), sonst der
  // erste Satz der Beschreibung (Satzende, nicht der Punkt in „0.99“), sonst „Tarif n“; die Kennung steht nur im title der Zelle
  const looksId = (s) => /^[A-Z]{2,}:|PricingPlan|-plan$|^plan-|^[\w-]{24,}$/i.test(s || '');
  const idType = (s) => { const m = /(e-?bike|cargo|scooter|bike)/i.exec(s || ''); if (!m) return null; const k = m[1].toLowerCase().replace('-', ''); return k === 'bike' ? t('app.tariffBike') : TYPE[k] || null; }; // „bike“ sagt nicht, ob mit Motor
  // Hinweis ausblenden, wenn er nur den Tarifnamen wiederholt
  const same = (a, b) => { const n = (s) => String(s || '').trim().replace(/[.\s]+$/, '').toLowerCase(); return n(a) === n(b); };
  const nth = new Map(); const planName = (op, pl) => { const raw = pl.name || pl.id || ''; if (!looksId(raw)) return { label: raw, id: pl.id || '' }; const ty = idType(`${pl.name || ''} ${pl.id || ''}`); if (ty) return { label: t('app.tariffType', { type: ty }), id: raw }; const d = String(pl.desc || '').split(/[.;](?=\s|$)|[\n]/)[0].trim(); const n = (nth.get(op) || 0) + 1; nth.set(op, n); return { label: d && d.length <= 60 ? d : t('app.tariffN', { n }), id: raw }; };
  tb.innerHTML = rows.slice(0, 60).map(({ op, pl, src }) => { const nm = planName(op, pl); return `<tr><td><span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span>${state.scope === 'DE' ? `<div class="sub-line">${esc(src.sourceId)}</div>` : ''}</td><td translate="no"${nm.id ? ` title="${esc(nm.id)}"` : ''}>${esc(nm.label)}</td><td class="n">${money(pl.unlock, pl.currency)}</td><td class="n">${pl.perMin.length ? pl.perMin.map(x => `${money(x.rate, pl.currency)}${x.interval && x.interval !== 1 ? ` ${t('app.perMin', { interval: x.interval })}` : ''}${x.start ? ` ${t('app.fromMin', { start: x.start })}` : ''}`).join('<br>') : '—'}</td><td class="n">${pl.perKm.length ? pl.perKm.map(x => money(x.rate, pl.currency)).join('<br>') : '—'}</td><td class="small" translate="no">${same(pl.desc, nm.label) ? '' : esc(pl.desc || '')}${pl.surge ? ` · ${t('app.dynamic')}` : ''}</td></tr>`; }).join('') || `<tr><td colspan="6" class="empty">${t('app.noPricesForThisFilterNot')}</td></tr>`;
  $('#pricing-note').textContent = rows.length > 60 ? t('app.moreTariffsChooseAreaOr', { v0: rows.length - 60 }) : t('app.tariffsAsOf', { length: rows.length, v1: timeText(p.at) });
}
async function renderShareChart() {
  const idx = state.histIndex; const box = $('#chart-share');
  // Tagesmittel aus history/daily.json (eine Datei statt sieben Verlaufstage, Vertrag 6); alter Datenstand: Verlaufstage einzeln
  const daily = await loadDaily();
  if (daily) {
    const fi = (daily.fields || []).indexOf('available'), days = (daily.days || []).slice(-7);
    // Bruchmarken (breaks): Tage vor einem Zählregel-Wechsel nicht zeigen, wenn die betroffenen Reihen ≥ 5 % des Bestands im Ausschnitt tragen
    const brk = daily.breaks || {}, cut = new Set(), brkOps = new Set(), brkDays = new Set();
    const perDay = days.map(d => { const m = new Map(); let aff = 0, all = 0; const ops = new Set(), bds = new Set(); for (const [k, ser] of Object.entries(daily.series)) { const [ags, op, ty] = k.split('|'); if (ags === 'DE' || !op) continue; if (state.scope !== 'DE' && ags !== state.scope) continue; if (state.type !== 'all' && ty !== state.type) continue; const v = ser[d]; if (!v || v[fi] == null) continue; m.set(op, (m.get(op) || 0) + v[fi]); all += v[fi]; if (brk[k] > d) { aff += v[fi]; ops.add(op); bds.add(brk[k]); } }
      if (all > 0 && aff / all >= 0.05) { cut.add(d); ops.forEach(o => brkOps.add(o)); bds.forEach(b => brkDays.add(b)); return null; } return m.size ? m : null; });
    const note = cut.size ? t('cal.shareBreak', { v0: [...brkDays].sort().map(b => `${b.slice(8)}.${b.slice(5, 7)}.`).join(', '), v1: esc([...brkOps].join(', ')) }) : '';
    if (days.length && fi >= 0) return drawShare(box, days, perDay, note);
  }
  const days = (idx?.days || []).slice(-7);
  if (!days.length) { box.innerHTML = `<div class="empty">${t('app.noHistoryYetItStartsWith')}</div>`; return; }
  const perDay = [];
  for (const d of days) { const h = await loadHistory(d); if (!h) { perDay.push(null); continue; } const byOp = new Map(); for (const [k, ser] of Object.entries(h.series)) { const [ags, op, ty] = k.split('|'); if (ags === 'DE') continue; if (state.scope !== 'DE' && ags !== state.scope) continue; if (state.type !== 'all' && ty !== state.type) continue; const v = ser.available.filter(x => x != null); if (!v.length) continue; byOp.set(op, (byOp.get(op) || 0) + v.reduce((a, b) => a + b, 0) / v.length); } perDay.push(byOp); }
  drawShare(box, days, perDay);
}
function drawShare(box, days, perDay, note = '') {
  const ops = [...new Set(perDay.flatMap(m => m ? [...m.keys()] : []))];
  const totals = perDay.map(m => m ? [...m.values()].reduce((a, b) => a + b, 0) : 0);
  // Reihen, die an keinem Tag einen Anteil haben (z. B. Zeus 0,0 %), weder als Linie noch in der Legende
  const series = ops.map(op => ({ name: op, color: opColor(op), values: perDay.map((m, i) => m && totals[i] ? ((m.get(op) || 0) / totals[i]) * 100 : null) })).filter(s => s.values.some(v => v > 0)).sort((a, b) => (b.values.at(-1) || 0) - (a.values.at(-1) || 0)).slice(0, 8);
  // Titel aus den Daten: so viele Tage, wie Werte haben (statt fest „7 Tage“)
  const nDays = perDay.filter(Boolean).length; $('#share-days').textContent = nDays ? ` · ${nDays} ${nDays === 1 ? t('rep.day') : t('rep.days')}` : '';
  const W = chartWidth(box, () => renderShareChart()), H = W < 520 ? 190 : 220, P = { l: 48, r: 16, t: 12, b: 26 };
  // y-Achse 0 bis aufgerundetes Maximum (Anteile liegen meist unter 30 %; 0–100 % drückte die Unterschiede platt)
  const mx = Math.max(0, ...series.flatMap(s => s.values.filter(v => v != null))), step = [1, 2, 5, 10, 20, 25].find(s => mx / s <= 5) || 25, top = Math.min(100, Math.max(step, Math.ceil(mx / step - 1e-9) * step));
  const x = (i) => P.l + (i / Math.max(1, days.length - 1)) * (W - P.l - P.r), y = (v) => P.t + (1 - v / top) * (H - P.t - P.b);
  let g = ''; for (let v = 0; v <= top + 1e-9; v += step) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 3}" text-anchor="end">${fmt(v)} %</text>`;
  const every = (W - P.l - P.r) / Math.max(1, days.length - 1) < 44 ? 2 : 1; // schmal: jeder zweite Tag beschriftet
  days.forEach((d, i) => { if (i % every && i !== days.length - 1) return; g += `<text x="${x(i)}" y="${H - 8}" text-anchor="${days.length > 1 && i === 0 ? 'start' : i === days.length - 1 && days.length > 1 ? 'end' : 'middle'}">${d.slice(8)}.${d.slice(5, 7)}.</text>`; });
  const paths = series.map(s => { let d = '', open = false; s.values.forEach((v, i) => { if (v == null) { open = false; return; } d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>` + s.values.map((v, i) => v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"/>`).join(''); }).join('');
  box.innerHTML = `<svg class="chart" data-px="1" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${t('app.shareOfRecordedVehicles')}. ${seriesSummary(series, (v) => `${fmt(v, 1)} %`)}`)}">${g}${paths}</svg>`;
  $('#share-legend').innerHTML = series.map(s => `<span><i class="dot" style="background:${s.color}"></i>${esc(s.name)} <span class="mono">${s.values.at(-1) == null ? '—' : fmt(s.values.at(-1), 1) + ' %'}</span></span>`).join('') + (note ? `<span class="muted small">${note}</span>` : '');
}

// ---------- Konsistenz ----------
const CONS_LABEL_DEF = () => ({ consistent: [t('app.consistent'), 'ok'], minor: [t('app.minorDeviation'), 'warn'], divergent: [t('app.divergent'), 'bad'], disjoint: [t('app.separateFleets'), 'info'], alt_unreachable: [t('app.alternativeNotReachable'), 'muted'], error: [t('app.error2'), 'bad'] });
const CONS_KIND = { get version() { return t('app.v2V3SameHost'); }, get land_vs_betreiber() { return t('app.stateFeedOperator'); }, get betreiber_vs_land() { return t('app.operatorStateFeed'); } };
const shortSrc = (id) => String(id).replace(/^mobidrom_[^:]+:source-/, 'NRW · ').replace(/^citybikes_/, 'CityBikes · ');
async function renderConsistency() {
  const c = await loadOnce('consistency', 'consistency.json'); const tb = $('#tbl-cons tbody');
  if (!c) { tb.innerHTML = `<tr><td colspan="9" class="empty">${t('app.noConsistencyCheckYetItRuns')}</td></tr>`; return; }
  const inScope = (ids, ags) => state.scope === 'DE' ? true : (ags ? ags === state.scope : ids.some(id => (state.latest?.sources || []).find(r => r.id === id)?.municipalities?.includes(state.scope)));
  const rows = [];
  for (const e of c.systems) { if (!inScope([e.sourceId]) || (state.operator !== 'all' && e.operator !== state.operator)) continue; rows.push({ kind: `${esc(CONS_KIND[e.kind] || e.kind || t('app.alternativeFeed'))}${e.idsRekeyed ? ` · ${t('app.idsReKeyed')}` : ''}${e.stationsOnly ? ` · ${t('app.stations')}` : ''}<div class="sub-line mono">${esc(e.sourceId)}</div>`, op: e.operator, a: e.stationsOnly ? e.primary?.stations : e.primary?.vehicles, b: e.stationsOnly ? e.alt?.stations : e.alt?.vehicles, diff: e.countDiff, overlap: e.idOverlap, pm: e.posMatch, med: e.medianDistM, verdict: e.verdict, w: e.verdict === 'divergent' ? 3 : e.verdict === 'minor' ? 2 : e.verdict === 'alt_unreachable' ? 1 : 0 }); }
  for (const p of c.pairs) { if (!inScope([p.a.sourceId, p.b.sourceId], p.ags) || (state.operator !== 'all' && p.operator !== state.operator)) continue; rows.push({ kind: `${t('app.twoSources', { muniName: esc(muniName(p.ags)), v1: p.idsRekeyed ? ` · ${t('app.idsReKeyed')}` : '' })}<div class="sub-line mono">${esc(shortSrc(p.a.sourceId))} ↔ ${esc(shortSrc(p.b.sourceId))}</div>`, op: p.operator, a: p.a.vehicles, b: p.b.vehicles, diff: p.countDiff, overlap: p.idOverlap, pm: p.posMatch, med: p.medianDistM, verdict: p.verdict, w: p.verdict === 'divergent' ? 3 : p.verdict === 'minor' ? 2 : p.verdict === 'disjoint' ? 1.5 : 0 }); }
  rows.sort((x, y) => y.w - x.w || (y.a || 0) - (x.a || 0));
  const seenRow = new Set(); const uniq = rows.filter(r => { const k = r.kind.replace(/<[^>]+>/g, '') + '|' + r.op; if (seenRow.has(k)) return false; seenRow.add(k); return true; });
  rows.length = 0; rows.push(...uniq);
  const show = rows.slice(0, 80);
  tb.innerHTML = show.map(r => { const [label, cls] = CONS_LABEL_DEF()[r.verdict] || [r.verdict, '']; return `<tr><td>${r.kind}</td><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span></td><td class="n">${fmt(r.a)}</td><td class="n">${fmt(r.b)}</td><td class="n">${r.diff == null ? '—' : pctf(r.diff, 1)}</td><td class="n">${r.overlap == null ? '—' : pctf(r.overlap, 1)}</td><td class="n">${r.pm == null ? '—' : pctf(r.pm, 1)}</td><td class="n">${r.med == null ? '—' : `${fmt(r.med)} m`}</td><td><span class="pill plain"${cls ? ` style="color:var(--${cls === 'muted' ? 'muted' : cls})"` : ''}>${esc(label)}</span></td></tr>`; }).join('') || emptyRow(9, t('app.noComparisonsInFilter'), t('app.comparisonsExistOnlyWhere'));
  const vc = {}; for (const r of rows) vc[r.verdict] = (vc[r.verdict] || 0) + 1;
  $('#cons-note').textContent = t('app.comparisonsAsOf', { length: rows.length, v1: Object.entries(vc).map(([k, v]) => `${v} ${(CONS_LABEL_DEF()[k] || [k])[0].toLowerCase()}`).join(' · '), v2: timeText(c.at), v3: rows.length > show.length ? ` · ${t('app.more3', { v0: rows.length - show.length })}` : '' });
}

const METHOD = () => `
<h3>${t('app.counting')}</h3><p>${t('app.availableMeansBookableNot')}</p>
<h3>${t('app.freshness')}</h3><p>${t('app.collectorRatesEveryFeed')}</p>
<h3>${t('app.geoCheckAndPlaceAssignment')}</h3><p>${t('app.numberFormatsAreNormalised')}</p>
<h3>${t('app.duplicatesAndSourceChanges')}</h3><p>${t('app.vehiclesOfSameOperatorAre')}</p>
<h3>${t('app.energy')}</h3><p>${t('app.lowEnergyFollowsSameRule')}</p>
<h3>${t('app.history')}</h3><p>${t('app.collectorRunsEvery20Minutes')}</p>
<h3>${t('app.quality')}</h3><p>${t('app.sourceSQualityScoreRates')}</p>
<h3>${t('app.usageAndMovement')}</h3><p>${t('app.forEachVehicleCollectorKeeps')}</p>
<p>${t('app.tripsTripsAreDerivedFrom')}</p>
<p>${t('app.chargeJumpsFromBelow40ToAt')}</p>
<h3>${t('app.cellsZonesPrices')}</h3><p>${t('app.startAndDestinationCellsAre')}</p>
<h3>${t('app.consistencyAndWalkingRoutes')}</h3><p>${t('app.ifSystemInCatalogueHasSecond')}</p>
<h3>${t('app.calibration')}</h3>${(() => { const s = t('app.estimatesAreAlignedWith'), i = s.indexOf('. <b>'); return i < 0 ? `<p>${s}</p>` : `<p>${s.slice(0, i + 1)}</p><details class="more"><summary>${t('app.calibrationDetail')}</summary><p>${s.slice(i + 2)}</p></details>`; })()}
<h3>${t('app.limits')}</h3><p>${t('app.openFeedsDoNotCoverAll')}</p>`;

// ---------- Versorgung an Haltestellen ----------
async function checkSupply() {
  const box = $('#supply');
  if (state.scope === 'DE') { box.innerHTML = `<div class="empty">${t('app.pleaseChooseMunicipality')}</div>`; return; }
  if (!state.live) { box.innerHTML = `<div class="empty">${t('app.firstFetchLiveSoThatVehicle')}</div>`; return; }
  await loadBoundaries();
  const f = state.boundaries?.features.find(x => x.properties.ags === state.scope); if (!f) { box.innerHTML = `<div class="empty">${t('app.municipalBoundaryMissing')}</div>`; return; }
  const b = f.bbox; const radius = +$('#sel-radius').value; const useWalk = $('#chk-walk').checked;
  box.innerHTML = `<div class="muted small">${t('app.loadingStops')}</div>`;
  const q = `[out:json][timeout:25];(node["highway"="bus_stop"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="tram_stop"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="station"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="halt"](${b[1]},${b[0]},${b[3]},${b[2]}););out body 800;`;
  let r = null;
  for (const ep of CFG.OVERPASS) { r = await getJson(`${ep}?data=${encodeURIComponent(q)}`, { timeout: 40000 }); if (r.ok && r.json?.elements) break; }
  if (!r?.ok || !r.json?.elements) { box.innerHTML = `<div class="empty">${t('app.overpassNotReachableAll', { v0: esc(r?.error || r?.status) })}</div>`; return; }
  const rawStops = (r.json.elements || []).filter(e => C.assignMunicipality(state.bIndex, e.lat, e.lon)?.ags === state.scope).map(e => ({ id: e.id, name: e.tags?.name || t('app.stop'), lat: e.lat, lon: e.lon, kind: e.tags?.railway ? 'Bahn/Tram' : 'Bus' }));
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
      box.innerHTML = `<div class="muted small">${t('app.calculatingWalkingRoutes', { done, length: todo.length, v2: state.walkProvider || 'Valhalla' })}</div><div class="progress"><i style="width:${(done / todo.length) * 100}%"></i></div>`;
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
  box.innerHTML = `<div class="tiles" style="margin-bottom:10px">${tile(t('app.stops'), fmt(stops.length), t('app.osmWithinStopPointsMerged', { muniName: esc(muniName(state.scope)), length: fmt(rawStops.length) }))}${tile(t('app.withoutVehicleWithinM', { radius, v1: useWalk ? t('app.walkingRoute') : t('app.straightLine') }), fmt(gaps.length), pctf(gaps.length, stops.length) + ` ${t('app.ofStops')}`, gaps.length / Math.max(1, stops.length) > 0.4 ? 'warn' : '')}${tile(t('app.median', { v0: useWalk ? t('app.walkingRoute') : t('app.straightLine') }), med == null ? '—' : `${fmt(med)} m`, t('app.toNearestAvailableVehicle'))}${useWalk ? tile(t('app.detourFactor'), ratio == null ? '—' : fmt(ratio, 2), t('app.stopsRoutedWalkingRoute', { routed: fmt(routed), v1: state.walkProvider || 'Valhalla', v2: routeFail ? ` · ${t('app.withoutRoute', { routeFail: fmt(routeFail) })}` : '' })) : ''}</div>
  <div class="tbl" tabindex="0" role="region" aria-label="${t('app.stopsWithoutVehicleWithin')}"><table><thead><tr><th>${t('app.stop')}</th><th>${t('app.type')}</th><th class="n">${t('app.straightLine')}</th>${useWalk ? `<th class="n">${t('app.walkingRoute')}</th><th class="n">${t('app.walkingTime')}</th>` : ''}<th>${t('app.operator')}</th></tr></thead><tbody>${gaps.slice(0, 40).map(s => `<tr><td translate="no">${esc(s.name)}</td><td>${s.kind}</td><td class="n">${s.dist == null ? '—' : `${fmt(s.dist)} m`}</td>${useWalk ? `<td class="n">${s.walk == null ? `<span class="muted">${s.dist != null && s.dist > Math.max(radius * 2, 1500) ? t('app.outOfRange') : t('app.notRouted')}</span>` : `${fmt(s.walk)} m`}</td><td class="n">${s.walkMin == null ? '—' : t('app.min2', { walkMin: fmt(s.walkMin) })}</td>` : ''}<td>${esc((useWalk && s.walkOp) || s.op || '–')}</td></tr>`).join('')}</tbody></table></div>${gaps.length > 40 ? `<div class="muted small">${t('app.moreStopsWithoutVehicle', { v0: gaps.length - 40 })}</div>` : ''}<div class="muted small" style="margin-top:6px">${useWalk ? t('app.walkingRoutesViaPedestrian', { max: fmt(Math.max(radius * 2, 1500)) }) : t('app.straightLineWalkingRoute')}</div>`;
}

// Fußweg-Matrix: OSRM (FOSSGIS, Fußgängerprofil), bei Ausfall Valhalla (FOSSGIS, pedestrian). Rückgabe {dist[i][j] m, sec[i][j]} oder null.
async function walkMatrix(sources, targets) {
  if (!targets.length) return null;
  const osrm = async () => {
    const coords = [...sources.map(s => `${s.lon.toFixed(6)},${s.lat.toFixed(6)}`), ...targets.map(tq => `${tq.lon.toFixed(6)},${tq.lat.toFixed(6)}`)];
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
      const ctrl = new AbortController(); const tq = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(CFG.VALHALLA + '/sources_to_targets', { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources: part.map(s => ({ lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6) })), targets: targets.map(tq => ({ lat: +tq.lat.toFixed(6), lon: +tq.lon.toFixed(6) })), costing: 'pedestrian', units: 'kilometers' }) });
      clearTimeout(tq);
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
  for (const s of state.supply.stops) { const d = state.supply.eff ? state.supply.eff(s) : s.dist; const gap = d == null || d > state.supply.radius; L.circleMarker([s.lat, s.lon], { radius: gap ? 6 : 4, weight: 2, color: gap ? tok('--bad') : tok('--info'), fillOpacity: .5 }).bindPopup(t('app.nearestAvailableVehicle', { name: esc(s.name), kind: s.kind, v2: s.dist == null ? '—' : t('app.mStraightLine', { n: fmt(s.dist) }), v3: s.walk != null ? ` · ${t('app.mWalkMin', { walk: fmt(s.walk), walkMin: fmt(s.walkMin) })}` : '', v4: esc(s.walkOp || s.op || '') })).addTo(L_.supply); }
}

// ---------- Steuerung ----------
function populateScope() {
  const sel = $('#sel-scope'); const munis = state.latest?.municipalities || {};
  // Betriebsgebiet-Erkennung (latest.municipalities[ags].presence, Sammler): Orte mit nur vereinzelten Fahrzeugen nicht als eigenes Gebiet; das
  // gewählte Gebiet bleibt immer wählbar (Links), neue Gebiete tragen den Zusatz „neu“
  const byState = {}; let hidden = 0;
  for (const m of Object.values(munis)) { if (m.presence?.status === 'vereinzelt' && m.ags !== state.scope) { hidden++; continue; } (byState[m.state] ??= []).push(m); }
  const STATES = { BW: 'Baden-Württemberg', BY: t('app.bavaria'), BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg', HE: t('app.hesse'), MV: t('app.mecklenburgWesternPomerania'), NI: t('app.lowerSaxony'), NW: t('app.northRhineWestphalia'), RP: t('app.rhinelandPalatinate'), SL: 'Saarland', SN: t('app.saxony'), ST: t('app.saxonyAnhalt'), SH: 'Schleswig-Holstein', TH: t('app.thuringia') };
  sel.innerHTML = `<option value="DE">${t('app.allOfGermany')}</option>` + Object.keys(byState).sort((a, b) => (STATES[a] || a).localeCompare(STATES[b] || b)).map(st => `<optgroup label="${esc(STATES[st] || st)}">${byState[st].sort((a, b) => String(a.name).localeCompare(String(b.name), 'de')).map(m => `<option value="${esc(m.ags)}">${esc(m.name)}${m.presence?.status === 'neu' ? ` (${t('app.presenceNew')})` : ''}</option>`).join('')}</optgroup>`).join('')
    + (hidden ? `<option disabled value="">${esc(t('app.strayHidden', { n: fmt(hidden) }))}</option>` : '');
  sel.title = state.latest?.presence ? t('app.presenceTitle') : '';
  sel.value = state.scope;
}
// Verknüpfte Filter (11.11.2026): Anbieter- und Fahrzeugart-Auswahl zeigen nur, was im gewählten Gebiet zusammenpasst – mit „E-Scooter“
// nur Anbieter mit E-Scootern, mit einem Anbieter nur dessen Arten. Grundlage: Gruppen Gemeinde|Anbieter|Art mit Fahrzeugen oder Stationen im
// Sammler-Stand, im Live-Modus zusätzlich der Live-Abruf; Datenlücken (latest.gaps) mit den Arten des Anbieters anderswo.
// prefer: 'type' (Art eben gewählt, Standard) → passt der Anbieter nicht, gilt „alle Anbieter“; 'op' (Anbieter eben gewählt) → passt die Art nicht, gilt „alle Arten“.
const TYPE_FILTER = ['scooter', 'ebike', 'bike', 'cargo', 'moped', 'car', 'unknown'];
let TYPE_LABELS = null; // Beschriftung der Arten aus dem HTML (data-i18n bzw. fester Text), einmal gelesen
function opTypeIndex() {
  const inScope = new Map(), anywhere = new Map();
  const add = (m, op, ty) => { if (!m.has(op)) m.set(op, new Set()); m.get(op).add(ty || 'unknown'); };
  const take = (k, g) => { const [ags, op, ty] = k.split('|'); if (!op || ags === 'DE' || !((g?.total || 0) + (g?.stations || 0) > 0)) return; add(anywhere, op, ty); if (state.scope === 'DE' || ags === state.scope) add(inScope, op, ty); };
  for (const [k, g] of Object.entries(state.latest?.groups || {})) take(k, g);
  if (state.live) for (const [k, g] of state.live.groups) take(k, g);
  return { inScope, anywhere };
}
// Datenlücke (latest.gaps) passt zur gewählten Art: Arten laut Liste (known_gaps.types), sonst die des Anbieters anderswo
function gapFitsType(g, idx = null) {
  if (state.type === 'all') return true;
  const ty = g.types?.length ? g.types : [...((idx || opTypeIndex()).anywhere.get(g.operator) || [])];
  return ty.includes(state.type);
}
function populateOperators(prefer = 'type') {
  const sel = $('#sel-operator'), tsel = $('#sel-type');
  let ops;
  if (state.scope === 'DE') ops = [...new Set((state.latest?.sources || []).filter(r => ['live', 'delayed'].includes(r.status)).map(r => r.operator))];
  else ops = Object.keys(muniInfo(state.scope)?.operators || {});
  if (state.live) for (const [k] of state.live.groups) { const [ags, op] = k.split('|'); if (state.scope === 'DE' || ags === state.scope) ops.push(op); }
  const gapOps = new Set(); for (const g of state.latest?.gaps || []) if (state.scope === 'DE' || muniName(state.scope) === g.city) { ops.push(g.operator); gapOps.add(g.operator); }
  ops = [...new Set(ops)].sort((a, b) => a.localeCompare(b, 'de'));
  const { inScope, anywhere } = opTypeIndex(), hasData = inScope.size > 0;
  // Arten je Anbieter im Gebiet; Datenlücke ohne Fahrzeuge im Gebiet: Arten des Anbieters anderswo (Dott Tübingen → E-Scooter, E-Bikes)
  const gapTypes = new Map(); for (const g of state.latest?.gaps || []) if (gapOps.has(g.operator) && g.types?.length) for (const ty of g.types) { if (!gapTypes.has(g.operator)) gapTypes.set(g.operator, new Set()); gapTypes.get(g.operator).add(ty); }
  const typesOf = (op) => inScope.get(op) || (gapOps.has(op) ? gapTypes.get(op) || anywhere.get(op) : null) || null;
  const opFits = (op, ty) => ty === 'all' || !hasData || !!typesOf(op)?.has(ty);
  const typesFor = (op) => { const out = new Set(); for (const o of op === 'all' ? ops : [op]) for (const ty of typesOf(o) || []) out.add(ty); return out; };
  if (!TYPE_LABELS && tsel) TYPE_LABELS = Object.fromEntries([...tsel.options].map(o => [o.value, { key: o.dataset.i18n || null, text: o.textContent }]));
  const typeOpts = (op) => { const have = typesFor(op); return TYPE_FILTER.filter(ty => !hasData || have.has(ty)); };
  // Vorrang: zuletzt geänderter Filter bleibt, der andere weicht auf „alle“ aus
  if (prefer === 'op') { if (state.operator !== 'all' && !ops.includes(state.operator)) state.operator = 'all'; if (state.type !== 'all' && !typeOpts(state.operator).includes(state.type)) state.type = 'all'; }
  else if (state.operator !== 'all' && !(ops.includes(state.operator) && opFits(state.operator, state.type))) state.operator = 'all';
  if (state.type !== 'all' && hasData && !typeOpts(state.operator).includes(state.type)) state.type = 'all';
  const shownOps = ops.filter(o => opFits(o, state.type));
  sel.innerHTML = `<option value="all">${t('app.allOperatorsOnSite')}</option>` + shownOps.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  sel.value = state.operator;
  if (tsel && TYPE_LABELS) {
    const opt = (v) => { const l = TYPE_LABELS[v] || { key: null, text: v }; return `<option value="${esc(v)}"${l.key ? ` data-i18n="${esc(l.key)}"` : ''}>${esc(l.key ? t(l.key) : l.text)}</option>`; };
    const list = typeOpts(state.operator); if (state.type !== 'all' && !list.includes(state.type)) list.push(state.type);
    tsel.innerHTML = opt('all') + list.map(opt).join('');
    tsel.value = state.type;
  }
}
function bind() {
  // Gebietswahl: Grenzen lädt erst der Live-Abruf (Ortszuordnung) bzw. die Grenz-Ebene; die Karte zeigt bis dahin die Sammler-Positionen
  // Pfeiltasten auf der geschlossenen Liste lösen je Schritt „change“ aus: per Tastatur erst nach 400 ms Ruhe wechseln (Enter sofort),
  // sonst startet jeder Schritt einen Gebietswechsel samt Live-Abruf aller Feeds
  const resetScope = (v) => { state.scope = v; state.live = null; state.supply = null; pendingLive = false; clearNotice('scope'); if (state.mode === 'live') state.mode = 'collector', $('#sel-mode').value = 'collector'; };
  const applyScope = (v) => { if (v === state.scope) return; resetScope(v); populateOperators(); syncUrl(true); renderAll(); autoLive(); };
  let scopeT = null, scopeByKey = false;
  $('#sel-scope').addEventListener('keydown', (e) => { if (e.key === 'Enter' && scopeT) { clearTimeout(scopeT); scopeT = null; applyScope(e.target.value); return; } if (/^(Arrow|Page)|^(Home|End)$/.test(e.key) || e.key.length === 1) scopeByKey = true; });
  $('#sel-scope').addEventListener('change', (e) => { clearTimeout(scopeT); scopeT = null; const v = e.target.value; if (scopeByKey) { scopeByKey = false; scopeT = setTimeout(() => { scopeT = null; applyScope(v); }, 400); } else applyScope(v); });
  // verknüpfte Filter: nach jeder Wahl die andere Liste neu (Anbieter nur mit der gewählten Art, Arten nur des gewählten Anbieters)
  $('#sel-operator').addEventListener('change', (e) => { state.operator = e.target.value; populateOperators('op'); syncUrl(true); renderAll(); });
  $('#sel-type').addEventListener('change', (e) => { state.type = e.target.value; populateOperators('type'); syncUrl(true); renderAll(); });
  // Zurück/Vorwärts: Gebiet, Anbieter, Art, Kundenansicht, Sprache und Ansicht aus der Adresszeile übernehmen, ohne automatischen Live-Abruf
  // (sonst startet jeder Schritt durch den Verlauf einen Abruf aller Feeds). Erst den Zustand setzen, dann zeichnen: setClient/setLang
  // schreiben die URL des gerade betretenen Eintrags (replaceState) und dürfen dabei keinen alten Stand hineinschreiben.
  window.addEventListener('popstate', () => {
    if (!urlReady) return;
    const q = new URLSearchParams(location.search), view = location.hash.slice(1), before = `${state.scope}|${state.operator}|${state.type}|${opsFleet() || ''}|${$('#ops-type').value}`;
    clearTimeout(scopeT); scopeT = null; scopeByKey = false; pendingLive = false;
    const sc = q.get('scope') || 'DE';
    if (sc !== state.scope && [...$('#sel-scope').options].some(o => o.value === sc)) resetScope(sc);
    applyUrlParams(q, true);
    // Sprache nur, wenn der Eintrag sie nennt (ohne ?lang= bleibt die gemerkte Wahl – so zeigt auch Neuladen dieselbe Sprache)
    const client = q.get('kunde') === '1', lg = q.get('lang');
    if (client !== isClient()) setClient(client);
    if (lg && lg !== lang()) { setLang(lg, { persist: false }); renderLangSwitch(); }
    // geänderte Filter: alle Ansichten veraltet, setView zeichnet die Zielansicht genau einmal (nach setClient/setLang: deren Zwischenstand
    // mit der alten Ansicht im Eintrag wird hier wieder überschrieben)
    if (dataReady && before !== `${state.scope}|${state.operator}|${state.type}|${opsFleet() || ''}|${$('#ops-type').value}`) { safe(renderHeader); for (const v of VIEWS) dirty.add(v); }
    setView(view);
  });
  $('#btn-share').addEventListener('click', copyLink);
  $('#btn-client').addEventListener('click', () => setClient(!isClient()));
  $('#econ-panel').addEventListener('change', (e) => { const i = e.target.closest('input.calib'); if (!i) return; setCalib(i.dataset.op, parseFloat(String(i.value).replace(',', '.'))); renderEcon(state.usage.day); });
  // Umschalter „kalibriert / gemessen“ (Standard kalibriert, im Browser gemerkt)
  $('#econ-panel').addEventListener('click', (e) => {
    const b = e.target.closest('#econ-mode button[data-cmode]'); if (!b || b.getAttribute('aria-disabled') === 'true') return; // gesperrt: kein Faktor wirksam (B3)
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
  $('#usage-days').addEventListener('click', (e) => { const b = e.target.closest('[data-uday]'); if (!b) return; state.usage.day = b.dataset.uday; try { const q = new URLSearchParams(location.search); q.set('day', state.usage.day); history.replaceState(history.state, '', `${location.pathname}?${q}${location.hash}`); } catch { /* file:// */ } renderUsage(); });
  $('#btn-flow-map').addEventListener('click', () => { $('#sel-layer').value = 'flow'; location.hash = '#live'; renderMap(); window.scrollTo({ top: 0 }); });
  document.addEventListener('click', (e) => { const a = e.target.closest('.pick-cell'); if (!a) return; e.preventDefault(); $('#sel-layer').value = 'flow'; location.hash = '#live'; renderMap(); setTimeout(() => state.map.setView([+a.dataset.lat, +a.dataset.lon], 16), 300); });
  $('#in-charge').addEventListener('change', (e) => { state.thresholds.charge = +e.target.value || 20; if (state.live) recomputeLive(); renderAll(); });
  $('#in-range').addEventListener('change', (e) => { state.thresholds.range = +e.target.value || 5; if (state.live) recomputeLive(); renderAll(); });
  $('#hist-days').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (!b) return; state.histDay = b.dataset.day; renderHistory(); markDirty('signals', 'live'); });
  // weitere Zeilen: danach Fokus auf die erste neue Zeile (der Knopf selbst verschwindet beim Neuaufbau)
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-more]'); if (!b || !MORE[b.dataset.more]) return; const key = b.dataset.more, n = MORE[key].n; MORE[key].n += 100; MORE_RENDER[key]?.(); const td = $(`#tbl-${key} tbody`)?.rows[n]?.cells[0]; if (td) { td.tabIndex = -1; td.focus(); } });
  // Kartenlegende: Anbieter hervorheben (erneuter Klick hebt auf)
  $('#map-legend-ops').addEventListener('click', (e) => { const b = e.target.closest('[data-map-hl]'); if (!b) return; const o = b.dataset.mapHl; state.mapFocus = state.mapFocus === o ? null : o; renderMap(); $(`#map-legend-ops [data-map-hl="${CSS.escape(o)}"]`)?.focus(); });
  // Abdeckung: Gebiet aufheben bzw. wieder anwenden
  $('#cov-sub').addEventListener('click', (e) => { if (!e.target.closest('[data-cov-all]')) return; covAllFor = covAllFor === state.scope ? null : state.scope; renderCoverage(); $('#cov-sub [data-cov-all]')?.focus(); });
  // Sprung in einen Abschnitt einer anderen Ansicht (z. B. Nutzung → Quellen › Kalibrierung)
  document.addEventListener('click', (e) => { const a = e.target.closest('a[data-jump]'); if (!a) return; e.preventDefault(); location.hash = a.getAttribute('href'); setTimeout(() => { const el = document.getElementById(a.dataset.jump); if (el) { el.scrollIntoView({ block: 'start' }); el.tabIndex = -1; el.focus({ preventScroll: true }); } }, 250); });
  $('#sig-filter').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; sigFilter = b.dataset.cat; renderSignals(); });
  $('#cov-search').addEventListener('input', renderCoverage); $('#cov-dir').addEventListener('change', renderCoverage);
  $('#src-search').addEventListener('input', renderSourceTable); $('#src-status').addEventListener('change', renderSourceTable);
  $('#btn-supply').addEventListener('click', checkSupply);
  $('#btn-supply-map').addEventListener('click', () => { renderSupplyLayer(); location.hash = '#live'; });
  $('#btn-csv').addEventListener('click', exportCsv);
  $('#btn-theme').addEventListener('click', () => { const cur = document.documentElement.dataset.theme; const next = cur === 'light' ? 'dark' : cur === 'dark' ? '' : 'light'; if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme; try { localStorage.setItem('mp-theme', next); } catch {} if (dataReady) renderAll(); });
  // Anbieter- und Ebenenfarben haben je Thema eigene Stufen: bei Themenwechsel (Knopf oder System) neu zeichnen
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (dataReady && !document.documentElement.dataset.theme) renderAll(); });
  document.addEventListener('click', (e) => { const a = e.target.closest('.pick-muni'); if (!a) return; e.preventDefault(); $('#sel-scope').value = a.dataset.ags; $('#sel-scope').dispatchEvent(new Event('change')); location.hash = '#live'; window.scrollTo({ top: 0 }); });
  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
}
function recomputeLive() { if (!state.live) return; state.live.groups = C.aggregateGroups(state.live.vehicles, state.live.stations, { chargeThreshold: state.thresholds.charge, rangeThreshold: state.thresholds.range }); }
function exportCsv() {
  const rows = operatorRows(); const head = [t('app.operator'), t('app.area'), t('app.available3'), t('app.reported3'), t('app.disabled2'), t('app.reserved'), t('app.lowenergy'), t('app.withenergydata'), t('app.stations'), t('app.emptystations'), 'Status', t('app.dataagemin'), t('app.sources2'), t('app.licence')];
  // Zellen, die mit = + - @ (oder Tab/CR) beginnen, würden in Tabellenprogrammen als Formel laufen: Text mit ' davor
  const cell = (v) => { let s = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const en = (op) => { const e = energyOfOp(op); return e.pending ? ['', ''] : [e.low, e.known]; }; // Energie niedrig nach energyLow (wie Kacheln und Disposition)
  const lines = rows.map(r => [r.op, scopeLabel(), r.st.available, r.st.total, r.st.disabled, r.st.reserved, ...en(r.op), r.st.stations, r.st.stationsEmpty, STATUS[r.status] || r.status, r.age == null ? '' : Math.round(r.age / 60e3), r.dirs.map(d => DIRS[d] || d).join('|'), r.license || ''].map(cell).join(';'));
  const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mobility-pulse_${state.scope}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Seitenweite Ergänzungen: Rahmenschutz, Hinweisband für abweichenden Datenstand, Höhe der Kopfleiste für scroll-padding,
// Leaflet-Bedienelemente in der Sprache der Seite (alle Karten, auch die der Module), Schriftausgleich für Diagramme mit festem viewBox
function relabelLeaflet(root = document) {
  for (const [sel, key] of [['.leaflet-control-zoom-in', 'common.zoomIn'], ['.leaflet-control-zoom-out', 'common.zoomOut']]) for (const a of root.querySelectorAll(sel)) { a.title = t(key); a.setAttribute('aria-label', t(key)); }
  for (const a of root.querySelectorAll('.leaflet-control-attribution a[href*="leafletjs.com"]')) { a.title = t('common.leafletTitle'); a.lang = 'en'; }
}
const K_RO = typeof ResizeObserver === 'function' ? new ResizeObserver((es) => es.forEach(e => fixChartFont(e.target))) : null;
// Diagramme mit festem viewBox (z. B. web/report.js): Schrift über --k auf ≈ 11 px halten, begrenzt auf 0,75–1,4, damit Achsentexte im Rand bleiben
function fixChartFont(svg) { const vb = svg.viewBox?.baseVal, w = svg.clientWidth; if (!vb?.width || !w) return; svg.style.setProperty('--k', Math.min(1.4, Math.max(0.75, vb.width / w)).toFixed(3)); }
// Tabellen-Rahmen (.tbl) scrollen am Telefon quer: per Tastatur erreichbar machen, benannt nach Beschriftung oder Überschrift des Abschnitts
function scrollRegion(d) {
  if (d.hasAttribute('tabindex')) return;
  d.tabIndex = 0; d.setAttribute('role', 'region');
  if (!d.hasAttribute('aria-label') && !d.hasAttribute('aria-labelledby')) {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const base = clean(d.querySelector('caption')?.textContent || d.closest('.panel,.rp-sec,.rp-cap,section')?.querySelector('h2,h3,h4')?.textContent);
    if (!base) return;
    // Bereichsnamen eindeutig halten (axe landmark-unique): sonst erste Spaltenüberschrift, dann laufende Nummer anhängen
    const taken = (n) => [...document.querySelectorAll('[role="region"][aria-label]')].some(x => x !== d && x.getAttribute('aria-label') === n);
    let name = base; const th = clean(d.querySelector('thead th')?.textContent);
    if (taken(name) && th) name = `${base}: ${th}`;
    for (let k = 2; taken(name); k++) name = `${base} (${k})`;
    d.setAttribute('aria-label', name);
  }
}
// ---------- Orientierung auf langen Seiten: Sprungleiste „Auf dieser Seite“ und Nach-oben-Knopf ----------
// Ab 4 sichtbaren Panels mit Überschrift zeigt die Ansicht unter dem Titel eine Leiste, die zu den Panels springt. Die Ansicht bleibt vollständig
// (nichts gefaltet: Strg+F und Druck sehen alles). Keine Links mit „#…“: der Hash wählt die Ansicht, darum Knöpfe mit scrollIntoView.
let tocTimer = 0, tocSeq = 0;
const scheduleToc = () => { clearTimeout(tocTimer); tocTimer = setTimeout(buildToc, 350); };
function buildToc() {
  const view = $(`#view-${currentView}`); if (!view) return;
  const items = [];
  for (const h of view.querySelectorAll('.panel h2')) {
    if (!h.offsetParent || h.closest('.toc')) continue;
    const c = h.cloneNode(true); c.querySelectorAll('.pill,.badge,button,.chip,sup').forEach(x => x.remove());
    const label = c.textContent.replace(/\s+/g, ' ').trim(); if (!label) continue;
    const box = h.closest('.panel') || h; if (!box.id) box.id = `sec-${currentView}-${++tocSeq}`;
    items.push([box.id, label.length > 44 ? `${label.slice(0, 42)}…` : label]);
  }
  let toc = view.querySelector(':scope > .toc');
  if (items.length < 4) { toc?.remove(); return; }
  const sig = `${lang()}|${items.map(i => i.join('=')).join('|')}`;
  if (toc?.dataset.sig === sig) return;
  if (!toc) { toc = document.createElement('nav'); toc.className = 'toc'; const hero = view.querySelector(':scope > .hero'); if (hero) hero.after(toc); else view.prepend(toc); }
  toc.dataset.sig = sig; toc.setAttribute('aria-label', t('ux.onThisPage'));
  toc.innerHTML = `<span class="toc-l">${esc(t('ux.onThisPage'))}</span>${items.map(([id, l]) => `<button type="button" class="chip" data-toc="${esc(id)}">${esc(l)}</button>`).join('')}`;
}
function bindOrientation() {
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('.toc [data-toc]'); if (!b) return;
    const box = document.getElementById(b.dataset.toc); if (!box) return;
    box.scrollIntoView({ behavior: calm(), block: 'start' });
    const h = box.querySelector('h2'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  });
  const up = $('#to-top');
  if (up) { const upd = () => { up.hidden = window.scrollY < 900; }; addEventListener('scroll', upd, { passive: true }); upd(); up.addEventListener('click', () => window.scrollTo({ top: 0, behavior: calm() })); }
  onLang(scheduleToc);
}
function enhanceUi() {
  if (window.top !== window.self) { document.body.classList.add('framed'); notice(() => t('app.framedWarning'), 'bad', 'framed'); }
  if (CFG.DATA_OK) {
    const b = document.createElement('div'); b.className = 'note warn data-origin'; b.id = 'data-origin';
    const put = () => { b.innerHTML = t('app.dataOriginBanner', { src: `<span class="mono">${esc(QS.get('data'))}</span>` }); };
    put(); onLang(put); $('#notice')?.before(b);
  }
  const bar = $('.topbar'), setH = () => document.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
  if (bar) { setH(); if (typeof ResizeObserver === 'function') new ResizeObserver(setH).observe(bar); }
  const main = $('main');
  if (main) new MutationObserver((ms) => {
    let leaf = false;
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.closest?.('.leaflet-control-container') || n.querySelector?.('.leaflet-control-zoom')) leaf = true;
      for (const s of n.matches?.('svg.chart') ? [n] : n.querySelectorAll?.('svg.chart') || []) if (!s.dataset.px) { fixChartFont(s); K_RO?.observe(s); }
      for (const d of n.matches?.('.tbl') ? [n] : n.querySelectorAll?.('.tbl') || []) scrollRegion(d);
    }
    if (leaf) relabelLeaflet(main);
    if (ms.some(m => !m.target.closest?.('.toc, .leaflet-container'))) scheduleToc();
  }).observe(main, { childList: true, subtree: true });
  bindOrientation();
  main?.querySelectorAll('.tbl').forEach(scrollRegion);
  relabelLeaflet(); onLang(() => relabelLeaflet());
// Werkzeuge (Stand, Link kopieren, Kundenansicht, DE/EN, Hell/Dunkel): am Desktop in der Seitenleiste, am Telefon im Menü „⋯“.
  // In der Kopfleiste bleiben Ort, Segmente und „Live abrufen“: sie bleibt in allen Bereichen einzeilig (vorher 2 Zeilen im Marktbild).
  const mq = matchMedia('(max-width: 820px)');
  const placeTools = () => {
    const mob = mq.matches, side = $('#side-tools'), menu = $('#tools-m-body');
    if (!side || !menu) return;
    for (const id of ['stand-pill', 'btn-share', 'btn-client', 'lang-switch', 'btn-theme']) { const el = $(`#${id}`); if (el) (mob ? menu : side).appendChild(el); }
    // Telefon: „Live abrufen“ und „⋯“ sitzen neben der Marke (spart die eigene Zeile unter den Segmenten), am Desktop wieder in der Kopfleiste
    const brand = $('aside .brand'), live = $('#btn-live'), tm = $('#tools-m'), stand = $('.stand');
    if (brand && live && tm && stand) { if (mob) brand.after(live, tm); else stand.append(live, tm); }
    if (!mob) $('#tools-m')?.removeAttribute('open');
  };
  placeTools(); mq.addEventListener?.('change', placeTools);
  document.addEventListener('click', (e) => { const m = $('#tools-m'); if (m?.open && !m.contains(e.target)) m.open = false; });
  // Filter am Telefon eingeklappt: Zusammenfassung als Knopf
  $('#filters-sum')?.addEventListener('click', () => { const f = $('#filters'), open = !f.classList.contains('open'); f.classList.toggle('open', open); $('#filters-sum').setAttribute('aria-expanded', String(open)); });
}
// Zusammenfassung der Filterleiste (Telefon): Gebiet · Anbieter · Fahrzeugart, nur die in der Ansicht wirksamen
function renderFilterSum() {
  const b = $('#filters-sum'); if (!b) return;
  const fs = (FILTERS[currentView] || 'scope op type mode').split(' ');
  const parts = [fs.includes('scope') ? scopeLabel() : null, fs.includes('op') ? (state.operator === 'all' ? t('app.allOperatorsOnSite') : state.operator) : null, fs.includes('type') ? (state.type === 'all' ? t('html.allVehicleTypes') : TYPE[state.type] || state.type) : null].filter(Boolean);
  b.textContent = parts.join(' · ');
}
async function init() {
  try { const tq = localStorage.getItem('mp-theme'); if (tq) document.documentElement.dataset.theme = tq; } catch {}
  applyStatic(); renderLangSwitch(); bindLangSwitch(); onLang(onLanguage); renderLangHint();
  if (QS.get('kunde') === '1') { document.body.classList.add('mode-client'); $('#btn-client').setAttribute('aria-pressed', 'true'); $('#btn-share').textContent = t('app.copyClientLink'); }
  if (DEMO) document.body.classList.add('mode-demo');
  initMap(); bind(); enhanceUi();
  // getJsonShared: ops.js lädt ops/<Land>.json, Zonen, Zellen usw. über denselben Promise-Cache wie die Übersichtskarte
  initOps({ state, CFG, getJson: getJsonShared, esc, fmt, opColor, muniName, notice, clearNotice, loadBoundaries, loadUsageIndex, loadCells, loadOnce, loadGroups, TYPE, econFor, syncUrl });
  $$('abbr[data-gloss]').forEach(a => { a.title = gl(a.dataset.gloss); }); // Glossar-Tooltips aus einer Quelle
  // Platzhalter-Kacheln in der späteren Anzahl: die Seite springt nicht, wenn die Zahlen kommen (CLS)
  for (const [id, n] of [['#live-tiles', 5], ['#lab-tiles', 4], ['#usage-tiles', 5], ['#econ-tiles', 5], ['#cov-tiles', isClient() ? 3 : 4], ['#src-tiles', 4]]) { const el = $(id); if (el && !el.children.length) el.innerHTML = '<div class="tile skel" aria-hidden="true"><div class="l">&nbsp;</div><div class="v">–</div><div class="s">&nbsp;</div></div>'.repeat(n); }
  setView(location.hash.slice(1) || 'live');
  await loadBase();
  populateScope();
  const deep = applyUrlParams(); // Deep-Link: Gebiet, Anbieter, Fahrzeugart aus der URL
  bindTableCsv(); bindGlossTips(); renderAll(); syncUrl();
  if (deep) autoLive();
  if (DEMO) return; // Demo-Stand: kein Nachladen
  // Sammler-Stand alle 2 Min. prüfen; bei neuem Lauf alles neu laden (Ereignis-, Zonen- und Flottendateien inklusive)
  setInterval(async () => {
    const s = await getJson(fresh('status.json')); if (!s.ok || s.json.at === state.status?.at) return;
    const l = await getJson(latestUrl(s.json)); if (!l.ok) return;
    state.status = s.json; state.latest = l.json; state.hist = {}; state.usage.docs = {}; state.usage.index = null; state.usage.cells = {}; state.usage.profile = null; state.usage.archiveDays = null; state.usage.zones = {};
    for (const k of ['idle', 'idleLong', 'quota', 'reliability', 'consistency', 'zonesIndex', 'pricing', 'runs', 'archiveIndex', 'groups']) state.usage[k] = null;
    const keepB = [...REQ].filter(([k]) => k.startsWith('boundaries')); resetCache(); if (state.bIndex) for (const [k, p] of keepB) REQ.set(k, p); // Grenzen ändern sich nicht je Lauf
    groupsReq = null; dailyReq = null; dailyLoaded = false; state.daily = null; state.fleet.clear(); ENERGY.clear(); Ops.resetCaches?.(); Rp.resetReportCaches?.(); Cov.resetCoverageCache?.(); Cmp.resetCompareCache?.(); Fv.resetForecastCache?.(); Sp.resetSpotsCache?.();
    const hi = await cached('history/index.json', 25000); if (hi.ok) state.histIndex = hi.json;
    populateScope(); populateOperators(); clearNotice('stale'); renderAll();
  }, 2 * 60e3);
  setInterval(renderStamp, 30e3);
}
init();
