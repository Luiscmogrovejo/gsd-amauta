"""Bridge module: provides Redis client access to pg_store without circular imports.

The daemon imports pg_store, so pg_store cannot import amauta-daemon directly.
This tiny bridge module is imported by both:
  - amauta-daemon.py calls set_redis_client() at startup to inject the client
  - pg_store.py calls get_redis_client() lazily to access Redis for L2 cache

INF-05/TOK-06: Redis L2 embedding cache bridge.
"""

_client = None


def get_redis_client():
    """Return the daemon's Redis client, or None if unavailable."""
    return _client


def set_redis_client(client):
    """Called by the daemon at startup to inject the Redis client."""
    global _client
    _client = client
