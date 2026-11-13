// Prüfstand (P1): Fahrterkennung (trackRun aus lib/pulse-track.js oder einem Kandidaten wie lib/pulse-track-next.js) gegen die Wahrheit
// des Simulators. Je Lauf: GBFS-Dokument → readGbfsSystem → dedupeVehicles → trackRun mit trace-Rückruf (Zuordnung Ereignis → Fahrzeug).
// Kennzahlen aus der Ausgabe (hourly, srcModes, state), die Zuordnung nur für Präzision, Trefferquote und Fehlergründe.
import path from 'node:path';
import * as SIM from './sim.mjs';

export const TRACK = (file = 'pulse-track.js') => import(path.join(SIM.REPO, 'lib', file));
const SUMF = ['start', 'end', 'reloc', 'swap', 'pickup', 'disOn', 'disOff', 'rot', 'vmin', 'vminTot', 'slow', 'fast', 'hide'];
const SUMS = ['tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN'];
const hourlyObj = (m) => Object.fromEntries([...m].sort((a, b) => a[0] < b[0] ? -1 : 1));
const sumHourly = (m) => { const o = Object.fromEntries([...SUMF, ...SUMS].map(f => [f, 0])); for (const h of m.values()) { for (const f of SUMF) o[f] += (h[f] || []).reduce((a, b) => a + b, 0); for (const f of SUMS) o[f] += h[f] || 0; } return o; };
const EXPECT = { stable: 'stable', trip: 'rotating', run: 'rotating' };

/**
 * Ein Szenario × Kennungsmodus durch die Fahrterkennung schicken.
 * T: Modul mit trackRun (Standard lib/pulse-track.js); check: zusätzlich ohne trace rechnen und vergleichen (trace ändert keine Regel).
 */
export async function runCase(world, mode, { T, check = false } = {}) {
  T ??= await TRACK();
  const keyPhys = new Map(), log = [], per = [];
  let st = null, stPlain = null, equal = true, firstDiff = null;
  for (let k = 0; k < world.runs.length; k++) {
    const at = world.runs[k].at, fbs = SIM.freeBikeStatus(world, mode, k), recs = SIM.sourceRecsOf(world, k);
    world.snaps[k].forEach((s, p) => { if (s.vis) keyPhys.set(T.vehicleKey(SIM.SOURCE.operator, SIM.idFor(world, mode, p, k)), p); });
    const vehicles = await SIM.vehiclesOf(fbs, at, world.cfg.vtype);
    const plain = check ? structuredClone(vehicles) : null;
    const r = T.trackRun(st, { vehicles, stations: world.stations || [], sourceRecs: recs, now: at, trace: (e) => { e.run = k; log.push(e); } });
    st = r.state;
    if (check) {
      const q = T.trackRun(stPlain, { vehicles: plain, stations: world.stations || [], sourceRecs: recs, now: at }); stPlain = q.state;
      if (equal && JSON.stringify([hourlyObj(r.hourly), r.srcModes, r.gap, r.dt]) !== JSON.stringify([hourlyObj(q.hourly), q.srcModes, q.gap, q.dt])) { equal = false; firstDiff = k; }
    }
    per.push({ k, at, sAt: world.runs[k].sAt, step: world.runs[k].step, dt: r.dt, gap: r.gap, first: r.first, day: r.day, h: sumHourly(r.hourly), mode: r.srcModes?.[SIM.SOURCE.id] ?? 'unknown', nVeh: vehicles.length, down: world.runs[k].down });
  }
  if (check && equal && JSON.stringify(st) !== JSON.stringify(stPlain)) { equal = false; firstDiff = 'state'; }
  return { per, log, keyPhys, equal, firstDiff, state: st };
}

/** Kennzahlen aus Ausgabe + Wahrheit (Zuordnung über Sichtbarkeits-Episoden je Fahrzeug) */
export function metrics(world, mode, res, T) {
  const { per, log, keyPhys } = res, day = world.cfg.day, R = per.length;
  const dayRun = per.map(p => p.day === day);
  // Episoden je Fahrzeug: zwischen zwei Läufen, in denen es im Feed steht (Ausfall-Läufe zählen als nicht gesehen)
  const seenIn = (k, p) => world.snaps[k][p].vis && !world.runs[k].down;
  const vis = world.snaps[0].map((_, p) => { const a = []; for (let k = 0; k < R; k++) if (seenIn(k, p)) a.push(k); return a; });
  const epAfter = vis.map(a => { const m = new Map(); a.forEach((k, i) => m.set(k, i)); return m; }); // Lauf k (sichtbar) → Episode i = (k, nächster sichtbarer]
  const epEnd = vis.map(a => { const m = new Map(); for (let i = 0; i + 1 < a.length; i++) m.set(a[i + 1], i); return m; });
  const E = vis.map(a => a.map((k, i) => ({ k0: k, k1: a[i + 1] ?? null, j: k + 1, d: 0, n: 0, ev: [], acts: [], trips: [] })));
  const GONE = new Set(['start', 'pickup', 'hide', 'massgone', 'rot', 'srcdown']);
  let unmapped = 0, logStart = 0;
  for (const e of log) {
    const p = keyPhys.get(e.key); if (p == null) { unmapped++; continue; }
    const isGone = GONE.has(e.k) || (e.k === 'swap' && e.newKey);
    // Verschwinden: Episode ab der letzten Sichtung vor diesem Lauf
    let i = null;
    if (isGone) { const a = vis[p]; let lo = 0, hi = a.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] < e.run) { i = m; lo = m + 1; } else hi = m - 1; } }
    else i = epEnd[p].get(e.run);
    if (i == null) { unmapped++; continue; }
    const ep = E[p][i]; ep.ev.push(e);
    if ((e.k === 'start' || e.k === 'move') && !e.gap) { ep.d++; if (dayRun[e.run]) logStart++; }
  }
  const sAt = per.map(p => p.sAt);
  const findEp = (p, t) => { const a = vis[p]; let lo = 0, hi = a.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (sAt[a[m]] < t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; }; // letzte Sichtung vor t
  for (const tr of world.truth.trips) { const i = findEp(tr.phys, tr.ts); if (i >= 0) { E[tr.phys][i].n++; E[tr.phys][i].trips.push(tr); } }
  world.truth.acts.forEach((list, p) => { for (const a of list) if (a.kind !== 'trip') { const i = findEp(p, a.t0 + (a.kind === 'swapv' ? 1 : 0)); if (i >= 0) E[p][i].acts.push(a); } });
  // Zählt die Episode in den Tag? Maßgeblich ist der Lauf, in dem das Ende erkannt wird (nächste Sichtung) bzw. das Verschwinden (j)
  const inDay = (ep) => ep.j < R && dayRun[ep.j];
  let truthN = 0, det = 0, tp = 0, fp = 0, fn = 0, vanN = 0, vanFP = 0, vanRel = 0, durS = 0, distS = 0;
  const fnWhy = {}, fpWhy = {};
  for (const p of E.keys()) for (const ep of E[p]) {
    if (!inDay(ep)) continue;
    truthN += ep.n; det += ep.d; const m = Math.min(ep.n, ep.d); tp += m;
    for (const tr of ep.trips) { durS += tr.durMin; distS += tr.distM; }
    const vans = ep.acts.filter(a => a.kind === 'van'); vanN += vans.length;
    if (vans.length && ep.ev.some(e => e.k === 'reloc')) vanRel++;
    if (ep.d > ep.n) {
      const ks = new Set(ep.acts.map(a => a.kind + (a.hidden ? 'H' : '') + (a.cancel ? 'C' : '')));
      const why = vans.length ? 'Umsetzung' : ks.has('wh') ? 'Laden Lager' : ks.has('swaph') ? 'Tausch ausgeblendet' : ks.has('disH') ? 'Sperre ausgeblendet' : [...ks].some(x => x.startsWith('resH')) ? 'Reservierung ausgeblendet' : ks.has('churn') ? 'Kennungswechsel am Ort' : ep.n > 0 ? 'doppelt' : 'Kennung/Rauschen';
      fpWhy[why] = (fpWhy[why] || 0) + (ep.d - ep.n); fp += ep.d - ep.n; if (why === 'Umsetzung') vanFP += Math.min(ep.d - ep.n, vans.length);
    }
    if (ep.n > ep.d) {
      const ks = new Set(ep.ev.map(e => e.k + (e.k === 'swap' && e.newKey ? 'P' : '')));
      const gapRun = per[ep.j]?.gap, downRun = per[ep.j]?.down;
      const why = gapRun ? 'Lücke' : downRun || ks.has('srcdown') ? 'Quellenausfall' : ks.has('slow') ? 'kurz ohne Akkuverlust (slow)' : ks.has('reloc') ? 'als Umsetzung' : ks.has('fast') ? 'zu schnell (fast)' : ks.has('pickup') ? 'als Abholung (Akku < 15 %)' : ks.has('hide') ? 'Ausblendung' : (ks.has('rot') || ks.has('swapP')) ? 'als Kennungswechsel gepaart' : (ks.has('massgone') || ks.has('massnew')) ? 'Massenregel' : ep.d > 0 ? 'mehrere Fahrten je Intervall' : ep.trips.every(t => t.distM < T.MOVE_M) ? 'Rückkehr an den Ort (< 150 m)' : 'sonst';
      fnWhy[why] = (fnWhy[why] || 0) + (ep.n - ep.d); fn += ep.n - ep.d;
    }
  }
  const hd = per.filter((p, k) => dayRun[k]).reduce((o, p) => { for (const f of Object.keys(p.h)) o[f] = (o[f] || 0) + p.h[f]; return o; }, {});
  // Fahrzeugminuten: Wahrheit über dieselben Fenster [at − min(dt, 45 Min.), at] der zählenden Läufe
  const av = world.truth.avail; let vTruth = 0;
  per.forEach((p, k) => {
    if (!dayRun[k] || p.first || p.gap || p.dt == null || p.down) return;
    let rem = Math.min(p.dt, T.GAP_MS) / 60e3, s = p.step;
    while (rem > 1e-9 && s >= 0) { const w = Math.min(1, rem); vTruth += w * av[s][1]; rem -= w; s--; }
  });
  const modes = per.filter((p, k) => dayRun[k]).map(p => p.mode);
  let flips = 0; for (let k = 1; k < R; k++) if (per[k].mode !== per[k - 1].mode) flips++;
  const truthDur = truthN ? durS / truthN : null, truthDist = truthN ? distS / truthN : null;
  const detDur = hd.tripDurN ? hd.tripDurSum / hd.tripDurN / 60e3 : null, detDist = hd.tripDistN ? hd.tripDistSum / hd.tripDistN : null;
  return {
    truth: truthN, detected: hd.start, detectedLog: logStart, tp, fp, fn, ends: hd.end,
    precision: hd.start ? tp / hd.start : null, recall: truthN ? tp / truthN : null, countErr: truthN ? hd.start / truthN - 1 : null,
    endRatio: hd.end ? hd.start / hd.end : null,
    truthDur, detDur, durN: hd.tripDurN, durErr: detDur != null ? detDur / truthDur - 1 : null,
    truthDist, detDist, distN: hd.tripDistN, distErr: detDist != null ? detDist / truthDist - 1 : null,
    vans: vanN, vanAsTrip: vanN ? vanFP / vanN : null, vanSeenAsReloc: vanN ? vanRel / vanN : null, relocDetected: hd.reloc,
    lost: truthN ? fn / truthN : null, fnWhy, fpWhy,
    vmin: hd.vmin, vminTruth: vTruth, vminErr: vTruth ? hd.vmin / vTruth - 1 : null,
    modeOk: modes.length ? modes.filter(m => m === EXPECT[mode]).length / modes.length : null, modeFlips: flips,
    swaps: hd.swap, pickups: hd.pickup, slow: hd.slow, fast: hd.fast, rot: hd.rot, unmapped, runsDay: modes.length, gapRuns: per.filter((p, k) => dayRun[k] && p.gap).length,
  };
}

const pct = (x, d = 1) => x == null ? '–' : `${(100 * x).toFixed(d)}`;
const sg = (x, d = 1) => x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(100 * x).toFixed(d)}`;
export function table(rows) {
  const L = ['| Szenario | Kennung | Fahrten wahr | erkannt | Präz. % | Treffer % | Δ Zahl % | Beginne/Enden | Δ Dauer % | Umsetz.→Fahrt % | Δ Fz-Min % | Modus ok % | Wechsel |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const r of rows) { const m = r.m; L.push(`| ${r.sc} | ${r.mode} | ${m.truth} | ${m.detected} | ${pct(m.precision)} | ${pct(m.recall)} | ${sg(m.countErr)} | ${m.endRatio == null ? '–' : m.endRatio.toFixed(2)} | ${sg(m.durErr, 0)} | ${pct(m.vanAsTrip, 0)} | ${sg(m.vminErr, 2)} | ${pct(m.modeOk, 0)} | ${m.modeFlips} |`); }
  return L.join('\n');
}
