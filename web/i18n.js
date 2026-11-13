// Mobility Pulse — Sprache der Oberfläche (Deutsch / English): Wörterbuch, t(), Zahlen- und Datumsformat je Sprache.
// Wahl: URL-Parameter ?lang=de|en vor gespeicherter Wahl (localStorage, fehlertolerant) vor Standard Deutsch. Englische Browser
// (navigator.language en*) bekommen nur einen Vorschlag (suggestLang), keine automatische Umstellung.
// Texte stehen unten im Wörterbuch DICT = { de, en }; Schlüssel „bereich.name“ (html = index.html, app/ops/rep/flows = Module,
// lib = Texte aus lib/*, common = Bausteine). Platzhalter {name} werden ersetzt; Texte dürfen HTML enthalten (eigene, geprüfte Texte –
// Werte in vars sind vom Aufrufer bereits escapet, wo nötig: Namen aus Daten immer durch esc(), auch wenn getJson Fremdtext beim Laden
// entschärft, lib/pulse-core.js parseJsonSafe; Prüfung über alle Ansichten: scripts/xss-probe.mjs). Fehlt ein Schlüssel in einer Sprache, gilt Deutsch; im Test-/Debugmodus
// (?debug=1, navigator.webdriver) meldet console.warn den fehlenden Schlüssel.
//
// Glossar (Fachbegriffe, durchgängig verwendet; Eigennamen, Quellennamen, Gesetzes-/Dokumenttitel und Zitate bleiben unübersetzt):
export const GLOSSARY = [
  ['Fahrten je Fahrzeug und Tag (RVD)', 'trips per vehicle per day (TVD)'], ['Fahrt / Fahrten', 'trip / trips'], ['Fahrtbeginn / Fahrtende', 'trip start / trip end'],
  ['Auslastung', 'utilisation'], ['Umsetzung', 'rebalancing'], ['Akkutausch', 'battery swap'], ['Abholung', 'pickup'], ['Ausbringung', 'deployment'],
  ['Sperrquote', 'disabled rate'], ['gesperrt', 'disabled'], ['verfügbar / buchbar', 'available / bookable'], ['Bestand', 'fleet'], ['Flotte', 'fleet'],
  ['Obergrenze', 'fleet cap'], ['Abstellverbot(szone)', 'no-parking zone'], ['Fahrverbot', 'no-riding zone'], ['Pflicht-Abstellzone', 'mandatory parking zone'],
  ['Betriebszone', 'operating zone'], ['Gemeinde', 'municipality'], ['Gebiet', 'area'], ['Bundesland', 'state'], ['Anbieter', 'operator'], ['Fahrzeugart', 'vehicle type'],
  ['Sammler(-Lauf)', 'collector (run)'], ['Sammler-Stand', 'collector snapshot'], ['Sammler-Punkt', 'collector point'], ['Live-Abruf', 'live fetch'],
  ['Kennung / Kennungswechsel', 'ID / ID rotation'], ['stabile Kennungen', 'stable IDs'], ['Netto-Abfluss / -Zufluss', 'net outflow / inflow'], ['Fehlmenge', 'shortfall'],
  ['Bedarf', 'need'], ['Grundbestand', 'base stock'], ['Nachfrage', 'demand'], ['Zelle', 'cell'], ['Tageszeit(-Band)', 'time of day (band)'], ['Tagesgang', 'daily profile'],
  ['Deploy-Spot', 'deploy spot'], ['Tour', 'run'], ['Transporter', 'van'], ['Werkstatt', 'workshop'], ['Stationsausgleich', 'station balancing'], ['Depot', 'depot'],
  ['Standzeit', 'idle time'], ['Ladestand / Reichweite', 'charge / range'], ['Energie niedrig', 'low energy'], ['Haltestelle / ÖPNV', 'stop / public transport'],
  ['Umsatz', 'revenue'], ['Tarif', 'tariff'], ['Realisierung(squote)', 'realisation (rate)'], ['Kalibrierung / kalibriert / gemessen', 'calibration / calibrated / measured'],
  ['Hochrechnung', 'extrapolation'], ['vorläufig', 'preliminary'], ['Lücke / Datenlücke', 'gap / data gap'], ['Quelle / Verzeichnis', 'source / directory'],
  ['Datenalter / aktuell / verzögert / veraltet', 'data age / current / delayed / stale'], ['Fingerabdruck / Quellenwechsel', 'fingerprint / source change'],
  ['Konsistenz / Urteil', 'consistency / verdict'], ['Kommunal-Bericht', 'municipal report'], ['Sondernutzungsgebühr', 'special-use fee'], ['Einwohner (EW)', 'residents'],
  ['Marktbild', 'Market view'], ['Disposition', 'Operations'], ['Datenqualität', 'Data quality'], ['Kundenansicht', 'Client view'], ['Methodik', 'Methodology'],
];

export const LANGS = ['de', 'en'];
export const LOCALE = { de: 'de-DE', en: 'en-GB' };
const LS_KEY = 'mp-lang', LS_HINT = 'mp-lang-hint';
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* privates Fenster: Wahl gilt nur für diese Seite */ } } };
const urlLang = () => { try { const q = new URLSearchParams(location.search).get('lang'); return LANGS.includes(q) ? q : null; } catch { return null; } };
const DEBUG = (() => { try { const q = new URLSearchParams(location.search); return q.get('debug') === '1' || q.get('i18n') === 'debug' || navigator.webdriver === true; } catch { return false; } })();
let cur = urlLang() || (LANGS.includes(store.get(LS_KEY)) ? store.get(LS_KEY) : null) || 'de';
const subs = new Set();

/** aktuelle Sprache 'de' | 'en' */
export const lang = () => cur;
/** Gebietsschema für Intl je Sprache: de-DE bzw. en-GB */
export const fmtLocale = (l = cur) => LOCALE[l] || LOCALE.de;
// Feste Maße an einer Stelle, in Texten als {CELL} / {CELL500}: Analyseraster der Zellen (lib/pulse-track.js CELL_LAT × CELL_LON =
// 0,0025° × 0,0035° ≈ 280 m Nord–Süd × 250 m Ost–West) und grobes Raster (Dichte-Ebene der Übersicht 0,0045° × 0,007°, geschätzte Ströme
// lib/pulse-flowest.js factor 2)
export const FIXED = { CELL: '≈ 280 × 250 m', CELL500: '≈ 500 × 500 m' };
/** Text zu einem Schlüssel; vars ersetzt {name}. Fehlt der Schlüssel in der Sprache: Deutsch (Debug: Warnung), fehlt er ganz: der Schlüssel. */
export function t(key, vars) {
  let s = DICT[cur]?.[key];
  if (s == null) {
    s = DICT.de[key];
    // Debug: auch ein Schlüssel, dessen Bereich nicht geladen ist (S3.5 – Browser-Test zählt diese Warnungen)
    if (DEBUG && !warned.has(`${cur}:${key}`)) { warned.add(`${cur}:${key}`); console.warn(`[i18n] Schlüssel fehlt: ${cur} → ${key}`); }
    if (s == null) return key;
  }
  if (s.includes('{CELL')) s = s.replace(/\{(CELL\w*)\}/g, (m, k) => FIXED[k] ?? m);
  return vars ? s.replace(/\{([\w$]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}
const warned = new Set();
/** Text in einer bestimmten Sprache (z. B. Sprachwahl-Hinweis in der anderen Sprache) */
export const tIn = (l, key, vars) => { const keep = cur; cur = LANGS.includes(l) ? l : cur; try { return t(key, vars); } finally { cur = keep; } };
/** Ist der Schlüssel bekannt? */
export const has = (key) => key in DICT.de || key in DICT.en; // nur geladene Bereiche
/** Sprache wechseln: speichert die Wahl, setzt <html lang> und ruft die Abonnenten (Ansichten neu zeichnen). */
export function setLang(l, { persist = true } = {}) {
  if (!LANGS.includes(l)) return false;
  if (persist) store.set(LS_KEY, l);
  if (l === cur) return false;
  const go = () => { cur = l; applyDocLang(); for (const fn of [...subs]) { try { fn(l); } catch (e) { console.error('[i18n]', e); } } };
  const need = areasOf(cur).filter(a => !have(l, a));
  if (!need.length && have(l, 'core')) go(); else ensureI18n([...new Set(['core', ...need])], l).then(go); // Browser: erst laden, dann umschalten
  return true;
}
/** Abonnieren: fn(lang) nach jedem Wechsel; Rückgabe meldet ab */
export const onLang = (fn) => { subs.add(fn); return () => subs.delete(fn); };
/** Vorschlag „English?“: nur ohne Wahl in URL/Speicher, bei englischem Browser und solange der Hinweis nicht abgelehnt wurde */
export function suggestLang() {
  if (cur !== 'de' || urlLang() || LANGS.includes(store.get(LS_KEY)) || store.get(LS_HINT) === 'no') return null;
  let langs = []; try { langs = navigator.languages?.length ? [...navigator.languages] : [navigator.language]; } catch { /* kein navigator */ }
  return /^en\b/i.test(String(langs[0] || '')) ? 'en' : null;
}
export const dismissSuggestion = () => store.set(LS_HINT, 'no');

/** Code→Text-Tabelle (z. B. Fahrzeugart aus lib/pulse-core.js) in der aktuellen Sprache: map[code] = t(`${prefix}.${code}`); Object.keys/in wie base */
export const tMap = (prefix, base) => new Proxy({}, {
  get: (_, k) => (typeof k === 'string' && Object.hasOwn(base, k) ? t(`${prefix}.${k}`) : undefined),
  has: (_, k) => Object.hasOwn(base, k), ownKeys: () => Reflect.ownKeys(base),
  getOwnPropertyDescriptor: (_, k) => (Object.hasOwn(base, k) ? { enumerable: true, configurable: true, writable: false, value: t(`${prefix}.${String(k)}`) } : undefined),
});

// ---------- Texte aus lib/* und aus dem Datenstand (Sammler schreibt deutsch) ----------
// Feste deutsche Texte (Flags, Quellen der Hochrechnung, Feed-Prüfung, Fehler) stehen im Wörterbuch unter lib.* mit dem Originaltext als
// deutschem Wert; Texte mit Zahlen über Muster. Unbekannte Texte bleiben unverändert (Eigennamen, Quellen, Zitate).
let REV = null;
const PATTERNS = [
  [/^gemessen \((\d+) volle Tage\)$/, 'lib.measuredFullDays', ['n']],
  [/^gemessen \((\d+) Tage\)$/, 'lib.measuredDays', ['n']],
  [/^Vergleich zur Vorperiode ab 2 × (\d+) vollen Messtagen; bisher (\d+) volle von (\d+) Tagen$/, 'lib.prevPeriodNeed', ['min', 'full', 'days']],
  [/^Stand (\d+) Min\. alt$/, 'lib.feedMinOld', ['n']],
  [/^Stand (\d+) Min\. alt \(Vorgabe ≤ 5 Min\. \+ ttl\)$/, 'lib.feedMinOldLimit', ['n']],
  [/^Pflichtfelder fehlen: (.+)$/, 'lib.fieldsMissing', ['x']],
  [/^(\S+) fehlt$/, 'lib.xMissing', ['x']],
  // Feed-Prüfung: Reichweiten-Schwelle relativ zur Quelle (lib/pulse-core.js rangeLimitMsg)
  [/^Reichweite klein \(95\. Perzentil ([\d.,]+) km < (\d+) km\): Reichweiten-Schwelle ([\d.,]+) km \((\d+) % davon\) statt ([\d.,]+) km$/, 'lib.rangeLimit', ['p95', 'max', 'limit', 'share', 'std']],
  // Feed-Prüfung: Befunde der Verfolgung (scripts/collect.mjs addCheck, Z4/Z5)
  [/^Standzeit unbrauchbar \((\d+) % kürzer als ein Laufintervall\): nicht ausgewiesen$/, 'trk.idleUnusableMsg', ['share']],
  [/^Fahrzeuge unter (\d+) % Ladestand nicht im Feed \(Ausblendung\): Verschwinden bis (\d+) % zählt nicht als Fahrt$/, 'trk.batteryFloorMsg', ['p', 'upto']],
  [/^HTTP (\d+)$/, null],
];
const enNum = (x) => String(x).replace(/(\d)\.(\d{3})(?!\d)/g, '$1\u0000$2').replace(/(\d),(\d)/g, '$1.$2').replace(/\u0000/g, ',');
/** Deutschen Text aus lib/* oder dem Datenstand in die aktuelle Sprache übertragen (Deutsch: unverändert) */
export function tx(text) {
  if (text == null || cur === 'de') return text;
  const s = String(text);
  if (!REV) { REV = new Map(); for (const [k, v] of Object.entries(DICT.de)) if (k.startsWith('lib.') && !/\{/.test(v)) REV.set(v, k); }
  const k = REV.get(s); if (k) return t(k);
  const h = /^HTTP (\d+) (.+)$/.exec(s); if (h) return `HTTP ${h[1]} ${tx(h[2])}`;
  for (const [re, key, names] of PATTERNS) { const m = re.exec(s); if (!m) continue; if (!key) return s; return t(key, Object.fromEntries(names.map((n, i) => [n, enNum(m[i + 1])]))); }
  // „feed: Befund (n)“ aus der Feed-Prüfung (lib/pulse-report.js normalizeChecks)
  const f = /^([\w.,/ ]+): (.+?)( \(\d+\))?$/.exec(s);
  if (f) { const inner = tx(f[2]); if (inner !== f[2]) return `${f[1]}: ${inner}${f[3] || ''}`; }
  return s;
}

// ---------- Zahlen und Daten (Formatierer je Sprache gecacht, Aufbau ist teuer) ----------
const NF = new Map(), DF = new Map();
/** Intl.NumberFormat mit d festen Nachkommastellen in der aktuellen Sprache */
export const numFmt = (d = 0, l = cur) => { const k = `${l}|${d}`; let f = NF.get(k); if (!f) NF.set(k, (f = new Intl.NumberFormat(fmtLocale(l), { maximumFractionDigits: d, minimumFractionDigits: d }))); return f; };
/** Begründung der Modellwahl in der Oberflächensprache, Modellnamen ausgeschrieben (Audit 11.11.2026, MET-08/UXM-23): aus decision.why des
 *  Prognose-Stands; ältere Stände nur mit deutschem Freitext → Kennungen wie pooledWx durch Namen ersetzt */
export function fcReason(fc) {
  const nm = (m) => (m === 'naive' ? t('fv.naive') : m === 'week' ? t('fv.week') : t(`fc.model.${m}`)), n2 = (x) => (x == null ? '–' : numFmt(2).format(x));
  const w = fc?.decision?.why;
  if (w?.model) return t('fc.why', { model: nm(w.model), r: n2(w.r), live: n2(w.live), n: w.n ?? 0, w: Math.round((w.w ?? 0) * 100), self: n2(w.self) }) + (w.kept ? ` ${t('fc.whyKept', { best: nm(w.best), bestR: n2(w.bestR) })}` : '');
  let s = String(fc?.reason || '');
  for (const m of ['pooledWx', 'pooled', 'profile', 'hybrid', 'adaptive', 'blend', 'chronos']) s = s.replace(new RegExp(`\\b${m}\\b`, 'g'), nm(m));
  return s;
}
/** Intl.DateTimeFormat mit opts in der aktuellen Sprache (gecacht je Sprache und Optionen) */
export const dateFmt = (opts = {}, l = cur) => { const k = `${l}|${JSON.stringify(opts)}`; let f = DF.get(k); if (!f) DF.set(k, (f = new Intl.DateTimeFormat(fmtLocale(l), opts))); return f; };
/** Dezimalzeichen der Sprache (CSV, Eingaben) */
export const decimalSep = (l = cur) => (l === 'en' ? '.' : ',');

// ---------- Statisches HTML: data-i18n, data-i18n-title, -aria-label, -placeholder, -empty, -content ----------
const ATTRS = [['title', 'i18nTitle'], ['aria-label', 'i18nAriaLabel'], ['placeholder', 'i18nPlaceholder'], ['data-empty', 'i18nEmpty'], ['content', 'i18nContent'], ['alt', 'i18nAlt']];
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) { const v = t(el.dataset.i18n); if (/[<&]/.test(v)) el.innerHTML = v; else el.textContent = v; }
  for (const [attr, prop] of ATTRS) {
    const sel = `[data-${prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}]`;
    for (const el of root.querySelectorAll(sel)) el.setAttribute(attr, t(el.dataset[prop]));
  }
}
function applyDocLang() { try { document.documentElement.lang = cur; } catch { /* Node */ } }
applyDocLang();

// ---------- Wörterbuch: Bereiche laden (S3.5) ----------
// Browser: docs/i18n/<Sprache>/<Bereich>.json (scripts/build-web.mjs), zuerst „core“ für die aktuelle Sprache (oberste Ebene dieses Moduls,
// alle Importeure warten darauf), die übrigen Bereiche lädt app.js zusammen mit dem Modul der Ansicht (ensureI18n). t() bleibt synchron.
// Node (Tests, Sammler): das ganze Wörterbuch aus web/i18n-dict.js.
export const DICT = { de: {}, en: {} };
const loaded = { de: new Set(), en: new Set() }, pending = new Map();
const BROWSER = typeof document !== 'undefined' && typeof fetch === 'function';
// Versionsanhang gegen alte Wörterbücher im Cache; setzt der Build (esbuild define), ohne Build leer
// eslint-disable-next-line no-undef
const BUILD = typeof __MP_BUILD__ !== 'undefined' ? __MP_BUILD__ : '';
async function loadArea(l, area) {
  if (loaded[l].has(area)) return;
  const k = `${l}/${area}`;
  if (!pending.has(k)) pending.set(k, (async () => {
    if (BROWSER) {
      const r = await fetch(new URL(`i18n/${l}/${area}.json${BUILD ? `?v=${BUILD}` : ''}`, document.baseURI));
      if (!r.ok) throw new Error(`Wörterbuch ${k}: HTTP ${r.status}`);
      Object.assign(DICT[l], await r.json());
    } else {
      const src = './i18n-dict.js', d = await import(/* @vite-ignore */ src); // ganzes Wörterbuch (Node)
      Object.assign(DICT.de, d.DE); Object.assign(DICT.en, d.EN);
      for (const x of LANGS) { loaded[x].add('*'); }
    }
    loaded[l].add(area);
  })().finally(() => pending.delete(k)));
  return pending.get(k);
}
const have = (l, area) => loaded[l].has(area) || loaded[l].has('*');
/** Bereiche für die aktuelle (oder angegebene) Sprache laden; Fehler werden gemeldet, nicht geworfen (Texte fallen dann auf den Schlüssel zurück) */
export async function ensureI18n(areas, l = cur) {
  const todo = [...new Set(areas)].filter(a => !have(l, a));
  if (!todo.length) return true;
  try { await Promise.all(todo.map(a => loadArea(l, a))); return true; } catch (e) { console.error('[i18n]', e); return false; }
}
/** geladene Bereiche der aktuellen Sprache (Sprachwechsel lädt dieselben in der neuen Sprache) */
const areasOf = (l) => [...loaded[l]].filter(a => a !== '*');
await ensureI18n(['core']);
