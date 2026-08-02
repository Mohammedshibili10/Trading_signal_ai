"""
Analysis engine.

Module map:

    indicators.py   Trend, momentum, volatility and volume indicators
    anatomy.py      Per-candle measurement and classification
    candlesticks.py Named pattern recognition with context multipliers
    structure.py    Swings, trend, support/resistance, trendlines, BOS/CHoCH
    smc.py          Order blocks, fair value gaps, liquidity, premium/discount
    patterns.py     Chart patterns (double tops, H&S, triangles, flags, cups)
    price_action.py Breakouts, retests, pullbacks, channels
    factors.py      Nine weighted evidence groups
    forecast.py     Blending, probability and confidence
    calibration.py  Walk-forward measurement and monotone correction
    signals.py      Trade levels, rejection rules
    pipeline.py     Orchestration — the single entry point
    risk.py         Position sizing, Monte Carlo, portfolio risk
    backtest.py     Strategy simulation
    sentiment.py    FinBERT / finance-lexicon news classification
    fundamentals.py Indian equity scoring
    invest.py       SIP, goal and retirement planning
    assistant.py    Grounded LLM explanations

Methodology: docs/signal-methodology.md
Domain reference: docs/trading-concepts.md
"""
