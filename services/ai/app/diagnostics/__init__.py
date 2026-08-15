"""
Diagnostics.

This package answers one question before any rebuild work is authorised:
**where does the system actually lose?** It deliberately contains no signal
logic of its own. Everything here reads the live engine, replays it, and
measures it.

The distinction that motivates the whole package: the platform already ships a
simulator (``engine/backtest.py``), but that simulator evaluates *strategy
builder* rules — user-assembled threshold conditions — and has never once run
the signal engine that publishes to the feed. Those are two unrelated code
paths. Every published signal in this system's history has therefore been
issued by a component whose expectancy was never measured.

``replay.py`` closes that gap: it walks closed bars, calls the same
``pipeline.analyse`` the live scanner calls, and turns the resulting signals
into simulated trades under the engine's own exit geometry. Diagnostics 1.1,
1.3, 1.4 and 1.6 are all computed on that trade population, because without it
they have no population to compute on.

Module map:

    config.py        Every threshold, as configuration with a stated default
    loader.py        Candle series from a CSV export of the candle store
    replay.py        Bar-by-bar replay of the live signal path
    simulate.py      Exit geometry, cost charging, excursion tracking
    metrics.py       Expectancy, profit factor, hit rate, Sharpe, drawdown
    audit.py         Static data-path audit — the §1.2 written questions
    checks/          One module per numbered diagnostic
    report.py        Consolidated markdown report
    __main__.py      CLI entry point

Nothing in this package writes to the database or mutates engine state.
"""

from __future__ import annotations

__all__ = ["config", "loader", "replay", "simulate", "metrics", "audit", "report"]
