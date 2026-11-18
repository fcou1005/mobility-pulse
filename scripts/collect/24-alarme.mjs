// Sammler, Phase „alarme“ (S5.2, F3): Ereignisse je Gemeinde aus dem Vergleich mit dem vorigen Lauf (lib/pulse-alarme.js) → auflagen/alarme.json
// und Atom-Feeds feeds/<AGS>.xml (alle Themen) und feeds/<AGS>-<Thema>.xml. Feeds werden nur neu geschrieben, wenn sich ihr Inhalt ändert.
// Optional Push über ntfy (NTFY_TOPIC, z. B. aus einer Repository-Variable im Workflow): höchstens 20 neue Alarme je Lauf.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as AL from '../../lib/pulse-alarme.js';
import * as BR from '../../lib/pulse-briefing.js';
import * as CX from '../../lib/pulse-context.js';
import { dayOf, hourOf } from '../../lib/pulse-track.js';
import * as SV from '../../lib/pulse-schema.js';

const BASE = 'https://fcou1005.github.io/mobility-pulse/', DATA_BASE = 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/';
const FEED_DROP_MAX = 600;

export async function run(ctx) {
  const { DATA, latest, log, now } = ctx;
  try {
    const rd = async (f) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null);
    const logFile = path.join(DATA, 'auflagen', 'alarme.json');
    const prev = await rd(logFile).catch(() => null);
    const pricing = await rd(path.join(DATA, 'pricing.json')).catch(() => null);
    const munis = latest?.municipalities || {};
    const name = (ags) => munis[ags]?.name || ags;
    const cur = AL.snapshot({ latest, caps: ctx.caps || null, pricing, pt: ctx.ptNow || null });
    const fresh = AL.detect(prev?.state || null, cur, { now, muniName: name });
    AL.carryPriceSeen(prev?.state || null, cur, now);
    const doc = SV.withSchema('auflagen', AL.updateLog(prev, fresh, { now, state: cur }));
    await mkdir(path.join(DATA, 'auflagen'), { recursive: true });
    await writeFile(logFile, JSON.stringify(doc));
    if (fresh.length) log(`Alarme: ${fresh.length} neu (${AL.KINDS.map(k => [k, fresh.filter(x => x.kind === k).length]).filter(x => x[1]).map(([k, n]) => `${AL.KIND_DE[k]} ${n}`).join(', ')})`);
    // Feeds je Gemeinde mit mindestens einer Quelle; „since“ = erster Lauf mit Feeds (fester Wert, damit leere Feeds stabil bleiben)
    await mkdir(path.join(DATA, 'feeds'), { recursive: true });
    const since = prev?.feedsSince || now; doc.feedsSince = since; await writeFile(logFile, JSON.stringify(doc));
    // Feeds für Gemeinden mit mindestens 20 Fahrzeugen, amtlicher Obergrenze oder einem Alarm im Protokoll (sonst > 7.000 Dateien für Kleinstorte)
    const fleet = {}; for (const [k, g] of Object.entries(latest?.groups || {})) { const a = k.split('|')[0]; fleet[a] = (fleet[a] || 0) + (g.total || 0); }
    const capped = new Set((ctx.caps || []).map(c => c.ags)), alarmed = new Set(doc.items.map(x => x.ags));
    const agsList = Object.keys(munis).filter(a => /^\d{8}$/.test(a) && ((fleet[a] || 0) >= 20 || capped.has(a) || alarmed.has(a))).sort();
    let written = 0;
    for (const ags of agsList) for (const kind of [null, ...AL.KINDS]) {
      const f = path.join(DATA, 'feeds', `${ags}${kind ? `-${kind}` : ''}.xml`);
      const xml = AL.atomFeed({ ags, name: name(ags), kind, items: doc.items, base: BASE, dataBase: DATA_BASE, since });
      if (existsSync(f) && (await readFile(f, 'utf8')) === xml) continue;
      await writeFile(f, xml); written++;
    }
    await writeFile(path.join(DATA, 'feeds', 'index.json'), JSON.stringify({ at: since, kinds: AL.KINDS, municipalities: agsList }));
    // Feeds von Gemeinden, die nicht mehr dazugehören, entfernen – höchstens 600 je Lauf: der Datenstand-Schutz (scripts/data-guard.mjs)
    // bricht ab, wenn ein Lauf weniger als 90 % der bisherigen Dateien hat (rund 13.600 Dateien → Abbau über mehrere Läufe)
    const keep = new Set(agsList), drop = (await readdir(path.join(DATA, 'feeds'))).filter(f => { const m = /^(\d{8})(?:-[a-z]+)?\.xml$/.exec(f); return m && !keep.has(m[1]); }).sort();
    for (const f of drop.slice(0, FEED_DROP_MAX)) await rm(path.join(DATA, 'feeds', f));
    if (drop.length) log(`Feeds: ${Math.min(drop.length, FEED_DROP_MAX)} Dateien kleiner Gemeinden entfernt${drop.length > FEED_DROP_MAX ? `, ${drop.length - FEED_DROP_MAX} folgen in den nächsten Läufen` : ''}`);
    if (written) log(`Feeds: ${written} geschrieben (${agsList.length} Gemeinden × ${AL.KINDS.length + 1})`);
    // F32: Tagesbriefing einmal je Ortstag ab 6 Uhr (Feed feeds/<AGS>-briefing.xml; ntfy nur für BRIEFING_AGS, Vorgabe Stuttgart)
    const topic = process.env.NTFY_TOPIC, bDay = dayOf(now);
    doc.briefings = prev?.briefings || {}; doc.briefingDay = prev?.briefingDay || null;
    if (BR.briefingDue(doc.briefingDay, bDay, hourOf(now))) {
      const fc = await rd(path.join(DATA, 'forecast', 'latest.json')).catch(() => null), yday = dayOf(now - 86400e3);
      const [sp, vd, cu] = await Promise.all(['sport.json', 'veranstaltungen.json', 'ereignisse.json'].map(f => rd(path.join(DATA, f)).catch(() => null)));
      let evs = []; try { evs = CX.eventList({ sport: sp, venues: vd, curated: cu?.ereignisse || [], now, pastDays: 0, aheadDays: 1 }).filter((/** @type {any} */ e) => dayOf(e.beginn) === bDay); } catch { evs = []; }
      const hhmm = (/** @type {number} */ ms) => new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(ms);
      const out = {};
      for (const ags of agsList) {
        const [pt, ak] = await Promise.all([rd(path.join(DATA, 'oepnv', `${ags}.json`)).catch(() => null), rd(path.join(DATA, 'akku', `${ags}.json`)).catch(() => null)]);
        const cap = (ctx.caps || []).find(c => c.ags === ags), ev = evs.filter((/** @type {any} */ e) => (e.ags || []).includes(ags)).sort((a, b) => (b.cap || 0) - (a.cap || 0)).map((/** @type {any} */ e) => ({ titel: e.titel, ort: e.ort, cap: e.cap, zeit: e.noTime ? null : hhmm(e.beginn) }));
        const b = BR.briefingText({ name: name(ags), day: bDay, fc: BR.dayForecast(fc, ags, bDay), akku: ak?.totals || null, pt: BR.ptBrief(pt, yday), events: ev, cap: cap ? { total: cap.total, limit: cap.limit } : null });
        if (b) out[ags] = { id: `briefing:${ags}:${bDay}`, at: now, ags, kind: 'briefing', op: null, level: 'info', ...b };
      }
      doc.briefings = out; doc.briefingDay = bDay; await writeFile(logFile, JSON.stringify(doc));
      for (const [ags, b] of Object.entries(out)) await writeFile(path.join(DATA, 'feeds', `${ags}-briefing.xml`), AL.atomFeed({ ags, name: name(ags), kind: 'briefing', items: [b], base: BASE, dataBase: DATA_BASE, since }));
      log(`Tagesbriefing: ${Object.keys(out).length} Gemeinden`);
      const pushTo = (process.env.BRIEFING_AGS || BR.BRIEFING.pushDefault.join(',')).split(',').map(x => x.trim()).filter(Boolean);
      if (topic) for (const ags of pushTo) { const b = out[ags]; if (b) await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', body: b.text, headers: { Title: b.title, Tags: 'briefing', Priority: '2', Click: `${BASE}?scope=${ags}#stadt` }, signal: AbortSignal.timeout(8000) }).catch(() => null); }
    } else await writeFile(logFile, JSON.stringify(doc));
    // Push über ntfy (frei, ohne Konto): nur wenn ein Thema gesetzt ist
    if (topic && fresh.length) for (const x of fresh.slice(0, 20)) {
      await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', body: x.text, headers: { Title: x.title, Tags: x.kind, Priority: x.level === 'bad' ? '4' : '3', Click: `${BASE}?scope=${x.ags}#stadt` }, signal: AbortSignal.timeout(8000) }).catch(e => log(`ntfy: ${e.message}`));
    }
  } catch (e) { log(`Alarme: ${e.message}`); }
}
