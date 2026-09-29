# Snowflake bureau fetch — key-pair auth (no browser, no per-query login)

The Snowflake bureau pull is the **~321-variable** complete user profile (the 9
core `BUREAU_DATA` tables joined on `ID`, plus the MOBILE-keyed `NOHIT_DATA` /
`UNSCRUBBED_DATA`, collapsed into one JSON object via `OBJECT_CONSTRUCT(*)`).
The variable catalog is [scrub_variables_320.xlsx](../scrub_variables_320.xlsx);
the canonical SQL lives in [../pre-processing/complete_by_mobile.sql](../pre-processing/complete_by_mobile.sql).

## Why this exists

The existing `~/.snowflake/connections.toml` connection (`LCQYUHW-QN23838`) uses
`authenticator = "OAUTH_AUTHORIZATION_CODE"`, and its token cache holds only
`null` — so a **browser OAuth window opens on every single fetch**.

This folder switches to **key-pair (JWT)** auth: register a public key once, and
every fetch afterward is silent — no browser, no expiry.

## Credentials live in `.env`

`fetch_bureau_profile.py` auto-loads [.env](.env). Auth priority is
**PAT → password → key-pair → connections.toml** — the script uses whichever is
filled in.

> **Current setup: password auth (Option C) — working, browser-free, no admin.**
> This matches the app's original `snowflake_client.py`. Note Snowflake is phasing
> out single-factor passwords (through Oct 2026), so once an admin can act, switch
> to key-pair (Option A) as the durable fix. Until then, password is the answer.

### Option A — Key-pair / JWT  *(recommended: never expires)*

```bash
cd snowflake-fetch
bash setup_keypair.sh           # already done: keys/ exist, .env points at them
```

Register the public key **once** (Snowsight worksheet, or hand to an admin):

```sql
ALTER USER SURAJ SET RSA_PUBLIC_KEY='<body of keys/rsa_key.pub>';
```

`setup_keypair.sh` prints the exact line. After that, every fetch is silent.

### Option B — Programmatic Access Token (PAT)  *(expires ≤ 1 yr)*

Snowsight → your name (bottom-left) → **Settings → Authentication →
Programmatic access tokens → Generate token**. Paste the secret into `.env`:

```
SNOWFLAKE_PAT=<the token>
```

The script prefers PAT over key-pair if both are set.

### Verify

```bash
../.sfcli/bin/python fetch_bureau_profile.py --top
```

## Fetch

```bash
../.sfcli/bin/python fetch_bureau_profile.py 9944003361        # by mobile -> all ~321 vars
../.sfcli/bin/python fetch_bureau_profile.py --top             # highest-score user (smoke test)
../.sfcli/bin/python fetch_bureau_profile.py --id BUR_000123   # by bureau ID (fast path)
../.sfcli/bin/python fetch_bureau_profile.py --pan ABCDE1234F  # by PAN
../.sfcli/bin/python fetch_bureau_profile.py 9944003361 -o profile.json
```

Output is one JSON object of all variables (NULL fields auto-omitted by
`OBJECT_CONSTRUCT`). The connection profile (`[bureau_jwt]`) supplies role /
warehouse / database / schema, so no `USE` statements are needed.

## Files

| File | Purpose |
|------|---------|
| `setup_keypair.sh`        | Generates `keys/`, adds `[bureau_jwt]`, prints the `ALTER USER` line |
| `fetch_bureau_profile.py` | The fetch — by mobile / `--id` / `--pan` / `--top`, JWT auth |
| `keys/rsa_key.p8`         | Private key (chmod 600, gitignored) |
| `keys/rsa_key.pub`        | Public key — its body goes in `ALTER USER ... SET RSA_PUBLIC_KEY` |

## Security notes

- `keys/` and any `*.json` output are **gitignored** — private key and PII never
  get committed.
- The private key is unencrypted so fetches need no passphrase. For an encrypted
  key, generate with `openssl pkcs8 ... -v2 aes-256-cbc` (drop `-nocrypt`) and add
  `private_key_file_pwd` to `[bureau_jwt]`.
- To revoke: `ALTER USER SURAJ UNSET RSA_PUBLIC_KEY;` and delete `keys/`.

## Relationship to the MongoDB path

`../user-fetch-by-mobile` fetches the same user from **MongoDB** (`scrub_profiles`,
already pre-joined, also no per-query login). This Snowflake path is the source of
truth the MongoDB documents are built from.
