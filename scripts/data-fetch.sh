#!/usr/bin/env bash
# Datenstand (Branch data) nach $1 holen – Sprint 0, S0.1.
# Unterscheidet „Branch fehlt“ (allererster Lauf: leer weiter) von „Abruf gescheitert“ (Abbruch nach 3 Versuchen). Vorher führte jeder
# Netzfehler zu einem leeren Stand, den der Force-Push im Schritt „Veröffentlichen“ als neuen Datenstand hochgeladen hätte
# (archive/, groups/, train/, train-cells/ und die Logs wären weg gewesen).
# Aufruf im Workflow: bash scripts/data-fetch.sh out   (Remote „origin“ aus dem Checkout, öffentliches Repo, kein Token nötig)
set -uo pipefail
out="${1:-out}"; branch="${DATA_BRANCH:-data}"; wait="${DATA_FETCH_WAIT:-15}"
mkdir -p "$out"
for i in 1 2 3; do
  git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; rc=$?
  if [ "$rc" = 2 ]; then echo "Noch kein Datenstand: Branch $branch gibt es nicht"; exit 0; fi
  if [ "$rc" = 0 ] && git fetch -q --depth 1 origin "$branch:refs/remotes/origin/$branch"; then
    if git archive "refs/remotes/origin/$branch" | tar -x -C "$out"; then
      echo "Datenstand übernommen: $(git ls-tree -r --name-only "refs/remotes/origin/$branch" | wc -l) Dateien"
      exit 0
    fi
  fi
  echo "Abruf des Datenstands fehlgeschlagen (Versuch $i von 3, ls-remote $rc)"
  [ "$i" -lt 3 ] && sleep $((i * wait))
done
echo "::error::Datenstand nicht abrufbar – Lauf abgebrochen, damit kein leerer Stand veröffentlicht wird"
exit 1
