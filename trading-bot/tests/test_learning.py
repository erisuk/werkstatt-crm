import json

import pandas as pd

from tjrbot import analysis, optimize


def test_analysis_finds_losing_group():
    tr = pd.DataFrame({"signal": ["2026-01-05 09:52"] * 4 + ["2026-01-06 10:12"] * 4, "index": "NQ",
                       "dir": "SHORT", "bias": "NEUTRAL", "levels": "PRE_H", "trigger": "1m-BOS",
                       "confirm": "BOS", "exit": "STOP", "R": [-1, -1, -1, -1, 2, 2, 2, 2]})
    a = analysis.analyze(tr, [], [])
    assert a["by_time"]["09:50"]["avg_R"] == -1 and "09:50" in analysis.text_report(a)


def test_promote_requires_out_of_sample_strength(tmp_path, monkeypatch):
    monkeypatch.setattr(optimize, "CHAMPION", tmp_path / "champ.yaml")
    base = {"train_n": 200, "train_t": 4.0, "test_n": 80, "neighbor_median_t": 3.0}
    board = pd.DataFrame([
        {**base, "key": "a", "params": json.dumps({"x": 1}), "test_t": 0.5, "test_avgR": 0.02},   # nur Train gut
        {**base, "key": "b", "params": json.dumps({"x": 2}), "test_t": 3.5, "test_avgR": 0.20},
    ])
    res = optimize.promote(board, min_trades=100)
    assert res["changed"] and res["champion"]["params"] == {"x": 2}
    board.loc[1, "neighbor_median_t"] = 0.1                                                      # Zufallsspitze
    (tmp_path / "champ.yaml").unlink()
    assert not optimize.promote(board, min_trades=100)["changed"]
