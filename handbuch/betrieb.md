# Betrieb

## Betrieb: Sammler-Kette und Wächter

Der Sammler stößt sich am Ende jedes Laufs selbst neu an (`collect.yml`, Schritt „Nächsten Lauf anstoßen“, Takt 20 Min.); der Zeitplan (`8,28,49 * * * *`) springt bei GitHub nur alle 4–8 Stunden an und taugt allein nicht als Rückfall. Am 9.11.2026 18:21 UTC startete ein angestoßener Lauf bei GitHub nicht (Fehlstart ohne Job, „workflow file issue“ bei unveränderter Datei) – die Kette stand, bis der Lauf von Hand neu gestartet wurde (19:30 UTC). Seitdem der Workflow **„Wächter“** (`.github/workflows/waechter.yml`, Vorlage `scripts/waechter-workflow.yml`, nur über die Weboberfläche ändern) als eigene Kette: prüft alle ~16 Min., ob ein Sammler-Lauf läuft oder wartet; wenn nicht (auch nach 60 s nicht), stößt er einen an (bis 6 Versuche), danach die eigene nächste Prüfung. Der Auslöser `workflow_run` taugt dafür nicht: Sammler-Läufe stößt der `GITHUB_TOKEN` an, und dessen Ereignisse starten keine anderen Workflows (getestet 9.11.2026: kein Wächter-Lauf nach drei Sammler-Läufen). Zeitplan `17,47 * * * *` nur als Rückfall, falls die Wächter-Kette selbst abreißt; Start der Kette einmal von Hand (Actions → Wächter → Run workflow). Eine zweite Kette entsteht nicht: Wächter wie Sammler hören auf, sobald ein neuerer Lauf derselben Kette wartet.

## Workflows

Alle Dateien unter `.github/workflows/` werden nur über die GitHub-Weboberfläche unter dem Konto `fcou1005` geändert: geplante Läufe laufen
unter dem Konto, das die Datei zuletzt geändert hat. Vorlagen liegen in `scripts/*-workflow.yml`.

| Workflow | Vorlage | Aufgabe |
| --- | --- | --- |
| `collect.yml` (Sammler) | `scripts/collect-workflow.yml` | Datenstand alle 20 Min., stößt sich selbst neu an; vor dem Push `scripts/data-guard.mjs` |
| `waechter.yml` (Wächter) | `scripts/waechter-workflow.yml` | startet den Sammler, wenn die Kette steht; Hinweis-Issue nach 60 Min. ohne Lauf |
| `chronos.yml` | `scripts/chronos-workflow.yml` | Chronos-Vorhersage (Python) für die Prognose |
| `termine.yml` | `scripts/termine-workflow.yml` | Termine und Veranstaltungen |
| `backup.yml` | `scripts/backup-workflow.yml` | Sicherung des Datenstands als Vorabversion |
| `test.yml` | `scripts/test-workflow.yml` | Tests, Typprüfung, Build-Budget, Browser, Barrierefreiheit, Lighthouse |

Sammler-Läufe von Hand nur über Actions → Sammler → Run workflow.

## Lokal

```sh
npm ci                               # nur Build und Tests (der Sammler braucht keine Abhängigkeiten)
node scripts/build-catalog.mjs       # data/sources.json
node scripts/prepare-boundaries.mjs  # braucht gdal-bin, unzip
node scripts/collect.mjs
node scripts/build-web.mjs --budget  # web/ → docs/ (esbuild), Größenbudget
```

## Tests

| Befehl | Prüft |
| --- | --- |
| `node scripts/test-all.mjs` | alle `test/*.test.mjs` und den Fixture-Test `test/run.mjs` (Port 8765), ohne Netz |
| `node scripts/typecheck.mjs` | Typprüfung: `lib/` fehlerfrei, sonst nicht mehr Fehler als `typecheck-baseline.json` |
| `node test/browser.mjs` | alle Ansichten mit festem Datenstand (`test/fixtures/web-data`, Port 8766), Byte-Budget je Ansicht |
| `node test/a11y.mjs` | axe ohne Verstöße auf Live, Disposition, Bericht, Prognose, Quellen; Referenz-Screenshots (Port 8768) |
| `npx @lhci/cli@0.16.1 autorun` | Lighthouse: Skript ≤ 300 KB, Barrierefreiheit ≥ 0,95 (Port 8767) |
| `node test/schema.mjs [Datenstand]` | Datenverträge gegen `schemas/` ([Datenformate](datenformate.md)) |
| `MP_DATA=<Datenstand> node test/split.test.mjs` | Daten nach Gebiet liefern dieselben Ergebnisse wie die großen Dateien |

Fixture neu schneiden: `node scripts/make-fixture.mjs <Checkout des Branches data>`, danach `UPDATE_SCREENSHOTS=1 node test/a11y.mjs`.

## Alarme, Feeds und Monatsberichte (Sprint 5)

- Phase `alarme` des Sammlers (`scripts/collect/24-alarme.mjs`, `lib/pulse-alarme.js`) vergleicht jeden Lauf mit dem vorigen und schreibt `auflagen/alarme.json` sowie Atom-Feeds `feeds/<AGS>.xml` und `feeds/<AGS>-<cap|source|zone|price|fleet>.xml` in den Datenzweig (nur bei geändertem Inhalt). Push über ntfy: Repository-Variable `NTFY_TOPIC` und im Sammler-Workflow `NTFY_TOPIC: ${{ vars.NTFY_TOPIC }}` unter `env` (Workflow nur über die Weboberfläche ändern).
- Jahresbuch der Feed-Verfügbarkeit: Phase `ereignisse` schreibt `auflagen/verfuegbarkeit-<Jahr>.json` (`lib/pulse-auflagen.js`; letzte zehn Tage einzeln, ältere je Monat).
- Monats-Steckbrief: Vorlage `scripts/monatsbericht-workflow.yml` als `.github/workflows/monatsbericht.yml` über die Weboberfläche anlegen; am 1. des Monats entstehen die PDFs des Vormonats im Branch `berichte`.
