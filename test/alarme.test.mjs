// Alarme und Feeds (S5.2, lib/pulse-alarme.js): Ereignisse aus dem Vergleich zweier Läufe, Protokoll, Atom-Feed nach RFC 4287
import * as AL from '../lib/pulse-alarme.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

const src = (id, op, status, zones, munis = ['08125000']) => ({ id, operator: op, status, municipalities: munis, zones: zones == null ? null : { count: zones } });
const plan = (rate) => [{ name: 'Standard', unlock: 1, perMin: [{ start: 0, rate }], perKm: [] }];
const lat0 = { sources: [src('voi_hn', 'Voi', 'live', 100), src('lime_hn', 'Lime', 'live', 40), src('dup', 'Lime', 'duplicate', 40)], groups: { '08125000|Voi|scooter': { total: 400 }, '08125000|Lime|scooter': { total: 300 } } };
const caps0 = [{ ags: '08125000', ort: 'Heilbronn', status: 'ok', total: 700, limit: 900, operators: [{ op: 'Voi', status: 'near', total: 400, limit: 450 }] }];
const s0 = AL.snapshot({ latest: lat0, caps: caps0, pricing: { plans: [{ sourceId: 'voi_hn', plans: plan(0.19) }] } });
assert(AL.detect(null, s0, { now: 1 }).length === 0, 'erster Lauf ohne vorigen Zustand: keine Alarme');
assert(AL.detect(s0, s0, { now: 2 }).length === 0, 'unveränderter Stand: keine Alarme');
const lat1 = { sources: [src('voi_hn', 'Voi', 'live', 112), src('lime_hn', 'Lime', 'error', 40), src('dup', 'Lime', 'gone', 40)], groups: { '08125000|Voi|scooter': { total: 470 }, '08125000|Lime|scooter': { total: 180 } } };
const caps1 = [{ ags: '08125000', ort: 'Heilbronn', status: 'ok', total: 650, limit: 900, operators: [{ op: 'Voi', status: 'over', total: 470, limit: 450 }] }];
const s1 = AL.snapshot({ latest: lat1, caps: caps1, pricing: { plans: [{ sourceId: 'voi_hn', plans: plan(0.22) }] } });
const ev = AL.detect(s0, s1, { now: 3, muniName: () => 'Heilbronn' });
const kinds = ev.map(x => x.kind).sort().join(',');
assert(kinds === 'cap,fleet,price,source,zone', `fünf Themen erkannt (${kinds})`);
assert(ev.find(x => x.kind === 'cap')?.op === 'Voi' && /470.*450/.test(ev.find(x => x.kind === 'cap').text), 'Obergrenze: Anbieter Voi, 470 bei erlaubten 450');
assert(ev.filter(x => x.kind === 'source').length === 1, 'Quelle aus: nur die gezählte Quelle, nicht die Dublette');
assert(ev.find(x => x.kind === 'fleet')?.op === 'Lime' && !ev.some(x => x.kind === 'fleet' && x.op === 'Voi'), 'Flottensprung: Lime −120 (−40 %), Voi +70 (+17,5 %) bleibt unter der Schwelle');
assert(AL.detect(s1, s1, { now: 4 }).length === 0, 'Obergrenze bleibt überschritten: kein zweiter Alarm');
// ÖPNV gestört (16.11.2026): Wechsel auf gestört, Ruhezeit 6 h, erster Lauf still, kleine Flotten nicht
{
  const H = 3600e3, lat = { sources: [], groups: { '08125000|Voi|scooter': { total: 400, available: 350 }, '08999999|Voi|scooter': { total: 50 }, '08125001|Voi|scooter': { total: 400 } } };
  const mk = (flag) => AL.snapshot({ latest: lat, pt: { '08125000': { day: '2026-11-16', hour: 16, n: 500, skip: flag ? 90 : 5, late: flag ? 110 : 30, flag }, '08999999': { day: '2026-11-16', hour: 16, n: 500, skip: 200, late: 0, flag: 1 }, '08125001': { day: '2026-11-16', hour: 16, n: 50, skip: 20, late: 0, flag: 1 } } });
  const a0 = AL.snapshot({ latest: lat }), a1 = mk(0), a2 = mk(1), a3 = mk(0), a4 = mk(1), a5 = mk(1);
  assert(AL.detect(a0, mk(1), { now: 10 * H }).length === 0, 'ÖPNV: erster Lauf mit ÖPNV-Zahlen meldet nichts');
  const e2 = AL.detect(a1, a2, { now: 20 * H, muniName: () => 'Heilbronn' });
  assert(e2.length === 1 && e2[0].kind === 'oepnv' && e2[0].ags === '08125000' && /18 % der 500 Halte/.test(e2[0].text) && /22 % waren/.test(e2[0].text) && /350 Sharing-Fahrzeuge/.test(e2[0].text), `ÖPNV: Wechsel auf gestört meldet einmal, mit Anteilen und Fahrzeugen (${e2[0]?.text})`);
  assert(AL.detect(a2, a3, { now: 21 * H }).length === 0 && AL.detect(a3, a4, { now: 22 * H }).length === 0, 'ÖPNV: erneut gestört nach 2 h bleibt still (Ruhezeit 6 h)');
  assert(AL.detect(a4, a5, { now: 23 * H }).length === 0, 'ÖPNV: bleibt gestört, kein zweiter Alarm');
  const b0 = mk(0); AL.detect(a5, b0, { now: 24 * H }); assert(AL.detect(b0, mk(1), { now: 27 * H }).length === 1, 'ÖPNV: nach 7 h Ruhe wieder ein Alarm');
  assert(!a2.pt['08999999'] && !a2.pt['08125001'], 'ÖPNV: Gemeinden unter 100 Fahrzeugen oder unter 150 Halten in der Stunde ohne Alarm');
}
// Protokoll: neue zuerst, 60 Tage
const log = AL.updateLog({ items: [{ id: 'alt', at: 3 - 61 * 864e5, ags: '08125000', kind: 'zone', title: 'x' }] }, ev, { now: 3, state: s1 });
assert(log.items.length === ev.length && log.items[0].at === 3, 'Protokoll: neue Einträge vorn, älter als 60 Tage fällt weg');
// Atom-Feed
const xml = AL.atomFeed({ ags: '08125000', name: 'Heilbronn <Stadt>', kind: null, items: log.items, base: 'https://fcou1005.github.io/mobility-pulse/', dataBase: 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/', since: 1 });
assert(/^<\?xml version="1\.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/.test(xml), 'Atom: XML-Kopf und Namensraum');
for (const el of ['id', 'title', 'updated', 'author']) assert(new RegExp(`<feed[^]*?<${el}[ >]`).test(xml), `Atom: <feed> hat <${el}>`);
assert(/<link rel="self" type="application\/atom\+xml" href="https:\/\/raw\.githubusercontent\.com\/fcou1005\/mobility-pulse\/data\/feeds\/08125000\.xml"\/>/.test(xml), 'Atom: rel="self" zeigt auf die Datei im Datenzweig');
const entries = xml.split('<entry>').slice(1);
assert(entries.length === ev.length && entries.every(e => /<id>tag:fcou1005\.github\.io,2026:[^<\s]+<\/id>/.test(e) && /<updated>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/updated>/.test(e) && /<title>[^<]+<\/title>/.test(e)), 'Atom: jeder Eintrag mit id (tag-URI ohne Leerzeichen), title, updated (RFC 3339)');
assert(xml.includes('Heilbronn &lt;Stadt&gt;') && !/<title>[^<]*<Stadt>/.test(xml), 'Atom: Sonderzeichen maskiert');
const opened = (xml.match(/<(feed|entry|author)\b/g) || []).length, closed = (xml.match(/<\/(feed|entry|author)>/g) || []).length;
assert(opened === closed, `Atom: Elemente geschlossen (${opened} = ${closed})`);
const one = AL.atomFeed({ ags: '08125000', name: 'Heilbronn', kind: 'cap', items: log.items, base: 'b/', dataBase: 'd/', since: 1 });
assert(one.split('<entry>').length === 2 && one.includes('feeds/08125000-cap.xml'), 'Feed je Thema: nur Einträge des Themas');
const empty = AL.atomFeed({ ags: '08111000', name: 'Stuttgart', kind: null, items: log.items, base: 'b/', dataBase: 'd/', since: 1794500000000 });
assert(!empty.includes('<entry>') && empty.includes(`<updated>${new Date(1794500000000).toISOString().replace(/\.\d{3}Z$/, 'Z')}</updated>`), 'leerer Feed: gültig, updated = fester Stand (keine Unruhe im Datenzweig)');
console.log(`${bad ? '✗' : '✓'} alarme: ${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad ? 1 : 0);
