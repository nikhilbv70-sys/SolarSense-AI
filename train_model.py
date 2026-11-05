
import os
import json
import joblib
import numpy as np
import pandas as pd

from sklearn.ensemble import (
    RandomForestRegressor,
    HistGradientBoostingRegressor
)
from sklearn.metrics import (
    mean_absolute_error,
    mean_squared_error,
    r2_score
)

# 1. Project configuration
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
MODEL_DIR = os.path.join(BASE_DIR, "models")

os.makedirs(MODEL_DIR, exist_ok=True)

print("\n========== SOLARSENSE AI ==========")
print("Starting model training...\n")

# 2. Load solar datasets
generation = pd.read_csv(
    os.path.join(DATA_DIR, "Plant_1_Generation_Data.csv")
)

weather = pd.read_csv(
    os.path.join(DATA_DIR, "Plant_1_Weather_Sensor_Data.csv")
)

print("Datasets loaded successfully!")

# 3. Process timestamps
generation["DATE_TIME"] = pd.to_datetime(
    generation["DATE_TIME"], dayfirst=True
)

weather["DATE_TIME"] = pd.to_datetime(
    weather["DATE_TIME"], dayfirst=True
)

# 4. Aggregate generation readings
generation = generation.groupby("DATE_TIME").agg({
    "AC_POWER": "sum",
    "DC_POWER": "sum",
    "DAILY_YIELD": "sum"
}).reset_index()

# 5. Aggregate weather readings
weather = weather.groupby("DATE_TIME").agg({
    "AMBIENT_TEMPERATURE": "mean",
    "MODULE_TEMPERATURE": "mean",
    "IRRADIATION": "mean"
}).reset_index()

# 6. Merge datasets
df = pd.merge(
    generation,
    weather,
    on="DATE_TIME",
    how="inner"
)

df = df.sort_values("DATE_TIME").reset_index(drop=True)

if len(df) < 20:
    raise ValueError("Not enough matching dataset records!")

print("Merged records:", len(df))

# 7. Create prediction features
df["hour"] = df["DATE_TIME"].dt.hour
df["day"] = df["DATE_TIME"].dt.day
df["month"] = df["DATE_TIME"].dt.month

df["power_lag_1"] = df["AC_POWER"].shift(1)
df["power_lag_2"] = df["AC_POWER"].shift(2)
df["power_lag_4"] = df["AC_POWER"].shift(4)

# Target: next recorded AC power
df["target"] = df["AC_POWER"].shift(-1)

df = df.dropna().reset_index(drop=True)

features = [
    "DC_POWER",
    "DAILY_YIELD",
    "AMBIENT_TEMPERATURE",
    "MODULE_TEMPERATURE",
    "IRRADIATION",
    "hour",
    "day",
    "month",
    "power_lag_1",
    "power_lag_2",
    "power_lag_4"
]

X = df[features]
y = df["target"]

# 8. Chronological train-test split
split = int(len(df) * 0.8)

X_train = X.iloc[:split]
X_test = X.iloc[split:]

y_train = y.iloc[:split]
y_test = y.iloc[split:]

print("Training records:", len(X_train))
print("Testing records:", len(X_test))

# 9. Define machine learning models
models = {
    "Random Forest": RandomForestRegressor(
        n_estimators=100,
        random_state=42,
        n_jobs=-1
    ),

    "HistGradientBoosting": HistGradientBoostingRegressor(
        max_iter=100,
        random_state=42
    )
}

results = {}
best_model = None
best_name = None
best_mae = float("inf")

# 10. Train and evaluate
for name, model in models.items():

    print(f"\nTraining {name}...")

    model.fit(X_train, y_train)

    predictions = model.predict(X_test)

    mae = mean_absolute_error(y_test, predictions)
    rmse = np.sqrt(mean_squared_error(y_test, predictions))
    r2 = r2_score(y_test, predictions)

    results[name] = {
        "MAE": float(mae),
        "RMSE": float(rmse),
        "R2": float(r2)
    }

    print("MAE:", round(mae, 3))
    print("RMSE:", round(rmse, 3))
    print("R2:", round(r2, 3))

    if mae < best_mae:
        best_mae = mae
        best_model = model
        best_name = name

# 11. Save trained model
joblib.dump(
    {
        "model": best_model,
        "features": features,
        "model_name": best_name
    },
    os.path.join(MODEL_DIR, "solar_forecast.joblib")
)

# 12. Save evaluation metrics
with open(
    os.path.join(MODEL_DIR, "model_metrics.json"),
    "w"
) as file:
    json.dump(results, file, indent=4)

# 13. Save test predictions
predictions = best_model.predict(X_test)

pd.DataFrame({
    "Actual_Power": y_test.values,
    "Predicted_Power": predictions
}).to_csv(
    os.path.join(MODEL_DIR, "test_predictions.csv"),
    index=False
)

print("\n================================")
print("SOLARSENSE AI TRAINING COMPLETE")
print("Best model:", best_name)
print("Best MAE:", round(best_mae, 3))
print("================================")
