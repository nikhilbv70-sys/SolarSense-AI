"""Train the hourly energy forecast model from the real Plant 1 CSV files.

Inputs are limited to values that a weather forecast can supply for future hours:
irradiance, ambient temperature and hour of day. The existing 15-minute model
(models/solar_forecast.joblib) uses lag and DC features that are unknown in the
future, so it is kept unchanged.

Run from the project root:  python backend/train_forecast.py
"""
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.inspection import permutation_importance
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

ROOT = Path(__file__).resolve().parents[1]
GENERATION_CSV = ROOT / "data" / "Plant_1_Generation_Data.csv"
WEATHER_CSV = ROOT / "data" / "Plant_1_Weather_Sensor_Data.csv"
MODEL_PATH = ROOT / "models" / "energy_forecast_hourly.joblib"
METRICS_PATH = ROOT / "models" / "energy_forecast_metrics.json"

FEATURES = ["irradiance_w_m2", "ambient_temp_c", "hour_sin", "hour_cos"]
MIN_INTERVALS_PER_HOUR = 3
TEST_FRACTION = 0.2
MODEL_NAME = "RandomForest hourly (irradiance, ambient temperature, hour of day)"


def load_hourly():
    generation = pd.read_csv(GENERATION_CSV)
    weather = pd.read_csv(WEATHER_CSV)
    generation["DATE_TIME"] = pd.to_datetime(generation["DATE_TIME"], format="%d-%m-%Y %H:%M")
    weather["DATE_TIME"] = pd.to_datetime(weather["DATE_TIME"], format="ISO8601")

    plant = generation.groupby("DATE_TIME")["AC_POWER"].sum().rename("ac_kw")
    sensor = weather.groupby("DATE_TIME").agg(
        irradiation_kw_m2=("IRRADIATION", "mean"),
        ambient_temp_c=("AMBIENT_TEMPERATURE", "mean"),
    )
    merged = pd.concat([plant, sensor], axis=1, join="inner").dropna()

    hourly = merged.resample("h").agg(
        ac_kw=("ac_kw", "mean"),
        irradiance_w_m2=("irradiation_kw_m2", "mean"),
        ambient_temp_c=("ambient_temp_c", "mean"),
        intervals=("ac_kw", "count"),
    )
    hourly["irradiance_w_m2"] = hourly["irradiance_w_m2"] * 1000
    hourly = hourly[hourly["intervals"] >= MIN_INTERVALS_PER_HOUR].copy()
    # Mean kW over an hour equals kWh generated in that hour.
    hourly["energy_kwh"] = hourly["ac_kw"]
    hour = hourly.index.hour
    hourly["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    hourly["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    return hourly


def main():
    hourly = load_hourly()
    split = int(len(hourly) * (1 - TEST_FRACTION))
    train, test = hourly.iloc[:split], hourly.iloc[split:]

    model = RandomForestRegressor(n_estimators=300, min_samples_leaf=3, random_state=42, n_jobs=-1)
    model.fit(train[FEATURES], train["energy_kwh"])
    pred = model.predict(test[FEATURES])
    actual = test["energy_kwh"].to_numpy()

    # Naive baseline: average training energy for the same hour of day.
    hour_means = train.groupby(train.index.hour)["energy_kwh"].mean()
    baseline = test.index.hour.map(hour_means).to_numpy()

    residuals = actual - pred
    q10, q90 = np.quantile(residuals, [0.10, 0.90])

    importance = permutation_importance(
        model, test[FEATURES], actual, n_repeats=10, random_state=42, scoring="r2"
    )
    factors = sorted(
        (
            {"feature": name, "r2_drop": round(float(mean), 4)}
            for name, mean in zip(FEATURES, importance.importances_mean)
        ),
        key=lambda item: item["r2_drop"],
        reverse=True,
    )

    daylight = test["irradiance_w_m2"].to_numpy() > 0
    daily = pd.DataFrame({"actual": actual, "pred": pred}, index=test.index).resample("D").sum()
    daily = daily[test.resample("D")["energy_kwh"].count().reindex(daily.index).fillna(0) >= 20]

    metrics = {
        "model_name": MODEL_NAME,
        "features": FEATURES,
        "training_hours": int(len(train)),
        "holdout_hours": int(len(test)),
        "training_period": [str(train.index.min()), str(train.index.max())],
        "holdout_period": [str(test.index.min()), str(test.index.max())],
        "holdout": {
            "mae_kwh": round(float(mean_absolute_error(actual, pred)), 2),
            "rmse_kwh": round(float(np.sqrt(mean_squared_error(actual, pred))), 2),
            "r2": round(float(r2_score(actual, pred)), 4),
            "daylight_mae_kwh": round(float(mean_absolute_error(actual[daylight], pred[daylight])), 2),
        },
        "baseline_same_hour": {
            "mae_kwh": round(float(mean_absolute_error(actual, baseline)), 2),
            "rmse_kwh": round(float(np.sqrt(mean_squared_error(actual, baseline))), 2),
            "r2": round(float(r2_score(actual, baseline)), 4),
        },
        "residual_q10_kwh": round(float(q10), 2),
        "residual_q90_kwh": round(float(q90), 2),
        "factors": factors,
        "daily_backtest": [
            {"date": str(idx.date()), "actual_kwh": round(float(row.actual), 1), "predicted_kwh": round(float(row.pred), 1)}
            for idx, row in daily.iterrows()
        ],
        "data_source": "data/Plant_1_Generation_Data.csv and data/Plant_1_Weather_Sensor_Data.csv (real 2020 readings)",
    }

    MODEL_PATH.parent.mkdir(exist_ok=True)
    joblib.dump({"model": model, "features": FEATURES, "model_name": MODEL_NAME,
                 "residual_q10_kwh": float(q10), "residual_q90_kwh": float(q90)}, MODEL_PATH)
    METRICS_PATH.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps(metrics["holdout"], indent=2))
    print("baseline", json.dumps(metrics["baseline_same_hour"]))
    print("factors", factors)
    print("hours train/test", len(train), len(test))


if __name__ == "__main__":
    main()
