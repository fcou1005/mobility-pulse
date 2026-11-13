// Sammler, Phase „abschluss“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as T from '../../lib/pulse-track.js';
import * as FE from '../../lib/pulse-flowest.js';
import * as SS from '../../lib/pulse-status.js';

export async function run(ctx) {
  const { DATA, HEALTH, PH, RULE, catalog, ds, dv, failing, latest, log, now, sourceOut, statusCounts, tr } = ctx;
  // Namensnennung und Lizenzen des Datenstands (DATA-LICENSE.md im Datenzweig)
  {
    const md = (x) => String(x ?? '').replace(/[\r\n|]+/g, ' ').replace(/[<>]/g, '').replace(/([\[\]`*_\\])/g, '\\$1').trim(); // Text aus Feeds entschärfen (Markdown/HTML)
    const counted = sourceOut.filter(r => ['live', 'delayed', 'stale'].includes(r.status));
    const byLic = new Map();
    for (const r of counted) { const k = r.licenseId || r.licenseUrl || 'ohne Angabe'; if (!byLic.has(k)) byLic.set(k, []); byLic.get(k).push(r); }
    const lic = [...byLic].sort((a, b) => b[1].length - a[1].length);
    const sa = counted.filter(r => /^CC-BY-SA/.test(r.licenseId || ''));
    const noLic = counted.filter(r => !r.licenseId && !r.licenseUrl), badLic = counted.filter(r => !r.licenseId && /privacy|datenschutz/i.test(r.licenseUrl || ''));
    const lines = [
      '# Daten und Lizenzen', '',
      `Stand: ${new Date(now).toISOString()} · erzeugt vom Sammler (scripts/collect.mjs) bei jedem Lauf.`, '',
      'Dieser Datenzweig enthält aus offenen Quellen abgeleitete Daten: Bestände, Ereignisse (Fahrten, Umsetzungen, Akkutausch), Zellen, Archiv und Momentaufnahmen. Die Lizenzangaben stammen aus den Feeds (GBFS `system_information`: `license_id`, `license_url`, `attribution_organization_name`) bzw. aus den Verzeichnissen; maßgeblich sind die Bedingungen der jeweiligen Quelle. Je Quelle stehen sie auch in `latest.json` → `sources[]` (`licenseId`, `licenseUrl`, `attribution`, `attributionUrl`).', '',
      '## Veröffentlichung von Ereignissen und Zellen', '',
      'Ereignisse (`events/<Tag>.json`) erscheinen für den laufenden Tag erst nach Stundenende und enthalten nur abgeschlossene Stunden. Zellen (`cells/<Tag>/<Land>.json`) erscheinen erst nach dem Ende eines Tageszeit-Bands und enthalten nur abgeschlossene Bänder. Nach Tagesende folgen beide vollständig (`published.complete`). In Zellendateien ist jede Zelle × Band mit weniger als 3 Ereignissen (Fahrtbeginne + Fahrtenden) unterdrückt; diese Summen stehen je Gemeinde in `below`. Läge dort weniger als 3 (also womöglich eine einzelne Zelle), fällt zusätzlich die kleinste veröffentlichte Zelle des Bands in `below` (`suppress: 2`). Start-Ziel-Ströme (`flows/<Tag>.json`) erscheinen erst nach Tagesende und nur für Zellenpaare mit mindestens ' + T.FLOW_MIN + ' Fahrten am Tag; Wochensummen (`flows-week/<Montag>.json`, 500-m-Zellen) erst nach Ende der Kalenderwoche, ebenfalls ab ' + T.FLOW_MIN + ' Fahrten je Zeile; geschätzte Ströme (`flows-est/`) ab ' + FE.EST_MIN + ' erwarteten Fahrten aus mindestens ' + FE.EST_SUPPORT + ' Fahrtbeginnen. Fahrzeugkennungen werden nicht veröffentlicht; sie bleiben privat (HMAC mit privatem Salt). Dieselben Ereignisse stehen je Land unter `events/<Tag>/<Land>.json`, als Tagessummen je Gruppe in `events/daily-summary.json` und als Stundensummen in `events/hour-totals.json`; die Zellen einer Gemeinde der letzten 7 Tage für die Disposition unter `ops-input/<AGS>.json` (gleiche Unterdrückung wie die Landesdateien).', '',
      '## Live-Bestand und Momentaufnahmen', '',
      'Veröffentlicht wird der jeweils letzte Bestand ohne Kennung: `ops/<Land>.json` (je sichtbarem Fahrzeug Position, Anbieter, Art, Ladestand, Reichweite, Standzeit-Klasse) und `snapshot/<Quelle>.json` (Bestand von Quellen, die der Browser nicht selbst lesen kann). Reichweite in ganzen km (Quellen mit eigener Reichweiten-Skala: 0,1 km). Die Standzeit erscheint nur als Klasse: unter 6 h, 6–24 h, danach ganze Tage (auch `idle-long.json`). Eine minutengenaue Standzeit zeigte, wann an einer Adresse die letzte Fahrt endete. Frühere Bestände bleiben nicht im Datenzweig (ein Commit je Lauf ohne Vorgänger).', '',
      '## Grundlagen', '',
      `- Gemeindegrenzen: ${md(ctx.boundaries?.attribution || '© GeoBasis-DE / BKG, VG250')} – Lizenz Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0, https://www.govdata.de/dl-de/by-2-0).`,
      '- Umgebung (`context/`: ÖPNV-Haltepunkte, Abstellflächen): © OpenStreetMap-Mitwirkende, Open Database License 1.0 (ODbL, https://opendatacommons.org/licenses/odbl/1-0/).',
      '- Wetter-Cache (`weather/<Tag>.json`): Beobachtungen und Vorhersage (MOSMIX) des Deutschen Wetterdienstes (DWD Open Data), abgerufen über Bright Sky (https://brightsky.dev). Quelle: Deutscher Wetterdienst; Nutzungsbedingungen des DWD gelten (Quellenvermerk-Wortlaut noch nicht amtlich geprüft).',
      '- Umgebungsereignisse (`incidents/<Tag>.json`, nur Kennzeichen je Gemeinde und Stunde, keine Meldungstexte): Wetterwarnungen des Deutschen Wetterdienstes (DWD Open Data, über Bright Sky); Sperrungen und Staus auf Autobahnen aus der Verkehrsinformation der Autobahn GmbH des Bundes (verkehr.autobahn.de; ausdrückliche Nutzungsbedingungen der Schnittstelle nicht gefunden, Quelle: Die Autobahn GmbH des Bundes). Streiks und Veranstaltungen aus der gepflegten Liste `data/ereignisse.json` im Code-Zweig (je Eintrag mit Quelle).',
      '- Termine aus den Quellenseiten (Branch `termine`, `termine.json`; in `ereignisse.json` mit `auto: true`): offizielle Seiten von Volksfesten, Messen, Stadien und Festen aus `data/termin-quellen.json`, wöchentlich im Workflow „Termine“ gelesen (Regeln, sonst ein kleines lokales Sprachmodell); je Termin der Link zur Quelle.',
      '- Streiks im Nahverkehr und bei der Bahn (`streiks.json`): im Sammler automatisch erkannt aus der Nachrichtensuche der tagesschau-App (www.tagesschau.de/api2u, mit den Regionalmeldungen der ARD-Anstalten); gespeichert sind nur abgeleitete Angaben (Art, Tage, Gebiet, erkannte Orte und Betriebe) und der Link zur jeweiligen Meldung, keine Meldungstexte. Nutzung: Die Schnittstelle ist vom Anbieter nicht öffentlich dokumentiert, die Inhalte sind laut Beschreibung für den privaten Gebrauch; eine kommerzielle Nutzung ist ungeklärt (vor bezahlten Aufträgen klären oder mit leerem `STRIKE_URL` abschalten).',
      '- Veranstaltungsorte und Termine (`veranstaltungen.json`): Orte mit Kapazität aus Wikidata (CC0 1.0); Termine (Name, Beginn, Ort, Link) aus den öffentlichen Programmseiten und Kalendern der Orte (Quelle je Termin verlinkt; `data/veranstaltungskalender.json`), höchstens 60 Tage behalten.',
      '- Sport-Ereignisse (`sport.json`: Heimspiele 1.–3. Liga mit Anstoßzeit, daraus Veranstaltungen je Stadion-Gemeinde): Spielpläne aus OpenLigaDB (https://www.openligadb.de), Open Database License 1.0 (ODbL); `sport.json` steht unter der ODbL 1.0.',
      '- Prognose (`forecast/latest.json`, `forecast/log.json`, `forecast/series.json`; E-Roller und Carsharing je mit eigenem Modell in `forecast/moped/` und `forecast/car/`): abgeleitet aus den Ereignissen dieses Datenstands, dem Tagtyp-Kalender, dem Wetter-Cache und den Umgebungsereignissen; statistisches Modell des Projekts, keine Betreiberdaten.',
      '- Baustellen in Städten (`incidents/<Tag>.json` → `works`, nur Zahl frischer Vollsperrungen je Gemeinde und Stunde): MobiData BW (Baustellen BEMaS), Freie und Hansestadt Hamburg (Behörde für Verkehr und Mobilitätswende), Landeshauptstadt München; jeweils Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2.0).',
      '- ÖPNV-Störungen (`incidents/<Tag>.json` → `ptN`, `ptSkip`, `ptLate`, `pt`: Halte mit Echtzeit, ausgefallene und verspätete Halte je Gemeinde und Stunde; `oepnv/haltestellen.json.gz`: Haltestelle → Gemeinde): abgeleitet aus dem GTFS-Realtime-Strom von gtfs.de (Creative Commons BY-SA 4.0, https://gtfs.de/de/realtime/, Datengeber dort aufgeführt) und dem freien deutschlandweiten GTFS-Feed von gtfs.de (Creative Commons BY 4.0). Die abgeleiteten ÖPNV-Felder stehen deshalb unter CC BY-SA 4.0.',
      '- Trainingsarchiv (`train/<Jahr>/<Tag>.json.gz`, `train-cells/<Jahr>/<Jahr>-W<KW>.json.gz`, `weather-fc/<Tag>.json`): dauerhafte Ablage der oben genannten Tagesdaten (Stundenwerte je Gemeinde, Anbieter und Fahrzeugart; Wochensummen der veröffentlichten Zellen; Wetter samt der ausgegebenen Vorhersage), abgeleitet aus denselben Quellen und unter denselben Bedingungen weiterzugeben (Namensnennung; bei CC-BY-SA-Quellen Weitergabe unter gleichen Bedingungen; Kalender ODbL). Keine Fahrzeugkennungen, keine Fahrzeugkoordinaten; Gruppen mit 1–2 Fahrtbeginnen am Tag nur als Tagessumme.',
      '- Tagtyp-Kalender (`calendar.json`: gesetzliche Feiertage und Schulferien je Land): OpenHolidays API (https://www.openholidaysapi.org), Open Database License 1.0 (ODbL); `calendar.json` steht unter der ODbL 1.0.',
      '- Verzeichnisse: MobilityData GBFS systems.csv, MobiData BW, MOBIDROM NRW, CityBikes, Betreiber-Direktfeeds.', '',
      '## Quellen nach Lizenz', '',
      `${counted.length} Quellen mit Daten in diesem Stand (Kopien anderer Quellen und nicht erreichbare Quellen ausgenommen).`, '',
      '| Lizenz | Quellen | Namensnennung / Anbieter |', '|---|---|---|',
      ...lic.map(([k, list]) => { const names = [...new Set(list.map(r => r.attribution || r.systemOperator || r.operator).filter(Boolean).map(md))]; const url = list.find(r => r.licenseUrl)?.licenseUrl; return `| ${md(k)}${url && url !== k ? ` (${md(url)})` : ''} | ${list.length} | ${names.slice(0, 25).join(', ')}${names.length > 25 ? ` u. a. (${names.length})` : ''} |`; }),
      '', '## Weitergabe unter gleichen Bedingungen', '',
      sa.length ? `${sa.length} Quellen stehen unter CC BY-SA (${[...new Set(sa.map(r => md(r.operator)))].join(', ')}). Daten, die aus diesen Quellen abgeleitet sind (Bestände, Ereignisse, Zellen, Archiv der betroffenen Gebiete und Anbieter), stehen unter CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).` : 'In diesem Stand liefert keine Quelle Daten unter CC BY-SA.',
      'Aus OpenStreetMap abgeleitete Datenbankteile (`context/`) stehen unter der ODbL 1.0.',
      '', `Quellen ohne Lizenzangabe sind oben als „ohne Angabe“ geführt (${noLic.length}${noLic.length ? `: ${[...new Set(noLic.map(r => md(r.operator)))].join(', ')}` : ''}). Ihre Lizenz ist ungeklärt; sie gelten hier nicht als gemeinfrei (CC0). Maßgeblich sind die Nutzungsbedingungen des jeweiligen Betreibers bzw. Verzeichnisses.`,
      ...(badLic.length ? [`Bei ${badLic.length} Quelle${badLic.length === 1 ? '' : 'n'} (${[...new Set(badLic.map(r => md(r.operator)))].join(', ')}) führt der Lizenz-Link zu einer Datenschutzerklärung, nicht zu einer Lizenz: Lizenz ebenfalls ungeklärt.`] : []), '',
    ];
    await writeFile(path.join(DATA, 'DATA-LICENSE.md'), lines.join('\n'));
  }
  // Sammler-Monitor: ein Eintrag je Lauf, 7 Tage (Lücken, Ausfälle, Zählungen)
  {
    const f = path.join(DATA, 'runs.json');
    const doc = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : { runs: [] };
    doc.fields = ['at', 'dauer_ms', 'quellen', 'aktuell', 'verzoegert', 'veraltet', 'fehler', 'fahrzeuge', 'stationen', 'fahrten', 'fahrtenden', 'kennungswechsel', 'ausloeser', 'zaehlt', 'regelstand'];
    const st = statusCounts;
    // zaehlt: 1 = Lauf zählt Ereignisse, 0 = Lauf nach Lücke bzw. Umzugslauf (ohne Zählung); regelstand wie events/<Tag>.json → runs[k][3]
    doc.runs.push([now, Date.now() - now, sourceOut.length, st.live || 0, st.delayed || 0, st.stale || 0, failing, dv.vehicles.length, ds.stations.length, ctx.runEv?.start ?? null, ctx.runEv?.end ?? null, ctx.runEv?.rot ?? null, process.env.GITHUB_EVENT_NAME || 'lokal', tr.gap ? 0 : 1, RULE]);
    doc.runs = doc.runs.filter(r => now - r[0] <= 7 * 86400e3).slice(-600);
    await writeFile(f, JSON.stringify(doc));
    // Ausfall-Wächter (HEALTH_FILE, z. B. für Healthchecks.io im Workflow): Zeile 1 „ok“ oder „fail“, Zeile 2 Grund. „fail“, wenn weniger als
    // HEALTH.minShare der Quellen aktuell oder verzögert liefern als im Median der letzten 7 Tage (grüner Lauf mit Teilausfall)
    if (process.env.HEALTH_FILE) {
      const okOf = (r) => (r[3] || 0) + (r[4] || 0), prev = doc.runs.slice(0, -1).map(okOf).sort((a, b) => a - b);
      const med = prev.length >= 12 ? prev[Math.floor(prev.length / 2)] : null, cur = okOf(doc.runs[doc.runs.length - 1]);
      // Audit OPS-01: auch die Fahrzeugzahl (8.11.: −29 % Fahrzeuge bei „grünem“ Lauf, weil ein ganzes Verzeichnis fehlte)
      const vPrev = doc.runs.slice(0, -1).map(r => r[7] || 0).filter(v => v > 0).sort((a, b) => a - b), vMed = vPrev.length >= 12 ? vPrev[Math.floor(vPrev.length / 2)] : null, vCur = doc.runs[doc.runs.length - 1][7] || 0;
      const failSrc = med != null && cur < HEALTH.minShare * med, failVeh = vMed != null && vCur < HEALTH.minVehShare * vMed, fail = failSrc || failVeh;
      await writeFile(process.env.HEALTH_FILE, `${fail ? 'fail' : 'ok'}\n${cur} Quellen aktuell/verzögert${med != null ? ` (Median 7 Tage ${med}, Schwelle ${Math.ceil(HEALTH.minShare * med)})` : ''} · ${dv.vehicles.length} Fahrzeuge${vMed != null ? ` (Median ${vMed}, Schwelle ${Math.ceil(HEALTH.minVehShare * vMed)})` : ''}${catalog.catalogFallback?.length ? ` · Verzeichnis nicht erreichbar: ${catalog.catalogFallback.map(x => x.dir).join(', ')}` : ''} · ${((Date.now() - now) / 1000).toFixed(0)} s\n`);
    }
  }
  // status.json v2 (S3.2): Laufzeit, Zeit je Phase, Budget und Trend aus runs.json; RUNTIME_FILE für den Workflow (Issue „laufzeit“)
  {
    const runsDoc = existsSync(path.join(DATA, 'runs.json')) ? JSON.parse(await readFile(path.join(DATA, 'runs.json'), 'utf8')) : null;
    const sd = SS.statusDoc({ at: now, generatedAt: new Date(now).toISOString(), runMs: Date.now() - now, phases: PH.list(true), counts: latest.counts, byStatus: statusCounts, runs: runsDoc?.runs || null });
    await writeFile(path.join(DATA, 'status.json'), JSON.stringify(sd));
    if (process.env.RUNTIME_FILE) await writeFile(process.env.RUNTIME_FILE, SS.runtimeLine(sd));
    log(`Laufzeit ${(sd.runMs / 1000).toFixed(0)} s (${sd.level}) · längste Phasen: ${sd.phases.slice().sort((x, y) => y[1] - x[1]).slice(0, 4).map(([n, ms]) => `${n} ${(ms / 1000).toFixed(1)} s`).join(', ')}${sd.trend?.ratio != null ? ` · Trend ${sd.trend.ratio}×` : ''}`);
  }
  log(`fertig in ${((Date.now() - now) / 1000).toFixed(1)} s · Status:`, JSON.stringify(statusCounts));
}
