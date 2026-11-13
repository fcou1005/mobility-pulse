// @ts-check
// Mobility Pulse — Kern – Spiegelquellen, Aggregation (aus pulse-core.js geschnitten; pulse-core.js bleibt die Fassade für alle Importe).
import { DELAYED_MS, haversineM, rangeLowKm, validLatLon } from './pulse-core-base.js';

// ---------- Spiegelquellen mit umgeschlüsselten Kennungen ----------
// MOBIDROM NRW ↔ nextbike direkt, Yoio (rideatom) ↔ MobiData BW, Zeus Heidelberg ↔ Zeus Leimen: dieselben Fahrzeuge unter anderen Kennungen.
// Die Kennungs-Dubletten (dedupeVehicles) greifen hier nicht; erkannt werden die Paare in collect.mjs (consistency.json → pairs: idsRekeyed).
export const MIRROR = { minPos: 0.9, maxDiff: 0.05, knownM: 10, twinM: 5, energyTol: 2, fullBattery: 99, holdRuns: 3 };
/** Stärke zweier Quellen: rank(id) → Liste (kleiner = stärker), bei Gleichstand die Kennung; < 0: a stärker */
export function compareSources(rank) {
  return (a, b) => { const x = rank(a) || [], y = rank(b) || []; for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return a < b ? -1 : a > b ? 1 : 0; };
}
/**
 * Spiegelpaare aus consistency.pairs ({ operator, ags, a: { sourceId }, b: { sourceId }, idsRekeyed, posMatch, countDiff }):
 * whole: `${Quelle}|${Gemeinde}` → stärkere Quelle (umgeschlüsselt, Positionen ≥ minPos gleich, Zahl ± maxDiff: die schwächere Quelle fällt
 * in dieser Gemeinde ganz weg); known: `${Anbieter}|${a}|${b}` (a < b) → { op, winner, loser } für den räumlichen Abgleich in allen Gemeinden.
 * extra: bekannte Paare aus dem vorigen Lauf ([{ operator, of, source }]), damit kleine Gemeinden ohne Paar nicht zwischen den Läufen flackern.
 */
export function mirrorPairs(pairs, cmp, { extra = [], opts = MIRROR } = {}) {
  const whole = new Map(), known = new Map();
  const add = (op, s1, s2) => { if (!op || !s1 || !s2 || s1 === s2) return null; const [winner, loser] = cmp(s1, s2) <= 0 ? [s1, s2] : [s2, s1]; const k = `${op}|${[s1, s2].sort().join('|')}`; if (!known.has(k)) known.set(k, { op, winner, loser }); return known.get(k); };
  for (const p of pairs || []) {
    if (!p?.idsRekeyed) continue;
    const m = add(p.operator, p.a?.sourceId, p.b?.sourceId); if (!m) continue;
    if ((p.posMatch ?? 0) >= opts.minPos && (p.countDiff ?? 1) <= opts.maxDiff && p.ags) whole.set(`${m.loser}|${p.ags}`, m.winner);
  }
  for (const e of extra || []) add(e?.operator, e?.of, e?.source);
  return { whole, known };
}
/**
 * Fahrzeuge aus Spiegelquellen verwerfen (nach dedupeVehicles): 1. ganze schwächere Quelle je Gemeinde (whole); 2. räumliche Zwillinge
 * (gleicher Anbieter, gleiche Art, verschiedene Quellen, eins zu eins, nächstes Paar zuerst): bekanntes Spiegelpaar ≤ knownM m (Ladestand,
 * wo beide ihn melden, ± energyTol), sonst ≤ twinM m mit gleichem Ladestand (beide gemeldet, unter fullBattery – volle Fahrzeuge stehen oft
 * zu mehreren an einem Ausbringort) und gleicher Reichweite (wo beide sie melden). Die schwächere Quelle (cmp) fällt.
 * Rückgabe { vehicles, dropped: [{ v, of, why: 'whole' | 'twin' }], known }.
 */
// Sprint 1, A19: Zwillingsregel ohne bekanntes Paar nicht für Autos und Fahrzeuge an einer Station (traf dort 10,4 % bzw. 6 % verschiedene
// Fahrzeuge, z. B. stadtmobil); Entscheid „ganze Quelle je Gemeinde“ mit Haltezeit: an bzw. aus erst nach holdRuns gleichen Läufen hintereinander
// (hold = Zustand des vorigen Laufs [{ k: 'Quelle|Gemeinde', winner, on, streak }], Rückgabe hold für den nächsten; ohne Zustand gilt der Lauf).
export function holdWhole(raw, hold, n = MIRROR.holdRuns) {
  const prev = new Map((hold || []).map(x => [x.k, x])), out = new Map(), next = [];
  for (const k of new Set([...raw.keys(), ...prev.keys()])) {
    const p = prev.get(k), isOn = raw.has(k);
    if (!p) { if (isOn) out.set(k, raw.get(k)); next.push({ k, winner: raw.get(k) ?? null, on: isOn, streak: 0 }); continue; }
    const streak = isOn !== p.on ? p.streak + 1 : 0, flip = streak >= n;
    const on = flip ? isOn : p.on, winner = raw.get(k) ?? p.winner;
    if (on && winner) out.set(k, winner);
    if (on || isOn || streak) next.push({ k, winner, on, streak: flip ? 0 : streak });
  }
  return { whole: out, hold: next };
}
export function dropMirrorVehicles(vehicles, { pairs = [], rank = (..._a) => [], extra = [], opts = MIRROR, hold = null } = {}) {
  const cmp = compareSources(rank);
  const mp = mirrorPairs(pairs, cmp, { extra, opts }), known = mp.known;
  const held = hold ? holdWhole(mp.whole, hold, opts.holdRuns ?? MIRROR.holdRuns) : null, whole = held ? held.whole : mp.whole;
  const dropped = [], rest = [];
  for (const v of vehicles) { const w = whole.get(`${v.sourceId}|${v.ags}`); if (w) dropped.push({ v, of: w, why: 'whole' }); else rest.push(v); }
  const CL = 0.0001, CO = 0.00015; const grid = new Map(); // Zelle ≈ 11 m
  const gk = (v, i, j) => `${v.operator}|${v.type}|${i}:${j}`;
  for (const v of rest) { if (!validLatLon(v.lat, v.lon)) continue; const k = gk(v, Math.floor(v.lat / CL), Math.floor(v.lon / CO)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(v); }
  const fin = (x) => x != null && Number.isFinite(+x);
  const cands = [];
  for (const v of rest) {
    if (!validLatLon(v.lat, v.lon)) continue;
    const i = Math.floor(v.lat / CL), j = Math.floor(v.lon / CO);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const w of grid.get(gk(v, i + di, j + dj)) || []) {
      if (w === v || !w.sourceId || !v.sourceId || w.sourceId === v.sourceId || cmp(v.sourceId, w.sourceId) > 0) continue; // jedes Paar einmal: v stärker
      const d = haversineM(v.lat, v.lon, w.lat, w.lon);
      const m = known.get(`${v.operator}|${[v.sourceId, w.sourceId].sort().join('|')}`);
      const bothBat = fin(v.batteryPct) && fin(w.batteryPct), bd = bothBat ? Math.abs(v.batteryPct - w.batteryPct) : null;
      let ok;
      if (m) ok = d <= opts.knownM && (bd == null || bd <= opts.energyTol);
      else if (v.type === 'car' || v.stationId || w.stationId) ok = false; // A19: keine Zwillinge ohne bekanntes Paar bei Autos und an Stationen
      else ok = d <= opts.twinM && bothBat && Math.round(v.batteryPct) === Math.round(w.batteryPct) && v.batteryPct < opts.fullBattery && !(fin(v.rangeKm) && fin(w.rangeKm) && Math.abs(v.rangeKm - w.rangeKm) > 0.1);
      if (ok) cands.push([d + (bd || 0), v, w]);
    }
  }
  cands.sort((x, y) => x[0] - y[0]);
  const gone = new Set(), took = new Map(); // took: stärkeres Fahrzeug → Quellen, aus denen es schon einen Zwilling übernommen hat
  for (const [, v, w] of cands) {
    if (gone.has(w)) continue;
    const t = took.get(v) || new Set(); if (t.has(w.sourceId)) continue;
    t.add(w.sourceId); took.set(v, t); gone.add(w); dropped.push({ v: w, of: v.sourceId, why: 'twin' });
  }
  return { vehicles: rest.filter(v => !gone.has(v)), dropped, known: [...known.values()], ...(held ? { hold: held.hold } : {}) };
}

const stationNameKey = (s) => String(s || '').toLowerCase().replace(/ß/g, 'ss').replace(/[äöü]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue' }[c])).replace(/[^a-z0-9]+/g, ' ').trim();
// Stationen desselben Anbieters aus mehreren Quellen: gleiche Kennung oder gleicher Name innerhalb 60 m → höchste Quellenpriorität / jüngster Stand gewinnt.
// Namenskandidaten je Anbieter|Name gebündelt (in Ausgabereihenfolge, erster Treffer zählt); ein übernommener Datensatz kann den Namen ändern → umhängen.
export function dedupeStations(stations) {
  const byId = new Map(); const out = []; let dup = 0;
  const byName = new Map(); // `${operator}|${nameKey}` → Stationen aus out, in Ausgabereihenfolge
  const pos = new Map(); // Station → Index in out (für die Reihenfolge beim Umhängen)
  const nameOf = new Map(); // Station → aktueller nameKey
  const link = (s) => { const nk = stationNameKey(s.name); nameOf.set(s, nk); if (!nk) return; const k = `${s.operator}|${nk}`; let l = byName.get(k); if (!l) byName.set(k, l = []); const i = pos.get(s); let j = l.length; while (j > 0 && pos.get(l[j - 1]) > i) j--; l.splice(j, 0, s); };
  const unlink = (s) => { const nk = nameOf.get(s); if (!nk) return; const l = byName.get(`${s.operator}|${nk}`); const i = l ? l.indexOf(s) : -1; if (i >= 0) l.splice(i, 1); };
  const take = (o, s) => { unlink(o); Object.assign(o, s); link(o); }; // Anbieter bleibt gleich (Teil beider Schlüssel), Name/Position können wechseln
  for (const s of stations) {
    const key = `${s.operator}|${s.id}`;
    if (byId.has(key)) { dup++; const prev = byId.get(key); if ((s.priority ?? 2) < (prev.priority ?? 2) || ((s.reportedAt ?? 0) > (prev.reportedAt ?? 0) && (s.priority ?? 2) === (prev.priority ?? 2))) take(prev, s); continue; }
    const nameKey = stationNameKey(s.name);
    let twin = null;
    if (nameKey && validLatLon(s.lat, s.lon)) for (const o of byName.get(`${s.operator}|${nameKey}`) || []) if (validLatLon(o.lat, o.lon) && haversineM(o.lat, o.lon, s.lat, s.lon) <= 60) { twin = o; break; }
    if (twin) { dup++; if ((s.priority ?? 2) < (twin.priority ?? 2)) take(twin, s); continue; }
    byId.set(key, s); pos.set(s, out.length); out.push(s); link(s);
  }
  return { stations: out, duplicates: dup };
}

/**
 * Quellen-Kopien über Stationskoordinaten, unabhängig vom Anbieternamen (CityBikes „DB Connect“ = RegioRad Stuttgart aus MobiData BW):
 * Eine Zählquelle ohne Fahrzeugliste (countOnly) ist Kopie, wenn ≥ minShare ihrer Stationen ≤ radiusM neben Stationen stärkerer Quellen
 * liegen und davon ≥ minNamed (70 %) gleich heißen (Mobilitätsstationen mehrerer Anbieter liegen auch nebeneinander; in NRW heißen bis zu 50 % gleich).
 * Stärke: Quelle mit Fahrzeugliste > bessere Priorität > nicht CityBikes > mehr Stationen > Kennung. Schwächste zuerst; eine erkannte
 * Kopie scheidet für spätere Vergleiche aus. stations: [{ sourceId, lat, lon, name }], sources: [{ id, priority, directories, countOnly }]
 * Rückgabe Map(sourceId → { of, share, named, n }).
 */
export function findSourceCopies(stations, sources, { minStations = 5, radiusM = 30, minShare = 0.8, minNamed = 0.7 } = {}) {
  const bySrc = new Map(); for (const s of stations) { if (!validLatLon(s.lat, s.lon)) continue; if (!bySrc.has(s.sourceId)) bySrc.set(s.sourceId, []); bySrc.get(s.sourceId).push(s); }
  const info = new Map(sources.map(r => [r.id, r]));
  const rank = (id) => { const r = info.get(id) || {}; return [r.countOnly ? 1 : 0, r.priority ?? 2, r.directories?.includes('citybikes') ? 1 : 0, -(bySrc.get(id)?.length || 0)]; };
  const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a < b ? -1 : a > b ? 1 : 0; }; // < 0: a stärker
  const CL = 0.0005, CO = 0.0008; const gk = (la, lo) => `${Math.floor(la / CL)}:${Math.floor(lo / CO)}`;
  const grid = new Map(); for (const [id, list] of bySrc) for (const s of list) { const k = gk(s.lat, s.lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([id, s.lat, s.lon, stationNameKey(s.name)]); }
  const out = new Map();
  const cands = [...bySrc.keys()].filter(id => info.get(id)?.countOnly && bySrc.get(id).length >= minStations).sort((a, b) => cmp(b, a)); // schwächste zuerst
  for (const w of cands) {
    const list = bySrc.get(w); let matched = 0, named = 0; const per = new Map();
    for (const s of list) {
      const [gi, gj] = gk(s.lat, s.lon).split(':').map(Number); const nk = stationNameKey(s.name); let hit = null, same = false;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const [oid, la, lo, onk] of grid.get(`${gi + di}:${gj + dj}`) || []) {
        if (oid === w || out.has(oid) || cmp(oid, w) >= 0 || haversineM(s.lat, s.lon, la, lo) > radiusM) continue;
        if (!hit) hit = oid; if (nk && onk === nk && !same) { same = true; hit = oid; }
      }
      if (!hit) continue;
      matched++; if (same) named++; per.set(hit, (per.get(hit) || 0) + 1);
    }
    const share = matched / list.length;
    if (share < minShare || !matched || named / matched < minNamed) continue;
    const of = [...per].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
    out.set(w, { of, share: +share.toFixed(3), named: +(named / matched).toFixed(3), n: list.length });
  }
  return out;
}

// ---------- Aggregation ----------
export function emptyStats() {
  return { total: 0, available: 0, reserved: 0, disabled: 0, batteryKnown: 0, lowBattery: 0, rangeKnown: 0, lowRange: 0, stationVehicles: 0, geoStation: 0, posStale: 0,
    stations: 0, stationsInstalled: 0, stationsRenting: 0, stationsEmpty: 0, stationsFull: 0, stationPhysical: 0, stationBookable: 0, stationDocks: 0,
    stationsEmptyReported: 0, stationsEmptyNearby: 0, stationsEmptyOtherNearby: 0,
    stationsVirtual: 0, stationsEmptyVirtual: 0, stationsEmptyDock: 0, stationDocksBad: 0 }; // virtuelle Stationen (Abstellzonen) getrennt: leer ohne Fahrzeug ≠ leere Dockstation
}
export function addVehicle(st, v, { chargeThreshold = 20, rangeThreshold = 5 } = {}) {
  st.total++;
  if (!v.reserved && !v.disabled) st.available++;
  if (v.reserved) st.reserved++;
  if (v.disabled) st.disabled++;
  if (v.batteryPct != null) { st.batteryKnown++; if (v.batteryPct < chargeThreshold) st.lowBattery++; }
  if (v.rangeKm != null) { st.rangeKnown++; if (v.rangeKm < rangeLowKm(v.type, rangeThreshold)) st.lowRange++; }
  if (v.geoOrigin === 'station') st.geoStation++;
  if (v.positionAgeMs != null && v.positionAgeMs > DELAYED_MS) st.posStale++;
}
export const DOCKS_MAX = 500; // mehr freie Plätze an einer Station gibt es nicht (größte Dockstationen ≈ 100)
export function addStation(st, s, countVehicles) {
  st.stations++;
  if (s.installed !== false) st.stationsInstalled++;
  if (s.installed !== false && s.renting !== false) st.stationsRenting++;
  const phys = s.physicalAvailable ?? 0;
  st.stationPhysical += phys; st.stationBookable += s.bookable ?? 0;
  // Audit UXM-13: Platzhalter wie 999.999 freie Plätze (unbegrenzte Rückgabe) nicht summieren; über der Kapazität oder > DOCKS_MAX = unplausibel
  const dk = s.docksAvailable; if (dk > 0 && (dk > DOCKS_MAX || (s.capacity > 0 && dk > s.capacity + 2))) st.stationDocksBad = (st.stationDocksBad || 0) + 1; else st.stationDocks += dk ?? 0;
  if (s.isVirtual === true) st.stationsVirtual++;
  if (s.installed !== false && s.renting !== false && (s.bookable ?? 0) === 0) {
    // als leer gemeldet – aber stehen frei abgestellte Fahrzeuge desselben Anbieters direkt daneben, ist die Station faktisch versorgt
    st.stationsEmptyReported++;
    if (s.nearbyVehicles > 0) st.stationsEmptyNearby++; else { st.stationsEmpty++; if (s.nearbyOther > 0) st.stationsEmptyOtherNearby++; if (s.isVirtual === true) st.stationsEmptyVirtual++; else st.stationsEmptyDock++; }
  }
  if (s.installed !== false && s.returning !== false && s.docksAvailable === 0) st.stationsFull++;
  if (countVehicles) { st.stationVehicles += phys; st.total += phys; st.available += s.bookable ?? 0; if (s.disabled) st.disabled += s.disabled; }
}
export const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// Anbieter aus Namen/Kennungen ableiten (längster Alias gewinnt)
export function operatorFromName(text, aliases) {
  const hay = String(text || '').toLowerCase();
  const keys = Object.keys(aliases || {}).sort((a, b) => b.length - a.length);
  for (const k of keys) if (hay.includes(k)) return aliases[k];
  return null;
}

// Gemeinde × Anbieter × Fahrzeugart aggregieren (Fahrzeuge bereits dedupliziert, mit .ags/.operator/.type;
// Stationen mit .ags/.operator/.perType/.typeHint/.hasVehicleList)
export const STATION_NEAR_M = 50; // Umkreis, in dem frei abgestellte Fahrzeuge einer Station zugerechnet werden
/** Zählt je Station verfügbare Fahrzeuge desselben Anbieters im Umkreis (setzt station.nearbyVehicles). */
export function countNearbyVehicles(vehicles, stations, radiusM = STATION_NEAR_M) {
  // Raster ohne Anbieter: zählt eigene (nearbyVehicles) und fremde Fahrzeuge (nearbyOther, Marktsicht)
  const CL = 0.0005, CO = 0.0008; const grid = new Map();
  for (const v of vehicles) { if (v.disabled || v.reserved || !Number.isFinite(v.lat)) continue; const k = `${Math.floor(v.lat / CL)}|${Math.floor(v.lon / CO)}`; (grid.get(k) || grid.set(k, []).get(k)).push(v); }
  for (const s of stations) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const i = Math.floor(s.lat / CL), j = Math.floor(s.lon / CO); let own = 0, other = 0; const otherOps = new Set();
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const v of grid.get(`${i + di}|${j + dj}`) || []) {
      if (haversineM(s.lat, s.lon, v.lat, v.lon) > radiusM) continue;
      if (v.operator === s.operator) own++; else { other++; otherOps.add(v.operator); }
    }
    s.nearbyVehicles = own; s.nearbyOther = other; s.nearbyOtherOps = [...otherOps];
  }
  return stations;
}
export function aggregateGroups(vehicles, stations, { chargeThreshold = 20, rangeThreshold = 5 } = {}) {
  countNearbyVehicles(vehicles, stations);
  const groups = new Map();
  const g = (key) => { if (!groups.has(key)) groups.set(key, emptyStats()); return groups.get(key); };
  for (const v of vehicles) addVehicle(g(`${v.ags}|${v.operator}|${v.type}`), v, { chargeThreshold, rangeThreshold });
  for (const s of stations) {
    const types = s.perType ? Object.keys(s.perType) : [s.typeHint || 'unknown'];
    const countVehicles = !s.hasVehicleList;
    if (s.perType && countVehicles) {
      for (const [ty, n] of Object.entries(s.perType)) { const st = g(`${s.ags}|${s.operator}|${ty}`); st.total += n; st.available += s.renting !== false && s.installed !== false ? n : 0; st.stationVehicles += n; }
      const main = types.slice().sort((a, b) => s.perType[b] - s.perType[a])[0];
      addStation(g(`${s.ags}|${s.operator}|${main}`), s, false);
    } else addStation(g(`${s.ags}|${s.operator}|${types[0]}`), s, countVehicles);
  }
  return groups;
}
export function sumStats(list) {
  const out = emptyStats();
  for (const st of list) for (const f of Object.keys(out)) out[f] += st[f] || 0;
  return out;
}
