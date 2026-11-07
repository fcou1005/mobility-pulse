// Eingabe für scripts/chronos.py aus einem Datenstand (Verzeichnis mit events/, weather/, calendar.json), siehe lib/pulse-chronos.js.
// Aufruf: node scripts/chronos-input.mjs <Datenstand> <Ausgabe.json>
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chronosInput, CHRONOS } from '../lib/pulse-chronos.js';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error('Aufruf: node scripts/chronos-input.mjs <Datenstand> <Ausgabe.json>'); process.exit(2); }
const list = async (d, n) => (existsSync(d) ? (await readdir(d)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-n).map(f => path.join(d, f)) : []);
const docs = []; for (const f of await list(path.join(dir, 'events'), CHRONOS.contextDays + 1)) docs.push(JSON.parse(await readFile(f, 'utf8')));
const weather = []; for (const f of await list(path.join(dir, 'weather'), CHRONOS.contextDays + 4)) weather.push(JSON.parse(await readFile(f, 'utf8')));
const cf = path.join(dir, 'calendar.json'), calendar = existsSync(cf) ? JSON.parse(await readFile(cf, 'utf8')) : null;
const inp = chronosInput({ docs, calendar, weather, now: process.env.NOW ? Date.parse(process.env.NOW) : Date.now() });
if (!inp?.groups?.length) { console.error('keine Gruppen – Datenstand leer?'); process.exit(1); }
await writeFile(out, JSON.stringify(inp));
console.log(`Chronos-Eingabe: ${inp.groups.length} Gruppen, ${inp.n} Stunden Kontext, ${inp.horizon} Stunden Prognose, ${Object.keys(inp.cov).length} Gemeinden`);
