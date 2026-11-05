from .common import (
    DEFAULT_TIMEOUT_SECONDS,
    STATUS_CONNECTED,
    cached,
    get_json,
    validate_coordinates,
    validate_date_range,
)
from .data_normalizer import make_record, yyyymmdd_to_iso

SOURCE = "NASA POWER"
BASE_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
DEFAULT_PARAMETERS = ["ALLSKY_SFC_SW_DWN", "T2M", "PRECTOTCORR"]
ALLOWED_PARAMETERS = {"ALLSKY_SFC_SW_DWN", "CLRSKY_SFC_SW_DWN", "T2M", "T2M_MAX", "T2M_MIN", "RH2M", "WS2M", "PRECTOTCORR"}
CACHE_TTL_SECONDS = 3600


def fetch(latitude, longitude, start, end, parameters=None):
    lat, lon = validate_coordinates(latitude, longitude)
    start_date, end_date = validate_date_range(start, end)
    requested = parameters or DEFAULT_PARAMETERS
    unknown = [p for p in requested if p not in ALLOWED_PARAMETERS]
    if unknown:
        from .common import ValidationError
        raise ValidationError(f"Unsupported NASA POWER parameters: {', '.join(unknown)}")

    key = ("nasa", lat, lon, start_date.isoformat(), end_date.isoformat(), tuple(requested))

    def load():
        payload = get_json(BASE_URL, {
            "parameters": ",".join(requested),
            "community": "RE",
            "latitude": lat,
            "longitude": lon,
            "start": start_date.strftime("%Y%m%d"),
            "end": end_date.strftime("%Y%m%d"),
            "format": "JSON",
        }, timeout=DEFAULT_TIMEOUT_SECONDS)
        return _normalize(payload, lat, lon)

    records = cached(key, CACHE_TTL_SECONDS, load)
    return {
        "source": SOURCE,
        "status": STATUS_CONNECTED,
        "location": {"latitude": lat, "longitude": lon},
        "records": records,
        "attribution": "NASA POWER (power.larc.nasa.gov)",
    }


def _normalize(payload, lat, lon):
    block = (payload or {}).get("properties", {}).get("parameter", {})
    headers = (payload or {}).get("parameters", {})
    location = {"latitude": lat, "longitude": lon}
    records = []
    for parameter, series in block.items():
        unit = headers.get(parameter, {}).get("units", "")
        for day, value in series.items():
            records.append(make_record(SOURCE, location, yyyymmdd_to_iso(day), parameter, value, unit))
    records.sort(key=lambda r: (r["parameter"], r["timestamp"]))
    return records
