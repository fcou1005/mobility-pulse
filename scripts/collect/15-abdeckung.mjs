// Sammler, Phase „abdeckung“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as V from '../../lib/pulse-coverage.js';

export async function run(ctx) {
  const { DATA, ROOT, latest, log, now } = ctx;
  // Abdeckung: Städte laut Anbieter-Website (data/operator-cities.json, liegt auf main im Checkout) gegen Feeds mit und ohne Fahrzeuge
  // (coverage.json, Format in lib/pulse-coverage.js); „zuletzt aktiv“ aus daily.json und dem vorigen coverage.json
  try {
    const claimsFile = process.env.OPERATOR_CITIES_FILE || path.join(ROOT, 'data', 'operator-cities.json');
    const claims = existsSync(claimsFile) ? JSON.parse(await readFile(claimsFile, 'utf8')) : null;
    const covFile = path.join(DATA, 'coverage.json');
    const prevCov = existsSync(covFile) ? JSON.parse(await readFile(covFile, 'utf8')) : null;
    const dailyFile = path.join(DATA, 'history', 'daily.json');
    const daily = existsSync(dailyFile) ? JSON.parse(await readFile(dailyFile, 'utf8')) : null;
    const cov = V.coverage({ claims, latest, features: ctx.boundaries?.features || [], prev: prevCov?.version === V.COVERAGE_VERSION ? prevCov : null, daily, now });
    await writeFile(covFile, JSON.stringify(cov));
    const lost = cov.unresolved.filter(u => u.grund === 'unbekannt').map(u => `${u.op}: ${u.ort}`);
    log(`Abdeckung: ${cov.rows.length} Zeilen, ${Object.entries(cov.totals).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}${lost.length ? `; ohne Gemeinde: ${lost.join(', ')}` : ''}`);
  } catch (e) { log(`Abdeckung: ${e.message}`); }
}
