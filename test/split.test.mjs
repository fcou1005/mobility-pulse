// S3.8 Daten nach Gebiet (lib/pulse-split.js): die kleinen Dateien müssen dieselben Ergebnisse liefern wie die großen.
// Grundlage: Fixture (test/fixtures/web-data) und der Datenzweig, falls MP_DATA gesetzt ist (z. B. MP_DATA=/home/claude/mp-data).
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { eventsByState, hourTotals, totalsDoc, groupDaySums, dailySummary, opsSlice, cellsSlice, SUMMARY_FIELDS, cellsCompact, cellsExpand, flowsSlice, econSlice, econCalib, groupsSlice, zonesSlice, zoneCover, featureBoxes, latestCore, pickUsageDay, usageDayCandidates, CORE_SOURCE_FIELDS } from '../lib/pulse-split.js';
import { planFor } from '../lib/pulse-econ.js';
import { hourQuality, histFromDaily } from '../lib/pulse-report.js';
import { dayOf } from '../lib/pulse-track.js';
import { attachFlows, groupPlaces, zoneConstraints, parkingViolations } from '../lib/pulse-ops.js';
import { existsSync } from 'node:fs';
import { hourProfile, DAY_TYPES } from '../lib/pulse-econ.js';
import { decodeFleet, buildDemandModel, BANDS } from '../lib/pulse-ops.js';
import { haversineM } from '../lib/pulse-core.js';

let ok = 0, bad = 0;
const check = (c, m) => { if (c) { ok++; console.log(`ok: ${m}`); } else { bad++; console.log(`FEHLER ${m}`); } };
const rep = (_k, v) => (v instanceof Map ? { Map: [...v] } : v instanceof Set ? { Set: [...v] } : v);
const same = (a, b) => JSON.stringify(a, rep) === JSON.stringify(b, rep);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DIRS = [path.join(ROOT, 'test/fixtures/web-data'), ...(process.env.MP_DATA ? [process.env.MP_DATA] : [])];
const rd = async (f) => JSON.parse(await readFile(f, 'utf8'));

for (const DIR of DIRS) {
  const tag = path.basename(DIR);
  const latest = await rd(path.join(DIR, 'latest.json'));
  const stateOf = (ags) => latest.municipalities?.[ags]?.state;
  const days = (await readdir(path.join(DIR, 'events'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map(f => f.slice(0, 10));
  const docs = await Promise.all(days.map(d => rd(path.join(DIR, 'events', `${d}.json`))));
  check(docs.length >= 2, `${tag}: ${docs.length} Ereignistage`);

  // Ereignisse je Land: alle Gruppen genau einmal, Kopf unverändert
  for (const doc of docs) {
    const parts = eventsByState(doc, stateOf);
    const keys = [...parts.values()].flatMap(p => Object.keys(p.groups)).sort();
    check(same(keys, Object.keys(doc.groups).sort()), `${tag} ${doc.day}: ${parts.size} Länder, jede Gruppe genau einmal`);
    const p0 = [...parts.values()][0], { groups: _g, state: _s, ...h0 } = p0, { groups: _G, ...H } = doc;
    check(same(h0, H), `${tag} ${doc.day}: Kopf (runs, hourMin, published …) gleich`);
    check([...parts].every(([st, p]) => Object.keys(p.groups).every(k => (stateOf(k.split('|')[0]) || 'XX') === st)), `${tag} ${doc.day}: Gruppen im richtigen Land`);
  }

  // Tagesgang-Profil aus hour-totals = aus den vollen Dateien (für jeden Tagtyp und ohne)
  const tot = docs.map(d => totalsDoc(d.day, JSON.parse(JSON.stringify(hourTotals(d))))); // über JSON wie aus der Datei
  for (const ty of [null, ...DAY_TYPES]) for (const land of [null, 'BW']) {
    const a = hourProfile(docs, { minDays: 1, dayType: ty, land }), b = hourProfile(tot, { minDays: 1, dayType: ty, land });
    check(same(a, b), `${tag}: Profil ${ty || 'alle'} ${land || 'DE'} gleich (${a.source})`);
  }

  // Tagessummen
  const byDay = Object.fromEntries(docs.map(d => [d.day, groupDaySums(d)]));
  const sum = dailySummary(byDay);
  check(same(sum.days, days) && same(sum.fields, SUMMARY_FIELDS), `${tag}: Tagessummen über ${sum.days.length} Tage`);
  const k0 = Object.keys(docs.at(-1).groups)[0], g0 = docs.at(-1).groups[k0];
  check(Math.abs(sum.groups[k0].at(-1)[0] - g0.start.reduce((a, x) => a + (x || 0), 0)) < 0.01, `${tag}: Σ start der Gruppe ${k0}`);

  // Disposition: Bestand und Zellen einer Gemeinde
  const opsFiles = (await readdir(path.join(DIR, 'ops'))).filter(f => /^[A-Z]{2}\.json$/.test(f));
  const ops = await rd(path.join(DIR, 'ops', opsFiles.includes('BW.json') ? 'BW.json' : opsFiles[0]));
  const full = decodeFleet(ops);
  const counts = {}; for (const v of full.vehicles) counts[v.ags] = (counts[v.ags] || 0) + 1;
  const ags = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const sl = opsSlice(ops, ags), part = decodeFleet(JSON.parse(JSON.stringify(sl)));
  check(same(part.vehicles, full.vehicles.filter(v => v.ags === ags)) && part.vehicles.length === counts[ags], `${tag}: Bestand ${ags} (${counts[ags]} Fahrzeuge) gleich`);
  check(same(part.stations, full.stations.filter(s => s.ags === ags)), `${tag}: Stationen ${ags} gleich (${part.stations.length})`);
  check(opsSlice(ops, '99999999') === null, `${tag}: unbekannte Gemeinde → null`);
  // mit Rahmen: alle Stationen bis 1 km um ein Fahrzeug der Gemeinde sind dabei (Einsammelliste sucht so weit, COLLECT.stationSearchM)
  {
    const lat = full.vehicles.filter(v => v.ags === ags).map(v => v.lat), lon = full.vehicles.filter(v => v.ags === ags).map(v => v.lon);
    const bbox = [Math.min(...lon), Math.min(...lat), Math.max(...lon), Math.max(...lat)];
    const raw = JSON.parse(JSON.stringify(opsSlice(ops, ags, { bbox }))), wide = decodeFleet(raw);
    const key = (s) => `${s.lat},${s.lon},${s.operator},${s.name}`, have = new Set(wide.stations.map(key));
    const inMuni = full.vehicles.filter(v => v.ags === ags), near = full.stations.filter(s => inMuni.some(v => Math.abs(v.lat - s.lat) < 0.009 && Math.abs(v.lon - s.lon) < 0.0135 && haversineM(v.lat, v.lon, s.lat, s.lon) <= 1000));
    check(near.every(s => have.has(key(s))) && same(wide.vehicles, part.vehicles) && raw.ops.length <= ops.ops.length && raw.munis.length <= ops.munis.length, `${tag}: mit Rahmen ${wide.stations.length} Stationen, alle ${near.length} Stationen bis 1 km um Fahrzeuge dabei, Listen gekürzt (${raw.ops.length}/${ops.ops.length} Anbieter, ${raw.munis.length}/${ops.munis.length} Gemeinden)`);
  }
  const st = ops.state, cdays = (await readdir(path.join(DIR, 'cells'))).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-14);
  const cdocs = (await Promise.all(cdays.map(d => rd(path.join(DIR, 'cells', d, `${st}.json`)).catch(() => null)))).filter(Boolean);
  const cs = JSON.parse(JSON.stringify(cellsSlice(cdocs, ags)));
  // Tag ohne Zellen der Gemeinde: bleibt mit leeren Zellen drin (Beobachtungsstunden zählen wie aus den Landesdateien)
  if (cdocs.length >= 2) {
    const gap = cdocs.map((d, i) => (i === 0 ? { ...d, munis: Object.fromEntries(Object.entries(d.munis).filter(([a]) => a !== ags)) } : d));
    const gs = JSON.parse(JSON.stringify(cellsSlice(gap, ags)));
    check(gs.length === gap.length && !Object.keys(gs[0].munis).length && same(buildDemandModel(gs, ags, 'day'), buildDemandModel(gap, ags, 'day')), `${tag}: Tag ohne Zellen der Gemeinde zählt mit (Modell gleich)`);
  }
  for (const band of /** @type {any[]} */ (['day', ...BANDS.map(b => b.id)])) { const m1 = buildDemandModel(cs, ags, band), m0 = buildDemandModel(cdocs, ags, band); check(same(m1, m0) && (band !== 'day' || m0.cells.size > 0), `${tag}: Nachfragemodell ${ags} Band ${band} gleich (${m0.cells.size} Zellen, ${m0.hours?.toFixed?.(1)} h)`); }

  // ---------- S3.8 Rest ----------
  // Zellen spaltenweise: gleiche Schlüssel in gleicher Reihenfolge, gleiches Modell je Band, kleiner
  const cx = cellsExpand(JSON.parse(JSON.stringify(cellsCompact(cs, ags))));
  check(cx.every((d, i) => same(Object.keys(d.munis[ags] || {}), Object.keys(cs[i].munis[ags] || {}))), `${tag}: Zellen spaltenweise – Schlüssel und Reihenfolge gleich`);
  check(/** @type {any[]} */ (['day', ...BANDS.map(b => b.id)]).every(band => same(buildDemandModel(cx, ags, band), buildDemandModel(cs, ags, band))), `${tag}: Zellen spaltenweise – Nachfragemodell in allen Bändern gleich`);
  check(JSON.stringify(cellsCompact(cs, ags)).length < JSON.stringify(cs).length, `${tag}: spaltenweise ${(JSON.stringify(cellsCompact(cs, ags)).length / 1e3).toFixed(0)} statt ${(JSON.stringify(cs).length / 1e3).toFixed(0)} KB roh`);
  // Ströme der Gemeinde: attachFlows gleich
  const flIdx = existsSync(path.join(DIR, 'flows', 'index.json')) ? await rd(path.join(DIR, 'flows', 'index.json')) : null;
  const flDocs = await Promise.all((flIdx?.days || []).filter(d => cdays.includes(d)).map(d => rd(path.join(DIR, 'flows', `${d}.json`)).catch(() => null)));
  if (flDocs.filter(Boolean).length) {
    const mA = attachFlows(buildDemandModel(cs, ags, 'day'), flDocs.filter(Boolean)), mB = attachFlows(buildDemandModel(cs, ags, 'day'), JSON.parse(JSON.stringify(flowsSlice(flDocs.filter(Boolean), ags))));
    check(same(mA, mB), `${tag}: Ströme der Gemeinde – attachFlows gleich (${mA.flow?.trips ?? 0} Fahrten)`);
  }
  // Umsatz-Eingabe: Vorauswahl-Tag wie im Browser, Gruppen, Tageswerte, Tarife und Kalibrierung der Gemeinde gleich
  {
    const idx = await rd(path.join(DIR, 'events', 'index.json')), ht = await rd(path.join(DIR, 'events', 'hour-totals.json'));
    const runDay = dayOf(latest.at) === idx.days.at(-1) ? idx.days.at(-1) : null;
    const viaTotals = pickUsageDay(idx.days, runDay, (d) => ht.days?.[d] || null, (doc) => hourQuality(doc.runs, doc.gapHours).full);
    let viaDocs = null; for (const d of usageDayCandidates(idx.days, runDay)) { const p = path.join(DIR, 'events', `${d}.json`); const doc = existsSync(p) ? await rd(p) : null; if (doc && hourQuality(doc.runs, doc.gapHours).full) { viaDocs = d; break; } }
    viaDocs ??= usageDayCandidates(idx.days, runDay)[0] || idx.days.at(-1);
    check(viaTotals === viaDocs, `${tag}: Vorauswahl-Tag aus hour-totals = aus den Tagesdateien (${viaTotals})`);
    const day = viaTotals, full = await rd(path.join(DIR, 'events', `${day}.json`));
    const [daily, pricing, calib] = await Promise.all(['history/daily.json', 'pricing.json', 'calib.json'].map(f => rd(path.join(DIR, f)).catch(() => null)));
    const stDoc = eventsByState(full, stateOf).get(stateOf(ags)) || null;
    const es = calib ? JSON.parse(JSON.stringify(econSlice({ ags, day, doc: stDoc, daily, pricing, calib, latestGroups: latest.groups }))) : null;
    if (es) {
      const keys = Object.keys(full.groups).filter(k => k.startsWith(`${ags}|`));
      check(same(Object.keys(es.events.groups), keys) && keys.every(k => same(es.events.groups[k], full.groups[k])) && same(es.events.runs, full.runs) && same(es.events.hourMin, full.hourMin), `${tag}: Umsatz-Eingabe ${ags}: ${keys.length} Gruppen und Kopf gleich`);
      const h0 = histFromDaily(daily, day), h1 = histFromDaily(es.daily, day);
      check(!h0 || keys.every(k => same(h0.series[k], h1?.series?.[k])), `${tag}: Tageswerte der Gruppen gleich`);
      const L = Object.keys(calib.langs || {});
      check(L.length > 0 && L.every(l => keys.every(k => { const [, op, ty] = k.split('|'); return same(es.plans[l][`${op}|${ty}`], planFor(pricing, op, ags, ty, calib.langs[l]?.assume?.[ty] || undefined)); })), `${tag}: Tarife je Anbieter|Art vorab gleich planFor (${L.join(', ')})`);
      const sh = econCalib(calib);
      check(L.every(l => same(sh.langs[l].assume, calib.langs[l].assume) && same(sh.langs[l].k, calib.langs[l].k) && same(sh.langs[l].limits, calib.langs[l].limits)) && keys.every(k => es.calib.kinds[k] === calib.kinds?.[k]), `${tag}: Kalibrierung (assume, k, limits, kinds) gleich`);
      check(keys.every(k => same(es.latestGroups[k], latest.groups[k])), `${tag}: Ersatz-Bestand aus latest.groups gleich`);
    } else check(!calib, `${tag}: Umsatz-Eingabe ohne Kalibrierung null`);
  }
  // Gruppen-Ereignisse der Gemeinde: groupPlaces gleich
  {
    const gi = existsSync(path.join(DIR, 'groups', 'index.json')) ? await rd(path.join(DIR, 'groups', 'index.json')) : null;
    if (gi?.months?.length) {
      const docs = await Promise.all(gi.months.map(m => rd(path.join(DIR, 'groups', `${m}.json`))));
      const gs = JSON.parse(JSON.stringify(groupsSlice(docs, gi.months, ags)));
      check(same(groupPlaces([{ fields: gs.fields, events: gs.events }], { ags }), groupPlaces(docs, { ags })), `${tag}: Gruppen-Ereignisse ${ags} (${gs.events.length}) – groupPlaces gleich`);
    }
  }
  // latest-core.json: Quellen nur mit den Kernfeldern, sonst gleich
  {
    const core = latestCore(latest), { sources: _a, groups: _b, lite: _c, ...rest } = core, { sources: _d, groups: _e, ...rest0 } = latest;
    check(same(rest, rest0) && core.sources.length === latest.sources.length && core.sources.every((r, i) => Object.keys(r).every(k => CORE_SOURCE_FIELDS.includes(k) && same(r[k], latest.sources[i][k]))) && !Object.keys(core.groups).length, `${tag}: latest-core.json – ${core.sources.length} Quellen mit ${CORE_SOURCE_FIELDS.length} Feldern, ${(JSON.stringify(core).length / 1e3).toFixed(0)} statt ${(JSON.stringify(latest).length / 1e3).toFixed(0)} KB`);
  }
  // Zonen-Ausschnitt (nur Datenzweig; das Fixture hat keine Betreiber-Geometrien): Abstellverbote im Rahmen ± 0,02° und Einsammelliste gleich
  {
    const zi = existsSync(path.join(DIR, 'zones', 'index.json')) ? await rd(path.join(DIR, 'zones', 'index.json')) : null;
    const bIdx = existsSync(path.join(DIR, 'boundaries', 'index.json')) ? await rd(path.join(DIR, 'boundaries', 'index.json')) : null;
    const bdoc = bIdx?.states?.[stateOf(ags)] ? await rd(path.join(DIR, 'boundaries', `${stateOf(ags)}.json`)) : null, bbox = bdoc?.features?.find(f => f.properties?.ags === ags)?.bbox;
    const list = (zi?.zones || []).filter(z => (z.municipalities || []).includes(ags));
    if (list.length && bbox) {
      const cover = zoneCover(bbox), req = [bbox[0] - 0.02, bbox[1] - 0.02, bbox[2] + 0.02, bbox[3] + 0.02];
      const ovl = (g, b) => { const c = JSON.stringify(g.coordinates).match(/-?\d+\.\d+/g) || []; let x0 = 999, x1 = -999, y0 = 999, y1 = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return !(x1 < b[0] || x0 > b[2] || y1 < b[1] || y0 > b[3]); };
      let nOk = 0, nAll = 0;
      for (const z of list) {
        const d = await rd(path.join(DIR, 'zones', z.file)), sl = zonesSlice(d, cover, { boxes: featureBoxes(d), maxShare: 1.01 }); nAll++;
        const a = zoneConstraints(d), b = zoneConstraints(JSON.parse(JSON.stringify(sl)));
        const pick = (c) => ({ noPark: c.noPark.filter(g => ovl(g, req)), mandatory: c.mandatory.filter(g => ovl(g, req)) });
        const vs = part.vehicles.filter(v => v.operator === z.operator);
        if (same(pick(a), pick(b)) && same(parkingViolations({ vehicles: vs, stations: part.stations }, [d], { operator: z.operator }), parkingViolations({ vehicles: vs, stations: part.stations }, [sl], { operator: z.operator }))) nOk++;
      }
      check(nOk === nAll, `${tag}: Zonen-Ausschnitt ${ags}: ${nOk}/${nAll} Dateien – Abstellverbote und Einsammelliste gleich`);
    }
  }
}

// S6.3: Zellen mit Angebotsfeldern (28 Werte) spaltenweise und zurück, alte (22) unverändert
{
  const row28 = (k) => Array.from({ length: 28 }, (_, j) => (j === 1 || j === 2 ? 7 : j * 10 + k)), row22 = (k) => row28(k).slice(0, 22);
  const d28 = [{ day: '2026-11-14', bandMin: [1, 1, 1, 1, 1, 1], munis: { '08111000': { '1:2': row28(1), '3:5': row28(2) } } }];
  const c28 = cellsCompact(d28, '08111000'), x28 = cellsExpand(JSON.parse(JSON.stringify(c28)));
  check(c28[0].cols?.n === 28 && same(x28[0].munis['08111000']['3:5'].slice(22), row28(2).slice(22)) && x28[0].munis['08111000']['1:2'][1] === null, 'S6.3: 28 Werte spaltenweise (cols.n), Angebotsfelder unverändert zurück');
  const c22 = cellsCompact([{ ...d28[0], munis: { '08111000': { '1:2': row22(1) } } }], '08111000');
  check(c22[0].cols && c22[0].cols.n === undefined && cellsExpand(c22)[0].munis['08111000']['1:2'].length === 22, 'S6.3: 22 Werte wie bisher (ohne cols.n)');
  const mix = cellsCompact([{ ...d28[0], munis: { '08111000': { '1:2': row22(1), '3:5': row28(2) } } }], '08111000');
  check(!mix[0].cols && mix[0].munis['08111000']['3:5'].length === 28, 'S6.3: gemischte Längen bleiben unverändert');
}
console.log(`${bad ? '✗' : '✓'} split: ${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad ? 1 : 0);
