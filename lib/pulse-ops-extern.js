// @ts-check
// Mobility Pulse – Disposition mit Prognose und ÖPNV (16.11.2026). Zwei Zuflüsse in den Plan, aus dem Schichtplan und Fahrertouren entstehen:
// 1. Prognose-Faktor: Das Nachfragemodell der Disposition ist der Mittelwert der letzten 7 Tage je Zelle und Tageszeit-Band. Die Prognose
//    (forecast/latest.json, Gemeinde je Stunde) sagt, ob die nächsten Stunden des Bands darüber oder darunter liegen (Wetter, Veranstaltungen,
//    Wochentag, Streik). Der Sammler schreibt dafür forecast/dispo.json: je Gemeinde die Prognose der nächsten 24 Stunden und das Mittel der
//    gemessenen Fahrtbeginne derselben Ortsstunde an den letzten baseDays Tagen aus derselben Quelle (forecast/series.json). Faktor = Prognose ÷
//    Mittel über die Stunden des Bands bei seinem nächsten Vorkommen, begrenzt auf min–max. Die Zählung der Zellen und die der Prognose
//    unterscheiden sich im Maßstab (Stuttgart 16.11.: Zellen 0,66 bis 0,85 der Prognose-Reihe je Band), darum das Verhältnis aus einer Quelle.
// 2. ÖPNV-Ziele: Stationen, die in den letzten 2 Stunden gestört waren (oepnv/<AGS>.json jetzt), ohne Fahrzeug des gewählten Anbieters in
//    radiusM und ohne Spot in der Nähe, werden zusätzliche Ziele mit target Fahrzeugen (höchstens max), damit Fahrgäste dort umsteigen können.

export const DISPO_FC = Object.freeze({ baseDays: 7, minBase: 20, min: 0.5, max: 2, holdAbove: 1.15 });
export const OEPNV_DISPO = Object.freeze({ radiusM: 300, max: 5, target: 2, spotNearM: 300, maxFromSpotM: 2000 });
const r1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;
const M_LAT = 111320;
const distM = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c, /** @type {number} */ d) => { const dy = (c - a) * M_LAT, dx = (d - b) * M_LAT * Math.cos(((a + c) / 2) * Math.PI / 180); return Math.sqrt(dx * dx + dy * dy); };

/**
 * Sammler: forecast/dispo.json aus Prognose (latest, Familie Mikromobilität) und Stundenreihen (series). Rückgabe { at, from, local: [[Tag, Stunde]],
 * baseDays: [Tag], fields, ags: { AGS: [[Prognose je Horizont-Stunde], [Mittel gemessen je Horizont-Stunde]] } }; Gemeinden ohne Messwerte fehlen.
 */
/** @param {any} latest @param {any} series @param {any} [opts] */
export function dispoForecast(latest, series, { baseDays = DISPO_FC.baseDays } = {}) {
  const local = latest?.horizon?.local || [], today = series?.today || (local[0]?.[0] ?? '9999');
  const days = Object.keys(series?.days || {}).filter(d => d < today).sort().slice(-baseDays), out = /** @type {Record<string, number[][]>} */ ({}), todayIst = /** @type {Record<string, number[]>} */ ({});
  for (const [ags, f] of Object.entries(latest?.municipalities || {})) {
    const b = local.map(([, h]) => { let s = 0, n = 0; for (const d of days) { const a = series.days[d]?.[`ags:${ags}`]?.a?.[h]; if (Number.isFinite(a)) { s += a; n++; } } return n ? r1(s / n) : null; });
    if (!b.some(x => x != null && x > 0)) continue;
    out[ags] = [/** @type {number[]} */ (f).slice(0, local.length).map(r1), b.map(x => x ?? 0)];
    // heute bisher: gezählt gegen Plan (Stunden mit beiden Werten), für die Schranke im Browser (forecastFactor, todayRatio)
    const s = series?.days?.[today]?.[`ags:${ags}`]; let ist = 0, plan = 0;
    if (s?.a && s?.p) for (let h = 0; h < 24; h++) if (Number.isFinite(s.a[h]) && Number.isFinite(s.p[h])) { ist += s.a[h]; plan += s.p[h]; }
    if (plan > 0) todayIst[ags] = [Math.round(ist), Math.round(plan)];
  }
  return { at: latest?.generatedAt ?? null, from: latest?.horizon?.from ?? null, local, baseDays: days, fields: ['prognose', 'mittel_gemessen'], ags: out, today: todayIst, corrections: dispoCorrections(latest), ptRisk: dispoPtRisk(latest) };
}
/**
 * Einfluss der ÖPNV-Prognose (Merkmal ptRisk) für den Reiter ÖPNV (seit Format 1.9): state on (im Modell) oder off, b = gelernte Wirkung
 * (log, Faktor exp(b), wie memory.effects), n = Fälle wie in der Einflüsse-Tabelle (env.support rows + memRows); null, solange die Prognose das Merkmal nicht kennt.
 */
/** @param {any} latest */
export function dispoPtRisk(latest) {
  const E = latest?.env; if (!(E?.keys || []).includes('ptRisk')) return null;
  const e = latest?.memory?.effects?.ptRisk, sup = E.support?.ptRisk;
  return { state: (E.active || []).includes('ptRisk') ? 'on' : 'off', b: e?.b ?? null, n: sup ? sup.rows + sup.memRows : (e?.n ?? 0) };
}
/**
 * Korrekturen der Prognose für die Anzeige in Disposition und Reiter ÖPNV (seit Format 1.2): on = in `prognose` eingerechnet; gate = Stand der
 * Freigabe (lib/pulse-forecast-select.js CORR_GATE); Störungskorrektur mit Faktor je gerade gestörter Gemeinde und Wirkdauer.
 */
/** @param {any} latest */
export function dispoCorrections(latest) {
  const g = (/** @type {any} */ x) => (x ? { on: !!x.on, why: x.why ?? null, since: x.since ?? null, n: x.n ?? 0, cases: x.cases ?? 0, ratio: x.ratio ?? null, p: x.p ?? null, need: x.need ?? null } : null);
  const S = latest?.stoerung, N = latest?.nowcast;
  return {
    stoerung: S ? { on: !!S.applied, gate: g(S.gate), learnUntil: S.learnUntil ?? null, maxLeadH: S.rule?.maxLeadH ?? null, tauH: S.rule?.tauH ?? null,
      cities: Object.fromEntries(Object.entries(S.now?.c || {}).map(([a, r]) => [a, /** @type {number[]} */ (r)[0]])) } : null,
    nowcast: N ? { on: !!N.applied, gate: g(N.gate), ratio: N.now?.ratio ?? null } : null,
  };
}

/**
 * Browser: Faktor für ein Band (Objekt { from, to } in Ortsstunden oder 'day') aus forecast/dispo.json. Nimmt die Horizont-Stunden des Bands bei
 * seinem nächsten Vorkommen (zusammenhängend ab der ersten), beim ganzen Tag alle 24. Rückgabe { factor, raw, fc, base, day, from, to } oder null.
 */
/** @param {any} doc @param {string} ags @param {{ from: number, to: number } | 'day'} band @param {any} [opts] */
export function forecastFactor(doc, ags, band, { minBase = DISPO_FC.minBase, min = DISPO_FC.min, max = DISPO_FC.max } = {}) {
  const row = doc?.ags?.[ags], local = doc?.local || []; if (!row || !local.length) return null;
  const inBand = (/** @type {number} */ h) => band === 'day' || (h >= band.from && h < band.to);
  let i0 = local.findIndex((/** @type {any[]} */ x) => inBand(x[1])); if (i0 < 0) return null;
  let i1 = i0; if (band === 'day') i1 = local.length - 1; else while (i1 + 1 < local.length && inBand(local[i1 + 1][1]) && local[i1 + 1][1] === local[i1][1] + 1) i1++;
  let fc = 0, base = 0; for (let i = i0; i <= i1; i++) { fc += row[0][i] || 0; base += row[1][i] || 0; }
  if (!(base >= minBase)) return null;
  const raw = fc / base, ti = doc?.today?.[ags], ratio = ti && ti[1] >= minBase ? ti[0] / ti[1] : null;
  // Schranke: liegt die Stadt heute deutlich über Plan, senkt die Prognose den Bedarf nicht (Stuttgart 18.11.2026: × 0,77 bei Ist +31 %)
  const held = raw < 1 && ratio != null && ratio >= DISPO_FC.holdAbove;
  return { factor: held ? 1 : Math.min(max, Math.max(min, raw)), raw: Math.round(raw * 1000) / 1000, fc: Math.round(fc), base: Math.round(base), day: local[i0][0], from: local[i0][1], to: local[i1][1] + 1, today: ratio == null ? null : Math.round(ratio * 1000) / 1000, held };
}

/**
 * Browser: zusätzliche Ziele an gestörten ÖPNV-Stationen. rows: jetzt.rows [Station, Name, lat, lon, Halte, ausgefallen, verspätet];
 * vehicles: verfügbare Fahrzeuge des Anbieters; spots: Spots der Disposition. Rückgabe Spot-ähnliche Objekte (cell 'pt:<Station>', rank ab firstRank).
 */
/** @param {any[][]} rows @param {any} o */
export function oepnvSpots(rows, { vehicles = [], spots = [], firstRank = 1, radiusM = OEPNV_DISPO.radiusM, max = OEPNV_DISPO.max, target = OEPNV_DISPO.target, spotNearM = OEPNV_DISPO.spotNearM, maxFromSpotM = OEPNV_DISPO.maxFromSpotM } = {}) {
  const out = [];
  for (const r of (rows || []).slice().sort((a, b) => (b[5] + b[6]) - (a[5] + a[6]) || b[4] - a[4])) {
    if (out.length >= max) break;
    const [id, name, lat, lon, n, skip, late] = r;
    if (vehicles.some((/** @type {any} */ v) => Math.abs(v.lat - lat) < 0.004 && distM(lat, lon, v.lat, v.lon) <= radiusM)) continue;
    if ([...spots, ...out].some((/** @type {any} */ s) => distM(lat, lon, s.lat, s.lon) <= spotNearM)) continue;
    // nur in Reichweite der Spots mit Nachfrage: Stationen am Stadtrand verlängerten die Touren (Stuttgart 18.11.2026: 52 und 58 km für 23 Fahrzeuge)
    if (spots.length && !spots.some((/** @type {any} */ s) => distM(lat, lon, s.lat, s.lon) <= maxFromSpotM)) continue;
    out.push({ rank: firstRank + out.length, cell: `pt:${id}`, lat, lon, target, score: 0, oepnv: { name, bad: skip + late, n } });
  }
  return out;
}

/**
 * Browser: Wirkung der Störungskorrektur für eine gerade gestörte Gemeinde aus forecast/dispo.json. Rückgabe { f, on, extra (Fahrtbeginne mehr
 * oder weniger in den Wirkstunden), share (relativ), hours, gate } oder null (Gemeinde nicht gestört, keine Prognose).
 */
/** @param {any} doc @param {string} ags */
export function ptCorrectionOf(doc, ags) {
  const S = doc?.corrections?.stoerung, f = S?.cities?.[ags], row = doc?.ags?.[ags]?.[0]; if (!S || !Number.isFinite(f) || !row) return null;
  const L = Math.min(S.maxLeadH ?? 3, row.length), tau = S.tauH ?? 2; let raw = 0, extra = 0;
  for (let k = 0; k < L; k++) { const lf = 1 + (f - 1) * Math.exp(-k / tau), r = S.on ? (row[k] || 0) / lf : (row[k] || 0); raw += r; extra += r * (lf - 1); }
  return { f, on: !!S.on, extra: Math.round(extra * 10) / 10, share: raw > 0 ? extra / raw : null, hours: L, gate: S.gate || null, learnUntil: S.learnUntil ?? null };
}
