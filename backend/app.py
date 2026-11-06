from pathlib import Path
import joblib
import pandas as pd
import random
import hmac
import os
import re
import secrets
import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

from flask import Flask, jsonify, request, session, send_from_directory
from flask_cors import CORS
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from werkzeug.security import check_password_hash, generate_password_hash

from database import Base, User, PasswordResetOTP, engine, ensure_settings_columns, ensure_user_role_columns
from mailer import MailError, send_reset_code
from auth_roles import REQUESTABLE_ROLES, NORMAL_ROLE, role_response
from external_routes import external_bp
from timemachine_routes import timemachine_bp
from faults_routes import faults_bp
from priority_routes import priority_bp
from cost_routes import cost_bp
from forecast_routes import forecast_bp
from settings_routes import settings_bp
from recovery_routes import recovery_bp
from government_routes import government_bp


# ==========================================
# SOLARSENSE AI - FLASK APPLICATION
# ==========================================

app = Flask(__name__)

# Serve the existing frontend from this same Flask/Render service.
# Project layout: frontend/assets and frontend/js (including frontend/js/css).
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


@app.route("/")
def home():
    return send_from_directory(FRONTEND_DIR / "js", "intro.html")


@app.route("/assets/<path:filename>")
def frontend_assets(filename):
    return send_from_directory(FRONTEND_DIR / "assets", filename)


@app.route("/js/<path:filename>")
def frontend_js(filename):
    return send_from_directory(FRONTEND_DIR / "js", filename)

app_environment = os.getenv("APP_ENV", "development").lower()
configured_secret = os.getenv("SECRET_KEY")
if app_environment == "production" and not configured_secret:
    raise RuntimeError("SECRET_KEY must be configured when APP_ENV=production.")
app.config.update(
    SECRET_KEY=configured_secret or secrets.token_hex(32),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv(
        "SESSION_COOKIE_SECURE",
        "true" if app_environment == "production" else "false"
    ).lower() == "true",
    PERMANENT_SESSION_LIFETIME=timedelta(days=7)
)
allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:4178,http://127.0.0.1:4178"
    ).split(",")
    if origin.strip()
]
CORS(
    app,
    resources={r"/api/*": {"origins": allowed_origins}},
    supports_credentials=True,
    allow_headers=["Content-Type", "X-CSRF-Token"],
    methods=["GET", "POST", "PUT", "OPTIONS"]
)
app.register_blueprint(external_bp)
app.register_blueprint(timemachine_bp)
app.register_blueprint(faults_bp)
app.register_blueprint(priority_bp)
app.register_blueprint(cost_bp)
app.register_blueprint(forecast_bp)
app.register_blueprint(settings_bp)
app.register_blueprint(recovery_bp)
app.register_blueprint(government_bp)


def ensure_user_table():
    User.__table__.create(bind=engine, checkfirst=True)
    Base.metadata.create_all(bind=engine)
    ensure_settings_columns()
    ensure_user_role_columns()


def user_response(user):
    return {
        "id": user["id"],
        "full_name": user["full_name"],
        "email": user["email"]
    }


def valid_csrf_token():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token", "")
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))


def csrf_error():
    return jsonify({"error": "Your session expired. Refresh the page and try again."}), 403


def verify_recaptcha(token):
    secret = os.getenv("RECAPTCHA_SECRET_KEY")
    if not secret:
        return True
    if not isinstance(token, str) or not token:
        return False
    payload = urllib.parse.urlencode({
        "secret": secret,
        "response": token,
        "remoteip": request.remote_addr or ""
    }).encode()
    try:
        with urllib.request.urlopen(
            "https://www.google.com/recaptcha/api/siteverify",
            data=payload,
            timeout=5
        ) as response:
            return json.load(response).get("success") is True
    except Exception:
        app.logger.exception("reCAPTCHA verification request failed.")
        return False


def captcha_error():
    return jsonify({"error": "Captcha verification failed. Please try again."}), 400


@app.route("/api/auth/config", methods=["GET"])
def auth_config():
    return jsonify({"recaptcha_site_key": os.getenv("RECAPTCHA_SITE_KEY", "")}), 200


@app.route("/api/auth/csrf", methods=["GET"])
def auth_csrf():
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return jsonify({"csrf_token": token}), 200


@app.route("/api/auth/register", methods=["POST"])
def register():
    if not valid_csrf_token():
        return csrf_error()

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Send the registration details as JSON."}), 400
    if not verify_recaptcha(data.get("captcha")):
        return captcha_error()

    full_name = data.get("name", "").strip() if isinstance(data.get("name"), str) else ""
    email = data.get("email", "").strip().lower() if isinstance(data.get("email"), str) else ""
    password = data.get("password", "")
    requested_role = data.get("access") or NORMAL_ROLE
    organisation = data.get("organisation", "").strip() if isinstance(data.get("organisation"), str) else ""

    if len(full_name) < 2 or len(full_name) > 100:
        return jsonify({"error": "Name must be between 2 and 100 characters."}), 400
    if len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify({"error": "Enter a valid email address."}), 400
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        return jsonify({"error": "Password must be between 8 and 128 characters."}), 400
    if requested_role != NORMAL_ROLE and requested_role not in REQUESTABLE_ROLES:
        return jsonify({"error": "Choose a valid access type."}), 400
    if len(organisation) > 150:
        return jsonify({"error": "Organisation name must be 150 characters or fewer."}), 400

    # Government access is never granted at signup. The account waits for approval.
    is_government_request = requested_role != NORMAL_ROLE
    status = "pending" if is_government_request else "active"

    try:
        ensure_user_table()
        with engine.begin() as connection:
            result = connection.execute(
                text("""
                    INSERT INTO app_users (full_name, email, password_hash, role, status, requested_role, organisation)
                    VALUES (:full_name, :email, :password_hash, :role, :status, :requested_role, :organisation)
                    RETURNING id, full_name, email
                """),
                {
                    "full_name": full_name,
                    "email": email,
                    "password_hash": generate_password_hash(password),
                    "role": NORMAL_ROLE,
                    "status": status,
                    "requested_role": requested_role if is_government_request else None,
                    "organisation": organisation or None
                }
            ).mappings().one()

        session.clear()
        session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify({
            "user": user_response(result),
            "role": NORMAL_ROLE,
            "status": status,
            "requested_role": requested_role if is_government_request else None,
            "redirect": "/js/login.html?registered=" + ("pending" if is_government_request else "1")
        }), 201
    except IntegrityError as error:
        constraint = getattr(getattr(error.orig, "diag", None), "constraint_name", "")
        if constraint == "ix_app_users_email" or "app_users.email" in str(error.orig):
            return jsonify({"error": "An account with this email already exists."}), 409
        app.logger.exception("Account registration violated a database constraint.")
        return jsonify({"error": "Account creation is temporarily unavailable."}), 503
    except SQLAlchemyError:
        app.logger.exception("Account registration failed because the database is unavailable.")
        return jsonify({"error": "Account creation is temporarily unavailable. Check the PostgreSQL connection and try again."}), 503


@app.route("/api/auth/login", methods=["POST"])
def login():
    if not valid_csrf_token():
        return csrf_error()

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Send the sign-in details as JSON."}), 400
    if not verify_recaptcha(data.get("captcha")):
        return captcha_error()
    email = data.get("email", "").strip().lower() if isinstance(data.get("email"), str) else ""
    password = data.get("password", "")
    if not email or not isinstance(password, str) or not password:
        return jsonify({"error": "Enter your email and password."}), 400

    try:
        ensure_user_table()
        with engine.connect() as connection:
            user = connection.execute(
                text("""
                    SELECT id, full_name, email, password_hash, role, status, requested_role, organisation
                    FROM app_users
                    WHERE email = :email
                """),
                {"email": email}
            ).mappings().first()

        if not user or not check_password_hash(user["password_hash"], password):
            return jsonify({"error": "Email or password is incorrect."}), 401

        session.clear()
        session.permanent = True
        session["user_id"] = user["id"]
        session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify({"user": user_response(user), **role_response(user)}), 200
    except SQLAlchemyError:
        app.logger.exception("Sign-in failed because the database is unavailable.")
        return jsonify({"error": "Sign-in is temporarily unavailable. Check the PostgreSQL connection and try again."}), 503


@app.route("/api/auth/me", methods=["GET"])
def auth_me():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "You are not signed in."}), 401

    try:
        ensure_user_table()
        with engine.connect() as connection:
            user = connection.execute(
                text("""
                    SELECT id, full_name, email, role, status, requested_role, organisation
                    FROM app_users
                    WHERE id = :user_id
                """),
                {"user_id": user_id}
            ).mappings().first()

        if not user:
            session.clear()
            return jsonify({"error": "You are not signed in."}), 401
        return jsonify({"user": user_response(user), **role_response(user)}), 200
    except SQLAlchemyError:
        app.logger.exception("Account lookup failed because the database is unavailable.")
        return jsonify({"error": "Account details are temporarily unavailable."}), 503


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    if not valid_csrf_token():
        return csrf_error()
    session.clear()
    return jsonify({"status": "success"}), 200


RESET_CODE_TTL = timedelta(minutes=10)
RESET_CODE_MAX_ATTEMPTS = 5
RESET_CODE_RESEND_SECONDS = 60
RESET_REQUEST_MESSAGE = "If an account exists for this email, a 6-digit code has been sent. It expires in 10 minutes."


@app.route("/api/auth/forgot-password", methods=["POST"])
def forgot_password():
    if not valid_csrf_token():
        return csrf_error()

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Send the request as JSON."}), 400
    if not verify_recaptcha(data.get("captcha")):
        return captcha_error()

    email = data.get("email", "").strip().lower() if isinstance(data.get("email"), str) else ""
    if len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify({"error": "Enter a valid email address."}), 400

    try:
        ensure_user_table()
        with engine.begin() as connection:
            user = connection.execute(
                text("SELECT id, full_name, email FROM app_users WHERE email = :email"),
                {"email": email}
            ).mappings().first()
            if not user:
                # Same response for unknown emails, so the form does not reveal which accounts exist.
                return jsonify({"status": "success", "message": RESET_REQUEST_MESSAGE}), 200

            latest = connection.execute(
                text("SELECT created_at FROM password_reset_otps WHERE user_id = :user_id ORDER BY created_at DESC LIMIT 1"),
                {"user_id": user["id"]}
            ).scalar()
            now = datetime.now(timezone.utc)
            if latest and (now - latest).total_seconds() < RESET_CODE_RESEND_SECONDS:
                return jsonify({"error": "A code was just sent. Wait one minute before requesting another."}), 429

            code = f"{secrets.randbelow(1000000):06d}"
            connection.execute(
                text("UPDATE password_reset_otps SET used_at = :now WHERE user_id = :user_id AND used_at IS NULL"),
                {"now": now, "user_id": user["id"]}
            )
            connection.execute(
                text("""
                    INSERT INTO password_reset_otps (user_id, code_hash, expires_at, attempts, created_at)
                    VALUES (:user_id, :code_hash, :expires_at, 0, :now)
                """),
                {
                    "user_id": user["id"],
                    "code_hash": generate_password_hash(code),
                    "expires_at": now + RESET_CODE_TTL,
                    "now": now
                }
            )
    except SQLAlchemyError:
        app.logger.exception("Password reset request failed because the database is unavailable.")
        return jsonify({"error": "Password reset is temporarily unavailable. Check the PostgreSQL connection and try again."}), 503

    try:
        send_reset_code(user["email"], user["full_name"], code)
    except MailError as error:
        app.logger.exception("Password reset email could not be sent.")
        return jsonify({"error": str(error)}), 503

    return jsonify({"status": "success", "message": RESET_REQUEST_MESSAGE}), 200


@app.route("/api/auth/reset-password", methods=["POST"])
def reset_password():
    if not valid_csrf_token():
        return csrf_error()

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Send the reset details as JSON."}), 400

    email = data.get("email", "").strip().lower() if isinstance(data.get("email"), str) else ""
    code = data.get("code", "").strip() if isinstance(data.get("code"), str) else ""
    password = data.get("password", "")

    if not re.fullmatch(r"\d{6}", code):
        return jsonify({"error": "Enter the 6-digit code from your email."}), 400
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        return jsonify({"error": "Password must be between 8 and 128 characters."}), 400

    invalid_code = jsonify({"error": "The code is incorrect or has expired. Request a new code."})
    try:
        ensure_user_table()
        with engine.begin() as connection:
            user = connection.execute(
                text("SELECT id FROM app_users WHERE email = :email"),
                {"email": email}
            ).mappings().first()
            if not user:
                return invalid_code, 400

            otp = connection.execute(
                text("""
                    SELECT id, code_hash, expires_at, attempts
                    FROM password_reset_otps
                    WHERE user_id = :user_id AND used_at IS NULL
                    ORDER BY created_at DESC
                    LIMIT 1
                """),
                {"user_id": user["id"]}
            ).mappings().first()

            now = datetime.now(timezone.utc)
            if not otp or otp["expires_at"] < now:
                return invalid_code, 400
            if otp["attempts"] >= RESET_CODE_MAX_ATTEMPTS:
                return jsonify({"error": "Too many wrong attempts. Request a new code."}), 429

            connection.execute(
                text("UPDATE password_reset_otps SET attempts = attempts + 1 WHERE id = :id"),
                {"id": otp["id"]}
            )
            if not check_password_hash(otp["code_hash"], code):
                return invalid_code, 400

            connection.execute(
                text("UPDATE app_users SET password_hash = :password_hash WHERE id = :user_id"),
                {"password_hash": generate_password_hash(password), "user_id": user["id"]}
            )
            connection.execute(
                text("UPDATE password_reset_otps SET used_at = :now WHERE user_id = :user_id AND used_at IS NULL"),
                {"now": now, "user_id": user["id"]}
            )
            connection.execute(
                text("INSERT INTO audit_logs (actor_user_id, action, target, detail) VALUES (:user_id, 'password_reset', :target, 'Password reset with email code')"),
                {"user_id": user["id"], "target": email}
            )
    except SQLAlchemyError:
        app.logger.exception("Password reset failed because the database is unavailable.")
        return jsonify({"error": "Password reset is temporarily unavailable. Check the PostgreSQL connection and try again."}), 503

    return jsonify({"status": "success", "message": "Password updated. Sign in with your new password."}), 200


# ==========================================
# 1. HEALTH CHECK API
# ==========================================

@app.route("/api/health", methods=["GET"])
def health():
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))

        return jsonify({
            "status": "success",
            "message": "SolarSense AI backend is connected to PostgreSQL!"
        }), 200

    except Exception as error:
        return jsonify({
            "status": "error",
            "message": str(error)
        }), 500


# ==========================================
# 2. GET SOLAR PLANTS
# ==========================================

@app.route("/api/plants", methods=["GET"])
def get_plants():
    try:
        with engine.connect() as connection:
            result = connection.execute(
                text("SELECT * FROM solar_plants ORDER BY id")
            )

            plants = [dict(row._mapping) for row in result]

        return jsonify(plants), 200

    except Exception as error:
        return jsonify({"error": str(error)}), 500


# ==========================================
# 3. ADD A SOLAR PLANT
# ==========================================

@app.route("/api/plants", methods=["POST"])
def add_plant():
    data = request.get_json(silent=True) or {}

    if not data.get("plant_name"):
        return jsonify({
            "error": "plant_name is required"
        }), 400

    try:
        with engine.begin() as connection:
            result = connection.execute(
                text("""
                    INSERT INTO solar_plants
                    (plant_name, location, capacity_kw)
                    VALUES (:name, :location, :capacity)
                    RETURNING id, plant_name, location, capacity_kw
                """),
                {
                    "name": data["plant_name"],
                    "location": data.get("location"),
                    "capacity": data.get("capacity_kw")
                }
            )

            plant = dict(result.fetchone()._mapping)

        return jsonify(plant), 201

    except Exception as error:
        return jsonify({"error": str(error)}), 500


# ==========================================
# 4. GET SENSOR READINGS
# ==========================================

@app.route("/api/readings", methods=["GET"])
def get_readings():
    try:
        with engine.connect() as connection:
            result = connection.execute(
                text("""
                    SELECT * FROM sensor_readings
                    ORDER BY timestamp DESC
                    LIMIT 100
                """)
            )

            readings = [dict(row._mapping) for row in result]

        return jsonify(readings), 200

    except Exception as error:
        return jsonify({"error": str(error)}), 500


# ==========================================
# 5. GET ANOMALY ALERTS
# ==========================================

@app.route("/api/alerts", methods=["GET"])
def get_alerts():
    try:
        with engine.connect() as connection:
            result = connection.execute(
                text("""
                    SELECT * FROM anomaly_alerts
                    ORDER BY created_at DESC
                    LIMIT 100
                """)
            )

            alerts = [dict(row._mapping) for row in result]

        return jsonify(alerts), 200

    except Exception as error:
        return jsonify({"error": str(error)}), 500


# ==========================================
# 6. GET ENERGY PREDICTIONS
# ==========================================

@app.route("/api/predictions", methods=["GET"])
def get_predictions():
    try:
        with engine.connect() as connection:
            result = connection.execute(
                text("""
                    SELECT * FROM energy_predictions
                    ORDER BY prediction_date DESC
                    LIMIT 100
                """)
            )

            predictions = [dict(row._mapping) for row in result]

        return jsonify(predictions), 200

    except Exception as error:
        return jsonify({"error": str(error)}), 500


# ==========================================
# 7. GET MAINTENANCE RECOMMENDATIONS
# ==========================================

@app.route("/api/maintenance", methods=["GET"])
def get_maintenance():
    try:
        with engine.connect() as connection:
            result = connection.execute(
                text("""
                    SELECT * FROM maintenance_recommendations
                    ORDER BY created_at DESC
                    LIMIT 100
                """)
            )

            recommendations = [
                dict(row._mapping) for row in result
            ]

        return jsonify(recommendations), 200

    except Exception as error:
        return jsonify({"error": str(error)}), 500


# ==========================================
# 8. SOLAR DATA SIMULATION
# ==========================================

@app.route("/api/simulation/run", methods=["POST"])
def run_simulation():

    try:
        generated = 0
        anomaly_count = 0
        samples = []

        with engine.begin() as connection:

            # Find an existing solar plant
            plant = connection.execute(
                text("""
                    SELECT id, capacity_kw
                    FROM solar_plants
                    ORDER BY id
                    LIMIT 1
                """)
            ).fetchone()

            # Create a demo plant if none exists
            if plant is None:
                plant = connection.execute(
                    text("""
                        INSERT INTO solar_plants
                        (plant_name, location, capacity_kw)
                        VALUES (
                            'SolarSense Demo Plant',
                            'Demo Location',
                            100.0
                        )
                        RETURNING id, capacity_kw
                    """)
                ).fetchone()

            plant_id = plant.id
            capacity = plant.capacity_kw or 100.0

            # Generate 12 simulated sensor readings
            for i in range(12):

                irradiance = random.uniform(450, 1000)
                temperature = random.uniform(25, 65)

                expected_power = (
                    capacity * (irradiance / 1000) * 0.82
                )

                # Simulate two underperformance events
                if i in (3, 8):
                    performance_factor = random.uniform(0.50, 0.65)
                else:
                    performance_factor = random.uniform(0.88, 1.05)

                actual_power = expected_power * performance_factor

                voltage = random.uniform(550, 650)

                current = (
                    actual_power * 1000 / voltage
                    if voltage > 0 else 0
                )

                # Flag output below 80% of expected power
                is_anomaly = (
                    actual_power < expected_power * 0.80
                )

                timestamp = (
                    datetime.now(timezone.utc)
                    - timedelta(minutes=(11 - i) * 5)
                )

                inverter_status = (
                    "Warning" if is_anomaly else "Normal"
                )

                # Save sensor reading
                connection.execute(
                    text("""
                        INSERT INTO sensor_readings
                        (
                            plant_id,
                            timestamp,
                            irradiance,
                            panel_temperature,
                            voltage,
                            current,
                            power,
                            expected_power,
                            inverter_status
                        )
                        VALUES
                        (
                            :plant_id,
                            :timestamp,
                            :irradiance,
                            :temperature,
                            :voltage,
                            :current,
                            :power,
                            :expected,
                            :status
                        )
                    """),
                    {
                        "plant_id": plant_id,
                        "timestamp": timestamp,
                        "irradiance": round(irradiance, 2),
                        "temperature": round(temperature, 2),
                        "voltage": round(voltage, 2),
                        "current": round(current, 2),
                        "power": round(actual_power, 2),
                        "expected": round(expected_power, 2),
                        "status": inverter_status
                    }
                )

                generated += 1

                # Save anomaly alert when required
                if is_anomaly:

                    anomaly_count += 1

                    connection.execute(
                        text("""
                            INSERT INTO anomaly_alerts
                            (
                                plant_id,
                                anomaly_type,
                                severity,
                                description,
                                confidence
                            )
                            VALUES
                            (
                                :plant_id,
                                :type,
                                :severity,
                                :description,
                                :confidence
                            )
                        """),
                        {
                            "plant_id": plant_id,
                            "type": "Power Underperformance",
                            "severity": "High",
                            "description": (
                                f"Simulated power output "
                                f"{actual_power:.2f} kW is below "
                                f"expected output "
                                f"{expected_power:.2f} kW. "
                                "Possible causes require investigation."
                            ),
                            "confidence": 0.80
                        }
                    )

                samples.append({
                    "timestamp": timestamp.isoformat(),
                    "irradiance": round(irradiance, 2),
                    "temperature": round(temperature, 2),
                    "actual_power": round(actual_power, 2),
                    "expected_power": round(expected_power, 2),
                    "status": inverter_status
                })

        return jsonify({
            "status": "success",
            "message": "Solar simulation completed!",
            "plant_id": plant_id,
            "readings_generated": generated,
            "anomalies_detected": anomaly_count,
            "simulation_data": samples
        }), 200

    except Exception as error:
        return jsonify({
            "status": "error",
            "message": str(error)
        }), 500

# ==========================================
# SOLARSENSE AI - MODEL INTEGRATION
# ==========================================

MODEL_PATH = (
    Path(__file__).resolve().parent.parent
    / "models"
    / "solar_forecast.joblib"
)

solar_model_bundle = None

if MODEL_PATH.exists():
    solar_model_bundle = joblib.load(MODEL_PATH)
    print("SolarSense AI model loaded successfully!")
else:
    print("SolarSense AI model file not found!")


# ==========================================
# SOLAR POWER PREDICTION API
# ==========================================
@app.route("/api/solar/predict", methods=["GET"])
def predict_solar_power():

    try:
        if solar_model_bundle is None:
            return jsonify({
                "status": "error",
                "message": "AI model is not loaded"
            }), 503

        # Locate the existing project datasets
        base_dir = Path(__file__).resolve().parent.parent
        data_dir = base_dir / "data"

        generation_path = data_dir / "Plant_1_Generation_Data.csv"
        weather_path = data_dir / "Plant_1_Weather_Sensor_Data.csv"

        if not generation_path.exists() or not weather_path.exists():
            return jsonify({
                "status": "error",
                "message": "Solar dataset files were not found"
            }), 404

        # Load datasets
        generation = pd.read_csv(generation_path)
        weather = pd.read_csv(weather_path)

        generation["DATE_TIME"] = pd.to_datetime(
            generation["DATE_TIME"]
        )
        weather["DATE_TIME"] = pd.to_datetime(
            weather["DATE_TIME"]
        )

        # Aggregate generation data
        generation = generation.groupby("DATE_TIME").agg({
            "AC_POWER": "sum",
            "DC_POWER": "sum",
            "DAILY_YIELD": "sum"
        }).reset_index()

        # Aggregate weather data
        weather = weather.groupby("DATE_TIME").agg({
            "AMBIENT_TEMPERATURE": "mean",
            "MODULE_TEMPERATURE": "mean",
            "IRRADIATION": "mean"
        }).reset_index()

        # Merge and sort
        df = pd.merge(
            generation,
            weather,
            on="DATE_TIME",
            how="inner"
        )

        df = df.sort_values("DATE_TIME").reset_index(drop=True)

        if len(df) < 5:
            return jsonify({
                "status": "error",
                "message": "Not enough records to prepare AI features"
            }), 400

        # Prepare the same features used during training
        df["hour"] = df["DATE_TIME"].dt.hour
        df["day"] = df["DATE_TIME"].dt.day
        df["month"] = df["DATE_TIME"].dt.month

        df["power_lag_1"] = df["AC_POWER"].shift(1)
        df["power_lag_2"] = df["AC_POWER"].shift(2)
        df["power_lag_4"] = df["AC_POWER"].shift(4)

        required_features = solar_model_bundle["features"]

        latest = df.iloc[-1]
        input_data = pd.DataFrame(
            [[float(latest[feature]) for feature in required_features]],
            columns=required_features
        )

        if input_data.isna().any().any():
            return jsonify({
                "status": "error",
                "message": "Latest dataset record contains missing features"
            }), 400

        # Generate prediction
        model = solar_model_bundle["model"]
        prediction = float(model.predict(input_data)[0])

        return jsonify({
            "status": "success",
            "model": solar_model_bundle["model_name"],
            "predicted_power": round(prediction, 3),
            "unit": "dataset AC_POWER units",
            "source": "Plant 1 historical dataset",
            "last_record_time": latest["DATE_TIME"].isoformat()
        }), 200

    except Exception as error:
        app.logger.exception("Solar prediction failed")

        return jsonify({
            "status": "error",
            "message": "Prediction could not be completed"
        }), 500

# ==========================================
# START FLASK SERVER
# KEEP THIS AT THE VERY BOTTOM
# ==========================================

if __name__ == "__main__":
    print("Starting SolarSense AI backend...")

    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )
