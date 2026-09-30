"""Lernschleife: testet dauerhaft Parameter-Varianten des TJR-Modells und kürt einen Champion.

Schutz gegen Selbstbetrug (Überanpassung) – drei zeitlich getrennte Datenblöcke:
  * TRAIN  (erste 50 % der Handelstage): nur hier wird gesucht/gerankt.
  * VALID  (nächste 25 %): entscheidet, ob ein Kandidat Champion werden darf.
  * HOLD   (letzte 25 %): wird NIE zur Auswahl benutzt, nur berichtet ("Abschlussprüfung").
  * Score = t-Wert des R (Ø R * sqrt(n) / Std) – belohnt stabile, nicht zufällige Ergebnisse.
  * Nachbar-Check: Varianten rund um den Kandidaten müssen auch gut sein (Plateau statt Zufallsspitze).
  * Die Schwelle für VALID steigt mit der Zahl der Versuche (je mehr probiert, desto strenger).
Die Marktstruktur wird einmal berechnet und von allen Prozessen geteilt; eine Variante kostet so nur Sekunden.
Jeder Versuch landet in state/leaderboard.csv; mit --forever läuft die Suche endlos in Runden weiter.

    python -m tjrbot.optimize --nq data/NQ_1m.csv --es data/ES_1m.csv --trials 2000 --workers 4
    python -m tjrbot.optimize --nq ... --es ... --forever --batch 500
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import multiprocessing as mp
import random
import time
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
    "lean_requires_smt": [True, False],
    "require_index_alignment": [True, False],
    "htf_conflict_action": ["escalate_15m", "stand_down"],
    "ifvg_enabled": [True, False],
    "allow_trigger_on_new_extreme": [True, False],
    "sweep_max_age_bars": [6, 12, 24],
    "include_prev_ny": [True, False],
    "include_premarket": [True, False],
    "stop_buffer_pct": [0.00003, 0.00007, 0.00012, 0.0002],
    "min_stop_pct": [0.0002, 0.0004, 0.0006],
    "max_stop_pct": [0.002, 0.003, 0.005],
    "tp1_min_R": [0.5, 1.0, 1.5, 2.0],
    "tp_include_internal": [True, False],
    "fallback_R": [None, 1.0, 2.0],
    "tp1_close_frac": [0.33, 0.5, 1.0],
    "max_hold_minutes": [60, 120, 180],
    "stall_minutes": [45, 90, 120],
    "max_trades_per_day": [1, 2],
}
SPLITS = ("train", "valid", "hold")


def key(params: dict) -> str:
    return hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:12]


def tstat(r: np.ndarray) -> float:
    if len(r) < 2 or r.std(ddof=1) == 0:
        return 0.0
    return float(r.mean() / r.std(ddof=1) * math.sqrt(len(r)))


def split_dates(frames: dict, fracs=(0.5, 0.25)) -> tuple[str, str]:
    idx = next(iter(frames.values())).index
    dates = sorted({str(d) for d in (idx + pd.Timedelta(hours=6)).date})
    return dates[int(len(dates) * fracs[0])], dates[int(len(dates) * (fracs[0] + fracs[1]))]


# --- geteilter Zustand (per fork an die Worker vererbt)
_STRUCT: dict | None = None
_CAL: dict | None = None


def evaluate(params: dict, cuts: tuple[str, str], base_over: dict) -> dict:
    out = {"key": key(params), "params": json.dumps(params, sort_keys=True)}
    try:
        cfg = config.load(**{**base_over, **params})
        eng = engine.Engine(None, cfg, calendar=_CAL, structure=_STRUCT).run()
    except Exception as e:  # noqa: BLE001 - ein kaputter Kandidat darf die Suche nicht stoppen
        out["error"] = repr(e)[:200]
        return out
    tf = eng.trades_frame()
    tf = tf.dropna(subset=["R"]) if len(tf) else pd.DataFrame(columns=["date", "R", "usd"])
    parts = {"train": tf[tf["date"] < cuts[0]], "valid": tf[(tf["date"] >= cuts[0]) & (tf["date"] < cuts[1])],
             "hold": tf[tf["date"] >= cuts[1]]}
    for name, part in parts.items():
        r = part["R"].to_numpy(dtype=float)
        out.update({f"{name}_n": len(r), f"{name}_avgR": round(float(r.mean()), 4) if len(r) else 0.0,
                    f"{name}_sumR": round(float(r.sum()), 2), f"{name}_t": round(tstat(r), 3),
                    f"{name}_win": round(float((r > 0).mean() * 100), 1) if len(r) else 0.0})
    return out


def _eval_star(a):
    return evaluate(*a)


def sample(rng: random.Random) -> dict:
    return {k: rng.choice(v) for k, v in SPACE.items()}


def mutate(params: dict, rng: random.Random, n: int = 2) -> dict:
    p = dict(params)
    for name in rng.sample(list(SPACE), n):
        p[name] = rng.choice(SPACE[name])
    return p


def neighbors(params: dict, rng: random.Random, k: int = 4) -> list[dict]:
    out = []
    for name in rng.sample(list(SPACE), k):
        vals = SPACE[name]
        i = vals.index(params[name]) if params.get(name) in vals else 0
        j = min(len(vals) - 1, max(0, i + rng.choice([-1, 1])))
        out.append({**params, name: vals[j]})
    return out


def tjr_default() -> dict:
    return {k: config.DEFAULTS[k] for k in SPACE}


def coach_candidates() -> list[dict]:
    if not PROPOSALS.exists():
        return []
    base = load_champion() or {}
    cands = []
    for e in json.loads(PROPOSALS.read_text()).get("experiments", []):
        if e.get("param") in SPACE:
            v = e.get("value")
            v = yaml.safe_load(v) if isinstance(v, str) else v
            cands.append({**tjr_default(), **base, e["param"]: v})
    return cands


def load_board() -> pd.DataFrame:
    return pd.read_csv(BOARD) if BOARD.exists() else pd.DataFrame()


def load_champion() -> dict | None:
    if CHAMPION.exists():
        return (yaml.safe_load(CHAMPION.read_text()) or {}).get("params")
    return None


def next_batch(board: pd.DataFrame, n: int, rng: random.Random, min_trades: int) -> list[dict]:
    """Hälfte Zufall (Erkundung), Hälfte Mutationen der besten TRAIN-Ergebnisse (Verfeinerung)."""
    seen = set(board["key"]) if len(board) else set()
    queue = [p for p in [tjr_default()] + coach_candidates() if key(p) not in seen]
    elite = []
    if len(board) and "train_t" in board:
        ok = board[board["train_n"] >= min_trades].nlargest(30, "train_t")
        elite = [json.loads(p) for p in ok["params"]]
    tries = 0
    while len(queue) < n and tries < n * 50:
        tries += 1
        p = mutate(rng.choice(elite), rng, rng.choice([1, 2, 3])) if elite and rng.random() < 0.5 else sample(rng)
        if key(p) not in seen:
            seen.add(key(p))
            queue.append(p)
    return queue[:n]


def run_batch(pool, board: pd.DataFrame, n: int, rng: random.Random, cuts, base_over, min_trades: int) -> pd.DataFrame:
    batch = next_batch(board, n, rng, min_trades)
    rows = pool.map(_eval_star, [(p, cuts, base_over) for p in batch], chunksize=2)
    good = sorted((r for r in rows if "error" not in r and r["train_n"] >= min_trades), key=lambda r: -r["train_t"])
    for r in good[:10]:                           # Plateau-Test für die besten 10 der Runde
        nb = neighbors(json.loads(r["params"]), rng)
        nres = pool.map(_eval_star, [(p, cuts, base_over) for p in nb])
        ts = [x["train_t"] for x in nres if "error" not in x]
        r["neighbor_median_t"] = round(float(np.median(ts)), 3) if ts else 0.0
        rows.extend(x for x in nres if "error" not in x and x["key"] not in {y["key"] for y in rows})
    # bereits bekannte Varianten (z. B. als Nachbar erneut gerechnet) behalten ihren Eintrag
    board = pd.concat([board, pd.DataFrame(rows)], ignore_index=True).drop_duplicates("key", keep="first")
    BOARD.parent.mkdir(parents=True, exist_ok=True)
    board.to_csv(BOARD, index=False)
    return board


def promote(board: pd.DataFrame, min_trades: int) -> dict:
    """Champion nur, wenn VALID (nicht zum Suchen benutzt) überzeugt. HOLD wird nur berichtet."""
    n_trials = len(board)
    need_t = 2.0 + 0.25 * math.log10(max(n_trials, 10))
    b = board.dropna(subset=["train_t"]).copy()
    if "neighbor_median_t" not in b:
        b["neighbor_median_t"] = np.nan
    vcol = "valid" if "valid_t" in b else "test"
    ok = b[(b["train_n"] >= min_trades) & (b[f"{vcol}_n"] >= max(10, min_trades // 3)) & (b[f"{vcol}_t"] >= need_t)
           & (b[f"{vcol}_avgR"] > 0) & (b["neighbor_median_t"].fillna(0) >= 0.5 * b["train_t"])]
    old = yaml.safe_load(CHAMPION.read_text()) if CHAMPION.exists() else None
    result = {"trials_total": n_trials, "required_valid_t": round(need_t, 2), "qualified": int(len(ok)),
              "changed": False, "champion": old}
    if not len(ok):
        return result
    best = ok.sort_values(["train_t", f"{vcol}_t"], ascending=False).iloc[0]
    if old and old.get("metrics", {}).get(f"{vcol}_t", -1e9) >= best[f"{vcol}_t"]:
        return result
    champ = {"params": json.loads(best["params"]),
             "metrics": {k: (float(best[k]) if isinstance(best[k], (int, float, np.number)) else best[k])
                         for k in best.index if k.startswith(("train_", "valid_", "hold_", "test_", "neighbor"))},
             "trials_total": n_trials}
    CHAMPION.parent.mkdir(parents=True, exist_ok=True)
    CHAMPION.write_text(yaml.safe_dump(champ, allow_unicode=True, sort_keys=False))
    result.update(changed=True, champion=champ)
    return result


def summary(board: pd.DataFrame, min_trades: int, top: int = 10) -> pd.DataFrame:
    b = board[(board.get("train_n", 0) >= min_trades)].copy() if len(board) else board
    if not len(b):
        return b
    cols = ["key"] + [f"{s}_{m}" for s in SPLITS for m in ("n", "win", "avgR", "t")] + ["neighbor_median_t"]
    return b.nlargest(top, "train_t")[[c for c in cols if c in b]]


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
    global _STRUCT, _CAL
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--nq"); p.add_argument("--es")
    p.add_argument("--synthetic", type=int, default=0)
    p.add_argument("--trials", type=int, default=200)
    p.add_argument("--forever", action="store_true", help="endlos in Runden weitersuchen")
    p.add_argument("--batch", type=int, default=400)
    p.add_argument("--workers", type=int, default=max(1, mp.cpu_count()))
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--min-trades", type=int, default=100)
    p.add_argument("--warmup-days", type=int, default=20)
    p.add_argument("--quiet", action="store_true", help="keine Telegram-Nachrichten")
    a = p.parse_args()
    from . import notify

    frames = load_frames(a)
    cuts = split_dates(frames)
    base_over = {"warmup_days": a.warmup_days}
    t0 = time.time()
    cfg0 = config.load(**base_over)
    _STRUCT = engine.Engine(frames, cfg0).X          # Struktur einmal berechnen, per fork geteilt
    _CAL = engine.load_calendar(cfg0)
    print(f"[optimize] Struktur in {time.time() - t0:.0f}s. TRAIN < {cuts[0]} <= VALID < {cuts[1]} <= HOLD",
          flush=True)
    rng = random.Random(a.seed if a.seed is not None else int(time.time()))
    board = load_board()
    ctx = mp.get_context("fork")
    rounds = 0
    with ctx.Pool(a.workers) as pool:
        while True:
            n = a.batch if a.forever else a.trials
            t1 = time.time()
            board = run_batch(pool, board, n, rng, cuts, base_over, a.min_trades)
            res = promote(board, a.min_trades)
            rounds += 1
            rate = n / max(time.time() - t1, 1e-9) * 3600
            print(f"[optimize] Runde {rounds}: gesamt {len(board)} Varianten, {rate:.0f}/h, "
                  f"qualifiziert {res['qualified']}, Champion neu: {res['changed']}", flush=True)
            if not a.quiet and (res["changed"] or rounds % 10 == 1):
                if res["changed"]:
                    m = res["champion"]["metrics"]
                    notify.send(f"🏆 Neuer Champion nach {res['trials_total']} Varianten\n"
                                f"VALID: {int(m.get('valid_n', 0))} Trades, Ø {m.get('valid_avgR')}R, t={m.get('valid_t')}\n"
                                f"HOLD (nie gesehen): {int(m.get('hold_n', 0))} Trades, Ø {m.get('hold_avgR')}R\n"
                                "Live erst nach Prüfung: config.yaml -> learning.use_champion: true")
                else:
                    notify.send(f"🔁 Lernlauf: {res['trials_total']} Varianten getestet, {res['qualified']} bestehen "
                                f"VALID (nötig t >= {res['required_valid_t']}). Champion unverändert.")
            if not a.forever:
                break
    print(summary(board, a.min_trades).to_string(index=False))
    print(json.dumps(res, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
