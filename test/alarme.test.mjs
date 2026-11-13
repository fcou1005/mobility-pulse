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
