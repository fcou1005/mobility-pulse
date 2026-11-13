// Sammler, Phase „verfolgung“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';
import * as T from '../../lib/pulse-track.js';
import * as E from '../../lib/pulse-econ.js';
import * as R from '../../lib/pulse-report.js';
import * as SV from '../../lib/pulse-schema.js';
import { gzipSync, gunzipSync } from 'node:zlib';

export async function run(ctx) {
  const { DATA, HISTORY_DAYS, RULE, TRACK_DIR, addCheck, ampel, ds, dv, ghostKeys, groups, latest, log, now, sourceOut, totals, vkey } = ctx;
  // ---------- Fahrzeug-Verfolgung: Zustand lesen (ggf. auf gesalzene Schlüssel umziehen) und Lauf auswerten ----------
  // Vor dem Verlauf, damit die Tagesdatei das Lauf-Flag (Lücke) mitführt.
  const readState = async (f) => { if (!existsSync(f)) return null; try { return JSON.parse(gunzipSync(await readFile(f)).toString('utf8')); } catch (e) { log('Track-Zustand unlesbar, Neustart:', e.message); return null; } };
  ctx.readState = readState;
  const stateFile = TRACK_DIR ? path.join(TRACK_DIR, 'state.json.gz') : path.join(DATA, 'track', 'state.json.gz');
  ctx.stateFile = stateFile;
  let prevState = await readState(stateFile);
  // ungesalzener Zustand im Cache oder anderer Salt: wie fehlend behandeln (Umzug aus out/track bzw. Neustart)
  if (TRACK_DIR && prevState && (!prevState.salted || prevState.keyId !== ctx.keyId)) { log('Track-Zustand passt nicht zum Salt – verworfen'); prevState = null; }
  let migrated = false;
  if (TRACK_DIR && !prevState) {
    const old = await readState(path.join(DATA, 'track', 'state.json.gz'));
    if (old?.v && !old.salted) { const mig = T.migrateState(old, dv.vehicles, (op, id) => T.vehicleKey(op, id), vkey); prevState = mig.state; migrated = true; log(`Track-Zustand umgezogen: ${mig.moved} Fahrzeuge übernommen, ${mig.dropped} verworfen (Lauf zählt keine Ereignisse)`); }
  }
  if (prevState?.v) for (const k of ghostKeys) delete prevState.v[k]; // verschwinden still, keine Abholung
  // Umzugslauf zählt nichts: verworfene alte Einträge (ohne aktuelle Kennung nicht umschlüsselbar) würden sonst Fahrtenden ohne Beginn erzeugen
  const tr = T.trackRun(prevState, { vehicles: dv.vehicles, stations: ds.stations, sourceRecs: sourceOut.map(r => ({ id: r.id, status: r.status, feedStatus: r.feedStatus || null, latencyMs: r.latencyMs, batteryFloor: r.batteryFloor?.hides ? r.batteryFloor.p005 : null })), now, hmac: ctx.hmac, noEvents: migrated });
  ctx.tr = tr;
  if (ctx.keyId) tr.state.keyId = ctx.keyId;
  // Goldene Tage (Sprint 1, P3): Rohstände je Lauf für wenige Gruppen privat im Cache (TRACK_DIR/golden/<Tag>.jsonl.gz), Kennungen gesalzen
  // (HMAC, gekürzt), GOLDEN_DAYS Tage (Vorgabe 14 – der Cache wird je Lauf gesichert; 30 Tage wären ~100 MB). Grundlage, um Regeländerungen
  // an echten Läufen exakt nachzurechnen (Erwartungswert: Ausgabe des geltenden Regelstands). GOLDEN='' = aus; nie veröffentlicht.
  if (TRACK_DIR && ctx.hmac && (process.env.GOLDEN ?? 'Dott|08111000,Lime|08111000,nextbike|05315000') !== '') {
    try {
      const want = new Set((process.env.GOLDEN ?? 'Dott|08111000,Lime|08111000,nextbike|05315000').split(',').map(x => x.trim()).filter(Boolean));
      const rows = {}; for (const v of dv.vehicles) { const g = `${v.operator}|${v.ags}`; if (!want.has(g) || !C.validLatLon(v.lat, v.lon)) continue;
        (rows[g] ??= []).push([vkey(v.operator, v.rawId).slice(0, 12), +v.lat.toFixed(5), +v.lon.toFixed(5), Number.isFinite(v.batteryPct) ? Math.round(v.batteryPct) : null, (v.disabled ? 1 : 0) | (v.reserved ? 2 : 0), v.type, v.sourceId, v.stationId ?? null]); }
      const gd = path.join(TRACK_DIR, 'golden'), gf = path.join(gd, `${T.dayOf(now)}.jsonl.gz`); await mkdir(gd, { recursive: true });
      const old = existsSync(gf) ? gunzipSync(await readFile(gf)).toString('utf8') : '';
      await writeFile(gf, gzipSync(old + JSON.stringify({ at: now, fields: ['key', 'lat', 'lon', 'bat', 'flags', 'type', 'source', 'station'], status: Object.fromEntries(sourceOut.filter(r => [...want].some(g => g.startsWith(`${r.operator}|`))).map(r => [r.id, r.status])), groups: rows }) + '\n'));
      const keepDays = Math.max(1, +(process.env.GOLDEN_DAYS || 14)), keep = new Set([...Array(keepDays).keys()].map(i => `${T.dayOf(now - i * 86400e3)}.jsonl.gz`));
      for (const x of await readdir(gd)) if (!keep.has(x)) await rm(path.join(gd, x), { force: true });
    } catch (e) { log('Goldene Tage nicht geschrieben:', e.message); }
  }
  // Schattenbetrieb (Sprint 1, P4): Kandidat lib/pulse-track-next.js rechnet denselben Lauf mit eigenem Zustand (privat im Cache). Veröffentlicht
  // wird nur shadow/diff-<Tag>.json: Tagessummen je Gemeinde|Anbieter|Art geltend gegen Kandidat, Moduswechsel je Quelle. SHADOW=0 = aus.
  // Abgelöst wird erst nach 7 vollen Tagen im Schatten mit bestandenem Prüfstand (test/algo-next.test.mjs), dann neue METHOD_VERSION.
  if (TRACK_DIR && process.env.SHADOW !== '0') {
    try {
      const TN = await import('../../lib/pulse-track-next.js'), t0 = Date.now();
      const sf = path.join(TRACK_DIR, 'shadow-state.json.gz');
      let sp = await readState(sf); if (sp && (!sp.salted || sp.keyId !== ctx.keyId)) sp = null;
      if (sp?.v) for (const k of ghostKeys) delete sp.v[k];
      const trN = TN.trackRun(sp, { vehicles: dv.vehicles, stations: ds.stations, sourceRecs: sourceOut.map(r => ({ id: r.id, status: r.status, feedStatus: r.feedStatus || null, latencyMs: r.latencyMs, batteryFloor: r.batteryFloor?.hides ? r.batteryFloor.p005 : null })), now, hmac: ctx.hmac, noEvents: migrated });
      if (ctx.keyId) trN.state.keyId = ctx.keyId;
      await writeFile(sf, gzipSync(JSON.stringify(trN.state)));
      const SF = ['start', 'end', 'reloc', 'swap', 'pickup', 'hide', 'rot', 'slow', 'fast'], dir = path.join(DATA, 'shadow'), f = path.join(dir, `diff-${tr.day}.json`);
      await mkdir(dir, { recursive: true });
      let doc = null; try { doc = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null; } catch {}
      if (!doc || doc.rule !== TN.METHOD_VERSION || doc.base !== T.METHOD_VERSION) doc = { version: 1, day: tr.day, base: T.METHOD_VERSION, rule: TN.METHOD_VERSION, fields: SF, note: 'Tagessummen je Gemeinde|Anbieter|Art: [geltend, Kandidat] je Feld; Läufe nur, wenn beide zählten', runs: 0, groups: {}, modeChanges: [] };
      if (!trN.gap && !tr.first && !trN.first) { // auch Lückenläufe, die der Kandidat schätzt (A22): geltend zählt dort 0
        doc.runs++; if (trN.gapEstimated) doc.gapRuns = (doc.gapRuns || 0) + 1;
        const add = (hourly, i) => { for (const [k, h] of hourly) { const row = (doc.groups[k] ??= SF.map(() => [0, 0])); SF.forEach((fl, j) => { row[j][i] += (h[fl] || []).reduce((x, y) => x + (y || 0), 0); }); } };
        add(tr.hourly, 0); add(trN.hourly, 1);
      }
      for (const [src, o, n, r] of trN.modeChanges || []) doc.modeChanges.push([now, src, o, n, r]);
      // A3: Dauer-Intervalle stabiler Fahrten je Art und Lognormal-Schätzung; A7: Umrechnungsfaktor je Reihe (Kandidat ÷ geltend)
      for (const [ty, o] of Object.entries(trN.durSpans || {})) { const d = ((doc.durSpans ??= {})[ty] ??= {}); for (const [k, n] of Object.entries(o)) d[k] = (d[k] || 0) + n; }
      doc.durEst = Object.fromEntries(Object.entries(doc.durSpans || {}).map(([ty, o]) => [ty, E.durationFromSpans(o)]).filter(([, v]) => v).map(([ty, v]) => [ty, { mean: +v.mean.toFixed(2), median: +v.median.toFixed(2), n: v.n }]));
      doc.factors = R.shadowFactors(doc);
      const diffModes = Object.entries(trN.srcModes || {}).filter(([src, m]) => tr.srcModes?.[src] !== m).map(([src, m]) => [src, tr.srcModes?.[src] ?? null, m]);
      doc.modes = diffModes; doc.updatedAt = new Date(now).toISOString();
      await writeFile(f, JSON.stringify(doc));
      const keep = new Set([...Array(21).keys()].map(i => `diff-${T.dayOf(now - i * 86400e3)}.json`));
      for (const x of await readdir(dir)) if (/^diff-\d{4}-\d{2}-\d{2}\.json$/.test(x) && !keep.has(x)) await rm(path.join(dir, x), { force: true });
      const st = (hourly) => [...hourly.values()].reduce((a, h) => a + h.start.reduce((x, y) => x + y, 0), 0);
      log(`Schatten (${TN.METHOD_VERSION}): ${Date.now() - t0} ms, Fahrtbeginne ${st(tr.hourly)} geltend / ${st(trN.hourly)} Kandidat, ${diffModes.length} Quellen mit anderem Modus, ${(trN.modeChanges || []).length} Moduswechsel`);
    } catch (e) { log('Schatten fehlgeschlagen (ohne Wirkung auf die Veröffentlichung):', e.message); }
  }
  // Standzeit unbrauchbar (T.IDLE_CHECK, Z5: ≥ 200 Fahrzeuge, > 50 % unter einem Laufintervall – Kennung wechselt je Lauf): sources[].idleUnusable, Befund in
  // der Feed-Prüfung, ops-Feld 8 null; latest.json ist vor der Verfolgung geschrieben und wird dann neu geschrieben
  {
    let n = 0;
    for (const rec of sourceOut) { const u = tr.idleUnusable?.[rec.id]; if (!u) continue; rec.idleUnusable = true; rec.idleCheck = { n: u.n, shortShare: u.share }; addCheck(rec, `Standzeit unbrauchbar (${Math.round(u.share * 100)} % kürzer als ein Laufintervall): nicht ausgewiesen`, u.n); n++; }
    // Ampel erst jetzt mit dem Befund idleUnusable (bis 02.11.2026 vor der Verfolgung berechnet: Regel idleUnusableWarn griff nie); Fehler brechen den Lauf nicht ab
    let ec = false;
    try {
      if (ctx.ecInput) { ampel(); ec = true; const g = Object.values(latest.eventChecks?.groups || {});
        if (g.length) log(`Ampel ${latest.eventChecks.day} (Regelstand ${latest.eventChecks.dayRules.join(' + ') || 'ohne Angabe'}${latest.eventChecks.ruleCurrent ? '' : `, älter als ${T.METHOD_VERSION}: rot nur als Hinweis`}): ${g.filter(x => x.level === 'bad').length} rot, ${g.filter(x => x.level === 'warn').length} gelb von ${g.length} Gruppen`); }
    } catch (e) { log(`Ampel: ${e.message}`); }
    // Carsharing: Anbieter mit messbaren Fahrten (T.CAR_TRIPS; übrige nur Bestand) – Dashboard und Prognose
    if (tr.carTrips) latest.carTrips = { ...tr.carTrips, note: 'unmeasurable = Buchungen im Feed nicht sichtbar (jedes Auto immer verfügbar): keine Fahrten, nur Bestand' };
    if (n || ec || tr.carTrips) await writeFile(path.join(DATA, 'latest.json'), JSON.stringify(latest));
    if (n) log(`Standzeit unbrauchbar: ${Object.keys(tr.idleUnusable).join(', ')}`);
  }
  if (tr.gap) log(migrated ? 'Umzugslauf – Ereignisse dieses Laufs zählen nicht' : `Lücke: ${Math.round(tr.dt / 60e3)} Min seit dem letzten Lauf – Ereignisse dieses Laufs zählen nicht`);
  // Verlauf (spaltenweise je Tag); f je Lauf: 1 = zählt, 0 = Lauf nach Lücke (Vertrag 5/6), null = unbekannt (ältere Läufe)
  const day = T.dayOf(now); // Tagesschnitt wie Ereignisse/Zellen in Europe/Berlin (bis 01.11.2026 in UTC)
  const histFile = path.join(DATA, 'history', `${day}.json`);
  const hist = existsSync(histFile) ? JSON.parse(await readFile(histFile, 'utf8')) : { day, t: [], series: {} };
  ctx.hist = hist;
  const FIELDS = ['total', 'available', 'disabled', 'lowBattery', 'batteryKnown', 'stations', 'stationsEmpty', 'stationBookable', 'stationsEmptyDock'];
  const n = hist.t.length;
  hist.t.push(now);
  hist.f = hist.f || new Array(n).fill(null);
   hist.f.push(tr.gap ? 0 : 1);
  const serOf = (key) => { const ser = (hist.series[key] ??= {}); for (const f of FIELDS) ser[f] ??= new Array(n).fill(null); return ser; }; // neue Felder in alten Tagesdateien mit null auffüllen
  for (const key of Object.keys(hist.series)) if (!groups.has(key) && !key.startsWith('DE||')) { const ser = serOf(key); for (const f of FIELDS) ser[f].push(null); }
  for (const [key, st] of groups) { if (key.startsWith('DE||')) continue; const ser = serOf(key); for (const f of FIELDS) ser[f].push(st[f]); } // DE-Summen nur einmal (unten aus totals), sonst doppelt je Lauf
  for (const key of Object.keys(hist.series)) if (key.startsWith('DE||') && !totals[key.slice(4)]) { const ser = serOf(key); for (const f of FIELDS) ser[f].push(null); }
  for (const ty of Object.keys(totals)) { const ser = serOf(`DE||${ty}`); for (const f of FIELDS) ser[f].push(totals[ty][f]); }
  hist.fields = FIELDS;
  await writeFile(histFile, JSON.stringify(SV.withSchema('history', hist)));
  // alte Tage entfernen
  const days = (await readdir(path.join(DATA, 'history'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of days.slice(0, Math.max(0, days.length - HISTORY_DAYS))) await rm(path.join(DATA, 'history', f));
  const histDays = (await readdir(path.join(DATA, 'history'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
  await writeFile(path.join(DATA, 'history', 'index.json'), JSON.stringify({ schemaVersion: SV.SCHEMA.history, days: histDays, fields: FIELDS, updatedAt: now }));
  // Tagesmittel über mehrere Tage (Vertrag 6): je Schlüssel und Tag [available, total, disabled, lowBattery, Läufe]; Läufe mit Flag 0 nicht im Mittel.
  // Frühere Tage werden aus der vorhandenen daily.json übernommen, nur der aktuelle Tag (und fehlende) neu gerechnet.
  {
    const DAILY = ['available', 'total', 'disabled', 'lowBattery', 'stations', 'stationsEmptyDock'];
    const dailyFile = path.join(DATA, 'history', 'daily.json');
    const prevDaily = existsSync(dailyFile) ? JSON.parse(await readFile(dailyFile, 'utf8')) : { days: [], series: {} };
    const useDays = histDays.slice(-30);
    const series = {}, dayRuns = {}; // dayRuns: zählende Läufe je Tag (Präsenz einer Gruppe = Läufe mit Wert ÷ dayRuns, lib/pulse-report.js histStats)
    const dayRows = (h) => { // Map key → Zeile
      const flags = h.f || [], runs = h.t.length;
      let use = [...Array(runs).keys()].filter(i => flags[i] !== 0); if (!use.length) use = [...Array(runs).keys()]; // Tag nur mit Lücken-Läufen: alle
      const out = new Map(); out.runs = use.length;
      for (const [key, ser] of Object.entries(h.series)) {
        const idx = use.filter(i => ser.total?.[i] != null); if (!idx.length) continue;
        // Mittel je Feld über die Läufe mit Wert (stationsEmptyDock fehlt in älteren Tagen → null)
        out.set(key, [...DAILY.map(f => { const xs = idx.filter(i => ser[f]?.[i] != null); return xs.length ? +(xs.reduce((a, i) => a + ser[f][i], 0) / xs.length).toFixed(1) : null; }), idx.length]);
      }
      return out;
    };
    for (const d of useDays) {
      const reuse = d !== day && prevDaily.days.includes(d) && JSON.stringify(prevDaily.fields) === JSON.stringify([...DAILY, 'runs']); // nur bei gleichem Feldaufbau übernehmen
      if (reuse && (prevDaily.dayRuns?.[d] != null || !existsSync(path.join(DATA, 'history', `${d}.json`)))) { for (const [key, byDay] of Object.entries(prevDaily.series)) if (byDay[d]) (series[key] ??= {})[d] = byDay[d]; if (prevDaily.dayRuns?.[d] != null) dayRuns[d] = prevDaily.dayRuns[d]; continue; }
      const h = d === day ? hist : JSON.parse(await readFile(path.join(DATA, 'history', `${d}.json`), 'utf8'));
      const rows = dayRows(h); dayRuns[d] = rows.runs;
      for (const [key, row] of rows) (series[key] ??= {})[d] = row;
    }
    // Bruchmarken (Z2, lib/pulse-report.js ruleBreaks): breaks { 'Gemeinde|Anbieter|Art': erster Tag mit neuem Regelstand }, wenn der Bestand
    // beim ersten Lauf mit neuem Regelstand (Teil vor „@“, Läufe aus runs.json, dieser Lauf mit RULE) um ≥ 10 % und ≥ 5 Fahrzeuge springt.
    // Ohne breaks in der vorigen daily.json einmal rückwirkend über alle Läufe von runs.json, danach nur Wechsel seit deren updatedAt; Marken bleiben im 30-Tage-Fenster.
    const breaks = Object.fromEntries(Object.entries(prevDaily.breaks || {}).filter(([, d]) => d >= (useDays[0] || '')));
    try {
      const rf = path.join(DATA, 'runs.json');
      const rl = existsSync(rf) ? (JSON.parse(await readFile(rf, 'utf8')).runs || []).map(r => [r[0], r[14] ?? null]) : [];
      rl.push([now, RULE]); rl.sort((a, b) => a[0] - b[0]);
      const since = prevDaily.breaks ? prevDaily.updatedAt ?? null : null;
      const era = (r) => R.ruleEra([r[0], null, null, r[1]]), need = new Set();
      for (let i = 1; i < rl.length; i++) if (era(rl[i]) !== era(rl[i - 1]) && (since == null || rl[i][0] > since)) { need.add(T.dayOf(rl[i - 1][0])); need.add(T.dayOf(rl[i][0])); }
      const hs = []; for (const d of need) { if (d === day) hs.push(hist); else if (existsSync(path.join(DATA, 'history', `${d}.json`))) hs.push(JSON.parse(await readFile(path.join(DATA, 'history', `${d}.json`), 'utf8'))); }
      const found = hs.length ? R.ruleBreaks(rl, hs, { since }) : {};
      if (Object.keys(found).length) log(`Bruchmarken: ${Object.keys(found).length} Reihen (${[...new Set(Object.values(found))].join(', ')})`);
      Object.assign(breaks, found);
    } catch (e) { log('Bruchmarken:', e.message); }
    await writeFile(dailyFile, JSON.stringify({ days: useDays, fields: [...DAILY, 'runs'], updatedAt: now, series, dayRuns, breaks }));
  }
}
