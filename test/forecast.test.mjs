import * as F from '../lib/pulse-forecast.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };

// ---------- deterministische Zufallszahlen und Poisson
let seed = 20261104; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const norm = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const pois = (l) => { if (l <= 0) return 0; if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * norm())); let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rnd(); } while (p > L); return k - 1; };

// ---------- kleine Bausteine
assert(JSON.stringify(F.wxFeatures(0, 0)) === JSON.stringify([-1, 0, 0, 0, 0, 0]) && JSON.stringify(F.wxFeatures(20, 1.2)) === JSON.stringify([0, 1, 1, 1, 0, 0]) && JSON.stringify(F.wxFeatures(10, 5, 0.2)) === JSON.stringify([0, 0, 1, 1, 1, 1]) && F.wxFeatures(null, 0) === null, 'Wettermerkmale: kalt/warm mit Knick bei 10 °C, Regen ab 0,1 mm/h, ohne Messwert null');
assert(F.localToUtcMs('2026-11-04', 0) === Date.parse('2026-11-03T23:00:00Z') && F.localToUtcMs('2026-07-01', 12) === Date.parse('2026-07-01T10:00:00Z'), 'Ortszeit → UTC: Winterzeit +1, Sommerzeit +2');
{
  const d = [{ rule: 'a' }, { rule: 'a' }, { rule: 'b' }, { rule: 'b' }, { rule: 'c' }]; F.assignEras(d);
  assert(d.map(x => x.era).join() === '2,2,1,1,0', 'Regelstände: der jüngste ist Era 0, ältere zählen hoch');
}
{
  const cal = { from: '2026-01-01', to: '2026-12-31', states: { BW: { '2026-11-03': 'F' }, BY: {} } };
  const d = F.dayFromDoc({ day: '2026-11-03', runs: [], groups: {} }, cal);
  assert(d.cls('08416041') === 1 && d.cls('09162000') === 0, 'Tagtyp je Gemeinde aus dem Land (AGS-Vorsilbe): BW Ferienwerktag, BY Werktag');
}

// ---------- synthetische Welt: bekannte Wahrheit, damit Lernen prüfbar wird
const OPS = ['Voi', 'Lime', 'Bolt', 'Dott', 'nextbike'], AGS = ['08416041', '09162000', '11000000', '05315000', '06412000', '14612000'];
const groups = []; // [key, Flottengröße, Niveau]
for (const a of AGS) for (const o of OPS) groups.push([`${a}|${o}|${o === 'nextbike' ? 'bike' : 'scooter'}`, 0.4 + 40 * rnd() ** 2, 0.15 + 0.5 * rnd()]); // viele kleine, wenige große Gruppen
const shape = (h, we) => (we ? 0.2 + 1.3 * Math.exp(-((h - 15) ** 2) / 30) : 0.2 + 1.0 * Math.exp(-((h - 8) ** 2) / 4) + 1.2 * Math.exp(-((h - 17.5) ** 2) / 6));
const wd = (day) => new Date(`${day}T12:00:00Z`).getUTCDay(), isWe = (day) => wd(day) === 0 || wd(day) === 6;
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const TRUE = { cold: 0.3, warm: 0.2, rain: -0.5 };
const wxOf = (day, h) => { const di = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse('2026-10-26T12:00:00Z')) / 86400e3); const t = 5 + 5 * Math.sin(di * 1.3) + 4 * Math.sin(((h - 15) / 24) * 2 * Math.PI), p = di % 3 === 0 && h >= 8 && h <= 18 ? 1.0 : 0; return [t, p]; };
const trueMu = (g, day, h, level = 1) => { const [t, p] = wxOf(day, h), f = F.wxFeatures(t, p); return g[1] * g[2] * shape(h, isWe(day)) * level * Math.exp(TRUE.cold * f[0] + TRUE.warm * f[1] + TRUE.rain * f[2]); };
function makeDoc(day, { rule = 'M1@abc', level = 1, skipHours = [] } = {}) {
  const runs = []; for (let h = 0; h < 24; h++) { if (skipHours.includes(h)) continue; const t = F.localToUtcMs(day, h); for (let k = 1; k <= 4; k++) runs.push([t + k * 900e3 - (h === 23 && k === 4 ? 1 : 0), 900e3, 1, rule]); } // Fenster genau in der Stunde h (anteilig, S1.1)
  const gr = {}; for (const g of groups) { const start = [], vmin = []; for (let h = 0; h < 24; h++) { start.push(skipHours.includes(h) ? 0 : pois(trueMu(g, day, h, level))); vmin.push(skipHours.includes(h) ? 0 : g[1] * 60); } gr[g[0]] = { start, vmin }; }
  return { day, runs, groups: gr, gapHours: [], published: { complete: true } };
}
const weatherDocs = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) { const cells = { '48.5|9.0': { t: [], p: [] } }; for (let u = 0; u < 24; u++) { const loc = F.localToUtcMs(d, 0); void loc; } out.push({ day: d, source: 'test', cells, ags: Object.fromEntries(AGS.map(a => [a, '48.5|9.0'])) }); } return out; };
// Wetterdokumente nach UTC-Tagen: Wert der Stunde = wxOf(Ortszeit der Stunde)
function wxDocs(from, to) {
  const docs = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const t = [], p = [];
    for (let u = 0; u < 24; u++) { const ms = Date.parse(`${d}T${String(u).padStart(2, '0')}:00:00Z`), loc = new Date(ms + 3600e3).toISOString(); const [tt, pp] = wxOf(loc.slice(0, 10), +loc.slice(11, 13)); t.push(tt); p.push(pp); }
    docs.push({ day: d, source: 'test', cells: { '48.5|9.0': { t, p } }, ags: Object.fromEntries(AGS.map(a => [a, '48.5|9.0'])) });
  }
  return docs;
}
void weatherDocs;
const DAY0 = '2026-10-26', NDAY = 12, days12 = Array.from({ length: NDAY }, (_, i) => addDays(DAY0, i));
const docs = days12.map(d => makeDoc(d)), WX = wxDocs(addDays(DAY0, -1), addDays(DAY0, NDAY + 2));

// ---------- Pooling schlägt je Gruppe getrennte Profile bei dünnen Gruppen
{
  // Prüftag Montag 02.11. (Training Di–So): seit S2.5 teilen Samstag und Sonntag den Wochenend-Tagesgang – ein Sonntag als Prüftag maß hier vor allem
  // das Wetter zwischen Samstag und Sonntag (das Modell ohne Wetter kann es nicht kennen)
  const ds = F.assignEras(docs.slice(1, 8).map(d => F.dayFromDoc(d, null))), R = F.buildRows(ds);
  const train = [], test = []; for (let i = 0; i < R.n; i++) (R.day[i] < 6 ? train : test).push(i);
  const m = F.fitPooled(R, train, { weather: false }), a = F.scoreDay(R, test, F.predictPooled(m, R, test), m.phi), b = F.scoreDay(R, test, F.predictProfile(R, train, test));
  assert(a.wapeGH < b.wapeGH, `Pooling: Fehler je Gruppe-Stunde ${(a.wapeGH * 100).toFixed(0)} % < ${(b.wapeGH * 100).toFixed(0)} % je Gruppe getrennt (nur ${6} Trainingstage, viele kleine Gruppen)`);
  // Verzerrung über mehrere Prüftage (das Modell ohne Wetter sieht die Tag-zu-Tag-Schwankung des Wetters der synthetischen Welt nicht; ein einzelner
  // Prüftag lag je nach Wetter bei −14 bis +14 %), jeweils mit allen Tagen davor trainiert
  { const dz = F.assignEras(docs.slice(0, 11).map(d => F.dayFromDoc(d, null))), RZ = F.buildRows(dz); let sb = 0, nb = 0;
    for (const td of [6, 7, 8, 9, 10]) { const tr = [], te = []; for (let i = 0; i < RZ.n; i++) { if (RZ.day[i] < td) tr.push(i); else if (RZ.day[i] === td) te.push(i); }
      const mm = F.fitPooled(RZ, tr, { weather: false }); sb += F.scoreDay(RZ, te, F.predictPooled(mm, RZ, te), mm.phi).bias; nb++; }
    assert(Math.abs(sb / nb) < 0.08, `Pooling: Verzerrung der Summe über 5 Prüftage klein (${(sb / nb * 100).toFixed(1)} %; Tag 02.11.: ${(a.bias * 100).toFixed(1)} %)`); }
  assert(a.cover80 > 0.65, `80-%-Band deckt ${(a.cover80 * 100).toFixed(0)} % der Gruppe-Stunden`);
}

// ---------- Wettereffekt wird wiedergefunden
{
  const ds = F.assignEras(docs.map(d => F.dayFromDoc(d, null))), R = F.buildRows(ds, F.wxLookup(WX)), all = Array.from({ length: R.n }, (_, i) => i);
  const m = F.fitPooled(R, all, { weather: true }), e = F.wxEffects(m);
  // A13: die synthetische Welt regnet immer mit genau 1 mm/h – Stufe „≥ 0,1“ und „≥ 1“ fallen zusammen, zählt also ihre Summe
  assert(Math.abs(e.cold - TRUE.cold) < 0.1 && Math.abs(e.warm - TRUE.warm) < 0.1 && Math.abs(Math.log(e.rain) + Math.log(e.rain1) - TRUE.rain) < 0.1 && Math.abs(Math.log(e.rain4)) < 0.05 && Math.abs(Math.log(e.rainPrev)) < 0.1,
    `Wetterwirkung gelernt: kalt ${e.cold.toFixed(2)} (0,3), warm ${e.warm.toFixed(2)} (0,2), Regen bei 1 mm/h ×${(e.rain * e.rain1).toFixed(2)} (×${Math.exp(TRUE.rain).toFixed(2)}), Vorstunde ×${e.rainPrev.toFixed(2)} (×1)`);
  const g = F.weatherGate(R, all);
  assert(g.ok && g.tempRangeK >= 5 && g.rainDays >= 2 && g.dryDays >= 2, `Wetter-Gate offen bei ${NDAY} Tagen mit Spanne ${g.tempRangeK} K, ${g.rainDays} Regen- und ${g.dryDays} Trockentagen`);
  const R1 = F.buildRows(ds.slice(0, 1), F.wxLookup(WX)), g1 = F.weatherGate(R1, Array.from({ length: R1.n }, (_, i) => i));
  assert(!g1.ok, 'Wetter-Gate zu bei einem Tag (keine Spanne, kein Regentag-Vergleich)');
  const gNo = F.weatherGate(R, all.filter(() => false).concat(all.slice(0, 50)));
  assert(!gNo.ok, 'Wetter-Gate zu bei wenigen Zeilen ohne Variation');
  const Rn = F.buildRows(ds, () => null), gm = F.weatherGate(Rn, Array.from({ length: Rn.n }, (_, i) => i));
  assert(!gm.ok && gm.missingShare === 1, 'Wetter-Gate zu ohne Wetterdaten (alle Zeilen ohne Wetter)');
}

// ---------- Regression: Temperaturspanne im Gate (Kalt-Merkmal ist negativ kodiert, t = 10 + 10·(kalt + warm)); echte Daten 03./04.11. zeigten Spanne 0
{
  const dd = F.assignEras(docs.slice(0, 2).map(d => F.dayFromDoc(d, null)));
  const mk = (day, tt) => ({ day, source: 'test', cells: { '48.5|9.0': { t: Array(24).fill(tt), p: Array(24).fill(0) } }, ags: Object.fromEntries(AGS.map(a => [a, '48.5|9.0'])) });
  const W2 = [mk(addDays(DAY0, -1), 2), mk(DAY0, 2), mk(addDays(DAY0, 1), 18), mk(addDays(DAY0, 2), 18)];
  const R2 = F.buildRows(dd, F.wxLookup(W2)), g2 = F.weatherGate(R2, Array.from({ length: R2.n }, (_, i) => i));
  assert(g2.tempRangeK >= 13 && g2.tempRangeK <= 17, `Wetter-Gate: Spanne 2 °C gegen 18 °C ≈ 15 K (nicht 0 durch Spiegelung um 10 °C): ${g2.tempRangeK} K`);
}

// ---------- Stunden ohne Trainingsdaten dürfen die Prognose nicht aufblähen (Regression: Nachtlücke früher Tage → Rate 1 je Fahrzeugstunde)
{
  const early = [makeDoc(addDays(DAY0, 0), { skipHours: [1, 2, 3, 4, 5, 6, 7, 8] }), makeDoc(addDays(DAY0, 1), { skipHours: [1, 2, 3, 4, 5, 6, 7, 8] }), makeDoc(addDays(DAY0, 2))];
  const ds = F.assignEras(early.map(d => F.dayFromDoc(d, null))), R = F.buildRows(ds), train = [], test = []; for (let i = 0; i < R.n; i++) (R.day[i] < 2 ? train : test).push(i);
  const m = F.fitPooled(R, train, { weather: false }), mu = F.predictPooled(m, R, test); let sy = 0, sm = 0; test.forEach((i, j) => { if (R.hr[i] >= 1 && R.hr[i] <= 8) { sy += R.y[i]; sm += mu[j]; } });
  assert(sm < 4 * sy && sm > 0.1 * sy && test.every((_, j) => Number.isFinite(mu[j])), `Nachtstunden ohne Training: Prognose ${Math.round(sm)} gegen real ${sy} (nicht um Größenordnungen daneben)`);
}

// ---------- Modellwahl
{
  const ev = (o) => Object.fromEntries(Object.entries(o).map(([d, m]) => [d, { models: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { wapeGD: v }])) }]));
  const mk = (n, f) => ev(Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-11-${String(i + 1).padStart(2, '0')}`, f(i)])));
  assert(F.chooseModel(mk(2, () => ({ profile: 0.3, pooled: 0.2 })), { trainDays: 4 }).status === 'learning', 'Modellwahl: unter 3 ausgewerteten Tagen bleibt es „lernt“');
  assert(F.chooseModel(mk(2, () => ({ profile: 0.3, pooled: 0.2 })), { trainDays: 4 }).active === 'pooled' && F.chooseModel({}, { trainDays: 1 }).active === null, 'Modellwahl: vorläufig pooled; unter 2 Trainingstagen keins');
  const a = F.chooseModel(mk(4, () => ({ profile: 0.3, pooled: 0.2 })), { trainDays: 8 });
  assert(a.status === 'active' && a.active === 'pooled', 'Modellwahl: pooled besser → pooled');
  assert(F.chooseModel(mk(4, () => ({ profile: 0.15, pooled: 0.2 })), { trainDays: 8 }).active === 'profile', 'Modellwahl: Profil besser → profile (das gepoolte Modell gewinnt nicht automatisch)');
  assert(F.chooseModel(mk(4, () => ({ profile: 0.3, pooled: 0.2, pooledWx: 0.15 })), { trainDays: 8 }).active === 'pooledWx', 'Modellwahl: Wetter ≥ 3 % besser → pooledWx');
  assert(F.chooseModel(mk(4, () => ({ profile: 0.3, pooled: 0.2, pooledWx: 0.198 })), { trainDays: 8 }).active === 'pooled', 'Modellwahl: Wetter nur 1 % besser → bleibt pooled (kein Überlernen)');
  const w = F.chooseModel(mk(10, (i) => (i < 6 ? { profile: 0.1, pooled: 0.4 } : { profile: 0.5, pooled: 0.2 })), { trainDays: 12 });
  assert(w.active === 'pooled' && w.evalDays === F.GATES.evalWindow, `Modellwahl: nur die letzten ${F.GATES.evalWindow} Tage zählen (alte Phase zählt nicht mehr)`);
}

// ---------- Lernen aus den eigenen Fehlern: Gewichte je Gruppe, Verblassen, kein Vorgriff, Wahl nur bei messbarem Gewinn
{
  // Lernstand von Hand: A trifft mit dem eigenen Profil (10 % Fehler, gepoolt 40 %), B umgekehrt, C hat kaum Daten
  const R = { keys: ['A', 'B', 'C'], g: Int32Array.from([0, 1, 2]), y: Float64Array.from([1000, 1000, 3]) };
  const fb = F.feedbackUpdate(F.emptyFeedback(), '2026-11-01', R, [0, 1, 2], Float64Array.from([1100, 600, 9]), Float64Array.from([600, 1100, 3]));
  const W = F.feedbackWeights(fb), wA = W.of('A').w, wB = W.of('B').w, wC = W.of('C').w;
  assert(wA > 0.85 && wB < 0.15, `Gewicht je Gruppe aus der eigenen Trefferbilanz: A ${wA.toFixed(2)} eigenes Profil, B ${wB.toFixed(2)} (lernt von allen)`);
  assert(Math.abs(wC - W.w0) < Math.abs(wA - W.w0) && W.of('D').w === W.w0, `Wenig eigene Erfahrung → nahe am Gesamtgewicht (C ${wC.toFixed(2)}, gesamt ${W.w0.toFixed(2)}); unbekannte Gruppe = Gesamtgewicht`);
  const mu = F.predictAdaptive(Float64Array.from([10, NaN]), Float64Array.from([20, 30]), (j) => ['A', 'A'][j], W);
  assert(Math.abs(mu[0] - (wA * 10 + (1 - wA) * 20)) < 1e-9 && mu[1] === 30, 'Mischung aus eigenem Profil und gepooltem Modell; ohne eigene Historie nur gepoolt');
  F.feedbackUpdate(fb, '2026-11-08', R, [], [], []);
  assert(Math.abs(fb.groups.A[0] - 500) < 1e-6 && fb.upto === '2026-11-08' && fb.days > 1.4 && fb.days < 1.6, `Verblassen: nach ${F.FEEDBACK.halfLifeDays} Tagen zählt ein Tag halb (A: ${fb.groups.A[0]} Starts)`);
  const c = F.compactFeedback(fb);
  assert(c.v === F.FEEDBACK.v && JSON.stringify(F.compactFeedback(c)) === JSON.stringify(c), 'Lernstand für log.json gerundet und beim erneuten Runden stabil');
}
{
  // kein Vorgriff: ein Tag, den der Lernstand schon kennt, wird nicht mit ihm bewertet
  const ds = F.assignEras(docs.slice(0, 6).map(d => F.dayFromDoc(d, null))), R = F.buildRows(ds), name = (i) => ds[i].day;
  const known = { ...F.emptyFeedback(), upto: ds[4].day }, e1 = F.evaluateDays(R, [4], { fb: known, dayName: name });
  const fresh = { ...F.emptyFeedback(), upto: ds[3].day }, e2 = F.evaluateDays(R, [4], { fb: fresh, dayName: name });
  assert(!e1[4].models.adaptive && e2[4].models.adaptive && fresh.upto === ds[4].day && Object.keys(fresh.groups).length > 0, 'Kein Vorgriff: bewertet wird nur mit Lernstand aus früheren Tagen, danach wird der Tag übernommen');
}
{
  const ev = (o) => Object.fromEntries(Object.entries(o).map(([d, m]) => [d, { models: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { wapeGD: v, wapeGH: v }])) }]));
  const mk = (n, f) => ev(Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-11-${String(i + 1).padStart(2, '0')}`, f(i)])));
  assert(F.chooseModel(mk(4, () => ({ profile: 0.3, pooled: 0.2, adaptive: 0.19 })), { trainDays: 8 }).active === 'adaptive', 'Modellwahl: lernendes Modell 5 % besser → adaptive');
  assert(F.chooseModel(mk(4, () => ({ profile: 0.3, pooled: 0.2, adaptive: 0.198 })), { trainDays: 8 }).active === 'pooled', 'Modellwahl: lernendes Modell nur 1 % besser → bleibt pooled (kein Überlernen)');
  assert(F.chooseModel(mk(4, (i) => (i < 2 ? { profile: 0.3, pooled: 0.2 } : { profile: 0.3, pooled: 0.2, adaptive: 0.1 })), { trainDays: 8 }).active === 'pooled', 'Modellwahl: lernendes Modell erst nach 3 eigenen Tagen wählbar');
  assert(F.chooseModel(mk(4, () => ({ profile: 0.3, pooled: 0.2, adaptive: 0.1 })), { trainDays: 8, without: ['adaptive'] }).active === 'pooled', 'Modellwahl ohne lernendes Modell (rückwirkende Pläne)');
  const s = F.scoreOf({ wapeGD: 0.1, wapeGH: 0.3 }), s1 = F.scoreOf({ wapeGD: 0.1 });
  assert(Math.abs(s - 0.2) < 1e-12 && s1 === 0.1, 'Wertung = Mittel aus Tagessumme und Stundenverlauf je Gruppe (ohne Stundenwert: Tageswert)');
}
{
  // (Abstand 0,15: seit Art × Stunde lernt das gepoolte Modell einen Teil des Sondergangs mit, die Sondergruppen brauchen ihr Profil etwas weniger)
  // Welt mit vier mittelgroßen Gruppen mit eigenem Tagesgang (Spitze am späten Abend), den das gepoolte Modell nicht kennt: diese Gruppen sollen sich
  // auf ihr eigenes Profil stützen, die vielen kleinen auf alle; das lernende Modell soll damit besser sein als beide Ausgangsmodelle
  const special = new Set([...groups].sort((a, b) => b[1] * b[2] - a[1] * a[2]).slice(6, 10).map(g => g[0])), own = (h) => 0.25 + 1.8 * Math.exp(-((h - 22) ** 2) / 5);
  const mk = (day) => { const d = makeDoc(day); for (const g of groups) if (special.has(g[0])) d.groups[g[0]].start = d.groups[g[0]].start.map((_, h) => pois(g[1] * g[2] * own(h))); return d; };
  const ds = days12.map(mk), NOW = Date.parse(`${addDays(DAY0, NDAY)}T10:00:00Z`);
  const r = F.runForecast({ docs: ds, calendar: null, weather: [], prevLog: null, now: NOW }), W = F.feedbackWeights(r.log.feedback);
  { // zurückgehaltene Einträge (Lernphase) nur gezählt: gleiche Prognose, Unterstützung pending je Merkmal
    const ag = String(ds[ds.length - 2].groups && Object.keys(ds[ds.length - 2].groups)[0]).split('|')[0], d1 = ds[ds.length - 2].day;
    const rP = F.runForecast({ docs: ds, calendar: null, weather: [], prevLog: null, now: NOW, pending: [{ art: 'sport', von: `${d1}T17:00`, bis: `${d1}T21:30`, gebiet: { ags: [ag] }, quelle: 'x' }], pendingFrom: '2026-11-28T10:00:00+01:00' });
    const sp = rP.latest.env.support.sport;
    assert(sp.rows === 0 && sp.pending?.rows > 0 && sp.pending.days === 1 && rP.latest.env.pendingFrom === '2026-11-28T10:00:00+01:00' && JSON.stringify(rP.latest.totals) === JSON.stringify(r.latest.totals) && !rP.latest.env.ready.includes('sport'),
      `Zurückgehalten: Heimspiel nur gezählt (${sp.pending?.rows} Gemeinde-Stunden), Prognose unverändert`); }
  const ws = [...special].map(k => W.of(k).w), small = groups.filter(g => !special.has(g[0])).map(g => W.of(g[0]).w), mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert(ws.every(w => w >= 0.6) && mean(small) < mean(ws) - 0.15, `Eigener Tagesgang → eigenes Profil (Gewichte ${ws.map(w => w.toFixed(2)).join(', ')}), kleine Gruppen im Mittel ${mean(small).toFixed(2)}`);
  const ev = Object.values(r.log.evals).filter(e => e.models.adaptive), avg = (m) => mean(ev.map(e => F.scoreOf(e.models[m])));
  assert(ev.length >= 5 && avg('adaptive') < Math.min(avg('pooled'), avg('profile')), `Lernendes Modell schlägt beide Ausgangsmodelle (Wertung ${(avg('adaptive') * 100).toFixed(1)} % gegen gepoolt ${(avg('pooled') * 100).toFixed(1)} %, Profil ${(avg('profile') * 100).toFixed(1)} %)`);
  const ch = F.chooseModel(r.log.evals, { trainDays: NDAY });
  assert(r.latest.active === ch.active && r.latest.learn?.leanOwn >= 4 && r.log.feedback.upto === addDays(DAY0, NDAY - 1), `Gewählt nach der Regel: ${r.latest.active} (${r.latest.reason}); Lernstand bis ${r.log.feedback?.upto}, ${r.latest.learn?.leanOwn} Gruppen stützen sich auf sich selbst`);
  // Weg „aktiv“: Auswertung so, dass ein Modell klar vorn liegt → Live-Prognose damit; gleiche Eingaben (mit Wetter) für alle drei, gemessen an der Wahrheit
  const rW = F.runForecast({ docs: ds, calendar: null, weather: WX, prevLog: null, now: NOW });
  const runAs = (m) => { const lg = JSON.parse(JSON.stringify(rW.log)); for (const e of Object.values(lg.evals)) if (e.models[m]) { e.models[m].wapeGD *= 0.5; e.models[m].wapeGH *= 0.5; } return F.runForecast({ docs: ds, calendar: null, weather: WX, prevLog: lg, now: NOW + 3600e3 }); };
  const errOf = (L) => { let e = 0, t = 0; L.horizon.local.forEach(([d, h], i) => { const tru = groups.reduce((a, g) => a + (special.has(g[0]) ? g[1] * g[2] * own(h) : trueMu(g, d, h)), 0); e += Math.abs(L.totals[i] - tru); t += tru; }); return e / t; };
  const r4 = runAs('adaptive'), E = { adaptive: errOf(r4.latest), profile: errOf(runAs('profile').latest), pooledWx: errOf(runAs('pooledWx').latest) };
  assert(r4.latest.active === 'adaptive' && r4.latest.weather.used && r4.latest.totals.every(Number.isFinite) && E.adaptive <= Math.max(E.profile, E.pooledWx) + 0.005,
    `Aktiv: lernendes Modell (mit Wetter im gepoolten Teil); Stundensummen gegen die Wahrheit ${(E.adaptive * 100).toFixed(1)} % (Profil ${(E.profile * 100).toFixed(1)} %, gepoolt mit Wetter ${(E.pooledWx * 100).toFixed(1)} %)`);
  const PL = r4.series.plans[addDays(DAY0, NDAY)], PY = r4.series.plans[addDays(DAY0, NDAY - 1)];
  assert(PL?.model === 'adaptive' && PY && PY.model !== 'adaptive', `Plan heute mit dem lernenden Modell (${PL?.model}); rückwirkender Plan gestern ohne (Lernstand kennt den Tag schon: ${PY?.model})`);
  const r2 = F.runForecast({ docs: ds, calendar: null, weather: [], prevLog: JSON.parse(JSON.stringify(r.log)), now: NOW + 3600e3 });
  assert(JSON.stringify(r2.log.feedback) === JSON.stringify(r.log.feedback) && JSON.stringify(r2.log.evals) === JSON.stringify(r.log.evals), 'Zweiter Lauf am selben Tag: Lernstand und Auswertungen unverändert');
  const r3 = F.runForecast({ docs: [...ds, mk(addDays(DAY0, NDAY))], calendar: null, weather: [], prevLog: JSON.parse(JSON.stringify(r.log)), now: NOW + 86400e3 });
  assert(r3.log.feedback.upto === addDays(DAY0, NDAY) && r3.log.evals[addDays(DAY0, NDAY)]?.models.adaptive, 'Neuer Tag: wird erst bewertet, dann in den Lernstand übernommen');
}

// ---------- Hybrid: Niveau des Bezugstags, Tagesgang aus dem Modell
{
  const K = F.HYBRID.k, ds = F.assignEras([makeDoc(DAY0), makeDoc(addDays(DAY0, 1), { skipHours: [17, 18, 19, 20] }), makeDoc(addDays(DAY0, 2))].map(d => F.dayFromDoc(d, null))), R = F.buildRows(ds);
  const g0 = R.keys.indexOf(groups[0][0]), rows = Array.from({ length: 24 }, (_, h) => ({ g: g0, h, ags: groups[0][0].split('|')[0], cls: ds[2].cls(groups[0][0].split('|')[0]) }));
  const Y = groups[0] && ds[1].groups[groups[0][0]].start.reduce((a, y, h) => a + ([17, 18, 19, 20].includes(h) ? 0 : y), 0);
  const out = F.hybridAdjust(R, ds, 2, rows, new Float64Array(24).fill(1)), f = (Y + K) / (20 + K);
  assert(out.every(x => Math.abs(x - f) < 1e-9), `Hybrid: Faktor (Fahrten am Bezugstag + ${K}) ÷ (Basis derselben Stunden + ${K}) = ${f.toFixed(3)}, Lückenstunden des Bezugstags zählen nicht`);
  assert(F.hybridAdjust(R, ds, 0, rows, new Float64Array(24).fill(1)).every(x => x === 1), 'Hybrid ohne vollständigen Vortag: Basis unverändert');
  const sat = rows.map(r => ({ ...r, cls: 2 })), fer = rows.map(r => ({ ...r, cls: 1 }));
  assert(F.hybridAdjust(R, ds, 2, sat, new Float64Array(24).fill(1)).every(x => x === 1) && F.hybridAdjust(R, ds, 2, fer, new Float64Array(24).fill(1)).every(x => Math.abs(x - f) < 1e-9), 'Hybrid: Samstag ohne Samstag als Bezugstag bleibt beim Modell (kein Freitagsniveau); Ferienwerktag darf einen Werktag nehmen');
  // Bezugstag gleichen Tagtyps: für einen Sonntag der Sonntag davor, nicht der Samstag
  const d14 = Array.from({ length: 14 }, (_, i) => addDays(DAY0, i)), ds14 = F.assignEras(d14.map((d, i) => F.dayFromDoc(makeDoc(d, { level: i === 6 ? 3 : 1 }), null))), R14 = F.buildRows(ds14);
  const ags = groups[0][0].split('|')[0], gi = R14.keys.indexOf(groups[0][0]), cls = ds14[13].cls(ags), sumY = (j) => ds14[j].groups[groups[0][0]].start.reduce((a, b) => a + b, 0);
  const o = F.hybridAdjust(R14, ds14, 13, Array.from({ length: 24 }, (_, h) => ({ g: gi, h, ags, cls })), new Float64Array(24).fill(1));
  assert(wd(d14[13]) === 0 && ds14[6].cls(ags) === cls && ds14[12].cls(ags) !== cls && Math.abs(o[0] - (sumY(6) + K) / (24 + K)) < 1e-9, `Hybrid: Bezugstag für Sonntag ${d14[13]} ist Sonntag ${d14[6]} (Faktor ${o[0].toFixed(2)}), nicht Samstag ${d14[12]}`);
}
{
  const ev = (o) => Object.fromEntries(Object.entries(o).map(([d, m]) => [d, { models: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { wapeGD: v, wapeGH: v }])) }]));
  const mk = (n, f) => ev(Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-11-${String(i + 1).padStart(2, '0')}`, f(i)])));
  const h = F.chooseModel(mk(4, () => ({ profile: 0.17, pooled: 0.19, hybrid: 0.16 })), { trainDays: 8 });
  assert(h.active === 'hybrid' && /wie gestern/.test(h.reason), `Modellwahl: Hybrid ≥ 2 % besser als das gewählte → hybrid (${h.reason})`);
  assert(F.chooseModel(mk(4, () => ({ profile: 0.17, pooled: 0.19, hybrid: 0.168 })), { trainDays: 8 }).active === 'profile', 'Modellwahl: Hybrid nur 1 % besser → bleibt profile');
  assert(F.chooseModel(mk(4, () => ({ profile: 0.3, pooled: 0.2, adaptive: 0.18, hybrid: 0.15 })), { trainDays: 8 }).active === 'hybrid' && F.chooseModel(mk(4, () => ({ profile: 0.3, pooled: 0.2, adaptive: 0.14, hybrid: 0.15 })), { trainDays: 8 }).active === 'adaptive', 'Modellwahl: sind lernendes Modell und Hybrid besser, gewinnt der größere Vorsprung');
}
{
  // Saisonabfall: Nachfrage −6 % je Tag bei gleicher Flotte; Profil und gepooltes Modell mitteln über das Fenster und liegen zu hoch, der Hybrid folgt dem Niveau
  const ds = days12.slice(0, NDAY - 1).map((d, i) => makeDoc(d, { level: 0.94 ** i })), TODAY = addDays(DAY0, NDAY - 1), NOW = Date.parse(`${TODAY}T03:00:00Z`);
  const r = F.runForecast({ docs: ds, calendar: null, weather: [], prevLog: null, now: NOW });
  const ev = Object.values(r.log.evals).filter(e => e.models.hybrid && e.trainDays >= 3), avg = (m) => ev.reduce((a, e) => a + F.scoreOf(e.models[m]), 0) / ev.length;
  assert(ev.length >= 5 && avg('hybrid') < Math.min(avg('profile'), avg('pooled')) * 0.95 && ev.every(e => e.expoErrAlt && e.expoErrAlt.class != null), `Saisonabfall: Hybrid ${(avg('hybrid') * 100).toFixed(1)} % gegen Profil ${(avg('profile') * 100).toFixed(1)} %, gepoolt ${(avg('pooled') * 100).toFixed(1)} %; andere Flottenannahmen mitgeschrieben`);
  const PL = r.series.plans[TODAY];
  assert(r.latest.active === 'hybrid' && r.latest.totals.every(Number.isFinite) && PL?.model === 'hybrid', `Gewählt: ${r.latest.active} (${r.latest.reason}); Plan heute mit ${PL?.model}`);
  // Live-Prognose (Freitag früh bis Samstag) gegen die Wahrheit, gleiche Eingaben, Modell jeweils erzwungen
  const runAs = (m) => { const lg = JSON.parse(JSON.stringify(r.log)); for (const e of Object.values(lg.evals)) if (e.models[m]) { e.models[m].wapeGD *= 0.5; e.models[m].wapeGH *= 0.5; } return F.runForecast({ docs: ds, calendar: null, weather: [], prevLog: lg, now: NOW + 3600e3 }).latest; };
  const lev = (d) => 0.94 ** Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${DAY0}T12:00:00Z`)) / 86400e3);
  const errOf = (L) => { let e = 0, t = 0; L.horizon.local.forEach(([d, h], i) => { const tru = groups.reduce((a, g) => a + trueMu(g, d, h, lev(d)), 0); e += Math.abs(L.totals[i] - tru); t += tru; }); return e / t; };
  const E = { hybrid: errOf(runAs('hybrid')), pooled: errOf(runAs('pooled')), profile: errOf(runAs('profile')) };
  assert(E.hybrid < Math.min(E.pooled, E.profile), `Live im Saisonabfall (gepoolt und Profil seit S2.8 mit Korrektur der Verzerrung je Art): Stundensummen ${(E.hybrid * 100).toFixed(1)} % neben der Wahrheit (gepoolt ${(E.pooled * 100).toFixed(1)} %, Profil ${(E.profile * 100).toFixed(1)} %)`);
}

// ---------- Selbstprüfung ohne Vorwissen: Exposition der Vortage wie im Betrieb (Regression Orakel, bis 6.11.2026)
{
  const ds = F.assignEras(docs.slice(0, 6).map(d => F.dayFromDoc(d, null)));
  const ds2 = F.assignEras(docs.slice(0, 6).map((d, i) => { const x = F.dayFromDoc(d, null); if (i === 5) x.groups = Object.fromEntries(Object.entries(x.groups).map(([k, g]) => [k, { ...g, vmin: g.vmin.map(v => v * 2.5) }])); return x; }));
  const R1 = F.buildRows(ds), R2 = F.buildRows(ds2);
  const lastOf = (days) => (d) => { const m = new Map(); for (const x of days.slice(0, d)) for (const [k, g] of Object.entries(x.groups)) m.set(k, g.vmin.map(v => v / 60)); return m; };
  const e1 = F.evaluateDays(R1, [5], { expoBefore: lastOf(ds) })[5], e2 = F.evaluateDays(R2, [5], { expoBefore: lastOf(ds2) })[5];
  const same = ['profile', 'pooled'].every(m => JSON.stringify({ ...e1.models[m] }) === JSON.stringify({ ...e2.models[m] }));
  assert(same, `Leck-Test: tatsächliche Fahrzeugstunden des Prüftags ×2,5 ändern die Wertung nicht (pooled ${(e1.models.pooled.wapeGH * 100).toFixed(1)} = ${(e2.models.pooled.wapeGH * 100).toFixed(1)} %)`);
  const o2 = F.evaluateDays(R2, [5], {})[5];
  assert(o2.models.pooled.wapeGH !== e2.models.pooled.wapeGH && e2.expoErr > 0.5 && e1.expoErr < 0.05, `Ohne Vortags-Exposition (alte Prüfung) hinge die Wertung vom Prüftag ab; Fehler der Flottenprognose ${e1.expoErr} bzw. ${e2.expoErr}`);
  const t = e1.models.pooled, ty = Object.values(t.byType), sz = Object.values(t.bySize);
  assert(Math.abs(ty.reduce((a, x) => a + x[2], 0) - t.starts) <= ty.length && Math.abs(sz.reduce((a, x) => a + x[2], 0) - t.starts) <= sz.length /* je volle Stunde (S2.1): Rundung je Teil */ && Object.keys(t.byType).every(k => ['scooter', 'bike'].includes(k)), `Aufteilung je Art (${Object.keys(t.byType).join(', ')}) und Größe (${Object.keys(t.bySize).join(', ')}) summiert sich zu allen Fahrtbeginnen`);
}
// ---------- Modellwahl nur mit reifen Tagen; Wetter-Gate je Gemeinde-Tag
{
  const ev = (o) => Object.fromEntries(Object.entries(o).map(([d, [td, m]]) => [d, { trainDays: td, models: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { wapeGD: v, wapeGH: v }])) }]));
  const E = ev({ '2026-11-02': [2, { profile: 0.9, pooled: 0.2 }], '2026-11-03': [3, { profile: 0.1, pooled: 0.2 }], '2026-11-04': [4, { profile: 0.1, pooled: 0.2 }], '2026-11-05': [5, { profile: 0.1, pooled: 0.2 }] });
  const c = F.chooseModel(E, { trainDays: 6 });
  assert(c.active === 'profile' && c.evalDays === 3, `Modellwahl: Tag mit 2 Trainingstagen zählt nicht (sonst gewänne pooled); ${c.reason}`);
  // Regen jeden Tag irgendwo (eine Gemeinde regnet immer), sonst trocken an Tagen ohne Regen: alte Regel zählte 0 Trockentage
  const ds = F.assignEras(docs.map(d => F.dayFromDoc(d, null)));
  const W = WX.map(w => { const wet = { t: w.cells['48.5|9.0'].t, p: w.cells['48.5|9.0'].t.map(() => 1) }; return { ...w, cells: { ...w.cells, wet }, ags: { ...w.ags, [AGS[0]]: 'wet' } }; });
  const R = F.buildRows(ds, F.wxLookup(W)), g = F.weatherGate(R, Array.from({ length: R.n }, (_, i) => i));
  assert(g.ok && g.dryDays >= 4 && g.rainDays >= 2 && g.places >= NDAY * AGS.length - 2, `Wetter-Gate je Gemeinde-Tag: ${g.rainDays} Regen-, ${g.dryDays} Trockentage, obwohl es jeden Tag irgendwo regnet; Spanne ${g.tempRangeK} K`);
}
// ---------- Live-Abgleich trotz täglicher Abendlücke; gezielter Neuaufbau bei neuer Prüffassung
{
  const gap = [17, 18, 19, 20], NOW = Date.parse(`${addDays(DAY0, NDAY - 2)}T10:00:00Z`);
  const ds = docs.slice(0, NDAY - 2), r = F.runForecast({ docs: ds, calendar: null, weather: WX, prevLog: null, now: NOW });
  assert(Object.keys(r.log.issued).length === 1 && r.log.evalVersion === F.EVAL_VERSION && Object.values(r.log.evals).every(e => e.expoErr != null), 'Ausgegebene Prognose festgehalten; Auswertungen mit Fehler der Flottenprognose');
  const holed = (d) => makeDoc(d, { skipHours: gap }); // keine Läufe und Fahrten 17–20 Uhr (wie die Lücken am 4./5.11.)
  const next = [...ds, holed(addDays(DAY0, NDAY - 2)), holed(addDays(DAY0, NDAY - 1))];
  const early = F.runForecast({ docs: next, calendar: null, weather: WX, prevLog: JSON.parse(JSON.stringify(r.log)), now: Date.parse(`${addDays(DAY0, NDAY - 1)}T11:30:00Z`) });
  assert(Object.keys(early.log.live).length === 0 && Object.keys(early.log.issued).length >= 1, 'Live-Abgleich wartet, bis die 24 Stunden plus Puffer vorbei sind');
  const r2 = F.runForecast({ docs: next, calendar: null, weather: WX, prevLog: JSON.parse(JSON.stringify(r.log)), now: Date.parse(`${addDays(DAY0, NDAY)}T09:00:00Z`) });
  const lv = Object.values(r2.log.live)[0];
  assert(lv && lv.hours === 20 && lv.lead.filter(x => x === null).length === 4 && lv.wapeTotalH < 0.2 && lv.naiveOpH != null, `Live-Abgleich mit Lücke 17–20 Uhr: ${lv?.hours} von 24 Stunden bewertet, Summe ${(lv?.wapeTotalH * 100).toFixed(1)} %, Vorlauf-Fehler je Stunde mitgeschrieben`);
  const old = JSON.parse(JSON.stringify(r.log)); delete old.evalVersion; for (const e of Object.values(old.evals)) e.models.pooled.wapeGD = 0.999; old.live = { 1: { model: 'pooled', hours: 24 } };
  const r3 = F.runForecast({ docs: ds, calendar: null, weather: WX, prevLog: old, now: NOW + 3600e3 });
  assert(Object.values(r3.log.evals).every(e => e.models.pooled.wapeGD < 0.9) && r3.log.live[1] && Object.keys(r3.log.issued).length >= 1 && r3.log.feedback.upto, 'Neue Prüffassung: Auswertungen und Lernstand neu gerechnet, Live-Abgleich und ausgegebene Prognosen bleiben');
}

// ---------- Ende zu Ende: Lauf, Selbstprüfung, Prognose, Live-Abgleich
{
  const NOW = Date.parse(`${addDays(DAY0, NDAY)}T10:00:00Z`); // alle 12 Tage sind abgeschlossen
  const t0 = Date.now(), r = F.runForecast({ docs, calendar: null, weather: WX, prevLog: null, now: NOW }), ms = Date.now() - t0;
  const L = r.latest;
  assert(L.status === 'active' && L.trainDays === NDAY && L.evalDays >= 3, `Lauf: Status ${L.status}, ${L.trainDays} Trainingstage, ${L.evalDays} ausgewertet (${ms} ms)`);
  assert(L.active === 'pooledWx' && L.weather.used === true, `Auswahl: ${L.active} – das Wetter trägt und wird genutzt (${L.reason})`);
  assert(Object.keys(r.log.evals).length >= 3 && Object.values(r.log.evals).every(e => e.models.pooled && e.models.profile && e.models.naive), 'Selbstprüfung: je Tag profile, pooled und naiver Vortag bewertet');
  const pw = Object.values(r.log.evals).filter(e => e.models.pooledWx), pp = pw.map(e => e.models.pooled.wapeGD), px = pw.map(e => e.models.pooledWx.wapeGD);
  assert(pw.length >= 3 && px.reduce((a, b) => a + b) < pp.reduce((a, b) => a + b), 'Selbstprüfung: das Wettermodell schlägt das ohne Wetter im Mittel');
  assert(L.horizon.hours === 24 && L.totals.length === 24 && L.horizon.local.length === 24 && L.horizon.local[0][1] === 12, 'Horizont: 24 Ortsstunden ab der nächsten vollen Stunde (11:00 UTC = 12 Uhr)');
  // Wahrheit der nächsten 24 Stunden: erwartete Starts je Stunde aus dem bekannten Modell
  let err = 0, tot = 0; L.horizon.local.forEach(([d, h], i) => { const tru = groups.reduce((s, g) => s + trueMu(g, d, h), 0); err += Math.abs(L.totals[i] - tru); tot += tru; });
  assert(err / tot < 0.1, `Prognose der Stundensummen trifft die Wahrheit (Fehler ${(err / tot * 100).toFixed(1)} %)`);
  // Gruppenebene: Summe und große Gruppe
  const big = [...groups].sort((a, b) => b[1] * b[2] - a[1] * a[2])[0], got = L.groups[big[0]], truth = L.horizon.local.reduce((s, [d, h]) => s + trueMu(big, d, h), 0);
  assert(got && Math.abs(got.start.reduce((a, b) => a + b, 0) / truth - 1) < 0.15 && got.fleet > 0 && got.perVeh > 0, `Größte Gruppe: Prognose ${got && got.start.reduce((a, b) => a + b, 0).toFixed(0)} vs. Wahrheit ${truth.toFixed(0)}, ${got && got.fleet} Fahrzeuge, ${got && got.perVeh} Starts je Fahrzeug`);
  assert(Math.abs(Object.values(L.municipalities).reduce((s, a) => s + a.reduce((x, y) => x + y, 0), 0) - L.totals.reduce((a, b) => a + b, 0)) < 20, 'Gemeinde-Summen ergeben die Gesamtsumme');
  // zweiter Lauf mit altem Log: nichts wird neu ausgewertet, Ergebnis stabil
  const r2 = F.runForecast({ docs, calendar: null, weather: WX, prevLog: JSON.parse(JSON.stringify(r.log)), now: NOW + 3600e3 });
  assert(JSON.stringify(r2.log.evals) === JSON.stringify(r.log.evals), 'Zweiter Lauf: bereits ausgewertete Tage bleiben unverändert (nur neue Tage werden bewertet)');
  assert(Object.keys(r.log.issued).length === 1 && Object.keys(r2.log.issued).length === 1, 'Ausgegebene Prognosen: höchstens eine je 6 Stunden');
  // Live-Abgleich: einen weiteren Tag liefern und prüfen, ob die ausgegebene Prognose gegen die Realität bewertet wird
  const next = [...docs, ...[0, 1].map(i => makeDoc(addDays(DAY0, NDAY + i)))];
  const r3 = F.runForecast({ docs: next, calendar: null, weather: WX, prevLog: JSON.parse(JSON.stringify(r.log)), now: Date.parse(`${addDays(DAY0, NDAY + 2)}T10:00:00Z`) });
  const live = Object.values(r3.log.live)[0];
  assert(live && live.wapeTotalH != null && live.wapeTotalH < 0.2 && live.wapeOpH < 0.4 && live.naiveOpH != null && live.skill > 0.2, `Live-Abgleich: ausgegebene Prognose gegen die Realität (Summe ${(live?.wapeTotalH * 100).toFixed(1)} %, je Anbieter ${(live?.wapeOpH * 100).toFixed(0)} %, naiv ${(live?.naiveOpH * 100).toFixed(0)} %, Skill ${live?.skill})`);
  assert(!Object.values(r3.log.issued).some(x => x.from === r.log.issued[Object.keys(r.log.issued)[0]].from), 'Live-Abgleich: bewertete Prognose wird aus der Warteliste genommen');
}

// ---------- Stundenreihen des Dashboards (series): Plan heute, Ist, Live-Prognose bis Ende morgen
{
  const TODAY = addDays(DAY0, NDAY), TOMORROW = addDays(DAY0, NDAY + 1), NOW = Date.parse(`${TODAY}T10:00:00Z`);
  const r = F.runForecast({ docs, calendar: null, weather: WX, prevLog: null, now: NOW }), S = r.series;
  assert(S.version === 1 && S.today === TODAY && S.tomorrow === TOMORROW && S.status === 'active', `Reihen: heute ${S.today}, morgen ${S.tomorrow}`);
  const keys = Object.keys(S.days);
  assert(keys.length <= F.SERIES_KEEP_DAYS + 1 && keys.includes(TODAY) && keys.includes(TOMORROW) && keys.includes(addDays(TODAY, -1)), `Reihen: höchstens ${F.SERIES_KEEP_DAYS} Tage + morgen (${keys.length})`);
  const T = S.days[TODAY].DE, M = S.days[TOMORROW].DE;
  assert(T.p?.length === 24 && T.p.every(x => x != null) && !T.a && T.l.slice(0, 12).every(x => x === null) && T.l.slice(12).every(x => x > 0), 'Heute ohne Tagesdatei: Plan für 24 Stunden, Live-Prognose nur ab 12 Uhr (nächste volle Ortsstunde), kein Ist');
  assert(M.l.length === 24 && M.l.every(x => x != null) && !M.p && !M.a, 'Morgen: Live-Prognose für alle 24 Stunden, noch kein Plan');
  const truth = (day, lvl = 1) => Array.from({ length: 24 }, (_, h) => groups.reduce((a, g) => a + trueMu(g, day, h, lvl), 0));
  const werr = (x, y) => x.reduce((a, v, i) => a + Math.abs(v - y[i]), 0) / y.reduce((a, b) => a + b, 0);
  assert(werr(T.p, truth(TODAY)) < 0.12, `Plan heute trifft die Wahrheit je Stunde (${(werr(T.p, truth(TODAY)) * 100).toFixed(1)} %)`);
  assert(werr(M.l, truth(TOMORROW)) < 0.12, `Prognose morgen trifft die Wahrheit je Stunde (${(werr(M.l, truth(TOMORROW)) * 100).toFixed(1)} %)`);
  const Y = S.days[addDays(TODAY, -1)].DE;
  assert(Y.p && Y.a && werr(Y.p, Y.a) < 0.2, `Gestern: Plan gegen Ist je Stunde ${(werr(Y.p, Y.a) * 100).toFixed(1)} % (rückwirkend nur mit Tagen davor gerechnet)`);
  // Gebiete summieren sich: Anbieter = Deutschland, Gemeinden = Deutschland, Arten = Deutschland (Plan, Rundung ±1 je Stunde und Gebiet)
  const sumOf = (pre) => Array.from({ length: 24 }, (_, h) => Object.entries(S.days[TODAY]).filter(([k]) => k.startsWith(pre)).reduce((a, [, e]) => a + (e.p?.[h] || 0), 0));
  assert(werr(sumOf('op:'), T.p) < 0.01 && werr(sumOf('ty:'), T.p) < 0.01, 'Gebiete: Anbieter und Arten ergeben je Stunde die Deutschland-Reihe');
  assert(Object.keys(S.days[TODAY]).some(k => k.startsWith('ags:')) && Object.keys(S.days[TODAY]).some(k => k.startsWith('g:')) && Object.keys(S.days[TODAY]).length <= 1 + 5 + 2 + AGS.length + F.SERIES_MIN.groupMax, 'Gebiete: Gemeinden und große Gruppen sind dabei, die Zahl ist begrenzt');
  // Herkunft des Plans (Kontrolle im Dashboard): Modell, Trainingstage, Zeitpunkt, rückwirkend ja/nein
  const PL = S.plans?.[TODAY], PLY = S.plans?.[addDays(TODAY, -1)];
  assert(PL && ['pooled', 'profile', 'pooledWx'].includes(PL.model) && PL.trainDays >= 2 && PL.retro === false && PL.at === new Date(NOW).toISOString() && PLY?.retro === true && !S.plans[TOMORROW], `Plan-Herkunft: heute ${PL?.model}/${PL?.trainDays} Tage, gestern rückwirkend, morgen noch kein Plan`);
  // Plan bleibt eingefroren, Ist und Live folgen neuen Daten
  const docs2 = [...docs, makeDoc(TODAY)], NOW2 = Date.parse(`${TODAY}T16:00:00Z`);
  docs2.at(-1).published = { complete: false }; docs2.at(-1).groups = Object.fromEntries(Object.entries(docs2.at(-1).groups).map(([k, g]) => [k, { ...g, start: g.start.map((x, h) => (h < 16 ? x : 0)), vmin: g.vmin.map((x, h) => (h < 16 ? x : 0)) }]));
  const r2 = F.runForecast({ docs: docs2, calendar: null, weather: WX, prevLog: JSON.parse(JSON.stringify(r.log)), prevSeries: JSON.parse(JSON.stringify(S)), now: NOW2 }), T2 = r2.series.days[TODAY].DE;
  assert(JSON.stringify(T2.p) === JSON.stringify(T.p), 'Plan heute bleibt über den Tag eingefroren (zweiter Lauf)');
  assert(JSON.stringify(r2.series.plans[TODAY]) === JSON.stringify(PL), 'Plan-Herkunft bleibt mit dem eingefrorenen Plan stehen (Zeitpunkt unverändert)');
  assert(T2.a && T2.a.slice(0, 16).every(x => x != null && x >= 0) && T2.a.slice(16).every(x => x === null), 'Ist: Stunden mit Beobachtung gezählt, spätere Stunden null');
  assert(T2.l.slice(0, 18).every(x => x === null) && T2.l.slice(18).every(x => x > 0), 'Live-Prognose beginnt mit der nächsten vollen Ortsstunde (18 Uhr bei 16:00 UTC)');
  const A = F.actualOfDay(F.dayFromDoc(docs2.at(-1), null));
  assert(A.get('DE').slice(0, 16).reduce((a, b) => a + b, 0) === T2.a.slice(0, 16).reduce((a, b) => a + b, 0) || Math.abs(A.get('DE').slice(0, 16).reduce((a, b) => a + b, 0) - T2.a.slice(0, 16).reduce((a, b) => a + b, 0)) < 20, 'actualOfDay: Summe stimmt mit der gespeicherten Ist-Reihe überein');
  // zu wenig Daten: keine Pläne, kein Fehler
  const e = F.runForecast({ docs: [docs[0]], now: Date.parse(`${docs[0].day}T20:00:00Z`) });
  assert(e.series.version === 1 && Object.values(e.series.days).every(d => Object.values(d).every(x => !x.p && !x.l)), 'Ein Tag Daten: Reihen ohne Plan und Live-Prognose');
}

// ---------- Regelwechsel: Prognose folgt dem aktuellen Regelstand (Era 0), nicht dem Mittel
{
  const ds = [];
  for (let i = 0; i < 12; i++) ds.push(makeDoc(addDays(DAY0, i), i < 6 ? { rule: 'M1@a', level: 1.0 } : { rule: 'M2@b', level: 0.6 }));
  const NOW = Date.parse(`${addDays(DAY0, 12)}T10:00:00Z`), r = F.runForecast({ docs: ds, calendar: null, weather: WX, prevLog: null, now: NOW }), L = r.latest;
  let tru = 0; L.horizon.local.forEach(([d, h]) => { tru += groups.reduce((s, g) => s + trueMu(g, d, h, 0.6), 0); });
  const got = L.totals.reduce((a, b) => a + b, 0);
  assert(Math.abs(got / tru - 1) < 0.12, `Regelwechsel (Zählung −40 %): Prognose ${got.toFixed(0)} folgt dem neuen Stand (Wahrheit ${tru.toFixed(0)})`);
}

// ---------- rote Gruppen (nicht plausibel gezählt) bleiben draußen
{
  const big = [...groups].sort((a, b) => b[1] * b[2] - a[1] * a[2])[0][0], NOW = Date.parse(`${addDays(DAY0, NDAY)}T10:00:00Z`);
  const r = F.runForecast({ docs, calendar: null, weather: WX, prevLog: null, now: NOW, exclude: new Set([big]) });
  assert(r.latest.excluded === 1 && !(big in r.latest.groups) && Object.keys(r.latest.groups).length >= 20, 'Ausschluss: rote Gruppe fehlt in Training und Prognose, die übrigen bleiben');
}

// ---------- zu wenig Daten und leere Eingaben
{
  const e = F.runForecast({ docs: [], now: Date.parse('2026-11-04T10:00:00Z') });
  assert(e.latest.status === 'insufficient' && e.latest.active === null && Object.keys(e.latest.groups).length === 0, 'Ohne Daten: Status insufficient, keine Prognose, kein Fehler');
  const one = F.runForecast({ docs: [docs[0]], now: Date.parse('2026-11-04T10:00:00Z') });
  assert(one.latest.status === 'insufficient' && one.latest.trainDays === 1, 'Ein Tag Daten: noch keine Prognose (Mindestens 2 Trainingstage)');
  const bad = F.runForecast({ docs: [{ day: '2026-11-03', runs: [], groups: { 'x|y|z': { start: [1], vmin: [] } } }, { day: '2026-11-02' }, null], now: Date.parse('2026-11-04T10:00:00Z') });
  assert(bad.latest.status === 'insufficient', 'Kaputte Gruppenzeilen und fehlende Felder werden übersprungen');
}

// ---------- Umgebung: Warnungen, Autobahn, gepflegte Ereignisse (lib/pulse-context.js)
import * as CX from '../lib/pulse-context.js';
{
  const docsI = new Map(), t0 = F.localToUtcMs('2026-11-10', 14), now = t0 - 2 * 3600e3;
  const n = CX.addAlerts(docsI, { c1: [{ status: 'actual', severity: 'severe', onset: new Date(t0).toISOString(), expires: new Date(t0 + 3 * 3600e3).toISOString() }, { status: 'actual', severity: 'minor', onset: new Date(t0).toISOString(), expires: new Date(t0 + 5 * 3600e3).toISOString() }, { status: 'test', severity: 'extreme', onset: new Date(t0).toISOString() }] }, { '08416041': 'c1', '08111000': 'c2' }, now);
  const w = docsI.get('2026-11-10')?.ags['08416041']?.warn;
  assert(n > 0 && w && w.slice(13, 20).join() === '0,3,3,3,1,1,0' && !docsI.get('2026-11-10').ags['08111000'], `Warnungen: höchste Stufe je Ortsstunde (14–16 Uhr Stufe 3, danach 1), Probewarnung ignoriert, nur Gemeinden der Zelle (${w?.slice(13, 20).join(',')})`);
  const it = (o) => ({ coordinate: { lat: '48.5', long: '9.0' }, future: false, ...o });
  const r = [CX.roadItem(it({}), 'closure', now), CX.roadItem(it({ future: true }), 'closure', now), CX.roadItem(it({ abnormalTrafficType: 'STATIONARY_TRAFFIC' }), 'warning', now), CX.roadItem(it({ description: ['Fahrbahnverengung, Staugefahr'], startTimestamp: '2026-01-01T00:00:00+01:00' }), 'warning', now), CX.roadItem(it({ title: 'A8 Stau 4 km', startTimestamp: new Date(now - 3600e3).toISOString() }), 'warning', now)];
  assert(r[0]?.kind === 'closure' && !r[1] && r[2]?.kind === 'jam' && !r[3] && r[4]?.kind === 'jam', 'Autobahn: Sperrung zählt, geplante nicht; Stau zählt, Dauer-Baustellenhinweis nicht');
  const old1 = CX.roadItem(it({ startTimestamp: '2026-09-19T00:00:00+02:00' }), 'closure', now), old2 = CX.roadItem(it({ abnormalTrafficType: 'QUEUING_TRAFFIC', startTimestamp: new Date(now - 26 * 3600e3).toISOString() }), 'warning', now);
  assert(!old1 && !old2, 'Autobahn: monatelange Bauphasen-Sperrung und 26 Stunden alte Staumeldung zählen nicht (sonst fast konstant je Gemeinde, Zukunft unbekannt)');
  const hit = CX.addRoad(docsI, [{ lat: 48.5, lon: 9.0 }, { lat: 1, lon: 1 }], (lat) => (lat > 40 ? '08416041' : null), now);
  assert(hit === 1 && docsI.get(T_dayOf(now)).ags['08416041'].road[T_hourOf(now)] === 1, 'Autobahn: Meldung → Gemeinde zur Stunde der Beobachtung');
  const cur = CX.checkCurated({ ereignisse: [{ art: 'streik-oepnv', von: '2026-11-10', gebiet: { laender: ['BW'] }, quelle: 'https://x' }, { art: 'streik-bahn', von: '2026-11-11T04:00', bis: '2026-11-11T10:00', gebiet: 'DE', quelle: 'https://y' }, { art: 'veranstaltung', von: '2026-11-12', gebiet: { ags: ['08111000'] }, quelle: 'https://z' }, { art: 'demo', von: '2026-11-10', gebiet: 'DE', quelle: 'q' }, { art: 'streik-oepnv', von: '2026-11-10', gebiet: 'DE' }] });
  assert(cur.ok.length === 3 && cur.bad.length === 2, `Ereignisliste: unbekannte Art und fehlende Quelle werden abgewiesen (${cur.bad.join('; ')})`);
  const L = CX.ctxLookup([...docsI.values()], cur.ok), K = (a) => CX.CTX_KEYS.filter((_, i) => a[i]).join('+') || '–';
  assert(K(L('08416041', '2026-11-10', 15)) === 'warn+strike' && K(L('09162000', '2026-11-10', 15)) === '–' && K(L('09162000', '2026-11-11', 5)) === 'rail' && K(L('09162000', '2026-11-11', 11)) === '–' && K(L('08111000', '2026-11-12', 20)) === 'event' && K(L('08416041', '2026-11-10', 19)) === 'strike',
    'Merkmale je Gemeinde und Stunde: Warnung ab Stufe 2, Streik je Land, Bahnstreik mit Uhrzeit bundesweit, Veranstaltung je Gemeinde');
  const back = CX.weatherBackfillDays(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'], ['2026-11-03', '2026-11-04', '2026-11-05'], '2026-11-06');
  assert(back.join() === '2026-10-30,2026-10-31,2026-11-01,2026-11-02', `Wetter nachholen: fehlende UTC-Tage samt Vortag des ältesten Ortstags (${back.join(', ')}); gestern und heute holt der normale Abruf`);
}
function T_dayOf(ms) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
function T_hourOf(ms) { return +new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date(ms)) % 24; }

// ---------- Umgebung im Modell und Langzeitgedächtnis (synthetische Welt mit bekannter Wirkung)
{
  const TRUE_W = -0.5, TRUE_S = 0.4, W_AGS = new Set(AGS.slice(0, 3)), S_LAND = '08'; // Warnung 12–18 Uhr jeden dritten Tag in drei Gemeinden; ÖPNV-Streik BW
  const NALL = 32, dl = Array.from({ length: NALL }, (_, i) => addDays(DAY0, i)), strikeDays = new Set([dl[2], dl[4]]);
  const warnOn = (day, h) => dl.indexOf(day) % 3 === 1 && h >= 12 && h <= 18;
  const mkCtx = (day) => { const d = makeDoc(day); for (const g of groups) { const ags = g[0].split('|')[0]; d.groups[g[0]].start = d.groups[g[0]].start.map((_, h) => pois(trueMu(g, day, h) * Math.exp((W_AGS.has(ags) && warnOn(day, h) ? TRUE_W : 0) + (ags.startsWith(S_LAND) && strikeDays.has(day) ? TRUE_S : 0)))); } return d; };
  const allDocs = dl.map(mkCtx);
  const inc = dl.map(day => ({ version: 1, day, sources: {}, ags: Object.fromEntries([...W_AGS].map(a => [a, { warn: Array.from({ length: 24 }, (_, h) => (warnOn(day, h) ? 3 : 0)) }])) }));
  const curated = [...strikeDays].map(d => ({ art: 'streik-oepnv', von: d, gebiet: { laender: ['BW'] }, quelle: 'https://example.org' })), WX2 = wxDocs(addDays(DAY0, -1), addDays(DAY0, NALL + 2)); // mit Wetter, sonst verdeckt der Temperaturgang die Wirkung
  // 1) Fenster mit beiden Streiktagen: Wirkungen gelernt, Modell mit Umgebung schlägt das gepoolte
  const r1 = F.runForecast({ docs: allDocs.slice(0, 12), weather: WX2, incidents: inc, curated, now: Date.parse(`${dl[12]}T10:00:00Z`) });
  const fx = r1.latest.memory.effects, ev1 = Object.values(r1.log.evals).filter(e => e.models.pooledWx && e.env?.includes('warn')), mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert(r1.latest.env.ready.includes('warn') && r1.latest.env.ready.includes('strike') && Math.abs(fx.warn.b - TRUE_W) < 0.12 && Math.abs(fx.strike.b - TRUE_S) < 0.15,
    `Umgebung gelernt: Warnung Faktor ${Math.exp(fx.warn.b).toFixed(2)} (wahr ${Math.exp(TRUE_W).toFixed(2)}), Streik ${Math.exp(fx.strike.b).toFixed(2)} (wahr ${Math.exp(TRUE_S).toFixed(2)})`);
  assert(ev1.length >= 4 && mean(ev1.map(e => F.scoreOf(e.models.pooledWx))) < mean(ev1.map(e => F.scoreOf(e.models.pooled))), `Selbstprüfung: Modell mit Umgebung ${(mean(ev1.map(e => F.scoreOf(e.models.pooledWx))) * 100).toFixed(1)} % gegen gepoolt ${(mean(ev1.map(e => F.scoreOf(e.models.pooled))) * 100).toFixed(1)} %`);
  // 2) Lauf Tag für Tag mit 21-Tage-Fenster: die Streiktage verlassen das Fenster, die Wirkung bleibt im Gedächtnis
  let log = null, r = null;
  for (let i = 3; i <= NALL - 1; i++) { r = F.runForecast({ docs: allDocs.slice(Math.max(0, i - 21), i), weather: WX2, incidents: inc, curated, prevLog: log, now: Date.parse(`${dl[i]}T10:00:00Z`) }); log = r.log; }
  const M = r.log.memory, sm = r.latest.memory, fresh = F.runForecast({ docs: allDocs.slice(NALL - 22, NALL - 1), weather: WX2, incidents: inc, curated, now: Date.parse(`${dl[NALL - 1]}T10:00:00Z`) });
  assert(Object.keys(M.days).length === 21 && M.old && M.old.days > 9.5 && M.old.days <= 10 && Object.keys(M.days).every(d => d > M.old.at) && Math.abs(sm.days - sm.oldDays - sm.windowDays) < 0.11,
    `Gedächtnis: ${Object.keys(M.days).length} Tage im Fenster, ${M.old.days.toFixed(1)} übernommen bis ${M.old.at}, keiner doppelt`);
  assert(!fresh.latest.env.ready.includes('strike') && r.latest.env.ready.includes('strike') && Math.abs(sm.effects.strike.b - TRUE_S) < 0.15 && sm.effects.strike.lo < Math.exp(TRUE_S) && sm.effects.strike.hi > Math.exp(TRUE_S),
    `Streiktage nicht mehr im Fenster: ohne Gedächtnis unbekannt, mit Gedächtnis Faktor ${Math.exp(sm.effects.strike.b).toFixed(2)} (90 %: ${sm.effects.strike.lo}–${sm.effects.strike.hi}, wahr ${Math.exp(TRUE_S).toFixed(2)})`);
  // 3) Vorhersage: angekündigte Warnung für morgen senkt die Live-Prognose in den betroffenen Gemeinden
  const tomorrowW = { version: 1, day: addDays(dl[NALL - 1], 0), sources: {}, ags: Object.fromEntries([...W_AGS].map(a => [a, { warn: Array.from({ length: 24 }, (_, h) => (h >= 12 && h <= 18 ? 3 : 0)) }])) };
  const lg = JSON.parse(JSON.stringify(r.log)); for (const e of Object.values(lg.evals)) if (e.models.pooledWx) { e.models.pooledWx.wapeGD *= 0.5; e.models.pooledWx.wapeGH *= 0.5; }
  const docsNow = allDocs.slice(NALL - 22, NALL - 1), nowL = Date.parse(`${dl[NALL - 1]}T05:00:00Z`);
  const withW = F.runForecast({ docs: docsNow, weather: WX2, incidents: [...inc.slice(0, -1), tomorrowW], curated, prevLog: JSON.parse(JSON.stringify(lg)), now: nowL }), noW = F.runForecast({ docs: docsNow, weather: WX2, incidents: inc.slice(0, -1), curated, prevLog: JSON.parse(JSON.stringify(lg)), now: nowL });
  const muni = (L, a) => L.horizon.local.reduce((s, [d, h], i) => s + (d === dl[NALL - 1] && h >= 12 && h <= 18 ? L.municipalities[a]?.[i] || 0 : 0), 0);
  const ratio = muni(withW.latest, AGS[0]) / muni(noW.latest, AGS[0]);
  assert(withW.latest.active === 'pooledWx' && withW.latest.env.active.includes('warn') && Math.abs(ratio - Math.exp(TRUE_W)) < 0.1, `Live: angekündigte Warnung 12–18 Uhr → Prognose dort ×${ratio.toFixed(2)} (wahr ${Math.exp(TRUE_W).toFixed(2)})`);
  // 4) Wetter-Gate zählt Gedächtnistage mit
  const ds = F.assignEras(docs.slice(0, 3).map(d => F.dayFromDoc(d, null))), R = F.buildRows(ds, F.wxLookup(WX)), sel = Array.from({ length: R.n }, (_, i) => i);
  const g0 = F.weatherGate(R, sel), g1 = F.weatherGate(R, sel, [[-2, 4, 1, 0], [12, 20, 0, 1], [3, 9, 1, 0]]);
  assert(g1.rainDays === g0.rainDays + 2 && g1.dryDays === g0.dryDays + 1 && g1.tempRangeK >= 22 && g1.memDays === 3, `Wetter-Gate mit Gedächtnis: ${g0.rainDays}→${g1.rainDays} Regentage, Spanne ${g0.tempRangeK}→${g1.tempRangeK} K`);
}

// ---------- Gepooltes Modell: Art × Stunde, Anbieter-Prior, jüngere Tage zählen mehr (POOLED)
{
  assert(F.POOLED.typeHour && F.POOLED.hier && F.POOLED.halfLife === 7, 'POOLED: Art × Stunde, Anbieter-Prior und Halbwertszeit 7 Tage sind eingeschaltet');
  // Räder mit Spitze am Morgen, E-Scooter am Abend: mit Art × Stunde trifft das gepoolte Modell beide Tagesgänge
  const sh = (ty, h) => (ty === 'bike' ? 0.2 + 1.6 * Math.exp(-((h - 8) ** 2) / 4) : 0.2 + 1.6 * Math.exp(-((h - 20) ** 2) / 5));
  const mkT = (day) => { const d = makeDoc(day); for (const g of groups) { const ty = g[0].split('|')[2]; d.groups[g[0]].start = d.groups[g[0]].start.map((_, h) => pois(g[1] * g[2] * sh(ty, h))); } return d; };
  const ds = F.assignEras(days12.slice(0, 7).map(d => F.dayFromDoc(mkT(d), null))), R = F.buildRows(ds);
  const train = [], test = []; for (let i = 0; i < R.n; i++) (R.day[i] < 6 ? train : test).push(i);
  const a = F.scoreDay(R, test, F.predictPooled(F.fitPooled(R, train, { typeHour: true }), R, test)), b = F.scoreDay(R, test, F.predictPooled(F.fitPooled(R, train, { typeHour: false }), R, test));
  assert(a.wapeGH < b.wapeGH - 0.05, `Art × Stunde: Räder morgens, E-Scooter abends → Abweichung je Gruppe und Stunde ${(a.wapeGH * 100).toFixed(1)} % statt ${(b.wapeGH * 100).toFixed(1)} %`);
  // Neue Stadt eines bekannten Anbieters: startet beim Niveau des Anbieters (Voi doppelt so stark wie die übrigen), nicht beim Durchschnitt
  const lvl = (k) => (k.split('|')[1] === 'Voi' ? 2 : 1), NEW = '99999999|Voi|scooter';
  const mkH = (day, withNew) => { const d = makeDoc(day); for (const g of groups) d.groups[g[0]].start = d.groups[g[0]].start.map((_, h) => pois(g[1] * g[2] * lvl(g[0]) * shape(h, isWe(day)))); if (withNew) d.groups[NEW] = { start: Array.from({ length: 24 }, (_, h) => pois(20 * 0.4 * 2 * shape(h, isWe(day)))), vmin: new Array(24).fill(20 * 60) }; return d; };
  const dsH = F.assignEras(days12.slice(0, 7).map((d, i) => F.dayFromDoc(mkH(d, i === 6), null))), RH = F.buildRows(dsH);
  const trH = [], teH = []; for (let i = 0; i < RH.n; i++) { if (RH.day[i] < 6) trH.push(i); else if (RH.keys[RH.g[i]] === NEW) teH.push(i); }
  const truth = teH.reduce((s0, i) => s0 + 20 * 0.4 * 2 * shape(RH.hr[i], isWe(dsH[6].day)), 0), sumP = (o) => F.predictPooled(F.fitPooled(RH, trH, o), RH, teH).reduce((x, y) => x + y, 0);
  const pH = sumP({ hier: true }), p0 = sumP({ hier: false }), voiLevel = groups.filter(g => g[0].includes('|Voi|')).reduce((s0, g) => s0 + g[2], 0) / groups.filter(g => g[0].includes('|Voi|')).length;
  assert(Math.abs(Math.log(pH / truth)) < Math.abs(Math.log(p0 / truth)), `Anbieter-Prior: neue Voi-Stadt ohne Historie → ${pH.toFixed(0)} statt ${p0.toFixed(0)} Fahrtbeginne erwartet (wahr ≈ ${truth.toFixed(0)}, Voi-Niveau ${voiLevel.toFixed(2)})`);
  // Abfall −8 % je Tag: mit Halbwertszeit liegt das gepoolte Modell am nächsten Tag weniger zu hoch
  const dsD = F.assignEras(days12.slice(0, 11).map((d, i) => F.dayFromDoc(makeDoc(d, { level: 0.92 ** i }), null))), RD = F.buildRows(dsD);
  const trD = [], teD = []; for (let i = 0; i < RD.n; i++) (RD.day[i] < 10 ? trD : teD).push(i);
  const bH = F.scoreDay(RD, teD, F.predictPooled(F.fitPooled(RD, trD, { halfLife: 7 }), RD, teD)).bias, b0 = F.scoreDay(RD, teD, F.predictPooled(F.fitPooled(RD, trD, { halfLife: 0 }), RD, teD)).bias;
  assert(bH < b0 - 0.05 && bH > 0, `Jüngere Tage zählen mehr: im Abfall liegt gepoolt nur ${(bH * 100).toFixed(0)} % statt ${(b0 * 100).toFixed(0)} % zu hoch`);
}

// ---------- Messaufbau: Schattenprognosen, faire Vergleichswerte, Spitzen, 80-%-Band, Entscheidungsregel (6.11.2026 abends)
{
  // Spitzen
  const S = (arr) => new Map(arr.map((v, h) => [h, v]));
  const a = Array.from({ length: 24 }, (_, h) => 10 + 100 * Math.exp(-((h - 17) ** 2) / 4)), f1 = a.map((v, h) => a[(h + 1) % 24]), f2 = a.map(v => v * 1.2);
  const p1 = F.peakScore([{ a: S(a), f: S(f1) }]), p2 = F.peakScore([{ a: S(a), f: S(f2) }]), p3 = F.peakScore([{ a: S(a.slice(0, 20)), f: S(f2) }]);
  assert(p1.hit === 0 && p1.hit1 === 1 && p2.hit === 1 && Math.abs(p2.top3 - 0.2) < 1e-9 && p3 === null, `Spitzen: eine Stunde früher → nicht genau, aber ±1 h; 20 % zu hoch → Spitze genau, Top-3-Fehler ${p2.top3}; zu wenige Stunden → keine Wertung`);
  // Vergleichswerte als Prognose: letzte beobachtete gleiche Stunde (inkl. heute schon beobachteter Stunden) und Vorwoche
  const ds = F.assignEras(days12.map(d => F.dayFromDoc(makeDoc(d), null))), R = F.buildRows(ds);
  const fut = [{ day: addDays(DAY0, NDAY), h: 9, cls: () => 0 }, { day: addDays(DAY0, NDAY), h: 22, cls: () => 0 }], Fu = F.buildFuture(R, fut, () => 1), sel = Array.from({ length: Fu.n }, (_, i) => i);
  const g0 = groups[0][0], gi = R.keys.indexOf(g0), rowsOf = (dIdx, h) => { for (let i = 0; i < R.n; i++) if (R.day[i] === dIdx && R.g[i] === gi && R.hr[i] === h) return R.y[i]; return null; };
  const nv = F.predictBaseline(R, ds, ds.length, Fu, sel, 'naive', (i) => fut[Fu.fh[i]].day), wk = F.predictBaseline(R, ds, ds.length, Fu, sel, 'week', (i) => fut[Fu.fh[i]].day);
  const j9 = sel.findIndex(i => Fu.g[i] === gi && Fu.hr[i] === 9);
  assert(nv[j9] === rowsOf(NDAY - 1, 9) && wk[j9] === rowsOf(NDAY - 7, 9), 'Vergleichswerte: „wie gestern“ = letzte beobachtete gleiche Stunde, Vorwoche = gleicher Wochentag 7 Tage zuvor');
  // Betrieb: Ausgabe mit allen Kandidaten, Live-Abgleich gegen faire Vergleichswerte, Band, Spitzen
  const NOW = Date.parse(`${addDays(DAY0, NDAY - 2)}T05:00:00Z`), dd = docs.slice(0, NDAY - 2), r = F.runForecast({ docs: dd, calendar: null, weather: WX, prevLog: null, now: NOW });
  const iss = Object.values(r.log.issued)[0];
  assert(iss?.v === 2 && iss.phi > 0 && Object.keys(iss.shadow).length >= 3 && !iss.shadow[iss.model], `Ausgabe hält alle Kandidaten fest (${iss.model} veröffentlicht, Schatten: ${Object.keys(iss.shadow).join(', ')})`);
  const r2 = F.runForecast({ docs: docs.slice(0, NDAY), calendar: null, weather: WX, prevLog: JSON.parse(JSON.stringify(r.log)), now: Date.parse(`${addDays(DAY0, NDAY)}T09:00:00Z`) });
  const lv = Object.values(r2.log.live).find(x => x.v === 2);
  assert(lv && lv.models.naive?.w > 0 && lv.models.week?.w > 0 && Object.keys(lv.models).length >= 5 && lv.cover80 > 0.5 && lv.peak?.n >= 1 && lv.hoursC >= 16,
    `Live v2: ${Object.keys(lv?.models || {}).join(', ')} gegen „wie gestern“ ${(lv?.models.naive.w * 100).toFixed(1)} % und Vorwoche ${(lv?.models.week.w * 100).toFixed(1)} %; 80-%-Band trifft ${(lv?.cover80 * 100).toFixed(0)} %; Spitze ±1 h ${lv?.peak?.hit1}`);
  // „wie gestern“ nutzt nur, was bei Ausgabe bekannt war: für eine Ausgabe um 6 Uhr ist 9 Uhr des Vortags bekannt, 9 Uhr heute nicht
  const evDays = Object.entries(r2.log.evals); 
  assert(evDays.some(([, e]) => e.models.week) && evDays.some(([, e]) => e.models.hybrid?.peak || e.models.pooled?.peak), 'Selbstprüfung mit Vorwochen-Vergleich und Spitzen je Modell');
  // Entscheidungsregel
  const mkLive = (n, rel) => Object.fromEntries(Array.from({ length: n }, (_, k) => [1000 + k, { v: 2, from: Date.parse('2026-11-01T00:00:00Z') + k * 6 * 3600e3, models: Object.fromEntries(Object.entries(rel).map(([m, x]) => [m, { w: x * 0.1 }])) }]));
  const ev = Object.fromEntries(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map(d => [d, { trainDays: 5, models: Object.fromEntries(Object.entries({ profile: 0.17, pooled: 0.19, adaptive: 0.17, hybrid: 0.16, naive: 0.18, week: 0.2 }).map(([m, v]) => [m, { wapeGD: v, wapeGH: v }])) }]));
  const nowMs = Date.parse('2026-11-05T12:00:00Z');
  const c0 = F.chooseModel(ev, { trainDays: 6, live: mkLive(3, { naive: 1, hybrid: 0.7 }), nowMs });
  const c1 = F.chooseModel(ev, { trainDays: 6, live: mkLive(10, { naive: 1, hybrid: 0.95, pooled: 0.8, profile: 1, adaptive: 0.9 }), nowMs });
  const c2 = F.chooseModel(ev, { trainDays: 6, live: mkLive(10, { naive: 1, hybrid: 0.9, pooled: 0.885, profile: 1, adaptive: 0.95 }), prevActive: 'hybrid', nowMs });
  const c3 = F.chooseModel(ev, { trainDays: 6, live: mkLive(14, { naive: 1, week: 0.9, hybrid: 1.3, pooled: 1.4, profile: 1.4, adaptive: 1.3 }), nowMs });
  assert(c0.active === 'hybrid' && !c0.combined, `Entscheidung: unter ${F.DECIDE.liveMin} Live-Prognosen gilt die Selbstprüfung (${c0.active})`);
  assert(c1.active === 'pooled' && c1.combined.pooled.w > 0.5, `Entscheidung: live klar besser → ${c1.active} (${c1.reason})`);
  assert(c2.active === 'hybrid', `Entscheidung: knapp besser (unter ${F.DECIDE.switchGain * 100} %) → bleibt beim bisherigen (${c2.reason})`);
  assert(c3.active === 'week' && /Vergleichswert/.test(c3.reason), `Entscheidung: kein Modell schlägt die Vergleichswerte → der bessere Vergleichswert wird veröffentlicht (${c3.active})`);
  // Veröffentlichung eines Vergleichswerts: Prognose = Vorwoche (fehlende Werte aus dem Modell)
  const lg = JSON.parse(JSON.stringify(r2.log)); lg.live = mkLive(14, { naive: 1, week: 0.9, hybrid: 1.3, pooled: 1.4, pooledWx: 1.35, profile: 1.4, adaptive: 1.3 }); // alle Kandidaten live schlechter
  for (const k of Object.keys(lg.live)) lg.live[k].from = Date.parse(`${addDays(DAY0, NDAY - 1)}T00:00:00Z`) - (+k - 1000) * 3600e3;
  const r4 = F.runForecast({ docs: docs.slice(0, NDAY), calendar: null, weather: WX, prevLog: lg, now: Date.parse(`${addDays(DAY0, NDAY)}T09:30:00Z`) });
  assert(r4.latest.active === 'week' && r4.latest.totals.every(Number.isFinite) && r4.latest.decision?.combined?.week, `Betrieb: veröffentlicht wird ${r4.latest.active}, Entscheidung in latest.json (decision)`);
}
// ---------- Sport: Heimspiele aus OpenLigaDB als Veranstaltungen (lib/pulse-context.js sportEntries)
{
  const now = Date.parse('2026-11-06T12:00:00Z'), k = Date.parse('2026-11-07T17:30:00Z'); // Anstoß 18:30 Ortszeit
  const rows = CX.compactMatches([{ matchID: 7, matchDateTimeUTC: '2026-11-07T17:30:00Z', team1: { teamName: 'VfB Stuttgart' }, team2: { teamName: 'SV Werder Bremen' } },
    { matchID: 8, matchDateTimeUTC: '2026-11-07T14:30:00Z', team1: { teamName: 'Energie Cottbus' }, team2: { teamName: 'Hertha BSC' } },
    { matchID: 9, matchDateTimeUTC: '2026-11-07T12:00:00Z', team1: { teamName: 'SG Sonnenhof Großaspach' }, team2: { teamName: 'MSV Duisburg' } },
    { matchID: 10, matchDateTimeUTC: '2026-11-07T12:00:00Z', team1: { teamName: 'Neuer Verein' }, team2: { teamName: 'X' } },
    { matchID: 11, matchDateTimeUTC: '2026-11-20T19:30:00Z', team1: { teamName: 'VfB Stuttgart' }, team2: { teamName: 'Z' } },
    { matchID: 12, matchDateTimeUTC: null, team1: { teamName: 'VfB Stuttgart' }, team2: { teamName: 'Y' } }], 'bl1');
  rows[1][1] = 'bl2'; rows[2][1] = 'bl3'; rows[3][1] = 'bl2';
  const venues = { ligen: { bl1: 'alle', bl2: 'alle', bl3: 'liste' }, vereine: { 'VfB Stuttgart': { ort: 'Stuttgart', land: 'BW' }, 'FC Energie Cottbus': { ort: 'Cottbus', land: 'BB', alias: ['Energie Cottbus'] } } };
  const resolve = CX.placeResolver([{ properties: { ags: '08111000', name: 'Stuttgart', state: 'BW' } }, { properties: { ags: '12052000', name: 'Cottbus/Chóśebuz', state: 'BB' } }, { properties: { ags: 'x1', name: 'Münster', state: 'HE' } }]);
  assert(CX.compactMatches([{ matchID: 1, matchDateTimeUTC: '2027-05-22T18:00:00Z', team1: { teamName: 'VfB Stuttgart' }, team2: { teamName: 'X' }, group: { groupName: 'Finale' } }, { matchID: 2, matchDateTimeUTC: '2027-04-22T18:00:00Z', team1: { teamName: 'VfB Stuttgart' }, team2: { teamName: 'Y' }, group: { groupName: 'Halbfinale' } }], 'dfb').map(x => x[0]).join() === '2', 'Sport: Endspiel auf neutralem Platz kein Heimspiel, Halbfinale schon');
  const r = CX.sportEntries(rows, venues, { now, resolve, aheadDays: 10 });
  assert(CX.sportEntries(rows, venues, { now, resolve }).entries.length === r.entries.length + 1, 'Sport: ohne Fenstervorgabe alle angesetzten Spiele der Saison (SPORT.aheadDays)');
  const vfb = r.entries.find(e => e.gebiet.ags[0] === '08111000'), cb = r.entries.find(e => e.gebiet.ags[0] === '12052000');
  assert(rows.length === 5 && CX.sportSeason(now) === 2026 && CX.sportSeason(Date.parse('2027-03-01T00:00:00Z')) === 2026 && CX.sportSeason(Date.parse('2027-07-01T00:00:00Z')) === 2027, 'Sport: Spiele ohne Anstoß entfallen; Saison = Startjahr (ab Juli)');
  assert(vfb?.von === '2026-11-07T17:00' && vfb.bis === '2026-11-07T21:30' && vfb.art === 'sport' && vfb.quelle.endsWith('/getmatchdata/bl1/2026') && vfb.id === 'openligadb:7', `Sport: Anstoß 18:30 → Veranstaltung 17:00–21:30 Ortszeit in Stuttgart (${vfb?.von}–${vfb?.bis})`);
  assert(cb?.von === '2026-11-07T14:00' && r.entries.length === 2 && r.unknown.join() === 'Neuer Verein' && !r.entries.some(e => /Großaspach/.test(e.titel)), 'Sport: Alias und „Cottbus/Chóśebuz“ aufgelöst; 3. Liga nur gelistete Vereine; unbekannter Verein der 2. Liga gemeldet; Spiel in 14 Tagen noch nicht');
  const ctx = CX.ctxLookup([], CX.checkCurated({ ereignisse: r.entries }).ok), iE = CX.CTX_KEYS.indexOf('sport');
  assert(ctx('08111000', '2026-11-07', 16)[iE] === 0 && ctx('08111000', '2026-11-07', 17)[iE] === 1 && ctx('08111000', '2026-11-07', 21)[iE] === 1 && ctx('08111000', '2026-11-07', 22)[iE] === 0 && ctx('09162000', '2026-11-07', 18)[iE] === 0 && ctx('08111000', '2026-11-07', 18)[CX.CTX_KEYS.indexOf('event')] === 0,
    'Sport: eigenes Merkmal sport (nicht event) in Stuttgart 17–21 Uhr, nicht davor, danach oder anderswo');
  assert(resolve('Münster', 'NW') === null && CX.sportEntries(rows, { ...venues, vereine: { 'VfB Stuttgart': { ort: 'Nirgendwo', land: 'BW' } } }, { now, resolve }).noAgs.join() === 'Nirgendwo (BW)', 'Sport: Ort ohne Gemeinde gemeldet, Land muss passen');
}
// ---------- Veranstaltungsorte (Wikidata) und Termine aus Programmseiten und ICS → Veranstaltungen (lib/pulse-context.js)
{
  const B = (id, l, c, p, t) => ({ i: { value: `http://www.wikidata.org/entity/${id}` }, l: { value: l }, c: { value: String(c) }, p: { value: p }, types: { value: t } });
  const vs = CX.parseVenues({ results: { bindings: [B('Q10', 'Arena', 15500, 'Point(9.2 48.79)', 'Mehrzweckhalle'), B('Q10', 'Arena', 15000, 'Point(9.2 48.79)', 'Mehrzweckhalle'), B('Q11', 'Friedhof X', 40000, 'Point(9.1 48.7)', 'Waldfriedhof'),
    B('Q12', 'Stadion', 60000, 'Point(9.232 48.792)', 'Fußballstadion'), B('Q13', 'Klein', 4000, 'Point(9 48)', 'Mehrzweckhalle'), B('Q14', 'Ohne Ort', 9000, '', 'Arena')] } });
  assert(vs.map(v => `${v.id}:${v.cap}`).join() === 'Q12:60000,Q10:15500', 'Orte: größte Kapazität je Objekt, Friedhof, zu klein und ohne Koordinate entfallen, nach Plätzen sortiert');
  const D = (s) => { const r = CX.parseDateText(s); return r ? `${r.days[0]}${r.days.length > 1 ? `..${r.days.at(-1)}` : ''} ${r.time || '--'}` : null; };
  const cases = [['Konzert Samstag, 07.11.2026, 20:00 Uhr Tokio Hotel', '2026-11-07 20:00'], ['Sa. 07.11.2026 20:00 Uhr Felix Lobrecht Einlass: 18:30 Uhr Beginn: 20:00 Uhr', '2026-11-07 20:00'],
    ['Einlass: 18:00 Uhr Beginn: 19:30 Uhr 10.11.2026', '2026-11-10 --'], ['04. - 05.12.2026 SDP', '2026-12-04..2026-12-05 --'], ['11.11.2026 - 15.11.2026 Reitturnier', '2026-11-11..2026-11-15 --'],
    ['Dienstag, 10. November 2026, 19:30 Uhr, Einlass: 18:00 Uhr', '2026-11-10 19:30'], ['koRn 13.11.2026 // 19:30 -', '2026-11-13 19:30'], ['30.12. - 02.01.2027 Show', '2026-12-30..2027-01-02 --'], ['ohne Datum 20:00 Uhr', null]];
  const bad = cases.filter(([s, w]) => D(s) !== w).map(([s, w]) => `${s} → ${D(s)} (erwartet ${w})`);
  assert(!bad.length, `Datum und Uhrzeit aus Programmtext (Beginn vor Einlass, Spannen, ausgeschriebene Monate, Jahreswechsel)${bad.length ? ': ' + bad.join('; ') : ''}`);
  assert(CX.berlinUtc('2026-11-07', 20, 0) === Date.parse('2026-11-07T19:00:00Z') && CX.berlinUtc('2026-07-01', 20, 30) === Date.parse('2026-07-01T18:30:00Z'), 'Ortszeit → UTC (Winter- und Sommerzeit)');
  const page = `<html><body><div class="list"><div class="card"><span>Konzert</span><span>Samstag, 07.11.2026, 20:00 Uhr</span><a href="/events/detail/band-x/2026-11-07">Band X</a><a href="/events/detail/band-x/2026-11-07">Tickets &amp; Infos</a></div>
    <div class="card"><h3>Reitturnier</h3><p>11.11.2026 - 15.11.2026</p><a href="/events/detail/reiten">Tickets</a></div><div class="card"><h3>Tour</h3><p>07.01. - 06.02.2027</p><a href="/events/detail/tour">Infos</a></div>
    <div><a href="/impressum">Impressum</a></div><script>var x = "<a href='/events/detail/fake'>01.01.2027</a>";</script></div></body></html>`;
  const tree = CX.htmlTree(page), hev = CX.htmlEvents(tree, 'https://arena.example/programm', { link: '/events/detail/' });
  assert(hev.length === 3 && hev[0].name === 'Band X' && hev[0].time === '20:00' && hev[1].name === 'Reitturnier' && hev[1].days.length === 5 && hev[2].days.length === 31 && hev.every(e => !e.url.includes('fake')), 'Programmseite: Name aus Link oder Überschrift, Uhrzeit, Spannen; Skripte werden nicht gelesen');
  const rows = CX.calendarRows(page, { id: 'arena', url: 'https://arena.example/programm', ort: 'Q10', link: '/events/detail/' });
  assert(rows.length === 6 && rows[0][1] === 'Band X' && rows[0][2] === Date.parse('2026-11-07T19:00:00Z') && rows[0][7] === 0 && rows[1][7] === 1 && rows.filter(r => r[1] === 'Reitturnier').length === 5 && !rows.some(r => r[1] === 'Tour') && rows.every(r => r[3] === 'Q10'),
    `Zeilen: Uhrzeit → Beginn UTC, mehrtägig je Tag (ohneZeit 1), Tourneen über 5 Tage entfallen (${rows.length} Zeilen)`);
  const nm = [['07. November 2026 Samstag Sa. Felix Lobrecht Sell out Einlass: Beginn: Felix Lob', 'Felix Lobrecht'], ['08. November 2026 Sonntag', ''], ['Sa. 07.11.2026 20:00 Uhr So What Band', 'So What Band'], ['CHL: Adler Mannheim vs. Tappara Tampere', 'CHL: Adler Mannheim vs. Tappara Tampere']].filter(([s, w]) => CX.cleanEventName(s) !== w);
  assert(!nm.length, `Name aus Kartentext: Datum, Wochentag, Kassenhinweise weg${nm.length ? ': ' + nm.map(([s]) => `${s} → ${CX.cleanEventName(s)}`).join('; ') : ''}`);
  // Lanxess/SAP Arena: Bildlink nur mit Datum und Textlink mit Uhrzeit zum selben Termin; Hallenduo: nur Kartenlink (anderer Host) je Termin
  const dup = `<div class="c"><h3>Komiker Y</h3><a href="/ev/7"><img src="y.jpg"></a><span>14.11.2026</span></div><div class="c"><a href="/ev/7"><span>14.11.2026 Sa. Komiker Y Sell out Einlass: 18:00 Uhr Beginn: 20:00 Uhr</span></a></div>
    <div class="event-item"><div class="event-date">11.11.2026 - 15.11.2026</div><div class="event-title">Reitturnier</div><a href="http://maps.google.com/?q=Schleyer-Halle">Schleyer-Halle</a></div>`;
  const dv = CX.htmlEvents(CX.htmlTree(dup), 'https://www.halle.example/programm');
  assert(dv.length === 2 && dv[0].name === 'Komiker Y' && dv[0].time === '20:00' && dv[0].url === 'https://www.halle.example/ev/7' && dv[1].name === 'Reitturnier' && dv[1].days.length === 5 && dv[1].url === 'https://www.halle.example/programm',
    `Programmseite: je Termin eine Zeile (mit Uhrzeit gewinnt), Kartenlink → Name aus …title, Adresse = Programmseite (${dv.map(e => `${e.name}@${e.time}`).join()})`);
  const ld = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"Event","name":"Let's Dance","startDate":"2026-11-07 20:00","location":{"@type":"Place","name":"Olympiahalle"}},{"@type":"MusicEvent","name":"Klein","startDate":"2026-11-08 19:00","location":{"name":"Kleine Olympiahalle"}},{"@type":"SportsEvent","name":"Spiel","startDate":"2026-11-09","location":{"name":"Olympiastadion"}}]}</script>`;
  const lr = CX.calendarRows(ld, { id: 'op', url: 'https://op.example/', orte: { 'Kleine Olympiahalle': null, Olympiahalle: 'Q10', Olympiastadion: 'Q12' } });
  assert(lr.length === 2 && lr[0][3] === 'Q10' && lr[0][2] === Date.parse('2026-11-07T19:00:00Z') && lr[1][3] === 'Q12' && lr[1][4] === 'Sports' && lr[1][7] === 2, 'JSON-LD (ItemList): Ort je Stichwort, „Kleine Olympiahalle“ ausgeschlossen, Art aus @type, Tag ohne Uhrzeit (ohneZeit 2)');
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Messe X\r\nDTSTART;VALUE=DATE:20261120\r\nLOCATION:Halle 1\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Konzert\r\n  mit Umbruch\r\nDTSTART:20261121T190000Z\r\nURL:https://x.example/k\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Abgesagt\r\nDTSTART;TZID=Europe/Berlin:20261122T200000\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const ir = CX.calendarRows(ics, { id: 'ics', url: 'https://x.example/cal.ics', art: 'ics', ort: 'Q10' });
  assert(ir.length === 2 && ir[0][1] === 'Messe X' && ir[0][7] === 1 && ir[1][1] === 'Konzert mit Umbruch' && ir[1][2] === Date.parse('2026-11-21T19:00:00Z') && ir[1][6] === 'https://x.example/k', 'ICS: ganztägig, UTC-Zeit, entfaltete Zeilen, abgesagte entfallen');
  const vA = vs.map(v => ({ ...v, ags: '08111000' })), ent = CX.venueEntries([...rows, ...lr], vA, { now: Date.parse('2026-11-06T12:00:00Z') });
  const e1 = ent.find(e => e.titel.startsWith('Band X')), e2 = ent.find(e => e.titel.startsWith('Spiel'));
  assert(e1?.von === '2026-11-07T19:00' && e1.bis === '2026-11-07T23:00' && /15500 Plätze/.test(e1.titel) && e2?.von === '2026-11-09T17:00' && e2.bis === '2026-11-09T23:00' && !ent.some(e => e.von.startsWith('2026-11-11')),
    `Einträge: Beginn 20 Uhr → 19–23 Uhr; ohne Uhrzeit 17–23 Uhr; nur bis 3 Tage voraus (${ent.map(e => e.von).join()})`);
  assert(CX.venueEntries(rows, vA.map(v => ({ ...v, cap: 4000 })), { now: Date.parse('2026-11-06T12:00:00Z') }).length === 0 && CX.venueEntries(rows, vs, { now: Date.parse('2026-11-06T12:00:00Z') }).length === 0, 'Einträge: nur Orte ab 5.000 Plätzen und mit Gemeinde');
  assert(CX.robotsAllowed('User-agent: *\nDisallow: /intern\nAllow: /intern/frei', '/intern/x') === false && CX.robotsAllowed('User-agent: *\nDisallow: /intern\nAllow: /intern/frei', '/intern/frei/y') && CX.robotsAllowed('User-agent: other\nDisallow: /', '/x') && CX.robotsAllowed('', '/x'), 'robots.txt: Disallow, längeres Allow, fremder User-agent, leer');
}
// ---------- Veranstaltungsliste fürs Dashboard und gemessene Wirkung (lib/pulse-context.js eventList, eventEffect)
{
  // Volksfest als eigenes Merkmal fest (hinten in CTX_KEYS), geprüft wie Veranstaltungen; Gedächtnis älterer Fassungen wird aufgefüllt
  { const fe = [{ art: 'volksfest', von: '2027-09-25T11:00', bis: '2027-09-25T23:30', gebiet: { ags: ['08111000'] }, titel: 'Cannstatter Volksfest', quelle: 'https://x.example' }];
    const iF = CX.CTX_KEYS.indexOf('fest'), iE = CX.CTX_KEYS.indexOf('event'), cx = CX.ctxLookup([], CX.checkCurated({ ereignisse: fe }).ok);
    assert(CX.CTX_KEYS.slice(-2).join() === 'fest,sport' && F.EFFECTS.slice(3, 3 + CX.CTX_KEYS.length).slice(-2).join() === 'fest,sport' && F.EFFECTS.slice(-3).join() === 'rain1,rain4,rainPrev' && cx('08111000', '2027-09-25', 20)[iF] === 1 && cx('08111000', '2027-09-25', 20)[iE] === 0 && cx('08111000', '2027-09-25', 8)[iF] === 0,
      'Volksfest: eigenes Merkmal fest (hinten in CTX_KEYS/EFFECTS, danach sport), nicht event, nur in den Öffnungsstunden');
    const NE = F.EFFECTS.length, k = NE - 2, H = Array.from({ length: k * k }, (_, i) => i + 1), mem = F.memoryResize({ old: { P: H.slice(), h: Array(k).fill(2), n: Array(k).fill(3), dk: Array(k).fill(1), days: 1 }, days: { '2026-11-02': { H: H.slice(), u: Array(k).fill(5), n: Array(k).fill(7) } } });
    const d = mem.days['2026-11-02'];
    assert(d.H.length === NE * NE && d.H[1 * NE + 2] === H[1 * k + 2] && d.H[k * NE + k] === 0 && d.u.length === NE && d.u[k] === 0 && mem.old.P.length === NE * NE && mem.old.P[(k - 1) * NE + (k - 1)] === H[(k - 1) * k + (k - 1)] && mem.old.dk[k] === 0 && F.memoryResize(mem).days['2026-11-02'].H.length === NE * NE,
      'memoryResize: Gedächtnis mit zwei Wirkungen weniger auf neue Länge (alte Einträge an ihrem Platz, neue 0, zweimal anwenden ändert nichts)'); }
  assert(CX.localMs('2026-11-07T18:30') === Date.parse('2026-11-07T17:30:00Z') && CX.localMs('2026-07-01') === Date.parse('2026-06-30T22:00:00Z') && Number.isNaN(CX.localMs('7.11.')), 'localMs: Ortszeit Winter/Sommer → UTC, Unsinn → NaN');
  const now = Date.parse('2026-11-08T08:00:00Z');
  const sport = { entries: [{ von: '2026-11-07T17:00', bis: '2026-11-07T21:30', gebiet: { ags: ['08111000'] }, titel: 'VfB Stuttgart – SV Werder Bremen (bl1, Anstoß 18:30)', quelle: 'https://api.openligadb.de/x', id: 'openligadb:1', beginn: Date.parse('2026-11-07T17:30:00Z'), liga: 'bl1' }] };
  const venues = { venues: [{ id: 'Q1', ags: '08111000', cap: 15500, name: 'Schleyer-Halle' }], events: [['e1', 'Supercross', Date.parse('2026-11-07T09:00:00Z'), 'Q1', null, null, 'https://h.example/sx', 1], ['e2', 'Placebo', Date.parse('2026-11-21T19:00:00Z'), 'Q1', 'Music', 'Rock', 'https://h.example/p', 0], ['e3', 'Später', Date.parse('2026-12-20T19:00:00Z'), 'Q1', null, null, null, 0], ['e4', 'VVK ab', Date.parse('2026-11-13T09:00:00Z'), 'Q1', null, null, null, 2]] };
  const curated = [{ art: 'veranstaltung', von: '2026-11-21T19:00', bis: '2026-11-21T23:30', beginn: '2026-11-21T20:00', gebiet: { ags: ['08111000'] }, titel: 'Placebo', ort: 'Schleyer-Halle', besucher: 15500, kategorie: 'konzert', quelle: 'https://h.example/p' },
    { art: 'streik-oepnv', von: '2026-11-09', bis: '2026-11-09', gebiet: { laender: ['BW'] }, titel: 'Warnstreik', quelle: 'https://x.example' }];
  const L = CX.eventList({ sport, venues, curated, now, pastDays: 8, aheadDays: 21 });
  const vfb = L.find(e => e.src === 'sport'), pl = L.filter(e => /Placebo/.test(e.titel));
  assert(L.length === 4 && vfb?.titel === 'VfB Stuttgart – SV Werder Bremen' && vfb.liga === 'bl1' && !L.some(e => e.titel === 'Später'), `eventList: Sport ohne Ligazusatz, Fenster 8 Tage zurück bis 21 voraus (${L.map(e => e.titel).join(', ')})`);
  assert(pl.length === 1 && pl[0].src === 'liste' && pl[0].beginn === Date.parse('2026-11-21T19:00:00Z') && pl[0].cap === 15500 && pl[0].kind === 'konzert', 'eventList: gleicher Termin aus Liste und Programmseite einmal, Liste gewinnt (Beginn 20 Uhr, Besucher, Art)');
  const st = L.find(e => e.art === 'streik-oepnv');
  assert(CX.eventInScope(st, '08111000') && !CX.eventInScope(st, '05315000') && CX.eventInScope(vfb, null) && !CX.eventInScope(vfb, '05315000'), 'eventInScope: Land, Gemeinde, ganz Deutschland');
  // Wirkung: im Fenster 17–21 Uhr Ist 1,5 × Plan, übriger Tag 1,1 × Plan → bereinigt ≈ +36 %
  const p = Array.from({ length: 24 }, () => 100), a = p.map((x, h) => (h >= 17 && h <= 21 ? 150 : 110));
  const f = CX.eventEffect({ '2026-11-07': { 'ags:08111000': { p, a } } }, 'ags:08111000', vfb);
  assert(f && f.hours === 5 && f.ist === 750 && f.plan === 500 && Math.abs(f.rel - 0.5) < 1e-9 && Math.abs(f.rest - 0.1) < 1e-9 && Math.abs(f.uplift - (1.5 / 1.1 - 1)) < 1e-9, `eventEffect: Fenster 17–21 Uhr, bereinigt um den übrigen Tag (${JSON.stringify(f)})`);
  { const cx = CX.ctxLookup([], [{ art: 'streik-oepnv', von: '2026-11-09', bis: '2026-11-11', gebiet: { laender: ['BW'] }, quelle: 'x' }, { art: 'veranstaltung', von: '2026-11-10T19:00', bis: '2026-11-10T23:00', gebiet: { ags: ['08111000'] }, quelle: 'x' }]), iS = CX.CTX_KEYS.indexOf('strike'), iE = CX.CTX_KEYS.indexOf('event');
    assert(cx('08111000', '2026-11-10', 12)[iS] === 1 && cx('08111000', '2026-11-11', 23)[iS] === 1 && cx('08111000', '2026-11-12', 0)[iS] === 0 && cx('05315000', '2026-11-10', 12)[iS] === 0 && cx('08111000', '2026-11-10', 20)[iE] === 1 && cx('08111000', '2026-11-10', 18)[iE] === 0,
      'ctxLookup mit Tagesindex: mehrtägiger Streik je Land, Veranstaltung nur in ihren Stunden'); }
  assert(CX.eventEffect({ '2026-11-07': { 'ags:08111000': { p: p.map(() => null), a } } }, 'ags:08111000', vfb) === null && CX.eventEffect({}, 'ags:08111000', vfb) === null, 'eventEffect: ohne Plan oder Tag keine Wirkung');
}
// ---------- Chronos-2: Vergleich chronos und Mischung blend (lib/pulse-chronos.js, scripts/chronos.py)
{
  const CH = await import('../lib/pulse-chronos.js');
  const NOW = Date.parse(`${addDays(DAY0, NDAY - 2)}T05:20:00Z`), dd = docs.slice(0, NDAY - 1); // laufender Tag bis 6 Uhr Ortszeit beobachtet
  const h3 = F.localToUtcMs(dd.at(-1).day, 3); // laufender Tag: um 3 Uhr kein Lauf (Lücke)
  dd[dd.length - 1] = { ...dd.at(-1), runs: dd.at(-1).runs.filter(r => r[0] < NOW && !(r[0] > h3 && r[0] <= h3 + 3600e3)) }; // Läufe mit Fenster in 3–4 Uhr
  const inp = CH.chronosInput({ docs: dd, calendar: null, weather: WX, now: NOW });
  const g = inp.groups[0], ff = Math.floor(NOW / 3600e3) * 3600e3, big = groups.filter(x => inp.groups.some(y => y.k === x[0])).length;
  assert(inp.futureFrom === ff && inp.from === F.localToUtcMs(DAY0, 0) && inp.n === (ff - inp.from) / 3600e3 && g.y.length === inp.n && g.e.length === inp.n + 48 && inp.lh.length === inp.n + 48
    && Object.values(inp.cov).every(c => c.c.length === inp.n + 48 && c.t.length === inp.n + 48) && big < groups.length && big > 0,
    `Chronos-Eingabe: ${inp.n} Stunden Kontext ab 0 Uhr Ortszeit, 48 Stunden ab der laufenden Stunde, ${big} von ${groups.length} Gruppen (ab ${CH.CHRONOS.minStarts} Fahrten in 7 Tagen)`);
  const i3 = (h3 - inp.from) / 3600e3;
  assert(g.y[i3] === null && g.e[i3] === null && Number.isInteger(g.y[i3 - 1]) && Number.isInteger(g.y.at(-1)) && g.y.slice(0, 24).every(x => Number.isInteger(x)) && inp.cov[AGS[0]].c.slice(0, 24) === 'W'.repeat(24) && inp.cov[AGS[0]].c.includes('S') && inp.lh[0] === 0,
    'Chronos-Eingabe: nicht beobachtete Stunden null, Tagtyp je Ortstag, Ortsstunde je Schritt');
  // Ausgabe: alle Chronos-Werte 0 für die erste Gruppe, Rest fehlt → Schatten = aktives Modell bis auf diese Gruppe
  const k0 = inp.groups[0].k, doc = { version: 1, model: 'test', at: new Date(NOW).toISOString(), from: ff, hours: 48, groups: { [k0]: { m: new Array(48).fill(0) } } };
  const r = F.runForecast({ docs: dd, calendar: null, weather: WX, prevLog: null, now: NOW, ext: CH.chronosLookup(doc) }), iss = Object.values(r.log.issued)[0], op0 = k0.split('|')[1];
  const S_ = (a) => a.reduce((x, y) => x + y, 0), act = S_(iss.byOp[op0]), ch = iss.shadow.chronos ? S_(iss.shadow.chronos[op0]) : null, opX = Object.keys(iss.byOp).find(o => o !== op0);
  assert(iss.shadow.chronos && iss.shadow.blend && iss.ext?.chronos?.cover > 0 && iss.ext.chronos.cover < 1 && ch < S_((iss.model === 'hybrid' ? iss.byOp : iss.shadow.hybrid)[op0]) && Math.abs(S_(iss.shadow.chronos[opX]) - S_((iss.model === 'hybrid' ? iss.byOp : iss.shadow.hybrid)[opX])) < 0.5 && !['chronos', 'blend'].includes(r.latest.active),
    `Schatten chronos und blend: ${op0} ${ch?.toFixed(1)} (eine Gruppe 0, sonst Hybrid), Abdeckung ${iss.ext?.chronos?.cover}, ${opX} wie Hybrid, veröffentlicht bleibt ${r.latest.active}`);
  // Linie im Verlauf: Feld c je Gebiet (nur Gebiete, die schon in series.json stehen), vor dem Chronos-Lauf leer
  const ser = JSON.parse(JSON.stringify(r.series)); CH.chronosSeries(ser, { ...doc, groups: { [k0]: { m: new Array(48).fill(2) } } });
  const tday = F.dayOfLocal(NOW), cDE = ser.days[tday]?.DE?.c, hNow = new Date(ff).getUTCHours() + 1, other = Object.entries(ser.days[tday] || {}).find(([sc]) => sc.startsWith('op:') && sc !== `op:${k0.split('|')[1]}`);
  assert(cDE && cDE[hNow - 1] === null && cDE[hNow] === 2 && ser.days[ser.tomorrow]?.DE?.c?.every(x => x === 2) && ser.days[tday][`op:${k0.split('|')[1]}`]?.c?.[hNow] === 2 && !other?.[1].c && ser.chronos?.from === ff,
    `Verlauf: Chronos-Linie (Feld c) ab der Laufstunde für Deutschland und den Anbieter der Gruppe, morgen ganztägig (${cDE?.slice(hNow - 1, hNow + 2)})`);
  // vergangene Tage und frühe Stunden von heute: Vortagsprognose (back), wo der jüngste Lauf nicht hinreicht
  const yday = addDays(tday, -1), ser2 = JSON.parse(JSON.stringify(r.series));
  CH.chronosSeries(ser2, { ...doc, groups: { [k0]: { m: new Array(48).fill(2) } }, back: { [yday]: { from: F.localToUtcMs(yday, 0), hours: 24, groups: { [k0]: new Array(24).fill(5) } }, [tday]: { from: F.localToUtcMs(tday, 0), hours: 24, groups: { [k0]: new Array(24).fill(7) } } } });
  const cY = ser2.days[yday]?.DE?.c, cT = ser2.days[tday]?.DE?.c;
  assert(ser2.days[yday] && cY?.every(x => x === 5) && cT?.[0] === 7 && cT[hNow - 1] === 7 && cT[hNow] === 2 && ser2.chronos.backDays.join() === [yday, tday].join(),
    `Verlauf: vergangene Tage mit der Chronos-Vortagsprognose (${yday}: ${cY?.[0]}), heute vor dem Lauf Vortagsprognose, danach der Lauf`);
  const stale = { ...doc, at: new Date(NOW - 31 * 3600e3).toISOString() }, late = { ...doc, from: ff + 5 * 3600e3 };
  const rs = F.runForecast({ docs: dd, calendar: null, weather: WX, prevLog: null, now: NOW, ext: CH.chronosLookup(stale) }), rh = F.runForecast({ docs: dd, calendar: null, weather: WX, prevLog: null, now: NOW, ext: CH.chronosLookup(late) });
  assert([rs, rh].every(x => { const s0 = Object.values(x.log.issued)[0].shadow; return !s0.chronos && !s0.blend; }), 'Ohne verwendbaren Chronos-Lauf (älter als 30 h oder beginnt nach der Ausgabe) weder chronos noch blend');
  const r2 = F.runForecast({ docs: docs.slice(0, NDAY), calendar: null, weather: WX, prevLog: JSON.parse(JSON.stringify(r.log)), now: Date.parse(`${addDays(DAY0, NDAY)}T09:00:00Z`) });
  const lv = Object.values(r2.log.live).find(x => x.v === 2);
  assert(lv?.models.chronos?.w > 0 && lv.models.blend?.w > 0 && lv.ext?.chronos && !F.MODELS.includes('chronos') && r2.latest.decision.live?.chronos?.n >= 1,
    `Live-Abgleich wertet chronos (${(lv?.models.chronos?.w * 100).toFixed(1)} %) und blend (${(lv?.models.blend?.w * 100).toFixed(1)} %) mit`);
  // Selbstprüfung mit Vortagsprognosen: Chronos kennt hier die Wahrheit (Erwartungswert) → besser als Hybrid; blend lernt, sich auf Chronos zu stützen
  const evDays = days12.slice(3), NOWB = Date.parse(`${addDays(DAY0, NDAY)}T09:00:00Z`);
  const back = Object.fromEntries(evDays.map(d => [d, { from: F.localToUtcMs(d, 0), hours: 24, groups: Object.fromEntries(groups.map(g => [g[0], Array.from({ length: 24 }, (_, h) => trueMu(g, d, h))])) }]));
  const docB = { version: 1, model: 'test', at: new Date(NOWB - 3600e3).toISOString(), from: Math.floor(NOWB / 3600e3) * 3600e3, hours: 48, groups: Object.fromEntries(groups.map(g => [g[0], { m: Array.from({ length: 48 }, (_, i) => { const t = Math.floor(NOWB / 3600e3) * 3600e3 + i * 3600e3; return trueMu(g, F.dayOfLocal(t), +new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date(t)) % 24); }) }])), back };
  const extB = CH.chronosLookup(docB), rb = F.runForecast({ docs: docs.slice(0, NDAY), calendar: null, weather: WX, prevLog: null, now: NOWB, ext: extB });
  const evs = Object.entries(rb.log.evals).filter(([, e]) => e.models.chronos), sc = (e, m) => F.scoreOf(e.models[m]);
  const better = evs.filter(([, e]) => sc(e, 'chronos') < sc(e, 'hybrid')).length, blendBetter = evs.filter(([, e]) => e.models.blend && sc(e, 'blend') < sc(e, 'hybrid')).length;
  assert(evs.length >= 4 && better === evs.length && blendBetter >= evs.length - 1 && rb.latest.blend?.learn?.ownShare > 0.5 && rb.log.feedbackC?.upto && !['blend', 'chronos'].includes(rb.latest.active),
    `Selbstprüfung: Chronos an ${better} von ${evs.length} Tagen besser als Hybrid, blend an ${blendBetter}; Chronos-Anteil gelernt ${rb.latest.blend?.learn?.ownShare}; vor ${new Date(F.BLEND.activeFrom).toISOString().slice(0, 10)} veröffentlicht ${rb.latest.active}`);
  // S2.3: wählbar erst mit geprüftem Vorsprung (DM-Test über ≥ 14 Tage); hier liegen weniger Tage vor → gesperrt, mit gesenkter Tagesgrenze wählbar
  assert(rb.latest.decision?.dm?.blend && rb.latest.decision.dm.blend.ok === false && rb.latest.decision.dm.blend.n < F.DM.minDays, `S2.3: blend mit ${rb.latest.decision?.dm?.blend?.n} Prüftagen (< ${F.DM.minDays}) nicht wählbar`);
  const keep = F.DM.minDays; F.DM.minDays = 5;
  const ra = F.runForecast({ docs: docs.slice(0, NDAY), calendar: null, weather: WX, prevLog: null, now: NOWB, ext: extB });
  const iA = Object.values(ra.log.issued)[0], plan = ra.series.plans[ra.series.today];
  F.DM.minDays = keep;
  assert(['blend', 'chronos'].includes(ra.latest.active) && /Chronos/.test(ra.latest.reason) && iA.model === ra.latest.active && ['blend', 'chronos'].includes(plan?.model) && ra.latest.decision.dm[ra.latest.active].p < F.DM.p,
    `S2.3: mit geprüftem Vorsprung (DM p ${ra.latest.decision?.dm?.[ra.latest.active]?.p}) gewählt: ${ra.latest.active} (${ra.latest.reason}), Plan heute mit ${plan?.model}`);
  // scripts/chronos.py im Testmodus (ohne Modell): Eingabe → Ausgabe mit Stunden je Gruppe
  const { spawnSync } = await import('node:child_process'), { writeFileSync, readFileSync, mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const py = spawnSync('python3', ['-c', 'import pandas, numpy'], { encoding: 'utf8' });
  if (py.status === 0) {
    const bundle = CH.chronosBundle({ docs: dd, calendar: null, weather: WX, now: NOW }), backTags = bundle.runs.slice(1).map(x => x.tag);
    assert(bundle.runs[0].tag === 'main' && backTags.length >= 3 && backTags.at(-1) === tday && bundle.runs.slice(1).every(x => x.horizon === 24 && x.futureFrom === F.localToUtcMs(x.tag, 0)),
      `Chronos-Bündel: Lauf ab jetzt und Vortagsprognosen für ${backTags.join(', ')} (je 24 Stunden ab 0 Uhr, Kontext nur aus Tagen davor)`);
    const dir = mkdtempSync(join(tmpdir(), 'chronos-')); writeFileSync(join(dir, 'in.json'), JSON.stringify(bundle));
    const run = spawnSync('python3', ['scripts/chronos.py', join(dir, 'in.json'), join(dir, 'out.json')], { encoding: 'utf8', env: { ...process.env, CHRONOS_FAKE: '1' } });
    const out = run.status === 0 ? JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) : null, o0 = out?.groups?.[k0];
    assert(out && out.from === ff && out.hours === 48 && Object.keys(out.groups).length === inp.groups.length && o0.m.length === 48 && o0.m.every(x => x >= 0) && out.at === inp.at
      && Object.keys(out.back).join() === backTags.join() && out.back[tday].groups[k0]?.length === 24 && out.back[tday].from === F.localToUtcMs(tday, 0),
      `scripts/chronos.py (Testmodus): ${Object.keys(out?.groups || {}).length} Gruppen, 48 Stunden ab der laufenden Stunde, Vortagsprognosen ${Object.keys(out?.back || {}).length}${run.status ? ' – ' + run.stderr.slice(-200) : ''}`);
    const lk = CH.chronosLookup(out);
    assert(lk.hasBack(tday) && Number.isFinite(lk.back(k0, F.localToUtcMs(tday, 5))) && Number.isNaN(lk.back('x|y|z', F.localToUtcMs(tday, 5))) && Number.isFinite(lk.live(k0, ff)) && lk.usable(ff) && !lk.usable(ff + 49 * 3600e3), 'chronosLookup: Vortagsprognose je Ortsstunde, laufende Prognose, Gültigkeit');
    const fr = spawnSync('python3', ['-c', `import json,sys; sys.path.insert(0,'scripts'); import chronos; runs=json.load(open('${join(dir, 'in.json')}'))['runs']; df,fu=chronos.frames_all([r for r in runs if r['horizon']==48]); print(len(df), len(fu), str(df['c'].dtype), int(df['target'].isna().sum()), sorted(set(fu['item_id']))==sorted(set(df['item_id'])))`], { encoding: 'utf8' });
    const [nDf, nFu, dt, nNan, same] = fr.stdout.trim().split(' ');
    assert(fr.status === 0 && +nDf === inp.groups.length * inp.n && +nFu === inp.groups.length * 48 && dt === 'category' && +nNan > 0 && same === 'True', `chronos.py: Tabellen für Chronos-2 (Kontext ${nDf}, Zukunft ${nFu} Zeilen, Tagtyp kategorial, fehlende Stunden NaN)${fr.status ? ' – ' + fr.stderr.slice(-200) : ''}`);
    // echter Pfad mit Ersatzpaketen chronos/torch: das installierte Paket wird gefunden, obwohl das Skript chronos.py heißt (erster Lauf 07.11.2026)
    const { mkdirSync } = await import('node:fs'), stub = join(dir, 'pkgs');
    mkdirSync(join(stub, 'chronos'), { recursive: true }); mkdirSync(join(stub, 'torch'), { recursive: true });
    writeFileSync(join(stub, 'torch', '__init__.py'), 'def set_num_threads(n): pass\n');
    writeFileSync(join(stub, 'chronos', '__init__.py'), [
      'class Chronos2Pipeline:', '    @classmethod', '    def from_pretrained(cls, name, device_map=None): return cls()',
      '    def predict_df(self, df, future_df=None, id_column=None, timestamp_column=None, target=None, prediction_length=None, quantile_levels=None, batch_size=None):',
      '        out = future_df[[id_column, timestamp_column]].copy(); out["predictions"] = 2.5; out["0.1"] = 1.0; out["0.5"] = 2.5; out["0.9"] = 4.0', '        return out', ''].join('\n'));
    const real = spawnSync('python3', ['scripts/chronos.py', join(dir, 'in.json'), join(dir, 'out2.json')], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: stub } });
    const o2 = real.status === 0 ? JSON.parse(readFileSync(join(dir, 'out2.json'), 'utf8')) : null;
    assert(o2?.model === 'amazon/chronos-2' && o2.groups[k0]?.m.every(x => x === 2.5) && o2.groups[k0].q90[0] === 4 && o2.back[tday]?.groups[k0]?.every(x => x === 2.5), `chronos.py lädt das Paket chronos, nicht sich selbst; Läufe je Prognoselänge (48 h, 24 h) getrennt${real.status ? ' – ' + real.stderr.slice(-300) : ''}`);
  } else console.log('übersprungen: chronos.py (python3 mit pandas fehlt)');
}

// ---------- je Fahrzeugfamilie ein eigenes Modell (08.11.2026) ----------
{
  // Welt wie oben, dazu Carsharing-Gruppen mit eigenem, flachem Tagesgang (Buchungen über den Tag) – das Mikro-Modell darf davon nichts sehen
  const carG = AGS.slice(0, 3).map(a => [`${a}|stadtmobil|car`, 30, 0.04]);
  const mk = (day) => { const d = makeDoc(day); for (const g of carG) { const start = [], vmin = []; for (let h = 0; h < 24; h++) { start.push(pois(g[1] * g[2] * (h >= 7 && h < 20 ? 1.5 : 0.3))); vmin.push(g[1] * 60); } d.groups[g[0]] = { start, vmin }; } return d; };
  const ds = days12.slice(0, 8).map(mk), NOW = Date.parse(`${addDays(DAY0, 8)}T10:00:00Z`);
  const micro = F.familyDocs(ds, 'micro'), car = F.familyDocs(ds, 'car'), moped = F.familyDocs(ds, 'moped');
  assert(micro.every(d => Object.keys(d.groups).every(k => !k.endsWith('|car'))) && car.every(d => Object.keys(d.groups).length === 3 && d.runs === ds[0].runs || d.runs.length === ds[0].runs.length)
    && F.familyHasData(car) && !F.familyHasData(moped) && F.FAMILY_DIR.micro === 'forecast' && F.FAMILY_DIR.car === 'forecast/car', 'familyDocs: Gruppen je Familie, Läufe bleiben; E-Roller ohne Daten');
  const rM = F.runForecast({ docs: micro, calendar: null, weather: [], prevLog: null, now: NOW }), rA = F.runForecast({ docs: ds, calendar: null, weather: [], prevLog: null, now: NOW });
  const rC = F.runForecast({ docs: car, calendar: null, weather: [], prevLog: null, now: NOW, family: 'car' });
  const keysM = Object.keys(rM.latest.groups), keysC = Object.keys(rC.latest.groups);
  assert(keysM.length && keysM.every(k => !k.endsWith('|car')) && keysC.length === 3 && keysC.every(k => k.endsWith('|car')) && rC.latest.family === 'car' && rC.series.family === 'car' && rM.latest.family === undefined,
    `getrennte Modelle: Mikro ${keysM.length} Gruppen ohne Autos, Carsharing ${keysC.length} Gruppen, Familie im Datenstand`);
  // Carsharing lernt seinen eigenen Tagesgang (tagsüber 1,5, nachts 0,3 → Faktor ≈ 5); im gemeinsamen Modell (rA) teilten Autos Stunde und Wetter mit den Scootern
  const loc = rC.latest.horizon?.local || [], hourIx = (h) => loc.findIndex(([, hh]) => hh === h), tot = rC.latest.totals || [];
  const day = tot[hourIx(13)], night = tot[hourIx(3)], rat = day / Math.max(night, 1e-6);
  assert(rC.latest.trainDays >= 2 && rat > 2.5 && rat < 10 && Object.keys(rA.latest.groups).some(k => k.endsWith('|car')), `Carsharing-Modell: eigener Tagesgang (13 Uhr ÷ 3 Uhr = ${rat.toFixed(1)}, wahr 5)`);
}

// ---------- Prognose-Ansicht: Gruppen der gewählten Stadt bzw. des Anbieters (11.11.2026)
{
  const { scopeGroups } = await import('../docs/forecast.js') /* gebaute Fassung: importiert lib/ als ./pulse-*.js */;
  const fbRow = (y, eP, eQ) => [y, 0, 0, eP * y, eQ * y];
  const G = { feedback: { groups: { '08416041|Voi|scooter': fbRow(3200, 0.37, 0.34), '08416041|Bolt|scooter': fbRow(2400, 0.34, 0.36), '08416041|Dott|scooter': fbRow(1, 0.5, 0.5), '08111000|Voi|scooter': fbRow(16000, 0.24, 0.24) } } };
  const L = { groups: { '08416041|Voi|scooter': { start: [300, 288], perVeh: 2.9 }, '08416041|Bolt|scooter': { start: [200, 216], perVeh: 2.8 }, '08111000|Voi|scooter': { start: [3054], perVeh: 2.2 } } };
  const tue = scopeGroups({ scope: '08416041', operator: 'all', type: 'all' }, null, G, L);
  const voi = scopeGroups({ scope: 'DE', operator: 'Voi', type: 'all' }, null, G, L, { maxDE: 1 });
  assert(scopeGroups({ scope: 'DE', operator: 'all' }, null, G, L) === null
    && tue.rows.map(r => r.k.split('|')[1]).join() === 'Voi,Bolt,Dott' && tue.rows[0].exp === 588 && Math.abs(tue.rows[0].eP - 0.37) < 1e-9 && tue.rows[2].exp === null && tue.rows[2].y === 1
    && tue.rows.every(r => r.w > 0 && r.w < 1)
    && voi.rows.length === 1 && voi.rows[0].k === '08111000|Voi|scooter' && voi.more === 1
    && scopeGroups({ scope: '08416041', operator: 'all', type: 'bike' }, null, G, L).rows.length === 0,
  'Prognose je Stadt/Anbieter: Gruppen gefiltert (Stadt, Anbieter, Art), nach erwarteten Fahrten sortiert, Treffer und Lernanteil je Gruppe, bundesweit gekappt');
}
// Audit MET-08: eine Quelle für die Live-Abweichung (Ansicht und Bericht), Modell und „wie gestern“ über dieselben Stunden, 7 Tage
{
  const now = Date.parse('2026-11-11T20:00:00Z'), d = 86400e3;
  const live = [{ at: now - 9 * d, from: now - 9 * d, wapeOpH: 0.1, wapeOpHn: 0.9, naiveOpH: 0.9 }, { at: now - d, from: now - d + 3600e3, wapeOpH: 0.15, wapeOpHn: 0.2, naiveOpH: 0.3, hours: 22 },
    { at: now - 2 * 3600e3, from: now - 3600e3, wapeOpH: 0.1, wapeOpHn: 0.2, naiveOpH: 0.34 }, { at: now - 3600e3, wapeOpH: 0.1 }];
  const ls = F.liveSummary(live, { now });
  assert(ls.n === 2 && Math.abs(ls.a - 0.2) < 1e-9 && Math.abs(ls.b - 0.32) < 1e-9 && Math.abs(ls.ratio - 0.625) < 1e-9 && ls.h === 23 && ls.targetDays === 2 && F.liveSummary([], { now }) === null && F.liveSummary(live).n === 2,
    'liveSummary: wapeOpHn gegen naiveOpH, nur letzte 7 Tage, Einträge ohne Vergleich übersprungen; ohne now Bezug = jüngste Prognose');
}
// Audit MET-03 (Schatten): faire Teilwertung nur über Zeilen mit Vortagswert; Hauptwertung unverändert
{
  const R = { y: [10, 10, 10, 10], g: [0, 0, 1, 1] }, sel = [0, 1, 2, 3], mu = [10, 10, 0, 0], mask = Uint8Array.from([1, 1, 0, 0]);
  const a = F.scoreDay(R, sel, mu, 1), b = F.scoreDay(R, sel, mu, 1, { mask });
  assert(a.wapeGH === 0.5 && b.wapeGH === 0.5 && !a.fair && b.fair.wapeGH === 0 && b.fair.n === 2 && b.fair.starts === 20 && b.fair.bias === 0,
    'scoreDay mask: „wie gestern“ ohne Vortagswert (0) zählt in der fairen Schattenwertung nicht, Hauptwertung bleibt');
}
// Vortrainiertes Modell zum Mitnehmen: die exportierten Parameter reproduzieren die Prognose des gepoolten Modells (Gruppenniveau a_g)
{
  const ds = F.assignEras(docs.map(d => F.dayFromDoc(d, null))), R = F.buildRows(ds, F.wxLookup(WX)), all = Array.from({ length: R.n }, (_, i) => i);
  const m = F.fitPooled(R, all, { weather: true }), P = F.portableModel(m, R, { family: 'micro', now: Date.parse('2026-11-11T21:00:00Z'), trainDays: 9 });
  const CL = ['W', 'F', 'S', 'H'], mu = F.predictPooled(m, R, all); let maxRel = 0;
  for (let i = 0; i < R.n; i += 97) { if (R.era[i] > 0 || !(R.e[i] > 0)) continue; const ty = String(R.keys[R.g[i]]).split('|')[2], T = P.types[ty] || Object.values(P.types).find(x => x.also.includes(ty));
    const eta = m.a[R.g[i]] + P.hour[R.hr[i]] + P.dayType[CL[R.cl[i]]][R.hr[i]] + T.hour[R.hr[i]] + P.weather.cold * R.w[0][i] + P.weather.warm * R.w[1][i] + P.weather.rain * R.w[2][i] + P.weather.rain1 * R.w[3][i] + P.weather.rain4 * R.w[4][i] + P.weather.rainPrev * R.w[5][i];
    maxRel = Math.max(maxRel, Math.abs(R.e[i] * Math.exp(eta) / mu[i] - 1)); }
  const op = Object.keys(P.operators)[0];
  assert(P.kind === 'mobility-pulse/portable-model' && maxRel < 0.002 && op && Number.isFinite(P.operators[op]) && Object.values(P.types).every(x => x.level.p25 <= x.level.p50 && x.level.p50 <= x.level.p75) && Object.keys(P.city).length > 0 && JSON.stringify(P).length < 60000,
    `portableModel: Stunde, Tagtyp, Art und Wetter reproduzieren predictPooled (größte Abweichung ${(maxRel * 100).toFixed(3)} %), Anbieter- und Stadtniveau, Quantile geordnet, klein`);
  assert(F.portableModel(null, R) === null, 'portableModel ohne Modell: null');
}
{ // S2.2/S2.3: bessere Basis, Summenverhältnis, DM-Test, Wechselsperre
  assert(Math.abs(F.tCdf(0, 5) - 0.5) < 1e-9 && Math.abs(F.tCdf(-2.015, 5) - 0.05) < 0.001 && Math.abs(F.tCdf(1.761, 14) - 0.95) < 0.001, 't-Verteilung: Quantile 0,05 (ν 5) und 0,95 (ν 14)');
  const a = Array.from({ length: 14 }, (_, i) => 0.20 + 0.01 * Math.sin(i)), b = a.map((x, i) => x + 0.02 + 0.005 * Math.cos(i * 3));
  const t1 = F.dmTest(a, b), t2 = F.dmTest(b, a), t3 = F.dmTest(a.slice(0, 2), b.slice(0, 2));
  assert(t1.p < 0.01 && t2.p > 0.99 && t3 === null && t1.n === 14, `DM-HLN: a durchgehend 2 Punkte besser → p ${t1.p}; umgekehrt ${t2.p}; unter 3 Tagen kein Test`);
  const day = (i) => `2026-11-${String(i + 1).padStart(2, '0')}`, E = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { wapeGD: v, wapeGH: v }]));
  const ev = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [day(i), { trainDays: 8, models: E({ profile: 0.2, pooled: 0.21, hybrid: 0.18, naive: 0.25, week: 0.2 + (i % 2) * 0.02, blend: 0.15 + 0.004 * Math.sin(i), chronos: 0.179 + 0.004 * Math.cos(i) }) }]));
  const sr = F.selfRelative(ev, 'hybrid', Object.keys(ev).slice(-7));
  assert(sr.base === 'week' && Math.abs(sr.r - (7 * 0.18) / (0.2 * 7 + 0.02 * 3)) < 0.02, `S2.2: Maßstab gegen die bessere Basis (Vorwoche), Summenverhältnis ${sr.r.toFixed(3)}`);
  const g = F.dmGate(ev, 'hybrid');
  assert(g.tests.blend.ok && !g.without.includes('blend') && !g.tests.chronos.ok && g.without.includes('chronos'), `S2.3: blend mit DM p ${g.tests.blend.p} freigegeben, chronos (kaum besser, p ${g.tests.chronos.p}) gesperrt`);
  const c = F.chooseModel(ev, { trainDays: 16 }), few = F.chooseModel(Object.fromEntries(Object.entries(ev).slice(-10)), { trainDays: 10 });
  assert(c.active === 'blend' && few.active === 'hybrid' && few.dm.blend.ok === false, `S2.3: über 16 Tage blend gewählt, über 10 Tage gesperrt (${few.active})`);
  const now = Date.parse('2026-11-16T12:00:00Z'), held = F.chooseModel(ev, { trainDays: 16, prevActive: 'hybrid', switchedAt: now - 2 * 86400e3, nowMs: now }), free = F.chooseModel(ev, { trainDays: 16, prevActive: 'hybrid', switchedAt: now - 8 * 86400e3, nowMs: now });
  assert(free.active === 'blend' && (held.active === 'blend' ? held.scores.blend / held.scores.hybrid <= 0.9 : held.active === 'hybrid' && held.why.held === 'blend'),
    `S2.3: Wechselsperre 7 Tage (2 Tage nach dem Wechsel: ${held.active}${held.why?.held ? `, gehalten statt ${held.why.held}` : ''}; nach 8 Tagen: ${free.active})`);
  const lv = { 1: { v: 2, from: now - 2 * 86400e3, models: { naive: { w: 0.3 }, week: { w: 0.2 }, hybrid: { w: 0.18 } } }, 2: { v: 2, from: now - 86400e3, models: { naive: { w: 0.3 }, week: { w: 0.25 }, hybrid: { w: 0.2 } } } };
  const L = F.liveRelative(lv, { nowMs: now });
  assert(L.hybrid.base === 'week' && L.hybrid.r > 0.8 && L.hybrid.r < 0.9 && L.naive.r > 1, `S2.2: live gegen die bessere Basis (Vorwoche) als Summenverhältnis: hybrid ${L.hybrid.r}, „wie gestern“ ${L.naive.r}`);
}
{ // S2.1: je volle Stunde – Takt von 3 bzw. 4 Läufen je Stunde (18 Minuten) springt im Rohwert, nicht mehr im Modellwert
  const day = '2026-11-10', t0 = F.localToUtcMs(day, 0), runs = [], start = new Array(24).fill(0), vmin = new Array(24).fill(0);
  for (let t = t0 + 18 * 60e3; t < t0 + 24 * 3600e3; t += 18 * 60e3) { runs.push([t, 18 * 60e3, 1, 'M1@x']); const h = new Date(t).getUTCHours() + 1 > 23 ? 0 : (new Date(t).getUTCHours() + 1) % 24; start[h] += 9; vmin[h] += 18 * 50; } // je Lauf 9 Starts, 50 Fahrzeuge
  const doc = { day, runs, groups: { '08416041|Voi|scooter': { start, vmin } }, gapHours: [] }, d = F.dayFromDoc(doc, null), g = d.groups['08416041|Voi|scooter'];
  const raw = start.slice(2, 22), n = g.start.slice(2, 22), v = g.vmin.slice(2, 22);
  assert(Math.max(...raw) / Math.min(...raw) >= 1.3 && n.every(x => Math.abs(x - 30) < 0.01) && v.every(x => Math.abs(x - 3000) < 0.01) && d.groupsRaw['08416041|Voi|scooter'].start === start,
    `S2.1: Rohwert springt (${Math.min(...raw)}/${Math.max(...raw)} je Stunde), je volle Stunde konstant ${n[0].toFixed(1)} Starts und ${v[0] / 60} Fahrzeuge; Ist im Verlauf bleibt gezählt`);
  const dp = F.dayFromDoc({ ...doc, pVersion: 1, obsP: new Array(24).fill(30), groups: { k: { start, vmin, startP: new Array(24).fill(12), vminP: new Array(24).fill(1500) } } }, null).groups.k;
  assert(dp.start[5] === 24 && dp.vmin[5] === 3000, 'S2.1: mit anteiligen Feldern (S1.1) startP/vminP × 60 ÷ obsP');
  assert(F.countedFactor([{ day: '2026-11-09', obsEnd: Object.assign(new Array(24).fill(54), { 7: 72 }) }], day, 7) === 1.2 && F.countedFactor([], day, 7) === 1, 'S2.1: Plan/Live im Verlauf gezählt: × Minuten der Stunde am letzten beobachteten Tag ÷ 60');
}
{ // S2.5: Sonntag ohne Morgenstunden im Training erbt den Wochenend-Tagesgang (Samstag), nicht den Werktag
  const G = '08416041|Voi|scooter', mk = (day, rate, hours) => { const runs = [], start = new Array(24).fill(0), vmin = new Array(24).fill(0);
    for (const h of hours) { const t = F.localToUtcMs(day, h); for (let k = 1; k <= 4; k++) runs.push([t + k * 900e3 - (h === 23 && k === 4 ? 1 : 0), 900e3, 1, 'M1@x']); start[h] = Math.round(rate(h) * 100); vmin[h] = 100 * 60; }
    return F.dayFromDoc({ day, runs, groups: { [G]: { start, vmin } }, gapHours: [] }, null); };
  const all = [...Array(24).keys()], wk = (h) => (h === 8 ? 1.0 : 0.3), we = (h) => (h === 8 ? 0.1 : 0.3);
  const days = F.assignEras([mk('2026-11-02', wk, all), mk('2026-11-03', wk, all), mk('2026-11-04', wk, all), mk('2026-11-07', we, all), mk('2026-11-08', we, all.filter(h => h >= 10))]);
  const R = F.buildRows(days), sel = Array.from({ length: R.n }, (_, i) => i), m = F.fitPooled(R, sel, {});
  const fut = [{ day: '2026-11-15', h: 8, cls: days[4].cls }], Fu = F.buildFuture(R, fut, () => 100, () => null, null), mu = F.predictPooled(m, Fu, [0])[0], pr = F.predictProfile(R, sel, [0], Fu, NaN)[0];
  assert(mu < 25 && pr < 15, `S2.5: Sonntag 8 Uhr ohne Sonntagsdaten wie Samstag (Modell ${mu.toFixed(1)}, Profil ${pr.toFixed(1)} Starts je 100 Fahrzeuge; Werktag 100, Samstag 10)`);
}
{ // S2.6: Mindestvolumen für E-Roller und Carsharing – darunter die Vorwoche (oder nichts)
  const ds = days12.map(d => makeDoc(d, { level: 0.05 })), NOW = Date.parse(`${addDays(DAY0, NDAY - 1)}T08:00:00Z`);
  const vol = F.volumeOf(ds.map(d => F.dayFromDoc(d, null)));
  const r = F.runForecast({ docs: ds, calendar: null, weather: [], prevLog: null, now: NOW, family: 'moped' }), rm = F.runForecast({ docs: ds, calendar: null, weather: [], prevLog: null, now: NOW });
  const r6 = F.runForecast({ docs: ds.slice(0, 5), calendar: null, weather: [], prevLog: null, now: Date.parse(`${addDays(DAY0, 5)}T08:00:00Z`), family: 'car' });
  assert(vol < 500 && r.latest.status === 'small' && r.latest.active === 'week' && r.latest.totals?.every(Number.isFinite) && rm.latest.status !== 'small' && r6.latest.status === 'small' && r6.latest.active === null && !r6.latest.totals,
    `S2.6: ${Math.round(vol)} Fahrtbeginne je Tag < 500 → E-Roller veröffentlicht die Vorwoche (${r.latest.reason}); ohne Vorwoche keine Prognose; micro ohne Grenze`);
}
{ // S2.4: Selbstprüfung ohne beobachtetes Wetter des Prüftags – nur die damals gesicherte Vorhersage
  const ds = F.assignEras(docs.slice(0, 8).map(d => F.dayFromDoc(d, null))), wx = F.wxLookup(WX), R = F.buildRows(ds, wx), d = 7;
  const fcDoc = JSON.parse(JSON.stringify(WX.find(w => w.day === ds[d].day))); for (const c of Object.values(fcDoc.cells)) { c.t = c.t.map(() => 99); c.p = c.p.map(() => 0); } // „Vorhersage“ erkennbar falsch
  const seen = []; const spy = (ags, day, h) => { seen.push(day); return F.wxLookup([fcDoc])(ags, day, h); };
  const before = Float64Array.from(R.w[1]);
  const ev = F.evaluateDays(R, [d], { dayName: (i) => ds[i].day, days: ds, wxTest: spy });
  const test = []; for (let i = 0; i < R.n; i++) if (R.day[i] === d) test.push(i);
  assert(ev[d] && seen.length && seen.every(x => x === ds[d].day) && R.w[1].every((x, i) => x === before[i]) && ev[d].wxFc >= 0,
    `S2.4: Prüftag ${ds[d].day} nimmt das Wetter nur aus der gesicherten Vorhersage (${seen.length} Abfragen, Anteil ${ev[d].wxFc}), das beobachtete Wetter der Zeilen ist danach unverändert`);
  const back = F.swapTestWeather(R, test, () => null);
  assert(test.every(i => R.hasW[i] === 0 && R.w[2][i] === 0) && back.share === 0, 'S2.4: ohne gesicherte Vorhersage geht der Prüftag ohne Wetter in die Prüfung (kein Orakel)'); back();
  assert(test.some(i => R.hasW[i] === 1), 'S2.4: danach wieder wie vorher');
}
{ // S2.7: konformes Band je Tageszeit – bei zu vielen Fehlern wird es breiter, bei zu wenigen schmaler
  let c = F.emptyConformal(); for (let i = 0; i < 20; i++) c = F.conformalUpdate(c, F.CONFORMAL.bands.map((_, b) => (b === 1 ? [5, 10] : b === 3 ? [0, 10] : [2, 10])));
  const [lo, hi] = F.bandOf80(100, 1, c.k[1]);
  assert(c.k[1] > 1.5 && c.k[3] < 0.7 && Math.abs(c.k[0] - 1) < 0.01 && c.n[1] === 20 && lo < 100 - 1.28 * 10 && hi > 100 + 1.28 * 10,
    `S2.7: Fehlquote 50 % (Morgen) → k ${c.k[1]}, 0 % (Mittag) → k ${c.k[3]}, 20 % bleibt k ${c.k[0]}`);
}
{ // S2.8: Verzerrung je Art aus der Selbstprüfung, Strukturbrüche je Gruppe
  const ev = Object.fromEntries(['2026-11-05', '2026-11-06', '2026-11-07'].map(d => [d, { trainDays: 5, models: { hybrid: { byType: { scooter: [0.1, 0.2, 10000, 11000], bike: [0.1, 0.2, 1000, 900], cargo: [0.1, 0.2, 5, 9] } } } }]));
  const tf = F.typeFactors(ev, 'hybrid');
  assert(Math.abs(tf.scooter - (30000 + 500) / (33000 + 500)) < 1e-3 && tf.bike > 1.05 && Math.abs(tf.cargo - (15 + 500) / (27 + 500)) < 1e-3 && Object.keys(F.typeFactors(ev, 'pooled')).length === 0,
    `S2.8: Faktor je Art = (Σ Ist + 500) ÷ (Σ Prognose + 500): E-Scooter ${tf.scooter}, Rad ${tf.bike}, Lastenrad (wenig Daten) ${tf.cargo}`);
  const NOW = Date.parse(`${addDays(DAY0, NDAY - 1)}T08:00:00Z`), k0 = groups[0][0];
  const rb = F.runForecast({ docs: docs.slice(0, NDAY - 1), calendar: null, weather: [], prevLog: null, now: NOW, breaks: { [k0]: addDays(DAY0, 6) } });
  assert(rb.latest.breaks === 6 && rb.latest.groups[k0] && rb.latest.biasCorr !== undefined, `S2.8: Gruppe mit Strukturbruch lernt erst ab dem Bruchtag (${rb.latest.breaks} Gruppe-Tage ausgelassen), Prognose bleibt`);
}
{ // S2.8 je Gemeinde: geschrumpft zum Faktor der Art; kleine Gemeinden behalten den der Art
  const ev = Object.fromEntries(['2026-11-05', '2026-11-06', '2026-11-07'].map(d => [d, { trainDays: 5, models: { pooled: { byType: { scooter: [0.1, 0.2, 2000, 2000] },
    byAgsType: { '08111000|scooter': [1000, 800], '08416041|scooter': [30, 60] } } } }]));
  const tf = F.typeFactors(ev, 'pooled'), af = F.agsFactors(ev, 'pooled', tf);
  assert(tf.scooter === 1 && Math.abs(af['08111000|scooter'] - (3000 + 500) / (2400 + 500)) < 1e-3 && Math.abs(af['08416041|scooter'] - (90 + 500) / (180 + 500)) < 1e-3,
    `S2.8: Stuttgart ${af['08111000|scooter']} (Σ 3000 Ist / 2400 Prognose), Tübingen ${af['08416041|scooter']} (wenig Fahrten, nah an der Art)`);
  assert(F.biasFactorOf('08111000|Voi|scooter', tf, af) === af['08111000|scooter'] && F.biasFactorOf('09162000|Voi|scooter', tf, af) === 1 && F.biasFactorOf('09162000|Voi|bike', tf, af) === 1, 'S2.8: Faktor je Gruppe: Gemeinde und Art vor Art vor 1');
  const R = { keys: ['08111000|Voi|scooter', '08111000|Bolt|scooter', '08416041|Voi|scooter'], y: [12, 8, 1], g: [0, 1, 2], hr: [8, 8, 8] };
  const sd = F.scoreDay(R, [0, 1, 2], Float64Array.from([10, 10, 2]), 1, { split: true, byAgs: true });
  assert(JSON.stringify(sd.byAgsType) === JSON.stringify({ '08111000|scooter': [20, 20] }) && !F.scoreDay(R, [0, 1, 2], Float64Array.from([10, 10, 2]), 1, { split: true }).byAgsType, 'S2.8: scoreDay sammelt je Gemeinde und Art erst ab 20 Fahrtbeginnen und nur auf Wunsch');
}
{ // S2.7: Band aus Chronos-Quantilen (aktiv Chronos/Mischung) – Wurzel der Quadratsumme je Anbieter, konformes k wie beim Poisson-Band
  const from = Date.parse('2026-11-13T07:00:00Z'), doc = { version: 1, at: '2026-11-13T06:30:00Z', from, hours: 2, groups: { 'A|Voi|scooter': { m: [10, 12], q10: [7, 9], q90: [14, 16] }, 'B|Voi|scooter': { m: [5, 5], q10: [1, 2], q90: [8, 8] }, 'C|Voi|bike': { m: [3, 3] } } };
  const CH = await import('../lib/pulse-chronos.js'), ext = CH.chronosLookup(doc);
  assert(JSON.stringify(ext.quant('A|Voi|scooter', from)) === '[3,4]' && ext.quant('C|Voi|bike', from) === null && ext.quant('A|Voi|scooter', from + 5 * 3600e3) === null, 'S2.7: chronosLookup.quant liefert halbe Breiten [m − q10, q90 − m], ohne Quantile null');
  const keys = Object.keys(doc.groups), bq = F.quantileBands(keys, [[0, 0, from], [1, 0, from], [2, 0, from], [0, 1, from + 3600e3]], ext.quant, 2);
  assert(bq.Voi[0][0] === +Math.hypot(3, 4).toFixed(1) && bq.Voi[0][1] === +Math.hypot(4, 3).toFixed(1) && bq.Voi[1][0] === 3, `S2.7: Breite je Anbieter und Stunde = √Σ w² (${JSON.stringify(bq.Voi)})`);
  assert(JSON.stringify(F.bandOfQ(15, [5, 5], 1.2)) === '[9,21]' && F.bandOfQ(2, [5, 1], 1)[0] === 0, 'S2.7: bandOfQ skaliert mit k und schneidet bei 0');
}
{ // A13: Autobahn nicht mehr als Merkmal, Standardfehler nach Tagen geclustert
  const ds = F.assignEras(docs.map(d => F.dayFromDoc(d, null))), R = F.buildRows(ds, F.wxLookup(WX)), all = Array.from({ length: R.n }, (_, i) => i);
  const iR = F.CTX_KEYS.indexOf('road'); for (let i = 0; i < R.n; i++) R.c[iR][i] = 1;
  const m = F.fitPooled(R, all, { weather: true }), se = F.daySE(m, R);
  assert(!F.ctxActive(R, all).includes(iR) && se.cold > 0 && se.rain > 0 && Object.keys(se).includes('rainPrev'), `A13: Autobahn bleibt aus, obwohl jede Zeile sie trägt; Standardfehler je Tag geclustert (kalt ${se.cold}, Regen ${se.rain})`);
}
{ // A14: Veranstaltungen mit „abgesagt“ oder „VVK“ irgendwo im Titel fallen weg
  const CX = await import('../lib/pulse-context.js');
  const venues = [{ id: 'v1', ags: '08111000', cap: 10000, name: 'Halle' }], t = Date.parse('2026-11-20T19:00:00Z');
  const rows = [['e1', 'Konzert X – abgesagt', t, 'v1', 'Konzert', null, 'https://x.example', 0], ['e2', 'Show Y (VVK läuft)', t, 'v1', 'Show', null, 'https://x.example', 0], ['e3', 'Konzert Z', t, 'v1', 'Konzert', null, 'https://x.example', 0]];
  const out = CX.venueEntries(rows, venues, { now: t - 86400e3 });
  assert(out.length === 1 && out[0].id === 'e3', `A14: abgesagte und VVK-Einträge verworfen (${out.map(x => x.id).join(', ')})`);
}
