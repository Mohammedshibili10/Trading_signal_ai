"""
Strategy backtesting.

Evaluates no-code strategies built from indicator conditions.

Three rules are enforced because breaking any of them is what makes backtests
look brilliant and trade badly:

1. **No look-ahead.** Conditions are evaluated on bar *i*; the fill happens at
   bar *i+1*'s **open**. Filling at the signal bar's close means trading on
   information you didn't have until the bar finished.
2. **Costs are charged.** Brokerage, STT, exchange fees and slippage are
   deducted on both legs. A strategy that only works gross of costs does not
   work.
3. **Intrabar order is assumed adverse.** When a bar touches both the stop and
   the target, the stop fills. Without knowing the tick sequence, assuming the
   good outcome inflates every result.

Spec: docs/trading-concepts.md §12.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from .indicators import compute_all

log = logging.getLogger(__name__)

#: Round-trip cost in basis points for Indian equity delivery, approximating
#: brokerage + STT + exchange charges + GST + stamp duty. Configurable per run.
DEFAULT_COST_BPS = 25.0
DEFAULT_SLIPPAGE_BPS = 5.0


@dataclass
class Trade:
    symbol: str
    side: str
    entry_time: int
    entry_price: float
    exit_time: int
    exit_price: float
    quantity: float
    pnl: float
    pnl_percent: float
    exit_reason: str
    bars: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol, "side": self.side,
            "entryTime": self.entry_time, "entryPrice": round(self.entry_price, 4),
            "exitTime": self.exit_time, "exitPrice": round(self.exit_price, 4),
            "quantity": round(self.quantity, 4),
            "pnl": round(self.pnl, 2), "pnlPercent": round(self.pnl_percent, 3),
            "exitReason": self.exit_reason, "bars": self.bars,
        }


@dataclass
class OpenPosition:
    side: str
    entry_index: int
    entry_price: float
    quantity: float
    stop: float | None
    target: float | None
    highest: float
    lowest: float
    bars: int = 0


# ─────────────────────────────────────────────────────────────────
#  Condition evaluation
# ─────────────────────────────────────────────────────────────────

#: Maps a strategy-builder indicator name to the series key(s) produced by
#: compute_all, plus the parameter used to select a period variant.
INDICATOR_SERIES: dict[str, str] = {
    "RSI": "rsi",
    "MACD": "macd",
    "MACD_SIGNAL": "macd_signal",
    "MACD_HIST": "macd_hist",
    "ADX": "adx",
    "ATR": "atr",
    "CCI": "cci",
    "MFI": "mfi",
    "STOCH_K": "stoch_k",
    "STOCH_D": "stoch_d",
    "WILLIAMS_R": "williams_r",
    "OBV": "obv",
    "VWAP": "vwap",
    "BB_UPPER": "bb_upper",
    "BB_LOWER": "bb_lower",
    "BB_MIDDLE": "bb_middle",
    "BB_PERCENT_B": "bb_percent_b",
    "SUPERTREND": "supertrend",
    "SUPERTREND_DIR": "supertrend_dir",
    "VOLUME_RATIO": "volume_ratio",
    "PRICE": "close",
    "CLOSE": "close",
    "OPEN": "open",
    "HIGH": "high",
    "LOW": "low",
    "VOLUME": "volume",
}


def resolve_series(
    name: str, params: dict[str, Any], df: pd.DataFrame, ind: dict[str, pd.Series]
) -> pd.Series | None:
    """
    Resolve an indicator reference to a series.

    Handles both plain names (``RSI``) and period-qualified references from the
    builder's right-hand side (``EMA:50``).
    """
    key = name.upper().strip()

    if ":" in key:
        base, _, period = key.partition(":")
        key = base
        params = {**params, "period": int(period) if period.isdigit() else params.get("period", 20)}

    if key in {"EMA", "SMA"}:
        period = int(params.get("period", 20))
        series_key = f"{key.lower()}_{period}"
        if series_key in ind:
            return ind[series_key]
        # Period not precomputed — build it on demand.
        from .indicators import ema, sma
        fn = ema if key == "EMA" else sma
        return fn(df["close"], period)

    if key in {"OPEN", "HIGH", "LOW", "CLOSE", "PRICE", "VOLUME"}:
        column = "close" if key == "PRICE" else key.lower()
        return df[column]

    mapped = INDICATOR_SERIES.get(key)
    if mapped and mapped in ind:
        return ind[mapped]
    if mapped and mapped in df.columns:
        return df[mapped]

    log.warning("unknown indicator reference in strategy: %s", name)
    return None


def evaluate_condition(
    condition: dict[str, Any], df: pd.DataFrame, ind: dict[str, pd.Series]
) -> pd.Series:
    """
    Evaluate one condition across the whole series, returning a boolean Series.

    Vectorised deliberately — evaluating per-bar inside the simulation loop
    turns a 2-second backtest into a 3-minute one.
    """
    left = resolve_series(condition.get("indicator", ""), condition.get("params", {}) or {}, df, ind)
    if left is None:
        return pd.Series(False, index=df.index)

    raw_value = condition.get("value")
    operator = str(condition.get("operator", "GT")).upper()

    if isinstance(raw_value, str) and not raw_value.replace(".", "", 1).replace("-", "", 1).isdigit():
        right = resolve_series(raw_value, condition.get("params", {}) or {}, df, ind)
        if right is None:
            return pd.Series(False, index=df.index)
    else:
        try:
            right = pd.Series(float(raw_value), index=df.index)
        except (TypeError, ValueError):
            return pd.Series(False, index=df.index)

    left_prev, right_prev = left.shift(1), right.shift(1)

    if operator == "GT":
        result = left > right
    elif operator == "LT":
        result = left < right
    elif operator == "GTE":
        result = left >= right
    elif operator == "LTE":
        result = left <= right
    elif operator == "EQUALS":
        result = np.isclose(left, right, rtol=1e-4)
        result = pd.Series(result, index=df.index)
    elif operator == "CROSSES_ABOVE":
        result = (left > right) & (left_prev <= right_prev)
    elif operator == "CROSSES_BELOW":
        result = (left < right) & (left_prev >= right_prev)
    elif operator == "IS":
        # Boolean-ish series such as SUPERTREND_DIR, where value is 1 / −1.
        try:
            result = np.isclose(left, float(raw_value))
            result = pd.Series(result, index=df.index)
        except (TypeError, ValueError):
            result = pd.Series(False, index=df.index)
    else:
        result = pd.Series(False, index=df.index)

    return result.fillna(False).astype(bool)


def evaluate_rule(rule: dict[str, Any], df: pd.DataFrame, ind: dict[str, pd.Series]) -> pd.Series:
    """Combine a rule's conditions with AND / OR."""
    conditions = rule.get("conditions") or []
    if not conditions:
        return pd.Series(False, index=df.index)

    logic = str(rule.get("logic", "AND")).upper()
    result: pd.Series | None = None

    for condition in conditions:
        evaluated = evaluate_condition(condition, df, ind)
        if result is None:
            result = evaluated
        elif logic == "OR":
            result = result | evaluated
        else:
            result = result & evaluated

    return result if result is not None else pd.Series(False, index=df.index)


# ─────────────────────────────────────────────────────────────────
#  Simulation
# ─────────────────────────────────────────────────────────────────


def run(
    candles: list[dict[str, Any]],
    strategy: dict[str, Any],
    *,
    symbol: str = "",
    initial_capital: float = 1_000_000.0,
    cost_bps: float = DEFAULT_COST_BPS,
    slippage_bps: float = DEFAULT_SLIPPAGE_BPS,
    allow_short: bool = False,
) -> dict[str, Any]:
    """Run one strategy over one instrument's candles."""
    from .pipeline import to_frame

    df = to_frame(candles)
    warnings: list[str] = []

    if len(df) < 60:
        return _empty_result(strategy, initial_capital, ["Not enough history to backtest — need at least 60 bars."])

    ind = compute_all(df)

    entry_signals = evaluate_rule(strategy.get("entry") or {}, df, ind)
    exit_signals = evaluate_rule(strategy.get("exit") or {}, df, ind)

    if not entry_signals.any():
        return _empty_result(strategy, initial_capital, ["The entry conditions never triggered on this data."])

    risk_percent = float(strategy.get("riskPerTradePercent", 1.0))
    stop_percent = strategy.get("stopLossPercent")
    target_percent = strategy.get("takeProfitPercent")
    use_atr = bool(strategy.get("useAtrStop", False))
    atr_mult = float(strategy.get("atrMultiplier", 2.0))

    opens = df["open"].to_numpy(dtype=float)
    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)
    atr_series = ind["atr"].to_numpy(dtype=float)
    times = [int(t.timestamp()) for t in df.index]

    entries = entry_signals.to_numpy()
    exits = exit_signals.to_numpy()

    capital = initial_capital
    equity_curve: list[dict[str, Any]] = []
    trades: list[Trade] = []
    position: OpenPosition | None = None
    peak = initial_capital

    cost_rate = (cost_bps + slippage_bps) / 10_000.0

    # Start after the longest warm-up so we never trade on a partially-formed
    # indicator. 200 covers the 200-period EMA.
    start = min(200, len(df) // 3)

    for i in range(start, len(df) - 1):
        # ── Manage an open position ──────────────────────────────
        if position is not None:
            position.bars += 1
            position.highest = max(position.highest, highs[i])
            position.lowest = min(position.lowest, lows[i])

            exit_price: float | None = None
            reason = ""

            # Stop first. When a bar touches both stop and target we cannot know
            # the intrabar order, so we assume the adverse one.
            if position.stop is not None:
                if position.side == "LONG" and lows[i] <= position.stop:
                    exit_price, reason = position.stop, "Stop loss"
                elif position.side == "SHORT" and highs[i] >= position.stop:
                    exit_price, reason = position.stop, "Stop loss"

            if exit_price is None and position.target is not None:
                if position.side == "LONG" and highs[i] >= position.target:
                    exit_price, reason = position.target, "Target"
                elif position.side == "SHORT" and lows[i] <= position.target:
                    exit_price, reason = position.target, "Target"

            # Rule-based exit fills on the next open, like an entry.
            if exit_price is None and exits[i]:
                exit_price, reason = opens[i + 1], "Exit signal"

            if exit_price is not None:
                gross = (
                    (exit_price - position.entry_price) * position.quantity
                    if position.side == "LONG"
                    else (position.entry_price - exit_price) * position.quantity
                )
                costs = (position.entry_price + exit_price) * position.quantity * cost_rate
                pnl = gross - costs
                capital += pnl

                trades.append(
                    Trade(
                        symbol=symbol, side=position.side,
                        entry_time=times[position.entry_index], entry_price=position.entry_price,
                        exit_time=times[i], exit_price=exit_price, quantity=position.quantity,
                        pnl=pnl,
                        pnl_percent=(pnl / (position.entry_price * position.quantity) * 100)
                        if position.entry_price * position.quantity else 0.0,
                        exit_reason=reason, bars=position.bars,
                    )
                )
                position = None

        # ── Open a new position ──────────────────────────────────
        if position is None and entries[i] and capital > 0:
            fill = opens[i + 1]  # next bar's open — never the signal bar's close
            if not np.isfinite(fill) or fill <= 0:
                continue

            atr_now = atr_series[i] if np.isfinite(atr_series[i]) else 0.0

            if use_atr and atr_now > 0:
                stop_distance = atr_now * atr_mult
            elif stop_percent:
                stop_distance = fill * float(stop_percent) / 100.0
            else:
                stop_distance = fill * 0.05

            if stop_distance <= 0:
                continue

            risk_amount = capital * risk_percent / 100.0
            quantity = risk_amount / stop_distance
            position_value = quantity * fill

            # Never exceed available capital on a long.
            if position_value > capital:
                quantity = capital / fill
                position_value = capital

            if quantity <= 0:
                continue

            side = "LONG"
            stop = fill - stop_distance
            target = fill + stop_distance * (float(target_percent) / float(stop_percent)) if (target_percent and stop_percent) else (
                fill + stop_distance * 2.0 if target_percent else None
            )

            position = OpenPosition(
                side=side, entry_index=i + 1, entry_price=fill, quantity=quantity,
                stop=stop, target=target, highest=fill, lowest=fill,
            )

        # ── Mark to market ───────────────────────────────────────
        mark = capital
        if position is not None:
            unrealised = (
                (closes[i] - position.entry_price) * position.quantity
                if position.side == "LONG"
                else (position.entry_price - closes[i]) * position.quantity
            )
            mark = capital + unrealised

        peak = max(peak, mark)
        equity_curve.append({
            "time": times[i],
            "equity": round(mark, 2),
            "drawdown": round((peak - mark) / peak * 100, 3) if peak > 0 else 0.0,
        })

    # Close anything still open at the last price, so the result reflects a
    # complete book rather than hiding an open loser.
    if position is not None:
        last = closes[-1]
        gross = (
            (last - position.entry_price) * position.quantity
            if position.side == "LONG"
            else (position.entry_price - last) * position.quantity
        )
        costs = (position.entry_price + last) * position.quantity * cost_rate
        pnl = gross - costs
        capital += pnl
        trades.append(
            Trade(
                symbol=symbol, side=position.side,
                entry_time=times[position.entry_index], entry_price=position.entry_price,
                exit_time=times[-1], exit_price=last, quantity=position.quantity,
                pnl=pnl,
                pnl_percent=(pnl / (position.entry_price * position.quantity) * 100)
                if position.entry_price * position.quantity else 0.0,
                exit_reason="Closed at end of test", bars=position.bars,
            )
        )
        warnings.append("A position was still open at the end of the test and was closed at the last price.")

    return _summarise(
        trades, equity_curve, strategy, initial_capital, capital, df, warnings, cost_bps, slippage_bps
    )


def _summarise(
    trades: list[Trade],
    equity_curve: list[dict[str, Any]],
    strategy: dict[str, Any],
    initial_capital: float,
    final_capital: float,
    df: pd.DataFrame,
    warnings: list[str],
    cost_bps: float,
    slippage_bps: float,
) -> dict[str, Any]:
    if not trades:
        return _empty_result(strategy, initial_capital, warnings + ["No trades were generated."])

    pnls = np.array([t.pnl for t in trades], dtype=float)
    wins = pnls[pnls > 0]
    losses = pnls[pnls < 0]

    gross_profit = float(wins.sum()) if wins.size else 0.0
    gross_loss = float(abs(losses.sum())) if losses.size else 0.0

    win_rate = float(len(wins) / len(trades) * 100)
    profit_factor = float(gross_profit / gross_loss) if gross_loss > 0 else float("inf") if gross_profit > 0 else 0.0
    avg_win = float(wins.mean()) if wins.size else 0.0
    avg_loss = float(abs(losses.mean())) if losses.size else 0.0
    expectancy = float((win_rate / 100 * avg_win) - ((1 - win_rate / 100) * avg_loss))

    total_return = (final_capital / initial_capital - 1) * 100
    days = max((df.index[-1] - df.index[0]).days, 1)
    years = days / 365.25
    cagr = ((final_capital / initial_capital) ** (1 / years) - 1) * 100 if years > 0 and final_capital > 0 else 0.0

    equity = np.array([p["equity"] for p in equity_curve], dtype=float)
    drawdowns = np.array([p["drawdown"] for p in equity_curve], dtype=float)
    max_dd = float(drawdowns.max()) if drawdowns.size else 0.0

    # Longest stretch spent below a prior peak.
    dd_duration = 0
    current = 0
    for d in drawdowns:
        current = current + 1 if d > 0.5 else 0
        dd_duration = max(dd_duration, current)

    sharpe = sortino = 0.0
    if equity.size > 2:
        returns = np.diff(equity) / equity[:-1]
        returns = returns[np.isfinite(returns)]
        if returns.size > 1 and float(np.std(returns, ddof=1)) > 0:
            sharpe = float(np.mean(returns) / np.std(returns, ddof=1) * np.sqrt(252))
            downside = returns[returns < 0]
            if downside.size > 1 and float(np.std(downside, ddof=1)) > 0:
                sortino = float(np.mean(returns) / np.std(downside, ddof=1) * np.sqrt(252))

    # Monthly returns from the equity curve.
    monthly: list[dict[str, Any]] = []
    if equity_curve:
        eq = pd.Series(
            [p["equity"] for p in equity_curve],
            index=pd.to_datetime([p["time"] for p in equity_curve], unit="s", utc=True),
        )
        resampled = eq.resample("ME").last().dropna()
        prev = initial_capital
        for stamp, value in resampled.items():
            monthly.append({
                "month": stamp.strftime("%Y-%m"),
                "returnPercent": round((value / prev - 1) * 100, 2) if prev else 0.0,
            })
            prev = value

    # ── Honest caveats ───────────────────────────────────────────
    if len(trades) < 30:
        warnings.append(
            f"Only {len(trades)} trades. Below ~30 the win rate and profit factor are not "
            "statistically meaningful — this result could easily be luck."
        )
    if max_dd > 30:
        warnings.append(
            f"Maximum drawdown of {max_dd:.0f}% requires a {100 * (1 / (1 - max_dd / 100) - 1):.0f}% gain to recover. "
            "Few people keep trading a system through that."
        )
    if profit_factor == float("inf"):
        warnings.append("No losing trades in the sample, which almost always means the test window is too short.")
    warnings.append(
        f"Costs charged at {cost_bps:.0f} bps plus {slippage_bps:.0f} bps slippage per round trip. "
        "Real fills, partial executions and market impact are not modelled."
    )
    warnings.append(
        "Tested on the instrument's current history — survivorship and regime bias are not corrected for."
    )

    return {
        "strategyId": strategy.get("id", ""),
        "from": df.index[0].isoformat(),
        "to": df.index[-1].isoformat(),
        "initialCapital": round(initial_capital, 2),
        "finalCapital": round(final_capital, 2),
        "totalReturn": round(total_return, 2),
        "cagr": round(cagr, 2),
        "winRate": round(win_rate, 2),
        "profitFactor": round(profit_factor, 2) if np.isfinite(profit_factor) else 999.0,
        "sharpeRatio": round(sharpe, 2),
        "sortinoRatio": round(sortino, 2),
        "maxDrawdown": round(max_dd, 2),
        "maxDrawdownDuration": dd_duration,
        "totalTrades": len(trades),
        "winningTrades": int(len(wins)),
        "losingTrades": int(len(losses)),
        "averageWin": round(avg_win, 2),
        "averageLoss": round(avg_loss, 2),
        "expectancy": round(expectancy, 2),
        "largestWin": round(float(wins.max()), 2) if wins.size else 0.0,
        "largestLoss": round(float(losses.min()), 2) if losses.size else 0.0,
        "averageHoldingBars": round(float(np.mean([t.bars for t in trades])), 1),
        "equityCurve": equity_curve[:: max(1, len(equity_curve) // 400)],
        "trades": [t.to_dict() for t in trades],
        "monthlyReturns": monthly,
        "warnings": warnings,
    }


def _empty_result(strategy: dict[str, Any], capital: float, warnings: list[str]) -> dict[str, Any]:
    return {
        "strategyId": strategy.get("id", ""), "from": "", "to": "",
        "initialCapital": round(capital, 2), "finalCapital": round(capital, 2),
        "totalReturn": 0.0, "cagr": 0.0, "winRate": 0.0, "profitFactor": 0.0,
        "sharpeRatio": 0.0, "sortinoRatio": 0.0, "maxDrawdown": 0.0, "maxDrawdownDuration": 0,
        "totalTrades": 0, "winningTrades": 0, "losingTrades": 0,
        "averageWin": 0.0, "averageLoss": 0.0, "expectancy": 0.0,
        "largestWin": 0.0, "largestLoss": 0.0, "averageHoldingBars": 0.0,
        "equityCurve": [], "trades": [], "monthlyReturns": [], "warnings": warnings,
    }
