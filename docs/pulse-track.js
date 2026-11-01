// Mobility Pulse — Fahrzeug-Verfolgung über Sammler-Läufe hinweg.
// Reine Funktionen, keine Abhängigkeiten. Speichert nur gehashte Kennungen und gerundete Positionen.
import { haversineM, normalizeId, hashStr, hourMinutes } from './pulse-core.js?v=mvxyn4sh';

export const TRACK_VERSION = 2;
export const GAP_MS = 45 * 60e3;  // größerer Abstand zum vorigen Lauf = Lücke: Zustand fortschreiben, keine Ereignisse zählen
export const MOVE_M = 150;        // ab hier gilt ein Positionswechsel bei gleicher Kennung als Umsetzung (bzw. Fahrt bei stabilen Kennungen)
export const TRANSPORT_MIN = 3, TRANSPORT_M = 40; // stabile Kennungen: ≥ 3 ankommende Fahrzeuge eines Anbieters ≤ 40 m beieinander = Sammeltransport (Umsetzung)
// Fahrt-Plausibilität bei stabilen Kennungen (Xu et al. 2020): Luftlinie / Laufintervall zwischen 3,5 und 24 km/h, sonst gesondert gezählt (slow/fast)
export const TRIP_MIN_KMH = 3.5, TRIP_MAX_KMH = 24, TRIP_MAX_MS = 2 * 3600e3;
export const NOLOSS_M = 2000;     // stabile Kennung ≥ 2 km versetzt ohne Ladestandverlust = Umsetzung (Transport), keine Fahrt
export const ENERGY_TOL = 2;      // Ladestand „gleich“: ± 2 Prozentpunkte (Kennungswechsel-Abgleich, Reichweiten-Fingerabdruck nach Das & Nicklas 2026)
export const ROTATE_ENERGY_M = 100; // Kennungswechsel mit gleichem Ladestand bis 100 m, ohne Ladestandangabe bis ROTATE_M (40 m)
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

// 64-Bit-Hash aus zwei FNV-1a-Läufen (Kollisionen bei ~250k Schlüsseln praktisch ausgeschlossen).
// Mit hmac (Sammler, Salt im privaten Track-Verzeichnis): HMAC-SHA256 statt des nachrechenbaren Hashes.
export function vehicleKey(operator, rawId, hmac = null) {
  const s = `${operator}|${normalizeId(rawId)}`;
  return hmac ? hmac(s) : hashStr(s) + hashStr(s + '#2');
}
// HMAC-Digest (Uint8Array/Buffer) auf 64 Bit kürzen, base36 wie der alte Schlüssel
export function keyFromDigest(digest) {
  let n = 0n; for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(digest[i]);
  return n.toString(36);
}
const trackable = (v) => Number.isFinite(v.lat) && Number.isFinite(v.lon) && !!v.ags && v.ags !== 'unbekannt';
// Zustand auf neue Schlüssel umziehen: jedes aktuelle Fahrzeug über den alten Schlüssel nachschlagen und unter dem neuen übernehmen;
// alte Einträge ohne Treffer entfallen (im Umzugslauf gibt es so keine „verschwundenen“ Fahrzeuge).
export function migrateState(old, vehicles, oldKey, newKey) {
  const state = { ...old, version: TRACK_VERSION, salted: true, v: {} };
  let moved = 0;
  for (const v of vehicles) {
    if (!trackable(v)) continue;
    const e = old.v?.[oldKey(v.operator, v.rawId)];
    if (e) { state.v[newKey(v.operator, v.rawId)] = e; moved++; }
  }
  return { state, moved, dropped: Object.keys(old.v || {}).length - moved };
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

// F_SILENT: verschwunden, ohne dass ein Fahrtbeginn gezählt wurde (Lauf nach Lücke, Quellenausfall) → Rückkehr zählt kein Fahrtende
const F_DISABLED = 1, F_RESERVED = 2, F_MISSING = 4, F_SILENT = 8;
const arr = (n) => new Array(n).fill(0);
export const ROTATE_M = 40;     // Kennung verschwindet und neue taucht ≤ 40 m daneben auf: Kennungswechsel am Ort, keine Fahrt
// slow/fast: Versatz einer stabilen Kennung außerhalb 3,5–24 km/h (keine Fahrt, gesondert gezählt)
export const HOUR_FIELDS = ['start', 'end', 'reloc', 'swap', 'pickup', 'disOn', 'disOff', 'rot', 'vmin', 'vminTot', 'slow', 'fast'];
export function emptyHourly() { return { start: arr(24), end: arr(24), reloc: arr(24), swap: arr(24), pickup: arr(24), disOn: arr(24), disOff: arr(24), rot: arr(24), vmin: arr(24), vminTot: arr(24), slow: arr(24), fast: arr(24), swapWaitSum: 0, swapWaitN: 0, disDurSum: 0, disDurN: 0, tripDurSum: 0, tripDurN: 0, tripDistSum: 0, tripDistN: 0 }; }
// Kennungswechsel-Abgleich: 'rot' (gleicher Ladestand ≤ 100 m bzw. ohne Angabe ≤ 40 m), 'swap' (Ladestand springt am Ort nach oben), sonst null
function pairKind(gb, ab, d) {
  if (gb != null && ab != null) {
    if (Math.abs(gb - ab) <= ENERGY_TOL) return d <= ROTATE_ENERGY_M ? 'rot' : null;
    return gb < SWAP_FROM && ab >= SWAP_TO && d <= ROTATE_M ? 'swap' : null;
  }
  return d <= ROTATE_M ? 'rot' : null;
}

/**
 * Ein Sammler-Lauf gegen den letzten Zustand.
 * vehicles: deduplizierte Fahrzeuge {operator, rawId, lat, lon, batteryPct, disabled, reserved, type, ags, sourceId}
 * stations: deduplizierte Stationen {operator, id, name, lat, lon, ags, bookable, docksAvailable, renting, installed, returning, isVirtual}
 * sourceRecs: Quellen-Datensätze des Laufs {id, status, latencyMs}
 * hmac: optionale Schlüsselfunktion (gesalzen, siehe vehicleKey); noEvents: Lauf zählt nichts (z. B. Umzug auf neue Schlüssel)
 * Rückgabe: { state, first, dt, gap, hourly: Map(key→emptyHourly), cells: Map(ags→Map(cell→[start,end,present,reloc])), idle: {...}, idleLong: [...], stationQuota, reliability, srcModes,
 *   flows: Map('ags|op|type|band' → Map('vonZelle>nachZelle' → {count, durSum, distSum})) }
 * gap = Lauf nach Lücke (dt > GAP_MS) oder noEvents: Zustand wird fortgeschrieben, hourly/cells/flows bleiben leer, keine Gruppen.
 * flows: Fahrten mit bekanntem Start und Ziel, nur Quellen mit stabilen Kennungen (modeOf 'stable'): Versatz ≥ 150 m, als Fahrt gewertet
 * (Start = alte Zelle, Dauer = Laufintervall), oder Rückkehr ≥ 150 m vom Ort des Verschwindens (Dauer = Zeit seit dem Verschwinden ≤ 2 h; nicht nach
 * Sperrung/Akku < 15 %, nicht aufgeladen, nicht im Sammeltransport, nicht schneller als 24 km/h). ags = Gemeinde des Starts, band = Tageszeit-Band
 * des Laufs (Ende), durSum in ms, distSum = Luftlinie in m. Rotierende Kennungen werden NICHT verknüpft (keine Re-Identifizierung über Reichweite o. Ä.).
 *
 * Methode: Verschwundene und neu aufgetauchte Kennungen eines Anbieters und einer Fahrzeugart werden global gepaart (alle Kandidatenpaare
 * nach Kosten sortiert): gleicher Ladestand (± ENERGY_TOL) bis 100 m bzw. ohne Ladestand bis 40 m = Kennungswechsel, Ladestand springt am
 * Ort von < 40 auf ≥ 85 % = Akkutausch; beides keine Fahrt. Übrige verschwundene = Fahrtbeginn (gesperrt/Akku < 15 % = Abholung), übrige
 * neue = Fahrtende. Stabile Kennungen ≥ 150 m versetzt: Fahrt (Start alt, Ende neu), wenn Luftlinie/Laufintervall 3,5–24 km/h, sonst
 * slow/fast; Umsetzung bei Sammeltransport (≥ 3 Ankünfte ≤ 40 m), Sperrung oder ≥ 2 km ohne Ladestandverlust.
 */
export function trackRun(prev, { vehicles, stations, sourceRecs, now, tz = 'Europe/Berlin', hmac = null, noEvents = false }) {
  const state = prev && prev.version === TRACK_VERSION ? prev : emptyState(now);
  if (hmac) state.salted = true;
  const first = state.at == null;
  const dt = first ? null : now - state.at;
  const gap = (dt != null && dt > GAP_MS) || (!!noEvents && !first);
  const hour = hourOf(now, tz), day = dayOf(now, tz);
  const hourly = new Map();
  const voidH = emptyHourly(), voidC = new Array(CELL_LEN).fill(0); // Lücken-Lauf: Zählungen laufen ins Leere
  const H = (op, ags, ty) => { if (gap) return voidH; const k = `${ags}|${op}|${ty}`; if (!hourly.has(k)) hourly.set(k, emptyHourly()); return hourly.get(k); };
  const cells = new Map();
  const CELL = (ags, cell) => { if (gap) return voidC; if (!cells.has(ags)) cells.set(ags, new Map()); const m = cells.get(ags); if (!m.has(cell)) m.set(cell, new Array(CELL_LEN).fill(0)); return m.get(cell); };
  const band = bandOf(hour);
  const flows = new Map(); // Start-Ziel-Ströme (nur stabile Kennungen), siehe oben
  const FLOW = (ags, op, ty, from, to, dur, dist) => {
    if (gap) return;
    const k = `${ags}|${op}|${ty}|${band}`; let m = flows.get(k); if (!m) flows.set(k, m = new Map());
    const p = `${from}>${to}`; const f = m.get(p) || { count: 0, durSum: 0, distSum: 0 }; f.count++; f.durSum += dur; f.distSum += dist; m.set(p, f);
  };
  const rets = []; // Rückkehrer stabiler Kennungen: Strom erst nach der Sammeltransport-Prüfung
  const dict = state.dict;
  const D = (name, v) => dictIdx(dict, name, v);
  const seen = new Set();
  const srcRun = {}; // sourceId → {present, gone, moved, newc, returned}
  const S = (src) => (srcRun[src] ??= { present: 0, gone: 0, moved: 0, newc: 0, returned: 0 });
  // Kennungsmodus je Quelle aus bisherigen Läufen: stabil, wenn Kennungen wiederkehren oder sich bewegen
  const modeOf = (src) => { const st = state.srcStats[src]; if (!st || st.runs < 2) return 'unknown'; const ret = st.returned + st.moved, gone = st.gone; if (ret + gone < 20) return 'unknown'; return ret / (ret + gone) > 0.25 ? 'stable' : 'rotating'; };
  const recById = new Map((sourceRecs || []).map(r => [r.id, r]));

  // --- Fahrzeuge ---
  const idleAgg = new Map(); // key(ags|op|ty) → [b0..b4, n]
  const idleLong = [];
  const dtMin = dt != null && !gap ? Math.min(dt, GAP_MS) / 60e3 : 0; // Beobachtungsfenster dieses Laufs (Fahrzeugminuten)
  const arrivals = [], departures = []; // für die Gruppen-Erkennung (Ausbringen/Einsammeln)
  const appeared = []; // neue Kennungen: erst nach dem Abgleich mit verschwundenen als Fahrtende zählen
  const moves = []; // stabile Kennungen mit Versatz ≥ MOVE_M: Fahrt, slow/fast oder Sammeltransport, Entscheidung nach der Schleife
  const landed = []; // Ankünfte stabiler Kennungen (Versatz oder Rückkehr) für die Sammeltransport-Prüfung
  for (const v of vehicles) {
    if (!trackable(v)) continue;
    const key = vehicleKey(v.operator, v.rawId, hmac);
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
      if (!first) appeared.push({ key, v, ty, c, bat });
      continue;
    }
    s.present++;
    const [plat, plon, pbat, pflags, pty, pop, pags, firstSeen, lastMoved, lowSince, disSince, psrc, missingSince] = e;
    const dist = haversineM(plat / 1e5, plon / 1e5, v.lat, v.lon);
    const wasMissing = !!(pflags & F_MISSING);
    const silent = wasMissing && !!(pflags & F_SILENT); // verschwunden ohne gezählten Beginn (Lücke/Ausfall): Rückkehr still
    const h = H(v.operator, v.ags, ty);
    const stable = modeOf(v.sourceId) === 'stable';
    if (silent) { /* nur Zustand fortschreiben */ }
    else if (wasMissing) {
      // Rückkehr einer bekannten Kennung = Fahrtende mit bekanntem Start (stabile Kennungen); Dauer > 2 h fließt nicht in Ø Dauer/Distanz
      s.returned++;
      h.end[hour]++; c[1]++; c[16 + band]++;
      const dur = now - (missingSince || state.at || now);
      if (dist >= JITTER_M && dur <= TRIP_MAX_MS) { h.tripDistSum += dist; h.tripDistN++; h.tripDurSum += dur; h.tripDurN++; }
      if (stable && dist >= MOVE_M) landed.push({ op: v.operator, lat: v.lat, lon: v.lon });
      // Strom nur, wenn das Verschwinden als Fahrtbeginn galt (nicht gesperrt, Akku ≥ 15 %) und das Fahrzeug nicht aufgeladen zurückkommt
      if (stable && dist >= MOVE_M && dur <= TRIP_MAX_MS && !v.disabled && !(pflags & F_DISABLED) && !(pbat != null && pbat < PICKUP_BATTERY) && !(bat != null && pbat != null && bat > pbat + ENERGY_TOL))
        rets.push({ op: v.operator, ty, ags: dict.ags[pags], from: cellOf(plat / 1e5, plon / 1e5), to: cell, lat: v.lat, lon: v.lon, dist, dur, noLoss: bat != null && pbat != null && bat >= pbat && dist >= NOLOSS_M });
    } else if (dist >= MOVE_M) {
      s.moved++;
      if (stable && !v.disabled && !(pflags & F_DISABLED)) {
        // stabile Kennungen bleiben während der Fahrt im Feed: Versatz = Fahrt (Start am alten Ort), außer Sammeltransport usw. (unten)
        const m = { key, op: v.operator, ty, ags: v.ags, agsOld: dict.ags[pags], cellOld: cellOf(plat / 1e5, plon / 1e5), c, lat: v.lat, lon: v.lon, dist, pbat, bat, src: v.sourceId };
        moves.push(m); landed.push(m);
      } else {
        // rotierende Kennungen (Fahrten entfernen das Fahrzeug aus dem Feed) bzw. gesperrt: Umsetzung durch den Betreiber
        h.reloc[hour]++; c[3]++;
        arrivals.push({ op: v.operator, ty, ags: v.ags, lat: v.lat, lon: v.lon, src: v.sourceId });
      }
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
  // --- Versatz bei stabilen Kennungen: Sammeltransport / ohne Energieverlust = Umsetzung, sonst Fahrt (3,5–24 km/h) bzw. slow/fast ---
  if (moves.length || rets.length) {
    const TGA = 0.0004, TGO = 0.0007; const tk = (op, la, lo) => `${op}|${Math.floor(la / TGA)}:${Math.floor(lo / TGO)}`; // Zelle ≥ 40 m
    const tgrid = new Map(); for (const p of landed) { const k = tk(p.op, p.lat, p.lon); if (!tgrid.has(k)) tgrid.set(k, []); tgrid.get(k).push(p); }
    const kmh = (m) => (m.dist / 1000) / (dt / 3600e3);
    const nearOf = (m) => { const gi = Math.floor(m.lat / TGA), gj = Math.floor(m.lon / TGO); let near = 0; for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const o of tgrid.get(`${m.op}|${gi + di}:${gj + dj}`) || []) if (haversineM(m.lat, m.lon, o.lat, o.lon) <= TRANSPORT_M) near++; return near; };
    for (const m of moves) {
      const near = nearOf(m); // zählt m selbst mit
      const noLoss = m.pbat != null && m.bat != null && m.bat >= m.pbat && m.dist >= NOLOSS_M;
      const h = H(m.op, m.ags, m.ty);
      if (near >= TRANSPORT_MIN || noLoss) { h.reloc[hour]++; m.c[3]++; arrivals.push({ op: m.op, ty: m.ty, ags: m.ags, lat: m.lat, lon: m.lon, src: m.src }); continue; }
      const v = kmh(m);
      if (v > TRIP_MAX_KMH) { h.fast[hour]++; arrivals.push({ op: m.op, ty: m.ty, ags: m.ags, lat: m.lat, lon: m.lon, src: m.src }); continue; }
      if (v < TRIP_MIN_KMH) { h.slow[hour]++; continue; }
      H(m.op, m.agsOld, m.ty).start[hour]++; const co = CELL(m.agsOld, m.cellOld); co[0]++; co[4 + band]++;
      h.end[hour]++; m.c[1]++; m.c[16 + band]++;
      h.tripDistSum += m.dist; h.tripDistN++; h.tripDurSum += dt; h.tripDurN++; // Dauer ≤ dt (Obergrenze)
      FLOW(m.agsOld, m.op, m.ty, m.cellOld, cellOf(m.lat, m.lon), dt, m.dist);
    }
    // Rückkehrer: Sammeltransport (≥ 3 Ankünfte ≤ 40 m), ≥ 2 km ohne Ladestandverlust oder selbst bei längster möglicher Dauer (seit Verschwinden + Laufintervall) > 24 km/h = kein Strom
    for (const r of rets) {
      if (nearOf(r) >= TRANSPORT_MIN || r.noLoss || (r.dist / 1000) / ((r.dur + dt) / 3600e3) > TRIP_MAX_KMH) continue;
      FLOW(r.ags, r.op, r.ty, r.from, r.to, r.dur, r.dist);
    }
  }
  // --- Verschwundene Fahrzeuge ---
  const goneList = [];
  if (!first) {
    for (const [key, e] of Object.entries(state.v)) {
      if (seen.has(key)) continue;
      const flags = e[3];
      if (flags & F_MISSING) { if (now - e[12] > MISSING_KEEP_MS) delete state.v[key]; continue; }
      const srcN = dict.src[e[11]];
      const srcRec = recById.get(srcN);
      const srcUsable = !srcRec || srcRec.status === 'live' || srcRec.status === 'delayed';
      // Quelle ausgefallen: nicht als Fahrt werten, Kennung still behalten (Rückkehr zählt kein Fahrtende)
      if (!srcUsable) { e[3] = flags | F_MISSING | F_SILENT; e[12] = now; continue; }
      S(srcN).gone++;
      goneList.push({ key, e, opN: dict.op[e[5]], agsN: dict.ags[e[6]], srcN, lat: e[0] / 1e5, lon: e[1] / 1e5 });
    }
    // Kennungswechsel/Akkutausch mit neuer Kennung: alle Kandidatenpaare (gleicher Anbieter, gleiche Art) nach Kosten, dann vergeben
    if (goneList.length && appeared.length) {
      const CLA = 0.001, CLO = 0.0016; const gk = (la, lo) => `${Math.floor(la / CLA)}:${Math.floor(lo / CLO)}`; // Zelle ≥ 100 m
      const grid = new Map(); appeared.forEach((a, i) => { const k = gk(a.v.lat, a.v.lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
      const pairs = [];
      goneList.forEach((g, gi) => {
        const ci = Math.floor(g.lat / CLA), cj = Math.floor(g.lon / CLO); const gb = g.e[2];
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const ai of grid.get(`${ci + di}:${cj + dj}`) || []) {
          const a = appeared[ai]; if (a.v.operator !== g.opN || a.ty !== g.e[4]) continue;
          const d = haversineM(g.lat, g.lon, a.v.lat, a.v.lon); if (d > ROTATE_ENERGY_M) continue;
          const kind = pairKind(gb, a.bat, d); if (!kind) continue;
          pairs.push([kind === 'swap' ? d + 100 : d + (gb != null && a.bat != null ? 10 * Math.abs(gb - a.bat) : 0), gi, ai, kind]);
        }
      });
      pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
      for (const [, gi, ai, kind] of pairs) { const g = goneList[gi], a = appeared[ai]; if (g.match || a.used) continue; g.match = { a, kind }; a.used = true; }
    }
    for (const g of goneList) {
      const { key, e } = g;
      const [lat, lon, bat, flags, ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src] = e;
      const h = H(g.opN, g.agsN, ty);
      if (g.match) {
        // dasselbe Fahrzeug unter neuer Kennung: Standzeit und erste Sichtung übernehmen
        const ne = state.v[g.match.a.key]; const s = S(g.srcN); s.gone--; s.rotated = (s.rotated || 0) + 1;
        ne[7] = firstSeen; ne[8] = lastMoved;
        if (g.match.kind === 'swap') { h.swap[hour]++; if (lowSince) { h.swapWaitSum += now - lowSince; h.swapWaitN++; } ne[9] = 0; }
        else { h.rot[hour]++; if (!ne[9] && lowSince) ne[9] = lowSince; if (!ne[10] && disSince && g.match.a.v.disabled) ne[10] = disSince; }
        delete state.v[key]; continue;
      }
      const c = CELL(g.agsN, cellOf(g.lat, g.lon));
      if ((flags & F_DISABLED) || (bat != null && bat < PICKUP_BATTERY)) { h.pickup[hour]++; }
      else { h.start[hour]++; c[0]++; c[4 + band]++; }
      departures.push({ op: g.opN, ty, ags: g.agsN, lat: g.lat, lon: g.lon, src: g.srcN });
      state.v[key] = [lat, lon, bat, flags | F_MISSING | (gap ? F_SILENT : 0), ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src, now];
    }
    // übrige neue Kennungen = Fahrtende bzw. Neuaufstellung
    for (const a of appeared) { if (a.used) continue; H(a.v.operator, a.v.ags, a.ty).end[hour]++; a.c[1]++; a.c[16 + band]++; arrivals.push({ op: a.v.operator, ty: a.ty, ags: a.v.ags, lat: a.v.lat, lon: a.v.lon, src: a.v.sourceId }); }
  }
  // --- Quellenstatistik (rollierend, gedämpft; Lücken-Läufe verzerren den Kennungsmodus und zählen nicht) ---
  if (!gap) for (const [src, s] of Object.entries(srcRun)) {
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
    e.name = String(s.name || e.name || '').slice(0, 60); e.lat = +s.lat.toFixed(5); e.lon = +s.lon.toFixed(5); e.vs = s.isVirtual === true ? 1 : 0; // virtuell (Abstellzone)
    const dd = (e.d[day] ??= [0, 0, 0]);
    const open = s.installed !== false && s.renting !== false;
    // leer nur, wenn auch im Umkreis kein Fahrzeug des Anbieters steht (nearbyVehicles aus aggregateGroups)
    dd[0]++; if (open && (s.bookable ?? 0) === 0 && !(s.nearbyVehicles > 0)) dd[1]++; if (s.installed !== false && s.returning !== false && s.docksAvailable === 0) dd[2]++;
    for (const k of Object.keys(e.d)) if (daysBetween(k, day) > 7) delete e.d[k];
    state.s[key] = e;
  }
  for (const [key, e] of Object.entries(state.s)) { if (seenSt.has(key)) continue; const last = Object.keys(e.d).sort().pop(); if (!last || daysBetween(last, day) > 7) delete state.s[key]; }

  // --- Zuverlässigkeit je Quelle (7 Tage); Dubletten zählen mit dem Status ihres Feeds (feedStatus) ---
  for (const r of sourceRecs) {
    const e = (state.rel[r.id] ??= {});
    const dd = (e[day] ??= [0, 0, 0, 0, 0, 0]); // runs, live, delayed, stale, error/gone/auth, latencySum
    const st = r.feedStatus || r.status;
    dd[0]++; if (st === 'live') dd[1]++; else if (st === 'delayed') dd[2]++; else if (st === 'stale') dd[3]++; else dd[4]++; dd[5] += r.latencyMs || 0;
    for (const k of Object.keys(e)) if (daysBetween(k, day) > 7) delete e[k];
  }
  for (const id of Object.keys(state.rel)) if (!recById.has(id)) { const last = Object.keys(state.rel[id]).sort().pop(); if (!last || daysBetween(last, day) > 7) delete state.rel[id]; }

  state.prevAt = state.at; state.at = now; state.day = day;
  const idle = {}; for (const [k, a] of idleAgg) idle[k] = a;
  // Gruppen: ≥ GROUP_MIN Fahrzeuge eines Anbieters tauchen in einem Lauf ≤ GROUP_M beieinander auf (Ausbringen)
  // bzw. verschwinden zusammen (Einsammeln). Quellen mit Massenwechsel (Ausfall, Neustart) zählen nicht.
  const glitch = new Set(Object.entries(srcRun).filter(([, r]) => (r.newc + r.gone) > 0.3 * Math.max(1, r.present + r.newc)).map(([k]) => k));
  const groups = first || gap ? [] : [...clusterGroups(arrivals.filter(a => !glitch.has(a.src)), 'deploy', now), ...clusterGroups(departures.filter(a => !glitch.has(a.src)), 'collect', now)];
  return { state, first, dt, gap, hourly, cells, idle, idleLong, srcModes, day, hour, groups, flows };
}

// Ab 4 Fahrzeugen (Nutzerwunsch 01.11.2026, bisher 5): kleinere Transporter-Ausbringungen werden sichtbar
export const GROUP_MIN = 4, GROUP_M = 40;
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
// ---------- Gruppen-Ereignisse dauerhaft: groups/<JJJJ-MM>.json (Monat nach Europe/Berlin) + groups/index.json ----------
// Zeile nach GROUP_FIELDS: [at (ms), art ('deploy'|'collect'), anbieter, gemeinde (AGS), lat, lon, anzahl, arten {Fahrzeugart: n}]
export const GROUP_FIELDS = ['at', 'art', 'anbieter', 'gemeinde', 'lat', 'lon', 'anzahl', 'arten'];
export const GROUP_VERSION = 1;
export const groupRow = (g) => [g.at, g.kind, g.op, g.ags, g.lat, g.lon, g.n, g.types];
const groupKey = (e) => `${e[0]}|${e[1]}|${e[2]}|${e[4]}|${e[5]}`;
/**
 * Ereignisse in Monatsdokumente einsortieren. docs = { 'JJJJ-MM': bisheriges Dokument | null }, rows = neue Zeilen.
 * Rückgabe: nur die geänderten Monate { 'JJJJ-MM': { version, month, fields, events (nach at sortiert), updatedAt } }; dasselbe Ereignis
 * (gleicher Lauf, Art, Anbieter, Ort) steht nur einmal darin. Nichts wird gelöscht.
 */
export function mergeGroupMonths(docs, rows, { at = null, tz = 'Europe/Berlin' } = {}) {
  const out = {}, keys = {};
  for (const r of rows || []) {
    if (!Array.isArray(r) || !Number.isFinite(r[0])) continue;
    const m = dayOf(r[0], tz).slice(0, 7);
    if (!out[m]) { const d = docs?.[m]; out[m] = { version: GROUP_VERSION, month: m, fields: GROUP_FIELDS, events: d?.month === m && Array.isArray(d.events) ? d.events.slice() : [] }; keys[m] = new Set(out[m].events.map(groupKey)); }
    const k = groupKey(r); if (keys[m].has(k)) continue; keys[m].add(k); out[m].events.push(r);
  }
  for (const d of Object.values(out)) { d.events.sort((a, b) => a[0] - b[0]); d.updatedAt = at; }
  return out;
}
/** Verzeichnis groups/index.json: months (aufsteigend), counts je Monat, Gesamtzahl, erstes/letztes Ereignis, Regeln der Erkennung */
export function groupIndex(months, counts, { at = null, first = null, last = null } = {}) {
  const ms = [...new Set(months || [])].filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
  return { version: GROUP_VERSION, months: ms, counts: Object.fromEntries(ms.map(m => [m, counts?.[m] ?? 0])), events: ms.reduce((s, m) => s + (counts?.[m] ?? 0), 0), first, last, fields: GROUP_FIELDS, min: GROUP_MIN, radiusM: GROUP_M, updatedAt: at };
}
export function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3); }

// Tagesdatei zusammenführen: bestehende Stundenwerte + neue
// runs[k] = [at, dt, flag]: 1 = Lauf zählt Ereignisse und Fahrzeugminuten, 0 = Lauf nach Lücke (> 45 Min.) bzw. ohne Zählung.
// gapHours = Stunden (tz) mit einem Lauf mit Flag 0: gestört → Seite zeigt sie grau und nimmt sie aus Hochrechnungen.
// Ältere Läufe mit dt > 45 Min. (vor der Lückenregel, Ereignisse wurden noch gezählt) werden nachträglich auf 0 gesetzt.
export function gapHoursOf(runs, tz = 'Europe/Berlin') { return [...new Set((runs || []).filter(r => r[2] === 0).map(r => hourOf(r[0], tz)))].sort((a, b) => a - b); }
export function mergeHourly(dayDoc, hourly, { day, at, dt, srcModes, gap = false, tz = 'Europe/Berlin' }) {
  const doc = dayDoc && dayDoc.day === day ? dayDoc : { day, runs: [], groups: {}, version: TRACK_VERSION };
  doc.runs.push([at, dt, gap ? 0 : 1]);
  for (const r of doc.runs) if (r[1] != null && r[1] > GAP_MS && r[2] !== 0) r[2] = 0;
  doc.gapHours = gapHoursOf(doc.runs, tz);
  doc.hourMin ??= hourMinutes(day, tz); // Minuten je Ortsstunde (Zeitumstellung: Stunde 2 = 120 bzw. 0)
  for (const [k, h] of hourly) {
    const g = doc.groups[k] || (doc.groups[k] = emptyHourly());
    for (const f of HOUR_FIELDS) { g[f] ??= arr(24); for (let i = 0; i < 24; i++) g[f][i] += h[f][i]; }
    for (const f of ['swapWaitSum', 'swapWaitN', 'disDurSum', 'disDurN', 'tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN']) g[f] += h[f];
  }
  doc.srcModes = srcModes;
  return doc;
}
// Zellen je Bundesland: { ags: { cell: [start,end,present,reloc] } }
export function mergeCells(doc, cells, munis, day, { dt = null, hour = null, gap = false } = {}) {
  const out = doc && doc.day === day ? doc : { day, version: TRACK_VERSION, states: {} };
  out.bandMin ??= new Array(BANDS.length).fill(0); out.bandRuns ??= new Array(BANDS.length).fill(0);
  if (hour != null && !gap) { const b = bandOf(hour); out.bandRuns[b]++; if (dt != null) out.bandMin[b] += Math.min(dt, GAP_MS) / 60e3; }
  for (const [ags, m] of cells) {
    const st = munis[ags]?.state || 'XX';
    const sdoc = (out.states[st] ??= {});
    const a = (sdoc[ags] ??= {});
    for (const [cell, v] of m) { const c = a[cell] || (a[cell] = new Array(CELL_LEN).fill(0)); while (c.length < CELL_LEN) c.push(0); for (let i = 0; i < CELL_LEN; i++) c[i] += v[i] || 0; }
  }
  return out;
}
// ---------- Start-Ziel-Ströme: Tagessumme (privat) und veröffentlichte Tagesdatei ----------
// Rohsummen liegen nur neben dem Verfolgungszustand (TRACK_DIR, nicht im Datenzweig). Veröffentlicht wird ein Tag erst, wenn er vorbei ist:
// eine je Lauf fortgeschriebene Datei würde im Vergleich zweier Stände einzelne Fahrten (Zellenpaar, 20-Min.-Fenster) zeigen.
export const FLOW_VERSION = 1;
export const FLOW_MIN = 2;   // je Tag und Zellenpaar mindestens 2 Fahrten in jeder veröffentlichten Zeile
export const FLOW_TOP = 300; // je Gemeinde höchstens so viele Zeilen (nach Anzahl), Rest als „außerhalb Top“
export const FLOW_FIELDS = ['gemeinde', 'von', 'nach', 'anbieter', 'art', 'band', 'anzahl', 'dauer_s', 'luftlinie_m'];
/** Gemeinde → Anbieter mit stabilen Kennungen (aus srcModes und den Quellen-Datensätzen {id, operator, municipalities}) */
export function stableOps(srcModes, sources) {
  const out = {};
  for (const r of sources || []) { if (srcModes?.[r.id] !== 'stable') continue; for (const ags of r.municipalities || []) { const a = (out[ags] ??= []); if (!a.includes(r.operator)) a.push(r.operator); } }
  for (const a of Object.values(out)) a.sort();
  return out;
}
/** Tagessumme fortschreiben: { version, day, runs, rows: { 'ags|op|type|band': { 'von>nach': [anzahl, dauerMs, luftlinieM] } }, stable: { ags: [op] } }; neuer Tag = neue Summe */
export function mergeFlows(raw, flows, { day, gap = false, stable = null } = {}) {
  const doc = raw && raw.day === day && raw.version === FLOW_VERSION ? raw : { version: FLOW_VERSION, day, runs: 0, rows: {}, stable: {} };
  if (!gap) doc.runs++;
  for (const [k, m] of flows || []) { const r = (doc.rows[k] ??= {}); for (const [p, f] of m) { const a = (r[p] ??= [0, 0, 0]); a[0] += f.count; a[1] += f.durSum; a[2] += f.distSum; } }
  for (const [ags, ops] of Object.entries(stable || {})) { const a = (doc.stable[ags] ??= []); for (const op of ops) if (!a.includes(op)) a.push(op); a.sort(); }
  return doc;
}
// Zusammenfassung je Zellenpaar, von fein nach grob: [Anbieter, Art, Band] behalten (1) oder zusammenfassen (0).
// Jede Stufe nimmt nur, was die feinere übrig ließ; Zeilen sind überschneidungsfrei, jede mit ≥ min Fahrten. Was auch grob unter min bleibt: „unter Mindestschwelle“.
const FLOW_LEVELS = [[1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0], [0, 0, 0]];
/**
 * Veröffentlichte Tagesdatei aus der Tagessumme. flows-Zeilen nach FLOW_FIELDS: [ags(Start), von, nach (Zellen wie cellOf), anbieter|null, art|null, band|null,
 * anzahl, dauer_s (Summe), luftlinie_m (Summe)]; null = über mehrere zusammengefasst (einzeln unter der Mindestschwelle).
 * munis[ags] = { trips, shown, below, cut, ops: {Anbieter: Fahrten} }: trips = shown + below + cut.
 */
export function publishFlows(raw, { min = FLOW_MIN, top = FLOW_TOP, at = null } = {}) {
  const pairs = new Map(), munis = {};
  const M = (ags) => (munis[ags] ??= { trips: 0, shown: 0, below: 0, cut: 0, ops: {} });
  for (const [k, r] of Object.entries(raw?.rows || {})) {
    const [ags, op, ty, b] = k.split('|');
    for (const [p, a] of Object.entries(r)) {
      if (!(a[0] > 0)) continue;
      const pk = `${ags}|${p}`; if (!pairs.has(pk)) pairs.set(pk, []);
      pairs.get(pk).push({ op, ty, band: +b, n: a[0], dur: a[1], dist: a[2] });
      const m = M(ags); m.trips += a[0]; m.ops[op] = (m.ops[op] || 0) + a[0];
    }
  }
  const byAgs = new Map();
  for (const [pk, units] of pairs) {
    const i = pk.indexOf('|'), ags = pk.slice(0, i), [from, to] = pk.slice(i + 1).split('>');
    let rest = units;
    for (const [kOp, kTy, kBand] of FLOW_LEVELS) {
      if (!rest.length) break;
      const g = new Map();
      for (const u of rest) { const gk = `${kOp ? u.op : ''}\u0000${kTy ? u.ty : ''}\u0000${kBand ? u.band : ''}`; if (!g.has(gk)) g.set(gk, []); g.get(gk).push(u); }
      rest = [];
      for (const list of g.values()) {
        const n = list.reduce((s, u) => s + u.n, 0);
        if (n < min) { rest.push(...list); continue; }
        const u0 = list[0];
        const row = [ags, from, to, kOp ? u0.op : null, kTy ? u0.ty : null, kBand ? u0.band : null, n, Math.round(list.reduce((s, u) => s + u.dur, 0) / 1000), Math.round(list.reduce((s, u) => s + u.dist, 0))];
        if (!byAgs.has(ags)) byAgs.set(ags, []); byAgs.get(ags).push(row);
      }
    }
    M(ags).below += rest.reduce((s, u) => s + u.n, 0);
  }
  const flows = [];
  for (const [ags, rows] of [...byAgs].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.sort((a, b) => b[6] - a[6] || b[8] - a[8] || `${a[1]}>${a[2]}`.localeCompare(`${b[1]}>${b[2]}`) || String(a[3]).localeCompare(String(b[3])) || String(a[4]).localeCompare(String(b[4])) || (a[5] ?? 9) - (b[5] ?? 9));
    const keep = rows.slice(0, top); flows.push(...keep);
    M(ags).shown = keep.reduce((s, r) => s + r[6], 0); M(ags).cut = rows.slice(top).reduce((s, r) => s + r[6], 0);
  }
  const total = { trips: 0, shown: 0, below: 0, cut: 0 };
  for (const m of Object.values(munis)) for (const f of Object.keys(total)) total[f] += m[f];
  return { version: FLOW_VERSION, day: raw?.day ?? null, at, runs: raw?.runs ?? 0, min, top, cell: [CELL_LAT, CELL_LON], bands: BANDS.map(({ label, from, to }) => ({ label, from, to })), fields: FLOW_FIELDS, flows, munis, stable: raw?.stable || {}, total };
}
export function stationQuota(state) {
  const out = [];
  for (const e of Object.values(state.s)) {
    let runs = 0, empty = 0, full = 0; for (const d of Object.values(e.d)) { runs += d[0]; empty += d[1]; full += d[2]; }
    if (!runs) continue;
    out.push([state.dict.ags[e.ags], state.dict.op[e.op], e.name, e.lat, e.lon, runs, empty, full, e.vs ? 1 : 0]); // letzte Spalte: virtuell (1) / Dock (0)
  }
  return out;
}
export function reliability(state) {
  const out = {};
  for (const [id, e] of Object.entries(state.rel)) { let runs = 0, live = 0, delayed = 0, stale = 0, err = 0, lat = 0; for (const d of Object.values(e)) { runs += d[0]; live += d[1]; delayed += d[2]; stale += d[3]; err += d[4]; lat += d[5]; } out[id] = { runs, live, delayed, stale, err, latencyAvg: runs ? Math.round(lat / runs) : null, days: Object.keys(e).length }; }
  return out;
}
