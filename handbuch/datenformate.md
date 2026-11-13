# Datenformate

Erzeugt aus `schemas/*.schema.json` mit `node scripts/schemas-doc.mjs` – nicht von Hand ändern. Jede Datei dieser Familien trägt vorn
`schemaVersion` („MAJOR.MINOR“). Neue Felder erhöhen MINOR, ein weggefallenes Feld oder eine geänderte Bedeutung MAJOR; passt die
MAJOR-Version nicht zur Seite, zeigt das Dashboard einen Hinweis. Geprüft wird mit `node test/schema.mjs` (Fixture) und
`node test/schema.mjs <Checkout des Branches data>`. Felder, die hier nicht stehen, sind erlaubt, aber nicht zugesichert.

| Familie | Version | Dateien |
| --- | --- | --- |
| [status](#status) | 2.0 | `status.json` |
| [latest](#latest) | 1.0 | `latest.json` |
| [sources](#sources) | 1.0 | `sources.json` |
| [history](#history) | 1.0 | `history/index.json`, `history/<Tag>.json` |
| [events](#events) | 1.1 | `events/index.json`, `events/<Tag>.json`, `events/<Tag>/<Land>.json`, `events/hour-totals.json`, `events/daily-summary.json` |
| [cells](#cells) | 1.0 | `cells/<Tag>/<Land>.json` |
| [ops](#ops) | 1.1 | `ops/<Land>.json`, `ops-input/<AGS>.json`, `ops-input/index.json` |
| [boundaries](#boundaries) | 1.0 | `boundaries/index.json`, `boundaries/<Land>.json` |
| [calib](#calib) | 1.0 | `calib.json` |
| [forecast](#forecast) | 1.0 | `forecast/latest.json`, `forecast/log.json`, `forecast/series.json`, `forecast/moped/…`, `forecast/car/…` |

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

latest.json – Bestand des letzten Laufs. Quellen mit Status und Lizenz, Gemeinden, Gruppen je Gemeinde|Anbieter|Art, Summen und Messbasis.

Version 1.0 · Schema: [schemas/latest.schema.json](../schemas/latest.schema.json)

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

ops/&lt;Land&gt;.json – Bestand für die Disposition. ops/&lt;Land&gt;.json (Bestand je Land, $defs/state); ab 1.1 (S3.8) ops-input/&lt;AGS&gt;.json mit der Nachfrage-Eingabe der Disposition ($defs/input) und ops-input/index.json.

Version 1.1 · Schema: [schemas/ops.schema.json](../schemas/ops.schema.json)

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
