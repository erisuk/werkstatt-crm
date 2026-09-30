"""Benachrichtigungen: Telegram (wenn TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID gesetzt), sonst Konsole."""
from __future__ import annotations

import os

import requests

TELEGRAM_LIMIT = 4000  # Telegram erlaubt 4096 Zeichen pro Nachricht


def _chunks(text: str, size: int = TELEGRAM_LIMIT):
    while text:
        if len(text) <= size:
            yield text
            return
        cut = text.rfind("\n", 0, size)
        cut = cut if cut > size // 2 else size
        yield text[:cut]
        text = text[cut:].lstrip("\n")


def send(text: str) -> bool:
    """Nachricht senden. Gibt True zurück, wenn Telegram erfolgreich war."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print(text)
        return False
    ok = True
    for part in _chunks(text):
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": part, "disable_web_page_preview": False},
            timeout=20,
        )
        ok = ok and r.ok
        if not r.ok:
            print(f"Telegram-Fehler {r.status_code}: {r.text[:200]}")
    return ok
