// Sammler, Phase „preise-zonen“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';
import * as E from '../../lib/pulse-econ.js';
import * as TR from '../../lib/pulse-train.js';

export async function run(ctx) {
  const { DATA, fetchJson, log, now, pool, results, sourceOut } = ctx;
  // ---------- Preise und Betriebszonen (GBFS system_pricing_plans / geofencing_zones) ----------
  const pricing = [], zonesIndex = [];
  await mkdir(path.join(DATA, 'zones'), { recursive: true });
  const zonesIdxFile = path.join(DATA, 'zones', 'index.json');
  const prevZonesIdx = existsSync(zonesIdxFile) ? JSON.parse(await readFile(zonesIdxFile, 'utf8')) : null;
  const refreshStatic = !prevZonesIdx || (now - (prevZonesIdx.at || 0)) > 23 * 3600e3 || process.env.REFRESH_STATIC === '1';
  if (!refreshStatic) {
    log(`Preise/Zonen: Stand von ${new Date(prevZonesIdx.at).toISOString()} behalten (Aktualisierung täglich)`);
    for (const z of prevZonesIdx.zones || []) { const rec = sourceOut.find(x => x.id === z.sourceId); if (rec) rec.zones = { count: z.count, ...z.kinds }; }
  } else {
  // Zonenänderungen (zones-log.json): Fingerabdrücke des alten Stands je Quelle, bevor die Dateien neu geschrieben werden (lib/pulse-train.js zoneHash)
  const prevZoneFp = new Map(), zoneChanges = [];
  for (const f of await readdir(path.join(DATA, 'zones')).catch(() => [])) if (f.endsWith('.json') && f !== 'index.json') { try { const d = JSON.parse(await readFile(path.join(DATA, 'zones', f), 'utf8')); if (d?.sourceId && Array.isArray(d.features)) prevZoneFp.set(d.sourceId, new Set(d.features.map(TR.zoneHash))); } catch {} }
  for (const f of await readdir(path.join(DATA, 'zones')).catch(() => [])) if (f.endsWith('.json')) await rm(path.join(DATA, 'zones', f));
  const firstLang = (o) => o == null ? null : Array.isArray(o) ? (o.find(x => x?.language === 'de') || o[0])?.text ?? null : typeof o === 'object' ? (o.de ?? o.en ?? Object.values(o)[0] ?? null) : o;
  await pool(results.filter(r => r.sys && r.sys.feeds && ['live', 'delayed'].includes(sourceOut.find(x => x.id === r.src.id)?.status)), async ({ src, sys }) => { try {
    const rec = sourceOut.find(x => x.id === src.id);
    if (sys.feeds.system_pricing_plans) {
      const r = await fetchJson(sys.feeds.system_pricing_plans);
      const plans = r.json?.data?.plans || [];
      const out = plans.slice(0, 12).map(pl => {
        const perMin = (pl.per_min_pricing || []).map(x => ({ start: C.num(x.start), rate: C.num(x.rate), interval: C.num(x.interval), end: C.num(x.end) }));
        const perKm = (pl.per_km_pricing || []).map(x => ({ start: C.num(x.start), rate: C.num(x.rate), interval: C.num(x.interval), end: C.num(x.end) }));
        const cur = typeof pl.currency === 'string' && /^[A-Z]{3}$/.test(pl.currency) ? pl.currency : undefined; // nur ISO-4217-Kürzel, sonst weglassen (Schutz vor eingeschleustem Text)
        return { id: String(pl.plan_id ?? '').slice(0, 80), name: String(firstLang(pl.name) ?? '').slice(0, 120), currency: cur, unlock: C.num(pl.price), perMin, perKm, taxable: C.bool(pl.is_taxable), desc: String(firstLang(pl.description) || '').slice(0, 240), surge: C.bool(pl.surge_pricing) };
      });
      if (out.length) { pricing.push({ sourceId: src.id, operator: src.operator, municipalities: rec.municipalities, plans: out, at: now }); rec.pricingPlans = out.length; }
    }
    if (sys.feeds.geofencing_zones) {
      const r = await fetchJson(sys.feeds.geofencing_zones);
      const fc = r.json?.data?.geofencing_zones;
      if (fc?.features?.length) {
        const feats = fc.features.filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')).flatMap(f => { try { return [zoneFeature(f)]; } catch { return []; } });
        function zoneFeature(f) {
          const rules = (f.properties?.rules || []).map(ru => ({ rideAllowed: C.bool(ru.ride_allowed ?? ru.ride_start_allowed), rideThrough: C.bool(ru.ride_through_allowed), endAllowed: C.bool(ru.ride_end_allowed), maxSpeed: C.num(ru.maximum_speed_kph), parking: C.bool(ru.station_parking) }));
          const round = (c) => Array.isArray(c[0]) ? c.map(round) : [+(+c[0]).toFixed(5), +(+c[1]).toFixed(5)];
          const coords = round(f.geometry.coordinates);
          if (JSON.stringify(coords).includes('null')) throw new Error('ungültige Koordinaten');
          return { type: 'Feature', properties: { name: firstLang(f.properties?.name) || null, rules, start: f.properties?.start || null, end: f.properties?.end || null }, geometry: { type: f.geometry.type, coordinates: coords } };
        }
        const doc = JSON.stringify({ type: 'FeatureCollection', sourceId: src.id, operator: src.operator, at: now, globalRules: (r.json?.data?.global_rules || []).map(ru => ({ rideAllowed: C.bool(ru.ride_allowed ?? ru.ride_start_allowed), rideThrough: C.bool(ru.ride_through_allowed), maxSpeed: C.num(ru.maximum_speed_kph) })), features: feats });
        if (doc.length <= 3e6) {
          const file = `${src.id.replace(/[^\w.-]+/g, '_')}.json`;
          await writeFile(path.join(DATA, 'zones', file), doc);
          const kinds = { noRide: feats.filter(f => f.properties.rules.some(ru => ru.rideAllowed === false)).length, noThrough: feats.filter(f => f.properties.rules.some(ru => ru.rideThrough === false)).length, slow: feats.filter(f => f.properties.rules.some(ru => ru.maxSpeed != null)).length, noEnd: feats.filter(f => f.properties.rules.some(ru => ru.endAllowed === false)).length };
          zonesIndex.push({ sourceId: src.id, operator: src.operator, municipalities: rec.municipalities, file, count: feats.length, bytes: doc.length, kinds, at: now });
          if (prevZoneFp.has(src.id)) { const dz = TR.zoneDiff(prevZoneFp.get(src.id), feats.map(TR.zoneHash)); if (dz.added || dz.removed) zoneChanges.push([now, src.id, src.operator, dz.added, dz.removed, feats.length]); }
          rec.zones = { count: feats.length, ...kinds };
        } else rec.zones = { count: feats.length, tooLarge: true };
      }
    }
    } catch (e) { log(`Preise/Zonen ${src.id}: ${e.message}`); }
  }, 6);
  // Zonenänderungen protokollieren (180 Tage), Format wie pricing-log: [Zeitpunkt, Quelle, Anbieter, neu, entfallen, Zonen gesamt]
  if (refreshStatic) { const zf = path.join(DATA, 'zones-log.json'), zl = existsSync(zf) ? JSON.parse(await readFile(zf, 'utf8')) : { fields: ['at', 'sourceId', 'operator', 'added', 'removed', 'count'], changes: [] };
    zl.changes = [...(zl.changes || []), ...zoneChanges].filter(c => now - c[0] <= 180 * 86400e3); zl.updatedAt = now; zl.days = 180; await writeFile(zf, JSON.stringify(zl));
    if (zoneChanges.length) log(`Zonen geändert: ${zoneChanges.map(c => `${c[2]} ${c[1]} +${c[3]}/−${c[4]}`).slice(0, 8).join(', ')}`); }
  const prevPricing = existsSync(path.join(DATA, 'pricing.json')) ? JSON.parse(await readFile(path.join(DATA, 'pricing.json'), 'utf8')) : null;
  for (const p of prevPricing?.plans || []) for (const x of p.plans || []) if (!/^[A-Z]{3}$/.test(String(x.currency ?? ''))) delete x.currency; // Altbestand ohne Prüfung
  await writeFile(path.join(DATA, 'pricing.json'), JSON.stringify({ at: now, plans: pricing }));
  // Preisänderungs-Log (180 Tage): je Quelle/Tarif Zeitpunkt, Feld, alt, neu
  {
    const f = path.join(DATA, 'pricing-log.json');
    const log0 = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : { changes: [] };
    const ch = prevPricing ? E.pricingChanges(prevPricing, { plans: pricing }, now) : [];
    const changes = [...(log0.changes || []), ...ch].filter(c => now - c[0] <= 180 * 86400e3);
    await writeFile(f, JSON.stringify({ updatedAt: now, days: 180, fields: ['at', 'sourceId', 'operator', 'planId', 'field', 'old', 'new'], changes }));
    if (ch.length) log(`Preisänderungen: ${ch.length}`);
  }
  await writeFile(zonesIdxFile, JSON.stringify({ at: now, zones: zonesIndex }));
  log(`Preise: ${pricing.length} Quellen · Zonen: ${zonesIndex.length} Quellen`);
  }
  if (!existsSync(path.join(DATA, 'pricing-log.json'))) await writeFile(path.join(DATA, 'pricing-log.json'), JSON.stringify({ updatedAt: now, days: 180, fields: ['at', 'sourceId', 'operator', 'planId', 'field', 'old', 'new'], changes: [] }));
}
