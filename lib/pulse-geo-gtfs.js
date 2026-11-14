// Mobility Pulse – S8.5 ÖPNV-Zubringer (F19): Abfahrten je gebündelter Haltestelle aus dem freien GTFS-Fahrplan von gtfs.de (CC BY 4.0)
// für einen Stichtag (Dienstag), und der Zubringer-Index je Gemeinde: Fahrtbeginne und -enden in 150 m um eine Haltestelle mit Abfahrten,
// je 100 Abfahrten des Tages. Bündel: Steige mit gleicher Elternstation, sonst gleicher Name in 150 m.
import { pointIndex, distM } from './pulse-geo-proj.js';

export const GTFS = Object.freeze({ url: 'https://download.gtfs.de/germany/free/latest.zip', license: 'CC BY 4.0', attribution: 'Fahrplan: gtfs.de (DELFI e. V. u. a.), CC BY 4.0', bundleM: 150, nearM: 150, perDep: 100 });

/** eine CSV-Zeile (RFC 4180, Anführungszeichen) → Felder */
export function csvLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}
export const headerIx = (line) => Object.fromEntries(csvLine(line.replace(/^﻿/, '')).map((h, i) => [h.trim(), i]));

/** Dienste, die am Datum (JJJJMMTT) fahren: calendar.txt (Wochentag, Zeitraum) plus calendar_dates.txt (1 = hinzu, 2 = entfällt) */
export function activeServices(calendarLines, datesLines, ymd) {
  const on = new Set(), d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T12:00:00Z`), wd = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getUTCDay()];
  if (calendarLines?.length) {
    const h = headerIx(calendarLines[0]);
    for (const l of calendarLines.slice(1)) { if (!l) continue; const c = csvLine(l); if (c[h[wd]] === '1' && c[h.start_date] <= ymd && c[h.end_date] >= ymd) on.add(c[h.service_id]); }
  }
  if (datesLines?.length) {
    const h = headerIx(datesLines[0]);
    for (const l of datesLines.slice(1)) { if (!l) continue; const c = csvLine(l); if (c[h.date] !== ymd) continue; if (c[h.exception_type] === '1') on.add(c[h.service_id]); else if (c[h.exception_type] === '2') on.delete(c[h.service_id]); }
  }
  return on;
}
/** nächster Dienstag ab Datum (JJJJMMTT) innerhalb des Fahrplans */
export function nextTuesday(ms) { const d = new Date(ms); while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10).replace(/-/g, ''); }

/** Zähler für stop_times.txt: add(line) zeilenweise, Abfahrten je stop_id (nur Fahrten aktiver Dienste, kein pickup_type 1) */
export function departureCounter(activeTrips) {
  let h = null; const dep = new Map(); let rows = 0, used = 0;
  return {
    add(line) {
      if (!h) { h = headerIx(line); return; }
      if (!line) return; rows++;
      const c = line.indexOf('"') >= 0 ? csvLine(line) : line.split(',');
      if (!activeTrips.has(c[h.trip_id])) return;
      if (h.pickup_type != null && c[h.pickup_type] === '1') return;
      used++; const s = c[h.stop_id]; dep.set(s, (dep.get(s) || 0) + 1);
    },
    result: () => ({ dep, rows, used }),
  };
}

/** Bündel: stops [{ id, name, lat, lon, parent }] mit Abfahrten dep (Map) → [{ lat, lon, name, dep, n }] (nur mit Abfahrten) */
export function bundleStops(stops, dep, { bundleM = GTFS.bundleM } = {}) {
  const byParent = new Map(), loose = [];
  for (const s of stops) { const d = dep.get(s.id) || 0; if (s.parent) { let b = byParent.get(s.parent); if (!b) byParent.set(s.parent, b = []); b.push({ ...s, d }); } else loose.push({ ...s, d }); }
  const out = [];
  const push = (list) => { const D = list.reduce((a, s) => a + s.d, 0); if (!D) return; const w = list.reduce((a, s) => a + (s.d || 0), 0) || list.length; out.push({ lat: list.reduce((a, s) => a + s.lat * (s.d || 0), 0) / w, lon: list.reduce((a, s) => a + s.lon * (s.d || 0), 0) / w, name: list[0].name, dep: D, n: list.length }); };
  for (const list of byParent.values()) push(list);
  // ohne Elternstation: gleicher Name, nah beieinander
  const byName = new Map(); for (const s of loose) { const k = String(s.name || '').trim().toLowerCase(); let a = byName.get(k); if (!a) byName.set(k, a = []); a.push(s); }
  for (const list of byName.values()) {
    const left = [...list];
    while (left.length) { const s0 = left.shift(), grp = [s0]; for (let i = left.length - 1; i >= 0; i--) if (distM(s0.lat, s0.lon, left[i].lat, left[i].lon) <= bundleM) grp.push(left.splice(i, 1)[0]); push(grp); }
  }
  return out;
}

/** Zubringer-Zähler je Gemeinde: Punkte (Beginne/Enden) in nearM um ein Bündel; Index = (Beginne + Enden in der Nähe) ÷ Abfahrten × perDep */
export function feederIndex(bundles, { nearM = GTFS.nearM } = {}) {
  const ix = pointIndex(bundles.map(b => [b.lat, b.lon]), 200), dep = bundles.reduce((a, b) => a + b.dep, 0);
  return { dep, near: (lat, lon) => ix.nearestWithin(lat, lon, nearM) <= nearM };
}
export const indexValue = (near, dep, perDep = GTFS.perDep) => (dep > 0 ? (near / dep) * perDep : null);
