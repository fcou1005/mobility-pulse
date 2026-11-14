// Mobility Pulse – Sprint 7 (Markt): Ereignis-Wirkung (S7.2), Preis-Wirkung (S7.3), Expansions-Scout (S7.4).
// Ereignis: Ist gegen die am Vortag ausgegebene Prognose (forecast/series.json, Stundenwerte je Gemeinde) im Zeitfenster des Ereignisses; das Band
// kommt aus den Abweichungen derselben Gemeinde im selben Fenster an den übrigen Tagen (90-%-Band: 5. bis 95. Perzentil). Enthält es die Null: „nicht unterscheidbar“.
// Preis: Differenz der Differenzen der logarithmierten Fahrten je Tag gegen die übrigen Anbieter derselben Gemeinde und Art, je 7 volle Tage davor
// und danach (Tag der Änderung ausgenommen), Intervall 95 % nach Welch mit t-Quantil.
// Scout: Gemeinden ab 20.000 Einwohnern ohne Sharing, Rang nach Einwohnern, Dichte, Nähe zu Sharing-Gemeinden und deren Flotte.
import { areaM2 } from './pulse-zones-geo.js';
import { fullDay } from './pulse-markt-index.js';

export const WIRK = Object.freeze({ version: 1, minDays: 5, minForecast: 50, keepDays: 400, priceWindow: 7, maxAgs: 3 });
const q = (arr, p) => { const v = arr.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return v[lo] + (v[hi] - v[lo]) * (i - lo); };
const r1 = (x) => Math.round(x * 10) / 10, r3 = (x) => Math.round(x * 1000) / 1000;

/** Zeitfenster [h0, h1) eines Ereignisses am Ortstag day (Streik: 5–24 Uhr; ohne Uhrzeit: 10–22 Uhr) */
/** @param {any} e @param {any} day @returns {any} */
export function eventWindow(e, day) {
  if (/^streik/.test(e.art || '')) return [5, 24];
  if (e.ohneUhrzeit || !/T\d\d:/.test(e.von || '')) return [10, 22];
  const d0 = String(e.von).slice(0, 10), d1 = String(e.bis || e.von).slice(0, 10), h0 = d0 === day ? +String(e.von).slice(11, 13) : 0, h1 = d1 === day ? Math.min(24, +String(e.bis || e.von).slice(11, 13) + 1) : 24;
  return h1 > h0 ? [h0, h1] : [h0, Math.min(24, h0 + 3)];
}
/** Ortstage, an denen ein Ereignis gilt (Streiks: tage; sonst von bis bis) */
/** @param {any} e @returns {any} */
export function eventDays(e) {
  if (Array.isArray(e.tage) && e.tage.length) return e.tage;
  const a = String(e.von || '').slice(0, 10), b = String(e.bis || e.von || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) return [];
  const out = []; for (let t = Date.parse(`${a}T12:00:00Z`), end = Date.parse(`${b || a}T12:00:00Z`); t <= end && out.length < 31; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
// Ist und Prognose im Fenster, nur Stunden mit beiden Werten (Lücken des Sammlers); null, wenn weniger als 70 % des Fensters gemessen sind
const sumPair = (/** @type {any} */ g, /** @type {any} */ [h0, h1]) => { let A = 0, P = 0, n = 0; for (let h = h0; h < h1; h++) { const a = g?.a?.[h], p = g?.p?.[h]; if (Number.isFinite(a) && Number.isFinite(p)) { A += a; P += p; n++; } } return n >= 0.7 * (h1 - h0) ? { A, P, n } : null; };

/**
 * Wirkung der Ereignisse an abgeschlossenen Tagen (vor today) aus series.days[Tag]['ags:<AGS>'] = { p, a } (Stunden 0–23).
 * events: ereignisse.json → ereignisse (und streiks.json → erkannt mit sicher). Rückgabe [{ key, id, day, ags, art, titel, window, actual, forecast,
 *   effect, rel, band: [lo, hi], relBand, n, verdict ('mehr'|'weniger'|'nicht unterscheidbar'), quelle }]
 */
/** @param {any} series @param {any} events @param {any} [opts] @returns {any} */
export function eventEffects(series, events, { today, minDays = WIRK.minDays, minForecast = WIRK.minForecast, maxAgs = WIRK.maxAgs } = {}) {
  const days = Object.keys(series?.days || {}).filter(d => d < today).sort(), out = [];
  for (const e of events || []) {
    if (e.aus || e.sicher === false) continue;
    const ags = (e.gebiet?.ags || []).filter(a => /^\d{8}$/.test(a));
    for (const day of eventDays(e).filter(d => days.includes(d))) {
      const win = eventWindow(e, day);
      for (const a of ags.filter(x => series.days[day]?.[`ags:${x}`]).slice(0, maxAgs)) {
        const cur = sumPair(series.days[day][`ags:${a}`], win); if (!cur || cur.P < minForecast) continue;
        const { A, P } = cur;
        const rel = days.filter(d => d !== day).map(d => { const o = sumPair(series.days[d]?.[`ags:${a}`], win); return o && o.P > 0 ? o.A / o.P - 1 : null; }).filter(Number.isFinite);
        if (rel.length < minDays) continue;
        const lo = q(rel, 0.05), hi = q(rel, 0.95), band = [A - P * (1 + hi), A - P * (1 + lo)], verdict = band[0] <= 0 && band[1] >= 0 ? 'nicht unterscheidbar' : band[0] > 0 ? 'mehr' : 'weniger';
        out.push({ key: `${e.id || e.titel}|${day}|${a}`, id: e.id || null, day, ags: a, art: e.art || null, titel: e.titel || e.grund?.join(', ') || null, window: win, actual: Math.round(A), forecast: Math.round(P), effect: Math.round(A - P), rel: r3(A / P - 1),
          hours: cur.n, band: band.map(Math.round), relBand: [r3(band[0] / P), r3(band[1] / P)], n: rel.length, verdict, quelle: e.quelle || e.link || null });
      }
    }
  }
  return out;
}

/** echte Preisänderungen aus pricing-log.json: Entsperrpreis oder Minutenpreis (Satz, ab Minute) anders; reine Formänderungen zählen nicht */
/** @param {any} log @param {any} [opts] @returns {any} */
export function priceChanges(log, { tz = 'Europe/Berlin' } = {}) {
  const fi = Object.fromEntries((log?.fields || ['at', 'sourceId', 'operator', 'planId', 'field', 'old', 'new']).map((f, i) => [f, i])), DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: tz });
  const norm = (v) => (Array.isArray(v) ? JSON.stringify(v.map(x => [x?.start ?? null, x?.rate ?? null, x?.end ?? null])) : JSON.stringify(v ?? null));
  const by = new Map();
  for (const c of log?.changes || []) {
    const f = c[fi.field]; if (!['unlock', 'perMin', 'perKm', 'price'].includes(f) || norm(c[fi.old]) === norm(c[fi.new])) continue;
    const day = DAY.format(new Date(c[fi.at])), k = `${day}|${c[fi.operator]}|${c[fi.sourceId]}`;
    const e = by.get(k) || { day, at: c[fi.at], operator: c[fi.operator], source: c[fi.sourceId], fields: new Set(), plans: new Set(), old: [], new: [] };
    e.fields.add(f); e.plans.add(c[fi.planId]); if (e.old.length < 3) { e.old.push(c[fi.old]); e.new.push(c[fi.new]); } by.set(k, e);
  }
  return [...by.values()].map(e => ({ ...e, fields: [...e.fields], plans: e.plans.size })).sort((a, b) => a.at - b.at);
}
const tq975 = (df) => (df >= 30 ? 1.96 : [12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05][Math.max(1, Math.floor(df)) - 1]);
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/**
 * Differenz der Differenzen je Preisänderung und Gemeinde. archive: { fields, days } (alle Monate), srcMunis: { Quelle → [AGS] }.
 * Rückgabe [{ key, day, operator, ags, type, status ('ok'|'wartet'|'ohne Vergleich'|'zu wenig Tage'), readyOn, did, effect (Anteil), ci: [lo, hi],
 *   before, after, controls, fields }]
 */
/** @param {any} changes @param {any} archive @param {any} [opts] @returns {any} */
export function priceEffects(changes, archive, { srcMunis = {}, window = WIRK.priceWindow, today = null, fullHours = 20 } = {}) {
  const F = Object.fromEntries((archive?.fields || []).map((f, i) => [f, i])), out = [];
  const val = (d, ags, type, pred) => { let s = 0, any = false; for (const [k, r] of Object.entries(archive?.days?.[d] || {})) { const [a, op, ty] = k.split('|'); if (a !== ags || ty !== type || !pred(op) || !fullDay(r, F, fullHours)) continue; s += r[F.fahrten] || 0; any = true; } return any && s > 0 ? s : null; };
  for (const c of changes || []) {
    for (const ags of srcMunis[c.source] || []) {
      const types = new Set(); for (const r of Object.values(archive?.days || {})) for (const k of Object.keys(r)) { const [a, op, ty] = k.split('|'); if (a === ags && op === c.operator) types.add(ty); }
      for (const type of types) {
        const base = { key: `${c.day}|${c.operator}|${ags}|${type}`, day: c.day, operator: c.operator, ags, type, fields: c.fields, readyOn: addDays(c.day, window + 1) };
        const controls = new Set(); for (const r of Object.values(archive?.days || {})) for (const k of Object.keys(r)) { const [a, op, ty] = k.split('|'); if (a === ags && ty === type && op !== c.operator) controls.add(op); }
        if (!controls.size) { out.push({ ...base, status: 'ohne Vergleich', controls: 0 }); continue; }
        if (today && base.readyOn > today) { out.push({ ...base, status: 'wartet', controls: controls.size }); continue; }
        const g = (d) => { const t = val(d, ags, type, op => op === c.operator), k = val(d, ags, type, op => op !== c.operator); return t && k ? Math.log(t) - Math.log(k) : null; };
        const before = [...Array(window)].map((_, i) => g(addDays(c.day, -window + i))).filter(Number.isFinite), after = [...Array(window)].map((_, i) => g(addDays(c.day, i + 1))).filter(Number.isFinite);
        if (before.length < Math.max(3, window - 2) || after.length < Math.max(3, window - 2)) { out.push({ ...base, status: 'zu wenig Tage', before: before.length, after: after.length, controls: controls.size }); continue; }
        const m = (a) => a.reduce((s, x) => s + x, 0) / a.length, v = (a) => { const mu = m(a); return a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1); };
        const did = m(after) - m(before), va = v(after) / after.length, vb = v(before) / before.length, se = Math.sqrt(va + vb);
        const df = (va + vb) ** 2 / ((va ** 2) / (after.length - 1) + (vb ** 2) / (before.length - 1) || 1), t = tq975(df);
        out.push({ ...base, status: 'ok', did: r3(did), effect: r3(Math.exp(did) - 1), ci: [r3(Math.exp(did - t * se) - 1), r3(Math.exp(did + t * se) - 1)], before: before.length, after: after.length, controls: controls.size, verdict: did - t * se > 0 ? 'mehr' : did + t * se < 0 ? 'weniger' : 'nicht unterscheidbar' });
      }
    }
  }
  return out;
}

// ---------- S7.4 Expansions-Scout ----------
const hav = (a, b) => { const R = 6371, dLa = (b[1] - a[1]) * Math.PI / 180, dLo = (b[0] - a[0]) * Math.PI / 180, s = Math.sin(dLa / 2) ** 2 + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const centerOf = (g) => { let x = 0, y = 0, n = 0; for (const p of g.type === 'Polygon' ? [g.coordinates] : g.coordinates || []) for (const [lon, lat] of p[0] || []) { x += lon; y += lat; n++; } return n ? [x / n, y / n] : null; };
export const SCOUT = Object.freeze({ minPop: 20000, radiusKm: 15, top: 20, w: { pop: 0.35, density: 0.25, near: 0.2, fleet: 0.2 } });
/**
 * features: Gemeindegrenzen aller Länder (properties ags, name, pop, state); fleetOf: { AGS → Fahrzeuge (Mikromobilität) }.
 * Rückgabe { minPop, candidates, rows: [{ rank, ags, name, state, pop, densityKm2, nearest: { ags, name, km }, sharingNear, fleetNear, score, parts, reason }] }
 */
/** @param {any} features @param {any} fleetOf @param {any} [opts] @returns {any} */
export function scout(features, fleetOf, { minPop = SCOUT.minPop, radiusKm = SCOUT.radiusKm, top = SCOUT.top } = {}) {
  const all = (features || []).filter(f => f?.properties?.ags && f.geometry).map(f => ({ ags: f.properties.ags, name: f.properties.name, state: f.properties.state, pop: +f.properties.pop || 0, c: centerOf(f.geometry), km2: areaM2(f.geometry) / 1e6 })).filter(x => x.c);
  const sharing = all.filter(x => (fleetOf[x.ags] || 0) > 0), cand = all.filter(x => x.pop >= minPop && !(fleetOf[x.ags] > 0));
  for (const x of cand) {
    let best = null; let nearN = 0, nearF = 0;
    for (const s of sharing) { const d = hav(x.c, s.c); if (!best || d < best.km) best = { ags: s.ags, name: s.name, km: d }; if (d <= radiusKm) { nearN++; nearF += fleetOf[s.ags] || 0; } }
    x.nearest = best ? { ags: best.ags, name: best.name, km: r1(best.km) } : null; x.sharingNear = nearN; x.fleetNear = nearF; x.densityKm2 = x.km2 > 0 ? Math.round(x.pop / x.km2) : null;
  }
  const z = (vals) => { const m = vals.reduce((s, v) => s + v, 0) / (vals.length || 1), sd = Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, vals.length - 1)) || 1; return (v) => (v - m) / sd; };
  const zp = z(cand.map(x => Math.log(x.pop))), zd = z(cand.map(x => Math.log(1 + (x.densityKm2 || 0)))), zn = z(cand.map(x => -(x.nearest?.km ?? 100))), zf = z(cand.map(x => Math.log(1 + x.fleetNear)));
  const W = SCOUT.w;
  for (const x of cand) { x.parts = { pop: r3(W.pop * zp(Math.log(x.pop))), density: r3(W.density * zd(Math.log(1 + (x.densityKm2 || 0)))), near: r3(W.near * zn(-(x.nearest?.km ?? 100))), fleet: r3(W.fleet * zf(Math.log(1 + x.fleetNear))) }; x.score = r3(Object.values(x.parts).reduce((s, v) => s + v, 0)); }
  const fmt = (n) => Math.round(n).toLocaleString('de-DE');
  const rows = cand.sort((a, b) => b.score - a.score || b.pop - a.pop).slice(0, top).map((x, i) => {
    const why = [];
    const order = Object.entries(x.parts).sort((a, b) => b[1] - a[1]);
    for (const [k] of order.slice(0, 2)) why.push(k === 'pop' ? `${fmt(x.pop)} Einwohner` : k === 'density' ? `dicht besiedelt (${fmt(x.densityKm2 || 0)} je km²)` : k === 'near' ? `nächste Sharing-Gemeinde ${x.nearest?.name} in ${String(x.nearest?.km).replace('.', ',')} km` : `${fmt(x.fleetNear)} Sharing-Fahrzeuge in ${x.sharingNear} ${x.sharingNear === 1 ? 'Gemeinde' : 'Gemeinden'} im Umkreis von ${radiusKm} km`);
    return { rank: i + 1, ags: x.ags, name: x.name, state: x.state, pop: x.pop, densityKm2: x.densityKm2, nearest: x.nearest, sharingNear: x.sharingNear, fleetNear: x.fleetNear, score: x.score, parts: x.parts, reason: `Rang ${i + 1}: ${why.join('; ')}.` };
  });
  return { minPop, radiusKm, candidates: cand.length, sharing: sharing.length, weights: SCOUT.w, rows };
}
