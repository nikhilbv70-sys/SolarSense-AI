"""Maintenance recovery verification: compares daily performance before and after a recorded action."""
import hmac
from datetime import date, datetime, timezone

from flask import Blueprint, jsonify, request, session
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from database import engine, get_selected_plant

recovery_bp = Blueprint("recovery", __name__, url_prefix="/api/recovery")

ACTION_TYPES = (
    "Panel cleaning",
    "Inverter inspection",
    "String or wiring check",
    "Sensor calibration",
    "Shading removal",
    "Other",
)
WINDOW_DAYS = 7                 # Complete days compared on each side of the action.
MIN_DAYS_EACH_SIDE = 3          # Fewer complete days than this gives an inconclusive result.
MIN_INTERVALS_PER_DAY = 90      # Same completeness rule as the priority alerts (of 96).
INTERVAL_HOURS = 0.25
IRRADIANCE_CHANGE_LIMIT = 0.15  # Irradiance differing by more than 15% counts as a weather influence.
MATERIAL_CHANGE = 0.05          # Performance ratio change of 5% or more counts as a change.


def _valid_csrf():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token", "")
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))


def _daily_metrics(rows, capacity_kw):
    """Return one dict per complete day with actual kWh, irradiation and performance ratio."""
    days = {}
    for row in rows:
        days.setdefault(row["timestamp"].date(), []).append(row)

    metrics = {}
    for day, day_rows in days.items():
        if len(day_rows) < MIN_INTERVALS_PER_DAY:
            continue
        actual_kwh = sum(float(r["power"] or 0) for r in day_rows) * INTERVAL_HOURS
        irradiation_kwh_m2 = sum(float(r["irradiance"] or 0) for r in day_rows) * INTERVAL_HOURS / 1000
        if irradiation_kwh_m2 <= 0 or not capacity_kw:
            continue
        metrics[day] = {
            "date": day.isoformat(),
            "actual_kwh": round(actual_kwh, 1),
            "irradiation_kwh_m2": round(irradiation_kwh_m2, 3),
            "performance_ratio": round(actual_kwh / (irradiation_kwh_m2 * capacity_kw), 4),
        }
    return metrics


def _average(values):
    return sum(values) / len(values) if values else None


def _verify(metrics, performed_on):
    """Compare up to WINDOW_DAYS complete days before and after the action date."""
    before = sorted((d for d in metrics if d < performed_on))[-WINDOW_DAYS:]
    after = sorted((d for d in metrics if d >= performed_on))[:WINDOW_DAYS]

    summary = {
        "days_before": len(before),
        "days_after": len(after),
        "window_days": WINDOW_DAYS,
    }
    if len(before) < MIN_DAYS_EACH_SIDE or len(after) < MIN_DAYS_EACH_SIDE:
        summary.update({
            "verdict": "Inconclusive",
            "explanation": (
                f"Needs at least {MIN_DAYS_EACH_SIDE} complete days before and after the action. "
                "Not enough complete data exists on one side, so no conclusion is drawn."
            ),
        })
        return summary

    before_days = [metrics[d] for d in before]
    after_days = [metrics[d] for d in after]
    pr_before = _average([m["performance_ratio"] for m in before_days])
    pr_after = _average([m["performance_ratio"] for m in after_days])
    irr_before = _average([m["irradiation_kwh_m2"] for m in before_days])
    irr_after = _average([m["irradiation_kwh_m2"] for m in after_days])
    kwh_before = _average([m["actual_kwh"] for m in before_days])
    kwh_after = _average([m["actual_kwh"] for m in after_days])

    pr_change = (pr_after - pr_before) / pr_before
    irr_change = (irr_after - irr_before) / irr_before
    weather_shift = abs(irr_change) > IRRADIANCE_CHANGE_LIMIT

    if pr_change >= MATERIAL_CHANGE:
        direction = "improved"
    elif pr_change <= -MATERIAL_CHANGE:
        direction = "declined"
    else:
        direction = "no material change"

    if weather_shift:
        verdict = "Weather-influenced"
        explanation = (
            f"Performance ratio moved {pr_change:+.1%}, but irradiation also changed "
            f"{irr_change:+.1%}. Weather may explain the difference, so the change is not attributed to maintenance."
        )
    else:
        verdict = {
            "improved": "Improved",
            "declined": "Declined",
            "no material change": "No material change",
        }[direction]
        explanation = (
            f"Performance ratio moved {pr_change:+.1%} with irradiation changing {irr_change:+.1%}. "
            "The comparison is observational and does not prove the maintenance caused the change."
        )

    summary.update({
        "verdict": verdict,
        "explanation": explanation,
        "performance_ratio_before": round(pr_before, 4),
        "performance_ratio_after": round(pr_after, 4),
        "performance_ratio_change_pct": round(pr_change * 100, 2),
        "irradiation_change_pct": round(irr_change * 100, 2),
        "average_kwh_per_day_before": round(kwh_before, 1),
        "average_kwh_per_day_after": round(kwh_after, 1),
        "observed_kwh_per_day_difference": round(kwh_after - kwh_before, 1),
        "daily_before": before_days,
        "daily_after": after_days,
    })
    return summary


def _load_plant_and_rows(connection):
    plant = get_selected_plant(connection, session.get("user_id"))
    if plant is None:
        return None, []
    rows = connection.execute(
        text("""
            SELECT timestamp, irradiance, power
            FROM sensor_readings
            WHERE plant_id = :plant_id AND inverter_status = 'Imported'
              AND irradiance IS NOT NULL AND power IS NOT NULL
            ORDER BY timestamp
        """),
        {"plant_id": plant["id"]},
    ).mappings().all()
    return plant, rows


@recovery_bp.route("/actions", methods=["GET"])
def list_actions():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "Sign in to view maintenance history."}), 401

    try:
        with engine.connect() as connection:
            plant, rows = _load_plant_and_rows(connection)
            if plant is None:
                return jsonify({"error": "No solar plant is configured."}), 404
            actions = connection.execute(
                text("""
                    SELECT id, action_type, performed_on, notes, created_at
                    FROM maintenance_actions
                    WHERE user_id = :user_id
                    ORDER BY performed_on DESC, id DESC
                """),
                {"user_id": user_id},
            ).mappings().all()
    except SQLAlchemyError:
        return jsonify({"error": "Maintenance history could not be loaded from PostgreSQL."}), 500

    metrics = _daily_metrics(rows, plant["capacity_kw"])
    payload = []
    for action in actions:
        performed_on = action["performed_on"]
        payload.append({
            "id": action["id"],
            "action_type": action["action_type"],
            "performed_on": performed_on.isoformat(),
            "notes": action["notes"] or "",
            "created_at": action["created_at"].isoformat() if action["created_at"] else None,
            "verification": _verify(metrics, performed_on),
        })

    return jsonify({
        "plant": {"id": plant["id"], "name": plant["plant_name"], "capacity_kw": plant["capacity_kw"]},
        "action_types": list(ACTION_TYPES),
        "data_coverage": {
            "first_day": min(metrics).isoformat() if metrics else None,
            "last_day": max(metrics).isoformat() if metrics else None,
            "complete_days": len(metrics),
        },
        "actions": payload,
        "method": (
            f"Daily performance ratio = actual kWh / (irradiation kWh/m² x {plant['capacity_kw']} kW). "
            f"Compares up to {WINDOW_DAYS} complete days before and after the action. "
            "Requires at least 3 complete days on each side."
        ),
    }), 200


@recovery_bp.route("/actions", methods=["POST"])
def create_action():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "Sign in to record maintenance."}), 401
    if not _valid_csrf():
        return jsonify({"error": "Your session expired. Refresh the page and try again."}), 403

    data = request.get_json(silent=True) or {}
    action_type = data.get("action_type")
    notes = (data.get("notes") or "").strip()[:500]
    if action_type not in ACTION_TYPES:
        return jsonify({"error": "Choose a valid maintenance action type."}), 400
    try:
        performed_on = date.fromisoformat(str(data.get("performed_on", "")))
    except ValueError:
        return jsonify({"error": "Enter the maintenance date as YYYY-MM-DD."}), 400
    if performed_on > datetime.now(timezone.utc).date():
        return jsonify({"error": "The maintenance date cannot be in the future."}), 400

    try:
        with engine.begin() as connection:
            plant = get_selected_plant(connection, session.get("user_id"))
            if plant is None:
                return jsonify({"error": "No solar plant is configured."}), 404
            result = connection.execute(
                text("""
                    INSERT INTO maintenance_actions (user_id, plant_id, action_type, performed_on, notes, created_at)
                    VALUES (:user_id, :plant_id, :action_type, :performed_on, :notes, now())
                    RETURNING id
                """),
                {
                    "user_id": user_id,
                    "plant_id": plant["id"],
                    "action_type": action_type,
                    "performed_on": performed_on,
                    "notes": notes,
                },
            ).mappings().first()
    except SQLAlchemyError:
        return jsonify({"error": "Could not save the maintenance record. Try again."}), 503

    return jsonify({"id": result["id"], "message": "Maintenance action recorded."}), 201
