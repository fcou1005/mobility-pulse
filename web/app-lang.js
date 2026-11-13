// Dashboard: Sprache, Kopfzeile, Übersicht und Leistung (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import { t, lang, setLang, applyStatic, fmtLocale, suggestLang, dismissSuggestion, tIn, ensureI18n } from './i18n.js';
import { $, $$, DEMO, DIRS, STATUS, TYPE, ageText, cl, emptyTip, esc, fmt, gl, isClient, opColor, pctf, state, timeText } from './app-core.js';
import { clearNotice, emptyRow, failedText, notice, refreshNotices } from './app-load.js';
import { USABLE, effStatus, liveRec, muniName, operatorRows, scopeGroups, scopeLabel, sourcesForScope, sumStats } from './app-scope.js';
import { M, VIEWS, copyLink, currentView, dataReady, dirty, safe, setView } from './app-router.js';
import { renderMap } from './app-map.js';
import { energyFor, energyOfOp, energySub, energyVal } from './app-energy.js';
import { computeSignals, sigCard } from './app-signals.js';
import { populateOperators, populateScope, renderFilterSum } from './app.js';

// ---------- Sprache (DE | EN) ----------
// Umschalter in der Kopfleiste (auch Kundenansicht). Wechsel ohne Neuladen der Daten: statische Texte (data-i18n), Kopf, Hinweise,
// Auswahllisten, Seitentitel; alle Ansichten werden als veraltet markiert und die aktive neu gezeichnet (Karten-Popups und Legenden inklusive).
export function renderLangSwitch() {
  const box = $('#lang-switch'); if (!box) return;
  box.setAttribute('aria-label', t('common.language'));
  $$('button[data-lang]', box).forEach(b => { const on = b.dataset.lang === lang(); b.setAttribute('aria-pressed', String(on)); b.tabIndex = on ? 0 : -1; });
}
export function bindLangSwitch() {
  const box = $('#lang-switch'); if (!box) return;
  box.addEventListener('click', (e) => { const b = e.target.closest('button[data-lang]'); if (!b) return; setLang(b.dataset.lang); renderLangSwitch(); });
  // Pfeiltasten wie in einer Segmentgruppe: Fokus und Wahl wandern zur anderen Sprache
  box.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const bs = $$('button[data-lang]', box); const i = bs.indexOf(document.activeElement); if (i < 0) return;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length;
    e.preventDefault(); bs[j].focus(); setLang(bs[j].dataset.lang); renderLangSwitch();
  });
}
// Englischer Browser, noch keine Wahl: Vorschlag in der anderen Sprache, ablehnbar
export function renderLangHint() {
  const sug = suggestLang();
  if (!sug) { clearNotice('lang'); return; }
  ensureI18n(['core'], sug).then(() => renderLangHint2(sug));
}
export function renderLangHint2(sug) {
  const el = notice(() => `<span lang="${sug}">${tIn(sug, 'common.langHint')}</span> <button type="button" class="chip" data-lang-yes="${sug}" lang="${sug}">${tIn(sug, 'common.langSwitch')}</button> <button type="button" class="chip" data-lang-no lang="${sug}">${tIn(sug, 'common.langKeep')}</button>`, '', 'lang');
  el.onclick = (e) => { const y = e.target.closest('[data-lang-yes]'); if (y) { clearNotice('lang'); setLang(y.dataset.langYes); renderLangSwitch(); } else if (e.target.closest('[data-lang-no]')) { dismissSuggestion(); clearNotice('lang'); } };
}
export function onLanguage() {
  applyStatic();
  $$('abbr[data-gloss]').forEach(a => { a.title = gl(a.dataset.gloss); });
  const share = $('#btn-share'); clearTimeout(copyLink.t); share.classList.remove('done'); share.textContent = isClient() ? t('app.copyClientLink') : t('app.copyLink');
  renderLangSwitch(); clearNotice('lang'); refreshNotices();
  if (state.map && state.tiles) { const prev = state.tiles.options.attribution, next = t('app.openstreetmapContributors'); if (prev !== next) { state.tiles.options.attribution = next; state.map.attributionControl?.removeAttribution(prev).addAttribution(next); } }
  if (state.latest) { populateScope(); populateOperators(); }
  safe(() => M.ops?.relabelOps?.()); safe(() => M.fl?.relabelFlows?.()); safe(() => M.cmp?.relabelCompare?.(document.getElementById('cmp-panel'))); safe(() => M.sp?.relabelSpots?.(document.getElementById('spots-panel'))); // Disposition behält den Plan, Fahrtrouten bauen ihr Gerüst neu
  if (dataReady) { safe(renderHeader); for (const v of VIEWS) dirty.add(v); }
  setView(currentView); // Kopf, Seitentitel, Segmente; zeichnet die aktive Ansicht neu
}
// Ein Stand oben: „Sammler 09:26 · vor 7 Min.“ bzw. „Live 09:33“; die Seitenleiste nennt nur den Umfang
export function renderStamp() {
  const live = state.mode === 'live' && state.live;
  const at = live ? state.live.at : state.latest?.at;
  const pill = $('#stand-pill');
  if (pill) { pill.textContent = !at ? t('app.asOf') : live ? `Live ${timeText(at)}` : t('app.ago', { v0: cl(t('app.collector'), t('app.asOf2')), at: timeText(at), v2: ageText(Date.now() - at) }); pill.classList.toggle('stale', !live && !DEMO && !!at && Date.now() - at > 45 * 60e3); pill.title = at ? t('app.dataAsOf', { v0: new Date(at).toLocaleString(fmtLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }) }) : ''; }
  const el = $('#side-stamp'); if (!el) return;
  el.textContent = state.latest ? t('app.sourcesMunicipalities', { v0: fmt(state.latest.counts?.sources), v1: fmt(state.latest.counts?.municipalitiesShown ?? state.latest.counts?.municipalities) }) : cl(t('app.collectorNoRunYet'), t('app.noDataYet'));
}
export function renderHeader() {
  $('#crumb-scope').textContent = scopeLabel();
  // Auswahl zeigt den tatsächlich gezeigten Stand samt Uhrzeit
  const sm = $('#sel-mode'); sm.value = state.mode === 'live' && state.live ? 'live' : 'collector';
  sm.options[0].textContent = state.latest ? t('app.collectorSnapshot2', { v0: timeText(state.latest.at) }) : t('app.collectorSnapshotEvery20Min');
  sm.options[1].textContent = state.live ? t('app.liveFetch2', { v0: timeText(state.live.at) }) : t('app.liveFetchInBrowser');
  renderStamp();
  const h = dataHealth();
  const el = $('#filter-count');
  const showAge = h.staleRun && !$('#notice [data-id="stale"]'); // das Hinweisband „Sammler-Lauf alt“ nennt das Alter schon; die Zeile wiederholt es nur ohne Band
  // Veralteter Stand: keine Abdeckungszahlen („0 von 290 nutzbar“ wäre nur das Alter in anderer Form), sondern eine klare Aussage; ab 6 Std. rot
  const lvl = h.staleRun ? (Date.now() - state.latest.at > 6 * 36e5 ? 'bad' : 'warn') : h.level, head = h.staleRun ? t('ux.dataStale') : h.label;
  const age = showAge ? ` · ${t(isClient() ? 'app.dataOld' : 'app.collectorRunOld', { v0: ageText(Date.now() - state.latest.at) })}` : '';
  const counts = !isClient() && !h.staleRun && h.counted ? ` · ${t('app.ofReachableSourcesCurrent', { usable: fmt(h.usable), fresh: fmt(h.fresh), counted: fmt(h.counted) })}` : '';
  el.innerHTML = `<span class="health ${lvl}"><i></i>${head}${counts}${age}</span>`;
  el.title = isClient() ? gl('fresh') : h.detail;
  renderAttribution(); renderFilterSum();
}
// Ampel zur Datenlage im Gebiet: nicht erreichbare Quellen und geprüfte Kandidaten ohne Feed zählen nicht als Fehler; ebenso Dubletten
// (gleiches System über eine zweite Adresse) und länger als 14 Tage verschwundene Quellen (retired)
export const NOT_COUNTED = new Set(['gone', 'foreign', 'duplicate', 'retired']);
export function dataHealth() {
  const recs = sourcesForScope().map(r => liveRec(r.id) || r);
  const eff = recs.map(effStatus);
  const by = {}; for (const e of eff) by[e.status] = (by[e.status] || 0) + 1;
  const counted = eff.filter((e, i) => { const r = recs[i]; return !NOT_COUNTED.has(e.status) && !(r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(e.status)); });
  const fresh = counted.filter(e => e.status === 'live').length, delayed = counted.filter(e => e.status === 'delayed').length, stale = counted.filter(e => e.status === 'stale').length;
  const usable = counted.filter(e => USABLE.has(e.status)).length;
  const staleRun = !DEMO && !!state.latest && !(state.mode === 'live' && state.live) && Date.now() - state.latest.at > 45 * 60e3;
  const ratio = counted.length ? usable / counted.length : 0;
  let level = !counted.length ? 'none' : ratio >= 0.8 ? 'ok' : ratio >= 0.5 ? 'warn' : 'bad';
  if (staleRun && level === 'ok') level = 'warn';
  const label = { ok: t('app.dataCoverageGood'), warn: t('app.dataCoverageLimited'), bad: t('app.dataCoverageWeak'), none: state.latest ? cl(t('app.noSourcesInArea'), t('app.noDataInArea')) : cl(t('app.noCollectorSnapshotYet'), t('app.noDataYet')) }[level];
  const detail = t('app.sourcesInAreaCurrentDataAge', { length: recs.length, v1: Object.entries(by).map(([k, v]) => `${v} ${STATUS[k] || k}`).join(' · '), v2: state.live ? ` · ${t('app.liveDuplicatesRemoved', { duplicates: state.live.dedupe.duplicates })}` : '' });
  return { level, label, fresh, delayed, stale, usable, counted: counted.length, staleRun, detail };
}
// Namensnennung: Anbieter/Attribution und Lizenzen der Quellen im Gebiet (Vertrag 2), Verzeichnisse und BKG – kompakt für Karte und Fußzeile
export const LIC_SHORT = (l) => { if (!l) return null; const s = String(l); const m = s.match(/creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/i); if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`; if (/publicdomain\/zero|CC0/i.test(s)) return 'CC0'; if (/dl-de\/by-2-0|DL-DE.?BY.?2/i.test(s)) return 'dl-de/by-2-0'; if (/odbl/i.test(s)) return 'ODbL'; if (/^https?:/.test(s)) { try { return new URL(s).hostname.replace(/^www\./, ''); } catch { return s; } } return s.length > 24 ? `${s.slice(0, 22)}…` : s; };
export function attributionParts() {
  const recs = sourcesForScope().filter(r => !(r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status)) && !NOT_COUNTED.has(r.status));
  const by = new Map();
  for (const r of recs) { const name = r.attribution || r.operator; if (!name) continue; const e = by.get(name) || { lic: new Set(), n: 0 }; e.n++; const l = LIC_SHORT(r.licenseId || r.license); if (l) e.lic.add(l); by.set(name, e); }
  const names = [...by].sort((a, b) => b[1].n - a[1].n).map(([n, e]) => `${n}${e.lic.size ? ` (${[...e.lic].join(', ')})` : ''}`);
  const dirs = new Set(recs.flatMap(r => r.directories || []));
  const extra = [dirs.has('mobidata_bw') ? 'MobiData BW' : null, dirs.has('mobidrom_nrw') ? 'MOBIDROM NRW' : null, dirs.has('citybikes') ? 'CityBikes' : null, 'BKG (dl-de/by-2-0)'].filter(Boolean);
  return { names, extra };
}
// Fußzeile in allen Ansichten (auch Kundenansicht): Anbieter/Lizenzen der Quellen im Gebiet, Verzeichnisse, BKG VG250, OSM
export function renderAttribution() {
  const { names, extra } = attributionParts();
  const shown = names.slice(0, 8), rest = names.length - shown.length;
  const dirs = extra.filter(x => !/^BKG/.test(x));
  const foot = $('#page-foot');
  if (foot) {
    foot.innerHTML = `<span>${t('app.data', { v0: esc([...shown, rest > 0 ? t('app.more', { rest }) : null].filter(Boolean).join(', ') || t('app.loadingCollectorSnapshot')), v1: dirs.length ? ` · ${t('app.via', { join: esc(dirs.join(', ')) })}` : '', v2: cl(t('app.licencePerSourceUnderData'), t('app.useSubjectToOperators')) })}</span>`
      + `<span>${t('app.municipalBoundariesVg250DlDe', { v0: esc(state.latest?.boundaries?.attribution?.replace(/\s*\(.*\)\s*$/, '') || '© GeoBasis-DE / BKG') })}</span>`
      + `<span>${t('app.mapsOpenstreetmap')}</span>`
      + `<span class="foot-legal">${t('app.legalLinks')}</span>`
      + `<details class="foot-privacy"><summary>${t('app.privacyTitle')}</summary><div class="foot-privacy-body">${t('app.privacyBody', { flowMin: 5, cellMin: 3 })}</div></details>`;
    foot.title = names.join('\n');
  }
  if (state.map?.attributionControl) {
    const short = t('maps.attribData', { src: [...names.slice(0, 4), names.length > 4 ? `+${names.length - 4}` : null, ...extra].filter(Boolean).map(esc).join(', ') });
    if (state.mapAttrib) state.map.attributionControl.removeAttribution(state.mapAttrib);
    state.mapAttrib = short; state.map.attributionControl.addAttribution(short);
  }
}
export function tile(l, v, s, cls = '', title = '') { return `<div class="tile ${cls}"${title ? ` title="${esc(title)}"` : ''}><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
// Kernaussage über den Kacheln der Übersicht
export function renderLede() {
  const el = $('#live-lede'); if (!el) return;
  if (!state.latest && !state.live) { el.textContent = t('app.noDataSnapshotLoadedYet'); return; }
  const st = sumStats([...scopeGroups().values()]); const h = dataHealth();
  const sig = computeSignals().filter(s => s.sev !== 'info').length;
  const place = state.scope === 'DE' ? t('app.germany') : muniName(state.scope);
  const filt = [state.operator !== 'all' ? state.operator : null, state.type !== 'all' ? TYPE[state.type] : null].filter(Boolean).join(', ');
  const dataTxt = h.level === 'ok' ? t('app.dataCurrent') : h.staleRun ? t('app.old', { v0: cl(t('app.collectorSnapshot'), t('app.data2')), v1: ageText(Date.now() - state.latest.at) }) : h.level === 'warn' ? t('app.dataPartlyDelayed') : h.level === 'bad' ? t('app.dataIncomplete') : cl(t('app.noSources'), t('app.noData2'));
  const sigTxt = `${fmt(sig)} ${sig === 1 ? t('app.anomaly') : t('app.anomalies')}`;
  el.innerHTML = `${t('app.vehiclesAvailable', { place: esc(place), v1: filt ? ` · ${esc(filt)}` : '', available: fmt(st.available), v3: st.total ? t('app.disabled', { disabled: pctf(st.disabled, st.total) }) : t('app.noVehicleData'), v4: isClient() ? sigTxt : `<a href="#signals">${sigTxt}</a>` })} · <span class="health ${h.level}" title="${esc(isClient() ? gl('fresh') : h.detail)}"><i></i>${dataTxt}</span>`;
}
export const dirLabel = (d) => esc(DIRS[d] || d);
export const pillStatus = (s) => `<span class="pill ${esc(s)}">${esc(STATUS[s] || s)}</span>`;
export function renderLive() {
  const groups = scopeGroups(); const st = sumStats([...groups.values()]);
  const rows = operatorRows();
  const recs = sourcesForScope().map(r => liveRec(r.id) || r);
  const eff = recs.map(effStatus);
  const usable = eff.filter(e => USABLE.has(e.status));
  const gaps = rows.filter(r => r.gap).length;
  const en = energyFor(), lowE = !en.pending && en.known ? en.low / en.known : null;
  const dockKnown = st.stationsEmptyDock != null;
  $('#live-tiles').innerHTML = [
    tile(t('app.availableBookable'), fmt(st.available), t('app.reportedReserved', { total: fmt(st.total), reserved: fmt(st.reserved) })),
    tile(t('app.disabled2'), fmt(st.disabled), `${st.total ? t('app.ofFleet', { disabled: pctf(st.disabled, st.total) }) : t('app.noVehicleData')}${ghostsInScope() ? ` · ${t('app.orphaned', { ghostsInScope: fmt(ghostsInScope()) })}` : ''}`, st.total && st.disabled / st.total > 0.15 ? 'warn' : ''),
    tile(t('app.stationsWithVehicles'), `${fmt(st.stationsRenting - st.stationsEmpty)} <small>/ ${fmt(st.stations)}</small>`, st.stations ? t('app.emptyFull', { stationsEmpty: fmt(st.stationsEmpty), v1: dockKnown ? ` ${t('app.docksZonesParen', { docks: fmt(st.stationsEmptyDock), zones: fmt(st.stationsEmptyVirtual) })}` : '', stationsFull: fmt(st.stationsFull) }) : t('app.noStationsInArea'), '', st.stations ? emptyTip(st) : ''),
    tile(t('app.lowEnergy'), energyVal(en), energySub(en), lowE > 0.3 ? 'warn' : ''),
    // ein Nenner mit der Kopfzeile (dataHealth: ohne Dubletten, verschwundene, Ausland), Farbe aus derselben Ampel (Audit UXM-08/DES-11)
    (() => { const hh = dataHealth(), notCounted = recs.length - hh.counted;
      return tile(cl(t('app.sources2'), t('app.dataFreshness')), `${fmt(hh.usable)} <small>/ ${fmt(hh.counted)}</small>`, t('app.currentDelayedStale', { length: hh.fresh, length2: hh.delayed, length3: hh.stale, v3: (gaps ? ` · ${gaps} ${cl(gaps > 1 ? t('app.dataGaps') : t('app.dataGap'), t('app.operatorsWithoutData'))}` : '') + (notCounted > 0 && !isClient() ? ` · ${t('app.sourcesNotCounted', { all: fmt(recs.length), n: fmt(notCounted) })}` : '') }), hh.level === 'bad' ? 'bad' : hh.level === 'warn' ? 'warn' : '', gl('fresh')); })(),
  ].join('');
  // Tabelle: „Δ Sammler“ nur, wenn es etwas zeigt (Live-Abruf mit Abweichung); Lizenzen stehen unter Datenvertrauen › Quellen
  const showDelta = rows.some(r => r.delta && r.delta.diff !== 0);
  const tbl = $('#tbl-operators'); tbl.classList.toggle('no-delta', !showDelta);
  $$('th', tbl).forEach((th, i) => { if (i === 4) th.hidden = !showDelta; });
  const cols = 9 - (showDelta ? 0 : 1);
  $('#tbl-operators tbody').innerHTML = rows.map(r => {
    const s = r.st;
    const d = r.delta ? `<span style="color:var(--${r.delta.diff > 0 ? 'ok' : r.delta.diff < 0 ? 'bad' : 'muted'})">${r.delta.diff > 0 ? '+' : ''}${fmt(r.delta.diff)}</span><div class="sub-line">${ageText(r.delta.sinceMs)}</div>` : '—';
    if (r.gap) return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line">${t('app.since', { city: esc(r.gap.city), since: esc(r.gap.since) })}</div></td><td colspan="${cols - 2}" class="sub-line">${esc(r.gap.note)}</td><td><span class="pill gap">${t('app.dataGap2')}</span></td></tr>`;
    const e = energyOfOp(r.op);
    const eCell = e.pending ? '…' : !e.known ? t('common.na') : `${energyVal(e)}<div class="sub-line">${t('app.withData', { known: fmt(e.known), v1: e.rangeOnly === e.known ? ` · ${t('app.rangeOnly')}` : e.rangeOnly ? ` · ${t('app.rangeOnly2', { rangeOnly: fmt(e.rangeOnly) })}` : '' })}</div>`;
    return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line internal">${r.sources.length} ${r.sources.length === 1 ? t('app.source') : t('app.sources')}${r.changed ? ` · ${t('app.sourceChange')}` : ''}${r.sources.some(x => x.snapshot) ? ` · ${t('app.collectorSnapshot3')}` : ''}${r.sources.some(x => x.status === 'collector') ? ` · ${t('app.collectorSnapshot')}` : ''}</div></td>
      <td class="internal">${r.dirs.map(dirLabel).join(' · ') || '–'}<div class="sub-line">${t('app.quality100', { v0: esc(r.quality ?? '–') })}</div></td>
      <td class="n">${fmt(s.available)}<div class="sub-line">${t('app.reported', { total: fmt(s.total) })}</div></td><td class="n">${fmt(s.disabled)}</td>${showDelta ? `<td class="n">${d}</td>` : ''}
      <td class="n">${eCell}</td>
      <td class="n"${s.stations ? ` title="${esc(emptyTip(s))}"` : ''}>${s.stations ? `${fmt(s.stationsEmpty)} / ${fmt(s.stations)}` : '—'}</td><td class="n">${ageText(r.age)}</td>
      <td>${isClient() && r.status === 'collector' ? `<span class="pill live">${t('app.asOf2')}</span>` : pillStatus(r.status)}</td></tr>`;
  }).join('') || emptyRow(cols, t('app.noOperatorsInSelectedFilter'), state.operator !== 'all' || state.type !== 'all' ? t('app.setOperatorAndVehicleTypeTo') : state.scope === 'DE' ? (state.latest ? cl(t('app.noDataInCollectorSnapshot'), t('app.noData3')) : failedText('latest.json')) : cl(t('app.chooseAnotherAreaOrFetchLive'), t('app.chooseAnotherArea')));
  renderBriefing(rows, st);
  renderLede();
  renderMap();
}
// Verwaiste Einträge (gesperrt, > 7 Tage ohne Signal) der Quellen im Gebiet/Anbieter-Filter
export function ghostsInScope() { return sourcesForScope().filter(r => state.operator === 'all' || r.operator === state.operator).reduce((a, r) => a + (r.counts?.ghosts || 0), 0); }
// Briefing: je Karte Zahl + eine Zeile, Begründung unter „Warum?“
// Handlungsbedarf zuerst: kritisch/auffällig; Hinweise füllen nur auf, wenn weniger als vier übrig sind. Kundenansicht ohne Datenqualität (interne Quellenlage).
export function renderBriefing() {
  const all = computeSignals().filter(s => !(isClient() && s.cat === 'data'));
  const act = all.filter(s => s.sev !== 'info');
  const items = [...act, ...all.filter(s => s.sev === 'info')].slice(0, 4);
  $('#briefing').innerHTML = items.length ? items.map(s => sigCard(s, true)).join('') : `<div class="empty">${t('app.noNotableSignalsInAreaFleet')}</div>`;
}
