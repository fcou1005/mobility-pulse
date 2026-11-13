// Datenschutzerklärung (Sprint 0, S0.5; Impressum S0.4 zurückgestellt): Seite vorhanden und verlinkt; jeder Host, den der Browser-Code von sich aus anfragt,
// steht in der Datenschutzerklärung. Neue Fremd-Hosts brechen diesen Test, bis sie dort eingetragen sind.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const read = (f) => readFileSync(f, 'utf8');

const dsg = read('web/datenschutz.html'), index = read('web/index.html'), app = readdirSync(new URL('../web/', import.meta.url)).filter(f => /^app(-[a-z]+)?\.js$/.test(f)).map(f => read(`web/${f}`)).join('\n'), // S3.9: app.js in app-*.js geschnitten
   i18n = readdirSync(new URL('../web/', import.meta.url)).filter(f => /^i18n-(dict|de-\d+|en-\d+)\.js$/.test(f)).map(f => read(`web/${f}`)).join('\n'); // Wörterbuch in Teilen (web/i18n-de-*.js, web/i18n-en-*.js)
assert(!/<script/i.test(dsg) && !dsg.includes('impressum.html'), 'Datenschutzerklärung kommt ohne JavaScript aus und verweist nicht auf ein Impressum, das es noch nicht gibt');
assert(/href="datenschutz\.html"/.test(index), 'Seitenleiste verlinkt die Datenschutzerklärung (auch ohne JavaScript)');
assert(app.includes("t('app.legalLinks')") && (i18n.match(/"app\.legalLinks": "/g) || []).length === 2 && (i18n.match(/"html\.legalLinks": "/g) || []).length === 2, 'Fußzeile jeder Ansicht verlinkt die Datenschutzerklärung, Deutsch und Englisch');
const build = read('scripts/build-web.mjs');
assert(build.includes("'datenschutz.html'"), 'Build kopiert die Seite nach docs/');
for (const k of ['Art. 15', 'Art. 21', 'Art. 77', 'Art. 6 Abs. 1 lit. f', '§ 25 Abs. 2 Nr. 2 TDDDG', 'Data Privacy Framework', 'id="en"']) assert(dsg.includes(k), `Datenschutzerklärung enthält ${k}`);

// Hosts aus dem Browser-Code: alle https-Adressen in web/*.js und web/index.html, außer Links (href) und reinen Link-Listen
const LINK_ONLY = new Map([
  ['github.com', 'Link zum Repository und zu Dateien'],
  ['mobidata-bw.de', 'Link in der Verzeichnisliste (Quellen)'],
  ['www.mobilitaetsdaten.nrw', 'Link in der Verzeichnisliste (Quellen)'],
  ['gbfs.api.ridedott.com', 'Link in der Verzeichnisliste; der Live-Abruf ist als „Feeds der Sharing-Anbieter“ erfasst'],
]);
const files = [...readdirSync('web').filter(f => f.endsWith('.js')).map(f => `web/${f}`), 'web/index.html'];
const hosts = new Map();
for (const f of files) {
  const s = read(f), re = /(href=\\?["'])?https?:\/\/(\*\.)?([a-z0-9.-]+\.[a-z]{2,})/gi; let m;
  while ((m = re.exec(s))) { if (m[1]) continue; const h = m[3].toLowerCase(); if (!hosts.has(h)) hosts.set(h, new Set()); hosts.get(h).add(f); }
}
const missing = [...hosts.keys()].filter(h => !LINK_ONLY.has(h) && !dsg.includes(h));
assert(hosts.size >= 8, `Hosts im Browser-Code gefunden (${hosts.size})`);
assert(!missing.length, `jeder angefragte Host steht in der Datenschutzerklärung${missing.length ? `, es fehlen: ${missing.map(h => `${h} (${[...hosts.get(h)].join(', ')})`).join('; ')}` : ''}`);
assert(!/open-meteo\.com/i.test(files.map(read).join('\n')), 'kein Abruf mehr bei Open-Meteo (S0.6)');
assert(existsSync('web/datenschutz.html'), 'Seite liegt in web/');
