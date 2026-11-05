"""Maintenance cost API: rupee estimates built on the real priority alerts and plant capacity."""
from flask import Blueprint, jsonify, session
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from database import DEFAULT_ALERT_THRESHOLD_PCT, engine, get_selected_plant
from priority_routes import _build_alerts

cost_bp = Blueprint("cost", __name__, url_prefix="/api/maintenance-cost")

CURRENCY = "INR"
CURRENCY_SYMBOL = "₹"
# Planning assumptions in rupees. They are estimates, not quotes, and are returned to the UI for transparency.
DEFAULT_TARIFF_INR_PER_KWH = 7.0
INSPECTION_VISIT_INR = 2500
ACTION_COST_INR = {"Critical": 12000, "High": 6000, "Medium": 2500, "Low": 800}
OM_RATE_INR_PER_KWP_YEAR = 650
BANDS = ("Critical", "High", "Medium", "Low")


def _round(value):
    return round(float(value or 0), 2)


@cost_bp.route("", methods=["GET"])
def maintenance_cost():
    if not session.get("user_id"):
        return jsonify({"error": "Sign in to view maintenance costs."}), 401

    try:
        with engine.connect() as connection:
            plant = get_selected_plant(connection, session.get("user_id"))
            if plant is None:
                return jsonify({"error": "No solar plant is configured."}), 404

            prefs = connection.execute(
                text("SELECT alert_threshold_pct, tariff_per_kwh FROM user_settings WHERE user_id = :user_id"),
                {"user_id": session.get("user_id")},
            ).mappings().first()
            threshold_pct = prefs["alert_threshold_pct"] if prefs else DEFAULT_ALERT_THRESHOLD_PCT
            user_tariff = prefs["tariff_per_kwh"] if prefs else None
            tariff = float(user_tariff) if user_tariff is not None else DEFAULT_TARIFF_INR_PER_KWH
            tariff_source = "Settings" if user_tariff is not None else "Default planning rate"

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

            alerts = _build_alerts(rows, -threshold_pct / 100, tariff)

            statuses = {
                row["alert_key"]: row["status"]
                for row in connection.execute(
                    text("SELECT alert_key, status FROM alert_workflow WHERE plant_id = :plant_id"),
                    {"plant_id": plant["id"]},
                ).mappings()
            }
    except SQLAlchemyError:
        return jsonify({"error": "Plant data is temporarily unavailable."}), 503

    capacity_kw = float(plant["capacity_kw"] or 0)
    items = []
    by_band = {band: {"count": 0, "loss_value_inr": 0.0, "cost_inr": 0.0} for band in BANDS}
    for alert in alerts:
        band = alert["priority"]
        loss_value = float(alert["estimated_loss_value"] or 0)
        action_cost = ACTION_COST_INR[band]
        cost = INSPECTION_VISIT_INR + action_cost
        status = statuses.get(alert["alert_key"], "Open")
        items.append({
            "alert_key": alert["alert_key"],
            "date": alert["date"],
            "window": f"{alert['start_time']}–{alert['end_time']}",
            "priority": band,
            "status": status,
            "loss_kwh": alert["estimated_loss_kwh"],
            "loss_value_inr": _round(loss_value),
            "inspection_cost_inr": INSPECTION_VISIT_INR,
            "action_cost_inr": action_cost,
            "total_cost_inr": _round(cost),
            "net_recovery_inr": _round(loss_value - cost),
        })
        by_band[band]["count"] += 1
        by_band[band]["loss_value_inr"] += loss_value
        by_band[band]["cost_inr"] += cost

    total_loss_kwh = sum(float(i["loss_kwh"] or 0) for i in items)
    total_loss_value = sum(i["loss_value_inr"] for i in items)
    total_cost = sum(i["total_cost_inr"] for i in items)
    open_items = [i for i in items if i["status"] != "Resolved"]
    open_cost = sum(i["total_cost_inr"] for i in open_items)
    days_analysed = len({i["date"] for i in items}) if items else 0

    return jsonify({
        "currency": CURRENCY,
        "symbol": CURRENCY_SYMBOL,
        "plant": {"id": plant["id"], "plant_name": plant["plant_name"], "capacity_kw": capacity_kw},
        "assumptions": {
            "tariff_per_kwh_inr": _round(tariff),
            "tariff_source": tariff_source,
            "inspection_visit_inr": INSPECTION_VISIT_INR,
            "action_cost_inr": ACTION_COST_INR,
            "om_rate_inr_per_kwp_year": OM_RATE_INR_PER_KWP_YEAR,
            "note": "Rupee figures are planning estimates from the rates above. Replace them with contractor quotes before budgeting.",
        },
        "totals": {
            "alerts": len(items),
            "open_alerts": len(open_items),
            "days_analysed": days_analysed,
            "lost_kwh": _round(total_loss_kwh),
            "lost_value_inr": _round(total_loss_value),
            "maintenance_cost_inr": _round(total_cost),
            "open_maintenance_cost_inr": _round(open_cost),
            "net_recovery_inr": _round(total_loss_value - total_cost),
            "routine_om_annual_inr": _round(capacity_kw * OM_RATE_INR_PER_KWP_YEAR),
        },
        "by_priority": {
            band: {
                "count": data["count"],
                "loss_value_inr": _round(data["loss_value_inr"]),
                "cost_inr": _round(data["cost_inr"]),
            }
            for band, data in by_band.items()
        },
        "items": sorted(items, key=lambda i: i["total_cost_inr"], reverse=True),
    }), 200
