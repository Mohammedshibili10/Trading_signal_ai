"""
Volume profile — volume per *price* rather than volume per *time*.

docs/trading-curriculum.md §3.3. A normal volume bar answers "how much traded
during this hour". A profile answers "how much has ever traded at this price",
which is the question that identifies where the market agreed value was and
where it refused to linger.

Four objects come out of it, and each has a distinct trading meaning:

* **POC** (point of control) — the single price with the most traded volume.
  The market's "fairest" price and a demonstrable magnet: price returning to it
  tends to slow there.
* **Value Area** — the band containing 70% of the volume, grown outward from
  the POC. §3.3: "inside it expect rotation/chop; outside it expect either quick
  rejection back in or trend initiation." This is a regime statement about
  *location*, and it is the piece the engine had no way to express.
* **HVN** (high-volume node) — a local peak in the histogram. Price has been
  accepted here before, so it acts as support/resistance. §1.5 lists HVNs as one
  of the four origins a support/resistance zone should be generated from, which
  is how they are used here.
* **LVN** (low-volume node) — a local trough. Price crossed this area fast and
  refused to trade in it. §7.2: LVNs "make excellent stop placement anchors
  because acceptance inside an LVN is abnormal" — a stop beyond an LVN is a stop
  that only fills if something genuinely changed, rather than one taken out by
  ordinary rotation.

**Why this is approximate, stated up front.** A true profile is built from
tick or footprint data — every trade at every price. This engine receives OHLCV
bars, so each bar's volume is spread across its own high-low range. That is the
standard reconstruction and it is good enough for locating nodes, but it cannot
see *where inside the bar* the volume actually printed. Treated accordingly: the
objects are reported as zones with a width, never as exact prices.

Volume is required and is not faked when absent. Spot forex has no true volume
(§3.3), so the profile is reported unavailable rather than computed from zeros —
the same rule `factors.py` already applies to the VOLUME group.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

#: Price buckets the range is divided into.
#:
#: Enough resolution to separate adjacent nodes without turning every bar into
#: its own peak. At 60, a typical daily range resolves to roughly a tenth of an
#: ATR per bucket.
DEFAULT_BINS = 60

#: Share of total volume defining the value area. 70% is the convention from
#: Market Profile (one standard deviation of a normal distribution) and is what
#: every desk means by the term.
VALUE_AREA_SHARE = 0.70

#: A bucket must hold at least this multiple of the mean bucket volume to be a
#: high-volume node, and at most this fraction to be a low-volume node.
HVN_THRESHOLD = 1.35
LVN_THRESHOLD = 0.45


def available(df: pd.DataFrame) -> bool:
    """Is there real volume to profile?"""
    if "volume" not in df or len(df) < 20:
        return False
    volumes = pd.to_numeric(df["volume"], errors="coerce").fillna(0.0).to_numpy(dtype=float)
    # Spot forex reports zeros; a series that is entirely zero or constant
    # carries no information about where trade concentrated.
    return bool(volumes.sum() > 0 and np.count_nonzero(volumes) >= len(volumes) * 0.5)


def _histogram(df: pd.DataFrame, bins: int) -> tuple[np.ndarray, np.ndarray]:
    """
    Spread each bar's volume evenly across the buckets its range covers.

    The even spread is the approximation named in the module docstring. The
    alternative — assigning a bar's whole volume to its close — concentrates
    everything on a handful of prices and invents nodes that are artefacts of
    where bars happened to close.
    """
    highs = pd.to_numeric(df["high"], errors="coerce").to_numpy(dtype=float)
    lows = pd.to_numeric(df["low"], errors="coerce").to_numpy(dtype=float)
    volumes = pd.to_numeric(df["volume"], errors="coerce").fillna(0.0).to_numpy(dtype=float)

    low = float(np.nanmin(lows))
    high = float(np.nanmax(highs))
    if not np.isfinite(low) or not np.isfinite(high) or high <= low:
        return np.array([]), np.array([])

    edges = np.linspace(low, high, bins + 1)
    centres = (edges[:-1] + edges[1:]) / 2.0
    profile = np.zeros(bins, dtype=float)

    width = (high - low) / bins

    for bar_low, bar_high, volume in zip(lows, highs, volumes):
        if not np.isfinite(bar_low) or not np.isfinite(bar_high) or volume <= 0:
            continue
        start = int(np.clip((bar_low - low) / width, 0, bins - 1))
        end = int(np.clip((bar_high - low) / width, 0, bins - 1))
        span = end - start + 1
        profile[start : end + 1] += volume / span

    return centres, profile


def _value_area(profile: np.ndarray, poc_index: int) -> tuple[int, int]:
    """
    Grow outward from the POC until 70% of volume is enclosed.

    Expands toward whichever neighbouring bucket holds more volume, which is the
    standard construction — it follows the shape of the distribution rather than
    growing symmetrically through a thin side.
    """
    total = float(profile.sum())
    if total <= 0:
        return poc_index, poc_index

    target = total * VALUE_AREA_SHARE
    low_index = high_index = poc_index
    enclosed = float(profile[poc_index])

    while enclosed < target and (low_index > 0 or high_index < len(profile) - 1):
        below = profile[low_index - 1] if low_index > 0 else -1.0
        above = profile[high_index + 1] if high_index < len(profile) - 1 else -1.0

        if above >= below:
            high_index += 1
            enclosed += float(profile[high_index])
        else:
            low_index -= 1
            enclosed += float(profile[low_index])

    return low_index, high_index


def _nodes(centres: np.ndarray, profile: np.ndarray, price: float, atr_value: float) -> dict:
    """Local peaks (HVN) and troughs (LVN), as zones rather than prices."""
    mean = float(profile.mean()) if profile.size else 0.0
    if mean <= 0:
        return {"hvn": [], "lvn": []}

    width = float(centres[1] - centres[0]) if centres.size > 1 else 0.0
    hvn: list[dict[str, Any]] = []
    lvn: list[dict[str, Any]] = []

    for index in range(1, len(profile) - 1):
        value = profile[index]
        ratio = value / mean

        # A node is a local extreme, not merely a bucket above average — the
        # latter labels half the value area an HVN.
        peak = value >= profile[index - 1] and value >= profile[index + 1]
        trough = value <= profile[index - 1] and value <= profile[index + 1]

        entry = {
            "price": round(float(centres[index]), 6),
            "low": round(float(centres[index] - width / 2), 6),
            "high": round(float(centres[index] + width / 2), 6),
            "volumeRatio": round(ratio, 2),
            "distancePercent": round((float(centres[index]) - price) / price * 100.0, 2)
            if price > 0
            else 0.0,
            "distanceAtr": round(abs(float(centres[index]) - price) / atr_value, 2)
            if atr_value > 0
            else None,
        }

        if peak and ratio >= HVN_THRESHOLD:
            hvn.append(entry)
        elif trough and ratio <= LVN_THRESHOLD:
            lvn.append(entry)

    # Nearest first — a node 30% away is true and useless.
    hvn.sort(key=lambda n: abs(n["distancePercent"]))
    lvn.sort(key=lambda n: abs(n["distancePercent"]))
    return {"hvn": hvn[:5], "lvn": lvn[:5]}


def analyse(
    df: pd.DataFrame,
    *,
    atr_value: float = 0.0,
    bins: int = DEFAULT_BINS,
) -> dict[str, Any]:
    """
    Full profile: POC, value area, nodes, and where price sits relative to them.

    The `location` field is the part the rest of the engine consumes. §3.3:
    inside the value area, expect rotation — which is an argument against
    breakout playbooks and for fading the edges; outside it, expect either quick
    rejection back in or trend initiation, which is the opposite prescription.
    """
    if not available(df):
        return {
            "available": False,
            "reason": (
                "No usable volume series. Spot forex reports no true volume, so a "
                "profile would be built from zeros and read as fact."
            ),
        }

    centres, profile = _histogram(df, bins)
    if centres.size == 0 or profile.sum() <= 0:
        return {"available": False, "reason": "Price range too narrow to profile."}

    price = float(pd.to_numeric(df["close"], errors="coerce").iloc[-1])

    poc_index = int(np.argmax(profile))
    poc = float(centres[poc_index])

    low_index, high_index = _value_area(profile, poc_index)
    val = float(centres[low_index])
    vah = float(centres[high_index])

    inside = val <= price <= vah
    if inside:
        location = "INSIDE_VALUE"
        note = (
            f"Price is inside the value area ({val:.6g}–{vah:.6g}), where most trade has "
            "occurred. Rotation is the base case here, not trend — breakout setups are "
            "poorly located in the middle of accepted value."
        )
    elif price > vah:
        location = "ABOVE_VALUE"
        note = (
            f"Price is above the value area high ({vah:.6g}). Either this is trend "
            "initiation and value migrates up behind it, or it is a rejection that "
            "returns inside — acceptance over the next few bars decides which."
        )
    else:
        location = "BELOW_VALUE"
        note = (
            f"Price is below the value area low ({val:.6g}). Either trend initiation "
            "downward, or a rejection that snaps back into value."
        )

    nodes = _nodes(centres, profile, price, atr_value)

    return {
        "available": True,
        "poc": round(poc, 6),
        "pocDistancePercent": round((poc - price) / price * 100.0, 2) if price > 0 else 0.0,
        "valueAreaLow": round(val, 6),
        "valueAreaHigh": round(vah, 6),
        "valueAreaSharePercent": round(VALUE_AREA_SHARE * 100, 0),
        "location": location,
        "insideValue": inside,
        "hvn": nodes["hvn"],
        "lvn": nodes["lvn"],
        "bars": int(len(df)),
        "note": note,
        "summary": (
            f"POC {poc:.6g}, value {val:.6g}–{vah:.6g} over {len(df)} bars. "
            + note
        ),
    }


def stop_anchor(
    profile: dict[str, Any] | None,
    *,
    entry: float,
    stop_loss: float,
    long: bool,
    atr_value: float,
) -> dict[str, Any] | None:
    """
    A low-volume node near the proposed stop, to anchor it against.

    §7.2: acceptance inside an LVN is abnormal, so a stop placed past one is
    taken out only by a move that actually traded through an area the market has
    been refusing to trade in. Advisory — reported alongside the structural stop,
    never used to replace it, because a profile reconstructed from bars is an
    approximation and the stop is the one number that must not rest on one.

    Measured against the **stop**, not the entry. An earlier version searched a
    fixed 0.5–3.5 ATR band around the entry, which asks the wrong question: this
    engine's stop is the wider of a structural and a 1.8-ATR candidate and is
    routinely 4–5 ATR out, so an entry-relative band excluded exactly the nodes
    sitting where the stop actually is. Measured on BNB 1h: the structural stop
    landed at 580.64 with a low-volume node at 580.33 — a near-perfect anchor
    that the entry-relative band rejected for being 4.76 ATR from entry.

    The window is one ATR either side of the stop, so acting on it is a small
    adjustment rather than a different trade.
    """
    if not profile or not profile.get("available") or atr_value <= 0:
        return None
    if abs(entry - stop_loss) <= 0:
        return None

    candidates = [
        node
        for node in profile.get("lvn", [])
        # Below entry for a long, above for a short — the side the stop sits on.
        if (node["price"] < entry) == long
        # Within reach of where the stop already is.
        and abs(node["price"] - stop_loss) <= atr_value
    ]
    if not candidates:
        return None

    nearest = min(candidates, key=lambda node: abs(node["price"] - stop_loss))
    pad = 0.15 * atr_value
    anchored = nearest["price"] - pad if long else nearest["price"] + pad

    return {
        "price": round(anchored, 6),
        "lvn": nearest["price"],
        # Whether taking the anchor would widen the stop (safer, costs size) or
        # tighten it (cheaper, risks the noise the node is meant to sit outside).
        "widensStop": bool((anchored < stop_loss) if long else (anchored > stop_loss)),
        "shiftAtr": round(abs(anchored - stop_loss) / atr_value, 2),
        "note": (
            f"A low-volume node sits at {nearest['price']:.6g}, "
            f"{abs(nearest['price'] - stop_loss) / atr_value:.2f} ATR from the proposed stop. "
            "Price has historically crossed this area rather than trading in it, so a stop "
            "beyond it is reached only by a genuine move rather than by ordinary rotation."
        ),
    }
