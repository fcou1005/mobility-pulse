// Langzeitarchiv der Trainingsdaten (Audit 11.11.2026, DAT-01/07/08/09/10/11): je abgeschlossenem Ortstag eine unveränderliche Datei
// train/<JJJJ>/<JJJJ-MM-TT>.json.gz im Datenzweig. Hintergrund: events/ und history/ (stündliche Fahrtbeginne, verfügbare Fahrzeugminuten,
// beobachtete Minuten, Bestand) liegen nur HISTORY_DAYS (30) Tage; dauerhaft blieben nur Tageswerte (archive/), das Wetter und zehn
// Wirkungsfaktoren im Gedächtnis der Prognose. Ohne dieses Archiv lässt sich ab Dezember kein Modell auf mehr als 30 Tagen prüfen oder
// trainieren (Saison, Ferien, Wetterreaktion, Ereigniswirkung, Neuaufbau des Gedächtnisses nach einer Modelländerung).
// Wirkung auf die Prognose: keine – weder Prognose noch Chronos lesen train/. Reine Funktionen, Dateizugriff im Sammler.
import * as T from './pulse-track.js';
import * as E from './pulse-econ.js';
import * as CX from './pulse-context.js';

export const TRAIN = {
  version: 1,
  dir: 'train',
  // Ereignisfelder je Gruppe × Ortsstunde (Reihenfolge fest, neue Felder nur hinten anfügen)
  fields: ['start', 'end', 'vmin', 'vminTot', 'reloc', 'swap', 'pickup', 'disOn', 'disOff', 'rot'],
  // Summen je Gruppe und Tag (Dauer und Strecke gemessener Fahrten, Wartezeit Akkutausch, Sperrdauer)
  sums: ['tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN', 'swapWaitSum', 'swapWaitN', 'disDurSum', 'disDurN'],
  // Bestand je Gruppe × Ortsstunde als Mittel der zählenden Läufe (aus history/)
  stock: ['total', 'available', 'disabled', 'lowBattery', 'batteryKnown', 'stationsEmpty', 'stationsEmptyDock'],
  minStarts: 3, // Gruppen mit weniger Fahrtbeginnen am Tag: start/end nur als Tagessumme (Einzelfahrten in kleinen Orten nicht dauerhaft je Stunde)
  readyAfterH: 3, // ein Ortstag wird frühestens 3 Stunden nach seinem Ende archiviert (Wetterbeobachtung und Selbstprüfung liegen dann vor)
  perRun: 6, // höchstens so viele Tage je Lauf (Nachholen ab dem ältesten fehlenden Tag)
};

const r1 = (x) => (x == null || !Number.isFinite(+x) ? null : Math.round(+x * 10) / 10);
const ri = (x) => (x == null || !Number.isFinite(+x) ? 0 : Math.round(+x));
const sum = (a) => (Array.isArray(a) ? a.reduce((s, x) => s + (+x || 0), 0) : +a || 0);

/** UTC-Zeitpunkte der Ortsstunden eines Ortstags in Reihenfolge (23/24/25 Stunden an Umstellungstagen) */
export function localHours(day, tz = 'Europe/Berlin') {
  const out = [], t0 = Date.parse(`${day}T00:00:00Z`);
  for (let t = t0 - 4 * 3600e3; t <= t0 + 28 * 3600e3; t += 3600e3) if (T.dayOf(t, tz) === day) out.push(t);
  return out;
}
/** Ende des Ortstags (erster Zeitpunkt des Folgetags) */
export const dayEndMs = (day, tz = 'Europe/Berlin') => { const h = localHours(day, tz); return h.length ? h[h.length - 1] + 3600e3 : Date.parse(`${day}T23:00:00Z`); };
/** Ist der Ortstag archivreif? (abgeschlossen und readyAfterH Stunden vorbei) */
export const trainReady = (day, now, { tz = 'Europe/Berlin', afterH = TRAIN.readyAfterH } = {}) => now >= dayEndMs(day, tz) + afterH * 3600e3;
export const trainPath = (day) => `${TRAIN.dir}/${day.slice(0, 4)}/${day}.json.gz`;

/** Stundenwerte aus Wetter-Tagesdateien (UTC-Tage) auf die Ortsstunden eines Tages: { cells: { k: [t[24], p[24], w[24], s[24]] }, ags } */
export function weatherLocal(day, docs = [], tz = 'Europe/Berlin') {
  const byDay = new Map(); for (const d of docs || []) if (d?.day && d.cells) byDay.set(d.day, d);
  if (!byDay.size) return null;
  const cells = {}, hours = localHours(day, tz); let agsMap = null, n = 0;
  for (const ms of hours) {
    const ud = new Date(ms).toISOString().slice(0, 10), uh = new Date(ms).getUTCHours(), lh = T.hourOf(ms, tz), doc = byDay.get(ud);
    if (!doc) continue; agsMap = agsMap || doc.ags || null;
    for (const [k, c] of Object.entries(doc.cells)) {
      const row = cells[k] || (cells[k] = [0, 1, 2, 3].map(() => new Array(24).fill(null)));
      ['t', 'p', 'w', 's'].forEach((f, i) => { const v = c?.[f]?.[uh]; if (v != null) { row[i][lh] = v; n++; } });
    }
  }
  return n ? { cells, ags: agsMap, src: [...new Set(hours.map(ms => new Date(ms).toISOString().slice(0, 10)))].filter(d => byDay.has(d)) } : null;
}

/** Bestand je Gruppe × Ortsstunde: Mittel der zählenden Läufe (history.f = 0 zählt nicht) */
export function stockHourly(history, tz = 'Europe/Berlin') {
  if (!history?.t?.length || !history.series) return null;
  const hrs = history.t.map(ms => T.hourOf(ms, tz)), ok = history.t.map((_, i) => (history.f ? history.f[i] !== 0 : true)), out = {};
  for (const [k, s] of Object.entries(history.series)) {
    const rows = TRAIN.stock.map(f => {
      const a = s?.[f]; if (!Array.isArray(a)) return null;
      const acc = new Array(24).fill(0), n = new Array(24).fill(0);
      a.forEach((v, i) => { if (ok[i] && v != null && Number.isFinite(+v)) { acc[hrs[i]] += +v; n[hrs[i]]++; } });
      return n.some(x => x) ? acc.map((x, h) => (n[h] ? r1(x / n[h]) : null)) : null;
    });
    if (rows.some(Boolean)) out[k] = rows;
  }
  return out;
}

/** Bitmaske (Bit h = Ortsstunde h) je Merkmal und Gemeinde; nur Einträge ≠ 0 */
function ctxMasks(lookup, agsList, day) {
  const out = {};
  for (const ags of agsList) for (let h = 0; h < 24; h++) {
    const v = lookup(ags, day, h);
    v.forEach((x, i) => { if (x) { const k = CX.CTX_KEYS[i]; (out[k] || (out[k] = {}))[ags] = ((out[k][ags] || 0) | (1 << h)) >>> 0; } });
  }
  return out;
}
const touchesDay = (e, day) => String(e.von).slice(0, 10) <= day && String(e.bis ?? e.von).slice(0, 10) >= day;

/**
 * Archivdatei eines Ortstags. events: events/<Tag>.json (Pflicht); history: history/<Tag>.json; weather: Wetter-Tagesdateien (UTC) um den Tag;
 * weatherFc: wie ausgegebene Vorhersage (weather-fc/<UTC-Tag>.json); incidents: incidents/<Tag>.json; calendar: calendar.json;
 * curated: Einträge, die zur Zeit in der Prognose wirken; pending: erfasst, aber zurückgehalten (Lernphase); checks: latest.eventChecks;
 * series: forecast/series.json; log: forecast/log.json. Fehlende Teile bleiben null (Nachholen alter Tage).
 */
export function trainDoc({ events, history = null, weather = [], weatherFc = [], incidents = null, calendar = null, curated = [], pending = [], checks = null, series = null, log = null, families = {}, now = Date.now(), tz = 'Europe/Berlin' } = {}) {
  const day = events?.day; if (!day || !events.groups) return null;
  const g = {}, x = {}, small = [];
  for (const [k, grp] of Object.entries(events.groups)) {
    const starts = sum(grp.start), few = starts > 0 && starts < TRAIN.minStarts;
    g[k] = TRAIN.fields.map(f => { const a = grp[f]; if (!Array.isArray(a)) return null; const v = a.map(ri); return few && (f === 'start' || f === 'end') ? sum(v) : v; });
    if (few) small.push(k);
    const sv = TRAIN.sums.map(f => (grp[f] == null ? null : r1(grp[f]))); if (sv.some(v => v)) x[k] = sv;
  }
  const agsList = [...new Set(Object.keys(events.groups).map(k => k.split('|')[0]))].sort();
  // Tagtyp je Land, wie er damals galt (W/F/S/H; Kalender wird laufend neu abgerufen)
  const dayType = Object.fromEntries(['BB', 'BE', 'BW', 'BY', 'HB', 'HE', 'HH', 'MV', 'NI', 'NW', 'RP', 'SH', 'SL', 'SN', 'ST', 'TH'].map(l => [l, E.dayType(day, l, calendar)]));
  // Kennzeichen, wie sie an diesem Tag in der Prognose galten (model) und einschließlich zurückgehaltener Einträge (all)
  const incDocs = incidents ? [incidents] : [];
  const model = ctxMasks(CX.ctxLookup(incDocs, curated), agsList, day), all = ctxMasks(CX.ctxLookup(incDocs, [...curated, ...pending]), agsList, day);
  const held = {}; for (const [k, m] of Object.entries(all)) for (const [a, v] of Object.entries(m)) { const d = (v & ~(model[k]?.[a] || 0)) >>> 0; if (d) (held[k] || (held[k] = {}))[a] = d; }
  const src = (list, aktiv) => list.filter(e => touchesDay(e, day)).map(e => ({ art: e.art, von: e.von, bis: e.bis ?? e.von, gebiet: e.gebiet, titel: e.titel ?? e.name ?? null, quelle: e.quelle ?? null, aktiv, ...(e.auto ? { auto: true } : {}) }));
  // Ampel des Tages (nur wenn die Prüfung genau diesen Tag betrifft): nur auffällige Gruppen
  const chk = checks?.day === day ? { rules: checks.dayRules ?? null, ruleNow: checks.ruleNow ?? null, n: Object.keys(checks.groups || {}).length,
    level: Object.fromEntries(Object.entries(checks.groups || {}).filter(([, v]) => v?.level && v.level !== 'ok').map(([k, v]) => [k, v.level])) } : null;
  // eigene Prognose: eingefrorener Plan je Ebene, Modell, Selbstprüfung, Live-Abgleiche mit Beginn an diesem Tag
  const fcOf = (ser, lg) => {
    const sd = ser?.days?.[day], plan = sd ? Object.fromEntries(Object.entries(sd).filter(([, v]) => Array.isArray(v?.p)).map(([k, v]) => [k, v.p.map(r1)])) : null;
    const live = lg?.live ? Object.values(lg.live).filter(l => l?.from && T.dayOf(l.from, tz) === day) : [];
    return plan || lg?.evals?.[day] || live.length ? { meta: ser?.plans?.[day] ?? null, plan, eval: lg?.evals?.[day] ?? null, live } : null;
  };
  const fc = fcOf(series, log), fcFam = Object.fromEntries(Object.entries(families || {}).map(([f, v]) => [f, fcOf(v?.series, v?.log)]).filter(([, v]) => v));
  return {
    v: TRAIN.version, day, tz, at: new Date(now).toISOString(), lagH: Math.round((now - dayEndMs(day, tz)) / 3600e3),
    runs: events.runs || [], obs: E.observedMinutes(events.runs || [], tz).map(r1), hourMin: events.hourMin ?? null, gapHours: events.gapHours ?? [], srcModes: events.srcModes ?? null,
    f: TRAIN.fields, g, small, xf: TRAIN.sums, x,
    sf: TRAIN.stock, s: stockHourly(history, tz),
    dayType, wx: weatherLocal(day, weather, tz), wxFc: weatherLocal(day, weatherFc, tz),
    ctxKeys: CX.CTX_KEYS, ctx: model, ctxHeld: held, ctxSrc: [...src(curated, true), ...src(pending, false)],
    checks: chk, fc, fcFam,
  };
}

/** Lesen: Bitmaske → 0/1 je Stunde; Stundenreihe eines Feldes (Tagessumme bei kleinen Gruppen → null je Stunde) */
export const maskHours = (m) => Array.from({ length: 24 }, (_, h) => ((m >>> h) & 1));
export function trainSeries(doc, key, field) {
  const i = (doc?.f || TRAIN.fields).indexOf(field), row = doc?.g?.[key]?.[i];
  return Array.isArray(row) ? row : row == null ? null : { daySum: row };
}

/** Archivreife Tage ohne Archivdatei, älteste zuerst, höchstens n */
export function trainTodo(eventDays = [], haveDays = new Set(), now = Date.now(), { tz = 'Europe/Berlin', n = TRAIN.perRun } = {}) {
  return [...eventDays].sort().filter(d => !haveDays.has(d) && trainReady(d, now, { tz })).slice(0, n);
}

/** Vorhersage-Sicherung (DAT-08): Wetterdatei, die vor Beginn ihres UTC-Tages geschrieben wurde, ist Vorhersage – vor dem Überschreiben sichern */
export const isForecastDoc = (doc) => !!(doc?.day && doc.generatedAt && doc.generatedAt.slice(0, 10) < doc.day);

// ---------- Zellen als Wochensumme (Audit DAT-02) ----------
// cells/<Tag>/<Land>.json lebt nur 14 Tage. Je abgeschlossener ISO-Woche eine unveränderliche Datei train-cells/<JJJJ>/<JJJJ>-W<KW>.json.gz mit der
// Summe der veröffentlichten (schon unterdrückten) Tagesdateien je Land: Zellwerte (fields wie in cells/), unterdrückte Reste (below), Bandminuten
// und Bandläufe. Keine neuen Daten, nur länger: was je Tag öffentlich war, bleibt als Wochensumme.
export const CELLS_WEEK = { dir: 'train-cells', readyAfterH: 8, perRun: 2 };
/** ISO-Woche eines Tages: { key: 'JJJJ-Wkk', from: Montag, to: Sonntag } */
export function isoWeek(day) {
  const t = Date.parse(`${day}T12:00:00Z`), wd = (new Date(t).getUTCDay() + 6) % 7, mon = t - wd * 86400e3, thu = mon + 3 * 86400e3;
  const y = new Date(thu).getUTCFullYear(), jan4 = Date.parse(`${y}-01-04T12:00:00Z`), w1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86400e3;
  const wk = Math.round((mon - w1) / (7 * 86400e3)) + 1, iso = (x) => new Date(x).toISOString().slice(0, 10);
  return { key: `${y}-W${String(wk).padStart(2, '0')}`, from: iso(mon), to: iso(mon + 6 * 86400e3) };
}
export const cellsWeekPath = (key) => `${CELLS_WEEK.dir}/${key.slice(0, 4)}/${key}.json.gz`;
/** Abgeschlossene Wochen (Sonntag + readyAfterH vorbei) mit vorhandenen Tagesordnern und ohne Wochendatei, älteste zuerst */
export function cellsWeekTodo(cellDays = [], haveWeeks = new Set(), now = Date.now(), { tz = 'Europe/Berlin', n = CELLS_WEEK.perRun } = {}) {
  const weeks = new Map(); for (const d of [...cellDays].sort()) { const w = isoWeek(d); if (!weeks.has(w.key)) weeks.set(w.key, { ...w, days: [] }); weeks.get(w.key).days.push(d); }
  return [...weeks.values()].filter(w => !haveWeeks.has(w.key) && now >= dayEndMs(w.to, tz) + CELLS_WEEK.readyAfterH * 3600e3).slice(0, n);
}
const addInto = (acc, v) => { for (let i = 0; i < v.length; i++) acc[i] = (acc[i] || 0) + (+v[i] || 0); return acc; };
/** Wochensumme aus Tagesdateien { day, state, munis, below, bandMin, bandRuns, fields, belowFields, minCount } */
export function cellsWeekDoc(week, docs = [], now = Date.now()) {
  const states = {}, days = new Set(); let fields = null, belowFields = null, minCount = null;
  for (const d of docs) {
    if (!d?.state || !d.munis) continue; days.add(d.day); fields = fields || d.fields; belowFields = belowFields || d.belowFields; minCount = minCount ?? d.minCount ?? null;
    const s = states[d.state] || (states[d.state] = { days: [], bandMin: [], bandRuns: [], munis: {}, below: {} });
    s.days.push(d.day); addInto(s.bandMin, d.bandMin || []); addInto(s.bandRuns, d.bandRuns || []);
    for (const [ags, cells] of Object.entries(d.munis)) { const m = s.munis[ags] || (s.munis[ags] = {}); for (const [c, v] of Object.entries(cells)) if (Array.isArray(v)) m[c] = addInto(m[c] || new Array(T.CELL_LEN).fill(0), v); }
    for (const [ags, v] of Object.entries(d.below || {})) if (Array.isArray(v)) s.below[ags] = addInto(s.below[ags] || [], v);
  }
  for (const s of Object.values(states)) { s.days.sort(); s.bandMin = s.bandMin.map(x => Math.round(x * 10) / 10); }
  return { v: 1, week: week.key, from: week.from, to: week.to, days: [...days].sort(), at: new Date(now).toISOString(), fields, belowFields, minCount, states };
}
