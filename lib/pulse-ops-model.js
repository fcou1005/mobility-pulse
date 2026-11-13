// @ts-check
// Mobility Pulse — Disposition – Gewichtung (AHP), Geometrie, Umgebung, Flotte, Nachfragemodell, Deploy-Spots und Bootstrap (aus pulse-ops.js geschnitten; pulse-ops.js bleibt die Fassade für alle Importe).
import { haversineM } from './pulse-core.js';
import { BANDS, cellCenter, FLOW_FIELDS } from './pulse-track.js';

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
// Standzeit-Klassen (IDLE_CLASS, idleClassMin, idleClassText): lib/pulse-idle.js, oben importiert und weiter exportiert
/** Veröffentlichte Reichweite: ganze km (feine Werte helfen, ein Fahrzeug am neuen Ort wiederzuerkennen); Quellen mit eigener Reichweiten-Skala
 *  (rangeLimitKm, Schwelle aus dem 95. Perzentil) behalten 0,1 km, sonst stimmte ihre Akkutausch-Schwelle nicht mehr */
export const rangePublic = (v) => (v?.rangeKm == null || !Number.isFinite(+v.rangeKm) ? null : v.rangeLimitKm != null ? +(+v.rangeKm).toFixed(1) : Math.round(+v.rangeKm));
// Regler „Priorität ↔ Strecke“: Stufe → λ (0 = nur Kilometer). Standard Stufe 2 = λ 1: ein Meter, den die dringenden Stopps im Mittel
// früher erreicht werden, ist einen Meter Umweg wert. Stufe 4 (λ 4) kommt der reinen Prioritätsfolge nahe, ohne Zickzack.
export const PRIO_LEVELS = [0, 0.5, 1, 2, 4];
export const PRIO_LEVEL_DEFAULT = 2;

export const sum = (a) => a.reduce((x, y) => x + y, 0);
export const quantile = (arr, q) => { const v = arr.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const i = Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1)))); return v[i]; };
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
export function boxed(geoms) {
  return (geoms || []).map(g => { const b = [Infinity, Infinity, -Infinity, -Infinity]; const walk = (c) => { if (typeof c[0] === 'number') { if (c[0] < b[0]) b[0] = c[0]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[1] > b[3]) b[3] = c[1]; } else c.forEach(walk); }; walk(g.coordinates || []); return { g, b }; });
}
const boxedContains = (list, lat, lon) => list.some(({ g, b }) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && geomContains(g, lat, lon));
// Rasterindex für Punktmengen (≈ 330 m Zellen): Nachbarn in maxM, ohne jeden Punkt zu prüfen
const GRID_LAT = 0.003, GRID_LON = 0.005;
export function gridIndex(points) {
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
    if (!f) continue; // Zonen-Ausschnitt (ops-input/zones): Features außerhalb des Rahmens sind null
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
  const bands = /** @type {number[]} */ (band === 'day' ? BANDS.map(b => b.id) : [band]);
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
  const o = /** @type {any} */ ({ ...DEFAULTS, ...opts });
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
  const o = /** @type {any} */ ({ ...DEFAULTS, ...ctx });
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
