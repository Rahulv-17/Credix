"""Flat Snowflake row -> categorized JSON, driven by config/scrub_mapping.yaml.

The Snowflake OBJECT_CONSTRUCT row is a flat dict with UPPERCASE keys
(``SCORE``, ``PL_OUTSTANDING``, ``<30DPD_1mon`` ...). ``_index`` upper-cases
every key so the mixed-case YAML candidates resolve via a case-insensitive
lookup. Product blocks that are entirely null are dropped, so sparse users
(missing ``*_HIGHEST_INTEREST_RATE`` etc.) categorize cleanly.
"""

import re
from datetime import UTC, datetime

import yaml


class Normalizer:
    def __init__(self, config_path: str):
        with open(config_path, encoding="utf-8") as fh:
            self.cfg = yaml.safe_load(fh)
        self.products = self.cfg["products"]
        self._dispatch = {
            "scalar": self._scalar_section,
            "product": self._product_section,
            "institution": self._institution_section,
            "dpd": self._dpd_section,
        }

    @staticmethod
    def _index(flat: dict) -> dict:
        return {str(k).upper(): v for k, v in flat.items()}

    @staticmethod
    def _first(idx: dict, *candidates):
        for c in candidates:
            v = idx.get(c.upper())
            if v is not None:
                return v
        return None

    def _scalar_section(self, idx, sec):
        out = {}
        for out_key, col in sec["fields"].items():
            if isinstance(col, list):
                vals = [self._first(idx, c) for c in col]
                out[out_key] = (
                    [v for v in vals if v is not None] if len(col) > 1 else vals[0]
                )
            else:
                out[out_key] = self._first(idx, col)
        return out

    def _product_section(self, idx, sec):
        out = {}
        for p in sec.get("products", self.products):
            block = {}
            for out_key, suffixes in sec["metrics"].items():
                suffixes = suffixes if isinstance(suffixes, list) else [suffixes]
                block[out_key] = self._first(idx, *[f"{p}_{s}" for s in suffixes])
            for out_key, suffix in sec.get("extra", {}).get(p, {}).items():
                block[out_key] = self._first(idx, f"{p}_{suffix}")
            if any(v is not None for v in block.values()):
                out["totals" if p == "Total" else p] = block
        return out

    def _institution_section(self, idx, sec):
        out = {}
        for p in sec["products"]:
            raw = self._first(idx, f"{p}_{sec['suffix']}")
            if raw is None:
                continue
            parsed = {k: int(v) for k, v in re.findall(r"([A-Z]+)(\d+)", str(raw))}
            out["totals" if p == "Total" else p] = {"raw": raw, "parsed": parsed}
        return out

    def _dpd_section(self, idx, sec):
        buckets = {}
        for bkey, spec in sec["buckets"].items():
            buckets[bkey] = {
                mkey: self._first(
                    idx, *[f"{pre}_{msuf}" for pre in spec["prefix_aliases"]]
                )
                for mkey, msuf in sec["months"].items()
            }
        pl = {k: self._first(idx, col) for k, col in sec["pl_fields"].items()}
        return {"buckets": buckets, "PL": pl}

    def transform(self, flat: dict, user_id: str) -> dict:
        idx = self._index(flat)
        doc = {
            "user_id": user_id,
            "_meta": {
                "scrub_month": self._first(idx, "Scrub_month"),
                "bureau": self._first(idx, "Bureau"),
                "source_name": self._first(idx, "Source_name"),
                "schema_version": self.cfg["schema_version"],
                "fetched_at": datetime.now(UTC).isoformat(),
            },
        }
        for name, sec in self.cfg["sections"].items():
            doc[name] = self._dispatch[sec["type"]](idx, sec)
        return doc
