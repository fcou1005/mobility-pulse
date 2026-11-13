// Mobility Pulse — Prognose (Ansicht) – Zustand, Reihen, Diagramm, Daten und Teile der Ansicht, gewähltes Gebiet (aus forecast.js geschnitten; forecast.js bleibt die Fassade für alle Importe).
import * as FC from './pulse-forecast.js';
import { decodeFleet, buildDemandModel } from './pulse-ops.js';
import { VEHICLE_TYPE_LABEL, familyOf } from './pulse-core.js';
import { t, tMap, dateFmt, numFmt, fcReason } from './i18n.js';
import { WX_CSS, resetWeatherCache } from './weather.js';
import { jChip, judge } from './forecast-parts.js';
import { scopeLabel } from './forecast-view.js';
import { MODEL, moreColor, seriesColor } from './tokens.js';
import { chartSpec, tableButton } from './charttip.js';

export const TZ = 'Europe/Berlin', DEMAND_DAYS = 7, SPOT_ROWS = 25;
const CACHE = new Map(), S = new WeakMap();
export let LAST_RATED = null; // zuletzt bewertete Spots (Anzeige in „Grundlagen & Kontrolle“)
export let FAM = 'micro'; // gewählte Fahrzeugfamilie der Prognose (alle drei Segmente)
export const setLastRated = (v) => { LAST_RATED = v; }, setFam = (v) => { FAM = v; }; // Schreibzugriffe aus anderen Teilen (ES-Module: Importe sind nur lesbar)
export const famNow = (ctx) => { const ty = ctx.state?.type; if (ty && ty !== 'all') FAM = familyOf(ty); return FAM; };
export const famFile = (fam, f) => `${FC.FAMILY_DIR[fam] || FC.FAMILY_DIR.micro}/${f}.json`;
export const st = (el) => { let s = S.get(el); if (!s) { s = { tok: 0, day: null, op: null, rows: SPOT_ROWS, map: null }; S.set(el, s); } return s; };
/** Zwischenspeicher leeren (neuer Sammler-Lauf) */
export function resetForecastCache() { CACHE.clear(); LAST_RATED = null; resetWeatherCache(); }
export const memo = (key, fn) => { if (!CACHE.has(key)) CACHE.set(key, Promise.resolve().then(fn).then(v => { if (v == null) CACHE.delete(key); return v; }, () => { CACHE.delete(key); return null; })); return CACHE.get(key); };
export const fj = (ctx, file) => { const at = ctx.state?.latest?.at || '', url = `${ctx.CFG.DATA}${file}${at ? `?t=${at}` : ''}`; return memo(url, async () => { const r = await ctx.getJson(url, { timeout: 60000 }); return r?.ok ? r.json : null; }); };

const CSS = `
.fv-root .fv-grid{display:grid;gap:var(--s4);grid-template-columns:minmax(0,1fr)}
.fv-lead{font-size:.875rem;line-height:1.5;max-width:80ch;margin:0 0 var(--s3)}
.fv-lead b{font-variant-numeric:tabular-nums}
.fv-ctl{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;margin:var(--s2) 0 var(--s3)}
.fv-ctl label{display:inline-flex;gap:6px;align-items:center;font-size:.75rem;color:var(--fg-2)}
.fv-tog{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:10px;background:var(--bg-2);border:1px solid var(--line)}
.fv-tog button{min-height:28px;border:0;background:transparent;color:var(--fg-2);padding:0 12px;border-radius:7px}
.fv-top .fv-fam{margin-right:var(--s2)}
.fv-tog button[aria-pressed="true"]{background:var(--thumb,var(--panel));color:var(--fg);box-shadow:inset 0 0 0 1px var(--line-2)}
.fv-scope{display:inline-flex;gap:6px;align-items:center;font-size:.75rem;color:var(--fg-2);padding:3px 10px;border:1px solid var(--line);border-radius:999px}
.fv-scope b{color:var(--fg);font-weight:600}
.fv-legend{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:.75rem;color:var(--fg-2);margin:0 0 var(--s2)}
.fv-legend i{display:inline-block;vertical-align:-2px;margin-right:6px}
.fv-legend .k-a{width:12px;height:12px;border-radius:2px;background:var(--accent)}
.fv-legend .k-l{width:12px;height:12px;border-radius:2px;background:color-mix(in srgb,var(--accent) 28%,transparent);border:1px dashed var(--accent)}
.fv-legend .k-p{width:18px;height:0;border-top:2.5px solid var(--info);margin-bottom:3px;vertical-align:middle}
.fv-legend .k-u{width:10px;height:10px;border:1px dashed color-mix(in srgb,var(--fg) 45%,transparent);box-sizing:border-box}.fv-gline{margin:var(--s2) 0 0;font-size:.875rem}.fv-gline a{font-weight:600;margin-left:4px}.fv-stale{margin:var(--s2) 0 0;font-size:.75rem}
.fv-legend .k-c{width:18px;height:0;border-top:2px dashed ${MODEL.chronos};margin-bottom:3px;vertical-align:middle}
.fv-legend .k-ev{width:12px;height:12px;border-radius:2px;background:color-mix(in srgb,var(--fg) 9%,transparent);border-top:3px solid var(--fg-2)}
.fv-chart .ev-band{fill:color-mix(in srgb,var(--fg) 7%,transparent)}.fv-chart .ev-bar{fill:var(--fg-2)}
.fv-chart text.ev-t{fill:var(--fg);font-size:10.5px;font-weight:600;paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round}
.fv-ev-sum{margin:0 0 var(--s3);font-size:.875rem;color:var(--fg-2)}.fv-ev-sum b{color:var(--fg)}
.fv-ev-cities{display:flex;flex-wrap:wrap;gap:var(--s1);margin:0 0 var(--s3)}
.fv-ev-h{margin:var(--s3) 0 var(--s1);font-size:.875rem;font-weight:600;color:var(--fg-2)}
.fv-eff{font-variant-numeric:tabular-nums;font-weight:600}.fv-eff.up{color:var(--ok)}.fv-eff.down{color:var(--bad)}
.fv-chart{width:100%;overflow:hidden}
.fv-chart svg{display:block;width:100%;height:auto;max-width:1100px}
.fv-chart text{fill:var(--fg-2);font-size:11px;font-family:var(--sans)}
.fv-chart .gl{stroke:var(--line);stroke-width:1}
.fv-chart .bar-a{fill:var(--accent)}.fv-chart .usual{fill:none;stroke:color-mix(in srgb,var(--fg) 45%,transparent);stroke-width:1;stroke-dasharray:2 2}.fv-chart text.pk{fill:var(--fg);font-size:10.5px;font-weight:600;paint-order:stroke;stroke:var(--panel);stroke-width:3px}
.fv-chart .bar-l{fill:color-mix(in srgb,var(--accent) 26%,transparent);stroke:var(--accent);stroke-width:1;stroke-dasharray:3 2}
.fv-chart .ln-p{fill:none;stroke:var(--info);stroke-width:2.2;stroke-linejoin:round}
.fv-chart .ln-c{fill:none;stroke:${MODEL.chronos};stroke-width:2;stroke-dasharray:5 3;stroke-linejoin:round}
.fv-chart .now{stroke:var(--fg-2);stroke-width:1.2;stroke-dasharray:3 3}
.fv-chart .mid{stroke:var(--line-2);stroke-width:1}
.fv-chart .dayl{font-weight:600;fill:var(--fg)}
.fv-chart rect.hit{fill:transparent}.fv-chart rect.hit:hover{fill:color-mix(in srgb,var(--fg) 7%,transparent)}
.fv-wx{margin-top:2px}.fv-wx svg{max-height:110px}
${WX_CSS}
.fv-gates{list-style:none;margin:var(--s3) 0 0;padding:0;display:grid;gap:var(--s2);grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.fv-gates li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px var(--s3);align-items:center;padding:var(--s2) var(--s3);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel-2)}
.fv-gates .gl{font-size:.75rem;color:var(--fg-2)}.fv-gates .gv{font-family:var(--sans);font-variant-numeric:tabular-nums;font-weight:600;text-align:right}
.fv-gates .gm{grid-column:1/-1;height:7px;border-radius:4px;background:var(--line);overflow:hidden}.fv-gates .gm span{display:block;height:100%;background:var(--warn);border-radius:4px}
.fv-gates li.ok .gm span{background:var(--ok)}
.fv-gates .gs{grid-column:1/-1;font-size:.75rem;color:var(--muted)}
.fv-st{display:inline-flex;align-items:flex-start;gap:8px;font-size:.875rem;font-weight:500}
.fv-st i{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;font:700 .75rem/1 var(--sans);font-style:normal;color:var(--panel);background:var(--muted);flex:none;margin-top:1px}
.fv-st.ok i{background:var(--ok)}.fv-st.near i{background:var(--warn)}.fv-st.none i{background:transparent;color:var(--fg-2);box-shadow:inset 0 0 0 1.5px var(--fg-2)}
.fv-bar{display:inline-block;height:9px;border-radius:3px;background:var(--accent);vertical-align:middle;min-width:2px}
.fv-bar.n{background:var(--muted);opacity:.7}
.fv-split{display:inline-block;width:72px;height:9px;border-radius:3px;background:color-mix(in srgb,var(--info) 35%,transparent);vertical-align:middle;overflow:hidden}
.fv-split i{display:block;height:100%;background:var(--accent)}
.fv-tbl td.bars{min-width:150px}.fv-tbl td.bars span.t{display:inline-block;min-width:3.6em;text-align:right;margin-right:6px;font-variant-numeric:tabular-nums}
.fv-chip{display:inline-flex;align-items:center;gap:4px;padding:0 8px;border-radius:999px;border:1px solid var(--line-2);font-size:.75rem;line-height:19px;white-space:nowrap}
.fv-chip.A{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 18%,transparent);font-weight:600}
.fv-chip.B{border-color:var(--accent)}
.fv-chip.D{color:var(--muted);border-style:dashed}
.fv-miss{font-weight:700;font-variant-numeric:tabular-nums}.fv-miss.z{font-weight:400;color:var(--muted)}
.fv-map{height:420px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-2);isolation:isolate;margin-top:var(--s3)}
.fv-keys{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:.75rem;color:var(--fg-2);margin-top:var(--s2)}
.fv-keys i{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.fv-link{all:unset;cursor:pointer;color:var(--fg);font-weight:500;text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:3px;border-radius:3px}
.fv-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fv-munis{display:flex;flex-wrap:wrap;gap:6px;margin-top:var(--s2)}
.fv-sub{font-size:.875rem;color:var(--fg-2);margin:var(--s2) 0 0;max-width:100ch}
details.fv-data{margin-top:var(--s3)}details.fv-data summary{cursor:pointer;font-size:.75rem;color:var(--fg-2)}
.fv-top{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin:0 0 var(--s4);padding:var(--s2) var(--s3);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel-2)}
.fv-top .lbl{font-size:.75rem;font-weight:500;color:var(--muted);margin-right:var(--s1)}
.fv-top .sp{flex:1 1 auto}.fv-top .hint{font-size:.75rem;color:var(--muted)}
.fv-pill{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 4px 0 11px;border:1px solid var(--line-2);border-radius:999px;font-size:.75rem;background:var(--panel);color:var(--fg-2)}
.fv-pill b{font-weight:600;color:var(--fg)}
.fv-pill.dim{padding-right:11px;border-style:dashed;color:var(--muted)}.fv-pill.dim b{font-weight:500;color:var(--fg-2)}
.fv-pill.ign b{text-decoration:line-through}
.fv-pill button{all:unset;cursor:pointer;width:22px;height:22px;border-radius:50%;display:inline-grid;place-items:center;color:var(--fg-2);font-size:.875rem;line-height:1}
.fv-pill button:hover{background:var(--line)}.fv-pill button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.fv-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:0 var(--s5);margin:var(--s3) 0 0}
.fv-kv>div{padding:var(--s2) 0;border-top:1px solid var(--line)}
.fv-kv dt{font-size:.75rem;color:var(--muted)}.fv-kv dd{margin:2px 0 0;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.fv-kv dd small{display:block;font-weight:400;font-size:.75rem;line-height:1.4;color:var(--fg-2);margin-top:2px}
.fv-checks{list-style:none;margin:var(--s3) 0 0;padding:0;display:grid;gap:var(--s2);grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))}
.fv-checks li{padding:var(--s2) var(--s3);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel-2)}
.fv-checks .why{display:block;font-size:.75rem;line-height:1.45;color:var(--fg-2);margin:3px 0 0 26px}
.fv-tag{display:inline-block;padding:0 8px;border-radius:999px;font-size:.75rem;line-height:19px;border:1px solid var(--line-2);white-space:nowrap;color:var(--fg)}
.fv-tag.measured{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 15%,transparent)}
.fv-tag.derived{border-color:var(--info);background:color-mix(in srgb,var(--info) 14%,transparent)}
.fv-tag.modelled{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}
.fv-tag.assumed{border-color:var(--warn);background:color-mix(in srgb,var(--warn) 18%,transparent);font-weight:600}
.fv-tag.rule,.fv-tag.external{color:var(--fg-2)}.fv-tag.external{border-style:dashed}
.fv-formula{display:block;white-space:pre-wrap;margin:var(--s3) 0 0;padding:var(--s3);background:var(--bg-2);border:1px solid var(--line);border-radius:var(--r-sm);font-family:var(--mono);font-size:.75rem;line-height:1.55;overflow-x:auto}
.fv-tbl.full{max-height:none}.fv-tbl td.wrap{white-space:normal;min-width:22ch}.fv-tbl td code{font-family:var(--mono);font-size:.75rem}
.fv-links{display:flex;flex-wrap:wrap;gap:var(--s2);margin-top:var(--s3)}
.fv-flag{color:var(--fg);font-weight:600}
.fv-list{margin:var(--s3) 0 0;padding-left:1.2em;display:grid;gap:var(--s1);max-width:100ch}
.fv-verdict{display:flex;gap:10px;align-items:flex-start;font-size:1rem;line-height:1.5;max-width:95ch;margin:0}
.fv-verdict i{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;font:700 .875rem/1 var(--sans);font-style:normal;color:var(--panel);background:var(--muted);flex:none;margin-top:2px}
.fv-verdict.ok i{background:var(--ok)}.fv-verdict.near i{background:var(--warn)}.fv-verdict.bad i{background:var(--bad)}
.fv-verdict b{font-weight:600}
.fv-verdict-in{white-space:normal}.fv-verdict-in i{display:inline-grid;place-items:center;width:1.25em;height:1.25em;border-radius:50%;font:700 .75em/1 var(--sans);font-style:normal;color:var(--panel);background:var(--muted);vertical-align:.1em}
.fv-verdict-in.ok i{background:var(--ok)}.fv-verdict-in.near i{background:var(--warn)}.fv-verdict-in.bad i{background:var(--bad)}
.fv-j{display:inline-block;padding:0 9px;border-radius:999px;font-size:.75rem;line-height:21px;font-weight:600;white-space:nowrap;border:1px solid var(--line-2);color:var(--fg-2)}
.fv-j.better{color:var(--ok);border-color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.fv-j.worse{color:var(--bad);border-color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent)}
.fv-tbl td .lv{display:block;font-weight:500;color:var(--fg)}.fv-tbl td .lvs{display:block;font-size:.75rem;line-height:1.35;color:var(--muted);white-space:normal}
.fv-dl{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin-top:var(--s3);font-size:.75rem;color:var(--fg-2)}
.fv-curve svg{display:block;width:100%;height:auto;max-width:1100px}
.fv-curve text{fill:var(--fg-2);font-size:11px;font-family:var(--sans)}
.fv-curve .gl{stroke:var(--line);stroke-width:1}
.fv-curve path{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.fv-curve path.act{stroke-width:3.4}.fv-curve path.nv{stroke-dasharray:5 4}
.fv-keys2{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:.75rem;color:var(--fg-2);margin:var(--s3) 0 var(--s2)}
.fv-keys2 i{display:inline-block;width:18px;height:0;border-top:3px solid;margin-right:6px;vertical-align:middle}.fv-keys2 i.nv{border-top-style:dashed}
.fv-keys2 b{font-weight:600;color:var(--fg)}
.fv-tbl .m-only{display:none}
.fv-tbl .v2+.v2::before{content:', '}
@media (max-width:640px){.fv-tbl .v2{display:block}.fv-tbl .v2+.v2::before{content:''}.fv-tbl .mh{display:none}.fv-tbl .m-only{display:block;margin-top:5px}.fv-tbl td.bars .fv-bar{display:none}.fv-tbl td.bars{min-width:0}.fv-tbl td.bars span.t{min-width:0;margin:0}.fv-verdict{font-size:.875rem}}
`;
let cssDone = false;
export const css = () => { if (cssDone || typeof document === 'undefined') return; cssDone = true; const s = document.createElement('style'); s.id = 'fv-style'; s.textContent = CSS; document.head.appendChild(s); };

export const n0 = (x) => (x == null || !Number.isFinite(x) ? '–' : numFmt(0).format(x));
export const n1 = (x) => (x == null || !Number.isFinite(x) ? '–' : numFmt(1).format(x));
export const pc = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${numFmt(d).format(x * 100)} %`);
export const sg = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${numFmt(d).format(Math.abs(x) * 100)} %`);
const fK = (v) => (v >= 10000 ? `${n0(v / 1000)}k` : v >= 1000 ? `${numFmt(v % 1000 === 0 ? 0 : 1).format(v / 1000)}k` : n0(v));
export const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
export const dayTxt = (d, o = { weekday: 'short', day: 'numeric', month: 'short' }) => dateFmt({ ...o, timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
export const berlinNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, h: +p.hour }; };

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
export function timeline(ctx, rows, { nowIdx = null, width = 720, blocks = [], peaks = [] } = {}) {
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
  const sepAndDays = blocks.map((b, k) => `${k ? `<line class="mid" x1="${x(b.from).toFixed(1)}" x2="${x(b.from).toFixed(1)}" y1="${pt}" y2="${H - pb}"/>` : ''}<text class="dayl" x="${(x(b.from) + (b.to - b.from) * bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${ctx.esc(b.label)}</text>`).join('');
  const now = nowIdx != null ? `<line class="now" x1="${x(nowIdx).toFixed(1)}" x2="${x(nowIdx).toFixed(1)}" y1="${pt - 6}" y2="${H - pb}"/><text x="${(x(nowIdx) + 4).toFixed(1)}" y="${pt - 6}">${ctx.esc(t('fv.now'))}</text>` : '';
  const total = sum(rows.map(r => r.a ?? r.l ?? 0));
  // S4.5: Werte je Stunde im gemeinsamen Hover-Layer (web/charttip.js) statt <title> auf 5-px-Flächen; ganze Stundenbreite trifft
  const dayOf = (i) => blocks.find(b => i >= b.from && i < b.to)?.label || '', obs = (r) => (r.a != null ? n0(r.a) : r.l != null ? n0(r.l) : t('fv.notObserved'));
  const fsp = chartSpec({ n: rows.length, x: (i) => x(i) + bw / 2, top: pt, bottom: H - pb, head: (i) => `${dayOf(i) ? `${dayOf(i)}, ` : ''}${String(rows[i].h).padStart(2, '0')}:00`, label: t('fv.chartAria', { total: n0(total) }), colHead: t('ct.hourCol'),
    cols: [t('fv.ist'), t('fv.plan'), t('fv.chronos'), t('fv.usual')], cell: (i, k) => { const r = rows[i]; return [obs(r), r.p == null ? '–' : n0(r.p), r.c == null ? '–' : n0(r.c), r.u ? `${n0(r.u[0])}–${n0(r.u[1])}` : '–'][k]; },
    rows: (i) => { const r = rows[i]; return [{ color: 'var(--accent)', label: r.a != null ? t('fv.ist') : t('fv.live'), value: obs(r), sort: 4 }, ...(r.p != null ? [{ color: 'var(--info)', label: t('fv.plan'), value: n0(r.p), sort: 3 }] : []), ...(r.c != null ? [{ color: MODEL.chronos, label: t('fv.chronos'), value: n0(r.c), sort: 2 }] : []), ...(r.u ? [{ label: t('fv.usual'), value: `${n0(r.u[0])}–${n0(r.u[1])}`, sort: 1 }] : [])]; } });
  return `<div class="fv-chart"><svg viewBox="0 0 ${W} ${H}" data-pl="${pl}" data-bw="${bw}" data-pt="${pt}" data-ph="${H - pt - pb}" role="img" ${fsp.attrs} aria-label="${ctx.esc(t('fv.chartAria', { total: n0(total) }))}">${grid}${usual}${bars}${peakTxt}<path class="ln-p" d="${d}"/>${dc ? `<path class="ln-c" d="${dc}"/>` : ''}${now}${sepAndDays}${labels}</svg>${tableButton(fsp.id)}</div>`;
}

// ---------- Daten für die Spots ----------
export const loadFleet = (ctx, land) => memo(`ops/${land}`, async () => { const r = await ctx.getJson(`${ctx.CFG.DATA}ops/${land}.json`, { timeout: 90000 }); return r?.ok && r.json ? decodeFleet(r.json) : null; });
export const loadDemand = (ctx, land, ags) => memo(`cells/${land}/${ags}`, async () => {
  const idx = await ctx.loadUsageIndex(); const days = (idx?.cellDays || []).slice(-DEMAND_DAYS); if (!days.length) return { model: null };
  const docs = (await Promise.all(days.map(d => ctx.loadCells(d, land)))).filter(Boolean), model = docs.length ? buildDemandModel(docs, ags, 'day') : null;
  return { model: model?.hours > 0 ? model : null };
});
export const loadGroups = (ctx) => memo('groups', async () => {
  const idx = await ctx.getJson(`${ctx.CFG.DATA}groups/index.json`, { timeout: 30000 });
  if (idx?.ok && Array.isArray(idx.json?.months)) { const docs = (await Promise.all(idx.json.months.map(async m => { const r = await ctx.getJson(`${ctx.CFG.DATA}groups/${m}.json`, { timeout: 60000 }); return r?.ok && Array.isArray(r.json?.events) ? r.json : null; }))).filter(Boolean); return { docs }; }
  const r = await ctx.getJson(`${ctx.CFG.DATA}groups.json`, { timeout: 60000 }); return { docs: r?.ok && Array.isArray(r.json?.events) ? [r.json] : [] };
});

// ---------- Teile der Ansicht ----------
export const tile = (l, v, s, cls = '') => `<div class="tile ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
export const head = (title, sub, right = '') => `<div class="panel-head"><div><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right}</div>`;
export const badge = (cls, ico, txt) => `<span class="fv-st ${cls}"><i aria-hidden="true">${ico}</i>${txt}</span>`;

export function learnPanel(ctx, L, G) {
  const gates = L.gates || {}, wg = L.weather?.gate || {}, minT = gates.minTrainDays ?? 2, minE = gates.minEvalDays ?? 3, wk = gates.wxTempRangeK ?? 5, wd = gates.wxRainDays ?? 2;
  const row = (label, have, need, unit, sub) => { const ok = have >= need; return `<li class="${ok ? 'ok' : ''}"><span class="gl">${label}</span><span class="gv">${unit === 'K' ? n1(have) : n0(have)} / ${n0(need)}${unit ? ` ${unit}` : ''} ${ok ? '✓' : ''}</span><span class="gm"><span style="width:${Math.min(100, Math.round(have / need * 100))}%"></span></span>${sub ? `<span class="gs">${sub}</span>` : ''}</li>`; };
  const status = L.status === 'active' ? badge('ok', '✓', ctx.esc(t('fv.stActive', { model: t(`fc.model.${L.active}`) })))
    : L.status === 'learning' ? badge('near', '!', ctx.esc(t('fv.stLearning', { n: L.evalDays || 0, min: minE })))
    : L.status === 'small' ? badge('near', '!', ctx.esc(t(L.active ? 'fv.stSmallWeek' : 'fv.stSmall', { n: Math.round(L.volume ?? 0), min: L.minVolume ?? FC.MIN_VOLUME.moped }))) // S2.6
    : badge('none', '–', ctx.esc(t('fv.stInsufficient', { n: L.trainDays || 0, min: minT })));
  const need = Math.max(0, minE - (L.evalDays || 0)), until = L.status === 'learning' && need > 0 && L.generatedAt ? dayTxt(addDays(L.generatedAt.slice(0, 10), need), { day: 'numeric', month: 'long' }) : null;
  const wxOn = L.weather?.used;
  return `<div class="panel">${head(t('fv.learnTitle'), t('fv.learnSub'), allTag(ctx))}<p style="margin:0">${status}</p>${until ? `<p class="fv-sub">${t('fv.activeFrom', { date: ctx.esc(until) })}</p>` : ''}`
    + `<ul class="fv-gates">${row(t('fv.gTrain'), L.trainDays || 0, minT, '', t('fv.gTrainSub'))}${row(t('fv.gEval'), L.evalDays || 0, minE, '', t('fv.gEvalSub'))}${row(t('fv.gTemp'), wg.tempRangeK || 0, wk, 'K', t('fv.gTempSub'))}${row(t('fv.gRain'), Math.min(wg.rainDays || 0, wg.dryDays || 0), wd, '', `${t('fv.gRainSub', { rain: wg.rainDays || 0, dry: wg.dryDays || 0 })}`)}</ul>`
    + `<p class="fv-sub">${wxOn ? t('fv.wxOn') : t('fv.wxOff')}</p></div>`;
}

/** Tage mit Plan und Ist (abgeschlossene Tage; mit withToday auch der laufende) für die gewählten Reihen */
export function accRows(S0, sel, G, { withToday = false } = {}) {
  const days = Object.keys(S0.days).filter(d => (withToday ? d <= S0.today : d < S0.today)).sort().slice(-7), rows = [];
  for (const d of days) { const e = seriesOf(S0, d, sel), prev = seriesOf(S0, addDays(d, -1), sel), s = dayStats(e, prev.a), c = e.c ? dayStats({ p: e.c, a: e.a }) : null; if (s) rows.push({ d, ...s, chronos: c?.wape ?? null, train: G?.evals?.[d]?.trainDays ?? null }); }
  return rows;
}
/** Mittlere Kennzahlen je Modell über die letzten ausgewerteten Tage (Selbstprüfung aus log.json); sc = Wertung (Tag und Stunde je Gruppe), nach der gewählt wird */
// 80-%-Band als Häufigkeit (Laien lesen Intervalle als harte Grenzen): Soll „etwa 8 von 10“, dazu die letzte bewertete Trefferquote
const bandFreq = (live) => { const x = (live || []).find(r => Number.isFinite(r?.cover80)); return x ? ` ${t('fv.bandFreq', { k: Math.round(x.cover80 * 10) })}` : ''; };
export const MODEL_ORDER = ['hybrid', 'blend', 'adaptive', 'pooled', 'pooledWx', 'profile', 'chronos', 'naive', 'week'];
// S4.6: Modelle als Reihen ohne Anbieter – Plätze der Palette MP-7 der Reihe nach, Vergleichsgrößen („wie gestern“, Vorwoche) grau; keine Statusfarben
export const MODEL_COLOR = { get hybrid() { return seriesColor(0); }, get blend() { return seriesColor(1); }, get adaptive() { return seriesColor(2); }, get pooled() { return seriesColor(3); }, get pooledWx() { return seriesColor(4); }, get profile() { return seriesColor(5); }, get chronos() { return seriesColor(6); }, get naive() { return moreColor(); }, get week() { return moreColor(); } };
export const modelName = (m) => (m === 'naive' ? t('fv.naive') : m === 'week' ? t('fv.week') : t(`fc.model.${m}`));
// Mischung Chronos/Hybrid: Stichtag und was bisher gelernt ist (latest.blend)
export const blendTxt = (L) => { const b = L?.blend, x = b?.learn, from = b?.activeFrom ? dayTxt(b.activeFrom.slice(0, 10), { day: 'numeric', month: 'long', year: 'numeric' }) : '–';
  return `${t('fv.mBlend', { from })}${x ? ` ${t('fv.blendShare', { pct: pc(x.ownShare), days: n1(x.days), n: n0(x.judged) })}` : ''}`; };
export const mature = (G, d) => !(G?.evals?.[d]?.trainDays < (FC.GATES.minEvalTrainDays ?? 0)); // wie chooseModel: unreife Starttage zählen nicht
export function raceOf(G, L) {
  const ev = G?.evals || {}, evDays = Object.keys(ev).sort().filter(d => mature(G, d)).slice(-(L?.gates?.evalWindow ?? FC.GATES.evalWindow));
  const avg = (m, f) => { const v = evDays.map(d => f(ev[d]?.models?.[m])).filter(x => x != null); return v.length ? { v: sum(v) / v.length, n: v.length } : null; };
  return MODEL_ORDER.map(m => ({ m, sc: avg(m, FC.scoreOf), gd: avg(m, x => x?.wapeGD), gh: avg(m, x => x?.wapeGH), bias: avg(m, x => x?.bias), cov: avg(m, x => x?.cover80) })).filter(r => r.sc);
}
/** Welche Prognose wird veröffentlicht? Live-Rennen aller Kandidaten (Schattenprognosen) und Selbstprüfung, je relativ zu „wie gestern“ */
function decisionHtml(ctx, L, G) {
  const D = L?.decision, rule = D?.rule || FC.DECIDE, f2 = (x) => (x == null ? '–' : `×${numFmt(2).format(x)}`);
  const recs = Object.values(G?.live || {}).filter(x => x?.v >= 2 && x.models?.naive?.w > 0);
  const evals = G?.evals || {}, days = Object.keys(evals).sort().filter(d => !(evals[d]?.trainDays < FC.GATES.minEvalTrainDays)).slice(-FC.GATES.evalWindow);
  const selfRel = (m) => FC.selfRelative(evals, m, days)?.r ?? null; // S2.2: gegen die bessere Basis, Summenverhältnis (wie lib)
  const pkOf = (m) => { const v = recs.map(x => x.models?.[m]?.peak?.hit1).filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
  const t3Of = (m) => { const v = recs.map(x => x.models?.[m]?.peak?.top3).filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
  const ms = [...MODEL_ORDER.filter(m => m !== 'naive'), 'naive', 'week'].filter(m => D?.live?.[m] || selfRel(m) != null || D?.combined?.[m]);
  if (!ms.length) return `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:.875rem">${t('fv.decTitle')}</h3><p class="fv-sub">${t('fv.decRule', { min: rule.liveMin, k: rule.liveK, hl: rule.halfLifeDays, gain: pc(rule.switchGain), base: rule.baseMin })}</p>`;
  const dmTxt = (m) => { const x = D?.dm?.[m]; return x ? `<div class="sub-line">${x.ok ? t('fv.dmOk', { p: numFmt(2).format(x.p), n: x.n }) : t('fv.dmLocked', { n: x.n, min: FC.DM.minDays })}</div>` : ''; };
  const rows = ms.map(m => { const lv = D?.live?.[m], c = D?.combined?.[m], sr = selfRel(m);
    return `<tr><td>${ctx.esc(m === 'week' ? t('fv.week') : modelName(m))}${m === L?.active ? ` <span class="fv-chip B">${t('fv.activeTag')}</span>` : ''}${dmTxt(m)}</td><td class="n">${f2(c?.r ?? (D?.combined ? null : sr))}</td><td class="n">${f2(lv?.r ?? null)}</td><td class="n mh">${lv ? n0(lv.n) : '–'}</td><td class="n mh">${f2(sr)}</td><td class="n mh">${c ? pc(c.w) : '–'}</td><td class="n mh">${pkOf(m) == null ? '–' : pc(pkOf(m))}</td><td class="n mh">${t3Of(m) == null ? '–' : pc(t3Of(m))}</td></tr>`; }).join('');
  return `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:.875rem">${t('fv.decTitle')}</h3><div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.decTitle'))}"><table><thead><tr><th>${t('fv.colModel')}</th><th class="n">${t('fv.decColAll')}</th><th class="n">${t('fv.decColLive')}</th><th class="n mh">${t('fv.decColN')}</th><th class="n mh">${t('fv.decColSelf')}</th><th class="n mh">${t('fv.decColW')}</th><th class="n mh">${t('fv.colPeak1')}</th><th class="n mh">${t('fv.colTop3')}</th></tr></thead><tbody>${rows}</tbody></table></div><div class="fv-sub">${t('fv.decRule', { min: rule.liveMin, k: rule.liveK, hl: rule.halfLifeDays, gain: pc(rule.switchGain), base: rule.baseMin })}</div>${L?.reason || L?.decision?.why ? `<div class="fv-sub">${t('fv.reasonNow')} <i>${ctx.esc(fcReason(L))}</i></div>` : ''}`;
}
export function accuracyPanel(ctx, S0, sel, G, L) {
  const rows = accRows(S0, sel, G);
  const maxW = Math.max(0.01, ...rows.map(r => Math.max(r.wape, r.naive ?? 0)));
  const body = rows.length ? rows.slice().reverse().map(r => `<tr><td>${ctx.esc(dayTxt(r.d))}</td><td class="n mh">${n0(r.ist)}</td><td class="n mh">${n0(r.plan)}</td><td class="n mh">${sg(r.bias, 1)}</td>`
    + `<td class="n bars"><span class="t">${pc(r.wape)}</span><span class="fv-bar" style="width:${Math.round(r.wape / maxW * 110)}px"></span></td><td class="n bars"><span class="t">${pc(r.naive)}</span>${r.naive == null ? '' : `<span class="fv-bar n" style="width:${Math.round(r.naive / maxW * 110)}px"></span>`}</td><td class="n mh">${r.chronos == null ? '–' : pc(r.chronos)}</td><td class="n mh">${r.skill == null ? '–' : sg(r.skill)}</td><td class="n mh">${r.train == null ? '–' : n0(r.train)}</td></tr>`).join('') : '';
  const table = rows.length ? `<div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.accTitle'))}"><table><thead><tr><th>${t('fv.colDay')}</th><th class="n mh">${t('fv.colIst')}</th><th class="n mh">${t('fv.colPlan')}</th><th class="n mh">${t('fv.colBias')}</th><th class="n">${t('fv.colErr')}</th><th class="n">${t('fv.colNaive')}</th><th class="n mh" title="${ctx.esc(t('fv.colChronosTip'))}">${t('fv.chronos')}</th><th class="n mh">${t('fv.colSkill')}</th><th class="n mh">${t('fv.colTrain')}</th></tr></thead><tbody>${body}</tbody></table></div>`
    : `<div class="empty"><b>${t('fv.accNone')}</b>${t('fv.accNoneHint')}</div>`;
  const live = (L?.live || []).slice(-6).reverse(), pk1 = (x) => (x?.peak?.hit1 == null ? '–' : pc(x.peak.hit1)), mdl = (x) => (x.model ? ctx.esc(modelName(x.model)) : '–');
  const liveHtml = live.length ? `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:.875rem">${t('fv.liveTitle')}</h3><div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.liveTitle'))}"><table><thead><tr><th>${t('fv.colIssued')}</th><th class="mh">${t('fv.colModel')}</th><th class="n">${t('fv.colErrOp')}</th><th class="n">${t('fv.colNaive')}</th><th class="n mh">${t('fv.colWeek')}</th><th class="n mh">${t('fv.colPeak1')}</th><th class="n mh">${t('fv.colBand')}</th><th class="n mh" title="${ctx.esc(t('fv.colPinballTip'))}">${t('fv.colPinball')}</th><th class="n mh">${t('fv.colHours')}</th></tr></thead><tbody>${live.map(x => `<tr><td>${ctx.esc(dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(x.at)))}</td><td class="mh">${mdl(x)}</td><td class="n">${pc(x.v >= 2 ? x.wapeOpHn : x.wapeOpH)}</td><td class="n">${pc(x.naiveOpH)}</td><td class="n mh">${pc(x.weekOpH)}</td><td class="n mh">${pk1(x)}</td><td class="n mh">${pc(x.cover80)}</td><td class="n mh">${x.pinball == null ? '–' : pc(x.pinball)}</td><td class="n mh">${x.hours == null ? '24' : n0(x.hours)}</td></tr>`).join('')}</tbody></table></div><div class="fv-sub">${t('fv.liveNote', { min: FC.GATES.liveMinHours })}${bandFreq(live)}</div>` : '';
  return `<div class="panel">${head(t('fv.accTitle'), t('fv.accSub'))}${table}<div class="fv-sub">${t('fv.accNote')}</div>${liveHtml}${decisionHtml(ctx, L, G)}</div>`;
}

// ---------- Gewähltes Gebiet bzw. Anbieter (11.11.2026): je Gruppe Erwartung, Trefferbilanz und woraus die Prognose lernt ----------
// Grundlage: latest.groups (nächste 24 h), log.feedback (Selbstprüfung je Gruppe, ältere Tage verblassen: Starts, |Fehler| eigenes Profil bzw.
// gepooltes Modell), series.json (Plan gegen Ist nur für Gruppen mit eigener Stundenreihe). Modell und Lernstand gelten für alle Gruppen gemeinsam.
const XP = { much: 300, enough: 30 }; // Fahrtbeginne in der Selbstprüfung: viel eigene Erfahrung / genug für ein eigenes Urteil
export const allTag = (ctx) => { const st = ctx.state || {}; return (st.scope && st.scope !== 'DE') || (st.operator && st.operator !== 'all') ? `<span class="fv-chip D" title="${ctx.esc(t('fv.scAllTagTip'))}">${t('fv.scAllTag')}</span>` : ''; };
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
export function scopePanel(ctx, S0, sel, G, L) {
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
  const label = (k) => { const [a, o, y] = k.split('|'); return city ? `${esc(o)}, ${esc(tl[y] || y)}` : `${esc(ctx.muniName?.(a) || a)}, ${esc(tl[y] || y)}`; };
  // Gruppen ohne eigene Prognose und mit kaum gezählten Fahrten: eine Zeile statt Tabellenzeilen voller Striche
  const quiet = R.rows.filter(r => r.exp == null && r.y < XP.enough), shown = R.rows.filter(r => !quiet.includes(r));
  const better = (r) => (r.eP == null || r.eQ == null || r.y < XP.enough ? '' : ` ${jChipTxt(Math.abs(r.eP - r.eQ) <= 0.05 * r.eQ ? 'eq' : r.eP < r.eQ ? 'own' : 'all')}`);
  const rows = shown.map(r => `<tr><td class="wrap">${label(r.k)}</td>`
    + `<td class="n">${r.exp == null ? '–' : n0(r.exp)}${r.perVeh != null ? `<div class="sub-line">${t('fv.scPerVeh', { v: n1(r.perVeh) })}</div>` : ''}</td>`
    + `<td class="n mh">${n0(r.y)}<div class="sub-line">${xpChip(r.y)}</div></td>`
    + `<td class="n mh">${r.y >= XP.enough ? `${pc(r.eP)}, ${pc(r.eQ)}${better(r)}` : '–'}</td>`
    + `<td>${r.w == null ? `<span class="muted">${t('fv.scLearnAll', { w: pc(R.w0) })}</span>` : `${splitBar(r.w)} <span class="fv-sub" style="display:inline">${t('fv.scOwnPct', { w: pc(r.w) })}</span>${r.y < XP.enough ? `<div class="sub-line">${t('fv.scLearnShrunk')}</div>` : ''}`}</td>`
    + `<td class="n">${r.plan ? `${pc(r.plan.a)}, ${pc(r.plan.b)} ${jChip(judge(r.plan.a, r.plan.b))}` : '<span class="muted">–</span>'}</td></tr>`).join('');
  const tbl = `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(title)}"><table><thead><tr><th>${city ? t('fv.scColGroup') : t('fv.scColGroupCity')}</th><th class="n">${t('fv.scColExp')}</th><th class="n mh">${t('fv.scColXp')}</th><th class="n mh">${t('fv.scColHit')}</th><th>${t('fv.scColLearn')}</th><th class="n">${t('fv.scColPlan')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const quietHtml = quiet.length ? `<div class="fv-sub">${t('fv.scQuiet', { n: n0(quiet.length), ok: XP.enough, list: quiet.map(r => label(r.k)).join(', ') })}</div>` : '';
  return `<div class="panel" id="fv-scope">${head(title, t('fv.scSub'))}<p class="fv-lead" style="margin-top:var(--s2)">${lead}</p>${shown.length ? tbl : ''}${quietHtml}`
    + `${R.more ? `<div class="fv-sub">${t('fv.scMore', { n: n0(R.more) })}</div>` : ''}<div class="fv-sub">${esc(activeHow(L))}</div><div class="fv-sub">${t('fv.scHowCols', { much: XP.much, ok: XP.enough })}</div></div>`;
}
const jChipTxt = (k) => `<span class="fv-chip${k === 'own' ? ' A' : k === 'all' ? ' B' : ' D'}">${t(`fv.scBetter.${k}`)}</span>`;
