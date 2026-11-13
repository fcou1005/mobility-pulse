// Sammler, Phase „betriebsgebiete“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';
import * as T from '../../lib/pulse-track.js';
import * as E from '../../lib/pulse-econ.js';
import * as V from '../../lib/pulse-coverage.js';
import * as SV from '../../lib/pulse-schema.js';

export async function run(ctx) {
  const { DATA, catalog, chargeThreshold, ds, dupOf, dv, fetchJson, groups, groupsOut, log, mirrorInfo, muniOut, munis, now, rangeOnlyOps, rangeThreshold, sourceOut } = ctx;
  try {
    const evDir0 = path.join(DATA, 'events'), cur = {};
    const files = existsSync(evDir0) ? (await readdir(evDir0)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-V.PRESENCE.windowDays) : [];
    const docs = []; for (const f of files) { try { docs.push(JSON.parse(await readFile(path.join(evDir0, f), 'utf8'))); } catch {} }
    for (const [k, st] of groups) { const [a, op] = k.split('|'); const c = (cur[`${a}|${op}`] ||= { vehicles: 0, stations: 0 }); c.vehicles += st.total || 0; c.stations += st.stations || 0; }
    ctx.presence = V.presenceOf(docs, cur);
    for (const [ags, m] of Object.entries(muniOut)) { const p = ctx.presence.byMuni[ags]; if (p) m.presence = { status: p.status, ops: p.ops }; }
    log(`Betriebsgebiete (${ctx.presence.days} Tage): ${Object.entries(ctx.presence.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  } catch (e) { log(`Betriebsgebiete: ${e.message} – ohne Einstufung`); }
  const totals = {};
  ctx.totals = totals;
  for (const [k, st] of groups) { const ty = k.split('|')[2]; totals[ty] ??= C.emptyStats(); for (const f of Object.keys(st)) totals[ty][f] = (totals[ty][f] || 0) + st[f]; }
  // Datenlücken (bekannte Betreiber ohne öffentliche Daten) prüfen
  const gaps = [];
  for (const gap of catalog.known_gaps || []) {
    const r = gap.probe_url ? await fetchJson(gap.probe_url) : null;
    gaps.push({ ...gap, probeStatus: r?.status ?? null, probeOk: !!r?.ok, checkedAt: now });
  }
  const statusCounts = {};
  ctx.statusCounts = statusCounts;
  ctx.runEv = null; // Ereignisse dieses Laufs (für runs.json)
  for (const s of sourceOut) statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
  // Fehler-Zähler: retired (> 14 Tage weg) und duplicate (Kopie einer anderen Quelle) sind keine Fehler
  const FAILING = ['error', 'gone', 'auth', 'unknown'];
  const failing = FAILING.reduce((a, k) => a + (statusCounts[k] || 0), 0);
  ctx.failing = failing;
  // Fehler nach Ursache (Quellen mit Status error/gone/auth/unknown): timeout, http404, http429, noJson, tooLarge, tls, dns, connection, redirect, noFeeds, other
  const errorCauses = {};
  for (const r of sourceOut) { if (!FAILING.includes(r.status)) continue; r.errorCause = C.errorCause(r.errors, r.httpStatus); errorCauses[r.errorCause] = (errorCauses[r.errorCause] || 0) + 1; }
  const latest = {
    schemaVersion: SV.SCHEMA.latest, at: now, generatedAt: new Date(now).toISOString(), runMs: Date.now() - now, catalogGeneratedAt: catalog.generatedAt, catalogFallback: catalog.catalogFallback || null,
    boundaries: ctx.boundaries ? { count: ctx.boundaries.features.length, attribution: ctx.boundaries.attribution, source: ctx.boundaries.source } : null,
    counts: { sources: sourceOut.length, byStatus: statusCounts, vehiclesRaw: ctx.allVehicles.length, vehicles: dv.vehicles.length, stationsRaw: ctx.allStations.length, stations: ds.stations.length, municipalities: munis.size, municipalitiesShown: ctx.presence ? Object.values(muniOut).filter(V.muniShown).length : munis.size, groups: groups.size, failing, errorCauses, retired: statusCounts.retired || 0, duplicates: statusCounts.duplicate || 0 },
    dedupe: { ...dv.stats, stationDuplicates: ds.duplicates, sourceDuplicates: dupOf.size, mirrorSources: mirrorInfo.size },
    thresholds: { chargeThreshold, rangeThreshold, rangeByType: C.TYPE_RANGE_LOW_KM },
    energy: { version: 1, fields: ['energyKnown', 'energyLow', 'energyRangeOnly', 'energyRangeOnlyLow', 'ready'], rangeOnlyOps: [...rangeOnlyOps].sort(), // Felder je groups-Eintrag (Q-2)
      rangeLimit: { ...C.RANGE_LIMIT, rule: 'Reichweite < min(rangeThreshold, sources[].rangeLimitKm); rangeLimitKm = share × 95. Perzentil der Reichweite der Quelle, wenn dieses < maxP95Km (ab minN Fahrzeugen), sonst null' },
      rangeFlat: { ...C.RANGE_FLAT, rule: 'Reichweite der Quelle konstant (Spanne p5–p95 < maxSpreadKm oder > maxModeShare gleiche Werte, ab minN Fahrzeugen): für Energie unbekannt (sources[].rangeFlat)' } },
    sources: sourceOut, municipalities: muniOut, groups: groupsOut, totals, gaps, mirrors: ctx.mirrorsOut, mirrorHold: ctx.mirrorHoldOut,
    ...(ctx.presence ? { presence: { version: 1, days: ctx.presence.days, rules: V.PRESENCE, counts: Object.fromEntries(Object.keys(ctx.presence.counts).map(k => [k, Object.values(muniOut).filter(m => m.presence?.status === k).length])), strayVehicles: Object.values(muniOut).filter(m => m.presence?.status === 'vereinzelt').reduce((s0, m) => s0 + Object.values(m.operators || {}).reduce((x, o) => x + (o.total || 0), 0), 0) } } : {}),
  };
  ctx.latest = latest;
  // Messbasis und Ampel aus dem veröffentlichten Stand der Ereignisse (vom vorigen Lauf): latest.json → measure.days[Tag] (Messminuten je
  // Stunde ohne Lücken, Läufe, Regelstände der gezählten Läufe, voller Tag; lib/pulse-econ.js measureDay; abgeschlossene Tage werden
  // übernommen) und → eventChecks (Selbsttest der Ereignisregeln je Gemeinde|Anbieter|Art am letzten vollständigen Tag, E.eventChecks).
  // eventChecks hier vorläufig; nach der Verfolgung neu (Quellenbefund idleUnusable steht erst dann fest, Regel idleUnusableWarn), mit dem
  // aktuellen Regelstand ruleNow: rot schließt nur aus, wenn der ausgewertete Tag ihn trägt (sonst gelb „älterer Regelstand“).
  ctx.ecInput = null; // Tagesdokument des letzten vollständigen Tags
  const ampel = () => { if (ctx.ecInput) latest.eventChecks = E.eventChecks(ctx.ecInput, sourceOut, E.EVENT_CHECKS, { ruleNow: T.METHOD_VERSION }); };
  ctx.ampel = ampel;
}
