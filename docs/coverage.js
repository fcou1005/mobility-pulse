// Mobility Pulse — Abdeckung: Städte laut Anbieter-Website gegen Feeds mit Fahrzeugen, stille Feeds, nicht offene Feeds und fehlende Feeds.
// Eigenständiges Modul; app.js übergibt ctx = { state, CFG, esc, getJson, setScope }. Daten: coverage.json (Sammler, lib/pulse-coverage.js).
// Alle Werte aus Daten gehen durch ctx.esc; Texte im Wörterbuch web/i18n.js (Schlüssel cov.*), Zahlen und Daten über i18n.js.
import { t, has, lang, numFmt, dateFmt } from './i18n.js?v=mwchnuax';
import { csvCell } from './pulse-ops.js?v=mwchnuax';

const CAT = (c) => (has(`cov.cat.${c}`) ? t(`cov.cat.${c}`) : c);
const SHORT = (c) => t(`cov.short.${c}`);
const ST = (s) => (s && has(`cov.st.${s}`) ? t(`cov.st.${s}`) : s || '');
const n0 = (x) => numFmt(0).format(x || 0);
const pct = (x) => `${numFmt(0).format(Math.round(x * 100))} %`;
const dayFmt = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)) : '–');
const stampFmt = (ms) => (ms ? dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date(ms)) : '–');

// Kategorie → [Symbol, Statusklasse]; Farbe nie allein (Symbol + Text)
// veraltet = Feed liefert nur alte Stände, nicht erreichbar = Abruf scheitert (lib/pulse-coverage.js CATS)
const CAT_ORDER = ['abgedeckt', 'gesperrt', 'feed-still', 'veraltet', 'nicht-erreichbar', 'kein-feed', 'nicht-gelistet', 'eingestellt', 'aktiv', 'still'];
const CAT_MARK = { abgedeckt: ['✓', 'ok'], gesperrt: ['⊘', 'info'], 'feed-still': ['!', 'near'], veraltet: ['◔', 'near'], 'nicht-erreichbar': ['⊗', 'over'], 'kein-feed': ['✕', 'over'], 'nicht-gelistet': ['+', 'hint'], eingestellt: ['–', 'none'], aktiv: ['✓', 'ok'], still: ['!', 'near'] };
const badge = (c) => `<span class="rp-status ${CAT_MARK[c]?.[1] || 'none'}"><i aria-hidden="true">${CAT_MARK[c]?.[0] || '?'}</i>${CAT(c) || c}</span>`;

const S = new WeakMap();
const CACHE = new Map();
const st = (el) => { let s = S.get(el); if (!s) { s = { op: 'all', cat: 'all', land: 'all', q: '', listOnly: true, sort: { key: 'cat', dir: 'asc' }, limit: 100 }; S.set(el, s); } return s; };
/** Zwischenspeicher leeren (neuer Sammler-Lauf) */
export function resetCoverageCache() { CACHE.clear(); }
function load(ctx) {
  const at = ctx.state?.latest?.at || '';
  const url = `${ctx.CFG.DATA}coverage.json${at ? `?t=${at}` : ''}`;
  if (!CACHE.has(url)) CACHE.set(url, Promise.resolve(ctx.getJson(url, { timeout: 60000 })).then((r) => (r?.ok ? r.json : null), () => null));
  return CACHE.get(url);
}

const CSS = `
.cov-ctl{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;margin:var(--s2) 0 var(--s3)}
.cov-ctl label{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--fg-2)}
.cov-meter{display:flex;align-items:center;gap:8px;min-width:150px}
.cov-meter .bar{flex:1;height:8px;border-radius:4px;background:var(--line);overflow:hidden;min-width:60px}
.cov-meter .bar span{display:block;height:100%;border-radius:4px;background:var(--ok)}
.cov-meter b{font-weight:600;font-variant-numeric:tabular-nums;min-width:3.2em;text-align:right}
.cov-n button{all:unset;font:inherit;cursor:pointer;font-variant-numeric:tabular-nums;padding:2px 6px;border-radius:6px}
.cov-op{white-space:nowrap}.cov-op .sub-line{white-space:nowrap}
a.cov-ext{margin-left:2px;text-decoration:none;color:var(--fg-2);display:inline-block;min-width:24px;min-height:24px;line-height:24px;text-align:center;vertical-align:middle;border-radius:4px}a.cov-ext:hover{color:var(--accent)}
.cov-th{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}.cov-th i{font-style:normal}
.cov-n button:hover,.cov-n button:focus-visible{background:var(--panel-2);outline:2px solid var(--accent);outline-offset:-2px}
.cov-n .z{color:var(--muted)}
tr.cov-sel td{background:color-mix(in srgb,var(--accent) 10%,var(--panel))}
.cov-src a{color:inherit}
.cov-foot{margin-top:var(--s2)}
`;
let cssDone = false;
const css = () => { if (cssDone || typeof document === 'undefined') return; cssDone = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); };

function rowsFor(cov, s, ctx) {
  const scope = ctx.state?.scope;
  const q = s.q.trim().toLowerCase();
  return cov.rows.filter((r) => (s.op === 'all' || r.opKey === s.op) && (s.cat === 'all' || r.cat === s.cat) && (s.land === 'all' || r.state === s.land)
    && (!s.listOnly || r.claimed !== null) && (!q || r.city.toLowerCase().includes(q) || (r.claimName || '').toLowerCase().includes(q))
    && (!scope || scope === 'DE' || r.ags === scope));
}
const SORTS = {
  cat: (a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat) || b.vehicles - a.vehicles || a.city.localeCompare(b.city, 'de'),
  city: (a, b) => a.city.localeCompare(b.city, 'de') || a.op.localeCompare(b.op, 'de'),
  op: (a, b) => a.op.localeCompare(b.op, 'de') || CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat),
  vehicles: (a, b) => a.vehicles - b.vehicles,
  last: (a, b) => String(a.lastActive || '').localeCompare(String(b.lastActive || '')),
};

function claimCell(r, op, esc) {
;
  if (r.claimed === null) return `<span class="muted">${t('cov.noList')}</span>`;
  if (r.claimed === false) return t('cov.no');
  const label = r.claimRegion ? t('cov.region', { r: esc(r.claimRegion) }) : t('cov.yes');
  const src = r.claimSrc || op?.claimSrc;
  const link = /^https?:/i.test(src || '') ? `<a href="${esc(src)}" target="_blank" rel="noopener" title="${esc(t('cov.sourceLink'))}">${label}</a>` : label;
  return `${link}${r.claimWeak ? `<sup title="${esc(t('cov.weak'))}">¹</sup>` : ''}${r.claimName ? `<div class="sub-line">„${esc(r.claimName)}“</div>` : ''}`;
}
function feedCell(r, cov, esc) {
;
  const parts = (r.src || []).slice(0, 2).map((id) => {
    const x = cov.sources?.[id]; if (!x) return '';
    const name = esc(x.name || id), stt = ST(x.status) || esc(x.status || '');
    return `<div class="cov-src">${/^https?:/i.test(x.url || '') ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${name}</a>` : name} <span class="muted">· ${stt}</span></div>`;
  });
  if ((r.src || []).length > 2) parts.push(`<div class="muted">+${(r.src.length - 2)}</div>`);
  if (r.gap) parts.push(`<div class="muted small">${r.gap.via ? t('cov.via', { p: esc(r.gap.via) }) : ''}${r.gap.since ? ` ${t('cov.since', { d: dayFmt(r.gap.since) })}` : ''}</div>`);
  return `${badge(r.cat)}${parts.join('')}`;
}
function noteCell(r, cov, esc) {
  const out = [];
  if (r.partOf) out.push(t('cov.partOf', { c: esc(r.partOf) }));
  if (r.gap?.note != null && cov.notes?.[r.gap.note]) out.push(esc(cov.notes[r.gap.note]) + (r.gap.assumed ? ` ${t('cov.assumed')}` : ''));
  if (r.guessed) out.push(t('cov.guessed'));
  if (r.named) out.push(t('cov.namedNoData', { f: esc(r.named) }));
  if (r.probes) out.push(t('cov.probes'));
  if (r.claimAmbiguous) out.push(t('cov.ambiguous', { n: r.claimAmbiguous }));
  if (r.unresolved) out.push(t('cov.unresolved'));
  return out.length ? `<div class="small">${out.map((x) => `<div>${x}</div>`).join('')}</div>` : '';
}

function opTable(cov, s, ctx) {
  const esc = ctx.esc;
  const ops = cov.operators.filter((o) => !s.listOnly || o.hasList);
  const num = (o, c) => { const v = o.cats[c] || 0; return `<td class="n cov-n">${v ? `<button type="button" data-cov-op="${esc(o.opKey)}" data-cov-cat="${c}" title="${esc(CAT(c))}">${n0(v)}</button>` : '<span class="z">0</span>'}</td>`; };
  const rows = ops.map((o) => {
    const listed = o.hasList ? ['abgedeckt', 'gesperrt', 'feed-still', 'veraltet', 'nicht-erreichbar', 'kein-feed'].reduce((a, c) => a + (o.cats[c] || 0), 0) : 0;
    const rate = listed ? (o.cats.abgedeckt || 0) / listed : null;
    const meter = rate == null ? `<span class="muted">${t('cov.noList')}</span>`
      : `<div class="cov-meter" title="${esc(t('cov.rateTip', { n: o.cats.abgedeckt || 0, m: listed }))}"><div class="bar" role="img" aria-label="${esc(t('cov.rateTip', { n: o.cats.abgedeckt || 0, m: listed }))}"><span style="width:${Math.round(rate * 100)}%"></span></div><b>${pct(rate)}</b></div>`;
    const srcLink = o.hasList && /^https?:/i.test(o.claimSrc || '') ? `<a class="cov-ext" href="${esc(o.claimSrc)}" target="_blank" rel="noopener" title="${esc(t('cov.sourceLink'))}" aria-label="${esc(`${t('cov.sourceLink')}: ${o.op}`)}">↗</a>` : '';
    const stray = o.stray ? `<div class="sub-line muted" title="${esc(t('cov.stray', { g: n0(o.stray.gemeinden), v: n0(o.stray.fahrzeuge), min: cov.minStray }))}">${t('cov.strayShort', { g: n0(o.stray.gemeinden), v: n0(o.stray.fahrzeuge) })}</div>` : '';
    return `<tr${s.op === o.opKey ? ' class="cov-sel"' : ''}><td class="cov-op"><button type="button" class="rp-city" data-cov-op="${esc(o.opKey)}" aria-pressed="${s.op === o.opKey}">${esc(o.op)}</button>${o.claimWeak ? `<sup title="${esc(t('cov.weak'))}">¹</sup>` : ''}${srcLink}${stray}</td>
      <td class="n">${o.hasList ? n0(listed) : '–'}</td><td>${meter}</td>${num(o, 'abgedeckt')}${num(o, 'gesperrt')}${num(o, 'feed-still')}${num(o, 'veraltet')}${num(o, 'nicht-erreichbar')}${num(o, 'kein-feed')}${num(o, 'nicht-gelistet')}${num(o, 'eingestellt')}<td class="n">${n0(o.vehicles)}</td></tr>`;
  }).join('');
  const th = (c) => `<th class="n" title="${esc(CAT(c))}"><span class="rp-status ${CAT_MARK[c][1]} cov-th"><i aria-hidden="true">${CAT_MARK[c][0]}</i>${SHORT(c)}</span></th>`;
  return `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('cov.opTableAria'))}"><table><thead><tr><th>${t('cov.op')}</th><th class="n">${t('cov.listed')}</th><th>${t('cov.rate')}</th>${th('abgedeckt')}${th('gesperrt')}${th('feed-still')}${th('veraltet')}${th('nicht-erreichbar')}${th('kein-feed')}${th('nicht-gelistet')}${th('eingestellt')}<th class="n">${t('cov.vehTotal')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function controls(cov, s, ctx) {
  const esc = ctx.esc;
  const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
  const ops = cov.operators.filter((o) => !s.listOnly || o.hasList).map((o) => [o.opKey, o.op]).sort((a, b) => a[1].localeCompare(b[1], 'de'));
  const lands = [...new Set(cov.rows.map((r) => r.state).filter(Boolean))].sort();
  return `<div class="cov-ctl rp-noprint">
    <label>${t('cov.op')} <select data-cov="op">${opt('all', t('cov.allOps'), s.op)}${ops.map(([k, l]) => opt(k, l, s.op)).join('')}</select></label>
    <label>${t('cov.cat')} <select data-cov="cat">${opt('all', t('cov.allCats'), s.cat)}${CAT_ORDER.map((c) => opt(c, CAT(c), s.cat)).join('')}</select></label>
    <label>${t('cov.state')} <select data-cov="land">${opt('all', t('cov.allStates'), s.land)}${lands.map((l) => opt(l, l, s.land)).join('')}</select></label>
    <label><input type="search" data-cov="q" value="${esc(s.q)}" placeholder="${esc(t('cov.search'))}" aria-label="${esc(t('cov.search'))}" style="width:11em"></label>
    <label><input type="checkbox" data-cov="listOnly"${s.listOnly ? ' checked' : ''}> ${t('cov.listOnly')}</label>
    <button type="button" data-cov-act="csv">${t('cov.csv')}</button></div>`;
}

function detailTable(cov, list, s, ctx) {
  const esc = ctx.esc;
  const ops = new Map(cov.operators.map((o) => [o.opKey, o]));
  const cols = [['city', t('cov.city')], ['op', t('cov.op')], [null, t('cov.claimed')], ['cat', t('cov.feed')], ['vehicles', t('cov.vehicles'), true], ['last', t('cov.last'), true], [null, t('cov.note')]];
  const head = `<thead><tr>${cols.map(([k, l, n]) => { if (!k) return `<th>${l}</th>`; const on = s.sort.key === k; return `<th class="${n ? 'n' : ''}" aria-sort="${on ? (s.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="rp-sort${on ? ' on' : ''}" data-cov-sort="${k}">${l}<span aria-hidden="true">${on ? (s.sort.dir === 'asc' ? '▲' : '▼') : ''}</span></button></th>`; }).join('')}</tr></thead>`;
  const city = (r) => {
    const label = `${esc(r.city)}${r.state ? ` <span class="muted">(${esc(r.state)})</span>` : ''}`;
    return r.ags && typeof ctx.setScope === 'function' ? `<button type="button" class="rp-city" data-ags="${esc(r.ags)}">${label}</button>` : label;
  };
  const body = list.slice(0, s.limit).map((r) => `<tr><td>${city(r)}</td><td>${esc(r.op)}</td><td>${claimCell(r, ops.get(r.opKey), esc)}</td><td>${feedCell(r, cov, esc)}</td>
    <td class="n">${r.vehicles ? n0(r.vehicles) : '<span class="muted">0</span>'}</td><td class="n">${r.vehicles ? t('cov.now') : r.lastActive ? dayFmt(r.lastActive) : '–'}</td><td>${noteCell(r, cov, esc)}</td></tr>`).join('');
  const rest = list.length - s.limit;
  const more = rest > 0 ? `<div class="rp-ctl rp-noprint" style="margin-top:var(--s2)"><button type="button" data-cov-act="more">${rest <= 100 ? t('common.showAllMore', { n: n0(rest) }) : t('common.show100More', { n: n0(rest - 100) })}</button></div>` : '';
  return `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('cov.cityTableAria'))}"><table>${head}<tbody>${body}</tbody></table></div>${more}`;
}

/** CSV der Abdeckung; Zellen mit Formel-Schutz (Anbieter- und Quellennamen stammen aus den Feeds) wie alle übrigen Exporte */
export function csvOf(cov, list) {
  const sep = lang() === 'en' ? ',' : ';';
  const cell = (v) => csvCell(v, sep);
  const head = [t('cov.city'), 'AGS', t('cov.state'), t('cov.op'), t('cov.claimed'), t('cov.cat'), t('cov.vehicles'), t('cov.last'), t('cov.feed'), t('cov.note')];
  const rows = list.map((r) => [r.city, r.ags || '', r.state || '', r.op, r.claimed === null ? t('cov.noList') : r.claimed ? (r.claimRegion ? t('cov.region', { r: r.claimRegion }) : t('cov.yes')) : t('cov.no'), CAT(r.cat) || r.cat,
    r.vehicles, r.vehicles ? t('cov.now') : r.lastActive || '', (r.src || []).map((id) => `${cov.sources?.[id]?.name || id} (${ST(cov.sources?.[id]?.status)})`).join(' | '),
    [r.partOf ? t('cov.partOf', { c: r.partOf }) : '', r.gap?.via ? t('cov.via', { p: r.gap.via }) : '', r.claimWeak ? t('cov.weak') : ''].filter(Boolean).join(' · ')]);
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(sep)).join('\r\n');
}
function download(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

function draw(el, ctx, cov) {
  const s = st(el), esc = ctx.esc;
  const all = rowsFor(cov, { ...s, cat: 'all', op: 'all', land: 'all', q: '' }, ctx);
  const list = rowsFor(cov, s, ctx);
  const cmp = SORTS[s.sort.key] || SORTS.cat;
  list.sort((a, b) => (s.sort.dir === 'desc' ? -cmp(a, b) : cmp(a, b)));
  const unres = (cov.unresolved || []).filter((u) => u.grund === 'unbekannt');
  el.innerHTML = `<div class="panel-head"><div><h2>${t('cov.title')}</h2><div class="sub">${t('cov.sub', { claims: dayFmt(cov.claimsDate), run: stampFmt(cov.generatedAt) })}</div></div></div>
    ${opTable(cov, s, ctx)}${controls(cov, s, ctx)}
    <div class="muted small" style="margin-bottom:var(--s2)" aria-live="polite">${list.length === all.length ? t('cov.rows', { n: n0(list.length) }) : t('cov.filtered', { n: n0(list.length), m: n0(all.length) })}</div>
    ${detailTable(cov, list, s, ctx)}
    <div class="muted small cov-foot">${t('cov.method', { min: cov.minStray })}${cov.operators.some((o) => o.claimWeak) ? `<div>¹ ${t('cov.weak')}</div>` : ''}${unres.length ? `<div>${t('cov.unresolvedList', { list: unres.slice(0, 30).map((u) => `${esc(u.op)}: ${esc(u.ort)}`).join(', ') + (unres.length > 30 ? ' …' : '') })}</div>` : ''}</div>`;
  el._covList = list;
  // Fokus zurück, wenn ein Klick die Tabelle neu aufgebaut hat (Ort öffnen, weitere Zeilen)
  if (s.refocus) { const f = el.querySelector(s.refocus.sel) || el.querySelectorAll('.tbl tbody tr')[s.refocus.row]?.querySelector('td'); if (f) { if (f.tagName === 'TD') f.tabIndex = -1; f.focus(); } s.refocus = null; }
}

/** Panel zeichnen (Ansicht „Quellen“) */
export async function renderCoverage(el, ctx) {
  if (!el) return;
  css();
  const s = st(el); s.ctx = ctx;
  const tok = (s.tok = (s.tok || 0) + 1);
  if (!s.cov) el.innerHTML = `<div class="panel-head"><div><h2>${t('cov.title')}</h2></div></div><div class="empty">${t('cov.loading')}</div>`;
  const cov = await load(ctx);
  if (tok !== s.tok) return;
  if (!cov?.rows) { el.innerHTML = `<div class="panel-head"><div><h2>${t('cov.title')}</h2></div></div><div class="empty">${t('cov.none')}<div class="muted small">${t('cov.noneHint')}</div></div>`; return; }
  s.cov = cov;
  if (!s.bound) {
    s.bound = true;
    const redraw = () => draw(el, s.ctx, s.cov);
    el.addEventListener('change', (e) => {
      const k = e.target.dataset?.cov; if (!k) return;
      s[k] = k === 'listOnly' ? e.target.checked : e.target.value; s.limit = 100;
      if (k === 'op' && s.op !== 'all' && !s.cov.operators.find((o) => o.opKey === s.op)?.hasList) s.listOnly = false;
      redraw();
    });
    let tq = 0;
    el.addEventListener('input', (e) => { if (e.target.dataset?.cov !== 'q') return; clearTimeout(tq); tq = setTimeout(() => { s.q = e.target.value; s.limit = 100; const pos = e.target.selectionStart; redraw(); const i = el.querySelector('input[data-cov="q"]'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch { /* */ } } }, 200); });
    el.addEventListener('click', (e) => {
      const so = e.target.closest('button[data-cov-sort]');
      if (so) { const k = so.dataset.covSort; s.sort = s.sort.key === k ? { key: k, dir: s.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: k === 'vehicles' || k === 'last' ? 'desc' : 'asc' }; redraw(); el.querySelector(`button[data-cov-sort="${k}"]`)?.focus(); return; }
      const ob = e.target.closest('button[data-cov-op]');
      if (ob) { const k = ob.dataset.covOp, c = ob.dataset.covCat; const same = s.op === k && (c ? s.cat === c : s.cat === 'all'); s.op = same ? 'all' : k; s.cat = same ? 'all' : c || 'all'; s.limit = 100; s.refocus = { sel: `button[data-cov-op="${CSS.escape(k)}"]${c ? `[data-cov-cat="${CSS.escape(c)}"]` : ':not([data-cov-cat])'}` }; redraw(); return; }
      const cb = e.target.closest('button.rp-city[data-ags]');
      if (cb && typeof s.ctx.setScope === 'function') { s.refocus = { sel: `button.rp-city[data-ags="${CSS.escape(cb.dataset.ags)}"]` }; s.ctx.setScope(cb.dataset.ags); return; }
      const a = e.target.closest('button[data-cov-act]');
      if (a?.dataset.covAct === 'more') { const n = s.limit, rest = (el._covList?.length || 0) - n; s.limit = rest <= 100 ? Infinity : n + 100; s.refocus = { sel: null, row: n }; redraw(); }
      if (a?.dataset.covAct === 'csv') download(`mobility-pulse_${lang() === 'en' ? 'coverage' : 'abdeckung'}_${new Date(s.cov.generatedAt || Date.now()).toISOString().slice(0, 10)}.csv`, csvOf(s.cov, el._covList || []));
    });
  }
  draw(el, ctx, cov);
}
