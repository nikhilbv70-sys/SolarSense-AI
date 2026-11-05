"""Import Plant 1 generation and weather CSVs into sensor_readings.

Run from the backend folder: python import_plant1.py
Safe to re-run: timestamps already stored for the plant are skipped.
"""
from pathlib import Path

import pandas as pd
from sqlalchemy import text

from database import engine

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GENERATION_CSV = DATA_DIR / "Plant_1_Generation_Data.csv"
WEATHER_CSV = DATA_DIR / "Plant_1_Weather_Sensor_Data.csv"

# Calibrated to the median daytime output/irradiance ratio of the imported data (0.979, n=1053).
PERFORMANCE_RATIO = 0.98


def load_generation():
    df = pd.read_csv(GENERATION_CSV)
    df["timestamp"] = pd.to_datetime(df["DATE_TIME"], format="%d-%m-%Y %H:%M")
    df["AC_POWER"] = pd.to_numeric(df["AC_POWER"], errors="coerce")
    df = df.dropna(subset=["AC_POWER"])
    df = df[df["AC_POWER"] >= 0]
    return df.groupby("timestamp", as_index=False)["AC_POWER"].sum().rename(columns={"AC_POWER": "power"})


def load_weather():
    df = pd.read_csv(WEATHER_CSV)
    df["timestamp"] = pd.to_datetime(df["DATE_TIME"], format="%Y-%m-%d %H:%M:%S")
    for col in ["IRRADIATION", "MODULE_TEMPERATURE"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["IRRADIATION"])
    df = df[(df["IRRADIATION"] >= 0) & (df["IRRADIATION"] <= 1.5)]
    df["irradiance"] = df["IRRADIATION"] * 1000  # kW/m2 -> W/m2
    return df[["timestamp", "irradiance", "MODULE_TEMPERATURE"]].rename(
        columns={"MODULE_TEMPERATURE": "panel_temperature"}
    )


def main():
    with engine.begin() as conn:
        plant = conn.execute(text("SELECT id, capacity_kw FROM solar_plants ORDER BY id LIMIT 1")).first()
        if plant is None:
            raise SystemExit("No solar plant row found. Create a plant first.")
        plant_id, capacity_kw = plant
        if not capacity_kw:
            raise SystemExit("solar_plants.capacity_kw is empty; set it before importing.")

        existing = {
            pd.Timestamp(row[0]).tz_localize(None) if pd.Timestamp(row[0]).tzinfo else pd.Timestamp(row[0])
            for row in conn.execute(
                text("SELECT timestamp FROM sensor_readings WHERE plant_id = :pid"), {"pid": plant_id}
            )
        }

        merged = load_generation().merge(load_weather(), on="timestamp", how="inner")
        merged = merged[~merged["timestamp"].isin(existing)]
        merged["expected_power"] = capacity_kw * (merged["irradiance"] / 1000) * PERFORMANCE_RATIO
        merged["expected_power"] = merged["expected_power"].clip(lower=0)

        rows = [
            {
                "plant_id": plant_id,
                "timestamp": r.timestamp.to_pydatetime(),
                "irradiance": float(r.irradiance),
                "panel_temperature": None if pd.isna(r.panel_temperature) else float(r.panel_temperature),
                "voltage": None,
                "current": None,
                "power": float(r.power),
                "expected_power": float(r.expected_power),
                "inverter_status": "Imported",
            }
            for r in merged.itertuples(index=False)
        ]

        conn.execute(
            text(
                "INSERT INTO sensor_readings (plant_id, timestamp, irradiance, panel_temperature, voltage, "
                "current, power, expected_power, inverter_status) VALUES (:plant_id, :timestamp, :irradiance, "
                ":panel_temperature, :voltage, :current, :power, :expected_power, :inverter_status)"
            ),
            rows,
        )
        print(f"Imported {len(rows)} readings for plant {plant_id} (skipped {len(existing)} existing timestamps).")


if __name__ == "__main__":
    main()
