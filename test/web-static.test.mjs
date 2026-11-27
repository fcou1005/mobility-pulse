// Statische Prüfung der Seitenmodule: kein Code hinter einem Zeilenkommentar (27.11.2026: in web/ops-plan.js stand seit 14.11. ein Kommentar
// vor `.bindPopup(…).addTo(…)` – die Touren der Disposition wurden nie auf die Karte gelegt)
import { readFile, readdir } from 'node:fs/promises';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };
const dir = new URL('../web/', import.meta.url), files = (await readdir(dir)).filter(f => f.endsWith('.js') && !f.startsWith('i18n-'));
const hits = [];
for (const f of files) (await readFile(new URL(f, dir), 'utf8')).split('\n').forEach((line, i) => {
  // Zeilenkommentar außerhalb von Zeichenketten: danach darf kein verketteter Aufruf mehr stehen
  let q = null, cut = -1; for (let k = 0; k < line.length - 1; k++) { const c = line[k]; if (q) { if (c === '\\') k++; else if (c === q) q = null; continue; } if (c === '"' || c === "'" || c === '`') q = c; else if (c === '/' && line[k + 1] === '/' && line[k - 1] !== ':') { cut = k; break; } }
  if (cut >= 0 && /\)\.(addTo|bindPopup|bindTooltip)\(/.test(line.slice(cut))) hits.push(`${f}:${i + 1}`);
});
assert(hits.length === 0, `kein .addTo/.bindPopup hinter einem Zeilenkommentar (${hits.join(', ') || 'keine Fundstelle'}; ${files.length} Dateien)`);
console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
