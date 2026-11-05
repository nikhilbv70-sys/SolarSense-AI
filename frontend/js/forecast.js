(function () {
  const $ = function (id) { return document.getElementById(id); };
  const HORIZON_NOTE = "Forecast values are model estimates, not measured generation.";
  let horizon = "24h";
  let location = null;
  let energyUnit = "kWh";
  let initialised = false;
  let lastData = null;
  const charts = {};

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fmt(value, digits) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "–";
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits === undefined ? 0 : digits });
  }

  function themeColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue("--text").trim() || "#1f2a37",
      muted: style.getPropertyValue("--muted").trim() || "#5b6675",
      border: style.getPropertyValue("--border").trim() || "#d6d2c4",
      accent: style.getPropertyValue("--accent").trim() || "#2e8b57",
      amber: style.getPropertyValue("--amber").trim() || "#b7791f"
    };
  }

  function setStatus(message, isError) {
    const node = $("forecast-status");
    node.textContent = message || "";
    node.classList.toggle("is-error", !!isError);
  }

  function destroyCharts() {
    Object.keys(charts).forEach(function (key) {
      charts[key].destroy();
      delete charts[key];
    });
  }

  function chartOptions(colors, yTitle) {
    return {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: colors.text } } },
      scales: {
        x: { ticks: { color: colors.muted, maxTicksLimit: 12 }, grid: { color: colors.border } },
        y: {
          title: { display: true, text: yTitle, color: colors.muted },
          ticks: { color: colors.muted },
          grid: { color: colors.border }
        }
      }
    };
  }

  function renderTotals(data) {
    const grid = $("forecast-totals");
    grid.replaceChildren();
    const divisor = energyUnit === "MWh" ? 1000 : 1;
    const total = function (value) { return value === null || value === undefined ? null : Number(value) / divisor; };
    const digits = energyUnit === "MWh" ? 3 : 0;
    const cards = [
      ["Predicted generation", fmt(total(data.totals.predicted_kwh), digits) + " " + energyUnit, "Model estimate"],
      ["Confidence low", fmt(total(data.totals.low_kwh), digits) + " " + energyUnit, "Approximate lower bound"],
      ["Confidence high", fmt(total(data.totals.high_kwh), digits) + " " + energyUnit, "Approximate upper bound"],
      ["Horizon", data.horizon_label, data.hourly.length + " hourly steps"]
    ];
    cards.forEach(function (item) {
      const card = el("article", "metric-card");
      card.appendChild(el("span", "", item[0]));
      card.appendChild(el("strong", "", item[1]));
      card.appendChild(el("small", "", item[2]));
      grid.appendChild(card);
    });
  }

  function renderHourlyChart(data, colors) {
    const labels = data.hourly.map(function (p) { return p.time.replace("T", " ").slice(0, 16); });
    charts.hourly = new Chart($("forecast-hourly-chart"), {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          { label: "Low (forecast)", data: data.hourly.map(function (p) { return p.low_kwh; }), borderColor: "transparent", pointRadius: 0, fill: false },
          { label: "Confidence band", data: data.hourly.map(function (p) { return p.high_kwh; }), borderColor: "transparent", backgroundColor: "rgba(46,139,87,0.15)", pointRadius: 0, fill: "-1" },
          { label: "Predicted kWh (forecast)", data: data.hourly.map(function (p) { return p.predicted_kwh; }), borderColor: colors.accent, backgroundColor: colors.accent, pointRadius: 0, tension: 0.25, fill: false }
        ]
      },
      options: chartOptions(colors, "kWh per hour")
    });
  }

  function renderDailyChart(data, colors) {
    charts.daily = new Chart($("forecast-daily-chart"), {
      type: "bar",
      data: {
        labels: data.daily.map(function (d) { return d.date; }),
        datasets: [
          { label: "Predicted kWh (forecast)", data: data.daily.map(function (d) { return d.predicted_kwh; }), backgroundColor: colors.accent },
          { label: "Low", type: "line", data: data.daily.map(function (d) { return d.low_kwh; }), borderColor: colors.amber, borderDash: [4, 4], pointRadius: 2, fill: false },
          { label: "High", type: "line", data: data.daily.map(function (d) { return d.high_kwh; }), borderColor: colors.amber, borderDash: [4, 4], pointRadius: 2, fill: false }
        ]
      },
      options: chartOptions(colors, "kWh per day")
    });
  }

  function renderBacktest(data, colors) {
    const rows = data.backtest || [];
    charts.backtest = new Chart($("forecast-backtest-chart"), {
      type: "line",
      data: {
        labels: rows.map(function (r) { return r.date; }),
        datasets: [
          { label: "Actual kWh (measured)", data: rows.map(function (r) { return r.actual_kwh; }), borderColor: colors.text, pointRadius: 3, fill: false },
          { label: "Predicted kWh (model)", data: rows.map(function (r) { return r.predicted_kwh; }), borderColor: colors.accent, borderDash: [5, 4], pointRadius: 3, fill: false }
        ]
      },
      options: chartOptions(colors, "kWh per day")
    });

    const wrap = $("forecast-backtest-table");
    wrap.replaceChildren();
    const table = el("table", "module-table");
    const head = el("thead");
    const headRow = el("tr");
    ["Date", "Actual kWh (measured)", "Predicted kWh", "Difference kWh", "Error %"].forEach(function (text) {
      headRow.appendChild(el("th", "", text));
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el("tbody");
    rows.forEach(function (r) {
      const diff = r.predicted_kwh - r.actual_kwh;
      const row = el("tr");
      row.appendChild(el("td", "", r.date));
      row.appendChild(el("td", "", fmt(r.actual_kwh, 1)));
      row.appendChild(el("td", "", fmt(r.predicted_kwh, 1)));
      row.appendChild(el("td", "", fmt(diff, 1)));
      row.appendChild(el("td", "", r.actual_kwh ? fmt((diff / r.actual_kwh) * 100, 1) + "%" : "–"));
      body.appendChild(row);
    });
    table.appendChild(body);
    wrap.appendChild(table);
  }

  function renderHourlyRows(data) {
    const body = $("forecast-hourly-rows");
    body.replaceChildren();
    data.hourly.forEach(function (p) {
      const row = el("tr");
      row.appendChild(el("td", "", p.time.replace("T", " ").slice(0, 16)));
      row.appendChild(el("td", "", fmt(p.predicted_kwh, 1)));
      row.appendChild(el("td", "", fmt(p.low_kwh, 1)));
      row.appendChild(el("td", "", fmt(p.high_kwh, 1)));
      row.appendChild(el("td", "", p.ambient_temp_c === null || p.ambient_temp_c === undefined ? "–" : fmt(p.ambient_temp_c, 1)));
      body.appendChild(row);
    });
  }

  function renderWarnings(data) {
    const box = $("forecast-warnings");
    box.replaceChildren();
    if (!data.warnings.length) {
      box.appendChild(el("p", "module-text", "No days fall below the low-generation threshold of " +
        fmt(data.low_generation_threshold_kwh) + " kWh (50% of the median daily output in the held-out data)."));
      return;
    }
    const list = el("ul", "module-list");
    data.warnings.forEach(function (w) { list.appendChild(el("li", "", w.date + ": " + w.message)); });
    box.appendChild(list);
  }

  function renderFactors(data) {
    const box = $("forecast-factors");
    box.replaceChildren();
    const factors = data.factors.slice().sort(function (a, b) { return b.r2_drop - a.r2_drop; });
    const max = Math.max.apply(null, factors.map(function (f) { return Math.max(f.r2_drop, 0); }).concat([0.0001]));
    factors.forEach(function (f) {
      const wrap = el("div", "");
      wrap.appendChild(el("div", "", labelFeature(f.feature) + " · importance " + fmt(f.r2_drop, 3)));
      const bar = el("div", "module-bar");
      const fill = el("span");
      fill.style.width = Math.max(0, Math.min(100, (Math.max(f.r2_drop, 0) / max) * 100)) + "%";
      bar.appendChild(fill);
      wrap.appendChild(bar);
      box.appendChild(wrap);
    });
    box.appendChild(el("p", "chart-caption", "Irradiance drives almost all of the prediction. Ambient temperature and hour of day add almost nothing on this data."));
  }

  function labelFeature(name) {
    const labels = {
      irradiance_w_m2: "Irradiance (W/m²)",
      ambient_temp_c: "Ambient temperature (°C)",
      hour_sin: "Hour of day (sine)",
      hour_cos: "Hour of day (cosine)"
    };
    return labels[name] || name;
  }

  function renderMetrics(data) {
    const box = $("forecast-metrics");
    box.replaceChildren();
    const h = data.model.holdout;
    const b = data.model.baseline_same_hour;
    const grid = el("div", "module-kv");
    [
      ["MAE (kWh/hour)", fmt(h.mae_kwh, 1)],
      ["RMSE (kWh/hour)", fmt(h.rmse_kwh, 1)],
      ["R²", fmt(h.r2, 4)]
    ].forEach(function (item) {
      const cell = el("div");
      cell.appendChild(el("span", "", item[0]));
      cell.appendChild(el("strong", "", item[1]));
      grid.appendChild(cell);
    });
    box.appendChild(grid);
    box.appendChild(el("p", "chart-caption",
      "Measured on " + data.model.holdout_hours + " hours from " + data.model.holdout_period[0] + " to " +
      data.model.holdout_period[1] + ", not used in training. Baseline (average training output for the same hour of day): MAE " +
      fmt(b.mae_kwh, 1) + " kWh, RMSE " + fmt(b.rmse_kwh, 1) + ", R² " + fmt(b.r2, 4) + "."));
    box.appendChild(el("p", "chart-caption", "Model: " + data.model.name + ". Accuracy comes from 2020 Plant 1 data only."));
  }

  function renderWeather(weather) {
    const box = $("forecast-weather");
    box.replaceChildren();
    const c = weather.current || {};
    const u = weather.current_units || {};
    const grid = el("div", "module-kv");
    [
      ["Temperature", c.temperature_2m, u.temperature_2m || "°C"],
      ["Cloud cover", c.cloud_cover, u.cloud_cover || "%"],
      ["Rain", c.rain, u.rain || "mm"],
      ["Wind gusts", c.wind_gusts_10m, u.wind_gusts_10m || "km/h"],
      ["Pressure", c.pressure_msl, u.pressure_msl || "hPa"]
    ].forEach(function (item) {
      const cell = el("div");
      cell.appendChild(el("span", "", item[0]));
      cell.appendChild(el("strong", "", item[1] === undefined || item[1] === null ? "–" : fmt(item[1], 1) + " " + item[2]));
      grid.appendChild(cell);
    });
    box.appendChild(grid);
    box.appendChild(el("p", "chart-caption", "Current conditions from Open-Meteo for the selected location."));
  }

  function renderAssumptions(data) {
    const list = $("forecast-assumptions");
    list.replaceChildren();
    data.assumptions.forEach(function (text) { list.appendChild(el("li", "", text)); });
  }

  function renderRuns(runs) {
    const box = $("forecast-runs");
    box.replaceChildren();
    if (!runs.length) {
      box.appendChild(el("p", "chart-caption", "No saved runs yet. Use Save run to keep a forecast in PostgreSQL."));
      return;
    }
    const table = el("table", "module-table");
    const head = el("tr");
    ["Saved", "Horizon", "Predicted kWh", "Low kWh", "High kWh"].forEach(function (text) { head.appendChild(el("th", "", text)); });
    table.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    runs.slice(0, 20).forEach(function (run) {
      const row = el("tr");
      row.appendChild(el("td", "", String(run.created_at || "").replace("T", " ").slice(0, 16)));
      row.appendChild(el("td", "", run.horizon));
      row.appendChild(el("td", "", fmt(run.total_kwh, 1)));
      row.appendChild(el("td", "", fmt(run.low_kwh, 1)));
      row.appendChild(el("td", "", fmt(run.high_kwh, 1)));
      body.appendChild(row);
    });
    table.appendChild(body);
    box.appendChild(table);
  }

  function showUnavailable(data) {
    const box = $("forecast-unavailable");
    box.textContent = data.reason || "This forecast is unavailable.";
    box.hidden = false;
    $("forecast-totals").replaceChildren();
    ["forecast-hourly-rows", "forecast-warnings", "forecast-factors", "forecast-metrics", "forecast-assumptions", "forecast-backtest-table"].forEach(function (id) {
      $(id).replaceChildren();
    });
    destroyCharts();
  }

  function render(data) {
    lastData = data;
    destroyCharts();
    const unavailable = $("forecast-unavailable");
    if (!data.available) {
      showUnavailable(data);
      setStatus("", false);
      return;
    }
    unavailable.hidden = true;
    const colors = themeColors();
    Chart.defaults.color = colors.muted;
    $("prediction-subtitle").textContent =
      "Forecast for " + data.location.latitude + ", " + data.location.longitude + " (" + data.location.timezone + "). " + HORIZON_NOTE;
    renderTotals(data);
    renderHourlyChart(data, colors);
    renderDailyChart(data, colors);
    renderBacktest(data, colors);
    renderHourlyRows(data);
    renderWarnings(data);
    renderFactors(data);
    renderMetrics(data);
    renderAssumptions(data);
    $("forecast-generated").textContent = "Generated " + data.generated_at.replace("T", " ") + ". Forecast values are never measured generation.";
  }

  function setHorizonButtons() {
    document.querySelectorAll("#prediction-view [data-horizon]").forEach(function (button) {
      const selected = button.dataset.horizon === horizon;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function load() {
    setStatus("Loading forecast…", false);
    return window.SolarSenseApi.forecastEnergy(horizon, location)
      .then(function (data) {
        render(data);
        setStatus("", false);
      })
      .catch(function (error) {
        destroyCharts();
        setStatus(error.message || "The forecast could not be loaded.", true);
      });
  }

  function loadWeather() {
    const spot = location || { latitude: 22, longitude: 79 };
    return window.SolarSenseApi.forecastWeather(spot)
      .then(renderWeather)
      .catch(function (error) {
        $("forecast-weather").replaceChildren(el("p", "chart-caption", error.message || "Weather inputs are unavailable."));
      });
  }

  function loadRuns() {
    return window.SolarSenseApi.forecastRuns()
      .then(function (data) { renderRuns(data.runs || []); })
      .catch(function () {
        $("forecast-runs").replaceChildren(el("p", "chart-caption", "Sign in to view saved runs."));
      });
  }

  function loadSettingsDefaults() {
    return window.SolarSenseApi.getSettings()
      .then(function (data) {
        const s = data.settings;
        location = { latitude: s.latitude, longitude: s.longitude };
        energyUnit = s.energy_unit === "MWh" ? "MWh" : "kWh";
        if (s.default_horizon && s.default_horizon !== horizon && !initialised) {
          horizon = s.default_horizon;
        }
      })
      .catch(function () { /* Signed out: fall back to the backend default location. */ });
  }

  function saveRun() {
    const button = $("forecast-save");
    button.disabled = true;
    window.SolarSenseApi.saveForecastRun(horizon, location)
      .then(function () {
        setStatus("Forecast run saved to PostgreSQL.", false);
        loadRuns();
      })
      .catch(function (error) {
        setStatus(error.message || "The run could not be saved.", true);
      })
      .finally(function () { button.disabled = false; });
  }

  function download() {
    setStatus("Preparing report…", false);
    window.SolarSenseApi.downloadForecastReport(horizon, location)
      .then(function (blob) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "solarsense-forecast-" + horizon + ".csv";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        setStatus("Report downloaded. It contains forecast values only.", false);
      })
      .catch(function (error) {
        setStatus(error.message || "The report could not be downloaded. Sign in to download reports.", true);
      });
  }

  function init() {
    initialised = true;
    document.querySelectorAll("#prediction-view [data-horizon]").forEach(function (button) {
      button.addEventListener("click", function () {
        horizon = button.dataset.horizon;
        setHorizonButtons();
        load();
      });
    });
    $("forecast-refresh").addEventListener("click", function () { load(); loadWeather(); });
    $("forecast-save").addEventListener("click", saveRun);
    $("forecast-download").addEventListener("click", download);
  }

  function activate() {
    if (!initialised) {
      init();
      loadSettingsDefaults().then(function () {
        setHorizonButtons();
        load();
        loadWeather();
        loadRuns();
      });
      return;
    }
    if (!lastData) load();
  }

  new MutationObserver(function () {
    if (lastData) render(lastData);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  window.SolarSensePrediction = { activate: activate };
})();
