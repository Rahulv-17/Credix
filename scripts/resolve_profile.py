#!/usr/bin/env python3
"""CLI for the bureau read-through resolver.

python scripts/resolve_profile.py 9944003361
python scripts/resolve_profile.py 9944003361 --path '$.loan_details.PL'
python scripts/resolve_profile.py 9944003361 --id   # print user_id, no I/O
"""

import argparse
import json
import os
import sys

# Make src/ (nodes) and the repo root (config) importable when run
# without `pip install -e .`.
_ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(_ROOT, "src"))
sys.path.insert(0, _ROOT)

from config.settings import load_env  # noqa: E402

load_env()  # populate MONGODB_URI / REDIS_URL before building clients

import redis  # noqa: E402
from pymongo import MongoClient  # noqa: E402

from nodes.raw_data.bureau.cache_client import CacheRepo  # noqa: E402
from nodes.raw_data.bureau.mongo_client import MongoRepo  # noqa: E402
from nodes.raw_data.bureau.normalizer import Normalizer  # noqa: E402
from nodes.raw_data.bureau.resolver import ProfileResolver  # noqa: E402
from nodes.raw_data.bureau.snowflake_client import (  # noqa: E402
    fetch_scrub_row,
)
from nodes.raw_data.bureau.tokenizer import mobile_to_user_id  # noqa: E402

CONFIG = os.path.join(os.path.dirname(__file__), "..", "config", "scrub_mapping.yaml")


def build_resolver() -> ProfileResolver:
    # protocol=2: Pogocache rejects the RESP3 HELLO handshake redis-py 8 sends.
    client = redis.Redis.from_url(
        os.environ["REDIS_URL"], decode_responses=True, protocol=2
    )
    redis_repo = CacheRepo(client, ttl=int(os.getenv("REDIS_TTL", "86400")))
    mongo_repo = MongoRepo(
        MongoClient(os.environ["MONGODB_URI"]), os.getenv("MONGODB_DB", "consumer")
    )
    fresh_days = int(os.getenv("BUREAU_FRESH_DAYS", "15"))
    return ProfileResolver(
        redis_repo, mongo_repo, fetch_scrub_row, Normalizer(CONFIG), fresh_days
    )


def main() -> None:
    p = argparse.ArgumentParser(description="Resolve a bureau profile by mobile.")
    p.add_argument("mobile")
    p.add_argument(
        "--path",
        default="$",
        help="dot-path slice (Python-side), e.g. 'loan_details.PL' or '$.dpd'",
    )
    p.add_argument(
        "--id", action="store_true", help="Print the user_id (10-digit) and exit."
    )
    args = p.parse_args()

    if args.id:
        print(mobile_to_user_id(args.mobile))
        return

    resolver = build_resolver()
    doc, source = resolver.resolve(args.mobile)
    user_id = mobile_to_user_id(args.mobile)
    if doc is None:
        print(json.dumps({"error": f"no profile for {args.mobile}"}))
        sys.exit(1)

    print(f"# source: {source}  id: {user_id}", file=sys.stderr)
    out = doc
    if args.path and args.path != "$":
        # Walk the dict in Python (no server-side JSONPath on a plain cache).
        for key in args.path.lstrip("$").lstrip(".").split("."):
            if not key:
                continue
            out = out.get(key) if isinstance(out, dict) else None
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
