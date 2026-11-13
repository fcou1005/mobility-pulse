// Mobility Pulse — Disposition: Nachfragemodell, Deploy-Spots, Rebalancing-, Swap- und Werkstatt-Touren.
// Reine Funktionen für Browser und Node. Entfernungen in Metern, Zeiten in Minuten.
import { haversineM, RANGE_LIMIT } from './pulse-core.js?v=mwf6frp1';
import { BANDS, bandOf, CELL_LAT, CELL_LON, cellOf, cellCenter, dayOf, GROUP_MIN, GROUP_M, GROUP_FIELDS, FLOW_FIELDS } from './pulse-track.js?v=mwf6frp1';

export { BANDS, bandOf, GROUP_MIN, GROUP_M, GROUP_FIELDS, RANGE_LIMIT };

// ---------- AHP ----------
// Gewichte = Haupteigenvektor der Paarvergleichsmatrix (Potenzmethode), Konsistenzquote CR = CI / RI (Saaty), CI = (λmax − n) / (n − 1)
const RI = { 1: 0, 2: 0, 3: 0.58, 4: 0.90, 5: 1.12, 6: 1.24, 7: 1.32, 8: 1.41, 9: 1.45, 10: 1.49 };
export function ahpWeights(A) {
  const n = A.length;
  if (!RI.hasOwnProperty(n) || A.some(r => r.length !== n)) throw new Error('AHP: quadratische Matrix 1–10 erwartet');
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (!(A[i][j] > 0) || !Number.isFinite(A[i][j])) throw new Error('AHP: Werte müssen positiv sein');
    if (Math.abs(A[i][j] * A[j][i] - 1) > 1e-6) throw new Error(`AHP: nicht reziprok (${i + 1},${j + 1})`);
  }
  const mul = (w) => A.map(r => r.reduce((s, x, j) => s + x * w[j], 0));
  let w = new Array(n).fill(1 / n);
  for (let it = 0; it < 1000; it++) { const v = mul(w), t = v.reduce((a, b) => a + b, 0), nw = v.map(x => x / t); const d = Math.max(...nw.map((x, i) => Math.abs(x - w[i]))); w = nw; if (d < 1e-13) break; }
  const Aw = mul(w), lambdaMax = Aw.reduce((s, x, i) => s + x / w[i], 0) / n;
  const ci = n > 2 ? Math.max(0, (lambdaMax - n) / (n - 1)) : 0;
  return { weights: w, lambdaMax, ci, cr: RI[n] > 0 ? ci / RI[n] : 0 };
}
// Kriterien (Nutzerwunsch 01.11.2026: Nachfrage mit Zahlen): Netto-Abfluss (Fahrtbeginne − Fahrtenden je h) ersetzt die abgeleitete
// „Unterversorgung“. Paarvergleich Saaty: Netto-Abfluss 2× Nachfrage (gleich bis mäßig wichtiger: der Abfluss ist der direkte Grund
// nachzufüllen, die Nachfrage sichert, dass der Spot genutzt wird), 5× ÖPNV, 5× Abstellfläche; Nachfrage 3× ÖPNV, 3× Abstellfläche;
// ÖPNV = Abstellfläche. Ergebnis 0,518 / 0,284 / 0,099 / 0,099, λmax = 4,004, CR = 0,0015 (< 0,10).
const AHP_CRITERIA = ['outflow', 'demand', 'transit', 'parking'];
const AHP_MATRIX = [[1, 2, 5, 5], [1 / 2, 1, 3, 3], [1 / 5, 1 / 3, 1, 1], [1 / 5, 1 / 3, 1, 1]];
const AHP0 = ahpWeights(AHP_MATRIX);
export const AHP = {
  criteria: AHP_CRITERIA,
  labels: { outflow: 'Netto-Abfluss', demand: 'Nachfrage', transit: 'ÖPNV-Nähe', parking: 'Abstellfläche' },
  matrix: AHP_MATRIX,
  weights: Object.fromEntries(AHP_CRITERIA.map((c, i) => [c, +AHP0.weights[i].toFixed(4)])),
  lambdaMax: +AHP0.lambdaMax.toFixed(4), ci: +AHP0.ci.toFixed(4), cr: +AHP0.cr.toFixed(4),
};
export const DEFAULTS = {
  // baseH: Grundbestand je Spot = Fahrtbeginne einer Stunde (Puffer, weil Starts und Enden nicht gleichzeitig kommen);
  // prelimH: darunter gelten Netto-Abfluss und Stabilität als vorläufig
  baseH: 1, prelimH: 24,
  spotRadiusM: 150, minSpacingM: 220, topN: 25, minPerSpot: 2, maxPerSpot: 15, horizonH: 3,
  vanCapacity: 20, swapCapacity: 50, workshopCapacity: 12, maxRuns: 6, maxPickupM: 4000,
  detour: 1.35, speedKmh: 18, pickupMin: 1.5, dropMin: 1.0, swapMin: 2.5, workshopMin: 3,
  swapThreshold: 20, swapRangeKm: 5, minBatteryForMove: 30, idleSurplusMin: 24 * 60,
  maxRunMin: 240, // Einsatz je Tour höchstens 4 h (Fahrt + vor Ort); was nicht passt, bildet weitere Touren oder bleibt „nicht eingeplant“
  // detour: Rückfall ohne Straßenmatrix = Luftlinie × 1,35 (Umwegfaktor Stadtverkehr). prioLambda: Gewicht der Priorität in der Reihenfolge (PRIO_LEVELS)
  prioLambda: 1,
};
// Voreinstellungen des Formulars je Fahrzeugart (beim Wechsel der Art gesetzt, seit 08.11.2026): E-Roller passen zu acht in einen Transporter,
// Reichweite niedrig unter 10 km; Autos setzt ein Fahrer einzeln um (Transporter = 1 Fahrzeug), „Tausch“ heißt bei ihnen Tanken bzw. Laden
// (Tour = Fahrer mit Tankkarte, 8 Fahrzeuge), Energie niedrig unter 25 % und 50 km. Übrige Arten: DEFAULTS.
export const TYPE_PRESETS = Object.freeze({
  default: { van: DEFAULTS.vanCapacity, swapCapacity: DEFAULTS.swapCapacity, swapThreshold: DEFAULTS.swapThreshold, swapRangeKm: DEFAULTS.swapRangeKm },
  moped: { van: 8, swapCapacity: 40, swapThreshold: 20, swapRangeKm: 10 },
  car: { van: 1, swapCapacity: 8, swapThreshold: 25, swapRangeKm: 50 },
});
export const presetOf = (type) => TYPE_PRESETS[type] || TYPE_PRESETS.default;
// Veröffentlichte Standzeit (ops/<Land>.json, idle-long.json) nur als Klasse: eine minutengenaue Standzeit zeigt, wann an einer Adresse die
// letzte Fahrt endete. Wert = Untergrenze der Klasse in Minuten: 0 = unter 6 h, 360 = 6–24 h, ab 24 h ganze Tage (1440 = 1–2 Tage, 2880 = 2–3 Tage …).
// Die Schwellen der Disposition (6 h Bonus, 24 h Überschuss) liegen auf Klassengrenzen und wirken unverändert.
export const IDLE_CLASS = { minH: 6, dayH: 24 };
export function idleClassMin(min) {
  if (min == null || !Number.isFinite(+min)) return null;
  const m = Math.max(0, +min), lo = IDLE_CLASS.minH * 60, day = IDLE_CLASS.dayH * 60;
  return m < lo ? 0 : m < day ? lo : Math.floor(m / day) * day;
}
/** Klasse als Text: „unter 6 h“, „6–24 h“, „1–2 Tage“; atLeast (Mindestwert, seit Beginn der Verfolgung unbewegt): „≥ 6 h“, „≥ 2 Tage“ */
export function idleClassText(min, { en = false, atLeast = false } = {}) {
  const c = idleClassMin(min); if (c == null) return '–';
  const lo = IDLE_CLASS.minH * 60, day = IDLE_CLASS.dayH * 60, d = c / day;
  if (c === 0) return en ? `under ${IDLE_CLASS.minH} h` : `unter ${IDLE_CLASS.minH} h`;
  if (c < day) return atLeast ? `≥ ${IDLE_CLASS.minH} h` : `${c / 60}–${IDLE_CLASS.dayH} h`;
  if (atLeast) return en ? `≥ ${d} ${d === 1 ? 'day' : 'days'}` : `≥ ${d} ${d === 1 ? 'Tag' : 'Tage'}`;
  return en ? `${d}–${d + 1} days` : `${d}–${d + 1} Tage`;
}
/** Veröffentlichte Reichweite: ganze km (feine Werte helfen, ein Fahrzeug am neuen Ort wiederzuerkennen); Quellen mit eigener Reichweiten-Skala
 *  (rangeLimitKm, Schwelle aus dem 95. Perzentil) behalten 0,1 km, sonst stimmte ihre Akkutausch-Schwelle nicht mehr */
export const rangePublic = (v) => (v?.rangeKm == null || !Number.isFinite(+v.rangeKm) ? null : v.rangeLimitKm != null ? +(+v.rangeKm).toFixed(1) : Math.round(+v.rangeKm));
// Regler „Priorität ↔ Strecke“: Stufe → λ (0 = nur Kilometer). Standard Stufe 2 = λ 1: ein Meter, den die dringenden Stopps im Mittel
// früher erreicht werden, ist einen Meter Umweg wert. Stufe 4 (λ 4) kommt der reinen Prioritätsfolge nahe, ohne Zickzack.
export const PRIO_LEVELS = [0, 0.5, 1, 2, 4];
export const PRIO_LEVEL_DEFAULT = 2;

const sum = (a) => a.reduce((x, y) => x + y, 0);
const quantile = (arr, q) => { const v = arr.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const i = Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1)))); return v[i]; };
export const dist = (a, b) => haversineM(a.lat, a.lon, b.lat, b.lon);

// ---------- Geometrie ----------
function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function geomContains(geom, lat, lon) {
  if (!geom) return false;
  const poly = (c) => ringContains(c[0], lon, lat) && !c.slice(1).some(h => ringContains(h, lon, lat));
  if (geom.type === 'Polygon') return poly(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(poly);
  return false;
}
// Geometrien mit Begrenzungsrechteck: Punkt-in-Polygon nur, wenn der Punkt im Rechteck liegt (viele Zonen × viele Zellen)
function boxed(geoms) {
  return (geoms || []).map(g => { const b = [Infinity, Infinity, -Infinity, -Infinity]; const walk = (c) => { if (typeof c[0] === 'number') { if (c[0] < b[0]) b[0] = c[0]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[1] > b[3]) b[3] = c[1]; } else c.forEach(walk); }; walk(g.coordinates || []); return { g, b }; });
}
const boxedContains = (list, lat, lon) => list.some(({ g, b }) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && geomContains(g, lat, lon));
// Rasterindex für Punktmengen (≈ 330 m Zellen): Nachbarn in maxM, ohne jeden Punkt zu prüfen
const GRID_LAT = 0.003, GRID_LON = 0.005;
function gridIndex(points) {
  const g = new Map();
  for (const p of points || []) { const k = `${Math.floor(p.lat / GRID_LAT)}:${Math.floor(p.lon / GRID_LON)}`; const l = g.get(k); if (l) l.push(p); else g.set(k, [p]); }
  return (p, maxM) => {
    const r = Math.ceil(maxM / 250), i0 = Math.floor(p.lat / GRID_LAT), j0 = Math.floor(p.lon / GRID_LON), out = [];
    for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) for (const q of g.get(`${i}:${j}`) || []) if (haversineM(p.lat, p.lon, q.lat, q.lon) <= maxM) out.push(q);
    return out;
  };
}

// ---------- Kontextdaten ----------
// GBFS-Zonen (zones/*.json): Abstellen verboten, wenn Fahrtende, Fahren oder Durchfahrt verboten ist
export function zoneConstraints(fc) {
  // GBFS: station_parking = Fahrt darf nur an einer Station des Anbieters enden (Pflicht-Abstellzone, MPZ).
  // Sonst gilt Abstellverbot, wenn Fahrtende, Fahrtbeginn/-ende (2.x ride_allowed) oder Durchfahrt verboten ist.
  const noPark = [], mandatory = [];
  for (const f of fc?.features || []) {
    const r = f.properties?.rules || []; if (!f.geometry) continue;
    if (r.some(x => x.parking === true) && !r.some(x => x.rideThrough === false)) mandatory.push(f.geometry);
    else if (r.some(x => x.endAllowed === false || x.rideAllowed === false || x.rideThrough === false)) noPark.push(f.geometry);
  }
  return { noPark, mandatory };
}
export const noParkGeometries = (fc) => zoneConstraints(fc).noPark;
const elPos = (e) => e.type === 'node' ? { lat: e.lat, lon: e.lon } : e.center ? { lat: e.center.lat, lon: e.center.lon } : null;
// OSM: E-Scooter-Stellflächen und Sharing-/Mobilitätspunkte getrennt von Radabstellanlagen
export function parkingFromOsm(elements) {
  const out = [];
  for (const e of elements || []) {
    const t = e.tags || {}, p = elPos(e); if (!p) continue;
    let cat = null;
    if (/^(kick-scooter_parking|small_vehicle_parking|small_electric_vehicle_parking)$/.test(t.amenity || '') || /^(designated|yes)$/.test(t.small_electric_vehicle || '') || /^(designated|yes)$/.test(t['kick-scooter'] || '')) cat = 'escooter';
    else if (/^(bicycle_rental|kick-scooter_rental|mobility_hub)$/.test(t.amenity || '') || t.public_transport === 'mobility_hub' || /mobilit(ä|ae)tspunkt|mobilstation|jelbi|hub/i.test(t.name || '')) cat = 'sharing';
    else if (t.amenity === 'bicycle_parking') cat = 'rad';
    if (cat) out.push({ ...p, cat, name: t.name || null, osm: `${e.type}/${e.id}` });
  }
  return out;
}
export function transitFromOsm(elements) {
  return (elements || []).filter(e => { const t = e.tags || {}; return t.highway === 'bus_stop' || t.public_transport === 'platform' || t.public_transport === 'stop_position' || /^(tram_stop|station|halt|subway_entrance)$/.test(t.railway || ''); }).map(elPos).filter(Boolean);
}
// Amtliche Geodaten (WFS, Open-Data-Portal) in lon/lat bringen: WFS 2.0 liefert EPSG:4326 je nach Server als lat/lon.
// In Deutschland (lat 47–55, lon 5–16) ist die Reihenfolge eindeutig erkennbar; projizierte Koordinaten (> 180) werden gezählt, nicht geraten.
export function lonLatFc(fc) {
  let swapped = 0, projected = 0, n = 0;
  const fix = (c) => { if (!Array.isArray(c)) return c; if (typeof c[0] !== 'number') return c.map(fix); n++;
    if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) { projected++; return c; }
    if (c[0] > 46 && c[0] < 56 && c[1] > 4 && c[1] < 17) { swapped++; return [c[1], c[0], ...c.slice(2)]; }
    return c; };
  const features = (fc?.features || []).map(f => f?.geometry ? { ...f, geometry: { ...f.geometry, coordinates: fix(f.geometry.coordinates) } } : f);
  return { type: 'FeatureCollection', features, swapped, projected, n };
}
const ringCenter = (r) => { const q = r.length > 3 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r; return [sum(q.map(p => p[0])) / q.length, sum(q.map(p => p[1])) / q.length]; };
const featName = (pr = {}) => pr.name || pr.bezeichnung || pr.standort || pr.titel || pr.typ || null;
// Amtliche Abstellflächen (Berlin WFS abstell_mikromob, München Abstellflächen): Punkte, Multipunkte oder Flächen (→ Mittelpunkt)
export function parkingFromWfs(fc, cat = 'official') {
  const out = [];
  for (const f of fc?.features || []) {
    const g = f.geometry; if (!g) continue;
    const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : g.type === 'Polygon' ? [ringCenter(g.coordinates[0])] : g.type === 'MultiPolygon' ? g.coordinates.map(p => ringCenter(p[0])) : [];
    for (const [lon, lat] of pts) if (Number.isFinite(lat) && Number.isFinite(lon)) out.push({ lat, lon, cat, name: featName(f.properties) });
  }
  return out;
}
// Amtliche Abstellverbotszonen (Berlin parkverbot_mikromob, München Geofences um Abstellflächen): Flächen als Ausschluss
export const noParkFromFc = (fc) => (fc?.features || []).map(f => f.geometry).filter(g => g && (g.type === 'Polygon' || g.type === 'MultiPolygon'));
// WFS-GetFeature als GeoJSON in WGS84; typeNames Standard „<letzter Pfadteil>:<letzter Pfadteil>“ (Berliner GDI-Muster)
export function wfsGetFeatureUrl(base, typeNames) {
  const u = new URL(base); const seg = u.pathname.split('/').filter(Boolean).pop();
  const tn = typeNames || u.searchParams.get('typeNames') || u.searchParams.get('typeName') || `${seg}:${seg}`;
  for (const k of [...u.searchParams.keys()]) if (/^(service|version|request|typenames?|outputformat|srsname)$/i.test(k)) u.searchParams.delete(k);
  for (const [k, v] of Object.entries({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: tn, outputFormat: 'application/json', srsName: 'EPSG:4326' })) u.searchParams.set(k, v);
  return u.toString();
}
// Open-Data-Portal (CKAN, z. B. opendata.muenchen.de): aus package_show die Ressource wählen – GeoJSON vor JSON vor WFS
export function pickCkanResource(pkg, typeNames = null) {
  const res = (pkg?.result || pkg)?.resources || [];
  const fmt = (r) => `${r.format || ''} ${r.mimetype || ''}`.toLowerCase(), url = (r) => String(r.url || '');
  const gj = res.find(r => /geo\+?json/.test(fmt(r)) || /\.geojson(\?|$)/i.test(url(r))) || res.find(r => /(^|\s)json\b/.test(fmt(r)) || /\.json(\?|$)/i.test(url(r)));
  if (gj) return { url: url(gj), type: 'geojson' };
  const wfs = res.find(r => /wfs/.test(fmt(r)) || /service=wfs|\/wfs\b/i.test(url(r)));
  if (wfs) { const tn = typeNames || new URL(url(wfs)).searchParams.get('typeName') || new URL(url(wfs)).searchParams.get('typeNames'); if (tn) return { url: wfsGetFeatureUrl(url(wfs), tn), type: 'wfs' }; }
  return null;
}

// ---------- Flotte ----------
// ops/<Land>.json → Fahrzeuge als Objekte
export function decodeFleet(doc) {
  // rangeDerived = Feld 10 „reichweiteAbgeleitet“ (Reichweite aus dem Ladestand gerechnet, M-16; ältere Dateien ohne Feld → false)
  // rangeLimitKm = Feld 11 „reichweiteSchwelleKm“ (Reichweiten-Schwelle der Quelle, pulse-core rangeLimitCheck; null/fehlt = Standard)
  // rangeFlat = Feld 12 „reichweiteKonstant“ (Reichweite der Quelle konstant, pulse-core rangeFlatCheck: für Energie/Akkutausch unbekannt; fehlt = nein)
  // idleCensored = Feld 13 „standzeitMindestens“ (seit Beginn der Verfolgung unbewegt: idleMin ist ein Mindestwert, Z6; fehlt = nein)
  // Felder am Zeilenende ohne Wert schreibt der Sammler nicht (fehlend = null)
  const vehicles = (doc?.vehicles || []).map(([lat, lon, op, ty, flags, bat, range, idleMin, m, rd, rl, rf, ic]) => ({
    lat, lon, operator: doc.ops[op], type: doc.types[ty] ?? 'unknown', reserved: !!(flags & 1), disabled: !!(flags & 2), battery: bat, rangeKm: range, idleMin: idleMin ?? null, ags: doc.munis[m], rangeDerived: rd === 1,
    rangeLimitKm: Number.isFinite(rl) ? rl : null, rangeFlat: rf === 1, idleCensored: ic === 1,
  }));
  // physical = physischer Bestand an der Station (Fahrzeuge), virtual = Merkmal der Station (Feld 12 „virtuell“: 1/0; ältere Dateien ohne Feld → null)
  const stations = (doc?.stations || []).map(([lat, lon, op, name, bookable, docks, capacity, m, renting, returning, physical, virtual]) => ({
    lat, lon, operator: doc.ops[op], name, bookable, docks, capacity, ags: doc.munis[m], renting: !!renting, returning: !!returning, physical,
    virtual: virtual === 1 || virtual === true ? 1 : virtual === 0 || virtual === false ? 0 : null,
  }));
  return { at: doc?.at ?? null, trackStart: doc?.trackStart ?? null, vehicles, stations }; // trackStart: Beginn der Verfolgung (Standzeit höchstens seitdem)
}
export const isAvailable = (v) => !v.disabled && !v.reserved;
// S2.10: ein Anbieteranteil für Disposition, Spot-Abgleich und Prognose-Spots. Die Zellen zählen Fahrten aller Arten außer Autos (Carsharing
// hat kein Zellen-Nachfragemodell), daher Anteil = verfügbare Fahrzeuge des Anbieters ÷ verfügbare des Markts, beide ohne Autos; type schränkt
// nur den Anbieter ein (z. B. nur seine E-Scooter am ganzen Mikromobilitätsmarkt). null ohne verfügbare Fahrzeuge im Markt.
export function operatorShare(fleet, ags, operator, { type = 'all' } = {}) {
  const inMuni = (fleet?.vehicles || []).filter(v => v.ags === ags && v.type !== 'car' && isAvailable(v));
  if (!inMuni.length) return null;
  return inMuni.filter(v => v.operator === operator && (type === 'all' || v.type === type)).length / inMuni.length;
}

// ---------- Nachfrage ----------
// Unsicherheit des Netto-Abflusses (M-10): z = Faktor der vorsichtigen Untergrenze max(0, Abfluss − z · SE) in der MCDA; Poisson-Bootstrap der
// Start-/Endzählungen mit draws Ziehungen und festem Startwert seed (deterministisch); „stabil“ nur, wenn der Spot in ≥ minShare der Ziehungen
// unter den Top-N bleibt (zusätzlich zur ±20-%-Gewichts-Sensitivität). 200 Ziehungen: Standardfehler eines Anteils um 0,8 ≈ 0,03.
export const BOOT = { z: 2, draws: 200, seed: 20261102, minShare: 0.8 };
/**
 * Nachfragemodell je Zelle aus den Tagesdateien cells/<Tag>/<Land>.json.
 * band = 0…5 oder 'day'. Starts/Ziele sind Marktgrößen (alle Anbieter), Präsenz = Ø verfügbare Fahrzeuge je Lauf.
 * Lücken-Läufe zählen in den Zellendateien nicht. dayHours[Tag] = Messstunden des Bands an diesem Tag (für Ströme aus flows/<Tag>.json).
 *
 * Ausgleich (M-10): Jede Fahrt hat einen Beginn und ein Ende, über die Gemeinde müssten Σ Starts und Σ Enden gleich sein. Gezählt sind sie es nicht:
 * Ausbringungen und Rückläufe aus dem Lager (neue Kennungen) zählen als Enden ohne Beginn, Fahrten über die Gemeindegrenze und am Rand des
 * Messfensters als Beginn ohne Ende bzw. umgekehrt (31.10./01.11.2026: Σ Enden über Σ Starts in Stuttgart um 13 %, in Frankfurt um 17 %).
 * Ohne Ausgleich rückt jede Zelle Richtung Zufluss, und das Abschneiden negativer Werte in der MCDA verstärkt das. Daher je Gemeinde (Markt;
 * die Zellendateien tragen keine Anbieter, der Anbieter bekommt seinen Anteil): Enden × k mit k = Σ Starts ÷ Σ Enden. Die Summen enthalten die
 * unterdrückten Ereignisse (cells/…: below je Gemeinde, Zelle × Band unter 3 Ereignissen), die keiner Zelle zugeordnet werden. Danach ist der
 * Netto-Abfluss über die ganze Gemeinde (Zellen + below) 0. Die Starts bleiben (Nachfrage, besser gemessen); der Überschuss an Enden wird
 * proportional zu den gezählten Enden verteilt – Annahme: Nicht-Fahrt-Enden fallen wie Fahrt-Enden an (Randsummen-Ausgleich wie beim
 * Gravitationsmodell mit festen Randsummen). An eigenen Deploy-Orten eines Anbieters bleibt der Abfluss deshalb eher zu niedrig.
 *   outPerHour = (S − k·E) ÷ h, outSe = √(S + k²·E) ÷ h (Poisson, k fest; die Unsicherheit von k steckt im Bootstrap),
 *   outLow = max(0, outPerHour − z·outSe) (vorsichtige Untergrenze, Faktor der MCDA), outPerHourRaw = (S − E) ÷ h (ohne Ausgleich),
 *   endsPerHour = E ÷ h (gezählt), endsPerHourBal = k·E ÷ h. model.balance = { starts, ends, belowStarts, belowEnds, totalStarts, totalEnds, k }.
 * A15 (13.11.2026, cells/ 31.10.–12.11., 8 Großstädte, Vorhersage der Starts je Zelle am Folgetag): 7 Tage statt 3 senken die Poisson-Devianz
 * um 26 % (Tag) bzw. 29–33 % (je Band), Top-25-Treffer 63,6 → 67,7 %. Starts/h als Gamma-Poisson-Posterior (Empirical Bayes, Momentenmethode),
 * Exposition nur bei Präsenz (Zensierung) und Verteilung der unterdrückten Starts auf Zellen ohne Wert brachten nichts (Devianz gleich bis
 * höher, Top 25 ±0,5 Punkte) – die Rangfolge hängt an Zellen mit vielen Starts, wo die Schrumpfung nichts ändert. Daher: Rate wie bisher, 7 Tage.
 */
export function buildDemandModel(cellDocs, ags, band = 'day') {
  const bands = band === 'day' ? BANDS.map(b => b.id) : [band];
  let hours = 0, runs = 0, days = 0, belowS = 0, belowE = 0;
  const cells = new Map(), dayHours = {}, dayH = [], dayBS = [], dayBE = []; // S2.11: je Tag (Reihenfolge der Dateien) für den Bootstrap über ganze Tage
  for (const doc of cellDocs) {
    if (!doc) continue;
    const m = doc.munis?.[ags], bl = doc.below?.[ags]; if (!m && !Array.isArray(bl)) continue;
    const h = sum(bands.map(b => doc.bandMin?.[b] || 0)) / 60, r = sum(bands.map(b => doc.bandRuns?.[b] || 0));
    if (h <= 0 && r <= 0) continue;
    const di = days; hours += h; runs += r; days++; if (doc.day) dayHours[doc.day] = (dayHours[doc.day] || 0) + h;
    // below = [Starts × 6 Bänder, Enden × 6 Bänder, Starts ohne Band, Enden ohne Band] (belowFields); ohne Band zählt wie in den Zellen nicht
    let bS = 0, bE = 0; if (Array.isArray(bl)) for (const b of bands) { bS += +bl[b] || 0; bE += +bl[BANDS.length + b] || 0; }
    belowS += bS; belowE += bE; dayH.push(h); dayBS.push(bS); dayBE.push(bE);
    for (const [cell, c] of Object.entries(m || {})) {
      if (c.length < 22) continue;
      const e = cells.get(cell) || { cell, starts: 0, ends: 0, presence: 0, reloc: 0, startsDay: 0, dS: [], dE: [] };
      let s0 = 0, e0 = 0; for (const b of bands) { s0 += c[4 + b]; e.presence += c[10 + b]; e0 += c[16 + b]; }
      e.starts += s0; e.ends += e0; if (s0) e.dS[di] = (e.dS[di] || 0) + s0; if (e0) e.dE[di] = (e.dE[di] || 0) + e0;
      e.reloc += c[3]; e.startsDay += c[0]; // Umsetzungen haben kein Band: Vergleich für Lagerflächen mit den Starts des ganzen Tags
      cells.set(cell, e);
    }
  }
  let sumS = 0, sumE = 0; for (const e of cells.values()) { sumS += e.starts; sumE += e.ends; }
  const totS = sumS + belowS, totE = sumE + belowE, k = totS > 0 && totE > 0 ? totS / totE : 1;
  for (const e of cells.values()) {
    const [lat, lon] = cellCenter(e.cell);
    e.lat = lat; e.lon = lon;
    e.startsPerHour = hours > 0 ? e.starts / hours : null;
    e.endsPerHour = hours > 0 ? e.ends / hours : null;
    e.endsPerHourBal = hours > 0 ? (k * e.ends) / hours : null;
    e.supplyAvg = runs > 0 ? e.presence / runs : 0;
    e.outPerHourRaw = hours > 0 ? (e.starts - e.ends) / hours : null;
    e.outPerHour = hours > 0 ? (e.starts - k * e.ends) / hours : null;
    e.outSe = hours > 0 ? Math.sqrt(e.starts + k * k * e.ends) / hours : null;
    e.outLow = hours > 0 ? Math.max(0, e.outPerHour - BOOT.z * e.outSe) : null;
  }
  const balance = { starts: sumS, ends: sumE, belowStarts: belowS, belowEnds: belowE, totalStarts: totS, totalEnds: totE, k };
  return { ags, band, hours, runs, days, cells, dayHours, dayH, dayBelow: { starts: dayBS, ends: dayBE }, flow: null, balance };
}

/**
 * Bedarf einer Zelle bzw. eines Spots für einen Anbieter (Anteil share am verfügbaren Bestand der Gemeinde):
 * Bedarf = max(0, Netto-Abfluss/h) × Horizont + Grundbestand, Grundbestand = Fahrtbeginne/h × baseH (1 h).
 * Netto-Abfluss ausgeglichen (Enden × k, buildDemandModel) und als Schätzwert, nicht als Untergrenze: der Bedarf ist der erwartete Abfluss;
 * die vorsichtige Untergrenze wirkt nur in der Rangfolge (MCDA). Zellen ohne endsPerHourBal (ältere Modelle) mit den gezählten Enden.
 * target = Bedarf aufgerundet, mindestens minPerSpot, höchstens maxPerSpot (capped = rechnerisch mehr).
 */
export function needOf(c, share = 1, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const startsOp = (c?.startsPerHour ?? 0) * share, endsOp = (c?.endsPerHourBal ?? c?.endsPerHour ?? 0) * share, outOp = startsOp - endsOp;
  const base = startsOp * o.baseH, drain = Math.max(0, outOp) * o.horizonH, raw = base + drain, up = Math.ceil(raw - 1e-9);
  return { startsOp, endsOp, outOp, base, drain, raw, target: Math.max(o.minPerSpot, Math.min(o.maxPerSpot, up)), capped: up > o.maxPerSpot };
}

/**
 * Start-Ziel-Ströme (flows/<Tag>.json, nur stabile Kennungen, Zeilen ab 2 Fahrten) als Beleg für Abfluss und Zufluss je Zelle.
 * Gezählt werden Tage, an denen die Gemeinde in der Datei vorkommt (munis[ags]) und das Modell Messstunden hat; Zeilen ohne Band
 * (über Bänder zusammengefasst) zählen nur für den ganzen Tag. Schreibt cell.flow = { out, in } und model.flow = { days, hours, trips, below, noBand }.
 */
export function attachFlows(model, flowDocs) {
  const ev = new Map(); let days = 0, hours = 0, trips = 0, below = 0, noBand = 0;
  const E = (cell) => { let e = ev.get(cell); if (!e) ev.set(cell, e = { out: 0, in: 0 }); return e; };
  for (const doc of flowDocs || []) {
    const mu = doc?.munis?.[model.ags], h = model.dayHours?.[doc?.day]; if (!mu || !(h > 0)) continue;
    const ix = Object.fromEntries((doc.fields || FLOW_FIELDS).map((f, i) => [f, i]));
    days++; hours += h; below += (mu.below || 0) + (mu.cut || 0);
    for (const r of doc.flows || []) {
      if (r[ix.gemeinde] !== model.ags) continue;
      const n = +r[ix.anzahl] || 0, from = r[ix.von], to = r[ix.nach], b = r[ix.band];
      if (!n || from === to) continue;
      if (model.band !== 'day' && b !== model.band) { if (b == null) noBand += n; continue; }
      trips += n; E(from).out += n; E(to).in += n;
    }
  }
  for (const c of model.cells.values()) c.flow = ev.get(c.cell) || null;
  model.flow = days ? { days, hours, trips, below, noBand } : null;
  return model;
}

// ---------- Deploy-Spots (MCDA) ----------
// S2.10: Netto-Abfluss mit Shrinkage (empirischer Bayes) und fachlicher Skala statt Untergrenze ÷ 95. Perzentil. Vorher war outLow = max(0,
// Abfluss − 2·SE) in 773 von 778 Kandidaten 0, und unter den wenigen übrigen setzte das 95. Perzentil kleine Zellen auf Faktor 1 (Berlin:
// Lagerzelle mit 35 Starts in 160 Std. auf Rang 1). Jetzt: τ² = Streuung des wahren Abflusses zwischen den Zellen (Varianz der Schätzer minus
// mittlere SE², Momentenmethode), Abfluss je Zelle × τ² ÷ (τ² + SE²) (kleine, unsichere Zellen rücken zur 0), Faktor = Abfluss des Anbieters
// über den Horizont in Fahrzeugen (× share × horizonH), 1 Fahrzeug = 1. Nachfrage wie bisher ÷ 95. Perzentil. outLow bleibt als Angabe.
// Vermutete Lagerflächen (STORAGE): Zellen mit mindestens so vielen Umsetzungen wie halb so viele Starts (und ≥ 5) – dort bringt der Betreiber aus
// und holt ein, die „Starts“ sind Abtransporte; ausgeschlossen.
const lowOf = (c) => c.outLow ?? Math.max(0, c.outPerHour ?? 0);
export const STORAGE = { minReloc: 5, relocPerStart: 0.5 };
export const isStorageCell = (c) => (c?.reloc ?? 0) >= STORAGE.minReloc && c.reloc >= STORAGE.relocPerStart * (c.startsDay ?? c.starts ?? 0);
/** τ² (Momentenmethode) und geschrumpfter Abfluss je Zelle aus Schätzern out und Standardfehlern se */
export function shrinkOut(out, se) {
  const n = out.length; if (!n) return { tau2: 0, shr: [] };
  let m = 0; for (const x of out) m += x; m /= n;
  let v = 0, s2 = 0; for (let i = 0; i < n; i++) { v += (out[i] - m) ** 2; s2 += se[i] ** 2; }
  const tau2 = Math.max(0, v / Math.max(1, n - 1) - s2 / n);
  return { tau2, shr: out.map((x, i) => (tau2 > 0 ? x * tau2 / (tau2 + se[i] ** 2) : 0)) };
}
function standardize(model, o = DEFAULTS) {
  const list = [...model.cells.values()].filter(c => (c.startsPerHour ?? 0) > 0 && (c.presence > 0 || c.ends > 0));
  const p95 = quantile(list.map(c => c.startsPerHour), 0.95) || 1;
  const { tau2, shr } = shrinkOut(list.map(c => c.outPerHour ?? 0), list.map(c => c.outSe ?? 0));
  const scale = (o.share ?? 1) * (o.horizonH ?? DEFAULTS.horizonH);
  list.forEach((c, i) => { c.outShr = shr[i]; c.storage = isStorageCell(c); c.f = { outflow: Math.min(1, Math.max(0, shr[i]) * scale), demand: Math.min(1, c.startsPerHour / p95) }; });
  model.tau2 = tau2;
  return list;
}
// ---------- Poisson-Bootstrap (M-10) ----------
// Pseudozufall mit festem Startwert (mulberry32): gleiche Eingabe und gleicher Startwert → gleiche Ziehungen
export function rng32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(x) { if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = LANCZOS[0]; const t = x + 7.5; for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); }
/** Poisson(λ)-Ziehung: Inversion für λ < 10, sonst PTRS (Hörmann 1993, transformierte Ablehnung, wie NumPy); rnd() ∈ [0, 1) */
export function poisson(lam, rnd) {
  if (!(lam > 0)) return 0;
  if (lam < 10) { let k = 0, p = Math.exp(-lam), F = p; const u = rnd(); while (u > F && k < 1000) { k++; p *= lam / k; F += p; } return k; }
  const slam = Math.sqrt(lam), ll = Math.log(lam), b = 0.931 + 2.53 * slam, a = -0.059 + 0.02483 * b, inva = 1.1239 + 1.1328 / (b - 3.4), vr = 0.9277 - 3.6224 / (b - 2);
  for (;;) {
    const U = rnd() - 0.5, V = rnd(), us = 0.5 - Math.abs(U), k = Math.floor((2 * a / us + b) * U + lam + 0.43);
    if (us >= 0.07 && V <= vr) return k;
    if (k < 0 || (us < 0.013 && V > us)) continue;
    if (Math.log(V) + Math.log(inva) - Math.log(a / (us * us) + b) <= -lam + k * ll - lgamma(k + 1)) return k;
  }
}
/** Gamma(a, 1)-Ziehung (Marsaglia & Tsang 2000; a < 1 über a + 1); Normalziehung nach Box-Muller */
function gauss(rnd) { let u = 0; while (u <= 1e-12) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }
export function gamma(a, rnd) {
  if (a < 1) { let u = 0; while (u <= 1e-12) u = rnd(); return gamma(a + 1, rnd) * u ** (1 / a); }
  const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = gauss(rnd); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = rnd(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
/** Dirichlet(α·w)-Ziehung der Gewichte (Summe 1); α = DIRICHLET_A ≈ ±20 % Streuung je Gewicht um 0,4 */
export const DIRICHLET_A = 36;
export function dirichlet(w, rnd, alpha = DIRICHLET_A) { const g = w.map(x => (x > 0 ? gamma(alpha * x, rnd) : 0)); const t = g.reduce((a, b) => a + b, 0) || 1; return g.map(x => x / t); }
const q95sorted = (a, n) => { if (!n) return 0; const s = a.subarray(0, n).sort(); return s[Math.floor(0.95 * (n - 1))]; };
/**
 * Stabilität (S2.11): je Ziehung (1) Zählungen neu – ab 3 Messtagen Bootstrap über ganze Tage (Tage mit Zurücklegen; Starts, Enden, Messstunden
 * und unterdrückte Ereignisse eines Tags bleiben zusammen, so wirkt die Abhängigkeit innerhalb eines Tags), darunter Poisson je Zelle –, (2) Gewichte
 * aus Dirichlet(α·w) (DIRICHLET_A). Daraus wie im Modell: Ausgleich k*, Abfluss, Shrinkage, Faktoren, Score, Rang mit denselben Ausschlüssen und
 * demselben Mindestabstand. ÖPNV und Abstellfläche hängen nicht an den Zählungen. Rückgabe { share: Map Zelle → Anteil der Ziehungen in den
 * Top-N (nur cells), mode: 'days' | 'poisson' } oder null.
 */
function bootTop(model, cands, weights, o, cells) {
  const R = Math.max(0, Math.floor(o.bootDraws ?? BOOT.draws)), n = cands.length;
  if (!R || !cells.length || !n || !(model.hours > 0)) return null;
  const rnd = rng32(o.bootSeed ?? BOOT.seed);
  const active = Object.keys(weights).filter(k => weights[k] > 0), wsum = sum(active.map(k => weights[k])), w0 = active.map(k => weights[k] / wsum);
  const iO = active.indexOf('outflow'), iD = active.indexOf('demand');
  const fixedF = active.map(k => (k === 'outflow' || k === 'demand' ? null : Float64Array.from(cands, c => c.f[k] ?? 0)));
  const D = model.dayH?.length || 0, byDays = D >= 3 && cands.every(c => Array.isArray(c.dS));
  let cS = 0, cE = 0; for (const c of cands) { cS += c.starts; cE += c.ends; }
  const b = model.balance || {}, restS = Math.max(0, (b.totalStarts ?? cS) - cS), restE = Math.max(0, (b.totalEnds ?? cE) - cE);
  // Tag d: Summe aller Zellen außerhalb der Kandidaten + below (für k*)
  const restDS = new Float64Array(D), restDE = new Float64Array(D);
  if (byDays) {
    for (let d = 0; d < D; d++) { restDS[d] = model.dayBelow?.starts?.[d] || 0; restDE[d] = model.dayBelow?.ends?.[d] || 0; }
    const inC = new Set(cands.map(c => c.cell));
    for (const c of model.cells.values()) if (!inC.has(c.cell)) for (let d = 0; d < D; d++) { restDS[d] += c.dS?.[d] || 0; restDE[d] += c.dE?.[d] || 0; }
  }
  const scale = (o.share ?? 1) * (o.horizonH ?? DEFAULTS.horizonH);
  const S = new Float64Array(n), E = new Float64Array(n), dem = new Float64Array(n), out = new Array(n), se = new Array(n), sc = new Float64Array(n), tmp = new Float64Array(n), cnt = new Float64Array(D);
  const idx = Int32Array.from({ length: n }, (_, i) => i), hits = new Map(cells.map(c => [c, 0]));
  const topN = o.topN, minSp = o.minSpacingM, sel = [];
  for (let r = 0; r < R; r++) {
    let TS = 0, TE = 0, h = model.hours;
    if (byDays) {
      cnt.fill(0); for (let q = 0; q < D; q++) cnt[Math.floor(rnd() * D)]++;
      h = 0; for (let d = 0; d < D; d++) if (cnt[d]) { h += cnt[d] * model.dayH[d]; TS += cnt[d] * restDS[d]; TE += cnt[d] * restDE[d]; }
      for (let i = 0; i < n; i++) { let a = 0, e = 0; const c = cands[i]; for (let d = 0; d < D; d++) if (cnt[d]) { a += cnt[d] * (c.dS[d] || 0); e += cnt[d] * (c.dE[d] || 0); } S[i] = a; E[i] = e; TS += a; TE += e; }
    } else {
      TS = poisson(restS, rnd); TE = poisson(restE, rnd);
      for (let i = 0; i < n; i++) { S[i] = poisson(cands[i].starts, rnd); E[i] = poisson(cands[i].ends, rnd); TS += S[i]; TE += E[i]; }
    }
    if (!(h > 0)) continue;
    const k = TS > 0 && TE > 0 ? TS / TE : 1;
    let m = 0;
    for (let i = 0; i < n; i++) { out[i] = (S[i] - k * E[i]) / h; se[i] = Math.sqrt(S[i] + k * k * E[i]) / h; dem[i] = S[i] / h; if (dem[i] > 0) tmp[m++] = dem[i]; }
    const p95 = q95sorted(tmp, m) || 1, shr = shrinkOut(out, se).shr;
    const w = active.length > 1 ? dirichlet(w0, rnd) : w0;
    for (let i = 0; i < n; i++) {
      let v = 0; for (let j = 0; j < active.length; j++) v += w[j] * (j === iO ? Math.min(1, Math.max(0, shr[i]) * scale) : j === iD ? Math.min(1, dem[i] / p95) : fixedF[j][i]);
      sc[i] = v;
    }
    idx.sort((x, y) => sc[y] - sc[x] || dem[y] - dem[x]);
    sel.length = 0;
    for (let q = 0; q < n && sel.length < topN; q++) {
      const c = cands[idx[q]]; if (c.excluded) continue;
      if (sel.some(s => haversineM(s.loc.lat, s.loc.lon, c.loc.lat, c.loc.lon) < minSp)) continue;
      sel.push(c);
    }
    for (const c of sel) if (hits.has(c.cell)) hits.set(c.cell, hits.get(c.cell) + 1);
  }
  return { share: new Map([...hits].map(([c, x]) => [c, x / R])), mode: byDays ? 'days' : 'poisson' };
}
// Rangkorrelation (Spearman, mittlere Ränge bei Gleichstand): prüft, ob Netto-Abfluss und Nachfrage dasselbe messen (Doppelzählung)
export function spearman(a, b) {
  const n = Math.min(a.length, b.length); if (n < 3) return null;
  const rk = (x) => { const o = x.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Array(n); for (let i = 0; i < n;) { let j = i; while (j + 1 < n && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2; i = j + 1; } return r; };
  const ra = rk(a.slice(0, n)), rb = rk(b.slice(0, n)), ma = sum(ra) / n, mb = sum(rb) / n;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = ra[i] - ma, y = rb[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}
function nearestWithin(points, p, maxM) {
  let best = null, bd = Infinity;
  for (const q of points) { const d = haversineM(p.lat, p.lon, q.lat, q.lon); if (d < bd && d <= maxM) { bd = d; best = q; } }
  return best ? { item: best, d: bd } : null;
}
const PARK_RANK = { station: 0, escooter: 0, sharing: 1, official: 0, rad: 2 };

function rank(cands, weights, topN, minSpacingM) {
  const active = Object.keys(weights).filter(k => weights[k] > 0);
  const wsum = sum(active.map(k => weights[k]));
  for (const c of cands) c.score = sum(active.map(k => (weights[k] / wsum) * (c.f[k] ?? 0)));
  const sorted = [...cands].filter(c => !c.excluded).sort((a, b) => b.score - a.score || b.startsPerHour - a.startsPerHour);
  const out = [];
  for (const c of sorted) { if (out.length >= topN) break; if (out.some(o => haversineM(o.lat, o.lon, c.loc.lat, c.loc.lon) < minSpacingM)) continue; out.push({ ...c, lat: c.loc.lat, lon: c.loc.lon }); }
  return out;
}

/**
 * Deploy-Spots für einen Anbieter.
 * ctx: { transit: [{lat,lon}] | null, parking: [{lat,lon,cat,name}] | null, noPark: [geometry], mandatory: [geometry], officialNoPark: [geometry],
 *        stations: [{lat,lon,name}], share, horizonH, topN, minSpacingM, weights }
 * officialNoPark (Abstellverbot laut Stadt) ist wie noPark ein Ausschluss, gilt aber nicht für einen Spot auf einer ausgewiesenen
 * Abstellfläche (amtlich oder E-Scooter-Stellfläche): dort ist Abstellen erlaubt (München: Verbot im Umkreis, Fläche frei).
 * Stabilität: ±20 % je Gewicht (stability, stabilityWeights) und Poisson-Bootstrap der Zählungen (bootShare; ctx.bootDraws, ctx.bootSeed,
 * Standard BOOT); stabilityLabel „stabil“ nur bei allen Gewichtsvarianten und ≥ 80 % der Ziehungen, unter 80 % „unsicher“.
 */
export function scoreSpots(model, ctx = {}) {
  const o = { ...DEFAULTS, ...ctx };
  const share = o.share ?? 1;
  const cands = standardize(model, { ...o, share });
  const weights = { ...AHP.weights, ...(o.weights || {}) };
  if (!o.transit) weights.transit = 0;
  if (!o.parking && !o.mandatory?.length) weights.parking = 0;
  const parkNear = gridIndex(o.parking), transitNear = gridIndex(o.transit), noPark = boxed(o.noPark), mandatory = boxed(o.mandatory), offNo = boxed(o.officialNoPark);
  for (const c of cands) {
    // Standort: offizielle/ausgewiesene Fläche in der Zelle, sonst Zellmitte
    let loc = { lat: c.lat, lon: c.lon }, park = null;
    if (o.parking?.length) {
      const near = parkNear(c, 160).sort((a, b) => (PARK_RANK[a.cat] ?? 3) - (PARK_RANK[b.cat] ?? 3) || haversineM(c.lat, c.lon, a.lat, a.lon) - haversineM(c.lat, c.lon, b.lat, b.lon));
      const pick = near.find(p => p.cat !== 'rad') || near.find(p => haversineM(c.lat, c.lon, p.lat, p.lon) <= 80);
      if (pick) { loc = { lat: pick.lat, lon: pick.lon }; park = pick; }
    }
    c.excluded = null;
    // Pflicht-Abstellzone: Spot nur an einer Station des Anbieters (≤ 150 m), sonst ausgeschlossen
    if (mandatory.length && boxedContains(mandatory, c.lat, c.lon)) {
      const st = nearestWithin(o.stations || [], c, 150);
      if (st) { loc = { lat: st.item.lat, lon: st.item.lon }; park = { cat: 'station', name: st.item.name || null }; }
      else c.excluded = 'Pflicht-Abstellzone ohne Station in 150 m';
    }
    c.loc = loc; c.park = park;
    c.f.transit = o.transit ? Math.min(1, transitNear(loc, 200).length / 3) : 0;
    c.f.parking = o.parking || park?.cat === 'station' ? (park ? (PARK_RANK[park.cat] <= 1 ? 1 : 0.5) : 0) : 0;
    if (!c.excluded && boxedContains(noPark, loc.lat, loc.lon)) c.excluded = 'Abstellverbot laut Betreiber-Zonen';
    if (!c.excluded && offNo.length && !(park && (park.cat === 'official' || park.cat === 'escooter')) && boxedContains(offNo, loc.lat, loc.lon)) c.excluded = 'Abstellverbot laut Stadt';
    if (!c.excluded && c.storage) c.excluded = 'vermutete Lagerfläche'; // S2.10
  }
  const why = (r) => cands.filter(c => c.excluded === r).length;
  const top = rank(cands, weights, o.topN, o.minSpacingM);
  // Sensitivität: jedes aktive Gewicht ±20 %, neu normiert
  const active = Object.keys(weights).filter(k => weights[k] > 0);
  const variants = [];
  for (const k of active) for (const f of [0.8, 1.2]) variants.push({ ...weights, [k]: weights[k] * f });
  const hits = new Map(top.map(t => [t.cell, 0]));
  for (const w of variants) { const r = rank(cands, w, o.topN, o.minSpacingM); for (const t of r) if (hits.has(t.cell)) hits.set(t.cell, hits.get(t.cell) + 1); }
  // Zählunsicherheit: Poisson-Bootstrap (bootDraws, Standard BOOT.draws; 0 = aus, z. B. für die Vorauswahl im Browser)
  const bt = bootTop(model, cands, weights, o, top.map(t => t.cell)), boot = bt?.share ?? null;
  const r2 = (x) => x == null ? null : +x.toFixed(2);
  const rho = spearman(cands.map(c => c.startsPerHour), cands.map(c => c.outPerHour ?? 0));
  const bal = model.balance;
  const spots = top.map((t, i) => {
    const nd = needOf(t, share, o);
    const stab = variants.length ? hits.get(t.cell) / variants.length : 1, bs = boot ? boot.get(t.cell) : null;
    // Label (S2.11): aus den Ziehungen (Tage bzw. Poisson × Dirichlet-Gewichte) – stabil ab BOOT.minShare (80 %), mittel ab 50 %, sonst unsicher;
    // ohne Ziehungen (Vorauswahl im Browser) aus der ±20-%-Gewichts-Sensitivität (stabil = alle Varianten, mittel ≥ 75 %)
    const wl = bs != null ? (bs >= BOOT.minShare ? 'stabil' : bs >= 0.5 ? 'mittel' : 'unsicher') : stab >= 0.999 ? 'stabil' : stab >= 0.75 ? 'mittel' : 'unsicher';
    const se = t.outSe ?? 0, out = t.outPerHour ?? 0;
    return { rank: i + 1, cell: t.cell, lat: t.lat, lon: t.lon, score: +t.score.toFixed(3), factors: Object.fromEntries(Object.entries(t.f).map(([k, v]) => [k, +v.toFixed(2)])),
      // Markt (alle Anbieter) und Anbieter-Anteil; starts/ends = gezählte Ereignisse in hours Messstunden; Enden/Abfluss ausgeglichen (× balanceK)
      starts: t.starts, ends: t.ends, hours: +model.hours.toFixed(2), balanceK: bal ? +bal.k.toFixed(3) : 1,
      startsPerHour: r2(t.startsPerHour), endsPerHour: r2(t.endsPerHour), endsPerHourBal: r2(t.endsPerHourBal ?? t.endsPerHour), outPerHour: r2(t.outPerHour), outPerHourRaw: r2(t.outPerHourRaw ?? t.outPerHour), outSe: r2(se), outLow: r2(lowOf(t)),
      startsPerHourOp: r2(nd.startsOp), endsPerHourOp: r2(nd.endsOp), outPerHourOp: r2(nd.outOp), outSeOp: r2(se * share),
      // Spanne ± z·SE (≈ 95 %) und vorsichtige Untergrenze max(0, Abfluss − z·SE), die in die MCDA eingeht (Anbieter-Anteil)
      outLoOp: r2((out - BOOT.z * se) * share), outHiOp: r2((out + BOOT.z * se) * share), outLowOp: r2(lowOf(t) * share),
      base: +nd.base.toFixed(1), drain: +nd.drain.toFixed(1), needRaw: +nd.raw.toFixed(1), target: nd.target, capped: nd.capped,
      supplyAvg: +t.supplyAvg.toFixed(1), flow: t.flow ? { out: t.flow.out, in: t.flow.in } : null,
      stability: +stab.toFixed(2), stabilityWeights: +stab.toFixed(2), bootShare: bs == null ? null : +bs.toFixed(2),
      outShr: r2(t.outShr), outShrOp: r2((t.outShr ?? 0) * share), stabilityLabel: wl, park: t.park ? { cat: t.park.cat, name: t.park.name || null } : null };
  });
  return {
    weights, activeFactors: active, excluded: cands.filter(c => c.excluded).length, candidates: cands.length, perturbations: variants.length,
    hours: model.hours, prelim: !(model.hours >= o.prelimH), horizonH: o.horizonH, baseH: o.baseH, share, rho: rho == null ? null : +rho.toFixed(2),
    excludedBy: { operator: why('Abstellverbot laut Betreiber-Zonen'), mandatory: why('Pflicht-Abstellzone ohne Station in 150 m'), official: why('Abstellverbot laut Stadt'), storage: why('vermutete Lagerfläche') },
    tau2: model.tau2 != null ? +model.tau2.toFixed(5) : null, outflowPositive: cands.filter(c => c.f.outflow > 0).length,
    // Ausgleich je Gemeinde (Zellen + below) und Bootstrap-Einstellungen; stable/uncertain = Zahl der Spots je Label
    balance: bal ? { ...bal, k: +bal.k.toFixed(4) } : null,
    boot: boot ? { draws: Math.floor(o.bootDraws ?? BOOT.draws), seed: o.bootSeed ?? BOOT.seed, minShare: BOOT.minShare, z: BOOT.z, mode: bt.mode, dirichlet: DIRICHLET_A } : null,
    stable: spots.filter(s => s.stabilityLabel === 'stabil').length, uncertain: spots.filter(s => s.stabilityLabel === 'unsicher').length,
    spots,
  };
}

// ---------- Touren ----------
export const EXACT_MAX = 12; // orderStops: bis zu so vielen Stopps exakt
export function makeCost(o = {}) { const detour = o.detour ?? DEFAULTS.detour; return (a, b) => dist(a, b) * detour; }
// Reihenfolge: Nächster Nachbar + 2-opt + Or-opt (wie im Routenplaner-Skill). start/end: Punkte oder null. starts/exact: Probe mit 1 Start, ohne exakt.
// Kostenmatrix einmal je Tour, jede Verbesserung nur über die betroffenen Kanten (Delta); cost(a, b) bleibt
// injizierbar und darf asymmetrisch sein (OSRM-Matrix): dann zählt bei 2-opt auch die Umkehr der inneren Kanten.
export function orderStops(stops, { start = null, end = null, cost = makeCost(), starts: maxStarts = 6, exact = true } = {}) {
  const n = stops.length; if (n <= 1) return stops.slice();
  const pts = stops.slice(); const S = start ? pts.push(start) - 1 : -1, E = end ? pts.push(end) - 1 : -1, N = pts.length;
  const M = pts.map(a => pts.map(b => a === b ? 0 : cost(a, b)));
  let sym = true; for (let i = 0; i < N && sym; i++) for (let j = i + 1; j < N; j++) if (Math.abs(M[i][j] - M[j][i]) > 1e-6 * Math.max(1, Math.abs(M[i][j]))) { sym = false; break; }
  const e = (a, b) => a < 0 || b < 0 ? 0 : M[a][b];
  const total = (t) => { let s = e(S, t[0]) + e(t[n - 1], E); for (let i = 0; i < n - 1; i++) s += M[t[i]][t[i + 1]]; return s; };
  // Bis 12 Stopps exakt (Held-Karp wie im Routenplaner-Skill): garantiert kürzeste Reihenfolge, nie länger als die Heuristik
  if (exact && n <= EXACT_MAX) {
    const F = 1 << n, dp = new Float64Array(F * n).fill(Infinity), par = new Int8Array(F * n).fill(-1);
    for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = e(S, j);
    for (let m = 1; m < F; m++) for (let j = 0; j < n; j++) {
      const v = dp[m * n + j]; if (v === Infinity || !(m & (1 << j))) continue;
      for (let k = 0; k < n; k++) if (!(m & (1 << k))) { const T = m | (1 << k), c = v + M[j][k]; if (c < dp[T * n + k]) { dp[T * n + k] = c; par[T * n + k] = j; } }
    }
    let bj = 0, bv = Infinity; for (let j = 0; j < n; j++) { const c = dp[(F - 1) * n + j] + e(j, E); if (c < bv) { bv = c; bj = j; } }
    const seq = []; for (let m = F - 1, j = bj; j >= 0;) { seq.push(j); const pj = par[m * n + j]; m &= ~(1 << j); j = pj; }
    return seq.reverse().map(i => stops[i]);
  }
  let best = null, bc = Infinity;
  const starts = Math.min(maxStarts, n); // wie bisher 6 Starts: gleiche Züge, gleiches Ergebnis, nur schneller bewertet
  for (let s = 0; s < starts; s++) {
    const left = [...Array(n).keys()], t = [];
    let cur = S;
    if (cur < 0 || s > 0) { cur = left.splice(s === 0 ? 0 : (s * 7919) % left.length, 1)[0]; t.push(cur); }
    while (left.length) { let bi = 0, bv = Infinity; for (let i = 0; i < left.length; i++) { const c = M[cur][left[i]]; if (c < bv) { bv = c; bi = i; } } cur = left.splice(bi, 1)[0]; t.push(cur); }
    // Präfixsummen der Kanten vorwärts/rückwärts, nur bei asymmetrischen Kosten nötig
    const F = new Float64Array(n), B = new Float64Array(n);
    const prefix = () => { if (sym) return; for (let i = 1; i < n; i++) { F[i] = F[i - 1] + M[t[i - 1]][t[i]]; B[i] = B[i - 1] + M[t[i]][t[i - 1]]; } };
    prefix();
    let improved = true, guard = 0;
    while (improved && guard++ < 60) {
      improved = false;
      // 2-opt: Abschnitt t[i..k] umkehren, Delta aus den zwei äußeren Kanten (+ innere bei Asymmetrie)
      for (let i = 0; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
        const a = i > 0 ? t[i - 1] : S, d = k < n - 1 ? t[k + 1] : E;
        let delta = e(a, t[k]) - e(a, t[i]) + e(t[i], d) - e(t[k], d);
        if (!sym) delta += (B[k] - B[i]) - (F[k] - F[i]);
        if (delta < -1e-6) { for (let x = i, y = k; x < y; x++, y--) { const h = t[x]; t[x] = t[y]; t[y] = h; } prefix(); improved = true; }
      }
      // Or-opt: Abschnitt (1–3 Stopps) ohne Umkehr an anderer Stelle einfügen, Delta aus drei Kanten
      for (let L = 1; L <= 3; L++) for (let i = 0; i + L <= n; i++) {
        const u = t[i], v = t[i + L - 1], pu = i > 0 ? t[i - 1] : S, nv = i + L < n ? t[i + L] : E;
        const rem = e(pu, nv) - e(pu, u) - e(v, nv), m = n - L, rest = (q) => q < i ? t[q] : t[q + L];
        for (let p = 0; p <= m; p++) {
          if (p === i) continue;
          const a = p > 0 ? rest(p - 1) : S, b = p < m ? rest(p) : E;
          if (rem + e(a, u) + e(v, b) - e(a, b) < -1e-6) { const seg = t.splice(i, L); t.splice(p, 0, ...seg); prefix(); improved = true; break; }
        }
      }
    }
    const c = total(t); if (c < bc) { bc = c; best = t; }
  }
  return best.map(i => stops[i]);
}
// ---------- Priorität je Stopp ----------
// Skala: 0 = nicht dringend, 1 = dringend, bis 1,5 mit Zuschlag. Ein Stopp mit mehreren Fahrzeugen zählt mit dem dringendsten (Grund = dessen Werte).
// Begründung der Konstanten:
//  energyW 0,7 / idleW 0,3 – Akkutausch: ein fast leeres Fahrzeug fällt als Nächstes aus (kein Umsatz, Kunden stranden); die Standzeit zeigt
//    zusätzlich, dass es an der Stelle niemand nimmt. Energie-Lücke = 1 − Ladestand ÷ Tauschschwelle bzw. 1 − Reichweite ÷ Schwelle (die größere
//    von beiden; 0 an der Schwelle, 1 bei leer).
//  idleRefH 24 – Standzeit zählt linear bis 24 h voll (Einsammeln: Standzeit des Überschuss-Fahrzeugs; Werkstatt: Sperrdauer = Standzeit seit der
//    letzten Bewegung, der Feed meldet keinen Sperrbeginn).
//  longIdleBonus 0,5 ab longIdleH 24 h – länger als einen Tag ungenutzt bzw. gesperrt ist deutlich dringender (Beschwerden, Vandalismus, Auflagen).
//  needRef 6 – Ausbringen (Umsetzen, Stationsausgleich): Fehlmenge ÷ 6 Fahrzeuge, höchstens 1 (6 ≈ ein Drittel einer Transporterladung).
//  emptyBonus 0,5 – Spot ohne verfügbares Fahrzeug im Umkreis (150 m) bzw. leere Station: dort geht gerade jede Fahrt verloren.
//  fullStation 0,5 – Abholen an einer Station ohne freien Platz (keine Rückgabe möglich); sonst ist Abholen nicht dringend (0).
export const PRIO = { energyW: 0.7, idleW: 0.3, idleRefH: 24, longIdleH: 24, longIdleBonus: 0.5, needRef: 6, emptyBonus: 0.5, fullStation: 0.5 };
const r3 = (x) => Math.round(x * 1000) / 1000;
const idleH = (v) => Math.max(0, v.idleMin ?? 0) / 60;
const idlePart = (h) => Math.min(1, h / PRIO.idleRefH) + (h >= PRIO.longIdleH ? PRIO.longIdleBonus : 0);
/** Priorität eines Fahrzeugs für einen Stopp-Typ ('swap' | 'pickup' | 'pickup_disabled') mit Grund { battery, rangeKm, idleH }. */
export function vehiclePrio(type, v, opts = {}) {
  const o = { ...DEFAULTS, ...opts }, h = idleH(v), why = { idleH: v.idleMin == null ? null : Math.round(h) };
  if (type !== 'swap') return { prio: r3(idlePart(h)), why };
  const gaps = [v.battery != null ? 1 - v.battery / o.swapThreshold : null, rangeUsable(v) ? 1 - v.rangeKm / swapRangeOf(v, o.swapRangeKm) : null].filter(x => x != null);
  const gap = gaps.length ? Math.min(1, Math.max(0, ...gaps)) : 0;
  return { prio: r3(PRIO.energyW * gap + PRIO.idleW * Math.min(1, h / PRIO.idleRefH) + (h >= PRIO.longIdleH ? PRIO.longIdleBonus : 0)), why: { battery: v.battery ?? null, rangeKm: v.rangeKm ?? null, ...why } };
}
/** Priorität eines Ausbring-Stopps nach Fehlmenge (need) und Bestand im Umkreis (have; 0 = leer). */
export function dropPrio(need, have, target = null) {
  const n = Math.max(0, need || 0);
  return { prio: r3(Math.min(1, n / PRIO.needRef) + (have === 0 ? PRIO.emptyBonus : 0)), why: { need: n, have, target, empty: have === 0 } };
}
// dringendstes Fahrzeug eines Stopps
const maxPrio = (list) => list.reduce((b, x) => (x.prio > b.prio ? x : b), list[0]);

// ---------- Reihenfolge mit Priorität ----------
/**
 * Reihenfolge einer Tour aus Gruppen in fester Folge (Umsetzen: erst alle Abholungen, dann alle Ausbringungen) mit Priorität.
 * Ziel J = L + λ · Σ wᵢ·dᵢ ÷ Σ wᵢ
 *   L = Tourlänge (Start → Stopps → Ende), dᵢ = Strecke vom Start bis Stopp i, wᵢ = Priorität − kleinste Priorität der Tour (≥ 0).
 * Der zweite Term ist die nach Dringlichkeit gewichtete mittlere Anfahrstrecke in Metern (wie L): dringende Stopps kommen früh, wenn der Umweg
 * klein ist. λ = 0 oder gleiche Prioritäten (alle wᵢ = 0) ergeben die kürzeste Tour. Weil wᵢ ≥ 0, macht ein Umweg J nie kleiner.
 * Exakt (Held-Karp je Gruppe, Gruppen verkettet), solange jede Gruppe ≤ EXACT_MAX Stopps hat: jede Kante zählt für alle noch offenen Stopps,
 * der Aufschlag hängt also nur von der Menge der besuchten Stopps ab und die DP über (Menge, letzter Stopp) bleibt exakt. Darüber Heuristik:
 * Startlösungen (kürzeste Tour wie bisher, Nächster Nachbar mit Priorität, reine Prioritätsfolge, Nächster Nachbar ab anderen Stopps), dann
 * 2-opt und Or-opt innerhalb der Gruppen auf dem vollen Ziel. cost(a, b) darf asymmetrisch sein (OSRM-Matrix).
 * Rückgabe { stops, J, L, reach } (reach = Σ wᵢ·dᵢ ÷ Σ wᵢ oder null, Einheiten von cost).
 */
export function orderTour(groups, { start = null, end = null, cost = makeCost(), weight = null, lambda = 0, exact = true, starts: maxStarts = 6 } = {}) {
  const G0 = groups.filter(g => g?.length), stops = G0.flat(), n = stops.length;
  if (!n) return { stops: [], J: 0, L: 0, reach: null };
  const pts = stops.slice(); const S = start ? pts.push(start) - 1 : -1, E = end ? pts.push(end) - 1 : -1, N = pts.length;
  const M = new Float64Array(N * N); for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) M[i * N + j] = i === j ? 0 : cost(pts[i], pts[j]);
  const raw = stops.map(s => (weight ? +weight(s) || 0 : 0)), wmin = Math.min(...raw), w = Float64Array.from(raw, x => x - wmin);
  const W = w.reduce((a, b) => a + b, 0), lam = lambda > 0 && W > 1e-9 ? lambda / W : 0;
  const ranges = []; { let a = 0; for (const g of G0) { ranges.push([a, a + g.length]); a += g.length; } } // Stopps der Gruppe g = Indizes ranges[g]
  // Tourwerte einer Folge t (Stopp-Indizes): L, Σ w·d, J
  const evalT = (t) => { let R = W, J = 0, L = 0, wd = 0, d = 0, p = S;
    for (let i = 0; i < n; i++) { const x = t[i]; if (p >= 0) { const c = M[p * N + x]; L += c; d += c; J += c * (1 + lam * R); } wd += w[x] * d; R -= w[x]; p = x; }
    if (E >= 0) { const c = M[p * N + E]; L += c; J += c; }
    return { J, L, reach: W > 1e-9 ? wd / W : null }; };
  const done = (t) => { const v = evalT(t); return { stops: Array.from(t, i => stops[i]), J: v.J, L: v.L, reach: v.reach }; };
  const pix = new Map(); pts.forEach((p, i) => { if (!pix.has(p)) pix.set(p, i); });
  const mc = (a, b) => M[pix.get(a) * N + pix.get(b)], ix = new Map(stops.map((s, i) => [s, i]));
  // eine Gruppe ohne Priorität: bisherige Reihenfolge (Held-Karp bis 12, sonst Nächster Nachbar + 2-opt + Or-opt mit Delta-Bewertung)
  if (G0.length === 1 && lam === 0) return done(Int32Array.from(orderStops(stops, { start, end, cost: mc, starts: maxStarts, exact }), s => ix.get(s)));
  // ---- exakt: Held-Karp je Gruppe, verkettet über den letzten Stopp der vorigen Gruppe
  if (exact && ranges.every(([a, b]) => b - a <= EXACT_MAX)) {
    let prevNodes = [S], prevCost = [0], Wrest = W; const back = [];
    for (const [a, b] of ranges) {
      const m = b - a, F = 1 << m, Gn = Array.from({ length: m }, (_, j) => a + j);
      let Wg = 0; for (const x of Gn) Wg += w[x]; Wrest -= Wg;
      const Wm = new Float64Array(F); for (let mk = 1; mk < F; mk++) { const lb = mk & -mk; Wm[mk] = Wm[mk ^ lb] + w[Gn[31 - Math.clz32(lb)]]; }
      const dp = new Float64Array(F * m).fill(Infinity), par = new Int8Array(F * m).fill(-1), seed = new Int32Array(m);
      for (let j = 0; j < m; j++) for (let e = 0; e < prevNodes.length; e++) {
        const pe = prevNodes[e], c = prevCost[e] + (pe < 0 ? 0 : M[pe * N + Gn[j]] * (1 + lam * (Wg + Wrest)));
        if (c < dp[(1 << j) * m + j]) { dp[(1 << j) * m + j] = c; seed[j] = e; }
      }
      for (let mk = 1; mk < F; mk++) { const mult = 1 + lam * (Wg - Wm[mk] + Wrest);
        for (let j = 0; j < m; j++) { const v = dp[mk * m + j]; if (v === Infinity || !(mk & (1 << j))) continue;
          for (let k = 0; k < m; k++) if (!(mk & (1 << k))) { const T = mk | (1 << k), c = v + M[Gn[j] * N + Gn[k]] * mult; if (c < dp[T * m + k]) { dp[T * m + k] = c; par[T * m + k] = j; } } } }
      back.push({ Gn, m, F, par, seed }); prevNodes = Gn; prevCost = Gn.map((_, j) => dp[(F - 1) * m + j]);
    }
    let bj = 0, bv = Infinity; for (let j = 0; j < prevNodes.length; j++) { const c = prevCost[j] + (E >= 0 ? M[prevNodes[j] * N + E] : 0); if (c < bv) { bv = c; bj = j; } }
    const seq = []; let j = bj;
    for (let g = back.length - 1; g >= 0; g--) { const { Gn, m, F, par, seed } = back[g]; const part = []; let mk = F - 1, jj = j, first = j;
      while (jj >= 0) { part.push(Gn[jj]); first = jj; const pj = par[mk * m + jj]; mk &= ~(1 << jj); jj = pj; }
      seq.push(...part); j = seed[first]; }
    return done(Int32Array.from(seq.reverse()));
  }
  // ---- Heuristik
  // Nächster Nachbar über die Gruppen nacheinander; score(x) skaliert den Abstand (Priorität: dringende wirken näher), first = erster Stopp
  const nnFrom = (score, first = null) => { const t = []; let cur = S;
    for (const [a, b] of ranges) { const left = []; for (let x = a; x < b; x++) left.push(x);
      if (first != null && a === 0) { left.splice(left.indexOf(first), 1); t.push(first); cur = first; }
      while (left.length) { let bi = 0, bv = Infinity; for (let i = 0; i < left.length; i++) { const c = (cur < 0 ? 0 : M[cur * N + left[i]]) * score(left[i]); if (c < bv - 1e-12) { bv = c; bi = i; } } cur = left.splice(bi, 1)[0]; t.push(cur); } }
    return Int32Array.from(t); };
  const seeds = [];
  // 1) kürzeste Tour wie bisher: je Gruppe orderStops (Start = Ende der vorigen Gruppe, Ende nur bei der letzten) → nie länger als vorher
  { const t = []; let st = start;
    ranges.forEach(([a, b], g) => { const part = orderStops(stops.slice(a, b), { start: st, end: g === ranges.length - 1 ? end : null, cost: mc, starts: Math.min(maxStarts, 6), exact }); t.push(...part.map(s => ix.get(s))); st = part[part.length - 1]; });
    seeds.push(Int32Array.from(t)); }
  if (lam > 0) {
    const wMean = W / n;
    seeds.push(nnFrom(x => 1 / (1 + lambda * w[x] / wMean)));                                                     // 2) Nächster Nachbar mit Priorität
    if (maxStarts > 1) seeds.push(Int32Array.from(ranges.flatMap(([a, b]) => Array.from({ length: b - a }, (_, k) => a + k).sort((x, y) => w[y] - w[x] || x - y)))); // 3) reine Prioritätsfolge
  }
  for (let s = 1; seeds.length < maxStarts && s < n; s++) seeds.push(nnFrom(() => 1, (s * 7919) % (ranges[0][1] - ranges[0][0]))); // 4) andere erste Stopps
  // Lokale Suche. Jeder Zug ergibt eine Folge aus höchstens vier Blöcken der aktuellen Folge t (vorwärts oder rückwärts); mit Präfixsummen
  // der Kanten vorwärts (Fw) und rückwärts (Bw, für asymmetrische Kosten), der Gewichte (PW) und Gewicht × Strecke (PWF, PWB) kostet die
  // Bewertung eines Zugs O(1): je Block Länge, Gewicht und Σ w × Anfahrt innerhalb des Blocks.
  let t = null; const Fw = new Float64Array(n), Bw = new Float64Array(n), PW = new Float64Array(n + 1), PWF = new Float64Array(n + 1), PWB = new Float64Array(n + 1);
  const prefix = () => { for (let x = 1; x < n; x++) { Fw[x] = Fw[x - 1] + M[t[x - 1] * N + t[x]]; Bw[x] = Bw[x - 1] + M[t[x] * N + t[x - 1]]; }
    for (let x = 0; x < n; x++) { const wx = w[t[x]]; PW[x + 1] = PW[x] + wx; PWF[x + 1] = PWF[x] + wx * Fw[x]; PWB[x + 1] = PWB[x] + wx * Bw[x]; } };
  const bl = new Int32Array(12); let nb = 0; const blk = (s, e, rv) => { if (s <= e) { bl[3 * nb] = s; bl[3 * nb + 1] = e; bl[3 * nb + 2] = rv; nb++; } };
  const evalBl = () => { let D = 0, L = 0, WD = 0, prev = S;
    for (let k = 0; k < nb; k++) { const s = bl[3 * k], e = bl[3 * k + 1], rv = bl[3 * k + 2], Wb = PW[e + 1] - PW[s];
      if (prev >= 0) { const c = M[prev * N + (rv ? t[e] : t[s])]; D += c; L += c; }
      const len = rv ? Bw[e] - Bw[s] : Fw[e] - Fw[s];
      WD += Wb * D + (rv ? Bw[e] * Wb - (PWB[e + 1] - PWB[s]) : (PWF[e + 1] - PWF[s]) - Fw[s] * Wb); D += len; L += len; prev = rv ? t[s] : t[e]; }
    if (E >= 0) L += M[prev * N + E];
    return L + lam * WD; };
  const applyBl = () => { const u = new Int32Array(n); let q = 0; for (let k = 0; k < nb; k++) { const s = bl[3 * k], e = bl[3 * k + 1]; if (bl[3 * k + 2]) for (let x = e; x >= s; x--) u[q++] = t[x]; else for (let x = s; x <= e; x++) u[q++] = t[x]; } t = u; prefix(); };
  const improve = (t0) => { t = Int32Array.from(t0); prefix(); nb = 0; blk(0, n - 1, 0); let cur = evalBl(), improved = true, guard = 0;
    const tryMove = () => { const c = evalBl(); if (c < cur - 1e-6) { applyBl(); cur = c; return true; } return false; };
    while (improved && guard++ < 60) { improved = false;
      for (const [a, b] of ranges) {
        // 2-opt: t[i..k] umkehren
        for (let i = a; i < b - 1; i++) for (let k = i + 1; k < b; k++) { nb = 0; blk(0, i - 1, 0); blk(i, k, 1); blk(k + 1, n - 1, 0); if (tryMove()) improved = true; }
        // Or-opt: Abschnitt t[i..i+L−1] (vorwärts oder umgekehrt) an Stelle p der übrigen Folge einsetzen, innerhalb der Gruppe
        for (let L = 1; L <= 3; L++) for (let i = a; i + L <= b; i++) for (let p = a; p <= b - L; p++) {
          if (p === i) continue; let hit = false;
          for (let rv = 0; rv <= (L > 1 ? 1 : 0) && !hit; rv++) {
            nb = 0;
            if (p < i) { blk(0, p - 1, 0); blk(i, i + L - 1, rv); blk(p, i - 1, 0); blk(i + L, n - 1, 0); }
            else { blk(0, i - 1, 0); blk(i + L, p + L - 1, 0); blk(i, i + L - 1, rv); blk(p + L, n - 1, 0); }
            hit = tryMove();
          }
          if (hit) { improved = true; break; }
        }
      } }
    return { c: cur, t }; };
  let best = null, bc = Infinity;
  for (const s of seeds) { const r = improve(s); if (r.c < bc - 1e-9) { bc = r.c; best = r.t; } }
  return done(best);
}
/** Kostenfunktion aus einer übergebenen Matrix (Meter; Zeile/Spalte = Reihenfolge von points); fehlende Werte (null) → Luftlinie × Umwegfaktor. */
const ptKey = (p) => `${(+p.lat).toFixed(5)},${(+p.lon).toFixed(5)}`;
export function matrixCost(points, D, { detour = DEFAULTS.detour } = {}) {
  const idx = new Map(); points.forEach((p, i) => { if (!idx.has(p)) idx.set(p, i); const k = ptKey(p); if (!idx.has(k)) idx.set(k, i); });
  const at = (p) => idx.get(p) ?? idx.get(ptKey(p)), air = makeCost({ detour });
  return (a, b) => { const i = at(a), j = at(b), v = i != null && j != null ? D?.[i]?.[j] : null; return Number.isFinite(v) ? v : air(a, b); };
}
/**
 * S2.12: Tour nach dem Straßenrouting wieder unter die Einsatzgrenze bringen. Solange Fahrzeit (minOf(Depot, Stopps, Depot), Minuten) plus
 * Handhabung (je Fahrzeug wie geplant: handleMin ÷ vehicles) über limitMin liegt, fällt der Stopp mit der niedrigsten Priorität weg –
 * bei Umsetzen/Stationen eine Ausbringung samt gleich vielen Abholungen niedrigster Priorität –, dann wird neu geordnet (cost, lambda).
 * Rückgabe { stops, vehicles, removed, driveMin, handleMin, totalMin }; removed = Fahrzeuge, die nicht mehr eingeplant sind.
 */
export function trimRun(r, { depot, cost = makeCost(), minOf, limitMin, lambda = DEFAULTS.prioLambda } = {}) {
  const hv = r.vehicles > 0 ? r.handleMin / r.vehicles : 0, low = (a, b) => ((b.prio ?? 0) < (a.prio ?? 0) ? b : a);
  let stops = r.stops.slice(), veh = r.vehicles, removed = 0;
  const drive = (st) => minOf([depot, ...st, depot]);
  while (limitMin > 0 && stops.length > 1 && drive(stops) + hv * veh > limitMin) {
    const g = runGroups(stops);
    if (g.length === 2) {
      if (g[1].length <= 1) break; // letzte Ausbringung bleibt: sonst wäre die Tour leer
      const d = g[1].reduce(low); let c = d.count || 1; stops = stops.filter(x => x !== d); veh -= c; removed += c;
      for (const pk of g[0].slice().sort((a, b) => (a.prio ?? 0) - (b.prio ?? 0))) {
        if (c <= 0) break; const k = Math.min(c, pk.count || 1); c -= k;
        stops = k >= (pk.count || 1) ? stops.filter(x => x !== pk) : stops.map(x => (x === pk ? { ...x, count: x.count - k } : x));
      }
    } else { const x = stops.reduce(low), n = x.count || 1; stops = stops.filter(y => y !== x); veh -= n; removed += n; }
    stops = sequenceRun(runGroups(stops), { depot, cost, lambda }).stops;
  }
  const driveMin = Math.round(drive(stops)), handleMin = Math.round(hv * veh);
  return { stops, vehicles: veh, removed, driveMin, handleMin, totalMin: driveMin + handleMin };
}
/** Stopp-Gruppen einer fertigen Tour: Umsetzen/Stationen erst alle Abholungen, dann alle Ausbringungen; sonst eine Gruppe. */
export function runGroups(stops) {
  const pick = stops.filter(s => s.type === 'pickup'), drop = stops.filter(s => s.type === 'drop');
  return pick.length && drop.length && pick.length + drop.length === stops.length ? [pick, drop] : [stops.slice()];
}
/**
 * Reihenfolge und Kennzahlen einer Tour (Planung mit Luftlinie × Umwegfaktor; im Browser erneut mit der OSRM-Straßenmatrix als cost).
 * Jeder Stopp trägt prio (Priorität) und why (Grund). Rückgabe: stops in Fahrreihenfolge mit seq (Position), rank (Rang der Priorität in der
 * Tour, 1 = dringendster), atKm (Strecke vom Depot bis zum Stopp); km (gefahren), kmMin (kürzeste Tour ohne Priorität), kmNN (Nächster Nachbar
 * ohne Verbesserung), kmPrio (reine Prioritätsfolge), reachKm / reachKmMin (nach Priorität gewichtete mittlere Anfahrstrecke dieser bzw. der
 * kürzesten Tour), obj (Zielwert J in m), lambda. quick: schnelle Rechnung (Probe der Einsatzzeit: ein Start, ohne exakte Lösung).
 */
export function sequenceRun(groups, { depot, cost = makeCost(), lambda = DEFAULTS.prioLambda, quick = false } = {}) {
  const G = groups.filter(g => g?.length), opt = { start: depot, end: depot, cost, weight: s => s.prio ?? 0 };
  const res = orderTour(G, { ...opt, lambda, starts: quick ? 1 : 6, exact: !quick });
  const km = (m) => +(m / 1000).toFixed(1);
  const pv = res.stops.map(s => s.prio ?? 0), rankOf = (p) => 1 + pv.filter(x => x > p + 1e-9).length;
  let d = 0, prev = depot;
  const stops = res.stops.map((s, i) => { d += cost(prev, s); prev = s; return { ...s, seq: i + 1, rank: rankOf(s.prio ?? 0), atKm: km(d) }; });
  const out = { stops, L: res.L, obj: res.J, km: km(res.L), lambda, reachKm: res.reach == null ? null : km(res.reach) };
  // Vergleichswerte auch in der Probe (sie kann als Tour übernommen werden), dort mit der schnellen Rechnung
  let base = lambda > 0 && res.reach != null ? orderTour(G, { ...opt, lambda: 0, starts: quick ? 1 : 6, exact: !quick }) : res;
  if (res.L < base.L) base = res; // Heuristik: die Prioritätstour ist zufällig kürzer → sie ist die kürzeste bekannte
  const len = (seq) => { let m = 0, p = depot; for (const s of seq) { m += cost(p, s); p = s; } return m + cost(p, depot); };
  // Nächster Nachbar ohne Verbesserung (Gruppen nacheinander) und reine Prioritätsfolge (absteigend, Gleichstand in Planungsfolge)
  const nn = []; { let cur = depot; for (const g of G) { const left = g.slice(); while (left.length) { let bi = 0, bv = Infinity; left.forEach((x, i) => { const c = cost(cur, x); if (c < bv) { bv = c; bi = i; } }); cur = left.splice(bi, 1)[0]; nn.push(cur); } } }
  const byPrio = G.flatMap(g => g.map((s, i) => [s, i]).sort((a, b) => (b[0].prio ?? 0) - (a[0].prio ?? 0) || a[1] - b[1]).map(x => x[0]));
  return { ...out, kmMin: km(base.L), reachKmMin: base.reach == null ? null : km(base.reach), kmNN: km(len(nn)), kmPrio: km(len(byPrio)) };
}
// Fahrstrecke und -zeit einer Tour aus sequenceRun (Luftlinie × Umweg bei speedKmh); Kennzahlen der Reihenfolge für die Anzeige
const seqSummary = (sq, o) => ({ km: sq.km, driveMin: Math.round((sq.L / 1000) / o.speedKmh * 60), obj: sq.obj, lambda: sq.lambda, kmMin: sq.kmMin ?? null, kmNN: sq.kmNN ?? null, kmPrio: sq.kmPrio ?? null, reachKm: sq.reachKm, reachKmMin: sq.reachKmMin ?? null });

// Stopps in Läufe gleicher Kapazität bündeln: Sweep vom Depot aus (weitester zuerst), dann die dem Tour-Mittelpunkt nächsten auffüllen.
// fit(run) → { back, ok }: Einsatzzeit prüfen; ein zu langer Lauf behält nur einen Teil (in place), back geht in den Vorrat zurück,
// ok = false: schon der nächstgelegene Auftrag allein ist zu lang (nicht eingeplant).
const centerOf = (pts) => ({ lat: sum(pts.map(p => p.lat)) / pts.length, lon: sum(pts.map(p => p.lon)) / pts.length });
// order(a, b): optionale Vorrangregel für den Tour-Start (Umsetzen: größte Fehlmenge zuerst), bei Gleichstand weitester vom Depot
export function clusterRuns(items, capacity, depot, maxRuns = Infinity, weight = () => 1, fit = null, order = null) {
  const dd = new Map(items.map(x => [x, dist(depot, x)])), far = (a, b) => dd.get(b) - dd.get(a), byDepot = order ? (a, b) => order(a, b) || far(a, b) : far;
  const left = items.slice().sort(byDepot), runs = [], tooLong = []; // einmal sortiert, Reihenfolge bleibt beim Entnehmen
  while (left.length && runs.length < maxRuns) {
    const seed = left.shift(); const run = [seed]; let load = weight(seed), sl = seed.lat, so = seed.lon;
    while (left.length && load < capacity) {
      const cx = { lat: sl / run.length, lon: so / run.length };
      let bi = -1, bd = Infinity; for (let i = 0; i < left.length; i++) { const x = left[i]; if (load + weight(x) > capacity) continue; const d = dist(cx, x); if (d < bd) { bd = d; bi = i; } }
      if (bi < 0) break; const x = left.splice(bi, 1)[0]; run.push(x); load += weight(x); sl += x.lat; so += x.lon;
    }
    if (fit) { const f = fit(run); if (f.back.length) { left.push(...f.back); left.sort(byDepot); } if (!f.ok) { tooLong.push(...run); continue; } }
    runs.push(run);
  }
  return { runs, unplanned: [...left, ...tooLong] };
}
// Einsatzzeit je Tour begrenzen (Fahrt + vor Ort ≤ maxMin): Aufträge nach Abstand zum Tour-Mittelpunkt ordnen und per
// Halbierung die meisten nahen behalten, die noch passen; die fernen gehen zurück in den Vorrat und bilden eigene Touren.
// spread(x, c): Abstand eines Auftrags zum Mittelpunkt (Umsetzen: weiterer von Abhol- und Zielort). memo: fertige Tour je Lauf.
function timeCap(build, maxMin, spread = (x, c) => dist(c, x)) {
  const memo = new Map();
  const fit = (run) => {
    const all = build(run);
    if (!(maxMin > 0) || all.totalMin <= maxMin) { memo.set(run, all); return { back: [], ok: true }; }
    const c = centerOf(run), ranked = run.map(x => [x, spread(x, c)]).sort((a, b) => a[1] - b[1]).map(a => a[0]);
    // größtes k < n, für das die k nächsten passen; Probe schnell mit einem Startpunkt, danach die kürzere von Probe und voller Rechnung
    let lo = 0, hi = ranked.length - 1, probe = null;
    while (lo < hi) { const k = (lo + hi + 1) >> 1, r = build(ranked.slice(0, k), true); if (r.totalMin <= maxMin) { lo = k; probe = r; } else hi = k - 1; }
    const k = Math.max(1, lo); run.length = 0; run.push(...ranked.slice(0, k));
    // volle Rechnung, wenn sie die Grenze hält und im Ziel (Strecke + Priorität, ohne Priorität = Strecke) nicht schlechter ist als die Probe
    if (probe) { const r = build(run); memo.set(run, r.totalMin <= maxMin && r.obj <= probe.obj + 1e-6 ? r : probe); }
    return { back: ranked.slice(k), ok: !!probe };
  };
  return { fit, built: (run) => memo.get(run) || build(run) };
}
// gleiche Position (≤ 30 m) zu einem Stopp zusammenfassen
function groupStops(points, keyFn = () => '', maxM = 30) {
  const out = [];
  for (const p of points) { const g = out.find(s => s.key === keyFn(p) && dist(s, p) <= maxM); if (g) { g.items.push(p); g.count++; } else out.push({ lat: p.lat, lon: p.lon, key: keyFn(p), items: [p], count: 1 }); }
  return out;
}

/**
 * Rebalancing: Fahrzeuge aus Überschuss (lange Standzeit, Zellen mit Zufluss) zu Deploy-Spots mit Fehlmenge.
 * vehicles: verfügbare Fahrzeuge des Anbieters in der Gemeinde. model: Nachfragemodell (Band oder Tag).
 * Bestand = verfügbare Fahrzeuge des Anbieters im Umkreis spotRadiusM (150 m) um den Spot, Fehlmenge = Bedarf − Bestand.
 * Vorrang nach Fehlmenge: Spots mit der größten Fehlmenge bekommen zuerst Überschussfahrzeuge, eröffnen zuerst eine Tour, R1 deckt die größte.
 */
export function planRebalance({ spots, vehicles, model, share = 1, depot, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const cost = makeCost(o);
  // S2.11: jedes Fahrzeug zählt nur am nächsten Spot (Spots ≥ minSpacingM auseinander, Umkreis spotRadiusM: Kreise überlappen) – sonst zählt es als
  // Bestand zweier Spots und kann zweimal als Überschuss in die Umsetzungen
  const near = new Map(spots.map(s => [s.cell, []]));
  for (const v of vehicles) { let best = null, bd = Infinity; for (const s of spots) { const d = dist(s, v); if (d <= o.spotRadiusM && d < bd) { bd = d; best = s; } } if (best) near.get(best.cell).push(v); }
  const needs = spots.map(s => ({ spot: s, have: near.get(s.cell).length, need: Math.max(0, s.target - near.get(s.cell).length) }));
  const atSpot = new Set(spots.flatMap(s => near.get(s.cell)));
  // überbelegte Spots geben ihre am längsten stehenden Fahrzeuge ab
  const spotExtra = [];
  for (const s of spots) { const list = near.get(s.cell).slice().sort((a, b) => (b.idleMin ?? 0) - (a.idleMin ?? 0)); for (const v of list.slice(0, Math.max(0, list.length - s.target))) spotExtra.push(v); }
  // Überschuss je Zelle: Fahrzeuge über dem rechnerischen Bedarf der Zelle (gleiche Formel wie am Spot, ohne Mindest-/Höchstwert)
  const byCell = new Map();
  for (const v of vehicles) { if (atSpot.has(v)) continue; const c = cellOf(v.lat, v.lon); if (!byCell.has(c)) byCell.set(c, []); byCell.get(c).push(v); }
  const surplus = [];
  for (const [cell, list] of byCell) {
    const mc = model.cells.get(cell), nd = needOf(mc, share, o);
    const keep = Math.ceil(nd.raw - 1e-9);
    const movable = list.filter(v => v.battery == null || v.battery >= o.minBatteryForMove).sort((a, b) => (b.idleMin ?? 0) - (a.idleMin ?? 0));
    const longIdle = movable.filter(v => (v.idleMin ?? 0) >= o.idleSurplusMin);
    const extra = movable.slice(0, Math.max(0, movable.length - keep));
    for (const v of new Set([...longIdle, ...extra])) surplus.push({ ...v, cell, cellDemand: +nd.startsOp.toFixed(2), cellOut: +nd.outOp.toFixed(2) });
  }
  for (const v of spotExtra) if (v.battery == null || v.battery >= o.minBatteryForMove) surplus.push({ ...v, cell: cellOf(v.lat, v.lon), fromSpot: true });
  // Zuordnung: Spots nach Fehlmenge (dann Score), je fehlendem Fahrzeug das nächste Überschussfahrzeug;
  // je Spot die Kandidaten in Reichweite einmal nach Entfernung sortieren (statt je fehlendem Fahrzeug den ganzen Pool)
  const taken = new Set(); const moves = [];
  for (const n of needs.slice().sort((a, b) => b.need - a.need || b.spot.score - a.spot.score)) {
    const cands = surplus.map(v => ({ v, d: dist(v, n.spot) })).filter(x => x.d <= o.maxPickupM && !(x.v.fromSpot && x.d <= o.spotRadiusM)).sort((a, b) => a.d - b.d);
    let k = 0;
    for (const { v, d } of cands) { if (k >= n.need) break; if (taken.has(v)) continue; taken.add(v); k++; moves.push({ lat: v.lat, lon: v.lon, vehicle: v, spot: n.spot, need: n.need, have: n.have, distM: Math.round(d) }); }
  }
  const missing = sum(needs.map(n => n.need)) - moves.length;
  // Touren nach dem Mittelpunkt aus Abhol- und Zielort bündeln: jede Tour bleibt in einem Stadtbereich; Lage = weiterer der beiden Orte
  const mids = moves.map(m => ({ lat: (m.lat + m.spot.lat) / 2, lon: (m.lon + m.spot.lon) / 2, m }));
  const spread = (x, c) => Math.max(dist(c, x.m), dist(c, x.m.spot));
  // Reihenfolge: erst alle Abholungen, dann alle Ausbringungen, beide zusammen optimiert (sequenceRun); Priorität Abholen = Standzeit,
  // Ausbringen = Fehlmenge des Spots (leer im Umkreis = Zuschlag)
  const build = (run, quick) => {
    const g = run.map(x => x.m);
    const pickups = groupStops(g, () => 'p').map(s => ({ type: 'pickup', lat: s.lat, lon: s.lon, count: s.count, idleMaxH: Math.round(Math.max(...s.items.map(x => x.vehicle.idleMin ?? 0)) / 60), battery: s.items.map(x => x.vehicle.battery).filter(b => b != null), ...maxPrio(s.items.map(x => vehiclePrio('pickup', x.vehicle, o))) }));
    const drops = groupStops(g.map(m => ({ ...m.spot, move: m })), s => s.cell, 5).map(s => { const mv = s.items[0].move;
      return { type: 'drop', lat: s.lat, lon: s.lon, count: s.count, spotRank: s.items[0].rank, target: s.items[0].target, have: mv.have, need: mv.need, ...dropPrio(mv.need, mv.have, s.items[0].target) }; });
    const sq = sequenceRun([pickups, drops], { depot, cost, lambda: o.prioLambda, quick });
    const r = seqSummary(sq, o);
    const handle = g.length * (o.pickupMin + o.dropMin);
    return { kind: 'rebalance', vehicles: g.length, shortfall: sum(drops.map(d => d.need)), prio: Math.max(0, ...drops.map(d => d.need)), stops: sq.stops,
      ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin, spread), cl = clusterRuns(mids, o.vanCapacity, depot, o.maxRuns, undefined, cap.fit, (a, b) => b.m.need - a.m.need);
  // R1 = Tour zum Spot mit der größten Fehlmenge, dann absteigend
  const runs = cl.runs.map(g => cap.built(g)).sort((a, b) => b.prio - a.prio || b.shortfall - a.shortfall || b.vehicles - a.vehicles).map((r, i) => ({ id: `R${i + 1}`, ...r }));
  return { needs: needs.sort((a, b) => a.spot.rank - b.spot.rank).map(n => ({ rank: n.spot.rank, cell: n.spot.cell, target: n.spot.target, have: n.have, need: n.need })), surplus: surplus.length, moves: moves.length, missing, unplanned: cl.unplanned.length, limitMin: o.maxRunMin, runs };
}

/**
 * Akku-Tausch: Fahrzeuge unter der Schwelle, priorisiert nach Ladestand und Nachfrage am Standort.
 */
export const MAX_SWAP = 50; // höchstens 50 Akkus je Tour (Ladekapazität eines Tauschfahrzeugs)
// Akkutausch nötig: Ladestand UND Reichweite unter der Schwelle (beides muss erfüllt sein). Meldet ein Feed nur eines
// von beiden, entscheidet dieses; ohne Energieangabe kein Tausch.
// Reichweiten-Schwelle je Fahrzeug = min(swapRangeKm, v.rangeLimitKm): v.rangeLimitKm ist die Schwelle der Quelle (20 % des 95. Perzentils der
// Reichweite, wenn dieses < 25 km; pulse-core rangeLimitCheck, Nutzerwunsch 02.11.2026), null = eingestellter Wert.
export const swapRangeOf = (v, swapRangeKm = DEFAULTS.swapRangeKm) => (v?.rangeLimitKm != null && Number.isFinite(v.rangeLimitKm) ? Math.min(swapRangeKm, v.rangeLimitKm) : swapRangeKm);
// Reichweite verwendbar: gemeldet und nicht konstant (v.rangeFlat = Platzhalter der Quelle, pulse-core rangeFlatCheck)
export const rangeUsable = (v) => v?.rangeKm != null && !v.rangeFlat;
export function needsSwap(v, { swapThreshold = DEFAULTS.swapThreshold, swapRangeKm = DEFAULTS.swapRangeKm } = {}) {
  if (v.disabled) return false;
  // Reichweite aus dem Ladestand gerechnet (v.rangeDerived, M-16): nur der Ladestand entscheidet; sonst UND-Regel (Nutzervorgabe)
  const bat = v.battery != null ? v.battery < swapThreshold : null, rng = rangeUsable(v) && !(v.rangeDerived && v.battery != null) ? v.rangeKm < swapRangeOf(v, swapRangeKm) : null;
  if (bat == null && rng == null) return false;
  return (bat ?? true) && (rng ?? true);
}
const energyGap = (v, o) => v.battery != null ? 1 - v.battery / o.swapThreshold : 1 - v.rangeKm / swapRangeOf(v, o.swapRangeKm);
// Gesperrt wegen Akku (Audit 11.11.2026, MET-10/UXP-02): Voi und Bolt nehmen leere Fahrzeuge per is_disabled aus dem Verleih (Voi Stuttgart:
// alle 56 gesperrten mit 2–8 km, verfügbare ab 5 km, 1-%-Quantil 14 km). Die Betriebsgrenze der Quelle = 1-%-Quantil der Energie der
// verfügbaren Fahrzeuge (mind. 20 mit Angabe, gedeckelt auf 35 % bzw. 25 km); ein gesperrtes Fahrzeug darunter ist ein Tauschfall, kein Werkstattfall.
export const DISABLE_FLOOR = { minAvail: 20, q: 0.01, maxBattery: 35, maxRangeKm: 25 };
export function disableFloor(vehicles) {
  const ok = vehicles.filter(v => !v.disabled && !v.reserved), bat = ok.map(v => v.battery).filter(x => x != null && Number.isFinite(x));
  const rng = ok.filter(v => v.battery == null && rangeUsable(v)).map(v => v.rangeKm);
  const q = (a, cap) => (a.length >= DISABLE_FLOOR.minAvail ? Math.min(cap, quantile(a, DISABLE_FLOOR.q)) : null);
  return { battery: q(bat, DISABLE_FLOOR.maxBattery), rangeKm: q(rng, DISABLE_FLOOR.maxRangeKm) };
}
export function lockedForEnergy(v, floor) {
  if (!v?.disabled || !floor) return false;
  if (v.battery != null) return floor.battery != null && v.battery < floor.battery;
  return rangeUsable(v) && floor.rangeKm != null && v.rangeKm < floor.rangeKm;
}
export function planSwaps({ vehicles, model, depot, ...opts }) {
  const o = { ...DEFAULTS, ...opts }; o.swapCapacity = Math.max(1, Math.min(MAX_SWAP, o.swapCapacity));
  const cost = makeCost(o);
  const floor = disableFloor(vehicles);
  const low = vehicles.filter(v => needsSwap(v, o) || lockedForEnergy(v, floor)).map(v => ({ ...v, lockedLow: !!v.disabled }));
  const sphMax = Math.max(0.01, ...[...model.cells.values()].map(c => c.startsPerHour ?? 0));
  for (const v of low) {
    const d = (model.cells.get(cellOf(v.lat, v.lon))?.startsPerHour ?? 0) / sphMax;
    v.priority = +(0.6 * Math.max(0, energyGap(v, o)) + 0.4 * Math.min(1, d) + ((v.idleMin ?? 0) > 360 ? 0.05 : 0)).toFixed(3);
  }
  const chosen = low.sort((a, b) => b.priority - a.priority).slice(0, o.swapCapacity * o.maxRuns);
  // priority (Auswahl, wer überhaupt getauscht wird: Energie + Nachfrage am Ort) bleibt; die Reihenfolge nutzt prio (Energie + Standzeit, PRIO)
  const build = (g, quick) => {
    const stops = groupStops(g, () => 's', 25).map(s => ({ type: 'swap', lat: s.lat, lon: s.lon, count: s.count, battery: s.items.map(x => x.battery), priority: Math.max(...s.items.map(x => x.priority)), ...maxPrio(s.items.map(x => vehiclePrio('swap', x, o))) }));
    const sq = sequenceRun([stops], { depot, cost, lambda: o.prioLambda, quick });
    const r = seqSummary(sq, o);
    const handle = g.length * o.swapMin;
    return { kind: 'swap', vehicles: g.length, stops: sq.stops, ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin), { runs: groups, unplanned } = clusterRuns(chosen, o.swapCapacity, depot, o.maxRuns, undefined, cap.fit);
  const runs = groups.map((g, i) => ({ id: `S${i + 1}`, ...cap.built(g) }));
  return { below: low.length, locked: low.filter(v => v.lockedLow).length, floor, chosen: chosen.length, unplanned: unplanned.length + (low.length - chosen.length), limitMin: o.maxRunMin, runs };
}

/** Werkstatt: gesperrte Fahrzeuge einsammeln und zum Depot bringen. */
export function planWorkshop({ vehicles, depot, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const cost = makeCost(o);
  const floor = disableFloor(vehicles); // gesperrt wegen leerem Akku → Akkutausch (planSwaps), nicht Werkstatt
  const dis = vehicles.filter(v => v.disabled && !lockedForEnergy(v, floor)).sort((a, b) => (b.idleMin ?? 0) - (a.idleMin ?? 0));
  // Priorität = Sperrdauer (Standzeit seit der letzten Bewegung), ab 24 h Zuschlag
  const build = (g, quick) => {
    const stops = groupStops(g, () => 'w', 25).map(s => ({ type: 'pickup_disabled', lat: s.lat, lon: s.lon, count: s.count, idleMaxH: Math.round(Math.max(...s.items.map(x => x.idleMin ?? 0)) / 60), ...maxPrio(s.items.map(x => vehiclePrio('pickup_disabled', x, o))) }));
    const sq = sequenceRun([stops], { depot, cost, lambda: o.prioLambda, quick });
    const r = seqSummary(sq, o);
    const handle = g.length * o.workshopMin;
    return { kind: 'workshop', vehicles: g.length, stops: sq.stops, ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin), { runs: groups, unplanned } = clusterRuns(dis, o.workshopCapacity, depot, o.maxRuns, undefined, cap.fit);
  const runs = groups.map((g, i) => ({ id: `W${i + 1}`, ...cap.built(g) }));
  return { disabled: dis.length, lockedLow: vehicles.filter(v => lockedForEnergy(v, floor)).length, unplanned: unplanned.length, limitMin: o.maxRunMin, runs };
}

/**
 * Stationsausgleich (stationsbasiertes Bikesharing): fast leere Stationen aus fast vollen auffüllen.
 * Füllgrad = buchbar / Kapazität (Kapazität fehlt → buchbar + freie Plätze). Ziel ist `fill` (Standard 50 %).
 */
export function planStationBalance({ stations, depot, low = 0.2, high = 0.8, fill = 0.5, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const cost = makeCost(o);
  const list = stations.map(s => ({ ...s, cap: s.capacity ?? (s.docks != null && s.bookable != null ? s.docks + s.bookable : null) })).filter(s => s.cap > 0 && s.bookable != null);
  const deficits = [], givers = [];
  for (const s of list) {
    const rate = s.bookable / s.cap, target = Math.max(1, Math.round(s.cap * fill));
    if (rate <= low && s.renting !== false && s.returning !== false) deficits.push({ s, need: target - s.bookable });
    else if (rate >= high) givers.push({ s, give: s.bookable - target });
  }
  const moves = [];
  for (const d of deficits.sort((a, b) => b.need - a.need)) {
    for (let k = 0; k < d.need; k++) {
      let bi = -1, bd = Infinity; givers.forEach((g, i) => { if (g.give <= 0) return; const x = dist(g.s, d.s); if (x < bd) { bd = x; bi = i; } });
      if (bi < 0 || bd > o.maxPickupM) break;
      givers[bi].give--; moves.push({ lat: givers[bi].s.lat, lon: givers[bi].s.lon, from: givers[bi].s, to: d.s });
    }
  }
  const mids = moves.map(m => ({ lat: (m.lat + m.to.lat) / 2, lon: (m.lon + m.to.lon) / 2, m }));
  const spread = (x, c) => Math.max(dist(c, x.m), dist(c, x.m.to));
  // Priorität: Ausbringen nach Fehlmenge der Station (leer = Zuschlag), Abholen nur dringend, wenn die Station keinen freien Platz mehr hat
  const build = (run, quick) => {
    const g = run.map(x => x.m);
    const pickups = groupStops(g, m => m.from.name || '', 5).map(s => { const f = s.items[0].from, full = f.docks === 0 || f.bookable >= f.cap;
      return { type: 'pickup', lat: s.lat, lon: s.lon, count: s.count, station: f.name, fill: `${f.bookable}/${f.cap}`, prio: full ? PRIO.fullStation : 0, why: { fill: `${f.bookable}/${f.cap}`, full } }; });
    const drops = groupStops(g.map(m => ({ lat: m.to.lat, lon: m.to.lon, to: m.to })), x => x.to.name || '', 5).map(s => { const to = s.items[0].to, need = Math.max(0, Math.max(1, Math.round(to.cap * fill)) - to.bookable), dp = dropPrio(need, to.bookable);
      return { type: 'drop', lat: s.lat, lon: s.lon, count: s.count, station: to.name, fill: `${to.bookable}/${to.cap}`, prio: dp.prio, why: { ...dp.why, fill: `${to.bookable}/${to.cap}` } }; });
    const sq = sequenceRun([pickups, drops], { depot, cost, lambda: o.prioLambda, quick });
    const r = seqSummary(sq, o);
    const handle = g.length * (o.pickupMin + o.dropMin) * 0.6; // an Stationen schneller als frei abgestellt
    return { kind: 'station', vehicles: g.length, stops: sq.stops, ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin, spread), cl = clusterRuns(mids, o.vanCapacity, depot, o.maxRuns, undefined, cap.fit);
  const runs = cl.runs.map((g, i) => ({ id: `B${i + 1}`, ...cap.built(g) }));
  return { stations: list.length, empty: deficits.length, full: givers.length, moves: moves.length, missing: sum(deficits.map(d => d.need)) - moves.length, unplanned: cl.unplanned.length, limitMin: o.maxRunMin, runs };
}

/** Navigationslinks: Google Maps erlaubt bis zu 10 Punkte je Link (Start, 8 Zwischenziele, Ziel). */
export function mapsLinks(points) {
  const pts = points.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
  const links = [];
  for (let i = 0; i < pts.length - 1; i += 9) links.push('https://www.google.com/maps/dir/' + pts.slice(i, i + 10).join('/'));
  return links;
}

/** Kennzahlen der Flotte eines Anbieters in einer Gemeinde. */
export function fleetKpis(vehicles, { swapThreshold = DEFAULTS.swapThreshold, swapRangeKm = DEFAULTS.swapRangeKm } = {}) {
  const avail = vehicles.filter(isAvailable);
  const withBat = vehicles.filter(v => (v.battery != null || rangeUsable(v)) && !v.disabled);
  const idleKnown = avail.filter(v => v.idleMin != null), floor = disableFloor(vehicles), locked = vehicles.filter(v => lockedForEnergy(v, floor)).length;
  return {
    total: vehicles.length, available: avail.length, disabled: vehicles.filter(v => v.disabled).length, reserved: vehicles.filter(v => v.reserved).length,
    // low = Tauschfälle insgesamt: verfügbare unter der Schwelle + gesperrte unter der Betriebsgrenze der Quelle (lockedLow)
    low: withBat.filter(v => needsSwap(v, { swapThreshold, swapRangeKm })).length + locked, lockedLow: locked, batteryKnown: withBat.length,
    chargeKnown: withBat.filter(v => v.battery != null).length,
    idle24: idleKnown.filter(v => v.idleMin >= 1440).length, idle6: idleKnown.filter(v => v.idleMin >= 360).length, idleKnown: idleKnown.length,
    idleMedianH: idleKnown.length ? +(quantile(idleKnown.map(v => v.idleMin), 0.5) / 60).toFixed(1) : null,
  };
}

/** Exporte */
// CSV-Zelle mit Formel-Schutz: Text, der mit = + - @ Tab oder Wagenrücklauf beginnt, bekommt ein führendes ' (Tabellenprogramme
// führen ihn sonst als Formel aus); Trennzeichen, Anführungszeichen und Zeilenumbrüche werden gequotet. Zahlen bleiben Zahlen.
// S2.13: Semikolon = deutsche Datei → Dezimalkomma (auch Zahlentext wie „48.123456“ aus toFixed), sonst liest deutsches Excel „1.5“ als 1. Mai.
export function csvCell(v, sep = ';') {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return sep === ';' ? String(v).replace('.', ',') : String(v);
  let t = String(v);
  if (sep === ';' && /^-?\d+\.\d+$/.test(t)) return t.replace('.', ',');
  if (/^[=+\-@\t\r]/.test(t) && !/^[+-]?\d+([.,]\d+)?$/.test(t)) t = `'${t}`; // reine Zahl als Text (z. B. -0.123456) bleibt
  return t.includes(sep) || /["\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
const csvRows = (rows, sep = ';') => rows.map(r => r.map(x => csvCell(x, sep)).join(sep)).join('\n');
// Disposition-CSV je Sprache: Deutsch (Standard) mit Semikolon, Englisch (lang 'en') mit Komma und englischen Spaltennamen/Texten.
// Die Spots-CSV im Backend-Format (spotsCsv) ist sprachunabhängig.
const OPS_CSV_EN = { rang: 'rank', starts_je_h_anbieter: 'starts_per_h_operator', enden_je_h_anbieter: 'ends_per_h_operator', netto_abfluss_je_h_anbieter: 'net_outflow_per_h_operator',
  netto_abfluss_fehler_je_h: 'net_outflow_error_per_h', netto_abfluss_untergrenze_je_h: 'net_outflow_lower_bound_per_h', ausgleich_k: 'balance_k', bootstrap_anteil: 'bootstrap_share', starts_markt: 'starts_market', enden_markt: 'ends_market', messstunden: 'measured_hours', horizont_h: 'horizon_h', grundbestand: 'base_stock',
  abfluss_im_horizont: 'outflow_in_horizon', bedarf_rechnerisch: 'need_calculated', bedarf_fzg: 'need_veh', bestand_umkreis: 'fleet_nearby', fehlmenge: 'shortfall', stroeme_ab: 'flows_out', stroeme_an: 'flows_in',
  f_netto_abfluss: 'f_net_outflow', f_nachfrage: 'f_demand', f_oepnv: 'f_transit', f_abstellflaeche: 'f_parking', stabilitaet: 'stability', abstellflaeche: 'parking_area',
  tour: 'run', art: 'type', stopp: 'stop', typ: 'kind', anzahl: 'count', info: 'info', prioritaet: 'priority', prio_rang: 'priority_rank', grund: 'reason', stabil: 'stable', mittel: 'medium', unsicher: 'uncertain',
  anbieter: 'operator', lage: 'location', fahrzeuge_summe: 'vehicles_total', fahrzeuge_mittel: 'vehicles_mean', fahrzeugarten: 'vehicle_types', erstmals: 'first', zuletzt: 'last', arten: 'types', naechster_spot: 'nearest_spot', abstand_m: 'distance_m' };
const opsCsvText = (v, lang) => (lang === 'en' && typeof v === 'string' ? OPS_CSV_EN[v] ?? v : v);
const opsCsv = (rows, lang = 'de') => (lang === 'en' ? csvRows([rows[0].map(h => opsCsvText(h, lang)), ...rows.slice(1)], ',') : csvRows(rows));
export function spotsCsv(spots, { name = 'Spot', radius = 15 } = {}) {
  const head = ['name', 'lat', 'lng', 'deploymentStatus', 'parkingStatus', 'deploymentRadius', 'deploymentVehicles'];
  const rows = spots.map(s => [`${name} ${String(s.rank).padStart(2, '0')}`, s.lat.toFixed(6), s.lon.toFixed(6), 'enabled', 'disabled', radius, s.target]);
  return csvRows([head, ...rows], ',');
}
// needs: planRebalance(...).needs (Bestand im Umkreis und Fehlmenge je Spot); ohne needs bleiben die Spalten leer
// enden_je_h_anbieter und netto_abfluss_je_h_anbieter ausgeglichen (Enden × ausgleich_k, M-10); enden_markt = gezählte Enden;
// netto_abfluss_untergrenze_je_h = max(0, Abfluss − 2·Fehler) (Faktor der MCDA); bootstrap_anteil = Anteil der Ziehungen in den Top-N
export const SPOTS_ANALYSIS_FIELDS = ['rang', 'lat', 'lng', 'starts_je_h_anbieter', 'enden_je_h_anbieter', 'netto_abfluss_je_h_anbieter', 'netto_abfluss_fehler_je_h', 'netto_abfluss_untergrenze_je_h', 'ausgleich_k', 'starts_markt', 'enden_markt', 'messstunden',
  'horizont_h', 'grundbestand', 'abfluss_im_horizont', 'bedarf_rechnerisch', 'bedarf_fzg', 'bestand_umkreis', 'fehlmenge', 'stroeme_ab', 'stroeme_an',
  'score', 'f_netto_abfluss', 'f_nachfrage', 'f_oepnv', 'f_abstellflaeche', 'stabilitaet', 'bootstrap_anteil', 'abstellflaeche'];
export function spotsAnalysisCsv(spots, needs = null, { horizonH = DEFAULTS.horizonH, prelim = false, lang = 'de' } = {}) {
  const nb = new Map((needs || []).map(n => [n.cell, n]));
  const rows = spots.map(s => { const n = nb.get(s.cell); return [s.rank, s.lat.toFixed(6), s.lon.toFixed(6), s.startsPerHourOp, s.endsPerHourOp, s.outPerHourOp, s.outSeOp, s.outLowOp ?? null, s.balanceK ?? null, s.starts, s.ends, s.hours,
    horizonH, s.base, s.drain, s.needRaw, s.target, n?.have ?? null, n?.need ?? null, s.flow?.out ?? null, s.flow?.in ?? null,
    s.score, s.factors.outflow, s.factors.demand, s.factors.transit ?? null, s.factors.parking ?? null, prelim ? `${lang === 'en' ? 'preliminary' : 'vorläufig'} (${opsCsvText(s.stabilityLabel, lang)})` : opsCsvText(s.stabilityLabel, lang), s.bootShare ?? null, s.park ? `${s.park.cat}${s.park.name ? ' ' + s.park.name : ''}` : '']; });
  return opsCsv([SPOTS_ANALYSIS_FIELDS, ...rows], lang);
}
/** Grund eines Stopps als kurzer Text (wie die Stoppliste der Disposition): Akku/Reichweite, Standzeit, Fehlmenge, leer/voll */
export function stopReason(s, lang = 'de') {
  const w = s?.why || {}, en = lang === 'en', out = [];
  if (s.type === 'swap') { if (w.battery != null) out.push(en ? `battery ${w.battery} %` : `Akku ${w.battery} %`); else if (w.rangeKm != null) out.push(en ? `range ${w.rangeKm} km` : `Reichweite ${w.rangeKm} km`); }
  if (w.idleH != null && s.type !== 'drop' && !s.station) out.push(`${en ? 'idle' : 'steht'} ${idleClassText(w.idleH * 60, { en })}`);
  if (s.type === 'drop') { if (s.station) out.push(w.empty ? (en ? 'station empty' : 'Station leer') : (en ? `shortfall ${w.need}` : `Fehlmenge ${w.need}`)); else if (w.empty) out.push(en ? 'spot empty' : 'Spot leer'); else if (w.need) out.push(en ? `shortfall ${w.need}` : `Fehlmenge ${w.need}`); }
  if (s.type === 'pickup' && s.station && w.full) out.push(en ? 'station full' : 'Station voll');
  return out.join(', ');
}
/** Touren-CSV: je Stopp Reihenfolge, Typ, Lage, Anzahl, Info sowie Priorität (0–1+), Rang der Priorität in der Tour und Grund */
export function runsCsv(runs, depot, lang = 'de') {
  const head = ['tour', 'art', 'stopp', 'typ', 'lat', 'lng', 'anzahl', 'info', 'prioritaet', 'prio_rang', 'grund'];
  const rows = [];
  for (const r of runs) {
    rows.push([r.id, r.kind, 0, 'depot', depot.lat.toFixed(6), depot.lon.toFixed(6), '', `${r.km} km · ${r.totalMin} min`, '', '', '']);
    const en = lang === 'en';
    r.stops.forEach((s, i) => rows.push([r.id, r.kind, i + 1, s.type, s.lat.toFixed(6), s.lon.toFixed(6), s.count, s.type === 'drop' ? (en ? `Spot ${s.spotRank} (need ${s.target}${s.need != null ? `, fleet ${s.have}, shortfall ${s.need}` : ''})` : `Spot ${s.spotRank} (Bedarf ${s.target}${s.need != null ? `, Bestand ${s.have}, Fehlmenge ${s.need}` : ''})`) : s.battery?.length ? `${en ? 'Battery' : 'Akku'} ${s.battery.join('/')} %` : s.idleMaxH != null ? `${en ? 'idle' : 'steht'} ${idleClassText(s.idleMaxH * 60, { en })}` : '',
      s.prio ?? '', s.rank ?? '', stopReason(s, lang)]));
  }
  return opsCsv([head, ...rows], lang);
}

// ---------- Vermutete Deploy-Spots und Einsammel-Orte (Gruppen-Ereignisse aus groups/<JJJJ-MM>.json bzw. groups.json) ----------
// Ereignis: ≥ GROUP_MIN Fahrzeuge eines Anbieters tauchen in einem Lauf ≤ GROUP_M beieinander auf (deploy) bzw. verschwinden zusammen (collect).
// Orte je Anbieter und Art: ein Ereignis fällt in den Ort, dessen Mittelpunkt ≤ mergeM (60 m) entfernt ist (sonst neuer Ort); zeitlich sortiert,
// der Mittelpunkt ist das Mittel der zugeordneten Ereignisse. Gleiches Ereignis aus mehreren Dateien (at, Art, Anbieter, Ort) zählt einmal.
export const GROUP_MERGE_M = 60;
export function groupPlaces(docs, { ags, mergeM = GROUP_MERGE_M } = {}) {
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
export function filterPlaces(list, f = {}, labelOf = () => '') {
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
export function sortPlaces(list, key = 'count', dir = 'desc', { labelOf = () => '', nearOf = () => null } = {}) {
  const val = { lage: (p) => fold(labelOf(p) || `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`), op: (p) => fold(p.op), count: (p) => p.count, last: (p) => p.last, avg: (p) => p.avg, near: (p) => nearOf(p)?.d ?? Infinity }[key] || ((p) => p.count);
  const s = dir === 'asc' ? 1 : -1;
  return list.slice().sort((a, b) => { const x = val(a), y = val(b); const c = typeof x === 'string' ? x.localeCompare(y, 'de') : x - y; return s * c || b.count - a.count || b.last - a.last; });
}
const STAMP = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const PLACES_FIELDS = ['art', 'anbieter', 'lage', 'lat', 'lon', 'anzahl', 'fahrzeuge_summe', 'fahrzeuge_mittel', 'erstmals', 'zuletzt', 'fahrzeugarten', 'naechster_spot', 'abstand_m'];
export function placesCsv(list, { labelOf = () => '', nearOf = () => null, lang = 'de' } = {}) {
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
export { cellOf, cellCenter, CELL_LAT, CELL_LON };
