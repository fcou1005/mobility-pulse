// Mobility Pulse — Bereiche des Wörterbuchs (S3.5): welcher Schlüsselbereich (Präfix vor dem ersten Punkt) mit welcher Ansicht geladen wird.
// Alles, was hier nicht steht, ist „core“ und kommt mit dem Start. scripts/build-web.mjs schneidet danach docs/i18n/<Sprache>/<Bereich>.json
// und legt zusätzlich jeden Schlüssel nach core, den ein Startmodul (app.js, ui-shared.js, i18n.js, index.html …) wörtlich benutzt.
export const AREAS = Object.freeze({
  report: ['rep', 'zv'],
  forecast: ['fv'],
  ops: ['ops', 'col'],
  spots: ['spots'],
  flows: ['flows'],
  compare: ['cmp'],
  coverage: ['cov'],
  status: ['st'],
  stadt: ['sd', 'aufl', 'aus'],
  zonen: ['zw'],
});
const BY_PREFIX = Object.fromEntries(Object.entries(AREAS).flatMap(([a, ps]) => ps.map(p => [p, a])));
/** Bereich eines Schlüssels ohne die Startliste (Build); core für alles Übrige */
export const areaOfKey = (key) => BY_PREFIX[String(key).split('.')[0]] || 'core';
