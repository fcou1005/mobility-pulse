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
import { driverChecks } from './browser-fahrer.mjs';

const PORT = +process.env.BROWSER_PORT || 8766, RUNS = Math.max(1, +process.env.BROWSER_RUNS || 1);
const ONLY = process.env.VIEWS ? process.env.VIEWS.split(',') : null;

// Ansicht → Prüfungen am sichtbaren Text (Gebiet Stuttgart, Deutsch). Jede Prüfung: [Beschreibung, RegExp]
const CHECKS = {
  live: [['Antwort mit Bestand', /Verfügbar sind [\d.]+ Fahrzeuge in Stuttgart/], ['Kachel Stationen', /STATIONEN MIT ANGEBOT\s*\d+ \/ \d+/i], ['Kachel Energie', /ENERGIE NIEDRIG\s*[\d,]+ %/i]],
  lab: [['Bestandsverlauf', /Bestandsverlauf/], ['Scorecard', /Anbieter-Scorecard/], ['Quellenqualität mit Zahl', /QUELLENQUALITÄT\s*\d+/i]],
  staedte: [['Gebiet hervorgehoben', /Stuttgart im Kontext/], ['Zeile Stuttgart mit Bestand', /Stuttgart\s*BW\s*[\d.]+\s*[\d,]+/]],
  usage: [['Tag gewählt', /Sammler-Läufe am \d\d\.\d\d\.2026/], ['Fahrten gezählt', /FAHRTEN GEZÄHLT \(ROH\)\s*[\d.]+/i], ['Umsetzungen', /UMSETZUNGEN\s*\d+/i]],
  coverage: [['Anbieter vor Ort', /ANBIETER VOR ORT\s*\d+/i], ['Voi gelistet', /Voi/]],
  vergleich: [['Gebiet', /Anbieter-Vergleich: Stuttgart/], ['mehrere Anbieter', /Voi[\s\S]*Lime[\s\S]*Bolt/]],
  bericht: [['Gemeindeschlüssel', /AGS 08111000/], ['Einwohner', /609\.365 Einwohner/], ['Zeitraum', /Alle verfügbaren Tage \(3\)/]],
  ops: [['Flotte je Anbieter', /FLOTTE\s*Voi \([\d.]+ Fzg\.\)/i], ['Deploy-Spots', /Deploy-Spots/], ['Schichtplan', /Schichtplan/], ['Soll je Tageszeit', /[\d.]+ von [\d.]+ verfügbaren Fahrzeugen auf [\d.]+ Zellen/], ['Akku bis morgen 8 Uhr', /Akku bis morgen 8 Uhr[\s\S]*melden keinen Ladestand/], ['Akku: Trefferquote', /Selbstprüfung: \d+ % von [\d.]+ Vorhersagen getroffen/]],
  spots: [['Gebiet', /Spot-Abgleich: Stuttgart/], ['eigener Anbieter mit Spots', /Mein Anbieter\s*Voi \(\d+ Spots\)/]],
  prognose: [['Prognose für Anbieter und Gebiet', /Prognose für Voi in Stuttgart/], ['Güte', /Wie gut ist die Prognose\?/]],
  'prognose-spots': [['Filter Gebiet', /Gebiet: Stuttgart/], ['Spots bewertet', /Wichtigkeit und Fehlbestand/]],
  'prognose-basis': [['Selbstkontrollen', /Selbstkontrollen/], ['Parameter', /Parameter/]],
  sources: [['letzter Lauf', /Letzter Lauf \d\d:\d\d/], ['Quellen aktuell', /\d+ von \d+ Quellen im Gebiet sind aktuell/]],
  signals: [['Kopf', /Signale je Anbieter und Gemeinde/], ['Stationshinweis', /Abstellzonen ohne Fahrzeug/]],
  stadt: [['Antwort mit Bestand', /Unterwegs sind in Stuttgart [\d.]+ E-Scooter bei einer amtlichen Obergrenze von [\d.]+/], ['Feeds', /Alle Themen/]],
  auflagen: [['Titel', /Datenauflagen in Stuttgart/], ['Ampel', /Verfügbarkeit 2026/]],
  ausschreibungen: [['Kalender', /Fristenkalender/], ['Quelle', /Heidelberg[\s\S]*geprüft/]],
  marktindex: [['Antwort', /Im November 2026 \(vorläufig\) gab es in Stuttgart [\d.]+ Fahrten je Tag/], ['Rangliste', /1 Köln [\d.]+/], ['Wirkung', /Wirkung von Ereignissen[\s\S]*(mehr Fahrten|weniger Fahrten|nicht unterscheidbar)/], ['Scout', /Expansions-Scout[\s\S]*Leonberg/], ['Grafik der Woche', /Grafik der Woche/]],
  zonen: [['Antwort', /Dott hat in Stuttgart \d+ Zonen: \d+ Überlappungen/], ['Export geprüft', /Abstellverbot \d+ Zonen, [\d.]+ Stützpunkte ✓ Upload-Prüfung bestanden/], ['Änderungsverlauf', /Änderungsverlauf/]],
  begriffe: [['Begriffe', /Netto-Abfluss/], ['Erklärung', /Fahrtbeginne minus Fahrtenden/]],
  status: [['letzter Lauf', /LETZTER LAUF\s*\d\d:\d\d/i], ['Laufzeit mit Stufe', /LAUFZEIT\s*\d+ s/i], ['Verlauf', /Laufzeit der letzten 7 Tage/]],
};
const VIEWS = Object.keys(CHECKS).filter(v => !ONLY || ONLY.includes(v));
// S4.1: Ansichten mit Antwort-Komponente – genau eine Antwort vor dem ersten Diagramm, drei Kennzahlen, Antwortwert = Tabellenwert,
// auf dem Handy (390 × 844) die Kennzahlen im ersten Bildschirm
const ANSWER_VIEWS = ['live', 'usage', 'ops', 'prognose', 'bericht', 'spots', 'vergleich', 'sources', 'stadt', 'auflagen', 'ausschreibungen', 'zonen', 'marktindex'];
/** @param {import('playwright').Page} page @param {string} v @param {boolean} mobile */
async function answerProblems(page, v, mobile) {
  return page.evaluate(([x, mob]) => {
    const view = document.getElementById(`view-${x}`), out = [];
    const ans = /** @type {HTMLElement[]} */ ([...(view?.querySelectorAll('.answer') || [])]).filter(a => a.offsetParent !== null);
    if (ans.length !== 1) return [`${ans.length} statt genau einer Antwort`];
    const a = ans[0], kpis = /** @type {NodeListOf<HTMLElement>} */ (a.querySelectorAll('.ans-kpi'));
    if (kpis.length !== 3) out.push(`${kpis.length} statt drei Kennzahlen`);
    const chart = /** @type {HTMLElement[]} */ ([...view.querySelectorAll('svg.chart, svg[data-ct], .fv-chart svg, .rp-chart svg, .leaflet-container')]).find(c => c.offsetParent !== null);
    if (chart && !(a.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING)) out.push('Antwort steht nicht vor dem ersten Diagramm');
    const first = (el) => { const c = el.cloneNode(true); c.querySelectorAll('.sub-line, div').forEach(d => d.remove()); const m = (c.textContent || '').replace(/\./g, '').replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? +m[0] : 0; };
    for (const k of kpis) {
      if (!k.dataset.eq) continue;
      const n = +(/** @type {HTMLElement|null} */ (k.querySelector('.ans-v'))?.dataset.n ?? NaN), cells = [...view.querySelectorAll(k.dataset.eq)];
      if (!cells.length) { out.push(`keine Tabellenzelle für ${k.querySelector('dt')?.textContent}`); continue; }
      const sum = k.dataset.eqSum ? cells.reduce((s, c) => s + first(c), 0) : first(cells[0]);
      if (!(Math.abs(sum - n) <= 0.5 * cells.length + 1e-6)) out.push(`${k.querySelector('dt')?.textContent}: Antwort ${n} ≠ Tabelle ${sum}`);
    }
    // S4.2: höchstens ein Prognose-Urteil je Bildschirm; Quellenzahl der Antwort = Kachel „Quellen“ (ein Nenner, dataHealth)
    const vh = window.innerHeight, verdicts = [...view.querySelectorAll('.fv-verdict, .fv-verdict-in, .fv-gline')].filter(e => /** @type {HTMLElement} */ (e).offsetParent !== null).map(e => e.getBoundingClientRect().top + window.scrollY).sort((p, q) => p - q);
    for (let i = 1; i < verdicts.length; i++) if (verdicts[i] - verdicts[i - 1] < vh) out.push(`zwei Prognose-Urteile auf einem Bildschirm (${Math.round(verdicts[i - 1])} und ${Math.round(verdicts[i])} px)`);
    if (x === 'live') { const nums = (t) => (t.match(/\d[\d.]*/g) || []).map(z => +z.replace(/\./g, '')).join('/'); const tileV = [...view.querySelectorAll('#live-tiles .tile')].find(tl => /Quellen|Sources/.test(tl.querySelector('.l')?.textContent || ''))?.querySelector('.v');
      const ansV = kpis[2]?.querySelector('.ans-v'); if (tileV && ansV && nums(tileV.textContent) !== nums(ansV.textContent)) out.push(`Quellen: Antwort ${ansV.textContent} ≠ Kachel ${tileV.textContent}`); }
    if (mob) { window.scrollTo(0, 0); const b = a.querySelector('.ans-k')?.getBoundingClientRect(); if (b && b.bottom + window.scrollY > 844) out.push(`Kennzahlen enden bei ${Math.round(b.bottom + window.scrollY)} px (über 844)`); }
    return out;
  }, [v, mobile]);
}
const BAD_TEXT = /nicht ladbar|konnte nicht geladen|Fehler beim Laden/i;

const missing = new Set(); // Dateien, die die Seite anfragt und das Fixture nicht hat (Hinweis; optionale Dateien wie incidents/<heute> fehlen erlaubt)
// S3.8 Byte-Budget je Ansicht: Daten (gzip, wie Pages ausliefert), die eine frisch geöffnete Ansicht aus dem Datenstand lädt. Grenzen auf dem
// Fixture (2 Gemeinden, 3 Tage) mit etwa 15 % Luft – wächst eine Ansicht darüber, lädt sie mehr Dateien oder größere als bisher.
const BYTE_BUDGET_KB = { live: 145, ops: 190, bericht: 245, prognose: 220, sources: 140, usage: 140, staedte: 95 };
let byteView = null; const viewBytes = {};
const bytes = { add: (u, n) => { if (byteView && u.startsWith('/d/')) { const v = (viewBytes[byteView] ||= {}); v[u.slice(3)] = (v[u.slice(3)] || 0) + n; } } };
const server = await startFixtureServer(PORT, { missing, bytes });
const { chromium } = await import('playwright').catch(() => { console.error('Playwright fehlt: npm ci (devDependencies) und npx playwright install chromium'); process.exit(2); });
const fx = JSON.parse(await readFile(path.join(FIX, 'FIXTURE.json'), 'utf8'));
const browser = await chromium.launch();
let bad = 0;
const fail = (m) => { bad++; console.log(`✗ ${m}`); };
const blocked = new Map();

const TEXTS = new Map(); // Prüfwert → Text (bei abweichenden Läufen die erste Abweichung zeigen)
const i18nMissing = new Set(); // S3.5: Schlüssel, deren Wörterbuchbereich beim Zeichnen nicht geladen war (Debug-Warnung von web/i18n.js)
async function pass(run, { scope, viewport, checks, tag, lang = null }) {
  const { page, errs, setCur } = await openFixturePage(browser, { port: PORT, fx, scope, viewport, lang, blocked,
    onConsole: (t, cur) => { const w = /\[i18n\] Schlüssel fehlt: (\w+) → (\S+)/.exec(t); if (w) i18nMissing.add(`${w[1]}:${w[2]} (${cur})`); } });
  const sums = {};
  for (const v of VIEWS) {
    setCur(v); await page.evaluate((x) => { location.hash = x; }, v);
    const txt = await settledText(page, v);
    sums[v] = createHash('sha1').update(mask(txt)).digest('hex').slice(0, 10); TEXTS.set(sums[v], mask(txt));
    const res = [];
    if (txt.length < 300) res.push(`zu wenig Inhalt (${txt.length} Zeichen)`);
    if (BAD_TEXT.test(txt)) res.push(`Ladefehler im Text: „${txt.match(BAD_TEXT)[0]}“`);
    if (checks) for (const [name, re] of CHECKS[v]) if (!re.test(txt)) res.push(`fehlt: ${name}`);
    // S4.8: jeder Leerzustand nennt eine Handlung (Knopf, Link, Auswahl) oder eine Zeitangabe
    if (!lang) for (const p of await page.evaluate((x) => [...document.querySelectorAll(`#view-${x} div.empty, #view-${x} p.empty, #view-${x} td.empty[colspan]`)].filter(e => /** @type {HTMLElement} */ (e).offsetParent !== null && !e.querySelector('a, button, select')
      && !/\d+ ?(Min|Minuten|Stunden?|Std|Tagen?|h)\b|nächste[nmr]? (Lauf|Läufen)|morgen|ab \d|um \d\d:\d\d|seit |mit (dem|den) (nächsten|kommenden)/i.test(e.textContent || '')).map(e => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90)), v)) res.push(`Leerzustand ohne Handlung/Zeit: „${p}“`);
    if (ANSWER_VIEWS.includes(v) && !lang) for (const p of await answerProblems(page, v, viewport.width < 500)) res.push(`Antwort: ${p}`);
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
  // S3.8 Rest: Start in der Disposition mit latest-core.json – gleicher Text wie ohne latest-core.json (älterer Datenstand: Start mit latest.json),
  // auch nach dem Wechsel in Ansichten, die latest.json nachladen
  if (!ONLY) {
    const seq = ['ops', 'live', 'sources', 'staedte'], got = {};
    for (const [tag, missing] of /** @type {Array<[string, string[]]>} */ ([['voll', ['latest-core.json']], ['lite', []]])) {
      byteView = tag;
      const { page, errs, close } = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 1440, height: 900 }, hash: 'ops', missing });
      got[tag] = {}; for (const v of seq) { if (v !== 'ops') await page.evaluate((x) => { location.hash = x; }, v); got[tag][v] = createHash('sha1').update(mask(await settledText(page, v))).digest('hex').slice(0, 10); }
      await close(); byteView = null; if (errs.length) fail(`Start in der Disposition (${tag}): Skriptfehler ${errs.slice(0, 3).join('; ')}`);
    }
    const files = Object.keys(viewBytes.lite || {}), diff = seq.filter(v => got.lite[v] !== got.voll[v]);
    if (diff.length || !files.includes('latest-core.json') || !files.includes('latest.json')) fail(`Start in der Disposition: ${diff.length ? `anders als mit latest.json: ${diff.join(', ')}` : ''}${files.includes('latest-core.json') ? '' : ' latest-core.json nicht geladen'}${files.includes('latest.json') ? '' : ' latest.json beim Wechsel nicht nachgeladen'}`);
    else console.log(`✓ Start in der Disposition mit latest-core.json: ${seq.join(', ')} gleich wie mit latest.json, latest.json erst beim Wechsel`);
  }
  // S5.6: jeder alte Link (Ansicht, Alias) landet in der passenden Ansicht; ?rolle= ohne Ansicht startet in der Ansicht der Rolle; S4.8: Erstbesuch-Karte
  if (!ONLY) {
    const src = await readFile(new URL('../web/app-router.js', import.meta.url), 'utf8');
    const views = JSON.parse(src.match(/export const VIEWS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
    const alias = Object.fromEntries([...src.match(/export const VIEW_ALIAS = \{([^}]*)\}/)[1].matchAll(/'?([\wäöüß-]+)'?: '([\w-]+)'/g)].map(m => [m[1], m[2]]));
    const links = [...views.map(v => [v, v]), ...Object.entries(alias)];
    const { page, close } = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 1280, height: 900 } });
    const wrong = [];
    for (const [h, want] of links) { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(60); const got = await page.evaluate(() => document.querySelector('section.view.active')?.id); if (got !== `view-${want}`) wrong.push(`#${h} → ${got} statt view-${want}`); }
    await close();
    if (wrong.length) fail(`alte Links: ${wrong.slice(0, 6).join('; ')}`); else console.log(`✓ alte Links: ${links.length} Ansichten und Aliasse landen in der passenden Ansicht`);
    for (const [role, want] of [['betrieb', 'ops'], ['analyse', 'usage'], ['stadt', src.match(/stadt: '([\w-]+)'/)[1]]]) {
      const o = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 1280, height: 900 }, hash: '', query: `&rolle=${role}` });
      const got = await o.page.waitForFunction(() => document.querySelector('section.view.active')?.id, null, { timeout: 15000 }).then(h => h.jsonValue()).catch(() => null);
      await o.close(); if (got !== `view-${want}`) fail(`?rolle=${role}: ${got} statt view-${want}`); else console.log(`✓ ?rolle=${role} startet in ${want}`);
    }
    const fv = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 390, height: 844 }, firstVisit: true });
    const card = await fv.page.waitForSelector('#first-visit:not([hidden]) button[data-role="betrieb"]', { timeout: 15000 }).catch(() => null);
    if (!card) fail('Erstbesuch-Karte fehlt'); else { await card.click(); await fv.page.waitForTimeout(300); const v = await fv.page.evaluate(() => [location.hash, localStorage.getItem('mp-rolle'), !!document.querySelector('#first-visit[hidden]')]);
      if (v[0] !== '#ops' || v[1] !== 'betrieb' || !v[2]) fail(`Erstbesuch-Karte: ${JSON.stringify(v)}`); else console.log('✓ Erstbesuch-Karte: Wahl „Betrieb“ öffnet die Disposition und wird gemerkt'); }
    await fv.close();
  }
  // S5.5: Kommunal-Bericht im Druck – Antwort und Kennzahlen vorn, der Kern endet nach höchstens zwei A4-Seiten (Inhalt 186 × 269 mm), Anhang danach
  if (!ONLY) {
    const o = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 703, height: 1016 }, hash: 'bericht' });
    await settledText(o.page, 'bericht');
    await o.page.evaluate(() => { window.print = () => {}; });
    await o.page.click('#view-bericht button[data-rp="print"]');
    await o.page.waitForSelector('.rp-print-root .rp-appendix', { state: 'attached', timeout: 20000 }).catch(() => null);
    await o.page.emulateMedia({ media: 'print' });
    const m = await o.page.evaluate(() => { const r = document.querySelector('.rp-print-root'), a = r?.querySelector('.rp-appendix'), ans = r?.querySelector('.answer');
      return r && a ? { core: a.getBoundingClientRect().top - r.getBoundingClientRect().top, answerFirst: !!ans && ans.getBoundingClientRect().top < (r.querySelector('table')?.getBoundingClientRect().top ?? Infinity) } : null; });
    await o.close();
    const page = 269 / 25.4 * 96;
    if (!m) fail('Bericht im Druck: Anhang nicht gefunden');
    else if (!m.answerFirst || m.core > 2 * page) fail(`Bericht im Druck: Kern ${(m.core / page).toFixed(2)} Seiten${m.answerFirst ? '' : ', Antwort nicht vorn'}`);
    else console.log(`✓ Bericht im Druck: Antwort vorn, Kern ${(m.core / page).toFixed(2)} Seiten (höchstens 2), Anhang ab neuer Seite`);
  }
  // S3.7: passt die MAJOR-Version einer Datei nicht zur Seite, erscheint ein Hinweis (hier status.json mit 9.0)
  if (!ONLY) {
    const { page, close } = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 1280, height: 900 }, patch: { 'status.json': (d) => ({ ...d, schemaVersion: '9.0' }) } });
    const ok = await page.waitForFunction(() => /Datenformat passt nicht zur Seite: status\.json hat Version 9\.0/.test(document.getElementById('notice')?.innerText || ''), null, { timeout: 15000 }).then(() => true, () => false);
    if (ok) console.log('✓ Hinweis bei abweichender Formatversion (status.json 9.0)'); else fail('kein Hinweis bei abweichender Formatversion (status.json 9.0)');
    await close();
  }
  // S6.5: Akku-Prognose für einen Anbieter mit Ladestand (Dott Stuttgart): Satz, Zonen, CSV, Häkchen plant die Tauschtouren neu
  if (!ONLY || ONLY.includes('ops')) {
    const { page, errs, close } = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 1280, height: 900 }, hash: 'ops', query: '&op=Dott' });
    const sub = await page.waitForFunction(() => { const x = document.getElementById('ops-akku-sub')?.textContent || ''; return /fallen voraussichtlich/.test(x) ? x : null; }, null, { timeout: 60000 }).then(h => h.jsonValue()).catch(() => null);
    const rows = await page.evaluate(() => document.querySelectorAll('#ops-akku tbody tr').length), csv = await page.evaluate(() => !document.getElementById('ops-akku-csv')?.disabled);
    const before = await page.evaluate(() => document.getElementById('ops-runs')?.innerText || '');
    await page.click('#ops-akku-swap').catch(() => null);
    const replanned = await page.waitForFunction((b) => (document.getElementById('ops-runs')?.innerText || '') !== b, before, { timeout: 30000 }).then(() => true, () => false);
    const m = /fallen voraussichtlich ([\d.]+) von ([\d.]+) verfügbaren Fahrzeugen mit Ladestand unter 20 %, ([\d.]+) sind schon darunter/.exec(sub || '');
    if (!m || rows < 5 || !csv || !replanned || errs.length) fail(`Akku-Prognose Dott: ${JSON.stringify({ sub, rows, csv, replanned, errs: errs.slice(0, 2) })}`);
    else console.log(`✓ Akku-Prognose Dott Stuttgart: ${m[1]} von ${m[2]} bis 8 Uhr unter 20 % (${m[3]} schon darunter), ${rows} Zonen, Häkchen plant die Tauschtouren neu`);
    await close();
  }
  // S6.2/S6.6: Fahrermodus mit 20 Stopps im Flugmodus, Trefferflächen, Blatt ohne Sprung
  if (!ONLY || ONLY.includes('fahrer')) await driverChecks(browser, PORT, fail);
} finally { await browser.close(); server.close(); }
const firstDiff = (h0, h1) => { const a = (TEXTS.get(h0) || '').split(' '), b = (TEXTS.get(h1) || '').split(' '); let i = 0; while (i < a.length && a[i] === b[i]) i++; return `\n    Lauf 1: …${a.slice(Math.max(0, i - 12), i + 18).join(' ')}…\n    dieser: …${b.slice(Math.max(0, i - 12), i + 18).join(' ')}…`; };
if (RUNS > 1) for (let r = 1; r < RUNS; r++) for (const side of ['a', 'b']) for (const v of VIEWS) if (runs[r][side][v] !== runs[0][side][v]) fail(`Lauf ${r + 1} weicht ab: ${side === 'a' ? 'Desktop' : 'Handy'} ${v} (${runs[0][side][v]} ≠ ${runs[r][side][v]})${firstDiff(runs[0][side][v], runs[r][side][v])}`);
console.log(`Netz: nur 127.0.0.1 erreicht; abgebrochen ${[...blocked].map(([h, n]) => `${h} ×${n}`).join(', ') || 'nichts'}`);
if (missing.size) console.log(`Im Fixture nicht vorhanden (404): ${[...missing].sort().join(', ')}`);
if (i18nMissing.size) fail(`${i18nMissing.size} Texte ohne geladenen Wörterbuchbereich (S3.5): ${[...i18nMissing].slice(0, 12).join(', ')}`);
else console.log('Wörterbuch: 0 fehlende Schlüssel in Deutsch und Englisch');
console.log(`Prüfwerte: ${VIEWS.map(v => `${v}=${runs[0].a[v]}`).join(' ')}`);
console.log(`${bad ? `${bad} Befunde` : 'Browser-Tests grün'} · ${RUNS} Lauf/Läufe · ${((Date.now() - t0) / 1000).toFixed(0)} s · Fixture ${fx.days.join(', ')}`);
process.exit(bad ? 1 : 0);
