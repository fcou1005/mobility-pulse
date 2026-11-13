#!/usr/bin/env node
// Letzte Prüfung vor dem Force-Push des Datenstands – Sprint 0, S0.1.
// Läuft im Veröffentlichen-Schritt im Ordner out/ nach „git fetch origin data“ und „git add -A“ und vergleicht den neuen Stand (Index)
// mit dem alten (FETCH_HEAD bzw. --old <Ref>). Bricht ab (Exit 1, nichts wird gepusht), wenn
//   - der Branch auf dem Server existiert, der alte Stand aber nicht abgerufen werden konnte,
//   - der neue Stand weniger als 90 % der Dateien des alten hat,
//   - ein Langzeitarchiv (archive/, train/, train-cells/) Dateien verliert oder latest.json fehlt.
// Gewollter Umbau: Repository-Variable DATA_GUARD_OFF=1 setzen (Workflow reicht sie durch), danach wieder löschen.
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OLD = opt('--old', 'FETCH_HEAD'), REMOTE = opt('--remote', 'origin'), BRANCH = opt('--branch', process.env.DATA_BRANCH || 'data');
const MIN_SHARE = Number(process.env.DATA_GUARD_MIN_SHARE || 0.9);
const KEEP = (process.env.DATA_GUARD_KEEP || 'archive/,train/,train-cells/').split(',').map(s => s.trim()).filter(Boolean);
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
const fail = (msg) => { console.error(`::error::Datenstand-Schutz: ${msg} – nichts veröffentlicht`); process.exit(1); };

if (process.env.DATA_GUARD_OFF === '1') { console.log('Datenstand-Schutz abgeschaltet (DATA_GUARD_OFF=1)'); process.exit(0); }

let exists;
try { git('ls-remote', '--exit-code', '--heads', REMOTE, BRANCH); exists = true; } catch (e) {
  if (e.status === 2) exists = false;
  else fail(`Server nicht erreichbar (git ls-remote, Status ${e.status ?? '?'})`);
}
if (!exists) { console.log(`Branch ${BRANCH} gibt es noch nicht: erster Datenstand, nichts zu vergleichen`); process.exit(0); }

let oldRef;
try { oldRef = git('rev-parse', '-q', '--verify', `${OLD}^{commit}`).trim(); } catch { fail(`alter Stand (${OLD}) nicht abgerufen, obwohl ${BRANCH} auf dem Server existiert`); }
const oldFiles = git('ls-tree', '-r', '--name-only', oldRef).split('\n').filter(Boolean);
const newFiles = new Set(git('ls-files').split('\n').filter(Boolean));
const count = (list, p) => { let n = 0; for (const f of list) if (f.startsWith(p)) n++; return n; };

const problems = [];
const share = oldFiles.length ? newFiles.size / oldFiles.length : 1;
if (oldFiles.length && share < MIN_SHARE) problems.push(`nur ${newFiles.size} von bisher ${oldFiles.length} Dateien (${Math.round(share * 100)} %, Grenze ${Math.round(MIN_SHARE * 100)} %)`);
const kept = KEEP.map(p => ({ p, old: count(oldFiles, p), now: count(newFiles, p) }));
for (const k of kept) if (k.now < k.old) problems.push(`${k.p} hätte ${k.old - k.now} Dateien weniger (${k.old} → ${k.now})`);
if (oldFiles.includes('latest.json') && !newFiles.has('latest.json')) problems.push('latest.json fehlt');

console.log(`Datenstand-Schutz: bisher ${oldFiles.length} Dateien, neu ${newFiles.size} (${Math.round(share * 100)} %); ${kept.map(k => `${k.p} ${k.old} → ${k.now}`).join(', ')}`);
if (problems.length) fail(problems.join('; '));
console.log('Datenstand-Schutz: ok');
