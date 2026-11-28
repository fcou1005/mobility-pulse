#!/usr/bin/env node
// Länder-Sammler (Reiter „Länder“, Stufe 1, 28.11.2026): EIN Land je Prozess, damit ein Absturz oder ein hängender Feed nur dieses Land trifft.
// Der Sammler (Phase „welt“, scripts/collect/31-welt.mjs) startet die Prozesse parallel zum deutschen Lauf und wartet höchstens bis zur Frist.
//   node scripts/welt.mjs <Land> [--deadline <ms seit 1970>]
// Liest alle offenen GBFS-Systeme des Landes aus systems.csv (MobilityData; ohne Zugangsdaten) mit lib/pulse-core-feeds.js → readGbfsSystem,
// rechnet Kennzahlen je System (lib/pulse-welt.js) und schreibt:
//   welt/<Land>/latest.json   Systeme (Zeilen SYS_FIELDS), Städte, Summen; Systeme ohne neuen Abruf behalten ihren letzten Stand (stale)
//   welt/<Land>/<Tag>.json    Stunden in Ortszeit je System (HOUR_FIELDS)
//   welt/<Land>/punkte.json   Stationen (Füllstand) und Zellen frei abgestellter Fahrzeuge für die Karte
// Vergleichsstand für Abgänge/Zugänge (Positionen, Räder je Station) privat in TRACK_DIR/welt/<Land>.json.gz (ohne TRACK_DIR: DATA_DIR/track/welt).
// Umgebung: DATA_DIR, TRACK_DIR, WELT_CSV (Pfad oder URL; Standard data/cache/systems.csv aus build-catalog, sonst MobilityData), FETCH_TIMEOUT, MAX_BYTES.
// Letzte Zeile auf stdout: JSON-Zusammenfassung für den Sammler.
import { readFile, writeFile, mkdir, readdir, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import * as W from '../lib/pulse-welt.js';
import { readGbfsSystem } from '../lib/pulse-core-feeds.js';
import { fetchLimited, parseJsonSafe, normalizeLicense, safeText } from '../lib/pulse-core-base.js';
import { SCHEMA } from '../lib/pulse-schema.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const cc = String(process.argv[2] || '').toUpperCase(), argv = process.argv.slice(3);
const deadline = argv.includes('--deadline') ? +argv[argv.indexOf('--deadline') + 1] : Date.now() + W.WELT.budgetMs;
if (!Object.hasOwn(W.COUNTRIES, cc)) { console.error(`[welt] unbekanntes Land: ${cc}`); process.exit(2); }
const tz = W.COUNTRIES[cc], now = Date.now(), t0 = now;
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data'), OUT = path.join(DATA, 'welt', cc);
const STATE = path.join(process.env.TRACK_DIR ? path.resolve(process.env.TRACK_DIR) : path.join(DATA, 'track'), 'welt', `${cc}.json.gz`);
const TIMEOUT = +process.env.FETCH_TIMEOUT || 20000, MAX = +process.env.MAX_BYTES || 40e6, UA = 'mobility-pulse/1.0 (+https://github.com/fcou1005/mobility-pulse)';
const log = (/** @type {any[]} */ ...a) => console.error(`[welt ${cc}]`, ...a);

/** @param {string} url */
async function fetchJson(url) {
  try { const txt = await fetchLimited(url, { timeout: TIMEOUT, max: MAX, headers: { 'user-agent': UA, accept: 'application/json' } }); const json = parseJsonSafe(txt); return json ? { ok: true, status: 200, json } : { ok: false, status: 200, json: null, error: 'kein JSON' }; }
  catch (e) { const m = /HTTP (\d+)/.exec(e.message); return { ok: false, status: m ? +m[1] : null, json: null, error: m ? '' : e.message }; }
}
/** @param {string} f */
const rdJson = async (f) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } };
/** atomar schreiben (Abbruch mitten im Schreiben hinterlässt keine halbe Datei) @param {string} f @param {any} doc */
const put = async (f, doc) => { await mkdir(path.dirname(f), { recursive: true }); const tmp = `${f}.tmp`; await writeFile(tmp, JSON.stringify({ schemaVersion: SCHEMA.welt, ...doc })); await rename(tmp, f); };

async function catalog() {
  const src = process.env.WELT_CSV || (existsSync(path.join(ROOT, 'data', 'cache', 'systems.csv')) ? path.join(ROOT, 'data', 'cache', 'systems.csv') : W.WELT.csvUrl);
  const text = /^https?:/.test(src) ? await fetchLimited(src, { timeout: 30000, max: 20e6, headers: { 'user-agent': UA } }) : await readFile(src, 'utf8');
  return W.catalogByCountry(text)[cc] || [];
}

const list = await catalog();
const old = await rdJson(path.join(OUT, 'latest.json'));
/** @type {any} */
let state = null; try { state = existsSync(STATE) ? JSON.parse(gunzipSync(await readFile(STATE)).toString('utf8')) : null; } catch { state = null; }
if (state?.version !== W.WELT.version) state = { version: W.WELT.version, at: {}, pts: {} };
const oldRows = new Map((old?.systems || []).map((/** @type {any[]} */ r) => [r[0], r]));
const { day, h } = W.localDayHour(now, tz);
const dayFile = path.join(OUT, `${day}.json`);
const dayDoc = (await rdJson(dayFile)) || { version: W.WELT.version, land: cc, day, tz, fields: W.HOUR_FIELDS, sys: {} };
/** @type {any[][]} */
const rows = [];
/** @type {any[][]} */
const stations = []; /** @type {Array<[number, number]>} */ const free = [];
let done = 0, failed = 0, skipped = 0, outSum = 0, inSum = 0;
const queue = list.slice();
async function worker() {
  for (let sys = queue.shift(); sys; sys = queue.shift()) {
    if (Date.now() > deadline - 20e3) { skipped++; const r = oldRows.get(sys.id); if (r) rows.push([...r.slice(0, 4), false, ...r.slice(5, 14), 'Frist erreicht']); continue; }
    let res; try { res = await readGbfsSystem({ id: sys.id, operator: sys.name, name: sys.name, url: sys.url }, fetchJson, { now: Date.now() }); } catch (e) { res = { errors: [String(e.message || e)], vehicles: [], stations: [] }; }
    const empty = !res.vehicles.length && !res.stations.length;
    if (empty) {
      failed++; const r = oldRows.get(sys.id);
      rows.push(r ? [...r.slice(0, 4), false, ...r.slice(5, 14), (res.errors || []).slice(0, 2).join('; ').slice(0, 160) || 'leer'] : [sys.id, safeText(sys.name), safeText(sys.city), W.operatorName(sys.name, null), false, 0, 0, 0, 0, 0, {}, null, null, null, (res.errors || []).slice(0, 2).join('; ').slice(0, 160) || 'leer']);
      continue;
    }
    done++;
    const s = W.summarize(res), lic = normalizeLicense(res.systemInfo?.licenseId, res.systemInfo?.licenseUrl);
    rows.push([sys.id, safeText(sys.name), safeText(sys.city), W.operatorName(sys.name, res.systemInfo?.operator || null), true, s.avail, s.disabled, s.stations, s.empty, s.full, s.types, lic.id, lic.url, Date.now(), null]);
    const prevAt = state.at[sys.id] || 0, gapMin = (now - prevAt) / 60e3, use = gapMin > 0 && gapMin <= W.WELT.maxGapMin;
    const mv = use ? W.moves(state.pts[sys.id] || null, s) : { out: 0, in: 0 };
    outSum += mv.out; inSum += mv.in;
    W.addHour(dayDoc, sys.id, h, { avail: s.avail, stations: s.stations, empty: s.empty, full: s.full, ...(use ? { out: mv.out, in: mv.in, min: Math.round(gapMin * 10) / 10 } : {}) });
    state.at[sys.id] = now; state.pts[sys.id] = { free: s.free, st: s.st.map(r => [r[0], 0, 0, r[3]]) };
    for (const r of s.st) stations.push([sys.id, r[1], r[2], r[3], r[4], r[5]]);
    free.push(...s.free);
  }
}
await Promise.all(Array.from({ length: Math.min(W.WELT.sysConcurrency, list.length || 1) }, worker));

// Systeme nicht mehr im Verzeichnis: fallen weg; Reihenfolge nach Bestand
rows.sort((a, b) => (b[5] || 0) - (a[5] || 0));
const totals = rows.reduce((t, r) => { t.avail += r[5] || 0; t.disabled += r[6] || 0; t.stations += r[7] || 0; t.empty += r[8] || 0; t.full += r[9] || 0; for (const [ty, n] of Object.entries(r[10] || {})) t.types[ty] = (t.types[ty] || 0) + n; return t; }, { avail: 0, disabled: 0, stations: 0, empty: 0, full: 0, types: /** @type {Record<string, number>} */ ({}) });
const cities = W.citiesOf(rows).map(c => [c.city, c.systems, c.avail, c.stations, c.ops, c.types]);
// heutige Summen in Ortszeit (Abgänge, Zugänge, Minuten mit Vergleich: längste Abdeckung eines Systems)
const today = { out: 0, in: 0, min: 0 };
for (const rs of Object.values(dayDoc.sys)) { let m = 0; for (const r of /** @type {number[][]} */ (rs)) { today.out += r[6]; today.in += r[7]; m += r[8]; } today.min = Math.max(today.min, Math.round(m)); }
if (done) {
  await put(dayFile, dayDoc);
  await put(path.join(OUT, 'punkte.json'), { version: W.WELT.version, land: cc, at: now, stationFields: ['sys', 'lat', 'lon', 'raeder', 'frei', 'zustand'], stations, cellFields: ['lat', 'lon', 'fahrzeuge'], cells: W.cellsOf(free) });
  await mkdir(path.dirname(STATE), { recursive: true }); await writeFile(STATE, gzipSync(JSON.stringify(state)));
}
// alte Tage entfernen (höchstens keepDays Dateien)
await mkdir(OUT, { recursive: true });
const dayFiles = (await readdir(OUT)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
for (const f of dayFiles.slice(0, Math.max(0, dayFiles.length - W.WELT.keepDays))) await rm(path.join(OUT, f), { force: true });
const days = dayFiles.slice(-W.WELT.keepDays).map(f => f.slice(0, 10));
await put(path.join(OUT, 'latest.json'), { version: W.WELT.version, land: cc, region: W.regionOf(cc), tz, at: now, day, ms: Date.now() - t0, systemsListed: list.length, ok: done, failed, skipped,
  fields: W.SYS_FIELDS, systems: rows, cityFields: ['stadt', 'systeme', 'fahrzeuge', 'stationen', 'anbieter', 'arten'], cities, totals, today, days });
log(`${done}/${list.length} Systeme gelesen, ${failed} ohne Daten, ${skipped} nach Frist; ${totals.avail} Fahrzeuge verfügbar, ${totals.stations} Stationen; ab ${outSum}, an ${inSum} (${Date.now() - t0} ms)`);
console.log(JSON.stringify({ land: cc, listed: list.length, ok: done, failed, skipped, avail: totals.avail, stations: totals.stations, cities: cities.length, ms: Date.now() - t0 }));
