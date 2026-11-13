// Sammler, Phase „kalender-wetter“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as T from '../../lib/pulse-track.js';
import * as E from '../../lib/pulse-econ.js';
import * as CX from '../../lib/pulse-context.js';
import * as TR from '../../lib/pulse-train.js';

export async function run(ctx) {
  const { DATA, fetchJson, log, muniOut, now } = ctx;
  ctx.incidentDocs = incidentDocs;
  ctx.writeIncidents = writeIncidents;
  // Tagtyp-Kalender (calendar.json, Format in lib/pulse-econ.js calendarFromApi): gesetzliche Feiertage und Schulferien je Land aus der
  // OpenHolidays API (ODbL), einmal je Berliner Kalendertag, Zeitraum heute −400 bis +400 Tage (eine Anfrage je Endpunkt; 800 Tage am
  // 02.11.2026 geprüft). Ohne Netz, bei Fehler oder unplausibler Antwort bleibt die alte Datei. CALENDAR_URL leer = aus (Fixture-Test).
  {
    const base = process.env.CALENDAR_URL ?? 'https://openholidaysapi.org', f = path.join(DATA, 'calendar.json'), today = T.dayOf(now);
    let old = null; try { old = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null; } catch { old = null; }
    if (base && !(old?.version === 1 && Number.isFinite(Date.parse(old.generatedAt)) && T.dayOf(Date.parse(old.generatedAt)) === today)) {
      const iso = (ms) => new Date(ms).toISOString().slice(0, 10), mid = Date.parse(`${today}T12:00:00Z`);
      const from = iso(mid - 400 * 86400e3), to = iso(mid + 400 * 86400e3), q = `countryIsoCode=DE&languageIsoCode=DE&validFrom=${from}&validTo=${to}`;
      try {
        const [p, s] = await Promise.all([fetchJson(`${base}/PublicHolidays?${q}`, { retry: 0 }), fetchJson(`${base}/SchoolHolidays?${q}`, { retry: 0 })]);
        const cal = p.ok && s.ok ? E.calendarFromApi(p.json, s.json, { from, to, at: now }) : null;
        if (cal) { await writeFile(f, JSON.stringify(cal)); log(`Kalender ${from}–${to}: ${Object.keys(cal.states).length} Länder, ${Object.values(cal.states).reduce((a, x) => a + Object.keys(x).length, 0)} Ausnahmetage`); }
        else log(`Kalender: keine gültige Antwort (Feiertage ${p.ok ? `${(p.json || []).length} Einträge` : p.error || `HTTP ${p.status}`}, Ferien ${s.ok ? `${(s.json || []).length} Einträge` : s.error || `HTTP ${s.status}`}) – ${old ? 'alte Datei bleibt' : 'keine Datei'}`);
      } catch (e) { log(`Kalender: ${e.message} – ${old ? 'alte Datei bleibt' : 'keine Datei'}`); }
    }
  }
  // Umgebungsereignisse (incidents/<Ortstag>.json, lib/pulse-context.js): vorhandene Dateien lesen, ergänzen, schreiben
  const incidentDir = path.join(DATA, 'incidents');
  ctx.incidentDir = incidentDir;
  async function incidentDocs(dayList) {
    const m = new Map();
    for (const d of new Set(dayList)) { const f = path.join(incidentDir, `${d}.json`); try { m.set(d, existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : CX.emptyIncidentDoc(d)); } catch { m.set(d, CX.emptyIncidentDoc(d)); } }
    return m;
  }
  async function writeIncidents(docs) { await mkdir(incidentDir, { recursive: true }); for (const [d, doc] of docs) { doc.updatedAt = new Date(now).toISOString(); await writeFile(path.join(incidentDir, `${d}.json`), JSON.stringify(doc)); } }
  // Wetter-Cache (weather/<UTC-Tag>.json): stündlich Temperatur, Niederschlag, Wind, Sonnenschein je 0,5°-Rasterzelle über den Gemeinden mit
  // Flotte (Schwerpunkt aus den Grenzen), DWD-Beobachtungen über Bright Sky. Zweck: eine Wetterreihe aufbauen, die später ein wetterbereinigtes
  // Modell speist (je früher der Verlauf beginnt, desto früher trägt es). Höchstens einmal je 50 Minuten, gestern und heute (UTC) als Beobachtung, morgen als Vorhersage;
  // bei Fehler bleibt die alte Datei. WEATHER_URL leer = aus (Fixture-Test). Werte außerhalb des plausiblen Bereichs werden null.
  // Seit 6.11.2026: fehlende Tage im Fenster der Prognose (Ortstage der Ereignisdateien, höchstens 23 Tage zurück) werden im selben Abruf nachgeholt
  // (die Reihe begann erst am 3.11., die Tage davor hatten kein Wetter und hielten das Wetter-Gate zu). Im selben Takt die DWD-Warnungen je Zelle
  // (Bright Sky /alerts) → incidents/<Ortstag>.json (lib/pulse-context.js).
  {
    const base = process.env.WEATHER_URL ?? 'https://api.brightsky.dev', dir = path.join(DATA, 'weather');
    const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10), days = [utcDay(now - 86400e3), utcDay(now)], wDays = [...days, utcDay(now + 86400e3)]; // morgen: DWD-Vorhersage (MOSMIX), wird am Folgetag durch Beobachtungen ersetzt
    const fileOf = (d) => path.join(dir, `${d}.json`);
    let stale = false;
    for (const d of days) { try { const o = existsSync(fileOf(d)) ? JSON.parse(await readFile(fileOf(d), 'utf8')) : null; if (!o || !(now - Date.parse(o.generatedAt) < 50 * 60e3)) stale = true; } catch { stale = true; } }
    const dayFiles = async (d) => (existsSync(d) ? (await readdir(d)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)) : []);
    const back = CX.weatherBackfillDays((await dayFiles(path.join(DATA, 'events'))).sort().slice(-21), await dayFiles(dir), utcDay(now));
    if (back.length) { stale = true; wDays.unshift(...back); }
    if (base && stale && ctx.boundaries) {
      const cellOf = (c) => `${(Math.round(c[0] * 2) / 2).toFixed(1)}|${(Math.round(c[1] * 2) / 2).toFixed(1)}`;
      const cells = new Map(), agsCell = {};
      for (const [ags, m] of Object.entries(muniOut)) if (m.c && Number.isFinite(m.c[0]) && Number.isFinite(m.c[1]) && Object.values(m.operators || {}).length) { const k = cellOf(m.c); agsCell[ags] = k; if (!cells.has(k)) cells.set(k, m.c); }
      const num = (x, lo, hi, d = 1) => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x * 10 ** d) / 10 ** d : null);
      try {
        await mkdir(dir, { recursive: true });
        const keys = [...cells.keys()], res = {}; let fails = 0;
        for (let i = 0; i < keys.length; i += 4) await Promise.all(keys.slice(i, i + 4).map(async (k) => {
          const [lat, lon] = cells.get(k).map(x => Math.round(x * 100) / 100); // Abfrage am Schwerpunkt der ersten Gemeinde der Zelle (Zelle nur zum Zusammenfassen)
          const r = await fetchJson(`${base}/weather?lat=${lat}&lon=${lon}&date=${back[0] ?? days[0]}&last_date=${utcDay(now + 2 * 86400e3)}&tz=UTC&units=dwd`, { retry: 0 });
          if (r.ok && Array.isArray(r.json?.weather)) res[k] = r.json.weather; else fails++;
        }));
        let wrote = 0;
        for (const d of wDays) {
          const hours = Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00:00Z`), out = {};
          for (const [k, rows] of Object.entries(res)) {
            const by = new Map(rows.map(w => [Date.parse(w.timestamp), w])), col = (f, lo, hi, dg) => hours.map(h => num(by.get(Date.parse(h))?.[f], lo, hi, dg));
            const t = col('temperature', -45, 55), p = col('precipitation', 0, 250), w = col('wind_speed', 0, 250), s = col('sunshine', 0, 60, 0);
            if ([t, p].some(a => a.some(x => x != null))) out[k] = { lat: cells.get(k)[0], lon: cells.get(k)[1], t, p, w, s };
          }
          // Audit DAT-08: die Vorhersage eines Tages (geschrieben vor seinem Beginn, MOSMIX) wird hier durch Beobachtungen ersetzt – vorher als
          // weather-fc/<Tag>.json sichern (letzter Stand vor dem Tag, ohne Wirkung auf die Prognose; Langzeit in train/, siehe lib/pulse-train.js)
          if (Object.keys(out).length && d <= utcDay(now) && existsSync(fileOf(d))) { try { const old = JSON.parse(await readFile(fileOf(d), 'utf8')), ff = path.join(DATA, 'weather-fc', `${d}.json`); if (TR.isForecastDoc(old) && !existsSync(ff)) { await mkdir(path.dirname(ff), { recursive: true }); await writeFile(ff, JSON.stringify(old)); } } catch {} }
          if (Object.keys(out).length) { await writeFile(fileOf(d), JSON.stringify({ version: 1, day: d, generatedAt: new Date(now).toISOString(), source: 'DWD Open Data via Bright Sky', units: { t: '°C', p: 'mm/h', w: 'km/h', s: 'min/h' }, hours, cells: out, ags: agsCell })); wrote++; }
        }
        log(`Wetter: ${keys.length} Rasterzellen, ${wrote} Tagesdatei(en)${back.length ? ` (nachgeholt: ${back.join(', ')})` : ''}${fails ? `, ${fails} Abrufe ohne Antwort` : ''}`);
        // DWD-Warnungen je Zelle (Beginn/Ende → Ortsstunden, auch die kommenden); Fehler lassen die Dateien unverändert
        const alerts = {}; let afails = 0; const aUntil = Date.now() + 45e3; // höchstens 45 s, danach mit dem Stand weiter
        for (let i = 0; i < keys.length && Date.now() < aUntil; i += 4) await Promise.all(keys.slice(i, i + 4).map(async (k) => {
          const [lat, lon] = cells.get(k).map(x => Math.round(x * 100) / 100), r = await fetchJson(`${base}/alerts?lat=${lat}&lon=${lon}`, { retry: 0 });
          if (r.ok && Array.isArray(r.json?.alerts)) alerts[k] = r.json.alerts.map(a => ({ status: a.status, severity: a.severity, onset: a.onset, effective: a.effective, expires: a.expires })); else afails++;
        }));
        if (Object.keys(alerts).length) { const docs = await incidentDocs([T.dayOf(now - 3 * 3600e3), T.dayOf(now), T.dayOf(now + 86400e3), T.dayOf(now + 2 * 86400e3)]), n = CX.addAlerts(docs, alerts, agsCell, now);
          for (const d of docs.values()) d.sources.warn = { at: new Date(now).toISOString(), cells: Object.keys(alerts).length };
          await writeIncidents(docs); log(`Warnungen (DWD): ${Object.values(alerts).reduce((a, l) => a + l.length, 0)} aktiv in ${Object.keys(alerts).length} Zellen, ${n} Gemeinde-Stunden neu${afails ? `, ${afails} Abrufe ohne Antwort` : ''}`); }
      } catch (e) { log(`Wetter: ${e.message} – alte Dateien bleiben`); }
    }
  }
}
