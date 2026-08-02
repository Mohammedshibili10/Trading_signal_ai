"""
Outbound HTTP with a trust store that works on real machines.

httpx verifies against certifi's bundle, which is correct on a plain internet
connection and wrong on the many that are not: corporate proxies, antivirus TLS
inspection and captive networks all re-sign traffic with a root that is
installed in the *operating system's* store and will never be in certifi. On
those machines every outbound call fails with CERTIFICATE_VERIFY_FAILED even
though the browser and curl on the same box work fine.

So the context is chosen in this order:

1. ``AI_CA_BUNDLE`` / ``SSL_CERT_FILE`` — an explicit bundle always wins.
2. The OS trust store, via ``truststore`` when it is installed. This is the
   case that fixes TLS interception, because the interception root is in the
   OS store by definition — that is how it was made to work at all.
3. certifi, httpx's default.

Verification is never disabled. A silent downgrade to plaintext-equivalent
security is worse than a failed request, because the failure is at least
visible.
"""

from __future__ import annotations

import logging
import os
import ssl
from functools import lru_cache

import httpx

log = logging.getLogger(__name__)


@lru_cache
def _context() -> ssl.SSLContext | None:
    """Build the verification context once. None means "use httpx's default"."""
    bundle = os.environ.get("AI_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE")
    if bundle and os.path.isfile(bundle):
        log.info("TLS: verifying against %s", bundle)
        return ssl.create_default_context(cafile=bundle)

    try:
        import truststore

        log.info("TLS: verifying against the OS trust store")
        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except ImportError:
        # Not installed — fine on a network that isn't intercepting TLS.
        return None
    except Exception:  # noqa: BLE001
        log.warning("TLS: OS trust store unavailable, falling back to certifi", exc_info=True)
        return None


def async_client(timeout: float, **kwargs) -> httpx.AsyncClient:
    """An AsyncClient configured with the best available trust store."""
    context = _context()
    if context is not None:
        kwargs["verify"] = context
    return httpx.AsyncClient(timeout=timeout, **kwargs)


def tls_backend() -> str:
    """Which trust store is in use. Surfaced by the health endpoint."""
    bundle = os.environ.get("AI_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE")
    if bundle and os.path.isfile(bundle):
        return f"bundle:{os.path.basename(bundle)}"
    try:
        import truststore  # noqa: F401

        return "os-trust-store"
    except ImportError:
        return "certifi"
