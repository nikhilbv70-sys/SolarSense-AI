(function () {
  const defaultApiBase = window.location.protocol + "//" + window.location.hostname + ":5000";
  const apiBase = (window.SOLARSENSE_API_BASE || defaultApiBase).replace(/\/+$/, "");

  async function readResponse(response) {
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error = new Error(data.error || "The request could not be completed.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function getCsrfToken() {
    const response = await fetch(apiBase + "/api/auth/csrf", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    const data = await readResponse(response);
    return data.csrf_token;
  }

  async function request(path, method, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["X-CSRF-Token"] = await getCsrfToken();

    const response = await fetch(apiBase + path, {
      method: method,
      credentials: "include",
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return readResponse(response);
  }

  function handleConnectionError(error) {
    if (error instanceof TypeError) {
      throw new Error("Cannot reach the Flask API. Start the backend on port 5000 and confirm PostgreSQL is running.");
    }
    throw error;
  }

  function handleRequest(path, method, body) {
    return request(path, method, body).catch(handleConnectionError);
  }

  window.SolarSenseApi = {
    external: function (route, params) {
      const query = new URLSearchParams(params || {}).toString();
      return fetch(apiBase + "/api/external/" + route + (query ? "?" + query : ""), {
        credentials: "include"
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          return { ok: response.ok, body: body };
        });
      });
    },
    timeMachineBaseline: function () {
      return handleRequest("/api/timemachine/baseline", "GET");
    },
    faultReplay: function (date) {
      return handleRequest("/api/faults/replay" + (date ? "?date=" + encodeURIComponent(date) : ""), "GET");
    },
    maintenancePriority: function () {
      return handleRequest("/api/priority", "GET");
    },
    maintenanceCost: function () {
      return handleRequest("/api/maintenance-cost", "GET");
    },
    governmentStateCapacity: function () {
      return handleRequest("/api/government/state-capacity", "GET");
    },
    governmentLive: function () {
      return handleRequest("/api/government/live", "GET");
    },
    updateAlertStatus: function (alertKey, status) {
      return handleRequest("/api/priority/" + encodeURIComponent(alertKey) + "/status", "POST", { status: status });
    },
    login: function (credentials) {
      return handleRequest("/api/auth/login", "POST", credentials);
    },
    register: function (details) {
      return handleRequest("/api/auth/register", "POST", details);
    },
    forgotPassword: function (details) {
      return handleRequest("/api/auth/forgot-password", "POST", details);
    },
    resetPassword: function (details) {
      return handleRequest("/api/auth/reset-password", "POST", details);
    },
    authConfig: function () {
      return handleRequest("/api/auth/config", "GET");
    },
    currentUser: function () {
      return handleRequest("/api/auth/me", "GET");
    },
    
    logout: function () {
      return handleRequest("/api/auth/logout", "POST", {});
    },
    predictSolarPower: function () {
      return handleRequest("/api/solar/predict", "GET");
    },
    forecastEnergy: function (horizon, location) {
      const params = new URLSearchParams({ horizon: horizon });
      if (location) {
        params.set("latitude", location.latitude);
        params.set("longitude", location.longitude);
      }
      return handleRequest("/api/forecast/energy?" + params.toString(), "GET");
    },
    forecastWeather: function (location) {
      const params = new URLSearchParams({ latitude: location.latitude, longitude: location.longitude });
      return handleRequest("/api/forecast/weather?" + params.toString(), "GET");
    },
    forecastRuns: function () {
      return handleRequest("/api/forecast/runs", "GET");
    },
    saveForecastRun: function (horizon, location) {
      return handleRequest("/api/forecast/runs", "POST", Object.assign({ horizon: horizon }, location || {}));
    },
    downloadForecastReport: function (horizon, location) {
      const params = new URLSearchParams({ horizon: horizon });
      if (location) {
        params.set("latitude", location.latitude);
        params.set("longitude", location.longitude);
      }
      return fetch(apiBase + "/api/forecast/report.csv?" + params.toString(), {
        credentials: "include"
      }).then(function (response) {
        if (!response.ok) {
          return readResponse(response);
        }
        return response.blob();
      }).catch(handleConnectionError);
    },
    getSettings: function () {
      return handleRequest("/api/settings", "GET");
    },
    saveSettings: function (settings) {
      return handleRequest("/api/settings", "PUT", settings);
    },
    getPlants: function () {
      return handleRequest("/api/settings/plants", "GET");
    },
    recoveryActions: function () {
      return handleRequest("/api/recovery/actions", "GET");
    },
    createRecoveryAction: function (action) {
      return handleRequest("/api/recovery/actions", "POST", action);
    }
  };

})();