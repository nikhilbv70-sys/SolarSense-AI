"""Fault detection replay API: real imported 15-minute readings for one day."""
from datetime import date as date_type

from flask import Blueprint, jsonify, request, session
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from database import engine, get_selected_plant
from import_plant1 import PERFORMANCE_RATIO

faults_bp = Blueprint("faults", __name__, url_prefix="/api/faults")

MIN_INTERVALS_PER_DAY = 90  # Same completeness rule as the Time Machine baseline.


@faults_bp.route("/replay", methods=["GET"])
def replay():
    if not session.get("user_id"):
        return jsonify({"error": "Sign in to replay plant data."}), 401

    requested = request.args.get("date")
    try:
        requested_day = date_type.fromisoformat(requested) if requested else None
    except ValueError:
        return jsonify({"error": "date must use the format YYYY-MM-DD."}), 400

    try:
        with engine.connect() as connection:
            plant = get_selected_plant(connection, session.get("user_id"))
            if plant is None:
                return jsonify({"error": "No solar plant is configured."}), 404

            days = [
                row["day"].isoformat()
                for row in connection.execute(
                    text("""
                        SELECT DATE(timestamp) AS day, COUNT(*) AS intervals
                        FROM sensor_readings
                        WHERE plant_id = :plant_id AND inverter_status = 'Imported'
                        GROUP BY DATE(timestamp)
                        ORDER BY DATE(timestamp)
                    """),
                    {"plant_id": plant["id"]},
                ).mappings().all()
                if row["intervals"] >= MIN_INTERVALS_PER_DAY
            ]
            if not days:
                return jsonify({"error": "No complete imported days are available. Run backend/import_plant1.py."}), 404

            day = requested_day.isoformat() if requested_day else days[0]
            if day not in days:
                return jsonify({"error": "That day has no complete imported readings.", "days": days}), 404

            rows = connection.execute(
                text("""
                    SELECT timestamp, irradiance, panel_temperature, power, expected_power
                    FROM sensor_readings
                    WHERE plant_id = :plant_id AND inverter_status = 'Imported'
                      AND DATE(timestamp) = :day
                      AND irradiance IS NOT NULL AND power IS NOT NULL
                    ORDER BY timestamp
                """),
                {"plant_id": plant["id"], "day": day},
            ).mappings().all()
    except SQLAlchemyError:
        return jsonify({"error": "Plant data is temporarily unavailable."}), 503

    intervals = [
        {
            "time": row["timestamp"].strftime("%H:%M"),
            "irradiance": round(float(row["irradiance"]), 1),
            "panel_temperature": None if row["panel_temperature"] is None else round(float(row["panel_temperature"]), 1),
            "actual_kw": round(float(row["power"]), 2),
        }
        for row in rows
    ]

    return jsonify({
        "plant": {
            "id": plant["id"],
            "plant_name": plant["plant_name"],
            "capacity_kw": float(plant["capacity_kw"]),
        },
        "performance_ratio": PERFORMANCE_RATIO,
        "date": day,
        "days": days,
        "intervals": intervals,
    }), 200
