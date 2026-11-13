// Dashboard: Router: Ansichten, nachgeladene Module, nur die sichtbare Ansicht zeichnen (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as R from './pulse-report.js';
import { t, lang, ensureI18n } from './i18n.js';
import { $, $$, CFG, QS, TYPE, esc, fmt, gl, isClient, opColor, state } from './app-core.js';
import { LITE_VIEWS, clearNotice, ensureFullLatest, getJsonShared, loadBoundaries, loadCatalog, loadHistory, notice } from './app-load.js';
import { muniName } from './app-scope.js';
import { liveFetch, pendingLive, setPendingLive } from './app-live.js';
import { renderHeader, renderLive } from './app-lang.js';
import { fitMap } from './app-map.js';
import { renderCities, renderLab } from './app-energy.js';
import { loadGroups, renderSignals } from './app-signals.js';
import { renderCoverage, renderPricing, renderShareChart, renderSources } from './app-sources.js';
import { econFor, loadCells, loadEvents, loadOnce, loadUsageIndex, renderUsage } from './app-usage.js';
import { renderCalibPanel } from './app-calib.js';
import { TYPE_FILTER, populateOperators, populateScope, renderFilterSum, scheduleToc } from './app.js';

// ---------- Ansichtsmodule bei Bedarf laden (S3.4): Modul und sein Wörterbuchbereich zusammen; M[k] = geladenes Modul ----------
export const LAZY = { ops: [() => import('./ops.js'), 'ops'], rp: [() => import('./report.js'), 'report'], fl: [() => import('./flows.js'), 'flows'], cov: [() => import('./coverage.js'), 'coverage'],
  cmp: [() => import('./compare.js'), 'compare'], sp: [() => import('./spots.js'), 'spots'], fv: [() => import('./forecast.js'), 'forecast'], st: [() => import('./status.js'), 'status'] };
export const M = {}, MP = {};
// Teil nicht ladbar (z. B. nach einer neuen Version liegen die Teile unter anderen Namen): Hinweis zum Neuladen, nächster Versuch lädt erneut
export const mod = (k) => MP[k] || (MP[k] = Promise.all([LAZY[k][0](), ensureI18n([LAZY[k][1]])]).then(([m]) => { M[k] = m; if (k === 'ops') m.initOps(opsCtx()); return m; })
  .catch((e) => { delete MP[k]; notice(() => t('app.chunkReload'), 'warn', 'chunk'); throw e; }));
export const renderOps = () => mod('ops').then(m => m.renderOps());
export const opsFleet = () => M.ops?.opsFleet() || null;
export const applyOpsParams = (p) => { mod('ops').then(m => m.applyOpsParams(p)); };

// ---------- Rendering ----------
// Vier Hauptbereiche; die alten Ansichten bleiben Sections und werden als Segmente gezeigt. Alte Hashes funktionieren weiter.
// „Städte“: die bundesweiten Vergleiche (Gebietsvergleich, Verfügbarkeit je Stadt, Rangliste, Dichte) aus „Leistung“ ausgelagert
export const VIEWS = ['live', 'lab', 'staedte', 'usage', 'ops', 'prognose', 'prognose-spots', 'prognose-basis', 'spots', 'signals', 'coverage', 'vergleich', 'bericht', 'sources', 'status'];
export const GROUPS_DEF = () => [
  { id: 'markt', label: t('app.marketView'), segs: [['live', t('app.overview')], ['lab', t('app.performance')], ['staedte', t('app.citiesSeg')], ['usage', t('app.usage')], ['coverage', t('app.coverageSeg')], ['vergleich', t('app.compare')], ['bericht', t('app.report')]] },
  { id: 'prognose', label: t('app.forecast'), segs: [['prognose', t('fv.segVerlauf')], ['prognose-spots', t('fv.segSpots')], ['prognose-basis', t('fv.segBasis')]] },
  { id: 'ops', label: t('app.operations'), segs: [['ops', t('app.operations')], ['spots', t('app.spots')]] },
  { id: 'vertrauen', label: t('app.dataTrust'), segs: [['sources', t('app.sources2')], ['signals', t('app.signals')], ['status', t('app.statusSeg')]] },
];
export const VIEW_ALIAS = { cities: 'staedte', städte: 'staedte', abdeckung: 'coverage', compare: 'vergleich', anbietervergleich: 'vergleich', report: 'bericht', kommune: 'bericht', markt: 'live', marktbild: 'live', uebersicht: 'live', disposition: 'ops', forecast: 'prognose', vorhersage: 'prognose', forecastdashboard: 'prognose', 'forecast-spots': 'prognose-spots', 'prognose-spot': 'prognose-spots', 'forecast-basis': 'prognose-basis', grundlagen: 'prognose-basis', kontrolle: 'prognose-basis', 'spot-abgleich': 'spots', spotabgleich: 'spots', vertrauen: 'sources', datenvertrauen: 'sources', datenqualität: 'sources', datenqualitaet: 'sources', qualitaet: 'sources' };
export const CLIENT_HIDDEN = new Set(['usage', 'sources', 'signals', 'prognose-basis', 'status']); // Kundenansicht: ohne Schätzungen und Datenvertrauen
export let currentView = 'live', urlReady = false;
export const resolveView = (h) => { try { h = decodeURIComponent(h); } catch { /* Hash nicht dekodierbar: roh verwenden */ } let n = VIEW_ALIAS[h] || h; if (!VIEWS.includes(n)) n = 'live'; if (isClient() && CLIENT_HIDDEN.has(n)) n = 'live'; return n; };
// Welche Filter der Leiste in welcher Ansicht wirken; die übrigen werden ausgeblendet (Disposition und Vergleich haben eigene Auswahl im Panel)
export const FILTERS = { live: 'scope op type mode', lab: 'scope op type mode', staedte: 'scope op type', usage: 'scope op type', coverage: 'scope op type', vergleich: 'scope', bericht: 'scope op type', ops: 'scope', prognose: 'scope op type', 'prognose-spots': 'scope op type', 'prognose-basis': 'scope op type', spots: 'scope', sources: 'scope op', signals: 'scope op type mode', status: 'none' };
export let viewShown = false;
export function setView(name) {
  name = resolveView(name);
  if (name !== 'usage') { const fl = document.getElementById('fl-panel'); if (fl) M.fl?.abortFlows?.(fl); }
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
  if (name === 'live' && pendingLive && dataReady) { setPendingLive(false); liveFetch(); }
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
export const VIEW_RENDER = { live: [() => renderLive()], lab: [() => renderLab(), () => renderPricing(), () => renderShareChart()], usage: [() => renderUsage()], ops: [() => renderOps()], signals: [() => renderSignals()], coverage: [() => renderCoverage()], sources: [() => renderSources()], status: [() => mod('st').then(m => m.renderStatus($('#st-panel'), { state, CFG, esc, fmt, getJson: getJsonShared }))] };
export const dirty = new Set(VIEWS);
 export let dataReady = false;
// Ein fehlerhaftes Panel darf die übrigen nicht mitreißen
export const safe = (f) => { try { const r = f(); if (r?.catch) r.catch(e => console.error(f.name, e)); } catch (e) { console.error(f.name, e); } };
export function renderView(name) {
  if (!dataReady) return; // vor dem ersten Datenstand nichts zeichnen (sonst kurz „keine Daten“)
  // S3.8 Rest: gestartet mit latest-core.json (Disposition) – andere Ansichten erst mit dem vollen latest.json zeichnen
  if (state.latest?.lite && !LITE_VIEWS.has(name)) { dirty.add(name); ensureFullLatest().then(ok => { if (ok) { populateOperators(); renderAll(); } }); return; }
  dirty.delete(name); (VIEW_RENDER[name] || []).forEach(safe);
}
export const markDirty = (...names) => { for (const n of names) if (n === currentView) renderView(n); else dirty.add(n); };
export function renderSegments(group, name) {
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
export function placeSeg() {
  const seg = $('#seg'); const a = seg && !seg.hidden && seg.querySelector('a[aria-current]');
  if (!a || !a.offsetWidth) { seg?.classList.remove('ready'); return; }
  seg.style.setProperty('--seg-x', `${a.offsetLeft}px`); seg.style.setProperty('--seg-w', `${a.offsetWidth}px`); seg.style.setProperty('--seg-o', '1');
  seg.classList.add('ready');
}
// Gebiet, Anbieter, Fahrzeugart (und Kundenansicht) in der URL halten: ?scope=…&op=…&type=…#ansicht
// push: neuer Verlaufseintrag (Wechsel von Gebiet, Anbieter, Art – „Zurück“ macht ihn rückgängig); sonst wird der aktuelle Eintrag ersetzt
export function syncUrl(push = false) {
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
export function applyUrlParams(q = QS, back = false) {
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
export function setClient(on) {
  document.body.classList.toggle('mode-client', on);
  $('#btn-client').setAttribute('aria-pressed', String(on));
  $('#btn-share').textContent = on ? t('app.copyClientLink') : t('app.copyLink');
  $$('abbr[data-gloss]').forEach(a => { a.title = gl(a.dataset.gloss); });
  setView(currentView); if (dataReady) renderAll(); // alle Texte in der passenden Sprache (Kunde: ohne Methodik-Begriffe)
}
// Glossar auch per Touch und Tastatur: Kürzel (abbr mit Erklärung) antippen oder mit Enter öffnen; Esc oder außerhalb tippen schließt
export function bindGlossTips() {
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
export function bindTableCsv() {
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
export async function copyLink() {
  syncUrl();
  const btn = $('#btn-share'), url = location.href; let ok = false;
  if (navigator.share && matchMedia('(pointer:coarse)').matches) { try { await navigator.share({ title: document.title, url }); return; } catch (e) { if (e?.name === 'AbortError') return; } } // Handy: nativer Teilen-Dialog, sonst Zwischenablage
  try { await navigator.clipboard.writeText(url); ok = true; } catch {
    try { const tq = document.createElement('textarea'); tq.value = url; tq.setAttribute('readonly', ''); tq.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(tq); tq.select(); ok = document.execCommand('copy'); tq.remove(); } catch { ok = false; }
  }
  btn.textContent = ok ? t('app.copied') : t('app.copyingNotPossible'); btn.classList.toggle('done', ok);
  clearTimeout(copyLink.t); copyLink.t = setTimeout(() => { btn.textContent = isClient() ? t('app.copyClientLink') : t('app.copyLink'); btn.classList.remove('done'); }, 1600);
}
// Nach neuem Datenstand oder Filterwechsel: Kopf sofort, Ansichten als veraltet markieren, nur die aktive zeichnen
// Berichtsmodul (web/report.js): bekommt die Helfer und Lader der Seite, teilt deren Cache
export const rpCtx = () => ({ state, CFG, esc, fmt, getJson: getJsonShared, sharedCache: true, opColor, muniName, loadUsageIndex, loadEvents, loadHistory, loadCells,
  setScope: (ags) => { const sel = $('#sel-scope'); if (![...sel.options].some(o => o.value === ags)) return; sel.value = ags; sel.dispatchEvent(new Event('change')); },
  // einzelnen Filter der Leiste setzen (kind: scope | op | type) bzw. alle zurücksetzen; wirkt wie die Auswahl in der Leiste
  setFilter: (kind, v) => { const sel = $(kind === 'scope' ? '#sel-scope' : kind === 'op' ? '#sel-operator' : '#sel-type'); if (!sel || sel.value === v || ![...sel.options].some(o => o.value === v)) return; sel.value = v; sel.dispatchEvent(new Event('change')); },
  resetFilters: () => { for (const [id, v] of [['#sel-type', 'all'], ['#sel-operator', 'all'], ['#sel-scope', 'DE']]) { const sel = $(id); if (sel && sel.value !== v && [...sel.options].some(o => o.value === v)) { sel.value = v; sel.dispatchEvent(new Event('change')); } } } });
// Disposition: Helfer und Lader der Seite; getJsonShared lädt ops/<Land>.json, Zonen, Zellen usw. über denselben Cache wie die Übersichtskarte
export function opsCtx() { return { state, CFG, getJson: getJsonShared, esc, fmt, opColor, muniName, notice, clearNotice, loadBoundaries, loadUsageIndex, loadCells, loadOnce, loadGroups, TYPE, econFor, syncUrl, loadCatalog }; }
// rp(k, Funktion, Element): Modul k laden (S3.4), dann Funktion(Element, Kontext)
export const rp = (k, fn, id) => () => { const el = document.getElementById(id); if (el) return mod(k).then(m => m[fn](el, rpCtx())); };
VIEW_RENDER.bericht = [rp('rp', 'renderReport', 'rp-report'), rp('rp', 'renderForecast', 'rp-fc'), rp('rp', 'renderRegulationProfile', 'rp-reg'), rp('rp', 'renderCaps', 'rp-caps'), rp('rp', 'renderZoneWatch', 'rp-zones'), rp('rp', 'renderFeeCalculator', 'rp-fees'), rp('rp', 'renderWeekHeatmap', 'rp-week'), rp('rp', 'renderHotspotStability', 'rp-hot')];
VIEW_RENDER.staedte = [() => renderCities(), rp('rp', 'renderAvailability', 'rp-avail'), rp('rp', 'renderCityRanking', 'rp-rank'), rp('rp', 'renderDensityScatter', 'rp-scatter')];
VIEW_RENDER.usage.push(rp('fl', 'renderFlows', 'fl-panel'));
VIEW_RENDER.vergleich = [rp('cmp', 'renderCompare', 'cmp-panel')];
export const fvCtx = () => ({ ...rpCtx(), loadOnce });
export const fv = (part, id) => () => { const el = document.getElementById(id); if (el) return mod('fv').then(m => m.renderForecastView(el, fvCtx(), { part })); };
VIEW_RENDER.prognose = [fv('verlauf', 'fv-panel')];
VIEW_RENDER['prognose-spots'] = [fv('spots', 'fv-spots-panel')];
VIEW_RENDER['prognose-basis'] = [fv('basis', 'fv-basis-panel')];
VIEW_RENDER.spots = [() => { const el = document.getElementById('spots-panel'); if (el) return mod('sp').then(m => m.renderSpots(el, { ...rpCtx(), loadOnce })); }]; // Spot-Abgleich braucht dazu stations-quota und Zonen-Index
VIEW_RENDER.sources.push(rp('cov', 'renderCoverage', 'cov-panel'), rp('rp', 'renderFeedChecks', 'rp-feedchecks'), rp('rp', 'renderPriceLog', 'rp-pricelog'), () => renderCalibPanel());
export function renderAll() {
  dataReady = true;
  safe(renderHeader);
  for (const v of VIEWS) dirty.add(v);
  renderView(currentView);
}
