"""
Technical indicators.

Implemented directly against numpy/pandas rather than a TA library, for three
reasons: no dependency breaks on numpy majors, every formula is auditable against
docs/indicator-formulas.md, and we control the smoothing convention.

Two conventions used throughout, because getting them wrong silently shifts every
downstream number:

*Wilder smoothing* (RSI, ATR, ADX) is an EMA with ``alpha = 1/n``, not ``2/(n+1)``.
Wilder's originals in *New Concepts in Technical Trading Systems* use the former;
libraries that use the latter produce values that look right and aren't.

*Causality* — every function returns a series aligned to its input where element
``i`` uses only data up to and including ``i``. Nothing here peeks forward. This is
what makes the walk-forward calibration meaningful.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# ─────────────────────────────────────────────────────────────────
#  Moving averages
# ─────────────────────────────────────────────────────────────────


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(window=period, min_periods=period).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    """Standard EMA, alpha = 2/(n+1)."""
    return series.ewm(span=period, adjust=False, min_periods=period).mean()


def wilder(series: pd.Series, period: int) -> pd.Series:
    """Wilder's smoothing, alpha = 1/n. Used by RSI, ATR and ADX."""
    return series.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()


def wma(series: pd.Series, period: int) -> pd.Series:
    weights = np.arange(1, period + 1, dtype=float)
    return series.rolling(period).apply(
        lambda w: float(np.dot(w, weights) / weights.sum()), raw=True
    )


def hull_ma(series: pd.Series, period: int) -> pd.Series:
    half = max(1, period // 2)
    sqrt_p = max(1, int(np.sqrt(period)))
    return wma(2 * wma(series, half) - wma(series, period), sqrt_p)


# ─────────────────────────────────────────────────────────────────
#  Volatility
# ─────────────────────────────────────────────────────────────────


def true_range(df: pd.DataFrame) -> pd.Series:
    """max(H−L, |H−C_prev|, |L−C_prev|). The first bar falls back to H−L."""
    prev_close = df["close"].shift(1)
    ranges = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - prev_close).abs(),
            (df["low"] - prev_close).abs(),
        ],
        axis=1,
    )
    return ranges.max(axis=1)


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    return wilder(true_range(df), period)


def atr_percent(df: pd.DataFrame, period: int = 14) -> pd.Series:
    return atr(df, period) / df["close"] * 100.0


@dataclass
class BollingerBands:
    upper: pd.Series
    middle: pd.Series
    lower: pd.Series
    bandwidth: pd.Series
    percent_b: pd.Series


def bollinger(series: pd.Series, period: int = 20, std_mult: float = 2.0) -> BollingerBands:
    middle = sma(series, period)
    # ddof=0 — population sd, which is the standard convention for Bollinger.
    sd = series.rolling(period, min_periods=period).std(ddof=0)
    upper = middle + std_mult * sd
    lower = middle - std_mult * sd
    width = (upper - lower).replace(0, np.nan)
    return BollingerBands(
        upper=upper,
        middle=middle,
        lower=lower,
        bandwidth=(upper - lower) / middle * 100.0,
        percent_b=(series - lower) / width,
    )


@dataclass
class KeltnerChannels:
    upper: pd.Series
    middle: pd.Series
    lower: pd.Series


def keltner(df: pd.DataFrame, period: int = 20, atr_mult: float = 2.0) -> KeltnerChannels:
    middle = ema(df["close"], period)
    band = atr(df, period) * atr_mult
    return KeltnerChannels(upper=middle + band, middle=middle, lower=middle - band)


def bollinger_squeeze(df: pd.DataFrame, period: int = 20) -> pd.Series:
    """
    True when Bollinger Bands sit entirely inside the Keltner Channels — the
    classic volatility-compression state that precedes expansion.
    """
    bb = bollinger(df["close"], period)
    kc = keltner(df, period, 1.5)
    return (bb.upper < kc.upper) & (bb.lower > kc.lower)


def historical_volatility(series: pd.Series, period: int = 20, periods_per_year: int = 252) -> pd.Series:
    """Annualised stdev of log returns."""
    log_ret = np.log(series / series.shift(1))
    return log_ret.rolling(period, min_periods=period).std(ddof=1) * np.sqrt(periods_per_year) * 100.0


# ─────────────────────────────────────────────────────────────────
#  Momentum
# ─────────────────────────────────────────────────────────────────


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Wilder's RSI. 100 − 100/(1+RS), RS = avg gain / avg loss."""
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = wilder(gain, period)
    avg_loss = wilder(loss, period)
    # A zero average loss means an unbroken run of up-bars → RSI 100.
    rs = avg_gain / avg_loss.replace(0, np.nan)
    out = 100.0 - (100.0 / (1.0 + rs))
    return out.fillna(100.0).where(avg_loss.notna(), np.nan)


@dataclass
class MacdResult:
    macd: pd.Series
    signal: pd.Series
    histogram: pd.Series


def macd(series: pd.Series, fast: int = 12, slow: int = 26, signal_period: int = 9) -> MacdResult:
    line = ema(series, fast) - ema(series, slow)
    sig = ema(line, signal_period)
    return MacdResult(macd=line, signal=sig, histogram=line - sig)


@dataclass
class StochasticResult:
    k: pd.Series
    d: pd.Series


def stochastic(df: pd.DataFrame, k_period: int = 14, d_period: int = 3, smooth: int = 3) -> StochasticResult:
    low_n = df["low"].rolling(k_period, min_periods=k_period).min()
    high_n = df["high"].rolling(k_period, min_periods=k_period).max()
    span = (high_n - low_n).replace(0, np.nan)
    raw_k = (df["close"] - low_n) / span * 100.0
    k = raw_k.rolling(smooth, min_periods=smooth).mean()
    return StochasticResult(k=k, d=k.rolling(d_period, min_periods=d_period).mean())


def cci(df: pd.DataFrame, period: int = 20) -> pd.Series:
    """Commodity Channel Index. Lambert's 0.015 constant puts ~70–80% inside ±100."""
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    ma = sma(tp, period)
    mean_dev = tp.rolling(period, min_periods=period).apply(
        lambda x: float(np.mean(np.abs(x - x.mean()))), raw=True
    )
    return (tp - ma) / (0.015 * mean_dev.replace(0, np.nan))


def williams_r(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high_n = df["high"].rolling(period, min_periods=period).max()
    low_n = df["low"].rolling(period, min_periods=period).min()
    span = (high_n - low_n).replace(0, np.nan)
    return (high_n - df["close"]) / span * -100.0


def roc(series: pd.Series, period: int = 12) -> pd.Series:
    return (series / series.shift(period) - 1.0) * 100.0


def momentum(series: pd.Series, period: int = 10) -> pd.Series:
    return series - series.shift(period)


# ─────────────────────────────────────────────────────────────────
#  Trend strength & direction
# ─────────────────────────────────────────────────────────────────


@dataclass
class AdxResult:
    adx: pd.Series
    plus_di: pd.Series
    minus_di: pd.Series


def adx(df: pd.DataFrame, period: int = 14) -> AdxResult:
    """
    Wilder's ADX/DMI.

    Directional movement is exclusive: on any bar at most one of +DM/−DM is
    non-zero. Getting that wrong inflates both DIs and flattens ADX.
    """
    up_move = df["high"].diff()
    down_move = -df["low"].diff()

    plus_dm = pd.Series(
        np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=df.index
    )
    minus_dm = pd.Series(
        np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=df.index
    )

    atr_n = wilder(true_range(df), period).replace(0, np.nan)
    plus_di = 100.0 * wilder(plus_dm, period) / atr_n
    minus_di = 100.0 * wilder(minus_dm, period) / atr_n

    di_sum = (plus_di + minus_di).replace(0, np.nan)
    dx = 100.0 * (plus_di - minus_di).abs() / di_sum
    return AdxResult(adx=wilder(dx, period), plus_di=plus_di, minus_di=minus_di)


@dataclass
class SuperTrendResult:
    line: pd.Series
    direction: pd.Series  # +1 uptrend, −1 downtrend


def supertrend(df: pd.DataFrame, period: int = 10, multiplier: float = 3.0) -> SuperTrendResult:
    """
    SuperTrend.

    The ratcheting band logic is the whole indicator and must be iterative: a
    band only tightens, never loosens, while price stays on its side. Vectorised
    "shortcuts" for this produce a different (wrong) indicator.
    """
    hl2 = (df["high"] + df["low"]) / 2.0
    atr_n = atr(df, period)
    upper_basic = hl2 + multiplier * atr_n
    lower_basic = hl2 - multiplier * atr_n

    close = df["close"].to_numpy(dtype=float)
    ub = upper_basic.to_numpy(dtype=float)
    lb = lower_basic.to_numpy(dtype=float)
    n = len(df)

    final_ub = np.full(n, np.nan)
    final_lb = np.full(n, np.nan)
    direction = np.full(n, np.nan)
    line = np.full(n, np.nan)

    start = int(np.argmax(~np.isnan(ub))) if np.any(~np.isnan(ub)) else n
    if start >= n:
        idx = df.index
        return SuperTrendResult(
            line=pd.Series(line, index=idx), direction=pd.Series(direction, index=idx)
        )

    final_ub[start] = ub[start]
    final_lb[start] = lb[start]
    direction[start] = 1.0
    line[start] = lb[start]

    for i in range(start + 1, n):
        # Bands ratchet toward price and hold otherwise.
        final_ub[i] = ub[i] if (ub[i] < final_ub[i - 1] or close[i - 1] > final_ub[i - 1]) else final_ub[i - 1]
        final_lb[i] = lb[i] if (lb[i] > final_lb[i - 1] or close[i - 1] < final_lb[i - 1]) else final_lb[i - 1]

        if close[i] > final_ub[i - 1]:
            direction[i] = 1.0
        elif close[i] < final_lb[i - 1]:
            direction[i] = -1.0
        else:
            direction[i] = direction[i - 1]

        line[i] = final_lb[i] if direction[i] > 0 else final_ub[i]

    idx = df.index
    return SuperTrendResult(line=pd.Series(line, index=idx), direction=pd.Series(direction, index=idx))


@dataclass
class IchimokuResult:
    tenkan: pd.Series
    kijun: pd.Series
    senkou_a: pd.Series
    senkou_b: pd.Series
    chikou: pd.Series


def ichimoku(
    df: pd.DataFrame, tenkan_p: int = 9, kijun_p: int = 26, senkou_p: int = 52
) -> IchimokuResult:
    """
    Ichimoku Kinko Hyo.

    Note the displacement: the cloud is plotted *forward* 26 periods and Chikou
    *backward* 26. For charting that is correct. For signal generation we must
    only ever compare price against cloud values already visible at that bar —
    ``factors.py`` uses ``senkou_a.shift(kijun_p)`` accordingly, never the raw
    forward-shifted series.
    """

    def mid(period: int) -> pd.Series:
        return (
            df["high"].rolling(period, min_periods=period).max()
            + df["low"].rolling(period, min_periods=period).min()
        ) / 2.0

    tenkan = mid(tenkan_p)
    kijun = mid(kijun_p)
    return IchimokuResult(
        tenkan=tenkan,
        kijun=kijun,
        senkou_a=((tenkan + kijun) / 2.0).shift(kijun_p),
        senkou_b=mid(senkou_p).shift(kijun_p),
        chikou=df["close"].shift(-kijun_p),
    )


def parabolic_sar(df: pd.DataFrame, step: float = 0.02, max_af: float = 0.2) -> pd.Series:
    """Wilder's Parabolic SAR. Inherently iterative."""
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    n = len(df)
    if n < 2:
        return pd.Series(np.full(n, np.nan), index=df.index)

    sar = np.zeros(n)
    trend_up = True
    af = step
    ep = high[0]
    sar[0] = low[0]

    for i in range(1, n):
        prev = sar[i - 1]
        sar[i] = prev + af * (ep - prev)

        if trend_up:
            # SAR may never enter the prior two bars' range.
            sar[i] = min(sar[i], low[i - 1], low[max(0, i - 2)])
            if low[i] < sar[i]:
                trend_up = False
                sar[i] = ep
                ep = low[i]
                af = step
            elif high[i] > ep:
                ep = high[i]
                af = min(af + step, max_af)
        else:
            sar[i] = max(sar[i], high[i - 1], high[max(0, i - 2)])
            if high[i] > sar[i]:
                trend_up = True
                sar[i] = ep
                ep = high[i]
                af = step
            elif low[i] < ep:
                ep = low[i]
                af = min(af + step, max_af)

    return pd.Series(sar, index=df.index)


# ─────────────────────────────────────────────────────────────────
#  Volume
# ─────────────────────────────────────────────────────────────────


def obv(df: pd.DataFrame) -> pd.Series:
    """On-Balance Volume."""
    sign = np.sign(df["close"].diff().fillna(0.0))
    return (sign * df["volume"]).cumsum()


def money_flow_index(df: pd.DataFrame, period: int = 14) -> pd.Series:
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    raw_flow = tp * df["volume"]
    direction = np.sign(tp.diff().fillna(0.0))
    positive = raw_flow.where(direction > 0, 0.0).rolling(period, min_periods=period).sum()
    negative = raw_flow.where(direction < 0, 0.0).rolling(period, min_periods=period).sum()
    ratio = positive / negative.replace(0, np.nan)
    return (100.0 - 100.0 / (1.0 + ratio)).fillna(100.0)


def chaikin_money_flow(df: pd.DataFrame, period: int = 20) -> pd.Series:
    span = (df["high"] - df["low"]).replace(0, np.nan)
    mf_multiplier = ((df["close"] - df["low"]) - (df["high"] - df["close"])) / span
    mf_volume = mf_multiplier * df["volume"]
    return (
        mf_volume.rolling(period, min_periods=period).sum()
        / df["volume"].rolling(period, min_periods=period).sum().replace(0, np.nan)
    )


def accumulation_distribution(df: pd.DataFrame) -> pd.Series:
    span = (df["high"] - df["low"]).replace(0, np.nan)
    clv = ((df["close"] - df["low"]) - (df["high"] - df["close"])) / span
    return (clv.fillna(0.0) * df["volume"]).cumsum()


def vwap(df: pd.DataFrame, session_reset: bool = True) -> pd.Series:
    """
    Volume-weighted average price.

    Anchored to the session for intraday data — a VWAP that never resets is a
    different (and far less useful) statistic. Returns NaN when volume is absent
    or zero throughout, which is the case for spot forex; callers must treat
    that as "unavailable" rather than substituting a proxy.
    """
    if df["volume"].fillna(0).sum() <= 0:
        return pd.Series(np.nan, index=df.index)

    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    pv = tp * df["volume"]

    if session_reset and isinstance(df.index, pd.DatetimeIndex):
        day = df.index.normalize()
        cum_pv = pv.groupby(day).cumsum()
        cum_vol = df["volume"].groupby(day).cumsum()
    else:
        cum_pv = pv.cumsum()
        cum_vol = df["volume"].cumsum()

    return cum_pv / cum_vol.replace(0, np.nan)


def volume_ratio(df: pd.DataFrame, period: int = 20) -> pd.Series:
    """Current volume relative to its own recent average."""
    avg = sma(df["volume"], period).replace(0, np.nan)
    return df["volume"] / avg


# ─────────────────────────────────────────────────────────────────
#  Levels
# ─────────────────────────────────────────────────────────────────


@dataclass
class PivotLevels:
    pivot: float
    r1: float
    r2: float
    r3: float
    s1: float
    s2: float
    s3: float


def pivot_points(high: float, low: float, close: float, method: str = "standard") -> PivotLevels:
    """Floor-trader, Fibonacci and Camarilla variants."""
    rng = high - low

    if method == "fibonacci":
        p = (high + low + close) / 3.0
        return PivotLevels(
            pivot=p,
            r1=p + 0.382 * rng, r2=p + 0.618 * rng, r3=p + 1.000 * rng,
            s1=p - 0.382 * rng, s2=p - 0.618 * rng, s3=p - 1.000 * rng,
        )

    if method == "camarilla":
        p = (high + low + close) / 3.0
        return PivotLevels(
            pivot=p,
            r1=close + rng * 1.1 / 12.0,
            r2=close + rng * 1.1 / 6.0,
            r3=close + rng * 1.1 / 4.0,
            s1=close - rng * 1.1 / 12.0,
            s2=close - rng * 1.1 / 6.0,
            s3=close - rng * 1.1 / 4.0,
        )

    p = (high + low + close) / 3.0
    return PivotLevels(
        pivot=p,
        r1=2 * p - low, r2=p + rng, r3=high + 2 * (p - low),
        s1=2 * p - high, s2=p - rng, s3=low - 2 * (high - p),
    )


def fibonacci_retracements(swing_high: float, swing_low: float, uptrend: bool = True) -> dict[str, float]:
    """
    Retracement levels for the last impulse leg.

    0.5 is included despite not being a Fibonacci ratio — it is the most
    respected level in practice, which is the only thing that matters here.
    """
    diff = swing_high - swing_low
    ratios = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0]
    if uptrend:
        return {f"{r:.3f}": swing_high - diff * r for r in ratios}
    return {f"{r:.3f}": swing_low + diff * r for r in ratios}


def fibonacci_extensions(swing_high: float, swing_low: float, uptrend: bool = True) -> dict[str, float]:
    diff = swing_high - swing_low
    ratios = [1.272, 1.618, 2.0, 2.618]
    if uptrend:
        return {f"{r:.3f}": swing_high + diff * (r - 1.0) for r in ratios}
    return {f"{r:.3f}": swing_low - diff * (r - 1.0) for r in ratios}


# ─────────────────────────────────────────────────────────────────
#  Bundle
# ─────────────────────────────────────────────────────────────────


def compute_all(df: pd.DataFrame) -> dict[str, pd.Series]:
    """
    Every indicator the factor engine consumes, computed once per request.

    Returns a flat dict of aligned Series so downstream code can grab the last
    value without recomputing. ``df`` must have columns
    ``open, high, low, close, volume`` and be sorted ascending by time.
    """
    close = df["close"]
    macd_r = macd(close)
    stoch = stochastic(df)
    adx_r = adx(df)
    bb = bollinger(close)
    st = supertrend(df)
    ich = ichimoku(df)

    return {
        # trend
        "sma_20": sma(close, 20),
        "sma_50": sma(close, 50),
        "sma_200": sma(close, 200),
        "ema_9": ema(close, 9),
        "ema_20": ema(close, 20),
        "ema_50": ema(close, 50),
        "ema_200": ema(close, 200),
        "supertrend": st.line,
        "supertrend_dir": st.direction,
        "psar": parabolic_sar(df),
        "adx": adx_r.adx,
        "plus_di": adx_r.plus_di,
        "minus_di": adx_r.minus_di,
        "ichimoku_tenkan": ich.tenkan,
        "ichimoku_kijun": ich.kijun,
        "ichimoku_senkou_a": ich.senkou_a,
        "ichimoku_senkou_b": ich.senkou_b,
        # momentum
        "rsi": rsi(close),
        "macd": macd_r.macd,
        "macd_signal": macd_r.signal,
        "macd_hist": macd_r.histogram,
        "stoch_k": stoch.k,
        "stoch_d": stoch.d,
        "cci": cci(df),
        "williams_r": williams_r(df),
        "roc": roc(close),
        # volatility
        "atr": atr(df),
        "atr_percent": atr_percent(df),
        "bb_upper": bb.upper,
        "bb_middle": bb.middle,
        "bb_lower": bb.lower,
        "bb_bandwidth": bb.bandwidth,
        "bb_percent_b": bb.percent_b,
        "squeeze": bollinger_squeeze(df).astype(float),
        "hist_vol": historical_volatility(close),
        # volume
        "obv": obv(df),
        "mfi": money_flow_index(df),
        "cmf": chaikin_money_flow(df),
        "vwap": vwap(df),
        "volume_sma_20": sma(df["volume"], 20),
        "volume_ratio": volume_ratio(df),
    }


def last_valid(series: pd.Series | None) -> float | None:
    """Most recent non-NaN value, or None. Every read-out goes through this."""
    if series is None or len(series) == 0:
        return None
    cleaned = series.dropna()
    if cleaned.empty:
        return None
    value = float(cleaned.iloc[-1])
    return value if np.isfinite(value) else None
