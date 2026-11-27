// Geschäftsgebiet im Reiter ÖPNV (lib/pulse-oepnv-gebiet.js, 19.11.2026): bediente Zellen, Stationen innen und außen, Filter für die Seite
import * as GB from '../lib/pulse-oepnv-gebiet.js';
import * as NZ from '../lib/pulse-oepnv-karte.js';
import * as OX from '../lib/pulse-ops-extern.js';
import { cellOf, CELL_LAT, CELL_LON } from '../lib/pulse-track-rules.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

// Kern: 4 × 4 Zellen um die Neckarbrücke, je Tag ein verfügbares Fahrzeug; eine Zelle nur mit Fahrtbeginn (present 0) zählt nicht
const c0 = cellOf(48.52, 9.05), [a0, b0] = c0.split(':').map(Number), cells = {};
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) cells[`${a0 + i}:${b0 + j}`] = [1, 1, 5, 0];
cells[`${a0 + 30}:${b0}`] = [2, 0, 0, 0];
const docs = [{ day: '2026-11-17', fields: 'start,end,present,reloc', munis: { '08416041': cells, '08415061': { '1:1': [0, 0, 3, 0] } } }, { day: '2026-11-18', fields: 'start,end,present,reloc', munis: { '08416041': { [`${a0}:${b0}`]: [0, 0, 1, 0] } } }];
const S = GB.servedFrom(docs), sv = S.get('08416041');
assert(sv.size === 16 && !sv.has(`${a0 + 30}:${b0}`) && S.get('08415061').size === 1, `bediente Zellen: nur mit verfügbarem Fahrzeug (${sv.size})`);
const ctr = (i, j) => [(a0 + i) * CELL_LAT, (b0 + j) * CELL_LON], inG = (i, j) => { const [la, lo] = ctr(i, j); return GB.inGebiet(la, lo, sv); };
assert(inG(1, 1) && inG(4, 1) && !inG(5, 1) && !inG(1, 6), 'im Gebiet: eigene Zelle oder eine Zelle Rand, zwei daneben nicht');

const rows = [['1', 'Tü, Neckarbrücke', ...ctr(1, 1), 600], ['2', 'Tübingen Uni', ...ctr(4, 3), 300], ['3', 'Kilchberg Bahnhof', ...ctr(20, 1), 80], ['4', 'Pfrondorf Rathaus', ...ctr(-15, 9), 120]];
const g = GB.gebietOf(rows, sv, 7);
assert(g && g.inside === 2 && g.outside.join() === '4,3' && g.names.join() === 'Pfrondorf Rathaus,Kilchberg Bahnhof' && g.cells === 16 && g.days === 7, `Stationen außerhalb nach Halten (${JSON.stringify(g)})`);
assert(GB.gebietOf(rows, new Set(['1:1']), 7) === null && GB.gebietOf(rows, undefined, 7) === null, 'unter 10 bedienten Zellen kein Gebiet');

const F = GB.gebietFilter({ rows, gebiet: g }), off = GB.gebietFilter({ rows, gebiet: null });
assert(F.on && F.keepId('1') && F.keepId(2) && !F.keepId(3) && !F.keepId('4') && !off.on && off.keepId('3'), 'Filter: innen ja, außen nein; ohne Gebiet alles');

// Jetzt gestört: Station außerhalb bleibt in der Liste, aber ohne Bedarf (Stufe out, ganz hinten), auch ohne Fahrzeug daneben
const jetzt = [['3', 'Kilchberg Bahnhof', ...ctr(20, 1), 30, 9, 3], ['1', 'Tü, Neckarbrücke', ...ctr(1, 1), 40, 2, 10]];
const H = NZ.hotspotHints(jetzt, [], { keep: F.keepId });
assert(H.length === 2 && H[0].id === '1' && H[0].level === 'none' && H[1].id === '3' && H[1].level === 'out', `außerhalb: kein Bedarf (${H.map(x => `${x.id}:${x.level}`).join(' ')})`);
const spots = OX.oepnvSpots(jetzt.filter(r => F.keepId(r[0])), { vehicles: [] });
assert(spots.length === 1 && spots[0].cell === 'pt:1', 'Disposition: Ziel nur an der Station im Gebiet');

// Zählung je Gemeinde-Stunde nur im Gebiet (27.11.2026): Halt → innen/außen über seine Station; Gemeinde ohne Gebiet fehlt in der Map
{ const [la1, lo1] = ctr(1, 1), [la3, lo3] = ctr(20, 1);
  const ix = { id: ['h1', 'h2', 'h3', 'h4'], a: [0, 0, 0, 1], ags: ['08416041', '08415061'], s: [0, 1, -1, 2], st: { lat: [la1, la3, 48.49], lon: [lo1, lo3, 9.2], a: [0, 0, 1] } };
  const m = GB.stopAreaLookup(ix, S), A = GB.areaAgs(S);
  assert(m.get('h1') === true && m.get('h2') === false && !m.has('h3') && !m.has('h4') && A.has('08416041') && !A.has('08415061'),
    `Halt im Gebiet: Neckarbrücke ja, Kilchberg nein; Halt ohne Station und Gemeinde ohne Gebiet zählen überall mit (${[...m].join(' ')})`); }

console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
