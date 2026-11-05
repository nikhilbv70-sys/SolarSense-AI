"""Energy forecast API: Open-Meteo weather proxy, hourly model forecast, saved runs and CSV report.

Forecast values are model estimates. They are never presented as measured generation.
"""
import csv
import hmac
import io
import json
import math
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
from flask import Blueprint, Response, jsonify, request, session
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from database import DEFAULT_TIMEZONE, ForecastRun, UserSettings, engine

ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / "models" / "energy_forecast_hourly.joblib"
METRICS_PATH = ROOT / "models" / "energy_forecast_metrics.json"

forecast_bp = Blueprint("forecast", __name__, url_prefix="/api/forecast")

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_PARAMS = {
    "daily": "weather_code,sunrise,sunset,moonrise,daylight_duration,sunshine_duration,"
             "wind_gusts_10m_max,wind_speed_10m_max,uv_index_clear_sky_max,apparent_temperature_min",
    # shortwave_radiation is added to the link you provided; the forecast model needs irradiance.
    "hourly": "temperature_2m,relative_humidity_2m,dew_point_2m,rain,showers,snowfall,"
              "precipitation_probability,precipitation,cloud_cover,cloud_cover_low,cloud_cover_high,"
              "pressure_msl,wind_speed_10m,temperature_80m,vapour_pressure_deficit,visibility,"
              "shortwave_radiation",
    "current": "temperature_2m,apparent_temperature,showers,rain,cloud_cover,pressure_msl,"
               "wind_direction_10m,wind_gusts_10m",
    "past_days": "92",
    "forecast_days": "16",
}
WEATHER_TTL_SECONDS = 1800
HORIZON_HOURS = {"24h": 24, "7d": 168}
HORIZON_LABELS = {"24h": "Next 24 hours", "7d": "Next 7 days", "30d": "Next 30 days"}
DEFAULT_LATITUDE = 22.0
DEFAULT_LONGITUDE = 79.0
LOW_GENERATION_RATIO = 0.5

_weather_cache = {}
_model_bundle = None


class ServiceUnavailable(Exception):
    pass


def _valid_csrf():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token", "")
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))


def _current_user_id():
    return session.get("user_id")


def _parse_coordinate(value, limit, default, name):
    if value in (None, ""):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number.")
    if not math.isfinite(number) or abs(number) > limit:
        raise ValueError(f"{name} must be between -{limit} and {limit}.")
    return round(number, 4)


def _location_from_request(data=None):
    source = data if data is not None else request.args
    lat = source.get("latitude")
    lon = source.get("longitude")
    user_id = _current_user_id()
    if (lat in (None, "") and lon in (None, "")) and user_id:
        with Session(engine) as db:
            saved = db.get(UserSettings, user_id)
            if saved:
                return saved.latitude, saved.longitude
    return (
        _parse_coordinate(lat, 90, DEFAULT_LATITUDE, "latitude"),
        _parse_coordinate(lon, 180, DEFAULT_LONGITUDE, "longitude"),
    )


def _horizon_from(source):
    horizon = (source.get("horizon") or "24h").strip().lower()
    if horizon not in HORIZON_LABELS:
        raise ValueError("horizon must be 24h, 7d or 30d.")
    return horizon


def _saved_timezone():
    user_id = _current_user_id()
    if user_id:
        with Session(engine) as db:
            saved = db.get(UserSettings, user_id)
            if saved and saved.timezone:
                return saved.timezone
    return DEFAULT_TIMEZONE


def fetch_weather(latitude, longitude):
    timezone_name = _saved_timezone()
    key = (round(latitude, 2), round(longitude, 2), timezone_name)
    cached = _weather_cache.get(key)
    if cached and time.time() - cached[0] < WEATHER_TTL_SECONDS:
        return cached[1]

    params = {
        "latitude": f"{latitude:.4f}",
        "longitude": f"{longitude:.4f}",
        **OPEN_METEO_PARAMS,
        "timezone": timezone_name,
    }
    url = OPEN_METEO_URL + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.load(response)
    except Exception as error:
        raise ServiceUnavailable("Open-Meteo weather service could not be reached.") from error
    if "hourly" not in data or "current" not in data:
        raise ServiceUnavailable("Open-Meteo returned an unexpected response.")

    _weather_cache[key] = (time.time(), data)
    return data


def load_model():
    global _model_bundle
    if _model_bundle is None:
        if not MODEL_PATH.exists() or not METRICS_PATH.exists():
            raise ServiceUnavailable("Forecast model files are missing. Run backend/train_forecast.py.")
        _model_bundle = {
            "bundle": joblib.load(MODEL_PATH),
            "metrics": json.loads(METRICS_PATH.read_text(encoding="utf-8")),
        }
    return _model_bundle["bundle"], _model_bundle["metrics"]


def _forecast_rows(weather, hours):
    """Return the next `hours` hourly weather rows, or raise if they are incomplete."""
    hourly = weather["hourly"]
    now_local = datetime.fromisoformat(weather["current"]["time"]).replace(minute=0, second=0, microsecond=0)
    rows = []
    for stamp, irradiance, temperature in zip(
        hourly["time"], hourly["shortwave_radiation"], hourly["temperature_2m"]
    ):
        moment = datetime.fromisoformat(stamp)
        if moment < now_local:
            continue
        rows.append((moment, irradiance, temperature))
        if len(rows) == hours:
            break
    if len(rows) < hours:
        raise ValueError(f"Weather forecast has only {len(rows)} of the {hours} hours needed.")
    if any(irradiance is None or temperature is None for _, irradiance, temperature in rows):
        raise ValueError("Weather forecast has missing irradiance or temperature values for part of the horizon.")
    return rows


def build_forecast(horizon, latitude, longitude):
    model_bundle, metrics = load_model()
    timezone_name = _saved_timezone()
    if horizon not in HORIZON_HOURS:
        return {
            "available": False,
            "horizon": horizon,
            "horizon_label": HORIZON_LABELS[horizon],
            "reason": "The weather forecast source covers 16 days ahead, so a 30-day energy forecast "
                      "would need invented weather. It is not shown.",
            "location": {"latitude": latitude, "longitude": longitude},
        }

    weather = fetch_weather(latitude, longitude)
    hours = HORIZON_HOURS[horizon]
    try:
        rows = _forecast_rows(weather, hours)
    except ValueError as error:
        return {
            "available": False,
            "horizon": horizon,
            "horizon_label": HORIZON_LABELS[horizon],
            "reason": str(error),
            "location": {"latitude": latitude, "longitude": longitude},
        }

    features = model_bundle["features"]
    values = []
    for moment, irradiance, temperature in rows:
        angle = 2 * np.pi * moment.hour / 24
        row = {
            "irradiance_w_m2": max(0.0, float(irradiance)),
            "ambient_temp_c": float(temperature),
            "hour_sin": float(np.sin(angle)),
            "hour_cos": float(np.cos(angle)),
        }
        values.append([row[name] for name in features])

    predicted = np.clip(model_bundle["model"].predict(np.array(values)), 0, None)
    q10 = model_bundle["residual_q10_kwh"]
    q90 = model_bundle["residual_q90_kwh"]

    hourly_out = []
    for (moment, irradiance, temperature), pred in zip(rows, predicted):
        hourly_out.append({
            "time": moment.isoformat(),
            "predicted_kwh": round(float(pred), 1),
            "low_kwh": round(max(0.0, float(pred) + q10), 1),
            "high_kwh": round(max(0.0, float(pred) + q90), 1),
            "irradiance_w_m2": round(float(irradiance), 1),
            "ambient_temp_c": round(float(temperature), 1),
        })

    daily = {}
    for item in hourly_out:
        day = item["time"][:10]
        bucket = daily.setdefault(day, {"date": day, "predicted_kwh": 0.0, "low_kwh": 0.0, "high_kwh": 0.0, "hours": 0})
        bucket["predicted_kwh"] += item["predicted_kwh"]
        bucket["low_kwh"] += item["low_kwh"]
        bucket["high_kwh"] += item["high_kwh"]
        bucket["hours"] += 1
    daily_out = [
        {**day, "predicted_kwh": round(day["predicted_kwh"], 1),
         "low_kwh": round(day["low_kwh"], 1), "high_kwh": round(day["high_kwh"], 1)}
        for day in daily.values()
    ]

    reference = sorted(day["actual_kwh"] for day in metrics["daily_backtest"])
    threshold = round(reference[len(reference) // 2] * LOW_GENERATION_RATIO, 1) if reference else None
    warnings = []
    if threshold is not None:
        for day in daily_out:
            if day["predicted_kwh"] < threshold:
                warnings.append({
                    "date": day["date"],
                    "predicted_kwh": day["predicted_kwh"],
                    "message": f"Predicted output is below {int(LOW_GENERATION_RATIO * 100)}% of the "
                               f"median actual day in the test period ({threshold} kWh).",
                })

    totals = {
        "predicted_kwh": round(sum(item["predicted_kwh"] for item in hourly_out), 1),
        "low_kwh": round(sum(item["low_kwh"] for item in hourly_out), 1),
        "high_kwh": round(sum(item["high_kwh"] for item in hourly_out), 1),
    }

    return {
        "available": True,
        "is_forecast": True,
        "horizon": horizon,
        "horizon_label": HORIZON_LABELS[horizon],
        "location": {"latitude": latitude, "longitude": longitude, "timezone": timezone_name},
        "totals": totals,
        "hourly": hourly_out,
        "daily": daily_out,
        "warnings": warnings,
        "low_generation_threshold_kwh": threshold,
        "model": {
            "name": model_bundle["model_name"],
            "holdout": metrics["holdout"],
            "baseline_same_hour": metrics["baseline_same_hour"],
            "holdout_period": metrics["holdout_period"],
            "holdout_hours": metrics["holdout_hours"],
            "residual_q10_kwh": round(q10, 1),
            "residual_q90_kwh": round(q90, 1),
        },
        "factors": metrics["factors"],
        "backtest": metrics["daily_backtest"],
        "assumptions": [
            "Forecast values are model estimates from weather forecast inputs, not measured generation.",
            "Irradiance input is Open-Meteo shortwave radiation (W/m²); the model was trained on plant sensor irradiance, so some bias is expected.",
            "The model was trained on 2020 Plant 1 readings. Its output reflects that plant's response, not necessarily a plant at this location.",
            "Confidence ranges use the 10th and 90th percentiles of holdout errors. Totals add hourly bands, so they are approximate.",
            f"Hour of day uses the {timezone_name} timezone from the weather request.",
        ],
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def _unavailable_response(error):
    return jsonify({"error": str(error)}), 503


@forecast_bp.route("/weather", methods=["GET"])
def weather():
    try:
        latitude, longitude = _location_from_request()
        data = fetch_weather(latitude, longitude)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except ServiceUnavailable as error:
        return _unavailable_response(error)
    return jsonify({
        "location": {"latitude": latitude, "longitude": longitude},
        "source": "Open-Meteo",
        "current": data["current"],
        "current_units": data.get("current_units", {}),
        "daily": data.get("daily", {}),
        "daily_units": data.get("daily_units", {}),
        "hourly": data["hourly"],
        "hourly_units": data.get("hourly_units", {}),
    }), 200


@forecast_bp.route("/energy", methods=["GET"])
def energy():
    try:
        horizon = _horizon_from(request.args)
        latitude, longitude = _location_from_request()
        result = build_forecast(horizon, latitude, longitude)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except ServiceUnavailable as error:
        return _unavailable_response(error)
    return jsonify(result), 200


@forecast_bp.route("/runs", methods=["GET"])
def list_runs():
    user_id = _current_user_id()
    if not user_id:
        return jsonify({"error": "Sign in to view saved forecast runs."}), 401
    try:
        with Session(engine) as db:
            runs = (
                db.query(ForecastRun)
                .filter(ForecastRun.user_id == user_id)
                .order_by(ForecastRun.created_at.desc())
                .limit(20)
                .all()
            )
            payload = [{
                "id": run.id,
                "horizon": run.horizon,
                "latitude": run.latitude,
                "longitude": run.longitude,
                "total_kwh": run.total_kwh,
                "low_kwh": run.low_kwh,
                "high_kwh": run.high_kwh,
                "model_name": run.model_name,
                "created_at": run.created_at.isoformat() if run.created_at else None,
            } for run in runs]
    except SQLAlchemyError:
        return jsonify({"error": "Forecast history could not be loaded from PostgreSQL."}), 500
    return jsonify({"runs": payload}), 200


@forecast_bp.route("/runs", methods=["POST"])
def save_run():
    user_id = _current_user_id()
    if not user_id:
        return jsonify({"error": "Sign in to save a forecast run."}), 401
    if not _valid_csrf():
        return jsonify({"error": "Your session expired. Refresh the page and try again."}), 403
    data = request.get_json(silent=True) or {}
    try:
        horizon = _horizon_from(data)
        latitude, longitude = _location_from_request(data)
        result = build_forecast(horizon, latitude, longitude)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except ServiceUnavailable as error:
        return _unavailable_response(error)
    if not result["available"]:
        return jsonify({"error": result["reason"]}), 400

    try:
        with Session(engine) as db:
            run = ForecastRun(
                user_id=user_id,
                horizon=horizon,
                latitude=latitude,
                longitude=longitude,
                total_kwh=result["totals"]["predicted_kwh"],
                low_kwh=result["totals"]["low_kwh"],
                high_kwh=result["totals"]["high_kwh"],
                model_name=result["model"]["name"],
            )
            db.add(run)
            db.commit()
            run_id = run.id
    except SQLAlchemyError:
        return jsonify({"error": "Forecast run could not be saved to PostgreSQL."}), 500
    return jsonify({"saved": True, "id": run_id, "totals": result["totals"]}), 201


@forecast_bp.route("/report.csv", methods=["GET"])
def report():
    if not _current_user_id():
        return jsonify({"error": "Sign in to download a forecast report."}), 401
    try:
        horizon = _horizon_from(request.args)
        latitude, longitude = _location_from_request()
        result = build_forecast(horizon, latitude, longitude)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except ServiceUnavailable as error:
        return _unavailable_response(error)
    if not result["available"]:
        return jsonify({"error": result["reason"]}), 400

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["record_type", "time_local", "predicted_kwh", "low_kwh", "high_kwh", "irradiance_w_m2", "ambient_temp_c"])
    for item in result["hourly"]:
        writer.writerow(["FORECAST", item["time"], item["predicted_kwh"], item["low_kwh"],
                         item["high_kwh"], item["irradiance_w_m2"], item["ambient_temp_c"]])
    writer.writerow([])
    writer.writerow(["note", "Forecast values are model estimates, not measured generation. See assumptions in the app."])
    filename = f"solarsense_forecast_{horizon}.csv"
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
