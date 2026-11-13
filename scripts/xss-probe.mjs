// XSS-Probe (Sprint 0, S0.3): öffnet alle Ansichten mit einem Datenstand, in dem jeder Name eine HTML-Nutzlast trägt, und zählt
// eingeschleuste Elemente und Attribute. Erwartung: 0 Treffer in jeder Ansicht und jeder Sprache.
//
// Aufruf (lokal, braucht Chrome/Chromium und playwright oder playwright-core):
//   PROBE_DATA=/pfad/zum/data-branch node scripts/xss-probe.mjs
// Optional: CHROME_PATH=/usr/bin/google-chrome, PW_MODULE=/pfad/zu/playwright-core/index.mjs, VIEWS=ops,spots, LANGS=de, WAIT=12000, SCOPE=08111000
//
// Die Nutzlast wird nur beim Ausliefern eingesetzt (Kopie im Speicher), der Datenstand auf der Platte bleibt unverändert.
// Eingeschleust wird in Werte, die wie Namen aussehen (Großbuchstabe am Anfang, kein Datum, keine URL), und in die entsprechenden
// Teile von Schlüsseln wie „AGS|Anbieter|Art“, damit Verknüpfungen zwischen den Dateien erhalten bleiben.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DOCS = path.join(ROOT, 'docs'), MAIN = path.join(ROOT, 'data');
const DATA = process.env.PROBE_DATA;
if (!DATA) { console.error('PROBE_DATA fehlt: Pfad zu einem ausgecheckten data-Branch'); process.exit(2); }
const PORT = +process.env.PORT || 8797, WAIT = +process.env.WAIT || 12000, SCOPE = process.env.SCOPE || '08111000';
const VIEWS = (process.env.VIEWS || 'live,lab,staedte,usage,coverage,vergleich,bericht,ops,spots,prognose,prognose-spots,prognose-basis,sources,signals').split(',');
const LANGS = (process.env.LANGS || 'de,en').split(',');

// Text-Kontext: Element; Attribut-Kontext: schließt "…" und setzt ein eigenes Attribut
const PAYLOAD = ' <b data-xss="1">x</b>" data-xss-attr="1';
const NAMEISH = /^[A-ZÄÖÜ][\p{L}\p{N} .,'&()/+-]{1,60}$/u;
const inject = (s) => (NAMEISH.test(s) && /\p{Ll}/u.test(s) && !/^\d{4}-\d{2}/.test(s) && !/^https?:/i.test(s) ? s + PAYLOAD : s);
const injectKey = (k) => (k.includes('|') ? k.split('|').map(inject).join('|') : inject(k));
function walk(v) {
  if (typeof v === 'string') return inject(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[injectKey(k)] = walk(x); return o; }
  return v;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.gz': 'application/gzip' };
const cache = new Map();
const srv = http.createServer(async (req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = u.startsWith('/d/') ? path.join(DATA, u.slice(3)) : u.startsWith('/data/') ? path.join(MAIN, u.slice(6)) : path.join(DOCS, u.endsWith('/') ? `${u}index.html` : u);
  try {
    let body = cache.get(f);
    if (!body) {
      body = await readFile(f);
      if (!process.env.NO_INJECT && (u.startsWith('/d/') || u.startsWith('/data/')) && f.endsWith('.json')) { try { body = Buffer.from(JSON.stringify(walk(JSON.parse(body.toString('utf8'))))); } catch { /* kein JSON: unverändert */ } }
      cache.set(f, body);
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'access-control-allow-origin': '*' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
// SERVE_ONLY=1: nur den präparierten Stand ausliefern (zum Nachsehen im eigenen Browser); NO_INJECT=1: Datenstand unverändert
if (process.env.SERVE_ONLY) { console.log(`http://127.0.0.1:${PORT}/index.html?data=/d/&scope=${SCOPE}`); await new Promise(() => {}); }

const pw = await import(process.env.PW_MODULE || 'playwright').catch(() => import('playwright-core'));
const browser = await pw.chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox'] });
let total = 0; const rows = [];
for (const lang of LANGS) for (const v of VIEWS) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.slice(0, 100)));
  // nur der lokale Server; Kacheln, Router und Live-Feeds der Anbieter bleiben draußen
  await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
  await page.goto(`http://127.0.0.1:${PORT}/index.html?data=/d/&scope=${SCOPE}&lang=${lang}#${v}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(WAIT);
  const hit = await page.evaluate(() => ({
    el: document.querySelectorAll('[data-xss]').length,
    attr: document.querySelectorAll('[data-xss-attr]').length,
    meta: document.querySelectorAll('body meta[http-equiv], body base').length,
    where: [...document.querySelectorAll('[data-xss],[data-xss-attr]')].slice(0, 3).map(e => `${e.tagName.toLowerCase()} in ${e.closest('[id]')?.id || '?'}`),
  }));
  const n = hit.el + hit.attr + hit.meta; total += n;
  rows.push({ lang, view: v, ...hit, errs: errs.length });
  console.log(`${lang} ${v.padEnd(15)} Elemente ${hit.el}  Attribute ${hit.attr}  meta/base ${hit.meta}  Skriptfehler ${errs.length}${hit.where.length ? `  → ${hit.where.join(', ')}` : ''}`);
  await ctx.close();
}
await browser.close(); srv.close();
console.log(total ? `\n${total} Treffer – XSS möglich` : '\n0 Treffer in allen Ansichten');
process.exitCode = total ? 1 : 0;
