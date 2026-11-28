// Sammler, Phasen „welt-start“ und „welt“ (Reiter Länder, Stufe 1, 28.11.2026): die Länder außerhalb Deutschlands laufen als eigene Prozesse
// (scripts/welt.mjs, ein Land je Prozess), parallel zum deutschen Lauf. „welt-start“ stößt sie gleich nach dem Start an, „welt“ wartet am Ende
// höchstens bis zur Frist (WELT.budgetMs ab Start) und schreibt welt/index.json. Ein abgestürztes oder hängendes Land trifft nur sich selbst:
// eigener Prozess, eigene Frist, nach Fristende beendet. Länder, die in einem Lauf nicht drankommen, stehen im nächsten vorn (ältester Stand zuerst).
// WELT=0 schaltet ab; WELT_LAENDER=FR,JP beschränkt (Tests); WELT_BUDGET_MS überschreibt die Frist.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import * as W from '../../lib/pulse-welt.js';
import * as SV from '../../lib/pulse-schema.js';
import { fetchLimited } from '../../lib/pulse-core-base.js';

/** Länder anstoßen (kehrt sofort zurück; ctx.weltJob = Versprechen auf die Ergebnisse) @param {any} ctx */
export async function start(ctx) {
  const { DATA, ROOT, log, UA } = ctx;
  if (process.env.WELT === '0') return;
  const t0 = Date.now(), budget = +process.env.WELT_BUDGET_MS || W.WELT.budgetMs, deadline = t0 + budget;
  let text = '';
  try {
    const src = process.env.WELT_CSV || (existsSync(path.join(ROOT, 'data', 'cache', 'systems.csv')) ? path.join(ROOT, 'data', 'cache', 'systems.csv') : W.WELT.csvUrl);
    text = /^https?:/.test(src) ? await fetchLimited(src, { timeout: 30000, max: 20e6, headers: { 'user-agent': UA } }) : await readFile(src, 'utf8');
  } catch (e) { log('Länder: Verzeichnis nicht lesbar:', e.message); return; }
  const cat = W.catalogByCountry(text), only = (process.env.WELT_LAENDER || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  let ix = null; try { ix = JSON.parse(await readFile(path.join(DATA, 'welt', 'index.json'), 'utf8')); } catch { ix = null; }
  const lastAt = Object.fromEntries((ix?.countries || []).map((/** @type {any} */ c) => [c.land, c.at || 0]));
  const queue = Object.keys(cat).filter(cc => !only.length || only.includes(cc)).sort((a, b) => (lastAt[a] || 0) - (lastAt[b] || 0) || cat[b].length - cat[a].length);
  /** @type {any[]} */
  const results = [];
  const one = (/** @type {string} */ cc) => new Promise((resolve) => {
    const t1 = Date.now(); let out = '', done = false;
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'welt.mjs'), cc, '--deadline', String(deadline)], { env: { ...process.env, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
    const kill = setTimeout(() => { if (!done) { log(`Länder: ${cc} nach Frist beendet`); p.kill('SIGKILL'); } }, Math.max(1000, deadline - Date.now() + 20e3));
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      done = true; clearTimeout(kill);
      let r = null; try { r = JSON.parse(out.trim().split('\n').pop() || 'null'); } catch { r = null; }
      results.push({ land: cc, code, ms: Date.now() - t1, ...(r || {}), error: code === 0 ? null : `Prozess endete mit ${code ?? 'Abbruch'}` }); resolve(null);
    });
  });
  const worker = async () => { for (let cc = queue.shift(); cc; cc = queue.shift()) { if (Date.now() > deadline - Math.min(60e3, budget / 4)) { results.push({ land: cc, skipped: true }); continue; } await one(cc); } };
  ctx.weltJob = { deadline, t0, cat, results, done: Promise.all(Array.from({ length: W.WELT.procConcurrency }, worker)) };
}

/** auf die Länder warten (höchstens bis Frist + 25 s) und welt/index.json schreiben @param {any} ctx */
export async function run(ctx) {
  const job = ctx.weltJob; if (!job) return;
  const { DATA, log } = ctx;
  await Promise.race([job.done, new Promise(r => setTimeout(r, Math.max(0, job.deadline - Date.now() + 25e3)))]);
  try {
    const dir = path.join(DATA, 'welt'); await mkdir(dir, { recursive: true });
    let old = null; try { old = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8')); } catch { old = null; }
    const prev = new Map((old?.countries || []).map((/** @type {any} */ c) => [c.land, c]));
    /** @type {any[]} */
    const countries = [];
    for (const cc of Object.keys(job.cat).sort()) {
      const r = job.results.find((/** @type {any} */ x) => x.land === cc);
      let lt = null; try { lt = JSON.parse(await readFile(path.join(dir, cc, 'latest.json'), 'utf8')); } catch { lt = null; }
      const p = prev.get(cc);
      if (!lt) { if (p) countries.push(p); else countries.push({ land: cc, region: W.regionOf(cc), listed: job.cat[cc].length, at: null }); continue; }
      countries.push({ land: cc, region: W.regionOf(cc), tz: lt.tz, listed: lt.systemsListed, ok: lt.ok, failed: lt.failed, skipped: lt.skipped, at: lt.at, ms: lt.ms,
        avail: lt.totals.avail, stations: lt.totals.stations, cities: lt.cities.filter((/** @type {any[]} */ c) => c[2] > 0).length, ops: new Set(lt.systems.filter((/** @type {any[]} */ s) => !s[15] && s[5] > 0).map((/** @type {any[]} */ s) => s[3])).size, types: lt.totals.types,
        today: lt.today, ...(r && r.land && !r.skipped && r.code !== 0 ? { error: r.error } : {}), ranNow: !!(r && !r.skipped) });
    }
    const ran = job.results.filter((/** @type {any} */ x) => !x.skipped), errs = ran.filter((/** @type {any} */ x) => x.code !== 0);
    await writeFile(path.join(dir, 'index.json'), JSON.stringify(SV.withSchema('welt', { version: W.WELT.version, at: Date.now(), source: W.WELT.csvUrl, ms: Date.now() - job.t0, ran: ran.length, failedProcs: errs.length, countries })));
    log(`Länder: ${ran.length} von ${Object.keys(job.cat).length} gelaufen${errs.length ? `, ${errs.length} mit Fehler (${errs.map((/** @type {any} */ x) => x.land).join(', ')})` : ''}, ${countries.reduce((a, c) => a + (c.avail || 0), 0)} Fahrzeuge verfügbar (${Math.round((Date.now() - job.t0) / 1000)} s)`);
  } catch (e) { log('Länder: Index nicht geschrieben:', e.message); }
}
