// Mobility Pulse — Fahrzeug-Verfolgung über Sammler-Läufe hinweg.
// Reine Funktionen, keine Abhängigkeiten. Speichert nur gehashte Kennungen und gerundete Positionen.
import { haversineM, normalizeId, hashStr, hourMinutes } from './pulse-core.js?v=mw2hedag';

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
// Ausblendung (Z4): Quelle blendet unter batteryFloor (pulse-core batteryFloorCheck, je Lauf in sourceRecs[].batteryFloor) aus; verschwindet ein
// verfügbares Fahrzeug mit absolutem Ladestand ≤ Untergrenze + HIDE_BAND, zählt das als hide (vor der Abholschwelle 15 %), nicht als Fahrtbeginn.
// Rückkehr-Tausch: stabile Kennung kehrt ≤ JITTER_M (50 m) vom Ort des Verschwindens mit ≥ RETURN_SWAP Punkten mehr zurück = Akkutausch (swap) und
// zusätzlich Fahrtende (der Beginn beim Verschwinden ist gezählt; ohne Verknüpfung über Tage bleibt die Scheinfahrt als bekannte Obergrenze).
export const HIDE_BAND = 5, RETURN_SWAP = 30;
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
// F_BATREL: Ladestand nur relativ verwendbar (Skala der Quelle unplausibel, pulse-core batteryScaleCheck): Fingerabdruck für den Kennungswechsel
// und für „Ladestand gesunken/gestiegen“, aber keine absoluten Schwellen (Abholung < 15 %, Akkutausch < 40 → ≥ 85 %, niedrig < 20 %)
const F_DISABLED = 1, F_RESERVED = 2, F_MISSING = 4, F_SILENT = 8, F_BATREL = 16;
const arr = (n) => new Array(n).fill(0);
export const ROTATE_M = 40;     // Kennung verschwindet und neue taucht ≤ 40 m daneben auf: Kennungswechsel am Ort, keine Fahrt
// slow/fast: Versatz einer stabilen Kennung < 500 m ohne Ladestandverlust bzw. über 24 km/h (keine Fahrt, gesondert gezählt)
// hide (Z4, ab 02.11.2026 am Ende): Ausblendung bei niedrigem Akku statt Fahrtbeginn; swapWaitCens/disDurCens = davon linkszensierte Werte (Mindestwerte)
export const HOUR_FIELDS = ['start', 'end', 'reloc', 'swap', 'pickup', 'disOn', 'disOff', 'rot', 'vmin', 'vminTot', 'slow', 'fast', 'hide'];
export const HOUR_SUMS = ['swapWaitSum', 'swapWaitN', 'disDurSum', 'disDurN', 'tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN', 'swapWaitCens', 'disDurCens'];
export function emptyHourly() { return { start: arr(24), end: arr(24), reloc: arr(24), swap: arr(24), pickup: arr(24), disOn: arr(24), disOff: arr(24), rot: arr(24), vmin: arr(24), vminTot: arr(24), slow: arr(24), fast: arr(24), hide: arr(24), swapWaitSum: 0, swapWaitN: 0, disDurSum: 0, disDurN: 0, tripDurSum: 0, tripDurN: 0, tripDistSum: 0, tripDistN: 0, swapWaitCens: 0, disDurCens: 0 }; }
// Kennungswechsel-Abgleich: 'rot' (gleicher Ladestand ≤ 100 m bzw. ohne Angabe ≤ 40 m), 'swap' (Ladestand springt am Ort nach oben; nur bei
// absolut verwendbarem Ladestand beider Seiten, abs = true), sonst null
function pairKind(gb, ab, d, abs = true, tol = ENERGY_TOL) {
  if (gb != null && ab != null) {
    if (Math.abs(gb - ab) <= tol) return d <= ROTATE_ENERGY_M ? 'rot' : null;
    return abs && gb < SWAP_FROM && ab >= SWAP_TO && d <= ROTATE_M ? 'swap' : null;
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

/**
 * Ein Sammler-Lauf gegen den letzten Zustand.
 * vehicles: deduplizierte Fahrzeuge {operator, rawId, lat, lon, batteryPct, disabled, reserved, type, ags, sourceId}
 * stations: deduplizierte Stationen {operator, id, name, lat, lon, ags, bookable, docksAvailable, renting, installed, returning, isVirtual}
 * sourceRecs: Quellen-Datensätze des Laufs {id, status, latencyMs, batteryFloor?} (batteryFloor = Ausblend-Untergrenze in %, null = blendet nicht aus)
 * idle: { 'ags|op|type': [je IDLE_BUCKETS-Klasse, Summe] }, idleCens: dieselben Schlüssel, je Klasse zensierte (seit Beginn der Verfolgung unbewegt),
 * idleUnusable: { Quelle: { n, short, share } } (Standzeit unbrauchbar, Z5; fehlen in idle/idleLong); state.trackStart/trackStart2 = erster/zweiter Lauf
 * hmac: optionale Schlüsselfunktion (gesalzen, siehe vehicleKey); noEvents: Lauf zählt nichts (z. B. Umzug auf neue Schlüssel)
 * Rückgabe: { state, first, dt, gap, hourly: Map(key→emptyHourly), cells: Map(ags→Map(cell→[start,end,present,reloc])), idle: {...}, idleLong: [...], stationQuota, reliability, srcModes,
 *   flows: Map('ags|op|type|band' → Map('vonZelle>nachZelle' → {count, durSum, distSum})) }
 * gap = Lauf nach Lücke (dt > GAP_MS) oder noEvents: Zustand wird fortgeschrieben, hourly/cells/flows bleiben leer, keine Gruppen.
 * flows: Fahrten mit bekanntem Start und Ziel, nur Quellen mit stabilen Kennungen (modeOf 'stable'): Versatz ≥ 150 m, als Fahrt gewertet
 * (Start = alte Zelle, Dauer = Laufintervall), oder Rückkehr ≥ 150 m vom Ort des Verschwindens (Dauer = Zeit seit dem Verschwinden ≤ 2 h; nicht nach
 * Sperrung/Akku < 15 %, nicht aufgeladen, nicht im Sammeltransport, nicht schneller als 24 km/h). ags = Gemeinde des Starts, band = Tageszeit-Band
 * des Laufs (Ende), durSum in ms, distSum = Luftlinie in m. Rotierende Kennungen werden NICHT verknüpft (keine Re-Identifizierung über Reichweite o. Ä.).
 * est: Zählungen je Zelle für die geschätzten Ströme (lib/pulse-flowest.js), { s, e, vs, ve: { 'Anbieter|Art': { 'Gemeinde|Zelle': n } }, vsLate }:
 * s/e = Fahrtbeginne (verschwunden, verfügbar, keine Abholung) und Fahrtenden (neue Kennung bzw. Rückkehr) aller nicht stabilen Quellen, ohne
 * Ausbringen/Einsammeln (Gruppen ≥ 4) und ohne Quellen mit Massenwechsel; vs/ve = Beginne/Enden der gemessenen Ströme stabiler Quellen
 * (Validierung), vsLate = [['Anbieter|Art', 'Gemeinde|Zelle', Lauf des Verschwindens]] für stabile Rückkehrer. Nur Zählungen, keine Paare.
 *
 * Methode: Verschwundene und neu aufgetauchte Kennungen eines Anbieters und einer Fahrzeugart werden global gepaart (alle Kandidatenpaare
 * nach Kosten sortiert): gleicher Ladestand (± ENERGY_TOL) bis 100 m bzw. ohne Ladestand bis 40 m = Kennungswechsel, Ladestand springt am
 * Ort von < 40 auf ≥ 85 % = Akkutausch; beides keine Fahrt. Übrige verschwundene = Fahrtbeginn (gesperrt/Akku < 15 % = Abholung; Quelle mit
 * Ausblend-Untergrenze: Akku ≤ Untergrenze + 5 = hide; stabile Kennung zurück ≤ 50 m mit ≥ 30 Punkten mehr = Akkutausch und Fahrtende), übrige
 * neue = Fahrtende. Stabile Kennungen ≥ 150 m versetzt: Fahrt (Start alt, Ende neu), wenn Luftlinie/Laufintervall ≤ 24 km/h und der Versatz
 * ≥ 500 m ist oder der Ladestand sinkt, sonst slow/fast; Umsetzung bei Sammeltransport (≥ 3 Ankünfte ≤ 40 m), Sperrung oder ≥ 2 km ohne
 * Ladestandverlust. Massenwechsel einer Quelle (≥ 10 und > 30 % der Flotte ungepaart neu bzw. verschwunden, z. B. Rückkehr nach Ausfall):
 * keine Fahrtenden bzw. -beginne, Kennungen still angelegt bzw. behalten. Quelle ohne Datensatz in sourceRecs = ausgefallen.
 * Ladestand mit unplausibler Skala (v.batteryFp statt v.batteryPct): nur Fingerabdruck (Kennungswechsel, gesunken/gestiegen), keine Schwellen.
 */
export function trackRun(prev, { vehicles, stations, sourceRecs, now, tz = 'Europe/Berlin', hmac = null, noEvents = false }) {
  const state = prev && prev.version === TRACK_VERSION ? prev : emptyState(now);
  if (hmac) state.salted = true;
  const CS = canonSource;
  // Umstieg auf kanonische Schlüssel: je Ursprungsfeed die Statistik mit den meisten Läufen übernehmen (Kopien sahen dieselben Fahrzeuge)
  if (!state.srcCanon) { const m = {}; for (const [id, st] of Object.entries(state.srcStats || {})) { const c = CS(id); if (!m[c] || (st?.runs || 0) > (m[c].runs || 0)) m[c] = st; } state.srcStats = m; state.srcCanon = 1; }
  const first = state.at == null;
  const dt = first ? null : now - state.at;
  const gap = (dt != null && dt > GAP_MS) || (!!noEvents && !first);
  // Beginn der Verfolgung (Z6): erster und zweiter Lauf; ältere Zustände ohne Angabe: kleinste und zweitkleinste erste Sichtung
  if (first) { state.trackStart = now; delete state.trackStart2; }
  else {
    if (state.trackStart == null) { let a = Infinity, b = Infinity; for (const e of Object.values(state.v)) { const f = e[7]; if (f < a) { b = a; a = f; } else if (f > a && f < b) b = f; } state.trackStart = Number.isFinite(a) ? a : (state.at ?? now); if (Number.isFinite(b)) state.trackStart2 = b; }
    if (state.trackStart2 == null) state.trackStart2 = now;
  }
  const cLim = censorLimit(state), cens = (ts, firstSeen) => isCensored(cLim, ts, firstSeen);
  const hour = hourOf(now, tz), day = dayOf(now, tz);
  const hourly = new Map();
  const voidH = emptyHourly(), voidC = new Array(CELL_LEN).fill(0); // Lücken-Lauf: Zählungen laufen ins Leere
  const H = (op, ags, ty) => { if (gap) return voidH; const k = `${ags}|${op}|${ty}`; if (!hourly.has(k)) hourly.set(k, emptyHourly()); return hourly.get(k); };
  const cells = new Map();
  const CELL = (ags, cell) => { if (gap) return voidC; if (!cells.has(ags)) cells.set(ags, new Map()); const m = cells.get(ags); if (!m.has(cell)) m.set(cell, new Array(CELL_LEN).fill(0)); return m.get(cell); };
  const band = bandOf(hour);
  const flows = new Map(); // Start-Ziel-Ströme (nur stabile Kennungen), siehe oben
  const est = { s: {}, e: {}, vs: {}, ve: {}, vsLate: [] }; // Zählungen je Zelle für die Schätzung (siehe oben), keine Paare
  const EST = (o, k1, k2) => { const m = (o[k1] ??= {}); m[k2] = (m[k2] || 0) + 1; };
  const FLOW = (ags, op, ty, from, to, dur, dist, toAgs, startAt) => {
    if (gap) return;
    const k = `${ags}|${op}|${ty}|${band}`; let m = flows.get(k); if (!m) flows.set(k, m = new Map());
    const p = `${from}>${to}`; const f = m.get(p) || { count: 0, durSum: 0, distSum: 0 }; f.count++; f.durSum += dur; f.distSum += dist; m.set(p, f);
    // Validierung der Schätzung: Beginn im Lauf des Verschwindens (Versatz: dieser Lauf), Ende in diesem Lauf – getrennt gezählt
    EST(est.ve, `${op}|${ty}`, `${toAgs}|${to}`);
    if (startAt === now) EST(est.vs, `${op}|${ty}`, `${ags}|${from}`); else est.vsLate.push([`${op}|${ty}`, `${ags}|${from}`, startAt]);
  };
  const estS = [], estE = []; // Kandidaten für s/e: Gruppen (Ausbringen/Einsammeln) und Massenwechsel werden am Ende herausgenommen
  const rets = []; // Rückkehrer stabiler Kennungen: Strom erst nach der Sammeltransport-Prüfung
  const dict = state.dict;
  const D = (name, v) => dictIdx(dict, name, v);
  const seen = new Set();
  const srcRun = {}; // kanonische Quelle → {present, gone, moved, newc, returned, rotated}
  const S = (src) => (srcRun[CS(src)] ??= { present: 0, gone: 0, moved: 0, newc: 0, returned: 0 });
  // Kennungsmodus je Quelle aus bisherigen Läufen: stabil, wenn Kennungen wiederkehren oder sich bewegen
  const modeOf = (src) => { const st = state.srcStats[CS(src)]; if (!st || st.runs < 2) return 'unknown'; const ret = st.returned + st.moved, gone = st.gone; if (ret + gone < 20) return 'unknown'; return ret / (ret + gone) > 0.25 ? 'stable' : 'rotating'; };
  const rotRate = (src) => { const st = state.srcStats[CS(src)]; if (!st || st.runs < 3) return null; const base = (st.present || 0) + (st.rotated || 0); return base >= 10 ? (st.rotated || 0) / base : null; };
  const periodic = (src) => { const r = rotRate(src); return r == null || r >= PERIODIC_RATE; };
  const recById = new Map((sourceRecs || []).map(r => [r.id, r]));
  // eigene Stationen je Anbieter (Raster ≈ 55 m): strenge Paarung bei Wechsel je Fahrt (M-7), keine Gruppen an Dockstationen (M-14)
  const SLA = 0.0005, SLO = 0.0008; const sgrid = new Map();
  for (const st of stations || []) { if (!Number.isFinite(st.lat) || !Number.isFinite(st.lon)) continue; const k = `${st.operator}|${Math.floor(st.lat / SLA)}:${Math.floor(st.lon / SLO)}`; if (!sgrid.has(k)) sgrid.set(k, []); sgrid.get(k).push(st); }
  const nearStation = (op, la, lo, dockOnly = false) => { const i = Math.floor(la / SLA), j = Math.floor(lo / SLO); for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const st of sgrid.get(`${op}|${i + di}:${j + dj}`) || []) if ((!dockOnly || st.isVirtual !== true) && haversineM(la, lo, st.lat, st.lon) <= STATION_ROT_M) return true; return false; };
  const atStation = (op, la, lo) => nearStation(op, la, lo);
  const usableCanon = new Set((sourceRecs || []).filter(r => r.status === 'live' || r.status === 'delayed').map(r => CS(r.id))); // eine laufende Kopie genügt
  // Ausblend-Untergrenze je Quelle (Z4; Kopien über den kanonischen Feed)
  const floorBy = new Map(); for (const r of sourceRecs || []) if (Number.isFinite(r.batteryFloor)) { floorBy.set(r.id, r.batteryFloor); floorBy.set(CS(r.id), r.batteryFloor); }
  const floorOf = (src) => floorBy.get(src) ?? floorBy.get(CS(src)) ?? null;
  // Stationsbindung je Anbieter|Gemeinde (Z7): [verfügbar, davon ≤ 30 m an eigener Station]
  const stBound = new Map();

  // --- Fahrzeuge ---
  const idleRows = []; // verfügbare Fahrzeuge mit Standzeit: erst nach der Plausibilitätsprüfung je Quelle in idle/idleLong (Z5)
  const idleSrc = {}; // Quelle → [verfügbar, davon Standzeit < Laufintervall] (neue Kennungen zählen mit Standzeit 0)
  const IS = (src) => (idleSrc[src || ''] ??= [0, 0]);
  const newAvail = []; // neue Kennungen (verfügbar): Standzeit erst nach dem Kennungswechsel-Abgleich (gepaarte übernehmen die Standzeit)
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
    // absolut verwendbar; ein aus Reichweite ÷ Maximalreichweite abgeleiteter Ladestand (batteryDerived, z. B. Lime BW) nur als Fingerabdruck wie die
    // unplausible Skala: bis 02.11.2026 zählte die Abholschwelle 15 % darauf 40 % der Lime-Abgänge in Stuttgart als Abholung statt als Fahrt
    const bat = v.batteryPct != null && !v.batteryDerived ? Math.round(v.batteryPct) : null;
    const fpRaw = v.batteryFp != null && Number.isFinite(v.batteryFp) ? v.batteryFp : v.batteryDerived && v.batteryPct != null ? v.batteryPct : null;
    const fp = bat ?? (fpRaw != null ? Math.round(fpRaw) : null); // Fingerabdruck (auch bei unplausibler Skala bzw. abgeleitetem Ladestand)
    let flags = (v.disabled ? F_DISABLED : 0) | (v.reserved ? F_RESERVED : 0) | (bat == null && fp != null ? F_BATREL : 0);
    const op = D('op', v.operator), ags = D('ags', v.ags), src = D('src', v.sourceId || ''), ty = v.type || 'unknown';
    const e = state.v[key];
    const s = S(v.sourceId);
    const cell = cellOf(v.lat, v.lon);
    const c = CELL(v.ags, cell);
    if (!v.disabled && !v.reserved) {
      c[2]++; c[10 + band]++; // präsent (verfügbar)
      if (sgrid.size) { const bk = `${v.operator}|${v.ags}`; const sb = stBound.get(bk) || [0, 0]; sb[0]++; if (nearStation(v.operator, v.lat, v.lon)) sb[1]++; stBound.set(bk, sb); }
    }
    if (dtMin) { const hh = H(v.operator, v.ags, ty); hh.vminTot[hour] += dtMin; if (!v.disabled && !v.reserved) hh.vmin[hour] += dtMin; }
    if (!e) {
      // neu aufgetaucht: Fahrtende (rotierende Kennungen) bzw. Neuaufstellung – Zählung nach dem Abgleich unten
      s.newc++;
      state.v[key] = [lat, lon, fp, flags, ty, op, ags, now, now, bat != null && bat < LOW_BATTERY ? now : 0, v.disabled ? now : 0, src, 0];
      if (!first) { appeared.push({ key, v, ty, c, bat: fp, abs: bat != null }); if (!v.disabled && !v.reserved) newAvail.push({ key, v, ty, bat }); }
      continue;
    }
    s.present++;
    const [plat, plon, pbat, pflags, pty, pop, pags, firstSeen, lastMoved, lowSince, disSince, psrc, missingSince] = e;
    const pAbs = pbat != null && !(pflags & F_BATREL); // voriger Ladestand absolut verwendbar
    const dist = haversineM(plat / 1e5, plon / 1e5, v.lat, v.lon);
    const wasMissing = !!(pflags & F_MISSING);
    const silent = wasMissing && !!(pflags & F_SILENT); // verschwunden ohne gezählten Beginn (Lücke/Ausfall): Rückkehr still
    const h = H(v.operator, v.ags, ty);
    const stable = modeOf(v.sourceId) === 'stable';
    // Rückkehr-Tausch (Z4): am Ort (≤ 50 m) mit ≥ 30 Punkten mehr zurück – geladen bzw. Akku getauscht, keine Fahrt (auch relativer Ladestand:
    // „gestiegen“ ist ein Vergleich, keine absolute Schwelle); bis 02.11.2026 zählte der Rückkehr-Zweig hier immer ein Fahrtende
    const retSwap = wasMissing && !silent && dist <= JITTER_M && fp != null && pbat != null && fp >= pbat + RETURN_SWAP;
    if (silent) { /* nur Zustand fortschreiben */ }
    else if (retSwap) {
      // zusätzlich ein Fahrtende: der Fahrtbeginn beim Verschwinden ist schon gezählt (ohne Verknüpfung über Tage nicht zurücknehmbar); so bleiben
      // Beginne ÷ Enden ausgeglichen, die Scheinfahrt bleibt eine bekannte Obergrenze wie vor Z4 (bis 02.11.2026: swap ohne end → Ampel S/E verschoben)
      s.returned++; h.swap[hour]++; if (lowSince) { h.swapWaitSum += now - lowSince; h.swapWaitN++; if (cens(lowSince, firstSeen)) h.swapWaitCens++; }
      h.end[hour]++; c[1]++; c[16 + band]++; if (!stable) estE.push([null, v.operator, ty, v.ags, cell, v.sourceId]);
    }
    else if (wasMissing) {
      // Rückkehr einer bekannten Kennung = Fahrtende mit bekanntem Start (stabile Kennungen); Dauer > 2 h fließt nicht in Ø Dauer/Distanz
      s.returned++;
      h.end[hour]++; c[1]++; c[16 + band]++;
      if (!stable) estE.push([null, v.operator, ty, v.ags, cell, v.sourceId]);
      const dur = now - (missingSince || state.at || now);
      if (dist >= JITTER_M && dur <= TRIP_MAX_MS) { h.tripDistSum += dist; h.tripDistN++; h.tripDurSum += dur; h.tripDurN++; }
      if (stable && dist >= MOVE_M) landed.push({ op: v.operator, lat: v.lat, lon: v.lon });
      // Strom nur, wenn das Verschwinden als Fahrtbeginn galt (nicht gesperrt, Akku ≥ 15 %) und das Fahrzeug nicht aufgeladen zurückkommt
      if (stable && dist >= MOVE_M && dur <= TRIP_MAX_MS && !v.disabled && !(pflags & F_DISABLED) && !(pAbs && pbat < PICKUP_BATTERY) && !(fp != null && pbat != null && fp > pbat + ENERGY_TOL))
        rets.push({ op: v.operator, ty, ags: dict.ags[pags], toAgs: v.ags, from: cellOf(plat / 1e5, plon / 1e5), to: cell, lat: v.lat, lon: v.lon, dist, dur, noLoss: fp != null && pbat != null && fp >= pbat && dist >= NOLOSS_M });
    } else if (dist >= MOVE_M) {
      s.moved++;
      if (stable && !v.disabled && !(pflags & F_DISABLED)) {
        // stabile Kennungen bleiben während der Fahrt im Feed: Versatz = Fahrt (Start am alten Ort), außer Sammeltransport usw. (unten)
        const m = { key, op: v.operator, ty, ags: v.ags, agsOld: dict.ags[pags], cellOld: cellOf(plat / 1e5, plon / 1e5), c, lat: v.lat, lon: v.lon, dist, pbat, bat: fp, babs: bat, src: v.sourceId };
        moves.push(m); landed.push(m);
      } else {
        // rotierende Kennungen (Fahrten entfernen das Fahrzeug aus dem Feed) bzw. gesperrt: Umsetzung durch den Betreiber
        h.reloc[hour]++; c[3]++;
        arrivals.push({ op: v.operator, ty, ags: v.ags, lat: v.lat, lon: v.lon, src: v.sourceId, bat }); // bat: absoluter Ladestand (Gruppen ≥ 85 %, Z7)
      }
    }
    // Rückkehr-Tausch am Ort: Standzeit läuft weiter (wie Tausch unter neuer Kennung); stille Rückkehr (Ausfall, Lücke, Massenverschwinden) am Ort
    // ebenso – bis 02.11.2026 begann die Standzeit nach jedem Quellenausfall neu und die Quelle galt danach als „Standzeit unbrauchbar“ (Z5)
    const moved = !retSwap && (dist >= JITTER_M || (wasMissing && !silent));
    const newLastMoved = moved ? now : lastMoved;
    // Akkutausch: deutlicher Sprung nach oben am selben Ort
    let newLowSince = retSwap ? 0 : lowSince;
    if (bat != null) {
      if (pAbs && pbat < SWAP_FROM && bat >= SWAP_TO && dist < MOVE_M && !wasMissing) { h.swap[hour]++; if (lowSince) { h.swapWaitSum += now - lowSince; h.swapWaitN++; if (cens(lowSince, firstSeen)) h.swapWaitCens++; } newLowSince = 0; }
      else if (bat < LOW_BATTERY) { if (!newLowSince) newLowSince = now; }
      else if (bat >= SWAP_TO) newLowSince = 0;
    }
    // Sperren
    let newDisSince = disSince;
    const wasDis = !!(pflags & F_DISABLED);
    if (v.disabled && !wasDis) { h.disOn[hour]++; newDisSince = now; }
    else if (!v.disabled && wasDis) { h.disOff[hour]++; if (disSince) { h.disDurSum += now - disSince; h.disDurN++; if (cens(disSince, firstSeen)) h.disDurCens++; } newDisSince = 0; }
    else if (v.disabled && !newDisSince) newDisSince = now;
    state.v[key] = [lat, lon, fp ?? pbat, flags | (fp == null && (pflags & F_BATREL) ? F_BATREL : 0), ty, op, ags, firstSeen, newLastMoved, newLowSince, newDisSince, src, 0];
    // Standzeit (nur verfügbare Fahrzeuge); zensiert = seit Beginn der Verfolgung unbewegt (Mindestwert)
    if (!v.disabled && !v.reserved) {
      const idle = now - newLastMoved;
      if (!first && !silent) { const q = IS(v.sourceId); q[0]++; if (dt != null && idle < dt) q[1]++; } // stille Rückkehrer nicht in die Prüfung (Z5)
      idleRows.push({ v, ty, idle, bat, c: cens(newLastMoved, firstSeen) });
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
      if (near >= TRANSPORT_MIN || noLoss) { h.reloc[hour]++; m.c[3]++; arrivals.push({ op: m.op, ty: m.ty, ags: m.ags, lat: m.lat, lon: m.lon, src: m.src, bat: m.babs }); continue; }
      // Versatz innerhalb eines Laufs: die echte Dauer ist ≤ dt, eine Untergrenze auf Luftlinie ÷ dt verwürfe alle Fahrten unter ≈ 1,2 km (20 Min.).
      // Daher nur die Obergrenze; kurze Versätze (< 500 m) ohne Ladestandverlust bleiben GPS-Sprung (slow). TRIP_MIN_KMH gilt nur für Rückkehrer.
      const v = kmh(m);
      if (v > TRIP_MAX_KMH) { h.fast[hour]++; arrivals.push({ op: m.op, ty: m.ty, ags: m.ags, lat: m.lat, lon: m.lon, src: m.src, bat: m.babs }); continue; }
      if (m.dist < SHORT_TRIP_M && !(m.pbat != null && m.bat != null && m.bat < m.pbat)) { h.slow[hour]++; continue; }
      H(m.op, m.agsOld, m.ty).start[hour]++; const co = CELL(m.agsOld, m.cellOld); co[0]++; co[4 + band]++;
      h.end[hour]++; m.c[1]++; m.c[16 + band]++;
      h.tripDistSum += m.dist; h.tripDistN++; h.tripDurSum += dt; h.tripDurN++; // Dauer ≤ dt (Obergrenze)
      FLOW(m.agsOld, m.op, m.ty, m.cellOld, cellOf(m.lat, m.lon), dt, m.dist, m.ags, now);
    }
    // Rückkehrer: Sammeltransport (≥ 3 Ankünfte ≤ 40 m), ≥ 2 km ohne Ladestandverlust oder selbst bei längster möglicher Dauer (seit Verschwinden + Laufintervall) > 24 km/h = kein Strom
    for (const r of rets) {
      if (nearOf(r) >= TRANSPORT_MIN || r.noLoss || (r.dist / 1000) / ((r.dur + dt) / 3600e3) > TRIP_MAX_KMH) continue;
      FLOW(r.ags, r.op, r.ty, r.from, r.to, r.dur, r.dist, r.toAgs, now - r.dur);
    }
  }
  // --- Verschwundene Fahrzeuge ---
  const goneList = [];
  const massNew = new Set(), massGone = new Set();
  if (!first) {
    for (const [key, e] of Object.entries(state.v)) {
      if (seen.has(key)) continue;
      const flags = e[3];
      if (flags & F_MISSING) { if (now - e[12] > MISSING_KEEP_MS) delete state.v[key]; continue; }
      const srcN = dict.src[e[11]];
      // fehlt der Quellen-Datensatz (Manifest ausgefallen, Quelle aus dem Katalog entfernt), gilt die Quelle als ausgefallen
      const srcUsable = usableCanon.has(CS(srcN));
      // Quelle ausgefallen: nicht als Fahrt werten, Kennung still behalten (Rückkehr zählt kein Fahrtende)
      if (!srcUsable) { e[3] = flags | F_MISSING | F_SILENT; e[12] = now; continue; }
      S(srcN).gone++;
      goneList.push({ key, e, opN: dict.op[e[5]], agsN: dict.ags[e[6]], srcN, lat: e[0] / 1e5, lon: e[1] / 1e5 });
    }
    // Kennungswechsel/Akkutausch mit neuer Kennung: alle Kandidatenpaare (gleicher Anbieter, gleiche Art) nach Kosten, dann vergeben
    // nach einer Lücke entlädt sich ein stehendes Fahrzeug weiter: Toleranz ± (2 + 1 je Stunde Lücke), damit die Standzeit nicht neu beginnt (M-18)
    const tolRun = ENERGY_TOL + (gap && dt != null ? Math.floor(dt / 3600e3) : 0);
    if (goneList.length && appeared.length) {
      const CLA = 0.001, CLO = 0.0016; const gk = (la, lo) => `${Math.floor(la / CLA)}:${Math.floor(lo / CLO)}`; // Zelle ≥ 100 m
      const grid = new Map(); appeared.forEach((a, i) => { const k = gk(a.v.lat, a.v.lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
      const pairs = [];
      goneList.forEach((g, gi) => {
        const ci = Math.floor(g.lat / CLA), cj = Math.floor(g.lon / CLO); const gb = g.e[2], gAbs = gb != null && !(g.e[3] & F_BATREL);
        const strict = !periodic(g.srcN); let stn = null; // Wechsel je Fahrt: nur strenge Paarung
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const ai of grid.get(`${ci + di}:${cj + dj}`) || []) {
          const a = appeared[ai]; if (a.v.operator !== g.opN || a.ty !== g.e[4]) continue;
          const d = haversineM(g.lat, g.lon, a.v.lat, a.v.lon); if (d > ROTATE_ENERGY_M) continue;
          const kind = pairKind(gb, a.bat, d, gAbs && a.abs, tolRun); if (!kind) continue;
          if (strict && kind === 'rot' && !(d <= STRICT_ROT_M && gb != null && a.bat != null && gb === a.bat && !(stn ??= atStation(g.opN, g.lat, g.lon)))) continue;
          pairs.push([kind === 'swap' ? d + 100 : d + (gb != null && a.bat != null ? 10 * Math.abs(gb - a.bat) : 0), gi, ai, kind]);
        }
      });
      pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
      for (const [, gi, ai, kind] of pairs) { const g = goneList[gi], a = appeared[ai]; if (g.match || a.used) continue; g.match = { a, kind }; a.used = true; }
    }
    // Massenwechsel je Quelle vor dem Zählen (gepaarte Kennungswechsel zählen zur Flotte, nicht als neu/verschwunden)
    const rotS = {}, newU = {}, goneU = {};
    for (const g of goneList) { if (g.match) { const k = CS(g.match.a.v.sourceId); rotS[k] = (rotS[k] || 0) + 1; } else { const k = CS(g.srcN); goneU[k] = (goneU[k] || 0) + 1; } }
    for (const a of appeared) if (!a.used) { const k = CS(a.v.sourceId); newU[k] = (newU[k] || 0) + 1; }
    const fleetOf = (src) => (srcRun[src]?.present || 0) + (rotS[src] || 0);
    for (const [src, n] of Object.entries(newU)) if (n >= MASS_MIN && n > MASS_SHARE * (fleetOf(src) + n)) massNew.add(src);
    for (const [src, n] of Object.entries(goneU)) if (n >= MASS_MIN && n > MASS_SHARE * (fleetOf(src) + n)) massGone.add(src);
    for (const g of goneList) {
      const { key, e } = g;
      const [lat, lon, bat, flags, ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src] = e;
      const h = H(g.opN, g.agsN, ty);
      if (g.match) {
        // dasselbe Fahrzeug unter neuer Kennung: Standzeit und erste Sichtung übernehmen
        const ne = state.v[g.match.a.key]; const s = S(g.srcN); s.gone--; s.rotated = (s.rotated || 0) + 1; S(g.match.a.v.sourceId).newc--; // Wechsel ist weder neu noch verschwunden
        ne[7] = firstSeen; ne[8] = lastMoved;
        if (g.match.kind === 'swap') { h.swap[hour]++; if (lowSince) { h.swapWaitSum += now - lowSince; h.swapWaitN++; if (cens(lowSince, firstSeen)) h.swapWaitCens++; } ne[9] = 0; }
        else { h.rot[hour]++; if (!ne[9] && lowSince) ne[9] = lowSince; if (!ne[10] && disSince && g.match.a.v.disabled) ne[10] = disSince; }
        delete state.v[key]; continue;
      }
      // Massenverschwinden einer Quelle (Teilausfall): kein Fahrtbeginn, Kennung still behalten (Rückkehr zählt kein Fahrtende)
      if (massGone.has(CS(g.srcN))) { S(g.srcN).gone--; state.v[key] = [lat, lon, bat, flags | F_MISSING | F_SILENT, ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src, now]; continue; }
      const gcell = cellOf(g.lat, g.lon), c = CELL(g.agsN, gcell);
      const dep = { op: g.opN, ty, ags: g.agsN, lat: g.lat, lon: g.lon, src: g.srcN };
      const absBat = bat != null && !(flags & F_BATREL), fl = floorOf(g.srcN);
      if (flags & F_DISABLED) { h.pickup[hour]++; }
      // Quelle blendet unter fl aus (Z4): Verschwinden bis fl + 5 Punkte = Ausblendung, keine Ausleihe (vor der Abholschwelle, die sonst einen Teil davon nähme)
      else if (absBat && fl != null && bat <= fl + HIDE_BAND && !(flags & F_RESERVED)) { h.hide[hour]++; }
      else if (absBat && bat < PICKUP_BATTERY) { h.pickup[hour]++; }
      else { h.start[hour]++; c[0]++; c[4 + band]++; if (modeOf(g.srcN) !== 'stable') estS.push([dep, g.opN, ty, g.agsN, gcell, g.srcN]); }
      departures.push(dep);
      state.v[key] = [lat, lon, bat, flags | F_MISSING | (gap ? F_SILENT : 0), ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src, now];
    }
    // übrige neue Kennungen = Fahrtende bzw. Neuaufstellung
    for (const a of appeared) {
      if (a.used || massNew.has(CS(a.v.sourceId))) continue; // Massenwechsel: neue Kennungen nur anlegen (Rückkehr nach Ausfall ist kein Fahrtende)
      H(a.v.operator, a.v.ags, a.ty).end[hour]++; a.c[1]++; a.c[16 + band]++;
      const arr = { op: a.v.operator, ty: a.ty, ags: a.v.ags, lat: a.v.lat, lon: a.v.lon, src: a.v.sourceId, bat: a.abs ? a.bat : null }; arrivals.push(arr);
      if (modeOf(a.v.sourceId) !== 'stable') estE.push([arr, a.v.operator, a.ty, a.v.ags, cellOf(a.v.lat, a.v.lon), a.v.sourceId]);
    }
  }
  // --- Quellenstatistik (rollierend, gedämpft; Lücken-Läufe verzerren den Kennungsmodus und zählen nicht) ---
  if (!gap) for (const [src, s] of Object.entries(srcRun)) {
    const st = (state.srcStats[src] ??= { runs: 0, present: 0, gone: 0, moved: 0, newc: 0, returned: 0, rotated: 0 });
    st.runs++; for (const f of ['present', 'gone', 'moved', 'newc', 'returned', 'rotated']) st[f] = Math.round((st[f] || 0) * 0.9 + (s[f] || 0));
  }
  const srcModes = {}; for (const src of Object.keys(state.srcStats)) srcModes[src] = modeOf(src);
  for (const r of sourceRecs || []) srcModes[r.id] = modeOf(r.id); // je Quelle (Kopien mit dem Modus ihres Ursprungsfeeds)

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
  // neue Kennungen nach dem Abgleich: ungepaart = Standzeit 0 (zählt für die Prüfung, nicht in den Klassen), per Kennungswechsel gepaart = Standzeit
  // des Vorgängers (in den Klassen; bis 02.11.2026 fehlten Quellen mit Wechsel in jedem Lauf wie Lime Frankfurt ganz in idle.json)
  for (const n of newAvail) { const e2 = state.v[n.key]; if (!e2) continue; const ms = now - e2[8], q = IS(n.v.sourceId); q[0]++; if (dt != null && ms < dt) q[1]++; if (e2[8] !== now) idleRows.push({ v: n.v, ty: n.ty, idle: ms, bat: n.bat, c: cens(e2[8], e2[7]) }); }
  // Standzeit-Plausibilität je Quelle (Z5): nur in zählenden Läufen neu bestimmt (nach Lücken bewegen sich mehr Fahrzeuge), sonst Stand des Vorlaufs
  if (!first && !gap) { const bad = {}; for (const [src, [n, sh]] of Object.entries(idleSrc)) if (n >= IDLE_CHECK.minN && sh / n > IDLE_CHECK.maxShort) bad[src] = { n, short: sh, share: +(sh / n).toFixed(3) }; state.idleBad = bad; }
  const idleUnusable = state.idleBad || {};
  // Standzeit-Klassen je Gruppe [b0..b5, n] und zensierte je Klasse [c0..c5] (nur Gruppen mit zensierten Werten); lange Standzeiten ab 48 h
  const idle = {}, idleCens = {}, idleLong = [], NB = IDLE_BUCKETS.length + 1;
  for (const { v, ty, idle: ms, bat, c } of idleRows) {
    if (idleUnusable[v.sourceId]) continue;
    const k = `${v.ags}|${v.operator}|${ty}`;
    const a = (idle[k] ??= new Array(NB + 1).fill(0)); let b = IDLE_BUCKETS.findIndex(lim => ms < lim); if (b < 0) b = IDLE_BUCKETS.length; a[b]++; a[NB]++;
    if (c) (idleCens[k] ??= new Array(NB).fill(0))[b]++;
    if (ms >= IDLE_BUCKETS[3]) idleLong.push({ ags: v.ags, op: v.operator, ty, lat: +v.lat.toFixed(5), lon: +v.lon.toFixed(5), hours: Math.round(ms / 3600e3), bat, ...(c ? { censored: 1 } : {}) });
  }
  // Gruppen: ≥ GROUP_MIN Fahrzeuge eines Anbieters tauchen in einem Lauf ≤ GROUP_M beieinander auf (Ausbringen)
  // bzw. verschwinden zusammen (Einsammeln). Quellen mit Massenwechsel (Ausfall, Neustart) zählen nicht.
  // newc/gone ohne gepaarte Kennungswechsel; Flotte = präsent + gewechselt + neu (Quellen, die jede Kennung je Lauf wechseln, sind kein Massenwechsel)
  const glitch = new Set([...massNew, ...massGone, ...Object.entries(srcRun).filter(([, r]) => (r.newc + r.gone) > MASS_SHARE * Math.max(1, r.present + (r.rotated || 0) + r.newc)).map(([k]) => k)]);
  // an einer eigenen Dockstation (≤ 30 m, nicht virtuell) sind gemeinsame Ankünfte/Abgänge Nutzerverkehr (Rückgaben, Ausleihen), keine Ausbringung (M-14).
  // Z7 (02.11.2026: 83 % der Gruppen waren nextbike, Spitzen wie der Fahrtengang 16–19 Uhr): stationsgebundene Systeme (≥ 50 % an eigenen
  // Stationen) auch an virtuellen Stationen ausschließen; sonst im Nachfrage-Hauptfenster (7–22 Uhr) nur Ausbringungen aus Fahrzeugen mit
  // absolutem Ladestand ≥ 85 % (≥ 4 zugleich) und keine Einsammlungen; nachts beides wie bisher
  const bound = (a) => { const sb = stBound.get(`${a.op}|${a.ags}`); return !!sb && sb[0] > 0 && sb[1] / sb[0] >= STATION_BOUND; };
  const night = isNightHour(hour);
  // Quellen mit unbrauchbarer Standzeit (Kennung wechselt je Lauf, Z5) bilden Scheingruppen: nextbike Köln/Bonn 814 der 1.634 Ereignisse bis 02.11.2026
  const groupable = (a) => !glitch.has(CS(a.src)) && !idleUnusable[a.src] && !(sgrid.size && nearStation(a.op, a.lat, a.lon, !bound(a)));
  const ffOk = (a, kind) => night || bound(a) || (kind === 'deploy' && a.bat != null && a.bat >= SWAP_TO);
  const groups = first || gap ? [] : [...clusterGroups(arrivals.filter(a => groupable(a) && ffOk(a, 'deploy')), 'deploy', now), ...clusterGroups(departures.filter(a => groupable(a) && ffOk(a, 'collect')), 'collect', now)];
  // Zählungen für die Schätzung: ohne Gruppenmitglieder (Ausbringen/Einsammeln) und ohne Quellen mit Massenwechsel
  if (!first && !gap) for (const [list, o] of [[estS, est.s], [estE, est.e]]) for (const [ref, op, ty, ags, cell, src] of list) if (!ref?.inGroup && !glitch.has(CS(src))) EST(o, `${op}|${ty}`, `${ags}|${cell}`);
  return { state, first, dt, gap, hourly, cells, idle, idleCens, idleLong, idleUnusable, srcModes, day, hour, groups, flows, est };
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
      near.forEach(q => { used.add(q); q.inGroup = true; }); // inGroup: zählt nicht als Fahrtbeginn/-ende der Schätzung
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
/**
 * Nachtanteil je Anbieter (Z7, Gütemaß der Gruppen-Erkennung): Betriebsfahrten liegen überwiegend außerhalb des Nachfrage-Hauptfensters
 * (Dott-Ausbringungen 58 % nachts), Nutzerverkehr an Stationen folgt dem Fahrtengang (nextbike vor dem 02.11.2026: 16 %).
 * rows = Zeilen nach GROUP_FIELDS; Rückgabe { Anbieter: { n, night, share } } (share = Anteil 22–7 Uhr Ortszeit, null unter 1 Ereignis).
 */
export function groupNight(rows, { since = null, tz = 'Europe/Berlin' } = {}) {
  const out = {};
  for (const r of rows || []) { if (!Array.isArray(r) || !Number.isFinite(r[0]) || (since != null && r[0] < since)) continue; const o = (out[r[2]] ??= { n: 0, night: 0, share: null }); o.n++; if (isNightHour(hourOf(r[0], tz))) o.night++; }
  for (const o of Object.values(out)) o.share = o.n ? +(o.night / o.n).toFixed(3) : null;
  return out;
}
/** Verzeichnis groups/index.json: months (aufsteigend), counts je Monat, Gesamtzahl, erstes/letztes Ereignis, Regeln der Erkennung, Nachtanteil je Anbieter (30 Tage) */
export function groupIndex(months, counts, { at = null, first = null, last = null, night = null } = {}) {
  const ms = [...new Set(months || [])].filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
  return { version: GROUP_VERSION, months: ms, counts: Object.fromEntries(ms.map(m => [m, counts?.[m] ?? 0])), events: ms.reduce((s, m) => s + (counts?.[m] ?? 0), 0), first, last, fields: GROUP_FIELDS, min: GROUP_MIN, radiusM: GROUP_M,
    rules: { demandMain: DEMAND_MAIN, stationBound: STATION_BOUND, deployMinBattery: SWAP_TO, since: '2026-11-02a' }, ...(night ? { night30: night } : {}), updatedAt: at };
}
export function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3); }

// Tagesdatei zusammenführen: bestehende Stundenwerte + neue
// runs[k] = [at, dt, flag, regelstand?]: 1 = Lauf zählt Ereignisse und Fahrzeugminuten, 0 = Lauf nach Lücke (> 45 Min.) bzw. ohne Zählung;
// regelstand = METHOD_VERSION@Commit (ältere Läufe ohne Angabe).
// gapHours = Stunden (tz) mit einem Lauf mit Flag 0: gestört → Seite zeigt sie grau und nimmt sie aus Hochrechnungen.
// Ältere Läufe mit dt > 45 Min. (vor der Lückenregel, Ereignisse wurden noch gezählt) werden nachträglich auf 0 gesetzt.
export function gapHoursOf(runs, tz = 'Europe/Berlin') { return [...new Set((runs || []).filter(r => r[2] === 0).map(r => hourOf(r[0], tz)))].sort((a, b) => a - b); }
export function mergeHourly(dayDoc, hourly, { day, at, dt, srcModes, gap = false, tz = 'Europe/Berlin', rule = null }) {
  const doc = dayDoc && dayDoc.day === day ? dayDoc : { day, runs: [], groups: {}, version: TRACK_VERSION };
  doc.runs.push(rule ? [at, dt, gap ? 0 : 1, rule] : [at, dt, gap ? 0 : 1]);
  const rules = [...new Set(doc.runs.map(r => r[3] ?? null))];
  if (rules.length > 1) doc.mixedRules = rules; else delete doc.mixedRules; // Tag mit mehreren Regelständen (null = vor der Kennzeichnung)
  for (const r of doc.runs) if (r[1] != null && r[1] > GAP_MS && r[2] !== 0) r[2] = 0;
  doc.gapHours = gapHoursOf(doc.runs, tz);
  doc.hourMin ??= hourMinutes(day, tz); // Minuten je Ortsstunde (Zeitumstellung: Stunde 2 = 120 bzw. 0)
  for (const [k, h] of hourly) {
    const g = doc.groups[k] || (doc.groups[k] = emptyHourly());
    for (const f of HOUR_FIELDS) { g[f] ??= arr(24); for (let i = 0; i < 24; i++) g[f][i] += h[f][i]; }
    for (const f of HOUR_SUMS) g[f] = (g[f] || 0) + (h[f] || 0); // ältere Tagesdateien ohne die Zensur-Zähler
  }
  doc.srcModes = srcModes;
  return doc;
}
// ---------- Altläufe in Zellendateien (vor der Lückenregel gezählt) ----------
// Die Lückenregel steht in events/ nachträglich (Flag 0, gapHours), Zellen sind dagegen Tagessummen ohne Laufbezug: Ein Lauf nach > 45 Min.,
// der noch gezählt hat (z. B. 01.11.2026 08:25 Uhr, 21.379 Fahrtbeginne in einem Lauf), steckt ganz im Band seiner Stunde. Ältere Zellendateien
// (ohne taintChecked) werden einmalig repariert: jedes Band mit einem Lauf > 45 Min. (laut events/<Tag>.json → runs) fällt für diesen Tag aus
// (Starts, Enden, Präsenz und Messminuten des Bands auf 0, bandTainted[b] = 1). Umsetzungen (Feld 3) haben keine Bandaufteilung und bleiben
// (relocUnrepaired). Neue Dateien zählen Lücken-Läufe nicht und brauchen keine Reparatur.
export const CELLS_TAINT_VERSION = 1;
/** Bänder mit einem Lauf nach Lücke (dt > 45 Min.); exclude = Zeitpunkt des laufenden Laufs (zählt ohnehin nicht) */
export function taintedBands(runs, { tz = 'Europe/Berlin', exclude = null } = {}) {
  const out = new Set();
  for (const r of runs || []) if (Array.isArray(r) && Number.isFinite(r[0]) && r[0] !== exclude && r[1] != null && r[1] > GAP_MS) out.add(bandOf(hourOf(r[0], tz)));
  return [...out].sort((a, b) => a - b);
}
/** Band b in { ags: { zelle: [...] } } neutralisieren (Summenfelder um den Bandanteil verringern) */
function neutralizeBand(munis, b) {
  for (const cells of Object.values(munis || {})) for (const c of Object.values(cells || {})) {
    if (!Array.isArray(c) || c.length < CELL_LEN) continue;
    c[0] = Math.max(0, (c[0] || 0) - (c[4 + b] || 0)); c[2] = Math.max(0, (c[2] || 0) - (c[10 + b] || 0)); c[1] = Math.max(0, (c[1] || 0) - (c[16 + b] || 0));
    c[4 + b] = 0; c[10 + b] = 0; c[16 + b] = 0;
  }
}
/**
 * Zellendatei (Tagesdatei { states: { Land: { ags: … } } } oder Landesdatei { munis: { ags: … } }) einmalig reparieren. runs = events/<Tag>.json → runs.
 * Rückgabe { doc, bands } (bands = neutralisierte Bänder; leer, wenn schon geprüft).
 */
export function repairCells(doc, runs, { tz = 'Europe/Berlin', exclude = null } = {}) {
  if (!doc || doc.taintChecked) return { doc, bands: [] };
  const bands = taintedBands(runs, { tz, exclude });
  const z = () => new Array(BANDS.length).fill(0);
  doc.bandMin ??= z(); doc.bandRuns ??= z(); doc.bandTainted ??= z();
  for (const b of bands) { for (const m of doc.states ? Object.values(doc.states) : [doc.munis]) neutralizeBand(m, b); doc.bandMin[b] = 0; doc.bandRuns[b] = 0; doc.bandTainted[b] = 1; }
  if (bands.length) doc.relocUnrepaired = true;
  doc.taintChecked = CELLS_TAINT_VERSION;
  return { doc, bands };
}
// ---------- Veröffentlichung der Zellen (M-11) ----------
// Eine je Lauf fortgeschriebene Zellendatei zeigt im Vergleich zweier Stände Start- und Zielzelle einzelner Fahrten. Daher: laufender Tag nur mit
// abgeschlossenen Tageszeit-Bändern (der Sammler veröffentlicht den privaten Arbeitsstand beim Bandwechsel), und in jeder veröffentlichten Datei
// Zelle × Band mit weniger als CELL_MIN Ereignissen (Beginne + Enden) unterdrückt; die unterdrückten Summen stehen je Gemeinde in below.
export const CELL_MIN = 3;
/**
 * Landesteil { ags: { zelle: [...] } } für die Veröffentlichung: Rückgabe { munis, below: { ags: [start×6, end×6] } } (neue Objekte, Eingabe bleibt).
 * Präsenz (Felder 2, 10–15) und Umsetzungen (Feld 3) bleiben; Feld 0/1 = Summe der veröffentlichten Bänder. Zellen ohne Werte entfallen.
 * Ältere Zellen ohne Bandfelder bzw. Anteile ohne Bandangabe: unter min → below als Summe ohne Band (Index 12/13).
 */
export function suppressCells(munis, { min = CELL_MIN } = {}) {
  const out = {}, below = {};
  const B = (ags) => (below[ags] ??= new Array(2 * BANDS.length + 2).fill(0));
  for (const [ags, cells] of Object.entries(munis || {})) {
    const m = {};
    for (const [cell, c0] of Object.entries(cells || {})) {
      if (!Array.isArray(c0)) continue;
      const c = c0.slice();
      if (c.length < CELL_LEN) { const n = (c[0] || 0) + (c[1] || 0); if (n > 0 && n < min) { const b = B(ags); b[12] += c[0] || 0; b[13] += c[1] || 0; c[0] = 0; c[1] = 0; } }
      else {
        // Anteil ohne Bandangabe (Läufe vor Einführung der Bandfelder): wie ein eigenes Band behandeln
        let b0 = 0, b1 = 0; for (let k = 0; k < BANDS.length; k++) { b0 += c[4 + k] || 0; b1 += c[16 + k] || 0; }
        let r0 = Math.max(0, (c[0] || 0) - b0), r1 = Math.max(0, (c[1] || 0) - b1);
        if (r0 + r1 > 0 && r0 + r1 < min) { const b = B(ags); b[12] += r0; b[13] += r1; r0 = 0; r1 = 0; }
        for (let k = 0; k < BANDS.length; k++) { const st = c[4 + k] || 0, en = c[16 + k] || 0; if (st + en > 0 && st + en < min) { const b = B(ags); b[k] += st; b[6 + k] += en; c[4 + k] = 0; c[16 + k] = 0; } }
        let s0 = r0, s1 = r1; for (let k = 0; k < BANDS.length; k++) { s0 += c[4 + k] || 0; s1 += c[16 + k] || 0; } c[0] = s0; c[1] = s1;
      }
      if (c.some(x => x)) m[cell] = c;
    }
    if (Object.keys(m).length) out[ags] = m;
  }
  return { munis: out, below };
}
// Zellen je Bundesland: { ags: { cell: [start,end,present,reloc] } }
// runs/at: Läufe des Tages aus events/<Tag>.json und Zeitpunkt dieses Laufs – ältere Dateien werden damit einmalig repariert (repairCells)
export function mergeCells(doc, cells, munis, day, { dt = null, hour = null, gap = false, runs = null, at = null } = {}) {
  const fresh = !(doc && doc.day === day);
  const out = fresh ? { day, version: TRACK_VERSION, states: {}, taintChecked: CELLS_TAINT_VERSION } : doc;
  if (!fresh && !out.taintChecked && runs) repairCells(out, runs, { exclude: at });
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
