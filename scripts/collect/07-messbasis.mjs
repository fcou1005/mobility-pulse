// Sammler, Phase „messbasis“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as T from '../../lib/pulse-track.js';
import * as E from '../../lib/pulse-econ.js';
import * as SS from '../../lib/pulse-status.js';

export async function run(ctx) {
  const { DATA, PH, ampel, latest, log, now, prev, statusCounts } = ctx;
  try {
    const evDir = path.join(DATA, 'events'), today = T.dayOf(now);
    const evDays = existsSync(evDir) ? (await readdir(evDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort() : [];
    const prevM = prev?.measure?.version === 2 ? prev.measure.days || {} : {}; // Version 2 (13.11.2026): obs anteilig je Stunde (S1.1), obsEnd = Endstunde
    const mDays = {}; let ecDoc = null;
    for (const d of evDays) {
      if (prevM[d]?.complete) { mDays[d] = prevM[d]; continue; }
      const doc = JSON.parse(await readFile(path.join(evDir, `${d}.json`), 'utf8'));
      const complete = d < today && doc.published?.complete !== false; // laufender Tag und noch nicht vollständig veröffentlichter Vortag: neu lesen
      mDays[d] = { ...E.measureDay(doc), ...(complete ? { complete: true } : {}) };
      if (complete) ecDoc = doc;
    }
    latest.measure = { version: 2, fullDay: E.FULL_DAY, fields: 'obs: Minuten je Ortsstunde 0–23 ohne Lücken-Stunden (Fenster der Läufe anteilig je Stunde), obsEnd: dieselben Minuten in der Endstunde der Läufe, runs, counted (gezählte Läufe), rules (METHOD_VERSION der gezählten Läufe, "" = ohne), full (≥ 20 h mit ≥ 50 Min.), complete', days: mDays };
    const ecDay = Object.keys(mDays).filter(d => mDays[d].complete).sort().at(-1);
    if (ecDay) { ctx.ecInput = ecDoc?.day === ecDay ? ecDoc : JSON.parse(await readFile(path.join(evDir, `${ecDay}.json`), 'utf8')); ampel(); }
  } catch (e) { log(`Messbasis/Ampel: ${e.message}`); }
  await mkdir(path.join(DATA, 'history'), { recursive: true });
  await mkdir(path.join(DATA, 'snapshot'), { recursive: true });
  await writeFile(path.join(DATA, 'latest.json'), JSON.stringify(latest));
  // vorläufig (complete: false); am Ende des Laufs mit allen Phasen, Laufzeit und Trend überschrieben (S3.2)
  await writeFile(path.join(DATA, 'status.json'), JSON.stringify(SS.statusDoc({ at: now, generatedAt: latest.generatedAt, runMs: latest.runMs, phases: PH.list(true), counts: latest.counts, byStatus: statusCounts, complete: false })));
}
