"""
The analysis pipeline.

Single entry point that turns candles into every artefact the platform serves:
technical read, price action, SMC, patterns, per-candle anatomy, next-candle
forecast, calibration and the trade signal.

Everything is computed once here and shared. Recomputing indicators inside each
sub-analysis is the obvious way to write this and would triple the cost of every
request.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd

from ..config import settings
from . import (
    calibration,
    candlesticks,
    derivatives as derivatives_engine,
    elliott,
    factors,
    ict as ict_engine,
    forecast,
    harmonics,
    orderbook as orderbook_engine,
    orderflow,
    patterns,
    price_action,
    signals,
    smc,
    volume_profile,
)
from .anatomy import analyse_candle, analyse_series, describe
from .indicators import compute_all, last_valid
from .structure import classify_trend, find_levels, find_swings, level_proximity, swing_window_for

log = logging.getLogger(__name__)


def to_frame(candles: list[dict[str, Any]]) -> pd.DataFrame:
    """
    Normalise incoming candles into a sorted, de-duplicated OHLCV frame.

    Bars with a null close are dropped rather than forward-filled — a synthetic
    price would propagate through every indicator and be indistinguishable from
    a real one downstream.
    """
    if not candles:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    df = pd.DataFrame(candles)
    required = {"time", "open", "high", "low", "close"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"candles missing required fields: {sorted(missing)}")

    if "volume" not in df.columns:
        df["volume"] = 0.0

    df = df.dropna(subset=["close"])
    df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.set_index("time").sort_index()
    df = df[~df.index.duplicated(keep="last")]

    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["open", "high", "low", "close"])
    df["volume"] = df["volume"].fillna(0.0)

    # Guard against provider glitches where high < low.
    bad = df["high"] < df["low"]
    if bad.any():
        log.warning("dropping %d candles with high < low", int(bad.sum()))
        df = df[~bad]

    return df[["open", "high", "low", "close", "volume"]]


def _indicator_readings(df: pd.DataFrame, ind: dict[str, pd.Series]) -> list[dict[str, Any]]:
    """The indicator table shown on the technical analysis tab."""
    price = float(df["close"].iloc[-1])
    out: list[dict[str, Any]] = []

    def add(
        key: str, label: str, value: float | None, display: str, stance: str, note: str,
        extra: dict[str, float | None] | None = None,
    ) -> None:
        out.append({
            "key": key, "label": label,
            "value": round(value, 6) if value is not None else None,
            "display": display, "stance": stance, "note": note,
            "extra": extra or {},
        })

    rsi_v = last_valid(ind.get("rsi"))
    if rsi_v is not None:
        add("rsi", "RSI (14)", rsi_v, f"{rsi_v:.1f}",
            "BEARISH" if rsi_v >= 70 else "BULLISH" if rsi_v <= 30 else "BULLISH" if rsi_v > 55 else "BEARISH" if rsi_v < 45 else "NEUTRAL",
            "Overbought — extended, but strong trends stay overbought for a long time" if rsi_v >= 70
            else "Oversold — stretched to the downside" if rsi_v <= 30
            else f"Mid-range at {rsi_v:.0f}, no extreme reading")

    macd_v, sig, hist = last_valid(ind.get("macd")), last_valid(ind.get("macd_signal")), last_valid(ind.get("macd_hist"))
    if macd_v is not None and sig is not None:
        bullish = macd_v > sig
        add("macd", "MACD (12,26,9)", macd_v, f"{macd_v:.3f}",
            "BULLISH" if bullish else "BEARISH",
            f"MACD line {'above' if bullish else 'below'} signal — momentum favours the {'upside' if bullish else 'downside'}",
            {"signal": round(sig, 6), "histogram": round(hist, 6) if hist is not None else None})

    for key, label, period in (("ema_20", "EMA 20", 20), ("ema_50", "EMA 50", 50), ("ema_200", "EMA 200", 200)):
        v = last_valid(ind.get(key))
        if v is not None:
            above = price > v
            add(key, label, v, f"{v:,.2f}", "BULLISH" if above else "BEARISH",
                f"Price is {abs(price / v - 1) * 100:.1f}% {'above' if above else 'below'} the {period}-period EMA")

    sma50 = last_valid(ind.get("sma_50"))
    if sma50 is not None:
        add("sma_50", "SMA 50", sma50, f"{sma50:,.2f}", "BULLISH" if price > sma50 else "BEARISH",
            f"Price {'above' if price > sma50 else 'below'} the 50-period simple average")

    vwap_v = last_valid(ind.get("vwap"))
    if vwap_v is not None:
        add("vwap", "VWAP", vwap_v, f"{vwap_v:,.2f}", "BULLISH" if price > vwap_v else "BEARISH",
            f"Trading {'above' if price > vwap_v else 'below'} the session volume-weighted average — "
            f"{'buyers' if price > vwap_v else 'sellers'} control the session")
    else:
        add("vwap", "VWAP", None, "n/a", "NEUTRAL",
            "Not available — this instrument has no meaningful traded volume")

    atr_v, atr_pct = last_valid(ind.get("atr")), last_valid(ind.get("atr_percent"))
    if atr_v is not None:
        add("atr", "ATR (14)", atr_v, f"{atr_v:,.2f}", "NEUTRAL",
            f"Average bar range is {atr_pct:.2f}% of price — use this to size stops" if atr_pct else "Average true range")

    adx_v, pdi, mdi = last_valid(ind.get("adx")), last_valid(ind.get("plus_di")), last_valid(ind.get("minus_di"))
    if adx_v is not None:
        add("adx", "ADX (14)", adx_v, f"{adx_v:.1f}",
            "BULLISH" if (pdi or 0) > (mdi or 0) and adx_v > 20 else "BEARISH" if (mdi or 0) > (pdi or 0) and adx_v > 20 else "NEUTRAL",
            "Strong trend" if adx_v >= 40 else "Trending" if adx_v >= 25 else "Weak trend — likely chop" if adx_v < 20 else "Developing trend",
            {"plusDI": round(pdi, 2) if pdi else None, "minusDI": round(mdi, 2) if mdi else None})

    bb_u, bb_m, bb_l, bb_p = (last_valid(ind.get(k)) for k in ("bb_upper", "bb_middle", "bb_lower", "bb_percent_b"))
    if bb_u is not None and bb_l is not None:
        add("bollinger", "Bollinger Bands (20,2)", bb_p, f"%B {bb_p:.2f}" if bb_p is not None else "—",
            "BEARISH" if (bb_p or 0.5) > 1 else "BULLISH" if (bb_p or 0.5) < 0 else "NEUTRAL",
            f"Bands span {bb_l:,.2f} – {bb_u:,.2f}",
            {"upper": round(bb_u, 4), "middle": round(bb_m, 4) if bb_m else None, "lower": round(bb_l, 4)})

    tenkan, kijun = last_valid(ind.get("ichimoku_tenkan")), last_valid(ind.get("ichimoku_kijun"))
    sen_a, sen_b = last_valid(ind.get("ichimoku_senkou_a")), last_valid(ind.get("ichimoku_senkou_b"))
    if sen_a is not None and sen_b is not None:
        top, bottom = max(sen_a, sen_b), min(sen_a, sen_b)
        stance = "BULLISH" if price > top else "BEARISH" if price < bottom else "NEUTRAL"
        add("ichimoku", "Ichimoku Cloud", None,
            "Above cloud" if price > top else "Below cloud" if price < bottom else "In cloud", stance,
            f"Cloud spans {bottom:,.2f} – {top:,.2f}. Inside the cloud there is no directional edge.",
            {"tenkan": round(tenkan, 4) if tenkan else None, "kijun": round(kijun, 4) if kijun else None,
             "senkouA": round(sen_a, 4), "senkouB": round(sen_b, 4)})

    st_line, st_dir = last_valid(ind.get("supertrend")), last_valid(ind.get("supertrend_dir"))
    if st_line is not None and st_dir is not None:
        bull = st_dir > 0
        add("supertrend", "SuperTrend (10,3)", st_line, f"{st_line:,.2f}", "BULLISH" if bull else "BEARISH",
            f"{'Bullish' if bull else 'Bearish'} — the line at {st_line:,.2f} acts as a trailing stop")

    stoch_k, stoch_d = last_valid(ind.get("stoch_k")), last_valid(ind.get("stoch_d"))
    if stoch_k is not None:
        add("stochastic", "Stochastic (14,3,3)", stoch_k, f"{stoch_k:.1f}",
            "BEARISH" if stoch_k >= 80 else "BULLISH" if stoch_k <= 20 else "NEUTRAL",
            "Overbought" if stoch_k >= 80 else "Oversold" if stoch_k <= 20 else "Mid-range",
            {"d": round(stoch_d, 2) if stoch_d else None})

    mfi_v = last_valid(ind.get("mfi"))
    if mfi_v is not None:
        add("mfi", "Money Flow Index", mfi_v, f"{mfi_v:.1f}",
            "BEARISH" if mfi_v >= 80 else "BULLISH" if mfi_v <= 20 else "NEUTRAL",
            "Volume-weighted momentum — diverging from RSI is the useful case")

    vr = last_valid(ind.get("volume_ratio"))
    if vr is not None:
        add("volume", "Volume vs 20-avg", vr, f"{vr:.2f}x",
            "BULLISH" if vr > 1.5 else "NEUTRAL",
            f"{'Well above' if vr > 2 else 'Above' if vr > 1.2 else 'Below' if vr < 0.8 else 'In line with'} average participation")

    return out


def _technical_score(readings: list[dict[str, Any]]) -> float:
    """−100…+100 roll-up of the indicator table."""
    if not readings:
        return 0.0
    values = [1 if r["stance"] == "BULLISH" else -1 if r["stance"] == "BEARISH" else 0 for r in readings]
    return float(np.clip(sum(values) / len(values) * 100.0, -100, 100))


def analyse(
    candles: list[dict[str, Any]],
    *,
    symbol: str,
    name: str | None = None,
    asset_class: str = "EQUITY",
    timeframe: str = "1D",
    higher_tf_candles: list[dict[str, Any]] | None = None,
    sentiment: dict[str, Any] | None = None,
    fundamentals: dict[str, Any] | None = None,
    risk_per_trade: float = 1.0,
    with_calibration: bool = True,
    #: A calibration report measured earlier for this exact symbol, timeframe and
    #: closed bar. Replaces the walk-forward pass rather than supplementing it.
    precomputed_calibration: dict[str, Any] | None = None,
    #: Validated weights from the review loop. None uses the engine defaults.
    factor_weights: dict[str, float] | None = None,
    #: Raw candle dicts, so the taker-side fields survive the DataFrame
    #: conversion — `to_frame` keeps only OHLCV by design.
    raw_candles: list[dict[str, Any]] | None = None,
    #: Live depth snapshot, when the venue publishes one.
    order_book: dict[str, Any] | None = None,
    #: Perpetual funding, open interest and positioning. Crypto only.
    derivatives: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Full analysis. The single function every API route ultimately calls.
    """
    df = to_frame(candles)
    if len(df) < 20:
        raise ValueError(f"need at least 20 candles to analyse, got {len(df)}")

    display_name = name or symbol
    ind = compute_all(df)
    atr_value = last_valid(ind.get("atr")) or 0.0
    price = float(df["close"].iloc[-1])

    # ── Structure ────────────────────────────────────────────────
    swing_window = swing_window_for(timeframe)
    swings = find_swings(df, swing_window)
    adx_v = last_valid(ind.get("adx"))
    trend = classify_trend(swings, adx_v)

    # Volume per price, before levels — §1.5 lists volume-profile HVNs as one of
    # the four origins a support/resistance zone should be built from, and a
    # swing that coincides with a high-volume node is a materially better level
    # than one that does not. Unavailable on spot forex, which reports no true
    # volume; `find_levels` handles the None.
    profile = volume_profile.analyse(df, atr_value=atr_value)
    levels = find_levels(df, swings, atr_value=atr_value, profile=profile)

    # ── Higher timeframe bias ────────────────────────────────────
    higher_tf_trend: str | None = None
    if higher_tf_candles:
        try:
            htf_df = to_frame(higher_tf_candles)
            if len(htf_df) >= 20:
                htf_swings = find_swings(htf_df, swing_window_for("1D"))
                from .indicators import adx as adx_fn
                htf_adx = last_valid(adx_fn(htf_df).adx)
                higher_tf_trend = classify_trend(htf_swings, htf_adx)["direction"]
        except Exception:  # noqa: BLE001 — a bad HTF series must not fail the request
            log.warning("higher-timeframe analysis failed for %s", symbol, exc_info=True)

    # ── Current candle ───────────────────────────────────────────
    anatomy = analyse_candle(
        df, len(df) - 1,
        atr_series=ind.get("atr"), volume_sma=ind.get("volume_sma_20"),
        ema20=ind.get("ema_20"), vwap_series=ind.get("vwap"),
    )

    proximity = level_proximity(levels, price, atr_value)
    near_level = bool(proximity["near"])
    level_agrees = False
    if near_level and proximity["level"] is not None:
        lv = proximity["level"]
        level_agrees = (lv.kind == "SUPPORT" and proximity["side"] == "ABOVE") or (
            lv.kind == "RESISTANCE" and proximity["side"] == "BELOW"
        )

    candle_patterns = candlesticks.detect(
        df, trend_direction=trend["direction"],
        near_level=near_level, level_side_agrees=level_agrees, anatomy=anatomy,
    )

    # ── Sub-analyses ─────────────────────────────────────────────
    pa = price_action.analyse(
        df, swings, levels, ind,
        atr_value=atr_value, trend_direction=trend["direction"], timeframe=timeframe,
    )
    smc_result = smc.analyse(df, swings, atr_value=atr_value, timeframe=timeframe)

    # ICT refinements on the same structural read: killzone timing, the OTE
    # band, and order blocks that failed and flipped. Reuses the blocks SMC
    # already found so the two cannot disagree about where a level is.
    ict_result = ict_engine.analyse(
        df,
        swings,
        smc.find_order_blocks(df, atr_value=atr_value),
        atr_value=atr_value,
        timeframe=timeframe,
    )
    chart_patterns = patterns.detect(df, swings, atr_value=atr_value)
    harmonic_patterns = harmonics.detect(df, swings, atr_value=atr_value)

    # ── Binance microstructure ───────────────────────────────────
    # Both return `available: False` for venues that publish neither, and the
    # factor blend then simply omits them.
    flow = orderflow.analyse(raw_candles or [], atr_value=atr_value)
    book = orderbook_engine.analyse(order_book, price=price)

    # Funding and positioning. Given the structural trend so rising open
    # interest can be read as conviction behind the existing move — on its own
    # it has no direction, and guessing one would invent evidence.
    trend_direction = {"UPTREND": 1.0, "DOWNTREND": -1.0}.get(trend.get("direction", ""), 0.0)
    derivs = derivatives_engine.analyse(derivatives, trend_score=trend_direction)
    elliott_result = elliott.analyse(df, swings, min_bars=settings.min_bars)
    regime = factors.volatility_regime(ind)

    harmonic_value = harmonics.harmonic_score(harmonic_patterns)
    harmonic_note = (
        f"{harmonic_patterns[0].name} {harmonic_patterns[0].status.lower()} at "
        f"{harmonic_patterns[0].completion:.2f}, invalid beyond {harmonic_patterns[0].invalidation:.2f}"
        if harmonic_patterns
        else ""
    )
    elliott_value = float(elliott_result.get("score", 0.0))
    elliott_note = elliott_result["summary"] if elliott_result.get("count") else ""

    # ── Factors & forecast ───────────────────────────────────────
    factor_list = factors.build(
        df, ind,
        anatomy=anatomy, trend=trend, candle_patterns=candle_patterns,
        price_action=pa, smc=smc_result, regime=regime,
        sentiment=sentiment, fundamentals=fundamentals,
        higher_tf_trend=higher_tf_trend, asset_class=asset_class,
        harmonic=harmonic_value, harmonic_note=harmonic_note,
        elliott=elliott_value, elliott_note=elliott_note,
        weights=factor_weights,
        order_flow=flow if flow.get("available") else None,
        order_book=book if book.get("available") else None,
        derivatives=derivs if derivs.get("available") else None,
        ict=ict_result if ict_result.get("available") else None,
    )

    # ── Calibration ──────────────────────────────────────────────
    # Re-runs this exact pipeline on truncated slices. Expensive, so it is
    # cached upstream and refreshed by a nightly job rather than per request.
    report = None
    calibrator = None
    if precomputed_calibration:
        # Measured on a previous request for this same closed bar. The caller
        # owns cache invalidation — it keys on the bar timestamp, so a report
        # can only arrive here while it is still the answer the walk-forward
        # pass would produce.
        try:
            report = calibration.CalibrationReport.from_dict(precomputed_calibration)
            calibrator = calibration.build_calibrator(report)
        except Exception:  # noqa: BLE001 — a bad cache entry must not fail the analysis
            log.warning("could not restore cached calibration for %s %s", symbol, timeframe)
            report = None
            calibrator = None
    if report is None and with_calibration and len(df) >= settings.min_bars + 30:
        try:
            # Cap the number of scoring passes. Adjacent bars produce nearly
            # identical predictions, so beyond ~200 samples the extra passes buy
            # resolution nobody reads at real latency cost.
            # ~125 samples: enough to clear the 100-sample floor that gates the
            # correction fit, without paying for passes that tell us nothing new.
            candidates = min(len(df) - settings.min_bars, settings.calibration_window)
            stride = max(1, candidates // 125)

            report = calibration.walk_forward(
                df,
                _make_scorer(asset_class, timeframe, swing_window),
                flat_threshold=0.0005,
                stride=stride,
            )
            calibrator = calibration.build_calibrator(report)
        except Exception:  # noqa: BLE001 — never fail an analysis over calibration
            log.warning("calibration failed for %s %s", symbol, timeframe, exc_info=True)

    fc = forecast.generate(
        df, factor_list,
        anatomy=anatomy, regime=regime, atr_value=atr_value,
        higher_tf_trend=higher_tf_trend, calibrator=calibrator,
    )

    # ── Signal ───────────────────────────────────────────────────
    setup = "BREAKOUT" if any(e["type"] in {"BREAKOUT", "BREAKDOWN"} for e in pa["events"][:2]) else "MOMENTUM"
    signal = signals.build(
        df, fc, levels,
        symbol=symbol, name=display_name, asset_class=asset_class, timeframe=timeframe,
        atr_value=atr_value, regime=regime, trend=trend,
        risk_per_trade=risk_per_trade, setup=setup,
    )

    readings = _indicator_readings(df, ind)
    tech_score = _technical_score(readings)

    ema20_v, ema50_v, ema200_v = (last_valid(ind.get(k)) for k in ("ema_20", "ema_50", "ema_200"))
    ma_stack = "MIXED"
    if ema20_v and ema50_v and ema200_v:
        if price > ema20_v > ema50_v > ema200_v:
            ma_stack = "BULLISH"
        elif price < ema20_v < ema50_v < ema200_v:
            ma_stack = "BEARISH"

    volume_ratio_v = last_valid(ind.get("volume_ratio")) or 1.0
    divergence = factors.detect_divergence(df, ind)

    forecast_payload = {
        "symbol": symbol,
        "timeframe": timeframe,
        "anatomy": anatomy.to_dict(),
        **fc.to_dict(),
        "calibration": report.to_dict() if report else None,
        "calibrationVerdict": calibration.verdict(report),
        "summary": forecast.summarise(fc, anatomy, symbol, timeframe),
    }
    signal["forecast"] = forecast_payload
    signal["calibration"] = report.to_dict() if report else None

    return {
        "symbol": symbol,
        "name": display_name,
        "assetClass": asset_class,
        "timeframe": timeframe,
        "price": price,
        "asOf": df.index[-1].isoformat(),
        "technical": {
            "symbol": symbol,
            "timeframe": timeframe,
            "asOf": df.index[-1].isoformat(),
            "price": price,
            "indicators": readings,
            "score": tech_score,
            "stance": "BULLISH" if tech_score > 15 else "BEARISH" if tech_score < -15 else "NEUTRAL",
            "trend": {
                "direction": trend["direction"],
                "strength": round(trend["strength"], 1),
                "label": trend["label"],
                "maStack": ma_stack,
            },
            "momentum": {
                "value": round(float(np.clip((last_valid(ind.get("rsi")) or 50) - 50, -50, 50) * 2), 1),
                "label": _momentum_label(last_valid(ind.get("rsi"))),
                "divergence": divergence,
            },
            "volatility": {
                "atr": round(regime["atr"], 6),
                "atrPercent": round(regime["atrPercent"], 3),
                "regime": regime["regime"],
                "percentile": round(regime["percentile"], 1),
            },
            "volume": {
                "ratio": round(volume_ratio_v, 2),
                "trend": _volume_trend(ind),
                "label": _volume_label(volume_ratio_v),
            },
            "summary": _technical_summary(trend, regime, readings, tech_score),
        },
        "priceAction": {
            "symbol": symbol, "timeframe": timeframe,
            "levels": pa["levels"], "events": pa["events"],
            "trendlines": pa["trendlines"], "channel": pa["channel"],
            "summary": pa["summary"],
        },
        "smc": {
            "symbol": symbol, "timeframe": timeframe,
            "orderBlocks": smc_result["orderBlocks"],
            "fairValueGaps": smc_result["fairValueGaps"],
            "liquidity": smc_result["liquidity"],
            "structure": smc_result["structure"],
            "premiumDiscount": smc_result["premiumDiscount"],
            "bias": smc_result["bias"],
            "summary": smc_result["summary"],
        },
        "orderFlow": {**flow, "series": orderflow.delta_series(raw_candles or [])}
        if flow.get("available")
        else flow,
        "orderBook": book,
        "volumeProfile": {
            **profile,
            # Advisory stop anchor, when the setup has a direction to anchor
            # against. §7.2 — a stop beyond a low-volume node is only reached by
            # a move that traded through an area the market has been refusing to
            # trade in, rather than by ordinary rotation.
            "stopAnchor": volume_profile.stop_anchor(
                profile,
                entry=float(signal.get("entry") or price),
                stop_loss=float(signal.get("stopLoss") or 0.0),
                long=signal.get("action") == "BUY",
                atr_value=atr_value,
            )
            if signal.get("action") in ("BUY", "SELL") and signal.get("stopLoss")
            else None,
        },
        "derivatives": derivs,
        "ict": ict_result,
        "chartPatterns": [p.to_dict() for p in chart_patterns],
        "harmonicPatterns": [p.to_dict() for p in harmonic_patterns],
        "elliott": elliott_result,
        "candlestickPatterns": [p.to_dict() for p in candle_patterns],
        "candleAnatomy": anatomy.to_dict(),
        "candleDescription": describe(anatomy),
        "forecast": forecast_payload,
        "signal": signal,
        "meta": {
            "bars": len(df),
            "swingWindow": swing_window,
            "higherTimeframeTrend": higher_tf_trend,
            "factorGroups": [f.group for f in factor_list],
            "droppedGroups": sorted(set(factors.BASE_WEIGHTS) - {f.group for f in factor_list}),
        },
    }


def _make_scorer(asset_class: str, timeframe: str, swing_window: int):
    """
    Build the walk-forward scorer.

    Runs the same factor pipeline the live path uses, on a truncated slice, with
    the expensive optional inputs (news, fundamentals, higher timeframe) omitted
    — those aren't available historically anyway, and pretending otherwise would
    leak future information into the calibration.
    """

    def score(window_df: pd.DataFrame) -> tuple[float, float] | None:
        if len(window_df) < 40:
            return None
        try:
            w_ind = compute_all(window_df)
            w_atr = last_valid(w_ind.get("atr")) or 0.0
            if w_atr <= 0:
                return None

            w_swings = find_swings(window_df, swing_window)
            w_trend = classify_trend(w_swings, last_valid(w_ind.get("adx")))
            w_levels = find_levels(window_df, w_swings, atr_value=w_atr)
            w_anatomy = analyse_candle(
                window_df, len(window_df) - 1,
                atr_series=w_ind.get("atr"), volume_sma=w_ind.get("volume_sma_20"),
                ema20=w_ind.get("ema_20"), vwap_series=w_ind.get("vwap"),
            )
            w_patterns = candlesticks.detect(
                window_df, trend_direction=w_trend["direction"], anatomy=w_anatomy
            )
            w_pa = price_action.analyse(
                window_df, w_swings, w_levels, w_ind,
                atr_value=w_atr, trend_direction=w_trend["direction"], timeframe=timeframe,
            )
            w_smc = smc.analyse(window_df, w_swings, atr_value=w_atr, timeframe=timeframe)
            w_regime = factors.volatility_regime(w_ind)

            w_factors = factors.build(
                window_df, w_ind,
                anatomy=w_anatomy, trend=w_trend, candle_patterns=w_patterns,
                price_action=w_pa, smc=w_smc, regime=w_regime,
                sentiment=None, fundamentals=None, higher_tf_trend=None,
                asset_class=asset_class,
            )

            w_fc = forecast.generate(
                window_df, w_factors,
                anatomy=w_anatomy, regime=w_regime, atr_value=w_atr, calibrator=None,
            )

            directional = w_fc.prob_up + w_fc.prob_down
            if directional <= 0:
                return None
            return w_fc.prob_up / directional, w_fc.confidence
        except Exception:  # noqa: BLE001
            return None

    return score


def forecast_history(
    candles: list[dict[str, Any]],
    *,
    symbol: str,
    asset_class: str = "EQUITY",
    timeframe: str = "1D",
    lookback: int = 30,
) -> list[dict[str, Any]]:
    """
    Per-candle anatomy plus the forecast the engine *would have made* at each
    bar, and what actually happened next.

    This is what powers the candle-by-candle view: every bar carries its own
    read, and the outcome column shows whether that read was right. Being able
    to see the misses is the point.
    """
    df = to_frame(candles)
    if len(df) < 60:
        raise ValueError("need at least 60 candles for a forecast history")

    ind = compute_all(df)
    swing_window = swing_window_for(timeframe)
    scorer = _make_scorer(asset_class, timeframe, swing_window)
    anatomies = analyse_series(df, ind, lookback=lookback)

    closes = df["close"].to_numpy(dtype=float)
    n = len(df)
    start = n - len(anatomies)
    out: list[dict[str, Any]] = []

    for offset, a in enumerate(anatomies):
        i = start + offset
        scored = scorer(df.iloc[: i + 1]) if i >= 40 else None

        entry: dict[str, Any] = {
            "anatomy": a.to_dict(),
            "description": describe(a),
            "predicted": None,
            "confidence": None,
            "actual": None,
            "correct": None,
        }

        if scored is not None:
            prob_up, confidence = scored
            entry["predicted"] = "UP" if prob_up > 0.5 else "DOWN"
            entry["probUp"] = round(prob_up, 4)
            entry["confidence"] = round(confidence, 1)

            if i + 1 < n:
                change = (closes[i + 1] - closes[i]) / closes[i] * 100.0 if closes[i] else 0.0
                entry["actual"] = "UP" if change > 0 else "DOWN" if change < 0 else "FLAT"
                entry["actualChangePercent"] = round(change, 3)
                if entry["actual"] != "FLAT":
                    entry["correct"] = entry["predicted"] == entry["actual"]

        out.append(entry)

    return out


# ── Small helpers for the technical summary ──────────────────────


def _momentum_label(rsi_value: float | None) -> str:
    if rsi_value is None:
        return "Not enough data"
    if rsi_value >= 70:
        return "Strongly bullish, overbought"
    if rsi_value >= 55:
        return "Bullish"
    if rsi_value <= 30:
        return "Strongly bearish, oversold"
    if rsi_value <= 45:
        return "Bearish"
    return "Neutral"


def _volume_trend(ind: dict[str, pd.Series]) -> str:
    series = ind.get("volume_sma_20")
    if series is None or len(series.dropna()) < 10:
        return "FLAT"
    clean = series.dropna().iloc[-10:]
    slope = np.polyfit(np.arange(len(clean)), clean.to_numpy(dtype=float), 1)[0]
    mean = float(clean.mean())
    if mean <= 0:
        return "FLAT"
    normalised = slope / mean
    return "RISING" if normalised > 0.01 else "FALLING" if normalised < -0.01 else "FLAT"


def _volume_label(ratio: float) -> str:
    if ratio >= 2.0:
        return f"{ratio:.1f}× average — heavy participation"
    if ratio >= 1.3:
        return f"{ratio:.1f}× average — above normal"
    if ratio <= 0.6:
        return f"{ratio:.1f}× average — thin"
    return f"{ratio:.1f}× average — normal"


def _technical_summary(
    trend: dict[str, Any], regime: dict[str, Any], readings: list[dict[str, Any]], score: float
) -> str:
    bullish = sum(1 for r in readings if r["stance"] == "BULLISH")
    bearish = sum(1 for r in readings if r["stance"] == "BEARISH")
    neutral = len(readings) - bullish - bearish

    lead = (
        f"{bullish} of {len(readings)} indicators read bullish, {bearish} bearish, {neutral} neutral "
        f"(net score {score:+.0f}/100)."
    )
    body = f" {trend['label']}."
    vol = f" Volatility is {regime['regime'].lower()} at the {regime['percentile']:.0f}th percentile of its own history."

    if abs(score) < 15:
        tail = " Indicators disagree, which usually means the market has not decided — a poor environment for directional risk."
    elif score > 0:
        tail = " The weight of evidence favours the upside on this timeframe."
    else:
        tail = " The weight of evidence favours the downside on this timeframe."

    return lead + body + vol + tail
