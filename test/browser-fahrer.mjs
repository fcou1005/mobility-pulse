// S6.2/S6.6 Fahrermodus im Browser (aus test/browser.mjs): Tour mit 20 Stopps am Handy (390 × 844, Touch) öffnen, Flugmodus, neu laden
// (Service Worker), alle Stopps abarbeiten; Trefferflächen ≥ 44 px, Bedienung mit dem Daumen (nächster Stopp in der unteren Bildhälfte),
// nichts springt beim Öffnen des Blatts, prefers-reduced-motion ohne Bewegung.
import { makeTour, encodeTour } from '../lib/pulse-fahrer.js';

export function tour20() {
  const stops = Array.from({ length: 20 }, (_, i) => ({ type: ['pickup', 'drop', 'swap', 'pickup_disabled'][i % 4], lat: 48.775 + (i % 5) * 0.004, lon: 9.17 + Math.floor(i / 5) * 0.006, count: 1 + (i % 3), eta: 360 + i * 9, note: i % 4 === 1 ? `Spot ${i}` : '' }));
  return makeTour({ id: 'F1', title: 'Stuttgart · Voi', at: Date.parse('2026-11-14T05:30:00Z'), day: '2026-11-14', depot: { lat: 48.78, lon: 9.18 }, stops });
}

/** @param {import('playwright').Browser} browser @param {number} port @param {(m: string) => void} fail */
export async function driverChecks(browser, port, fail) {
  const ok = (m) => console.log(`✓ ${m}`);
  const url = `http://127.0.0.1:${port}/fahrer.html#t=${encodeTour(tour20())}`;
  for (const reduced of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'de-DE', timezoneId: 'Europe/Berlin', reducedMotion: reduced ? 'reduce' : 'no-preference', serviceWorkers: 'allow' });
    await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
    const page = await ctx.newPage(), errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 }).catch(() => fail('Fahrermodus: Service Worker übernimmt die Seite nicht'));
    const tag = reduced ? ' (reduzierte Bewegung)' : '';
    if (!reduced) {
      // Flugmodus, neu laden: Seite aus dem Service Worker, Tour aus dem Link, Hinweis mit Datenstand
      await ctx.setOffline(true);
      await page.reload({ waitUntil: 'load' });
      const n = await page.locator('#stops li.stop').count(), off = await page.locator('#offline').innerText().catch(() => '');
      if (n !== 20) fail(`Fahrermodus offline: ${n} statt 20 Stopps`); else ok('Fahrermodus: Tour mit 20 Stopps im Flugmodus geladen (Service Worker)');
      if (!/Offline – Tour vom 14\.11\./.test(off)) fail(`Fahrermodus offline: Hinweis mit Datenstand fehlt („${off}“)`); else ok(`Fahrermodus: Offline-Hinweis mit Datenstand („${off.slice(0, 40)} …“)`);
      // Trefferflächen und Daumen: alle Bedienelemente im Blatt ≥ 44 px; „Erledigt“ des nächsten Stopps in der unteren Bildhälfte
      const small = await page.evaluate(() => [...document.querySelectorAll('#sheet button, #sheet a.btn')].map(b => b.getBoundingClientRect()).filter(r => r.width && (r.width < 44 || r.height < 44)).length);
      if (small) fail(`Fahrermodus: ${small} Bedienelemente unter 44 px`); else ok('Fahrermodus: alle Trefferflächen ≥ 44 px');
      const thumb = await page.locator('#drv-next button[data-act="done"]').boundingBox();
      if (!thumb || thumb.y < 844 / 2) fail(`Fahrermodus: „Erledigt“ des nächsten Stopps nicht in der unteren Bildhälfte (${thumb?.y})`); else ok(`Fahrermodus: nächster Stopp mit dem Daumen erreichbar (y = ${Math.round(thumb.y)} px)`);
      // alle 20 abarbeiten: 17 über „Erledigt“ des nächsten Stopps (Kopf), 2 „nicht gefunden“, 1 „defekt“ in der Liste
      await page.evaluate(() => /** @type {any} */ (window).__drv.snapTo('full')); await page.waitForTimeout(900); // Liste: Blatt ganz öffnen
      await page.locator('#stops li.stop').nth(4).locator('[data-act="missing"]').tap();
      await page.locator('#stops li.stop').nth(9).locator('[data-act="missing"]').tap();
      await page.locator('#stops li.stop').nth(14).locator('[data-act="broken"]').tap();
      await page.evaluate(() => /** @type {any} */ (window).__drv.snapTo('peek')); await page.waitForTimeout(900);
      for (let k = 0; k < 17; k++) await page.locator('#drv-next button[data-act="done"]').tap();
      const cnt = await page.locator('#drv-count').innerText(), head = await page.locator('#drv-next').innerText();
      if (cnt !== '20 von 20' || !/Alle Stopps bearbeitet/.test(head)) fail(`Fahrermodus offline: nicht alle Stopps bearbeitet (${cnt}, „${head}“)`); else ok('Fahrermodus: alle 20 Stopps offline abgearbeitet (17 erledigt, 3 mit Rückmeldung)');
      await page.reload({ waitUntil: 'load' });
      const kept = await page.locator('#stops li.stop.done').count(), iss = await page.locator('#stops li.stop.issue').count();
      if (kept !== 17 || iss !== 3) fail(`Fahrermodus: Stand nach Neuladen offline ${kept}/${iss} statt 17/3`); else ok('Fahrermodus: Stand bleibt nach Neuladen im Flugmodus');
    }
    // Blatt öffnen: Karte bleibt, wo sie ist (keine Layout-Verschiebung), Stufen Kopf → halb → voll
    const before = await page.evaluate(() => JSON.stringify(document.getElementById('map').getBoundingClientRect()));
    await page.evaluate(() => { /** @type {any} */ (window).__cls = 0; new PerformanceObserver(l => { for (const e of l.getEntries()) /** @type {any} */ (window).__cls += /** @type {any} */ (e).value; }).observe({ type: 'layout-shift', buffered: false }); });
    const vis = [];
    for (const s of ['half', 'full', 'peek']) { await page.evaluate((x) => /** @type {any} */ (window).__drv.snapTo(x), s); await page.waitForTimeout(reduced ? 50 : 900); vis.push(Math.round(await page.evaluate(() => /** @type {any} */ (window).__drv.visible()))); }
    const after = await page.evaluate(() => JSON.stringify(document.getElementById('map').getBoundingClientRect())), cls = await page.evaluate(() => /** @type {any} */ (window).__cls);
    if (before !== after || cls > 0.001) fail(`Fahrermodus${tag}: Karte springt beim Öffnen des Blatts (CLS ${cls})`); else ok(`Fahrermodus${tag}: nichts springt beim Öffnen des Blatts (CLS 0)`);
    if (!(vis[0] > 300 && vis[1] > vis[0] && vis[2] < vis[0])) fail(`Fahrermodus${tag}: Stufen des Blatts ${vis.join(' / ')} px`); else ok(`Fahrermodus${tag}: drei Stufen (halb ${vis[0]}, voll ${vis[1]}, Kopf ${vis[2]} px)`);
    if (reduced) { const y0 = await page.evaluate(() => { /** @type {any} */ (window).__drv.snapTo('full'); return /** @type {any} */ (window).__drv.visible(); }); if (y0 < 700) fail(`Fahrermodus: reduzierte Bewegung animiert (${y0} px sofort sichtbar)`); else ok('Fahrermodus: reduzierte Bewegung – Stufe ohne Animation'); }
    // Ziehen mit dem Finger: vom Kopf nach oben werfen → volle Stufe
    if (!reduced) {
      await page.evaluate(() => /** @type {any} */ (window).__drv.snapTo('peek')); await page.waitForTimeout(800);
      const g = await page.locator('#grip').boundingBox();
      if (g) { await page.mouse.move(g.x + g.width / 2, g.y + 10); await page.mouse.down(); for (let k = 1; k <= 6; k++) { await page.mouse.move(g.x + g.width / 2, g.y + 10 - k * 40); await page.waitForTimeout(8); } await page.mouse.up(); await page.waitForTimeout(900); }
      const st = await page.evaluate(() => /** @type {any} */ (window).__drv.stage());
      if (st !== 'full') fail(`Fahrermodus: Wurf nach oben endet in „${st}“ statt „full“`); else ok('Fahrermodus: Wurf nach oben rastet an der vollen Stufe ein (Schwung projiziert)');
    }
    if (errs.length) fail(`Fahrermodus${tag}: Skriptfehler ${errs.slice(0, 3).join(' | ')}`);
    await ctx.close();
  }
}
