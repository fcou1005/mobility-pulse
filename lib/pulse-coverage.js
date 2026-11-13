// @ts-check
// Mobility Pulse — Abdeckung: wo ein Anbieter laut eigener Website aktiv ist, wo ein Feed Fahrzeuge liefert,
// wo ein Feed still ist und wo es keinen gibt. Reine Rechenfunktionen ohne DOM (Node, Sammler).
// Eingaben: data/operator-cities.json (Selbstauskünfte), latest.json (Quellen, Gemeinden, Lücken),
// Gemeindegrenzen (Namen, AGS, Land, Einwohner), history/daily.json und das vorige coverage.json (zuletzt aktiv).

export const COVERAGE_VERSION = 1;
export const MIN_STRAY = 10; // Gemeinde am Rand eines Feeds mit weniger Fahrzeugen: Streuung, keine eigene Zeile

// ---------- Betriebsgebiet: wo ein Anbieter wirklich fährt (nicht nur ein verirrtes Fahrzeug) ----------
// Je Gemeinde × Anbieter aus den Tagesdateien (events/<Tag>.json → groups[ags|op|art].vmin: Fahrzeugminuten je Stunde) und dem aktuellen Stand:
//   Tagesmaximum = höchste Stundenzahl gleichzeitig vorhandener Fahrzeuge (Σ Arten vmin ÷ 60), ein Tag zählt ab 0,5 Fahrzeugen.
//   fest       – der Anbieter hat dort Stationen oder Abstellzonen (geplante Infrastruktur)
//   aktiv      – an mindestens minDays Tagen im Fenster (windowDays) da, Median der Tagesmaxima mindestens minMedian Fahrzeuge
//   neu        – Start oder Wachstum: jetzt mindestens nowNew Fahrzeuge, oder an newDays der letzten recentDays Tage mit mindestens newMin –
//                und entweder erst seit Kurzem da (höchstens recentDays Tage) oder zuletzt mindestens doppelt so viele wie davor (Median)
//   vereinzelt – sonst (z. B. ein E-Scooter, der in den Nachbarort gefahren und dort abgestellt wurde)
// Eine Gemeinde trägt den besten Stand ihrer Anbieter. Vereinzelte Orte bleiben in den Daten (die Fahrzeuge zählen in den Summen), erscheinen
// aber nicht als eigenes Gebiet; „neu“ wird nach minDays Tagen von selbst „aktiv“ oder fällt zurück.
export const PRESENCE = { windowDays: 14, minDays: 3, minMedian: 3, nowNew: 10, recentDays: 3, newDays: 2, newMin: 3 };
export const PRESENCE_RANK = { fest: 3, aktiv: 2, neu: 1, vereinzelt: 0 };
const r1p = (x) => Math.round(x * 10) / 10;
/** docs: Tagesdateien (beliebige Reihenfolge), current: { 'ags|op': { vehicles, stations } } → { byOp, byMuni, counts } */
export function presenceOf(docs, current = {}, opts = PRESENCE) {
  const days = (docs || []).filter((d) => d?.day && d.groups).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-opts.windowDays);
  const recent = new Set(days.slice(-opts.recentDays).map((d) => d.day)), hist = new Map();
  for (const d of days) {
    const per = new Map();
    for (const [k, g] of Object.entries(d.groups)) {
      if (!Array.isArray(g?.vmin)) continue;
      const [a, op] = k.split('|'), key = `${a}|${op}`; let arr = per.get(key); if (!arr) per.set(key, (arr = new Array(24).fill(0)));
      g.vmin.forEach((v, h) => { if (h < 24) arr[h] += (+v || 0) / 60; });
    }
    for (const [key, arr] of per) { const mx = Math.max(...arr); if (mx >= 0.5) { let l = hist.get(key); if (!l) hist.set(key, (l = [])); l.push([d.day, mx]); } }
  }
  const byOp = {}, byMuni = {};
  for (const key of new Set([...hist.keys(), ...Object.keys(current || {})])) {
    const l = hist.get(key) || [], cur = current?.[key] || {}, mx = l.map((x) => x[1]).sort((a, b) => a - b);
    const med = mx.length ? (mx.length % 2 ? mx[(mx.length - 1) / 2] : (mx[mx.length / 2 - 1] + mx[mx.length / 2]) / 2) : 0;
    const rec = l.filter((x) => recent.has(x[0]) && x[1] >= opts.newMin).length, now = cur.vehicles || 0;
    const medOf = (a) => { const b = a.map((x) => x[1]).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : 0; };
    const before = l.filter((x) => !recent.has(x[0])), grows = !before.length || l.length <= opts.recentDays || medOf(l.filter((x) => recent.has(x[0]))) >= 2 * medOf(before);
    const status = cur.stations > 0 ? 'fest' : l.length >= opts.minDays && med >= opts.minMedian ? 'aktiv' : now >= opts.nowNew || (rec >= opts.newDays && grows) ? 'neu' : 'vereinzelt';
    byOp[key] = { status, days: l.length, median: r1p(med), max: r1p(mx.at(-1) ?? 0), now, ...(cur.stations ? { stations: cur.stations } : {}) };
    const [ags, op] = key.split('|'), m = (byMuni[ags] ||= { status: 'vereinzelt', ops: {} });
    m.ops[op] = status; if (PRESENCE_RANK[status] > PRESENCE_RANK[m.status]) m.status = status;
  }
  const counts = { fest: 0, aktiv: 0, neu: 0, vereinzelt: 0 }; for (const m of Object.values(byMuni)) counts[m.status]++;
  return { byOp, byMuni, counts, days: days.length };
}
/** Stand einer Gemeinde aus latest.json (municipalities[ags].presence); ohne Angabe gilt sie als gezeigt */
export const muniShown = (m) => !m?.presence || m.presence.status !== 'vereinzelt';

/** Kategorien der Zeilen; Reihenfolge = Sortierung in der Übersicht */
// veraltet / nicht-erreichbar (M-17): gelistet, Feed vorhanden, aber nur veraltet bzw. nicht abrufbar – kein „Feed ohne Aktivität“
export const CATS = ['abgedeckt', 'kein-feed', 'feed-still', 'veraltet', 'nicht-erreichbar', 'gesperrt', 'nicht-gelistet', 'eingestellt', 'aktiv', 'still'];
const LIVE = new Set(['live', 'delayed', 'empty']); // Feed abrufbar und aktuell (empty: ohne Fahrzeuge und Stationen); unknown (Zeit unklar) zählt wie veraltet

// ---------- Namen ----------
const UML = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
/** Schlüssel 1: Umlaute ausgeschrieben (Muenster = Münster) */
export const normName = (s) => String(s || '').toLowerCase().replace(/[äöüß]/g, (c) => UML[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
/** Schlüssel 2: Akzente nur entfernt (Wurzburg = Würzburg, Lubeck = Lübeck) */
export const plainName = (s) => String(s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
/** Grundname ohne Zusatz: „Frankfurt am Main“ → frankfurt, „Halle (Saale)“ → halle, „Cottbus/Chóśebuz“ → cottbus */
export const baseName = (s) => normName(String(s || '').split(/\s*[(/,]/)[0].replace(/\s+(am|an der|an den|im|in der|in|ob der|bei|vor der)\s.*$/i, ''));

/** Englische und abweichende Schreibweisen der Anbieter-Websites → amtlicher Name (VG250 GEN) */
export const CITY_ALIASES = {
  cologne: 'Köln', munich: 'München', nuremberg: 'Nürnberg', hanover: 'Hannover', brunswick: 'Braunschweig',
  frankfurt: 'Frankfurt am Main', freiburg: 'Freiburg im Breisgau', halle: 'Halle (Saale)', 'muehlheim a m': 'Mühlheim am Main',
  'muehlheim an der ruhr': 'Mülheim an der Ruhr', 'muelheim': 'Mülheim an der Ruhr', ellwagen: 'Ellwangen (Jagst)', 'st augustin': 'Sankt Augustin',
  monheim: 'Monheim am Rhein', kempten: 'Kempten (Allgäu)', singen: 'Singen (Hohentwiel)', wangen: 'Wangen im Allgäu',
  neustadt: 'Neustadt an der Weinstraße', oldenburg: 'Oldenburg (Oldb)', ludwigshafen: 'Ludwigshafen am Rhein', 'ruesselsheim': 'Rüsselsheim am Main',
  langenfeld: 'Langenfeld (Rhld.)', offenbach: 'Offenbach am Main', lindau: 'Lindau (Bodensee)', hennef: 'Hennef (Sieg)',
  'renningen malmsheim': 'Renningen', 'villingen schwenningen': 'Villingen-Schwenningen', 'dessau': 'Dessau-Roßlau', 'tubingen': 'Tübingen',
};
/** Mehrdeutige Kurznamen: Land der gemeinten Gemeinde (sonst gewinnt die einwohnerstärkste) */
export const CITY_STATE_HINT = { 'brühl': 'NW', hemmingen: 'BW', stein: 'BY', 'cham': 'BY' };
/** Regionen statt Gemeinde: Name → AGS-Präfixe der Kreise und kreisfreien Städte (RVR-Gebiet, KielRegion, Schlei, Prignitz) */
export const REGION_AGS = {
  ruhrpott: ['05911', '05512', '05913', '05112', '05113', '05513', '05914', '05915', '05916', '05117', '05119', '05954', '05562', '05978', '05170'],
  'kiel region': ['01002', '01057', '01058'], 'schlei region': ['01059', '01058'], prignitz: ['12070'],
};
REGION_AGS.ruhrgebiet = REGION_AGS.ruhrpott; REGION_AGS['metropolrad ruhr'] = REGION_AGS.ruhrpott;
export const REGIONS = new Set(Object.keys(REGION_AGS));
export const inRegion = (region, ags) => (REGION_AGS[plainName(region)] || []).some((p) => String(ags || '').startsWith(p));

/** Nachschlagewerk aus Gemeindegrenzen (features[].properties: ags, name, state, pop) */
export function buildGazetteer(features = []) {
  const full = new Map(), plain = new Map(), base = new Map(), byAgs = new Map();
  const add = (m, k, e) => { if (!k) return; const a = m.get(k); if (a) { if (!a.includes(e)) a.push(e); } else m.set(k, [e]); };
  for (const f of features) {
    const p = f.properties || f;
    if (!p?.ags || !p.name) continue;
    const e = { ags: p.ags, name: p.name, state: p.state || null, pop: p.pop ?? null };
    byAgs.set(e.ags, e);
    add(full, normName(e.name), e); add(plain, plainName(e.name), e); add(base, baseName(e.name), e);
  }
  return { full, plain, base, byAgs };
}

const pick = (cands, state) => {
  if (!cands?.length) return null;
  let c = state ? cands.filter((e) => e.state === state) : cands;
  if (!c.length) c = cands;
  const best = [...c].sort((a, b) => (b.pop || 0) - (a.pop || 0))[0];
  return { ...best, ambiguous: c.length > 1 ? c.length : 0 };
};

/** Ortsname → Gemeinde { ags, name, state, pop, ambiguous } oder null. state: Länderkürzel (z. B. BW) als Vorgabe. */
export function resolveCity(gaz, q, { state = null, ags = null } = {}) {
  if (ags && gaz.byAgs.has(ags)) return { ...gaz.byAgs.get(ags), ambiguous: 0 };
  const n0 = normName(q);
  if (!n0) return null;
  const alias = CITY_ALIASES[n0] || CITY_ALIASES[plainName(q)];
  const name = alias || q;
  const hint = state || CITY_STATE_HINT[String(q).toLowerCase().trim()] || null;
  return pick(gaz.full.get(normName(name)), hint) || pick(gaz.plain.get(plainName(name)), hint)
    || pick(gaz.base.get(baseName(name)), hint) || null;
}

// ---------- Anbieter ----------
const OP_ALIASES = {
  'dott (inkl. ehemals tier)': 'dott', tier: 'dott', 'donkey republic': 'donkey', 'call a bike (db)': 'db connect', 'call a bike': 'db connect',
  'call-a-bike': 'db connect', 'hopp konstanz': 'hopp',
};
/** einheitlicher Anbieterschlüssel für Selbstauskunft und Feed */
export const opKey = (name) => { const n = String(name || '').trim().toLowerCase(); return OP_ALIASES[n] || n; };
const opLabel = (name) => String(name || '').replace(/\s*\(.*\)\s*$/, '').trim();

// Wörter aus Quellnamen und URLs, die nie eine Gemeinde meinen
const STOP = new Set(['gbfs', 'json', 'api', 'v1', 'v2', 'v3', 'public', 'feed', 'feeds', 'source', 'sources', 'sharing', 'scooter', 'scooters', 'e', 'bike', 'bikes',
  'ebike', 'networks', 'network', 'free', 'floating', 'gebuendelte', 'daten', 'nrw', 'bw', 'de', 'www', 'com', 'https', 'http', 'systemadapter', 'provider', 'conflated',
  'mobilitaetsdaten', 'mobidata', 'citybik', 'es', 'stables', 'donkey', 'bird', 'mds', 'co', 'dott', 'ridedott', 'tier', 'voi', 'lime', 'bolt', 'zeus', 'nextbike', 'callabike',
  'call', 'a', 'db', 'connect', 'sigo', 'yoio', 'rideatom', 'gbfs.json', 'station', 'information', 'status', 'germany', 'deutschland', 'city', 'stadt', 'region', 'lastenrad',
  'cargo', 'gmbh', 'mobil', 'mobility', 'moin', 'en', 'li', 'me', 'io', 'org', 'net', 'eu', 'api.mobidata', 'kick', 'roller']);

/** Gemeinde zu einer Quelle ohne zugeordnete Fahrzeuge aus Name und URL raten (Ein- bis Dreiwort-Folgen). */
export function guessSourceCity(gaz, src) {
  const words = [];
  const push = (s) => { for (const w of String(s || '').split(/[^\p{L}\p{N}]+/u)) if (w) words.push(w); };
  push(src.name); try { push(new URL(src.url).pathname); } catch { /* keine URL */ }
  const toks = words.filter((w) => !STOP.has(plainName(w)) && !STOP.has(normName(w)) && !/^\d+$/.test(w) && w.length > 1);
  if (toks.some((w) => REGIONS.has(plainName(w)))) return null;
  for (let len = 3; len >= 1; len--) {
    for (let i = 0; i + len <= toks.length; i++) {
      const q = toks.slice(i, i + len).join(' ');
      if (REGIONS.has(plainName(q))) return null;
      const n = normName(q), p = plainName(q), al = CITY_ALIASES[n] || CITY_ALIASES[p];
      const hit = al ? resolveCity(gaz, al) : (pick(gaz.full.get(n)) || pick(gaz.plain.get(p)));
      if (hit) return hit;
    }
  }
  return null;
}

/** Selbstauskünfte → [{ key, opName, ort, city, unresolved, src, note, weak }] (Sammelnamen „A/B“ getrennt, Regionen ausgewiesen) */
export function claimEntries(gaz, claims) {
  /** @type {any[]} */
  const out = [];
  /** @type {any[]} */
  const unresolved = [];
  for (const a of claims?.anbieter || []) {
    if (!a?.staedte?.length) continue;
    const key = opKey(a.name), opName = opLabel(a.name);
    const weak = /alle(n)?\s+(bolt-)?dienste|ALLE Bolt-Dienste/i.test(a.hinweis || '');
    for (const s of a.staedte) {
      const ort = typeof s === 'string' ? s : s.ort;
      const parts = s?.ags ? [ort] : String(ort).split(/\s*\/\s*/);
      for (const part of parts) {
        const src = s?.quelle || a.quelle || null;
        if (REGIONS.has(plainName(part))) { out.push({ key, opName, ort: part, region: plainName(part), src, weak }); continue; }
        const city = resolveCity(gaz, part, { state: s?.land || null, ags: s?.ags || null });
        if (!city) { unresolved.push({ op: opName, ort: part, grund: 'unbekannt' }); out.push({ key, opName, ort: part, city: null, src, weak }); continue; }
        out.push({ key, opName, ort: part, city, src, stand: s?.stand || claims.erstellt || null, weak });
      }
    }
  }
  return { entries: out, unresolved };
}

/** Zeilenschlüssel Anbieter|AGS (ohne AGS: ?Name) */
export const rowId = (r) => `${r.opKey}|${r.ags || '?' + normName(r.city)}`;

const TODAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const today = (ms) => TODAY_FMT.format(new Date(ms));

/** zuletzt aktiv je Anbieter|Gemeinde aus daily.json (series 'ags|Anbieter|Art' → { Tag: [verfügbar, gesamt, …] }) */
export function lastActiveFromDaily(daily) {
  const out = new Map(), fi = Math.max(0, (daily?.fields || []).indexOf('total'));
  for (const [k, days] of Object.entries(daily?.series || {})) {
    const [ags, op] = k.split('|');
    if (!ags || ags === 'DE' || !op) continue;
    const key = `${opKey(op)}|${ags}`;
    for (const [d, v] of Object.entries(days || {})) if ((v?.[fi] || 0) > 0 && !(out.get(key) >= d)) out.set(key, d);
  }
  return out;
}

/**
 * Abdeckung je Anbieter und Gemeinde.
 * claims: operator-cities.json · latest: { sources, municipalities, gaps } · features: Gemeindegrenzen (Namen)
 * prev: voriges coverage.json (zuletzt aktiv, Gemeinden stiller Quellen) · daily: history/daily.json
 * Kategorie: abgedeckt (gelistet, Fahrzeuge im Feed) · kein-feed (gelistet, keine Quelle) · feed-still (gelistet, Quelle ohne Fahrzeuge)
 * · gesperrt (gelistet, Feed existiert, aber nicht offen) · nicht-gelistet (Fahrzeuge, Stadt fehlt in der Liste) · eingestellt (Quelle still,
 * Stadt nicht gelistet) · aktiv / still (Anbieter ohne Städteliste).
 */
export function coverage({ claims = null, latest = /** @type {any} */ ({}), features = [], prev = null, daily = null, now = Date.now(), minStray = MIN_STRAY } = {}) {
  const gaz = buildGazetteer(features.length ? features : Object.values(latest.municipalities || {}).map((m) => ({ ags: m.ags, name: m.name, state: m.state, pop: m.pop })));
  const { entries, unresolved } = claimEntries(gaz, claims);
  const listed = new Set(entries.map((e) => e.key));
  const rows = new Map();
  const row = (key, opName, city) => {
    const id = `${key}|${city.ags || '?' + normName(city.name)}`;
    let r = rows.get(id);
    if (!r) {
      r = { id, op: opName, opKey: key, ags: city.ags || null, city: city.name, state: city.state || null, claimed: listed.has(key) ? false : null, claimSrc: null, claimWeak: false,
        claimAmbiguous: 0, vehicles: 0, available: 0, types: {}, sources: [], feedStatus: [], probes: [], gap: null, lastActive: null, main: false };
      rows.set(id, r);
    }
    return r;
  };
  const regionClaims = entries.filter((e) => e.region);
  for (const e of entries) {
    if (e.region) continue;
    const r = row(e.key, e.opName, e.city || { ags: null, name: e.ort, state: null });
    r.claimed = true; r.claimSrc = r.claimSrc || e.src; r.claimWeak = r.claimWeak || e.weak; r.claimAmbiguous = Math.max(r.claimAmbiguous, e.city?.ambiguous || 0); if (!e.city) r.unresolved = true;
    if (e.ort && e.city && e.ort !== e.city.name) r.claimName = e.ort;
  }
  // Fahrzeuge je Gemeinde und Anbieter (Anzeigename des Feeds gewinnt)
  for (const m of Object.values(latest.municipalities || {})) {
    const city = gaz.byAgs.get(m.ags) || { ags: m.ags, name: m.name, state: m.state };
    for (const [op, o] of Object.entries(m.operators || {})) {
      if (!(o?.total > 0)) continue;
      const r = row(opKey(op), op, city);
      r.op = op; r.vehicles += o.total; r.available += o.available || 0;
      for (const [t, n] of Object.entries(o.types || {})) r.types[t] = (r.types[t] || 0) + n;
    }
  }
  // Quellen: zugeordnete Gemeinden, bei stillen Quellen aus dem vorigen Stand oder aus Name/URL
  const prevSrc = prev?.sourceAgs || {};
  const sourceAgs = {};
  const probes = [];
  for (const s of latest.sources || []) {
    if (s.status === 'duplicate') continue;
    const key = opKey(s.operator);
    if (s.candidate && s.status !== 'live') { probes.push(s); continue; } // geratene Adresse ohne Daten: nur Hinweis an vorhandenen Zeilen
    let ags = (s.municipalities || []).filter(Boolean);
    let guessed = false;
    if (!ags.length && prevSrc[s.id]?.length) ags = prevSrc[s.id];
    if (!ags.length) { const g = guessSourceCity(gaz, s); if (g) { ags = [g.ags]; guessed = true; } }
    if (!ags.length) { unresolved.push({ op: s.operator, ort: s.name, grund: 'quelle', status: s.status }); continue; }
    sourceAgs[s.id] = ags;
    // Hauptgemeinde der Quelle: die mit den meisten Fahrzeugen dieses Anbieters
    let mainAgs = ags[0], best = -1;
    for (const a of ags) { const v = rows.get(`${key}|${a}`)?.vehicles || 0; if (v > best) { best = v; mainAgs = a; } }
    for (const a of ags) {
      const city = gaz.byAgs.get(a) || { ags: a, name: latest.municipalities?.[a]?.name || a, state: latest.municipalities?.[a]?.state || null };
      const r = row(key, s.operator, city);
      if (!r.vehicles) r.op = s.operator;
      const rec = { id: s.id, name: s.name, status: s.status, url: s.url || null, guessed: guessed || undefined, directories: s.directories || [] };
      if (a === mainAgs) r.sources.unshift(rec); else r.sources.push(rec); // Quelle, deren Hauptgemeinde das ist, zuerst
      if (!r.feedStatus.includes(s.status)) r.feedStatus.push(s.status);
      if (a === mainAgs) r.main = true;
      else if (!r.partOf) r.partOf = gaz.byAgs.get(mainAgs)?.name || latest.municipalities?.[mainAgs]?.name || null;
    }
  }
  // Feed nennt weitere Städte im Titel („Bolt Köln-Bonn“, „Voi Duisburg-Oberhausen“), liefert dort aber keine Fahrzeuge: an die gelistete
  // Zeile hängen (named) – dann gilt „Feed läuft, still“ statt der Annahme „geschlossene Plattform“ (MOBIDROM 02.11.2026: Bolt Bonn, Mönchengladbach)
  for (const s of latest.sources || []) {
    if (s.status !== 'live' || !(s.counts?.vehicles > 0) || !s.name) continue;
    const key = opKey(s.operator), title = String(s.name).split(' · ')[0], have = new Set(sourceAgs[s.id] || []);
    for (const w of title.split(/[^\p{L}]+/u)) {
      if (w.length < 3 || STOP.has(plainName(w)) || opKey(w) === key) continue;
      const hit = pick(gaz.full.get(normName(w))) || pick(gaz.plain.get(plainName(w)));
      if (!hit || have.has(hit.ags)) continue;
      const r = rows.get(`${key}|${hit.ags}`); if (!r || r.vehicles || r.sources.some(x => x.id === s.id)) continue;
      r.sources.push({ id: s.id, name: s.name, status: s.status, url: s.url || null, named: true, directories: s.directories || [] });
      if (!r.feedStatus.includes(s.status)) r.feedStatus.push(s.status);
    }
  }
  for (const s of probes) {
    const g = (s.municipalities || []).length ? null : guessSourceCity(gaz, s);
    const ags = (s.municipalities || []).length ? s.municipalities : g ? [g.ags] : [];
    for (const a of ags) { const r = rows.get(`${opKey(s.operator)}|${a}`); if (r) r.probes.push({ url: s.url || null, status: s.status }); }
  }
  // Regionen in der Selbstauskunft (Ruhrgebiet …): Gemeinden des Anbieters darin gelten als gelistet
  for (const e of regionClaims) {
    for (const r of rows.values()) if (r.opKey === e.key && r.claimed !== true && r.ags && inRegion(e.region, r.ags)) { r.claimed = true; r.claimRegion = e.ort; r.claimSrc = r.claimSrc || e.src; r.claimWeak = r.claimWeak || e.weak; }
  }
  // Feeds nur über geschlossene Plattformen (operator-cities.json → geschlossen: [{ land, plattform, hinweis }])
  const closed = new Map();
  for (const a of claims?.anbieter || []) for (const c of a.geschlossen || []) { const k = opKey(a.name); (closed.get(k) || closed.set(k, []).get(k)).push(c); }
  // Bekannte Datenlücken (latest.gaps): Feed vorhanden, aber nicht offen abrufbar oder abgeschaltet
  for (const g of latest.gaps || []) {
    const city = resolveCity(gaz, g.city);
    if (!city) { unresolved.push({ op: g.operator, ort: g.city, grund: 'luecke' }); continue; }
    const r = row(opKey(g.operator), g.operator, city);
    r.gap = { since: g.since || null, note: g.note || null, probeStatus: g.probeStatus ?? null, open: !!g.probe_url };
  }
  // zuletzt aktiv
  const fromDaily = lastActiveFromDaily(daily);
  const prevRows = new Map((prev?.rows || []).map((r) => [rowId(r), r]));
  const day = today(now);
  for (const r of rows.values()) {
    if (!r.gap && !r.sources.length && !r.vehicles && r.claimed) {
      const c = (closed.get(r.opKey) || []).find((x) => x.land && x.land === r.state);
      if (c) r.gap = { since: null, note: c.hinweis || null, via: c.plattform || null, assumed: true, open: false };
    }
    const cands = [r.vehicles > 0 ? day : null, fromDaily.get(`${r.opKey}|${r.ags}`), prevRows.get(r.id)?.lastActive].filter(Boolean).sort();
    r.lastActive = cands.length ? cands[cands.length - 1] : null;
    // Feed-Zustand nach dem Status der Quellen: bekannte Lücke vor allem anderen (ohne Fahrzeuge), dann laufend ohne Fahrzeuge = still,
    // nur veraltete Quellen = veraltet, nur nicht erreichbare (gone/error/auth …) = nicht-erreichbar
    const st = r.sources.map((x) => x.status);
    // Feed nennt die Stadt im Titel und läuft (named): bleibt „still“ (Feed offen, aber unvollständig), die bekannte Lücke liefert nur den Hinweis
    const namedLive = r.sources.some((x) => x.named && LIVE.has(x.status));
    r.feed = r.vehicles > 0 ? 'aktiv' : r.gap && !namedLive ? 'gesperrt' : st.some((x) => LIVE.has(x)) ? 'still' : st.some((x) => x === 'stale' || x === 'unknown') ? 'veraltet' : st.length ? 'nicht-erreichbar' : 'keiner';
    if (r.claimed === true) r.cat = r.feed === 'aktiv' ? 'abgedeckt' : r.feed === 'still' ? 'feed-still' : r.feed === 'gesperrt' ? 'gesperrt' : r.feed === 'veraltet' ? 'veraltet' : r.feed === 'nicht-erreichbar' ? 'nicht-erreichbar' : 'kein-feed';
    else if (r.claimed === false) r.cat = r.feed === 'aktiv' ? 'nicht-gelistet' : r.feed === 'gesperrt' ? 'gesperrt' : 'eingestellt';
    else r.cat = r.feed === 'aktiv' ? 'aktiv' : r.feed === 'gesperrt' ? 'gesperrt' : 'still';
  }
  // Streuung: Randgemeinden eines Feeds mit wenigen Fahrzeugen, die der Anbieter nicht nennt
  const stray = new Map();
  const out = [];
  for (const r of rows.values()) {
    // Streuung: mit Betriebsgebiet-Erkennung (latest.municipalities[ags].presence) zählt der Stand des Anbieters dort, sonst die Momentaufnahme (< minStray)
    const pst = latest.municipalities?.[r.ags]?.presence?.ops?.[r.op];
    if (r.claimed !== true && !r.main && r.feed === 'aktiv' && (pst ? pst === 'vereinzelt' : r.vehicles < minStray) && !r.gap) {
      const s = stray.get(r.opKey) || { gemeinden: 0, fahrzeuge: 0 }; s.gemeinden++; s.fahrzeuge += r.vehicles; stray.set(r.opKey, s); continue;
    }
    if (r.claimed !== true && r.feed === 'keiner') continue;
    if (r.claimed !== true && ['still', 'veraltet', 'nicht-erreichbar'].includes(r.feed) && !r.main && !r.gap) continue; // Randgemeinde eines Feeds ohne Fahrzeuge
    out.push(r);
  }
  out.sort((a, b) => a.op.localeCompare(b.op, 'de') || CATS.indexOf(a.cat) - CATS.indexOf(b.cat) || b.vehicles - a.vehicles || a.city.localeCompare(b.city, 'de'));
  // Übersicht je Anbieter
  const ops = new Map();
  for (const r of out) {
    let o = ops.get(r.opKey);
    if (!o) { o = { opKey: r.opKey, op: r.op, hasList: listed.has(r.opKey), cities: 0, listedCities: 0, vehicles: 0, cats: Object.fromEntries(CATS.map((c) => [c, 0])) }; ops.set(r.opKey, o); }
    if (r.vehicles > (o.maxV || 0)) { o.op = r.op; o.maxV = r.vehicles; }
    o.cities++; o.vehicles += r.vehicles; o.cats[r.cat]++; if (r.claimed) o.listedCities++;
  }
  for (const a of claims?.anbieter || []) {
    const o = ops.get(opKey(a.name));
    if (o) { o.claimSrc = a.quelle || null; o.claimNote = a.hinweis || null; o.claimWeak = /ALLE Bolt-Dienste|alle(n)?\s+Dienste/i.test(a.hinweis || ''); }
  }
  for (const [k, s] of stray) { const o = ops.get(k); if (o) o.stray = s; }
  const operators = [...ops.values()].map(({ maxV, ...o }) => o).sort((a, b) => b.vehicles - a.vehicles || a.op.localeCompare(b.op, 'de'));
  const totals = Object.fromEntries(CATS.map((c) => [c, out.filter((r) => r.cat === c).length]));
  // kompakt: Quellen und Hinweise einmal, Zeilen ohne leere Felder
  const sources = {}, notes = [], noteIdx = new Map();
  const note = (t) => { if (!t) return undefined; if (!noteIdx.has(t)) { noteIdx.set(t, notes.length); notes.push(t); } return noteIdx.get(t); };
  const opSrc = new Map(operators.map((o) => [o.opKey, o.claimSrc]));
  const rowsOut = out.map((r) => {
    for (const x of r.sources) sources[x.id] ||= { name: x.name, status: x.status, url: x.url, dir: x.directories?.[0] || null };
    const o = { op: r.op, opKey: r.opKey, ags: r.ags, city: r.city, state: r.state, cat: r.cat, feed: r.feed, claimed: r.claimed, vehicles: r.vehicles };
    if (r.available !== r.vehicles) o.available = r.available;
    if (Object.keys(r.types).length) o.types = r.types;
    if (r.claimSrc && r.claimSrc !== opSrc.get(r.opKey)) o.claimSrc = r.claimSrc;
    if (r.claimName) o.claimName = r.claimName;
    if (r.claimRegion) o.claimRegion = r.claimRegion;
    if (r.claimWeak) o.claimWeak = true;
    if (r.claimAmbiguous) o.claimAmbiguous = r.claimAmbiguous;
    if (r.unresolved) o.unresolved = true;
    if (r.sources.length) { o.src = r.sources.map((x) => x.id); if (r.sources.some((x) => x.guessed)) o.guessed = true; const nm = r.sources.find((x) => x.named); if (nm) o.named = String(nm.name || '').split(' · ')[0]; }
    if (r.probes.length) o.probes = r.probes.length;
    if (r.gap) o.gap = { since: r.gap.since || undefined, via: r.gap.via || undefined, assumed: r.gap.assumed || undefined, open: r.gap.open || undefined, probeStatus: r.gap.probeStatus ?? undefined, note: note(r.gap.note) };
    if (r.lastActive) o.lastActive = r.lastActive;
    if (!r.main && r.partOf) o.partOf = r.partOf;
    return o;
  });
  return { version: COVERAGE_VERSION, generatedAt: now, claimsDate: claims?.erstellt || null, minStray, totals, operators, rows: rowsOut, sources, notes, unresolved, sourceAgs };
}
