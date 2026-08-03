"""
Transaction costs, charged against every signal before it is published.

Curriculum §10.3 puts cost modelling first in the order of leverage, and §8.2
names cost blindness as one of the seven sins that manufacture fake edges: "for
intraday, err pessimistic (costs kill more intraday edges than logic errors
do)". §10.2 requires every published signal to carry "EV after costs".

Until now the engine charged costs in the **backtest** (`backtest.py`, 5 bps
slippage plus fees) and nowhere else, so a live signal reported a gross
reward:risk and was measured against a gross floor. That is the exact asymmetry
§8.3 warns about — the backtest and the live system judging the same setup by
different arithmetic — and it flatters short-horizon trades most, because cost
is fixed in price terms while the risk distance shrinks with the timeframe.

A worked example of why this matters, using this engine's own numbers. A 15m
crypto setup with a 1.8-ATR stop on a pair whose 15m ATR is 0.15% risks about
0.27% of price. A round trip costs roughly 0.14% (two crossings of a ~2 bps
spread plus 10 bps taker fees each way, plus slippage). That is **half an R**.
A setup reporting 1.60:1 gross is really about 1.07:1 — below the 1.5 floor it
was just told it had cleared. The same trade on the daily, where risk is ten
times wider, loses about a twentieth of an R and the distinction barely
registers. So the floor has to be applied to the net number or the engine
systematically publishes its worst trades as though they were its best.

Estimates, not measurements. Real cost depends on venue, size, tier and the
moment — none of which this service knows. The numbers below are deliberately
pessimistic within the plausible range, per §8.2, and the resulting `netRR` is
always reported alongside the gross figure so the deduction is visible rather
than baked in silently.
"""

from __future__ import annotations

from typing import Any

#: Round-trip cost in basis points of notional, by asset class.
#:
#: Each is entry + exit: the spread crossed twice plus fees both ways.
#:
#: * ``CRYPTO`` — 10 bps taker per side on a mainstream venue, plus a ~2 bps
#:   spread on a major pair. Retail tiers are worse; maker rebates are better,
#:   but a signal is a market-order instruction, so taker is the honest read.
#: * ``FOREX`` — spot majors are the cheapest thing here: no commission on a
#:   retail spread account, ~1 pip on EURUSD round trip. Crosses and INR pairs
#:   are several times wider, which `_pair_multiplier` handles.
#: * ``EQUITY`` — Indian equities carry brokerage, STT, exchange and stamp
#:   charges. Matches `backtest.py`'s default so the two agree.
#: * ``INVESTMENT`` — funds transact at NAV with no spread; exit loads apply
#:   over horizons this engine does not signal on.
ROUND_TRIP_BPS: dict[str, float] = {
    "CRYPTO": 24.0,
    "FOREX": 4.0,
    "EQUITY": 30.0,
    "INVESTMENT": 10.0,
}

#: Extra slippage in basis points, by setup timeframe.
#:
#: Not a claim that fast bars have wider spreads — they do not. It is that a
#: signal on a fast bar is acted on into a thinner book with less time to work
#: the order, and that the engine's own entry is the *close* of a bar it can
#: only act on after that bar has closed. §6.1: "costs decide everything at this
#: frequency (model spread+slippage per asset per hour)".
TIMEFRAME_SLIPPAGE_BPS: dict[str, float] = {
    "1m": 8.0,
    "3m": 7.0,
    "5m": 6.0,
    "15m": 5.0,
    "30m": 4.0,
    "1h": 3.0,
    "4h": 2.0,
    "1D": 1.5,
    "1W": 1.0,
    "1M": 1.0,
}

#: Forex pairs are not one market. A spread that is 0.6 pips on EURUSD is 15+
#: on a thin INR cross, and expressing that as a multiple of the majors keeps
#: the table short.
_FX_WIDE = ("INR", "TRY", "ZAR", "MXN", "SEK", "NOK")


def _pair_multiplier(symbol: str, asset_class: str) -> float:
    """How much wider than the class default this instrument trades."""
    upper = symbol.upper()

    if asset_class == "FOREX":
        # An INR or EM leg is the expensive half of the pair and sets the cost.
        if any(code in upper for code in _FX_WIDE):
            return 4.0
        # Majors — the pairs the class default was written for.
        if upper in {"EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCHF", "USDCAD", "NZDUSD"}:
            return 1.0
        # Everything else is a cross: wider than a major, cheaper than an EM.
        return 2.0

    if asset_class == "CRYPTO":
        # Majors quote inside a basis point or two; everything else does not.
        return 1.0 if upper in {"BTC", "ETH"} else 1.5

    return 1.0


def round_trip_bps(symbol: str, asset_class: str, timeframe: str) -> float:
    """Total round-trip cost for one trade, in basis points of entry price."""
    base = ROUND_TRIP_BPS.get(asset_class, 25.0)
    slippage = TIMEFRAME_SLIPPAGE_BPS.get(timeframe, 3.0)
    return (base + slippage) * _pair_multiplier(symbol, asset_class)


def apply(
    *,
    entry: float,
    stop_loss: float,
    targets: list[dict[str, Any]],
    symbol: str,
    asset_class: str,
    timeframe: str,
) -> dict[str, Any]:
    """
    Charge the round trip against a trade's arithmetic.

    Returns the cost in price and R terms, the net reward:risk at each target,
    and a sentence naming the deduction. Never mutates the gross numbers — §8.2
    is about making costs *visible*, and a net figure that silently replaced the
    gross one would hide exactly what it was added to show.
    """
    risk_per_unit = abs(entry - stop_loss)
    if entry <= 0 or risk_per_unit <= 0:
        return {
            "available": False,
            "note": "No entry or stop to charge costs against.",
        }

    bps = round_trip_bps(symbol, asset_class, timeframe)
    cost_price = entry * bps / 10_000.0

    # Cost as a fraction of the risk unit. This is the number that matters: it
    # is how much of one R disappears into the round trip, and therefore how far
    # the whole reward:risk ladder shifts down.
    cost_r = cost_price / risk_per_unit

    net_targets = []
    for target in targets:
        gross_rr = float(target.get("rr", 0.0))
        net_targets.append(
            {
                "level": target.get("level"),
                "price": target.get("price"),
                "grossRR": round(gross_rr, 2),
                # Cost is paid on both the reward and the risk: winning nets
                # less and losing costs more, so the honest ratio divides the
                # reduced gain by the increased loss.
                "netRR": round(max(0.0, (gross_rr - cost_r) / (1.0 + cost_r)), 2),
            }
        )

    first = net_targets[0] if net_targets else None

    return {
        "available": True,
        "roundTripBps": round(bps, 1),
        "costPerUnit": cost_price,
        "costAsR": round(cost_r, 3),
        "grossRR": first["grossRR"] if first else 0.0,
        "netRR": first["netRR"] if first else 0.0,
        "targets": net_targets,
        "note": (
            f"A round trip on {symbol} at {timeframe} costs about {bps:.0f} bps, "
            f"which is {cost_r * 100:.0f}% of the risk on this setup"
            + (
                f" — first target is {first['grossRR']:.2f}:1 gross, "
                f"{first['netRR']:.2f}:1 after costs."
                if first
                else "."
            )
        ),
    }
