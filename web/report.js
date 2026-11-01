// Mobility Pulse — Bericht: Kommunal-Bericht (druckbar, CSV), Obergrenzen-Wächter, Heatmap Stunde × Wochentag,
// Preisänderungs-Log und Feed-Prüfung. Eigenständiges Modul; app.js übergibt
// ctx = { state, CFG, esc, fmt, getJson, opColor, muniName } und optional loadUsageIndex, loadEvents, loadHistory, loadCells (geteilter Cache).
// Rechenlogik in pulse-report.js; alle Werte aus Daten gehen durch ctx.esc, Tooltip-Texte über textContent.
import * as R from './pulse-report.js';
import * as K from './pulse-calib.js';
import { VEHICLE_TYPE_LABEL as TYPE } from './pulse-core.js';

const S = new WeakMap(); // Element → { ctx, tok, period, show }
const st = (el) => { let s = S.get(el); if (!s) { s = { tok: 0, period: 'all', show: {} }; S.set(el, s); } return s; };
const CACHE = new Map();
const DTF = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: R.TZ });
const TF = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: R.TZ });
const stamp = (ms) => (ms ? DTF.format(new Date(ms)) : '–');
const hhmm = (ms) => (ms ? TF.format(new Date(ms)) : '–');
const dd = R.dayLabel;
const sum = (a) => (a || []).reduce((x, y) => x + (y || 0), 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const typeName = (t) => TYPE[t] || t;

// ---------- Laden (ein Download je Datei; Dateien des laufenden Tags mit Laufstempel, damit neue Sammler-Läufe ankommen) ----------
function fetchJson(ctx, file, fresh = false, base = ctx.CFG.DATA) {
  const at = ctx.state?.latest?.at || '';
  const url = base + file + (fresh && at ? `?t=${at}` : '');
  if (!CACHE.has(url)) CACHE.set(url, Promise.resolve(ctx.getJson(url, { timeout: 60000 })).then(r => (r?.ok ? r.json : null), () => null));
  return CACHE.get(url);
}
/** Zwischenspeicher leeren (z. B. nach neuem Sammler-Lauf); ältere Tagesdateien ändern sich nicht */
export function resetReportCaches() { CACHE.clear(); }
const lastOf = (a) => (a || [])[(a || []).length - 1];
async function usageIndex(ctx) {
  const idx = ctx.loadUsageIndex ? await ctx.loadUsageIndex() : await fetchJson(ctx, 'events/index.json', true);
  return idx && Array.isArray(idx.days) ? idx : { days: [], cellDays: [] };
}
const eventsDoc = (ctx, idx, day) => (ctx.loadEvents ? ctx.loadEvents(day) : fetchJson(ctx, `events/${day}.json`, lastOf(idx.days) === day));
async function histIndex(ctx) { return ctx.state?.histIndex || (await fetchJson(ctx, 'history/index.json', true)) || { days: [] }; }
function histDoc(ctx, hidx, day) {
  if (!(hidx.days || []).includes(day)) return Promise.resolve(null);
  return ctx.loadHistory ? ctx.loadHistory(day) : fetchJson(ctx, `history/${day}.json`, lastOf(hidx.days) === day);
}
function cellsDoc(ctx, idx, day, land) {
  if (!land || !(idx.cellDays || []).includes(day)) return Promise.resolve(null);
  return ctx.loadCells ? ctx.loadCells(day, land) : fetchJson(ctx, `cells/${day}/${land}.json`, lastOf(idx.cellDays) === day);
}
const reference = (ctx) => fetchJson(ctx, 'reference.json', false, ctx.CFG.MAIN);
const dailyDoc = (ctx) => fetchJson(ctx, 'history/daily.json', true);
// Tageswerte für Flotte/Sperrquote: history/daily.json (verdichtet), sonst history/<Tag>.json
const histFor = (ctx, hidx, daily, day) => { const h = R.histFromDaily(daily, day); return h ? Promise.resolve(h) : histDoc(ctx, hidx, day); };
async function allDocs(ctx, days) { const idx = await usageIndex(ctx); const list = days || idx.days || []; return { idx, docs: (await Promise.all(list.map(d => eventsDoc(ctx, idx, d)))).filter(Boolean) }; }

// ---------- Kalibrierung (lib/pulse-calib.js): einmal je Datenstand, geteilt mit app.js ----------
// Berliner Messung = Kommunal-Bericht Berlin, E-Scooter, über die letzten CALIB_DAYS Tagesdateien; Vergleichswerte (Deutschland, Voi,
// Frankfurt) aus der Städte-Rangliste derselben Tage. Ohne reference.json: Annahmen wie bisher, keine Kalibrierung.
export const CALIB_DAYS = 14;
const CALIB_CACHE = new Map();
const isClient = () => typeof document !== 'undefined' && document.body?.classList.contains('mode-client');
const natRvd = (rows) => { let rd = 0, fl = 0; for (const r of rows) if (r.rvd > 0 && r.ridesDay != null) { rd += r.ridesDay; fl += r.ridesDay / r.rvd; } return fl > 0 ? { rvd: rd / fl, ridesDay: rd, fleet: fl } : null; };
export function loadCalibration(ctx) {
  const key = `${ctx.state?.latest?.at || ''}`;
  if (!CALIB_CACHE.has(key)) CALIB_CACHE.set(key, (async () => {
    const ref = await reference(ctx);
    const idx = await usageIndex(ctx); const days = (idx.days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-CALIB_DAYS);
    const [hidx, daily] = await Promise.all([histIndex(ctx), dailyDoc(ctx)]);
    const [docs, hs] = await Promise.all([Promise.all(days.map(d => eventsDoc(ctx, idx, d))), Promise.all(days.map(d => histFor(ctx, hidx, daily, d)))]);
    const ok = docs.map((d, i) => [d, days[i], hs[i]]).filter(([d]) => d);
    const D = ok.map(x => x[0]), H = Object.fromEntries(ok.filter(x => x[2]).map(x => [x[1], x[2]]));
    const latest = ctx.state?.latest || null; const limits = K.rvdLimits(ref);
    // k nur aus plausiblen Berliner Anbietern; Vergleichswerte Deutschland/Voi ohne Überzählungen; Gemeinden (Frankfurt) roh, damit die Prüfung sie zeigt
    const berlinReport = D.length ? R.municipalReport({ docs: D, hists: H, ags: K.BERLIN, type: 'scooter', latestGroups: null, rvdLimit: limits }) : null;
    const all = D.length ? R.cityRanking(D, H, latest, { type: 'scooter', minFleet: 0, rvdLimit: limits }) : { rows: [] };
    const raw = D.length ? R.cityRanking(D, H, latest, { type: 'scooter', minFleet: 0 }) : { rows: [] };
    const voi = D.length ? R.cityRanking(D, H, latest, { type: 'scooter', operator: 'Voi', minFleet: 0, rvdLimit: limits }) : { rows: [] };
    const byAgs = Object.fromEntries(raw.rows.map(r => [r.ags, { rvd: r.rvd, fleet: r.fleet, ridesDay: r.ridesDay }]));
    const own = { national: natRvd(all.rows), voi: natRvd(voi.rows), byAgs };
    const c = K.calibration(ref, { berlinReport: berlinReport && berlinReport.groups.length ? berlinReport : null, groups: latest?.groups, own });
    return { ...c, ref, own, days: ok.map(x => x[1]), berlinReport };
  })().catch(e => { console.error('Kalibrierung', e); return { assume: K.rideAssumptions(null), limits: {}, k: { applied: false, reason: 'Kalibrierung nicht berechenbar' }, coverage: [], checks: [], ref: null, own: {}, days: [], hasReference: false }; }));
  return CALIB_CACHE.get(key);
}
// Kurzbeschreibung des Faktors für Notizen und CSV, z. B. „Berlin Q4/2025 · vorläufig“
export const SUSPENDED_TXT = R.SUSPENDED;
export const calibLabel = (k) => (k?.applied ? `Berlin ${k.quarter}${k.prelim ? ' · vorläufig' : ''}` : '');

// ---------- Stil (einmal in den head; nur Variablen aus index.html) ----------
// Skala --rp-seq-0…8: Anteile 7/16/27/38/49/60/72/85/100 % Akzent in OKLab – dieselben Werte stehen in SEQ_P (Zellkarten auf Canvas)
const CSS = `
.rp-root{--rp-seq-0:color-mix(in oklab,var(--accent) 7%,var(--panel));--rp-seq-1:color-mix(in oklab,var(--accent) 16%,var(--panel));--rp-seq-2:color-mix(in oklab,var(--accent) 27%,var(--panel));--rp-seq-3:color-mix(in oklab,var(--accent) 38%,var(--panel));--rp-seq-4:color-mix(in oklab,var(--accent) 49%,var(--panel));--rp-seq-5:color-mix(in oklab,var(--accent) 60%,var(--panel));--rp-seq-6:color-mix(in oklab,var(--accent) 72%,var(--panel));--rp-seq-7:color-mix(in oklab,var(--accent) 85%,var(--panel));--rp-seq-8:var(--accent);
  --rp-na:repeating-linear-gradient(135deg,color-mix(in srgb,var(--muted) 34%,transparent) 0 1.5px,transparent 1.5px 6px)}
.rp-s0{--rp-f:var(--rp-seq-0)}.rp-s1{--rp-f:var(--rp-seq-1)}.rp-s2{--rp-f:var(--rp-seq-2)}.rp-s3{--rp-f:var(--rp-seq-3)}.rp-s4{--rp-f:var(--rp-seq-4)}.rp-s5{--rp-f:var(--rp-seq-5)}.rp-s6{--rp-f:var(--rp-seq-6)}.rp-s7{--rp-f:var(--rp-seq-7)}.rp-s8{--rp-f:var(--rp-seq-8)}
.rp-root.rp-busy>:not(.panel-head){opacity:.55;transition:opacity .2s}
.rp-ctl{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center}
.rp-ctl label{display:inline-flex;gap:var(--s2);align-items:center;font-size:13px;color:var(--fg-2)}
.rp-report{display:flex;flex-direction:column;gap:var(--s5);min-width:0}
.rp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--s3);flex-wrap:wrap;padding-bottom:var(--s3);border-bottom:1px solid var(--line)}
.rp-kicker{font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.rp-head h2{margin:2px 0 4px;font-size:22px;line-height:1.2;letter-spacing:-.015em;font-weight:700}
.rp-head h2 small{font-size:13px;font-weight:400;color:var(--fg-2);letter-spacing:0;margin-left:var(--s2)}
.rp-head .sub{color:var(--fg-2);font-size:12.5px;margin:0;max-width:90ch}
.rp-sec{min-width:0}
.rp-sec>h3{margin:0 0 var(--s1);font-size:14px;font-weight:600;color:var(--fg)}
.rp-sec>.sub{color:var(--muted);font-size:12.5px;margin:0 0 var(--s2)}
.rp-qual{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:var(--s2) var(--s5);padding:var(--s3);border:1px solid var(--line-2);border-radius:var(--r-sm);background:var(--panel-2);font-size:13px;color:var(--fg-2)}
.rp-qual.prelim{box-shadow:inset 3px 0 0 var(--warn)}
.rp-qual dt{font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.rp-qual dd{margin:2px 0 0;color:var(--fg)}.rp-qual dd .muted{color:var(--muted)}
.rp-qual>div{min-width:0}
.rp-grid2{display:grid;gap:var(--s4);grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))}
.rp-report .tbl{max-height:none}
.rp-root td .sub-line{white-space:normal}
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
.rp-week .rl{font-size:12px;color:var(--fg-2);display:flex;align-items:center;justify-content:space-between;gap:4px;padding-right:6px;white-space:nowrap}
.rp-week .rl small{color:var(--muted);font-family:var(--mono);font-size:10.5px}
.rp-week .hl{font-family:var(--mono);font-size:10px;color:var(--muted);line-height:1;padding:0 0 4px}
.rp-legend{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);align-items:center;font-size:12px;color:var(--fg-2);margin-top:var(--s2)}
.rp-ramp{display:inline-flex;align-items:center;gap:2px}.rp-ramp>span{width:14px;height:10px;border-radius:2px;background:var(--rp-f)}
.rp-ramp>em{font-style:normal;font-family:var(--mono);font-size:11px;color:var(--fg-2);margin:0 4px}
.rp-sw{display:inline-block;width:14px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:6px;background:var(--rp-f,var(--rp-seq-0))}.rp-sw.na{background:var(--rp-na),var(--panel-2)}
.rp-tip{position:absolute;z-index:30;pointer-events:none;width:max-content;max-width:280px;padding:6px 10px;border-radius:var(--r-sm);border:1px solid var(--line-2);background:var(--panel);box-shadow:var(--shadow);font-size:12px;line-height:1.4;color:var(--fg-2);transform:translate(-50%,calc(-100% - 8px))}
.rp-tip b{display:block;font-family:var(--mono);font-size:14px;font-weight:600;color:var(--fg);white-space:nowrap}
.rp-maps{display:grid;gap:var(--s4);grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))}
.rp-fig{margin:0;min-width:0}.rp-fig figcaption{font-size:12.5px;font-weight:600;color:var(--fg);margin-bottom:var(--s1)}
svg.rp-cellmap{display:block;width:100%;height:auto;max-height:340px;background:var(--panel-2);border-radius:var(--r-sm)}
svg.rp-cellmap rect{fill:var(--rp-f)}svg.rp-cellmap rect.on{stroke:var(--fg);stroke-width:.18}
div.rp-cellmap{height:clamp(260px,46vw,380px);border-radius:var(--r-sm);border:1px solid var(--line);overflow:hidden;z-index:0;background:var(--panel-2)}
div.rp-cellmap:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
div.rp-cellmap .leaflet-tile-pane{filter:grayscale(1) invert(1) brightness(.8) contrast(.88)}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]) div.rp-cellmap .leaflet-tile-pane{filter:grayscale(1) contrast(.92) brightness(1.04)}}
:root[data-theme="light"] div.rp-cellmap .leaflet-tile-pane{filter:grayscale(1) contrast(.92) brightness(1.04)}
img.rp-cellmap-img{display:block;width:100%;height:auto;border-radius:var(--r-sm)}
.rp-cellnote{margin:0 0 var(--s2)}
.rp-status{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:var(--fg);white-space:nowrap}
.rp-status i{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;font:700 10px/1 var(--sans);font-style:normal;color:var(--panel);background:var(--muted);flex:none}
.rp-status.ok i{background:var(--ok)}.rp-status.near i{background:var(--warn)}.rp-status.over i{background:var(--bad)}
.rp-status.unchecked i,.rp-status.unknown i,.rp-status.none i,.rp-status.unlicensed i,.rp-status.info i,.rp-status.hint i{background:transparent;color:var(--fg-2);box-shadow:inset 0 0 0 1.5px var(--fg-2)}
details.rp-capinfo{margin-top:var(--s3);font-size:12.5px;color:var(--fg-2)}details.rp-capinfo summary{cursor:pointer;color:var(--fg);font-weight:500}details.rp-capinfo ul{margin:var(--s2) 0 0;padding-left:1.2em;display:grid;gap:4px}
.rp-meter{position:relative;height:8px;border-radius:4px;background:color-mix(in srgb,var(--rp-c,var(--accent)) 20%,var(--panel-2));min-width:80px}
.rp-meter>i{display:block;height:100%;border-radius:4px;background:var(--rp-c,var(--accent))}
.rp-meter>b{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;border-radius:1px;background:var(--fg)}
.rp-meter.ok{--rp-c:var(--ok)}.rp-meter.near{--rp-c:var(--warn)}.rp-meter.over{--rp-c:var(--bad)}
.rp-cap{display:flex;flex-direction:column;gap:var(--s3);padding:var(--s3) 0;border-top:1px solid var(--line)}
.rp-cap:first-of-type{border-top:0;padding-top:0}
.rp-cap-h{display:flex;justify-content:space-between;align-items:baseline;gap:var(--s3);flex-wrap:wrap}
.rp-cap-h h3{margin:0;font-size:15px}
.rp-cap-total{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--s1) var(--s3);align-items:center}
.rp-cap-total .big{font-family:var(--mono);font-size:22px;font-weight:500;color:var(--fg);font-variant-numeric:normal}
.rp-print-root{display:none}
@page{size:A4;margin:14mm 12mm}
@media print{
  body.rp-printing>:not(.rp-print-root){display:none!important}
  body.rp-printing .rp-print-root{display:block!important}
  body.rp-printing{background:#fff}
  .rp-noprint,.rp-tip{display:none!important}
  .rp-print-root .rp-report{gap:14px}
  .rp-print-root .rp-qual,.rp-print-root .rp-fig,.rp-print-root .tile,.rp-print-root .rp-legend,.rp-print-root tr{break-inside:avoid}
  .rp-print-root h3,.rp-print-root .sub{break-after:avoid}
  .rp-print-root .tbl{overflow:visible;max-height:none}
  .rp-print-root table{font-size:10.5px}.rp-print-root th{font-size:8.5px;padding:4px 6px}.rp-print-root td{padding:4px 6px}
  .rp-print-root .tiles{grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.rp-print-root .tile{padding:8px 10px}.rp-print-root .tile .v{font-size:18px}
  .rp-print-root .rp-grid2{grid-template-columns:1fr}
  .rp-print-root .rp-head h2{font-size:20px}
  .rp-print-root svg.rp-cellmap{max-height:250px}
  .rp-print-root img.rp-cellmap-img{max-height:260px;object-fit:contain}
  .rp-print-root a{color:inherit;text-decoration:none}
}`;
function injectStyle() {
  if (document.getElementById('rp-style')) return;
  const s = document.createElement('style'); s.id = 'rp-style'; s.textContent = CSS; document.head.appendChild(s);
}
function prep(el, ctx) { injectStyle(); el.classList.add('rp-root'); const s = st(el); s.ctx = ctx; return s; }

// ---------- Bausteine ----------
const head = (title, sub, right = '') => `<div class="panel-head"><div><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right}</div>`;
const tile = (l, v, s) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const emptyBox = (b, t) => `<div class="empty"><b>${b}</b>${t}</div>`;
const STATUS = { ok: ['✓', 'ok'], near: ['!', 'nahe'], over: ['✕', 'über'], unchecked: ['?', 'nicht prüfbar'], unknown: ['–', 'ohne Grenze'], hint: ['i', 'Hinweis (gerechnete Zahl)'], info: ['i', 'nur Information'], none: ['–', 'keine Grenze laut Quelle'], unlicensed: ['–', 'ohne Zulassung laut Quelle'] };
const badge = (s) => `<span class="rp-status ${s}"><i aria-hidden="true">${STATUS[s][0]}</i>${STATUS[s][1]}</span>`;
const safeLink = (ctx, url, label) => (/^https?:\/\//i.test(String(url || '')) ? `<a href="${ctx.esc(url)}" target="_blank" rel="noopener">${ctx.esc(label)}</a>` : ctx.esc(label));
const rampSpans = (from = 1, to = 8) => Array.from({ length: to - from + 1 }, (_, i) => `<span class="rp-s${from + i}"></span>`).join('');
const pctTxt = (ctx, v, d = 1) => (v == null ? '—' : `${ctx.fmt(v * 100, d)} %`);
const num = (ctx, v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : ctx.fmt(v, d));
const cnt = (ctx, v) => (R.suppressed(v) ? `&lt; ${R.MIN_COUNT}` : num(ctx, v)); // Fahrten-Zählung mit Datenschutz-Schwelle
const kmTxt = (ctx, v) => (v == null ? null : `${ctx.fmt(v, 2)} km`);
const minTxt = (ctx, v) => (v == null ? null : `${ctx.fmt(v, 1)} Min.`);
function bindOnce(el, kind, fn) { if (el.dataset.rpBound === kind) return; el.dataset.rpBound = kind; fn(); }

// Tooltip: ein Element je Diagramm, Inhalt über textContent; Wert zuerst, Beschriftung danach
function tip(box) { let t = box.querySelector(':scope > .rp-tip'); if (!t) { t = document.createElement('div'); t.className = 'rp-tip'; t.hidden = true; box.appendChild(t); } return t; }
function showTip(box, target, value, label) {
  const t = tip(box); t.replaceChildren(); const b = document.createElement('b'); b.textContent = value; t.append(b);
  for (const l of [].concat(label || [])) { const d = document.createElement('div'); d.textContent = l; t.append(d); }
  t.hidden = false;
  const r = target.getBoundingClientRect(), w = box.getBoundingClientRect();
  const x = Math.max(t.offsetWidth / 2 + 4, Math.min(w.width - t.offsetWidth / 2 - 4, r.left - w.left + r.width / 2));
  let y = r.top - w.top; if (y - t.offsetHeight - 10 < 0) y = r.bottom - w.top + t.offsetHeight + 16;
  t.style.left = `${x}px`; t.style.top = `${y}px`;
}
const hideTip = (box) => { const t = box.querySelector(':scope > .rp-tip'); if (t) t.hidden = true; };
function download(name, text, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ======================================================================
// 1. Kommunal-Bericht
// ======================================================================
// Zeitraum: alle Tage, letzte 7/14, Quartal (nur wenn die Daten ganz darüber reichen), Monat, einzelner Tag
function periodOptions(days, archDays = []) {
  const opts = [['all', `Alle verfügbaren Tage (${days.length})`]];
  if (days.length > 7) opts.push(['last7', 'Letzte 7 Tage']);
  if (days.length > 14) opts.push(['last14', 'Letzte 14 Tage']);
  const known = [...new Set([...archDays, ...days])].sort();
  for (const q of R.completeQuarters(known).reverse()) opts.push([`q:${q}`, `Quartal ${R.periodRange(`q:${q}`).label}`]);
  for (const m of R.monthsOf(known).reverse()) opts.push([m.period, `${m.label}${m.complete ? '' : ` (${plural(m.days, 'Tag', 'Tage')} mit Daten)`}`]);
  for (const d of [...days].reverse()) opts.push([`day:${d}`, `${R.WEEKDAYS[R.weekdayOf(d)]}, ${dd(d)}`]);
  return opts;
}
function pickDays(days, period, archDays = []) {
  if (period === 'last7') return days.slice(-7);
  if (period === 'last14') return days.slice(-14);
  if (period?.startsWith('day:')) { const d = period.slice(4); return days.includes(d) ? [d] : days; }
  if (/^[mq]:/.test(period || '')) { const r = R.daysIn(period, [...new Set([...archDays, ...days])]); return r.length ? r : days; }
  return days;
}
const periodInfo = (period) => { const r = R.periodRange(period); if (r) return { kind: r.kind, label: r.label, key: r.key }; if (period?.startsWith('day:')) return { kind: 'Tag', label: dd(period.slice(4)) }; return { kind: 'Tage', label: period === 'last7' ? 'letzte 7 Tage' : period === 'last14' ? 'letzte 14 Tage' : 'alle Tage mit Tagesdateien' }; };
// Langzeit-Archiv (archive/<Monat>.json, nie gekürzt): Tagesliste ohne alle Monate zu laden, wenn der Index firstDay kennt
const archIndex = (ctx) => fetchJson(ctx, 'archive/index.json', true);
async function archiveDayList(ctx) {
  const ai = await archIndex(ctx); const months = (ai?.months || []).filter(m => /^\d{4}-\d{2}$/.test(m)).sort(); if (!months.length) return [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(ai.firstDay || '')) {
    const last = ctx.state?.latest?.at ? R.berlinDay(ctx.state.latest.at) : `${lastOf(months)}-28`; const out = [];
    for (let t = Date.parse(`${ai.firstDay}T12:00:00Z`), end = Date.parse(`${last}T12:00:00Z`); t <= end && out.length < 4000; t += 86400e3) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }
  const docs = await Promise.all(months.map(m => fetchJson(ctx, `archive/${m}.json`, m === lastOf(months))));
  return docs.flatMap(d => Object.keys(d?.days || {})).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
}
async function archiveFor(ctx, days) {
  const ai = await archIndex(ctx); const months = [...new Set(days.map(d => d.slice(0, 7)))].filter(m => (ai?.months || []).includes(m));
  const docs = await Promise.all(months.map(m => fetchJson(ctx, `archive/${m}.json`, m === lastOf((ai.months || []).slice().sort()))));
  const archive = {}; let fields = null; for (const d of docs) { if (!d?.days) continue; fields ??= d.fields; for (const [day, rows] of Object.entries(d.days)) if (days.includes(day)) archive[day] = rows; }
  return { archive, fields: fields || ai?.fields || R.ARCHIVE_FIELDS };
}
function filterText(ctx) {
  const { state } = ctx;
  return [state.operator !== 'all' ? `Anbieter ${ctx.esc(state.operator)}` : 'alle Anbieter', state.type !== 'all' ? ctx.esc(typeName(state.type)) : 'alle Fahrzeugarten'].join(', ');
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
function tripTxt(ctx, r) {
  const one = (unit, mean, med, lo, hi) => [lo != null && hi != null ? `${fd(ctx, lo)}–${fd(ctx, hi)} ${unit}` : null, med != null ? `Median ${fd(ctx, med)} ${unit}` : null, mean != null ? `Ø ${fd(ctx, mean)} ${unit}` : null].filter(Boolean).join(', ');
  return [one('km', r.kmMittel, r.kmMedian, r.kmMin, r.kmMax), one('Min.', r.minMittel, r.minMedian, r.minMin, r.minMax)].filter(Boolean).join(' · ');
}
// Flotte laut Quelle: Berlin genehmigt (Abgeordnetenhaus), München aktiv (Stadtrat: keine Genehmigungspflicht)
const fleetLabel = (r) => (r?.art === 'genehmigt' ? 'Genehmigte Flotte' : r?.art === 'aktiv' ? 'Aktive Flotte' : 'Flotte');
function referenceRows(ctx, ref, rep, cal = null) {
  if (!ref || !rep.ags) return '';
  const own = scooterAgg(rep, cal); const rows = []; const client = isClient();
  const src = (r) => safeLink(ctx, r.url, r.quelle || 'Quelle');
  const ownRvd = (r) => { if (r.type !== 'scooter' || own?.rvd == null) return '—'; if (client) return num(ctx, own.rvdCal ?? own.rvd, 2); return `${num(ctx, own.rvd, 2)}${own.rvdCal != null ? `<div class="sub-line">kalibriert ${num(ctx, own.rvdCal, 2)}</div>` : ''}`; };
  for (const r of (ref.rvd || []).filter(x => x.ags === rep.ags)) rows.push([`Fahrten je Fahrzeug und Tag · ${ctx.esc(typeName(r.type))}`, num(ctx, r.wert, 2), ctx.esc(r.zeitraum || ''), src(r), ownRvd(r)]);
  for (const r of (ref.fahrt || []).filter(x => x.ags === rep.ags)) rows.push([`Fahrt · ${ctx.esc(typeName(r.type))}`, tripTxt(ctx, r), ctx.esc(r.zeitraum || ''), src(r), [kmTxt(ctx, own?.avgKm), minTxt(ctx, own?.avgMin)].filter(Boolean).join(' · ') || 'nicht messbar']);
  for (const r of (ref.flotte || []).filter(x => x.ags === rep.ags)) rows.push([`${fleetLabel(r)} · ${ctx.esc(typeName(r.type))}`, num(ctx, r.wert), r.stand ? dd(r.stand) : '', src(r), own ? `${num(ctx, own.fleet)} in offenen Feeds<div class="sub-line">${pctTxt(ctx, own.fleet / r.wert, 1)} ${r.art === 'genehmigt' ? 'der genehmigten Flotte (Untergrenze der Feed-Abdeckung)' : r.art === 'aktiv' ? 'der aktiven Flotte' : 'der Flotte laut Quelle'}</div>` : '—']);
  for (const r of (ref.fahrten || []).filter(x => x.ags === rep.ags)) rows.push([`Fahrten im Jahr · ${ctx.esc(typeName(r.type))}`, num(ctx, r.wert), ctx.esc(r.zeitraum || ''), src(r), '—']);
  if (!rows.length) return '';
  return `<section class="rp-sec"><h3>Einordnung: öffentliche Referenzwerte</h3><div class="sub">Werte aus amtlichen oder veröffentlichten Quellen neben ${client ? 'unserem Wert' : 'der eigenen Messung'} im gewählten Zeitraum</div>
    <div class="tbl"><table><thead><tr><th>Kennzahl</th><th class="n">Referenz</th><th>Zeitraum</th><th>Quelle</th><th class="n">${client ? 'unser Wert' : 'eigene Messung'}</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="n">${r[1]}</td><td>${r[2]}</td><td class="small">${r[3]}</td><td class="n">${r[4]}</td></tr>`).join('')}</tbody></table></div></section>`;
}
const meta_lim = (calib) => calib?.limits?.scooter ?? null;
// Kalibrierung in einem Satz (Kundenansicht ohne Methodikbegriffe)
function calibText(ctx, calib) {
  const k = calib?.k; const { fmt } = ctx;
  if (isClient()) return k?.applied ? `E-Scooter-Fahrten kalibriert an amtlichen Berliner Zahlen (${safeLink(ctx, k.ref.url, k.ref.quelle || 'Quelle')}); angegeben mit Spanne` : 'nicht kalibriert';
  if (!k?.applied) return `nicht kalibriert: ${ctx.esc(k?.reason || 'keine Referenz')}`;
  const m = k.measured;
  return `E-Scooter-Fahrten × <b>${fmt(k.k, 2)}</b> (Spanne ${fmt(k.kLow, 2)}–${fmt(k.kHigh, 2)}) = amtlich Berlin ${ctx.esc(k.quarter)} ${fmt(k.ref.wert, 2)} ÷ gemessen Berlin ${fmt(m.rvd, 2)} Fahrten je Fahrzeug und Tag (${ctx.esc(k.source)}; ${plural(m.days, 'Tag', 'Tage')}, ${pctTxt(ctx, k.obsShare, 0)} beobachtet, ${dd(m.from)}–${dd(m.to)}) · ${ctx.esc(k.rule)}${k.prelim ? ` · <b>vorläufig</b> <span class="muted">(${ctx.esc(k.prelimWhy.join(', '))})</span>` : ''}${k.single ? ` · <span class="muted">Einschränkung: ${ctx.esc(k.single)}</span>` : ''}${m.excluded?.length ? ` · <span class="muted">ausgeschlossen (Überzählung): ${ctx.esc(m.excluded.map(x => x.op).join(', '))}</span>` : ''} · Zeilen über ${fmt(meta_lim(calib), 2)} Fahrten je Fahrzeug und Tag werden nicht kalibriert · ${safeLink(ctx, k.ref.url, k.ref.quelle || 'Quelle')}`;
}
function qualityBlock(ctx, rep, extra) {
  const q = rep.quality, { fmt, esc } = ctx; const arch = q.source === 'archiv';
  const obsH = q.obsMin / 60, possH = q.possibleMin / 60;
  const gaps = q.gaps.slice(0, 4).map(g => `${dd(g.day).slice(0, 6)} ${g.from != null ? `${hhmm(g.from)}–` : 'bis '}${hhmm(g.at)}${g.ms ? ` (${fmt(g.ms / 3600e3, 1)} h)` : ''}`).join(' · ');
  const items = [
    ['Beobachtung', `${fmt(obsH, 1)} h von ${fmt(possH)} h (${pctTxt(ctx, possH ? obsH / possH : null, 0)}) · ${arch ? 'Tageswerte aus dem Langzeit-Archiv' : plural(q.runs, 'Sammler-Lauf', 'Sammler-Läufe')}`],
    ['Volle Messtage', `${q.fullDays} von ${q.days} <span class="muted">(≥ ${R.FULL_DAY_HOURS} Stunden mit ≥ ${R.FULL_HOUR_MIN} Min. Beobachtung${arch ? ', im Archiv: ≥ 1.000 beobachtete Minuten' : ''})</span>${q.prelim ? ` · <b>vorläufig</b> <span class="muted">unter ${R.MIN_FULL_DAYS} vollen Tagen</span>` : ''}`],
    ['Lücken', arch ? 'im Archiv nicht je Lauf ausgewiesen; gestörte Stunden sind dort schon herausgerechnet' : q.gapRuns ? `${plural(q.gapRuns, 'Lücken-Lauf', 'Lücken-Läufe')}, längste ${fmt(q.longestGapMs / 3600e3, 1)} h · ${plural(q.excludedHours, 'Stunde', 'Stunden')} ohne Wertung<div class="muted small">${gaps}${q.gaps.length > 4 ? ' …' : ''}</div>` : 'keine (Abstand zwischen Läufen nie über 45 Min.)'],
    ['Hochrechnung auf den Tag', arch ? `${esc(q.profileSource)} · Fahrten ÷ beobachteter Anteil des Tages` : `Tagesgang ${esc(q.profileSource)} · Fahrten ÷ beobachteter Anteil des Tagesgangs`],
    ['Flotte', arch ? 'Ø Fahrzeuge je Tag laut Archiv (Fahrzeugminuten bzw. Ø Bestand je Lauf, inkl. gesperrter)' : q.fleetFromHistory.length ? `Fahrzeugminuten ÷ beobachtete Minuten; ${q.fleetFromHistory.map(d => dd(d).slice(0, 6)).join(', ')} aus dem Ø Bestand je Lauf` : 'Fahrzeugminuten ÷ beobachtete Minuten (inkl. gesperrter Fahrzeuge)'],
    ['Dauer und Distanz', arch ? 'im Archiv nicht enthalten' : `nur bei stabilen Fahrzeugkennungen und ab ${R.MIN_TRIPS_MEASURED} Messungen; Dauer im 20-Min.-Raster (Obergrenze), Distanz Luftlinie (Untergrenze)${q.taintedDays.length ? `; ${q.taintedDays.map(d => dd(d).slice(0, 6)).join(', ')} ausgelassen (Lücke mitgezählt)` : ''}`],
    ...extra,
  ];
  return `<dl class="rp-qual${q.prelim ? ' prelim' : ''}">${items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}
// Wert mit Spanne darunter (kalibriert)
const withSpan = (ctx, v, lo, hi, d = 0, bold = false) => `${bold ? '<b>' : ''}${num(ctx, v, d)}${bold ? '</b>' : ''}${lo != null && hi != null && Math.abs(hi - lo) > 1e-9 ? `<div class="sub-line">${num(ctx, lo, d)}–${num(ctx, hi, d)}</div>` : ''}`;
function groupTable(ctx, rep, cal = null) {
  const { esc, opColor } = ctx; const t = rep.totals; const client = isClient(); const C = cal?.applied ? cal : null;
  const notMeasurable = '<span class="muted" title="Kennungen wechseln je Fahrt oder weniger als 20 Messungen">nicht messbar</span>';
  const cOf = (g) => { const c = C?.groups.get(g.key); return c?.calibrated ? c : null; };
  // Kundenansicht: E-Scooter nur kalibriert (mit Spanne); intern: gemessen + Spalte „kalibriert“
  const rdCell = (g) => { const c = client && cOf(g); return c ? withSpan(ctx, c.ridesDay, c.lo, c.hi) : num(ctx, g.ridesDay); };
  const rvdCell = (g) => { const c = client && cOf(g); return c ? withSpan(ctx, c.rvd, c.rvdLo, c.rvdHi, 2, true) : `<b>${num(ctx, g.rvd, 2)}</b>`; };
  const calCol = C && !client;
  const calCell = (g) => { const c = cOf(g); return c && c.rvd != null ? withSpan(ctx, c.rvd, c.rvdLo, c.rvdHi, 2, true) : '<span class="muted" title="nur E-Scooter werden kalibriert">—</span>'; };
  const rows = rep.groups.map(g => `<tr${g.plausible ? '' : ' class="muted"'}><td><span class="op"><i style="background:${opColor(g.op)}"></i>${esc(g.op)}</span><div class="sub-line">${esc(typeName(g.ty))}${g.fleetSource === 'aktuell' ? ' · nur aktueller Bestand' : ''}</div>${g.flags.length ? `<div class="sub-line">${esc(g.flags[0])}</div>` : ''}</td>
    <td class="n">${num(ctx, g.fleet)}${g.fleetDays.length > 1 ? `<div class="sub-line">${num(ctx, g.fleetMin)}–${num(ctx, g.fleetMax)}</div>` : ''}</td>${client ? '' : `<td class="n">${num(ctx, g.rides)}</td>`}<td class="n">${rdCell(g)}</td><td class="n">${rvdCell(g)}</td>${calCol ? `<td class="n">${calCell(g)}</td>` : ''}
    <td class="n">${minTxt(ctx, g.avgMin) || notMeasurable}</td><td class="n">${kmTxt(ctx, g.avgKm) || notMeasurable}</td><td class="n">${pctTxt(ctx, g.disabledShare)}${g.disabledSource === 'aktuell' ? '<div class="sub-line">aktuell</div>' : ''}</td><td class="n">${num(ctx, g.per1000Fleet, 2)}</td></tr>`).join('');
  const ct = C?.totals; const cols = 9 + (calCol ? 1 : 0) - (client ? 1 : 0);
  const footRd = client && ct ? withSpan(ctx, ct.ridesDay, ct.lo, ct.hi) : num(ctx, t.ridesDay), footRvd = client && ct ? withSpan(ctx, ct.rvd, ct.rvdLo, ct.rvdHi, 2) : num(ctx, t.rvd, 2);
  return `<div class="tbl"><table><thead><tr><th>Anbieter · Art</th><th class="n">Ø Flotte</th>${client ? '' : '<th class="n">Fahrten gemessen</th>'}<th class="n">Fahrten / Tag${client && C ? ' <span class="muted">(E-Scooter kalibriert)</span>' : ''}</th><th class="n">je Fzg. und Tag</th>${calCol ? '<th class="n" title="E-Scooter × Kalibrierfaktor, Spanne aus den Berliner Quartalswerten">kalibriert je Fzg. und Tag</th>' : ''}<th class="n">Ø Dauer</th><th class="n">Ø Distanz</th><th class="n">Sperrquote</th><th class="n">Fzg. je 1.000 EW</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="${cols}" class="empty"><b>Keine Fahrzeuge im Filter.</b>Anbieter oder Fahrzeugart oben auf „Alle“ stellen.</td></tr>`}</tbody>
    ${rep.groups.length > 1 ? `<tfoot><tr><td>Summe${t.excluded.length ? `<div class="sub-line">Fahrten ohne ${esc(t.excluded.map(k => k.replace('|', ' ')).join(', '))} (unplausibel)</div>` : ''}</td><td class="n">${num(ctx, t.fleet)}</td>${client ? '' : `<td class="n">${num(ctx, t.rides)}</td>`}<td class="n">${footRd}</td><td class="n">${footRvd}</td>${calCol ? `<td class="n">${ct ? withSpan(ctx, ct.rvd, ct.rvdLo, ct.rvdHi, 2) : '—'}</td>` : ''}<td></td><td></td><td class="n">${pctTxt(ctx, t.disabledShare)}</td><td class="n">${num(ctx, t.per1000Fleet, 2)}</td></tr></tfoot>` : ''}</table></div>`;
}
function dailyTable(ctx, rep, k = null) {
  const { esc } = ctx; const client = isClient();
  // kalibriert je Tag: E-Scooter-Fahrten × k, andere Arten gemessen, ÷ beobachteter Anteil
  const calDay = (d) => { if (!k?.applied || !(d.coverage > 0)) return null; let r = 0, any = false; for (const [key, v] of Object.entries(d.byGroup)) { const sc = key.split('|')[1] === 'scooter'; if (sc && v.rides) any = true; r += (v.rides || 0) * (sc ? k.k : 1); } return any ? r / d.coverage : null; };
  const rows = rep.daily.map(d => {
    const byOp = new Map(); for (const [key, v] of Object.entries(d.byGroup)) { const op = key.split('|')[0]; byOp.set(op, (byOp.get(op) || 0) + (v.fleet || 0)); }
    const ops = [...byOp].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([o, v]) => `${esc(o)} ${num(ctx, v)}`).join(' · ');
    const c = calDay(d);
    const rd = client && c != null ? `${num(ctx, c)}<div class="sub-line">E-Scooter kalibriert</div>` : `${num(ctx, d.ridesDay)}<div class="sub-line">${pctTxt(ctx, d.coverage, 0)} beobachtet${c != null ? ` · kalibriert ${num(ctx, c)}` : ''}</div>`;
    return `<tr><td>${R.WEEKDAYS[d.weekday]}, ${dd(d.day)}${d.full ? '' : '<div class="sub-line">kein voller Messtag</div>'}</td><td class="n">${num(ctx, d.obsHours, 1)} h</td><td class="n">${d.runs ?? '–'}</td><td class="n">${d.gapRuns || '–'}</td><td class="n">${num(ctx, d.fleet)}${ops ? `<div class="sub-line">${ops}</div>` : ''}</td>${client ? '' : `<td class="n">${num(ctx, d.rides)}</td>`}<td class="n">${rd}</td></tr>`;
  }).join('');
  return `<div class="tbl"><table><thead><tr><th>Tag</th><th class="n">Beobachtet</th><th class="n">Läufe</th><th class="n">Lücken-Läufe</th><th class="n">Ø Flotte · je Anbieter</th>${client ? '' : '<th class="n">Fahrten gemessen</th>'}<th class="n">Fahrten / Tag hochgerechnet</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
function cellSvgMarkup(cs, key, title) {
  const grid = cs.grid; if (!grid.length) return '';
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity, lat = 0;
  for (const c of grid) { if (c.i < i0) i0 = c.i; if (c.i > i1) i1 = c.i; if (c.j < j0) j0 = c.j; if (c.j > j1) j1 = c.j; lat += c.lat; }
  lat /= grid.length;
  const ky = R.CELL_LAT / (R.CELL_LON * Math.cos((lat * Math.PI) / 180)); // Zellen etwa quadratisch zeichnen
  const W = j1 - j0 + 1, H = (i1 - i0 + 1) * ky, g = 0.14;
  const rects = grid.map((c, n) => `<rect class="rp-s${R.suppressed(c[key]) ? 0 : R.heatClass(c[key], cs.max)}" x="${(c.j - j0 + g / 2).toFixed(2)}" y="${((i1 - c.i) * ky + g / 2).toFixed(2)}" width="${(1 - g).toFixed(2)}" height="${(ky - g).toFixed(2)}" data-i="${n}"/>`).join('');
  return `<svg class="rp-cellmap" viewBox="0 0 ${W} ${H.toFixed(2)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${title}: Raster mit ${grid.length} Zellen, Werte in der Tabelle" data-key="${key}">${rects}</svg>`;
}
function cellsSection(ctx, rep, s) {
  const cs = rep.cells; const { fmt } = ctx;
  if (!cs.n) return `<section class="rp-sec"><h3>Orte</h3>${emptyBox('Keine Zellen für den Zeitraum.', 'Zellendateien fehlen für diese Tage oder in der Gemeinde wurde nichts gezählt.')}</section>`;
  const filt = ctx.state.operator !== 'all' || ctx.state.type !== 'all';
  const strong = cs.strong.map((c, i) => `<tr><td class="n">${i + 1}</td><td>${cellLink(c)}</td><td class="n">${cnt(ctx, c.start)}</td><td class="n">${cnt(ctx, c.end)}</td><td class="n">${num(ctx, c.presAvg, 1)}</td></tr>`).join('');
  const weak = cs.weak.map((c, i) => `<tr><td class="n">${i + 1}</td><td>${cellLink(c)}</td><td class="n">${num(ctx, c.presAvg, 1)}</td><td class="n">${cnt(ctx, c.start)}</td><td class="n">${R.suppressed(c.start) ? '—' : num(ctx, c.perVehicle, 2)}</td></tr>`).join('');
  const k5 = R.heatClassFloor(5, cs.max);
  const top = [...cs.grid].sort((a, b) => (b.start + b.end) - (a.start + a.end)).slice(0, 30);
  const live = hasLeaflet();
  return `<section class="rp-sec"><h3>Orte: Start- und Zielverteilung</h3><div class="sub">Zellen ≈ 280 × 250 m · ${plural(cs.days, 'Tag', 'Tage')} · ${fmt(cs.n)} Zellen mit Bestand oder Bewegung · alle Anbieter und Fahrzeugarten · Datenschutz: Orte mit weniger als ${R.MIN_COUNT} Fahrten erscheinen als „< ${R.MIN_COUNT}“ (Schwelle wie Portland), damit keine einzelne Fahrt erkennbar ist</div>
    ${filt ? `<div class="note small rp-cellnote" role="note"><b>Filter wirkt hier nicht:</b> Die Zellen zählen alle Anbieter und Fahrzeugarten der Gemeinde (die Zellendateien des Sammlers sind nicht nach Anbieter getrennt). Die übrigen Abschnitte zeigen ${filterText(ctx)}.</div>` : ''}
    ${live ? `<p class="vh" id="rp-cm-desc">Karte mit ${fmt(cs.n)} Zellen auf OpenStreetMap; beide Karten bewegen sich gemeinsam. Pfeiltasten verschieben, Plus und Minus zoomen. Alle Werte stehen in der Tabelle unter „Als Tabelle“.</p>` : ''}
    <div class="rp-maps" data-rp="cellmaps">${cellMap(ctx, cs, 'start', 'Fahrtbeginne')}${cellMap(ctx, cs, 'end', 'Fahrtenden')}</div>
    <div class="rp-legend"><span>Fahrten je Zelle</span><span class="rp-ramp"><em>${R.MIN_COUNT}</em>${rampSpans()}<em>${num(ctx, cs.max)}</em></span><span class="muted">gestaucht: Mitte der Skala ≈ ${num(ctx, k5)}</span><span><i class="rp-sw rp-s0"></i>Bestand, weniger als ${R.MIN_COUNT} Fahrten (unterdrückt)</span>${live ? '<span class="muted">Karten gekoppelt · Zelle antippen oder überfahren für Werte</span>' : ''}
      <button type="button" class="rp-noprint" data-rp="cellscsv" title="Alle Zellen; Zählungen unter ${R.MIN_COUNT} als „<${R.MIN_COUNT}“">↓ Orte-CSV</button><button type="button" class="rp-noprint" data-rp="toggle" data-k="cells" aria-expanded="${s.show.cells ? 'true' : 'false'}">${s.show.cells ? 'Tabelle ausblenden' : 'Als Tabelle'}</button></div>
    <div class="tbl" data-rp-view="cells"${s.show.cells ? '' : ' hidden'} style="margin-top:var(--s2)"><table><thead><tr><th>Zelle (Mittelpunkt)</th><th class="n">Fahrtbeginne</th><th class="n">Fahrtenden</th><th class="n">Ø verfügbar je Lauf</th><th class="n">Umsetzungen</th></tr></thead><tbody>${top.map(c => `<tr><td>${cellLink(c)}</td><td class="n">${cnt(ctx, c.start)}</td><td class="n">${cnt(ctx, c.end)}</td><td class="n">${num(ctx, c.presAvg, 1)}</td><td class="n">${cnt(ctx, c.reloc)}</td></tr>`).join('')}</tbody></table></div>
    <div class="rp-grid2" style="margin-top:var(--s4)">
      <div><h3 style="font-size:13px;margin:0 0 var(--s1)">Stärkste Orte</h3><div class="sub small muted" style="margin-bottom:var(--s1)">meiste Fahrtbeginne</div><div class="tbl"><table><thead><tr><th class="n">#</th><th>Zelle</th><th class="n">Starts</th><th class="n">Ziele</th><th class="n">Ø verfügbar</th></tr></thead><tbody>${strong}</tbody></table></div></div>
      <div><h3 style="font-size:13px;margin:0 0 var(--s1)">Schwächste Orte</h3><div class="sub small muted" style="margin-bottom:var(--s1)">Bestand ≥ ${R.WEAK_MIN_PRESENT} verfügbare Fahrzeuge je Lauf, wenigste Starts je Fahrzeug</div><div class="tbl"><table><thead><tr><th class="n">#</th><th>Zelle</th><th class="n">Ø verfügbar</th><th class="n">Starts</th><th class="n">je Fahrzeug</th></tr></thead><tbody>${weak || '<tr><td colspan="5" class="empty">Keine Zelle mit genug Bestand.</td></tr>'}</tbody></table></div></div>
    </div></section>`;
}
function reportHtml(ctx, rep, meta, ref) {
  const { esc, fmt } = ctx; const t = rep.totals, q = rep.quality; const client = isClient();
  const k = meta.calib?.k, C = meta.cal?.applied ? meta.cal.totals : null;
  const pre = q.prelim ? ' · vorläufig' : '';
  const sources = (ctx.state.latest?.sources || []).filter(r => (r.municipalities || []).includes(rep.ags) && !['duplicate', 'retired'].includes(r.status));
  const srcTxt = sources.length ? `${sources.filter(r => r.status === 'live').length} aktuell, ${sources.filter(r => r.status === 'delayed').length} verzögert, ${sources.filter(r => !['live', 'delayed'].includes(r.status)).length} sonstige` : 'keine';
  const gaps = (ctx.state.latest?.gaps || []).filter(g => g.city === meta.name);
  const extra = [['Quellen in der Gemeinde', `${srcTxt} · Stand ${stamp(ctx.state.latest?.at)}`]];
  if (gaps.length) extra.push(['Anbieter ohne offenen Feed', gaps.map(g => `${esc(g.operator)}${g.since ? ` (seit ${dd(g.since)})` : ''}`).join(', ') + ' <span class="muted">– fehlen in allen Zahlen</span>']);
  if (meta.missing.length) extra.push([q.source === 'archiv' ? 'Tage ohne Archivwerte' : 'Tagesdateien fehlen', meta.missing.length > 8 ? `${plural(meta.missing.length, 'Tag', 'Tage')} (${meta.missing.slice(0, 4).map(dd).join(', ')} …)` : meta.missing.map(dd).join(', ')]);
  if (q.source === 'archiv') extra.push(['Zeitraum', `${esc(meta.period.kind)} ${esc(meta.period.label)} reicht über die 30 Tage der Tagesdateien hinaus: Tageswerte aus dem Langzeit-Archiv, ohne Orte, Dauer, Distanz und Sperrquote`]);
  if (meta.calib && rep.groups.some(g => g.ty === 'scooter')) extra.push(['Kalibrierung', calibText(ctx, meta.calib)]);
  // Kennzahlen mit Fahrten: kalibriert (E-Scooter × k) mit Spanne, gemessen daneben; Kundenansicht nur kalibriert
  const calTile = (label, v, lo, hi, d, measured, sub) => (C && v != null
    ? tile(label, num(ctx, v, d), `${client ? '' : `gemessen ${num(ctx, measured, d)} · `}Spanne ${num(ctx, lo, d)}–${num(ctx, hi, d)} · ${client ? 'kalibriert an amtlichen Berliner Zahlen' : `E-Scooter kalibriert (${esc(calibLabel(k))})`}${client ? '' : pre}`)
    : tile(label, num(ctx, measured, d), sub));
  const tiles = [
    tile('Ø Flotte', num(ctx, t.fleet), `Fahrzeuge im Feed inkl. gesperrter · ${plural(rep.groups.length, 'Anbieter/Art', 'Anbieter/Arten')}`),
    client ? '' : tile('Fahrten gemessen', num(ctx, t.rides), `in ${fmt(q.obsMin / 60, 1)} h Beobachtung${q.source === 'archiv' ? '' : ' (ohne Lücken-Stunden)'}`),
    calTile('Fahrten je Tag', C?.ridesDay, C?.lo, C?.hi, 0, t.ridesDay, `hochgerechnet über den ${q.source === 'archiv' ? 'beobachteten Anteil des Tages' : 'Tagesgang'}${pre}`),
    calTile('Fahrten je Fahrzeug und Tag', C?.rvd, C?.rvdLo, C?.rvdHi, 2, t.rvd, `Fahrten/Tag ÷ Ø Flotte${pre}`),
    q.source === 'archiv' ? '' : tile('Sperrquote', pctTxt(ctx, t.disabledShare), 'gesperrte Fahrzeuge am Bestand, Mittel der Läufe'),
    tile('Fahrzeuge je 1.000 EW', num(ctx, t.per1000Fleet, 1), rep.pop ? `${fmt(rep.pop)} Einwohner` : 'Einwohnerzahl fehlt'),
    calTile('Fahrten je 1.000 EW und Tag', C?.per1000Rides, C?.per1000Lo, C?.per1000Hi, 1, t.per1000Rides, rep.pop ? `hochgerechnet${pre}` : 'Einwohnerzahl fehlt'),
  ].join('');
  const per = meta.period && ['Quartal', 'Monat'].includes(meta.period.kind) ? `${esc(meta.period.kind)} ${esc(meta.period.label)} · ` : '';
  const calMethod = client ? (C ? ' E-Scooter-Fahrten sind an amtlichen Berliner Zahlen kalibriert und mit Spanne angegeben.' : '')
    : (C ? ` Kalibrierung: Gemessene E-Scooter-Fahrten unterschätzen die echten Fahrten (Fahrten zwischen zwei Abrufen, Kennungswechsel). Der Faktor ist das Verhältnis der amtlichen Berliner Fahrten je Fahrzeug und Tag zur eigenen Berliner Messung; er gilt für E-Scooter überall, die Spanne folgt aus dem kleinsten und größten Berliner Quartalswert. Räder und E-Bikes bleiben gemessen.` : '');
  return `<article class="rp-report" aria-label="Kommunal-Bericht ${esc(meta.name)}">
    <header class="rp-head"><div><div class="rp-kicker">Kommunal-Bericht · Sharing-Mobilität</div><h2>${esc(meta.name)}<small>AGS ${esc(rep.ags)}${rep.pop ? ` · ${fmt(rep.pop)} Einwohner` : ''}</small></h2>
      <p class="sub">${per}Zeitraum ${dd(rep.from)}${rep.to !== rep.from ? `–${dd(rep.to)}` : ''} (${plural(rep.days.length, 'Tag', 'Tage')}) · ${filterText(ctx)} · Datenstand ${stamp(ctx.state.latest?.at)} · erstellt ${stamp(Date.now())}</p></div>
      ${q.prelim ? `<span class="pill prelim" title="Erst ${q.fullDays} volle Messtage; ab ${R.MIN_FULL_DAYS} gilt der Bericht als belastbar">vorläufig</span>` : '<span class="pill plain">belastbar</span>'}</header>
    <section class="rp-sec"><h3>Datenqualität</h3>${qualityBlock(ctx, rep, extra)}</section>
    <section class="rp-sec"><h3>Kennzahlen</h3><div class="sub">Gliederung nach der Kennzahlenliste für Kommunen (MobiData BW); Fahrt = gemessener Fahrtbeginn${C ? (client ? '; E-Scooter-Fahrten kalibriert an amtlichen Berliner Zahlen' : '; Fahrten-Kennzahlen kalibriert, gemessener Wert darunter') : ''}</div><div class="tiles">${tiles}</div></section>
    <section class="rp-sec"><h3>Je Anbieter und Fahrzeugart</h3><div class="sub">Mittel über den Zeitraum; Flotte mit Spanne der Tageswerte</div>${groupTable(ctx, rep, meta.cal)}</section>
    <section class="rp-sec"><h3>Tageswerte</h3><div class="sub">Flotte täglich, Beobachtung und Lücken je Tag</div>${dailyTable(ctx, rep, k)}</section>
    ${q.source === 'archiv' ? '' : cellsSection(ctx, rep, meta.s)}
    ${referenceRows(ctx, ref, rep, meta.cal)}
    <footer class="rp-sec small muted"><h3>Methode</h3><p style="margin:0 0 var(--s1)">Grundlage sind die offenen Live-Feeds (GBFS) der Anbieter, abgerufen etwa alle 20 Minuten. Eine Fahrt beginnt, wenn ein verfügbares Fahrzeug aus dem Feed verschwindet (wechselnde Kennungen) oder bei gleicher Kennung über 150 m versetzt auftaucht. Kennungswechsel am selben Ort (≤ 40 m), Umsetzungen durch den Betreiber und Abholungen gesperrter oder fast leerer Fahrzeuge zählen nicht als Fahrt. Läufe mit mehr als 45 Minuten Abstand zum vorigen (Lücken) und ihre Stunden gehen nicht in die Fahrten ein.</p><p style="margin:0">Fahrten je Tag sind gemessene Fahrten geteilt durch den beobachteten Anteil des typischen Tagesgangs.${calMethod} Anbieter ohne offenen Feed fehlen. Mobility Pulse · ${esc(ctx.CFG.REPO || '')}</p></footer>
  </article>`;
}
function reportControls(ctx, s, days, archDays = []) {
  const opts = periodOptions(days, archDays);
  if (!opts.some(([v]) => v === s.period)) s.period = 'all';
  return `<div class="rp-ctl rp-noprint"><label>Zeitraum <select data-rp="period">${opts.map(([v, l]) => `<option value="${ctx.esc(v)}"${v === s.period ? ' selected' : ''}>${ctx.esc(l)}</option>`).join('')}</select></label>
    <button type="button" data-rp="print" title="Nur den Bericht drucken oder als PDF sichern">Drucken / PDF</button><button type="button" data-rp="csv" title="Tageswerte und Zeitraumwerte je Anbieter und Fahrzeugart, gemessen und kalibriert">↓ CSV</button></div>`;
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
    el.addEventListener('change', (e) => { if (e.target.matches('[data-rp="period"]')) { s.period = e.target.value; renderReport(el, s.ctx); } });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-rp]'); if (!b) return;
      if (b.dataset.rp === 'print') printReport(el);
      else if (b.dataset.rp === 'csv') reportCsv(el);
      else if (b.dataset.rp === 'cellscsv') { const r = s.rep; if (r) download(`orte_${r.ags}_${r.from}_${r.to}.csv`, R.toCsv(R.cellsCsvRows(r.cells, { ags: r.ags, name: s.meta?.name, from: r.from, to: r.to }))); }
      else if (b.dataset.rp === 'toggle') { const k = b.dataset.k; s.show[k] = !s.show[k]; const v = el.querySelector(`[data-rp-view="${k}"]`); if (v) v.hidden = !s.show[k]; b.setAttribute('aria-expanded', String(!!s.show[k])); b.textContent = s.show[k] ? 'Tabelle ausblenden' : 'Als Tabelle'; }
    });
    bindCellTips(el);
  });
  const title = head('Kommunal-Bericht', 'Druckbarer Bericht je Gemeinde: Flotte, Fahrten, Orte und Datenqualität im gewählten Zeitraum');
  const put = (html) => { unmountCellMaps(s); el.innerHTML = html; }; // Karten vor dem Ersetzen abbauen (Leaflet hält sonst Ereignisse und Kacheln)
  if (!state.latest) { put(title + emptyBox('Noch kein Datenstand.', 'Der Bericht erscheint, sobald der Sammler-Stand geladen ist.')); return; }
  if (!state.scope || state.scope === 'DE') { put(title + emptyBox('Gemeinde wählen.', 'Der Bericht gilt je Gemeinde: oben unter „Gebiet“ eine Gemeinde auswählen.')); return; }
  const tok = ++s.tok; el.classList.add('rp-busy');
  if (!el.querySelector('.rp-report')) put(title + '<div class="muted small">Bericht wird zusammengestellt …</div>');
  try {
    const ags = state.scope, m = state.latest.municipalities?.[ags] || {};
    const name = m.name || ctx.muniName?.(ags) || ags;
    const [idx, archDays] = await Promise.all([usageIndex(ctx), archiveDayList(ctx).catch(() => [])]); const all = (idx.days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (tok !== s.tok) return;
    if (!all.length) { put(title + emptyBox('Noch keine Tagesdateien.', 'Der Bericht braucht gemessene Bewegungen; sie entstehen ab dem zweiten Sammler-Lauf.')); return; }
    if (!periodOptions(all, archDays).some(([v]) => v === s.period)) s.period = 'all';
    const days = pickDays(all, s.period, archDays);
    const useArchive = days.some(d => !all.includes(d));
    let rep, missing, ref;
    const calibP = loadCalibration(ctx); const limits = (await calibP).limits || null; if (tok !== s.tok) return;
    if (useArchive) {
      const [{ archive, fields }, r] = await Promise.all([archiveFor(ctx, days), reference(ctx)]); ref = r;
      if (tok !== s.tok) return;
      rep = R.archiveReport({ archive, fields, ags, pop: m.pop || null, operator: state.operator, type: state.type, days, rvdLimit: limits });
      missing = days.filter(d => !archive[d]);
    } else {
      const [hidx, daily] = await Promise.all([histIndex(ctx), dailyDoc(ctx)]);
      const [docs, hists, cdocs, r] = await Promise.all([
        Promise.all(days.map(d => eventsDoc(ctx, idx, d))), Promise.all(days.map(d => histFor(ctx, hidx, daily, d))), Promise.all(days.map(d => cellsDoc(ctx, idx, d, m.state))), reference(ctx)]);
      ref = r;
      if (tok !== s.tok) return;
      const cells = {}, cellRuns = {};
      days.forEach((d, i) => { const c = cdocs[i]; if (c?.munis) { cells[d] = c.munis[ags] || {}; cellRuns[d] = sum(c.bandRuns) || (docs[i]?.runs || []).length; } });
      rep = R.municipalReport({ docs: docs.filter(Boolean), hists: Object.fromEntries(days.map((d, i) => [d, hists[i]]).filter(x => x[1])), cells, cellRuns, ags, pop: m.pop || null, operator: state.operator, type: state.type, latestGroups: state.latest.groups, rvdLimit: limits });
      missing = days.filter((d, i) => !docs[i]);
    }
    const calib = await calibP; if (tok !== s.tok) return;
    const cal = K.calibrateReport(rep, calib.k);
    const meta = { name, missing, s, calib, cal, period: periodInfo(s.period), archive: useArchive };
    s.rep = rep; s.meta = meta;
    put(head('Kommunal-Bericht', `Druckbarer Bericht je Gemeinde · ${esc(name)}`, reportControls(ctx, s, all, archDays)) + reportHtml(ctx, rep, meta, ref));
    mountCellMaps(el, s);
  } catch (e) {
    console.error('Bericht', e);
    if (tok === s.tok) put(title + emptyBox('Bericht nicht erstellbar.', 'Daten nicht ladbar – Seite später neu laden.'));
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
    showTip(box, r, `${m(c[key])} ${key === 'start' ? 'Fahrtbeginne' : 'Fahrtenden'}`, [`${m(c[key === 'start' ? 'end' : 'start'])} ${key === 'start' ? 'Fahrtenden' : 'Fahrtbeginne'} · Ø ${c.presAvg == null ? '—' : fmt(c.presAvg, 1)} verfügbar je Lauf`, `Zelle ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`]);
  });
  el.addEventListener('pointerleave', () => { el.querySelectorAll('.rp-chart').forEach(hideTip); el.querySelectorAll('svg.rp-cellmap rect.on').forEach(x => x.classList.remove('on')); });
}

// ---------- Zellkarten auf OpenStreetMap (Leaflet) ----------
// Zwei Karten (Fahrtbeginne, Fahrtenden), gekoppelt: die zuletzt bediente Karte führt, die andere folgt ohne eigene Animation.
// Zellen als halbtransparente Rechtecke auf einem Canvas-Renderer in den Farben der Skala; Kacheln entsättigt (dunkles Thema: invertiert),
// damit die Skala lesbar bleibt. Tooltip je Zelle beim Überfahren oder Antippen; Werte für alle Zellen in der Tabelle.
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';
const CELL_FILL = 0.72; // Deckkraft der Zellen über der Karte
const hasLeaflet = () => typeof window !== 'undefined' && !!window.L && typeof window.L.map === 'function';
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// Skala als Zahlen (gleiche Anteile wie --rp-seq-0…8 im CSS): Akzentfarbe in OKLab mit der Fläche gemischt
const SEQ_P = [7, 16, 27, 38, 49, 60, 72, 85, 100];
const hexRgb = (h) => { const m = String(h || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i); if (!m) return null; let s = m[1]; if (s.length === 3) s = [...s].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4), unlin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function toOklab([r, g, b]) {
  [r, g, b] = [r, g, b].map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map(c => Math.round(Math.max(0, Math.min(1, unlin(c))) * 255).toString(16).padStart(2, '0')).join('')}`;
}
function rampColors(accent, panel) {
  const A = hexRgb(accent), P = hexRgb(panel); if (!A || !P) return SEQ_P.map(() => accent || '#0f766e');
  const a = toOklab(A), p = toOklab(P);
  return SEQ_P.map(q => fromOklab(a.map((x, i) => x * (q / 100) + p[i] * (1 - q / 100))));
}
const cssVar = (el, name, d) => (getComputedStyle(el).getPropertyValue(name) || '').trim() || d;
const PRINT_ACCENT = '#0f766e', PRINT_PANEL = '#ffffff'; // helle Werte wie @media print in index.html
const cellBounds = (c) => [[c.lat - R.CELL_LAT / 2, c.lon - R.CELL_LON / 2], [c.lat + R.CELL_LAT / 2, c.lon + R.CELL_LON / 2]];
const cellClass = (c, key, max) => (R.suppressed(c[key]) ? 0 : R.heatClass(c[key], max));
function unmountCellMaps(s) {
  if (s.cellMaps?.length && s.cellMapsAgs) { const v = s.cellMaps[0].map; try { if (v.getSize().x) s.cellView = { ags: s.cellMapsAgs, center: v.getCenter(), zoom: v.getZoom() }; } catch { /* Karte ohne Ansicht */ } }
  for (const m of s.cellMaps || []) { try { m.ro?.disconnect(); m.map.remove(); } catch { /* bereits entfernt */ } }
  s.cellMaps = [];
}
function mountCellMaps(el, s) {
  unmountCellMaps(s);
  const boxes = [...el.querySelectorAll('.rp-report div.rp-cellmap[data-key]')]; const cs = s.rep?.cells;
  if (!boxes.length || !hasLeaflet() || !cs?.grid?.length) return;
  const L = window.L, still = reducedMotion(), { fmt } = s.ctx;
  const colors = rampColors(cssVar(el, '--accent', PRINT_ACCENT), cssVar(el, '--panel', PRINT_PANEL)), ink = cssVar(el, '--fg', '#111820');
  const idx = new Map(cs.grid.map((c, n) => [`${c.i}:${c.j}`, n]));
  const all = L.latLngBounds(cs.grid.flatMap(cellBounds));
  const maps = boxes.map(box => {
    const key = box.dataset.key;
    const map = L.map(box, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false, zoomSnap: 0.5, zoomDelta: 0.5,
      zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still, inertia: !still, minZoom: 8, maxZoom: 18 });
    const tiles = L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR, crossOrigin: 'anonymous' }).addTo(map);
    const renderer = L.canvas({ padding: 0.3 });
    for (const c of cs.grid) L.rectangle(cellBounds(c), { renderer, stroke: false, fillColor: colors[cellClass(c, key, cs.max)], fillOpacity: CELL_FILL, interactive: false }).addTo(map);
    const hi = L.rectangle(cellBounds(cs.grid[0]), { renderer, interactive: false, fill: false, color: ink, weight: 2, opacity: 0 }).addTo(map);
    return { map, key, box, tiles, hi };
  });
  const keep = s.cellView?.ags === s.rep.ags ? s.cellView : null;
  for (const m of maps) { if (keep) m.map.setView(keep.center, keep.zoom, { animate: false }); else m.map.fitBounds(all, { padding: [8, 8], animate: false }); }
  // Kopplung: die zuletzt bediente Karte gibt Mitte und Zoom vor
  let lead = maps[0];
  const follow = (src, center, zoom, anim) => { for (const m of maps) { if (m === src) continue; const c = m.map.getCenter(); if (m.map.getZoom() === zoom && Math.abs(c.lat - center.lat) < 1e-9 && Math.abs(c.lng - center.lng) < 1e-9) continue; m.map.setView(center, zoom, { animate: anim && !still }); } };
  for (const m of maps) {
    for (const ev of ['pointerdown', 'wheel', 'focusin', 'mouseenter', 'touchstart']) m.box.addEventListener(ev, () => { lead = m; }, { passive: true });
    m.map.on('move', () => { if (lead === m && !m.map._animatingZoom) follow(m, m.map.getCenter(), m.map.getZoom(), false); });
    m.map.on('zoomanim', (e) => { if (lead === m) follow(m, e.center, e.zoom, true); });
    m.map.on('zoomend moveend', () => { if (lead === m) follow(m, m.map.getCenter(), m.map.getZoom(), false); });
  }
  // Tooltip je Zelle (Überfahren, Antippen), Markierung derselben Zelle in beiden Karten
  const hide = () => { for (const m of maps) { m.hi.setStyle({ opacity: 0 }); const b = m.box.closest('.rp-chart'); if (b) hideTip(b); } };
  const show = (m, latlng) => {
    const n = idx.get(`${Math.round(latlng.lat / R.CELL_LAT)}:${Math.round(latlng.lng / R.CELL_LON)}`); const c = n == null ? null : cs.grid[n];
    if (!c) { hide(); return; }
    for (const x of maps) { x.hi.setBounds(cellBounds(c)); x.hi.setStyle({ opacity: 1 }); if (x !== m) { const b = x.box.closest('.rp-chart'); if (b) hideTip(b); } }
    const key = m.key, other = key === 'start' ? 'end' : 'start', v = (x) => (R.suppressed(x) ? `< ${R.MIN_COUNT}` : fmt(x));
    const p = m.map.latLngToContainerPoint([c.lat + R.CELL_LAT / 2, c.lon]);
    showTipAt(m.box.closest('.rp-chart'), p.x, p.y, `${v(c[key])} ${key === 'start' ? 'Fahrtbeginne' : 'Fahrtenden'}`, [`${v(c[other])} ${other === 'start' ? 'Fahrtbeginne' : 'Fahrtenden'} · Ø ${c.presAvg == null ? '—' : fmt(c.presAvg, 1)} verfügbar je Lauf`, `Zelle ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`]);
  };
  for (const m of maps) {
    m.map.on('mousemove', (e) => show(m, e.latlng)); m.map.on('click', (e) => show(m, e.latlng));
    m.map.on('mouseout movestart zoomstart', hide);
    // Größe ändert sich (Fenster, Spaltenumbruch, Ansicht erst später sichtbar): Kartengröße nachziehen
    if (typeof ResizeObserver === 'function') { let w0 = m.box.clientWidth, h0 = m.box.clientHeight; m.ro = new ResizeObserver(() => { const w = m.box.clientWidth, h = m.box.clientHeight; if (w === w0 && h === h0) return; const was = !w0; w0 = w; h0 = h; m.map.invalidateSize({ animate: false }); if (was && w && !keep) m.map.fitBounds(all, { padding: [8, 8], animate: false }); }); m.ro.observe(m.box); }
  }
  s.cellMaps = maps; s.cellMapsAgs = s.rep.ags;
}
// Tooltip an einer Stelle im Diagrammkasten (Kartenpunkt), sonst wie showTip
function showTipAt(box, px, py, value, label) {
  if (!box) return;
  const t = tip(box); t.replaceChildren(); const b = document.createElement('b'); b.textContent = value; t.append(b);
  for (const l of [].concat(label || [])) { const d = document.createElement('div'); d.textContent = l; t.append(d); }
  t.hidden = false;
  const w = box.getBoundingClientRect();
  const x = Math.max(t.offsetWidth / 2 + 4, Math.min(w.width - t.offsetWidth / 2 - 4, px));
  let y = py; if (y - t.offsetHeight - 10 < 0) y = py + t.offsetHeight + 24;
  t.style.left = `${x}px`; t.style.top = `${y}px`;
}
// Druck: Kacheln abwarten (höchstens ms), dann Karte + Zellen in hellen Druckfarben als Bild; ohne Freigabe der Kacheln (CORS) null
function tilesSettled(tiles, ms = 4000) {
  return new Promise(res => { if (!tiles?.isLoading?.()) { res(); return; } const done = () => { clearTimeout(t); tiles.off('load', done); res(); }; const t = setTimeout(done, ms); tiles.on('load', done); });
}
async function cellMapImage(m, cs) {
  const W = m.box.clientWidth, H = m.box.clientHeight; if (!W || !H) return null;
  await tilesSettled(m.tiles);
  const k = 2, cv = document.createElement('canvas'); cv.width = W * k; cv.height = H * k;
  const g = cv.getContext('2d'); if (!g) return null; g.scale(k, k);
  g.fillStyle = '#eef1f4'; g.fillRect(0, 0, W, H);
  const br = m.box.getBoundingClientRect(); let tiles = 0;
  g.save(); if ('filter' in g) g.filter = 'grayscale(1) contrast(.92) brightness(1.04)';
  for (const img of m.box.querySelectorAll('.leaflet-tile-pane img.leaflet-tile-loaded')) { const r = img.getBoundingClientRect(); if (r.right < br.left || r.left > br.right || r.bottom < br.top || r.top > br.bottom) continue; try { g.drawImage(img, r.left - br.left, r.top - br.top, r.width, r.height); tiles++; } catch { /* Kachel nicht zeichenbar */ } }
  g.restore();
  const colors = rampColors(PRINT_ACCENT, PRINT_PANEL); g.globalAlpha = CELL_FILL;
  for (const c of cs.grid) { const [[s0, w0], [n0, e0]] = cellBounds(c); const a = m.map.latLngToContainerPoint([n0, w0]), b = m.map.latLngToContainerPoint([s0, e0]); if (b.x < 0 || a.x > W || b.y < 0 || a.y > H) continue; g.fillStyle = colors[cellClass(c, m.key, cs.max)]; g.fillRect(a.x, a.y, Math.max(0.5, b.x - a.x), Math.max(0.5, b.y - a.y)); }
  g.globalAlpha = 1;
  const note = '© OpenStreetMap-Mitwirkende'; g.font = '10px system-ui, sans-serif'; const tw = g.measureText(note).width;
  g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(W - tw - 10, H - 16, tw + 10, 16); g.fillStyle = '#3b4855'; g.fillText(note, W - tw - 5, H - 4.5);
  try { return tiles ? cv.toDataURL('image/png') : null; } catch { return null; } // Kacheln ohne CORS-Freigabe: Canvas gesperrt → Rückfall
}
function reportCsv(el) {
  const s = st(el); if (!s.rep) return;
  const rows = R.reportCsvRows(s.rep, { name: s.meta.name, typeLabel: typeName, cal: s.meta.cal, calLabel: calibLabel(s.meta.calib?.k), period: s.meta.period });
  const per = s.meta.period?.key ? `${s.meta.period.key}_` : '';
  download(`kommunal-bericht_${s.rep.ags}_${per}${s.rep.from}_${s.rep.to}.csv`, R.toCsv(rows));
}
/**
 * Nur den Bericht drucken: Kopie als oberstes Element, alles andere per @media print ausgeblendet; nach dem Druck aufräumen.
 * Zellkarten: Kacheln laden abwarten (höchstens 4 s) und Karte samt Zellen als Bild einsetzen (eine geklonte Leaflet-Karte druckt keine
 * Canvas-Zellen); sind die Kacheln nicht zeichenbar, druckt das Zellraster ohne Kartenhintergrund mit Hinweis.
 */
export async function printReport(el) {
  const art = el?.querySelector('.rp-report'); if (!art) return;
  const s = st(el); const btn = el.querySelector('button[data-rp="print"]');
  if (s.printing) return; s.printing = true;
  if (btn) { btn.setAttribute('aria-busy', 'true'); btn.dataset.label = btn.textContent; btn.textContent = 'Karten werden vorbereitet …'; }
  let shots = [];
  try { shots = await Promise.all((s.cellMaps || []).map(m => cellMapImage(m, s.rep.cells).catch(() => null))); } catch { shots = []; }
  if (btn) { btn.removeAttribute('aria-busy'); btn.textContent = btn.dataset.label || 'Drucken / PDF'; }
  s.printing = false;
  document.querySelectorAll('.rp-print-root').forEach(n => n.remove());
  const root = document.createElement('div'); root.className = 'rp-print-root rp-root';
  root.appendChild(art.cloneNode(true)); root.querySelectorAll('.rp-tip,.rp-noprint').forEach(n => n.remove());
  root.querySelectorAll('[id]').forEach(n => n.removeAttribute('id')); // keine doppelten IDs neben dem Original
  root.querySelectorAll('div.rp-cellmap[data-key]').forEach((box, i) => {
    const key = box.dataset.key, url = shots[i], fig = box.closest('.rp-fig'); const title = fig?.querySelector('figcaption')?.textContent || '';
    const host = box.closest('.rp-chart') || box;
    if (url) { const img = document.createElement('img'); img.className = 'rp-cellmap-img'; img.alt = `${title}: Zellen auf OpenStreetMap`; img.src = url; host.replaceChildren(img); }
    else if (s.rep?.cells) { host.innerHTML = cellSvgMarkup(s.rep.cells, key, title) + '<div class="small muted">Kartenhintergrund nicht druckbar (Kacheln nicht geladen); Zellen ohne Karte.</div>'; }
  });
  document.body.appendChild(root); document.body.classList.add('rp-printing');
  const title = document.title; document.title = `Kommunal-Bericht ${s.meta?.name || ''} ${s.rep?.from || ''}${s.rep?.to && s.rep.to !== s.rep.from ? ` bis ${s.rep.to}` : ''}`.trim();
  let done = false;
  const end = () => { if (done) return; done = true; document.body.classList.remove('rp-printing'); root.remove(); document.title = title; window.removeEventListener('afterprint', end); };
  window.addEventListener('afterprint', end);
  setTimeout(end, 120e3); // Browser ohne afterprint
  await Promise.all([...root.querySelectorAll('img')].map(i => (i.decode ? i.decode().catch(() => {}) : null)));
  window.print();
}

// ======================================================================
// 2. Obergrenzen-Wächter
// ======================================================================
function meter(ctx, value, limit, status) {
  const dom = Math.max(limit || 0, value || 0) || 1; const w = Math.min(100, ((value || 0) / dom) * 100);
  return `<div class="rp-meter ${status}" role="img" aria-label="${ctx.fmt(value)} von ${ctx.fmt(limit)}"><i style="width:${w.toFixed(1)}%"></i>${value > limit ? `<b style="left:${((limit / dom) * 100).toFixed(1)}%" title="Obergrenze"></b>` : ''}</div>`;
}
// Dauer als Text: „40 Min.“, „3,3 Std.“, „1,5 Tage“
const durTxt = (ctx, ms) => (!ms ? '–' : ms < 3600e3 ? `${ctx.fmt(ms / 60e3)} Min.` : ms < 48 * 3600e3 ? `${ctx.fmt(ms / 3600e3, 1)} Std.` : `${ctx.fmt(ms / 86400e3, 1)} Tage`);
// Verlauf: Tagesmaximum gesamt als schmale Balken, Obergrenze als gestrichelte Linie; Tooltip je Tag, Tabelle als Alternative
function capChart(ctx, v, c) {
  const pts = v.daily.filter(d => d.max != null); if (!pts.length) return '';
  const limit = c.limit || Math.max(...pts.map(d => d.limit || 0)) || null;
  const W = 900, H = 150, P = { l: 52, r: 12, t: 12, b: 26 };
  const first = Date.parse(`${pts[0].day}T12:00:00Z`), last = Date.parse(`${pts[pts.length - 1].day}T12:00:00Z`); const n = Math.max(30, Math.round((last - first) / 86400e3) + 1);
  const slot = (W - P.l - P.r) / n, bw = Math.max(3, Math.min(16, slot * 0.62));
  const ymax = Math.max(limit || 0, ...pts.map(d => d.max)) * 1.08 || 1;
  const Y = (x) => P.t + (1 - x / ymax) * (H - P.t - P.b);
  const xi = (d) => Math.round((Date.parse(`${d}T12:00:00Z`) - (last - (n - 1) * 86400e3)) / 86400e3);
  const bars = pts.map((d, i) => { const x = P.l + xi(d.day) * slot + (slot - bw) / 2, y = Y(d.max), y0 = Y(0), r = Math.min(4, bw / 2, y0 - y);
    const path = y0 - y < 0.5 ? '' : `<path class="bar" d="M${x.toFixed(1)},${y0.toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)},${y.toFixed(1)} ${(x + bw).toFixed(1)},${(y + r).toFixed(1)}V${y0.toFixed(1)}Z"/>`;
    return `<g data-i="${i}"><rect class="hit" x="${(P.l + xi(d.day) * slot).toFixed(1)}" y="${P.t}" width="${slot.toFixed(1)}" height="${H - P.t - P.b}"/>${path}</g>`; }).join('');
  const lim = limit ? `<line class="lim" x1="${P.l}" x2="${W - P.r}" y1="${Y(limit).toFixed(1)}" y2="${Y(limit).toFixed(1)}"/><text x="${P.l - 6}" y="${(Y(limit) + 3.5).toFixed(1)}" text-anchor="end">${ctx.fmt(limit)}</text>` : '';
  const ax = `<line class="base" x1="${P.l}" x2="${W - P.r}" y1="${Y(0)}" y2="${Y(0)}"/><text x="${P.l - 6}" y="${Y(0) + 3.5}" text-anchor="end">0</text><text x="${P.l}" y="${H - 6}">${dd(new Date(last - (n - 1) * 86400e3).toISOString().slice(0, 10)).slice(0, 6)}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end">${dd(pts[pts.length - 1].day).slice(0, 6)}</text>`;
  return `<div class="rp-chart" data-rp="capchart" data-ags="${ctx.esc(v.ags)}"><svg class="rp-line rp-bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tagesmaximum des Bestands an ${pts.length} Tagen gegen die Obergrenze ${limit ? ctx.fmt(limit) : ''}; Werte auch als Tabelle">${ax}${lim}<g>${bars}</g></svg></div>
    <div class="rp-legend"><span><i class="rp-sw" style="--rp-f:var(--accent)"></i>höchster Bestand je Tag (alle Anbieter)</span>${limit ? `<span><i class="rp-key" style="--c:var(--fg-2)"></i>Obergrenze gesamt ${ctx.fmt(limit)}</span>` : ''}</div>`;
}
function violationsBlock(ctx, c, v, s) {
  const { esc, fmt, opColor } = ctx;
  const h = `<h3 style="font-size:13px;margin:var(--s2) 0 var(--s1)">Verstöße der letzten 30 Tage</h3>`;
  if (v === undefined) return h + `<div class="muted small">Noch kein Protokoll: caps-log.json entsteht mit dem nächsten Sammler-Lauf. Danach prüft der Sammler die Grenzen bei jedem Lauf und hält Läufe ab ${R.NEAR_CAP * 100} % der Grenze fest.</div>`;
  if (!v) return h + '<div class="muted small">Für diese Gemeinde enthält das Protokoll noch keine Prüfung.</div>';
  const ops = v.ops.filter(o => o.overRuns || o.nearRuns);
  const name = (op) => (op === '*' ? '<b>gesamt</b>' : `<span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span>`);
  const rows = ops.map(o => `<tr><td>${name(o.op)}</td><td class="n">${o.overRuns ? `${badge('over')} ${durTxt(ctx, o.overMs)}<div class="sub-line">${plural(o.overRuns, 'Lauf', 'Läufe')}</div>` : '<span class="muted">–</span>'}</td><td class="n">${o.nearRuns ? `${durTxt(ctx, o.nearMs)}<div class="sub-line">${plural(o.nearRuns, 'Lauf', 'Läufe')}</div>` : '<span class="muted">–</span>'}</td><td class="n"><b>${fmt(o.peak)}</b><div class="sub-line">${stamp(o.peakAt)}</div></td><td class="n">${fmt(o.limit)}</td><td class="n">${o.lastOverAt ? stamp(o.lastOverAt) : '–'}</td></tr>`).join('');
  const days = v.daily.length;
  const table = ops.length ? `<div class="tbl" tabindex="0" role="region" aria-label="Verstöße ${esc(v.ort)}"><table><thead><tr><th>Anbieter</th><th class="n">über der Grenze</th><th class="n">nahe (≥ ${R.NEAR_CAP * 100} %)</th><th class="n">Spitzenwert</th><th class="n">Grenze</th><th class="n">zuletzt über</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="muted small">Keine Überschreitung und kein Lauf ab ${R.NEAR_CAP * 100} % der Grenze in ${plural(days || 0, 'protokolliertem Tag', 'protokollierten Tagen')}.</div>`;
  const tbl = s.show[`cap:${v.ags}`];
  const btn = v.daily.length ? `<button type="button" class="rp-noprint" data-rp="captable" data-ags="${esc(v.ags)}" aria-expanded="${tbl ? 'true' : 'false'}">${tbl ? 'Als Diagramm' : 'Verlauf als Tabelle'}</button>` : '';
  const hist = !v.daily.length ? '' : tbl ? `<div class="tbl" tabindex="0" role="region" aria-label="Tagesmaximum ${esc(v.ort)}"><table><thead><tr><th>Tag</th><th class="n">höchster Bestand</th><th class="n">Grenze</th><th>Status</th></tr></thead><tbody>${v.daily.slice().reverse().map(d => `<tr><td>${dd(d.day)}</td><td class="n">${fmt(d.max)}</td><td class="n">${d.limit != null ? fmt(d.limit) : '—'}</td><td>${badge(R.capStatus(d.max, d.limit).status)}</td></tr>`).join('')}</tbody></table></div>` : capChart(ctx, v, c);
  return h + `<div class="sub small muted" style="margin-bottom:var(--s1)">Dauer = Summe der Abrufabstände, in denen der Bestand über der Grenze lag (je Lauf höchstens 45 Min.) · ${plural(days, 'Tag', 'Tage')} im Verlauf ${btn}</div>` + table + hist;
}
function capBlock(ctx, c, rep, pop, viol = undefined, s = { show: {} }) {
  const { fmt, esc, opColor } = ctx;
  const hasTotal = c.limit != null;
  const limTxt = hasTotal ? `${fmt(c.limit)}${c.limitDerived ? ` (${DERIVED_TXT})` : ''}` : '—';
  const hist = c.previous != null ? `bis ${dd(new Date(Date.parse(`${c.since}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10))}: ${fmt(c.previous)}` : c.next ? `ab ${dd(c.next.from)}: ${fmt(c.next.limit)}` : '';
  // Verfügbar ÷ erlaubt: buchbar ÷ Grenze je Anbieter; ohne Grenze je Anbieter Anteil an der Gesamtgrenze; ohne Zulassung laut Quelle: keine Rate
  const own = (o) => o.limit != null;
  const rate = (o, f) => (o.licensed === false ? null : own(o) ? o[f] : f === 'availShare' ? o.capShareAvail : o.capShare);
  const derivedOf = (o) => (own(o) ? o.derived : c.limitDerived);
  const shareNote = (o) => (o.licensed === false || own(o) ? '' : hasTotal ? '<div class="sub-line">Anteil an der Gesamtgrenze</div>' : '');
  const limCell = (o) => (o.licensed === false ? '—' : own(o) ? `${fmt(o.limit)}${o.derived ? `<div class="sub-line">${DERIVED_TXT}</div>` : ''}` : '—');
  const meterCell = (o) => (o.licensed === false ? `<span class="muted small">nicht in der Anbieterliste der Quelle</span>` : own(o) ? meter(ctx, o.total, o.limit, o.status === 'hint' ? 'near' : o.status) : '<span class="muted small">keine Grenze je Anbieter</span>');
  const ops = c.operators.map(o => `<tr><td><span class="op"><i style="background:${opColor(o.op)}"></i>${esc(o.op)}</span></td><td class="n">${fmt(o.total)}</td><td class="n">${fmt(o.disabled)}</td><td class="n">${fmt(o.available)}</td><td class="n">${limCell(o)}</td><td style="min-width:120px">${meterCell(o)}</td><td class="n">${rateCell(ctx, rate(o, 'share'), false, derivedOf(o))}${shareNote(o)}</td><td class="n">${rateCell(ctx, rate(o, 'availShare'), false, derivedOf(o))}${shareNote(o)}</td><td>${badge(o.licensed === false ? 'unlicensed' : own(o) ? o.status : 'unknown')}</td></tr>`).join('');
  const zoneNum = (d) => [d.limit != null ? `gesamt ${fmt(d.limit)}` : null, d.perOperator != null ? `je Anbieter ${fmt(d.perOperator)}${d.perOperatorDerived ? ` (${DERIVED_TXT})` : ''}` : null].filter(Boolean).join(' · ') || '—';
  const districts = c.districts.map(d => `<tr><td>${esc(d.label)}</td><td class="n">${zoneNum(d)}</td><td>${badge('unchecked')}</td><td class="small muted">${d.hinweis ? `${esc(d.hinweis)} · ` : ''}nicht prüfbar ohne Gebietsgrenze – der Feed nennt nur Koordinaten, die Grenze des Teilgebiets fehlt im Datenstand</td></tr>`).join('');
  const per1000 = pop ? (c.total / pop) * 1000 : null;
  const pre = rep?.quality.prelim ? ' · vorläufig' : '';
  const links = [safeLink(ctx, c.url, c.quelle || 'Quelle'), ...(c.links || []).map((l, i) => safeLink(ctx, l.url, l.quelle || `Quelle ${i + 2}`))].join(' · ');
  const listTxt = c.listed ? ` · Anbieter laut Quelle: ${esc(c.listed.join(', '))}${c.listComplete ? '' : ' (Liste unvollständig, keine Zulassungsprüfung)'}` : '';
  const head = hasTotal
    ? `<div class="rp-cap-total"><div>${meter(ctx, c.total, c.limit, c.status === 'hint' ? 'near' : c.status)}</div><div><span class="big">${fmt(c.total)}</span> <span class="muted">von ${fmt(c.limit)} · ${pctTxt(ctx, c.share, 0)}</span></div></div>
    <div class="small">Verfügbar ÷ erlaubt gesamt: <b>${c.availShare == null ? '—' : rateTxt(ctx, c.availShare)}</b> <span class="muted">(${fmt(c.available)} buchbar von ${fmt(c.limit)})</span>${overMark(c.availShare, c.limitDerived)}</div>`
    : `<div class="small"><b>${fmt(c.total)}</b> ${esc(typeName(c.type))} gemeldet · ${c.perOperator != null ? 'keine Gesamtgrenze, Grenze je Anbieter siehe Tabelle' : 'keine stadtweite Grenze'}</div>`;
  return `<div class="rp-cap"><div class="rp-cap-h"><h3>${esc(c.ort)} <span class="muted small">${esc(typeName(c.type))}${c.art ? ` · ${esc(c.art)}` : ''}</span></h3>${badge(c.status)}</div>
    ${head}
    <div class="small muted">Obergrenze gesamt ${limTxt}${c.perOperator != null ? ` · je Anbieter ${fmt(c.perOperator)}${c.perOperatorDerived ? ` (${DERIVED_TXT})` : ''}` : ''}${hist ? ` · ${hist}` : ''}${c.since && !c.previous ? ` · gilt seit ${esc(standTxt(c.since))}` : ''}${c.stand ? ` · Stand ${esc(standTxt(c.stand))}` : ''} · amtlich · Quelle: ${links}${listTxt}</div>
    ${c.hinweis ? `<div class="small muted">${esc(c.hinweis)}</div>` : ''}
    ${ops ? `<div class="tbl"><table><thead><tr><th>Anbieter</th><th class="n">Bestand</th><th class="n">davon gesperrt</th><th class="n">Buchbar</th><th class="n">Grenze</th><th>Auslastung</th><th class="n" title="gemeldet ÷ Grenze">Gemeldet ÷ erlaubt</th><th class="n" title="buchbar ÷ Grenze">Verfügbar ÷ erlaubt</th><th>Status</th></tr></thead><tbody>${ops}</tbody></table></div>` : emptyBox(`Keine ${esc(typeName(c.type))} im Feed.`, 'Kein offener Feed meldet hier gerade Fahrzeuge dieser Art.')}
    ${districts ? `<div class="tbl"><table><thead><tr><th>Teilgebiet mit eigener Grenze</th><th class="n">Grenze</th><th>Status</th><th>Hinweis</th></tr></thead><tbody>${districts}</tbody></table></div>` : ''}
    ${c.hasRate ? violationsBlock(ctx, c, viol, s) : ''}
    <div class="tiles">${tile(`${esc(typeName(c.type))} je 1.000 EW`, num(ctx, per1000, 1), pop ? `${fmt(c.total)} Fahrzeuge · ${fmt(pop)} Einwohner` : 'Einwohnerzahl fehlt')}${tile('Fahrten je 1.000 EW und Tag', num(ctx, rep?.totals.per1000Rides, 1), rep ? `${esc(typeName(c.type))}, ${plural(rep.days.length, 'Tag', 'Tage')} hochgerechnet, gemessen${pre}` : 'noch keine Tagesdateien')}</div></div>`;
}
// Einträge ohne Prüfung (nicht amtlich, „keine“): kompakte Tabelle mit Zahl laut Quelle und heutigem Bestand zur Einordnung
function capInfoTable(ctx, list, title) {
  const { esc, fmt } = ctx; if (!list.length) return '';
  const rows = list.map(c => `<tr><td><b>${esc(c.ort)}</b><div class="sub-line">${esc(typeName(c.type))}${c.art ? ` · ${esc(c.art)}` : ''}</div></td><td>${badge(c.status)}<div class="sub-line">${esc(R.CAP_SOURCE_STATUS[c.sourceStatus] || c.sourceStatus)}${c.statusText && c.statusText !== R.CAP_SOURCE_STATUS[c.sourceStatus] ? ` – ${esc(c.statusText)}` : ''}</div></td>
    <td class="small">${c.sourceStatus === 'keine' ? '—' : capInfoTxt(ctx, c) || '—'}</td><td class="n">${fmt(c.total)}</td><td class="small">${safeLink(ctx, c.url, c.quelle || 'Quelle')}${c.stand ? ` · ${esc(standTxt(c.stand))}` : ''}</td></tr>`).join('');
  return `<h3 style="font-size:13px;margin:var(--s4) 0 var(--s1)">${title}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(title)}"><table><thead><tr><th>Stadt</th><th>Status der Quelle</th><th>Zahl laut Quelle</th><th class="n">Bestand heute</th><th>Quelle</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
/**
 * Obergrenzen-Wächter: Gemeinden mit Eintrag in reference.json → obergrenzen (bei 'DE' alle), Bestand aus latest.json groups.
 * Daten: reference.json (CFG.MAIN), latest.json (state.latest), events/<Tag>.json für Fahrten je 1.000 EW.
 */
export async function renderCaps(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc } = ctx; const tok = ++s.tok;
  bindOnce(el, 'caps', () => {
    el.addEventListener('click', (e) => { const b = e.target.closest('button[data-rp="captable"]'); if (!b) return; const k = `cap:${b.dataset.ags}`; s.show[k] = !s.show[k]; renderCaps(el, s.ctx); });
    const hide = () => { el.querySelectorAll('.rp-chart[data-rp="capchart"]').forEach(hideTip); el.querySelectorAll('svg.rp-bars g.on').forEach(x => x.classList.remove('on')); };
    el.addEventListener('pointermove', (e) => {
      const g = e.target.closest?.('svg.rp-bars g[data-i]'); const box = e.target.closest?.('.rp-chart[data-rp="capchart"]'); if (!g || !box) { hide(); return; }
      const v = s.viol?.find(x => x.ags === box.dataset.ags); const d = v?.daily.filter(x => x.max != null)[+g.dataset.i]; if (!d) return;
      el.querySelectorAll('svg.rp-bars g.on').forEach(x => { if (x !== g) x.classList.remove('on'); }); g.classList.add('on');
      const st = R.capStatus(d.max, d.limit); showTip(box, g.querySelector('.bar') || g, `${s.ctx.fmt(d.max)} Fahrzeuge`, [`${R.WEEKDAYS_LONG[R.weekdayOf(d.day)]}, ${dd(d.day)} · höchster Bestand`, d.limit ? `Grenze ${s.ctx.fmt(d.limit)} · ${STATUS[st.status][0]} ${STATUS[st.status][1]} (${pctTxt(s.ctx, st.share, 0)})` : 'ohne Grenze']);
    });
    el.addEventListener('pointerleave', hide);
  });
  const title = head('Obergrenzen-Wächter', `Aktueller Bestand gegen kommunale Obergrenzen (amtliche Zahlen) · Sammler-Stand ${stamp(state.latest?.at)}`);
  if (!state.latest) { el.innerHTML = title + emptyBox('Noch kein Datenstand.', 'Die Prüfung erscheint, sobald der Sammler-Stand geladen ist.'); return; }
  el.classList.add('rp-busy');
  try {
    const ref = await reference(ctx); if (tok !== s.tok) return;
    if (!ref) { el.innerHTML = title + emptyBox('Referenzwerte nicht ladbar.', 'reference.json fehlt oder ist gerade nicht erreichbar.'); return; }
    const caps = R.capsCheck(ref, state.latest.groups, { ags: state.scope || 'DE', asOf: state.latest.at || Date.now() });
    const [{ docs }, log] = await Promise.all([allDocs(ctx), fetchJson(ctx, 'caps-log.json', true)]); if (tok !== s.tok) return;
    s.viol = log ? R.capsViolations(log, { ags: state.scope || 'DE', asOf: state.latest.at || Date.now() }) : null;
    const violFor = (c) => (log ? s.viol.find(v => v.ags === R.capLogKey(c)) || null : undefined); // je Gemeinde und Art
    const repFor = (ags, ty) => (docs.length ? R.municipalReport({ docs, ags, pop: state.latest.municipalities?.[ags]?.pop || null, type: ty, latestGroups: state.latest.groups }) : null);
    const defn = `<p class="note small" style="margin:var(--s3) 0 0">Bestand = alle E-Scooter, die die offenen Feeds in der Gemeinde melden: verfügbar, reserviert <b>und gesperrt</b>, nach Abgleich doppelter Quellen. Anbieter ohne offenen Feed fehlen, die Prüfung ist deshalb eine Untergrenze. Status: ok unter ${R.NEAR_CAP * 100} %, nahe ab ${R.NEAR_CAP * 100} %, über bei mehr als 100 % der Grenze. Geprüft werden nur amtliche Zahlen; gerechnete Zahlen (${DERIVED_TXT}) geben nur einen Hinweis, Teilgebiets-Grenzen (z. B. Berlin innerhalb des S-Bahn-Rings) sind ohne Gebietsgrenze nicht prüfbar, Anbieter außerhalb der vollständigen Anbieterliste der Quelle stehen als „ohne Zulassung laut Quelle“ da (kein Verstoß). <b>Verfügbar ÷ erlaubt</b> = buchbare Fahrzeuge des Anbieters ÷ seine erlaubte Zahl; ohne Grenze je Anbieter steht dort sein Anteil an der Gesamtgrenze. Je Stadt und Anbieter mit Tagesverlauf unter Marktbild › Leistung › Verfügbarkeit je Stadt.</p>`;
    let body = '';
    // geprüft wird nur, was amtlich ist; amtliche Einträge nur mit Teilgebiets-Grenzen als Block mit „nicht prüfbar“, der Rest kompakt zur Information
    const checked = caps.filter(c => c.official && (c.hasRate || (state.scope && state.scope !== 'DE'))), rest = caps.filter(c => !checked.includes(c));
    if (caps.length) body = checked.map(c => capBlock(ctx, c, repFor(c.ags, c.type), state.latest.municipalities?.[c.ags]?.pop || null, violFor(c), s)).join('')
      + capInfoTable(ctx, rest, state.scope && state.scope !== 'DE' ? 'Weitere Angaben ohne Prüfung' : `Weitere Einträge ohne Prüfung (${rest.length}): nur Teilgebiete, geplant, Presse, ungeprüft, veraltet oder keine Obergrenze`);
    else {
      const ags = state.scope, m = state.latest.municipalities?.[ags] || {};
      const total = Object.entries(state.latest.groups || {}).filter(([k]) => k.startsWith(`${ags}|`) && k.endsWith('|scooter')).reduce((a, [, g]) => a + (g.total || 0), 0);
      const rep = repFor(ags, 'scooter');
      body = `<div class="note">Für ${esc(m.name || ags)} ist keine Obergrenze hinterlegt (reference.json → obergrenzen). Amtlich mit Zahl hinterlegt sind: ${[...new Set(R.capsCheck(ref, state.latest.groups, { asOf: state.latest.at || Date.now() }).filter(c => c.hasRate).map(c => c.ort))].map(esc).join(', ') || 'keine'}.</div>
        <div class="tiles" style="margin-top:var(--s3)">${tile('E-Scooter je 1.000 EW', num(ctx, m.pop ? (total / m.pop) * 1000 : null, 1), m.pop ? `${ctx.fmt(total)} Fahrzeuge · ${ctx.fmt(m.pop)} Einwohner` : 'Einwohnerzahl fehlt')}${tile('Fahrten je 1.000 EW und Tag', num(ctx, rep?.totals.per1000Rides, 1), rep ? `E-Scooter, hochgerechnet${rep.quality.prelim ? ' · vorläufig' : ''}` : 'noch keine Tagesdateien')}</div>`;
    }
    el.innerHTML = title + body + defn;
  } catch (e) { console.error('Obergrenzen', e); if (tok === s.tok) el.innerHTML = title + emptyBox('Prüfung nicht möglich.', 'Daten nicht ladbar – später erneut versuchen.'); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}

// ======================================================================
// 3. Heatmap Stunde × Wochentag
// ======================================================================
const fieldName = (hm) => (hm?.field === 'end' ? 'Fahrtenden' : 'Fahrtbeginne');
function weekLabel(ctx, hm, wd, h) {
  const c = hm.cells[wd][h]; const when = `${R.WEEKDAYS_LONG[wd]}, ${h}–${h + 1} Uhr`; const F = fieldName(hm);
  if (c.mean != null && R.suppressed(c.raw)) return { value: `< ${R.MIN_COUNT} ${F}`, lines: [when, `unterdrückt (Datenschutz-Schwelle) · ${plural(c.n, 'Tag', 'Tage')}`] };
  if (c.mean != null) return { value: `${ctx.fmt(c.mean, c.mean < 10 ? 1 : 0)} ${F}/h`, lines: [when, `Mittel aus ${plural(c.n, 'Tag', 'Tagen')} (${c.dates.map(d => dd(d).slice(0, 6)).join(', ')})${c.gapDays ? ` · ${plural(c.gapDays, 'Tag', 'Tage')} mit Lücke ausgelassen` : ''}`] };
  const why = !hm.days[wd] ? 'kein beobachteter Tag' : c.gapDays ? `Lücken-Lauf (${plural(c.gapDays, 'Tag', 'Tage')})` : c.thinDays ? `unter ${R.HEAT_MIN_OBS} Min. beobachtet` : 'nicht beobachtet';
  return { value: 'nicht gemessen', lines: [when, why] };
}
function weekGrid(ctx, hm) {
  let first = true; const hdr = Array.from({ length: 24 }, (_, h) => `<div role="columnheader" class="hl" aria-label="${h} Uhr">${h % 3 === 0 ? h : `<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">${h}</span>`}</div>`).join('');
  const rows = R.WEEKDAYS.map((w, wd) => {
    const cells = Array.from({ length: 24 }, (_, h) => {
      const c = hm.cells[wd][h]; const lb = weekLabel(ctx, hm, wd, h);
      const cls = c.mean == null ? 'na' : R.suppressed(c.raw) ? 'rp-s0' : `rp-s${R.heatClass(c.mean, hm.max, 8, { sqrt: false })}`;
      const tab = first && c.mean != null ? (first = false, 0) : -1;
      return `<div role="gridcell" class="c ${cls}" tabindex="${tab}" data-wd="${wd}" data-h="${h}" aria-label="${ctx.esc(`${lb.lines[0]}: ${lb.value}`)}"></div>`;
    }).join('');
    return `<div role="row" class="rp-row"><div role="rowheader" class="rl"><span>${w}</span><small title="beobachtete Tage">${hm.days[wd]} T.</small></div>${cells}</div>`;
  }).join('');
  const html = `<div class="rp-weekwrap" tabindex="0" role="region" aria-label="Heatmap, waagrecht scrollbar" style="overflow-x:auto;max-width:100%;position:relative"><div class="rp-week" role="grid" aria-label="${fieldName(hm)} je Stunde und Wochentag" data-rp="week"><div role="row" class="rp-row"><div role="columnheader" class="hl"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Wochentag</span></div>${hdr}</div>${rows}</div></div>`;
  return first ? html.replace('tabindex="-1"', 'tabindex="0"') : html; // nichts gemessen: erste Zelle trotzdem erreichbar
}
function weekTable(ctx, hm) {
  const head = R.WEEKDAYS.map((w, wd) => `<th class="n">${w}<div class="sub-line">${hm.days[wd]} T.</div></th>`).join('');
  const rows = Array.from({ length: 24 }, (_, h) => `<tr><td>${h}–${h + 1} Uhr</td>${R.WEEKDAYS.map((_, wd) => { const c = hm.cells[wd][h]; return `<td class="n">${c.mean == null ? '<span class="muted">nicht gem.</span>' : R.suppressed(c.raw) ? `&lt; ${R.MIN_COUNT}` : ctx.fmt(c.mean, c.mean < 10 ? 1 : 0)}</td>`; }).join('')}</tr>`).join('');
  return `<div class="tbl"><table><thead><tr><th>Stunde</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
/**
 * Heatmap Fahrtbeginne je Stunde × Wochentag für Gebiet/Anbieter/Art aus allen Tagesdateien (events/index.json → events/<Tag>.json).
 * Zelle grau = nicht gemessen (kein beobachteter Tag, unter 30 Min. Beobachtung oder Lücken-Lauf in der Stunde).
 */
export async function renderWeekHeatmap(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc } = ctx; const tok = ++s.tok;
  bindOnce(el, 'week', () => {
    el.addEventListener('click', (e) => {
      const f = e.target.closest('button[data-rp="field"]'); if (f && s.docs) { s.field = f.dataset.f; s.hm = R.weekHeatmap(s.docs, s.keep, { field: s.field }); renderWeek(el); el.querySelector(`button[data-rp="field"][data-f="${s.field}"]`)?.focus(); return; }
      const b = e.target.closest('button[data-rp="toggle"]'); if (!b) return; s.show.week = !s.show.week; renderWeek(el); });
    const cellOf = (t) => t.closest?.('.rp-week .c');
    const show = (c) => { if (!c || !s.hm) return; const box = c.closest('.rp-chart'); el.querySelectorAll('.rp-week .c.on').forEach(x => x.classList.remove('on')); c.classList.add('on'); const lb = weekLabel(s.ctx, s.hm, +c.dataset.wd, +c.dataset.h); showTip(box, c, lb.value, lb.lines); };
    const hide = () => { el.querySelectorAll('.rp-chart').forEach(hideTip); el.querySelectorAll('.rp-week .c.on').forEach(x => x.classList.remove('on')); };
    el.addEventListener('pointerover', (e) => { const c = cellOf(e.target); if (c) show(c); });
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focusin', (e) => { const c = cellOf(e.target); if (c) show(c); });
    el.addEventListener('focusout', (e) => { if (cellOf(e.target)) hide(); });
    el.addEventListener('keydown', (e) => {
      const c = cellOf(e.target); if (!c) return;
      const mv = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0], Home: [0, -24], End: [0, 24] }[e.key]; if (!mv) return;
      e.preventDefault();
      const wd = Math.max(0, Math.min(6, +c.dataset.wd + mv[0])), h = Math.max(0, Math.min(23, +c.dataset.h + mv[1]));
      const n = el.querySelector(`.rp-week .c[data-wd="${wd}"][data-h="${h}"]`); if (!n) return;
      c.tabIndex = -1; n.tabIndex = 0; n.focus();
    });
  });
  const scopeName = state.scope === 'DE' ? 'Deutschlandweit' : esc(ctx.muniName?.(state.scope) || state.scope);
  s.field ??= 'start';
  s.title = (btn) => head('Fahrten nach Stunde und Wochentag', `${s.field === 'end' ? 'Fahrtenden (Ziel)' : 'Fahrtbeginne (Start)'}: Mittel je Stunde über die beobachteten Tage · ${scopeName} · ${filterText(ctx)}`, btn);
  el.classList.add('rp-busy');
  try {
    const { docs } = await allDocs(ctx); if (tok !== s.tok) return;
    if (!docs.length) { el.innerHTML = s.title('') + emptyBox('Noch keine Tagesdateien.', 'Fahrtbeginne entstehen ab dem zweiten Sammler-Lauf.'); s.hm = null; return; }
    s.docs = docs; s.keep = R.keyFilter({ ags: state.scope || 'DE', operator: state.operator, type: state.type });
    s.hm = R.weekHeatmap(docs, s.keep, { field: s.field });
    s.ndocs = docs.length; renderWeek(el);
  } catch (e) { console.error('Heatmap', e); if (tok === s.tok) el.innerHTML = s.title('') + emptyBox('Heatmap nicht erstellbar.', 'Tagesdateien nicht ladbar.'); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}
function renderWeek(el) {
  const s = st(el); const ctx = s.ctx, hm = s.hm; if (!hm) return;
  const seg = `<div class="rp-seg" role="group" aria-label="Start oder Ziel">${[['start', 'Start'], ['end', 'Ziel']].map(([f, l]) => `<button type="button" data-rp="field" data-f="${f}" aria-pressed="${s.field === f}">${l}</button>`).join('')}</div>`;
  const btn = `<div class="rp-ctl rp-noprint">${seg}<button type="button" data-rp="toggle" aria-expanded="${s.show.week ? 'true' : 'false'}">${s.show.week ? 'Als Heatmap' : 'Als Tabelle'}</button></div>`;
  const mid = hm.max / 2;
  const legend = `<div class="rp-legend"><span>${fieldName(hm)} je Stunde</span><span class="rp-ramp"><em>0</em>${rampSpans()}<em>${ctx.fmt(hm.max, hm.max < 10 ? 1 : 0)}</em></span><span class="muted">Mitte ≈ ${ctx.fmt(mid, mid < 10 ? 1 : 0)}</span><span><i class="rp-sw na"></i>nicht gemessen (kein Tag, unter ${R.HEAT_MIN_OBS} Min. beobachtet oder Lücken-Lauf)</span><span><i class="rp-sw rp-s0"></i>weniger als ${R.MIN_COUNT} ${fieldName(hm)} (Datenschutz)</span></div>`;
  const note = `<div class="muted small" style="margin-top:var(--s2)">${hm.measured} von 168 Stunden gemessen · ${plural(s.ndocs, 'Tagesdatei', 'Tagesdateien')} · Stunden in Ortszeit; Werte auf 60 Min. Beobachtung bezogen. ${hm.measured < 168 ? 'Graue Felder sind Lücken in der Messung, keine Nullwerte.' : ''}</div>`;
  el.innerHTML = s.title(btn) + (s.show.week ? weekTable(ctx, hm) : `<div class="rp-chart"><div class="rp-scroll">${weekGrid(ctx, hm)}</div></div>${legend}`) + note;
}

// ======================================================================
// 4. Preisänderungs-Log
// ======================================================================
const FIELD = { unlock: 'Entsperren', price: 'Grundpreis', perMin: 'je Minute', per_min: 'je Minute', perKm: 'je km', per_km: 'je km', '+plan': 'neuer Tarif', '-plan': 'Tarif entfernt', added: 'neuer Tarif', removed: 'Tarif entfernt', plan: 'Tarif', currency: 'Währung', name: 'Name', taxable: 'steuerpflichtig', surge: 'Zuschlag bei Nachfrage (surge)' };
function valTxt(ctx, v) {
  if (v == null || v === '') return '–';
  if (typeof v === 'boolean') return v ? 'ja' : 'nein';
  if (typeof v === 'number') return `${ctx.fmt(v, 2)}`;
  if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object' ? [x.rate != null ? `${ctx.fmt(+x.rate, 2)}` : '', x.interval > 1 ? `/${x.interval}` : '', x.start ? ` ab ${x.start}` : ''].join('') : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v);
}
/** Preisänderungen aus pricing-log.json (CFG.DATA), gefiltert nach Gebiet und Anbieter, neueste zuerst; Leerzustand ohne Datei */
export async function renderPriceLog(el, ctx) {
  if (!el) return;
  const s = prep(el, ctx); const { state, esc } = ctx; const tok = ++s.tok;
  const title = head('Preisänderungen', 'Änderungen an den Tarifen der Preisfeeds (system_pricing_plans), wie der Sammler sie festgestellt hat');
  const log = await fetchJson(ctx, 'pricing-log.json', true); if (tok !== s.tok) return;
  if (!log) { el.innerHTML = title + emptyBox('Noch kein Preisänderungs-Log.', 'Die Datei pricing-log.json entsteht, sobald der Sammler Tarife zwischen zwei Läufen vergleicht. Aktuelle Tarife stehen unter Marktbild › Leistung › Preise.'); return; }
  const pricing = await fetchJson(ctx, 'pricing.json', true); if (tok !== s.tok) return;
  const all = R.priceLogEntries(log, { sources: state.latest?.sources, pricing });
  const list = R.filterPriceLog(all, { ags: state.scope || 'DE', operator: state.operator });
  const area = (e) => (!e.munis.length ? `<span class="muted">${e.sourceId != null ? 'Quelle nicht im Datenstand' : 'bundesweit'}</span>` : `${e.munis.slice(0, 3).map(a => esc(ctx.muniName?.(a) || a)).join(', ')}${e.munis.length > 3 ? ` <span class="muted">+${e.munis.length - 3}</span>` : ''}`);
  const rows = list.slice(0, 200).map(e => `<tr><td class="n">${e.at ? stamp(e.at) : esc(e.day || '–')}</td><td><span class="op"><i style="background:${ctx.opColor(e.operator || '')}"></i>${esc(e.operator || '–')}</span></td><td class="small">${area(e)}</td><td>${esc(e.plan || '–')}</td><td>${esc(FIELD[e.field] || FIELD[e.kind] || e.field || e.kind || 'Änderung')}${e.note ? `<div class="sub-line">${esc(e.note)}</div>` : ''}</td><td class="n">${esc(valTxt(ctx, e.from))} → <b>${esc(valTxt(ctx, e.to))}</b></td></tr>`).join('');
  const at = log.updatedAt || log.at;
  el.innerHTML = title + (rows ? `<div class="tbl"><table><thead><tr><th class="n">Festgestellt</th><th>Anbieter</th><th>Gebiet</th><th>Tarif</th><th>Was</th><th class="n">alt → neu</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyBox('Keine Preisänderung im Filter.', all.length ? `${plural(all.length, 'Änderung', 'Änderungen')} insgesamt; Gebiet oder Anbieter oben weiter fassen.` : 'Bisher hat der Sammler keine Änderung festgestellt.'))
    + `<div class="muted small" style="margin-top:var(--s2)">${list.length > 200 ? `${list.length - 200} ältere ausgeblendet · ` : ''}Beträge in der Währung des Tarifs, wie im Feed${at ? ` · Stand ${stamp(at)}` : ''}</div>`;
}

// ======================================================================
// 5. Feed-Prüfung
// ======================================================================
/** Eigene Prüfung nach GBFS-Pflichtfeldern aus latest.json sources[].checks, gefiltert nach Gebiet und Anbieter */
export function renderFeedChecks(el, ctx) {
  if (!el) return;
  prep(el, ctx); const { state, esc } = ctx;
  const label = (state.latest?.sources || []).find(r => r.checks?.label)?.checks.label;
  const title = head('Feed-Prüfung', `${label ? esc(label) : 'Eigene Prüfung nach GBFS-Pflichtfeldern – keine offizielle Validierung'} · letzter Sammler-Lauf ${stamp(state.latest?.at)}`);
  const recs = (state.latest?.sources || []).filter(r => r.status !== 'retired' && (state.scope === 'DE' || !state.scope || (r.municipalities || []).includes(state.scope)) && (state.operator === 'all' || r.operator === state.operator));
  const checked = recs.map(r => ({ r, c: R.normalizeChecks(r.checks) })).filter(x => x.c);
  if (!checked.length) { el.innerHTML = title + emptyBox(state.latest?.sources?.some(r => r.checks) ? 'Keine geprüfte Quelle im Filter.' : 'Noch keine Feed-Prüfung im Datenstand.', state.latest?.sources?.some(r => r.checks) ? 'Gebiet oder Anbieter oben weiter fassen.' : 'Die Prüfung erscheint mit dem nächsten Sammler-Lauf (latest.json → sources[].checks).'); return; }
  checked.sort((a, b) => b.c.errors - a.c.errors || b.c.warnings - a.c.warnings || String(a.r.name || a.r.id).localeCompare(String(b.r.name || b.r.id), 'de'));
  const ok = checked.filter(x => !x.c.errors && !x.c.warnings).length;
  const rows = checked.slice(0, 300).map(({ r, c }) => `<tr><td>${/^https?:/i.test(r.url || '') ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name || r.id)}</a>` : esc(r.name || r.id)}<div class="sub-line">${esc(r.operator || '')}${r.version ? ` · GBFS ${esc(r.version)}` : ''}${r.status === 'duplicate' ? ' · Dublette, zählt nicht' : ''}</div></td>
    <td class="n">${c.errors ? `<span class="rp-status over"><i aria-hidden="true">✕</i>${c.errors}</span>` : '<span class="muted">0</span>'}</td><td class="n">${c.warnings ? `<span class="rp-status near"><i aria-hidden="true">!</i>${c.warnings}</span>` : '<span class="muted">0</span>'}</td>
    <td class="small">${c.findings.slice(0, 3).map(f => `<div>${f.level === 'error' ? 'Fehler' : 'Warnung'}: ${esc(f.text).slice(0, 160)}</div>`).join('') || '<span class="muted">ohne Befund</span>'}${Math.max(c.findings.length, c.errors + c.warnings) > 3 ? `<div class="muted">+${Math.max(c.findings.length, c.errors + c.warnings) - 3} weitere</div>` : ''}</td></tr>`).join('');
  el.innerHTML = title + `<div class="muted small" style="margin-bottom:var(--s2)">${plural(checked.length, 'Quelle', 'Quellen')} geprüft · ${ok} ohne Befund · ${checked.filter(x => x.c.errors).length} mit Fehlern</div>
    <div class="tbl"><table><thead><tr><th>Quelle</th><th class="n">Fehler</th><th class="n">Warnungen</th><th>erste Befunde</th></tr></thead><tbody>${rows}</tbody></table></div>${checked.length > 300 ? `<div class="muted small">${checked.length - 300} weitere Quellen – Gebiet eingrenzen.</div>` : ''}`;
}

// ======================================================================
// Gemeinsame Bausteine für Tabellen mit Auswahlfeldern, Sortierung und „mehr zeigen“
// ======================================================================
const TYPE_ORDER = ['scooter', 'ebike', 'bike', 'cargo', 'other', 'unknown'];
function groupOptions(latest) {
  const ops = new Set(), types = new Set();
  for (const k of Object.keys(latest?.groups || {})) { const [a, op, ty] = k.split('|'); if (!a || a === 'DE') continue; ops.add(op); types.add(ty); }
  return { ops: [...ops].sort((a, b) => a.localeCompare(b, 'de')), types: [...types].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b)) };
}
function filterCtl(ctx, s, { op = true, min = true, typeAll = true, minLabel = 'Mindestbestand' } = {}) {
  const { ops, types } = groupOptions(ctx.state.latest); const esc = ctx.esc;
  const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
  return `<div class="rp-ctl rp-noprint">${op ? `<label>Anbieter <select data-f="op">${opt('all', 'Alle Anbieter', s.op)}${ops.map(o => opt(o, o, s.op)).join('')}</select></label>` : ''}
    <label>Fahrzeugart <select data-f="type">${typeAll ? opt('all', 'Alle Arten', s.type) : ''}${types.map(t => opt(t, typeName(t), s.type)).join('')}</select></label>
    ${min ? `<label>${minLabel} <input type="number" data-f="min" min="0" step="10" value="${s.min}" style="width:6em" aria-label="${minLabel} (Fahrzeuge)"> Fzg.</label>` : ''}</div>`;
}
function initFilters(s, ctx, { type = null } = {}) {
  if (s.init) return; s.init = true;
  const { ops, types } = groupOptions(ctx.state.latest);
  s.op = ops.includes(ctx.state.operator) ? ctx.state.operator : 'all';
  s.type = type ?? (types.includes(ctx.state.type) ? ctx.state.type : 'all');
  s.min = R.MIN_FLEET; s.limit = 100;
}
function bindFilters(el, s, rerender) {
  el.addEventListener('change', (e) => {
    const f = e.target.dataset?.f; if (!f || f === 'day') return;
    if (f === 'min') { const v = parseInt(e.target.value, 10); s.min = Number.isFinite(v) && v >= 0 ? v : R.MIN_FLEET; } else s[f] = e.target.value;
    s.limit = 100; rerender();
  });
}
// Kopfzeile mit Sortierknöpfen; cols: [key, label, numeric, defaultDir, title?]
function sortHead(cols, sort) {
  return `<thead><tr>${cols.map(([k, l, n, , title]) => { if (!k) return `<th${n ? ' class="n"' : ''}>${l}</th>`; const on = sort.key === k; return `<th class="${n ? 'n' : ''}" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="rp-sort${on ? ' on' : ''}" data-sort="${k}"${title ? ` title="${title}"` : ''}>${l}<span aria-hidden="true">${on ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span></button></th>`; }).join('')}</tr></thead>`;
}
function bindSort(el, s, cols, rerender) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button.rp-sort'); if (b) { const k = b.dataset.sort; const def = cols.find(c => c[0] === k)?.[3] || 'asc'; s.sort = s.sort.key === k ? { key: k, dir: s.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: def }; rerender(); el.querySelector(`button.rp-sort[data-sort="${k}"]`)?.focus(); return; }
    if (e.target.closest('button[data-rp="more"]')) { s.limit += 100; rerender(); }
  });
}
const moreBtn = (shown, total) => (total > shown ? `<div class="rp-ctl rp-noprint" style="margin-top:var(--s2)"><button type="button" data-rp="more">Mehr zeigen (${Math.min(100, total - shown)} von ${total - shown} weiteren)</button></div>` : '');
// Stadt: mit ctx.setScope als Knopf, sonst Link mit ?scope=
function cityCell(ctx, ags, name, land) {
  const label = `${ctx.esc(name)}${land ? ` <span class="muted">(${ctx.esc(land)})</span>` : ''}`;
  if (typeof ctx.setScope === 'function') return `<button type="button" class="rp-city" data-ags="${ctx.esc(ags)}" title="Als Gebiet wählen">${label}</button>`;
  return `<a class="rp-city" href="?scope=${encodeURIComponent(ags)}${ctx.esc(location.hash || '')}" title="Als Gebiet wählen">${label}</a>`;
}
function bindCity(el, ctx) { el.addEventListener('click', (e) => { const b = e.target.closest('button.rp-city'); if (b && typeof S.get(el)?.ctx?.setScope === 'function') S.get(el).ctx.setScope(b.dataset.ags); }); }
// Anteil ohne Rundungsübertreibung: knapp unter 100 % nicht als „100,0 %“, knapp über 0 nicht als „0,0 %“
const pctFine = (ctx, v, d = 1) => { const lim = 0.5 * 10 ** -d / 100; return v < 1 && v >= 1 - lim ? `> ${ctx.fmt(100 - 10 ** -d, d)} %` : v > 0 && v < lim ? `< ${ctx.fmt(10 ** -d, d)} %` : `${ctx.fmt(v * 100, d)} %`; };
const pctCell = (ctx, v, d = 1) => (v == null ? '<span class="muted">k. A.</span>' : pctFine(ctx, v, d));
const miniBar = (v) => (v == null ? '' : `<span class="rp-mini" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, v * 100)).toFixed(1)}%"></i></span>`);
const EXTRA_CSS = `
.rp-sort{all:unset;cursor:pointer;display:inline-flex;gap:4px;align-items:center;font:inherit;letter-spacing:inherit;text-transform:inherit;color:inherit;border-radius:4px}
.rp-sort:hover,.rp-sort.on{color:var(--fg)}.rp-sort:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.rp-sort span{font-size:9px;min-width:8px}
.rp-city{all:unset;cursor:pointer;font-weight:500;color:var(--fg);text-decoration:underline;text-decoration-color:var(--line-2);text-underline-offset:2px}
a.rp-city{text-decoration:underline}.rp-city:hover{text-decoration-color:var(--accent)}.rp-city:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
tr.rp-sel td{background:color-mix(in srgb,var(--accent) 11%,transparent)}tr.rp-sel .muted{color:var(--fg)}tr.rp-sel .sub-line{color:var(--fg-2)}tr.rp-sel td:first-child{box-shadow:inset 3px 0 0 var(--accent)}
.rp-mini{display:inline-block;width:44px;height:4px;border-radius:2px;background:color-mix(in srgb,var(--accent) 18%,var(--panel-2));vertical-align:middle;margin-left:6px;overflow:hidden}.rp-mini>i{display:block;height:100%;background:var(--accent)}
.rp-defs{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:var(--s2) var(--s4);margin:0 0 var(--s3)}
.rp-defs div{font-size:12.5px;color:var(--fg-2)}.rp-defs b{color:var(--fg);font-weight:600}
.rp-keys{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:12px;color:var(--fg-2);margin:0 0 var(--s2)}
.rp-key{display:inline-block;width:14px;height:2px;border-radius:1px;vertical-align:middle;margin-right:6px;background:var(--c)}
svg.rp-line{display:block;width:100%;height:auto;overflow:visible;touch-action:pan-y}
svg.rp-line text{font-family:var(--mono);font-size:10.5px;fill:var(--muted)}svg.rp-line text.lab{font-family:var(--sans);font-size:11.5px;fill:var(--fg-2)}
svg.rp-line .grid{stroke:var(--line);stroke-width:1}svg.rp-line .base{stroke:var(--line-2);stroke-width:1}
svg.rp-line .xh{stroke:var(--fg-2);stroke-width:1}svg.rp-line:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:4px}
svg.rp-line circle.end{stroke:var(--panel);stroke-width:2}svg.rp-line circle.sel{fill:none;stroke:var(--fg);stroke-width:2}
.rp-tip .row{display:flex;gap:8px;align-items:center;white-space:nowrap}.rp-tip .row b{display:inline;font-size:13px;min-width:56px;text-align:right}.rp-tip .row i{width:12px;height:2px;border-radius:1px;flex:none}
.rp-tip .hd{color:var(--muted);font-size:11px;margin-bottom:2px}
.rp-captable tbody th{position:static;text-transform:none;letter-spacing:0;font-size:13px;font-weight:500;color:var(--fg);vertical-align:top;background:transparent;border-bottom:1px solid var(--line);min-width:150px}
.rp-captable tbody th .sub-line{font-weight:400;color:var(--muted)}
.rp-captable tbody+tbody tr:first-child>*{border-top:1px solid var(--line-2)}
.rp-captable td.n .sub-line{font-family:var(--sans);white-space:normal;min-width:7em}
.rp-captable tr.rp-sum td{font-weight:600;background:color-mix(in srgb,var(--fg) 3%,transparent)}
.rp-captable tbody.rp-selg>tr>*{background:color-mix(in srgb,var(--accent) 11%,transparent)}.rp-captable tbody.rp-selg th{box-shadow:inset 3px 0 0 var(--accent)}.rp-captable tbody.rp-selg .muted,.rp-captable tbody.rp-selg .sub-line{color:var(--fg-2)}
.rp-over{font-size:11.5px;margin-left:4px;vertical-align:1px}.rp-over i{width:14px;height:14px;font-size:9px}
.rp-prof{display:grid;gap:var(--s3);grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))}
.rp-prof .card dl{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px var(--s3);font-size:12.5px}
.rp-prof .card dt{color:var(--muted)}.rp-prof .card dd{margin:0;color:var(--fg)}
`;
function injectExtra() { if (document.getElementById('rp-style-2')) return; const s = document.createElement('style'); s.id = 'rp-style-2'; s.textContent = EXTRA_CSS + EXTRA_CSS_2; document.head.appendChild(s); }
function prep2(el, ctx) { const s = prep(el, ctx); injectExtra(); return s; }
const opsDoc = (ctx, land) => fetchJson(ctx, `ops/${land}.json`); // ohne Laufstempel: derselbe Download wie Übersicht (Energie) und Karte
async function latestHist(ctx, day = null) { const hidx = await histIndex(ctx); const days = (hidx.days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)); const d = day && days.includes(day) ? day : lastOf(days); return { days, day: d || null, hist: d ? await histDoc(ctx, hidx, d) : null }; }

// ======================================================================
// 7. Verfügbarkeit je Stadt
// ======================================================================
const AV_COLS = [['name', 'Stadt (Land)', false, 'asc'], ['total', 'Gemeldet', true, 'desc'], ['available', 'Buchbar', true, 'desc'], ['avail', 'Verfügbarkeit', true, 'asc', 'buchbar ÷ gemeldet'], ['ready', 'Einsatzbereit', true, 'asc', 'buchbar und Energie ausreichend ÷ Fahrzeuge mit Energieangabe'],
  ['disabledShare', 'Gesperrt', true, 'desc'], ['reserved', 'Reserviert', true, 'desc'], ['opCount', 'Anbieter', true, 'desc'], ['dayMean', 'Tagesmittel', true, 'asc', 'Mittel der Verfügbarkeit über die Sammler-Punkte des Tages'], ['dayMin', 'Tagesminimum', true, 'asc']];
function availData(ctx, s) {
  const { state } = ctx; const scope = state.scope && state.scope !== 'DE' ? state.scope : null;
  const rows = R.availabilityRows(state.latest, { operator: s.op, type: s.type, minTotal: s.min, keepAgs: scope });
  const th = state.latest?.thresholds || {};
  const rangeOnly = (op) => R.RANGE_ONLY_OPS.includes(op) || (state.latest?.sources || []).some(r => r.operator === op && r.counts?.batteryNative === 0 && r.counts?.vehicles > 0);
  const readyFor = (land) => { const k = `${land}|${s.op}|${s.type}`; if (!s.readyCache.has(k) && s.ops.has(land)) s.readyCache.set(k, R.readinessFromOps(s.ops.get(land), { operator: s.op, type: s.type, charge: th.chargeThreshold ?? 20, range: th.rangeThreshold ?? 5, rangeOnly })); return s.readyCache.get(k) || null; };
  const ha = s.hist ? R.histAvailability(s.hist, { operator: s.op, type: s.type }) : null;
  for (const r of rows) {
    const rd = r.state ? readyFor(r.state) : null; const o = rd?.get(r.ags);
    r.readyKnown = o ? o.known : null; r.ready = o && o.known ? o.ready / o.known : null; r.readyPending = !rd && r.state && !s.opsFailed.has(r.state);
    const h = ha?.byAgs.get(r.ags); r.dayMean = h ? h.mean : null; r.dayMin = h ? h.min : null; r.dayMinAt = h ? h.minAt : null; r.dayN = h ? h.n : null;
  }
  return { rows: R.sortRows(rows, s.sort.key, s.sort.dir), scope, ha };
}
function availTable(ctx, s, d) {
  const { esc, fmt } = ctx; const show = d.rows.slice(0, s.limit);
  const body = show.map(r => `<tr${r.ags === d.scope ? ' class="rp-sel" aria-current="true"' : ''}><td>${cityCell(ctx, r.ags, r.name, r.state)}${r.below ? '<div class="sub-line">unter Mindestbestand, gewählte Gemeinde</div>' : ''}</td>
    <td class="n">${fmt(r.total)}</td><td class="n">${fmt(r.available)}</td><td class="n"><b>${pctCell(ctx, r.avail)}</b>${miniBar(r.avail)}</td>
    <td class="n">${r.readyPending ? '<span class="muted">…</span>' : pctCell(ctx, r.ready)}${r.readyKnown != null && r.readyKnown < r.total ? `<div class="sub-line">${r.readyKnown ? `n = ${fmt(r.readyKnown)} mit Energieangabe` : 'keine Energieangabe'}</div>` : ''}</td>
    <td class="n">${pctCell(ctx, r.disabledShare)}</td><td class="n">${fmt(r.reserved)}</td><td class="n" title="${esc(r.operators.join(', '))}">${r.opCount}</td>
    <td class="n">${pctCell(ctx, r.dayMean)}</td><td class="n">${pctCell(ctx, r.dayMin)}${r.dayMinAt ? `<div class="sub-line">${hhmm(r.dayMinAt)}</div>` : ''}</td></tr>`).join('');
  return `<div class="tbl"><table>${sortHead(AV_COLS, s.sort)}<tbody>${body || `<tr><td colspan="${AV_COLS.length}" class="empty"><b>Keine Stadt im Filter.</b>Mindestbestand senken oder Anbieter/Art auf „Alle“ stellen.</td></tr>`}</tbody></table></div>${moreBtn(show.length, d.rows.length)}`;
}
// Liniendiagramm: eine Achse 0–100 %, Farbe je Anbieter, Lücken > 45 Min. als Unterbrechung, Direktbeschriftung am Ende
function lineChart(ctx, t, series, { W = 900, H = 280 } = {}) {
  const P = { l: 46, r: 132, t: 14, b: 30 };
  const HOUR = 3600e3; const t0 = Math.floor(t[0] / HOUR) * HOUR, t1 = Math.max(t0 + HOUR, Math.ceil(t[t.length - 1] / HOUR) * HOUR);
  const x = (v) => P.l + ((v - t0) / (t1 - t0)) * (W - P.l - P.r), y = (v) => P.t + (1 - v) * (H - P.t - P.b);
  let g = '';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) g += `<line class="${v === 0 ? 'base' : 'grid'}" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${v * 100} %</text>`;
  const span = (t1 - t0) / HOUR; const step = [1, 2, 3, 4, 6, 12].find(s => span / s <= 8) || 24;
  for (let tt = t0; tt <= t1; tt += step * HOUR) g += `<text x="${x(tt)}" y="${H - 8}" text-anchor="middle">${hhmm(tt)}</text>`;
  const lines = series.map((s) => {
    const segs = R.lineSegments(t, s.values); const c = ctx.opColor(s.op);
    return segs.map(seg => seg.length === 1 ? `<circle cx="${x(t[seg[0]]).toFixed(1)}" cy="${y(s.values[seg[0]]).toFixed(1)}" r="3" fill="${c}"/>` : `<path d="${seg.map((i, j) => `${j ? 'L' : 'M'}${x(t[i]).toFixed(1)} ${y(s.values[i]).toFixed(1)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  }).join('');
  // Endpunkte und Direktbeschriftung; kollidierende Beschriftungen entfallen (Legende und Tooltip tragen sie)
  const ends = series.map(s => { let i = s.values.length - 1; while (i >= 0 && s.values[i] == null) i--; return i >= 0 ? { s, i, ty: y(s.values[i]) } : null; }).filter(Boolean).sort((a, b) => a.ty - b.ty);
  let lastY = -Infinity; let labels = '';
  const dots = ends.map(e => `<circle class="end" cx="${x(t[e.i]).toFixed(1)}" cy="${e.ty.toFixed(1)}" r="4" fill="${ctx.opColor(e.s.op)}"/>`).join('');
  for (const e of ends) { if (e.ty - lastY < 13) continue; lastY = e.ty; labels += `<text class="lab" x="${(x(t[e.i]) + 9).toFixed(1)}" y="${(e.ty + 4).toFixed(1)}">${ctx.esc(e.s.op)} ${ctx.fmt(e.s.values[e.i] * 100, 0)} %</text>`; }
  return { svg: `<svg class="rp-line" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="Verfügbarkeit je Anbieter über den Tag; Pfeiltasten wählen den Zeitpunkt, Werte auch in der Tabellenansicht">${g}${lines}${dots}${labels}<line class="xh" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" visibility="hidden"/><rect class="hit" x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent"/></svg>`, x, W, P };
}
function showRowsTip(box, anchor, px, py, head, rows) {
  const t = tip(box); t.replaceChildren();
  const hd = document.createElement('div'); hd.className = 'hd'; hd.textContent = head; t.append(hd);
  for (const r of rows) { const d = document.createElement('div'); d.className = 'row'; const i = document.createElement('i'); i.style.background = r.color; const b = document.createElement('b'); b.textContent = r.value; const s = document.createElement('span'); s.textContent = r.label; d.append(i, b, s); t.append(d); }
  t.hidden = false; const w = box.getBoundingClientRect();
  const xx = Math.max(t.offsetWidth / 2 + 4, Math.min(w.width - t.offsetWidth / 2 - 4, px - w.left)); let yy = py - w.top; if (yy - t.offsetHeight - 10 < 0) yy = yy + t.offsetHeight + 24;
  t.style.left = `${xx}px`; t.style.top = `${yy}px`;
}
function bindLine(el, getChart) {
  const move = (svg, i) => {
    const c = getChart(); if (!c || i == null) return; const box = svg.closest('.rp-chart');
    const xh = svg.querySelector('line.xh'); const xv = c.x(c.t[i]); xh.setAttribute('x1', xv); xh.setAttribute('x2', xv); xh.setAttribute('visibility', 'visible');
    const r = svg.getBoundingClientRect(); const k = r.width / c.W;
    const rows = c.series.map(s => ({ color: c.color(s.op), value: s.values[i] == null ? '–' : c.pct(s.values[i]), label: s.op, v: s.values[i] ?? -1 })).sort((a, b) => b.v - a.v);
    showRowsTip(box, svg, r.left + xv * k, r.top + c.P.t * k, `${hhmm(c.t[i])} Uhr · Sammler-Punkt`, rows); c.i = i;
  };
  const nearest = (svg, clientX) => { const c = getChart(); if (!c) return null; const r = svg.getBoundingClientRect(); const xv = (clientX - r.left) * (c.W / r.width); let best = null, bd = Infinity; c.t.forEach((tt, i) => { const d = Math.abs(c.x(tt) - xv); if (d < bd) { bd = d; best = i; } }); return best; };
  const hide = (svg) => { svg?.querySelector('line.xh')?.setAttribute('visibility', 'hidden'); const box = svg?.closest('.rp-chart'); if (box) hideTip(box); };
  el.addEventListener('pointermove', (e) => { const svg = e.target.closest?.('svg.rp-line'); if (svg) move(svg, nearest(svg, e.clientX)); });
  el.addEventListener('pointerout', (e) => { const svg = e.target.closest?.('svg.rp-line'); if (svg && !svg.contains(e.relatedTarget)) hide(svg); });
  el.addEventListener('focusin', (e) => { if (e.target.matches?.('svg.rp-line')) { const c = getChart(); move(e.target, c?.i ?? (c ? c.t.length - 1 : null)); } });
  el.addEventListener('focusout', (e) => { if (e.target.matches?.('svg.rp-line')) hide(e.target); });
  el.addEventListener('keydown', (e) => { if (!e.target.matches?.('svg.rp-line')) return; const c = getChart(); if (!c) return; const d = { ArrowRight: 1, ArrowLeft: -1, Home: -1e9, End: 1e9 }[e.key]; if (d == null) return; e.preventDefault(); move(e.target, Math.max(0, Math.min(c.t.length - 1, (c.i ?? c.t.length - 1) + d))); });
}
function availChart(ctx, s) {
  const { state, esc, fmt } = ctx; const scope = state.scope;
  if (!scope || scope === 'DE') return '';
  const name = state.latest?.municipalities?.[scope]?.name || scope;
  const daySel = s.histDays.length > 1 ? `<label>Tag <select data-f="day">${[...s.histDays].reverse().map(d => `<option value="${esc(d)}"${d === s.day ? ' selected' : ''}>${R.WEEKDAYS[R.weekdayOf(d)]}, ${dd(d)}</option>`).join('')}</select></label>` : '';
  const btn = `<button type="button" data-rp="avtable" aria-expanded="${s.showTable ? 'true' : 'false'}">${s.showTable ? 'Als Diagramm' : 'Als Tabelle'}</button>`;
  const headH = `<div class="panel-head" style="margin-top:var(--s5)"><div><h3 style="margin:0;font-size:14px">Verlauf in ${esc(name)}</h3><div class="sub">Verfügbarkeit je Anbieter aus den Sammler-Punkten${s.hist?.t?.length ? ` · ${s.hist.t.length} Punkte ${hhmm(s.hist.t[0])}–${hhmm(lastOf(s.hist.t))} Uhr` : ''} · Lücken über 45 Min. unterbrechen die Linie</div></div><div class="rp-ctl rp-noprint">${daySel}${btn}</div></div>`;
  if (!s.hist) return headH + emptyBox(s.histLoading ? 'Verlauf wird geladen …' : 'Kein Verlauf für diesen Tag.', s.histLoading ? '' : 'history/<Tag>.json fehlt.');
  const ser = R.availabilitySeries(s.hist, scope, { operator: s.op, type: s.type });
  s.chart = null;
  if (!ser.series.length) return headH + emptyBox('Keine Sammler-Punkte im Filter.', 'Anbieter oder Fahrzeugart auf „Alle“ stellen.');
  const series = ser.series.slice(0, 8); const more = ser.series.length - series.length;
  if (s.showTable) {
    const rows = ser.t.map((tt, i) => `<tr><td class="n">${hhmm(tt)}</td>${series.map(x => `<td class="n">${x.values[i] == null ? '–' : pctFine(ctx, x.values[i], 1)}</td>`).join('')}</tr>`).join('');
    return headH + `<div class="tbl"><table><thead><tr><th class="n">Zeit</th>${series.map(x => `<th class="n">${esc(x.op)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  const ch = lineChart(ctx, ser.t, series);
  s.chart = { t: ser.t, series, x: ch.x, W: ch.W, P: ch.P, color: ctx.opColor, fmt, pct: (v) => pctFine(ctx, v, 1), i: null };
  const keys = `<div class="rp-keys" aria-label="Legende">${series.map(x => `<span><i class="rp-key" style="--c:${ctx.opColor(x.op)}"></i>${esc(x.op)} <span class="muted mono">Ø ${fmt(x.total)} Fzg.</span></span>`).join('')}${more ? `<span class="muted">+${more} weitere (nach Bestand)</span>` : ''}</div>`;
  return headH + keys + `<div class="rp-chart">${ch.svg}</div>`;
}
/**
 * Verfügbarkeit je Stadt (ganz Deutschland) mit eigenen Auswahlfeldern Anbieter, Art und Mindestbestand; Verlauf für die gewählte Gemeinde.
 * Daten: latest.json groups (gemeldet, buchbar, gesperrt, reserviert), ops/<Land>.json (Einsatzbereitschaft je Fahrzeug),
 * history/index.json + history/<Tag>.json (Tagesmittel/-minimum, Verlauf). Optional ctx.setScope(ags).
 */
export async function renderAvailability(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state } = ctx;
  if (!s.sort) { s.sort = { key: 'avail', dir: 'asc' }; s.ops = new Map(); s.opsFailed = new Set(); s.readyCache = new Map(); s.histDays = []; }
  if (state.latest) initFilters(s, ctx);
  const draw = () => drawAvailability(el);
  bindOnce(el, 'avail', () => {
    bindFilters(el, s, draw);
    el.addEventListener('change', async (e) => { if (e.target.dataset?.f === 'day') { s.day = e.target.value; s.histLoading = true; draw(); const h = await latestHist(s.ctx, s.day); s.hist = h.hist; s.histLoading = false; draw(); } });
    bindSort(el, s, AV_COLS, draw); bindCity(el, ctx); bindLine(el, () => s.chart);
    el.addEventListener('click', (e) => { if (e.target.closest('button[data-rp="avtable"]')) { s.showTable = !s.showTable; draw(); } else if (e.target.closest('button[data-rp="avcsv"]')) availCsv(el); else if (e.target.closest('button[data-rp="capcsv"]')) capCsv(el); });
  });
  if (!state.latest) { el.innerHTML = head('Verfügbarkeit je Stadt', '') + emptyBox('Noch kein Datenstand.', 'Die Tabelle erscheint, sobald der Sammler-Stand geladen ist.'); return; }
  const tok = ++s.tok;
  draw();
  try {
    if (!s.hist || s.histAt !== state.latest.at) { s.histLoading = true; const h = await latestHist(ctx, s.day); if (tok !== s.tok) return; s.hist = h.hist; s.histDays = h.days; s.day = h.day; s.histAt = state.latest.at; s.histLoading = false; draw(); }
    if (s.ref === undefined) { s.ref = await reference(ctx); if (tok !== s.tok) return; draw(); } // Obergrenzen (reference.json) für Verfügbar ÷ erlaubt
    // Einsatzbereitschaft: ops/<Land>.json der Länder in der Tabelle (und der gewählten Gemeinde) nachladen
    if (s.opsAt !== state.latest.at) { s.ops.clear(); s.readyCache.clear(); s.opsFailed.clear(); s.opsAt = state.latest.at; }
    const lands = [...new Set(Object.values(state.latest.municipalities || {}).map(m => m.state).filter(Boolean))].filter(l => !s.ops.has(l) && !s.opsFailed.has(l));
    await Promise.all(lands.map(async (l) => { const d = await opsDoc(ctx, l); if (tok !== s.tok) return; if (d?.vehicles) { s.ops.set(l, d); if (d.at && d.at !== state.latest.at) s.opsStamp = d.at; } else s.opsFailed.add(l); }));
    if (tok === s.tok) draw();
  } catch (e) { console.error('Verfügbarkeit', e); }
}
function drawAvailability(el) {
  const s = st(el); const ctx = s.ctx; const { esc } = ctx; if (!ctx.state.latest) return;
  const d = availData(ctx, s); s.rows = d.rows;
  const th = ctx.state.latest.thresholds || {};
  const defs = `<div class="rp-defs"><div><b>Verfügbarkeit</b> = buchbare ÷ gemeldete Fahrzeuge. Buchbar = nicht gesperrt und nicht reserviert; bei Stationsfeeds ohne Fahrzeugliste die buchbaren Fahrzeuge an Stationen. Gemeldet = alle Fahrzeuge der offenen Feeds nach Abgleich doppelter Quellen.</div>
    <div><b>Einsatzbereit</b> = buchbar <i>und</i> Energie nicht niedrig, bezogen auf die Fahrzeuge mit Energieangabe. Energie niedrig = Ladestand unter ${th.chargeThreshold ?? 20} % und Reichweite unter ${th.rangeThreshold ?? 5} km, wo beides gemeldet ist, sonst die gemeldete Angabe; Anbieter, die nur Reichweite melden (${esc(R.RANGE_ONLY_OPS.join(', '))}), über die Reichweite – dieselbe Regel wie Disposition und Übersicht. Ohne Energieangabe: k. A.${s.opsStamp ? ` Energie-Stand ${stamp(s.opsStamp)}.` : ''}</div>
    <div><b>Tagesmittel / -minimum</b> = Verfügbarkeit über die Sammler-Punkte des Tages${s.hist?.t?.length ? ` (${s.hist.t.length} Punkte, ${hhmm(s.hist.t[0])}–${hhmm(lastOf(s.hist.t))} Uhr)` : ''}; Stand der übrigen Spalten ${stamp(ctx.state.latest.at)}.</div></div>`;
  const right = `<div class="rp-ctl rp-noprint"><button type="button" data-rp="avcsv" title="Alle Zeilen im Filter">↓ CSV</button></div>`;
  const focus = document.activeElement && el.contains(document.activeElement) ? (document.activeElement.dataset?.f || null) : null;
  el.innerHTML = head('Verfügbarkeit je Stadt', `Buchbare und einsatzbereite Fahrzeuge je Gemeinde in ganz Deutschland · ${d.rows.length} Städte im Filter · Klick auf den Spaltenkopf sortiert`, right)
    + filterCtl(ctx, s) + defs + availTable(ctx, s, d) + capRateSection(ctx, s) + availChart(ctx, s);
  if (focus) el.querySelector(`[data-f="${focus}"]`)?.focus();
}
// ---------- Verfügbar ÷ erlaubt je Anbieter gegen die Obergrenzen ----------
// Überschreitung (über 100 %) mit Symbol und Text, nahe (ab 90 %) mit Symbol und Text – nie nur über die Farbe. Gerechnete Grenze
// (nicht in der Quelle): statt „Überschreitung/nahe“ nur ein Hinweis-Zeichen, kein Verstoß.
const overMark = (v, derived = false) => (v != null && v > 1 ? (derived ? ` <span class="rp-status hint rp-over"><i aria-hidden="true">i</i>über gerechneter Zahl</span>` : ` <span class="rp-status over rp-over"><i aria-hidden="true">✕</i>Überschreitung</span>`) : '');
const nearMark = (v, derived = false) => (v != null && v <= 1 && v >= R.NEAR_CAP && !derived ? ` <span class="rp-status near rp-over"><i aria-hidden="true">!</i>nahe</span>` : '');
// knapp an 100 % mit einer Nachkommastelle („100,1 %“ statt „100 %“ neben „Überschreitung“, „> 99,9 %“ knapp darunter)
const rateTxt = (ctx, v) => (v >= 0.995 && v < 1.005 ? pctFine(ctx, v, 1) : pctTxt(ctx, v, 0));
const rateCell = (ctx, v, bar = false, derived = false) => (v == null ? '<span class="muted">—</span>' : `<b>${rateTxt(ctx, v)}</b>${bar ? miniBar(Math.min(1, v)) : ''}${overMark(v, derived)}${bar ? nearMark(v, derived) : ''}`);
const standTxt = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || '') ? dd(x) : /^\d{4}-\d{2}$/.test(x || '') ? `${x.slice(5)}/${x.slice(0, 4)}` : x || '');
const DERIVED_TXT = 'gerechnet, nicht in der Quelle';
const numsTxt = (ctx, a) => (a?.length ? a.map(v => ctx.fmt(v)).join('–') : null);
// Zahlen eines Eintrags ohne Kennzahl in einem Satz: „gesamt 9.000–10.000 · je Anbieter 800 · Teilgebiete: Innenstadt 19.000 (je Anbieter 4.750, gerechnet)“
function capInfoTxt(ctx, x) {
  const parts = [];
  const g = numsTxt(ctx, x.info?.gesamt), j = numsTxt(ctx, x.info?.jeAnbieter);
  if (g) parts.push(`gesamt ${g}`); if (j) parts.push(`je Anbieter ${j}`);
  const z = (x.districts || []).filter(d => d.limit != null || d.perOperator != null).map(d => `${ctx.esc(d.label)} ${[d.limit != null ? ctx.fmt(d.limit) : null, d.perOperator != null ? `je Anbieter ${ctx.fmt(d.perOperator)}${d.perOperatorDerived ? ` (${DERIVED_TXT})` : ''}` : null].filter(Boolean).join(', ')}`);
  if (z.length) parts.push(`nur Teilgebiet${z.length > 1 ? 'e' : ''}: ${z.join('; ')} – nicht prüfbar ohne Gebietsgrenze`);
  return parts.join(' · ');
}
const capInfoLine = (ctx, x) => {
  const why = x.sourceStatus === 'keine' ? 'keine Obergrenze laut Quelle' : !x.official ? `${ctx.esc(R.CAP_SOURCE_STATUS[x.sourceStatus] || x.sourceStatus)}${x.statusText && x.statusText !== R.CAP_SOURCE_STATUS[x.sourceStatus] ? ` (${ctx.esc(x.statusText)})` : ''}, nur zur Information` : 'amtlich, aber keine stadtweite Zahl';
  const nums = x.sourceStatus === 'keine' ? '' : capInfoTxt(ctx, x);
  return `<b>${ctx.esc(x.ort)}</b>${x.types?.[0] && x.types[0] !== 'scooter' ? ` (${ctx.esc(x.types.map(typeName).join(', '))})` : ''}: ${why}${nums ? ` · ${nums}` : ''}${x.url ? ` · ${safeLink(ctx, x.url, 'Quelle')}` : ''}`;
};
function capRateSection(ctx, s) {
  const { esc, fmt, state } = ctx;
  const h3 = (sub, right = '') => `<div class="panel-head" style="margin-top:var(--s5)"><div><h3 style="margin:0;font-size:14px" id="rp-caprate-h">Verfügbar ÷ erlaubt je Anbieter</h3><div class="sub">${sub}</div></div>${right}</div>`;
  if (s.ref === undefined) return h3('Obergrenzen werden geladen …');
  if (!s.ref?.obergrenzen?.length) return h3('Keine Obergrenzen hinterlegt (reference.json → obergrenzen).');
  const ca = R.capAvailability(s.ref, state.latest, { hist: s.hist, operator: s.op, type: s.type, asOf: state.latest.at || Date.now() }); s.capRows = ca.rows;
  const scope = state.scope && state.scope !== 'DE' ? state.scope : null;
  const scopeName = scope ? state.latest.municipalities?.[scope]?.name || ctx.muniName?.(scope) || scope : null;
  const capAgs = new Set((s.ref.obergrenzen || []).map(e => e.ags));
  const notes = [];
  if (scope && !capAgs.has(scope)) notes.push(`<b>${esc(scopeName)}:</b> keine Obergrenze bekannt – Städte ohne Eintrag in reference.json → obergrenzen sind hier ausgeblendet.`);
  if (scope) for (const x of ca.info.filter(i => i.ags === scope)) notes.push(capInfoLine(ctx, x));
  if (ca.skipped.length) notes.push(`Für ${esc(typeName(s.type))} ist keine amtliche Obergrenze hinterlegt; die Grenzen von ${esc([...new Set(ca.skipped.map(x => x.ort))].join(', '))} gelten für ${esc([...new Set(ca.skipped.flatMap(x => x.types))].map(typeName).join(', '))}.`);
  const day = s.hist?.day || s.day; const tN = s.hist?.t?.length || 0;
  const nCities = new Set(ca.rows.map(r => r.ags)).size;
  const sub = `${plural(ca.cities, 'amtliche Grenze', 'amtliche Grenzen')} mit stadtweiter Zahl${nCities ? ` · ${plural(nCities, 'Stadt', 'Städte')} im Filter` : ''} · gezählt nur die Fahrzeugart der Grenze · Stand ${stamp(state.latest.at)}${tN ? ` · Tagesmittel/-minimum ${day ? dd(day) : ''} aus ${fmt(tN)} Sammler-Punkten` : ''}`;
  const right = ca.rows.length ? `<div class="rp-ctl rp-noprint"><button type="button" data-rp="capcsv" title="Alle Zeilen im Filter">↓ CSV</button></div>` : '';
  const defs = `<div class="rp-defs"><div><b>Verfügbar ÷ erlaubt</b> = buchbare Fahrzeuge des Anbieters ÷ seine erlaubte Fahrzeugzahl (Obergrenze je Anbieter). Gibt die Stadt nur eine Gesamtgrenze vor, steht dort der Anteil des Anbieters an der Gesamtgrenze; die Zeile „Alle Anbieter“ setzt die Summe gegen die Gesamtgrenze.</div>
    <div><b>Gemeldet ÷ erlaubt</b> = alle gemeldeten Fahrzeuge (auch gesperrte und reservierte) ÷ dieselbe Grenze – so prüft der Obergrenzen-Wächter. Über 100 % ist eine Überschreitung (✕), ab ${R.NEAR_CAP * 100} % nahe (!); bei gerechneten Zahlen (${DERIVED_TXT}) nur ein Hinweis (i). Anbieter ohne offenen Feed fehlen: Untergrenze.</div>
    <div><b>Nur amtliche Grenzen</b> mit stadtweiter Zahl. Grenzen für Teilgebiete (z. B. Berlin innerhalb des S-Bahn-Rings) sind ohne Gebietsgrenze nicht prüfbar; geplante, nur in der Presse genannte oder veraltete Zahlen stehen als Information darunter. <b>Tagesmittel / -minimum</b> = Verfügbar ÷ erlaubt über die Sammler-Punkte des gewählten Tages.</div></div>`;
  const noteHtml = notes.length ? `<div class="note small" role="note" style="margin:0 0 var(--s2)">${notes.join('<br>')}</div>` : '';
  const others = scope ? [] : ca.info;
  const otherHtml = others.length ? `<details class="rp-capinfo"><summary>Weitere Einträge ohne amtliche stadtweite Zahl (${others.length})</summary><ul>${others.map(x => `<li>${capInfoLine(ctx, x)}</li>`).join('')}</ul></details>` : '';
  if (!ca.rows.length) return h3(sub, right) + defs + noteHtml + (ca.skipped.length || (scope && notes.length) ? '' : emptyBox('Keine Fahrzeuge im Filter.', 'Anbieter oder Fahrzeugart auf „Alle“ stellen.')) + otherHtml;
  const byCity = new Map(); for (const r of ca.rows) { const k = `${r.ags}|${r.types.join(',')}`; if (!byCity.has(k)) byCity.set(k, []); byCity.get(k).push(r); }
  const kindTxt = { operator: 'je Anbieter', share: 'Anteil an gesamt', total: 'gesamt', unlicensed: '', none: 'keine Zahl' };
  const bodies = [...byCity.values()].sort((a, b) => a[0].ort.localeCompare(b[0].ort, 'de') || a[0].types[0].localeCompare(b[0].types[0])).map(list => {
    const first = list[0]; const land = state.latest.municipalities?.[first.ags]?.state;
    const zones = (first.districts || []).length ? `<div class="sub-line">${plural(first.districts.length, 'Teilgebiet', 'Teilgebiete')} mit eigener Grenze: nicht prüfbar</div>` : '';
    const src = `${safeLink(ctx, first.url, first.quelle || 'Quelle')}${first.stand ? ` · Stand ${esc(standTxt(first.stand))}` : ''}${first.next ? ` · ab ${dd(first.next.from)}: ${fmt(first.next.limit)}` : ''}`;
    const ty = first.types[0] !== 'scooter' ? ` <span class="muted">· ${esc(first.types.map(typeName).join(', '))}</span>` : '';
    return `<tbody${first.ags === scope ? ' class="rp-selg" aria-current="true"' : ''}>${list.map((r, i) => `<tr${r.op === '*' ? ' class="rp-sum"' : ''}>${i === 0 ? `<th scope="rowgroup" rowspan="${list.length}" class="rp-cityth">${cityCell(ctx, r.ags, r.ort, land)}${ty}<div class="sub-line">${src}</div>${zones}</th>` : ''}
      <td>${r.op === '*' ? '<b>Alle Anbieter</b>' : `<span class="op"><i style="background:${ctx.opColor(r.op)}"></i>${esc(r.op)}</span>`}${r.kind === 'unlicensed' ? `<div class="sub-line">${badge('unlicensed')}</div>` : ''}</td><td class="n">${fmt(r.total)}</td><td class="n">${fmt(r.available)}</td>
      <td class="n">${r.limit != null ? fmt(r.limit) : '—'}<div class="sub-line">${kindTxt[r.kind] || ''}${r.derived ? `${kindTxt[r.kind] ? ' · ' : ''}${DERIVED_TXT}` : ''}</div></td>
      <td class="n">${rateCell(ctx, r.availRate, true, r.derived)}</td><td class="n">${rateCell(ctx, r.totalRate, false, r.derived)}</td>
      <td class="n">${rateCell(ctx, r.dayMean, false, r.derived)}</td><td class="n">${rateCell(ctx, r.dayMin, false, r.derived)}${r.dayMinAt ? `<div class="sub-line">${hhmm(r.dayMinAt)} Uhr</div>` : ''}</td></tr>`).join('')}</tbody>`;
  }).join('');
  return h3(sub, right) + defs + noteHtml + `<div class="tbl" tabindex="0" role="region" aria-labelledby="rp-caprate-h"><table class="rp-captable"><thead><tr><th scope="col">Stadt (Quelle, Stand der Grenze)</th><th scope="col">Anbieter</th><th scope="col" class="n">Gemeldet</th><th scope="col" class="n">Buchbar</th><th scope="col" class="n">Erlaubt</th><th scope="col" class="n">Verfügbar ÷ erlaubt</th><th scope="col" class="n">Gemeldet ÷ erlaubt</th><th scope="col" class="n">Tagesmittel</th><th scope="col" class="n">Tagesminimum</th></tr></thead>${bodies}</table></div>` + otherHtml;
}
function capCsv(el) {
  const s = st(el); if (!s.capRows) return; const ctx = s.ctx;
  download(`verfuegbar-je-erlaubt_${s.op}_${s.type}_${new Date(ctx.state.latest?.at || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, R.toCsv(R.capAvailabilityCsvRows(s.capRows, { operator: s.op, type: s.type, at: ctx.state.latest?.at, typeLabel: typeName, day: s.hist?.day || s.day })));
}
function availCsv(el) {
  const s = st(el); if (!s.rows) return; const ctx = s.ctx;
  download(`verfuegbarkeit_${s.op}_${s.type}_${new Date(ctx.state.latest?.at || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, R.toCsv(R.availabilityCsvRows(s.rows, { operator: s.op, type: s.type, at: ctx.state.latest?.at, typeLabel: typeName, day: s.day })));
}

// ======================================================================
// 8. Städte-Rangliste (je Stadt × Fahrzeugart) und 9. Dichte gegen Nutzung
// ======================================================================
const RANK_CACHE = new Map();
async function rankingInputs(ctx) {
  const idx = await usageIndex(ctx); const days = (idx.days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)); const [hidx, daily] = await Promise.all([histIndex(ctx), dailyDoc(ctx)]);
  const [docs, hs] = await Promise.all([Promise.all(days.map(d => eventsDoc(ctx, idx, d))), Promise.all(days.map(d => histFor(ctx, hidx, daily, d)))]);
  const ok = docs.map((d, i) => [d, days[i], hs[i]]).filter(([d]) => d);
  const limits = (await loadCalibration(ctx)).limits || null;
  return { docs: ok.map(x => x[0]), hists: Object.fromEntries(ok.filter(x => x[2]).map(x => [x[1], x[2]])), limits };
}
function rankingFor(ctx, inp, type, operator = 'all') {
  const rvdLimit = inp.limits || null; // Überzählung (über der Kalibrier-Grenze) zählt wie bisher nur bei der Flotte
  const k = `${ctx.state.latest?.at}|${inp.docs.map(d => d.day).join(',')}|${type}|${operator}|${JSON.stringify(rvdLimit)}`;
  if (!RANK_CACHE.has(k)) { const cur = R.cityRanking(inp.docs, inp.hists, ctx.state.latest, { type, operator, minFleet: 0, rvdLimit }); const per = R.rankingPeriods(inp.docs); let prev = null;
    if (!per.reason) { const a = R.cityRanking(per.cur, inp.hists, ctx.state.latest, { type, operator, minFleet: 0, rvdLimit }), b = R.cityRanking(per.prev, inp.hists, ctx.state.latest, { type, operator, minFleet: 0, rvdLimit }); prev = { n: per.n, cur: new Map(a.rows.map(r => [r.key, r])), prev: new Map(b.rows.map(r => [r.key, r])), from: per.prev[0].day, to: lastOf(per.prev).day, curFrom: per.cur[0].day, curTo: lastOf(per.cur).day }; }
    RANK_CACHE.set(k, { ...cur, prev, reason: per.reason || null }); }
  return RANK_CACHE.get(k);
}
const RK_COLS = [['name', 'Stadt (Land)', false, 'asc'], ['ty', 'Art', false, 'asc'], ['fleet', 'Ø Flotte', true, 'desc'], ['ridesDay', 'Fahrten / Tag', true, 'desc'], ['rvd', 'je Fzg. und Tag', true, 'desc', 'Fahrten je Fahrzeug und Tag'], ['per1000Fleet', 'Fzg. je 1.000 EW', true, 'desc'], ['per1000Rides', 'Fahrten je 1.000 EW/Tag', true, 'desc'], ['opCount', 'Anbieter', true, 'desc']];
/**
 * Rangliste der Städte: Fahrten je Fahrzeug und Tag je Stadt × Fahrzeugart, Flotte, Fahrten/Tag, je 1.000 Einwohner; Vorperiode ab 2 × 3 vollen Messtagen.
 * Daten: events/<Tag>.json, history/<Tag>.json, latest.json municipalities (pop). Optional ctx.setScope(ags).
 */
export async function renderCityRanking(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state } = ctx;
  if (!s.sort) s.sort = { key: 'rvd', dir: 'desc' };
  if (state.latest) initFilters(s, ctx, { type: groupOptions(state.latest).types.includes(state.type) ? state.type : 'scooter' });
  const draw = () => drawRanking(el);
  bindOnce(el, 'rank', () => { bindFilters(el, s, draw); bindSort(el, s, [...RK_COLS, ['delta', '', true, 'desc']], draw); bindCity(el, ctx); el.addEventListener('click', (e) => { if (e.target.closest('button[data-rp="rkcsv"]')) rankingCsv(el); }); });
  const title = head('Städte-Rangliste', 'Fahrten je Fahrzeug und Tag je Stadt und Fahrzeugart');
  if (!state.latest) { el.innerHTML = title + emptyBox('Noch kein Datenstand.', ''); return; }
  const tok = ++s.tok; el.classList.add('rp-busy'); if (!s.inp) el.innerHTML = title + '<div class="muted small">Tagesdateien werden geladen …</div>';
  try {
    const [inp, archDays] = await Promise.all([rankingInputs(ctx), archiveDayList(ctx).catch(() => [])]); if (tok !== s.tok) return; s.inp = inp;
    // Vorquartal aus dem Langzeit-Archiv, sobald zwei aufeinanderfolgende Quartale vollständig vorliegen
    const rq = R.rankingQuarters(archDays);
    if (rq && s.rq?.cur !== rq.cur) { const { archive, fields } = await archiveFor(ctx, [...rq.prevDays, ...rq.curDays]); if (tok !== s.tok) return; s.rq = { ...rq, archive, fields }; }
    else if (!rq) s.rq = null;
    draw();
  }
  catch (e) { console.error('Rangliste', e); if (tok === s.tok) el.innerHTML = title + emptyBox('Rangliste nicht erstellbar.', 'Tagesdateien nicht ladbar.'); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}
function drawRanking(el) {
  const s = st(el); const ctx = s.ctx; const { esc, fmt, state } = ctx; if (!s.inp) return;
  const title = (right = '') => head('Städte-Rangliste', `Fahrten je Fahrzeug und Tag je Stadt und Fahrzeugart · ${plural(s.inp.docs.length, 'Tag', 'Tage')} · Anbieter mit unplausibler Quote (über 15 bzw. bei E-Scooter über ${s.inp.limits?.scooter ? ctx.fmt(s.inp.limits.scooter, 2) : '15'}: Überzählung) zählen nur bei der Flotte`, right);
  if (!s.inp.docs.length) { el.innerHTML = title() + emptyBox('Noch keine Tagesdateien.', 'Fahrten entstehen ab dem zweiten Sammler-Lauf.'); return; }
  const rk = rankingFor(ctx, s.inp, s.type, s.op);
  const scope = state.scope && state.scope !== 'DE' ? state.scope : null;
  let rows = rk.rows.filter(r => r.fleet >= s.min || r.ags === scope);
  if (rk.prev) for (const r of rows) { const a = rk.prev.cur.get(r.key), b = rk.prev.prev.get(r.key); r.delta = a?.rvd != null && b?.rvd != null ? a.rvd - b.rvd : null; }
  // Quartalsvergleich (Archiv) vor dem Wochenvergleich
  let qcmp = null;
  if (s.rq) {
    const A = (ds) => new Map(R.cityRankingArchive(s.rq.archive, state.latest, { fields: s.rq.fields, type: s.type, operator: s.op, days: ds, rvdLimit: s.inp.limits }).rows.map(r => [r.key, r]));
    const ck = `${s.rq.cur}|${s.type}|${s.op}`; if (s.qcmpKey !== ck) { s.qcmp = { cur: A(s.rq.curDays), prev: A(s.rq.prevDays) }; s.qcmpKey = ck; } qcmp = s.qcmp;
    for (const r of rows) { const a = qcmp.cur.get(r.key), b = qcmp.prev.get(r.key); r.delta = a?.rvd != null && b?.rvd != null ? a.rvd - b.rvd : null; }
  }
  rows = R.sortRows(rows, s.sort.key, s.sort.dir); s.rows = rows; s.rk = rk;
  const qLab = (q) => R.periodRange(`q:${q}`).label;
  const cols = qcmp ? [...RK_COLS, ['delta', 'Δ zum Vorquartal', true, 'desc', `je Fzg. und Tag: ${qLab(s.rq.cur)} gegen ${qLab(s.rq.prev)} (Archiv, linear hochgerechnet)`]] : rk.prev ? [...RK_COLS, ['delta', `Δ zur Vorperiode`, true, 'desc', `je Fzg. und Tag: ${dd(rk.prev.curFrom)}–${dd(rk.prev.curTo)} gegen ${dd(rk.prev.from)}–${dd(rk.prev.to)}`]] : RK_COLS;
  const show = rows.slice(0, s.limit);
  const body = show.map((r, i) => `<tr${r.ags === scope ? ' class="rp-sel" aria-current="true"' : ''}><td>${cityCell(ctx, r.ags, r.name, r.state)}${r.excluded.length ? `<div class="sub-line">Fahrten ohne ${esc(r.excluded.join(', '))} (unplausibel)</div>` : ''}</td><td>${esc(typeName(r.ty))}</td>
    <td class="n">${fmt(r.fleet)}</td><td class="n">${r.ridesDay == null ? '—' : fmt(r.ridesDay)}</td><td class="n"><b>${r.rvd == null ? '—' : fmt(r.rvd, 2)}</b></td><td class="n">${r.per1000Fleet == null ? '—' : fmt(r.per1000Fleet, 1)}</td><td class="n">${r.per1000Rides == null ? '—' : fmt(r.per1000Rides, 1)}</td><td class="n">${r.opCount}</td>
    ${qcmp || rk.prev ? `<td class="n">${r.delta == null ? '—' : `${r.delta > 0 ? '+' : ''}${fmt(r.delta, 2)}`}</td>` : ''}</tr>`).join('');
  const note = `<div class="note small" style="margin-bottom:var(--s3)">${rk.prelim ? `<b>Vorläufig:</b> erst ${rk.fullDays} volle Messtage; Fahrten/Tag über den Tagesgang (${esc(rk.profileSource)}) hochgerechnet. ` : ''}${qcmp ? `Vorperiode: ${esc(qLab(s.rq.cur))} gegen ${esc(qLab(s.rq.prev))} aus dem Langzeit-Archiv (Tageswerte, linear über die beobachtete Zeit hochgerechnet).` : rk.reason ? `${esc(rk.reason)} – Spalte ausgeblendet. Der Quartalsvergleich erscheint, sobald zwei aufeinanderfolgende Quartale vollständig vorliegen.` : `Vorperiode: je ${rk.prev.n} Tage; Quartalsvergleich, sobald zwei aufeinanderfolgende Quartale vollständig vorliegen.`} Art der Rangliste wie Fluctuo-Index: gleiche Kennzahl für alle Städte, aus offenen Feeds gemessen; Anbieter ohne offenen Feed fehlen.</div>`;
  el.innerHTML = title(`<div class="rp-ctl rp-noprint"><button type="button" data-rp="rkcsv">↓ CSV</button></div>`) + filterCtl(ctx, s, { minLabel: 'Mindestflotte' }) + note
    + `<div class="tbl"><table>${sortHead(cols, s.sort)}<tbody>${body || `<tr><td colspan="${cols.length}" class="empty"><b>Keine Stadt im Filter.</b>Mindestflotte senken oder Art wechseln.</td></tr>`}</tbody></table></div>${moreBtn(show.length, rows.length)}`;
}
function rankingCsv(el) {
  const s = st(el); if (!s.rows) return;
  const vp = s.rq ? `${s.rq.cur} gegen ${s.rq.prev}` : s.rk.prev ? `${s.rk.prev.curFrom}–${s.rk.prev.curTo} gegen ${s.rk.prev.from}–${s.rk.prev.to}` : '';
  const rows = [['Rang', 'AGS', 'Stadt', 'Land', 'Fahrzeugart', 'Flotte_Mittel', 'Fahrten_je_Tag', 'Fahrten_je_Fahrzeug_Tag', 'Fahrzeuge_je_1000_EW', 'Fahrten_je_1000_EW_Tag', 'Anbieter', 'Delta_Vorperiode', 'Tage', 'vorlaeufig', 'Hinweis', 'Vorperiode'],
    ...s.rows.map((r, i) => [i + 1, r.ags, r.name, r.state || '', typeName(r.ty), [r.fleet, 1], [r.ridesDay, 1], [r.rvd, 2], [r.per1000Fleet, 2], [r.per1000Rides, 2], r.opCount, [r.delta, 2], s.rk.days.length, s.rk.prelim ? 'ja' : 'nein', r.excluded.length ? `ohne ${r.excluded.join(', ')}` : '', vp])];
  download(`staedte-rangliste_${s.type}_${lastOf(s.rk.days)}.csv`, R.toCsv(rows));
}
/**
 * Streudiagramm Fahrten je Fahrzeug und Tag gegen Fahrzeuge je km² je Gemeinde (Ansatz Universität St. Gallen).
 * Fläche aus latest.json municipalities[].areaKm2; fehlt sie, Leerzustand. Punktgröße fest, Tooltip, Tabellenansicht.
 */
export async function renderDensityScatter(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state } = ctx;
  if (state.latest) initFilters(s, ctx, { type: 'scooter' });
  const draw = () => drawScatter(el);
  bindOnce(el, 'scatter', () => {
    bindFilters(el, s, draw); bindCity(el, ctx);
    el.addEventListener('click', (e) => { if (e.target.closest('button[data-rp="sctable"]')) { s.showTable = !s.showTable; draw(); } });
    const near = (svg, ev) => { const c = s.sc; if (!c) return null; const r = svg.getBoundingClientRect(); const k = c.W / r.width; const px = (ev.clientX - r.left) * k, py = (ev.clientY - r.top) * k; let best = null, bd = 24 * k; c.pts.forEach((p, i) => { const d = Math.hypot(p.px - px, p.py - py); if (d < bd) { bd = d; best = i; } }); return best; };
    const show = (svg, i) => { const c = s.sc; const box = svg.closest('.rp-chart'); svg.querySelectorAll('circle.on').forEach(x => x.classList.remove('on')); if (i == null) { hideTip(box); return; } const p = c.pts[i]; svg.querySelector(`circle[data-i="${i}"]`)?.classList.add('on'); const r = svg.getBoundingClientRect(); const k = r.width / c.W;
      showRowsTip(box, svg, r.left + p.px * k, r.top + p.py * k - 6, `${p.name}${p.state ? ` (${p.state})` : ''} · ${typeName(p.ty)}`, [{ color: 'transparent', value: s.ctx.fmt(p.rvd, 2), label: 'Fahrten je Fahrzeug und Tag' }, { color: 'transparent', value: s.ctx.fmt(p.density, 1), label: 'Fahrzeuge je km²' }, { color: 'transparent', value: s.ctx.fmt(p.fleet), label: `Ø Flotte · ${s.ctx.fmt(p.areaKm2, 1)} km²` }]); c.i = i; };
    el.addEventListener('pointermove', (e) => { const svg = e.target.closest?.('svg.rp-scatter'); if (svg) show(svg, near(svg, e)); });
    el.addEventListener('pointerout', (e) => { const svg = e.target.closest?.('svg.rp-scatter'); if (svg && !svg.contains(e.relatedTarget)) show(svg, null); });
    el.addEventListener('keydown', (e) => { const svg = e.target.closest?.('svg.rp-scatter'); if (!svg || !s.sc) return; const d = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1 }[e.key]; if (!d) return; e.preventDefault(); const n = s.sc.pts.length; show(svg, (((s.sc.i ?? -1) + d) % n + n) % n); });
    el.addEventListener('focusout', (e) => { if (e.target.matches?.('svg.rp-scatter')) show(e.target, null); });
  });
  const title = head('Dichte gegen Nutzung', 'Fahrten je Fahrzeug und Tag gegen Fahrzeuge je km² je Gemeinde');
  if (!state.latest) { el.innerHTML = title + emptyBox('Noch kein Datenstand.', ''); return; }
  const tok = ++s.tok; el.classList.add('rp-busy');
  try { const inp = await rankingInputs(ctx); if (tok !== s.tok) return; s.inp = inp; draw(); }
  catch (e) { console.error('Dichte', e); if (tok === s.tok) el.innerHTML = title + emptyBox('Diagramm nicht erstellbar.', 'Tagesdateien nicht ladbar.'); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}
function drawScatter(el) {
  const s = st(el); const ctx = s.ctx; const { esc, fmt, state } = ctx; if (!s.inp) return;
  const title = (right = '') => head('Dichte gegen Nutzung', `Fahrten je Fahrzeug und Tag gegen Fahrzeuge je km² je Gemeinde · Ansatz Universität St. Gallen · ${plural(s.inp.docs.length, 'Tag', 'Tage')}`, right);
  const hasArea = Object.values(state.latest.municipalities || {}).some(m => +m.areaKm2 > 0);
  if (!hasArea) { s.sc = null; el.innerHTML = title() + emptyBox('Fläche je Gemeinde fehlt im Datenstand.', 'Das Diagramm erscheint, sobald latest.json municipalities[].areaKm2 liefert.'); return; }
  const rk = rankingFor(ctx, s.inp, s.type, s.op);
  const scope = state.scope && state.scope !== 'DE' ? state.scope : null;
  const pts = R.densityPoints(rk.rows.filter(r => r.fleet >= s.min || r.ags === scope));
  const btn = `<div class="rp-ctl rp-noprint"><button type="button" data-rp="sctable" aria-expanded="${s.showTable ? 'true' : 'false'}">${s.showTable ? 'Als Diagramm' : 'Als Tabelle'}</button></div>`;
  const note = `<div class="muted small" style="margin-top:var(--s2)">${pts.length} Gemeinden mit Fläche und Fahrten · Dichte = Ø Flotte ÷ Gemeindefläche (km², ganze Gemeinde, nicht nur Betriebsgebiet) · Achse waagrecht logarithmisch${rk.prelim ? ' · vorläufig (unter 3 vollen Messtagen)' : ''}${pts.some(p => p.excluded.length) ? ' · unplausible Anbieter nur in der Flotte' : ''}</div>`;
  if (!pts.length) { s.sc = null; el.innerHTML = title(btn) + filterCtl(ctx, s, { minLabel: 'Mindestflotte' }) + emptyBox('Keine Gemeinde im Filter.', 'Mindestflotte senken oder Art wechseln.'); return; }
  if (s.showTable) {
    const rows = R.sortRows(pts, 'rvd', 'desc');
    s.sc = null; el.innerHTML = title(btn) + filterCtl(ctx, s, { minLabel: 'Mindestflotte' }) + `<div class="tbl"><table><thead><tr><th>Stadt (Land)</th><th>Art</th><th class="n">Fahrzeuge je km²</th><th class="n">Fahrten je Fzg. und Tag</th><th class="n">Ø Flotte</th><th class="n">Fläche km²</th></tr></thead><tbody>${rows.map(p => `<tr${p.ags === scope ? ' class="rp-sel"' : ''}><td>${cityCell(ctx, p.ags, p.name, p.state)}</td><td>${esc(typeName(p.ty))}</td><td class="n">${fmt(p.density, 1)}</td><td class="n">${fmt(p.rvd, 2)}</td><td class="n">${fmt(p.fleet)}</td><td class="n">${fmt(p.areaKm2, 1)}</td></tr>`).join('')}</tbody></table></div>` + note;
    return;
  }
  const W = 900, H = 340, P = { l: 48, r: 24, t: 14, b: 40 };
  const lx = pts.map(p => Math.log10(p.density)); let x0 = Math.floor(Math.min(...lx)), x1 = Math.ceil(Math.max(...lx)); if (x1 === x0) x1 = x0 + 1;
  const ymax = Math.max(1, Math.ceil(Math.max(...pts.map(p => p.rvd)) * 1.1));
  const X = (d) => P.l + ((Math.log10(d) - x0) / (x1 - x0)) * (W - P.l - P.r), Y = (v) => P.t + (1 - v / ymax) * (H - P.t - P.b);
  let g = ''; const yStep = ymax <= 4 ? 1 : ymax <= 10 ? 2 : 5;
  for (let v = 0; v <= ymax; v += yStep) g += `<line class="${v === 0 ? 'base' : 'grid'}" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${P.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`;
  for (let e = x0; e <= x1; e++) { const d = 10 ** e; g += `<line class="grid" x1="${X(d)}" x2="${X(d)}" y1="${P.t}" y2="${H - P.b}"/><text x="${X(d)}" y="${H - P.b + 16}" text-anchor="middle">${fmt(d, d < 1 ? 1 : 0)}</text>`; }
  g += `<text x="${(P.l + W - P.r) / 2}" y="${H - 4}" text-anchor="middle">Fahrzeuge je km² (log.)</text><text x="12" y="${P.t + (H - P.t - P.b) / 2}" text-anchor="middle" transform="rotate(-90 12 ${P.t + (H - P.t - P.b) / 2})">Fahrten je Fzg. und Tag</text>`;
  const P2 = pts.map(p => ({ ...p, px: X(p.density), py: Y(p.rvd) }));
  // Beschriftung sparsam: gewählte Stadt, höchste Quote, höchste Dichte
  const lab = new Set([scope && P2.findIndex(p => p.ags === scope), P2.indexOf(R.sortRows(P2, 'rvd', 'desc')[0]), P2.indexOf(R.sortRows(P2, 'density', 'desc')[0])].filter(i => i != null && i >= 0));
  const dots = P2.map((p, i) => `<circle data-i="${i}" cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="${p.ags === scope ? 6 : 4.5}" class="${p.ags === scope ? 'sel-pt' : ''}"/>`).join('');
  const placed = []; const labels = [...lab].map(i => { const p = P2[i]; const right = p.px < W - 160; const w = 7 * p.name.length + 4; const bx = right ? p.px + 9 : p.px - 9 - w; const box = [bx, p.py - 9, bx + w, p.py + 5];
    if (placed.some(q => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) return ''; placed.push(box);
    return `<text class="lab" x="${(p.px + (right ? 9 : -9)).toFixed(1)}" y="${(p.py + 4).toFixed(1)}" text-anchor="${right ? 'start' : 'end'}">${esc(p.name)}</text>`; }).join('');
  s.sc = { pts: P2, W, i: null };
  el.innerHTML = title(btn) + filterCtl(ctx, s, { minLabel: 'Mindestflotte' }) + `<div class="rp-chart"><svg class="rp-line rp-scatter" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="Streudiagramm mit ${P2.length} Gemeinden; Pfeiltasten wählen eine Gemeinde, Werte auch in der Tabellenansicht">${g}<g class="pts">${dots}</g>${labels}</svg></div>` + note;
}
const EXTRA_CSS_2 = `
svg.rp-bars .bar{fill:var(--accent)}svg.rp-bars .hit{fill:transparent}svg.rp-bars g.on .bar{fill:color-mix(in oklab,var(--accent) 72%,var(--fg))}
svg.rp-bars .lim{stroke:var(--fg-2);stroke-width:1.5;stroke-dasharray:5 4}
.rp-seg{display:inline-flex;border:1px solid var(--line-2);border-radius:var(--r-sm);overflow:hidden}.rp-seg button{border:0;border-radius:0;background:transparent}.rp-seg button[aria-pressed="true"]{background:color-mix(in srgb,var(--accent) 16%,var(--panel));color:var(--fg);font-weight:600}
svg.rp-scatter .pts circle{fill:color-mix(in srgb,var(--accent) 78%,transparent);stroke:var(--panel);stroke-width:2}
svg.rp-scatter .pts circle.sel-pt{fill:var(--accent);stroke:var(--fg);stroke-width:2}
svg.rp-scatter .pts circle.on{stroke:var(--fg);stroke-width:2.5}
`;

// ======================================================================
// 10. Gebührenrechner (Sondernutzungsgebühr)
// ======================================================================
const euro = (ctx, v) => (v == null ? '—' : `${ctx.fmt(v)} €`);
const span = (ctx, a, b) => (a == null ? '—' : a === b ? euro(ctx, a) : `${ctx.fmt(a)}–${euro(ctx, b)}`);
/**
 * Gebührenrechner: gezählte Fahrzeuge × Gebührensatz je Gemeinde aus reference.json → gebuehren (nur Sätze mit Quelle);
 * eigener Satz für die gewählte Gemeinde. Daten: reference.json (CFG.MAIN), latest.json groups.
 */
export async function renderFeeCalculator(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state } = ctx;
  if (!s.own) s.own = { rate: '', unit: 'jahr', type: 'scooter' };
  bindOnce(el, 'fee', () => {
    el.addEventListener('input', (e) => { const k = e.target.dataset?.own; if (!k) return; s.own[k] = e.target.value; const out = el.querySelector('[data-rp="ownout"]'); if (out) out.innerHTML = ownOut(s.ctx, s); });
    el.addEventListener('change', (e) => { const k = e.target.dataset?.own; if (!k) return; s.own[k] = e.target.value; const out = el.querySelector('[data-rp="ownout"]'); if (out) out.innerHTML = ownOut(s.ctx, s); });
  });
  const tok = ++s.tok;
  const title = head('Gebührenrechner', `Sondernutzungsgebühr aus gezählten Fahrzeugen × Gebührensatz · Sammler-Stand ${stamp(state.latest?.at)}`);
  if (!state.latest) { el.innerHTML = title + emptyBox('Noch kein Datenstand.', ''); return; }
  const ref = await reference(ctx); if (tok !== s.tok) return;
  const list = R.feeEstimates(ref, state.latest.groups, { ags: state.scope || 'DE' });
  const { esc, fmt } = ctx;
  const rows = list.map(e => `<tr><td>${esc(e.ort || state.latest.municipalities?.[e.ags]?.name || e.ags)}</td><td>${esc(e.types.map(typeName).join(', ') || 'alle')}</td>
    <td class="n">${e.rate ? `${e.rate.range ? `${fmt(+[].concat(e.satz)[0])}–${fmt(+[].concat(e.satz).slice(-1)[0])}` : fmt(+[].concat(e.satz)[0], 2)}${/€/.test(e.einheit || '') ? '' : ' €'}` : '—'}<div class="sub-line">${esc(e.einheit || '')}</div></td><td class="small">${esc(e.gebiet || '–')}</td>
    <td class="n">${fmt(e.count)}<div class="sub-line">${plural(e.operators.length, 'Anbieter', 'Anbieter')}</div></td><td class="n"><b>${span(ctx, e.yearMin, e.yearMax)}</b></td><td class="n">${span(ctx, e.monthMin, e.monthMax)}</td><td class="small">${safeLink(ctx, e.url, e.quelle || 'Quelle')}${e.stand ? `<div class="sub-line">Stand ${/^\d{4}-\d{2}-\d{2}$/.test(e.stand) ? dd(e.stand) : esc(e.stand)}</div>` : ''}</td></tr>`).join('');
  const table = list.length ? `<div class="tbl"><table><thead><tr><th>Stadt</th><th>Art</th><th class="n">Satz</th><th>Gebiet</th><th class="n">gezählt</th><th class="n">je Jahr</th><th class="n">je Monat</th><th>Quelle</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : emptyBox(ref?.gebuehren?.length ? 'Für dieses Gebiet ist kein Gebührensatz mit Quelle hinterlegt.' : 'Noch keine Gebührensätze mit Quelle hinterlegt.', ref?.gebuehren?.length ? `Hinterlegt: ${[...new Set(ref.gebuehren.map(g => g.ort))].map(esc).join(', ')}. Unten lässt sich ein eigener Satz rechnen.` : 'reference.json → gebuehren ist leer. Unten lässt sich ein eigener Satz rechnen.');
  const { types } = groupOptions(state.latest);
  const own = `<div class="panel-head" style="margin-top:var(--s4)"><div><h3 style="margin:0;font-size:14px">Eigener Satz</h3><div class="sub">Für Gemeinden ohne Satz mit Quelle – Ergebnis ist eine eigene Rechnung, keine Angabe der Stadt</div></div></div>
    <div class="rp-ctl rp-noprint"><label>Satz <input type="number" data-own="rate" min="0" step="0.5" value="${esc(s.own.rate)}" placeholder="z. B. 50" style="width:7em" aria-label="Eigener Gebührensatz in Euro"> €</label>
    <label>je Fahrzeug und <select data-own="unit"><option value="jahr"${s.own.unit === 'jahr' ? ' selected' : ''}>Jahr</option><option value="monat"${s.own.unit === 'monat' ? ' selected' : ''}>Monat</option></select></label>
    <label>Fahrzeugart <select data-own="type">${types.map(t => `<option value="${esc(t)}"${t === s.own.type ? ' selected' : ''}>${esc(typeName(t))}</option>`).join('')}</select></label></div>
    <div data-rp="ownout" aria-live="polite" style="margin-top:var(--s2)">${ownOut(ctx, s)}</div>`;
  el.innerHTML = title + `<div class="note small" style="margin-bottom:var(--s3)">Gezählt = Fahrzeuge der Art, die die offenen Feeds in der Gemeinde gerade melden (inkl. gesperrter). Gilt ein Satz nur für einen Teil der Stadt oder nach Zonen gestaffelt, ist das Ergebnis eine Spanne bzw. Obergrenze – die Zuordnung zu Zonen ist ohne Zonengeometrie nicht prüfbar. Anbieter ohne offenen Feed fehlen.</div>` + table + own;
}
function ownOut(ctx, s) {
  const { state, fmt, esc } = ctx; const scope = state.scope;
  const rate = parseFloat(String(s.own.rate).replace(',', '.'));
  if (!scope || scope === 'DE') return '<span class="muted small">Gemeinde oben unter „Gebiet“ wählen, um den eigenen Satz zu rechnen.</span>';
  const count = Object.entries(state.latest?.groups || {}).filter(([k]) => { const [a, , t] = k.split('|'); return a === scope && t === s.own.type; }).reduce((a, [, g]) => a + (g.total || 0), 0);
  const name = state.latest?.municipalities?.[scope]?.name || scope;
  if (!Number.isFinite(rate)) return `<span class="muted small">${esc(name)}: ${fmt(count)} ${esc(typeName(s.own.type))} gezählt – Satz eingeben.</span>`;
  const r = R.ownFee(rate, s.own.unit, count);
  return `<div class="tiles">${tile(`${esc(name)} · ${esc(typeName(s.own.type))}`, fmt(count), 'gezählte Fahrzeuge')}${tile('je Jahr', euro(ctx, r.year), `${fmt(rate, 2)} € je Fahrzeug und ${s.own.unit === 'monat' ? 'Monat' : 'Jahr'} · eigener Satz`)}${tile('je Monat', euro(ctx, r.month), 'eigener Satz, ohne Quelle')}</div>`;
}

// ======================================================================
// 11. Steckbrief Regulierung
// ======================================================================
/** Steckbrief je Stadt aus reference.json (Obergrenzen, Gebühren, Referenzwerte) und Anbieter laut Daten; bei 'DE' alle Städte mit Eintrag */
export async function renderRegulationProfile(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc, fmt } = ctx; const tok = ++s.tok;
  const title = head('Steckbrief Regulierung', 'Obergrenzen, Gebühren und Referenzwerte mit Quelle; Anbieter laut offenen Feeds');
  if (!state.latest) { el.innerHTML = title + emptyBox('Noch kein Datenstand.', ''); return; }
  const ref = await reference(ctx); if (tok !== s.tok) return;
  if (!ref) { el.innerHTML = title + emptyBox('Referenzwerte nicht ladbar.', 'reference.json fehlt oder ist nicht erreichbar.'); return; }
  const profs = R.regulationProfiles(ref, state.latest, { ags: state.scope || 'DE', asOf: state.latest.at || Date.now() });
  const src = (e) => safeLink(ctx, e.url, e.quelle || 'Quelle');
  const card = (p) => {
    const caps = p.caps.map(c => `${fmt(c.limit)} ${esc(typeName(c.type))} gesamt${c.perOperator != null ? `, ${fmt(c.perOperator)} je Anbieter` : ''}${c.districts.length ? `; ${c.districts.map(d => `${esc(d.label)} ${fmt(d.limit)}`).join(', ')}` : ''}${c.previous != null ? ` <span class="muted">(ab ${dd(c.since)}; davor ${fmt(c.previous)})</span>` : ''} · ${badge(c.status)} ${fmt(c.total)} gezählt · ${src(c)}`).join('<br>') || '<span class="muted">nicht hinterlegt</span>';
    const fees = p.fees.map(f => `${esc([].concat(f.satz).join('–'))} ${esc(f.einheit || '')} · ${esc([].concat(f.type || []).map(typeName).join(', '))}${f.gebiet ? ` · ${esc(f.gebiet)}` : ''} · ${src(f)}`).join('<br>') || '<span class="muted">kein Satz mit Quelle hinterlegt</span>';
    const ops = Object.entries(p.operators).sort((a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0])).map(([ty, l]) => `${esc(typeName(ty))}: ${l.length} <span class="muted">(${l.map(esc).join(', ')})</span>`).join('<br>') || '<span class="muted">keine Fahrzeuge in offenen Feeds</span>';
    const refs = p.refs.map(r => { const v = r.kind === 'fahrt' ? tripTxt(ctx, r) : fmt(r.wert, r.kind === 'rvd' ? 2 : 0);
      return `${({ rvd: 'Fahrten je Fzg. und Tag', flotte: fleetLabel(r), fahrt: 'Fahrt', fahrten: 'Fahrten' })[r.kind]} ${esc(typeName(r.type))}: ${v} <span class="muted">(${esc(r.zeitraum || r.stand || '')})</span> · ${src(r)}`; }).join('<br>') || '<span class="muted">keine</span>';
    return `<div class="card"><b>${esc(p.name)}${p.state ? ` <span class="muted">(${esc(p.state)})</span>` : ''}</b><div class="foot">AGS ${esc(p.ags)}${p.pop ? ` · ${fmt(p.pop)} Einwohner` : ''}</div>
      <dl><dt>Obergrenzen</dt><dd>${caps}</dd><dt>Gebühren</dt><dd>${fees}</dd><dt>Anbieter laut Daten</dt><dd>${ops}</dd><dt>Referenzwerte</dt><dd>${refs}</dd><dt>Unfälle</dt><dd><span class="muted">keine Karte: der <a href="https://unfallatlas.statistikportal.de/" target="_blank" rel="noopener">Unfallatlas</a> führt E-Scooter nicht als eigene Kategorie (Merkmale nur Rad, Pkw, Fuß, Kraftrad, Güterkraftfahrzeug, Sonstige; <a href="https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/DSB_Unfallatlas_EN.pdf" target="_blank" rel="noopener">Datensatzbeschreibung</a>)</span></dd></dl></div>`;
  };
  el.innerHTML = title + (profs.length ? `<div class="rp-prof">${profs.map(card).join('')}</div>` : emptyBox('Keine Regulierungsangaben hinterlegt.', 'reference.json enthält für dieses Gebiet keinen Eintrag.'))
    + `<div class="muted small" style="margin-top:var(--s2)">Nur Angaben, die in der verlinkten Quelle stehen. „Anbieter laut Daten“ zählt Anbieter mit Fahrzeugen in offenen Feeds; Anbieter ohne Feed fehlen.</div>`;
}

// ======================================================================
// 12. Hotspot-Stabilität
// ======================================================================
/**
 * Überlappung der Top-200-Startzellen zwischen beobachteten Tagen der gewählten Gemeinde (Tag-zu-Tag-Stabilität,
 * keine Validierung gegen Betreiberdaten). Daten: events/index.json (cellDays), cells/<Tag>/<Land>.json, events/<Tag>.json (Beobachtung).
 */
export async function renderHotspotStability(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc, fmt } = ctx; const tok = ++s.tok;
  const title = head('Hotspot-Stabilität', `Überlappung der Top-200-Startzellen zwischen den Tagen · Tag-zu-Tag-Stabilität, keine Validierung gegen Betreiberdaten`);
  if (!state.latest) { el.innerHTML = title + emptyBox('Noch kein Datenstand.', ''); return; }
  if (!state.scope || state.scope === 'DE') { el.innerHTML = title + emptyBox('Gemeinde wählen.', 'Die Stabilität wird je Gemeinde aus den Zellen (≈ 280 × 250 m) berechnet.'); return; }
  el.classList.add('rp-busy');
  try {
    const ags = state.scope, land = state.latest.municipalities?.[ags]?.state; const idx = await usageIndex(ctx);
    const days = (idx.cellDays || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const [cdocs, edocs] = await Promise.all([Promise.all(days.map(d => cellsDoc(ctx, idx, d, land))), Promise.all(days.map(d => ((idx.days || []).includes(d) ? eventsDoc(ctx, idx, d) : null)))]);
    if (tok !== s.tok) return;
    const cells = Object.fromEntries(days.map((d, i) => [d, cdocs[i]?.munis?.[ags] || null]));
    const stb = R.hotspotStability(cells, { top: 200 });
    const obs = Object.fromEntries(days.map((d, i) => [d, edocs[i] ? R.hourQuality(edocs[i].runs, edocs[i].gapHours) : null]));
    const oh = (d) => (obs[d] ? `${fmt(obs[d].obsMin / 60, 1)} h` : '–');
    const thin = stb.pairs.some(p => !obs[p.a]?.full || !obs[p.b]?.full);
    const tiles = `<div class="tiles">${tile('Ø Überlappung', stb.meanShare == null ? '—' : pctTxt(ctx, stb.meanShare, 0), `gemeinsame Top-Zellen ÷ kleinere Top-Menge${thin ? ' · vorläufig' : ''}`)}${tile('Tagespaare', fmt(stb.pairs.length), `${plural(stb.days.length, 'Tag', 'Tage')} mit Zellen`)}${tile('Top-Zellen je Tag', `bis ${stb.top}`, `nur Zellen mit ≥ ${stb.minCount} Fahrtbeginnen`)}</div>`;
    const rows = stb.pairs.map(p => `<tr><td>${dd(p.a)} → ${dd(p.b)}</td><td class="n">${fmt(p.nA)} / ${fmt(p.nB)}</td><td class="n">${fmt(p.common)}</td><td class="n"><b>${pctTxt(ctx, p.share, 0)}</b></td><td class="n">${pctTxt(ctx, p.jaccard, 0)}</td><td class="n">${oh(p.a)} / ${oh(p.b)}</td></tr>`).join('');
    el.innerHTML = title + tiles + (stb.pairs.length ? `<div class="tbl" style="margin-top:var(--s3)"><table><thead><tr><th>Tage</th><th class="n">Top-Zellen</th><th class="n">gemeinsam</th><th class="n">Überlappung</th><th class="n">Jaccard</th><th class="n">beobachtet</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyBox('Erst ein Tag mit Zellen.', 'Die Überlappung braucht mindestens zwei beobachtete Tage.'))
      + `<div class="note small" style="margin-top:var(--s3)">Maß wie bei der Validierung von Fraunhofer IAO/TUM (Überlappung der stärksten Startzellen), hier nur als Tag-zu-Tag-Stabilität der eigenen Messung – kein Abgleich mit Betreiberdaten. Hohe Werte heißen: die Nachfrage-Schwerpunkte liegen jeden Tag an denselben Orten. Tage mit kurzer Beobachtung (${thin ? 'hier der Fall' : 'unter 20 Stunden'}) senken die Überlappung.</div>`;
  } catch (e) { console.error('Hotspots', e); if (tok === s.tok) el.innerHTML = title + emptyBox('Nicht berechenbar.', 'Zellendateien nicht ladbar.'); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}
