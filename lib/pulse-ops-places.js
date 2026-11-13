// @ts-check
// Mobility Pulse — Disposition – vermutete Deploy-Spots, Einsammel-Orte und Einsammelliste (aus pulse-ops.js geschnitten; pulse-ops.js bleibt die Fassade für alle Importe).
import { haversineM } from './pulse-core.js';
import { dayOf, GROUP_FIELDS } from './pulse-track.js';
import { boxed, geomContains, gridIndex, isAvailable } from './pulse-ops-model.js';
import { csvRows, opsCsv, stopReason } from './pulse-ops-tours.js';

// ---------- Vermutete Deploy-Spots und Einsammel-Orte (Gruppen-Ereignisse aus groups/<JJJJ-MM>.json bzw. groups.json) ----------
// Ereignis: ≥ GROUP_MIN Fahrzeuge eines Anbieters tauchen in einem Lauf ≤ GROUP_M beieinander auf (deploy) bzw. verschwinden zusammen (collect).
// Orte je Anbieter und Art: ein Ereignis fällt in den Ort, dessen Mittelpunkt ≤ mergeM (60 m) entfernt ist (sonst neuer Ort); zeitlich sortiert,
// der Mittelpunkt ist das Mittel der zugeordneten Ereignisse. Gleiches Ereignis aus mehreren Dateien (at, Art, Anbieter, Ort) zählt einmal.
export const GROUP_MERGE_M = 60;
export function groupPlaces(docs, { ags = undefined, mergeM = GROUP_MERGE_M } = {}) {
  const evs = [], seen = new Set();
  for (const doc of (Array.isArray(docs) ? docs : [docs]).filter(Boolean)) {
    const ix = Object.fromEntries((doc.fields || GROUP_FIELDS).map((f, i) => [f, i]));
    for (const e of doc.events || []) {
      const at = e[ix.at], kind = e[ix.art], op = e[ix.anbieter], lat = e[ix.lat], lon = e[ix.lon];
      if ((ags && e[ix.gemeinde] !== ags) || (kind !== 'deploy' && kind !== 'collect') || !op || !Number.isFinite(at) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const k = `${at}|${kind}|${op}|${lat}|${lon}`; if (seen.has(k)) continue; seen.add(k);
      evs.push({ at, kind, op, lat, lon, n: +e[ix.anzahl] || 0, types: e[ix.arten] || {} });
    }
  }
  evs.sort((a, b) => a.at - b.at);
  const out = { deploy: [], collect: [], ops: [], events: { deploy: 0, collect: 0 }, first: evs[0]?.at ?? null, last: evs[evs.length - 1]?.at ?? null };
  // Rasterindex der Ortsmittelpunkte (≈ 110 m), damit viele Monate nicht jeden Ort gegen jedes Ereignis prüfen
  const GA = 0.001, GO = 0.0015, grid = new Map(), gk = (p) => `${p.op}|${p.kind}|${Math.floor(p.lat / GA)}:${Math.floor(p.lon / GO)}`;
  const put = (s) => { s.k = gk(s); (grid.get(s.k) || grid.set(s.k, []).get(s.k)).push(s); }, drop = (s) => { const l = grid.get(s.k); l.splice(l.indexOf(s), 1); };
  const ops = new Set();
  for (const e of evs) {
    ops.add(e.op); out.events[e.kind]++;
    const gi = Math.floor(e.lat / GA), gj = Math.floor(e.lon / GO); let best = null, bd = Infinity;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const s of grid.get(`${e.op}|${e.kind}|${gi + di}:${gj + dj}`) || []) { const d = haversineM(s.lat, s.lon, e.lat, e.lon); if (d < bd) { bd = d; best = s; } }
    if (!best || bd > mergeM) { best = { op: e.op, kind: e.kind, lat: e.lat, lon: e.lon, count: 0, vehicles: 0, first: e.at, last: e.at, types: {} }; out[e.kind].push(best); put(best); }
    drop(best);
    best.lat = (best.lat * best.count + e.lat) / (best.count + 1); best.lon = (best.lon * best.count + e.lon) / (best.count + 1);
    best.count++; best.vehicles += e.n; best.last = Math.max(best.last, e.at); best.first = Math.min(best.first, e.at);
    for (const [t, n] of Object.entries(e.types)) best.types[t] = (best.types[t] || 0) + (+n || 0);
    put(best);
  }
  for (const k of ['deploy', 'collect']) out[k].sort((a, b) => b.count - a.count || b.last - a.last).forEach((s, i) => { delete s.k; s.lat = +s.lat.toFixed(5); s.lon = +s.lon.toFixed(5); s.avg = s.count ? s.vehicles / s.count : 0; s.rank = i + 1; });
  out.ops = [...ops].sort((a, b) => a.localeCompare(b, 'de'));
  return out;
}
const fold = (t) => String(t ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase();
const BERLIN_DAY = (ms) => dayOf(ms, 'Europe/Berlin');
/**
 * Filter je Spalte: q = Text in der Lage (labelOf(place): Adresse, Koordinaten), op = Anbieter ('all' = alle), countMin/countMax = Ausbringungen,
 * avgMin/avgMax = Ø Fahrzeuge, from/to = Zeitraum „zuletzt“ als Tag JJJJ-MM-TT (Europe/Berlin, beide Grenzen einschließlich). Leere Werte filtern nicht.
 */
export function filterPlaces(list, f = {}, labelOf = (..._a) => '') {
  const num = (x) => x === '' || x == null || !Number.isFinite(+x) ? null : +x;
  const cMin = num(f.countMin), cMax = num(f.countMax), aMin = num(f.avgMin), aMax = num(f.avgMax), q = fold(f.q).trim();
  return (list || []).filter(p => {
    if (f.op && f.op !== 'all' && p.op !== f.op) return false;
    if (cMin != null && p.count < cMin) return false; if (cMax != null && p.count > cMax) return false;
    if (aMin != null && p.avg < aMin - 1e-9) return false; if (aMax != null && p.avg > aMax + 1e-9) return false;
    if (f.from || f.to) { const d = BERLIN_DAY(p.last); if (f.from && d < f.from) return false; if (f.to && d > f.to) return false; }
    if (q && !q.split(/\s+/).every(w => fold(`${labelOf(p)} ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} ${p.op}`).includes(w))) return false;
    return true;
  });
}
// Sortierung nach Spalte: lage (Text), op, count, last, avg, near (Abstand zum nächsten Plan-Spot); Gleichstand: Ausbringungen, dann zuletzt
export function sortPlaces(list, key = 'count', dir = 'desc', { labelOf = (..._a) => '', nearOf = (..._a) => null } = {}) {
  const val = { lage: (p) => fold(labelOf(p) || `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`), op: (p) => fold(p.op), count: (p) => p.count, last: (p) => p.last, avg: (p) => p.avg, near: (p) => nearOf(p)?.d ?? Infinity }[key] || ((p) => p.count);
  const s = dir === 'asc' ? 1 : -1;
  return list.slice().sort((a, b) => { const x = val(a), y = val(b); const c = typeof x === 'string' ? x.localeCompare(y, 'de') : x - y; return s * c || b.count - a.count || b.last - a.last; });
}
const STAMP = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const PLACES_FIELDS = ['art', 'anbieter', 'lage', 'lat', 'lon', 'anzahl', 'fahrzeuge_summe', 'fahrzeuge_mittel', 'erstmals', 'zuletzt', 'fahrzeugarten', 'naechster_spot', 'abstand_m'];
export function placesCsv(list, { labelOf = (..._a) => '', nearOf = (..._a) => null, lang = 'de' } = {}) {
  const rows = (list || []).map(p => { const n = nearOf(p);
    return [p.kind === 'deploy' ? (lang === 'en' ? 'Deployment' : 'Ausbringen') : (lang === 'en' ? 'Pickup' : 'Einsammeln'), p.op, labelOf(p) || '', p.lat.toFixed(5), p.lon.toFixed(5), p.count, p.vehicles, +p.avg.toFixed(2), STAMP.format(p.first), STAMP.format(p.last),
      Object.entries(p.types || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '), n ? n.rank : null, n ? Math.round(n.d) : null]; });
  return opsCsv([PLACES_FIELDS, ...rows], lang);
}
export function planGeoJson(spots, runs, depot) {
  const f = [];
  for (const s of spots) f.push({ type: 'Feature', properties: { kind: 'spot', rank: s.rank, target: s.target, score: s.score, stability: s.stabilityLabel, bootShare: s.bootShare ?? null, outPerHour: s.outPerHourOp ?? null, outSe: s.outSeOp ?? null }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
  for (const r of runs) {
    f.push({ type: 'Feature', properties: { kind: 'run', id: r.id, run: r.kind, km: r.km, minutes: r.totalMin, vehicles: r.vehicles }, geometry: { type: 'LineString', coordinates: [[depot.lon, depot.lat], ...r.stops.map(s => [s.lon, s.lat]), [depot.lon, depot.lat]] } });
    r.stops.forEach((s, i) => f.push({ type: 'Feature', properties: { kind: 'stop', run: r.id, seq: i + 1, type: s.type, count: s.count, priority: s.prio ?? null, priorityRank: s.rank ?? null, reason: stopReason(s), why: s.why ?? null }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }));
  }
  f.push({ type: 'Feature', properties: { kind: 'depot' }, geometry: { type: 'Point', coordinates: [depot.lon, depot.lat] } });
  return { type: 'FeatureCollection', features: f };
}
// ---------- Einsammelliste: Fahrzeuge im eigenen Abstellverbot oder ohne Station in einer Pflicht-Abstellzone (intern, kein Anbieter-Vergleich) ----------
// Zonenart wie zoneConstraints: 'mpz' = Pflicht-Abstellzone (GBFS station_parking, ohne Durchfahrtsverbot: Abstellen an Stationen erlaubt),
// 'ban' = Abstell- oder Fahrverbot (Fahrtende, ride_allowed aus GBFS 2.x oder Durchfahrt verboten), 'ok' = Fahren und Abstellen erlaubt
// (Betriebsgebiet, Tempozone, Ausnahmefläche wie ein Mobility Hub in einer Verbotszone). Die Feeds 2.x melden ride_end_allowed nicht
// (endAllowed null, Stand 02.11.2026 alle BW-Feeds), dort trägt ride_allowed die Regel.
// mpzStationM: Pflicht-Abstellzone gilt als ohne Station erst ab 50 m zur nächsten eigenen Station (25 m Stationsabstand + 25 m GPS-Umfeld,
// Entscheidung Felix 02.11.2026); stationSearchM: Suchradius für den Abstand zur nächsten Station in der Liste
export const COLLECT = { buffers: [15, 25, 50], stationM: 25, mpzStationM: 50, stationSearchM: 1000 };
export function zoneKind(rules = []) {
  if (rules.some(x => x.parking === true) && !rules.some(x => x.rideThrough === false)) return 'mpz';
  if (rules.some(x => x.endAllowed === false || x.rideAllowed === false || x.rideThrough === false)) return 'ban';
  return rules.some(x => x.rideAllowed === true || x.endAllowed === true) ? 'ok' : null;
}
// Fläche in m² (eben, je Polygon mit cos der Breite; Löcher abgezogen): nur zum Vergleich „kleinere Zone gilt“
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return Math.abs(a / 2); };
function geomAreaM2(g) {
  let s = 0;
  for (const p of g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) {
    if (!p?.[0]?.length) continue;
    s += (ringArea(p[0]) - p.slice(1).reduce((x, h) => x + ringArea(h), 0)) * 111320 * 111320 * Math.cos(p[0][0][1] * Math.PI / 180);
  }
  return s;
}
/**
 * Verfügbare Fahrzeuge (nicht gesperrt, nicht reserviert) von operator, die in EIGENEN Zonen falsch stehen, in zwei Arten (kind):
 * 'ban' = Abstell- oder Fahrverbotszone. Ein Punkt ist „im Verbot“, wenn er in einer Verbotszone liegt, in keiner Pflicht-Abstellzone und
 *   in keiner erlaubten Zone, die kleiner ist als die kleinste Verbotszone am Punkt (die genauere Zone gilt: Hub ja, Betriebsgebiet nein).
 *   Roh = im Verbot und keine eigene Station ≤ stationM.
 * 'mpz' = Pflicht-Abstellzone (station_parking: Abstellen nur an Stationen) ohne eigene Station ≤ mpzStationM; ebenso nicht in einer kleineren
 *   erlaubten Zone. Station ≤ stationM = richtig abgestellt, stationM < Abstand ≤ mpzStationM = „knapp neben Station“ (nur gezählt).
 * Robust je Puffer b: auch die 4 Punkte im Abstand b (N/O/S/W) liegen im Verbot bzw. in einer Pflicht-Abstellzone (Umfeld der Koordinate
 * geprüft: GPS-Fehler, Fahrzeug am Zonenrand). Gelistet nur, wenn robust bei ALLEN Puffern.
 * fleet: { vehicles, stations } (decodeFleet; vom Aufrufer auf Gemeinde/Fahrzeugart eingegrenzt, Stationen dürfen das ganze Land sein).
 * zonesDoc: zones/<Datei>.json oder eine Liste davon; Dateien eines anderen Anbieters zählen nicht. Gleiche Zone aus zwei Quellen
 * (MobiData BW und Direktfeed, gleiche Umrandung und Fläche) zählt einmal.
 * Rückgabe { operator, features, zones: { ban, mpz, ok }, buffers, stationM, mpzStationM, counts: { available, listed,
 *   ban: { inZone, mpz, allowed, station, raw, robust: { <b>: n }, listed }, mpz: { inZone, allowed, station, near, raw, robust, listed } },
 *   list: [{ kind, lat, lon, type, ags, zone: { id, name, noRide }, stationDistM (nächste eigene Station ≤ stationSearchM, sonst null), idleMin,
 *   idleCensored, battery, rangeKm, rangeFlat }] (Standzeit absteigend), zonesHit: [{ kind, id, name, noRide, geometry, n }] }
 */
export function parkingViolations(fleet, zonesDoc, { operator = null, buffers = COLLECT.buffers, stationM = COLLECT.stationM, mpzStationM = COLLECT.mpzStationM } = {}) {
  const docs = (Array.isArray(zonesDoc) ? zonesDoc : [zonesDoc]).filter(d => d && (operator == null || d.operator == null || d.operator === operator));
  const vehicles = (fleet?.vehicles || []).filter(v => (operator == null || v.operator === operator) && isAvailable(v) && Number.isFinite(v.lat) && Number.isFinite(v.lon));
  const near = gridIndex((fleet?.stations || []).filter(s => (operator == null || s.operator === operator) && Number.isFinite(s.lat) && Number.isFinite(s.lon)));
  const bmax = Math.max(0, ...buffers);
  // Begrenzung der Fahrzeuge + größter Puffer: Zonen außerhalb (z. B. Voi-Feed für ganz Deutschland) fallen vorab weg
  const vb = vehicles.length ? [Math.min(...vehicles.map(v => v.lon)), Math.min(...vehicles.map(v => v.lat)), Math.max(...vehicles.map(v => v.lon)), Math.max(...vehicles.map(v => v.lat))] : null;
  const padLat = (bmax + 10) / 111320, padLon = vb ? (bmax + 10) / (111320 * Math.cos(((vb[1] + vb[3]) / 2) * Math.PI / 180)) : 0;
  const zones = { ban: [], mpz: [], ok: [] }, seen = new Set(); let features = 0;
  docs.forEach((d, di) => (d.features || []).forEach((f, i) => {
    features++;
    const g = f?.geometry; if (!vb || !g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return;
    const rules = f.properties?.rules || [], kind = zoneKind(rules); if (!kind) return;
    const [{ b }] = boxed([g]); if (b[2] < vb[0] - padLon || b[0] > vb[2] + padLon || b[3] < vb[1] - padLat || b[1] > vb[3] + padLat) return;
    const area = geomAreaM2(g), dup = `${kind}|${b.map(x => x.toFixed(6)).join(',')}|${area.toFixed(1)}`; if (seen.has(dup)) return; seen.add(dup);
    zones[kind].push({ g, b, area, id: `${d.sourceId ?? di}#${i}`, name: f.properties?.name || null, noRide: rules.some(x => x.rideThrough === false) });
  }));
  const inside = (z, lat, lon) => lon >= z.b[0] && lon <= z.b[2] && lat >= z.b[1] && lat <= z.b[3] && geomContains(z.g, lat, lon);
  const smallest = (list, lat, lon) => { let m = null; for (const z of list) if ((!m || z.area < m.area) && inside(z, lat, lon)) m = z; return m; };
  const freed = (z, lat, lon) => zones.ok.some(o => o.area < z.area && inside(o, lat, lon)); // kleinere erlaubte Zone gilt
  const at = (lat, lon) => {
    const ban = smallest(zones.ban, lat, lon);
    if (!ban) return { why: 'none' };
    if (zones.mpz.some(z => inside(z, lat, lon))) return { why: 'mpz', ban };
    return freed(ban, lat, lon) ? { why: 'allowed', ban } : { why: 'ban', ban };
  };
  const mpzAt = (lat, lon) => { const m = smallest(zones.mpz, lat, lon); return !m ? { why: 'none' } : freed(m, lat, lon) ? { why: 'allowed', mpz: m } : { why: 'mpz', mpz: m }; };
  const robustAll = (v, test, rob) => {
    let all = true;
    for (const b of buffers) {
      const dLat = b / 111320, dLon = b / (111320 * Math.cos(v.lat * Math.PI / 180));
      if ([[dLat, 0], [-dLat, 0], [0, dLon], [0, -dLon]].every(([x, y]) => test(v.lat + x, v.lon + y))) rob[b]++; else all = false;
    }
    return all;
  };
  const nearest = (v) => { let d = null; for (const s of near(v, COLLECT.stationSearchM)) { const x = haversineM(v.lat, v.lon, s.lat, s.lon); if (d == null || x < d) d = x; } return d; };
  const rob0 = () => Object.fromEntries(buffers.map(b => [b, 0]));
  const counts = { available: vehicles.length, listed: 0, ban: { inZone: 0, mpz: 0, allowed: 0, station: 0, raw: 0, robust: rob0(), listed: 0 }, mpz: { inZone: 0, allowed: 0, station: 0, near: 0, raw: 0, robust: rob0(), listed: 0 } };
  const list = [], hit = new Map();
  const add = (kind, v, z, d) => {
    counts.listed++; counts[kind].listed++;
    let h = hit.get(z); if (!h) hit.set(z, (h = { kind, id: z.id, name: z.name, noRide: z.noRide, geometry: z.g, n: 0 })); h.n++;
    list.push({ kind, lat: v.lat, lon: v.lon, type: v.type, ags: v.ags ?? null, zone: { id: z.id, name: z.name, noRide: z.noRide }, stationDistM: d == null ? null : Math.round(d),
      idleMin: v.idleMin ?? null, idleCensored: v.idleCensored ?? null, battery: v.battery ?? null, rangeKm: v.rangeKm ?? null, rangeFlat: !!v.rangeFlat });
  };
  for (const v of vehicles) {
    let dist; const dSt = () => (dist === undefined ? (dist = nearest(v)) : dist), within = (m) => dSt() != null && dSt() <= m;
    const a = at(v.lat, v.lon);
    if (a.why !== 'none') {
      const c = counts.ban; c.inZone++;
      if (a.why !== 'ban') c[a.why]++;
      else if (within(stationM)) c.station++;
      else { c.raw++; if (robustAll(v, (la, lo) => at(la, lo).why === 'ban', c.robust)) add('ban', v, a.ban, dSt()); }
      if (a.why === 'ban') continue; // im Verbot heißt: in keiner Pflicht-Abstellzone
    }
    const m = mpzAt(v.lat, v.lon); if (m.why === 'none') continue;
    const c = counts.mpz; c.inZone++;
    if (m.why === 'allowed') c.allowed++;
    else if (within(stationM)) c.station++;
    else if (within(mpzStationM)) c.near++;
    else { c.raw++; if (robustAll(v, (la, lo) => mpzAt(la, lo).why === 'mpz', c.robust)) add('mpz', v, m.mpz, dSt()); }
  }
  list.sort((a, b) => (b.idleMin ?? -1) - (a.idleMin ?? -1) || a.lat - b.lat || a.lon - b.lon);
  return { operator, features, zones: { ban: zones.ban.length, mpz: zones.mpz.length, ok: zones.ok.length }, buffers: [...buffers], stationM, mpzStationM, counts, list, zonesHit: [...hit.values()] };
}
// Einsammelliste als CSV (Formel-Schutz über csvCell): Deutsch mit Semikolon, Englisch mit Komma und englischen Spaltennamen
// standzeit_ab_min = Untergrenze der Standzeit-Klasse (veröffentlicht nur als Klasse, IDLE_CLASS)
// art = Art des Befunds (Abstellverbot | Pflicht-Abstellzone ohne Station), zonenart = Regel der Zone, station_abstand_m = nächste eigene Station
export const COLLECT_CSV_FIELDS = ['rang', 'anbieter', 'art', 'lat', 'lon', 'zone_id', 'zone_name', 'zonenart', 'station_abstand_m', 'standzeit_ab_min', 'standzeit_mindestens', 'akku_prozent', 'reichweite_km', 'fahrzeugart'];
const COLLECT_CSV_EN = { rang: 'rank', anbieter: 'operator', art: 'kind', zonenart: 'zone_kind', station_abstand_m: 'station_distance_m', standzeit_ab_min: 'idle_from_min', standzeit_mindestens: 'idle_at_least', akku_prozent: 'battery_pct', reichweite_km: 'range_km', fahrzeugart: 'vehicle_type' };
export function violationsCsv(res, { lang = 'de' } = {}) {
  const en = lang === 'en', mpz = (v) => v.kind === 'mpz';
  const rows = (res?.list || []).map((v, i) => [i + 1, res.operator, mpz(v) ? (en ? 'mandatory parking zone without station' : 'Pflicht-Abstellzone ohne Station') : (en ? 'no-parking zone' : 'Abstellverbot'), v.lat.toFixed(6), v.lon.toFixed(6), v.zone.id, v.zone.name ?? '',
    mpz(v) ? (en ? 'mandatory parking zone' : 'Pflicht-Abstellzone') : v.zone.noRide ? (en ? 'no-riding zone' : 'Fahrverbot') : (en ? 'no-parking zone' : 'Abstellverbot'), v.stationDistM ?? null,
    v.idleMin, v.idleCensored == null ? '' : v.idleCensored ? 1 : 0, v.battery, v.rangeKm, v.type]);
  return en ? csvRows([COLLECT_CSV_FIELDS.map(h => COLLECT_CSV_EN[h] ?? h), ...rows], ',') : csvRows([COLLECT_CSV_FIELDS, ...rows]);
}
