// Mobility Pulse — Fahrzeug-Verfolgung über Sammler-Läufe hinweg.
// Reine Funktionen, keine Abhängigkeiten. Speichert nur gehashte Kennungen und gerundete Positionen.
import { haversineM, normalizeId, hashStr } from './pulse-core.js?v=mvxjtwjp';

export const TRACK_VERSION = 2;
export const MOVE_M = 150;        // ab hier gilt ein Positionswechsel bei gleicher Kennung als Umsetzung (bzw. Fahrt bei stabilen Kennungen)
export const JITTER_M = 50;       // darunter: GPS-Rauschen, Standzeit läuft weiter
export const MISSING_KEEP_MS = 24 * 3600e3; // verschwundene Kennungen so lange behalten (Rückkehr = Fahrtende bei stabilen Kennungen)
export const PICKUP_BATTERY = 15; // verschwindet ein Fahrzeug mit so wenig Akku, war es eher eine Abholung als eine Ausleihe
export const SWAP_FROM = 40, SWAP_TO = 85; // Akkusprung = Tausch
export const LOW_BATTERY = 20;
export const IDLE_BUCKETS = [2 * 3600e3, 8 * 3600e3, 24 * 3600e3, 48 * 3600e3]; // <2h, 2–8h, 8–24h, 1–2 Tage, >2 Tage
export const CELL_LAT = 0.0025, CELL_LON = 0.0035; // ≈ 280 m × 250 m
// Tageszeit-Bänder für Nachfrage und Versorgung je Zelle
export const BANDS = [
  { id: 0, label: 'Nacht', from: 0, to: 6 }, { id: 1, label: 'Morgen', from: 6, to: 9 }, { id: 2, label: 'Vormittag', from: 9, to: 12 },
  { id: 3, label: 'Mittag', from: 12, to: 15 }, { id: 4, label: 'Nachmittag', from: 15, to: 19 }, { id: 5, label: 'Abend', from: 19, to: 24 },
];
export const bandOf = (hour) => BANDS.findIndex(b => hour >= b.from && hour < b.to);
// Zellenwerte: [start, end, present, reloc, start je Band ×6 (4–9), present je Band ×6 (10–15), end je Band ×6 (16–21)]
export const CELL_LEN = 22;

// 64-Bit-Hash aus zwei FNV-1a-Läufen (Kollisionen bei ~250k Schlüsseln praktisch ausgeschlossen)
export function vehicleKey(operator, rawId) {
  const s = `${operator}|${normalizeId(rawId)}`;
  return hashStr(s) + hashStr(s + '#2');
}
export const cellOf = (lat, lon) => `${Math.round(lat / CELL_LAT)}:${Math.round(lon / CELL_LON)}`;
export const cellCenter = (cell) => { const [a, b] = cell.split(':').map(Number); return [a * CELL_LAT, b * CELL_LON]; };
export const hourOf = (ms, tz = 'Europe/Berlin') => +new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date(ms)) % 24;
export const dayOf = (ms, tz = 'Europe/Berlin') => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); return p; };

export function emptyState(now) {
  return { version: TRACK_VERSION, at: null, prevAt: null, dict: { op: [], ags: [], src: [] }, v: {}, s: {}, srcStats: {}, rel: {} };
}
// Wörterbuch-Index
function dictIdx(dict, name, value) { const arr = dict[name]; let i = arr.indexOf(value); if (i < 0) { i = arr.length; arr.push(value); } return i; }

const F_DISABLED = 1, F_RESERVED = 2, F_MISSING = 4;
const arr = (n) => new Array(n).fill(0);
export const ROTATE_M = 40;     // Kennung verschwindet und neue taucht ≤ 40 m daneben auf: Kennungswechsel am Ort, keine Fahrt
export const HOUR_FIELDS = ['start', 'end', 'reloc', 'swap', 'pickup', 'disOn', 'disOff', 'rot', 'vmin', 'vminTot'];
export function emptyHourly() { return { start: arr(24), end: arr(24), reloc: arr(24), swap: arr(24), pickup: arr(24), disOn: arr(24), disOff: arr(24), rot: arr(24), vmin: arr(24), vminTot: arr(24), swapWaitSum: 0, swapWaitN: 0, disDurSum: 0, disDurN: 0, tripDurSum: 0, tripDurN: 0, tripDistSum: 0, tripDistN: 0 }; }

/**
 * Ein Sammler-Lauf gegen den letzten Zustand.
 * vehicles: deduplizierte Fahrzeuge {operator, rawId, lat, lon, batteryPct, disabled, reserved, type, ags, sourceId}
 * stations: deduplizierte Stationen {operator, id, name, lat, lon, ags, bookable, docksAvailable, renting, installed, returning}
 * sourceRecs: Quellen-Datensätze des Laufs {id, status, latencyMs}
 * Rückgabe: { state, hourly: Map(key→emptyHourly), cells: Map(ags→Map(cell→[start,end,present,reloc])), idle: {...}, idleLong: [...], stationQuota, reliability, srcModes }
 */
export function trackRun(prev, { vehicles, stations, sourceRecs, now, tz = 'Europe/Berlin' }) {
  const state = prev && prev.version === TRACK_VERSION ? prev : emptyState(now);
  const first = state.at == null;
  const dt = first ? null : now - state.at;
  const hour = hourOf(now, tz), day = dayOf(now, tz);
  const hourly = new Map();
  const H = (op, ags, ty) => { const k = `${ags}|${op}|${ty}`; if (!hourly.has(k)) hourly.set(k, emptyHourly()); return hourly.get(k); };
  const cells = new Map();
  const CELL = (ags, cell) => { if (!cells.has(ags)) cells.set(ags, new Map()); const m = cells.get(ags); if (!m.has(cell)) m.set(cell, new Array(CELL_LEN).fill(0)); return m.get(cell); };
  const band = bandOf(hour);
  const dict = state.dict;
  const D = (name, v) => dictIdx(dict, name, v);
  const seen = new Set();
  const srcRun = {}; // sourceId → {present, gone, moved, newc, returned}
  const S = (src) => (srcRun[src] ??= { present: 0, gone: 0, moved: 0, newc: 0, returned: 0 });
  // Kennungsmodus je Quelle aus bisherigen Läufen: stabil, wenn Kennungen wiederkehren oder sich bewegen
  const modeOf = (src) => { const st = state.srcStats[src]; if (!st || st.runs < 2) return 'unknown'; const ret = st.returned + st.moved, gone = st.gone; if (ret + gone < 20) return 'unknown'; return ret / (ret + gone) > 0.25 ? 'stable' : 'rotating'; };

  // --- Fahrzeuge ---
  const idleAgg = new Map(); // key(ags|op|ty) → [b0..b4, n]
  const idleLong = [];
  const dtMin = dt != null ? Math.min(dt, 45 * 60e3) / 60e3 : 0; // Beobachtungsfenster dieses Laufs (Fahrzeugminuten)
  const arrivals = [], departures = []; // für die Gruppen-Erkennung (Ausbringen/Einsammeln)
  const appeared = []; // neue Kennungen: erst nach dem Abgleich mit verschwundenen als Fahrtende zählen
  for (const v of vehicles) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon) || !v.ags || v.ags === 'unbekannt') continue;
    const key = vehicleKey(v.operator, v.rawId);
    seen.add(key);
    const lat = Math.round(v.lat * 1e5), lon = Math.round(v.lon * 1e5);
    const bat = v.batteryPct != null ? Math.round(v.batteryPct) : null;
    let flags = (v.disabled ? F_DISABLED : 0) | (v.reserved ? F_RESERVED : 0);
    const op = D('op', v.operator), ags = D('ags', v.ags), src = D('src', v.sourceId || ''), ty = v.type || 'unknown';
    const e = state.v[key];
    const s = S(v.sourceId);
    const cell = cellOf(v.lat, v.lon);
    const c = CELL(v.ags, cell);
    if (!v.disabled && !v.reserved) { c[2]++; c[10 + band]++; } // präsent (verfügbar)
    if (dtMin) { const hh = H(v.operator, v.ags, ty); hh.vminTot[hour] += dtMin; if (!v.disabled && !v.reserved) hh.vmin[hour] += dtMin; }
    if (!e) {
      // neu aufgetaucht: Fahrtende (rotierende Kennungen) bzw. Neuaufstellung – Zählung nach dem Abgleich unten
      s.newc++;
      state.v[key] = [lat, lon, bat, flags, ty, op, ags, now, now, bat != null && bat < LOW_BATTERY ? now : 0, v.disabled ? now : 0, src, 0];
      if (!first) appeared.push({ key, v, ty, c });
      continue;
    }
    s.present++;
    const [plat, plon, pbat, pflags, pty, pop, pags, firstSeen, lastMoved, lowSince, disSince, psrc, missingSince] = e;
    const dist = haversineM(plat / 1e5, plon / 1e5, v.lat, v.lon);
    const wasMissing = !!(pflags & F_MISSING);
    const h = H(v.operator, v.ags, ty);
    if (wasMissing) {
      // Rückkehr einer bekannten Kennung = Fahrtende mit bekanntem Start (stabile Kennungen)
      s.returned++;
      h.end[hour]++; c[1]++; c[16 + band]++;
      if (dist >= JITTER_M) { h.tripDistSum += dist; h.tripDistN++; const dur = now - (missingSince || state.at || now); h.tripDurSum += dur; h.tripDurN++; }
    } else if (dist >= MOVE_M) {
      // gleiche Kennung, nie verschwunden, aber weit bewegt: Umsetzung durch den Betreiber (Fahrten entfernen das Fahrzeug aus dem Feed)
      s.moved++;
      h.reloc[hour]++; c[3]++;
      arrivals.push({ op: v.operator, ty, ags: v.ags, lat: v.lat, lon: v.lon, src: v.sourceId });
    }
    const moved = dist >= JITTER_M || wasMissing;
    const newLastMoved = moved ? now : lastMoved;
    // Akkutausch: deutlicher Sprung nach oben am selben Ort
    let newLowSince = lowSince;
    if (bat != null) {
      if (pbat != null && pbat < SWAP_FROM && bat >= SWAP_TO && dist < MOVE_M && !wasMissing) { h.swap[hour]++; if (lowSince) { h.swapWaitSum += now - lowSince; h.swapWaitN++; } newLowSince = 0; }
      else if (bat < LOW_BATTERY) { if (!newLowSince) newLowSince = now; }
      else if (bat >= SWAP_TO) newLowSince = 0;
    }
    // Sperren
    let newDisSince = disSince;
    const wasDis = !!(pflags & F_DISABLED);
    if (v.disabled && !wasDis) { h.disOn[hour]++; newDisSince = now; }
    else if (!v.disabled && wasDis) { h.disOff[hour]++; if (disSince) { h.disDurSum += now - disSince; h.disDurN++; } newDisSince = 0; }
    else if (v.disabled && !newDisSince) newDisSince = now;
    state.v[key] = [lat, lon, bat ?? pbat, flags, ty, op, ags, firstSeen, newLastMoved, newLowSince, newDisSince, src, 0];
    // Standzeit (nur verfügbare Fahrzeuge)
    if (!v.disabled && !v.reserved) {
      const idle = now - newLastMoved;
      const k = `${v.ags}|${v.operator}|${ty}`;
      if (!idleAgg.has(k)) idleAgg.set(k, [0, 0, 0, 0, 0, 0]);
      const a = idleAgg.get(k); let b = IDLE_BUCKETS.findIndex(lim => idle < lim); if (b < 0) b = IDLE_BUCKETS.length; a[b]++; a[5]++;
      if (idle >= IDLE_BUCKETS[3]) idleLong.push({ ags: v.ags, op: v.operator, ty, lat: +v.lat.toFixed(5), lon: +v.lon.toFixed(5), hours: Math.round(idle / 3600e3), bat });
    }
  }
  // --- Verschwundene Fahrzeuge ---
  // Kennungswechsel am Ort: neue Kennung ≤ ROTATE_M neben einer gerade verschwundenen (gleicher Anbieter, gleiche Art)
  // ist dasselbe Fahrzeug – keine Fahrt; Standzeit und erste Sichtung werden übernommen.
  const grid = new Map(); const gk = (la, lo) => `${Math.floor(la / 0.0005)}:${Math.floor(lo / 0.0007)}`;
  for (const a of appeared) { const k = gk(a.v.lat, a.v.lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(a); }
  const takeRotated = (opName, ty, la, lo) => {
    const [gi, gj] = gk(la, lo).split(':').map(Number); let best = null, bd = ROTATE_M;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const a of grid.get(`${gi + di}:${gj + dj}`) || []) {
      if (a.used || a.v.operator !== opName || a.ty !== ty) continue; const d = haversineM(la, lo, a.v.lat, a.v.lon); if (d <= bd) { bd = d; best = a; }
    }
    if (best) best.used = true; return best;
  };
  if (!first) {
    for (const [key, e] of Object.entries(state.v)) {
      if (seen.has(key)) continue;
      const [lat, lon, bat, flags, ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src, missingSince] = e;
      if (flags & F_MISSING) { if (now - missingSince > MISSING_KEEP_MS) delete state.v[key]; continue; }
      const opN = dict.op[op], agsN = dict.ags[ags], srcN = dict.src[src];
      const s = S(srcN); s.gone++;
      const h = H(opN, agsN, ty);
      const c = CELL(agsN, cellOf(lat / 1e5, lon / 1e5));
      const srcRec = sourceRecs.find(r => r.id === srcN);
      const srcUsable = !srcRec || srcRec.status === 'live' || srcRec.status === 'delayed';
      if (!srcUsable) { /* Quelle ausgefallen: nicht als Fahrt werten, Kennung behalten */ state.v[key] = [lat, lon, bat, flags | F_MISSING, ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src, now]; continue; }
      const rot = takeRotated(opN, ty, lat / 1e5, lon / 1e5);
      if (rot) {
        h.rot[hour]++; s.gone--; s.rotated = (s.rotated || 0) + 1;
        const ne = state.v[rot.key]; ne[7] = firstSeen; ne[8] = lastMoved; if (!ne[9] && lowSince) ne[9] = lowSince; if (!ne[10] && disSince && rot.v.disabled) ne[10] = disSince;
        delete state.v[key]; continue;
      }
      if ((flags & F_DISABLED) || (bat != null && bat < PICKUP_BATTERY)) { h.pickup[hour]++; }
      else { h.start[hour]++; c[0]++; c[4 + band]++; }
      departures.push({ op: opN, ty, ags: agsN, lat: lat / 1e5, lon: lon / 1e5, src: srcN });
      state.v[key] = [lat, lon, bat, flags | F_MISSING, ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src, now];
    }
    // übrige neue Kennungen = Fahrtende bzw. Neuaufstellung
    for (const a of appeared) { if (a.used) continue; H(a.v.operator, a.v.ags, a.ty).end[hour]++; a.c[1]++; a.c[16 + band]++; arrivals.push({ op: a.v.operator, ty: a.ty, ags: a.v.ags, lat: a.v.lat, lon: a.v.lon, src: a.v.sourceId }); }
  }
  // --- Quellenstatistik (rollierend, gedämpft) ---
  for (const [src, s] of Object.entries(srcRun)) {
    const st = (state.srcStats[src] ??= { runs: 0, present: 0, gone: 0, moved: 0, newc: 0, returned: 0 });
    st.runs++; for (const f of ['present', 'gone', 'moved', 'newc', 'returned']) st[f] = Math.round(st[f] * 0.9 + s[f]);
  }
  const srcModes = {}; for (const src of Object.keys(state.srcStats)) srcModes[src] = modeOf(src);

  // --- Stationen: Leer-/Vollquote je Tag ---
  const seenSt = new Set();
  for (const s of stations) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon) || !s.ags) continue;
    const key = hashStr(`${s.operator}|${s.id}`) + hashStr(`${s.operator}|${s.id}#s`);
    seenSt.add(key);
    const e = state.s[key] || { lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), name: String(s.name || '').slice(0, 60), op: D('op', s.operator), ags: D('ags', s.ags), d: {} };
    e.name = String(s.name || e.name || '').slice(0, 60); e.lat = +s.lat.toFixed(5); e.lon = +s.lon.toFixed(5);
    const dd = (e.d[day] ??= [0, 0, 0]);
    const open = s.installed !== false && s.renting !== false;
    // leer nur, wenn auch im Umkreis kein Fahrzeug des Anbieters steht (nearbyVehicles aus aggregateGroups)
    dd[0]++; if (open && (s.bookable ?? 0) === 0 && !(s.nearbyVehicles > 0)) dd[1]++; if (s.installed !== false && s.returning !== false && s.docksAvailable === 0) dd[2]++;
    for (const k of Object.keys(e.d)) if (daysBetween(k, day) > 7) delete e.d[k];
    state.s[key] = e;
  }
  for (const [key, e] of Object.entries(state.s)) { if (seenSt.has(key)) continue; const last = Object.keys(e.d).sort().pop(); if (!last || daysBetween(last, day) > 7) delete state.s[key]; }

  // --- Zuverlässigkeit je Quelle (7 Tage) ---
  for (const r of sourceRecs) {
    const e = (state.rel[r.id] ??= {});
    const dd = (e[day] ??= [0, 0, 0, 0, 0, 0]); // runs, live, delayed, stale, error/gone/auth, latencySum
    dd[0]++; if (r.status === 'live') dd[1]++; else if (r.status === 'delayed') dd[2]++; else if (r.status === 'stale') dd[3]++; else dd[4]++; dd[5] += r.latencyMs || 0;
    for (const k of Object.keys(e)) if (daysBetween(k, day) > 7) delete e[k];
  }
  for (const id of Object.keys(state.rel)) if (!sourceRecs.some(r => r.id === id)) { const last = Object.keys(state.rel[id]).sort().pop(); if (!last || daysBetween(last, day) > 7) delete state.rel[id]; }

  state.prevAt = state.at; state.at = now; state.day = day;
  const idle = {}; for (const [k, a] of idleAgg) idle[k] = a;
  // Gruppen: ≥ GROUP_MIN Fahrzeuge eines Anbieters tauchen in einem Lauf ≤ GROUP_M beieinander auf (Ausbringen)
  // bzw. verschwinden zusammen (Einsammeln). Quellen mit Massenwechsel (Ausfall, Neustart) zählen nicht.
  const glitch = new Set(Object.entries(srcRun).filter(([, r]) => (r.newc + r.gone) > 0.3 * Math.max(1, r.present + r.newc)).map(([k]) => k));
  const groups = first ? [] : [...clusterGroups(arrivals.filter(a => !glitch.has(a.src)), 'deploy', now), ...clusterGroups(departures.filter(a => !glitch.has(a.src)), 'collect', now)];
  return { state, first, dt, hourly, cells, idle, idleLong, srcModes, day, hour, groups };
}

export const GROUP_MIN = 5, GROUP_M = 40;
function clusterGroups(points, kind, at) {
  const out = []; const used = new Set();
  const byOp = new Map(); for (const p of points) { if (!byOp.has(p.op)) byOp.set(p.op, []); byOp.get(p.op).push(p); }
  for (const [op, list] of byOp) {
    if (list.length < GROUP_MIN) continue;
    for (const p of list) {
      if (used.has(p)) continue;
      const near = list.filter(q => !used.has(q) && haversineM(p.lat, p.lon, q.lat, q.lon) <= GROUP_M);
      if (near.length < GROUP_MIN) continue;
      near.forEach(q => used.add(q));
      const lat = near.reduce((a, q) => a + q.lat, 0) / near.length, lon = near.reduce((a, q) => a + q.lon, 0) / near.length;
      const types = {}; for (const q of near) types[q.ty] = (types[q.ty] || 0) + 1;
      out.push({ at, kind, op, ags: p.ags, lat: +lat.toFixed(5), lon: +lon.toFixed(5), n: near.length, types });
    }
  }
  return out;
}
export function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3); }

// Tagesdatei zusammenführen: bestehende Stundenwerte + neue
export function mergeHourly(dayDoc, hourly, { day, at, dt, srcModes }) {
  const doc = dayDoc && dayDoc.day === day ? dayDoc : { day, runs: [], groups: {}, version: TRACK_VERSION };
  doc.runs.push([at, dt, 1]); // 1 = Lauf zählt Fahrzeugminuten (vmin/vminTot)
  for (const [k, h] of hourly) {
    const g = doc.groups[k] || (doc.groups[k] = emptyHourly());
    for (const f of HOUR_FIELDS) { g[f] ??= arr(24); for (let i = 0; i < 24; i++) g[f][i] += h[f][i]; }
    for (const f of ['swapWaitSum', 'swapWaitN', 'disDurSum', 'disDurN', 'tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN']) g[f] += h[f];
  }
  doc.srcModes = srcModes;
  return doc;
}
// Zellen je Bundesland: { ags: { cell: [start,end,present,reloc] } }
export function mergeCells(doc, cells, munis, day, { dt = null, hour = null } = {}) {
  const out = doc && doc.day === day ? doc : { day, version: TRACK_VERSION, states: {} };
  out.bandMin ??= new Array(BANDS.length).fill(0); out.bandRuns ??= new Array(BANDS.length).fill(0);
  if (hour != null) { const b = bandOf(hour); out.bandRuns[b]++; if (dt != null) out.bandMin[b] += Math.min(dt, 45 * 60e3) / 60e3; }
  for (const [ags, m] of cells) {
    const st = munis[ags]?.state || 'XX';
    const sdoc = (out.states[st] ??= {});
    const a = (sdoc[ags] ??= {});
    for (const [cell, v] of m) { const c = a[cell] || (a[cell] = new Array(CELL_LEN).fill(0)); while (c.length < CELL_LEN) c.push(0); for (let i = 0; i < CELL_LEN; i++) c[i] += v[i] || 0; }
  }
  return out;
}
export function stationQuota(state) {
  const out = [];
  for (const e of Object.values(state.s)) {
    let runs = 0, empty = 0, full = 0; for (const d of Object.values(e.d)) { runs += d[0]; empty += d[1]; full += d[2]; }
    if (!runs) continue;
    out.push([state.dict.ags[e.ags], state.dict.op[e.op], e.name, e.lat, e.lon, runs, empty, full]);
  }
  return out;
}
export function reliability(state) {
  const out = {};
  for (const [id, e] of Object.entries(state.rel)) { let runs = 0, live = 0, delayed = 0, stale = 0, err = 0, lat = 0; for (const d of Object.values(e)) { runs += d[0]; live += d[1]; delayed += d[2]; stale += d[3]; err += d[4]; lat += d[5]; } out[id] = { runs, live, delayed, stale, err, latencyAvg: runs ? Math.round(lat / runs) : null, days: Object.keys(e).length }; }
  return out;
}
