// @ts-check
// Mobility Pulse — Fahrzeug-Verfolgung – ein Lauf: Fahrten, Umsetzungen, Akkutausch, Gruppen-Ereignisse (aus pulse-track.js geschnitten; pulse-track.js bleibt die Fassade für alle Importe).
import { haversineM, hashStr } from './pulse-core.js';
import { CAR_TRIPS, CELL_LEN, ENERGY_TOL, F_BATREL, F_DISABLED, F_MISSING, F_RESERVED, F_SILENT, GAP_MS, HIDE_BAND, IDLE_BUCKETS, IDLE_CHECK, JITTER_M, LOW_BATTERY, MASS_MIN, MASS_SHARE, MOVE_M, PERIODIC_RATE, REL_MIN_N, REL_MIN_SCALE, RETURN_SWAP, ROTATE_ENERGY_M, SHORT_TRIP_M, STATION_BOUND, STATION_ROT_M, STRICT_ROT_M, SWAP_FROM, SWAP_TO, TRACK_VERSION, TRANSPORT_M, bandOf, canonSource, cellOf, censorLimit, dayOf, dictIdx, emptyHourly, emptyState, hourOf, isCensored, isNightHour, pairKind, rulesOf, trackable, vehicleKey } from './pulse-track-rules.js';
import { daysBetween } from './pulse-track-publish.js';

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
// Kandidaten-Regeln (Sprint 1, Schattenbetrieb P4): next = NEXT_RULES aus lib/pulse-track-next.js schaltet sie ein; ohne next rechnet trackRun
// unverändert nach METHOD_VERSION. Abgelöst wird erst nach 7 vollen Tagen im Schatten (shadow/diff-<Tag>.json) und bestandenem Prüfstand.
//  S1.3 Hysterese: stabil ab Rückkehranteil > stableAbove, rotierend unter rotBelow, dazwischen bleibt der Modus (je Quelle in srcStats.modeH);
//       Wechsel stehen in result.modeChanges
//  A1   Taktmaß ohne Paarung: Anteil neuer Kennungen (gepaart oder nicht) an allen Kennungen des Laufs, statt nur gelungener Paarungen
//  S1.4 Wechsel je Fahrt, Fahrzeuge ohne Ladestand: Kennungswechsel ≤ STRICT_ROT_M (5 m) wird gepaart (bisher nie: Räder ohne Akku → Scheinfahrten)
//  A23  Modus ab minEvents (8 statt 20) Ereignissen im gedämpften Fenster; bis dahin Mehrheit der Quellen desselben Anbieters, sonst unbekannt
//  S1.5 Rückkehr einer stabilen Kennung, deren Verschwinden nicht als Fahrtbeginn zählte (Abholung, Ausblendung, Sperre): Wiederaufstellung, kein Fahrtende
//  S1.9 Dauer und Distanz („gemessen“) nur aus stabilen Kennungen; bei rotierenden Quellen ist eine Rückkehr derselben Kennung keine beobachtete Fahrt
//  A4/A21 Einsammeln/Ausbringen als Gruppe ab groupMin (3) Fahrzeugen ≤ 40 m: Umsetzung statt Fahrtbeginn bzw. -ende (Bedingungen beim Code)
//  A22  Lücken bis gapMaxMs (3 h) werden geschätzt statt verworfen (result.gapEstimated)
//  A3   Fahrtdauer als Intervall je stabiler Fahrt (result.durSpans), Schätzung per Lognormal-ML in pulse-econ durationFromSpans
//  A2   Kennungswechsel an Stationen: Quelle mit Wechsel je Fahrt und erhöhtem Wechselanteil (≥ stationChurnMin je Lauf), Fahrzeuge ohne Ladestand:
//       an der eigenen Station wird bis stationExactM (1,5 m, Auflösung des Zustands) gepaart. Die reine Bilanz (gleich viele Ab- und Zugänge = Wechsel) kostete im
//       Prüfstand 24 % echter Fahrten (Ausleihe und Rückgabe an derselben Station im selben Lauf) und bleibt verworfen.
const F_NOSTART = 32; // nur Kandidaten-Regeln: verschwunden ohne gezählten Fahrtbeginn (Abholung/Ausblendung/gesperrt)
export function trackRun(prev, { vehicles, stations, sourceRecs, now, tz = 'Europe/Berlin', hmac = null, noEvents = false, trace = null, next = null }) {
  const NX = next || null;
  const state = prev && prev.version === TRACK_VERSION ? prev : emptyState(now);
  if (hmac) state.salted = true;
  const CS = canonSource;
  // Umstieg auf kanonische Schlüssel: je Ursprungsfeed die Statistik mit den meisten Läufen übernehmen (Kopien sahen dieselben Fahrzeuge)
  if (!state.srcCanon) { const m = {}; for (const [id, st] of Object.entries(state.srcStats || {})) { const c = CS(id); if (!m[c] || (st?.runs || 0) > (m[c].runs || 0)) m[c] = st; } state.srcStats = m; state.srcCanon = 1; }
  const first = state.at == null;
  const dt = first ? null : now - state.at;
  // Kandidat A22: Lücke bis gapMaxMs wird geschätzt statt verworfen (Ereignisse zählen, Ergebnis gapEstimated; Dauer zählt nicht, Fahrzeugminuten
  // bleiben auf 45 Min. gedeckelt). Bisher kosteten zwei Lücken von 65 und 90 Min. zur Spitzenzeit rund 20 % der Tagesfahrten.
  const gapEst = !!NX?.gapMaxMs && !noEvents && dt != null && dt > GAP_MS && dt <= NX.gapMaxMs;
  const gap = ((dt != null && dt > GAP_MS) || (!!noEvents && !first)) && !gapEst;
  // Prüfstand (P1): optionaler Rückruf je Zählstelle { k, key, now, gap, … }; ändert keine Regel (test/algo-bench.test.mjs)
  const L = trace ? (k, key, x) => trace({ k, key, now, gap, ...(x || {}) }) : () => {};
  // Kandidat A3: Dauer als Intervall statt Laufabstand – je Art Zählung der Intervalle [a, b) in Minuten ({ Art: { 'a|b': n } }), Schätzung in pulse-econ durationFromSpans
  const durSpans = {}; const SPAN = (ty, a, b) => { if (gap) return; const k = `${Math.round(a / 60e3)}|${Math.max(Math.round(a / 60e3) + 1, Math.round(b / 60e3))}`; const o = (durSpans[ty] ??= {}); o[k] = (o[k] || 0) + 1; };
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
  // Zellen (Nachfrage-Modell der Disposition, alle Arten zusammen) ohne Autos: stationsgebundene Autos stünden als Dauer-Bestand in den Zellen
  const CELL = (ags, cell, ty) => { if (gap || ty === 'car') return voidC; if (!cells.has(ags)) cells.set(ags, new Map()); const m = cells.get(ags); if (!m.has(cell)) m.set(cell, new Array(CELL_LEN).fill(0)); return m.get(cell); };
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
  const resEv = []; // Carsharing: Buchungswechsel (reserviert) je Fahrzeug, gezählt nach der Massenprüfung je Quelle
  const dict = state.dict;
  const D = (name, v) => dictIdx(dict, name, v);
  const seen = new Set();
  const srcRun = {}; // kanonische Quelle → {present, gone, moved, newc, returned, rotated}
  const S = (src) => (srcRun[CS(src)] ??= { present: 0, gone: 0, moved: 0, newc: 0, returned: 0 });
  // Kennungsmodus je Quelle aus bisherigen Läufen: stabil, wenn Kennungen wiederkehren oder sich bewegen
  const modeOf0 = (src) => { const st = state.srcStats[CS(src)]; if (!st || st.runs < 2) return 'unknown'; const ret = st.returned + st.moved, gone = st.gone; if (ret + gone < 20) return 'unknown'; return ret / (ret + gone) > 0.25 ? 'stable' : 'rotating'; };
  // Kandidaten (S1.3, A23): Modus aus dem vorigen Lauf (Hysterese, unten fortgeschrieben), sonst Mehrheit der Quellen desselben Anbieters
  let opModes = null;
  const opModeOf = (op) => { if (!opModes) { opModes = new Map(); for (const st of Object.values(state.srcStats)) if (st?.op && st.modeH) { const m = opModes.get(st.op) || { stable: 0, rotating: 0 }; m[st.modeH]++; opModes.set(st.op, m); } } const m = opModes.get(op); return !m ? null : m.stable > m.rotating ? 'stable' : m.rotating > m.stable ? 'rotating' : null; };
  const modeOf = !NX ? modeOf0 : (src) => { const st = state.srcStats[CS(src)]; return st?.modeH || (st?.op && opModeOf(st.op)) || 'unknown'; };
  const rotRate = (src) => { const st = state.srcStats[CS(src)]; if (!st || st.runs < 3) return null;
    if (NX) { const base = (st.present || 0) + (st.newc || 0) + (st.rotated || 0); return base >= 10 ? ((st.newc || 0) + (st.rotated || 0)) / base : null; } // A1: ohne Paarung
    const base = (st.present || 0) + (st.rotated || 0); return base >= 10 ? (st.rotated || 0) / base : null; };
  const periodic = (src) => { const r = rotRate(src); return r == null || r >= PERIODIC_RATE; };
  // Anteil neuer Kennungen (gepaart oder nicht) je Lauf, unabhängig vom Regelstand (Kandidat A2: Kennungswechsel an Stationen erkennen)
  const churnRate = (src) => { const st = state.srcStats[CS(src)]; if (!st || st.runs < 3) return 0; const base = (st.present || 0) + (st.newc || 0) + (st.rotated || 0); return base >= 10 ? ((st.newc || 0) + (st.rotated || 0)) / base : 0; };
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
  /** @type {any[]} */ const appeared = []; // neue Kennungen: erst nach dem Abgleich mit verschwundenen als Fahrtende zählen
  // Skala des relativen Ladestands je Quelle (95. Perzentil der Fingerabdrücke ohne absolut verwendbaren Ladestand)
  const relScale = new Map();
  { const vals = new Map();
    for (const v of vehicles) { if (!trackable(v) || (v.batteryPct != null && !v.batteryDerived)) continue; const r = v.batteryFp != null && Number.isFinite(v.batteryFp) ? v.batteryFp : v.batteryDerived && v.batteryPct != null ? v.batteryPct : null; if (r == null) continue; const k = CS(v.sourceId); let a = vals.get(k); if (!a) vals.set(k, a = []); a.push(r); }
    for (const [k, a] of vals) { if (a.length < REL_MIN_N) continue; a.sort((x, y) => x - y); const p = a[Math.floor(0.95 * (a.length - 1))]; if (p >= REL_MIN_SCALE) relScale.set(k, p); } }
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
    const relSc = bat == null ? relScale.get(CS(v.sourceId)) ?? null : null; // Skala, wenn nur der relative Ladestand vorliegt
    let flags = (v.disabled ? F_DISABLED : 0) | (v.reserved ? F_RESERVED : 0) | (bat == null && fp != null ? F_BATREL : 0);
    const op = D('op', v.operator), ags = D('ags', v.ags), src = D('src', v.sourceId || ''), ty = v.type || 'unknown', RU = rulesOf(ty);
    const e = state.v[key];
    const s = S(v.sourceId); if (NX && !s.op) s.op = v.operator;
    const cell = cellOf(v.lat, v.lon);
    const c = CELL(v.ags, cell, ty);
    if (!v.disabled && !v.reserved) {
      c[2]++; c[10 + band]++; // präsent (verfügbar)
      if (sgrid.size) { const bk = `${v.operator}|${v.ags}`; const sb = stBound.get(bk) || [0, 0]; sb[0]++; if (nearStation(v.operator, v.lat, v.lon)) sb[1]++; stBound.set(bk, sb); }
    }
    if (dtMin) { const hh = H(v.operator, v.ags, ty); hh.vminTot[hour] += dtMin; if (!v.disabled && !v.reserved) hh.vmin[hour] += dtMin; }
    if (!e) {
      // neu aufgetaucht: Fahrtende (rotierende Kennungen) bzw. Neuaufstellung – Zählung nach dem Abgleich unten
      s.newc++;
      state.v[key] = [lat, lon, fp, flags, ty, op, ags, now, now, (bat != null ? bat < LOW_BATTERY : fp != null && relSc != null && fp < LOW_BATTERY / 100 * relSc) ? now : 0, v.disabled ? now : 0, src, 0];
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
    const retSwap = RU.swap && wasMissing && !silent && dist <= JITTER_M && fp != null && pbat != null && fp >= pbat + (bat == null && !pAbs && relSc ? RETURN_SWAP / 100 * relSc : RETURN_SWAP);
    if (silent) { /* nur Zustand fortschreiben */ }
    else if (NX && wasMissing && (pflags & F_NOSTART)) {
      // Kandidat S1.5: Verschwinden zählte nicht als Fahrtbeginn (Abholung, Ausblendung, gesperrt) → Rückkehr = Wiederaufstellung, kein Fahrtende
      s.returned++; L('redeploy', key, { dist, swap: retSwap });
      if (retSwap) h.swap[hour]++; else if (dist >= MOVE_M) h.reloc[hour]++;
    }
    else if (retSwap) {
      // zusätzlich ein Fahrtende: der Fahrtbeginn beim Verschwinden ist schon gezählt (ohne Verknüpfung über Tage nicht zurücknehmbar); so bleiben
      // Beginne ÷ Enden ausgeglichen, die Scheinfahrt bleibt eine bekannte Obergrenze wie vor Z4 (bis 02.11.2026: swap ohne end → Ampel S/E verschoben)
      L('retswap', key, { dist }); s.returned++; h.swap[hour]++; if (lowSince) { h.swapWaitSum += now - lowSince; h.swapWaitN++; if (cens(lowSince, firstSeen)) h.swapWaitCens++; }
      h.end[hour]++; c[1]++; c[16 + band]++; if (!stable) estE.push([null, v.operator, ty, v.ags, cell, v.sourceId]);
    }
    else if (wasMissing) {
      // Rückkehr einer bekannten Kennung = Fahrtende mit bekanntem Start (stabile Kennungen); Dauer > 2 h fließt nicht in Ø Dauer/Distanz
      s.returned++;
      h.end[hour]++; c[1]++; c[16 + band]++;
      if (!stable) estE.push([null, v.operator, ty, v.ags, cell, v.sourceId]);
      const dur = now - (missingSince || state.at || now); L('ret', key, { dist, dur, stable });
      if (NX && stable && dist >= JITTER_M && dur <= RU.tripMaxMs && dt != null) SPAN(ty, Math.max(0, dur - dt), dur + dt); // A3: Dauer liegt zwischen (dur − Laufabstand, dur + Laufabstand)
      if (NX && !stable) { /* Kandidat S1.9: gemessene Dauer und Distanz nur aus stabilen Kennungen (rotierend: Rückkehr ist keine beobachtete Fahrt) */ }
      else if (dist >= JITTER_M && dur <= RU.tripMaxMs) { h.tripDistSum += dist; h.tripDistN++; h.tripDurSum += dur; h.tripDurN++; }
      else if (RU.roundTrip && dur <= RU.tripMaxMs && dur > 0) { h.tripDurSum += dur; h.tripDurN++; } // Rundfahrt (Auto zurück an der Station): nur die Dauer
      if (stable && dist >= MOVE_M) landed.push({ op: v.operator, lat: v.lat, lon: v.lon });
      // Strom nur, wenn das Verschwinden als Fahrtbeginn galt (nicht gesperrt, Akku ≥ 15 %) und das Fahrzeug nicht aufgeladen zurückkommt
      if (stable && dist >= MOVE_M && dur <= RU.tripMaxMs && !v.disabled && !(pflags & F_DISABLED) && !(pAbs && pbat < RU.pickupBattery) && !(fp != null && pbat != null && fp > pbat + ENERGY_TOL))
        rets.push({ op: v.operator, ty, ags: dict.ags[pags], toAgs: v.ags, from: cellOf(plat / 1e5, plon / 1e5), to: cell, lat: v.lat, lon: v.lon, dist, dur, noLoss: fp != null && pbat != null && fp >= pbat && dist >= RU.noLossM });
    } else if (dist >= MOVE_M && RU.resTrips && (v.reserved || (pflags & F_RESERVED))) {
      s.moved++; // gebuchtes Auto an anderem Ort: Fahrt über die Buchung gezählt (Beginn bei „reserviert“, Ende bei „frei“)
    } else if (dist >= MOVE_M) {
      s.moved++;
      if (stable && !v.disabled && !(pflags & F_DISABLED)) {
        // stabile Kennungen bleiben während der Fahrt im Feed: Versatz = Fahrt (Start am alten Ort), außer Sammeltransport usw. (unten)
        const m = { key, op: v.operator, ty, ags: v.ags, agsOld: dict.ags[pags], cellOld: cellOf(plat / 1e5, plon / 1e5), c, lat: v.lat, lon: v.lon, dist, pbat, bat: fp, babs: bat, src: v.sourceId };
        moves.push(m); landed.push(m);
      } else {
        // rotierende Kennungen (Fahrten entfernen das Fahrzeug aus dem Feed) bzw. gesperrt: Umsetzung durch den Betreiber
        L('reloc', key, { dist, why: stable ? 'disabled' : 'nonstable' }); h.reloc[hour]++; c[3]++;
        arrivals.push({ op: v.operator, ty, ags: v.ags, lat: v.lat, lon: v.lon, src: v.sourceId, bat }); // bat: absoluter Ladestand (Gruppen ≥ 85 %, Z7)
      }
    }
    // Rückkehr-Tausch am Ort: Standzeit läuft weiter (wie Tausch unter neuer Kennung); stille Rückkehr (Ausfall, Lücke, Massenverschwinden) am Ort
    // ebenso – bis 02.11.2026 begann die Standzeit nach jedem Quellenausfall neu und die Quelle galt danach als „Standzeit unbrauchbar“ (Z5)
    // Carsharing-Buchung (RU.resTrips): Zeitpunkt des Buchungsbeginns steht bei reservierten Autos im Feld 12 (sonst Zeitpunkt des Verschwindens)
    let resSince = !wasMissing && (pflags & F_RESERVED) ? missingSince || 0 : 0, resEnd = false;
    if (RU.resTrips && !silent && !wasMissing && !v.disabled) {
      const was = !!(pflags & F_RESERVED);
      if (v.reserved && !was) { resEv.push({ src: v.sourceId, h, kind: 'start' }); resSince = now; }
      else if (!v.reserved && was) { resEv.push({ src: v.sourceId, h, kind: 'end', dur: resSince ? now - resSince : null, dist, maxMs: RU.tripMaxMs }); resEnd = true; resSince = 0; }
    }
    const moved = !retSwap && (dist >= JITTER_M || (wasMissing && !silent) || resEnd);
    const newLastMoved = moved ? now : lastMoved;
    // Akkutausch: deutlicher Sprung nach oben am selben Ort
    let newLowSince = retSwap ? 0 : lowSince;
    if (bat != null) {
      if (RU.swap && pAbs && pbat < SWAP_FROM && bat >= SWAP_TO && dist < MOVE_M && !wasMissing) { L('swap', key); h.swap[hour]++; if (lowSince) { h.swapWaitSum += now - lowSince; h.swapWaitN++; if (cens(lowSince, firstSeen)) h.swapWaitCens++; } newLowSince = 0; }
      else if (bat < LOW_BATTERY) { if (!newLowSince) newLowSince = now; }
      else if (bat >= SWAP_TO) newLowSince = 0;
    }
    else if (fp != null && relSc) {
      // relativer Ladestand (Lime: aus der Reichweite): dieselben Schwellen als Anteil der Skala der Quelle, Sprung am Ort ohne Fahrt = Tausch
      const lo = SWAP_FROM / 100 * relSc, hi = SWAP_TO / 100 * relSc;
      if (RU.swap && pbat != null && !pAbs && pbat < lo && fp >= hi && dist < MOVE_M && !wasMissing) { h.swap[hour]++; if (lowSince) { h.swapWaitSum += now - lowSince; h.swapWaitN++; if (cens(lowSince, firstSeen)) h.swapWaitCens++; } newLowSince = 0; }
      else if (fp < LOW_BATTERY / 100 * relSc) { if (!newLowSince) newLowSince = now; }
      else if (fp >= hi) newLowSince = 0;
    }
    // Sperren
    let newDisSince = disSince;
    const wasDis = !!(pflags & F_DISABLED);
    if (v.disabled && !wasDis) { L('disOn', key); h.disOn[hour]++; newDisSince = now; }
    else if (!v.disabled && wasDis) { L('disOff', key); h.disOff[hour]++; if (disSince) { h.disDurSum += now - disSince; h.disDurN++; if (cens(disSince, firstSeen)) h.disDurCens++; } newDisSince = 0; }
    else if (v.disabled && !newDisSince) newDisSince = now;
    state.v[key] = [lat, lon, fp ?? pbat, flags | (fp == null && (pflags & F_BATREL) ? F_BATREL : 0), ty, op, ags, firstSeen, newLastMoved, newLowSince, newDisSince, src, RU.resTrips && v.reserved ? resSince || now : 0];
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
      const near = nearOf(m), RU = rulesOf(m.ty); // zählt m selbst mit
      const noLoss = m.pbat != null && m.bat != null && m.bat >= m.pbat && m.dist >= RU.noLossM;
      const h = H(m.op, m.ags, m.ty);
      if (near >= RU.transportMin || noLoss) { L('reloc', m.key, { dist: m.dist, why: noLoss ? 'noloss' : 'transport' }); h.reloc[hour]++; m.c[3]++; arrivals.push({ op: m.op, ty: m.ty, ags: m.ags, lat: m.lat, lon: m.lon, src: m.src, bat: m.babs }); continue; }
      // Versatz innerhalb eines Laufs: die echte Dauer ist ≤ dt, eine Untergrenze auf Luftlinie ÷ dt verwürfe alle Fahrten unter ≈ 1,2 km (20 Min.).
      // Daher nur die Obergrenze; kurze Versätze (< 500 m) ohne Ladestandverlust bleiben GPS-Sprung (slow). TRIP_MIN_KMH gilt nur für Rückkehrer.
      const v = kmh(m);
      if (v > RU.tripMaxKmh) { L('fast', m.key, { dist: m.dist }); h.fast[hour]++; arrivals.push({ op: m.op, ty: m.ty, ags: m.ags, lat: m.lat, lon: m.lon, src: m.src, bat: m.babs }); continue; }
      if (m.dist < SHORT_TRIP_M && !(m.pbat != null && m.bat != null && m.bat < m.pbat)) { L('slow', m.key, { dist: m.dist }); h.slow[hour]++; continue; }
      L('move', m.key, { dist: m.dist, dur: dt }); if (NX && !gapEst) SPAN(m.ty, 0, dt); /* A3: Versatz zwischen zwei Läufen, Dauer in [0, Laufabstand) */ H(m.op, m.agsOld, m.ty).start[hour]++; const co = CELL(m.agsOld, m.cellOld, m.ty); co[0]++; co[4 + band]++;
      h.end[hour]++; m.c[1]++; m.c[16 + band]++;
      if (!gapEst) { h.tripDistSum += m.dist; h.tripDistN++; h.tripDurSum += dt; h.tripDurN++; } // Dauer ≤ dt (Obergrenze); nach geschätzter Lücke ohne Dauer
      FLOW(m.agsOld, m.op, m.ty, m.cellOld, cellOf(m.lat, m.lon), dt, m.dist, m.ags, now);
    }
    // Rückkehrer: Sammeltransport (≥ 3 Ankünfte ≤ 40 m), ≥ 2 km ohne Ladestandverlust oder selbst bei längster möglicher Dauer (seit Verschwinden + Laufintervall) > 24 km/h = kein Strom
    for (const r of rets) {
      const RU = rulesOf(r.ty);
      if (nearOf(r) >= RU.transportMin || r.noLoss || (r.dist / 1000) / ((r.dur + dt) / 3600e3) > RU.tripMaxKmh) continue;
      FLOW(r.ags, r.op, r.ty, r.from, r.to, r.dur, r.dist, r.toAgs, now - r.dur);
    }
  }
  // --- Carsharing-Buchungen zählen (Massenregel je Quelle: auf einen Schlag viele Autos reserviert bzw. frei = Feedfehler) ---
  if (resEv.length) {
    const nRes = {}; for (const r of resEv) { const k = `${CS(r.src)}|${r.kind}`; nRes[k] = (nRes[k] || 0) + 1; }
    for (const r of resEv) {
      const n = nRes[`${CS(r.src)}|${r.kind}`], fleet = S(r.src).present || 0; if (n >= MASS_MIN && n > MASS_SHARE * fleet) continue;
      S(r.src).resc = (S(r.src).resc || 0) + 1;
      if (r.kind === 'start') r.h.start[hour]++;
      else { r.h.end[hour]++; if (r.dur != null && r.dur > 0 && r.dur <= r.maxMs) { r.h.tripDurSum += r.dur; r.h.tripDurN++; } if (r.dist >= JITTER_M) { r.h.tripDistSum += r.dist; r.h.tripDistN++; } }
    }
  }
  // --- Verschwundene Fahrzeuge ---
  /** @type {any[]} */ const goneList = [];
  const massNew = new Set(), massGone = new Set();
  if (!first) {
    for (const [key, e] of Object.entries(state.v)) {
      if (seen.has(key)) continue;
      const flags = e[3];
      if (flags & F_MISSING) { if (now - e[12] > rulesOf(e[4]).missingKeepMs) delete state.v[key]; continue; }
      const srcN = dict.src[e[11]];
      // fehlt der Quellen-Datensatz (Manifest ausgefallen, Quelle aus dem Katalog entfernt), gilt die Quelle als ausgefallen
      const srcUsable = usableCanon.has(CS(srcN));
      // Quelle ausgefallen: nicht als Fahrt werten, Kennung still behalten (Rückkehr zählt kein Fahrtende)
      if (!srcUsable) { L('srcdown', key); e[3] = flags | F_MISSING | F_SILENT; e[12] = now; continue; }
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
          const kind = pairKind(gb, a.bat, d, gAbs && a.abs, tolRun, !gAbs && !a.abs ? relScale.get(CS(a.v.sourceId)) : null, rulesOf(a.ty).swap); if (!kind) continue;
          if (strict && kind === 'rot' && !(d <= STRICT_ROT_M && ((gb != null && a.bat != null && gb === a.bat) || (NX && gb == null && a.bat == null))
            && (!(stn ??= atStation(g.opN, g.lat, g.lon)) || (NX && gb == null && a.bat == null && d <= NX.stationExactM && churnRate(g.srcN) >= NX.stationChurnMin)))) continue;
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
    const MS = NX?.massShare ?? MASS_SHARE; // Kandidat S1.9: Teilausfall ab 15 % der Flotte (bisher 30 %: 20–29 % fehlende Fahrzeuge zählten als Fahrten)
    for (const [src, n] of Object.entries(newU)) if (n >= MASS_MIN && n > MS * (fleetOf(src) + n)) massNew.add(src);
    for (const [src, n] of Object.entries(goneU)) if (n >= MASS_MIN && n > MS * (fleetOf(src) + n)) massGone.add(src);
    // Kandidat A4/A21: Einsammeln und Ausbringen als Gruppe (≥ groupMin Fahrzeuge eines Anbieters und einer Art ≤ GROUP_M beieinander im selben
    // Lauf, nicht an einer eigenen Dockstation): nachts immer, tagsüber Einsammeln nur bei Ladestand ≥ Median der Quelle, Ausbringen nur ≥ 85 %.
    // Eingesammelte zählen als Umsetzung statt Fahrtbeginn (ihre Rückkehr ist dann eine Wiederaufstellung, S1.5), ausgebrachte neue Kennungen
    // als Umsetzung statt Fahrtende.
    const collectKeys = new Set(), deployKeys = new Set();
    if (NX?.groupMin && !gap) {
      const isNight = isNightHour(hour), medBat = new Map();
      { const by = new Map(); for (const v of vehicles || []) if (Number.isFinite(v.batteryPct)) { const k = CS(v.sourceId); (by.get(k) || by.set(k, []).get(k)).push(v.batteryPct); } for (const [k, a] of by) { a.sort((x, y) => x - y); medBat.set(k, a[a.length >> 1]); } }
      const clusters = (pts, keyOf, R = GROUP_M) => { const by = new Map(); for (const p of pts) { const k = `${p.op}|${p.ty}`; (by.get(k) || by.set(k, []).get(k)).push(p); }
        for (const list of by.values()) { if (list.length < NX.groupMin) continue; const used = new Set();
          for (const p of list) { if (used.has(p)) continue; const near = list.filter(q => !used.has(q) && haversineM(p.lat, p.lon, q.lat, q.lon) <= R); if (near.length < NX.groupMin) continue; for (const q of near) { used.add(q); keyOf.add(q.key); } } } };
      const dock = (op, la, lo) => sgrid.size && nearStation(op, la, lo, true);
      clusters(goneList.filter(g => !g.match && !massGone.has(CS(g.srcN)) && rulesOf(g.e[4]).groups && !(g.e[3] & (F_DISABLED | F_RESERVED)) && !dock(g.opN, g.lat, g.lon)
        && (isNight || (g.e[2] != null && !(g.e[3] & F_BATREL) && g.e[2] >= (medBat.get(CS(g.srcN)) ?? 101)))).map(g => ({ key: g.key, op: g.opN, ty: g.e[4], lat: g.lat, lon: g.lon })), collectKeys,
        isNight ? (NX.collectNightM ?? GROUP_M) : GROUP_M); // nachts sammelt ein Transporter auch verstreut ein (wenige Ausleihen, kaum Gruppenfahrten)
      clusters(appeared.filter(a => !a.used && !massNew.has(CS(a.v.sourceId)) && rulesOf(a.ty).groups && !dock(a.v.operator, a.v.lat, a.v.lon)
        && (isNight || (a.abs && a.bat != null && a.bat >= SWAP_TO))).map(a => ({ key: a.key, op: a.v.operator, ty: a.ty, lat: a.v.lat, lon: a.v.lon })), deployKeys);
    }
    for (const g of goneList) {
      const { key, e } = g;
      const [lat, lon, bat, flags, ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src] = e;
      const h = H(g.opN, g.agsN, ty);
      if (g.match) { L(g.match.kind, key, { newKey: g.match.a.key });
        // dasselbe Fahrzeug unter neuer Kennung: Standzeit und erste Sichtung übernehmen
        const ne = state.v[g.match.a.key]; const s = S(g.srcN); s.gone--; s.rotated = (s.rotated || 0) + 1; S(g.match.a.v.sourceId).newc--; // Wechsel ist weder neu noch verschwunden
        ne[7] = firstSeen; ne[8] = lastMoved;
        if (g.match.kind === 'swap') { h.swap[hour]++; if (lowSince) { h.swapWaitSum += now - lowSince; h.swapWaitN++; if (cens(lowSince, firstSeen)) h.swapWaitCens++; } ne[9] = 0; }
        else { h.rot[hour]++; if (!ne[9] && lowSince) ne[9] = lowSince; if (!ne[10] && disSince && g.match.a.v.disabled) ne[10] = disSince; }
        delete state.v[key]; continue;
      }
      // Massenverschwinden einer Quelle (Teilausfall): kein Fahrtbeginn, Kennung still behalten (Rückkehr zählt kein Fahrtende)
      if (massGone.has(CS(g.srcN))) { L('massgone', key); S(g.srcN).gone--; state.v[key] = [lat, lon, bat, flags | F_MISSING | F_SILENT, ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src, now]; continue; }
      const gcell = cellOf(g.lat, g.lon), c = CELL(g.agsN, gcell, ty);
      const dep = { op: g.opN, ty, ags: g.agsN, lat: g.lat, lon: g.lon, src: g.srcN };
      const absBat = bat != null && !(flags & F_BATREL), fl = floorOf(g.srcN);
      // gebuchtes Auto verschwindet: Fahrtbeginn schon bei „reserviert“ gezählt, Rückkehr zählt das Ende
      if (rulesOf(ty).resTrips && (flags & F_RESERVED)) { state.v[key] = [lat, lon, bat, flags | F_MISSING | (gap ? F_SILENT : 0), ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src, now]; continue; }
      let noStart = true;
      if (flags & F_DISABLED) { L('pickup', key, { why: 'disabled' }); h.pickup[hour]++; }
      // Quelle blendet unter fl aus (Z4): Verschwinden bis fl + 5 Punkte = Ausblendung, keine Ausleihe (vor der Abholschwelle, die sonst einen Teil davon nähme)
      else if (absBat && fl != null && bat <= fl + HIDE_BAND && !(flags & F_RESERVED)) { L('hide', key); h.hide[hour]++; }
      else if (absBat && bat < rulesOf(ty).pickupBattery) { L('pickup', key, { why: 'lowbat' }); h.pickup[hour]++; }
      else if (collectKeys.has(key)) { L('collect', key); h.reloc[hour]++; }
      else { noStart = false; L('start', key); h.start[hour]++; c[0]++; c[4 + band]++; if (modeOf(g.srcN) !== 'stable') estS.push([dep, g.opN, ty, g.agsN, gcell, g.srcN]); }
      departures.push(dep);
      state.v[key] = [lat, lon, bat, flags | F_MISSING | (gap ? F_SILENT : 0) | (NX && noStart ? F_NOSTART : 0), ty, op, ags, firstSeen, lastMoved, lowSince, disSince, src, now];
    }
    // übrige neue Kennungen = Fahrtende bzw. Neuaufstellung
    for (const a of appeared) {
      if (a.used) continue; if (massNew.has(CS(a.v.sourceId))) { L('massnew', a.key); continue; } // Massenwechsel: neue Kennungen nur anlegen (Rückkehr nach Ausfall ist kein Fahrtende)
      if (deployKeys.has(a.key)) { L('deploy', a.key); H(a.v.operator, a.v.ags, a.ty).reloc[hour]++; arrivals.push({ op: a.v.operator, ty: a.ty, ags: a.v.ags, lat: a.v.lat, lon: a.v.lon, src: a.v.sourceId, bat: a.abs ? a.bat : null }); continue; }
      L('new', a.key); H(a.v.operator, a.v.ags, a.ty).end[hour]++; a.c[1]++; a.c[16 + band]++;
      const arr = { op: a.v.operator, ty: a.ty, ags: a.v.ags, lat: a.v.lat, lon: a.v.lon, src: a.v.sourceId, bat: a.abs ? a.bat : null }; arrivals.push(arr);
      if (modeOf(a.v.sourceId) !== 'stable') estE.push([arr, a.v.operator, a.ty, a.v.ags, cellOf(a.v.lat, a.v.lon), a.v.sourceId]);
    }
  }
  // --- Quellenstatistik (rollierend, gedämpft; Lücken-Läufe verzerren den Kennungsmodus und zählen nicht) ---
  if (!gap) for (const [src, s] of Object.entries(srcRun)) {
    const st = (state.srcStats[src] ??= { runs: 0, present: 0, gone: 0, moved: 0, newc: 0, returned: 0, rotated: 0 });
    st.runs++; for (const f of ['present', 'gone', 'moved', 'newc', 'returned', 'rotated']) st[f] = Math.round((st[f] || 0) * 0.9 + (s[f] || 0));
    if (NX && s.op) st.op = s.op;
  }
  // Kandidaten S1.3: Modus mit Hysterese je Quelle fortschreiben, Wechsel protokollieren (result.modeChanges: [Quelle, alt, neu, Rückkehranteil])
  const modeChanges = [];
  if (NX && !gap) for (const src of Object.keys(srcRun)) {
    const st = state.srcStats[src]; if (!st || st.runs < 2) continue;
    const ret = st.returned + st.moved, gone = st.gone; if (ret + gone < (NX.minEvents ?? 20)) continue;
    const r = ret / (ret + gone), old = st.modeH || null;
    const nw = r > NX.stableAbove ? 'stable' : r < NX.rotBelow ? 'rotating' : (old || (r > 0.25 ? 'stable' : 'rotating'));
    if (nw !== old) { st.modeH = nw; if (old) modeChanges.push([src, old, nw, Math.round(r * 1000) / 1000]); }
  }
  const srcModes = {}; for (const src of Object.keys(state.srcStats)) srcModes[src] = modeOf(src);
  for (const r of sourceRecs || []) srcModes[r.id] = modeOf(r.id); // je Quelle (Kopien mit dem Modus ihres Ursprungsfeeds)

  // --- Stationen: Leer-/Vollquote je Tag; Carsharing-Stationen ohne Fahrzeugliste: Fahrten aus der Zahl buchbarer Autos ---
  const seenSt = new Set(), stDel = [], carFleet = new Map();
  for (const v of vehicles) if (v.type === 'car' && trackable(v)) carFleet.set(v.operator, (carFleet.get(v.operator) || 0) + 1);
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
    const pt = s.perType ? Object.keys(s.perType) : null;
    if (!s.hasVehicleList && (pt ? pt.length > 0 && pt.every(t => t === 'car') : s.typeHint === 'car')) {
      const nb = open ? Math.max(0, s.bookable ?? 0) : 0, all = Math.max(nb, s.physicalAvailable ?? 0);
      carFleet.set(s.operator, (carFleet.get(s.operator) || 0) + all);
      if (dtMin) { const hh = H(s.operator, s.ags, 'car'); hh.vmin[hour] += nb * dtMin; hh.vminTot[hour] += all * dtMin; }
      if (!first && e.cb != null && e.cbAt === state.at && nb !== e.cb) stDel.push({ s, d: nb - e.cb, prev: e.cb });
      e.cb = nb; e.cbAt = now;
    }
    state.s[key] = e;
  }
  if (stDel.length) {
    const agg = {}; for (const x of stDel) { const a = (agg[CS(x.s.sourceId)] ??= { neg: 0, pos: 0, prev: 0 }); if (x.d < 0) a.neg -= x.d; else a.pos += x.d; }
    for (const s of stations) if (s.sourceId && agg[CS(s.sourceId)] && !s.hasVehicleList) agg[CS(s.sourceId)].prev += Math.max(0, s.bookable ?? 0);
    for (const x of stDel) {
      const a = agg[CS(x.s.sourceId)], n = x.d < 0 ? a.neg : a.pos; if (n >= MASS_MIN && n > MASS_SHARE * Math.max(a.prev, 1)) continue;
      const hh = H(x.s.operator, x.s.ags, 'car'); if (x.d < 0) hh.start[hour] -= x.d; else hh.end[hour] += x.d;
      S(x.s.sourceId).stc = (S(x.s.sourceId).stc || 0) + Math.abs(x.d);
    }
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
  // --- Carsharing messbar? je Anbieter über CAR_TRIPS.days Tage: Fahrtbeginne und Auto-Tage (Höchstbestand je Tag) ---
  const ce = (state.carEvt ??= {});
  if (!gap) {
    const st = new Map(); for (const [k, g] of hourly) { const [, op, ty] = k.split('|'); if (ty === 'car') st.set(op, (st.get(op) || 0) + (g.start[hour] || 0)); }
    for (const [op, n] of carFleet) { const e = (ce[op] ??= { d: {} }); const dd = (e.d[day] ??= [0, 0]); dd[0] += st.get(op) || 0; dd[1] = Math.max(dd[1], n); }
  }
  for (const [op, e] of Object.entries(ce)) { for (const k of Object.keys(e.d)) if (daysBetween(k, day) >= CAR_TRIPS.days) delete e.d[k]; if (!Object.keys(e.d).length) delete ce[op]; }
  const carOk = (op) => { const ds = Object.values(ce[op]?.d || {}), n = ds.reduce((a, x) => a + x[0], 0), cd = ds.reduce((a, x) => a + x[1], 0); return n >= CAR_TRIPS.minStarts && n >= CAR_TRIPS.perCarDay * cd; };
  const carMuted = new Set([...carFleet.keys()].filter(op => !carOk(op)));
  if (carMuted.size) {
    const mut = (op, ty) => ty === 'car' && carMuted.has(op);
    for (const k of [...hourly.keys()]) { const [, op, ty] = k.split('|'); if (mut(op, ty)) hourly.delete(k); }
    for (const k of [...flows.keys()]) { const [, op, ty] = k.split('|'); if (mut(op, ty)) flows.delete(k); }
    for (let i = idleRows.length - 1; i >= 0; i--) if (mut(idleRows[i].v.operator, idleRows[i].ty)) idleRows.splice(i, 1);
    for (const list of [estS, estE]) for (let i = list.length - 1; i >= 0; i--) if (mut(list[i][1], list[i][2])) list.splice(i, 1);
  }
  const carTrips = { rule: CAR_TRIPS, measurable: [...carFleet.keys()].filter(op => !carMuted.has(op)).sort(), unmeasurable: [...carMuted].sort(),
    perOp: Object.fromEntries([...carFleet.keys()].sort().map(op => { const ds = Object.values(ce[op]?.d || {}); return [op, { starts: ds.reduce((a, x) => a + x[0], 0), carDays: ds.reduce((a, x) => a + x[1], 0), days: ds.length }]; })) };
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
  const groupable = (a) => rulesOf(a.ty).groups && !glitch.has(CS(a.src)) && !idleUnusable[a.src] && !(sgrid.size && nearStation(a.op, a.lat, a.lon, !bound(a)));
  const ffOk = (a, kind) => night || bound(a) || (kind === 'deploy' && a.bat != null && a.bat >= SWAP_TO);
  const groups = first || gap ? [] : [...clusterGroups(arrivals.filter(a => groupable(a) && ffOk(a, 'deploy')), 'deploy', now), ...clusterGroups(departures.filter(a => groupable(a) && ffOk(a, 'collect')), 'collect', now)];
  // Zählungen für die Schätzung: ohne Gruppenmitglieder (Ausbringen/Einsammeln) und ohne Quellen mit Massenwechsel
  if (!first && !gap) for (const [list, o] of /** @type {[any[], any][]} */ ([[estS, est.s], [estE, est.e]])) for (const [ref, op, ty, ags, cell, src] of list) if (!ref?.inGroup && !glitch.has(CS(src))) EST(o, `${op}|${ty}`, `${ags}|${cell}`);
  return { state, first, dt, gap, hourly, cells, idle, idleCens, idleLong, idleUnusable, srcModes, day, hour, groups, flows, est, carTrips, ...(NX ? { modeChanges, gapEstimated: gapEst, durSpans } : {}) };
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
