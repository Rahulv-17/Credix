"""Bureau resolution error types.

A small, typed hierarchy so callers can tell three outcomes apart:

* a caller mistake (bad mobile number)        -> ``InvalidMobile``
* a storage or source layer failing           -> ``BureauUnavailable``
* a genuine "this user has no record" outcome -> not an error, the client
  returns ``None`` for that case.

Collapsing "no record" and "infra down" into a single ``None`` would make a
Redis outage indistinguishable from a brand new user, so the wrapper raises
``BureauUnavailable`` for infra failures and reserves ``None`` for true misses.
"""


class BureauError(Exception):
    """Base for every bureau resolution failure."""


class InvalidMobile(BureauError, ValueError):
    """Mobile number could not be normalized to a bare 10 digit id."""


class BureauUnavailable(BureauError):
    """A storage or source layer failed (Redis, Mongo, Snowflake, or the lock).

    ``layer`` names the failing component so logs and metrics can attribute the
    outage without parsing the message.
    """

    def __init__(self, layer: str, message: str):
        self.layer = layer
        super().__init__(f"{layer}: {message}")
