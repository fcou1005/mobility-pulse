// Tests für web/i18n.js: Wörterbuch vollständig (de/en, gleiche Platzhalter und Tags), alle verwendeten Schlüssel vorhanden,
// t()/tx()/tMap, Zahlen- und Datumsformat je Sprache, Sprachwechsel mit Abonnenten
import { readFileSync, readdirSync } from 'node:fs';
import * as I from '../web/i18n.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const { DICT } = I;
const ph = (s) => [...String(s).matchAll(/\{([\w$]+)\}/g)].map(m => m[1]).sort().join(',');
const tags = (s) => [...String(s).matchAll(/<[^>]+>/g)].map(m => m[0].replace(/\b(title|aria-label|placeholder|alt)="[^"]*"/g, '$1=""').replace(/\s+/g, ' ')).sort().join('|');

// ---------- Wörterbuch ----------
const de = Object.keys(DICT.de), en = Object.keys(DICT.en);
assert(de.length > 2000 && de.length === en.length && de.every(k => k in DICT.en), `Wörterbuch: ${de.length} Schlüssel, jeder in de und en`);
const badPh = de.filter(k => ph(DICT.de[k]) !== ph(DICT.en[k])), badTags = de.filter(k => tags(DICT.de[k]) !== tags(DICT.en[k]));
assert(!badPh.length, `gleiche Platzhalter in de und en${badPh.length ? ': ' + badPh.slice(0, 5).join(', ') : ''}`);
assert(!badTags.length, `gleiche HTML-Tags in de und en${badTags.length ? ': ' + badTags.slice(0, 5).join(', ') : ''}`);
assert(de.every(k => /^[a-z]+(\.[\p{L}\w-]+)+$/iu.test(k) && String(DICT.en[k]).trim() !== ''), 'Schlüssel „bereich.name“, kein leerer englischer Text');
// verwendete Schlüssel (alle Module in web/ und statisches HTML) existieren – neue Panels/Module werden automatisch mitgeprüft
const used = new Set();
for (const f of readdirSync(new URL('../web/', import.meta.url)).filter(f => f.endsWith('.js'))) for (const m of readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8').matchAll(/\bt(?:In)?\((?:'(?:de|en)', |l, |sug, )?'([\w.$-]+)'/g)) used.add(m[1]);
for (const m of readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
const missing = [...used].filter(k => !(k in DICT.de));
assert(used.size > 1900 && !missing.length, `${used.size} verwendete Schlüssel vorhanden${missing.length ? ' – fehlen: ' + missing.slice(0, 5).join(', ') : ''}`);
// Glossar: Fachbegriffe der englischen Oberfläche durchgängig
const enAll = Object.values(DICT.en).join(' \n ');
assert(I.GLOSSARY.length >= 50 && /trips per vehicle per day/i.test(enAll) && !/\bRVD\b/.test(enAll.replace(/RVD-/g, '')) && /\bTVD\b/.test(enAll) && /no-parking zone/i.test(enAll) && /fleet cap/i.test(enAll) && /ID rotation/.test(enAll) && /net outflow/i.test(enAll) && /shortfall/i.test(enAll),
  'Glossar: TVD statt RVD, no-parking zone, fleet cap, ID rotation, net outflow, shortfall');
assert(!/\b(Umsetzung|Akkutausch|Sperrquote|Obergrenze|Gemeinde|Sammler|Kennungswechsel|Fehlmenge|Datenvertrauen|Marktbild|Disposition)\b/.test(enAll), 'keine deutschen Fachbegriffe in den englischen Texten');

// ---------- t(), Platzhalter, Rückfall ----------
assert(I.lang() === 'de' && I.fmtLocale() === 'de-DE' && I.t('app.copyLink') === 'Link kopieren', 'ohne Wahl: Deutsch (Node ohne localStorage/location)');
assert(I.t('app.sourcesMunicipalities', { v0: '1.234', v1: 5 }) === '1.234 Quellen · 5 Gemeinden' && I.t('gibt.es.nicht') === 'gibt.es.nicht', 'Platzhalter ersetzt; unbekannter Schlüssel liefert den Schlüssel');
const calls = []; const off = I.onLang((l) => calls.push(l));
assert(I.setLang('en') === true && I.lang() === 'en' && I.fmtLocale() === 'en-GB' && calls.join() === 'en' && I.t('app.copyLink') === 'Copy link', 'setLang: Sprache, Gebietsschema, Abonnent');
assert(I.t('app.sourcesMunicipalities', { v0: '1,234', v1: 5 }) === '1,234 sources · 5 municipalities' && I.tIn('de', 'app.copyLink') === 'Link kopieren' && I.lang() === 'en', 'Englisch mit Platzhaltern; tIn liest die andere Sprache ohne Wechsel');
assert(I.numFmt(1).format(1234.5) === '1,234.5' && I.numFmt(0, 'de').format(1234.5) === '1.235' && I.decimalSep() === '.' && I.decimalSep('de') === ',', 'Zahlen je Sprache: 1,234.5 (en-GB) gegen 1.235 (de-DE)');
const d = new Date('2026-11-01T15:05:00Z');
assert(I.dateFmt({ dateStyle: 'medium', timeZone: 'Europe/Berlin' }).format(d) === '1 Nov 2026' && I.dateFmt({ dateStyle: 'medium', timeZone: 'Europe/Berlin' }, 'de').format(d) === '01.11.2026' && I.dateFmt({ hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(d) === '16:05',
  'Datum und Uhrzeit je Sprache (Formatierer gecacht)');
// ---------- Texte aus lib/* und dem Datenstand ----------
assert(I.tx('Standardkurve') === 'standard curve' && I.tx('gemessen (4 volle Tage)') === 'measured (4 full days)' && I.tx('Kalibrierung ausgesetzt – Messung unplausibel (Überzählung wahrscheinlich)').startsWith('Calibration suspended'), 'tx: feste Texte und Muster aus lib/pulse-report.js');
assert(I.tx('free_bike_status: ungültige Koordinaten (3)') === 'free_bike_status: invalid coordinates (3)' && I.tx('gbfs: system_information fehlt') === 'gbfs: system_information missing' && I.tx('citybikes: HTTP 0 Netz/CORS') === 'citybikes: HTTP 0 network/CORS', 'tx: Befunde der Feed-Prüfung und Abruffehler des Sammlers');
assert(I.tx('Stadtwerke Musterstadt') === 'Stadtwerke Musterstadt' && I.tx(null) === null, 'tx: unbekannte Texte (Eigennamen, Quellen) bleiben');
const TY = I.tMap('type', { scooter: 1, bike: 1 });
assert(TY.scooter === 'E-scooters' && Object.keys(TY).join() === 'scooter,bike' && ('bike' in TY) && TY.car === undefined, 'tMap: Code → Text der Sprache, Object.keys/in wie die Vorlage');
// ---------- zurück auf Deutsch ----------
assert(I.setLang('de') === true && I.tx('Standardkurve') === 'Standardkurve' && I.t('app.copyLink') === 'Link kopieren' && calls.join() === 'en,de', 'zurück auf Deutsch: tx gibt den Originaltext zurück');
off(); I.setLang('en'); I.setLang('de');
assert(calls.length === 2 && I.setLang('xx') === false && I.lang() === 'de', 'abgemeldeter Abonnent wird nicht mehr gerufen; unbekannte Sprache abgelehnt');
// ---------- Zellmaß und Datenschutz-Schwelle aus je einer Stelle (FIXED.CELL / CELL500, R.MIN_COUNT) ----------
const allTxt = [...Object.values(DICT.de), ...Object.values(DICT.en)];
assert(I.t('cmp.cellsTip').includes(I.FIXED.CELL) && I.t('flows.originDestinationFlowsEst', { v0: 'a', v1: 'b' }).includes(I.FIXED.CELL500) && !/\{CELL/.test(I.t('html.gridOfAbout250250M'))
  && !allTxt.some(s => /≈ ?250[ -]m|250 × 250|500-m-Zell|weniger als \{MIN_COUNT\}|fewer than \{MIN_COUNT\}/.test(s)), 'Zellmaß aus FIXED ({CELL} ersetzt), keine abweichenden Angaben „≈ 250 m“, „weniger als {MIN_COUNT}“');
