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
  assert(near(voi.fleetShare, 115 / 205) && rep.totals.topOp === 'Voi' && near(rep.totals.topShare, 115 / 205) && rep.totals.opCount === 3
    && rep.totals.hhi === Math.round(((115 / 205) ** 2 + (50 / 205) ** 2 + (40 / 205) ** 2) * 1e4), 'Marktanteil nach Bestand und HHI je Anbieter (0–10.000)');
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
  assert(R.MIN_COUNT === (await import('../lib/pulse-track.js')).CELL_MIN && R.suppressed(0) && R.suppressed(2) && !R.suppressed(3) && !R.suppressed(null), 'Schwelle eine Stelle (CELL_MIN = 3): 0–2 Fahrten unterdrückt, ab 3 sichtbar');
  const cs = R.cellStats({ d: { '1:1': [5, 2, 3, 0], '1:2': [2, 0, 4, 0] } }, { d: 2 });
  const rows = R.cellsCsvRows(cs, { name: 'X' });
  assert(rows[1][7] === 5 && rows[1][8] === '<3' && rows[2][7] === '<3', 'Orte-CSV: Zählungen unter 3 als „<3“');
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
  assert(st.days.length === 2 && st.pairs.length === 1 && st.pairs[0].common === 2 && near(st.pairs[0].share, 2 / 3) && near(st.pairs[0].jaccard, 2 / 4) && near(st.meanShare, 2 / 3), 'Top-N-Überlappung zwischen Tagen: gemeinsam ÷ kleinere Menge, Jaccard; Zellen < 3 Starts zählen nicht');
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
  // Ampel rot (latest.json → eventChecks, Agent M): Gruppe im Bericht nicht plausibel (Flag ampel-rot), in der Rangliste nur bei der Flotte
  const ec = { day: '2026-11-02', groups: { 'F|Dott|scooter': { level: 'bad', checks: { flags: ['pickup'] } }, 'F|nb|bike': { level: 'warn', checks: { flags: ['se'] } } } };
  const c = R.municipalReport({ docs: [doc], ags: 'F', eventChecks: ec }), cd = c.groups.find(g => g.op === 'Dott');
  const rkS = R.cityRanking([doc], {}, latest, { type: 'scooter', minFleet: 0, eventChecks: ec }).rows[0], rkB = R.cityRanking([doc], {}, latest, { type: 'bike', minFleet: 0, eventChecks: ec }).rows[0];
  assert(!cd.plausible && cd.flags.includes(R.AMPEL_RED) && R.AMPEL_RED === 'ampel-rot' && c.groups.find(g => g.op === 'nb').plausible && c.totals.excluded.join() === 'Dott|scooter' && near(c.totals.ridesDay, 960 + 480, 1e-6)
    && rkS.excluded.join() === 'Dott' && near(rkS.rvd, 9.6, 1e-6) && rkB.excluded.length === 0, 'Ampel rot: Bericht nicht plausibel (ampel-rot), Rangliste ohne die Fahrten der roten Gruppe; gelb bleibt');
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
  assert(pub.filter(z => z.ags === '08111000').length === 2 && pub.every(z => z.assumed && /^\d{8}$/.test(z.ags) && z.description?.includes('Vermutet') && z.accuracyM > 0 && (z.rest ? !z.polys.length : z.polys.every(p => p.every(r => r.length < 120)))) && watch.every(w => pub.some(z => z.id === w)) && watch.length === 2,
    'data/zonen-vermutet.json: vermutete, grob vereinfachte Teilgebiete (je Ring < 120 Punkte, Rest ohne Umriss); Stuttgart: zwei, reference.json ordnet beide zu');
  // jede Zuordnung beobachtung → Zone derselben Gemeinde; jede Zone wird genutzt
  const refWatch = ref.obergrenzen.flatMap(e => (e.zonen || []).filter(z => z.beobachtung).map(z => [e.ags, z.beobachtung]));
  assert(refWatch.length >= 15 && refWatch.every(([a, w]) => pub.some(z => z.id === w && z.ags === a)) && pub.every(z => refWatch.some(([, w]) => w === z.id)),
    `reference.json: ${refWatch.length} Teilgebiete mit vermuteter Abgrenzung, alle in data/zonen-vermutet.json mit gleicher Gemeinde, keine Zone ohne Zuordnung`);
  const inZ = (id, lon, lat) => R.zoneContains(pub.find(z => z.id === id), lon, lat);
  assert(inZ('karlsruhe-kerngebiet-1', 8.4037, 49.0094) && !inZ('karlsruhe-kerngebiet-1', 8.4044, 49.0137) && !inZ('karlsruhe-kerngebiet-1', 8.4745, 48.9995) && inZ('karlsruhe-kerngebiet-2-durlach', 8.4745, 48.9995) && !inZ('karlsruhe-kerngebiet-2-durlach', 8.4037, 49.0094),
    'Karlsruhe: Marktplatz in Kerngebiet 1, Schloss nicht; Marktplatz Durlach in Kerngebiet 2');
  assert(inZ('dresden-gebiet-1', 13.7383, 51.0505) && !inZ('dresden-gebiet-2', 13.7383, 51.0505) && inZ('dresden-gebiet-2', 13.7270, 51.0290) && !inZ('dresden-gebiet-3', 13.7270, 51.0290) && pub.find(z => z.id === 'dresden-gebiet-4')?.rest,
    'Dresden: Altmarkt in Gebiet 1 (nicht im Ring Gebiet 2), TU-Campus in Gebiet 2 (Loch des Rings Gebiet 3 ausgenommen), Gebiet 4 = Rest');
  assert(inZ('koeln-innenstadt', 6.9583, 50.9413) && !inZ('koeln-innenstadt', 6.8850, 50.9180) && inZ('berlin-innerhalb-s-bahn-ring', 13.4132, 52.5219) && !inZ('berlin-innerhalb-s-bahn-ring', 13.2000, 52.5350)
    && inZ('frankfurt-zentraler-innenstadtbereich', 8.6821, 50.1106) && inZ('mainz-innenstadt', 8.2740, 49.9990) && inZ('bremen-nord', 8.6280, 53.1700) && !inZ('bremen-nord', 8.8070, 53.0758)
    && inZ('dortmund-innenstadtbezirke-und-phoenix-see', 7.4590, 51.5178) && inZ('dortmund-innenstadtbezirke-und-phoenix-see', 7.5110, 51.4900) && inZ('duesseldorf-zone-1', 6.7800, 51.2240) && inZ('duesseldorf-zone-2', 6.7740, 51.2050) && !inZ('duesseldorf-zone-1', 6.7740, 51.2050),
    'Stichproben: Kölner Dom, Alexanderplatz, Römer, Mainzer Dom, Vegesack, Dortmund Hbf und PHOENIX See, Königsallee in Zone 1, Bilk in Zone 2 – Müngersdorf, Spandau, Bremer Marktplatz nicht');
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
// ---------- zweite Stadt: Rest-Gebiet (Düsseldorf), Anteils-Regeln (Dresden), Karlsruhe aus dem Repo ----------
{
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const D = '05111000';
  const zs = R.parseZoneWatch(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'Düsseldorf Zone 1', ags: D, vermutet: true, genauigkeit_m: 150 }, geometry: { type: 'Polygon', coordinates: [sq(6.77, 51.22, 6.79, 51.23)] } },
    { type: 'Feature', properties: { name: 'Düsseldorf Zone 2', ags: D, vermutet: true, genauigkeit_m: 200 }, geometry: { type: 'Polygon', coordinates: [sq(6.75, 51.20, 6.81, 51.25), sq(6.77, 51.22, 6.79, 51.23)] } },
    { type: 'Feature', properties: { name: 'Düsseldorf übriges Stadtgebiet', ags: D, rest: true, vermutet: true, genauigkeit_m: 200 }, geometry: null },
    { type: 'Feature', properties: { name: 'kaputt', rest: true }, geometry: null }] }));
  const rest = zs.find(z => z.id === 'duesseldorf-uebriges-stadtgebiet');
  assert(zs.length === 3 && rest?.rest && rest.polys.length === 0 && rest.bbox === null && !R.zoneContains(rest, 6.6, 51.3), 'Rest-Zone ohne Umriss mit Gemeinde gelesen; Rest ohne Gemeinde verworfen; zoneContains nie für Rest');
  const veh = [
    { lat: 51.225, lon: 6.78, operator: 'Lime', type: 'scooter', ags: D }, { lat: 51.21, lon: 6.76, operator: 'Lime', type: 'scooter', ags: D },
    { lat: 51.30, lon: 6.85, operator: 'Lime', type: 'scooter', ags: D }, { lat: 51.31, lon: 6.86, operator: 'Lime', type: 'scooter', ags: D, disabled: true },
    { lat: 51.30, lon: 6.85, operator: 'Voi', type: 'scooter', ags: '05158004' }, { lat: 51.30, lon: 6.85, operator: 'Bolt', type: 'scooter' },
  ];
  const c = R.zoneCounts(zs, veh);
  assert(c.get('duesseldorf-zone-1|Lime|scooter')?.join() === '1,1' && c.get('duesseldorf-zone-2|Lime|scooter')?.join() === '1,1' && c.get('duesseldorf-uebriges-stadtgebiet|Lime|scooter')?.join() === '2,1' && ![...c.keys()].some(k => /Voi|Bolt/.test(k)),
    'Rest = Fahrzeuge der Gemeinde außerhalb aller Umrisse der Gemeinde (Loch von Zone 2 = Zone 1); andere Gemeinde und ohne Gemeinde nicht');
  const t1 = T('2026-11-02T10:00:00');
  const log = R.zoneLogUpdate(null, zs, new Map([['duesseldorf-zone-1|Lime|scooter', [700, 690]], ['duesseldorf-zone-1|Bolt|scooter', [1200, 1200]], ['duesseldorf-uebriges-stadtgebiet|Lime|scooter', [900, 880]]]), { at: t1 });
  assert(log.zones.find(z => z.id === 'duesseldorf-uebriges-stadtgebiet')?.rest === true && !JSON.stringify(log).includes('6.77'), 'zone-watch.json: Rest-Zone gekennzeichnet, keine Koordinaten');
  const entry = { ags: D, ort: 'Düsseldorf', type: 'scooter', gesamt: 8400, zonen: [{ name: 'Zone 1', gesamt: 1800, beobachtung: 'duesseldorf-zone-1' }, { name: 'übriges Stadtgebiet', gesamt: 1700, beobachtung: 'duesseldorf-uebriges-stadtgebiet' }] };
  const amt = R.capsCheck({ obergrenzen: [{ ...entry, status: 'amtlich' }] }, {}, { zoneWatch: log, ags: D })[0], ung = R.capsCheck({ obergrenzen: [{ ...entry, status: 'ungeprüft' }] }, {}, { zoneWatch: log, ags: D })[0];
  assert(amt.districts[0].check.total === 1900 && amt.districts[0].status === 'over' && amt.districts[1].check.total === 900 && amt.districts[1].status === 'ok' && amt.districts[1].check.rest
    && ung.districts[0].status === 'info' && ung.districts[0].check.operators.every(o => o.status === 'info' && o.limit == null),
    'Düsseldorf: Zone 1 1.900 > 1.800 (über Grenze), Rest 900 ≤ 1.700; ungeprüfte Quelle: nur gezählt (Status Information)');
  // Anteile an der Flotte (Dresden Nr. 6.4): Gebiet 1 max. 30 %, Gebiet 3 mind. 25 %
  const S = '14612000';
  const dz = R.parseZoneWatch(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'Dresden Gebiet 1', ags: S, vermutet: true, genauigkeit_m: 150 }, geometry: { type: 'Polygon', coordinates: [sq(13.72, 51.04, 13.76, 51.07)] } },
    { type: 'Feature', properties: { name: 'Dresden Gebiet 3', ags: S, vermutet: true, genauigkeit_m: 150 }, geometry: { type: 'Polygon', coordinates: [sq(13.60, 50.95, 13.90, 51.15), sq(13.70, 51.02, 13.78, 51.09)] } }] }));
  const dlog = R.zoneLogUpdate(null, dz, new Map([['dresden-gebiet-1|Voi|scooter', [270, 260]], ['dresden-gebiet-1|Bolt|scooter', [230, 230]], ['dresden-gebiet-1|Dott|scooter', [100, 100]], ['dresden-gebiet-3|Voi|scooter', [300, 290]], ['dresden-gebiet-3|Bolt|scooter', [100, 100]]]), { at: t1 });
  const dref = { obergrenzen: [{ ags: S, ort: 'Dresden', type: 'scooter', gesamt: 2500, jeAnbieter: 833, jeAnbieterAbgeleitet: true, status: 'amtlich', zonen: [{ name: 'Gebiet 1', jeAnbieter: 250, jeAnbieterAbgeleitet: true, anteilMax: 0.3, beobachtung: 'dresden-gebiet-1' }, { name: 'Gebiet 3', anteilMin: 25, beobachtung: 'dresden-gebiet-3' }] }] };
  const dc = R.capsCheck(dref, { [`${S}|Voi|scooter`]: { total: 800 }, [`${S}|Bolt|scooter`]: { total: 800 }, [`${S}|Dott|scooter`]: { total: 400 } }, { zoneWatch: dlog, ags: S })[0];
  const g1 = dc.districts[0].check, g3 = dc.districts[1].check, op = (k, o) => k.operators.find(x => x.op === o);
  assert(dc.districts[0].shareMax === 0.3 && dc.districts[1].shareMin === 0.25 && op(g1, 'Voi').fleetShare === 270 / 800 && op(g1, 'Voi').shareStatus === 'over' && op(g1, 'Voi').status === 'over' && op(g1, 'Voi').countStatus === 'hint'
    && op(g1, 'Bolt').shareStatus === 'near' && op(g1, 'Dott').shareStatus === 'ok' && op(g1, 'Dott').status === 'ok' && dc.districts[0].status === 'over'
    && op(g3, 'Voi').shareStatus === 'ok' && op(g3, 'Bolt').shareStatus === 'below' && op(g3, 'Dott')?.now === 0 && op(g3, 'Dott').shareStatus === 'below' && dc.districts[1].status === 'below',
    'Dresden: Anteil je Anbieter am eigenen Bestand – Voi 34 % > 30 % (über, Zählgrenze gerechnet nur Hinweis), Bolt 29 % nahe, Dott 25 % ok; Gebiet 3 (25 als Prozent gelesen): Bolt 12,5 % und Dott ohne Fahrzeug unter Mindestanteil');
  // umfassender Umriss (Dortmund: Bezirke größer als „dicht bebaute Bereiche“): Bestand ist Obergrenze → über der Grenze nur Hinweis
  const oz = R.parseZoneWatch(JSON.stringify({ type: 'Feature', properties: { name: 'Dortmund Innenstadt', ags: '05913000', vermutet: true, umfassend: true, genauigkeit_m: 600 }, geometry: { type: 'Polygon', coordinates: [sq(7.39, 51.48, 7.53, 51.56)] } }));
  const olog = R.zoneLogUpdate(null, oz, new Map([['dortmund-innenstadt|Lime|scooter', [1353, 1300]], ['dortmund-innenstadt|Voi|scooter', [120, 120]]]), { at: t1 });
  const od = R.capsCheck({ obergrenzen: [{ ags: '05913000', ort: 'Dortmund', type: 'scooter', status: 'amtlich', zonen: [{ name: 'Innenstadtbezirke', jeAnbieter: 300, beobachtung: 'dortmund-innenstadt' }] }] }, {}, { zoneWatch: olog, ags: '05913000' })[0].districts[0];
  assert(oz[0].superset && olog.zones[0].superset && od.check.superset && od.check.operators.find(o => o.op === 'Lime').status === 'hint' && od.check.operators.find(o => o.op === 'Voi').status === 'ok' && od.status === 'hint',
    'umfassender Umriss: Lime 1.353 > 300 nur Hinweis (Bestand ist Obergrenze), Voi 120 ok');
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
// Vertrag 1/2: Regelstand je Lauf (Teil vor „@“), Regelstand-Tage; Z2: Bruchmarken bei Regelwechsel
{
  assert(R.ruleOf([1, 2, 1, '2026-11-02a@abc1234']) === '2026-11-02a' && R.ruleOf([1, 2, 1]) === null && R.ruleOf(null) === null && R.ruleOf([1, 2, 1, '']) === null, 'ruleOf: METHOD_VERSION-Teil, null für alte Läufe');
  const u = Date.parse('2026-11-01T12:51:00Z'), v = Date.parse('2026-11-01T13:13:00Z');
  assert(R.ruleEra([u, 1, 1]) !== R.ruleEra([v, 1, 1]) && R.ruleEra([v, 1, 1, 'R@1']) === 'R' && R.ruleEra([v, 1, 1, 'R@1']) === R.ruleEra([v + 1, 1, 1, 'R@2']), 'ruleEra: Wechsel am 01.11. 14:13 ohne Angabe getrennt; Commit-Teil zählt nicht');
  const d01 = { day: '2026-11-01', runs: [[u, 20 * MIN, 1], [v, 22 * MIN, 0], [v + 20 * MIN, 20 * MIN, 1]], groups: {} };
  const d02 = { day: '2026-11-02', runs: [[T('2026-11-02T07:00:00'), 20 * MIN, 1, 'R@1cf42c8'], [T('2026-11-02T08:00:00'), 20 * MIN, 1, 'R@32d451a']], groups: {} };
  const rq = R.municipalReport({ docs: [d01, d02], ags: '1' }).quality;
  assert(rq.mixedRuleDays.length === 1 && rq.mixedRuleDays[0].day === '2026-11-01', 'mixedRuleDays: 01.11. (Lime reloc → slow ohne Kennzeichnung) gemischt, 02.11. mit zwei Commits desselben Regelstands nicht');
  // drei Tage: A alter Stand (Spiegel doppelt, Flotte 200), B Wechsel um 07:00 (davor 200, danach 100), C neuer Stand (100)
  const runsOf = (day, rule = null, from = 0) => [...Array(72).keys()].map(i => T(`${day}T00:00:00`) + (i * 20 + 10) * MIN).map(at => { const h = R.hourOfMs(at); return rule && h >= from ? [at, 20 * MIN, 1, rule] : [at, 20 * MIN, 1]; });
  const grp = (f) => ({ start: new Array(24).fill(10), end: new Array(24).fill(10), vminTot: [...Array(24).keys()].map(h => f(h) * 60), vmin: [...Array(24).keys()].map(h => f(h) * 60) });
  const A = { day: '2026-11-10', runs: runsOf('2026-11-10'), groups: { '1|nb|bike': grp(() => 200), '1|v|scooter': grp(() => 50) } };
  const B = { day: '2026-11-11', runs: runsOf('2026-11-11', 'X@1', 7), groups: { '1|nb|bike': grp(h => (h < 7 ? 200 : 100)), '1|v|scooter': grp(() => 50) } };
  const Cd = { day: '2026-11-12', runs: runsOf('2026-11-12', 'X@2', 0), groups: { '1|nb|bike': grp(() => 100), '1|v|scooter': grp(() => 50) } };
  assert(R.docRule(Cd) === 'X' && R.docRule(B) === null && R.docRule(A) === null, 'docRule: einheitlicher Regelstand eines Tages, sonst null');
  const brk = { '1|nb|bike': '2026-11-11' };
  const r0 = R.municipalReport({ docs: [A, B, Cd], ags: '1', pop: 1000 }), r1 = R.municipalReport({ docs: [A, B, Cd], ags: '1', pop: 1000, breaks: brk });
  const nb0 = r0.groups.find(g => g.key === 'nb|bike'), nb1 = r1.groups.find(g => g.key === 'nb|bike'), v1 = r1.groups.find(g => g.key === 'v|scooter');
  assert(r1.quality.rule === 'X' && r1.quality.ruleFullDays === 1 && r1.quality.fullDays === 3 && r1.quality.mixedRuleDays.map(x => x.day).join() === '2026-11-11', 'Vertrag 2: q.rule = Regelstand des jüngsten gezählten Laufs, q.ruleFullDays = volle Tage nur mit ihm (gemischter Wechseltag zählt nicht)');
  assert(nb0.fleet > 140 && near(nb1.fleet, 100, 1e-9) && nb1.rides === 170 + 240 && nb1.breakDay === '2026-11-11' && nb1.breakSkipped.join() === '2026-11-10' && near(v1.fleet, 50, 1e-9) && v1.rides === 720 && !v1.breakDay,
    `Z2: Bruchmarke – Tag vor dem Bruch nicht gezählt, am Bruchtag nur Stunden ab dem Wechsel (Flotte ${nb0.fleet.toFixed(0)} → ${nb1.fleet.toFixed(0)}); andere Reihen unverändert`);
  assert(r1.quality.breaks.length === 1 && r1.quality.breaks[0].key === 'nb|bike' && r1.quality.breaks[0].day === '2026-11-11' && near(nb1.rvd, nb1.ridesDay / 100, 1e-9) && near(r1.totals.per1000Fleet, 150, 1e-6), 'Z2: quality.breaks nennt Reihe und Tag; Fahrten je Fahrzeug und Hochrechnung aus den Tagen ab dem Bruch');
  // Rangliste und Archiv-Bericht mit denselben Bruchmarken und der Ampel (bisher nur im Kommunal-Bericht)
  const lt = { municipalities: { 1: { name: 'Eins', pop: 1000 } } };
  const k0 = R.cityRanking([A, B, Cd], {}, lt, { type: 'bike', minFleet: 0 }).rows[0], k1 = R.cityRanking([A, B, Cd], {}, lt, { type: 'bike', minFleet: 0, breaks: brk }).rows[0];
  assert(k0.fleet > 140 && near(k1.fleet, nb1.fleet, 1e-9) && near(k1.ridesDay, nb1.ridesDay, 1e-9) && near(k1.rvd, nb1.rvd, 1e-9), `Z2: Rangliste mit Bruchmarken wie der Bericht (Flotte ${k0.fleet.toFixed(0)} → ${k1.fleet.toFixed(0)}, Fahrten je Rad ${k1.rvd.toFixed(2)})`);
  const arB = { '2026-11-10': { '1|nb|bike': [200, 240, 240, 0, 0, 0, 0, 0, 1440], '1|v|scooter': [50, 240, 240, 0, 0, 0, 0, 0, 1440] }, '2026-11-11': { '1|nb|bike': [130, 240, 240, 0, 0, 0, 0, 0, 1440], '1|v|scooter': [50, 240, 240, 0, 0, 0, 0, 0, 1440] }, '2026-11-12': { '1|nb|bike': [100, 240, 240, 0, 0, 0, 0, 0, 1440], '1|v|scooter': [50, 240, 240, 0, 0, 0, 0, 0, 1440] } };
  const ecV = { day: '2026-11-12', groups: { '1|v|scooter': { level: 'bad', checks: { flags: ['pickup'] } } } };
  const ar0 = R.archiveReport({ archive: arB, ags: '1', pop: 1000 }), ar1 = R.archiveReport({ archive: arB, ags: '1', pop: 1000, breaks: brk, eventChecks: ecV });
  const an1 = ar1.groups.find(g => g.key === 'nb|bike'), av1 = ar1.groups.find(g => g.key === 'v|scooter');
  assert(near(ar0.groups.find(g => g.key === 'nb|bike').fleet, 430 / 3) && near(an1.fleet, 115) && an1.rides === 480 && an1.breakDay === '2026-11-11' && an1.breakSkipped.join() === '2026-11-10' && ar1.quality.breaks[0]?.key === 'nb|bike'
    && !av1.plausible && av1.flags.includes(R.AMPEL_RED) && ar1.totals.excluded.join() === 'v|scooter' && ar0.groups.every(g => g.plausible),
    'Z2/Ampel: Archiv-Bericht ohne Tage vor dem Bruch (Ø 143 → 115, Bruchtag ganz), rote Gruppe nicht plausibel');
  const ca = R.cityRankingArchive(arB, lt, { type: 'bike', breaks: brk }).rows[0], cs = R.cityRankingArchive(arB, lt, { type: 'scooter', eventChecks: ecV }).rows[0];
  assert(near(ca.fleet, 115) && cs.rvd === null && cs.fleet === 50, 'Rangliste aus dem Archiv: Bruchmarken und Ampel rot (nur Flotte) ebenso');
  // ruleBreaks: Sprung ≥ 10 % und ≥ 5 Fahrzeuge im ersten Lauf mit neuem Regelstand
  const ts = B.runs.map(r => r[0]), cut = B.runs.findIndex(r => r[3]);
  const hB = { day: '2026-11-11', t: ts, series: { '1|nb|bike': { total: ts.map((_, i) => (i < cut ? 200 : 100)) }, '1|v|scooter': { total: ts.map(() => 50) }, '1|z|scooter': { total: ts.map((_, i) => (i < cut ? 8 : 4)) }, '1|w|bike': { total: ts.map((_, i) => (i === cut ? null : i < cut ? 60 : 40)) } } };
  const runs = B.runs.map(r => [r[0], r[3] ?? null]);
  const rb = R.ruleBreaks(runs, [hB]);
  assert(JSON.stringify(rb) === '{"1|nb|bike":"2026-11-11"}' && Object.keys(R.ruleBreaks(runs, [hB], { since: ts[cut] })).length === 0 && Object.keys(R.ruleBreaks(runs.map(r => [r[0], 'X@1']), [hB])).length === 0,
    'ruleBreaks: nur die Reihe mit Sprung (200 → 100) beim ersten Lauf mit neuem Stand; < 5 Fahrzeuge, fehlender Wert und Wechsel vor since zählen nicht; ohne Regelwechsel keine Marke');
  // rückwirkend auf dem echten Datenstand: Doppelzählung der Spiegelquellen bis 02.11. 07:17 (Köln nextbike 4.952 → 2.406)
  const RD = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.realdata');
  if (existsSync(path.join(RD, 'runs.json')) && existsSync(path.join(RD, 'history', '2026-11-02.json'))) {
    const J = (f) => JSON.parse(readFileSync(path.join(RD, f), 'utf8'));
    const hs = J('history/index.json').days.filter(d => existsSync(path.join(RD, 'history', `${d}.json`))).map(d => J(`history/${d}.json`));
    const real = R.ruleBreaks(J('runs.json').runs.map(r => [r[0], r[14] ?? null]), hs);
    assert(real['05315000|nextbike|bike'] === '2026-11-02' && real['05111000|nextbike|bike'] === '2026-11-02' && real['08311000|Yoio|scooter'] === '2026-11-02' && !real['11000000|Dott|scooter'] && !real['08111000|Lime|scooter'] && Object.values(real).every(d => d === '2026-11-02'),
      `Z2 Datenstand: Bruch am 02.11. rückwirkend erkannt (${Object.keys(real).length} Reihen, u. a. Köln/Düsseldorf nextbike, Yoio Freiburg; Dott Berlin, Lime Stuttgart ohne Bruch; Wechsel am 01.11. ohne Bestandssprung)`);
  } else console.log('übersprungen: .realdata fehlt (Z2-Datenstand-Test)');
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
// Reichweiten-Schwelle relativ zur Quelle: Reichweite < min(5 km, reichweiteSchwelleKm) – energyLow, energyFromOps, readinessFromOps wie needsSwap
{
  const O = await import('../lib/pulse-ops.js');
  assert(R.energyLow(null, 4) === true && R.energyLow(null, 4, { rangeLimit: 2.4 }) === false && R.energyLow(null, 2, { rangeLimit: 2.4 }) === true && R.energyLow(10, 4, { rangeLimit: 2.4 }) === false && R.energyLow(10, 4, { rangeLimit: 8 }) === true && R.energyLow(15, 12, { rangeDerived: true, rangeLimit: 2 }) === true,
    'energyLow: Schwelle der Quelle (4 km bei 2,4 km nicht niedrig, 2 km niedrig), min mit der eingestellten Schwelle (8 km → 5 km), UND-Regel und rangeDerived bleiben');
  const F = 'lat,lon,op,type,flags(1=reserviert,2=gesperrt),akku%,reichweiteKm,standzeitMin,gemeinde,reichweiteAbgeleitet,reichweiteSchwelleKm';
  const veh = [...Array(10)].map((_, i) => [48.78, 9.18, 0, 0, i === 9 ? 2 : 0, null, i * 0.5, 10, 0, 0, 2.4]); // Reichweite 0–4,5 km, Schwelle 2,4 km; letztes gesperrt
  const ops = { at: 1, types: ['scooter'], ops: ['Lime'], munis: ['08111000'], vehicleFields: F, vehicles: [...veh, [48.78, 9.18, 0, 0, 0, null, 3, 10, 0, 0, null]], stations: [] };
  const e = R.energyFromOps(ops).get('08111000|Lime|scooter'), rd = R.readinessFromOps(ops).get('08111000');
  const swap = O.decodeFleet(ops).vehicles.filter(v => O.needsSwap(v)).length;
  assert(e.known === 11 && e.low === 6 && e.rangeOnly === 11 && e.rangeOnlyLow === 6 && rd.okEnergy === 5 && rd.ready === 4 && swap === 6,
    `energyFromOps/readinessFromOps: Feld 11 „reichweiteSchwelleKm“ (0–2 km unter 2,4 km niedrig = 5, 3 km ohne Schwelle unter 5 km = 1 → ${e.low}; 2,5–4,5 km nicht), Disposition gleich (${swap} Tausch)`);
  const old = { ...ops, vehicleFields: F.replace(',reichweiteSchwelleKm', ''), vehicles: ops.vehicles.map(v => v.slice(0, 10)) };
  assert(R.energyFromOps(old).get('08111000|Lime|scooter').low === 11 && O.decodeFleet(old).vehicles.every(v => v.rangeLimitKm === null), 'ältere ops-Dateien ohne Feld 11 → Standardschwelle 5 km');
}
// Konstante Reichweite (Feld 12 „reichweiteKonstant“): Reichweite unbekannt – ohne Ladestand Energie unbekannt (nicht niedrig), mit Ladestand entscheidet er
{
  const O = await import('../lib/pulse-ops.js');
  assert(R.energyLow(null, 1, { rangeFlat: true }) === null && R.energyLow(10, 1, { rangeFlat: true }) === true && R.energyLow(30, 1, { rangeFlat: true }) === false && R.energyLow(null, 1) === true,
    'energyLow rangeFlat: ohne Ladestand unbekannt (statt niedrig), mit Ladestand nur dieser');
  const F = 'lat,lon,op,type,flags(1=reserviert,2=gesperrt),akku%,reichweiteKm,standzeitMin,gemeinde,reichweiteAbgeleitet,reichweiteSchwelleKm,reichweiteKonstant';
  // Zeilen wie der Sammler sie schreibt: Felder am Ende ohne Wert entfallen, explizites null nur vor einem späteren Wert
  const ops = { at: 1, types: ['ebike'], ops: ['Donkey', 'nextbike'], munis: ['09362000'], vehicleFields: F, stations: [],
    vehicles: [[49.0, 12.1, 0, 0, 0, null, 1, 10, 0, 0, null, 1], [49.0, 12.1, 0, 0, 0, null, 1, 10, 0, 0, null, 1], [49.0, 12.1, 1, 0, 0, 12, 0, 10, 0, 0, null, 1], [49.0, 12.1, 1, 0, 0, 40, 0, 10, 0, 0, null, 1], [49.0, 12.1, 1, 0, 0, null, 3, 10, 0, 0]] };
  const e = R.energyFromOps(ops, { rangeOnly: () => false }), d = e.get('09362000|Donkey|ebike'), nb = e.get('09362000|nextbike|ebike'), rd = R.readinessFromOps(ops, { rangeOnly: () => false }).get('09362000');
  const fl = O.decodeFleet(ops).vehicles;
  assert(d.known === 0 && d.low === 0 && nb.known === 3 && nb.low === 2 && rd.known === 3 && rd.okEnergy === 1 && fl.filter(v => O.needsSwap(v)).length === 2 && fl[0].rangeFlat && !fl[4].rangeFlat && O.fleetKpis(fl).batteryKnown === 3,
    'Feld 12: Donkey (1 km konstant, kein Ladestand) → Energie unbekannt, kein Tausch; nextbike 0 km konstant → Ladestand entscheidet (12 % niedrig, 40 % nicht); Zeile ohne Feld 11/12 normal (3 km niedrig)');
}
// Nur Reichweite je Anbieter: nicht mehr, sobald eine einzige Quelle keinen Ladestand meldet (02.11.2026: voi_de machte ganz Voi, Räder ohne Akku ganz nextbike dazu)
{
  const src = (id, operator, batteryNative, vehicles = 10, status = 'live') => ({ id, operator, status, counts: { vehicles, batteryNative } });
  const ro = R.rangeOnlyOperators([src('voi_de', 'Voi', 0), src('voi_bw', 'Voi', 120), src('nb-rad', 'nextbike', 0), src('nb-e', 'nextbike', 3), src('zeus', 'Zeus', 0), src('zeus2', 'Zeus', 0),
    src('alt', 'Bolt', undefined), src('tot', 'Dott', 5, 10, 'down'), src('tot2', 'Dott', 0), src('leer', 'Tier', 0, 0)]);
  assert([...ro].sort().join() === 'Dott,Lime,Zeus', 'rangeOnlyOperators: Lime immer; Zeus (keine Quelle mit Ladestand) ja; Voi/nextbike (eine Quelle mit Ladestand) nein; fehlendes batteryNative zählt als gemeldet; Ausfälle und leere Quellen zählen nicht');
}
