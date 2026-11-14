#!/usr/bin/env node
// Monats-Steckbrief als PDF (S5.4): Kommunal-Bericht des Vormonats je Gemeinde mit amtlicher Obergrenze (data/reference.json → obergrenzen),
// gedruckt wie über den Knopf „Drucken / PDF“ (Antwort und Kennzahlen vorn, Herleitung im Anhang, S5.5); dazu der Deutschland-Index des
// Monats (S7.1, Ansicht Markt) als deutschland-index.pdf.
//   node scripts/monatsbericht.mjs <Checkout des Branches data> [JJJJ-MM] [AGS,AGS,…]   (Ausgabe: BERICHTE_OUT, Standard ./berichte)
// Liefert die Seite aus docs/ und den Datenstand lokal aus (kein Netz außer 127.0.0.1), schreibt <Ausgabe>/<JJJJ-MM>/<AGS>.pdf und
// <Ausgabe>/index.json (veröffentlicht im Branch berichte, nicht im Datenzweig). Läuft am 1. des Monats im Workflow „Monatsbericht“ (Vorlage scripts/monatsbericht-workflow.yml).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DATA = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('Aufruf: node scripts/monatsbericht.mjs <Checkout des Branches data> [JJJJ-MM] [AGS,…]'); process.exit(2); }
const berlin = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const prevMonth = (() => { const [y, m] = berlin.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
const MONTH = /^\d{4}-\d{2}$/.test(process.argv[3] || '') ? process.argv[3] : prevMonth;
const ref = JSON.parse(await readFile(path.join(ROOT, 'data', 'reference.json'), 'utf8'));
const LIST = process.argv[4] ? process.argv[4].split(',') : [...new Set((ref.obergrenzen || []).map(r => r.ags).filter(a => /^\d{8}$/.test(a || '')))];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.xml': 'application/atom+xml' };

// docs/ unter /, Datenstand unter /d/, data/ (main) unter /data/
const server = createServer(async (req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [base, rel] = u.startsWith('/d/') ? [DATA, u.slice(3)] : u.startsWith('/data/') ? [path.join(ROOT, 'data'), u.slice(6)] : [path.join(ROOT, 'docs'), u.endsWith('/') ? `${u}index.html` : u];
  const f = path.join(base, rel); if (!f.startsWith(base)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', () => r(null)));
const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
const { chromium } = await import('playwright');
const browser = await chromium.launch();
const OUT = path.resolve(process.env.BERICHTE_OUT || 'berichte'), out = path.join(OUT, MONTH); await mkdir(out, { recursive: true });
const done = [];
try {
  for (const ags of LIST) {
    const ctx = await browser.newContext({ viewport: { width: 703, height: 1016 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    await ctx.addInitScript(() => { try { localStorage.setItem('mp-first-done', '1'); } catch { /* ohne Speicher */ } });
    const page = await ctx.newPage();
    await page.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
    await page.goto(`http://127.0.0.1:${port}/?data=/d/&scope=${ags}&period=m:${MONTH}#bericht`, { waitUntil: 'load', timeout: 60000 });
    const ready = await page.waitForSelector('#view-bericht .rp-report', { timeout: 90000 }).then(() => true, () => false);
    if (!ready) { console.log(`– ${ags}: kein Bericht (keine Daten für ${MONTH})`); await ctx.close(); continue; }
    const period = await page.$eval('#view-bericht select[data-rp="period"]', (s) => /** @type {HTMLSelectElement} */ (s).value).catch(() => null);
    if (period !== `m:${MONTH}`) { console.log(`– ${ags}: Monat ${MONTH} nicht im Datenstand (gewählt: ${period})`); await ctx.close(); continue; }
    await page.evaluate(() => { window.print = () => {}; });
    await page.click('#view-bericht button[data-rp="print"]');
    await page.waitForSelector('.rp-print-root', { state: 'attached', timeout: 60000 });
    await page.emulateMedia({ media: 'print' });
    const file = path.join(out, `${ags}.pdf`);
    await page.pdf({ path: file, format: 'A4', printBackground: true, preferCSSPageSize: true });
    done.push(ags); console.log(`✓ ${ags}: ${path.relative(OUT, file)}`);
    await ctx.close();
  }
  // S7.1: Deutschland-Index des Monats als PDF (Ansicht Markt, Gebiet Deutschland), nur wenn der Monat abgeschlossen im Datenstand steht
  {
    const ctx = await browser.newContext({ viewport: { width: 703, height: 1016 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    await ctx.addInitScript(() => { try { localStorage.setItem('mp-first-done', '1'); } catch { /* ohne Speicher */ } });
    const page = await ctx.newPage();
    await page.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
    await page.goto(`http://127.0.0.1:${port}/?data=/d/&scope=DE#marktindex`, { waitUntil: 'load', timeout: 60000 });
    const ok = await page.waitForSelector('#view-marktindex #mk-idx', { timeout: 90000 }).then(() => true, () => false);
    if (ok && await page.$(`#view-marktindex #mk-month option[value="${MONTH}"]`)) {
      await page.selectOption('#view-marktindex #mk-month', MONTH); await page.waitForTimeout(1500);
      await page.evaluate(() => { window.print = () => {}; document.body.classList.add('mk-printing'); });
      await page.emulateMedia({ media: 'print' });
      const file = path.join(out, `deutschland-index.pdf`);
      await page.pdf({ path: file, format: 'A4', printBackground: true });
      done.push('deutschland-index'); console.log(`✓ Deutschland-Index: ${path.relative(OUT, file)}`);
    } else console.log(`– Deutschland-Index ${MONTH} noch nicht abgeschlossen im Datenstand`);
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
const idxFile = path.join(OUT, 'index.json');
const idx = JSON.parse(await readFile(idxFile, 'utf8').catch(() => '{"months":{}}'));
idx.months[MONTH] = done.sort(); idx.at = Date.now();
await writeFile(idxFile, JSON.stringify(idx));
console.log(`${done.length} Monatsberichte ${MONTH} geschrieben`);
