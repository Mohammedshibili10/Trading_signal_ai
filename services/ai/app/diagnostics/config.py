"""
Diagnostics configuration.

Every number the diagnostics use lives here with a stated default and a reason.
None of them are tuning knobs for the strategy — they are measurement choices,
and a measurement choice that is buried in a function body cannot be argued
with. Where a value is genuinely unknown it is still a field here rather than a
literal at the call site.

The defaults are chosen to be *pessimistic* wherever the honest value is
unknown: adverse intrabar resolution, taker fees on both legs, slippage that
grows as the bar gets faster. A diagnostic that flatters the system is worse
than no diagnostic, because it costs the same to run and produces a decision in
the wrong direction.
"""

from __future__ import annotations

from dataclasses import dataclass, field


# ─────────────────────────────────────────────────────────────────
#  Execution model
# ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ExecutionConfig:
    """How a recorded signal becomes a filled, exited trade."""

    #: Bars between the signal bar and the fill. 1 is the only defensible
    #: default: the engine's own entry price is the *close* of a bar, which is
    #: not knowable until that bar has finished, so the earliest tradeable price
    #: is the next bar's open. 0 would be the look-ahead the §1.2 audit exists
    #: to detect, and is offered only so the lag test has something to compare
    #: against.
    entry_delay_bars: int = 1

    #: Extra bars of delay applied by the §1.2 lag test on top of the above.
    lag_test_extra_bars: int = 1

    #: Hard time-based exit. The signal schema has never carried one, so this is
    #: the diagnostic's assumption, not the engine's rule — stated here rather
    #: than hidden. 96 bars is four days of hourly bars, roughly the horizon a
    #: swing signal implies before its thesis is stale regardless of price.
    max_holding_bars: int = 96

    #: Which target closes the trade. The engine quotes reward:risk at the first
    #: target, so measuring against anything else would report a ratio nobody
    #: was shown.
    exit_target_index: int = 0

    #: How the entry is reached. ``market_next_open`` fills unconditionally at
    #: the open ``entry_delay_bars`` after the signal bar. ``limit_zone`` waits
    #: for price to trade inside the published entry zone and abandons the setup
    #: if it never does — closer to what the live tracker believes it is doing,
    #: and it produces the never-filled population the market variant cannot.
    entry_type: str = "market_next_open"

    #: Intrabar resolution when one bar's range contains both stop and target.
    #: "pessimistic" fills the stop, "optimistic" fills the target, "midpoint"
    #: splits them 50/50 by deterministic alternation. Only the pessimistic
    #: number is trustworthy; the others exist to size the ambiguity.
    intrabar_policy: str = "pessimistic"

    #: A signal whose entry never trades within this many bars is recorded as
    #: never filled rather than force-filled. Mirrors the live tracker's notion
    #: that an entry price price walked away from is not a trade.
    entry_valid_bars: int = 12


# ─────────────────────────────────────────────────────────────────
#  Cost model
# ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CostConfig:
    """
    Friction charged against a simulated trade.

    Deliberately reuses ``engine/costs.py`` rather than reimplementing it. The
    zero-cost ablation is only meaningful if the "with costs" arm charges what
    the live engine believes it charges — a diagnostic that invents its own
    better cost model would be measuring a system nobody is running.
    """

    #: Master switch. Only ``checks/ablation.py`` is permitted to set this
    #: False, and it says so in its own docstring.
    enabled: bool = True

    #: Multiplier on the engine's round-trip estimate. 1.0 uses the engine's
    #: number verbatim. Raised in sensitivity runs to ask "how wrong would the
    #: cost model have to be to change the verdict?".
    scale: float = 1.0

    #: Charged once per side on the *fill* price, on top of the round-trip
    #: figure, to represent the gap between the modelled fill and the achieved
    #: one. Zero by default because the engine's per-timeframe slippage table
    #: already carries this and double-charging would be its own distortion.
    extra_slippage_bps_per_side: float = 0.0


# ─────────────────────────────────────────────────────────────────
#  Replay
# ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ReplayConfig:
    """Which bars the live signal path is re-run on."""

    #: Bars of history required before the first replayed signal. The engine
    #: refuses below ``settings.min_bars`` (60) anyway; 120 additionally lets
    #: the 50-period averages and the swing detector warm up, so the first
    #: replayed bar is scored by the same machinery as the thousandth.
    warmup_bars: int = 120

    #: Replay every Nth bar. 1 is exhaustive. Raised only when a run would
    #: otherwise not finish; a stride above 1 thins the trade population and is
    #: reported in the output so the sample size is never silently reduced.
    stride: int = 1

    #: Bars that must remain after a signal for it to be simulated at all.
    #: Without this the tail of every series produces signals that can only
    #: resolve as time exits, which biases the outcome mix toward the flat
    #: middle of the distribution.
    min_forward_bars: int = 24

    #: Walk-forward calibration during replay. Off by default and this is a
    #: stated limitation, not an oversight: one calibrated analysis measured at
    #: 7.9 s against 0.14 s uncalibrated, a 56x cost, which turns a 25-minute
    #: replay into a 23-hour one. The live path caches calibration per closed
    #: bar for exactly this reason.
    with_calibration: bool = False

    #: Worker processes. 0 means "one per CPU, less two".
    workers: int = 0

    #: Cap on replayed bars per (symbol, timeframe). A guard against one deep
    #: series dominating the population.
    max_bars_per_series: int = 2000


# ─────────────────────────────────────────────────────────────────
#  Individual diagnostics
# ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RandomControlConfig:
    """§1.3 — the seeded coin-flip direction control."""

    #: Independent seeds. The spec asks for 30; the distribution of a statistic
    #: over 30 draws is enough to place the real system in it without implying
    #: more precision than 30 draws support.
    seeds: int = 30

    #: Trades per seed the spec asks for. The replay population is whatever the
    #: engine actually emits, so this is an *expectation to report against*, not
    #: a target to pad toward. A shortfall is stated in the output.
    target_trades_per_seed: int = 500

    #: Base seed. Fixed so a rerun reproduces the same distribution.
    base_seed: int = 20260815


@dataclass(frozen=True)
class ExcursionConfig:
    """§1.6 — maximum adverse and favourable excursion."""

    #: Fraction of the target distance a losing trade's favourable excursion
    #: must exceed before the target is judged too far.
    mfe_threshold_of_target: float = 0.5

    #: Fraction of the stop distance a winning trade's adverse excursion must
    #: exceed before the stop is judged too tight.
    mae_threshold_of_stop: float = 0.5

    #: Histogram resolution, in units of R.
    bucket_r: float = 0.25


@dataclass(frozen=True)
class ReconciliationConfig:
    """§1.5 — live versus replay feature-vector comparison."""

    #: Relative tolerance below which a field difference is not reported. Float
    #: arithmetic across a JSON round trip is not bit-identical and reporting
    #: that as drift would bury the real diffs.
    relative_tolerance: float = 1e-6

    #: Absolute floor for the same comparison, for fields that sit near zero.
    absolute_tolerance: float = 1e-9


# ─────────────────────────────────────────────────────────────────
#  Top level
# ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DiagnosticsConfig:
    """Everything the diagnostics run needs, in one object."""

    execution: ExecutionConfig = field(default_factory=ExecutionConfig)
    costs: CostConfig = field(default_factory=CostConfig)
    replay: ReplayConfig = field(default_factory=ReplayConfig)
    random_control: RandomControlConfig = field(default_factory=RandomControlConfig)
    excursion: ExcursionConfig = field(default_factory=ExcursionConfig)
    reconciliation: ReconciliationConfig = field(default_factory=ReconciliationConfig)

    #: Sample-size floor below which every derived statistic is reported with a
    #: warning attached. 200 is the platform's own published threshold.
    min_trades_for_confidence: int = 200

    def with_costs_disabled(self) -> "DiagnosticsConfig":
        """The zero-cost arm of §1.1. The only sanctioned use of this."""
        from dataclasses import replace

        return replace(self, costs=replace(self.costs, enabled=False))

    def with_extra_entry_delay(self, bars: int) -> "DiagnosticsConfig":
        """The lagged arm of §1.2."""
        from dataclasses import replace

        return replace(
            self,
            execution=replace(
                self.execution,
                entry_delay_bars=self.execution.entry_delay_bars + bars,
            ),
        )

    def with_intrabar_policy(self, policy: str) -> "DiagnosticsConfig":
        """The optimistic / pessimistic arms of §1.4."""
        from dataclasses import replace

        return replace(
            self, execution=replace(self.execution, intrabar_policy=policy)
        )


DEFAULT = DiagnosticsConfig()
