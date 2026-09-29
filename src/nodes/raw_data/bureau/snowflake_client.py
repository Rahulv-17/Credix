"""Snowflake L3 source for the bureau read-through resolver.

Runs the same join the app's pre-processing uses
(../pre-processing/complete_by_mobile.sql): the PII anchor LEFT JOINed to the
8 feature tables on ID, plus the MOBILE-keyed NOHIT_DATA / UNSCRUBBED_DATA, all
collapsed into a single JSON object via OBJECT_CONSTRUCT(*).

This module is import-side-effect free: env loading, the default connection
name, and connecting all happen lazily inside ``connect()``. The interactive
CLI that used to live here is now ``scripts/fetch_bureau_profile.py``.

AUTH (one-time)
---------------
    bash setup_keypair.sh          # generates keys/ + the connections.toml entry
    #   ALTER USER SURAJ SET RSA_PUBLIC_KEY='<keys/rsa_key.pub body>';

Connection comes from ~/.snowflake/connections.toml [bureau_jwt] by default
(override with SNOWFLAKE_CONNECTION_NAME).
"""

import json
import logging
import os

import snowflake.connector

logger = logging.getLogger(__name__)

# Credentials come from the repo-root .env (four levels up from this module).
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))


def load_dotenv(path):
    """Minimal .env loader (no dependency). Existing env vars win."""
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def connect(connection_name: str | None = None):
    """Build a Snowflake connection from .env, in priority order:

    1. PAT  -> SNOWFLAKE_PAT (used as password; no browser, no MFA)
    2. JWT  -> SNOWFLAKE_PRIVATE_KEY_FILE (key-pair; no browser, never expires)
    3. fall back to a named connections.toml profile.

    Env is loaded lazily here (repo-root .env) so importing this module does
    nothing; ``connection_name`` defaults to ``$SNOWFLAKE_CONNECTION_NAME`` read
    at call time, so a runtime env change is honored.
    """
    load_dotenv(os.path.join(_ROOT, ".env"))
    if connection_name is None:
        connection_name = os.getenv("SNOWFLAKE_CONNECTION_NAME", "bureau_jwt")
    base = {
        "account": os.getenv("SNOWFLAKE_ACCOUNT"),
        "user": os.getenv("SNOWFLAKE_USER"),
        "role": os.getenv("SNOWFLAKE_ROLE"),
        "warehouse": os.getenv("SNOWFLAKE_WAREHOUSE"),
        "database": os.getenv("SNOWFLAKE_DATABASE"),
        "schema": os.getenv("SNOWFLAKE_SCHEMA"),
    }
    pat = os.getenv("SNOWFLAKE_PAT")
    password = os.getenv("SNOWFLAKE_PASSWORD")
    key_file = os.getenv("SNOWFLAKE_PRIVATE_KEY_FILE")

    if pat and base["account"] and base["user"]:
        logger.debug("snowflake auth: PAT (.env)")
        return snowflake.connector.connect(
            password=pat, **{k: v for k, v in base.items() if v}
        )
    if password and base["account"] and base["user"]:
        # The app's original proven path: username + password, no browser.
        logger.debug("snowflake auth: password (.env)")
        return snowflake.connector.connect(
            password=password, **{k: v for k, v in base.items() if v}
        )
    if key_file and base["account"] and base["user"]:
        logger.debug("snowflake auth: key-pair / JWT (.env)")
        params = {k: v for k, v in base.items() if v}
        params["authenticator"] = "SNOWFLAKE_JWT"
        params["private_key_file"] = key_file
        if os.getenv("SNOWFLAKE_PRIVATE_KEY_PWD"):
            params["private_key_file_pwd"] = os.environ["SNOWFLAKE_PRIVATE_KEY_PWD"]
        return snowflake.connector.connect(**params)

    logger.debug("snowflake auth: connections.toml [%s]", connection_name)
    return snowflake.connector.connect(connection_name=connection_name)


# Complete profile keyed on MOBILE. Mirrors ../pre-processing/complete_by_mobile.sql
# but parameterised (%(mobile)s bind) and without the snow-CLI `USE`/`SET` lines —
# role / warehouse / db / schema all come from the connection profile.
SQL_BY_MOBILE = """
WITH anchor AS (
    SELECT * FROM PII WHERE MOBILE = %(mobile)s LIMIT 1
),
nohit AS (
    SELECT MOBILE,
           NAME AS NOHIT_NAME, EMAIL AS NOHIT_EMAIL, PAN AS NOHIT_PAN,
           CITY AS NOHIT_CITY, STATE AS NOHIT_STATE,
           EMPLOYMENT_TYPE AS NOHIT_EMPLOYMENT_TYPE, INCOME AS NOHIT_INCOME,
           SCORE AS NOHIT_SCORE, SOURCE AS NOHIT_SOURCE, BUREAU_NOHIT
    FROM NOHIT_DATA WHERE MOBILE = %(mobile)s
    QUALIFY ROW_NUMBER() OVER (PARTITION BY MOBILE ORDER BY SCORE DESC NULLS LAST) = 1
),
unscr AS (
    SELECT MOBILE,
           NAME AS UNSCR_NAME, EMAIL AS UNSCR_EMAIL, PAN AS UNSCR_PAN,
           CITY AS UNSCR_CITY, STATE AS UNSCR_STATE,
           EMPLOYMENT_TYPE AS UNSCR_EMPLOYMENT_TYPE, INCOME AS UNSCR_INCOME,
           SCORE AS UNSCR_SCORE, SOURCE AS UNSCR_SOURCE
    FROM UNSCRUBBED_DATA WHERE MOBILE = %(mobile)s
    QUALIFY ROW_NUMBER() OVER (PARTITION BY MOBILE ORDER BY SCORE DESC NULLS LAST) = 1
)
SELECT OBJECT_CONSTRUCT(*) AS user_profile
FROM (
    SELECT
        pii.*,
        gi.*   EXCLUDE (ID),
        enq.*  EXCLUDE (ID),
        dpd.*  EXCLUDE (ID),
        ld.*   EXCLUDE (ID),
        lp.*   EXCLUDE (ID),
        lr.*   EXCLUDE (ID),
        bw.*   EXCLUDE (ID),
        inst.* EXCLUDE (ID),
        nohit.* EXCLUDE (MOBILE),
        unscr.* EXCLUDE (MOBILE)
    FROM            anchor                  AS pii
    LEFT JOIN       GENERAL_INFO            AS gi    ON gi.ID   = pii.ID
    LEFT JOIN       ENQUIRY                 AS enq   ON enq.ID  = pii.ID
    LEFT JOIN       DPD                     AS dpd   ON dpd.ID  = pii.ID
    LEFT JOIN       LOAN_DETAILS            AS ld    ON ld.ID   = pii.ID
    LEFT JOIN       LOAN_PATTERN            AS lp    ON lp.ID   = pii.ID
    LEFT JOIN       LOAN_REPAYMENT          AS lr    ON lr.ID   = pii.ID
    LEFT JOIN       BORROWING_WINDOW        AS bw    ON bw.ID   = pii.ID
    LEFT JOIN       INSTITUTION_DETAILS     AS inst  ON inst.ID = pii.ID
    LEFT JOIN       nohit                            ON nohit.MOBILE = pii.MOBILE
    LEFT JOIN       unscr                            ON unscr.MOBILE = pii.MOBILE
)
"""

# Resolve a bureau ID from PII by ID / PAN / MOBILE, then join the 9 core tables.
SQL_BY_ID = """
WITH anchor AS (
    SELECT * FROM PII
    WHERE ( %(id)s     IS NOT NULL AND ID     = %(id)s )
       OR ( %(pan)s    IS NOT NULL AND PAN    = %(pan)s )
       OR ( %(mobile)s IS NOT NULL AND MOBILE = %(mobile)s )
    LIMIT 1
)
SELECT OBJECT_CONSTRUCT(*) AS user_profile
FROM (
    SELECT
        pii.*,
        gi.*   EXCLUDE (ID), enq.*  EXCLUDE (ID), dpd.*  EXCLUDE (ID),
        ld.*   EXCLUDE (ID), lp.*   EXCLUDE (ID), lr.*   EXCLUDE (ID),
        bw.*   EXCLUDE (ID), inst.* EXCLUDE (ID)
    FROM            anchor              AS pii
    LEFT JOIN       GENERAL_INFO        AS gi    ON gi.ID   = pii.ID
    LEFT JOIN       ENQUIRY             AS enq   ON enq.ID  = pii.ID
    LEFT JOIN       DPD                 AS dpd   ON dpd.ID  = pii.ID
    LEFT JOIN       LOAN_DETAILS        AS ld    ON ld.ID   = pii.ID
    LEFT JOIN       LOAN_PATTERN        AS lp    ON lp.ID   = pii.ID
    LEFT JOIN       LOAN_REPAYMENT      AS lr    ON lr.ID   = pii.ID
    LEFT JOIN       BORROWING_WINDOW    AS bw    ON bw.ID   = pii.ID
    LEFT JOIN       INSTITUTION_DETAILS AS inst  ON inst.ID = pii.ID
)
"""

# Highest-score user with a real name. Mirrors ../pre-processing/_top_user.sql.
SQL_TOP = """
WITH top_id AS (
    SELECT gi.ID
    FROM GENERAL_INFO gi
    JOIN PII p ON p.ID = gi.ID
    WHERE gi.SCORE IS NOT NULL AND p.APPLICANT_NAME IS NOT NULL
    ORDER BY gi.SCORE DESC
    LIMIT 1
)
SELECT OBJECT_CONSTRUCT(*) AS user_profile
FROM (
    SELECT
        pii.*,
        gi.*   EXCLUDE (ID), enq.*  EXCLUDE (ID), dpd.*  EXCLUDE (ID),
        ld.*   EXCLUDE (ID), lp.*   EXCLUDE (ID), lr.*   EXCLUDE (ID),
        bw.*   EXCLUDE (ID), inst.* EXCLUDE (ID)
    FROM            top_id              AS t
    JOIN            PII                 AS pii   ON pii.ID  = t.ID
    LEFT JOIN       GENERAL_INFO        AS gi    ON gi.ID   = t.ID
    LEFT JOIN       ENQUIRY             AS enq   ON enq.ID  = t.ID
    LEFT JOIN       DPD                 AS dpd   ON dpd.ID  = t.ID
    LEFT JOIN       LOAN_DETAILS        AS ld    ON ld.ID   = t.ID
    LEFT JOIN       LOAN_PATTERN        AS lp    ON lp.ID   = t.ID
    LEFT JOIN       LOAN_REPAYMENT      AS lr    ON lr.ID   = t.ID
    LEFT JOIN       BORROWING_WINDOW    AS bw    ON bw.ID   = t.ID
    LEFT JOIN       INSTITUTION_DETAILS AS inst  ON inst.ID = t.ID
)
"""


def fetch_scrub_row(mobile: str) -> dict | None:
    """L3 read-through hook: return the flat OBJECT_CONSTRUCT row for ``mobile``.

    Used by ``resolver.ProfileResolver`` on an L1/L2 miss. Returns ``None`` when
    the mobile has no bureau row.
    """
    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute(SQL_BY_MOBILE, {"mobile": str(mobile)})
        row = cur.fetchone()
    finally:
        conn.close()
    if not row or row[0] is None:
        return None
    return json.loads(row[0]) if isinstance(row[0], str) else row[0]
