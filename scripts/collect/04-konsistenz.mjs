// Sammler, Phase „konsistenz“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';

export async function run(ctx) {
  const { DATA, fetchJson, log, now, pool, results, sourceOut } = ctx;
  // ---------- Konsistenz: Alternativ-Feeds desselben Systems und mehrere Quellen je Anbieter × Gemeinde ----------
  const consistency = { at: now, systems: [], pairs: [] };
  ctx.consistency = consistency;
  {
    const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
    // Positionsabgleich: Anteil der Fahrzeuge aus A, zu denen in B ein Fahrzeug innerhalb von 10 m steht (Kennungen können umgeschlüsselt sein)
    const posMatch = (A, B) => {
      const grid = new Map(); const k = (lat, lon) => `${Math.round(lat * 1000)}:${Math.round(lon * 1000)}`;
      for (const w of B.values()) { if (!C.validLatLon(w.lat, w.lon)) continue; const key = k(w.lat, w.lon); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(w); }
      let n = 0, hit = 0;
      for (const v of A.values()) {
        if (!C.validLatLon(v.lat, v.lon)) continue; n++;
        const la = Math.round(v.lat * 1000), lo = Math.round(v.lon * 1000); let ok = false;
        for (let dx = -1; dx <= 1 && !ok; dx++) for (let dy = -1; dy <= 1 && !ok; dy++) for (const w of grid.get(`${la + dx}:${lo + dy}`) || []) if (C.haversineM(v.lat, v.lon, w.lat, w.lon) <= 10) { ok = true; break; }
        if (ok) hit++;
      }
      return n ? +(hit / n).toFixed(3) : null;
    };
    const judge = (countDiff, idOverlap, med, pm) => {
      const idsOk = idOverlap != null && idOverlap >= 0.9 && (med ?? 0) <= 25;
      const posOk = pm != null && pm >= 0.9;
      if (countDiff <= 0.05 && (idsOk || posOk)) return 'consistent';
      if (countDiff <= 0.15 && ((idOverlap ?? 0) >= 0.7 || (pm ?? 0) >= 0.7)) return 'minor';
      if ((idOverlap ?? 0) < 0.2 && (pm ?? 0) < 0.2 && countDiff > 0.3) return 'disjoint';
      return 'divergent';
    };

    const altTargets = results.filter(r => r.sys && !r.sys.viaAlt && r.src.altUrls?.length && ['live', 'delayed'].includes(sourceOut.find(x => x.id === r.src.id)?.status));
    await pool(altTargets, async ({ src, sys }) => {
      // Ersatz schon beim Abruf gelesen (C.readGbfsWithFallback: anderer Host) → kein zweiter Abruf; verglichen wird der Hauptfeed ohne Ergänzungen
      const altUrl = sys.altRead?.url || src.altUrls[0], pv = sys.primaryVehicles || sys.vehicles;
      try {
        const alt = sys.altRead || await C.readGbfsSystem({ ...src, url: altUrl }, fetchJson, { now });
        const rec = sourceOut.find(x => x.id === src.id);
        const kind = hostOf(altUrl) === hostOf(src.url) ? 'version' : (/mobidata-bw|mobilitaetsdaten\.nrw/.test(hostOf(src.url)) ? 'land_vs_betreiber' : 'betreiber_vs_land');
        const entry = { sourceId: src.id, operator: src.operator, kind, primary: { url: src.url, version: sys.version, vehicles: pv.length, available: pv.filter(v => !v.disabled && !v.reserved).length, stations: sys.stations.length, feedAgeMs: rec?.feedAgeMs ?? null },
          alt: { url: altUrl, version: alt.version, httpStatus: alt.httpStatus, vehicles: alt.vehicles.length, available: alt.vehicles.filter(v => !v.disabled && !v.reserved).length, stations: alt.stations.length, feedAgeMs: (() => { const a = [alt.feedAges.vehicle_status ?? alt.feedAges.free_bike_status, alt.feedAges.station_status].filter(x => x != null); return a.length ? Math.max(...a) : null; })(), errors: alt.errors.slice(0, 2) } };
        if (!alt.vehicles.length && !alt.stations.length) { entry.verdict = 'alt_unreachable'; consistency.systems.push(entry); rec.consistency = entry.verdict; return; }
        const A = new Map(pv.map(v => [C.normalizeId(v.rawId), v])), B = new Map(alt.vehicles.map(v => [C.normalizeId(v.rawId), v]));
        let common = 0; const dists = [];
        for (const [id, v] of A) { const w = B.get(id); if (!w) continue; common++; if (C.validLatLon(v.lat, v.lon) && C.validLatLon(w.lat, w.lon)) dists.push(C.haversineM(v.lat, v.lon, w.lat, w.lon)); }
        const union = A.size + B.size - common;
        dists.sort((a, b) => a - b);
        entry.idOverlap = union ? +(common / union).toFixed(3) : null;
        entry.medianDistM = dists.length ? Math.round(dists[Math.floor(dists.length / 2)]) : null;
        entry.p90DistM = dists.length ? Math.round(dists[Math.floor(dists.length * 0.9)]) : null;
        const n1 = entry.primary.vehicles, n2 = entry.alt.vehicles;
        const countDiff = Math.max(n1, n2) ? Math.abs(n1 - n2) / Math.max(n1, n2) : 0;
        entry.countDiff = +countDiff.toFixed(3);
        entry.posMatch = posMatch(A, B);
        entry.idsRekeyed = (entry.idOverlap ?? 0) < 0.2 && (entry.posMatch ?? 0) >= 0.7;
        if (!n1 && !n2) { // reine Stationssysteme: Stationszahl vergleichen
          const s1 = entry.primary.stations, s2 = entry.alt.stations; const sd = Math.max(s1, s2) ? Math.abs(s1 - s2) / Math.max(s1, s2) : 0;
          entry.countDiff = +sd.toFixed(3); entry.stationsOnly = true; entry.verdict = sd <= 0.05 ? 'consistent' : sd <= 0.15 ? 'minor' : 'divergent';
        } else entry.verdict = judge(countDiff, entry.idOverlap, entry.medianDistM, entry.posMatch);
        if (sys.merged) entry.merged = sys.merged.added; // nur im Ersatz, zum Hauptfeed gezählt
        consistency.systems.push(entry); rec.consistency = entry.verdict;
      } catch (e) { consistency.systems.push({ sourceId: src.id, operator: src.operator, alt: { url: altUrl }, verdict: 'error', error: e.message }); }
    }, 6);
    // Mehrere Quellen je Anbieter × Gemeinde (vor der Dublettenbereinigung)
    const bySrc = new Map(); // `${op}|${ags}` → Map(sourceId → Set(ids))
    for (const v of ctx.allVehicles) { const k = `${v.operator}|${v.ags}`; if (!bySrc.has(k)) bySrc.set(k, new Map()); const m = bySrc.get(k); if (!m.has(v.sourceId)) m.set(v.sourceId, new Map()); m.get(v.sourceId).set(C.normalizeId(v.rawId), v); }
    for (const [k, m] of bySrc) {
      if (m.size < 2) continue;
      const [op, ags] = k.split('|');
      const srcs = [...m.entries()].filter(([, ids]) => ids.size >= 20).sort((a, b) => b[1].size - a[1].size);
      for (let i = 0; i < srcs.length; i++) for (let j = i + 1; j < srcs.length; j++) {
        const [idA, A] = srcs[i], [idB, B] = srcs[j];
        let common = 0; const dists = [];
        for (const [id, v] of A) { const w = B.get(id); if (!w) continue; common++; if (C.validLatLon(v.lat, v.lon) && C.validLatLon(w.lat, w.lon)) dists.push(C.haversineM(v.lat, v.lon, w.lat, w.lon)); }
        dists.sort((a, b) => a - b);
        const union = A.size + B.size - common;
        const pm = posMatch(A, B);
        consistency.pairs.push({ operator: op, ags, a: { sourceId: idA, vehicles: A.size }, b: { sourceId: idB, vehicles: B.size }, common, idOverlap: +(common / union).toFixed(3), posMatch: pm, idsRekeyed: common / union < 0.2 && (pm ?? 0) >= 0.7, medianDistM: dists.length ? Math.round(dists[Math.floor(dists.length / 2)]) : null, countDiff: +(Math.abs(A.size - B.size) / Math.max(A.size, B.size)).toFixed(3) });
      }
    }
    for (const pr of consistency.pairs) pr.verdict = judge(pr.countDiff, pr.idOverlap, pr.medianDistM, pr.posMatch);
    await writeFile(path.join(DATA, 'consistency.json'), JSON.stringify(consistency));
    const vc = {}; for (const e of consistency.systems) vc[e.verdict] = (vc[e.verdict] || 0) + 1;
    log(`Konsistenz: ${consistency.systems.length} Alternativ-Feeds ${JSON.stringify(vc)} · ${consistency.pairs.length} Quellenpaare je Anbieter×Gemeinde`);
  }
}
