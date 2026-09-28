"""Lernschleife: testet laufend Parameter-Varianten des TJR-Modells und kürt einen Champion.

Schutz gegen Selbstbetrug (Überanpassung):
  * Zeitliche Trennung: Auswahl nur auf den ersten `train_frac` der Handelstage; der Rest ist Test (nie zur Auswahl).
  * Mindestanzahl Trades, Score = t-Wert des R (Ø R * sqrt(n) / Std), nicht nur Gewinn.
  * Nachbar-Check: Werte rund um den Kandidaten müssen auch ordentlich sein (Plateau statt Zufallsspitze).
  * Champion-Wechsel nur, wenn der Test-t-Wert >= Schwelle UND besser als der alte Champion ist.
    Die Schwelle steigt mit der Zahl der Versuche (je mehr probiert, desto strenger).
Jeder Versuch landet in state/leaderboard.csv (läuft beliebig oft weiter = "dauerhaft").

    python -m tjrbot.optimize --nq data/NQ_1m.csv --es data/ES_1m.csv --trials 500 --workers 8
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from . import config, data, engine

ROOT = Path(__file__).resolve().parent.parent
BOARD = ROOT / "state" / "leaderboard.csv"
CHAMPION = ROOT / "state" / "champion.yaml"
PROPOSALS = ROOT / "state" / "coach_proposals.json"

# Was gelernt werden darf. TJRs Kern (Sweep -> Bestätigung -> Retrace -> Einstieg) bleibt fest.
SPACE: dict[str, list] = {
    "entry_start": ["09:35", "09:45", "09:50", "10:00"],
    "cutoff": ["10:30", "11:00", "11:30"],
    "require_zone_touch": [True, False],
    "continuation_zones": [["EQ", "FVG"], ["EQ"], ["FVG"]],
    "bias_mode": ["lean", "filter", "off"],
    "require_index_alignment": [True, False],
    "htf_conflict_action": ["escalate_15m", "stand_down"],
    "ifvg_enabled": [True, False],
    "sweep_max_age_bars": [6, 12, 24],
    "stop_buffer_pct": [0.00003, 0.00007, 0.00012],
    "min_stop_pct": [0.0002, 0.0004, 0.0006],
    "tp1_min_R": [0.5, 1.0, 1.5, 2.0],
    "tp_include_internal": [True, False],
    "tp1_close_frac": [0.33, 0.5, 1.0],
    "max_hold_minutes": [60, 120, 180],
    "stall_minutes": [45, 90, 120],
    "include_prev_ny": [True, False],
    "include_premarket": [True, False],
}


def key(params: dict) -> str:
    return hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:12]


def tstat(r: np.ndarray) -> float:
    if len(r) < 2 or r.std(ddof=1) == 0:
        return 0.0
    return float(r.mean() / r.std(ddof=1) * math.sqrt(len(r)))


def split_date(frames: dict, train_frac: float) -> str:
    idx = next(iter(frames.values())).index
    dates = sorted({str(d) for d in (idx + pd.Timedelta(hours=6)).date})
    return dates[int(len(dates) * train_frac)]


# --- Worker (Prozess-global, damit die Daten nur einmal geladen werden)
_FR = None


def _init(frames):
    global _FR
    _FR = frames


def evaluate(params: dict, split: str, base_over: dict) -> dict:
    cfg = config.load(**{**base_over, **params})
    try:
        eng = engine.Engine(_FR, cfg).run()
    except Exception as e:  # noqa: BLE001 - ein kaputter Kandidat darf die Suche nicht stoppen
        return {"key": key(params), "params": json.dumps(params), "error": repr(e)[:200]}
    tf = eng.trades_frame()
    tf = tf.dropna(subset=["R"]) if len(tf) else tf
    out = {"key": key(params), "params": json.dumps(params, sort_keys=True)}
    for name, part in (("train", tf[tf["date"] < split] if len(tf) else tf),
                       ("test", tf[tf["date"] >= split] if len(tf) else tf)):
        r = part["R"].to_numpy(dtype=float) if len(part) else np.array([])
        out.update({f"{name}_n": len(r), f"{name}_avgR": round(float(r.mean()), 4) if len(r) else 0.0,
                    f"{name}_sumR": round(float(r.sum()), 2), f"{name}_t": round(tstat(r), 3),
                    f"{name}_win": round(float((r > 0).mean() * 100), 1) if len(r) else 0.0})
    return out


def sample(rng: random.Random) -> dict:
    return {k: rng.choice(v) for k, v in SPACE.items()}


def neighbors(params: dict, rng: random.Random, k: int = 4) -> list[dict]:
    out = []
    for name in rng.sample(list(SPACE), k):
        vals = SPACE[name]
        i = vals.index(params[name]) if params[name] in vals else 0
        j = min(len(vals) - 1, max(0, i + rng.choice([-1, 1])))
        out.append({**params, name: vals[j]})
    return out


def coach_candidates() -> list[dict]:
    if not PROPOSALS.exists():
        return []
    base = load_champion() or {}
    cands = []
    for e in json.loads(PROPOSALS.read_text()).get("experiments", []):
        if e.get("param") in SPACE:
            v = e.get("value")
            v = yaml.safe_load(v) if isinstance(v, str) else v
            full = {**{k: config.DEFAULTS[k] for k in SPACE}, **base, e["param"]: v}
            cands.append(full)
    return cands


def load_board() -> pd.DataFrame:
    return pd.read_csv(BOARD) if BOARD.exists() else pd.DataFrame()


def load_champion() -> dict | None:
    if CHAMPION.exists():
        return (yaml.safe_load(CHAMPION.read_text()) or {}).get("params")
    return None


def run(frames: dict, trials: int, workers: int, seed: int, train_frac: float, min_trades: int,
        base_over: dict) -> dict:
    split = split_date(frames, train_frac)
    board = load_board()
    seen = set(board["key"]) if len(board) else set()
    rng = random.Random(seed)
    tjr_default = {k: config.DEFAULTS[k] for k in SPACE}
    queue = [p for p in [tjr_default] + coach_candidates() if key(p) not in seen]
    while len(queue) < trials:
        p = sample(rng)
        if key(p) not in seen:
            queue.append(p)
            seen.add(key(p))
    queue = queue[:max(trials, 1)]
    print(f"[optimize] {len(queue)} Kandidaten, Train < {split} <= Test, {workers} Prozesse")
    with ProcessPoolExecutor(workers, initializer=_init, initargs=(frames,)) as ex:
        rows = list(ex.map(evaluate, queue, [split] * len(queue), [base_over] * len(queue), chunksize=4))
        good = [r for r in rows if "error" not in r and r["train_n"] >= min_trades]
        good.sort(key=lambda r: -r["train_t"])
        # Nachbar-Check für die besten 10 (Plateau-Test)
        for r in good[:10]:
            nb = neighbors(json.loads(r["params"]), rng)
            nres = list(ex.map(evaluate, nb, [split] * len(nb), [base_over] * len(nb)))
            ts = [x["train_t"] for x in nres if "error" not in x]
            r["neighbor_median_t"] = round(float(np.median(ts)), 3) if ts else 0.0
            rows.extend(x for x in nres if "error" not in x)
    board = pd.concat([board, pd.DataFrame(rows)], ignore_index=True).drop_duplicates("key", keep="last")
    BOARD.parent.mkdir(parents=True, exist_ok=True)
    board.to_csv(BOARD, index=False)
    return promote(board, min_trades)


def promote(board: pd.DataFrame, min_trades: int) -> dict:
    """Champion nur wechseln, wenn Test (ungesehene Daten) überzeugt. Schwelle wächst mit Versuchszahl."""
    n_trials = len(board)
    need_t = 2.0 + 0.25 * math.log10(max(n_trials, 10))
    b = board.dropna(subset=["train_t"]).copy()
    if "neighbor_median_t" not in b:
        b["neighbor_median_t"] = np.nan
    ok = b[(b["train_n"] >= min_trades) & (b["test_n"] >= max(10, min_trades // 3)) & (b["test_t"] >= need_t)
           & (b["test_avgR"] > 0) & (b["neighbor_median_t"].fillna(0) >= 0.5 * b["train_t"])]
    old = yaml.safe_load(CHAMPION.read_text()) if CHAMPION.exists() else None
    result = {"trials_total": n_trials, "required_test_t": round(need_t, 2), "qualified": int(len(ok)),
              "changed": False, "champion": old}
    if not len(ok):
        return result
    best = ok.sort_values(["train_t", "test_t"], ascending=False).iloc[0]
    if old and old.get("metrics", {}).get("test_t", -1e9) >= best["test_t"]:
        return result
    champ = {"params": json.loads(best["params"]),
             "metrics": {k: (float(best[k]) if isinstance(best[k], (int, float, np.number)) else best[k])
                         for k in best.index if k.startswith(("train_", "test_", "neighbor"))},
             "trials_total": n_trials}
    CHAMPION.write_text(yaml.safe_dump(champ, allow_unicode=True, sort_keys=False))
    result.update(changed=True, champion=champ)
    return result


def load_frames(a) -> dict:
    if a.synthetic:
        return {"NQ": data.synthetic(days=a.synthetic, freq="1min", seed=1),
                "ES": data.synthetic(days=a.synthetic, freq="1min", seed=2, start_price=6000.0)}
    fr = {}
    if a.nq:
        fr["NQ"] = data.load_csv(a.nq)
    if a.es:
        fr["ES"] = data.load_csv(a.es)
    if not fr:
        raise SystemExit("Daten fehlen: --nq/--es (1m-CSV) oder --synthetic N (nur Funktionstest)")
    return fr


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--nq"); p.add_argument("--es")
    p.add_argument("--synthetic", type=int, default=0)
    p.add_argument("--trials", type=int, default=200)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--train-frac", type=float, default=0.6)
    p.add_argument("--min-trades", type=int, default=100)
    p.add_argument("--warmup-days", type=int, default=20)
    a = p.parse_args()
    res = run(load_frames(a), a.trials, a.workers, a.seed, a.train_frac, a.min_trades,
              {"warmup_days": a.warmup_days})
    print(json.dumps(res, indent=2, ensure_ascii=False, default=str))
    from . import notify
    if res["changed"]:
        m = res["champion"]["metrics"]
        notify.send(f"🏆 Neuer Champion nach {res['trials_total']} Varianten\n"
                    f"Test (ungesehene Daten): {int(m['test_n'])} Trades, Ø {m['test_avgR']}R, t={m['test_t']}\n"
                    f"Parameter: {res['champion']['params']}\n"
                    "Live-Nutzung erst nach Prüfung: config.yaml -> learning.use_champion: true")
    else:
        notify.send(f"🔁 Lernlauf: {res['trials_total']} Varianten getestet, {res['qualified']} bestehen den Test "
                    f"(nötig t >= {res['required_test_t']}). Champion unverändert.")


if __name__ == "__main__":
    main()
