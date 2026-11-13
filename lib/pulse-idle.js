// Standzeit als Klasse (aus lib/pulse-ops.js ausgelagert, S3.4: Startpaket ohne Disposition-Modul; pulse-ops.js exportiert weiter)
// Veröffentlichte Standzeit (ops/<Land>.json, idle-long.json) nur als Klasse: eine minutengenaue Standzeit zeigt, wann an einer Adresse die
// letzte Fahrt endete. Wert = Untergrenze der Klasse in Minuten: 0 = unter 6 h, 360 = 6–24 h, ab 24 h ganze Tage (1440 = 1–2 Tage, 2880 = 2–3 Tage …).
// Die Schwellen der Disposition (6 h Bonus, 24 h Überschuss) liegen auf Klassengrenzen und wirken unverändert.
export const IDLE_CLASS = { minH: 6, dayH: 24 };
export function idleClassMin(min) {
  if (min == null || !Number.isFinite(+min)) return null;
  const m = Math.max(0, +min), lo = IDLE_CLASS.minH * 60, day = IDLE_CLASS.dayH * 60;
  return m < lo ? 0 : m < day ? lo : Math.floor(m / day) * day;
}
/** Klasse als Text: „unter 6 h“, „6–24 h“, „1–2 Tage“; atLeast (Mindestwert, seit Beginn der Verfolgung unbewegt): „≥ 6 h“, „≥ 2 Tage“ */
export function idleClassText(min, { en = false, atLeast = false } = {}) {
  const c = idleClassMin(min); if (c == null) return '–';
  const lo = IDLE_CLASS.minH * 60, day = IDLE_CLASS.dayH * 60, d = c / day;
  if (c === 0) return en ? `under ${IDLE_CLASS.minH} h` : `unter ${IDLE_CLASS.minH} h`;
  if (c < day) return atLeast ? `≥ ${IDLE_CLASS.minH} h` : `${c / 60}–${IDLE_CLASS.dayH} h`;
  if (atLeast) return en ? `≥ ${d} ${d === 1 ? 'day' : 'days'}` : `≥ ${d} ${d === 1 ? 'Tag' : 'Tage'}`;
  return en ? `${d}–${d + 1} days` : `${d}–${d + 1} Tage`;
}
