"""
Live feature-vector logging.

§1.5 needs the live path to record, at every signal, the complete input snapshot
it decided from. Without that record there is nothing to reconcile a replay
against, and live/backtest divergence stays invisible until it shows up as
money.

Deliberately additive. This module observes; it does not participate. It is
called after the signal has been built, it can raise nothing that reaches the
caller, and if the destination is unwritable it silently stops trying. A
diagnostic that can fail a request is a diagnostic that gets switched off.

The format is JSON Lines — one self-contained object per signal, appended. Not a
database table: this has to survive the service being killed mid-write, has to
be readable by a tool that has no database driver, and has to be trivially
shippable off the box. A torn final line costs one record and the reader skips
it.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: Off unless a destination is configured. The scanner runs every five minutes
#: across a rotating universe, so this is not free, and turning it on should be
#: a decision rather than a default.
_ENV_PATH = "DIAGNOSTICS_SIGNAL_LOG"
_ENV_ENABLED = "DIAGNOSTICS_SIGNAL_LOG_ENABLED"

#: Stop writing after this many consecutive failures. One unwritable path
#: should not produce one log line per signal for the life of the process.
_MAX_FAILURES = 5

_lock = threading.Lock()
_failures = 0
_disabled = False


def _destination() -> Path | None:
    if os.environ.get(_ENV_ENABLED, "").strip().lower() in ("0", "false", "no"):
        return None
    raw = os.environ.get(_ENV_PATH, "").strip()
    if not raw:
        return None
    return Path(raw)


def enabled() -> bool:
    return not _disabled and _destination() is not None


def emit(
    analysis: dict[str, Any],
    *,
    symbol: str,
    timeframe: str,
    asset_class: str,
    signal_id: str | None = None,
) -> None:
    """
    Append one snapshot.

    ``analysis`` is the full ``pipeline.analyse`` result. The snapshot is built
    by the same function the replay harness uses, which is the point: two
    snapshots taken by different code paths would reconcile against each other's
    bugs rather than against the data.
    """
    global _failures, _disabled

    if _disabled:
        return
    destination = _destination()
    if destination is None:
        return

    try:
        from .replay import _feature_vector

        signal = analysis.get("signal") or {}
        record = {
            "loggedAt": datetime.now(timezone.utc).isoformat(),
            "signalId": signal_id,
            "symbol": symbol,
            "timeframe": timeframe,
            "assetClass": asset_class,
            # The close timestamp of the last bar the engine saw. This is the
            # join key for reconciliation, and the only honest answer to "when
            # did this information exist".
            "generatedAt": _as_of_epoch(analysis.get("asOf")),
            "asOf": analysis.get("asOf"),
            "action": signal.get("action"),
            "featureVector": _feature_vector(analysis),
        }

        line = json.dumps(record, default=str, separators=(",", ":"))

        with _lock:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
            _failures = 0

    except Exception as error:  # noqa: BLE001 — never let logging break a request
        with _lock:
            _failures += 1
            if _failures >= _MAX_FAILURES:
                _disabled = True
                log.warning(
                    "signal snapshot logging disabled after %d failures: %s",
                    _failures,
                    error,
                )


def _as_of_epoch(as_of: Any) -> int | None:
    """The engine reports `asOf` as an ISO string; reconciliation needs epoch."""
    if not as_of:
        return None
    try:
        return int(datetime.fromisoformat(str(as_of)).timestamp())
    except (TypeError, ValueError):
        return None
