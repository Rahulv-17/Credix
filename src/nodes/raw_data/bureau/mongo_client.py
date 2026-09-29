"""L2 storage — MongoDB audit + source-of-truth bureau docs.

``MongoRepo`` persists the full categorized doc (incl. PII) keyed by
``{user_id}:{scrub_month}`` and serves the latest-month lookup for the
read-through resolver. The PII-stripped serving cache lives in
``cache_client.CacheRepo`` (L1).
"""

from pymongo import ASCENDING, DESCENDING, MongoClient


class MongoRepo:
    def __init__(
        self, client: MongoClient, db_name: str, collection: str = "bureau_data"
    ):
        self.c = client[db_name][collection]
        # _id is unique by construction; this index serves latest-month lookups.
        self.c.create_index([("user_id", ASCENDING), ("scrub_month", DESCENDING)])

    def latest(self, user_id: str):
        return self.c.find_one({"user_id": user_id}, sort=[("scrub_month", DESCENDING)])

    def upsert(self, doc: dict) -> dict:
        user_id = doc["user_id"]
        month = doc["_meta"]["scrub_month"]
        rec = {
            "_id": f"{user_id}:{month}",
            "user_id": user_id,
            "scrub_month": month,
            "fetched_at": doc["_meta"]["fetched_at"],
            "data": doc,
        }
        self.c.replace_one({"_id": rec["_id"]}, rec, upsert=True)
        return doc
