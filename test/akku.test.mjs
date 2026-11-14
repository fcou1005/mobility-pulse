// S6.5 Akku-Prognose: Zeitabschnitte bis 8 Uhr, Poisson-Rest, Prognose je Fahrzeug und Zone, Lernen aus Läufen, Selbstprüfung je Nacht,
// Rückblick auf die goldenen Tage (simulierte Flotte mit bekannter Entladung und bekanntem Verbrauch je Fahrt) und die Sammler-Phase.
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as A from '../lib/pulse-akku.js';
import * as L from '../lib/pulse-akku-learn.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const near = (a, b, e) => Math.abs(a - b) <= e;
const berlin = (s) => Date.parse(s); // ISO mit Versatz

// ---------- Zeitabschnitte und Poisson ----------
{
  const a = A.slotsUntil(berlin('2026-11-14T21:00:00+01:00'));
  assert(a.target === berlin('2026-11-15T08:00:00+01:00') && near(a.slots.reduce((x, s) => x + s.h, 0), 11, 1e-9) && a.slots[0].hour === 21 && a.slots.at(-1).hour === 7, 'Abschnitte: 21 Uhr → morgen 8 Uhr = 11 Stunden, Ortsstunden 21 … 7');
  const d = A.slotsUntil(berlin('2027-03-27T21:00:00+01:00'));
  assert(d.target === berlin('2027-03-28T08:00:00+02:00') && near(d.slots.reduce((x, s) => x + s.h, 0), 10, 1e-9), 'Abschnitte: Nacht der Zeitumstellung hat 10 Stunden');
  const m = A.slotsUntil(berlin('2026-11-14T07:30:00+01:00'));
  assert(near(m.slots.reduce((x, s) => x + s.h, 0), 0.5, 1e-9) && m.slots[0].h === 0.5, 'Abschnitte: 7:30 Uhr → 8 Uhr heute (halbe Stunde)');
  assert(near(A.poissonTail(2, 1), 1 - Math.exp(-2), 1e-12) && A.poissonTail(0, 1) === 0 && A.poissonTail(3, 0) === 1 && near(A.poissonTail(2, 3), 1 - Math.exp(-2) * 5, 1e-12), 'Poisson: P(N ≥ k)');
}
// ---------- Prognose je Fahrzeug ----------
{
  const { slots } = A.slotsUntil(berlin('2026-11-14T21:00:00+01:00'));
  const g = { drain: 0.5, trip: 5, rate: new Array(24).fill(0) };
  const f = A.forecastVehicle(25, g, slots);
  assert(f.p === 1 && near(f.morning, 19.5, 1e-9) && f.cross === berlin('2026-11-15T07:00:00+01:00'), `ohne Fahrten: 25 % − 11 h × 0,5 = 19,5 % → sicher unter 20, ab 7 Uhr (${new Date(f.cross).toISOString()})`);
  const f2 = A.forecastVehicle(40, g, slots);
  assert(f2.p === 0 && f2.cross == null, 'ohne Fahrten: 40 % bleibt darüber');
  const g3 = { drain: 0.5, trip: 5, rate: new Array(24).fill(0.1) }; // 1,1 Fahrten erwartet
  const f3 = A.forecastVehicle(30, g3, slots); // Rand 30 − 5,5 − 20 = 4,5 → schon eine Fahrt reicht
  assert(near(f3.p, 1 - Math.exp(-1.1), 1e-9) && f3.p > 0.5, `mit Fahrten: P(mindestens eine Fahrt) = ${f3.p.toFixed(3)}`);
  const doc = { low: 20, targetHour: 8, groups: { 'Dott|scooter': [0.5, 5, 'gruppe', 'art', ...new Array(24).fill(0)] } };
  const veh = [
    { lat: 48.7758, lon: 9.1829, operator: 'Dott', type: 'scooter', battery: 24 }, { lat: 48.7759, lon: 9.1830, operator: 'Dott', type: 'scooter', battery: 25 },
    { lat: 48.7758, lon: 9.1829, operator: 'Dott', type: 'scooter', battery: 15 }, { lat: 48.79, lon: 9.20, operator: 'Dott', type: 'scooter', battery: 80 },
    { lat: 48.79, lon: 9.20, operator: 'Dott', type: 'scooter', battery: 22, disabled: true }, { lat: 48.79, lon: 9.20, operator: 'Voi', type: 'scooter', battery: 22 },
    { lat: 48.79, lon: 9.20, operator: 'Dott', type: 'scooter', battery: null },
  ];
  const ff = A.fleetForecast(veh, doc, berlin('2026-11-14T21:00:00+01:00'));
  assert(ff.known === 4 && ff.nowLow === 1 && ff.morning === 2 && ff.zones.length === 1 && ff.zones[0].morning === 2 && ff.zones[0].nowLow === 1, 'Bestand: gesperrt, ohne Ladestand und ohne Modell zählen nicht; Zone mit 1 jetzt + 2 bis 8 Uhr');
  const am = A.atMorning(veh, doc, berlin('2026-11-14T21:00:00+01:00'));
  assert(am[0].battery === 19 && am[0].batteryNow === 24 && am[3].battery === 75 && am[5] === veh[5], 'Tauschplanung: Ladestand um 8 Uhr statt jetzt, ohne Modell unverändert');
  assert(A.scores({ tp: 7, fp: 3, fn: 1, tn: 9 }).precision === 0.7 && A.scores({ tp: 7, fp: 3, fn: 1, tn: 9 }).recall === 7 / 8, 'Trefferquote und Abdeckung');
}
// ---------- Simulierte Flotte: lernt Entladung und Verbrauch, Selbstprüfung je Nacht ----------
// Voi mit stabilen Kennungen (bleibt bei der Fahrt im Feed), Dott mit rotierenden Kennungen und Ausblendung unter 14 %. Entladung 0,5 Punkte
// je Stunde, 5 Punkte je Fahrt, Fahrten je Fahrzeugstunde nachts 0,01, tagsüber 0,08. Voi tauscht nachts (2–5 Uhr) einen Teil der leeren Akkus.
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
function simulate(days, startIso) {
  const t0 = berlin(startIso), runs = [], step = 15 * 60e3, fleet = [];
  let id = 0; const key = () => `k${(id++).toString(36)}`;
  for (let i = 0; i < 600; i++) fleet.push({ op: i < 300 ? 'Voi' : 'Dott', key: key(), lat: 48.76 + rnd() * 0.04, lon: 9.15 + rnd() * 0.06, bat: 15 + rnd() * 85, away: 0 });
  for (let t = t0; t < t0 + days * 86400e3; t += step) {
    const h = A.clockOf(t)[0], rate = h >= 0 && h < 6 ? 0.01 : 0.08;
    for (const v of fleet) {
      v.bat -= 0.5 * step / 3600e3;
      if (v.away > 0) { v.away--; continue; }
      if (v.bat > 15 && rnd() < rate * step / 3600e3) { v.bat -= 4 + rnd() * 2; v.lat += (rnd() - 0.5) * 0.02; v.lon += (rnd() - 0.5) * 0.03; if (v.op === 'Dott') { v.away = 1; v.key = key(); } }
      if (v.op === 'Voi' && v.bat < 18 && h >= 2 && h < 5 && rnd() < 0.05) v.bat = 95 + rnd() * 5;
      if (v.bat < 3) v.bat = 95; // Betreiber lädt irgendwann
    }
    const rows = (op) => fleet.filter(v => v.op === op && v.away === 0 && !(op === 'Dott' && v.bat < 14)).map(v => [v.key, +v.lat.toFixed(5), +v.lon.toFixed(5), Math.round(v.bat), 0, 'scooter', op.toLowerCase(), null]);
    runs.push({ at: t, groups: { 'Voi|08111000': rows('Voi'), 'Dott|08111000': rows('Dott') } });
  }
  return runs;
}
{
  const runs = simulate(5, '2026-11-09T12:00:00+01:00');
  const bt = L.backtestGolden(runs);
  const ok = bt.nights.filter(n => !n.late);
  assert(bt.floors.Dott >= 13 && bt.floors.Dott <= 15 && bt.floors.Voi == null, `Untergrenze der Ausblendung erkannt (Dott ${bt.floors.Dott}, Voi keine)`);
  assert(ok.length >= 4, `Selbstprüfung: ${ok.length} Nächte geprüft`);
  assert(bt.total.precision >= 0.7, `Trefferquote über ${bt.total.nights} Nächte ${(bt.total.precision * 100).toFixed(1)} % (≥ 70 %), Abdeckung ${(bt.total.recall * 100).toFixed(1)} %, Regel „unter 25 %“ ${(bt.total.base.precision * 100).toFixed(1)} %`);
  assert(bt.total.hidden > 0 && bt.total.swapped > 0, `ausgeblendete zählen als unter 20 % (${bt.total.hidden}), getauschte zählen nicht (${bt.total.swapped})`);
  // Lernen: dieselben Läufe Schritt für Schritt
  const st = L.emptyAkkuState(); let prev = null, prevAt = null;
  for (const r of runs) {
    const cur = new Map(); for (const [g, rows] of Object.entries(r.groups)) { const op = g.split('|')[0]; for (const x of rows) cur.set(x[0], { lat: x[1], lon: x[2], bat: x[3], dis: false, res: false, missing: false, ty: 'scooter', op, ags: '08111000' }); }
    L.learnStep(st, prev, cur, { prevAt, now: r.at, floors: { Dott: 14 } }); prev = cur; prevAt = r.at;
  }
  const M = L.modelsOf(st), mv = M('08111000', 'Voi', 'scooter'), md = M('08111000', 'Dott', 'scooter');
  assert(near(mv.drain, 0.5, 0.12) && near(md.drain, 0.5, 0.12) && mv.basisDrain === 'gruppe', `Entladung gelernt (Voi ${mv.drain.toFixed(2)}, Dott ${md.drain.toFixed(2)} Punkte je Stunde; Rundung auf ganze Prozent)`);
  assert(near(mv.trip, 5.5, 1.2) && mv.basisTrip === 'gruppe' && md.basisTrip === 'art' && near(md.trip, mv.trip, 1e-9), `Verbrauch je Fahrt: Voi aus stabilen Kennungen ${mv.trip.toFixed(1)}, Dott (rotierend) übernimmt den Wert der Art`);
  assert(mv.rate[3] < 0.03 && mv.rate[14] > 0.04 && md.rate[14] > 0.04, `Fahrten je Fahrzeugstunde: nachts ${mv.rate[3].toFixed(3)}, nachmittags ${mv.rate[14].toFixed(3)} (Voi), ${md.rate[14].toFixed(3)} (Dott)`);
  const packed = L.packModel(mv);
  assert(packed.length === 28 && packed[2] === 'gruppe', 'Modell gepackt: drain, trip, Herkunft ×2, 24 Raten');
}
if (process.env.AKKU_PHASE !== "0") // ---------- Sammler-Phase: Zustand privat, Dateien je Gemeinde und Bewertung ----------
{
  const { run } = await import('../scripts/collect/28-akku.mjs');
  const DATA = await mkdtemp(path.join(tmpdir(), 'akku-data-')), TRACK_DIR = await mkdtemp(path.join(tmpdir(), 'akku-track-'));
  const runs = simulate(2, '2026-11-12T12:00:00+01:00');
  // goldene Tage (privat) für den Rückblick
  await mkdir(path.join(TRACK_DIR, 'golden'), { recursive: true });
  const byDay = {}; for (const r of runs) { const d = new Date(r.at + 3600e3).toISOString().slice(0, 10); (byDay[d] ??= []).push(JSON.stringify({ at: r.at, fields: [], groups: r.groups })); }
  for (const [d, lines] of Object.entries(byDay)) await writeFile(path.join(TRACK_DIR, 'golden', `${d}.jsonl.gz`), gzipSync(lines.join('\n') + '\n'));
  const vehiclesOf = (r) => Object.entries(r.groups).flatMap(([g, rows]) => rows.map(x => ({ operator: g.split('|')[0], rawId: x[0], lat: x[1], lon: x[2], batteryPct: x[3], disabled: false, reserved: false, type: 'scooter', ags: '08111000', sourceId: x[6] })));
  const logs = []; let prevSnap = null, prevAt = null;
  for (const r of runs.slice(-6)) {
    const vehicles = vehiclesOf(r);
    await run({ DATA, TRACK_DIR, now: r.at, log: (...m) => logs.push(m.join(' ')), dv: { vehicles }, vkey: (op, id) => `${op}:${id}`, sourceOut: [{ operator: 'Dott', batteryFloor: { hides: true, p005: 14 } }], akkuPrev: prevSnap ? { snap: prevSnap, at: prevAt } : null });
    prevSnap = L.snapFromVehicles(vehicles, (op, id) => `${op}:${id}`); prevAt = r.at;
  }
  const doc = JSON.parse(await readFile(path.join(DATA, 'akku', '08111000.json'), 'utf8'));
  const ev = JSON.parse(await readFile(path.join(DATA, 'akku', 'bewertung.json'), 'utf8'));
  assert(doc.schemaVersion === '1.0' && doc.ags === '08111000' && doc.groups['Dott|scooter']?.length === 28 && doc.zones.rows.length > 0 && doc.totals.known > 0, `akku/<AGS>.json: Modell je Anbieter|Art und ${doc.zones.rows.length} Zonen`);
  assert(!JSON.stringify(doc).includes('Dott:k') && !JSON.stringify(ev).includes('Dott:k'), 'keine Fahrzeugkennungen in den veröffentlichten Dateien');
  assert(ev.backtest && ev.backtest.nights.length >= 1 && ev.backtest.total.precision != null, `Bewertung: Rückblick auf die goldenen Tage (${ev.backtest.nights.length} Nacht, Treffer ${(ev.backtest.total.precision * 100).toFixed(0)} %)`);
  const st = JSON.parse((await import('node:zlib')).gunzipSync(await readFile(path.join(TRACK_DIR, 'akku-state.json.gz'))).toString('utf8'));
  assert(st.version === L.AKKU_STATE_V && Object.keys(st.g).length >= 1, 'Zustand privat im Track-Verzeichnis');
}
