"""Service configuration, read from environment with working defaults."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

#: Repo root, three levels up from this file (app/ → ai/ → services/ → root).
_ROOT = Path(__file__).resolve().parents[3]

#: The monorepo keeps one .env at the root so all three services share it. A
#: local services/ai/.env still wins, because later files override earlier ones
#: — that is what makes per-service overrides possible without a second copy of
#: everything. Both are absolute, so the values found do not depend on which
#: directory uvicorn happened to be started from.
_ENV_FILES = (_ROOT / ".env", Path(__file__).resolve().parents[1] / ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILES, extra="ignore")

    app_name: str = "Trading Intelligence AI Service"
    version: str = "1.0.0"
    ai_port: int = 8000
    log_level: str = "INFO"

    # Shared secret with the NestJS API. The service is never exposed publicly;
    # only the API talks to it.
    ai_service_token: str = "dev-ai-service-token-change-me"

    redis_url: str = "redis://localhost:6379"
    cache_ttl_seconds: int = 60

    # Transformer sentiment. Off by default — pulling FinBERT is a ~440 MB
    # download, and the lexicon model is good enough to develop against.
    enable_finbert: bool = False
    finbert_model: str = "ProsusAI/finbert"
    model_cache_dir: str = "./.model_cache"

    # Optional LLM for prose explanations, via Google Gemini. Without a key the
    # assistant answers from the deterministic factor engine using templates —
    # still fully grounded, just less fluent.
    gemini_api_key: str = ""
    #: A rolling alias, not a pinned version. Google retires numbered models for
    #: new keys — pinning one means the assistant silently degrades to templates
    #: months later with a 404 nobody is watching for. The task here is
    #: rephrasing engine output at temperature 0.25, so a moving target costs
    #: nothing and staying reachable is worth a great deal.
    assistant_model: str = "gemini-flash-latest"
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    assistant_timeout_seconds: float = 25.0

    # ── Engine tuning ────────────────────────────────────────────────
    # Documented in docs/signal-methodology.md. Changing these changes every
    # probability the platform reports, so they are configuration, not magic
    # numbers buried in the code.

    #: Logistic steepness mapping blended score → probability.
    logistic_k: float = 2.2
    #: Confidence is capped here. No market state justifies near-certainty.
    max_confidence: float = 85.0
    #: Below this confidence the engine returns WAIT instead of a trade.
    min_signal_confidence: float = 45.0
    #: Signals below this reward:risk are rejected outright.
    min_risk_reward: float = 1.5
    #: Reject setups whose stop sits further than this from entry.
    max_stop_distance_percent: float = 8.0
    #: Minimum bars before the engine will score anything at all.
    min_bars: int = 60
    #: Walk-forward window used by the calibration pass.
    calibration_window: int = 250
    #: Below this many scored samples, calibration is reported as unavailable.
    calibration_min_samples: int = 100
    #: Confidence floor for the "high confidence" calibration slice.
    high_confidence_threshold: float = 65.0


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
