import * as F from '../lib/pulse-forecast.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };

// ---------- deterministische Zufallszahlen und Poisson
let seed = 20261104; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const norm = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const pois = (l) => { if (l <= 0) return 0; if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * norm())); let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rnd(); } while (p > L); return k - 1; };

// ---------- kleine Bausteine
assert(JSON.stringify(F.wxFeatures(0, 0)) === JSON.stringify([-1, 0, 0]) && JSON.stringify(F.wxFeatures(20, 1.2)) === JSON.stringify([0, 1, 1]) && F.wxFeatures(null, 0) === null, 'Wettermerkmale: kalt/warm mit Knick bei 10 °C, Regen ab 0,1 mm/h, ohne Messwert null');
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
  const runs = []; for (let h = 0; h < 24; h++) { if (skipHours.includes(h)) continue; const t = F.localToUtcMs(day, h); for (let k = 0; k < 4; k++) runs.push([t + k * 900e3 + 120e3, 900e3, 1, rule]); }
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
  const ds = F.assignEras(docs.slice(0, 7).map(d => F.dayFromDoc(d, null))), R = F.buildRows(ds);
  const train = [], test = []; for (let i = 0; i < R.n; i++) (R.day[i] < 6 ? train : test).push(i);
  const m = F.fitPooled(R, train, { weather: false }), a = F.scoreDay(R, test, F.predictPooled(m, R, test), m.phi), b = F.scoreDay(R, test, F.predictProfile(R, train, test));
  assert(a.wapeGH < b.wapeGH, `Pooling: Fehler je Gruppe-Stunde ${(a.wapeGH * 100).toFixed(0)} % < ${(b.wapeGH * 100).toFixed(0)} % je Gruppe getrennt (nur ${6} Trainingstage, viele kleine Gruppen)`);
  assert(Math.abs(a.bias) < 0.08, `Pooling: Verzerrung der Summe klein (${(a.bias * 100).toFixed(1)} %)`);
  assert(a.cover80 > 0.65, `80-%-Band deckt ${(a.cover80 * 100).toFixed(0)} % der Gruppe-Stunden`);
}

// ---------- Wettereffekt wird wiedergefunden
{
  const ds = F.assignEras(docs.map(d => F.dayFromDoc(d, null))), R = F.buildRows(ds, F.wxLookup(WX)), all = Array.from({ length: R.n }, (_, i) => i);
  const m = F.fitPooled(R, all, { weather: true }), e = F.wxEffects(m);
  assert(Math.abs(e.cold - TRUE.cold) < 0.1 && Math.abs(e.warm - TRUE.warm) < 0.1 && Math.abs(Math.log(e.rain) - TRUE.rain) < 0.1, `Wetterwirkung gelernt: kalt ${e.cold.toFixed(2)} (0,3), warm ${e.warm.toFixed(2)} (0,2), Regen ×${e.rain.toFixed(2)} (×${Math.exp(TRUE.rain).toFixed(2)})`);
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
