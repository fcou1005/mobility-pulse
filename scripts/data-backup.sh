#!/usr/bin/env bash
# Wochensicherung des Datenstands (Sprint 0, S0.2). Der Branch data hat nur einen Commit (Force-Push je Lauf), frühere Stände gibt es dort nicht.
# Gesichert werden die Teile, die sich nicht neu rechnen lassen: Langzeitarchive und Logs.
#   bash scripts/data-backup.sh pack <ordner> <datei.tar.gz>     packen und Vollständigkeit prüfen
#   bash scripts/data-backup.sh restore <datei.tar.gz> <ziel>     auspacken und Dateien zählen
# Wiederherstellen aus GitHub: gh release download datenstand-JJJJ-MM-TT -R fcou1005/mobility-pulse -p backup.tar.gz
set -euo pipefail
PARTS=(archive groups train train-cells calib.json caps-log.json eingriffe.json pricing-log.json runs.json zones-log.json DATA-LICENSE.md)
case "${1:-}" in
  pack)
    src="$2"; dst="$3"; present=()
    for p in "${PARTS[@]}"; do if [ -e "$src/$p" ]; then present+=("$p"); fi; done
    if [ "${#present[@]}" -eq 0 ] || [ ! -d "$src/archive" ]; then echo "::error::Kein Datenstand in $src (archive/ fehlt) – keine Sicherung"; exit 1; fi
    tar -czf "$dst" -C "$src" "${present[@]}"
    n_src=$(cd "$src" && find "${present[@]}" -type f | wc -l); n_tar=$(tar -tzf "$dst" | grep -vc '/$')
    if [ "$n_src" != "$n_tar" ]; then echo "::error::Sicherung unvollständig: $n_tar statt $n_src Dateien"; exit 1; fi
    echo "Sicherung: $n_tar Dateien ($(du -h "$dst" | cut -f1)) aus ${present[*]}"
    ;;
  restore)
    src="$2"; dst="$3"; mkdir -p "$dst"
    tar -xzf "$src" -C "$dst"
    echo "Wiederhergestellt nach $dst: $(find "$dst" -type f | wc -l) Dateien"
    ;;
  *) echo "Aufruf: data-backup.sh pack <ordner> <datei.tar.gz> | restore <datei.tar.gz> <ziel>"; exit 2 ;;
esac
