// Sammler, Phase „kalibrierung“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as R from '../../lib/pulse-report.js';
import * as K from '../../lib/pulse-calib.js';
import * as SV from '../../lib/pulse-schema.js';

export async function run(ctx) {
  const { DATA, ROOT, latest, log, now } = ctx;
  // Kalibrierung vorrechnen (Audit OPS-04): calib.json mit Faktor k, Prüfwerten und Abdeckung, wie web/report.js loadCalibration – das Dashboard
  // lädt dann eine kleine Datei statt 14 Ereignis- und Verlaufsdateien und rechnet nicht dreimal die Städte-Rangliste. Höchstens stündlich
  // (mit der Prognose) oder wenn die Datei fehlt bzw. älter als 2 Stunden ist; sonst bleibt der alte Stand. CALIB=0 = aus.
  if (process.env.CALIB !== '0') {
    try {
      const cf = path.join(DATA, 'calib.json'), old = existsSync(cf) ? JSON.parse(await readFile(cf, 'utf8')) : null;
      if (ctx.trainCtx || !old || now - (old.at || 0) > 2 * 3600e3) {
        const t0 = Date.now(), rdj = async (f) => { try { return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null; } catch { return null; } };
        const ref = await rdj(process.env.REFERENCE_FILE || path.join(ROOT, 'data', 'reference.json')), daily = await rdj(path.join(DATA, 'history', 'daily.json'));
        const days = (await readdir(path.join(DATA, 'events'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort().slice(-14);
        const D = [], H = {}; for (const d of days) { const doc = await rdj(path.join(DATA, 'events', `${d}.json`)); if (!doc) continue; D.push(doc); H[d] = R.histFromDaily(daily, d) || await rdj(path.join(DATA, 'history', `${d}.json`)); if (!H[d]) delete H[d]; }
        const breaks = daily?.breaks || null, res = K.calibrationFromDocs({ ref, docs: D, hists: H, latest, breaks, langs: ['de', 'en'] }), langs = res.langs, kinds = res.kinds, own = res.own;
        for (const c of Object.values(langs)) delete c.kinds;
        // Umsatz-Prüfwert Voi (€ je Fahrzeug und Tag) bleibt in der Ansicht (braucht Tarife und Annahmen der Seite)
        await writeFile(cf, JSON.stringify({ schemaVersion: SV.SCHEMA.calib, version: 1, at: now, latestAt: latest.at, days: D.map(d => d.day), breaks, kinds, own, langs }));
        log(`Kalibrierung vorgerechnet: ${D.length} Tage, k ${langs.de?.k?.applied ? langs.de.k.k.toFixed(2) : 'nicht angewandt'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      }
    } catch (e) { log(`Kalibrierung: ${e.message}`); }
  }
}
