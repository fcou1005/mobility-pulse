// Chronos-2 (Amazon, Apache 2.0) als Schattenkandidat der Prognose (seit 07.11.2026).
// Ablauf: der Workflow „Chronos-2“ baut mit chronosInput aus dem Datenstand (events/, weather/, calendar.json) je Gruppe die Stundenreihe der
// Fahrtbeginne mit Kovariaten, scripts/chronos.py rechnet damit die nächsten CHRONOS.horizon Stunden und legt chronos.json in den Branch tsfm.
// Der Sammler liest die Datei und führt „chronos“ in den ausgegebenen Prognosen als Schatten mit (chronosShadow); bewertet wird im Live-Abgleich
// wie bei allen Kandidaten. Gewählt werden kann chronos nicht (nicht in MODELS) – die veröffentlichte Prognose bleibt unberührt.
import * as E from './pulse-econ.js';
import { hourOf, dayOf } from './pulse-track.js';
import { GATES, LAND_OF_AGS, localToUtcMs, lastExposure, dayFromDoc, scopesOfKey } from './pulse-forecast.js';

/** contextDays: Tage Vorlauf; horizon: Stunden ab der laufenden Stunde; minStarts: Fahrtbeginne der letzten 7 Tage, ab denen eine Gruppe dabei ist;
 *  maxAgeH: so alt darf die Eingabe beim Ausgeben einer Prognose höchstens sein */
export const CHRONOS = { version: 1, contextDays: 21, horizon: 48, minStarts: 20, maxAgeH: 30, model: 'amazon/chronos-2' };
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/**
 * Eingabe für scripts/chronos.py. docs = events/<Tag>.json, weather = weather/<UTC-Tag>.json, calendar = calendar.json.
 * Zeitachse: volle UTC-Stunden ab 0 Uhr Ortszeit des ersten Tags bis vor die laufende Stunde (Kontext, n Stunden), danach horizon Stunden
 * Zukunft ab der laufenden Stunde (futureFrom). y = Fahrtbeginne (null = Stunde nicht beobachtet), e = Fahrzeugstunden (Zukunft: zuletzt
 * beobachteter Wert derselben Stunde wie in der Prognose), je Gemeinde t/p = Temperatur/Niederschlag (DWD über Bright Sky), c = Tagtyp W/F/S/H,
 * lh = Ortsstunde je Zeitschritt.
 */
export function chronosInput({ docs, calendar = null, weather = [], now = Date.now(), opts = CHRONOS }) {
  const days = (docs || []).filter(d => d?.day && d.groups).map(d => dayFromDoc(d, calendar)).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-opts.contextDays);
  if (!days.length) return null;
  const futureFrom = Math.floor(now / 3600e3) * 3600e3, from = localToUtcMs(days[0].day, 0), n = Math.max(0, Math.round((futureFrom - from) / 3600e3)), H = opts.horizon;
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
 * Schatten „chronos“ für eine ausgegebene Prognose: je Anbieter und Stunde die Summe der Chronos-Werte; Gruppen ohne Chronos-Wert (unter
 * minStarts oder neu) nehmen den Wert des aktiven Modells, damit der Vergleich die großen Gruppen misst und nicht an fehlenden kleinen scheitert.
 * rows = [{ key, fi (Index der Stunde), v (aktives Modell) }], fut = [{ t }] (UTC-Beginn je Stunde), horizon = Stunden der Ausgabe.
 * Rückgabe { byOp: { op: [horizon] }, meta: { at, cover } } oder null (Datei fehlt, zu alt oder deckt die Stunden nicht).
 */
export function chronosShadow(doc, rows, fut, horizon, { opts = CHRONOS } = {}) {
  if (!doc?.groups || !Number.isFinite(doc.from) || !(doc.hours > 0) || !fut.length) return null;
  const t0 = fut[0].t, tEnd = fut[Math.min(horizon, fut.length) - 1].t, at = Date.parse(doc.at);
  if (!(t0 >= doc.from && tEnd < doc.from + doc.hours * 3600e3) || !(t0 - at <= opts.maxAgeH * 3600e3)) return null;
  const o = new Map(); let cov = 0, all = 0;
  for (const { key, fi, v } of rows) {
    if (fi >= horizon) continue;
    const op = key.split('|')[1], idx = Math.round((fut[fi].t - doc.from) / 3600e3), c = doc.groups[key]?.m?.[idx];
    const x = Number.isFinite(c) ? Math.max(0, c) : v; all += v; if (Number.isFinite(c)) cov += v;
    let a = o.get(op); if (!a) o.set(op, a = new Array(horizon).fill(0)); a[fi] += x;
  }
  return { byOp: Object.fromEntries([...o].map(([k, a]) => [k, a.map(x => Math.round(x * 10) / 10)])), meta: { at: doc.at, ageH: +((t0 - at) / 3600e3).toFixed(1), cover: all > 0 ? +(cov / all).toFixed(3) : 0 } };
}

/**
 * Chronos-Werte in die Stundenreihen des Dashboards (forecast/series.json): je Tag und Gebiet, das dort schon steht, Feld c (24 Ortsstunden,
 * null außerhalb der Chronos-Prognose). Gebiete wie im Plan (scopesOfKey). series.chronos = Stand der Datei. Ändert series an Ort und Stelle.
 */
export function chronosSeries(series, doc) {
  if (!series?.days || !doc?.groups || !Number.isFinite(doc.from) || !(doc.hours > 0)) return series;
  const slots = Array.from({ length: doc.hours }, (_, i) => { const t = doc.from + i * 3600e3; return [dayOf(t), hourOf(t)]; });
  const acc = new Map(); // `${day}|${scope}` → [24]
  for (const [k, g] of Object.entries(doc.groups)) {
    const scs = scopesOfKey(k);
    (g.m || []).forEach((v, i) => {
      if (!Number.isFinite(v) || !slots[i]) return; const [day, h] = slots[i]; if (!series.days[day]) return;
      for (const sc of scs) { const q = `${day}|${sc}`; let a = acc.get(q); if (!a) acc.set(q, a = new Array(24).fill(null)); a[h] = (a[h] || 0) + v; }
    });
  }
  for (const [day, entry] of Object.entries(series.days)) for (const [sc, e] of Object.entries(entry)) { delete e.c; const a = acc.get(`${day}|${sc}`); if (a) e.c = a.map(x => (x == null ? null : Math.round(x))); }
  series.chronos = { model: doc.model ?? null, at: doc.at ?? null, from: doc.from, hours: doc.hours };
  return series;
}
