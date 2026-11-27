// @ts-check
// Fortschritt der Einflüsse bis „greift“ (27.11.2026, Felix): je Einfluss, wie viel der Schwelle schon erreicht ist (GATES.ctxMinRows
// Gemeinde-Stunden an GATES.ctxMinDays Tagen, Fenster + Gedächtnis, wie ctxActive) und ab wann er voraussichtlich greift – geschätzt aus dem
// bisherigen Tempo seit Erfassungsbeginn. Wetter: Wetter-Gate (Temperaturspanne, Regen- und Trockentage), ohne Datum (hängt vom Wetter ab).
import { GATES } from './pulse-forecast-model.js';

// Erfassungsbeginn je Merkmal (Ortstag), sonst gilt das Fenster: Autobahn-Sperrung/-Stau getrennt seit 26.11.2026; ptOut und ptRisk zählen seit
// 27.11.2026 nur Haltestellen im Geschäftsgebiet, ptRisk braucht dafür erst 3 Tage Gebietszählung (ÖPNV-Prognose aus den Vortagen)
export const FEATURE_SINCE = Object.freeze(/** @type {Record<string, string>} */ ({ roadC: '2026-11-26', roadJ: '2026-11-26', ptOut: '2026-11-27', ptRisk: '2026-11-30', semfrei: '2026-12-19' })); // semfrei: erster vorlesungsfreier Tag in data/vorlesungszeiten.json (Test prüft)

const DAY = 864e5;
const addDays = (/** @type {string} */ d, /** @type {number} */ n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const diffDays = (/** @type {string} */ a, /** @type {string} */ b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

/**
 * s = env.support[key] ({ rows, days, memRows, memDays }), today = Ortstag. Rückgabe { share (0–1, der knappere Teil), rows, needRows, days,
 * needDays, eta (Ortstag, ab dem er voraussichtlich greift; null = wartet auf den ersten Fall), from (Erfassung beginnt erst an diesem Tag) }.
 * @param {any} s @param {string} key @param {string} today @param {{ windowDays?: number, minRows?: number, minDays?: number }} [o]
 */
export function ctxProgress(s, key, today, { windowDays = 21, minRows = GATES.ctxMinRows, minDays = GATES.ctxMinDays } = {}) {
  const n = (s?.rows || 0) + (s?.memRows || 0), d = (s?.days || 0) + (s?.memDays || 0), base = { rows: Math.round(n), needRows: minRows, days: Math.round(d * 10) / 10, needDays: minDays };
  const share = Math.max(0, Math.min(1, n / minRows, d / minDays)), since = FEATURE_SINCE[key] || null;
  if (since && since > today) return { ...base, share: 0, eta: addDays(since, minDays - 1), from: since };
  if (share >= 1) return { ...base, share: 1, eta: today, from: null };
  const start = since && diffDays(since, today) < windowDays ? since : addDays(today, 1 - windowDays), span = Math.max(1, diffDays(start, today) + 1);
  const rRows = (s?.rows || 0) / span, rDays = (s?.days || 0) / span;
  const tRows = n >= minRows ? 0 : rRows > 0 ? Math.ceil((minRows - n) / rRows) : Infinity, tDays = d >= minDays ? 0 : rDays > 0 ? Math.ceil((minDays - d) / rDays) : Infinity, t = Math.max(tRows, tDays);
  return { ...base, share, eta: Number.isFinite(t) ? addDays(today, t) : null, from: null };
}

/**
 * Wetter-Gate als Fortschritt: share = knappster Teil (Temperaturspanne, Regentage, Trockentage, Anteil mit Wetter), parts für den Text.
 * @param {any} gate weather.gate aus forecast/latest.json @param {any} [G] GATES
 */
export function wxProgress(gate, G = GATES) {
  if (!gate) return null;
  const parts = { temp: (gate.tempRangeK || 0) / G.wxTempRangeK, rain: (gate.rainDays || 0) / G.wxRainDays, dry: (gate.dryDays || 0) / G.wxRainDays, have: gate.missingShare == null ? 1 : (1 - gate.missingShare) / (1 - G.wxMissingMax) };
  return { share: gate.ok ? 1 : Math.max(0, Math.min(1, ...Object.values(parts))), parts };
}
