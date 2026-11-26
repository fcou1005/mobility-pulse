// Sammler, Phase „prognose“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as FC from '../../lib/pulse-forecast.js';
import * as OX from '../../lib/pulse-ops-extern.js';
import * as CX from '../../lib/pulse-context.js';
import * as CH from '../../lib/pulse-chronos.js';
import * as TMN from '../../lib/pulse-termine.js';
import * as SV from '../../lib/pulse-schema.js';
import * as OPS from '../../lib/pulse-ops.js';
import * as FB from '../../lib/pulse-fehlbestand.js';
import * as PG from '../../lib/pulse-oepnv-prog.js';

export async function run(ctx) {
  const { DATA, ROOT, fetchJson, latest, log, now } = ctx;
  if (process.env.FORECAST !== '0') {
    try {
      const fLatest = path.join(DATA, 'forecast', 'latest.json');
      const rd = async (f) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null);
      const prevLatest = await rd(fLatest), every = (process.env.FORECAST_EVERY_MIN != null ? +process.env.FORECAST_EVERY_MIN : 60) * 60e3;
      if (!prevLatest || !(now - Date.parse(prevLatest.generatedAt) < every)) {
        const list = async (d, n) => (existsSync(d) ? (await readdir(d)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-n).map(f => path.join(d, f)) : []);
        const docs = []; for (const f of await list(path.join(DATA, 'events'), 21)) docs.push(JSON.parse(await readFile(f, 'utf8')));
        // Ausfallstunden je Gruppe aus history/<Tag>.json (lib/pulse-forecast-outage.js): lernen und zählen in der Selbstprüfung nicht mit
        const outages = /** @type {Record<string, Record<string, number>>} */ ({}); for (const d of docs) { const hf = path.join(DATA, 'history', `${d.day}.json`); if (!existsSync(hf)) continue; try { outages[d.day] = FC.outageMask(JSON.parse(await readFile(hf, 'utf8'))); } catch { /* defekte Datei: Tag ohne Maske */ } }
        { const s = Object.values(FC.outageSummary(outages)); if (s.length) log(`Prognose: Ausfallstunden ${s.reduce((a, x) => a + x[1], 0)} Gruppen-Stunden in ${s.filter(x => x[0]).length} von ${s.length} Tagen ausgenommen`); }
        const weather = []; for (const f of await list(path.join(DATA, 'weather'), 30)) weather.push(JSON.parse(await readFile(f, 'utf8')));
        // S2.4: Selbstprüfung mit der damals gesicherten Vorhersage (weather-fc/), nicht mit dem beobachteten Wetter des Prüftags
        // S2.8: Strukturbrüche je Gruppe aus calib.json (letzter Stand) – Tage davor lernen für die Gruppe nicht mit
        let calibBreaks = null; try { const cj = path.join(DATA, 'calib.json'); if (existsSync(cj)) calibBreaks = JSON.parse(await readFile(cj, 'utf8'))?.breaks || null; } catch { calibBreaks = null; }
        const weatherFc = []; for (const f of await list(path.join(DATA, 'weather-fc'), 30)) { try { weatherFc.push(JSON.parse(await readFile(f, 'utf8'))); } catch { /* defekte Datei: Tag ohne Wetter */ } }
        const red = new Set(Object.entries(latest.eventChecks?.groups || {}).filter(([, g]) => g?.level === 'bad').map(([k]) => k)); // rote Ampel: nicht plausibel gezählt
        // Carsharing ohne sichtbare Buchungen: auch ältere Tagesdateien (vor 9.11.2026 noch mit Nullen) nicht ins Modell
        { const mut = new Set(latest.carTrips?.unmeasurable || []); if (mut.size) for (const d of docs) for (const k of Object.keys(d.groups || {})) { const [, op, ty] = k.split('|'); if (ty === 'car' && mut.has(op)) red.add(k); } }
        // Umgebung: Warnungen und Autobahn (incidents/), gepflegte Ereignisliste (data/ereignisse.json im Repo; fehlerhafte Einträge werden gemeldet und übersprungen)
        const incidents = []; for (const f of await list(path.join(DATA, 'incidents'), 25)) { try { incidents.push(JSON.parse(await readFile(f, 'utf8'))); } catch {} }
        // erwartete ÖPNV-Verspätung je Gemeinde, Tag und Stunde (Merkmal ptRisk): Prognose aus den Vortagen wie auf der ÖPNV-Seite, für vergangene und kommende Tage
        const ptMap = new Map(incidents.filter(d => d?.day).map(d => [d.day, d])), ptCity = new Map(), ptDay = new Map();
        const ptRisk = (ags, day, h) => { const k = `${ags}|${day}`; let p = ptDay.get(k); if (p === undefined) { let cd = ptCity.get(ags); if (cd === undefined) ptCity.set(ags, cd = PG.cityDays(ptMap, ags)); p = cd.size ? PG.predictDay(cd, day) : null; ptDay.set(k, p); } const v = p?.late?.[h]; return v != null && (p.n?.[h] ?? 0) >= PG.PTP.minN ? v : null; };
        const curDoc = await rd(path.join(ROOT, 'data', 'ereignisse.json')), cur = CX.checkCurated(curDoc); if (cur.bad.length) log(`Ereignisliste: ${cur.bad.length} Einträge übersprungen (${cur.bad.slice(0, 3).join('; ')})`);
        // Termine aus dem Workflow „Termine“ (Branch termine, lib/pulse-termine.js, wöchentlich): wie Veranstaltungen der Liste (erst ab veranstaltungenAb);
        // Doppel zur Liste fallen für die Anzeige weg (das Merkmal je Gemeinde und Stunde ist 0/1). TERMINE_URL leer = aus.
        let termineAuto = []; const termUrl = process.env.TERMINE_URL ?? `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || 'fcou1005/mobility-pulse'}/termine/termine.json`;
        if (termUrl) { const r = await fetchJson(termUrl); if (r.ok && r.json?.version === 1 && Array.isArray(r.json.termine)) termineAuto = TMN.withoutCurated(CX.checkCurated({ ereignisse: r.json.termine }).ok, cur.ok); else if (r.status !== 404) log(`Termine: ${r.error || `HTTP ${r.status}`}`); }
        // geprüfte Liste auch im Datenstand: das Dashboard zeigt sie mit Sport und Hallen-Terminen (Prognose › Veranstaltungen)
        // dazu die automatisch erkannten Streiks (streiks.json) und Termine (termine.json), beide mit auto: true
        await writeFile(path.join(DATA, 'ereignisse.json'), JSON.stringify({ version: 1, at: now, quelle: 'data/ereignisse.json (gepflegte Liste, je Eintrag mit Beleg), automatisch erkannte Streiks (streiks.json) und Termine aus den Quellenseiten (Branch termine), beide auto: true', veranstaltungenAb: curDoc?.veranstaltungenAb ?? null, ereignisse: [...cur.ok, ...ctx.strikeAuto, ...termineAuto], automatisch: ctx.strikeAuto.length + termineAuto.length, streiks: ctx.strikeAuto.length, termine: termineAuto.length, uebersprungen: cur.bad.length }));
        // Veranstaltungen (Konzerte, Feste) wie Sport erst ab veranstaltungenAb in die Prognose (Ende der Lernphase); Streiks sofort
        const evFrom = Date.parse(curDoc?.veranstaltungenAb ?? ''), evOn = !Number.isFinite(evFrom) || now >= evFrom;
        const curOk = evOn ? cur.ok : cur.ok.filter(e => e.art !== 'veranstaltung' && e.art !== 'volksfest'); // Volksfeste (Merkmal fest) ebenso
        // Zurückgehaltenes nur zählen (Dashboard: „erfasst, wirkt ab …“), nicht ins Modell
        const pending = [...(evOn ? [] : cur.ok.filter(e => e.art === 'veranstaltung' || e.art === 'volksfest')), ...ctx.sportPending, ...(evOn ? [] : ctx.venueCurated), ...(evOn ? [] : termineAuto)], pendingFrom = curDoc?.veranstaltungenAb ?? ctx.sportFrom;
        if (curOk.length < cur.ok.length) log(`Ereignisliste: ${cur.ok.length - curOk.length} Veranstaltungen vorgemerkt, in der Prognose ab ${curDoc.veranstaltungenAb}`);
        if (termineAuto.length) log(`Termine (Workflow): ${termineAuto.length} Einträge${evOn ? '' : `, in der Prognose ab ${curDoc?.veranstaltungenAb}`}`);
        // Chronos-2 (lib/pulse-chronos.js): chronos.json aus dem Branch tsfm (Workflow „Chronos-2“, scripts/chronos.py) – Vergleich „chronos“ und
        // Mischung „blend“ (lernt mit, wählbar nach geprüftem Vorsprung, FC.DM); fehlt sie oder ist sie zu alt, läuft die Prognose ohne. TSFM_URL leer = aus.
        let chronos = null; const tsfmUrl = process.env.TSFM_URL ?? `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || 'fcou1005/mobility-pulse'}/tsfm/chronos.json`;
        if (tsfmUrl) { const r = await fetchJson(tsfmUrl); if (r.ok && r.json?.version === 1 && r.json.groups) chronos = r.json; else if (r.status !== 404) log(`Chronos: ${r.error || `HTTP ${r.status}`}`); }
        const ext = chronos ? CH.chronosLookup(chronos) : null;
        // je Fahrzeugfamilie ein eigenes Modell (FC.FAMILY_DIR): micro wie bisher in forecast/ (Lernphase unverändert), E-Roller und Carsharing
        // getrennt in forecast/moped/ und forecast/car/; eine Familie ohne Fahrzeugminuten in den Tagesdateien wird übersprungen (keine Dateien)
        const curatedAll = [...curOk, ...ctx.strikeAuto, ...ctx.sportCurated, ...(evOn ? [...ctx.venueCurated, ...termineAuto] : [])], calendar = await rd(path.join(DATA, 'calendar.json'));
        ctx.trainCtx = { curated: curatedAll, pending };
        // Störungskorrektur (angezeigt, nach Freigabe eingerechnet): letzte volle Stunde je Gemeinde (Phase oepnv) und belegte Wirkung (oepnv/wirkung.json)
        let ptIn = null; try { const w = ctx.ptNow ? await rd(path.join(DATA, 'oepnv', 'wirkung.json')) : null; if (w?.learn) ptIn = { now: ctx.ptNow, effect: Object.fromEntries(Object.entries(w.learn.cities || {}).map(([a, r]) => [a, r[1]])), pooled: w.learn.pooled?.effect ?? 0, since: w.learn.since, until: w.learn.until }; } catch { ptIn = null; }
        for (const fam of FC.FAMILIES) {
          try {
            const fdocs = FC.familyDocs(docs, fam); if (fam !== 'micro' && !FC.familyHasData(fdocs)) continue;
            const fdir = path.join(DATA, FC.FAMILY_DIR[fam]), fL = path.join(fdir, 'latest.json'), fG = path.join(fdir, 'log.json'), fS = path.join(fdir, 'series.json');
            const t0 = Date.now(), res = FC.runForecast({ docs: fdocs, calendar, weather, weatherFc, breaks: calibBreaks, incidents, curated: curatedAll, prevLog: await rd(fG), prevSeries: await rd(fS), now, exclude: red, ext, pending, pendingFrom, family: fam === 'micro' ? null : fam, pt: ptIn, outages, ptRisk });
            if (chronos) CH.chronosSeries(res.series, chronos); // Linie „Chronos-2“ im Verlauf (Feld c)
            if (chronos) res.latest.external = { chronos: { model: chronos.model, package: chronos.package ?? null, at: chronos.at, ranAt: chronos.ranAt ?? null, runSec: chronos.runSec ?? null, from: chronos.from, hours: chronos.hours, groups: Object.keys(chronos.groups).length, minStarts: CH.CHRONOS.minStarts } };
            await mkdir(fdir, { recursive: true });
            await writeFile(fL, JSON.stringify(SV.withSchema('forecast', res.latest))); await writeFile(fG, JSON.stringify(SV.withSchema('forecast', res.log))); await writeFile(fS, JSON.stringify(SV.withSchema('forecast', res.series)));
            if (res.model) await writeFile(path.join(fdir, 'model.json'), JSON.stringify(res.model)); // vortrainiertes Modell zum Mitnehmen (tools/prognose-modell.mjs)
            // Disposition: Prognose und gemessenes Mittel je Gemeinde und Horizont-Stunde (lib/pulse-ops-extern.js), nur Mikromobilität
            if (fam === 'micro' && res.latest.status === 'active') { const dp = OX.dispoForecast(res.latest, res.series); await writeFile(path.join(fdir, 'dispo.json'), JSON.stringify(SV.withSchema('forecast', dp))); }
            // Wo fehlen Fahrzeuge (lib/pulse-fehlbestand.js): Spot-Bewertung wie Prognose › Spots für alle Gemeinden mit Prognose, nur Mikromobilität
            if (fam === 'micro') { try { const t1 = Date.now(), rows = await gapRows(DATA, latest, res.latest.groups || {}, rd); await writeFile(path.join(fdir, 'fehlbestand.json'), JSON.stringify(SV.withSchema('forecast', { generatedAt: new Date(now).toISOString(), forecastAt: res.latest.generatedAt ?? null, rows })));
              log(`Fehlbestand: ${rows.length} Gemeinde-Anbieter mit Lücke, ${rows.reduce((a, r) => a + r.missing, 0)} Fahrzeuge (${((Date.now() - t1) / 1000).toFixed(1)} s)`); } catch (e) { log(`Fehlbestand: ${e.message} – übersprungen`); } }
            const l = res.latest;
            // Korrekturen: Stand der Freigabe (lib/pulse-forecast-select.js CORR_GATE) – eine Zeile, damit der Wechsel im Lauf-Protokoll steht
            if (fam === 'micro') { const gs = (k, x) => (x?.gate ? `${k} ${x.applied ? 'eingerechnet' : x.gate.on ? 'frei' : `Probe (${x.gate.why}, ${x.gate.n}/${x.gate.need?.minN ?? '?'}${x.gate.ratio != null ? `, ${x.gate.ratio}` : ''})`}` : `${k} –`); log(`Prognose-Korrekturen: ${gs('Tageskorrektur', l.nowcast)}, ${gs('Störungskorrektur', l.stoerung)}${l.stoerung?.now ? ` in ${Object.keys(l.stoerung.now.c).length} gestörten Gemeinden` : ''}`); }
            log(`Prognose${fam === 'micro' ? '' : ` (${fam})`}: ${l.status}${l.active ? ` (${l.active}${l.weather.used ? ', mit Wetter' : ''}${l.env?.active?.length ? `, mit ${l.env.active.join(', ')}` : ''})` : ''}, ${l.trainDays} Tage Training, ${l.evalDays} ausgewertet, ${Object.keys(l.groups).length} Gruppen, Gedächtnis ${l.memory?.days ?? 0} Tage, ${Date.now() - t0} ms`);
          } catch (e) { if (fam === 'micro') throw e; log(`Prognose (${fam}): ${e.message} – alte Dateien bleiben`); }
        }
      } else {
        // zwischen zwei Prognose-Läufen: neuen Chronos-Lauf (viermal täglich) trotzdem in die Stundenreihen übernehmen, nur Feld c
        const tsfmUrl = process.env.TSFM_URL ?? `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || 'fcou1005/mobility-pulse'}/tsfm/chronos.json`;
        const famSeries = []; for (const fam of FC.FAMILIES) { const f = path.join(DATA, FC.FAMILY_DIR[fam], 'series.json'), ser = await rd(f); if (ser?.version === 1) famSeries.push([fam, f, ser]); }
        if (tsfmUrl && famSeries.length) {
          const r = await fetchJson(tsfmUrl);
          if (r.ok && r.json?.version === 1 && r.json.groups) for (const [fam, f, ser] of famSeries) if (r.json.at !== ser.chronos?.at || !ser.chronos?.backDays) { CH.chronosSeries(ser, r.json); await writeFile(f, JSON.stringify(SV.withSchema('forecast', ser))); log(`Chronos: Stundenreihen${fam === 'micro' ? '' : ` (${fam})`} auf den Lauf ${r.json.at} gebracht`); }
        }
      }
    } catch (e) { log(`Prognose: ${e.message} – alte Dateien bleiben`); }
  }
  // Langzeitarchiv der Trainingsdaten (lib/pulse-train.js, Audit DAT-01): je abgeschlossenem Ortstag train/<JJJJ>/<Tag>.json.gz, einmal geschrieben,
  // nie geändert; holt fehlende Tage nach (höchstens TRAIN.perRun je Lauf), solange events/ sie noch hat. Nur in Läufen mit Prognose (Kennzeichen
  // wie in der Prognose). weather-fc/ (gesicherte Vorhersagen) 40 Tage. TRAIN=0 = aus. Ohne Wirkung auf Prognose und Chronos.
  // Eingriffe der Anbieter und Ausfälle je abgeschlossenem Ortstag (lib/pulse-train.js opsSignals) → eingriffe.json (120 Tage) und train/ (ops)
  const opsByDay = new Map();
  ctx.opsByDay = opsByDay;
}

/** Eingaben der Spot-Bewertung aus dem Datenstand: Flotte je Land (ops/<Land>.json), Nachfrage der letzten 7 Tage (cells/<Tag>/<Land>.json), Einsatzorte (groups/), Stationsbestand */
async function gapRows(DATA, latest, groups, rd) {
  const landOf = (ags) => latest?.municipalities?.[ags]?.state ?? null, lands = new Set(Object.keys(groups).map(k => landOf(k.split('|')[0])).filter(Boolean));
  const fleets = new Map(), cellDocs = new Map(), list = existsSync(path.join(DATA, 'cells')) ? (await readdir(path.join(DATA, 'cells'))).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-7) : [];
  for (const land of lands) { const f = await rd(path.join(DATA, 'ops', `${land}.json`)); fleets.set(land, f ? OPS.decodeFleet(f) : null); const ds = []; for (const d of list) { const c = await rd(path.join(DATA, 'cells', d, `${land}.json`)); if (c) ds.push(c); } cellDocs.set(land, ds); }
  const idx = await rd(path.join(DATA, 'groups', 'index.json')), gdocs = [];
  if (Array.isArray(idx?.months)) for (const m of idx.months) { const g = await rd(path.join(DATA, 'groups', `${m}.json`)); if (Array.isArray(g?.events)) gdocs.push(g); }
  else { const g = await rd(path.join(DATA, 'groups.json')); if (Array.isArray(g?.events)) gdocs.push(g); }
  const quota = await rd(path.join(DATA, 'stations-quota.json')), dem = new Map();
  const demandOf = (land, ags) => { if (!dem.has(ags)) { const ds = cellDocs.get(land) || [], m = ds.length ? OPS.buildDemandModel(ds, ags, 'day') : null; dem.set(ags, m?.hours > 0 ? m : null); } return dem.get(ags); };
  return FB.shortageRows({ groups, landOf, fleetOf: (land) => fleets.get(land) ?? null, demandOf, placesOf: (ags) => OPS.groupPlaces(gdocs, { ags }), quota });
}
