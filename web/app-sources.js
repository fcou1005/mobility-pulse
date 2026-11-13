// Dashboard: Quellen: Abdeckung, Datenvertrauen, Preise, Konsistenz, Versorgung an Haltestellen (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as C from './pulse-core.js';
import { t, tx, lang, fmtLocale } from './i18n.js';
import { $, CFG, DEMO, DIRS, TYPE, ageText, cl, dateTimeText, esc, fmt, foldSeries, isClient, link, opColor, pctf, state, timeText, tok } from './app-core.js';
import { FAILED, emptyRow, failedText, getJson, loadBoundaries, loadDaily, loadHistory } from './app-load.js';
import { muniName } from './app-scope.js';
import { dataHealth, dirLabel, pillStatus, tile } from './app-lang.js';
import { setAnswer } from './answer.js';
import { livePoints } from './app-map.js';
import { chartWidth, seriesSummary } from './app-energy.js';
import { durText, loadOnce } from './app-usage.js';
import { hourOf } from './app-calib.js';
import { opTypeIndex } from './app.js';
import { chartSpec, tableButton } from './charttip.js';

// ---------- Abdeckung ----------
// Abdeckung folgt dem Gebiet und dem Anbieter oben; „Ganz Deutschland“ hebt die Gebietswahl für diese Tabelle auf (gilt, bis das Gebiet wechselt)
export let covAllFor = null;
export const toggleCovAll = () => { covAllFor = covAllFor === state.scope ? null : state.scope; }; // S3.9: Umschalten aus der Steuerung
export function renderCoverage() {
  const munis = state.latest?.municipalities || {}; const q = ($('#cov-search').value || '').toLowerCase(); const dir = $('#cov-dir').value;
  const recs = state.latest?.sources || [];
  const local = state.scope !== 'DE' && covAllFor !== state.scope;
  const rows = [];
  for (const [ags, m] of Object.entries(munis)) {
    if (local && ags !== state.scope) continue;
    for (const [op, o] of Object.entries(m.operators || {})) {
      if (state.operator !== 'all' && op !== state.operator) continue;
      if (state.type !== 'all' && !(o.types?.[state.type] > 0)) continue; // gewählte Fahrzeugart (verknüpfte Filter)
      const srcs = recs.filter(r => r.operator === op && (r.municipalities || []).includes(ags));
      const dirs = [...new Set(srcs.flatMap(r => r.directories || []))];
      if (dir !== 'all' && !dirs.includes(dir)) continue;
      if (q && !`${m.name} ${op} ${m.state}`.toLowerCase().includes(q)) continue;
      const status = srcs.some(r => r.status === 'live') ? 'live' : srcs.some(r => r.status === 'delayed') ? 'delayed' : srcs[0]?.status || 'unknown';
      rows.push({ ags, m, op, o, srcs, dirs, status });
    }
  }
  rows.sort((a, b) => a.m.name.localeCompare(b.m.name, 'de') || a.op.localeCompare(b.op));
  const opsAll = new Set(rows.map(r => r.op)), places = new Set(rows.map(r => r.ags));
  $('#cov-tiles').innerHTML = [tile(t('app.operatorsOnSite'), fmt(rows.length), cl(t('app.operatorMunicipalityWith'), t('app.operatorsPerMunicipality'))), tile(cl(t('app.operatorGroups'), t('app.operator')), fmt(opsAll.size), cl(t('app.acrossAllSources'), t('app.nationwide'))), tile(t('app.municipalities'), fmt(places.size), t('app.withAvailableVehicles')), isClient() ? '' : tile(t('app.unassigned'), fmt(recs.filter(r => ['foreign', 'empty'].includes(r.status)).length), t('app.sourcesOutsideGermanyOr'))].join('');
  $('#cov-sub').innerHTML = `${esc(t('app.rows', { length: fmt(rows.length), v1: cl(t('app.collectorSnapshot'), t('app.asOf2')), v2: timeText(state.latest?.at) }))}${state.scope !== 'DE' ? `, <button type="button" class="chip" data-cov-all aria-pressed="${!local}">${esc(local ? t('app.covShowGermany') : t('app.covShowOnly', { place: muniName(state.scope) }))}</button>` : ''}`;
  const { show, rest } = pageRows('cov', rows, `${q}|${dir}|${state.latest?.at}|${local}|${state.operator}`);
  $('#tbl-cov tbody').innerHTML = show.map(r => `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line">${Object.entries(r.o.types || {}).filter(([, n]) => n).map(([tq, n]) => `${esc(TYPE[tq] || tq)} ${fmt(n)}`).join(', ')}</div></td><td>${esc(r.m.name)} <span class="muted">${esc(r.m.state)}</span></td><td class="n">${fmt(r.o.total)}</td><td class="n">${fmt(r.o.available)}</td><td class="small internal">${r.dirs.map(dirLabel).join(', ')}<div class="sub-line">${r.srcs.length} ${r.srcs.length === 1 ? t('app.source') : t('app.sources')}</div></td><td>${pillStatus(r.status)}</td><td><a href="#live" class="pick-muni" data-ags="${esc(r.ags)}">${t('app.openPlace2')}</a></td></tr>`).join('') || emptyRow(7, t('app.noMatches'), q || dir !== 'all' ? t('app.clearSearchOrChooseAll') : state.latest ? t('app.noOperatorsInCollector') : failedText('latest.json'));
  $('#cov-more').innerHTML = moreBtn('cov', rest, ` ${t('app.orNarrowSearch')}`);
  // Lücken mit gleichem Anbieter und gleichem Text als eine Karte mit Städteliste (z. B. Ryde in zehn NRW-Städten)
  // Hinweistext der Datenlücke: englisch, wo gepflegt (data/sources-manual.json → known_gaps[].note_en), sonst deutsch mit lang="de"
  const gapNote = (g) => lang() === 'en' && g.note_en ? `<p>${esc(g.note_en)}</p>` : `<p lang="de">${esc(g.note)}</p>`;
  const gb = new Map(); for (const g of state.latest?.gaps || []) { const k = `${g.operator}|${g.note}`; (gb.get(k) || gb.set(k, []).get(k)).push(g); }
  $('#gaps').innerHTML = [...gb.values()].map(list => { const g = list[0]; const cities = [...new Set(list.map(x => x.city))].sort((a, b) => a.localeCompare(b, 'de')); const since = list.map(x => x.since).filter(Boolean).sort()[0] || g.since; const ok = list.filter(x => x.probeOk).length;
    return `<div class="card info"><div class="k">${t('app.dataGap2')}</div><b>${esc(g.operator)}, ${cities.length > 1 ? esc(t('app.gapCities', { n: fmt(cities.length) })) : esc(g.city)}</b>${cities.length > 1 ? `<p translate="no">${esc(cities.join(', '))}</p>` : ''}${gapNote(g)}<div class="foot">${cities.length > 1 ? t('app.gapGroupFoot', { since: esc(since), v1: timeText(Math.max(...list.map(x => x.checkedAt || 0)) || null), ok: fmt(ok), n: fmt(list.length) }) : t('app.sinceLastCheckedFeed', { since: esc(g.since), v1: timeText(g.checkedAt), v2: g.probeOk ? t('app.reachable') : t('app.notReachable', { v0: esc(g.probeStatus ?? '–') }) })}</div></div>`; }).join('') || `<div class="empty">${t('app.noKnownGapsAllKnownOperators')}</div>`;
}
// Lange Tabellen: erst 100 Zeilen, je Klick 100 weitere; neuer Filter (Schlüssel) setzt auf 100 zurück
export const MORE = {};
export function pageRows(key, rows, filterKey) {
  const m = MORE[key]?.f === filterKey ? MORE[key] : (MORE[key] = { f: filterKey, n: 100 });
  return { show: rows.slice(0, m.n), rest: Math.max(0, rows.length - m.n) };
}
// eine Formulierung für „weitere Zeilen“ in allen Tabellen: bis 100 Rest alle auf einmal, sonst 100 und der verbleibende Rest
export const moreText = (rest) => (rest <= 100 ? t('common.showAllMore', { n: fmt(rest) }) : t('common.show100More', { n: fmt(rest - 100) }));
export const moreBtn = (key, rest, hint = '') => rest ? `<button class="more-rows" data-more="${esc(key)}">${moreText(rest)}</button>${hint ? ` <span class="muted">${esc(hint.trim())}</span>` : ''}` : '';
export const MORE_RENDER = { cov: () => renderCoverage(), src: () => renderSourceTable() };

// ---------- Quellen ----------
export function renderSources() {
  const recs = state.latest?.sources || []; const cat = state.catalog;
  const by = {}; for (const r of recs) by[r.status] = (by[r.status] || 0) + 1;
  $('#src-tiles').innerHTML = [tile(t('app.sourcesChecked'), fmt(recs.length), t('app.catalogueEntries', { v0: cat?.count ?? '–', v1: state.latest ? new Date(state.latest.at).toLocaleString(fmtLocale(), { dateStyle: 'short', timeStyle: 'short' }) : '–' })), (() => { const hA = dataHealth({ ags: 'DE' }); return tile(t('app.current'), `${fmt(hA.fresh)} <small>/ ${fmt(hA.counted)}</small>`, t('app.delayedStale', { v0: fmt(hA.delayed), v1: fmt(hA.stale) }), hA.level === 'ok' ? 'ok' : 'warn'); })(), tile(t('app.notUsable'), fmt((by.gone || 0) + (by.error || 0) + (by.auth || 0) + (by.empty || 0) + (by.unknown || 0)), t('app.goneErrorsTimeUnclearEmpty', { v0: fmt(by.gone || 0), v1: fmt(by.error || 0), v2: fmt(by.unknown || 0), v3: fmt(by.empty || 0), v4: by.duplicate || by.retired ? `, ${t('app.notCountedDuplicatesGoneFor', { v0: fmt(by.duplicate || 0), v1: fmt(by.retired || 0) })}` : '' })), tile(t('app.duplicatesRemoved'), fmt(state.latest?.dedupe?.duplicates), t('app.stationDuplicatesIdsReused', { v0: fmt(state.latest?.dedupe?.stationDuplicates), v1: fmt(state.latest?.dedupe?.reusedIds) }))].join('');
  const dirCount = {}; for (const r of recs) for (const d of r.directories || []) dirCount[d] = (dirCount[d] || 0) + 1;
  const dirInfo = {
    mobilitydata: [t('app.connected'), t('app.allSystemsOfGbfsCatalogue'), 'https://github.com/MobilityData/gbfs/blob/master/systems.csv'],
    mobidata_bw: [t('app.connectedPreferred'), t('app.stateFeedsOfBadenWuRttemberg'), 'https://mobidata-bw.de/sk/dataset/bikesh'],
    mobidrom_nrw: [t('app.connectedServiceAccess'), t('app.conflatedStateFeedsOfNorth'), 'https://www.mobilitaetsdaten.nrw/api/ckan/organization/angemeldet'],
    citybikes: [t('app.connectedSupplement'), t('app.stationCountersWithout'), 'https://api.citybik.es/v2/networks'],
    dott_direct: [t('app.candidatesChecked'), t('app.directFeedsGbfsApiRidedott'), 'https://gbfs.api.ridedott.com/public/v2/stuttgart/gbfs.json'],
  };
  $('#dirs').innerHTML = Object.entries(dirInfo).map(([k, [st, txt, url]]) => `<div class="card ok"><div class="k">${esc(st)}</div><b>${esc(DIRS[k])}</b><p>${esc(txt)}</p><div class="foot">${t('app.sourcesOriginalSource', { v0: fmt(dirCount[k] || 0), url })}</div></div>`).join('') +
    `<div class="card info"><div class="k">${t('app.basis')}</div>${t('app.municipalBoundariesBkg')}<p>${t('app.licenceDlDeBy20GpsDecides', { v0: `<span translate="no">${esc(state.latest?.boundaries?.attribution || '© GeoBasis-DE / BKG, VG250')}</span>` })}</p><div class="foot">${t('app.municipalitiesOriginalSource', { v0: fmt(state.latest?.boundaries?.count) })}</div></div>
     <div class="card warn"><div class="k">${t('app.notUsed')}</div>${t('app.dbApiMarketplaceVoiPartner')}<p>${t('app.bothRequirePersonal')}</p><div class="foot">${t('app.noPartnerAccess')}</div></div>`;
  loadOnce('reliability', 'reliability.json').then(() => renderSourceTable());
  renderConsistency(); renderMonitor().catch(e => console.error('Monitor', e)); renderQuality(); renderLicenses();
  // S4.8: Dateinamen nicht ladbarer Dateien stehen nur hier (unter „Prüfen“), die übrigen Ansichten nennen Grund und Handlung
  { const box = $('#failed-files'); if (box) { const list = [...FAILED].filter(([file]) => !/^incidents\//.test(file)); box.hidden = !list.length;
    box.innerHTML = list.length ? `<b>${t('ux.failedFiles')}</b> ${list.map(([file, st]) => `<span class="mono">${esc(file)}</span> (${st === 404 ? t('ux.missing404') : esc(String(st))})`).join(', ')}` : ''; } }
  // Methodik eingeklappt wie in der Disposition: sichtbar bleibt ein Satz, geöffnet bleibt geöffnet
  const mOpen = $('#method details')?.open;
  $('#method').innerHTML = `<h2>${t('app.analysisInDetail')}</h2><p>${t('app.methodLead')}</p><details class="more"${mOpen ? ' open' : ''}><summary>${t('app.methodSummary')}</summary>${METHOD()}</details>`;
}
// ---------- Datenvertrauen: Sammler-Monitor, Datenqualität, Lizenzen ----------
export const TRIGGER = { get schedule() { return t('app.scheduled'); }, get workflow_dispatch() { return t('app.manual'); }, get lokal() { return t('app.local'); }, push: 'Push' };
export async function renderMonitor() {
  const box = $('#monitor'); const doc = await loadOnce('runs', 'runs.json');
  const F = doc?.fields || ['at', 'dauer_ms', 'quellen', t('app.current2'), 'verzoegert', t('app.stale'), t('app.error'), 'fahrzeuge', 'stationen', 'fahrten', 'fahrtenden', 'kennungswechsel', 'ausloeser'];
  const ix = Object.fromEntries(F.map((f, i) => [f, i]));
  const runs = (doc?.runs || []).filter(r => Number.isFinite(r[ix.at])).sort((a, b) => a[ix.at] - b[ix.at]);
  if (!runs.length) { box.innerHTML = `<div class="empty">${t('app.monitorStartsWithNext')}</div>`; setAnswer($('#sources-answer'), { id: 'sources', sentence: esc(t('app.monitorStartsWithNext')), kpis: [] }); return; }
  const share = (r) => r[ix.quellen] ? (r[ix.aktuell] || 0) / r[ix.quellen] : null;
  const shares = runs.map(share).filter(x => x != null).sort((a, b) => a - b);
  const med = shares.length ? shares[Math.floor(shares.length / 2)] : null;
  const lvl = (v) => v == null || med == null ? 'warn' : v >= med - 0.05 ? 'ok' : v >= med - 0.15 ? 'warn' : 'bad';
  const GAP = 45 * 60e3, now = Date.now(), last = runs[runs.length - 1];
  const gaps = []; for (let i = 1; i < runs.length; i++) { const a = runs[i - 1][ix.at], b = runs[i][ix.at]; if (b - a > GAP) gaps.push([a, b, false]); }
  if (!DEMO && now - last[ix.at] > GAP && now - last[ix.at] < 7 * 86400e3) gaps.push([last[ix.at], now, true]);
  const W = chartWidth(box, () => renderMonitor().catch(e => console.error('Monitor', e))), H = W < 520 ? 170 : 150, P = { l: 44, r: 12, t: 12, b: 24 }, plotW = W - P.l - P.r;
  // Statt eines Punkts je Lauf (gut 500 in 7 Tagen) ein Wert je Zeitabschnitt: Median der Läufe als Linie; Punkt nur, wo ein Lauf deutlich unter
  // dem Üblichen lag (am niedrigsten Lauf). Abschnitt 1 Stunde, auf schmalen Bildschirmen länger (mind. 4 px je Abschnitt).
  const span0 = Math.max((gaps.some(g => g[2]) ? now : last[ix.at]) - runs[0][ix.at], 3600e3);
  const B = [1, 2, 3, 4, 6].find(b => plotW / (span0 / (b * 3600e3)) >= 4) || 6, BMS = B * 3600e3;
  const bStart = (tq) => { const hs = Math.floor(tq / 3600e3) * 3600e3; return B > 1 ? hs - (hourOf(hs) % B) * 3600e3 : hs; };
  const bk = new Map(); for (const r of runs) { const s = bStart(r[ix.at]); let b = bk.get(s); if (!b) bk.set(s, b = { s, runs: [] }); b.runs.push(r); }
  const buckets = [...bk.values()].sort((a, b) => a.s - b.s).map(b => {
    const v = b.runs.map(share).filter(x => x != null).sort((p, q) => p - q), n = v.length;
    const low = b.runs.reduce((m, r) => (share(r) != null && (m == null || share(r) < share(m)) ? r : m), null);
    return { ...b, med: n ? (v[(n - 1) >> 1] + v[n >> 1]) / 2 : null, min: n ? v[0] : null, low };
  });
  const t0 = buckets[0].s, t1 = Math.max(buckets[buckets.length - 1].s + BMS, gaps.some(g => g[2]) ? now : 0, t0 + 3600e3), span = t1 - t0;
  const lo = Math.max(0, Math.floor(((shares[0] ?? 0) - 0.05) * 10) / 10), hi = Math.min(1, Math.ceil(((shares[shares.length - 1] ?? 1) + 0.02) * 10) / 10) || 1;
  const x = (tq) => P.l + ((tq - t0) / span) * plotW, y = (v) => P.t + (1 - ((v ?? lo) - lo) / Math.max(0.05, hi - lo)) * (H - P.t - P.b);
  const dt = (tq) => dateTimeText(tq, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const pct = (v) => (v == null ? '–' : `${fmt(v * 100)} %`);
  let g = '';
  // y: unten, oben und der übliche Wert (gestrichelt) – Beschriftung entfällt, wo sie sich überdecken würde
  for (const v of [lo, hi]) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>${med != null && Math.abs(y(v) - y(med)) < 12 ? '' : `<text x="${P.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v * 100)} %</text>`}`;
  // Tagesmarken: Wochentag nur, wenn ein Tag ≥ 90 px breit ist; unter 48 px nur jeder zweite Tag
  const dayPx = plotW / Math.max(1, span / 86400e3), dayOpt = dayPx >= 90 ? { weekday: 'short', day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit' };
  if (span > 30 * 3600e3) { const d = new Date(t0); d.setHours(24, 0, 0, 0); let k = 0; for (let tq = +d; tq < t1; tq += 86400e3, k++) { const lab = new Date(tq).toLocaleDateString(fmtLocale(), dayOpt); g += `<line class="grid" x1="${x(tq).toFixed(1)}" x2="${x(tq).toFixed(1)}" y1="${P.t}" y2="${H - P.b}"/>${(dayPx >= 48 || !(k % 2)) && x(tq) + 4 + lab.length * 6.8 <= W ? `<text x="${(x(tq) + 4).toFixed(1)}" y="${H - 8}">${lab}</text>` : ''}`; } }
  else { const fit = Math.max(1, Math.floor(plotW / 56)), step = [1, 2, 3, 4, 6, 12].find(s => span / (s * 3600e3) <= fit) || 12; for (let tq = Math.ceil(t0 / 3600e3) * 3600e3; tq < t1; tq += 3600e3) { if (hourOf(tq) % step) continue; g += `<text x="${x(tq).toFixed(1)}" y="${H - 8}" text-anchor="middle">${timeText(tq)}</text>`; } }
  for (const [a, b, open] of gaps) g += `<rect class="gap" x="${x(a).toFixed(1)}" y="${P.t}" width="${Math.max(2, x(b) - x(a)).toFixed(1)}" height="${H - P.t - P.b}"/>`;
  if (med != null) g += `<line class="mon-med" x1="${P.l}" x2="${W - P.r}" y1="${y(med).toFixed(1)}" y2="${y(med).toFixed(1)}"/><text class="mon-med-t" x="${P.l - 6}" y="${(y(med) + 3).toFixed(1)}" text-anchor="end">${fmt(med * 100)} %</text>`;
  // Linie durch die Abschnittsmitten, unterbrochen, wo ein Abschnitt ohne Lauf dazwischen liegt
  const xc = (b) => x(b.s + BMS / 2);
  let d = '', prev = null; for (const b of buckets) { if (b.med == null) { prev = null; continue; } d += `${!prev || b.s - prev.s > BMS ? 'M' : 'L'}${xc(b).toFixed(1)} ${y(b.med).toFixed(1)} `; prev = b; }
  g += `<path class="mon-line" d="${d}"/>`;
  // Einbrüche: Stiel vom Abschnittswert zum niedrigsten Lauf, Punkt mit Rand in Flächenfarbe
  for (const b of buckets) { const l = b.min == null ? 'ok' : lvl(b.min); if (l === 'ok') continue; const cx = xc(b).toFixed(1); g += `<line class="mon-stem ${l}" x1="${cx}" x2="${cx}" y1="${y(b.med).toFixed(1)}" y2="${y(b.min).toFixed(1)}"/><circle class="mon-pt ${l}" cx="${cx}" cy="${y(b.min).toFixed(1)}" r="4"/>`; }
  // Trefferflächen je Abschnitt: Zusammenfassung und der niedrigste Lauf mit allen Werten
  const runTip = (r) => t('app.ofSourcesCurrentErrors', { v0: dt(r[ix.at]), v1: esc(TRIGGER[r[ix.ausloeser]] || r[ix.ausloeser] || '–'), v2: fmt(r[ix.aktuell]), v3: fmt(r[ix.quellen]), v4: pct(share(r)), v5: fmt(r[ix.fehler]), v6: fmt(r[ix.fahrzeuge]), v7: fmt(r[ix.fahrten]), v8: r[ix.dauer_ms] == null ? '–' : fmt(r[ix.dauer_ms] / 1000, 1) + ' s' });
  // S4.5: je Abschnitt Zusammenfassung und niedrigster Lauf im gemeinsamen Hover-Layer (web/charttip.js); Lücken ohne Lauf mit Dauer
  const gapAt = (b) => gaps.find(([a, e]) => a < b.s + BMS && e > b.s);
  const mon = chartSpec({ n: buckets.length, x: (i) => xc(buckets[i]), top: P.t, bottom: H - P.b, head: (i) => `${dt(buckets[i].s)}–${timeText(buckets[i].s + BMS)}`, label: t('app.collectorRunsOfLast7Days'), colHead: t('ct.timeCol'),
    cols: [t('ct.runs'), t('ct.median'), t('ct.lowest')], cell: (i, k) => [fmt(buckets[i].runs.length), pct(buckets[i].med), pct(buckets[i].min)][k],
    rows: (i) => { const b = buckets[i], gp = gapAt(b); return [{ label: t('ct.runs'), value: fmt(b.runs.length) }, { label: t('ct.median'), value: pct(b.med) }, { label: t('ct.lowest'), value: pct(b.min) }, ...(b.low ? [{ label: t('ct.lowestRun'), value: runTip(b.low).replace(/<[^>]+>/g, '') }] : []), ...(gp ? [{ label: t('ct.gap'), value: t('app.gapToWithoutRun', { a: dt(gp[0]), v1: gp[2] ? t('app.now') : dt(gp[1]), v2: durText(gp[1] - gp[0]) }) }] : [])]; } });
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const today = runs.filter(r => r[ix.at] >= +midnight).length;
  const trig = {}; for (const r of runs) { const k = r[ix.ausloeser] || t('app.unknown'); trig[k] = (trig[k] || 0) + 1; }
  const trigTxt = Object.entries(trig).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${fmt(n)} ${esc(TRIGGER[k] || k)}`).join(', ');
  const closed = gaps.filter(gp => !gp[2]); const longest = closed.length ? Math.max(...closed.map(([a, b]) => b - a)) : 0;
  const lastAge = now - last[ix.at], dips = buckets.filter(b => b.min != null && lvl(b.min) !== 'ok').length;
  // S4.1: Antwort oben in Quellen statt der drei Zahlen über dem Diagramm; Quellenzahl aus dataHealth (S4.2, ein Nenner mit Kopfzeile und Übersicht)
  const hh = dataHealth(), avgMin = runs.length > 1 ? (last[ix.at] - runs[0][ix.at]) / (runs.length - 1) / 60e3 : null, daysN = Math.max(1, Math.round((last[ix.at] - runs[0][ix.at]) / 86400e3));
  const longestAll = Math.max(longest, ...gaps.filter(gp => gp[2]).map(([a, b]) => b - a));
  setAnswer($('#sources-answer'), { id: 'sources',
    sentence: t('ans.sources', { ago: DEMO ? esc(new Date(last[ix.at]).toLocaleDateString(fmtLocale())) : esc(t('app.ago2', { lastAge: ageText(lastAge) })), a: `<strong>${fmt(hh.usable)}</strong>`, b: fmt(hh.counted) }),
    kpis: [
      { label: t('app.lastRun'), value: timeText(last[ix.at]), cmp: last[ix.dauer_ms] == null ? t('ans.noDuration') : t('ans.kRunDur', { s: fmt(last[ix.dauer_ms] / 1000, 1) }), tone: !DEMO && lastAge > GAP ? 'warn' : 'ok' },
      { label: t('ans.kRunsToday'), value: fmt(today), n: today, cmp: t('ans.kRunsTodayCmp', { n: fmt(runs.length), d: fmt(daysN), avg: avgMin == null ? '–' : fmt(avgMin, 1) }) },
      { label: t('app.gapsOver45Min'), value: fmt(gaps.length), n: gaps.length, cmp: gaps.length ? t('app.longest', { v0: durText(longestAll), v1: gaps.some(gp => gp[2]) ? `, ${t('app.openSinceLastRun')}` : '' }) : t('app.collectorRanWithoutGaps'), tone: gaps.length ? 'warn' : 'ok' },
    ],
    how: t('ans.sourcesHow', { trig: trigTxt }), asOf: dt(last[ix.at]) });
  box.innerHTML = `
  <svg class="chart mon-chart" data-px="1" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" ${mon.attrs} aria-label="${esc(`${t('app.collectorRunsOfLast7Days')}. ${t('app.monitorSummary', { n: fmt(runs.length), med: med == null ? '–' : fmt(med * 100), gaps: fmt(gaps.length) })}`)}">${g}</svg>${tableButton(mon.id)}
  <div class="legend"><span><i class="lnk"></i>${t('app.monLineKey', { b: B === 1 ? t('app.monHour') : t('app.monHours', { n: B }) })}</span><span><i class="lnk dash"></i>${t('app.usualShareOfCurrentSources', { v0: pct(med) })}</span>${dips ? `<span><i class="dot" style="background:var(--warn)"></i>${t('app.n515PointsBelow')}</span><span><i class="dot" style="background:var(--bad)"></i>${t('app.moreThan15PointsBelow')}</span>` : ''}${gaps.length ? `<span><i class="sq gap-key"></i>${t('app.gapOver45MinWithoutRun')}</span>` : ''}</div>`;
}
export function renderQuality() {
  const L0 = state.latest; const box = $('#quality');
  if (!L0) { box.innerHTML = `<div class="empty">${t('app.noCollectorSnapshotYetClean')}</div>`; return; }
  const d = L0.dedupe || {}; const recs = L0.sources || [];
  const tot = { unassigned: 0, outside: 0, missing: 0, repaired: 0, stationFallback: 0, ghosts: 0 };
  for (const r of recs) for (const k in tot) tot[k] += r.counts?.[k] || 0;
  const worst = recs.map(r => ({ r, n: (r.counts?.unassigned || 0) + (r.counts?.outside || 0) + (r.counts?.missing || 0) + (r.counts?.ghosts || 0) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 8);
  box.innerHTML = `<dl class="kv">
    <dt>${t('app.vehicleDuplicatesRemovedSame', { v0: d.prefixVariants ? t('app.ofWhichOnlyWithDifferentId', { prefixVariants: fmt(d.prefixVariants) }) : '' })}</dt><dd>${fmt(d.duplicates)}</dd>
    <dt>${t('app.stationDuplicatesSameIdOr')}</dt><dd>${fmt(d.stationDuplicates)}</dd>
    <dt>${t('app.idsReusedSameIdAtDistant')}</dt><dd>${fmt(d.reusedIds)}</dd>
    <dt>${t('app.noMunicipalityPositionIn')}</dt><dd>${fmt(tot.unassigned)}</dd>
    <dt>${t('app.outsideGermany')}</dt><dd>${fmt(tot.outside)}</dd>
    <dt>${t('app.noCoordinates', { v0: tot.stationFallback ? t('app.replacedByStationPosition', { stationFallback: fmt(tot.stationFallback) }) : t('app.withoutFallbackPosition') })}</dt><dd>${fmt(tot.missing)}</dd>
    ${tot.ghosts ? `<dt>${t('app.orphanedEntriesDisabledAnd')}</dt><dd>${fmt(tot.ghosts)}</dd>` : ''}
    ${tot.repaired ? `<dt>${t('app.coordinatesRepairedSwapped')}</dt><dd>${fmt(tot.repaired)}</dd>` : ''}
  </dl>${worst.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${t('app.sourcesWithMostExclusions')}" style="margin-top:var(--s3)"><table><thead><tr><th>${t('app.source3')}</th><th class="n">${t('app.noMunicipality')}</th><th class="n">${t('app.outside')}</th><th class="n">${t('app.noCoord')}</th><th class="n" title="${t('app.disabledAndWithoutSignalFor')}">${t('app.orphaned2')}</th></tr></thead><tbody>${worst.map(({ r }) => `<tr><td>${esc(r.name || r.id)}<div class="sub-line mono">${esc(r.id)}</div></td><td class="n">${fmt(r.counts?.unassigned || 0)}</td><td class="n">${fmt(r.counts?.outside || 0)}</td><td class="n">${fmt(r.counts?.missing || 0)}</td><td class="n">${fmt(r.counts?.ghosts || 0)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
export function renderLicenses() {
  const box = $('#licenses'); const recs = (state.latest?.sources || []).filter(r => !(r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status)));
  if (!recs.length) { box.innerHTML = `<div class="empty">${t('app.noSourcesYetOverviewAppears')}</div>`; return; }
  // Lizenz-Kennung (licenseId, z. B. CC0-1.0) vor URL; die URL bleibt Link
  const by = new Map(); for (const r of recs) { const k = r.licenseId || r.license || r.licenseUrl || ''; const e = by.get(k) || { n: 0, ops: new Set(), url: r.licenseUrl || (/^https?:/i.test(r.license || '') ? r.license : null) }; e.n++; e.ops.add(r.operator); by.set(k, e); }
  const rows = [...by].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  const label = (l, url) => !l ? `<span class="muted">${t('common.na')}</span>` : /^https?:\/\//i.test(l) ? link(l, `${esc(String(l).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''))} ↗`) : url ? link(url, `${esc(l)} ↗`) : esc(l);
  box.innerHTML = `<div class="tbl" tabindex="0" role="region" aria-label="${t('app.licences')}"><table><thead><tr><th>${t('app.licence')}</th><th class="n">${t('app.sources2')}</th><th>${t('app.operator')}</th></tr></thead><tbody>${rows.slice(0, 20).map(([l, e]) => `<tr><td>${label(l, e.url)}</td><td class="n">${fmt(e.n)}</td><td class="small">${esc([...e.ops].sort((a, b) => a.localeCompare(b, 'de')).slice(0, 5).join(', '))}${e.ops.size > 5 ? ` +${e.ops.size - 5}` : ''}</td></tr>`).join('')}</tbody></table></div><div class="muted small" style="margin-top:var(--s2)">${t('app.checkCommercialUsePerLicence', { v0: rows.length > 20 ? ` ${t('app.moreLicenceEntries', { v0: rows.length - 20 })}` : '' })}</div>`;
}
export function relCell(id) { const r = state.usage?.reliability?.sources?.[id]; if (!r || !r.runs) return '<span class="muted">–</span>'; const ok = (r.live + r.delayed) / r.runs; return `<span style="color:var(--${ok >= 0.95 ? 'ok' : ok >= 0.8 ? 'warn' : 'bad'})">${pctf(r.live + r.delayed, r.runs)}</span><div class="sub-line">${t('app.runsAvgMs', { runs: r.runs, latencyAvg: fmt(r.latencyAvg) })}</div>`; }
export function renderSourceTable() {
  const q = ($('#src-search').value || '').toLowerCase(); const stf = $('#src-status').value;
  const all = (state.latest?.sources || []).filter(r => (stf === 'all' || r.status === stf) && (!q || `${r.id} ${r.name} ${r.operator} ${r.url}`.toLowerCase().includes(q)));
  const hidden = all.filter(r => r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status) && !q);
  // Dubletten und länger verschwundene Quellen bilden eine eigene Gruppe am Ende (kein Fehler)
  const recs = all.filter(r => !hidden.includes(r)).sort((a, b) => (['duplicate', 'retired'].includes(a.status) ? 1 : 0) - (['duplicate', 'retired'].includes(b.status) ? 1 : 0));
  const munis = state.latest?.municipalities || {};
  const { show, rest } = pageRows('src', recs, `${q}|${stf}|${state.latest?.at}`);
  $('#tbl-src tbody').innerHTML = show.map(r => `<tr><td>${link(r.url, esc(r.name || r.id))}${r.attribution && r.attribution !== r.name ? `<div class="sub-line">${esc(r.attribution)}</div>` : ''}<div class="sub-line mono">${esc(r.id)}${r.sourceChanged ? `, ${t('app.sourceChange2')}` : ''}</div></td><td>${esc(r.operator)}</td><td class="small">${(r.directories || []).map(dirLabel).join(', ')}</td><td class="n">${esc(r.version || '–')}</td><td class="n">${fmt(r.counts?.vehicles)}<div class="sub-line">${[r.counts?.unassigned ? t('app.noMunicipality2', { unassigned: fmt(r.counts.unassigned) }) : '', r.counts?.outside ? t('app.outside2', { outside: fmt(r.counts.outside) }) : '', r.counts?.missing ? t('app.noCoord2', { missing: fmt(r.counts.missing) }) : ''].filter(Boolean).join(', ')}</div></td><td class="n">${fmt(r.counts?.stations)}</td><td class="n" title="${esc((r.municipalities || []).slice(0, 12).map(a => munis[a]?.name || a).join(', '))}">${fmt((r.municipalities || []).length)}</td><td class="n">${ageText(r.feedAgeMs)}</td><td class="n">${esc(r.quality ?? '–')}</td><td class="n">${relCell(r.id)}</td><td>${pillStatus(r.status)}${r.status === 'duplicate' && r.duplicateOf ? `<div class="sub-line">${t('app.sameAs', { duplicateOf: esc(r.duplicateOf), v1: r.duplicateShare != null ? ` (${pctf(r.duplicateShare, 1)})` : '' })}</div>` : r.errorCause ? `<div class="sub-line">${esc(String(r.errorCause).slice(0, 60))}</div>` : r.errors?.length ? `<div class="sub-line">${esc(tx(String(r.errors[0])).slice(0, 60))}</div>` : ''}</td><td class="small">${r.licenseId ? (r.licenseUrl ? link(r.licenseUrl, `${esc(r.licenseId)} ↗`) : esc(r.licenseId)) : r.license ? (/^https?:\/\//i.test(r.license) ? link(r.license, t('app.licence2')) : esc(r.license)) : `<span class="muted">${t('common.na')}</span>`}</td></tr>`).join('') || emptyRow(12, t('app.noMatches'), q || stf !== 'all' ? t('app.clearSearchOrChooseAllStates') : state.latest ? t('app.noSourcesInCollectorSnapshot') : failedText('latest.json'));
  $('#src-more').innerHTML = [moreBtn('src', rest, ` ${t('app.orNarrowSearch')}`), hidden.length ? t('app.checkedDirectFeedCandidates', { length: fmt(hidden.length) }) : ''].filter(Boolean).join(' ');
}

// ---------- Preise, Anteile an erfassten Fahrzeugen, Zuverlässigkeit ----------
export async function renderPricing() {
  const p = await loadOnce('pricing', 'pricing.json'); const tb = $('#tbl-pricing tbody');
  if (!p?.plans?.length) { tb.innerHTML = `<tr><td colspan="6" class="empty">${t('app.noPricingFeedsReadYetPrices')}</td></tr>`; return; }
  const tyIdx = state.type === 'all' ? null : opTypeIndex().inScope; // gewählte Fahrzeugart: nur Tarife von Anbietern mit dieser Art
  let list = p.plans.filter(x => (state.scope === 'DE' || (x.municipalities || []).includes(state.scope)) && (state.operator === 'all' || x.operator === state.operator) && (!tyIdx || tyIdx.get(x.operator)?.has(state.type)));
  const seen = new Set(); const rows = [];
  for (const src of list) for (const pl of src.plans) { const key = `${src.operator}|${pl.name}|${pl.unlock}|${pl.perMin[0]?.rate}`; if (seen.has(key)) continue; seen.add(key); rows.push({ op: src.operator, pl, src }); }
  rows.sort((a, b) => a.op.localeCompare(b.op) || (a.pl.unlock ?? 0) - (b.pl.unlock ?? 0));
  const money = (v, cur) => v == null ? '—' : esc(`${fmt(v, 2)} ${cur || '€'}`.replace(' EUR', ' €')); // Währung kommt aus dem Feed
  // Feed-Kennungen („LMG:PricingPlan:…“, „plan-scooter-EUR“) sind kein Tarifname: Fahrzeugart aus der Kennung („Tarif E-Scooter“), sonst der
  // erste Satz der Beschreibung (Satzende, nicht der Punkt in „0.99“), sonst „Tarif n“; die Kennung steht nur im title der Zelle
  const looksId = (s) => /^[A-Z]{2,}:|PricingPlan|-plan$|^plan-|^[\w-]{24,}$/i.test(s || '');
  const idType = (s) => { const m = /(e-?bike|cargo|scooter|bike)/i.exec(s || ''); if (!m) return null; const k = m[1].toLowerCase().replace('-', ''); return k === 'bike' ? t('app.tariffBike') : TYPE[k] || null; }; // „bike“ sagt nicht, ob mit Motor
  // Hinweis ausblenden, wenn er nur den Tarifnamen wiederholt
  const same = (a, b) => { const n = (s) => String(s || '').trim().replace(/[.\s]+$/, '').toLowerCase(); return n(a) === n(b); };
  const nth = new Map(); const planName = (op, pl) => { const raw = pl.name || pl.id || ''; if (!looksId(raw)) return { label: raw, id: pl.id || '' }; const ty = idType(`${pl.name || ''} ${pl.id || ''}`); if (ty) return { label: t('app.tariffType', { type: ty }), id: raw }; const d = String(pl.desc || '').split(/[.;](?=\s|$)|[\n]/)[0].trim(); const n = (nth.get(op) || 0) + 1; nth.set(op, n); return { label: d && d.length <= 60 ? d : t('app.tariffN', { n }), id: raw }; };
  tb.innerHTML = rows.slice(0, 60).map(({ op, pl, src }) => { const nm = planName(op, pl); return `<tr><td><span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span>${state.scope === 'DE' ? `<div class="sub-line">${esc(src.sourceId)}</div>` : ''}</td><td translate="no"${nm.id ? ` title="${esc(nm.id)}"` : ''}>${esc(nm.label)}</td><td class="n">${money(pl.unlock, pl.currency)}</td><td class="n">${pl.perMin.length ? pl.perMin.map(x => `${money(x.rate, pl.currency)}${x.interval && x.interval !== 1 ? ` ${t('app.perMin', { interval: x.interval })}` : ''}${x.start ? ` ${t('app.fromMin', { start: x.start })}` : ''}`).join('<br>') : '—'}</td><td class="n">${pl.perKm.length ? pl.perKm.map(x => money(x.rate, pl.currency)).join('<br>') : '—'}</td><td class="small" translate="no">${same(pl.desc, nm.label) ? '' : esc(pl.desc || '')}${pl.surge ? `, ${t('app.dynamic')}` : ''}</td></tr>`; }).join('') || `<tr><td colspan="6" class="empty">${t('app.noPricesForThisFilterNot')}</td></tr>`;
  $('#pricing-note').textContent = rows.length > 60 ? t('app.moreTariffsChooseAreaOr', { v0: rows.length - 60 }) : t('app.tariffsAsOf', { length: rows.length, v1: timeText(p.at) });
}
export async function renderShareChart() {
  const idx = state.histIndex; const box = $('#chart-share');
  // Tagesmittel aus history/daily.json (eine Datei statt sieben Verlaufstage, Vertrag 6); alter Datenstand: Verlaufstage einzeln
  const daily = await loadDaily();
  if (daily) {
    const fi = (daily.fields || []).indexOf('available'), days = (daily.days || []).slice(-7);
    // Bruchmarken (breaks): Tage vor einem Zählregel-Wechsel nicht zeigen, wenn die betroffenen Reihen ≥ 5 % des Bestands im Ausschnitt tragen
    const brk = daily.breaks || {}, cut = new Set(), brkOps = new Set(), brkDays = new Set();
    const perDay = days.map(d => { const m = new Map(); let aff = 0, all = 0; const ops = new Set(), bds = new Set(); for (const [k, ser] of Object.entries(daily.series)) { const [ags, op, ty] = k.split('|'); if (ags === 'DE' || !op) continue; if (state.scope !== 'DE' && ags !== state.scope) continue; if (state.type !== 'all' && ty !== state.type) continue; const v = ser[d]; if (!v || v[fi] == null) continue; m.set(op, (m.get(op) || 0) + v[fi]); all += v[fi]; if (brk[k] > d) { aff += v[fi]; ops.add(op); bds.add(brk[k]); } }
      if (all > 0 && aff / all >= 0.05) { cut.add(d); ops.forEach(o => brkOps.add(o)); bds.forEach(b => brkDays.add(b)); return null; } return m.size ? m : null; });
    const note = cut.size ? t('cal.shareBreak', { v0: [...brkDays].sort().map(b => `${b.slice(8)}.${b.slice(5, 7)}.`).join(', '), v1: esc([...brkOps].join(', ')) }) : '';
    if (days.length && fi >= 0) return drawShare(box, days, perDay, note);
  }
  const days = (idx?.days || []).slice(-7);
  if (!days.length) { box.innerHTML = `<div class="empty">${t('app.noHistoryYetItStartsWith')}</div>`; return; }
  const perDay = [];
  for (const d of days) { const h = await loadHistory(d); if (!h) { perDay.push(null); continue; } const byOp = new Map(); for (const [k, ser] of Object.entries(h.series)) { const [ags, op, ty] = k.split('|'); if (ags === 'DE') continue; if (state.scope !== 'DE' && ags !== state.scope) continue; if (state.type !== 'all' && ty !== state.type) continue; const v = ser.available.filter(x => x != null); if (!v.length) continue; byOp.set(op, (byOp.get(op) || 0) + v.reduce((a, b) => a + b, 0) / v.length); } perDay.push(byOp); }
  drawShare(box, days, perDay);
}
export function drawShare(box, days, perDay, note = '') {
  const ops = [...new Set(perDay.flatMap(m => m ? [...m.keys()] : []))];
  const totals = perDay.map(m => m ? [...m.values()].reduce((a, b) => a + b, 0) : 0);
  // Reihen, die an keinem Tag einen Anteil haben (z. B. Zeus 0,0 %), weder als Linie noch in der Legende
  // S4.6: Farbe je Anbieter, graue Anbieter als eine Reihe „Weitere“ (Anteile am selben Ganzen, Summe passt) statt .slice(0, 8)
  const series = foldSeries(ops.map(op => ({ name: op, color: opColor(op), values: perDay.map((m, i) => m && totals[i] ? ((m.get(op) || 0) / totals[i]) * 100 : null) })).filter(s => s.values.some(v => v > 0)).sort((a, b) => (b.values.at(-1) || 0) - (a.values.at(-1) || 0)), t('app.moreOperators'));
  // Titel aus den Daten: so viele Tage, wie Werte haben (statt fest „7 Tage“)
  const nDays = perDay.filter(Boolean).length; $('#share-days').textContent = nDays ? `, ${nDays} ${nDays === 1 ? t('rep.day') : t('rep.days')}` : '';
  const W = chartWidth(box, () => renderShareChart()), H = W < 520 ? 190 : 220, P = { l: 48, r: 16, t: 12, b: 26 };
  // y-Achse 0 bis aufgerundetes Maximum (Anteile liegen meist unter 30 %; 0–100 % drückte die Unterschiede platt)
  const mx = Math.max(0, ...series.flatMap(s => s.values.filter(v => v != null))), step = [1, 2, 5, 10, 20, 25].find(s => mx / s <= 5) || 25, top = Math.min(100, Math.max(step, Math.ceil(mx / step - 1e-9) * step));
  const x = (i) => P.l + (i / Math.max(1, days.length - 1)) * (W - P.l - P.r), y = (v) => P.t + (1 - v / top) * (H - P.t - P.b);
  let g = ''; for (let v = 0; v <= top + 1e-9; v += step) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 3}" text-anchor="end">${fmt(v)} %</text>`;
  const every = (W - P.l - P.r) / Math.max(1, days.length - 1) < 44 ? 2 : 1; // schmal: jeder zweite Tag beschriftet
  days.forEach((d, i) => { if (i % every && i !== days.length - 1) return; g += `<text x="${x(i)}" y="${H - 8}" text-anchor="${days.length > 1 && i === 0 ? 'start' : i === days.length - 1 && days.length > 1 ? 'end' : 'middle'}">${d.slice(8)}.${d.slice(5, 7)}.</text>`; });
  const paths = series.map(s => { let d = '', open = false; s.values.forEach((v, i) => { if (v == null) { open = false; return; } d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>` + s.values.map((v, i) => v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"/>`).join(''); }).join('');
  const shp = chartSpec({ n: days.length, x, top: P.t, bottom: H - P.b, head: (i) => `${days[i].slice(8)}.${days[i].slice(5, 7)}.`, label: t('app.shareOfRecordedVehicles'), colHead: t('ct.dayCol'), cols: series.map(s => s.name),
    cell: (i, k) => (series[k].values[i] == null ? '–' : `${fmt(series[k].values[i], 1)} %`), rows: (i) => series.map(s => ({ color: s.color, label: s.name, value: s.values[i] == null ? '–' : `${fmt(s.values[i], 1)} %`, sort: s.values[i] ?? -1 })) });
  box.innerHTML = `<svg class="chart" data-px="1" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" ${shp.attrs} aria-label="${esc(`${t('app.shareOfRecordedVehicles')}. ${seriesSummary(series, (v) => `${fmt(v, 1)} %`)}`)}">${g}${paths}</svg>${tableButton(shp.id)}`;
  $('#share-legend').innerHTML = series.map(s => `<span><i class="dot" style="background:${s.color}"></i>${esc(s.name)} <span class="mono">${s.values.at(-1) == null ? '—' : fmt(s.values.at(-1), 1) + ' %'}</span></span>`).join('') + (note ? `<span class="muted small">${note}</span>` : '');
}

// ---------- Konsistenz ----------
export const CONS_LABEL_DEF = () => ({ consistent: [t('app.consistent'), 'ok'], minor: [t('app.minorDeviation'), 'warn'], divergent: [t('app.divergent'), 'bad'], disjoint: [t('app.separateFleets'), 'info'], alt_unreachable: [t('app.alternativeNotReachable'), 'muted'], error: [t('app.error2'), 'bad'] });
export const CONS_KIND = { get version() { return t('app.v2V3SameHost'); }, get land_vs_betreiber() { return t('app.stateFeedOperator'); }, get betreiber_vs_land() { return t('app.operatorStateFeed'); } };
export const shortSrc = (id) => String(id).replace(/^mobidrom_[^:]+:source-/, 'NRW: ').replace(/^citybikes_/, 'CityBikes: ');
export async function renderConsistency() {
  const c = await loadOnce('consistency', 'consistency.json'); const tb = $('#tbl-cons tbody');
  if (!c) { tb.innerHTML = `<tr><td colspan="9" class="empty">${t('app.noConsistencyCheckYetItRuns')}</td></tr>`; return; }
  const inScope = (ids, ags) => state.scope === 'DE' ? true : (ags ? ags === state.scope : ids.some(id => (state.latest?.sources || []).find(r => r.id === id)?.municipalities?.includes(state.scope)));
  const rows = [];
  for (const e of c.systems) { if (!inScope([e.sourceId]) || (state.operator !== 'all' && e.operator !== state.operator)) continue; rows.push({ kind: `${esc(CONS_KIND[e.kind] || e.kind || t('app.alternativeFeed'))}${e.idsRekeyed ? `, ${t('app.idsReKeyed')}` : ''}${e.stationsOnly ? `, ${t('app.stations')}` : ''}<div class="sub-line mono">${esc(e.sourceId)}</div>`, op: e.operator, a: e.stationsOnly ? e.primary?.stations : e.primary?.vehicles, b: e.stationsOnly ? e.alt?.stations : e.alt?.vehicles, diff: e.countDiff, overlap: e.idOverlap, pm: e.posMatch, med: e.medianDistM, verdict: e.verdict, w: e.verdict === 'divergent' ? 3 : e.verdict === 'minor' ? 2 : e.verdict === 'alt_unreachable' ? 1 : 0 }); }
  for (const p of c.pairs) { if (!inScope([p.a.sourceId, p.b.sourceId], p.ags) || (state.operator !== 'all' && p.operator !== state.operator)) continue; rows.push({ kind: `${t('app.twoSources', { muniName: esc(muniName(p.ags)), v1: p.idsRekeyed ? `, ${t('app.idsReKeyed')}` : '' })}<div class="sub-line mono">${esc(shortSrc(p.a.sourceId))} ↔ ${esc(shortSrc(p.b.sourceId))}</div>`, op: p.operator, a: p.a.vehicles, b: p.b.vehicles, diff: p.countDiff, overlap: p.idOverlap, pm: p.posMatch, med: p.medianDistM, verdict: p.verdict, w: p.verdict === 'divergent' ? 3 : p.verdict === 'minor' ? 2 : p.verdict === 'disjoint' ? 1.5 : 0 }); }
  rows.sort((x, y) => y.w - x.w || (y.a || 0) - (x.a || 0));
  const seenRow = new Set(); const uniq = rows.filter(r => { const k = r.kind.replace(/<[^>]+>/g, '') + '|' + r.op; if (seenRow.has(k)) return false; seenRow.add(k); return true; });
  rows.length = 0; rows.push(...uniq);
  const show = rows.slice(0, 80);
  tb.innerHTML = show.map(r => { const [label, cls] = CONS_LABEL_DEF()[r.verdict] || [r.verdict, '']; return `<tr><td>${r.kind}</td><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span></td><td class="n">${fmt(r.a)}</td><td class="n">${fmt(r.b)}</td><td class="n">${r.diff == null ? '—' : pctf(r.diff, 1)}</td><td class="n">${r.overlap == null ? '—' : pctf(r.overlap, 1)}</td><td class="n">${r.pm == null ? '—' : pctf(r.pm, 1)}</td><td class="n">${r.med == null ? '—' : `${fmt(r.med)} m`}</td><td><span class="pill plain"${cls ? ` style="color:var(--${cls === 'muted' ? 'muted' : cls})"` : ''}>${esc(label)}</span></td></tr>`; }).join('') || emptyRow(9, t('app.noComparisonsInFilter'), t('app.comparisonsExistOnlyWhere'));
  const vc = {}; for (const r of rows) vc[r.verdict] = (vc[r.verdict] || 0) + 1;
  $('#cons-note').textContent = t('app.comparisonsAsOf', { length: rows.length, v1: Object.entries(vc).map(([k, v]) => `${v} ${(CONS_LABEL_DEF()[k] || [k])[0].toLowerCase()}`).join(', '), v2: timeText(c.at), v3: rows.length > show.length ? `, ${t('app.more3', { v0: rows.length - show.length })}` : '' });
}

export const METHOD = () => `
<h3>${t('app.counting')}</h3><p>${t('app.availableMeansBookableNot')}</p>
<h3>${t('app.freshness')}</h3><p>${t('app.collectorRatesEveryFeed')}</p>
<h3>${t('app.geoCheckAndPlaceAssignment')}</h3><p>${t('app.numberFormatsAreNormalised')}</p>
<h3>${t('app.duplicatesAndSourceChanges')}</h3><p>${t('app.vehiclesOfSameOperatorAre')}</p>
<h3>${t('app.energy')}</h3><p>${t('app.lowEnergyFollowsSameRule')}</p>
<h3>${t('app.history')}</h3><p>${t('app.collectorRunsEvery20Minutes')}</p>
<h3>${t('app.quality')}</h3><p>${t('app.sourceSQualityScoreRates')}</p>
<h3>${t('app.usageAndMovement')}</h3><p>${t('app.forEachVehicleCollectorKeeps')}</p>
<p>${t('app.tripsTripsAreDerivedFrom')}</p>
<p>${t('app.chargeJumpsFromBelow40ToAt')}</p>
<h3>${t('app.cellsZonesPrices')}</h3><p>${t('app.startAndDestinationCellsAre')}</p>
<h3>${t('app.consistencyAndWalkingRoutes')}</h3><p>${t('app.ifSystemInCatalogueHasSecond')}</p>
<h3>${t('app.calibration')}</h3>${(() => { const s = t('app.estimatesAreAlignedWith'), i = s.indexOf('. <b>'); return i < 0 ? `<p>${s}</p>` : `<p>${s.slice(0, i + 1)}</p><details class="more"><summary>${t('app.calibrationDetail')}</summary><p>${s.slice(i + 2)}</p></details>`; })()}
<h3>${t('app.limits')}</h3><p>${t('app.openFeedsDoNotCoverAll')}</p>`;

// ---------- Versorgung an Haltestellen ----------
export async function checkSupply() {
  const box = $('#supply');
  if (state.scope === 'DE') { box.innerHTML = `<div class="empty">${t('app.pleaseChooseMunicipality')}</div>`; return; }
  if (!state.live) { box.innerHTML = `<div class="empty">${t('app.firstFetchLiveSoThatVehicle')}</div>`; return; }
  await loadBoundaries();
  const f = state.boundaries?.features.find(x => x.properties.ags === state.scope); if (!f) { box.innerHTML = `<div class="empty">${t('app.municipalBoundaryMissing')}</div>`; return; }
  const b = f.bbox; const radius = +$('#sel-radius').value; const useWalk = $('#chk-walk').checked;
  box.innerHTML = `<div class="muted small">${t('app.loadingStops')}</div>`;
  const q = `[out:json][timeout:25];(node["highway"="bus_stop"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="tram_stop"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="station"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="halt"](${b[1]},${b[0]},${b[3]},${b[2]}););out body 800;`;
  let r = null;
  for (const ep of CFG.OVERPASS) { r = await getJson(`${ep}?data=${encodeURIComponent(q)}`, { timeout: 40000 }); if (r.ok && r.json?.elements) break; }
  if (!r?.ok || !r.json?.elements) { box.innerHTML = `<div class="empty">${t('app.overpassNotReachableAll', { v0: esc(r?.error || r?.status) })}</div>`; return; }
  const rawStops = (r.json.elements || []).filter(e => C.assignMunicipality(state.bIndex, e.lat, e.lon)?.ags === state.scope).map(e => ({ id: e.id, name: e.tags?.name || t('app.stop'), lat: e.lat, lon: e.lon, kind: e.tags?.railway ? 'Bahn/Tram' : 'Bus' }));
  // Gegenüberliegende Haltepunkte gleichen Namens (innerhalb 80 m) zu einer Haltestelle zusammenfassen
  const stops = [];
  for (const st of rawStops) { const twin = stops.find(o => o.name === st.name && C.haversineM(o.lat, o.lon, st.lat, st.lon) <= 80); if (twin) { twin.n = (twin.n || 1) + 1; twin.lat = (twin.lat * (twin.n - 1) + st.lat) / twin.n; twin.lon = (twin.lon * (twin.n - 1) + st.lon) / twin.n; continue; } stops.push({ ...st, n: 1 }); }
  const { vehicles } = livePoints(); const avail = vehicles.filter(v => !v.disabled && !v.reserved);
  // Luftlinie: drei nächste Kandidaten je Haltestelle
  for (const s of stops) {
    const cands = [];
    for (const v of avail) { const d = C.haversineM(s.lat, s.lon, v.lat, v.lon); if (cands.length < 2 || d < cands[1].d) { cands.push({ d, v }); cands.sort((a, b) => a.d - b.d); if (cands.length > 2) cands.pop(); } }
    s.cands = cands; s.dist = cands.length ? Math.round(cands[0].d) : null; s.op = cands[0]?.v.operator || null; s.walk = null; s.walkMin = null; s.walkOp = null;
  }
  // Fußweg (OSRM, Fußgänger-Profil der FOSSGIS-Instanz): nur Haltestellen, die per Luftlinie überhaupt in Reichweite sein könnten
  let routed = 0, routeFail = 0;
  if (useWalk && stops.length) {
    const limit = Math.max(radius * 2, 1500);
    const todo = stops.filter(s => s.dist != null && s.dist <= limit).slice(0, 600);
    const batchSize = 6; // 6 Haltestellen × ≤ 12 Ziele = ein Valhalla-Aufruf (Quellen × Ziele ≤ 100)
    const batches = []; for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
    let done = 0;
    for (const batch of batches) {
      box.innerHTML = `<div class="muted small">${t('app.calculatingWalkingRoutes', { done, length: todo.length, v2: state.walkProvider || 'Valhalla' })}</div><div class="progress"><i style="width:${(done / todo.length) * 100}%"></i></div>`;
      const targets = [], targetIdx = new Map();
      batch.forEach(s => s.cands.forEach(c => { const k = `${c.v.lon.toFixed(5)},${c.v.lat.toFixed(5)}`; if (!targetIdx.has(k)) { targetIdx.set(k, targets.length); targets.push({ lat: c.v.lat, lon: c.v.lon }); } }));
      const m = await walkMatrix(batch, targets);
      if (!m) { routeFail += batch.length; done += batch.length; continue; }
      batch.forEach((s, i) => {
        let best = Infinity, bestSec = null, bestOp = null;
        for (const c of s.cands) { const j = targetIdx.get(`${c.v.lon.toFixed(5)},${c.v.lat.toFixed(5)}`); const d = m.dist?.[i]?.[j]; if (d != null && d < best) { best = d; bestSec = m.sec?.[i]?.[j]; bestOp = c.v.operator; } }
        if (Number.isFinite(best)) { s.walk = Math.round(best); s.walkMin = bestSec != null ? Math.round(bestSec / 60) : null; s.walkOp = bestOp; routed++; }
      });
      done += batch.length;
      await new Promise(res => setTimeout(res, 40));
    }
  }
  // Fußweg, sonst Luftlinie (nicht geroutet oder außerhalb des Routing-Limits)
  const eff = (s) => useWalk ? (s.walk ?? s.dist) : s.dist;
  stops.sort((a, b) => (eff(b) ?? 1e9) - (eff(a) ?? 1e9));
  const gaps = stops.filter(s => eff(s) == null || eff(s) > radius);
  state.supply = { stops, radius, useWalk, eff };
  const vals = stops.map(eff).filter(v => v != null).sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  const ratio = (() => { const pairs = stops.filter(s => s.walk != null && s.dist); return pairs.length ? pairs.reduce((a, s) => a + s.walk / s.dist, 0) / pairs.length : null; })();
  box.innerHTML = `<div class="tiles" style="margin-bottom:10px">${tile(t('app.stops'), fmt(stops.length), t('app.osmWithinStopPointsMerged', { muniName: esc(muniName(state.scope)), length: fmt(rawStops.length) }))}${tile(t('app.withoutVehicleWithinM', { radius, v1: useWalk ? t('app.walkingRoute') : t('app.straightLine') }), fmt(gaps.length), pctf(gaps.length, stops.length) + ` ${t('app.ofStops')}`, gaps.length / Math.max(1, stops.length) > 0.4 ? 'warn' : '')}${tile(t('app.median', { v0: useWalk ? t('app.walkingRoute') : t('app.straightLine') }), med == null ? '—' : `${fmt(med)} m`, t('app.toNearestAvailableVehicle'))}${useWalk ? tile(t('app.detourFactor'), ratio == null ? '—' : fmt(ratio, 2), t('app.stopsRoutedWalkingRoute', { routed: fmt(routed), v1: state.walkProvider || 'Valhalla', v2: routeFail ? `, ${t('app.withoutRoute', { routeFail: fmt(routeFail) })}` : '' })) : ''}</div>
  <div class="tbl" tabindex="0" role="region" aria-label="${t('app.stopsWithoutVehicleWithin')}"><table><thead><tr><th>${t('app.stop')}</th><th>${t('app.type')}</th><th class="n">${t('app.straightLine')}</th>${useWalk ? `<th class="n">${t('app.walkingRoute')}</th><th class="n">${t('app.walkingTime')}</th>` : ''}<th>${t('app.operator')}</th></tr></thead><tbody>${gaps.slice(0, 40).map(s => `<tr><td translate="no">${esc(s.name)}</td><td>${s.kind}</td><td class="n">${s.dist == null ? '—' : `${fmt(s.dist)} m`}</td>${useWalk ? `<td class="n">${s.walk == null ? `<span class="muted">${s.dist != null && s.dist > Math.max(radius * 2, 1500) ? t('app.outOfRange') : t('app.notRouted')}</span>` : `${fmt(s.walk)} m`}</td><td class="n">${s.walkMin == null ? '—' : t('app.min2', { walkMin: fmt(s.walkMin) })}</td>` : ''}<td>${esc((useWalk && s.walkOp) || s.op || '–')}</td></tr>`).join('')}</tbody></table></div>${gaps.length > 40 ? `<div class="muted small">${t('app.moreStopsWithoutVehicle', { v0: gaps.length - 40 })}</div>` : ''}<div class="muted small" style="margin-top:6px">${useWalk ? t('app.walkingRoutesViaPedestrian', { max: fmt(Math.max(radius * 2, 1500)) }) : t('app.straightLineWalkingRoute')}</div>`;
}

// Fußweg-Matrix: OSRM (FOSSGIS, Fußgängerprofil), bei Ausfall Valhalla (FOSSGIS, pedestrian). Rückgabe {dist[i][j] m, sec[i][j]} oder null.
export async function walkMatrix(sources, targets) {
  if (!targets.length) return null;
  const osrm = async () => {
    const coords = [...sources.map(s => `${s.lon.toFixed(6)},${s.lat.toFixed(6)}`), ...targets.map(tq => `${tq.lon.toFixed(6)},${tq.lat.toFixed(6)}`)];
    const url = `${CFG.OSRM_FOOT}/table/v1/driving/${coords.join(';')}?sources=${sources.map((_, i) => i).join(';')}&destinations=${targets.map((_, j) => sources.length + j).join(';')}&annotations=distance,duration`;
    const r = await getJson(url, { timeout: 25000 });
    return r.ok && r.json?.code === 'Ok' ? { dist: r.json.distances, sec: r.json.durations } : null;
  };
  if (state.walkProvider === 'OSRM') return osrm();
  // Valhalla zuerst (schnelle Matrix, Quellen × Ziele ≤ 100 je Aufruf → Teilaufrufe); bei Ausfall OSRM
  const dist = [], sec = [];
  const per = Math.max(1, Math.floor(100 / targets.length));
  for (let i = 0; i < sources.length; i += per) {
    const part = sources.slice(i, i + per);
    try {
      const ctrl = new AbortController(); const tq = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(CFG.VALHALLA + '/sources_to_targets', { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources: part.map(s => ({ lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6) })), targets: targets.map(tq => ({ lat: +tq.lat.toFixed(6), lon: +tq.lon.toFixed(6) })), costing: 'pedestrian', units: 'kilometers' }) });
      clearTimeout(tq);
      if (!r.ok) throw new Error(`Valhalla ${r.status}`);
      const j = await r.json();
      for (const row of j.sources_to_targets || []) { dist.push(row.map(c => c.distance == null ? null : c.distance * 1000)); sec.push(row.map(c => c.time ?? null)); }
    } catch { const m = await osrm(); if (m) state.walkProvider = 'OSRM'; return m; }
    if (i + per < sources.length) await new Promise(res => setTimeout(res, 60));
  }
  state.walkProvider = 'Valhalla';
  return { dist, sec };
}
export function renderSupplyLayer() {
  const L_ = state.layers; L_.supply.clearLayers(); if (!state.supply) return;
  for (const s of state.supply.stops) { const d = state.supply.eff ? state.supply.eff(s) : s.dist; const gap = d == null || d > state.supply.radius; L.circleMarker([s.lat, s.lon], { radius: gap ? 6 : 4, weight: 2, color: gap ? tok('--bad') : tok('--info'), fillOpacity: .5 }).bindPopup(t('app.nearestAvailableVehicle', { name: esc(s.name), kind: s.kind, v2: s.dist == null ? '—' : t('app.mStraightLine', { n: fmt(s.dist) }), v3: s.walk != null ? `, ${t('app.mWalkMin', { walk: fmt(s.walk), walkMin: fmt(s.walkMin) })}` : '', v4: esc(s.walkOp || s.op || '') })).addTo(L_.supply); }
}
