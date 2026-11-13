// S3.10 Handbuch: README höchstens 10 KB, alle relativen Verweise in README.md und handbuch/*.md zeigen auf vorhandene Dateien und
// Überschriften, handbuch/datenformate.md passt zu schemas/ (scripts/schemas-doc.mjs). markdownlint läuft in der CI (npx markdownlint-cli2).
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { render } from '../scripts/schemas-doc.mjs';

let ok = 0, bad = 0;
const check = (c, m) => { if (c) { ok++; console.log(`ok: ${m}`); } else { bad++; console.log(`FEHLER ${m}`); } };
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const files = ['README.md', ...(await readdir(path.join(ROOT, 'handbuch'))).filter(f => f.endsWith('.md')).map(f => `handbuch/${f}`)];

const readme = await stat(path.join(ROOT, 'README.md'));
check(readme.size <= 10 * 1024, `README.md ${(readme.size / 1024).toFixed(1)} KB (höchstens 10 KB)`);

// GitHub-Anker: klein, Leerzeichen → '-', Satzzeichen weg (Buchstaben mit Umlaut bleiben), Doppelte mit -1, -2 …
function anchors(md) {
  const out = new Set(), seen = {};
  for (const line of md.replace(/```[\s\S]*?```/g, '').split('\n')) {
    const m = /^#{1,6} (.+)$/.exec(line); if (!m) continue;
    let a = m[1].trim().toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    if (seen[a] != null) a = `${a}-${++seen[a]}`; else seen[a] = 0;
    out.add(a);
  }
  return out;
}
const texts = Object.fromEntries(await Promise.all(files.map(async f => [f, await readFile(path.join(ROOT, f), 'utf8')])));
let links = 0;
for (const f of files) {
  const md = texts[f].replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1]; if (/^(https?:|mailto:)/.test(href)) continue;
    links++;
    const [p, frag] = href.split('#'), target = p ? path.normalize(path.join(path.dirname(f), p)) : f;
    const exists = await stat(path.join(ROOT, target)).then(() => true, () => false);
    check(exists, `${f}: Verweis ${href} → ${target} vorhanden`);
    if (exists && frag && target.endsWith('.md')) {
      const t = texts[target] ?? await readFile(path.join(ROOT, target), 'utf8');
      check(anchors(t).has(frag), `${f}: Anker #${frag} in ${target}`);
    }
  }
}
check(links >= 20, `${links} relative Verweise geprüft`);
check(texts['handbuch/datenformate.md'] === await render(), 'handbuch/datenformate.md passt zu schemas/ (sonst node scripts/schemas-doc.mjs)');
const all = files.map(f => texts[f]).join('\n');
for (const f of ['architektur.md', 'datenformate.md', 'betrieb.md', 'entscheidungen.md']) check(files.includes(`handbuch/${f}`), `handbuch/${f} vorhanden`);
check(['raw statt Pages', 'Force-Push', 'Sammler-Kette', 'esbuild', 'Aufteilung der Daten'].every(k => texts['handbuch/entscheidungen.md'].includes(k)), 'Entscheidungen: raw, Force-Push, Sammler-Kette, esbuild, Aufteilung');
check(!/\]\(docs\//.test(all), 'keine Verweise ins Pages-Verzeichnis docs/ als Handbuch');
console.log(`${bad ? '✗' : '✓'} handbuch: ${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad ? 1 : 0);
