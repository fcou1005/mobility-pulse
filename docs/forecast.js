// Mobility Pulse — Prognose-Ansicht: Plan heute, Ist bis jetzt und Live-Prognose bis Ende morgen als Zeitreihe, Lernstand und Trefferquote der Prognose,
// Bewertung der bekannten Deploy- und Parkspots (Wichtigkeit, Soll, Ist, Fehlbestand).
// Eigener Hauptreiter mit drei Segmenten: renderForecastView(el, ctx, { part: 'verlauf' | 'spots' | 'basis' }) – Verlauf (Lernstand, Zeitreihe, Trefferquote),
// Spots (Bewertung der bekannten Spots), Grundlagen & Kontrolle (alles, was genutzt, erzeugt oder vermutet wird, mit Selbstprüfungen und Rohdaten).
// ctx = { state, CFG, esc, fmt, getJson, muniName, setScope, setFilter, resetFilters, loadUsageIndex, loadEvents, loadCells, loadOnce };
// Leaflet (L) global. Daten: forecast/series.json, forecast/latest.json, forecast/log.json (Sammler, lib/pulse-forecast.js); Spots über lib/pulse-spots.js.
// Je Fahrzeugfamilie ein eigenes Modell (FC.FAMILY_DIR: forecast/, forecast/moped/, forecast/car/); die Familie folgt der Fahrzeugart-Auswahl
// oder dem Umschalter in der Kopfleiste.
// Werte aus Daten gehen durch ctx.esc; Texte im Wörterbuch web/i18n.js (Schlüssel fv.*).
import * as FC from './pulse-forecast.js?v=mwcm379k';
import * as CX from './pulse-context.js?v=mwcm379k';
import * as SP from './pulse-spots.js?v=mwcm379k';
import { decodeFleet, buildDemandModel, groupPlaces, DEFAULTS as OPS } from './pulse-ops.js?v=mwcm379k';
import { VEHICLE_TYPE_LABEL, familyOf } from './pulse-core.js?v=mwcm379k';
import { toCsv } from './pulse-report.js?v=mwcm379k';
import { dayType } from './pulse-econ.js?v=mwcm379k';
import { t, tMap, lang, dateFmt, numFmt, fcReason } from './i18n.js?v=mwcm379k';
import { weatherFor, weatherSvg, WX_CSS, resetWeatherCache } from './weather.js?v=mwcm379k';
import { mapKeys } from './mapkeys.js?v=mwcm379k';

const TZ = 'Europe/Berlin', DEMAND_DAYS = 7, SPOT_ROWS = 25;
const CACHE = new Map(), S = new WeakMap();
let LAST_RATED = null; // zuletzt bewertete Spots (Anzeige in „Grundlagen & Kontrolle“)
let FAM = 'micro'; // gewählte Fahrzeugfamilie der Prognose (alle drei Segmente)
const famNow = (ctx) => { const ty = ctx.state?.type; if (ty && ty !== 'all') FAM = familyOf(ty); return FAM; };
const famFile = (fam, f) => `${FC.FAMILY_DIR[fam] || FC.FAMILY_DIR.micro}/${f}.json`;
const st = (el) => { let s = S.get(el); if (!s) { s = { tok: 0, day: null, op: null, rows: SPOT_ROWS, map: null }; S.set(el, s); } return s; };
/** Zwischenspeicher leeren (neuer Sammler-Lauf) */
export function resetForecastCache() { CACHE.clear(); LAST_RATED = null; resetWeatherCache(); }
const memo = (key, fn) => { if (!CACHE.has(key)) CACHE.set(key, Promise.resolve().then(fn).then(v => { if (v == null) CACHE.delete(key); return v; }, () => { CACHE.delete(key); return null; })); return CACHE.get(key); };
const fj = (ctx, file) => { const at = ctx.state?.latest?.at || '', url = `${ctx.CFG.DATA}${file}${at ? `?t=${at}` : ''}`; return memo(url, async () => { const r = await ctx.getJson(url, { timeout: 60000 }); return r?.ok ? r.json : null; }); };

const CSS = `
.fv-root .fv-grid{display:grid;gap:var(--s4);grid-template-columns:minmax(0,1fr)}
.fv-lead{font-size:15px;line-height:1.5;max-width:80ch;margin:0 0 var(--s3)}
.fv-lead b{font-variant-numeric:tabular-nums}
.fv-ctl{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;margin:var(--s2) 0 var(--s3)}
.fv-ctl label{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--fg-2)}
.fv-tog{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:10px;background:var(--bg-2);border:1px solid var(--line)}
.fv-tog button{min-height:28px;border:0;background:transparent;color:var(--fg-2);padding:0 12px;border-radius:7px}
.fv-top .fv-fam{margin-right:var(--s2)}
.fv-tog button[aria-pressed="true"]{background:var(--thumb,var(--panel));color:var(--fg);box-shadow:inset 0 0 0 1px var(--line-2)}
.fv-scope{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--fg-2);padding:3px 10px;border:1px solid var(--line);border-radius:999px}
.fv-scope b{color:var(--fg);font-weight:600}
.fv-legend{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:12px;color:var(--fg-2);margin:0 0 var(--s2)}
.fv-legend i{display:inline-block;vertical-align:-2px;margin-right:6px}
.fv-legend .k-a{width:12px;height:12px;border-radius:2px;background:var(--accent)}
.fv-legend .k-l{width:12px;height:12px;border-radius:2px;background:color-mix(in srgb,var(--accent) 28%,transparent);border:1px dashed var(--accent)}
.fv-legend .k-p{width:18px;height:0;border-top:2.5px solid var(--info);margin-bottom:3px;vertical-align:middle}
.fv-legend .k-u{width:10px;height:10px;border:1px dashed color-mix(in srgb,var(--fg) 45%,transparent);box-sizing:border-box}.fv-gline{margin:var(--s2) 0 0;font-size:13px}.fv-gline a{font-weight:600;margin-left:4px}.fv-stale{margin:var(--s2) 0 0;font-size:12.5px}
.fv-legend .k-c{width:18px;height:0;border-top:2px dashed #14b8a6;margin-bottom:3px;vertical-align:middle}
.fv-legend .k-ev{width:12px;height:12px;border-radius:2px;background:color-mix(in srgb,var(--fg) 9%,transparent);border-top:3px solid var(--fg-2)}
.fv-chart .ev-band{fill:color-mix(in srgb,var(--fg) 7%,transparent)}.fv-chart .ev-bar{fill:var(--fg-2)}
.fv-chart text.ev-t{fill:var(--fg);font-size:10.5px;font-weight:600;paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round}
.fv-ev-sum{margin:0 0 var(--s3);font-size:13.5px;color:var(--fg-2)}.fv-ev-sum b{color:var(--fg)}
.fv-ev-cities{display:flex;flex-wrap:wrap;gap:var(--s1);margin:0 0 var(--s3)}
.fv-ev-h{margin:var(--s3) 0 var(--s1);font-size:13px;font-weight:600;color:var(--fg-2)}
.fv-eff{font-variant-numeric:tabular-nums;font-weight:600}.fv-eff.up{color:var(--ok)}.fv-eff.down{color:var(--bad)}
.fv-chart{width:100%;overflow:hidden}
.fv-chart svg{display:block;width:100%;height:auto;max-width:1100px}
.fv-chart text{fill:var(--fg-2);font-size:11px;font-family:var(--sans)}
.fv-chart .gl{stroke:var(--line);stroke-width:1}
.fv-chart .bar-a{fill:var(--accent)}.fv-chart .usual{fill:none;stroke:color-mix(in srgb,var(--fg) 45%,transparent);stroke-width:1;stroke-dasharray:2 2}.fv-chart text.pk{fill:var(--fg);font-size:10.5px;font-weight:600;paint-order:stroke;stroke:var(--panel);stroke-width:3px}
.fv-chart .bar-l{fill:color-mix(in srgb,var(--accent) 26%,transparent);stroke:var(--accent);stroke-width:1;stroke-dasharray:3 2}
.fv-chart .ln-p{fill:none;stroke:var(--info);stroke-width:2.2;stroke-linejoin:round}
.fv-chart .ln-c{fill:none;stroke:#14b8a6;stroke-width:2;stroke-dasharray:5 3;stroke-linejoin:round}
.fv-chart .now{stroke:var(--fg-2);stroke-width:1.2;stroke-dasharray:3 3}
.fv-chart .mid{stroke:var(--line-2);stroke-width:1}
.fv-chart .dayl{font-weight:600;fill:var(--fg)}
.fv-chart rect.hit{fill:transparent}.fv-chart rect.hit:hover{fill:color-mix(in srgb,var(--fg) 7%,transparent)}
.fv-wx{margin-top:2px}.fv-wx svg{max-height:110px}
${WX_CSS}
.fv-gates{list-style:none;margin:var(--s3) 0 0;padding:0;display:grid;gap:var(--s2);grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.fv-gates li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px var(--s3);align-items:center;padding:var(--s2) var(--s3);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel-2)}
.fv-gates .gl{font-size:12.5px;color:var(--fg-2)}.fv-gates .gv{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:600;text-align:right}
.fv-gates .gm{grid-column:1/-1;height:7px;border-radius:4px;background:var(--line);overflow:hidden}.fv-gates .gm span{display:block;height:100%;background:var(--warn);border-radius:4px}
.fv-gates li.ok .gm span{background:var(--ok)}
.fv-gates .gs{grid-column:1/-1;font-size:11.5px;color:var(--muted)}
.fv-st{display:inline-flex;align-items:flex-start;gap:8px;font-size:13.5px;font-weight:500}
.fv-st i{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;font:700 11px/1 var(--sans);font-style:normal;color:var(--panel);background:var(--muted);flex:none;margin-top:1px}
.fv-st.ok i{background:var(--ok)}.fv-st.near i{background:var(--warn)}.fv-st.none i{background:transparent;color:var(--fg-2);box-shadow:inset 0 0 0 1.5px var(--fg-2)}
.fv-bar{display:inline-block;height:9px;border-radius:3px;background:var(--accent);vertical-align:middle;min-width:2px}
.fv-bar.n{background:var(--muted);opacity:.7}
.fv-split{display:inline-block;width:72px;height:9px;border-radius:3px;background:color-mix(in srgb,var(--info) 35%,transparent);vertical-align:middle;overflow:hidden}
.fv-split i{display:block;height:100%;background:var(--accent)}
.fv-tbl td.bars{min-width:150px}.fv-tbl td.bars span.t{display:inline-block;min-width:3.6em;text-align:right;margin-right:6px;font-variant-numeric:tabular-nums}
.fv-chip{display:inline-flex;align-items:center;gap:4px;padding:0 8px;border-radius:999px;border:1px solid var(--line-2);font-size:11.5px;line-height:19px;white-space:nowrap}
.fv-chip.A{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 18%,transparent);font-weight:600}
.fv-chip.B{border-color:var(--accent)}
.fv-chip.D{color:var(--muted);border-style:dashed}
.fv-miss{font-weight:700;font-variant-numeric:tabular-nums}.fv-miss.z{font-weight:400;color:var(--muted)}
.fv-map{height:420px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-2);isolation:isolate;margin-top:var(--s3)}
.fv-keys{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:12px;color:var(--fg-2);margin-top:var(--s2)}
.fv-keys i{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.fv-link{all:unset;cursor:pointer;color:var(--fg);font-weight:500;text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:3px;border-radius:3px}
.fv-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fv-munis{display:flex;flex-wrap:wrap;gap:6px;margin-top:var(--s2)}
.fv-sub{font-size:13px;color:var(--fg-2);margin:var(--s2) 0 0;max-width:100ch}
details.fv-data{margin-top:var(--s3)}details.fv-data summary{cursor:pointer;font-size:12.5px;color:var(--fg-2)}
.fv-top{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin:0 0 var(--s4);padding:var(--s2) var(--s3);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel-2)}
.fv-top .lbl{font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-right:var(--s1)}
.fv-top .sp{flex:1 1 auto}.fv-top .hint{font-size:12px;color:var(--muted)}
.fv-pill{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 4px 0 11px;border:1px solid var(--line-2);border-radius:999px;font-size:12.5px;background:var(--panel);color:var(--fg-2)}
.fv-pill b{font-weight:600;color:var(--fg)}
.fv-pill.dim{padding-right:11px;border-style:dashed;color:var(--muted)}.fv-pill.dim b{font-weight:500;color:var(--fg-2)}
.fv-pill.ign b{text-decoration:line-through}
.fv-pill button{all:unset;cursor:pointer;width:22px;height:22px;border-radius:50%;display:inline-grid;place-items:center;color:var(--fg-2);font-size:15px;line-height:1}
.fv-pill button:hover{background:var(--line)}.fv-pill button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.fv-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:0 var(--s5);margin:var(--s3) 0 0}
.fv-kv>div{padding:var(--s2) 0;border-top:1px solid var(--line)}
.fv-kv dt{font-size:12px;color:var(--muted)}.fv-kv dd{margin:2px 0 0;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.fv-kv dd small{display:block;font-weight:400;font-size:12px;line-height:1.4;color:var(--fg-2);margin-top:2px}
.fv-checks{list-style:none;margin:var(--s3) 0 0;padding:0;display:grid;gap:var(--s2);grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))}
.fv-checks li{padding:var(--s2) var(--s3);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel-2)}
.fv-checks .why{display:block;font-size:12.5px;line-height:1.45;color:var(--fg-2);margin:3px 0 0 26px}
.fv-tag{display:inline-block;padding:0 8px;border-radius:999px;font-size:11.5px;line-height:19px;border:1px solid var(--line-2);white-space:nowrap;color:var(--fg)}
.fv-tag.measured{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 15%,transparent)}
.fv-tag.derived{border-color:var(--info);background:color-mix(in srgb,var(--info) 14%,transparent)}
.fv-tag.modelled{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}
.fv-tag.assumed{border-color:var(--warn);background:color-mix(in srgb,var(--warn) 18%,transparent);font-weight:600}
.fv-tag.rule,.fv-tag.external{color:var(--fg-2)}.fv-tag.external{border-style:dashed}
.fv-formula{display:block;white-space:pre-wrap;margin:var(--s3) 0 0;padding:var(--s3);background:var(--bg-2);border:1px solid var(--line);border-radius:var(--r-sm);font-family:var(--mono);font-size:12.5px;line-height:1.55;overflow-x:auto}
.fv-tbl.full{max-height:none}.fv-tbl td.wrap{white-space:normal;min-width:22ch}.fv-tbl td code{font-family:var(--mono);font-size:12px}
.fv-links{display:flex;flex-wrap:wrap;gap:var(--s2);margin-top:var(--s3)}
.fv-flag{color:var(--fg);font-weight:600}
.fv-list{margin:var(--s3) 0 0;padding-left:1.2em;display:grid;gap:var(--s1);max-width:100ch}
.fv-verdict{display:flex;gap:10px;align-items:flex-start;font-size:15.5px;line-height:1.5;max-width:95ch;margin:0}
.fv-verdict i{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;font:700 13px/1 var(--sans);font-style:normal;color:var(--panel);background:var(--muted);flex:none;margin-top:2px}
.fv-verdict.ok i{background:var(--ok)}.fv-verdict.near i{background:var(--warn)}.fv-verdict.bad i{background:var(--bad)}
.fv-verdict b{font-weight:600}
.fv-j{display:inline-block;padding:0 9px;border-radius:999px;font-size:12px;line-height:21px;font-weight:600;white-space:nowrap;border:1px solid var(--line-2);color:var(--fg-2)}
.fv-j.better{color:var(--ok);border-color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.fv-j.worse{color:var(--bad);border-color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent)}
.fv-tbl td .lv{display:block;font-weight:500;color:var(--fg)}.fv-tbl td .lvs{display:block;font-size:11.5px;line-height:1.35;color:var(--muted);white-space:normal}
.fv-dl{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin-top:var(--s3);font-size:12.5px;color:var(--fg-2)}
.fv-curve svg{display:block;width:100%;height:auto;max-width:1100px}
.fv-curve text{fill:var(--fg-2);font-size:11px;font-family:var(--sans)}
.fv-curve .gl{stroke:var(--line);stroke-width:1}
.fv-curve path{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.fv-curve path.act{stroke-width:3.4}.fv-curve path.nv{stroke-dasharray:5 4}
.fv-keys2{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:12px;color:var(--fg-2);margin:var(--s3) 0 var(--s2)}
.fv-keys2 i{display:inline-block;width:18px;height:0;border-top:3px solid;margin-right:6px;vertical-align:middle}.fv-keys2 i.nv{border-top-style:dashed}
.fv-keys2 b{font-weight:600;color:var(--fg)}
.fv-tbl .m-only{display:none}
.fv-tbl .v2+.v2::before{content:' · '}
@media (max-width:640px){.fv-tbl .v2{display:block}.fv-tbl .v2+.v2::before{content:''}.fv-tbl .mh{display:none}.fv-tbl .m-only{display:block;margin-top:5px}.fv-tbl td.bars .fv-bar{display:none}.fv-tbl td.bars{min-width:0}.fv-tbl td.bars span.t{min-width:0;margin:0}.fv-verdict{font-size:14.5px}}
`;
let cssDone = false;
const css = () => { if (cssDone || typeof document === 'undefined') return; cssDone = true; const s = document.createElement('style'); s.id = 'fv-style'; s.textContent = CSS; document.head.appendChild(s); };

const n0 = (x) => (x == null || !Number.isFinite(x) ? '–' : numFmt(0).format(x));
const n1 = (x) => (x == null || !Number.isFinite(x) ? '–' : numFmt(1).format(x));
const pc = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${numFmt(d).format(x * 100)} %`);
const sg = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${numFmt(d).format(Math.abs(x) * 100)} %`);
const fK = (v) => (v >= 10000 ? `${n0(v / 1000)}k` : v >= 1000 ? `${numFmt(v % 1000 === 0 ? 0 : 1).format(v / 1000)}k` : n0(v));
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const dayTxt = (d, o = { weekday: 'short', day: 'numeric', month: 'short' }) => dateFmt({ ...o, timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const berlinNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, h: +p.hour }; };

// ---------- Gebiet → Reihen ----------
/** Gebietsschlüssel für die Filter der Leiste (Gebiet, Anbieter, Art) und Hinweise, was davon nicht abbildbar war */
export function pickScope(series, st) {
  const days = Object.values(series?.days || {}), keys = new Set(days.flatMap(d => Object.keys(d)));
  const { scope: ags = 'DE', operator: op = 'all', type: ty = 'all' } = st || {};
  const any = (re) => [...keys].filter(k => re.test(k));
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (ags !== 'DE') {
    if (op !== 'all' || ty !== 'all') {
      const g = any(new RegExp(`^g:${esc(ags)}\\|${op === 'all' ? '[^|]*' : esc(op)}\\|${ty === 'all' ? '.*' : esc(ty)}$`));
      if (g.length) return { keys: g, ags, op, ty, partial: true };
    }
    if (keys.has(`ags:${ags}`)) return { keys: [`ags:${ags}`], ags, op: 'all', ty: 'all', partial: false, ignored: op !== 'all' || ty !== 'all' };
    return { keys: [], ags, op, ty };
  }
  if (op !== 'all' && ty !== 'all') { const g = any(new RegExp(`^g:[^|]*\\|${esc(op)}\\|${esc(ty)}$`)); if (g.length) return { keys: g, ags, op, ty, partial: true }; }
  if (op !== 'all') return keys.has(`op:${op}`) ? { keys: [`op:${op}`], ags, op, ty: 'all', ignored: ty !== 'all' } : { keys: [], ags, op, ty };
  if (ty !== 'all') return keys.has(`ty:${ty}`) ? { keys: [`ty:${ty}`], ags, op: 'all', ty } : { keys: [], ags, op, ty };
  return { keys: ['DE'], ags, op: 'all', ty: 'all' };
}
/** Reihen eines Tags: Summe über die gewählten Schlüssel (null bleibt null, wenn kein Schlüssel einen Wert hat) */
export function seriesOf(series, day, sel) {
  const out = { p: null, a: null, l: null, c: null }, d = series?.days?.[day] || {};
  for (const f of ['p', 'a', 'l', 'c']) for (const k of sel.keys) { const x = d[k]?.[f]; if (!x) continue; out[f] ||= new Array(24).fill(null); x.forEach((v, h) => { if (v != null) out[f][h] = (out[f][h] || 0) + v; }); }
  return out;
}
/** Kennzahlen eines Tags: Ist gegen Plan über die Stunden mit beiden Werten (Abweichung je Stunde = Σ|Ist − Plan| ÷ Σ Ist, Verzerrung = Σ Plan ÷ Σ Ist − 1) und gegen den naiven Vortag */
export function dayStats(e, prevA = null) {
  if (!e?.p || !e?.a) return null;
  let y = 0, ab = 0, pp = 0, n = 0, yn = 0, abn = 0;
  e.a.forEach((a, h) => { const p = e.p[h]; if (a == null || p == null) return; y += a; ab += Math.abs(a - p); pp += p; n++; if (prevA?.[h] != null) { yn += a; abn += Math.abs(a - prevA[h]); } });
  return n && y > 0 ? { n, ist: y, plan: pp, wape: ab / y, bias: pp / y - 1, naive: yn > 0 ? abn / yn : null, skill: yn > 0 && abn > 0 ? 1 - (ab / y) / (abn / yn) : null } : null;
}

// ---------- Diagramm ----------
// Obergrenze mit glatten Viertel-Marken (0/50/100/150/200 statt 63/125/188/250, Audit UXP-08)
const niceMax = (v) => { const e = 10 ** Math.floor(Math.log10(Math.max(v, 1))), m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 4 ? 4 : m <= 6 ? 6 : m <= 8 ? 8 : 10) * e; };
function timeline(ctx, rows, { nowIdx = null, width = 720, blocks = [], peaks = [] } = {}) {
  const W = Math.max(320, Math.min(1100, Math.round(width))), H = 260, pl = 40, pr = 8, pt = 18, pb = 38, N = rows.length, bw = (W - pl - pr) / N, gap = bw > 9 ? 1.5 : 0.7;
  const vals = rows.flatMap(r => [r.p, r.a, r.l, r.c, r.u?.[1]]).filter(Number.isFinite), top = niceMax(Math.max(1, ...vals) * 1.05), y = (v) => pt + (H - pt - pb) * (1 - v / top), x = (i) => pl + i * bw, every = W < 520 ? 6 : 3;
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y(top * f).toFixed(1)}" y2="${y(top * f).toFixed(1)}"/><text x="${pl - 5}" y="${(y(top * f) + 4).toFixed(1)}" text-anchor="end">${fK(top * f)}</text>`).join('');
  const bars = rows.map((r, i) => {
    const v = r.a ?? r.l; if (v == null) return '';
    const cls = r.a != null ? 'bar-a' : 'bar-l', h = Math.max(1, y(0) - y(v));
    return `<rect class="${cls}" x="${(x(i) + gap).toFixed(1)}" y="${(y(0) - h).toFixed(1)}" width="${Math.max(1.5, bw - 2 * gap).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"/>`;
  }).join('');
  // üblicher Bereich: Min–Max der gezählten Werte derselben Stunde an den letzten gleichen Tagen (hinter den Balken)
  const usual = rows.map((r, i) => (r.u ? `<rect class="usual" x="${x(i).toFixed(1)}" y="${y(r.u[1]).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y(r.u[0]) - y(r.u[1])).toFixed(1)}"/>` : '')).join('');
  const peakTxt = peaks.map(i => { const r = rows[i], v = r?.a ?? r?.l ?? r?.p; return v == null ? '' : `<text class="pk" x="${(x(i) + bw / 2).toFixed(1)}" y="${(y(v) - 4).toFixed(1)}" text-anchor="middle">${fK(v)}</text>`; }).join('');
  let d = '', open = false;
  rows.forEach((r, i) => { if (r.p == null) { open = false; return; } d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(r.p).toFixed(1)}L${x(i + 1).toFixed(1)} ${y(r.p).toFixed(1)}`; open = true; });
  // Chronos-2 (KI, nur Vergleich): gestrichelte Linie durch die Stundenmitten
  let dc = '', openC = false;
  rows.forEach((r, i) => { if (r.c == null) { openC = false; return; } dc += `${openC ? 'L' : 'M'}${(x(i) + bw / 2).toFixed(1)} ${y(r.c).toFixed(1)}`; openC = true; });
  const labels = rows.map((r, i) => (r.h % every === 0 ? `<text x="${(x(i) + bw / 2).toFixed(1)}" y="${H - pb + 14}" text-anchor="middle">${r.h}</text>` : '')).join('');
  const hit = rows.map((r, i) => `<rect class="hit" x="${x(i).toFixed(1)}" y="${pt}" width="${bw.toFixed(1)}" height="${H - pt - pb}"><title>${ctx.esc(`${String(r.h).padStart(2, '0')}:00 · ${r.a != null ? `${t('fv.ist')} ${n0(r.a)}` : r.l != null ? `${t('fv.live')} ${n0(r.l)}` : t('fv.notObserved')}${r.p != null ? ` · ${t('fv.plan')} ${n0(r.p)}` : ''}${r.c != null ? ` · ${t('fv.chronos')} ${n0(r.c)}` : ''}${r.u ? ` · ${t('fv.usual')} ${n0(r.u[0])}–${n0(r.u[1])}` : ''}`)}</title></rect>`).join('');
  const sepAndDays = blocks.map((b, k) => `${k ? `<line class="mid" x1="${x(b.from).toFixed(1)}" x2="${x(b.from).toFixed(1)}" y1="${pt}" y2="${H - pb}"/>` : ''}<text class="dayl" x="${(x(b.from) + (b.to - b.from) * bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${ctx.esc(b.label)}</text>`).join('');
  const now = nowIdx != null ? `<line class="now" x1="${x(nowIdx).toFixed(1)}" x2="${x(nowIdx).toFixed(1)}" y1="${pt - 6}" y2="${H - pb}"/><text x="${(x(nowIdx) + 4).toFixed(1)}" y="${pt - 6}">${ctx.esc(t('fv.now'))}</text>` : '';
  const total = sum(rows.map(r => r.a ?? r.l ?? 0));
  return `<div class="fv-chart"><svg viewBox="0 0 ${W} ${H}" data-pl="${pl}" data-bw="${bw}" data-pt="${pt}" data-ph="${H - pt - pb}" role="img" aria-label="${ctx.esc(t('fv.chartAria', { total: n0(total) }))}">${grid}${usual}${bars}${peakTxt}<path class="ln-p" d="${d}"/>${dc ? `<path class="ln-c" d="${dc}"/>` : ''}${now}${sepAndDays}${labels}${hit}</svg></div>`;
}

// ---------- Daten für die Spots ----------
const loadFleet = (ctx, land) => memo(`ops/${land}`, async () => { const r = await ctx.getJson(`${ctx.CFG.DATA}ops/${land}.json`, { timeout: 90000 }); return r?.ok && r.json ? decodeFleet(r.json) : null; });
const loadDemand = (ctx, land, ags) => memo(`cells/${land}/${ags}`, async () => {
  const idx = await ctx.loadUsageIndex(); const days = (idx?.cellDays || []).slice(-DEMAND_DAYS); if (!days.length) return { model: null };
  const docs = (await Promise.all(days.map(d => ctx.loadCells(d, land)))).filter(Boolean), model = docs.length ? buildDemandModel(docs, ags, 'day') : null;
  return { model: model?.hours > 0 ? model : null };
});
const loadGroups = (ctx) => memo('groups', async () => {
  const idx = await ctx.getJson(`${ctx.CFG.DATA}groups/index.json`, { timeout: 30000 });
  if (idx?.ok && Array.isArray(idx.json?.months)) { const docs = (await Promise.all(idx.json.months.map(async m => { const r = await ctx.getJson(`${ctx.CFG.DATA}groups/${m}.json`, { timeout: 60000 }); return r?.ok && Array.isArray(r.json?.events) ? r.json : null; }))).filter(Boolean); return { docs }; }
  const r = await ctx.getJson(`${ctx.CFG.DATA}groups.json`, { timeout: 60000 }); return { docs: r?.ok && Array.isArray(r.json?.events) ? [r.json] : [] };
});

// ---------- Teile der Ansicht ----------
const tile = (l, v, s, cls = '') => `<div class="tile ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const head = (title, sub, right = '') => `<div class="panel-head"><div><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right}</div>`;
const badge = (cls, ico, txt) => `<span class="fv-st ${cls}"><i aria-hidden="true">${ico}</i>${txt}</span>`;

function learnPanel(ctx, L, G) {
  const gates = L.gates || {}, wg = L.weather?.gate || {}, minT = gates.minTrainDays ?? 2, minE = gates.minEvalDays ?? 3, wk = gates.wxTempRangeK ?? 5, wd = gates.wxRainDays ?? 2;
  const row = (label, have, need, unit, sub) => { const ok = have >= need; return `<li class="${ok ? 'ok' : ''}"><span class="gl">${label}</span><span class="gv">${unit === 'K' ? n1(have) : n0(have)} / ${n0(need)}${unit ? ` ${unit}` : ''} ${ok ? '✓' : ''}</span><span class="gm"><span style="width:${Math.min(100, Math.round(have / need * 100))}%"></span></span>${sub ? `<span class="gs">${sub}</span>` : ''}</li>`; };
  const status = L.status === 'active' ? badge('ok', '✓', ctx.esc(t('fv.stActive', { model: t(`fc.model.${L.active}`) })))
    : L.status === 'learning' ? badge('near', '!', ctx.esc(t('fv.stLearning', { n: L.evalDays || 0, min: minE }))) : badge('none', '–', ctx.esc(t('fv.stInsufficient', { n: L.trainDays || 0, min: minT })));
  const need = Math.max(0, minE - (L.evalDays || 0)), until = L.status === 'learning' && need > 0 && L.generatedAt ? dayTxt(addDays(L.generatedAt.slice(0, 10), need), { day: 'numeric', month: 'long' }) : null;
  const wxOn = L.weather?.used;
  return `<div class="panel">${head(t('fv.learnTitle'), t('fv.learnSub'), allTag(ctx))}<p style="margin:0">${status}</p>${until ? `<p class="fv-sub">${t('fv.activeFrom', { date: ctx.esc(until) })}</p>` : ''}`
    + `<ul class="fv-gates">${row(t('fv.gTrain'), L.trainDays || 0, minT, '', t('fv.gTrainSub'))}${row(t('fv.gEval'), L.evalDays || 0, minE, '', t('fv.gEvalSub'))}${row(t('fv.gTemp'), wg.tempRangeK || 0, wk, 'K', t('fv.gTempSub'))}${row(t('fv.gRain'), Math.min(wg.rainDays || 0, wg.dryDays || 0), wd, '', `${t('fv.gRainSub', { rain: wg.rainDays || 0, dry: wg.dryDays || 0 })}`)}</ul>`
    + `<p class="fv-sub">${wxOn ? t('fv.wxOn') : t('fv.wxOff')}</p></div>`;
}

/** Tage mit Plan und Ist (abgeschlossene Tage; mit withToday auch der laufende) für die gewählten Reihen */
function accRows(S0, sel, G, { withToday = false } = {}) {
  const days = Object.keys(S0.days).filter(d => (withToday ? d <= S0.today : d < S0.today)).sort().slice(-7), rows = [];
  for (const d of days) { const e = seriesOf(S0, d, sel), prev = seriesOf(S0, addDays(d, -1), sel), s = dayStats(e, prev.a), c = e.c ? dayStats({ p: e.c, a: e.a }) : null; if (s) rows.push({ d, ...s, chronos: c?.wape ?? null, train: G?.evals?.[d]?.trainDays ?? null }); }
  return rows;
}
/** Mittlere Kennzahlen je Modell über die letzten ausgewerteten Tage (Selbstprüfung aus log.json); sc = Wertung (Tag und Stunde je Gruppe), nach der gewählt wird */
// 80-%-Band als Häufigkeit (Laien lesen Intervalle als harte Grenzen): Soll „etwa 8 von 10“, dazu die letzte bewertete Trefferquote
const bandFreq = (live) => { const x = (live || []).find(r => Number.isFinite(r?.cover80)); return x ? ` ${t('fv.bandFreq', { k: Math.round(x.cover80 * 10) })}` : ''; };
const MODEL_ORDER = ['hybrid', 'blend', 'adaptive', 'pooled', 'pooledWx', 'profile', 'chronos', 'naive', 'week'];
const MODEL_COLOR = { week: 'var(--muted)', chronos: '#14b8a6', blend: '#f59e0b', hybrid: '#8b5cf6', adaptive: 'var(--accent)', pooled: 'var(--info)', pooledWx: 'var(--ok)', profile: 'var(--warn)', naive: 'var(--muted)' };
const modelName = (m) => (m === 'naive' ? t('fv.naive') : m === 'week' ? t('fv.week') : t(`fc.model.${m}`));
// Mischung Chronos/Hybrid: Stichtag und was bisher gelernt ist (latest.blend)
const blendTxt = (L) => { const b = L?.blend, x = b?.learn, from = b?.activeFrom ? dayTxt(b.activeFrom.slice(0, 10), { day: 'numeric', month: 'long', year: 'numeric' }) : '–';
  return `${t('fv.mBlend', { from })}${x ? ` ${t('fv.blendShare', { pct: pc(x.ownShare), days: n1(x.days), n: n0(x.judged) })}` : ''}`; };
const mature = (G, d) => !(G?.evals?.[d]?.trainDays < (FC.GATES.minEvalTrainDays ?? 0)); // wie chooseModel: unreife Starttage zählen nicht
function raceOf(G, L) {
  const ev = G?.evals || {}, evDays = Object.keys(ev).sort().filter(d => mature(G, d)).slice(-(L?.gates?.evalWindow ?? FC.GATES.evalWindow));
  const avg = (m, f) => { const v = evDays.map(d => f(ev[d]?.models?.[m])).filter(x => x != null); return v.length ? { v: sum(v) / v.length, n: v.length } : null; };
  return MODEL_ORDER.map(m => ({ m, sc: avg(m, FC.scoreOf), gd: avg(m, x => x?.wapeGD), gh: avg(m, x => x?.wapeGH), bias: avg(m, x => x?.bias), cov: avg(m, x => x?.cover80) })).filter(r => r.sc);
}
/** Welche Prognose wird veröffentlicht? Live-Rennen aller Kandidaten (Schattenprognosen) und Selbstprüfung, je relativ zu „wie gestern“ */
function decisionHtml(ctx, L, G) {
  const D = L?.decision, rule = D?.rule || FC.DECIDE, f2 = (x) => (x == null ? '–' : `×${numFmt(2).format(x)}`);
  const recs = Object.values(G?.live || {}).filter(x => x?.v >= 2 && x.models?.naive?.w > 0);
  const evals = G?.evals || {}, days = Object.keys(evals).sort().filter(d => !(evals[d]?.trainDays < FC.GATES.minEvalTrainDays)).slice(-FC.GATES.evalWindow);
  const selfRel = (m) => { const v = days.map(d => { const a = FC.scoreOf(evals[d]?.models?.[m]), b = FC.scoreOf(evals[d]?.models?.naive); return a != null && b > 0 ? a / b : null; }).filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
  const pkOf = (m) => { const v = recs.map(x => x.models?.[m]?.peak?.hit1).filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
  const t3Of = (m) => { const v = recs.map(x => x.models?.[m]?.peak?.top3).filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
  const ms = [...MODEL_ORDER.filter(m => m !== 'naive'), 'naive', 'week'].filter(m => D?.live?.[m] || selfRel(m) != null || D?.combined?.[m]);
  if (!ms.length) return `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.decTitle')}</h3><p class="fv-sub">${t('fv.decRule', { min: rule.liveMin, k: rule.liveK, hl: rule.halfLifeDays, gain: pc(rule.switchGain), base: rule.baseMin })}</p>`;
  const rows = ms.map(m => { const lv = D?.live?.[m], c = D?.combined?.[m], sr = m === 'naive' ? 1 : selfRel(m);
    return `<tr><td>${ctx.esc(m === 'week' ? t('fv.week') : modelName(m))}${m === L?.active ? ` <span class="fv-chip B">${t('fv.activeTag')}</span>` : ''}</td><td class="n">${f2(c?.r ?? (D?.combined ? null : sr))}</td><td class="n">${f2(lv?.r ?? null)}</td><td class="n mh">${lv ? n0(lv.n) : '–'}</td><td class="n mh">${f2(sr)}</td><td class="n mh">${c ? pc(c.w) : '–'}</td><td class="n mh">${pkOf(m) == null ? '–' : pc(pkOf(m))}</td><td class="n mh">${t3Of(m) == null ? '–' : pc(t3Of(m))}</td></tr>`; }).join('');
  return `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.decTitle')}</h3><div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.decTitle'))}"><table><thead><tr><th>${t('fv.colModel')}</th><th class="n">${t('fv.decColAll')}</th><th class="n">${t('fv.decColLive')}</th><th class="n mh">${t('fv.decColN')}</th><th class="n mh">${t('fv.decColSelf')}</th><th class="n mh">${t('fv.decColW')}</th><th class="n mh">${t('fv.colPeak1')}</th><th class="n mh">${t('fv.colTop3')}</th></tr></thead><tbody>${rows}</tbody></table></div><div class="fv-sub">${t('fv.decRule', { min: rule.liveMin, k: rule.liveK, hl: rule.halfLifeDays, gain: pc(rule.switchGain), base: rule.baseMin })}</div>${L?.reason || L?.decision?.why ? `<div class="fv-sub">${t('fv.reasonNow')} <i>${ctx.esc(fcReason(L))}</i></div>` : ''}`;
}
function accuracyPanel(ctx, S0, sel, G, L) {
  const rows = accRows(S0, sel, G);
  const maxW = Math.max(0.01, ...rows.map(r => Math.max(r.wape, r.naive ?? 0)));
  const body = rows.length ? rows.slice().reverse().map(r => `<tr><td>${ctx.esc(dayTxt(r.d))}</td><td class="n mh">${n0(r.ist)}</td><td class="n mh">${n0(r.plan)}</td><td class="n mh">${sg(r.bias, 1)}</td>`
    + `<td class="n bars"><span class="t">${pc(r.wape)}</span><span class="fv-bar" style="width:${Math.round(r.wape / maxW * 110)}px"></span></td><td class="n bars"><span class="t">${pc(r.naive)}</span>${r.naive == null ? '' : `<span class="fv-bar n" style="width:${Math.round(r.naive / maxW * 110)}px"></span>`}</td><td class="n mh">${r.chronos == null ? '–' : pc(r.chronos)}</td><td class="n mh">${r.skill == null ? '–' : sg(r.skill)}</td><td class="n mh">${r.train == null ? '–' : n0(r.train)}</td></tr>`).join('') : '';
  const table = rows.length ? `<div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.accTitle'))}"><table><thead><tr><th>${t('fv.colDay')}</th><th class="n mh">${t('fv.colIst')}</th><th class="n mh">${t('fv.colPlan')}</th><th class="n mh">${t('fv.colBias')}</th><th class="n">${t('fv.colErr')}</th><th class="n">${t('fv.colNaive')}</th><th class="n mh" title="${ctx.esc(t('fv.colChronosTip'))}">${t('fv.chronos')}</th><th class="n mh">${t('fv.colSkill')}</th><th class="n mh">${t('fv.colTrain')}</th></tr></thead><tbody>${body}</tbody></table></div>`
    : `<div class="empty"><b>${t('fv.accNone')}</b>${t('fv.accNoneHint')}</div>`;
  const live = (L?.live || []).slice(-6).reverse(), pk1 = (x) => (x?.peak?.hit1 == null ? '–' : pc(x.peak.hit1)), mdl = (x) => (x.model ? ctx.esc(modelName(x.model)) : '–');
  const liveHtml = live.length ? `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.liveTitle')}</h3><div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.liveTitle'))}"><table><thead><tr><th>${t('fv.colIssued')}</th><th class="mh">${t('fv.colModel')}</th><th class="n">${t('fv.colErrOp')}</th><th class="n">${t('fv.colNaive')}</th><th class="n mh">${t('fv.colWeek')}</th><th class="n mh">${t('fv.colPeak1')}</th><th class="n mh">${t('fv.colBand')}</th><th class="n mh">${t('fv.colHours')}</th></tr></thead><tbody>${live.map(x => `<tr><td>${ctx.esc(dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(x.at)))}</td><td class="mh">${mdl(x)}</td><td class="n">${pc(x.v >= 2 ? x.wapeOpHn : x.wapeOpH)}</td><td class="n">${pc(x.naiveOpH)}</td><td class="n mh">${pc(x.weekOpH)}</td><td class="n mh">${pk1(x)}</td><td class="n mh">${pc(x.cover80)}</td><td class="n mh">${x.hours == null ? '24' : n0(x.hours)}</td></tr>`).join('')}</tbody></table></div><div class="fv-sub">${t('fv.liveNote', { min: FC.GATES.liveMinHours })}${bandFreq(live)}</div>` : '';
  return `<div class="panel">${head(t('fv.accTitle'), t('fv.accSub'))}${table}<div class="fv-sub">${t('fv.accNote')}</div>${liveHtml}${decisionHtml(ctx, L, G)}</div>`;
}

// ---------- Gewähltes Gebiet bzw. Anbieter (11.11.2026): je Gruppe Erwartung, Trefferbilanz und woraus die Prognose lernt ----------
// Grundlage: latest.groups (nächste 24 h), log.feedback (Selbstprüfung je Gruppe, ältere Tage verblassen: Starts, |Fehler| eigenes Profil bzw.
// gepooltes Modell), series.json (Plan gegen Ist nur für Gruppen mit eigener Stundenreihe). Modell und Lernstand gelten für alle Gruppen gemeinsam.
const XP = { much: 300, enough: 30 }; // Fahrtbeginne in der Selbstprüfung: viel eigene Erfahrung / genug für ein eigenes Urteil
const allTag = (ctx) => { const st = ctx.state || {}; return (st.scope && st.scope !== 'DE') || (st.operator && st.operator !== 'all') ? `<span class="fv-chip D" title="${ctx.esc(t('fv.scAllTagTip'))}">${t('fv.scAllTag')}</span>` : ''; };
export function scopeGroups(st, S0, G, L, { maxDE = 25 } = {}) {
  const ags = st?.scope || 'DE', op = st?.operator || 'all', ty = st?.type || 'all';
  if (ags === 'DE' && op === 'all') return null;
  const fb = G?.feedback?.groups || {}, keys = new Set([...Object.keys(L?.groups || {}), ...Object.keys(fb)]);
  const fit = (k) => { const [a, o, y] = k.split('|'); return (ags === 'DE' || a === ags) && (op === 'all' || o === op) && (ty === 'all' || y === ty); };
  const fbw = FC.feedbackWeights(G?.feedback), mean = (a) => (a.length ? sum(a) / a.length : null);
  const rows = [...keys].filter(fit).map(k => {
    const s = fb[k], g = L?.groups?.[k], y = s ? s[0] : 0;
    const ser = S0 ? accRows(S0, { keys: [`g:${k}`] }, G).filter(r => r.naive != null) : [];
    return { k, exp: g ? sum(g.start) : null, perVeh: g?.perVeh ?? null, y, eP: y > 0 ? s[3] / y : null, eQ: y > 0 ? s[4] / y : null, w: s ? fbw.of(k).w : null,
      plan: ser.length ? { a: mean(ser.map(r => r.wape)), b: mean(ser.map(r => r.naive)), n: ser.length } : null };
  }).sort((a, b) => (b.exp ?? -1) - (a.exp ?? -1) || b.y - a.y);
  return { ags, op, ty, rows: ags === 'DE' ? rows.slice(0, maxDE) : rows, more: ags === 'DE' ? Math.max(0, rows.length - maxDE) : 0, w0: fbw.w0 };
}
const xpChip = (y) => (y >= XP.much ? `<span class="fv-chip A">${t('fv.scXpMuch')}</span>` : y >= XP.enough ? `<span class="fv-chip B">${t('fv.scXpOk')}</span>` : `<span class="fv-chip D">${t('fv.scXpLow')}</span>`);
const splitBar = (w) => `<span class="fv-split" role="img" aria-label="${t('fv.scSplitAria', { own: pc(w), all: pc(1 - w) })}"><i style="width:${Math.round(w * 100)}%"></i></span>`;
function activeHow(L) {
  const m = L?.active, name = m ? modelName(m) : '–';
  const k = m === 'hybrid' ? 'fv.scHowHybrid' : m === 'adaptive' ? 'fv.scHowAdaptive' : m === 'profile' ? 'fv.scHowProfile' : m === 'blend' ? 'fv.scHowBlend' : m ? 'fv.scHowPooled' : 'fv.scHowNone';
  return t(k, { model: name, k: FC.HYBRID?.k ?? 20 });
}
function scopePanel(ctx, S0, sel, G, L) {
  const R = scopeGroups(ctx.state, S0, G, L); if (!R) return '';
  const esc = ctx.esc, tl = tMap('type', VEHICLE_TYPE_LABEL), city = R.ags !== 'DE' ? (ctx.muniName?.(R.ags) || R.ags) : null;
  const title = city ? (R.op !== 'all' ? t('fv.scTitleCityOp', { city: esc(city), op: esc(R.op) }) : t('fv.scTitleCity', { city: esc(city) })) : t('fv.scTitleOp', { op: esc(R.op) });
  if (!R.rows.length) return `<div class="panel" id="fv-scope">${head(title, t('fv.scSub'))}<div class="empty"><b>${t('fv.scNone')}</b>${t('fv.scNoneHint')}</div></div>`;
  const judged = R.rows.filter(r => r.y >= XP.enough), own = judged.filter(r => r.w >= 0.6).length, pool = judged.filter(r => r.w <= 0.4).length;
  // Plan gegen Ist für die Auswahl als Ganzes (Stundenreihe des Gebiets bzw. Anbieters, sofern gespeichert)
  const sr = accRows(S0, sel, G).filter(r => r.naive != null), mean = (a) => (a.length ? sum(a) / a.length : null);
  const area = sr.length ? { a: mean(sr.map(r => r.wape)), b: mean(sr.map(r => r.naive)), n: sr.length } : null;
  const parts = [[own, 'fv.scPartOwn'], [pool, 'fv.scPartPool'], [judged.length - own - pool, 'fv.scPartMix']].filter(([c]) => c > 0).map(([c, k]) => t(k, { n: n0(c) }));
  const lead = (R.rows.length === 1 ? t('fv.scLead1', { xp: t(judged.length ? 'fv.scLead1Ok' : 'fv.scLead1Low') }) : t('fv.scLead', { n: n0(R.rows.length), x: n0(judged.length) }))
    + (parts.length ? ' ' + t('fv.scLearnLead', { parts: parts.join(', ') }) : '') + ' ' + (area ? t('fv.scArea', { s: esc(((x) => x.charAt(0).toUpperCase() + x.slice(1))(String(scopeLabel(ctx, sel)))), a: pc(area.a), b: pc(area.b), n: area.n, v: t(judge(area.a, area.b) === 'better' ? 'fv.gBetter' : judge(area.a, area.b) === 'worse' ? 'fv.gWorse' : 'fv.gEqual') }) : t('fv.scAreaNone'));
  const label = (k) => { const [a, o, y] = k.split('|'); return city ? `${esc(o)} · ${esc(tl[y] || y)}` : `${esc(ctx.muniName?.(a) || a)} · ${esc(tl[y] || y)}`; };
  // Gruppen ohne eigene Prognose und mit kaum gezählten Fahrten: eine Zeile statt Tabellenzeilen voller Striche
  const quiet = R.rows.filter(r => r.exp == null && r.y < XP.enough), shown = R.rows.filter(r => !quiet.includes(r));
  const better = (r) => (r.eP == null || r.eQ == null || r.y < XP.enough ? '' : ` ${jChipTxt(Math.abs(r.eP - r.eQ) <= 0.05 * r.eQ ? 'eq' : r.eP < r.eQ ? 'own' : 'all')}`);
  const rows = shown.map(r => `<tr><td class="wrap">${label(r.k)}</td>`
    + `<td class="n">${r.exp == null ? '–' : n0(r.exp)}${r.perVeh != null ? `<div class="sub-line">${t('fv.scPerVeh', { v: n1(r.perVeh) })}</div>` : ''}</td>`
    + `<td class="n mh">${n0(r.y)}<div class="sub-line">${xpChip(r.y)}</div></td>`
    + `<td class="n mh">${r.y >= XP.enough ? `${pc(r.eP)} · ${pc(r.eQ)}${better(r)}` : '–'}</td>`
    + `<td>${r.w == null ? `<span class="muted">${t('fv.scLearnAll', { w: pc(R.w0) })}</span>` : `${splitBar(r.w)} <span class="fv-sub" style="display:inline">${t('fv.scOwnPct', { w: pc(r.w) })}</span>${r.y < XP.enough ? `<div class="sub-line">${t('fv.scLearnShrunk')}</div>` : ''}`}</td>`
    + `<td class="n">${r.plan ? `${pc(r.plan.a)} · ${pc(r.plan.b)} ${jChip(judge(r.plan.a, r.plan.b))}` : '<span class="muted">–</span>'}</td></tr>`).join('');
  const tbl = `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(title)}"><table><thead><tr><th>${city ? t('fv.scColGroup') : t('fv.scColGroupCity')}</th><th class="n">${t('fv.scColExp')}</th><th class="n mh">${t('fv.scColXp')}</th><th class="n mh">${t('fv.scColHit')}</th><th>${t('fv.scColLearn')}</th><th class="n">${t('fv.scColPlan')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const quietHtml = quiet.length ? `<div class="fv-sub">${t('fv.scQuiet', { n: n0(quiet.length), ok: XP.enough, list: quiet.map(r => label(r.k)).join(', ') })}</div>` : '';
  return `<div class="panel" id="fv-scope">${head(title, t('fv.scSub'))}<p class="fv-lead" style="margin-top:var(--s2)">${lead}</p>${shown.length ? tbl : ''}${quietHtml}`
    + `${R.more ? `<div class="fv-sub">${t('fv.scMore', { n: n0(R.more) })}</div>` : ''}<div class="fv-sub">${esc(activeHow(L))}</div><div class="fv-sub">${t('fv.scHowCols', { much: XP.much, ok: XP.enough })}</div></div>`;
}
const jChipTxt = (k) => `<span class="fv-chip${k === 'own' ? ' A' : k === 'all' ? ' B' : ' D'}">${t(`fv.scBetter.${k}`)}</span>`;

// ---------- Zeugnis: wie gut ist die Prognose, besser als „wie gestern“? ----------
const judge = (a, b) => (a == null || b == null ? null : Math.abs(a - b) <= 0.05 * b ? 'eq' : a < b ? 'better' : 'worse');
/** Drei Ebenen: gewähltes Gebiet je Stunde (Plan gegen Ist), Gruppen je Stunde und je Tag (Selbstprüfung des aktiven Modells) – jeweils gegen „wie gestern“ */
export function gradeOf(S0, sel, G, L) {
  const mean = (a) => (a.length ? sum(a) / a.length : null), rows = S0 ? accRows(S0, sel, G).filter(r => r.naive != null) : [];
  const scope = rows.length ? { a: mean(rows.map(r => r.wape)), b: mean(rows.map(r => r.naive)), n: rows.length, bias: mean(rows.map(r => r.bias)) } : null;
  const ev = G?.evals || {}, act = L?.active || 'pooled', win = L?.gates?.evalWindow ?? FC.GATES.evalWindow;
  const days = Object.keys(ev).sort().filter(d => mature(G, d)).slice(-win).filter(d => ev[d]?.models?.[act] && ev[d]?.models?.naive);
  const gm = (k) => (days.length ? { a: mean(days.map(d => ev[d].models[act][k])), b: mean(days.map(d => ev[d].models.naive[k])), n: days.length } : null);
  // ausgegebene Prognosen (Live-Abgleich, letzte 7 Tage): je Anbieter und Stunde gegen „wie gestern“ über dieselben Stunden
  const liveLv = FC.liveSummary(L?.live, { now: L?.generatedAt ? Date.parse(L.generatedAt) : null }); // eine Quelle mit dem Bericht (Audit MET-08)
  // Audit UXP-07: live, gh und gd gelten für Deutschland gesamt; bei einer Auswahl (Gemeinde, Anbieter, Art) urteilt nur deren eigene Ebene
  const local = !(sel?.ags === 'DE' || !sel?.ags) || (sel?.op && sel.op !== 'all') || (sel?.ty && sel.ty !== 'all');
  const lv = [['live', liveLv], ['scope', scope], ['gh', gm('wapeGH')], ['gd', gm('wapeGD')]].filter(([, x]) => x && x.a != null && x.b != null).map(([k, x]) => ({ k, ...x, j: judge(x.a, x.b), nat: local && k !== 'scope' }));
  const vl = local && lv.some(x => x.k === 'scope') ? lv.filter(x => x.k === 'scope') : lv, main = vl[0] || null;
  const nb = vl.filter(x => x.j === 'better').length, nw = vl.filter(x => x.j === 'worse').length;
  // Audit UXP-06: Haken nur, wenn mindestens eine Ebene besser ist und die Hauptebene unter GRADE_USABLE Abweichung liegt
  const unusable = main != null && main.a >= GRADE_USABLE;
  const lvl = !vl.length ? 'none' : nw === 0 && nb >= 1 && !unusable ? 'ok' : nb === 0 && nw > 0 ? 'bad' : 'near';
  const biasG = days.length ? mean(days.map(d => ev[d].models[act].bias).filter(x => x != null)) : null;
  return { lv, vl, main, local, natOnly: local && !lv.some(x => x.k === 'scope'), unusable, nb, nw, lvl, act, evalDays: days.length, win, bias: scope?.bias ?? biasG };
}
const GRADE_USABLE = 0.5; // Abweichung je Stunde ab 50 %: „nur als Größenordnung lesen“, kein grüner Haken
function verdictText(ctx, g) {
  if (!g.vl?.length) return t('fv.vNone');
  const n = g.vl.length, x = g.main;
  const main = g.unusable ? t('fv.vUnusable', { a: pc(x.a), b: pc(x.b) })
    : n === 1 ? t(x.j === 'better' ? 'fv.vOne' : x.j === 'worse' ? 'fv.vOneWorse' : 'fv.vOneEq', { a: pc(x.a), b: pc(x.b) })
    : g.nw === 0 ? (g.nb === n ? t('fv.vAll', { n }) : t('fv.vNoWorse', { b: g.nb, n })) : g.nb === 0 ? t('fv.vNotYet', { w: g.nw, n }) : t('fv.vMixed', { b: g.nb, w: g.nw, n });
  const nat = g.natOnly ? ` ${t('fv.vNational')}` : '';
  const basis = g.evalDays < g.win ? t('fv.vBasisEarly', { n: g.evalDays, win: g.win }) : t('fv.vBasis', { n: g.evalDays });
  const bias = g.bias == null ? '' : Math.abs(g.bias) < 0.05 ? t('fv.vBiasNone', { d: sg(g.bias, 0) }) : t(g.bias < 0 ? 'fv.vBiasLow' : 'fv.vBiasHigh', { d: pc(Math.abs(g.bias)) });
  return `<b>${ctx.esc(main)}</b> ${ctx.esc(bias)} ${ctx.esc(basis)}${ctx.esc(nat)}`;
}
/** Zeugnis in einer Zeile über dem Diagramm (Audit UXP-05), Details im Panel darunter */
function gradeLine(ctx, S0, sel, G, L) {
  const g = gradeOf(S0, sel, G, L), ico = g.lvl === 'ok' ? '✓' : g.lvl === 'near' ? '!' : g.lvl === 'bad' ? '✗' : '–';
  return `<p class="fv-verdict fv-gline ${g.lvl}"><i aria-hidden="true">${ico}</i><span>${verdictText(ctx, g)} <a href="#fv-grade">${t('fv.gDetails')}</a></span></p>`;
}
const jChip = (j) => (j ? `<span class="fv-j ${j}">${t(j === 'better' ? 'fv.gBetter' : j === 'worse' ? 'fv.gWorse' : 'fv.gEqual')}</span>` : '–');
function gradePanel(ctx, S0, sel, G, L) {
  const g = gradeOf(S0, sel, G, L), scopeTxt = scopeLabel(ctx, sel);
  const label = (x) => (x.k === 'live' ? [t('fv.gRowLive'), t('fv.gRowLiveSub', { n: x.n, h: n0(x.h) })] : x.k === 'scope' ? [t('fv.gRowScope', { s: scopeTxt }), t('fv.gRowScopeSub', { n: x.n })] : x.k === 'gh' ? [t('fv.gRowGH'), t('fv.gRowGroupSub', { n: x.n, model: modelName(g.act) })] : [t('fv.gRowGD'), t('fv.gRowGroupSub', { n: x.n, model: modelName(g.act) })]);
  const tbl = g.lv.length ? `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.gradeTitle'))}"><table><thead><tr><th>${t('fv.gLevel')}</th><th class="n">${t('fv.gModel')}</th><th class="n">${t('fv.gNaive')}</th><th class="mh">${t('fv.gVerdict')}</th></tr></thead><tbody>${g.lv.map(x => { const [l, s] = label(x); return `<tr><td class="wrap"><span class="lv">${ctx.esc(l)}</span>${x.nat ? ` <span class="fv-chip D">${t('fv.gNat')}</span>` : ''}<span class="lvs">${ctx.esc(s)}</span><span class="m-only">${jChip(x.j)}</span></td><td class="n">${pc(x.a)}</td><td class="n">${pc(x.b)}</td><td class="mh">${jChip(x.j)}</td></tr>`; }).join('')}</tbody></table></div>` : '';
  const ico = g.lvl === 'ok' ? '✓' : g.lvl === 'near' ? '!' : g.lvl === 'bad' ? '✗' : '–';
  return `<div class="panel" id="fv-grade">${head(t('fv.gradeTitle'), t('fv.gradeSub'))}<p class="fv-verdict ${g.lvl}"><i aria-hidden="true">${ico}</i><span>${verdictText(ctx, g)}</span></p>${tbl}<div class="fv-sub">${t('fv.gHow')}</div>${dlRow(true)}</div>`;
}

// ---------- Lernkurve: Wertung je Tag und Modell, Modellvergleich, was das lernende Modell gelernt hat ----------
function curveSvg(ctx, G, L, width) {
  const ev = G?.evals || {}, days = Object.keys(ev).sort().slice(-14), ms = MODEL_ORDER.filter(m => days.some(d => FC.scoreOf(ev[d]?.models?.[m]) != null));
  if (days.length < 2 || !ms.length) return '';
  const W = Math.max(320, Math.min(1100, Math.round(width))), H = 230, pl = 40, pr = 16, pt = 14, pb = 30, vals = days.flatMap(d => ms.map(m => FC.scoreOf(ev[d]?.models?.[m]))).filter(Number.isFinite);
  const top = Math.max(0.1, Math.ceil(Math.max(...vals) * 10 + 0.5) / 10), y = (v) => pt + (H - pt - pb) * (1 - v / top), x = (i) => pl + (days.length === 1 ? 0 : i * (W - pl - pr) / (days.length - 1));
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y(top * f).toFixed(1)}" y2="${y(top * f).toFixed(1)}"/><text x="${pl - 5}" y="${(y(top * f) + 4).toFixed(1)}" text-anchor="end">${numFmt(0).format(top * f * 100)} %</text>`).join('');
  const every = Math.max(1, Math.ceil(days.length / (W < 520 ? 4 : 8)));
  const xl = days.map((d, i) => (i % every === 0 || i === days.length - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}">${ctx.esc(dayTxt(d, { day: 'numeric', month: 'numeric' }))}</text>` : '')).join('');
  const lines = ms.map(m => { let d = '', open = false, dots = '';
    days.forEach((day, i) => { const v = FC.scoreOf(ev[day]?.models?.[m]); if (v == null) { open = false; return; } d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; open = true; dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${m === L?.active ? 3.6 : 2.6}" fill="${MODEL_COLOR[m]}"><title>${ctx.esc(`${modelName(m)} · ${dayTxt(day)} · ${pc(v, 1)}`)}</title></circle>`; });
    return `<path class="${m === L?.active ? 'act' : ''}${m === 'naive' || m === 'week' ? ' nv' : ''}" style="stroke:${MODEL_COLOR[m]}" d="${d}"/>${dots}`; }).join('');
  const keys = ms.map(m => `<span><i class="${m === 'naive' || m === 'week' ? 'nv' : ''}" style="border-color:${MODEL_COLOR[m]}"></i>${m === L?.active ? `<b>${ctx.esc(modelName(m))}</b> (${t('fv.activeTag')})` : ctx.esc(modelName(m))}</span>`).join('');
  return `<div class="fv-keys2">${keys}</div><div class="fv-curve"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ctx.esc(t('fv.curveAria'))}">${grid}${lines}${xl}</svg></div>`;
}
function curveTrend(ctx, G, L) {
  const ev = G?.evals || {}, act = L?.active, days = Object.keys(ev).sort().slice(-14).filter(d => FC.scoreOf(ev[d]?.models?.[act]) != null);
  if (!act || !days.length) return '';
  if (days.length < 2) return t('fv.curveOne');
  const d1 = days[0], d2 = days.at(-1), a = FC.scoreOf(ev[d1].models[act]), b = FC.scoreOf(ev[d2].models[act]);
  return t('fv.curveTrend', { model: ctx.esc(modelName(act)), a: pc(a), d1: ctx.esc(dayTxt(d1)), t1: ev[d1].trainDays ?? '–', b: pc(b), d2: ctx.esc(dayTxt(d2)), t2: ev[d2].trainDays ?? '–' });
}
const groupLabel = (ctx, key) => { const [ags, op, ty] = String(key).split('|'), tl = tMap('type', VEHICLE_TYPE_LABEL); return `${ctx.muniName?.(ags) || ags} · ${op} · ${tl[ty] || ty}`; };
function learnedHtml(ctx, L) {
  const x = L?.learn, gain = pc(L?.gates?.adGain ?? FC.GATES.adGain);
  if (!x) return `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.learnedTitle')}</h3><p class="fv-sub">${t('fv.learnedNone')}</p>`;
  const lead = t('fv.learnedLead', { days: n1(x.days), own: n0(x.leanOwn), pool: n0(x.leanPool), mixed: n0(x.mixed), judged: n0(x.judged), share: pc(x.ownShare), eo: pc(x.errOwn), ep: pc(x.errPooled) });
  const state = L.active === 'adaptive' ? t('fv.learnedActive') : t('fv.learnedCandidate', { gain });
  const rows = [...(x.own || []).filter(r => r[1] >= 0.55).map(r => ['own', ...r]), ...(x.pool || []).filter(r => r[1] <= 0.45).map(r => ['pool', ...r])];
  const tbl = rows.length ? `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.learnedTitle'))}"><table><thead><tr><th>${t('fv.colGroup')}</th><th>${t('fv.colLearnsFrom')}</th><th class="n">${t('fv.colOwnW')}</th><th class="n mh">${t('fv.colErrOwn')}</th><th class="n mh">${t('fv.colErrPool')}</th><th class="n mh">${t('fv.colStarts')}</th></tr></thead><tbody>${rows.map(([dir, k, w, eo, ep, y]) => `<tr><td class="wrap">${ctx.esc(groupLabel(ctx, k))}</td><td><span class="fv-chip${dir === 'own' ? ' A' : ''}">${t(dir === 'own' ? 'fv.fromOwn' : 'fv.fromAll')}</span></td><td class="n">${pc(w)}</td><td class="n mh">${pc(eo)}</td><td class="n mh">${pc(ep)}</td><td class="n mh">${n0(y)}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.learnedTitle')}</h3><p class="fv-sub" style="margin-top:0">${ctx.esc(lead)} ${ctx.esc(state)}</p>${tbl}<div class="fv-sub">${t('fv.learnedNote')}</div>`;
}
/** Letzter reifer Prüftag: aktives Modell gegen „wie gestern“ je Fahrzeugart und Gruppengröße (die Gesamtwertung ist nach Volumen gewichtet) */
function partsHtml(ctx, G, L) {
  const ev = G?.evals || {}, act = L?.active, d = Object.keys(ev).sort().filter(x => mature(G, x) && ev[x]?.models?.[act]?.byType && ev[x]?.models?.naive?.byType).at(-1);
  if (!d) return '';
  const A = ev[d].models[act], N = ev[d].models.naive, tl = tMap('type', VEHICLE_TYPE_LABEL);
  const rows = [...Object.keys(A.byType).filter(k => A.byType[k][2] > 0).sort((a, b) => A.byType[b][2] - A.byType[a][2]).map(k => [tl[k] || k, A.byType[k], N.byType[k]]),
    ...['L', 'M', 'S'].filter(k => A.bySize?.[k]?.[2] > 0).map(k => [t(`fv.size${k}`), A.bySize[k], N.bySize?.[k]])];
  const sc = (x) => (x ? (x[0] + x[1]) / 2 : null);
  return `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.partsTitle')}</h3><div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.partsTitle'))}"><table><thead><tr><th>${t('fv.colPart')}</th><th class="n mh">${t('fv.colStarts')}</th><th class="n">${t('fv.gModel')}</th><th class="n">${t('fv.gNaive')}</th><th class="mh">${t('fv.gVerdict')}</th></tr></thead><tbody>${rows.map(([l, a, n]) => `<tr><td class="wrap"><span class="lv">${ctx.esc(l)}</span><span class="m-only">${jChip(judge(sc(a), sc(n)))}</span></td><td class="n mh">${n0(a[2])}</td><td class="n"><span class="v2">${pc(a[0])}</span><span class="v2">${pc(a[1])}</span></td><td class="n">${n ? `<span class="v2">${pc(n[0])}</span><span class="v2">${pc(n[1])}</span>` : '–'}</td><td class="mh">${jChip(judge(sc(a), sc(n)))}</td></tr>`).join('')}</tbody></table></div><div class="fv-sub">${t('fv.partsNote', { d: ctx.esc(dayTxt(d)), model: ctx.esc(modelName(act)) })}</div>`;
}
/** Umgebung und Langzeitgedächtnis: was gelernt ist (Faktor mit 90-%-Bereich), wie viel Erfahrung dahintersteht, ob es im Modell ist */
const fx = (x) => (x == null || !Number.isFinite(x) ? '–' : `×${numFmt(2).format(x)}`);
function envHtml(ctx, L, { title = true } = {}) {
  const M = L?.memory, E = L?.env, esc = ctx.esc;
  if (!M && !E) return '';
  const wxUsed = !!L?.weather?.used, act = new Set(E?.active || []), ready = new Set(E?.ready || []);
  const rows = (FC.EFFECTS || []).map(k => {
    const e = M?.effects?.[k] || {}, isWx = ['cold', 'warm', 'rain'].includes(k), inv = k === 'cold'; // kalt: Merkmal ≤ 0, „10 K kälter“ = exp(−b)
    const f = e.b == null ? null : Math.exp(inv ? -e.b : e.b), lo = e.b == null ? null : inv ? 1 / e.hi : e.lo, hi = e.b == null ? null : inv ? 1 / e.lo : e.hi;
    const sup = E?.support?.[k], n = isWx ? e.n : (sup ? sup.rows + sup.memRows : e.n), days = isWx ? e.days : (sup ? sup.days + sup.memDays : e.days);
    let st = isWx ? (wxUsed ? 'on' : e.b == null ? 'none' : 'wait') : act.has(k) ? 'on' : ready.has(k) ? 'ready' : n > 0 ? 'wait' : 'none';
    // Lernphase: erfasst, aber noch zurückgehalten (Sport, Veranstaltungen, Volksfeste ab E.pendingFrom) – Erfahrung = was sie kennzeichnen würden
    if (!isWx && st === 'none' && sup?.pending?.rows) return { k, f, lo, hi, n: sup.pending.rows, days: sup.pending.days, st: 'held' };
    return { k, f, lo, hi, n, days, st };
  });
  const heldFrom = E?.pendingFrom && Number.isFinite(Date.parse(E.pendingFrom)) ? dateFmt({ day: 'numeric', month: 'numeric', timeZone: TZ }).format(new Date(E.pendingFrom)) : '–';
  const chip = (st) => `<span class="fv-chip${st === 'on' ? ' A' : st === 'ready' || st === 'held' ? ' B' : ''}">${t(`fv.envSt.${st}`, { d: heldFrom })}</span>`;
  const tbl = `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.envTitle'))}"><table><thead><tr><th>${t('fv.envColWhat')}</th><th class="n">${t('fv.envColEffect')}</th><th class="n mh">${t('fv.envColRange')}</th><th class="n mh">${t('fv.envColExp')}</th><th>${t('fv.envColState')}</th></tr></thead><tbody>${rows.map(r => `<tr><td class="wrap">${t(`fv.env.${r.k}`)}</td><td class="n">${fx(r.f)}</td><td class="n mh">${r.lo == null ? '–' : `${fx(r.lo)} – ${fx(r.hi)}`}</td><td class="n mh">${t('fv.envExp', { n: n0(r.n), d: n1(r.days) })}</td><td>${chip(r.st)}</td></tr>`).join('')}</tbody></table></div>`;
  const S = E?.sources || {}, up = (S.upcoming || []).map(e => `${esc(e.titel || t(`fv.envArt.${e.art}`))} (${esc(String(e.von))}${e.bis && e.bis !== e.von ? `–${esc(String(e.bis))}` : ''})`).join(' · ');
  const lead = M ? t('fv.envLead', { since: M.since ? esc(dayTxt(M.since, { day: 'numeric', month: 'short', year: 'numeric' })) : '–', days: n1(M.days), old: n1(M.oldDays), hl: M.halfLifeDays }) : '';
  const src = t('fv.envSources', { warn: S.warnAt ? timeTxt(S.warnAt) : t('fv.envNever'), road: S.roadAt ? timeTxt(S.roadAt) : t('fv.envNever'), n: n0(S.curated || 0) }) + (up ? ` ${t('fv.envUpcoming')} ${up}` : '');
  return `${title ? `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.envTitle')}</h3>` : ''}<p class="fv-sub" style="margin-top:0">${lead}</p>${tbl}<div class="fv-sub">${src}</div><div class="fv-sub">${t('fv.envNote', { rows: FC.GATES.ctxMinRows, days: FC.GATES.ctxMinDays })}</div>`;
}
function curvePanel(ctx, G, L, width) {
  const race = raceOf(G, L), cand = race.filter(r => r.m !== 'naive'), best = cand.length ? Math.min(...cand.map(r => r.sc.v)) : null, maxS = Math.max(0.01, ...race.map(r => r.sc.v));
  const raceHtml = race.length ? `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.raceTitle')}</h3><div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.raceTitle'))}"><table><thead><tr><th>${t('fv.colModel')}</th><th class="n">${t('fv.colScore')}</th><th class="n mh">${t('fv.colGD')}</th><th class="n mh">${t('fv.colGH')}</th><th class="n mh">${t('fv.colBias')}</th><th class="n mh">${t('fv.colCover')}</th><th class="n mh">${t('fv.colDays')}</th></tr></thead><tbody>${race.map(r => `<tr><td>${ctx.esc(modelName(r.m))}${r.m === L?.active ? ` <span class="fv-chip B">${t('fv.activeTag')}</span>` : ''}${r.m !== 'naive' && r.sc.v === best ? ` <span class="fv-chip A">${t('fv.bestTag')}</span>` : ''}</td><td class="n bars"><span class="t">${pc(r.sc.v)}</span><span class="fv-bar${r.m === 'naive' ? ' n' : ''}" style="width:${Math.round(r.sc.v / maxS * 110)}px"></span></td><td class="n mh">${pc(r.gd?.v)}</td><td class="n mh">${pc(r.gh?.v)}</td><td class="n mh">${sg(r.bias?.v, 1)}</td><td class="n mh">${pc(r.cov?.v)}</td><td class="n mh">${r.sc.n}</td></tr>`).join('')}</tbody></table></div><div class="fv-sub">${t('fv.raceNote')}</div>` : '';
  const svg = curveSvg(ctx, G, L, width), trend = curveTrend(ctx, G, L);
  return `<div class="panel" id="fv-curve">${head(t('fv.curveTitle'), t('fv.curveSub'), allTag(ctx))}${trend ? `<p class="fv-lead" style="margin-top:var(--s2)">${trend}</p>` : ''}${svg}${raceHtml}${partsHtml(ctx, G, L)}${learnedHtml(ctx, L)}${envHtml(ctx, L)}</div>`;
}

// ---------- Algorithmus herunterladen: Steckbrief (Markdown, aus den aktuellen Daten) und Quellcode der Engine ----------
const ENGINE_FILES = ['pulse-forecast.js', 'pulse-context.js', 'pulse-econ.js', 'pulse-track.js', 'pulse-core.js'];
function dlRow(short = false) {
  const files = short ? ENGINE_FILES.slice(0, 1) : ENGINE_FILES;
  return `<div class="fv-dl"><span>${t('fv.dlLead')}</span><button type="button" class="chip" data-fv-dl="md">${t('fv.dlMd')}</button>${files.map(f => `<button type="button" class="chip" data-fv-dl="code" data-f="${f}">${f === 'pulse-forecast.js' ? t('fv.dlEngine') : f}</button>`).join('')}${short ? `<span>${t('fv.dlMore')} <a href="#prognose-basis">${t('fv.segBasis')}</a></span>` : ''}</div>`;
}
function saveText(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const mdEsc = (v) => String(v ?? '–').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const mdTable = (head, rows) => `| ${head.map(mdEsc).join(' | ')} |\n|${head.map(() => ' --- ').join('|')}|\n${rows.map(r => `| ${r.map(mdEsc).join(' | ')} |`).join('\n')}\n`;
/** Parameter der Prognose (aus dem Code) – Grundlagen-Tabelle und Steckbrief */
function paramRows(L) {
  const gates = { ...FC.GATES, ...(L?.gates || {}) };
  return [
    ['minTrainDays', gates.minTrainDays, t('fv.pMinTrain')], ['minEvalDays', gates.minEvalDays, t('fv.pMinEval')], ['hourMinObserved', gates.hourMinObserved, t('fv.pHourMin')],
    ['wxTempRangeK', gates.wxTempRangeK, t('fv.pWxRange')], ['wxRainDays', gates.wxRainDays, t('fv.pWxRain')], ['wxMissingMax', gates.wxMissingMax, t('fv.pWxMiss')], ['wxGain', gates.wxGain, t('fv.pWxGain')],
    ['adGain', gates.adGain ?? FC.GATES.adGain, t('fv.pAdGain')], ['evalWindow', gates.evalWindow, t('fv.pWindow')], ['minEvalTrainDays', gates.minEvalTrainDays ?? FC.GATES.minEvalTrainDays, t('fv.pMinEvalTrain')],
    ['liveMinHours', gates.liveMinHours ?? FC.GATES.liveMinHours, t('fv.pLiveMin')], ['wxShareDay', gates.wxShareDay ?? FC.GATES.wxShareDay, t('fv.pWxShare')],
    ['HYBRID.k', FC.HYBRID.k, t('fv.pHybK')], ['HYBRID.maxBack', FC.HYBRID.maxBack, t('fv.pHybBack')],
    ['ctxMinRows', gates.ctxMinRows ?? FC.GATES.ctxMinRows, t('fv.pCtxRows')], ['ctxMinDays', gates.ctxMinDays ?? FC.GATES.ctxMinDays, t('fv.pCtxDays')], ['MEMORY.halfLifeDays', FC.MEMORY.halfLifeDays, t('fv.pMemHl')], ['POOLED.typeHour', String(FC.POOLED.typeHour), t('fv.pTypeHour')], ['POOLED.hier', String(FC.POOLED.hier), t('fv.pHier')], ['POOLED.halfLife', FC.POOLED.halfLife, t('fv.pHalfLife7')],
    ['FEEDBACK.halfLifeDays', FC.FEEDBACK.halfLifeDays, t('fv.pHalfLife')], ['FEEDBACK.kBlend', FC.FEEDBACK.kBlend, t('fv.pKBlend')], ['FEEDBACK.sharp', FC.FEEDBACK.sharp, t('fv.pSharp')],
    ['SERIES_KEEP_DAYS', FC.SERIES_KEEP_DAYS, t('fv.pKeep')], ['SERIES_MIN.ags', FC.SERIES_MIN.ags, t('fv.pSerAgs')], ['SERIES_MIN.group', FC.SERIES_MIN.group, t('fv.pSerGroup')], ['SERIES_MIN.groupMax', FC.SERIES_MIN.groupMax, t('fv.pSerMax')],
    ['baseH', OPS.baseH, t('fv.pBase')], ['minPerSpot', OPS.minPerSpot, t('fv.pMinSpot')], ['maxPerSpot', OPS.maxPerSpot, t('fv.pMaxSpot')], ['spotRadiusM', OPS.spotRadiusM, t('fv.pRadius')], ['horizonH', OPS.horizonH, t('fv.pHorizon')], ['prelimH', OPS.prelimH, t('fv.pPrelim')],
    ['RATE.classA', SP.RATE.classA, t('fv.pClassA')], ['RATE.classB', SP.RATE.classB, t('fv.pClassB')], ['RATE.linkM', SP.RATE.linkM, t('fv.pLink')], ['DEMAND_DAYS', DEMAND_DAYS, t('fv.pDemandDays')],
  ];
}
const NOT_KEYS = ['nTrain', 'nStrike', 'nEvents', 'nRoad', 'nOp', 'nZones'];
export function steckbrief(ctx, S0, L, G, sel) {
  const g = gradeOf(S0, sel, G, L), scopeTxt = scopeLabel(ctx, sel), gates = { ...FC.GATES, ...(L?.gates || {}) }, now = dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).format(new Date());
  const strip = (h) => String(h).replace(/<[^>]+>/g, '');
  const levelName = (x) => (x.k === 'live' ? t('fv.gRowLive') : x.k === 'scope' ? t('fv.gRowScope', { s: scopeTxt }) : x.k === 'gh' ? t('fv.gRowGH') : t('fv.gRowGD'));
  const jTxt = (j) => (j ? t(j === 'better' ? 'fv.gBetter' : j === 'worse' ? 'fv.gWorse' : 'fv.gEqual') : '–');
  const out = [];
  out.push(`# ${t('fv.mdTitle')}\n`, `${t('fv.mdStand', { time: now, data: timeTxt(L?.generatedAt), url: location.href.split('#')[0] })}\n`);
  out.push(`## ${t('fv.mdVerdict')}\n`, `${strip(verdictText({ esc: (x) => x }, g))}\n`);
  if (g.lv.length) out.push(mdTable([t('fv.gLevel'), t('fv.gModel'), t('fv.gNaive'), t('fv.gVerdict')], g.lv.map(x => [levelName(x), pc(x.a), pc(x.b), jTxt(x.j)])), `\n${strip(t('fv.gHow'))}\n`);
  out.push(`## ${t('fv.mdWhat')}\n`, `${t('fv.mdWhatTxt', { g: n0(L?.learn?.groups ?? Object.keys(L?.groups || {}).length), m: n0(Object.keys(L?.municipalities || {}).length) })}\n`);
  out.push(`## ${t('fv.mdModels')}\n`, '```\n' + `${t('fv.formula')}\n` + '```\n');
  for (const [m, k] of [['profile', 'fv.mProfile'], ['pooled', 'fv.mPooled'], ['pooledWx', 'fv.mPooledWx'], ['adaptive', 'fv.mAdaptive'], ['hybrid', 'fv.mHybrid'], ['blend', 'fv.mBlend'], ['chronos', 'fv.mChronos'], ['naive', 'fv.mNaive']]) out.push(`- **${modelName(m)}**${m === L?.active ? ` (${t('fv.activeTag')})` : ''}: ${m === 'blend' ? blendTxt(L) : t(k, { hl: FC.FEEDBACK.halfLifeDays, k: FC.HYBRID.k, back: FC.HYBRID.maxBack, min: L?.external?.chronos?.minStarts ?? 20 })}`);
  out.push('', `${t('fv.chooseRule', { min: gates.minEvalDays, win: gates.evalWindow, gain: pc(gates.wxGain), again: pc(gates.adGain ?? FC.GATES.adGain), mt: gates.minEvalTrainDays ?? FC.GATES.minEvalTrainDays })}\n`, `${t('fv.mdActive', { model: L?.active ? modelName(L.active) : '–', reason: (L?.reason || L?.decision?.why) ? fcReason(L) : '–' })}\n`);
  const x = L?.learn;
  out.push(`## ${t('fv.mdLearn')}\n`, `${t('fv.mAdaptive', { hl: FC.FEEDBACK.halfLifeDays })}\n`);
  if (x) { out.push(`${t('fv.learnedLead', { days: n1(x.days), own: n0(x.leanOwn), pool: n0(x.leanPool), mixed: n0(x.mixed), judged: n0(x.judged), share: pc(x.ownShare), eo: pc(x.errOwn), ep: pc(x.errPooled) })}\n`);
    const rows = [...(x.own || []).map(r => [t('fv.fromOwn'), ...r]), ...(x.pool || []).map(r => [t('fv.fromAll'), ...r])];
    if (rows.length) out.push(mdTable([t('fv.colGroup'), t('fv.colLearnsFrom'), t('fv.colOwnW'), t('fv.colErrOwn'), t('fv.colErrPool'), t('fv.colStarts')], rows.map(([dir, k, w, eo, ep, y]) => [groupLabel(ctx, k), dir, pc(w), pc(eo), pc(ep), n0(y)])));
  } else out.push(`${t('fv.learnedNone')}\n`);
  if (L?.memory) { out.push(`\n## ${t('fv.envTitle')}\n`, `${strip(envHtml({ esc: (x) => x }, L, { title: false }).replace(/<table>[\s\S]*<\/table>/, '').replace(/<\/(p|div)>/g, '\n'))}\n`);
    out.push(mdTable([t('fv.envColWhat'), t('fv.envColEffect'), t('fv.envColRange'), t('fv.envColExp')], (FC.EFFECTS || []).map(k => { const e = L.memory.effects?.[k] || {}, inv = k === 'cold'; return [t(`fv.env.${k}`), e.b == null ? '–' : fx(Math.exp(inv ? -e.b : e.b)), e.b == null ? '–' : `${fx(inv ? 1 / e.hi : e.lo)} – ${fx(inv ? 1 / e.lo : e.hi)}`, t('fv.envExp', { n: n0(e.n), d: n1(e.days) })]; }))); }
  const ev = G?.evals || {}, evRows = [];
  for (const d of Object.keys(ev).sort()) for (const m of MODEL_ORDER) { const r = ev[d]?.models?.[m]; if (r) evRows.push([d, ev[d].trainDays ?? '–', modelName(m), pc(FC.scoreOf(r), 1), pc(r.wapeGD, 1), pc(r.wapeGH, 1), sg(r.bias, 1), pc(r.cover80)]); }
  out.push(`\n## ${t('fv.mdEval')}\n`, `${strip(t('fv.raceNote'))}\n`, evRows.length ? mdTable([t('fv.colDay'), t('fv.colTrain'), t('fv.colModel'), t('fv.colScore'), t('fv.colGD'), t('fv.colGH'), t('fv.colBias'), t('fv.colCover')], evRows) : `${t('fv.accNone')}\n`);
  const lvAll = (L?.live || []).slice().reverse();
  if (lvAll.length) out.push(`\n## ${t('fv.liveTitle')}\n`, mdTable([t('fv.colIssued'), t('fv.colModel'), t('fv.colHours'), t('fv.colErrOp'), t('fv.colNaive'), t('fv.colSkill')], lvAll.map(x => [dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(x.at)), x.model ? modelName(x.model) : '–', x.hours ?? 24, pc(x.wapeOpH), pc(x.naiveOpH), x.skill == null ? '–' : sg(x.skill)])), `\n${strip(t('fv.liveNote', { min: FC.GATES.liveMinHours }))}\n`);
  const pr = S0 ? accRows(S0, sel, G) : [];
  out.push(`\n## ${t('fv.mdPlan', { scope: scopeTxt })}\n`, pr.length ? mdTable([t('fv.colDay'), t('fv.colIst'), t('fv.colPlan'), t('fv.colBias'), t('fv.colErr'), t('fv.colNaive'), t('fv.colSkill'), t('fv.colTrain')], pr.map(r => [r.d, n0(r.ist), n0(r.plan), sg(r.bias, 1), pc(r.wape), pc(r.naive), r.skill == null ? '–' : sg(r.skill), r.train ?? '–'])) : `${t('fv.accNone')}\n`, `\n${strip(t('fv.accNote'))}\n`);
  out.push(`\n## ${t('fv.mdParams')}\n`, mdTable([t('fv.colParam'), t('fv.colValue'), t('fv.colEffect')], paramRows(L).map(([k, v, d]) => [k, v, d])));
  out.push(`\n## ${t('fv.mdNot')}\n`, NOT_KEYS.map(k => `- ${t(`fv.${k}`)}`).join('\n'), `\n\n${strip(t('fv.notNote'))}\n`);
  out.push(`\n## ${t('fv.mdCode')}\n`, `${t('fv.mdCodeTxt', { repo: ctx.CFG?.REPO || '' })}\n`);
  return out.join('\n');
}
function bindDl(el, ctx, S0, L, G, sel) {
  el.querySelectorAll('[data-fv-dl="md"]').forEach(b => b.addEventListener('click', () => saveText(`prognose-algorithmus_${S0?.today || 'stand'}.md`, steckbrief(ctx, S0, L, G, sel), 'text/markdown;charset=utf-8')));
  el.querySelectorAll('[data-fv-dl="code"]').forEach(b => b.addEventListener('click', async () => {
    const f = b.dataset.f; if (!ENGINE_FILES.includes(f)) return;
    try {
      const r = await fetch(new URL(`./${f}`, import.meta.url), { cache: 'no-store' }); if (!r.ok) throw new Error(String(r.status));
      saveText(f, (await r.text()).replace(/(from '\.\/[\w-]+\.js)\?v=[\w]+'/g, "$1'"), 'text/javascript;charset=utf-8'); // Versionsanhang des Builds entfernen = Datei wie im Repo
    } catch { window.open(`${ctx.CFG?.REPO || ''}/blob/main/lib/${f}`, '_blank', 'noopener'); }
  }));
}

// ---------- Spots ----------
const COLORS = { miss: '#e3703d', ok: '#2fa36b', over: '#4f8fe0', none: '#8a949e' };
function spotsPanelShell(ctx, s0) { return `<div class="panel" id="fv-spots">${head(t('fv.spotsTitle'), t('fv.spotsSub'))}<div id="fv-spots-body">${s0 || ''}</div></div>`; }
async function paintSpots(el, ctx, s, S0, L, sel) {
  const box = el.querySelector('#fv-spots-body'); if (!box) return; const tok = s.tok;
  const ags = ctx.state.scope, land = ctx.state.latest?.municipalities?.[ags]?.state, csvB = el.querySelector('[data-fv-csv="spots"]');
  s.rated = null; if (csvB) csvB.disabled = true;
  if (!ags || ags === 'DE' || !land) {
    const top = Object.entries(S0.days[S0.tomorrow] || {}).filter(([k]) => k.startsWith('ags:')).map(([k, e]) => [k.slice(4), sum(e.l || e.p || [])]).sort((a, b) => b[1] - a[1]).slice(0, 12);
    box.innerHTML = `<div class="empty"><b>${t('fv.spotsPick')}</b>${t('fv.spotsPickHint')}</div>${top.length ? `<div class="fv-munis">${top.map(([a, v]) => `<button class="chip" data-ags="${ctx.esc(a)}">${ctx.esc(ctx.muniName?.(a) || a)} · ${n0(v)}</button>`).join('')}</div>` : ''}`;
    box.querySelectorAll('button[data-ags]').forEach(b => b.addEventListener('click', () => ctx.setScope?.(b.dataset.ags))); return;
  }
  box.innerHTML = `<div class="note small">${t('fv.spotsLoading')}</div>`;
  const [fleet, dem, grp, quota] = await Promise.all([loadFleet(ctx, land), loadDemand(ctx, land, ags), loadGroups(ctx), Promise.resolve(ctx.loadOnce?.('quota', 'stations-quota.json')).catch(() => null)]);
  if (tok !== s.tok) return;
  if (!fleet) { box.innerHTML = `<div class="empty"><b>${t('fv.spotsNoFleet')}</b>${t('fv.spotsNoFleetHint')}</div>`; return; }
  // nur Anbieter der gewählten Fahrzeugfamilie (Audit 11.11.2026, UXP-04: vorher teilAuto als Standard in Tübingen, „75 Fahrzeuge fehlen“
  // mit Scooter-Nachfrage); Arten je Anbieter aus den Fahrzeugen und den Gruppen des Sammler-Stands (Stationen haben keine Art)
  const fam = famNow(ctx), tys = new Map();
  for (const v of fleet.vehicles) if (v.ags === ags) { let m = tys.get(v.operator); if (!m) tys.set(v.operator, m = new Set()); m.add(v.type); }
  for (const k of Object.keys(ctx.state?.latest?.groups || {})) { const [a, o, y] = k.split('|'); if (a !== ags) continue; let m = tys.get(o); if (!m) tys.set(o, m = new Set()); m.add(y); }
  const famOk = (o) => { const m = tys.get(o); return m ? [...m].some(y => familyOf(y) === fam) : fam === 'micro'; };
  const ops = [...new Set([...fleet.vehicles.filter(v => v.ags === ags).map(v => v.operator), ...fleet.stations.filter(x => x.ags === ags).map(x => x.operator)])].filter(o => o && famOk(o));
  const cnt = (o) => fleet.vehicles.filter(v => v.ags === ags && v.operator === o && familyOf(v.type) === fam).length + fleet.stations.filter(x => x.ags === ags && x.operator === o).length;
  ops.sort((a, b) => cnt(b) - cnt(a) || a.localeCompare(b, 'de'));
  const want = ctx.state.operator !== 'all' ? ctx.state.operator : s.op;
  const op = ops.includes(want) ? want : ops[0]; s.op = op;
  if (!op) { box.innerHTML = `<div class="empty"><b>${t('fv.spotsNoOp')}</b></div>`; return; }
  const gp = groupPlaces(grp?.docs || [], { ags });
  // Prognose des Anbieters in der Gemeinde: Summe der Gruppen (alle Arten oder die gewählte Art) aus latest.json, ab der nächsten vollen Stunde
  const ty = ctx.state.type !== 'all' ? ctx.state.type : null, day24 = new Array(24).fill(0); let hasFc = false;
  for (const [k, g] of Object.entries(L.groups || {})) { const [a, o, y] = k.split('|'); if (a === ags && o === op && (!ty || y === ty)) { hasFc = true; g.start.forEach((v, h) => { day24[h] += v; }); } }
  const R = SP.rateSpots(fleet, { ags, op, demand: dem?.model, groups: gp, quota, fc: hasFc ? { day24 } : null, type: ty || 'all' });
  s.rated = R; s.ratedAgs = ags; LAST_RATED = { ags, op, R }; if (csvB) csvB.disabled = !R.items.length;
  const T = R.total, opSel = ctx.state.operator !== 'all' ? '' : `<label>${t('fv.operator')} <select id="fv-op">${ops.map(o => `<option value="${ctx.esc(o)}"${o === op ? ' selected' : ''}>${ctx.esc(o)}</option>`).join('')}</select></label>`;
  const lead = !R.items.length ? t('fv.spotsNone', { op: ctx.esc(op) })
    : `<p class="fv-lead">${t('fv.spotsLead', { spots: `<b>${n0(T.spots)}</b>`, miss: `<b>${n0(T.missing)}</b>`, nMiss: `<b>${n0(T.spotsMissing)}</b>`, imp: `<b>${n0(T.missingAB)}</b>`, op: ctx.esc(op) })}</p>`;
  const tiles = R.items.length ? `<div class="tiles">${tile(t('fv.tSpots'), n0(T.spots), t('fv.tSpotsSub', { d: T.deploy, p: T.park, b: T.both }))}${tile(t('fv.tClasses'), `${T.byCls.A} · ${T.byCls.B} · ${T.byCls.C}`, t('fv.tClassesSub', { d: T.byCls.D }))}${tile(t('fv.tTarget'), n0(T.target), t('fv.tTargetSub', { have: n0(T.have) }), T.missing ? 'warn' : 'ok')}${tile(t('fv.tMissing'), n0(T.missing), t('fv.tMissingSub', { n: T.spotsMissing, ab: T.importantMissing }), T.missing ? 'warn' : 'ok')}</div>` : '';
  const rows = R.items.slice(0, s.rows), maxI = 1;
  const kindTxt = (x) => (x.kind === 'both' ? t('fv.kBoth') : x.kind === 'deploy' ? t('fv.kDeploy') : t('fv.kPark'));
  const info = (x) => [x.deploy ? t('fv.infDeploy', { n: x.deploy.count, avg: n1(x.deploy.avg) }) : '', x.deploy?.last ? t('fv.infLast', { d: dateFmt({ day: '2-digit', month: '2-digit', timeZone: TZ }).format(new Date(x.deploy.last)) }) : '', x.park?.emptyShare != null && x.park.runs >= SP.MIN_RUNS ? t('fv.infEmpty', { p: pc(x.park.emptyShare) }) : '', x.sharedWith ? t('fv.infShared', { n: x.sharedWith }) : ''].filter(Boolean).join(' · ');
  const tbl = R.items.length ? `<div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.spotsTitle'))}"><table><thead><tr><th class="n">#</th><th>${t('fv.colSpot')}</th><th>${t('fv.colClass')}</th><th class="n">${t('fv.colImp')}</th><th class="n">${t('fv.colExp')}</th><th class="n">${t('fv.colTarget')}</th><th class="n">${t('fv.colHave')}</th><th class="n">${t('fv.colMissing')}</th><th>${t('fv.colInfo')}</th></tr></thead><tbody>${rows.map(x => `<tr data-i="${x.rank - 1}"><td class="n">${x.rank}</td><td><button class="fv-link" data-i="${x.rank - 1}">${ctx.esc(x.label || `${x.lat.toFixed(4)}, ${x.lon.toFixed(4)}`)}</button> <span class="fv-chip">${kindTxt(x)}</span></td><td><span class="fv-chip ${x.cls}">${x.cls}</span></td><td class="n bars"><span class="t">${x.cls === 'D' ? '–' : pc(x.importance)}</span><span class="fv-bar" style="width:${Math.round(x.importance / maxI * 80)}px"></span></td><td class="n">${x.expected24 == null ? '–' : n0(x.expected24)}</td><td class="n">${x.cls === 'D' ? '–' : n0(x.targetFc)}</td><td class="n">${n0(x.have)}</td><td class="n"><span class="fv-miss${x.missing ? '' : ' z'}">${x.missing ? n0(x.missing) : '0'}</span></td><td class="sub-line" style="white-space:normal;min-width:18ch">${ctx.esc(info(x))}</td></tr>`).join('')}</tbody></table></div>${R.items.length > rows.length ? `<p><button class="chip" id="fv-more">${t('fv.more', { n: R.items.length - rows.length })}</button></p>` : ''}` : '';
  const notes = [R.prelim ? t('fv.nPrelim', { h: n0(R.hours) }) : '', !R.fc ? t('fv.nNoFc') : '', !dem?.model ? t('fv.nNoDemand') : '', ops.length > 1 ? '' : ''].filter(Boolean).join(' ');
  box.innerHTML = `${opSel ? `<div class="fv-ctl">${opSel}</div>` : ''}${lead}${tiles}${R.items.length ? `<div class="fv-map" id="fv-map" role="region" aria-label="${ctx.esc(t('fv.mapAria'))}"></div><div class="fv-keys"><span><i style="background:${COLORS.miss}"></i>${t('fv.keyMiss')}</span><span><i style="background:${COLORS.ok}"></i>${t('fv.keyOk')}</span><span><i style="background:${COLORS.over}"></i>${t('fv.keyOver')}</span><span><i style="background:${COLORS.none}"></i>${t('fv.keyNone')}</span><span>${t('fv.keySize')}</span></div>` : ''}${tbl}<div class="fv-sub">${t('fv.spotsNote', { r: R.radiusM, h: R.horizonH })} ${ctx.esc(notes)}</div>`;
  box.querySelector('#fv-op')?.addEventListener('change', (e) => { s.op = e.target.value; s.rows = SPOT_ROWS; paintSpots(el, ctx, s, S0, L, sel); });
  box.querySelector('#fv-more')?.addEventListener('click', () => { s.rows += 50; paintSpots(el, ctx, s, S0, L, sel); });
  if (R.items.length) drawMap(box.querySelector('#fv-map'), ctx, s, R, rows);
}
function drawMap(mapEl, ctx, s, R, rows) {
  const Lf = globalThis.L; if (!Lf || !mapEl) return;
  if (s.map) { try { s.map.remove(); } catch { /* weg */ } s.map = null; }
  const map = s.map = Lf.map(mapEl, { zoomControl: true, preferCanvas: true });
  Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('app.openstreetmapContributors') }).addTo(map);
  const pts = [], layer = Lf.layerGroup().addTo(map), byRank = new Map();
  for (const x of R.items) {
    const c = x.cls === 'D' ? COLORS.none : x.missing > 0 ? COLORS.miss : x.surplus > 0 ? COLORS.over : COLORS.ok;
    const m = Lf.circleMarker([x.lat, x.lon], { radius: 5 + Math.round(x.importance * 11), color: c, weight: 2, fillColor: c, fillOpacity: x.cls === 'D' ? 0.25 : 0.55 }).addTo(layer);
    m.bindPopup(`<b>${ctx.esc(x.label || `${x.lat.toFixed(4)}, ${x.lon.toFixed(4)}`)}</b><br>${ctx.esc(t('fv.popup', { cls: x.cls, imp: pc(x.importance), target: x.cls === 'D' ? '–' : n0(x.targetFc), have: n0(x.have), miss: n0(x.missing) }))}`);
    byRank.set(x.rank, m); pts.push([x.lat, x.lon]);
  }
  s.markers = byRank;
  map.invalidateSize();
  if (pts.length) map.fitBounds(pts, { padding: [24, 24], maxZoom: 16, animate: false }); else map.setView([51.1, 10.4], 6);
  setTimeout(() => { map.invalidateSize(); if (pts.length) map.fitBounds(pts, { padding: [24, 24], maxZoom: 16, animate: false }); }, 150);
  try { mapKeys(map); } catch { /* optional */ }
  mapEl.closest('#fv-spots-body')?.querySelectorAll('button.fv-link[data-i]').forEach(b => b.addEventListener('click', () => { const x = rows[+b.dataset.i]; if (!x) return; map.setView([x.lat, x.lon], Math.max(map.getZoom(), 16)); byRank.get(x.rank)?.openPopup(); mapEl.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }));
}

// ---------- Kopfleiste: gewählte Filter sichtbar und einzeln lösbar (die Auswahl selbst steht in der Filterleiste oben) ----------
function topBar(ctx, sel, extra = '') {
  const { esc } = ctx, S1 = ctx.state, ty = tMap('type', VEHICLE_TYPE_LABEL);
  const a = !!sel.ags && sel.ags !== 'DE', o = S1.operator !== 'all', y = S1.type !== 'all', ign = !!sel.ignored;
  const pill = (kind, label, val, on, off) => `<span class="fv-pill${on ? '' : ' dim'}${off ? ' ign' : ''}"${off ? ` title="${esc(t('fv.nIgnored'))}"` : ''}>${label}: <b>${esc(val)}</b>${on ? `<button type="button" data-fv-clear="${kind}" aria-label="${esc(t('fv.clearFilter', { f: label }))}">×</button>` : ''}</span>`;
  const fam = famNow(ctx), famTog = `<div class="fv-tog fv-fam" role="group" aria-label="${esc(t('fv.famAria'))}">${FC.FAMILIES.map(f => `<button type="button" data-fv-fam="${f}" aria-pressed="${f === fam}">${t(`fv.fam.${f}`)}</button>`).join('')}</div>`;
  return `<div class="fv-top" role="group" aria-label="${esc(t('fv.topAria'))}">${famTog}<span class="lbl">${t('fv.filter')}</span>`
    + pill('scope', t('fv.fArea'), a ? (ctx.muniName?.(sel.ags) || sel.ags) : t('fc.scopeDE'), a, false)
    + pill('op', t('fv.fOp'), o ? S1.operator : t('fv.fAll'), o, ign && o)
    + pill('type', t('fv.fType'), y ? (ty[S1.type] || S1.type) : t('fv.fAll'), y, ign && y)
    + (a || o || y ? `<button type="button" class="chip" data-fv-clear="all">${t('fv.resetAll')}</button>` : '')
    + `<span class="sp"></span>${extra}<span class="hint">${t('fv.filterHint')}</span></div>`;
}
function bindTop(el, ctx) {
  // Familie wechseln: passt die gewählte Fahrzeugart nicht, wird sie aufgehoben (das rendert alle Ansichten neu), sonst nur dieses Segment
  el.querySelectorAll('[data-fv-fam]').forEach(b => b.addEventListener('click', () => {
    const f = b.dataset.fvFam; if (f === famNow(ctx)) return; FAM = f;
    const ty = ctx.state?.type; if (ty && ty !== 'all' && familyOf(ty) !== f) ctx.setFilter?.('type', 'all'); else renderForecastView(el, ctx, { part: el.dataset.fvPart });
  }));
  el.querySelectorAll('[data-fv-clear]').forEach(b => b.addEventListener('click', () => { const k = b.dataset.fvClear; if (k === 'all') ctx.resetFilters?.(); else ctx.setFilter?.(k, k === 'scope' ? 'DE' : 'all'); }));
}
function download(name, rows) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + toCsv(rows, lang())], { type: 'text/csv;charset=utf-8' })); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const fileTag = (ctx, sel) => [FAM !== 'micro' ? FAM : null, sel.ags && sel.ags !== 'DE' ? sel.ags : 'DE', ctx.state.operator !== 'all' ? ctx.state.operator : null, ctx.state.type !== 'all' ? ctx.state.type : null].filter(Boolean).join('_').replace(/[^\w.-]+/g, '-');
const csvBtn = (key, label, disabled = false) => `<button type="button" class="chip" data-fv-csv="${key}"${disabled ? ' disabled' : ''}>${label}</button>`;

// ---------- Hauptansicht ----------
/** part: 'verlauf' (Standard) | 'spots' | 'basis' – jedes Segment des Reiters „Prognose“ hat einen eigenen Container */
export async function renderForecastView(el, ctx, opts = {}) {
  if (!el) return;
  const part = ['spots', 'basis'].includes(opts.part) ? opts.part : 'verlauf';
  css(); const s = st(el), tok = ++s.tok; el.classList.add('fv-root'); el.dataset.fvPart = part;
  if (!el.firstChild) el.innerHTML = `<div class="note small">${t('fv.loading')}</div>`;
  const fam = famNow(ctx);
  // ohne Prognose der gewählten Familie: Umschalter bleibt sichtbar, damit man zurückwechseln kann
  const none = () => { el.innerHTML = (fam === 'micro' ? '' : topBar(ctx, { ags: ctx.state?.scope || 'DE' })) + `<div class="panel"><div class="empty"><b>${fam === 'micro' ? t('fv.none') : t('fv.noneFam', { fam: t(`fv.fam.${fam}`) })}</b>${fam === 'micro' ? t('fv.noneHint') : t('fv.noneFamHint')}</div></div>`; if (fam !== 'micro') bindTop(el, ctx); };
  try {
    const [S0, L, G] = await Promise.all([fj(ctx, famFile(fam, 'series')), fj(ctx, famFile(fam, 'latest')), fj(ctx, famFile(fam, 'log'))]); if (tok !== s.tok) return;
    if (!S0 || S0.version !== 1 || !L) { none(); return; }
    if (part === 'spots') return await renderSpotsPart(el, ctx, s, S0, L);
    if (part === 'basis') return renderBasisPart(el, ctx, s, S0, L, G);
    await renderVerlauf(el, ctx, s, tok, S0, L, G);
  } catch (e) { console.error('Prognose-Ansicht', e); if (tok === s.tok) none(); }
}

async function renderVerlauf(el, ctx, s, tok, S0, L, G) {
  const { esc } = ctx;
  const sel = pickScope(S0, ctx.state), today = S0.today, bn = berlinNow();
  // heutige Ist-Werte frisch aus der Tagesdatei (der Sammler schreibt die Reihen höchstens stündlich)
  const fresh = await freshActual(ctx, S0, sel, today); if (tok !== s.tok) return;
  if (s.norm == null) { try { s.norm = localStorage.getItem('fv-norm') !== '0'; } catch { s.norm = true; } }
  const live = fresh?.a || null, norm = s.norm !== false, stale = bn.day !== today;
  const dayList = Object.keys(S0.days).filter(d => d <= today).sort().reverse(); // heute, gestern, …
  const view = s.day && (s.day === 'ahead' || dayList.includes(s.day)) ? s.day : 'ahead';
  s.day = view;
  const nowH = bn.day === today ? bn.h : bn.day > today ? 24 : 0, T = today, TM = addDays(today, 1);
  const eT = seriesOf(S0, T, sel), eM = seriesOf(S0, TM, sel);
  if (live) eT.a = live;
  // Zeilen des Diagramms; norm: je volle Stunde (Audit MET-01: der Sammler läuft alle ~18 Min., eine Stunde zählt 3 oder 4 Läufe und damit
  // 50–76 Minuten. Ist × 60 ÷ beobachtete Minuten des Tages; Plan und Live-Prognose × 60 ÷ beobachtete Minuten des Tages, dessen Fahrzeugstunden
  // sie verwenden (zuletzt beobachteter Tag davor, wie lib/pulse-forecast.js lastExposure). Nur Anzeige; Summen und Kacheln bleiben gezählt.
  const obsOf = (d) => (d === today && fresh?.obs ? fresh.obs : ctx.state.latest?.measure?.days?.[d]?.obs) || null;
  const mDays = [...new Set([...Object.keys(ctx.state.latest?.measure?.days || {}), today])].sort();
  const fA = (d, h) => { const o = obsOf(d)?.[h]; return norm && o >= 30 ? 60 / o : 1; };
  const fP = (d, h) => { if (!norm) return 1; for (let i = mDays.length - 1; i >= 0; i--) { const e = mDays[i]; if (e >= d) continue; const o = obsOf(e)?.[h]; if (o >= FC.GATES.hourMinObserved) return 60 / o; } return 1; };
  const nz = (v, f) => (v == null ? null : v * f);
  // üblicher Bereich (Audit UXP-09): gezählte Werte derselben Stunde an den letzten 3 Tagen gleicher Art (Werktag / Samstag / Sonn- und Feiertag) vor dem Tag
  const land = sel.ags && sel.ags !== 'DE' ? FC.LAND_OF_AGS[String(sel.ags).slice(0, 2)] ?? null : null, clsOf = (d) => FC.classOf(dayType(d, land, ctx.state.calendar || null));
  const pastDays = Object.keys(S0.days).filter(d => d <= today).sort();
  const usualOf = (day, h) => { const c = clsOf(day), v = [];
    for (let i = pastDays.length - 1; i >= 0 && v.length < 3; i--) { const d = pastDays[i]; if (d >= day || clsOf(d) !== c) continue; const a = (d === today && live ? live : seriesOf(S0, d, sel).a)?.[h]; if (a != null) v.push(a * fA(d, h)); }
    return v.length >= 2 ? [Math.min(...v), Math.max(...v)] : null; };
  const mk = (day, e, withLive) => Array.from({ length: 24 }, (_, h) => ({ day, h, p: nz(e.p?.[h], fP(day, h)), a: nz(e.a?.[h], fA(day, h)), l: withLive ? nz(e.l?.[h], fP(day, h)) : null, c: e.c?.[h] ?? null, u: usualOf(day, h) }));
  let rows, blocks, nowIdx = null, title;
  if (view === 'ahead') {
    rows = [...mk(T, eT, true), ...mk(TM, eM, true)];
    // Audit UXP-10: nach Mitternacht, bevor der erste Lauf des neuen Tags die Reihen fortschreibt, stimmt „Heute“ nicht – dann nur Datum
    blocks = stale ? [{ from: 0, to: 24, label: dayTxt(T) }, { from: 24, to: 48, label: dayTxt(TM) }] : [{ from: 0, to: 24, label: `${t('fv.today')} · ${dayTxt(T)}` }, { from: 24, to: 48, label: `${t('fv.tomorrow')} · ${dayTxt(TM)}` }];
    nowIdx = nowH < 24 ? nowH : null; title = t('fv.chartAhead');
  } else {
    const e = seriesOf(S0, view, sel); rows = mk(view, e, false); blocks = [{ from: 0, to: 24, label: dayTxt(view, { weekday: 'long', day: 'numeric', month: 'long' }) }]; title = t('fv.chartDay', { d: dayTxt(view) });
  }
  const scopeTxt = scopeLabel(ctx, sel);
  const segs = [['ahead', t('fv.todayTomorrow')], ...dayList.filter(d => d < T).slice(0, 4).map(d => [d, d === addDays(T, -1) ? t('fv.yesterday') : dayTxt(d, { weekday: 'short', day: 'numeric', month: 'numeric' })])];
  const noSeries = !sel.keys.length || (!eT.p && !eT.l && !eT.a);
  // Kacheln
  const prevA = seriesOf(S0, addDays(T, -1), sel).a, stT = dayStats({ p: eT.p, a: eT.a }, prevA);
  // Erwartung bis Tagesende: gezählte Stunden + für alle übrigen Stunden die Live-Prognose, wo es keine gibt der Plan
  const doneIst = eT.a ? sum(eT.a.filter(x => x != null)) : 0, planDay = eT.p ? sum(eT.p) : null, totalM = eM.l ? sum(eM.l) : eM.p ? sum(eM.p) : null;
  const expectDay = Array.from({ length: 24 }, (_, h) => eT.a?.[h] ?? eT.l?.[h] ?? eT.p?.[h] ?? 0).reduce((x, y) => x + y, 0);
  // Spitze je Tag (Audit UXP-08) aus den angezeigten Stundenwerten: gezählt, sonst Live-Prognose, sonst Plan
  const peakOf = (from, to) => { let bi = -1, bv = -1; for (let i = from; i < to; i++) { const r = rows[i], v = r?.a ?? r?.l ?? r?.p; if (v != null && v > bv) { bv = v; bi = i; } } return bi < 0 ? null : { i: bi, h: rows[bi].h, v: bv, src: rows[bi].a != null ? 'a' : rows[bi].l != null ? 'l' : 'p' }; };
  const peaks = view === 'ahead' ? [peakOf(0, 24), peakOf(24, 48)] : [peakOf(0, 24)];
  const pkTile = (pk, lbl) => tile(lbl, pk ? t('fv.kPeakV', { h: String(pk.h).padStart(2, '0'), h2: String((pk.h + 1) % 24).padStart(2, '0') }) : '–', pk ? t(pk.src === 'a' ? 'fv.kPeakSubA' : 'fv.kPeakSubF', { v: n0(pk.v), u: norm ? t('fv.perFullHour') : '' }) : t('fv.kNoPlan'));
  const tiles = noSeries ? '' : `<div class="tiles">${tile(t('fv.kSoFar'), n0(doneIst), stT ? t('fv.kSoFarSub', { plan: n0(stT.plan), d: sg(stT.bias, 1) }) : t('fv.kNoPlan'))}`
    + `${tile(t('fv.kErr'), stT ? pc(stT.wape) : '–', stT ? (stT.naive != null ? t('fv.kErrSub', { naive: pc(stT.naive), verdict: t(judge(stT.wape, stT.naive) === 'better' ? 'fv.gBetter' : judge(stT.wape, stT.naive) === 'worse' ? 'fv.gWorse' : 'fv.gEqual') }) : t('fv.kErrSub1', { n: stT.n })) : t('fv.kNoPlan'))}`
    + `${tile(t('fv.kDay'), n0(expectDay), planDay != null ? t('fv.kDaySub', { plan: n0(planDay), d: sg(planDay > 0 ? expectDay / planDay - 1 : null, 1) }) : t('fv.kNoPlan'))}`
    + `${tile(t('fv.kTomorrow'), totalM == null ? '–' : n0(totalM), totalM != null && expectDay > 0 ? t('fv.kTomorrowSub', { d: sg(totalM / expectDay - 1, 0) }) : t('fv.kNoPlan'))}`
    + (view === 'ahead' ? `${pkTile(peaks[0], stale ? t('fv.kPeakD', { d: dayTxt(T) }) : t('fv.kPeakToday'))}${pkTile(peaks[1], stale ? t('fv.kPeakD', { d: dayTxt(TM) }) : t('fv.kPeakTomorrow'))}` : pkTile(peaks[0], t('fv.kPeakD', { d: dayTxt(view) }))) + '</div>';
  const lead = noSeries ? `<div class="empty"><b>${t('fv.noScope')}</b>${esc(t('fv.noScopeHint'))}</div>` : '';
  const dataTable = noSeries ? '' : `<details class="fv-data"><summary>${t('fv.tableToggle')}</summary><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fv.tableToggle'))}"><table><thead><tr><th>${t('fv.colDay')}</th><th class="n">${t('fv.colHour')}</th><th class="n">${t('fv.colIst')}</th><th class="n">${t('fv.colPlan')}</th><th class="n">${t('fv.colLive')}</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(dayTxt(r.day))}</td><td class="n">${String(r.h).padStart(2, '0')}:00</td><td class="n">${n0(r.a)}</td><td class="n">${n0(r.p)}</td><td class="n">${n0(r.l)}</td></tr>`).join('')}</tbody></table></div></details>`;
  const notes = [sel.partial ? t('fv.nPartial') : '', sel.ignored ? t('fv.nIgnored') : '', S0.generatedAt ? t('fv.asOf', { time: dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(S0.generatedAt)) }) : ''].filter(Boolean).join(' ');
  const accRowsNow = accRows(S0, sel, G);
  el.innerHTML = topBar(ctx, sel, noSeries ? '' : `${csvBtn('series', t('fv.csvSeries'))}${accRowsNow.length ? csvBtn('days', t('fv.csvDays')) : ''}`)
    + `<div class="fv-grid"><div class="panel">${head(title, t('fv.chartSub'), `<span class="fv-scope">${t('fv.scope')}: <b>${esc(scopeTxt)}</b></span>`)}${gradeLine(ctx, S0, sel, G, L)}${stale ? `<p class="fv-stale warn-text">${esc(t('fv.staleDay', { time: S0.generatedAt ? dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(S0.generatedAt)) : '–' }))}</p>` : ''}${lead || ''}`
    + `<div class="fv-ctl"><div class="fv-tog" role="group" aria-label="${esc(t('fv.dayAria'))}">${segs.map(([v, l]) => `<button data-v="${esc(v)}" aria-pressed="${v === view}">${esc(l)}</button>`).join('')}</div>`
    + `<div class="fv-tog fv-norm" role="group" aria-label="${esc(t('fv.normAria'))}"><button data-n="1" aria-pressed="${norm}" title="${esc(t('fv.normTip'))}">${t('fv.normOn')}</button><button data-n="0" aria-pressed="${!norm}">${t('fv.normOff')}</button></div></div>`
    + (noSeries ? '' : `${tiles}<div class="fv-legend" style="margin-top:var(--s3)"><span><i class="k-a"></i>${t('fv.ist')}</span><span><i class="k-l"></i>${t('fv.live')}</span><span><i class="k-p"></i>${t('fv.plan')}</span>${rows.some(r => r.u) ? `<span title="${esc(t('fv.usualTip'))}"><i class="k-u"></i>${t('fv.usual')}</span>` : ''}${rows.some(r => r.c != null) ? `<span title="${esc(t('fv.chronosTip'))}"><i class="k-c"></i>${t('fv.chronos')}</span>` : ''}</div>${timeline(ctx, rows, { nowIdx: view === 'ahead' && !stale ? nowIdx : null, width: el.clientWidth - 40, blocks, peaks: peaks.filter(Boolean).map(p => p.i) })}<div class="fv-chart fv-wx"></div><div class="fv-sub">${t('fv.chartNote')} ${norm ? t('fv.normNote') : ''} ${esc(notes)}</div>${dataTable}`) + '</div>'
    + `${gradePanel(ctx, S0, sel, G, L)}${scopePanel(ctx, S0, sel, G, L)}`
    + `${eventsMainShell(ctx, sel)}${accuracyPanel(ctx, S0, sel, G, L)}${curvePanel(ctx, G, L, el.clientWidth - 40)}${learnPanel(ctx, L, G)}<p class="fv-sub">${t('fv.moreBasis')} <a href="#prognose-basis">${t('fv.segBasis')}</a>.</p></div>`;
  bindTop(el, ctx); bindDl(el, ctx, S0, L, G, sel);
  el.querySelectorAll('.fv-tog button[data-v]').forEach(b => b.addEventListener('click', () => { s.day = b.dataset.v; renderForecastView(el, ctx, { part: 'verlauf' }); }));
  el.querySelectorAll('.fv-norm button').forEach(b => b.addEventListener('click', () => { s.norm = b.dataset.n === '1'; try { localStorage.setItem('fv-norm', s.norm ? '1' : '0'); } catch {} renderForecastView(el, ctx, { part: 'verlauf' }); }));
  el.querySelector('.fv-gline a')?.addEventListener('click', (e) => { e.preventDefault(); el.querySelector('#fv-grade')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  if (!noSeries) fillWx(el.querySelector('.fv-wx'), ctx, rows, sel, el.clientWidth - 40);
  if (!noSeries) markEvents(el, ctx, rows, sel);
  fillEventsMain(el.querySelector('#fv-ev-main .fv-ev-body'), ctx, sel, S0);
  el.querySelector('[data-fv-csv="series"]')?.addEventListener('click', () => download(`prognose_stundenreihe_${fileTag(ctx, sel)}_${view === 'ahead' ? today : view}.csv`,
    [[t('fv.colScope'), t('fv.colDay'), t('fv.colHour'), t('fv.colIst'), t('fv.colPlan'), t('fv.colLive'), t('fv.chronos'), t('fv.colUsualLo'), t('fv.colUsualHi'), t('fv.colUnit')], ...rows.map(r => [scopeTxt, r.day, r.h, r.a == null ? null : [r.a, 1], r.p == null ? null : [r.p, 1], r.l == null ? null : [r.l, 1], r.c == null ? null : [r.c, 0], r.u ? [r.u[0], 1] : null, r.u ? [r.u[1], 1] : null, norm ? t('fv.normOn') : t('fv.normOff')])]));
  el.querySelector('[data-fv-csv="days"]')?.addEventListener('click', () => download(`prognose_tage_${fileTag(ctx, sel)}.csv`,
    [[t('fv.colScope'), t('fv.colDay'), t('fv.colIst'), t('fv.colPlan'), t('fv.colBias'), t('fv.colErr'), t('fv.colNaive'), t('fv.colSkill'), t('fv.colTrain')], ...accRowsNow.map(r => [scopeTxt, r.d, [r.ist, 0], [r.plan, 0], r.bias == null ? null : [r.bias, 4], r.wape == null ? null : [r.wape, 4], r.naive == null ? null : [r.naive, 4], r.skill == null ? null : [r.skill, 4], r.train])]));
}

// Wetter unter dem Stundendiagramm (gleiche x-Achse wie timeline: W, pl 40, pr 8): Temperatur und Niederschlag der Gemeinde bzw. Mittel aller Zellen
async function fillWx(box, ctx, rows, sel, width) {
  if (!box || !rows.length) return;
  const scope = sel.ags && sel.ags !== 'DE' ? sel.ags : null;
  const vals = await weatherFor(rows.map(r => [r.day, r.h]), scope, ctx.getJson, ctx.CFG.DATA);
  if (!box.isConnected) return;
  const svg = weatherSvg(vals, { W: Math.max(320, Math.min(1100, Math.round(width))), pl: 40, pr: 8, hours: rows.map(r => r.h), esc: ctx.esc });
  box.innerHTML = svg ? `${svg}<div class="fv-sub">${t('wx.legend', { scope: ctx.esc(scope ? (ctx.muniName?.(scope) || scope) : t('wx.scopeDE')) })}</div>` : `<div class="fv-sub">${t('wx.none')}</div>`;
}

async function renderSpotsPart(el, ctx, s, S0, L) {
  const sel = pickScope(S0, ctx.state);
  el.innerHTML = topBar(ctx, sel, csvBtn('spots', t('fv.csvSpots'), true)) + `<div class="fv-grid">${spotsPanelShell(ctx)}<p class="fv-sub">${t('fv.moreBasis')} <a href="#prognose-basis">${t('fv.segBasis')}</a>. ${t('fv.spotsElsewhere')} <a href="#spots">${t('app.spots')}</a> · <a href="#ops">${t('app.operations')}</a>.</p></div>`;
  bindTop(el, ctx);
  el.querySelector('[data-fv-csv="spots"]')?.addEventListener('click', () => {
    const R = s.rated; if (!R?.items?.length) return;
    const ags = s.ratedAgs || '', name = ctx.muniName?.(ags) || ags;
    download(`prognose_spots_${ags}_${(s.op || '').replace(/[^\w.-]+/g, '-')}.csv`, [[t('fv.colRank'), t('fv.colSpot'), t('fv.colKind'), t('fv.colClass'), t('fv.colImp'), t('fv.colExp'), t('fv.colTarget'), t('fv.colHave'), t('fv.colMissing'), t('fv.colLat'), t('fv.colLon'), t('fv.fOp'), t('fv.fArea')],
      ...R.items.map(x => [x.rank, x.label || '', x.kind === 'both' ? t('fv.kBoth') : x.kind === 'deploy' ? t('fv.kDeploy') : t('fv.kPark'), x.cls, [x.importance, 3], x.expected24 == null ? null : [x.expected24, 1], x.cls === 'D' ? null : [x.targetFc, 0], [x.have, 0], [x.missing, 0], [x.lat, 5], [x.lon, 5], s.op, name])]);
  });
  await paintSpots(el, ctx, s, S0, L, sel);
}

// ---------- Grundlagen & Kontrolle ----------
const n1v = (x) => (x == null || !Number.isFinite(x) ? '–' : numFmt(1).format(x));
const kv = (rows) => `<dl class="fv-kv">${rows.map(([k, v, sub]) => `<div><dt>${k}</dt><dd>${v}${sub ? `<small>${sub}</small>` : ''}</dd></div>`).join('')}</dl>`;
const tag = (k) => `<span class="fv-tag ${k}">${t(`fv.tag.${k}`)}</span>`;
const timeTxt = (iso) => (iso ? dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(iso)) : '–');

/** Selbstkontrollen: jede mit Ampel (ok / near / none) und einem Satz Begründung aus den Daten */
function checksOf(ctx, S0, L, G, race) {
  const { esc } = ctx, gates = { ...FC.GATES, ...(L.gates || {}) }, wg = L.weather?.gate || {}, out = [], add = (lvl, title, why) => out.push({ lvl, title, why });
  const age = S0.generatedAt ? (Date.now() - Date.parse(S0.generatedAt)) / 3600e3 : null;
  add(age == null ? 'none' : age <= 3 ? 'ok' : 'near', t('fv.cFresh'), age == null ? t('fv.cFreshNone') : t('fv.cFreshWhy', { time: timeTxt(S0.generatedAt), h: n1v(Math.max(0, age)) }));
  const nT = L.trainDays || 0, nE = L.evalDays || 0;
  add(nT >= gates.minTrainDays ? 'ok' : 'none', t('fv.cTrain'), t('fv.cTrainWhy', { n: nT, min: gates.minTrainDays }));
  add(nE >= gates.minEvalDays ? 'ok' : 'near', t('fv.cEval'), t('fv.cEvalWhy', { n: nE, min: gates.minEvalDays }));
  const act = race.find(r => r.m === L.active) || race.find(r => r.m === 'pooled'), nv = race.find(r => r.m === 'naive');
  if (act && nv) add(act.sc.v <= nv.sc.v ? 'ok' : 'near', t('fv.cNaive'), act.sc.v <= nv.sc.v ? t('fv.cNaiveOk', { model: modelName(act.m), a: pc(act.sc.v), n: pc(nv.sc.v) }) : t('fv.cNaiveBad', { model: modelName(act.m), a: pc(act.sc.v), n: pc(nv.sc.v) }));
  else add('none', t('fv.cNaive'), t('fv.cNaiveNone'));
  const models = race.filter(r => r.m !== 'naive'), best = models.slice().sort((a, b) => a.sc.v - b.sc.v)[0];
  if (best && act && best.m !== act.m && best.sc.v < act.sc.v - 0.005) add('near', t('fv.cBest'), t('fv.cBestBad', { best: modelName(best.m), b: pc(best.sc.v), act: modelName(act.m), a: pc(act.sc.v), min: gates.minEvalDays }));
  else if (best) add('ok', t('fv.cBest'), t('fv.cBestOk', { model: modelName(act?.m || best.m) }));
  add(L.weather?.used ? 'ok' : 'near', t('fv.cWx'), L.weather?.used ? t('fv.cWxOn') : t('fv.cWxOff', { range: n1v(wg.tempRangeK), need: gates.wxTempRangeK, rain: wg.rainDays ?? 0, dry: wg.dryDays ?? 0, n: gates.wxRainDays, miss: pc(wg.missingShare) }));
  const ex = L.excluded || 0;
  add(ex ? 'near' : 'ok', t('fv.cExcl'), ex ? t('fv.cExclWhy', { n: ex }) : t('fv.cExclNone'));
  const pl = S0.plans?.[S0.today], hasP = Object.values(S0.days?.[S0.today] || {}).some(e => e.p);
  add(pl ? 'ok' : hasP ? 'near' : 'none', t('fv.cPlan'), pl ? t('fv.cPlanWhy', { model: t(`fc.model.${pl.model}`), n: pl.trainDays, time: timeTxt(pl.at) }) : hasP ? t('fv.cPlanOld') : t('fv.cPlanNone'));
  const nl = (L.live || []).length;
  add(nl ? 'ok' : 'near', t('fv.cLive'), nl ? t('fv.cLiveWhy', { n: nl }) : t('fv.cLiveNone'));
  return `<ul class="fv-checks">${out.map(c => `<li>${badge(c.lvl, c.lvl === 'ok' ? '✓' : c.lvl === 'near' ? '!' : '–', esc(c.title))}<span class="why">${esc(c.why)}</span></li>`).join('')}</ul>`;
}

function renderBasisPart(el, ctx, s, S0, L, G) {
  const { esc } = ctx, sel = pickScope(S0, ctx.state), gates = { ...FC.GATES, ...(L.gates || {}) }, race = raceOf(G, L), ck = ctx.state.latest?.eventChecks || null;
  const checks = checksOf(ctx, S0, L, G, race), nGroups = Object.keys(L.groups || {}).length, nMuni = Object.keys(L.municipalities || {}).length, cal = ctx.state.calendar || null;
  const wg = L.weather?.gate || {}, evKeys = Object.keys(G?.evals || {}).sort();
  const files = ['latest', 'log', 'series'].map(f => `<a class="chip" href="${esc(`${ctx.CFG.DATA}${famFile(FAM, f)}`)}" target="_blank" rel="noopener">${esc(famFile(FAM, f))}</a>`).join('')
    + (L?.env?.sources?.days ? `<a class="chip" href="${esc(`${ctx.CFG.DATA}incidents/${FC.dayOfLocal(Date.now())}.json`)}" target="_blank" rel="noopener">incidents/${esc(FC.dayOfLocal(Date.now()))}.json</a>` : '')
    + (ctx.CFG?.REPO ? `<a class="chip" href="${esc(`https://github.com/${ctx.CFG.REPO}/blob/main/data/ereignisse.json`)}" target="_blank" rel="noopener">data/ereignisse.json</a>` : '');
  // Panel 1: Kontrollen
  const p1 = `<div class="panel">${head(t('fv.checksTitle'), t('fv.checksSub'))}${checks}</div>`;
  // Panel 2: Eingangsdaten und Herkunft der Pläne
  const prov = accRows(S0, sel, G, { withToday: true }).reverse();
  const provRows = prov.map(r => { const pl = S0.plans?.[r.d], odd = r.bias != null && Math.abs(r.bias) > 0.25;
    return `<tr><td>${esc(dayTxt(r.d))}${r.d === S0.today ? ` <span class="fv-chip B">${t('fv.today')}</span>` : ''}</td><td class="wrap">${pl ? `${esc(t(`fc.model.${pl.model}`))} · ${t('fv.provDays', { n: pl.trainDays })} · ${pl.retro ? t('fv.provRetro') : t('fv.provFrozen', { time: esc(timeTxt(pl.at)) })}` : '–'}</td><td class="n">${n0(r.ist)}</td><td class="n">${n0(r.plan)}</td><td class="n">${odd ? `<span class="fv-flag" title="${esc(t('fv.oddTip'))}">${sg(r.bias, 1)} ⚑</span>` : sg(r.bias, 1)}</td></tr>`; }).join('');
  const provTbl = prov.length ? `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.provTitle')}</h3><div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.provTitle'))}"><table><thead><tr><th>${t('fv.colDay')}</th><th>${t('fv.colPlanFrom')}</th><th class="n">${t('fv.colIst')}</th><th class="n">${t('fv.colPlan')}</th><th class="n">${t('fv.colBias')}</th></tr></thead><tbody>${provRows}</tbody></table></div><div class="fv-sub">${t('fv.provNote')} ${esc(t('fv.nScopeOf', { s: scopeLabel(ctx, sel) }))}</div>` : '';
  const p2 = `<div class="panel">${head(t('fv.inTitle'), t('fv.inSub'))}${kv([
    [t('fv.kvTrain'), n0(L.trainDays), t('fv.kvTrainSub')],
    [t('fv.kvEval'), n0(L.evalDays), evKeys.length ? evKeys.slice(-4).map(d => dayTxt(d, { day: 'numeric', month: 'numeric' })).join(', ') : t('fv.kvEvalNone')],
    [t('fv.kvGroups'), n0(nGroups), t('fv.kvGroupsSub', { m: n0(nMuni) })],
    [t('fv.kvExcl'), n0(L.excluded || 0), ck?.ruleNow ? t('fv.kvExclSub', { rule: esc(ck.ruleNow) }) : t('fv.kvExclSub0')],
    [t('fv.kvPhi'), n1v(L.phi), t('fv.kvPhiSub')],
    (() => { const d = evKeys.filter(x => G?.evals?.[x]?.expoErr != null).at(-1); const alt = d ? G.evals[d].expoErrAlt : null; return [t('fv.kvExpo'), d ? pc(G.evals[d].expoErr) : '–', d ? t('fv.kvExpoSub', { d: esc(dayTxt(d)) }) + (alt?.mean != null ? ` ${t('fv.kvExpoAlt', { c: pc(alt.class), m: pc(alt.mean) })}` : '') : t('fv.kvExpoNone')]; })(),
    [t('fv.kvWx'), esc(L.weather?.source || '–'), L.weather?.used ? t('fv.kvWxOn') : t('fv.kvWxOff', { range: n1v(wg.tempRangeK), rain: wg.rainDays ?? 0, dry: wg.dryDays ?? 0, miss: pc(wg.missingShare) })],
    [t('fv.kvCal'), cal?.source ? esc(cal.source) : t('fv.kvCalNone'), cal?.from ? `${esc(cal.from)} – ${esc(cal.to)}` : t('fv.kvCalFallback')],
    [t('fv.kvHorizon'), t('fv.kvHorizonV', { h: L.horizon?.hours ?? 24 }), L.horizon?.from ? t('fv.kvHorizonSub', { time: timeTxt(new Date(L.horizon.from).toISOString()), d: esc(L.horizon.tomorrow || '') }) : ''],
    [t('fv.kvStand'), timeTxt(L.generatedAt), t('fv.kvStandSub', { time: timeTxt(S0.generatedAt) })],
  ])}${provTbl}</div>`;
  // Panel 3: Modell
  const modelRows = [['profile', t('fv.mProfile')], ['pooled', t('fv.mPooled')], ['pooledWx', t('fv.mPooledWx')], ['adaptive', t('fv.mAdaptive', { hl: FC.FEEDBACK.halfLifeDays })], ['hybrid', t('fv.mHybrid', { k: FC.HYBRID.k, back: FC.HYBRID.maxBack })], ['blend', blendTxt(L)], ['chronos', t('fv.mChronos', { min: L?.external?.chronos?.minStarts ?? 20 })], ['naive', t('fv.mNaive')]];
  const p3 = `<div class="panel">${head(t('fv.modelTitle'), t('fv.modelSub'))}<code class="fv-formula">${esc(t('fv.formula'))}</code>`
    + `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.modelTitle'))}"><table style="margin-top:var(--s3)"><thead><tr><th>${t('fv.colModel')}</th><th>${t('fv.colWhat')}</th></tr></thead><tbody>${modelRows.map(([m, d]) => `<tr><td>${m === 'naive' ? t('fv.naive') : t(`fc.model.${m}`)}${m === L.active ? ` <span class="fv-chip B">${t('fv.activeTag')}</span>` : ''}</td><td class="wrap">${esc(d)}</td></tr>`).join('')}</tbody></table></div>`
    + `<p class="fv-sub">${esc(t('fv.chooseRule', { min: gates.minEvalDays, win: gates.evalWindow, gain: pc(gates.wxGain), again: pc(gates.adGain ?? FC.GATES.adGain), mt: gates.minEvalTrainDays ?? FC.GATES.minEvalTrainDays }))}</p>${L.reason ? `<p class="fv-sub">${t('fv.reasonNow')} <i>${esc(fcReason(L))}</i></p>` : ''}</div>`;
  // Panel 4: gemessen · abgeleitet · modelliert · vermutet
  const A = [
    ['derived', t('fv.aStarts'), t('fv.aStartsHow')], ['measured', t('fv.aExposure'), t('fv.aExposureHow')], ['external', t('fv.aDayType'), t('fv.aDayTypeHow')],
    ['external', t('fv.aWeather'), t('fv.aWeatherHow')], ['derived', t('fv.aEra'), t('fv.aEraHow')], ['modelled', t('fv.aPlan'), t('fv.aPlanHow')], ['modelled', t('fv.aWeight'), t('fv.aWeightHow', { hl: FC.FEEDBACK.halfLifeDays })], ['external', t('fv.aEnv'), t('fv.aEnvHow')], ['modelled', t('fv.aMem'), t('fv.aMemHow', { hl: FC.MEMORY.halfLifeDays })], ['modelled', t('fv.aBand'), t('fv.aBandHow')],
    ['assumed', t('fv.aDeploy'), t('fv.aDeployHow')], ['derived', t('fv.aPark'), t('fv.aParkHow')], ['modelled', t('fv.aDemand'), t('fv.aDemandHow')], ['assumed', t('fv.aShare'), t('fv.aShareHow')],
    ['rule', t('fv.aTarget'), t('fv.aTargetHow', { base: OPS.baseH, min: OPS.minPerSpot, max: OPS.maxPerSpot, h: OPS.horizonH })], ['measured', t('fv.aHave'), t('fv.aHaveHow', { r: OPS.spotRadiusM })],
    ['derived', t('fv.aMissing'), t('fv.aMissingHow')], ['rule', t('fv.aClasses'), t('fv.aClassesHow', { a: pc(SP.RATE.classA), b: pc(SP.RATE.classB) })],
  ];
  const last = LAST_RATED;
  const lastRow = last?.R?.items?.length ? `<p class="fv-sub">${t('fv.lastSpots', { n: n0(last.R.total.spots), d: n0(last.R.total.deploy), p: n0(last.R.total.park), b: n0(last.R.total.both), op: esc(last.op), m: esc(ctx.muniName?.(last.ags) || last.ags) })}</p>` : '';
  const p4 = `<div class="panel">${head(t('fv.assumeTitle'), t('fv.assumeSub'))}<div class="fv-legend" style="margin-top:var(--s2)">${['measured', 'derived', 'modelled', 'assumed', 'rule', 'external'].map(k => `<span>${tag(k)}</span>`).join('')}</div>`
    + `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.assumeTitle'))}"><table><thead><tr><th>${t('fv.colWhat')}</th><th>${t('fv.colKind')}</th><th>${t('fv.colHow')}</th></tr></thead><tbody>${A.map(([k, n, h]) => `<tr><td class="wrap"><b>${esc(n)}</b></td><td>${tag(k)}</td><td class="wrap">${esc(h)}</td></tr>`).join('')}</tbody></table></div>${lastRow}</div>`;
  // Panel 5: Parameter (aus dem Code, nicht frei einstellbar)
  const P = paramRows(L);

  const p5 = `<div class="panel">${head(t('fv.paramTitle'), t('fv.paramSub'))}<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.paramTitle'))}"><table><thead><tr><th>${t('fv.colParam')}</th><th class="n">${t('fv.colValue')}</th><th>${t('fv.colEffect')}</th></tr></thead><tbody>${P.map(([k, v, d]) => `<tr><td><code>${esc(k)}</code></td><td class="n">${esc(String(v))}</td><td class="wrap">${esc(d)}</td></tr>`).join('')}</tbody></table></div></div>`;
  // Panel 6: nicht berücksichtigt
  const NO = NOT_KEYS;
  const p6 = `<div class="panel">${head(t('fv.notTitle'), t('fv.notSub'))}<ul class="fv-list">${NO.map(k => `<li>${esc(t(`fv.${k}`))}</li>`).join('')}</ul><p class="fv-sub">${t('fv.notNote')}</p></div>`;
  // Panel 7: Rohdaten
  const p7 = `<div class="panel">${head(t('fv.rawTitle'), t('fv.rawSub'))}<div class="fv-links">${files}</div><p class="fv-sub">${t('fv.rawNote')}</p></div>`;
  const p9 = `<div class="panel" id="fv-env">${head(t('fv.envTitle'), t('fv.envSub'))}${envHtml(ctx, L, { title: false })}</div>`;
  const p10 = `<div class="panel" id="fv-events">${head(t('fv.evTitle'), t('fv.evSub'))}<div class="fv-ev-body"><p class="fv-sub">${t('fv.evLoading')}</p></div></div>`;
  const p8 = `<div class="panel" id="fv-dl">${head(t('fv.dlTitle'), t('fv.dlSub'))}${dlRow(false)}<p class="fv-sub">${t('fv.dlNote', { repo: esc(ctx.CFG?.REPO || '') })}</p></div>`;
  el.innerHTML = topBar(ctx, sel) + `<div class="fv-grid">${p1}${p2}${p3}${p9}${p10}${p8}${p4}${p5}${p6}${p7}</div>`;
  bindTop(el, ctx); bindDl(el, ctx, S0, L, G, sel);
  fillEvents(el.querySelector('#fv-events .fv-ev-body'), ctx, sel, S0);
}
// ---------- Veranstaltungen: eine Liste aus sport.json (Heimspiele, OpenLigaDB), veranstaltungen.json (Termine an Orten ab 5.000 Plätzen) und
// ereignisse.json (gepflegte Liste data/ereignisse.json, vom Sammler geprüft) – Zeitfenster wie in der Prognose (lib/pulse-context.js eventList) ----------
const loadEvents = (ctx) => memo(`events|${ctx.state?.latest?.at || ''}`, async () => {
  const [sp, vd, cu] = await Promise.all([fj(ctx, 'sport.json'), fj(ctx, 'veranstaltungen.json'), fj(ctx, 'ereignisse.json')]);
  return { list: CX.eventList({ sport: sp, venues: vd, curated: cu?.ereignisse || [], now: Date.now(), pastDays: 8, aheadDays: 430 }), sp, vd, cu };
});
const LIGA = { bl1: '1. Bundesliga', bl2: '2. Bundesliga', bl3: '3. Liga', del: 'DEL', dfb: 'DFB-Pokal', ucl: 'Champions League' };
const evWhen = (e, until = null) => {
  const d = (x, o) => dateFmt({ ...o, timeZone: TZ }).format(new Date(x)), day = { weekday: 'short', day: '2-digit', month: '2-digit' };
  if (until) return `${d(e.beginn, day)}–${d(CX.localMs(until), { day: '2-digit', month: '2-digit' })}`;
  return e.noTime ? `${d(e.beginn, day)} · ${t(e.noTime === 1 ? 'fv.evAllDay' : 'fv.evNoTime')}` : d(e.beginn, { ...day, hour: '2-digit', minute: '2-digit' });
};
const evKind = (e) => (e.src === 'sport' ? `${t('fv.evSport')} · ${LIGA[e.liga] || e.liga || ''}` : e.src === 'liste' ? `${e.kind ? t(`fv.evKind.${e.kind}`) : t('fv.evListe')}${e.auto ? ` · ${t('fv.evAuto')}` : ''}` : e.kind || t('fv.evVenue'));
const evWhat = (ctx, e) => (e.quelle && /^https?:/.test(e.quelle) && e.src !== 'sport' ? `<a href="${ctx.esc(e.quelle)}" target="_blank" rel="noopener">${ctx.esc(e.titel)}</a>` : ctx.esc(e.titel));
/** gleiche Veranstaltung an Folgetagen (Turnier, Messe) als eine Zeile */
function evRuns(list) {
  const out = [];
  for (const e of list) {
    const last = out[out.length - 1], k = `${e.src}|${e.titel}|${e.ort}|${e.ags[0] || ''}`;
    if (last && last.k === k && (e.noTime ? last.e.noTime : !last.e.noTime && e.von.slice(11) === last.e.von.slice(11)) && Date.parse(`${e.von.slice(0, 10)}T12:00:00Z`) - Date.parse(`${(last.until || last.e.von).slice(0, 10)}T12:00:00Z`) <= 86400e3) { last.until = e.von.slice(0, 10); last.days.push(e); continue; }
    out.push({ k, e, until: null, days: [e] });
  }
  return out;
}
/** Wirkung (Ist gegen Plan im Zeitfenster, bereinigt um den übrigen Tag) als Zelle */
function effCell(f) {
  if (!f) return '<span class="muted">–</span>';
  const cls = f.uplift >= 0.05 ? 'up' : f.uplift <= -0.05 ? 'down' : '', pct = (x) => (Math.round(Math.abs(x) * 100) === 0 ? '±0 %' : `${x >= 0 ? '+' : '−'}${n0(Math.abs(x) * 100)} %`);
  return `<span class="fv-eff ${cls}" title="${t('fv.evEffTip', { ist: n0(f.ist), plan: n0(f.plan), h: f.hours, rel: pct(f.rel), rest: f.rest == null ? '–' : pct(f.rest) })}">${pct(f.uplift)}</span>`;
}
const evEffect = (S0, e) => (e.ags.length === 1 ? CX.eventEffect(S0?.days, `ags:${e.ags[0]}`, e) : null);
const activeFromTxt = (cu, sp) => { const a = Date.parse(cu?.veranstaltungenAb || sp?.activeFrom || ''); return Number.isFinite(a) ? dateFmt({ day: 'numeric', month: 'numeric', year: 'numeric', timeZone: TZ }).format(new Date(a)) : '–'; };

function eventsMainShell(ctx, sel) {
  const where = sel.ags && sel.ags !== 'DE' ? (ctx.muniName?.(sel.ags) || sel.ags) : t('fc.scopeDE');
  return `<div class="panel" id="fv-ev-main">${head(t('fv.evMainTitle', { where: ctx.esc(where) }), t('fv.evMainSub'))}<div class="fv-ev-body"><p class="fv-sub">${t('fv.evLoading')}</p></div></div>`;
}
// Kurzfassung in der Prognose: was in den nächsten 14 Tagen ansteht (je Gebiet), was zuletzt war und wie stark es die Fahrten bewegt hat
async function fillEventsMain(box, ctx, sel, S0) {
  if (!box) return;
  const ev = await loadEvents(ctx); if (!box.isConnected) return;
  const { esc } = ctx, now = Date.now(), scope = sel.ags && sel.ags !== 'DE' ? sel.ags : null, list = (ev?.list || []).filter(e => CX.eventInScope(e, scope));
  const muni = (a) => ctx.muniName?.(a) || a || '–', known = (e) => !!e.ags[0] && muni(e.ags[0]) !== e.ags[0], withWhere = !scope;
  const endMs = (e) => e.endMs ?? CX.localMs(e.bis), big = (e) => e.src === 'liste' || (e.cap || 0) >= 10000 || ['bl1', 'ucl', 'dfb'].includes(e.liga);
  // ohne Gebiet: nur Gemeinden mit Sharing-Daten (Spielorte wie Sinsheim fallen sonst als Kennziffer auf)
  const upAll = list.filter(e => endMs(e) >= now && e.beginn <= now + 14 * 864e5 && (scope || known(e))), up = scope ? upAll : upAll.filter(e => big(e) && e.beginn <= now + 7 * 864e5);
  const past = list.filter(e => endMs(e) < now && e.beginn >= now - 7 * 864e5 && (scope || known(e))).reverse();
  // Zusammenfassung
  const runs = evRuns(upAll), nS = upAll.filter(e => e.src === 'sport').length, nO = runs.filter(r => r.e.src === 'ort').length, nL = runs.filter(r => r.e.src === 'liste').length;
  const top = runs.filter(r => r.e.cap).sort((a, b) => b.e.cap - a.e.cap)[0];
  const parts = [nS ? t(nS === 1 ? 'fv.evSumS1' : 'fv.evSumS', { n: n0(nS) }) : '', nO ? t('fv.evSumO', { n: n0(nO) }) : '', nL ? t('fv.evSumL', { n: n0(nL) }) : ''].filter(Boolean).join(', ');
  let html = `<p class="fv-ev-sum">${t(runs.length === 1 ? 'fv.evSum1' : 'fv.evSum', { n: `<b>${n0(runs.length)}</b>`, parts: parts ? ` (${parts})` : '' })}${top ? ` ${t('fv.evSumTop', { what: esc(top.e.titel), cap: n0(top.e.cap), when: esc(evWhen(top.e, top.until)) })}` : ''}</p>`;
  if (!scope) {
    const by = new Map(); for (const r of runs) { const a = r.e.ags[0]; if (a) by.set(a, (by.get(a) || 0) + 1); }
    const cities = [...by].sort((a, b) => b[1] - a[1]).slice(0, 14);
    if (cities.length) html += `<div class="fv-ev-cities" role="list" aria-label="${esc(t('fv.evCities'))}">${cities.map(([a, n]) => `<a role="listitem" class="chip" href="?scope=${esc(a)}#prognose">${esc(muni(a))} <b>${n0(n)}</b></a>`).join('')}</div>`;
  }
  // gemessene Wirkung über alle Städte (letzte 8 Tage), Median je Art – zeigt, was die Prognose ab der Freischaltung lernen kann
  { const grp = (e) => (e.src === 'sport' ? (e.liga === 'del' ? 'icehockey' : 'football') : e.src === 'ort' ? 'venue' : e.kind === 'volksfest' ? 'fair' : e.kind === 'messe' ? 'tradefair' : 'other');
    const by = new Map();
    for (const e of ev?.list || []) { if (e.ags.length !== 1 || !(endMs(e) < now) || e.beginn < now - 8 * 864e5) continue; const f = evEffect(S0, e); if (!f) continue; const g = grp(e); let a = by.get(g); if (!a) by.set(g, a = []); a.push(f.uplift); }
    const med = (a) => { const b = [...a].sort((x, y) => x - y), n = b.length; return (b[(n - 1) >> 1] + b[n >> 1]) / 2; }, pct = (x) => (Math.round(Math.abs(x) * 100) === 0 ? '±0 %' : `${x >= 0 ? '+' : '−'}${n0(Math.abs(x) * 100)} %`);
    const parts = ['football', 'icehockey', 'venue', 'tradefair', 'fair', 'other'].filter(g => (by.get(g) || []).length >= 3).map(g => t('fv.evEffPart', { what: t(`fv.evGrp.${g}`), eff: pct(med(by.get(g))), n: n0(by.get(g).length) }));
    if (parts.length) html += `<p class="fv-sub">${t('fv.evEffAll', { list: parts.join(' · ') })}</p>`; }
  const upRuns = evRuns(up);
  const upRow = (r) => `<tr><td>${esc(evWhen(r.e, r.until))}</td>${withWhere ? `<td>${esc(muni(r.e.ags[0]))}</td>` : ''}<td class="wrap">${evWhat(ctx, r.e)}</td><td class="mh">${esc(r.e.ort || (r.e.src === 'liste' ? (r.e.kind ? evKind(r.e) : '–') : evKind(r.e)))}</td><td class="n mh">${r.e.cap ? n0(r.e.cap) : '–'}</td></tr>`;
  const upHead = `<thead><tr><th>${t('fv.evColWhen')}</th>${withWhere ? `<th>${t('fv.evColWhere')}</th>` : ''}<th>${t('fv.evColWhat')}</th><th class="mh">${t('fv.evColVenue')}</th><th class="n mh">${t('fv.evColCap')}</th></tr></thead>`;
  html += `<div class="fv-ev-h">${t(scope ? 'fv.evNext' : 'fv.evNextBig')}</div>`;
  html += upRuns.length ? `<div class="tbl fv-tbl full" data-csv="0" tabindex="0" role="region" aria-label="${esc(t('fv.evNext'))}"><table>${upHead}<tbody>${upRuns.slice(0, 8).map(upRow).join('')}</tbody></table></div>${upRuns.length > 8 ? `<details class="fv-data"><summary>${t('fv.evMore', { n: upRuns.length - 8 })}</summary><div class="tbl fv-tbl full" data-csv="0"><table>${upHead}<tbody>${upRuns.slice(8).map(upRow).join('')}</tbody></table></div></details>` : ''}` : `<p class="fv-sub">${t('fv.evNoneNext')}</p>`;
  // zuletzt: gemessene Wirkung
  const pastRows = past.slice(0, scope ? 10 : 12).map(e => ({ e, f: evEffect(S0, e) }));
  html += `<div class="fv-ev-h">${t('fv.evPast')}</div>`;
  html += pastRows.length ? `<div class="tbl fv-tbl full" data-csv="0" tabindex="0" role="region" aria-label="${esc(t('fv.evPast'))}"><table><thead><tr><th>${t('fv.evColWhat')}</th><th class="n" title="${esc(t('fv.evColEffTip'))}">${t('fv.evColEff')}</th></tr></thead><tbody>${pastRows.map(({ e, f }) => `<tr><td class="wrap"><span class="lv">${evWhat(ctx, e)}</span><span class="lvs">${esc([evWhen(e), withWhere ? muni(e.ags[0]) : '', e.ort || evKind(e)].filter(Boolean).join(' · '))}</span></td><td class="n">${effCell(f)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="fv-sub">${t('fv.evNonePast')}</p>`;
  const later = list.filter(e => e.beginn > now + 14 * 864e5 && (scope || known(e)));
  if (later.length) html += `<p class="fv-sub">${t('fv.evLater', { n: n0(evRuns(later).length), d: esc(dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ }).format(new Date(later[later.length - 1].beginn))) })}</p>`;
  html += `<p class="fv-sub">${t('fv.evMainNote', { d: esc(activeFromTxt(ev?.cu, ev?.sp)) })} <a href="#prognose-basis">${t('fv.evAllLink')}</a></p>`;
  box.innerHTML = html;
}
// Veranstaltungen im Stundenverlauf: Band über den Stunden des Zeitfensters (wie es die Prognose sieht), Name oben, im Tooltip der Stunde
async function markEvents(el, ctx, rows, sel) {
  const svg = el.querySelector('.fv-chart svg[data-pl]'); if (!svg || !sel.ags || sel.ags === 'DE') return;
  const ev = await loadEvents(ctx); if (!svg.isConnected || !ev?.list?.length) return;
  const pl = +svg.dataset.pl, bw = +svg.dataset.bw, pt = +svg.dataset.pt, ph = +svg.dataset.ph, W = +svg.viewBox.baseVal.width;
  const st = rows.map(r => `${r.day}T${String(r.h).padStart(2, '0')}`), marks = [];
  for (const e of ev.list) {
    if (!CX.eventInScope(e, sel.ags) || e.all || e.laender.length) continue;
    const from = e.von.slice(0, 13); let i0 = -1, i1 = -1;
    st.forEach((s, i) => { if (s >= from && `${s}:00` < e.bis) { if (i0 < 0) i0 = i; i1 = i; } });
    if (i0 >= 0) marks.push({ e, i0, i1 });
  }
  if (!marks.length) return;
  marks.sort((a, b) => a.i0 - b.i0 || a.i1 - b.i1);
  let bands = '', labels = ''; const lanes = [];
  for (const m of marks) {
    const x0 = pl + m.i0 * bw, x1 = pl + (m.i1 + 1) * bw;
    bands += `<rect class="ev-band" x="${x0.toFixed(1)}" y="${pt}" width="${(x1 - x0).toFixed(1)}" height="${ph}"/><rect class="ev-bar" x="${x0.toFixed(1)}" y="${pt - 3}" width="${(x1 - x0).toFixed(1)}" height="3"/>`;
    const txt = m.e.titel.length > 26 ? `${m.e.titel.slice(0, 25)}…` : m.e.titel, w = txt.length * 6 + 6;
    let lane = lanes.findIndex(end => end <= x0); if (lane < 0 && lanes.length < 3) { lane = lanes.length; lanes.push(0); } if (lane < 0) continue;
    const x = Math.max(pl, Math.min(x0 + 3, W - w)); lanes[lane] = x + w;
    labels += `<text class="ev-t" x="${x.toFixed(1)}" y="${(pt + 12 + lane * 13).toFixed(1)}">${ctx.esc(txt)}</text>`;
  }
  svg.insertAdjacentHTML('afterbegin', bands);
  const firstHit = svg.querySelector('rect.hit'); if (firstHit) firstHit.insertAdjacentHTML('beforebegin', labels); else svg.insertAdjacentHTML('beforeend', labels);
  const hits = svg.querySelectorAll('rect.hit');
  for (const m of marks) for (let i = m.i0; i <= m.i1; i++) { const tt = hits[i]?.querySelector('title'); if (tt) tt.textContent += `\n◆ ${m.e.titel}${m.e.ort ? ` (${m.e.ort})` : ''}`; }
  el.querySelector('.fv-legend')?.insertAdjacentHTML('beforeend', `<span><i class="k-ev"></i>${t('fv.evMark')}</span>`);
}
// Grundlagen: vollständige Liste im gewählten Gebiet, 7 Tage zurück bis 14 Tage voraus, mit Quelle und gemessener Wirkung
let EV_RANGE = 14; // Grundlagen: Tage voraus (14, 90 oder 400 = alles)
async function fillEvents(box, ctx, sel, S0 = null) {
  if (!box) return;
  const ev = await loadEvents(ctx); if (!box.isConnected) return;
  const { esc } = ctx, now = Date.now(), scope = sel.ags && sel.ags !== 'DE' ? sel.ags : null, vd = ev?.vd, sp = ev?.sp;
  const list = (ev?.list || []).filter(e => e.beginn >= now - 7 * 864e5 && e.beginn <= now + EV_RANGE * 864e5 && CX.eventInScope(e, scope));
  const tog = `<div class="fv-ctl"><div class="fv-tog" role="group" aria-label="${esc(t('fv.evRange'))}">${[[14, t('fv.evR14')], [90, t('fv.evR90')], [400, t('fv.evRAll')]].map(([v, l]) => `<button type="button" data-evr="${v}" aria-pressed="${v === EV_RANGE}">${l}</button>`).join('')}</div></div>`;
  const nSrc = (vd?.quellen || []).length, okSrc = (vd?.quellen || []).filter(q => q.n > 0).length, nAuto = (ev?.cu?.ereignisse || []).filter(e => e.auto).length, nCur = (ev?.cu?.ereignisse || []).length - nAuto;
  const notes = [t('fv.evNote', { from: activeFromTxt(ev?.cu, sp) }), nSrc ? t('fv.evSrc', { ok: okSrc, n: nSrc }) : '', t('fv.evCur', { n: n0(nCur) }), nAuto ? t('fv.evAutoN', { n: n0(nAuto) }) : ''].filter(Boolean).join(' ');
  const shown = list.slice(0, EV_RANGE > 14 ? 400 : 80);
  box.innerHTML = tog + (shown.length ? `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.evTitle'))}"><table><thead><tr><th>${t('fv.evColWhen')}</th><th>${t('fv.evColWhere')}</th><th>${t('fv.evColWhat')}</th><th class="mh">${t('fv.evColVenue')}</th><th class="n">${t('fv.evColCap')}</th><th class="mh">${t('fv.evColKind')}</th><th class="n" title="${esc(t('fv.evColEffTip'))}">${t('fv.evColEff')}</th></tr></thead><tbody>`
    + shown.map(e => `<tr${e.beginn < now ? ' class="muted"' : ''}><td>${esc(evWhen(e))}</td><td>${esc(e.all ? t('fc.scopeDE') : e.laender.length ? e.laender.join(', ') : (ctx.muniName?.(e.ags[0]) || e.ags[0] || '–'))}</td><td class="wrap">${evWhat(ctx, e)}</td><td class="mh">${esc(e.ort || '–')}</td><td class="n">${e.cap ? n0(e.cap) : '–'}</td><td class="mh">${esc(evKind(e))}</td><td class="n">${e.beginn < now ? effCell(evEffect(S0, e)) : ''}</td></tr>`).join('')
    + `</tbody></table></div>` : `<p class="fv-sub">${t('fv.evNone')}</p>`) + `<p class="fv-sub">${list.length > shown.length ? `${t('fv.evMore', { n: list.length - shown.length })} ` : ''}${notes}</p>`;
  box.querySelectorAll('[data-evr]').forEach(b => b.addEventListener('click', () => { EV_RANGE = +b.dataset.evr; fillEvents(box, ctx, sel, S0); }));
}

function scopeLabel(ctx, sel) {
  const parts = [sel.ags && sel.ags !== 'DE' ? (ctx.muniName?.(sel.ags) || sel.ags) : t('fc.scopeDE'), sel.op && sel.op !== 'all' && !sel.ignored ? sel.op : null, sel.ty && sel.ty !== 'all' && !sel.ignored ? sel.ty : null].filter(Boolean);
  return parts.join(' · ');
}
/** Ist des heutigen Tags frisch aus events/<Tag>.json (Sammler-Lauf alle paar Minuten); null = Datei fehlt, dann gelten die Reihen aus series.json */
async function freshActual(ctx, S0, sel, today) {
  try {
    if (!ctx.loadEvents || !sel.keys.length) return null;
    const doc = await ctx.loadEvents(today); if (!doc?.groups) return null;
    const bad = new Set(Object.entries(ctx.state.latest?.eventChecks?.groups || {}).filter(([, g]) => g?.level === 'bad').map(([k]) => k));
    const groups = Object.fromEntries(Object.entries(doc.groups).filter(([k]) => !bad.has(k)));
    const D = FC.dayFromDoc({ ...doc, groups }, ctx.state.calendar || null), A = FC.actualOfDay(D), out = new Array(24).fill(null);
    for (const k of sel.keys) { const a = A.get(k); if (!a) continue; a.forEach((v, h) => { if (v != null) out[h] = (out[h] || 0) + v; }); }
    return out.some(x => x != null) ? { a: out, obs: D.hourMin } : null;
  } catch { return null; }
}
