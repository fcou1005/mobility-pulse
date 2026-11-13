// Gemeinsame Bausteine der Browser-Tests (test/browser.mjs, test/a11y.mjs): Seite mit festem Datenstand öffnen,
// Uhr auf den Stand des Fixtures, alles außer 127.0.0.1 abbrechen, Skriptfehler je Ansicht sammeln.

/**
 * @param {import('playwright').Browser} browser
 * @param {{ port: number, fx: { at: number }, scope: string, viewport: { width: number, height: number }, lang?: string|null,
 *   blocked?: Map<string, number>, bypassCSP?: boolean, hash?: string, onConsole?: (text: string, cur: string) => void,
 *   patch?: Record<string, (doc: any) => any>, missing?: string[], firstVisit?: boolean, query?: string }} o  firstVisit: Erstbesuch-Karte zeigen (sonst als gesehen markiert); query: weitere URL-Parameter  patch: Fixture-Datei (Pfad unter /d/) → Änderung am JSON vor der Auslieferung; missing: Dateien mit 404
 */
export async function openFixturePage(browser, { port, fx, scope, viewport, lang = null, blocked = new Map(), bypassCSP = false, hash = 'live', onConsole = null, patch = null, missing = [], firstVisit = false, query = '' }) {
  const context = await browser.newContext({ viewport, locale: 'de-DE', timezoneId: 'Europe/Berlin', bypassCSP });
  const page = await context.newPage();
  if (!firstVisit) await context.addInitScript(() => { try { localStorage.setItem('mp-first-done', '1'); } catch { /* ohne Speicher */ } }); // S4.8: Erstbesuch-Karte nur im eigenen Test
  await page.clock.install({ time: fx.at + 2 * 60e3 });
  await page.route('**/*', (route) => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); blocked.set(u.hostname, (blocked.get(u.hostname) || 0) + 1); return route.abort(); });
  for (const file of missing) await page.route((u) => u.pathname === `/d/${file}`, (route) => route.fulfill({ status: 404, body: '' })); // Datei fehlt (älterer Datenstand)
  for (const [file, fn] of Object.entries(patch || {})) await page.route((u) => u.pathname === `/d/${file}`, async (route) => { const r = await route.fetch(); route.fulfill({ response: r, json: fn(await r.json()) }); });
  const errs = []; let cur = 'start';
  page.on('pageerror', e => errs.push(`${cur}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(`${cur}: console ${m.text().slice(0, 200)}`); if (onConsole) onConsole(m.text(), cur); });
  await page.goto(`http://127.0.0.1:${port}/?data=/d/&scope=${scope}${lang ? `&lang=${lang}` : ''}${query}${hash ? `#${hash}` : ''}`, { waitUntil: 'load', timeout: 60000 });
  return { page, context, errs, setCur: (v) => { cur = v; }, close: () => context.close() };
}

// Zwischenstände, die noch aufgelöst werden (Adresssuche der Spots: Nominatim ist im Test gesperrt, danach greift der Name aus der Umgebung)
const PENDING = /Adresse wird gesucht|Looking up address/;
/** Text der Ansicht, sobald er sich 1 s nicht mehr ändert und keine Zwischenstände mehr zeigt (höchstens maxMs) */
export async function settledText(page, v, maxMs = 12000, pendingMaxMs = 45000) {
  let last = '', same = 0; const t0 = Date.now();
  // Adresssuche läuft höchstens 1 Anfrage/s (web/ops.js pumpGeo): solange sie offen ist, bis pendingMaxMs warten
  while (Date.now() - t0 < maxMs || (PENDING.test(last) && Date.now() - t0 < pendingMaxMs)) {
    const txt = await page.evaluate((x) => (document.getElementById(`view-${x}`)?.innerText || '').replace(/\s+/g, ' ').trim(), v);
    if (txt === last && txt.length > 200 && !PENDING.test(txt)) { if (++same >= 5) return txt; } else same = 0; // 1 s ruhig: die Sprungleiste „Auf dieser Seite“ kommt 350 ms nach dem letzten Zeichnen (web/app.js scheduleToc)
    last = txt; await page.waitForTimeout(200);
  }
  return last;
}

/** Zeitangaben maskieren (Prüfwerte, Screenshots) */
export const mask = (s) => s.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, 'hh:mm').replace(/vor \d+ (Sek|Min)\.?/g, 'vor x').replace(/\d+[,.]\d+ s\b/g, 'x s');

/** Zeitangaben im sichtbaren Text der Seite ersetzen, bevor ein Screenshot entsteht (gleiche Regeln wie mask) */
export async function maskTimesInPage(page) {
  await page.evaluate(() => {
    /** @type {Array<[RegExp, string]>} */
    const re = [[/\b\d{1,2}:\d{2}(:\d{2})?\b/g, 'hh:mm'], [/vor \d+ (Sek|Min)\.?/g, 'vor x'], [/\b\d+[,.]\d+ s\b/g, 'x s']];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { let t = n.nodeValue || ''; for (const [r, s] of re) t = t.replace(r, s); if (t !== n.nodeValue) n.nodeValue = t; }
  });
}
