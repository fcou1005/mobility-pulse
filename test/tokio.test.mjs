// Tokio im Reiter Vergleich (28.11.2026): lib/pulse-tokio.js – Ports in Tokio, Stand, Kennzahlen, Abgänge/Zugänge, Stunden in Ortszeit.
import * as TK from '../lib/pulse-tokio.js';

let ok = 0, bad = 0;
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); if (s) { ok++; console.log(`ok: ${m}`); } else { bad++; console.log(`FEHLER ${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); } };
const [docomo, hello] = TK.TOKIO.systems;

// Ortszeit: UTC+9 ohne Sommerzeit; 15:30 UTC ist schon der nächste Tag in Tokio
eq([TK.jstDay(Date.parse('2026-11-28T15:30:00Z')), TK.jstHour(Date.parse('2026-11-28T15:30:00Z'))], ['2026-11-29', 0], 'Ortszeit Tokio: Tag und Stunde');
eq([TK.jstDay(Date.parse('2026-07-01T14:59:00Z')), TK.jstHour(Date.parse('2026-07-01T14:59:00Z'))], ['2026-07-01', 23], 'Ortszeit im Sommer gleich (keine Sommerzeit)');

// Ports: docomo ganz (nur plausible Koordinaten), HELLO CYCLING nur mit Adresse 東京都; Plätze aus capacity oder vehicle_capacity (Text)
const infoD = [
  { station_id: '1131', lat: 35.760939, lon: 139.609264, name: 'T2-54.土支田農業公園', capacity: 9 },
  { station_id: 'x', lat: 0, lon: 0, name: 'kaputt' },
  { station_id: 'y', lat: 34.69, lon: 135.5, name: 'Osaka' },
];
eq(TK.tokyoStations(docomo, infoD), [['1131', 35.76094, 139.60926, 9, 'T2-54.土支田農業公園']], 'docomo: Port in Tokio, Koordinaten auf 5 Stellen, ohne Unsinn');
const infoH = [
  { station_id: '17', lat: 35.707252, lon: 139.777587, name: '新御徒町ステーション', address: '東京都台東区台東４丁目３１－１', vehicle_capacity: '8' },
  { station_id: '26', lat: 35.844371, lon: 139.658823, name: 'Saitama', address: '埼玉県さいたま市南区根岸５丁目６－１', vehicle_capacity: '10' },
  { station_id: '27', lat: 35.7, lon: 139.7, name: 'ohne Adresse' },
];
eq(TK.tokyoStations(hello, infoH), [['17', 35.70725, 139.77759, 8, '新御徒町ステーション']], 'HELLO CYCLING: nur Adresse in Tokio (Saitama und ohne Adresse fallen weg)');

// Stand: nur bekannte Ports; Zustand Bit 1 keine Ausleihe, Bit 2 keine Rückgabe (nicht installiert = beides)
const st = [
  { station_id: '1', num_bikes_available: 0, num_docks_available: 5, is_installed: true, is_renting: true, is_returning: true },
  { station_id: '2', num_bikes_available: 4, num_docks_available: 0, is_installed: true, is_renting: true, is_returning: true },
  { station_id: '3', num_bikes_available: 2, num_docks_available: 2, is_installed: true, is_renting: false, is_returning: true },
  { station_id: '4', num_bikes_available: 1, num_docks_available: 1, is_installed: false },
  { station_id: '9', num_bikes_available: 7, num_docks_available: 1 },
];
const rows = TK.standRows('docomo', st, new Set(['1', '2', '3', '4']));
eq(rows, [['docomo', '1', 0, 5, 0], ['docomo', '2', 4, 0, 0], ['docomo', '3', 2, 2, 1], ['docomo', '4', 1, 1, 3]], 'Stand je Port mit Zustand, unbekannter Port 9 fehlt');
eq(TK.summarize(rows), { docomo: { ports: 4, bikes: 7, docks: 8, empty: 1, full: 1, off: 2 } }, 'Kennzahlen: leer nur ausleihbar ohne Rad, voll nur mit Rückgabe ohne Platz');

// Abgänge/Zugänge: Summe der Änderungen je Port, der in beiden Ständen vorkommt
const prev = [['docomo', '1', 3, 2, 0], ['docomo', '2', 4, 0, 0], ['hello', '7', 0, 5, 0], ['docomo', 'weg', 9, 0, 0]];
const cur = [['docomo', '1', 0, 5, 0], ['docomo', '2', 6, 0, 0], ['hello', '7', 2, 3, 0], ['hello', 'neu', 5, 0, 0]];
eq(TK.moves(prev, cur), { docomo: { out: 3, in: 2, n: 2 }, hello: { out: 0, in: 2, n: 1 } }, 'Abgänge und Zugänge je System, neue und verschwundene Ports zählen nicht');

// Stunden: Summen über die Läufe, Mittel und Anteile; Abgänge je Stunde erst ab 10 Minuten Vergleich
const day = { sys: {} };
TK.addHour(day, 'docomo', 8, { bikes: 100, ports: 20, empty: 2, full: 1, out: 6, in: 4, min: 20 });
TK.addHour(day, 'docomo', 8, { bikes: 80, ports: 20, empty: 4, full: 1, out: 10, in: 2, min: 20 });
TK.addHour(day, 'docomo', 7, { bikes: 120, ports: 20, empty: 0, full: 0 });
eq(day.sys.docomo.map(r => r[0]), [7, 8], 'Zeilen nach Stunde sortiert');
eq(TK.hourly(day, 'docomo'), [{ h: 7, runs: 1, bikes: 120, empty: 0, full: 0, outH: null, out: 0, in: 0, min: 0 }, { h: 8, runs: 2, bikes: 90, empty: 0.15, full: 0.05, outH: 24, out: 16, in: 6, min: 40 }], 'Mittel der Räder, Anteil leer/voll, Abgänge je Stunde hochgerechnet');
eq(TK.dayTotals(day, 'docomo'), { out: 16, in: 6, min: 40 }, 'Tagessumme');
eq(TK.dayTotals(day, 'hello'), { out: 0, in: 0, min: 0 }, 'System ohne Zeilen: null');

console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
