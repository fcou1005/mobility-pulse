// @ts-check
// Termine aus Quellenseiten (seit 08.11.2026): Workflow „Termine“ (scripts/termine.mjs, wöchentlich) liest die offiziellen Seiten aus
// data/termin-quellen.json (Volksfeste, Messekalender, Stadien/Arenen, Läufe, Stadtfeste, Karneval) und zieht künftige Termine heraus –
// zuerst mit Regeln (schema.org-Event, Kalender-Blöcke), sonst mit einem kleinen lokalen Sprachmodell (llama.cpp im Workflow, kein Konto,
// kein Schlüssel). Schutz gegen Erfundenes: das Modell muss den Datumstext wörtlich aus der Seite übernehmen; Tag und Monat aus dem Text
// müssen zu Beginn und Ende passen. Danach dieselben Prüfungen wie für die Recherche (scripts/ereignisse-merge.mjs): Gemeinde, Dauer,
// keine Weihnachtsmärkte, nichts Abgesagtes; Zeitfenster wie Sport/Hallen. Ergebnis: termine.json im Branch termine, Einträge wie
// data/ereignisse.json (art veranstaltung | volksfest); der Sammler liest sie wie chronos.json (TERMINE_URL).
import { htmlTree, textOf, htmlEvents, parseDateText, icsEvents } from './pulse-context.js';
import { dayOf } from './pulse-track.js';

export const TERMINE = {
  version: 1, aheadDays: 450, keepDays: 60, maxChars: 14000, chunkChars: 3800, maxChunks: 4, maxPerSource: 60, maxTokens: 1600,
  model: 'Qwen3-4B-Instruct-2507 (Q4_K_M, Apache 2.0) über llama.cpp, lokal im Workflow',
  arten: ['volksfest', 'messe', 'konzert', 'sport', 'lauf', 'fest', 'karneval'],
};
export const NO_EVENT = /weihnachtsmarkt|christkindl|wintertraum|eiswelt|winterzauber|weihnachtszirkus|weihnachtscircus|lichterzauber|winterwelt|eislaufbahn|adventsmarkt|ausstellung|führung|museum/i;
export const GONE = /abgesagt|entfällt|verschoben|ausgefallen|cancelled|canceled|postponed/i;
const DAY_LONG = new Set(['messe', 'fest', 'karneval', 'lauf', 'volksfest']);
const MONTHS = { januar: 1, jan: 1, februar: 2, feb: 2, märz: 3, maerz: 3, mär: 3, april: 4, apr: 4, mai: 5, juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12,
  // englische Seiten (Messen, Läufe, Tourismus)
  january: 1, february: 2, march: 3, mar: 3, may: 5, june: 6, july: 7, october: 10, oct: 10, december: 12, dec: 12 };
const MON = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const DATE_RE = new RegExp(`\\d{1,2}\\.\\s?\\d{1,2}\\.(?:\\s?\\d{2,4})?|\\d{1,2}(?:\\.|st|nd|rd|th)?\\s?(?:${MON})\\b|\\b(?:${MON})\\.?\\s(?:\\d{1,2}\\b|20\\d{2})|\\d{4}-\\d{2}-\\d{2}`, 'i');
const pad = (n) => String(n).padStart(2, '0');
export const addDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const days = (a, b) => { const o = []; for (let d = a, k = 0; d <= b && k < 62; d = addDay(d, 1), k++) o.push(d); return o; };
export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '');
const flat = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[–—‑]/g, '-').trim().toLowerCase();
export const sourceId = (q) => q.id || `${norm(q.name).slice(0, 40)}-${q.ags}`;
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); };

/** Quellen (data/termin-quellen.json → quellen) prüfen: Name, https-Adresse, AGS (8 Ziffern), bekannte Art; Rückgabe { ok, bad } */
export function checkSources(doc) {
  const ok = [], bad = [], seen = new Set();
  for (const [i, q] of (Array.isArray(doc?.quellen) ? doc.quellen : []).entries()) {
    const why = [];
    if (!q?.name) why.push('Name'); if (!/^https:\/\/|^http:\/\/(?:127\.0\.0\.1|localhost)[:/]/.test(q?.url || '')) why.push('Adresse'); /* http nur lokal (Tests) */ if (!/^\d{8}$/.test(q?.ags || '')) why.push('AGS'); if (!TERMINE.arten.includes(q?.art)) why.push(`Art „${q?.art}“`);
    const id = q && sourceId(q); if (id && seen.has(id)) why.push('doppelt');
    if (why.length) { bad.push(`#${i} ${q?.name || ''}: ${why.join(', ')}`); continue; }
    seen.add(id); ok.push({ ...q, id });
  }
  return { ok, bad };
}

/** HTML → Textzeilen (Blöcke als Zeilen; Skripte, Stile, Navigation, Formulare und Fußzeile weg) */
export function pageLines(html) {
  const tree = htmlTree(String(html || '')), lines = [], BLOCK = /^(p|div|li|h[1-6]|tr|td|th|section|article|header|dd|dt|dl|ul|ol|table|time|span|a|strong|b|em|br|main|aside|figure|figcaption)$/;
  const SKIP = /^(script|style|noscript|nav|footer|form|svg|button|select|option|iframe|template)$/;
  let cur = '';
  const flush = () => { const t = cur.replace(/\s+/g, ' ').trim(); if (t) lines.push(t); cur = ''; };
  const go = (n) => {
    if (typeof n === 'string') { cur += ` ${textOf(n)}`; return; }
    if (n.raw || SKIP.test(n.tag)) return;
    const block = BLOCK.test(n.tag) && !/^(span|a|strong|b|em|time)$/.test(n.tag);
    if (block || n.tag === 'br') flush();
    for (const c of n.children) go(c);
    if (block) flush();
  };
  go(tree); flush();
  // gleiche Zeilen (Menüs, Wiederholungen) nur einmal
  const seen = new Set(); return lines.filter(l => { const k = l.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Ausschnitte mit Datumsangaben (je Datumszeile ±2 Zeilen Umfeld), höchstens maxChars, in Stücken zu chunkChars */
export function dateChunks(lines, { maxChars = TERMINE.maxChars, chunkChars = TERMINE.chunkChars, maxChunks = TERMINE.maxChunks } = {}) {
  const keep = new Set(); lines.forEach((l, i) => { if (DATE_RE.test(l)) for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < lines.length) keep.add(k); });
  const out = []; let cur = '', total = 0, last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const l = lines[i].slice(0, 400), add = (i !== last + 1 && cur ? '…\n' : '') + l + '\n'; last = i;
    if (total + add.length > maxChars) break;
    if (cur.length + add.length > chunkChars && cur) { out.push(cur); cur = ''; if (out.length >= maxChunks) break; }
    cur += add; total += add.length;
  }
  if (cur && out.length < maxChunks) out.push(cur);
  return out;
}

/** JSON-Schema der Modell-Antwort (llama-server: response_format json_schema → Grammatik, die Antwort ist sicher gültiges JSON) */
export const TERMIN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['termine'],
  properties: { termine: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['titel', 'datumText', 'beginn', 'ende', 'uhrVon', 'uhrBis', 'abgesagt'],
    properties: { titel: { type: 'string' }, datumText: { type: 'string' }, beginn: { type: 'string' }, ende: { type: 'string' }, uhrVon: { type: 'string' }, uhrBis: { type: 'string' }, abgesagt: { type: 'boolean' } } } } },
};
const ART_TEXT = { volksfest: 'Volksfest/Kirmes', messe: 'Messe', konzert: 'Konzert, Show oder Sportveranstaltung', sport: 'Sportveranstaltung', lauf: 'Lauf oder Radrennen', fest: 'Stadtfest, Umzug oder Fest', karneval: 'Karnevals- bzw. Fastnachtsveranstaltung (Umzug, Straßenkarneval, Sitzung)' };
/** Nachrichten an das Sprachmodell für einen Ausschnitt einer Quelle */
export function llmMessages(q, chunk, today) {
  const sys = 'Du liest Ausschnitte deutscher Veranstaltungsseiten und gibst künftige Termine als JSON zurück. Erfinde nichts: jeder Termin muss im Text stehen. ' +
    '„datumText“ ist die Datumsangabe genau so, wie sie im Text steht (z. B. „25.09. – 11.10.2027“ oder „Samstag, 14. März 2027“). beginn und ende als JJJJ-MM-TT (ende = beginn bei einem Tag); ' +
    'fehlt das Jahr im Text, nimm das nächste Vorkommen ab heute. uhrVon/uhrBis als HH:MM, sonst leer. abgesagt = true, wenn der Termin als abgesagt oder verschoben bezeichnet wird. ' +
    'Keine vergangenen Termine, keine Vorverkaufs-, Anmelde- oder Bewerbungsfristen, keine Öffnungszeiten ohne Datum. Keine Termine → {"termine": []}.';
  const user = `Heute: ${today}\nQuelle: ${q.name}${q.ort ? ` (${q.ort})` : ''}, Art: ${ART_TEXT[q.art] || q.art}\n` +
    (q.art === 'volksfest' || q.art === 'lauf' || q.art === 'karneval' || q.art === 'fest' ? 'Gesucht: die nächsten Termine dieser Veranstaltung (je Ausgabe ein Termin mit Anfang und Ende).\n' : 'Gesucht: alle einzelnen Veranstaltungen mit Datum (Titel ohne Datum und Ort).\n') +
    `Text:\n${chunk}`;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

/** Antwort des Modells → Termine; bei abgeschnittener Antwort (Grenze der Ausgabelänge) die vollständigen Termine davor retten */
export function parseLlm(txt) {
  const s = String(txt || ''), a = s.indexOf('{');
  try { return JSON.parse(s.slice(a, s.lastIndexOf('}') + 1))?.termine || []; } catch {}
  const i = s.indexOf('['); if (i < 0) return [];
  for (let k = s.lastIndexOf('}'); k > i; k = s.lastIndexOf('}', k - 1)) { try { const arr = JSON.parse(`${s.slice(i, k + 1)}]`); if (Array.isArray(arr)) return arr.filter(x => x && typeof x === 'object'); } catch {} }
  return [];
}

/** Tag/Monat(/Jahr)-Angaben eines Datumstexts: [{ d, m, y }] (auch „25.09.–11.10.2027“, „14. März“, „5./6. Juni“) */
export function datePartsOf(s, { fill = true } = {}) {
  const t = flat(s), out = [];
  for (const m of t.matchAll(/(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2}(?!\d)))?/g)) out.push({ d: +m[1], m: +m[2], y: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null });
  for (const m of t.matchAll(new RegExp(`(\\d{1,2})(?:\\.|st|nd|rd|th)?\\s?(?:of\\s)?(${MON})\\b\\.?,?(?:\\s?(\\d{4}))?`, 'g'))) out.push({ d: +m[1], m: MONTHS[m[2]], y: m[3] ? +m[3] : null });
  // englisch: „September 24 – October 10, 2027“, „April 25, 2027“, „May 6-9, 2027“
  for (const m of t.matchAll(new RegExp(`\\b(${MON})\\.?\\s(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s?(?:-|to|and|&)\\s?(\\d{1,2})(?:st|nd|rd|th)?\\b)?,?(?:\\s?(\\d{4}))?`, 'g'))) { const mo = MONTHS[m[1]], y = m[4] ? +m[4] : null; out.push({ d: +m[2], m: mo, y }); if (m[3]) out.push({ d: +m[3], m: mo, y }); }
  // „5./6. Juni“, „5. bis 7. Juni“, „5.–7. Juni“: Tag ohne Monat vor einer Angabe mit Monat
  for (const m of t.matchAll(new RegExp(`(?<!\\d\\.\\s?)(?<!\\d)(\\d{1,2})\\.\\s?(?:/|-|bis|und)\\s?(\\d{1,2})\\.?\\s?(${MON}|\\d{1,2}\\.)`, 'g'))) { const mo = MONTHS[m[3]] || +String(m[3]).replace('.', ''); if (mo) out.push({ d: +m[1], m: mo, y: null }); }
  for (const m of t.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) out.push({ d: +m[3], m: +m[2], y: +m[1] });
  if (!fill) return out;
  const years = out.map(x => x.y).filter(Boolean); return out.map(x => ({ ...x, y: x.y ?? (years.length ? Math.max(...years) : null) }));
}

/**
 * Termin des Modells prüfen: Datumstext wörtlich im Ausschnitt, Beginn/Ende passen zu Tag und Monat (und Jahr, falls genannt) des Texts, im Fenster
 * [heute, heute + aheadDays], Dauer ≤ 31 Tage (Volksfest) bzw. ≤ 10 Tage, nicht abgesagt, kein Weihnachtsmarkt. Rückgabe { ok, why }.
 */
export function checkTermin(t, q, chunk, today, { aheadDays = TERMINE.aheadDays } = {}) {
  const iso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
  const titel = String(t?.titel || '').trim(), dt = String(t?.datumText || '').trim(), b = String(t?.beginn || ''), e = String(t?.ende || t?.beginn || '');
  if (q.stichwortNicht && new RegExp(q.stichwortNicht, 'i').test(titel)) return { ok: false, why: 'ausgeschlossen (stichwortNicht)' };
  if (!titel || titel.length < 3 || JUNK_TITLE.test(titel.replace(/[^\p{L}& ]/gu, ' ').replace(/\s+/g, ' ').trim())) return { ok: false, why: 'Titel' };
  if (!iso(b) || !iso(e) || e < b) return { ok: false, why: 'Datum' };
  if (chunk != null) { // vom Modell (Regeln/schema.org: chunk = null)
    // (1) Datumstext wörtlich im Ausschnitt → Tag/Monat/Jahr daraus müssen zu Beginn und Ende passen; (2) sonst (Modelle schreiben Datumsangaben oft um:
    // „24.09.–10.10.2027“ → „24. September bis 10. Oktober 2027“) müssen Beginn und Ende als Datum im Ausschnitt stehen (Tag und Monat; ein dort genanntes
    // Jahr muss passen). Ein Datum, das nirgends im Text steht, fällt in beiden Fällen weg.
    const verbatim = !!dt && flat(chunk).includes(flat(dt)), parts = verbatim ? datePartsOf(dt) : datePartsOf(chunk, { fill: false });
    const has = (day) => parts.some(p => p.d === +day.slice(8, 10) && p.m === +day.slice(5, 7) && (!p.y || p.y === +day.slice(0, 4)));
    if (!has(b) || (e !== b && !has(e))) return { ok: false, why: verbatim ? 'Datum passt nicht zum Datumstext' : 'Datum nicht im Text' };
  }
  if (e < today || b > addDay(today, aheadDays)) return { ok: false, why: 'außerhalb' };
  const n = days(b, e).length; if (n > (q.art === 'volksfest' ? 31 : 10)) return { ok: false, why: `${n} Tage` };
  if (t.abgesagt || GONE.test(`${titel} ${dt}`)) return { ok: false, why: 'abgesagt' };
  if (NO_EVENT.test(titel)) return { ok: false, why: 'kein Ereignis (Weihnachtsmarkt, Ausstellung …)' };
  return { ok: true };
}

const isT = (s) => /^\d{2}:\d{2}$/.test(String(s || '')) && +s.slice(0, 2) < 24 && +s.slice(3) < 60;
const addMin = (day, hhmm, min) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, m) + min * 60e3); return `${d.toISOString().slice(0, 10)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
/**
 * Termin → Einträge wie data/ereignisse.json, je Tag einer (Zeitfenster wie scripts/ereignisse-merge.mjs: mit Uhrzeit Beginn − 60 Min. bis Ende + 60 Min.
 * bzw. Beginn + 3 Std.; mehrtägige/ganztägige Arten ohne Ende bis 22 Uhr; ohne Uhrzeit Volksfest 11–23, Messe/Fest/Lauf/Karneval 10–22, sonst 17–23).
 */
export function terminEntries(t, q, { stand = undefined, via = 'modell', from = null } = {}) {
  const out = [], kat = q.art, dayLong = DAY_LONG.has(kat), fest = kat === 'volksfest';
  for (const d of days(t.beginn, t.ende || t.beginn)) {
    if (from && d < from) continue;
    let von, bis, beginn; const uv = isT(t.uhrVon) ? t.uhrVon : null, ub = isT(t.uhrBis) ? t.uhrBis : null;
    if (uv) { beginn = `${d}T${uv}`; von = `${addMin(d, uv, -60).slice(0, 13)}:00`; bis = ub ? addMin(d, ub, (ub < uv ? 24 * 60 : 0) + 60) : addMin(d, uv, 180); if (!ub && dayLong && bis < `${d}T22:00`) bis = `${d}T22:00`; }
    else if (fest) { beginn = `${d}T11:00`; von = `${d}T11:00`; bis = `${d}T23:00`; }
    else if (dayLong) { beginn = `${d}T10:00`; von = `${d}T10:00`; bis = `${d}T22:00`; }
    else { beginn = `${d}T17:00`; von = `${d}T17:00`; bis = `${d}T23:00`; }
    const titel = String(t.titel).replace(/\s+/g, ' ').trim().slice(0, 160);
    out.push({ art: fest ? 'volksfest' : 'veranstaltung', von, bis, beginn, ...(uv ? {} : { ohneUhrzeit: true }), gebiet: { ags: [q.ags] }, titel, ort: q.ort || null, besucher: Number.isFinite(q.besucher) ? q.besucher : null,
      kategorie: kat, quelle: t.url && /^https:\/\//.test(t.url) ? t.url : q.url, id: `termin:${hash(`${q.ags}|${d}|${norm(titel)}`)}`, quelleId: q.id, stand: stand || null, via, auto: true });
  }
  return out;
}

/** schema.org-Events (JSON-LD) mit Ende und Status → [{ titel, beginn, ende, uhrVon, uhrBis, abgesagt, url, ort }] */
export function ldTermine(html, baseUrl) {
  const out = [], flatLd = (x) => (Array.isArray(x) ? x.flatMap(flatLd) : x && typeof x === 'object' ? [x, ...flatLd(x['@graph'] || []), ...flatLd((x.itemListElement || []).map(i => i?.item || i)), ...flatLd(x.subEvent || [])] : []);
  for (const m of String(html || '').matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j; try { j = JSON.parse(m[1].trim()); } catch { continue; }
    for (const e of flatLd(j)) {
      if (!/Event$/.test(String([].concat(e['@type'] || '')[0] || ''))) continue;
      const st = String(e.startDate || '').trim().replace(' ', 'T'), en = String(e.endDate || '').trim().replace(' ', 'T'); if (!/^\d{4}-\d{2}-\d{2}/.test(st)) continue;
      const tm = (s) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/T00:00(:00)?(\.0+)?(Z|[+-]00:?00)?$/.test(s) ? s.slice(11, 16) : '');
      let url = null; try { url = typeof e.url === 'string' ? new URL(e.url, baseUrl).href : null; } catch {}
      out.push({ titel: String(e.name || '').replace(/\s+/g, ' ').trim().slice(0, 160), beginn: st.slice(0, 10), ende: /^\d{4}-\d{2}-\d{2}/.test(en) && en.slice(0, 10) >= st.slice(0, 10) ? en.slice(0, 10) : st.slice(0, 10),
        uhrVon: tm(st), uhrBis: en.slice(0, 10) === st.slice(0, 10) ? tm(en) : '', abgesagt: /Cancelled|Postponed/i.test(String(e.eventStatus || '')), url, ort: String(e.location?.name || [].concat(e.location || [])[0]?.name || '') });
    }
  }
  return out;
}

/**
 * Regeln vor dem Modell: (1) schema.org-Events, (2) bei Programm- und Messekalendern (konzert, sport, messe) Datum neben Link wie bei den Hallen (ab 3 Terminen),
 * (3) ICS. Rückgabe [{ titel, beginn, ende, uhrVon, uhrBis, abgesagt, url }] oder [] (dann liest das Modell).
 */
export function ruleTermine(body, q) {
  if (q.format === 'ics' || /^BEGIN:VCALENDAR/m.test(String(body).slice(0, 200))) return icsEvents(body).map(e => ({ titel: e.name || '', beginn: e.start.slice(0, 10), ende: e.start.slice(0, 10), uhrVon: e.start.length > 10 && !e.utc ? e.start.slice(11, 16) : '', uhrBis: '', abgesagt: false, url: e.url || null }));
  const ld = ldTermine(body, q.url).map(t => ({ ...t, titel: cleanTitle(t.titel, q) })).filter(t => !elsewhere(`${t.titel} ${t.ort || ''}`, q)); if (ld.length) return ld;
  if (q.art === 'konzert' || q.art === 'sport' || q.art === 'messe') { // Programm- und Messekalender: Liste aus Datum und Link (schneller und sicherer als das Modell)
    const ev = htmlEvents(htmlTree(body), q.url, { link: q.link || null }).filter(e => e.days.length <= 10);
    if (ev.length >= 3) return ev.filter(e => !elsewhere(`${e.name} ${e.text || ''}`, q)).map(e => ({ titel: cleanTitle(e.name, q), beginn: e.days[0], ende: e.days[e.days.length - 1], uhrVon: e.time && e.days.length === 1 ? e.time : '', uhrBis: '', abgesagt: GONE.test(e.text || ''), url: e.url }));
  }
  return [];
}

// Reste der Seite statt eines Namens („Mehr erfahren“, „Termin speichern“ …) – solche Termine fallen weg (meist steht derselbe Termin mit Namen daneben)
export const JUNK_TITLE = /^(mehr( erfahren| infos?)?|more( info)?|read more|infos?|info &|infos &|kontakt(daten)?|aktuelle veranstaltungen|nächste termine|alle termine|termine?( und)?|termin speichern|website öffnen|webseite|veranstalter|music|musik|sports?|tickets?( &( infos?)?)?|details?|weiterlesen|merken|zum event|zur veranstaltung|programm|am um|von bis|ausverkauft|abgesagt|neu|highlight|vorschau|kalender)$/i;
const CITY_WORDS = ['berlin', 'hamburg', 'münchen', 'köln', 'frankfurt', 'stuttgart', 'düsseldorf', 'leipzig', 'dortmund', 'bremen', 'dresden', 'hannover', 'nürnberg', 'duisburg', 'bochum', 'wuppertal', 'bielefeld', 'bonn', 'münster', 'mannheim', 'karlsruhe', 'augsburg', 'wiesbaden', 'freiburg', 'kassel', 'offenburg', 'magdeburg', 'kiel', 'rostock', 'friedrichshafen', 'sindelfingen'];
const FOREIGN = /\b(schweiz|österreich|türkiye|türkei|turkey|china|shanghai|peking|beijing|shenzhen|guangzhou|indien|india|bangalore|mumbai|delhi|dubai|singapur|singapore|asia|asien|americas|usa|brasil|brazil|mexico|mexiko|afrika|africa|italien|italy|spanien|spain|frankreich|france|polen|poland|griechenland|greece|athen|athens|bern|wien|vienna|zürich|basel|tokio|tokyo|korea|thailand|bangkok|vietnam|indonesien|indonesia|australien|australia|kanada|canada|saudi|riyadh|abu dhabi|katar|qatar|istanbul|moskau|kairo|cairo|nigeria|kenia|südafrika|johannesburg|marokko|chile|kolumbien|peru|argentinien)\b/i;
const short = (n) => String(n || '').split(/\s*[/(,]\s*|\s+(?:am|im|an der|in der|ob der|bei|b\.)\s+/)[0].trim().toLowerCase();
/** Findet die Veranstaltung woanders statt (Messekalender führen auch Auslands- und Gastmessen in anderen Städten)? Nur für Messe-Quellen. */
export function elsewhere(text, q) {
  if (q.art !== 'messe') return false;
  // eigene Orte: Gemeinde der Quelle und Städte im Namen der Quelle („Messe Stuttgart“ liegt in Leinfelden-Echterdingen)
  const t = String(text || '').toLowerCase(), qn = String(q.name || '').toLowerCase(), own = [short(q.gemeinde || q.ort || ''), ...CITY_WORDS.filter(c => qn.includes(c))].filter(Boolean);
  const mine = own.some(o => t.includes(o));
  if (FOREIGN.test(t)) return true; // Auslandsmessen nennen oft auch den Veranstalter („NürnbergMesse“) – Ausland gilt immer als woanders
  return CITY_WORDS.some(c => !own.includes(c) && new RegExp(`(?<![\\wäöüß])${c}(?![\\wäöüß])`).test(t)) && !mine;
}
/** Name bereinigen: Datum, Ortsangaben der Seite („location_on …, Deutschland“), „Merken“, Stadtname der Quelle vorn */
export function cleanTitle(s, q = {}) {
  let t = ` ${String(s || '')} `.replace(/[[\]]/g, ' ').replace(/location_on\s+[^,]{1,40},\s*[A-ZÄÖÜ][\wäöüß]+/g, ' ')
    .replace(/\b(merken|termin speichern|website öffnen|tickets? sichern)\b/gi, ' ')
    .replace(new RegExp(`\\d{1,2}\\.\\s?(?:\\d{1,2}\\.|${MON})?\\s?(?:20\\d{2})?\\s*(?:[-–—]|bis)\\s*\\d{1,2}\\.\\s?(?:\\d{1,2}\\.|${MON})\\s?(?:20\\d{2})?`, 'gi'), ' ')
    .replace(new RegExp(`(?:^|\\s)\\d{1,2}\\.\\s?(?:\\d{1,2}\\.|${MON})?\\s?(?:20\\d{2})?(?:\\s*[-–—])?(?=\\s)`, 'gi'), ' ')
    .replace(/\s+/g, ' ').trim();
  const own = short(q.gemeinde || ''); if (own) t = t.replace(new RegExp(`^${own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+am\\s+\\S+)?\\s+`, 'i'), '');
  return t.replace(/^[\s,.:;–—-]+|[\s,.:;–—-]+$/g, '').trim();
}

/**
 * Ohne Sprachmodell (Test, Ausfall): einfache Textregel für Seiten einer einzelnen Veranstaltung (Volksfest, Lauf, Fest, Karneval) – erste Zeile mit
 * Name/Stichwort und Datum; Spannen („17. April bis 9. Mai 2027“, „25.09. – 11.10.2027“) als Beginn–Ende. Liefert höchstens einen Termin.
 */
export function textTermin(lines, q, today) {
  const keys = [q.stichwort, ...String(q.name).split(/\s+/).filter(w => w.length >= 5)].filter(Boolean).map(s => s.toLowerCase());
  for (const l of lines) {
    if (!keys.some(k => l.toLowerCase().includes(k))) continue;
    const parts = datePartsOf(l).filter(p => p.y && p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= 31).map(p => `${p.y}-${pad(p.m)}-${pad(p.d)}`).filter(d => !Number.isNaN(Date.parse(`${d}T12:00:00Z`))).sort();
    if (!parts.length) continue;
    const range = /[-–—]|\bbis\b|\bto\b/.test(l) && parts.length >= 2, b = parts[0], e = range ? parts[parts.length - 1] : parts[0];
    if (e < today || days(b, e).length > (q.art === 'volksfest' ? 31 : 10)) continue;
    const p = parseDateText(l);
    return [{ titel: q.name, datumText: l, beginn: b, ende: e, uhrVon: b === e && p?.time ? p.time : '', uhrBis: '', abgesagt: GONE.test(l) }];
  }
  return [];
}

/**
 * Lauf zusammenführen: prev = bisherige termine.json, res = [{ q, ok, entries }] dieses Laufs. Quellen mit neuen Terminen ersetzen ihre künftigen
 * Einträge (ab heute); Quellen ohne Antwort oder ohne Termine behalten die bisherigen; Vergangenes bleibt keepDays Tage (Training, Gedächtnis).
 */
export function mergeTermine(prev, res, { now = Date.now(), keepDays = TERMINE.keepDays } = {}) {
  const today = dayOf(now), cut = addDay(today, -keepDays), fresh = new Map(res.filter(r => r.ok && r.entries.length).map(r => [r.q.id, r.entries]));
  const kept = (prev?.termine || []).filter(e => String(e.bis).slice(0, 10) >= cut && !(fresh.has(e.quelleId) && String(e.von).slice(0, 10) >= today));
  const all = new Map(); for (const e of [...kept, ...[...fresh.values()].flat()]) all.set(e.id, e);
  return [...all.values()].sort((a, b) => String(a.von).localeCompare(String(b.von)) || a.id.localeCompare(b.id));
}

/**
 * Doppel zur gepflegten Liste (Recherche) entfernen – nur für die Anzeige und Zählung; das Merkmal je Gemeinde und Stunde ist 0/1, doppelte
 * Einträge änderten am Modell nichts. Doppelt = gleiche Gemeinde und gleicher Tag und (beide Volksfest oder ein gemeinsames Wort ab 5 Buchstaben im Titel).
 */
export function withoutCurated(termine, curated) {
  const words = (s) => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9äöüß]+/).filter(w => w.length >= 5 && !/^(20\d\d|messe|volksfest|festival|konzert|stadion|arena)$/.test(w)));
  const by = new Map(); for (const e of curated || []) for (const a of e.gebiet?.ags || []) { const k = `${a}|${String(e.von).slice(0, 10)}`; if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
  return (termine || []).filter(t => { const l = by.get(`${t.gebiet?.ags?.[0]}|${String(t.von).slice(0, 10)}`) || []; const w = words(t.titel); return !l.some(c => (c.art === 'volksfest' && t.art === 'volksfest') || [...words(c.titel)].some(x => w.has(x))); });
}
