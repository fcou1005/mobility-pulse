// S3.8 Daten nach Gebiet: kleinere Dateien neben den bisherigen (die laufen zwei Wochen parallel weiter), damit eine Ansicht für eine
// Gemeinde nicht die Daten ganz Deutschlands lädt. Reine Funktionen – der Sammler schreibt, die Seite liest, die Tests prüfen.
//   events/<Tag>/<Land>.json    Ereignisse des Tages nur mit Gruppen des Landes (Kopf wie events/<Tag>.json)
//   events/hour-totals.json     je Tag Läufe und Fahrtbeginne je Stunde über alle Gruppen (Tagesgang-Profil ohne 14 Tagesdateien)
//   events/daily-summary.json   Tagessummen je Gruppe (Gemeinde|Anbieter|Art) für Übersichten
//   ops-input/<AGS>.json        Disposition: Zellen der letzten 7 Tage und Begrenzungsrahmen der Gemeinde
//   ops-input/fleet/<AGS>.json  Disposition: Bestand der Gemeinde im Format von ops/<Land>.json (+ Stationen bis 1,5 km um den Rahmen)
import { startsOf, planFor } from './pulse-econ.js';

export const SPLIT_VERSION = 1;
export const SUMMARY_FIELDS = ['start', 'end', 'reloc', 'swap', 'vmin'];
export const OPS_INPUT_DAYS = 7; // Zellen-Tage der Voreinstellung der Disposition (1, 3, 7 aus der Datei; 14 Tage weiter aus den Landesdateien)

const r2 = (x) => Math.round(x * 100) / 100;

/** Ereignisdatei nach Land teilen. stateOf(ags) → 'BW' …; unbekannte Gemeinden unter 'XX'. Kopf (runs, hourMin, published …) bleibt gleich. */
export function eventsByState(doc, stateOf) {
  const { groups = {}, ...head } = doc || {};
  const out = new Map();
  for (const [k, g] of Object.entries(groups)) {
    const st = stateOf(k.slice(0, k.indexOf('|'))) || 'XX';
    if (!out.has(st)) out.set(st, { ...head, state: st, groups: {} });
    out.get(st).groups[k] = g;
  }
  return out;
}

/**
 * Tageswerte für das Tagesgang-Profil (lib/pulse-econ.js hourProfile): Läufe und Σ Fahrtbeginne je Stunde über alle Gruppen in derselben
 * Reihenfolge wie hourProfile summiert – aus totalsDoc() gebaute Ersatz-Tagesdateien ergeben dasselbe Profil wie die vollen Dateien.
 */
export function hourTotals(doc) {
  const startsH = new Array(24).fill(0);
  for (const g of Object.values(doc?.groups || {})) { const st = startsOf(doc, g); for (let h = 0; h < 24; h++) startsH[h] += st?.[h] || 0; }
  return { runs: doc?.runs || [], gapHours: doc?.gapHours || [], startsH };
}
/** Ersatz-Tagesdatei für hourProfile aus hourTotals (eine Gruppe mit allen Fahrtbeginnen) */
export const totalsDoc = (day, t) => ({ day, runs: t.runs, gapHours: t.gapHours, groups: { '*': { start: t.startsH } } });

/** Tagessummen je Gruppe für eine Tagesdatei: { key: [Σ start, Σ end, Σ reloc, Σ swap, Σ vmin] } */
export function groupDaySums(doc, fields = SUMMARY_FIELDS) {
  const out = {};
  for (const [k, g] of Object.entries(doc?.groups || {})) out[k] = fields.map(f => (Array.isArray(g[f]) ? r2(g[f].reduce((a, x) => a + (x || 0), 0)) : Number.isFinite(g[f]) ? g[f] : null));
  return out;
}
/** Zusammenfassung über Tage aus { day: groupDaySums } → { days, fields, groups: { key: [je Tag Summen oder null] } } */
export function dailySummary(byDay, fields = SUMMARY_FIELDS) {
  const days = Object.keys(byDay).sort(), groups = {};
  days.forEach((d, i) => { for (const [k, v] of Object.entries(byDay[d] || {})) (groups[k] ||= new Array(days.length).fill(null))[i] = v; });
  return { days, fields, groups };
}

/**
 * Bestand einer Gemeinde aus ops/<Land>.json: gleiche Kopfzeilen, Fahrzeuge der Gemeinde (Feld gemeinde = Index in munis) und Stationen
 * der Gemeinde; mit bbox zusätzlich Stationen anderer Gemeinden bis marginM um den Rahmen (die Einsammelliste sucht Stationen bis 1 km um ein
 * Fahrzeug, lib/pulse-ops.js COLLECT.stationSearchM). null ohne Fahrzeuge und Stationen der Gemeinde.
 */
export function opsSlice(opsDoc, ags, { bbox = null, marginM = 1500 } = {}) {
  const mi = (opsDoc?.munis || []).indexOf(ags); if (mi < 0) return null;
  const vehicles = (opsDoc.vehicles || []).filter(r => r[8] === mi), own = (opsDoc.stations || []).filter(r => r[7] === mi);
  if (!vehicles.length && !own.length) return null;
  /** @type {(r: any[]) => boolean} */
  let near = (_r) => false;
  if (bbox) { const dLat = marginM / 111320, dLon = marginM / (111320 * Math.cos(((bbox[1] + bbox[3]) / 2) * Math.PI / 180)); near = (r) => r[0] >= bbox[1] - dLat && r[0] <= bbox[3] + dLat && r[1] >= bbox[0] - dLon && r[1] <= bbox[2] + dLon; }
  const stations = (opsDoc.stations || []).filter(r => r[7] === mi || near(r));
  // Anbieter- und Gemeindelisten auf die vorkommenden kürzen (Zeilen verweisen per Index darauf)
  const ops = [], munis = [], oi = new Map(), mm = new Map();
  const map = (m, arr, list, i) => { if (!m.has(i)) { m.set(i, arr.length); arr.push(list[i]); } return m.get(i); };
  const veh = vehicles.map(r => { const x = r.slice(); x[2] = map(oi, ops, opsDoc.ops, r[2]); x[8] = map(mm, munis, opsDoc.munis, r[8]); return x; });
  const sta = stations.map(r => { const x = r.slice(); x[2] = map(oi, ops, opsDoc.ops, r[2]); x[7] = map(mm, munis, opsDoc.munis, r[7]); return x; });
  const { vehicles: _v, stations: _s, ops: _o, munis: _m, ...head } = opsDoc;
  return { ...head, ags, ops, munis, vehicles: veh, stations: sta };
}
/**
 * Zellen einer Gemeinde aus Landesdateien cells/<Tag>/<Land>.json, je übergebenem Tag ein Eintrag – auch ohne Zellen der Gemeinde
 * (munis leer): ein Tag ohne Fahrten zählt mit seinen Beobachtungsstunden, wie im Nachfragemodell aus den Landesdateien.
 */
export function cellsSlice(cellDocs, ags) {
  const out = [];
  for (const d of cellDocs || []) {
    if (!d) continue;
    const { munis, below, ...head } = d;
    out.push({ ...head, munis: munis?.[ags] ? { [ags]: munis[ags] } : {}, below: below?.[ags] ? { [ags]: below[ags] } : {} });
  }
  return out;
}

// ---------- S3.8 Rest: Disposition unter 0,4 MB (zusätzliche Dateien, die bisherigen bleiben) ----------
//   ops-input/cells/<AGS>.json  Zellen wie ops-input/<AGS>.json, spaltenweise (cellsCompact), dazu die Start-Ziel-Ströme der Gemeinde
//   ops-input/area/<AGS>.json   je Lauf: Umsatz-Eingabe (econSlice), Gruppen-Ereignisse der Gemeinde, Zonen-Dateien je Anbieter
//   ops-input/zones/<AGS>/<n>.json  Zonen eines Anbieters, Features außerhalb des Rahmens als null (Index und Anzahl bleiben)
//   latest-core.json            latest.json ohne sources und groups (Start der Disposition; die übrigen Ansichten laden latest.json)
export const COMPACT_VERSION = 1, AREA_VERSION = 1;
export const CELL_N = 22, CELL_DROP = Object.freeze([1, 2]); // Tagessummen end, present: buildDemandModel liest nur 0, 3 und 4–21
// S6.3: Zellen mit Angebotsfeldern (Läufe mit Angebot je Band, 22–27) haben 28 Werte; cols.n trägt die Länge, wenn sie nicht CELL_N ist
export const CELL_NS = Object.freeze([CELL_N, CELL_N + 6]);
// Ausschnitt-Rahmen der Zonen: Gemeinderahmen ± ZONE_PAD_DEG (web/ops.js computePlan fragt Abstellverbote im Rahmen ± 0,02° ab) + ZONE_MARGIN_M;
// die Seite prüft vor der Nutzung, dass der abgefragte Rahmen und die Fahrzeuge (+ Puffer der Einsammelliste) im Ausschnitt (cover) liegen
export const ZONE_PAD_DEG = 0.02, ZONE_MARGIN_M = 200;
/** Rahmen, für den ein Zonen-Ausschnitt der Gemeinde vollständig ist */
export const zoneCover = (bbox) => growBox([bbox[0] - ZONE_PAD_DEG, bbox[1] - ZONE_PAD_DEG, bbox[2] + ZONE_PAD_DEG, bbox[3] + ZONE_PAD_DEG], ZONE_MARGIN_M);
/** Rahmen a liegt ganz in b */
export const boxInside = (a, b) => !!a && !!b && a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
const DROP = new Set(CELL_DROP);

/** Zellen (cellsSlice) spaltenweise: Zellschlüssel x:y in Originalreihenfolge als Differenzen, je Feld eine Liste ohne CELL_DROP. */
export function cellsCompact(slices, ags) {
  return (slices || []).map(d => {
    const { munis, ...head } = d, m = munis?.[ags];
    if (!m) return { ...head, munis: {} };
    const keys = Object.keys(m), N = keys.length ? m[keys[0]]?.length : CELL_N;
    const ok = CELL_NS.includes(N) && keys.every(k => { const i = k.indexOf(':'); return Array.isArray(m[k]) && m[k].length === N && `${+k.slice(0, i)}:${+k.slice(i + 1)}` === k; });
    if (!ok) return { ...head, munis: { [ags]: m } }; // anderes Format: unverändert
    const x = [], y = [], v = [];
    for (let j = 0; j < N; j++) if (!DROP.has(j)) v.push([]);
    let px = 0, py = 0;
    for (const k of keys) {
      const i = k.indexOf(':'), a = +k.slice(0, i), b = +k.slice(i + 1); x.push(a - px); y.push(b - py); px = a; py = b;
      let c = 0; for (let j = 0; j < N; j++) if (!DROP.has(j)) v[c++].push(m[k][j]);
    }
    return { ...head, cols: { ags, drop: CELL_DROP, ...(N !== CELL_N ? { n: N } : {}), x, y, v } };
  });
}
/** Umkehrung von cellsCompact: Tagesdokumente wie cellsSlice (CELL_DROP-Felder null) */
export function cellsExpand(docs) {
  return (docs || []).map(d => {
    if (!d?.cols) return d;
    const { cols, ...head } = d, drop = new Set(cols.drop || []), m = {}, N = cols.n || CELL_N;
    let px = 0, py = 0;
    for (let n = 0; n < cols.x.length; n++) {
      px += cols.x[n]; py += cols.y[n];
      const row = new Array(N); let c = 0;
      for (let j = 0; j < N; j++) row[j] = drop.has(j) ? null : cols.v[c++][n];
      m[`${px}:${py}`] = row;
    }
    return { ...head, munis: { [cols.ags]: m } };
  });
}
/** Start-Ziel-Ströme (flows/<Tag>.json) nur der Gemeinde; Tage ohne Eintrag der Gemeinde entfallen (attachFlows überspringt sie ohnehin) */
export function flowsSlice(flowDocs, ags) {
  const out = [];
  for (const d of flowDocs || []) {
    const mu = d?.munis?.[ags]; if (!mu) continue;
    const gi = (d.fields || []).indexOf('gemeinde');
    out.push({ day: d.day, fields: d.fields, munis: { [ags]: mu }, flows: (d.flows || []).filter(r => r[gi < 0 ? 0 : gi] === ags) });
  }
  return out;
}

/** Kandidaten der Vorauswahl „letzter voller Messtag“ (web/app-usage.js defaultUsageDay): jüngste 7 Tage ohne den laufenden, neueste zuerst */
export const usageDayCandidates = (days, runDay) => (days || []).slice(-7).filter(d => d !== runDay).reverse();
/** Vorauswahl synchron (Sammler): full(doc) = R.hourQuality(doc.runs, doc.gapHours).full */
export function pickUsageDay(days, runDay, docOf, full) {
  const cand = usageDayCandidates(days, runDay);
  for (const d of cand) { const doc = docOf(d); if (doc && full(doc)) return d; }
  return cand[0] || days[days.length - 1] || null;
}
const byPrefix = (o, pre) => { if (!o) return o ?? null; const out = {}; for (const [k, v] of Object.entries(o)) if (k.startsWith(pre)) out[k] = v; return out; };
/**
 * Eingabe der Umsatz-Kachel der Disposition (web/app-usage.js econGroups) für eine Gemeinde: Ereignisse des Vorauswahl-Tages (Kopf + Gruppen der
 * Gemeinde), Tageswerte (history/daily.json, Reihen der Gemeinde), Kalibrierung (kinds der Gemeinde; assume, limits, k in econCalib), Tarif je
 * Anbieter|Art und Sprache vorab (planFor mit assume[Art] wie im Browser) und latest.groups der Gruppen (Ersatz-Bestand).
 * null ohne Gruppen der Gemeinde oder ohne gültige Kalibrierung (dann rechnet die Seite wie bisher aus den großen Dateien).
 */
export function econSlice({ ags, day, doc, daily, pricing, calib, latestGroups }) {
  const pre = `${ags}|`;
  if (!day || !doc || calib?.version !== 1 || !calib.langs) return null;
  const { groups = {}, srcModes: _s, ...head } = doc, g = byPrefix(groups, pre), keys = Object.keys(g);
  if (!keys.length) return null;
  const plans = {};
  for (const [l, c] of Object.entries(calib.langs)) {
    const pl = (plans[l] = {}), assume = c?.assume || null;
    for (const k of keys) { const [, op, ty] = k.split('|'), pk = `${op}|${ty}`; if (!(pk in pl)) pl[pk] = planFor(pricing, op, ags, ty, assume?.[ty] || undefined); }
  }
  const lg = {}; for (const k of keys) if (latestGroups?.[k]) lg[k] = latestGroups[k];
  return {
    day, events: { ...head, groups: g },
    daily: daily?.series ? { days: daily.days, fields: daily.fields, dayRuns: daily.dayRuns ?? null, series: byPrefix(daily.series, pre) } : null,
    calib: { at: calib.at, kinds: byPrefix(calib.kinds, pre) }, plans, pricingAt: pricing?.at ?? null, latestGroups: lg,
  };
}
/** Gemeinsamer Teil der Kalibrierung für alle Gemeinden (ops-input/area/calib.json): je Sprache assume, limits, k */
export function econCalib(calib) {
  if (calib?.version !== 1 || !calib.langs) return null;
  const langs = {}; for (const [l, c] of Object.entries(calib.langs)) langs[l] = { assume: c?.assume ?? null, limits: c?.limits ?? null, k: c?.k ?? null };
  return { version: calib.version, at: calib.at, langs };
}
/** Gruppen-Ereignisse (groups/<Monat>.json) einer Gemeinde über alle Monate, Reihenfolge wie in den Monatsdateien */
export function groupsSlice(monthDocs, months, ags) {
  const fields = monthDocs.find(d => d?.fields)?.fields || null; if (!fields) return null;
  const gi = fields.indexOf('gemeinde'), events = [];
  for (const d of monthDocs) { if (!d || JSON.stringify(d.fields) !== JSON.stringify(fields)) return null; for (const e of d.events || []) if (e[gi] === ags) events.push(e); }
  return { months, fields, events };
}
const geomBox = (g) => { const c = JSON.stringify(g?.coordinates ?? null).match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return x0 <= x1 ? [x0, y0, x1, y1] : null; };
/** Rahmen [W, S, O, N] um marginM erweitert */
export function growBox(b, marginM) { const dLat = marginM / 111320, dLon = marginM / (111320 * Math.cos(((b[1] + b[3]) / 2) * Math.PI / 180)); return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat]; }
// Rahmen wie web/ops.js overlaps (nur Zahlen mit Dezimalpunkt, paarweise): weicht bei ganzzahligen Koordinaten ab – ein Feature bleibt im
// Ausschnitt, wenn einer der beiden Rahmen trifft, damit die Seite dieselben Abstellverbote findet wie mit der ganzen Datei
const pageBox = (g) => { const c = JSON.stringify(g?.coordinates ?? null).match(/-?\d+\.\d+/g) || []; let x0 = 999, x1 = -999, y0 = 999, y1 = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
/** Rahmen je Feature einer Zonen-Datei (einmal je Datei, für viele Gemeinden): [geometrisch, wie die Seite] */
export const featureBoxes = (doc) => (doc?.features || []).map(f => (f?.geometry ? [geomBox(f.geometry), pageBox(f.geometry)] : null));
/**
 * Zonen-Datei (zones/<Datei>.json) auf den Rahmen cover (zoneCover): Features außerhalb (und ohne Geometrie) werden null, Index und Anzahl bleiben.
 * null, wenn mehr als maxShare der Features im Rahmen liegen (dann lädt die Seite die ganze Datei, ein Ausschnitt spart nichts).
 */
export function zonesSlice(doc, cover, { boxes = featureBoxes(doc), maxShare = 0.5 } = {}) {
  const B = cover; let n = 0;
  const hit = (b) => !!b && !(b[2] < B[0] || b[0] > B[2] || b[3] < B[1] || b[1] > B[3]);
  const features = (doc?.features || []).map((f, i) => { const inB = !!boxes[i] && (hit(boxes[i][0]) || hit(boxes[i][1])); if (inB) n++; return inB ? f : null; });
  return features.length && n > maxShare * features.length ? null : { ...doc, features };
}
/** Felder der Quellen in latest-core.json: Kopfzeile (Datenlage), Fußzeile (Namensnennung, Lizenz) und Anbieterliste der Filter */
export const CORE_SOURCE_FIELDS = Object.freeze(['id', 'operator', 'name', 'status', 'candidate', 'municipalities', 'attribution', 'license', 'licenseId', 'directories', 'feedAgeMs', 'checkedAt']);
/**
 * latest.json für den Start der Disposition (latest-core.json): Quellen nur mit CORE_SOURCE_FIELDS, groups leer; lite nennt, was fehlt.
 * Die Seite lädt latest.json nach, sobald eine andere Ansicht gezeichnet wird (web/app-load.js ensureFullLatest).
 */
export function latestCore(latest) {
  const { sources = [], groups: _g, ...core } = latest || {};
  const lite = sources.map(r => { const o = {}; for (const k of CORE_SOURCE_FIELDS) if (k in r) o[k] = r[k]; return o; });
  return { ...core, sources: lite, groups: {}, lite: { sourceFields: CORE_SOURCE_FIELDS, groups: false } };
}
