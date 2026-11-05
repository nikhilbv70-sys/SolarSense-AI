(function () {
  const initialValues = { horizon: 30, degradation: 5, improvement: 4 };
  let expectedDailyKwh = 0;
  let currentPerformance = 1;
  let baselineLoaded = false;
  let baselinePromise = null;
  let dailyData = [];
  let chart;
  let trendChart;
  let initialized = false;

  function formatEnergy(value) {
    return Math.round(value).toLocaleString("en-US");
  }

  function updateScenario() {
    if (!baselineLoaded) return;
    const horizon = Number(document.getElementById("horizon-slider").value);
    const degradation = Number(document.getElementById("degradation-slider").value);
    const improvement = Number(document.getElementById("improvement-slider").value);
    const currentEnergy = expectedDailyKwh * currentPerformance * horizon;
    const underperformanceRatio = Math.max(0, currentPerformance - degradation / 100);
    const maintenanceRatio = currentPerformance + improvement / 100;
    const underperformanceEnergy = expectedDailyKwh * underperformanceRatio * horizon;
    const maintenanceEnergy = expectedDailyKwh * maintenanceRatio * horizon;
    const values = [currentEnergy, underperformanceEnergy, maintenanceEnergy];

    document.getElementById("horizon-output").textContent = horizon + " days";
    document.getElementById("degradation-output").textContent = degradation + " pp";
    document.getElementById("improvement-output").textContent = improvement + " pp";
    document.getElementById("assumption-horizon").textContent = horizon + " days";
    document.getElementById("current-energy").firstChild.textContent = formatEnergy(currentEnergy) + " ";
    document.getElementById("underperformance-energy").firstChild.textContent = formatEnergy(underperformanceEnergy) + " ";
    document.getElementById("maintenance-energy").firstChild.textContent = formatEnergy(maintenanceEnergy) + " ";
    document.getElementById("current-performance").textContent = (currentPerformance * 100).toFixed(1) + "%";
    document.getElementById("underperformance-performance").textContent = (underperformanceRatio * 100).toFixed(1) + "%";
    document.getElementById("maintenance-performance").textContent = (maintenanceRatio * 100).toFixed(1) + "%";

    if (chart) {
      chart.data.datasets[0].data = values;
      chart.update();
    }
  }

  function initializeChart() {
    if (chart || typeof Chart === "undefined") return;
    chart = new Chart(document.getElementById("scenario-chart"), {
      type: "bar",
      data: {
        labels: ["Current condition", "Continued underperformance", "Assumed maintenance"],
        datasets: [{
          label: "Estimated generation",
          data: [expectedDailyKwh * currentPerformance * initialValues.horizon,
            expectedDailyKwh * (currentPerformance - initialValues.degradation / 100) * initialValues.horizon,
            expectedDailyKwh * (currentPerformance + initialValues.improvement / 100) * initialValues.horizon],
          backgroundColor: ["rgba(22, 163, 74, .78)", "rgba(251, 191, 36, .72)", "rgba(22, 163, 74, .32)"],
          borderColor: ["#16A34A", "#FBBF24", "#16A34A"],
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: 42
        }]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#FFFFFF",
            borderColor: "rgba(15, 23, 42, .16)",
            borderWidth: 1,
            titleColor: "#17212B",
            bodyColor: "#526170",
            callbacks: {
              label: function (context) {
                return " Estimated: " + formatEnergy(context.parsed.x) + " kWh";
              }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: "rgba(15, 23, 42, .08)" },
            border: { display: false },
            ticks: {
              color: "#64748B",
              callback: function (value) { return Number(value).toLocaleString(); }
            }
          },
          y: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: "#526170", font: { family: "DM Sans", size: 10 } }
          }
        }
      }
    });
  }

  function applyBaseline(data) {
    const status = document.getElementById("baseline-status");
    if (!data.summary) {
      status.textContent = data.message || "No imported plant data is available.";
      return;
    }
    const summary = data.summary;
    expectedDailyKwh = summary.avg_daily_expected_kwh;
    currentPerformance = summary.performance_ratio;
    dailyData = data.daily;
    baselineLoaded = true;

    document.getElementById("baseline-source").textContent = data.plant.plant_name + " · " + summary.days + " days (" + summary.start_date + " to " + summary.end_date + ")";
    document.getElementById("assumption-baseline").textContent = formatEnergy(expectedDailyKwh) + " kWh";
    document.getElementById("assumption-performance").textContent = (currentPerformance * 100).toFixed(1) + "%";
    status.textContent = "Baseline loaded from imported Plant 1 readings (estimated expected power).";
    updateScenario();
  }

  function loadBaseline() {
    if (!baselinePromise) {
      baselinePromise = window.SolarSenseApi.timeMachineBaseline()
        .then(applyBaseline)
        .catch(function (error) {
          document.getElementById("baseline-status").textContent = error.message || "Plant data could not be loaded.";
        });
    }
    return baselinePromise;
  }

  function initializeTrendChart() {
    if (trendChart || typeof Chart === "undefined" || !dailyData.length) return;
    trendChart = new Chart(document.getElementById("trend-chart"), {
      type: "line",
      data: {
        labels: dailyData.map(function (d) { return d.date; }),
        datasets: [
          {
            label: "Actual (kWh/day)",
            data: dailyData.map(function (d) { return d.actual_kwh; }),
            borderColor: "#16A34A",
            backgroundColor: "rgba(22, 163, 74, .12)",
            fill: true,
            tension: 0.3,
            pointRadius: 0
          },
          {
            label: "Expected estimate (kWh/day)",
            data: dailyData.map(function (d) { return d.expected_kwh; }),
            borderColor: "#64748B",
            borderDash: [6, 4],
            tension: 0.3,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom" } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, color: "#64748B" }, grid: { display: false } },
          y: {
            beginAtZero: true,
            ticks: { color: "#64748B", callback: function (value) { return Number(value).toLocaleString(); } },
            grid: { color: "rgba(15, 23, 42, .08)" }
          }
        }
      }
    });
  }

  function reset() {
    document.getElementById("horizon-slider").value = initialValues.horizon;
    document.getElementById("degradation-slider").value = initialValues.degradation;
    document.getElementById("improvement-slider").value = initialValues.improvement;
    updateScenario();
  }

  function initialize() {
    if (initialized) return;
    initialized = true;
    ["horizon-slider", "degradation-slider", "improvement-slider"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", updateScenario);
    });
    document.getElementById("reset-scenario").addEventListener("click", reset);
    updateScenario();
  }

  function activate() {
    initialize();
    loadBaseline().then(function () {
      if (!baselineLoaded) return;
      initializeChart();
      initializeTrendChart();
      if (chart) chart.resize();
      if (trendChart) trendChart.resize();
    });
  }

  window.SolarSenseTimeMachine = { activate: activate };
})();
