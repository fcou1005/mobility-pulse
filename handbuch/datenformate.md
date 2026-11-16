# Datenformate

Erzeugt aus `schemas/*.schema.json` mit `node scripts/schemas-doc.mjs` – nicht von Hand ändern. Jede Datei dieser Familien trägt vorn
`schemaVersion` („MAJOR.MINOR“). Neue Felder erhöhen MINOR, ein weggefallenes Feld oder eine geänderte Bedeutung MAJOR; passt die
MAJOR-Version nicht zur Seite, zeigt das Dashboard einen Hinweis. Geprüft wird mit `node test/schema.mjs` (Fixture) und
`node test/schema.mjs <Checkout des Branches data>`. Felder, die hier nicht stehen, sind erlaubt, aber nicht zugesichert.

| Familie | Version | Dateien |
| --- | --- | --- |
| [status](#status) | 2.0 | `status.json` |
| [latest](#latest) | 1.1 | `latest.json` |
| [sources](#sources) | 1.0 | `sources.json` |
| [history](#history) | 1.0 | `history/index.json`, `history/<Tag>.json` |
| [events](#events) | 1.1 | `events/index.json`, `events/<Tag>.json`, `events/<Tag>/<Land>.json`, `events/hour-totals.json`, `events/daily-summary.json` |
| [cells](#cells) | 1.1 | `cells/<Tag>/<Land>.json` |
| [ops](#ops) | 1.4 | `ops/<Land>.json`, `ops-input/<AGS>.json`, `ops-input/index.json`, `ops-input/fleet/<AGS>.json`, `ops-input/fleet/index.json` |
| [boundaries](#boundaries) | 1.0 | `boundaries/index.json`, `boundaries/<Land>.json` |
| [calib](#calib) | 1.0 | `calib.json` |
| [forecast](#forecast) | 1.1 | `forecast/latest.json`, `forecast/log.json`, `forecast/series.json`, `forecast/dispo.json`, `forecast/moped/…`, `forecast/car/…` |
| [auflagen](#auflagen) | 1.1 | `auflagen/verfuegbarkeit-<Jahr>.json`, `auflagen/alarme.json` |
| [markt](#markt) | 1.1 | `index/<JJJJ-MM>.json`, `index/laufend.json`, `index/index.json`, `markt/wirkung.json`, `markt/scout.json`, `grafik/index.json`, `offen/index.json` |
| [akku](#akku) | 1.3 | `akku/<AGS>.json`, `akku/bewertung.json` |
| [geo](#geo) | 1.2 | `versorgung/<AGS>.json`, `versorgung/index.json`, `zubringer/index.json`, `abstell/<AGS>.json`, `unfall/<AGS>.json`, `unfall/index.json`, `umweg/<AGS>.json`, `umweg/index.json`, `pop/index.json` |
| [oepnv](#oepnv) | 1.4 | `oepnv/<AGS>.json`, `oepnv/live/<AGS>.json`, `oepnv/wirkung.json`, `oepnv/index.json` |

## status

status.json – Zustand des letzten Sammler-Laufs. Kleine Datei, die das Dashboard zuerst lädt: Zeitpunkt, Laufzeit, Phasen, Budget und Trend (S3.2).

Version 2.0 · Schema: [schemas/status.schema.json](../schemas/status.schema.json)

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^2\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `at` | ja | integer |
| `generatedAt` | ja | string (Muster `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`) |
| `complete` | ja | boolean |
| `runMs` |  | integer oder null |
| `level` |  | `"ok"` / `"warn"` / `"fail"` / `null` |
| `phases` | ja | array von array |
| `budget` | ja | object |
| `trend` |  | object oder null |
| `counts` |  | object oder null |
| `byStatus` |  | object oder null |

## latest

latest.json – Bestand des letzten Laufs. Quellen mit Status und Lizenz, Gemeinden, Gruppen je Gemeinde|Anbieter|Art, Summen und Messbasis. latest-core.json (S3.8 Rest): gleiche Datei mit Quellen nur aus den Kernfeldern und leeren groups (lite nennt sie), Start der Disposition.

Version 1.1 · Schema: [schemas/latest.schema.json](../schemas/latest.schema.json)

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `at` | ja | integer |
| `generatedAt` | ja | string (Muster `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`) |
| `runMs` |  | integer oder null |
| `counts` | ja | object |
| `thresholds` |  | object |
| `energy` |  | object |
| `sources` | ja | array von object |
| `municipalities` | ja | object |
| `groups` | ja | object |
| `totals` |  | object |
| `measure` |  | object |
| `presence` |  | object |
| `lite` |  | object – nur latest-core.json: sourceFields = enthaltene Felder je Quelle, groups = false (leer) |

## sources

sources.json – Quellenkatalog. Von scripts/build-catalog.mjs aus den Verzeichnissen gebaut; je Quelle Kennung, Anbieter, API und Adresse.

Version 1.0 · Schema: [schemas/sources.schema.json](../schemas/sources.schema.json)

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `generatedAt` | ja | string (Muster `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`) |
| `count` | ja | integer |
| `directories` |  | object |
| `sources` | ja | array von object |

## history

history/ – Bestandsverlauf je Tag. index.json listet die Tage; &lt;Tag&gt;.json hat je Gruppe (Gemeinde|Anbieter|Art) Reihen über die Laufzeitpunkte t.

Version 1.0 · Schema: [schemas/history.schema.json](../schemas/history.schema.json)

### history · index

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `days` | ja | array von string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `fields` | ja | array von string |
| `updatedAt` | ja | integer |

### history · day

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `day` | ja | string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `t` | ja | array von integer |
| `f` |  | array von `0` / `1` / `null` – je Zeitpunkt 1 = Lauf zählt, 0 = Lauf nach Lücke, null = vor Einführung des Feldes |
| `fields` | ja | array von string |
| `series` | ja | object |

## events

events/ – Ereignisse je Tag. index.json listet Tage mit Ereignissen und Zellen; &lt;Tag&gt;.json hat Läufe und je Gruppe Stundenreihen (Fahrtbeginne, Umsetzungen, …), nur abgeschlossene Stunden. Ab 1.1 (S3.8) zusätzlich &lt;Tag&gt;/&lt;Land&gt;.json (nur Gruppen des Landes, Feld state), hour-totals.json und daily-summary.json.

Version 1.1 · Schema: [schemas/events.schema.json](../schemas/events.schema.json)

### events · index

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `days` | ja | array von string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `cellDays` |  | array von string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `updatedAt` | ja | integer |
| `first` |  | boolean oder null |

### events · day

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `day` | ja | string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `runs` | ja | array von array |
| `groups` | ja | object |
| `hourMin` |  | array |
| `published` |  | object – Veröffentlichungsstand; fehlt in Dateien vor dem 2. November 2026 |
| `state` |  | string (Muster `^[A-Z]{2}$`) |

### events · hourTotals

je Tag Läufe und Σ Fahrtbeginne je Stunde über alle Gruppen: das Tagesgang-Profil (lib/pulse-econ.js hourProfile) ohne die Tagesdateien

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` | ja | integer |
| `at` | ja | integer |
| `latestAt` |  | integer oder null |
| `days` | ja | object |

### events · summary

Tagessummen je Gruppe (Gemeinde|Anbieter|Art): groups\[key\]\[i\] = Summen der Felder fields am Tag days\[i\] oder null

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` | ja | integer |
| `at` | ja | integer |
| `days` | ja | array von string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `fields` | ja | array von string |
| `groups` | ja | object |

## cells

cells/&lt;Tag&gt;/&lt;Land&gt;.json – Zellen je Tageszeit-Band. Je Gemeinde und Rasterzelle Summen je Band; Zellen mit weniger als minCount Ereignissen sind unterdrückt (Summen in below).

Version 1.1 · Schema: [schemas/cells.schema.json](../schemas/cells.schema.json)

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `day` | ja | string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `state` | ja | string (Muster `^[A-Z]{2}$`) |
| `bandMin` |  | array |
| `bandRuns` |  | array |
| `fields` | ja | string – Felder je Zelle: start,end,present,reloc,start×6,present×6,end×6; seit 1.1 (S6.3, 14.11.2026) dazu angebot×6 = Läufe mit mindestens einem verfügbaren Fahrzeug je Band (ältere Tage ohne diese Felder) |
| `munis` | ja | object |
| `below` |  | object |
| `minCount` | ja | integer |
| `suppress` |  | integer |
| `published` |  | object – Veröffentlichungsstand; fehlt in Dateien vor dem 2. November 2026 |

## ops

ops/&lt;Land&gt;.json – Bestand für die Disposition. ops/&lt;Land&gt;.json (Bestand je Land, $defs/state); ab 1.1 (S3.8) ops-input/&lt;AGS&gt;.json mit der Nachfrage-Eingabe der Disposition ($defs/input) und ops-input/index.json. Ab 1.2 ops-input/fleet/&lt;AGS&gt;.json (Bestand einer Gemeinde im Format von $defs/state, Feld ags) und ops-input/fleet/index.json.

Version 1.4 · Schema: [schemas/ops.schema.json](../schemas/ops.schema.json)

### ops · state

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `at` | ja | integer |
| `state` | ja | string (Muster `^[A-Z]{2}$`) |
| `types` | ja | array von string |
| `trackStart` |  | integer oder null |
| `vehicleFields` | ja | string |
| `stationFields` | ja | string |
| `ops` | ja | array von string |
| `munis` | ja | array von string (Muster `^\d{8}$`) |
| `vehicles` | ja | array von array von number / null |
| `stations` | ja | array von array |
| `ags` |  | string (Muster `^\d{8}$`) – nur in ops-input/fleet/&lt;AGS&gt;.json: die Gemeinde des Ausschnitts |

### ops · input

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` | ja | integer |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `state` | ja | string (Muster `^[A-Z]{2}$`) |
| `bbox` |  | null oder array von number |
| `cellDays` | ja | array von string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `cells` | ja | array von object |

### ops · inputIndex

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` | ja | integer |
| `at` | ja | integer |
| `cellDays` | ja | array von string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `ags` | ja | array von string (Muster `^\d{8}$`) |
| `compact` |  | integer – S3.8 Rest: Version von ops-input/cells/&lt;AGS&gt;.json, wenn die spaltenweise Datei für alle Gemeinden geschrieben ist |

### ops · fleetIndex

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` | ja | integer |
| `at` | ja | integer |
| `ags` | ja | array von string (Muster `^\d{8}$`) |

### ops · inputCompact

ops-input/cells/&lt;AGS&gt;.json (S3.8 Rest): Zellen wie ops-input/&lt;AGS&gt;.json, je Tag spaltenweise (cols: Zellschlüssel x, y als Differenzen in Originalreihenfolge, v je Feld ohne drop; seit 1.4 n = Werte je Zelle, wenn nicht 22 – 28 mit den Angebotsfeldern aus S6.3), dazu die Start-Ziel-Ströme der Gemeinde für die Zellen-Tage.

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` | ja | integer |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `state` | ja | string (Muster `^[A-Z]{2}$`) |
| `bbox` |  | null oder array von number |
| `cellDays` | ja | array von string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `cells` | ja | array von object |
| `flows` | ja | object |

### ops · area

ops-input/area/&lt;AGS&gt;.json (S3.8 Rest, je Lauf): Umsatz-Eingabe der Disposition (Vorauswahl-Tag, Ereignisse der Gemeinde, Tageswerte, Tarife je Anbieter|Art und Sprache vorab, kinds der Kalibrierung, Ersatz-Bestand), Gruppen-Ereignisse der Gemeinde über alle Monate, Zonen-Dateien je Anbieter (path = Ausschnitt ops-input/zones/…, null = ganze Dateien unter zones/). zones null: Zonen-Verzeichnis unvollständig.

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` | ja | integer |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `at` | ja | integer |
| `zonesAt` |  | null oder integer |
| `econ` |  | null oder object |
| `groups` |  | null oder object |
| `zones` |  | null oder object |
| `parking` |  | null oder object – amtliche Abstellflächen und Abstellverbote der Gemeinde aus sources.json → parking_reference (null: Katalog fehlte) |

### ops · areaCalib

ops-input/area/calib.json (S3.8 Rest): gemeinsamer Teil der Kalibrierung für die Umsatz-Eingabe, je Sprache assume, limits, k (wie calib.json).

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` | ja | integer |
| `at` | ja | integer |
| `langs` | ja | object |

### ops · zoneSlice

ops-input/zones/&lt;AGS&gt;/&lt;n&gt;.json (S3.8 Rest): Geofencing-Zonen eines Anbieters (GBFS, wie zones/&lt;Datei&gt;.json) für eine Gemeinde; Features außerhalb von cover (Rahmen ± 0,02° + 200 m) sind null, Index und Anzahl bleiben. full = ganze Datei laden.

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` | ja | integer |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `operator` | ja | string |
| `bbox` |  | array von number |
| `cover` | ja | array von number |
| `files` | ja | array von object |

## boundaries

boundaries/ – Gemeindegrenzen je Land. index.json mit Ländern und Begrenzungsrahmen je Gemeinde; &lt;Land&gt;.json als GeoJSON-FeatureCollection (BKG VG250, dl-de/by-2-0).

Version 1.0 · Schema: [schemas/boundaries.schema.json](../schemas/boundaries.schema.json)

### boundaries · index

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` |  | integer |
| `generatedAt` | ja | string (Muster `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`) |
| `attribution` |  | string |
| `license` |  | string |
| `bboxFields` |  | string |
| `states` | ja | object |

### boundaries · state

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `type` | ja | `"FeatureCollection"` |
| `state` | ja | string (Muster `^[A-Z]{2}$`) |
| `attribution` |  | string |
| `license` |  | string |
| `generatedAt` |  | string (Muster `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`) |
| `features` | ja | array von object |

## calib

calib.json – Kalibrierung. Vorgerechnete Kalibrierung (Faktor k je Gemeinde, Prüfwerte, Strukturbrüche) für Bericht und Prognose.

Version 1.0 · Schema: [schemas/calib.schema.json](../schemas/calib.schema.json)

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` |  | integer |
| `at` | ja | integer |
| `latestAt` |  | integer oder null |
| `days` | ja | array von string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `breaks` |  | object |
| `kinds` |  | object |
| `own` | ja | object |
| `langs` |  | object |

## forecast

forecast/ – Prognose. latest.json (nächste 24 Stunden, Güte, Entscheidung), log.json (Selbstprüfung, Live-Abgleich), series.json (Stundenreihen fürs Dashboard); gleiche Dateien je Fahrzeugfamilie in forecast/moped/ und forecast/car/.

Version 1.1 · Schema: [schemas/forecast.schema.json](../schemas/forecast.schema.json)

### forecast · latest

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` |  | integer |
| `generatedAt` | ja | string (Muster `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`) |
| `status` | ja | string |
| `active` |  | string oder null |
| `scores` |  | object oder null |
| `horizon` |  | object oder array oder null |
| `totals` |  | object oder array oder null |

### forecast · log

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` |  | integer |
| `evals` |  | object |
| `issued` |  | object |
| `live` |  | object |
| `history` |  | array |

### forecast · series

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `version` |  | integer |
| `generatedAt` | ja | string (Muster `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`) |
| `tz` | ja | string |
| `today` | ja | string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `tomorrow` | ja | string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `status` | ja | string |
| `active` |  | string oder null |
| `plans` |  | object |
| `days` | ja | object |

### forecast · dispo

Für die Disposition (seit 1.1): je Gemeinde die Prognose der nächsten 24 Stunden und das Mittel der gemessenen Fahrtbeginne derselben Ortsstunde an den letzten Tagen (baseDays), beide aus derselben Quelle; Faktor eines Tageszeit-Bands = Summe Prognose ÷ Summe Mittel

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) |
| `at` |  | string / null |
| `from` |  | number / null |
| `local` | ja | array von array |
| `baseDays` |  | array von string |
| `fields` |  | array von string |
| `ags` | ja | object |

## auflagen

auflagen/ – Datenauflagen-Check und Alarme. Jahresbuch der Feed-Verfügbarkeit je Quelle (auflagen/verfuegbarkeit-&lt;Jahr&gt;.json, S5.1) und Alarmprotokoll je Gemeinde (auflagen/alarme.json, S5.2; daraus die Atom-Feeds feeds/&lt;AGS&gt;.xml).

Version 1.1 · Schema: [schemas/auflagen.schema.json](../schemas/auflagen.schema.json)

### auflagen · ledger

Verfügbarkeit im Kalenderjahr: Läufe, verfügbare Läufe (aktuell oder leicht verzögert), Fehler – letzte Tage einzeln, ältere je Monat

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `year` | ja | integer – Kalenderjahr |
| `at` | ja | integer – Stand (ms seit 1970) |
| `sources` | ja | object – Quelle (id) → Buch |

### auflagen · alarms

Alarme der letzten 60 Tage, neueste zuerst; Zustand für den Vergleich mit dem nächsten Lauf

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `at` | ja | integer – Stand (ms seit 1970) |
| `items` | ja | array von object |
| `state` |  | object – Stand des letzten Laufs für den Vergleich (Obergrenzen, Quellenstatus, Zonen, Preise, Flotte) |

## markt

Markt – Deutschland-Index, Wirkung, Scout, Grafik der Woche, offene Daten (Sprint 7). index/&lt;JJJJ-MM&gt;.json und index/laufend.json (Deutschland-Index je Gemeinde und Fahrzeugart, S7.1), index/index.json, markt/wirkung.json (Ereignis- und Preis-Wirkung, S7.2/S7.3), markt/scout.json (Expansions-Scout, S7.4), grafik/index.json (Grafik der Woche) und offen/index.json (Monatspakete, S7.5).

Version 1.1 · Schema: [schemas/markt.schema.json](../schemas/markt.schema.json)

### markt · index

Monatswerte je Gemeinde und Fahrzeugart über alle Anbieter; complete = Monat abgeschlossen (sonst vorläufig)

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `month` | ja | string (Muster `^\d{4}-\d{2}$`) |
| `complete` | ja | boolean |
| `days` | ja | array von string |
| `firstDay` |  | string / null |
| `lastDay` |  | string / null |
| `rows` | ja | array von object |
| `de` | ja | object – Summen Deutschlands je Fahrzeugart: tripsDay, fleet, tvd, cities |
| `operatorLevel` |  | boolean – false: keine Werte je Anbieter |
| `at` |  | integer – Stand (ms seit 1970) |

### markt · indexList

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `months` | ja | array von object |

### markt · wirkung

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `at` |  | integer – Stand (ms seit 1970) |
| `version` |  | integer |
| `events` | ja | array von object – Ereignis-Wirkung: Ist − Prognose im Zeitfenster, 90-%-Band aus den übrigen Tagen |
| `prices` | ja | array von object – Preis-Wirkung: Differenz der Differenzen gegen die übrigen Anbieter der Gemeinde, je 7 Tage davor und danach |

### markt · scout

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `at` |  | integer – Stand (ms seit 1970) |
| `minPop` |  | integer |
| `radiusKm` |  | number |
| `candidates` | ja | integer |
| `sharing` |  | integer |
| `weights` |  | object |
| `rows` | ja | array von object |

### markt · grafik

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `weeks` | ja | array von object |

### markt · offen

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `packages` | ja | array von object |

## akku

Akku-Prognose – Modell und Zonen je Gemeinde, Trefferquote (S6.5). akku/&lt;AGS&gt;.json (Modell je Anbieter und Fahrzeugart, Zonen mit Fahrzeugen, die bis zum nächsten Morgen 8 Uhr unter 20 % fallen) und akku/bewertung.json (Selbstprüfung je Nacht, Rückblick auf die goldenen Tage). Keine Fahrzeugkennungen.

Version 1.3 · Schema: [schemas/akku.schema.json](../schemas/akku.schema.json)

### akku · ags

Gemeinden mit mindestens 20 Fahrzeugen mit absolutem Ladestand; je Lauf neu

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `at` | ja | number – Zeitpunkt des Laufs (ms) |
| `low` | ja | number – Schwelle in % (20) |
| `targetHour` | ja | integer – Zielstunde Ortszeit Berlin (8) |
| `target` | ja | number – nächster Zeitpunkt targetHour:00 (ms) |
| `groupFields` |  | array von string |
| `groups` | ja | object – 'Anbieter\|Art' → \[drain (Prozentpunkte je Stunde Standzeit), trip (Prozentpunkte je Fahrt), Herkunft drain, Herkunft trip ('gruppe' \| 'art' \| 'startwert'), Fahrten je verfügbarer Fahrzeugstunde für die Ortsstunden 0–23, ab 1.2 Entladung je Ortsstunde 0–23 (Prozentpunkte je Stunde, zum Mittel geglättet), ab 1.3 drei Faktoren auf diese Entladung nach Ladestand (unter 30 %, 30–49 %, ab 50 %)\] |
| `zones` | ja | object |
| `totals` | ja | object |

### akku · night

Ergebnis einer Nacht: Zählwerte (getroffen tp, falsch fp, übersehen fn, richtig nein tn), getauscht/unbekannt zählen nicht, ausgeblendet zählt als unter 20 %; late = Prüfung verpasst

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `day` | ja | string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `late` |  | boolean |
| `tp` |  | integer |
| `fp` |  | integer |
| `fn` |  | integer |
| `tn` |  | integer |
| `precision` |  | number / null |
| `recall` |  | number / null |
| `stay` |  | object – ab 1.1: dieselben Zählwerte nur für Fahrzeuge, die am Morgen weniger als 200 m vom Abendort stehen (dazu ausgeblendete), mit precision, recall, base |
| `moved` |  | object – ab 1.1: Zählwerte für gefahrene oder umgesetzte Fahrzeuge (≥ 200 m vom Abendort) |
| `bins` |  | object – ab 1.1: je Anbieter und Abend-Ladestand \[am Ort, davon unter 20 %, gefahren, davon unter 20 %\] |

### akku · bewertung

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `at` | ja | number |
| `rule` | ja | string – Prüfregel im Wortlaut |
| `nights` | ja | array von Werten |
| `total` | ja | object – Summe der geprüften Nächte mit precision (Treffer), recall (Abdeckung) und base (Vergleichsregel) |
| `backtest` |  | object / null – Rückblick auf die goldenen Tage (private Rohstände weniger Gruppen), einmal am Tag: nights, total, floors, groups, from, to |
| `models` | ja | object – 'Anbieter\|Art' → \[drain je Stunde, Verbrauch je Fahrt, Standstunden, Fahrten\] (gelernte Summen, Halbwertszeit 7 Tage) |
| `open` |  | object / null – abgelegte, noch nicht geprüfte Prognose: day, target, n |

## geo

Geo – Versorgung, Zubringer, Abstellorte, Unfälle, Umwegfaktor, Zensus-Abgleich (Sprint 8). Vom Sammler (Phase geo) aus dem Branch geo (Workflow „Geo“) und den privaten Positionen eines Laufs. Keine Fahrzeugkennungen, Fahrtenden je 50-m-Zelle erst ab 3.

Version 1.2 · Schema: [schemas/geo.schema.json](../schemas/geo.schema.json)

### geo · versorgung

S8.2 je Gemeinde: Einwohneranteil mit Fahrzeug in 150/200/300 m, mindestens 50 % der Zeit 7–22 Uhr, Gini, je Tag (days) und vorläufig heute (today); cells = Anteil je 250-m-Zelle für den letzten vollen Tag

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `pop` | ja | integer |
| `radii` | ja | array von integer |
| `days` | ja | array von object |
| `today` |  | object / null |
| `cells` |  | object |
| `missingOps` |  | array von string – Anbieter mit Genehmigung ohne offenen Feed: Versorgung unterschätzt |
| `letzteMeile` |  | object / null – Letzte Meile (seit 1.2): Einwohner weiter als stopM von jeder Haltestelle mit mindestens minDep Abfahrten am Stichtag, Anteil davon mit Sharing-Fahrzeug in vehM (Mittel der Läufe 7–22 Uhr des Tages day), Einwohner ohne beides, Zellen mit den meisten unversorgten Einwohnern |

### geo · versorgungIndex

S8.2 Übersicht je Gemeinde

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `fields` | ja | array |
| `ags` | ja | object |

### geo · zubringer

S8.5 ÖPNV-Zubringer-Index der größten Flottenstädte

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `cities` | ja | array von object |
| `rule` | ja | string |

### geo · abstell

S8.4 Fahrtenden je 50-m-Zelle im Monat (ab minCount)

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `month` | ja | string (Muster `^\d{4}-\d{2}$`) |
| `cells` | ja | object |

### geo · unfall

S8.3 Unfälle je 250-m-Zelle: Summen je Kategorie über die Jahre, EB-Rate, Gi*-z, Schwerpunkt

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `years` | ja | array |
| `fields` | ja | array |
| `rows` | ja | array |
| `overlap` |  | number / null |

### geo · unfallIndex

S8.3 Übersicht: Jahre, fehlende Jahre, Abgleich, Schwerpunkte je Gemeinde

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `years` | ja | array |
| `missingYears` |  | array |
| `landsByYear` |  | object – Jahr → erfasste Länder (zweistelliger AGS-Anfang, mindestens ein Fünftel des stärksten Jahres); eine Gemeinde nutzt nur die Jahre ihres Landes (ab 1.1) |
| `ags` | ja | object |

### geo · umweg

S8.6 Umwegfaktor je bewohnter 100-m-Zelle

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `fields` | ja | array |
| `rows` | ja | array |
| `median` |  | number / null |

### geo · umwegIndex

S8.6 Übersicht je Stadt mit Stichproben gegen einen Router

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `cities` | ja | object |

### geo · popIndex

S8.1 Zensus 2022 gegen VG250-EW je Gemeinde

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `maxDev` | ja | number |
| `ags` | ja | object |
| `within` |  | integer |
| `withinAdj` |  | integer – Gemeinden innerhalb ±maxDev nach Abzug des Landes-Medians von Zensus ÷ VG250-EW (Stichtagsunterschied); ab 1.1 |
| `landFactor` |  | object – Land (zweistelliger AGS-Anfang) → Median von Zensus ÷ VG250-EW; ab 1.1 |
| `n` |  | integer |

## oepnv

ÖPNV – Halte je Station, geschätzte Fahrzeugwege, Wirkung auf Sharing (Reiter ÖPNV). oepnv/&lt;AGS&gt;.json (Stationen und Stunden einer Gemeinde), oepnv/live/&lt;AGS&gt;.json (geschätzte Fahrzeugwege der nächsten Minuten), oepnv/wirkung.json und oepnv/index.json. Quelle: GTFS-Realtime von gtfs.de (CC BY-SA 4.0), Haltestellen CC BY 4.0. Fahrzeugwege sind aus Haltezeiten geschätzt, keine Ortung. Keine Fahrzeugkennungen, keine Fahrgastzahlen.

Version 1.4 · Schema: [schemas/oepnv.schema.json](../schemas/oepnv.schema.json)

### oepnv · ags

Stationen einer Gemeinde mit Flotte (höchstens 300, nach Halten) und Halte je Stunde der letzten 8 Tage; je Lauf neu

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `at` | ja | number – Zeit des Laufs (ms) |
| `feedAt` |  | number / null – Zeit des Echtzeit-Stroms (ms) |
| `license` |  | string |
| `attribution` |  | string |
| `halfLifeDays` |  | number – Halbwertszeit der Summen in Tagen |
| `days` |  | number – Tage in der Summe (mit Halbwertszeit gewichtet); Halte je Tag = halte ÷ days |
| `stations` |  | integer – Stationen der Gemeinde im Fahrplan |
| `fields` | ja | array von string – Spalten von rows: station, name, lat, lon, halte, ausgefallen, verspaetet (ab 5 Minuten), verspaetung_min (Mittel der Halte mit Angabe), halte_heute, ausgefallen_heute, verspaetet_heute |
| `rows` | ja | array von array |
| `hours` | ja | object – je Tag 24 Ortsstunden: Halte mit Echtzeit, ausgefallen, verspätet, Kennzeichen gestört; cancel = ganz ausgefallene Fahrten des Tages |
| `lines` |  | object – Linien der Gemeinde (höchstens 80, nach Halten), Summe wie rows; seit 1.1 |
| `profile` |  | object / null – Tagesgang je Ortsstunde, Mittel der Tage vor heute: ÖPNV-Halte mit Echtzeit gegen Sharing-Fahrtbeginne; gap = Stunden mit ÖPNV unter gapShare des Höchstwerts und mindestens minSharing Fahrtbeginnen; seit 1.1 |
| `jetzt` |  | object – Stationen, die in den letzten windowH Stunden gestört waren (ab minN Halten, mindestens 30 % ausgefallen oder verspätet oder 15 % ausgefallen); seit 1.3 |

### oepnv · live

Geschätzte Fahrzeugwege ab at für aheadMin Minuten; je Lauf neu

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `ags` | ja | string (Muster `^\d{8}$`) |
| `at` | ja | number |
| `feedAt` |  | number / null |
| `aheadMin` | ja | number |
| `license` |  | string |
| `attribution` |  | string |
| `fields` | ja | array von string – Spalten von trips: linie (oder null), art ('bus' \| 'tram' \| 'ubahn' \| 'sbahn' \| 'regio' \| 'fern' \| 'sonst'; bis 1.1 'bahn' für alle Bahnen), verspaetung_s am nächsten Halt (oder null), weg = \[lat, lon, Sekunden nach at, …\] je Station |
| `trips` | ja | array von array |

### oepnv · wirkung

Sharing-Fahrtbeginne in gestörten Stunden gegen die übrigen Stunden derselben Gemeinde

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `at` | ja | number |
| `days` |  | array von string |
| `rule` |  | string / null |
| `pooled` |  | object / null |
| `cities` | ja | array von object |
| `learn` |  | object – Passiv gelernte Wirkung je Stadt (seit 1.4): Tageswerte bis 60 Tage zurück, je Stadt mit k Tagen zur Gesamtwirkung gezogen; since = Beginn des Lernens, until = frühestens einschalten |

### oepnv · index

Übersicht je Gemeinde

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR |
| `at` | ja | number |
| `feedAt` |  | number / null |
| `license` |  | string |
| `attribution` |  | string |
| `aheadMin` |  | number |
| `days` |  | number |
| `trips` |  | integer – Fahrzeugwege im Lauf |
| `withRoute` |  | integer – davon mit Linie |
| `fields` | ja | array von string |
| `cities` | ja | object |
