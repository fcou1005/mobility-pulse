// Geo-Lauf (Sprint 8): gemeinsame Helfer – Herunterladen, ZIP-Einträge zeilenweise lesen (unzip -p), Grenzen und Flotten aus dem Datenstand.
import { createWriteStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

export const UA = 'mobility-pulse-geo (+https://github.com/fcou1005/mobility-pulse)';
/** Datei herunterladen (Stream auf die Platte); wirft bei HTTP-Fehler */
export async function download(url, file, { timeoutMs = 20 * 60e3, tries = 3, waitMs = 15e3 } = {}) {
  // Netzfehler („fetch failed“: Verbindung abgebrochen) bis zu dreimal versuchen; HTTP-Fehler nicht wiederholen
  let r = null;
  for (let k = 1; ; k++) {
    try { r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' }); break; }
    catch (e) { if (k >= tries) throw new Error(`${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''} nach ${k} Versuchen`); await sleep(waitMs * k); }
  }
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(/** @type {any} */ (r.body)), createWriteStream(file));
  return { bytes: (await stat(file)).size, lastModified: r.headers.get('last-modified') };
}
/** Einträge eines ZIP (Name, Größe) über „unzip -Z1“ */
export function zipNames(zip) { return execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 64e6 }).split('\n').map(s => s.trim()).filter(Boolean); }
/** einen ZIP-Eintrag zeilenweise lesen; onLine(line, n) */
export async function zipLines(zip, member, onLine, { encoding = 'utf8' } = {}) {
  const p = spawn('unzip', ['-p', zip, member], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (encoding !== 'utf8') p.stdout.setEncoding(/** @type {any} */ (encoding));
  const rl = createInterface({ input: p.stdout, crlfDelay: Infinity }); let n = 0;
  for await (const line of rl) onLine(line, n++);
  await new Promise((res, rej) => p.on('close', (c) => (c === 0 || c === null ? res(c) : rej(new Error(`unzip ${member}: ${c}`)))));
  return n;
}
/** ganze Zeilen eines Eintrags (für kleine Dateien wie calendar.txt) */
export async function zipAll(zip, member) { const out = []; await zipLines(zip, member, (l) => out.push(l)); return out; }

/** Grenzen aller Länder aus dem Datenstand (nur aktive Gemeinden, vereinfacht) */
export async function loadBoundaries(dataDir) {
  const ix = JSON.parse(await readFile(path.join(dataDir, 'boundaries', 'index.json'), 'utf8')), features = [], byState = {};
  for (const st of Object.keys(ix.states || {})) {
    const f = path.join(dataDir, 'boundaries', `${st}.json`); if (!existsSync(f)) continue;
    const d = JSON.parse(await readFile(f, 'utf8')); byState[st] = d.features.map(x => x.properties.ags);
    for (const x of d.features) features.push(x);
  }
  return { features, byState, stateOf: new Map(Object.entries(byState).flatMap(([st, l]) => l.map(a => [a, st]))) };
}
/** Flotte je Gemeinde ohne Autos aus latest.json → [[AGS, Fahrzeuge, Name]] absteigend */
export async function fleetByAgs(dataDir) {
  const l = JSON.parse(await readFile(path.join(dataDir, 'latest.json'), 'utf8')), out = [];
  for (const [ags, m] of Object.entries(l.municipalities || {})) {
    let n = 0; for (const o of Object.values(m.operators || {})) for (const [ty, c] of Object.entries(o.types || {})) if (ty !== 'car') n += c;
    out.push([ags, n, m.name]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
