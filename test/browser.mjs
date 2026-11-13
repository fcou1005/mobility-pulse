#!/usr/bin/env node
// Browser-Tests mit festem Datenstand (S3.1): docs/ und das Fixture (test/fixtures/web-data, scripts/make-fixture.mjs) lokal ausliefern,
// jede Ansicht öffnen und inhaltlich prüfen. Kein Netz: alles außer 127.0.0.1 wird per page.route abgebrochen (Kacheln, OSRM, Nominatim,
// GBFS, Overpass), die Uhr steht per page.clock.install auf dem Stand des Fixtures. Läufe sind reproduzierbar: je Ansicht ein Prüfwert
// über den Text (Zeitangaben maskiert), BROWSER_RUNS=3 vergleicht drei Läufe.
//   node test/browser.mjs            (Playwright aus node_modules; BROWSER_PORT, Standard 8766 – 8765 gehört test/run.mjs)
// Exit 1 bei Skriptfehlern, fehlenden Inhalten oder abweichenden Läufen.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), FIX = path.join(ROOT, 'test/fixtures/web-data');
const PORT = +process.env.BROWSER_PORT || 8766, RUNS = Math.max(1, +process.env.BROWSER_RUNS || 1);
const ONLY = process.env.VIEWS ? process.env.VIEWS.split(',') : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

// Ansicht → Prüfungen am sichtbaren Text (Gebiet Stuttgart, Deutsch). Jede Prüfung: [Beschreibung, RegExp]
const CHECKS = {
  live: [['Kopfzeile mit Bestand', /Stuttgart: [\d.]+ Fahrzeuge verfügbar/], ['Kachel Stationen', /STATIONEN MIT ANGEBOT\s*\d+ \/ \d+/i], ['Kachel Energie', /ENERGIE NIEDRIG\s*[\d,]+ %/i]],
  lab: [['Bestandsverlauf', /Bestandsverlauf/], ['Scorecard', /Anbieter-Scorecard/], ['Quellenqualität mit Zahl', /QUELLENQUALITÄT\s*\d+/i]],
  staedte: [['Gebiet hervorgehoben', /Stuttgart im Kontext/], ['Zeile Stuttgart mit Bestand', /Stuttgart\s*BW\s*[\d.]+\s*[\d,]+/]],
  usage: [['Tag gewählt', /Sammler-Läufe am \d\d\.\d\d\.2026/], ['Fahrten gezählt', /FAHRTEN GEZÄHLT \(ROH\)\s*[\d.]+/i], ['Umsetzungen', /UMSETZUNGEN\s*\d+/i]],
  coverage: [['Anbieter vor Ort', /ANBIETER VOR ORT\s*\d+/i], ['Voi gelistet', /Voi/]],
  vergleich: [['Gebiet', /Anbieter-Vergleich · Stuttgart/], ['mehrere Anbieter', /Voi[\s\S]*Lime[\s\S]*Bolt/]],
  bericht: [['Gemeindeschlüssel', /AGS 08111000/], ['Einwohner', /609\.365 Einwohner/], ['Zeitraum', /Alle verfügbaren Tage \(3\)/]],
  ops: [['Flotte je Anbieter', /FLOTTE\s*Voi · [\d.]+ Fzg\./i], ['Deploy-Spots', /Deploy-Spots/]],
  spots: [['Gebiet', /Spot-Abgleich · Stuttgart/], ['eigener Anbieter mit Spots', /Mein Anbieter\s*Voi \(\d+ Spots\)/]],
  prognose: [['Prognose für Anbieter und Gebiet', /Prognose für Voi in Stuttgart/], ['Güte', /Wie gut ist die Prognose\?/]],
  'prognose-spots': [['Filter Gebiet', /Gebiet: Stuttgart/], ['Spots bewertet', /Wichtigkeit und Fehlbestand/]],
  'prognose-basis': [['Selbstkontrollen', /Selbstkontrollen/], ['Parameter', /Parameter/]],
  sources: [['letzter Lauf', /Letzter Lauf \d\d:\d\d/], ['Quellen aktuell', /\d+ von \d+ Quellen aktuell/]],
  signals: [['Kopf', /Signale je Anbieter und Gemeinde/], ['Stationshinweis', /Abstellzonen ohne Fahrzeug/]],
  status: [['letzter Lauf', /LETZTER LAUF\s*\d\d:\d\d/i], ['Laufzeit mit Stufe', /LAUFZEIT\s*\d+ s/i], ['Verlauf', /Laufzeit der letzten 7 Tage/]],
};
const VIEWS = Object.keys(CHECKS).filter(v => !ONLY || ONLY.includes(v));
const BAD_TEXT = /nicht ladbar|konnte nicht geladen|Fehler beim Laden/i;

const missing = new Set(); // Dateien, die die Seite anfragt und das Fixture nicht hat (Hinweis; optionale Dateien wie incidents/<heute> fehlen erlaubt)
const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const base = u.startsWith('/d/') ? FIX : u.startsWith('/data/') ? path.join(ROOT, 'data') : path.join(ROOT, 'docs');
  const rel = u.startsWith('/d/') ? u.slice(3) : u.startsWith('/data/') ? u.slice(6) : (u.endsWith('/') ? `${u}index.html` : u);
  const f = path.join(base, rel);
  if (!f.startsWith(base)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(b); } catch { if (u.startsWith('/d/')) missing.add(u.slice(3)); res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const { chromium } = await import('playwright').catch(() => { console.error('Playwright fehlt: npm ci (devDependencies) und npx playwright install chromium'); process.exit(2); });
const fx = JSON.parse(await readFile(path.join(FIX, 'FIXTURE.json'), 'utf8'));
const browser = await chromium.launch();
let bad = 0;
const fail = (m) => { bad++; console.log(`✗ ${m}`); };
const blocked = new Map();

/** Text der Ansicht, sobald er sich 600 ms nicht mehr ändert (höchstens maxMs) */
async function settledText(page, v, maxMs = 12000) {
  let last = '', same = 0; const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const txt = await page.evaluate((x) => (document.getElementById(`view-${x}`)?.innerText || '').replace(/\s+/g, ' ').trim(), v);
    if (txt === last && txt.length > 200) { if (++same >= 3) return txt; } else same = 0;
    last = txt; await page.waitForTimeout(200);
  }
  return last;
}
const mask = (s) => s.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, 'hh:mm').replace(/vor \d+ (Sek|Min)\.?/g, 'vor x').replace(/\d+[,.]\d+ s\b/g, 'x s');

const i18nMissing = new Set(); // S3.5: Schlüssel, deren Wörterbuchbereich beim Zeichnen nicht geladen war (Debug-Warnung von web/i18n.js)
async function pass(run, { scope, viewport, checks, tag, lang = null }) {
  const page = await browser.newPage({ viewport, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  await page.clock.install({ time: fx.at + 2 * 60e3 });
  await page.route('**/*', (route) => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); blocked.set(u.hostname, (blocked.get(u.hostname) || 0) + 1); return route.abort(); });
  const errs = []; let cur = 'start';
  page.on('pageerror', e => errs.push(`${cur}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(`${cur}: console ${m.text().slice(0, 200)}`);
    const w = /\[i18n\] Schlüssel fehlt: (\w+) → (\S+)/.exec(m.text()); if (w) i18nMissing.add(`${w[1]}:${w[2]} (${cur})`); });
  await page.goto(`http://127.0.0.1:${PORT}/?data=/d/&scope=${scope}${lang ? `&lang=${lang}` : ''}#live`, { waitUntil: 'load', timeout: 60000 });
  const sums = {};
  for (const v of VIEWS) {
    cur = v; await page.evaluate((x) => { location.hash = x; }, v);
    const txt = await settledText(page, v);
    sums[v] = createHash('sha1').update(mask(txt)).digest('hex').slice(0, 10);
    const res = [];
    if (txt.length < 300) res.push(`zu wenig Inhalt (${txt.length} Zeichen)`);
    if (BAD_TEXT.test(txt)) res.push(`Ladefehler im Text: „${txt.match(BAD_TEXT)[0]}“`);
    if (checks) for (const [name, re] of CHECKS[v]) if (!re.test(txt)) res.push(`fehlt: ${name}`);
    if (run === 0) { if (res.length) fail(`${tag} ${v}: ${res.join('; ')}`); else console.log(`✓ ${tag} ${v.padEnd(15)} ${String(txt.length).padStart(6)} Zeichen${checks ? `, ${CHECKS[v].length} Prüfungen` : ''}`); }
    else if (res.length) fail(`${tag} ${v} (Lauf ${run + 1}): ${res.join('; ')}`);
  }
  if (errs.length) { bad += errs.length; console.log(`✗ ${tag}: ${errs.length} Skriptfehler\n  ${errs.slice(0, 10).join('\n  ')}`); }
  await page.close();
  return sums;
}

const t0 = Date.now(), runs = [];
try {
  for (let run = 0; run < RUNS; run++) {
    const a = await pass(run, { scope: '08111000', viewport: { width: 1440, height: 900 }, checks: true, tag: 'Desktop Stuttgart' });
    const b = await pass(run, { scope: '08416041', viewport: { width: 390, height: 844 }, checks: false, tag: 'Handy Tübingen' });
    if (run === 0) await pass(run, { scope: '08111000', viewport: { width: 1280, height: 900 }, checks: false, tag: 'Englisch Stuttgart', lang: 'en' });
    runs.push({ a, b });
  }
} finally { await browser.close(); server.close(); }
if (RUNS > 1) for (let r = 1; r < RUNS; r++) for (const side of ['a', 'b']) for (const v of VIEWS) if (runs[r][side][v] !== runs[0][side][v]) fail(`Lauf ${r + 1} weicht ab: ${side === 'a' ? 'Desktop' : 'Handy'} ${v} (${runs[0][side][v]} ≠ ${runs[r][side][v]})`);
console.log(`Netz: nur 127.0.0.1 erreicht; abgebrochen ${[...blocked].map(([h, n]) => `${h} ×${n}`).join(', ') || 'nichts'}`);
if (missing.size) console.log(`Im Fixture nicht vorhanden (404): ${[...missing].sort().join(', ')}`);
if (i18nMissing.size) fail(`${i18nMissing.size} Texte ohne geladenen Wörterbuchbereich (S3.5): ${[...i18nMissing].slice(0, 12).join(', ')}`);
else console.log('Wörterbuch: 0 fehlende Schlüssel in Deutsch und Englisch');
console.log(`Prüfwerte: ${VIEWS.map(v => `${v}=${runs[0].a[v]}`).join(' ')}`);
console.log(`${bad ? `${bad} Befunde` : 'Browser-Tests grün'} · ${RUNS} Lauf/Läufe · ${((Date.now() - t0) / 1000).toFixed(0)} s · Fixture ${fx.days.join(', ')}`);
process.exit(bad ? 1 : 0);
