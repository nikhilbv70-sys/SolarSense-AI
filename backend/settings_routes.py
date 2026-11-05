"""Per-user settings API: weather location and default forecast horizon."""
import hmac
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import Blueprint, jsonify, request, session
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from database import DEFAULT_ALERT_THRESHOLD_PCT, DEFAULT_TIMEZONE, ENERGY_UNITS, User, UserSettings, engine
from forecast_routes import DEFAULT_LATITUDE, DEFAULT_LONGITUDE

settings_bp = Blueprint("settings", __name__, url_prefix="/api/settings")
HORIZONS = ("24h", "7d", "30d")


def _valid_csrf():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token", "")
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))


def _default_payload():
    return {
        "latitude": DEFAULT_LATITUDE,
        "longitude": DEFAULT_LONGITUDE,
        "default_horizon": "24h",
        "plant_id": None,
        "timezone": DEFAULT_TIMEZONE,
        "tariff_per_kwh": None,
        "alert_threshold_pct": DEFAULT_ALERT_THRESHOLD_PCT,
        "energy_unit": "kWh",
    }


def _serialise(settings):
    return {
        "latitude": settings.latitude,
        "longitude": settings.longitude,
        "default_horizon": settings.default_horizon,
        "plant_id": settings.plant_id,
        "timezone": settings.timezone,
        "tariff_per_kwh": settings.tariff_per_kwh,
        "alert_threshold_pct": settings.alert_threshold_pct,
        "energy_unit": settings.energy_unit,
    }


def _validate(data):
    try:
        latitude = float(data.get("latitude"))
        longitude = float(data.get("longitude"))
    except (TypeError, ValueError):
        raise ValueError("Latitude and longitude must be numbers.")
    if not -90 <= latitude <= 90:
        raise ValueError("Latitude must be between -90 and 90.")
    if not -180 <= longitude <= 180:
        raise ValueError("Longitude must be between -180 and 180.")
    horizon = data.get("default_horizon", "24h")
    if horizon not in HORIZONS:
        raise ValueError("Default horizon must be 24h, 7d or 30d.")

    timezone_name = str(data.get("timezone") or DEFAULT_TIMEZONE).strip()
    try:
        ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("Timezone must be a valid IANA name such as Asia/Singapore.")

    tariff = data.get("tariff_per_kwh")
    if tariff in (None, ""):
        tariff = None
    else:
        try:
            tariff = float(tariff)
        except (TypeError, ValueError):
            raise ValueError("Tariff must be a number.")
        if tariff < 0:
            raise ValueError("Tariff cannot be negative.")

    try:
        threshold = float(data.get("alert_threshold_pct", DEFAULT_ALERT_THRESHOLD_PCT))
    except (TypeError, ValueError):
        raise ValueError("Alert threshold must be a number.")
    if not 5 <= threshold <= 50:
        raise ValueError("Alert threshold must be between 5% and 50%.")

    energy_unit = data.get("energy_unit", "kWh")
    if energy_unit not in ENERGY_UNITS:
        raise ValueError("Energy unit must be kWh or MWh.")

    plant_id = data.get("plant_id")
    if plant_id in (None, ""):
        plant_id = None
    else:
        try:
            plant_id = int(plant_id)
        except (TypeError, ValueError):
            raise ValueError("Plant must be a valid plant id.")
        with engine.connect() as connection:
            exists = connection.execute(
                text("SELECT 1 FROM solar_plants WHERE id = :plant_id"), {"plant_id": plant_id}
            ).first()
        if exists is None:
            raise ValueError("The selected plant does not exist.")

    return {
        "latitude": round(latitude, 4),
        "longitude": round(longitude, 4),
        "default_horizon": horizon,
        "plant_id": plant_id,
        "timezone": timezone_name,
        "tariff_per_kwh": tariff,
        "alert_threshold_pct": threshold,
        "energy_unit": energy_unit,
    }


@settings_bp.route("/plants", methods=["GET"])
def list_plants():
    if not session.get("user_id"):
        return jsonify({"error": "Sign in to view plants."}), 401
    try:
        with engine.connect() as connection:
            rows = connection.execute(
                text("SELECT id, plant_name, location, capacity_kw FROM solar_plants ORDER BY id")
            ).mappings().all()
    except SQLAlchemyError:
        return jsonify({"error": "Plants could not be loaded from PostgreSQL."}), 500
    return jsonify({"plants": [dict(row) for row in rows]}), 200


@settings_bp.route("", methods=["GET"])
def get_settings():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "Sign in to view settings."}), 401
    try:
        with Session(engine) as db:
            user = db.get(User, user_id)
            settings = db.get(UserSettings, user_id)
            payload = _default_payload() if settings is None else _serialise(settings)
            account = {"full_name": user.full_name, "email": user.email} if user else None
    except SQLAlchemyError:
        return jsonify({"error": "Settings could not be loaded from PostgreSQL."}), 500
    return jsonify({"settings": payload, "account": account}), 200


@settings_bp.route("", methods=["PUT"])
def update_settings():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "Sign in to change settings."}), 401
    if not _valid_csrf():
        return jsonify({"error": "Your session expired. Refresh the page and try again."}), 403
    try:
        values = _validate(request.get_json(silent=True) or {})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    try:
        with Session(engine) as db:
            settings = db.get(UserSettings, user_id)
            if settings is None:
                settings = UserSettings(user_id=user_id)
                db.add(settings)
            for field, value in values.items():
                setattr(settings, field, value)
            settings.updated_at = datetime.now(timezone.utc)
            db.commit()
            payload = _serialise(settings)
    except SQLAlchemyError:
        return jsonify({"error": "Settings could not be saved to PostgreSQL."}), 500
    return jsonify({"settings": payload}), 200
