"""UserStoryStore — two-layer (cache L1 -> Mongo L2) read-through.

Both layers faked, so this runs with no live cache or Mongo.
"""

from nodes.raw_data.user_story import SIGNALS_VERSION, UserStoryStore
from nodes.raw_data.user_story.store import STORY_KEY

USER = "9944003361"
DOC = {
    "general_info": {
        "score": 810,
        "credit_history_length": 180,
        "foir": 35,
        "salary": 90000,
    },
    "pii": {"age": 39, "pan": "ABCDE1234F"},
    "loan_details": {"PL": {"all": 3, "active": 1}, "totals": {"all": 16, "active": 1}},
}


class FakeRESP:
    def __init__(self):
        self.store = {}
        self.ex = {}

    def ping(self):
        return True

    def set(self, key, value, ex=None):
        self.store[key] = value
        self.ex[key] = ex

    def get(self, key):
        return self.store.get(key)


class FakeCol:
    def __init__(self):
        self.docs = {}

    def replace_one(self, flt, doc, upsert=False):
        self.docs[flt["_id"]] = doc

    def find_one(self, flt):
        return self.docs.get(flt["_id"])


def _store():
    return UserStoryStore(FakeRESP(), FakeCol(), ttl=120)


def test_materialize_writes_both_layers():
    s = _store()
    payload = s.materialize(USER, DOC)
    # L2 durable
    assert s.col.docs[USER]["signals_version"] == SIGNALS_VERSION
    # L1 cache
    assert STORY_KEY.format(USER) in s.r.store
    assert s.r.ex[STORY_KEY.format(USER)] == 120
    # payload shape
    assert payload["user_story"] is None  # prose deferred
    assert payload["signals"]["segment"] == "super_prime"
    assert "computed_at" in payload
    # PII never persisted
    assert "ABCDE1234F" not in s.r.store[STORY_KEY.format(USER)]


def test_get_reads_from_l1():
    s = _store()
    s.materialize(USER, DOC)
    got = s.get(USER)
    assert got["signals"]["segment"] == "super_prime"


def test_get_rewarms_l1_from_l2_on_cache_miss():
    s = _store()
    s.materialize(USER, DOC)
    s.r.store.clear()  # evict L1 only; L2 still holds it
    got = s.get(USER)
    assert got is not None
    assert got["signals_version"] == SIGNALS_VERSION
    assert STORY_KEY.format(USER) in s.r.store  # re-warmed
    assert "_id" not in got  # mongo _id stripped from returned payload


def test_get_absent_returns_none():
    assert _store().get("0000000000") is None
