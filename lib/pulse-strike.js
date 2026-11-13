// Streiks im ÖPNV und bei der Bahn automatisch erkennen (seit 08.11.2026) – läuft im Sammler, ohne Konto und ohne Schlüssel.
// Quelle: Nachrichtensuche der tagesschau-App (https://www.tagesschau.de/api2u/search/; enthält auch die Regionalmeldungen von SWR, WDR, NDR, BR,
// HR, MDR, rbb, SR, RB; etwa die letzten 30 Tage, neueste zuerst; höchstens 60 Abrufe je Stunde). Inhalte sind privat nutzbar, Veröffentlichung
// nicht – gespeichert werden deshalb nur abgeleitete Angaben: Art, Tage, Gebiet, erkannte Orte/Betriebe, Link.
// Kopf einer Meldung (Dachzeile, Überschrift, Anrisstext) muss von Streik und Bussen/Bahnen sprechen; dann werden aus den Sätzen über den Streik
// (Suchtreffer, bei Bedarf der vollständige Text) Art (ÖPNV oder Bahn), Streiktage (Datum, Wochentag, „heute“, „morgen“) und Gebiet abgeleitet:
// Gemeinden mit Sharing-Daten beim Namen, Verkehrsbetriebe mit kompaktem Gebiet aus data/streik-betriebe.json, „landesweit“/„bundesweit“ mit Land.
// Nur Meldungen mit Tag und Gebiet gehen als Einträge wie data/ereignisse.json in die Prognose (Merkmal strike bzw. rail, sofort wirksam); der Rest
// (Sammelmeldungen, ohne Tag, ohne Ort) bleibt als Hinweis im Datenstand. Meldungen über Absage oder Einigung heben erkannte Streiks im selben
// Gebiet an denselben (bzw. folgenden) Tagen wieder auf.
import { dayOf } from './pulse-track.js';

export const STRIKE = {
  version: 2, // Stand der Auswertung: bei Änderung wertet der Sammler gespeicherte Meldungen neu aus (Volltext erneut abrufen)
  // Die Suche findet einzelne Wörter (mehrere Wörter = Wortgruppe, meist ohne Treffer)
  queries: ['Streik', 'Streiks', 'Warnstreik', 'Warnstreiks', 'bestreikt', 'streiken', 'streikt', 'gestreikt', 'Bahnstreik', 'GDL', 'Ausstand'],
  pageSize: 30, maxPages: 3, refreshMin: 55, maxDetails: 10, maxAgeDays: 21, pastDays: 3, aheadDays: 14, keepDays: 60,
  base: 'https://www.tagesschau.de/api2u/search/',
};
const MONTHS = { januar: 1, jan: 1, februar: 2, feb: 2, märz: 3, maerz: 3, april: 4, apr: 4, mai: 5, juni: 6, juli: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12 };
const WEEKDAYS = { sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6 };
const LAENDER = [['Baden-Württemberg', 'BW'], ['Bayern', 'BY'], ['Berlin', 'BE'], ['Brandenburg', 'BB'], ['Bremen', 'HB'], ['Hamburg', 'HH'], ['Hessen', 'HE'],
  ['Mecklenburg-Vorpommern', 'MV'], ['Niedersachsen', 'NI'], ['Nordrhein-Westfalen', 'NW'], ['NRW', 'NW'], ['Rheinland-Pfalz', 'RP'], ['Saarland', 'SL'],
  ['Sachsen-Anhalt', 'ST'], ['Sachsen', 'SN'], ['Schleswig-Holstein', 'SH'], ['Thüringen', 'TH']];
// regionId der tagesschau-App (1–16) → Land
export const REGION_LAND = { 1: 'BW', 2: 'BY', 3: 'BE', 4: 'BB', 5: 'HB', 6: 'HH', 7: 'HE', 8: 'MV', 9: 'NI', 10: 'NW', 11: 'RP', 12: 'SL', 13: 'SN', 14: 'ST', 15: 'SH', 16: 'TH' };
const LAND2 = { '01': 'SH', '02': 'HH', '03': 'NI', '04': 'HB', '05': 'NW', '06': 'HE', '07': 'RP', '08': 'BW', '09': 'BY', 10: 'SL', 11: 'BE', 12: 'BB', 13: 'MV', 14: 'SN', 15: 'ST', 16: 'TH' };
const CITY_STATE = new Set(['BE', 'HH', 'HB']);
const STRIKE_RE = /streik|ausstand|arbeitsniederlegung/i;
const MODE = '(?:schul|linien|regional|stadt|omni|nacht)?bus(?:se[ns]?|fahrer\\w*|verkehr\\w*|linien?|betrieb\\w*|unternehmen|fahrten|verbindungen|standort\\w*)?\\b|straßenbahn\\w*|stadtbahn\\w*|u-bahn\\w*|\\btrams?\\b|regiobus|verkehrsbetrieb\\w*|verkehrsgesellschaft\\w*|verkehrsunternehmen';
const MODE_RE = new RegExp(`(?<![\\wäöüß])(?:${MODE})`, 'i');
const LOCAL_RE = new RegExp(`(?<![\\wäöüß])(?:${MODE})|nahverkehr|öpnv`, 'i');
const RAIL_RE = /lokführer|lokomotivführer|\bgdl\b|\bevg\b|deutsche bahn|\bdb\b|bahnstreik|fernverkehr|zugverkehr|bahnverkehr|bahnstrecke|regionalverkehr|regionalzüge|\bzügen?\b|zugausf\w*|s-bahn|\bice\b|eisenbahn/i;
const RAIL_CORE_RE = /lokführer|lokomotivführer|\bgdl\b|\bevg\b|deutsche bahn|bahnstreik|fernverkehr/i;
const TRANSIT_RE = new RegExp(`${LOCAL_RE.source}|${RAIL_RE.source}|busse und bahnen`, 'i');
const TICKER_RE = /newsticker|ticker|das war|am morgen|am abend|kompakt|im überblick|nachrichten aus|der tag in/i;
const OFF_RE = /abgesagt|ausgesetzt|abgeblasen|zurückgenommen|einigung erzielt|tarifeinigung|tarifabschluss|geeinigt|friedenspflicht|kein(?:e|en)? (?:weiteren? )?(?:warn)?streiks?\b|verzicht\w* auf (?:den |weitere )?(?:warn)?streik/i;
const NOT_OFF_RE = /gescheitert|droht|drohen|abgelehnt|ohne einigung|keine einigung|ende der friedenspflicht|friedenspflicht (?:endet|ist vorbei|abgelaufen)/i;
const FUT_RE = /angekündigt|kündig|aufgerufen|\bruft|\brufen|\bsoll(?:en)?\b|\bwird\b|\bwerden\b|geplant|droht|drohen|voraussichtlich|kommende[nmrs]?|nächste[nmrs]?|\bab\b|\bvon .{1,20} an\b|müssen sich|einstellen/i;
const PAST_RE = /\b(?:traf|trafen|fiel|fielen|war|waren|hatte|hatten|streikten|legten|beteiligten|ausgefallen|gestern|vergangene[nmrs]?|letzte[nmrs]?)\b/i;
const WIDE_RE = /landesweit|in ganz\b|im ganzen land|flächendeckend|alle(?:n)? (?:kommunalen )?verkehrsbetrieb|in (?:vielen|zahlreichen|mehreren|etlichen|allen) (?:großen )?(?:städten|kommunen)/i;
const NATION_RE = /\bbundesweit\b|bundesweite[nrs]? (?:warn)?streik|bundesweite[nrs]? bahnstreik|in ganz deutschland|deutschlandweit\b/i;
const DAYWORD_RE = /streik|ausstand|arbeitsniederlegung|stillsteh|stehen\b.{0,60}\bstill\b|ausfall|ausfäll|fallen\b.{0,60}\baus\b|f[äa]hr(?:t|en) (?:fast )?(?:nicht|keine|nichts)|nichts geht|kein(?:e)? (?:busse|bahnen|straßenbahnen|züge)\b|lahmgelegt|eingestellt|einschränkung|betroffen/i;
const WD = '(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend)(?:s|früh|morgen|vormittag|mittag|nachmittag|abend|nacht)?';

const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;|&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const addDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const wdOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const word = (s, flags = 'i') => new RegExp(`(?<![\\wäöüßÄÖÜ-])(?:${s})(?![\\wäöüßÄÖÜ])`, flags); // „SSB-Streik“, „KVB-Busse“: Bindestrich danach erlaubt

/** Kopf (Dachzeile, Überschrift, Anrisstext) und Text einer Meldung (Suchtreffer oder Detail-JSON); Sendehinweise („Sendung am …“) fallen weg */
export function itemText(it) {
  const lead = strip([it?.topline, it?.title, it?.firstSentence].filter(Boolean).join(' . '));
  const blocks = Array.isArray(it?.content) ? it.content.filter(c => c && (c.type === 'text' || c.type === 'headline') && c.value).map(c => strip(c.value)).filter(v => v && !/^(?:sendung (?:am|vom)|erstveröffentlichung|von [A-ZÄÖÜ][\wäöüß-]+ [A-ZÄÖÜ][\wäöüß-]+$)/i.test(v)) : [];
  const body = blocks.join(' . ');
  return { lead, body, all: body ? `${lead} . ${body}` : lead };
}
/** Sätze (Punkt nach Ziffer – „5. November“ – trennt nicht) */
const sentences = (t) => t.split(/(?<![0-9])[.!?]\s+|\s\.\s|\s\|\s/).map(s => s.trim()).filter(Boolean);

/**
 * Ortsverzeichnis für die Erkennung: features = Gemeindegrenzen (properties { ags, name }) der Gemeinden mit Sharing-Daten, operators =
 * data/streik-betriebe.json (betriebe: { Name: { muster: [...], ags: [...], art?: 'bahn', gross?: true } }).
 * Namen als ganze Wörter (auch „Kölner“, „Stuttgarter“), nicht nach „Kreis“/„Landkreis“ (der Kreis ist nicht die Stadt); Kurzformen („Lahr“ aus
 * „Lahr/Schwarzwald“) nur, wenn eindeutig. Namen, die auch gewöhnliche Wörter sind (Essen, Halle …), nur nach „in/nach/aus/von/für/bei“.
 */
export function strikePlaces(features = [], operators = {}) {
  const COMMON = new Set(['essen', 'halle', 'weil', 'hof', 'lage', 'senden', 'werne', 'kamen', 'marl', 'rees', 'wehr', 'brühl', 'bühl', 'stade', 'zell', 'horb', 'olpe', 'selm', 'goch', 'bad', 'werl', 'hamm', 'datteln', 'ahlen', 'linden', 'aue', 'roth', 'neuss', 'lohr', 'kirchen', 'stein', 'berg', 'hagen', 'baden', 'mark', 'unna', 'rain', 'gera',
    'wetter', 'leer', 'burg', 'lauf', 'weiden', 'singen', 'norden', 'rot', 'hausen', 'waren', 'werder', 'sachsen', 'bergen', 'viersen', 'kaiser', 'neustadt', 'münster',
    'haar', 'graben', 'forst', 'grafschaft', 'march', 'born', 'much', 'felde', 'kall', 'ense', 'wisch', 'benz', 'reute', 'dahlem', 'stolpe', 'tamm', 'garz']);
  const byName = new Map(), pop = new Map(), add = (n, ags) => { const k = n.toLowerCase(); if (k.length < 3) return; const l = byName.get(k) || new Set(); l.add(ags); byName.set(k, l); };
  for (const f of features) {
    const p = f?.properties || f; if (!p?.ags || !p.name) continue; const n = String(p.name).trim(); add(n, p.ags); pop.set(p.ags, +p.pop || 0);
    const short = n.split(/\s*[/(,]\s*|\s+(?:am|im|an der|in der|ob der|bei|b\.|v\.\s?d\.|vor der)\s+/)[0].trim(); if (short && short !== n) add(short, p.ags);
  }
  // mehrdeutige Kurzform (Frankfurt am Main / Frankfurt (Oder)): die deutlich größere Stadt, sonst keine
  const pick = (s) => { if (s.size === 1) return [...s][0]; const l = [...s].sort((a, b) => (pop.get(b) || 0) - (pop.get(a) || 0)); return (pop.get(l[0]) || 0) >= 5 * Math.max(1, pop.get(l[1]) || 0) ? l[0] : null; };
  const notKreis = '(?<!kreis(?:es|en|e)?\\s)(?<!bezirk(?:s|es)?\\s)(?<!region\\s)(?<!kreis(?:en|e)?\\s[\\wäöüß-]+\\s(?:und|sowie|,)\\s?)'; // auch „Landkreis Sigmaringen und Reutlingen“
  const names = [...byName].map(([k, s]) => [k, pick(s)]).filter(([, a]) => a).map(([k, a]) => ({ k, ags: a, re: COMMON.has(k) ? new RegExp(`\\b(?:in|nach|aus|von|für|bei)\\s+${esc(k)}(?![\\wäöüß-])`, 'i') : new RegExp(`${notKreis}(?<![\\wäöüßÄÖÜ-])${esc(k)}(?:er)?(?![\\wäöüßÄÖÜ])`, 'i') }));
  const list = operators?.betriebe || operators || {};
  // Betriebe mit Gemeinden sind Stadtverkehr (art oepnv), ohne Gemeinden (SWEG: Busse und Bahnen in vielen Kreisen) offen, Gewerkschaften der Bahn art bahn
  const ops = Object.entries(list).filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => ({ k, ags: v.ags || [], art: v.art || (v.ags?.length ? 'oepnv' : null), re: word((v.muster?.length ? v.muster : [k]).map(esc).join('|'), v.gross ? '' : 'i') }));
  return { names, ops };
}

/** Streiktage (Ortstage) aus den Sätzen über den Streik, bezogen auf den Tag der Meldung pubDay; nur im Fenster [pubDay − pastDays, pubDay + aheadDays] */
export function strikeDays(text, pubDay, { pastDays = STRIKE.pastDays, aheadDays = STRIKE.aheadDays } = {}) {
  const lo = addDay(pubDay, -pastDays), hi = addDay(pubDay, aheadDays), y0 = +pubDay.slice(0, 4), out = new Set();
  const near = (m, d, y) => { if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null; const c = y ? [y] : [y0, y0 + 1, y0 - 1]; return c.map(yy => ymd(yy, m, d)).find(x => x >= lo && x <= hi && new Date(`${x}T12:00:00Z`).getUTCDate() === d) || null; };
  const range = (a, b) => { if (!a || !b || b < a) return; for (let d = a, n = 0; d <= b && n < 15; d = addDay(d, 1), n++) out.add(d); };
  const mon = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  const rel = sentences(text).filter(s => DAYWORD_RE.test(s)), t = rel.join(' . ').toLowerCase();
  // „5. November bis 7. November“, „5. bis 7. November“, „5. und 6. November“, „5./6. November“, „5.11.“, „5. November“
  for (const m of t.matchAll(new RegExp(`(\\d{1,2})\\.\\s*(${mon})\\b\\.?\\s*(?:bis|-|–)\\s*(?:zum\\s+)?(?:[a-zäöü]+,?\\s+)?(\\d{1,2})\\.\\s*(${mon})\\b`, 'g'))) range(near(MONTHS[m[2]], +m[1]), near(MONTHS[m[4]], +m[3]));
  for (const m of t.matchAll(new RegExp(`(\\d{1,2})\\.\\s*(bis|und|/|-|–)\\s*(?:zum\\s+)?(\\d{1,2})\\.\\s*(${mon})\\b\\.?(?:\\s*(\\d{4}))?`, 'g'))) {
    const mo = MONTHS[m[4]], y = m[5] ? +m[5] : undefined, a = near(mo, +m[1], y), b = near(mo, +m[3], y);
    if (/bis|-|–/.test(m[2])) range(a, b); else { if (a) out.add(a); if (b) out.add(b); }
  }
  for (const m of t.matchAll(new RegExp(`(\\d{1,2})\\.\\s*(${mon})\\b\\.?(?:\\s*(\\d{4}))?`, 'g'))) { const d = near(MONTHS[m[2]], +m[1], m[3] ? +m[3] : undefined); if (d) out.add(d); }
  for (const m of t.matchAll(/(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2}(?!\d))?/g)) { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined; const d = near(+m[2], +m[1], y); if (d) out.add(d); }
  if (out.size) return [...out].sort();
  // ohne Datum: Wochentage („am Montag“, „von Montag bis Mittwoch“), „heute“, „morgen“, „übermorgen“ – je Satz: Vergangenheit → der letzte, sonst der
  // nächste (Präsens steht im Deutschen auch für Künftiges: „Am Montag fallen Busse aus“); der Tag der Meldung selbst gilt in beiden Fällen
  for (const s of rel.map(x => x.toLowerCase())) {
    const back = PAST_RE.test(s) && !FUT_RE.test(s);
    const resolve = (name) => { const w = WEEKDAYS[name]; let d = pubDay; for (let i = 0; i < 7 && wdOf(d) !== w; i++) d = addDay(d, back ? -1 : 1); return d >= lo && d <= hi ? d : null; };
    for (const m of s.matchAll(new RegExp(`(?:von|ab)\\s+(?:dem\\s+)?${WD}\\s+bis\\s+(?:zum\\s+|einschließlich\\s+)?${WD}`, 'g'))) range(resolve(m[1]), resolve(m[2]));
    for (const m of s.matchAll(new RegExp(`\\b${WD}\\b`, 'g'))) { const d = resolve(m[1]); if (d) out.add(d); }
    if (/\bheute\b/.test(s)) out.add(pubDay);
    if (/\bübermorgen\b/.test(s)) out.add(addDay(pubDay, 2));
    else if (/\bmorgen\b(?!s|stunden)/.test(s) && !/\b(?:heute|gestern|am|den|jeden)\s+morgen\b/.test(s)) out.add(addDay(pubDay, 1));
  }
  return [...out].filter(d => d >= lo && d <= hi).sort();
}

/**
 * Eine Meldung → Kandidat { id, art, tage, gebiet, teile?, sicher, aus, sammel?, link, at, grund } oder null (kein Streik bei Bussen und Bahnen).
 * places = strikePlaces(…). Tage je Ort: aus dem Satz, der den Ort nennt, sonst aus dem letzten Satz davor mit Tagen, sonst aus dem Kopf – so
 * bekommen „Norden Mo–Mi, Süden Do–Fr“ in einer Meldung je ihre Tage (teile). Sammelmeldungen (Newsticker) bleiben Hinweis.
 */
export function strikeFromItem(it, places, { now = Date.now() } = {}) {
  const { lead, body, all } = itemText(it); if (!lead || !STRIKE_RE.test(lead) || !TRANSIT_RE.test(lead)) return null;
  const pub = Date.parse(it?.date || '') || now, pubDay = dayOf(pub), aus = OFF_RE.test(lead) && !NOT_OFF_RE.test(lead), sammel = TICKER_RE.test(it?.title || '');
  const units = [lead, ...sentences(body).filter(s => DAYWORD_RE.test(s))], rel = units.join(' . ');
  // Länder vorher entfernen („Schleswig-Holstein“ ist nicht Schleswig, „Baden-Württemberg“ nicht Baden-Baden); Berlin, Hamburg, Bremen bleiben auch Städte
  const laender = [], landRe = LAENDER.map(([name, code]) => [new RegExp(`(?<![\\wäöüß-])${esc(name)}(?![\\wäöüß-])`, 'g'), code]);
  const noLand = (u) => { let r = u; for (const [re, code] of landRe) { re.lastIndex = 0; if (re.test(r)) { if (!laender.includes(code)) laender.push(code); if (!CITY_STATE.has(code)) r = r.replace(re, ' '); } } return r; };
  const leadDays = strikeDays(lead, pubDay); let carry = leadDays;
  const U = units.map((u, i) => { const d = i === 0 ? leadDays : strikeDays(u, pubDay); if (d.length) carry = d; return { u, r: noLand(u), days: d.length ? d : carry, lead: i === 0 }; });
  // Orte beim Namen; Betriebe (kompaktes Gebiet) nur, wenn keine ihrer Gemeinden schon beim Namen genannt ist; Bahn-Gewerkschaften nur im Kopf
  const dayOf_ = new Map(), why = [], named = new Set(), add = (a, days) => { const x = dayOf_.get(a) || new Set(); days.forEach(d => x.add(d)); dayOf_.set(a, x); };
  for (const x of U) for (const n of places.names) if (n.re.test(x.r)) { named.add(n.ags); add(n.ags, x.days); why.push(n.k); }
  let railOp = false, localOp = false;
  for (const o of places.ops) {
    const hits = U.filter(x => (o.art === 'bahn' ? x.lead : true) && o.re.test(x.u)); if (!hits.length) continue;
    if (o.art === 'bahn') railOp = true; else if (o.art === 'oepnv') localOp = true;
    if (!o.ags.some(a => named.has(a))) for (const x of hits) o.ags.forEach(a => add(a, x.days));
    why.push(o.k);
  }
  if (!laender.length) for (const r of [it?.regionId, ...(Array.isArray(it?.regionIds) ? it.regionIds : [])]) if (REGION_LAND[r]) laender.push(REGION_LAND[r]);
  // Art: Nahverkehr, wenn ein Stadtverkehrsbetrieb genannt ist oder Bus/Straßen-/Stadt-/U-Bahn im Kopf steht; sonst Bahn bei GDL/EVG/DB/Zügen; sonst Nahverkehr
  const art = localOp || MODE_RE.test(lead) ? 'streik-oepnv' : railOp || RAIL_RE.test(lead) ? 'streik-bahn' : 'streik-oepnv';
  const ags = [...dayOf_.keys()].sort();
  let tage = [...new Set([...leadDays, ...[...dayOf_.values()].flatMap(x => [...x])])].sort(); if (!tage.length) tage = strikeDays(all, pubDay);
  let gebiet = null;
  if (NATION_RE.test(rel) && (art === 'streik-bahn' || WIDE_RE.test(rel) || !ags.length)) gebiet = 'DE';
  else if (WIDE_RE.test(rel) && laender.length) gebiet = { laender: [...new Set(laender)].sort() };
  else if (ags.length) gebiet = { ags };
  else if (art === 'streik-bahn' && RAIL_CORE_RE.test(lead) && !laender.length) gebiet = 'DE'; // GDL/EVG/DB-Fernverkehr ohne Ortsangabe: bundesweit
  // Teile: Gemeinden mit unterschiedlichen Tagen (ohne eigene Tage: alle Tage der Meldung)
  let teile = null;
  if (gebiet?.ags) {
    const g = new Map(); for (const a of ags) { const d = dayOf_.get(a).size ? [...dayOf_.get(a)].sort() : tage, k = d.join(','); if (!g.has(k)) g.set(k, { tage: d, ags: [] }); g.get(k).ags.push(a); }
    if (g.size > 1) { teile = [...g.values()].filter(t => t.tage.length); tage = [...new Set(teile.flatMap(t => t.tage))].sort(); }
    else if (g.size === 1) tage = [...g.values()][0].tage;
  }
  // A14: ein Nahverkehrsstreik gilt nur dort, wo sein Gebiet die Gemeinde abdeckt – genannte Städte oder Gemeinden eines genannten Betriebs. „Landesweit“
  // bzw. „bundesweit“ ohne genannte Gemeinde: die Gemeinden der bekannten Stadtverkehrsbetriebe (data/streik-betriebe.json) in diesen Ländern; kennt die
  // Liste dort keinen, bleibt die Meldung Hinweis (vorher: alle Gemeinden des Landes, auch ohne bestreikten Betrieb)
  if (art === 'streik-oepnv' && gebiet && !gebiet.ags) {
    const inL = (a) => gebiet === 'DE' || (gebiet.laender || []).includes(LAND2[String(a).slice(0, 2)] ?? LAND2[+String(a).slice(0, 2)]);
    const cover = [...new Set(places.ops.filter(o => o.art === 'oepnv').flatMap(o => o.ags.filter(inL)))].sort();
    if (cover.length) { why.push(gebiet === 'DE' ? 'bundesweit' : `landesweit ${gebiet.laender.join(', ')}`); gebiet = { ags: cover }; } // nur ags: ctxLookup wertet laender als ganzes Land
  }
  const vague = art === 'streik-oepnv' && !!gebiet && !gebiet.ags;
  const sicher = !!(tage.length && gebiet && !aus && !sammel && !vague);
  const key = `${it?.shareURL || it?.detailsweb || it?.title || ''}`;
  let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { id: `auto:${h.toString(36)}`, art, tage, gebiet, ...(teile ? { teile } : {}), sicher, aus, ...(vague ? { ungenau: true } : {}), ...(sammel ? { sammel: true } : {}), link: it?.shareURL || it?.detailsweb || null, at: new Date(pub).toISOString(), grund: [...new Set(why)].slice(0, 8) };
}

/** Tage → zusammenhängende Abschnitte [von, bis] (ganze Ortstage) */
export const spans = (tage) => { const out = []; for (const d of [...new Set(tage)].sort()) { const l = out[out.length - 1]; if (l && addDay(l[1], 1) === d) l[1] = d; else out.push([d, d]); } return out; };
const landOf = (a) => LAND2[String(a).slice(0, 2)];
/** Überschneiden sich zwei Gebiete ('DE', { laender }, { ags })? */
export const areaOverlap = (a, b) => {
  if (!a || !b) return false; if (a === 'DE' || b === 'DE') return true;
  if (a.ags && b.ags) return a.ags.some(x => b.ags.includes(x));
  const la = new Set([...(a.laender || []), ...(a.ags || []).map(landOf)]), lb = new Set([...(b.laender || []), ...(b.ags || []).map(landOf)]);
  return [...la].some(x => x && lb.has(x));
};

/**
 * Erkannte Streiks fortschreiben: prev = bisherige streiks.json, cands = neue Kandidaten. Gleiche Meldung (Link) ersetzt die ältere Fassung.
 * Absagen (aus) heben sichere Streiks gleicher Art im selben Gebiet auf – an den genannten Tagen bzw. ohne Tag an allen Tagen ab der Absage –, wenn
 * die Absage neuer ist. Älteres als keepDays fällt weg. Rückgabe { erkannt: [...], hinweise: [...] } (Hinweise: unsicher, abgesagt, Absagen).
 */
export function mergeStrikes(prev, cands, { now = Date.now(), keepDays = STRIKE.keepDays } = {}) {
  const cut = addDay(dayOf(now), -keepDays), all = new Map();
  const fresh = (c) => (c.tage?.length ? c.tage[c.tage.length - 1] >= cut : String(c.at || '').slice(0, 10) >= cut);
  for (const c of [...(prev?.erkannt || []), ...(prev?.hinweise || []), ...cands]) {
    if (!c?.id || !fresh(c)) continue;
    // gleiche Meldung: neuerer Auswertungsstand vor Volltext vor neuerem Stand der Meldung
    const k = c.link || c.id, old = all.get(k), rank = (x) => [x.v || 1, x.det ? 1 : 0, String(x.at || '')];
    const newer = (a, b) => { const ra = rank(a), rb = rank(b); return ra[0] !== rb[0] ? ra[0] > rb[0] : ra[1] !== rb[1] ? ra[1] > rb[1] : ra[2] >= rb[2]; };
    if (!old || newer(c, old)) { const { abgesagt, ...rest } = c; all.set(k, { ...rest, sicher: !!(c.tage?.length && c.gebiet && !c.aus && !c.sammel && !c.ungenau) }); }
  }
  const list = [...all.values()];
  for (const o of list.filter(c => c.aus && c.gebiet)) {
    const from = String(o.at || '').slice(0, 10);
    for (const c of list) if (!c.aus && c.sicher && c.art === o.art && String(c.at || '') <= String(o.at || '') && areaOverlap(c.gebiet, o.gebiet) && (o.tage?.length ? c.tage.some(d => o.tage.includes(d)) : c.tage.some(d => d >= from))) { c.sicher = false; c.abgesagt = o.link || true; }
  }
  return { erkannt: list.filter(c => c.sicher).sort((a, b) => a.tage[0].localeCompare(b.tage[0]) || a.id.localeCompare(b.id)), hinweise: list.filter(c => !c.sicher).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 60) };
}

/**
 * Sichere Erkennungen → Einträge wie data/ereignisse.json (je zusammenhängendem Abschnitt einer), ohne Doppel zu gepflegten Streiks und untereinander
 * (gleiche Art, Gebiet und Tage überschneiden sich: die zuerst erschienene Meldung gewinnt).
 */
export function strikeEntries(doc, curated = []) {
  const out = [], label = { 'streik-oepnv': 'Streik im Nahverkehr', 'streik-bahn': 'Bahnstreik' };
  const clash = (list, art, von, bis, gebiet) => list.some(e => e.art === art && String(e.von).slice(0, 10) <= bis && String(e.bis ?? e.von).slice(0, 10) >= von && areaOverlap(e.gebiet, gebiet));
  const cands = [...(doc?.erkannt || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const cap = (g) => g.replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
  for (const c of cands) for (const part of (c.teile?.length && c.gebiet?.ags ? c.teile.map(t => ({ tage: t.tage, gebiet: { ags: t.ags } })) : [{ tage: c.tage, gebiet: c.gebiet }])) for (const [von, bis] of spans(part.tage)) {
    // Gemeinden, die schon ein gepflegter oder früher erkannter Streik derselben Art an diesen Tagen abdeckt, fallen weg; Länder/bundesweit ganz oder gar nicht
    let gebiet = part.gebiet;
    if (gebiet?.ags) { const keep = gebiet.ags.filter(a => !clash(curated || [], c.art, von, bis, { ags: [a] }) && !clash(out, c.art, von, bis, { ags: [a] })); if (!keep.length) continue; gebiet = { ags: keep }; }
    else if (clash(curated || [], c.art, von, bis, gebiet) || clash(out, c.art, von, bis, gebiet)) continue;
    const where = c.grund?.length ? c.grund.slice(0, 4).map(cap).join(', ') : c.gebiet === 'DE' ? 'bundesweit' : (c.gebiet?.laender || []).join(', ');
    out.push({ art: c.art, von, bis, gebiet, titel: `${label[c.art]}${where ? ` (${where})` : ''}`, quelle: c.link || 'https://www.tagesschau.de', id: `${c.id}:${von}${gebiet.ags && c.teile ? `:${gebiet.ags[0]}` : ''}`, auto: true, stand: String(c.at || '').slice(0, 10) });
  }
  return out.sort((a, b) => a.von.localeCompare(b.von));
}

/** Suchadresse der tagesschau-App für eine Abfrage */
export const strikeSearchUrl = (q, page = 0, base = STRIKE.base, pageSize = STRIKE.pageSize) => `${base}?searchText=${encodeURIComponent(q)}&pageSize=${pageSize}&resultPage=${page}`;
/** Treffer aus einer Suchantwort (Feld searchResults; andere Felder vorsichtshalber) */
export const searchItems = (j) => (Array.isArray(j?.searchResults) ? j.searchResults : Array.isArray(j?.news) ? j.news : Array.isArray(j?.items) ? j.items : []).filter(x => x && typeof x === 'object');
/** Darf eine Detail-Adresse abgerufen werden (nur JSON der tagesschau-App)? */
export const detailUrlOk = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && x.host === 'www.tagesschau.de' && x.pathname.startsWith('/api2u/') && x.pathname.endsWith('.json'); } catch { return false; } };
/** Kommt eine Meldung als Streik bei Bussen/Bahnen in Frage (Kopf)? Für die Auswahl der Detail-Abrufe */
export const strikeLead = (it) => { const { lead } = itemText(it); return !!lead && STRIKE_RE.test(lead) && TRANSIT_RE.test(lead) && !TICKER_RE.test(it?.title || ''); };
