#!/usr/bin/env node
// Browser-Tests mit festem Datenstand (S3.1): docs/ und das Fixture (test/fixtures/web-data, scripts/make-fixture.mjs) lokal ausliefern,
// jede Ansicht öffnen und inhaltlich prüfen. Kein Netz: alles außer 127.0.0.1 wird per page.route abgebrochen (Kacheln, OSRM, Nominatim,
// GBFS, Overpass), die Uhr steht per page.clock.install auf dem Stand des Fixtures. Läufe sind reproduzierbar: je Ansicht ein Prüfwert
// über den Text (Zeitangaben maskiert), BROWSER_RUNS=3 vergleicht drei Läufe.
//   node test/browser.mjs            (Playwright aus node_modules; BROWSER_PORT, Standard 8766 – 8765 gehört test/run.mjs)
// Exit 1 bei Skriptfehlern, fehlenden Inhalten oder abweichenden Läufen.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { startFixtureServer, FIX } from './fixture-server.mjs';
import { openFixturePage, settledText, mask } from './browser-lib.mjs';

const PORT = +process.env.BROWSER_PORT || 8766, RUNS = Math.max(1, +process.env.BROWSER_RUNS || 1);
const ONLY = process.env.VIEWS ? process.env.VIEWS.split(',') : null;

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
// S3.8 Byte-Budget je Ansicht: Daten (gzip, wie Pages ausliefert), die eine frisch geöffnete Ansicht aus dem Datenstand lädt. Grenzen auf dem
// Fixture (2 Gemeinden, 3 Tage) mit etwa 15 % Luft – wächst eine Ansicht darüber, lädt sie mehr Dateien oder größere als bisher.
const BYTE_BUDGET_KB = { live: 145, ops: 240, bericht: 245, prognose: 220, sources: 140, usage: 140, staedte: 95 };
let byteView = null; const viewBytes = {};
const bytes = { add: (u, n) => { if (byteView && u.startsWith('/d/')) { const v = (viewBytes[byteView] ||= {}); v[u.slice(3)] = (v[u.slice(3)] || 0) + n; } } };
const server = await startFixtureServer(PORT, { missing, bytes });
const { chromium } = await import('playwright').catch(() => { console.error('Playwright fehlt: npm ci (devDependencies) und npx playwright install chromium'); process.exit(2); });
const fx = JSON.parse(await readFile(path.join(FIX, 'FIXTURE.json'), 'utf8'));
const browser = await chromium.launch();
let bad = 0;
const fail = (m) => { bad++; console.log(`✗ ${m}`); };
const blocked = new Map();

const i18nMissing = new Set(); // S3.5: Schlüssel, deren Wörterbuchbereich beim Zeichnen nicht geladen war (Debug-Warnung von web/i18n.js)
async function pass(run, { scope, viewport, checks, tag, lang = null }) {
  const { page, errs, setCur } = await openFixturePage(browser, { port: PORT, fx, scope, viewport, lang, blocked,
    onConsole: (t, cur) => { const w = /\[i18n\] Schlüssel fehlt: (\w+) → (\S+)/.exec(t); if (w) i18nMissing.add(`${w[1]}:${w[2]} (${cur})`); } });
  const sums = {};
  for (const v of VIEWS) {
    setCur(v); await page.evaluate((x) => { location.hash = x; }, v);
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
  await page.context().close();
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
  // S3.8: Datenmenge je frisch geöffneter Ansicht (Desktop Stuttgart)
  for (const v of Object.keys(BYTE_BUDGET_KB).filter(x => !ONLY || ONLY.includes(x))) {
    byteView = v;
    const { page, close } = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 1440, height: 900 }, hash: v });
    await settledText(page, v); await page.waitForTimeout(500); await close(); byteView = null;
    const files = Object.entries(viewBytes[v] || {}).sort((a, b) => b[1] - a[1]), kb = files.reduce((a, [, n]) => a + n, 0) / 1024, lim = BYTE_BUDGET_KB[v];
    const top = files.slice(0, 4).map(([f, n]) => `${f} ${(n / 1024).toFixed(0)}`).join(', ');
    if (lim && kb > lim) fail(`Datenmenge ${v}: ${kb.toFixed(0)} KB gzip über Budget ${lim} KB (${top})`);
    else console.log(`✓ Datenmenge ${v.padEnd(9)} ${kb.toFixed(0).padStart(4)} KB gzip${lim ? ` (Budget ${lim} KB)` : ' (ohne Budget)'} · ${top}`);
  }
  // S3.7: passt die MAJOR-Version einer Datei nicht zur Seite, erscheint ein Hinweis (hier status.json mit 9.0)
  if (!ONLY) {
    const { page, close } = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 1280, height: 900 }, patch: { 'status.json': (d) => ({ ...d, schemaVersion: '9.0' }) } });
    const ok = await page.waitForFunction(() => /Datenformat passt nicht zur Seite: status\.json hat Version 9\.0/.test(document.getElementById('notice')?.innerText || ''), null, { timeout: 15000 }).then(() => true, () => false);
    if (ok) console.log('✓ Hinweis bei abweichender Formatversion (status.json 9.0)'); else fail('kein Hinweis bei abweichender Formatversion (status.json 9.0)');
    await close();
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
