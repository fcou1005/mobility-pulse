// Mobility Pulse — Disposition (Ansicht) – vermutete Deploy-Spots, Straßenkilometer (OSRM), Einsammelliste (aus ops.js geschnitten; ops.js bleibt die Fassade für alle Importe).
import * as O from './pulse-ops.js';
import { t, lang, fmtLocale } from './i18n.js';
import { $, AHP_L, DAY_BERLIN, S, X, allRuns, ascii, download, idleCls, slug, status, tick, tok, zoneSource } from './ops-data.js';
import { DAYMON, avgText, computePlan, drawLayers, drawRoutes, legend, markFocus, osmLink, planStatus, renderRuns, renderTiles, spotTitle, typesText, whenText } from './ops-plan.js';

// ---------- Vermutete Deploy-Spots und Einsammel-Orte (Gruppen-Ereignisse aller Monate, aus Beobachtung) ----------
// Orte je Anbieter und Art aus lib/pulse-ops.js groupPlaces (Ereignisse ≤ 60 m zusammengefasst). Tabelle mit Filter je Spalte (Lage, Anbieter,
// Anzahl, Ø Fahrzeuge, Zeitraum „zuletzt“), Sortierung per Spaltenkopf (Tastatur: Tab + Enter/Leertaste, aria-sort), CSV der gefilterten Zeilen.
// Die Kartenebenen „Anbieter-Spots“ und „Einsammel-Orte“ zeigen dieselbe Auswahl.
const GROUP_GEO_TOP = 10;
export const GF0 = () => ({ kind: 'deploy', q: '', op: 'all', countMin: '', countMax: '', avgMin: '', avgMax: '', from: '', to: '', sort: 'count', dir: 'desc', forOp: null, forAgs: null });
const GCOLS = [
  { key: 'lage', label: () => t('ops.location'), n: false, dir: 'asc' },
  { key: 'op', label: () => t('ops.operator'), n: false, dir: 'asc' },
  { key: 'count', label: () => S.gf?.kind === 'collect' ? t('ops.pickups') : t('ops.deployments'), n: true, dir: 'desc' },
  { key: 'last', label: () => t('ops.lastCol'), n: true, dir: 'desc' },
  { key: 'avg', label: () => t('ops.avgVehicles'), n: true, dir: 'desc' },
  { key: 'near', label: () => t('ops.nearestPlanSpot'), n: true, dir: 'asc' },
];
const geoLabel = (s) => GEO.get(geoKey(s.lat, s.lon)) || '';
// nächster Spot des Plans je Ort, einmal je Plan gerechnet
const NEAR = new WeakMap();
function nearOf(s) {
  const p = S.plan; if (!p) return null;
  let m = NEAR.get(p); if (!m) NEAR.set(p, m = new Map()); if (m.has(s)) return m.get(s);
  let best = null, bd = Infinity; for (const o of p.spots.spots) { const d = O.dist(o, s); if (d < bd) { bd = d; best = o; } }
  const r = best ? { rank: best.rank, d: bd } : null; m.set(s, r); return r;
}
export function groupView(kind) {
  const g = S.plan?.groups; if (!g || !S.gf) return [];
  return O.sortPlaces(O.filterPlaces(g[kind] || [], S.gf, geoLabel), S.gf.sort, S.gf.dir, { labelOf: geoLabel, nearOf });
}
export function initGroupsUi() {
  const tbl = $('#ops-groups'); if (!tbl || $('#ops-gfilter')) return;
  const panel = tbl.closest('.panel'), head = panel.querySelector('.panel-head');
  head.insertAdjacentHTML('beforeend', `<div class="inline-form"><div class="ops-gkind" role="group" aria-label="${t('ops.typeOfPlaces')}" data-i18n-aria-label="ops.typeOfPlaces"><button type="button" data-gk="deploy" aria-pressed="true"><span data-i18n="ops.deployments">${t('ops.deployments')}</span></button><button type="button" data-gk="collect" aria-pressed="false"><span data-i18n="ops.pickupPlaces">${t('ops.pickupPlaces')}</span></button></div><button type="button" id="ops-gcsv" title="${t('ops.filteredRowsAsCsvSemicolon')}" data-i18n-title="ops.filteredRowsAsCsvSemicolon">↓ CSV</button></div>`);
  head.insertAdjacentHTML('afterend', `<form class="ops-gfilter" id="ops-gfilter" aria-label="${t('ops.filterColumns')}" data-i18n-aria-label="ops.filterColumns" novalidate>
    <label><span data-i18n="ops.location">${t('ops.location')}</span><input type="search" data-f="q" placeholder="${t('ops.streetPlaceOrLatLon')}" data-i18n-placeholder="ops.streetPlaceOrLatLon" autocomplete="off"></label>
    <label><span data-i18n="ops.operator">${t('ops.operator')}</span><select data-f="op"><option value="all" data-i18n="ops.allOperators"><span data-i18n="ops.allOperators">${t('ops.allOperators')}</span></option></select></label>
    <div class="rng" role="group" aria-labelledby="ops-gf-cl"><span id="ops-gf-cl"><span data-i18n="ops.deployments">${t('ops.deployments')}</span></span><span><input type="number" min="1" step="1" inputmode="numeric" data-f="countMin" placeholder="${t('ops.from')}" data-i18n-placeholder="ops.from" aria-label="${t('ops.deploymentsFrom')}" data-i18n-aria-label="ops.deploymentsFrom"> – <input type="number" min="1" step="1" inputmode="numeric" data-f="countMax" placeholder="${t('ops.to')}" data-i18n-placeholder="ops.to" aria-label="${t('ops.deploymentsTo')}" data-i18n-aria-label="ops.deploymentsTo"></span></div>
    <div class="rng" role="group" aria-labelledby="ops-gf-al"><span id="ops-gf-al"><span data-i18n="ops.avgVehicles">${t('ops.avgVehicles')}</span></span><span><input type="number" min="0" step="0.5" inputmode="decimal" data-f="avgMin" placeholder="${t('ops.from')}" data-i18n-placeholder="ops.from" aria-label="${t('ops.avgVehiclesFrom')}" data-i18n-aria-label="ops.avgVehiclesFrom"> – <input type="number" min="0" step="0.5" inputmode="decimal" data-f="avgMax" placeholder="${t('ops.to')}" data-i18n-placeholder="ops.to" aria-label="${t('ops.avgVehiclesTo')}" data-i18n-aria-label="ops.avgVehiclesTo"></span></div>
    <div class="rng dates" role="group" aria-labelledby="ops-gf-dl"><span id="ops-gf-dl"><span data-i18n="ops.lastPeriod">${t('ops.lastPeriod')}</span></span><span><input type="date" data-f="from" aria-label="${t('ops.lastFrom')}" data-i18n-aria-label="ops.lastFrom"> – <input type="date" data-f="to" aria-label="${t('ops.lastTo')}" data-i18n-aria-label="ops.lastTo"></span></div>
    <div class="ops-actions"><span class="small muted" id="ops-gf-count" role="status"></span><button type="button" id="ops-gf-reset"><span data-i18n="ops.resetFilters">${t('ops.resetFilters')}</span></button></div></form>`);
  const form = $('#ops-gfilter'); let tmr = null;
  // nur bei geänderter Eingabe neu zeichnen: „change“ beim Verlassen eines Felds darf die Tabelle nicht ersetzen (sonst verpufft ein Klick
  // auf „Filter zurücksetzen“ in der Leerzeile, weil der Knopf zwischen mousedown und mouseup neu entsteht)
  const apply = () => { clearTimeout(tmr); if (!S.gf || !S.plan) return; let changed = false; for (const el of form.querySelectorAll('[data-f]')) if (String(S.gf[el.dataset.f] ?? '') !== el.value) { S.gf[el.dataset.f] = el.value; changed = true; } if (!changed) return; renderGroups(); legend(); drawLayers(['groups', 'collect']); };
  form.addEventListener('input', (e) => { clearTimeout(tmr); tmr = setTimeout(apply, e.target.type === 'search' ? 200 : 120); });
  form.addEventListener('change', apply);
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  const reset = () => { if (!S.gf || !S.plan) return; S.gf = { ...GF0(), kind: S.gf.kind, sort: S.gf.sort, dir: S.gf.dir, op: S.plan.op, forOp: S.plan.op, forAgs: S.plan.ags }; syncGf(true); renderGroups(); legend(); drawLayers(['groups', 'collect']); };
  $('#ops-gf-reset').addEventListener('click', reset);
  panel.addEventListener('click', (e) => {
    if (e.target.closest('#ops-gf-reset2')) { reset(); $('#ops-gf-reset')?.focus(); return; }
    const k = e.target.closest('[data-gk]'); if (k && S.gf && S.plan) { S.gf.kind = k.dataset.gk; const l = S.gf.kind === 'deploy' ? 'groups' : 'collect'; if (!S.show[l]) { S.show[l] = true; legend(); drawLayers([l]); } renderGroups(); return; }
    const b = e.target.closest('[data-sort]'); if (b && S.gf && S.plan) { const key = b.dataset.sort; S.gf.dir = S.gf.sort === key ? (S.gf.dir === 'asc' ? 'desc' : 'asc') : GCOLS.find(c => c.key === key).dir; S.gf.sort = key; renderGroups(); $(`#ops-groups [data-sort="${key}"]`)?.focus(); }
  });
  $('#ops-gcsv').addEventListener('click', () => { if (!S.plan || !S.gf) return; download(`${S.gf.kind === 'deploy' ? 'deploy-spots' : t('file.pickupPlaces')}_${slug()}.csv`, '﻿' + O.placesCsv(groupView(S.gf.kind), { labelOf: geoLabel, nearOf, lang: lang() }), 'text/csv'); });
  const note = panel.querySelector('.note');
  if (note) note.textContent = t('ops.derivedFromObservationNo', { GROUP_MIN: O.GROUP_MIN, GROUP_M: O.GROUP_M, GROUP_MERGE_M: O.GROUP_MERGE_M });
}
// Eingaben aus S.gf setzen; ein gerade bedientes Feld behält seine Eingabe (Cursor), außer nach „Zurücksetzen“
function syncGf(force = false) {
  for (const el of document.querySelectorAll('#ops-gfilter [data-f]')) { if (!force && el === document.activeElement) continue; const v = S.gf?.[el.dataset.f] ?? ''; if (el.value !== String(v)) el.value = v; }
}
// Leerzustand der Gruppentabelle als eigener Block unter der Tabelle; die Tabelle selbst ist dann ausgeblendet
export function groupsEmpty(tbl, msg) {
  const wrap = tbl.closest('.tbl'); if (!wrap) return;
  let box = wrap.nextElementSibling?.classList.contains('ops-groups-empty') ? wrap.nextElementSibling : null;
  if (!box) { box = document.createElement('div'); box.className = 'empty ops-groups-empty'; wrap.after(box); }
  wrap.hidden = !!msg; box.hidden = !msg; box.innerHTML = msg || '';
}
export function renderGroups() {
  const p = S.plan, f = X.fmt, esc = X.esc, g = p.groups, gf = S.gf, kind = gf.kind, deploy = kind === 'deploy', all = g?.[kind] || [];
  const tbl = $('#ops-groups'), panel = tbl.closest('.panel'), noun = deploy ? t('ops.deployments') : t('ops.pickups');
  panel.querySelector('h2').textContent = deploy ? t('ops.presumedDeploySpotsOf') : t('ops.pickupPlacesOfOperatorFrom');
  tbl.closest('.tbl')?.setAttribute('aria-label', deploy ? t('ops.presumedDeploySpotsOf2') : t('ops.pickupPlacesOfOperator'));
  panel.querySelectorAll('[data-gk]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.gk === kind)));
  $('#ops-gf-cl').textContent = noun;
  const [cMin, cMax] = panel.querySelectorAll('[data-f="countMin"],[data-f="countMax"]'); cMin.setAttribute('aria-label', t('ops.from2', { noun })); cMax.setAttribute('aria-label', t('ops.to2', { noun }));
  // Anbieter-Auswahl: alle mit Orten dieser Art, dazu der Plan-Anbieter
  const opsHere = new Map(); for (const s of all) opsHere.set(s.op, (opsHere.get(s.op) || 0) + 1);
  const opList = [...new Set([p.op, ...g.ops])].sort((a, b) => a.localeCompare(b, 'de'));
  const sel = panel.querySelector('[data-f="op"]');
  sel.innerHTML = `<option value="all">${t('ops.allOperators2', { length: f(all.length) })}</option>` + opList.map(o => `<option value="${esc(o)}">${esc(o)} (${f(opsHere.get(o) || 0)})</option>`).join('');
  if (gf.op !== 'all' && !opList.includes(gf.op)) gf.op = 'all';
  const days = all.map(s => s.last).sort((a, b) => a - b), dmin = days.length ? dayStr(days[0]) : '', dmax = days.length ? dayStr(days[days.length - 1]) : '';
  for (const el of panel.querySelectorAll('input[type=date]')) { el.min = dmin; el.max = dmax; }
  syncGf();
  // Kopf mit Sortier-Knöpfen
  tbl.querySelector('thead').innerHTML = `<tr>${GCOLS.map(c => { const on = gf.sort === c.key; return `<th${c.n ? ' class="n"' : ''}${on ? ` aria-sort="${gf.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}><button type="button" class="th-sort" data-sort="${c.key}" title="${t('ops.sortBy', { v0: c.label(), v1: on ? ` ${t('ops.now2', { v0: gf.dir === 'asc' ? t('common.ascending') : t('common.descending') })}` : '' })}">${c.label()}<i aria-hidden="true">${on ? (gf.dir === 'asc' ? '↑' : '↓') : ''}</i></button></th>`; }).join('')}</tr>`;
  const rows = groupView(kind), scope = gf.op === 'all' ? all : all.filter(s => s.op === gf.op);
  const where = t('ops.in', { v0: gf.op === 'all' ? t('ops.allOperators3') : gf.op, v1: X.muniName(p.ags) }), ev = scope.reduce((a, s) => a + s.count, 0), first = scope.length ? Math.min(...scope.map(s => s.first)) : null;
  const src = p.groupSrc?.source === 'groups' ? `${f(p.groupSrc.months.length)} ${p.groupSrc.months.length === 1 ? t('ops.monthlyFile') : t('ops.monthlyFiles')}${p.groupSrc.months.length ? ` (${p.groupSrc.months[0]}${p.groupSrc.months.length > 1 ? ` ${t('ops.to3', { v0: p.groupSrc.months[p.groupSrc.months.length - 1] })}` : ''})` : ''}` : t('ops.groupsJson30Days');
  $('#ops-groups-sub').textContent = t('ops.data', { v0: scope.length ? `${t('ops.atSince', { ev: f(ev), noun, length: f(scope.length), v3: scope.length === 1 ? t('ops.place') : t('ops.places'), v4: new Date(first).toLocaleDateString(fmtLocale()) })} · ` : '', where, src });
  $('#ops-gf-count').textContent = t('ops.ofPlacesShown', { length: f(rows.length), length2: f(all.length) });
  const tb = tbl.querySelector('tbody'), muni = esc(X.muniName(p.ags));
  if (!rows.length) {
    const filtered = !!(gf.q || gf.countMin || gf.countMax || gf.avgMin || gf.avgMax || gf.from || gf.to);
    const msg = p.groupSrc?.failed?.length && !all.length ? t('ops.groupEventsNotFullyLoadedSee')
      : !g.events.deploy && !g.events.collect ? t('ops.noGroupsObservedForYetPlace', { muni, GROUP_MIN: O.GROUP_MIN })
      : filtered ? `${t('ops.noPlaceMatchesFilters')}<button type="button" class="chip" id="ops-gf-reset2">${t('ops.resetFilters')}</button>`
      : t('ops.noObservedForYetAppearsAs', { where: esc(where), noun, GROUP_MIN: O.GROUP_MIN, v3: deploy ? t('ops.appear') : t('ops.disappear'), v4: all.length ? ` ${t('ops.otherOperatorsSetOperator', { length: f(all.length), v1: all.length === 1 ? t('ops.place') : t('ops.places2') })}` : '' });
    // Leerzustand außerhalb der scrollenden Tabelle (am Telefon sonst rechts abgeschnitten)
    tb.innerHTML = ''; groupsEmpty(tbl, msg); return;
  }
  groupsEmpty(tbl, null);
  tb.innerHTML = rows.map((s, i) => {
    const n = nearOf(s), k = geoKey(s.lat, s.lon), geo = GEO.get(k), ty = typesText(s.types);
    const main = geo ? `<span class="geo-main" translate="no" data-geo="${k}">${esc(geo)}</span>` : i < GROUP_GEO_TOP ? `<span class="geo-main" translate="no" data-geo="${k}" data-fallback="${t('ops.addressNotFound')}">${geo === null ? t('ops.addressNotFound') : `<span class="muted">${t('ops.lookingUpAddress')}</span>`}</span>` : osmLink(s.lat, s.lon);
    return `<tr><td>${main}<div class="sub-line">${geo !== undefined || i < GROUP_GEO_TOP ? osmLink(s.lat, s.lon) : ''}${(geo !== undefined || i < GROUP_GEO_TOP) && ty ? ' · ' : ''}${esc(ty)}</div></td>
    <td><span class="op"><i style="background:${X.opColor(s.op)}"></i>${esc(s.op)}</span></td>
    <td class="n"><b>${f(s.count)}</b><div class="sub-line">${t('ops.vehInTotal', { vehicles: f(s.vehicles) })}</div></td><td class="n">${whenText(s.last)}${s.count > 1 ? `<div class="sub-line">${t('ops.first', { v0: DAYMON.format(s.first) })}</div>` : ''}</td>
    <td class="n">${avgText(s.avg)}</td>
    <td class="n">${n ? t('ops.spotM', { rank: n.rank, v1: f(Math.round(n.d / 10) * 10), v2: n.d <= O.DEFAULTS.spotRadiusM ? `<div class="sub-line">${t('ops.withinSpotRadius')}</div>` : '' }) : `<span class="muted">${t('ops.noSpot')}</span>`}</td></tr>`;
  }).join('');
  queueGeo(rows.slice(0, GROUP_GEO_TOP));
}
const dayStr = (ms) => DAY_BERLIN.format(ms);
// Straße/Stadtteil für die Top-Spots per Nominatim (OSM): im Hintergrund, höchstens 1 Anfrage/s, Cache im Speicher
export const GEO = new Map(), GEO_TOP = 20;
 const geoQueue = [];
 let geoBusy = false;
export const geoKey = (lat, lon) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
function geoText(j) {
  const a = j?.address || {};
  const street = a.road || a.pedestrian || a.footway || a.square || a.path || a.cycleway || a.place || j?.name || null;
  const area = a.suburb || a.city_district || a.quarter || a.neighbourhood || a.village || a.town || null;
  return [street, area].filter(Boolean).join(' · ') || null;
}
export function queueGeo(spots) {
  for (const s of spots) { const k = geoKey(s.lat, s.lon); if (!GEO.has(k) && !geoQueue.some(q => q.k === k)) geoQueue.push({ k, lat: s.lat, lon: s.lon }); }
  pumpGeo();
}
async function pumpGeo() {
  if (geoBusy) return; geoBusy = true;
  try {
    while (geoQueue.length) {
      const q = geoQueue.shift(); if (GEO.has(q.k)) continue;
      const r = await X.getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${q.lat.toFixed(6)}&lon=${q.lon.toFixed(6)}&accept-language=de`, { timeout: 15000 });
      GEO.set(q.k, r.ok ? geoText(r.json) : null);
      document.querySelectorAll(`[data-geo="${q.k}"]`).forEach(el => { const tq = GEO.get(q.k); el.textContent = tq || el.dataset.fallback || t('ops.cellCentre'); });
      for (const [s, m] of S.spotMarkers) if (geoKey(s.lat, s.lon) === q.k) m.getElement()?.setAttribute('title', spotTitle(s));
      if (geoQueue.length) await new Promise(res => setTimeout(res, 1100)); // Nominatim-Nutzungsregel: höchstens 1 Anfrage je Sekunde
    }
  } finally { geoBusy = false; }
}
// ---------- Straßenkilometer (OSRM-Demo-Server) ----------
// Matrix je Tour über /table (Strecke und Fahrzeit; bis OSRM_MAX Punkte je Anfrage, größere Touren in Blöcken zu je OSRM_MAX/2 Punkten),
// Linie und Fahrzeit über /route. Höflich: alle Anfragen nacheinander mit ≥ 1,2 s Abstand; Ergebnisse je Punktpaar bzw. Punktfolge im
// Speicher gecacht (über Pläne und Reglerstellungen hinweg), nach Ausfall/429/5xx 2 Minuten Pause. Fehlt die Matrix, bleibt die Planung
// aus lib (Luftlinie × 1,35); einzelne fehlende Paare ersetzt O.matrixCost ebenso.
const OSRM = 'https://router.project-osrm.org', OSRM_MAX = 90, OSRM_GAP_MS = 1200, OSRM_PAUSE_MS = 120e3;
const MX = new Map(), ROUTES = new Map(), OSRM_S = { last: 0, chain: Promise.resolve(), downUntil: 0 };
const okey = (p) => `${(+p.lon).toFixed(5)},${(+p.lat).toFixed(5)}`;
export const osrmDown = () => Date.now() < OSRM_S.downUntil;
function osrmGet(path) {
  const run = async () => {
    if (osrmDown()) return null;
    const wait = OSRM_S.last + OSRM_GAP_MS - Date.now(); if (wait > 0) await new Promise(res => setTimeout(res, wait));
    OSRM_S.last = Date.now();
    const r = await X.getJson(OSRM + path, { timeout: 30000 });
    if (!r.ok) { if (!r.status || r.status === 429 || r.status >= 500) OSRM_S.downUntil = Date.now() + OSRM_PAUSE_MS; return null; }
    return r.json?.code === 'Ok' ? r.json : null;
  };
  const q = OSRM_S.chain.then(run, run); OSRM_S.chain = q.catch(() => null); return q;
}
// Straßenmatrix (Meter) für points; null, wenn kein einziges Paar bekannt ist
async function roadMatrix(points) {
  const keys = points.map(okey), uniq = [...new Set(keys)], h = uniq.length <= OSRM_MAX ? uniq.length : Math.floor(OSRM_MAX / 2), blocks = [];
  for (let i = 0; i < uniq.length; i += h) blocks.push(uniq.slice(i, i + h));
  const miss = (a, b) => a !== b && !MX.has(`${a}>${b}`);
  outer: for (let a = 0; a < blocks.length; a++) for (let b = a; b < blocks.length; b++) {
    const set = a === b ? blocks[a] : [...blocks[a], ...blocks[b]];
    if (!set.some(x => set.some(y => miss(x, y)))) continue;
    const j = await osrmGet(`/table/v1/driving/${set.join(';')}?annotations=distance,duration`);
    if (!j?.distances) break outer;
    set.forEach((x, i) => set.forEach((y, k) => { const d = j.distances[i]?.[k]; if (i !== k && d != null) MX.set(`${x}>${y}`, { d, t: j.durations?.[i]?.[k] ?? null }); }));
  }
  let known = 0; const D = keys.map(a => keys.map(b => { if (a === b) return 0; const v = MX.get(`${a}>${b}`); if (v) known++; return v ? v.d : null; }));
  return known ? { D, missing: keys.length * (keys.length - 1) - known } : null;
}
const roadDur = (seq) => { let s = 0; for (let i = 0; i < seq.length - 1; i++) { const a = okey(seq[i]), b = okey(seq[i + 1]); if (a === b) continue; const v = MX.get(`${a}>${b}`); if (v?.t == null) return null; s += v.t; } return s; };
async function roadRoute(seq) {
  const key = seq.map(okey).join(';'); if (ROUTES.has(key)) return ROUTES.get(key);
  if (seq.length > 100) return null; // Wegpunkte je Route begrenzt: dann nur km aus der Matrix, Linie gerade
  const rt = (await osrmGet(`/route/v1/driving/${key}?overview=simplified&geometries=geojson`))?.routes?.[0]; if (!rt) return null;
  const v = { coords: rt.geometry.coordinates.map(([lo, la]) => [la, lo]), km: +(rt.distance / 1000).toFixed(1), min: Math.round(rt.duration / 60) };
  ROUTES.set(key, v); return v;
}
// Tour nach Straße: Reihenfolge mit der Straßenmatrix neu (gleiches Ziel wie in lib: Strecke + λ · gewichtete Anfahrt, Gruppen bleiben),
// Vergleichswerte aus der Matrix, km und Fahrzeit aus der gefahrenen Route
async function roadOptimize(r, p) {
  const mx = await roadMatrix([p.depot, ...r.stops]); if (!mx || S.plan !== p) return false; // Plan inzwischen ersetzt: nichts in die alte Tour schreiben
  const sq = O.sequenceRun(O.runGroups(r.stops), { depot: p.depot, cost: O.matrixCost([p.depot, ...r.stops], mx.D), lambda: p.params.common.prioLambda });
  Object.assign(r, { stops: sq.stops, km: sq.km, kmSeq: sq.km, kmMin: sq.kmMin, kmNN: sq.kmNN, kmPrio: sq.kmPrio, reachKm: sq.reachKm, reachKmMin: sq.reachKmMin, obj: sq.obj, road: true, roadMissing: mx.missing });
  let seq = [p.depot, ...r.stops, p.depot], dur = roadDur(seq); if (dur != null) r.driveMin = Math.round(dur / 60);
  // S2.12: nach der Straßenzeit die Einsatzgrenze neu anwenden (niedrigste Priorität fällt weg, Rest neu geordnet)
  const limit = p.params.common.maxRunMin;
  if (limit && r.driveMin + r.handleMin > limit) {
    const cost = O.matrixCost([p.depot, ...r.stops], mx.D), D = O.DEFAULTS;
    const minOf = (sq) => { const d = roadDur(sq); if (d != null) return d / 60; let m = 0; for (let i = 0; i < sq.length - 1; i++) m += cost(sq[i], sq[i + 1]); return m / 1000 / D.speedKmh * 60; };
    const tr = O.trimRun(r, { depot: p.depot, cost, minOf, limitMin: limit, lambda: p.params.common.prioLambda });
    if (tr.removed) {
      Object.assign(r, { stops: tr.stops, vehicles: tr.vehicles, driveMin: tr.driveMin, handleMin: tr.handleMin, trimmed: (r.trimmed || 0) + tr.removed });
      const plan = { rebalance: p.rebalance, swap: p.swaps, workshop: p.workshop, station: p.station }[r.kind]; if (plan) plan.unplanned = (plan.unplanned || 0) + tr.removed;
      seq = [p.depot, ...r.stops, p.depot];
    }
  }
  const rt = await roadRoute(seq); if (S.plan !== p) return false;
  if (rt) { r.km = rt.km; r.driveMin = rt.min; }
  S.routed[r.id] = { coords: rt?.coords || null }; r.totalMin = r.driveMin + r.handleMin;
  return true;
}
export async function routeRuns() {
  const p = S.plan; if (!p || S.routing === p) return;
  S.routing = p; // eine noch laufende Schleife des vorigen Plans bricht ab; den Abstand zum Server hält osrmGet
  if (osrmDown()) { status(`${planStatus(p)} · ${t('ops.osrmUnreachable')}`); renderTiles(); S.routing = null; return; }
  // Reihenfolge: fokussierte Tour, dann sichtbare Arten, dann der Rest
  // Reihenfolge wird je Schritt neu bestimmt: eine während des Routings angeklickte Tour kommt als nächste dran
  const tried = new Set(), total = allRuns().filter(r => !S.routed[r.id]).length;
  const next = () => allRuns().filter(r => !S.routed[r.id] && !tried.has(r.id)).sort((a, b) => (b.id === S.focus) - (a.id === S.focus) || (S.show[b.kind] ? 1 : 0) - (S.show[a.kind] ? 1 : 0))[0];
  const base = () => $('#ops-status').textContent.split(` · ${t('ops.routingWord')}`)[0].split(' · Straßenrouting')[0]; // vorigen Routing-Stand abschneiden (Sprache der Seite)
  let n = 0, r;
  try {
    while ((r = next())) {
      if (S.plan !== p) return;
      tried.add(r.id);
      status(t('ops.roadRoutingOrderAndKmByRoad', { v0: base(), v1: ++n, total }));
      try { await roadOptimize(r, p); } catch { /* Tour bleibt bei Luftlinie */ }
      if (S.plan !== p) return;
      renderTiles(); renderRuns(); markFocus(); drawRoutes(); // nur Routen-Ebenen, nicht alle Marker
      await tick();
      if (osrmDown()) break; // Server nicht erreichbar: übrige Touren bleiben bei Luftlinie, kein Nachfeuern
    }
    // Zähler über S.routed: nach einer Neubewertung (Overpass) behalten die übrigen Touren ihr Routing
    const done = allRuns().filter(x => S.routed[x.id]).length;
    if (S.plan === p) { status(t('ops.roadRoutingOsrmOfRunsByRoad', { v0: base(), done, length: allRuns().length, v3: done < allRuns().length ? t('ops.restStraightLine135') : '' }) + (osrmDown() ? ` · ${t('ops.osrmUnreachable')}` : '')); renderTiles(); }
  } finally { if (S.routing === p) S.routing = null; }
}
// ---------- Einsammelliste: im eigenen Abstellverbot oder ohne Station in einer Pflicht-Abstellzone (lib/pulse-ops.js parkingViolations) ----------
// Zwei Arten je Fahrzeug (kind 'ban' | 'mpz'), getrennt ausgewiesen: Kopfzeile, Spalte „Art · Zone“, Marker (Schrägstrich bzw. „P“), CSV-Spalte art.
// Intern für die Flotte der Disposition (Anbieter und Fahrzeugart wie der Plan), kein Anbieter-Vergleich, im Kunden-Modus ausgeblendet (.internal).
// Zonen: die GBFS-Geofencing-Dateien des Datenstands (zones/<Datei>.json, nur Dateien mit dieser Gemeinde laut zones/index.json) über den
// gemeinsamen Cache (X.getJson, dieselben Downloads wie Übersichtskarte und Abstellverbote der Spots); nichts davon wird gespeichert.
// Gerechnet im Browser, unabhängig von Nachfrage und Plan. Eigene Kartenebenen außerhalb von S.layers (emptyPlan/showPicker räumen sie nicht ab),
// Schalter in der Ebenen-Leiste; die Marker haben Popups und sind so per Tastatur (web/mapkeys.js, N/P/Enter) erreichbar.
const COL_GEO_TOP = 10;
const isClient = () => document.body.classList.contains('mode-client');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const colValid = () => { const c = S.col; return c && c.ags === X.state.scope && c.op === S.op && c.type === $('#ops-type')?.value ? c : null; };
const idleText = (v) => v.idleMin == null ? '–' : idleCls(v.idleMin, v.idleCensored);
const zoneLabel = (z) => z.name || t('col.zoneId', { id: z.id });
// Art je Fahrzeug bzw. betroffener Zone: Pflicht-Abstellzone ohne Station (Blau wie „Abstellen nur an Stationen“ der Übersichtskarte), Fahrverbot (Rot), Abstellverbot
const colKind = (x) => (x.kind === 'mpz' ? 'mpz' : x.noRide ?? x.zone?.noRide ? 'noRide' : 'noPark');
const kindText = (x) => t({ mpz: 'col.kindMpz', noRide: 'col.kindNoRide', noPark: 'col.kindNoPark' }[colKind(x)]);
const kindColor = (x) => tok({ mpz: '--info', noRide: '--bad', noPark: '--warn' }[colKind(x)]);
// Marker: Kreis mit Schrägstrich (Verbot) bzw. mit „P“ (Pflicht-Abstellzone ohne Station); Form trägt die Art auch ohne Farbe
const violSvg = (c, bg, size = 20, css = '', mpz = false) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" style="${css}overflow:visible"><circle cx="10" cy="10" r="7.5" fill="${bg}" stroke="${c}" stroke-width="3"/>${mpz ? `<text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" font-family="sans-serif" fill="${c}">P</text>` : `<path d="M4.7 4.7 15.3 15.3" stroke="${c}" stroke-width="3"/>`}</svg>`;
const stationText = (v) => (v.stationDistM != null ? t('col.stationDist', { m: X.fmt(v.stationDistM) }) : t('col.stationNone', { km: X.fmt(O.COLLECT.stationSearchM / 1000) }));
export function initCollect() {
  if ($('#ops-col-panel')) return;
  if (S.show.viol == null) S.show.viol = true;
  const st = document.createElement('style'); st.id = 'ops-col-style';
  st.textContent = '.ops-col-head{margin:0 0 var(--s2);color:var(--fg-2)}.ops-col-head b{font-size:18px;color:var(--fg)}.ops-col-mk{background:none;border:0}.ops-col-mk svg{display:block}';
  document.head.appendChild(st);
  const anchor = $('#ops-spots')?.closest('.panel'); if (!anchor) return;
  anchor.insertAdjacentHTML('beforebegin', `<div class="panel c12 internal" id="ops-col-panel"><div class="panel-head"><div><h2 id="ops-col-h">${t('col.title')}</h2><div class="sub" id="ops-col-sub"></div></div><div class="inline-form"><button type="button" id="ops-col-csv" title="${t('col.csvTitle')}">↓ CSV</button></div></div>
    <p class="ops-col-head" id="ops-col-head"></p><div class="tbl" tabindex="0" role="region" aria-labelledby="ops-col-h"><table id="ops-col"><thead></thead><tbody></tbody></table></div><div class="empty" id="ops-col-empty" hidden></div>
    <p class="small muted" id="ops-col-note" style="margin:var(--s3) 0 0"></p></div>`);
  $('#ops-col-csv').addEventListener('click', () => { const c = colValid(); if (c?.res?.list.length) download(`${t('col.file')}_${ascii(X.muniName(c.ags))}_${ascii(c.op)}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, '﻿' + O.violationsCsv(c.res, { lang: lang() }), 'text/csv'); });
  $('#ops-col-panel').addEventListener('click', (e) => {
    const f = e.target.closest('[data-col-fly]'); if (f) { flyViol(+f.dataset.colFly); return; }
    if (e.target.closest('[data-col-retry]')) { S.col = null; S.retry = true; computePlan(); }
  });
  renderCollect();
}
// Zonen-Datei über den gemeinsamen Cache; nach „Erneut versuchen“ an einem gemerkten Fehlschlag vorbei (wie dataJson, Wunsch beim Start gemerkt)
async function zoneJson(file, retry) {
  const r = await X.getJson(X.CFG.DATA + `zones/${file}`, { timeout: 60000 });
  return !r.ok && retry && (!r.status || r.status >= 500) ? X.getJson(X.CFG.DATA + `zones/${file}?retry=${Date.now()}`, { timeout: 60000 }) : r;
}
// Gleiche Gemeinde, Flotte, Art und gleicher Sammler-Stand: Ergebnis bleibt (Tageszeit, Tage, Prioritätsregler rechnen nicht neu)
export async function collectFor(ags, op, type, vehicles, fleet) {
  const key = `${ags}|${op}|${type}|${fleet.at}`;
  if (S.col?.key === key && S.col.state !== 'fail') { renderCollect(); return; }
  const job = S.col = { key, ags, op, type, at: fleet.at, state: 'loading', retry: S.retry };
  renderCollect();
  try {
    // Ausschnitt nur, wenn alle Fahrzeuge samt Puffer der Prüfung (parkingViolations: größter Puffer + 10 m) darin liegen
    const own = vehicles.filter(v => v.operator === op && Number.isFinite(v.lat) && Number.isFinite(v.lon)), padM = Math.max(0, ...O.COLLECT.buffers) + 20;
    const vb = own.length ? [Math.min(...own.map(v => v.lon)), Math.min(...own.map(v => v.lat)), Math.max(...own.map(v => v.lon)), Math.max(...own.map(v => v.lat))] : null;
    const need = vb ? [vb[0] - padM / (111320 * Math.cos(((vb[1] + vb[3]) / 2) * Math.PI / 180)), vb[1] - padM / 111320, vb[2] + padM / (111320 * Math.cos(((vb[1] + vb[3]) / 2) * Math.PI / 180)), vb[3] + padM / 111320] : false;
    const src = await zoneSource(ags, op, need), idx = src ? null : await X.loadOnce('zonesIndex', 'zones/index.json');
    const list = src ? src.list : (idx?.zones || []).filter(z => z.operator === op && (z.municipalities || []).includes(ags));
    const got = await Promise.all(list.map((z, i) => { const sd = src?.slice?.files?.[i]?.file === z.file ? src.slice.files[i].doc : null; return sd ? { ok: true, json: sd } : zoneJson(z.file, job.retry); }));
    if (S.col !== job) return;
    const docs = got.filter(r => r.ok && Array.isArray(r.json?.features)).map(r => r.json);
    job.files = list.length; job.failed = list.length - docs.length;
    if ((!src && !idx) || (list.length && !docs.length)) job.state = 'fail';
    else { await tick(); if (S.col !== job) return; job.res = O.parkingViolations({ vehicles, stations: fleet.stations }, docs, { operator: op }); job.state = 'ok'; }
  } catch (e) { console.error(e); job.state = 'fail'; }
  if (S.col === job) renderCollect();
}
export function renderCollect() {
  const panel = $('#ops-col-panel'); if (!panel) return;
  const c = colValid(), f = X.fmt, esc = X.esc, B = O.COLLECT.buffers;
  const head = $('#ops-col-head'), sub = $('#ops-col-sub'), tbl = panel.querySelector('.tbl'), empty = $('#ops-col-empty');
  const show = (msg) => { tbl.hidden = !!msg; empty.hidden = !msg; empty.innerHTML = msg || ''; if (msg) panel.querySelector('tbody').innerHTML = ''; };
  $('#ops-col-h').textContent = t('col.title'); $('#ops-col-csv').title = t('col.csvTitle');
  $('#ops-col-note').textContent = t('col.method', { buffers: B.join('/'), stationM: O.COLLECT.stationM, mpzStationM: O.COLLECT.mpzStationM });
  $('#ops-col-csv').disabled = !(c?.state === 'ok' && c.res.list.length);
  syncViolToggle(); drawViol();
  if (S.plan && c && S.plan.ags === c.ags && S.plan.op === c.op) legend();
  head.innerHTML = ''; sub.textContent = c ? t('col.sub', { op: c.op, muni: X.muniName(c.ags), at: new Date(c.at).toLocaleString(fmtLocale(), { dateStyle: 'short', timeStyle: 'short' }) }) : '';
  if (!c) { show(t('col.noFleet')); return; }
  if (c.state === 'loading') { show(t('col.loading')); return; }
  if (c.state === 'fail') { show(`${t('col.failed')} <button type="button" class="chip" data-col-retry>${t('ops.tryAgain')}</button>`); return; }
  const r = c.res, k = r.counts;
  if (!r.features) { show(esc(t('col.noZones', { op: c.op }))); return; }
  // Kopfzeile: Summe und je Art (roh, robust gelistet); darunter die Zählung je Art zur Transparenz
  const kb = k.ban, km = k.mpz, rob = (x) => B.map(b => `${b} m ${f(x.robust[b])}`).join(', '), st = { stationM: r.stationM, mpzStationM: r.mpzStationM };
  head.innerHTML = `${t(k.listed === 1 ? 'col.headOne' : 'col.head', { n: `<b>${f(k.listed)}</b>`, buffers: B.join('/'), ban: f(kb.listed), raw: f(kb.raw), mpz: f(km.listed), mraw: f(km.raw), near: f(km.near), ...st })}`
    + `<br><span class="small muted">${esc(t('col.counts', { available: f(k.available), inZone: f(kb.inZone), mpz: f(kb.mpz), allowed: f(kb.allowed), station: f(kb.station), raw: f(kb.raw), robust: rob(kb), ...st }))}</span>`
    + (r.zones.mpz ? `<br><span class="small muted">${esc(t('col.countsMpz', { inZone: f(km.inZone), allowed: f(km.allowed), station: f(km.station), near: f(km.near), raw: f(km.raw), robust: rob(km), ...st }))}</span>` : '')
    + `<br><span class="small muted">${esc(t('col.zonesLine', { ban: f(r.zones.ban), mpzZones: f(r.zones.mpz), files: f(c.files) }))}</span>${c.failed ? `<br><span class="warn-text small">${esc(t('col.partial', { failed: f(c.failed), files: f(c.files) }))}</span>` : ''}`;
  if (!k.listed) { show(esc(t('col.none')) + (r.zones.ban + r.zones.mpz ? '' : ` ${esc(t('col.noBanZones'))}`)); return; }
  show(null);
  // 5 Spalten (am Telefon schmal): Rang · Standzeit, Lage, Art · Zone (mit Fahrzeugart, bei Pflicht-Abstellzone nächste Station), Ladestand · Reichweite, Karte
  tbl.querySelector('thead').innerHTML = `<tr><th class="n"># · ${t('col.idle')}</th><th>${t('ops.location')}</th><th>${t('col.kindZone')}</th><th class="n">${t('col.battery')} · ${t('col.range')}</th><th>${t('col.map')}</th></tr>`;
  tbl.querySelector('tbody').innerHTML = r.list.map((v, i) => {
    const g = geoKey(v.lat, v.lon), geo = GEO.get(g);
    const main = i < COL_GEO_TOP ? `<span class="geo-main" translate="no" data-geo="${g}" data-fallback="${esc(t('ops.addressNotFound'))}">${geo ? esc(geo) : geo === null ? t('ops.addressNotFound') : `<span class="muted">${t('ops.lookingUpAddress')}</span>`}</span><div class="sub-line">${osmLink(v.lat, v.lon)}</div>` : osmLink(v.lat, v.lon);
    const energy = [v.battery != null ? `${f(v.battery)} %` : null, v.rangeKm != null ? `${f(v.rangeKm, 1)} km` : null].filter(Boolean).join(' · ') || '–';
    return `<tr><td class="n"><span class="mono muted">${i + 1} ·</span> <b>${idleText(v)}</b></td><td>${main}</td><td>${violSvg(kindColor(v), tok('--panel'), 14, 'display:inline-block;vertical-align:-2px;margin-right:4px;', v.kind === 'mpz')}<b>${kindText(v)}</b><div class="sub-line">${esc(zoneLabel(v.zone))} · ${esc(X.TYPE[v.type] || v.type)}${v.kind === 'mpz' ? ` · ${stationText(v)}` : ''}</div></td>
      <td class="n">${energy}</td><td><button type="button" class="chip" data-col-fly="${i}">${t('ops.onMap')}</button></td></tr>`;
  }).join('');
  queueGeo(r.list.slice(0, COL_GEO_TOP));
}
// Kartenebene: Marker (Kreis mit Schrägstrich) je Fahrzeug, gestrichelte Umrisse der betroffenen Zonen (nicht anklickbar)
export function drawViol() {
  if (!S.map) return;
  if (!S.vl) S.vl = { zones: L.featureGroup().addTo(S.map), pts: L.featureGroup().addTo(S.map) };
  S.vl.zones.clearLayers(); S.vl.pts.clearLayers(); S.violMk = [];
  const c = colValid(); if (!c || c.state !== 'ok' || !S.show.viol || isClient()) return;
  const bg = tok('--panel');
  for (const z of c.res.zonesHit) { const col = kindColor(z); L.geoJSON(z.geometry, { interactive: false, style: { color: col, weight: 1.5, dashArray: '5 4', fillColor: col, fillOpacity: 0.07 } }).addTo(S.vl.zones); }
  c.res.list.forEach((v, i) => {
    S.violMk[i] = L.marker([v.lat, v.lon], { icon: L.divIcon({ className: 'ops-col-mk', html: violSvg(kindColor(v), bg, 20, '', v.kind === 'mpz'), iconSize: [20, 20] }), keyboard: false, zIndexOffset: 400, title: t('col.markerTitle', { i: i + 1, kind: kindText(v), idle: idleText(v) }) })
      .bindPopup(() => `<b>${t('col.popupTitle', { i: i + 1, kind: kindText(v) })}</b><br>${X.esc(c.op)} · ${X.esc(X.TYPE[v.type] || v.type)} · ${X.esc(zoneLabel(v.zone))}${v.kind === 'mpz' ? ` · ${stationText(v)}` : ''}<br>${t('col.popupIdle', { idle: idleText(v) })}${v.battery != null ? ` · ${t('ops.battery', { battery: X.fmt(v.battery) })}` : ''}${v.rangeKm != null ? ` · ${X.fmt(v.rangeKm, 1)} km` : ''}<br><span style="color:var(--muted)">${t('col.popupNote', { buffers: O.COLLECT.buffers.join('/') })}</span>`).addTo(S.vl.pts);
  });
}
const violCount = () => { const c = colValid(); return c?.state === 'ok' ? c.res.list.length : 0; };
export function violToggle() { return `<label class="tog internal"${violCount() ? '' : ' hidden'}><input type="checkbox" data-l="viol"${S.show.viol ? ' checked' : ''}> ${violSvg(tok('--warn'), tok('--panel'), 12, 'display:inline-block;vertical-align:-1px;')}<span>${t('col.layer')}</span></label>`; }
function syncViolToggle() { const i = $('#ops-layers input[data-l="viol"]'); if (!i) return; i.checked = !!S.show.viol; i.closest('label').hidden = !violCount(); }
// Legende: je vorkommender Art Zeichen und Anzahl, dazu der Hinweis auf die gestrichelten Zonen
export function violLegend() {
  if (!S.show.viol || !violCount()) return '';
  const n = {}; for (const v of colValid().res.list) n[colKind(v)] = (n[colKind(v)] || 0) + 1;
  const item = (k, x) => `<span class="internal">${violSvg(kindColor(x), tok('--panel'), 12, 'display:inline-block;vertical-align:-1px;margin-right:6px;', k === 'mpz')}${kindText(x)} (${X.fmt(n[k])})</span>`;
  return [['noPark', { zone: {} }], ['noRide', { zone: { noRide: true } }], ['mpz', { kind: 'mpz' }]].filter(([k]) => n[k]).map(([k, x]) => item(k, x)).join('') + `<span class="internal muted">${t('col.legendZones')}</span>`;
}
// „Auf Karte“: Ebene einschalten, Karte auf das Fahrzeug, Popup öffnen, Fokus auf die Karte (dort weiter mit N/P, Esc)
function flyViol(i) {
  const c = colValid(), v = c?.res?.list[i]; if (!v || !S.map) return;
  if (!S.show.viol) { S.show.viol = true; syncViolToggle(); if (S.plan) legend(); }
  drawViol();
  const box = $('#ops-map'); box.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  S.map.setView([v.lat, v.lon], Math.max(17, S.map.getZoom()), { animate: !reduced() });
  S.violMk[i]?.openPopup(); box.focus({ preventScroll: true });
}
// Methode als aufklappbarer Block über die volle Breite (das Panel trägt .prose mit 76ch; Breite hier per Inline-Stil aufgehoben),
// innen Spalten mit lesbarer Zeilenlänge
export function renderMethod() {
  const A = O.AHP, f = (x) => x < 1 ? `1/${Math.round(1 / x)}` : String(x), el = $('#ops-method'), D = O.DEFAULTS;
  el.style.maxWidth = 'none';
  el.innerHTML = `<details><summary style="cursor:pointer"><h2 style="display:inline;margin:0">${t('ops.method')}</h2> <span class="muted small">${t('ops.demandDeploySpotsAhpRuns')}</span></summary>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,44ch),1fr));gap:0 var(--s5);margin-top:var(--s2)">
  <section><h3>${t('ops.measuredDemandNetOutflow')}</h3><p>${t('ops.perCell250MAndTimeOfDayBand', { prelimH: D.prelimH })}</p>
  <h3>${t('ops.needFleetShortfall')}</h3><p>${t('ops.needMax0NetOutflowHHorizon', { horizonH: D.horizonH, baseH: D.baseH, minPerSpot: D.minPerSpot, maxPerSpot: D.maxPerSpot, spotRadiusM: D.spotRadiusM })}</p>
  <h3>${t('ops.deploySpotsMcda')}</h3><p>${t('ops.factorsStandardisedTo0195th')}</p>
  <h3>${t('ops.uncertaintyH')}</h3><p>${t('ops.uncertaintyText', { z: O.BOOT.z, draws: O.BOOT.draws, minShare: O.BOOT.minShare * 100 })}</p></section>
  <section><h3>${t('ops.weightsAhp')}</h3><div class="tbl"><table><thead><tr><th>AHP</th>${A.criteria.map(c => `<th class="n">${AHP_L[c]}</th>`).join('')}<th class="n">${t('ops.weight')}</th></tr></thead><tbody>${A.criteria.map((c, i) => `<tr><td>${AHP_L[c]}</td>${A.matrix[i].map(x => `<td class="n mono">${f(x)}</td>`).join('')}<td class="n mono"><b>${A.weights[c].toFixed(3)}</b></td></tr>`).join('')}</tbody></table></div>
  <p class="small">${t('ops.saatyScale1EquallyImportant3', { lambdaMax: X.fmt(A.lambdaMax, 3), cr: X.fmt(A.cr, 4) })}</p></section>
  <section><h3>${t('ops.runs')}</h3><p>${t('ops.rebalanceSurplusMeans', { minBatteryForMove: D.minBatteryForMove, v1: D.maxPickupM / 1000, swapThreshold: f(D.swapThreshold), swapRangeKm: f(D.swapRangeKm) })}</p>
  <p>${t('ops.swapRangeRule', { share: Math.round(O.RANGE_LIMIT.share * 100), maxP95: O.RANGE_LIMIT.maxP95Km, minN: O.RANGE_LIMIT.minN, std: f(D.swapRangeKm) })}</p>
  <p>${t('ops.bundlingByAreaOpenJob', { v0: D.maxRunMin / 60 })}</p>
  <p>${t('ops.orderPerRunPrio', { levels: O.PRIO_LEVELS.map((l, i) => `${i} = λ ${X.fmt(l, l % 1 ? 1 : 0)}`).join(', '), exactMax: O.EXACT_MAX, osrmMax: OSRM_MAX, detour: X.fmt(D.detour, 2), speedKmh: D.speedKmh })}</p>
  <p>${t('ops.prioValues', { energyW: X.fmt(O.PRIO.energyW, 1), idleW: X.fmt(O.PRIO.idleW, 1), idleRefH: O.PRIO.idleRefH, longIdleH: O.PRIO.longIdleH, longIdleBonus: X.fmt(O.PRIO.longIdleBonus, 1), needRef: O.PRIO.needRef, emptyBonus: X.fmt(O.PRIO.emptyBonus, 1), fullStation: X.fmt(O.PRIO.fullStation, 1) })}</p></section>
  <section><h3>${t('ops.limits')}</h3><p>${t('ops.idleTimeCountsFromFirst')}</p></section>
  </div></details>`;
}
