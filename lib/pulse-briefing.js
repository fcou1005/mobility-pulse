// @ts-check
// Mobility Pulse — Tagesbriefing am Morgen (18.11.2026, F32): je Gemeinde ein Eintrag mit Prognose des Tages, Akku, ÖPNV, Veranstaltungen und
// Obergrenze; einmal je Ortstag ab BRIEFING.fromHour, als Atom-Feed feeds/<AGS>-briefing.xml und (nur für ausgewählte Gemeinden) per ntfy.
// Reine Funktionen; der Sammler (Phase alarme) liest die Dateien und schreibt Feed und Zustand.

export const BRIEFING = Object.freeze({ fromHour: 6, maxEvents: 3, maxLines: 3, pushDefault: ['08111000'] });
const fmtDe = (/** @type {number} */ n, d = 0) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d }).format(n);
const pct = (/** @type {number} */ x, d = 0) => `${fmtDe(x * 100, d)} %`;

/**
 * Prognose des Ortstags day aus forecast/latest.json (horizon.local, municipalities[AGS] je Horizont-Stunde): { total, peakH, peak, hours }.
 * @param {any} fc @param {string} ags @param {string} day
 */
export function dayForecast(fc, ags, day) {
  const local = fc?.horizon?.local || [], row = fc?.municipalities?.[ags]; if (!row) return null;
  let total = 0, peak = -1, peakH = null, hours = 0;
  local.forEach((/** @type {any[]} */ x, /** @type {number} */ i) => { if (x[0] !== day || !Number.isFinite(row[i])) return; total += row[i]; hours++; if (row[i] > peak) { peak = row[i]; peakH = x[1]; } });
  return hours ? { total: Math.round(total), peakH, peak: Math.round(peak), hours } : null;
}

/**
 * ÖPNV aus oepnv/<AGS>.json: Pünktlichkeit des Vortags (Stunden ohne Lücke), erwartete Verspätung der nächsten 3 Stunden, Linien mit den
 * höchsten erwarteten Anteilen. Rückgabe { yOk, yDay, late3, skip3, lines } oder null.
 * @param {any} doc @param {string} yesterday
 */
export function ptBrief(doc, yesterday) {
  if (!doc) return null;
  const H = doc.hours, i = H?.days?.indexOf(yesterday) ?? -1;
  let yOk = null;
  if (i >= 0) { let n = 0, bad = 0; for (let h = 0; h < 24; h++) { if (H.gap?.[i]?.[h]) continue; n += H.n[i][h] || 0; bad += (H.skip[i][h] || 0) + (H.late[i][h] || 0); } yOk = n ? (n - bad) / n : null; }
  const nx = (doc.prognose?.next || []).slice(0, 3), late3 = nx.length ? nx.reduce((s, x) => s + x[2], 0) / nx.length : null, skip3 = nx.length ? nx.reduce((s, x) => s + x[3], 0) / nx.length : null;
  const lines = (doc.prognose?.lines || []).slice(0, BRIEFING.maxLines).map((/** @type {any[]} */ l) => l[0]);
  return yOk == null && late3 == null ? null : { yOk, yDay: yesterday, late3, skip3, lines };
}

/**
 * Text des Briefings (deutsch, wie die übrigen Feeds). parts: { fc, akku: akku.totals, pt, events: [{ titel, ort, cap, zeit }], cap: { total, limit } }.
 * @param {{ name: string, day: string, fc?: any, akku?: any, pt?: any, events?: any[], cap?: any }} o
 */
export function briefingText({ name, day, fc = null, akku = null, pt = null, events = [], cap = null }) {
  const [y, m, d] = day.split('-'), lines = [];
  if (fc) lines.push(`Prognose: ${fmtDe(fc.total)} Fahrtbeginne${fc.peakH != null ? `, Spitze ${fc.peakH}–${fc.peakH + 1} Uhr (${fmtDe(fc.peak)})` : ''}.`);
  if (akku && Number.isFinite(akku.morning)) lines.push(`Akku: ${Number.isFinite(akku.nowLow) ? `jetzt ${fmtDe(akku.nowLow)} Fahrzeuge unter 20 %, bis 8 Uhr ${fmtDe(akku.morning)} weitere` : `bis 8 Uhr ${fmtDe(akku.morning)} Fahrzeuge zusätzlich unter 20 %`}.`); // morning zählt nur, wer bis zum Ziel neu unter 20 % fällt (lib/pulse-akku.js)
  if (pt) lines.push(`ÖPNV: gestern ${pt.yOk == null ? '–' : pct(pt.yOk)} pünktlich${pt.late3 == null ? '' : `; nächste 3 Stunden erwartet ${pct(pt.late3, 1)} verspätet, ${pct(pt.skip3, 1)} ausgefallen`}${pt.lines?.length ? ` (am stärksten: ${pt.lines.join(', ')})` : ''}.`);
  if (events.length) lines.push(`Veranstaltungen: ${events.slice(0, BRIEFING.maxEvents).map(e => `${e.titel}${e.ort ? ` (${e.ort}${e.cap ? `, ${fmtDe(e.cap)} Plätze` : ''})` : ''}${e.zeit ? ` ${e.zeit}` : ''}`).join('; ')}.`);
  if (cap && cap.limit) lines.push(`Obergrenze: ${fmtDe(cap.total)} von ${fmtDe(cap.limit)} E-Scootern (${pct(cap.total / cap.limit)}).`);
  if (!lines.length) return null;
  return { title: `Briefing ${name}, ${d}.${m}.${y}`, text: lines.join('\n') };
}

/** Ist ein Briefing fällig? Einmal je Ortstag ab fromHour. @param {string|null} lastDay @param {string} day @param {number} hour */
export const briefingDue = (lastDay, day, hour, o = BRIEFING) => hour >= o.fromHour && lastDay !== day;
