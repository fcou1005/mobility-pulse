#!/usr/bin/env node
// Browser-Rauchtest (Audit OPS-13): docs/ lokal ausliefern, jede Ansicht öffnen, Skriptfehler (pageerror) und leere Ansichten melden.
// Daten kommen wie auf der Seite aus dem Branch data (raw.githubusercontent.com). Exit 1 bei Fehlern. SMOKE_PORT (Standard 8790), SMOKE_WAIT_MS.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), PORT = +process.env.SMOKE_PORT || 8790, WAIT = +process.env.SMOKE_WAIT_MS || 6000;
const VIEWS = (process.env.VIEWS || 'live,lab,staedte,usage,coverage,vergleich,bericht,ops,spots,prognose,prognose-spots,prognose-basis,sources,signals').split(',');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname), f = path.join(ROOT, 'docs', u.endsWith('/') ? `${u}index.html` : u);
  if (!f.startsWith(path.join(ROOT, 'docs'))) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(b); } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
const browser = await chromium.launch({ proxy });
let bad = 0;
try {
  for (const [tag, vp] of [['Desktop', { width: 1440, height: 900 }], ['Handy', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport: vp }); let cur = 'start'; const errs = [];
    page.on('pageerror', e => errs.push(`${cur}: ${e.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/#live`, { waitUntil: 'load', timeout: 90000 }); await page.waitForTimeout(WAIT * 2);
    for (const v of VIEWS) {
      cur = v; await page.evaluate((x) => { location.hash = x; }, v); await page.waitForTimeout(WAIT);
      const len = await page.evaluate((x) => (document.getElementById(`view-${x}`)?.innerText || '').trim().length, v);
      const ok = len > 80; if (!ok) bad++;
      console.log(`${ok ? '✓' : '✗'} ${tag} ${v.padEnd(15)} ${len} Zeichen`);
    }
    if (errs.length) { bad += errs.length; console.log(`✗ ${tag}: ${errs.length} Skriptfehler\n  ${errs.slice(0, 10).join('\n  ')}`); }
    await page.close();
  }
} finally { await browser.close(); server.close(); }
console.log(bad ? `${bad} Befunde` : 'Rauchtest grün');
process.exit(bad ? 1 : 0);
