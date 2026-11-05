"""Time Machine baseline API: daily actual vs expected energy from imported plant data."""
from flask import Blueprint, jsonify, session
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from database import engine, get_selected_plant

timemachine_bp = Blueprint("timemachine", __name__, url_prefix="/api/timemachine")

INTERVAL_HOURS = 0.25  # Readings are 15-minute samples.
MIN_INTERVALS_PER_DAY = 90  # Skip partial days at the edges of the dataset.


@timemachine_bp.route("/baseline", methods=["GET"])
def baseline():
    if not session.get("user_id"):
        return jsonify({"error": "You are not signed in."}), 401

    try:
        with engine.connect() as connection:
            plant = get_selected_plant(connection, session.get("user_id"))
            if plant is None:
                return jsonify({"error": "No solar plant is configured."}), 404

            rows = connection.execute(
                text("""
                    SELECT DATE(timestamp) AS day,
                           COUNT(*) AS intervals,
                           SUM(power) * :hours AS actual_kwh,
                           SUM(expected_power) * :hours AS expected_kwh
                    FROM sensor_readings
                    WHERE plant_id = :plant_id AND inverter_status = 'Imported'
                      AND power IS NOT NULL AND expected_power IS NOT NULL
                    GROUP BY DATE(timestamp)
                    ORDER BY DATE(timestamp)
                """),
                {"hours": INTERVAL_HOURS, "plant_id": plant["id"]},
            ).mappings().all()
    except SQLAlchemyError:
        return jsonify({"error": "Plant data is temporarily unavailable."}), 503

    daily = [
        {
            "date": row["day"].isoformat(),
            "actual_kwh": round(float(row["actual_kwh"]), 1),
            "expected_kwh": round(float(row["expected_kwh"]), 1),
        }
        for row in rows
        if row["intervals"] >= MIN_INTERVALS_PER_DAY and float(row["expected_kwh"]) > 0
    ]

    if not daily:
        return jsonify({
            "plant": dict(plant),
            "daily": [],
            "summary": None,
            "message": "No complete imported days are available yet. Run backend/import_plant1.py.",
        }), 200

    total_actual = sum(d["actual_kwh"] for d in daily)
    total_expected = sum(d["expected_kwh"] for d in daily)
    days = len(daily)

    return jsonify({
        "plant": {
            "id": plant["id"],
            "plant_name": plant["plant_name"],
            "capacity_kw": plant["capacity_kw"],
        },
        "daily": daily,
        "summary": {
            "days": days,
            "start_date": daily[0]["date"],
            "end_date": daily[-1]["date"],
            "avg_daily_actual_kwh": round(total_actual / days, 1),
            "avg_daily_expected_kwh": round(total_expected / days, 1),
            "performance_ratio": round(total_actual / total_expected, 4),
        },
        "message": None,
    }), 200
