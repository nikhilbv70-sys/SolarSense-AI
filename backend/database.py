
import os
from dotenv import load_dotenv
from sqlalchemy import (
    create_engine,
    text,
    Column,
    Integer,
    String,
    Float,
    Date,
    DateTime,
    ForeignKey,
    Boolean,
    func
)
from sqlalchemy.orm import declarative_base
from datetime import datetime, timezone

load_dotenv()

DATABASE_URL = (
    f"postgresql+psycopg://{os.getenv('DB_USER')}:"
    f"{os.getenv('DB_PASSWORD')}@"
    f"{os.getenv('DB_HOST')}:"
    f"{os.getenv('DB_PORT')}/"
    f"{os.getenv('DB_NAME')}"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
Base = declarative_base()

DEFAULT_TIMEZONE = "Asia/Singapore"
DEFAULT_ALERT_THRESHOLD_PCT = 15.0
ENERGY_UNITS = ("kWh", "MWh")

# Columns added after user_settings was first created. create_all does not alter existing tables.
SETTINGS_COLUMN_MIGRATIONS = (
    "ADD COLUMN IF NOT EXISTS plant_id INTEGER REFERENCES solar_plants(id) ON DELETE SET NULL",
    f"ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT '{DEFAULT_TIMEZONE}'",
    "ADD COLUMN IF NOT EXISTS tariff_per_kwh DOUBLE PRECISION",
    f"ADD COLUMN IF NOT EXISTS alert_threshold_pct DOUBLE PRECISION NOT NULL DEFAULT {DEFAULT_ALERT_THRESHOLD_PCT}",
    "ADD COLUMN IF NOT EXISTS energy_unit VARCHAR(4) NOT NULL DEFAULT 'kWh'",
)


def ensure_settings_columns():
    with engine.begin() as connection:
        for clause in SETTINGS_COLUMN_MIGRATIONS:
            connection.execute(text(f"ALTER TABLE user_settings {clause}"))


# Columns added to app_users for role-based access. Existing users default to normal_user and active.
USER_ROLE_MIGRATIONS = (
    "ADD COLUMN IF NOT EXISTS role VARCHAR(30) NOT NULL DEFAULT 'normal_user'",
    "ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'",
    "ADD COLUMN IF NOT EXISTS requested_role VARCHAR(30)",
    "ADD COLUMN IF NOT EXISTS organisation VARCHAR(150)",
)


def ensure_user_role_columns():
    with engine.begin() as connection:
        for clause in USER_ROLE_MIGRATIONS:
            connection.execute(text(f"ALTER TABLE app_users {clause}"))


def get_selected_plant(connection, user_id):
    """Plant chosen in Settings for this user, or the first plant when none is chosen."""
    return connection.execute(
        text("""
            SELECT id, plant_name, capacity_kw FROM solar_plants
            WHERE id = COALESCE(
                (SELECT plant_id FROM user_settings WHERE user_id = :user_id),
                (SELECT MIN(id) FROM solar_plants)
            )
        """),
        {"user_id": user_id},
    ).mappings().first()


# 1. Solar Plants
class SolarPlant(Base):
    __tablename__ = "solar_plants"

    id = Column(Integer, primary_key=True)
    plant_name = Column(String(150), nullable=False)
    location = Column(String(200))
    capacity_kw = Column(Float)
    created_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc))


# 2. Sensor Readings
class SensorReading(Base):
    __tablename__ = "sensor_readings"

    id = Column(Integer, primary_key=True)
    plant_id = Column(Integer, ForeignKey("solar_plants.id"))
    timestamp = Column(DateTime(timezone=True),
                       default=lambda: datetime.now(timezone.utc))
    irradiance = Column(Float)
    panel_temperature = Column(Float)
    voltage = Column(Float)
    current = Column(Float)
    power = Column(Float)
    expected_power = Column(Float)
    inverter_status = Column(String(50))


# 3. Anomaly Alerts
class AnomalyAlert(Base):
    __tablename__ = "anomaly_alerts"

    id = Column(Integer, primary_key=True)
    plant_id = Column(Integer, ForeignKey("solar_plants.id"))
    anomaly_type = Column(String(100))
    severity = Column(String(30))
    description = Column(String(500))
    confidence = Column(Float)
    created_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc))
    resolved = Column(Boolean, default=False)


# 4. Energy Predictions
class EnergyPrediction(Base):
    __tablename__ = "energy_predictions"

    id = Column(Integer, primary_key=True)
    plant_id = Column(Integer, ForeignKey("solar_plants.id"))
    prediction_date = Column(DateTime(timezone=True))
    predicted_energy = Column(Float)
    model_name = Column(String(100))
    created_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc))


# 5. Maintenance Recommendations
class MaintenanceRecommendation(Base):
    __tablename__ = "maintenance_recommendations"

    id = Column(Integer, primary_key=True)
    plant_id = Column(Integer, ForeignKey("solar_plants.id"))
    anomaly_id = Column(Integer, ForeignKey("anomaly_alerts.id"),
                        nullable=True)
    recommendation = Column(String(500))
    priority = Column(String(30))
    status = Column(String(30), default="Pending")
    created_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc))


# 5b. Maintenance alert workflow status (Open / Under Investigation / Resolved)
class AlertWorkflow(Base):
    __tablename__ = "alert_workflow"

    alert_key = Column(String(64), primary_key=True)
    plant_id = Column(Integer, ForeignKey("solar_plants.id"))
    status = Column(String(30), nullable=False, default="Open")
    updated_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc))


# 6. User accounts
class User(Base):
    __tablename__ = "app_users"

    id = Column(Integer, primary_key=True)
    full_name = Column(String(100), nullable=False)
    email = Column(String(254), nullable=False, unique=True, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(30), nullable=False, default="normal_user")
    status = Column(String(20), nullable=False, default="active")
    requested_role = Column(String(30), nullable=True)
    organisation = Column(String(150), nullable=True)
    created_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc),
                        server_default=func.now(),
                        nullable=False)


# 6b. One-time password reset codes (stored hashed, expire, limited attempts)
class PasswordResetOTP(Base):
    __tablename__ = "password_reset_otps"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True)
    code_hash = Column(String(255), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    attempts = Column(Integer, nullable=False, default=0)
    used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)


# 10. Audit trail for government and administrative actions
class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True)
    actor_user_id = Column(Integer, ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True)
    action = Column(String(80), nullable=False)
    target = Column(String(200))
    detail = Column(String(500))
    created_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc))


# 7. Per-user settings (weather location, forecast horizon, plant and display preferences)
class UserSettings(Base):
    __tablename__ = "user_settings"

    user_id = Column(Integer, ForeignKey("app_users.id", ondelete="CASCADE"), primary_key=True)
    latitude = Column(Float, nullable=False, default=22.0)
    longitude = Column(Float, nullable=False, default=79.0)
    default_horizon = Column(String(10), nullable=False, default="24h")
    plant_id = Column(Integer, ForeignKey("solar_plants.id", ondelete="SET NULL"), nullable=True)
    timezone = Column(String(64), nullable=False, default=DEFAULT_TIMEZONE)
    tariff_per_kwh = Column(Float, nullable=True)
    alert_threshold_pct = Column(Float, nullable=False, default=DEFAULT_ALERT_THRESHOLD_PCT)
    energy_unit = Column(String(4), nullable=False, default="kWh")
    updated_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc))


# 8. Saved energy forecast runs
class ForecastRun(Base):
    __tablename__ = "forecast_runs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False)
    horizon = Column(String(10), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    total_kwh = Column(Float, nullable=False)
    low_kwh = Column(Float, nullable=False)
    high_kwh = Column(Float, nullable=False)
    model_name = Column(String(150), nullable=False)
    created_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc))


# 9. Maintenance actions recorded by operators (used for before/after verification)
class MaintenanceAction(Base):
    __tablename__ = "maintenance_actions"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False)
    plant_id = Column(Integer, ForeignKey("solar_plants.id"))
    action_type = Column(String(60), nullable=False)
    performed_on = Column(Date, nullable=False)
    notes = Column(String(500))
    created_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc))


def initialize_database():
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))

        Base.metadata.create_all(bind=engine)

        print("PostgreSQL connected successfully!")
        print("SolarSense AI database tables created successfully!")

    except Exception as error:
        print("Database initialization failed!")
        print(error)


if __name__ == "__main__":
    initialize_database()
