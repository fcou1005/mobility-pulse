// Sammler, Phase „akku“ (S6.5 Akku-Prognose, F15): läuft nach „verfolgung“. Lernt je Lauf Entladung, Verbrauch je Fahrt und Fahrten je
// Fahrzeugstunde (lib/pulse-akku-learn.js, Zustand privat in TRACK_DIR/akku-state.json.gz), legt abends die Prognose für morgen 8 Uhr ab und
// prüft sie morgens. Veröffentlicht (nur Kennzahlen, keine Kennungen):
//   akku/<AGS>.json      Modell je Anbieter|Art und Zonen (Zelle × Anbieter × Art): jetzt unter 20 %, bis 8 Uhr dazu, Median des Zeitpunkts
//                        (Gemeinden mit mindestens 20 Fahrzeugen mit Ladestand)
//   akku/bewertung.json  Trefferquote je Nacht (Selbstprüfung) und einmal am Tag der Rückblick auf die goldenen Tage (TRACK_DIR/golden)
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import * as A from '../../lib/pulse-akku.js';
import * as L from '../../lib/pulse-akku-learn.js';
import { cellOf, dayOf } from '../../lib/pulse-track-rules.js';
import * as SV from '../../lib/pulse-schema.js';

export const MIN_VEHICLES = 20, DROP_MAX = 50;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export async function run(ctx) {
  const { DATA, TRACK_DIR, now, log, dv, vkey, sourceOut } = ctx;
  if (!dv?.vehicles?.length || !vkey) return;
  try {
    const t0 = Date.now(), stFile = path.join(TRACK_DIR || path.join(DATA, 'track'), 'akku-state.json.gz');
    let st = null; try { st = existsSync(stFile) ? JSON.parse(gunzipSync(await readFile(stFile)).toString('utf8')) : null; } catch (e) { log('Akku-Zustand unlesbar, Neustart:', e.message); }
    if (st?.version !== L.AKKU_STATE_V) st = L.emptyAkkuState();
    if (st.method !== A.AKKU_METHOD) { if (st.method) log(`Akku-Prognose: Rechenstand ${st.method} → ${A.AKKU_METHOD}, Modell lernt neu`); st.g = {}; st.r = {}; st.backtest = null; st.method = A.AKKU_METHOD; }
    const floors = {}; for (const r of sourceOut || []) { const f = r.batteryFloor; if (f?.hides && Number.isFinite(f.p005)) floors[r.operator] = Math.max(floors[r.operator] ?? 0, f.p005); }
    const cur = L.snapFromVehicles(dv.vehicles, vkey);
    const lr = L.learnStep(st, ctx.akkuPrev?.snap || null, cur, { prevAt: ctx.akkuPrev?.at ?? null, now, floors });
    L.followForecast(st, cur);
    const ev = L.evaluateForecast(st, cur, now, { floors });
    if (ev) { st.nights = [...(st.nights || []), ev].slice(-L.LEARN.keepNights); log(ev.late ? `Akku-Prognose ${ev.day}: Prüfung verpasst (kein Lauf bis ${L.LEARN.evalUntilHour} Uhr)` : `Akku-Prognose ${ev.day}: ${ev.tp} von ${ev.tp + ev.fp} Vorhersagen getroffen, ${ev.fn} übersehen (getauscht ${ev.swapped}, unbekannt ${ev.unknown})`); }
    const M = L.modelsOf(st);
    const fc = L.storeForecast(st, cur, now, M); if (fc) log(`Akku-Prognose für ${new Date(fc.target).toISOString()} abgelegt: ${Object.keys(fc.items).length} Fahrzeuge mit 20–49 %`);
    // je Gemeinde: Modell und Zonen aus dem aktuellen Bestand (dieselbe Rechnung wie die Disposition)
    const byAgs = new Map();
    for (const v of dv.vehicles) { const bat = v.batteryDerived || !Number.isFinite(v.batteryPct) ? null : Math.round(v.batteryPct); if (bat == null || !v.ags) continue; let a = byAgs.get(v.ags); if (!a) byAgs.set(v.ags, a = []); a.push({ lat: v.lat, lon: v.lon, operator: v.operator, type: v.type || 'unknown', battery: bat, disabled: !!v.disabled, reserved: !!v.reserved }); }
    const dir = path.join(DATA, 'akku'); await mkdir(dir, { recursive: true });
    const written = new Set(); let zonesN = 0;
    const { target } = A.slotsUntil(now);
    for (const [ags, veh] of byAgs) {
      if (veh.length < MIN_VEHICLES) continue;
      const groups = {}; for (const v of veh) { const k = `${v.operator}|${v.type}`; if (!groups[k]) groups[k] = L.packModel(M(ags, v.operator, v.type)); }
      const doc = { schemaVersion: SV.SCHEMA.akku, ags, at: now, low: A.AKKU.low, targetHour: A.AKKU.targetHour, target, groupFields: A.AKKU_FIELDS, groups };
      const ff = A.fleetForecast(veh, doc, now, { cellOf });
      doc.zones = { fields: ['zelle', 'lat', 'lon', 'anbieter', 'art', 'jetzt_unter', 'bis_ziel', 'ab'], rows: ff.zones.map(z => [z.cell, r4(z.lat), r4(z.lon), z.op, z.type, z.nowLow, z.morning, z.cross]) };
      doc.totals = { known: ff.known, nowLow: ff.nowLow, morning: ff.morning };
      await writeFile(path.join(dir, `${ags}.json`), JSON.stringify(doc)); written.add(`${ags}.json`); zonesN += doc.zones.rows.length;
    }
    // Gemeinden ohne Bestand: Dateien schrittweise entfernen (Datenstand-Schutz zählt Dateien)
    const drop = (await readdir(dir)).filter(f => /^\d{8}\.json$/.test(f) && !written.has(f)).sort().slice(0, DROP_MAX);
    for (const f of drop) await rm(path.join(dir, f), { force: true });
    // Rückblick auf die goldenen Tage: einmal am Tag (nach 8 Uhr, dann ist die letzte Nacht vollständig)
    const today = dayOf(now), gd = TRACK_DIR ? path.join(TRACK_DIR, 'golden') : null;
    if (gd && existsSync(gd) && st.backtest?.day !== today && A.clockOf(now)[0] >= A.AKKU.targetHour) {
      const runs = [];
      for (const f of (await readdir(gd)).filter(x => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(x)).sort())
        for (const line of gunzipSync(await readFile(path.join(gd, f))).toString('utf8').split('\n')) if (line.trim()) { try { runs.push(JSON.parse(line)); } catch { /* Zeile kaputt */ } }
      const bt = L.backtestGolden(runs, { skipOps: [...(ctx.rangeOnlyOps || [])] });
      st.backtest = { day: today, at: now, skipOps: [...(ctx.rangeOnlyOps || [])], runs: bt.runs, from: bt.from, to: bt.to, floors: bt.floors, groups: [...new Set(runs.flatMap(r => Object.keys(r.groups || {})))].sort(), nights: bt.nights, total: bt.total };
      log(`Akku-Rückblick (goldene Tage, ${bt.runs} Läufe): ${bt.total.nights} Nächte, Treffer ${bt.total.precision == null ? '–' : `${(bt.total.precision * 100).toFixed(1)} %`}`);
    }
    const models = Object.fromEntries(Object.entries(st.g).map(([k, a]) => [k, [a[1] > 0 ? r4(a[0] / a[1]) : null, a[3] > 0 ? r4(a[2] / a[3]) : null, Math.round(a[1]), Math.round(a[3])]]));
    const evDoc = { schemaVersion: SV.SCHEMA.akku, at: now, method: A.AKKU_METHOD, low: A.AKKU.low, targetHour: A.AKKU.targetHour, eveningHour: A.AKKU.eveningHour, pCut: A.AKKU.pCut,
      rule: `Vorhersage „unter ${A.AKKU.low} % bis ${A.AKKU.targetHour} Uhr“ im ersten Lauf ab ${A.AKKU.eveningHour} Uhr für Fahrzeuge mit ${A.AKKU.low}–${L.LEARN.keepBelow - 1} %, geprüft im ersten Lauf ab ${A.AKKU.targetHour} Uhr; Treffer = getroffen ÷ vorhergesagt, Abdeckung = getroffen ÷ tatsächlich unter ${A.AKKU.low} %; getauscht (≥ ${L.LEARN.swapUp} Punkte mehr) und unbekannt (verschwunden über der Ausblend-Grenze) zählen nicht; Vergleich: Regel „heute Abend unter ${L.LEARN.baseRule} %“`,
      nights: (st.nights || []).map(n => (n.late ? { day: n.day, late: true } : n)), total: L.totalOf(st.nights), backtest: st.backtest || null,
      modelFields: ['drain_je_h', 'verbrauch_je_fahrt', 'standstunden', 'fahrten'], models, open: st.fc ? { day: st.fc.day, target: st.fc.target, n: Object.keys(st.fc.items).length } : null };
    await writeFile(path.join(dir, 'bewertung.json'), JSON.stringify(evDoc));
    if (TRACK_DIR) await writeFile(stFile, gzipSync(JSON.stringify(st)));
    log(`Akku-Prognose: ${written.size} Gemeinden, ${zonesN} Zonen${lr.learned ? `, gelernt aus ${lr.stays} Standzeiten und ${lr.trips} Fahrten` : ''} (${Date.now() - t0} ms)`);
  } catch (e) { log('Akku-Prognose:', e.message); }
}
