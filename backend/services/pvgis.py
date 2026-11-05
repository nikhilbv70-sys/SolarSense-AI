from .common import (
    DEFAULT_TIMEOUT_SECONDS,
    STATUS_CONNECTED,
    ValidationError,
    cached,
    get_json,
    validate_coordinates,
)
from .data_normalizer import make_record

SOURCE = "PVGIS"
BASE_URL = "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc"
CACHE_TTL_SECONDS = 86400
MIN_TILT, MAX_TILT = 0, 90


def fetch(latitude, longitude, peak_power_kw=1.0, tilt=35, azimuth=0, loss_percent=14):
    lat, lon = validate_coordinates(latitude, longitude)
    try:
        peak = float(peak_power_kw)
        tilt_value = float(tilt)
        azimuth_value = float(azimuth)
        loss = float(loss_percent)
    except (TypeError, ValueError):
        raise ValidationError("PV system inputs must be numbers.")
    if not 0 < peak <= 10000:
        raise ValidationError("Peak power must be between 0 and 10000 kWp.")
    if not MIN_TILT <= tilt_value <= MAX_TILT:
        raise ValidationError("Tilt must be between 0 and 90 degrees.")
    if not -180 <= azimuth_value <= 180:
        raise ValidationError("Azimuth must be between -180 and 180 degrees.")
    if not 0 <= loss <= 100:
        raise ValidationError("System loss must be between 0 and 100 percent.")

    key = ("pvgis", lat, lon, peak, tilt_value, azimuth_value, loss)

    def load():
        payload = get_json(BASE_URL, {
            "lat": lat,
            "lon": lon,
            "peakpower": peak,
            "loss": loss,
            "angle": tilt_value,
            "aspect": azimuth_value,
            "outputformat": "json",
        }, timeout=DEFAULT_TIMEOUT_SECONDS)
        return _normalize(payload, lat, lon)

    records, totals = cached(key, CACHE_TTL_SECONDS, load)
    return {
        "source": SOURCE,
        "status": STATUS_CONNECTED,
        "location": {"latitude": lat, "longitude": lon},
        "records": records,
        "totals": totals,
        "attribution": "PVGIS, European Commission JRC (re.jrc.ec.europa.eu)",
    }


def _normalize(payload, lat, lon):
    location = {"latitude": lat, "longitude": lon}
    outputs = (payload or {}).get("outputs", {})
    monthly = outputs.get("monthly", {}).get("fixed", [])
    records = []
    for row in monthly:
        month = int(row.get("month", 0))
        records.append(make_record(SOURCE, location, None, "E_m", row.get("E_m"), "kWh/month",
                                   {"month": month, "typical_year": True}))
        records.append(make_record(SOURCE, location, None, "H(i)_m", row.get("H(i)_m"), "kWh/m2/month",
                                   {"month": month, "typical_year": True}))
    fixed_totals = outputs.get("totals", {}).get("fixed", {})
    totals = {
        "annual_energy_kwh": fixed_totals.get("E_y"),
        "annual_irradiation_kwh_m2": fixed_totals.get("H(i)_y"),
        "system_loss_percent": fixed_totals.get("SL_total"),
    }
    return records, totals
