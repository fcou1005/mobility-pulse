// Dashboard: Laden: Dateien des Datenstands, Cache, Hinweise, Grenzen, Verlauf (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as C from './pulse-core.js';
import { t, fmtLocale } from './i18n.js';
import { checkMajor } from './pulse-schema.js';
import { $, $$, CFG, DEMO, QS, ageText, cl, esc, fmt, isClient, state } from './app-core.js';
import { scopeState } from './app-usage.js';

// ---------- Laden ----------
// raw.githubusercontent cacht bis zu 5 Min.; ein eindeutiger Parameter holt den aktuellen Stand
export const fresh = (file) => `${CFG.DATA}${file}?t=${Date.now()}`;
export const MAX_BYTES = 40 * 1024 * 1024; // Größenlimit je Antwort
// Timeout gilt bis zum Ende des Lesens; Antworten über 40 MB werden abgebrochen
export async function getJson(url, { timeout = 25000 } = {}) {
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
          if (json && typeof url === 'string' && url.startsWith(CFG.DATA)) schemaHint(url.slice(CFG.DATA.length).split('?')[0], json);
        } catch (e) { error = e.message === t('app.tooLarge') ? t('app.tooLarge') : e.name === 'AbortError' ? 'Timeout' : t('app.notJson'); }
      }
    }
    return { ok: r.ok && !!json, status: r.status, json, error, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) { return { ok: false, status: 0, json: null, error: e.name === 'AbortError' ? 'Timeout' : t('common.netCors'), latencyMs: Math.round(performance.now() - t0) }; }
  finally { clearTimeout(tq); }
}
// S3.7 Datenverträge: passt die MAJOR-Version einer Datei nicht (lib/pulse-schema.js), einmal je Familie ein Hinweis – die Seite rechnet
// trotzdem weiter, aber der Leser weiß, dass Zahlen aus dieser Datei falsch sein können. Dateien ohne schemaVersion gelten als verträglich.
export const SCHEMA_SEEN = new Set();
export function schemaHint(file, json) {
  const bad = checkMajor(file, json); if (!bad || SCHEMA_SEEN.has(bad.family)) return;
  SCHEMA_SEEN.add(bad.family); console.warn('[Datenformat]', file, bad);
  notice(() => t('app.schemaMismatch', { file: esc(file), got: esc(bad.got), expected: esc(bad.expected) }), 'warn', `schema-${bad.family}`);
}
// Jede Datei des Datenstands nur einmal laden: das Promise wird sofort gemerkt (parallele Aufrufer teilen sich den Download).
// Fehlende Dateien (404) bleiben gemerkt bis zum nächsten Datenstand; Netzfehler/Timeouts dürfen nach 30 s erneut versucht werden.
export const REQ = new Map();
 export const FAILED = new Map(); // Datei → HTTP-Status/Fehler des letzten Versuchs
export function cached(file, timeout = 60000) {
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
export const resetCache = () => { REQ.clear(); FAILED.clear(); };
// getJson für ops.js (und künftige Module): Dateien des Datenstands laufen über denselben Cache, fremde URLs direkt
export const getJsonShared = (url, opt = {}) => typeof url === 'string' && url.startsWith(CFG.DATA) && !url.includes('?') ? cached(url.slice(CFG.DATA.length), opt.timeout) : getJson(url, opt);
// S4.8: Dateinamen nur unter „Prüfen“ (Quellen › Nicht ladbare Dateien); hier Grund und Handlung bzw. Zeitangabe
export const failedText = (file) => { const f = FAILED.get(file); return f === 404 ? t('ux.dataNotYet') : f ? t('ux.dataNotLoadable') : t('app.noData'); };
export const emptyRow = (cols, msg, hint = '') => `<tr><td colspan="${cols}" class="empty"><b>${esc(msg)}</b>${esc(hint)}</td></tr>`;
// Chip-Gruppe neu aufbauen, ohne dass der Tastaturfokus auf <body> fällt: der Knopf mit demselben Wert (attr) bekommt den Fokus zurück
export function setChips(el, attr, html) {
  if (!el) return;
  const a = document.activeElement, v = a && el.contains(a) ? a.getAttribute(attr) : null;
  el.innerHTML = html;
  if (v != null) el.querySelector(`[${attr}="${CSS.escape(v)}"]`)?.focus();
}
// html: Text oder Funktion, die den Text liefert (Funktion = beim Sprachwechsel neu erzeugt)
// #notice ist eine höfliche Live-Region (index.html); Fehler (kind 'bad') werden zusätzlich als role="alert" sofort angesagt
export function notice(html, kind = '', id = null) {
  const box = $('#notice');
  const el = id && $(`#notice [data-id="${id}"]`) || document.createElement('div');
  el.className = `note ${kind}`; if (id) el.dataset.id = id; if (kind === 'bad') el.setAttribute('role', 'alert'); else el.removeAttribute('role');
  el._html = typeof html === 'function' ? html : null; el.innerHTML = el._html ? el._html() : html; if (!el.parentNode) box.appendChild(el); return el;
}
export const refreshNotices = () => $$('#notice .note').forEach(el => { if (el._html) try { el.innerHTML = el._html(); } catch (e) { console.error('Hinweis', e); } });
export const clearNotice = (id) => $(`#notice [data-id="${id}"]`)?.remove();

// latest.json mit dem Zeitpunkt aus status.json als Anhang: unveränderter Lauf = gleiche Adresse, der Browser fragt nur nach (304) statt 1 MB neu zu laden
export const latestUrl = (status, file = 'latest.json') => (status?.at ? `${CFG.DATA}${file}?t=${encodeURIComponent(status.at)}` : fresh(file));
// S3.8 Rest: Ansichten, die mit latest-core.json starten (Quellen ohne Prüfdetails, ohne groups; lib/pulse-split.js latestCore). Jede andere
// Ansicht lädt vor dem Zeichnen latest.json (ensureFullLatest), ebenso der Live-Abruf (volle Quellen).
export const LITE_VIEWS = new Set(['ops']);
export const liteWanted = (view) => LITE_VIEWS.has(view);
/** latest.json bzw. latest-core.json zum Stand status; Kern ohne Kennzeichen lite (älterer Datenstand) → latest.json */
export async function loadLatest(status, lite) {
  if (lite) { const c = await getJson(latestUrl(status, 'latest-core.json')); if (c.ok && c.json?.lite && c.json.at === status?.at) return c; }
  return getJson(latestUrl(status));
}
let fullReq = null;
/** Vollständiges latest.json zum geladenen Stand nachladen (nach Start mit latest-core.json); true, wenn state.latest danach vollständig ist */
export function ensureFullLatest() {
  if (!state.latest?.lite) return Promise.resolve(true);
  const at = state.latest.at;
  return (fullReq ??= Promise.all([getJson(latestUrl(state.status)), state.catalog ? null : loadCatalog()]).then(([r]) => { fullReq = null; if (r.ok && r.json?.at === at && state.latest?.at === at) state.latest = r.json; return !state.latest?.lite; }, () => { fullReq = null; return false; }));
}
// Quellenkatalog (sources.json; fehlt er im Datenstand, der vom Branch main). Start mit latest-core.json: erst mit ensureFullLatest –
// die Disposition braucht daraus nur parking_reference der Gemeinde, das steht in ops-input/area/<AGS>.json
export const loadCatalog = async () => (state.catalog = (await cached('sources.json', 25000)).json || (await getJson(CFG.MAIN + 'sources.json')).json);
export async function loadBase(view = null) {
  const lite = !DEMO && liteWanted(view), pSrc = lite ? null : cached('sources.json', 25000), pHist = cached('history/index.json', 25000);
  const pCal = cached('calendar.json', 25000).then(r => { state.calendar = r.json?.version === 1 ? r.json : null; }); // Tagtyp-Kalender (Sammler, OpenHolidays); fehlt er: lokale Feiertagsrechnung
  const status = await getJson(fresh('status.json'));
  const [latest, hist] = await Promise.all([loadLatest(status.json, lite), pHist]);
  state.status = status.json; state.latest = latest.json; state.histIndex = hist.json; await pCal;
  if (!latest.ok) FAILED.set('latest.json', latest.status || latest.error); // für die Leerzeilen der Tabellen
  if (!state.latest?.lite) { await pSrc; await loadCatalog(); } else state.catalog = null;
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
export let boundariesReq = null;
 export const bLands = new Map();
export const bboxOf = (f) => { if (!f.bbox) { const c = JSON.stringify(f.geometry?.coordinates || []).match(/-?\d+(\.\d+)?/g) || []; let x0 = 999, y0 = 999, x1 = -999, y1 = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } f.bbox = [x0, y0, x1, y1]; } return f; };
export function loadAllBoundaries() {
  return boundariesReq ??= cached('boundaries-active.json', 60000).then(r => {
    if (!r.ok) return state.bIndex || null;
    for (const f of r.json.features || []) bboxOf(f);
    state.boundaries = r.json; state.bIndex = C.buildMunicipalityIndex(r.json); state.bFull = true;
    return state.bIndex;
  });
}
export function loadBoundaries(land = state.scope !== 'DE' ? scopeState() : null) {
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
export const hasCenters = () => Object.values(state.latest?.municipalities || {}).some(m => Array.isArray(m.c));
export const FC_dayOfNow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export async function loadHistory(day) {
  if (state.hist[day]) return state.hist[day];
  const r = await cached(`history/${day}.json`, 60000);
  state.hist[day] = r.json || null; return state.hist[day];
}
// Tagesmittel über bis zu 30 Tage (history/daily.json, Vertrag 6); null bei altem Datenstand
export let dailyReq = null;
export const resetDaily = () => { dailyReq = null; }; // S3.9: Zurücksetzen aus app.js (Importe sind nur lesbar)
export const loadDaily = () => dailyReq ??= cached('history/daily.json', 60000).then(r => r.ok && r.json?.days && r.json?.series ? r.json : null);
// Reihen je „Gemeinde|Anbieter“ einmal je Datei indizieren (daily.json, history/<Tag>.json; Schlüssel Gemeinde|Anbieter|Art): Signale fragen je Paar
// nach, und ein Durchlauf über alle Reihen je Paar war quadratisch (Deutschland: 723 Paare × 1.400 Reihen)
export const SER_IX = new WeakMap(), SER_KEY = new WeakMap(); // SER_KEY: Reihe → Schlüssel Gemeinde|Anbieter|Art (Bruchmarken)
export function seriesOf(doc, ags, op) {
  let m = SER_IX.get(doc);
  if (!m) { m = new Map(); for (const [k, ser] of Object.entries(doc?.series || {})) { const j = k.indexOf('|', k.indexOf('|') + 1); const key = j < 0 ? k : k.slice(0, j); (m.get(key) || m.set(key, []).get(key)).push(ser); if (ser && typeof ser === 'object') SER_KEY.set(ser, k); } SER_IX.set(doc, m); }
  return m.get(`${ags}|${op}`) || [];
}
// Mittel je Gemeinde|Anbieter über die vorigen Tage (ohne den gezeigten Tag): Anteil gesperrt und Anteil Energie niedrig am Bestand.
// Bruchmarke (daily.json → breaks, Zählregel geändert): Tage vor dem Bruch zählen für diese Reihe nicht im Mittel.
export function dailyBaseline(daily, ags, op, excludeDay) {
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
