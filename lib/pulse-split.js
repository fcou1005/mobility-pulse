// S3.8 Daten nach Gebiet: kleinere Dateien neben den bisherigen (die laufen zwei Wochen parallel weiter), damit eine Ansicht für eine
// Gemeinde nicht die Daten ganz Deutschlands lädt. Reine Funktionen – der Sammler schreibt, die Seite liest, die Tests prüfen.
//   events/<Tag>/<Land>.json    Ereignisse des Tages nur mit Gruppen des Landes (Kopf wie events/<Tag>.json)
//   events/hour-totals.json     je Tag Läufe und Fahrtbeginne je Stunde über alle Gruppen (Tagesgang-Profil ohne 14 Tagesdateien)
//   events/daily-summary.json   Tagessummen je Gruppe (Gemeinde|Anbieter|Art) für Übersichten
//   ops-input/<AGS>.json        Disposition: Zellen der letzten 7 Tage und Begrenzungsrahmen der Gemeinde
//   ops-input/fleet/<AGS>.json  Disposition: Bestand der Gemeinde im Format von ops/<Land>.json (+ Stationen bis 1,5 km um den Rahmen)
import { startsOf } from './pulse-econ.js';

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
