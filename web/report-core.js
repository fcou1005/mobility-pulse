// Mobility Pulse — Bericht (Ansicht) – Laden, Kalibrierung, Stil, Bausteine, Kommunal-Bericht (aus report.js geschnitten; report.js bleibt die Fassade für alle Importe).
import * as R from './pulse-report.js';
import * as K from './pulse-calib.js';
import { liveSummary } from './pulse-forecast.js';
import { VEHICLE_TYPE_LABEL } from './pulse-core.js';
import { t, tx, tMap, lang, dateFmt } from './i18n.js';
import { CALIB_DAYS, calibLabel, mbBase, mbMainType, mbBadge, mbInTile } from './ui-shared.js';
import { hasLeaflet, mountCellMaps, printReport, reducedMotion, reportCsv, unmountCellMaps } from './report-maps.js';
import { mbFlagText } from './report-more.js';
import { PRINT } from './tokens.js';
import { answerHtml, clearAnswer, setAnswer, viewSlot } from './answer.js';

export const FCL = { liveSummary };

export const S = new WeakMap(); // Element → { ctx, tok, period, show }
// Teilbare Ansicht: ?period=… bzw. ?day=… (nur geprüfte Formen; unbekannte Werte fallen auf den Standard zurück)
const urlParam = (k) => { try { const v = new URLSearchParams(location.search).get(k); return v && /^[A-Za-z0-9:_-]{1,20}$/.test(v) ? v : null; } catch { return null; } };
const urlSet = (k, v) => { try { const q = new URLSearchParams(location.search); if (v && v !== 'all') q.set(k, v); else q.delete(k); const qs = q.toString().replace(/%3A/gi, ':'); history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`); } catch { /* file:// o. Ä. */ } };
export const st = (el) => { let s = S.get(el); if (!s) { s = { tok: 0, period: urlParam('period') || 'all', show: {} }; S.set(el, s); } return s; };
const CACHE = new Map();
// Datum, Uhrzeit, Wochentage, Fahrzeugart, Zeitraum-Art und Quellstatus in der Sprache der Seite (Formatierer je Sprache gecacht)
export const stamp = (ms) => (ms ? dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: R.TZ }).format(new Date(ms)) : '–');
export const hhmm = (ms) => (ms ? dateFmt({ hour: '2-digit', minute: '2-digit', timeZone: R.TZ }).format(new Date(ms)) : '–');
export const dd = (day) => (/^\d{4}-\d{2}-\d{2}$/.test(day || '') ? dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`)) : R.dayLabel(day));
export const dm = (day) => (/^\d{4}-\d{2}-\d{2}$/.test(day || '') ? dateFmt({ day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`)) : String(day || ''));
const TYPE = tMap('type', VEHICLE_TYPE_LABEL);
export const WD = () => (lang() === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : R.WEEKDAYS);
export const WDL = () => (lang() === 'en' ? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] : R.WEEKDAYS_LONG);
const PKIND = (k) => ({ Monat: t('rep.month'), Quartal: t('rep.quarter2'), Tage: t('rep.days') }[k] || k);
export const CAPSRC = tMap('capsrc', R.CAP_SOURCE_STATUS);
const sum = (a) => (a || []).reduce((x, y) => x + (y || 0), 0);
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const typeName = (tq) => TYPE[tq] || tq;

// ---------- Laden (ein Download je Datei; Dateien des laufenden Tags mit Laufstempel, damit neue Sammler-Läufe ankommen) ----------
// Bietet die Seite einen gemeinsamen Cache an (ctx.sharedCache, app.js leert ihn bei jedem neuen Lauf zusammen mit CACHE), laufen
// Dateien des Datenstands ohne Stempel über ctx.getJson: dann teilen Bericht, Quellen und Leistung denselben Download (z. B. pricing.json)
export function fetchJson(ctx, file, fresh = false, base = ctx.CFG.DATA) {
  const at = ctx.state?.latest?.at || '';
  const url = base + file + (fresh && at && !(ctx.sharedCache && base === ctx.CFG.DATA) ? `?t=${at}` : '');
  if (!CACHE.has(url)) CACHE.set(url, Promise.resolve(ctx.getJson(url, { timeout: 60000 })).then(r => (r?.ok ? r.json : null), () => null));
  return CACHE.get(url);
}
/** Zwischenspeicher leeren (z. B. nach neuem Sammler-Lauf); ältere Tagesdateien ändern sich nicht */
export function resetReportCaches() { CACHE.clear(); }
export const lastOf = (a) => (a || [])[(a || []).length - 1];
export async function usageIndex(ctx) {
  const idx = ctx.loadUsageIndex ? await ctx.loadUsageIndex() : await fetchJson(ctx, 'events/index.json', true);
  return idx && Array.isArray(idx.days) ? idx : { days: [], cellDays: [] };
}
export const eventsDoc = (ctx, idx, day) => (ctx.loadEvents ? ctx.loadEvents(day) : fetchJson(ctx, `events/${day}.json`, lastOf(idx.days) === day));
export async function histIndex(ctx) { return ctx.state?.histIndex || (await fetchJson(ctx, 'history/index.json', true)) || { days: [] }; }
export function histDoc(ctx, hidx, day) {
  if (!(hidx.days || []).includes(day)) return Promise.resolve(null);
  return ctx.loadHistory ? ctx.loadHistory(day) : fetchJson(ctx, `history/${day}.json`, lastOf(hidx.days) === day);
}
export function cellsDoc(ctx, idx, day, land) {
  if (!land || !(idx.cellDays || []).includes(day)) return Promise.resolve(null);
  return ctx.loadCells ? ctx.loadCells(day, land) : fetchJson(ctx, `cells/${day}/${land}.json`, lastOf(idx.cellDays) === day);
}
// Art der Zahl („Höchstzahl (Sondernutzungserlaubnis)“): englische Fassung aus reference.json → artEn je Eintrag (lib/pulse-report.js reicht nur art weiter)
const ART_EN = new Map();
export const reference = (ctx) => fetchJson(ctx, 'reference.json', false, ctx.CFG.MAIN).then((ref) => {
  for (const e of [...(ref?.obergrenzen || []), ...(ref?.flotte || [])]) if (typeof e?.art === 'string' && typeof e.artEn === 'string') { ART_EN.set(`${e.ags}|${e.art}`, e.artEn); if (!ART_EN.has(e.art)) ART_EN.set(e.art, e.artEn); }
  return ref;
});
// Englisch: artEn (sachlich übersetzt); Deutsch: wie in der Quelle, als Name/Zitat gekennzeichnet
export const artTxt = (esc, c) => { const en = lang() === 'en' ? ART_EN.get(`${c.ags}|${c.art}`) || ART_EN.get(c.art) : null; return en ? esc(en) : `<span translate="no">${esc(c.art)}</span>`; };
export const dailyDoc = (ctx) => fetchJson(ctx, 'history/daily.json', true);
// Tageswerte für Flotte/Sperrquote: history/daily.json (verdichtet), sonst history/<Tag>.json
export const histFor = (ctx, hidx, daily, day) => { const h = R.histFromDaily(daily, day); return h ? Promise.resolve(h) : histDoc(ctx, hidx, day); };
export async function allDocs(ctx, days) { const idx = await usageIndex(ctx); const list = days || idx.days || []; return { idx, docs: (await Promise.all(list.map(d => eventsDoc(ctx, idx, d)))).filter(Boolean) }; }

// ---------- Kalibrierung (lib/pulse-calib.js): einmal je Datenstand, geteilt mit app.js ----------
// Berliner Messung = Kommunal-Bericht Berlin, E-Scooter, über die letzten CALIB_DAYS Tagesdateien; Vergleichswerte (Deutschland, Voi,
// Frankfurt) aus der Städte-Rangliste derselben Tage. Ohne reference.json: Annahmen wie bisher, keine Kalibrierung.
const CALIB_CACHE = new Map();
const isClient = () => typeof document !== 'undefined' && document.body?.classList.contains('mode-client');
const natRvd = (rows) => { let rd = 0, fl = 0; for (const r of rows) if (r.rvd > 0 && r.ridesDay != null) { rd += r.ridesDay; fl += r.ridesDay / r.rvd; } return fl > 0 ? { rvd: rd / fl, ridesDay: rd, fleet: fl } : null; };
export function loadCalibration(ctx) {
  const key = `${ctx.state?.latest?.at || ''}|${lang()}`; // Texte der Kalibrierung je Sprache
  if (!CALIB_CACHE.has(key)) CALIB_CACHE.set(key, (async () => {
    const ref = await reference(ctx);
    // Audit OPS-04: vom Sammler vorgerechnet (calib.json, höchstens 2 Std. älter als der Datenstand) – sonst wie bisher im Browser
    const pre = await fetchJson(ctx, 'calib.json', true).catch(() => null), at = ctx.state?.latest?.at || 0;
    if (pre?.version === 1 && pre.langs?.[lang()] && (!at || Math.abs(at - pre.at) <= 2 * 3600e3)) return { ...pre.langs[lang()], kinds: pre.kinds || {}, ref, own: pre.own, days: pre.days || [], berlinReport: null, breaks: pre.breaks || null, precomputed: true };
    const idx = await usageIndex(ctx); const days = (idx.days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-CALIB_DAYS);
    const [hidx, daily] = await Promise.all([histIndex(ctx), dailyDoc(ctx)]);
    const [docs, hs] = await Promise.all([Promise.all(days.map(d => eventsDoc(ctx, idx, d))), Promise.all(days.map(d => histFor(ctx, hidx, daily, d)))]);
    const ok = docs.map((d, i) => [d, days[i], hs[i]]).filter(([d]) => d);
    const D = ok.map(x => x[0]), H = Object.fromEntries(ok.filter(x => x[2]).map(x => [x[1], x[2]]));
    const latest = ctx.state?.latest || null, breaks = daily?.breaks || null;
    const res = K.calibrationFromDocs({ ref, docs: D, hists: H, latest, breaks, langs: [lang()] }), c = res.langs[lang()], own = res.own, berlinReport = res.berlinReport;
    return { ...c, ref, own, days: ok.map(x => x[1]), berlinReport, breaks };
  })().catch(e => { console.error('Kalibrierung', e); return { assume: K.rideAssumptions(null, lang()), limits: {}, k: { applied: false, status: 'off', statusText: t('rep.calibrationCannotBeComputed'), reason: t('rep.calibrationCannotBeComputed') }, kinds: {}, coverage: [], checks: [], ref: null, own: {}, days: [], hasReference: false }; }));
  return CALIB_CACHE.get(key);
}
// Kurzbeschreibung des Faktors für Notizen und CSV, z. B. „Berlin Q4/2025 · vorläufig“

// ---------- Stil (einmal in den head; nur Variablen aus index.html) ----------
// Skala --rp-seq-0…8: Anteile 7/16/27/38/49/60/72/85/100 % Akzent in OKLab – dieselben Werte stehen in SEQ_P (Zellkarten auf Canvas)
const CSS = `
.rp-root{--rp-seq-0:color-mix(in oklab,var(--accent) 7%,var(--panel));--rp-seq-1:color-mix(in oklab,var(--accent) 16%,var(--panel));--rp-seq-2:color-mix(in oklab,var(--accent) 27%,var(--panel));--rp-seq-3:color-mix(in oklab,var(--accent) 38%,var(--panel));--rp-seq-4:color-mix(in oklab,var(--accent) 49%,var(--panel));--rp-seq-5:color-mix(in oklab,var(--accent) 60%,var(--panel));--rp-seq-6:color-mix(in oklab,var(--accent) 72%,var(--panel));--rp-seq-7:color-mix(in oklab,var(--accent) 85%,var(--panel));--rp-seq-8:var(--accent);
  --rp-na:repeating-linear-gradient(135deg,color-mix(in srgb,var(--muted) 34%,transparent) 0 1.5px,transparent 1.5px 6px)}
.rp-s0{--rp-f:var(--rp-seq-0)}.rp-s1{--rp-f:var(--rp-seq-1)}.rp-s2{--rp-f:var(--rp-seq-2)}.rp-s3{--rp-f:var(--rp-seq-3)}.rp-s4{--rp-f:var(--rp-seq-4)}.rp-s5{--rp-f:var(--rp-seq-5)}.rp-s6{--rp-f:var(--rp-seq-6)}.rp-s7{--rp-f:var(--rp-seq-7)}.rp-s8{--rp-f:var(--rp-seq-8)}
.rp-root.rp-busy>:not(.panel-head){opacity:.55;transition:opacity .2s}
.rp-ctl{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center}
.rp-ctl label{display:inline-flex;gap:var(--s2);align-items:center;font-size:.875rem;color:var(--fg-2)}
.rp-report{display:flex;flex-direction:column;gap:var(--s5);min-width:0}
.rp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--s3);flex-wrap:wrap;padding-bottom:var(--s3);border-bottom:1px solid var(--line)}
.rp-kicker{font-size:.75rem;font-weight:500;color:var(--muted)}
.rp-head h2{margin:2px 0 4px;font-size:1.25rem;line-height:1.2;letter-spacing:-.015em;font-weight:700}
.rp-head h2 small{font-size:.875rem;font-weight:400;color:var(--fg-2);letter-spacing:0;margin-left:var(--s2)}
.rp-head .sub{color:var(--fg-2);font-size:.75rem;margin:0;max-width:90ch}
.rp-sec{min-width:0}
.rp-sec>h3{margin:0 0 var(--s1);font-size:.875rem;font-weight:600;color:var(--fg)}
.rp-sec>.sub{color:var(--muted);font-size:.75rem;margin:0 0 var(--s2)}
.rp-qual{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:var(--s2) var(--s5);padding:var(--s3);border:1px solid var(--line-2);border-radius:var(--r-sm);background:var(--panel-2);font-size:.875rem;color:var(--fg-2)}
.rp-qual.prelim{box-shadow:inset 3px 0 0 var(--warn)}
.rp-qual dt{font-size:.75rem;font-weight:500;color:var(--muted)}
.rp-qual dd{margin:2px 0 0;color:var(--fg)}.rp-qual dd .muted{color:var(--muted)}
.rp-qual>div{min-width:0}
.rp-grid2{display:grid;gap:var(--s4);grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))}
.rp-report .tbl{max-height:none}
.rp-root td .sub-line{white-space:normal}.rp-root td .sub-line.nw{white-space:nowrap}
.rp-root tfoot td{font-weight:600;border-top:1px solid var(--line-2);border-bottom:0}
a.pick-cell{white-space:nowrap}
.rp-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:0;flex:none}
.rp-chart{position:relative;min-width:0}
.rp-scroll{overflow-x:auto;padding-bottom:2px}
.rp-week{display:grid;grid-template-columns:76px repeat(24,minmax(15px,1fr));gap:2px;min-width:520px}
.rp-week .rp-row{display:contents}
.rp-week .c{height:24px;border-radius:3px;background:var(--rp-f,var(--rp-seq-0));cursor:default;transition:box-shadow .1s}
.rp-week .c.na{background:var(--rp-na),var(--panel-2)}
.rp-week .c:hover,.rp-week .c.on{box-shadow:inset 0 0 0 1.5px var(--fg)}
.rp-week .c:focus-visible{outline:2px solid var(--fg);outline-offset:1px}
.rp-week .rl{font-size:.75rem;color:var(--fg-2);display:flex;align-items:center;justify-content:space-between;gap:4px;padding-right:6px;white-space:nowrap}
.rp-week .rl small{color:var(--muted);font-family:var(--sans);font-size:.75rem;font-variant-numeric:tabular-nums}
.rp-week .hl{font-family:var(--sans);font-size:.75rem;color:var(--muted);line-height:1;padding:0 0 4px;font-variant-numeric:tabular-nums}
.rp-week .rl,.rp-week .rp-row:first-child>.hl:first-child{position:sticky;left:0;z-index:1;background:var(--panel)}
.rp-weekwrap.rp-more-r{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 36px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 36px),transparent)}.rp-scrollhint{margin:var(--s1) 0 0;font-size:.75rem;color:var(--muted)}.rp-scrollhint[hidden]{display:none}
@media (max-width:520px){.rp-week{grid-template-columns:60px repeat(24,minmax(15px,1fr))}}
.rp-tilewrap{container-type:inline-size}
.rp-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
@container (min-width:600px){.rp-tiles{grid-template-columns:repeat(var(--rp-cols,4),minmax(0,1fr))}}
@container (max-width:599.98px){.rp-tiles>.tile:last-child:nth-child(odd){grid-column:1/-1}}
.rp-legend{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);align-items:center;font-size:.75rem;color:var(--fg-2);margin-top:var(--s2)}
.rp-ramp{display:inline-flex;align-items:center;gap:2px}.rp-ramp>span{width:14px;height:10px;border-radius:2px;background:var(--rp-f)}
.rp-ramp>em{font-style:normal;font-family:var(--sans);font-size:.75rem;color:var(--fg-2);margin:0 4px;font-variant-numeric:tabular-nums}
.rp-sw{display:inline-block;width:14px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:6px;background:var(--rp-f,var(--rp-seq-0))}.rp-sw.na{background:var(--rp-na),var(--panel-2)}
.rp-tip{position:absolute;z-index:30;pointer-events:none;width:max-content;max-width:280px;padding:6px 10px;border-radius:var(--r-sm);border:1px solid var(--line-2);background:var(--panel);box-shadow:var(--shadow);font-size:.75rem;line-height:1.4;color:var(--fg-2);transform:translate(-50%,calc(-100% - 8px))}
.rp-tip b{display:block;font-family:var(--sans);font-size:.875rem;font-weight:600;color:var(--fg);white-space:nowrap;font-variant-numeric:tabular-nums}
.rp-maps{display:grid;gap:var(--s4);grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))}
.rp-fig{margin:0;min-width:0}.rp-fig figcaption{font-size:.75rem;font-weight:600;color:var(--fg);margin-bottom:var(--s1)}
svg.rp-cellmap{display:block;width:100%;height:auto;max-height:340px;background:var(--panel-2);border-radius:var(--r-sm)}
svg.rp-cellmap rect{fill:var(--rp-f)}svg.rp-cellmap rect.on{stroke:var(--fg);stroke-width:.18}
div.rp-cellmap{height:clamp(16.25rem,46vw,23.75rem);border-radius:var(--r-sm);border:1px solid var(--line);overflow:hidden;z-index:0;background:var(--panel-2)}
div.rp-cellmap:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
div.rp-cellmap .leaflet-tile-pane{filter:grayscale(1) invert(1) brightness(.8) contrast(.88)}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]) div.rp-cellmap .leaflet-tile-pane{filter:grayscale(1) contrast(.92) brightness(1.04)}}
:root[data-theme="light"] div.rp-cellmap .leaflet-tile-pane{filter:grayscale(1) contrast(.92) brightness(1.04)}
img.rp-cellmap-img{display:block;width:100%;height:auto;border-radius:var(--r-sm)}
.rp-cellnote{margin:0 0 var(--s2)}
.rp-status{display:inline-flex;align-items:center;gap:6px;font-size:.75rem;font-weight:500;color:var(--fg);white-space:nowrap}
.rp-status i{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;font:700 .75rem/1 var(--sans);font-style:normal;color:var(--panel);background:var(--muted);flex:none}
.rp-status.ok i{background:var(--ok)}.rp-status.near i{background:var(--warn)}.rp-status.over i,.rp-status.below i{background:var(--bad)}
.rp-status.unchecked i,.rp-status.unknown i,.rp-status.none i,.rp-status.unlicensed i,.rp-status.info i,.rp-status.hint i{background:transparent;color:var(--fg-2);box-shadow:inset 0 0 0 1.5px var(--fg-2)}
details.rp-capinfo{margin-top:var(--s3);font-size:.75rem;color:var(--fg-2)}details.rp-capinfo summary{cursor:pointer;color:var(--fg);font-weight:500}details.rp-capinfo ul{margin:var(--s2) 0 0;padding-left:1.2em;display:grid;gap:4px}
.rp-meter{position:relative;height:8px;border-radius:4px;background:color-mix(in srgb,var(--rp-c,var(--accent)) 20%,var(--panel-2));min-width:80px}
.rp-meter>i{display:block;height:100%;border-radius:4px;background:var(--rp-c,var(--accent))}
.rp-meter>b{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;border-radius:1px;background:var(--fg)}
.rp-meter.ok{--rp-c:var(--ok)}.rp-meter.near{--rp-c:var(--warn)}.rp-meter.over{--rp-c:var(--bad)}
.rp-cap{display:flex;flex-direction:column;gap:var(--s3);padding:var(--s3) 0;border-top:1px solid var(--line)}
.rp-cap:first-of-type{border-top:0;padding-top:0}
.rp-cap-h{display:flex;justify-content:space-between;align-items:baseline;gap:var(--s3);flex-wrap:wrap}
.rp-cap-h h3{margin:0;font-size:.875rem}
.rp-cap-total{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--s1) var(--s3);align-items:center}
.rp-cap-total .big{font-family:var(--sans);font-size:1.25rem;font-weight:500;color:var(--fg);font-variant-numeric:normal;font-variant-numeric:tabular-nums}
.rp-print-root{display:none}
.rp-print-only{display:none}.rp-appendix{margin-top:var(--s5);padding-top:var(--s4);border-top:1px solid var(--line)}.rp-app-h{margin:0;font-size:1.25rem}
@page{size:A4;margin:14mm 12mm}
@media print{
  body.rp-printing>:not(.rp-print-root){display:none!important}
  body.rp-printing .rp-print-root{display:block!important}
  body.rp-printing{background:${PRINT.panel}}
  .rp-print-only{display:block!important}
  .rp-print-root .rp-appendix{break-before:page}
  .rp-noprint,.rp-tip{display:none!important}
  .rp-print-root .rp-report{gap:14px}
  .rp-print-root .rp-qual,.rp-print-root .rp-fig,.rp-print-root .tile,.rp-print-root .rp-legend,.rp-print-root tr{break-inside:avoid}
  .rp-print-root h3,.rp-print-root .sub{break-after:avoid}
  .rp-print-root .tbl{overflow:visible;max-height:none}
  .rp-print-root table{font-size:.75rem}.rp-print-root th{font-size:.75rem;padding:4px 6px}.rp-print-root td{padding:4px 6px}
  .rp-print-root .tiles{grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.rp-print-root .tile{padding:8px 10px}.rp-print-root .tile .v{font-size:1.25rem}
  .rp-print-root .rp-grid2{grid-template-columns:1fr}
  .rp-print-root .rp-head h2{font-size:1.25rem}
  .rp-print-root svg.rp-cellmap{max-height:250px}
  .rp-print-root img.rp-cellmap-img{max-height:260px;object-fit:contain}
  .rp-print-root a{color:inherit;text-decoration:none}
}`;
function injectStyle() {
  if (document.getElementById('rp-style')) return;
  const s = document.createElement('style'); s.id = 'rp-style'; s.textContent = CSS; document.head.appendChild(s);
}
export function prep(el, ctx) { injectStyle(); bindJump(); el.classList.add('rp-root'); const s = st(el); s.ctx = ctx; return s; }

// ---------- Bausteine ----------
export const head = (title, sub, right = '') => `<div class="panel-head"><div><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right}</div>`;
export const tile = (l, v, s) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
export const emptyBox = (b, tq) => `<div class="empty"><b>${b}</b>${tq}</div>`;
// Beschreibungen aus data/reference.json (Teilgebiete, Hinweise, Art der Zahl) stehen wie in der Quelle: als Name/Zitat gekennzeichnet
export const srcTxt = (esc, s) => `<span translate="no">${esc(s)}</span>`;
export const STATUS_DEF = () => ({ ok: ['✓', 'ok'], near: ['!', t('rep.nearStatus')], over: ['✕', t('rep.over')], below: ['✕', t('zv.below')], hintUpper: ['i', t('zv.hintUpper')], unchecked: ['?', t('rep.notCheckable')], unknown: ['–', t('rep.noLimit')], hint: ['i', t('rep.noteCalculatedFigure')], info: ['i', t('rep.informationOnly')], none: ['–', t('rep.noLimitAccordingToSource')], unlicensed: ['–', t('rep.notLicensedAccordingToSource')] });
export const badge = (s) => `<span class="rp-status ${s === 'hintUpper' ? 'hint' : s}"><i aria-hidden="true">${STATUS_DEF()[s][0]}</i>${STATUS_DEF()[s][1]}</span>`, badge0 = badge;
export const safeLink = (ctx, url, label) => (/^https?:\/\//i.test(String(url || '')) ? `<a href="${ctx.esc(url)}" target="_blank" rel="noopener">${ctx.esc(label)}</a>` : ctx.esc(label));
export const rampSpans = (from = 1, to = 8) => Array.from({ length: to - from + 1 }, (_, i) => `<span class="rp-s${from + i}"></span>`).join('');
export const pctTxt = (ctx, v, d = 1) => (v == null ? '—' : `${ctx.fmt(v * 100, d)} %`);
export const num = (ctx, v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : ctx.fmt(v, d));
const cnt = (ctx, v) => (R.suppressed(v) ? `&lt; ${R.MIN_COUNT}` : num(ctx, v)); // Fahrten-Zählung mit Datenschutz-Schwelle
const kmTxt = (ctx, v) => (v == null ? null : `${ctx.fmt(v, 2)} km`);
const minTxt = (ctx, v) => (v == null ? null : t('rep.min', { v0: ctx.fmt(v, 1) }));
export function bindOnce(el, kind, fn) { if (el.dataset.rpBound === kind) return; el.dataset.rpBound = kind; fn(); }

// Tooltip: ein Element je Diagramm, Inhalt über textContent; Wert zuerst, Beschriftung danach
export function tip(box) { let tq = box.querySelector(':scope > .rp-tip'); if (!tq) { tq = document.createElement('div'); tq.className = 'rp-tip'; tq.hidden = true; box.appendChild(tq); } return tq; }
export function showTip(box, target, value, label) {
  const tq = tip(box); tq.replaceChildren(); const b = document.createElement('b'); b.textContent = value; tq.append(b);
  for (const l of [].concat(label || [])) { const d = document.createElement('div'); d.textContent = l; tq.append(d); }
  tq.hidden = false;
  const r = target.getBoundingClientRect(), w = box.getBoundingClientRect();
  const x = Math.max(tq.offsetWidth / 2 + 4, Math.min(w.width - tq.offsetWidth / 2 - 4, r.left - w.left + r.width / 2));
  let y = r.top - w.top; if (y - tq.offsetHeight - 10 < 0) y = r.bottom - w.top + tq.offsetHeight + 16;
  tq.style.left = `${x}px`; tq.style.top = `${y}px`;
}
export const hideTip = (box) => { const tq = box.querySelector(':scope > .rp-tip'); if (tq) tq.hidden = true; };
// Link auf ein Panel einer anderen oder derselben Ansicht (<a href="#bericht" data-rp-jump="rp-caps">): Ansicht wechseln, warten bis das
// Panel gezeichnet ist, dann hinscrollen und seine Überschrift fokussieren (Screenreader hören, wo sie gelandet sind)
let jumpBound = false;
function bindJump() {
  if (jumpBound || typeof document === 'undefined') return; jumpBound = true;
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-rp-jump]'); if (!a || e.button || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    const id = a.dataset.rpJump, view = (a.getAttribute('href') || '').slice(1); let n = 0;
    if (view && location.hash !== `#${view}`) location.hash = `#${view}`;
    const go = () => {
      const p = document.getElementById(id), h = p?.querySelector('h2');
      if ((!h || !p.closest('section.view.active') || p.classList.contains('rp-busy')) && n++ < 80) { setTimeout(go, 100); return; }
      if (!p) return;
      const tgt = h || p; tgt.tabIndex = -1;
      p.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); tgt.focus({ preventScroll: true });
    };
    setTimeout(go, 150);
  });
}
export function download(name, text, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ======================================================================
// 1. Kommunal-Bericht
// ======================================================================
// Zeitraum: alle Tage, letzte 7/14, Quartal (nur wenn die Daten ganz darüber reichen), Monat, einzelner Tag
function periodOptions(days, archDays = []) {
  const opts = [['all', t('rep.allAvailableDays', { length: days.length })]];
  if (days.length > 7) opts.push(['last7', t('rep.last7Days')]);
  if (days.length > 14) opts.push(['last14', t('rep.last14Days')]);
  const known = [...new Set([...archDays, ...days])].sort();
  for (const q of R.completeQuarters(known).reverse()) opts.push([`q:${q}`, t('rep.quarter', { label: R.periodRange(`q:${q}`).label })]);
  for (const m of R.monthsOf(known, lang()).reverse()) opts.push([m.period, `${m.label}${m.complete ? '' : ` ${t('rep.withData', { v0: plural(m.days, t('rep.day'), t('rep.days')) })}`}`]);
  for (const d of [...days].reverse()) opts.push([`day:${d}`, `${WD()[R.weekdayOf(d)]}, ${dd(d)}`]);
  return opts;
}
function pickDays(days, period, archDays = []) {
  if (period === 'last7') return days.slice(-7);
  if (period === 'last14') return days.slice(-14);
  if (period?.startsWith('day:')) { const d = period.slice(4); return days.includes(d) ? [d] : days; }
  if (/^[mq]:/.test(period || '')) { const r = R.daysIn(period, [...new Set([...archDays, ...days])]); return r.length ? r : days; }
  return days;
}
const periodInfo = (period) => { const r = R.periodRange(period, lang()); if (r) return { kind: r.kind, label: r.label, key: r.key }; if (period?.startsWith('day:')) return { kind: t('rep.day'), label: dd(period.slice(4)) }; return { kind: t('rep.days'), label: period === 'last7' ? t('rep.last7Days2') : period === 'last14' ? t('rep.last14Days2') : t('rep.allDaysWithDailyFiles') }; };
// Langzeit-Archiv (archive/<Monat>.json, nie gekürzt): Tagesliste ohne alle Monate zu laden, wenn der Index firstDay kennt
const archIndex = (ctx) => fetchJson(ctx, 'archive/index.json', true);
export async function archiveDayList(ctx) {
  const ai = await archIndex(ctx); const months = (ai?.months || []).filter(m => /^\d{4}-\d{2}$/.test(m)).sort(); if (!months.length) return [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(ai.firstDay || '')) {
    const last = ctx.state?.latest?.at ? R.berlinDay(ctx.state.latest.at) : `${lastOf(months)}-28`; const out = [];
    for (let tq = Date.parse(`${ai.firstDay}T12:00:00Z`), end = Date.parse(`${last}T12:00:00Z`); tq <= end && out.length < 4000; tq += 86400e3) out.push(new Date(tq).toISOString().slice(0, 10));
    return out;
  }
  const docs = await Promise.all(months.map(m => fetchJson(ctx, `archive/${m}.json`, m === lastOf(months))));
  return docs.flatMap(d => Object.keys(d?.days || {})).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
}
export async function archiveFor(ctx, days) {
  const ai = await archIndex(ctx); const months = [...new Set(days.map(d => d.slice(0, 7)))].filter(m => (ai?.months || []).includes(m));
  const docs = await Promise.all(months.map(m => fetchJson(ctx, `archive/${m}.json`, m === lastOf((ai.months || []).slice().sort()))));
  const archive = {}; let fields = null; for (const d of docs) { if (!d?.days) continue; fields ??= d.fields; for (const [day, rows] of Object.entries(d.days)) if (days.includes(day)) archive[day] = rows; }
  return { archive, fields: fields || ai?.fields || R.ARCHIVE_FIELDS };
}
export function filterText(ctx) {
  const { state } = ctx;
  return [state.operator !== 'all' ? t('rep.operator', { operator: ctx.esc(state.operator) }) : t('rep.allOperators'), state.type !== 'all' ? ctx.esc(typeName(state.type)) : t('rep.allVehicleTypes')].join(', ');
}
// eigene E-Scooter-Werte zum Vergleich mit öffentlichen Referenzen (kalibriert: E-Scooter × k)
function scooterAgg(rep, cal = null) {
  const g = rep.groups.filter(x => x.ty === 'scooter'); if (!g.length) return null;
  const good = g.filter(x => x.plausible);
  const fleet = sum(g.map(x => x.fleet)), fleetG = sum(good.map(x => x.fleet)), rd = good.some(x => x.ridesDay != null) ? sum(good.map(x => x.ridesDay)) : null;
  const rdC = cal?.applied && rd != null ? sum(good.map(x => cal.groups.get(x.key)?.ridesDay || 0)) : null;
  const w = (f, n) => { const s = g.filter(x => x[f] != null); const N = sum(s.map(x => x[n])); return N ? sum(s.map(x => x[f] * x[n])) / N : null; };
  return { fleet, rvd: rd != null && fleetG ? rd / fleetG : null, rvdCal: rdC != null && fleetG ? rdC / fleetG : null, avgMin: w('avgMin', 'durN'), avgKm: w('avgKm', 'distN') };
}
// Fahrt-Referenz als Text: Spanne, Median, Mittel je km und Minuten
const fd = (ctx, x) => num(ctx, x, Math.abs(x * 10 - Math.round(x * 10)) > 1e-9 ? 2 : 1);
export function tripTxt(ctx, r) {
  const one = (unit, mean, med, lo, hi) => [lo != null && hi != null ? `${fd(ctx, lo)}–${fd(ctx, hi)} ${unit}` : null, med != null ? t('rep.median', { v0: fd(ctx, med), unit }) : null, mean != null ? `Ø ${fd(ctx, mean)} ${unit}` : null].filter(Boolean).join(', ');
  return [one('km', r.kmMittel, r.kmMedian, r.kmMin, r.kmMax), one(t('rep.min2'), r.minMittel, r.minMedian, r.minMin, r.minMax)].filter(Boolean).join(', ');
}
// Flotte laut Quelle: Berlin genehmigt (Abgeordnetenhaus), München aktiv (Stadtrat: keine Genehmigungspflicht)
export const fleetLabel = (r) => (r?.art === 'genehmigt' ? t('rep.licensedFleet') : r?.art === 'aktiv' ? t('rep.activeFleet') : t('rep.fleet'));
function referenceRows(ctx, ref, rep, cal = null) {
  if (!ref || !rep.ags) return '';
  const own = scooterAgg(rep, cal); const rows = []; const client = isClient();
  const src = (r) => safeLink(ctx, r.url, r.quelle || t('rep.source'));
  const ownRvd = (r) => { if (r.type !== 'scooter' || own?.rvd == null) return '—'; if (client) return num(ctx, own.rvdCal ?? own.rvd, 2); return `${num(ctx, own.rvd, 2)}${own.rvdCal != null ? `<div class="sub-line">${t('rep.calibrated', { ctx: num(ctx, own.rvdCal, 2) })}</div>` : ''}`; };
  // Stadtwerte über alle Arten (Düsseldorf, SMM-CPI): eigene Summen nur ohne Anbieter-/Artfilter vergleichbar; Hinweis „Jahresmittel, alle Arten, MDS“
  const allOk = ctx.state.operator === 'all' && ctx.state.type === 'all', tq = rep.totals, ct = cal?.applied ? cal.totals : null;
  const ownAll = (v, vc, d) => (!allOk || v == null ? '—' : client ? num(ctx, vc ?? v, d) : `${num(ctx, v, d)}${vc != null ? `<div class="sub-line">${t('rep.calibrated', { ctx: num(ctx, vc, d) })}</div>` : ''}`);
  // Räder mit Anbieter (KVB-Rad = nextbike in Köln): Messung genau dieser Gruppe, ungefiltert durch k
  const ownOp = (r) => { const g = rep.groups.find(x => x.ty === r.type && x.op === r.op); return g?.rvd != null ? `${num(ctx, g.rvd, 2)}<div class="sub-line"><span translate="no">${ctx.esc(r.op)}</span></div>` : '—'; };
  const tyName = (r) => (r.type === 'all' ? t('rep.allVehicleTypes') : typeName(r.type));
  for (const r of (ref.rvd || []).filter(x => x.ags === rep.ags)) {
    const hint = r.hinweis ? `<div class="sub-line"><span translate="no">${ctx.esc(r.hinweis)}</span></div>` : '';
    rows.push([t('rep.tripsPerVehiclePerDay', { typeName: ctx.esc(tyName(r)) }) + hint, num(ctx, r.wert, 2), ctx.esc(r.zeitraum || ''), src(r), r.type === 'all' ? ownAll(tq.rvd, ct?.rvd, 2) : r.op ? ownOp(r) : ownRvd(r)]);
    if (r.type === 'all' && r.flotteJe1000 != null) rows.push([`${t('rep.vehiclesPer1000Residents')}, ${ctx.esc(tyName(r))}`, num(ctx, r.flotteJe1000, 1), ctx.esc(r.zeitraum || ''), src(r), ownAll(tq.per1000Fleet, null, 1)]);
    if (r.type === 'all' && r.fahrtenJe1000 != null) rows.push([`${t('rep.tripsPer1000ResidentsAndDay')}, ${ctx.esc(tyName(r))}`, num(ctx, r.fahrtenJe1000, 1), ctx.esc(r.zeitraum || ''), src(r), ownAll(tq.per1000Rides, ct?.per1000Rides, 1)]);
  }
  for (const r of (ref.fahrt || []).filter(x => x.ags === rep.ags)) rows.push([t('rep.trip', { typeName: ctx.esc(typeName(r.type)) }), tripTxt(ctx, r), ctx.esc(r.zeitraum || ''), src(r), [kmTxt(ctx, own?.avgKm), minTxt(ctx, own?.avgMin)].filter(Boolean).join(', ') || t('rep.notMeasurable')]);
  for (const r of (ref.flotte || []).filter(x => x.ags === rep.ags)) rows.push([`${fleetLabel(r)}, ${ctx.esc(typeName(r.type))}`, num(ctx, r.wert), r.stand ? dd(r.stand) : '', src(r), own ? `${t('rep.inOpenFeeds', { ctx: num(ctx, own.fleet) })}<div class="sub-line">${pctTxt(ctx, own.fleet / r.wert, 1)} ${r.art === 'genehmigt' ? t('rep.ofLicensedFleetLowerBoundOf') : r.art === 'aktiv' ? t('rep.ofActiveFleet') : t('rep.ofFleetAccordingToSource')}</div>` : '—']);
  for (const r of (ref.fahrten || []).filter(x => x.ags === rep.ags)) rows.push([t('rep.tripsPerYear', { typeName: ctx.esc(typeName(r.type)) }), num(ctx, r.wert), ctx.esc(r.zeitraum || ''), src(r), '—']);
  if (!rows.length) return '';
  return `<section class="rp-sec"><h3>${t('rep.contextPublicReferenceValues')}</h3><div class="sub">${t('rep.valuesFromOfficialOr', { v0: client ? t('rep.ourValueDat') : t('rep.ofOwnMeasurement') })}</div>
    <div class="tbl"><table><thead><tr><th>${t('rep.metric')}</th><th class="n">${t('rep.reference')}</th><th>${t('rep.period')}</th><th>${t('rep.source')}</th><th class="n">${client ? t('rep.ourValue') : t('rep.ownMeasurement')}</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="n">${r[1]}</td><td>${r[2]}</td><td class="small">${r[3]}</td><td class="n">${r[4]}</td></tr>`).join('')}</tbody></table></div></section>`;
}
const meta_lim = (calib) => calib?.limits?.scooter ?? null;
// Kalibrierung in einem Satz (Kundenansicht ohne Methodikbegriffe)
// Zustand (Z3): gesperrt / vorläufig / angewandt mit Freigabedatum; Gruppen anderer Kennungsart (cal.skipped) bleiben gemessen
function calibText(ctx, calib, cal = null) {
  const k = calib?.k; const { fmt } = ctx;
  if (isClient()) return k?.applied ? t('rep.eScooterTripsCalibratedTo', { v0: safeLink(ctx, k.ref.url, k.ref.quelle || t('rep.source')) }) : t('rep.notCalibrated');
  if (!k?.applied) return t('rep.notCalibrated2', { v0: ctx.esc(k?.reason || t('rep.noReference')) });
  const m = k.measured;
  const skip = cal?.skipped?.length ? `, ${t('cal.skipped', { v0: ctx.esc([...new Set(cal.skipped.map(x => `${x.op} (${K.kindText(x.kind, lang())})`))].join(', ')) })}` : '';
  return `${ctx.esc(k.statusText || '')}, ${ctx.esc(k.onlyKind || '')}${skip}, ` + t('rep.eScooterTripsRangeOfficial', { k: fmt(k.k, 2), kLow: fmt(k.kLow, 2), kHigh: fmt(k.kHigh, 2), quarter: ctx.esc(k.quarter), wert: fmt(k.ref.wert, 2), rvd: fmt(m.rvd, 2), source: ctx.esc(k.source), v7: plural(m.days, t('rep.day'), t('rep.days')), v8: pctTxt(ctx, k.obsShare, 0), v9: dd(m.from), v10: dd(m.to), rule: ctx.esc(k.rule), v12: k.prelim ? `, ${t('rep.preliminary2')} <span class="muted">(${ctx.esc(k.prelimWhy.join(', '))})</span>` : '', v13: k.single ? `, <span class="muted">${t('rep.limitation', { single: ctx.esc(k.single) })}</span>` : '', v14: m.excluded?.length ? `, <span class="muted">${t('rep.excludedOvercount', { join: ctx.esc(m.excluded.map(x => x.op).join(', ')) })}</span>` : '', meta_lim: fmt(meta_lim(calib), 2), v16: safeLink(ctx, k.ref.url, k.ref.quelle || t('rep.source')) });
}
function qualityBlock(ctx, rep, extra) {
  const q = rep.quality, { fmt, esc } = ctx; const arch = q.source === 'archiv';
  const obsH = q.obsMin / 60, possH = q.possibleMin / 60;
  const gaps = q.gaps.slice(0, 4).map(g => `${dm(g.day)} ${g.from != null ? `${hhmm(g.from)}–` : `${t('rep.to')} `}${hhmm(g.at)}${g.ms ? ` (${fmt(g.ms / 3600e3, 1)} h)` : ''}`).join(', ');
  const items = [
    [t('rep.observation'), t('rep.hOfH', { obsH: fmt(obsH, 1), possH: fmt(possH), v2: pctTxt(ctx, possH ? obsH / possH : null, 0), v3: arch ? t('rep.dailyValuesFromLongTerm') : plural(q.runs, t('rep.collectorRun'), t('rep.collectorRuns')) })],
    [t('rep.fullMeasurementDays'), `${t('rep.of', { fullDays: q.fullDays, days: q.days })} <span class="muted">${t('rep.hoursWithMinOfObservation', { FULL_DAY_HOURS: R.FULL_DAY_HOURS, FULL_HOUR_MIN: R.FULL_HOUR_MIN, v2: arch ? t('rep.inArchive1000ObservedMinutes') : '' })}</span>${q.prelim ? `, ${t('rep.preliminary2')} <span class="muted">${t('rep.underFullDays', { MIN_FULL_DAYS: R.MIN_FULL_DAYS })}</span>` : ''}`],
    [t('rep.gaps'), arch ? t('rep.notStatedPerRunInArchive') : q.gapRuns ? `${t('rep.longestHNotCounted', { v0: plural(q.gapRuns, t('rep.gapRun'), t('rep.gapRuns')), v1: fmt(q.longestGapMs / 3600e3, 1), v2: plural(q.excludedHours, t('rep.hour'), t('rep.hours')) })}<div class="muted small">${gaps}${q.gaps.length > 4 ? ' …' : ''}</div>` : t('rep.noneIntervalBetweenRunsNever')],
    [t('rep.extrapolationToDay'), arch ? t('rep.tripsObservedShareOfDay', { profileSource: esc(tx(q.profileSource)) }) : t('rep.dailyProfileTripsObserved', { profileSource: esc(tx(q.profileSource)) })],
    [t('rep.fleet'), arch ? t('rep.avgVehiclesPerDayAccordingTo') : q.fleetFromHistory.length ? t('rep.vehicleMinutesObserved', { v0: q.fleetFromHistory.map(d => dm(d)).join(', ') }) : t('rep.vehicleMinutesObserved2')],
    [t('rep.durationAndDistance'), arch ? t('rep.notContainedInArchive') : t('rep.onlyWithStableVehicleIdsAnd', { MIN_TRIPS_MEASURED: R.MIN_TRIPS_MEASURED, v1: q.taintedDays.length ? t('rep.leftOutGapCounted', { v0: q.taintedDays.map(d => dm(d)).join(', ') }) : '' })],
    ...(q.incompleteGroups?.length ? [[t('rep.incompleteGroups'), t('rep.incompleteGroupsTxt', { v0: esc(q.incompleteGroups.map(k => k.replace('|', ' ')).join(', ')) })]] : []),
    ...(q.mixedRuleDays?.length ? [[t('rep.ruleVersions'), t('rep.mixedRuleDays', { v0: q.mixedRuleDays.map(d => dm(d.day)).join(', ') })]] : []),
    // Bruchmarken (Z2): je Tag die betroffenen Reihen; Tage davor zählen für sie nicht, am Bruchtag nur Stunden mit dem neuen Regelstand
    ...(q.breaks?.length ? [[t('cal.breaksTitle'), [...new Set(q.breaks.map(b => b.day))].sort().map(d => t(arch ? 'cal.breakTxtArch' : 'cal.breakTxt', { day: dd(d), v1: esc(q.breaks.filter(b => b.day === d).map(b => `${b.key.split('|')[0]} ${typeName(b.key.split('|')[1])}`).join(', ')) })).join(', ')]] : []),
    ...extra,
  ];
  return `<dl class="rp-qual${q.prelim ? ' prelim' : ''}">${items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}
// Wert mit Spanne darunter (kalibriert)
const withSpan = (ctx, v, lo, hi, d = 0, bold = false) => `${bold ? '<b>' : ''}${num(ctx, v, d)}${bold ? '</b>' : ''}${lo != null && hi != null && Math.abs(hi - lo) > 1e-9 ? `<div class="sub-line nw">${num(ctx, lo, d)}–${num(ctx, hi, d)}</div>` : ''}`;
function groupTable(ctx, rep, cal = null) {
  const { esc, opColor } = ctx; const tq = rep.totals; const client = isClient(); const C = cal?.applied ? cal : null;
  const notMeasurable = `<span class="muted" title="${t('rep.idsChangeWithEveryTripOr')}">${t('rep.notMeasurable')}</span>`;
  const cOf = (g) => { const c = C?.groups.get(g.key); return c?.calibrated ? c : null; };
  // Kundenansicht: E-Scooter nur kalibriert (mit Spanne); intern: gemessen + Spalte „kalibriert“
  // A8: gemessene Werte mit 90-%-Band über die Messtage (Bootstrap), kalibrierte mit der Spanne von k
  const rdCell = (g) => { const c = client && cOf(g); return c ? withSpan(ctx, c.ridesDay, c.lo, c.hi) : withSpan(ctx, g.ridesDay, g.ridesDayBand?.[0], g.ridesDayBand?.[1]); };
  const rvdCell = (g) => { const c = client && cOf(g); return c ? withSpan(ctx, c.rvd, c.rvdLo, c.rvdHi, 2, true) : withSpan(ctx, g.rvd, g.rvdBand?.[0], g.rvdBand?.[1], 2, true); };
  const calCol = C && !client;
  const calCell = (g) => { const c = cOf(g); const sk = C?.groups.get(g.key)?.skipKind; if (sk) return `<span class="muted">${t('cal.notKind', { v0: esc(K.kindText(sk, lang())) })}</span>`; return c && c.rvd != null ? withSpan(ctx, c.rvd, c.rvdLo, c.rvdHi, 2, true) + (c.capped ? `<div class="sub-line">${t('rep.cappedAtLimit')}</div>` : '') : `<span class="muted" title="${t('rep.onlyEScootersAreCalibrated')}">—</span>`; };
  const rows = rep.groups.map(g => `<tr${g.plausible ? '' : ' class="muted"'}><td><span class="op"><i style="background:${opColor(g.op)}"></i>${esc(g.op)}</span><div class="sub-line">${esc(typeName(g.ty))}${g.fleetSource === 'aktuell' ? `, ${t('rep.currentFleetOnly')}` : ''}</div>${g.flags.length ? `<div class="sub-line">${esc(mbFlagText(g.flags))}</div>` : ''}</td>
    <td class="n fleet">${num(ctx, g.fleet)}${g.fleetDays.length > 1 ? `<div class="sub-line nw">${num(ctx, g.fleetMin)}–${num(ctx, g.fleetMax)}</div>` : ''}</td>${client ? '' : `<td class="n">${num(ctx, g.rides)}</td>`}<td class="n">${rdCell(g)}</td><td class="n">${rvdCell(g)}</td>${calCol ? `<td class="n">${calCell(g)}</td>` : ''}
    <td class="n">${g.avgMin != null ? t('rep.atMost', { v0: minTxt(ctx, g.avgMin) }) : notMeasurable}</td><td class="n">${kmTxt(ctx, g.avgKm) || notMeasurable}</td><td class="n">${pctTxt(ctx, g.disabledShare)}${g.disabledSource === 'aktuell' ? `<div class="sub-line">${t('rep.current')}</div>` : ''}</td><td class="n">${num(ctx, g.per1000Fleet, 2)}</td></tr>`).join('');
  const ct = C?.totals; const cols = 9 + (calCol ? 1 : 0) - (client ? 1 : 0);
  const footRd = client && ct ? withSpan(ctx, ct.ridesDay, ct.lo, ct.hi) : num(ctx, tq.ridesDay), footRvd = client && ct ? withSpan(ctx, ct.rvd, ct.rvdLo, ct.rvdHi, 2) : num(ctx, tq.rvd, 2);
  return `<div class="tbl"><table><thead><tr><th>${t('rep.operatorType')}</th><th class="n">${t('rep.avgFleet')}</th>${client ? '' : `<th class="n">${t('rep.tripsMeasured')}</th>`}<th class="n">${t('rep.tripsDay', { v0: client && C ? ` <span class="muted">${t('rep.eScootersCalibrated')}</span>` : '' })}</th><th class="n">${t('rep.perVehAndDay')}</th>${calCol ? `<th class="n" title="${t('rep.eScootersCalibrationFactor')}">${t('rep.calibratedPerVehAndDay')}</th>` : ''}<th class="n" title="${t('rep.avgDurationUpperTitle')}">${t('rep.avgDurationUpper')}</th><th class="n">${t('rep.avgDistance')}</th><th class="n">${t('rep.disabledRate')}</th><th class="n">${t('rep.vehPer1000Residents')}</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="${cols}" class="empty">${t('rep.noVehiclesInFilterSet')}</td></tr>`}</tbody>
    ${rep.groups.length > 1 ? `<tfoot><tr><td>${t('rep.total', { v0: tq.excluded.length ? `<div class="sub-line">${t('rep.tripsWithoutImplausible', { join: esc(tq.excluded.map(k => k.replace('|', ' ')).join(', ')) })}</div>` : '' })}</td><td class="n">${num(ctx, tq.fleet)}</td>${client ? '' : `<td class="n">${num(ctx, tq.rides)}</td>`}<td class="n">${footRd}</td><td class="n">${footRvd}</td>${calCol ? `<td class="n">${ct ? withSpan(ctx, ct.rvd, ct.rvdLo, ct.rvdHi, 2) : '—'}</td>` : ''}<td></td><td></td><td class="n">${pctTxt(ctx, tq.disabledShare)}</td><td class="n">${num(ctx, tq.per1000Fleet, 2)}</td></tr></tfoot>` : ''}</table></div>`;
}
function dailyTable(ctx, rep, k = null, limits = null, cal = null) {
  const { esc } = ctx; const client = isClient();
  // kalibriert je Tag: E-Scooter-Fahrten × k (höchstens bis zur Plausibilitätsgrenze je Gruppe), andere Arten gemessen, ÷ beobachteter Anteil
  const kOk = (key) => !cal || !!cal.groups.get(key)?.calibrated; // Kennungsart wie die Referenz (calibrateReport), sonst gemessen
  const calDay = (d) => { if (!k?.applied || !(d.coverage > 0)) return null; let r = 0, any = false; for (const [key, v] of Object.entries(d.byGroup)) { const sc = key.split('|')[1] === 'scooter' && kOk(key); if (sc && v.rides) any = true; const f = sc ? K.cappedFactor(k.k, v.fleet > 0 ? (v.rides || 0) / d.coverage / v.fleet : null, limits?.scooter ?? null).f : 1; r += (v.rides || 0) * f; } return any ? r / d.coverage : null; };
  const rows = rep.daily.map(d => {
    const byOp = new Map(); for (const [key, v] of Object.entries(d.byGroup)) { const op = key.split('|')[0]; byOp.set(op, (byOp.get(op) || 0) + (v.fleet || 0)); }
    const ops = [...byOp].filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]).map(([o, v]) => `${esc(o)} ${num(ctx, v)}`).join(', '); // Anbieter mit gerundet 0 Fahrzeugen nicht als „Zeus 0“
    const c = calDay(d);
    const rd = client && c != null ? `${num(ctx, c)}<div class="sub-line">${t('rep.eScootersCalibrated2')}</div>` : `${num(ctx, d.ridesDay)}<div class="sub-line">${t('rep.observed', { v0: pctTxt(ctx, d.coverage, 0), v1: c != null ? `, ${t('rep.calibrated', { ctx: num(ctx, c) })}` : '' })}</div>`;
    return `<tr><td>${WD()[d.weekday]}, ${dd(d.day)}${d.full ? '' : `<div class="sub-line">${t('rep.noFullMeasurementDay')}</div>`}</td><td class="n">${num(ctx, d.obsHours, 1)} h</td><td class="n">${d.runs ?? '–'}</td><td class="n">${d.gapRuns || '–'}</td><td class="n">${num(ctx, d.fleet)}${ops ? `<div class="sub-line">${ops}</div>` : ''}</td>${client ? '' : `<td class="n">${num(ctx, d.rides)}</td>`}<td class="n">${rd}</td></tr>`;
  }).join('');
  return `<div class="tbl"><table><thead><tr><th>${t('rep.day')}</th><th class="n">${t('rep.observed2')}</th><th class="n">${t('rep.runs')}</th><th class="n">${t('rep.gapRuns')}</th><th class="n">${t('rep.avgFleetPerOperator')}</th>${client ? '' : `<th class="n">${t('rep.tripsMeasured')}</th>`}<th class="n">${t('rep.tripsDayExtrapolated')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
const cellLink = (c) => `<a href="#live" class="pick-cell" data-lat="${c.lat.toFixed(5)}" data-lon="${c.lon.toFixed(5)}">${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}</a>`;
// Zellkarte: mit Leaflet eine echte Karte (OSM-Kacheln, Zellen als halbtransparente Rechtecke, mountCellMaps); ohne Leaflet das Raster als SVG
function cellMap(ctx, cs, key, title) {
  if (!cs.grid.length) return '';
  if (!hasLeaflet()) return cellSvg(ctx, cs, key, title);
  return `<figure class="rp-fig"><figcaption id="rp-cm-${key}">${title}</figcaption><div class="rp-chart"><div class="rp-cellmap" data-key="${key}" role="region" aria-labelledby="rp-cm-${key}" aria-describedby="rp-cm-desc"></div></div></figure>`;
}
function cellSvg(ctx, cs, key, title) {
  return cs.grid.length ? `<figure class="rp-fig"><figcaption>${title}</figcaption><div class="rp-chart">${cellSvgMarkup(cs, key, title)}</div></figure>` : '';
}
export function cellSvgMarkup(cs, key, title) {
  const grid = cs.grid; if (!grid.length) return '';
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity, lat = 0;
  for (const c of grid) { if (c.i < i0) i0 = c.i; if (c.i > i1) i1 = c.i; if (c.j < j0) j0 = c.j; if (c.j > j1) j1 = c.j; lat += c.lat; }
  lat /= grid.length;
  const ky = R.CELL_LAT / (R.CELL_LON * Math.cos((lat * Math.PI) / 180)); // Zellen etwa quadratisch zeichnen
  const W = j1 - j0 + 1, H = (i1 - i0 + 1) * ky, g = 0.14;
  const rects = grid.map((c, n) => `<rect class="rp-s${R.suppressed(c[key]) ? 0 : R.heatClass(c[key], cs.max)}" x="${(c.j - j0 + g / 2).toFixed(2)}" y="${((i1 - c.i) * ky + g / 2).toFixed(2)}" width="${(1 - g).toFixed(2)}" height="${(ky - g).toFixed(2)}" data-i="${n}"/>`).join('');
  return `<svg class="rp-cellmap" viewBox="0 0 ${W} ${H.toFixed(2)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${t('rep.gridWithCellsValuesInTable', { title, length: grid.length })}" data-key="${key}">${rects}</svg>`;
}
function cellsSection(ctx, rep, s) {
  const cs = rep.cells; const { fmt } = ctx;
  if (!cs.n) return `<section class="rp-sec"><h3>${t('rep.places')}</h3>${emptyBox(t('rep.noCellsForPeriod'), t('rep.cellFilesAreMissingForThese'))}</section>`;
  const filt = ctx.state.operator !== 'all' || ctx.state.type !== 'all';
  const strong = cs.strong.map((c, i) => `<tr><td class="n">${i + 1}</td><td>${cellLink(c)}</td><td class="n">${cnt(ctx, c.start)}</td><td class="n">${cnt(ctx, c.end)}</td><td class="n">${num(ctx, c.presAvg, 1)}</td></tr>`).join('');
  const weak = cs.weak.map((c, i) => `<tr><td class="n">${i + 1}</td><td>${cellLink(c)}</td><td class="n">${num(ctx, c.presAvg, 1)}</td><td class="n">${cnt(ctx, c.start)}</td><td class="n">${R.suppressed(c.start) ? '—' : num(ctx, c.perVehicle, 2)}</td></tr>`).join('');
  const k5 = R.heatClassFloor(5, cs.max);
  const top = [...cs.grid].sort((a, b) => (b.start + b.end) - (a.start + a.end)).slice(0, 30);
  const live = hasLeaflet();
  return `<section class="rp-sec"><h3>${t('rep.placesStartAndDestination')}</h3><div class="sub">${t('rep.cells280250MCellsWithFleetOr', { v0: plural(cs.days, t('rep.day'), t('rep.days')), n: fmt(cs.n), MIN_COUNT: R.MIN_COUNT })}</div>
    ${filt ? `<div class="note small rp-cellnote" role="note">${t('rep.filterDoesNotApplyHereCells', { ctx: filterText(ctx) })}</div>` : ''}
    ${live ? `<p class="vh" id="rp-cm-desc">${t('rep.mapWithCellsOnOpenstreetmap', { n: fmt(cs.n) })}</p>` : ''}
    <div class="rp-maps" data-rp="cellmaps">${cellMap(ctx, cs, 'start', t('rep.tripStarts'))}${cellMap(ctx, cs, 'end', t('rep.tripEnds'))}</div>
    <div class="rp-legend"><span>${t('rep.tripsPerCell')}</span><span class="rp-ramp"><em>${R.MIN_COUNT}</em>${rampSpans()}<em>${num(ctx, cs.max)}</em></span><span class="muted">${t('rep.compressedMiddleOfScale', { ctx: num(ctx, k5) })}</span><span><i class="rp-sw rp-s0"></i>${t('rep.fleetFewerThanTrips', { MIN_COUNT: R.MIN_COUNT })}</span>${live ? `<span class="muted">${t('rep.mapsLinkedTapOrHoverCellFor')}</span>` : ''}
      <button type="button" class="rp-noprint" data-rp="cellscsv" title="${t('rep.allCellsCountsBelowAs', { MIN_COUNT: R.MIN_COUNT })}">${t('rep.placesCsv')}</button><button type="button" class="rp-noprint" data-rp="toggle" data-k="cells" aria-expanded="${s.show.cells ? 'true' : 'false'}">${s.show.cells ? t('rep.hideTable') : t('rep.asTable')}</button></div>
    <div class="tbl" data-rp-view="cells"${s.show.cells ? '' : ' hidden'} style="margin-top:var(--s2)"><table><thead><tr><th>${t('rep.cellCentre')}</th><th class="n">${t('rep.tripStarts')}</th><th class="n">${t('rep.tripEnds')}</th><th class="n">${t('rep.avgAvailablePerRun')}</th><th class="n">${t('rep.rebalancing')}</th></tr></thead><tbody>${top.map(c => `<tr><td>${cellLink(c)}</td><td class="n">${cnt(ctx, c.start)}</td><td class="n">${cnt(ctx, c.end)}</td><td class="n">${num(ctx, c.presAvg, 1)}</td><td class="n">${cnt(ctx, c.reloc)}</td></tr>`).join('')}</tbody></table></div>
    <div class="rp-grid2" style="margin-top:var(--s4)">
      <div><h3 style="font-size:.875rem;margin:0 0 var(--s1)">${t('rep.strongestPlaces')}</h3><div class="sub small muted" style="margin-bottom:var(--s1)">${t('rep.mostTripStarts')}</div><div class="tbl"><table><thead><tr><th class="n">#</th><th>${t('rep.cell')}</th><th class="n">${t('rep.starts')}</th><th class="n">${t('rep.destinations')}</th><th class="n">${t('rep.avgAvailable')}</th></tr></thead><tbody>${strong}</tbody></table></div></div>
      <div><h3 style="font-size:.875rem;margin:0 0 var(--s1)">${t('rep.weakestPlaces')}</h3><div class="sub small muted" style="margin-bottom:var(--s1)">${t('rep.fleetAvailableVehiclesPerRun', { WEAK_MIN_PRESENT: R.WEAK_MIN_PRESENT })}</div><div class="tbl"><table><thead><tr><th class="n">#</th><th>${t('rep.cell')}</th><th class="n">${t('rep.avgAvailable')}</th><th class="n">${t('rep.starts')}</th><th class="n">${t('rep.perVehicle')}</th></tr></thead><tbody>${weak || `<tr><td colspan="5" class="empty">${t('rep.noCellWithEnoughFleet')}</td></tr>`}</tbody></table></div></div>
    </div></section>`;
}
// S4.1: Antwort vorn im Bericht – Bestand (= Summe der Tabelle je Anbieter und Art), Fahrten je Tag, Fahrten je Fahrzeug und Tag
function reportAnswer(ctx, rep, meta, C) {
  const { esc } = ctx, tq = rep.totals, client = isClient();
  const rd = C?.ridesDay ?? tq.ridesDay, rvd = C?.rvd ?? tq.rvd;
  return ({ id: 'bericht',
    sentence: t('ans.report', { name: `<b>${esc(meta.name)}</b>`, fleet: `<strong>${num(ctx, tq.fleet)}</strong>`, rides: rd == null ? '–' : num(ctx, rd), days: plural(rep.days.length, t('rep.day'), t('rep.days')) }),
    kpis: [
      { label: t('rep.avgFleet'), value: num(ctx, tq.fleet), n: tq.fleet == null ? null : Math.round(tq.fleet), cmp: rep.pop ? t('ans.kPer1000', { v: num(ctx, tq.per1000Fleet, 1) }) : t('rep.populationMissing'), eq: '.rp-report table td.fleet', eqSum: true },
      { label: t('ans.kRidesDay'), value: num(ctx, rd), cmp: C && C.lo != null ? t('ans.kRange', { lo: num(ctx, C.lo), hi: num(ctx, C.hi) }) : client ? '' : t('ans.kMeasuredRides', { n: num(ctx, tq.rides) }) },
      { label: t('rep.tripsPerVehiclePerDay2'), value: num(ctx, rvd, 2), cmp: C && C.rvdLo != null ? t('ans.kRange', { lo: num(ctx, C.rvdLo, 2), hi: num(ctx, C.rvdHi, 2) }) : t('ans.kOverDays', { days: plural(rep.days.length, t('rep.day'), t('rep.days')) }) },
    ],
    how: t('ans.reportHow'), asOf: stamp(ctx.state.latest?.at) });
}
function reportHtml(ctx, rep, meta, ref) {
  const { esc, fmt } = ctx; const tq = rep.totals, q = rep.quality; const client = isClient();
  const k = meta.calib?.k, C = meta.cal?.applied ? meta.cal.totals : null;
  const pre = q.prelim ? `, ${t('rep.preliminary')}` : '';
  const sources = (ctx.state.latest?.sources || []).filter(r => (r.municipalities || []).includes(rep.ags) && !['duplicate', 'retired'].includes(r.status));
  // S4.2: ein Nenner mit Kopfzeile, Übersicht und Quellen (dataHealth über ctx.health)
  const hh = ctx.health?.(rep.ags);
  const srcTxt = hh?.counted ? t('rep.currentDelayedOther', { length: hh.fresh, length2: hh.delayed, length3: hh.counted - hh.fresh - hh.delayed }) : t('rep.none');
  const gaps = (ctx.state.latest?.gaps || []).filter(g => g.city === meta.name);
  const extra = [[t('rep.sourcesInMunicipality'), t('rep.asOf', { srcTxt, v1: stamp(ctx.state.latest?.at) })]];
  if (gaps.length) extra.push([t('rep.operatorsWithoutOpenFeed'), gaps.map(g => `${esc(g.operator)}${g.since ? ` ${t('rep.since', { v0: dd(g.since) })}` : ''}`).join(', ') + ` <span class="muted">${t('rep.missingFromAllFigures')}</span>`]);
  if (meta.missing.length) extra.push([q.source === 'archiv' ? t('rep.daysWithoutArchiveValues') : t('rep.dailyFilesMissing'), meta.missing.length > 8 ? `${plural(meta.missing.length, t('rep.day'), t('rep.days'))} (${meta.missing.slice(0, 4).map(dd).join(', ')} …)` : meta.missing.map(dd).join(', ')]);
  if (q.source === 'archiv') extra.push([t('rep.period'), t('rep.extendsBeyond30DaysOfDaily', { kind: esc(PKIND(meta.period.kind)), label: esc(meta.period.label) })]);
  if (meta.calib && rep.groups.some(g => g.ty === 'scooter')) extra.push([t('rep.calibration'), calibText(ctx, meta.calib, meta.cal)]);
  // Kennzahlen mit Fahrten: kalibriert (E-Scooter × k) mit Spanne, gemessen daneben; Kundenansicht nur kalibriert
  const calTile0 = (label, v, lo, hi, d, measured, sub) => (C && v != null
    ? tile(label, num(ctx, v, d), t('rep.range', { v0: client ? '' : `${t('rep.measured', { ctx: num(ctx, measured, d) })}, `, ctx: num(ctx, lo, d), ctx2: num(ctx, hi, d), v3: client ? t('rep.calibratedToOfficialBerlin') : t('rep.eScootersCalibrated3', { calibLabel: esc(calibLabel(k)) }), v4: client ? '' : pre }))
    : tile(label, num(ctx, measured, d), sub));
  // Reifegrad an den Fahrten-Kennzahlen (Messbasis der Tage des Berichts, Tagtyp der meisten Tage, Regelstand wie quality.rule)
  const mbLand = ctx.state.latest?.municipalities?.[rep.ags]?.state || null, mbB = mbBase(ctx.state, { land: mbLand, days: rep.days, rule: typeof q.rule === 'string' ? q.rule : undefined });
  const mbRep = mbBadge(mbB, 'full3', { dayType: mbMainType(rep.days, mbLand, ctx.state.calendar), curve: q.profileSource ? t('mb.curve', { v: esc(tx(q.profileSource)) }) : null });
  const calTile = (...a) => mbInTile(calTile0(...a), mbRep);
  const tiles = [
    tile(t('rep.avgFleet'), num(ctx, tq.fleet), t('rep.vehiclesInFeedInclDisabled', { v0: plural(rep.groups.length, t('rep.opTypeOne'), t('rep.opTypeMany')) })),
    client ? '' : tile(t('rep.tripsMeasured'), num(ctx, tq.rides), t('rep.inHOfObservation', { v0: fmt(q.obsMin / 60, 1), v1: q.source === 'archiv' ? '' : ` ${t('rep.withoutGapHours')}` })),
    // Basis im Titel: Mittel über die Tage des Zeitraums (Nutzung › Umsatz nennt dort den einzelnen Tag)
    calTile(t('rep.tripsPerDay', { days: plural(rep.days.length, t('rep.day'), t('rep.days')) }), C?.ridesDay, C?.lo, C?.hi, 0, tq.ridesDay, t('rep.extrapolatedVia', { v0: q.source === 'archiv' ? t('rep.observedShareOfDay') : t('rep.dailyProfile'), pre })),
    calTile(t('rep.tripsPerVehiclePerDay2'), C?.rvd, C?.rvdLo, C?.rvdHi, 2, tq.rvd, t('rep.tripsDayAvgFleet', { pre })),
    q.source === 'archiv' ? '' : tile(t('rep.disabledRate'), pctTxt(ctx, tq.disabledShare), t('rep.disabledVehiclesInFleetMean')),
    tile(t('rep.vehiclesPer1000Residents'), num(ctx, tq.per1000Fleet, 1), rep.pop ? t('rep.residents', { pop: fmt(rep.pop) }) : t('rep.populationMissing')),
    tq.hhi != null && tq.opCount > 1 ? tile(t('rep.marketConcentration'), `${fmt(tq.hhi)} HHI`, t('rep.topOperatorShare', { op: ctx.esc(tq.topOp), pct: fmt(tq.topShare * 100, 0) })) : '',
    calTile(t('rep.tripsPer1000ResidentsAndDay'), C?.per1000Rides, C?.per1000Lo, C?.per1000Hi, 1, tq.per1000Rides, rep.pop ? t('rep.extrapolatedPre', { pre }) : t('rep.populationMissing')),
  ].filter(Boolean);
  // Spalten nach Anzahl (UI-17): 7 Kacheln → 4 + 3, 6 → 3 + 3, 5 → 3 + 2; keine Kachel allein in der letzten Zeile
  const tileCols = tiles.length >= 5 ? Math.ceil(tiles.length / 2) : tiles.length;
  const per = meta.period && ['Quartal', 'Monat'].includes(meta.period.kind) ? `${esc(PKIND(meta.period.kind))} ${esc(meta.period.label)}, ` : '';
  const calMethod = client ? (C ? ` ${t('rep.eScooterTripsAreCalibratedTo')}` : '')
    : (C ? ` ${t('rep.calibrationMeasuredEScooter')}` : '');
  return `<article class="rp-report" aria-label="${t('rep.municipalReport', { name: esc(meta.name) })}">
    <header class="rp-head"><div><div class="rp-kicker">${t('rep.municipalReportShared')}</div><h2>${t('rep.ags', { name: esc(meta.name), ags: esc(rep.ags), v2: rep.pop ? `, ${t('rep.residents', { pop: fmt(rep.pop) })}` : '' })}</h2>
      <p class="sub">${t('rep.periodDataAsOfCreated', { per, v1: dd(rep.from), v2: rep.to !== rep.from ? `–${dd(rep.to)}` : '', v3: plural(rep.days.length, t('rep.day'), t('rep.days')), ctx: filterText(ctx), v5: stamp(ctx.state.latest?.at), v6: stamp(Date.now()) })}</p></div>
      ${q.prelim ? `<span class="pill prelim" title="${t('rep.onlyFullMeasurementDaysFrom', { fullDays: q.fullDays, MIN_FULL_DAYS: R.MIN_FULL_DAYS })}">${t('rep.preliminary')}</span>` : `<span class="pill plain">${t('rep.reliable')}</span>`}</header>
    <div class="rp-print-only">${answerHtml(meta.answer = reportAnswer(ctx, rep, meta, C))}</div>
    <section class="rp-sec"><h3>${t('rep.metrics')}</h3><div class="sub">${t('rep.structuredAfterListOfMetrics', { v0: C ? (client ? t('rep.eScooterTripsCalibratedTo2') : t('rep.tripMetricsCalibrated')) : '' })}</div><div class="rp-tilewrap"><div class="tiles rp-tiles" style="--rp-cols:${tileCols}">${tiles.join('')}</div></div></section>
    <section class="rp-sec"><h3>${t('rep.perOperatorAndVehicleType')}</h3><div class="sub">${t('rep.meanOverPeriodFleetWithRange')}</div>${groupTable(ctx, rep, meta.cal)}</section>
    <div class="rp-appendix"><h2 class="rp-app-h">${t('rep.appendix')}</h2><p class="sub">${t('rep.appendixSub')}</p>
    <section class="rp-sec"><h3>${t('rep.dataQuality')}</h3>${qualityBlock(ctx, rep, extra)}</section>
    <section class="rp-sec"><h3>${t('rep.dailyValues')}</h3><div class="sub">${t('rep.fleetPerDayObservationAnd')}</div>${dailyTable(ctx, rep, k, meta.calib?.limits, meta.cal)}</section>
    ${q.source === 'archiv' ? '' : cellsSection(ctx, rep, meta.s)}
    ${referenceRows(ctx, ref, rep, meta.cal)}
    <footer class="rp-sec small muted"><h3>${t('rep.method')}</h3><p style="margin:0 0 var(--s1)">${t('rep.basisIsOperatorsOpenLive')}</p><p style="margin:0">${t('rep.tripsPerDayAreMeasuredTrips', { calMethod, v1: esc(ctx.CFG.REPO || '') })}</p></footer></div>
  </article>`;
}
function reportControls(ctx, s, days, archDays = []) {
  const opts = periodOptions(days, archDays);
  if (!opts.some(([v]) => v === s.period)) s.period = 'all';
  return `<div class="rp-ctl rp-noprint"><label>${t('rep.period')} <select data-rp="period">${opts.map(([v, l]) => `<option value="${ctx.esc(v)}"${v === s.period ? ' selected' : ''}>${ctx.esc(l)}</option>`).join('')}</select></label>
    <button type="button" data-rp="print" title="${t('rep.printOnlyReportOrSaveItAsPdf')}">${t('rep.printPdf')}</button><button type="button" data-rp="csv" title="${t('rep.dailyAndPeriodValuesPer')}">↓ CSV</button></div>`;
}
/**
 * Kommunal-Bericht der gewählten Gemeinde (state.scope) in el. Filter Anbieter/Fahrzeugart wirken.
 * Daten: events/index.json, events/<Tag>.json, history/index.json + history/<Tag>.json, cells/<Tag>/<Land>.json, latest.json, reference.json (CFG.MAIN);
 * Monat/Quartal über die 30 Tage hinaus: archive/index.json + archive/<Monat>.json. Kalibrierung: loadCalibration.
 */
export async function renderReport(el, ctx) {
  if (!el) return;
  const s = prep(el, ctx); const { state, esc } = ctx;
  bindOnce(el, 'report', () => {
    el.addEventListener('change', (e) => { if (e.target.matches('[data-rp="period"]')) { s.period = e.target.value; urlSet('period', s.period); renderReport(el, s.ctx); } });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-rp]'); if (!b) return;
      if (b.dataset.rp === 'print') printReport(el);
      else if (b.dataset.rp === 'csv') reportCsv(el);
      else if (b.dataset.rp === 'cellscsv') { const r = s.rep; if (r) download(`${t('file.places')}_${r.ags}_${r.from}_${r.to}.csv`, R.toCsv(R.cellsCsvRows(r.cells, { ags: r.ags, name: s.meta?.name, from: r.from, to: r.to , lang: lang() }), lang())); }
      else if (b.dataset.rp === 'toggle') { const k = b.dataset.k; s.show[k] = !s.show[k]; const v = el.querySelector(`[data-rp-view="${k}"]`); if (v) v.hidden = !s.show[k]; b.setAttribute('aria-expanded', String(!!s.show[k])); b.textContent = s.show[k] ? t('rep.hideTable') : t('rep.asTable'); }
    });
    bindCellTips(el);
  });
  const title = head(t('rep.municipalReport2'), t('rep.printableReportPer'));
  const put = (html) => { unmountCellMaps(s); el.innerHTML = html; if (!html.includes('rp-report')) clearAnswer(el); }; // Karten vor dem Ersetzen abbauen (Leaflet hält sonst Ereignisse und Kacheln); ohne Bericht keine Antwort
  if (!state.latest) { put(title + emptyBox(t('rep.noDataSnapshotYet'), t('rep.reportAppearsAsSoonAs'))); return; }
  if (!state.scope || state.scope === 'DE') { put(title + emptyBox(t('rep.chooseMunicipality'), t('rep.reportAppliesPerMunicipality'))); return; }
  const tok = ++s.tok; el.classList.add('rp-busy');
  if (!el.querySelector('.rp-report')) put(title + `<div class="muted small">${t('rep.compilingReport')}</div>`);
  try {
    const ags = state.scope, m = state.latest.municipalities?.[ags] || {};
    const name = m.name || ctx.muniName?.(ags) || ags;
    const [idx, archDays] = await Promise.all([usageIndex(ctx), archiveDayList(ctx).catch(() => [])]); const all = (idx.days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (tok !== s.tok) return;
    if (!all.length) { put(title + emptyBox(t('rep.noDailyFilesYet'), t('rep.reportNeedsMeasuredMovements'))); return; }
    if (!periodOptions(all, archDays).some(([v]) => v === s.period)) s.period = 'all';
    const days = pickDays(all, s.period, archDays);
    const useArchive = days.some(d => !all.includes(d));
    let rep, missing, ref;
    const calibP = loadCalibration(ctx); const limits = (await calibP).limits || null; if (tok !== s.tok) return;
    if (useArchive) {
      const [{ archive, fields }, r, daily] = await Promise.all([archiveFor(ctx, days), reference(ctx), dailyDoc(ctx).catch(() => null)]); ref = r;
      if (tok !== s.tok) return;
      rep = R.archiveReport({ archive, fields, ags, pop: m.pop || null, operator: state.operator, type: state.type, days, rvdLimit: limits, eventChecks: state.latest.eventChecks, breaks: daily?.breaks || null });
      missing = days.filter(d => !archive[d]);
    } else {
      const [hidx, daily] = await Promise.all([histIndex(ctx), dailyDoc(ctx)]);
      const [docs, hists, cdocs, r] = await Promise.all([
        Promise.all(days.map(d => eventsDoc(ctx, idx, d))), Promise.all(days.map(d => histFor(ctx, hidx, daily, d))), Promise.all(days.map(d => cellsDoc(ctx, idx, d, m.state))), reference(ctx)]);
      ref = r;
      if (tok !== s.tok) return;
      const cells = {}, cellRuns = {};
      days.forEach((d, i) => { const c = cdocs[i]; if (c?.munis) { cells[d] = c.munis[ags] || {}; cellRuns[d] = sum(c.bandRuns) || (docs[i]?.runs || []).length; } });
      rep = R.municipalReport({ docs: docs.filter(Boolean), hists: Object.fromEntries(days.map((d, i) => [d, hists[i]]).filter(x => x[1])), cells, cellRuns, ags, pop: m.pop || null, operator: state.operator, type: state.type, latestGroups: state.latest.groups, rvdLimit: limits, eventChecks: state.latest.eventChecks, breaks: daily?.breaks || null });
      missing = days.filter((d, i) => !docs[i]);
    }
    const calib = await calibP; if (tok !== s.tok) return;
    const cal = K.calibrateReport(rep, calib.k, { limits: calib.limits, kinds: calib.kinds }); // k nur für die Kennungsart der Berliner Referenz
    const meta = { name, missing, s, calib, cal, period: periodInfo(s.period), archive: useArchive };
    s.rep = rep; s.meta = meta;
    put(head(t('rep.municipalReport2'), t('rep.printableReportPer2', { name: esc(name) }), reportControls(ctx, s, all, archDays)) + reportHtml(ctx, rep, meta, ref));
    setAnswer(viewSlot(el), meta.answer); // S4.1: Antwort oben in der Ansicht (im Druck steht dieselbe im Bericht)
    mountCellMaps(el, s);
  } catch (e) {
    console.error('Bericht', e);
    if (tok === s.tok) put(title + emptyBox(t('rep.reportCannotBeCreated'), t('rep.dataNotLoadableReloadPage')));
  } finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}
function bindCellTips(el) {
  el.addEventListener('pointermove', (e) => {
    const r = e.target.closest?.('svg.rp-cellmap rect[data-i]'); const box = e.target.closest?.('.rp-chart');
    el.querySelectorAll('svg.rp-cellmap rect.on').forEach(x => { if (x !== r) x.classList.remove('on'); });
    if (!r || !box) { el.querySelectorAll('.rp-chart').forEach(hideTip); return; }
    const s = st(el); const c = s.rep?.cells.grid[+r.dataset.i]; if (!c) return;
    r.classList.add('on');
    const key = r.closest('svg').dataset.key; const { fmt } = s.ctx;
    const m = (v) => (R.suppressed(v) ? `< ${R.MIN_COUNT}` : fmt(v));
    showTip(box, r, `${m(c[key])} ${key === 'start' ? t('rep.tripStarts') : t('rep.tripEnds')}`, [t('rep.avgAvailablePerRun2', { v0: m(c[key === 'start' ? 'end' : 'start']), v1: key === 'start' ? t('rep.tripEnds') : t('rep.tripStarts'), v2: c.presAvg == null ? '—' : fmt(c.presAvg, 1) }), t('rep.cell2', { v0: c.lat.toFixed(4), v1: c.lon.toFixed(4) })]);
  });
  el.addEventListener('pointerleave', () => { el.querySelectorAll('.rp-chart').forEach(hideTip); el.querySelectorAll('svg.rp-cellmap rect.on').forEach(x => x.classList.remove('on')); });
}
