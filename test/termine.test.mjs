// Termine aus Quellenseiten (lib/pulse-termine.js, scripts/termine.mjs): Regeln, Prüfung der Modell-Antworten, Zeitfenster, Zusammenführen und ein
// ganzer Lauf gegen einen lokalen Testserver mit nachgebildetem Sprachmodell (eigener Port, nicht 8765).
import * as TM from '../lib/pulse-termine.js';
import * as CX from '../lib/pulse-context.js';
import { dayOf } from '../lib/pulse-track.js';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };

// Quellen prüfen
const chk = TM.checkSources({ quellen: [{ name: 'Wasen', url: 'https://wasen.example/', ags: '08111000', art: 'volksfest' }, { name: 'X', url: 'http://x.example/', ags: '1', art: 'kino' }, { name: 'Wasen', url: 'https://wasen.example/', ags: '08111000', art: 'volksfest' }] });
assert(chk.ok.length === 1 && chk.bad.length === 2 && chk.ok[0].id === 'wasen-08111000' && /Adresse, AGS, Art/.test(chk.bad[0]) && /doppelt/.test(chk.bad[1]), 'Quellen: Adresse, AGS, Art, Doppel geprüft; ID aus Name und AGS');

// Text und Ausschnitte
const html = `<html><head><script>var x = "25.09.2027";</script><style>.a{}</style></head><body><nav>Start | Programm</nav><h1>Cannstatter Volksfest</h1><p>Das 182. Cannstatter Volksfest findet vom <b>25.09. – 11.10.2027</b> statt.</p><div>Öffnungszeiten täglich ab 11 Uhr</div><footer>Impressum 01.01.2020</footer></body></html>`;
const lines = TM.pageLines(html);
assert(lines.includes('Cannstatter Volksfest') && lines.some(l => l.includes('vom 25.09. – 11.10.2027 statt')) && !lines.some(l => /Impressum|var x|Programm/.test(l)), 'Seitentext: Blöcke als Zeilen, ohne Skript, Navigation und Fußzeile');
const many = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? `Termin ${i}: ${1 + (i % 28)}.03.2027 Konzert` : `Fülltext ${i} ohne Datum, der nur Platz braucht und nichts sagt.`));
const ch = TM.dateChunks(many, { chunkChars: 1000 });
assert(ch.length >= 2 && ch.length <= 4 && ch.every(c => c.length <= 1100) && ch[0].includes('Termin 0: 1.03.2027') && !ch.join('').includes('Fülltext 5 '), 'Ausschnitte: nur Umfeld von Datumszeilen, in Stücken, höchstens 4');

// Prüfung der Modell-Antwort
const q = { id: 'wasen-08111000', name: 'Cannstatter Volksfest', url: 'https://wasen.example/', ags: '08111000', art: 'volksfest', ort: 'Cannstatter Wasen', besucher: 4000000 };
const chunk = 'Das 182. Cannstatter Volksfest findet vom 25.09. – 11.10.2027 statt.\nFrühlingsfest 17. April bis 9. Mai 2027';
const T = (o) => ({ titel: 'Cannstatter Volksfest', datumText: '25.09. – 11.10.2027', beginn: '2027-09-25', ende: '2027-10-11', uhrVon: '', uhrBis: '', abgesagt: false, ...o });
assert(TM.checkTermin(T(), q, chunk, '2026-11-08').ok, 'Termin mit wörtlichem Datumstext und passenden Tagen');
assert(TM.checkTermin(T({ datumText: '26.09. – 11.10.2027' }), q, chunk, '2026-11-08').why === 'Datumstext nicht im Text', 'erfundener Datumstext fällt weg');
assert(TM.checkTermin(T({ beginn: '2027-09-24' }), q, chunk, '2026-11-08').why === 'Datum passt nicht zum Text', 'Beginn passt nicht zum Datumstext');
assert(TM.checkTermin(T({ beginn: '2026-09-25', ende: '2026-10-11', datumText: '25.09. – 11.10.2027' }), q, chunk, '2026-11-08').why === 'Datum passt nicht zum Text', 'falsches Jahr (Text nennt 2027)');
assert(TM.checkTermin(T({ titel: 'Frühlingsfest', datumText: '17. April bis 9. Mai 2027', beginn: '2027-04-17', ende: '2027-05-09' }), q, chunk, '2026-11-08').ok, '„17. April bis 9. Mai 2027“: Monatsnamen und Spanne');
assert(TM.checkTermin(T({ beginn: '2027-09-25', ende: '2027-11-30', datumText: '25.09. – 11.10.2027' }), q, chunk, '2026-11-08').ok === false, 'Ende passt nicht / zu lang');
assert(TM.checkTermin(T({ abgesagt: true }), q, chunk, '2026-11-08').why === 'abgesagt' && TM.checkTermin(T({ titel: 'Weihnachtsmarkt am Wasen' }), q, chunk, '2026-11-08').ok === false, 'abgesagt und Weihnachtsmarkt fallen weg');
assert(TM.checkTermin(T(), q, chunk, '2027-10-12').why === 'außerhalb', 'vorbei');
const qm = { ...q, art: 'messe', name: 'Messe' };
assert(TM.checkTermin({ titel: 'CMT', beginn: '2027-01-16', ende: '2027-01-24', uhrVon: '', uhrBis: '' }, qm, null, '2026-11-08').ok && TM.checkTermin({ titel: 'Lange Messe', beginn: '2027-01-01', ende: '2027-01-20' }, qm, null, '2026-11-08').why === '20 Tage', 'Regeln (ohne Ausschnitt): Dauer ≤ 10 Tage außer Volksfest');
assert(TM.checkTermin({ titel: 'Volksfest', datumText: 'September 24 – October 10, 2027', beginn: '2027-09-24', ende: '2027-10-10', uhrVon: '', uhrBis: '' }, q, 'The festival runs September 24 – October 10, 2027.', '2026-11-08').ok
  && TM.checkTermin({ titel: 'Marathon', datumText: '25 April 2027', beginn: '2027-04-25', ende: '2027-04-25' }, { ...q, art: 'lauf' }, 'Race day: 25 April 2027', '2026-11-08').ok
  && TM.dateChunks(['Race day', 'Sunday, April 25, 2027', 'x']).length === 1, 'englische Seiten: „September 24 – October 10, 2027“, „25 April 2027“');
assert(TM.datePartsOf('5./6. Juni 2027').map(p => `${p.d}.${p.m}.${p.y}`).sort().join() === '5.6.2027,6.6.2027' && TM.datePartsOf('Sa., 14. März').some(p => p.d === 14 && p.m === 3 && p.y === null), 'Datumsteile: „5./6. Juni 2027“, „14. März“');

// Zeitfenster
const ev = TM.terminEntries(T({ beginn: '2027-09-25', ende: '2027-09-26' }), q, { stand: '2026-11-08' });
assert(ev.length === 2 && ev[0].art === 'volksfest' && ev[0].von === '2027-09-25T11:00' && ev[0].bis === '2027-09-25T23:00' && ev[0].ohneUhrzeit && ev[0].gebiet.ags[0] === '08111000' && ev[0].auto && ev[0].quelleId === q.id && /^termin:/.test(ev[0].id), 'Volksfest ohne Uhrzeit: 11–23 Uhr je Tag');
const ek = TM.terminEntries({ titel: 'Band X', beginn: '2027-03-14', ende: '2027-03-14', uhrVon: '20:00', uhrBis: '' }, { ...q, art: 'konzert' });
assert(ek.length === 1 && ek[0].art === 'veranstaltung' && ek[0].kategorie === 'konzert' && ek[0].von === '2027-03-14T19:00' && ek[0].bis === '2027-03-14T23:00' && ek[0].beginn === '2027-03-14T20:00', 'Konzert 20 Uhr: 19–23 Uhr');
const em = TM.terminEntries({ titel: 'Messe', beginn: '2027-03-14', ende: '2027-03-14', uhrVon: '', uhrBis: '' }, qm);
assert(em[0].von === '2027-03-14T10:00' && em[0].bis === '2027-03-14T22:00', 'Messe ohne Uhrzeit: 10–22 Uhr');
assert(CX.checkCurated({ ereignisse: [...ev, ...ek, ...em] }).ok.length === 4, 'Einträge bestehen die Prüfung der Ereignisliste');

// Regeln: schema.org mit Ende und Status, ICS
const ld = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Event","name":"CMT 2027","startDate":"2027-01-16","endDate":"2027-01-24","url":"/cmt"},{"@type":"MusicEvent","name":"Abgesagt","startDate":"2027-02-01T20:00","eventStatus":"https://schema.org/EventCancelled"}]}</script>`;
const lr = TM.ldTermine(ld, 'https://messe.example/kalender');
assert(lr.length === 2 && lr[0].ende === '2027-01-24' && lr[0].url === 'https://messe.example/cmt' && lr[1].abgesagt && lr[1].uhrVon === '20:00', 'schema.org: Ende, Adresse, Status abgesagt, Uhrzeit');
const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Lauf\r\nDTSTART;VALUE=DATE:20270418\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
assert(TM.ruleTermine(ics, { ...q, art: 'lauf', format: 'ics' })[0]?.beginn === '2027-04-18', 'ICS');
const tt = TM.textTermin(TM.pageLines(html), q, '2026-11-08');
assert(tt.length === 1 && tt[0].beginn === '2027-09-25' && tt[0].ende === '2027-10-11' && TM.checkTermin(tt[0], q, tt[0].datumText, '2026-11-08').ok, 'Textregel ohne Modell: Zeile mit Name und Datum');

// Zusammenführen
const now = Date.parse('2026-11-08T03:00:00Z'), today = dayOf(now);
const old = [{ id: 'termin:a', quelleId: 'w', von: '2026-10-01T11:00', bis: '2026-10-01T23:00' }, { id: 'termin:b', quelleId: 'w', von: '2026-12-01T11:00', bis: '2026-12-01T23:00' }, { id: 'termin:c', quelleId: 'm', von: '2027-01-16T10:00', bis: '2027-01-16T22:00' }, { id: 'termin:z', quelleId: 'w', von: '2026-08-01T11:00', bis: '2026-08-01T23:00' }];
const neu = [{ id: 'termin:d', quelleId: 'w', von: '2027-04-17T11:00', bis: '2027-04-17T23:00' }];
const mg = TM.mergeTermine({ termine: old }, [{ q: { id: 'w' }, ok: true, entries: neu }, { q: { id: 'm' }, ok: false, entries: [] }], { now });
assert(mg.map(e => e.id).join() === 'termin:a,termin:c,termin:d', `Zusammenführen: Vergangenes bleibt (60 Tage), Künftiges der gelesenen Quelle ersetzt, ungelesene Quelle behält (${mg.map(e => e.id)})`);
void today;
// Doppel zur gepflegten Liste
const cur = [{ art: 'volksfest', von: '2027-09-25T11:00', gebiet: { ags: ['08111000'] }, titel: 'Cannstatter Wasen' }, { art: 'veranstaltung', von: '2027-03-14T19:00', gebiet: { ags: ['08111000'] }, titel: 'Helene Fischer – Tour 2027' }];
const wc = TM.withoutCurated([...ev, { ...ek[0], titel: 'Helene Fischer' }, { ...ek[0], titel: 'Andere Gruppe', id: 'x' }], cur);
assert(wc.length === 2 && wc.some(e => e.von.startsWith('2027-09-26')) && wc.some(e => e.titel === 'Andere Gruppe'), 'gleiches Volksfest am selben Tag bzw. gleicher Titelteil fällt weg');

// Ganzer Lauf: Testserver mit vier Seiten und nachgebildetem Sprachmodell
{
  const nextYear = new Date(now).getUTCFullYear() + 1, y = new Date().getUTCFullYear() + 1, calls = [];
  const pages = {
    '/robots.txt': 'User-agent: *\nDisallow: /geheim\n',
    '/volksfest': `<html><body><h1>Großes Stadtfest</h1><p>Das Stadtfest ${y} feiern wir vom 12.06. – 14.06.${y} in der Innenstadt.</p></body></html>`,
    '/messe': `<html><head><script type="application/ld+json">[{"@type":"Event","name":"Testmesse","startDate":"${y}-02-03","endDate":"${y}-02-05"}]</script></head><body>Messen</body></html>`,
    '/geheim': '<p>12.06.2027</p>',
    '/fest': `<html><body><div>Rhein in Lichtern</div><p>Am Samstag, 8. Mai ${y} ab 18 Uhr leuchtet das Ufer.</p><p>Vorverkauf ab 1. März ${y}.</p></body></html>`,
  };
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      let b = ''; req.on('data', d => (b += d)).on('end', () => {
        const j = JSON.parse(b); calls.push(j); const txt = j.messages[1].content;
        const termine = txt.includes('Rhein in Lichtern') ? [{ titel: 'Rhein in Lichtern', datumText: `Samstag, 8. Mai ${y}`, beginn: `${y}-05-08`, ende: `${y}-05-08`, uhrVon: '18:00', uhrBis: '', abgesagt: false },
          { titel: 'Erfunden', datumText: `9. Mai ${y}`, beginn: `${y}-05-09`, ende: `${y}-05-09`, uhrVon: '', uhrBis: '', abgesagt: false }] : [];
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ termine }) } }] }));
      }); return;
    }
    const p = pages[req.url]; res.writeHead(p ? 200 : 404, { 'content-type': req.url === '/robots.txt' ? 'text/plain' : 'text/html; charset=utf-8' }); res.end(p || '');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`, dir = await mkdtemp(path.join(tmpdir(), 'termine-'));
  await writeFile(path.join(dir, 'q.json'), JSON.stringify({ quellen: [
    { name: 'Großes Stadtfest', url: `${base}/volksfest`, ags: '08416041', art: 'volksfest', stichwort: 'Stadtfest' }, { name: 'Testmesse', url: `${base}/messe`, ags: '08416041', art: 'messe' },
    { name: 'Gesperrt', url: `${base}/geheim`, ags: '08416041', art: 'fest' }, { name: 'Rhein in Lichtern', url: `${base}/fest`, ags: '05314000', art: 'fest' }] }));
  const run = (env) => new Promise(r => spawn('node', ['scripts/termine.mjs', path.join(dir, 'q.json'), '-', path.join(dir, 'out.json')], { stdio: 'inherit', env: { ...process.env, ...env } }).on('exit', r));
  await run({ LLM_URL: base });
  const o = JSON.parse(await readFile(path.join(dir, 'out.json'), 'utf8')), S = Object.fromEntries(o.quellen.map(x => [x.name, x]));
  const byT = (t) => o.termine.filter(e => e.titel === t);
  assert(S.Testmesse?.via === 'regel' && byT('Testmesse').length === 3 && byT('Testmesse')[0].von === `${y}-02-03T10:00`, 'Lauf: Messe aus schema.org (3 Tage), ohne Modell');
  assert(S['Gesperrt']?.status === 'fehler' && /robots/.test(S['Gesperrt'].fehler), 'Lauf: robots.txt-Sperre beachtet');
  assert(S['Rhein in Lichtern']?.via === 'modell' && byT('Rhein in Lichtern').length === 1 && byT('Rhein in Lichtern')[0].von === `${y}-05-08T17:00` && byT('Erfunden').length === 0 && S['Rhein in Lichtern'].verworfen?.['Datumstext nicht im Text'] === 1,
    'Lauf: Modell liest die Festseite; erfundener Termin (Datum nicht im Text) fällt weg');
  assert(S['Großes Stadtfest']?.via === 'modell' && S['Großes Stadtfest'].termine === 0, 'Lauf: Modell ohne Treffer → keine Termine (Textregel nur ohne Modell)');
  assert(calls.length >= 2 && calls.every(c => c.response_format?.type === 'json_schema' && c.temperature === 0), 'Lauf: Modell mit JSON-Schema und Temperatur 0');
  assert(o.termine.every(e => CX.checkCurated({ ereignisse: [e] }).ok.length === 1), 'Lauf: alle Einträge gültig für die Ereignisliste');
  // ohne Modell: Textregel für die Seite einer einzelnen Veranstaltung; Vorlauf bleibt erhalten
  await writeFile(path.join(dir, 'prev.json'), JSON.stringify(o));
  await new Promise(r => spawn('node', ['scripts/termine.mjs', path.join(dir, 'q.json'), path.join(dir, 'prev.json'), path.join(dir, 'out2.json')], { stdio: 'inherit', env: { ...process.env, TERMINE_FAKE: '1' } }).on('exit', r));
  const o2 = JSON.parse(await readFile(path.join(dir, 'out2.json'), 'utf8')), S2 = Object.fromEntries(o2.quellen.map(x => [x.name, x]));
  assert(S2['Großes Stadtfest']?.via === 'textregel' && o2.termine.filter(e => e.titel === 'Großes Stadtfest').length === 3 && o2.termine.some(e => e.titel === 'Rhein in Lichtern') && o2.modell.startsWith('ohne'),
    'ohne Modell: Textregel findet das Stadtfest (3 Tage); Termine des Modells aus dem Vorlauf bleiben');
  srv.close(); void nextYear;
}
