#!/usr/bin/env python3
"""Interactive CLI to fetch a complete bureau profile from Snowflake.

Moved out of ``nodes.raw_data.bureau.snowflake_client`` so that importing the
library module has no side effects. The library keeps ``connect`` and the SQL.

USAGE
-----
    python scripts/fetch_bureau_profile.py 9944003361
    python scripts/fetch_bureau_profile.py --top              # highest-score user
    python scripts/fetch_bureau_profile.py --id BUR_000123
    python scripts/fetch_bureau_profile.py --pan ABCDE1234F
    python scripts/fetch_bureau_profile.py 9944003361 -o out.json

Connection comes from ~/.snowflake/connections.toml [bureau_jwt] by default
(override with --connection NAME or SNOWFLAKE_CONNECTION_NAME).
"""

import argparse
import json
import os
import sys

# Make src/ (nodes) importable when run without `pip install -e .`.
_ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(_ROOT, "src"))

from nodes.raw_data.bureau.snowflake_client import (  # noqa: E402
    SQL_BY_ID,
    SQL_TOP,
    connect,
)


def parse_args():
    p = argparse.ArgumentParser(
        description="Fetch complete bureau profile (~321 vars) from Snowflake."
    )
    p.add_argument("mobile", nargs="?", help="Mobile number to look up.")
    p.add_argument("--id", help="Bureau ID (fast path, the join key).")
    p.add_argument("--pan", help="PAN to look up.")
    p.add_argument(
        "--top",
        action="store_true",
        help="Highest-score user (smoke test, no identifier needed).",
    )
    p.add_argument(
        "--connection",
        default=None,
        help="connections.toml profile (default: $SNOWFLAKE_CONNECTION_NAME).",
    )
    p.add_argument("-o", "--out", help="Write JSON here instead of stdout.")
    return p.parse_args()


def build_query(args):
    if args.top:
        return SQL_TOP, {}
    if args.id or args.pan or args.mobile:
        return SQL_BY_ID, {"id": args.id, "pan": args.pan, "mobile": args.mobile}
    raise SystemExit("error: supply a mobile number, --id, --pan, or --top")


def main():
    args = parse_args()
    sql, binds = build_query(args)

    conn = connect(args.connection)
    try:
        cur = conn.cursor()
        cur.execute(sql, binds)
        row = cur.fetchone()
    finally:
        conn.close()

    if not row or row[0] is None:
        ident = args.id or args.pan or args.mobile or "top-user"
        print(json.dumps({"error": f"No profile found for {ident}"}))
        return

    # OBJECT_CONSTRUCT returns a JSON string; re-parse so we emit real JSON.
    profile = json.loads(row[0]) if isinstance(row[0], str) else row[0]
    text = json.dumps(profile, indent=2, ensure_ascii=False)
    print(f"# variables  : {len(profile)}", file=sys.stderr)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"# written    : {args.out}", file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
