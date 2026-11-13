// Laufzeit-Budget und status.json v2 (lib/pulse-status.js, S3.2)
import * as SS from '../lib/pulse-status.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };

assert(SS.levelOf(135e3) === 'ok' && SS.levelOf(361e3) === 'warn' && SS.levelOf(601e3) === 'fail' && SS.levelOf(NaN) === null, 'Stufe: bis 360 s ok, bis 600 s Warnung, darüber Fehler');
// 7 Tage Läufe alle 20 Min. mit ~135 s, dann 6 langsame Läufe (künstlich verlangsamt) → Alarm
const t0 = Date.parse('2026-11-06T00:00:00Z'), runs = [];
for (let i = 0; i < 7 * 72; i++) runs.push([t0 + i * 20 * 60e3, 120e3 + (i % 7) * 5e3]);
const normal = SS.runtimeTrend(runs);
assert(!normal.alarm && normal.ratio > 0.8 && normal.ratio < 1.2 && normal.baseS > 120 && normal.baseS < 160, `normaler Betrieb: kein Alarm (Verhältnis ${normal.ratio}, Basis ${normal.baseS} s)`);
const slow = runs.concat(Array.from({ length: 6 }, (_, k) => [runs.at(-1)[0] + (k + 1) * 20 * 60e3, 260e3]));
const tr = SS.runtimeTrend(slow);
assert(tr.alarm && tr.ratio > 1.5 && tr.recentS === 260, `künstlich verlangsamter Lauf (6 × 260 s): Alarm, ${tr.ratio}× des 7-Tage-Medians`);
const one = runs.concat([[runs.at(-1)[0] + 20 * 60e3, 500e3]]);
assert(!SS.runtimeTrend(one).alarm, 'ein einzelner langsamer Lauf löst keinen Alarm aus (Median der letzten 6)');
assert(!SS.runtimeTrend(slow.slice(-10)).alarm, 'ohne genug Vergleichsläufe (unter 12) kein Alarm');
let t = 1000; const pc = SS.phaseClock(1000, () => t);
t = 1500; pc.phase('abruf'); t = 4500; pc.phase('verfolgung'); t = 4600; pc.phase('abruf'); t = 5000;
const doc = SS.statusDoc({ at: 1000, generatedAt: 'x', runMs: 400e3, phases: pc.list(true), runs: slow });
assert(doc.schemaVersion === '2.0' && doc.level === 'warn' && JSON.stringify(doc.phases) === JSON.stringify([['start', 500], ['abruf', 3400], ['verfolgung', 100]]) && doc.trend.alarm,
  `status.json v2: Phasen zusammengefasst (${JSON.stringify(doc.phases)}), Stufe ${doc.level}, Trend mit Alarm`);
const line = SS.runtimeLine(doc).split('\n');
assert(line[0] === 'alarm' && /6 Läufe 260 s/.test(line[1]) && /abruf 3 s/.test(line[1]), `Zeile für den Workflow: ${line[1]}`);
assert(SS.runtimeLine(SS.statusDoc({ at: 1, runMs: 100e3, phases: [], runs })).startsWith('ok\nLaufzeit 100 s (ok)'), 'Zeile ohne Alarm: ok und Laufzeit');
