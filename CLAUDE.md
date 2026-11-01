# Hinweise für Claude

- `.github/workflows/collect.yml` nie aus der Sitzung pushen: geplante Läufe (cron) laufen unter dem Konto, das die Datei zuletzt geändert hat. Änderungen nur über die GitHub-Weboberfläche unter `fcou1005` (im Chrome des Nutzers), sonst stoppt der Zeitplan.
- Konto: ausschließlich `fcou1005`, nie `F3lixH3ni`.
- Nach Änderungen an `web/` oder `lib/`: `node scripts/build-web.mjs` (kopiert nach `docs/` mit Cache-Busting), Tests: `node test/run.mjs`, `node test/track.test.mjs`, `node test/ops.test.mjs`, `node test/econ.test.mjs`, `node test/core.test.mjs`, `node test/report.test.mjs`, `node test/coverage.test.mjs`, `node test/flowest.test.mjs`, `node test/i18n.test.mjs`. Der Fixture-Test nutzt Port 8765 – keinen anderen Server darauf laufen lassen.
- Sammler-Läufe von Hand nur über Actions → Sammler → Run workflow im Browser des Nutzers (das Sitzungs-Token darf nicht dispatchen).
- Zonen-Umrisse für die Zonen-Beobachtung nur im Secret `ZONE_WATCH`, nie ins Repo oder auf `data` (Repo und Seite sind öffentlich; Quelle intern).
