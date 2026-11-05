(function () {
  const capacityKw = 2400;
  const performanceRatio = 0.925;
  const initialIrradiance = [
    612, 628, 645, 668, 695, 721, 748, 770, 789, 804, 816, 824,
    821, 812, 798, 780, 757, 731, 704, 678, 695, 725, 755, 782
  ];
  const nextIrradiance = [755, 738, 710, 680, 645, 622, 650, 700, 745, 790, 810, 770];
  const voltageOffsets = [0, 1, -1, 2, -2, 1, 0, -1];
  const temperatureOffsets = [0, 0.2, -0.1, 0.1, 0.3, -0.2, 0.1, 0];
  const state = {
    samples: [],
    sequence: 0,
    nextSampleIndex: 0,
    range: "6h",
    charts: null,
    initialized: false
  };

  function clockLabel(sampleIndex) {
    const minutes = 6 * 60 + 15 + sampleIndex * 15;
    const hours = Math.floor(minutes / 60) % 24;
    const remainder = minutes % 60;
    return String(hours).padStart(2, "0") + ":" + String(remainder).padStart(2, "0");
  }

  function createSample(irradiance, sampleIndex) {
    const temperature = Math.round(
      (31 + irradiance * 0.0182 + temperatureOffsets[sampleIndex % temperatureOffsets.length]) * 10
    ) / 10;
    const voltage = Math.round(620 - (irradiance - 700) * 0.025 + voltageOffsets[sampleIndex % voltageOffsets.length]);
    const temperatureFactor = Math.max(0.82, 1 - Math.max(temperature - 25, 0) * 0.004);
    const estimatedPower = capacityKw * (irradiance / 1000) * temperatureFactor * performanceRatio;
    const current = Math.round((estimatedPower * 1000 / voltage) * 10) / 10;
    const power = Math.round(voltage * current / 1000);

    return {
      label: clockLabel(sampleIndex),
      irradiance: irradiance,
      temperature: temperature,
      voltage: voltage,
      current: current,
      power: power
    };
  }

  function visibleSamples() {
    const countByRange = { "1h": 5, "3h": 13, "6h": 24 };
    return state.samples.slice(-countByRange[state.range]);
  }

  function updateReadings(sample) {
    document.getElementById("sample-time").textContent = "Sample · " + sample.label;
    document.getElementById("reading-sequence").textContent = "Sample " + String(state.sequence).padStart(2, "0");
    document.getElementById("irradiance-value").textContent = sample.irradiance.toLocaleString("en-US");
    document.getElementById("temperature-value").textContent = sample.temperature.toFixed(1);
    document.getElementById("voltage-value").textContent = sample.voltage.toLocaleString("en-US");
    document.getElementById("current-value").textContent = sample.current.toLocaleString("en-US");
    document.getElementById("power-value").textContent = sample.power.toLocaleString("en-US");
  }

  function updateCharts() {
    if (!state.charts) return;
    const samples = visibleSamples();
    const labels = samples.map(function (sample) { return sample.label; });

    state.charts.power.data.labels = labels;
    state.charts.power.data.datasets[0].data = samples.map(function (sample) { return sample.power; });
    state.charts.conditions.data.labels = labels;
    state.charts.conditions.data.datasets[0].data = samples.map(function (sample) { return sample.irradiance; });
    state.charts.conditions.data.datasets[1].data = samples.map(function (sample) { return sample.temperature; });
    state.charts.power.update();
    state.charts.conditions.update();
  }

  function setRange(range) {
    if (!["1h", "3h", "6h"].includes(range)) return;
    state.range = range;
    document.querySelectorAll("[data-monitor-range]").forEach(function (button) {
      const selected = button.dataset.monitorRange === range;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    updateCharts();
  }

  function lineChartOptions(unit, color) {
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
          callbacks: {
            label: function (context) {
              return " " + context.dataset.label + ": " + context.parsed.y.toLocaleString() + " " + unit;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: "#71808a", font: { family: "DM Sans", size: 9 }, maxRotation: 0, maxTicksLimit: 8 }
        },
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: "rgba(133, 151, 160, .12)", drawTicks: false },
          ticks: {
            color: "#71808a",
            padding: 8,
            font: { family: "DM Sans", size: 9 },
            callback: function (value) { return value.toLocaleString(); }
          },
          title: {
            display: true,
            text: unit,
            color: color,
            font: { family: "DM Sans", size: 9, weight: "500" }
          }
        }
      }
    };
  }

  function initializeCharts() {
    if (state.charts || typeof Chart === "undefined") return;
    const samples = visibleSamples();
    const labels = samples.map(function (sample) { return sample.label; });

    state.charts = {
      power: new Chart(document.getElementById("power-chart"), {
        type: "line",
        data: {
          labels: labels,
          datasets: [{
            label: "Power output",
            data: samples.map(function (sample) { return sample.power; }),
            borderColor: "#16A34A",
            backgroundColor: "rgba(22, 163, 74, .08)",
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 5,
            pointBackgroundColor: "#16A34A",
            tension: .35,
            fill: true
          }]
        },
        options: lineChartOptions("kW", "#16A34A")
      }),
      conditions: new Chart(document.getElementById("conditions-chart"), {
        type: "line",
        data: {
          labels: labels,
          datasets: [
            {
              label: "Irradiance",
              data: samples.map(function (sample) { return sample.irradiance; }),
              yAxisID: "irradiance",
              borderColor: "#16A34A",
              borderWidth: 1.8,
              pointRadius: 1.5,
              pointHoverRadius: 4,
              pointBackgroundColor: "#16A34A",
              tension: .35
            },
            {
              label: "Panel temperature",
              data: samples.map(function (sample) { return sample.temperature; }),
              yAxisID: "temperature",
              borderColor: "#FBBF24",
              borderWidth: 1.8,
              pointRadius: 1.5,
              pointHoverRadius: 4,
              pointBackgroundColor: "#FBBF24",
              tension: .35
            }
          ]
        },
        options: {
          scales: {
            x: lineChartOptions("W/m²", "#16A34A").scales.x,
            irradiance: {
              ...lineChartOptions("W/m²", "#16A34A").scales.y,
              position: "left",
              min: 0,
              max: 1000,
              title: { display: false }
            },
            temperature: {
              ...lineChartOptions("°C", "#FBBF24").scales.y,
              position: "right",
              min: 20,
              max: 60,
              grid: { drawOnChartArea: false },
              title: { display: false }
            }
          }
        }
      })
    };
  }

  function generateReading() {
    const irradiance = nextIrradiance[state.nextSampleIndex % nextIrradiance.length];
    const sampleIndex = state.samples.length ? state.samples[state.samples.length - 1].index + 1 : 0;
    const sample = createSample(irradiance, sampleIndex);
    sample.index = sampleIndex;
    state.samples.push(sample);
    if (state.samples.length > 24) state.samples.shift();
    state.sequence += 1;
    state.nextSampleIndex += 1;
    updateReadings(sample);
    updateCharts();
  }

  function resetSamples() {
    state.samples = initialIrradiance.map(function (irradiance, index) {
      const sample = createSample(irradiance, index);
      sample.index = index;
      return sample;
    });
    state.sequence = state.samples.length;
    state.nextSampleIndex = 0;
    updateReadings(state.samples[state.samples.length - 1]);
    updateCharts();
  }

  function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    resetSamples();

    document.getElementById("generate-reading").addEventListener("click", generateReading);
    document.getElementById("reset-readings").addEventListener("click", resetSamples);
    document.querySelectorAll("[data-monitor-range]").forEach(function (button) {
      button.addEventListener("click", function () {
        setRange(button.dataset.monitorRange);
      });
    });
  }

  function activate() {
    initialize();
    initializeCharts();
    if (state.charts) {
      state.charts.power.resize();
      state.charts.conditions.resize();
    }
  }

  window.SolarSenseMonitoring = { activate: activate };
})();
