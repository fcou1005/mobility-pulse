// Sammler, Phase „tokio“ (Reiter Vergleich, 28.11.2026): stationsgebundene Leihräder in Tokio (docomo bike share, HELLO CYCLING) aus den
// offenen GBFS-Feeds der ODPT (api-public.odpt.org, ohne Schlüssel, CC BY 4.0; Rechenlogik in lib/pulse-tokio.js). Je Lauf station_status
// beider Systeme (HELLO CYCLING rund 5 MB für ganz Japan), station_information höchstens alle 20 h (HELLO CYCLING rund 8 MB; es bleiben die Ports
// mit Adresse 東京都). Veröffentlicht:
//   tokio/index.json      Kennzahlen je System (Ports, Räder, freie Plätze, leer, voll), heutige Abgänge/Zugänge, vorhandene Tage
//   tokio/stationen.json  Ports (Lage, Plätze, Name)
//   tokio/stand.json      letzter Stand je Port (Räder, freie Plätze, Zustand); zugleich Vergleichsbasis des nächsten Laufs
//   tokio/<Tag>.json      Stunden in Ortszeit (JST): Summen über die Läufe (Räder, leere/volle Ports) und Abgänge/Zugänge zwischen zwei Läufen
// TOKIO_URL überschreibt die Basis der Feeds ('' = aus; Tests: Fixture-Server). Ein Fehler hier bricht den Lauf nicht ab.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import * as TK from '../../lib/pulse-tokio.js';
import * as SV from '../../lib/pulse-schema.js';

/** @param {any} ctx */
export async function run(ctx) {
  const { DATA, UA, log, now } = ctx;
  const base = (process.env.TOKIO_URL ?? TK.TOKIO.base).replace(/\/+$/, '');
  if (!base) return;
  const dir = path.join(DATA, 'tokio'), t0 = Date.now();
  /** @param {string} f */
  const rd = async (f) => { try { return JSON.parse(await readFile(path.join(dir, f), 'utf8')); } catch { return null; } };
  /** @param {string} f @param {any} doc */
  const wr = (f, doc) => writeFile(path.join(dir, f), JSON.stringify(SV.withSchema('tokio', doc)));
  /** @param {string} url */
  const get = async (url) => {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 60e3);
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json(); if (!Array.isArray(j?.data?.stations)) throw new Error('keine Stationsliste');
      return j;
    } finally { clearTimeout(timer); }
  };
  try {
    await mkdir(dir, { recursive: true });
    const [oldSt, oldStand, oldIx] = await Promise.all([rd('stationen.json'), rd('stand.json'), rd('index.json')]);
    // Ports: höchstens alle infoEveryH Stunden neu; scheitert der Abruf, bleiben die bisherigen
    const infoAt = { ...(oldSt?.at || {}) }, bySys = new Map();
    for (const r of oldSt?.rows || []) { let a = bySys.get(r[0]); if (!a) bySys.set(r[0], a = []); a.push(r.slice(1)); }
    /** @type {Record<string, any>} */
    const sysOut = {};
    for (const sys of TK.TOKIO.systems) {
      const o = sysOut[sys.id] = { id: sys.id, name: sys.name, operator: sys.operator, url: sys.url, license: sys.license, licenseUrl: sys.licenseUrl, feed: `${TK.TOKIO.base}/${sys.feed}/gbfs.json`, ok: false, error: null };
      if (oldSt?.version === TK.TOKIO.version && bySys.has(sys.id) && now - (infoAt[sys.id] || 0) < TK.TOKIO.infoEveryH * 3600e3) continue;
      try {
        const j = await get(`${base}/${sys.feed}/station_information.json`), rows = TK.tokyoStations(sys, j.data.stations);
        if (!rows.length) throw new Error('keine Ports in Tokio');
        bySys.set(sys.id, rows); infoAt[sys.id] = now;
      } catch (e) { o.error = `Ports: ${e.message}`; log(`Tokio ${sys.name}: Ports nicht gelesen (${e.message})${bySys.has(sys.id) ? ', bisherige bleiben' : ''}`); }
    }
    const stRows = TK.TOKIO.systems.flatMap(sys => (bySys.get(sys.id) || []).map(r => [sys.id, ...r]));
    await wr('stationen.json', { version: TK.TOKIO.version, at: infoAt, tz: TK.TOKIO.tz, fields: TK.STATION_FIELDS, rows: stRows });
    // Stand je Port; scheitert ein System, bleibt sein letzter Stand (mit altem Zeitpunkt, dann zählt der nächste Lauf keine Bewegungen)
    const standAt = { ...(oldStand?.at || {}) }, prevRows = oldStand?.rows || [], cur = [], fresh = new Set();
    for (const sys of TK.TOKIO.systems) {
      const known = new Set((bySys.get(sys.id) || []).map(r => r[0]));
      if (!known.size) continue;
      try {
        const j = await get(`${base}/${sys.feed}/station_status.json`), rows = TK.standRows(sys.id, j.data.stations, known);
        if (!rows.length) throw new Error('kein Port mit Stand');
        cur.push(...rows); standAt[sys.id] = now; fresh.add(sys.id); sysOut[sys.id].ok = true;
      } catch (e) {
        sysOut[sys.id].error = [sysOut[sys.id].error, `Stand: ${e.message}`].filter(Boolean).join('; '); log(`Tokio ${sys.name}: Stand nicht gelesen (${e.message})`);
        cur.push(...prevRows.filter(r => r[0] === sys.id && known.has(r[1])));
      }
    }
    await wr('stand.json', { version: TK.TOKIO.version, at: standAt, fields: TK.STAND_FIELDS, rows: cur });
    // Stunde des Laufs (Ortszeit); Bewegungen nur, wenn der vorige Stand des Systems höchstens maxGapMin alt ist
    const sum = TK.summarize(cur), mv = TK.moves(prevRows, cur), day = TK.jstDay(now), h = TK.jstHour(now);
    const dayDoc = (await rd(`${day}.json`)) || { version: TK.TOKIO.version, day, tz: TK.TOKIO.tz, fields: TK.HOUR_FIELDS, sys: {} };
    for (const id of fresh) {
      const s = sum[id]; if (!s) continue;
      const gapMin = (now - (oldStand?.at?.[id] || 0)) / 60e3, use = gapMin > 0 && gapMin <= TK.TOKIO.maxGapMin && mv[id];
      TK.addHour(dayDoc, id, h, { bikes: s.bikes, ports: s.ports, empty: s.empty, full: s.full, ...(use ? { out: mv[id].out, in: mv[id].in, min: Math.round(gapMin * 10) / 10 } : {}) });
      Object.assign(sysOut[id], s);
    }
    for (const sys of TK.TOKIO.systems) if (!fresh.has(sys.id) && sum[sys.id]) Object.assign(sysOut[sys.id], sum[sys.id], { stale: true });
    if (fresh.size) await wr(`${day}.json`, dayDoc);
    // alte Tage entfernen (höchstens keepDays Dateien)
    const days = (await readdir(dir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of days.slice(0, Math.max(0, days.length - TK.TOKIO.keepDays))) await rm(path.join(dir, f), { force: true });
    const kept = days.slice(-TK.TOKIO.keepDays).map(f => f.slice(0, 10));
    for (const sys of TK.TOKIO.systems) { sysOut[sys.id].at = standAt[sys.id] || null; sysOut[sys.id].today = TK.dayTotals(dayDoc, sys.id); }
    const tot = Object.values(sum).reduce((a, s) => { for (const k of ['ports', 'bikes', 'docks', 'empty', 'full', 'off']) a[k] += s[k]; return a; }, { ports: 0, bikes: 0, docks: 0, empty: 0, full: 0, off: 0 });
    await wr('index.json', { version: TK.TOKIO.version, at: now, tz: TK.TOKIO.tz, day, systems: TK.TOKIO.systems.map(s => sysOut[s.id]), totals: tot, days: kept, stationsAt: infoAt, firstDay: oldIx?.firstDay || day });
    log(`Tokio: ${tot.ports} Ports, ${tot.bikes} Räder, ${tot.empty} leer, ${tot.full} voll${Object.entries(mv).map(([k, m]) => `; ${k} ab ${m.out}/an ${m.in}`).join('')} (${Date.now() - t0} ms)`);
  } catch (e) { log('Tokio: Phase fehlgeschlagen:', e.message); }
}
