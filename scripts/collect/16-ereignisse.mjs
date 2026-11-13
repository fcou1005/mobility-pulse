// Sammler, Phase „ereignisse“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';
import * as T from '../../lib/pulse-track.js';
import * as OPS from '../../lib/pulse-ops.js';
import * as E from '../../lib/pulse-econ.js';
import * as R from '../../lib/pulse-report.js';
import * as FE from '../../lib/pulse-flowest.js';
import * as TR from '../../lib/pulse-train.js';
import * as SV from '../../lib/pulse-schema.js';
import * as SP from '../../lib/pulse-split.js';
import * as AU from '../../lib/pulse-auflagen.js';
import { gzipSync } from 'node:zlib';

export async function run(ctx) {
  const { DATA, HISTORY_DAYS, ROOT, RULE, TRACK_DIR, UA, ds, dv, hist, incidentDir, latest, log, muniOut, now, readState, sourceOut, stateFile, tr, vkey } = ctx;
  // ---------- Fahrzeug-Verfolgung (Fahrten, Standzeiten, Tausch, Umsetzungen, Sperren, Zellen, Stationsquote, Zuverlässigkeit) ----------
  {
    await mkdir(path.join(DATA, 'events'), { recursive: true });
    await mkdir(path.join(DATA, 'cells'), { recursive: true });
    if (TRACK_DIR) await rm(path.join(DATA, 'track'), { recursive: true, force: true }); // Zustand liegt privat im Cache, nicht mehr auf dem Datenzweig
    else await mkdir(path.join(DATA, 'track'), { recursive: true });
    await writeFile(stateFile, gzipSync(JSON.stringify(tr.state)));
    // Ereignisse je Stunde (M-11 Datenschutz): mit TRACK_DIR liegt der laufende Tag privat (events-work.json.gz) und wird beim Stundenwechsel
    // veröffentlicht – vor dem Einrechnen dieses Laufs, dann sind alle enthaltenen Stunden abgeschlossen –, nach Tagesende vollständig
    // (published.complete). Ohne TRACK_DIR wie bisher je Lauf.
    const evFile = path.join(DATA, 'events', `${tr.day}.json`);
    const evWorkFile = TRACK_DIR ? path.join(TRACK_DIR, 'events-work.json.gz') : null;
    // S1.7: Zwischenstand (complete false) ohne Dauer-/Distanzsummen und Kleinstgruppen (T.publicEventsDoc)
    const evChanged = new Set(); // S3.8: Tage, deren events/<Tag>.json in diesem Lauf geschrieben wurde (Teilung je Land danach neu)
    const evPublish = async (doc, complete) => { evChanged.add(doc.day); const str = JSON.stringify(SV.withSchema('events', { ...T.publicEventsDoc(doc, complete), published: { at: now, through: doc.runs?.at(-1)?.[0] ?? null, complete } })); await writeFile(path.join(DATA, 'events', `${doc.day}.json`), str); return JSON.parse(str); }; // Kopie: der Arbeitsstand wird danach fortgeschrieben
    let evWork = null, evPub = null, evFinal = null; // evPub: veröffentlichter Stand des laufenden Tags, evFinal: in diesem Lauf abgeschlossener Vortag
    if (evWorkFile) {
      evWork = await readState(evWorkFile);
      if (!evWork && existsSync(evFile)) evWork = JSON.parse(await readFile(evFile, 'utf8')); // Umstieg: bisher je Lauf veröffentlicht
      if (evWork && evWork.day !== tr.day) { evFinal = await evPublish(evWork, true); evWork = null; }
      else if (evWork) { const last = evWork.runs?.at(-1)?.[0]; if (last != null && T.hourOf(last) !== tr.hour) evPub = await evPublish(evWork, false); }
    }
    const evDoc = T.mergeHourly(evWorkFile ? evWork : existsSync(evFile) ? JSON.parse(await readFile(evFile, 'utf8')) : null, tr.hourly, { day: tr.day, at: now, dt: tr.dt, srcModes: tr.srcModes, gap: tr.gap, rule: RULE });
    // Carsharing ohne sichtbare Buchungen (tr.carTrips.unmeasurable): auch frühere Läufe des Tags aus der Tagesdatei nehmen (keine Nullen als Messung)
    { const mut = new Set(tr.carTrips?.unmeasurable || []); if (mut.size) for (const k of Object.keys(evDoc.groups || {})) { const [, op, ty] = k.split('|'); if (ty === 'car' && mut.has(op)) delete evDoc.groups[k]; } }
    if (evWorkFile) await writeFile(evWorkFile, gzipSync(JSON.stringify(evDoc)));
    else { await writeFile(evFile, JSON.stringify(SV.withSchema('events', evDoc))); evPub = evDoc; evChanged.add(evDoc.day); }
    if (!evPub && existsSync(evFile)) evPub = JSON.parse(await readFile(evFile, 'utf8')); // in dieser Stunde schon veröffentlichter Stand
    // Gruppen-Ereignisse (≥ T.GROUP_MIN = 4 Fahrzeuge eines Anbieters zusammen ausgebracht/eingesammelt): dauerhaft je Monat in
    // groups/<JJJJ-MM>.json (Monat nach Europe/Berlin, nie gekürzt) mit Verzeichnis groups/index.json; groups.json (30 Tage) bleibt als
    // Rückfall für Briefing/Signale und ältere Seitenstände. Erster Lauf mit Monatsdateien übernimmt die Ereignisse aus groups.json.
    {
      const rows = (tr.groups || []).map(T.groupRow);
      const gf = path.join(DATA, 'groups.json');
      const gd = existsSync(gf) ? JSON.parse(await readFile(gf, 'utf8')) : { events: [] };
      gd.fields = T.GROUP_FIELDS;
      gd.events.push(...rows);
      gd.events = gd.events.filter(e => now - e[0] <= 30 * 86400e3);
      gd.updatedAt = now;
      await writeFile(gf, JSON.stringify(gd));
      const gDir = path.join(DATA, 'groups'), gIdxFile = path.join(gDir, 'index.json');
      await mkdir(gDir, { recursive: true });
      const gIdx = existsSync(gIdxFile) ? JSON.parse(await readFile(gIdxFile, 'utf8')) : null;
      const add = gIdx ? rows : gd.events; // Dubletten (gleicher Lauf, Art, Anbieter, Ort) fallen in mergeGroupMonths weg
      const touched = [...new Set(add.map(r => T.dayOf(r[0]).slice(0, 7)))];
      const prev = {}; for (const m of touched) { const f = path.join(gDir, `${m}.json`); prev[m] = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null; }
      const changed = T.mergeGroupMonths(prev, add, { at: now });
      for (const [m, doc] of Object.entries(changed)) await writeFile(path.join(gDir, `${m}.json`), JSON.stringify(doc));
      const months = (await readdir(gDir)).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)).sort();
      const counts = {}; let first = gIdx?.first ?? null, last = gIdx?.last ?? null;
      for (const m of months) {
        const doc = changed[m] || (gIdx?.counts?.[m] != null ? null : JSON.parse(await readFile(path.join(gDir, `${m}.json`), 'utf8')));
        counts[m] = doc ? doc.events.length : gIdx.counts[m];
        if (doc?.events.length) { first = Math.min(first ?? Infinity, doc.events[0][0]); last = Math.max(last ?? -Infinity, doc.events[doc.events.length - 1][0]); }
      }
      await writeFile(gIdxFile, JSON.stringify(T.groupIndex(months, counts, { at: now, first, last, night: T.groupNight(gd.events) }))); // night30: Nachtanteil je Anbieter (30 Tage, Z7)
      if (tr.groups?.length) log(`Gruppen: ${tr.groups.filter(g => g.kind === 'deploy').length} ausgebracht, ${tr.groups.filter(g => g.kind === 'collect').length} eingesammelt (groups/: ${months.length} Monat${months.length === 1 ? '' : 'e'}, ${Object.values(counts).reduce((a, b) => a + b, 0)} Ereignisse)`);
    }
    { const s = (a) => (a || []).reduce((x, y) => x + (y || 0), 0); ctx.runEv = { start: 0, end: 0, rot: 0 }; for (const h of tr.hourly.values()) { ctx.runEv.start += s(h.start); ctx.runEv.end += s(h.end); ctx.runEv.rot += s(h.rot); } }
    // Langzeit-Archiv: Tageswerte je Gemeinde|Anbieter|Art, eine Datei je Monat, wird nie gekürzt. Grundlage ist der veröffentlichte Stand der
    // Ereignisse (M-11: laufender Tag nur abgeschlossene Stunden; abgeschlossener Vortag vollständig), sonst verrieten die Tageswerte je Lauf mehr.
    {
      const arDir = path.join(DATA, 'archive'); await mkdir(arDir, { recursive: true });
      // seit 11.11.2026 (Audit DAT-05) hinten: flotte_verf = mittlere verfügbare Flotte (vmin, wie die Prognose; flotte_avg zählt Gesperrte mit),
      // stunden_voll = Stunden mit ≥ 50 beobachteten Minuten (Gate der Prognose). Leser greifen per fields.indexOf; ältere Zeilen sind kürzer.
      const AR_FIELDS = ['flotte_avg', 'fahrten', 'fahrtenden', 'kennungswechsel', 'umsetzungen', 'akkutausch', 'abholungen', 'sperren', 'beobachtet_min', 'flotte_verf', 'stunden_voll'];
      const arRows = (doc, h) => {
        // gestörte Stunden (Lauf nach Lücke, auch Altbestand) zählen weder mit Ereignissen noch mit Beobachtungszeit
        const obsH = E.observedMinutesEnd(doc.runs); // Nenner der Fahrzeugminuten (je Lauf in der Endstunde gezählt), nicht die anteiligen Minuten
        const s = (a) => (a || []).reduce((x, y, hh) => x + (obsH[hh] > 0 ? (y || 0) : 0), 0);
        const obsMin = obsH.reduce((a, b) => a + b, 0);
        const vminOk = (doc.runs || []).every(r => r[1] == null || r[2] === 1 || r[2] === 0);
        const rows = {};
        for (const [k, g] of Object.entries(doc.groups || {})) {
          const hs = h?.series?.[k]?.total?.filter((x, i) => x != null && h.f?.[i] !== 0) || [];
          const countedRuns = h ? ((h.f || h.t).filter(x => x !== 0).length || h.t.length) : 0;
          // Mittel über die Läufe mit Wert nur bei ausreichender Präsenz (≥ 50 % der zählenden Läufe), sonst keine Tagesflotte (lib/pulse-report.js MIN_PRESENCE)
          const fleet = vminOk && obsMin > 0 && s(g.vminTot) > 0 ? s(g.vminTot) / obsMin : hs.length && hs.length >= R.MIN_PRESENCE * countedRuns ? hs.reduce((a, b) => a + b, 0) / hs.length : null;
          const avail = vminOk && obsMin > 0 && Array.isArray(g.vmin) ? +(s(g.vmin) / obsMin).toFixed(1) : null;
          rows[k] = [fleet == null ? null : +fleet.toFixed(1), s(g.start), s(g.end), s(g.rot), s(g.reloc), s(g.swap), s(g.pickup), s(g.disOn), Math.round(obsMin), avail, obsH.filter(m => m >= 50).length];
        }
        return rows;
      };
      const put = [];
      if (evFinal) { const hf = path.join(DATA, 'history', `${evFinal.day}.json`); put.push([evFinal.day, arRows(evFinal, existsSync(hf) ? JSON.parse(await readFile(hf, 'utf8')) : null)]); }
      if (evPub?.day === tr.day) put.push([tr.day, arRows(evPub, hist)]);
      let month = tr.day.slice(0, 7), ar = null;
      for (const [d, rows] of put) {
        const m = d.slice(0, 7), f = path.join(arDir, `${m}.json`);
        const doc = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : { month: m, days: {} };
        doc.fields = AR_FIELDS; doc.days[d] = rows; doc.updatedAt = now;
        await writeFile(f, JSON.stringify(doc)); if (m === month) ar = doc;
      }
      if (!ar) { const f = path.join(arDir, `${month}.json`); ar = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : { month, days: {}, fields: AR_FIELDS }; }
      // Index mit Tagen und erstem Tag (Vertrag 7), damit das Dashboard nicht alle Monatsdateien laden muss
      const months = (await readdir(arDir)).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)).sort();
      const allDays = []; for (const m of months) { const d = m === month ? ar : JSON.parse(await readFile(path.join(arDir, `${m}.json`), 'utf8')); allDays.push(...Object.keys(d.days || {})); }
      allDays.sort();
      await writeFile(path.join(arDir, 'index.json'), JSON.stringify({ months, fields: ar.fields, days: allDays.length, firstDay: allDays[0] || null, updatedAt: now }));
    }
    // Zellen (M-11 Datenschutz): mit TRACK_DIR liegt der laufende Tag privat (cells-work.json.gz) und wird je Bundesland beim Wechsel des
    // Tageszeit-Bands veröffentlicht (vor dem Einrechnen dieses Laufs: nur abgeschlossene Bänder), nach Tagesende vollständig. In jeder
    // veröffentlichten Landesdatei ist Zelle × Band unter T.CELL_MIN (3) Ereignissen unterdrückt, die Summen stehen je Gemeinde in below.
    // Ohne TRACK_DIR wie bisher je Lauf (Tagesdatei cells/<Tag>.json öffentlich), Landesdateien ebenfalls mit Unterdrückung.
    const cellsDir = path.join(DATA, 'cells');
    const cellFile = path.join(cellsDir, `${tr.day}.json`);
    const cellWorkFile = TRACK_DIR ? path.join(TRACK_DIR, 'cells-work.json.gz') : null;
    // je Bundesland aufgeteilt (kleinere Downloads); bandTainted/taintChecked: Altläufe repariert (lib/pulse-track.js repairCells)
    const cellMeta = (d) => ({ bandMin: d.bandMin, bandRuns: d.bandRuns, ...(d.bandTainted ? { bandTainted: d.bandTainted } : {}), ...(d.taintChecked ? { taintChecked: d.taintChecked } : {}), ...(d.relocUnrepaired ? { relocUnrepaired: true } : {}) });
    const CELL_FIELDS = 'start,end,present,reloc,start×6,present×6,end×6', BELOW_FIELDS = 'start×6,end×6,start_ohne_Band,end_ohne_Band';
    const publishCells = async (doc, complete) => {
      await mkdir(path.join(cellsDir, doc.day), { recursive: true });
      for (const [st, m] of Object.entries(doc.states || {})) {
        const sp = T.suppressCells(m);
        await writeFile(path.join(cellsDir, doc.day, `${st}.json`), JSON.stringify({ schemaVersion: SV.SCHEMA.cells, day: doc.day, state: st, ...cellMeta(doc), fields: CELL_FIELDS, munis: sp.munis, below: sp.below, belowFields: BELOW_FIELDS, minCount: T.CELL_MIN, suppress: T.SUPPRESS_VERSION, published: { at: now, through: doc.lastAt ?? null, complete } }));
      }
    };
    let cellWork = null;
    if (cellWorkFile) {
      cellWork = await readState(cellWorkFile);
      let migratedCells = false;
      if (!cellWork && existsSync(cellFile)) { cellWork = JSON.parse(await readFile(cellFile, 'utf8')); migratedCells = true; } // Umstieg: bisher öffentliche Tagesdatei
      if (cellWork && cellWork.day !== tr.day) { await publishCells(cellWork, true); cellWork = null; }
      else if (cellWork) {
        if (migratedCells) T.repairCells(cellWork, evDoc.runs, { exclude: now });
        const last = cellWork.lastAt;
        if (migratedCells || (last != null && T.bandOf(T.hourOf(last)) !== T.bandOf(tr.hour))) await publishCells(cellWork, false);
      }
    }
    const cellDoc = T.mergeCells(cellWorkFile ? cellWork : existsSync(cellFile) ? JSON.parse(await readFile(cellFile, 'utf8')) : null, tr.cells, muniOut, tr.day, { dt: tr.dt, hour: tr.hour, gap: tr.gap, runs: evDoc.runs, at: now });
    cellDoc.lastAt = now;
    if (cellWorkFile) {
      await writeFile(cellWorkFile, gzipSync(JSON.stringify(cellDoc)));
      for (const f of (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) await rm(path.join(cellsDir, f)); // Tagesdateien nicht mehr öffentlich
    } else { await writeFile(cellFile, JSON.stringify(cellDoc)); await publishCells(cellDoc, false); }
    // frühere Tage (14 Tage Landesdateien, 3 Tage Tagesdateien) einmalig reparieren: Bänder mit Altlauf laut events/<Tag>.json fallen aus
    try {
      for (const d of (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}(\.json)?$/.test(f))) {
        const dayD = d.slice(0, 10); if (dayD === tr.day) continue;
        const evF = path.join(DATA, 'events', `${dayD}.json`); if (!existsSync(evF)) continue;
        const files = d.endsWith('.json') ? [path.join(cellsDir, d)] : (await readdir(path.join(cellsDir, d))).filter(f => f.endsWith('.json')).map(f => path.join(cellsDir, d, f));
        let runsD = null;
        for (const f of files) {
          const doc = JSON.parse(await readFile(f, 'utf8')); const perState = !d.endsWith('.json');
          if (doc.taintChecked && (!perState || (doc.minCount && doc.suppress >= T.SUPPRESS_VERSION))) continue;
          if (!doc.taintChecked) {
            runsD ??= JSON.parse(await readFile(evF, 'utf8')).runs || [];
            const { bands } = T.repairCells(doc, runsD);
            if (bands.length && perState && f.endsWith('BE.json')) log(`Zellen ${dayD}: Altläufe neutralisiert (Bänder ${bands.map(b => T.BANDS[b].label).join(', ')})`);
          }
          // ältere Landesdateien: Unterdrückung kleiner Zellen nachträglich (M-11)
          if (perState && !doc.minCount) { const sp = T.suppressCells(doc.munis); doc.munis = sp.munis; doc.below = sp.below; doc.belowFields = BELOW_FIELDS; doc.minCount = T.CELL_MIN; }
          // Sekundärunterdrückung nachträglich (ab 6.11.2026): einzeln unterdrückte Zelle je Gemeinde × Band nicht aus below ablesbar
          else if (perState && !(doc.suppress >= T.SUPPRESS_VERSION)) T.secondarySuppress(doc.munis, doc.below || {}, { min: doc.minCount });
          if (perState) doc.suppress = T.SUPPRESS_VERSION;
          await writeFile(f, JSON.stringify(perState ? SV.withSchema('cells', doc) : doc));
        }
      }
    } catch (e) { log(`Zellen-Reparatur: ${e.message}`); }
    // laufender Tag: schon veröffentlichte Landesdateien ohne Sekundärunterdrückung sofort nachziehen (nicht erst beim nächsten Bandwechsel)
    try {
      const dToday = path.join(cellsDir, tr.day);
      if (existsSync(dToday)) for (const f of (await readdir(dToday)).filter(f => f.endsWith('.json'))) {
        const fp = path.join(dToday, f), doc = JSON.parse(await readFile(fp, 'utf8'));
        if (doc.minCount && !(doc.suppress >= T.SUPPRESS_VERSION)) { T.secondarySuppress(doc.munis, doc.below || {}, { min: doc.minCount }); doc.suppress = T.SUPPRESS_VERSION; await writeFile(fp, JSON.stringify(doc)); }
      }
    } catch (e) { log(`Zellen heute: ${e.message}`); }
    // Start-Ziel-Ströme (nur stabile Kennungen; lib/pulse-track.js publishFlows): Tagessumme privat in TRACK_DIR, veröffentlicht wird ein Tag
    // erst nach Tagesende (flows/<Tag>.json, ≥ T.FLOW_MIN = 5 Fahrten je Zeile, Top 300 je Gemeinde, 30 Tage) – ohne privates Verzeichnis keine Ströme
    if (TRACK_DIR) {
      const flDir = path.join(DATA, 'flows'), rawFile = path.join(TRACK_DIR, 'flows-raw.json.gz');
      await mkdir(flDir, { recursive: true });
      const raw0 = await readState(rawFile);
      if (raw0?.day && raw0.day < tr.day) { const pub = T.publishFlows(raw0, { at: now }); await writeFile(path.join(flDir, `${raw0.day}.json`), JSON.stringify(pub)); log(`Ströme ${raw0.day}: ${pub.flows.length} Zeilen (${pub.total.shown} Fahrten), ${pub.total.below} unter Mindestschwelle, ${pub.total.cut} außerhalb Top ${pub.top}`); }
      const raw = T.mergeFlows(raw0, tr.flows, { day: tr.day, gap: tr.gap, stable: T.stableOps(tr.srcModes, sourceOut) });
      await writeFile(rawFile, gzipSync(JSON.stringify(raw)));
      const flDays = (await readdir(flDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      for (const f of flDays.slice(0, -HISTORY_DAYS)) await rm(path.join(flDir, f));
      // ältere Tagesdateien mit niedrigerer Schwelle (bis 6.11.2026: 2) einmalig nachziehen: Zeilen unter T.FLOW_MIN entfallen
      for (const f of flDays.slice(-HISTORY_DAYS)) { try { const fp = path.join(flDir, f), doc = JSON.parse(await readFile(fp, 'utf8')); if (T.tightenFlows(doc)) { await writeFile(fp, JSON.stringify(doc)); log(`Ströme ${f.slice(0, 10)}: auf ≥ ${T.FLOW_MIN} Fahrten je Zeile nachgezogen (${doc.flows.length} Zeilen)`); } } catch (e) { log(`Ströme ${f}: ${e.message}`); } }
      await writeFile(path.join(flDir, 'index.json'), JSON.stringify({ days: flDays.slice(-HISTORY_DAYS).map(f => f.slice(0, 10)), collecting: raw.day, min: T.FLOW_MIN, top: T.FLOW_TOP, fields: T.FLOW_FIELDS, updatedAt: now }));
      // Wochenströme (A10): vergröberte Tagessumme (500 m) in den privaten Wochenspeicher (flows-week-raw.json.gz, 14 Tage); nach dem Ende einer
      // Kalenderwoche einmal flows-week/<Montag>.json (≥ T.FLOW_MIN Fahrten je Zeile, Top 300 je Gemeinde) + flows-week/index.json, 8 Wochen
      try {
        const wDir = path.join(DATA, 'flows-week'), wRawFile = path.join(TRACK_DIR, 'flows-week-raw.json.gz'), wIdxFile = path.join(wDir, 'index.json');
        await mkdir(wDir, { recursive: true });
        const roll = raw0?.day && raw0.day < tr.day;
        if (roll) {
          const wk = T.mergeWeekFlows(await readState(wRawFile), raw0);
          await writeFile(wRawFile, gzipSync(JSON.stringify(wk)));
          const mon = T.weekStart(raw0.day);
          if (T.weekStart(tr.day) > mon) { const doc = T.publishWeekFlows(wk, mon, { at: now }); await writeFile(path.join(wDir, `${mon}.json`), JSON.stringify(doc)); log(`Wochenströme ${mon}: ${doc.flows.length} Zeilen, ${doc.total.shown} von ${doc.total.trips} Fahrten sichtbar (${doc.total.trips ? (doc.total.shown / doc.total.trips * 100).toFixed(1) : 0} %), ${doc.week.days.length}/7 Tage`); }
        }
        if (roll || !existsSync(wIdxFile)) {
          const wDays = (await readdir(wDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
          for (const f of wDays.slice(0, -8)) await rm(path.join(wDir, f));
          await writeFile(wIdxFile, JSON.stringify({ weekly: true, days: wDays.slice(-8).map(f => f.slice(0, 10)), collecting: T.weekStart(tr.day), min: T.FLOW_MIN, top: T.FLOW_TOP, fields: T.FLOW_FIELDS, factor: T.WEEK_FACTOR, updatedAt: now }));
        }
      } catch (e) { log(`Wochenströme: ${e.message}`); }
      // Geschätzte Ströme für rotierende Kennungen (lib/pulse-flowest.js): je Lauf nur Zählungen je Zelle, privat in TRACK_DIR
      // (flows-est-raw.json.gz, keine Paare); Schätzung erst nach Tagesende → flows-est/<Tag>.json (estimated: true, ≥ FE.EST_MIN = 2 erwartete Fahrten,
      // Top 300 je Gemeinde, 500-m-Zellen, Gütekennzahl aus der Validierung an stabilen Kennungen) + flows-est/index.json, 30 Tage
      try {
        const eDir = path.join(DATA, 'flows-est'), eRawFile = path.join(TRACK_DIR, 'flows-est-raw.json.gz'), eIdxFile = path.join(eDir, 'index.json');
        await mkdir(eDir, { recursive: true });
        const er0 = await readState(eRawFile);
        const eIdx0 = existsSync(eIdxFile) ? JSON.parse(await readFile(eIdxFile, 'utf8')) : null;
        let method = eIdx0?.method ?? null, quality = eIdx0?.quality ?? null;
        if (er0?.day && er0.day < tr.day) try { // Fehler hier: Tag entfällt, die Zählung läuft weiter (kein Wiederholen in jedem Lauf)
          const refFile = process.env.REFERENCE_FILE || path.join(ROOT, 'data', 'reference.json');
          const reference = existsSync(refFile) ? JSON.parse(await readFile(refFile, 'utf8')) : null;
          const { doc, learn } = FE.publishEstimate(er0, raw0?.day === er0.day ? raw0 : null, { at: now, reference, factor: +process.env.FLOWS_EST_FACTOR || undefined });
          await writeFile(path.join(eDir, `${er0.day}.json`), JSON.stringify(doc)); er0.learn = learn; method = doc.method; quality = doc.quality;
          const q = doc.quality;
          log(`Ströme geschätzt ${er0.day}: ${doc.flows.length} Zeilen (${doc.total.shown} von ${doc.total.trips} erwarteten Fahrten), L ${JSON.stringify(doc.method.L_m)} m, ${(doc.runtimeMs.total / 1000).toFixed(1)} s (${doc.runtimeMs.perRun} ms je Lauf)${q ? ` · Validierung an stabilen Kennungen: CPC ${q.cpc} (ohne Distanzzerfall ${q.cpcBase}), r ${q.r}, Top-50 ${q.topShare}/${q.topOracle}, Ø ${q.meanKmEst}/${q.meanKmMeas} km` : ' · keine gemessenen Ströme zur Validierung'}`);
        } catch (e) { log(`Ströme geschätzt ${er0.day}: ${e.message}`); }
        const er = FE.mergeEstCounts(er0, tr.est, { day: tr.day, at: now, dt: tr.dt, gap: tr.gap, band: T.bandOf(tr.hour) });
        await writeFile(eRawFile, gzipSync(JSON.stringify(er)));
        const eDays = (await readdir(eDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
        for (const f of eDays.slice(0, -HISTORY_DAYS)) await rm(path.join(eDir, f));
        await writeFile(eIdxFile, JSON.stringify(FE.estIndex(eDays.slice(-HISTORY_DAYS).map(f => f.slice(0, 10)), { collecting: er.day, at: now, method, quality })));
      } catch (e) { log(`Ströme geschätzt: ${e.message}`); }
    }
    // Flotte für die Disposition (Ops): alle deduplizierten Fahrzeuge und Stationen je Bundesland, mit Standzeit
    {
      await mkdir(path.join(DATA, 'ops'), { recursive: true });
      for (const f of await readdir(path.join(DATA, 'ops')).catch(() => [])) if (f.endsWith('.json')) await rm(path.join(DATA, 'ops', f));
      const TYPES = C.VEHICLE_TYPES;
      const byState = new Map();
      const S = (st) => { if (!byState.has(st)) byState.set(st, { ops: [], munis: [], vehicles: [], stations: [] }); return byState.get(st); };
      const idx = (arr, v) => { let i = arr.indexOf(v); if (i < 0) { i = arr.length; arr.push(v); } return i; };
      for (const v of dv.vehicles) {
        const st = muniOut[v.ags]?.state; if (!st) continue; const o = S(st);
        const e = tr.state.v[vkey(v.operator, v.rawId)];
        // Standzeit null, wenn sie für die Quelle unbrauchbar ist (Z5); Feld 13 standzeitMindestens 1 = seit Beginn der Verfolgung unbewegt (Mindestwert, Z6)
        // veröffentlicht wird nur die Klasse (OPS.idleClassMin: unter 6 h, 6–24 h, ganze Tage), nicht die Minute des letzten Fahrtendes
        const idleOk = e && !tr.idleUnusable?.[v.sourceId] && !(v.type === 'car' && tr.carTrips?.unmeasurable?.includes(v.operator)), idleMin = idleOk ? OPS.idleClassMin(Math.round((now - e[8]) / 60e3)) : null;
        const idleMinOnly = idleOk && T.isCensored(T.censorLimit(tr.state), e[8], e[7]) ? 1 : null;
        // Feld 11 reichweiteSchwelleKm (null = Standard), Feld 12 reichweiteKonstant (1 = Reichweite der Quelle konstant); Felder am Zeilenende ohne
        // Wert entfallen (Leser werten fehlende Felder als null), explizites null nur vor einem späteren Wert
        const row = [+v.lat.toFixed(5), +v.lon.toFixed(5), idx(o.ops, v.operator), TYPES.indexOf(v.type), (v.reserved ? 1 : 0) | (v.disabled ? 2 : 0), v.batteryPct != null && !v.batteryDerived ? Math.round(v.batteryPct) : null, OPS.rangePublic(v), idleMin, idx(o.munis, v.ags), v.rangeDerived ? 1 : 0, v.rangeLimitKm ?? null, v.rangeFlat ? 1 : null, idleMinOnly];
        while (row.length && row[row.length - 1] == null) row.pop();
        o.vehicles.push(row);
      }
      for (const s of ds.stations) {
        const st = muniOut[s.ags]?.state; if (!st) continue; const o = S(st);
        o.stations.push([+s.lat.toFixed(5), +s.lon.toFixed(5), idx(o.ops, s.operator), String(s.name || '').slice(0, 50), s.bookable ?? 0, s.docksAvailable ?? null, s.capacity ?? null, idx(o.munis, s.ags), s.renting === false ? 0 : 1, s.returning === false ? 0 : 1, s.physicalAvailable ?? 0, s.isVirtual === true ? 1 : s.isVirtual === false ? 0 : null]);
      }
      let bytes = 0;
      const stateDocs = new Map(); // Land → veröffentlichter Text (für ops-input/fleet)
      for (const [st, o] of byState) { const doc = JSON.stringify({ schemaVersion: SV.SCHEMA.ops, at: now, state: st, types: TYPES, trackStart: tr.state.trackStart ?? null, vehicleFields: 'lat,lon,op,type,flags(1=reserviert,2=gesperrt),akku%,reichweiteKm,standzeitKlasseMin,gemeinde,reichweiteAbgeleitet,reichweiteSchwelleKm,reichweiteKonstant,standzeitMindestens', vehicleFieldsNote: 'Felder am Zeilenende ohne Wert entfallen (fehlend = null): standzeitKlasseMin = Untergrenze der Standzeit-Klasse in Minuten (0 = unter 6 h, 360 = 6–24 h, ab 1440 ganze Tage; minutengenau wird nicht veröffentlicht, weil sie zeigt, wann an einer Adresse die letzte Fahrt endete), reichweiteKm ganze km (Quellen mit eigener Reichweiten-Skala, Feld reichweiteSchwelleKm gesetzt: 0,1 km), reichweiteSchwelleKm null = Standardschwelle, reichweiteKonstant 1 = Reichweite der Quelle konstant (für Energie und Akkutausch unbekannt), standzeitMindestens 1 = seit Beginn der Verfolgung (trackStart) unbewegt, die Klasse ist ein Mindestwert; standzeitKlasseMin null = unbekannt oder für die Quelle unbrauchbar (sources[].idleUnusable)', stationFields: 'lat,lon,op,name,buchbar,freiePlaetze,kapazitaet,gemeinde,vermietend,rueckgabe,physisch,virtuell', ...o }); bytes += doc.length; stateDocs.set(st, doc); await writeFile(path.join(DATA, 'ops', `${st}.json`), doc); }
      log(`Ops-Flotte: ${byState.size} Länder, ${(bytes / 1e6).toFixed(1)} MB`);
      // S3.8: Bestand je Gemeinde für die Disposition (ops-input/fleet/<AGS>.json, Format wie ops/<Land>.json, lib/pulse-split.js opsSlice)
      try {
        const fdir = path.join(DATA, 'ops-input', 'fleet'), bb = new Map(); await mkdir(fdir, { recursive: true });
        for (const ft of ctx.boundaries?.features || []) if (ft.properties?.ags) bb.set(ft.properties.ags, C.geomBounds(ft.geometry));
        const list = []; let fbytes = 0;
        for (const [st, o] of byState) {
          const head = JSON.parse(stateDocs.get(st));
          for (const ags of o.munis) { const sl = SP.opsSlice(head, ags, { bbox: bb.get(ags) || null }); if (!sl) continue; const str = JSON.stringify(sl); fbytes += str.length; list.push(ags); await writeFile(path.join(fdir, `${ags}.json`), str); }
        }
        const keep = new Set(list); for (const f of (await readdir(fdir)).filter(f => /^\d{8}\.json$/.test(f) && !keep.has(f.slice(0, 8)))) await rm(path.join(fdir, f));
        await writeFile(path.join(fdir, 'index.json'), JSON.stringify({ schemaVersion: SV.SCHEMA.ops, version: SP.SPLIT_VERSION, at: now, ags: list.sort() }));
        log(`Ops-Flotte je Gemeinde: ${list.length} Dateien, ${(fbytes / 1e6).toFixed(1)} MB`);
      } catch (e) { log(`Ops-Flotte je Gemeinde: ${e.message}`); }
    }
    // Umgebung für die Disposition: ÖPNV-Haltepunkte und Abstellflächen aus OpenStreetMap, je Gemeinde.
    // Wenige Gemeinden je Lauf (größte Flotten zuerst), gültig 7 Tage – der Browser muss Overpass dann nicht selbst fragen.
    if (process.env.SKIP_CONTEXT !== '1') {
      const dir = path.join(DATA, 'context'); await mkdir(dir, { recursive: true });
      const idxFile = path.join(dir, 'index.json');
      const cidx = existsSync(idxFile) ? JSON.parse(await readFile(idxFile, 'utf8')) : { munis: {} };
      const byAgs = new Map(); for (const v of dv.vehicles) { if (!v.ags) continue; if (!byAgs.has(v.ags)) byAgs.set(v.ags, []); byAgs.get(v.ags).push(v); }
      const due = (a) => { const m = cidx.munis[a]; if (!m) return true; if (m.failedAt && now - m.failedAt < 6 * 3600e3) return false; return !m.at || now - m.at > 7 * 86400e3; };
      const todo = [...byAgs].filter(([a, l]) => l.length >= 30 && due(a)).sort((a, b) => b[1].length - a[1].length).slice(0, +process.env.CONTEXT_PER_RUN || 2);
      const t0 = Date.now(); const CATS = ['escooter', 'sharing', 'rad', 'official'];
      for (const [ags, list] of todo) {
        if (Date.now() - t0 > 120e3) break;
        const qt = (arr, p) => { const x = arr.slice().sort((a, b) => a - b); return x[Math.floor(p * (x.length - 1))]; };
        const la = list.map(v => v.lat), lo = list.map(v => v.lon);
        const bbox = [qt(la, 0.02) - 0.004, qt(lo, 0.02) - 0.006, qt(la, 0.98) + 0.004, qt(lo, 0.98) + 0.006].map(x => +x.toFixed(4));
        const q = `[out:json][timeout:110][bbox:${bbox.join(',')}];(nwr["amenity"~"^(kick-scooter_parking|small_vehicle_parking|small_electric_vehicle_parking|bicycle_rental|kick-scooter_rental|mobility_hub|bicycle_parking)$"];nwr["small_electric_vehicle"];node["highway"="bus_stop"];node["public_transport"="platform"];node["railway"~"^(tram_stop|station|halt)$"];);out center tags;`;
        let els = null, ep = null;
        for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
          const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 120e3);
          try { const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': UA }, signal: ctrl.signal }); if (r.ok) { const j = await r.json(); if (Array.isArray(j.elements) && !j.remark) { els = j.elements; ep = url; } } } catch { /* nächster Spiegel */ }
          clearTimeout(tm); if (els) break;
        }
        if (!els) { cidx.munis[ags] = { ...(cidx.munis[ags] || {}), failedAt: now }; log(`Umgebung ${ags}: Overpass ohne Antwort`); continue; }
        const parking = OPS.parkingFromOsm(els).map(p => [+p.lat.toFixed(5), +p.lon.toFixed(5), CATS.indexOf(p.cat), p.cat === 'rad' ? null : (p.name || null)]);
        const transit = OPS.transitFromOsm(els).map(p => [+p.lat.toFixed(5), +p.lon.toFixed(5)]);
        const doc = JSON.stringify({ at: now, ags, bbox, source: 'OpenStreetMap (ODbL) via Overpass', cats: CATS, parkingFields: 'lat,lon,kategorie,name', parking, transit });
        await writeFile(path.join(dir, `${ags}.json`), doc);
        cidx.munis[ags] = { at: now, parking: parking.length, transit: transit.length, bytes: doc.length };
        log(`Umgebung ${ags}: ${parking.length} Abstellflächen, ${transit.length} Haltepunkte (${(doc.length / 1e3).toFixed(0)} kB, ${new URL(ep).host})`);
      }
      await writeFile(idxFile, JSON.stringify(cidx));
    }
    // Standzeit-Klassen (T.IDLE_BUCKETS, ab 02.11.2026 mit „> 72 h“): groups[k] = [je Klasse, Summe], censored[k] = je Klasse Mindestwerte (seit
    // trackStart unbewegt, Z6); Quellen mit unbrauchbarer Standzeit (Z5) fehlen (unusable)
    await writeFile(path.join(DATA, 'idle.json'), JSON.stringify({ at: now, version: T.IDLE_VERSION, buckets: T.IDLE_LABELS, fields: 'groups: Anzahl je Klasse, dann Summe; censored: davon Mindestwerte je Klasse', trackStart: tr.state.trackStart ?? null, groups: tr.idle, censored: tr.idleCens, unusable: Object.keys(tr.idleUnusable || {}).sort() }));
    // Lange Standzeiten: je Gemeinde max. 400 Punkte (gleichmäßig ausgedünnt)
    const byAgs = new Map(); for (const p of tr.idleLong) { if (!byAgs.has(p.ags)) byAgs.set(p.ags, []); byAgs.get(p.ags).push(p); }
    // hours nur als ganze Tage (Klasse wie ops/<Land>.json: OPS.idleClassMin), nicht stundengenau
    const longOut = []; for (const [, list] of byAgs) { list.sort((a, b) => b.hours - a.hours); const step = Math.max(1, Math.ceil(list.length / 400)); for (let i = 0; i < list.length; i += step) longOut.push({ ...list[i], hours: OPS.idleClassMin(list[i].hours * 60) / 60 }); }
    await writeFile(path.join(DATA, 'idle-long.json'), JSON.stringify({ at: now, total: tr.idleLong.length, points: longOut }));
    await writeFile(path.join(DATA, 'stations-quota.json'), JSON.stringify({ at: now, days: 7, fields: ['ags', 'operator', 'name', 'lat', 'lon', 'runs', 'emptyRuns', 'fullRuns', 'virtual'], stations: T.stationQuota(tr.state) }));
    await writeFile(path.join(DATA, 'reliability.json'), JSON.stringify({ at: now, days: 7, sources: T.reliability(tr.state) }));
    // S5.1 Datenauflagen-Check: Jahresbuch der Feed-Verfügbarkeit (lib/pulse-auflagen.js), eine Datei je Kalenderjahr
    if (tr.state.day) {
      await mkdir(path.join(DATA, 'auflagen'), { recursive: true });
      const lf = path.join(DATA, 'auflagen', `verfuegbarkeit-${tr.state.day.slice(0, 4)}.json`);
      const prevL = existsSync(lf) ? JSON.parse(await readFile(lf, 'utf8').catch(() => 'null')) : null;
      await writeFile(lf, JSON.stringify(SV.withSchema('auflagen', AU.updateLedger(prevL, tr.state.rel, { today: tr.state.day, now }))));
    }
    // Ereignis- und Zellendateien: 30 bzw. 14 Tage behalten
    for (const f of (await readdir(path.join(DATA, 'events'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -HISTORY_DAYS)) await rm(path.join(DATA, 'events', f));
    // Umgebungsereignisse wie Ereignisse (+ 2 Tage Vorschau: heute, morgen); was die Prognose daraus gelernt hat, steht im Langzeitgedächtnis
    if (existsSync(incidentDir)) for (const f of (await readdir(incidentDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -(HISTORY_DAYS + 2))) await rm(path.join(incidentDir, f));
    const cellDays = (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}(\.json)?$/.test(f)).sort();
    // vor dem Löschen: abgeschlossene ISO-Wochen als Summe der veröffentlichten Tagesdateien behalten (lib/pulse-train.js, Audit DAT-02)
    if (process.env.TRAIN !== '0') {
      try {
        const wDir = path.join(DATA, TR.CELLS_WEEK.dir), haveW = new Set();
        if (existsSync(wDir)) for (const y of (await readdir(wDir)).filter(f => /^\d{4}$/.test(f))) for (const f of await readdir(path.join(wDir, y))) { const m = f.match(/^(\d{4}-W\d{2})\.json\.gz$/); if (m) haveW.add(m[1]); }
        for (const w of TR.cellsWeekTodo(cellDays.filter(f => !f.endsWith('.json')), haveW, now)) {
          const docs = []; for (const d of w.days) for (const f of (await readdir(path.join(cellsDir, d))).filter(f => /^[A-Z]{2}\.json$/.test(f))) { try { docs.push(JSON.parse(await readFile(path.join(cellsDir, d, f), 'utf8'))); } catch {} }
          const buf = gzipSync(JSON.stringify(TR.cellsWeekDoc(w, docs, now)), { level: 9 }), f = path.join(DATA, TR.cellsWeekPath(w.key));
          await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, buf); log(`Zellen-Wochensumme ${w.key}: ${w.days.length} Tage, ${(buf.length / 1e3).toFixed(0)} kB gz`);
        }
      } catch (e) { log(`Zellen-Wochensumme: ${e.message}`); }
    }
    for (const f of cellDays.filter(f => !f.endsWith('.json')).slice(0, -14)) await rm(path.join(cellsDir, f), { recursive: true, force: true });
    for (const f of cellDays.filter(f => f.endsWith('.json')).slice(0, -3)) await rm(path.join(cellsDir, f));
    await writeFile(path.join(DATA, 'events', 'index.json'), JSON.stringify({ schemaVersion: SV.SCHEMA.events, days: (await readdir(path.join(DATA, 'events'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort(), cellDays: (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f)).sort(), updatedAt: now, first: tr.first }));
    // S3.8 Daten nach Gebiet (lib/pulse-split.js), neben den bisherigen Dateien (die laufen bis mindestens 27.11.2026 parallel):
    // events/<Tag>/<Land>.json, events/hour-totals.json (Tagesgang ohne 14 Tagesdateien), events/daily-summary.json (Tagessummen je Gruppe).
    // Neu geteilt werden nur Tage, die dieser Lauf geschrieben hat oder denen die Teilung fehlt; Summen früherer Tage kommen aus dem Vorlauf.
    try {
      const t0 = Date.now(), evDir = path.join(DATA, 'events');
      const evDays = (await readdir(evDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
      const stateOf = (ags) => latest.municipalities?.[ags]?.state;
      const htFile = path.join(evDir, 'hour-totals.json'), dsFile = path.join(evDir, 'daily-summary.json');
      const ht0 = existsSync(htFile) ? JSON.parse(await readFile(htFile, 'utf8')) : null, ds0 = existsSync(dsFile) ? JSON.parse(await readFile(dsFile, 'utf8')) : null;
      const dsOld = ds0?.version === SP.SPLIT_VERSION && JSON.stringify(ds0.fields) === JSON.stringify(SP.SUMMARY_FIELDS) ? ds0 : null;
      const oldSums = (d) => { const i = dsOld?.days?.indexOf(d) ?? -1; if (i < 0) return null; const o = {}; for (const [k, row] of Object.entries(dsOld.groups || {})) if (row[i]) o[k] = row[i]; return o; };
      const htDays = {}, sums = {}; let nSplit = 0;
      for (const d of evDays) {
        const dir = path.join(evDir, d), prevT = ht0?.version === SP.SPLIT_VERSION ? ht0.days?.[d] : null, prevS = oldSums(d);
        if (!evChanged.has(d) && existsSync(dir) && prevT && prevS) { htDays[d] = prevT; sums[d] = prevS; continue; }
        const doc = JSON.parse(await readFile(path.join(evDir, `${d}.json`), 'utf8'));
        await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
        for (const [st, part] of SP.eventsByState(doc, stateOf)) await writeFile(path.join(dir, `${st}.json`), JSON.stringify(SV.withSchema('events', part)));
        htDays[d] = SP.hourTotals(doc); sums[d] = SP.groupDaySums(doc); nSplit++;
      }
      for (const f of await readdir(evDir, { withFileTypes: true })) if (f.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(f.name) && !evDays.includes(f.name)) await rm(path.join(evDir, f.name), { recursive: true, force: true });
      await writeFile(htFile, JSON.stringify({ schemaVersion: SV.SCHEMA.events, version: SP.SPLIT_VERSION, at: now, latestAt: latest.at, days: htDays }));
      await writeFile(dsFile, JSON.stringify({ schemaVersion: SV.SCHEMA.events, version: SP.SPLIT_VERSION, at: now, ...SP.dailySummary(sums) }));
      if (nSplit) log(`Daten nach Gebiet: ${nSplit} Ereignistag(e) je Land geteilt (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) { log(`Daten nach Gebiet (Ereignisse): ${e.message}`); }
    // ops-input/<AGS>.json: Nachfrage-Eingabe der Disposition (Zellen der letzten 7 Zellen-Tage nur dieser Gemeinde, Begrenzungsrahmen) –
    // statt 7 Landesdateien. Ändert sich nur, wenn ein Tageszeit-Band neu veröffentlicht wird (git speichert unveränderte Dateien nicht neu).
    try {
      const t0 = Date.now(), dir = path.join(DATA, 'ops-input');
      const days = (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f)).sort().slice(-SP.OPS_INPUT_DAYS);
      const byDay = []; // je Zellen-Tag: Land → Landesdatei
      for (const d of days) { const m = new Map(); for (const f of (await readdir(path.join(cellsDir, d))).filter(f => /^[A-Z]{2}\.json$/.test(f))) m.set(f.slice(0, 2), JSON.parse(await readFile(path.join(cellsDir, d, f), 'utf8'))); byDay.push(m); }
      const byAgs = new Map(); // ags → Land (Gemeinden mit Zellen an mindestens einem der Tage)
      for (const m of byDay) for (const [st, doc] of m) for (const ags of Object.keys(doc.munis || {})) if (!byAgs.has(ags)) byAgs.set(ags, st);
      const bbox = new Map(); for (const ft of ctx.boundaries?.features || []) if (ft.properties?.ags) bbox.set(ft.properties.ags, C.geomBounds(ft.geometry));
      await mkdir(dir, { recursive: true });
      for (const f of (await readdir(dir)).filter(f => /^\d{8}\.json$/.test(f) && !byAgs.has(f.slice(0, 8)))) await rm(path.join(dir, f));
      // je Tag die Landesdatei der Gemeinde (fehlt sie, fehlt der Tag – wie beim Laden der Landesdateien); Tage ohne Zellen der Gemeinde bleiben leer drin
      for (const [ags, st] of byAgs) await writeFile(path.join(dir, `${ags}.json`), JSON.stringify({ schemaVersion: SV.SCHEMA.ops, version: SP.SPLIT_VERSION, ags, state: st, bbox: bbox.get(ags) || null, cellDays: days, cells: SP.cellsSlice(byDay.map(m => m.get(st)), ags) }));
      await writeFile(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: SV.SCHEMA.ops, version: SP.SPLIT_VERSION, at: now, cellDays: days, ags: [...byAgs.keys()].sort() }));
      log(`Daten nach Gebiet: ops-input für ${byAgs.size} Gemeinden (${days.length} Zellen-Tage, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) { log(`Daten nach Gebiet (ops-input): ${e.message}`); }
    const ev = [...tr.hourly.values()].reduce((a, h) => { a.start += h.start.reduce((x, y) => x + y, 0); a.end += h.end.reduce((x, y) => x + y, 0); a.reloc += h.reloc.reduce((x, y) => x + y, 0); a.swap += h.swap.reduce((x, y) => x + y, 0); return a; }, { start: 0, end: 0, reloc: 0, swap: 0 });
    log(`Verfolgung: ${Object.keys(tr.state.v).length} Kennungen im Zustand${tr.first ? ' (erster Lauf)' : ` · Fahrten begonnen ${ev.start}, beendet ${ev.end}, Umsetzungen ${ev.reloc}, Akkutausch ${ev.swap}`} · lange Standzeiten ${tr.idleLong.length}`);
  }
}
