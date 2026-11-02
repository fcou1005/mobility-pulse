// Mobility Pulse — Spot-Abgleich (Disposition › Spot-Abgleich): Park- und Abstellflächen laut Feed je Anbieter gegeneinander, aus Sicht
// eines eigenen Anbieters: Übersicht mit Abgleich-Balken, Listen „Fehlt bei mir“, „Nur bei mir“, „Pflegebedarf“ mit Karte, Filter und Export.
// Eigenständig: renderSpots(el, ctx), ctx = { state, CFG, esc, fmt, getJson, opColor, muniName, setScope, loadUsageIndex, loadCells, loadOnce };
// Leaflet (L) global. Rechenlogik in lib/pulse-spots.js; Werte aus Daten gehen durch ctx.esc.
import * as SP from './pulse-spots.js';
import { decodeFleet, buildDemandModel, GROUP_MIN } from './pulse-ops.js';
import { t, dateFmt, fmtLocale } from './i18n.js';

const LISTS = ['missing', 'onlyMine', 'care'], ISSUES = ['zone', 'dup', 'empty'], DEMAND_DAYS = 7, LIMIT = 100, RANK_LABELS = 30;
const CACHE = new Map();
const S = new WeakMap();
const st = (el) => { let s = S.get(el); if (!s) { s = { tok: 0, own: null, radius: SP.DEFAULT_RADIUS, kind: null, list: 'missing', minOps: 1, hide: new Set(), only: 'all', issues: new Set(ISSUES), q: '', limit: LIMIT }; S.set(el, s); } return s; };
/** Zwischenspeicher leeren (neuer Sammler-Lauf) */
export function resetSpotsCache() { CACHE.clear(); }

const STYLE = `
.sp-root .sp-ctl{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;margin:var(--s2) 0 var(--s3)}
.sp-ctl label{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--fg-2)}
.sp-ctl input[type=search]{min-height:var(--ctl);padding:0 var(--s3);border:1px solid var(--line-2);border-radius:var(--r-sm);background:var(--panel-2);min-width:min(240px,100%)}
.sp-tog{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:10px;background:var(--bg-2);border:1px solid var(--line)}
.sp-tog button{min-height:26px;border:0;background:transparent;color:var(--fg-2);padding:0 12px;border-radius:7px}
.sp-tog button[aria-pressed="true"]{background:var(--thumb,var(--panel));color:var(--fg);box-shadow:inset 0 0 0 1px var(--line-2)}
.sp-chips{display:flex;flex-wrap:wrap;gap:6px}
.sp-chips .chip .sp-n{font-weight:400;font-variant-numeric:tabular-nums}
.sp-chips .chip i{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--c,var(--warn))}
.sp-chips .chip[aria-pressed="false"]{color:var(--fg-2);border-style:dashed;text-decoration:line-through}.sp-chips .chip[aria-pressed="false"] i{background:transparent;box-shadow:inset 0 0 0 1.5px var(--c,var(--warn))}
.sp-lead{font-size:15px;line-height:1.5;color:var(--fg);max-width:78ch;margin:var(--s3) 0}
.sp-lead b{font-weight:600;font-variant-numeric:tabular-nums}
.sp-root .sp-feed{margin:0 0 var(--s4);max-width:110ch}
.sp-h3{font-size:14px;font-weight:600;margin:var(--s4) 0 var(--s2)}
.sp-op{display:inline-flex;align-items:center;gap:6px;font-weight:500;white-space:nowrap}.sp-op i{width:9px;height:9px;border-radius:50%;background:var(--c);flex:none}
.sp-ops{display:flex;flex-wrap:wrap;gap:2px 10px}
.sp-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;border:1px solid var(--accent);color:var(--fg);font-size:11px;font-weight:500;line-height:17px}
.sp-root tr.sp-own td:first-child{box-shadow:inset 3px 0 0 var(--accent)}
.sp-bar{position:relative;display:flex;gap:2px;height:10px;width:100%;min-width:150px;max-width:280px;margin:4px 0 3px;border-radius:3px}
.sp-bar span{height:100%;background:var(--c);flex:none}
.sp-bar span:first-of-type{border-radius:3px 0 0 3px}.sp-bar span:last-of-type{border-radius:0 3px 3px 0}.sp-bar span:only-of-type{border-radius:3px}
.sp-bar span.b{background:color-mix(in srgb,var(--c) 30%,var(--panel))}
.sp-bar i{position:absolute;top:-4px;bottom:-4px;width:2px;margin-left:-1px;background:var(--fg);border-radius:1px}
.sp-keys{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);align-items:center;font-size:12px;color:var(--fg-2);margin-top:var(--s2)}
.sp-keys .k{display:inline-block;width:18px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px;background:var(--fg-2)}
.sp-keys .k.b{background:color-mix(in srgb,var(--fg-2) 30%,var(--panel))}.sp-keys .k.t{width:2px;height:14px;background:var(--fg);vertical-align:-3px}
.sp-keys .dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:5px;vertical-align:-1px;border:2px solid var(--c,var(--fg-2))}
.sp-keys .dot.fill{background:var(--c,var(--fg-2))}.sp-keys .dot.ring{border-color:var(--warn);background:var(--c,var(--fg-2))}.sp-keys .dot.area{border:1.5px dashed var(--fg-2);width:14px;height:14px}
.sp-keys .dot.grey{border:0;width:7px;height:7px;background:var(--muted)}
.sp-tabs{display:flex;flex-wrap:wrap;gap:0 var(--s4);margin:var(--s5) 0 var(--s2);border-bottom:1px solid var(--line)}
.sp-tabs button,.sp-tabs button[aria-pressed]{min-height:36px;padding:0 2px;border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--fg-2);font-size:14px;font-weight:500;margin-bottom:-1px}
.sp-tabs button[aria-pressed="true"]{color:var(--fg);border-bottom-color:var(--accent);background:none}
.sp-tabs button span{margin-left:6px;color:var(--muted);font-variant-numeric:tabular-nums;font-weight:400}
.sp-sub{font-size:13px;color:var(--fg-2);margin:var(--s2) 0 0;max-width:100ch}
.sp-map{height:460px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-2);isolation:isolate;margin-top:var(--s2)}
.sp-link{all:unset;cursor:pointer;color:var(--fg);font-weight:500;text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:3px;border-radius:3px}
.sp-link:hover{text-decoration-color:currentColor}.sp-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sp-link.none{color:var(--fg-2);font-style:italic}
.sp-pl{display:grid;grid-template-columns:auto 1fr;column-gap:8px;align-items:start}.sp-rk{min-width:2ch;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
.sp-why{min-width:30ch;max-width:52ch;white-space:normal;color:var(--fg-2);font-size:12.5px;line-height:1.45}
.sp-flag{display:inline-flex;gap:5px;align-items:center;font-size:12px;color:var(--fg-2);white-space:nowrap}.sp-flag i{width:8px;height:8px;border-radius:50%;background:var(--warn);flex:none}
.sp-iss{display:flex;gap:6px;align-items:baseline;white-space:normal;min-width:26ch;max-width:46ch;font-size:12.5px;line-height:1.45}.sp-iss+.sp-iss{margin-top:2px}.sp-iss i{width:7px;height:7px;border-radius:50%;background:var(--warn);flex:none;transform:translateY(-1px)}
.sp-root .tbl td.n .sub-line{white-space:nowrap}
.sp-rank span{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--panel);color:var(--fg);box-shadow:0 0 0 1.5px var(--fg-2);font:600 10.5px/1 var(--sans);font-variant-numeric:tabular-nums}
.leaflet-tooltip.sp-tip{background:var(--panel);color:var(--fg-2);border:1px solid var(--line-2);border-radius:var(--r-sm);box-shadow:var(--shadow);padding:6px 10px;font:12px/1.45 var(--sans);max-width:min(320px,72vw);white-space:normal}
.leaflet-tooltip.sp-tip b{color:var(--fg)}
.sp-method{margin-top:var(--s4)}
@media (max-width:720px){.sp-map{height:340px}.sp-lead{font-size:14px}}
`;
let cssDone = false;
const css = () => { if (cssDone || typeof document === 'undefined') return; cssDone = true; const s = document.createElement('style'); s.textContent = STYLE; document.head.appendChild(s); };
const stamp = (ms) => (ms ? dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date(ms)) : '–');
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const cssVar = (n, fb) => (typeof getComputedStyle === 'function' && getComputedStyle(document.documentElement).getPropertyValue(n).trim()) || fb;
const fold = (x) => String(x ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase();

// ---------- Laden (gemeinsamer Cache von app.js über ctx.getJson/loadOnce/loadCells) ----------
function memo(key, fn) {
  if (!CACHE.has(key)) CACHE.set(key, Promise.resolve().then(fn).then(v => { if (v == null) CACHE.delete(key); return v; }, () => { CACHE.delete(key); return null; }));
  return CACHE.get(key);
}
const loadFleet = (ctx, land) => memo(`ops/${land}`, async () => { const r = await ctx.getJson(`${ctx.CFG.DATA}ops/${land}.json`, { timeout: 90000 }); return r?.ok && r.json ? decodeFleet(r.json) : null; });
// Nachfrage: Fahrtbeginne je Zelle aus den letzten Tagesdateien; { model: null } = keine Tagesdateien (kein Fehler)
const loadDemand = (ctx, land, ags) => memo(`cells/${land}/${ags}`, async () => {
  const idx = await ctx.loadUsageIndex(); const days = (idx?.cellDays || []).slice(-DEMAND_DAYS);
  if (!days.length) return { model: null };
  const docs = (await Promise.all(days.map(d => ctx.loadCells(d, land)))).filter(Boolean);
  const model = docs.length ? buildDemandModel(docs, ags, 'day') : null;
  return { model: model?.hours > 0 ? model : null };
});
// Zonen des eigenen Anbieters in der Gemeinde (zones/index.json → Dateien); Fehlschlag = failed (Zonenbefunde entfallen, Hinweis)
async function loadZones(ctx, ags, own) {
  const idx = await ctx.loadOnce('zonesIndex', 'zones/index.json');
  if (!idx) return { failed: true };
  const list = (idx.zones || []).filter(z => z.operator === own && (z.municipalities || []).includes(ags));
  const fcs = await Promise.all(list.map(z => memo(`zones/${z.file}|${z.at}`, async () => { const r = await ctx.getJson(`${ctx.CFG.DATA}zones/${z.file}`, { timeout: 60000 }); return r?.ok ? r.json : null; })));
  return fcs.some(f => !f) ? { failed: true } : { fcs, files: list.length };
}
function zonesFor(el, s) {
  const key = `${s.ags}|${s.own}`;
  if (s.zkey === key) return s.zres;
  s.zkey = key; s.zres = { state: 'loading', fcs: null };
  loadZones(s.ctx, s.ags, s.own).then(z => {
    if (s.zkey !== key) return;
    s.zres = z.failed ? { state: 'failed', fcs: null } : { state: z.files ? 'ok' : 'none', fcs: z.fcs };
    if (s.fleet && el.isConnected) keepFocus(el, () => draw(el, s.ctx, s));
  });
  return s.zres;
}

// ---------- Text-Bausteine ----------
const pct = (ctx, x) => (x == null ? '–' : `${ctx.fmt(x * 100)} %`);
const num = (ctx, x, d = 0) => (x == null ? '–' : ctx.fmt(x, d));
const meters = (ctx, d) => (d == null ? '–' : `${ctx.fmt(d)} m`);
const signed = (ctx, x) => (x == null ? '—' : x > 0 ? `+${ctx.fmt(x)}` : x < 0 ? `−${ctx.fmt(-x)}` : '±0');
const listFmt = () => { try { return new Intl.ListFormat(fmtLocale(), { style: 'long', type: 'conjunction' }); } catch { return { format: (a) => a.join(', ') }; } };
const opCell = (ctx, op) => `<span class="sp-op" style="--c:${ctx.esc(ctx.opColor(op))}"><i></i>${ctx.esc(op)}</span>`;
const coords = (x) => `${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}`;
const nameOf = (x) => x.label || t('spots.noName');

/** Begründung „Fehlt bei mir“ als Satz (Tabelle, Karte, GeoJSON) */
function whyMissing(ctx, x) {
  const L = listFmt(), out = [];
  for (const r of x.reasons) {
    if (r.k === 'ops') out.push(r.ops.length > 1 ? (r.spread < 5 ? t('spots.why.opsSame', { ops: L.format(r.ops) }) : t('spots.why.opsN', { ops: L.format(r.ops), n: ctx.fmt(r.n), d: ctx.fmt(r.spread) })) : r.n > 1 ? t('spots.why.ops1n', { ops: r.ops[0], n: ctx.fmt(r.n) }) : t('spots.why.ops1', { ops: r.ops[0] }));
    else if (r.k === 'demand') out.push((r.pct ?? 0) >= 0.01 ? t('spots.why.demand', { v: ctx.fmt(r.v, 2), p: ctx.fmt((r.pct ?? 0) * 100) }) : t('spots.why.demandLow', { v: ctx.fmt(r.v, 2) }));
    else if (r.k === 'noDemand') out.push(t('spots.why.noDemand'));
    else if (r.k === 'veh') out.push(r.n === 1 ? t('spots.why.veh1') : t('spots.why.veh', { n: ctx.fmt(r.n) }));
    else if (r.k === 'otherEmpty') out.push(t('spots.why.otherEmpty', { p: ctx.fmt(r.share * 100) }));
    else if (r.k === 'nearOwn') out.push(t('spots.why.nearOwn', { d: ctx.fmt(r.d) }));
    else if (r.k === 'noOwn') out.push(t('spots.why.noOwn'));
  }
  return out.join(' · ');
}
function issueText(ctx, i) {
  if (i.k === 'zone') return i.zone ? t('spots.iss.zone', { zone: i.zone }) : t('spots.iss.zoneNoName');
  if (i.k === 'dup') return t('spots.iss.dup', { of: i.of || coords(i), d: ctx.fmt(i.d) }); // Partner ohne Namen: Koordinaten
  const base = t('spots.iss.empty', { p: ctx.fmt(i.share * 100), n: ctx.fmt(i.runs) });
  const dem = i.demand === 'high' ? ` – ${t('spots.iss.emptyHigh')}` : i.demand === 'low' ? ` – ${t('spots.iss.emptyLow')}` : '';
  return base + dem + (i.vehNow ? ` · ${t('spots.iss.vehNow', { n: ctx.fmt(i.vehNow) })}` : '');
}
function whyOnly(ctx, x) {
  const out = [x.emptyShare == null ? t('spots.why.noQuota') : t('spots.iss.empty', { p: ctx.fmt(x.emptyShare * 100), n: ctx.fmt(x.runs) })];
  if (x.nearestOther) out.push(t('spots.why.nearOther', { op: x.nearestOther.operator, d: ctx.fmt(x.nearestOther.d) }));
  return out.join(' · ');
}
const reasonOf = (ctx, list, x) => (list === 'missing' ? whyMissing(ctx, x) : list === 'care' ? x.issues.map(i => issueText(ctx, i)).join(' · ') : whyOnly(ctx, x));

// ---------- Übersicht ----------
function overview(ctx, res, s) {
  const own = res.rows.find(r => r.own), others = res.rows.filter(r => !r.own);
  const rows = [own, ...others].filter(Boolean);
  const max = Math.max(1, ...rows.map(r => r.spots)), ownN = own?.spots || 0;
  const bar = (r) => {
    const c = ctx.esc(ctx.opColor(r.op)), w = (n) => `${(n / max * 100).toFixed(2)}%`;
    const a = r.unmatched, b = r.matched;
    const label = r.own ? t('spots.matchOwn', { u: ctx.fmt(a), m: ctx.fmt(b), own: res.own }) : t('spots.matchOther', { u: ctx.fmt(a), m: ctx.fmt(b), own: res.own });
    const segs = `${a ? `<span class="a" style="width:calc(${w(a)} - ${b ? 1 : 0}px)"></span>` : ''}${b ? `<span class="b" style="width:calc(${w(b)} - ${a ? 1 : 0}px)"></span>` : ''}`;
    return `<div class="sp-bar" style="--c:${c}" role="img" aria-label="${ctx.esc(`${r.op}: ${label}`)}" title="${ctx.esc(label)}">${segs}${!r.own && ownN ? `<i style="left:${w(ownN)}"></i>` : ''}</div><div class="sub-line">${ctx.esc(label)}</div>`;
  };
  const head = [[t('spots.colOp')], [t('spots.colSpots'), t('spots.colSpotsTip'), true], [t('spots.colDiff'), t('spots.colDiffTip', { own: res.own }), true], [t('spots.colMatch', { own: res.own }), t('spots.colMatchTip', { r: s.radius, own: res.own })],
    [t('spots.colKm2'), t('spots.colKm2Tip'), true], [t('spots.colPer1000'), t('spots.colPer1000Tip'), true], [t('spots.colAtSpot'), t('spots.colAtSpotTip', { r: s.radius }), true],
    [t('spots.colEmpty'), t('spots.colEmptyTip', { p: ctx.fmt(res.emptyShare * 100), runs: ctx.fmt(res.minRuns), near: SP.STATION_NEAR_M }), true], [t('spots.colDup'), t('spots.colDupTip', { d: res.dupM }), true]]
    .map(([l, tip, n]) => `<th${n ? ' class="n"' : ''}>${tip ? `<abbr title="${ctx.esc(tip)}">${l}</abbr>` : l}</th>`).join('');
  const body = rows.map(r => `<tr${r.own ? ' class="sp-own"' : ''}><td>${opCell(ctx, r.op)}${r.own ? `<span class="sp-tag">${t('spots.ownTag')}</span>` : ''}<div class="sub-line">${t('spots.vehiclesN', { n: ctx.fmt(r.vehicles) })}</div></td>
    <td class="n">${num(ctx, r.spots)}${s.kind === 'all' && r.spots ? `<div class="sub-line">${t('spots.physVirt', { v: ctx.fmt(r.virtual), p: ctx.fmt(r.physical) })}</div>` : ''}</td>
    <td class="n">${r.own ? '—' : signed(ctx, r.diff)}</td><td>${r.spots ? bar(r) : `<span class="sub-line">${t('spots.noSpots')}</span>`}</td>
    <td class="n">${num(ctx, r.perKm2, 1)}</td><td class="n">${num(ctx, r.per1000, 1)}</td><td class="n">${r.spots ? pct(ctx, r.atSpot) : '–'}</td>
    <td class="n">${r.quotaKnown ? `${num(ctx, r.permEmpty)}<div class="sub-line">${t('spots.ofKnown', { n: ctx.fmt(r.quotaKnown) })}</div>` : '–'}</td><td class="n">${r.spots ? num(ctx, r.dupExtra) : '–'}</td></tr>`).join('');
  const keys = `<div class="sp-keys"><span><i class="k"></i>${t('spots.keyA')}</span><span><i class="k b"></i>${t('spots.keyB', { r: s.radius })}</span><span><i class="k t"></i>${t('spots.keyTick', { own: ctx.esc(res.own) })}</span></div>`;
  return `<h3 class="sp-h3">${t('spots.ovTitle')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${t('spots.ovTitle')}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${keys}`;
}
function lead(ctx, res) {
  const own = res.rows.find(r => r.own), others = res.rows.filter(r => !r.own && r.spots);
  const list = others.length ? listFmt().format(others.map(r => t('spots.leadOther', { op: r.op, n: ctx.fmt(r.spots), d: signed(ctx, r.diff) }))) : t('spots.leadNoOthers');
  const v = { own: ctx.esc(res.own), n: ctx.fmt(own?.spots || 0), others: ctx.esc(list) };
  return `<p class="sp-lead">${!own?.spots ? t('spots.leadNone', v) : own.spots === 1 ? t('spots.lead1', v) : t('spots.lead', v)}</p>`;
}
function controls(ctx, res, s) {
  const esc = ctx.esc, opt = (v, l, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
  const nS = new Map(res.rows.map(r => [r.op, r.spots]));
  return `<div class="sp-ctl rp-noprint"><label>${t('spots.own')} <select data-sp="own">${res.operators.map(o => opt(o, nS.get(o) ? t('spots.ownOpt', { op: o, n: ctx.fmt(nS.get(o)) }) : t('spots.ownOptNone', { op: o }), res.own)).join('')}</select></label>
    <label>${t('spots.radius')} <select data-sp="radius">${SP.RADII.map(r => opt(r, `${r} m`, s.radius)).join('')}</select></label>
    <div class="sp-tog" role="group" aria-label="${t('spots.kind')}"><button type="button" data-sp-kind="virtual" aria-pressed="${s.kind === 'virtual'}">${t('spots.kindVirtual')}</button><button type="button" data-sp-kind="all" aria-pressed="${s.kind === 'all'}">${t('spots.kindAll', { n: ctx.fmt(s.allCount ?? 0) })}</button></div></div>`;
}

// ---------- Listen ----------
function filtered(res, s) {
  const words = fold(s.q).trim().split(/\s+/).filter(Boolean), ok = (txt) => !words.length || words.every(w => fold(txt).includes(w));
  if (s.list === 'missing') return res.missing.filter(x => x.nOps >= s.minOps && x.ops.some(o => !s.hide.has(o)) && ok(`${x.label} ${x.members.map(m => `${m.label} ${m.operator}`).join(' ')} ${coords(x)}`));
  if (s.list === 'onlyMine') return res.onlyMine.filter(x => (s.only === 'all' || (s.only === 'empty' ? x.permEmpty : !x.permEmpty)) && ok(`${x.label} ${coords(x)}`));
  return res.care.filter(x => x.issues.some(i => s.issues.has(i.k)) && ok(`${x.label} ${coords(x)}`));
}
function tools(ctx, res, s) {
  const esc = ctx.esc, n = { missing: res.missing.length, onlyMine: res.onlyMine.length, care: res.care.length };
  const tabs = `<div class="sp-tabs" role="group" aria-label="${t('spots.listsAria')}">${LISTS.map(l => `<button type="button" data-sp-list="${l}" aria-pressed="${s.list === l}">${t(`spots.list.${l}`)}<span>${ctx.fmt(n[l])}</span></button>`).join('')}</div>`;
  const sub = `<p class="sp-sub">${t(`spots.sub.${s.list}`, { own: esc(res.own), r: s.radius, d: res.dupM })}</p>`;
  let f = '';
  if (s.list === 'missing') {
    const ops = [...new Set(res.missing.flatMap(x => x.ops))].sort((a, b) => a.localeCompare(b, 'de'));
    f = `<div class="sp-tog" role="group" aria-label="${t('spots.minOps')}"><button type="button" data-sp-minops="1" aria-pressed="${s.minOps === 1}">${t('spots.minOps1')}</button><button type="button" data-sp-minops="2" aria-pressed="${s.minOps === 2}">${t('spots.minOps2')}</button></div>`
      + (ops.length > 1 ? `<div class="sp-chips" role="group" aria-label="${t('spots.opsAria')}">${ops.map(o => `<button type="button" class="chip" data-sp-op="${esc(o)}" aria-pressed="${!s.hide.has(o)}" style="--c:${esc(ctx.opColor(o))}"><i></i>${esc(o)}</button>`).join('')}</div>` : '');
  } else if (s.list === 'onlyMine') {
    f = `<div class="sp-tog" role="group" aria-label="${t('spots.emptyFilter')}">${['all', 'empty', 'used'].map(k => `<button type="button" data-sp-only="${k}" aria-pressed="${s.only === k}">${t(`spots.f.${k}`)}</button>`).join('')}</div>`;
  } else {
    const cnt = Object.fromEntries(ISSUES.map(k => [k, res.care.filter(x => x.issues.some(i => i.k === k)).length]));
    f = `<div class="sp-chips" role="group" aria-label="${t('spots.issuesAria')}">${ISSUES.map(k => `<button type="button" class="chip" data-sp-issue="${k}" aria-pressed="${s.issues.has(k)}"><i></i>${t(`spots.issue.${k}`)} <span class="sp-n">${ctx.fmt(cnt[k])}</span></button>`).join('')}</div>`;
  }
  const search = `<input type="search" data-sp-q value="${esc(s.q)}" placeholder="${t('spots.search')}" aria-label="${t('spots.search')}">`;
  const exp = `<button type="button" data-sp-act="csv" title="${t('spots.csvTip')}">${t('spots.csv')}</button><button type="button" data-sp-act="geojson">↓ GeoJSON</button>`;
  return `${tabs}${sub}<div class="sp-ctl rp-noprint">${f}${search}${exp}</div>`;
}
function table(ctx, res, s, items) {
  const esc = ctx.esc;
  if (!items.length) return `<div class="empty">${(s.list === 'missing' ? res.missing : s.list === 'onlyMine' ? res.onlyMine : res.care).length ? t('spots.emptyFiltered') : t(`spots.empty.${s.list}`, { own: esc(res.own), r: s.radius })}</div>`;
  const th = (l, tip, n) => `<th${n ? ' class="n"' : ''}>${tip ? `<abbr title="${esc(tip)}">${l}</abbr>` : l}</th>`;
  // Rang steht vor dem Namen (eine Spalte weniger; auf dem Telefon bleibt der Name als erste Spalte stehen)
  const place = (x, key) => `<div class="sp-pl"><span class="sp-rk">${x.rank}</span><div><button type="button" class="sp-link${x.label ? '' : ' none'}" data-sp-focus="${key}" title="${t('spots.showOnMap')}">${esc(nameOf(x))}</button><div class="sub-line">${coords(x)}</div></div></div>`;
  const dem = (x) => (x.demand ? `${ctx.fmt(x.demand.startsPerHour, 2)}${x.demand.startsPerHour > 0 && (x.demand.pct ?? 0) >= 0.01 ? `<div class="sub-line">${t('spots.abovePct', { p: ctx.fmt((x.demand.pct ?? 0) * 100) })}</div>` : ''}` : '–');
  const quota = (x) => (x.emptyShare == null ? `<span class="sub-line">${t('spots.noQuota')}</span>` : `${pct(ctx, x.emptyShare)}<div class="sub-line">${x.permEmpty ? `<span class="sp-flag"><i aria-hidden="true"></i>${t('spots.permEmpty')}</span>` : t('spots.runsN', { n: ctx.fmt(x.runs) })}</div>`);
  const demTip = res.demand ? t('spots.colDemandTip', { days: ctx.fmt(res.demand.days), h: ctx.fmt(res.demand.hours) }) : t('spots.noDemandData');
  let head, rows;
  const shown = items.slice(0, s.limit);
  if (s.list === 'missing') {
    head = th(t('spots.colPlace')) + th(t('spots.colOpsThere')) + th(t('spots.colDemand'), demTip, true) + th(t('spots.colOwnVeh'), t('spots.colOwnVehTip', { own: res.own, r: s.radius }), true)
      + th(t('spots.colNearOwn'), '', true) + th(t('spots.colScore'), t('spots.colScoreTip', { g: GROUP_MIN }), true) + th(t('spots.colWhy'));
    rows = shown.map(x => `<tr><td>${place(x, `missing:${x.rank}`)}</td><td><div class="sp-ops">${x.ops.map(o => `${opCell(ctx, o)}${x.byOp[o] > 1 ? ` <span class="muted">×${x.byOp[o]}</span>` : ''}`).join('')}</div></td>
      <td class="n">${dem(x)}</td><td class="n">${num(ctx, x.ownVehicles)}</td><td class="n">${x.nearestOwn ? `${meters(ctx, x.nearestOwn.d)}${x.nearestOwn.label ? `<div class="sub-line">${esc(x.nearestOwn.label)}</div>` : ''}` : '–'}</td>
      <td class="n">${ctx.fmt(x.score, 2)}</td><td class="sp-why">${esc(whyMissing(ctx, x))}</td></tr>`).join('');
  } else if (s.list === 'onlyMine') {
    head = th(t('spots.colSpot')) + th(t('spots.colEmptyShare'), t('spots.colEmptyShareTip', { near: SP.STATION_NEAR_M }), true) + th(t('spots.colBookable'), '', true)
      + th(t('spots.colVehNow'), t('spots.colVehNowTip', { own: res.own, r: s.radius }), true) + th(t('spots.colDemand'), demTip, true) + th(t('spots.colNearOther'), '', true);
    rows = shown.map(x => `<tr><td>${place(x, `onlyMine:${x.rank}`)}</td><td class="n">${quota(x)}</td><td class="n">${num(ctx, x.bookable)}</td><td class="n">${num(ctx, x.vehNow)}</td><td class="n">${dem(x)}</td>
      <td class="n">${x.nearestOther ? `${meters(ctx, x.nearestOther.d)}<div class="sub-line">${esc(x.nearestOther.operator)}</div>` : '–'}</td></tr>`).join('');
  } else {
    head = th(t('spots.colSpot')) + th(t('spots.colIssues')) + th(t('spots.colEmptyShare'), t('spots.colEmptyShareTip', { near: SP.STATION_NEAR_M }), true)
      + th(t('spots.colVehNow'), t('spots.colVehNowTip', { own: res.own, r: s.radius }), true) + th(t('spots.colAction'), t('spots.colActionTip'));
    rows = shown.map(x => `<tr><td>${place(x, `care:${x.rank}`)}</td><td>${x.issues.map(i => `<div class="sp-iss"><i aria-hidden="true"></i><span>${esc(issueText(ctx, i))}</span></div>`).join('')}</td>
      <td class="n">${quota(x)}</td><td class="n">${num(ctx, x.vehNow)}</td><td>${t(`spots.action.${x.action}`)}<div class="sub-line">parkingStatus ${x.export.parkingStatus} · deploymentStatus ${x.export.deploymentStatus}</div></td></tr>`).join('');
  }
  const more = items.length > s.limit ? `<div class="sp-ctl rp-noprint"><button type="button" data-sp-act="more">${t('spots.more', { n: ctx.fmt(Math.min(LIMIT, items.length - s.limit)), m: ctx.fmt(items.length - s.limit) })}</button></div>` : '';
  const title = t(`spots.list.${s.list}`);
  return `<div class="tbl" tabindex="0" role="region" aria-label="${esc(title)}"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>${more}`;
}
function notes(ctx, res, s) {
  const D = res.demand, z = s.zres?.state, out = [];
  out.push(t(`spots.export.${s.list}`));
  out.push(D ? t('spots.method', { r: s.radius, days: ctx.fmt(D.days), h: ctx.fmt(D.hours), p95: ctx.fmt(D.p95, 2), g: GROUP_MIN, d: res.dupM }) : `${t('spots.methodBase', { r: s.radius, g: GROUP_MIN, d: res.dupM })} ${t('spots.noDemandData')}`);
  if (z === 'loading') out.push(t('spots.zonesLoading'));
  else if (z === 'failed') out.push(t('spots.zonesFail'));
  else if (z === 'none') out.push(t('spots.zonesNone', { own: ctx.esc(res.own) }));
  else if (res.zones) out.push(t('spots.zonesNote', { files: ctx.fmt(res.zones.files), own: ctx.esc(res.own), n: ctx.fmt(res.zones.inNoFree) }));
  return `<div class="sp-method muted small">${out.map(p => `<p>${p}</p>`).join('')}</div>`;
}

// ---------- Karte ----------
function drawMap(el, ctx, res, s, items) {
  const box = el.querySelector('[data-sp-map]');
  if (!box || typeof L === 'undefined') return;
  if (!s.map || s.map.getContainer() !== box) {
    s.map?.remove(); s.ro?.disconnect();
    const still = reduced();
    s.map = L.map(box, { zoomControl: true, zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still, preferCanvas: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('app.openstreetmapContributors') }).addTo(s.map);
    s.layer = L.layerGroup().addTo(s.map); s.fitKey = null;
    // unsichtbar gezeichnet (Ansicht gewechselt): sobald der Kasten eine Größe hat, Größe nachziehen und einpassen
    if (typeof ResizeObserver === 'function') { s.ro = new ResizeObserver(() => { if (!s.map || !box.offsetWidth) return; s.map.invalidateSize(); if (s.pendingFit) { const b = s.pendingFit; s.pendingFit = null; s.map.fitBounds(b, { padding: [24, 24], maxZoom: 16, animate: false }); } }); s.ro.observe(box); }
  }
  s.layer.clearLayers(); s.marks = new Map();
  const renderer = L.canvas({ padding: 0.3 }), esc = ctx.esc;
  const panel = cssVar('--panel', '#fff'), fg2 = cssVar('--fg-2', '#555'), muted = cssVar('--muted', '#888'), warn = cssVar('--warn', '#c90');
  const ownC = ctx.opColor(res.own), pts = [];
  const add = (layer, key, html) => { if (html) layer.bindTooltip(html, { className: 'sp-tip', sticky: true }); layer.addTo(s.layer); if (key) s.marks.set(key, layer); return layer; };
  const ownSpots = res.spots.filter(x => x.operator === res.own);
  const ctxOwn = (skip) => { for (const o of ownSpots) { if (skip?.has(o.id)) continue; add(L.circleMarker([o.lat, o.lon], { renderer, radius: 3.5, color: ownC, weight: 1.5, fillColor: panel, fillOpacity: 1 }), null, `<b>${esc(nameOf(o))}</b><div>${esc(res.own)}</div>`); } };
  if (s.list === 'missing') {
    ctxOwn();
    for (const x of items) {
      const why = esc(whyMissing(ctx, x));
      const html = `<b>${x.rank}. ${esc(nameOf(x))}</b><div>${why}</div>`;
      add(L.circle([x.lat, x.lon], { renderer, radius: s.radius, color: fg2, weight: 1, dashArray: '4 4', fillColor: fg2, fillOpacity: 0.07 }), `missing:${x.rank}`, html);
      for (const m of x.members) { add(L.circleMarker([m.lat, m.lon], { renderer, radius: 5.5, color: panel, weight: 1.5, fillColor: ctx.opColor(m.operator), fillOpacity: 1 }), null, `<b>${esc(nameOf(m))}</b><div>${esc(m.operator)}${m.emptyShare != null ? ` · ${t('spots.emptyShareShort', { p: ctx.fmt(m.emptyShare * 100) })}` : ''}</div><div>${x.rank}. ${esc(nameOf(x))}</div>`); pts.push([m.lat, m.lon]); }
    }
    items.slice(0, RANK_LABELS).forEach(x => L.marker([x.lat, x.lon], { icon: L.divIcon({ className: 'sp-rank', html: `<span>${x.rank}</span>`, iconSize: [20, 20], iconAnchor: [10, 26] }), interactive: false, keyboard: false }).addTo(s.layer));
  } else if (s.list === 'onlyMine') {
    for (const f of res.spots) if (f.operator !== res.own) add(L.circleMarker([f.lat, f.lon], { renderer, radius: 2.5, color: muted, weight: 0, fillColor: muted, fillOpacity: 0.7, interactive: false }), null, null);
    const shownIds = new Set(items.map(x => x.id));
    ctxOwn(shownIds);
    for (const x of items) {
      add(L.circleMarker([x.lat, x.lon], { renderer, radius: 6, color: x.permEmpty ? ownC : panel, weight: x.permEmpty ? 2.5 : 1.5, fillColor: x.permEmpty ? panel : ownC, fillOpacity: 1 }), `onlyMine:${x.rank}`,
        `<b>${x.rank}. ${esc(nameOf(x))}</b><div>${esc(whyOnly(ctx, x))}</div>`);
      pts.push([x.lat, x.lon]);
    }
  } else {
    const shownIds = new Set(items.map(x => x.id));
    ctxOwn(shownIds);
    for (const x of items) {
      for (const i of x.issues) if (i.k === 'dup') L.polyline([[x.lat, x.lon], [i.lat, i.lon]], { renderer, color: warn, weight: 2, dashArray: '3 3', interactive: false }).addTo(s.layer);
      add(L.circleMarker([x.lat, x.lon], { renderer, radius: 6.5, color: warn, weight: 3, fillColor: ownC, fillOpacity: 1 }), `care:${x.rank}`, `<b>${x.rank}. ${esc(nameOf(x))}</b>${x.issues.map(i => `<div>${esc(issueText(ctx, i))}</div>`).join('')}`);
      pts.push([x.lat, x.lon]);
    }
  }
  if (!pts.length) for (const o of ownSpots) pts.push([o.lat, o.lon]);
  const key = `${res.ags}|${res.own}|${s.list}|${s.kind}`;
  if (pts.length && s.fitKey !== key) {
    const b = L.latLngBounds(pts); s.fitKey = key;
    if (box.offsetWidth) s.map.fitBounds(b, { padding: [24, 24], maxZoom: 16, animate: false }); else s.pendingFit = b;
  }
  setTimeout(() => s.map?.invalidateSize(), 0);
  const c = (op) => `style="--c:${esc(ctx.opColor(op))}"`;
  const lg = el.querySelector('[data-sp-legend]');
  if (s.list === 'missing') {
    const ops = [...new Set(items.flatMap(x => x.ops))].sort((a, b) => a.localeCompare(b, 'de'));
    lg.innerHTML = `${ops.map(o => `<span>${opCell(ctx, o)}</span>`).join('')}<span><i class="dot area"></i>${t('spots.legendPlace', { r: s.radius })}</span><span><i class="dot" ${c(res.own)}></i>${t('spots.legendOwn', { own: esc(res.own) })}</span>`;
  } else if (s.list === 'onlyMine') {
    lg.innerHTML = `<span><i class="dot fill" ${c(res.own)}></i>${t('spots.legendUsed')}</span><span><i class="dot" ${c(res.own)}></i>${t('spots.legendEmpty')}</span><span><i class="dot grey"></i>${t('spots.legendForeign')}</span>`;
  } else {
    lg.innerHTML = `<span><i class="dot ring" ${c(res.own)}></i>${t('spots.legendCare')}</span><span><i class="dot" ${c(res.own)}></i>${t('spots.legendOwn', { own: esc(res.own) })}</span>`;
  }
}
function focus(el, s, key) {
  const m = s.marks?.get(key); if (!m || !s.map) return;
  const ll = m.getLatLng(); s.map.setView(ll, Math.max(s.map.getZoom(), 17), { animate: !reduced() });
  m.openTooltip(ll);
  el.querySelector('[data-sp-map]')?.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
}

// ---------- Export ----------
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` })); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const fileName = (s, ext) => `${t(`spots.file.${s.list}`)}_${s.ags}_${String(s.res.own).replace(/[^\p{L}\d]+/gu, '-')}_${new Date(s.fleet.at || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;

// ---------- Ansicht ----------
function pickMunicipality(el, ctx) {
  const m = Object.values(ctx.state.latest?.municipalities || {}).map(x => ({ ...x, n: Object.keys(x.operators || {}).length, v: Object.values(x.operators || {}).reduce((a, o) => a + (o.total || 0), 0) }))
    .filter(x => x.n >= 2).sort((a, b) => b.v - a.v).slice(0, 24);
  el.innerHTML = `<div class="panel-head"><div><h2>${t('spots.title')}</h2><div class="sub">${t('spots.pickSub')}</div></div></div><div class="sp-chips">${m.map(x => `<button type="button" class="chip" data-ags="${ctx.esc(x.ags)}">${ctx.esc(x.name)} <span class="muted">${ctx.esc(ctx.fmt(x.n))} · ${ctx.esc(ctx.fmt(x.v))}</span></button>`).join('')}</div>`;
}
function analysis(s) {
  const z = zonesFor(s.el, s);
  const key = [s.ags, s.own, s.radius, s.kind, z.state].join('|');
  if (s.resKey !== key || !s.res) {
    s.res = SP.analyzeSpots(s.fleet, { ags: s.ags, own: s.own, radiusM: s.radius, kind: s.kind, quota: s.quota, demand: s.demand, zones: z.state === 'ok' || z.state === 'none' ? (z.fcs || []) : null });
    if (s.res.own !== s.own) { s.own = s.res.own; return analysis(s); }
    s.resKey = key;
  }
  return s.res;
}
function drawList(el, ctx, s) {
  const items = filtered(s.res, s);
  el.querySelector('[data-sp-items]').innerHTML = table(ctx, s.res, s, items);
  el.querySelector('[data-sp-notes]').innerHTML = notes(ctx, s.res, s);
  drawMap(el, ctx, s.res, s, items);
}
function draw(el, ctx, s) {
  s.el = el;
  const res = analysis(s);
  const name = ctx.muniName?.(s.ags) || s.ags;
  const head = `<div class="panel-head"><div><h2>${t('spots.title')} · ${ctx.esc(name)}</h2><div class="sub">${t('spots.sub', { at: stamp(s.fleet.at) })}</div></div></div>`;
  if (!res.total.spots && !s.allCount) { s.map?.remove(); s.map = null; el.innerHTML = `${head}<div class="empty">${t('spots.none')}</div>`; return; }
  const feed = `<div class="note sp-feed">${t('spots.feedNote', { runs: ctx.fmt(res.total.maxRuns), h: ctx.fmt(res.total.maxRuns / 3), near: SP.STATION_NEAR_M })}</div>`;
  const top = `${head}${controls(ctx, res, s)}${res.total.spots ? `${lead(ctx, res)}${feed}${overview(ctx, res, s)}` : `<div class="empty">${t('spots.noneVirtual')}</div>`}`;
  if (!el.querySelector('[data-sp-map]')) {
    s.map?.remove(); s.map = null;
    el.innerHTML = `<div data-sp-top></div><div data-sp-tools></div><div class="sp-map" data-sp-map role="region" aria-label="${t('spots.mapAria')}"></div><div class="sp-keys" data-sp-legend></div><div data-sp-items style="margin-top:var(--s3)"></div><div data-sp-notes></div>`;
  }
  el.querySelector('[data-sp-top]').innerHTML = top;
  const hasSpots = res.total.spots > 0;
  el.querySelector('[data-sp-tools]').innerHTML = hasSpots ? tools(ctx, res, s) : '';
  el.querySelector('[data-sp-map]').hidden = !hasSpots; el.querySelector('[data-sp-legend]').hidden = !hasSpots;
  if (hasSpots) drawList(el, ctx, s); else { el.querySelector('[data-sp-items]').innerHTML = ''; el.querySelector('[data-sp-notes]').innerHTML = ''; }
}
const refocus = (el, sel) => el.querySelector(sel)?.focus();
// Neu zeichnen ohne Fokusverlust (z. B. wenn die Zonen nachträglich geladen sind): Element über sein data-sp-Attribut wiederfinden
const FOCUS_ATTRS = ['data-sp', 'data-sp-kind', 'data-sp-list', 'data-sp-minops', 'data-sp-op', 'data-sp-only', 'data-sp-issue', 'data-sp-act', 'data-sp-q', 'data-sp-focus'];
function keepFocus(el, fn) {
  const a = typeof document !== 'undefined' ? document.activeElement : null, attr = a && el.contains(a) ? FOCUS_ATTRS.find(x => a.hasAttribute(x)) : null;
  const sel = attr ? `${a.tagName.toLowerCase()}[${attr}="${CSS.escape(a.getAttribute(attr))}"]` : null;
  fn();
  if (sel && !el.contains(a)) el.querySelector(sel)?.focus({ preventScroll: true });
}

/** Panel zeichnen (Ansicht „Spot-Abgleich“); braucht eine Gemeinde oben im Gebiet */
export async function renderSpots(el, ctx) {
  if (!el) return;
  css(); el.classList.add('sp-root');
  const s = st(el); s.ctx = ctx; s.el = el; const tok = ++s.tok;
  const ags = ctx.state.scope && ctx.state.scope !== 'DE' ? ctx.state.scope : null;
  if (!s.bound) {
    s.bound = true;
    el.addEventListener('change', (e) => {
      const k = e.target.dataset?.sp; if (!k || !s.fleet) return;
      if (k === 'radius') s.radius = +e.target.value; else if (k === 'own') { s.own = e.target.value; s.hide.clear(); s.fitKey = null; }
      s.limit = LIMIT; draw(el, s.ctx, s); refocus(el, `select[data-sp="${k}"]`);
    });
    let qT = null;
    el.addEventListener('input', (e) => { if (!e.target.matches?.('[data-sp-q]') || !s.res) return; s.q = e.target.value; s.limit = LIMIT; clearTimeout(qT); qT = setTimeout(() => drawList(el, s.ctx, s), 150); });
    el.addEventListener('click', (e) => {
      const ch = e.target.closest('button[data-ags]'); if (ch && !s.fleet) { s.ctx.setScope?.(ch.dataset.ags); return; }
      if (!s.fleet || !s.res) return;
      const b = e.target.closest('button'); if (!b || !el.contains(b)) return;
      const d = b.dataset, re = (sel) => { draw(el, s.ctx, s); refocus(el, sel); };
      if (d.spKind) { if (s.kind !== d.spKind) { s.kind = d.spKind; s.hide.clear(); s.fitKey = null; s.limit = LIMIT; } return re(`button[data-sp-kind="${d.spKind}"]`); }
      if (d.spList) { s.list = d.spList; s.limit = LIMIT; return re(`button[data-sp-list="${d.spList}"]`); }
      if (d.spMinops) { s.minOps = +d.spMinops; s.limit = LIMIT; return re(`button[data-sp-minops="${d.spMinops}"]`); }
      if (d.spOp) { if (s.hide.has(d.spOp)) s.hide.delete(d.spOp); else s.hide.add(d.spOp); return re(`button[data-sp-op="${CSS.escape(d.spOp)}"]`); }
      if (d.spOnly) { s.only = d.spOnly; s.limit = LIMIT; return re(`button[data-sp-only="${d.spOnly}"]`); }
      if (d.spIssue) { if (s.issues.has(d.spIssue)) s.issues.delete(d.spIssue); else s.issues.add(d.spIssue); return re(`button[data-sp-issue="${d.spIssue}"]`); }
      if (d.spFocus) return focus(el, s, d.spFocus);
      if (d.spAct === 'more') { s.limit += LIMIT; drawList(el, s.ctx, s); return; }
      if (d.spAct === 'csv') download(fileName(s, 'csv'), SP.spotsBackendCsv(filtered(s.res, s), { name: s.ctx.muniName?.(s.ags) || 'Spot' }), 'text/csv');
      if (d.spAct === 'geojson') download(fileName(s, 'geojson'), JSON.stringify(SP.spotsGeoJson(filtered(s.res, s), { list: s.list, own: s.res.own, radiusM: s.radius, at: s.fleet.at, reason: (x) => reasonOf(s.ctx, s.list, x) }), null, 1), 'application/geo+json');
    });
  }
  if (!ags) { s.fleet = null; s.res = null; s.map?.remove(); s.map = null; pickMunicipality(el, ctx); return; }
  const land = ctx.state.latest?.municipalities?.[ags]?.state;
  if (!land) { s.fleet = null; s.res = null; el.innerHTML = `<div class="panel-head"><div><h2>${t('spots.title')}</h2></div></div><div class="empty">${t('spots.none')}</div>`; return; }
  if (s.ags !== ags) { s.own = null; s.kind = null; s.hide.clear(); s.fitKey = null; s.q = ''; s.limit = LIMIT; s.zkey = null; }
  if (!s.fleet || s.ags !== ags) { s.map?.remove(); s.map = null; el.innerHTML = `<div class="panel-head"><div><h2>${t('spots.title')}</h2></div></div><div class="empty">${t('spots.loading')}</div>`; }
  const [fleet, quota, dem] = await Promise.all([loadFleet(ctx, land), Promise.resolve(ctx.loadOnce?.('quota', 'stations-quota.json')).catch(() => null), loadDemand(ctx, land, ags)]);
  if (tok !== s.tok) return;
  if (!fleet) { s.fleet = null; s.res = null; el.innerHTML = `<div class="panel-head"><div><h2>${t('spots.title')}</h2></div></div><div class="empty">${t('spots.loadError')}</div>`; return; }
  const fresh = s.fleet !== fleet || s.quota !== quota || s.demand !== (dem?.model ?? null);
  s.fleet = fleet; s.quota = quota; s.demand = dem?.model ?? null; s.ags = ags; s.land = land;
  if (fresh) { s.res = null; s.resKey = null; }
  s.allCount = SP.spotsOf(fleet, { ags, quota, kind: 'all' }).length;
  if (!s.kind) s.kind = SP.spotsOf(fleet, { ags, quota, kind: 'virtual' }).length ? 'virtual' : 'all';
  if (!s.own) { // Standard: Anbieter mit den meisten Spots; ist oben ein Anbieter gewählt, der hier Spots hat, dieser
    const n = new Map(); for (const x of SP.spotsOf(fleet, { ags, quota, kind: s.kind })) n.set(x.operator, (n.get(x.operator) || 0) + 1);
    const pref = ctx.state.operator && ctx.state.operator !== 'all' && n.get(ctx.state.operator) ? ctx.state.operator : null;
    s.own = pref || [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'))[0]?.[0] || null;
  }
  if (s.map && !el.querySelector('[data-sp-map]')) { s.map.remove(); s.map = null; }
  draw(el, ctx, s);
}
/** Sprachwechsel: Karte samt Namensnennung neu aufbauen */
export function relabelSpots(el) { const s = el && S.get(el); if (!s) return; s.ro?.disconnect(); s.map?.remove(); s.map = null; s.fitKey = null; if (s.fleet) el.innerHTML = ''; } // Gerüst (aria-label der Karte) neu
