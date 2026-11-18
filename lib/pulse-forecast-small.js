// @ts-check
// Familien ohne tragfähiges Volumen (E-Roller, Carsharing; S2.6, 18.11.2026): wann das Dashboard statt einer Prognose einen ehrlichen Stand
// zeigt und woran es liegt. Der Sammler veröffentlicht unter MIN_VOLUME die Vorwoche; bei wenigen Fahrten je Tag in ganz Deutschland wären
// deren Stundenwerte 0–2 und jede Fehlerzahl Zufall (18.11.2026: E-Roller 1 Fahrtbeginn je Tag, Prognose 4, „100 % zu niedrig“).

/** Unter minPerDay Fahrtbeginnen je Tag (Mittel 7 Tage, alle Gemeinden; latest.volume) zeigt das Dashboard für die Familie keine Prognose,
 * auch nicht die Vorwoche. still: Anbieter mit mindestens minVehicles gemeldeten Fahrzeugen und keinem Fahrtbeginn in days Tagen. */
export const SMALL_SHOW = Object.freeze({ minPerDay: 50, days: 7, minVehicles: 10 });

/** Arten je Familie (Gegenstück zu familyOf in pulse-core) */
export const FAMILY_TYPES = Object.freeze({ moped: ['moped'], car: ['car'] });

/** true = für diese Familie keine Prognose zeigen (latest.json der Familie) */
export const smallNoForecast = (L) => !!L && (L.status === 'insufficient' || (L.status === 'small' && (!L.active || (L.volume ?? 0) < SMALL_SHOW.minPerDay)));

const addDay = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * Stand je Anbieter einer Familie: gemeldete Fahrzeuge der Familie (latest.municipalities[ags].operators[op].types) und gezählte
 * Fahrtbeginne der letzten SMALL_SHOW.days abgeschlossenen Tage vor today (series.days[d]['op:<Anbieter>'].a).
 * ags: nur diese Gemeinde (Fahrzeuge); Fahrtbeginne bleiben je Anbieter, weil die Reihen der Familie nur Anbieter-Summen führen.
 * sources (latest.sources): down = alle Quellen des Anbieters liefern gerade nicht (Status weder live noch verzögert).
 * @param {any} series  series.json der Familie
 * @param {Record<string, any>|null|undefined} munis  latest.municipalities
 * @param {string[]} types  Arten der Familie
 * @param {string} today  Ortstag (series.today)
 * @param {{ ags?: string|null, sources?: any[]|null }} [o]
 */
export function smallState(series, munis, types, today, o = {}) {
  const days = [];
  for (let i = 1; i <= SMALL_SHOW.days; i++) { const d = addDay(today, -i); if (series?.days?.[d]) days.push(d); }
  /** @type {Map<string, { op: string, ags: string[], vehicles: number, starts: number }>} */ const by = new Map();
  const row = (op) => { let r = by.get(op); if (!r) by.set(op, (r = { op, ags: [], vehicles: 0, starts: 0 })); return r; };
  for (const [ags, m] of Object.entries(munis || {})) {
    if (o.ags && o.ags !== 'DE' && ags !== o.ags) continue;
    for (const [op, x] of Object.entries(m?.operators || {})) {
      let n = 0; for (const ty of types) n += x?.types?.[ty] || 0;
      if (n > 0) { const r = row(op); r.vehicles += n; if (!r.ags.includes(ags)) r.ags.push(ags); }
    }
  }
  for (const d of days) for (const [k, v] of Object.entries(series.days[d] || {})) {
    if (!k.startsWith('op:') || !Array.isArray(v?.a)) continue;
    const s = v.a.reduce((t, y) => t + (y || 0), 0), op = k.slice(3);
    if (s > 0 || by.has(op)) row(op).starts += s;
  }
  const srcOf = (op) => (o.sources || []).filter(s => s?.operator === op && !s.candidate);
  const rows = [...by.values()].map(r => { const src = srcOf(r.op);
    return { ...r, days: days.length, still: r.vehicles >= SMALL_SHOW.minVehicles && r.starts === 0 && days.length >= 3, down: src.length > 0 && src.every(s => !['live', 'delayed'].includes(s.status)) }; })
    .sort((a, b) => b.vehicles - a.vehicles || b.starts - a.starts || a.op.localeCompare(b.op));
  const starts = rows.reduce((t, r) => t + r.starts, 0), vehicles = rows.reduce((t, r) => t + r.vehicles, 0);
  return { rows, days: days.length, starts, perDay: days.length ? starts / days.length : null, vehicles };
}
