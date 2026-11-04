// Mobility Pulse — Prognose-Ansicht: Plan heute, Ist bis jetzt und Live-Prognose bis Ende morgen als Zeitreihe, Lernstand und Trefferquote der Prognose,
// Bewertung der bekannten Deploy- und Parkspots (Wichtigkeit, Soll, Ist, Fehlbestand).
// Eigener Hauptreiter mit drei Segmenten: renderForecastView(el, ctx, { part: 'verlauf' | 'spots' | 'basis' }) – Verlauf (Lernstand, Zeitreihe, Trefferquote),
// Spots (Bewertung der bekannten Spots), Grundlagen & Kontrolle (alles, was genutzt, erzeugt oder vermutet wird, mit Selbstprüfungen und Rohdaten).
// ctx = { state, CFG, esc, fmt, getJson, muniName, setScope, setFilter, resetFilters, loadUsageIndex, loadEvents, loadCells, loadOnce };
// Leaflet (L) global. Daten: forecast/series.json, forecast/latest.json, forecast/log.json (Sammler, lib/pulse-forecast.js); Spots über lib/pulse-spots.js.
// Werte aus Daten gehen durch ctx.esc; Texte im Wörterbuch web/i18n.js (Schlüssel fv.*).
import * as FC from './pulse-forecast.js?v=mw2id1k1';
import * as SP from './pulse-spots.js?v=mw2id1k1';
import { decodeFleet, buildDemandModel, groupPlaces, DEFAULTS as OPS } from './pulse-ops.js?v=mw2id1k1';
import { VEHICLE_TYPE_LABEL } from './pulse-core.js?v=mw2id1k1';
import { toCsv } from './pulse-report.js?v=mw2id1k1';
import { t, tMap, lang, dateFmt, numFmt } from './i18n.js?v=mw2id1k1';
import { mapKeys } from './mapkeys.js?v=mw2id1k1';

const TZ = 'Europe/Berlin', DEMAND_DAYS = 7, SPOT_ROWS = 25;
const CACHE = new Map(), S = new WeakMap();
let LAST_RATED = null; // zuletzt bewertete Spots (Anzeige in „Grundlagen & Kontrolle“)
const st = (el) => { let s = S.get(el); if (!s) { s = { tok: 0, day: null, op: null, rows: SPOT_ROWS, map: null }; S.set(el, s); } return s; };
/** Zwischenspeicher leeren (neuer Sammler-Lauf) */
export function resetForecastCache() { CACHE.clear(); LAST_RATED = null; }
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
.fv-tog button[aria-pressed="true"]{background:var(--thumb,var(--panel));color:var(--fg);box-shadow:inset 0 0 0 1px var(--line-2)}
.fv-scope{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--fg-2);padding:3px 10px;border:1px solid var(--line);border-radius:999px}
.fv-scope b{color:var(--fg);font-weight:600}
.fv-legend{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:12px;color:var(--fg-2);margin:0 0 var(--s2)}
.fv-legend i{display:inline-block;vertical-align:-2px;margin-right:6px}
.fv-legend .k-a{width:12px;height:12px;border-radius:2px;background:var(--accent)}
.fv-legend .k-l{width:12px;height:12px;border-radius:2px;background:color-mix(in srgb,var(--accent) 28%,transparent);border:1px dashed var(--accent)}
.fv-legend .k-p{width:18px;height:0;border-top:2.5px solid var(--info);margin-bottom:3px;vertical-align:middle}
.fv-chart{width:100%;overflow:hidden}
.fv-chart svg{display:block;width:100%;height:auto;max-width:1100px}
.fv-chart text{fill:var(--fg-2);font-size:11px;font-family:var(--sans)}
.fv-chart .gl{stroke:var(--line);stroke-width:1}
.fv-chart .bar-a{fill:var(--accent)}
.fv-chart .bar-l{fill:color-mix(in srgb,var(--accent) 26%,transparent);stroke:var(--accent);stroke-width:1;stroke-dasharray:3 2}
.fv-chart .ln-p{fill:none;stroke:var(--info);stroke-width:2.2;stroke-linejoin:round}
.fv-chart .now{stroke:var(--fg-2);stroke-width:1.2;stroke-dasharray:3 3}
.fv-chart .mid{stroke:var(--line-2);stroke-width:1}
.fv-chart .dayl{font-weight:600;fill:var(--fg)}
.fv-chart rect.hit{fill:transparent}.fv-chart rect.hit:hover{fill:color-mix(in srgb,var(--fg) 7%,transparent)}
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
`;
let cssDone = false;
const css = () => { if (cssDone || typeof document === 'undefined') return; cssDone = true; const s = document.createElement('style'); s.id = 'fv-style'; s.textContent = CSS; document.head.appendChild(s); };

const n0 = (x) => (x == null || !Number.isFinite(x) ? '–' : numFmt(0).format(x));
const n1 = (x) => (x == null || !Number.isFinite(x) ? '–' : numFmt(1).format(x));
const pc = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${numFmt(d).format(x * 100)} %`);
const sg = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${numFmt(d).format(Math.abs(x) * 100)} %`);
const fK = (v) => (v >= 10000 ? `${n0(v / 1000)}k` : v >= 1000 ? `${numFmt(1).format(v / 1000)}k` : n0(v));
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
  const out = { p: null, a: null, l: null }, d = series?.days?.[day] || {};
  for (const f of ['p', 'a', 'l']) for (const k of sel.keys) { const x = d[k]?.[f]; if (!x) continue; out[f] ||= new Array(24).fill(null); x.forEach((v, h) => { if (v != null) out[f][h] = (out[f][h] || 0) + v; }); }
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
const niceMax = (v) => { const e = 10 ** Math.floor(Math.log10(Math.max(v, 1))), m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e; };
function timeline(ctx, rows, { nowIdx = null, width = 720, blocks = [] } = {}) {
  const W = Math.max(320, Math.min(1100, Math.round(width))), H = 260, pl = 40, pr = 8, pt = 18, pb = 38, N = rows.length, bw = (W - pl - pr) / N, gap = bw > 9 ? 1.5 : 0.7;
  const vals = rows.flatMap(r => [r.p, r.a, r.l]).filter(Number.isFinite), top = niceMax(Math.max(1, ...vals) * 1.05), y = (v) => pt + (H - pt - pb) * (1 - v / top), x = (i) => pl + i * bw, every = W < 520 ? 6 : 3;
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y(top * f).toFixed(1)}" y2="${y(top * f).toFixed(1)}"/><text x="${pl - 5}" y="${(y(top * f) + 4).toFixed(1)}" text-anchor="end">${fK(top * f)}</text>`).join('');
  const bars = rows.map((r, i) => {
    const v = r.a ?? r.l; if (v == null) return '';
    const cls = r.a != null ? 'bar-a' : 'bar-l', h = Math.max(1, y(0) - y(v));
    return `<rect class="${cls}" x="${(x(i) + gap).toFixed(1)}" y="${(y(0) - h).toFixed(1)}" width="${Math.max(1.5, bw - 2 * gap).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"/>`;
  }).join('');
  let d = '', open = false;
  rows.forEach((r, i) => { if (r.p == null) { open = false; return; } d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(r.p).toFixed(1)}L${x(i + 1).toFixed(1)} ${y(r.p).toFixed(1)}`; open = true; });
  const labels = rows.map((r, i) => (r.h % every === 0 ? `<text x="${(x(i) + bw / 2).toFixed(1)}" y="${H - pb + 14}" text-anchor="middle">${r.h}</text>` : '')).join('');
  const hit = rows.map((r, i) => `<rect class="hit" x="${x(i).toFixed(1)}" y="${pt}" width="${bw.toFixed(1)}" height="${H - pt - pb}"><title>${ctx.esc(`${String(r.h).padStart(2, '0')}:00 · ${r.a != null ? `${t('fv.ist')} ${n0(r.a)}` : r.l != null ? `${t('fv.live')} ${n0(r.l)}` : t('fv.notObserved')}${r.p != null ? ` · ${t('fv.plan')} ${n0(r.p)}` : ''}`)}</title></rect>`).join('');
  const sepAndDays = blocks.map((b, k) => `${k ? `<line class="mid" x1="${x(b.from).toFixed(1)}" x2="${x(b.from).toFixed(1)}" y1="${pt}" y2="${H - pb}"/>` : ''}<text class="dayl" x="${(x(b.from) + (b.to - b.from) * bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${ctx.esc(b.label)}</text>`).join('');
  const now = nowIdx != null ? `<line class="now" x1="${x(nowIdx).toFixed(1)}" x2="${x(nowIdx).toFixed(1)}" y1="${pt - 6}" y2="${H - pb}"/><text x="${(x(nowIdx) + 4).toFixed(1)}" y="${pt - 6}">${ctx.esc(t('fv.now'))}</text>` : '';
  const total = sum(rows.map(r => r.a ?? r.l ?? 0));
  return `<div class="fv-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ctx.esc(t('fv.chartAria', { total: n0(total) }))}">${grid}${bars}<path class="ln-p" d="${d}"/>${now}${sepAndDays}${labels}${hit}</svg></div>`;
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
  return `<div class="panel">${head(t('fv.learnTitle'), t('fv.learnSub'))}<p style="margin:0">${status}</p>${until ? `<p class="fv-sub">${t('fv.activeFrom', { date: ctx.esc(until) })}</p>` : ''}`
    + `<ul class="fv-gates">${row(t('fv.gTrain'), L.trainDays || 0, minT, '', t('fv.gTrainSub'))}${row(t('fv.gEval'), L.evalDays || 0, minE, '', t('fv.gEvalSub'))}${row(t('fv.gTemp'), wg.tempRangeK || 0, wk, 'K', t('fv.gTempSub'))}${row(t('fv.gRain'), Math.min(wg.rainDays || 0, wg.dryDays || 0), wd, '', `${t('fv.gRainSub', { rain: wg.rainDays || 0, dry: wg.dryDays || 0 })}`)}</ul>`
    + `<p class="fv-sub">${wxOn ? t('fv.wxOn') : t('fv.wxOff')}</p></div>`;
}

/** Tage mit Plan und Ist (abgeschlossene Tage; mit withToday auch der laufende) für die gewählten Reihen */
function accRows(S0, sel, G, { withToday = false } = {}) {
  const days = Object.keys(S0.days).filter(d => (withToday ? d <= S0.today : d < S0.today)).sort().slice(-7), rows = [];
  for (const d of days) { const e = seriesOf(S0, d, sel), prev = seriesOf(S0, addDays(d, -1), sel), s = dayStats(e, prev.a); if (s) rows.push({ d, ...s, train: G?.evals?.[d]?.trainDays ?? null }); }
  return rows;
}
/** Mittlere Abweichung je Modell über die letzten ausgewerteten Tage (Selbstprüfung aus log.json) */
function raceOf(G, L) {
  const ev = G?.evals || {}, evDays = Object.keys(ev).sort().slice(-(L?.gates?.evalWindow ?? FC.GATES.evalWindow)), M = ['profile', 'pooled', 'pooledWx', 'naive'];
  const avg = (m, k) => { const v = evDays.map(d => ev[d]?.models?.[m]?.[k]).filter(x => x != null); return v.length ? { v: sum(v) / v.length, n: v.length } : null; };
  return M.map(m => ({ m, gd: avg(m, 'wapeGD'), gh: avg(m, 'wapeGH'), bias: avg(m, 'bias'), cov: avg(m, 'cover80') })).filter(r => r.gd);
}
function accuracyPanel(ctx, S0, sel, G, L) {
  const rows = accRows(S0, sel, G);
  const maxW = Math.max(0.01, ...rows.map(r => Math.max(r.wape, r.naive ?? 0)));
  const body = rows.length ? rows.slice().reverse().map(r => `<tr><td>${ctx.esc(dayTxt(r.d))}</td><td class="n">${n0(r.ist)}</td><td class="n">${n0(r.plan)}</td><td class="n">${sg(r.bias, 1)}</td>`
    + `<td class="n bars"><span class="t">${pc(r.wape)}</span><span class="fv-bar" style="width:${Math.round(r.wape / maxW * 110)}px"></span></td><td class="n bars"><span class="t">${pc(r.naive)}</span>${r.naive == null ? '' : `<span class="fv-bar n" style="width:${Math.round(r.naive / maxW * 110)}px"></span>`}</td><td class="n">${r.skill == null ? '–' : sg(r.skill)}</td><td class="n">${r.train == null ? '–' : n0(r.train)}</td></tr>`).join('') : '';
  const table = rows.length ? `<div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.accTitle'))}"><table><thead><tr><th>${t('fv.colDay')}</th><th class="n">${t('fv.colIst')}</th><th class="n">${t('fv.colPlan')}</th><th class="n">${t('fv.colBias')}</th><th class="n">${t('fv.colErr')}</th><th class="n">${t('fv.colNaive')}</th><th class="n">${t('fv.colSkill')}</th><th class="n">${t('fv.colTrain')}</th></tr></thead><tbody>${body}</tbody></table></div>`
    : `<div class="empty"><b>${t('fv.accNone')}</b>${t('fv.accNoneHint')}</div>`;
  // Modellvergleich je Gruppe und Tag (Selbstprüfung über alle Anbieter und Gemeinden)
  const race = raceOf(G, L);
  const best = Math.min(...race.map(r => r.gd.v)), raceHtml = race.length ? `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.raceTitle')}</h3><div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.raceTitle'))}"><table><thead><tr><th>${t('fv.colModel')}</th><th class="n">${t('fv.colGD')}</th><th class="n">${t('fv.colGH')}</th><th class="n">${t('fv.colBias')}</th><th class="n">${t('fv.colCover')}</th><th class="n">${t('fv.colDays')}</th></tr></thead><tbody>${race.map(r => `<tr><td>${r.m === 'naive' ? t('fv.naive') : t(`fc.model.${r.m}`)}${r.m === L?.active ? ` <span class="fv-chip B">${t('fv.activeTag')}</span>` : ''}${r.gd.v === best ? ` <span class="fv-chip A">${t('fv.bestTag')}</span>` : ''}</td><td class="n bars"><span class="t">${pc(r.gd.v)}</span><span class="fv-bar${r.m === 'naive' ? ' n' : ''}" style="width:${Math.round(r.gd.v / Math.max(...race.map(x => x.gd.v)) * 110)}px"></span></td><td class="n">${pc(r.gh?.v)}</td><td class="n">${sg(r.bias?.v, 1)}</td><td class="n">${pc(r.cov?.v)}</td><td class="n">${r.gd.n}</td></tr>`).join('')}</tbody></table></div><div class="fv-sub">${t('fv.raceNote')}</div>` : '';
  const live = (L?.live || []).slice(-6).reverse(), liveHtml = live.length ? `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.liveTitle')}</h3><div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.liveTitle'))}"><table><thead><tr><th>${t('fv.colIssued')}</th><th class="n">${t('fv.colErrOp')}</th><th class="n">${t('fv.colNaive')}</th><th class="n">${t('fv.colSkill')}</th><th class="n">${t('fv.colStarts')}</th></tr></thead><tbody>${live.map(x => `<tr><td>${ctx.esc(dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(x.at)))}</td><td class="n">${pc(x.wapeOpH)}</td><td class="n">${pc(x.naiveOpH)}</td><td class="n">${x.skill == null ? '–' : sg(x.skill)}</td><td class="n">${n0(x.starts)}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<div class="panel">${head(t('fv.accTitle'), t('fv.accSub'))}${table}<div class="fv-sub">${t('fv.accNote')}</div>${raceHtml}${liveHtml}</div>`;
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
  const ops = [...new Set([...fleet.vehicles.filter(v => v.ags === ags).map(v => v.operator), ...fleet.stations.filter(x => x.ags === ags).map(x => x.operator)])].filter(Boolean);
  const cnt = (o) => fleet.vehicles.filter(v => v.ags === ags && v.operator === o).length + fleet.stations.filter(x => x.ags === ags && x.operator === o).length;
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
  return `<div class="fv-top" role="group" aria-label="${esc(t('fv.topAria'))}"><span class="lbl">${t('fv.filter')}</span>`
    + pill('scope', t('fv.fArea'), a ? (ctx.muniName?.(sel.ags) || sel.ags) : t('fc.scopeDE'), a, false)
    + pill('op', t('fv.fOp'), o ? S1.operator : t('fv.fAll'), o, ign && o)
    + pill('type', t('fv.fType'), y ? (ty[S1.type] || S1.type) : t('fv.fAll'), y, ign && y)
    + (a || o || y ? `<button type="button" class="chip" data-fv-clear="all">${t('fv.resetAll')}</button>` : '')
    + `<span class="sp"></span>${extra}<span class="hint">${t('fv.filterHint')}</span></div>`;
}
function bindTop(el, ctx) {
  el.querySelectorAll('[data-fv-clear]').forEach(b => b.addEventListener('click', () => { const k = b.dataset.fvClear; if (k === 'all') ctx.resetFilters?.(); else ctx.setFilter?.(k, k === 'scope' ? 'DE' : 'all'); }));
}
function download(name, rows) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + toCsv(rows, lang())], { type: 'text/csv;charset=utf-8' })); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const fileTag = (ctx, sel) => [sel.ags && sel.ags !== 'DE' ? sel.ags : 'DE', ctx.state.operator !== 'all' ? ctx.state.operator : null, ctx.state.type !== 'all' ? ctx.state.type : null].filter(Boolean).join('_').replace(/[^\w.-]+/g, '-');
const csvBtn = (key, label, disabled = false) => `<button type="button" class="chip" data-fv-csv="${key}"${disabled ? ' disabled' : ''}>${label}</button>`;

// ---------- Hauptansicht ----------
/** part: 'verlauf' (Standard) | 'spots' | 'basis' – jedes Segment des Reiters „Prognose“ hat einen eigenen Container */
export async function renderForecastView(el, ctx, opts = {}) {
  if (!el) return;
  const part = ['spots', 'basis'].includes(opts.part) ? opts.part : 'verlauf';
  css(); const s = st(el), tok = ++s.tok; el.classList.add('fv-root');
  if (!el.firstChild) el.innerHTML = `<div class="note small">${t('fv.loading')}</div>`;
  try {
    const [S0, L, G] = await Promise.all([fj(ctx, 'forecast/series.json'), fj(ctx, 'forecast/latest.json'), fj(ctx, 'forecast/log.json')]); if (tok !== s.tok) return;
    if (!S0 || S0.version !== 1 || !L) { el.innerHTML = `<div class="panel"><div class="empty"><b>${t('fv.none')}</b>${t('fv.noneHint')}</div></div>`; return; }
    if (part === 'spots') return await renderSpotsPart(el, ctx, s, S0, L);
    if (part === 'basis') return renderBasisPart(el, ctx, s, S0, L, G);
    await renderVerlauf(el, ctx, s, tok, S0, L, G);
  } catch (e) { console.error('Prognose-Ansicht', e); if (tok === s.tok) el.innerHTML = `<div class="panel"><div class="empty"><b>${t('fv.none')}</b>${t('fv.noneHint')}</div></div>`; }
}

async function renderVerlauf(el, ctx, s, tok, S0, L, G) {
  const { esc } = ctx;
  const sel = pickScope(S0, ctx.state), today = S0.today, bn = berlinNow();
  // heutige Ist-Werte frisch aus der Tagesdatei (der Sammler schreibt die Reihen höchstens stündlich)
  const live = await freshActual(ctx, S0, sel, today); if (tok !== s.tok) return;
  const dayList = Object.keys(S0.days).filter(d => d <= today).sort().reverse(); // heute, gestern, …
  const view = s.day && (s.day === 'ahead' || dayList.includes(s.day)) ? s.day : 'ahead';
  s.day = view;
  const nowH = bn.day === today ? bn.h : bn.day > today ? 24 : 0, T = today, TM = addDays(today, 1);
  const eT = seriesOf(S0, T, sel), eM = seriesOf(S0, TM, sel);
  if (live) eT.a = live;
  // Zeilen des Diagramms
  const mk = (day, e, withLive) => Array.from({ length: 24 }, (_, h) => ({ day, h, p: e.p?.[h] ?? null, a: e.a?.[h] ?? null, l: withLive ? (e.l?.[h] ?? null) : null }));
  let rows, blocks, nowIdx = null, title;
  if (view === 'ahead') {
    rows = [...mk(T, eT, true), ...mk(TM, eM, true)];
    blocks = [{ from: 0, to: 24, label: `${t('fv.today')} · ${dayTxt(T)}` }, { from: 24, to: 48, label: `${t('fv.tomorrow')} · ${dayTxt(TM)}` }];
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
  const tiles = noSeries ? '' : `<div class="tiles">${tile(t('fv.kSoFar'), n0(doneIst), stT ? t('fv.kSoFarSub', { plan: n0(stT.plan), d: sg(stT.bias, 1) }) : t('fv.kNoPlan'))}`
    + `${tile(t('fv.kErr'), stT ? pc(stT.wape) : '–', stT ? (stT.naive != null ? t('fv.kErrSub', { naive: pc(stT.naive), skill: sg(stT.skill) }) : t('fv.kErrSub1', { n: stT.n })) : t('fv.kNoPlan'))}`
    + `${tile(t('fv.kDay'), n0(expectDay), planDay != null ? t('fv.kDaySub', { plan: n0(planDay), d: sg(planDay > 0 ? expectDay / planDay - 1 : null, 1) }) : t('fv.kNoPlan'))}`
    + `${tile(t('fv.kTomorrow'), totalM == null ? '–' : n0(totalM), totalM != null && expectDay > 0 ? t('fv.kTomorrowSub', { d: sg(totalM / expectDay - 1, 0) }) : t('fv.kNoPlan'))}</div>`;
  const lead = noSeries ? `<div class="empty"><b>${t('fv.noScope')}</b>${esc(t('fv.noScopeHint'))}</div>` : '';
  const dataTable = noSeries ? '' : `<details class="fv-data"><summary>${t('fv.tableToggle')}</summary><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fv.tableToggle'))}"><table><thead><tr><th>${t('fv.colDay')}</th><th class="n">${t('fv.colHour')}</th><th class="n">${t('fv.colIst')}</th><th class="n">${t('fv.colPlan')}</th><th class="n">${t('fv.colLive')}</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(dayTxt(r.day))}</td><td class="n">${String(r.h).padStart(2, '0')}:00</td><td class="n">${n0(r.a)}</td><td class="n">${n0(r.p)}</td><td class="n">${n0(r.l)}</td></tr>`).join('')}</tbody></table></div></details>`;
  const notes = [sel.partial ? t('fv.nPartial') : '', sel.ignored ? t('fv.nIgnored') : '', S0.generatedAt ? t('fv.asOf', { time: dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(S0.generatedAt)) }) : ''].filter(Boolean).join(' ');
  const accRowsNow = accRows(S0, sel, G);
  el.innerHTML = topBar(ctx, sel, noSeries ? '' : `${csvBtn('series', t('fv.csvSeries'))}${accRowsNow.length ? csvBtn('days', t('fv.csvDays')) : ''}`)
    + `<div class="fv-grid">${learnPanel(ctx, L, G)}`
    + `<div class="panel">${head(title, t('fv.chartSub'), `<span class="fv-scope">${t('fv.scope')}: <b>${esc(scopeTxt)}</b></span>`)}${lead || ''}`
    + `<div class="fv-ctl"><div class="fv-tog" role="group" aria-label="${esc(t('fv.dayAria'))}">${segs.map(([v, l]) => `<button data-v="${esc(v)}" aria-pressed="${v === view}">${esc(l)}</button>`).join('')}</div></div>`
    + (noSeries ? '' : `${tiles}<div class="fv-legend" style="margin-top:var(--s3)"><span><i class="k-a"></i>${t('fv.ist')}</span><span><i class="k-l"></i>${t('fv.live')}</span><span><i class="k-p"></i>${t('fv.plan')}</span></div>${timeline(ctx, rows, { nowIdx: view === 'ahead' ? nowIdx : null, width: el.clientWidth - 40, blocks })}<div class="fv-sub">${t('fv.chartNote')} ${esc(notes)}</div>${dataTable}`) + '</div>'
    + `${accuracyPanel(ctx, S0, sel, G, L)}<p class="fv-sub">${t('fv.moreBasis')} <a href="#prognose-basis">${t('fv.segBasis')}</a>.</p></div>`;
  bindTop(el, ctx);
  el.querySelectorAll('.fv-tog button').forEach(b => b.addEventListener('click', () => { s.day = b.dataset.v; renderForecastView(el, ctx, { part: 'verlauf' }); }));
  el.querySelector('[data-fv-csv="series"]')?.addEventListener('click', () => download(`prognose_stundenreihe_${fileTag(ctx, sel)}_${view === 'ahead' ? today : view}.csv`,
    [[t('fv.colScope'), t('fv.colDay'), t('fv.colHour'), t('fv.colIst'), t('fv.colPlan'), t('fv.colLive')], ...rows.map(r => [scopeTxt, r.day, r.h, r.a == null ? null : [r.a, 1], r.p == null ? null : [r.p, 1], r.l == null ? null : [r.l, 1]])]));
  el.querySelector('[data-fv-csv="days"]')?.addEventListener('click', () => download(`prognose_tage_${fileTag(ctx, sel)}.csv`,
    [[t('fv.colScope'), t('fv.colDay'), t('fv.colIst'), t('fv.colPlan'), t('fv.colBias'), t('fv.colErr'), t('fv.colNaive'), t('fv.colSkill'), t('fv.colTrain')], ...accRowsNow.map(r => [scopeTxt, r.d, [r.ist, 0], [r.plan, 0], r.bias == null ? null : [r.bias, 4], r.wape == null ? null : [r.wape, 4], r.naive == null ? null : [r.naive, 4], r.skill == null ? null : [r.skill, 4], r.train])]));
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
  if (act && nv) add(act.gd.v <= nv.gd.v ? 'ok' : 'near', t('fv.cNaive'), act.gd.v <= nv.gd.v ? t('fv.cNaiveOk', { model: t(`fc.model.${act.m}`), a: pc(act.gd.v), n: pc(nv.gd.v) }) : t('fv.cNaiveBad', { model: t(`fc.model.${act.m}`), a: pc(act.gd.v), n: pc(nv.gd.v) }));
  else add('none', t('fv.cNaive'), t('fv.cNaiveNone'));
  const models = race.filter(r => r.m !== 'naive'), best = models.slice().sort((a, b) => a.gd.v - b.gd.v)[0];
  if (best && act && best.m !== act.m && best.gd.v < act.gd.v - 0.005) add('near', t('fv.cBest'), t('fv.cBestBad', { best: t(`fc.model.${best.m}`), b: pc(best.gd.v), act: t(`fc.model.${act.m}`), a: pc(act.gd.v), min: gates.minEvalDays }));
  else if (best) add('ok', t('fv.cBest'), t('fv.cBestOk', { model: t(`fc.model.${act?.m || best.m}`) }));
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
  const files = ['latest', 'log', 'series'].map(f => `<a class="chip" href="${esc(`${ctx.CFG.DATA}forecast/${f}.json`)}" target="_blank" rel="noopener">forecast/${f}.json</a>`).join('');
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
    [t('fv.kvWx'), esc(L.weather?.source || '–'), L.weather?.used ? t('fv.kvWxOn') : t('fv.kvWxOff', { range: n1v(wg.tempRangeK), rain: wg.rainDays ?? 0, dry: wg.dryDays ?? 0, miss: pc(wg.missingShare) })],
    [t('fv.kvCal'), cal?.source ? esc(cal.source) : t('fv.kvCalNone'), cal?.from ? `${esc(cal.from)} – ${esc(cal.to)}` : t('fv.kvCalFallback')],
    [t('fv.kvHorizon'), t('fv.kvHorizonV', { h: L.horizon?.hours ?? 24 }), L.horizon?.from ? t('fv.kvHorizonSub', { time: timeTxt(new Date(L.horizon.from).toISOString()), d: esc(L.horizon.tomorrow || '') }) : ''],
    [t('fv.kvStand'), timeTxt(L.generatedAt), t('fv.kvStandSub', { time: timeTxt(S0.generatedAt) })],
  ])}${provTbl}</div>`;
  // Panel 3: Modell
  const modelRows = [['profile', t('fv.mProfile')], ['pooled', t('fv.mPooled')], ['pooledWx', t('fv.mPooledWx')], ['naive', t('fv.mNaive')]];
  const p3 = `<div class="panel">${head(t('fv.modelTitle'), t('fv.modelSub'))}<code class="fv-formula">${esc(t('fv.formula'))}</code>`
    + `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.modelTitle'))}"><table style="margin-top:var(--s3)"><thead><tr><th>${t('fv.colModel')}</th><th>${t('fv.colWhat')}</th></tr></thead><tbody>${modelRows.map(([m, d]) => `<tr><td>${m === 'naive' ? t('fv.naive') : t(`fc.model.${m}`)}${m === L.active ? ` <span class="fv-chip B">${t('fv.activeTag')}</span>` : ''}</td><td class="wrap">${esc(d)}</td></tr>`).join('')}</tbody></table></div>`
    + `<p class="fv-sub">${esc(t('fv.chooseRule', { min: gates.minEvalDays, win: gates.evalWindow, gain: pc(gates.wxGain) }))}</p>${L.reason ? `<p class="fv-sub">${t('fv.reasonNow')} <i>${esc(L.reason)}</i></p>` : ''}</div>`;
  // Panel 4: gemessen · abgeleitet · modelliert · vermutet
  const A = [
    ['derived', t('fv.aStarts'), t('fv.aStartsHow')], ['measured', t('fv.aExposure'), t('fv.aExposureHow')], ['external', t('fv.aDayType'), t('fv.aDayTypeHow')],
    ['external', t('fv.aWeather'), t('fv.aWeatherHow')], ['derived', t('fv.aEra'), t('fv.aEraHow')], ['modelled', t('fv.aPlan'), t('fv.aPlanHow')], ['modelled', t('fv.aBand'), t('fv.aBandHow')],
    ['assumed', t('fv.aDeploy'), t('fv.aDeployHow')], ['derived', t('fv.aPark'), t('fv.aParkHow')], ['modelled', t('fv.aDemand'), t('fv.aDemandHow')], ['assumed', t('fv.aShare'), t('fv.aShareHow')],
    ['rule', t('fv.aTarget'), t('fv.aTargetHow', { base: OPS.baseH, min: OPS.minPerSpot, max: OPS.maxPerSpot, h: OPS.horizonH })], ['measured', t('fv.aHave'), t('fv.aHaveHow', { r: OPS.spotRadiusM })],
    ['derived', t('fv.aMissing'), t('fv.aMissingHow')], ['rule', t('fv.aClasses'), t('fv.aClassesHow', { a: pc(SP.RATE.classA), b: pc(SP.RATE.classB) })],
  ];
  const last = LAST_RATED;
  const lastRow = last?.R?.items?.length ? `<p class="fv-sub">${t('fv.lastSpots', { n: n0(last.R.total.spots), d: n0(last.R.total.deploy), p: n0(last.R.total.park), b: n0(last.R.total.both), op: esc(last.op), m: esc(ctx.muniName?.(last.ags) || last.ags) })}</p>` : '';
  const p4 = `<div class="panel">${head(t('fv.assumeTitle'), t('fv.assumeSub'))}<div class="fv-legend" style="margin-top:var(--s2)">${['measured', 'derived', 'modelled', 'assumed', 'rule', 'external'].map(k => `<span>${tag(k)}</span>`).join('')}</div>`
    + `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.assumeTitle'))}"><table><thead><tr><th>${t('fv.colWhat')}</th><th>${t('fv.colKind')}</th><th>${t('fv.colHow')}</th></tr></thead><tbody>${A.map(([k, n, h]) => `<tr><td class="wrap"><b>${esc(n)}</b></td><td>${tag(k)}</td><td class="wrap">${esc(h)}</td></tr>`).join('')}</tbody></table></div>${lastRow}</div>`;
  // Panel 5: Parameter (aus dem Code, nicht frei einstellbar)
  const P = [
    ['minTrainDays', gates.minTrainDays, t('fv.pMinTrain')], ['minEvalDays', gates.minEvalDays, t('fv.pMinEval')], ['hourMinObserved', gates.hourMinObserved, t('fv.pHourMin')],
    ['wxTempRangeK', gates.wxTempRangeK, t('fv.pWxRange')], ['wxRainDays', gates.wxRainDays, t('fv.pWxRain')], ['wxMissingMax', gates.wxMissingMax, t('fv.pWxMiss')], ['wxGain', gates.wxGain, t('fv.pWxGain')], ['evalWindow', gates.evalWindow, t('fv.pWindow')],
    ['SERIES_KEEP_DAYS', FC.SERIES_KEEP_DAYS, t('fv.pKeep')], ['SERIES_MIN.ags', FC.SERIES_MIN.ags, t('fv.pSerAgs')], ['SERIES_MIN.group', FC.SERIES_MIN.group, t('fv.pSerGroup')], ['SERIES_MIN.groupMax', FC.SERIES_MIN.groupMax, t('fv.pSerMax')],
    ['baseH', OPS.baseH, t('fv.pBase')], ['minPerSpot', OPS.minPerSpot, t('fv.pMinSpot')], ['maxPerSpot', OPS.maxPerSpot, t('fv.pMaxSpot')], ['spotRadiusM', OPS.spotRadiusM, t('fv.pRadius')], ['horizonH', OPS.horizonH, t('fv.pHorizon')], ['prelimH', OPS.prelimH, t('fv.pPrelim')],
    ['RATE.classA', SP.RATE.classA, t('fv.pClassA')], ['RATE.classB', SP.RATE.classB, t('fv.pClassB')], ['RATE.linkM', SP.RATE.linkM, t('fv.pLink')], ['DEMAND_DAYS', DEMAND_DAYS, t('fv.pDemandDays')],
  ];
  const p5 = `<div class="panel">${head(t('fv.paramTitle'), t('fv.paramSub'))}<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.paramTitle'))}"><table><thead><tr><th>${t('fv.colParam')}</th><th class="n">${t('fv.colValue')}</th><th>${t('fv.colEffect')}</th></tr></thead><tbody>${P.map(([k, v, d]) => `<tr><td><code>${esc(k)}</code></td><td class="n">${esc(String(v))}</td><td class="wrap">${esc(d)}</td></tr>`).join('')}</tbody></table></div></div>`;
  // Panel 6: nicht berücksichtigt
  const NO = ['nStrike', 'nTrain', 'nEvents', 'nWarn', 'nRoad', 'nOp', 'nZones'];
  const p6 = `<div class="panel">${head(t('fv.notTitle'), t('fv.notSub'))}<ul class="fv-list">${NO.map(k => `<li>${esc(t(`fv.${k}`))}</li>`).join('')}</ul><p class="fv-sub">${t('fv.notNote')}</p></div>`;
  // Panel 7: Rohdaten
  const p7 = `<div class="panel">${head(t('fv.rawTitle'), t('fv.rawSub'))}<div class="fv-links">${files}</div><p class="fv-sub">${t('fv.rawNote')}</p></div>`;
  el.innerHTML = topBar(ctx, sel) + `<div class="fv-grid">${p1}${p2}${p3}${p4}${p5}${p6}${p7}</div>`;
  bindTop(el, ctx);
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
    const A = FC.actualOfDay(FC.dayFromDoc({ ...doc, groups }, ctx.state.calendar || null)), out = new Array(24).fill(null);
    for (const k of sel.keys) { const a = A.get(k); if (!a) continue; a.forEach((v, h) => { if (v != null) out[h] = (out[h] || 0) + v; }); }
    return out.some(x => x != null) ? out : null;
  } catch { return null; }
}
