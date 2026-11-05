from unittest.mock import patch

import pytest

from app import app
from services import nasa_power, pvgis
from services.common import ProviderError, ValidationError, validate_coordinates, validate_date_range
from services.data_normalizer import clean_value


@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as test_client:
        yield test_client


def test_clean_value_drops_fill_values():
    assert clean_value(-999) is None
    assert clean_value("bad") is None
    assert clean_value(5.12345) == 5.1235


def test_coordinate_validation():
    assert validate_coordinates("28.61", "77.2") == (28.61, 77.2)
    with pytest.raises(ValidationError):
        validate_coordinates(91, 0)
    with pytest.raises(ValidationError):
        validate_coordinates("abc", 0)


def test_date_range_validation():
    with pytest.raises(ValidationError):
        validate_date_range("2024-02-02", "2024-02-01")
    with pytest.raises(ValidationError):
        validate_date_range("2024-01-01", "2099-01-01")
    with pytest.raises(ValidationError):
        validate_date_range("01/01/2024", "2024-01-02")


def test_nasa_power_normalizes_payload():
    payload = {
        "parameters": {"T2M": {"units": "C"}},
        "properties": {"parameter": {"T2M": {"20240101": 21.5, "20240102": -999}}},
    }
    with patch.object(nasa_power, "get_json", return_value=payload):
        result = nasa_power.fetch("28.6", "77.2", "2024-01-01", "2024-01-02", ["T2M"])
    values = [r["value"] for r in result["records"]]
    assert values == [21.5, None]
    assert result["records"][0]["unit"] == "C"
    assert result["records"][0]["timestamp"] == "2024-01-01T00:00:00Z"


def test_nasa_power_rejects_unknown_parameter():
    with pytest.raises(ValidationError):
        nasa_power.fetch("28.6", "77.2", "2024-01-01", "2024-01-02", ["NOT_A_PARAM"])


def test_pvgis_normalizes_totals_without_inventing_dates():
    payload = {
        "outputs": {
            "monthly": {"fixed": [{"month": 1, "E_m": 100.0, "H(i)_m": 120.0}]},
            "totals": {"fixed": {"E_y": 1500.0, "H(i)_y": 1800.0, "SL_total": 14.0}},
        }
    }
    with patch.object(pvgis, "get_json", return_value=payload):
        result = pvgis.fetch("28.6", "77.2", peak_power_kw=2)
    assert result["totals"]["annual_energy_kwh"] == 1500.0
    assert all(r["timestamp"] is None for r in result["records"])


def test_pvgis_rejects_bad_tilt():
    with pytest.raises(ValidationError):
        pvgis.fetch("28.6", "77.2", tilt=120)


def test_provider_timeout_is_isolated(client):
    with patch.object(nasa_power, "get_json", side_effect=ProviderError("timed out")):
        response = client.get("/api/external/nasa-power?latitude=28.6&longitude=77.2&start=2024-01-01&end=2024-01-02")
    assert response.status_code == 200
    assert response.get_json()["records"] == []


def test_status_endpoint_lists_providers(client):
    providers = client.get("/api/external/status").get_json()["providers"]
    assert {p["id"] for p in providers} == {"nasa-power", "pvgis"}
