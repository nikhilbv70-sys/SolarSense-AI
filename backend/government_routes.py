import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd
from flask import Blueprint, jsonify, session

from auth_roles import GOVERNMENT_ROLES, require_roles

government_bp = Blueprint("government", __name__)

DATA_FILE = Path(__file__).resolve().parent / "data" / "state-wise-installed-capacity.csv"
SOURCE_LABEL = "Government CSV: state-wise installed capacity (MW)"
LIVE_BASE_URL = "https://api.data.gov.in/resource/"
LIVE_TIMEOUT_SECONDS = 15

COLUMN_MAP = {
    "STATES / UTs": "state",
    "Small Hydro Power (MW)": "small_hydro_mw",
    "Wind Power (MW)": "wind_mw",
    "Bio Power Total (MW)": "bio_mw",
    "Solar Power Total (MW)": "solar_mw",
    "Total Capacity (MW)": "total_mw",
}


def _normalise_header(name):
    return " ".join(str(name).split())


def _load_state_capacity():
    frame = pd.read_csv(DATA_FILE, dtype=str, keep_default_na=False)
    frame.columns = [_normalise_header(column) for column in frame.columns]

    def number(value):
        cleaned = str(value).strip()
        if cleaned in ("", "NA", "N/A", "-"):
            return None
        try:
            return float(cleaned.replace(",", ""))
        except ValueError:
            return None

    frame = frame.rename(columns=COLUMN_MAP)
    value_keys = ("small_hydro_mw", "wind_mw", "bio_mw", "solar_mw", "total_mw")

    rows = []
    totals = {}
    for _, record in frame.iterrows():
        state = str(record["state"]).strip()
        if not state:
            continue
        values = {key: number(record[key]) if key in record else None for key in value_keys}
        if state.lower().startswith("total"):
            totals = values
            continue
        rows.append({"state": state, **values})
    return rows, totals


@government_bp.route("/api/government/state-capacity", methods=["GET"])
@require_roles(*GOVERNMENT_ROLES)
def state_capacity():
    try:
        rows, totals = _load_state_capacity()
    except (OSError, ValueError, KeyError) as error:
        return jsonify({"error": "The state capacity CSV could not be read.", "detail": str(error)}), 500
    return jsonify({
        "source": SOURCE_LABEL,
        "unit": "MW",
        "rows": rows,
        "totals": totals,
        "note": "NA values in the source file are shown as null and are not counted as zero.",
    }), 200


@government_bp.route("/api/government/live", methods=["GET"])
@require_roles(*GOVERNMENT_ROLES)
def live_data():
    api_key = (os.getenv("INDIA_RENEWABLE_API_KEY") or "").strip()
    resource_id = (os.getenv("INDIA_RENEWABLE_RESOURCE_ID") or "").strip()
    if not api_key or api_key.startswith("your_"):
        return jsonify({"configured": False, "message": "The government API key is not configured on the server."}), 200
    if not resource_id:
        return jsonify({
            "configured": False,
            "message": "The API key is set, but no dataset resource ID is configured yet.",
        }), 200

    query = urllib.parse.urlencode({"api-key": api_key, "format": "json", "limit": 100})
    url = LIVE_BASE_URL + urllib.parse.quote(resource_id) + "?" + query
    try:
        with urllib.request.urlopen(url, timeout=LIVE_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return jsonify({"configured": True, "error": "The government API returned HTTP " + str(error.code) + "."}), 502
    except (urllib.error.URLError, TimeoutError, ValueError):
        return jsonify({"configured": True, "error": "The government API could not be reached right now."}), 502

    return jsonify({
        "configured": True,
        "source": "Government API (live)",
        "title": payload.get("title"),
        "total": payload.get("total"),
        "fields": payload.get("field", []),
        "records": payload.get("records", []),
    }), 200
