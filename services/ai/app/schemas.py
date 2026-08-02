"""
Request/response models.

Requests are strictly validated — the API is the only caller, and a malformed
payload should fail loudly at the boundary rather than surface as a NaN three
modules deep.

Responses are returned as plain dicts built by the engine. The shapes are the
contract documented in apps/web/src/types/index.ts; duplicating them as Pydantic
models here would mean maintaining the same structure in a third place with
nothing checking that the three agree.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

AssetClass = Literal["EQUITY", "FOREX", "CRYPTO", "INVESTMENT"]
#: 3m is included because Binance serves it natively for crypto. Yahoo does not,
#: so it is simply absent for equities and forex rather than being synthesised —
#: a resampled bar is not the same instrument's 3-minute chart.
Timeframe = Literal["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"]
Horizon = Literal["INTRADAY", "SWING", "POSITIONAL", "LONG_TERM"]


class Candle(BaseModel):
    time: int = Field(..., description="Unix seconds, UTC")
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    #: Microstructure, where the venue publishes it (Binance does, on every
    #: kline, at no extra cost). Absent elsewhere, and the engine drops the
    #: order-flow factor rather than estimating it.
    trades: int | None = None
    takerBuyVolume: float | None = None
    quoteVolume: float | None = None

    @field_validator("high")
    @classmethod
    def high_is_highest(cls, v: float, info: Any) -> float:
        low = info.data.get("low")
        if low is not None and v < low:
            raise ValueError("high cannot be below low")
        return v


class OrderBookLevel(BaseModel):
    price: float
    quantity: float


class OrderBookInput(BaseModel):
    """A depth snapshot. Only venues with a real book supply one."""

    bids: list[OrderBookLevel] = Field(default_factory=list)
    asks: list[OrderBookLevel] = Field(default_factory=list)
    lastUpdateId: int = 0
    fetchedAt: str | None = None
    source: str = ""


class NewsInput(BaseModel):
    headline: str
    summary: str = ""
    source: str = ""
    ageHours: float = 0.0


class AnalysisRequest(BaseModel):
    symbol: str
    name: str | None = None
    assetClass: AssetClass = "EQUITY"
    timeframe: Timeframe = "1D"
    candles: list[Candle]
    #: Optional higher-timeframe series for the bias check. Without it the
    #: engine simply omits that adjustment rather than guessing.
    higherTimeframeCandles: list[Candle] | None = None
    news: list[NewsInput] | None = None
    fundamentals: dict[str, Any] | None = None
    #: Live depth, when the venue has one. Feeds the liquidity read with
    #: measured resting size instead of size inferred from swing structure.
    orderBook: OrderBookInput | None = None
    riskPerTradePercent: float = Field(default=1.0, ge=0.1, le=5.0)
    #: Calibration re-runs the pipeline over history — expensive. The API caches
    #: results and refreshes them on a nightly job rather than per request.
    withCalibration: bool = True
    #: Validated factor weights from the review loop. Absent means the engine's
    #: own defaults, which is the correct behaviour until a proposal validates.
    factorWeights: dict[str, float] | None = None

    @field_validator("candles")
    @classmethod
    def enough_candles(cls, v: list[Candle]) -> list[Candle]:
        if len(v) < 20:
            raise ValueError("at least 20 candles are required to analyse")
        return v


class ForecastHistoryRequest(BaseModel):
    symbol: str
    assetClass: AssetClass = "EQUITY"
    timeframe: Timeframe = "1D"
    candles: list[Candle]
    lookback: int = Field(default=30, ge=5, le=200)

    @field_validator("candles")
    @classmethod
    def enough_candles(cls, v: list[Candle]) -> list[Candle]:
        if len(v) < 60:
            raise ValueError("at least 60 candles are required for a forecast history")
        return v


class EconomicEventInput(BaseModel):
    title: str
    importance: str = "MEDIUM"
    #: Hours from now until the event. Negative means it has already happened.
    hoursUntil: float


class ConfluenceRequest(BaseModel):
    """
    Multi-timeframe confirmation.

    `candlesByTimeframe` carries whatever the API could actually fetch. A
    timeframe that is missing or too short simply does not vote — it is never
    filled in from a resampled neighbour, because a 4h bar built from 1h data is
    not what a 4h trader is looking at.
    """

    symbol: str
    assetClass: AssetClass = "EQUITY"
    #: The timeframe the trade would be taken on.
    setupTimeframe: Timeframe = "1D"
    horizon: Horizon = "SWING"
    candlesByTimeframe: dict[str, list[Candle]]

    @field_validator("candlesByTimeframe")
    @classmethod
    def at_least_one(cls, v: dict[str, list[Candle]]) -> dict[str, list[Candle]]:
        if not v:
            raise ValueError("at least one timeframe of candles is required")
        return v


class OpenPositionInput(BaseModel):
    """A position or live signal already on the book, for the correlation check."""

    symbol: str
    assetClass: AssetClass = "EQUITY"
    sector: str | None = None
    action: str = "BUY"
    riskPercent: float = 1.0


class SignalOutcomeInput(BaseModel):
    """One resolved signal, for the learning loop."""

    symbol: str
    timeframe: str
    action: str
    confidence: float
    status: str
    riskRewardRatio: float = 0.0


class ConfluenceSignalRequest(AnalysisRequest):
    """A full analysis, gated on multi-timeframe agreement before it may signal."""

    horizon: Horizon = "SWING"
    candlesByTimeframe: dict[str, list[Candle]] = Field(default_factory=dict)
    #: Upcoming calendar events, so the checklist can refuse to enter ahead of
    #: one. None means "no calendar supplied" and is reported as unverified
    #: rather than silently treated as all-clear.
    economicEvents: list[EconomicEventInput] | None = None
    #: When true a conflicted read downgrades the signal to WAIT rather than
    #: only reducing its confidence.
    enforceConfluence: bool = True

    #: Positions and live signals already open, so a correlated add can be
    #: caught before it is taken rather than after.
    openPositions: list[OpenPositionInput] = Field(default_factory=list)
    #: Daily return series keyed by symbol, for measured correlation. Structural
    #: correlation is used for whatever is missing.
    returnsBySymbol: dict[str, list[float]] | None = None
    #: The realised record — resolved signals this engine actually issued.
    outcomes: list[SignalOutcomeInput] = Field(default_factory=list)
    #: Skip the session gate. Used by backtests, where "now" is meaningless.
    applySessionFilter: bool = True


class BatchSignalRequest(BaseModel):
    """Scan many instruments in one call — used by the scanners and dashboard."""

    items: list[AnalysisRequest]
    minConfidence: float = Field(default=0.0, ge=0.0, le=100.0)
    #: WAIT results are the majority and usually not what a scan wants.
    includeWait: bool = False


class PostMortemRequest(BaseModel):
    """One resolved signal plus the price action that followed it."""

    signal: dict[str, Any]
    candlesAfterEntry: list[Candle] = Field(default_factory=list)
    volatilityPercentile: float | None = None
    volumeRatio: float | None = None
    hadNews: bool = False
    # Bars since the engine cancelled the signal, used to judge whether
    # cancelling was the right call rather than merely a cautious one.
    candlesAfterExit: list[Candle] = Field(default_factory=list)
    healthFindings: list[dict[str, Any]] | None = None
    invalidationReason: str | None = None
    confidenceAtEnd: float | None = None
    entryFilled: bool = True
    target: float | None = None


class AttributionRequest(BaseModel):
    """
    Resolved trades with the factor breakdown recorded at issue.

    `holdout` is kept separate and is never used to fit the proposal — it exists
    solely to test it. Callers that pass an empty holdout get a proposal that is
    explicitly marked unvalidated rather than one that is quietly applied.
    """

    trades: list[dict[str, Any]]
    holdout: list[dict[str, Any]] = Field(default_factory=list)
    postMortems: list[dict[str, Any]] = Field(default_factory=list)
    baseWeights: dict[str, float] | None = None


class InvestmentRequest(BaseModel):
    """One instrument's fundamentals, plus optional context."""

    data: dict[str, Any]
    price: float | None = None
    #: The technical read, used only for entry timing — never for the thesis.
    technical: dict[str, Any] | None = None
    #: Sector peers, for the industry comparison.
    peers: list[dict[str, Any]] = Field(default_factory=list)
    #: When true a company failing the ethical screen is excluded outright
    #: rather than merely scored lower.
    ethicalMode: bool = False


class InvestmentScreenRequest(BaseModel):
    """Rank a universe by investment merit, optionally filtered by style."""

    candidates: list[dict[str, Any]]
    style: str | None = None
    ethicalMode: bool = False
    limit: int = Field(default=25, ge=1, le=100)


class PortfolioHealthRequest(BaseModel):
    holdings: list[dict[str, Any]]
    correlationPenalty: float | None = None


class PrecedentRequest(BaseModel):
    """A candidate setup plus the resolved signals to judge it against."""

    candidate: dict[str, Any]
    history: list[dict[str, Any]] = Field(default_factory=list)
    context: dict[str, Any] | None = None


class RevalidationRequest(BaseModel):
    """A live signal plus a fresh analysis of the same instrument."""

    signal: dict[str, Any]
    current: dict[str, Any]
    price: float | None = None
    economicEvents: list[EconomicEventInput] | None = None
    news: list[dict[str, Any]] | None = None
    marketOpen: bool = True


class PositionSizeRequest(BaseModel):
    capital: float = Field(..., gt=0)
    riskPercent: float = Field(..., gt=0, le=10)
    entry: float = Field(..., gt=0)
    stopLoss: float = Field(..., gt=0)
    target: float | None = None
    lotSize: int | None = None


class MonteCarloRequest(BaseModel):
    tradeReturns: list[float] = Field(..., min_length=5)
    startingCapital: float = Field(..., gt=0)
    simulations: int = Field(default=5000, ge=100, le=50_000)
    horizon: int = Field(default=100, ge=10, le=1000)


class PortfolioRiskRequest(BaseModel):
    holdings: list[dict[str, Any]]
    returnsBySymbol: dict[str, list[float]] | None = None
    benchmarkReturns: list[float] | None = None
    riskFreeRate: float = 6.5


class KellyRequest(BaseModel):
    winRate: float = Field(..., gt=0, lt=1)
    averageWin: float = Field(..., gt=0)
    averageLoss: float = Field(..., gt=0)


class AtrStopRequest(BaseModel):
    entry: float = Field(..., gt=0)
    atr: float = Field(..., gt=0)
    multiplier: float = Field(default=2.0, gt=0, le=10)
    long: bool = True


class TrailingStopRequest(BaseModel):
    entry: float = Field(..., gt=0)
    currentPrice: float = Field(..., gt=0)
    highest: float = Field(..., gt=0)
    atr: float = Field(..., gt=0)
    multiplier: float = Field(default=3.0, gt=0, le=10)
    long: bool = True


class BacktestRequest(BaseModel):
    strategy: dict[str, Any]
    candles: list[Candle]
    symbol: str = ""
    initialCapital: float = Field(default=1_000_000.0, gt=0)
    costBps: float = Field(default=25.0, ge=0, le=200)
    slippageBps: float = Field(default=5.0, ge=0, le=200)


class SentimentRequest(BaseModel):
    items: list[NewsInput]
    symbol: str | None = None


class FundamentalsRequest(BaseModel):
    data: dict[str, Any]


class FundamentalsCompareRequest(BaseModel):
    candidates: list[dict[str, Any]]


class SipRequest(BaseModel):
    monthlyAmount: float = Field(..., gt=0)
    years: int = Field(..., ge=1, le=50)
    expectedReturn: float = Field(..., gt=0, le=40)
    stepUpPercent: float = Field(default=0.0, ge=0, le=50)
    inflationRate: float = Field(default=6.0, ge=0, le=20)


class GoalRequest(BaseModel):
    name: str = "Goal"
    targetAmount: float = Field(..., gt=0)
    currentSavings: float = Field(default=0.0, ge=0)
    years: int = Field(..., ge=1, le=50)
    expectedReturn: float = Field(default=12.0, gt=0, le=40)
    inflationRate: float = Field(default=6.0, ge=0, le=20)


class AssistantRequest(BaseModel):
    question: str = Field(..., min_length=2, max_length=2000)
    symbol: str | None = None
    #: Analysis payload the answer must be grounded in. The assistant is not
    #: permitted to introduce claims that aren't in here.
    context: dict[str, Any] | None = None
    history: list[dict[str, str]] | None = None
