// Mobility Pulse — Laufzeit-Budget und Statusdatei des Sammlers (S3.2). Reine Funktionen, ohne Abhängigkeiten; nutzt der Sammler
// (status.json, Laufzeit-Alarm) und die Ansicht #status (web/status.js).
//
// status.json v2: { schemaVersion: '2.0', at, generatedAt, complete, runMs, phases: [[Name, ms], …], budget, level, trend, counts, byStatus }.
// level: ok bis BUDGET.warnS, warn bis BUDGET.failS, fail darüber. trend: Median der letzten BUDGET.recentRuns Läufe gegen den Median der
// Läufe der letzten BUDGET.baseDays Tage davor; alarm, wenn das Verhältnis über BUDGET.factor liegt (dann legt der Workflow ein Issue
// „laufzeit“ an). Gemessen 13.11.2026 (runs.json, 7 Tage): Median 135 s, p95 348 s, Maximum 456 s.

export const STATUS_VERSION = '2.0';
export const BUDGET = Object.freeze({ warnS: 360, failS: 600, recentRuns: 6, baseDays: 7, factor: 1.5, minBase: 12, staleMin: 45 });

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Stufe einer Laufzeit (ms) */
export const levelOf = (runMs, b = BUDGET) => (!Number.isFinite(runMs) ? null : runMs > b.failS * 1000 ? 'fail' : runMs > b.warnS * 1000 ? 'warn' : 'ok');

/**
 * Trend aus runs.json (Zeilen [at, dauer_ms, …], älteste zuerst; der laufende Lauf ist die letzte Zeile).
 * Rückgabe { recentS, baseS, ratio, alarm, n } – alarm nur mit mindestens minBase Vergleichsläufen.
 */
export function runtimeTrend(rows, { now = null, b = BUDGET } = {}) {
  const runs = (rows || []).filter(r => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]));
  if (!runs.length) return { recentS: null, baseS: null, ratio: null, alarm: false, n: 0 };
  const t = now ?? runs[runs.length - 1][0];
  const recent = runs.slice(-b.recentRuns), base = runs.slice(0, -b.recentRuns).filter(r => t - r[0] <= b.baseDays * 86400e3);
  const rm = median(recent.map(r => r[1])), bm = median(base.map(r => r[1]));
  const ratio = rm != null && bm ? rm / bm : null;
  return { recentS: rm != null ? +(rm / 1000).toFixed(1) : null, baseS: bm != null ? +(bm / 1000).toFixed(1) : null, ratio: ratio != null ? +ratio.toFixed(2) : null,
    alarm: ratio != null && base.length >= b.minBase && recent.length >= b.recentRuns && ratio > b.factor, n: base.length };
}

/** Phasen messen: phase('name') schließt die laufende Phase ab und beginnt die nächste; list() = [[Name, ms], …] */
export function phaseClock(start = Date.now(), clock = () => Date.now()) {
  const list = []; let name = 'start', at = start;
  return {
    phase(n) { const t = clock(); list.push([name, t - at]); name = n; at = t; },
    list(close = false) { const out = list.slice(); if (close) out.push([name, clock() - at]); return out.filter(([, ms]) => ms > 0); },
  };
}

/** status.json v2 */
export function statusDoc({ at, generatedAt, runMs, phases = [], counts = null, byStatus = null, runs = null, complete = true, b = BUDGET }) {
  const merged = []; for (const [n, ms] of phases) { const x = merged.find(p => p[0] === n); if (x) x[1] += ms; else merged.push([n, ms]); }
  return { schemaVersion: STATUS_VERSION, at, generatedAt, complete, runMs, level: levelOf(runMs, b), phases: merged,
    budget: { warnS: b.warnS, failS: b.failS, recentRuns: b.recentRuns, baseDays: b.baseDays, factor: b.factor, staleMin: b.staleMin },
    trend: runs ? runtimeTrend(runs, { now: at, b }) : null, counts, byStatus };
}

/** Zeile für den Workflow (RUNTIME_FILE): „alarm“ oder „ok“, dann der Grund */
export function runtimeLine(doc, b = BUDGET) {
  const tr = doc?.trend, s = Number.isFinite(doc?.runMs) ? (doc.runMs / 1000).toFixed(0) : '?';
  const slow = (doc?.phases || []).slice().sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n, ms]) => `${n} ${(ms / 1000).toFixed(0)} s`).join(', ');
  if (tr?.alarm) return `alarm\nLaufzeit: Median der letzten ${b.recentRuns} Läufe ${tr.recentS} s, ${tr.ratio}× des ${b.baseDays}-Tage-Medians (${tr.baseS} s). Dieser Lauf ${s} s; längste Phasen: ${slow}.`;
  return `ok\nLaufzeit ${s} s (${doc?.level ?? '?'})${tr?.ratio != null ? `, ${tr.ratio}× des ${b.baseDays}-Tage-Medians` : ''}.`;
}
