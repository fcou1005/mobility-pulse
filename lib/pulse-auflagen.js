// @ts-check
// Mobility Pulse — Datenauflagen-Check (S5.1, F1): Verfügbarkeit der offenen Feeds im Kalenderjahr und Auflagen je Stadt und Anbieter.
// Jahresbuch (auflagen/verfuegbarkeit-<Jahr>.json, Phase „ereignisse“): je Quelle Tage der letzten Zeit einzeln (aus state.rel, 7 Tage), ältere
// Tage zu Monaten verdichtet. „Verfügbar“ = Lauf, in dem der Feed aktuell oder leicht verzögert lieferte (live, delayed); veraltet, Fehler,
// weg und gesperrt zählen als nicht verfügbar. Ziel aus den üblichen Genehmigungsauflagen: 96 % der Läufe im Kalenderjahr.

export const AVAIL_TARGET = 0.96, AVAIL_NEAR = 0.9;
export const LEDGER_VERSION = '1.0';
const KEEP_DAYS = 10; // so lange bleiben Tage einzeln (state.rel überschreibt sie bis zu 8 Tage rückwirkend), danach im Monat

/** @typedef {[number, number, number]} Cnt  [Läufe, verfügbar, Fehler] */
/** @typedef {{ mo: Record<string, Cnt>, d: Record<string, Cnt>, first: string }} SrcLedger */
/** @typedef {{ schemaVersion: string, year: number, at: number, sources: Record<string, SrcLedger> }} Ledger */

const daysBetween = (/** @type {string} */ a, /** @type {string} */ b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

/**
 * Jahresbuch fortschreiben. rel: state.rel der Verfolgung ({ id: { 'YYYY-MM-DD': [runs, live, delayed, stale, err, lat] } }), today: Ortstag.
 * Wechselt das Jahr, beginnt ein neues Buch (das alte bleibt als eigene Datei liegen).
 * @param {Ledger|null} prev @param {Record<string, Record<string, number[]>>} rel @param {{ today: string, now: number }} o
 * @returns {Ledger}
 */
export function updateLedger(prev, rel, { today, now }) {
  const year = +today.slice(0, 4);
  /** @type {Ledger} */
  const L = prev && prev.year === year ? { ...prev, at: now, sources: { ...prev.sources } } : { schemaVersion: LEDGER_VERSION, year, at: now, sources: {} };
  for (const [id, days] of Object.entries(rel || {})) {
    const e = L.sources[id] ? { mo: { ...L.sources[id].mo }, d: { ...L.sources[id].d }, first: L.sources[id].first } : { mo: {}, d: {}, first: today };
    for (const [day, c] of Object.entries(days)) {
      if (+day.slice(0, 4) !== year || daysBetween(day, today) > KEEP_DAYS || day in e.mo) continue; // anderes Jahr; schon verdichtet
      e.d[day] = [c[0] || 0, (c[1] || 0) + (c[2] || 0), c[4] || 0];
      if (day < e.first) e.first = day;
    }
    L.sources[id] = e;
  }
  // Tage außerhalb des Fensters in den Monat verdichten (endgültig: state.rel kennt sie nicht mehr)
  for (const e of Object.values(L.sources)) for (const [day, c] of Object.entries(e.d)) {
    if (daysBetween(day, today) <= KEEP_DAYS) continue;
    const m = day.slice(0, 7), t = (e.mo[m] ||= [0, 0, 0]); t[0] += c[0]; t[1] += c[1]; t[2] += c[2]; delete e.d[day];
  }
  return L;
}

/** Verfügbarkeit einer Quelle im Jahr: Anteil verfügbarer Läufe (null ohne Läufe), Läufe, gemessen seit */
export function yearAvailability(/** @type {Ledger|null} */ L, /** @type {string} */ id) {
  const e = L?.sources?.[id]; if (!e) return null;
  let runs = 0, ok = 0, err = 0;
  for (const c of [...Object.values(e.mo), ...Object.values(e.d)]) { runs += c[0]; ok += c[1]; err += c[2]; }
  return { runs, ok, err, share: runs ? ok / runs : null, from: e.first };
}
/** Monatswerte einer Quelle (für den Monatsnachweis) */
export function monthAvailability(/** @type {Ledger|null} */ L, /** @type {string} */ id, /** @type {string} */ month) {
  const e = L?.sources?.[id]; if (!e) return null;
  let runs = 0, ok = 0; const m = e.mo[month]; if (m) { runs += m[0]; ok += m[1]; }
  for (const [day, c] of Object.entries(e.d)) if (day.startsWith(month)) { runs += c[0]; ok += c[1]; }
  return { runs, ok, share: runs ? ok / runs : null };
}
/** Ampel gegen die Auflage: ok ab 96 %, nahe ab 90 %, sonst unter; ohne Läufe unbekannt */
export const availLevel = (/** @type {number|null|undefined} */ share) => (share == null ? 'unknown' : share >= AVAIL_TARGET ? 'ok' : share >= AVAIL_NEAR ? 'near' : 'bad');

/**
 * Auflagen je Anbieter in einer Gemeinde: Feed vorhanden, Datenalter, Jahresverfügbarkeit, Zonen, Preise, Lizenz, GBFS-Version.
 * sources: latest.sources; pricing: pricing.json (plans je Anbieter, optional). Dubletten und ausgemusterte Quellen zählen nicht.
 * @param {{ sources?: any[] }} latest @param {Ledger|null} ledger @param {{ ags: string, pricing?: any, now?: number }} o
 */
export function obligations(latest, ledger, { ags, pricing = null, now = Date.now() }) {
  const recs = (latest?.sources || []).filter(r => (r.municipalities || []).includes(ags) && !['duplicate', 'retired'].includes(r.status) && !r.candidate);
  /** @type {Map<string, any[]>} */ const byOp = new Map();
  for (const r of recs) { const op = r.operator || r.name || r.id; if (!byOp.has(op)) byOp.set(op, []); byOp.get(op)?.push(r); }
  const pricedIds = new Set((pricing?.plans || []).filter((/** @type {any} */ p) => (p.plans || []).length).map((/** @type {any} */ p) => p.sourceId));
  return [...byOp].map(([op, rs]) => {
    const live = rs.filter(r => ['live', 'delayed', 'stale', 'empty'].includes(r.status));
    // Jahresverfügbarkeit: Summe über die Quellen des Anbieters (ein Anbieter mit zwei Feeds braucht beide)
    let runs = 0, ok = 0, from = null;
    for (const r of rs) { const a = yearAvailability(ledger, r.id); if (!a) continue; runs += a.runs; ok += a.ok; if (!from || a.from < from) from = a.from; }
    const share = runs ? ok / runs : null;
    const ages = rs.map(r => r.feedAgeMs).filter(x => Number.isFinite(x));
    return {
      op, sources: rs.map(r => r.id), feed: live.length > 0, status: rs.map(r => r.status),
      ageMs: ages.length ? Math.max(...ages) : null,
      avail: share, runs, from, level: availLevel(share),
      zones: rs.some(r => (r.zones?.count ?? 0) > 0 || (r.feeds || []).includes('geofencing_zones')),
      prices: rs.some(r => pricedIds.has(r.id) || (r.feeds || []).includes('system_pricing_plans')),
      license: rs.map(r => r.licenseId || r.license).find(Boolean) || null,
      version: rs.map(r => r.version).find(Boolean) || null,
      api: rs.map(r => r.api).find(Boolean) || null,
    };
  }).sort((a, b) => a.op.localeCompare(b.op, 'de'));
}
