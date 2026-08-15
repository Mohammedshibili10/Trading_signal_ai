"""
Trade simulation.

Turns a recorded signal into a resolved trade by walking the bars that came
after it. Everything the simulator reads lives at ``bar_index + 1`` or later;
everything the signal knows was fixed at ``bar_index``. The two never touch,
which is the structural version of "no look-ahead" — it does not depend on
anyone remembering a shift.

Three rules, the same three ``engine/backtest.py`` states, applied to the signal
engine for the first time:

1. **The fill is never the signal bar's close.** The engine's published entry
   *is* that close, so filling there would be trading on a price that did not
   exist until the bar finished. The fill is the next bar's open at the
   earliest.
2. **Costs are charged on both legs**, from the engine's own cost model, so the
   zero-cost ablation compares against what the live system believes it pays.
3. **A bar containing both stop and target is adverse by default.** Bar data
   cannot say which came first. Assuming the good one is how a simulator
   manufactures an edge that does not survive contact with a tick feed, and
   §1.4 exists to measure how much of the result depends on that assumption.

The trade record carries excursions and the ambiguity flag whether or not any
diagnostic asks for them, because recomputing them later would mean re-walking
every bar a second time.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..engine import costs as engine_costs
from .config import DiagnosticsConfig, DEFAULT
from .replay import ReplaySignal

#: UTC hour boundaries for the session buckets the gate layer will use.
SESSION_BUCKETS: tuple[tuple[str, int, int], ...] = (
    ("asia", 0, 7),
    ("europe", 7, 13),
    ("us", 13, 21),
    ("late", 21, 24),
)


def session_bucket(epoch_seconds: int) -> str:
    """Which UTC session a timestamp falls in."""
    hour = (epoch_seconds // 3600) % 24
    for name, start, end in SESSION_BUCKETS:
        if start <= hour < end:
            return name
    return "late"


@dataclass
class SimulatedTrade:
    """One resolved trade. Every field is measured, none is assumed."""

    symbol: str
    asset_class: str
    timeframe: str
    direction: str
    session: str
    regime: str

    generated_at: int
    entry_time: int
    exit_time: int

    entry_price: float
    stop_price: float
    target_price: float
    exit_price: float

    #: Signed, net of costs, in R. The one number every downstream statistic is
    #: built from.
    realised_r: float
    #: The same trade before any cost was charged.
    gross_r: float
    #: Cost paid, expressed in R, so it is comparable across timeframes where
    #: the same basis points mean wildly different things.
    cost_r: float
    #: Percentage move from entry to exit, signed by direction, gross of costs.
    gross_pct: float
    net_pct: float
    #: Distance from entry to stop, as a percentage of entry. One R.
    risk_pct: float

    exit_reason: str
    bars_held: int
    #: The exit bar's range contained both the stop and the target.
    ambiguous_exit: bool

    #: Excursions from the entry price, in R, always non-negative.
    mae_r: float
    mfe_r: float

    confidence: float
    quoted_rr: float
    quoted_net_rr: float
    round_trip_bps: float

    @property
    def is_win(self) -> bool:
        return self.realised_r > 0

    @property
    def mfe_fraction_of_target(self) -> float:
        """How much of the way to the target the trade actually got."""
        distance = abs(self.target_price - self.entry_price) / self.entry_price * 100.0
        if distance <= 0 or self.risk_pct <= 0:
            return 0.0
        return (self.mfe_r * self.risk_pct) / distance

    @property
    def mae_fraction_of_stop(self) -> float:
        """How much of the way to the stop the trade went against itself."""
        return self.mae_r  # one R is the stop distance by construction


@dataclass
class SimulationResult:
    """A whole population of resolved trades, plus what could not be resolved."""

    trades: list[SimulatedTrade] = field(default_factory=list)
    never_filled: int = 0
    insufficient_forward_bars: int = 0
    #: Signals whose geometry was unusable — no target, zero risk distance.
    malformed: int = 0

    def __len__(self) -> int:
        return len(self.trades)


def _round_trip_bps(signal: ReplaySignal, config: DiagnosticsConfig) -> float:
    """
    What this trade pays, in basis points of notional, for the round trip.

    Reuses the engine's estimate rather than substituting a better one. §1.1
    asks whether the edge survives *the friction the system models*; answering
    it against a different cost model would measure a system nobody is running.
    """
    if not config.costs.enabled:
        return 0.0

    base = signal.round_trip_bps
    if base <= 0:
        base = engine_costs.round_trip_bps(
            signal.symbol, signal.asset_class, signal.timeframe
        )

    extra = config.costs.extra_slippage_bps_per_side * 2.0
    return (base + extra) * config.costs.scale


def _resolve_fill(
    signal: ReplaySignal, candles: list[dict[str, Any]], config: DiagnosticsConfig
) -> tuple[int, float] | None:
    """
    Which bar the position opened on, and at what price.

    Returns None when the entry was never reachable, which is a real outcome
    and not an error: a setup price walked away from is a setup that cost
    nothing.
    """
    execution = config.execution
    first = signal.bar_index + execution.entry_delay_bars
    if first >= len(candles):
        return None

    if execution.entry_type == "market_next_open":
        return first, float(candles[first]["open"])

    # limit_zone — price has to trade into the published band.
    low = signal.entry_low if signal.entry_low is not None else signal.entry
    high = signal.entry_high if signal.entry_high is not None else signal.entry
    if low is None or high is None:
        return None

    last = min(len(candles), first + execution.entry_valid_bars)
    for index in range(first, last):
        bar = candles[index]
        # Any overlap between the bar's range and the entry band is a fill. The
        # fill price is the band edge price would have had to cross, not the
        # midpoint, because a resting order fills at its own limit.
        if float(bar["low"]) <= high and float(bar["high"]) >= low:
            if index == first:
                open_price = float(bar["open"])
                if low <= open_price <= high:
                    return index, open_price
            return index, (high if signal.is_long else low)

    return None


def simulate_one(
    signal: ReplaySignal,
    candles: list[dict[str, Any]],
    config: DiagnosticsConfig = DEFAULT,
    *,
    direction_override: str | None = None,
) -> SimulatedTrade | None:
    """
    Resolve one signal against the bars that followed it.

    ``direction_override`` replaces the signal's direction while keeping its
    timing, sizing and geometry — the §1.3 random control, and nothing else,
    uses it. The stop and target are mirrored around the entry so the risk
    distance and reward distance are identical to the real trade's; only the
    side changes.
    """
    if signal.entry is None or signal.stop_loss is None or not signal.targets:
        return None

    execution = config.execution
    long = signal.is_long if direction_override is None else direction_override == "BUY"

    entry_reference = signal.entry
    risk_distance = abs(entry_reference - signal.stop_loss)
    if risk_distance <= 0 or entry_reference <= 0:
        return None

    target_index = min(execution.exit_target_index, len(signal.targets) - 1)
    raw_target = signal.targets[target_index].get("price")
    if raw_target is None:
        return None
    reward_distance = abs(float(raw_target) - entry_reference)
    if reward_distance <= 0:
        return None

    filled = _resolve_fill(signal, candles, config)
    if filled is None:
        return None
    fill_index, fill_price = filled
    if fill_price <= 0:
        return None

    # Geometry is rebuilt around the achieved fill rather than the quoted entry.
    # Quoting a stop against a price that was never traded is how a simulator
    # reports a 1R loss on a trade that actually lost 1.4R.
    direction = 1.0 if long else -1.0
    stop_price = fill_price - direction * risk_distance
    target_price = fill_price + direction * reward_distance
    risk_pct = risk_distance / fill_price * 100.0
    if risk_pct <= 0:
        return None

    exit_price: float | None = None
    exit_reason = ""
    exit_index = fill_index
    ambiguous = False
    mae = 0.0
    mfe = 0.0

    last_index = min(len(candles) - 1, fill_index + execution.max_holding_bars)

    for index in range(fill_index, last_index + 1):
        bar = candles[index]
        high = float(bar["high"])
        low = float(bar["low"])

        adverse = (fill_price - low) if long else (high - fill_price)
        favourable = (high - fill_price) if long else (fill_price - low)
        mae = max(mae, adverse)
        mfe = max(mfe, favourable)

        hit_stop = low <= stop_price if long else high >= stop_price
        hit_target = high >= target_price if long else low <= target_price

        if hit_stop and hit_target:
            ambiguous = True
            policy = execution.intrabar_policy
            if policy == "optimistic":
                exit_price, exit_reason = target_price, "target"
            elif policy == "midpoint":
                # Deterministic alternation rather than a coin flip, so the run
                # is reproducible and the split is exactly 50/50 by construction.
                if (index + signal.bar_index) % 2 == 0:
                    exit_price, exit_reason = target_price, "target"
                else:
                    exit_price, exit_reason = stop_price, "stop"
            else:
                exit_price, exit_reason = stop_price, "stop"
            exit_index = index
            break

        if hit_stop:
            exit_price, exit_reason, exit_index = stop_price, "stop", index
            break
        if hit_target:
            exit_price, exit_reason, exit_index = target_price, "target", index
            break

    if exit_price is None:
        exit_index = last_index
        exit_price = float(candles[exit_index]["close"])
        exit_reason = (
            "time_exit"
            if exit_index - fill_index >= execution.max_holding_bars
            else "series_end"
        )

    gross_pct = (exit_price - fill_price) / fill_price * 100.0 * direction
    bps = _round_trip_bps(signal, config)
    cost_pct = bps / 100.0
    net_pct = gross_pct - cost_pct

    return SimulatedTrade(
        symbol=signal.symbol,
        asset_class=signal.asset_class,
        timeframe=signal.timeframe,
        direction="BUY" if long else "SELL",
        session=session_bucket(signal.generated_at),
        regime=signal.regime,
        generated_at=signal.generated_at,
        entry_time=int(candles[fill_index]["time"]),
        exit_time=int(candles[exit_index]["time"]),
        entry_price=fill_price,
        stop_price=stop_price,
        target_price=target_price,
        exit_price=exit_price,
        realised_r=net_pct / risk_pct,
        gross_r=gross_pct / risk_pct,
        cost_r=cost_pct / risk_pct,
        gross_pct=gross_pct,
        net_pct=net_pct,
        risk_pct=risk_pct,
        exit_reason=exit_reason,
        bars_held=exit_index - fill_index,
        ambiguous_exit=ambiguous,
        mae_r=mae / risk_distance,
        mfe_r=mfe / risk_distance,
        confidence=signal.confidence,
        quoted_rr=signal.risk_reward,
        quoted_net_rr=signal.net_risk_reward,
        round_trip_bps=bps,
    )


def simulate_all(
    signals: list[ReplaySignal],
    candles_by_series: dict[str, list[dict[str, Any]]],
    config: DiagnosticsConfig = DEFAULT,
    *,
    directions: dict[int, str] | None = None,
) -> SimulationResult:
    """
    Resolve a whole population.

    ``directions`` maps a signal's position in the list to a replacement
    direction — the §1.3 control passes one, everything else passes None.
    """
    result = SimulationResult()

    for position, signal in enumerate(signals):
        candles = candles_by_series.get(f"{signal.symbol}:{signal.timeframe}")
        if candles is None:
            result.insufficient_forward_bars += 1
            continue
        if signal.entry is None or signal.stop_loss is None or not signal.targets:
            result.malformed += 1
            continue

        override = directions.get(position) if directions else None
        trade = simulate_one(signal, candles, config, direction_override=override)

        if trade is None:
            if signal.bar_index + config.execution.entry_delay_bars >= len(candles):
                result.insufficient_forward_bars += 1
            else:
                result.never_filled += 1
            continue

        result.trades.append(trade)

    return result
