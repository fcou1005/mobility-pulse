// Sammler, Phase „geo“ (Sprint 8): liest den Branch geo (Workflow „Geo“: Zensus, Unfallatlas, Fahrplan, Umwegfaktor) und rechnet je Lauf
// auf den privaten Positionen: Versorgung (S8.2), Fahrtbeginne/-enden an Haltestellen (S8.5), Fahrtenden je 50-m-Zelle (S8.4).
// Zustand privat in TRACK_DIR/geo-state.json.gz, Geo-Dateien zwischengespeichert in TRACK_DIR/geo/. Veröffentlicht im Branch data:
//   versorgung/<AGS>.json, versorgung/index.json, zubringer/index.json, abstell/<AGS>.json (Zellen ab 3 Fahrtenden),
//   unfall/<AGS>.json, unfall/index.json, umweg/<AGS>.json, umweg/index.json, pop/index.json (Kopien aus geo für aktive Gemeinden)
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import * as C from '../../lib/pulse-geo-cover.js';
import * as G from '../../lib/pulse-geo-gtfs.js';
import { G50, cellOfGrid, distM, dropBatches } from '../../lib/pulse-geo-proj.js';
import { unpackPts } from '../../lib/pulse-geo-pop.js';
import { cellOf, dayOf, hourOf } from '../../lib/pulse-track-rules.js';
import * as SV from '../../lib/pulse-schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GEO = Object.freeze({ base: process.env.GEO_BASE || 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/geo/', checkH: 6, minVehicles: 20, keepDays: 30, feederCities: 30, minCount: 3, hideBand: 5, floorDefault: 15, moveM: 200, massLoss: 0.3, batchM: 25, batchMin: 3, swapPts: 15, stateV: 1 });
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
const LAND = { '01': 'SH', '02': 'HH', '03': 'NI', '04': 'HB', '05': 'NW', '06': 'HE', '07': 'RP', '08': 'BW', '09': 'BY', '10': 'SL', '11': 'BE', '12': 'BB', '13': 'MV', '14': 'SN', '15': 'ST', '16': 'TH' };

async function getText(rel) {
  if (/^https?:/.test(GEO.base)) { const r = await fetch(GEO.base + rel, { signal: AbortSignal.timeout(120e3) }); if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`); return r.text(); }
  return readFile(path.join(GEO.base, rel), 'utf8');
}
/** Geo-Dateien in den Zwischenspeicher holen, wenn sich geo/index.json geändert hat (höchstens alle checkH Stunden prüfen) */
async function syncGeo(cacheDir, st, { states, agsList, log, now }) {
  await mkdir(cacheDir, { recursive: true });
  if (st.geoCheckedAt && now - st.geoCheckedAt < GEO.checkH * 3600e3 && existsSync(path.join(cacheDir, 'index.json'))) return false;
  st.geoCheckedAt = now;
  let ix; try { ix = JSON.parse(await getText('index.json')); } catch (e) { log(`Geo: Branch geo nicht lesbar (${e.message})`); return false; }
  const at = ix.at || 0, changed = at !== st.geoAt;
  if (!changed) return false;
  const files = ['index.json', 'pop/index.json', 'unfall/index.json', 'umweg/index.json', 'gtfs/index.json', ...states.flatMap(s => [`pop/${s}.json`, `gtfs/${s}.json`]), ...agsList.flatMap(a => [`unfall/${a}.json`, `umweg/${a}.json`])];
  let got = 0;
  for (const f of files) { try { const t = await getText(f); await mkdir(path.dirname(path.join(cacheDir, f)), { recursive: true }); await writeFile(path.join(cacheDir, f), t); got++; } catch { /* Teil fehlt (z. B. Umweg nur für 30 Städte) */ } }
  st.geoAt = at; log(`Geo: ${got} Dateien aus dem Branch geo (${new Date(at).toISOString()})`);
  return true;
}
const readJson = async (f) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } };

export async function run(ctx) {
  const { DATA, TRACK_DIR, now, log, dv, vkey, sourceOut } = ctx;
  if (!dv?.vehicles?.length) return;
  try {
    const t0 = Date.now(), base = TRACK_DIR || path.join(DATA, '..', 'geo-cache'), stFile = path.join(base, 'geo-state.json.gz'), cacheDir = path.join(base, 'geo');
    let st = null; try { st = existsSync(stFile) ? JSON.parse(gunzipSync(await readFile(stFile)).toString('utf8')) : null; } catch (e) { log('Geo-Zustand unlesbar, Neustart:', e.message); }
    if (st?.v !== GEO.stateV) st = { v: GEO.stateV, runIdx: 0, cover: {}, feeder: {}, abstell: {} };
    st.runIdx++;
    const day = dayOf(now), hour = hourOf(now);
    // aktive Gemeinden: mindestens 20 verfügbare Fahrzeuge ohne Autos
    const byAgs = new Map(), opsByAgs = new Map();
    for (const v of dv.vehicles) { if (!v.ags || v.type === 'car') continue; (opsByAgs.get(v.ags) || opsByAgs.set(v.ags, new Set()).get(v.ags)).add(v.operator); if (v.disabled || v.reserved) continue; let a = byAgs.get(v.ags); if (!a) byAgs.set(v.ags, a = []); a.push([v.lat, v.lon]); }
    const active = [...byAgs].filter(([, l]) => l.length >= GEO.minVehicles).map(([a]) => a).sort();
    const stateOf = (a) => LAND[a.slice(0, 2)] || null;
    const states = [...new Set(active.map(stateOf).filter(Boolean))].sort();
    const fresh = await syncGeo(cacheDir, st, { states, agsList: active, log, now });
    const popDocs = {}, gtfsDocs = {}; for (const s of states) { popDocs[s] = await readJson(path.join(cacheDir, 'pop', `${s}.json`)); gtfsDocs[s] = await readJson(path.join(cacheDir, 'gtfs', `${s}.json`)); }
    const refCaps = (await readJson(path.join(ROOT, 'data', 'reference.json')))?.obergrenzen || [];
    // ---------- S8.2 Versorgung ----------
    const vdir = path.join(DATA, 'versorgung'); await mkdir(vdir, { recursive: true });
    const vIndex = (await readJson(path.join(vdir, 'index.json'))) || { schemaVersion: SV.SCHEMA.geo, ags: {} };
    const writeHour = st.lastHour !== `${day}T${hour}`; st.lastHour = `${day}T${hour}`;
    let covered = 0, points = 0;
    for (const ags of active) {
      const pa = popDocs[stateOf(ags)]?.ags?.[ags]; if (!pa) continue;
      const prep = C.prepareAgs(unpackPts(pa.pts), cellOf); points += prep.n;
      let cs = st.cover[ags], acc = cs?.acc ? C.accFromJson(cs.acc, prep) : null;
      const docFile = path.join(vdir, `${ags}.json`); let doc = await readJson(docFile);
      if (!doc || doc.pop !== Math.round(prep.pop)) doc = { schemaVersion: SV.SCHEMA.geo, ags, pop: Math.round(prep.pop), radii: C.COVER.radii, dayFrom: C.COVER.dayFrom, dayTo: C.COVER.dayTo, days: [] };
      if (acc && acc.day !== day) { const fin = C.finalizeDay(prep, acc); const { cells, ...rest } = fin; doc.days = [...doc.days.filter(d => d.day !== fin.day), rest].slice(-GEO.keepDays); doc.cells = { day: fin.day, fields: ['zelle', 'einwohner', ...C.COVER.radii.map(r => `anteil_${r}m`)], rows: cells }; acc = null; }
      if (!acc) acc = C.emptyAcc(prep, day);
      C.coverRun(prep, acc, byAgs.get(ags), { hour, runIdx: st.runIdx }); covered++;
      st.cover[ags] = { acc: C.accToJson(acc) };
      if (writeHour || fresh || !existsSync(docFile)) {
        const today = C.finalizeDay(prep, acc), mo = C.missingOperators(refCaps, ags, opsByAgs.get(ags));
        doc = { ...doc, schemaVersion: SV.SCHEMA.geo, at: now, today: { ...today, cells: undefined }, missingOps: mo.missing, missingCount: mo.countGap, attribution: 'Einwohner: Zensus 2022 © Destatis (dl-de/by-2-0); Fahrzeuge: offene Feeds der Anbieter' };
        await writeFile(docFile, JSON.stringify(doc));
        const last = doc.days.at(-1) || today;
        vIndex.ags[ags] = [last.day, Math.round(prep.pop), ...last.share.map(r4), ...last.time50.map(r4), r4(last.gini), r4(last.diffPP), mo.missing.length];
      }
    }
    for (const a of Object.keys(st.cover)) if (!active.includes(a)) delete st.cover[a];
    if (writeHour || fresh) await writeFile(path.join(vdir, 'index.json'), JSON.stringify({ ...vIndex, schemaVersion: SV.SCHEMA.geo, at: now, fields: ['tag', 'einwohner', ...C.COVER.radii.map(r => `anteil_${r}m`), ...C.COVER.radii.map(r => `zeit50_${r}m`), 'gini_1km', 'abweichung_jeder_dritte_pp', 'anbieter_ohne_feed'] }));
    // ---------- Beginne und Enden dieses Laufs (Punkte) ----------
    const prev = ctx.akkuPrev?.snap || null, floors = {}; for (const r of sourceOut || []) { const f = r.batteryFloor; if (f?.hides && Number.isFinite(f.p005)) floors[r.operator] = Math.max(floors[r.operator] ?? 0, f.p005); }
    const starts = new Map(), ends = new Map(), add = (m, ags, la, lo, op) => { let l = m.get(ags); if (!l) m.set(ags, l = []); l.push([la, lo, op]); };
    const moved = new Map(), addMoved = (ags, n) => moved.set(ags, (moved.get(ags) || 0) + n);
    if (prev) {
      const cur = new Map(); for (const v of dv.vehicles) if (v.type !== 'car' && v.ags) cur.set(vkey(v.operator, v.rawId), v);
      const pres = new Map(), gone = new Map(), appear = new Map(), g = (m, k) => m.set(k, (m.get(k) || 0) + 1);
      for (const [k, p] of prev) { if (p.missing || p.dis || p.res || p.ty === 'car' || !p.ags) continue; const gk = `${p.op}|${p.ags}`; g(pres, gk); if (!cur.has(k)) g(gone, gk); }
      for (const [k, v] of cur) { const p = prev.get(k); if (!p || p.missing) g(appear, `${v.operator}|${v.ags}`); }
      const mass = (m, gk) => (pres.get(gk) || 0) >= 20 && (m.get(gk) || 0) / pres.get(gk) > GEO.massLoss;
      for (const [k, p] of prev) {
        if (p.missing || p.dis || p.res || p.ty === 'car' || !p.ags) continue; const c = cur.get(k), gk = `${p.op}|${p.ags}`;
        if (!c) { if (!mass(gone, gk) && !(p.bat != null && p.bat <= (floors[p.op] ?? GEO.floorDefault) + GEO.hideBand)) add(starts, p.ags, p.lat, p.lon, p.op); }
        else if (!c.disabled && distM(p.lat, p.lon, c.lat, c.lon) >= GEO.moveM) {
          // versetzt und deutlich voller: Akkutausch mit Umsetzung im Transporter, keine Fahrt
          if (p.bat != null && Number.isFinite(c.batteryPct) && c.batteryPct - p.bat >= GEO.swapPts) addMoved(p.ags, 1);
          else { add(starts, p.ags, p.lat, p.lon, p.op); add(ends, c.ags, c.lat, c.lon, c.operator); }
        }
      }
      for (const [k, v] of cur) { const p = prev.get(k); if ((!p || p.missing) && !v.disabled && !v.reserved && !mass(appear, `${v.operator}|${v.ags}`)) add(ends, v.ags, v.lat, v.lon, v.operator); }
      // gebündelt ausgebracht oder abgeholt (3 und mehr eines Anbieters in 25 m im selben Lauf): Umsetzung, keine Fahrt
      for (const m of [starts, ends]) for (const [ags, l] of m) { const r = dropBatches(l, { r: GEO.batchM, min: GEO.batchMin }); m.set(ags, r.kept); if (r.removed) addMoved(ags, r.removed); }
    }
    // ---------- S8.5 Zubringer ----------
    const top = [...byAgs].sort((a, b) => b[1].length - a[1].length).slice(0, GEO.feederCities).map(([a]) => a);
    for (const ags of active) {
      const bl = gtfsDocs[stateOf(ags)]?.ags?.[ags]; if (!bl?.length) continue;
      const fi = G.feederIndex(bl.map(b => ({ lat: b[0], lon: b[1], dep: b[2] })));
      let f = st.feeder[ags]; if (!f || f.day !== day) { if (f) (st.feederDone ??= {})[ags] = [...((st.feederDone || {})[ags] || []).filter(x => x.day !== f.day), { day: f.day, starts: f.s, ends: f.e, near: f.n, dep: fi.dep, runs: f.r, vn: f.vn || 0, vt: f.vt || 0, moved: f.u || 0 }].slice(-GEO.keepDays); f = st.feeder[ags] = { day, s: 0, e: 0, n: 0, r: 0, vn: 0, vt: 0, u: 0 }; }
      f.r++; for (const p of starts.get(ags) || []) { f.s++; if (fi.near(p[0], p[1])) f.n++; } for (const p of ends.get(ags) || []) { f.e++; if (fi.near(p[0], p[1])) f.n++; }
      // Vergleichsbasis: Anteil der abgestellten verfügbaren Fahrzeuge in 150 m an einer Haltestelle
      for (const v of byAgs.get(ags) || []) { f.vt = (f.vt || 0) + 1; if (fi.near(v[0], v[1])) f.vn = (f.vn || 0) + 1; }
      f.u = (f.u || 0) + (moved.get(ags) || 0);
    }
    if (writeHour || fresh) {
      const rows = top.filter(a => st.feeder[a] || st.feederDone?.[a]).map(a => { const hist = st.feederDone?.[a] || [], last = hist.at(-1), t = st.feeder[a], dep = gtfsDocs[stateOf(a)]?.ags?.[a]?.reduce((s, b) => s + b[2], 0) || 0;
        return { ags: a, name: ctx.latest?.municipalities?.[a]?.name || a, dep, last: last ? { day: last.day, index: r4(G.indexValue(last.near, last.dep)), share: r4(last.near / Math.max(1, last.starts + last.ends)), base: last.vt ? r4(last.vn / last.vt) : null, starts: last.starts, ends: last.ends, near: last.near, moved: last.moved ?? null } : null, today: t ? { index: r4(G.indexValue(t.n, dep)), share: r4(t.n / Math.max(1, t.s + t.e)), base: t.vt ? r4(t.vn / t.vt) : null, starts: t.s, ends: t.e, near: t.n, moved: t.u || 0, runs: t.r } : null, days: hist.map(x => [x.day, r4(G.indexValue(x.near, x.dep)), r4(x.near / Math.max(1, x.starts + x.ends)), x.vt ? r4(x.vn / x.vt) : null]) }; });
      const gi = await readJson(path.join(cacheDir, 'gtfs', 'index.json'));
      await mkdir(path.join(DATA, 'zubringer'), { recursive: true });
      await writeFile(path.join(DATA, 'zubringer', 'index.json'), JSON.stringify({ schemaVersion: SV.SCHEMA.geo, at: now, nearM: G.GTFS.nearM, perDep: G.GTFS.perDep, timetableDay: gi?.day || null, attribution: G.GTFS.attribution, rule: 'Index = (Fahrtbeginne + Fahrtenden in 150 m um eine gebündelte Haltestelle mit Abfahrten) ÷ Abfahrten des Stichtags × 100; Anteil = davon ÷ alle Beginne und Enden; Basis = Anteil der abgestellten verfügbaren Fahrzeuge in 150 m; Umsetzungen (gebündelt, Akkutausch) nicht gezählt', cities: rows }));
    }
    // ---------- S8.4 Fahrtenden je 50-m-Zelle und Monat ----------
    const month = day.slice(0, 7);
    for (const ags of active) {
      let a = st.abstell[ags]; if (!a || a.month !== month) { if (a) (st.abstellDone ??= {})[ags] = { month: a.month, cells: a.cells }; a = st.abstell[ags] = { month, cells: {} }; }
      for (const p of ends.get(ags) || []) { const c = cellOfGrid(G50, p[0], p[1]); a.cells[c] = (a.cells[c] || 0) + 1; }
    }
    if (writeHour || fresh) {
      const adir = path.join(DATA, 'abstell'); await mkdir(adir, { recursive: true });
      for (const ags of active) {
        const a = st.abstell[ags], prevM = st.abstellDone?.[ags], pick = (cells) => Object.entries(cells || {}).filter(([, n]) => n >= GEO.minCount).sort((x, y) => y[1] - x[1]);
        const doc = { schemaVersion: SV.SCHEMA.geo, ags, at: now, grid: G50, minCount: GEO.minCount, month: a.month, cells: { fields: ['zelle', 'fahrtenden'], rows: pick(a.cells) }, prev: prevM ? { month: prevM.month, rows: pick(prevM.cells) } : null };
        if (doc.cells.rows.length || doc.prev?.rows.length) await writeFile(path.join(adir, `${ags}.json`), JSON.stringify(doc));
      }
    }
    // ---------- Kopien aus geo: Unfälle, Umwegfaktor, Zensus-Abgleich ----------
    if (fresh || !existsSync(path.join(DATA, 'unfall', 'index.json'))) {
      for (const sub of ['unfall', 'umweg']) {
        const ix = await readJson(path.join(cacheDir, sub, 'index.json')); if (!ix) continue;
        await mkdir(path.join(DATA, sub), { recursive: true });
        const keep = new Set(active);
        if (sub === 'unfall') ix.ags = Object.fromEntries(Object.entries(ix.ags || {}).filter(([a]) => keep.has(a))); else ix.cities = Object.fromEntries(Object.entries(ix.cities || {}).filter(([a]) => keep.has(a)));
        await writeFile(path.join(DATA, sub, 'index.json'), JSON.stringify({ ...ix, schemaVersion: SV.SCHEMA.geo }));
        for (const a of active) { const d = await readJson(path.join(cacheDir, sub, `${a}.json`)); if (d) await writeFile(path.join(DATA, sub, `${a}.json`), JSON.stringify({ ...d, schemaVersion: SV.SCHEMA.geo })); }
        for (const f of (await readdir(path.join(DATA, sub))).filter(x => /^\d{8}\.json$/.test(x) && !keep.has(x.slice(0, 8))).slice(0, 50)) await rm(path.join(DATA, sub, f), { force: true });
      }
      const pix = await readJson(path.join(cacheDir, 'pop', 'index.json'));
      if (pix) { await mkdir(path.join(DATA, 'pop'), { recursive: true }); const { ags: all, worst, ...rest } = pix; await writeFile(path.join(DATA, 'pop', 'index.json'), JSON.stringify({ ...rest, schemaVersion: SV.SCHEMA.geo, worst, ags: Object.fromEntries(Object.entries(all || {}).filter(([a]) => active.includes(a))) })); }
    }
    if (TRACK_DIR) { await mkdir(base, { recursive: true }); await writeFile(stFile, gzipSync(JSON.stringify(st))); }
    log(`Geo: Versorgung ${covered} Gemeinden (${points} Zensuszellen), Beginne ${[...starts.values()].reduce((a, l) => a + l.length, 0)}, Enden ${[...ends.values()].reduce((a, l) => a + l.length, 0)} (${Date.now() - t0} ms)`);
  } catch (e) { log('Geo:', e.message); }
}
