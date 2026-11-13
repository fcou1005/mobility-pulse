// Sammler, Phase „training“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as FC from '../../lib/pulse-forecast.js';
import * as CX from '../../lib/pulse-context.js';
import * as TR from '../../lib/pulse-train.js';
import { gzipSync } from 'node:zlib';

export async function run(ctx) {
  const { DATA, latest, log, now, opsByDay } = ctx;
  if (process.env.TRAIN !== '0') {
    try {
      const rdj = async (f) => { try { return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null; } catch { return null; } };
      const of = path.join(DATA, 'eingriffe.json'), prevOps = await rdj(of), done = new Set(prevOps?.done || []);
      const evDays = existsSync(path.join(DATA, 'events')) ? (await readdir(path.join(DATA, 'events'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort() : [];
      const todoOps = evDays.filter(d => !done.has(d) && TR.trainReady(d, now)).slice(0, 8);
      if (todoOps.length) {
        const pl = await rdj(path.join(DATA, 'pricing-log.json')), zl = await rdj(path.join(DATA, 'zones-log.json')), pj = await rdj(path.join(DATA, 'pricing.json')), zi = await rdj(path.join(DATA, 'zones', 'index.json'));
        const srcMunis = new Map([...(pj?.plans || []).map(p => [p.sourceId, p.municipalities || []]), ...(zi?.zones || []).map(z => [z.sourceId, z.municipalities || []])]);
        const arch = { fields: null, days: {} }; for (const m of [...new Set(todoOps.flatMap(d => [d.slice(0, 7), new Date(Date.parse(`${d.slice(0, 7)}-01T12:00:00Z`) - 86400e3).toISOString().slice(0, 7)]))]) { const a = await rdj(path.join(DATA, 'archive', `${m}.json`)); if (a?.days) { arch.fields = a.fields; Object.assign(arch.days, a.days); } }
        let all = []; for (const d of todoOps) { const ev = await rdj(path.join(DATA, 'events', `${d}.json`)); const sig = TR.opsSignals({ day: d, events: ev, archive: arch, price: pl?.changes || [], zones: zl?.changes || [], srcMunis }); opsByDay.set(d, sig); all = all.concat(sig); done.add(d); }
        const doc = TR.mergeOps(prevOps, all, now); doc.done = [...done].filter(d => d >= evDays[0]).sort(); await writeFile(of, JSON.stringify(doc));
        log(`Eingriffe/Ausfälle: ${todoOps.join(', ')} → ${all.length} Einträge (${['price', 'zone', 'fleet', 'outage'].map(k => `${k} ${all.filter(e => e.kind === k).length}`).join(', ')})`);
      }
    } catch (e) { log(`Eingriffe: ${e.message}`); }
  }
  if (process.env.TRAIN !== '0') {
    try {
      const tDir = path.join(DATA, TR.TRAIN.dir), evDir = path.join(DATA, 'events'), have = new Set();
      if (existsSync(tDir)) for (const y of (await readdir(tDir)).filter(f => /^\d{4}$/.test(f))) for (const f of await readdir(path.join(tDir, y))) { const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json\.gz$/); if (m) have.add(m[1]); }
      const evDays = existsSync(evDir) ? (await readdir(evDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)) : [];
      const todo = ctx.trainCtx ? TR.trainTodo(evDays, have, now) : [];
      if (todo.length) {
        const rd = async (f) => { try { return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null; } catch { return null; } };
        const calendar = await rd(path.join(DATA, 'calendar.json')), series = await rd(path.join(DATA, 'forecast', 'series.json')), flog = await rd(path.join(DATA, 'forecast', 'log.json'));
        const fam = {}; for (const f of FC.FAMILIES) if (f !== 'micro') fam[f] = { series: await rd(path.join(DATA, FC.FAMILY_DIR[f], 'series.json')), log: await rd(path.join(DATA, FC.FAMILY_DIR[f], 'log.json')) };
        const prevUtc = (d) => new Date(Date.parse(`${d}T12:00:00Z`) - 86400e3).toISOString().slice(0, 10);
        const opsDoc = await rd(path.join(DATA, 'eingriffe.json'));
        const wx = async (dir, d) => [await rd(path.join(DATA, dir, `${prevUtc(d)}.json`)), await rd(path.join(DATA, dir, `${d}.json`))].filter(Boolean);
        let bytes = 0;
        for (const day of todo) {
          const events = await rd(path.join(evDir, `${day}.json`)); if (!events?.groups) continue;
          const doc = TR.trainDoc({ events, history: await rd(path.join(DATA, 'history', `${day}.json`)), weather: await wx('weather', day), weatherFc: await wx('weather-fc', day),
            incidents: await rd(path.join(DATA, 'incidents', `${day}.json`)), calendar, curated: ctx.trainCtx.curated, pending: ctx.trainCtx.pending, checks: latest.eventChecks, series, log: flog, families: fam, now, ops: opsByDay.get(day) ?? (opsDoc?.done?.includes(day) ? (opsDoc.entries || []).filter(e => e.day === day) : null) });
          const buf = gzipSync(JSON.stringify(doc), { level: 9 }), f = path.join(DATA, TR.trainPath(day));
          await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, buf); have.add(day); bytes += buf.length;
        }
        await writeFile(path.join(tDir, 'index.json'), JSON.stringify({ version: TR.TRAIN.version, updatedAt: new Date(now).toISOString(), days: [...have].sort(), path: 'train/<JJJJ>/<JJJJ-MM-TT>.json.gz',
          fields: TR.TRAIN.fields, sums: TR.TRAIN.sums, stock: TR.TRAIN.stock, ctxKeys: CX.CTX_KEYS, minStarts: TR.TRAIN.minStarts,
          note: 'Je Ortstag Stundenwerte je Gemeinde|Anbieter|Art (Ereignisse, verfügbare Fahrzeugminuten, Bestand), beobachtete Minuten, Wetter (Beobachtung und wie ausgegebene Vorhersage), Tagtyp je Land, Kennzeichen wie in der Prognose (ctx), zurückgehaltene (ctxHeld) und nur gesammelte wie Baustellen in Städten (ctxExtra), Ampel, eingefrorener Plan, Eingriffe der Anbieter (ops), anteilige Stundenwerte (pf, gp, obsP). Gruppen mit 1–2 Fahrtbeginnen am Tag: Fahrtbeginne/-enden nur als Tagessumme.' }));
        log(`Trainingsarchiv: ${todo.join(', ')} (${(bytes / 1e3).toFixed(0)} kB gz), ${have.size} Tage gesamt`);
      }
      const fcDir = path.join(DATA, 'weather-fc');
      if (existsSync(fcDir)) for (const f of (await readdir(fcDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -40)) await rm(path.join(fcDir, f));
    } catch (e) { log(`Trainingsarchiv: ${e.message}`); }
  }
}
