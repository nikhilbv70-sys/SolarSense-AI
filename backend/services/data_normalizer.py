import math
from datetime import datetime, timezone

MISSING_VALUES = {-999, -999.0}


def clean_value(value):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or number in MISSING_VALUES:
        return None
    return round(number, 4)


def yyyymmdd_to_iso(text):
    return datetime.strptime(str(text), "%Y%m%d").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def make_record(source, location, timestamp, parameter, value, unit, metadata=None):
    return {
        "source": source,
        "location": location,
        "timestamp": timestamp,
        "parameter": parameter,
        "value": clean_value(value),
        "unit": unit,
        "metadata": metadata or {},
    }


def dedupe_records(records):
    seen = set()
    unique = []
    for record in records:
        key = (record["source"], record["location"]["latitude"], record["location"]["longitude"],
               record["timestamp"], record["parameter"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(record)
    return unique
