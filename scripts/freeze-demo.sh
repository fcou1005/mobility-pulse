#!/bin/sh
# Friert den aktuellen Datenstand als Demo ein: Branch "demo" = Kopie des Branches "data".
# Dashboard mit ?demo=1 liest dann diesen festen Stand (unabhängig von Sammler, CORS, Live-Abruf).
# Alternativ ohne Terminal: GitHub → Branches → "New branch" aus "data" mit Namen "demo" (vorher alten löschen).
set -e
git fetch -q origin data
git push -f origin FETCH_HEAD:refs/heads/demo
echo "Demo-Stand eingefroren: $(git log -1 --format=%cd FETCH_HEAD)"
