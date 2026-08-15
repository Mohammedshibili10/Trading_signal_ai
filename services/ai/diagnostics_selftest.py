"""
Diagnostics self-test — the CI half of §1.5.

Runs on every push. Dependency-light in the same style as ``selftest.py`` (no
pytest) so it works anywhere Python and numpy exist:

    python diagnostics_selftest.py

Three things are asserted, in increasing order of what they buy:

1. **The replay harness is deterministic.** Two replays of the same bars must
   produce byte-identical feature snapshots. If this fails, every reconciliation
   result is noise and the rest of the file is meaningless.
2. **The replay cannot see the future.** A signal generated at bar *i* must be
   unchanged when the bars after *i* are altered beyond recognition. This is the
   look-ahead check that does not depend on anyone remembering to shift a
   series — it mutates the future and asserts the past did not move.
3. **Live and replay snapshots reconcile.** When a live log is present
   (``DIAGNOSTICS_SIGNAL_LOG``), the recorded snapshots are replayed and diffed
   field by field. Any nonzero diff fails the build. With no log present the
   check reports as skipped rather than passing, because a check that passes
   when it did not run is worse than one that fails.

This is the test that catches data drift before it costs money. A provider
changing a field, a timezone moving by an hour, a feed starting to include the
forming bar — all of them move live numbers while leaving every test that does
not compare the two paths green.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

from app.diagnostics.checks.reconcile import compare_vectors, load_live_log
from app.diagnostics.config import DiagnosticsConfig
from app.diagnostics.loader import Series
from app.diagnostics.replay import replay_series

PASS, FAIL, SKIP = "  PASS", "  FAIL", "  SKIP"
failures: list[str] = []
skipped: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"{PASS}  {label}")
    else:
        print(f"{FAIL}  {label}{' — ' + detail if detail else ''}")
        failures.append(label)


def skip(label: str, why: str) -> None:
    print(f"{SKIP}  {label} — {why}")
    skipped.append(label)


def make_series(n: int = 220, seed: int = 11) -> Series:
    """A walk with enough structure for the engine to have opinions about it."""
    rng = np.random.default_rng(seed)
    price = 100.0
    volatility = 0.012
    start = int(time.time()) - n * 3600
    candles = []
    for i in range(n):
        volatility = float(np.clip(volatility * 0.94 + abs(rng.normal(0, 0.004)) * 0.06, 0.004, 0.05))
        step = rng.normal(0.0004, volatility)
        open_price = price
        price = max(0.01, price * (1.0 + step))
        high = max(open_price, price) * (1.0 + abs(rng.normal(0, volatility * 0.4)))
        low = min(open_price, price) * (1.0 - abs(rng.normal(0, volatility * 0.4)))
        candles.append(
            {
                "time": start + i * 3600,
                "open": open_price,
                "high": high,
                "low": low,
                "close": price,
                "volume": float(rng.integers(800, 4000)),
            }
        )
    return Series(symbol="TEST", asset_class="CRYPTO", timeframe="1h", candles=candles)


#: The scored window is bars [warmup_bars, len − min_forward_bars). Both ends
#: are pinned rather than left to the defaults, because the look-ahead check
#: below mutates every bar past the window and needs to know exactly where the
#: window stops.
WARMUP = 150
FORWARD = 50

CONFIG = replace(
    DiagnosticsConfig(),
    replay=replace(
        DiagnosticsConfig().replay,
        warmup_bars=WARMUP,
        stride=1,
        min_forward_bars=FORWARD,
        max_bars_per_series=500,
        workers=1,
    ),
)


print("\nDiagnostics self-test\n")

# ── 1. Determinism ───────────────────────────────────────────────
series = make_series()
first = replay_series(series, CONFIG)
second = replay_series(series, CONFIG)

check("replay scores bars at all", first.bars_scored > 0, f"{first.bars_scored} bars")
check(
    "replay is deterministic across runs",
    json.dumps([s.feature_vector for s in first.signals], sort_keys=True, default=str)
    == json.dumps([s.feature_vector for s in second.signals], sort_keys=True, default=str),
    "two replays of identical input produced different snapshots",
)
check(
    "replay raised no engine errors",
    first.errors == 0,
    "; ".join(first.error_examples),
)

# ── 2. The future cannot reach the past ──────────────────────────
#
# Replace every bar after the scored window with an extreme move. A signal that
# was generated before those bars existed must be bit-identical. Anything that
# moves is reading forward.
mutated = Series(
    symbol=series.symbol,
    asset_class=series.asset_class,
    timeframe=series.timeframe,
    candles=[dict(c) for c in series.candles],
)
cut = len(series.candles) - FORWARD
for bar in mutated.candles[cut:]:
    bar["open"] *= 4.0
    bar["high"] *= 4.4
    bar["low"] *= 3.6
    bar["close"] *= 4.0
    bar["volume"] *= 20.0

mutated_replay = replay_series(mutated, CONFIG)

baseline_vectors = {s.generated_at: s.feature_vector for s in first.signals}
mutated_vectors = {s.generated_at: s.feature_vector for s in mutated_replay.signals}
shared = sorted(set(baseline_vectors) & set(mutated_vectors))

drifted = [
    stamp
    for stamp in shared
    if compare_vectors(baseline_vectors[stamp], mutated_vectors[stamp], CONFIG)
]

check(
    "quadrupling every future bar leaves past signals unchanged",
    not drifted,
    f"{len(drifted)} of {len(shared)} signals moved — the engine is reading forward",
)
check(
    "the same bars still produce the same signal set",
    set(baseline_vectors) == set(mutated_vectors),
    f"baseline {len(baseline_vectors)} vs mutated {len(mutated_vectors)} signals",
)

# ── 3. Live reconciliation ───────────────────────────────────────
live_path = os.environ.get("DIAGNOSTICS_SIGNAL_LOG", "").strip()
candles_path = os.environ.get("DIAGNOSTICS_CANDLES", "").strip()

if not live_path or not Path(live_path).exists():
    skip(
        "live snapshots reconcile against replay",
        "no DIAGNOSTICS_SIGNAL_LOG present — run the scanner with logging enabled",
    )
elif not candles_path or not Path(candles_path).exists():
    skip(
        "live snapshots reconcile against replay",
        "no DIAGNOSTICS_CANDLES export present to replay against",
    )
else:
    from app.diagnostics.checks import reconcile as reconcile_check
    from app.diagnostics.loader import load_csv

    series_list, _ = load_csv(candles_path, now_epoch=int(time.time()))
    result = reconcile_check.run(series_list, CONFIG, live_log_path=live_path)
    entries = load_live_log(live_path)

    check(
        "live log contains snapshots to compare",
        len(entries) > 0,
        f"{len(entries)} entries",
    )
    check(
        "every live snapshot matched a stored bar",
        result.get("unmatched", 0) == 0,
        f"{result.get('unmatched', 0)} unmatched of {len(entries)}",
    )
    check(
        "live and replay snapshots agree field for field",
        not result.get("fieldsWithDiffs"),
        json.dumps(result.get("fieldsWithDiffs", {}))[:300],
    )

print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for item in failures:
        print(f"  · {item}")
    sys.exit(1)

if skipped:
    print(f"{len(skipped)} check(s) skipped (not a failure, but not coverage either):")
    for item in skipped:
        print(f"  · {item}")

print("All checks passed.")
sys.exit(0)
