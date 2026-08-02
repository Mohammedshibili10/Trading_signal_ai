"""
Risk management.

Position sizing, Monte Carlo, portfolio risk, VaR/CVaR and performance metrics.

The part of the platform that determines whether an account survives, so it is
deliberately conservative: warnings are surfaced rather than smoothed over, and
every function that can produce a dangerous number says so.

Spec: docs/trading-concepts.md §8.
"""

from __future__ import annotations

from typing import Any

import numpy as np

TRADING_DAYS = 252


# ─────────────────────────────────────────────────────────────────
#  Position sizing
# ─────────────────────────────────────────────────────────────────


def position_size(
    *,
    capital: float,
    risk_percent: float,
    entry: float,
    stop_loss: float,
    lot_size: int | None = None,
    target: float | None = None,
    max_position_percent: float = 25.0,
) -> dict[str, Any]:
    """
    Size from the stop, never the other way round.

    The stop distance and the risk budget determine the quantity. Choosing a
    quantity first and fitting a stop around it is the single most common way
    retail accounts blow up.
    """
    warnings: list[str] = []

    if capital <= 0 or entry <= 0:
        return _empty_size(capital, risk_percent, entry, stop_loss, ["Capital and entry must be positive."])

    risk_per_unit = abs(entry - stop_loss)
    if risk_per_unit <= 0:
        return _empty_size(capital, risk_percent, entry, stop_loss, ["Stop loss cannot equal the entry price."])

    if risk_percent > 2:
        warnings.append(
            f"Risking {risk_percent:.1f}% per trade is aggressive. Standard practice is 1%, 2% maximum — "
            "at 3% a run of six losses costs nearly a fifth of the account."
        )

    risk_amount = capital * (risk_percent / 100.0)
    quantity = int(risk_amount // risk_per_unit)

    stop_distance_pct = risk_per_unit / entry * 100.0
    if stop_distance_pct > 10:
        warnings.append(
            f"The stop is {stop_distance_pct:.1f}% away, which forces a very small position. "
            "Consider a lower timeframe entry with tighter structure."
        )
    elif stop_distance_pct < 0.3:
        warnings.append(
            f"The stop is only {stop_distance_pct:.2f}% away — likely inside normal noise. "
            "Check it against ATR before using this size."
        )

    if lot_size and lot_size > 1:
        lots = quantity // lot_size
        quantity = lots * lot_size
        if lots == 0:
            warnings.append(
                f"Risk budget does not cover one lot of {lot_size} units. "
                "Either widen the risk or trade the cash segment."
            )
    else:
        lots = None

    position_value = quantity * entry
    position_pct = position_value / capital * 100.0 if capital > 0 else 0.0

    # Concentration is a separate risk from stop distance, and stop-based sizing
    # doesn't capture it — a very tight stop can justify an enormous position.
    if position_pct > max_position_percent:
        capped_qty = int((capital * max_position_percent / 100.0) // entry)
        if lot_size and lot_size > 1:
            capped_qty = (capped_qty // lot_size) * lot_size
        warnings.append(
            f"Stop-based sizing would put {position_pct:.0f}% of capital in one position. "
            f"Capped at {max_position_percent:.0f}% — concentration is a risk the stop cannot protect against."
        )
        quantity = capped_qty
        position_value = quantity * entry
        position_pct = position_value / capital * 100.0 if capital > 0 else 0.0
        if lot_size and lot_size > 1:
            lots = quantity // lot_size

    result: dict[str, Any] = {
        "capital": round(capital, 2),
        "riskPercent": round(risk_percent, 2),
        "riskAmount": round(risk_amount, 2),
        "entry": round(entry, 4),
        "stopLoss": round(stop_loss, 4),
        "riskPerUnit": round(risk_per_unit, 4),
        "quantity": quantity,
        "positionValue": round(position_value, 2),
        "positionPercentOfCapital": round(position_pct, 2),
        "lots": lots,
        "rewardAtTarget": None,
        "riskRewardRatio": None,
        "warnings": warnings,
    }

    if target is not None and quantity > 0:
        reward_per_unit = abs(target - entry)
        result["rewardAtTarget"] = round(reward_per_unit * quantity, 2)
        rr = reward_per_unit / risk_per_unit
        result["riskRewardRatio"] = round(rr, 2)
        if rr < 1.5:
            warnings.append(
                f"Reward-to-risk of {rr:.2f} needs a {1 / (1 + rr) * 100:.0f}% win rate just to break even."
            )

    return result


def _empty_size(capital: float, risk_percent: float, entry: float, stop: float, warnings: list[str]) -> dict[str, Any]:
    return {
        "capital": round(max(capital, 0), 2), "riskPercent": risk_percent,
        "riskAmount": 0.0, "entry": entry, "stopLoss": stop, "riskPerUnit": 0.0,
        "quantity": 0, "positionValue": 0.0, "positionPercentOfCapital": 0.0,
        "lots": None, "rewardAtTarget": None, "riskRewardRatio": None, "warnings": warnings,
    }


def kelly_fraction(win_rate: float, avg_win: float, avg_loss: float) -> dict[str, Any]:
    """
    Kelly criterion: f* = W − (1−W)/R.

    Mathematically optimal for long-run growth and far too aggressive in
    practice, because W and R are estimates from a small sample and Kelly
    assumes they're exact. Fractional Kelly (¼ to ½) is what practitioners
    actually use, so that's what is recommended.
    """
    if avg_loss <= 0 or not 0 < win_rate < 1:
        return {"full": 0.0, "half": 0.0, "quarter": 0.0, "recommended": 0.0, "note": "Insufficient data."}

    r = avg_win / avg_loss
    full = win_rate - (1 - win_rate) / r

    if full <= 0:
        return {
            "full": round(full * 100, 2), "half": 0.0, "quarter": 0.0, "recommended": 0.0,
            "note": "Kelly is negative — this edge does not justify any position size.",
        }

    return {
        "full": round(full * 100, 2),
        "half": round(full * 50, 2),
        "quarter": round(full * 25, 2),
        "recommended": round(min(full * 25, 2.0), 2),
        "note": (
            f"Full Kelly suggests {full * 100:.1f}% per trade. That assumes the win rate and payoff are "
            "known exactly, which they never are — quarter-Kelly is the practical figure, capped at 2%."
        ),
    }


# ─────────────────────────────────────────────────────────────────
#  Monte Carlo
# ─────────────────────────────────────────────────────────────────


def monte_carlo(
    *,
    trade_returns: list[float],
    starting_capital: float,
    simulations: int = 5000,
    horizon: int = 100,
    seed: int | None = 42,
) -> dict[str, Any]:
    """
    Bootstrap resampling of historical trade outcomes.

    Its real lesson is not the percentile bands but the *spread* of them: the
    same edge, reordered, produces wildly different equity curves. A strategy
    with genuine positive expectancy can still be underwater after 100 trades,
    and seeing that before it happens is what stops people abandoning a working
    system at the worst moment.

    ``trade_returns`` are per-trade fractional returns on risked capital.
    """
    if not trade_returns or starting_capital <= 0:
        return {
            "simulations": 0, "horizonDays": horizon, "startingCapital": starting_capital,
            "percentiles": {"p5": 0, "p25": 0, "p50": 0, "p75": 0, "p95": 0},
            "probabilityOfProfit": 0.0, "probabilityOfRuin": 0.0,
            "medianMaxDrawdown": 0.0, "worstDrawdown": 0.0, "expectedReturn": 0.0,
            "paths": [], "summary": "No trade history to simulate.",
        }

    rng = np.random.default_rng(seed)
    returns = np.array(trade_returns, dtype=float)

    # (simulations, horizon) matrix of resampled trades.
    draws = rng.choice(returns, size=(simulations, horizon), replace=True)
    equity = starting_capital * np.cumprod(1.0 + draws, axis=1)
    equity = np.concatenate([np.full((simulations, 1), starting_capital), equity], axis=1)

    final = equity[:, -1]
    running_max = np.maximum.accumulate(equity, axis=1)
    drawdowns = (running_max - equity) / running_max
    max_dd = drawdowns.max(axis=1)

    # Ruin: down 50%+ at any point. Recovering from that needs +100%, which in
    # practice almost nobody does.
    ruin = float(np.mean(equity.min(axis=1) <= starting_capital * 0.5))

    percentiles = {
        "p5": float(np.percentile(final, 5)),
        "p25": float(np.percentile(final, 25)),
        "p50": float(np.percentile(final, 50)),
        "p75": float(np.percentile(final, 75)),
        "p95": float(np.percentile(final, 95)),
    }

    # Down-sample paths for plotting — 5000 lines is unreadable and 40 tells the
    # same story.
    sample_idx = rng.choice(simulations, size=min(40, simulations), replace=False)
    step = max(1, (horizon + 1) // 60)
    paths = [equity[i, ::step].round(2).tolist() for i in sample_idx]

    median_return = (percentiles["p50"] / starting_capital - 1) * 100
    p5_return = (percentiles["p5"] / starting_capital - 1) * 100

    summary = (
        f"Across {simulations:,} resampled sequences of {horizon} trades, the median outcome is "
        f"{median_return:+.1f}% and the 5th percentile is {p5_return:+.1f}%. "
        f"Probability of ending profitable: {float(np.mean(final > starting_capital)) * 100:.0f}%. "
        f"Median worst drawdown along the way: {float(np.median(max_dd)) * 100:.1f}%. "
        "The spread between these paths comes purely from the order the same trades arrive in."
    )
    if ruin > 0.05:
        summary += f" Note: {ruin * 100:.0f}% of paths halved the account at some point — the risk per trade is too high."

    return {
        "simulations": simulations,
        "horizonDays": horizon,
        "startingCapital": round(starting_capital, 2),
        "percentiles": {k: round(v, 2) for k, v in percentiles.items()},
        "probabilityOfProfit": round(float(np.mean(final > starting_capital)), 4),
        "probabilityOfRuin": round(ruin, 4),
        "medianMaxDrawdown": round(float(np.median(max_dd)) * 100, 2),
        "worstDrawdown": round(float(max_dd.max()) * 100, 2),
        "expectedReturn": round(float(np.mean(final) / starting_capital - 1) * 100, 2),
        "paths": paths,
        "summary": summary,
    }


# ─────────────────────────────────────────────────────────────────
#  Portfolio risk
# ─────────────────────────────────────────────────────────────────


def value_at_risk(returns: list[float], confidence: float = 0.95) -> dict[str, float]:
    """
    Historical VaR and CVaR.

    VaR tells you the quantile; CVaR tells you the average loss *beyond* it.
    Reporting VaR alone is how institutions convince themselves the tail is
    smaller than it is, so both are always returned together.
    """
    if not returns:
        return {"var": 0.0, "cvar": 0.0}

    arr = np.array(returns, dtype=float)
    var = float(np.percentile(arr, (1 - confidence) * 100))
    tail = arr[arr <= var]
    cvar = float(tail.mean()) if tail.size else var
    return {"var": abs(var), "cvar": abs(cvar)}


def portfolio_risk(
    *,
    holdings: list[dict[str, Any]],
    returns_by_symbol: dict[str, list[float]] | None = None,
    benchmark_returns: list[float] | None = None,
    risk_free_rate: float = 6.5,
) -> dict[str, Any]:
    """
    Portfolio-level risk.

    The diversification score is built from the **effective number of
    independent bets** (inverse Herfindahl on correlation-adjusted weights), not
    the holding count. Ten correlated PSU banks is one position at ten times the
    size, and a naive count would call it well diversified.
    """
    if not holdings:
        return _empty_portfolio_risk()

    total_value = sum(h.get("currentValue", 0.0) for h in holdings)
    if total_value <= 0:
        return _empty_portfolio_risk()

    weights = np.array([h.get("currentValue", 0.0) / total_value for h in holdings], dtype=float)
    symbols = [h.get("symbol", "") for h in holdings]

    # ── Correlation-adjusted concentration ───────────────────────
    avg_correlation = 0.0
    correlation_warnings: list[str] = []

    if returns_by_symbol:
        series = [returns_by_symbol.get(s) for s in symbols]
        usable = [(i, s) for i, s in enumerate(series) if s and len(s) >= 30]
        if len(usable) >= 2:
            length = min(len(s) for _, s in usable)
            matrix = np.array([s[-length:] for _, s in usable], dtype=float)
            corr = np.corrcoef(matrix)
            idx = [i for i, _ in usable]

            off_diagonal = corr[np.triu_indices_from(corr, k=1)]
            avg_correlation = float(np.nanmean(off_diagonal)) if off_diagonal.size else 0.0

            for a in range(len(idx)):
                for b in range(a + 1, len(idx)):
                    c = corr[a, b]
                    if np.isfinite(c) and c >= 0.7:
                        combined = (weights[idx[a]] + weights[idx[b]]) * 100
                        correlation_warnings.append(
                            f"{symbols[idx[a]]} and {symbols[idx[b]]} move together "
                            f"({c:.2f} correlation) and are {combined:.0f}% of the book — "
                            "treat them as one position."
                        )

    herfindahl = float(np.sum(weights**2))
    effective_positions = 1.0 / herfindahl if herfindahl > 0 else 0.0
    # Correlation shrinks the effective count toward 1.
    correlation_penalty = 1.0 - max(0.0, avg_correlation) * 0.7
    effective_independent = max(1.0, effective_positions * correlation_penalty)

    diversification = float(np.clip((effective_independent - 1) / 9.0 * 100, 0, 100))
    concentration = float(np.clip(herfindahl * 100, 0, 100))

    # ── Volatility, beta, ratios ─────────────────────────────────
    portfolio_returns: list[float] = []
    if returns_by_symbol:
        length = min(
            (len(returns_by_symbol[s]) for s in symbols if returns_by_symbol.get(s)),
            default=0,
        )
        if length >= 30:
            stacked = np.array(
                [returns_by_symbol.get(s, [0.0] * length)[-length:] for s in symbols], dtype=float
            )
            portfolio_returns = (weights @ stacked).tolist()

    volatility_annual = 0.0
    sharpe = sortino = None
    max_dd = 0.0
    var95 = var99 = cvar95 = 0.0

    if portfolio_returns:
        arr = np.array(portfolio_returns, dtype=float)
        volatility_annual = float(np.std(arr, ddof=1) * np.sqrt(TRADING_DAYS) * 100)

        mean_annual = float(np.mean(arr) * TRADING_DAYS * 100)
        excess = mean_annual - risk_free_rate
        if volatility_annual > 0:
            sharpe = round(excess / volatility_annual, 2)

        downside = arr[arr < 0]
        if downside.size > 1:
            downside_dev = float(np.std(downside, ddof=1) * np.sqrt(TRADING_DAYS) * 100)
            if downside_dev > 0:
                sortino = round(excess / downside_dev, 2)

        equity = np.cumprod(1 + arr)
        peak = np.maximum.accumulate(equity)
        max_dd = float(np.max((peak - equity) / peak) * 100)

        v95 = value_at_risk(portfolio_returns, 0.95)
        v99 = value_at_risk(portfolio_returns, 0.99)
        var95, cvar95 = v95["var"] * total_value, v95["cvar"] * total_value
        var99 = v99["var"] * total_value

    beta = None
    if portfolio_returns and benchmark_returns:
        length = min(len(portfolio_returns), len(benchmark_returns))
        if length >= 30:
            p = np.array(portfolio_returns[-length:], dtype=float)
            b = np.array(benchmark_returns[-length:], dtype=float)
            variance = float(np.var(b, ddof=1))
            if variance > 0:
                beta = round(float(np.cov(p, b, ddof=1)[0, 1] / variance), 2)

    # ── Exposure ─────────────────────────────────────────────────
    sector_map: dict[str, float] = {}
    class_map: dict[str, float] = {}
    for h in holdings:
        value = h.get("currentValue", 0.0)
        sector_map[h.get("sector") or "Unclassified"] = sector_map.get(h.get("sector") or "Unclassified", 0.0) + value
        class_map[h.get("assetClass") or "EQUITY"] = class_map.get(h.get("assetClass") or "EQUITY", 0.0) + value

    sector_exposure = sorted(
        ({"sector": k, "percent": round(v / total_value * 100, 2), "value": round(v, 2)} for k, v in sector_map.items()),
        key=lambda x: -x["percent"],
    )
    class_exposure = sorted(
        ({"assetClass": k, "percent": round(v / total_value * 100, 2), "value": round(v, 2)} for k, v in class_map.items()),
        key=lambda x: -x["percent"],
    )

    # ── Recommendations ──────────────────────────────────────────
    recommendations: list[str] = []
    for s in sector_exposure:
        if s["percent"] > 30:
            recommendations.append(
                f"{s['sector']} is {s['percent']:.0f}% of the portfolio. A sector-wide shock would hit a third of the book — consider trimming toward 25%."
            )
    if diversification < 35:
        recommendations.append(
            f"Effective independent positions: {effective_independent:.1f}. "
            "The portfolio is concentrated once correlation is accounted for."
        )
    if max_dd > 20:
        recommendations.append(
            f"Historical drawdown reached {max_dd:.0f}%. Recovering from that requires a {100 * (1 / (1 - max_dd / 100) - 1):.0f}% gain."
        )
    if beta is not None and beta > 1.3:
        recommendations.append(
            f"Portfolio beta is {beta:.2f} — it amplifies index moves by {(beta - 1) * 100:.0f}%. Expect larger swings than NIFTY."
        )
    if sharpe is not None and sharpe < 0.5:
        recommendations.append(
            f"Sharpe of {sharpe:.2f} means the returns are not compensating for the volatility taken."
        )
    if not recommendations:
        recommendations.append("Exposure, concentration and drawdown are all within reasonable bounds.")

    return {
        "portfolioValue": round(total_value, 2),
        "valueAtRisk95": round(var95, 2),
        "valueAtRisk99": round(var99, 2),
        "conditionalVar95": round(cvar95, 2),
        "volatilityAnnual": round(volatility_annual, 2),
        "beta": beta,
        "sharpe": sharpe,
        "sortino": sortino,
        "maxDrawdown": round(max_dd, 2),
        "diversificationScore": round(diversification, 1),
        "concentrationRisk": round(concentration, 1),
        "effectivePositions": round(effective_independent, 2),
        "averageCorrelation": round(avg_correlation, 3),
        "sectorExposure": sector_exposure,
        "assetClassExposure": class_exposure,
        "correlationWarnings": correlation_warnings[:5],
        "recommendations": recommendations,
    }


def _empty_portfolio_risk() -> dict[str, Any]:
    return {
        "portfolioValue": 0.0, "valueAtRisk95": 0.0, "valueAtRisk99": 0.0, "conditionalVar95": 0.0,
        "volatilityAnnual": 0.0, "beta": None, "sharpe": None, "sortino": None, "maxDrawdown": 0.0,
        "diversificationScore": 0.0, "concentrationRisk": 0.0, "effectivePositions": 0.0,
        "averageCorrelation": 0.0, "sectorExposure": [], "assetClassExposure": [],
        "correlationWarnings": [], "recommendations": ["Add holdings to see portfolio risk."],
    }


# ─────────────────────────────────────────────────────────────────
#  Stops
# ─────────────────────────────────────────────────────────────────


def atr_stop(entry: float, atr: float, *, multiplier: float = 2.0, long: bool = True) -> dict[str, Any]:
    distance = atr * multiplier
    stop = entry - distance if long else entry + distance
    return {
        "stopLoss": round(stop, 4),
        "distance": round(distance, 4),
        "distancePercent": round(distance / entry * 100, 2) if entry else 0.0,
        "multiplier": multiplier,
        "note": (
            f"{multiplier}× ATR gives the position room to breathe through normal volatility. "
            "Tighter multiples get stopped out by noise; wider ones cost more than the setup is worth."
        ),
    }


def trailing_stop(
    *, entry: float, current_price: float, highest: float, atr: float,
    multiplier: float = 3.0, long: bool = True,
) -> dict[str, Any]:
    """
    Chandelier exit — trail from the extreme reached, not from entry.

    Only engages after 1R is banked. Trailing from the first tick is how a
    winning trade becomes a scratch.
    """
    r_multiple = (current_price - entry) / (atr * 2) if long else (entry - current_price) / (atr * 2)
    engaged = r_multiple >= 1.0

    if long:
        stop = highest - atr * multiplier
        stop = max(stop, entry) if engaged else entry - atr * 2
    else:
        stop = highest + atr * multiplier
        stop = min(stop, entry) if engaged else entry + atr * 2

    return {
        "stopLoss": round(stop, 4),
        "engaged": engaged,
        "rMultiple": round(r_multiple, 2),
        "note": (
            f"Trailing at {multiplier}× ATR from the extreme. Currently {r_multiple:.1f}R — "
            + ("stop has moved to protect profit." if engaged else "trailing engages once 1R is banked.")
        ),
    }
