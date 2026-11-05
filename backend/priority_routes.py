"""Maintenance priority API: rule-based alerts from real imported readings, with workflow status."""
import hmac
from datetime import timedelta

from flask import Blueprint, jsonify, request, session
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from database import DEFAULT_ALERT_THRESHOLD_PCT, engine, get_selected_plant
from import_plant1 import PERFORMANCE_RATIO

priority_bp = Blueprint("priority", __name__, url_prefix="/api/priority")

INTERVAL_HOURS = 0.25
MIN_IRRADIANCE = 200          # Daylight only, same rule as the fault replay.
MIN_RUN = 3                   # At least 3 consecutive intervals (45 min).
STATUSES = ("Open", "Under Investigation", "Resolved")
MIN_INTERVALS_PER_DAY = 90


def _valid_csrf():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token", "")
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))


def _priority_band(score):
    if score >= 70:
        return "Critical"
    if score >= 50:
        return "High"
    if score >= 30:
        return "Medium"
    return "Low"


def _build_alerts(rows, low_deviation, tariff):
    """Group rows by day, then find runs of sustained underperformance in daylight."""
    days = {}
    for row in rows:
        days.setdefault(row["timestamp"].date(), []).append(row)

    complete_days = [d for d, r in days.items() if len(r) >= MIN_INTERVALS_PER_DAY]
    latest_day = max(complete_days) if complete_days else None
    alerts = []

    for day in sorted(complete_days):
        day_rows = days[day]
        day_expected_kwh = sum(float(r["expected_power"] or 0) for r in day_rows) * INTERVAL_HOURS
        run = []
        for row in day_rows + [None]:
            is_low = (
                row is not None
                and row["irradiance"] >= MIN_IRRADIANCE
                and row["expected_power"] and row["expected_power"] > 0
                and (row["power"] - row["expected_power"]) / row["expected_power"] <= low_deviation
            )
            contiguous = (
                run and row is not None
                and row["timestamp"] - run[-1]["timestamp"] == timedelta(minutes=15)
            )
            if is_low and (not run or contiguous):
                run.append(row)
                continue
            if len(run) >= MIN_RUN:
                alerts.append(_summarise(run, latest_day, day_expected_kwh, tariff))
            run = [row] if is_low else []

    return alerts


def _summarise(run, latest_day, day_expected_kwh, tariff):
    n = len(run)
    deviations = [
        (r["power"] - r["expected_power"]) / r["expected_power"] for r in run
    ]
    mean_dev = sum(deviations) / n
    loss_kwh = sum(
        max(0.0, float(r["expected_power"]) - float(r["power"])) for r in run
    ) * INTERVAL_HOURS
    duration_min = n * 15

    # Evidence score: rule-based, grows with run length and depth. Not a statistical probability.
    confidence = min(0.9, 0.5 + 0.03 * n + (0.1 if mean_dev <= -0.25 else 0.0))

    loss_share = loss_kwh / day_expected_kwh if day_expected_kwh > 0 else 0.0
    severity_part = min(abs(mean_dev) / 0.5, 1.0)
    loss_part = min(loss_share / 0.10, 1.0)  # 10% of the day's expected energy scores full.
    duration_part = min(n / 12.0, 1.0)
    urgency = 1.0 if run[0]["timestamp"].date() == latest_day else 0.5
    score = round(100 * (0.35 * loss_part + 0.25 * severity_part
                         + 0.20 * duration_part + 0.10 * confidence
                         + 0.10 * urgency), 1)

    start = run[0]["timestamp"]
    if mean_dev <= -0.25 and n >= 6:
        inspection = ("Inspect strings and inverter logs for a sustained equipment or "
                      "shading issue. Confirm with a site visit before concluding.")
    else:
        inspection = ("Check panel cleanliness and soiling first, then compare with "
                      "neighbouring days at similar irradiance.")

    return {
        "alert_key": f"{start.strftime('%Y-%m-%d_%H%M')}",
        "date": start.date().isoformat(),
        "start_time": start.strftime("%H:%M"),
        "end_time": run[-1]["timestamp"].strftime("%H:%M"),
        "duration_min": duration_min,
        "intervals": n,
        "mean_deviation_pct": round(mean_dev * 100, 1),
        "estimated_loss_share_pct": round(loss_share * 100, 1),
        "estimated_loss_kwh": round(loss_kwh, 2),
        "estimated_loss_value": round(loss_kwh * tariff, 2) if tariff is not None else None,
        "confidence": round(confidence, 2),
        "priority_score": score,
        "priority": _priority_band(score),
        "reason": (
            f"Output averaged {abs(mean_dev) * 100:.1f}% below expected for "
            f"{duration_min} minutes in daylight, estimated loss {loss_kwh:.1f} kWh. "
            f"Evidence score {confidence:.2f} (rule-based)."
        ),
        "recommended_inspection": inspection,
    }


@priority_bp.route("", methods=["GET"])
def list_priority():
    if not session.get("user_id"):
        return jsonify({"error": "Sign in to view maintenance priorities."}), 401

    try:
        with engine.connect() as connection:
            plant = get_selected_plant(connection, session.get("user_id"))
            if plant is None:
                return jsonify({"error": "No solar plant is configured."}), 404

            prefs = connection.execute(
                text("SELECT alert_threshold_pct, tariff_per_kwh, energy_unit FROM user_settings WHERE user_id = :user_id"),
                {"user_id": session.get("user_id")},
            ).mappings().first()
            threshold_pct = prefs["alert_threshold_pct"] if prefs else DEFAULT_ALERT_THRESHOLD_PCT
            tariff = prefs["tariff_per_kwh"] if prefs else None
            energy_unit = prefs["energy_unit"] if prefs else "kWh"
            low_deviation = -threshold_pct / 100

            rows = connection.execute(
                text("""
                    SELECT timestamp, irradiance, power, expected_power
                    FROM sensor_readings
                    WHERE plant_id = :plant_id AND inverter_status = 'Imported'
                      AND irradiance IS NOT NULL AND power IS NOT NULL
                    ORDER BY timestamp
                """),
                {"plant_id": plant["id"]},
            ).mappings().all()

            alerts = _build_alerts(rows, low_deviation, tariff)

            statuses = {
                row["alert_key"]: row["status"]
                for row in connection.execute(
                    text("""
                        SELECT alert_key, status FROM alert_workflow
                        WHERE plant_id = :plant_id
                    """),
                    {"plant_id": plant["id"]},
                ).mappings()
            }
    except SQLAlchemyError:
        return jsonify({"error": "Plant data is temporarily unavailable."}), 503

    for alert in alerts:
        alert["status"] = statuses.get(alert["alert_key"], "Open")
    alerts.sort(key=lambda a: a["priority_score"], reverse=True)

    counts = {band: 0 for band in ("Critical", "High", "Medium", "Low")}
    for alert in alerts:
        counts[alert["priority"]] += 1

    return jsonify({
        "plant": {"id": plant["id"], "plant_name": plant["plant_name"]},
        "performance_ratio": PERFORMANCE_RATIO,
        "rules": {
            "irradiance_min_wm2": MIN_IRRADIANCE,
            "deviation_threshold_pct": threshold_pct,
            "min_run_intervals": MIN_RUN,
            "score_weights": "loss share 35% (10% of day = full), severity 25% (50% dev = full), duration 20% (3h = full), evidence 10%, urgency 10% (latest day = full)",
        },
        "counts": counts,
        "display": {"energy_unit": energy_unit, "tariff_per_kwh": tariff},
        "alerts": alerts,
        "statuses": list(STATUSES),
    }), 200


@priority_bp.route("/<alert_key>/status", methods=["POST"])
def update_status(alert_key):
    if not session.get("user_id"):
        return jsonify({"error": "Sign in to update alerts."}), 401
    if not _valid_csrf():
        return jsonify({"error": "Your session expired. Refresh the page and try again."}), 403

    payload = request.get_json(silent=True) or {}
    status = payload.get("status")
    if status not in STATUSES:
        return jsonify({"error": "status must be Open, Under Investigation or Resolved."}), 400

    try:
        with engine.begin() as connection:
            plant = get_selected_plant(connection, session.get("user_id"))
            if plant is None:
                return jsonify({"error": "No solar plant is configured."}), 404

            connection.execute(
                text("""
                    INSERT INTO alert_workflow (alert_key, plant_id, status, updated_at)
                    VALUES (:key, :plant_id, :status, now())
                    ON CONFLICT (alert_key)
                    DO UPDATE SET status = EXCLUDED.status, updated_at = now()
                """),
                {"key": alert_key[:64], "plant_id": plant["id"], "status": status},
            )
    except SQLAlchemyError:
        return jsonify({"error": "Could not save the status. Try again."}), 503

    return jsonify({"alert_key": alert_key, "status": status}), 200
