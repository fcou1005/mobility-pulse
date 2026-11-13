// Sammler, Phase „dubletten“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import * as C from '../../lib/pulse-core.js';
import * as R from '../../lib/pulse-report.js';

export async function run(ctx) {
  const { areas, centroids, chargeThreshold, consistency, ghostKeys, log, muniInfo, munis, now, prev, rangeThreshold, sourceOut, vkey } = ctx;
  // ---------- Quellen-Dubletten: Zählquellen ohne Fahrzeugliste (CityBikes), deren Stationen ≤ 30 m neben gleichnamigen Stationen einer stärkeren Quelle liegen ----------
  // z. B. CityBikes „stadtrad-stuttgart“ = RegioRad Stuttgart (MobiData BW). Die Kopie bleibt in sources sichtbar (status duplicate), zählt aber nirgends.
  const dupOf = new Map(); // sourceId → Quelle, die stattdessen zählt
  ctx.dupOf = dupOf;
  {
    const recOf = new Map(sourceOut.map(r => [r.id, r]));
    const cp = C.findSourceCopies(ctx.allStations, sourceOut.filter(r => r.status === 'live' || r.status === 'delayed').map(r => ({ id: r.id, priority: r.priority, directories: r.directories, countOnly: r.countOnly })));
    const root = (id) => { const seen = new Set(); while (cp.has(id) && !seen.has(id)) { seen.add(id); id = cp.get(id).of; } return id; };
    for (const [id, c] of cp) {
      const r = recOf.get(id), of = root(id), o = recOf.get(of);
      dupOf.set(id, of); r.feedStatus = r.status; r.status = 'duplicate'; r.duplicateOf = of; r.duplicateShare = c.share; r.dupCheckedAt = now;
      if (o?.quality != null && r.quality != null && r.quality >= o.quality) r.quality = Math.max(0, o.quality - 1); // Kopie nie besser bewertet als das Original
    }
    for (const r of sourceOut) if (r.reused && r.status === 'duplicate' && r.duplicateOf) dupOf.set(r.id, r.duplicateOf);
    if (dupOf.size) log(`Quellen-Dubletten: ${[...dupOf].map(([a, b]) => `${a} → ${b}`).join(', ')}`);
  }
  ctx.allVehicles = ctx.allVehicles.filter(v => !dupOf.has(v.sourceId));
  ctx.allStations = ctx.allStations.filter(s => !dupOf.has(s.sourceId));
  ctx.snapshots = ctx.snapshots.filter(s => !dupOf.has(s.id));
  for (const x of [...ctx.allVehicles, ...ctx.allStations]) if (!munis.has(x.ags)) munis.set(x.ags, muniInfo.get(x.ags));
  // Dedupe über alle Quellen (je Anbieter)
  ctx.allVehicles.sort((a, b) => a.priority - b.priority);
  const dv = C.dedupeVehicles(ctx.allVehicles);
  ctx.dv = dv;
  // gleiche Fahrzeugnummer aus zwei Quellen (dedupeVehicles, zweite Stufe): Verlierer wie Spiegel-Zwillinge still aus dem Verfolgungszustand
  for (const { v, of } of dv.dropped || []) { ghostKeys.push(vkey(v.operator, v.rawId)); v.codeDupOf = of; }
  for (const v of [...dv.vehicles, ...(dv.dropped || []).map(d => d.v)]) delete v.code; // Nummer nur für den Abgleich, nirgends gespeichert
  // Spiegelquellen mit umgeschlüsselten Kennungen (consistency.pairs: idsRekeyed): schwächere Quelle je Gemeinde ganz bzw. räumliche Zwillinge
  // verwerfen (lib/pulse-core.js dropMirrorVehicles). Stärke: Priorität, direkte Quelle vor Manifest-Kind (MOBIDROM fiel in 14 von 44 Läufen aus),
  // nicht CityBikes, dann Kennung – bewusst ohne Fahrzeugzahl, damit der Sieger nicht von Lauf zu Lauf wechselt.
  // Verworfene Kennungen verlassen den Verfolgungszustand still (ghostKeys), sonst zählten sie beim Umstieg als Fahrtbeginne.
  ctx.mirrorsOut = []; // bekannte Spiegelpaare für den nächsten Lauf (latest.json → mirrors)
  ctx.mirrorHoldOut = []; // A19: Entscheid „ganze Quelle je Gemeinde“ mit Haltezeit (latest.json → mirrorHold)
  const mirrorInfo = new Map(); // verlierende Quelle → { of: Map(Sieger → n), ags: Set, n, why: Set }
  ctx.mirrorInfo = mirrorInfo;
  {
    const recOf = new Map(sourceOut.map(r => [r.id, r]));
    const rank = (id) => { const r = recOf.get(id) || {}; return [r.priority ?? 2, r.parent ? 1 : 0, (r.directories || []).includes('citybikes') ? 1 : 0]; };
    const extra = (prev?.mirrors || []).filter(m => recOf.has(m.of) && recOf.has(m.source) && now - (m.seen || 0) <= 7 * 86400e3); // bekannte Paare höchstens 7 Tage ohne neuen Beleg
    const mr = C.dropMirrorVehicles(dv.vehicles, { pairs: consistency.pairs, rank, extra, hold: Array.isArray(prev?.mirrorHold) ? prev.mirrorHold : [] });
    ctx.mirrorHoldOut = mr.hold || [];
    dv.vehicles = mr.vehicles;
    for (const { v, of, why } of [...(dv.dropped || []).map(d => ({ ...d, why: 'code' })), ...mr.dropped]) {
      const m = mirrorInfo.get(v.sourceId) || { of: new Map(), ags: new Set(), n: 0, why: new Set(), op: v.operator };
      m.n++; m.of.set(of, (m.of.get(of) || 0) + 1); m.ags.add(v.ags); m.why.add(why); mirrorInfo.set(v.sourceId, m);
      ghostKeys.push(vkey(v.operator, v.rawId));
    }
    dv.stats.mirrorDropped = mr.dropped.length; dv.stats.mirrorWhole = mr.dropped.filter(d => d.why === 'whole').length; dv.stats.mirrorTwins = mr.dropped.filter(d => d.why === 'twin').length;
    // Quelle ganz gespiegelt (kein Fahrzeug übrig): Status duplicate wie bei findSourceCopies (Feed-Status bleibt in feedStatus), sonst nur Angabe mirror
    const left = new Set(dv.vehicles.map(v => v.sourceId));
    for (const [id, m] of mirrorInfo) {
      const r = recOf.get(id); if (!r) continue;
      const of = [...m.of].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
      r.mirror = { of, ofAll: [...m.of.keys()].sort(), dropped: m.n, municipalities: [...m.ags].sort(), how: [...m.why].sort() };
      if (!left.has(id) && r.status !== 'duplicate') { r.feedStatus = r.status; r.status = 'duplicate'; r.duplicateOf = of; r.duplicateKind = 'rekeyed'; r.duplicateShare = null; dupOf.set(id, of); }
    }
    ctx.snapshots = ctx.snapshots.filter(s => !dupOf.has(s.id));
    const fresh = new Set([...C.mirrorPairs(consistency.pairs, C.compareSources(rank)).known.values()].map(k => `${k.op}|${k.winner}|${k.loser}`));
    ctx.mirrorsOut = mr.known.map(k => ({ operator: k.op, of: k.winner, source: k.loser, seen: fresh.has(`${k.op}|${k.winner}|${k.loser}`) ? now : extra.find(e => e.operator === k.op && [e.of, e.source].sort().join('|') === [k.winner, k.loser].sort().join('|'))?.seen ?? now }));
    if (mr.dropped.length) log(`Spiegelquellen (umgeschlüsselt): ${mr.dropped.length} Fahrzeuge verworfen (${dv.stats.mirrorWhole} ganze Quelle je Gemeinde, ${dv.stats.mirrorTwins} Zwillinge) aus ${mirrorInfo.size} Quellen`);
  }
  const ds = C.dedupeStations(ctx.allStations);
  ctx.ds = ds;
  log(`Fahrzeuge ${ctx.allVehicles.length} → ${dv.vehicles.length} (Dubletten ${dv.stats.duplicates}, gleiche Fahrzeugnummer ${dv.stats.codeDuplicates || 0}, Kennungs-Wiederverwendung ${dv.stats.reusedIds}, Spiegel ${dv.stats.mirrorDropped}); Stationen ${ctx.allStations.length} → ${ds.stations.length}`);
  // Aggregation: Gemeinde × Anbieter × Fahrzeugart
  const groups = C.aggregateGroups(dv.vehicles, ds.stations, { chargeThreshold, rangeThreshold });
  ctx.groups = groups;
  const groupsOut = {};
  ctx.groupsOut = groupsOut;
  for (const [k, v] of groups) groupsOut[k] = v;
  // Energie je Gruppe (Q-2): dieselbe Regel wie lib/pulse-report.js energyLow (Ladestand < 20 % UND Reichweite < 5 km, wo beides gemeldet; sonst die
  // gemeldete Angabe; Anbieter nur mit Reichweite über die Reichweite), Ladestand unplausibler Skala ist schon verworfen (C.batteryScaleCheck).
  // Reichweiten-Schwelle je Quelle: min(5 km, v.rangeLimitKm) (C.rangeLimitCheck: 20 % des 95. Perzentils, wenn dieses < 25 km); konstante Reichweite
  // der Quelle (v.rangeFlat, C.rangeFlatCheck) zählt nicht – ohne verwendbaren Ladestand ist die Energie dann unbekannt, nicht niedrig.
  // energyKnown = Fahrzeuge mit Energieangabe, energyLow = Energie niedrig, energyRangeOnly(Low) = davon nur über die Reichweite beurteilt,
  // ready = einsatzbereit (nicht gesperrt, nicht reserviert, Energieangabe vorhanden und nicht niedrig; wie R.readinessFromOps). Gesperrte zählen bei Energie mit.
  // Nur Reichweite: je Fahrzeug, wenn der Anbieter nirgends einen Ladestand meldet (R.rangeOnlyOperators) oder der Ladestand des Fahrzeugs nur aus
  // Reichweite ÷ Maximalreichweite abgeleitet ist (batteryDerived); bis 02.11.2026 machte eine einzige Quelle ohne Ladestand den ganzen Anbieter dazu
  const rangeOnlyOps = R.rangeOnlyOperators(sourceOut);
  ctx.rangeOnlyOps = rangeOnlyOps;
  // Gruppen ohne Fahrzeug mit Energieangabe tragen die Felder nicht (latest.energy gesetzt = fehlendes Feld bedeutet 0)
  for (const v of dv.vehicles) {
    const st = groups.get(`${v.ags}|${v.operator}|${v.type}`); if (!st) continue;
    const ro = rangeOnlyOps.has(v.operator) || !!v.batteryDerived, rd = !!v.rangeDerived && v.batteryPct != null, low = R.energyLow(v.batteryPct, v.rangeKm, { charge: chargeThreshold, range: C.rangeLowKm(v.type, rangeThreshold), rangeOnly: ro, rangeDerived: rd, rangeLimit: v.rangeLimitKm ?? null, rangeFlat: !!v.rangeFlat });
    if (low == null) continue;
    if (st.energyKnown == null) Object.assign(st, { energyKnown: 0, energyLow: 0, energyRangeOnly: 0, energyRangeOnlyLow: 0, ready: 0 });
    st.energyKnown++; if (low) st.energyLow++;
    if (!rd && (ro || v.batteryPct == null)) { st.energyRangeOnly++; if (low) st.energyRangeOnlyLow++; }
    if (!low && !v.disabled && !v.reserved) st.ready++;
  }
  // Gemeinde-Zusammenfassung (Anbieter vor Ort, Bestand) und Totals
  const muniOut = {};
  ctx.muniOut = muniOut;
  for (const [ags, m] of munis) {
    const ops = {};
    for (const [k, st] of groups) { const [a, op, ty] = k.split('|'); if (a !== ags) continue; ops[op] ??= { total: 0, available: 0, types: {} }; ops[op].total += st.total; ops[op].available += st.available; ops[op].types[ty] = st.total; }
    muniOut[ags] = { ...m, c: centroids.get(ags) || null, areaKm2: areas.get(ags) ?? null, operators: ops }; // c = [lat, lon] Flächenschwerpunkt, areaKm2 aus den Grenzen
  }
  // Betriebsgebiet-Erkennung (V.presenceOf): wo ein Anbieter wirklich fährt, aus den Tagesdateien der letzten 14 Tage und dem aktuellen Stand.
  // Vereinzelte Orte (ein verirrtes Fahrzeug, sporadisch ein, zwei E-Scooter am Rand) bleiben in den Daten, erscheinen aber nicht als eigenes Gebiet.
  ctx.presence = null;
}
