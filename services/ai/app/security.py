"""Service-to-service authentication."""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from .config import settings


async def require_service_token(authorization: str | None = Header(default=None)) -> None:
    """
    Verify the shared bearer token.

    This service is never exposed publicly — only the NestJS API talks to it —
    so a shared secret is sufficient and avoids a second JWT verification path.
    Compared with `hmac.compare_digest` so the check doesn't leak the token
    through timing.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = authorization.split(" ", 1)[1].strip()
    if not hmac.compare_digest(token, settings.ai_service_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid service token")
