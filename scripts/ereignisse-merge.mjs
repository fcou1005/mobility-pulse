// Recherche je Stadt (Auftrag: scripts/ereignisse-recherche.md, je Region eine JSON-Datei) → Einträge für data/ereignisse.json (art veranstaltung):
// geprüft (Gemeinde mit Sharing-Daten, Datum, Quelle, nicht wochenlang außer Volksfesten (art volksfest, bis 31 Tage), nicht abgesagt), je Tag ein Eintrag mit Zeitfenster wie Sport/Hallen
// (Beginn − 60 Min. bis Ende + 60 Min. bzw. Beginn + 3 Std.; Umzug/Messe ohne Ende bis 22 Uhr; ohne Uhrzeit 17–23 bzw. 10–22 Uhr), ohne Dubletten.
// Aufruf: [FROM=JJJJ-MM-TT] [TO=JJJJ-MM-TT] node scripts/ereignisse-merge.mjs <Recherche-Ordner> <boundaries/index.json> <Vorschau.json> [--write] [--rolling]
// --write ersetzt alle Einträge mit id „recherche:…“ in data/ereignisse.json; gepflegte Einträge ohne diese id bleiben.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const [dir, idxFile, out, flag] = process.argv.slice(2), repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
if (!dir || !idxFile || !out) { console.error('Aufruf: node scripts/ereignisse-merge.mjs <Recherche-Ordner> <boundaries/index.json> <Vorschau.json> [--write]'); process.exit(2); }
const FROM = process.env.FROM || '2026-10-31', TO = process.env.TO || '2027-02-10', STAND = new Date().toISOString().slice(0, 10);
const FIX = { '08116033': '08116078', '08215111': '08215108' }; // Leinfelden-Echterdingen, Rheinstetten (im Auftrag falsch angegeben)
const GONE = /verschoben|abgesagt|UFO-Bühne|Lichterglanz/i;
const NO = /weihnachtsmarkt|christkindl|wintertraum|eiswelt|winterzauber|weihnachtszirkus|weihnachtscircus|lichterzauber im zoo|winterwelt|eislaufbahn|adventsmarkt/i;
const pad = (n) => String(n).padStart(2, '0');
const addMin = (day, hhmm, min) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, m) + min * 60e3); return `${d.toISOString().slice(0, 10)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const floorH = (s) => `${s.slice(0, 13)}:00`;
const days = (a, b) => { const o = []; for (let t = Date.parse(`${a}T12:00:00Z`); t <= Date.parse(`${b}T12:00:00Z`); t += 864e5) o.push(new Date(t).toISOString().slice(0, 10)); return o; };
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
// „Muse (PSD Bank Dome)“ mit Ort „PSD BANK DOME“ → „Muse“; weitere Angaben in der Klammer bleiben („Holiday on Ice (Shows 16 und 19 Uhr)“)
const cleanTitle = (t, ort) => String(t || '').replace(/\s*\(([^()]*)\)\s*$/, (m, inner) => {
  const o = norm(ort), parts = inner.split(/,\s*/), keep = parts.filter((p, i) => !(i === 0 && norm(p).length >= 4 && (o.includes(norm(p)) || norm(p).includes(o) && o.length >= 4)));
  return keep.length === parts.length ? m : keep.length ? ` (${keep.join(', ')})` : '';
}).trim();
const isT = (s) => /^\d{2}:\d{2}$/.test(String(s || ''));

const idx = JSON.parse(await readFile(idxFile, 'utf8')), ACTIVE = new Set(Object.values(idx.states || {}).flatMap(s => s.ags || []));
const files = (await readdir(dir)).filter(f => f.endsWith('.json') && !f.startsWith('_'));
const cur = JSON.parse(await readFile(path.join(repo, 'data', 'ereignisse.json'), 'utf8'));
// --rolling (laufende Aktualisierung): nur ersetzen, was diese Recherche abdeckt – recherchierte Einträge ab FROM für die Gemeinden unter
// „geprueft“ und die Art laut „umfang“ der Datei (voll = Veranstaltungen, volksfest = Volksfeste, ergaenzung/ohne Angabe = nichts ersetzen);
// ohne --rolling ersetzt --write alle recherchierten Einträge (Neuaufbau aus allen Dateien)
const rolling = process.argv.includes('--rolling'), docs = [];
for (const f of files) { try { docs.push([f, JSON.parse(await readFile(path.join(dir, f), 'utf8'))]); } catch (e) { console.log(`${f}: kein JSON (${e.message})`); } }
const ART_OF = { voll: 'veranstaltung', volksfest: 'volksfest' }, replace = new Set();
for (const [, doc] of docs) { const art = ART_OF[doc.umfang]; if (art) for (const g of doc.geprueft || []) if (g?.ags) replace.add(`${FIX[g.ags] || g.ags}|${art}`); }
const isRech = (e) => String(e.id || '').startsWith('recherche:');
const gone = (e) => isRech(e) && (!rolling || (replace.has(`${e.gebiet?.ags?.[0]}|${e.art}`) && String(e.von).slice(0, 10) >= FROM && String(e.von).slice(0, 10) <= TO)); // nur im Fenster der Recherche
const n0 = cur.ereignisse.length, kept = cur.ereignisse.filter(e => !gone(e));
const have = new Set(kept.filter(e => rolling || !isRech(e)).map(e => `${e.gebiet?.ags?.[0]}|${String(e.von).slice(0, 10)}|${norm(e.titel).slice(0, 14)}`));
const entries = [], drop = [], perCity = {}, checked = [];
for (const [f, doc] of docs) {
  checked.push(...(doc.geprueft || []).map(g => `${g.stadt} (${g.ags})`));
  for (const v of doc.veranstaltungen || []) {
    if (FIX[v.ags]) v.ags = FIX[v.ags];
    const why = [];
    if (GONE.test(`${v.titel} ${v.ort}`)) why.push('abgesagt/verschoben/klein');
    if (ACTIVE.size && !ACTIVE.has(v.ags)) why.push('Gemeinde ohne Sharing-Daten');
    if (!/^\d{8}$/.test(v.ags || '')) why.push('AGS');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.beginn || '') || !/^\d{4}-\d{2}-\d{2}$/.test(v.ende || v.beginn)) why.push('Datum');
    if (!/^https:\/\//.test(v.quelle || '')) why.push('Quelle');
    if (NO.test(`${v.titel} ${v.ort}`)) why.push('wochenlang/Weihnachtsmarkt');
    const ende = v.ende || v.beginn, dl = why.length ? [] : days(v.beginn, ende);
    const fest = String(v.kategorie || '').toLowerCase() === 'volksfest'; // Volksfeste (eigenes Merkmal fest) dürfen mehrere Wochen dauern
    if (!why.length && dl.length > (fest ? 31 : 10)) why.push(`${dl.length} Tage`);
    if (!why.length && (ende < FROM || v.beginn > TO)) why.push('außerhalb');
    if (why.length) { drop.push(`${v.stadt}: ${v.titel} (${why.join(', ')})`); continue; }
    const kat = String(v.kategorie || '').toLowerCase(), dayLong = ['messe', 'fest', 'karneval', 'demo', 'lauf', 'volksfest'].includes(kat);
    for (const d of dl) {
      if (d < FROM || d > TO) continue;
      let von, bis, beginn;
      if (isT(v.uhrVon)) {
        beginn = `${d}T${v.uhrVon}`; von = floorH(addMin(d, v.uhrVon, -60));
        bis = isT(v.uhrBis) ? addMin(d, v.uhrBis, (v.uhrBis < v.uhrVon ? 24 * 60 : 0) + 60) : addMin(d, v.uhrVon, 180);
        if (!isT(v.uhrBis) && dayLong && bis < `${d}T22:00`) bis = `${d}T22:00`; // Umzug, Straßenkarneval, Messe ohne Ende: bis abends
      } else if (kat === 'volksfest') { beginn = `${d}T11:00`; von = `${d}T11:00`; bis = `${d}T23:00`; }
      else if (dayLong) { beginn = `${d}T10:00`; von = `${d}T10:00`; bis = `${d}T22:00`; }
      else { beginn = `${d}T17:00`; von = `${d}T17:00`; bis = `${d}T23:00`; }
      const key = `${v.ags}|${d}|${norm(v.titel).slice(0, 14)}`; if (have.has(key)) { drop.push(`${v.stadt}: ${v.titel} ${d} (doppelt)`); continue; } have.add(key);
      const id = 'recherche:' + crypto.createHash('sha1').update(`${v.ags}|${d}|${norm(v.titel)}`).digest('hex').slice(0, 10);
      entries.push({ art: fest ? 'volksfest' : 'veranstaltung', von, bis, beginn, ...(isT(v.uhrVon) ? {} : { ohneUhrzeit: true }), gebiet: { ags: [v.ags] }, titel: cleanTitle(v.titel, v.ort).slice(0, 160), ort: v.ort || null, besucher: Number.isFinite(v.besucher) ? v.besucher : null, kategorie: kat || null, quelle: v.quelle, id, stand: STAND, sicher: v.sicher || null });
      perCity[v.stadt] = (perCity[v.stadt] || 0) + 1;
    }
  }
}
entries.sort((a, b) => a.von.localeCompare(b.von) || a.gebiet.ags[0].localeCompare(b.gebiet.ags[0]));
console.log(`Einträge: ${entries.length} aus ${files.length} Dateien; verworfen ${drop.length}`);
console.log(Object.entries(perCity).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · '));
if (drop.length) console.log('Verworfen:\n  ' + drop.join('\n  '));
await writeFile(out, JSON.stringify(entries, null, 1));
if (flag === '--write') {
  cur.ereignisse = [...kept, ...entries].sort((a, b) => String(a.von).localeCompare(String(b.von)));
  if (rolling) console.log(`laufend: ${n0 - kept.length} ersetzt, ${entries.length} eingetragen`);
  await writeFile(path.join(repo, 'data', 'ereignisse.json'), JSON.stringify(cur, null, 2) + '\n');
  console.log(`data/ereignisse.json: ${cur.ereignisse.length} Einträge`);
}
