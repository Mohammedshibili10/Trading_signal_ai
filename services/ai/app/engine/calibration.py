"""
Walk-forward calibration.

The part that makes the numbers honest. Without it, "72% confidence" is
decoration — a number produced by a formula nobody checked against reality.

The engine is re-run over the last N closed bars using **only** data available at
each bar, and each prediction is compared against what the next bar actually did.
Then a monotone correction is fitted so future probabilities are pulled toward
measured frequencies rather than left to drift.

Two properties are enforced by construction:

* **No look-ahead.** The scorer receives ``df.iloc[:i+1]`` and physically cannot
  see bar ``i+1``. This is why the resulting hit-rate means something.
* **The thing measured is the thing deployed.** Calibration re-runs the real
  scoring pipeline, not a cheaper approximation of it. A calibration that
  measures a different model is worse than none, because it looks rigorous.

Spec: docs/signal-methodology.md §6.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol

import numpy as np
import pandas as pd

from ..config import settings


class Scorer(Protocol):
    """Callable that scores a truncated series. Returns (prob_up, confidence)."""

    def __call__(self, df: pd.DataFrame) -> tuple[float, float] | None: ...


@dataclass
class Bucket:
    label: str
    predicted: float
    actual: float
    samples: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "predicted": round(self.predicted, 4),
            "actual": round(self.actual, 4),
            "samples": self.samples,
        }


@dataclass
class CalibrationReport:
    samples: int
    hit_rate: float
    high_confidence_hit_rate: float
    high_confidence_samples: int
    calibration_error: float
    brier_score: float
    buckets: list[Bucket]
    window: str
    #: Monotone correction points, (raw, corrected). Empty when uncorrected.
    correction: list[tuple[float, float]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "samples": self.samples,
            "hitRate": round(self.hit_rate, 4),
            "highConfidenceHitRate": round(self.high_confidence_hit_rate, 4),
            "highConfidenceSamples": self.high_confidence_samples,
            "calibrationError": round(self.calibration_error, 4),
            "brierScore": round(self.brier_score, 4),
            "buckets": [b.to_dict() for b in self.buckets],
            "window": self.window,
        }


class Calibrator:
    """
    Applies a fitted monotone correction to raw probabilities.

    Deliberately conservative: the correction is blended 60/40 with the raw
    probability rather than applied outright. A hard remap on a few hundred
    samples overfits to the recent regime, which trades one kind of wrongness
    for another.
    """

    def __init__(self, correction: list[tuple[float, float]] | None = None) -> None:
        self.correction = sorted(correction or [])

    def _map(self, p: float) -> float:
        if not self.correction:
            return p
        xs = [c[0] for c in self.correction]
        ys = [c[1] for c in self.correction]
        mapped = float(np.interp(p, xs, ys))
        return float(np.clip(0.6 * mapped + 0.4 * p, 0.02, 0.98))

    def apply(self, prob_up: float, prob_down: float, prob_flat: float) -> tuple[float, float, float]:
        """Correct the directional split, preserving the flat band."""
        directional = prob_up + prob_down
        if directional <= 0:
            return prob_up, prob_down, prob_flat

        share_up = prob_up / directional
        corrected_share = self._map(share_up)

        new_up = corrected_share * directional
        new_down = directional - new_up
        return float(new_up), float(new_down), float(prob_flat)


def _fit_correction(buckets: list[Bucket]) -> list[tuple[float, float]]:
    """
    Fit a monotone (isotonic-style) map from predicted → observed.

    Pool-adjacent-violators, weighted by sample count. Buckets with too few
    samples are dropped rather than allowed to swing the curve.
    """
    usable = [b for b in buckets if b.samples >= 12]
    if len(usable) < 3:
        return []

    xs = [b.predicted for b in usable]
    ys = [b.actual for b in usable]
    ws = [float(b.samples) for b in usable]

    # PAVA: merge adjacent blocks until the sequence is non-decreasing.
    blocks = [[y, w, y * w] for y, w in zip(ys, ws)]
    changed = True
    while changed:
        changed = False
        for i in range(len(blocks) - 1):
            if blocks[i][0] > blocks[i + 1][0]:
                w = blocks[i][1] + blocks[i + 1][1]
                s = blocks[i][2] + blocks[i + 1][2]
                merged = [s / w, w, s]
                blocks[i : i + 2] = [merged]
                changed = True
                break

    # Re-expand the merged blocks back onto the original x positions.
    fitted: list[float] = []
    bi = 0
    remaining = blocks[0][1] if blocks else 0.0
    for w in ws:
        if remaining <= 0 and bi + 1 < len(blocks):
            bi += 1
            remaining = blocks[bi][1]
        fitted.append(blocks[bi][0])
        remaining -= w

    # Anchor the ends so interpolation outside the observed range stays sane.
    points = [(0.0, 0.0)] + list(zip(xs, fitted)) + [(1.0, 1.0)]
    return [(float(x), float(np.clip(y, 0.0, 1.0))) for x, y in points]


def walk_forward(
    df: pd.DataFrame,
    scorer: Scorer,
    *,
    window: int | None = None,
    min_bars: int | None = None,
    flat_threshold: float = 0.0,
    max_context: int = 300,
    stride: int = 1,
) -> CalibrationReport | None:
    """
    Score the last ``window`` closed bars and grade each prediction.

    ``flat_threshold`` is the move size (as a fraction of price) below which the
    next bar counts as unchanged and the prediction is skipped — grading a
    directional call on a bar that moved 0.01% measures noise, not skill.

    ``max_context`` bounds how much history each scoring call receives. Passing
    the full growing prefix makes the pass quadratic — on 400 bars that was ~22
    seconds, most of it re-deriving swing structure from bars far too old to
    affect the answer. A bounded trailing window is still strictly causal and
    turns the pass linear. 300 bars comfortably covers the 200-period EMA
    warm-up, which is the longest lookback any factor uses.

    ``stride`` scores every Nth bar. Adjacent bars produce near-identical
    predictions, so a stride of 2 halves the cost for almost no loss of
    resolution on long series.

    Returns None when there isn't enough history to say anything, which the API
    surfaces as "not yet calibrated" rather than an unearned number.
    """
    window = window or settings.calibration_window
    min_bars = min_bars or settings.min_bars

    n = len(df)
    if n < min_bars + 30:
        return None

    start = max(min_bars, n - window)
    if n - start < 30:
        return None

    closes = df["close"].to_numpy(dtype=float)

    predictions: list[float] = []
    confidences: list[float] = []
    outcomes: list[int] = []

    for i in range(start, n - 1, max(1, stride)):
        # Bounded trailing context. Slicing from `i + 1 - max_context` rather
        # than 0 keeps this causal — the scorer still cannot see past bar i.
        lo = max(0, i + 1 - max_context)
        result = scorer(df.iloc[lo : i + 1])
        if result is None:
            continue
        prob_up, confidence = result

        move = (closes[i + 1] - closes[i]) / closes[i] if closes[i] else 0.0
        if abs(move) < flat_threshold:
            continue

        predictions.append(float(prob_up))
        confidences.append(float(confidence))
        outcomes.append(1 if move > 0 else 0)

    samples = len(predictions)
    if samples < 30:
        return None

    preds = np.array(predictions, dtype=float)
    confs = np.array(confidences, dtype=float)
    actual = np.array(outcomes, dtype=float)

    # Directional hit rate: did the side we leaned toward win?
    calls = preds != 0.5
    hit_rate = float(np.mean((preds[calls] > 0.5) == (actual[calls] > 0.5))) if calls.any() else 0.0

    hi = confs >= settings.high_confidence_threshold
    hi_samples = int(hi.sum())
    hi_hit = (
        float(np.mean((preds[hi] > 0.5) == (actual[hi] > 0.5))) if hi_samples >= 10 else 0.0
    )

    # Brier score — mean squared error of the probabilities. 0.25 is a coin flip.
    brier = float(np.mean((preds - actual) ** 2))

    # Reliability buckets.
    edges = [0.0, 0.35, 0.45, 0.5, 0.55, 0.65, 1.0]
    labels = ["<35%", "35–45%", "45–50%", "50–55%", "55–65%", ">65%"]
    buckets: list[Bucket] = []
    errors: list[tuple[float, float]] = []

    for lo, hi_edge, label in zip(edges, edges[1:], labels):
        mask = (preds >= lo) & (preds < hi_edge)
        count = int(mask.sum())
        if count == 0:
            continue
        predicted = float(preds[mask].mean())
        observed = float(actual[mask].mean())
        buckets.append(Bucket(label=label, predicted=predicted, actual=observed, samples=count))
        errors.append((abs(predicted - observed), float(count)))

    calibration_error = (
        float(sum(e * w for e, w in errors) / sum(w for _, w in errors)) if errors else 0.0
    )

    correction = _fit_correction(buckets) if samples >= settings.calibration_min_samples else []

    return CalibrationReport(
        samples=samples,
        hit_rate=hit_rate,
        high_confidence_hit_rate=hi_hit,
        high_confidence_samples=hi_samples,
        calibration_error=calibration_error,
        brier_score=brier,
        buckets=buckets,
        window=f"last {samples} scored bars",
        correction=correction,
    )


def build_calibrator(report: CalibrationReport | None) -> Calibrator | None:
    """A calibrator only when there's enough evidence to justify correcting."""
    if report is None or report.samples < settings.calibration_min_samples:
        return None
    if not report.correction:
        return None
    return Calibrator(report.correction)


def verdict(report: CalibrationReport | None) -> str:
    """One-line plain-language read, shown next to the confidence figure."""
    if report is None:
        return "Not yet calibrated on this instrument — treat the confidence as provisional."

    if report.samples < settings.calibration_min_samples:
        return (
            f"Only {report.samples} scored bars — too few to calibrate. "
            "Probabilities are uncorrected."
        )

    quality = (
        "well calibrated"
        if report.calibration_error < 0.06
        else "roughly calibrated"
        if report.calibration_error < 0.12
        else "poorly calibrated"
    )

    edge = report.hit_rate - 0.5
    edge_note = (
        f"a {edge * 100:+.1f}pt edge over a coin flip"
        if abs(edge) > 0.02
        else "no measurable edge over a coin flip"
    )

    return (
        f"Measured {report.hit_rate:.0%} hit-rate across {report.samples} bars "
        f"({edge_note}); Brier {report.brier_score:.3f}; {quality}."
    )
