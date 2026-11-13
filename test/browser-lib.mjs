// Gemeinsame Bausteine der Browser-Tests (test/browser.mjs, test/a11y.mjs): Seite mit festem Datenstand öffnen,
// Uhr auf den Stand des Fixtures, alles außer 127.0.0.1 abbrechen, Skriptfehler je Ansicht sammeln.

/**
 * @param {import('playwright').Browser} browser
 * @param {{ port: number, fx: { at: number }, scope: string, viewport: { width: number, height: number }, lang?: string|null,
 *   blocked?: Map<string, number>, bypassCSP?: boolean, hash?: string, onConsole?: (text: string, cur: string) => void }} o
 */
export async function openFixturePage(browser, { port, fx, scope, viewport, lang = null, blocked = new Map(), bypassCSP = false, hash = 'live', onConsole = null }) {
  const context = await browser.newContext({ viewport, locale: 'de-DE', timezoneId: 'Europe/Berlin', bypassCSP });
  const page = await context.newPage();
  await page.clock.install({ time: fx.at + 2 * 60e3 });
  await page.route('**/*', (route) => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); blocked.set(u.hostname, (blocked.get(u.hostname) || 0) + 1); return route.abort(); });
  const errs = []; let cur = 'start';
  page.on('pageerror', e => errs.push(`${cur}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(`${cur}: console ${m.text().slice(0, 200)}`); if (onConsole) onConsole(m.text(), cur); });
  await page.goto(`http://127.0.0.1:${port}/?data=/d/&scope=${scope}${lang ? `&lang=${lang}` : ''}#${hash}`, { waitUntil: 'load', timeout: 60000 });
  return { page, context, errs, setCur: (v) => { cur = v; }, close: () => context.close() };
}

/** Text der Ansicht, sobald er sich 600 ms nicht mehr ändert (höchstens maxMs) */
export async function settledText(page, v, maxMs = 12000) {
  let last = '', same = 0; const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const txt = await page.evaluate((x) => (document.getElementById(`view-${x}`)?.innerText || '').replace(/\s+/g, ' ').trim(), v);
    if (txt === last && txt.length > 200) { if (++same >= 3) return txt; } else same = 0;
    last = txt; await page.waitForTimeout(200);
  }
  return last;
}

/** Zeitangaben maskieren (Prüfwerte, Screenshots) */
export const mask = (s) => s.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, 'hh:mm').replace(/vor \d+ (Sek|Min)\.?/g, 'vor x').replace(/\d+[,.]\d+ s\b/g, 'x s');

/** Zeitangaben im sichtbaren Text der Seite ersetzen, bevor ein Screenshot entsteht (gleiche Regeln wie mask) */
export async function maskTimesInPage(page) {
  await page.evaluate(() => {
    const re = [[/\b\d{1,2}:\d{2}(:\d{2})?\b/g, 'hh:mm'], [/vor \d+ (Sek|Min)\.?/g, 'vor x'], [/\b\d+[,.]\d+ s\b/g, 'x s']];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { let t = n.nodeValue || ''; for (const [r, s] of re) t = t.replace(r, s); if (t !== n.nodeValue) n.nodeValue = t; }
  });
}
