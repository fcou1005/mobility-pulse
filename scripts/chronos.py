#!/usr/bin/env python3
"""Chronos-2-Prognose für Mobility Pulse (Schattenkandidat, siehe lib/pulse-chronos.js).

Eingabe: chronos-input.json aus scripts/chronos-input.mjs. Ausgabe: chronos.json
  { version, model, package, at (Stand der Eingabe), ranAt, runSec, from (UTC ms der ersten Prognosestunde), hours,
    quantiles, groups: { "ags|op|ty": { m: [Mittel je Stunde], q10: [...], q90: [...] } } }
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


def frames(inp):
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
            "item_id": k,
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
    df = pd.concat(past, ignore_index=True)
    future = pd.concat(fut, ignore_index=True)
    df["c"] = df["c"].astype("category")
    future["c"] = pd.Categorical(future["c"], categories=df["c"].cat.categories)
    return df, future


def predict_fake(inp):
    n, H = inp["n"], inp["horizon"]
    out = {}
    for g in inp["groups"]:
        y = [v for v in g["y"]]
        m = []
        for j in range(H):
            back = n + j - 24 * (1 + j // 24)
            v = y[back] if 0 <= back < n and y[back] is not None else 0.0
            m.append(float(v))
        out[g["k"]] = {"m": m, "q10": [x * 0.7 for x in m], "q90": [x * 1.3 for x in m]}
    return out


def predict_chronos(inp):
    # Dieses Skript heißt wie das Paket: beim Aufruf als scripts/chronos.py steht scripts/ vorn in sys.path und „import chronos“ fände die
    # Datei selbst (erster Lauf 07.11.2026: ImportError Chronos2Pipeline). Verzeichnis entfernen, damit das installierte Paket geladen wird.
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.getcwd()) != here]
    if getattr(sys.modules.get("chronos"), "__file__", None) and os.path.dirname(os.path.abspath(sys.modules["chronos"].__file__)) == here:
        del sys.modules["chronos"]
    import torch
    from chronos import Chronos2Pipeline

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    pipe = Chronos2Pipeline.from_pretrained(inp.get("model") or "amazon/chronos-2", device_map="cpu")
    df, future = frames(inp)
    pred = pipe.predict_df(
        df,
        future_df=future,
        id_column="item_id",
        timestamp_column="timestamp",
        target="target",
        prediction_length=inp["horizon"],
        quantile_levels=QUANTILES,
        batch_size=int(os.environ.get("CHRONOS_BATCH", "256")),
    )
    out = {}
    for k, g in pred.groupby("item_id", sort=False):
        g = g.sort_values("timestamp")
        out[k] = {"m": g["predictions"].tolist(), "q10": g["0.1"].tolist(), "q90": g["0.9"].tolist()}
    return out


def main(src, dst):
    t0 = time.time()
    with open(src, encoding="utf-8") as f:
        inp = json.load(f)
    if not inp or not inp.get("groups"):
        sys.exit("Eingabe ohne Gruppen")
    fake = os.environ.get("CHRONOS_FAKE") == "1"
    res = predict_fake(inp) if fake else predict_chronos(inp)
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
        "at": inp["at"],
        "ranAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runSec": round(time.time() - t0, 1),
        "from": inp["futureFrom"],
        "hours": inp["horizon"],
        "quantiles": QUANTILES,
        "groups": {k: {"m": r(v["m"]), "q10": r(v["q10"]), "q90": r(v["q90"])} for k, v in res.items()},
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"Chronos: {len(doc['groups'])} Gruppen, {doc['hours']} Stunden ab {pd.to_datetime(doc['from'], unit='ms')} UTC, {doc['runSec']} s")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Aufruf: chronos.py chronos-input.json chronos.json")
    main(sys.argv[1], sys.argv[2])
