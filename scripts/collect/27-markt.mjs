// Sammler, Phase „markt“ (Sprint 7): Deutschland-Index (S7.1), Ereignis- und Preis-Wirkung (S7.2/S7.3), Expansions-Scout (S7.4),
// offene Daten-Pakete und Grafik der Woche (S7.5). Läuft nach „alarme“ und vor „datenvertraege“ (Reihenfolge in scripts/collect.mjs).
//  - index/<JJJJ-MM>.json, index/<JJJJ-MM>-<Art>.svg, offen/<JJJJ-MM>/: einmal, im ersten Lauf nach Monatsende (Vormonat aus archive/)
//  - index/laufend.json: laufender Monat (vorläufig), nur bei geänderten Zahlen neu
//  - grafik/<JJJJ>-W<KW>.svg: einmal je abgeschlossener Kalenderwoche, sobald mindestens 5 volle Tage im Archiv stehen
//  - markt/wirkung.json: je Lauf (Ereignisse aus forecast/series.json und ereignisse.json, Preisänderungen aus pricing-log.json und archive/)
//  - markt/scout.json: höchstens alle 20 Stunden (Gemeindegrenzen mit Einwohnern, Bestand aus latest.json)
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as K from '../../lib/pulse-markt.js';
import * as SV from '../../lib/pulse-schema.js';

const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });
const INDEX_SVG_TYPES = ['scooter', 'bike'];
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export async function run(ctx) {
  const { DATA, latest, log, now } = ctx;
  const t0 = Date.now(), rd = async (f) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null);
  const writeIfChanged = async (f, text) => { if (existsSync(f) && (await readFile(f, 'utf8')) === text) return false; await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, text); return true; };
  const notes = [];
  try {
    const today = DAY.format(new Date(now)), month = today.slice(0, 7), prev = K.prevMonth(month);
    const names = Object.fromEntries(Object.entries(latest?.municipalities || {}).map(([a, m]) => [a, m.name || a]));
    const arDir = path.join(DATA, 'archive'), arMonths = existsSync(arDir) ? (await readdir(arDir)).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)).sort() : [];
    const arch = {}; const archOf = async (m) => (m in arch ? arch[m] : (arch[m] = arMonths.includes(m) ? await rd(path.join(arDir, `${m}.json`)) : null));
    const merged = async (ms) => { const out = { fields: null, days: {} }; for (const m of ms) { const a = await archOf(m); if (a?.days) { out.fields = a.fields; Object.assign(out.days, a.days); } } return out; };

    // ---------- S7.1 Index und S7.5 Paket des Vormonats ----------
    const idxDir = path.join(DATA, 'index'), listFile = path.join(idxDir, 'index.json'), list = (await rd(listFile)) || { months: [] };
    if (!list.months.some(e => e.month === prev && e.complete) && (await archOf(prev))) {
      const before = await rd(path.join(idxDir, `${K.prevMonth(prev)}.json`));
      const idx = K.monthIndex(await archOf(prev), { month: prev, names, prev: before, complete: true });
      if (idx.rows.length) {
        await mkdir(idxDir, { recursive: true });
        await writeFile(path.join(idxDir, `${prev}.json`), JSON.stringify(SV.withSchema('markt', { ...idx, at: now })));
        for (const ty of INDEX_SVG_TYPES) if (idx.rows.some(r => r.type === ty)) await writeFile(path.join(idxDir, `${prev}-${ty}.svg`), K.indexSvg(idx, { type: ty }));
        const pk = K.openPackage(await archOf(prev), idx, { names, at: now }), pkDir = path.join(DATA, 'offen', prev);
        await mkdir(pkDir, { recursive: true }); for (const [f, text] of Object.entries(pk.files)) await writeFile(path.join(pkDir, f), text);
        const oList = (await rd(path.join(DATA, 'offen', 'index.json'))) || { packages: [] };
        oList.packages = [...oList.packages.filter(p => p.month !== prev), { month: prev, at: now, files: Object.keys(pk.files), rows: pk.rows }].sort((a, b) => (a.month < b.month ? 1 : -1));
        await writeFile(path.join(DATA, 'offen', 'index.json'), JSON.stringify(SV.withSchema('markt', oList)));
        list.months = [...list.months.filter(e => e.month !== prev), { month: prev, complete: true, at: now, days: idx.days.length, rows: idx.rows.length, svg: INDEX_SVG_TYPES.filter(ty => idx.rows.some(r => r.type === ty)) }].sort((a, b) => (a.month < b.month ? 1 : -1));
        await writeFile(listFile, JSON.stringify(SV.withSchema('markt', list)));
        notes.push(`Index und Daten-Paket ${prev} (${idx.rows.length} Zeilen)`);
      }
    }
    // laufender Monat (vorläufig)
    if (await archOf(month)) {
      const idx = K.monthIndex(await archOf(month), { month, names, prev: await rd(path.join(idxDir, `${prev}.json`)), complete: false });
      const { at: _a, ...old } = (await rd(path.join(idxDir, 'laufend.json'))) || {};
      const cur = SV.withSchema('markt', idx); if (JSON.stringify(old) !== JSON.stringify(cur)) { await mkdir(idxDir, { recursive: true }); await writeFile(path.join(idxDir, 'laufend.json'), JSON.stringify({ ...cur, at: now })); }
      if (!list.months.some(e => e.month === month)) { list.months = [{ month, complete: false }, ...list.months.filter(e => e.complete)]; await mkdir(idxDir, { recursive: true }); await writeFile(listFile, JSON.stringify(SV.withSchema('markt', list))); }
    }

    // ---------- S7.5 Grafik der Woche ----------
    const wd = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7, lastWeek = K.isoWeek(addDays(today, -wd - 1));
    const gDir = path.join(DATA, 'grafik'), gList = (await rd(path.join(gDir, 'index.json'))) || { weeks: [] };
    if (!gList.weeks.some(w => w.week === lastWeek)) {
      const days = K.weekDays(lastWeek), a = await merged([...new Set(days.map(d => d.slice(0, 7)).flatMap(m => [K.prevMonth(m), m]))]);
      const F = Object.fromEntries((a.fields || []).map((f, i) => [f, i])), full = days.filter(d => Object.values(a.days[d] || {}).some(r => K.fullDay(r, F))).length;
      if (full >= 5) {
        const g = K.weekGraphic(a, lastWeek, { names });
        await mkdir(gDir, { recursive: true }); await writeFile(path.join(gDir, `${lastWeek}.svg`), g.svg);
        gList.weeks = [{ week: lastWeek, theme: g.theme, title: g.title, file: `${lastWeek}.svg`, days: full, at: now }, ...gList.weeks].slice(0, 260);
        await writeFile(path.join(gDir, 'index.json'), JSON.stringify(SV.withSchema('markt', gList)));
        notes.push(`Grafik der Woche ${lastWeek}`);
      }
    }

    // ---------- S7.2/S7.3 Wirkung ----------
    const wFile = path.join(DATA, 'markt', 'wirkung.json'), wPrev = await rd(wFile);
    const series = await rd(path.join(DATA, 'forecast', 'series.json')), ev = (await rd(path.join(DATA, 'ereignisse.json')))?.ereignisse || [];
    const fresh = series ? K.eventEffects(series, ev, { today }) : [], keep = addDays(today, -K.WIRK.keepDays);
    const byKey = new Map((wPrev?.events || []).filter(e => e.day >= keep).map(e => [e.key, e])); for (const e of fresh) byKey.set(e.key, e);
    const changes = K.priceChanges(await rd(path.join(DATA, 'pricing-log.json')));
    const pMonths = [...new Set(changes.flatMap(c => [K.prevMonth(c.day.slice(0, 7)), c.day.slice(0, 7), addDays(c.day, 10).slice(0, 7)]))].filter(m => arMonths.includes(m));
    const srcMunis = Object.fromEntries((latest?.sources || []).filter(s => Array.isArray(s.municipalities)).map(s => [s.id, s.municipalities]));
    const prices = K.priceEffects(changes, await merged(pMonths), { srcMunis, today });
    const wDoc = { version: K.WIRK.version, events: [...byKey.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.key < b.key ? -1 : 1)), prices };
    const { at: _w, schemaVersion: _s, ...wOld } = wPrev || {};
    if (JSON.stringify(wOld) !== JSON.stringify(wDoc)) { await mkdir(path.dirname(wFile), { recursive: true }); await writeFile(wFile, JSON.stringify({ ...SV.withSchema('markt', wDoc), at: now })); }

    // ---------- S7.4 Expansions-Scout ----------
    const sFile = path.join(DATA, 'markt', 'scout.json'), sPrev = await rd(sFile);
    if (!sPrev || now - (sPrev.at || 0) > 20 * 3600e3) {
      let feats = ctx.boundaries?.features?.filter(f => f.properties?.pop != null) || [];
      if (!feats.length) { const bDir = path.join(DATA, 'boundaries'); for (const f of existsSync(bDir) ? (await readdir(bDir)).filter(x => /^[A-Z]{2}\.json$/.test(x)) : []) feats = feats.concat((await rd(path.join(bDir, f)))?.features || []); }
      const fleetOf = {}; for (const [k, g] of Object.entries(latest?.groups || {})) { const [a, , ty] = k.split('|'); if (ty === 'car') continue; fleetOf[a] = (fleetOf[a] || 0) + (g.total || 0); }
      if (feats.length) { const sc = K.scout(feats, fleetOf); await mkdir(path.dirname(sFile), { recursive: true }); await writeFile(sFile, JSON.stringify({ ...SV.withSchema('markt', sc), at: now })); notes.push(`Scout ${sc.rows.length} von ${sc.candidates} Gemeinden`); }
    }
    log(`Markt: ${fresh.length} Ereignis-Schätzungen, ${prices.filter(p => p.status === 'ok').length}/${prices.length} Preis-Schätzungen${notes.length ? `; ${notes.join(', ')}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) { log(`Markt: ${e.message}`); }
}
