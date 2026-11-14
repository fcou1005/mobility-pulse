#!/usr/bin/env node
// S3.6 Barrierefreiheit und Referenz-Screenshots mit festem Datenstand (Fixture wie test/browser.mjs, kein Netz).
//  1. axe-core (WCAG 2.1 A/AA) auf Live, Disposition, Bericht, Prognose und Quellen: 0 Verstöße ist harte Grenze.
//     Die CSP der Seite blockt das Einspritzen von axe, daher bypassCSP. Vorab ein Selbsttest: ein absichtlich zu
//     schwacher Kontrast muss als Verstoß erkannt werden, sonst ist der Test selbst kaputt (Abnahme S3.6).
//     A11Y_BREAK=1 baut denselben schwachen Kontrast in die echten Ansichten ein – der Lauf muss dann rot werden.
//  2. Referenz-Screenshots aller Ansichten (erster Bildschirm, 1280×800, Zeitangaben maskiert) gegen test/screenshots/.
//     Vergleich im Browser per Canvas (keine weitere Abhängigkeit): höchstens 0,1 % abweichende Pixel je Ansicht (zwei Läufe hier: 0,00 %).
//     Die Referenzen gelten für die Umgebung, in der sie entstanden (Chromium-Version, Schriften des Systems für
//     Zeichen außerhalb von IBM Plex); weicht die Umgebung ab, wird nur gemeldet und nicht verglichen.
//     Neu anlegen: UPDATE_SCREENSHOTS=1 node test/a11y.mjs  · Abweichungen landen als Bild in /tmp/mp-shots/.
//   node test/a11y.mjs   (Port A11Y_PORT, Standard 8768)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { startFixtureServer, FIX, ROOT } from './fixture-server.mjs';
import { openFixturePage, settledText, maskTimesInPage } from './browser-lib.mjs';

const PORT = +process.env.A11Y_PORT || 8768;
const AXE_VIEWS = ['live', 'ops', 'bericht', 'prognose', 'sources', 'stadt', 'auflagen', 'ausschreibungen', 'begriffe'];
const SHOT_VIEWS = ['live', 'lab', 'staedte', 'usage', 'coverage', 'vergleich', 'bericht', 'ops', 'spots', 'prognose', 'prognose-spots', 'prognose-basis', 'sources', 'signals', 'status', 'stadt', 'auflagen', 'ausschreibungen', 'begriffe'];
const SHOT_DIR = path.join(ROOT, 'test/screenshots'), OUT = '/tmp/mp-shots';
const MAX_DIFF = 0.001, UPDATE = !!process.env.UPDATE_SCREENSHOTS, BREAK = !!process.env.A11Y_BREAK;
const ONLY = process.env.VIEWS ? process.env.VIEWS.split(',') : null;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BAD_CONTRAST = '<p id="a11y-break" style="color:#c8c8c8;background:#fff;font-size:14px;padding:4px">Absichtlich zu schwacher Kontrast</p>';

const { chromium } = await import('playwright').catch(() => { console.error('Playwright fehlt: npm ci (devDependencies) und npx playwright install chromium'); process.exit(2); });
const { default: AxeBuilder } = await import('@axe-core/playwright').catch(() => { console.error('@axe-core/playwright fehlt: npm ci'); process.exit(2); });
const fx = JSON.parse(await readFile(path.join(FIX, 'FIXTURE.json'), 'utf8'));
const server = await startFixtureServer(PORT);
const browser = await chromium.launch();
let bad = 0;
const fail = (m) => { bad++; console.log(`✗ ${m}`); };

/** Umgebung, für die Screenshots vergleichbar sind: Chromium-Version und die Systemschriften */
function environment() {
  let fonts = '';
  try { fonts = execSync('fc-list : family 2>/dev/null', { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean).sort().join('|'); } catch { fonts = 'unbekannt'; }
  return { chromium: browser.version(), fonts: createHash('sha1').update(fonts).digest('hex').slice(0, 12), platform: process.platform };
}

const violText = (v) => `${v.id} (${v.impact}): ${v.nodes.length}× – ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`;
async function axe(page, view) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze(); // ganze Seite; verborgene Ansichten prüft axe nicht
  return r.violations;
}

const t0 = Date.now();
try {
  // 1a. Selbsttest: erkennt axe einen schwachen Kontrast?
  {
    const { page, close } = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 1280, height: 800 }, bypassCSP: true });
    await settledText(page, 'live');
    await page.evaluate((h) => document.getElementById('view-live')?.insertAdjacentHTML('afterbegin', h), BAD_CONTRAST);
    const v = await axe(page, 'live');
    if (v.some(x => x.id === 'color-contrast' && x.nodes.some(n => n.target.join(' ').includes('a11y-break')))) console.log('✓ Selbsttest: absichtlich schwacher Kontrast wird erkannt');
    else fail('Selbsttest: absichtlich schwacher Kontrast wurde NICHT erkannt – Barrierefreiheitsprüfung ist wirkungslos');
    await close();
  }
  // 1b. Ansichten prüfen
  {
    const { page, errs, setCur, close } = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 1440, height: 900 }, bypassCSP: true });
    for (const v of AXE_VIEWS.filter(x => !ONLY || ONLY.includes(x))) {
      setCur(v); await page.evaluate((x) => { location.hash = x; }, v);
      await settledText(page, v);
      if (BREAK) await page.evaluate(([x, h]) => document.getElementById(`view-${x}`)?.insertAdjacentHTML('afterbegin', h), [v, BAD_CONTRAST]);
      const viol = await axe(page, v);
      if (viol.length) fail(`axe ${v}: ${viol.length} Regel(n) verletzt\n    ${viol.map(violText).join('\n    ')}`);
      else console.log(`✓ axe ${v.padEnd(10)} 0 Verstöße (WCAG 2.1 AA)`);
    }
    if (errs.length) fail(`Skriptfehler: ${errs.slice(0, 5).join(' | ')}`);
    await close();
  }
  // 1c. Fahrermodus (S6.2/S6.6): Handy, Tour mit 20 Stopps, Blatt halb geöffnet
  if (!ONLY || ONLY.includes('fahrer')) {
    const { tour20 } = await import('./browser-fahrer.mjs'), { encodeTour } = await import('../lib/pulse-fahrer.js');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'de-DE' });
    await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
    const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${PORT}/fahrer.html#t=${encodeTour(tour20())}`, { waitUntil: 'load' });
    await page.evaluate(() => /** @type {any} */ (window).__drv.snapTo('half')); await page.waitForTimeout(900);
    const viol = await axe(page, 'fahrer');
    if (viol.length) fail(`axe fahrer: ${viol.length} Regel(n) verletzt\n    ${viol.map(violText).join('\n    ')}`); else console.log('✓ axe fahrer     0 Verstöße (WCAG 2.1 AA)');
    await ctx.close();
  }
  // 2. Referenz-Screenshots
  {
    const env = environment(), metaFile = path.join(SHOT_DIR, 'umgebung.json');
    const ref = existsSync(metaFile) ? JSON.parse(await readFile(metaFile, 'utf8')) : null;
    const same = ref && ref.chromium === env.chromium && ref.fonts === env.fonts && ref.platform === env.platform;
    if (UPDATE) await mkdir(SHOT_DIR, { recursive: true });
    else if (!same) console.log(`Screenshots: Referenz aus anderer Umgebung (${ref ? `Chromium ${ref.chromium}, Schriften ${ref.fonts}` : 'keine'}; hier Chromium ${env.chromium}, Schriften ${env.fonts}) – nur Aufnahme nach ${OUT}, kein Vergleich`);
    await mkdir(OUT, { recursive: true });
    const { page, close } = await openFixturePage(browser, { port: PORT, fx, scope: '08111000', viewport: { width: 1280, height: 800 } });
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}' });
    const res = [];
    for (const v of SHOT_VIEWS.filter(x => !ONLY || ONLY.includes(x))) {
      await page.evaluate((x) => { location.hash = x; window.scrollTo(0, 0); }, v);
      await settledText(page, v);
      await maskTimesInPage(page);
      await page.waitForTimeout(150);
      const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      const file = path.join(SHOT_DIR, `${v}.png`);
      if (UPDATE) { await writeFile(file, png); res.push(`${v} neu`); continue; }
      await writeFile(path.join(OUT, `${v}.png`), png);
      if (!same || !existsSync(file)) continue;
      const refPng = await readFile(file);
      const d = await page.evaluate(async ([a, b]) => {
        const load = (s) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = `data:image/png;base64,${s}`; });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        if (ia.width !== ib.width || ia.height !== ib.height) return { size: `${ia.width}×${ia.height} statt ${ib.width}×${ib.height}`, share: 1 };
        const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height; const g = c.getContext('2d');
        g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
        g.clearRect(0, 0, c.width, c.height); g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0; for (let k = 0; k < da.length; k += 4) if (Math.abs(da[k] - db[k]) > 24 || Math.abs(da[k + 1] - db[k + 1]) > 24 || Math.abs(da[k + 2] - db[k + 2]) > 24) n++;
        return { share: n / (da.length / 4) };
      }, [png.toString('base64'), refPng.toString('base64')]);
      if (d.share > MAX_DIFF) fail(`Screenshot ${v}: ${d.size || `${(d.share * 100).toFixed(2)} % der Pixel abweichend`} (Grenze ${MAX_DIFF * 100} %) – aktuell: ${OUT}/${v}.png`);
      else res.push(`${v} ${(d.share * 100).toFixed(2)} %`);
    }
    if (UPDATE) await writeFile(metaFile, `${JSON.stringify({ ...env, at: new Date(fx.at).toISOString(), viewport: '1280x800' }, null, 1)}\n`);
    if (res.length) console.log(`✓ Screenshots ${UPDATE ? 'angelegt' : 'wie Referenz'}: ${res.join(', ')}`);
    await close();
  }
} finally { await browser.close(); server.close(); }
console.log(`${bad ? `${bad} Befunde` : 'Barrierefreiheit und Screenshots grün'}${BREAK ? ' (A11Y_BREAK: Rot erwartet)' : ''} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(bad ? 1 : 0);
