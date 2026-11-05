from flask import Blueprint, jsonify, request

from services import nasa_power, pvgis
from services.common import ProviderError, ValidationError, STATUS_CONNECTED

external_bp = Blueprint("external", __name__, url_prefix="/api/external")


def _error(message, status_code, provider_status="invalid_request"):
    return jsonify({"status": provider_status, "error": message}), status_code


def _provider_response(fetcher):
    try:
        return jsonify(fetcher()), 200
    except ValidationError as error:
        return _error(str(error), 400)
    except ProviderError as error:
        return jsonify({"status": error.status, "error": str(error), "records": []}), 200


def _args():
    return request.args if request.method == "GET" else (request.get_json(silent=True) or {})


@external_bp.get("/status")
def status():
    return jsonify({
        "providers": [
            {"id": "nasa-power", "name": "NASA POWER", "requires_key": False, "status": STATUS_CONNECTED},
            {"id": "pvgis", "name": "PVGIS (EU JRC)", "requires_key": False, "status": STATUS_CONNECTED},
        ]
    })


@external_bp.route("/nasa-power", methods=["GET", "POST"])
def nasa_power_route():
    args = _args()
    params = args.get("parameters")
    parameters = [p.strip() for p in params.split(",") if p.strip()] if isinstance(params, str) else params
    return _provider_response(lambda: nasa_power.fetch(
        args.get("latitude"), args.get("longitude"), args.get("start"), args.get("end"), parameters))


@external_bp.route("/pvgis", methods=["GET", "POST"])
def pvgis_route():
    args = _args()
    return _provider_response(lambda: pvgis.fetch(
        args.get("latitude"), args.get("longitude"),
        args.get("peak_power_kw", 1.0), args.get("tilt", 35),
        args.get("azimuth", 0), args.get("loss_percent", 14)))
