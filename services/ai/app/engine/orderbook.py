"""
Order book analysis.

Every other "liquidity zone" in this engine is inferred — from equal highs, from
where price previously turned, from swing structure. Those are all estimates of
where orders *probably* sit. The book is where they actually sit, right now.

That difference matters most for the thing traders use liquidity zones for: a
swing high two weeks old may have had its stops taken already, while a fifty-BTC
wall two percent above price is a fact about the current market. Both are worth
knowing, and conflating them costs precision exactly when it is most needed.

Three reads:

**Imbalance** — resting size on each side, within a band around mid. Strongly
one-sided books precede moves toward the thin side, because that is where price
meets least resistance. This is not a prediction; it is a description of where
the friction is.

**Walls** — levels holding far more than the typical level. These act as
magnets and as barriers, and they are the honest version of a "liquidity zone".

**Spread and depth** — execution quality. A signal whose target is inside the
spread, or on a book too thin to fill the position, is not a tradeable signal
regardless of how good the chart looks.

A caveat worth stating: a book snapshot is a photograph of a thing that changes
by the millisecond, and resting orders can be pulled the instant price
approaches. Walls are read here as *evidence of intent*, never as a guarantee of
support.
"""

from __future__ import annotations

from typing import Any

import numpy as np

#: Band around mid within which liquidity is counted, as a share of price.
IMBALANCE_BAND = 0.005
#: A level holding this multiple of a typical level counts as a wall.
WALL_MULTIPLE = 4.0
#: How far from mid a level must sit to be a wall rather than the spread, in %.
MIN_WALL_DISTANCE = 0.05
#: Imbalance beyond this is one-sided enough to be worth acting on.
STRONG_IMBALANCE = 0.35


def analyse(book: dict[str, Any] | None, *, price: float | None = None) -> dict[str, Any]:
    """
    Read a depth snapshot.

    Returns `available: False` when no book was supplied — the case for every
    venue in this platform except Binance.
    """
    if not book or not book.get("bids") or not book.get("asks"):
        return {
            "available": False,
            "score": 0.0,
            "summary": (
                "No order book for this venue. Liquidity is inferred from price structure "
                "instead, which is an estimate rather than a measurement."
            ),
        }

    bids = [(float(b["price"]), float(b["quantity"])) for b in book["bids"] if float(b["quantity"]) > 0]
    asks = [(float(a["price"]), float(a["quantity"])) for a in book["asks"] if float(a["quantity"]) > 0]

    if not bids or not asks:
        return {"available": False, "score": 0.0, "summary": "Order book is empty on one side."}

    bids.sort(key=lambda level: -level[0])
    asks.sort(key=lambda level: level[0])

    best_bid, best_ask = bids[0][0], asks[0][0]
    mid = (best_bid + best_ask) / 2.0
    reference = price if price and price > 0 else mid

    spread = best_ask - best_bid
    spread_percent = (spread / mid * 100.0) if mid > 0 else 0.0

    # ── Imbalance within a tight band ────────────────────────────
    band = reference * IMBALANCE_BAND
    near_bids = [(p, q) for p, q in bids if p >= reference - band]
    near_asks = [(p, q) for p, q in asks if p <= reference + band]

    bid_size = sum(q for _, q in near_bids)
    ask_size = sum(q for _, q in near_asks)
    total = bid_size + ask_size
    imbalance = float((bid_size - ask_size) / total) if total > 0 else 0.0

    # ── Walls ────────────────────────────────────────────────────
    #
    # Two corrections over the obvious implementation, both learned from the
    # obvious implementation being wrong:
    #
    # 1. The top of book is excluded. The best bid and best ask are the spread,
    #    not resting liquidity ahead of price, and counting them made every
    #    snapshot report a "wall" at zero distance — which then flipped the
    #    directional score against the measured imbalance.
    #
    # 2. The threshold is a high percentile, not a multiple of the median. Most
    #    levels in a deep book hold dust, so the median is near zero and
    #    `median × 4` marks almost everything as a wall. Multiples of 700× in
    #    the output were the symptom.
    quantities = np.array([q for _, q in bids] + [q for _, q in asks], dtype=float)
    if quantities.size < 10:
        typical = float(quantities.mean()) if quantities.size else 0.0
    else:
        # The 75th percentile describes a normal *meaningful* level, ignoring
        # the long tail of dust below it.
        typical = float(np.percentile(quantities, 75))

    threshold = max(typical * WALL_MULTIPLE, float(np.percentile(quantities, 97)) if quantities.size >= 20 else 0.0)

    def walls(levels: list[tuple[float, float]], side: str) -> list[dict[str, Any]]:
        found = []
        for p, q in levels:
            distance = (p - reference) / reference * 100.0 if reference > 0 else 0.0
            # Skip the spread itself — a wall has to be somewhere price would
            # have to travel to reach.
            if abs(distance) < MIN_WALL_DISTANCE:
                continue
            if typical <= 0 or q < threshold:
                continue
            found.append({
                "side": side,
                "price": round(p, 8),
                "quantity": round(q, 6),
                "multiple": round(q / typical, 1),
                "distancePercent": round(distance, 3),
            })
        found.sort(key=lambda w: -w["quantity"])
        return found[:3]

    bid_walls = walls(bids, "BID")
    ask_walls = walls(asks, "ASK")

    # ── Depth, for execution sanity ──────────────────────────────
    def depth_within(levels: list[tuple[float, float]], percent: float) -> float:
        limit = reference * percent / 100.0
        return float(sum(q for p, q in levels if abs(p - reference) <= limit))

    depth_bid = depth_within(bids, 0.5)
    depth_ask = depth_within(asks, 0.5)

    # ── Score ────────────────────────────────────────────────────
    # Imbalance is the directional component. Walls are read as resistance in
    # the direction they sit, which is the opposite sign to the imbalance they
    # contribute to — a large ask wall is size willing to sell, not demand.
    score = float(np.clip(imbalance * 1.4, -1.0, 1.0))

    nearest_ask_wall = min(ask_walls, key=lambda w: abs(w["distancePercent"]), default=None)
    nearest_bid_wall = min(bid_walls, key=lambda w: abs(w["distancePercent"]), default=None)

    # A close wall dampens movement toward it. Applied as a nudge rather than a
    # floor: an earlier version clamped the score to ±0.15, which let a single
    # nearby level reverse the sign of a strongly measured imbalance. Size
    # sitting in the way is a reason to expect resistance, not a reason to
    # disbelieve what the rest of the book says.
    if nearest_ask_wall and abs(nearest_ask_wall["distancePercent"]) < 0.6:
        score -= 0.2
    if nearest_bid_wall and abs(nearest_bid_wall["distancePercent"]) < 0.6:
        score += 0.2
    score = float(np.clip(score, -1.0, 1.0))

    notes: list[str] = []
    notes.append(
        f"Book {abs(imbalance) * 100:.0f}% {'bid' if imbalance > 0 else 'ask'}-heavy "
        f"within {IMBALANCE_BAND * 100:.1f}% of mid"
    )
    notes.append(f"Spread {spread_percent:.3f}%")

    for wall in (bid_walls + ask_walls)[:3]:
        notes.append(
            f"{wall['side'].title()} wall of {wall['quantity']:.2f} at {wall['price']:.2f} "
            f"({wall['distancePercent']:+.2f}%, {wall['multiple']:.0f}× the typical level)"
        )

    if abs(imbalance) >= STRONG_IMBALANCE:
        notes.append(
            f"Strongly one-sided — least resistance is "
            f"{'upward' if imbalance > 0 else 'downward'} from here"
        )

    return {
        "available": True,
        "bestBid": round(best_bid, 8),
        "bestAsk": round(best_ask, 8),
        "mid": round(mid, 8),
        "spread": round(spread, 8),
        "spreadPercent": round(spread_percent, 4),
        "imbalance": round(imbalance, 4),
        "bidSize": round(bid_size, 6),
        "askSize": round(ask_size, 6),
        "depthBid": round(depth_bid, 6),
        "depthAsk": round(depth_ask, 6),
        "walls": bid_walls + ask_walls,
        "score": round(score, 4),
        "notes": notes,
        "summary": "; ".join(notes),
        "asOf": book.get("fetchedAt"),
    }


def liquidity_levels(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Walls as chart-drawable levels.

    Returned in the same shape the chart already uses for support and
    resistance, so book liquidity renders alongside structural levels rather
    than needing its own drawing path.
    """
    if not analysis.get("available"):
        return []

    return [
        {
            "price": wall["price"],
            "kind": "SUPPORT" if wall["side"] == "BID" else "RESISTANCE",
            # Strength scales with how far the level stands out, capped — a
            # hundred-times-median wall is not a hundred times more meaningful.
            "strength": float(min(95.0, 45.0 + wall["multiple"] * 5.0)),
            "label": f"Book {wall['side'].lower()} wall ({wall['multiple']:.0f}×)",
            "touches": 0,
            "distancePercent": wall["distancePercent"],
        }
        for wall in analysis.get("walls", [])
    ]
