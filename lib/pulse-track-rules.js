// @ts-check
// Mobility Pulse — Fahrzeug-Verfolgung – Regeln, Zellen, Schlüssel, Zeit und Hilfsfunktionen (aus pulse-track.js geschnitten; pulse-track.js bleibt die Fassade für alle Importe).
import { normalizeId, hashStr } from './pulse-core.js';

export const TRACK_VERSION = 2;
// Regelstand der Ereigniszählung (M-19): ändert sich mit jeder Regeländerung; je Lauf in events/<Tag>.json → runs[k][3] und runs.json
// 2026-11-02a: abgeleiteter Ladestand nur Fingerabdruck (Lime BW), Ausblendung (hide), Rückkehr-Tausch, Standzeit-Prüfung und -Zensierung, Gruppenregeln
export const METHOD_VERSION = '2026-11-02a';
export const GAP_MS = 45 * 60e3;  // größerer Abstand zum vorigen Lauf = Lücke: Zustand fortschreiben, keine Ereignisse zählen
export const MOVE_M = 150;        // ab hier gilt ein Positionswechsel bei gleicher Kennung als Umsetzung (bzw. Fahrt bei stabilen Kennungen)
export const TRANSPORT_MIN = 3, TRANSPORT_M = 40; // stabile Kennungen: ≥ 3 ankommende Fahrzeuge eines Anbieters ≤ 40 m beieinander = Sammeltransport (Umsetzung)
// Fahrt-Plausibilität bei stabilen Kennungen (Xu et al. 2020): Luftlinie / Laufintervall höchstens 24 km/h (sonst fast); die Untergrenze 3,5 km/h
// gilt nicht für Versätze innerhalb eines Laufs (echte Dauer ≤ Laufintervall), dort sind kurze Versätze < 500 m ohne Ladestandverlust slow
export const TRIP_MIN_KMH = 3.5, TRIP_MAX_KMH = 24, TRIP_MAX_MS = 2 * 3600e3;
export const NOLOSS_M = 2000;     // stabile Kennung ≥ 2 km versetzt ohne Ladestandverlust = Umsetzung (Transport), keine Fahrt
export const ENERGY_TOL = 2;      // Ladestand „gleich“: ± 2 Prozentpunkte (Kennungswechsel-Abgleich, Reichweiten-Fingerabdruck nach Das & Nicklas 2026)
export const ROTATE_ENERGY_M = 100; // Kennungswechsel mit gleichem Ladestand bis 100 m, ohne Ladestandangabe bis ROTATE_M (40 m)
export const JITTER_M = 50;       // darunter: GPS-Rauschen, Standzeit läuft weiter
export const MISSING_KEEP_MS = 24 * 3600e3; // verschwundene Kennungen so lange behalten (Rückkehr = Fahrtende bei stabilen Kennungen)
export const PICKUP_BATTERY = 15; // verschwindet ein Fahrzeug mit so wenig Akku, war es eher eine Abholung als eine Ausleihe
export const SWAP_FROM = 40, SWAP_TO = 85; // Akkusprung = Tausch
export const LOW_BATTERY = 20;
// Regeln je Fahrzeugart (seit 08.11.2026 mit E-Rollern und Carsharing): Für Mikromobilität (scooter, ebike, bike, cargo, other, unknown) gelten
// unverändert die Konstanten oben (METHOD_VERSION bleibt). E-Roller fahren bis 45 km/h, ihr Akku sinkt je km weniger als bei E-Scootern.
// Autos: Fahrten über Stunden bis Tage (TRIP_MAX_MS 72 h, verschwundene Kennungen 7 Tage behalten), Luftlinie bis 120 km/h je Laufintervall;
// kein Akkutausch, keine Abholung bei wenig Energie (getankt/geladen wird bei der Fahrt oder am Stellplatz), kein Sammeltransport, keine
// Umsetzungsregel „≥ 2 km ohne Energieverlust“ (eine Tankfüllung sinkt bei einer Stadtfahrt kaum), keine Ausbring-/Einsammelgruppen
// (an großen Stationen kommen mehrere Autos zugleich zurück); Rückgabe am Ort des Verschwindens (stationsgebunden, roundtrip_station) zählt
// mit ihrer Dauer in Ø Dauer (die Distanz einer Rundfahrt ist unbekannt und zählt nicht).
const BASE_RULES = Object.freeze({ tripMaxKmh: TRIP_MAX_KMH, tripMaxMs: TRIP_MAX_MS, missingKeepMs: MISSING_KEEP_MS, noLossM: NOLOSS_M, pickupBattery: PICKUP_BATTERY,
  swap: true, transportMin: TRANSPORT_MIN, groups: true, roundTrip: false });
export const TYPE_RULES = Object.freeze({
  moped: Object.freeze({ ...BASE_RULES, tripMaxKmh: 60, noLossM: 5000 }),
  car: Object.freeze({ ...BASE_RULES, tripMaxKmh: 120, tripMaxMs: 72 * 3600e3, missingKeepMs: 7 * 24 * 3600e3, noLossM: Infinity, pickupBattery: -Infinity,
    swap: false, transportMin: Infinity, groups: false, roundTrip: true, resTrips: true }),
});
// Carsharing-Fahrten (seit 9.11.2026; erster Tag mit Carsharing: 2 Fahrtbeginne bei 4.696 Autos). Stationsgebundene Autos bleiben während der
// Buchung im Feed (Rückgabe an dieselbe Station): sichtbar nur als „reserviert“ (Flinkster, MIKAR, Ford, SEEFAHRER …) oder als sinkende Zahl
// buchbarer Autos an der Station (deer, ZEO, Car-Ship – Quellen ohne Fahrzeugliste). Daher für Autos:
// - resTrips: frei → reserviert = Fahrtbeginn, reserviert → frei = Fahrtende mit Dauer der Buchung (Distanz nur, wenn das Auto woanders steht);
//   verschwindet ein reserviertes Auto, ist der Beginn schon gezählt; Versatz während der Buchung zählt nicht zusätzlich
// - Stationen ohne Fahrzeugliste, nur Autos: buchbare Autos weniger als im Vorlauf = Fahrtbeginne, mehr = Fahrtenden; Fahrzeugminuten = buchbare Autos
// - beides mit Massenregel je Quelle (≥ MASS_MIN und > MASS_SHARE der Autos in einem Lauf = Feedfehler, nicht gezählt)
// - Viele Feeds melden jedes Auto immer als verfügbar (stadtmobil, teilAuto, naturenergie, Grüne Flotte, Getaround …): Buchungen unsichtbar.
//   Ein Anbieter gilt nur als messbar, wenn er in den letzten 7 Tagen ≥ minStarts Fahrtbeginne und ≥ perCarDay Fahrtbeginne je Auto und Tag
//   hatte (Flottenwechsel allein reichen nicht); sonst fallen seine Autos aus Ereignissen, Standzeiten und Strömen (nur Bestand) – keine falschen
//   Nullen in Fahrten je Fahrzeug, Ranglisten und der Carsharing-Prognose (result.carTrips).
export const CAR_TRIPS = Object.freeze({ minStarts: 3, perCarDay: 0.05, days: 7 });
export const rulesOf = (ty) => TYPE_RULES[ty] || BASE_RULES;
// Ausblendung (Z4): Quelle blendet unter batteryFloor (pulse-core batteryFloorCheck, je Lauf in sourceRecs[].batteryFloor) aus; verschwindet ein
// verfügbares Fahrzeug mit absolutem Ladestand ≤ Untergrenze + HIDE_BAND, zählt das als hide (vor der Abholschwelle 15 %), nicht als Fahrtbeginn.
// Rückkehr-Tausch: stabile Kennung kehrt ≤ JITTER_M (50 m) vom Ort des Verschwindens mit ≥ RETURN_SWAP Punkten mehr zurück = Akkutausch (swap) und
// zusätzlich Fahrtende (der Beginn beim Verschwinden ist gezählt; ohne Verknüpfung über Tage bleibt die Scheinfahrt als bekannte Obergrenze).
export const HIDE_BAND = 5, RETURN_SWAP = 30;
// Relativer Ladestand (gestauchte Skala oder aus der Reichweite abgeleitet, z. B. Lime: neuer Akku ≈ 33 statt 100): Schwellen als Anteil der
// Skala der Quelle (95. Perzentil des Fingerabdrucks im Lauf), sobald REL_MIN_N Fahrzeuge einen Wert haben und die Skala ≥ REL_MIN_SCALE ist
export const REL_MIN_N = 30, REL_MIN_SCALE = 10;
// Standzeit-Klassen <2 h, 2–8 h, 8–24 h, 1–2 Tage, 2–3 Tage, > 72 h (idle.json → buckets; > 72 h seit 02.11.2026, vorher > 2 Tage als letzte Klasse)
export const IDLE_BUCKETS = [2 * 3600e3, 8 * 3600e3, 24 * 3600e3, 48 * 3600e3, 72 * 3600e3];
export const IDLE_LABELS = ['<2 h', '2–8 h', '8–24 h', '1–2 Tage', '2–3 Tage', '> 72 h'];
export const IDLE_VERSION = 2;
// Standzeit-Plausibilität je Quelle (Z5): bei ≥ minN verfügbaren Fahrzeugen mehr als maxShort mit Standzeit unter einem Laufintervall (Kennung
// wechselt je Lauf, z. B. nextbike Köln 02.11.2026: 97 %) = Standzeit unbrauchbar (nicht in idle.json/idle-long.json, ops-Feld 8 null)
export const IDLE_CHECK = { minN: 200, maxShort: 0.5 };
// Linkszensierung (Z6): Wer seit Beginn der Verfolgung unbewegt ist (erste Sichtung im ersten oder zweiten Lauf, seitdem keine Bewegung), hat
// eine Mindest-Standzeit; dasselbe für „unter 20 %“ (lowSince) und „gesperrt“ (disSince) seit der ersten Sichtung. Grenze = zweiter Lauf
// (state.trackStart2; ältere Zustände: zweitkleinste erste Sichtung, sonst Beginn + 45 Min.).
export const censorLimit = (state) => state?.trackStart2 ?? (state?.trackStart != null ? state.trackStart + GAP_MS : null);
export const isCensored = (limit, ts, firstSeen) => limit != null && ts > 0 && ts === firstSeen && firstSeen <= limit;
// Gruppen (Z7): Nachfrage-Hauptfenster 7–22 Uhr (Ortszeit); stationsgebunden = ≥ STATION_BOUND der verfügbaren Fahrzeuge eines Anbieters in der
// Gemeinde ≤ 30 m an einer eigenen Station (auch virtuell); gemessen 02.11.2026: nextbike 66 %, Donkey 92 %, DB 73 %, Dott 17 %, Voi 9 %, Bolt 10 %
export const DEMAND_MAIN = { from: 7, to: 22 }, STATION_BOUND = 0.5;
export const isNightHour = (h) => !(h >= DEMAND_MAIN.from && h < DEMAND_MAIN.to);
export const CELL_LAT = 0.0025, CELL_LON = 0.0035; // ≈ 280 m × 250 m
// Tageszeit-Bänder für Nachfrage und Versorgung je Zelle
export const BANDS = [
  { id: 0, label: 'Nacht', from: 0, to: 6 }, { id: 1, label: 'Morgen', from: 6, to: 9 }, { id: 2, label: 'Vormittag', from: 9, to: 12 },
  { id: 3, label: 'Mittag', from: 12, to: 15 }, { id: 4, label: 'Nachmittag', from: 15, to: 19 }, { id: 5, label: 'Abend', from: 19, to: 24 },
];
export const bandOf = (hour) => BANDS.findIndex(b => hour >= b.from && hour < b.to);
// Zellenwerte: [start, end, present, reloc, start je Band ×6 (4–9), present je Band ×6 (10–15), end je Band ×6 (16–21)]
// seit S6.3 (14.11.2026) dazu Läufe mit Angebot je Band ×6 (22–27): Läufe, in denen die Zelle mindestens ein verfügbares Fahrzeug hatte
// (Zensur der Nachfrage: ohne Angebot kann keine Fahrt beginnen). CELL_LEN bleibt die Länge mit Bandfeldern (Prüfungen auf ältere Zellen),
// CELL_FULL die Länge neuer Zellen; ältere Zellen ohne die Angebotsfelder bleiben gültig.
export const CELL_LEN = 22, CELL_SUPPLY = 22, CELL_FULL = 28;

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
export const trackable = (v) => Number.isFinite(v.lat) && Number.isFinite(v.lon) && !!v.ags && v.ags !== 'unbekannt';
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
// Formatierer je Zeitzone zwischengespeichert: ein neuer Intl.DateTimeFormat je Aufruf kostete ~120 µs statt ~3 µs und fror die Prognose-Ansicht
// mit ihren Tausenden Terminen sekundenlang ein (Audit 11.11.2026, OPS-03)
const FMT_H = new Map(), FMT_D = new Map();
const fmtH = (tz) => { let f = FMT_H.get(tz); if (!f) FMT_H.set(tz, (f = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }))); return f; };
const fmtD = (tz) => { let f = FMT_D.get(tz); if (!f) FMT_D.set(tz, (f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }))); return f; };
export const hourOf = (ms, tz = 'Europe/Berlin') => +fmtH(tz).format(new Date(ms)) % 24;
export const dayOf = (ms, tz = 'Europe/Berlin') => fmtD(tz).format(new Date(ms));

export function emptyState(now) {
  return { version: TRACK_VERSION, at: null, prevAt: null, dict: { op: [], ags: [], src: [] }, v: {}, s: {}, srcStats: {}, rel: {} };
}
// Wörterbuch-Index
export function dictIdx(dict, name, value) { const arr = dict[name]; let i = arr.indexOf(value); if (i < 0) { i = arr.length; arr.push(value); } return i; }

// F_SILENT: verschwunden, ohne dass ein Fahrtbeginn gezählt wurde (Lauf nach Lücke, Quellenausfall) → Rückkehr zählt kein Fahrtende
// F_BATREL: Ladestand nur relativ verwendbar (Skala der Quelle unplausibel, pulse-core batteryScaleCheck): Fingerabdruck für den Kennungswechsel
// und für „Ladestand gesunken/gestiegen“, aber keine absoluten Schwellen (Abholung < 15 %, Akkutausch < 40 → ≥ 85 %, niedrig < 20 %)
export const F_DISABLED = 1, F_RESERVED = 2, F_MISSING = 4, F_SILENT = 8, F_BATREL = 16;
export const arr = (n) => new Array(n).fill(0);
export const ROTATE_M = 40;     // Kennung verschwindet und neue taucht ≤ 40 m daneben auf: Kennungswechsel am Ort, keine Fahrt
// slow/fast: Versatz einer stabilen Kennung < 500 m ohne Ladestandverlust bzw. über 24 km/h (keine Fahrt, gesondert gezählt)
// hide (Z4, ab 02.11.2026 am Ende): Ausblendung bei niedrigem Akku statt Fahrtbeginn; swapWaitCens/disDurCens = davon linkszensierte Werte (Mindestwerte)
export const HOUR_FIELDS = ['start', 'end', 'reloc', 'swap', 'pickup', 'disOn', 'disOff', 'rot', 'vmin', 'vminTot', 'slow', 'fast', 'hide'];
export const HOUR_SUMS = ['swapWaitSum', 'swapWaitN', 'disDurSum', 'disDurN', 'tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN', 'swapWaitCens', 'disDurCens'];
export function emptyHourly() { return { start: arr(24), end: arr(24), reloc: arr(24), swap: arr(24), pickup: arr(24), disOn: arr(24), disOff: arr(24), rot: arr(24), vmin: arr(24), vminTot: arr(24), slow: arr(24), fast: arr(24), hide: arr(24), swapWaitSum: 0, swapWaitN: 0, disDurSum: 0, disDurN: 0, tripDurSum: 0, tripDurN: 0, tripDistSum: 0, tripDistN: 0, swapWaitCens: 0, disDurCens: 0 }; }
// Kennungswechsel-Abgleich: 'rot' (gleicher Ladestand ≤ 100 m bzw. ohne Angabe ≤ 40 m), 'swap' (Ladestand springt am Ort nach oben; nur bei
// absolut verwendbarem Ladestand beider Seiten, abs = true), sonst null
export function pairKind(gb, ab, d, abs = true, tol = ENERGY_TOL, sc = null, swapOk = true) {
  if (gb != null && ab != null) {
    if (Math.abs(gb - ab) <= tol) return d <= ROTATE_ENERGY_M ? 'rot' : null;
    if (!swapOk) return null;
    if (abs) return gb < SWAP_FROM && ab >= SWAP_TO && d <= ROTATE_M ? 'swap' : null;
    // relativer Ladestand: Sprung von unter 40 % auf mindestens 85 % der Skala der Quelle (seit 08.11.2026; vorher nie ein Tausch)
    return sc && gb < SWAP_FROM / 100 * sc && ab >= SWAP_TO / 100 * sc && d <= ROTATE_M ? 'swap' : null;
  }
  return d <= ROTATE_M ? 'rot' : null;
}
// Massenwechsel je Quelle und Lauf (Rückkehr nach Ausfall, Neustart, Umstieg auf eine Spiegelquelle): mindestens MASS_MIN und mehr als
// MASS_SHARE der Flotte (präsent + per Kennungswechsel gepaart + neu) ungepaart neu bzw. verschwunden → keine Fahrtenden bzw. -beginne
export const MASS_MIN = 10, MASS_SHARE = 0.3;
export const SHORT_TRIP_M = 500; // stabile Kennung: Versatz darunter ohne Ladestandverlust = GPS-Sprung (slow), darüber Fahrt
// Kennungswechsel-Takt je Quelle (M-7): Anteil gepaarter Wechsel an präsent + gewechselt (rollierend). Ab PERIODIC_RATE wechselt die Quelle
// periodisch (Lime direkt: jede Kennung in jedem Lauf) – dann Ortspaarung wie bisher. Darunter wechselt die Kennung je Fahrt (nextbike, Dott):
// eine Ausleihe und eine Rückgabe am selben Ort im selben Lauf sind zwei Fahrten; gepaart wird nur ≤ STRICT_ROT_M mit exakt gleichem Ladestand
// und nicht ≤ STATION_ROT_M an einer eigenen Station. Ohne ausreichende Statistik (unter 3 Läufen) wie bisher.
export const PERIODIC_RATE = 0.2, STRICT_ROT_M = 5, STATION_ROT_M = 30;
// Kanonischer Feed einer Quelle (M-13): Spiegelkopien desselben Ursprungsfeeds in mehreren MOBIDROM-Manifesten („…:source-voi-koeln“) teilen
// Statistik und Kennungsmodus – sonst wechselt der Modus mit dem Dublettensieger von Lauf zu Lauf (stabil ↔ rotierend).
export const canonSource = (id) => { const m = /^[^:]+:(source-.+)$/.exec(String(id ?? '')); return m ? m[1] : String(id ?? ''); };
