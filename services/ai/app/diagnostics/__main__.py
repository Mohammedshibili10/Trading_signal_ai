"""
Phase 1 diagnostics runner.

    python -m app.diagnostics --candles diagnostics_data/candles.csv \
        --out diagnostics_data/phase1

Reads a CSV export of the candle store, replays the live signal path across it,
resolves every signal into a trade, and writes the consolidated report plus its
JSON envelope.

Nothing here writes to the database, mutates engine state, or changes signal
generation. The one production change Phase 1 makes is additive logging on the
live path (``live_log.py``), which is off unless a destination is configured.
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from . import audit, metrics, report
from .checks import ablation, excursion, intrabar, lag, random_control, reconcile
from .config import (
    CostConfig,
    DiagnosticsConfig,
    ExecutionConfig,
    ReplayConfig,
)
from .loader import gap_profile, integrity_profile, integrity_summary, load_csv
from .replay import collect_signals, replay_all

log = logging.getLogger("diagnostics")


def _commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=Path(__file__).resolve().parents[4],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="app.diagnostics")
    parser.add_argument("--candles", required=True, help="CSV export of the candle store")
    parser.add_argument("--out", required=True, help="Output directory")
    parser.add_argument(
        "--timeframes",
        default="15m,1h,4h,1D",
        help="Comma-separated engine timeframes to replay",
    )
    parser.add_argument(
        "--asset-classes",
        default="",
        help="Comma-separated asset classes; empty means all",
    )
    parser.add_argument("--warmup", type=int, default=ReplayConfig.warmup_bars)
    parser.add_argument("--stride", type=int, default=ReplayConfig.stride)
    parser.add_argument("--workers", type=int, default=ReplayConfig.workers)
    parser.add_argument(
        "--max-holding-bars", type=int, default=ExecutionConfig.max_holding_bars
    )
    parser.add_argument(
        "--entry-type",
        default=ExecutionConfig.entry_type,
        choices=("market_next_open", "limit_zone"),
    )
    parser.add_argument("--cost-scale", type=float, default=CostConfig.scale)
    parser.add_argument("--seeds", type=int, default=30)
    parser.add_argument(
        "--live-log",
        default="",
        help="JSONL of live feature vectors, for §1.5",
    )
    parser.add_argument(
        "--now",
        type=int,
        default=int(time.time()),
        help="Reference instant for the future-dated bar check",
    )
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args(argv)


def _build_config(args: argparse.Namespace) -> DiagnosticsConfig:
    from dataclasses import replace

    base = DiagnosticsConfig()
    return replace(
        base,
        replay=replace(
            base.replay,
            warmup_bars=args.warmup,
            stride=args.stride,
            workers=args.workers,
        ),
        execution=replace(
            base.execution,
            max_holding_bars=args.max_holding_bars,
            entry_type=args.entry_type,
        ),
        costs=replace(base.costs, scale=args.cost_scale),
        random_control=replace(base.random_control, seeds=args.seeds),
    )


def _population_narrative(
    series_list, replays, signals, trades_resolved: int, load_report
) -> str:
    """Prose that puts the numbers in the reader's hands before the statistics."""
    wait_reasons: dict[str, int] = {}
    for replay in replays:
        for reason, count in replay.wait_reasons.items():
            wait_reasons[reason] = wait_reasons.get(reason, 0) + count

    total_waits = sum(wait_reasons.values())
    bars = sum(r.bars_scored for r in replays)
    top = sorted(wait_reasons.items(), key=lambda kv: -kv[1])[:6]

    lines = [
        f"The replay scored **{bars:,} bars** across {len(series_list)} series and "
        f"emitted **{len(signals)} tradeable signals** — a firing rate of "
        f"**{len(signals) / bars * 100:.2f}%** of scored bars. "
        f"{trades_resolved} of those resolved into simulated trades.",
        "",
        "The engine declined on the remaining "
        f"{total_waits:,} bars. Its own stated reasons, most frequent first:",
        "",
    ]
    for reason, count in top:
        share = count / total_waits * 100 if total_waits else 0
        lines.append(f"- `{reason}` — {count:,} ({share:.1f}%)")

    lines += [
        "",
        f"Candle store: {load_report.summary()}.",
    ]
    if load_report.rows_future_dated:
        lines += [
            "",
            f"**{load_report.rows_future_dated} bars carry timestamps in the future** "
            "and were excluded from the replay. A bar the store says has not happened "
            "yet cannot be a bar the engine was entitled to see. Examples:",
            "",
        ]
        lines += [f"- {example}" for example in load_report.future_dated_examples[:5]]

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s  %(message)s",
        datefmt="%H:%M:%S",
    )

    config = _build_config(args)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    timeframes = tuple(t.strip() for t in args.timeframes.split(",") if t.strip())
    asset_classes = tuple(
        a.strip().upper() for a in args.asset_classes.split(",") if a.strip()
    )

    log.info("loading %s", args.candles)
    series_list, load_report = load_csv(
        args.candles,
        now_epoch=args.now,
        timeframes=timeframes or None,
        asset_classes=asset_classes or None,
        # A series shorter than warm-up plus the forward window cannot produce a
        # single resolvable trade, so loading it only slows the run down.
        min_bars=config.replay.warmup_bars + config.replay.min_forward_bars + 2,
    )
    log.info("%s", load_report.summary())

    if not series_list:
        log.error("no series long enough to replay — nothing to do")
        return 2

    started = time.perf_counter()
    replays = replay_all(series_list, config, progress=not args.quiet)
    log.info("replay finished in %.1fs", time.perf_counter() - started)

    signals = collect_signals(replays)
    candles_by_series = {s.key: s.candles for s in series_list}

    log.info("%d tradeable signals — simulating", len(signals))

    ablation_result = ablation.run(signals, candles_by_series, config)
    lag_result = lag.run(signals, candles_by_series, config)
    control_result = random_control.run(signals, candles_by_series, config)
    intrabar_result = intrabar.run(signals, candles_by_series, config)
    reconcile_result = reconcile.run(
        series_list, config, live_log_path=args.live_log or None
    )

    from .simulate import simulate_all

    baseline = simulate_all(signals, candles_by_series, config)
    excursion_result = excursion.run(baseline.trades, config)
    audit_result = audit.run()

    breakdowns = {
        "session bucket": {
            k: v.to_dict()
            for k, v in metrics.breakdown(
                baseline.trades,
                lambda t: t.session,
                min_trades_for_confidence=config.min_trades_for_confidence,
            ).items()
        },
        "timeframe": {
            k: v.to_dict()
            for k, v in metrics.breakdown(
                baseline.trades,
                lambda t: t.timeframe,
                min_trades_for_confidence=config.min_trades_for_confidence,
            ).items()
        },
        "asset class": {
            k: v.to_dict()
            for k, v in metrics.breakdown(
                baseline.trades,
                lambda t: t.asset_class,
                min_trades_for_confidence=config.min_trades_for_confidence,
            ).items()
        },
        "volatility regime": {
            k: v.to_dict()
            for k, v in metrics.breakdown(
                baseline.trades,
                lambda t: t.regime,
                min_trades_for_confidence=config.min_trades_for_confidence,
            ).items()
        },
        "direction": {
            k: v.to_dict()
            for k, v in metrics.breakdown(
                baseline.trades,
                lambda t: t.direction,
                min_trades_for_confidence=config.min_trades_for_confidence,
            ).items()
        },
    }

    payload: dict[str, Any] = {
        "meta": {
            "generatedAt": report.now_iso(),
            "commit": _commit(),
            "seriesReplayed": len(series_list),
            "barsScored": sum(r.bars_scored for r in replays),
            "signalsEmitted": len(signals),
            "tradesResolved": len(baseline.trades),
            "minTradesForConfidence": config.min_trades_for_confidence,
            "replayErrors": sum(r.errors for r in replays),
            "calibrationEnabled": config.replay.with_calibration,
            "timeframes": list(timeframes),
            "populationNarrative": _population_narrative(
                series_list, replays, signals, len(baseline.trades), load_report
            ),
            "integrity": integrity_summary(series_list),
            "seriesDetail": [
                {
                    "series": s.key,
                    "assetClass": s.asset_class,
                    "bars": len(s),
                    "sources": sorted(s.sources),
                    "gaps": gap_profile(s),
                    "integrity": integrity_profile(s),
                }
                for s in series_list[:60]
            ],
        },
        "ablation": ablation_result,
        "lag": lag_result,
        "randomControl": control_result,
        "intrabar": intrabar_result,
        "reconcile": reconcile_result,
        "excursion": excursion_result,
        "audit": audit_result,
        "breakdowns": breakdowns,
    }

    (out_dir / "phase1.json").write_text(report.envelope(payload), encoding="utf-8")
    markdown = report.build(payload)
    (out_dir / "phase1.md").write_text(markdown, encoding="utf-8")

    trades_path = out_dir / "trades.jsonl"
    with trades_path.open("w", encoding="utf-8") as handle:
        for trade in baseline.trades:
            handle.write(json.dumps(trade.__dict__, default=str) + "\n")

    log.info("wrote %s", out_dir / "phase1.md")
    log.info("wrote %s", out_dir / "phase1.json")
    log.info("wrote %s (%d trades)", trades_path, len(baseline.trades))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
