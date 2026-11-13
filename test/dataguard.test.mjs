// Datenstand-Schutz (Sprint 0, S0.1): scripts/data-fetch.sh und scripts/data-guard.mjs gegen ein lokales Repo als „origin“.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const GUARD = path.join(ROOT, 'scripts', 'data-guard.mjs'), FETCH = path.join(ROOT, 'scripts', 'data-fetch.sh');
const tmp = mkdtempSync(path.join(tmpdir(), 'mp-guard-'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const guard = (cwd, env = {}) => spawnSync('node', [GUARD], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const fetch = (cwd, out, env = {}) => spawnSync('bash', [FETCH, out], { cwd, encoding: 'utf8', env: { ...process.env, DATA_FETCH_WAIT: '0', ...env } });
const put = (dir, files) => { for (const f of files) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), f); } };

const origin = path.join(tmp, 'origin.git'); git(tmp, 'init', '-q', '--bare', origin);
// Arbeitskopie wie im Workflow: Checkout mit origin
const work = path.join(tmp, 'work'); mkdirSync(work); git(work, 'init', '-q'); git(work, 'remote', 'add', 'origin', origin);

// 1) Branch fehlt: Abruf leer weiter, Schutz lässt den ersten Stand durch
let r = fetch(work, 'out1');
assert(r.status === 0 && /Branch data gibt es nicht/.test(r.stdout) && readdirSync(path.join(work, 'out1')).length === 0, 'data-fetch: fehlender Branch → leerer Stand, Lauf geht weiter');
const first = path.join(tmp, 'first'); mkdirSync(first); git(first, 'init', '-q'); git(first, 'remote', 'add', 'origin', origin);
const OLD = ['latest.json', 'archive/2026-10.json', 'archive/2026-11.json', 'train/2026/2026-11-01.json.gz', 'train/2026/2026-11-02.json.gz', 'train-cells/2026-W44.json.gz', ...Array.from({ length: 14 }, (_, i) => `events/2026-11-${String(i + 1).padStart(2, '0')}.json`)];
put(first, OLD); git(first, 'checkout', '-q', '--orphan', 'data'); git(first, 'add', '-A');
r = guard(first); assert(r.status === 0 && /erster Datenstand/.test(r.stdout), 'data-guard: erster Stand ohne Vergleich erlaubt');
git(first, 'commit', '-qm', 'eins'); git(first, 'push', '-q', 'origin', 'data:data');

// 2) Abruf mit Branch: Dateien kommen an
r = fetch(work, 'out2');
assert(r.status === 0 && readdirSync(path.join(work, 'out2')).includes('archive') && /20 Dateien/.test(r.stdout), 'data-fetch: vorhandener Branch → Stand übernommen');
// 3) Abruf scheitert (origin weg): Abbruch statt leerem Stand
const broken = path.join(tmp, 'broken'); mkdirSync(broken); git(broken, 'init', '-q'); git(broken, 'remote', 'add', 'origin', path.join(tmp, 'gibt-es-nicht.git'));
r = fetch(broken, 'out3'); assert(r.status === 1 && /nicht abrufbar/.test(r.stdout + r.stderr), 'data-fetch: Server nicht erreichbar → Abbruch nach 3 Versuchen');

const next = (name, files, doFetch = true) => {
  const d = path.join(tmp, name); mkdirSync(d); put(d, files); git(d, 'init', '-q'); git(d, 'remote', 'add', 'origin', origin);
  if (doFetch) git(d, 'fetch', '-q', '--depth', '1', 'origin', 'data');
  git(d, 'checkout', '-q', '--orphan', 'data'); git(d, 'add', '-A'); return d;
};
// 4) normaler Lauf: ein Event-Tag fällt raus, einer kommt dazu
r = guard(next('normal', [...OLD.filter(f => f !== 'events/2026-11-01.json'), 'events/2026-11-15.json']));
assert(r.status === 0 && /Datenstand-Schutz: ok/.test(r.stdout), 'data-guard: normaler Lauf wird veröffentlicht');
// 5) leerer Stand nach gescheitertem Abruf: nur latest.json
r = guard(next('leer', ['latest.json'])); assert(r.status === 1 && /nur 1 von bisher 20/.test(r.stderr), 'data-guard: fast leerer Stand → Abbruch');
// 6) Archiv verliert eine Datei, Gesamtzahl über 90 %
r = guard(next('archiv', OLD.filter(f => f !== 'archive/2026-10.json'))); assert(r.status === 1 && /archive\/ hätte 1 Dateien weniger/.test(r.stderr), 'data-guard: Langzeitarchiv darf nicht schrumpfen');
// 7) Branch existiert, alter Stand wurde nicht abgerufen
r = guard(next('ohne-fetch', OLD, false)); assert(r.status === 1 && /nicht abgerufen/.test(r.stderr), 'data-guard: alter Stand fehlt → Abbruch');
// 8) gewollter Umbau
r = guard(path.join(tmp, 'leer'), { DATA_GUARD_OFF: '1' }); assert(r.status === 0 && /abgeschaltet/.test(r.stdout), 'data-guard: DATA_GUARD_OFF=1 lässt einen gewollten Umbau durch');
// 9) Wochensicherung (S0.2): packen, auspacken, gleiche Dateien
{
  const src = path.join(tmp, 'stand'); put(src, ['archive/2026-11.json', 'train/2026/2026-11-01.json.gz', 'runs.json', 'events/2026-11-01.json']);
  const BK = path.join(ROOT, 'scripts', 'data-backup.sh'), tgz = path.join(tmp, 'b.tar.gz'), back = path.join(tmp, 'zurueck');
  r = spawnSync('bash', [BK, 'pack', src, tgz], { encoding: 'utf8' });
  const r2 = spawnSync('bash', [BK, 'restore', tgz, back], { encoding: 'utf8' });
  assert(r.status === 0 && /3 Dateien/.test(r.stdout) && r2.status === 0 && /3 Dateien/.test(r2.stdout) && readdirSync(back).sort().join() === 'archive,runs.json,train', 'data-backup: Langzeitteile gepackt und wiederhergestellt, events/ nicht');
  r = spawnSync('bash', [BK, 'pack', path.join(tmp, 'nichts'), tgz], { encoding: 'utf8' }); assert(r.status === 1, 'data-backup: ohne archive/ keine (leere) Sicherung');
}
rmSync(tmp, { recursive: true, force: true });
