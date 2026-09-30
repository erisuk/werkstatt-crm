"""TJR-Strategie-Bot: bildet die öffentlich gelehrte Intraday-Strategie von TJR regelbasiert nach.

Module:
    data       – OHLCV laden/aufbereiten
    sessions   – Session-Fenster (New-York-Zeit)
    structure  – Swings, Liquidity-Sweeps, Break of Structure, Fair Value Gaps
    strategy   – das TJR-Einstiegsmodell
    backtest   – Bar-basierter Backtester
    notify     – Telegram-/Konsolen-Benachrichtigung
    monitor    – YouTube-Kanal überwachen und neue Videos zusammenfassen
"""

__version__ = "0.1.0"
