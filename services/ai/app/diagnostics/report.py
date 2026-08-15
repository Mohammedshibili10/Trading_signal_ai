"""
Consolidated Phase 1 report.

One document covering diagnostics 1.1 through 1.6, written so it can be read
without the JSON beside it. The JSON is emitted alongside for anything that
wants to diff two runs.

The ordering is not the numeric one. Sample size comes first, because every
number after it is conditional on there being enough trades to mean anything,
and a report that buries "n = 40" under six sections of statistics is a report
that will be acted on incorrectly.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


def _pct(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def _r(value: float | None) -> str:
    return "—" if value is None else f"{value:+.4f}R"


def _table(rows: list[list[str]], headers: list[str]) -> str:
    out = ["| " + " | ".join(headers) + " |"]
    out.append("|" + "|".join(["---"] * len(headers)) + "|")
    for row in rows:
        out.append("| " + " | ".join(row) + " |")
    return "\n".join(out)


def _stats_row(label: str, stats: dict[str, Any]) -> list[str]:
    return [
        label,
        str(stats.get("trades", 0)),
        f"{stats.get('netR', 0):+.2f}",
        f"{stats.get('expectancyR', 0):+.4f}",
        f"{stats.get('profitFactor', 0):.3f}",
        f"{stats.get('hitRate', 0) * 100:.1f}%",
        f"{stats.get('tStat', 0):+.2f}",
    ]


_STATS_HEADERS = [
    "Arm", "Trades", "Net R", "Expectancy", "Profit factor", "Hit rate", "t",
]


def build(payload: dict[str, Any]) -> str:
    """Render the whole report as markdown."""
    meta = payload["meta"]
    ablation = payload["ablation"]
    lag = payload["lag"]
    control = payload["randomControl"]
    intrabar = payload["intrabar"]
    reconcile = payload["reconcile"]
    excursion = payload["excursion"]
    audit = payload["audit"]

    sections: list[str] = []

    # ── Header ───────────────────────────────────────────────────
    sections.append(
        f"""# Phase 1 — Diagnostic Report

Generated {meta['generatedAt']} · commit `{meta.get('commit', 'unknown')}`

Replay covered **{meta['seriesReplayed']} instrument-timeframe series**,
**{meta['barsScored']:,} scored bars**, producing **{meta['signalsEmitted']} signals**
and **{meta['tradesResolved']} resolved trades**.
"""
    )

    # ── Sample size, first ───────────────────────────────────────
    warning = (
        "> **The trade count is below the 200 the protocol requires for a "
        "statistically meaningful result.** Every figure below is reported "
        "because the protocol asks for it, and none of them should be treated as "
        "established. They are directional evidence about *mechanisms*, not "
        "measurements of *performance*.\n"
        if meta["tradesResolved"] < meta["minTradesForConfidence"]
        else "> Trade count clears the 200-trade floor.\n"
    )
    sections.append("## 0. Sample size and what it permits\n\n" + warning)
    sections.append(meta["populationNarrative"])

    integrity = meta.get("integrity")
    if integrity:
        contaminated = integrity["seriesContaminated"]
        block = [
            "\n### Candle store integrity\n",
            f"{integrity['seriesChecked']} series checked; "
            f"**{contaminated} unusable**. "
            f"{integrity['seriesWithSyntheticBars']} contain synthetic bars, "
            f"{integrity['seriesMixingRealAndSynthetic']} mix synthetic and real bars "
            f"in the same series, {integrity['seriesWithScaleBreaks']} contain a "
            f"bar-to-bar price ratio no instrument produces.\n",
        ]
        if integrity["worst"]:
            rows = [
                [
                    key,
                    ", ".join(value["sources"]),
                    str(value["scaleBreaks"]),
                    f"{value['largestScaleBreak']:.0f}x",
                ]
                for key, value in integrity["worst"].items()
            ]
            block.append(
                _table(rows, ["Series", "Sources", "Scale breaks", "Largest"])
            )
        sections.append("\n".join(block))

    # ── 1.1 ──────────────────────────────────────────────────────
    sections.append(
        f"""## 1.1 Zero-cost ablation

{_table([
    _stats_row("Zero cost", ablation["zeroCost"]),
    _stats_row("Full costs", ablation["withCosts"]),
], _STATS_HEADERS)}

Average round-trip cost: **{ablation['averageCostR']:.3f}R** per trade.
Cost drag as a share of gross result: **{ablation['costDragFractionOfGross'] * 100:.1f}%**.
Break-even hit rate at the reward:risk the engine quotes: **{_pct(ablation.get('breakEvenHitRateAtQuotedRR'))}**.

Signals that produced no trade: {ablation['unresolved']['neverFilled']} never filled,
{ablation['unresolved']['insufficientForwardBars']} had too little forward data,
{ablation['unresolved']['malformed']} had unusable geometry.

**Verdict — `{ablation['verdict']}`**

{ablation['interpretation']}
"""
    )

    # ── 1.2 ──────────────────────────────────────────────────────
    sections.append(
        f"""## 1.2 One-bar lag test

{_table([
    _stats_row("Baseline (next-open fill)", lag["baseline"]),
    _stats_row("Lagged (+1 bar)", lag["lagged"]),
], _STATS_HEADERS)}

Delta: net {lag['delta']['netR']:+.2f}R, expectancy {lag['delta']['expectancyR']:+.4f}R,
hit rate {lag['delta']['hitRate'] * 100:+.1f}pp.

**Verdict — {lag['verdict']}**

{lag['note']}
"""
    )

    # ── 1.2 audit ────────────────────────────────────────────────
    sections.append("### 1.2 Data-path audit — the five required answers\n")
    for finding in audit["questions"]:
        evidence = "\n".join(
            f"  - `{e['path']}:{e['line']}` — `{e['text']}`"
            for e in finding["evidence"][:3]
        )
        sections.append(
            f"""**{finding['question']}**

> **{finding['answer']}** · severity `{finding['severity']}`

{finding['detail']}

{evidence}
"""
        )

    sections.append(
        "### 1.2 Additional structural findings\n\n"
        "Found while answering the five. Kept separate so the numbered answers "
        "stay answers.\n"
    )
    for finding in audit["additionalFindings"]:
        evidence = "\n".join(
            f"  - `{e['path']}:{e['line']}` — `{e['text']}`"
            for e in finding["evidence"][:3]
        )
        sections.append(
            f"""**{finding['question']}**

> **{finding['answer']}** · severity `{finding['severity']}`

{finding['detail']}

{evidence}
"""
        )

    # ── 1.3 ──────────────────────────────────────────────────────
    distribution = control["randomDistribution"]["netR"]
    sections.append(
        f"""## 1.3 Random-direction control

{control['seeds']} seeds, {control['tradesPerSeed']} trades each
(protocol asks for {control['targetTradesPerSeed']};
shortfall {control['tradeCountShortfall']}).

Coin-flip net R distribution: min {distribution.get('min', 0):+.2f},
p05 {distribution.get('p05', 0):+.2f}, median {distribution.get('median', 0):+.2f},
p95 {distribution.get('p95', 0):+.2f}, max {distribution.get('max', 0):+.2f}
(mean {distribution.get('mean', 0):+.2f}, sd {distribution.get('stdev', 0):.2f}).

Real system net R: **{control['real']['netR']:+.2f}** →
**{control['realPercentileOfRandom']['netR']:.0f}th percentile** of the random distribution.
On expectancy: {control['realPercentileOfRandom']['expectancyR']:.0f}th percentile.

**Verdict — {control['verdict']}**
"""
    )

    # ── 1.4 ──────────────────────────────────────────────────────
    tf_rows = [
        [tf, str(v["trades"]), str(v["ambiguous"]), f"{v['rate'] * 100:.1f}%"]
        for tf, v in intrabar["ambiguityByTimeframe"].items()
    ]
    sections.append(
        f"""## 1.4 Intrabar path audit

**{intrabar['ambiguousTrades']} of {intrabar['closedTrades']} closed trades
({intrabar['ambiguityRate'] * 100:.1f}%)** exited on a bar whose range contained both
the stop and the target.

{_table(tf_rows, ["Timeframe", "Trades", "Ambiguous", "Rate"]) if tf_rows else "_No closed trades._"}

{_table([
    _stats_row("Pessimistic (stop first)", intrabar["pessimistic"]),
    _stats_row("Optimistic (target first)", intrabar["optimistic"]),
], _STATS_HEADERS)}

Policy spread: net {intrabar['policySpread']['netR']:+.2f}R,
expectancy {intrabar['policySpread']['expectancyR']:+.4f}R,
hit rate {intrabar['policySpread']['hitRate'] * 100:+.1f}pp.

**Verdict — {intrabar['verdict']}**

{intrabar['note']}
"""
    )

    # ── 1.5 ──────────────────────────────────────────────────────
    determinism = reconcile.get("determinism", {})
    sections.append(
        f"""## 1.5 Live vs backtest reconciliation

Mode: `{reconcile['mode']}` · live snapshots available: {reconcile['liveEntries']}

Determinism check: {'ran on ' + determinism.get('series', '—') if determinism.get('ran') else 'not run'} —
identical across two replays: **{determinism.get('identical', 'n/a')}**
({determinism.get('signalsCompared', 0)} signals over {determinism.get('barsScored', 0)} bars).

**Verdict — {reconcile['verdict']}**
"""
    )
    if reconcile.get("fieldsWithDiffs"):
        rows = [[k, str(v)] for k, v in reconcile["fieldsWithDiffs"].items()]
        sections.append(_table(rows, ["Field", "Snapshots differing"]) + "\n")

    # ── 1.6 ──────────────────────────────────────────────────────
    if excursion.get("trades"):
        summary = excursion["summary"]
        sweep_rows = [
            [f"{s['targetR']:.2f}R", f"{s['reachedPct']:.1f}%", str(s["trades"])]
            for s in excursion["targetSensitivity"]
        ]
        sections.append(
            f"""## 1.6 MAE / MFE distributions

{excursion['winners']} winners, {excursion['losers']} losers.

| Outcome | MAE median | MAE p90 | MFE median | MFE p90 |
|---|---|---|---|---|
| Winners | {summary['winners'].get('maeR', {}).get('median', 0):.2f}R | {summary['winners'].get('maeR', {}).get('p90', 0):.2f}R | {summary['winners'].get('mfeR', {}).get('median', 0):.2f}R | {summary['winners'].get('mfeR', {}).get('p90', 0):.2f}R |
| Losers | {summary['losers'].get('maeR', {}).get('median', 0):.2f}R | {summary['losers'].get('maeR', {}).get('p90', 0):.2f}R | {summary['losers'].get('mfeR', {}).get('median', 0):.2f}R | {summary['losers'].get('mfeR', {}).get('p90', 0):.2f}R |

**Losing trades whose MFE exceeded half the target distance: {excursion['losingTradesWithMfeOverHalfTargetPct']:.1f}%**
→ targets too far, if high.

**Winning trades whose MAE exceeded half the stop distance: {excursion['winningTradesWithMaeOverHalfStopPct']:.1f}%**
→ stops too tight, if high.

Reach rate by target distance — an upper bound on what pulling the target in could achieve,
since a bar cannot say whether the stop was touched first:

{_table(sweep_rows, ["Target", "Trades reaching", "Count"])}

**Verdict — {excursion['verdict']}**
"""
        )
    else:
        sections.append("## 1.6 MAE / MFE distributions\n\n_No trade population._\n")

    # ── Breakdowns ───────────────────────────────────────────────
    if payload.get("breakdowns"):
        sections.append("## Breakdowns\n")
        for name, buckets in payload["breakdowns"].items():
            rows = [_stats_row(key, stats) for key, stats in buckets.items()]
            sections.append(f"### By {name}\n\n{_table(rows, _STATS_HEADERS)}\n")

    return "\n".join(sections)


def envelope(payload: dict[str, Any]) -> str:
    """The machine-readable half, for diffing two runs."""
    return json.dumps(payload, indent=2, default=str)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
