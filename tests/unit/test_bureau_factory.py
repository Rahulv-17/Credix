"""Regression guard for the shared ``get_resolver()`` factory wiring.

The 49 bureau unit tests all monkeypatch ``client.get_resolver``, so a broken
import *inside* the real factory (historically ``from ..user_story import
UserStoryStore`` when that module did not exist) stayed invisible: every test
passed while every real ``/internal/bureau/*`` call would have raised
``ModuleNotFoundError``. These tests exercise the real factory, unmocked.

``test_factory_dependency_imports_resolve`` runs everywhere: it imports the exact
modules ``get_resolver()`` pulls in, so the missing-module class of bug fails the
normal suite. ``test_get_resolver_builds_unmocked`` actually calls the factory and
is gated on live services because ``MongoRepo.__init__`` opens a connection
(``create_index``).
"""

import os

import pytest


def test_factory_dependency_imports_resolve():
    """Every module get_resolver() imports must resolve — unmocked, no services."""
    from nodes.raw_data.bureau.cache_client import CacheRepo
    from nodes.raw_data.bureau.mongo_client import MongoRepo
    from nodes.raw_data.bureau.normalizer import Normalizer
    from nodes.raw_data.bureau.resolver import ProfileResolver
    from nodes.raw_data.bureau.snowflake_client import fetch_scrub_row
    from nodes.raw_data.user_story import UserStoryStore

    # Reference each so linters keep the imports and the intent is explicit.
    assert all(
        callable(x)
        for x in (
            CacheRepo,
            MongoRepo,
            Normalizer,
            ProfileResolver,
            fetch_scrub_row,
            UserStoryStore,
        )
    )


def test_get_resolver_builds_once_under_concurrency(monkeypatch):
    """The double-checked lock must build exactly one resolver even when many threads
    race on a cold singleton. get_bureau_profile() runs get_resolver() via to_thread,
    so without the lock each racing thread builds its own resolver + MongoClient."""
    import threading
    import time

    from nodes.raw_data.bureau import factory

    factory._resolver = None
    build_count = 0
    build_lock = threading.Lock()
    sentinel = object()

    def slow_build():
        nonlocal build_count
        # Count under a lock: if the resolver's lock breaks and threads build
        # concurrently, an unguarded += could lose updates and still read 1,
        # hiding the very failure this test exists to catch.
        with build_lock:
            build_count += 1
        # widen the race window; a broken resolver lock would double-build
        time.sleep(0.02)
        return sentinel

    monkeypatch.setattr(factory, "_build_resolver", slow_build)
    try:
        results: list = []
        threads = [
            threading.Thread(target=lambda: results.append(factory.get_resolver()))
            for _ in range(20)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert build_count == 1
        assert len(results) == 20 and all(r is sentinel for r in results)
    finally:
        factory._resolver = None


@pytest.mark.skipif(
    os.getenv("BUREAU_LIVE") != "true",
    reason="needs BUREAU_LIVE=true + live REDIS_URL/MONGODB_URI (MongoRepo connects)",
)
def test_get_resolver_builds_unmocked():
    """Call the real factory end-to-end (no mocks); assert it wires the story store."""
    from nodes.raw_data.bureau import factory
    from nodes.raw_data.bureau.resolver import ProfileResolver

    factory._resolver = None  # reset the module singleton for an honest build
    try:
        resolver = factory.get_resolver()
        assert isinstance(resolver, ProfileResolver)
        assert resolver.story is not None
    finally:
        factory._resolver = None
