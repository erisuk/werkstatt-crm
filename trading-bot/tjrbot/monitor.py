"""TJRs YouTube-Kanal überwachen: neue Videos erkennen, Transkript holen, auf Deutsch zusammenfassen,
per Telegram melden und in der Wissensbasis (knowledge/) ablegen.

Der Bot spricht NICHT als TJR, sondern berichtet, was TJR gesagt hat ("TJR sagt: ...").

Aufruf:
    python -m tjrbot.monitor              # neue Videos verarbeiten
    python -m tjrbot.monitor --dry-run    # nur anzeigen, nichts senden/speichern
    python -m tjrbot.monitor --init       # aktuelle Videos als "gesehen" markieren, ohne zu melden
    python -m tjrbot.monitor --video ID --transcript-file t.txt   # selbst kopiertes Transkript

Umgebungsvariablen: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TJR_CHANNEL_ID (optional).
"""
from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path

import feedparser

from . import notify

ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = ROOT / "state" / "seen_videos.json"
KNOWLEDGE_DIR = ROOT / "knowledge" / "videos"
CONFIG_FILE = ROOT / "config.yaml"

MODEL = "claude-opus-5"
MAX_TRANSCRIPT_CHARS = 400_000  # ~100k Tokens; längere Livestreams werden gekürzt (wird im Text vermerkt)

SYSTEM_PROMPT = """Du bist ein Analyse-Assistent, der Trading-Videos des YouTubers TJR für einen deutschsprachigen
Trader zusammenfasst. Du sprichst NICHT als TJR und gibst dich nicht als er aus, sondern berichtest in der
dritten Person ("TJR sagt ...", "Laut TJR ...").

Antworte auf Deutsch, knapp und konkret, in genau diesen Abschnitten (Telegram-tauglich, kein Markdown-Tabellen):

📢 Kernaussage – 1–2 Sätze: worum geht es im Video?
📊 Markt & Bias – welche Märkte (NQ, ES, Forex, …), welcher Bias (bullish/bearish/neutral) und warum,
   genannte Levels (Preise, Highs/Lows, FVGs, Sessions). Nur was wirklich gesagt wurde.
🧠 Strategie-Details – Regeln, Einstiegsmodelle, Bestätigungen, Stop/Target, Risiko, Uhrzeiten.
🔄 Neu oder geändert? – weicht etwas von TJRs bekanntem Modell ab (Liquidity Sweep → Bestätigung wie BOS/
   CHoCH/iFVG/SMT → Einstieg an FVG/Order Block, NY-Session)? Wenn ja, genau beschreiben, sonst "Nichts Neues".
⚠️ Termine & Warnungen – News, Feiertage, Dinge, die TJR meidet.
💬 Zitate – bis zu 3 kurze wörtliche Zitate (Originalsprache) mit Kontext.

Erfinde nichts. Wenn das Transkript fehlt und nur Titel/Beschreibung vorliegen, sag das klar und fasse nur
diese zusammen."""


@dataclass
class Video:
    video_id: str
    title: str
    url: str
    published: str
    description: str


def monitor_cfg() -> dict:
    if CONFIG_FILE.exists():
        import yaml

        return (yaml.safe_load(CONFIG_FILE.read_text()) or {}).get("monitor") or {}
    return {}


def channel_id() -> str:
    cid = os.environ.get("TJR_CHANNEL_ID") or monitor_cfg().get("youtube_channel_id")
    if cid:
        return cid
    raise SystemExit("Kein YouTube-Kanal konfiguriert (config.yaml monitor.youtube_channel_id oder TJR_CHANNEL_ID)")


def fetch_feed(cid: str) -> list[Video]:
    feed = feedparser.parse(f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}")
    if feed.bozo and not feed.entries:
        raise RuntimeError(f"RSS-Feed nicht lesbar: {feed.bozo_exception}")
    videos = []
    for e in feed.entries:
        if e.get("yt_channelid") and e.get("yt_channelid") != cid:
            continue  # nur Originalkanal, keine Clip-Kanäle
        vid = e.get("yt_videoid") or e.get("id", "").split(":")[-1]
        videos.append(Video(
            video_id=vid,
            title=e.get("title", ""),
            url=e.get("link", f"https://www.youtube.com/watch?v={vid}"),
            published=e.get("published", ""),
            description=(e.get("media_description") or e.get("summary") or "")[:5000],
        ))
    return videos


def fetch_transcript(video_id: str) -> str | None:
    """Transkript über youtube-transcript-api. YouTube blockiert das teils von Cloud-IPs -> dann None."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi

        fetched = YouTubeTranscriptApi().fetch(video_id, languages=("en", "en-US", "de"))
        return " ".join(snippet.text for snippet in fetched)
    except Exception as exc:  # noqa: BLE001 - jede Fehlerart heißt: kein Transkript
        print(f"[monitor] kein Transkript für {video_id}: {type(exc).__name__}: {exc}"[:300])
        return None


def summarize(video: Video, transcript: str | None) -> str:
    """Zusammenfassung über die Claude API. Ohne ANTHROPIC_API_KEY: nur Titel + Beschreibung."""
    if not os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return f"(Keine KI-Zusammenfassung – ANTHROPIC_API_KEY fehlt)\n\n{video.description[:1500]}"

    import anthropic

    note = ""
    if transcript and len(transcript) > MAX_TRANSCRIPT_CHARS:
        transcript = transcript[:MAX_TRANSCRIPT_CHARS]
        note = "\n[Hinweis: Transkript wurde wegen Länge gekürzt – nur der erste Teil liegt vor.]"
    body = (
        f"Titel: {video.title}\nVeröffentlicht: {video.published}\nLink: {video.url}\n\n"
        f"Beschreibung:\n{video.description}\n\n"
        + (f"Transkript:{note}\n{transcript}" if transcript else "Transkript: NICHT VERFÜGBAR")
    )
    client = anthropic.Anthropic()
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=8000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        thinking={"type": "adaptive"},
        output_config={"effort": "medium"},
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": body}],
    ) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        return "(Zusammenfassung wurde vom Modell abgelehnt.)"
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    if msg.stop_reason == "max_tokens":
        text += "\n[… gekürzt]"
    return text


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"seen": []}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state["seen"] = state["seen"][-500:]
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")


def save_knowledge(video: Video, summary: str, transcript: str | None) -> Path:
    KNOWLEDGE_DIR.mkdir(parents=True, exist_ok=True)
    path = KNOWLEDGE_DIR / f"{video.published[:10]}_{video.video_id}.md"
    path.write_text(
        f"# {video.title}\n\n- Link: {video.url}\n- Veröffentlicht: {video.published}\n"
        f"- Transkript: {'ja' if transcript else 'nein'}\n\n## Zusammenfassung\n\n{summary}\n",
        encoding="utf-8",
    )
    return path


def format_message(video: Video, summary: str) -> str:
    return (f"📢 Neues TJR-Video: {video.title}\n{video.url}\n"
            f"(Inoffizielle Zusammenfassung – nicht von TJR geschrieben)\n\n{summary}")


def run(dry_run: bool = False, init: bool = False, limit: int = 5) -> int:
    state = load_state()
    seen = set(state["seen"])
    videos = fetch_feed(channel_id())
    new = [v for v in reversed(videos) if v.video_id not in seen]  # älteste zuerst
    if init:
        state["seen"].extend(v.video_id for v in new)
        save_state(state)
        print(f"{len(new)} Videos als gesehen markiert.")
        return 0
    if len(new) > limit:
        print(f"[monitor] {len(new)} neue Videos, verarbeite nur die neuesten {limit}.")
        skipped, new = new[:-limit], new[-limit:]
        if not dry_run:
            state["seen"].extend(v.video_id for v in skipped)
    use_transcripts = monitor_cfg().get("fetch_transcripts", True)
    for v in new:
        transcript = fetch_transcript(v.video_id) if use_transcripts else None
        summary = summarize(v, transcript)
        msg = format_message(v, summary)
        if dry_run:
            print(msg, "\n", "=" * 60)
            continue
        notify.send(msg)
        save_knowledge(v, summary, transcript)
        state["seen"].append(v.video_id)
        save_state(state)  # nach jedem Video speichern, damit nichts doppelt gemeldet wird
    if not new:
        print("[monitor] keine neuen Videos.")
    return len(new)


def summarize_manual(video_id: str, transcript_file: str, dry_run: bool = False) -> None:
    """Selbst kopiertes Transkript (z. B. aus YouTube "Transkript anzeigen") zusammenfassen und melden."""
    v = Video(video_id, f"Video {video_id}", f"https://www.youtube.com/watch?v={video_id}", "", "")
    for x in fetch_feed(channel_id()) if not dry_run else []:
        if x.video_id == video_id:
            v = x
    transcript = Path(transcript_file).read_text(encoding="utf-8")
    summary = summarize(v, transcript)
    msg = format_message(v, summary)
    if dry_run:
        print(msg)
        return
    notify.send(msg)
    save_knowledge(v, summary, transcript)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--init", action="store_true")
    p.add_argument("--limit", type=int, default=5)
    p.add_argument("--video", help="Video-ID für manuelles Transkript")
    p.add_argument("--transcript-file", help="Textdatei mit Transkript (zusammen mit --video)")
    a = p.parse_args()
    if a.video and a.transcript_file:
        summarize_manual(a.video, a.transcript_file, a.dry_run)
        return
    run(dry_run=a.dry_run, init=a.init, limit=a.limit)


if __name__ == "__main__":
    main()
