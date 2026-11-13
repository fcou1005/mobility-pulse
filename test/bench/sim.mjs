// Mobility Pulse – Simulator für den Prüfstand der Fahrterkennung (P1/P2, Tab „Algorithmen“).
// Erzeugt für eine Stadt (Standard 500 E-Scooter, ein Tag + 4 h Vorlauf) GBFS-2.3-Momentaufnahmen (free_bike_status) im echten Lauftakt
// und eine Wahrheit (Fahrten, Umsetzungen, Akku-Service, Reservierungen, Sperren, verfügbare Fahrzeugminuten je Minute).
// Physik und Kennungen sind getrennt: dieselbe physische Welt (Seed je Szenario) wird mit stabilen, je Fahrt oder je Lauf wechselnden
// Kennungen ausgegeben. Verteilungen: derived.json (Laufabstände aus runs.json, Tagesgang aus events/, Stand 11.11.2026).
// Annahmen (nicht gemessen): Umsetzungen, Akkudienst, Reservierungen, Sperren, Ausblend-Untergrenze, Kennungswechsel am Ort.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = process.env.MP_REPO || path.resolve(HERE, '..', '..');
const T = await import(path.join(REPO, 'lib', 'pulse-track.js'));
const C = await import(path.join(REPO, 'lib', 'pulse-core.js'));
export const DERIVED = JSON.parse(readFileSync(path.join(HERE, 'derived.json'), 'utf8'));

// ---------- Szenarien (einzeln schaltbar; alles = realistische Mischung) ----------
export const BASE = {
  n: 500, seed: 1, day: '2026-11-10', warmupH: 4, tailMin: 40,
  center: [48.7758, 9.1829], radiusM: 3500, hotspots: 25,
  trips: true, shortShare: 0, roundShare: 0,
  reloc: false, battery: false, resdis: false, gaps: [], noise: null,
  rotateOnOps: true, // je-Fahrt-Kennung wechselt auch nach Umsetzung/Laden (Annahme)
  minRentBat: 10,    // ausleihbar ab 10 % Akku (Annahme; Betreiber-Untergrenzen laut lib/pulse-core.js: Dott 14–17 %, Voi 2–9 %, Bolt 0–4 %)
  floor: null,       // Ausblend-Untergrenze in %: darunter steht das Fahrzeug nicht im Feed (sourceRecs.batteryFloor)
  outages: [],       // Quellenausfall: [['hh:mm', Minuten]] – Läufe finden statt, die Quelle liefert nichts (status down)
  vtype: 'scooter',  // 'scooter' oder 'bike' (Fahrrad ohne Motor)
  noBattery: false,  // Feed ohne Ladestand (Räder ohne Akku, viele nextbike-Feeds)
  churn: 0,          // Anteil abgestellter Fahrzeuge, die je Lauf am Ort eine neue Kennung bekommen (nur Kennungsart „je Fahrt“)
  dropout: [],       // Teilausfall des Feeds: [['hh:mm', Anteil]] – im ersten Lauf ab hh:mm fehlt dieser Anteil der Fahrzeuge (zufällig), danach wieder da
};
export const SCENARIOS = {
  basis: {},
  umsetzung: { reloc: true },
  akku: { battery: true },
  'res-sperre': { resdis: true },
  luecken: { gaps: [['08:10', 40], ['13:00', 65], ['17:30', 90]] },
  gps: { noise: [5, 30] },
  kurz: { shortShare: 0.5 },
  rundfahrt: { roundShare: 0.2 },
  alles: { reloc: true, battery: true, resdis: true, gaps: [['17:30', 65]], noise: [5, 30], shortShare: 0.15, roundShare: 0.05 },
  // P2
  klein50: { n: 50 },
  klein25: { n: 25 },
  ausblendung: { battery: true, floor: 10 },
  ausfall: { outages: [['12:00', 60]] },
  sommerzeit: { day: '2026-10-25' },
  rad: { vtype: 'bike', noBattery: true },
  'rad-wechsel': { vtype: 'bike', noBattery: true, churn: 0.1 },
  teilausfall: { dropout: [['12:00', 0.25]] },
};
export const ID_MODES = ['stable', 'trip', 'run']; // stabil, neue Kennung je Fahrt (GBFS 2.1+), neue Kennung je Lauf (z. B. Lime direkt)

// ---------- Zufall ----------
export function rngOf(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const normal = (r) => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
const U = (r, a, b) => a + (b - a) * r();
const UI = (r, a, b) => Math.floor(U(r, a, b + 1));
const fnv = (s, h = 0x811c9dc5) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
export const idOf = (seed, phys, epoch) => fnv(`${seed}|${phys}|${epoch}`).toString(16).padStart(8, '0') + fnv(`${epoch}#${phys}#${seed}`, 0x01234567).toString(16).padStart(8, '0');

// ---------- Geometrie (lokal eben, m) ----------
const M_LAT = 111320;
const mk = (c) => { const mLon = M_LAT * Math.cos(c[0] * Math.PI / 180); return { xy: (lat, lon) => [(lon - c[1]) * mLon, (lat - c[0]) * M_LAT], ll: (x, y) => [c[0] + y / M_LAT, c[1] + x / mLon] }; };

// Ortszeit (Europe/Berlin) → UTC ms für Tag und hh:mm (Sommer- und Winterzeit über hourOf geprüft)
export function localMs(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  let t = Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) - 3600e3;
  for (let i = 0; i < 3 && T.hourOf(t) !== h; i++) t += (h - T.hourOf(t)) * 3600e3;
  return t;
}
export const nextDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) + 86400e3).toISOString().slice(0, 10);

/**
 * Physische Welt simulieren (unabhängig vom Kennungsmodus).
 * Rückgabe: { cfg, runs: [{ at, sAt, step, down }], snaps: [[{ vis, lat, lon, bat, res, dis, st, ep, cep }] je Fahrzeug] je Lauf, truth: {...} }
 */
export function simulate(over = {}) {
  const cfg = { ...BASE, ...over };
  const r = rngOf(cfg.seed * 7919 + 13), rn = rngOf(cfg.seed * 104729 + 7), rr = rngOf(4242), rc = rngOf(cfg.seed * 31 + 5); // Physik, GPS, Lauftakt, Kennungswechsel
  const G = mk(cfg.center);
  const dayStart = localMs(cfg.day, '00:00'), dayEnd = localMs(nextDay(cfg.day), '00:00');
  const T0 = dayStart - cfg.warmupH * 3600e3, T1 = dayEnd + cfg.tailMin * 60e3;
  // Lauftakt: Abstände aus runs.json (≤ 45 Min.) gezogen; Lücken: nächster Lauf genau gapMin nach dem letzten Lauf vor dem Lückenbeginn
  const DT = DERIVED.runs.dt_list;
  const gapAt = cfg.gaps.map(([hhmm, min]) => ({ t: localMs(cfg.day, hhmm), min, done: false }));
  const outAt = cfg.outages.map(([hhmm, min]) => { const t = localMs(cfg.day, hhmm); return [t, t + min * 60e3]; });
  const dropAt = cfg.dropout.map(([hhmm, share]) => ({ t: localMs(cfg.day, hhmm), share, done: false })), rd = rngOf(cfg.seed * 97 + 3);
  const runs = []; let t = T0 + U(rr, 0, 5) * 60e3;
  while (t < T1) {
    runs.push(t);
    let next = t + DT[Math.floor(rr() * DT.length)] * 60e3;
    for (const g of gapAt) if (!g.done && next > g.t) { next = t + g.min * 60e3; g.done = true; }
    t = next;
  }
  // Hotspots (Nachfrage-Schwerpunkte, Abstellspots)
  const hot = []; for (let i = 0; i < cfg.hotspots; i++) { const rad = cfg.radiusM * Math.sqrt(r()) * 0.85, a = U(r, 0, 2 * Math.PI); hot.push([rad * Math.cos(a), rad * Math.sin(a)]); }
  const clampDisk = (x, y) => { const d = Math.hypot(x, y), R = cfg.radiusM * 0.98; return d > R ? [x * R / d, y * R / d] : [x, y]; };
  const near = (p, s) => { const a = U(r, 0, 2 * Math.PI), d = Math.abs(normal(r)) * s; return clampDisk(p[0] + d * Math.cos(a), p[1] + d * Math.sin(a)); };
  // Fahrzeuge
  const V = [];
  for (let i = 0; i < cfg.n; i++) {
    const p = r() < 0.7 ? near(hot[Math.floor(r() * hot.length)], 250) : (() => { const rad = cfg.radiusM * Math.sqrt(r()), a = U(r, 0, 2 * Math.PI); return [rad * Math.cos(a), rad * Math.sin(a)]; })();
    V.push({ i, x: p[0], y: p[1], bat: U(r, 20, 100), st: 'avail', until: Infinity, ep: 0, cep: 0, svcAt: null, svcKind: null, act: null });
  }
  const lam = DERIVED.diurnal.per_vehicle_hour; // Fahrtbeginne je verfügbarer Fahrzeugstunde, Ortsstunde (events/*.json)
  const truth = { trips: [], vans: [], services: [], res: [], dis: [], avail: [], acts: V.map(() => []) };
  const act = (v, kind, t0, extra = {}) => { const a = { kind, t0, t1: null, ...extra }; truth.acts[v.i].push(a); v.act = a; return a; };
  const close = (v, t1) => { if (v.act) { v.act.t1 = t1; v.act = null; } };
  // Fahrt ziehen (Dauer: Heilbronn-Betreiberdaten, Median 6,9 / Mittel 8,7 Min.; Tempo Luftlinie: Berlin 1,5 km in 7,3 Min. ÷ Umwegfaktor 1,3)
  const SIG_D = Math.sqrt(2 * Math.log(8.7 / 6.9));
  const drawTrip = (v) => {
    const u = r(); let kind = 'normal', dur, dist, routeKm, bearing = r() < 0.5 ? (() => { const h = hot[Math.floor(r() * hot.length)]; return Math.atan2(h[1] - v.y, h[0] - v.x); })() : U(r, 0, 2 * Math.PI);
    if (u < cfg.roundShare) { kind = 'round'; dur = U(r, 4, 15); dist = U(r, 0, 30); bearing = U(r, 0, 2 * Math.PI); routeKm = 12 * dur / 60; }
    else if (u < cfg.roundShare + cfg.shortShare) { kind = 'short'; dur = U(r, 1, 4); dist = U(r, 150, 700); routeKm = 1.35 * dist / 1000; }
    else { dur = Math.min(90, Math.max(1, Math.exp(Math.log(6.9) + SIG_D * normal(r)))); const kmh = Math.min(18, Math.exp(Math.log(9.5) + 0.25 * normal(r))); dist = kmh * dur / 60 * 1000; routeKm = 1.35 * dist / 1000; }
    const [x, y] = clampDisk(v.x + dist * Math.cos(bearing), v.y + dist * Math.sin(bearing));
    return { kind, durMin: Math.max(1, Math.round(dur)), x, y, drain: cfg.noBattery ? 0 : 1.8 * routeKm };
  };
  const startTrip = (v, t, trip) => { v.st = 'trip'; v.until = t + trip.durMin * 60e3; v.trip = { ...trip, ts: t, x0: v.x, y0: v.y, bat0: v.bat }; act(v, 'trip', t); };
  // Umsetzungsfahrten (Transporter): morgens 05:00–09:30 und abends 21:00–22:30 alle 30 Min. (Annahme)
  const vanTimes = [];
  if (cfg.reloc) for (const off of [-1, 0]) for (const hh of ['05:00', '05:30', '06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '21:00', '21:30', '22:00', '22:30']) {
    const tt = localMs(off ? T.dayOf(dayStart - 3600e3) : cfg.day, hh); if (tt >= T0 && tt < T1) vanTimes.push(tt);
  }
  vanTimes.sort((a, b) => a - b);
  const pendingDrops = [];
  const snaps = [], runMeta = [];
  let ri = 0, step = 0;
  for (let tm = T0 - (T0 % 60e3); tm < T1; tm += 60e3, step++) {
    const hour = T.hourOf(tm), lamMin = lam[hour] / 60;
    // 1) Zustände beenden
    for (const v of V) {
      if (v.until > tm) continue;
      if (v.st === 'res') {
        close(v, tm);
        if (v.next) { const tr = v.next; v.next = null; startTrip(v, tm, tr); } else { v.st = 'avail'; v.until = Infinity; }
      } else if (v.st === 'trip') {
        const tr = v.trip; v.x = tr.x; v.y = tr.y; v.bat = Math.max(0, v.bat - tr.drain); v.st = 'avail'; v.until = Infinity; v.ep++;
        const [la0, lo0] = G.ll(tr.x0, tr.y0), [la1, lo1] = G.ll(tr.x, tr.y);
        truth.trips.push({ phys: v.i, kind: tr.kind, ts: tr.ts, te: tm, durMin: (tm - tr.ts) / 60e3, distM: C.haversineM(la0, lo0, la1, lo1), bat0: tr.bat0 });
        close(v, tm); v.trip = null;
      } else if (v.st === 'dis') { v.st = 'avail'; v.until = Infinity; close(v, tm); }
      else if (v.st === 'swaph') { v.st = 'avail'; v.until = Infinity; v.bat = U(r, 95, 100); close(v, tm); }
      else if (v.st === 'wh') { const h = hot[Math.floor(r() * hot.length)]; const p = near(h, 10); v.x = p[0]; v.y = p[1]; v.bat = 100; v.st = 'avail'; v.until = Infinity; if (cfg.rotateOnOps) v.ep++; close(v, tm); }
    }
    for (let k = pendingDrops.length - 1; k >= 0; k--) {
      const d = pendingDrops[k]; if (d.t > tm) continue; pendingDrops.splice(k, 1);
      for (const v of d.vs) { const p = near(d.spot, 8); v.x = p[0]; v.y = p[1]; v.st = 'avail'; v.until = Infinity; if (cfg.rotateOnOps) v.ep++; close(v, tm); }
    }
    // 2) Ruheverbrauch 0,3 %/h (Annahme)
    if (!cfg.noBattery) for (const v of V) if (v.st !== 'wh' && v.st !== 'swaph') v.bat = Math.max(0, v.bat - 0.3 / 60);
    // 3) Transporter: k = 3–6 verfügbare Fahrzeuge ≤ 300 m um ein zufälliges verfügbares Fahrzeug einsammeln, an einem Spot abstellen
    while (vanTimes.length && vanTimes[0] <= tm) {
      vanTimes.shift();
      const av = V.filter(v => v.st === 'avail'); if (!av.length) continue;
      const seed = av[Math.floor(r() * av.length)], k = UI(r, 3, 6);
      const pick = av.map(v => [Math.hypot(v.x - seed.x, v.y - seed.y), v]).filter(([d]) => d <= 300).sort((a, b) => a[0] - b[0]).slice(0, k).map(x => x[1]);
      const long = r() < 0.7, durMin = long ? UI(r, 25, 70) : UI(r, 3, 10), spot = hot[Math.floor(r() * hot.length)];
      for (const v of pick) { v.st = 'van'; v.until = Infinity; act(v, 'van', tm, { long }); truth.vans.push({ phys: v.i, t0: tm, t1: tm + durMin * 60e3, long, n: pick.length }); }
      pendingDrops.push({ t: tm + durMin * 60e3, vs: pick, spot });
    }
    // 4) Akku-Service: unter 25 % nach 30–480 Min.; 70 % Tausch vor Ort (06–22 Uhr, halb sichtbar, halb 3–12 Min. ausgeblendet), 30 % Laden im Lager 3–8 h
    if (cfg.battery && !cfg.noBattery) for (const v of V) {
      if (v.svcAt == null && v.bat < 25 && v.st === 'avail') { v.svcAt = tm + UI(r, 30, 480) * 60e3; v.svcKind = r() < 0.7 ? 'swap' : 'wh'; }
      if (v.svcAt == null || v.svcAt > tm || v.st !== 'avail') continue;
      if (v.svcKind === 'swap' && !(hour >= 6 && hour < 22)) continue;
      const kind = v.svcKind; v.svcAt = null; v.svcKind = null;
      if (kind === 'wh') { v.st = 'wh'; v.until = tm + UI(r, 180, 480) * 60e3; act(v, 'wh', tm); truth.services.push({ phys: v.i, kind: 'wh', t0: tm, bat: v.bat }); }
      else if (r() < 0.5) { v.st = 'swaph'; v.until = tm + UI(r, 3, 12) * 60e3; act(v, 'swaph', tm); truth.services.push({ phys: v.i, kind: 'swaph', t0: tm, bat: v.bat }); }
      else { truth.services.push({ phys: v.i, kind: 'swapv', t0: tm, bat: v.bat }); truth.acts[v.i].push({ kind: 'swapv', t0: tm, t1: tm }); v.bat = U(r, 95, 100); }
    }
    // 5) Sperren: 0,08 je Fahrzeugtag (sichtbar oder ausgeblendet je 50 %), 1–10 h, Freigabe am Ort
    if (cfg.resdis) for (const v of V) if (v.st === 'avail' && r() < 0.08 / 1440) { const hid = r() < 0.5; v.st = 'dis'; v.hidden = hid; v.until = tm + UI(r, 60, 600) * 60e3; act(v, 'dis', tm, { hidden: hid }); truth.dis.push({ phys: v.i, t0: tm, hidden: hid }); }
    // 6) Fahrten: Rate je verfügbarem Fahrzeug aus dem gemessenen Tagesgang; nur ab minRentBat ausleihbar; 25 % mit Reservierung 1–10 Min. (10 % storniert)
    if (cfg.trips) for (const v of V) {
      if (v.st !== 'avail' || (!cfg.noBattery && v.bat < cfg.minRentBat) || (cfg.floor != null && v.bat <= cfg.floor) || !(r() < lamMin)) continue;
      const trip = drawTrip(v);
      if (cfg.resdis && r() < 0.25) {
        const hid = r() < 0.5, cancel = r() < 0.1; v.st = 'res'; v.hidden = hid; v.until = tm + UI(r, 1, 10) * 60e3; v.next = cancel ? null : trip;
        act(v, 'res', tm, { hidden: hid, cancel }); truth.res.push({ phys: v.i, t0: tm, hidden: hid, cancel });
      } else startTrip(v, tm, trip);
    }
    // 7) verfügbare Fahrzeuge (im Feed, nicht reserviert, nicht gesperrt, über der Ausblend-Untergrenze) je Minute
    let nAv = 0; for (const v of V) if (v.st === 'avail' && (cfg.floor == null || v.bat > cfg.floor)) nAv++;
    truth.avail.push([tm, nAv]);
    // 8) Momentaufnahmen der Läufe in dieser Minute
    while (ri < runs.length && runs[ri] < tm + 60e3) {
      const at = runs[ri++];
      if (cfg.churn) for (const v of V) if (v.st === 'avail' && rc() < cfg.churn) { v.cep++; truth.acts[v.i].push({ kind: 'churn', t0: tm - 1, t1: tm - 1 }); } // vor der Momentaufnahme: gehört zum Intervall davor
      const snap = V.map(v => {
        const vis = (v.st === 'avail' && (cfg.floor == null || v.bat > cfg.floor)) || ((v.st === 'res' || v.st === 'dis') && !v.hidden);
        if (!vis) return { vis: false, st: v.st, ep: v.ep, cep: v.cep };
        let [la, lo] = G.ll(v.x, v.y);
        if (cfg.noise) { const d = U(rn, cfg.noise[0], cfg.noise[1]), a = U(rn, 0, 2 * Math.PI); [la, lo] = G.ll(v.x + d * Math.cos(a), v.y + d * Math.sin(a)); }
        return { vis: true, st: v.st, ep: v.ep, cep: v.cep, lat: +la.toFixed(6), lon: +lo.toFixed(6), bat: Math.round(v.bat), res: v.st === 'res', dis: v.st === 'dis' };
      });
      for (const d of dropAt) if (!d.done && at >= d.t) { d.done = true; for (const x of snap) if (x.vis && rd() < d.share) { x.vis = false; x.dropped = true; } } // Teilausfall: Wahrheit unverändert
      snaps.push(snap); runMeta.push({ at, sAt: tm, step, down: outAt.some(([a, b]) => at >= a && at < b) });
    }
  }
  return { cfg, runs: runMeta, snaps, truth, dayStart, dayEnd, T0, T1 };
}

// ---------- Kennungen + GBFS-Dokumente je Lauf ----------
export const SOURCE = { id: 'sim-src', operator: 'SimOp', name: 'Sim Scooter', url: 'sim://gbfs.json', priority: 1 };
export const AGS = '08111000';
export function idFor(world, mode, phys, k) {
  const s = world.snaps[k][phys], seed = world.cfg.seed;
  return mode === 'stable' ? idOf(seed, phys, 'S') : mode === 'trip' ? idOf(seed, phys, `E${s.ep}.${s.cep}`) : idOf(seed, phys, 'R' + k);
}
export function freeBikeStatus(world, mode, k) {
  const at = world.runs[k].at, bikes = [], nb = world.cfg.noBattery;
  if (!world.runs[k].down) world.snaps[k].forEach((s, phys) => {
    if (!s.vis) return;
    const b = { bike_id: idFor(world, mode, phys, k), lat: s.lat, lon: s.lon, is_reserved: s.res, is_disabled: s.dis, vehicle_type_id: 'v', last_reported: Math.floor(at / 1000) - 30 };
    if (!nb) { b.current_fuel_percent = s.bat / 100; b.current_range_meters = s.bat * 500; }
    bikes.push(b);
  });
  return { last_updated: Math.floor(at / 1000), ttl: 60, version: '2.3', data: { bikes } };
}
const VT = { scooter: { vehicle_type_id: 'v', form_factor: 'scooter', propulsion_type: 'electric', max_range_meters: 50000 }, bike: { vehicle_type_id: 'v', form_factor: 'bicycle', propulsion_type: 'human' } };
const STATIC = (at, vtype) => ({
  'sim://gbfs.json': { last_updated: Math.floor(at / 1000), ttl: 60, version: '2.3', data: { de: { feeds: ['system_information', 'vehicle_types', 'free_bike_status'].map(n => ({ name: n, url: `sim://${n}.json` })) } } },
  'sim://system_information.json': { last_updated: Math.floor(at / 1000), ttl: 60, version: '2.3', data: { system_id: 'sim', language: 'de', name: 'Sim', timezone: 'Europe/Berlin' } },
  'sim://vehicle_types.json': { last_updated: Math.floor(at / 1000), ttl: 60, version: '2.3', data: { vehicle_types: [VT[vtype]] } },
});
/** GBFS-Dokument → Fahrzeuge wie im Sammler (readGbfsSystem, dedupeVehicles) */
export async function vehiclesOf(fbs, at, vtype = 'scooter') {
  const docs = { ...STATIC(at, vtype), 'sim://free_bike_status.json': fbs };
  const sys = await C.readGbfsSystem(SOURCE, async (u) => ({ ok: !!docs[u], status: docs[u] ? 200 : 404, json: docs[u] || null, latencyMs: 1 }), { now: at });
  if (sys.errors.length) throw new Error(sys.errors.join('; '));
  const all = sys.vehicles.map(v => ({ ...v, operator: SOURCE.operator, sourceId: SOURCE.id, priority: SOURCE.priority, ags: AGS, feedAgeMs: 0 }));
  return C.dedupeVehicles(all).vehicles;
}
/** Quellen-Datensatz des Laufs wie im Sammler (status, batteryFloor) */
export const sourceRecsOf = (world, k) => [{ id: SOURCE.id, status: world.runs[k].down ? 'down' : 'live', latencyMs: 1, ...(world.cfg.floor != null ? { batteryFloor: world.cfg.floor } : {}) }];
