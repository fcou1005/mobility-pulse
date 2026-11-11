// Mobility Pulse — Bericht: Kommunal-Bericht (druckbar, CSV), Obergrenzen-Wächter, Heatmap Stunde × Wochentag,
// Preisänderungs-Log und Feed-Prüfung. Eigenständiges Modul; app.js übergibt
// ctx = { state, CFG, esc, fmt, getJson, opColor, muniName } und optional loadUsageIndex, loadEvents, loadHistory, loadCells (geteilter Cache).
// Rechenlogik in pulse-report.js; alle Werte aus Daten gehen durch ctx.esc, Tooltip-Texte über textContent.
import * as R from './pulse-report.js?v=mwcichl2';
import * as K from './pulse-calib.js?v=mwcichl2';
import { VEHICLE_TYPE_LABEL } from './pulse-core.js?v=mwcichl2';
import { decodeFleet } from './pulse-ops.js?v=mwcichl2';
import { t, tx, tMap, lang, dateFmt, fmtLocale } from './i18n.js?v=mwcichl2';
import { mapKeys } from './mapkeys.js?v=mwcichl2';
import { weatherFor, weatherSvg, WX_CSS } from './weather.js?v=mwcichl2';
import { maturity as mbMaturity, measureBase as mbMeasureBase, measureDay as mbMeasureDay, dayType as mbDayType, DAY_TYPES as MB_TYPES } from './pulse-econ.js?v=mwcichl2';

const S = new WeakMap(); // Element → { ctx, tok, period, show }
// Teilbare Ansicht: ?period=… bzw. ?day=… (nur geprüfte Formen; unbekannte Werte fallen auf den Standard zurück)
const urlParam = (k) => { try { const v = new URLSearchParams(location.search).get(k); return v && /^[A-Za-z0-9:_-]{1,20}$/.test(v) ? v : null; } catch { return null; } };
const urlSet = (k, v) => { try { const q = new URLSearchParams(location.search); if (v && v !== 'all') q.set(k, v); else q.delete(k); const qs = q.toString().replace(/%3A/gi, ':'); history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`); } catch { /* file:// o. Ä. */ } };
const st = (el) => { let s = S.get(el); if (!s) { s = { tok: 0, period: urlParam('period') || 'all', show: {} }; S.set(el, s); } return s; };
const CACHE = new Map();
// Datum, Uhrzeit, Wochentage, Fahrzeugart, Zeitraum-Art und Quellstatus in der Sprache der Seite (Formatierer je Sprache gecacht)
const stamp = (ms) => (ms ? dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: R.TZ }).format(new Date(ms)) : '–');
const hhmm = (ms) => (ms ? dateFmt({ hour: '2-digit', minute: '2-digit', timeZone: R.TZ }).format(new Date(ms)) : '–');
const dd = (day) => (/^\d{4}-\d{2}-\d{2}$/.test(day || '') ? dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`)) : R.dayLabel(day));
const dm = (day) => (/^\d{4}-\d{2}-\d{2}$/.test(day || '') ? dateFmt({ day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`)) : String(day || ''));
const TYPE = tMap('type', VEHICLE_TYPE_LABEL);
const WD = () => (lang() === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : R.WEEKDAYS);
const WDL = () => (lang() === 'en' ? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] : R.WEEKDAYS_LONG);
const PKIND = (k) => ({ Monat: t('rep.month'), Quartal: t('rep.quarter2'), Tage: t('rep.days') }[k] || k);
const CAPSRC = tMap('capsrc', R.CAP_SOURCE_STATUS);
const sum = (a) => (a || []).reduce((x, y) => x + (y || 0), 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const typeName = (tq) => TYPE[tq] || tq;

// ---------- Laden (ein Download je Datei; Dateien des laufenden Tags mit Laufstempel, damit neue Sammler-Läufe ankommen) ----------
// Bietet die Seite einen gemeinsamen Cache an (ctx.sharedCache, app.js leert ihn bei jedem neuen Lauf zusammen mit CACHE), laufen
// Dateien des Datenstands ohne Stempel über ctx.getJson: dann teilen Bericht, Quellen und Leistung denselben Download (z. B. pricing.json)
function fetchJson(ctx, file, fresh = false, base = ctx.CFG.DATA) {
  const at = ctx.state?.latest?.at || '';
  const url = base + file + (fresh && at && !(ctx.sharedCache && base === ctx.CFG.DATA) ? `?t=${at}` : '');
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
// Art der Zahl („Höchstzahl (Sondernutzungserlaubnis)“): englische Fassung aus reference.json → artEn je Eintrag (lib/pulse-report.js reicht nur art weiter)
const ART_EN = new Map();
const reference = (ctx) => fetchJson(ctx, 'reference.json', false, ctx.CFG.MAIN).then((ref) => {
  for (const e of [...(ref?.obergrenzen || []), ...(ref?.flotte || [])]) if (typeof e?.art === 'string' && typeof e.artEn === 'string') { ART_EN.set(`${e.ags}|${e.art}`, e.artEn); if (!ART_EN.has(e.art)) ART_EN.set(e.art, e.artEn); }
  return ref;
});
// Englisch: artEn (sachlich übersetzt); Deutsch: wie in der Quelle, als Name/Zitat gekennzeichnet
const artTxt = (esc, c) => { const en = lang() === 'en' ? ART_EN.get(`${c.ags}|${c.art}`) || ART_EN.get(c.art) : null; return en ? esc(en) : `<span translate="no">${esc(c.art)}</span>`; };
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
  const key = `${ctx.state?.latest?.at || ''}|${lang()}`; // Texte der Kalibrierung je Sprache
  if (!CALIB_CACHE.has(key)) CALIB_CACHE.set(key, (async () => {
    const ref = await reference(ctx);
    const idx = await usageIndex(ctx); const days = (idx.days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-CALIB_DAYS);
    const [hidx, daily] = await Promise.all([histIndex(ctx), dailyDoc(ctx)]);
    const [docs, hs] = await Promise.all([Promise.all(days.map(d => eventsDoc(ctx, idx, d))), Promise.all(days.map(d => histFor(ctx, hidx, daily, d)))]);
    const ok = docs.map((d, i) => [d, days[i], hs[i]]).filter(([d]) => d);
    const D = ok.map(x => x[0]), H = Object.fromEntries(ok.filter(x => x[2]).map(x => [x[1], x[2]]));
    const latest = ctx.state?.latest || null; const limits = K.rvdLimits(ref);
    // k nur aus plausiblen Berliner Anbietern; Vergleichswerte Deutschland/Voi ohne Überzählungen; Gemeinden (Frankfurt) roh, damit die Prüfung sie zeigt
    // Bruchmarken (daily.json → breaks) und Kennungsart je Gruppe (Z3c); ab 7 vollen Regelstand-Tagen misst k nur Tage mit diesem Regelstand
    const breaks = daily?.breaks || null, kinds = K.groupKinds(D, latest?.sources || []);
    const bRep = (docs) => (docs.length ? R.municipalReport({ docs, hists: H, ags: K.BERLIN, type: 'scooter', latestGroups: null, rvdLimit: limits, eventChecks: latest?.eventChecks, breaks }) : null); // Ampel rot: nicht in k
    let berlinReport = bRep(D); const bq = berlinReport?.quality;
    if (bq?.rule && bq.ruleFullDays >= K.CALIB.minDays) { const same = D.filter(d => R.docRule(d) === bq.rule); if (same.length && same.length < D.length) berlinReport = bRep(same); }
    // Bruchmarken auch in der Rohzeile (raw): Tage vor dem Regelwechsel sind falsch gezählt, keine Plausibilitätsprüfung
    const all = D.length ? R.cityRanking(D, H, latest, { type: 'scooter', minFleet: 0, rvdLimit: limits, eventChecks: latest?.eventChecks, breaks }) : { rows: [] };
    const raw = D.length ? R.cityRanking(D, H, latest, { type: 'scooter', minFleet: 0, breaks }) : { rows: [] };
    const voi = D.length ? R.cityRanking(D, H, latest, { type: 'scooter', operator: 'Voi', minFleet: 0, rvdLimit: limits, eventChecks: latest?.eventChecks, breaks }) : { rows: [] };
    // Kennungsart der E-Scooter je Gemeinde, bundesweit und Voi: k nur bei derselben Art wie die Berliner Referenz
    const kindsOf = (pred) => K.commonKind(Object.entries(kinds).filter(([key]) => { const [a, op, ty] = key.split('|'); return ty === 'scooter' && pred(a, op); }).map(([, v]) => v));
    const byAgs = Object.fromEntries(raw.rows.map(r => [r.ags, { rvd: r.rvd, fleet: r.fleet, ridesDay: r.ridesDay, kind: kindsOf((a) => a === r.ags) }]));
    const own = { national: { ...natRvd(all.rows), kind: kindsOf(() => true) }, voi: { ...natRvd(voi.rows), kind: kindsOf((a, op) => op === 'Voi') }, byAgs };
    const c = K.calibration(ref, { berlinReport: berlinReport && berlinReport.groups.length ? berlinReport : null, groups: latest?.groups, own, lang: lang(), kinds });
    // Plausibilitätsprobe je Stadt (reference.rvd mit ags, alle Arten, z. B. Düsseldorf): Kommunal-Bericht mit Bruchmarken, kalibriert wie der Bericht
    own.byAgsAll = {};
    for (const e of (ref?.rvd || []).filter(x => x.ags && x.ags !== K.BERLIN && x.type === 'all')) {
      const rp = D.length ? R.municipalReport({ docs: D, hists: H, ags: e.ags, pop: latest?.municipalities?.[e.ags]?.pop || null, rvdLimit: limits, eventChecks: latest?.eventChecks, breaks }) : null; if (!rp) continue;
      const cr = K.calibrateReport(rp, c.k, { limits, kinds }), ct = cr.applied ? cr.totals : null;
      own.byAgsAll[e.ags] = { rvd: rp.totals.rvd, per1000Fleet: rp.totals.per1000Fleet, per1000Rides: rp.totals.per1000Rides, rvdCal: ct?.rvd ?? null, per1000RidesCal: ct?.per1000Rides ?? null, breaks: rp.quality.breaks };
    }
    c.checks = K.plausibilityChecks(ref, own, c.k, lang());
    return { ...c, ref, own, days: ok.map(x => x[1]), berlinReport, breaks };
  })().catch(e => { console.error('Kalibrierung', e); return { assume: K.rideAssumptions(null, lang()), limits: {}, k: { applied: false, status: 'off', statusText: t('rep.calibrationCannotBeComputed'), reason: t('rep.calibrationCannotBeComputed') }, kinds: {}, coverage: [], checks: [], ref: null, own: {}, days: [], hasReference: false }; }));
  return CALIB_CACHE.get(key);
}
// Kurzbeschreibung des Faktors für Notizen und CSV, z. B. „Berlin Q4/2025 · vorläufig“
export const SUSPENDED_TXT = R.SUSPENDED;
export const calibLabel = (k) => (k?.applied ? t('rep.berlin', { quarter: k.quarter, v1: k.prelim ? ` · ${t('rep.preliminary')}` : '' }) : '');

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
.rp-week .rl{font-size:12px;color:var(--fg-2);display:flex;align-items:center;justify-content:space-between;gap:4px;padding-right:6px;white-space:nowrap}
.rp-week .rl small{color:var(--muted);font-family:var(--mono);font-size:10.5px}
.rp-week .hl{font-family:var(--mono);font-size:10px;color:var(--muted);line-height:1;padding:0 0 4px}
.rp-week .rl,.rp-week .rp-row:first-child>.hl:first-child{position:sticky;left:0;z-index:1;background:var(--panel)}
.rp-weekwrap.rp-more-r{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 36px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 36px),transparent)}.rp-scrollhint{margin:var(--s1) 0 0;font-size:12px;color:var(--muted)}.rp-scrollhint[hidden]{display:none}
@media (max-width:520px){.rp-week{grid-template-columns:60px repeat(24,minmax(15px,1fr))}}
.rp-tilewrap{container-type:inline-size}
.rp-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
@container (min-width:600px){.rp-tiles{grid-template-columns:repeat(var(--rp-cols,4),minmax(0,1fr))}}
@container (max-width:599.98px){.rp-tiles>.tile:last-child:nth-child(odd){grid-column:1/-1}}
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
.rp-status.ok i{background:var(--ok)}.rp-status.near i{background:var(--warn)}.rp-status.over i,.rp-status.below i{background:var(--bad)}
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
function prep(el, ctx) { injectStyle(); bindJump(); el.classList.add('rp-root'); const s = st(el); s.ctx = ctx; return s; }

// ---------- Bausteine ----------
const head = (title, sub, right = '') => `<div class="panel-head"><div><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right}</div>`;
const tile = (l, v, s) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const emptyBox = (b, tq) => `<div class="empty"><b>${b}</b>${tq}</div>`;
// Beschreibungen aus data/reference.json (Teilgebiete, Hinweise, Art der Zahl) stehen wie in der Quelle: als Name/Zitat gekennzeichnet
const srcTxt = (esc, s) => `<span translate="no">${esc(s)}</span>`;
const STATUS_DEF = () => ({ ok: ['✓', 'ok'], near: ['!', t('rep.nearStatus')], over: ['✕', t('rep.over')], below: ['✕', t('zv.below')], hintUpper: ['i', t('zv.hintUpper')], unchecked: ['?', t('rep.notCheckable')], unknown: ['–', t('rep.noLimit')], hint: ['i', t('rep.noteCalculatedFigure')], info: ['i', t('rep.informationOnly')], none: ['–', t('rep.noLimitAccordingToSource')], unlicensed: ['–', t('rep.notLicensedAccordingToSource')] });
const badge = (s) => `<span class="rp-status ${s === 'hintUpper' ? 'hint' : s}"><i aria-hidden="true">${STATUS_DEF()[s][0]}</i>${STATUS_DEF()[s][1]}</span>`, badge0 = badge;
const safeLink = (ctx, url, label) => (/^https?:\/\//i.test(String(url || '')) ? `<a href="${ctx.esc(url)}" target="_blank" rel="noopener">${ctx.esc(label)}</a>` : ctx.esc(label));
const rampSpans = (from = 1, to = 8) => Array.from({ length: to - from + 1 }, (_, i) => `<span class="rp-s${from + i}"></span>`).join('');
const pctTxt = (ctx, v, d = 1) => (v == null ? '—' : `${ctx.fmt(v * 100, d)} %`);
const num = (ctx, v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : ctx.fmt(v, d));
const cnt = (ctx, v) => (R.suppressed(v) ? `&lt; ${R.MIN_COUNT}` : num(ctx, v)); // Fahrten-Zählung mit Datenschutz-Schwelle
const kmTxt = (ctx, v) => (v == null ? null : `${ctx.fmt(v, 2)} km`);
const minTxt = (ctx, v) => (v == null ? null : t('rep.min', { v0: ctx.fmt(v, 1) }));
function bindOnce(el, kind, fn) { if (el.dataset.rpBound === kind) return; el.dataset.rpBound = kind; fn(); }

// Tooltip: ein Element je Diagramm, Inhalt über textContent; Wert zuerst, Beschriftung danach
function tip(box) { let tq = box.querySelector(':scope > .rp-tip'); if (!tq) { tq = document.createElement('div'); tq.className = 'rp-tip'; tq.hidden = true; box.appendChild(tq); } return tq; }
function showTip(box, target, value, label) {
  const tq = tip(box); tq.replaceChildren(); const b = document.createElement('b'); b.textContent = value; tq.append(b);
  for (const l of [].concat(label || [])) { const d = document.createElement('div'); d.textContent = l; tq.append(d); }
  tq.hidden = false;
  const r = target.getBoundingClientRect(), w = box.getBoundingClientRect();
  const x = Math.max(tq.offsetWidth / 2 + 4, Math.min(w.width - tq.offsetWidth / 2 - 4, r.left - w.left + r.width / 2));
  let y = r.top - w.top; if (y - tq.offsetHeight - 10 < 0) y = r.bottom - w.top + tq.offsetHeight + 16;
  tq.style.left = `${x}px`; tq.style.top = `${y}px`;
}
const hideTip = (box) => { const tq = box.querySelector(':scope > .rp-tip'); if (tq) tq.hidden = true; };
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
function download(name, text, type = 'text/csv;charset=utf-8') {
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
async function archiveDayList(ctx) {
  const ai = await archIndex(ctx); const months = (ai?.months || []).filter(m => /^\d{4}-\d{2}$/.test(m)).sort(); if (!months.length) return [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(ai.firstDay || '')) {
    const last = ctx.state?.latest?.at ? R.berlinDay(ctx.state.latest.at) : `${lastOf(months)}-28`; const out = [];
    for (let tq = Date.parse(`${ai.firstDay}T12:00:00Z`), end = Date.parse(`${last}T12:00:00Z`); tq <= end && out.length < 4000; tq += 86400e3) out.push(new Date(tq).toISOString().slice(0, 10));
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
function tripTxt(ctx, r) {
  const one = (unit, mean, med, lo, hi) => [lo != null && hi != null ? `${fd(ctx, lo)}–${fd(ctx, hi)} ${unit}` : null, med != null ? t('rep.median', { v0: fd(ctx, med), unit }) : null, mean != null ? `Ø ${fd(ctx, mean)} ${unit}` : null].filter(Boolean).join(', ');
  return [one('km', r.kmMittel, r.kmMedian, r.kmMin, r.kmMax), one(t('rep.min2'), r.minMittel, r.minMedian, r.minMin, r.minMax)].filter(Boolean).join(' · ');
}
// Flotte laut Quelle: Berlin genehmigt (Abgeordnetenhaus), München aktiv (Stadtrat: keine Genehmigungspflicht)
const fleetLabel = (r) => (r?.art === 'genehmigt' ? t('rep.licensedFleet') : r?.art === 'aktiv' ? t('rep.activeFleet') : t('rep.fleet'));
function referenceRows(ctx, ref, rep, cal = null) {
  if (!ref || !rep.ags) return '';
  const own = scooterAgg(rep, cal); const rows = []; const client = isClient();
  const src = (r) => safeLink(ctx, r.url, r.quelle || t('rep.source'));
  const ownRvd = (r) => { if (r.type !== 'scooter' || own?.rvd == null) return '—'; if (client) return num(ctx, own.rvdCal ?? own.rvd, 2); return `${num(ctx, own.rvd, 2)}${own.rvdCal != null ? `<div class="sub-line">${t('rep.calibrated', { ctx: num(ctx, own.rvdCal, 2) })}</div>` : ''}`; };
  // Stadtwerte über alle Arten (Düsseldorf, SMM-CPI): eigene Summen nur ohne Anbieter-/Artfilter vergleichbar; Hinweis „Jahresmittel, alle Arten, MDS“
  const allOk = ctx.state.operator === 'all' && ctx.state.type === 'all', tq = rep.totals, ct = cal?.applied ? cal.totals : null;
  const ownAll = (v, vc, d) => (!allOk || v == null ? '—' : client ? num(ctx, vc ?? v, d) : `${num(ctx, v, d)}${vc != null ? `<div class="sub-line">${t('rep.calibrated', { ctx: num(ctx, vc, d) })}</div>` : ''}`);
  const tyName = (r) => (r.type === 'all' ? t('rep.allVehicleTypes') : typeName(r.type));
  for (const r of (ref.rvd || []).filter(x => x.ags === rep.ags)) {
    const hint = r.type === 'all' && r.hinweis ? `<div class="sub-line"><span translate="no">${ctx.esc(r.hinweis)}</span></div>` : '';
    rows.push([t('rep.tripsPerVehiclePerDay', { typeName: ctx.esc(tyName(r)) }) + hint, num(ctx, r.wert, 2), ctx.esc(r.zeitraum || ''), src(r), r.type === 'all' ? ownAll(tq.rvd, ct?.rvd, 2) : ownRvd(r)]);
    if (r.type === 'all' && r.flotteJe1000 != null) rows.push([`${t('rep.vehiclesPer1000Residents')} · ${ctx.esc(tyName(r))}`, num(ctx, r.flotteJe1000, 1), ctx.esc(r.zeitraum || ''), src(r), ownAll(tq.per1000Fleet, null, 1)]);
    if (r.type === 'all' && r.fahrtenJe1000 != null) rows.push([`${t('rep.tripsPer1000ResidentsAndDay')} · ${ctx.esc(tyName(r))}`, num(ctx, r.fahrtenJe1000, 1), ctx.esc(r.zeitraum || ''), src(r), ownAll(tq.per1000Rides, ct?.per1000Rides, 1)]);
  }
  for (const r of (ref.fahrt || []).filter(x => x.ags === rep.ags)) rows.push([t('rep.trip', { typeName: ctx.esc(typeName(r.type)) }), tripTxt(ctx, r), ctx.esc(r.zeitraum || ''), src(r), [kmTxt(ctx, own?.avgKm), minTxt(ctx, own?.avgMin)].filter(Boolean).join(' · ') || t('rep.notMeasurable')]);
  for (const r of (ref.flotte || []).filter(x => x.ags === rep.ags)) rows.push([`${fleetLabel(r)} · ${ctx.esc(typeName(r.type))}`, num(ctx, r.wert), r.stand ? dd(r.stand) : '', src(r), own ? `${t('rep.inOpenFeeds', { ctx: num(ctx, own.fleet) })}<div class="sub-line">${pctTxt(ctx, own.fleet / r.wert, 1)} ${r.art === 'genehmigt' ? t('rep.ofLicensedFleetLowerBoundOf') : r.art === 'aktiv' ? t('rep.ofActiveFleet') : t('rep.ofFleetAccordingToSource')}</div>` : '—']);
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
  const skip = cal?.skipped?.length ? ` · ${t('cal.skipped', { v0: ctx.esc([...new Set(cal.skipped.map(x => `${x.op} (${K.kindText(x.kind, lang())})`))].join(', ')) })}` : '';
  return `${ctx.esc(k.statusText || '')} · ${ctx.esc(k.onlyKind || '')}${skip} · ` + t('rep.eScooterTripsRangeOfficial', { k: fmt(k.k, 2), kLow: fmt(k.kLow, 2), kHigh: fmt(k.kHigh, 2), quarter: ctx.esc(k.quarter), wert: fmt(k.ref.wert, 2), rvd: fmt(m.rvd, 2), source: ctx.esc(k.source), v7: plural(m.days, t('rep.day'), t('rep.days')), v8: pctTxt(ctx, k.obsShare, 0), v9: dd(m.from), v10: dd(m.to), rule: ctx.esc(k.rule), v12: k.prelim ? ` · ${t('rep.preliminary2')} <span class="muted">(${ctx.esc(k.prelimWhy.join(', '))})</span>` : '', v13: k.single ? ` · <span class="muted">${t('rep.limitation', { single: ctx.esc(k.single) })}</span>` : '', v14: m.excluded?.length ? ` · <span class="muted">${t('rep.excludedOvercount', { join: ctx.esc(m.excluded.map(x => x.op).join(', ')) })}</span>` : '', meta_lim: fmt(meta_lim(calib), 2), v16: safeLink(ctx, k.ref.url, k.ref.quelle || t('rep.source')) });
}
function qualityBlock(ctx, rep, extra) {
  const q = rep.quality, { fmt, esc } = ctx; const arch = q.source === 'archiv';
  const obsH = q.obsMin / 60, possH = q.possibleMin / 60;
  const gaps = q.gaps.slice(0, 4).map(g => `${dm(g.day)} ${g.from != null ? `${hhmm(g.from)}–` : `${t('rep.to')} `}${hhmm(g.at)}${g.ms ? ` (${fmt(g.ms / 3600e3, 1)} h)` : ''}`).join(' · ');
  const items = [
    [t('rep.observation'), t('rep.hOfH', { obsH: fmt(obsH, 1), possH: fmt(possH), v2: pctTxt(ctx, possH ? obsH / possH : null, 0), v3: arch ? t('rep.dailyValuesFromLongTerm') : plural(q.runs, t('rep.collectorRun'), t('rep.collectorRuns')) })],
    [t('rep.fullMeasurementDays'), `${t('rep.of', { fullDays: q.fullDays, days: q.days })} <span class="muted">${t('rep.hoursWithMinOfObservation', { FULL_DAY_HOURS: R.FULL_DAY_HOURS, FULL_HOUR_MIN: R.FULL_HOUR_MIN, v2: arch ? t('rep.inArchive1000ObservedMinutes') : '' })}</span>${q.prelim ? ` · ${t('rep.preliminary2')} <span class="muted">${t('rep.underFullDays', { MIN_FULL_DAYS: R.MIN_FULL_DAYS })}</span>` : ''}`],
    [t('rep.gaps'), arch ? t('rep.notStatedPerRunInArchive') : q.gapRuns ? `${t('rep.longestHNotCounted', { v0: plural(q.gapRuns, t('rep.gapRun'), t('rep.gapRuns')), v1: fmt(q.longestGapMs / 3600e3, 1), v2: plural(q.excludedHours, t('rep.hour'), t('rep.hours')) })}<div class="muted small">${gaps}${q.gaps.length > 4 ? ' …' : ''}</div>` : t('rep.noneIntervalBetweenRunsNever')],
    [t('rep.extrapolationToDay'), arch ? t('rep.tripsObservedShareOfDay', { profileSource: esc(tx(q.profileSource)) }) : t('rep.dailyProfileTripsObserved', { profileSource: esc(tx(q.profileSource)) })],
    [t('rep.fleet'), arch ? t('rep.avgVehiclesPerDayAccordingTo') : q.fleetFromHistory.length ? t('rep.vehicleMinutesObserved', { v0: q.fleetFromHistory.map(d => dm(d)).join(', ') }) : t('rep.vehicleMinutesObserved2')],
    [t('rep.durationAndDistance'), arch ? t('rep.notContainedInArchive') : t('rep.onlyWithStableVehicleIdsAnd', { MIN_TRIPS_MEASURED: R.MIN_TRIPS_MEASURED, v1: q.taintedDays.length ? t('rep.leftOutGapCounted', { v0: q.taintedDays.map(d => dm(d)).join(', ') }) : '' })],
    ...(q.incompleteGroups?.length ? [[t('rep.incompleteGroups'), t('rep.incompleteGroupsTxt', { v0: esc(q.incompleteGroups.map(k => k.replace('|', ' ')).join(', ')) })]] : []),
    ...(q.mixedRuleDays?.length ? [[t('rep.ruleVersions'), t('rep.mixedRuleDays', { v0: q.mixedRuleDays.map(d => dm(d.day)).join(', ') })]] : []),
    // Bruchmarken (Z2): je Tag die betroffenen Reihen; Tage davor zählen für sie nicht, am Bruchtag nur Stunden mit dem neuen Regelstand
    ...(q.breaks?.length ? [[t('cal.breaksTitle'), [...new Set(q.breaks.map(b => b.day))].sort().map(d => t(arch ? 'cal.breakTxtArch' : 'cal.breakTxt', { day: dd(d), v1: esc(q.breaks.filter(b => b.day === d).map(b => `${b.key.split('|')[0]} ${typeName(b.key.split('|')[1])}`).join(', ')) })).join(' · ')]] : []),
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
  const rdCell = (g) => { const c = client && cOf(g); return c ? withSpan(ctx, c.ridesDay, c.lo, c.hi) : num(ctx, g.ridesDay); };
  const rvdCell = (g) => { const c = client && cOf(g); return c ? withSpan(ctx, c.rvd, c.rvdLo, c.rvdHi, 2, true) : `<b>${num(ctx, g.rvd, 2)}</b>`; };
  const calCol = C && !client;
  const calCell = (g) => { const c = cOf(g); const sk = C?.groups.get(g.key)?.skipKind; if (sk) return `<span class="muted">${t('cal.notKind', { v0: esc(K.kindText(sk, lang())) })}</span>`; return c && c.rvd != null ? withSpan(ctx, c.rvd, c.rvdLo, c.rvdHi, 2, true) + (c.capped ? `<div class="sub-line">${t('rep.cappedAtLimit')}</div>` : '') : `<span class="muted" title="${t('rep.onlyEScootersAreCalibrated')}">—</span>`; };
  const rows = rep.groups.map(g => `<tr${g.plausible ? '' : ' class="muted"'}><td><span class="op"><i style="background:${opColor(g.op)}"></i>${esc(g.op)}</span><div class="sub-line">${esc(typeName(g.ty))}${g.fleetSource === 'aktuell' ? ` · ${t('rep.currentFleetOnly')}` : ''}</div>${g.flags.length ? `<div class="sub-line">${esc(mbFlagText(g.flags))}</div>` : ''}</td>
    <td class="n">${num(ctx, g.fleet)}${g.fleetDays.length > 1 ? `<div class="sub-line nw">${num(ctx, g.fleetMin)}–${num(ctx, g.fleetMax)}</div>` : ''}</td>${client ? '' : `<td class="n">${num(ctx, g.rides)}</td>`}<td class="n">${rdCell(g)}</td><td class="n">${rvdCell(g)}</td>${calCol ? `<td class="n">${calCell(g)}</td>` : ''}
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
    const ops = [...byOp].filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]).map(([o, v]) => `${esc(o)} ${num(ctx, v)}`).join(' · '); // Anbieter mit gerundet 0 Fahrzeugen nicht als „Zeus 0“
    const c = calDay(d);
    const rd = client && c != null ? `${num(ctx, c)}<div class="sub-line">${t('rep.eScootersCalibrated2')}</div>` : `${num(ctx, d.ridesDay)}<div class="sub-line">${t('rep.observed', { v0: pctTxt(ctx, d.coverage, 0), v1: c != null ? ` · ${t('rep.calibrated', { ctx: num(ctx, c) })}` : '' })}</div>`;
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
function cellSvgMarkup(cs, key, title) {
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
      <div><h3 style="font-size:13px;margin:0 0 var(--s1)">${t('rep.strongestPlaces')}</h3><div class="sub small muted" style="margin-bottom:var(--s1)">${t('rep.mostTripStarts')}</div><div class="tbl"><table><thead><tr><th class="n">#</th><th>${t('rep.cell')}</th><th class="n">${t('rep.starts')}</th><th class="n">${t('rep.destinations')}</th><th class="n">${t('rep.avgAvailable')}</th></tr></thead><tbody>${strong}</tbody></table></div></div>
      <div><h3 style="font-size:13px;margin:0 0 var(--s1)">${t('rep.weakestPlaces')}</h3><div class="sub small muted" style="margin-bottom:var(--s1)">${t('rep.fleetAvailableVehiclesPerRun', { WEAK_MIN_PRESENT: R.WEAK_MIN_PRESENT })}</div><div class="tbl"><table><thead><tr><th class="n">#</th><th>${t('rep.cell')}</th><th class="n">${t('rep.avgAvailable')}</th><th class="n">${t('rep.starts')}</th><th class="n">${t('rep.perVehicle')}</th></tr></thead><tbody>${weak || `<tr><td colspan="5" class="empty">${t('rep.noCellWithEnoughFleet')}</td></tr>`}</tbody></table></div></div>
    </div></section>`;
}
function reportHtml(ctx, rep, meta, ref) {
  const { esc, fmt } = ctx; const tq = rep.totals, q = rep.quality; const client = isClient();
  const k = meta.calib?.k, C = meta.cal?.applied ? meta.cal.totals : null;
  const pre = q.prelim ? ` · ${t('rep.preliminary')}` : '';
  const sources = (ctx.state.latest?.sources || []).filter(r => (r.municipalities || []).includes(rep.ags) && !['duplicate', 'retired'].includes(r.status));
  const srcTxt = sources.length ? t('rep.currentDelayedOther', { length: sources.filter(r => r.status === 'live').length, length2: sources.filter(r => r.status === 'delayed').length, length3: sources.filter(r => !['live', 'delayed'].includes(r.status)).length }) : t('rep.none');
  const gaps = (ctx.state.latest?.gaps || []).filter(g => g.city === meta.name);
  const extra = [[t('rep.sourcesInMunicipality'), t('rep.asOf', { srcTxt, v1: stamp(ctx.state.latest?.at) })]];
  if (gaps.length) extra.push([t('rep.operatorsWithoutOpenFeed'), gaps.map(g => `${esc(g.operator)}${g.since ? ` ${t('rep.since', { v0: dd(g.since) })}` : ''}`).join(', ') + ` <span class="muted">${t('rep.missingFromAllFigures')}</span>`]);
  if (meta.missing.length) extra.push([q.source === 'archiv' ? t('rep.daysWithoutArchiveValues') : t('rep.dailyFilesMissing'), meta.missing.length > 8 ? `${plural(meta.missing.length, t('rep.day'), t('rep.days'))} (${meta.missing.slice(0, 4).map(dd).join(', ')} …)` : meta.missing.map(dd).join(', ')]);
  if (q.source === 'archiv') extra.push([t('rep.period'), t('rep.extendsBeyond30DaysOfDaily', { kind: esc(PKIND(meta.period.kind)), label: esc(meta.period.label) })]);
  if (meta.calib && rep.groups.some(g => g.ty === 'scooter')) extra.push([t('rep.calibration'), calibText(ctx, meta.calib, meta.cal)]);
  // Kennzahlen mit Fahrten: kalibriert (E-Scooter × k) mit Spanne, gemessen daneben; Kundenansicht nur kalibriert
  const calTile0 = (label, v, lo, hi, d, measured, sub) => (C && v != null
    ? tile(label, num(ctx, v, d), t('rep.range', { v0: client ? '' : `${t('rep.measured', { ctx: num(ctx, measured, d) })} · `, ctx: num(ctx, lo, d), ctx2: num(ctx, hi, d), v3: client ? t('rep.calibratedToOfficialBerlin') : t('rep.eScootersCalibrated3', { calibLabel: esc(calibLabel(k)) }), v4: client ? '' : pre }))
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
  const per = meta.period && ['Quartal', 'Monat'].includes(meta.period.kind) ? `${esc(PKIND(meta.period.kind))} ${esc(meta.period.label)} · ` : '';
  const calMethod = client ? (C ? ` ${t('rep.eScooterTripsAreCalibratedTo')}` : '')
    : (C ? ` ${t('rep.calibrationMeasuredEScooter')}` : '');
  return `<article class="rp-report" aria-label="${t('rep.municipalReport', { name: esc(meta.name) })}">
    <header class="rp-head"><div><div class="rp-kicker">${t('rep.municipalReportShared')}</div><h2>${t('rep.ags', { name: esc(meta.name), ags: esc(rep.ags), v2: rep.pop ? ` · ${t('rep.residents', { pop: fmt(rep.pop) })}` : '' })}</h2>
      <p class="sub">${t('rep.periodDataAsOfCreated', { per, v1: dd(rep.from), v2: rep.to !== rep.from ? `–${dd(rep.to)}` : '', v3: plural(rep.days.length, t('rep.day'), t('rep.days')), ctx: filterText(ctx), v5: stamp(ctx.state.latest?.at), v6: stamp(Date.now()) })}</p></div>
      ${q.prelim ? `<span class="pill prelim" title="${t('rep.onlyFullMeasurementDaysFrom', { fullDays: q.fullDays, MIN_FULL_DAYS: R.MIN_FULL_DAYS })}">${t('rep.preliminary')}</span>` : `<span class="pill plain">${t('rep.reliable')}</span>`}</header>
    <section class="rp-sec"><h3>${t('rep.dataQuality')}</h3>${qualityBlock(ctx, rep, extra)}</section>
    <section class="rp-sec"><h3>${t('rep.metrics')}</h3><div class="sub">${t('rep.structuredAfterListOfMetrics', { v0: C ? (client ? t('rep.eScooterTripsCalibratedTo2') : t('rep.tripMetricsCalibrated')) : '' })}</div><div class="rp-tilewrap"><div class="tiles rp-tiles" style="--rp-cols:${tileCols}">${tiles.join('')}</div></div></section>
    <section class="rp-sec"><h3>${t('rep.perOperatorAndVehicleType')}</h3><div class="sub">${t('rep.meanOverPeriodFleetWithRange')}</div>${groupTable(ctx, rep, meta.cal)}</section>
    <section class="rp-sec"><h3>${t('rep.dailyValues')}</h3><div class="sub">${t('rep.fleetPerDayObservationAnd')}</div>${dailyTable(ctx, rep, k, meta.calib?.limits, meta.cal)}</section>
    ${q.source === 'archiv' ? '' : cellsSection(ctx, rep, meta.s)}
    ${referenceRows(ctx, ref, rep, meta.cal)}
    <footer class="rp-sec small muted"><h3>${t('rep.method')}</h3><p style="margin:0 0 var(--s1)">${t('rep.basisIsOperatorsOpenLive')}</p><p style="margin:0">${t('rep.tripsPerDayAreMeasuredTrips', { calMethod, v1: esc(ctx.CFG.REPO || '') })}</p></footer>
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
  const put = (html) => { unmountCellMaps(s); el.innerHTML = html; }; // Karten vor dem Ersetzen abbauen (Leaflet hält sonst Ereignisse und Kacheln)
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

// ---------- Zellkarten auf OpenStreetMap (Leaflet) ----------
// Zwei Karten (Fahrtbeginne, Fahrtenden), gekoppelt: die zuletzt bediente Karte führt, die andere folgt ohne eigene Animation.
// Zellen als halbtransparente Rechtecke auf einem Canvas-Renderer in den Farben der Skala; Kacheln entsättigt (dunkles Thema: invertiert),
// damit die Skala lesbar bleibt. Tooltip je Zelle beim Überfahren oder Antippen; Werte für alle Zellen in der Tabelle.
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR_DEF = () => (t('rep.openstreetmapContributors'));
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
    const tiles = L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR_DEF(), crossOrigin: 'anonymous' }).addTo(map);
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
    const p = m.map.latLngToContainerPoint([c.lat + R.CELL_LAT / 2, c.lon]), tq = tipOf(m, c);
    showTipAt(m.box.closest('.rp-chart'), p.x, p.y, tq.value, tq.lines);
  };
  const tipOf = (m, c) => {
    const key = m.key, other = key === 'start' ? 'end' : 'start', v = (x) => (R.suppressed(x) ? `< ${R.MIN_COUNT}` : fmt(x));
    return { value: `${v(c[key])} ${key === 'start' ? t('rep.tripStarts') : t('rep.tripEnds')}`, lines: [t('rep.avgAvailablePerRun2', { v0: v(c[other]), v1: other === 'start' ? t('rep.tripStarts') : t('rep.tripEnds'), v2: c.presAvg == null ? '—' : fmt(c.presAvg, 1) }), t('rep.cell2', { v0: c.lat.toFixed(4), v1: c.lon.toFixed(4) })] };
  };
  // Tastatur (web/mapkeys.js): die Zellen sind nicht anklickbar (Canvas, interactive: false) – N/P geht über das Zellraster selbst,
  // markiert die Zelle in beiden Karten und zeigt denselben Tooltip wie beim Überfahren; ein gemeinsamer Hinweis unter beiden Karten
  const grid = el.querySelector('.rp-report [data-rp="cellmaps"]');
  for (const m of maps) mapKeys(m.map, { hintAfter: grid || m.box, items: () => cs.grid.map(c => ({ key: c, latlng: [c.lat, c.lon], ring: false, show: () => show(m, L.latLng(c.lat, c.lon)), hide, text: () => { const tq = tipOf(m, c); return [tq.value, ...tq.lines].join('\n'); } })) });
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
  const tq = tip(box); tq.replaceChildren(); const b = document.createElement('b'); b.textContent = value; tq.append(b);
  for (const l of [].concat(label || [])) { const d = document.createElement('div'); d.textContent = l; tq.append(d); }
  tq.hidden = false;
  const w = box.getBoundingClientRect();
  const x = Math.max(tq.offsetWidth / 2 + 4, Math.min(w.width - tq.offsetWidth / 2 - 4, px));
  let y = py; if (y - tq.offsetHeight - 10 < 0) y = py + tq.offsetHeight + 24;
  tq.style.left = `${x}px`; tq.style.top = `${y}px`;
}
// Druck: Kacheln abwarten (höchstens ms), dann Karte + Zellen in hellen Druckfarben als Bild; ohne Freigabe der Kacheln (CORS) null
function tilesSettled(tiles, ms = 4000) {
  return new Promise(res => { if (!tiles?.isLoading?.()) { res(); return; } const done = () => { clearTimeout(tq); tiles.off('load', done); res(); }; const tq = setTimeout(done, ms); tiles.on('load', done); });
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
  const note = t('rep.openstreetmapContributors2'); g.font = '10px system-ui, sans-serif'; const tw = g.measureText(note).width;
  g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(W - tw - 10, H - 16, tw + 10, 16); g.fillStyle = '#3b4855'; g.fillText(note, W - tw - 5, H - 4.5);
  try { return tiles ? cv.toDataURL('image/png') : null; } catch { return null; } // Kacheln ohne CORS-Freigabe: Canvas gesperrt → Rückfall
}
function reportCsv(el) {
  const s = st(el); if (!s.rep) return;
  const rows = R.reportCsvRows(s.rep, { name: s.meta.name, typeLabel: typeName, cal: s.meta.cal, calLabel: calibLabel(s.meta.calib?.k), period: s.meta.period , lang: lang() });
  const per = s.meta.period?.key ? `${s.meta.period.key}_` : '';
  download(`${t('file.report')}_${s.rep.ags}_${per}${s.rep.from}_${s.rep.to}.csv`, R.toCsv(rows, lang()));
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
  if (btn) { btn.setAttribute('aria-busy', 'true'); btn.dataset.label = btn.textContent; btn.textContent = t('rep.preparingMaps'); }
  let shots = [];
  try { shots = await Promise.all((s.cellMaps || []).map(m => cellMapImage(m, s.rep.cells).catch(() => null))); } catch { shots = []; }
  if (btn) { btn.removeAttribute('aria-busy'); btn.textContent = btn.dataset.label || t('rep.printPdf'); }
  s.printing = false;
  document.querySelectorAll('.rp-print-root').forEach(n => n.remove());
  const root = document.createElement('div'); root.className = 'rp-print-root rp-root';
  root.appendChild(art.cloneNode(true)); root.querySelectorAll('.rp-tip,.rp-noprint').forEach(n => n.remove());
  root.querySelectorAll('[id]').forEach(n => n.removeAttribute('id')); // keine doppelten IDs neben dem Original
  root.querySelectorAll('div.rp-cellmap[data-key]').forEach((box, i) => {
    const key = box.dataset.key, url = shots[i], fig = box.closest('.rp-fig'); const title = fig?.querySelector('figcaption')?.textContent || '';
    const host = box.closest('.rp-chart') || box;
    if (url) { const img = document.createElement('img'); img.className = 'rp-cellmap-img'; img.alt = t('rep.cellsOnOpenstreetmap', { title }); img.src = url; host.replaceChildren(img); }
    else if (s.rep?.cells) { host.innerHTML = cellSvgMarkup(s.rep.cells, key, title) + `<div class="small muted">${t('rep.mapBackgroundNotPrintable')}</div>`; }
  });
  document.body.appendChild(root); document.body.classList.add('rp-printing');
  const title = document.title; document.title = t('rep.municipalReport3', { v0: s.meta?.name || '', v1: s.rep?.from || '', v2: s.rep?.to && s.rep.to !== s.rep.from ? ` ${t('rep.to2', { to: s.rep.to })}` : '' }).trim();
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
  return `<div class="rp-meter ${status}" role="img" aria-label="${t('rep.of2', { value: ctx.fmt(value), limit: ctx.fmt(limit) })}"><i style="width:${w.toFixed(1)}%"></i>${value > limit ? `<b style="left:${((limit / dom) * 100).toFixed(1)}%" title="${t('rep.fleetCap')}"></b>` : ''}</div>`;
}
// Dauer als Text: „40 Min.“, „3,3 Std.“, „1,5 Tage“
const durTxt = (ctx, ms) => (!ms ? '–' : ms < 3600e3 ? t('rep.min', { v0: ctx.fmt(ms / 60e3) }) : ms < 48 * 3600e3 ? t('rep.h', { v0: ctx.fmt(ms / 3600e3, 1) }) : t('rep.days2', { v0: ctx.fmt(ms / 86400e3, 1) }));
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
  // Tage ohne Protokoll (vor dem ersten Tag und Lücken) schraffiert statt leer – leer läse sich wie 0
  const have = new Set(pts.map(d => xi(d.day))), pid = `rp-na-${String(v.ags).replace(/[^\w-]/g, '')}`;
  const gaps = [...Array(n).keys()].filter(i => !have.has(i)).map(i => `<rect class="gap" x="${(P.l + i * slot).toFixed(1)}" y="${P.t}" width="${slot.toFixed(1)}" height="${H - P.t - P.b}" fill="url(#${pid})"/>`).join('');
  const defs = gaps ? `<defs><pattern id="${pid}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" stroke-opacity=".35" stroke-width="1.5"/></pattern></defs>` : '';
  const bars = pts.map((d, i) => { const x = P.l + xi(d.day) * slot + (slot - bw) / 2, y = Y(d.max), y0 = Y(0), r = Math.min(4, bw / 2, y0 - y);
    const path = y0 - y < 0.5 ? '' : `<path class="bar" d="M${x.toFixed(1)},${y0.toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)},${y.toFixed(1)} ${(x + bw).toFixed(1)},${(y + r).toFixed(1)}V${y0.toFixed(1)}Z"/>`;
    return `<g data-i="${i}"><rect class="hit" x="${(P.l + xi(d.day) * slot).toFixed(1)}" y="${P.t}" width="${slot.toFixed(1)}" height="${H - P.t - P.b}"/>${path}</g>`; }).join('');
  const lim = limit ? `<line class="lim" x1="${P.l}" x2="${W - P.r}" y1="${Y(limit).toFixed(1)}" y2="${Y(limit).toFixed(1)}"/><text x="${P.l - 6}" y="${(Y(limit) + 3.5).toFixed(1)}" text-anchor="end">${ctx.fmt(limit)}</text>` : '';
  const ax = `<line class="base" x1="${P.l}" x2="${W - P.r}" y1="${Y(0)}" y2="${Y(0)}"/><text x="${P.l - 6}" y="${Y(0) + 3.5}" text-anchor="end">0</text><text x="${P.l}" y="${H - 6}">${dm(new Date(last - (n - 1) * 86400e3).toISOString().slice(0, 10))}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end">${dm(pts[pts.length - 1].day)}</text>`;
  return `<div class="rp-chart" data-rp="capchart" data-ags="${ctx.esc(v.ags)}"><svg class="rp-line rp-bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('rep.dailyMaximumOfFleetOnDays', { length: pts.length, v1: limit ? ctx.fmt(limit) : '' })}">${defs}<g>${gaps}</g>${ax}${lim}<g>${bars}</g></svg></div>
    <div class="rp-legend"><span><i class="rp-sw" style="--rp-f:var(--accent)"></i>${t('rep.highestFleetPerDayAll')}</span>${limit ? `<span><i class="rp-key" style="--c:var(--fg-2)"></i>${t('rep.totalFleetCap', { limit: ctx.fmt(limit) })}</span>` : ''}${gaps ? `<span><i class="rp-sw" style="background:var(--rp-na)"></i>${t('rep.notMeasuredDays', { n: n - have.size })}</span>` : ''}</div>`;
}
function violationsBlock(ctx, c, v, s) {
  const { esc, fmt, opColor } = ctx;
  const h = `<h3 style="font-size:13px;margin:var(--s2) 0 var(--s1)">${t('rep.violationsInLast30Days')}</h3>`;
  if (v === undefined) return h + `<div class="muted small">${t('rep.noLogYetCapsLogJsonIsCreated', { v0: R.NEAR_CAP * 100 })}</div>`;
  if (!v) return h + `<div class="muted small">${t('rep.logContainsNoCheckForThis')}</div>`;
  const ops = v.ops.filter(o => o.overRuns || o.nearRuns);
  const name = (op) => (op === '*' ? t('rep.total2') : `<span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span>`);
  const rows = ops.map(o => `<tr><td>${name(o.op)}</td><td class="n">${o.overRuns ? `${badge('over')} ${durTxt(ctx, o.overMs)}<div class="sub-line">${plural(o.overRuns, t('rep.run'), t('rep.runs'))}</div>` : '<span class="muted">–</span>'}</td><td class="n">${o.nearRuns ? `${durTxt(ctx, o.nearMs)}<div class="sub-line">${plural(o.nearRuns, t('rep.run'), t('rep.runs'))}</div>` : '<span class="muted">–</span>'}</td><td class="n"><b>${fmt(o.peak)}</b><div class="sub-line">${stamp(o.peakAt)}</div></td><td class="n">${fmt(o.limit)}</td><td class="n">${o.lastOverAt ? stamp(o.lastOverAt) : '–'}</td></tr>`).join('');
  const days = v.daily.length;
  const table = ops.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${t('rep.violations', { ort: esc(v.ort) })}"><table><thead><tr><th>${t('rep.operator2')}</th><th class="n">${t('rep.overCap')}</th><th class="n">${t('rep.near', { v0: R.NEAR_CAP * 100 })}</th><th class="n">${t('rep.peakValue')}</th><th class="n">${t('rep.cap')}</th><th class="n">${t('rep.lastOver')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="muted small">${t('rep.noExceedanceAndNoRunFromOf', { v0: R.NEAR_CAP * 100, v1: plural(days || 0, t('rep.loggedDay'), t('rep.loggedDays')) })}</div>`;
  const tbl = s.show[`cap:${v.ags}`];
  const btn = v.daily.length ? `<button type="button" class="rp-noprint" data-rp="captable" data-ags="${esc(v.ags)}" aria-expanded="${tbl ? 'true' : 'false'}">${tbl ? t('rep.asChart') : t('rep.historyAsTable')}</button>` : '';
  const hist = !v.daily.length ? '' : tbl ? `<div class="tbl" tabindex="0" role="region" aria-label="${t('rep.dailyMaximum', { ort: esc(v.ort) })}"><table><thead><tr><th>${t('rep.day')}</th><th class="n">${t('rep.highestFleet')}</th><th class="n">${t('rep.cap')}</th><th>Status</th></tr></thead><tbody>${v.daily.slice().reverse().map(d => `<tr><td>${dd(d.day)}</td><td class="n">${fmt(d.max)}</td><td class="n">${d.limit != null ? fmt(d.limit) : '—'}</td><td>${badge(R.capStatus(d.max, d.limit).status)}</td></tr>`).join('')}</tbody></table></div>` : capChart(ctx, v, c);
  return h + `<div class="sub small muted" style="margin-bottom:var(--s1)">${t('rep.durationSumOfFetchIntervals', { v0: plural(days, t('rep.day'), t('rep.days')), btn })}</div>` + table + hist;
}
// Teilgebiet mit vermuteter Abgrenzung (zone-watch.json): Statuszeile und je Anbieter Bestand gegen die Grenze
// Grenze eines Teilgebiets als Text: gesamt, je Anbieter, Anteil an der Flotte (anteilMax/anteilMin)
const zoneLimitTxt = (ctx, d) => [d.limit != null ? t('rep.total3', { limit: ctx.fmt(d.limit) }) : null, d.perOperator != null ? t('rep.perOperator', { perOperator: ctx.fmt(d.perOperator), v1: d.perOperatorDerived ? ` (${DERIVED_TXT_DEF()})` : '' }) : null,
  d.shareMax != null ? t('zv.shareMax', { p: pctTxt(ctx, d.shareMax, 0) }) : null, d.shareMin != null ? t('zv.shareMin', { p: pctTxt(ctx, d.shareMin, 0) }) : null].filter(Boolean).join(' · ') || '—';
function zoneCheckRows(ctx, d) {
  const { fmt, esc, opColor } = ctx, k = d.check, shareCol = k.shareMax != null || k.shareMin != null;
  const badge = (s) => badge0(k.superset && s === 'hint' ? 'hintUpper' : s); // umfassender Umriss: Hinweis = Bestand ist Obergrenze
  const shareCell = (o) => (o.fleetShare == null ? '<span class="muted">–</span>' : `${pctTxt(ctx, o.fleetShare, 0)}<div class="sub-line">${t('zv.ofFleet', { n: fmt(o.now), f: fmt(o.fleet) })}</div>`);
  const rows = k.operators.map(o => `<tr><td><span class="op"><i style="background:${opColor(o.op)}"></i>${esc(o.op)}</span></td><td class="n">${fmt(o.now)}</td><td class="n">${o.limit != null ? fmt(o.limit) : '—'}</td><td style="min-width:120px">${o.limit != null ? meter(ctx, o.now, o.limit, ((s) => (s === 'hint' ? 'near' : s))(o.countStatus || o.status)) : '<span class="muted small">—</span>'}</td>${shareCol ? `<td class="n">${shareCell(o)}</td>` : ''}<td class="n">${o.todayMax != null ? fmt(o.todayMax) : '–'}</td><td class="n">${o.max30 != null ? fmt(o.max30) : '–'}</td><td class="n">${o.daysOver != null ? `${fmt(o.daysOver)} <span class="muted small">${t('rep.capZoneDaysOf', { n: fmt(o.daysLogged) })}</span>` : '–'}</td><td>${badge(o.status)}</td></tr>`).join('');
  const sub = `<div class="tbl" style="margin-top:var(--s1)"><table><thead><tr><th>${t('rep.operator2')}</th><th class="n">${t('rep.capZoneNow')}</th><th class="n">${t('rep.cap')}</th><th>${t('rep.utilisation')}</th>${shareCol ? `<th class="n">${t('zv.fleetShare')}</th>` : ''}<th class="n">${t('rep.capZoneTodayMax')}</th><th class="n">${t('rep.capZoneMax30')}</th><th class="n">${t('rep.capZoneDaysOver')}</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return `<tr><td translate="no">${esc(d.label)}</td><td class="n">${zoneLimitTxt(ctx, d)}</td><td>${badge(d.status)}</td><td class="small muted">${t('rep.capZoneChecked', { m: fmt(k.accuracyM || 0), at: stamp(k.at) })}${k.rest ? ` · ${t('zv.rest')}` : ''}${k.superset ? ` · ${t('zv.superset')}` : ''}${k.live ? ` · ${t('zv.live')}` : ''}${d.hinweis ? ` · ${srcTxt(esc, d.hinweis)}` : ''}</td></tr><tr class="rp-zonesub"><td colspan="4">${sub}</td></tr>`;
}
function capBlock(ctx, c, rep, pop, viol = undefined, s = { show: {} }) {
  const { fmt, esc, opColor } = ctx;
  const hasTotal = c.limit != null;
  const limTxt = hasTotal ? `${fmt(c.limit)}${c.limitDerived ? ` (${DERIVED_TXT_DEF()})` : ''}` : '—';
  const hist = c.previous != null ? t('rep.until', { v0: dd(new Date(Date.parse(`${c.since}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10)), previous: fmt(c.previous) }) : c.next ? `${t('rep.fromDate', { v0: dd(c.next.from) })}: ${fmt(c.next.limit)}` : '';
  // Verfügbar ÷ erlaubt: buchbar ÷ Grenze je Anbieter; ohne Grenze je Anbieter Anteil an der Gesamtgrenze; ohne Zulassung laut Quelle: keine Rate
  const own = (o) => o.limit != null;
  const rate = (o, f) => (o.licensed === false ? null : own(o) ? o[f] : f === 'availShare' ? o.capShareAvail : o.capShare);
  const derivedOf = (o) => (own(o) ? o.derived : c.limitDerived);
  const shareNote = (o) => (o.licensed === false || own(o) ? '' : hasTotal ? `<div class="sub-line">${t('rep.shareOfTotalCap')}</div>` : '');
  const limCell = (o) => (o.licensed === false ? '—' : own(o) ? `${fmt(o.limit)}${o.derived ? `<div class="sub-line">${DERIVED_TXT_DEF()}</div>` : ''}<div class="sub-line">${t('rep.headroom', { n: fmt(Math.max(0, o.limit - o.total)) })}</div>` : '—');
  // Ausschöpfung (gemeldet ÷ erlaubt) direkt am Balken; ohne eigene Grenze der Anteil an der Gesamtgrenze als Text
  const shareLbl = (o) => { const v = rate(o, 'share'); return v == null ? '' : `<div class="sub-line"><b>${rateTxt(ctx, v)}</b>${overMark(v, derivedOf(o))}${own(o) ? '' : ` ${t('rep.shareOfTotalCap')}`}</div>`; };
  const meterCell = (o) => (o.licensed === false ? `<span class="muted small">${t('rep.notInSourceSOperatorList')}</span>` : own(o) ? meter(ctx, o.total, o.limit, o.status === 'hint' ? 'near' : o.status) + shareLbl(o) : `<span class="muted small">${t('rep.noCapPerOperator')}</span>${shareLbl(o)}`);
  const ops = c.operators.map(o => `<tr><td><span class="op"><i style="background:${opColor(o.op)}"></i>${esc(o.op)}</span></td><td class="n">${fmt(o.total)}</td><td class="n">${fmt(o.disabled)}</td><td class="n">${fmt(o.available)}</td><td class="n">${limCell(o)}</td><td style="min-width:120px">${meterCell(o)}</td><td class="n">${rateCell(ctx, rate(o, 'availShare'), false, derivedOf(o))}${shareNote(o)}</td><td>${badge(o.licensed === false ? 'unlicensed' : own(o) ? o.status : 'unknown')}</td></tr>`).join('');
  const zoneNum = (d) => zoneLimitTxt(ctx, d);
  const districts = c.districts.map(d => d.check ? zoneCheckRows(ctx, d) : `<tr><td translate="no">${esc(d.label)}</td><td class="n">${zoneNum(d)}</td><td>${badge('unchecked')}</td><td class="small muted">${d.watch ? `${t('zv.noRuns')}${d.hinweis ? ` · ${srcTxt(esc, d.hinweis)}` : ''}` : t('rep.notCheckableWithoutArea', { v0: d.hinweis ? `${srcTxt(esc, d.hinweis)} · ` : '' })}</td></tr>`).join('');
  const per1000 = pop ? (c.total / pop) * 1000 : null;
  const pre = rep?.quality.prelim ? ` · ${t('rep.preliminary')}` : '';
  const links = [safeLink(ctx, c.url, c.quelle || t('rep.source')), ...(c.links || []).map((l, i) => safeLink(ctx, l.url, l.quelle || t('rep.source2', { v0: i + 2 })))].join(' · ');
  const listTxt = c.listed ? ` · ${t('rep.operatorsAccordingToSource', { join: esc(c.listed.join(', ')), v1: c.listComplete ? '' : ` ${t('rep.listIncompleteNoLicenceCheck')}` })}` : '';
  const head = hasTotal
    ? `<div class="rp-cap-total"><div>${meter(ctx, c.total, c.limit, c.status === 'hint' ? 'near' : c.status)}</div><div><span class="big">${fmt(c.total)}</span> <span class="muted">${t('rep.of3', { limit: fmt(c.limit), v1: pctTxt(ctx, c.share, 0) })}</span></div></div>
    <div class="small">${t('rep.bookableOfCap', { available: fmt(c.available), limit: fmt(c.limit) })}${overMark(c.availShare, c.limitDerived)} · ${t('rep.headroomTotal', { n: fmt(Math.max(0, c.limit - c.total)) })}</div>`
    : `<div class="small">${t('rep.reported', { total: fmt(c.total), typeName: esc(typeName(c.type)), v2: c.perOperator != null ? t('rep.noTotalCapCapPerOperatorSee') : t('rep.noCityWideCap') })}</div>`;
  return `<div class="rp-cap"><div class="rp-cap-h"><h3>${esc(c.ort)} <span class="muted small">${esc(typeName(c.type))}${c.art ? ` · ${artTxt(esc, c)}` : ''}</span></h3>${badge(c.status)}</div>
    ${head}
    <div class="small muted">${t('rep.totalFleetCapOfficialSource', { limTxt, v1: c.perOperator != null ? ` · ${t('rep.perOperator', { perOperator: fmt(c.perOperator), v1: c.perOperatorDerived ? ` (${DERIVED_TXT_DEF()})` : '' })}` : '', v2: hist ? ` · ${hist}` : '', v3: c.since && !c.previous ? ` · ${t('rep.validSince', { standTxt: esc(standTxt(c.since)) })}` : '', v4: c.stand ? ` · ${t('rep.asOf2', { standTxt: esc(standTxt(c.stand)) })}` : '', links, listTxt })}</div>
    ${c.hinweis ? `<div class="small muted">${`<span translate="no">${esc(c.hinweis)}</span>`}</div>` : ''}
    ${ops ? `<div class="tbl"><table><thead><tr><th>${t('rep.operator2')}</th><th class="n">${t('rep.fleet2')}</th><th class="n">${t('rep.ofWhichDisabled')}</th><th class="n">${t('rep.bookable')}</th><th class="n">${t('rep.cap')}</th><th title="${t('rep.reportedCap')}">${t('rep.utilisation')}</th><th class="n" title="${t('rep.bookableCap')}">${t('rep.availableAllowed')}</th><th>Status</th></tr></thead><tbody>${ops}</tbody></table></div>` : emptyBox(t('rep.noInFeed', { typeName: esc(typeName(c.type)) }), t('rep.noOpenFeedCurrentlyReports'))}
    ${districts ? `<div class="tbl"><table><thead><tr><th>${t('rep.subAreaWithItsOwnCap')}</th><th class="n">${t('rep.cap')}</th><th>Status</th><th>${t('rep.note')}</th></tr></thead><tbody>${districts}</tbody></table></div>` : ''}
    ${c.hasRate ? violationsBlock(ctx, c, viol, s) : ''}
    <div class="tiles">${tile(t('rep.per1000Residents', { typeName: esc(typeName(c.type)) }), num(ctx, per1000, 1), pop ? t('rep.vehiclesResidents', { total: fmt(c.total), pop: fmt(pop) }) : t('rep.populationMissing'))}${tile(t('rep.tripsPer1000ResidentsAndDayMeasured'), num(ctx, rep?.totals.per1000Rides, 1), rep ? t('rep.extrapolatedMeasured', { typeName: esc(typeName(c.type)), v1: plural(rep.days.length, t('rep.day'), t('rep.days')), pre }) : t('rep.noDailyFilesYet2'))}</div></div>`;
}
// Einträge ohne Prüfung (nicht amtlich, „keine“): kompakte Tabelle mit Zahl laut Quelle und heutigem Bestand zur Einordnung
function capInfoTable(ctx, list, title) {
  const { esc, fmt } = ctx; if (!list.length) return '';
  const rows = list.map(c => `<tr><td><b>${esc(c.ort)}</b><div class="sub-line">${esc(typeName(c.type))}${c.art ? ` · ${artTxt(esc, c)}` : ''}</div></td><td>${badge(c.status)}<div class="sub-line">${esc(CAPSRC[c.sourceStatus] || c.sourceStatus)}${c.statusText && c.statusText !== R.CAP_SOURCE_STATUS[c.sourceStatus] ? ` – ${srcTxt(esc, c.statusText)}` : ''}</div></td>
    <td class="small">${c.sourceStatus === 'keine' ? '—' : capInfoTxt(ctx, c) || '—'}</td><td class="n">${fmt(c.total)}</td><td class="small">${safeLink(ctx, c.url, c.quelle || t('rep.source'))}${c.stand ? ` · ${esc(standTxt(c.stand))}` : ''}</td></tr>`).join('');
  return `<h3 style="font-size:13px;margin:var(--s4) 0 var(--s1)">${title}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(title)}"><table><thead><tr><th>${t('rep.city')}</th><th>${t('rep.sourceStatus')}</th><th>${t('rep.figureAccordingToSource')}</th><th class="n">${t('rep.fleetToday')}</th><th>${t('rep.source')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
      const st = R.capStatus(d.max, d.limit); showTip(box, g.querySelector('.bar') || g, t('rep.vehicles', { v0: s.ctx.fmt(d.max) }), [t('rep.highestFleet2', { v0: WDL()[R.weekdayOf(d.day)], v1: dd(d.day) }), d.limit ? t('rep.cap2', { v0: s.ctx.fmt(d.limit), v1: STATUS_DEF()[st.status][0], v2: STATUS_DEF()[st.status][1], v3: pctTxt(s.ctx, st.share, 0) }) : t('rep.noLimit')]);
    });
    el.addEventListener('pointerleave', hide);
  });
  const title = head(t('rep.fleetCapMonitor'), t('rep.currentFleetAgainstMunicipal', { v0: stamp(state.latest?.at) }));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), t('rep.checkAppearsAsSoonAs')); return; }
  el.classList.add('rp-busy');
  try {
    const ref = await reference(ctx); if (tok !== s.tok) return;
    if (!ref) { el.innerHTML = title + emptyBox(t('rep.referenceValuesNotLoadable'), t('rep.referenceJsonIsMissingOr')); return; }
    const [{ docs }, log, zw] = await Promise.all([allDocs(ctx), fetchJson(ctx, 'caps-log.json', true), zoneData(ctx)]); if (tok !== s.tok) return;
    const caps = R.capsCheck(ref, state.latest.groups, { ags: state.scope || 'DE', asOf: state.latest.at || Date.now(), zoneWatch: zw.log });
    s.viol = log ? R.capsViolations(log, { ags: state.scope || 'DE', asOf: state.latest.at || Date.now() }) : null;
    const violFor = (c) => (log ? s.viol.find(v => v.ags === R.capLogKey(c)) || null : undefined); // je Gemeinde und Art
    const repFor = (ags, ty) => (docs.length ? R.municipalReport({ docs, ags, pop: state.latest.municipalities?.[ags]?.pop || null, type: ty, latestGroups: state.latest.groups }) : null);
    const defn = `<p class="note small" style="margin:var(--s3) 0 0">${t('zv.capsDefn', { v0: R.NEAR_CAP * 100, v1: DERIVED_TXT_DEF() })}</p>`;
    let body = '';
    // geprüft wird nur, was amtlich ist; amtliche Einträge nur mit Teilgebiets-Grenzen als Block mit „nicht prüfbar“, der Rest kompakt zur Information
    const checked = caps.filter(c => c.official && (c.hasRate || c.districts.some(d => d.check) || (state.scope && state.scope !== 'DE'))), rest = caps.filter(c => !checked.includes(c));
    if (caps.length) body = checked.map(c => capBlock(ctx, c, repFor(c.ags, c.type), state.latest.municipalities?.[c.ags]?.pop || null, violFor(c), s)).join('')
      + capInfoTable(ctx, rest, state.scope && state.scope !== 'DE' ? t('rep.furtherEntriesWithoutCheck') : t('rep.furtherEntriesWithoutCheck2', { length: rest.length }));
    else {
      const ags = state.scope, m = state.latest.municipalities?.[ags] || {};
      const total = Object.entries(state.latest.groups || {}).filter(([k]) => k.startsWith(`${ags}|`) && k.endsWith('|scooter')).reduce((a, [, g]) => a + (g.total || 0), 0);
      const rep = repFor(ags, 'scooter');
      body = `<div class="note">${t('rep.noFleetCapIsStoredFor', { v0: esc(m.name || ags), v1: [...new Set(R.capsCheck(ref, state.latest.groups, { asOf: state.latest.at || Date.now() }).filter(c => c.hasRate).map(c => c.ort))].map(esc).join(', ') || t('rep.none') })}</div>
        <div class="tiles" style="margin-top:var(--s3)">${tile(t('rep.eScootersPer1000Residents'), num(ctx, m.pop ? (total / m.pop) * 1000 : null, 1), m.pop ? t('rep.vehiclesResidents', { total: ctx.fmt(total), pop: ctx.fmt(m.pop) }) : t('rep.populationMissing'))}${tile(t('rep.tripsPer1000ResidentsAndDayMeasured'), num(ctx, rep?.totals.per1000Rides, 1), rep ? t('rep.eScootersExtrapolated', { v0: rep.quality.prelim ? ` · ${t('rep.preliminary')}` : '' }) : t('rep.noDailyFilesYet2'))}</div>`;
    }
    el.innerHTML = title + body + defn;
  } catch (e) { console.error('Obergrenzen', e); if (tok === s.tok) el.innerHTML = title + emptyBox(t('rep.checkNotPossible'), t('rep.dataNotLoadableTryAgainLater')); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}

// ======================================================================
// 3. Heatmap Stunde × Wochentag
// ======================================================================
const fieldName = (hm) => (hm?.field === 'end' ? t('rep.tripEnds') : t('rep.tripStarts'));
function weekLabel(ctx, hm, wd, h) {
  const c = hm.cells[wd][h]; const when = t('rep.text', { v0: WDL()[wd], h, v2: h + 1 }); const F = fieldName(hm);
  if (c.mean != null && R.suppressed(c.raw)) return { value: `< ${R.MIN_COUNT} ${F}`, lines: [when, t('rep.suppressedPrivacyThreshold', { v0: plural(c.n, t('rep.day'), t('rep.days')) })] };
  if (c.mean != null) return { value: `${ctx.fmt(c.mean, c.mean < 10 ? 1 : 0)} ${F}/h`, lines: [when, t('rep.meanOf', { v0: plural(c.n, t('rep.day'), t('rep.days3')), v1: c.dates.map(d => dm(d)).join(', '), v2: c.gapDays ? ` · ${t('rep.withGapLeftOut', { v0: plural(c.gapDays, t('rep.day'), t('rep.days')) })}` : '' })] };
  const why = !hm.days[wd] ? t('rep.noObservedDay') : c.gapDays ? t('rep.gapRun2', { v0: plural(c.gapDays, t('rep.day'), t('rep.days')) }) : c.thinDays ? t('rep.observedUnderMin', { HEAT_MIN_OBS: R.HEAT_MIN_OBS }) : t('rep.notObserved');
  return { value: t('rep.notMeasured'), lines: [when, why] };
}
function weekGrid(ctx, hm) {
  let first = true; const hdr = Array.from({ length: 24 }, (_, h) => `<div role="columnheader" class="hl" aria-label="${t('rep.n00', { h })}">${h % 3 === 0 ? h : `<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">${h}</span>`}</div>`).join('');
  const rows = WD().map((w, wd) => {
    const cells = Array.from({ length: 24 }, (_, h) => {
      const c = hm.cells[wd][h]; const lb = weekLabel(ctx, hm, wd, h);
      const cls = c.mean == null ? 'na' : R.suppressed(c.raw) ? 'rp-s0' : `rp-s${R.heatClass(c.mean, hm.max, 8, { sqrt: false })}`;
      const tab = first && c.mean != null ? (first = false, 0) : -1;
      return `<div role="gridcell" class="c ${cls}" tabindex="${tab}" data-wd="${wd}" data-h="${h}" aria-label="${ctx.esc(`${lb.lines[0]}: ${lb.value}`)}"></div>`;
    }).join('');
    return `<div role="row" class="rp-row"><div role="rowheader" class="rl"><span>${w}</span><small title="${t('rep.observedDays')}">${t('rep.nDaysShort', { n: hm.days[wd] })}</small></div>${cells}</div>`;
  }).join('');
  const html = `<div class="rp-weekwrap" tabindex="0" role="region" aria-label="${t('rep.heatmapScrollsHorizontally')}" style="overflow-x:auto;max-width:100%;position:relative"><div class="rp-week" role="grid" aria-label="${t('rep.perHourAndWeekday', { hm: fieldName(hm) })}" data-rp="week"><div role="row" class="rp-row"><div role="columnheader" class="hl"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">${t('rep.weekday')}</span></div>${hdr}</div>${rows}</div></div>`;
  return first ? html.replace('tabindex="-1"', 'tabindex="0"') : html; // nichts gemessen: erste Zelle trotzdem erreichbar
}
function weekTable(ctx, hm) {
  const head = WD().map((w, wd) => `<th class="n">${w}<div class="sub-line">${t('rep.nDaysShort', { n: hm.days[wd] })}</div></th>`).join('');
  const rows = Array.from({ length: 24 }, (_, h) => `<tr><td>${t('rep.text2', { h, v1: h + 1 })}</td>${WD().map((_, wd) => { const c = hm.cells[wd][h]; return `<td class="n">${c.mean == null ? `<span class="muted">${t('rep.notMeas')}</span>` : R.suppressed(c.raw) ? `&lt; ${R.MIN_COUNT}` : ctx.fmt(c.mean, c.mean < 10 ? 1 : 0)}</td>`; }).join('')}</tr>`).join('');
  return `<div class="tbl"><table><thead><tr><th>${t('rep.hour')}</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
/**
 * Heatmap Fahrtbeginne je Stunde × Wochentag für Gebiet/Anbieter/Art aus allen Tagesdateien (events/index.json → events/<Tag>.json).
 * Zelle grau = nicht gemessen (kein beobachteter Tag, unter 30 Min. Beobachtung oder Lücken-Lauf in der Stunde).
 */
// ======================================================================
// Zonen-Beobachtung: Bestand je privat hinterlegter Zone (Umrisse nicht veröffentlicht) und Anbieter, 30 Tage (zone-watch.json)
// ======================================================================
// Zonen: Protokoll des Sammlers (zone-watch.json); fehlt es (noch), zählt die Seite den aktuellen Sammler-Stand selbst aus
// ops/<Land>.json mit den vermuteten Umrissen aus data/zonen-vermutet.json (main) – ein Lauf, ohne Verlauf (live: true)
async function zoneData(ctx) {
  const [log, zdoc] = await Promise.all([fetchJson(ctx, 'zone-watch.json', true), fetchJson(ctx, 'zonen-vermutet.json', false, ctx.CFG.MAIN)]);
  const zones = zdoc ? R.parseZoneWatch(JSON.stringify(zdoc)) : [];
  // Umrisse, die das Protokoll (noch) nicht kennt (neu in data/zonen-vermutet.json), live nachzählen; Rest-Zonen brauchen alle Umrisse ihrer Gemeinde
  // nur für die gewählte Gemeinde (Deutschland-Ansicht ohne Nachzählen: sonst Bestand aller Länder laden, bis der Sammler die Zonen protokolliert)
  const scope = ctx.state.scope || 'DE', inLog = (z) => (log?.zones || []).some(x => x.id === z.id && !x.retired);
  const missing = scope === 'DE' && log?.zones?.length ? [] : zones.filter(z => !inLog(z) && (scope === 'DE' || z.ags === scope));
  if (!missing.length) return { log: log?.zones?.length ? log : null, zones };
  const lands = [...new Set(missing.map(z => ctx.state.latest?.municipalities?.[z.ags]?.state).filter(Boolean))];
  const fleets = (await Promise.all(lands.map(l => fetchJson(ctx, `ops/${l}.json`, true)))).filter(Boolean).map(decodeFleet);
  if (!fleets.length) return { log: log?.zones?.length ? log : null, zones };
  const at = Math.max(...fleets.map(f => f.at || 0)) || ctx.state.latest?.at || Date.now();
  const agsSet = new Set(missing.map(z => z.ags)), ids = new Set(missing.map(z => z.id));
  const counts = new Map([...R.zoneCounts(zones.filter(z => agsSet.has(z.ags)), fleets.flatMap(f => f.vehicles))].filter(([k]) => ids.has(k.split('|')[0])));
  const live = R.zoneLogUpdate(null, missing, counts, { at });
  if (!log?.zones?.length) return { log: { ...live, zones: live.zones.map(z => ({ ...z, live: true })), live: true }, zones };
  return { log: { ...log, zones: [...log.zones, ...live.zones.map(z => ({ ...z, live: true }))], runs: [...(log.runs || []), ...live.runs], daily: [...(log.daily || []), ...live.daily] }, zones };
}
// kleine Karte der vermuteten Umrisse (gestrichelt), Leaflet global
function zoneMap(el, s, zones, ctx) {
  const box = el.querySelector('.rp-zonemap'); if (!box || typeof L === 'undefined' || !zones.length) return;
  if (s.zmap && s.zmap.getContainer() !== box) { s.zmap.remove(); s.zmap = null; }
  if (!s.zmap) {
    s.zmap = L.map(box, { zoomControl: true, scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('app.openstreetmapContributors') }).addTo(s.zmap);
    mapKeys(s.zmap); // Tastatur: N/P durch die Teilgebiete im Ausschnitt (web/mapkeys.js)
  }
  const pal = ['#0f766e', '#c2410c', '#6d28d9', '#a16207', '#be185d', '#1d4ed8'];
  const layers = zones.filter(z => z.polys?.length).map((z, i) => L.polygon(z.polys.map(rs => rs.map(r => r.map(([x, y]) => [y, x]))), { color: pal[i % pal.length], weight: 2.5, dashArray: '7 6', fillOpacity: 0.06 })
    .bindTooltip(`<b>${ctx.esc(z.name)}</b><br>${t('rep.zwAssumed', { m: ctx.fmt(z.accuracyM || 0) })}`, { sticky: true }).addTo(s.zmap));
  s.zmap.fitBounds(L.featureGroup(layers).getBounds(), { padding: [12, 12] });
  setTimeout(() => s.zmap?.invalidateSize(), 0);
}
function sparkline(ctx, series) {
  const pts = (series || []).filter(([, v]) => Number.isFinite(v));
  if (pts.length < 2) return '<span class="muted">–</span>';
  const W = 96, H = 22, P = 3, vs = pts.map(([, v]) => v), lo = Math.min(...vs), hi = Math.max(...vs), sp = hi - lo || 1;
  const xy = pts.map(([, v], i) => [P + (W - 2 * P) * i / (pts.length - 1), H - P - (H - 2 * P) * (v - lo) / sp]);
  const label = t('rep.zwSpark', { n: pts.length, lo: ctx.fmt(lo), hi: ctx.fmt(hi), last: ctx.fmt(vs[vs.length - 1]) });
  return `<svg class="rp-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${ctx.esc(label)}"><title>${ctx.esc(label)}</title><polyline points="${xy.map(p => p.map(x => x.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${xy[xy.length - 1][0].toFixed(1)}" cy="${xy[xy.length - 1][1].toFixed(1)}" r="2.5" fill="var(--accent)"/></svg>`;
}
export async function renderZoneWatch(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc, fmt } = ctx; const tok = ++s.tok;
  const { log, zones: shapes } = await zoneData(ctx); if (tok !== s.tok) return;
  const scope = state.scope || 'DE';
  const zones = log ? R.zoneSummary(log, { operator: state.operator || 'all', type: state.type || 'all' }).filter(z => !z.retired && (scope === 'DE' || z.ags === scope)) : [];
  if (!zones.length) { el.hidden = true; el.innerHTML = ''; s.zmap?.remove(); s.zmap = null; return; }
  el.hidden = false;
  const num = (v) => (v == null ? '<span class="muted">–</span>' : esc(fmt(v, Number.isInteger(v) ? 0 : 1)));
  const opCell = (op) => (op === '*' ? `<b>${t('rep.zwAll')}</b>` : `<span class="op"><i style="background:${ctx.opColor(op)}"></i>${esc(op)}</span>`);
  const blocks = zones.map(z => {
    const trend = z.rows.some(r => (r.series || []).filter(([, v]) => Number.isFinite(v)).length >= 2); // Tagesmaximum-Verlauf erst ab 2 Tagen
    const rows = z.rows.map(r => `<tr${r.op === '*' ? ' class="rp-sum"' : ''}><td>${opCell(r.op)}</td><td class="n">${num(r.now)}${r.avail != null && r.avail !== r.now ? `<div class="sub-line">${t('rep.zwAvail', { v: esc(fmt(r.avail)) })}</div>` : ''}</td>
      <td class="n">${r.todayMin == null ? '<span class="muted">–</span>' : `${esc(fmt(r.todayMin))}–${esc(fmt(r.todayMax))}`}</td><td class="n">${num(r.mean7)}</td><td class="n">${num(r.max30)}</td>${trend ? `<td>${sparkline(ctx, r.series)}</td>` : ''}</tr>`).join('');
    const city0 = z.ags ? (ctx.muniName?.(z.ags) || z.ags) : '', city = city0 && !z.name.startsWith(city0) ? city0 : ''; // „Köln Innenstadt · Köln“ vermeiden
    return `<h3 class="rp-h3">${esc(z.name)}${city ? ` <span class="muted">· ${esc(city)}</span>` : ''}</h3>${z.assumed ? `<div class="small muted" style="margin:-4px 0 var(--s2)"><span class="rp-status hint"><i aria-hidden="true">i</i>${t('rep.zwAssumed', { m: fmt(z.accuracyM || 0) })}</span>${z.description ? ` <span translate="no">${esc(z.description)}</span>` : ''}</div>` : ''}${z.rows.length ? `<div class="tbl"><table><thead><tr><th>${t('rep.operator2')}</th><th class="n">${t('rep.zwNow')}</th><th class="n">${t('rep.zwToday')}</th><th class="n">${t('rep.zwMean7')}</th><th class="n">${t('rep.zwMax30')}</th>${trend ? `<th>${t('rep.zwTrend')}</th>` : ''}</tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">${t('rep.zwNone')}</div>`}`;
  }).join('');
  const shown = shapes.filter(z => !z.rest && zones.some(x => x.id === z.id));
  s.zmap?.remove(); s.zmap = null;
  el.innerHTML = head(t('rep.zwTitle'), t('rep.zwSub', { at: stamp(zones[0].at || log.updatedAt) })) + (log.live || zones.some(z => z.live) ? `<div class="note small" style="margin-bottom:var(--s2)">${t('rep.zwLive')}</div>` : '')
    + (shown.length ? `<div class="rp-zonemap" role="region" aria-label="${t('rep.zwMapAria')}"></div>` : '') + blocks + `<p class="note small" style="margin:var(--s3) 0 0">${t('rep.zwNote', { days: log.days || R.ZONE_LOG_DAYS })}</p>`;
  zoneMap(el, s, shown, ctx);
}

export async function renderWeekHeatmap(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc } = ctx; const tok = ++s.tok;
  bindOnce(el, 'week', () => {
    el.addEventListener('click', (e) => {
      const f = e.target.closest('button[data-rp="field"]'); if (f && s.docs) { s.field = f.dataset.f; s.hm = R.weekHeatmap(s.docs, s.keep, { field: s.field }); renderWeek(el); el.querySelector(`button[data-rp="field"][data-f="${s.field}"]`)?.focus(); return; }
      const b = e.target.closest('button[data-rp="toggle"]'); if (!b) return; s.show.week = !s.show.week; renderWeek(el); });
    const cellOf = (tq) => tq.closest?.('.rp-week .c');
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
  const scopeName = state.scope === 'DE' ? t('rep.allOfGermany') : esc(ctx.muniName?.(state.scope) || state.scope);
  s.field ??= 'start';
  s.title = (btn) => head(t('rep.tripsByHourAndWeekday'), t('rep.meanPerHourOverObservedDays', { v0: s.field === 'end' ? t('rep.tripEndsDestination') : t('rep.tripStartsStart'), scopeName, ctx: filterText(ctx) }), btn);
  el.classList.add('rp-busy');
  try {
    const { docs } = await allDocs(ctx); if (tok !== s.tok) return;
    if (!docs.length) { el.innerHTML = s.title('') + emptyBox(t('rep.noDailyFilesYet'), t('rep.tripStartsAriseFromSecond')); s.hm = null; return; }
    s.docs = docs; s.keep = R.keyFilter({ ags: state.scope || 'DE', operator: state.operator, type: state.type });
    s.hm = R.weekHeatmap(docs, s.keep, { field: s.field });
    s.ndocs = docs.length; renderWeek(el);
  } catch (e) { console.error('Heatmap', e); if (tok === s.tok) el.innerHTML = s.title('') + emptyBox(t('rep.heatmapCannotBeCreated'), t('rep.dailyFilesNotLoadable')); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}
function renderWeek(el) {
  const s = st(el); const ctx = s.ctx, hm = s.hm; if (!hm) return;
  const seg = `<div class="rp-seg" role="group" aria-label="${t('rep.startOrDestination')}">${[['start', t('rep.start')], ['end', t('rep.destination')]].map(([f, l]) => `<button type="button" data-rp="field" data-f="${f}" aria-pressed="${s.field === f}">${l}</button>`).join('')}</div>`;
  const btn = `<div class="rp-ctl rp-noprint">${seg}<button type="button" data-rp="toggle" aria-expanded="${s.show.week ? 'true' : 'false'}">${s.show.week ? t('rep.asHeatmap') : t('rep.asTable')}</button></div>`;
  const mid = hm.max / 2;
  const legend = `<div class="rp-legend"><span>${t('rep.perHour', { hm: fieldName(hm) })}</span><span class="rp-ramp"><em>0</em>${rampSpans()}<em>${ctx.fmt(hm.max, hm.max < 10 ? 1 : 0)}</em></span><span class="muted">${t('rep.middle', { mid: ctx.fmt(mid, mid < 10 ? 1 : 0) })}</span><span><i class="rp-sw na"></i>${t('rep.notMeasuredNoDayObserved', { HEAT_MIN_OBS: R.HEAT_MIN_OBS })}</span><span><i class="rp-sw rp-s0"></i>${t('rep.fewerThanPrivacy', { MIN_COUNT: R.MIN_COUNT, hm: fieldName(hm) })}</span></div>`;
  const note = `<div class="muted small" style="margin-top:var(--s2)">${t('rep.of168HoursMeasuredHoursIn', { measured: hm.measured, v1: plural(s.ndocs, t('rep.dailyFile'), t('rep.dailyFiles')), v2: hm.measured < 168 ? t('rep.greyCellsAreGapsIn') : '' })}</div>`;
  el.innerHTML = s.title(btn) + (s.show.week ? weekTable(ctx, hm) : `<div class="rp-chart"><div class="rp-scroll">${weekGrid(ctx, hm)}</div></div><p class="rp-scrollhint" hidden>${t('rep.weekScrollHint')}</p>${legend}`) + note;
  // Telefon (UI-18): die 24 Stunden passen nicht ins Panel – Wochentage bleiben stehen, der rechte Rand blendet aus, solange rechts noch
  // Stunden folgen, und ein Satz unter der Heatmap sagt es
  const wrap = el.querySelector('.rp-weekwrap'); s.weekRo?.disconnect();
  if (wrap) {
    const hint = el.querySelector('.rp-scrollhint');
    const upd = () => { const over = wrap.scrollWidth > wrap.clientWidth + 2; wrap.classList.toggle('rp-more-r', over && wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft > 2); if (hint) hint.hidden = !over; };
    wrap.addEventListener('scroll', upd, { passive: true }); upd();
    if (typeof ResizeObserver === 'function') { s.weekRo = new ResizeObserver(upd); s.weekRo.observe(wrap); }
  }
}

// ======================================================================
// 4. Preisänderungs-Log
// ======================================================================
const FIELD = { get unlock() { return t('rep.unlock'); }, get price() { return t('rep.basePrice'); }, get perMin() { return t('rep.perMinute'); }, get per_min() { return t('rep.perMinute'); }, get perKm() { return t('rep.perKm'); }, get per_km() { return t('rep.perKm'); }, get '+plan'() { return t('rep.newTariff'); }, get '-plan'() { return t('rep.tariffRemoved'); }, get added() { return t('rep.newTariff'); }, get removed() { return t('rep.tariffRemoved'); }, get plan() { return t('rep.tariff'); }, get currency() { return t('rep.currency'); }, get name() { return t('rep.name'); }, get taxable() { return t('rep.taxable'); }, get surge() { return t('rep.surchargeOnDemandSurge'); } };
function valTxt(ctx, v) {
  if (v == null || v === '') return '–';
  if (typeof v === 'boolean') return v ? t('rep.yes') : t('rep.no');
  if (typeof v === 'number') return `${ctx.fmt(v, 2)}`;
  if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object' ? [x.rate != null ? `${ctx.fmt(+x.rate, 2)}` : '', x.interval > 1 ? `/${x.interval}` : '', x.start ? ` ${t('rep.fromDate', { v0: x.start })}` : ''].join('') : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v);
}
/** Preisänderungen aus pricing-log.json (CFG.DATA), gefiltert nach Gebiet und Anbieter, neueste zuerst; Leerzustand ohne Datei */
export async function renderPriceLog(el, ctx) {
  if (!el) return;
  const s = prep(el, ctx); const { state, esc } = ctx; const tok = ++s.tok;
  const title = head(t('rep.priceChanges'), t('rep.changesToTariffsOfPricing'));
  const log = await fetchJson(ctx, 'pricing-log.json', true); if (tok !== s.tok) return;
  if (!log) { el.innerHTML = title + emptyBox(t('rep.noPriceChangeLogYet'), t('rep.filePricingLogJsonIsCreated')); return; }
  const pricing = await fetchJson(ctx, 'pricing.json', true); if (tok !== s.tok) return;
  const all = R.priceLogEntries(log, { sources: state.latest?.sources, pricing });
  const list = R.filterPriceLog(all, { ags: state.scope || 'DE', operator: state.operator });
  const area = (e) => (!e.munis.length ? `<span class="muted">${e.sourceId != null ? t('rep.sourceNotInDataSnapshot') : t('rep.nationwide')}</span>` : `${e.munis.slice(0, 3).map(a => esc(ctx.muniName?.(a) || a)).join(', ')}${e.munis.length > 3 ? ` <span class="muted">+${e.munis.length - 3}</span>` : ''}`);
  const rows = list.slice(0, 200).map(e => `<tr><td class="n">${e.at ? stamp(e.at) : esc(e.day || '–')}</td><td><span class="op"><i style="background:${ctx.opColor(e.operator || '')}"></i>${esc(e.operator || '–')}</span></td><td class="small">${area(e)}</td><td>${esc(e.plan || '–')}</td><td>${esc(FIELD[e.field] || FIELD[e.kind] || e.field || e.kind || t('rep.change'))}${e.note ? `<div class="sub-line">${esc(e.note)}</div>` : ''}</td><td class="n">${esc(valTxt(ctx, e.from))} → <b>${esc(valTxt(ctx, e.to))}</b></td></tr>`).join('');
  const at = log.updatedAt || log.at;
  el.innerHTML = title + (rows ? `<div class="tbl"><table><thead><tr><th class="n">${t('rep.detected')}</th><th>${t('rep.operator2')}</th><th>${t('rep.area')}</th><th>${t('rep.tariff')}</th><th>${t('rep.what')}</th><th class="n">${t('rep.oldNew')}</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyBox(t('rep.noPriceChangeInFilter'), all.length ? t('rep.inTotalWidenAreaOrOperator', { v0: plural(all.length, t('rep.change'), t('rep.changes')) }) : t('rep.soFarCollectorHasNotDetected')))
    + `<div class="muted small" style="margin-top:var(--s2)">${t('rep.amountsInTariffSCurrencyAsIn', { v0: list.length > 200 ? `${t('rep.olderHidden', { v0: list.length - 200 })} · ` : '', v1: at ? ` · ${t('rep.asOf3', { at: stamp(at) })}` : '' })}</div>`;
}

// ======================================================================
// 5. Feed-Prüfung
// ======================================================================
/** Eigene Prüfung nach GBFS-Pflichtfeldern aus latest.json sources[].checks, gefiltert nach Gebiet und Anbieter */
export function renderFeedChecks(el, ctx) {
  if (!el) return;
  prep(el, ctx); const { state, esc } = ctx;
  const label = (state.latest?.sources || []).find(r => r.checks?.label)?.checks.label;
  const title = head(t('rep.feedCheck'), t('rep.lastCollectorRun', { v0: label ? esc(tx(label)) : t('rep.ownCheckOfGbfsMandatory'), v1: stamp(state.latest?.at) }));
  const recs = (state.latest?.sources || []).filter(r => r.status !== 'retired' && (state.scope === 'DE' || !state.scope || (r.municipalities || []).includes(state.scope)) && (state.operator === 'all' || r.operator === state.operator));
  const checked = recs.map(r => ({ r, c: R.normalizeChecks(r.checks) })).filter(x => x.c);
  if (!checked.length) { el.innerHTML = title + emptyBox(state.latest?.sources?.some(r => r.checks) ? t('rep.noCheckedSourceInFilter') : t('rep.noFeedCheckInDataSnapshotYet'), state.latest?.sources?.some(r => r.checks) ? t('rep.widenAreaOrOperatorAbove') : t('rep.checkAppearsWithNext')); return; }
  checked.sort((a, b) => b.c.errors - a.c.errors || b.c.warnings - a.c.warnings || String(a.r.name || a.r.id).localeCompare(String(b.r.name || b.r.id), 'de'));
  const ok = checked.filter(x => !x.c.errors && !x.c.warnings).length;
  const rows = checked.slice(0, 300).map(({ r, c }) => `<tr><td>${/^https?:/i.test(r.url || '') ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name || r.id)}</a>` : esc(r.name || r.id)}<div class="sub-line">${esc(r.operator || '')}${r.version ? ` · GBFS ${esc(r.version)}` : ''}${r.status === 'duplicate' ? ` · ${t('rep.duplicateNotCounted')}` : ''}${r.mirror ? ` · ${t('rep.mirrorOf', { of: esc(r.mirror.of), n: ctx.fmt(r.mirror.dropped) })}` : ''}${r.batteryScale?.suspect ? ` · ${t('rep.batteryScaleSuspect', { p99: ctx.fmt(r.batteryScale.p99) })}` : ''}${r.rangeCheck?.derived ? ` · ${t('rep.rangeDerived', { km: r.rangeCheck.types.filter(x => x.derived).map(x => ctx.fmt(x.kmPer100, 1)).join(' / ') })}` : ''}</div></td>
    <td class="n">${c.errors ? `<span class="rp-status over"><i aria-hidden="true">✕</i>${c.errors}</span>` : '<span class="muted">0</span>'}</td><td class="n">${c.warnings ? `<span class="rp-status near"><i aria-hidden="true">!</i>${c.warnings}</span>` : '<span class="muted">0</span>'}</td>
    <td class="small">${c.findings.slice(0, 3).map(f => `<div>${f.level === 'error' ? t('rep.error') : t('rep.warning')}: ${esc(tx(f.text)).slice(0, 160)}</div>`).join('') || `<span class="muted">${t('rep.noFindings')}</span>`}${Math.max(c.findings.length, c.errors + c.warnings) > 3 ? `<div class="muted">${t('rep.more', { v0: Math.max(c.findings.length, c.errors + c.warnings) - 3 })}</div>` : ''}</td></tr>`).join('');
  el.innerHTML = title + `<div class="muted small" style="margin-bottom:var(--s2)">${t('rep.checkedWithoutFindingsWith', { v0: plural(checked.length, t('rep.source'), t('rep.sources')), ok, length: checked.filter(x => x.c.errors).length })}</div>
    <div class="tbl"><table><thead><tr><th>${t('rep.source')}</th><th class="n">${t('rep.error')}</th><th class="n">${t('rep.warnings')}</th><th>${t('rep.firstFindings')}</th></tr></thead><tbody>${rows}</tbody></table></div>${checked.length > 300 ? `<div class="muted small">${t('rep.moreSourcesNarrowArea', { v0: checked.length - 300 })}</div>` : ''}`;
  el.insertAdjacentHTML('beforeend', mbAmpelHtml(ctx)); // Ampel der Ereignisregeln je Gruppe (Messbasis)
}

// ======================================================================
// Gemeinsame Bausteine für Tabellen mit Auswahlfeldern, Sortierung und „mehr zeigen“
// ======================================================================
const TYPE_ORDER = ['scooter', 'ebike', 'bike', 'cargo', 'moped', 'car', 'other', 'unknown'];
// verknüpft (11.11.2026): Anbieter nur mit Fahrzeugen der gewählten Art, Arten nur des gewählten Anbieters; die aktuelle Wahl bleibt wählbar
function groupOptions(latest, s = null) {
  const ops = new Set(), types = new Set();
  for (const [k, g] of Object.entries(latest?.groups || {})) {
    const [a, op, ty] = k.split('|'); if (!a || a === 'DE' || !((g?.total || 0) + (g?.stations || 0) > 0)) continue;
    if (!s?.type || s.type === 'all' || ty === s.type) ops.add(op);
    if (!s?.op || s.op === 'all' || op === s.op) types.add(ty);
  }
  if (s?.op && s.op !== 'all') ops.add(s.op); if (s?.type && s.type !== 'all') types.add(s.type);
  return { ops: [...ops].sort((a, b) => a.localeCompare(b, 'de')), types: [...types].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b)) };
}
function filterCtl(ctx, s, { op = true, min = true, typeAll = true, minLabel = t('rep.minimumFleet') } = {}) {
  const { ops, types } = groupOptions(ctx.state.latest, op ? s : { type: s.type }); const esc = ctx.esc;
  const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
  return `<div class="rp-ctl rp-noprint">${op ? `<label>${t('rep.operator2')} <select data-f="op">${opt('all', t('rep.allOperators2'), s.op)}${ops.map(o => opt(o, o, s.op)).join('')}</select></label>` : ''}
    <label>${t('rep.vehicleType')} <select data-f="type">${typeAll ? opt('all', t('rep.allTypes'), s.type) : ''}${types.map(tq => opt(tq, typeName(tq), s.type)).join('')}</select></label>
    ${min ? `<label>${minLabel} <input type="number" data-f="min" min="0" step="10" value="${s.min}" style="width:6em" aria-label="${t('rep.vehicles2', { minLabel })}"> ${t('rep.veh')}</label>` : ''}</div>`;
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
const moreBtn = (shown, total) => (total > shown ? `<div class="rp-ctl rp-noprint" style="margin-top:var(--s2)"><button type="button" data-rp="more">${t('rep.showMoreOfMore', { v0: Math.min(100, total - shown), v1: total - shown })}</button></div>` : '');
// Stadt: mit ctx.setScope als Knopf, sonst Link mit ?scope=
function cityCell(ctx, ags, name, land) {
  const label = `${ctx.esc(name)}${land ? ` <span class="muted">(${ctx.esc(land)})</span>` : ''}`;
  if (typeof ctx.setScope === 'function') return `<button type="button" class="rp-city" data-ags="${ctx.esc(ags)}" title="${t('rep.chooseAsArea')}">${label}</button>`;
  return `<a class="rp-city" href="?scope=${encodeURIComponent(ags)}${ctx.esc(location.hash || '')}" title="${t('rep.chooseAsArea')}">${label}</a>`;
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
.rp-h3{font-size:14px;font-weight:600;margin:var(--s4) 0 var(--s2)}.rp-h3:first-of-type{margin-top:var(--s2)}
.rp-root tr.rp-sum td{font-weight:600}.rp-zonemap{height:300px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-2);margin-bottom:var(--s3);isolation:isolate}.rp-root tr.rp-zonesub>td{padding-top:0;border-top:0}.rp-spark{display:block;overflow:visible}
.rp-captable tbody.rp-selg>tr>*{background:color-mix(in srgb,var(--accent) 11%,transparent)}.rp-captable tbody.rp-selg th{box-shadow:inset 3px 0 0 var(--accent)}.rp-captable tbody.rp-selg .muted,.rp-captable tbody.rp-selg .sub-line{color:var(--fg-2)}
.rp-over{font-size:11.5px;margin-left:4px;vertical-align:1px}.rp-over i{width:14px;height:14px;font-size:9px}
.rp-prof{display:grid;gap:var(--s3);grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))}
.rp-prof .card dl{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px var(--s3);font-size:12.5px}
.rp-prof .card dt{color:var(--muted)}.rp-prof .card dd{margin:0;color:var(--fg)}
details.rp-defs-d{margin:0 0 var(--s3)}details.rp-defs-d .rp-defs{margin:0}
.rp-caplink{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;margin:var(--s4) 0 0}.rp-caplink>span{flex:1 1 44ch;min-width:0}.rp-caplink a{font-weight:500}
a[data-rp-jump]{display:inline-flex;align-items:center;min-height:24px}
`;
function injectExtra() { if (document.getElementById('rp-style-2')) return; const s = document.createElement('style'); s.id = 'rp-style-2'; s.textContent = EXTRA_CSS + EXTRA_CSS_2; document.head.appendChild(s); }
function prep2(el, ctx) { const s = prep(el, ctx); injectExtra(); return s; }
const opsDoc = (ctx, land) => fetchJson(ctx, `ops/${land}.json`); // ohne Laufstempel: derselbe Download wie Übersicht (Energie) und Karte
async function latestHist(ctx, day = null) { const hidx = await histIndex(ctx); const days = (hidx.days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)); const d = day && days.includes(day) ? day : lastOf(days); return { days, day: d || null, hist: d ? await histDoc(ctx, hidx, d) : null }; }

// ======================================================================
// 7. Verfügbarkeit je Stadt
// ======================================================================
const AV_COLS_DEF = () => ([['name', t('rep.cityState'), false, 'asc'], ['total', t('rep.reported2'), true, 'desc'], ['available', t('rep.bookable'), true, 'desc'], ['avail', t('rep.availability'), true, 'asc', t('rep.bookableReported')], ['ready', t('rep.readyToRide'), true, 'asc', t('rep.bookableAndEnoughEnergy')],
  ['disabledShare', t('rep.disabled'), true, 'desc'], ['reserved', t('rep.reserved'), true, 'desc'], ['opCount', t('rep.operator2'), true, 'desc'], ['dayMean', t('rep.dailyMean'), true, 'asc', t('rep.meanAvailabilityOver')], ['dayMin', t('rep.dailyMinimum'), true, 'asc']]);
function availData(ctx, s) {
  const { state } = ctx; const scope = state.scope && state.scope !== 'DE' ? state.scope : null;
  const rows = R.availabilityRows(state.latest, { operator: s.op, type: s.type, minTotal: s.min, keepAgs: scope });
  const th = state.latest?.thresholds || {};
  const roSet = R.rangeOnlyOperators(state.latest?.sources), rangeOnly = (op) => roSet.has(op); // wie Sammler und app.js
  // Einsatzbereit: aus den Zählern je Gruppe in latest.json (energyKnown, ready; Sammler seit latest.energy), sonst je Land aus ops/<Land>.json
  const fromGroups = (k) => { if (!s.readyCache.has(k)) { const m = new Map(); for (const [key, g] of Object.entries(state.latest.groups || {})) { const [ags, op, ty] = key.split('|'); if (ags === 'DE' || (s.op !== 'all' && op !== s.op) || (s.type !== 'all' && ty !== s.type)) continue; const o = m.get(ags) || { total: 0, known: 0, ready: 0 }; o.total += g.total || 0; o.known += g.energyKnown || 0; o.ready += g.ready || 0; m.set(ags, o); } s.readyCache.set(k, m); } return s.readyCache.get(k); };
  const readyFor = (land) => { if (state.latest?.energy) return fromGroups(`groups|${s.op}|${s.type}`); const k = `${land}|${s.op}|${s.type}`; if (!s.readyCache.has(k) && s.ops.has(land)) s.readyCache.set(k, R.readinessFromOps(s.ops.get(land), { operator: s.op, type: s.type, charge: th.chargeThreshold ?? 20, range: th.rangeThreshold ?? 5, rangeOnly })); return s.readyCache.get(k) || null; };
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
  const body = show.map(r => `<tr${r.ags === d.scope ? ' class="rp-sel" aria-current="true"' : ''}><td>${cityCell(ctx, r.ags, r.name, r.state)}${r.below ? `<div class="sub-line">${t('rep.belowMinimumFleetSelected')}</div>` : ''}</td>
    <td class="n">${fmt(r.total)}</td><td class="n">${fmt(r.available)}</td><td class="n"><b>${pctCell(ctx, r.avail)}</b>${miniBar(r.avail)}</td>
    <td class="n">${r.readyPending ? '<span class="muted">…</span>' : pctCell(ctx, r.ready)}${r.readyKnown != null && r.readyKnown < r.total ? `<div class="sub-line">${r.readyKnown ? t('rep.nWithEnergyData', { readyKnown: fmt(r.readyKnown) }) : t('rep.noEnergyData')}</div>` : ''}</td>
    <td class="n">${pctCell(ctx, r.disabledShare)}</td><td class="n">${fmt(r.reserved)}</td><td class="n" title="${esc(r.operators.join(', '))}">${r.opCount}</td>
    <td class="n">${pctCell(ctx, r.dayMean)}</td><td class="n">${pctCell(ctx, r.dayMin)}${r.dayMinAt ? `<div class="sub-line">${hhmm(r.dayMinAt)}</div>` : ''}</td></tr>`).join('');
  return `<div class="tbl"><table>${sortHead(AV_COLS_DEF(), s.sort)}<tbody>${body || `<tr><td colspan="${AV_COLS_DEF().length}" class="empty">${t('rep.noCityInFilterLowerMinimum')}</td></tr>`}</tbody></table></div>${moreBtn(show.length, d.rows.length)}`;
}
// Liniendiagramm: eine Achse bis 100 %, Farbe je Anbieter, Lücken > 45 Min. als Unterbrechung, Direktbeschriftung am Ende.
// y-Achse auf den Datenbereich (Linie, kein Balken: Untergrenze darf über 0 liegen): 5 Punkte unter dem kleinsten Wert, auf die Teilung
// abgerundet (Werte 97–100 % → Achse 90–100 %); Achsentitel nennt die Größe, die unterste Marke den Beginn
function lineChart(ctx, tq, series, { W = 900, H = 280 } = {}) {
  const P = { l: 46, r: 132, t: 22, b: 30 };
  const HOUR = 3600e3; const t0 = Math.floor(tq[0] / HOUR) * HOUR, t1 = Math.max(t0 + HOUR, Math.ceil(tq[tq.length - 1] / HOUR) * HOUR);
  const vals = series.flatMap(s => s.values.filter(v => v != null)), lo0 = vals.length ? Math.max(0, Math.min(...vals) - 0.05) : 0;
  const yStep = [0.01, 0.02, 0.05, 0.1, 0.25].find(s => (1 - lo0) / s <= 4) || 0.25, lo = Math.floor(lo0 / yStep + 1e-9) * yStep;
  const x = (v) => P.l + ((v - t0) / (t1 - t0)) * (W - P.l - P.r), y = (v) => P.t + (1 - (v - lo) / (1 - lo)) * (H - P.t - P.b);
  let g = `<text x="2" y="${P.t - 10}">${t('rep.availAxis')}</text>`;
  for (let k = 0, v = lo; v <= 1 + 1e-9; k++, v = lo + k * yStep) g += `<line class="${k === 0 ? 'base' : 'grid'}" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${ctx.fmt(v * 100, Math.abs(v * 100 - Math.round(v * 100)) > 1e-6 ? 1 : 0)} %</text>`;
  const span = (t1 - t0) / HOUR; const step = [1, 2, 3, 4, 6, 12].find(s => span / s <= 8) || 24;
  for (let tt = t0; tt <= t1; tt += step * HOUR) g += `<text x="${x(tt)}" y="${H - 8}" text-anchor="middle">${hhmm(tt)}</text>`;
  const lines = series.map((s) => {
    const segs = R.lineSegments(tq, s.values); const c = ctx.opColor(s.op);
    return segs.map(seg => seg.length === 1 ? `<circle cx="${x(tq[seg[0]]).toFixed(1)}" cy="${y(s.values[seg[0]]).toFixed(1)}" r="3" fill="${c}"/>` : `<path d="${seg.map((i, j) => `${j ? 'L' : 'M'}${x(tq[i]).toFixed(1)} ${y(s.values[i]).toFixed(1)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  }).join('');
  // Endpunkte und Direktbeschriftung; kollidierende Beschriftungen entfallen (Legende und Tooltip tragen sie)
  const ends = series.map(s => { let i = s.values.length - 1; while (i >= 0 && s.values[i] == null) i--; return i >= 0 ? { s, i, ty: y(s.values[i]) } : null; }).filter(Boolean).sort((a, b) => a.ty - b.ty);
  let lastY = -Infinity; let labels = '';
  const dots = ends.map(e => `<circle class="end" cx="${x(tq[e.i]).toFixed(1)}" cy="${e.ty.toFixed(1)}" r="4" fill="${ctx.opColor(e.s.op)}"/>`).join('');
  for (const e of ends) { if (e.ty - lastY < 13) continue; lastY = e.ty; labels += `<text class="lab" x="${(x(tq[e.i]) + 9).toFixed(1)}" y="${(e.ty + 4).toFixed(1)}">${ctx.esc(e.s.op)} ${ctx.fmt(e.s.values[e.i] * 100, 0)} %</text>`; }
  return { svg: `<svg class="rp-line" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${t('rep.availabilityPerOperatorOver')}">${g}${lines}${dots}${labels}<line class="xh" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" visibility="hidden"/><rect class="hit" x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent"/></svg>`, x, W, P };
}
function showRowsTip(box, anchor, px, py, head, rows) {
  const tq = tip(box); tq.replaceChildren();
  const hd = document.createElement('div'); hd.className = 'hd'; hd.textContent = head; tq.append(hd);
  for (const r of rows) { const d = document.createElement('div'); d.className = 'row'; const i = document.createElement('i'); i.style.background = r.color; const b = document.createElement('b'); b.textContent = r.value; const s = document.createElement('span'); s.textContent = r.label; d.append(i, b, s); tq.append(d); }
  tq.hidden = false; const w = box.getBoundingClientRect();
  const xx = Math.max(tq.offsetWidth / 2 + 4, Math.min(w.width - tq.offsetWidth / 2 - 4, px - w.left)); let yy = py - w.top; if (yy - tq.offsetHeight - 10 < 0) yy = yy + tq.offsetHeight + 24;
  tq.style.left = `${xx}px`; tq.style.top = `${yy}px`;
}
function bindLine(el, getChart) {
  const move = (svg, i) => {
    const c = getChart(); if (!c || i == null) return; const box = svg.closest('.rp-chart');
    const xh = svg.querySelector('line.xh'); const xv = c.x(c.t[i]); xh.setAttribute('x1', xv); xh.setAttribute('x2', xv); xh.setAttribute('visibility', 'visible');
    const r = svg.getBoundingClientRect(); const k = r.width / c.W;
    const rows = c.series.map(s => ({ color: c.color(s.op), value: s.values[i] == null ? '–' : c.pct(s.values[i]), label: s.op, v: s.values[i] ?? -1 })).sort((a, b) => b.v - a.v);
    showRowsTip(box, svg, r.left + xv * k, r.top + c.P.t * k, t('rep.collectorPoint', { v0: hhmm(c.t[i]) }), rows); c.i = i;
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
  const daySel = s.histDays.length > 1 ? `<label>${t('rep.day')} <select data-f="day">${[...s.histDays].reverse().map(d => `<option value="${esc(d)}"${d === s.day ? ' selected' : ''}>${WD()[R.weekdayOf(d)]}, ${dd(d)}</option>`).join('')}</select></label>` : '';
  const btn = `<button type="button" data-rp="avtable" aria-expanded="${s.showTable ? 'true' : 'false'}">${s.showTable ? t('rep.asChart') : t('rep.asTable')}</button>`;
  const headH = `<div class="panel-head" style="margin-top:var(--s5)"><div><h3 style="margin:0;font-size:14px">${t('rep.historyIn', { name: esc(name) })}</h3><div class="sub">${t('rep.availabilityPerOperatorFrom', { v0: s.hist?.t?.length ? ` · ${t('rep.points', { length: s.hist.t.length, v1: hhmm(s.hist.t[0]), v2: hhmm(lastOf(s.hist.t)) })}` : '' })}</div></div><div class="rp-ctl rp-noprint">${daySel}${btn}</div></div>`;
  if (!s.hist) return headH + emptyBox(s.histLoading ? t('rep.loadingHistory') : t('rep.noHistoryForThisDay'), s.histLoading ? '' : 'history/<Tag>.json fehlt.');
  const ser = R.availabilitySeries(s.hist, scope, { operator: s.op, type: s.type });
  s.chart = null;
  if (!ser.series.length) return headH + emptyBox(t('rep.noCollectorPointsInFilter'), t('rep.setOperatorOrVehicleTypeTo'));
  const series = ser.series.slice(0, 8); const more = ser.series.length - series.length;
  if (s.showTable) {
    const rows = ser.t.map((tt, i) => `<tr><td class="n">${hhmm(tt)}</td>${series.map(x => `<td class="n">${x.values[i] == null ? '–' : pctFine(ctx, x.values[i], 1)}</td>`).join('')}</tr>`).join('');
    return headH + `<div class="tbl"><table><thead><tr><th class="n">${t('rep.time')}</th>${series.map(x => `<th class="n">${esc(x.op)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  const ch = lineChart(ctx, ser.t, series);
  s.chart = { t: ser.t, series, x: ch.x, W: ch.W, P: ch.P, color: ctx.opColor, fmt, pct: (v) => pctFine(ctx, v, 1), i: null };
  const keys = `<div class="rp-keys" aria-label="${t('rep.legend')}">${series.map(x => `<span><i class="rp-key" style="--c:${ctx.opColor(x.op)}"></i>${esc(x.op)} <span class="muted mono">${t('rep.avgVeh', { total: fmt(x.total) })}</span></span>`).join('')}${more ? `<span class="muted">${t('rep.moreByFleet', { more })}</span>` : ''}</div>`;
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
    bindSort(el, s, AV_COLS_DEF(), draw); bindCity(el, ctx); bindLine(el, () => s.chart);
    el.addEventListener('click', (e) => { if (e.target.closest('button[data-rp="avtable"]')) { s.showTable = !s.showTable; draw(); } else if (e.target.closest('button[data-rp="avcsv"]')) availCsv(el); else if (e.target.closest('button[data-rp="capcsv"]')) capCsv(el); });
    el.addEventListener('toggle', (e) => { if (e.target.matches?.('details.rp-defs-d')) s.defsOpen = e.target.open; }, true); // toggle steigt nicht auf
  });
  if (!state.latest) { el.innerHTML = head(t('rep.availabilityPerCity'), '') + emptyBox(t('rep.noDataSnapshotYet'), t('rep.tableAppearsAsSoonAs')); return; }
  const tok = ++s.tok;
  draw();
  try {
    if (!s.hist || s.histAt !== state.latest.at) { s.histLoading = true; const h = await latestHist(ctx, s.day); if (tok !== s.tok) return; s.hist = h.hist; s.histDays = h.days; s.day = h.day; s.histAt = state.latest.at; s.histLoading = false; draw(); }
    if (s.ref === undefined) { s.ref = await reference(ctx); if (tok !== s.tok) return; draw(); } // Obergrenzen (reference.json) für Verfügbar ÷ erlaubt
    // Einsatzbereitschaft: ops/<Land>.json der Länder in der Tabelle (und der gewählten Gemeinde) nachladen
    if (s.opsAt !== state.latest.at) { s.ops.clear(); s.readyCache.clear(); s.opsFailed.clear(); s.opsAt = state.latest.at; }
    // mit Energie-Zählern je Gruppe (latest.energy) keine Flottendateien laden (vorher alle 15 Länder, 6,3 MB)
    const lands = state.latest.energy ? [] : [...new Set(Object.values(state.latest.municipalities || {}).map(m => m.state).filter(Boolean))].filter(l => !s.ops.has(l) && !s.opsFailed.has(l));
    await Promise.all(lands.map(async (l) => { const d = await opsDoc(ctx, l); if (tok !== s.tok) return; if (d?.vehicles) { s.ops.set(l, d); if (d.at && d.at !== state.latest.at) s.opsStamp = d.at; } else s.opsFailed.add(l); }));
    if (tok === s.tok) draw();
  } catch (e) { console.error('Verfügbarkeit', e); }
}
function drawAvailability(el) {
  const s = st(el); const ctx = s.ctx; const { esc } = ctx; if (!ctx.state.latest) return;
  const d = availData(ctx, s); s.rows = d.rows;
  const th = ctx.state.latest.thresholds || {};
  // Definitionen eingeklappt wie „Methode“ in der Disposition (UI-25); offen bleibt, was der Nutzer geöffnet hat
  const defs = `<details class="more rp-defs-d"${s.defsOpen ? ' open' : ''}><summary data-f="defs">${t('rep.definitions')}</summary><div class="rp-defs"><div>${t('rep.availabilityBookableReported')}</div>
    <div>${t('rep.readyToRideBookableAndEnergy', { v0: th.chargeThreshold ?? 20, v1: th.rangeThreshold ?? 5, join: esc(R.RANGE_ONLY_OPS.join(', ')), v3: s.opsStamp ? ` ${t('rep.energyAsOf', { v0: stamp(s.opsStamp) })}` : '' })}</div>
    <div>${t('rep.dailyMeanMinimumAvailability', { v0: s.hist?.t?.length ? ` ${t('rep.pointsTimeRange', { n: s.hist.t.length, from: hhmm(s.hist.t[0]), to: hhmm(lastOf(s.hist.t)) })}` : '', v1: stamp(ctx.state.latest.at) })}</div></div></details>`;
  const right = `<div class="rp-ctl rp-noprint"><button type="button" data-rp="avcsv" title="${t('rep.allRowsInFilter')}">↓ CSV</button></div>`;
  const focus = document.activeElement && el.contains(document.activeElement) ? (document.activeElement.dataset?.f || null) : null;
  el.innerHTML = head(t('rep.availabilityPerCity'), t('rep.bookableAndReadyToRide', { length: d.rows.length }), right)
    + filterCtl(ctx, s) + defs + availTable(ctx, s, d) + capLink(ctx, s) + availChart(ctx, s);
  if (focus) el.querySelector(`[data-f="${focus}"]`)?.focus();
}
// ---------- Verfügbar ÷ erlaubt je Anbieter gegen die Obergrenzen ----------
// Überschreitung (über 100 %) mit Symbol und Text, nahe (ab 90 %) mit Symbol und Text – nie nur über die Farbe. Gerechnete Grenze
// (nicht in der Quelle): statt „Überschreitung/nahe“ nur ein Hinweis-Zeichen, kein Verstoß.
const overMark = (v, derived = false) => (v != null && v > 1 ? (derived ? ` <span class="rp-status hint rp-over">${t('rep.iAboveCalculatedFigure')}</span>` : ` <span class="rp-status over rp-over">${t('rep.exceedance')}</span>`) : '');
const nearMark = (v, derived = false) => (v != null && v <= 1 && v >= R.NEAR_CAP && !derived ? ` <span class="rp-status near rp-over">${t('rep.near2')}</span>` : '');
// knapp an 100 % mit einer Nachkommastelle („100,1 %“ statt „100 %“ neben „Überschreitung“, „> 99,9 %“ knapp darunter)
const rateTxt = (ctx, v) => (v >= 0.995 && v < 1.005 ? pctFine(ctx, v, 1) : pctTxt(ctx, v, 0));
const rateCell = (ctx, v, bar = false, derived = false) => (v == null ? '<span class="muted">—</span>' : `<b>${rateTxt(ctx, v)}</b>${bar ? miniBar(Math.min(1, v)) : ''}${overMark(v, derived)}${bar ? nearMark(v, derived) : ''}`);
const standTxt = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || '') ? dd(x) : /^\d{4}-\d{2}$/.test(x || '') ? `${x.slice(5)}/${x.slice(0, 4)}` : x || '');
const DERIVED_TXT_DEF = () => (t('rep.calculatedNotInSource'));
const numsTxt = (ctx, a) => (a?.length ? a.map(v => ctx.fmt(v)).join('–') : null);
// Zahlen eines Eintrags ohne Kennzahl in einem Satz: „gesamt 9.000–10.000 · je Anbieter 800 · Teilgebiete: Innenstadt 19.000 (je Anbieter 4.750, gerechnet)“
function capInfoTxt(ctx, x) {
  const parts = [];
  const g = numsTxt(ctx, x.info?.gesamt), j = numsTxt(ctx, x.info?.jeAnbieter);
  if (g) parts.push(t('rep.total4', { g })); if (j) parts.push(t('rep.perOperator2', { j }));
  const lim = (d) => `${srcTxt(ctx.esc, d.label)} ${[d.limit != null ? ctx.fmt(d.limit) : null, d.perOperator != null ? t('rep.perOperator', { perOperator: ctx.fmt(d.perOperator), v1: d.perOperatorDerived ? ` (${DERIVED_TXT_DEF()})` : '' }) : null].filter(Boolean).join(', ')}`;
  const ds = (x.districts || []).filter(d => d.limit != null || d.perOperator != null);
  // mit vermuteter Abgrenzung gezählt (Zonen-Beobachtung): Zahl der Quelle und heutiger Bestand im Teilgebiet, ohne Prüfung
  const zc = ds.filter(d => d.check).map(d => `${lim(d)} (${t('zv.nowInArea', { n: ctx.fmt(d.check.total) })})`), z = ds.filter(d => !d.check).map(lim);
  if (zc.length) parts.push(t('zv.subAreasCounted', { v1: zc.join('; ') }));
  if (z.length) parts.push(t('rep.onlyNotCheckableWithoutArea', { v0: z.length > 1 ? t('rep.subAreas') : t('rep.subArea'), v1: z.join('; ') }));
  return parts.join(' · ');
}
// Verfügbar ÷ erlaubt je Anbieter steht im Kommunal-Bericht (Obergrenzen-Wächter, Steckbrief): hier nur ein Satz mit Link und die CSV (UI-10)
function capLink(ctx, s) {
  if (s.ref === undefined) return `<p class="note small rp-caplink">${t('rep.loadingFleetCaps')}</p>`;
  if (!s.ref?.obergrenzen?.length) return `<p class="note small rp-caplink">${t('rep.noFleetCapsStoredReference')}</p>`;
  const ca = R.capAvailability(s.ref, ctx.state.latest, { hist: s.hist, operator: s.op, type: s.type, asOf: ctx.state.latest.at || Date.now() }); s.capRows = ca.rows;
  return `<div class="note small rp-caplink"><span>${t('rep.capLinkNote', { v0: plural(ca.cities, t('rep.officialCap'), t('rep.officialCaps')) })}</span> <a href="#bericht" data-rp-jump="rp-caps">${t('rep.capLinkGo')}</a>${ca.rows.length ? `<button type="button" class="rp-noprint" data-rp="capcsv" title="${t('rep.allRowsInFilter')}">${t('rep.capCsv')}</button>` : ''}</div>`;
}
function capCsv(el) {
  const s = st(el); if (!s.capRows) return; const ctx = s.ctx;
  download(t('rep.availablePerAllowedCsv', { op: s.op, type: s.type, v2: new Date(ctx.state.latest?.at || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-') }), R.toCsv(R.capAvailabilityCsvRows(s.capRows, { operator: s.op, type: s.type, at: ctx.state.latest?.at, typeLabel: typeName, day: s.hist?.day || s.day , lang: lang() }), lang()));
}
function availCsv(el) {
  const s = st(el); if (!s.rows) return; const ctx = s.ctx;
  download(`${t('file.availability')}_${s.op}_${s.type}_${new Date(ctx.state.latest?.at || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, R.toCsv(R.availabilityCsvRows(s.rows, { operator: s.op, type: s.type, at: ctx.state.latest?.at, typeLabel: typeName, day: s.day , lang: lang() }), lang()));
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
  return { docs: ok.map(x => x[0]), hists: Object.fromEntries(ok.filter(x => x[2]).map(x => [x[1], x[2]])), limits, breaks: daily?.breaks || null }; // breaks: Bruchmarken (daily.json)
}
function rankingFor(ctx, inp, type, operator = 'all') {
  const rvdLimit = inp.limits || null; // Überzählung (über der Kalibrier-Grenze) zählt wie bisher nur bei der Flotte
  const k = `${ctx.state.latest?.at}|${inp.docs.map(d => d.day).join(',')}|${type}|${operator}|${JSON.stringify(rvdLimit)}`;
  const o = { type, operator, minFleet: 0, rvdLimit, eventChecks: ctx.state.latest?.eventChecks, breaks: inp.breaks || null };
  if (!RANK_CACHE.has(k)) { const cur = R.cityRanking(inp.docs, inp.hists, ctx.state.latest, o); const per = R.rankingPeriods(inp.docs); let prev = null;
    if (!per.reason) { const a = R.cityRanking(per.cur, inp.hists, ctx.state.latest, o), b = R.cityRanking(per.prev, inp.hists, ctx.state.latest, o); prev = { n: per.n, cur: new Map(a.rows.map(r => [r.key, r])), prev: new Map(b.rows.map(r => [r.key, r])), from: per.prev[0].day, to: lastOf(per.prev).day, curFrom: per.cur[0].day, curTo: lastOf(per.cur).day }; }
    RANK_CACHE.set(k, { ...cur, prev, reason: per.reason || null }); }
  return RANK_CACHE.get(k);
}
const RK_COLS_DEF = () => ([['name', t('rep.cityState'), false, 'asc'], ['ty', t('rep.type'), false, 'asc'], ['fleet', t('rep.avgFleet'), true, 'desc'], ['ridesDay', t('rep.tripsDay2'), true, 'desc'], ['rvd', t('rep.perVehAndDay'), true, 'desc', t('rep.tripsPerVehiclePerDay2')], ['per1000Fleet', t('rep.vehPer1000Residents'), true, 'desc'], ['per1000Rides', t('rep.tripsPer1000ResidentsDay'), true, 'desc'], ['opCount', t('rep.operator2'), true, 'desc']]);
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
  bindOnce(el, 'rank', () => { bindFilters(el, s, draw); bindSort(el, s, [...RK_COLS_DEF(), ['delta', '', true, 'desc']], draw); bindCity(el, ctx); el.addEventListener('click', (e) => { if (e.target.closest('button[data-rp="rkcsv"]')) rankingCsv(el); }); });
  const title = head(t('rep.cityRanking'), t('rep.tripsPerVehiclePerDayByCity'));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), ''); return; }
  const tok = ++s.tok; el.classList.add('rp-busy'); if (!s.inp) el.innerHTML = title + `<div class="muted small">${t('rep.loadingDailyFiles')}</div>`;
  try {
    const [inp, archDays] = await Promise.all([rankingInputs(ctx), archiveDayList(ctx).catch(() => [])]); if (tok !== s.tok) return; s.inp = inp;
    // Vorquartal aus dem Langzeit-Archiv, sobald zwei aufeinanderfolgende Quartale vollständig vorliegen
    const rq = R.rankingQuarters(archDays);
    if (rq && s.rq?.cur !== rq.cur) { const { archive, fields } = await archiveFor(ctx, [...rq.prevDays, ...rq.curDays]); if (tok !== s.tok) return; s.rq = { ...rq, archive, fields }; }
    else if (!rq) s.rq = null;
    draw();
  }
  catch (e) { console.error('Rangliste', e); if (tok === s.tok) el.innerHTML = title + emptyBox(t('rep.rankingCannotBeCreated'), t('rep.dailyFilesNotLoadable')); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}
function drawRanking(el) {
  const s = st(el); const ctx = s.ctx; const { esc, fmt, state } = ctx; if (!s.inp) return;
  const title = (right = '') => head(t('rep.cityRanking'), t('rep.tripsPerVehiclePerDayByCity2', { v0: plural(s.inp.docs.length, t('rep.day'), t('rep.days')), v1: s.inp.limits?.scooter ? ctx.fmt(s.inp.limits.scooter, 2) : '15' }), right);
  if (!s.inp.docs.length) { el.innerHTML = title() + emptyBox(t('rep.noDailyFilesYet'), t('rep.tripsAriseFromSecond')); return; }
  const rk = rankingFor(ctx, s.inp, s.type, s.op);
  const scope = state.scope && state.scope !== 'DE' ? state.scope : null;
  let rows = rk.rows.filter(r => r.fleet >= s.min || r.ags === scope);
  if (rk.prev) for (const r of rows) { const a = rk.prev.cur.get(r.key), b = rk.prev.prev.get(r.key); r.delta = a?.rvd != null && b?.rvd != null ? a.rvd - b.rvd : null; }
  // Quartalsvergleich (Archiv) vor dem Wochenvergleich
  let qcmp = null;
  if (s.rq) {
    const A = (ds) => new Map(R.cityRankingArchive(s.rq.archive, state.latest, { fields: s.rq.fields, type: s.type, operator: s.op, days: ds, rvdLimit: s.inp.limits, breaks: s.inp.breaks || null, eventChecks: state.latest?.eventChecks }).rows.map(r => [r.key, r]));
    const ck = `${s.rq.cur}|${s.type}|${s.op}`; if (s.qcmpKey !== ck) { s.qcmp = { cur: A(s.rq.curDays), prev: A(s.rq.prevDays) }; s.qcmpKey = ck; } qcmp = s.qcmp;
    for (const r of rows) { const a = qcmp.cur.get(r.key), b = qcmp.prev.get(r.key); r.delta = a?.rvd != null && b?.rvd != null ? a.rvd - b.rvd : null; }
  }
  rows = R.sortRows(rows, s.sort.key, s.sort.dir); s.rows = rows; s.rk = rk;
  const qLab = (q) => R.periodRange(`q:${q}`).label;
  const cols = qcmp ? [...RK_COLS_DEF(), ['delta', t('rep.toPreviousQuarter'), true, 'desc', t('rep.perVehAndDayAgainstArchive', { v0: qLab(s.rq.cur), v1: qLab(s.rq.prev) })]] : rk.prev ? [...RK_COLS_DEF(), ['delta', t('rep.toPreviousPeriod'), true, 'desc', t('rep.perVehAndDayAgainst', { v0: dd(rk.prev.curFrom), v1: dd(rk.prev.curTo), v2: dd(rk.prev.from), v3: dd(rk.prev.to) })]] : RK_COLS_DEF();
  const show = rows.slice(0, s.limit);
  const body = show.map((r, i) => `<tr${r.ags === scope ? ' class="rp-sel" aria-current="true"' : ''}><td>${cityCell(ctx, r.ags, r.name, r.state)}${r.excluded.length ? `<div class="sub-line">${t('rep.tripsWithoutImplausible', { join: esc(r.excluded.join(', ')) })}</div>` : ''}</td><td>${esc(typeName(r.ty))}</td>
    <td class="n">${fmt(r.fleet)}</td><td class="n">${r.ridesDay == null ? '—' : fmt(r.ridesDay)}</td><td class="n"><b>${r.rvd == null ? '—' : fmt(r.rvd, 2)}</b></td><td class="n">${r.per1000Fleet == null ? '—' : fmt(r.per1000Fleet, 1)}</td><td class="n">${r.per1000Rides == null ? '—' : fmt(r.per1000Rides, 1)}</td><td class="n">${r.opCount}</td>
    ${qcmp || rk.prev ? `<td class="n">${r.delta == null ? '—' : `${r.delta > 0 ? '+' : ''}${fmt(r.delta, 2)}`}</td>` : ''}</tr>`).join('');
  const note = `<div class="note small" style="margin-bottom:var(--s3)">${t('rep.typeOfRankingAsInFluctuo', { v0: rk.prelim ? `${t('rep.preliminaryOnlyFull', { fullDays: rk.fullDays, profileSource: esc(tx(rk.profileSource)) })} ` : '', v1: qcmp ? t('rep.previousPeriodAgainstFrom', { qLab: esc(qLab(s.rq.cur)), qLab2: esc(qLab(s.rq.prev)) }) : rk.reason ? t('rep.columnHiddenQuarter', { reason: esc(tx(rk.reason)) }) : t('rep.previousPeriodDaysEach', { n: rk.prev.n }) })}</div>`;
  el.innerHTML = title(`<div class="rp-ctl rp-noprint"><button type="button" data-rp="rkcsv">↓ CSV</button></div>`) + filterCtl(ctx, s, { minLabel: t('rep.minimumFleet2') }) + note
    + `<div class="tbl"><table>${sortHead(cols, s.sort)}<tbody>${body || `<tr><td colspan="${cols.length}" class="empty">${t('rep.noCityInFilterLowerMinimum2')}</td></tr>`}</tbody></table></div>${moreBtn(show.length, rows.length)}`;
}
function rankingCsv(el) {
  const s = st(el); if (!s.rows) return;
  const vp = s.rq ? t('rep.against', { cur: s.rq.cur, prev: s.rq.prev }) : s.rk.prev ? t('rep.against2', { curFrom: s.rk.prev.curFrom, curTo: s.rk.prev.curTo, from: s.rk.prev.from, to: s.rk.prev.to }) : '';
  const rows = [[t('rep.rank'), 'AGS', t('rep.city'), t('rep.state'), t('rep.vehicleType'), R.csvText('Flotte_Mittel', lang()), t('rep.tripsperday'), t('rep.tripspervehicleday'), t('rep.vehiclesper1000residents'), t('rep.tripsper1000residentsday'), t('rep.operator2'), t('rep.csvDeltaPrev'), t('rep.days'), t('rep.csvPrelim'), t('rep.note'), t('rep.previousPeriod')],
    ...s.rows.map((r, i) => [i + 1, r.ags, r.name, r.state || '', typeName(r.ty), [r.fleet, 1], [r.ridesDay, 1], [r.rvd, 2], [r.per1000Fleet, 2], [r.per1000Rides, 2], r.opCount, [r.delta, 2], s.rk.days.length, s.rk.prelim ? t('rep.yes') : t('rep.no'), r.excluded.length ? t('rep.without', { v0: r.excluded.join(', ') }) : '', vp])];
  download(`${t('file.cityRanking')}_${s.type}_${lastOf(s.rk.days)}.csv`, R.toCsv(rows, lang()));
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
      showRowsTip(box, svg, r.left + p.px * k, r.top + p.py * k - 6, `${p.name}${p.state ? ` (${p.state})` : ''} · ${typeName(p.ty)}`, [{ color: 'transparent', value: s.ctx.fmt(p.rvd, 2), label: t('rep.tripsPerVehiclePerDay2') }, { color: 'transparent', value: s.ctx.fmt(p.density, 1), label: t('rep.vehiclesPerKm2') }, { color: 'transparent', value: s.ctx.fmt(p.fleet), label: t('rep.avgFleetKm2', { v0: s.ctx.fmt(p.areaKm2, 1) }) }]); c.i = i; };
    el.addEventListener('pointermove', (e) => { const svg = e.target.closest?.('svg.rp-scatter'); if (svg) show(svg, near(svg, e)); });
    el.addEventListener('pointerout', (e) => { const svg = e.target.closest?.('svg.rp-scatter'); if (svg && !svg.contains(e.relatedTarget)) show(svg, null); });
    el.addEventListener('keydown', (e) => { const svg = e.target.closest?.('svg.rp-scatter'); if (!svg || !s.sc) return; const d = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1 }[e.key]; if (!d) return; e.preventDefault(); const n = s.sc.pts.length; show(svg, (((s.sc.i ?? -1) + d) % n + n) % n); });
    el.addEventListener('focusout', (e) => { if (e.target.matches?.('svg.rp-scatter')) show(e.target, null); });
  });
  const title = head(t('rep.densityVersusUsage'), t('rep.tripsPerVehiclePerDayAgainst'));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), ''); return; }
  const tok = ++s.tok; el.classList.add('rp-busy');
  try { const inp = await rankingInputs(ctx); if (tok !== s.tok) return; s.inp = inp; draw(); }
  catch (e) { console.error('Dichte', e); if (tok === s.tok) el.innerHTML = title + emptyBox(t('rep.chartCannotBeCreated'), t('rep.dailyFilesNotLoadable')); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}
function drawScatter(el) {
  const s = st(el); const ctx = s.ctx; const { esc, fmt, state } = ctx; if (!s.inp) return;
  const title = (right = '') => head(t('rep.densityVersusUsage'), t('rep.tripsPerVehiclePerDayAgainst2', { v0: plural(s.inp.docs.length, t('rep.day'), t('rep.days')) }), right);
  const hasArea = Object.values(state.latest.municipalities || {}).some(m => +m.areaKm2 > 0);
  if (!hasArea) { s.sc = null; el.innerHTML = title() + emptyBox(t('rep.areaPerMunicipalityIsMissing'), t('rep.chartAppearsAsSoonAsLatest')); return; }
  const rk = rankingFor(ctx, s.inp, s.type, s.op);
  const scope = state.scope && state.scope !== 'DE' ? state.scope : null;
  const pts = R.densityPoints(rk.rows.filter(r => r.fleet >= s.min || r.ags === scope));
  const btn = `<div class="rp-ctl rp-noprint"><button type="button" data-rp="sctable" aria-expanded="${s.showTable ? 'true' : 'false'}">${s.showTable ? t('rep.asChart') : t('rep.asTable')}</button></div>`;
  const note = `<div class="muted small" style="margin-top:var(--s2)">${t('rep.municipalitiesWithAreaAnd', { length: pts.length, v1: rk.prelim ? ` · ${t('rep.preliminaryUnder3Full')}` : '', v2: pts.some(p => p.excluded.length) ? ` · ${t('rep.implausibleOperatorsOnlyIn')}` : '' })}</div>`;
  if (!pts.length) { s.sc = null; el.innerHTML = title(btn) + filterCtl(ctx, s, { minLabel: t('rep.minimumFleet2') }) + emptyBox(t('rep.noMunicipalityInFilter'), t('rep.lowerMinimumFleetOrChange')); return; }
  if (s.showTable) {
    const rows = R.sortRows(pts, 'rvd', 'desc');
    s.sc = null; el.innerHTML = title(btn) + filterCtl(ctx, s, { minLabel: t('rep.minimumFleet2') }) + `<div class="tbl"><table><thead><tr><th>${t('rep.cityState')}</th><th>${t('rep.type')}</th><th class="n">${t('rep.vehiclesPerKm2')}</th><th class="n">${t('rep.tripsPerVehAndDay')}</th><th class="n">${t('rep.avgFleet')}</th><th class="n">${t('rep.areaKm2')}</th></tr></thead><tbody>${rows.map(p => `<tr${p.ags === scope ? ' class="rp-sel"' : ''}><td>${cityCell(ctx, p.ags, p.name, p.state)}</td><td>${esc(typeName(p.ty))}</td><td class="n">${fmt(p.density, 1)}</td><td class="n">${fmt(p.rvd, 2)}</td><td class="n">${fmt(p.fleet)}</td><td class="n">${fmt(p.areaKm2, 1)}</td></tr>`).join('')}</tbody></table></div>` + note;
    return;
  }
  const W = 900, H = 340, P = { l: 48, r: 24, t: 14, b: 40 };
  const lx = pts.map(p => Math.log10(p.density)); let x0 = Math.floor(Math.min(...lx)), x1 = Math.ceil(Math.max(...lx)); if (x1 === x0) x1 = x0 + 1;
  const ymax = Math.max(1, Math.ceil(Math.max(...pts.map(p => p.rvd)) * 1.1));
  const X = (d) => P.l + ((Math.log10(d) - x0) / (x1 - x0)) * (W - P.l - P.r), Y = (v) => P.t + (1 - v / ymax) * (H - P.t - P.b);
  let g = ''; const yStep = ymax <= 4 ? 1 : ymax <= 10 ? 2 : 5;
  for (let v = 0; v <= ymax; v += yStep) g += `<line class="${v === 0 ? 'base' : 'grid'}" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${P.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`;
  for (let e = x0; e <= x1; e++) { const d = 10 ** e; g += `<line class="grid" x1="${X(d)}" x2="${X(d)}" y1="${P.t}" y2="${H - P.b}"/><text x="${X(d)}" y="${H - P.b + 16}" text-anchor="middle">${fmt(d, d < 1 ? 1 : 0)}</text>`; }
  g += `<text x="${(P.l + W - P.r) / 2}" y="${H - 4}" text-anchor="middle">${t('rep.vehiclesPerKm2Log')}</text><text x="12" y="${P.t + (H - P.t - P.b) / 2}" text-anchor="middle" transform="rotate(-90 12 ${P.t + (H - P.t - P.b) / 2})">${t('rep.tripsPerVehAndDay')}</text>`;
  const P2 = pts.map(p => ({ ...p, px: X(p.density), py: Y(p.rvd) }));
  // Beschriftung sparsam: gewählte Stadt, höchste Quote, höchste Dichte
  const lab = new Set([scope && P2.findIndex(p => p.ags === scope), P2.indexOf(R.sortRows(P2, 'rvd', 'desc')[0]), P2.indexOf(R.sortRows(P2, 'density', 'desc')[0])].filter(i => i != null && i >= 0));
  const dots = P2.map((p, i) => `<circle data-i="${i}" cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="${p.ags === scope ? 6 : 4.5}" class="${p.ags === scope ? 'sel-pt' : ''}"/>`).join('');
  const placed = []; const labels = [...lab].map(i => { const p = P2[i]; const right = p.px < W - 160; const w = 7 * p.name.length + 4; const bx = right ? p.px + 9 : p.px - 9 - w; const box = [bx, p.py - 9, bx + w, p.py + 5];
    if (placed.some(q => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) return ''; placed.push(box);
    return `<text class="lab" x="${(p.px + (right ? 9 : -9)).toFixed(1)}" y="${(p.py + 4).toFixed(1)}" text-anchor="${right ? 'start' : 'end'}">${esc(p.name)}</text>`; }).join('');
  s.sc = { pts: P2, W, i: null };
  el.innerHTML = title(btn) + filterCtl(ctx, s, { minLabel: t('rep.minimumFleet2') }) + `<div class="rp-chart"><svg class="rp-line rp-scatter" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${t('rep.scatterPlotWith', { length: P2.length })}">${g}<g class="pts">${dots}</g>${labels}</svg></div>` + note;
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
const euro = (ctx, v) => (v == null ? '—' : `${ctx.fmt(v)} €`);
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
  const title = head(t('rep.feeCalculator'), t('rep.specialUseFeeFromCounted', { v0: stamp(state.latest?.at) }));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), ''); return; }
  const ref = await reference(ctx); if (tok !== s.tok) return;
  const list = R.feeEstimates(ref, state.latest.groups, { ags: state.scope || 'DE' });
  const { esc, fmt } = ctx;
  const rows = list.map(e => `<tr><td>${esc(e.ort || state.latest.municipalities?.[e.ags]?.name || e.ags)}</td><td>${esc(e.types.map(typeName).join(', ') || t('rep.all'))}</td>
    <td class="n">${e.rate ? `${e.rate.range ? `${fmt(+[].concat(e.satz)[0])}–${fmt(+[].concat(e.satz).slice(-1)[0])}` : fmt(+[].concat(e.satz)[0], 2)}${/€/.test(e.einheit || '') ? '' : ' €'}` : '—'}<div class="sub-line">${esc(tx(e.einheit || ''))}</div></td><td class="small" translate="no">${esc(e.gebiet || '–')}</td>
    <td class="n">${fmt(e.count)}<div class="sub-line">${plural(e.operators.length, t('rep.operatorOne'), t('rep.operatorMany'))}</div></td><td class="n"><b>${span(ctx, e.yearMin, e.yearMax)}</b></td><td class="n">${span(ctx, e.monthMin, e.monthMax)}</td><td class="small">${safeLink(ctx, e.url, e.quelle || t('rep.source'))}${e.stand ? `<div class="sub-line">${t('rep.asOf4', { v0: /^\d{4}-\d{2}-\d{2}$/.test(e.stand) ? dd(e.stand) : esc(e.stand) })}</div>` : ''}</td></tr>`).join('');
  const table = list.length ? `<div class="tbl"><table><thead><tr><th>${t('rep.city')}</th><th>${t('rep.type')}</th><th class="n">${t('rep.rate')}</th><th>${t('rep.area')}</th><th class="n">${t('rep.counted')}</th><th class="n">${t('rep.perYear')}</th><th class="n">${t('rep.perMonth')}</th><th>${t('rep.source')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : emptyBox(ref?.gebuehren?.length ? t('rep.noFeeRateWithSourceIsStored') : t('rep.noFeeRatesWithSourceStored'), ref?.gebuehren?.length ? t('rep.storedForOwnRateBelow', { list: [...new Set(ref.gebuehren.map(g => g.ort))].map(esc).join(', ') }) : t('rep.referenceJsonGebuehrenIs'));
  const { types } = groupOptions(state.latest);
  const own = `<div class="panel-head" style="margin-top:var(--s4)"><div><h3 style="margin:0;font-size:14px">${t('rep.ownRate')}</h3><div class="sub">${t('rep.forMunicipalitiesWithoutRate')}</div></div></div>
    <div class="rp-ctl rp-noprint"><label>${t('rep.rate')} <input type="number" data-own="rate" min="0" step="0.5" value="${esc(s.own.rate)}" placeholder="z. B. 50" style="width:7em" aria-label="${t('rep.ownFeeRateInEuros')}"> €</label>
    <label>${t('rep.perVehicleAnd')} <select data-own="unit"><option value="jahr"${s.own.unit === 'jahr' ? ' selected' : ''}>${t('rep.year')}</option><option value="monat"${s.own.unit === 'monat' ? ' selected' : ''}>${t('rep.month')}</option></select></label>
    <label>${t('rep.vehicleType')} <select data-own="type">${types.map(tq => `<option value="${esc(tq)}"${tq === s.own.type ? ' selected' : ''}>${esc(typeName(tq))}</option>`).join('')}</select></label></div>
    <div data-rp="ownout" aria-live="polite" style="margin-top:var(--s2)">${ownOut(ctx, s)}</div>`;
  el.innerHTML = title + `<div class="note small" style="margin-bottom:var(--s3)">${t('rep.countedVehiclesOfType')}</div>` + table + own;
}
function ownOut(ctx, s) {
  const { state, fmt, esc } = ctx; const scope = state.scope;
  const rate = parseFloat(String(s.own.rate).replace(',', '.'));
  if (!scope || scope === 'DE') return `<span class="muted small">${t('rep.chooseMunicipalityAboveUnder')}</span>`;
  const count = Object.entries(state.latest?.groups || {}).filter(([k]) => { const [a, , tq] = k.split('|'); return a === scope && tq === s.own.type; }).reduce((a, [, g]) => a + (g.total || 0), 0);
  const name = state.latest?.municipalities?.[scope]?.name || scope;
  if (!Number.isFinite(rate)) return `<span class="muted small">${t('rep.countedEnterRate', { name: esc(name), count: fmt(count), typeName: esc(typeName(s.own.type)) })}</span>`;
  const r = R.ownFee(rate, s.own.unit, count);
  return `<div class="tiles">${tile(`${esc(name)} · ${esc(typeName(s.own.type))}`, fmt(count), t('rep.countedVehicles'))}${tile(t('rep.perYear'), euro(ctx, r.year), t('rep.perVehicleAndOwnRate', { rate: fmt(rate, 2), v1: s.own.unit === 'monat' ? t('rep.month') : t('rep.year') }))}${tile(t('rep.perMonth'), euro(ctx, r.month), t('rep.ownRateWithoutSource'))}</div>`;
}

// ======================================================================
// 11. Steckbrief Regulierung
// ======================================================================
/** Steckbrief je Stadt aus reference.json (Obergrenzen, Gebühren, Referenzwerte) und Anbieter laut Daten; bei 'DE' alle Städte mit Eintrag */
export async function renderRegulationProfile(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc, fmt } = ctx; const tok = ++s.tok;
  const title = head(t('rep.regulationProfile'), t('rep.fleetCapsFeesAndReference'));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), ''); return; }
  const ref = await reference(ctx); if (tok !== s.tok) return;
  if (!ref) { el.innerHTML = title + emptyBox(t('rep.referenceValuesNotLoadable'), t('rep.referenceJsonIsMissingOr2')); return; }
  const profs = R.regulationProfiles(ref, state.latest, { ags: state.scope || 'DE', asOf: state.latest.at || Date.now() });
  const src = (e) => safeLink(ctx, e.url, e.quelle || t('rep.source'));
  const card = (p) => {
    const caps = p.caps.map(c => t('rep.inTotalCounted', { limit: fmt(c.limit), typeName: esc(typeName(c.type)), v2: c.perOperator != null ? t('rep.perOperator4', { perOperator: fmt(c.perOperator) }) : '', v3: c.districts.length ? `; ${c.districts.map(d => `${srcTxt(esc, d.label)} ${d.limit != null ? fmt(d.limit) : d.perOperator != null ? t('rep.perOperatorZone', { perOperator: fmt(d.perOperator) }) : '—'}`).join(', ')}` : '', v4: c.previous != null ? ` <span class="muted">${t('rep.fromBeforeThat', { v0: dd(c.since), previous: fmt(c.previous) })}</span>` : '', v5: badge(c.status), total: fmt(c.total), c: src(c) })).join('<br>') || `<span class="muted">${t('rep.notStored')}</span>`;
    const fees = p.fees.map(f => `${esc([].concat(f.satz).join('–'))} ${esc(tx(f.einheit || ''))} · ${esc([].concat(f.type || []).map(typeName).join(', '))}${f.gebiet ? ` · ${srcTxt(esc, f.gebiet)}` : ''} · ${src(f)}`).join('<br>') || `<span class="muted">${t('rep.noRateWithSourceStored')}</span>`;
    const ops = Object.entries(p.operators).sort((a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0])).map(([ty, l]) => `${esc(typeName(ty))}: ${l.length} <span class="muted">(${l.map(esc).join(', ')})</span>`).join('<br>') || `<span class="muted">${t('rep.noVehiclesInOpenFeeds')}</span>`;
    const refs = p.refs.map(r => { const v = r.kind === 'fahrt' ? tripTxt(ctx, r) : fmt(r.wert, r.kind === 'rvd' ? 2 : 0);
      return `${({ rvd: t('rep.tripsPerVehAndDay'), flotte: fleetLabel(r), fahrt: t('rep.trip2'), fahrten: t('rep.trips') })[r.kind]} ${esc(typeName(r.type))}: ${v} <span class="muted">(${esc(r.zeitraum || r.stand || '')})</span> · ${src(r)}`; }).join('<br>') || `<span class="muted">${t('rep.none')}</span>`;
    return `<div class="card"><b>${esc(p.name)}${p.state ? ` <span class="muted">(${esc(p.state)})</span>` : ''}</b><div class="foot">AGS ${esc(p.ags)}${p.pop ? ` · ${t('rep.residents', { pop: fmt(p.pop) })}` : ''}</div>
      <dl><dt>${t('rep.fleetCaps')}</dt><dd>${caps}${p.caps.length ? `<div><a href="#bericht" data-rp-jump="rp-caps">${t('rep.capCheckLink')}</a></div>` : ''}</dd><dt>${t('rep.fees')}</dt><dd>${fees}</dd><dt>${t('rep.operatorsAccordingToData')}</dt><dd>${ops}</dd><dt>${t('rep.referenceValues')}</dt><dd>${refs}</dd><dt>${t('rep.accidents')}</dt><dd><span class="muted">${t('rep.noMapUnfallatlasDoesNotListE')}</span></dd></dl></div>`;
  };
  el.innerHTML = title + (profs.length ? `<div class="rp-prof">${profs.map(card).join('')}</div>` : emptyBox(t('rep.noRegulationDataStored'), t('rep.referenceJsonHasNoEntryFor')))
    + `<div class="muted small" style="margin-top:var(--s2)">${t('rep.onlyInformationStatedIn')}</div>`;
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
  const title = head(t('rep.hotspotStability'), t('rep.overlapOfTop200StartCells'));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), ''); return; }
  if (!state.scope || state.scope === 'DE') { el.innerHTML = title + emptyBox(t('rep.chooseMunicipality'), t('rep.stabilityIsCalculatedPer')); return; }
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
    const tiles = `<div class="tiles">${tile(t('rep.avgOverlap'), stb.meanShare == null ? '—' : pctTxt(ctx, stb.meanShare, 0), t('rep.sharedTopCellsSmallerTopSet', { v0: thin ? ` · ${t('rep.preliminary')}` : '' }))}${tile(t('rep.dayPairs'), fmt(stb.pairs.length), t('rep.withCells', { v0: plural(stb.days.length, t('rep.day'), t('rep.days')) }))}${tile(t('rep.topCellsPerDay'), t('rep.upTo', { top: stb.top }), t('rep.onlyCellsWithTripStarts', { minCount: stb.minCount }))}</div>`;
    const rows = stb.pairs.map(p => `<tr><td>${dd(p.a)} → ${dd(p.b)}</td><td class="n">${fmt(p.nA)} / ${fmt(p.nB)}</td><td class="n">${fmt(p.common)}</td><td class="n"><b>${pctTxt(ctx, p.share, 0)}</b></td><td class="n">${pctTxt(ctx, p.jaccard, 0)}</td><td class="n">${oh(p.a)} / ${oh(p.b)}</td></tr>`).join('');
    el.innerHTML = title + tiles + (stb.pairs.length ? `<div class="tbl" style="margin-top:var(--s3)"><table><thead><tr><th>${t('rep.days')}</th><th class="n">${t('rep.topCells')}</th><th class="n">${t('rep.shared')}</th><th class="n">${t('rep.overlap')}</th><th class="n">Jaccard</th><th class="n">${t('rep.observed3')}</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyBox(t('rep.onlyOneDayWithCellsSoFar'), t('rep.overlapNeedsAtLeastTwo')))
      + `<div class="note small" style="margin-top:var(--s3)">${t('rep.measureAsInValidationBy', { v0: thin ? t('rep.caseHere') : t('rep.under20Hours') })}</div>`;
  } catch (e) { console.error('Hotspots', e); if (tok === s.tok) el.innerHTML = title + emptyBox(t('rep.notComputable'), t('rep.cellFilesNotLoadable')); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}

// ======================================================================
// Prognose (forecast/latest.json, forecast/log.json): erwartete Fahrtbeginne der nächsten 24 Stunden, Selbstprüfung, Live-Abgleich
// ======================================================================
const FC_MIN_FLEET = 5, FC_HIGH = 1.25, FC_LOW = 0.6;
function fcBars(ctx, series, local, width) {
  const W = Math.max(300, Math.min(1100, Math.round(width || 720))), H = 140, pl = 4, pb = 22, pt = 8, n = series.length, max = Math.max(1, ...series), bw = (W - 2 * pl) / n, total = series.reduce((a, b) => a + b, 0), every = W < 480 ? 6 : 3;
  const bars = series.map((v, i) => { const h = Math.max(1, (H - pt - pb) * v / max); return `<rect class="fcb" style="fill:var(--accent)" x="${(pl + i * bw + 1.5).toFixed(1)}" y="${(H - pb - h).toFixed(1)}" width="${Math.max(2, bw - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${local[i][1]}:00 · ${ctx.fmt(v, v < 10 ? 1 : 0)}</title></rect>`; }).join('');
  const lab = local.map(([, h], i) => (i % every === 0 ? `<text x="${(pl + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="currentColor" opacity=".75" font-size="11">${h}</text>` : '')).join('');
  return `<div class="rp-chart"><svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;max-width:${W}px" role="img" aria-label="${ctx.esc(t('fc.chartAria', { total: ctx.fmt(total) }))}">${bars}${lab}</svg></div>`;
}
export async function renderForecast(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc, fmt } = ctx; const tok = ++s.tok;
  const title = head(t('fc.title'), t('fc.sub'));
  el.classList.add('rp-busy');
  try {
    const [fc, lg] = await Promise.all([fetchJson(ctx, 'forecast/latest.json', true), fetchJson(ctx, 'forecast/log.json', true)]); if (tok !== s.tok) return;
    if (!fc || fc.version !== 1) { el.innerHTML = title + emptyBox(t('fc.none'), t('fc.noneHint')); return; }
    const G = fc.gates || {}, minTrain = G.minTrainDays ?? 2, minEval = G.minEvalDays ?? 3;
    const modelName = (m) => (m ? t(`fc.model.${m}`) : '–');
    const status = fc.status === 'active' ? t('fc.statusActive', { model: modelName(fc.active), reason: esc(fc.reason || '') })
      : fc.status === 'learning' ? t('fc.statusLearning', { n: fc.evalDays || 0, min: minEval }) : t('fc.statusInsufficient', { n: fc.trainDays || 0, min: minTrain });
    const badge = `<p class="note small" style="margin:0 0 var(--s3)"><span class="rp-status ${fc.status === 'active' ? 'ok' : 'near'}" style="white-space:normal;align-items:flex-start"><i aria-hidden="true" style="margin-top:2px">${fc.status === 'active' ? '✓' : '!'}</i>${esc(status)}</span></p>`;
    if (!fc.horizon || !fc.totals) { el.innerHTML = title + badge + emptyBox(t('fc.none'), t('fc.noneHint')); return; }
    const ags = state.scope && state.scope !== 'DE' ? state.scope : null;
    const series = ags ? fc.municipalities?.[ags] : fc.totals, local = fc.horizon.local;
    const pct = (v) => (v == null ? '–' : `${fmt(v * 100, 0)} %`);
    // Live-Abgleich: Mittel der letzten bewerteten Prognosen
    const live = (fc.live || []).slice(-6), avg = (k) => { const v = live.map(x => x[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const ev = lg?.evals || {}, evDays = Object.keys(ev).sort().slice(-(G.evalWindow || 7));
    const evAvg = (m) => { const v = evDays.map(d => ev[d]?.models?.[m]?.wapeGD).filter(x => x != null); return v.length >= minEval ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const wg = fc.weather?.gate || {};
    const time = new Intl.DateTimeFormat(fmtLocale(), { hour: '2-digit', minute: '2-digit', timeZone: R.TZ }).format(new Date(fc.horizon.from));
    const scopeTxt = ags ? esc(ctx.muniName?.(ags) || state.latest?.municipalities?.[ags]?.name || ags) : t('fc.scopeDE');
    const tiles = `<div class="tiles">`
      + tile(t('fc.expected'), series ? fmt(series.reduce((a, b) => a + b, 0), 0) : '—', t('fc.expectedSub', { time, scope: scopeTxt }))
      + tile(t('fc.liveError'), avg('wapeOpH') == null ? '—' : pct(avg('wapeOpH')), live.length ? t('fc.liveErrorSub', { n: live.length, naive: pct(avg('naiveOpH')), skill: avg('skill') == null ? '–' : pct(avg('skill')) }) : t('fc.liveNone'))
      + tile(t('fc.backtest'), evAvg(fc.active || 'pooled') == null ? '—' : pct(evAvg(fc.active || 'pooled')), evAvg('pooled') == null ? t('fc.backtestNone') : t('fc.backtestSub', { n: evDays.length, profile: pct(evAvg('profile')), pooled: pct(evAvg('pooled')) }))
      + tile(t('fc.weather'), fc.weather?.used ? t('fc.weatherOn') : t('fc.weatherOff'), t('fc.weatherSub', { k: fmt(wg.tempRangeK ?? 0, 1), rain: wg.rainDays ?? 0, dry: wg.dryDays ?? 0, kmin: G.wxTempRangeK ?? 5, dmin: G.wxRainDays ?? 2 }))
      + `</div>`;
    const chart = series ? `<div style="margin-top:var(--s3)">${fcBars(ctx, series, local, el.clientWidth - 40)}<div class="rp-chart fc-wx"></div></div>` : `<div class="note" style="margin-top:var(--s3)">${t('fc.noMuni')}</div>`;
    // Auslastung: erwartete Fahrtbeginne je Fahrzeug gegen den Median der Fahrzeugart (Gruppen ab FC_MIN_FLEET Fahrzeugen)
    const rows = Object.entries(fc.groups || {}).map(([k, g]) => { const [a, op, ty] = k.split('|'); return { k, ags: a, op, ty, fleet: g.fleet, starts: g.start.reduce((x, y) => x + y, 0), perVeh: g.perVeh }; });
    const med = {}; for (const key of new Set(rows.map(r => `${r.op}|${r.ty}`))) { const v = rows.filter(r => `${r.op}|${r.ty}` === key && r.fleet >= FC_MIN_FLEET && r.perVeh != null).map(r => r.perVeh).sort((a, b) => a - b); if (v.length >= 3) med[key] = v[Math.floor(v.length / 2)]; }
    for (const r of rows) { r.vs = med[`${r.op}|${r.ty}`] && r.fleet >= FC_MIN_FLEET && r.perVeh != null ? r.perVeh / med[`${r.op}|${r.ty}`] : null; r.cls = r.vs == null ? null : r.vs >= FC_HIGH ? 'high' : r.vs <= FC_LOW ? 'low' : 'mid'; }
    const clsTxt = (c) => (c === 'high' ? `<span class="rp-status near"><i aria-hidden="true">▲</i>${t('fc.high')}</span>` : c === 'low' ? `<span class="rp-status over"><i aria-hidden="true">▼</i>${t('fc.low')}</span>` : c === 'mid' ? t('fc.mid') : '–');
    const line = (r, withMuni) => `<tr><td>${withMuni ? `${esc(ctx.muniName?.(r.ags) || state.latest?.municipalities?.[r.ags]?.name || r.ags)} · ` : ''}${esc(r.op)} · ${esc(typeName(r.ty))}</td><td class="n">${fmt(r.fleet, 0)}</td><td class="n">${fmt(r.starts, 0)}</td><td class="n">${r.perVeh == null ? '–' : fmt(r.perVeh, 1)}</td><td class="n">${r.vs == null ? '–' : `${fmt(r.vs, 2)}×`}</td><td>${clsTxt(r.cls)}</td></tr>`;
    const thead = (first) => `<thead><tr><th>${first}</th><th class="n">${t('fc.colFleet')}</th><th class="n">${t('fc.colStarts')}</th><th class="n">${t('fc.colPerVeh')}</th><th class="n">${t('fc.colVs')}</th><th>${t('fc.colClass')}</th></tr></thead>`;
    let body = '';
    if (ags) {
      const mine = rows.filter(r => r.ags === ags).sort((a, b) => b.starts - a.starts);
      if (mine.length) body = `<h3 style="margin:var(--s4) 0 var(--s1);font-size:14px">${t('fc.tableTitle')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fc.tableTitle'))}"><table>${thead(t('fc.colOperator'))}<tbody>${mine.map(r => line(r, false)).join('')}</tbody></table></div>`;
    } else {
      const top = Object.entries(fc.municipalities || {}).map(([a, v]) => [a, v.reduce((x, y) => x + y, 0)]).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const big = rows.filter(r => r.fleet >= 20 && r.vs != null), hi = [...big].sort((a, b) => b.vs - a.vs).slice(0, 8), lo = [...big].sort((a, b) => a.vs - b.vs).slice(0, 8);
      body = `<div class="grid" style="margin-top:var(--s4)"><div class="c4"><h3 style="margin:0 0 var(--s1);font-size:14px">${t('fc.topMunis')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fc.topMunis'))}"><table><tbody>${top.map(([a, v]) => `<tr><td>${esc(ctx.muniName?.(a) || state.latest?.municipalities?.[a]?.name || a)}</td><td class="n">${fmt(v, 0)}</td></tr>`).join('')}</tbody></table></div></div>`
        + `<div class="c8"><h3 style="margin:0 0 var(--s1);font-size:14px">${t('fc.topHigh', { min: 20 })}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fc.topHigh', { min: 20 }))}"><table>${thead(t('fc.colOperator'))}<tbody>${hi.map(r => line(r, true)).join('')}</tbody></table></div>`
        + `<h3 style="margin:var(--s3) 0 var(--s1);font-size:14px">${t('fc.topLow', { min: 20 })}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fc.topLow', { min: 20 }))}"><table>${thead(t('fc.colOperator'))}<tbody>${lo.map(r => line(r, true)).join('')}</tbody></table></div></div></div>`;
    }
    el.innerHTML = title + badge + tiles + chart + body + `<div class="note small" style="margin-top:var(--s3)">${t('fc.note', { min: FC_MIN_FLEET })}</div>`;
    // Wetter der nächsten 24 Stunden unter den Balken (gleiche x-Achse wie fcBars: W, Rand 4)
    const wxBox = el.querySelector('.fc-wx');
    if (wxBox && series && Array.isArray(local)) weatherFor(local.map(([d, h]) => [d, h]), ags, ctx.getJson, ctx.CFG.DATA).then((vals) => {
      if (!wxBox.isConnected || tok !== s.tok) return; const W = Math.max(300, Math.min(1100, Math.round(el.clientWidth - 40 || 720)));
      const svg = weatherSvg(vals, { W, pl: 4, pr: 4, hours: local.map(([, h]) => h), esc, svgAttrs: `width="100%" style="display:block;max-width:${W}px"` });
      wxBox.innerHTML = svg ? `<style>${WX_CSS}.fc-wx text{fill:currentColor;opacity:.75;font-size:11px}.fc-wx .gl{stroke:var(--line);stroke-width:1}.fc-wx rect.hit{fill:transparent}</style>${svg}<div class="note small">${t('wx.legend', { scope: scopeTxt })}</div>` : '';
    });
  } catch (e) { console.error('Prognose', e); if (tok === s.tok) el.innerHTML = title + emptyBox(t('rep.notComputable'), t('fc.noneHint')); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}

// ======================================================================
// Messbasis: Reifegrad je Kennzahl (research Nr. 15) und Ampel der Ereignisregeln (datamine Nr. 18)
// ======================================================================
const mbEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mbNum = (v, d = 0) => (v == null || !Number.isFinite(+v) ? '–' : new Intl.NumberFormat(fmtLocale(), { maximumFractionDigits: d, minimumFractionDigits: d }).format(v));
const mbPct = (v) => (v == null ? '–' : `${mbNum(v * 100, 0)} %`);
export const mbTypeName = (k) => t(`mb.type${k}`);
/**
 * Messbasis für Abzeichen und Matrix (lib/pulse-econ.js measureBase): latest.json → measure.days (Sammler), bei älterem Datenstand aus den
 * schon geladenen Tagesdateien (state.usage.docs). land: Land des Gebiets (null = Deutschland), days: nur diese Tage, rule: Regelstand.
 */
export function mbBase(state, { land = null, days = null, rule = undefined } = {}) {
  let md = state?.latest?.measure?.version === 1 ? state.latest.measure.days || {} : null;
  if (!md) { md = {}; for (const d of Object.values(state?.usage?.docs || {})) if (d?.day) md[d.day] = mbMeasureDay(d); }
  if (days) { const keep = new Set(days); md = Object.fromEntries(Object.entries(md).filter(([d]) => keep.has(d))); }
  return mbMeasureBase(md, { land, calendar: state?.calendar || null, ...(rule !== undefined ? { rule } : {}) });
}
/** Häufigster Tagtyp einer Tagesliste (Gleichstand: W vor F, S, H) */
export function mbMainType(days, land = null, calendar = null) {
  const n = {}; for (const d of days || []) { const k = mbDayType(d, land, calendar); if (k) n[k] = (n[k] || 0) + 1; }
  return MB_TYPES.reduce((a, k) => ((n[k] || 0) > (n[a] || 0) ? k : a), 'W');
}
/**
 * Abzeichen an einer Kennzahl mit Rate oder Trend: Stufe als Zeichen und Wort (nicht nur Farbe), „Basis x h · Tagtypen W/S/H · Regelstand v“;
 * der vollständige Satz steht für Screenreader im Text und als Tooltip. need: 'full3' | 'weeks2' | 'weeks4' (lib/pulse-econ.js MATURITY).
 */
export function mbBadge(base, need = 'full3', { dayType = null, curve = null } = {}) {
  if (!base) return '';
  const m = mbMaturity(base, need, { dayType });
  const stage = m.met ? t('mb.met') : t('mb.prelim');
  const types = base.types.length ? base.types.join('/') : '–', rule = base.rule || '–';
  const needTxt = m.want ? t(`mb.need.${need}`, { want: m.want, have: m.have, type: m.dayType ? mbTypeName(m.dayType) : '' }) : t('mb.need.now');
  const byType = base.types.map(k => `${mbTypeName(k)} ${mbNum(base.byType[k], 1)} h`).join(', ') || '–';
  const full = t('mb.aria', { stage, need: needTxt, h: mbNum(base.hours, 1), byType, rule }) + (curve ? ` ${curve}` : '');
  return `<span class="mb-badge ${m.met ? 'mb-ok' : 'mb-wait'}" title="${mbEsc(full)}"><span aria-hidden="true"><span class="mb-ico"></span><b>${stage}</b>${m.met ? '' : ` ${m.have}/${m.want}`}<span class="mb-meta"> · ${t('mb.base', { h: mbNum(base.hours, 1) })} · ${t('mb.types', { v: types })} · ${t('mb.rule', { v: mbEsc(rule) })}</span></span><span class="vh">${mbEsc(full)}</span></span>`;
}
/** Abzeichen in die Unterzeile einer Kachel (HTML aus tile()) bzw. aller Kacheln eines Containers setzen */
export const mbInTile = (html, badge) => (badge ? String(html).replace(/<\/div><\/div>\s*$/, `<div class="mb-line">${badge}</div></div></div>`) : html);
export function mbTiles(box, badge) { if (!box || !badge) return; for (const s of box.querySelectorAll('.tile .s')) s.insertAdjacentHTML('beforeend', `<div class="mb-line">${badge}</div>`); }
/** Regelstände eines Tags (eventChecks.dayRules, "" = ohne Angabe) als Text */
const mbRules = (rs) => (Array.isArray(rs) && rs.length ? rs.map(r => r || t('mb.ck.noRule')).join(' + ') : t('mb.ck.noRule'));
/** Befunde der Ampel einer Gruppe als Text (latest.json → eventChecks.groups[k].checks) */
export function mbChecksText(c) {
  if (!c) return '';
  const T0 = { pickup: () => t('mb.ck.pickup', { share: mbPct(c.pickupShare), r: mbNum(c.r, 2) }), se: () => t('mb.ck.se', { v: mbNum(c.se, 2) }), swap0: () => t('mb.ck.swap0', { rides: mbNum(c.rides) }),
    hide: () => t('mb.ck.hide', { share: mbPct(c.hideShare) }), idle: () => t('mb.ck.idle', { share: mbPct(c.idleUnusable) }), batteryFloor: () => t('mb.ck.floor', { v: mbNum(c.batteryFloor) }),
    oldRule: () => t('mb.ck.oldRule', { rule: mbRules(c.oldRule) }) }; // rot nach älterem bzw. gemischtem Regelstand (lib/pulse-econ.js eventChecks ruleNow)
  return (c.flags || []).map(f => (T0[f] ? T0[f]() : f)).join(' · ');
}
export const mbLevel = (lv) => (lv === 'bad' ? `<span class="rp-status over"><i aria-hidden="true">✕</i>${t('mb.red')}</span>` : lv === 'warn' ? `<span class="rp-status near"><i aria-hidden="true">!</i>${t('mb.yellow')}</span>` : `<span class="rp-status ok"><i aria-hidden="true">✓</i>${t('mb.green')}</span>`);
/** Flag-Text im Bericht: Ampel rot vor anderen Flags (Grund für den Ausschluss) */
const mbFlagText = (flags) => (flags.includes(R.AMPEL_RED) ? t('mb.flagRed') : tx(flags[0]));
/** Ampel je Gruppe für die Feed-Prüfung (Gebiet und Anbieter wie oben; gelb und rot zuerst, höchstens 60 Zeilen) */
function mbAmpelHtml(ctx) {
  const { state, esc } = ctx; const ec = state.latest?.eventChecks;
  const h = `<h3 class="mb-h">${t('mb.ampelTitle', { day: ec?.day ? dd(ec.day) : '–' })}</h3>`;
  if (!ec?.groups) return h + `<div class="muted small">${t('mb.ampelNone')}</div>`;
  const W0 = { bad: 2, warn: 1 };
  const rows = Object.entries(ec.groups).filter(([k]) => { const [a, op] = k.split('|'); return (!state.scope || state.scope === 'DE' || a === state.scope) && (state.operator === 'all' || op === state.operator); })
    .sort((a, b) => (W0[b[1].level] || 0) - (W0[a[1].level] || 0) || (b[1].checks?.rides || 0) - (a[1].checks?.rides || 0));
  const shown = rows.filter(([, v]) => v.level !== 'ok').slice(0, 60), n = (lv) => rows.filter(([, v]) => v.level === lv).length, R0 = ec.rules || {};
  const body = shown.map(([k, v]) => { const [a, op, ty] = k.split('|'); const c = v.checks || {};
    return `<tr><td><span class="op"><i style="background:${ctx.opColor(op)}"></i>${esc(op)}</span><div class="sub-line">${esc(typeName(ty))} · ${esc(ctx.muniName(a))}</div></td><td>${mbLevel(v.level)}</td><td class="n">${mbNum(c.rides)}</td><td class="n">${mbPct(c.pickupShare)}<div class="sub-line">r ${mbNum(c.r, 2)}</div></td><td class="n">${mbNum(c.se, 2)}</td><td class="n">${mbNum(c.swapsPer100, 1)}</td><td class="small">${esc(mbChecksText(c))}</td></tr>`; }).join('');
  const rules = t('mb.ampelRules', { pw: mbPct(R0.pickupWarn ?? 0.1), pb: mbPct(R0.pickupBad ?? 0.2), r: mbNum(R0.pickupR ?? 0.5, 1), lo: mbNum(R0.seWarn?.[0] ?? 0.7, 1), hi: mbNum(R0.seWarn?.[1] ?? 1.3, 1), sw: mbNum(R0.swapZeroRides ?? 300), min: mbNum(R0.minRides ?? 50) });
  const old = ec.ruleCurrent === false ? ` ${t('mb.ampelOldRule', { rule: esc(mbRules(ec.dayRules)), now: esc(ec.ruleNow || '–'), n: rows.filter(([, v]) => v.was === 'bad').length })}` : '';
  return h + `<div class="muted small" style="margin-bottom:var(--s2)">${t('mb.ampelSummary', { red: n('bad'), yellow: n('warn'), ok: n('ok') })}${old} ${rules}</div>`
    + (body ? `<div class="tbl" tabindex="0" role="region" aria-label="${t('mb.ampelAria')}"><table><thead><tr><th>${t('rep.operator2')}</th><th>${t('mb.ampel')}</th><th class="n">${t('mb.rides')}</th><th class="n">${t('mb.pickupShare')}</th><th class="n">${t('mb.se')}</th><th class="n">${t('mb.swaps100')}</th><th>${t('mb.findings')}</th></tr></thead><tbody>${body}</tbody></table></div>` : `<div class="muted small">${t('mb.ampelAllOk')}</div>`);
}
