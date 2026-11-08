// Automatische Streik-Erkennung (lib/pulse-strike.js): Meldungen der tagesschau-App → Streiktage und Gebiet → Einträge für die Prognose.
// Texte unten sind frei formulierte Beispiele im Stil der Regionalmeldungen (keine Zitate).
import * as S from '../lib/pulse-strike.js';
import * as CX from '../lib/pulse-context.js';
import { readFileSync } from 'node:fs';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const ops = JSON.parse(readFileSync(new URL('../data/streik-betriebe.json', import.meta.url), 'utf8'));
const F = (ags, name, pop = 50000) => ({ properties: { ags, name, pop } });
const feats = [F('08111000', 'Stuttgart', 630000), F('05315000', 'Köln', 1080000), F('08317065', 'Lahr/Schwarzwald', 47000), F('08317096', 'Offenburg', 61000), F('08317057', 'Kehl', 37000),
  F('08317122', 'Schutterwald', 7000), F('08316011', 'Emmendingen', 28000), F('08121000', 'Heilbronn', 128000), F('08415061', 'Reutlingen', 117000), F('06412000', 'Frankfurt am Main', 770000),
  F('12053000', 'Frankfurt (Oder)', 57000), F('05113000', 'Essen', 580000), F('03241001', 'Hannover', 540000), F('03241010', 'Langenhagen', 55000), F('08335075', 'Singen (Hohentwiel)', 48000),
  F('05111000', 'Düsseldorf', 620000), F('05314000', 'Bonn', 330000)];
const P = S.strikePlaces(feats, ops);
const it = (o) => ({ type: 'story', regionIds: [], ...o });

// Tage
assert(S.strikeDays('In einigen Regionen fallen Donnerstag und Freitag wieder viele Busse aus. Ver.di hat zu Warnstreiks aufgerufen.', '2026-11-04').join() === '2026-11-05,2026-11-06', 'Wochentage angekündigt → die nächsten (Mi → Do, Fr)');
assert(S.strikeDays('Ein Warnstreik traf am Freitag viele Schüler.', '2026-11-07').join() === '2026-11-06', 'Vergangenheit → der letzte Freitag');
assert(S.strikeDays('Am Montag fallen wegen des Streiks Busse aus.', '2026-11-02').join() === '2026-11-02', 'Wochentag = Tag der Meldung');
assert(S.strikeDays('Der Streik ist für Montag und Dienstag angekündigt. Im Kreis wird gestreikt – bis einschließlich Mittwoch.', '2026-11-02').join() === '2026-11-02,2026-11-03,2026-11-04', 'Montag, Dienstag, bis einschließlich Mittwoch');
assert(S.strikeDays('Ver.di ruft vom 12. bis 14. November zum Warnstreik im Nahverkehr auf.', '2026-11-08').join() === '2026-11-12,2026-11-13,2026-11-14', 'Datumsbereich „12. bis 14. November“');
assert(S.strikeDays('Gestreikt wird am 5. und 6. November.', '2026-11-03').join() === '2026-11-05,2026-11-06', '„5. und 6. November“');
assert(S.strikeDays('Der Warnstreik am 3.12. trifft Busse und Bahnen.', '2026-11-28').join() === '2026-12-03', '„3.12.“');
assert(S.strikeDays('Am Freitag streiken die Busfahrer. Die Gespräche gehen am 20. November weiter.', '2026-11-08').join() === '2026-11-13', 'Datum in Satz ohne Streikbezug zählt nicht');
assert(S.strikeDays('Warnstreik bei Bussen und Bahnen: heute fährt fast nichts.', '2026-11-09').join() === '2026-11-09', '„heute“');
assert(S.strikeDays('Die Busse stehen morgen still, weil gestreikt wird.', '2026-11-09').join() === '2026-11-10' && S.strikeDays('Am Morgen fielen wegen des Streiks Busse aus.', '2026-11-09').join() === '', '„morgen“ ja, „am Morgen“ nein');
assert(S.strikeDays('Wegen des Streiks stellt die Bahn den Betrieb bis Montagfrüh ein.', '2026-10-31').join() === '2026-11-02', 'Wochentag mit Zusatz („Montagfrüh“)');
assert(S.strikeDays('Warnstreik am 5. November 2026', '2026-11-07').join() === '2026-11-05' && S.strikeDays('Warnstreik am 5. November 2025', '2026-11-07').join() === '', 'Jahr und Fenster');

// Meldungen
const sweg = it({ date: '2026-11-04T11:36:00.000+01:00', topline: 'Baden-Württemberg', title: 'Neue SWEG-Warnstreiks angekündigt', firstSentence: 'In einigen Regionen fallen Donnerstag und Freitag wieder viele Busse aus.', regionIds: [1], shareURL: 'https://www.swr.de/a',
  content: [{ type: 'text', value: '<strong>Ver.di hat erneut zu Warnstreiks aufgerufen.</strong>' }, { type: 'text', value: 'Der Streikaufruf betrifft die Bus-Standorte Emmendingen, Lahr, Offenburg, Schutterwald und Kehl.' }, { type: 'text', value: 'Sendung am Mi., 4.11.2026 15:19 Uhr, SWR Aktuell – Streik bei der SWEG' }] });
const c1 = S.strikeFromItem(sweg, P);
assert(c1 && c1.art === 'streik-oepnv' && c1.tage.join() === '2026-11-05,2026-11-06' && c1.sicher && c1.gebiet.ags.join() === '08316011,08317057,08317065,08317096,08317122', 'SWEG: Busse, Do/Fr, genannte Orte (Sendehinweis zählt nicht)');
assert(S.strikeFromItem(it({ date: '2026-11-03T10:00:00+01:00', title: '3.000 Menschen streiken bei Ford in Köln', firstSentence: 'Bei den Protesten der IG Metall machten viele mit.' }), P) === null, 'Streik ohne Busse/Bahnen: kein Kandidat');
assert(S.strikeFromItem(it({ date: '2026-11-03T10:00:00+01:00', title: 'Hochwasser: Busse fahren Umleitung', firstSentence: 'In Köln fahren Busse anders.' }), P) === null, 'Busse ohne Streik: kein Kandidat');
const ticker = S.strikeFromItem(it({ date: '2026-11-05T10:00:00+01:00', title: 'BW-Newsticker am Morgen: Stellenabbau, wegen Streiks fallen Busse in Lahr aus', firstSentence: 'Das Wichtigste am Morgen.', regionIds: [1] }), P);
assert(ticker && !ticker.sicher && ticker.sammel, 'Sammelmeldung (Newsticker) bleibt Hinweis');
const kreis = S.strikeFromItem(it({ date: '2026-11-02T06:52:00+01:00', title: 'Wo zum Schulstart viele Busse ausfallen', firstSentence: 'Es werden mehrere SWEG-Busbetriebe bestreikt.', regionIds: [1], content: [{ type: 'text', value: 'Auch im Kreis Heilbronn wird am Montag gestreikt.' }] }), P);
assert(kreis && kreis.tage.join() === '2026-11-02' && kreis.gebiet === null && !kreis.sicher, '„Kreis Heilbronn“ ist nicht die Stadt; SWEG ohne Gebiet → Hinweis');
const kreis2 = S.strikeFromItem(it({ date: '2026-10-28T16:27:00+01:00', title: 'Warnstreik bei der SWEG: Ausfälle bei Zügen am Donnerstag', firstSentence: 'Betroffen ist die Strecke in den Landkreisen Heilbronn und Reutlingen.', regionIds: [1] }), P);
assert(kreis2 && kreis2.gebiet === null, '„Landkreisen Heilbronn und Reutlingen“: beide sind Kreise, nicht die Städte');
const ffm = S.strikeFromItem(it({ date: '2026-11-08T08:00:00+01:00', title: 'Warnstreik bei der VGF', firstSentence: 'In Frankfurt stehen am Dienstag U-Bahnen und Straßenbahnen still.', regionIds: [7] }), P);
assert(ffm?.sicher && ffm.gebiet.ags.join() === '06412000' && ffm.tage.join() === '2026-11-10', 'Frankfurt = Frankfurt am Main (deutlich größer als Frankfurt (Oder)); Betrieb und Ort');
const essen = S.strikeFromItem(it({ date: '2026-11-08T08:00:00+01:00', title: 'Busfahrer streiken am Montag', firstSentence: 'Fahrgäste müssen sich auf Ausfälle einstellen, das Essen in der Kantine fällt aus.', regionIds: [10] }), P);
assert(essen && !essen.gebiet && !essen.sicher, 'Ortsname, der ein gewöhnliches Wort ist (Essen), nur mit Präposition');
const essen2 = S.strikeFromItem(it({ date: '2026-11-08T08:00:00+01:00', title: 'Busfahrer streiken am Montag', firstSentence: 'In Essen fallen Busse und Bahnen aus.', regionIds: [10] }), P);
assert(essen2?.gebiet?.ags?.join() === '05113000', '„in Essen“ zählt');
const hann = S.strikeFromItem(it({ date: '2026-11-07T18:00:00+01:00', title: 'Warnstreik bei Regiobus', firstSentence: 'In der Region Hannover fallen am Montag und Dienstag viele Busse aus.', regionIds: [9] }), P);
assert(hann?.sicher && hann.gebiet.ags.length === 8 && !hann.gebiet.ags.includes('03241001') && hann.tage.join() === '2026-11-09,2026-11-10', 'Regiobus: Gemeinden der Region (nicht die Stadt nach „Region“)');
const ssb = S.strikeFromItem(it({ date: '2026-11-08T08:00:00+01:00', title: 'SSB-Streik in Stuttgart', firstSentence: 'Am Mittwoch fahren keine Stadtbahnen.', regionIds: [1] }), P);
assert(ssb?.gebiet?.ags?.join() === '08111000' && ssb.grund.includes('SSB') && ssb.grund.includes('stuttgart'), 'Betrieb und Stadt zusammen: eine Gemeinde');
// Bahn
const gdl = S.strikeFromItem(it({ date: '2026-11-08T12:00:00+01:00', topline: 'Tarifstreit', title: 'GDL ruft zum Bahnstreik auf', firstSentence: 'Von Mittwoch bis Freitag sollen Fern- und Regionalzüge bestreikt werden.' }), P);
assert(gdl?.art === 'streik-bahn' && gdl.gebiet === 'DE' && gdl.tage.join() === '2026-11-11,2026-11-12,2026-11-13' && gdl.sicher, 'GDL: Bahnstreik bundesweit, Mi–Fr');
const saar = S.strikeFromItem(it({ date: '2026-10-23T14:59:00+02:00', topline: 'Saarland', title: 'Streik bei der Saarbahn – Demonstration der GDL', firstSentence: 'Die GDL zog am Freitag durch die Innenstadt.', regionIds: [12] }), P);
assert(saar?.art === 'streik-oepnv' && saar.gebiet?.ags?.join() === '10041100', 'Saarbahn (Stadtbahn) mit GDL: Nahverkehr, nicht Bahnstreik bundesweit');
const swegBahn = S.strikeFromItem(it({ date: '2026-10-28T16:27:00+01:00', title: 'Warnstreik bei SWEG: Ausfälle im Bahnverkehr am Donnerstag möglich', firstSentence: 'Auf mehreren Bahnstrecken kann es wegen eines Warnstreiks zu Ausfällen kommen.', regionIds: [1],
  content: [{ type: 'text', value: 'Hintergrund ist die bundesweite Tarifrunde zum Eisenbahntarifvertrag.' }] }), P);
assert(swegBahn?.art === 'streik-bahn' && swegBahn.gebiet === null && swegBahn.tage.join() === '2026-10-29', 'SWEG-Bahn: Bahn, „bundesweite Tarifrunde“ ist kein bundesweiter Streik');
const land = S.strikeFromItem(it({ date: '2026-11-08T12:00:00+01:00', title: 'Warnstreik im Nahverkehr', firstSentence: 'Ver.di ruft am Montag landesweit die Beschäftigten der kommunalen Verkehrsbetriebe zum Ausstand auf.', regionIds: [10] }), P);
assert(land?.gebiet?.laender?.join() === 'NW' && land.sicher && land.tage.join() === '2026-11-09', 'landesweit + Region der Meldung → Land');
// Absage
const off = S.strikeFromItem(it({ date: '2026-11-08T20:00:00+01:00', title: 'Warnstreik bei der VGF abgesagt', firstSentence: 'Die U-Bahnen in Frankfurt fahren am Dienstag doch.', shareURL: 'https://www.hr.de/off' }), P);
assert(off?.aus && !off.sicher, 'Absage erkannt');
const m1 = S.mergeStrikes(null, [ffm, off, c1], { now: Date.parse('2026-11-08T21:00:00Z') });
assert(m1.erkannt.length === 1 && m1.erkannt[0].link === 'https://www.swr.de/a' && m1.hinweise.some(h => h.abgesagt), 'Absage hebt den Streik im selben Gebiet und Tag auf');
const m2 = S.mergeStrikes(m1, [], { now: Date.parse('2027-01-20T00:00:00Z') });
assert(m2.erkannt.length === 0 && m2.hinweise.length === 0, 'nach 60 Tagen vergessen');
// Einträge für die Prognose
const doc = S.mergeStrikes(null, [c1, gdl, hann], { now: Date.parse('2026-11-08T21:00:00Z') });
const cur = [{ art: 'streik-oepnv', von: '2026-11-05', bis: '2026-11-06', gebiet: { ags: ['08317096'] }, titel: 'gepflegt', quelle: 'https://x' }];
const ent = S.strikeEntries(doc, cur);
assert(ent.length === 2 && ent.every(e => e.auto && e.quelle.startsWith('https://')) && !ent.some(e => e.von === '2026-11-05'), 'Doppel zum gepflegten Eintrag fällt weg');
assert(ent.find(e => e.art === 'streik-bahn')?.von === '2026-11-11' && ent.find(e => e.art === 'streik-bahn').bis === '2026-11-13' && /Bahnstreik/.test(ent.find(e => e.art === 'streik-bahn').titel), 'zusammenhängende Tage → ein Eintrag');
const chk = CX.checkCurated({ ereignisse: ent });
assert(chk.ok.length === ent.length && !chk.bad.length, 'Einträge bestehen die Prüfung der Ereignisliste');
const lk = CX.ctxLookup([], chk.ok);
assert(typeof lk === 'function' || typeof lk === 'object', 'Einträge lassen sich nachschlagen');
// Hilfen
assert(S.detailUrlOk('https://www.tagesschau.de/api2u/inland/regional/x-100.json') && !S.detailUrlOk('https://example.org/api2u/x.json') && !S.detailUrlOk('http://www.tagesschau.de/api2u/x.json'), 'Detail-Abruf nur tagesschau-App-JSON');
assert(S.strikeSearchUrl('Warnstreik', 1) === 'https://www.tagesschau.de/api2u/search/?searchText=Warnstreik&pageSize=30&resultPage=1' && S.searchItems({ searchResults: [{ a: 1 }, null] }).length === 1, 'Suchadresse und Treffer');
assert(S.areaOverlap({ laender: ['BW'] }, { ags: ['08111000'] }) && !S.areaOverlap({ ags: ['08111000'] }, { ags: ['05315000'] }) && S.areaOverlap('DE', { ags: ['1'] }), 'Gebiete überschneiden sich');
