// @ts-check
// Chronos-2 (Amazon, Apache 2.0) in der Prognose (seit 07.11.2026).
// Ablauf: der Workflow „Chronos-2“ baut mit chronosBundle aus dem Datenstand (events/, weather/, calendar.json) je Gruppe die Stundenreihe der
// Fahrtbeginne mit Kovariaten – einmal ab jetzt (48 Stunden) und für die letzten Tage je einmal „am Vorabend“ (Kontext bis 0 Uhr des Tags,
// 24 Stunden, für die Selbstprüfung) –, scripts/chronos.py rechnet alle auf einmal und legt chronos.json in den Branch tsfm.
// Der Sammler liest die Datei (chronosLookup) und gibt sie der Prognose: „chronos“ läuft als reiner Vergleich mit, „blend“ mischt Chronos und das
// eigene Hybrid-Modell je Gruppe mit Gewichten, die aus den Fehlern beider gelernt werden (lib/pulse-forecast.js, BLEND).
import * as E from './pulse-econ.js';
import { hourOf, dayOf } from './pulse-track.js';
import { GATES, LAND_OF_AGS, localToUtcMs, lastExposure, dayFromDoc, scopesOfKey } from './pulse-forecast.js';

/** contextDays: Tage Vorlauf; horizon: Stunden ab der laufenden Stunde; minStarts: Fahrtbeginne der letzten 7 Tage, ab denen eine Gruppe dabei ist;
 *  maxAgeH: so alt darf die Eingabe beim Ausgeben einer Prognose höchstens sein */
export const CHRONOS = { version: 1, contextDays: 21, horizon: 48, backDays: 8, backHorizon: 24, minStarts: 20, maxAgeH: 30, model: 'amazon/chronos-2' };
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/**
 * Eingabe für scripts/chronos.py. docs = events/<Tag>.json, weather = weather/<UTC-Tag>.json, calendar = calendar.json.
 * Zeitachse: volle UTC-Stunden ab 0 Uhr Ortszeit des ersten Tags bis vor die laufende Stunde (Kontext, n Stunden), danach horizon Stunden
 * Zukunft ab der laufenden Stunde (futureFrom). y = Fahrtbeginne (null = Stunde nicht beobachtet), e = Fahrzeugstunden (Zukunft: zuletzt
 * beobachteter Wert derselben Stunde wie in der Prognose), je Gemeinde t/p = Temperatur/Niederschlag (DWD über Bright Sky), c = Tagtyp W/F/S/H,
 * lh = Ortsstunde je Zeitschritt.
 */
export function chronosInput({ docs, calendar = null, weather = [], now = Date.now(), horizon = null, opts = CHRONOS }) {
  const days = (docs || []).filter(d => d?.day && d.groups).map(d => dayFromDoc(d, calendar)).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-opts.contextDays);
  if (!days.length) return null;
  const futureFrom = Math.floor(now / 3600e3) * 3600e3, from = localToUtcMs(days[0].day, 0), n = Math.max(0, Math.round((futureFrom - from) / 3600e3)), H = horizon ?? opts.horizon;
  const ts = Array.from({ length: n + H }, (_, i) => from + i * 3600e3), slot = ts.map(t => [dayOf(t), hourOf(t)]);
  const byDay = new Map(days.map(d => [d.day, d]));
  // Gruppen: genug Fahrtbeginne in den letzten 7 Tagen und in den letzten 24 Stunden Fahrzeuge
  const tot = new Map(), alive = new Set(), last7 = new Set(days.slice(-7).map(d => d.day));
  for (let i = 0; i < n; i++) {
    const [day, h] = slot[i], d = byDay.get(day); if (!d) continue;
    for (const [k, g] of Object.entries(d.groups)) { if (last7.has(day)) tot.set(k, (tot.get(k) || 0) + (g.start?.[h] || 0)); if (i >= n - 24 && (g.vmin?.[h] || 0) > 0) alive.add(k); }
  }
  const keys = [...tot].filter(([k, s]) => s >= opts.minStarts && alive.has(k)).map(([k]) => k).sort();
  const expo = lastExposure(days);
  const groups = keys.map(k => {
    const y = new Array(n), e = new Array(n + H);
    for (let i = 0; i < n + H; i++) {
      const [day, h] = slot[i];
      if (i >= n) { e[i] = r1(expo.get(k)?.[h] ?? 0); continue; }
      const d = byDay.get(day), g = d?.groups[k], obs = d && d.hourMin[h] >= GATES.hourMinObserved;
      y[i] = obs ? g?.start?.[h] || 0 : null; e[i] = obs ? r1((g?.vmin?.[h] || 0) / 60) : null;
    }
    return { k, y, e };
  });
  // Kovariaten je Gemeinde: Wetter aus dem Cache (UTC-Tag, UTC-Stunde), Tagtyp je Land und Ortstag
  const wByDay = new Map((weather || []).filter(w => w?.day && w.cells && w.ags).map(w => [w.day, w]));
  const typeOf = new Map(), cls = (land, day) => { const q = `${land}|${day}`; if (!typeOf.has(q)) typeOf.set(q, E.dayType(day, land, calendar) || 'W'); return typeOf.get(q); };
  const cov = {};
  for (const ags of [...new Set(keys.map(k => k.split('|')[0]))]) {
    const land = LAND_OF_AGS[String(ags).slice(0, 2)] ?? null, t = new Array(n + H), p = new Array(n + H); let c = '';
    for (let i = 0; i < n + H; i++) {
      const iso = new Date(ts[i]).toISOString(), w = wByDay.get(iso.slice(0, 10)), cell = w?.cells?.[w.ags?.[ags]], uh = +iso.slice(11, 13);
      const tv = cell?.t?.[uh], pv = cell?.p?.[uh];
      t[i] = Number.isFinite(tv) && Math.abs(tv) < 60 ? r1(tv) : null; p[i] = Number.isFinite(pv) && pv >= 0 && pv < 200 ? r1(pv) : null;
      c += cls(land, slot[i][0]);
    }
    cov[ags] = { t, p, c };
  }
  return { version: opts.version, at: new Date(now).toISOString(), model: opts.model, from, n, horizon: H, futureFrom, lh: slot.map(s => s[1]), groups, cov };
}

/**
 * Alle Läufe für scripts/chronos.py: main = ab jetzt (horizon Stunden), dazu für die letzten backDays Ortstage (einschließlich heute) je eine
 * Vortagsprognose: nur Tage davor als Kontext, 24 Stunden ab 0 Uhr – so, wie sie am Vorabend möglich gewesen wäre (Selbstprüfung, Lernstand von blend).
 */
export function chronosBundle({ docs, calendar = null, weather = [], now = Date.now(), opts = CHRONOS }) {
  const main = chronosInput({ docs, calendar, weather, now, opts });
  if (!main) return null;
  const all = (docs || []).filter(d => d?.day && d.groups).map(d => d.day).sort(), today = dayOf(now), runs = [{ tag: 'main', ...main }];
  for (const day of [...new Set(all)].filter(d => d <= today).slice(-opts.backDays)) {
    const before = (docs || []).filter(d => d?.day && d.day < day);
    if (new Set(before.map(d => d.day)).size < 2) continue;
    const inp = chronosInput({ docs: before, calendar, weather, now: localToUtcMs(day, 0), horizon: opts.backHorizon, opts });
    if (inp?.groups?.length && inp.n >= 24) runs.push({ tag: day, ...inp });
  }
  return { version: 2, at: main.at, model: opts.model, runs };
}

/**
 * Zugriff der Prognose auf chronos.json: live(key, t) = Chronos-Mittel für die UTC-Stunde t aus dem jüngsten Lauf (NaN ohne Wert), usable(t0) =
 * Lauf höchstens maxAgeH Stunden alt und deckt t0, back(key, t) = Vortagsprognose des Ortstags von t (NaN ohne), hasBack(day).
 */
export function chronosLookup(doc, { opts = CHRONOS } = {}) {
  if (!doc?.groups || !Number.isFinite(doc.from) || !(doc.hours > 0)) return null;
  const at = Date.parse(doc.at), end = doc.from + doc.hours * 3600e3, back = doc.back || {};
  const days = new Map(), dOf = (t) => { let d = days.get(t); if (d === undefined) { d = dayOf(t); days.set(t, d); } return d; }; // Intl ist teuer: je Stunde einmal
  const val = (v) => (Number.isFinite(v) ? Math.max(0, v) : NaN);
  return {
    at: doc.at, model: doc.model ?? null, from: doc.from, hours: doc.hours, backDays: Object.keys(back).sort(),
    usable: (t0) => Number.isFinite(at) && t0 - at <= opts.maxAgeH * 3600e3 && t0 >= doc.from && t0 < end,
    live: (key, t) => (t >= doc.from && t < end ? val(doc.groups[key]?.m?.[Math.round((t - doc.from) / 3600e3)]) : NaN),
    // S2.7: halbe Breiten des 10–90-%-Intervalls [m − q10, q90 − m] der Stunde, null ohne Quantile (Rückfallwerte des Skripts: ±30 %)
    quant: (key, t) => { if (!(t >= doc.from && t < end)) return null; const g = doc.groups[key], i = Math.round((t - doc.from) / 3600e3), m = g?.m?.[i], lo = g?.q10?.[i], hi = g?.q90?.[i];
      return Number.isFinite(m) && Number.isFinite(lo) && Number.isFinite(hi) ? [Math.max(0, m - lo), Math.max(0, hi - m)] : null; },
    hasBack: (day) => !!back[day]?.groups,
    back: (key, t) => { const b = back[dOf(t)]; return b?.groups ? val(b.groups[key]?.[Math.round((t - b.from) / 3600e3)]) : NaN; },
  };
}

/**
 * Chronos-Werte in die Stundenreihen des Dashboards (forecast/series.json): je Tag und Gebiet, das dort schon steht, Feld c (24 Ortsstunden).
 * Quelle: der jüngste Lauf, wo er die Stunde abdeckt (heute ab Laufbeginn, morgen); sonst die Vortagsprognose des Tags (vergangene Tage und
 * die frühen Stunden von heute) – so steht Chronos auch an Tagen, für die es noch keinen Lauf gab, neben Ist und Plan. Gebiete wie im Plan
 * (scopesOfKey). series.chronos = Stand der Datei. Ändert series an Ort und Stelle.
 */
export function chronosSeries(series, doc) {
  if (!series?.days || !doc?.groups || !Number.isFinite(doc.from) || !(doc.hours > 0)) return series;
  const acc = new Map(); // `${day}|${scope}` → [24]
  const add = (groups, from, hours, pick, src) => {
    const slots = Array.from({ length: hours }, (_, i) => { const t = from + i * 3600e3; return [dayOf(t), hourOf(t)]; });
    for (const [k, g] of Object.entries(groups)) {
      const scs = scopesOfKey(k), arr = pick(g) || [];
      arr.forEach((v, i) => {
        if (!Number.isFinite(v) || !slots[i]) return; const [day, h] = slots[i]; if (!series.days[day]) return;
        for (const sc of scs) { const q = `${day}|${sc}`; let a = acc.get(q); if (!a) acc.set(q, a = { live: new Array(24).fill(null), back: new Array(24).fill(null) }); a[src][h] = (a[src][h] || 0) + v; }
      });
    }
  };
  add(doc.groups, doc.from, doc.hours, (g) => g.m, 'live');
  for (const b of Object.values(doc.back || {})) if (b?.groups && Number.isFinite(b.from)) add(b.groups, b.from, b.hours || 24, (g) => g, 'back');
  for (const [day, entry] of Object.entries(series.days)) for (const [sc, e] of Object.entries(entry)) {
    delete e.c; const a = acc.get(`${day}|${sc}`); if (!a) continue;
    const c = a.live.map((x, h) => (x ?? a.back[h])); if (c.some(x => x != null)) e.c = c.map(x => (x == null ? null : Math.round(x)));
  }
  series.chronos = { model: doc.model ?? null, at: doc.at ?? null, from: doc.from, hours: doc.hours, backDays: Object.keys(doc.back || {}).sort() };
  return series;
}
