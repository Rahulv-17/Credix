#!/usr/bin/env bash
# One-time key-pair (JWT) auth setup for the Snowflake bureau fetch.
#
# Generates an RSA key-pair, ensures a [bureau_jwt] entry in
# ~/.snowflake/connections.toml, and prints the ALTER USER statement you run
# once to register the public key. After that: zero browser, zero per-query
# login. Safe to re-run — it won't clobber existing keys.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYS="$HERE/keys"
PRIV="$KEYS/rsa_key.p8"
PUB="$KEYS/rsa_key.pub"
CONN_FILE="$HOME/.snowflake/connections.toml"

# --- connection parameters (match your account) ------------------------------
ACCOUNT="LCQYUHW-QN23838"
USER="SURAJ"
ROLE="BUREAU_DATA_READONLY"
WAREHOUSE="B2C_APP_WH"
DATABASE="BUREAU_DATA"
SCHEMA="BUREAU_DATA"

mkdir -p "$KEYS"

# 1. Generate the key-pair (unencrypted PKCS#8 so fetches need no passphrase).
if [[ -f "$PRIV" ]]; then
    echo "key-pair already exists at $PRIV — keeping it."
else
    echo "generating RSA key-pair..."
    openssl genrsa 2048 2>/dev/null | openssl pkcs8 -topk8 -inform PEM -out "$PRIV" -nocrypt
    openssl rsa -in "$PRIV" -pubout -out "$PUB" 2>/dev/null
    chmod 600 "$PRIV"; chmod 644 "$PUB"
    echo "  private: $PRIV (chmod 600)"
    echo "  public : $PUB"
fi

# 2. Ensure the [bureau_jwt] connection entry exists.
mkdir -p "$HOME/.snowflake"
touch "$CONN_FILE"; chmod 600 "$CONN_FILE"
if grep -q '^\[bureau_jwt\]' "$CONN_FILE"; then
    echo "[bureau_jwt] already in $CONN_FILE — leaving it."
else
    echo "adding [bureau_jwt] to $CONN_FILE"
    cat >> "$CONN_FILE" <<EOF

[bureau_jwt]
account = "$ACCOUNT"
user = "$USER"
authenticator = "SNOWFLAKE_JWT"
private_key_file = "$PRIV"
role = "$ROLE"
warehouse = "$WAREHOUSE"
database = "$DATABASE"
schema = "$SCHEMA"
EOF
fi

# 3. Print the registration statement (run once on Snowflake).
PUBKEY_BODY="$(grep -v 'PUBLIC KEY' "$PUB" | tr -d '\n')"
cat <<EOF

------------------------------------------------------------------------------
NEXT (one time): register the public key on the SURAJ user. Run this on
Snowflake (snowsight worksheet, or 'snow sql -c LCQYUHW-QN23838 -q "..."').
Needs SECURITYADMIN/ACCOUNTADMIN or self-alter privilege:

  ALTER USER $USER SET RSA_PUBLIC_KEY='$PUBKEY_BODY';

Verify, then test the no-browser connection:

  snow connection test -c bureau_jwt
  ../.sfcli/bin/python fetch_bureau_profile.py --top
------------------------------------------------------------------------------
EOF
