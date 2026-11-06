// Umgebung der Prognose: Ereignisse je Gemeinde und Ortsstunde, die die Nachfrage verschieben können.
//
// Quellen (alle optional, jede einzeln abschaltbar):
//   warn   – Wetterwarnungen des DWD (über Bright Sky /alerts, je 0,5°-Wetterzelle), ab Stufe „markant“ (moderate); mit Beginn und Ende,
//            also auch für die kommenden Stunden bekannt
//   road   – Autobahn: Sperrung oder Stau im Gemeindegebiet (Autobahn GmbH, verkehr.autobahn.de), nur zur Stunde der Beobachtung
//   strike – Streik im ÖPNV, rail – Bahnstreik, event – Veranstaltung: aus der gepflegten Liste data/ereignisse.json (es gibt keine offene
//            Schnittstelle für Streiks; Einträge mit Quelle)
// Gespeichert werden nur abgeleitete Kennzeichen (Gemeinde, Stunde, Stufe bzw. ja/nein), keine Meldungstexte.
// Datei incidents/<Ortstag>.json: { version: 1, day, updatedAt, sources: { warn: {at, cells}, road: {at, items} }, ags: { [ags]: { warn: [24], road: [24] } } }
import { hourOf, dayOf } from './pulse-track.js?v=mw5d7krn';

export const CTX_KEYS = ['warn', 'road', 'strike', 'rail', 'event'];
export const SEVERITY = { minor: 1, moderate: 2, severe: 3, extreme: 4 };
export const WARN_MIN = 2; // Merkmal „warn“ ab Stufe 2 (markant); Stufe 1 (z. B. Frost, leichter Wind) ist fast täglich irgendwo und trägt nichts
export const CURATED_KINDS = { 'streik-oepnv': 'strike', 'streik-bahn': 'rail', veranstaltung: 'event' };
const LAND_OF_AGS = { '01': 'SH', '02': 'HH', '03': 'NI', '04': 'HB', '05': 'NW', '06': 'HE', '07': 'RP', '08': 'BW', '09': 'BY', '10': 'SL', '11': 'BE', '12': 'BB', '13': 'MV', '14': 'SN', '15': 'ST', '16': 'TH' };

export const emptyIncidentDoc = (day) => ({ version: 1, day, updatedAt: null, sources: {}, ags: {} });
const slot = (doc, ags, key) => { const a = (doc.ags[ags] ||= {}); return (a[key] ||= new Array(24).fill(0)); };

/** Stunden (UTC-Beginn) im Intervall [from, to) */
function* hoursBetween(from, to) { for (let t = Math.floor(from / 3600e3) * 3600e3; t < to; t += 3600e3) yield t; }

/**
 * DWD-Warnungen eintragen. docs: Map Ortstag → Dokument (wird ergänzt), alerts: { zelle: [Bright-Sky-Alert] }, agsCell: { ags: zelle }.
 * Je Stunde zählt die höchste Stufe; bereits eingetragene Stunden bleiben (Warnungen der Vergangenheit kommen nicht erneut).
 * Nur status 'actual'; ohne Ende 6 Stunden; höchstens maxAheadH Stunden voraus, nichts vor from.
 */
export function addAlerts(docs, alerts, agsCell, now, { maxAheadH = 48, from = now - 3 * 3600e3 } = {}) {
  const byCell = new Map(); for (const [ags, c] of Object.entries(agsCell || {})) { if (!byCell.has(c)) byCell.set(c, []); byCell.get(c).push(ags); }
  let n = 0;
  for (const [cell, list] of Object.entries(alerts || {})) {
    const agsList = byCell.get(cell); if (!agsList || !Array.isArray(list)) continue;
    for (const a of list) {
      const sev = SEVERITY[a?.severity] || 0; if (!sev || (a.status && a.status !== 'actual')) continue;
      const on = Date.parse(a.onset ?? a.effective), off = a.expires ? Date.parse(a.expires) : on + 6 * 3600e3;
      if (!Number.isFinite(on) || !Number.isFinite(off) || off <= on) continue;
      for (const t of hoursBetween(Math.max(on, from), Math.min(off, now + maxAheadH * 3600e3))) {
        const day = dayOf(t), h = hourOf(t); let doc = docs.get(day); if (!doc) docs.set(day, doc = emptyIncidentDoc(day));
        for (const ags of agsList) { const s = slot(doc, ags, 'warn'); if (sev > s[h]) { s[h] = sev; n++; } }
      }
    }
  }
  return n;
}

// Nur frische Ereignisse zählen: Bauphasen-Sperrungen laufen oft monatelang (Beginn Monate zurück) und wären je Gemeinde fast konstant – das
// Modell könnte sie nicht vom Gruppeneffekt trennen, und für die Zukunft ist der Wert unbekannt (dort 0). Deshalb: Sperrung, die vor höchstens
// ROAD_FRESH.closureH Stunden begonnen hat oder ohne Beginn (kurzfristige Sperrfenster, z. B. nachts), Stau seit höchstens ROAD_FRESH.jamH Stunden.
export const ROAD_FRESH = { closureH: 24, jamH: 6 };
/** Autobahn-Meldung → { lat, lon, kind: 'closure' | 'jam' } oder null (Dauer-Baustellen, geplante Sperrungen, alte Staumeldungen, ohne Koordinate) */
export function roadItem(it, service, now) {
  const lat = +it?.coordinate?.lat, lon = +it?.coordinate?.long;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || it.future === true) return null;
  const start = it.startTimestamp ? Date.parse(it.startTimestamp) : NaN;
  if (Number.isFinite(start) && start > now) return null;
  const age = Number.isFinite(start) ? (now - start) / 3600e3 : 0;
  if (service === 'closure') return age <= ROAD_FRESH.closureH ? { lat, lon, kind: 'closure' } : null;
  const type = String(it.abnormalTrafficType || ''), text = [it.title, ...(Array.isArray(it.description) ? it.description : [])].join(' ');
  const jam = (/STATIONARY|QUEUING|SLOW|HEAVY/.test(type) || /\bStau\b|stockender Verkehr|zähfließend|Stillstand/i.test(text)) && age <= ROAD_FRESH.jamH;
  return jam ? { lat, lon, kind: 'jam' } : null;
}

/** Autobahn-Beobachtung zur aktuellen Ortsstunde eintragen: items [{lat, lon}], locate(lat, lon) → ags | null; Rückgabe: Gemeinden mit Meldung */
export function addRoad(docs, items, locate, now) {
  const day = dayOf(now), h = hourOf(now); let doc = docs.get(day); if (!doc) docs.set(day, doc = emptyIncidentDoc(day));
  const hit = new Set();
  for (const it of items || []) { const ags = locate(it.lat, it.lon); if (ags) hit.add(ags); }
  for (const ags of hit) slot(doc, ags, 'road')[h] = 1;
  return hit.size;
}

/** Gepflegte Liste (data/ereignisse.json → ereignisse[]) prüfen: Einträge mit bekannter Art, Datum und Gebiet; Rückgabe { ok: [...], bad: [Grund] } */
export function checkCurated(doc) {
  const ok = [], bad = [], isDay = (s) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(s || ''));
  for (const [i, e] of (Array.isArray(doc?.ereignisse) ? doc.ereignisse : []).entries()) {
    if (!CURATED_KINDS[e?.art]) { bad.push(`#${i}: Art „${e?.art}“ unbekannt`); continue; }
    if (!isDay(e.von) || !isDay(e.bis ?? e.von) || String(e.bis ?? e.von) < String(e.von)) { bad.push(`#${i}: von/bis ungültig`); continue; }
    const g = e.gebiet; if (!(g === 'DE' || Array.isArray(g?.laender) || Array.isArray(g?.ags))) { bad.push(`#${i}: Gebiet fehlt (DE, {laender}, {ags})`); continue; }
    if (!e.quelle) { bad.push(`#${i}: Quelle fehlt`); continue; }
    ok.push(e);
  }
  return { ok, bad };
}
/** Ortstag + Stunde als vergleichbare Zeichenfolge 'YYYY-MM-DDTHH:00' */
const stamp = (day, h) => `${day}T${String(h).padStart(2, '0')}:00`;
const fromOf = (s) => (s.length === 10 ? `${s}T00:00` : s), toOf = (s) => (s.length === 10 ? `${s}T23:59` : s);

/**
 * Merkmale je (Gemeinde, Ortstag, Ortsstunde): docs = incidents-Dokumente (Liste), curated = geprüfte Einträge.
 * Rückgabe ctx(ags, day, h) → Int8Array(CTX_KEYS.length) (0/1) – ohne Information 0 (keine Meldung).
 */
export function ctxLookup(docs = [], curated = []) {
  const byDay = new Map(); for (const d of docs || []) if (d?.day && d.ags) byDay.set(d.day, d);
  const cur = (curated || []).map(e => ({ k: CURATED_KINDS[e.art], from: fromOf(String(e.von)), to: toOf(String(e.bis ?? e.von)), all: e.gebiet === 'DE', laender: new Set(e.gebiet?.laender || []), ags: new Set(e.gebiet?.ags || []) }));
  const iW = CTX_KEYS.indexOf('warn'), iR = CTX_KEYS.indexOf('road');
  return (ags, day, h) => {
    const out = new Int8Array(CTX_KEYS.length), a = byDay.get(day)?.ags?.[ags];
    if (a) { if ((a.warn?.[h] || 0) >= WARN_MIN) out[iW] = 1; if (a.road?.[h]) out[iR] = 1; }
    if (cur.length) { const s = stamp(day, h), land = LAND_OF_AGS[String(ags).slice(0, 2)];
      for (const e of cur) if (s >= e.from && s <= e.to && (e.all || e.laender.has(land) || e.ags.has(String(ags)))) out[CTX_KEYS.indexOf(e.k)] = 1; }
    return out;
  };
}

/** Fehlende Wettertage (UTC) für die Ortstage der Ereignisdateien: je Ortstag D braucht die Prognose die UTC-Tage D−1 (23 Uhr) und D */
export function weatherBackfillDays(eventDays, haveDays, today, { maxDays = 23 } = {}) {
  const have = new Set(haveDays), need = new Set(), add = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
  const oldest = add(today, -maxDays);
  for (const d of eventDays) for (const u of [add(d, -1), d]) if (u >= oldest && u < add(today, -1) && !have.has(u)) need.add(u);
  return [...need].sort();
}
