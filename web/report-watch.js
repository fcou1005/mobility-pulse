// Mobility Pulse — Bericht (Ansicht) – Obergrenzen-Wächter, Wochen-Heatmap, Zonen-Beobachtung, Preis-Log, Feed-Prüfung (aus report.js geschnitten; report.js bleibt die Fassade für alle Importe).
import * as R from './pulse-report.js';
import { decodeFleet } from './pulse-ops.js';
import { t, tx } from './i18n.js';
import { mapKeys } from './mapkeys.js';
import { STATUS_DEF, WD, WDL, allDocs, bindOnce, dd, dm, emptyBox, fetchJson, filterText, head, hideTip, num, pctTxt, plural, prep, rampSpans, reference, showTip, st, stamp, tile } from './report-core.js';
import { capBlock, capInfoTable } from './report-maps.js';
import { prep2 } from './report-avail.js';
import { DERIVED_TXT_DEF, mbAmpelHtml } from './report-more.js';
import { ZONE_SERIES } from './tokens.js';
import { chartSpec } from './charttip.js';

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
        <div class="tiles" style="margin-top:var(--s3)">${tile(t('rep.eScootersPer1000Residents'), num(ctx, m.pop ? (total / m.pop) * 1000 : null, 1), m.pop ? t('rep.vehiclesResidents', { total: ctx.fmt(total), pop: ctx.fmt(m.pop) }) : t('rep.populationMissing'))}${tile(t('rep.tripsPer1000ResidentsAndDayMeasured'), num(ctx, rep?.totals.per1000Rides, 1), rep ? t('rep.eScootersExtrapolated', { v0: rep.quality.prelim ? `, ${t('rep.preliminary')}` : '' }) : t('rep.noDailyFilesYet2'))}</div>`;
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
  if (c.mean != null) return { value: `${ctx.fmt(c.mean, c.mean < 10 ? 1 : 0)} ${F}/h`, lines: [when, t('rep.meanOf', { v0: plural(c.n, t('rep.day'), t('rep.days3')), v1: c.dates.map(d => dm(d)).join(', '), v2: c.gapDays ? `, ${t('rep.withGapLeftOut', { v0: plural(c.gapDays, t('rep.day'), t('rep.days')) })}` : '' })] };
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
  const pal = ZONE_SERIES;
  const layers = zones.filter(z => z.polys?.length).map((z, i) => L.polygon(z.polys.map(rs => rs.map(r => r.map(([x, y]) => [y, x]))), { color: pal[i % pal.length], weight: 2.5, dashArray: '7 6', fillOpacity: 0.06 })
    .bindTooltip(`<b>${ctx.esc(z.name)}</b><br>${t('rep.zwAssumed', { m: ctx.fmt(z.accuracyM || 0) })}`, { sticky: true }).addTo(s.zmap));
  s.zmap.fitBounds(L.featureGroup(layers).getBounds(), { padding: [12, 12] });
  setTimeout(() => s.zmap?.invalidateSize(), 0);
}
const dayLabel = (d) => (/^\d{4}-\d{2}-\d{2}/.test(String(d)) ? `${String(d).slice(8, 10)}.${String(d).slice(5, 7)}.` : String(d));
function sparkline(ctx, series) {
  const pts = (series || []).filter(([, v]) => Number.isFinite(v));
  if (pts.length < 2) return '<span class="muted">–</span>';
  const W = 96, H = 22, P = 3, vs = pts.map(([, v]) => v), lo = Math.min(...vs), hi = Math.max(...vs), sp = hi - lo || 1;
  const xy = pts.map(([, v], i) => [P + (W - 2 * P) * i / (pts.length - 1), H - P - (H - 2 * P) * (v - lo) / sp]);
  const label = t('rep.zwSpark', { n: pts.length, lo: ctx.fmt(lo), hi: ctx.fmt(hi), last: ctx.fmt(vs[vs.length - 1]) });
  const cs = chartSpec({ n: pts.length, x: (i) => xy[i][0], top: 0, bottom: H, head: (i) => dayLabel(pts[i][0]), rows: (i) => [{ color: 'var(--accent)', label: t('rep.zwSparkRow'), value: ctx.fmt(vs[i]) }] }, { focus: false });
  return `<svg class="rp-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${ctx.esc(label)}" ${cs.attrs}><polyline points="${xy.map(p => p.map(x => x.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${xy[xy.length - 1][0].toFixed(1)}" cy="${xy[xy.length - 1][1].toFixed(1)}" r="2.5" fill="var(--accent)"/></svg>`;
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
    return `<h3 class="rp-h3">${esc(z.name)}${city ? ` <span class="muted">(${esc(city)})</span>` : ''}</h3>${z.assumed ? `<div class="small muted" style="margin:-4px 0 var(--s2)"><span class="rp-status hint"><i aria-hidden="true">i</i>${t('rep.zwAssumed', { m: fmt(z.accuracyM || 0) })}</span>${z.description ? ` <span translate="no">${esc(z.description)}</span>` : ''}</div>` : ''}${z.rows.length ? `<div class="tbl"><table><thead><tr><th>${t('rep.operator2')}</th><th class="n">${t('rep.zwNow')}</th><th class="n">${t('rep.zwToday')}</th><th class="n">${t('rep.zwMean7')}</th><th class="n">${t('rep.zwMax30')}</th>${trend ? `<th>${t('rep.zwTrend')}</th>` : ''}</tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">${t('rep.zwNone')}</div>`}`;
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
    + `<div class="muted small" style="margin-top:var(--s2)">${t('rep.amountsInTariffSCurrencyAsIn', { v0: list.length > 200 ? `${t('rep.olderHidden', { v0: list.length - 200 })}, ` : '', v1: at ? `, ${t('rep.asOf3', { at: stamp(at) })}` : '' })}</div>`;
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
  const rows = checked.slice(0, 300).map(({ r, c }) => `<tr><td>${/^https?:/i.test(r.url || '') ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name || r.id)}</a>` : esc(r.name || r.id)}<div class="sub-line">${esc(r.operator || '')}${r.version ? `, GBFS ${esc(r.version)}` : ''}${r.status === 'duplicate' ? `, ${t('rep.duplicateNotCounted')}` : ''}${r.mirror ? `, ${t('rep.mirrorOf', { of: esc(r.mirror.of), n: ctx.fmt(r.mirror.dropped) })}` : ''}${r.batteryScale?.suspect ? `, ${t('rep.batteryScaleSuspect', { p99: ctx.fmt(r.batteryScale.p99) })}` : ''}${r.rangeCheck?.derived ? `, ${t('rep.rangeDerived', { km: r.rangeCheck.types.filter(x => x.derived).map(x => ctx.fmt(x.kmPer100, 1)).join(' / ') })}` : ''}</div></td>
    <td class="n">${c.errors ? `<span class="rp-status over"><i aria-hidden="true">✕</i>${c.errors}</span>` : '<span class="muted">0</span>'}</td><td class="n">${c.warnings ? `<span class="rp-status near"><i aria-hidden="true">!</i>${c.warnings}</span>` : '<span class="muted">0</span>'}</td>
    <td class="small">${c.findings.slice(0, 3).map(f => `<div>${f.level === 'error' ? t('rep.error') : t('rep.warning')}: ${esc(tx(f.text)).slice(0, 160)}</div>`).join('') || `<span class="muted">${t('rep.noFindings')}</span>`}${Math.max(c.findings.length, c.errors + c.warnings) > 3 ? `<div class="muted">${t('rep.more', { v0: Math.max(c.findings.length, c.errors + c.warnings) - 3 })}</div>` : ''}</td></tr>`).join('');
  el.innerHTML = title + `<div class="muted small" style="margin-bottom:var(--s2)">${t('rep.checkedWithoutFindingsWith', { v0: plural(checked.length, t('rep.source'), t('rep.sources')), ok, length: checked.filter(x => x.c.errors).length })}</div>
    <div class="tbl"><table><thead><tr><th>${t('rep.source')}</th><th class="n">${t('rep.error')}</th><th class="n">${t('rep.warnings')}</th><th>${t('rep.firstFindings')}</th></tr></thead><tbody>${rows}</tbody></table></div>${checked.length > 300 ? `<div class="muted small">${t('rep.moreSourcesNarrowArea', { v0: checked.length - 300 })}</div>` : ''}`;
  el.insertAdjacentHTML('beforeend', mbAmpelHtml(ctx)); // Ampel der Ereignisregeln je Gruppe (Messbasis)
}

// ======================================================================
// Gemeinsame Bausteine für Tabellen mit Auswahlfeldern, Sortierung und „mehr zeigen“
// ======================================================================
export const TYPE_ORDER = ['scooter', 'ebike', 'bike', 'cargo', 'moped', 'car', 'other', 'unknown'];
