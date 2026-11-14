// Mobility Pulse – S6.4 Schichtplaner, Stufe 1 (F11; A17 Touren als Pickup-and-Delivery)
// Aus den Touren der Disposition (Umsetzen, Stationsausgleich, Akkutausch, Werkstatt) werden Aufträge: Umsetzen = Paar Abholung → Ausbringung
// (je Tour die Ausbringungen den nächsten Abholungen zugeordnet), Werkstatt = Abholung, abgeladen am Depot, Tausch = Halt ohne Ladung.
// Je Fahrer eine Schicht (Beginn bis Ende) aus einer oder mehreren Fahrten Depot → … → Depot. Einfügen nach Priorität (billigste Stelle,
// Kapazität des Transporters entlang der Fahrt, Abholung vor Ausbringung in derselben Fahrt, Schichtende), danach Verlegen einzelner Aufträge,
// solange die Strecke sinkt. Abholen und Ausbringen dürfen sich abwechseln (Pickup-and-Delivery); Vergleich „heute“: dieselben Aufträge je
// bisheriger Tour mit „erst einsammeln, dann ausbringen“ (orderTour mit zwei Gruppen), Strecke wie in der Disposition (Luftlinie × Umweg).
import { DEFAULTS, dist, sum } from './pulse-ops-model.js';
import { makeCost, orderTour } from './pulse-ops-tours.js';

// balanceM: Ausgleich zwischen Fahrern – je Minute, die eine Schicht schon dauert, zählt eine Einfügung dort balanceM Meter teurer (nur bei der
// Wahl des Fahrers; ohne ihn landet alles beim ersten Fahrer, solange die Zeit reicht)
export const SHIFT = Object.freeze({ drivers: 2, startMin: 6 * 60, endMin: 14 * 60, depotMin: 5, passes: 4, balanceM: 15 });
const SERVICE = { P: 'pickupMin', D: 'dropMin', S: 'swapMin', W: 'workshopMin' };

/**
 * Aufträge aus einem Plan der Disposition (computePlan: rebalance, station, swaps, workshop). Rückgabe [{ id, kind ('move'|'swap'|'workshop'),
 * run (bisherige Tour), count, prio, p: { lat, lon, info }, d (nur move): { lat, lon, info } }]
 */
export function shiftJobs(plan) {
  const jobs = []; let n = 0;
  const pt = (s) => ({ lat: s.lat, lon: s.lon, type: s.type, ...(s.spotRank != null ? { spotRank: s.spotRank } : {}), ...(s.station ? { station: s.station } : {}), ...(s.battery?.length ? { battery: s.battery } : {}), ...(s.idleMaxH != null ? { idleMaxH: s.idleMaxH } : {}) });
  for (const r of [...(plan?.rebalance?.runs || []), ...(plan?.station?.runs || [])]) {
    const picks = r.stops.filter(s => s.type === 'pickup').map(s => ({ s, left: s.count || 1 }));
    for (const d of r.stops.filter(s => s.type === 'drop')) {
      let need = d.count || 1;
      while (need > 0) {
        let best = null, bd = Infinity; for (const p of picks) { if (p.left <= 0) continue; const x = dist(p.s, d); if (x < bd) { bd = x; best = p; } }
        if (!best) break; const k = Math.min(need, best.left); best.left -= k; need -= k;
        jobs.push({ id: `J${++n}`, kind: 'move', run: r.id, count: k, prio: Math.max(best.s.prio ?? 0, d.prio ?? 0), p: pt(best.s), d: pt(d) });
      }
    }
  }
  for (const r of plan?.swaps?.runs || []) for (const s of r.stops) jobs.push({ id: `J${++n}`, kind: 'swap', run: r.id, count: s.count || 1, prio: s.prio ?? 0, p: pt(s) });
  for (const r of plan?.workshop?.runs || []) for (const s of r.stops) jobs.push({ id: `J${++n}`, kind: 'workshop', run: r.id, count: s.count || 1, prio: s.prio ?? 0, p: pt(s) });
  return jobs;
}

// Route = Knoten [{ t: 'depot' } | { t: 'P'|'D'|'S'|'W', job }], beginnt und endet am Depot; Depots dazwischen trennen Fahrten (Abladen, neue Akkus).
const nodesOf = (job) => (job.kind === 'move' ? [{ t: 'P', job }, { t: 'D', job }] : [{ t: job.kind === 'swap' ? 'S' : 'W', job }]);
const posOf = (nd, depot) => (nd.t === 'depot' ? depot : nd.t === 'D' ? nd.job.d : nd.job.p);

function makeEval(o, depot, cost) {
  const svc = (nd) => (nd.t === 'depot' ? 0 : (o[SERVICE[nd.t]] ?? 0) * (nd.job.count || 1));
  const minOfM = (m) => (m / 1000) / o.speedKmh * 60;
  /** Kennzahlen einer Route: Strecke m, Minuten (Fahrt + vor Ort + Zwischendepots), Ladung nach jedem Knoten, Fahrtgrenzen, Tausch je Fahrt */
  const stats = (R) => {
    let m = 0, min = 0, load = 0, swaps = 0; const L = [], trip = [], swapOf = []; let ti = 0;
    for (let k = 0; k < R.length; k++) {
      const nd = R[k];
      if (k) { const d = cost(posOf(R[k - 1], depot), posOf(nd, depot)); m += d; min += minOfM(d); }
      min += svc(nd);
      if (nd.t === 'depot') { if (k && k < R.length - 1) min += o.depotMin; if (k) { swapOf[ti] = swaps; ti++; } load = 0; swaps = 0; }
      else if (nd.t === 'P' || nd.t === 'W') load += nd.job.count || 1;
      else if (nd.t === 'D') load -= nd.job.count || 1;
      else swaps += nd.job.count || 1;
      L.push(load); trip.push(ti);
    }
    return { m, min, L, trip, swapOf };
  };
  return { svc, minOfM, stats };
}

/** beste Einfügestelle eines Auftrags in Route R (stats st); Rückgabe { dm, dmin, apply: () => neue Route } oder null */
function bestInsert(R, st, job, o, depot, cost, ev, limitMin) {
  const at = (k) => posOf(R[k], depot), k1 = job.count || 1, C = (a, b) => cost(a, b);
  const nodes = nodesOf(job), svcAdd = sum(nodes.map(ev.svc));
  let best = null;
  const consider = (dm, extraMin, mk) => { const dmin = ev.minOfM(dm) + svcAdd + extraMin; if (st.min + dmin > limitMin + 1e-9) return; if (!best || dm < best.dm - 1e-9) best = { dm, dmin, apply: mk }; };
  const n = R.length;
  if (job.kind === 'move') {
    const P = job.p, D = job.d;
    for (let i = 1; i < n; i++) {
      const a = at(i - 1), b = at(i), dP = C(a, P) + C(P, b) - C(a, b);
      // D direkt hinter P (gleiche Lücke)
      let mx = st.L[i - 1];
      if (mx + k1 <= o.vanCapacity) consider(C(a, P) + C(P, D) + C(D, b) - C(a, b), 0, () => [...R.slice(0, i), nodes[0], nodes[1], ...R.slice(i)]);
      // D in einer späteren Lücke j derselben Fahrt (kein Depot zwischen i und j)
      for (let j = i + 1; j < n; j++) {
        if (R[j - 1].t === 'depot') break;
        mx = Math.max(mx, st.L[j - 1]); if (mx + k1 > o.vanCapacity) break;
        const a2 = at(j - 1), b2 = at(j);
        consider(dP + C(a2, D) + C(D, b2) - C(a2, b2), 0, () => [...R.slice(0, i), nodes[0], ...R.slice(i, j), nodes[1], ...R.slice(j)]);
      }
    }
  } else {
    const P = job.p;
    for (let i = 1; i < n; i++) {
      const a = at(i - 1), b = at(i);
      if (job.kind === 'swap') { if ((st.swapOf[st.trip[i - 1]] ?? 0) + k1 > o.swapCapacity) continue; } // Lücke i gehört zur Fahrt von Knoten i − 1
      else { let mx = st.L[i - 1], ok = true; for (let j = i; j < n && R[j].t !== 'depot'; j++) mx = Math.max(mx, st.L[j]); if (mx + k1 > o.vanCapacity) ok = false; if (!ok) continue; }
      consider(C(a, P) + C(P, b) - C(a, b), 0, () => [...R.slice(0, i), nodes[0], ...R.slice(i)]);
    }
  }
  // neue Fahrt am Ende (Zwischendepot + Fahrt): nur, wenn die Route schon Aufträge hat
  if (n > 2 || R.some(x => x.t !== 'depot')) {
    const seq = nodes.map(nd => posOf(nd, depot)); let dm = C(depot, seq[0]) + C(seq[seq.length - 1], depot); for (let k = 1; k < seq.length; k++) dm += C(seq[k - 1], seq[k]);
    consider(dm, o.depotMin, () => [...R, ...nodes, { t: 'depot' }]);
  }
  return best;
}
/** aufeinanderfolgende Depots (leere Fahrt nach dem Herausnehmen) zusammenfassen; Start- und Enddepot bleiben */
function tidy(R) { const out = []; for (const x of R) { if (x.t === 'depot' && out.length && out[out.length - 1].t === 'depot') continue; out.push(x); } if (out.length < 2 || out[out.length - 1].t !== 'depot') out.push({ t: 'depot' }); return out; }

/**
 * Schichtplan. jobs: shiftJobs(plan); drivers: Anzahl; startMin/endMin: Schicht in Minuten ab Mitternacht (Ortszeit); depot { lat, lon };
 * opts: DEFAULTS (vanCapacity, swapCapacity, speedKmh, detour, pickupMin, dropMin, swapMin, workshopMin) und SHIFT (depotMin, passes).
 * Rückgabe { drivers: [{ id, stops: [{ seq, type ('pickup'|'drop'|'swap'|'pickup_disabled'|'depot'), lat, lon, count, eta (Minuten ab
 * Mitternacht), load, trip, job }], km, driveMin, serviceMin, startMin, endMin, trips, jobs }], unplanned: [job], planned, km, baselineKm
 * („erst einsammeln, dann ausbringen“ je bisheriger Tour, nur eingeplante Aufträge), savingKm, overMin (Zeitüberschreitung, soll 0) }
 */
/** @param {any[]} jobs @param {{ drivers?: number, startMin?: number, endMin?: number, depot?: any, cost?: any, [k: string]: any }} [opts] */
export function planShift(jobs, { drivers = SHIFT.drivers, startMin = SHIFT.startMin, endMin = SHIFT.endMin, depot, cost: costIn = null, ...opts } = {}) {
  const o = /** @type {any} */ ({ ...DEFAULTS, ...SHIFT, ...opts }); o.swapCapacity = Math.max(1, Math.min(50, o.swapCapacity));
  const cost = costIn || makeCost(o), ev = makeEval(o, depot, cost), limit = Math.max(0, endMin - startMin);
  const routes = Array.from({ length: Math.max(1, drivers | 0) }, () => [{ t: 'depot' }, { t: 'depot' }]);
  const order = jobs.slice().sort((a, b) => (b.prio ?? 0) - (a.prio ?? 0) || dist(depot, b.p) - dist(depot, a.p) || (a.id < b.id ? -1 : 1));
  const insert = (job, skip = -1) => {
    /** @type {any} */ let best = null; let bi = -1;
    routes.forEach((R, ri) => { if (ri === skip) return; const st = ev.stats(R), b = bestInsert(R, st, job, o, depot, cost, ev, limit); if (!b) return; b.score = b.dm + o.balanceM * (st.min + b.dmin); if (!best || b.score < best.score - 1e-9) { best = b; bi = ri; } });
    return best ? { ...best, ri: bi } : null;
  };
  const unplanned = [];
  for (const job of order) { const b = insert(job); if (b) routes[b.ri] = b.apply(); else unplanned.push(job); }
  // Verbessern: jeden Auftrag herausnehmen und an der besten Stelle wieder einsetzen, solange die Gesamtstrecke sinkt; danach Liegengebliebenes
  for (let pass = 0; pass < o.passes; pass++) {
    let moved = false;
    for (const job of order) {
      const ri = routes.findIndex(R => R.some(x => x.job === job)); if (ri < 0) continue;
      const R0 = routes[ri], m0 = ev.stats(R0).m, without = tidy(R0.filter(x => x.job !== job)), mW = ev.stats(without).m;
      routes[ri] = without;
      const b = insert(job);
      if (b && b.dm < (m0 - mW) - 1) { routes[b.ri] = b.apply(); moved = true; } else routes[ri] = R0;
    }
    for (let k = unplanned.length - 1; k >= 0; k--) { const b = insert(unplanned[k]); if (b) { routes[b.ri] = b.apply(); unplanned.splice(k, 1); moved = true; } }
    if (!moved) break;
  }
  const TYPE = { P: (nd) => (nd.job.p.type === 'pickup_disabled' ? 'pickup_disabled' : 'pickup'), D: () => 'drop', S: () => 'swap', W: () => 'pickup_disabled', depot: () => 'depot' };
  const out = routes.map((R, ri) => {
    R = tidy(R); const st = ev.stats(R); let t = startMin, drive = 0, service = 0;
    const stops = R.map((nd, k) => {
      if (k) { const dm = ev.minOfM(cost(posOf(R[k - 1], depot), posOf(nd, depot))); t += dm; drive += dm; }
      const eta = t, s = ev.svc(nd) + (nd.t === 'depot' && k && k < R.length - 1 ? o.depotMin : 0); t += s; service += s;
      const p = posOf(nd, depot);
      return { seq: k, type: TYPE[nd.t](nd), lat: p.lat, lon: p.lon, count: nd.t === 'depot' ? 0 : nd.job.count || 1, eta: Math.round(eta), load: st.L[k], trip: nd.t === 'depot' ? st.trip[k] : st.trip[k] + 1, job: nd.job?.id ?? null, info: nd.t === 'D' ? nd.job.d : nd.t === 'depot' ? null : nd.job.p };
    });
    const jobsIn = new Set(R.filter(x => x.job).map(x => x.job));
    return { id: `F${ri + 1}`, stops, km: +(st.m / 1000).toFixed(1), driveMin: Math.round(drive), serviceMin: Math.round(service), startMin, endMin: Math.round(t), trips: R.filter(x => x.t === 'depot').length - 1, jobs: jobsIn.size, vehicles: sum([...jobsIn].map(j => j.count || 1)) };
  });
  const plannedSet = new Set(routes.flatMap(R => R.filter(x => x.job).map(x => x.job)));
  const baselineKm = +(baselineM([...plannedSet], depot, cost) / 1000).toFixed(1), km = +sum(out.map(d => d.km)).toFixed(1);
  return { drivers: out, unplanned, planned: plannedSet.size, jobs: jobs.length, km, baselineKm, savingKm: +(baselineKm - km).toFixed(1), overMin: Math.max(0, ...out.map(d => d.endMin - endMin)), startMin, endMin, depot };
}

/** „Heute“: je bisheriger Tour die eingeplanten Aufträge, erst alle Abholungen (und Tausch/Werkstatt), dann alle Ausbringungen, je Gruppe optimiert */
export function baselineM(jobs, depot, cost) {
  const byRun = new Map(); for (const j of jobs) { const k = `${j.kind === 'move' ? 'm' : j.kind}:${j.run}`; if (!byRun.has(k)) byRun.set(k, []); byRun.get(k).push(j); }
  let m = 0;
  for (const list of byRun.values()) {
    const first = list.map(j => ({ lat: j.p.lat, lon: j.p.lon })), second = list.filter(j => j.kind === 'move').map(j => ({ lat: j.d.lat, lon: j.d.lon }));
    m += orderTour(second.length ? [first, second] : [first], { start: depot, end: depot, cost }).L;
  }
  return m;
}

const hm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}`;
export const minText = hm;
/** Schichtplan als CSV: je Stopp Fahrer, Fahrt, Reihenfolge, Ankunft, Typ, Lage, Anzahl, Ladung danach */
export function shiftCsv(sp, { lang = 'de' } = {}) {
  const en = lang === 'en', head = en ? ['driver', 'trip', 'stop', 'arrival', 'type', 'lat', 'lng', 'count', 'load_after'] : ['fahrer', 'fahrt', 'stopp', 'ankunft', 'typ', 'lat', 'lng', 'anzahl', 'ladung_danach'];
  const rows = sp.drivers.flatMap(d => d.stops.map(s => [d.id, s.trip, s.seq, hm(s.eta), s.type, s.lat.toFixed(6), s.lon.toFixed(6), s.count || '', s.load]));
  const esc = (v) => { const x = String(v ?? ''); return /[;,"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  return [head, ...rows].map(r => r.map(esc).join(en ? ',' : ';')).join('\n');
}
