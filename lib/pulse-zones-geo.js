// Mobility Pulse – S6.1 Zonen-Werkbank: Geometrie-Helfer und Prüfung der Upload-Datei (wie der Validator des Backends sie sieht).
// Rechnen in einer örtlichen ebenen Projektion (Meter); Polygone als GeoJSON-Koordinaten [lon, lat]. Mengenoperationen (Vereinigung,
// Schnitt) macht polygon-clipping (MIT, nur im Browser und in Tests gebündelt – der Sammler braucht diese Datei nicht).
export const M_PER_DEG = 111320;
/** Projektion um lat0: [lon, lat] → [x, y] in Metern */
export const projector = (lat0) => { const kx = M_PER_DEG * Math.cos(lat0 * Math.PI / 180); return ([lon, lat]) => [lon * kx, lat * M_PER_DEG]; };
export const polysOf = (g) => (!g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
/** vorzeichenbehaftete Fläche eines Rings (Grad², > 0 = gegen den Uhrzeigersinn) */
export const ringSigned = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; };
/** Fläche in m² (Polygon/MultiPolygon oder Koordinaten eines Polygons), Löcher abgezogen */
export function areaM2(g, lat0 = null) {
  const ps = Array.isArray(g) ? [g] : polysOf(g); if (!ps.length) return 0;
  const la = lat0 ?? ps[0][0][0][1], k = M_PER_DEG * M_PER_DEG * Math.cos(la * Math.PI / 180);
  // größter Ring = Außenring (manche Feeds liefern die Ringe in anderer Reihenfolge), die übrigen Löcher
  let s = 0; for (const p of ps) { if (!p?.[0]?.length) continue; const a = p.map(r => Math.abs(ringSigned(r))), mx = Math.max(...a); s += mx - (a.reduce((x, y) => x + y, 0) - mx); }
  return s * k;
}
/** Begrenzungsrechteck [minLon, minLat, maxLon, maxLat] */
export function bboxOf(g) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of Array.isArray(g) ? [g] : polysOf(g)) for (const r of p) for (const [x, y] of r) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
  return b;
}
export const boxHit = (a, b, padDeg = 0) => a[0] <= b[2] + padDeg && b[0] <= a[2] + padDeg && a[1] <= b[3] + padDeg && b[1] <= a[3] + padDeg;
function ringIn(r, x, y) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
/** Punkt [lon, lat] in Polygon/MultiPolygon (Löcher ausgenommen) */
export const contains = (g, lon, lat) => (Array.isArray(g) ? [g] : polysOf(g)).some(p => ringIn(p[0], lon, lat) && !p.slice(1).some(h => ringIn(h, lon, lat)));
// Abstand Punkt–Strecke in der Ebene
function segDist(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy; let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t)); const qx = ax + t * dx - px, qy = ay + t * dy - py; return Math.sqrt(qx * qx + qy * qy); }
/** kleinster Abstand zweier Polygone (Ränder) in Metern; nur Stützpunkte und Strecken im Umkreis maxM des anderen Rechtecks. Rückgabe { d, at: [lon, lat] } */
export function edgeDist(ga, gb, maxM = 5) {
  const ba = bboxOf(ga), bb = bboxOf(gb), P = projector((ba[1] + ba[3]) / 2), pad = maxM / M_PER_DEG * 2;
  const rings = (g) => (Array.isArray(g) ? [g] : polysOf(g)).flat();
  const near = (p, b) => p[0] >= b[0] - pad && p[0] <= b[2] + pad && p[1] >= b[1] - pad && p[1] <= b[3] + pad;
  const segNear = (a, c, b) => Math.max(a[0], c[0]) >= b[0] - pad && Math.min(a[0], c[0]) <= b[2] + pad && Math.max(a[1], c[1]) >= b[1] - pad && Math.min(a[1], c[1]) <= b[3] + pad;
  let best = { d: Infinity, at: null };
  const one = (A, B, bA, bB) => { // Stützpunkte von A nahe bB gegen Strecken von B nahe bA
    const segs = []; for (const r of rings(B)) for (let i = 1; i < r.length; i++) if (segNear(r[i - 1], r[i], bA)) segs.push([P(r[i - 1]), P(r[i])]);
    if (!segs.length) return;
    for (const r of rings(A)) for (const v of r) { if (!near(v, bB)) continue; const [x, y] = P(v); for (const [[ax, ay], [bx, by]] of segs) { const d = segDist(x, y, ax, ay, bx, by); if (d < best.d) best = { d, at: v }; } }
  };
  one(ga, gb, ba, bb); one(gb, ga, bb, ba);
  return best;
}
// Strecken schneiden sich (auch Berühren); o = Orientierung
const orient = (a, b, c) => { const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); return Math.abs(v) < 1e-18 ? 0 : v > 0 ? 1 : -1; };
const onSeg = (a, b, c) => Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
export function segCross(p1, p2, p3, p4) {
  const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4), o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSeg(p1, p2, p3)) || (o2 === 0 && onSeg(p1, p2, p4)) || (o3 === 0 && onSeg(p3, p4, p1)) || (o4 === 0 && onSeg(p3, p4, p2));
}
/** Selbstüberschneidung eines Polygons (Ringe einzeln und untereinander), Raster über die Strecken */
export function selfIntersects(poly) {
  const segs = []; poly.forEach((r, ri) => { for (let i = 1; i < r.length; i++) segs.push({ a: r[i - 1], b: r[i], ri, i, n: r.length - 1 }); });
  if (segs.length < 4) return false;
  const bb = bboxOf(poly), cells = Math.max(1, Math.ceil(Math.sqrt(segs.length / 4))), cw = (bb[2] - bb[0]) / cells || 1, ch = (bb[3] - bb[1]) / cells || 1, grid = new Map();
  const keys = (s) => { const out = []; const x0 = Math.floor((Math.min(s.a[0], s.b[0]) - bb[0]) / cw), x1 = Math.floor((Math.max(s.a[0], s.b[0]) - bb[0]) / cw), y0 = Math.floor((Math.min(s.a[1], s.b[1]) - bb[1]) / ch), y1 = Math.floor((Math.max(s.a[1], s.b[1]) - bb[1]) / ch); for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x}:${y}`); return out; };
  segs.forEach((s, k) => { for (const q of keys(s)) { const l = grid.get(q); if (l) l.push(k); else grid.set(q, [k]); } });
  const seen = new Set();
  for (const l of grid.values()) for (let u = 0; u < l.length; u++) for (let v = u + 1; v < l.length; v++) {
    const A = segs[l[u]], B = segs[l[v]], key = l[u] * segs.length + l[v]; if (seen.has(key)) continue; seen.add(key);
    if (A.ri === B.ri && (Math.abs(A.i - B.i) === 1 || Math.abs(A.i - B.i) === A.n - 1)) continue; // Nachbarn im Ring teilen einen Punkt
    if (segCross(A.a, A.b, B.a, B.b)) return true;
  }
  return false;
}
/** Polygone berühren oder überlappen sich (Ränder kreuzen oder einer enthält einen Punkt des anderen) */
export function touches(pa, pb) {
  if (!boxHit(bboxOf(pa), bboxOf(pb))) return false;
  if (contains(pb, pa[0][0][0], pa[0][0][1]) || contains(pa, pb[0][0][0], pb[0][0][1])) return true;
  const bbB = bboxOf(pb);
  for (const r of pa) for (let i = 1; i < r.length; i++) { const a = r[i - 1], b = r[i]; if (Math.max(a[0], b[0]) < bbB[0] || Math.min(a[0], b[0]) > bbB[2] || Math.max(a[1], b[1]) < bbB[1] || Math.min(a[1], b[1]) > bbB[3]) continue;
    for (const s of pb) for (let j = 1; j < s.length; j++) if (segCross(a, b, s[j - 1], s[j])) return true; }
  return false;
}

// ---------- Upload-Datei des Backends ----------
// Positivliste der Felder, Hülle, Grenzen: wie pruef_upload.py (Betriebsgebiet-Werkzeug, Stand 21.09.2026). Ein Feld außerhalb der Liste lässt
// den Validator die ganze Datei ablehnen; Innenringe zeichnet das Portal als Fächer (hier Fehler, außer holesOk).
export const UPLOAD = Object.freeze({ fields: ['id', 'name', 'features', 'is', 'parentSubregionId', 'schedule'], hull: ['timestampMs', 'timestampFormatted', 'type', 'features'], maxZones: 3000, maxPoints: 80000, gapM: 0.01 });
/**
 * Prüft eine Upload-Datei. Rückgabe { ok, errors: [Text], stats: { zones, points, children, named, byKind } }.
 * Geprüft: Hülle, Positivliste, IDs (20 Zeichen [0-9A-Za-z], eindeutig), Grenzen (Zonen, Stützpunkte ohne Schlusspunkt), parentSubregionId
 * (Ziel in der Datei, Eltern vor Kindern), nur Polygone, Außenring gegen den Uhrzeigersinn, Ringe geschlossen, keine doppelten Stützpunkte,
 * keine Selbstüberschneidung, keine Innenringe, nicht verwandte Zonen ohne Berührung und mit mindestens gapM Abstand, Namen.
 */
export function validateUpload(doc, { holesOk = false } = {}) {
  const errors = [], E = (m) => errors.push(m);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.features)) return { ok: false, errors: ['keine FeatureCollection mit features'], stats: null };
  const hull = Object.keys(doc).filter(k => !UPLOAD.hull.includes(k)); if (hull.length) E(`Hülle: unbekannte Felder ${hull.join(', ')}`);
  if (doc.type !== 'FeatureCollection') E('Hülle: type ist nicht FeatureCollection');
  const F = doc.features, P = F.map(f => f?.properties || {}), ids = P.map(p => p.id), cnt = new Map(); ids.forEach(i => cnt.set(i, (cnt.get(i) || 0) + 1));
  const dup = [...cnt].filter(([, n]) => n > 1).map(([i]) => i); if (dup.length) E(`doppelte IDs: ${dup.slice(0, 5).join(', ')}`);
  if (ids.some(i => !/^[0-9A-Za-z]{20}$/.test(String(i)))) E('IDs nicht im Format [0-9A-Za-z]{20}');
  const extra = [...new Set(P.flatMap(p => Object.keys(p)))].filter(k => !UPLOAD.fields.includes(k)); if (extra.length) E(`Felder außerhalb der Positivliste: ${extra.join(', ')}`);
  const polys = F.map(f => (f?.geometry?.type === 'Polygon' ? f.geometry.coordinates : null));
  const nonPoly = polys.filter(p => !p).length; if (nonPoly) E(`${nonPoly} Nicht-Polygone`);
  const points = polys.reduce((s, p) => s + (p ? p.reduce((a, r) => a + r.length - 1, 0) : 0), 0);
  if (F.length > UPLOAD.maxZones) E(`${F.length} Zonen > ${UPLOAD.maxZones}`); if (points > UPLOAD.maxPoints) E(`${points} Stützpunkte > ${UPLOAD.maxPoints}`);
  const pos = new Map(ids.map((i, k) => [i, k]));
  const dead = P.filter(p => p.parentSubregionId && !pos.has(p.parentSubregionId)).length; if (dead) E(`${dead} parentSubregionId ohne Zielzone in der Datei`);
  const before = P.filter((p, k) => p.parentSubregionId && pos.has(p.parentSubregionId) && pos.get(p.parentSubregionId) > k).length; if (before) E(`${before} Kind-Zonen stehen vor ihrer Elternzone`);
  let cw = 0, open = 0, dupPt = 0, bad = 0, holes = 0, short = 0;
  polys.forEach(p => { if (!p) return;
    if (ringSigned(p[0]) <= 0) cw++;
    for (const r of p) { if (r.length < 4) short++; const a = r[0], b = r[r.length - 1]; if (!a || !b || a[0] !== b[0] || a[1] !== b[1]) open++; for (let i = 1; i < r.length; i++) if (r[i][0] === r[i - 1][0] && r[i][1] === r[i - 1][1]) { dupPt++; break; } }
    holes += p.length - 1; if (selfIntersects(p)) bad++; });
  if (cw) E(`${cw} Außenringe im Uhrzeigersinn`); if (open) E(`${open} Ringe nicht geschlossen`); if (short) E(`${short} Ringe mit weniger als 4 Punkten`);
  if (dupPt) E(`${dupPt} Zonen mit doppelten Stützpunkten`); if (bad) E(`${bad} Zonen mit Selbstüberschneidung`); if (holes && !holesOk) E(`${holes} Innenringe – das Portal zeichnet sie als Fächer`);
  // Verwandtschaft (Eltern/Kind) darf überlappen; sonst weder Berührung noch Abstand unter gapM
  const anc = (k) => { const out = new Set(); let p = P[k]; while (p?.parentSubregionId && pos.has(p.parentSubregionId) && !out.has(p.parentSubregionId)) { out.add(p.parentSubregionId); p = P[pos.get(p.parentSubregionId)]; } return out; };
  const A = P.map((_, k) => anc(k)), B = polys.map(p => (p ? bboxOf(p) : null)), order = polys.map((_, k) => k).filter(k => polys[k]).sort((x, y) => B[x][0] - B[y][0]);
  let touch = 0, tight = 0; const pad = UPLOAD.gapM / M_PER_DEG * 2;
  for (let u = 0; u < order.length; u++) { const i = order[u]; for (let v = u + 1; v < order.length; v++) { const j = order[v]; if (B[j][0] > B[i][2] + pad) break; if (!boxHit(B[i], B[j], pad)) continue;
    if (A[i].has(ids[j]) || A[j].has(ids[i])) continue;
    if (touches(polys[i], polys[j])) touch++; else if (edgeDist(polys[i], polys[j], 0.05).d < UPLOAD.gapM * 0.999) tight++; } }
  if (touch) E(`${touch} Paare nicht verwandter Zonen berühren oder überlappen sich`); if (tight) E(`${tight} Paare näher als ${UPLOAD.gapM * 100} cm`);
  const named = P.filter(p => p.name).length; if (F.length && named < 0.5 * F.length) E(`nur ${named} von ${F.length} Zonen mit Namen`);
  const byKind = {}; for (const p of P) { const k = kindOfFlags(p); byKind[k] = (byKind[k] || 0) + 1; }
  return { ok: !errors.length, errors, stats: { zones: F.length, points, children: P.filter(p => p.parentSubregionId).length, named, byKind } };
}
/** Zonenart einer Upload-Zone aus den Flags (scooter) */
export function kindOfFlags(p) {
  const s = p?.features?.scooter || Object.values(p?.features || {})[0] || {};
  return s.isRidingForbidden ? 'no_ride' : s.mustParkInParkingLocation ? 'mandatory' : s.isParkingForbidden ? 'no_park' : s.isDesignatedParking ? 'designated' : 'allowed';
}
/** 20 Zeichen [0-9A-Za-z], deterministisch aus einem Schlüssel (gleiche Zone → gleiche ID beim nächsten Export) */
export function id20(key) {
  const AL = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; let out = '', h1 = 0x811c9dc5, h2 = 0x01000193 ^ key.length;
  for (let r = 0; out.length < 20; r++) { for (let i = 0; i < key.length; i++) { const c = key.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ (c + r), 0x5bd1e995) >>> 0; } h1 = (h1 ^ (h2 >>> 13)) >>> 0; out += AL[h1 % 62] + AL[h2 % 62]; }
  return out.slice(0, 20);
}
