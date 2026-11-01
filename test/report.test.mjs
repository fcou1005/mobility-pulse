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
}

// ---------- CSV ----------
assert(R.csvCell('=1+1') === "'=1+1" && R.csvCell('+49 711') === "'+49 711" && R.csvCell('-x') === "'-x" && R.csvCell('@SUM(A1)') === "'@SUM(A1)" && R.csvCell('\tx') === "'\tx",'Formel-Injection: = + - @ und Tab am Anfang bekommen ein Apostroph');
assert(R.csvCell(-3) === '-3' && R.csvCell(1.5) === '1,5' && R.csvCell(2.345, 1) === '2,3' && R.csvCell(null) === '' && R.csvCell(NaN) === '', 'Zahlen bleiben Zahlen (Dezimalkomma), leere Werte leer');
assert(R.csvCell('a;b') === '"a;b"' && R.csvCell('Sag "Hallo"') === '"Sag ""Hallo"""' && R.csvCell('Zeile\n2') === '"Zeile\n2"', 'Trennzeichen, Anführungszeichen und Umbrüche werden gequotet');
{
  const rep = R.municipalReport({ docs: [docA], ags: '08111000', pop: 1000 });
  const rows = R.reportCsvRows(rep, { name: '=Stuttgart' });
  assert(rows.length > 2 && rows.every(r => r.length === rows[0].length) && rows[1][0] === '=Stuttgart' && R.toCsv(rows).split('\r\n')[1].startsWith("'=Stuttgart;"), 'Bericht-CSV: gleiche Spaltenzahl je Zeile, Gemeindename abgesichert');
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
    assert(caps.length === 2 && caps[0].total > 0 && caps.every(c => ['ok', 'near', 'over'].includes(c.status)), `echte Daten Obergrenzen: ${caps.map(c => `${c.ort} ${c.total}/${c.limit} ${c.status}`).join(', ')}`);
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
  // Lime meldet nur Reichweite: 95. Perzentil der Reichweiten 21…40 → 39; Schwelle ¼ = 9,75 km → alle 20 ausreichend, obwohl Ladestand 5 %
  assert(B.known === 20 && B.ready === 20, 'Anbieter nur mit Reichweite (Lime): niedrig relativ zur üblichen Reichweite, nicht über den abgeleiteten Ladestand');
  assert(R.readinessFromOps(ops, { type: 'bike' }).size === 0 && R.readinessFromOps(null).size === 0, 'Filter Art in der Einsatzbereitschaft; fehlende Datei = leer');
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
}

// ---------- Datenschutz-Schwelle ----------
{
  assert(R.suppressed(0) && R.suppressed(1) && !R.suppressed(2) && !R.suppressed(null), 'Schwelle: 0 und 1 Fahrt werden unterdrückt, ab 2 sichtbar');
  const cs = R.cellStats({ d: { '1:1': [5, 1, 3, 0], '1:2': [1, 0, 4, 0] } }, { d: 2 });
  const rows = R.cellsCsvRows(cs, { name: 'X' });
  assert(rows[1][7] === 5 && rows[1][8] === '<2' && rows[2][7] === '<2', 'Orte-CSV: Zählungen unter 2 als „<2“');
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
