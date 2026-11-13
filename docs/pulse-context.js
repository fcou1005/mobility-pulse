// Umgebung der Prognose: Ereignisse je Gemeinde und Ortsstunde, die die Nachfrage verschieben können.
//
// Quellen (alle optional, jede einzeln abschaltbar):
//   warn   – Wetterwarnungen des DWD (über Bright Sky /alerts, je 0,5°-Wetterzelle), ab Stufe „markant“ (moderate); mit Beginn und Ende,
//            also auch für die kommenden Stunden bekannt
//   road   – Autobahn: Sperrung oder Stau im Gemeindegebiet (Autobahn GmbH, verkehr.autobahn.de), nur zur Stunde der Beobachtung
//   strike – Streik im ÖPNV, rail – Bahnstreik, event – Veranstaltung: aus der gepflegten Liste data/ereignisse.json (es gibt keine offene
//            Schnittstelle für Streiks; Einträge mit Quelle)
//   fest   – Volksfest über mehrere Wochen (Wasen, Oktoberfest, Freimarkt, Dippemess …): eigenes Merkmal, damit die Saison eines Festplatzes
//            nicht als Wirkung einer Einzelveranstaltung gelernt wird (seit 08.11.2026; wie Veranstaltungen erst ab veranstaltungenAb)
//   sport  – Heimspiel aus OpenLigaDB (Fußball 1.–3. Liga, DFB-Pokal, Champions League, DEL): eigenes Merkmal, weil Stadionspiele mit
//            Zehntausenden Fans anders wirken als Hallenkonzerte (seit 08.11.2026; ab aktivAb in data/sport-spielorte.json)
// Gespeichert werden nur abgeleitete Kennzeichen (Gemeinde, Stunde, Stufe bzw. ja/nein), keine Meldungstexte.
// Datei incidents/<Ortstag>.json: { version: 1, day, updatedAt, sources: { warn: {at, cells}, road: {at, items} }, ags: { [ags]: { warn: [24], road: [24] } } }
import { hourOf, dayOf } from './pulse-track.js?v=mwf1y0cc';

export const CTX_KEYS = ['warn', 'road', 'strike', 'rail', 'event', 'fest', 'sport']; // neue Merkmale nur hinten anfügen (Gedächtnis, lib/pulse-forecast.js memoryResize)
export const SEVERITY = { minor: 1, moderate: 2, severe: 3, extreme: 4 };
export const WARN_MIN = 2; // Merkmal „warn“ ab Stufe 2 (markant); Stufe 1 (z. B. Frost, leichter Wind) ist fast täglich irgendwo und trägt nichts
export const CURATED_KINDS = { 'streik-oepnv': 'strike', 'streik-bahn': 'rail', veranstaltung: 'event', volksfest: 'fest', sport: 'sport' };
const LAND_OF_AGS = { '01': 'SH', '02': 'HH', '03': 'NI', '04': 'HB', '05': 'NW', '06': 'HE', '07': 'RP', '08': 'BW', '09': 'BY', '10': 'SL', '11': 'BE', '12': 'BB', '13': 'MV', '14': 'SN', '15': 'ST', '16': 'TH' };

export const emptyIncidentDoc = (day) => ({ version: 1, day, updatedAt: null, sources: {}, ags: {} });
const slot = (doc, ags, key) => { const a = (doc.ags[ags] ||= {}); return (a[key] ||= new Array(24).fill(0)); };

/** Stunden (UTC-Beginn) im Intervall [from, to) */
function* hoursBetween(from, to) { for (let t = Math.floor(from / 3600e3) * 3600e3; t < to; t += 3600e3) yield t; }

/**
 * DWD-Warnungen eintragen. docs: Map Ortstag → Dokument (wird ergänzt), alerts: { zelle: [Bright-Sky-Alert] }, agsCell: { ags: zelle }.
 * Je Stunde zählt die höchste Stufe; bereits eingetragene Stunden bleiben (Warnungen der Vergangenheit kommen nicht erneut).
 * Nur status 'actual'; ohne Ende 6 Stunden; höchstens maxAheadH Stunden voraus, nichts vor from.
 */
export function addAlerts(docs, alerts, agsCell, now, { maxAheadH = 48, from = now - 3 * 3600e3 } = {}) {
  const byCell = new Map(); for (const [ags, c] of Object.entries(agsCell || {})) { if (!byCell.has(c)) byCell.set(c, []); byCell.get(c).push(ags); }
  let n = 0;
  for (const [cell, list] of Object.entries(alerts || {})) {
    const agsList = byCell.get(cell); if (!agsList || !Array.isArray(list)) continue;
    for (const a of list) {
      const sev = SEVERITY[a?.severity] || 0; if (!sev || (a.status && a.status !== 'actual')) continue;
      const on = Date.parse(a.onset ?? a.effective), off = a.expires ? Date.parse(a.expires) : on + 6 * 3600e3;
      if (!Number.isFinite(on) || !Number.isFinite(off) || off <= on) continue;
      for (const t of hoursBetween(Math.max(on, from), Math.min(off, now + maxAheadH * 3600e3))) {
        const day = dayOf(t), h = hourOf(t); let doc = docs.get(day); if (!doc) docs.set(day, doc = emptyIncidentDoc(day));
        for (const ags of agsList) { const s = slot(doc, ags, 'warn'); if (sev > s[h]) { s[h] = sev; n++; } }
      }
    }
  }
  return n;
}

// Nur frische Ereignisse zählen: Bauphasen-Sperrungen laufen oft monatelang (Beginn Monate zurück) und wären je Gemeinde fast konstant – das
// Modell könnte sie nicht vom Gruppeneffekt trennen, und für die Zukunft ist der Wert unbekannt (dort 0). Deshalb: Sperrung, die vor höchstens
// ROAD_FRESH.closureH Stunden begonnen hat oder ohne Beginn (kurzfristige Sperrfenster, z. B. nachts), Stau seit höchstens ROAD_FRESH.jamH Stunden.
export const ROAD_FRESH = { closureH: 24, jamH: 6 };
/** Autobahn-Meldung → { lat, lon, kind: 'closure' | 'jam' } oder null (Dauer-Baustellen, geplante Sperrungen, alte Staumeldungen, ohne Koordinate) */
export function roadItem(it, service, now) {
  const lat = +it?.coordinate?.lat, lon = +it?.coordinate?.long;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || it.future === true) return null;
  const start = it.startTimestamp ? Date.parse(it.startTimestamp) : NaN;
  if (Number.isFinite(start) && start > now) return null;
  const age = Number.isFinite(start) ? (now - start) / 3600e3 : 0;
  if (service === 'closure') return age <= ROAD_FRESH.closureH ? { lat, lon, kind: 'closure' } : null;
  const type = String(it.abnormalTrafficType || ''), text = [it.title, ...(Array.isArray(it.description) ? it.description : [])].join(' ');
  const jam = (/STATIONARY|QUEUING|SLOW|HEAVY/.test(type) || /\bStau\b|stockender Verkehr|zähfließend|Stillstand/i.test(text)) && age <= ROAD_FRESH.jamH;
  return jam ? { lat, lon, kind: 'jam' } : null;
}

/** Autobahn-Beobachtung zur aktuellen Ortsstunde eintragen: items [{lat, lon}], locate(lat, lon) → ags | null; Rückgabe: Gemeinden mit Meldung */
export function addRoad(docs, items, locate, now) {
  const day = dayOf(now), h = hourOf(now); let doc = docs.get(day); if (!doc) docs.set(day, doc = emptyIncidentDoc(day));
  const hit = new Set();
  for (const it of items || []) { const ags = locate(it.lat, it.lon); if (ags) hit.add(ags); }
  for (const ags of hit) slot(doc, ags, 'road')[h] = 1;
  return hit.size;
}

/** Gepflegte Liste (data/ereignisse.json → ereignisse[]) prüfen: Einträge mit bekannter Art, Datum und Gebiet; Rückgabe { ok: [...], bad: [Grund] } */
export function checkCurated(doc) {
  const ok = [], bad = [], isDay = (s) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(s || ''));
  for (const [i, e] of (Array.isArray(doc?.ereignisse) ? doc.ereignisse : []).entries()) {
    if (!CURATED_KINDS[e?.art]) { bad.push(`#${i}: Art „${e?.art}“ unbekannt`); continue; }
    if (!isDay(e.von) || !isDay(e.bis ?? e.von) || String(e.bis ?? e.von) < String(e.von)) { bad.push(`#${i}: von/bis ungültig`); continue; }
    const g = e.gebiet; if (!(g === 'DE' || Array.isArray(g?.laender) || Array.isArray(g?.ags))) { bad.push(`#${i}: Gebiet fehlt (DE, {laender}, {ags})`); continue; }
    if (!e.quelle) { bad.push(`#${i}: Quelle fehlt`); continue; }
    ok.push(e);
  }
  return { ok, bad };
}
/** Ortstag + Stunde als vergleichbare Zeichenfolge 'YYYY-MM-DDTHH:00' */
const stamp = (day, h) => `${day}T${String(h).padStart(2, '0')}:00`;
const fromOf = (s) => (s.length === 10 ? `${s}T00:00` : s), toOf = (s) => (s.length === 10 ? `${s}T23:59` : s);

/**
 * Merkmale je (Gemeinde, Ortstag, Ortsstunde): docs = incidents-Dokumente (Liste), curated = geprüfte Einträge.
 * Rückgabe ctx(ags, day, h) → Int8Array(CTX_KEYS.length) (0/1) – ohne Information 0 (keine Meldung).
 */
export function ctxLookup(docs = [], curated = []) {
  const byDay = new Map(); for (const d of docs || []) if (d?.day && d.ags) byDay.set(d.day, d);
  const cur = (curated || []).map(e => ({ k: CTX_KEYS.indexOf(CURATED_KINDS[e.art]), from: fromOf(String(e.von)), to: toOf(String(e.bis ?? e.von)), all: e.gebiet === 'DE', laender: new Set(e.gebiet?.laender || []), ags: new Set(e.gebiet?.ags || []) }));
  // je Ortstag nur die Einträge, die ihn berühren (Hunderte Veranstaltungen × Zeilen der Prognose wären sonst zu langsam)
  const curByDay = new Map();
  for (const e of cur) { const d0 = e.from.slice(0, 10), d1 = e.to.slice(0, 10); for (let t = Date.parse(`${d0}T12:00:00Z`), n = 0; n < 400; t += 86400e3, n++) { const d = new Date(t).toISOString().slice(0, 10); if (d > d1) break; let l = curByDay.get(d); if (!l) curByDay.set(d, l = []); l.push(e); } }
  const iW = CTX_KEYS.indexOf('warn'), iR = CTX_KEYS.indexOf('road');
  return (ags, day, h) => {
    const out = new Int8Array(CTX_KEYS.length), a = byDay.get(day)?.ags?.[ags];
    if (a) { if ((a.warn?.[h] || 0) >= WARN_MIN) out[iW] = 1; if (a.road?.[h]) out[iR] = 1; }
    const list = curByDay.get(day);
    if (list) { const s = stamp(day, h), land = LAND_OF_AGS[String(ags).slice(0, 2)];
      for (const e of list) if (s >= e.from && s <= e.to && (e.all || e.laender.has(land) || e.ags.has(String(ags)))) out[e.k] = 1; }
    return out;
  };
}

// ---------- Sport: Heimspiele aus OpenLigaDB (ODbL) als Veranstaltungen ----------
// Je Heimspiel ein Eintrag wie in data/ereignisse.json (art 'veranstaltung' → Merkmal event) für die Gemeinde des Stadions (data/sport-spielorte.json),
// von der vollen Stunde vor Anstoß − beforeMin bis Anstoß + afterMin (Spiel, Halbzeit, Abreise). Nur Spiele im Fenster [now − pastDays, now + aheadDays]:
// weiter vorn stehen oft nur Platzhalter-Anstoßzeiten, bis die Liga die Spieltage zeitgenau ansetzt.
// aheadDays/keepAheadDays: alle schon angesetzten Spiele der Saison stehen in sport.json (Liste im Dashboard; die Prognose selbst schaut höchstens 48 Stunden voraus)
export const SPORT = { leagues: ['bl1', 'bl2', 'bl3', 'del', 'dfb', 'ucl'], beforeMin: 60, afterMin: 180, pastDays: 60, aheadDays: 300, keepAheadDays: 300, refreshH: 6 };
/** OpenLigaDB-Saison (Startjahr): ab Juli das laufende Jahr */
export const sportSeason = (now) => { const d = new Date(now); return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };
/** OpenLigaDB-Spiele → kompakte Zeilen [matchID, Liga, Anstoß UTC (ms), Heim, Gast] (ohne Anstoßzeit oder Mannschaft: entfällt) */
export function compactMatches(list, league) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const t = Date.parse(m?.matchDateTimeUTC ?? ''), h = m?.team1?.teamName, g = m?.team2?.teamName;
    // Endspiele (DFB-Pokal in Berlin, Champions League) auf neutralem Platz: kein Heimspiel in der Stadt des erstgenannten Vereins
    if (/^(finale|endspiel|final)$/i.test(String(m?.group?.groupName || '').trim())) continue;
    if (Number.isFinite(t) && typeof h === 'string' && h && typeof g === 'string') out.push([m.matchID ?? null, league, t, h, g]);
  }
  return out;
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const localStamp = (t) => { const d = new Date(t); return `${dayOf(t)}T${String(hourOf(t)).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
/**
 * Heimspiele → Einträge. rows: compactMatches-Zeilen, venues: data/sport-spielorte.json ({ ligen: { bl1: 'alle' | 'liste' }, vereine: { Name: { ort, land, ags?, alias? } } }),
 * resolve(ort, land) → ags | null. Rückgabe { entries, unknown: [Heimmannschaft ohne Spielort in Ligen „alle“], noAgs: [Ort ohne Gemeinde] }
 */
export function sportEntries(rows, venues, { now, resolve = () => null, beforeMin = SPORT.beforeMin, afterMin = SPORT.afterMin, pastDays = SPORT.pastDays, aheadDays = SPORT.aheadDays, base = 'https://api.openligadb.de' } = {}) {
  const byName = new Map();
  for (const [name, v] of Object.entries(venues?.vereine || {})) for (const n of [name, ...(Array.isArray(v?.alias) ? v.alias : [])]) byName.set(norm(n), v);
  const entries = [], unknown = new Set(), noAgs = new Set(), agsOf = new Map();
  for (const [id, lg, t, home, guest] of rows || []) {
    if (!(t >= now - pastDays * 86400e3 && t <= now + aheadDays * 86400e3)) continue;
    const v = byName.get(norm(home));
    if (!v) { if ((venues?.ligen?.[lg] ?? 'alle') === 'alle') unknown.add(home); continue; }
    const key = `${v.ort}|${v.land}`; if (!agsOf.has(key)) agsOf.set(key, v.ags || resolve(v.ort, v.land) || null);
    const ags = agsOf.get(key); if (!ags) { noAgs.add(`${v.ort} (${v.land})`); continue; }
    const from = Math.floor((t - beforeMin * 60e3) / 3600e3) * 3600e3;
    entries.push({ art: 'sport', von: localStamp(from), bis: localStamp(t + afterMin * 60e3), gebiet: { ags: [ags] }, titel: `${home} – ${guest} (${lg}, Anstoß ${localStamp(t).slice(11)})`,
      quelle: `${base}/getmatchdata/${lg}/${sportSeason(t)}`, id: id == null ? null : `openligadb:${id}`, beginn: t, liga: lg });
  }
  entries.sort((a, b) => a.von.localeCompare(b.von));
  return { entries, unknown: [...unknown].sort(), noAgs: [...noAgs].sort() };
}
/** Gemeinde zu Ortsname und Land aus den Grenzen (features[].properties { ags, name, state }); Namen wie „Cottbus/Chóśebuz“ passen über den Anfang */
export function placeResolver(features) {
  const idx = new Map();
  for (const f of features || []) { const p = f?.properties; if (!p?.ags || !p.name) continue; const k = `${p.state}|${norm(String(p.name).split(/[/,(]/)[0])}`; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(p.ags); }
  return (ort, land) => { const l = idx.get(`${land}|${norm(ort)}`); return l?.length === 1 ? l[0] : null; };
}

// ---------- Veranstaltungsorte (Wikidata, CC0) und Termine aus den Programmseiten der Orte (ohne Schlüssel) ----------
// Orte: Bauwerke in Deutschland mit Kapazität ≥ minCap (Wikidata P1083) und Koordinate – Stadien, Arenen, Hallen, Freilichtbühnen. Kapazität = „wie viele
// Leute“ (Obergrenze, nicht verkauft). Termine: data/veranstaltungskalender.json nennt je Quelle eine öffentliche Programmseite (HTML: schema.org-Event
// oder Datum neben Link) oder einen ICS-Kalender und den Ort (Wikidata-ID, bei Sammelseiten je Stichwort). Kein Konto, kein Schlüssel.
export const VENUES = { minCap: 5000, refreshDays: 7, aheadDays: 365, pastDays: 60, refreshH: 6, perRun: 8, maxBytes: 3e6, beforeMin: 60, afterMin: 180, allDayFrom: 10, allDayTo: 22, noTimeFrom: 17, noTimeTo: 23, maxDays: 5, modelMinCap: 5000 };
export const VENUE_TYPES_OK = /stadion|arena|halle|konzert|veranstaltung|messe|freilicht|bühne|amphitheater|theater|sportstätte|eisstadion|velodrom|festplatz|kongress|tennis|spielstätte|eisbahn/i;
export const VENUE_JUNK = /^(vvk|vorverkauf|tickets?|einlass|termine?|mehr|infos?|abgesagt|verlegt|ausverkauft)\b|^.{0,2}$/i;
export const VENUE_TYPES_NO = /friedhof|thingstätte|unvollendet|rennbahn|rennstrecke|schanze|kirche|kloster|schloss|burg|ruine|denkmal|bahnhof/i;
export const wikidataVenueQuery = (minCap = VENUES.minCap) => `SELECT ?i ?l ?c ?p ?w ?addr (GROUP_CONCAT(DISTINCT ?tl; separator="|") AS ?types) WHERE {
 ?i wdt:P17 wd:Q183; wdt:P1083 ?c; wdt:P625 ?p. FILTER(?c >= ${+minCap})
 OPTIONAL { ?i wdt:P856 ?w } OPTIONAL { ?i wdt:P6375 ?addr }
 OPTIONAL { ?i wdt:P31 ?t. ?t rdfs:label ?tl FILTER(lang(?tl)="de") }
 OPTIONAL { ?i rdfs:label ?l FILTER(lang(?l)="de") }
 FILTER NOT EXISTS { ?i wdt:P576 ?end }
} GROUP BY ?i ?l ?c ?p ?w ?addr`;
/** SPARQL-Ergebnis → Orte [{ id, name, cap, lat, lon, web, addr, types }] (je Objekt eine Zeile, größte Kapazität; ungeeignete Arten entfallen) */
export function parseVenues(json, { minCap = VENUES.minCap } = {}) {
  const m = new Map();
  for (const b of json?.results?.bindings || []) {
    const id = String(b.i?.value || '').split('/').pop(), cap = +b.c?.value, pt = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.p?.value || '');
    if (!/^Q\d+$/.test(id) || !Number.isFinite(cap) || !pt) continue;
    const e = m.get(id) || { id, name: b.l?.value || id, cap: 0, lat: +(+pt[2]).toFixed(5), lon: +(+pt[1]).toFixed(5), web: null, addr: b.addr?.value || null, types: b.types?.value || '' };
    e.cap = Math.max(e.cap, cap); const w = b.w?.value, foreign = (u) => /\/(en|ar|cn|es|fr|it|ja|ru)\/?$/.test(u); if (w && (!e.web || (foreign(e.web) && !foreign(w)))) e.web = w;
    m.set(id, e);
  }
  return [...m.values()].filter(v => v.cap >= minCap && !VENUE_TYPES_NO.test(v.types) && (!v.types || VENUE_TYPES_OK.test(v.types))).sort((a, b) => b.cap - a.cap || a.id.localeCompare(b.id));
}
// ---------- Kalender lesen: Programmseiten (HTML) und ICS ----------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', eacute: 'é', egrave: 'è' };
const unent = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
/** Minimaler HTML-Baum (ohne Abhängigkeiten): { tag, attrs, children, parent }; Text als String; script/style/noscript nur als Rohtext */
export function htmlTree(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null }; let cur = root;
  const re = /<!--[\s\S]*?-->|<(script|style|noscript)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) { cur.children.push({ tag: m[1].toLowerCase(), attrs: attrsOf(m[2]), children: [m[3]], parent: cur, raw: true }); continue; }
    if (m[4]) { const tag = m[4].toLowerCase(); let n = cur; while (n && n.tag !== tag) n = n.parent; if (n && n.parent) cur = n.parent; continue; }
    if (m[5]) { const tag = m[5].toLowerCase(), node = { tag, attrs: attrsOf(m[6]), children: [], parent: cur }; cur.children.push(node); if (!VOID.has(tag) && !/\/\s*$/.test(m[6])) cur = node; continue; }
    cur.children.push(m[0]);
  }
  return root;
}
function attrsOf(s) { const a = {}; for (const m of String(s || '').matchAll(/([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) a[m[1].toLowerCase()] = unent(m[3] ?? m[4] ?? m[5] ?? ''); return a; }
export const textOf = (n) => (typeof n === 'string' ? unent(n) : n.raw ? '' : n.children.map(textOf).join(' ')).replace(/\s+/g, ' ').trim();
const walk = (n, f) => { if (typeof n === 'string') return; f(n); for (const c of n.children) walk(c, f); };
const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
const pad2 = (x) => String(x).padStart(2, '0');
const isoDay = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const addDayIso = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
/** Ortszeit Europe/Berlin → UTC (ms) */
export function berlinUtc(day, h = 0, mi = 0) {
  const [y, m, d] = day.split('-').map(Number); let t = Date.UTC(y, m - 1, d, h, mi) - 3600e3;
  if (hourOf(t) !== h || dayOf(t) !== day) t -= 3600e3;
  return t;
}
/**
 * Datum und Uhrzeit aus Text: „Sa. 07.11.2026 20:00 Uhr“, „04. - 05.12.2026“, „11.11.2026 - 15.11.2026“, „10. November 2026, 19:30 Uhr“,
 * „Einlass: 18:30 Uhr Beginn: 20:00 Uhr“ (Beginn zählt). Rückgabe { days: [YYYY-MM-DD …], time: 'HH:MM' | null } oder null.
 */
export function parseDateText(txt) {
  const s = String(txt || ''), dates = [];
  for (const m of s.matchAll(/(\d{1,2})\.\s?(\d{1,2})\.\s?(20\d{2})/g)) dates.push({ i: m.index, end: m.index + m[0].length, y: +m[3], mo: +m[2], d: +m[1] });
  for (const m of s.matchAll(/(\d{1,2})\.\s?(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s?(20\d{2})/gi)) { const mo = MONTHS.indexOf(m[2].toLowerCase().replace('maerz', 'märz')) + 1; dates.push({ i: m.index, end: m.index + m[0].length, y: +m[3], mo, d: +m[1] }); }
  dates.sort((a, b) => a.i - b.i);
  const ok = (x) => x.mo >= 1 && x.mo <= 12 && x.d >= 1 && x.d <= 31;
  const first = dates.find(ok); if (!first) return null;
  let from = isoDay(first.y, first.mo, first.d), to = from;
  // Spanne „04. - 05.12.2026“ / „04.12. - 05.12.2026“: Anfangstag ohne Jahr vor dem ersten vollen Datum
  const pre = s.slice(Math.max(0, first.i - 14), first.i).match(/(\d{1,2})\.(?:\s?(\d{1,2})\.)?\s*[-–—]\s*$/);
  if (pre) { to = from; from = isoDay(first.y, pre[2] ? +pre[2] : first.mo, +pre[1]); if (from > to) from = isoDay(first.y - 1, pre[2] ? +pre[2] : first.mo, +pre[1]); }
  else { const nx = dates.find(x => x !== first && ok(x) && x.i > first.i && /^\s*[-–—]\s*$|^\s*bis\s*$/.test(s.slice(first.end, x.i))); if (nx) to = isoDay(nx.y, nx.mo, nx.d); }
  const days = []; for (let d = from, k = 0; d <= to && k < 62; d = addDayIso(d, 1), k++) days.push(d);
  const after = s.slice(first.i), beg = after.match(/Beginn:?\s*(\d{1,2})[:.](\d{2})/i), any = after.match(/(\d{1,2})[:.](\d{2})\s*(?:Uhr|h\b)/i) || after.match(/\/\/\s*(\d{1,2}):(\d{2})/) || after.match(/,\s*(\d{1,2}):(\d{2})(?!\d)/);
  const tm = beg || any, hh = tm ? +tm[1] : null;
  return { days, time: tm && hh < 24 && +tm[2] < 60 ? `${pad2(hh)}:${tm[2]}` : null };
}
/** schema.org-Events aus JSON-LD (auch in @graph und ItemList) → [{ name, start: 'YYYY-MM-DDTHH:MM' | 'YYYY-MM-DD', place, url, type }] */
export function jsonLdEvents(tree) {
  const out = [], flat = (x) => (Array.isArray(x) ? x.flatMap(flat) : x && typeof x === 'object' ? [x, ...flat(x['@graph'] || []), ...flat((x.itemListElement || []).map(i => i?.item || i))] : []);
  walk(tree, (n) => {
    if (n.tag !== 'script' || !/ld\+json/i.test(n.attrs.type || '')) return;
    let j; try { j = JSON.parse(n.children[0] || ''); } catch { return; }
    for (const e of flat(j)) {
      if (!/Event$/.test(String([].concat(e['@type'] || '')[0] || ''))) continue;
      const st = String(e.startDate || '').trim().replace(' ', 'T'); if (!/^\d{4}-\d{2}-\d{2}/.test(st)) continue;
      out.push({ name: String(e.name || '').slice(0, 140), start: st, place: String(e.location?.name || [].concat(e.location || [])[0]?.name || ''), url: typeof e.url === 'string' ? e.url : null, type: String([].concat(e['@type'])[0]) });
    }
  });
  return out;
}
const SKIP_LINK = /^(tickets?( kaufen)?|infos?( & tickets)?|mehr( lesen| infos)?|details?|weiter|kaufen|ticket|tickets & infos|infos & tickets)$/i;
const MON_RE = MONTHS.join('|') + '|maerz';
const LEAD_RE = new RegExp(`^\\s*(?:\\d{1,2}\\.\\s?(?:\\d{1,2}\\.|${MON_RE})\\s?(?:20\\d{2})?|(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\\.?,?|(?:mo|di|mi|do|fr|sa|so)\\.,?|[-–—,|/:]|\\d{1,2}[:.]\\d{2}\\s*(?:uhr)?)(?=\\s|$)`, 'i');
/** Name aus Kartentext: Datum, Wochentag und Uhrzeit vorn weg, ab „Einlass“, „Beginn“, „Ausverkauft“, „Sell out“, „Tickets“ abgeschnitten (Lanxess: „07. November 2026 Samstag Sa. Felix Lobrecht Sell out Einlass: …“) */
export function cleanEventName(s) {
  let x = ` ${String(s || '')}`.replace(/\s+/g, ' ').replace(/\s(?:sell[ -]?out|ausverkauft|einlass|beginn|tickets?)(?=[\s:]|$).*$/i, '');
  for (let k = 0; k < 12 && LEAD_RE.test(x); k++) x = x.replace(LEAD_RE, '');
  return x.replace(/\d{1,2}\.\s?\d{1,2}\.\s?(20\d{2})?|\d{1,2}[:.]\d{2}\s*Uhr/gi, ' ').replace(/\s+/g, ' ').trim();
}
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
/**
 * Programmseite (HTML) → Termine: je Link (optional nur Pfade nach linkRe) der nächste Block mit Datum (höchstens 6 Ebenen, < 600 Zeichen).
 * Links auf andere Seiten (Hallenduo: Kartenlink je Termin) liefern nur den Block, Name dann aus Überschrift oder Element mit Klasse …title/…name,
 * Adresse ist die Programmseite. Je Termin und Tag eine Zeile, die mit Uhrzeit gewinnt (Lanxess, SAP Arena: Bild- und Textlink je Termin).
 */
export function htmlEvents(tree, baseUrl, { link = null } = {}) {
  const re = link ? new RegExp(link) : null, out = [], at = new Map(), home = hostOf(baseUrl);
  walk(tree, (a) => {
    if (a.tag !== 'a' || !a.attrs.href) return;
    let href; try { href = new URL(a.attrs.href, baseUrl).href; } catch { return; }
    if (re && !re.test(href)) return;
    let el = a, txt = '', dt = null;
    for (let i = 0; i < 6 && el && el.tag !== '#root'; i++, el = el.parent) { txt = textOf(el); if (txt.length > 600) break; dt = parseDateText(txt); if (dt) break; }
    if (!dt) return;
    const ext = hostOf(href) !== home;
    let name = ext ? '' : textOf(a);
    if (!name || name.length < 3 || SKIP_LINK.test(name) || /^\W*\d/.test(name)) {
      let h = null; walk(el, (x) => { if (!h && x !== a && (/^h[1-5]$/.test(x.tag) || /(^|[\s_-])(title|titel|headline|name)([\s_-]|$)/i.test(x.attrs.class || ''))) { const v = cleanEventName(textOf(x)); if (v.length >= 3) h = v; } });
      name = h || cleanEventName(txt).slice(0, 80);
    } else name = cleanEventName(name) || name;
    if (!name) return;
    const url = ext ? baseUrl : href, key = `${ext ? name : url}|${dt.days[0]}`, ev = { name: name.slice(0, 140), days: dt.days, time: dt.time, text: txt.slice(0, 300), url };
    const j = at.get(key); if (j == null) { at.set(key, out.length); out.push(ev); } else if (!out[j].time && ev.time) out[j] = ev;
  });
  return out;
}
/** ICS (RFC 5545) → [{ name, start: 'YYYY-MM-DDTHH:MM' | 'YYYY-MM-DD', utc: bool, place, url }] (Zeilen entfaltet; TZID wird als Ortszeit Berlin gelesen) */
export function icsEvents(text) {
  const lines = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/), out = []; let e = null;
  const val = (l) => l.slice(l.indexOf(':') + 1).replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') e = {}; else if (l === 'END:VEVENT') { if (e?.start) out.push(e); e = null; }
    else if (e) {
      const k = l.slice(0, l.search(/[:;]/)).toUpperCase();
      if (k === 'SUMMARY') e.name = val(l).slice(0, 140); else if (k === 'LOCATION') e.place = val(l); else if (k === 'URL') e.url = val(l);
      else if (k === 'DTSTART') { const v = val(l), m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z?))?/); if (m) { e.start = m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`; e.utc = m[6] === 'Z'; } }
      else if (k === 'STATUS' && /CANCELLED/i.test(val(l))) e.cancelled = true;
    }
  }
  return out.filter(x => !x.cancelled);
}
/**
 * Eine Quelle (data/veranstaltungskalender.json) lesen: { url, art: 'seite' | 'ics', ort: Wikidata-ID, orte: { Stichwort: Wikidata-ID }, link }
 * → Zeilen [id, name, Beginn UTC ms, Ort-ID, Art, null, url, ohneZeit] (ohneZeit: 0 = mit Uhrzeit, 1 = Tag einer mehrtägigen Veranstaltung, 2 = Tag ohne
 * Uhrzeit); Spannen über maxDays Tage (Tourneen, Saisons) entfallen.
 */
export function calendarRows(body, src, { maxDays = VENUES.maxDays } = {}) {
  const items = [];
  if (src.art === 'ics') for (const e of icsEvents(body)) items.push({ name: e.name || '', start: e.start, utc: e.utc, place: e.place || '', url: e.url || src.url, type: null, text: `${e.name} ${e.place}`, span: true });
  else {
    const tree = htmlTree(body), ld = jsonLdEvents(tree);
    if (ld.length) for (const e of ld) items.push({ ...e, text: `${e.name} ${e.place}`, url: e.url ? new URL(e.url, src.url).href : src.url });
    else for (const e of htmlEvents(tree, src.url, { link: src.link })) { if (e.days.length > maxDays) continue; for (const d of e.days) items.push({ name: e.name, start: e.time && e.days.length === 1 ? `${d}T${e.time}` : d, place: '', url: e.url, type: null, text: e.text, span: e.days.length > 1 }); }
  }
  const out = [], seen = new Set(), kw = Object.entries(src.orte || {});
  for (const it of items) {
    // Stichwort vor Ort (Sammelseiten); Stichwort mit null = ausschließen (z. B. „Kleine Olympiahalle“ vor „Olympiahalle“)
    const hit = kw.find(([k]) => (`${it.place} ${it.text}`).toLowerCase().includes(k.toLowerCase())), vid = hit ? hit[1] : src.ort; if (!vid) continue;
    const allDay = it.start.length === 10, t = it.utc ? Date.parse(`${it.start}:00Z`) : allDay ? berlinUtc(it.start, 0, 0) : berlinUtc(it.start.slice(0, 10), +it.start.slice(11, 13), +it.start.slice(14, 16));
    if (!Number.isFinite(t) || !it.name) continue;
    const key = `${vid}|${t}`; if (seen.has(key)) continue; seen.add(key);
    out.push([`${src.id || src.url}|${t}|${vid}`, it.name, t, vid, it.type && it.type !== 'Event' ? it.type.replace(/Event$/, '') : null, null, it.url, allDay ? (it.span ? 1 : 2) : 0]);
  }
  return out.sort((a, b) => a[2] - b[2]);
}
/** robots.txt: ist path für User-agent * erlaubt? (Allow vor Disallow bei gleicher oder größerer Länge; leeres Disallow = alles erlaubt) */
export function robotsAllowed(txt, path) {
  let on = false; const rules = [];
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, '').trim(), m = l.match(/^([\w-]+)\s*:\s*(.*)$/); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') on = v === '*'; else if (on && (k === 'allow' || k === 'disallow') && v) rules.push([k, v]);
  }
  let best = null; for (const [k, v] of rules) { const re = new RegExp('^' + v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')); if (re.test(path) && (!best || v.length > best[1].length || (v.length === best[1].length && k === 'allow'))) best = [k, v]; }
  return !best || best[0] === 'allow';
}
/** Zeilen → Einträge wie data/ereignisse.json (art veranstaltung, Gemeinde des Orts) für Orte ab modelMinCap, im Fenster [now − pastDays, now + aheadDays] */
export function venueEntries(rows, venues, { now, pastDays = SPORT.pastDays, aheadDays = 3, beforeMin = VENUES.beforeMin, afterMin = VENUES.afterMin, minCap = VENUES.modelMinCap } = {}) {
  const V = new Map((venues || []).map(v => [v.id, v])), out = [];
  for (const [id, name, t, vid, kind, , url, allDay] of rows || []) {
    const v = V.get(vid); if (!v?.ags || v.cap < minCap || !(t >= now - pastDays * 86400e3 && t <= now + aheadDays * 86400e3)) continue;
    if (!name || VENUE_JUNK.test(String(name).trim())) continue; // Reste der Programmseite („VVK ab“, „Tickets“) sind keine Veranstaltung
    // ohne Uhrzeit: mehrtägig (Messe, Turnier) tagsüber, einzelner Tag (Konzert, Show) abends
    const day = dayOf(t), [f0, f1] = allDay === 1 ? [VENUES.allDayFrom, VENUES.allDayTo] : [VENUES.noTimeFrom, VENUES.noTimeTo];
    const von = allDay ? `${day}T${pad2(f0)}:00` : localStamp(Math.floor((t - beforeMin * 60e3) / 3600e3) * 3600e3), bis = allDay ? `${day}T${pad2(f1)}:00` : localStamp(t + afterMin * 60e3);
    out.push({ art: 'veranstaltung', von, bis, gebiet: { ags: [v.ags] }, titel: `${name} (${v.name}, ${v.cap} Plätze${kind ? `, ${kind}` : ''})`.slice(0, 200), quelle: url, id, beginn: t, ganztags: allDay ? 1 : 0 });
  }
  return out;
}

/** Fehlende Wettertage (UTC) für die Ortstage der Ereignisdateien: je Ortstag D braucht die Prognose die UTC-Tage D−1 (23 Uhr) und D */
export function weatherBackfillDays(eventDays, haveDays, today, { maxDays = 23 } = {}) {
  const have = new Set(haveDays), need = new Set(), add = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
  const oldest = add(today, -maxDays);
  for (const d of eventDays) for (const u of [add(d, -1), d]) if (u >= oldest && u < add(today, -1) && !have.has(u)) need.add(u);
  return [...need].sort();
}

// ---------- Veranstaltungsliste fürs Dashboard (eine Liste aus Sport, Orten und gepflegter Liste) und gemessene Wirkung ----------
/** Ortszeit 'YYYY-MM-DDTHH:MM' (oder 'YYYY-MM-DD' = 0 Uhr) → UTC ms (Europe/Berlin, Sommer- und Winterzeit) */
export function localMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(String(s || '')); if (!m) return NaN;
  const want = `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}`, u = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  for (const off of [3600e3, 7200e3, 0]) if (localStamp(u - off) === want) return u - off;
  return u - 3600e3;
}
const ART_KIND = { 'streik-oepnv': 'strike', 'streik-bahn': 'rail', veranstaltung: 'event', volksfest: 'fest', sport: 'sport' };
/**
 * Alle Veranstaltungen und Ereignisse, die die Prognose kennt, als eine Liste: sport = sport.json, venues = veranstaltungen.json,
 * curated = Einträge aus data/ereignisse.json (geprüft). Zeitfenster wie in der Prognose (Sport: Anstoß − 60 bis + 180 Min.; Orte: VENUES).
 * Rückgabe [{ id, src: 'sport'|'ort'|'liste', art, ags: [..], laender: [..], all, von, bis, beginn (UTC ms), titel, ort, cap, kind, liga, quelle, noTime }], nach Beginn.
 */
export function eventList({ sport = null, venues = null, curated = [], now = Date.now(), pastDays = 8, aheadDays = 21 } = {}) {
  const lo = now - pastDays * 86400e3, hi = now + aheadDays * 86400e3, out = [];
  for (const e of sport?.entries || []) if (Number.isFinite(e.beginn) && e.beginn >= lo && e.beginn <= hi)
    out.push({ id: e.id, src: 'sport', art: 'sport', ags: e.gebiet?.ags || [], laender: [], all: false, von: e.von, bis: e.bis, beginn: e.beginn, titel: String(e.titel).replace(/ \((?:bl\d|del|dfb|ucl)[^)]*\)$/, ''), ort: '', cap: null, kind: 'sport', liga: e.liga || null, quelle: e.quelle, noTime: 0 });
  const rows = venues?.events || [], byId = new Map(rows.map(r => [r[0], r])), V = new Map((venues?.venues || []).map(v => [v.id, v]));
  for (const e of venueEntries(rows, venues?.venues || [], { now, pastDays, aheadDays, minCap: 0 })) {
    const r = byId.get(e.id), v = V.get(r?.[3]); if (!r || !v) continue;
    out.push({ id: e.id, src: 'ort', art: 'veranstaltung', ags: [v.ags], laender: [], all: false, von: e.von, bis: e.bis, beginn: e.beginn, titel: r[1], ort: v.name, cap: v.cap ?? null, kind: [r[4], r[5]].filter(Boolean).join(' · ') || null, liga: null, quelle: r[6] || null, noTime: r[7] || 0 });
  }
  for (const [i, e] of (curated || []).entries()) {
    const b = localMs(e.von), bis = String(e.bis ?? e.von), end = localMs(bis.length === 10 ? `${bis}T23:59` : bis); if (!Number.isFinite(b) || end < lo || b > hi) continue;
    const g = e.gebiet, timed = String(e.von).length > 10;
    out.push({ id: e.id || `liste:${i}`, src: 'liste', art: e.art, ags: g?.ags || [], laender: g?.laender || [], all: g === 'DE', von: String(e.von).length === 10 ? `${e.von}T00:00` : e.von, bis: bis.length === 10 ? `${bis}T23:59` : bis, beginn: Number.isFinite(localMs(e.beginn)) ? localMs(e.beginn) : b,
      titel: e.titel || e.art, ort: e.ort || '', cap: Number.isFinite(e.besucher) ? e.besucher : null, kind: e.kategorie || (ART_KIND[e.art] === 'event' ? null : e.art), liga: null, quelle: e.quelle, noTime: e.ohneUhrzeit ? 2 : timed ? 0 : 1, ...(e.auto ? { auto: true } : {}) });
  }
  // gleiche Veranstaltung aus zwei Quellen (Liste und Programmseite): Liste gewinnt, wenn Gemeinde, Tag und Name übereinstimmen
  const key = (e) => `${e.ags[0] || ''}|${e.von.slice(0, 10)}|${norm(e.titel).replace(/[^a-z0-9]/g, '').slice(0, 12)}`, seen = new Set(out.filter(e => e.src === 'liste').map(key));
  const res = out.filter(e => e.src === 'liste' || !seen.has(key(e))).sort((a, b) => a.beginn - b.beginn || a.titel.localeCompare(b.titel));
  for (const e of res) e.endMs = localMs(e.bis); // einmal je Eintrag statt bei jedem Filter (Audit OPS-03)
  return res;
}
/** Liegt die Veranstaltung im Gebiet ags (null/'DE' = überall)? */
export const eventInScope = (e, ags) => !ags || ags === 'DE' || e.all || e.ags.includes(ags) || e.laender.includes(LAND_OF_AGS[String(ags).slice(0, 2)]);
/**
 * Gemessene Wirkung einer vergangenen Veranstaltung: Fahrtbeginne (Ist) gegen den am Morgen eingefrorenen Plan in den Stunden des Zeitfensters,
 * bereinigt um die Abweichung in den übrigen Stunden derselben Tage (sonst würde ein ohnehin schlecht geplanter Tag als Wirkung gelten).
 * days = series.days, key = Reihe (z. B. 'ags:08111000'). Rückgabe { ist, plan, hours, rel, rest, uplift } oder null (zu wenig Stunden mit Ist und Plan).
 */
export function eventEffect(days, key, e) {
  const from = e.von.slice(0, 13), to = e.bis; let ist = 0, plan = 0, n = 0, iR = 0, pR = 0, nR = 0;
  const d0 = e.von.slice(0, 10), d1 = e.bis.slice(0, 10);
  for (const [day, entry] of Object.entries(days || {})) {
    if (day < d0 || day > d1) continue; const s = entry?.[key]; if (!s?.a || !s?.p) continue;
    for (let h = 0; h < 24; h++) {
      const a = s.a[h], p = s.p[h]; if (a == null || p == null) continue;
      const st = `${day}T${String(h).padStart(2, '0')}`;
      if (st >= from && `${st}:00` < to) { ist += a; plan += p; n++; } else { iR += a; pR += p; nR++; }
    }
  }
  if (!n || !(plan > 0)) return null;
  const rel = ist / plan - 1, rest = nR >= 4 && pR > 0 ? iR / pR - 1 : null;
  return { ist: Math.round(ist), plan: Math.round(plan), hours: n, rel, rest, uplift: rest == null ? rel : (1 + rel) / (1 + rest) - 1 };
}

// ---------- Baustellen und Sperrungen in Städten (Merkmal „works“, nur gesammelt) ----------
// Offene Quellen ohne Konto (Recherche 11.11.2026): MobiData BW (Bundes-, Landes-, Kreisstraßen in BW, WGS84), Hamburg (WFS, EPSG:25832),
// München (WFS, 4 Wochen, EPSG:25832), alle dl-de/by-2.0. Gezählt werden nur Vollsperrungen, die vor höchstens WORKS.freshDays Tagen begonnen
// haben (Dauerbaustellen sind je Gemeinde konstant und für das Modell wertlos, vgl. ROAD_FRESH). Eintrag in incidents/<Tag>.json → ags[].works
// (Zahl je Ortsstunde). Nicht in CTX_KEYS: wirkt nicht auf die Prognose, liegt im Trainingsarchiv (Lernphase bis 28.11.2026).
export const WORKS = { freshDays: 7, maxPerAgs: 9 };
export const WORKS_SOURCES = [
  { id: 'mobidata_bw', name: 'MobiData BW (Baustellen BEMaS)', url: 'https://api.mobidata-bw.de/datasets/traffic/roadworks/roadworks_geojson.json', license: 'dl-de/by-2.0',
    closed: (p) => p?.type === 'ROAD_CLOSED', start: (p) => p?.starttime, end: (p) => p?.endtime },
  { id: 'hamburg', name: 'Freie und Hansestadt Hamburg, Behörde für Verkehr und Mobilitätswende (Baustellen)', url: 'https://geodienste.hamburg.de/hh_wfs_baustellen?service=WFS&version=2.0.0&request=GetFeature&typeNames=de.hh.up:baustelle&outputFormat=application/geo%2Bjson', license: 'dl-de/by-2.0',
    closed: (p) => /vollsperr/i.test(Object.values(p || {}).filter(v => typeof v === 'string').join(' ')), start: (p) => p?.baubeginn, end: (p) => p?.bauende },
  { id: 'muenchen', name: 'Landeshauptstadt München (Baustellen, 4 Wochen)', url: 'https://geoportal.muenchen.de/geoserver/mor_wfs/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=mor_wfs:baustellen_opendata&outputFormat=application/json', license: 'dl-de/by-2.0',
    closed: (p) => /vollsperr/i.test(String(p?.beeintraechtigung ?? '')) || /vollsperr/i.test(String(p?.beeintraechtigung_text ?? '')), start: (p) => p?.beginn_datum_kombiniert ?? p?.beginn_datum, end: (p) => p?.ende_datum_kombiniert ?? p?.ende_datum },
];
/** Datum aus ISO, „TT.MM.JJJJ [hh:mm]“ oder Millisekunden → ms (ohne Uhrzeit: Ortsmitternacht) oder NaN */
export function parseWhen(v) {
  if (v == null || v === '') return NaN; if (typeof v === 'number') return v > 1e11 ? v : NaN;
  const s = String(v).trim(), de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2}))?/);
  if (de) return berlinUtc(`${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}`, +(de[4] || 0), +(de[5] || 0));
  if (/^\d{4}-\d{2}-\d{2}Z?$/.test(s)) return berlinUtc(s.slice(0, 10), 0, 0);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return berlinUtc(s.slice(0, 10), +s.slice(11, 13), +s.slice(14, 16));
  return Date.parse(s);
}
/** ETRS89/UTM Zone 32N (EPSG:25832) → [lon, lat] (WGS84, Abweichung < 1 m) */
export function utm32ToLonLat(E, N) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2), lon0 = 9 * Math.PI / 180;
  const x = E - 500000, M = N / k0, mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256)), e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2, N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), R1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, D = x / (N1 * k0);
  const lat = p1 - (N1 * Math.tan(p1) / R1) * (D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5 / 120) / Math.cos(p1);
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}
/** Bezugspunkt einer Geometrie (mittlerer Stützpunkt bzw. Mittel des Rings) als [lon, lat]; UTM-Koordinaten werden umgerechnet */
export function geomPoint(g) {
  if (!g?.coordinates) return null; let pts = [];
  const flat = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(flat));
  if (g.type === 'Point') pts = [g.coordinates]; else if (g.type === 'LineString' || g.type === 'MultiPoint') pts = [g.coordinates[Math.floor(g.coordinates.length / 2)]];
  else if (g.type === 'Polygon' || g.type === 'MultiLineString') pts = flat(g.coordinates[0] || []); else if (g.type === 'MultiPolygon') pts = flat(g.coordinates[0]?.[0] || []);
  pts = pts.filter(p => Number.isFinite(+p?.[0]) && Number.isFinite(+p?.[1])); if (!pts.length) return null;
  const x = pts.reduce((s, p) => s + +p[0], 0) / pts.length, y = pts.reduce((s, p) => s + +p[1], 0) / pts.length;
  return Math.abs(x) > 1000 ? utm32ToLonLat(x, y) : [x, y];
}
/** GeoJSON einer Quelle → frische, laufende Vollsperrungen [{ lon, lat }] und Zählung */
export function worksItems(src, geojson, now, { freshDays = WORKS.freshDays } = {}) {
  const out = [], stat = { features: 0, closed: 0, active: 0, fresh: 0 };
  for (const f of Array.isArray(geojson?.features) ? geojson.features : []) {
    stat.features++; const p = f?.properties || {}; if (!src.closed(p)) continue; stat.closed++;
    const s = parseWhen(src.start(p)), e = parseWhen(src.end(p)); if (!Number.isFinite(s) || s > now || (Number.isFinite(e) && e < now)) continue; stat.active++;
    if (now - s > freshDays * 86400e3) continue; const pt = geomPoint(f.geometry); if (!pt) continue; stat.fresh++; out.push({ lon: pt[0], lat: pt[1] });
  }
  return { items: out, stat };
}
/** Zur aktuellen Ortsstunde eintragen: Zahl frischer Vollsperrungen je Gemeinde (höchstens WORKS.maxPerAgs) */
export function addWorks(docs, items, locate, now) {
  const day = dayOf(now), h = hourOf(now); let doc = docs.get(day); if (!doc) docs.set(day, doc = emptyIncidentDoc(day));
  const by = new Map(); for (const it of items || []) { const ags = locate(it.lat, it.lon); if (ags) by.set(ags, (by.get(ags) || 0) + 1); }
  for (const [ags, n] of by) slot(doc, ags, 'works')[h] = Math.min(WORKS.maxPerAgs, n);
  return by.size;
}
