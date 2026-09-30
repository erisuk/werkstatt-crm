from tjrbot import monitor


def test_new_videos_notified_once(tmp_path, monkeypatch):
    vids = [monitor.Video("b", "Neu", "u2", "2026-09-28T12:00:00", "desc"),
            monitor.Video("a", "Alt", "u1", "2026-09-27T12:00:00", "desc")]
    sent = []
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "seen.json")
    monkeypatch.setattr(monitor, "KNOWLEDGE_DIR", tmp_path / "k")
    monkeypatch.setattr(monitor, "fetch_feed", lambda cid: vids)
    monkeypatch.setattr(monitor, "channel_id", lambda: "UC_TEST")
    monkeypatch.setattr(monitor, "fetch_transcript", lambda vid: None)
    monkeypatch.setattr(monitor.notify, "send", lambda m: sent.append(m) or True)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)

    assert monitor.run() == 2
    assert "Alt" in sent[0] and "Neu" in sent[1]           # älteste zuerst
    assert all("nicht von TJR" in m for m in sent)          # nie als TJR ausgeben
    assert monitor.run() == 0                               # kein Doppel-Versand
    assert len(list((tmp_path / "k").glob("*.md"))) == 2


def test_init_marks_seen_without_sending(tmp_path, monkeypatch):
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "seen.json")
    monkeypatch.setattr(monitor, "fetch_feed", lambda cid: [monitor.Video("x", "t", "u", "", "")])
    monkeypatch.setattr(monitor, "channel_id", lambda: "UC_TEST")
    monkeypatch.setattr(monitor.notify, "send", lambda m: (_ for _ in ()).throw(AssertionError("sent")))
    monitor.run(init=True)
    assert monitor.run() == 0
