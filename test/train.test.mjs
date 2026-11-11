// Langzeitarchiv der Trainingsdaten (lib/pulse-train.js, Audit DAT-01/07/08/09/10/11)
import * as TR from '../lib/pulse-train.js';
import { gzipSync, gunzipSync } from 'node:zlib';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };

// Ortsstunden und Archivreife
assert(TR.localHours('2026-11-10').length === 24 && TR.localHours('2026-03-29').length === 23 && TR.localHours('2026-10-25').length === 25, 'Ortsstunden: 24, Umstellung 23 bzw. 25');
assert(new Date(TR.localHours('2026-11-10')[0]).toISOString() === '2026-11-09T23:00:00.000Z' && new Date(TR.dayEndMs('2026-11-10')).toISOString() === '2026-11-10T23:00:00.000Z', 'Ortstag 10.11. = 09.11. 23 Uhr UTC bis 10.11. 23 Uhr UTC');
assert(!TR.trainReady('2026-11-10', Date.parse('2026-11-11T01:30:00Z')) && TR.trainReady('2026-11-10', Date.parse('2026-11-11T02:00:00Z')), 'archivreif erst 3 Stunden nach Tagesende');
const todo = TR.trainTodo(['2026-11-03', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-11'], new Set(['2026-11-01']), Date.parse('2026-11-11T12:00:00Z'), { n: 2 });
assert(todo.join() === '2026-10-31,2026-11-02', 'Nachholen: älteste fehlende Tage zuerst, laufender Tag nie, höchstens n je Lauf');
assert(TR.trainPath('2026-11-10') === 'train/2026/2026-11-10.json.gz', 'Pfad train/<JJJJ>/<Tag>.json.gz');

// Archivdatei aus einem kleinen Tag
const z = () => new Array(24).fill(0), at = (h, v) => { const a = z(); a[h] = v; return a; };
const day = '2026-11-10', t0 = Date.parse('2026-11-09T23:00:00Z');
const events = {
  day, version: 1, hourMin: new Array(24).fill(60), gapHours: [], srcModes: { s1: 'perTrip' },
  runs: Array.from({ length: 72 }, (_, i) => [t0 + (i + 1) * 20 * 60e3, 20 * 60e3, 1, '2026-11-02a@x']),
  groups: {
    '08416041|Voi|scooter': { start: at(17, 10), end: at(18, 9), vmin: new Array(24).fill(600.4), vminTot: new Array(24).fill(660), reloc: z(), swap: at(9, 2), pickup: z(), disOn: z(), disOff: z(), rot: z(), tripDurSum: 3600e3, tripDurN: 10 },
    '08415061|Voi|scooter': { start: at(8, 2), end: at(9, 2), vmin: new Array(24).fill(120), vminTot: new Array(24).fill(120), reloc: z(), swap: z(), pickup: z(), disOn: z(), disOff: z(), rot: z() },
    '08111000|stadtmobil|car': { start: z(), end: z(), vmin: new Array(24).fill(60), vminTot: new Array(24).fill(60), reloc: z(), swap: z(), pickup: z(), disOn: z(), disOff: z(), rot: z() },
  },
};
const history = { day, t: [t0 + 10 * 60e3, t0 + 30 * 60e3, t0 + 50 * 60e3], f: [1, 0, 1], series: { '08416041|Voi|scooter': { total: [11, 99, 13], available: [10, 99, 12], disabled: [1, 0, 1] } } };
const cell = (base) => ({ t: Array.from({ length: 24 }, (_, h) => base + h), p: z(), w: z(), s: z() });
const weather = [{ day: '2026-11-09', cells: { '48.5|9.0': cell(100) }, ags: { '08416041': '48.5|9.0' } }, { day: '2026-11-10', cells: { '48.5|9.0': cell(0) }, ags: { '08416041': '48.5|9.0' } }];
const incidents = { version: 1, day, ags: { '08416041': { road: at(16, 1), warn: at(3, 1) } } };
const curated = [{ art: 'streik-oepnv', von: '2026-11-10T05:00', bis: '2026-11-10T09:00', gebiet: { ags: ['08416041'] }, quelle: 'x' }];
const pending = [{ art: 'veranstaltung', von: '2026-11-10T19:00', bis: '2026-11-10T22:00', gebiet: { ags: ['08416041'] }, quelle: 'y', titel: 'Konzert' }, { art: 'veranstaltung', von: '2026-11-12', gebiet: 'DE', quelle: 'z' }];
const checks = { day, dayRules: ['2026-11-02a'], ruleNow: '2026-11-02a', groups: { '08416041|Voi|scooter': { level: 'ok' }, '08415061|Voi|scooter': { level: 'warn' } } };
const series = { plans: { [day]: { model: 'pooledWx', trainDays: 10 } }, days: { [day]: { DE: { p: new Array(24).fill(1.234), a: z() }, 'op:Voi': { p: new Array(24).fill(2) } } } };
const log = { evals: { [day]: { trainDays: 10 } }, live: { a: { from: Date.parse('2026-11-10T06:00:00Z'), hours: 6 }, b: { from: Date.parse('2026-11-11T06:00:00Z') } } };
const doc = TR.trainDoc({ events, history, weather, weatherFc: [], incidents, curated, pending, checks: { ...checks }, series, log, families: { car: { series: { days: { [day]: { DE: { p: [1] } } } } } }, now: Date.parse('2026-11-11T03:00:00Z') });
const K = '08416041|Voi|scooter', S = '08415061|Voi|scooter', C = '08111000|stadtmobil|car';
assert(doc.v === 1 && doc.day === day && doc.lagH === 4 && doc.f.join() === TR.TRAIN.fields.join(), 'Kopf: Version, Tag, Abstand zum Tagesende, Feldliste');
assert(TR.trainSeries(doc, K, 'start')[17] === 10 && TR.trainSeries(doc, K, 'vmin')[0] === 600 && doc.x[K][0] === 3600000 && doc.x[K][1] === 10, 'Stundenwerte ganzzahlig, Summen je Tag');
assert(TR.trainSeries(doc, S, 'start').daySum === 2 && doc.g[S][1] === 2 && Array.isArray(doc.g[S][2]) && doc.small.join() === S, 'Gruppe mit 2 Fahrtbeginnen: Beginne/Enden nur als Tagessumme, Exposition je Stunde');
assert(Array.isArray(doc.g[C][0]) && !doc.small.includes(C), 'Gruppe ohne Fahrten bleibt stündlich (nichts preiszugeben)');
assert(doc.obs.length === 24 && doc.obs.every(m => m === 60) && doc.runs.length === 72 && doc.hourMin.length === 24, 'beobachtete Minuten je Stunde und Läufe');
assert(doc.s[K][0][0] === 12 && doc.s[K][1][0] === 11 && doc.s[K][4] === null, 'Bestand je Stunde: Mittel der zählenden Läufe (f = 0 nicht), fehlendes Feld null');
assert(doc.wx.cells['48.5|9.0'][0][0] === 123 && doc.wx.cells['48.5|9.0'][0][1] === 0 && doc.wx.cells['48.5|9.0'][0][23] === 22 && doc.wx.ags['08416041'] === '48.5|9.0' && doc.wxFc === null, 'Wetter auf Ortsstunden: 0 Uhr = 23 Uhr UTC des Vortags');
assert(doc.ctx.road[K.slice(0, 8)] === (1 << 16) && doc.ctx.strike[K.slice(0, 8)] === [5, 6, 7, 8, 9].reduce((m, h) => m | (1 << h), 0) && !doc.ctx.warn, 'Kennzeichen als Bitmaske je Gemeinde (Warnung Stufe 1 zählt nicht)');
assert(doc.ctxHeld.event['08416041'] === [19, 20, 21, 22].reduce((m, h) => m | (1 << h), 0) && !doc.ctx.event && doc.ctxSrc.length === 2 && doc.ctxSrc.find(e => !e.aktiv).titel === 'Konzert', 'zurückgehaltene Veranstaltung getrennt (ctxHeld), Quellen des Tages mit aktiv');
assert(TR.maskHours(doc.ctx.road['08416041'])[16] === 1 && TR.maskHours(doc.ctx.road['08416041']).reduce((a, b) => a + b) === 1, 'Bitmaske lesen');
assert(doc.checks.level[S] === 'warn' && !doc.checks.level[K] && doc.checks.n === 2 && TR.trainDoc({ events, checks: { ...checks, day: '2026-11-09' } }).checks === null, 'Ampel nur für denselben Tag, nur auffällige Gruppen');
assert(doc.fc.plan.DE[0] === 1.2 && doc.fc.meta.model === 'pooledWx' && doc.fc.eval.trainDays === 10 && doc.fc.live.length === 1 && doc.fcFam.car.plan.DE[0] === 1, 'Prognose: eingefrorener Plan, Modell, Selbstprüfung, Live-Abgleich des Tages, Familien');
assert(['BW', 'BY', 'BE'].every(l => doc.dayType[l] === 'W') && TR.trainDoc({ events: { ...events, day: '2026-11-08' } }).dayType.BW === 'H', 'Tagtyp je Land (Sonntag = H)');
const back = JSON.parse(gunzipSync(gzipSync(JSON.stringify(doc))).toString());
assert(back.g[K][0][17] === 10 && TR.trainDoc({ events: null }) === null, 'gzip-Rundweg; ohne Ereignisse keine Datei');
assert(TR.isForecastDoc({ day: '2026-11-12', generatedAt: '2026-11-11T20:00:00Z' }) && !TR.isForecastDoc({ day: '2026-11-11', generatedAt: '2026-11-11T20:00:00Z' }), 'Vorhersage-Datei erkennen (vor Tagesbeginn geschrieben)');

// Zellen als Wochensumme (DAT-02)
assert(TR.isoWeek('2026-11-10').key === '2026-W46' && TR.isoWeek('2026-11-01').key === '2026-W44' && TR.isoWeek('2026-11-01').from === '2026-10-26' && TR.isoWeek('2027-01-01').key === '2026-W53' && TR.isoWeek('2026-01-01').key === '2026-W01', 'ISO-Woche (Montag bis Sonntag, Jahreswechsel)');
const wt = TR.cellsWeekTodo(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-08', '2026-11-09'], new Set(), Date.parse('2026-11-09T08:00:00Z'));
assert(wt.map(w => w.key).join() === '2026-W44,2026-W45' && wt[0].days.join() === '2026-10-31,2026-11-01' && TR.cellsWeekTodo(['2026-11-02', '2026-11-08'], new Set(), Date.parse('2026-11-09T05:00:00Z')).length === 0, 'Wochen erst 8 Stunden nach Sonntagsende; Teilwoche am Beginn mit ihren Tagen');
const cw = TR.cellsWeekDoc(TR.isoWeek('2026-11-01'), [
  { day: '2026-10-31', state: 'BW', fields: 'f', bandMin: [60, 30], bandRuns: [3, 2], munis: { '08416041': { 'a:b': [1, 2, 3], 'c:d': new Array(22).fill(1) } }, below: { '08416041': [1, 0, 2] } },
  { day: '2026-11-01', state: 'BW', bandMin: [60.04, 30], bandRuns: [3, 1], munis: { '08416041': { 'a:b': new Array(22).fill(2) } }, below: { '08416041': [0, 1] } },
  { day: '2026-11-01', state: 'BY', bandMin: [1], bandRuns: [1], munis: { '09162000': { 'x:y': [5] } } }]);
const bw = cw.states.BW;
assert(cw.week === '2026-W44' && cw.days.join() === '2026-10-31,2026-11-01' && bw.munis['08416041']['a:b'][0] === 3 && bw.munis['08416041']['a:b'][21] === 2 && bw.munis['08416041']['c:d'][5] === 1 && bw.bandMin[0] === 120 && bw.bandRuns.join() === '6,3' && bw.below['08416041'].join() === '1,1,2' && cw.states.BY.munis['09162000']['x:y'][0] === 5 && TR.cellsWeekPath(cw.week) === 'train-cells/2026/2026-W44.json.gz',
  'Wochensumme je Land: Zellen elementweise (kurze Altzeilen aufgefüllt), Reste, Bandminuten und -läufe');

// Eingriffe der Anbieter und Ausfälle (Preis, Zone, Flottensprung, Ausfall)
{
  const day = '2026-11-10', at = Date.parse('2026-11-10T09:00:00Z'), z24 = () => new Array(24).fill(0);
  const runs = Array.from({ length: 72 }, (_, i) => [Date.parse('2026-11-09T23:00:00Z') + (i + 1) * 20 * 60e3, 20 * 60e3, 1, 'x']);
  const vt = new Array(24).fill(100 * 60); vt[14] = 0; vt[15] = 3 * 60;
  const events = { day, runs, groups: { 'A|Voi|scooter': { start: z24(), vminTot: vt }, 'A|Tiny|bike': { start: z24(), vminTot: new Array(24).fill(5 * 60).map((v, h) => (h === 3 ? 0 : v)) } } };
  const archive = { fields: ['flotte_avg', 'fahrten'], days: { '2026-11-06': { 'A|Voi|scooter': [100, 0], 'A|Lime|scooter': [200, 0] }, '2026-11-07': { 'A|Voi|scooter': [102, 0], 'A|Lime|scooter': [205, 0] }, '2026-11-08': { 'A|Voi|scooter': [98, 0], 'A|Lime|scooter': [198, 0] }, '2026-11-09': { 'A|Voi|scooter': [101, 0], 'A|Lime|scooter': [200, 0] }, [day]: { 'A|Voi|scooter': [104, 0], 'A|Lime|scooter': [300, 0] } } };
  const price = [[at, 'voi_a', 'Voi', 'p1', '~unlock', 0.5, 1], [at, 'voi_a', 'Voi', 'p2', '+plan', null, 'x'], [Date.parse('2026-11-08T09:00:00Z'), 'voi_a', 'Voi', 'p1', '~rate', 1, 2]];
  const zones = [[at, 'lime_a', 'Lime', 3, 1, 40]];
  const sig = TR.opsSignals({ day, events, archive, price, zones, srcMunis: new Map([['voi_a', ['A']], ['lime_a', ['A', 'B']]]) });
  const k = (kind) => sig.filter(e => e.kind === kind);
  assert(k('price').length === 1 && k('price')[0].n === 2 && k('price')[0].munis.join() === 'A' && k('price')[0].plans.join() === 'p1,p2', 'Preisänderung: je Quelle und Tag eine Zeile mit Gemeinden und Plänen; Vortag nicht');
  assert(k('zone')[0].added === 3 && k('zone')[0].removed === 1 && k('zone')[0].munis.join() === 'A,B', 'Zonenänderung aus zones-log');
  assert(k('fleet').length === 1 && k('fleet')[0].key === 'A|Lime|scooter' && k('fleet')[0].ratio === 1.5, 'Flottensprung: Lime 200 → 300 (+50 %), Voi +3 % nicht');
  const o = k('outage'); assert(o.length === 1 && o[0].key === 'A|Voi|scooter' && o[0].hours === 2 && o[0].mask === ((1 << 14) | (1 << 15)), 'Ausfall: Voi 14–16 Uhr ohne Fahrzeuge; kleine Gruppe (< 20) nicht');
  const m1 = TR.mergeOps(null, sig, Date.parse('2026-11-11T12:00:00Z')), m2 = TR.mergeOps(m1, sig, Date.parse('2026-11-11T12:00:00Z')), m3 = TR.mergeOps(m2, [], Date.parse('2027-04-01T12:00:00Z'));
  assert(m1.entries.length === sig.length && m2.entries.length === sig.length && m3.entries.length === 0, 'eingriffe.json: doppelt eingetragen bleibt einmal, nach keepDays gelöscht');
  const zh = (c, r) => TR.zoneHash({ geometry: { coordinates: c }, properties: { rules: r } }), a = zh([[1, 2]], [{ rideAllowed: false }]), b = zh([[1, 2]], [{ rideAllowed: true }]);
  assert(a !== b && TR.zoneDiff(new Set([a]), [a, b]).added === 1 && TR.zoneDiff(new Set([a, b]), [b]).removed === 1, 'Zonen-Fingerabdruck: Regeländerung zählt als geändert');
}
// anteilige Stundenwerte (MET-01b) im Archiv
{
  const z = () => new Array(24).fill(0), sp = z(); sp[9] = 6; sp[10] = 2; const vp = z(); vp[9] = 1500.4;
  const ev = { day: '2026-11-10', runs: [], obsP: z().map((_, h) => (h === 9 ? 15 : 0)), pVersion: 1, groups: { 'A|Voi|scooter': { start: z(), startP: sp, vminP: vp }, 'B|X|bike': { start: [2, ...z().slice(1)], startP: [1.5, 0.5, ...z().slice(2)] } } };
  const d = TR.trainDoc({ events: ev });
  assert(d.pf.join() === 'startP,vminP' && d.gp['A|Voi|scooter'][0][9] === 6 && d.gp['A|Voi|scooter'][1][9] === 1500 && d.gp['B|X|bike'][0] === 2 && d.obsP[9] === 15 && !('gp' in TR.trainDoc({ events: { day: '2026-11-10', groups: {} } })),
    'Archiv: startP/vminP je Gruppe (kleine Gruppe nur Tagessumme), obsP; ohne Zusatzfelder kein gp');
}
