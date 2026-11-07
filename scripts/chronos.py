#!/usr/bin/env python3
"""Chronos-2-Prognose für Mobility Pulse (Schattenkandidat, siehe lib/pulse-chronos.js).

Eingabe: chronos-input.json aus scripts/chronos-input.mjs (version 2: runs = [main, Vortagsprognosen je Ortstag]; version 1: ein Lauf).
Ausgabe: chronos.json
  { version, model, package, at (Stand der Eingabe), ranAt, runSec, from (UTC ms der ersten Prognosestunde), hours,
    quantiles, groups: { "ags|op|ty": { m: [Mittel je Stunde], q10: [...], q90: [...] } },
    back: { "YYYY-MM-DD": { from, hours, groups: { "ags|op|ty": [Mittel je Stunde] } } } }
Kovariaten je Gruppe: Fahrzeugstunden e (Zukunft: zuletzt beobachteter Wert), Temperatur t, Niederschlag p, Tagtyp c (W/F/S/H, kategorial),
Ortsstunde als Sinus/Kosinus. Nicht beobachtete Stunden bleiben NaN (Chronos-2 maskiert sie).

CHRONOS_FAKE=1: ohne Modell, saisonal naiv (gleiche Stunde 24 h vorher) – nur für Tests ohne torch.
"""
import json
import math
import os
import sys
import time

import numpy as np
import pandas as pd

QUANTILES = [0.1, 0.5, 0.9]


SEP = "\u00a7"


def frames(inp, prefix=""):
    n, H = inp["n"], inp["horizon"]
    ts = pd.to_datetime([inp["from"] + i * 3_600_000 for i in range(n + H)], unit="ms")
    lh = np.array(inp["lh"], dtype=float)
    hs, hc = np.sin(2 * math.pi * lh / 24), np.cos(2 * math.pi * lh / 24)
    past, fut = [], []
    for g in inp["groups"]:
        k = g["k"]
        cov = inp["cov"].get(k.split("|")[0], {})
        nan = [None] * (n + H)
        t, p, c = cov.get("t", nan), cov.get("p", nan), cov.get("c", "W" * (n + H))
        e = g["e"]
        base = {
            "item_id": prefix + k,
            "timestamp": ts,
            "e": np.array(e, dtype=float),
            "t": np.array(t, dtype=float),
            "p": np.array(p, dtype=float),
            "c": list(c),
            "hs": hs,
            "hc": hc,
        }
        d = pd.DataFrame(base)
        pf = d.iloc[:n].copy()
        pf["target"] = np.array(g["y"], dtype=float)
        past.append(pf)
        fut.append(d.iloc[n:].copy())
    return pd.concat(past, ignore_index=True), pd.concat(fut, ignore_index=True)


def frames_all(runs):
    """Alle Läufe gleicher Länge in eine Tabelle (item_id = Lauf + § + Gruppe), Tagtyp kategorial über alle"""
    parts = [frames(r, r["tag"] + SEP) for r in runs]
    df = pd.concat([p[0] for p in parts], ignore_index=True)
    future = pd.concat([p[1] for p in parts], ignore_index=True)
    df["c"] = df["c"].astype("category")
    future["c"] = pd.Categorical(future["c"], categories=df["c"].cat.categories)
    return df, future


def predict_fake(runs):
    out = {}
    for inp in runs:
        out.update(fake_one(inp))
    return out


def fake_one(inp):
    n, H = inp["n"], inp["horizon"]
    out = {}
    for g in inp["groups"]:
        y = [v for v in g["y"]]
        m = []
        for j in range(H):
            back = n + j - 24 * (1 + j // 24)
            v = y[back] if 0 <= back < n and y[back] is not None else 0.0
            m.append(float(v))
        out[inp["tag"] + SEP + g["k"]] = {"m": m, "q10": [x * 0.7 for x in m], "q90": [x * 1.3 for x in m]}
    return out


def predict_chronos(runs):
    # Dieses Skript heißt wie das Paket: beim Aufruf als scripts/chronos.py steht scripts/ vorn in sys.path und „import chronos“ fände die
    # Datei selbst (erster Lauf 07.11.2026: ImportError Chronos2Pipeline). Verzeichnis entfernen, damit das installierte Paket geladen wird.
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.getcwd()) != here]
    if getattr(sys.modules.get("chronos"), "__file__", None) and os.path.dirname(os.path.abspath(sys.modules["chronos"].__file__)) == here:
        del sys.modules["chronos"]
    import torch
    from chronos import Chronos2Pipeline

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    pipe = Chronos2Pipeline.from_pretrained(runs[0].get("model") or "amazon/chronos-2", device_map="cpu")
    out = {}
    for H in sorted({r["horizon"] for r in runs}):  # je Prognoselänge ein Aufruf (future_df braucht gleich viele Zeilen je Reihe)
        df, future = frames_all([r for r in runs if r["horizon"] == H])
        pred = pipe.predict_df(
            df,
            future_df=future,
            id_column="item_id",
            timestamp_column="timestamp",
            target="target",
            prediction_length=H,
            quantile_levels=QUANTILES,
            batch_size=int(os.environ.get("CHRONOS_BATCH", "256")),
        )
        for k, g in pred.groupby("item_id", sort=False):
            g = g.sort_values("timestamp")
            out[k] = {"m": g["predictions"].tolist(), "q10": g["0.1"].tolist(), "q90": g["0.9"].tolist()}
    return out


def main(src, dst):
    t0 = time.time()
    with open(src, encoding="utf-8") as f:
        inp = json.load(f)
    runs = inp.get("runs") if isinstance(inp, dict) and inp.get("runs") else [{"tag": "main", **inp}]
    main_run = next((r for r in runs if r["tag"] == "main"), None)
    if not main_run or not main_run.get("groups"):
        sys.exit("Eingabe ohne Gruppen")
    fake = os.environ.get("CHRONOS_FAKE") == "1"
    res = predict_fake(runs) if fake else predict_chronos(runs)
    r = lambda a: [round(max(0.0, float(x)), 1) if x is not None and math.isfinite(float(x)) else None for x in a]
    try:
        from importlib.metadata import version

        pkg = None if fake else version("chronos-forecasting")
    except Exception:
        pkg = None
    doc = {
        "version": 1,
        "model": "fake-seasonal-naive" if fake else (inp.get("model") or "amazon/chronos-2"),
        "package": pkg,
        "at": main_run["at"],
        "ranAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runSec": round(time.time() - t0, 1),
        "from": main_run["futureFrom"],
        "hours": main_run["horizon"],
        "quantiles": QUANTILES,
        "groups": {},
        "back": {},
    }
    for run in runs:
        pre = run["tag"] + SEP
        got = {k[len(pre):]: v for k, v in res.items() if k.startswith(pre)}
        if run["tag"] == "main":
            doc["groups"] = {k: {"m": r(v["m"]), "q10": r(v["q10"]), "q90": r(v["q90"])} for k, v in got.items()}
        else:
            doc["back"][run["tag"]] = {"from": run["futureFrom"], "hours": run["horizon"], "groups": {k: r(v["m"]) for k, v in got.items()}}
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"Chronos: {len(doc['groups'])} Gruppen, {doc['hours']} Stunden ab {pd.to_datetime(doc['from'], unit='ms')} UTC, Vortagsprognosen {', '.join(sorted(doc['back'])) or '–'}, {doc['runSec']} s")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Aufruf: chronos.py chronos-input.json chronos.json")
    main(sys.argv[1], sys.argv[2])
