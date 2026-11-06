// Tests für lib/pulse-coverage.js: Namenszuordnung, Selbstauskünfte, Kategorien der Abdeckung, Streuung, zuletzt aktiv
import * as V from '../lib/pulse-coverage.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };

const F = (ags, name, state, pop) => ({ properties: { ags, name, state, pop } });
const features = [
  F('05315000', 'Köln', 'NW', 1080000), F('06412000', 'Frankfurt am Main', 'HE', 770000), F('12053000', 'Frankfurt (Oder)', 'BB', 57000),
  F('15002000', 'Halle (Saale)', 'ST', 238000), F('05754012', 'Halle (Westf.)', 'NW', 22000), F('05362012', 'Brühl', 'NW', 44000), F('08226009', 'Brühl', 'BW', 14000),
  F('03241007', 'Hemmingen', 'NI', 19000), F('08118028', 'Hemmingen', 'BW', 8000), F('09663000', 'Würzburg', 'BY', 127000), F('05515000', 'Münster', 'NW', 320000),
  F('01003000', 'Lübeck', 'SH', 218000), F('05112000', 'Duisburg', 'NW', 500000), F('05119000', 'Oberhausen', 'NW', 210000), F('03241001', 'Hannover', 'NI', 545000),
  F('03241010', 'Langenhagen', 'NI', 55000), F('03241005', 'Garbsen', 'NI', 61000), F('05911000', 'Bochum', 'NW', 364000), F('05113000', 'Essen', 'NW', 580000),
  F('02000000', 'Hamburg', 'HH', 1850000), F('11000000', 'Berlin', 'BE', 3700000), F('06438007', 'Mühlheim am Main', 'HE', 29000), F('05117000', 'Mülheim an der Ruhr', 'NW', 170000),
  F('12052000', 'Cottbus/Chóśebuz', 'BB', 98000), F('05334002', 'Aachen', 'NW', 250000),
];
const gaz = V.buildGazetteer(features);

// ---------- Namen ----------
assert(V.normName('Münster') === 'muenster' && V.normName('Muenster') === 'muenster' && V.plainName('Würzburg') === 'wurzburg', 'Namensschlüssel: Umlaute ausgeschrieben bzw. ohne Akzent');
assert(V.baseName('Frankfurt am Main') === 'frankfurt' && V.baseName('Halle (Saale)') === 'halle' && V.baseName('Cottbus/Chóśebuz') === 'cottbus' && V.baseName('Mülheim an der Ruhr') === 'muelheim', 'Grundname ohne Zusatz');
const ags = (q, o) => V.resolveCity(gaz, q, o)?.ags;
assert(ags('Cologne') === '05315000' && ags('Muenster') === '05515000' && ags('Wurzburg') === '09663000' && ags('Lubeck') === '01003000', 'englische Schreibweisen und Umschrift → Köln, Münster, Würzburg, Lübeck');
assert(ags('Frankfurt') === '06412000' && ags('Halle') === '15002000' && ags('Cottbus') === '12052000', 'Kurzname → gemeinte Großstadt (Frankfurt am Main, Halle (Saale)), Doppelname Cottbus/Chóśebuz');
assert(ags('Brühl') === '05362012' && ags('Hemmingen') === '08118028' && ags('Hemmingen', { state: 'NI' }) === '03241007', 'mehrdeutig: Länder-Vorgabe (Hemmingen BW für Zeus) schlägt Einwohnerzahl, Aufrufer kann überschreiben');
assert(V.resolveCity(gaz, 'Brühl').ambiguous === 0 && V.resolveCity(gaz, 'Hemmingen', { state: 'XX' }).ambiguous === 2 && ags('Hemmingen', { state: 'XX' }) === '03241007',
  'Mehrdeutigkeit: passende Länder-Vorgabe macht eindeutig, sonst gewinnt die einwohnerstärkste und die Zahl der Kandidaten wird vermerkt');
assert(ags('Mühlheim a.M.') === '06438007' && ags('Mühlheim an der Ruhr') === '05117000', 'Bolt „Mühlheim a.M.“ und Dotts Schreibfehler „Mühlheim an der Ruhr“ getrennt');
assert(V.resolveCity(gaz, 'Atlantis') === null && ags('x', { ags: '05113000' }) === '05113000', 'unbekannter Ort → null; AGS aus der Liste gewinnt');
assert(V.opKey('Dott (inkl. ehemals TIER)') === 'dott' && V.opKey('Call a Bike (DB)') === 'db connect' && V.opKey('DB Connect') === 'db connect' && V.opKey('Hopp Konstanz') === 'hopp', 'Anbieterschlüssel für Selbstauskunft und Feed');
assert(V.inRegion('Ruhrpott', '05911000') && V.inRegion('Ruhrgebiet', '05113000') && !V.inRegion('Ruhrpott', '05315000'), 'Region Ruhrgebiet: Bochum, Essen ja, Köln nein');
{
  const s = V.guessSourceCity(gaz, { name: 'Bird berlin', url: 'https://mds.bird.co/gbfs/v2/public/berlin/gbfs.json' });
  const t = V.guessSourceCity(gaz, { name: 'Lime Hamburg', url: 'https://data.lime.bike/api/partners/v2/gbfs/hamburg/gbfs.json' });
  const u = V.guessSourceCity(gaz, { name: 'Donkey Prignitz', url: 'https://stables.donkey.bike/api/public/gbfs/3.0/Donkey-Prignitz/gbfs.json' });
  assert(s?.ags === '11000000' && t?.ags === '02000000' && u === null, 'Gemeinde stiller Quellen aus Name/URL; Region (Prignitz) ergibt keine Gemeinde');
}

// ---------- Abdeckung ----------
const claims = {
  erstellt: '2026-11-01',
  anbieter: [
    { name: 'Voi', quelle: 'https://www.voi.com/city', staedte: [{ ort: 'Cologne' }, { ort: 'Duisburg/Oberhausen' }, { ort: 'Hamburg' }, { ort: 'Flensburg' }] },
    { name: 'Dott (inkl. ehemals TIER)', quelle: 'https://ridedott.com/locations/', staedte: [{ ort: 'Hannover' }, { ort: 'Aachen' }, { ort: 'Bochum' }],
      geschlossen: [{ land: 'NW', plattform: 'MDD NRW', hinweis: 'nur über MDD' }] },
    { name: 'Bolt', quelle: 'https://bolt.eu/de-de/cities/', hinweis: 'Städteliste für ALLE Bolt-Dienste', staedte: [{ ort: 'Köln' }] },
    { name: 'Lime', quelle: 'https://www.li.me/locations', staedte: [{ ort: 'Ruhrpott' }, { ort: 'Hamburg' }] },
    { name: 'Ryde', quelle: 'x', staedte: [{ ort: 'Essen' }] },
    { name: 'nextbike', staedte: [] },
  ],
};
const mun = (agsCode, name, state, ops) => ({ ags: agsCode, name, state, operators: ops });
const latest = {
  municipalities: {
    '05315000': mun('05315000', 'Köln', 'NW', { Voi: { total: 900, available: 850, types: { scooter: 900 } }, Bolt: { total: 400, available: 400, types: { scooter: 400 } } }),
    '05112000': mun('05112000', 'Duisburg', 'NW', { Voi: { total: 300, available: 300, types: { scooter: 300 } } }),
    '03241001': mun('03241001', 'Hannover', 'NI', { Dott: { total: 2000, available: 1900, types: { scooter: 2000 } } }),
    '03241010': mun('03241010', 'Langenhagen', 'NI', { Dott: { total: 438, available: 438, types: { scooter: 438 } } }),
    '03241005': mun('03241005', 'Garbsen', 'NI', { Dott: { total: 4, available: 4, types: { scooter: 4 } } }),
    '05113000': mun('05113000', 'Essen', 'NW', { Lime: { total: 500, available: 480, types: { scooter: 500 } } }),
    '11000000': mun('11000000', 'Berlin', 'BE', { nextbike: { total: 5000, available: 4900, types: { bike: 5000 } } }),
  },
  sources: [
    { id: 'voi-koeln', operator: 'Voi', name: 'Voi Köln', status: 'live', url: 'u1', municipalities: ['05315000'] },
    { id: 'voi-duisburg', operator: 'Voi', name: 'Voi Duisburg', status: 'live', url: 'u2', municipalities: ['05112000', '05119000'] },
    { id: 'voi-koeln-copy', operator: 'Voi', name: 'Voi Köln (Spiegel)', status: 'duplicate', url: 'u1b', municipalities: ['05315000'] },
    { id: 'dott-hannover', operator: 'Dott', name: 'Dott Hannover', status: 'live', url: 'u3', municipalities: ['03241001', '03241010', '03241005'] },
    { id: 'bolt-koeln', operator: 'Bolt', name: 'Bolt Köln', status: 'live', url: 'u4', municipalities: ['05315000'] },
    { id: 'lime-essen', operator: 'Lime', name: 'Lime Essen', status: 'live', url: 'u5', municipalities: ['05113000'] },
    { id: 'lime-hamburg', operator: 'Lime', name: 'Lime Hamburg', status: 'gone', url: 'https://data.lime.bike/api/partners/v2/gbfs/hamburg/gbfs.json', municipalities: [] },
    { id: 'lime-berlin-probe', operator: 'Lime', name: 'Lime berlin', status: 'gone', candidate: true, url: 'https://data.lime.bike/api/partners/v2/gbfs/berlin/gbfs.json', municipalities: [] },
    { id: 'voi-hamburg-old', operator: 'Voi', name: 'Voi Hamburg', status: 'empty', url: 'u6', municipalities: [] },
    { id: 'voi-luebeck', operator: 'Voi', name: 'Voi Lübeck', status: 'gone', url: 'u7', municipalities: [] },
    { id: 'nb-berlin', operator: 'nextbike', name: 'nextbike Berlin', status: 'live', url: 'u8', municipalities: ['11000000'] },
  ],
  gaps: [{ operator: 'Ryde', city: 'Essen', since: '2026-10-31', note: 'MDD gesperrt', probeStatus: null, probeOk: false }],
};
const daily = { fields: ['available', 'total'], series: { '01003000|Voi|scooter': { '2026-10-31': [0, 12], '2026-11-01': [0, 0] }, 'DE||scooter': { '2026-11-01': [1, 1] } } };
const prev = { sourceAgs: { 'voi-hamburg-old': ['02000000'] }, rows: [{ opKey: 'voi', ags: '02000000', city: 'Hamburg', lastActive: '2026-10-20' }] };
const cov = V.coverage({ claims, latest, features, daily, prev, now: Date.parse('2026-11-01T18:00:00Z') });
const R = (opKey, agsCode) => cov.rows.find((r) => r.opKey === opKey && r.ags === agsCode);

assert(R('voi', '05315000')?.cat === 'abgedeckt' && R('voi', '05315000').vehicles === 900 && R('voi', '05315000').claimName === 'Cologne' && R('voi', '05315000').src.length === 1,
  'Voi Köln: gelistet („Cologne“) und Fahrzeuge im Feed → abgedeckt; Spiegel (duplicate) zählt nicht als zweite Quelle');
assert(R('voi', '05112000')?.cat === 'abgedeckt' && R('voi', '05119000')?.claimed === true && R('voi', '05119000').cat === 'feed-still',
  '„Duisburg/Oberhausen“ getrennt: Oberhausen gelistet, Feed deckt es ab, aber keine Fahrzeuge → Feed ohne Aktivität');
assert(R('voi', '02000000')?.cat === 'feed-still' && R('voi', '02000000').lastActive === '2026-10-20', 'Voi Hamburg: Quelle leer, Gemeinde aus dem vorigen Stand, zuletzt aktiv bleibt erhalten');
assert(R('voi', '01003000')?.cat === 'eingestellt' && R('voi', '01003000').lastActive === '2026-10-31' && R('voi', '01003000').claimed === false,
  'Voi Lübeck: Quelle weg, Stadt nicht mehr gelistet → eingestellt; zuletzt aktiv aus daily.json (Bundessumme ignoriert)');
assert(cov.rows.some((r) => r.opKey === 'voi' && r.ags === null && r.city === 'Flensburg' && r.cat === 'kein-feed' && r.unresolved), 'Flensburg ohne Gemeindegrenze: Zeile bleibt (kein Feed), Ort als unaufgelöst markiert');
assert(cov.unresolved.some((u) => u.ort === 'Flensburg' && u.grund === 'unbekannt'), 'unaufgelöste Orte werden gemeldet');
assert(R('dott', '03241001')?.cat === 'abgedeckt' && R('dott', '03241010')?.cat === 'nicht-gelistet' && R('dott', '03241010').partOf === 'Hannover',
  'Dott Langenhagen: Fahrzeuge, nicht eigens gelistet, im Feed von Hannover');
assert(!R('dott', '03241005') && cov.operators.find((o) => o.opKey === 'dott').stray?.fahrzeuge === 4, 'Garbsen mit 4 Fahrzeugen am Feedrand: Streuung statt eigener Zeile');
assert(R('dott', '05334002')?.cat === 'gesperrt' && R('dott', '05334002').gap.via === 'MDD NRW' && R('dott', '05334002').gap.assumed, 'Dott Aachen: gelistet, kein offener Feed, Land NW → Feed nur über MDD NRW');
assert(R('ryde', '05113000')?.cat === 'gesperrt' && cov.notes[R('ryde', '05113000').gap.note] === 'MDD gesperrt', 'Ryde Essen: Datenlücke ohne Abrufadresse → Feed nicht offen, Hinweis einmal abgelegt');
assert(R('bolt', '05315000')?.cat === 'abgedeckt' && R('bolt', '05315000').claimWeak && cov.operators.find((o) => o.opKey === 'bolt').claimWeak, 'Bolt: Liste gilt für alle Dienste → schwache Selbstauskunft gekennzeichnet');
assert(R('lime', '05113000')?.cat === 'abgedeckt' && R('lime', '05113000').claimRegion === 'Ruhrpott', 'Lime Essen über „Ruhrpott“ gelistet');
assert(R('lime', '02000000')?.cat === 'nicht-erreichbar' && R('lime', '02000000').guessed, 'Lime Hamburg: Quelle weg (404), Gemeinde aus der URL geraten → nicht erreichbar (M-17, vorher „Feed ohne Aktivität“)');
assert(!R('lime', '11000000'), 'geratene Adresse (candidate) ohne Daten legt keine Zeile an');
assert(R('nextbike', '11000000')?.cat === 'aktiv' && R('nextbike', '11000000').claimed === null, 'nextbike ohne Städteliste: Feed aktiv, Selbstauskunft unbekannt');
assert(cov.totals.abgedeckt === 5 && cov.rows.every((r) => !('id' in r) && !('feedStatus' in r)), 'Summen je Kategorie; Zeilen ohne ableitbare Felder');
assert(cov.sources['voi-koeln']?.status === 'live' && !cov.sources['voi-koeln-copy'] && cov.sourceAgs['voi-hamburg-old'][0] === '02000000', 'Quellen einmal abgelegt; Gemeinden der Quellen für den nächsten Lauf');
assert(V.rowId({ opKey: 'voi', ags: null, city: 'Flensburg' }) === 'voi|?flensburg', 'Zeilenschlüssel ohne AGS');
{
  const again = V.coverage({ claims, latest: { ...latest, sources: latest.sources.filter((s) => s.id !== 'voi-hamburg-old') }, features, daily, prev: cov, now: Date.parse('2026-11-02T08:00:00Z') });
  assert(again.rows.find((r) => r.opKey === 'voi' && r.ags === '01003000')?.lastActive === '2026-10-31' && again.rows.find((r) => r.opKey === 'voi' && r.ags === '05315000')?.lastActive === '2026-11-02',
    'Folgelauf: zuletzt aktiv aus dem vorigen coverage.json, heute aktive Zeilen bekommen den neuen Tag');
  assert(again.rows.find((r) => r.opKey === 'voi' && r.ags === '02000000')?.cat === 'kein-feed', 'Quelle aus dem Katalog verschwunden → gelistete Stadt ohne Feed');
}
{
  const fb = V.coverage({ claims, latest, features: [], now: Date.parse('2026-11-01T18:00:00Z') });
  assert(fb.rows.find((r) => r.opKey === 'voi' && r.ags === '05315000')?.cat === 'abgedeckt', 'ohne Gemeindegrenzen: Namen aus latest.municipalities');
}
// M-17: Kategorie nach dem Status der Quelle – Lücke vor allem anderen, veraltet und nicht erreichbar getrennt von „Feed ohne Aktivität“
{
  const cl = { erstellt: '2026-11-01', anbieter: [{ name: 'Dott', quelle: 'q', staedte: [{ ort: 'Köln' }, { ort: 'Hamburg' }, { ort: 'Essen' }, { ort: 'Bonn' }] }] };
  const lt = { municipalities: {}, gaps: [{ operator: 'Dott', city: 'Köln', since: '2026-09-25', probe_url: 'http://x/gone' }], sources: [
    { id: 'dott-koeln-cb', operator: 'Dott', name: 'Dott Köln (CityBikes)', status: 'stale', url: 'c1', municipalities: ['05315000'] },
    { id: 'dott-hamburg', operator: 'Dott', name: 'Dott Hamburg', status: 'stale', url: 'c2', municipalities: ['02000000'] },
    { id: 'dott-essen', operator: 'Dott', name: 'Dott Essen', status: 'error', url: 'c3', municipalities: ['05113000'] },
    { id: 'dott-bonn', operator: 'Dott', name: 'Dott Bonn', status: 'live', url: 'c4', municipalities: ['05314000'] }] };
  const fts = [['05315000', 'Köln', 'NW'], ['02000000', 'Hamburg', 'HH'], ['05113000', 'Essen', 'NW'], ['05314000', 'Bonn', 'NW']].map(([ags, name, state]) => ({ properties: { ags, name, state, pop: 1 } }));
  const c = V.coverage({ claims: cl, latest: lt, features: fts, now: Date.parse('2026-11-01T18:00:00Z') });
  const cat = (a) => c.rows.find((r) => r.ags === a)?.cat;
  assert(cat('05315000') === 'gesperrt' && cat('02000000') === 'veraltet' && cat('05113000') === 'nicht-erreichbar' && cat('05314000') === 'feed-still' && V.CATS.includes('veraltet') && V.CATS.includes('nicht-erreichbar'),
    'M-17: Lücke + veraltete Kopie → gesperrt; nur veraltet → veraltet; nur Fehler → nicht erreichbar; laufend ohne Fahrzeuge → Feed ohne Aktivität');
}

// web/coverage.js csvOf: Formel-Schutz wie alle übrigen Exporte (Anbieter- und Quellennamen stammen aus Feeds). Das Browser-Modul importiert
// ./pulse-ops.js (in docs/ neben ihm); für Node auf lib/ umgelenkt.
{
  const { readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url);
  const src = readFileSync(new URL('web/coverage.js', root), 'utf8').replace("'./i18n.js'", `'${new URL('web/i18n.js', root).href}'`).replace("'./pulse-ops.js'", `'${new URL('lib/pulse-ops.js', root).href}'`);
  const W = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const row = { city: '=HYPERLINK("http://x")', ags: '08111000', state: 'BW', op: '@Evil', claimed: true, cat: 'abgedeckt', vehicles: 3, src: ['s1'] };
  const csv = W.csvOf({ sources: { s1: { name: '+cmd|calc', status: 'live' } } }, [row]);
  const line = csv.split('\r\n')[1];
  assert(line.startsWith(`"'=HYPERLINK(""http://x"")"`) && line.includes(";'@Evil;") && line.includes("'+cmd|calc"), 'Abdeckungs-CSV: Zellen mit = + - @ beginnen mit \' (Formel-Schutz), Anführungszeichen gequotet');
}

// Feed nennt eine weitere Stadt im Titel („Bolt Köln-Bonn“), liefert dort aber keine Fahrzeuge → Feed läuft, still (statt „geschlossene Plattform“ angenommen)
{
  const feats = [...features, F('05314000', 'Bonn', 'NW', 330000)];
  const cl = { erstellt: '2026-11-02', anbieter: [{ name: 'Bolt', staedte: ['Köln', 'Bonn', 'Essen'], geschlossen: [{ land: 'NW', plattform: 'MDD NRW', hinweis: 'nur MDD' }] }] };
  const lt = { at: Date.parse('2026-11-02T10:00:00Z'), gaps: [],
    municipalities: { '05315000': { ags: '05315000', name: 'Köln', state: 'NW', operators: { Bolt: { total: 1900, available: 1800, types: { scooter: 1900 } } } } },
    sources: [{ id: 'mobidrom_bolt-koeln-bonn:source-bolt-koeln-bonn', name: 'Bolt Köln-Bonn · source-bolt-koeln-bonn', operator: 'Bolt', status: 'live', municipalities: ['05315000'], counts: { vehicles: 1900 } }] };
  const cv = V.coverage({ claims: cl, latest: lt, features: feats, now: Date.parse('2026-11-02T10:00:00Z') });
  const cg = V.coverage({ claims: cl, latest: { ...lt, gaps: [{ operator: 'Bolt', city: 'Bonn', since: '2026-11-02', note: 'Daten fehlen im Feed' }] }, features: feats, now: Date.parse('2026-11-04T10:00:00Z') });
  const bg = cg.rows.find((r) => r.opKey === 'bolt' && r.ags === '05314000');
  assert(bg?.cat === 'feed-still' && bg.gap && cg.notes?.[bg.gap.note] === 'Daten fehlen im Feed', 'bekannte Lücke bei Feed mit Stadtnamen: bleibt „Feed still“ (offen, unvollständig), Hinweis aus der Lücke');
  const bonn = cv.rows.find((r) => r.opKey === 'bolt' && r.ags === '05314000'), essen = cv.rows.find((r) => r.opKey === 'bolt' && r.ags === '05113000');
  assert(bonn?.cat === 'feed-still' && bonn.named === 'Bolt Köln-Bonn' && !bonn.gap && essen?.cat === 'gesperrt' && cv.rows.find((r) => r.opKey === 'bolt' && r.ags === '05315000')?.cat === 'abgedeckt',
    'Titel „Bolt Köln-Bonn“: Bonn → Feed still (named), Essen ohne Feed weiter „geschlossene Plattform“, Köln abgedeckt');
}

// ---------- Betriebsgebiet-Erkennung: wo ein Anbieter wirklich fährt
{
  const day = (d, groups) => ({ day: d, groups });
  const vm = (n) => Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 20 ? n * 60 : 0)); // n Fahrzeuge 8–20 Uhr
  const D = (i) => `2026-11-${String(i).padStart(2, '0')}`;
  const docs = Array.from({ length: 10 }, (_, i) => day(D(i + 1), {
    'A|Voi|scooter': { vmin: vm(40) },                                   // Stadt: täglich 40
    'B|Voi|scooter': { vmin: vm(i % 3 === 0 ? 1 : 0) },                  // Nachbarort: ab und zu ein E-Scooter
    'C|Voi|scooter': { vmin: vm(4) },                                    // Randgebiet mit dauerhaft 4: echtes kleines Gebiet
    'D|Lime|scooter': { vmin: vm(i >= 8 ? 6 : 0) },                      // Wachstum: seit 2 Tagen 6
    'E|Dott|scooter': { vmin: vm(i >= 3 ? (i >= 7 ? 6 : 2) : 0) },        // dauerhaft 2, zuletzt 6 (verdreifacht)
    'F|Bolt|scooter': { vmin: vm(2) },                                    // dauerhaft 2, kein Wachstum
  }));
  const P = V.presenceOf(docs, { 'A|Voi': { vehicles: 38 }, 'G|nextbike': { vehicles: 0, stations: 3 }, 'H|Bolt': { vehicles: 25 }, 'B|Voi': { vehicles: 1 } });
  const st = (k) => P.byOp[k]?.status;
  assert(st('A|Voi') === 'aktiv' && st('C|Voi') === 'aktiv' && st('G|nextbike') === 'fest', `Betriebsgebiet: Stadt (täglich 40) und dauerhaft 4 Fahrzeuge aktiv, Stationen ohne Fahrzeug fest (${st('A|Voi')}, ${st('C|Voi')}, ${st('G|nextbike')})`);
  assert(st('B|Voi') === 'vereinzelt' && st('F|Bolt') === 'vereinzelt', `Vereinzelt: ab und zu ein E-Scooter (${P.byOp['B|Voi'].days} Tage, Median ${P.byOp['B|Voi'].median}) und dauerhaft nur 2 ohne Wachstum`);
  assert(st('D|Lime') === 'neu' && st('E|Dott') === 'neu' && st('H|Bolt') === 'neu', 'Neu: seit 2 Tagen 6 Fahrzeuge, Verdreifachung, Start mit 25 Fahrzeugen auf einmal');
  assert(P.byMuni.A.status === 'aktiv' && P.byMuni.B.status === 'vereinzelt' && P.counts.vereinzelt === 2 && V.muniShown({ presence: P.byMuni.A }) && !V.muniShown({ presence: P.byMuni.B }) && V.muniShown({}),
    `Gemeinde: bester Stand ihrer Anbieter; gezeigt außer vereinzelt (${JSON.stringify(P.counts)})`);
  // Abdeckung: mit Erkennung zählt der Stand, nicht die Momentaufnahme
  const lat = JSON.parse(JSON.stringify(latest));
  lat.municipalities['03241005'].presence = { status: 'aktiv', ops: { Dott: 'aktiv' } };
  const cv2 = V.coverage({ claims, latest: lat, features, daily, prev, now: Date.parse('2026-11-01T18:00:00Z') });
  assert(cv2.rows.some((r) => r.opKey === 'dott' && r.ags === '03241005') && !cv2.operators.find((o) => o.opKey === 'dott').stray, 'Abdeckung: Garbsen mit 4 Fahrzeugen, aber dauerhaft da (aktiv) → eigene Zeile statt Streuung');
}
