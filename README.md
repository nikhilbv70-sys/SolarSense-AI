# SolarSense AI

SolarSense AI is a solar plant monitoring web app. It combines live plant readings, an hourly energy forecast, fault detection, a time machine for replaying past faults, maintenance tickets and cost tracking, and a government view of installed capacity across states.

## Features

- **Dashboard and monitoring**: plant readings, alerts, and status for the selected plant.
- **Energy forecast**: hourly energy prediction from a trained Random Forest model, plus weather and NASA POWER / PVGIS external data.
- **Fault detection and replay**: anomaly detection on plant readings and a replay view of past data.
- **Solar Energy Time Machine**: baseline and scenario calculations for past periods.
- **Maintenance**: priority queue, recovery actions, and ticket status updates.
- **Maintenance cost**: cost entries with estimates and calculations, in Indian Rupees (₹).
- **Authentication**: sign up, login, email-code password reset, and reCAPTCHA on forms.
- **Role-based access**: normal users see their own plants. Government users see state and department level data after an admin approves their account.
- **Settings**: per-user preferences and plant selection.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python, Flask, Flask-Cors, SQLAlchemy |
| Database | PostgreSQL (psycopg v3 driver) |
| ML | scikit-learn (Random Forest), pandas, numpy, joblib |
| Frontend | Static HTML, CSS, and vanilla JavaScript |
| Frontend server | Node.js (`frontend/server.js`), Vite as a dev dependency |

## Project layout

```
Hackathon/
├── backend/            Flask app, blueprints, DB setup, ML training, services
│   ├── app.py          Main Flask app (auth, plants, simulation, cost blueprint)
│   ├── database.py     SQLAlchemy engine built from DB_* env vars
│   ├── train_forecast.py
│   ├── *_routes.py     Blueprints: faults, forecast, priority, recovery, settings,
│   │                   timemachine, external, government, cost
│   ├── services/       NASA POWER and PVGIS clients
│   ├── scripts/        create_government_admin.py
│   ├── import_plant1.py
│   └── tests/          test_external.py
├── frontend/
│   ├── server.js       Static file server (port 4178)
│   ├── js/             Page scripts (auth, dashboard, forecast, government, cost, ...)
│   └── css/            Stylesheets
├── data/               Plant 1 generation and weather CSVs, district data
├── models/             Trained forecast models and metric JSON files
├── requirements.txt\requirments.txt   Python dependencies
├── solar_requirements.txt             Partial list (see note below)
├── package.json        npm scripts and Vite dev dependency
└── .env.example        Environment variable template
```

## Prerequisites

- Python 3.12 (a venv at `venv\` is used in development)
- Node.js (for the frontend server)
- PostgreSQL, running locally or remotely

## Setup

### 1. Create the Python environment

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r "requirements.txt\requirments.txt"
```

Note: `solar_requirements.txt` lists only pandas, numpy, scikit-learn, and joblib. It does not include Flask or the database driver, so use `requirements.txt\requirments.txt` for a full install.

### 2. Create the database

Create an empty PostgreSQL database, for example `solarsense`.

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in the values. The backend reads these variables, which are used to build the connection URL in `backend/database.py`:

| Variable | Purpose |
|---|---|
| `DB_USER` | PostgreSQL user |
| `DB_PASSWORD` | PostgreSQL password |
| `DB_HOST` | PostgreSQL host (for example `localhost`) |
| `DB_PORT` | PostgreSQL port (for example `5432`) |
| `DB_NAME` | Database name |
| `SECRET_KEY` | Flask session secret. Set it, or sessions reset on every restart |
| `APP_ENV` | `development` or `production` |
| `FRONTEND_ORIGINS` | Comma-separated origins allowed by CORS (for example `http://127.0.0.1:4178`) |
| `RECAPTCHA_SITE_KEY` / `RECAPTCHA_SECRET_KEY` | Google reCAPTCHA keys |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | Email sending for password reset codes |
| `INDIA_RENEWABLE_API_KEY`, `INDIA_RENEWABLE_RESOURCE_ID` | Optional, for India renewable data |

Note: `.env.example` has a `DATABASE_URL` line, but the code does not read it. Use the `DB_*` variables above.

Keep `.env` out of version control and never commit real keys.

### 4. Initialize the schema

```powershell
cd backend
python database.py
```

This creates the tables with `Base.metadata.create_all`.

### 5. Load Plant 1 data (optional)

```powershell
cd backend
python import_plant1.py
```

This imports `data/Plant_1_Generation_Data.csv` and `data/Plant_1_Weather_Sensor_Data.csv`.

### 6. Create a government admin (optional)

Government accounts need an approved admin. Set a password of at least 8 characters, then run:

```powershell
$env:SOLARSENSE_ADMIN_PASSWORD = "<a strong password>"
cd backend
python scripts\create_government_admin.py admin@example.com "Admin Name"
```

## Running the app

Start the backend API (port 5000):

```powershell
cd backend
python app.py
```

Start the frontend (port 4178), from the repo root in a second terminal:

```powershell
node frontend/server.js
```

Or use the npm scripts from the repo root: `npm run server` for the backend and `npm run dev` for the frontend.

Open `http://127.0.0.1:4178` in a browser. The frontend calls the API at `http://127.0.0.1:5000`.

## Ports

| Service | Address |
|---|---|
| Frontend | `http://127.0.0.1:4178` |
| Backend API | `http://127.0.0.1:5000` |
| PostgreSQL | `DB_HOST:DB_PORT` (default `5432`) |

## API overview

| Blueprint | Prefix (examples) |
|---|---|
| Auth, plants, simulation | `/api/...` in `app.py` (`/api/plants`, `/api/readings`, `/api/alerts`, `/api/predictions`, `/api/maintenance`, `/api/simulation/run`) |
| Forecast | `/api/forecast/weather`, `/energy`, `/runs`, `/report.csv` |
| Faults | `/api/faults/replay` |
| Time machine | `/api/timemachine/baseline` |
| Priority | `/api/priority`, `/api/priority/<alert_key>/status` |
| Recovery | `/api/recovery/actions` (GET, POST) |
| Settings | `/api/settings`, `/api/settings/plants` |
| External data | `/api/external/nasa-power`, `/api/external/pvgis` |
| Government | `/api/government/state-capacity`, `/api/government/live` |
| Cost | `/api/maintenance-cost` |

## Machine learning

- **Model**: Random Forest for hourly energy, saved at `models/energy_forecast_hourly.joblib`. A second model is at `models/solar_forecast.joblib`.
- **Training**: `backend/train_forecast.py` uses a chronological 80/20 train and test split (`TEST_FRACTION = 0.2`). Features are irradiance, ambient temperature, and sine/cosine of hour of day.
- **Scope**: this is a nowcast of current-hour output from weather inputs, not a day-ahead forecast.
- **Metrics**: `models/model_metrics.json` does not record its split, so do not quote it as a holdout result. Use the QA report below for measured numbers.

