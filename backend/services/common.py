import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime

logger = logging.getLogger("solarsense.external")

DEFAULT_TIMEOUT_SECONDS = 15
MAX_DATE_SPAN_DAYS = 3650

STATUS_CONNECTED = "connected"
STATUS_NOT_CONFIGURED = "not_configured"
STATUS_AUTH_REQUIRED = "authentication_required"
STATUS_UNAVAILABLE = "api_unavailable"
STATUS_RATE_LIMITED = "rate_limited"
STATUS_INVALID_REQUEST = "invalid_request"

_cache = {}


class ProviderError(Exception):
    def __init__(self, message, status=STATUS_UNAVAILABLE):
        super().__init__(message)
        self.status = status


class ValidationError(ValueError):
    pass


def cached(key, ttl_seconds, loader):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl_seconds:
        return hit[1]
    value = loader()
    _cache[key] = (now, value)
    return value


def get_json(base_url, params, headers=None, timeout=DEFAULT_TIMEOUT_SECONDS):
    query = urllib.parse.urlencode(params)
    url = f"{base_url}?{query}" if query else base_url
    request_headers = {"Accept": "application/json", "User-Agent": "SolarSenseAI/1.0"}
    request_headers.update(headers or {})
    req = urllib.request.Request(url, headers=request_headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise ProviderError("The provider rejected the API key or access is not granted.", STATUS_AUTH_REQUIRED)
        if error.code == 429:
            raise ProviderError("The provider rate limit was reached. Try again later.", STATUS_RATE_LIMITED)
        if error.code == 400:
            raise ProviderError("The provider rejected the request parameters.", STATUS_INVALID_REQUEST)
        logger.warning("Provider returned HTTP %s for %s", error.code, base_url)
        raise ProviderError(f"The provider returned HTTP {error.code}.", STATUS_UNAVAILABLE)
    except (urllib.error.URLError, TimeoutError, OSError):
        logger.warning("Provider request failed for %s", base_url)
        raise ProviderError("The provider timed out or could not be reached.", STATUS_UNAVAILABLE)
    try:
        return json.loads(body)
    except ValueError:
        raise ProviderError("The provider returned a response that is not valid JSON.", STATUS_UNAVAILABLE)


def validate_coordinates(latitude, longitude):
    try:
        lat = float(latitude)
        lon = float(longitude)
    except (TypeError, ValueError):
        raise ValidationError("Latitude and longitude must be numbers.")
    if not -90 <= lat <= 90:
        raise ValidationError("Latitude must be between -90 and 90.")
    if not -180 <= lon <= 180:
        raise ValidationError("Longitude must be between -180 and 180.")
    return round(lat, 4), round(lon, 4)


def parse_date(value, field_name):
    if not value:
        raise ValidationError(f"{field_name} is required (YYYY-MM-DD).")
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except ValueError:
        raise ValidationError(f"{field_name} must use the format YYYY-MM-DD.")


def validate_date_range(start_value, end_value):
    start = parse_date(start_value, "start")
    end = parse_date(end_value, "end")
    if end < start:
        raise ValidationError("End date must be on or after the start date.")
    if (end - start).days > MAX_DATE_SPAN_DAYS:
        raise ValidationError(f"Date range cannot exceed {MAX_DATE_SPAN_DAYS} days.")
    if end > date.today():
        raise ValidationError("End date cannot be in the future.")
    return start, end


def env_value(name):
    return (os.getenv(name) or "").strip()
