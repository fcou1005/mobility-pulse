# Ereignisliste pflegen

Was automatisch läuft, macht der **Sammler** (GitHub Actions, stündlich) – keine geplanten Claude-Läufe:

| Was | Wie | Datei im Datenstand |
|---|---|---|
| Streiks ÖPNV und Bahn | Nachrichtensuche der tagesschau-App, `lib/pulse-strike.js`; Betriebe → Gemeinden in `data/streik-betriebe.json` | `streiks.json`, Einträge mit `auto: true` in `ereignisse.json` |
| Heimspiele | OpenLigaDB, Spielorte in `data/sport-spielorte.json` | `sport.json` |
| Termine großer Hallen | Programmseiten/ICS in `data/veranstaltungskalender.json` | `veranstaltungen.json` |

Von Hand bleibt `data/ereignisse.json` (Veranstaltungen, Volksfeste, Karneval, Messen; Streiks nur, wenn die automatische Erkennung einen
verpasst hat). Grundregeln aus `CLAUDE.md`: nur Konto `fcou1005`, `.github/workflows/*` nie ändern, keine Workflows starten.

## Prüfen und einspielen (nach jeder Änderung an `data/ereignisse.json` oder `data/streik-betriebe.json`)

```bash
node -e "import('./lib/pulse-context.js').then(CX=>{const r=CX.checkCurated(require('./data/ereignisse.json'));console.log('ok',r.ok.length,'fehlerhaft',r.bad.length,r.bad.slice(0,5));process.exit(r.bad.length?1:0)})"
node test/strike.test.mjs | grep -c FEHLER     # muss 0 sein
node test/forecast.test.mjs | grep -c FEHLER   # muss 0 sein
node test/run.mjs | grep -c FEHLER             # muss 0 sein (nutzt Port 8765)
git add data/ && git commit -m "…" && git pull --rebase origin main && git push origin HEAD:main
```

## Streik verpasst oder falsch erkannt

- Verpasst (keine tagesschau-Meldung mit Tag und Ort): Eintrag in `data/ereignisse.json` →
  `{ "art": "streik-oepnv", "von": "2026-11-12", "bis": "2026-11-13", "gebiet": { "ags": ["08111000"] }, "titel": "…", "quelle": "https://…", "id": "streik:<Kurzname-Datum>" }`.
  Ein gepflegter Eintrag verdrängt automatische Erkennungen derselben Art im selben Gebiet an denselben Tagen.
- Ort fehlt, weil die Meldung nur den Betrieb nennt: Betrieb in `data/streik-betriebe.json` nachtragen (`muster`, `ags`; Betriebe mit vielen Kreisen ohne `ags`).
- Hinweise ansehen: `streiks.json` → `hinweise` (ohne Tag, ohne Ort, Sammelmeldung, abgesagt) mit Link zur Meldung.

## Veranstaltungen aktualisieren (auf Zuruf in einer Sitzung)

Die Recherche-Einträge (`id` `recherche:…`) reichen bis Ende 2027 (Volksfeste bis etwa 15 Monate voraus); was danach angekündigt wird,
kommt nur über eine neue Recherche hinein.

1. Auftrag `scripts/ereignisse-recherche.md` lesen (Kriterien, Ausschlüsse, Ausgabeformat, Folgerunden), dann `data/ereignisse.json`.
2. Je Region eine Recherche (JSON-Datei in einem Ordner außerhalb des Repos). `geprueft` nur für Gemeinden, die wirklich vollständig durchgesehen
   wurden – nur deren bisherige Einträge im Zeitraum werden ersetzt. Regionen und Gemeinden:
   - **Süd-West:** 08111000 Stuttgart, 08116078 Leinfelden-Echterdingen (Messe), 08212000 Karlsruhe, 08215108 Rheinstetten (Messe), 08222000 Mannheim,
     08311000 Freiburg, 08221000 Heidelberg, 08416041 Tübingen, 08415061 Reutlingen, 08335043 Konstanz, 08121000 Heilbronn, 08231000 Pforzheim,
     08326074 Villingen-Schwenningen, 08115003 Böblingen, 08115045 Sindelfingen, 08317096 Offenburg, 08317065 Lahr, 08335075 Singen,
     07314000 Ludwigshafen, 07312000 Kaiserslautern, 07315000 Mainz, 06414000 Wiesbaden, 06411000 Darmstadt, 06412000 Frankfurt, 06534014 Marburg,
     06531005 Gießen, 06611000 Kassel
   - **Rheinland:** 05315000 Köln, 05111000 Düsseldorf, 05314000 Bonn, 05334002 Aachen, 05116000 Mönchengladbach, 05124000 Wuppertal, 05112000 Duisburg,
     05162024 Neuss, 05316000 Leverkusen, 05382060 Siegburg, 05382056 Sankt Augustin, 05362012 Brühl, 05122000 Solingen, 05158016 Hilden,
     05158020 Langenfeld, 05158026 Monheim, 05378004 Bergisch Gladbach
   - **Ruhr/Westfalen/Nord:** 05913000 Dortmund, 05113000 Essen, 05515000 Münster, 05911000 Bochum, 05119000 Oberhausen, 05916000 Herne, 05774032 Paderborn,
     05711000 Bielefeld, 05974040 Soest, 05954036 Witten, 03241001 Hannover, 03241010 Langenhagen, 03241009 Laatzen, 03241005 Garbsen, 04011000 Bremen,
     03101000 Braunschweig, 01002000 Kiel, 03159016 Göttingen, 01060063 Norderstedt, 03353040 Winsen (Luhe)
   - **Ost/Bayern:** 11000000 Berlin, 12054000 Potsdam, 14612000 Dresden, 14713000 Leipzig, 15002000 Halle (Saale), 16051000 Erfurt, 09162000 München,
     09564000 Nürnberg, 09562000 Erlangen, 09563000 Fürth, 09761000 Augsburg, 09663000 Würzburg, 09184119 Garching
   - **Volksfeste** (alle Städte, `kategorie: "volksfest"`, `umfang: "volksfest"`) und Großtermine (Stadionkonzerte, Messen, Marathons, Stadtfeste; `umfang: "ergaenzung"`)
3. Zusammenführen (Grenzen der Gemeinden mit Sharing-Daten vorher laden):
   ```bash
   curl -s https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/boundaries/index.json -o /tmp/bidx.json
   FROM=<heute> TO=<Ende des Zeitraums> node scripts/ereignisse-merge.mjs <Ordner> /tmp/bidx.json /tmp/vorschau.json --write --rolling
   ```
   Die Ausgabe nennt ersetzt/eingetragen und Verworfenes; offensichtlich Falsches (Datum, Ort) in den JSON-Dateien korrigieren und wiederholen.
4. Stichprobe: drei neue Einträge gegen ihre Quelle prüfen. Dann prüfen, testen, committen (`Ereignisliste: Aktualisierung <Region>`), pushen.
