// Tests für lib/pulse-report.js: Lücken, Beobachtung je Stunde, Wochen-Heatmap, Kommunal-Bericht, Obergrenzen, CSV, Preis-Log, Feed-Prüfung
import * as R from '../lib/pulse-report.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const near = (a, b, eps = 1e-6) => a != null && Math.abs(a - b) <= eps;
const T = (s) => Date.parse(`${s}+01:00`); // Ortszeit Winter (MEZ)
const MIN = 60e3;
const h24 = (pairs) => { const a = new Array(24).fill(0); for (const [h, v] of Object.entries(pairs)) a[+h] = v; return a; };

// ---------- Lücken und Beobachtung ----------
assert(R.isGapRun([T('2026-11-02T10:00:00'), 20 * MIN, 0]) && R.isGapRun([T('2026-11-02T10:00:00'), 50 * MIN]) && !R.isGapRun([T('2026-11-02T10:00:00'), 20 * MIN, 1]) && !R.isGapRun([T('2026-11-02T10:00:00'), null]),
  'Lücken-Lauf: Flag 0 oder Abstand > 45 Min.; erster Lauf (ohne Fenster) ist keine Lücke');
assert(R.isTaintedRun([0, 456 * MIN, 1]) && !R.isTaintedRun([0, 456 * MIN, 0]), 'Lücke mit Flag 1 (ältere Datei) = Ereignisse mitgezählt → Stunde verwerfen');
{
  const runs = [[T('2026-11-02T09:50:00'), null], [T('2026-11-02T10:10:00'), 20 * MIN, 1], [T('2026-11-02T10:30:00'), 20 * MIN, 1], [T('2026-11-02T10:50:00'), 20 * MIN, 1], [T('2026-11-02T12:40:00'), 110 * MIN, 1], [T('2026-11-02T12:55:00'), 15 * MIN, 1]];
  const hq = R.hourQuality(runs);
  assert(hq.obs[10] === 60 && hq.ok[10] && hq.obs[9] === 0 && !hq.ok[9], 'Stunde 10: drei Läufe à 20 Min. = 60 Min.; erster Lauf zählt kein Fenster');
  assert(hq.gap[12] && !hq.ok[12] && hq.obsOk[12] === 0 && hq.gaps.length === 1 && hq.gaps[0].tainted, 'Stunde 12 mit Lücken-Lauf (110 Min.) fällt ganz heraus, auch der saubere Lauf daneben');
  assert(hq.counted === 4 && hq.obsMin === 60 && !hq.full && hq.excludedHours === 1, 'gezählte Läufe 4, beobachtet 60 Min., kein voller Tag, 1 Stunde ausgeschlossen');
}
{
  const hq = R.hourQuality([[T('2026-11-02T10:10:00'), 20 * MIN, 1], [T('2026-11-02T11:10:00'), 20 * MIN, 0], [T('2026-11-02T13:10:00'), 20 * MIN, 1]], [13]);
  assert(hq.gap[11] && !hq.gaps[0].tainted && hq.gap[13] && !hq.ok[13] && hq.ok[10], 'Flag 0 ohne lange Pause (Lauf ohne Zählung) und gapHours der Tagesdatei sperren die Stunde');
}
assert(R.weekdayOf('2026-11-01') === 6 && R.weekdayOf('2026-11-02') === 0 && R.weekdayOf('2026-10-31') === 5, 'Wochentag: 01.11.2026 Sonntag, 02.11.2026 Montag');
{
  const k = R.keyFilter({ ags: '08111000', operator: 'Voi', type: 'scooter' });
  const de = R.keyFilter({ ags: 'DE' });
  assert(k('08111000|Voi|scooter') && !k('08111000|Bolt|scooter') && !k('08111000|Voi|bike') && de('11000000|Dott|scooter') && !de('DE||scooter'), 'Schlüsselfilter Gemeinde|Anbieter|Art; DE ohne Bundessummen');
}

// ---------- Wochen-Heatmap ----------
// zwei Montage: 10 Uhr voll gemessen (6 und 10 Starts → Ø 8); 11 Uhr nur 20 Min. (zu dünn); 12 Uhr am zweiten Montag mit Lücken-Lauf
const fullHourRuns = (day, h) => [0, 20, 40].map(m => [T(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`), 20 * MIN, 1]);
const docA = { day: '2026-11-02', runs: [[T('2026-11-02T09:55:00'), null], ...fullHourRuns('2026-11-02', 10), [T('2026-11-02T11:20:00'), 20 * MIN, 1], ...fullHourRuns('2026-11-02', 12)],
  groups: { '08111000|Voi|scooter': { start: h24({ 10: 4, 11: 3, 12: 5 }) }, '08111000|Bolt|scooter': { start: h24({ 10: 2 }) }, '11000000|Dott|scooter': { start: h24({ 10: 100 }) } } };
const docB = { day: '2026-11-09', runs: [...fullHourRuns('2026-11-09', 10), [T('2026-11-09T12:10:00'), 60 * MIN, 1], [T('2026-11-09T12:30:00'), 20 * MIN, 1]],
  groups: { '08111000|Voi|scooter': { start: h24({ 10: 10, 12: 50 }) } } };
const docSun = { day: '2026-11-08', runs: [...fullHourRuns('2026-11-08', 15).map(r => [r[0], 15 * MIN, 1])], groups: { '08111000|Voi|scooter': { start: h24({ 15: 9 }) } } };
{
  const hm = R.weekHeatmap([docA, docB, docSun], R.keyFilter({ ags: '08111000' }));
  const mo = hm.cells[0];
  assert(hm.days[0] === 2 && hm.days[6] === 1 && hm.days[2] === 0, 'Tage je Wochentag: 2 Montage, 1 Sonntag, kein Mittwoch');
  assert(near(mo[10].mean, 8) && mo[10].n === 2, 'Montag 10 Uhr: Mittel (6 + 10) / 2 = 8, andere Gemeinde nicht mitgezählt');
  assert(mo[11].mean == null && mo[11].thinDays === 1, 'Montag 11 Uhr: nur 20 Min. beobachtet → nicht gemessen');
  assert(near(mo[12].mean, 5) && mo[12].n === 1 && mo[12].gapDays === 1, 'Montag 12 Uhr: Tag mit Lücken-Lauf fällt heraus, der andere zählt (5)');
  assert(near(hm.cells[6][15].mean, 9 * 60 / 45), 'Sonntag 15 Uhr: 45 Min. beobachtet → auf 60 Min. bezogen (12)');
  assert(hm.cells[2][10].mean == null && near(hm.max, 12), 'Mittwoch ohne Tagesdatei bleibt leer; Maximum 12');
}

// ---------- Kommunal-Bericht ----------
{
  const vt = (h, n, min = 60) => h24({ [h]: n * min });
  const g = (o) => ({ start: h24({}), end: h24({}), reloc: h24({}), vmin: h24({}), vminTot: h24({}), tripDurSum: 0, tripDurN: 0, tripDistSum: 0, tripDistN: 0, ...o });
  // Tag 1: Stunde 10 voll (60 Min., Flotte 100), Stunde 12 mit Lücken-Lauf (Ereignisse dort zählen nicht)
  const d1 = { day: '2026-11-02', runs: [[T('2026-11-02T09:55:00'), null], ...fullHourRuns('2026-11-02', 10), [T('2026-11-02T12:20:00'), 200 * MIN, 1]],
    groups: {
      '08111000|Voi|scooter': g({ start: h24({ 10: 30, 12: 500 }), end: h24({ 10: 28 }), vminTot: vt(10, 100), tripDurSum: 25 * 10 * MIN, tripDurN: 25, tripDistSum: 25 * 1500, tripDistN: 25 }),
      '08111000|Lime|scooter': g({ start: h24({ 10: 3000 }), vminTot: vt(10, 50) }), // unplausibel: 3000 Fahrten auf 50 Fahrzeuge
      '08111000|Voi|bike': g({ start: h24({ 10: 4 }), vminTot: vt(10, 20) }),
    } };
  // Tag 2: Stunde 10 voll, Fahrzeugminuten nicht gezählt (alte Datei ohne Flag) → Flotte aus dem Verlauf
  const d2 = { day: '2026-11-03', runs: [[T('2026-11-03T09:55:00'), null], ...fullHourRuns('2026-11-03', 10).map(r => [r[0], r[1]])],
    groups: { '08111000|Voi|scooter': g({ start: h24({ 10: 10 }), tripDurSum: 5 * 10 * MIN, tripDurN: 5, tripDistSum: 0, tripDistN: 0 }) } };
  const hists = {
    '2026-11-02': { t: [1, 2], f: [1, 1], series: { '08111000|Voi|scooter': { total: [100, 100], disabled: [10, 10], available: [90, 90] } } },
    '2026-11-03': { t: [1, 2, 3], f: [1, 0, 1], series: { '08111000|Voi|scooter': { total: [120, 999, 140], disabled: [12, 999, 14], available: [108, 0, 126] }, '08111000|Bolt|scooter': { total: [40, 40, 40], disabled: [0, 0, 0] } } },
  };
  const rep = R.municipalReport({ docs: [d2, d1], hists, ags: '08111000', pop: 600000, type: 'scooter' });
  const voi = rep.groups.find(x => x.op === 'Voi'), lime = rep.groups.find(x => x.op === 'Lime'), bolt = rep.groups.find(x => x.op === 'Bolt');
  assert(rep.from === '2026-11-02' && rep.to === '2026-11-03' && rep.days.length === 2 && !rep.groups.some(x => x.ty === 'bike'), 'Zeitraum sortiert; Filter Fahrzeugart wirkt');
  assert(voi.rides === 40 && rep.daily[0].rides === 3030, 'Fahrten nur aus Stunden ohne Lücken-Lauf (500 in Stunde 12 verworfen)');
  assert(near(voi.fleetDays[0].fleet, 100) && near(voi.fleetDays[1].fleet, 130) && near(voi.fleet, 115) && voi.fleetMin === 100 && voi.fleetMax === 130 && voi.fleetSource === 'gemessen + Verlauf',
    'Flotte: Fahrzeugminuten ÷ beobachtete Minuten (100), sonst Ø Verlauf ohne Lücken-Lauf (130); Mittel 115');
  assert(near(voi.disabledShare, (20 + 26) / (200 + 260)), 'Sperrquote aus dem Verlauf, Lücken-Läufe (Flag 0) nicht mitgezählt');
  assert(bolt && bolt.rides === 0 && near(bolt.fleet, 40), 'Anbieter nur im Verlauf (ohne Ereignisse) erscheint mit Flotte und 0 Fahrten');
  assert(voi.avgMin == null && voi.durN === 5, 'Ø Dauer nur ab 20 Messungen und nicht aus Tagen mit mitgezählter Lücke (Tag 1 verworfen, 5 übrig)');
  const cov = R.dayCoverage(R.hourQuality(d1.runs));
  assert(near(voi.ridesDay, 40 / (2 * cov)) && near(voi.rvd, voi.ridesDay / 115), 'Fahrten/Tag = gemessen ÷ beobachteter Anteil des Tagesgangs; je Fahrzeug ÷ Ø Flotte');
  assert(!lime.plausible && rep.totals.excluded.includes('Lime|scooter') && near(rep.totals.ridesDay, voi.ridesDay) && near(rep.totals.rvd, voi.ridesDay / (115 + 40)), 'unplausible Gruppe (RVD > 15) bleibt sichtbar, aber nicht in den Summen');
  assert(near(rep.totals.per1000Fleet, (115 + 50 + 40) / 600) && near(rep.totals.per1000Rides, voi.ridesDay / 600), 'je 1.000 Einwohner: Flotte und Fahrten je Tag');
  assert(rep.quality.prelim && rep.quality.fullDays === 0 && rep.quality.gapRuns === 1 && rep.quality.taintedDays[0] === '2026-11-02' && rep.quality.profileSource === 'Standardkurve' && rep.quality.fleetFromHistory.includes('2026-11-03'),
    'Datenqualität: vorläufig (< 3 volle Tage), 1 Lücken-Lauf, Tagesgang = Standardkurve, Flotte aus Verlauf benannt');
  const dur = R.municipalReport({ docs: [{ ...d2, groups: { '08111000|Voi|scooter': g({ start: h24({ 10: 25 }), tripDurSum: 25 * 9 * MIN, tripDurN: 25, tripDistSum: 25 * 1200, tripDistN: 25 }) } }], hists, ags: '08111000' });
  assert(near(dur.groups.find(x => x.op === 'Voi').avgMin, 9) && near(dur.groups.find(x => x.op === 'Voi').avgKm, 1.2), 'Ø Dauer 9 Min. und Distanz 1,2 km ab 20 Messungen');
  const none = R.municipalReport({ docs: [], ags: '08111000', latestGroups: { '08111000|Voi|scooter': { total: 50, disabled: 5 } } });
  assert(none.groups[0].fleet === 50 && none.groups[0].fleetSource === 'aktuell' && near(none.groups[0].disabledShare, 0.1) && none.quality.prelim, 'ohne Tagesdateien: aktueller Bestand als Ersatz, ausgewiesen');
  // M-12: Gruppe nur in 1 von 16 Läufen („Gebündelte“ aus dem konflationierten Feed) → keine Tagesflotte, nicht in den Summen
  const t16 = [...Array(16).keys()], one = t16.map(i => (i === 0 ? 6105 : null));
  const h16 = { '2026-11-03': { t: t16, f: t16.map(() => 1), series: { '08111000|Voi|scooter': { total: t16.map(() => 100), disabled: t16.map(() => 5) }, '08111000|Gebündelte|scooter': { total: one, disabled: one.map(x => (x == null ? null : 600)) } } } };
  const r16 = R.municipalReport({ docs: [d2], hists: h16, ags: '08111000', type: 'scooter' });
  assert(!r16.groups.some(x => x.op === 'Gebündelte') && r16.quality.incompleteGroups.includes('Gebündelte|scooter') && near(r16.totals.fleet, 100) && near(r16.groups.find(x => x.op === 'Voi').disabledShare, 0.05),
    'M-12: Wert nur in einem von 16 Läufen → nicht als Tagesflotte (6.105), nicht in Flotte und Sperrquote, als unvollständig ausgewiesen');
  // über daily.json (dayRuns): Präsenz aus Läufen mit Wert ÷ zählende Läufe des Tages
  const dly = { days: ['2026-11-03'], fields: ['available', 'total', 'disabled', 'lowBattery', 'stations', 'stationsEmptyDock', 'runs'], dayRuns: { '2026-11-03': 16 }, series: { '08111000|Voi|scooter': { '2026-11-03': [95, 100, 5, 0, 0, 0, 16] }, '08111000|Gebündelte|scooter': { '2026-11-03': [6000, 6105, 600, 0, 0, 0, 1] } } };
  const hd = R.histFromDaily(dly, '2026-11-03');
  const rd = R.municipalReport({ docs: [d2], hists: { '2026-11-03': hd }, ags: '08111000', type: 'scooter' });
  assert(near(hd.series['08111000|Gebündelte|scooter'].presence, 1 / 16) && !rd.groups.some(x => x.op === 'Gebündelte') && near(rd.totals.fleet, 100), 'M-12: daily.json mit dayRuns: Präsenz 1/16 → ausgeschlossen');
  const rk16 = R.cityRanking([d2], h16, { municipalities: {} }, { type: 'scooter', minFleet: 0 });
  assert(near(rk16.rows.find(r => r.ags === '08111000').fleet, 100), 'M-12: Städte-Rangliste ebenso ohne Ein-Lauf-Gruppe');
}

// ---------- Zellen ----------
{
  const cs = R.cellStats({ d1: { '100:200': [10, 2, 40, 0], '101:200': [0, 5, 60, 1], '102:201': [1, 0, 2, 0] }, d2: { '100:200': [6, 1, 40, 0], '101:200': [1, 0, 60, 0] } }, { d1: 10, d2: 10 });
  assert(cs.strong[0].cell === '100:200' && cs.strong[0].start === 16 && cs.runs === 20, 'stärkster Ort: meiste Fahrtbeginne über alle Tage');
  assert(cs.weak[0].cell === '101:200' && near(cs.weak[0].presAvg, 6) && cs.weak.length === 2, 'schwächster Ort: Bestand ≥ 2 je Lauf, wenigste Starts je Fahrzeug; Zelle mit 0,1 Fahrzeugen nicht dabei');
  assert(cs.max === 16 && near(cs.grid.find(c => c.cell === '100:200').lat, 100 * 0.0025), 'Raster mit Mittelpunkt und Maximum');
  assert(R.heatClass(0, 16) === 0 && R.heatClass(16, 16) === 8 && R.heatClass(1, 16) === 2 && R.heatClass(4, 16) === 4 && R.heatClassFloor(5, 16) === 16 * (4 / 8) ** 2, 'Heatmap-Klassen in Wurzel-Skala');
}

// ---------- Obergrenzen ----------
{
  const s = (v, l) => R.capStatus(v, l).status;
  assert(s(1349, 1500) === 'ok' && s(1350, 1500) === 'near' && s(1500, 1500) === 'near' && s(1501, 1500) === 'over' && s(10, null) === 'unknown', 'Status: unter 90 % ok, ab 90 % nahe, genau an der Grenze nahe, darüber über');
  const ffm = { ags: '06412000', gesamt: 12000, ab: '2026-07-01', gesamtAb: 10500 };
  const after = R.capLimit(ffm, Date.parse('2026-11-01T09:00:00Z')), before = R.capLimit(ffm, Date.parse('2026-06-30T12:00:00Z'));
  assert(after.limit === 10500 && after.previous === 12000 && before.limit === 12000 && before.next.limit === 10500, 'Frankfurt: ab 01.07.2026 gilt 10.500, davor 12.000 mit Hinweis');
  const ref = { obergrenzen: [{ ags: '08111000', ort: 'Stuttgart', type: 'scooter', gesamt: 6000, jeAnbieter: 1500, innenstadtbezirke: 800, zentraleInnenstadt: 100, quelle: 'Stadt', url: 'https://example.org' }, ffm] };
  const groups = { '08111000|Voi|scooter': { total: 1447, available: 1380, disabled: 67 }, '08111000|Bolt|scooter': { total: 1061, available: 1027, disabled: 34 }, '08111000|RegioRad Stuttgart|bike': { total: 618 }, '06412000|Lime|scooter': { total: 3186 } };
  const st = R.capsCheck(ref, groups, { ags: '08111000' });
  assert(st.length === 1 && st[0].total === 2508 && st[0].status === 'ok' && st[0].operators[0].op === 'Voi' && st[0].operators[0].status === 'near', 'Stuttgart: nur E-Scooter (2.508 von 6.000 ok), Voi 1.447 von 1.500 nahe');
  assert(st[0].districts.length === 2 && st[0].districts.every(d => d.status === 'unchecked') && st[0].districts[0].limit === 800, 'Bezirksgrenzen als nicht prüfbar ausgewiesen');
  const all = R.capsCheck(ref, groups, { ags: 'DE', asOf: Date.parse('2026-11-01T09:00:00Z') });
  assert(all.length === 2 && all[1].limit === 10500 && all[1].total === 3186 && all[1].operators[0].limit === null, 'Deutschlandweit: alle Gemeinden mit Eintrag; Frankfurt ohne Grenze je Anbieter');
  assert(R.capsCheck(ref, groups, { ags: '08416041' }).length === 0, 'Gemeinde ohne Eintrag: keine Prüfung');
  const voi = st[0].operators[0];
  assert(voi.available === 1380 && near(voi.availShare, 1380 / 1500) && near(voi.capShareAvail, 1380 / 6000) && st[0].available === 2407 && near(st[0].availShare, 2407 / 6000), 'Verfügbar ÷ erlaubt: Voi 1.380 buchbar ÷ 1.500 je Anbieter; gesamt 2.407 ÷ 6.000');
  assert(all[1].operators[0].availShare === null && near(all[1].operators[0].capShare, 3186 / 10500), 'Frankfurt (nur Gesamtgrenze): kein Wert je Anbieter, Anteil an der Gesamtgrenze');
}

// ---------- Obergrenzen: Status der Quelle, Zonen, gerechnete Grenzen, Zulassung ----------
{
  const asOf = Date.parse('2026-11-01T09:00:00Z');
  const ref = { obergrenzen: [
    { ags: 'B', ort: 'Berlin', type: 'scooter', gesamt: null, jeAnbieter: null, zonen: [{ name: 'Innenstadt (S-Bahn-Ring)', gesamt: 19000, jeAnbieter: 4750, jeAnbieterAbgeleitet: true }], anbieterZahl: 5, anbieter: ['Bolt', 'Lime', 'Dott (TIER)'], status: 'amtlich' },
    { ags: 'D', ort: 'Dresden', type: 'scooter', gesamt: 250, jeAnbieter: 83, jeAnbieterAbgeleitet: true, anbieter: [], status: 'amtlich' },
    { ags: 'D', ort: 'Dresden', type: 'bike', gesamt: 300, jeAnbieter: null, status: 'amtlich' },
    { ags: 'HB', ort: 'Bremen', type: 'scooter', gesamt: 100, jeAnbieter: 60, gesamtAbgeleitet: true, status: 'amtlich' },
    { ags: 'HD', ort: 'Heidelberg', type: 'scooter', gesamt: 120, jeAnbieter: 40, anbieterZahl: 3, anbieter: ['Dott (TIER)', 'Bolt', 'Voi'], status: 'amtlich' },
    { ags: 'K', ort: 'Köln', type: 'scooter', gesamt: [9000, 10000], status: 'geplant', statusText: 'ab 2027 angekündigt' },
    { ags: 'MA', ort: 'Mannheim', type: 'scooter', gesamt: 20, status: 'presse', statusText: 'nur Pressebericht' },
    { ags: 'HH', ort: 'Hamburg', type: 'scooter', gesamt: null, jeAnbieter: null, status: 'keine' } ] };
  const groups = { 'B|Bolt|scooter': { total: 3000, available: 2900 }, 'B|Voi|scooter': { total: 2000, available: 1900 }, 'D|Voi|scooter': { total: 100, available: 95 }, 'D|Bolt|scooter': { total: 50, available: 50 }, 'D|nextbike|bike': { total: 290, available: 280 },
    'HB|Voi|scooter': { total: 70, available: 65 }, 'HB|Bolt|scooter': { total: 40, available: 40 }, 'HD|Dott|scooter': { total: 45, available: 44 }, 'HD|Zeus|scooter': { total: 30, available: 30 }, 'HD|Bolt|scooter': { total: 20, available: 20 },
    'MA|Voi|scooter': { total: 50, available: 50 }, 'K|Voi|scooter': { total: 10, available: 10 }, 'HH|Voi|scooter': { total: 10, available: 10 } };
  const caps = R.capsCheck(ref, groups, { asOf }); const by = (ort, ty = 'scooter') => caps.find(c => c.ort === ort && c.types.includes(ty));
  const be = by('Berlin');
  assert(be.official && !be.hasRate && be.limit === null && be.status === 'unknown' && be.districts.length === 1 && be.districts[0].limit === 19000 && be.districts[0].perOperator === 4750 && be.districts[0].perOperatorDerived && be.districts[0].status === 'unchecked' && be.operators.every(o => o.limit === null),
    'Berlin: 19.000 gelten nur innerhalb des S-Bahn-Rings → Zone nicht prüfbar, keine stadtweite Grenze, keine Rate');
  assert(be.operators.every(o => o.licensed === null), 'Anbieterliste unvollständig (3 von 5 genannt): niemand als „ohne Zulassung“ markiert');
  const dr = by('Dresden'), drVoi = dr.operators.find(o => o.op === 'Voi');
  assert(drVoi.limit === 83 && drVoi.derived && drVoi.status === 'hint' && drVoi.availStatus === 'hint' && dr.status === 'ok' && by('Dresden', 'bike').limit === 300 && by('Dresden', 'bike').total === 290 && by('Dresden', 'bike').status === 'near',
    'Dresden: 833-artige Grenze je Anbieter gerechnet → über der Zahl nur „Hinweis“; Räder als eigener Eintrag je Art');
  const hb = by('Bremen');
  assert(hb.limitDerived && hb.status === 'hint' && hb.operators.find(o => o.op === 'Voi').status === 'over', 'Bremen: Gesamtzahl gerechnet → gesamt nur Hinweis; die genannte Zahl je Anbieter bleibt prüfbar (Voi 70 > 60 über)');
  const hd = by('Heidelberg'), zeus = hd.operators.find(o => o.op === 'Zeus'), dott = hd.operators.find(o => o.op === 'Dott');
  assert(zeus.licensed === false && zeus.limit === null && zeus.status === 'unlicensed' && dott.licensed === true && dott.status === 'over' && hd.total === 95 && hd.status === 'ok', 'Heidelberg: Zeus nicht in der vollständigen Liste → „ohne Zulassung laut Quelle“, kein Verstoß; „Dott (TIER)“ passt auf Dott; gesamt zählt alle');
  const ko = by('Köln'), ma = by('Mannheim'), hh = by('Hamburg');
  assert(!ko.official && ko.limit === null && ko.status === 'info' && ko.info.gesamt.join('–') === '9000–10000' && ma.status === 'info' && ma.info.gesamt[0] === 20 && ma.operators[0].limit === null && ma.operators[0].status === 'unknown' && hh.status === 'none' && !hh.hasRate,
    'nicht amtlich (geplant, presse): Zahl nur zur Information, keine Kennzahl; „keine“ = keine Obergrenze laut Quelle');
  const log = R.capsLogUpdate(null, caps, { at: asOf });
  const ops = new Set(log.daily.map(d => `${d[1]}|${d[2]}`));
  assert(!ops.has('MA|*') && !ops.has('K|*') && !ops.has('HH|*') && !ops.has('B|*') && log.checks.every(c => c[1] !== 'MA') && !log.checks.some(c => c[1] === 'HD' && c[2] === 'Zeus') && !log.checks.some(c => c[1] === 'D' && c[2] === 'Voi') && !log.checks.some(c => c[1] === 'HB' && c[2] === '*') && log.checks.some(c => c[1] === 'HB' && c[2] === 'Voi') && log.checks.some(c => c[1] === 'HD' && c[2] === 'Dott'),
    'Sammler-Protokoll: keine Prüfung aus nicht amtlichen, gerechneten, nur zonalen Grenzen oder für nicht zugelassene Anbieter; genannte Zahlen weiter');
  assert(log.daily.some(d => d[1] === 'D' && d[2] === '*' && d[4] === 250) && log.daily.some(d => d[1] === 'D~bike' && d[2] === '*' && d[4] === 300) && log.checks.some(c => c[1] === 'D~bike' && c[3] === 290),
    'Dresden E-Scooter und Räder getrennt im Protokoll (Schlüssel AGS bzw. AGS~Art)');
  const vd = R.capsViolations(log, { ags: 'D', asOf: asOf + 60e3 });
  assert(vd.length === 2 && vd.some(v => v.ags === 'D~bike' && v.ops.some(o => o.op === '*' && o.nearRuns === 1)), 'Verstöße je Gemeinde und Art abrufbar');
  const ca = R.capAvailability(ref, { groups }, { asOf });
  const row = (a, op) => ca.rows.find(r => r.ags === a && r.op === op);
  assert(row('HD', 'Zeus').kind === 'unlicensed' && row('HD', 'Zeus').availRate === null && row('D', 'Voi').derived && row('D', 'Voi').availStatus === 'hint' && row('HB', '*').derived && row('HB', '*').availStatus === 'hint' && !ca.rows.some(r => ['B', 'K', 'MA', 'HH'].includes(r.ags)),
    'Verfügbar ÷ erlaubt: nur amtliche Einträge mit stadtweiter Zahl; gerechnete Grenzen markiert, ohne Zulassung ohne Rate');
  assert(ca.info.map(i => i.ort).join() === 'Berlin,Köln,Mannheim,Hamburg' && ca.info[0].districts[0].limit === 19000 && ca.info[1].sourceStatus === 'geplant' && ca.cities === 4, 'übrige Einträge als Information (Teilgebiet, geplant, Presse, keine)');
  const bike = R.capAvailability(ref, { groups }, { asOf, type: 'bike' });
  assert(bike.rows.every(r => r.ags === 'D' && r.types[0] === 'bike') && bike.rows.find(r => r.op === 'nextbike').kind === 'share', 'Filter Räder: nur der Räder-Eintrag Dresden');
  // M-15: Rad-Grenze zählt E-Räder mit (außer exakteArt), Dresdner Eintrag ist nur Pressebericht
  const rb = { obergrenzen: [{ ags: 'D', ort: 'Dresden', type: 'bike', gesamt: 3000, status: 'amtlich', ausgenommeneAnbieter: ['nextbike'] }] };
  const gb = { 'D|Lime|ebike': { total: 1202, available: 1100 }, 'D|nextbike|bike': { total: 1500, available: 1400 } };
  const cb = R.capsCheck(rb, gb, { asOf })[0];
  assert(cb.total === 1202 && cb.types.join() === 'bike,ebike' && cb.type === 'bike' && R.capsCheck({ obergrenzen: [{ ...rb.obergrenzen[0], exakteArt: true }] }, gb, { asOf })[0].total === 0, 'M-15: type bike deckt ebike ab (Lime-E-Räder 1.202), exakteArt: nur Räder');
  const { readFileSync } = await import('node:fs');
  const realRef = JSON.parse(readFileSync(new URL('../data/reference.json', import.meta.url), 'utf8'));
  const dRad = realRef.obergrenzen.find(e => e.ags === '14612000' && e.type === 'bike');
  assert(dRad.status === 'presse' && /electrive/.test(dRad.quelle) && !R.capsCheck({ obergrenzen: [dRad] }, gb, { asOf })[0].official, 'M-15: Dresden Rad (nur Pressebericht) nicht als amtlich geführt');
}

// ---------- Verfügbar ÷ erlaubt je Anbieter und Stadt ----------
{
  const asOf = Date.parse('2026-11-01T09:00:00Z');
  const ref = { obergrenzen: [
    { ags: 'S', ort: 'Stuttgart', type: 'scooter', gesamt: 600, jeAnbieter: 150, quelle: 'Stadt, 20.10.2026', url: 'https://example.org' },
    { ags: 'F', ort: 'Frankfurt', type: 'scooter', gesamt: 1200, ab: '2026-07-01', gesamtAb: 1000, stand: '2026-02-26' },
    { ags: 'K', ort: 'Köln', type: ['scooter'], gesamt: 400, anbieter: [{ anbieter: 'voi', limit: 100 }, { name: 'Bolt', max: 80 }, 'Lime'], zonen: [{ name: 'Altstadt', limit: 50 }], neuesFeld: { x: 1 } },
    { ags: 'M', ort: 'Mstadt', type: 'scooter', anbieter: { Voi: 20, Tier: { fahrzeuge: 30 } } } ] };
  const latest = { groups: {
    'S|Voi|scooter': { total: 160, available: 140, disabled: 20 }, 'S|Bolt|scooter': { total: 100, available: 90 }, 'S|nb|bike': { total: 500, available: 500 },
    'F|Lime|scooter': { total: 700, available: 650 }, 'F|Voi|scooter': { total: 300, available: 280 },
    'K|Voi|scooter': { total: 110, available: 105 }, 'K|Bolt|scooter': { total: 50, available: 40 }, 'K|Lime|scooter': { total: 90, available: 88 },
    'M|Voi|scooter': { total: 10, available: 10 }, 'B|Voi|scooter': { total: 999, available: 999 } } };
  const hist = { t: [Date.parse('2026-06-30T12:00:00Z'), Date.parse('2026-07-01T12:00:00Z'), Date.parse('2026-07-01T12:20:00Z')], series: {
    'S|Voi|scooter': { total: [160, 160, 160], available: [120, 165, null] }, 'S|Bolt|scooter': { available: [60, 60, 60] },
    'F|Lime|scooter': { available: [600, 600, 700] }, 'F|Voi|scooter': { available: [240, 200, 300] }, 'S|nb|bike': { available: [500, 500, 500] } } };
  const ca = R.capAvailability(ref, latest, { hist, asOf });
  const row = (a, op) => ca.rows.find(r => r.ags === a && r.op === op);
  const sv = row('S', 'Voi'), sAll = row('S', '*'), fl = row('F', 'Lime'), fAll = row('F', '*');
  assert(ca.cities === 4 && !ca.rows.some(r => r.ags === 'B') && sv.kind === 'operator' && sv.limit === 150 && near(sv.availRate, 140 / 150) && near(sv.totalRate, 160 / 150) && sv.totalStatus === 'over' && sv.availStatus === 'near',
    'Stuttgart je Anbieter: Voi 140 buchbar ÷ 150 = 93 % (nahe), gemeldet 160 ÷ 150 = 107 % (Überschreitung); Stadt ohne Grenze fehlt');
  assert(near(sv.dayMean, (120 / 150 + 165 / 150) / 2) && near(sv.dayMin, 0.8) && sv.dayN === 2 && sAll.kind === 'total' && sAll.available === 230 && near(sAll.availRate, 230 / 600), 'Tagesmittel/-minimum aus den Sammler-Punkten (Punkt ohne Wert übersprungen); Zeile alle Anbieter gegen die Gesamtgrenze, Räder zählen nicht');
  assert(fl.kind === 'share' && fl.limit === 1000 && near(fl.availRate, 0.65) && near(fl.dayMean, (600 / 1200 + 600 / 1000 + 700 / 1000) / 3) && near(fl.dayMin, 0.5) && near(fAll.availRate, 930 / 1000) && fAll.stand === '2026-02-26',
    'Frankfurt nur Gesamtgrenze: Anteil des Anbieters an der Gesamtgrenze (ab 01.07. 1.000 statt 1.200, je Sammler-Punkt die damals gültige), Stand aus dem Eintrag');
  const kv = row('K', 'Voi'), kb = row('K', 'Bolt'), kl = row('K', 'Lime');
  assert(kv.kind === 'operator' && kv.limit === 100 && kv.availStatus === 'over' && kb.limit === 80 && kl.kind === 'share' && kl.limit === 400 && row('M', 'Voi').limit === 20,
    'neue Felder: anbieter als Liste (Name ohne Groß/Klein, limit/max) oder Objekt; zugelassen ohne Zahl → Anteil an der Gesamtgrenze; unbekannte Felder stören nicht');
  const kc = R.capsCheck(ref, latest.groups, { ags: 'K', asOf })[0];
  assert(kc.districts.some(d => d.label === 'Altstadt' && d.limit === 50 && d.status === 'unchecked') && kc.listed.join() === 'voi,Bolt,Lime' && kc.types.join() === 'scooter', 'zonen als nicht prüfbare Teilgrenzen; Liste der zugelassenen Anbieter');
  assert(!row('M', '*') && row('M', 'Voi').kind === 'operator', 'ohne Gesamtgrenze keine Summenzeile');
  const fv = R.capAvailability(ref, latest, { hist, asOf, operator: 'Voi' });
  assert(fv.rows.every(r => r.op === 'Voi') && fv.rows.length === 4, 'Filter Anbieter: nur dessen Zeilen, keine Summenzeile');
  const fb = R.capAvailability(ref, latest, { asOf, type: 'bike' });
  assert(fb.rows.length === 0 && fb.skipped.length === 4 && fb.cities === 4, 'Filter Fahrzeugart ohne Grenze: keine Zeilen, Städte als „Grenze gilt für E-Scooter“ gemeldet');
  assert(R.capAvailability(null, latest).rows.length === 0 && R.capAvailability(ref, latest, { asOf }).rows.find(r => r.ags === 'S' && r.op === 'Voi').dayN === 0, 'ohne reference.json leer; ohne Verlauf kein Tagesmittel');
  const csv = R.capAvailabilityCsvRows(ca.rows, { at: asOf });
  assert(csv.length === ca.rows.length + 1 && csv.every(r => r.length === csv[0].length) && R.toCsv(csv).includes('Anteil an der Gesamtgrenze'), 'CSV Verfügbar ÷ erlaubt: gleiche Spaltenzahl, Bezug je Zeile');
}

// ---------- CSV ----------
assert(R.csvCell('=1+1') === "'=1+1" && R.csvCell('+49 711') === "'+49 711" && R.csvCell('-x') === "'-x" && R.csvCell('@SUM(A1)') === "'@SUM(A1)" && R.csvCell('\tx') === "'\tx",'Formel-Injection: = + - @ und Tab am Anfang bekommen ein Apostroph');
assert(R.csvCell(-3) === '-3' && R.csvCell(1.5) === '1,5' && R.csvCell(2.345, 1) === '2,3' && R.csvCell(null) === '' && R.csvCell(NaN) === '', 'Zahlen bleiben Zahlen (Dezimalkomma), leere Werte leer');
assert(R.csvCell('a;b') === '"a;b"' && R.csvCell('Sag "Hallo"') === '"Sag ""Hallo"""' && R.csvCell('Zeile\n2') === '"Zeile\n2"', 'Trennzeichen, Anführungszeichen und Umbrüche werden gequotet');
// Englisch (lang 'en'): Komma als Trennzeichen, Dezimalpunkt; Formel-Schutz gleich
assert(R.csvCell(1.5, null, 'en') === '1.5' && R.csvCell(2.345, 1, 'en') === '2.3' && R.csvCell('a,b', null, 'en') === '"a,b"' && R.csvCell('a;b', null, 'en') === 'a;b' && R.csvCell('=1', null, 'en') === "'=1" && R.toCsv([['x', [1.25, 2]], ['y,z', 3]], 'en') === 'x,1.25\r\n"y,z",3',
  'CSV englisch: Komma-Trennung, Dezimalpunkt, Quoting und Formel-Schutz');
{
  const rep = R.municipalReport({ docs: [docA], ags: '08111000', pop: 1000 });
  const rows = R.reportCsvRows(rep, { name: '=Stuttgart' });
  assert(rows.length > 2 && rows.every(r => r.length === rows[0].length) && rows[1][0] === '=Stuttgart' && R.toCsv(rows).split('\r\n')[1].startsWith("'=Stuttgart;"), 'Bericht-CSV: gleiche Spaltenzahl je Zeile, Gemeindename abgesichert');
  const en = R.reportCsvRows(rep, { name: 'Stuttgart', lang: 'en' });
  assert(en[0].length === rows[0].length && en[0].slice(0, 7).join() === 'Municipality,AGS,Period_from,Period_to,Day,Operator,Vehicle_type' && en[0].includes('Trips_per_vehicle_day') && en.slice(-1)[0][4] === 'Period' && en.slice(-1)[0][5] === 'All'
    && en.slice(-1)[0].slice(-3)[0] === 'Days' && R.toCsv(en, 'en').split('\r\n')[0].startsWith('Municipality,AGS,'), 'Bericht-CSV englisch: Spaltenköpfe, Zeitraum-Zeile, Zeitraum-Art; Spaltenzahl wie deutsch');
}

// ---------- Preis-Log ----------
{
  const log = { changes: [
    { at: Date.parse('2026-10-30T10:00:00Z'), operator: 'Voi', municipalities: ['08111000'], plan: 'Standard', field: 'perMin', old: 0.25, new: 0.29 },
    { at: Date.parse('2026-10-31T10:00:00Z'), operator: 'Bolt', municipalities: ['08111000', '08416041'], plan: { name: 'Pay as you go' }, field: 'unlock', old: 1, new: 0 },
    { at: Date.parse('2026-10-29T10:00:00Z'), operator: 'Voi', municipalities: ['11000000'], plan: 'Standard', field: 'perMin', old: 0.2, new: 0.22 } ] };
  const e = R.filterPriceLog(R.priceLogEntries(log), { ags: '08111000' });
  assert(e.length === 2 && e[0].operator === 'Bolt' && e[0].plan === 'Pay as you go' && e[1].from === 0.25 && e[1].to === 0.29, 'Preis-Log: nach Gebiet gefiltert, neueste zuerst, Felder vereinheitlicht');
  const t = R.priceLogEntries({ fields: ['at', 'operator', 'ags', 'plan', 'field', 'old', 'new'], entries: [[Date.parse('2026-10-30T10:00:00Z'), 'Lime', '08111000', 'Basic', 'perMin', 0.3, 0.35]] });
  assert(t.length === 1 && t[0].munis[0] === '08111000' && t[0].to === 0.35, 'Preis-Log in Spaltenform (fields + Zeilen) wird gelesen');
  assert(R.filterPriceLog(R.priceLogEntries(log), { operator: 'Voi' }).length === 2 && R.priceLogEntries(null).length === 0, 'Filter Anbieter; fehlende Datei = leere Liste');
}

// ---------- Feed-Prüfung ----------
{
  const a = R.normalizeChecks({ errors: [{ feed: 'vehicle_status', field: 'vehicle_id', msg: 'Pflichtfeld fehlt' }], warnings: ['ttl fehlt', 'last_updated in der Zukunft'] });
  const b = R.normalizeChecks({ errors: 2, warnings: 0, findings: [{ level: 'error', msg: 'lat außerhalb' }] });
  const c = R.normalizeChecks([{ level: 'warning', message: 'version fehlt' }, { severity: 'error', message: 'kein JSON' }]);
  assert(a.errors === 1 && a.warnings === 2 && a.findings[0].text === 'vehicle_status: Pflichtfeld fehlt' && a.findings[0].level === 'error', 'Feed-Prüfung: Listen von Fehlern und Warnungen');
  const g = R.normalizeChecks({ label: 'Mobility Pulse Basisprüfung', errors: 2, warnings: 1, items: [{ level: 'error', feed: 'free_bike_status', msg: 'ungültige Koordinaten', n: 3 }, { level: 'error', feed: 'gbfs', msg: 'system_information fehlt' }, { level: 'warning', feed: 'station_status', msg: 'num_docks_available fehlt', n: 12 }] });
  assert(g.errors === 2 && g.warnings === 1 && g.findings.length === 3 && g.findings[0].text === 'free_bike_status: ungültige Koordinaten (3)' && g.findings[1].text === 'gbfs: system_information fehlt' && g.findings[2].level === 'warn' && g.label === 'Mobility Pulse Basisprüfung',
    'Feed-Prüfung im Format von checkGbfs: Zählungen, Befunde mit Datei und Anzahl, Bezeichnung');
  assert(b.errors === 2 && b.warnings === 0 && b.findings.length === 1 && c.errors === 1 && c.warnings === 1 && R.normalizeChecks(null) === null, 'Feed-Prüfung: Zählungen mit Befunden, Befundliste mit Stufe, fehlend = null');
}

// ---------- echte Daten (lokaler Stand in .realdata, falls vorhanden) ----------
{
  const D = path.resolve(new URL('..', import.meta.url).pathname, '.realdata');
  if (existsSync(path.join(D, 'events', 'index.json'))) {
    const J = (f) => JSON.parse(readFileSync(path.join(D, f), 'utf8'));
    const idx = J('events/index.json'); const docs = idx.days.map(d => J(`events/${d}.json`));
    const hists = Object.fromEntries(idx.days.filter(d => existsSync(path.join(D, 'history', `${d}.json`))).map(d => [d, J(`history/${d}.json`)]));
    const latest = J('latest.json'); const m = latest.municipalities['08111000'];
    const cells = {}, cellRuns = {};
    for (const d of idx.cellDays || []) { const f = `cells/${d}/${m.state}.json`; if (!existsSync(path.join(D, f))) continue; const c = J(f); cells[d] = c.munis?.['08111000'] || null; cellRuns[d] = (c.bandRuns || []).reduce((a, b) => a + b, 0); }
    const rep = R.municipalReport({ docs, hists, cells, cellRuns, ags: '08111000', pop: m.pop, latestGroups: latest.groups });
    const raw = docs.reduce((a, d) => a + Object.entries(d.groups).filter(([k]) => k.startsWith('08111000|')).reduce((x, [, g]) => x + g.start.reduce((p, q) => p + q, 0), 0), 0);
    assert(rep.groups.length >= 4 && rep.totals.fleet > 1000 && rep.totals.rides > 0 && rep.totals.rides < raw, `echte Daten Stuttgart: ${rep.groups.length} Gruppen, Ø Flotte ${Math.round(rep.totals.fleet)}, ${rep.totals.rides} von ${raw} Starts außerhalb von Lücken-Stunden`);
    assert(rep.quality.prelim && rep.quality.gapRuns >= 1 && rep.cells.strong.length === 5, `echte Daten: vorläufig, ${rep.quality.gapRuns} Lücken-Läufe, ${rep.cells.n} Zellen`);
    const E = await import('../lib/pulse-econ.js');
    if (E.observedMinutes && E.gapHours) assert(docs.every(d => { const a = R.hourQuality(d.runs).obsOk, b = E.observedMinutes(d.runs), g = E.gapHours(d.runs); return a.every((m, h) => Math.abs(m - b[h]) < 1e-9) && R.hourQuality(d.runs).gap.every((x, h) => x === !!g[h]); }), 'gleiche Lücken-Regel wie pulse-econ (observedMinutes/gapHours) auf den echten Tagesdateien');
    const ref = JSON.parse(readFileSync(path.resolve(D, '..', 'data', 'reference.json'), 'utf8'));
    const caps = R.capsCheck(ref, latest.groups, { ags: 'DE', asOf: latest.at });
    const rated = caps.filter(c => c.official && c.limit > 0);
    assert(caps.length === ref.obergrenzen.length && rated.length >= 1 && rated.every(c => ['ok', 'near', 'over', 'hint'].includes(c.status)) && caps.filter(c => !c.official).every(c => c.limit == null && ['info', 'none'].includes(c.status) && c.operators.every(o => o.limit == null)),
      `echte Daten Obergrenzen: amtlich mit Zahl ${rated.map(c => `${c.ort} ${c.total}/${c.limit} ${c.status}`).join(', ')}; nicht amtlich ohne Kennzahl`);
    const log = R.capsLogUpdate(null, caps, { at: latest.at });
    const officialAgs = new Set(ref.obergrenzen.filter(R.capOfficial).map(e => e.ags));
    const agsOf = (k) => String(k).split('~')[0];
    assert(log.rules.length >= 1 && log.rules.every(r => officialAgs.has(agsOf(r.ags))) && log.daily.every(d => officialAgs.has(agsOf(d[1]))), `Protokoll (Sammler): nur amtliche Einträge mit Zahl (${log.rules.map(r => r.ags).join(', ')})`);
  } else console.log('ok: echte Daten übersprungen (.realdata fehlt)');
}

// ---------- Verfügbarkeit je Stadt ----------
{
  const latest = { municipalities: { A: { name: 'Astadt', state: 'BW' }, B: { name: 'Bdorf', state: 'BY' }, C: { name: 'Cheim', state: 'BE' } }, groups: {
    'A|Voi|scooter': { total: 100, available: 80, disabled: 15, reserved: 5 }, 'A|Bolt|scooter': { total: 50, available: 50, disabled: 0, reserved: 0 }, 'A|nextbike|bike': { total: 40, available: 40 },
    'B|Voi|scooter': { total: 10, available: 9, disabled: 1, reserved: 0 }, 'C|Voi|scooter': { total: 0, available: 0 }, 'DE||scooter': { total: 999, available: 1 } } };
  const all = R.availabilityRows(latest, { minTotal: 50 });
  const a = all.find(r => r.ags === 'A');
  assert(all.length === 1 && a.total === 190 && a.available === 170 && near(a.avail, 170 / 190) && a.opCount === 3 && a.operators[0] === 'Voi' && a.reserved === 5, 'Verfügbarkeit je Stadt: buchbar ÷ gemeldet über alle Anbieter; Bundessumme und Kleinstorte (< 50) nicht dabei');
  const sc = R.availabilityRows(latest, { type: 'scooter', minTotal: 50, keepAgs: 'B' });
  assert(sc.length === 2 && near(sc.find(r => r.ags === 'A').avail, 130 / 150) && sc.find(r => r.ags === 'B').below, 'Filter Fahrzeugart; gewählte Gemeinde bleibt trotz Mindestbestand (markiert)');
  assert(R.availabilityRows(latest, { operator: 'Bolt', minTotal: 0 }).map(r => r.ags).join() === 'A', 'Filter Anbieter; Gemeinde ohne Fahrzeuge fällt weg');
  const ops = { at: 1, types: ['scooter', 'ebike', 'bike'], ops: ['Voi', 'Lime'], munis: ['A', 'B'], vehicleFields: 'lat,lon,op,type,flags(1=reserviert,2=gesperrt),akku%,reichweiteKm,standzeitMin,gemeinde', vehicles: [
    [0, 0, 0, 0, 0, 80, null, 0, 0], [0, 0, 0, 0, 0, 10, null, 0, 0], [0, 0, 0, 0, 2, 90, null, 0, 0], [0, 0, 0, 0, 0, null, 12, 0, 0], [0, 0, 0, 0, 0, null, null, 0, 0],
    ...Array.from({ length: 20 }, (_, i) => [0, 0, 1, 0, 0, 5, 40 - i, 0, 1]) ] };
  const rd = R.readinessFromOps(ops);
  const A = rd.get('A'), B = rd.get('B');
  assert(A.total === 5 && A.known === 4 && A.ready === 2 && A.okEnergy === 3, 'Einsatzbereit: buchbar und Ladestand ≥ 20 % (sonst Reichweite ≥ 5 km); gesperrt zählt nicht, ohne Energieangabe nicht im Nenner');
  // Lime meldet nur Reichweite (21…40 km): der abgeleitete Ladestand 5 % zählt nicht → alle 20 ausreichend
  assert(B.known === 20 && B.ready === 20, 'Anbieter nur mit Reichweite (Lime): beurteilt über Reichweite ≥ 5 km, nicht über den abgeleiteten Ladestand');
  assert(R.readinessFromOps(ops, { type: 'bike' }).size === 0 && R.readinessFromOps(null).size === 0, 'Filter Art in der Einsatzbereitschaft; fehlende Datei = leer');
  const ops2 = { ...ops, vehicles: [[0, 0, 0, 0, 0, 10, 8, 0, 0], [0, 0, 0, 0, 0, 10, 3, 0, 0], [0, 0, 1, 0, 0, 90, 3, 0, 1], [0, 0, 1, 0, 0, 5, 6, 0, 1]] };
  const r2 = R.readinessFromOps(ops2);
  assert(r2.get('A').known === 2 && r2.get('A').ready === 1 && r2.get('B').ready === 1, 'Einsatzbereit = nicht „Energie niedrig“: 10 % mit 8 km reicht (beides gemeldet, Reichweite genügt), 10 % mit 3 km nicht; Lime 3 km niedrig trotz 90 %');

  // Energie niedrig: eine Regel wie die Disposition
  const lo = (b, r, o) => R.energyLow(b, r, o);
  assert(lo(10, 3) === true && lo(10, 8) === false && lo(30, 3) === false && lo(10, null) === true && lo(null, 3) === true && lo(null, null) === null && lo(25, null) === false,
    'Energie niedrig: Ladestand < 20 % UND Reichweite < 5 km, wo beides gemeldet; sonst die gemeldete Angabe; ohne Angabe null');
  assert(lo(90, 3, { rangeOnly: true }) === true && lo(5, 12, { rangeOnly: true }) === false && lo(5, null, { rangeOnly: true }) === null, 'nur Reichweite (Lime): Ladestand zählt nicht, Reichweite < 5 km = niedrig');
  assert(lo(15, 4, { charge: 10, range: 5 }) === false && lo(9, 4, { charge: 10 }) === true && lo('12', '4') === true, 'eigene Grenzen (Live-Abruf) und Zahlen als Text');
  const O = await import('../lib/pulse-ops.js').catch((e) => { console.log(`ok: Abgleich mit needsSwap übersprungen (pulse-ops.js nicht ladbar: ${e.message})`); return null; });
  if (O?.needsSwap) {
    const vals = [null, 0, 5, 19, 20, 21, 50, 100], rng = [null, 0, 2, 4.9, 5, 5.1, 12];
    let same = 0, n = 0;
    for (const b of vals) for (const r of rng) { n++; const a = O.needsSwap({ battery: b, rangeKm: r, disabled: false }, { swapThreshold: 20, swapRangeKm: 5 }), c = lo(b, r) === true; if (a === c) same++; }
    assert(same === n, `gleiche Entscheidung wie needsSwap der Disposition für alle ${n} Kombinationen aus Ladestand und Reichweite (nicht gesperrt)`);
  }
  const doc = { types: ['scooter', 'bike'], ops: ['Voi', 'Lime', 'nb'], munis: ['A', 'B'], vehicleFields: 'lat,lon,op,type,flags(1=reserviert,2=gesperrt),akku%,reichweiteKm,standzeitMin,gemeinde', vehicles: [
    [0, 0, 0, 0, 0, 10, 3, 0, 0], [0, 0, 0, 0, 2, 10, 8, 0, 0], [0, 0, 0, 0, 0, 50, 2, 0, 0], [0, 0, 1, 0, 0, 12, 4, 0, 0], [0, 0, 1, 0, 0, 12, 6, 0, 0], [0, 0, 1, 0, 0, 90, 1, 0, 1],
    [0, 0, 2, 1, 0, null, null, 0, 0], [0, 0, 2, 1, 0, null, 3, 0, 0]] };
  const en = R.energyFromOps(doc);
  const voi = en.get('A|Voi|scooter'), lime = en.get('A|Lime|scooter'), nb = en.get('A|nb|bike');
  assert(voi.known === 3 && voi.low === 1 && voi.rangeOnly === 0 && lime.known === 2 && lime.low === 1 && lime.rangeOnly === 2 && lime.rangeOnlyLow === 1 && nb.known === 1 && nb.low === 1 && nb.rangeOnly === 1,
    'Energie je Gruppe aus ops/<Land>.json: Voi 1 von 3 (gesperrt zählt mit), Lime über Reichweite 1 von 2, Rad ohne Ladestand über Reichweite');
  const tot = R.sumEnergy([...en.values()]);
  assert(tot.known === 7 && tot.low === 4 && tot.rangeOnly === 4 && R.energyFromOps(doc, { keep: (a) => a === 'B' }).size === 1 && R.energyFromOps(null).size === 0, 'Summe über Gruppen; Filter je Gemeinde; fehlende Datei = leer');
  assert(R.energyFromOps(doc, { charge: 15, range: 3.5 }).get('A|Lime|scooter').low === 0, 'Grenzen aus dem Live-Abruf wirken auf die Zählung');
  const hist = { day: '2026-11-01', t: [1, 2, 3], series: { 'A|Voi|scooter': { total: [100, 100, null], available: [90, 50, null] }, 'A|Bolt|scooter': { total: [200, 200, 200], available: [200, 200, 160] }, 'DE||scooter': { total: [1, 1, 1], available: [0, 0, 0] } } };
  const ha = R.histAvailability(hist).byAgs.get('A');
  assert(near(ha.mean, (290 / 300 + 250 / 300 + 160 / 200) / 3) && near(ha.min, 0.8) && ha.minAt === 3 && ha.n === 3, 'Tagesmittel und -minimum der Verfügbarkeit aus den Sammler-Punkten, Punkte ohne Wert übersprungen');
  const ser = R.availabilitySeries(hist, 'A');
  assert(ser.series.length === 2 && ser.series[0].op === 'Bolt' && ser.series[1].values[2] === null && near(ser.series[1].values[1], 0.5), 'Verlauf je Anbieter: Anteil je Lauf, fehlender Punkt = null, sortiert nach Bestand');
  const segs = R.lineSegments([0, 20 * MIN, 40 * MIN, 140 * MIN, 160 * MIN, 180 * MIN], [1, 1, 1, 1, null, 1]);
  assert(segs.length === 3 && segs[0].length === 3 && segs[1].length === 1 && segs[2][0] === 5, 'Linie bricht bei Lücke > 45 Min. und bei fehlendem Punkt');
  const sorted = R.sortRows([{ name: 'b', avail: 0.9 }, { name: 'a', avail: null }, { name: 'c', avail: 0.5 }], 'avail', 'asc');
  assert(sorted.map(r => r.name).join('') === 'cba' && R.sortRows(sorted, 'avail', 'desc').map(r => r.name).join('') === 'bca' && R.sortRows(sorted, 'name', 'asc')[0].name === 'a', 'Sortieren: leere Werte immer am Ende, Text nach deutscher Ordnung');
  const csv = R.availabilityCsvRows([{ ...a, name: '=Astadt', ready: 0.5, readyKnown: 4, dayMean: null, dayMin: null }]);
  assert(R.toCsv(csv).split('\r\n')[1].startsWith("A;'=Astadt;BW;alle;alle;190;170;0,8947"), 'Verfügbarkeits-CSV mit Dezimalkomma und Formel-Schutz');
  const csvEn = R.availabilityCsvRows([{ ...a, name: '=Astadt', ready: 0.5, readyKnown: 4, dayMean: null, dayMin: null }], { lang: 'en' });
  assert(csvEn[0][1] === 'City' && csvEn[0][7] === 'Availability' && R.toCsv(csvEn, 'en').split('\r\n')[1].startsWith("A,'=Astadt,BW,all,all,190,170,0.8947"), 'Verfügbarkeits-CSV englisch: Köpfe, „all“, Dezimalpunkt, Formel-Schutz');
}

// ---------- Datenschutz-Schwelle ----------
{
  assert(R.suppressed(0) && R.suppressed(1) && !R.suppressed(2) && !R.suppressed(null), 'Schwelle: 0 und 1 Fahrt werden unterdrückt, ab 2 sichtbar');
  const cs = R.cellStats({ d: { '1:1': [5, 1, 3, 0], '1:2': [1, 0, 4, 0] } }, { d: 2 });
  const rows = R.cellsCsvRows(cs, { name: 'X' });
  assert(rows[1][7] === 5 && rows[1][8] === '<2' && rows[2][7] === '<2', 'Orte-CSV: Zählungen unter 2 als „<2“');
  assert(R.cellsCsvRows(cs, { name: 'X', lang: 'en' })[0].join() === 'Municipality,AGS,Period_from,Period_to,Cell,Latitude,Longitude,Trip_starts,Trip_ends,Available_per_run,Rebalancing', 'Orte-CSV englisch: Spaltenköpfe');
  const hm = R.weekHeatmap([{ day: '2026-11-02', runs: fullHourRuns('2026-11-02', 10), groups: { 'A|x|scooter': { start: h24({ 10: 1 }) } } }]);
  assert(hm.cells[0][10].raw === 1 && R.suppressed(hm.cells[0][10].raw), 'Heatmap führt die Rohzahl je Zelle für die Schwelle mit');
}

// ---------- Rangliste, Vorperiode, Dichte ----------
{
  const g = (start, vt) => ({ start: h24({ 10: start }), vminTot: h24({ 10: vt }) });
  const mk = (day, groups) => ({ day, runs: fullHourRuns(day, 10), groups });
  const docs = [mk('2026-11-02', { 'A|Voi|scooter': g(30, 100 * 60), 'A|Lime|scooter': g(9000, 50 * 60), 'A|nb|bike': g(5, 60 * 60), 'B|Voi|scooter': g(1, 10 * 60) })];
  const latest = { municipalities: { A: { name: 'Astadt', pop: 100000, areaKm2: 50 }, B: { name: 'Bdorf', pop: 1000 } } };
  const rk = R.cityRanking(docs, {}, latest, { minFleet: 50 });
  const as = rk.rows.find(r => r.key === 'A|scooter');
  const cov = R.dayCoverage(R.hourQuality(docs[0].runs));
  assert(rk.rows.length === 2 && as.fleet === 150 && as.opCount === 2 && as.excluded[0] === 'Lime' && near(as.ridesDay, 30 / cov) && near(as.rvd, (30 / cov) / 100), 'Rangliste je Stadt × Art: unplausibler Anbieter nur in der Flotte, Fahrten/Tag ÷ Flotte der übrigen');
  assert(near(as.per1000Fleet, 1.5) && rk.prelim && !rk.rows.some(r => r.ags === 'B'), 'je 1.000 Einwohner; Mindestbestand; vorläufig unter 3 vollen Tagen');
  const dp = R.densityPoints(rk.rows);
  assert(dp.length === 2 && dp.find(p => p.key === 'A|scooter').density === 3 && near(dp.find(p => p.key === 'A|bike').density, 60 / 50), 'Dichte: Ø Flotte ÷ Fläche (km²), nur mit Fläche und Quote');
  const fullDay = (day) => ({ day, runs: Array.from({ length: 24 }, (_, h) => fullHourRuns(day, h)).flat(), groups: {} });
  const days6 = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'].map(fullDay);
  const per = R.rankingPeriods(days6);
  assert(per.n === 3 && per.cur[0].day === '2026-11-05' && per.prev[0].day === '2026-11-02', 'Vorperiode: zwei gleich lange Hälften (3 + 3 volle Tage)');
  assert(R.rankingPeriods(days6.slice(0, 5)).reason && R.rankingPeriods(docs).reason.includes('2 × 3'), 'Vorperiode ausgeblendet, solange eine Hälfte unter 3 vollen Tagen liegt');
}

// ---------- Gebühren, Regulierung ----------
{
  const ref = { obergrenzen: [{ ags: 'S', ort: 'Stuttgart', type: 'scooter', gesamt: 6000 }], gebuehren: [
    { ags: 'K', ort: 'Köln', type: 'scooter', satz: [85, 130], einheit: '€ je Fahrzeug und Jahr', gebiet: 'drei Zonen', quelle: 'Stadt Köln', url: 'https://example.org' },
    { ags: 'K', ort: 'Köln', type: ['bike', 'cargo'], satz: 10, einheit: '€ je Fahrzeug und Jahr' },
    { ags: 'M', ort: 'Mstadt', type: 'scooter', satz: 3, einheit: '€ je Fahrzeug und Monat' } ] };
  const groups = { 'K|Voi|scooter': { total: 1000 }, 'K|Bolt|scooter': { total: 500 }, 'K|nb|bike': { total: 200 }, 'M|Voi|scooter': { total: 100 }, 'S|Voi|scooter': { total: 10 } };
  const f = R.feeEstimates(ref, groups);
  assert(f[0].count === 1500 && f[0].yearMin === 127500 && f[0].yearMax === 195000 && f[0].rate.range && near(f[0].monthMin, 10625), 'Gebühr Köln: 1.500 E-Scooter × 85–130 € je Jahr = 127.500–195.000 €');
  assert(f[1].count === 200 && f[1].yearMin === 2000 && f[2].yearMin === 3600 && f[2].rate.monthly, 'Mehrere Arten je Satz; Monatssatz × 12');
  assert(R.feeEstimates(ref, groups, { ags: 'S' }).length === 0 && R.feeRate({ satz: 'x' }) === null && R.ownFee(2, 'monat', 100).year === 2400 && R.ownFee(50, 'jahr', 10).month === 500 / 12, 'Ohne Eintrag keine Gebühr; eigener Satz je Monat oder Jahr');
  const latest = { municipalities: { K: { name: 'Köln', state: 'NW', pop: 1e6 } }, groups };
  const rp = R.regulationProfiles(ref, latest);
  const k = rp.find(p => p.ags === 'K');
  assert(rp.length === 3 && k.fees.length === 2 && k.operators.scooter.join() === 'Bolt,Voi' && rp.find(p => p.ags === 'S').caps.length === 1, 'Steckbrief: alle Gemeinden mit Eintrag; Gebühren, Obergrenzen, Anbieter je Art laut Daten');
  assert(R.regulationProfiles(ref, latest, { ags: 'K' }).length === 1, 'Steckbrief für eine gewählte Gemeinde');
}

// ---------- Hotspot-Stabilität ----------
{
  const day = (cells) => Object.fromEntries(cells.map(([c, n]) => [c, [n, 0, 0, 0]]));
  const st = R.hotspotStability({ d1: day([['a', 9], ['b', 8], ['c', 7], ['x', 1]]), d2: day([['a', 5], ['c', 4], ['d', 3], ['x', 1]]), d3: null }, { top: 3 });
  assert(st.days.length === 2 && st.pairs.length === 1 && st.pairs[0].common === 2 && near(st.pairs[0].share, 2 / 3) && near(st.pairs[0].jaccard, 2 / 4) && near(st.meanShare, 2 / 3), 'Top-N-Überlappung zwischen Tagen: gemeinsam ÷ kleinere Menge, Jaccard; Zellen < 2 Starts zählen nicht');
}

// ---------- endgültige Formate des Sammlers ----------
{
  const log = { updatedAt: 1, days: 180, fields: ['at', 'sourceId', 'operator', 'planId', 'field', 'old', 'new'], changes: [
    [Date.parse('2026-10-31T10:00:00Z'), 'voi_stuttgart', 'Voi', 'p1', 'perMin', [{ start: 0, rate: 0.25, interval: 1 }], [{ start: 0, rate: 0.29, interval: 1 }]],
    [Date.parse('2026-10-30T10:00:00Z'), 'voi_berlin', 'Voi', 'p9', '+plan', null, 'p9'],
    [Date.parse('2026-10-29T10:00:00Z'), 'unbekannt', 'Bolt', 'x', 'unlock', 1, 0] ] };
  const sources = [{ id: 'voi_stuttgart', municipalities: ['08111000'] }, { id: 'voi_berlin', municipalities: ['11000000'] }];
  const pricing = { plans: [{ sourceId: 'voi_stuttgart', plans: [{ id: 'p1', name: 'Voi Standard' }] }] };
  const e = R.priceLogEntries(log, { sources, pricing });
  const st = R.filterPriceLog(e, { ags: '08111000' });
  assert(e.length === 3 && e[0].plan === 'Voi Standard' && e[0].munis[0] === '08111000' && e[1].plan === 'p9' && e[1].field === '+plan', 'Preis-Log im Sammler-Format: Gebiet über sourceId, Tarifname über pricing.json, sonst planId');
  assert(st.length === 2 && st[0].operator === 'Voi' && st[1].operator === 'Bolt', 'Gebietsfilter: Einträge ohne bekannte Quelle bleiben sichtbar (bundesweit), andere Gemeinden fallen weg');
  const daily = { days: ['2026-11-02'], fields: ['available', 'total', 'disabled', 'lowBattery', 'stations', 'stationsEmptyDock', 'runs'], series: { '08111000|Voi|scooter': { '2026-11-02': [90, 120, 12, 5, 0, 0, 70] } } };
  const h = R.histFromDaily(daily, '2026-11-02');
  const d2 = { day: '2026-11-02', runs: fullHourRuns('2026-11-02', 10).map(r => [r[0], r[1]]), groups: { '08111000|Voi|scooter': { start: h24({ 10: 6 }) } } };
  const rep = R.municipalReport({ docs: [d2], hists: { '2026-11-02': h }, ags: '08111000' });
  assert(h && R.histFromDaily(daily, '2026-11-03') === null && rep.groups[0].fleet === 120 && near(rep.groups[0].disabledShare, 0.1), 'history/daily.json als Ersatz: Ø Flotte und Sperrquote aus den Tagesmitteln');
}

// ---------- Heatmap Start/Ziel ----------
{
  const d = { day: '2026-11-02', runs: fullHourRuns('2026-11-02', 10), groups: { 'A|x|scooter': { start: h24({ 10: 3 }), end: h24({ 10: 7 }) } } };
  const s = R.weekHeatmap([d]), e = R.weekHeatmap([d], () => true, { field: 'end' });
  assert(s.cells[0][10].mean === 3 && e.cells[0][10].mean === 7 && e.field === 'end' && s.field === 'start', 'Heatmap: Umschalter Fahrtbeginne / Fahrtenden');
}

// ---------- Obergrenzen-Protokoll (caps-log.json) ----------
{
  const ref = { obergrenzen: [{ ags: 'S', ort: 'Stuttgart', type: 'scooter', gesamt: 100, jeAnbieter: 40, quelle: 'Stadt', url: 'https://example.org' }] };
  const t0 = Date.parse('2026-11-02T08:00:00Z');
  const caps = (voi, bolt) => R.capsCheck(ref, { 'S|Voi|scooter': { total: voi }, 'S|Bolt|scooter': { total: bolt } }, { ags: 'DE', asOf: t0 });
  let log = R.capsLogUpdate(null, caps(30, 20), { at: t0, dt: 20 * 60e3 });
  assert(log.checks.length === 0 && log.daily.length === 3 && log.rules[0].limit === 100 && log.rules[0].perOperator === 40 && log.fields.join() === 'at,ags,operator,count,limit,dtMs', 'unter 90 %: keine Prüfung, aber Tagesmaximum je Gemeinde × Anbieter (gesamt, Voi, Bolt)');
  log = R.capsLogUpdate(log, caps(45, 50), { at: t0 + 20 * 60e3, dt: 20 * 60e3 });
  log = R.capsLogUpdate(log, caps(44, 52), { at: t0 + 40 * 60e3, dt: 20 * 60e3 });
  log = R.capsLogUpdate(log, caps(38, 30), { at: t0 + 60 * 60e3, dt: 120 * 60e3 }); // Voi 95 % (nahe), langes Fenster gekappt auf 45 Min.
  const voiChecks = log.checks.filter(c => c[2] === 'Voi');
  assert(log.checks.filter(c => c[2] === '*').length === 2 && voiChecks.length === 3 && voiChecks[2][5] === 45 * 60e3 && log.daily.find(d => d[2] === 'Voi')[3] === 45, 'Prüfungen ab 90 % der Grenze (gesamt 95 und 96 von 100, Voi 45/44/38 von 40), Fenster höchstens 45 Min., Tagesmaximum steigt');
  const v = R.capsViolations(log, { asOf: t0 + 2 * 3600e3 });
  const S = v[0], voi = S.ops.find(o => o.op === 'Voi'), bolt = S.ops.find(o => o.op === 'Bolt'), tot = S.ops.find(o => o.op === '*');
  assert(v.length === 1 && voi.overMs === 40 * 60e3 && voi.overRuns === 2 && voi.nearMs === 45 * 60e3 && voi.peak === 45 && bolt.overMs === 40 * 60e3 && bolt.peak === 52 && tot.op === '*' && tot.overMs === 0 && tot.nearRuns === 2, 'Verstöße: Dauer über der Grenze je Anbieter, Spitzenwert, nahe-Dauer; gesamt 95/96 nur nahe');
  assert(S.daily.length === 1 && S.daily[0].max === 96 && S.daily[0].limit === 100, 'Verlauf: Tagesmaximum gesamt');
  const old = R.capsLogUpdate(log, caps(10, 10), { at: t0 + 31 * 86400e3, dt: 20 * 60e3 });
  assert(old.checks.length === 0 && old.daily.every(d => d[0] === R.berlinDay(t0 + 31 * 86400e3)), 'nach 30 Tagen fallen Prüfungen und Tagesmaxima heraus');
  assert(R.capsViolations(null).length === 0 && R.capsViolations({ checks: [], rules: ref.obergrenzen }, { ags: 'S' })[0].ops.length === 0, 'ohne Datei leer; Gemeinde mit Regel, aber ohne Verstoß');
  const many = R.capsLogUpdate({ checks: Array.from({ length: 7000 }, (_, i) => [t0 - i * 1000, 'S', '*', 99, 100, 1000]) }, [], { at: t0 + 1 });
  assert(many.checks.length === 6000 && many.checks[0][0] > t0 - 7000 * 1000, 'Größe begrenzt: höchstens 6.000 Prüfungen, älteste fallen zuerst');
}

// ---------- Zeiträume Monat/Quartal und Archiv ----------
{
  assert(R.periodRange('q:2026-Q4').from === '2026-10-01' && R.periodRange('q:2026-Q4').to === '2026-12-31' && R.periodRange('m:2028-02').to === '2028-02-29' && R.periodRange('x') === null, 'Zeitraum Quartal/Monat: Beginn und Ende (Schaltjahr)');
  assert(R.periodRange('m:2026-03').label === 'März 2026' && R.periodRange('m:2026-03', 'en').label === 'March 2026' && R.periodRange('m:2026-03', 'en').kind === 'Monat' && R.monthsOf(['2026-10-31', '2026-11-01'], 'en').map(m => m.label).join() === 'October 2026,November 2026',
    'Monatsnamen je Sprache; kind bleibt Kennung');
  const span = (a, b) => { const out = []; for (let t = Date.parse(`${a}T12:00:00Z`); t <= Date.parse(`${b}T12:00:00Z`); t += 86400e3) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
  const d1 = span('2026-10-31', '2026-11-01');
  assert(R.completeQuarters(d1).length === 0 && R.monthsOf(d1).length === 2 && R.monthsOf(d1).every(m => !m.complete && m.days === 1), 'zwei Tage: kein vollständiges Quartal, zwei angefangene Monate');
  const d2 = span('2026-12-20', '2027-07-02');
  assert(R.completeQuarters(d2).join() === '2027-Q1,2027-Q2' && R.monthsOf(d2).find(m => m.key === '2027-01').complete && R.daysIn('q:2027-Q1', d2).length === 90, 'Quartal erst, wenn die Daten ganz darüber reichen; Q1/2027 = 90 Tage');
  const rq = R.rankingQuarters(d2);
  assert(rq && rq.cur === '2027-Q2' && rq.prev === '2027-Q1' && rq.curDays.length === 91 && R.rankingQuarters(span('2027-01-01', '2027-04-02')) === null, 'Vorquartal: zwei aufeinanderfolgende vollständige Quartale');
  const arch = { '2027-01-01': { 'S|Voi|scooter': [100, 120, 118, 5, 2, 1, 0, 3, 720], 'S|nb|bike': [50, 20, 20, 0, 0, 0, 0, 0, 720], 'B|Voi|scooter': [10, 999, 0, 0, 0, 0, 0, 0, 720] },
    '2027-01-02': { 'S|Voi|scooter': [110, 330, 320, 5, 2, 1, 0, 3, 1440] } };
  const ar = R.archiveReport({ archive: arch, ags: 'S', pop: 10000 });
  const voi = ar.groups.find(g => g.op === 'Voi');
  assert(ar.quality.source === 'archiv' && ar.days.length === 2 && near(voi.fleet, 105) && voi.rides === 450 && near(voi.ridesDay, 450 / 1.5) && near(voi.rvd, 300 / 105) && ar.quality.fullDays === 1 && ar.daily[0].coverage === 0.5, 'Archiv-Bericht: Ø Flotte, Fahrten linear über die beobachtete Zeit hochgerechnet (720 Min. = halber Tag)');
  assert(near(ar.totals.per1000Rides, (300 + 40) / 10) && ar.cells.n === 0 && ar.groups.every(g => g.avgMin == null), 'Archiv-Bericht: je 1.000 EW, ohne Orte und Dauer');
  const rows = R.reportCsvRows(ar, { name: 'S', period: { kind: 'Quartal', label: 'Q1/2027' } });
  assert(rows.every(r => r.length === rows[0].length) && rows[0].slice(-3).join() === 'Zeitraum_Art,Zeitraum_Name,Quartal' && rows[1].slice(-3).join() === 'Quartal,Q1/2027,2027-Q1', 'Bericht-CSV mit Zeitraum-Art und Quartal je Zeile');
  const crk = R.cityRankingArchive(arch, { municipalities: { S: { name: 'Stadt' } } }, { type: 'scooter' });
  const rs = crk.rows.find(r => r.ags === 'S'), rb = crk.rows.find(r => r.ags === 'B');
  assert(rs.name === 'Stadt' && near(rs.rvd, 300 / 105) && rb.rvd === null && rb.fleet === 10, 'Rangliste aus dem Archiv: unplausible Quote (> 15) zählt nur bei der Flotte');
}

// ---------- Plausibilitätsgrenze aus der Kalibrierung (Überzählung) ----------
{
  const fullDay = (day) => Array.from({ length: 24 }, (_, h) => fullHourRuns(day, h)).flat();
  const doc = { day: '2026-11-02', runs: fullDay('2026-11-02'), groups: {
    'F|Lime|scooter': { start: h24(Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, 40]))), vminTot: new Array(24).fill(100 * 60) },   // 960 Fahrten / 100 Fzg. = 9,6
    'F|Dott|scooter': { start: h24(Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, 8]))), vminTot: new Array(24).fill(100 * 60) },    // 192 / 100 = 1,92
    'F|nb|bike': { start: h24(Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, 20]))), vminTot: new Array(24).fill(100 * 60) } } };     // 4,8 (keine Grenze)
  const lim = { scooter: 3.465 };
  const a = R.municipalReport({ docs: [doc], ags: 'F' }), b = R.municipalReport({ docs: [doc], ags: 'F', rvdLimit: lim });
  const lb = b.groups.find(g => g.op === 'Lime');
  assert(a.groups.every(g => g.plausible) && !lb.plausible && lb.flags[0] === R.SUSPENDED && b.groups.find(g => g.op === 'nb').plausible && near(b.totals.ridesDay, 192 + 480, 1e-6) && b.totals.excluded.join() === 'Lime|scooter', 'Bericht: E-Scooter über der Grenze (9,6 > 3,47) als Überzählung markiert und aus Summen genommen; Räder ohne Grenze');
  const latest = { municipalities: { F: { name: 'Fstadt' } } };
  const rk = R.cityRanking([doc], {}, latest, { type: 'scooter', minFleet: 0, rvdLimit: lim }).rows[0];
  assert(rk.excluded.join() === 'Lime' && near(rk.rvd, 1.92, 1e-6) && rk.fleet === 200, 'Rangliste: überzählender Anbieter nur bei der Flotte');
  assert(R.overLimit(3.5, 'scooter', lim) && !R.overLimit(3.4, 'scooter', lim) && !R.overLimit(9, 'bike', lim) && !R.overLimit(9, 'scooter', null), 'Grenze nur für Arten mit Referenz');
}

// Ausgenommene Anbieter (Dresden: MOBIbike mit Bestandsschutz) zählen nicht gegen die Obergrenze
{
  const R2 = await import('../lib/pulse-report.js');
  const ref = { obergrenzen: [{ ags: '14612000', ort: 'Dresden', type: 'bike', gesamt: 3000, status: 'amtlich', ausgenommeneAnbieter: ['nextbike'] }] };
  const groups = { '14612000|nextbike|bike': { total: 1716, available: 1700 }, '14612000|Donkey|bike': { total: 200, available: 190 } };
  const c = R2.capsCheck(ref, groups, { ags: '14612000' })[0];
  if (!c || c.operators.some(o => o.op === 'nextbike')) throw new Error('ausgenommener Anbieter gezählt');
  console.log('ok: ausgenommener Anbieter (Bestandsschutz) zählt nicht gegen die Obergrenze');
}

// ---------- Zonen-Beobachtung ----------
{
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const inner = { type: 'Feature', properties: { id: 'geheim123', name: 'Kernstadt', enabled: true, limits: { scooter: { type: 'absolute', maximum: 130, minimum: 80 } } }, geometry: { type: 'Polygon', coordinates: [sq(9.17, 48.77, 9.19, 48.79)] } };
  const outer = { type: 'Feature', properties: { name: 'Innenstadt', ags: '08111000', limits: { scooter: { maximum: 900 } } }, geometry: { type: 'Polygon', coordinates: [sq(9.10, 48.74, 9.25, 48.82), sq(9.20, 48.80, 9.21, 48.81)] } };
  const zones = R.parseZoneWatch(JSON.stringify({ type: 'FeatureCollection', features: [outer, inner, { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [9, 48] } }] }));
  assert(zones.length === 2 && zones[0].id === 'innenstadt' && zones[0].ags === '08111000' && zones[1].id === 'kernstadt' && zones[1].ags === null && !JSON.stringify(zones).includes('130') && !JSON.stringify(zones).includes('limits') && !JSON.stringify(zones).includes('geheim'),
    'ZONE_WATCH: Umrisse mit Name/AGS, Limits und fremde Kennungen verworfen, Punkt übersprungen');
  assert(R.parseZoneWatch(Buffer.from(JSON.stringify(inner)).toString('base64')).length === 1 && R.parseZoneWatch('kein json').length === 0 && R.parseZoneWatch('').length === 0, 'ZONE_WATCH auch base64; Unlesbares → keine Zonen');
  assert(R.zoneContains(zones[0], 9.18, 48.78) && !R.zoneContains(zones[0], 9.205, 48.805) && !R.zoneContains(zones[0], 9.30, 48.78) && R.zoneContains(zones[1], 9.18, 48.78), 'Punkt in Zone, Loch ausgenommen, außerhalb nein');
  const veh = [
    { lat: 48.78, lon: 9.18, operator: 'Bolt', type: 'scooter' }, { lat: 48.78, lon: 9.181, operator: 'Bolt', type: 'scooter', disabled: true },
    { lat: 48.75, lon: 9.12, operator: 'Bolt', type: 'scooter' }, { lat: 48.75, lon: 9.12, operator: 'Voi', type: 'scooter' }, { lat: 48.805, lon: 9.205, operator: 'Voi', type: 'scooter' },
    { lat: 48.70, lon: 9.00, operator: 'Dott', type: 'scooter' }, { lat: null, lon: null, operator: 'Dott', type: 'scooter' },
  ];
  const c1 = R.zoneCounts(zones, veh);
  assert(c1.get('innenstadt|Bolt|scooter')?.join() === '3,2' && c1.get('kernstadt|Bolt|scooter')?.join() === '2,1' && c1.get('innenstadt|Voi|scooter')?.join() === '1,1' && !c1.has('innenstadt|Dott|scooter'),
    'Bestand je Zone/Anbieter/Art [gesamt, verfügbar]; verschachtelte Zonen zählen beide; Loch und ohne Position nicht');
  const t1 = T('2026-11-02T10:00:00'), t2 = T('2026-11-02T10:20:00'), t3 = T('2026-11-02T10:40:00');
  let log = R.zoneLogUpdate(null, zones, c1, { at: t1 });
  log = R.zoneLogUpdate(log, zones, new Map([['innenstadt|Bolt|scooter', [5, 5]], ['kernstadt|Bolt|scooter', [1, 1]]]), { at: t2 });
  log = R.zoneLogUpdate(log, zones, new Map([['innenstadt|Bolt|scooter', [9, 9]]]), { at: t3, flag: 0 });
  const d = (z, op) => log.daily.find(r => r[1] === z && r[2] === op);
  assert(log.zones.length === 2 && !JSON.stringify(log).includes('9.17') && d('innenstadt', 'Bolt').slice(4).join() === '3,5,4,2' && d('innenstadt', 'Voi').slice(4).join() === '0,1,0.5,2' && d('kernstadt', 'Bolt').slice(4).join() === '1,2,1.5,2',
    'Tageswerte Min/Max/Mittel/Läufe; Anbieter ohne Fahrzeuge im Folgelauf mit 0; Lauf mit Flag 0 zählt nicht; keine Koordinaten im Protokoll');
  const later = R.zoneLogUpdate(log, zones, new Map([['innenstadt|Bolt|scooter', [7, 6]]]), { at: T('2026-12-05T10:00:00') });
  assert(later.daily.every(r => r[0] >= '2026-11-06') && later.runs.every(r => r[0] >= T('2026-12-03T10:00:00')), 'Tageswerte 30 Tage, Läufe 2 Tage');
  const sum = R.zoneSummary(log, { asOf: t3 });
  const inn = sum.find(z => z.id === 'innenstadt'), bolt = inn.rows.find(r => r.op === 'Bolt'), star = inn.rows.find(r => r.op === '*');
  assert(bolt.now === 5 && bolt.avail === 5 && bolt.todayMin === 3 && bolt.todayMax === 5 && bolt.mean7 === 4 && bolt.max30 === 5 && bolt.series.length === 1 && star.now === 5 && star.todayMax === 5 && star.todayMin === 4 && inn.rows[inn.rows.length - 1].op === '*',
    'Übersicht: jetzt, heute Min–Max, Ø 7 Tage, Max 30 Tage; Summenzeile aus gleichzeitigem Bestand der Läufe, zuletzt');
  {
    const out = R.zoneLogUpdate(R.zoneLogUpdate(null, zones, c1, { at: t1 }), zones, new Map([['innenstadt|Bolt|scooter', [4, 4]]]), { at: t2, carryZero: (z, op) => op !== 'Voi' });
    assert(out.daily.find(r => r[1] === 'innenstadt' && r[2] === 'Voi')[7] === 1 && !out.runs.some(r => r[0] === t2 && r[2] === 'Voi'), 'Feed-Ausfall (carryZero nein): kein Nullbestand im Protokoll');
  }
  assert(R.zoneSummary(log, { operator: 'Voi', asOf: t3 }).find(z => z.id === 'innenstadt').rows.every(r => r.op === 'Voi' || r.op === '*'), 'Filter Anbieter wie oben im Dashboard');
}
// ---------- Teilgebiete gegen vermutete Abgrenzung ----------
{
  const pub = R.parseZoneWatch(readFileSync(new URL('../data/zonen-vermutet.json', import.meta.url), 'utf8'));
  const ref = JSON.parse(readFileSync(new URL('../data/reference.json', import.meta.url), 'utf8'));
  const stg = ref.obergrenzen.find(e => e.ags === '08111000'), watch = stg.zonen.map(z => z.beobachtung).filter(Boolean);
  assert(pub.length === 2 && pub.every(z => z.assumed && z.ags === '08111000' && z.description?.includes('Vermutet') && z.accuracyM > 0 && z.polys[0][0].length < 60) && watch.every(w => pub.some(z => z.id === w)) && watch.length === 2,
    'data/zonen-vermutet.json: zwei vermutete, grob vereinfachte Stuttgarter Teilgebiete; reference.json ordnet beide zu');
  assert(pub.find(z => z.id === 'zentrale-innenstadt') && R.zoneContains(pub.find(z => z.id === 'zentrale-innenstadt'), 9.1793, 48.7784) && R.zoneContains(pub.find(z => z.id === 'innenstadtbezirke'), 9.1793, 48.7784) && !R.zoneContains(pub.find(z => z.id === 'innenstadtbezirke'), 9.12, 48.70),
    'Schlossplatz liegt in beiden Teilgebieten, Vaihingen in keinem');
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const zs = R.parseZoneWatch(JSON.stringify({ type: 'Feature', properties: { name: 'zentrale Innenstadt', vermutet: true, genauigkeit_m: 150 }, geometry: { type: 'Polygon', coordinates: [sq(9.17, 48.77, 9.19, 48.79)] } }));
  const t1 = T('2026-11-02T10:00:00'), t2 = T('2026-11-02T10:20:00');
  let log = R.zoneLogUpdate(null, zs, new Map([['zentrale-innenstadt|Dott|scooter', [120, 118]], ['zentrale-innenstadt|Voi|scooter', [60, 60]], ['zentrale-innenstadt|RegioRad|bike', [40, 40]]]), { at: t1 });
  log = R.zoneLogUpdate(log, zs, new Map([['zentrale-innenstadt|Dott|scooter', [95, 95]], ['zentrale-innenstadt|Voi|scooter', [92, 92]]]), { at: t2 });
  const caps = R.capsCheck({ obergrenzen: [{ ags: '08111000', ort: 'Stuttgart', type: 'scooter', gesamt: 6000, jeAnbieter: 1500, anbieter: ['Dott', 'Voi', 'Bolt', 'Lime'], zonen: [{ name: 'zentrale Innenstadt', jeAnbieter: 100, beobachtung: 'zentrale-innenstadt' }, { name: 'ohne Umriss', jeAnbieter: 5 }], status: 'amtlich' }] },
    { '08111000|Dott|scooter': { total: 1300, available: 1290 } }, { asOf: t2, zoneWatch: log });
  const [d1, d2] = caps[0].districts, dott = d1.check.operators.find(o => o.op === 'Dott'), voi = d1.check.operators.find(o => o.op === 'Voi');
  assert(d1.check && d1.check.assumed && d1.check.accuracyM === 150 && dott.now === 95 && dott.limit === 100 && dott.status === 'near' && dott.max30 === 120 && dott.daysOver === 1 && voi.now === 92 && voi.status === 'near'
    && !d1.check.operators.some(o => o.op === 'RegioRad') && d1.status === 'near' && d2.status === 'unchecked' && !d2.check,
    'Teilgebiet mit Zuordnung: je Anbieter jetzt gegen 100 (nahe), Tagesmaximum 120 → 1 Tag über Grenze, nur Arten der Obergrenze; ohne Zuordnung weiter nicht prüfbar');
  assert(R.capsCheck({ obergrenzen: [{ ags: '08111000', ort: 'S', type: 'scooter', jeAnbieter: 10, zonen: [{ name: 'x', jeAnbieter: 1, beobachtung: 'fehlt' }], status: 'amtlich' }] }, {}, { zoneWatch: log })[0].districts[0].status === 'unchecked', 'Zuordnung auf unbekannte Zone: nicht prüfbar');
}
// M-20: Zeitumstellung – Heatmap und Tagesgang beziehen Stunde 2 am 25.10. (120 Min.) auf 60 Min.; Stichtage in Ortszeit (Sommer +02:00)
{
  const t0 = Date.parse('2026-10-24T22:00:00Z'), t1 = Date.parse('2026-10-25T23:00:00Z');
  const runs = [], start = new Array(24).fill(0);
  for (let t = t0 + 20 * 60e3; t < t1; t += 20 * 60e3) { runs.push([t, 20 * 60e3, 1]); start[R.hourOfMs(t)] += 10; }
  const doc = { day: '2026-10-25', runs, groups: { 'X|op|scooter': { start, end: start } } };
  const hm = R.weekHeatmap([doc]), wd = R.weekdayOf('2026-10-25');
  assert([1, 2, 3].map(h => hm.cells[wd][h].mean).join() === '30,30,30', 'M-20: Heatmap am Umstellungstag 30/30/30 (vorher 30/60/30)');
  assert(R.hourMinOf(doc)[2] === 120 && R.hourMinOf({ ...doc, hourMin: new Array(24).fill(60) })[2] === 60, 'M-20: Minuten je Stunde aus dem Tagesdokument, sonst gerechnet');
  assert(R.berlinMidnight('2026-07-01') === Date.parse('2026-06-30T22:00:00Z') && R.berlinMidnight('2026-12-01') === Date.parse('2026-11-30T23:00:00Z'), 'M-20: Mitternacht Ortszeit (Sommer +02:00, Winter +01:00)');
  const e = { gesamt: 100, gesamtAb: 200, ab: '2026-07-01' };
  assert(R.capLimit(e, Date.parse('2026-06-30T22:30:00Z')).limit === 200 && R.capLimit(e, Date.parse('2026-06-30T21:30:00Z')).limit === 100, 'M-20: Stichtag im Sommer gilt ab 0 Uhr Ortszeit (vorher 1 Uhr)');
}
// M-19: Tage mit mehreren Regelständen im Bericht ausgewiesen
{
  const day = '2026-11-12', at = (h) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00Z`);
  const doc = { day, runs: [[at(8), 20 * 60e3, 1], [at(9), 20 * 60e3, 1, '2026-11-01b@abc'], [at(10), 20 * 60e3, 1, '2026-11-01b@abc']], groups: {} };
  const rp = R.municipalReport({ docs: [doc], ags: '1' });
  assert(rp.quality.mixedRuleDays.length === 1 && rp.quality.mixedRuleDays[0].day === day && rp.quality.mixedRuleDays[0].rules.length === 2, 'M-19: Tag mit altem und neuem Regelstand in quality.mixedRuleDays');
}
// Q-9/Q-24: Formel-Schutz auch hinter führenden Leerzeichen; CSV-Kopf der Städte-Rangliste übersetzt
assert(R.csvCell(' =HYPERLINK("x")') === `"' =HYPERLINK(""x"")"` && R.csvCell(' +1') === "' +1" && R.csvCell('Köln') === 'Köln', 'Q-9: führende Leerzeichen vor = + - @ werden ebenfalls entschärft');
assert(R.csvText('Flotte_Mittel', 'en') === 'Fleet_mean' && R.csvText('Flotte_Mittel', 'de') === 'Flotte_Mittel', 'Q-24: Flotte_Mittel im englischen CSV-Kopf als Fleet_mean');
// M-16: Reichweite aus dem Ladestand gerechnet → nur „Ladestand < 20 %“ (Energie, Einsatzbereitschaft, needsSwap); sonst UND-Regel
{
  const O = await import('../lib/pulse-ops.js');
  assert(R.energyLow(15, 12) === false && R.energyLow(15, 12, { rangeDerived: true }) === true && R.energyLow(25, 3, { rangeDerived: true }) === false && R.energyLow(null, 3, { rangeDerived: true }) === true, 'M-16: energyLow mit rangeDerived – Voi 15 % / 12 km niedrig, 25 % / 3 km nicht; ohne Ladestand weiter Reichweite');
  const ops = { at: 1, types: ['scooter'], ops: ['Voi', 'Dott'], munis: ['08111000'], vehicleFields: 'lat,lon,op,type,flags(1=reserviert,2=gesperrt),akku%,reichweiteKm,standzeitMin,gemeinde,reichweiteAbgeleitet',
    vehicles: [[48.7, 9.1, 0, 0, 0, 15, 12, 10, 0, 1], [48.7, 9.1, 0, 0, 0, 30, 24, 10, 0, 1], [48.7, 9.1, 1, 0, 0, 15, 12, 10, 0, 0], [48.7, 9.1, 1, 0, 0, 15, 4, 10, 0, 0]], stations: [] };
  const e = R.energyFromOps(ops, { rangeOnly: () => false }), rd = R.readinessFromOps(ops, { rangeOnly: () => false }).get('08111000');
  assert(e.get('08111000|Voi|scooter').low === 1 && e.get('08111000|Voi|scooter').rangeOnly === 0 && e.get('08111000|Dott|scooter').low === 1 && rd.ready === 2 && rd.known === 4, 'M-16: energyFromOps/readinessFromOps lesen Feld „reichweiteAbgeleitet“');
  const fl = O.decodeFleet(ops);
  assert(fl.vehicles[0].rangeDerived === true && fl.vehicles[2].rangeDerived === false && O.needsSwap(fl.vehicles[0]) && !O.needsSwap(fl.vehicles[1]) && !O.needsSwap(fl.vehicles[2]) && O.needsSwap(fl.vehicles[3]), 'M-16: decodeFleet v.rangeDerived; needsSwap Voi 15 %/12 km ja, Dott 15 %/12 km nein (UND-Regel), Dott 15 %/4 km ja');
  const old = O.decodeFleet({ ...ops, vehicles: ops.vehicles.map(v => v.slice(0, 9)) });
  assert(old.vehicles.every(v => v.rangeDerived === false) && !O.needsSwap(old.vehicles[0]), 'M-16: ältere ops-Dateien ohne Feld 10 → UND-Regel wie bisher');
}
