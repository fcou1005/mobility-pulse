
import * as C from './pulse-core.js';
import { t, lang, setLang, onLang, applyStatic } from './i18n.js';
import { $, $$, CFG, DEMO, DIRS, QS, STATUS, TYPE, esc, fmt, gl, isClient, state } from './app-core.js';
import { LITE_VIEWS, REQ, cached, clearNotice, fresh, getJson, loadBase, loadLatest, notice, resetCache, resetDaily } from './app-load.js';
import { muniInfo, muniName, operatorRows, scopeLabel } from './app-scope.js';
import { autoLive, liveFetch, setPendingLive } from './app-live.js';
import { FILTERS, M, VIEWS, applyUrlParams, bindGlossTips, bindTableCsv, copyLink, currentView, dataReady, dirty, markDirty, opsFleet, placeSeg, renderAll, safe, setClient, setView, syncUrl, urlReady, ROLE_START, roleOf } from './app-router.js';
import { bindLangSwitch, onLanguage, renderHeader, renderLangHint, renderLangSwitch, renderStamp } from './app-lang.js';
import { fitMap, initMap, loadWfs, renderMap, renderZonesLayer } from './app-map.js';
import { ENERGY, energyOfOp, renderHistory } from './app-energy.js';
import { renderSignals, resetSignalData, setSigFilter } from './app-signals.js';
import { MORE, MORE_RENDER, checkSupply, renderCoverage, renderSourceTable, renderSupplyLayer, toggleCovAll } from './app-sources.js';
import { renderEcon, renderUsage, renderUsageChart, setCalibMode } from './app-usage.js';
import { renderCalibPanel, setCalib } from './app-calib.js';
import { firstVisit } from './app-terms.js';

// ---------- Steuerung ----------
export function populateScope() {
  const sel = $('#sel-scope'); const munis = state.latest?.municipalities || {};
  // Betriebsgebiet-Erkennung (latest.municipalities[ags].presence, Sammler): Orte mit nur vereinzelten Fahrzeugen nicht als eigenes Gebiet; das
  // gewählte Gebiet bleibt immer wählbar (Links), neue Gebiete tragen den Zusatz „neu“
  const byState = {}; let hidden = 0;
  for (const m of Object.values(munis)) { if (m.presence?.status === 'vereinzelt' && m.ags !== state.scope) { hidden++; continue; } (byState[m.state] ??= []).push(m); }
  const STATES = { BW: 'Baden-Württemberg', BY: t('app.bavaria'), BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg', HE: t('app.hesse'), MV: t('app.mecklenburgWesternPomerania'), NI: t('app.lowerSaxony'), NW: t('app.northRhineWestphalia'), RP: t('app.rhinelandPalatinate'), SL: 'Saarland', SN: t('app.saxony'), ST: t('app.saxonyAnhalt'), SH: 'Schleswig-Holstein', TH: t('app.thuringia') };
  sel.innerHTML = `<option value="DE">${t('app.allOfGermany')}</option>` + Object.keys(byState).sort((a, b) => (STATES[a] || a).localeCompare(STATES[b] || b)).map(st => `<optgroup label="${esc(STATES[st] || st)}">${byState[st].sort((a, b) => String(a.name).localeCompare(String(b.name), 'de')).map(m => `<option value="${esc(m.ags)}">${esc(m.name)}${m.presence?.status === 'neu' ? ` (${t('app.presenceNew')})` : ''}</option>`).join('')}</optgroup>`).join('')
    + (hidden ? `<option disabled value="">${esc(t('app.strayHidden', { n: fmt(hidden) }))}</option>` : '');
  sel.title = state.latest?.presence ? t('app.presenceTitle') : '';
  sel.value = state.scope;
}
// Verknüpfte Filter (11.11.2026): Anbieter- und Fahrzeugart-Auswahl zeigen nur, was im gewählten Gebiet zusammenpasst – mit „E-Scooter“
// nur Anbieter mit E-Scootern, mit einem Anbieter nur dessen Arten. Grundlage: Gruppen Gemeinde|Anbieter|Art mit Fahrzeugen oder Stationen im
// Sammler-Stand, im Live-Modus zusätzlich der Live-Abruf; Datenlücken (latest.gaps) mit den Arten des Anbieters anderswo.
// prefer: 'type' (Art eben gewählt, Standard) → passt der Anbieter nicht, gilt „alle Anbieter“; 'op' (Anbieter eben gewählt) → passt die Art nicht, gilt „alle Arten“.
export const TYPE_FILTER = ['scooter', 'ebike', 'bike', 'cargo', 'moped', 'car', 'unknown'];
export let TYPE_LABELS = null; // Beschriftung der Arten aus dem HTML (data-i18n bzw. fester Text), einmal gelesen
export function opTypeIndex() {
  const inScope = new Map(), anywhere = new Map();
  const add = (m, op, ty) => { if (!m.has(op)) m.set(op, new Set()); m.get(op).add(ty || 'unknown'); };
  const take = (k, g) => { const [ags, op, ty] = k.split('|'); if (!op || ags === 'DE' || !((g?.total || 0) + (g?.stations || 0) > 0)) return; add(anywhere, op, ty); if (state.scope === 'DE' || ags === state.scope) add(inScope, op, ty); };
  for (const [k, g] of Object.entries(state.latest?.groups || {})) take(k, g);
  if (state.live) for (const [k, g] of state.live.groups) take(k, g);
  return { inScope, anywhere };
}
// Datenlücke (latest.gaps) passt zur gewählten Art: Arten laut Liste (known_gaps.types), sonst die des Anbieters anderswo
export function gapFitsType(g, idx = null) {
  if (state.type === 'all') return true;
  const ty = g.types?.length ? g.types : [...((idx || opTypeIndex()).anywhere.get(g.operator) || [])];
  return ty.includes(state.type);
}
export function populateOperators(prefer = 'type') {
  const sel = $('#sel-operator'), tsel = $('#sel-type');
  let ops;
  if (state.scope === 'DE') ops = [...new Set((state.latest?.sources || []).filter(r => ['live', 'delayed'].includes(r.status)).map(r => r.operator))];
  else ops = Object.keys(muniInfo(state.scope)?.operators || {});
  if (state.live) for (const [k] of state.live.groups) { const [ags, op] = k.split('|'); if (state.scope === 'DE' || ags === state.scope) ops.push(op); }
  const gapOps = new Set(); for (const g of state.latest?.gaps || []) if (state.scope === 'DE' || muniName(state.scope) === g.city) { ops.push(g.operator); gapOps.add(g.operator); }
  ops = [...new Set(ops)].sort((a, b) => a.localeCompare(b, 'de'));
  const { inScope, anywhere } = opTypeIndex(), hasData = inScope.size > 0;
  // Arten je Anbieter im Gebiet; Datenlücke ohne Fahrzeuge im Gebiet: Arten des Anbieters anderswo (Dott Tübingen → E-Scooter, E-Bikes)
  const gapTypes = new Map(); for (const g of state.latest?.gaps || []) if (gapOps.has(g.operator) && g.types?.length) for (const ty of g.types) { if (!gapTypes.has(g.operator)) gapTypes.set(g.operator, new Set()); gapTypes.get(g.operator).add(ty); }
  const typesOf = (op) => inScope.get(op) || (gapOps.has(op) ? gapTypes.get(op) || anywhere.get(op) : null) || null;
  const opFits = (op, ty) => ty === 'all' || !hasData || !!typesOf(op)?.has(ty);
  const typesFor = (op) => { const out = new Set(); for (const o of op === 'all' ? ops : [op]) for (const ty of typesOf(o) || []) out.add(ty); return out; };
  if (!TYPE_LABELS && tsel) TYPE_LABELS = Object.fromEntries([...tsel.options].map(o => [o.value, { key: o.dataset.i18n || null, text: o.textContent }]));
  const typeOpts = (op) => { const have = typesFor(op); return TYPE_FILTER.filter(ty => !hasData || have.has(ty)); };
  // Vorrang: zuletzt geänderter Filter bleibt, der andere weicht auf „alle“ aus
  if (prefer === 'op') { if (state.operator !== 'all' && !ops.includes(state.operator)) state.operator = 'all'; if (state.type !== 'all' && !typeOpts(state.operator).includes(state.type)) state.type = 'all'; }
  else if (state.operator !== 'all' && !(ops.includes(state.operator) && opFits(state.operator, state.type))) state.operator = 'all';
  if (state.type !== 'all' && hasData && !typeOpts(state.operator).includes(state.type)) state.type = 'all';
  const shownOps = ops.filter(o => opFits(o, state.type));
  sel.innerHTML = `<option value="all">${t('app.allOperatorsOnSite')}</option>` + shownOps.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  sel.value = state.operator;
  if (tsel && TYPE_LABELS) {
    const opt = (v) => { const l = TYPE_LABELS[v] || { key: null, text: v }; return `<option value="${esc(v)}"${l.key ? ` data-i18n="${esc(l.key)}"` : ''}>${esc(l.key ? t(l.key) : l.text)}</option>`; };
    const list = typeOpts(state.operator); if (state.type !== 'all' && !list.includes(state.type)) list.push(state.type);
    tsel.innerHTML = opt('all') + list.map(opt).join('');
    tsel.value = state.type;
  }
}
export function bind() {
  // Gebietswahl: Grenzen lädt erst der Live-Abruf (Ortszuordnung) bzw. die Grenz-Ebene; die Karte zeigt bis dahin die Sammler-Positionen
  // Pfeiltasten auf der geschlossenen Liste lösen je Schritt „change“ aus: per Tastatur erst nach 400 ms Ruhe wechseln (Enter sofort),
  // sonst startet jeder Schritt einen Gebietswechsel samt Live-Abruf aller Feeds
  const resetScope = (v) => { state.scope = v; state.live = null; state.supply = null; setPendingLive(false); clearNotice('scope'); if (state.mode === 'live') state.mode = 'collector', $('#sel-mode').value = 'collector'; };
  const applyScope = (v) => { if (v === state.scope) return; resetScope(v); populateOperators(); syncUrl(true); renderAll(); autoLive(); };
  let scopeT = null, scopeByKey = false;
  $('#sel-scope').addEventListener('keydown', (e) => { if (e.key === 'Enter' && scopeT) { clearTimeout(scopeT); scopeT = null; applyScope(e.target.value); return; } if (/^(Arrow|Page)|^(Home|End)$/.test(e.key) || e.key.length === 1) scopeByKey = true; });
  $('#sel-scope').addEventListener('change', (e) => { clearTimeout(scopeT); scopeT = null; const v = e.target.value; if (scopeByKey) { scopeByKey = false; scopeT = setTimeout(() => { scopeT = null; applyScope(v); }, 400); } else applyScope(v); });
  // verknüpfte Filter: nach jeder Wahl die andere Liste neu (Anbieter nur mit der gewählten Art, Arten nur des gewählten Anbieters)
  $('#sel-operator').addEventListener('change', (e) => { state.operator = e.target.value; populateOperators('op'); syncUrl(true); renderAll(); });
  $('#sel-type').addEventListener('change', (e) => { state.type = e.target.value; populateOperators('type'); syncUrl(true); renderAll(); });
  // Zurück/Vorwärts: Gebiet, Anbieter, Art, Kundenansicht, Sprache und Ansicht aus der Adresszeile übernehmen, ohne automatischen Live-Abruf
  // (sonst startet jeder Schritt durch den Verlauf einen Abruf aller Feeds). Erst den Zustand setzen, dann zeichnen: setClient/setLang
  // schreiben die URL des gerade betretenen Eintrags (replaceState) und dürfen dabei keinen alten Stand hineinschreiben.
  window.addEventListener('popstate', () => {
    if (!urlReady) return;
    const q = new URLSearchParams(location.search), view = location.hash.slice(1), before = `${state.scope}|${state.operator}|${state.type}|${opsFleet() || ''}|${$('#ops-type').value}`;
    clearTimeout(scopeT); scopeT = null; scopeByKey = false; setPendingLive(false);
    const sc = q.get('scope') || 'DE';
    if (sc !== state.scope && [...$('#sel-scope').options].some(o => o.value === sc)) resetScope(sc);
    applyUrlParams(q, true);
    // Sprache nur, wenn der Eintrag sie nennt (ohne ?lang= bleibt die gemerkte Wahl – so zeigt auch Neuladen dieselbe Sprache)
    const client = q.get('kunde') === '1', lg = q.get('lang');
    if (client !== isClient()) setClient(client);
    if (lg && lg !== lang()) { setLang(lg, { persist: false }); renderLangSwitch(); }
    // geänderte Filter: alle Ansichten veraltet, setView zeichnet die Zielansicht genau einmal (nach setClient/setLang: deren Zwischenstand
    // mit der alten Ansicht im Eintrag wird hier wieder überschrieben)
    if (dataReady && before !== `${state.scope}|${state.operator}|${state.type}|${opsFleet() || ''}|${$('#ops-type').value}`) { safe(renderHeader); for (const v of VIEWS) dirty.add(v); }
    setView(view);
  });
  $('#btn-share').addEventListener('click', copyLink);
  $('#btn-client').addEventListener('click', () => setClient(!isClient()));
  $('#econ-panel').addEventListener('change', (e) => { const i = e.target.closest('input.calib'); if (!i) return; setCalib(i.dataset.op, parseFloat(String(i.value).replace(',', '.'))); renderEcon(state.usage.day); });
  // Umschalter „kalibriert / gemessen“ (Standard kalibriert, im Browser gemerkt)
  $('#econ-panel').addEventListener('click', (e) => {
    const b = e.target.closest('#econ-mode button[data-cmode]'); if (!b || b.getAttribute('aria-disabled') === 'true') return; // gesperrt: kein Faktor wirksam (B3)
    setCalibMode(b.dataset.cmode); renderEcon(state.usage.day);
  });
  window.addEventListener('resize', () => placeSeg());
  document.fonts?.ready?.then(() => placeSeg());
  // Drucken: zugeklappte Bereiche öffnen, danach wieder schließen
  window.addEventListener('beforeprint', () => $$('details:not([open])').forEach(d => { d.open = true; d.dataset.printOpened = '1'; }));
  window.addEventListener('afterprint', () => $$('details[data-print-opened]').forEach(d => { d.open = false; delete d.dataset.printOpened; }));
  $('#sel-mode').addEventListener('change', (e) => { state.mode = e.target.value; if (state.mode === 'live' && !state.live) liveFetch(); else renderAll(); });
  $('#btn-live').addEventListener('click', () => liveFetch());
  $('#btn-fit').addEventListener('click', () => fitMap(true));
  ['chk-vehicles', 'chk-stations', 'chk-muni', 'sel-layer'].forEach(id => $(`#${id}`).addEventListener('change', () => renderMap()));
  $('#chk-wfs').addEventListener('change', (e) => e.target.checked ? loadWfs() : (state.layers.wfs.clearLayers(), clearNotice('wfs')));
  $('#chk-zones').addEventListener('change', () => renderZonesLayer());
  $('#chk-weather').addEventListener('change', () => renderUsage());
  ['usage-op', 'usage-type'].forEach(id => $(`#${id}`).addEventListener('change', () => { const s = state.usage.chartSel; if (!s) return; s.op = $('#usage-op').value; s.type = $('#usage-type').value; renderUsageChart(); }));
  ['econ-min', 'econ-real', 'econ-net'].forEach(id => $(`#${id}`).addEventListener('change', () => { renderEcon(state.usage.day); renderCalibPanel().catch(e => console.error('Kalibrierung', e)); }));
  $('#usage-days').addEventListener('click', (e) => { const b = e.target.closest('[data-uday]'); if (!b) return; state.usage.day = b.dataset.uday; try { const q = new URLSearchParams(location.search); q.set('day', state.usage.day); history.replaceState(history.state, '', `${location.pathname}?${q}${location.hash}`); } catch { /* file:// */ } renderUsage(); });
  $('#btn-flow-map').addEventListener('click', () => { $('#sel-layer').value = 'flow'; location.hash = '#live'; renderMap(); window.scrollTo({ top: 0 }); });
  document.addEventListener('click', (e) => { const a = e.target.closest('.pick-cell'); if (!a) return; e.preventDefault(); $('#sel-layer').value = 'flow'; location.hash = '#live'; renderMap(); setTimeout(() => state.map.setView([+a.dataset.lat, +a.dataset.lon], 16), 300); });
  $('#in-charge').addEventListener('change', (e) => { state.thresholds.charge = +e.target.value || 20; if (state.live) recomputeLive(); renderAll(); });
  $('#in-range').addEventListener('change', (e) => { state.thresholds.range = +e.target.value || 5; if (state.live) recomputeLive(); renderAll(); });
  $('#hist-days').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (!b) return; state.histDay = b.dataset.day; renderHistory(); markDirty('signals', 'live'); });
  // weitere Zeilen: danach Fokus auf die erste neue Zeile (der Knopf selbst verschwindet beim Neuaufbau)
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-more]'); if (!b || !MORE[b.dataset.more]) return; const key = b.dataset.more, n = MORE[key].n; MORE[key].n += 100; MORE_RENDER[key]?.(); const td = $(`#tbl-${key} tbody`)?.rows[n]?.cells[0]; if (td) { td.tabIndex = -1; td.focus(); } });
  // Kartenlegende: Anbieter hervorheben (erneuter Klick hebt auf)
  $('#map-legend-ops').addEventListener('click', (e) => { const b = e.target.closest('[data-map-hl]'); if (!b) return; const o = b.dataset.mapHl; state.mapFocus = state.mapFocus === o ? null : o; renderMap(); $(`#map-legend-ops [data-map-hl="${CSS.escape(o)}"]`)?.focus(); });
  // Abdeckung: Gebiet aufheben bzw. wieder anwenden
  $('#cov-sub').addEventListener('click', (e) => { if (!e.target.closest('[data-cov-all]')) return; toggleCovAll(); renderCoverage(); $('#cov-sub [data-cov-all]')?.focus(); });
  // Sprung in einen Abschnitt einer anderen Ansicht (z. B. Nutzung → Quellen › Kalibrierung)
  document.addEventListener('click', (e) => { const a = e.target.closest('a[data-jump]'); if (!a) return; e.preventDefault(); location.hash = a.getAttribute('href'); setTimeout(() => { const el = document.getElementById(a.dataset.jump); if (el) { el.scrollIntoView({ block: 'start' }); el.tabIndex = -1; el.focus({ preventScroll: true }); } }, 250); });
  $('#sig-filter').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; setSigFilter(b.dataset.cat); renderSignals(); });
  $('#cov-search').addEventListener('input', renderCoverage); $('#cov-dir').addEventListener('change', renderCoverage);
  $('#src-search').addEventListener('input', renderSourceTable); $('#src-status').addEventListener('change', renderSourceTable);
  $('#btn-supply').addEventListener('click', checkSupply);
  $('#btn-supply-map').addEventListener('click', () => { renderSupplyLayer(); location.hash = '#live'; });
  $('#btn-csv').addEventListener('click', exportCsv);
  $('#btn-theme').addEventListener('click', () => { const cur = document.documentElement.dataset.theme; const next = cur === 'light' ? 'dark' : cur === 'dark' ? '' : 'light'; if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme; try { localStorage.setItem('mp-theme', next); } catch {} if (dataReady) renderAll(); });
  // Anbieter- und Ebenenfarben haben je Thema eigene Stufen: bei Themenwechsel (Knopf oder System) neu zeichnen
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (dataReady && !document.documentElement.dataset.theme) renderAll(); });
  document.addEventListener('click', (e) => { const a = e.target.closest('.pick-muni'); if (!a) return; e.preventDefault(); $('#sel-scope').value = a.dataset.ags; $('#sel-scope').dispatchEvent(new Event('change')); location.hash = '#live'; window.scrollTo({ top: 0 }); });
  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
}
export function recomputeLive() { if (!state.live) return; state.live.groups = C.aggregateGroups(state.live.vehicles, state.live.stations, { chargeThreshold: state.thresholds.charge, rangeThreshold: state.thresholds.range }); }
export function exportCsv() {
  const rows = operatorRows(); const head = [t('app.operator'), t('app.area'), t('app.available3'), t('app.reported3'), t('app.disabled2'), t('app.reserved'), t('app.lowenergy'), t('app.withenergydata'), t('app.stations'), t('app.emptystations'), 'Status', t('app.dataagemin'), t('app.sources2'), t('app.licence')];
  // Zellen, die mit = + - @ (oder Tab/CR) beginnen, würden in Tabellenprogrammen als Formel laufen: Text mit ' davor
  const cell = (v) => { let s = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const en = (op) => { const e = energyOfOp(op); return e.pending ? ['', ''] : [e.low, e.known]; }; // Energie niedrig nach energyLow (wie Kacheln und Disposition)
  const lines = rows.map(r => [r.op, scopeLabel(), r.st.available, r.st.total, r.st.disabled, r.st.reserved, ...en(r.op), r.st.stations, r.st.stationsEmpty, STATUS[r.status] || r.status, r.age == null ? '' : Math.round(r.age / 60e3), r.dirs.map(d => DIRS[d] || d).join('|'), r.license || ''].map(cell).join(';'));
  const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mobility-pulse_${state.scope}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Seitenweite Ergänzungen: Rahmenschutz, Hinweisband für abweichenden Datenstand, Höhe der Kopfleiste für scroll-padding,
// Leaflet-Bedienelemente in der Sprache der Seite (alle Karten, auch die der Module), Schriftausgleich für Diagramme mit festem viewBox
export function relabelLeaflet(root = document) {
  for (const [sel, key] of [['.leaflet-control-zoom-in', 'common.zoomIn'], ['.leaflet-control-zoom-out', 'common.zoomOut']]) for (const a of root.querySelectorAll(sel)) { a.title = t(key); a.setAttribute('aria-label', t(key)); }
  for (const a of root.querySelectorAll('.leaflet-control-attribution a[href*="leafletjs.com"]')) { a.title = t('common.leafletTitle'); a.lang = 'en'; }
}
export const K_RO = typeof ResizeObserver === 'function' ? new ResizeObserver((es) => es.forEach(e => fixChartFont(e.target))) : null;
// Diagramme mit festem viewBox (z. B. web/report.js): Schrift über --k auf ≈ 11 px halten, begrenzt auf 0,75–1,4, damit Achsentexte im Rand bleiben
export function fixChartFont(svg) { const vb = svg.viewBox?.baseVal, w = svg.clientWidth; if (!vb?.width || !w) return; svg.style.setProperty('--k', Math.min(1.4, Math.max(0.75, vb.width / w)).toFixed(3)); }
// Tabellen-Rahmen (.tbl) scrollen am Telefon quer: per Tastatur erreichbar machen, benannt nach Beschriftung oder Überschrift des Abschnitts
export function scrollRegion(d) {
  if (d.hasAttribute('tabindex')) return;
  d.tabIndex = 0; d.setAttribute('role', 'region');
  if (!d.hasAttribute('aria-label') && !d.hasAttribute('aria-labelledby')) {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const base = clean(d.querySelector('caption')?.textContent || d.closest('.panel,.rp-sec,.rp-cap,section')?.querySelector('h2,h3,h4')?.textContent);
    if (!base) return;
    // Bereichsnamen eindeutig halten (axe landmark-unique): sonst erste Spaltenüberschrift, dann laufende Nummer anhängen
    const taken = (n) => [...document.querySelectorAll('[role="region"][aria-label]')].some(x => x !== d && x.getAttribute('aria-label') === n);
    let name = base; const th = clean(d.querySelector('thead th')?.textContent);
    if (taken(name) && th) name = `${base}: ${th}`;
    for (let k = 2; taken(name); k++) name = `${base} (${k})`;
    d.setAttribute('aria-label', name);
  }
}
// ---------- Orientierung auf langen Seiten: Sprungleiste „Auf dieser Seite“ und Nach-oben-Knopf ----------
// Ab 4 sichtbaren Panels mit Überschrift zeigt die Ansicht unter dem Titel eine Leiste, die zu den Panels springt. Die Ansicht bleibt vollständig
// (nichts gefaltet: Strg+F und Druck sehen alles). Keine Links mit „#…“: der Hash wählt die Ansicht, darum Knöpfe mit scrollIntoView.
export let tocTimer = 0, tocSeq = 0;
export const scheduleToc = () => { clearTimeout(tocTimer); tocTimer = setTimeout(buildToc, 350); };
export function buildToc() {
  const view = $(`#view-${currentView}`); if (!view) return;
  const items = [];
  for (const h of view.querySelectorAll('.panel h2')) {
    if (!h.offsetParent || h.closest('.toc')) continue;
    const c = h.cloneNode(true); c.querySelectorAll('.pill,.badge,button,.chip,sup').forEach(x => x.remove());
    const label = c.textContent.replace(/\s+/g, ' ').trim(); if (!label) continue;
    const box = h.closest('.panel') || h; if (!box.id) box.id = `sec-${currentView}-${++tocSeq}`;
    items.push([box.id, label.length > 44 ? `${label.slice(0, 42)}…` : label]);
  }
  let toc = view.querySelector(':scope > .toc');
  if (items.length < 4) { toc?.remove(); return; }
  const sig = `${lang()}|${items.map(i => i.join('=')).join('|')}`;
  if (toc?.dataset.sig === sig) return;
  if (!toc) { toc = document.createElement('nav'); toc.className = 'toc'; const hero = view.querySelector(':scope > .view-answer') || view.querySelector(':scope > .hero'); if (hero) hero.after(toc); else view.prepend(toc); } // S4.1: Sprungleiste unter der Antwort
  toc.dataset.sig = sig; toc.setAttribute('aria-label', t('ux.onThisPage'));
  toc.innerHTML = `<span class="toc-l">${esc(t('ux.onThisPage'))}</span>${items.map(([id, l]) => `<button type="button" class="chip" data-toc="${esc(id)}">${esc(l)}</button>`).join('')}`;
}
export function bindOrientation() {
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('.toc [data-toc]'); if (!b) return;
    const box = document.getElementById(b.dataset.toc); if (!box) return;
    box.scrollIntoView({ behavior: calm(), block: 'start' });
    const h = box.querySelector('h2'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  });
  const up = $('#to-top');
  if (up) { const upd = () => { up.hidden = window.scrollY < 900; }; addEventListener('scroll', upd, { passive: true }); upd(); up.addEventListener('click', () => window.scrollTo({ top: 0, behavior: calm() })); }
  onLang(scheduleToc);
}
export function enhanceUi() {
  if (QS.has('embed')) document.body.classList.add('embed'); // S5.4: gewollt eingebettet (Stadtseite) – kein Hinweis auf fremden Rahmen
  else if (window.top !== window.self) { document.body.classList.add('framed'); notice(() => t('app.framedWarning'), 'bad', 'framed'); }
  if (CFG.DATA_OK) {
    const b = document.createElement('div'); b.className = 'note warn data-origin'; b.id = 'data-origin';
    const put = () => { b.innerHTML = t('app.dataOriginBanner', { src: `<span class="mono">${esc(QS.get('data'))}</span>` }); };
    put(); onLang(put); $('#notice')?.before(b);
  }
  const bar = $('.topbar'), setH = () => document.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
  if (bar) { setH(); if (typeof ResizeObserver === 'function') new ResizeObserver(setH).observe(bar); }
  const main = $('main');
  if (main) new MutationObserver((ms) => {
    let leaf = false;
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.closest?.('.leaflet-control-container') || n.querySelector?.('.leaflet-control-zoom')) leaf = true;
      for (const s of n.matches?.('svg.chart') ? [n] : n.querySelectorAll?.('svg.chart') || []) if (!s.dataset.px) { fixChartFont(s); K_RO?.observe(s); }
      for (const d of n.matches?.('.tbl') ? [n] : n.querySelectorAll?.('.tbl') || []) scrollRegion(d);
    }
    if (leaf) relabelLeaflet(main);
    if (ms.some(m => !m.target.closest?.('.toc, .leaflet-container'))) scheduleToc();
  }).observe(main, { childList: true, subtree: true });
  bindOrientation();
  main?.querySelectorAll('.tbl').forEach(scrollRegion);
  relabelLeaflet(); onLang(() => relabelLeaflet());
// Werkzeuge (Stand, Link kopieren, Kundenansicht, DE/EN, Hell/Dunkel): am Desktop in der Seitenleiste, am Telefon im Menü „⋯“.
  // In der Kopfleiste bleiben Ort, Segmente und „Live abrufen“: sie bleibt in allen Bereichen einzeilig (vorher 2 Zeilen im Marktbild).
  const mq = matchMedia('(max-width: 820px)');
  const placeTools = () => {
    const mob = mq.matches, side = $('#side-tools'), menu = $('#tools-m-body');
    if (!side || !menu) return;
    for (const id of ['stand-pill', 'btn-share', 'btn-client', 'lang-switch', 'btn-theme']) { const el = $(`#${id}`); if (el) (mob ? menu : side).appendChild(el); }
    // Telefon: „Live abrufen“ und „⋯“ sitzen neben der Marke (spart die eigene Zeile unter den Segmenten), am Desktop wieder in der Kopfleiste
    const brand = $('aside .brand'), live = $('#btn-live'), tm = $('#tools-m'), stand = $('.stand');
    if (brand && live && tm && stand) { if (mob) brand.after(live, tm); else stand.append(live, tm); }
    if (!mob) $('#tools-m')?.removeAttribute('open');
  };
  placeTools(); mq.addEventListener?.('change', placeTools);
  document.addEventListener('click', (e) => { const m = $('#tools-m'); if (m?.open && !m.contains(e.target)) m.open = false; });
  // Filter am Telefon eingeklappt: Zusammenfassung als Knopf
  $('#filters-sum')?.addEventListener('click', () => { const f = $('#filters'), open = !f.classList.contains('open'); f.classList.toggle('open', open); $('#filters-sum').setAttribute('aria-expanded', String(open)); });
}
// Zusammenfassung der Filterleiste (Telefon): Gebiet · Anbieter · Fahrzeugart, nur die in der Ansicht wirksamen
export function renderFilterSum() {
  const b = $('#filters-sum'); if (!b) return;
  const fs = (FILTERS[currentView] || 'scope op type mode').split(' ');
  const parts = [fs.includes('scope') ? scopeLabel() : null, fs.includes('op') ? (state.operator === 'all' ? t('app.allOperatorsOnSite') : state.operator) : null, fs.includes('type') ? (state.type === 'all' ? t('html.allVehicleTypes') : TYPE[state.type] || state.type) : null].filter(Boolean);
  b.textContent = parts.join(', ');
  b.hidden = !parts.length; // Ansicht ohne Filter (#status): keine leere Zusammenfassung
}
export async function init() {
  try { const tq = localStorage.getItem('mp-theme'); if (tq) document.documentElement.dataset.theme = tq; } catch {}
  applyStatic(); renderLangSwitch(); bindLangSwitch(); onLang(onLanguage); renderLangHint();
  if (QS.get('kunde') === '1') { document.body.classList.add('mode-client'); $('#btn-client').setAttribute('aria-pressed', 'true'); $('#btn-share').textContent = t('app.copyClientLink'); }
  if (DEMO) document.body.classList.add('mode-demo');
  initMap(); bind(); enhanceUi();
  // Disposition (web/ops.js) wird erst beim ersten Öffnen geladen und dann mit opsCtx() eingerichtet (S3.4)
  $$('abbr[data-gloss]').forEach(a => { a.title = gl(a.dataset.gloss); }); // Glossar-Tooltips aus einer Quelle
  // Platzhalter-Kacheln in der späteren Anzahl: die Seite springt nicht, wenn die Zahlen kommen (CLS)
  for (const [id, n] of [['#live-tiles', 5], ['#lab-tiles', 4], ['#usage-tiles', 5], ['#econ-tiles', 5], ['#cov-tiles', isClient() ? 3 : 4], ['#src-tiles', 4]]) { const el = $(id); if (el && !el.children.length) el.innerHTML = '<div class="tile skel" aria-hidden="true"><div class="l">&nbsp;</div><div class="v">–</div><div class="s">&nbsp;</div></div>'.repeat(n); }
  firstVisit(); // S4.8: einmal fragen, wofür die Seite genutzt wird
  setView(location.hash.slice(1) || (QS.has('embed') ? 'stadt' : ROLE_START[roleOf()]) || 'live'); // S5.6: ohne Ansicht im Link die Startansicht der Rolle
  await loadBase(currentView);
  populateScope();
  const deep = applyUrlParams(); // Deep-Link: Gebiet, Anbieter, Fahrzeugart aus der URL
  bindTableCsv(); bindGlossTips(); renderAll(); syncUrl();
  if (deep) autoLive();
  if (DEMO) return; // Demo-Stand: kein Nachladen
  // Sammler-Stand alle 2 Min. prüfen; bei neuem Lauf alles neu laden (Ereignis-, Zonen- und Flottendateien inklusive)
  setInterval(async () => {
    const s = await getJson(fresh('status.json')); if (!s.ok || s.json.at === state.status?.at) return;
    const l = await loadLatest(s.json, !!state.latest?.lite && LITE_VIEWS.has(currentView)); if (!l.ok) return; // weiter mit dem Kern, solange nur die Disposition offen war
    state.status = s.json; state.latest = l.json; state.hist = {}; state.usage.docs = {}; state.usage.docsSt = {}; state.usage.hourTotals = null; state.usage.opsInputIndex = null; state.usage.opsFleetIndex = null; state.usage.index = null; state.usage.cells = {}; state.usage.profile = null; state.usage.archiveDays = null; state.usage.zones = {};
    for (const k of ['idle', 'idleLong', 'quota', 'reliability', 'consistency', 'zonesIndex', 'pricing', 'runs', 'archiveIndex', 'groups']) state.usage[k] = null;
    const keepB = [...REQ].filter(([k]) => k.startsWith('boundaries')); resetCache(); if (state.bIndex) for (const [k, p] of keepB) REQ.set(k, p); // Grenzen ändern sich nicht je Lauf
    resetSignalData(); resetDaily(); state.daily = null; state.fleet.clear(); ENERGY.clear(); M.ops?.resetCaches?.(); M.rp?.resetReportCaches?.(); M.cov?.resetCoverageCache?.(); M.cmp?.resetCompareCache?.(); M.fv?.resetForecastCache?.(); M.sp?.resetSpotsCache?.();
    const hi = await cached('history/index.json', 25000); if (hi.ok) state.histIndex = hi.json;
    populateScope(); populateOperators(); clearNotice('stale'); renderAll();
  }, 2 * 60e3);
  setInterval(renderStamp, 30e3);
}
init();
