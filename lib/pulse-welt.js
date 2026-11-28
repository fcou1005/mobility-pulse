// Mobility Pulse — Länder außerhalb Deutschlands (Reiter „Länder“, Stufe 1, 28.11.2026): Sharing-Bestand je Land, Stadt und Anbieter aus den
// offenen GBFS-Feeds des MobilityData-Verzeichnisses (systems.csv; Japan dort über die ODPT). Reine Rechenlogik für scripts/welt.mjs (ein Prozess
// je Land) und web/welt.js. Deutschland bleibt im bestehenden Sammler; hier nur die übrigen Länder Europas und Japan.
// Abgänge/Zugänge sind geschätzt: Stationen über die Bestandsänderung je Station, frei abgestellte Fahrzeuge über die Position (an einer Stelle
// stand ein Fahrzeug, im nächsten Lauf steht dort im Umkreis von nearM keines mehr) – unabhängig von wechselnden Kennungen. Umsetzungen zählen mit.

export const WELT = Object.freeze({
  version: 1,
  csvUrl: 'https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv',
  keepDays: 14, // Tagesdateien je Land
  maxGapMin: 40, // längere Lücke zwischen zwei Läufen eines Landes: keine Abgänge/Zugänge
  nearM: 30, // Umkreis für „Fahrzeug noch da“ (Kennungswechsel ohne Bewegung zählt nicht)
  cellLat: 0.0025, cellLon: 0.004, // Kartenzellen frei abgestellter Fahrzeuge (≈ 280 × 280 m in Mitteleuropa)
  sysConcurrency: 8, // Systeme je Land gleichzeitig
  procConcurrency: 4, // Länder (Prozesse) gleichzeitig
  budgetMs: 300e3, // Frist ab Start der Länder im Sammler-Lauf
});

/** Länder mit Zeitzone (Ortszeit der Stundenwerte) und Region; Deutschland fehlt bewusst (eigener Sammler) */
export const COUNTRIES = Object.freeze({
  AT: 'Europe/Vienna', BE: 'Europe/Brussels', BG: 'Europe/Sofia', BA: 'Europe/Sarajevo', CH: 'Europe/Zurich', CY: 'Asia/Nicosia', CZ: 'Europe/Prague',
  DK: 'Europe/Copenhagen', EE: 'Europe/Tallinn', ES: 'Europe/Madrid', FI: 'Europe/Helsinki', FR: 'Europe/Paris', GB: 'Europe/London', GR: 'Europe/Athens',
  HR: 'Europe/Zagreb', HU: 'Europe/Budapest', IE: 'Europe/Dublin', IS: 'Atlantic/Reykjavik', IT: 'Europe/Rome', LI: 'Europe/Vaduz', LT: 'Europe/Vilnius',
  LU: 'Europe/Luxembourg', LV: 'Europe/Riga', MT: 'Europe/Malta', NL: 'Europe/Amsterdam', NO: 'Europe/Oslo', PL: 'Europe/Warsaw', PT: 'Europe/Lisbon',
  RO: 'Europe/Bucharest', RS: 'Europe/Belgrade', SE: 'Europe/Stockholm', SI: 'Europe/Ljubljana', SK: 'Europe/Bratislava', TR: 'Europe/Istanbul', UA: 'Europe/Kyiv',
  JP: 'Asia/Tokyo',
});
export const regionOf = (/** @type {string} */ cc) => (cc === 'JP' ? 'jp' : 'eu');
export const SYS_FIELDS = Object.freeze(['id', 'name', 'stadt', 'anbieter', 'ok', 'fahrzeuge', 'gesperrt', 'stationen', 'leer', 'voll', 'arten', 'lizenz', 'lizenzUrl', 'stand', 'fehler']);
export const HOUR_FIELDS = Object.freeze(['stunde', 'laeufe', 'verfuegbar', 'stationen', 'leer', 'voll', 'ab', 'an', 'minuten']);

/** CSV mit Anführungszeichen (systems.csv) @param {string} text @returns {string[][]} */
export function parseCsv(text) {
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(c => c !== '')) out.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell); if (row.some(c => c !== '')) out.push(row);
  return out;
}

/**
 * Systeme je Land aus systems.csv: ohne Deutschland, ohne Zugangsdaten, nur Länder aus COUNTRIES
 * @param {string} text @returns {Record<string, Array<{ id: string, name: string, city: string, url: string, home: string }>>}
 */
export function catalogByCountry(text) {
  const rows = parseCsv(text), head = rows.shift() || [], ix = (/** @type {string} */ n) => head.findIndex(h => h.trim().toLowerCase() === n);
  const [cC, cN, cL, cId, cUrl, cAuto, cAuth] = ['country code', 'name', 'location', 'system id', 'url', 'auto-discovery url', 'authentication type'].map(ix);
  /** @type {Record<string, Array<{ id: string, name: string, city: string, url: string, home: string }>>} */
  const by = {};
  for (const r of rows) {
    const cc = String(r[cC] || '').trim().toUpperCase(), url = String(r[cAuto] || '').trim();
    if (!Object.hasOwn(COUNTRIES, cc) || !/^https?:\/\//.test(url) || (cAuth >= 0 && String(r[cAuth] || '').trim())) continue;
    const id = String(r[cId] || '').trim() || url;
    (by[cc] ||= []).push({ id, name: String(r[cN] || '').trim(), city: String(r[cL] || '').trim(), url, home: String(r[cUrl] || '').trim() });
  }
  for (const [k, list] of Object.entries(by)) { const seen = new Set(); by[k] = list.filter(x => (seen.has(x.url) ? false : (seen.add(x.url), true))); }
  return by;
}

/** Ortszeit: Tag und Stunde @param {number} ms @param {string} tz @returns {{ day: string, h: number }} */
export function localDayHour(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, h: +p.hour % 24 };
}

const r5 = (/** @type {number} */ x) => Math.round(x * 1e5) / 1e5;
const ok = (/** @type {any} */ lat, /** @type {any} */ lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

/**
 * Kennzahlen eines gelesenen Systems (readGbfsSystem): verfügbare Fahrzeuge je Art, gesperrt, Stationen (ohne virtuelle), leer, voll,
 * dazu die Punkte für Abgänge/Karte. Stehen Fahrzeuge der Liste an Stationen (station_id), zählen die Stationen nicht noch einmal.
 * @param {any} sys
 */
export function summarize(sys) {
  /** @type {Record<string, number>} */
  const types = {};
  let avail = 0, disabled = 0, stations = 0, empty = 0, full = 0;
  /** @type {Array<[number, number]>} */
  const free = []; // frei abgestellte, verfügbare Fahrzeuge
  /** @type {Array<[string, number, number, number, number, number]>} */
  const st = []; // [Station, lat, lon, Räder ausleihbar, freie Plätze, Zustand]
  const docked = (sys.vehicles || []).some((/** @type {any} */ v) => v.stationId);
  for (const v of sys.vehicles || []) {
    if (v.disabled) { disabled++; continue; }
    if (v.reserved) continue;
    avail++; types[v.type] = (types[v.type] || 0) + 1;
    if (!v.stationId && ok(v.lat, v.lon)) free.push([r5(v.lat), r5(v.lon)]);
  }
  for (const s of sys.stations || []) {
    if (s.isVirtual || !ok(s.lat, s.lon)) continue;
    stations++;
    const b = Math.max(0, Math.round(s.bookable ?? 0)), d = s.docksAvailable == null ? null : Math.max(0, Math.round(s.docksAvailable));
    const z = (s.installed && s.renting ? 0 : 1) | (s.installed && s.returning ? 0 : 2);
    if (!(z & 1) && b === 0) empty++;
    if (!(z & 2) && d === 0) full++;
    if (!sys.vehicleListPresent || !docked) { avail += b; if (s.perType) for (const [ty, n] of Object.entries(s.perType)) types[ty] = (types[ty] || 0) + /** @type {number} */ (n); else if (b) types[s.typeHint || 'unknown'] = (types[s.typeHint || 'unknown'] || 0) + b; }
    st.push([String(s.id), r5(s.lat), r5(s.lon), b, d ?? -1, z]);
  }
  // mit Fahrzeugliste und station_id: Räder je Station aus der Liste (Stand der Station kann fehlen)
  if (sys.vehicleListPresent && docked) {
    /** @type {Map<string, number>} */
    const at = new Map(); for (const v of sys.vehicles || []) if (v.stationId && !v.disabled && !v.reserved) at.set(v.stationId, (at.get(v.stationId) || 0) + 1);
    for (const r of st) if (at.has(r[0])) r[3] = Math.max(r[3], at.get(r[0]) || 0);
  }
  return { avail, disabled, stations, empty, full, types, free, st };
}

/** Raster für Umkreissuche @param {Array<[number, number]>} pts @param {number} m */
function grid(pts, m) {
  const k = m / 111320, cells = new Map();
  for (const p of pts) { const key = `${Math.floor(p[0] / k)}|${Math.floor(p[1] / k)}`; let a = cells.get(key); if (!a) cells.set(key, a = []); a.push(p); }
  return { k, cells };
}
const nearAny = (/** @type {{ k: number, cells: Map<string, any[]> }} */ g, /** @type {[number, number]} */ p, /** @type {number} */ m) => {
  const a = Math.floor(p[0] / g.k), b = Math.floor(p[1] / g.k), cos = Math.cos(p[0] * Math.PI / 180);
  for (let i = -1; i <= 1; i++) for (let j = -2; j <= 2; j++) for (const q of g.cells.get(`${a + i}|${b + j}`) || []) { const dy = (q[0] - p[0]) * 111320, dx = (q[1] - p[1]) * 111320 * cos; if (dx * dx + dy * dy <= m * m) return true; }
  return false;
};

/**
 * Abgänge/Zugänge zwischen zwei Läufen eines Systems: frei abgestellte Fahrzeuge über die Position, Stationen über die Änderung je Station
 * @param {{ free: Array<[number, number]>, st: any[][] } | null} prev @param {{ free: Array<[number, number]>, st: any[][] }} cur @param {number} [m]
 * @returns {{ out: number, in: number }}
 */
export function moves(prev, cur, m = WELT.nearM) {
  if (!prev) return { out: 0, in: 0 };
  let out = 0, inn = 0;
  const gp = grid(prev.free || [], m), gc = grid(cur.free || [], m);
  for (const p of prev.free || []) if (!nearAny(gc, p, m)) out++;
  for (const p of cur.free || []) if (!nearAny(gp, p, m)) inn++;
  const was = new Map((prev.st || []).map(r => [r[0], +r[3]]));
  for (const r of cur.st || []) { const w = was.get(r[0]); if (w == null) continue; if (r[3] < w) out += w - r[3]; else inn += r[3] - w; }
  return { out, in: inn };
}

/** Kartenzellen frei abgestellter Fahrzeuge: [lat, lon, Anzahl] (Zellmitte) @param {Array<[number, number]>} free */
export function cellsOf(free) {
  /** @type {Map<string, number>} */
  const c = new Map();
  for (const [lat, lon] of free) { const k = `${Math.floor(lat / WELT.cellLat)}|${Math.floor(lon / WELT.cellLon)}`; c.set(k, (c.get(k) || 0) + 1); }
  return [...c].map(([k, n]) => { const [a, b] = k.split('|').map(Number); return [r5((a + 0.5) * WELT.cellLat), r5((b + 0.5) * WELT.cellLon), n]; });
}

/**
 * Lauf in eine Stunde der Tagesdatei eintragen (sys → Zeilen HOUR_FIELDS, Summen über die Läufe der Stunde)
 * @param {{ sys: Record<string, number[][]> }} day @param {string} id @param {number} h
 * @param {{ avail: number, stations: number, empty: number, full: number, out?: number, in?: number, min?: number }} v
 */
export function addHour(day, id, h, v) {
  const rows = day.sys[id] || (day.sys[id] = []);
  let r = rows.find(x => x[0] === h);
  if (!r) { r = [h, 0, 0, 0, 0, 0, 0, 0, 0]; rows.push(r); rows.sort((a, b) => a[0] - b[0]); }
  r[1]++; r[2] += v.avail; r[3] += v.stations; r[4] += v.empty; r[5] += v.full; r[6] += v.out || 0; r[7] += v.in || 0; r[8] += v.min || 0;
  return day;
}

/**
 * Stunden eines Landes (alle Systeme oder eines) für Diagramm und Tabelle: Mittel der verfügbaren Fahrzeuge, Anteil leerer Stationen,
 * Abgänge je Stunde (hochgerechnet auf 60 Minuten, ab 10 Minuten mit Vergleich)
 * @param {any} day @param {string|null} [id]
 * @returns {Array<{ h: number, avail: number, empty: number|null, outH: number|null, out: number, in: number, min: number }>}
 */
export function hourly(day, id = null) {
  /** @type {Map<number, number[]>} */
  const acc = new Map();
  for (const [k, rows] of Object.entries(day?.sys || {})) {
    if (id && k !== id) continue;
    for (const r of /** @type {number[][]} */ (rows)) { if (!r[1]) continue; const a = acc.get(r[0]) || [0, 0, 0, 0, 0, 0, 0]; a[0] += r[2] / r[1]; a[1] += r[3] / r[1]; a[2] += r[4] / r[1]; a[3] += r[6]; a[4] += r[7]; a[5] = Math.max(a[5], r[8]); a[6] += r[8] ? r[6] / r[8] * 60 : 0; acc.set(r[0], a); }
  }
  return [...acc].sort((a, b) => a[0] - b[0]).map(([h, a]) => ({ h, avail: a[0], empty: a[1] ? a[2] / a[1] : null, outH: a[5] >= 10 ? a[6] : null, out: a[3], in: a[4], min: a[5] }));
}

/** Städte eines Landes aus den Systemen (Ort laut Verzeichnis) @param {any[]} systems Zeilen SYS_FIELDS */
export function citiesOf(systems) {
  /** @type {Map<string, { city: string, systems: number, avail: number, stations: number, ops: Set<string>, types: Record<string, number> }>} */
  const m = new Map();
  for (const s of systems) {
    const k = s[2] || '–'; let c = m.get(k); if (!c) m.set(k, c = { city: k, systems: 0, avail: 0, stations: 0, ops: new Set(), types: {} });
    c.systems++; c.avail += s[5] || 0; c.stations += s[7] || 0; if (s[3]) c.ops.add(s[3]);
    for (const [ty, n] of Object.entries(s[10] || {})) c.types[ty] = (c.types[ty] || 0) + /** @type {number} */ (n);
  }
  return [...m.values()].map(c => ({ ...c, ops: [...c.ops].sort() })).sort((a, b) => b.avail - a.avail);
}

/** Anbieter-Name aus Verzeichnis und system_information (gleiche Anbieter in vielen Städten zusammenfassen) @param {string} name @param {string|null} op */
export function operatorName(name, op) {
  const s = `${op || ''} ${name || ''}`;
  for (const [re, v] of KNOWN_OPS) if (re.test(s)) return v;
  return (op || name || '').trim() || '–';
}
/** @type {Array<[RegExp, string]>} */
const KNOWN_OPS = [[/\bnextbike\b/i, 'nextbike'], [/\bgetaround\b/i, 'Getaround'], [/\blime\b/i, 'Lime'], [/\bvoi\b/i, 'Voi'], [/\b(dott|tier)\b/i, 'Dott'], [/\bbolt\b/i, 'Bolt'],
  [/\bbird\b/i, 'Bird'], [/\bdonkey\b/i, 'Donkey Republic'], [/\bzeus\b/i, 'Zeus'], [/\bcooltra\b/i, 'Cooltra'], [/\bcyclocity\b/i, 'Cyclocity (JCDecaux)'], [/\bv[ée]lib/i, 'Vélib\''],
  [/\bberyl\b/i, 'Beryl'], [/hello ?cycling/i, 'HELLO CYCLING'], [/\bdocomo\b/i, 'docomo bike share'], [/\becovelo\b/i, 'Ecovelo'], [/\bcitiz\b/i, 'Citiz'], [/urban ?sharing/i, 'Urban Sharing'],
  [/\bfifteen\b/i, 'Fifteen'], [/\bpony\b/i, 'Pony'], [/\byego\b/i, 'Yego'], [/\bfelyx\b/i, 'Felyx'], [/\bcityscoot\b/i, 'Cityscoot']];

// ---------- Stufe 2a: Tagtyp und Prognose je Land (Profil, 28.11.2026) ----------
// Erste Prognose außerhalb Deutschlands: je Stunde der Median der gleichen Tagtypen (Werktag, Samstag, Sonn- und Feiertag) der letzten Tage –
// wie das Profil-Modell der deutschen Prognose, ohne Wetter und Ereignisse. Feiertage: OpenHolidays API (landesweite Feiertage), Japan aus der
// Feiertagsliste des Cabinet Office (syukujitsu.csv); ohne Quelle nur Wochenenden. Selbstprüfung am Vortag (WAPE).
export const FORECAST = Object.freeze({ minDays: 2, method: 'profil' });
export const HOLIDAY_SOURCES = Object.freeze({ openholidays: 'https://openholidaysapi.org', jp: 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv' });
/** Länder der OpenHolidays API (Stand 28.11.2026, Feiertage); übrige Länder Europas ohne Feiertagsquelle */
export const OPENHOLIDAYS = Object.freeze(['AT', 'BE', 'BG', 'CH', 'CZ', 'EE', 'ES', 'FR', 'HR', 'HU', 'IE', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK']);

/** Tagtyp: H Sonn- oder Feiertag, S Samstag, W Werktag @param {string} day @param {Set<string>|null} [holidays] */
export const dayTypeOf = (day, holidays = null) => { const wd = new Date(`${day}T12:00:00Z`).getUTCDay(); return holidays?.has(day) || wd === 0 ? 'H' : wd === 6 ? 'S' : 'W'; };

/** landesweite Feiertage aus /PublicHolidays der OpenHolidays API (Zeiträume werden zu Tagen) @param {any[]} list @returns {string[]} */
export function holidaysOpen(list) {
  const out = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    if (x?.nationwide === false || !/^\d{4}-\d{2}-\d{2}$/.test(String(x?.startDate))) continue;
    const a = Date.parse(`${x.startDate}T12:00:00Z`), b = Date.parse(`${/^\d{4}-\d{2}-\d{2}$/.test(String(x.endDate)) ? x.endDate : x.startDate}T12:00:00Z`);
    for (let t = a; t <= b && t - a < 40 * 86400e3; t += 86400e3) out.add(new Date(t).toISOString().slice(0, 10));
  }
  return [...out].sort();
}
/** Feiertage Japans aus syukujitsu.csv (Kopfzeile, dann JJJJ/M/T,Name) @param {string} text @returns {string[]} */
export function holidaysJapan(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2}),/.exec(line.trim()); if (m) out.push(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`); }
  return out.sort();
}

const median = (/** @type {number[]} */ xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/**
 * Profil-Prognose je Stunde: Median der gleichen Tagtypen aus history (nur Tage vor dem Ziel)
 * @param {Array<{ day: string, hours: ReturnType<typeof hourly> }>} history @param {Array<{ day: string, h: number }>} targets @param {Set<string>|null} holidays
 * @returns {Array<{ day: string, h: number, avail: number|null, outH: number|null, n: number }>}
 */
export function profileForecast(history, targets, holidays) {
  return targets.map(({ day, h }) => {
    const ty = dayTypeOf(day, holidays), same = history.filter(x => x.day < day && dayTypeOf(x.day, holidays) === ty).map(x => x.hours.find(r => r.h === h)).filter(Boolean);
    const n = same.length;
    if (n < FORECAST.minDays) return { day, h, avail: null, outH: null, n };
    return { day, h, avail: median(same.map(r => r.avail)), outH: median(same.map(r => r.outH).filter(v => v != null)), n };
  });
}

/**
 * Selbstprüfung eines vergangenen Tages: Prognose nur aus den Tagen davor gegen den gemessenen Verlauf (WAPE = Σ|Prognose − Ist| ÷ Σ Ist)
 * @param {Array<{ day: string, hours: ReturnType<typeof hourly> }>} history @param {string} day @param {Set<string>|null} holidays
 * @returns {{ day: string, hours: number, wapeAvail: number|null, wapeOut: number|null } | null}
 */
export function checkDay(history, day, holidays) {
  const act = history.find(x => x.day === day); if (!act) return null;
  const fc = profileForecast(history, act.hours.map(r => ({ day, h: r.h })), holidays);
  let ea = 0, sa = 0, eo = 0, so = 0, n = 0;
  for (const f of fc) {
    const a = act.hours.find(r => r.h === f.h); if (!a || f.avail == null) continue;
    n++; ea += Math.abs(f.avail - a.avail); sa += a.avail;
    if (f.outH != null && a.outH != null) { eo += Math.abs(f.outH - a.outH); so += a.outH; }
  }
  return n ? { day, hours: n, wapeAvail: sa ? Math.round(ea / sa * 1000) / 1000 : null, wapeOut: so ? Math.round(eo / so * 1000) / 1000 : null } : null;
}
