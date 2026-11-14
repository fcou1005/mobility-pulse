// Geo-Lauf (Sprint 8): erzeugt den Branch „geo“ (Workflow „Geo“, Vorlage scripts/geo-workflow.yml, monatlich am 2.).
//   node scripts/geo.mjs <Checkout des Branches data> <Ausgabe = Checkout des Branches geo>
//   GEO_ONLY=zensus,unfall,gtfs,umweg (Vorgabe: was fällig ist) · GEO_FORCE=1 rechnet alles neu
// Fällig: Zensus fehlt oder älter als 330 Tage, Unfallatlas einmal im Jahr (oder wenn ein Jahr fehlt), GTFS und Umweg einmal im Monat.
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadBoundaries, fleetByAgs } from './geo/common.mjs';
import { runZensus } from './geo/zensus.mjs';
import { runUnfall } from './geo/unfall.mjs';
import { runGtfs } from './geo/gtfs.mjs';
import { runUmweg } from './geo/umweg.mjs';

const [DATA, OUT] = process.argv.slice(2);
if (!DATA || !OUT) { console.error('Aufruf: node scripts/geo.mjs <Datenstand> <Ausgabe>'); process.exit(2); }
const now = +(process.env.GEO_NOW || Date.now()), log = (...m) => console.log(...m), TMP = await mkdtemp(path.join(tmpdir(), 'geo-'));
await mkdir(OUT, { recursive: true });
const ixFile = path.join(OUT, 'index.json'), ix = existsSync(ixFile) ? JSON.parse(await readFile(ixFile, 'utf8')) : { schemaVersion: '1.0', parts: {} };
const only = (process.env.GEO_ONLY || '').split(',').map(s => s.trim()).filter(Boolean), force = process.env.GEO_FORCE === '1';
const age = (p) => (ix.parts?.[p]?.at ? (now - ix.parts[p].at) / 86400e3 : Infinity);
const due = { zensus: age('zensus') > 330, unfall: age('unfall') > 330 || (ix.parts?.unfall?.missing || []).length > 0, gtfs: age('gtfs') > 27, umweg: age('umweg') > 27 };
const want = (p) => (only.length ? only.includes(p) : force || due[p]);
const bounds = await loadBoundaries(DATA), top = await fleetByAgs(DATA), active = top.filter(([, n]) => n >= 20).map(([a]) => a);
log(`Geo-Lauf: ${bounds.features.length} aktive Gemeinden, ${active.length} mit mindestens 20 Fahrzeugen; fällig ${Object.entries(due).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nichts'}${only.length ? `, angefragt ${only.join(', ')}` : ''}`);
/** @type {Array<[string, () => Promise<any>]>} */
const parts = [['zensus', () => runZensus({ OUT, TMP, bounds, log, now })], ['unfall', () => runUnfall({ OUT, TMP, bounds, log, now, keep: active })], ['gtfs', () => runGtfs({ OUT, TMP, bounds, log, now })], ['umweg', () => runUmweg({ OUT, bounds, log, now, top })]];
let failed = 0;
for (const [name, fn] of parts) {
  if (!want(name)) continue;
  try { const r = await fn(); ix.parts[name] = { at: now, ok: true, ...(r?.missing ? { missing: r.missing } : {}) }; }
  catch (e) { failed++; log(`${name}: FEHLER ${e.message}`); ix.parts[name] = { ...(ix.parts[name] || {}), lastError: e.message, errorAt: now }; }
  await writeFile(ixFile, JSON.stringify({ ...ix, at: now }, null, 1));
}
await writeFile(path.join(OUT, 'README.md'), '# Mobility Pulse – Geo-Daten\n\nErzeugt vom Workflow „Geo“ (scripts/geo.mjs). Quellen und Lizenzen je Datei: Zensus 2022 (© Destatis, dl-de/by-2-0), Unfallatlas (© Statistische Ämter des Bundes und der Länder, dl-de/by-2-0), Fahrplan gtfs.de (CC BY 4.0), OpenStreetMap (ODbL). Der Sammler liest diese Dateien und veröffentlicht Auswertungen im Branch data.\n');
log(failed ? `Geo-Lauf mit ${failed} Fehlern` : 'Geo-Lauf fertig');
process.exitCode = failed && failed === parts.filter(([n]) => want(n)).length ? 1 : 0;
