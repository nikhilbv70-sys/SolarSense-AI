(function () {
  const periodData = {
    day: {
      generated: "8,420",
      expected: "9,100",
      performance: "92.5",
      labels: ["06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00"],
      actual: [180, 640, 1290, 1680, 1580, 1120, 520],
      expectedSeries: [210, 700, 1390, 1810, 1720, 1240, 610],
      unit: "Energy · kWh",
      footnote: "Sample plant · Today"
    },
    week: {
      generated: "54,680",
      expected: "59,200",
      performance: "92.4",
      labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      actual: [7180, 8040, 7650, 8210, 7420, 8560, 7620],
      expectedSeries: [7750, 8400, 8250, 8650, 8100, 9000, 9050],
      unit: "Energy · kWh",
      footnote: "Sample plant · This week"
    },
    month: {
      generated: "231,460",
      expected: "249,800",
      performance: "92.7",
      labels: ["Week 1", "Week 2", "Week 3", "Week 4"],
      actual: [54800, 59640, 57320, 59700],
      expectedSeries: [59600, 63400, 61500, 65300],
      unit: "Energy · kWh",
      footnote: "Sample plant · This month"
    }
  };

  let chart;

  function chartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#18232c",
          borderColor: "#34434d",
          borderWidth: 1,
          titleColor: "#dce6e9",
          bodyColor: "#aebbc1",
          padding: 10,
          displayColors: true,
          callbacks: {
            label: function (context) {
              return " " + context.dataset.label + ": " + context.parsed.y.toLocaleString() + " kWh";
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: "#71808a", font: { family: "DM Sans", size: 9 }, maxRotation: 0 }
        },
        y: {
          beginAtZero: true,
          border: { display: false, dash: [3, 4] },
          grid: { color: "rgba(133, 151, 160, .12)", drawTicks: false },
          ticks: {
            color: "#71808a",
            padding: 9,
            font: { family: "DM Sans", size: 9 },
            callback: function (value) {
              return value >= 1000 ? (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1) + "k" : value;
            }
          }
        }
      }
    };
  }

  function updatePeriod(period) {
    const data = periodData[period];
    if (!data) return;

    document.getElementById("generated-value").textContent = data.generated;
    document.getElementById("expected-value").textContent = data.expected;
    document.getElementById("performance-value").textContent = data.performance;
    document.getElementById("chart-unit").textContent = data.unit;
    document.querySelector(".last-updated").textContent = data.footnote;

    document.querySelectorAll("[data-period]").forEach(function (button) {
      const selected = button.dataset.period === period;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });

    if (chart) {
      chart.data.labels = data.labels;
      chart.data.datasets[0].data = data.actual;
      chart.data.datasets[1].data = data.expectedSeries;
      chart.update();
    }
  }


  function initialize() {
    const canvas = document.getElementById("energy-chart");

    if (canvas && typeof Chart !== "undefined") {
      chart = new Chart(canvas, {
        type: "line",
        data: {
          labels: periodData.day.labels,
          datasets: [
            {
              label: "Actual generation",
              data: periodData.day.actual,
              borderColor: "#16A34A",
              backgroundColor: "rgba(22, 163, 74, .08)",
              borderWidth: 2,
              pointRadius: 2.5,
              pointHoverRadius: 5,
              pointBackgroundColor: "#16A34A",
              tension: .35,
              fill: true
            },
            {
              label: "Expected generation",
              data: periodData.day.expectedSeries,
              borderColor: "#86EFAC",
              borderWidth: 1.5,
              borderDash: [5, 5],
              pointRadius: 0,
              pointHoverRadius: 4,
              pointBackgroundColor: "#86EFAC",
              tension: .35,
              fill: false
            }
          ]
        },
        options: chartOptions()
      });
    }

    document.querySelectorAll("[data-period]").forEach(function (button) {
      button.addEventListener("click", function () {
        updatePeriod(button.dataset.period);
      });
    });

    loadAIPrediction();
  }

  async function loadAIPrediction() {
    const powerElement = document.getElementById("ai-predicted-power");
    const statusElement = document.getElementById("ai-forecast-status");
    const modelElement = document.getElementById("ai-model-name");

    if (!powerElement || !statusElement || !modelElement || !window.SolarSenseApi) {
      return;
    }

    try {
      statusElement.textContent = "Generating prediction...";

      const result = await window.SolarSenseApi.predictSolarPower();

      if (result.status !== "success") {
        throw new Error(result.message || "Prediction failed");
      }

      powerElement.textContent = Number(result.predicted_power).toLocaleString(
        undefined,
        { maximumFractionDigits: 2 }
      );

      statusElement.textContent = "Historical dataset prediction";
      modelElement.textContent = result.model;

    } catch (error) {
      powerElement.textContent = "--";
      statusElement.textContent = "Prediction unavailable";
      console.error("AI prediction error:", error);
    }
  }

  window.SolarSenseDashboard = {
    initialize: initialize,
    updatePeriod: updatePeriod
  };

})();
