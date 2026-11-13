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
| [cells](#cells) | 1.0 | `cells/<Tag>/<Land>.json` |
| [ops](#ops) | 1.3 | `ops/<Land>.json`, `ops-input/<AGS>.json`, `ops-input/index.json`, `ops-input/fleet/<AGS>.json`, `ops-input/fleet/index.json` |
| [boundaries](#boundaries) | 1.0 | `boundaries/index.json`, `boundaries/<Land>.json` |
| [calib](#calib) | 1.0 | `calib.json` |
| [forecast](#forecast) | 1.0 | `forecast/latest.json`, `forecast/log.json`, `forecast/series.json`, `forecast/moped/…`, `forecast/car/…` |
| [auflagen](#auflagen) | 1.0 | `auflagen/verfuegbarkeit-<Jahr>.json`, `auflagen/alarme.json` |

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

Version 1.0 · Schema: [schemas/cells.schema.json](../schemas/cells.schema.json)

| Feld | Pflicht | Typ |
| --- | --- | --- |
| `schemaVersion` | ja | string (Muster `^1\.\d+$`) – Formatversion MAJOR.MINOR; MAJOR steigt bei unverträglichen Änderungen, MINOR bei neuen Feldern |
| `day` | ja | string (Muster `^\d{4}-\d{2}-\d{2}$`) |
| `state` | ja | string (Muster `^[A-Z]{2}$`) |
| `bandMin` |  | array |
| `bandRuns` |  | array |
| `fields` | ja | string |
| `munis` | ja | object |
| `below` |  | object |
| `minCount` | ja | integer |
| `suppress` |  | integer |
| `published` |  | object – Veröffentlichungsstand; fehlt in Dateien vor dem 2. November 2026 |

## ops

ops/&lt;Land&gt;.json – Bestand für die Disposition. ops/&lt;Land&gt;.json (Bestand je Land, $defs/state); ab 1.1 (S3.8) ops-input/&lt;AGS&gt;.json mit der Nachfrage-Eingabe der Disposition ($defs/input) und ops-input/index.json. Ab 1.2 ops-input/fleet/&lt;AGS&gt;.json (Bestand einer Gemeinde im Format von $defs/state, Feld ags) und ops-input/fleet/index.json.

Version 1.3 · Schema: [schemas/ops.schema.json](../schemas/ops.schema.json)

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

ops-input/cells/&lt;AGS&gt;.json (S3.8 Rest): Zellen wie ops-input/&lt;AGS&gt;.json, je Tag spaltenweise (cols: Zellschlüssel x, y als Differenzen in Originalreihenfolge, v je Feld ohne drop), dazu die Start-Ziel-Ströme der Gemeinde für die Zellen-Tage.

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

Version 1.0 · Schema: [schemas/forecast.schema.json](../schemas/forecast.schema.json)

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

## auflagen

auflagen/ – Datenauflagen-Check und Alarme. Jahresbuch der Feed-Verfügbarkeit je Quelle (auflagen/verfuegbarkeit-&lt;Jahr&gt;.json, S5.1) und Alarmprotokoll je Gemeinde (auflagen/alarme.json, S5.2; daraus die Atom-Feeds feeds/&lt;AGS&gt;.xml).

Version 1.0 · Schema: [schemas/auflagen.schema.json](../schemas/auflagen.schema.json)

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
