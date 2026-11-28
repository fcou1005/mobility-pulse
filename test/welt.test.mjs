// Reiter Länder, Stufe 1 (28.11.2026): lib/pulse-welt.js – Verzeichnis je Land, Kennzahlen je System, Abgänge über Position und Station,
// Stunden in Ortszeit, Städte, Anbieter-Namen.
import * as W from '../lib/pulse-welt.js';

let ok = 0, bad = 0;
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); if (s) { ok++; console.log(`ok: ${m}`); } else { bad++; console.log(`FEHLER ${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); } };

// Verzeichnis: Anführungszeichen mit Komma, Zeilenende \r\n, ohne Deutschland, ohne Zugangsdaten, unbekannte Länder weg, doppelte URL einmal
const csv = 'Country Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions,Authentication Info URL,Authentication Type,Authentication Parameter Name\r\n'
  + 'FR,"Vélo, Paris",Paris,v1,https://a,https://x/v1/gbfs.json,2.3,,,\r\n'
  + 'FR,Doppelt,Paris,v1b,https://a,https://x/v1/gbfs.json,2.3,,,\r\n'
  + 'FR,Mit Schlüssel,Lyon,k1,https://a,https://x/k1/gbfs.json,2.3,https://a,2,key\r\n'
  + 'DE,Berlin,Berlin,d1,https://a,https://x/d1/gbfs.json,2.3,,,\r\n'
  + 'US,NY,New York,u1,https://a,https://x/u1/gbfs.json,2.3,,,\r\n'
  + 'JP,HELLO CYCLING,Japan,hellocycling,https://a,https://api-public.odpt.org/api/v4/gbfs/hellocycling/gbfs.json,2.3,,,\r\n';
const cat = W.catalogByCountry(csv);
eq(Object.keys(cat).sort(), ['FR', 'JP'], 'Länder: Frankreich und Japan; Deutschland und USA nicht');
eq(cat.FR.map(s => [s.id, s.name, s.city]), [['v1', 'Vélo, Paris', 'Paris']], 'Komma in Anführungszeichen, doppelte URL einmal, System mit Zugangsdaten weg');
eq(Object.hasOwn(W.COUNTRIES, 'DE'), false, 'Deutschland nicht in der Länderliste (eigener Sammler)');

// Ortszeit: Paris im Winter UTC+1, Tokio UTC+9
eq(W.localDayHour(Date.parse('2026-11-28T23:30:00Z'), 'Europe/Paris'), { day: '2026-11-29', h: 0 }, 'Ortszeit Paris: nach Mitternacht schon der nächste Tag');
eq(W.localDayHour(Date.parse('2026-07-01T06:00:00Z'), 'Europe/London'), { day: '2026-07-01', h: 7 }, 'Ortszeit London mit Sommerzeit');
eq(W.localDayHour(Date.parse('2026-11-28T15:00:00Z'), 'Asia/Tokyo'), { day: '2026-11-29', h: 0 }, 'Ortszeit Tokio');

// Kennzahlen: frei abgestellt (gesperrt, reserviert nicht verfügbar), Stationen ohne virtuelle; Fahrzeuge mit station_id → Stationen nicht doppelt
const ff = { vehicleListPresent: true, vehicles: [
  { type: 'scooter', lat: 48.85, lon: 2.35 }, { type: 'scooter', lat: 48.86, lon: 2.35 }, { type: 'scooter', lat: 48.87, lon: 2.35, disabled: true }, { type: 'ebike', lat: 48.88, lon: 2.35, reserved: true },
], stations: [{ id: 'v', lat: 48.85, lon: 2.36, isVirtual: true, bookable: 0 }] };
const sf = W.summarize(ff);
eq([sf.avail, sf.disabled, sf.stations, sf.types, sf.free.length], [2, 1, 0, { scooter: 2 }, 2], 'frei abgestellt: verfügbar ohne gesperrt und reserviert, virtuelle Station zählt nicht');
const st = { vehicleListPresent: false, vehicles: [], stations: [
  { id: 's1', lat: 50.1, lon: 8.6, bookable: 0, docksAvailable: 5, installed: true, renting: true, returning: true, typeHint: 'bike' },
  { id: 's2', lat: 50.2, lon: 8.6, bookable: 7, docksAvailable: 0, installed: true, renting: true, returning: true, perType: { ebike: 2, bike: 5 } },
  { id: 's3', lat: 50.3, lon: 8.6, bookable: 0, docksAvailable: 3, installed: true, renting: false, returning: true, typeHint: 'bike' },
] };
const ss = W.summarize(st);
eq([ss.avail, ss.stations, ss.empty, ss.full, ss.types], [7, 3, 1, 1, { ebike: 2, bike: 5 }], 'Stationen: leer nur bei Ausleihe ohne Rad, voll ohne Platz, Arten aus den Stationen');
const dk = { vehicleListPresent: true, vehicles: [{ type: 'bike', lat: 50.1, lon: 8.6, stationId: 's1' }, { type: 'bike', lat: 50.1, lon: 8.6, stationId: 's1' }], stations: [{ id: 's1', lat: 50.1, lon: 8.6, bookable: 2, docksAvailable: 3, installed: true, renting: true, returning: true }] };
const sd = W.summarize(dk);
eq([sd.avail, sd.free.length, sd.st[0][3]], [2, 0, 2], 'Fahrzeuge mit station_id: einmal gezählt, nicht als frei abgestellt');

// Abgänge/Zugänge: neue Kennung am selben Ort zählt nicht; weggefahren zählt; Station über Bestandsänderung
/** @type {any} */
const prev = { free: [[48.85, 2.35], [48.86, 2.35], [48.87, 2.35]], st: [['s1', 0, 0, 5], ['s2', 0, 0, 1]] };
/** @type {any} */
const cur = { free: [[48.85001, 2.35001], [48.86, 2.35], [48.90, 2.40]], st: [['s1', 0, 0, 3], ['s2', 0, 0, 4], ['s9', 0, 0, 2]] };
eq(W.moves(prev, cur), { out: 1 + 2, in: 1 + 3 }, 'Abgänge: 1 frei abgestellt + 2 an s1; Zugänge: 1 neu + 3 an s2; neue Station s9 zählt nicht');
eq(W.moves(null, cur), { out: 0, in: 0 }, 'ohne vorigen Stand keine Bewegungen');

// Kartenzellen: Zellmitte und Anzahl
eq(W.cellsOf([[48.8501, 2.3501], [48.8502, 2.3502], [48.86, 2.35]]).map(c => c[2]).sort(), [1, 2], 'Kartenzellen zählen frei abgestellte Fahrzeuge je Zelle');

// Stunden: Mittel je System, Summe über Systeme; Abgänge je Stunde erst ab 10 Minuten
const day = { sys: {} };
W.addHour(day, 'a', 8, { avail: 100, stations: 10, empty: 2, full: 0, out: 10, in: 8, min: 20 });
W.addHour(day, 'a', 8, { avail: 80, stations: 10, empty: 4, full: 1, out: 6, in: 5, min: 20 });
W.addHour(day, 'b', 8, { avail: 50, stations: 0, empty: 0, full: 0 });
W.addHour(day, 'a', 7, { avail: 120, stations: 10, empty: 0, full: 0, out: 1, in: 1, min: 5 });
const hs = W.hourly(day);
eq(hs.map(r => [r.h, r.avail, r.out, r.outH]), [[7, 120, 1, null], [8, 140, 16, 24]], 'Stunden: Mittel 90 + 50 = 140, Abgänge 16 in 40 Min. = 24 je Stunde, 5 Min. zu wenig');
eq(W.hourly(day, 'a')[1].empty, 0.3, 'Anteil leerer Stationen eines Systems');

// Städte und Anbieter
const sysRows = [['a', 'Lime Paris', 'Paris', 'Lime', true, 500, 3, 0, 0, 0, { scooter: 500 }], ['b', 'Vélib', 'Paris', 'Vélib\'', true, 300, 1, 100, 10, 5, { bike: 200, ebike: 100 }], ['c', 'X', 'Lyon', 'X', true, 20, 0, 0, 0, 0, { scooter: 20 }]];
eq(W.citiesOf(sysRows).map(c => [c.city, c.systems, c.avail, c.ops.join('/')]), [['Paris', 2, 800, 'Lime/Vélib\''], ['Lyon', 1, 20, 'X']], 'Städte nach Bestand');
eq([W.operatorName('Lime Paris', null), W.operatorName('Getaround voiture', null), W.operatorName('TIER Paris', null), W.operatorName('Stadtrad', 'Unbekannt AG')], ['Lime', 'Getaround', 'Dott', 'Unbekannt AG'], 'Anbieter-Namen: Wortgrenzen (voiture ist nicht Voi), TIER → Dott');

// Stufe 2a: Tagtyp, Feiertage, Profil-Prognose, Selbstprüfung
eq([W.dayTypeOf('2026-11-27'), W.dayTypeOf('2026-11-28'), W.dayTypeOf('2026-11-29'), W.dayTypeOf('2026-11-27', new Set(['2026-11-27']))], ['W', 'S', 'H', 'H'], 'Tagtyp: Werktag, Samstag, Sonntag, Feiertag');
eq(W.holidaysOpen([{ startDate: '2026-12-25', endDate: '2026-12-26', nationwide: true }, { startDate: '2026-05-01', endDate: '2026-05-01', nationwide: false }]), ['2026-12-25', '2026-12-26'], 'OpenHolidays: nur landesweite, Zeiträume als Tage');
eq(W.holidaysJapan('\u56fd\u6c11,\u540d\r\n2026/1/12,x\r\nkaputt\r\n2026/11/3,y'), ['2026-01-12', '2026-11-03'], 'Japan: syukujitsu.csv, Datum unabhängig von der Kodierung der Namen');
const H = (/** @type {number} */ a, /** @type {number|null} */ o) => [{ h: 8, avail: a, empty: null, outH: o, out: 0, in: 0, min: 60 }];
const hist = [{ day: '2026-11-23', hours: H(100, 10) }, { day: '2026-11-24', hours: H(110, 20) }, { day: '2026-11-25', hours: H(120, 30) }, { day: '2026-11-28', hours: H(50, 5) }];
eq(W.profileForecast(hist, [{ day: '2026-11-26', h: 8 }, { day: '2026-11-26', h: 9 }, { day: '2026-11-29', h: 8 }], null).map(f => [f.avail, f.outH, f.n]), [[110, 20, 3], [null, null, 0], [null, null, 0]], 'Profil: Median der drei Werktage; ohne Stunde bzw. ohne zwei Sonntage keine Prognose');
eq(W.checkDay([...hist, { day: '2026-11-26', hours: H(99, 22) }], '2026-11-26', null), { day: '2026-11-26', hours: 1, wapeAvail: 0.111, wapeOut: 0.091 }, 'Selbstprüfung: Prognose 110/20 gegen 99/22');

console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
