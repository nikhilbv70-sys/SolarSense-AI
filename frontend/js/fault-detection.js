(function () {
  const START_INDEX = 24;
  const DETECT_MIN_IRRADIANCE = 200;
  const LOW_DEVIATION = -0.15;
  const HIGH_DEVIATION = 0.25;
  const PERSISTENCE = 3;
  const MAX_POINTS = 96;
  const TICK_MS = 1000;

  const SCENARIOS = {
    healthy: { label: "Healthy (normal operation)" },
    soiling: { label: "Soiling (dust builds up gradually)" },
    shading: { label: "Partial shading (structure shadow)" },
    "hot-module": { label: "Hot modules (extra thermal loss)" },
    "sensor-fault": { label: "Irradiance sensor reading low" },
    "inverter-drop": { label: "Inverter output collapse" }
  };

  const DEMO = [
    { scenario: "healthy", ticks: 20, text: "Normal operation: actual output tracks the expected estimate, so no alert is raised." },
    { scenario: "soiling", ticks: 40, text: "Soiling builds up gradually. Output drifts below expected, and an alert is raised only after 3 sustained daylight intervals." },
    { scenario: "healthy", ticks: 20, text: "Panels cleaned. Output returns to expected and the alert clears." },
    { scenario: "hot-module", ticks: 30, text: "Modules run hotter than the model predicts. The temperature check now supports a thermal explanation." },
    { scenario: "sensor-fault", ticks: 25, text: "The irradiance sensor reads low while output is normal. The system flags output above expected and points to the sensor, not the plant." },
    { scenario: "healthy", ticks: 10, text: "Demonstration complete. Choose a scenario to test another case." }
  ];

  let state = null;
  let demoActive = false;
  let demoIndex = -1;
  let demoRemaining = 0;
  let playing = true;
  let chart = null;
  let capacityKw = 0;
  let performanceRatio = 0;
  let intervals = [];
  let loadedDate = null;

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function newState(scenario) {
    return { tick: START_INDEX, scenario: scenario, faultAge: 0, lowStreak: 0, highStreak: 0,
      activeAlert: null, alerts: [], points: [], nextId: 1, reading: null };
  }

  function resetState() {
    state = newState($("fault-scenario").value);
  }

  function simulateReading() {
    const scenario = state.scenario;
    if (scenario === "soiling") state.faultAge++;

    const base = intervals[state.tick % intervals.length];
    const irradiance = base.irradiance;
    const moduleNormal = base.panel_temperature;
    const moduleTemp = moduleNormal + (scenario === "hot-module" ? 25 : 0);
    const reportedIrr = scenario === "sensor-fault" ? irradiance * 0.4 : irradiance;

    let factor = 1;
    if (scenario === "soiling") factor = 1 - 0.2 * Math.min(1, state.faultAge / 20);
    if (scenario === "shading") factor = 0.7;
    if (scenario === "hot-module") factor = 0.82;
    if (scenario === "inverter-drop") factor = 0.03;

    const expected = capacityKw * (reportedIrr / 1000) * performanceRatio;
    const actual = Math.max(0, base.actual_kw * factor);

    state.reading = {
      time: base.time,
      irradiance: irradiance,
      reportedIrr: reportedIrr,
      moduleNormal: moduleNormal,
      moduleTemp: moduleTemp,
      expected: expected,
      actual: actual,
      dev: expected > 0 ? (actual - expected) / expected : null
    };
  }

  function lowChecks(r) {
    return [
      { label: "Persistent: " + PERSISTENCE + " consecutive daylight intervals at least 15% below expected", pass: true },
      { label: "Reported irradiance agrees with the measured irradiance, so the sensor is less likely the cause", pass: Math.abs(r.reportedIrr - r.irradiance) <= 0.3 * Math.max(r.irradiance, 1) },
      { label: "Module temperature at least 10 °C above the measured value", pass: r.moduleTemp - r.moduleNormal >= 10 },
      { label: "Output near zero under sunlight (below 5% of expected)", pass: r.actual < 0.05 * r.expected }
    ];
  }

  function highChecks(r) {
    const measuredExpected = capacityKw * (r.irradiance / 1000) * performanceRatio;
    return [
      { label: "Persistent: " + PERSISTENCE + " consecutive daylight intervals at least 25% above expected", pass: true },
      { label: "Reported irradiance is well below the measured irradiance (sensor under-reading)", pass: r.reportedIrr < 0.7 * r.irradiance },
      { label: "Actual output matches the measured-irradiance estimate (within 10%)", pass: measuredExpected > 0 && Math.abs(r.actual - measuredExpected) <= 0.1 * measuredExpected }
    ];
  }

  function lowGuidance(checks) {
    const tempCheck = checks[2].pass;
    const zeroCheck = checks[3].pass;
    const causes = ["Soiling or partial shading on the array (irradiance looks normal, so the sun is not the cause)"];
    if (tempCheck) causes.unshift("Module temperature effect: modules run hotter than the model predicts");
    if (zeroCheck) causes.unshift("Inverter or equipment outage: near-zero output under sunlight");
    const inspect = zeroCheck
      ? "Check inverter status, DC isolators and string fuses first."
      : tempCheck
        ? "Check module temperature sensors and ventilation around the array."
        : "Walk the array for dust, bird droppings and new shadows from nearby objects.";
    return { causes: causes, inspect: inspect };
  }

  function clearAlert(r) {
    if (!state.activeAlert) return;
    state.activeAlert.endTime = r.time;
    state.activeAlert = null;
  }

  function raise(type, r) {
    clearAlert(r);
    const checks = type === "low" ? lowChecks(r) : highChecks(r);
    const passes = checks.filter(function (c) { return c.pass; }).length;
    const guidance = type === "low"
      ? lowGuidance(checks)
      : {
          causes: ["Irradiance sensor reading low, drifted, dirty or misaligned", "Expected-power model fed with a bad irradiance value"],
          inspect: "Clean and check the irradiance sensor before touching the panels."
        };
    const alert = {
      id: state.nextId++,
      type: type,
      title: type === "low" ? "Sustained underperformance" : "Output above expected",
      startTime: r.time,
      endTime: null,
      lastDev: r.dev,
      checks: checks,
      level: passes >= 3 ? "High" : passes === 2 ? "Medium" : "Low",
      causes: guidance.causes,
      inspect: guidance.inspect
    };
    state.alerts.push(alert);
    state.activeAlert = alert;
  }

  function detect(r) {
    if (r.reportedIrr < DETECT_MIN_IRRADIANCE || r.expected <= 0) {
      state.lowStreak = 0;
      state.highStreak = 0;
      return;
    }
    if (r.dev <= LOW_DEVIATION) {
      state.lowStreak++;
      state.highStreak = 0;
      if (state.lowStreak === PERSISTENCE) raise("low", r);
      else if (state.activeAlert && state.activeAlert.type === "low") state.activeAlert.lastDev = r.dev;
    } else if (r.dev >= HIGH_DEVIATION) {
      state.highStreak++;
      state.lowStreak = 0;
      if (state.highStreak === PERSISTENCE) raise("high", r);
      else if (state.activeAlert && state.activeAlert.type === "high") state.activeAlert.lastDev = r.dev;
    } else {
      state.lowStreak = 0;
      state.highStreak = 0;
      clearAlert(r);
    }
  }

  function setScenario(scenario) {
    state.scenario = scenario;
    state.faultAge = 0;
    $("fault-scenario").value = scenario;
  }

  function narrate(text) { $("fault-narration").textContent = text; }

  function stopDemo() {
    demoActive = false;
    $("fault-demo").textContent = "Run demonstration";
  }

  function advanceDemo() {
    if (demoRemaining <= 0) {
      demoIndex++;
      if (demoIndex >= DEMO.length) {
        stopDemo();
        narrate("Demonstration complete. Choose a scenario to test another case.");
        return;
      }
      setScenario(DEMO[demoIndex].scenario);
      demoRemaining = DEMO[demoIndex].ticks;
      narrate(DEMO[demoIndex].text);
    }
    demoRemaining--;
  }

  function advance() {
    if (demoActive) advanceDemo();
    simulateReading();
    const r = state.reading;
    detect(r);
    state.points.push({ label: r.time, actual: r.actual, expected: r.expected });
    if (state.points.length > MAX_POINTS) state.points.shift();
    state.tick++;
  }

  function fmtPct(value) {
    if (value === null) return "—";
    return (value >= 0 ? "+" : "") + (value * 100).toFixed(1) + "%";
  }

  function renderReadouts() {
    const r = state.reading;
    if (!r) {
      $("fault-status").textContent = (playing ? "Live" : "Paused") + " · " + SCENARIOS[state.scenario].label;
      return;
    }
    $("fault-time").textContent = r.time;
    $("fault-irr").textContent = Math.round(r.reportedIrr) + " W/m²";
    $("fault-temp").textContent = r.moduleTemp.toFixed(1) + " °C";
    $("fault-actual").textContent = Math.round(r.actual) + " kW";
    $("fault-expected").textContent = Math.round(r.expected) + " kW";
    $("fault-dev").textContent = fmtPct(r.dev);
    const readout = $("fault-dev").parentElement;
    readout.classList.toggle("is-low", r.dev !== null && r.dev <= LOW_DEVIATION);
    readout.classList.toggle("is-high", r.dev !== null && r.dev >= HIGH_DEVIATION);
    $("fault-status").textContent = (playing ? "Live" : "Paused") + " · " + SCENARIOS[state.scenario].label;
  }

  function buildAlert(a) {
    const card = el("article", "fault-alert " + (a.endTime ? "is-cleared" : "is-active"));
    const head = el("div", "fault-alert-head");
    head.appendChild(el("span", null, "#" + a.id + " " + a.title));
    const badges = el("span", "fault-badges");
    badges.appendChild(el("span", "fault-badge", a.endTime ? "Cleared " + a.endTime : "Active since " + a.startTime));
    badges.appendChild(el("span", "fault-badge", "Evidence: " + a.level));
    head.appendChild(badges);
    card.appendChild(head);

    card.appendChild(el("p", null, "Why it was raised: " + (a.type === "low"
      ? "output stayed at least 15% below expected for 3 consecutive daylight intervals."
      : "output stayed at least 25% above expected for 3 consecutive daylight intervals.") +
      " Latest deviation " + fmtPct(a.lastDev) + "."));

    card.appendChild(el("p", "fault-label", "Evidence checks"));
    const checks = el("ul");
    a.checks.forEach(function (c) {
      checks.appendChild(el("li", c.pass ? "check-pass" : "check-fail", (c.pass ? "✓ " : "✗ ") + c.label));
    });
    card.appendChild(checks);

    card.appendChild(el("p", "fault-label", "Suspected causes (not confirmed by electrical data alone)"));
    const causes = el("ul");
    a.causes.forEach(function (c) { causes.appendChild(el("li", null, c)); });
    card.appendChild(causes);

    card.appendChild(el("p", null, "Inspect next: " + a.inspect));
    return card;
  }

  function renderAlerts() {
    const list = $("fault-alerts");
    list.textContent = "";
    $("fault-alert-count").textContent = state.alerts.length + (state.alerts.length === 1 ? " alert" : " alerts");
    if (!state.alerts.length) {
      list.appendChild(el("p", "fault-empty", "No alerts yet. Alerts appear only after sustained deviation during daylight."));
      return;
    }
    state.alerts.slice().reverse().forEach(function (a) { list.appendChild(buildAlert(a)); });
  }

  function updateChart() {
    if (!chart) return;
    chart.data.labels = state.points.map(function (p) { return p.label; });
    chart.data.datasets[0].data = state.points.map(function (p) { return p.actual; });
    chart.data.datasets[1].data = state.points.map(function (p) { return p.expected; });
    chart.update("none");
  }

  function initChart() {
    if (chart || typeof Chart === "undefined") return;
    chart = new Chart($("fault-chart"), {
      type: "line",
      data: {
        labels: [],
        datasets: [
      { label: "Actual (kW, replayed)", data: [], borderColor: "#16A34A", backgroundColor: "rgba(22, 163, 74, .12)", fill: true, tension: 0.3, pointRadius: 0 },
          { label: "Expected (kW, estimate)", data: [], borderColor: "#64748B", borderDash: [6, 4], tension: 0.3, pointRadius: 0 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          x: { ticks: { maxTicksLimit: 8 }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { callback: function (v) { return Number(v).toLocaleString(); } } }
        }
      }
    });
  }

  function render() {
    renderReadouts();
    updateChart();
    renderAlerts();
  }

  function startDemo() {
    if (!intervals.length) {
      narrate("Sign in and load a real imported day before running the demonstration.");
      return;
    }
    resetState();
    demoActive = true;
    demoIndex = -1;
    demoRemaining = 0;
    playing = true;
    $("fault-toggle").textContent = "Pause live feed";
    $("fault-demo").textContent = "Stop demonstration";
    narrate("Demonstration started. The feed is simulated.");
    render();
  }

  function loop() {
    if (!playing || !state || !intervals.length || $("fault-view").hidden) return;
    const speed = Number($("fault-speed").value) || 1;
    for (let i = 0; i < speed; i++) advance();
    render();
  }

  function populateDays(days, selected) {
    const select = $("fault-day");
    select.textContent = "";
    days.forEach(function (day) { select.appendChild(new Option(day, day)); });
    select.value = selected;
  }

  function loadDay(date) {
    $("fault-status").textContent = "Loading real imported readings…";
    return window.SolarSenseApi.faultReplay(date).then(function (data) {
      capacityKw = data.plant.capacity_kw;
      performanceRatio = data.performance_ratio;
      intervals = data.intervals;
      loadedDate = data.date;
      populateDays(data.days, data.date);
      stopDemo();
      resetState();
      narrate("Replaying real imported readings for " + data.date + ". Scenarios are simulated overlays on this data.");
      render();
    }).catch(function (error) {
      intervals = [];
      loadedDate = null;
      narrate(error.status === 401 ? "Sign in to replay plant data." : error.message);
      $("fault-status").textContent = "Unavailable";
    });
  }

  function initialize() {
    const select = $("fault-scenario");
    Object.keys(SCENARIOS).forEach(function (key) {
      select.appendChild(new Option(SCENARIOS[key].label, key));
    });
    select.value = "healthy";
    resetState();

    $("fault-day").addEventListener("change", function () {
      loadDay(this.value);
    });

    select.addEventListener("change", function () {
      stopDemo();
      setScenario(select.value);
      narrate(SCENARIOS[select.value].label + " selected. Watch the readings and the alert evidence.");
      render();
    });
    $("fault-toggle").addEventListener("click", function () {
      playing = !playing;
      $("fault-toggle").textContent = playing ? "Pause live feed" : "Resume live feed";
      renderReadouts();
    });
    $("fault-reset").addEventListener("click", function () {
      stopDemo();
      resetState();
      narrate("Simulation reset. Choose a scenario or run the demonstration.");
      render();
    });
    $("fault-demo").addEventListener("click", function () {
      if (demoActive) {
        stopDemo();
        narrate("Demonstration stopped. The current scenario continues.");
      } else {
        startDemo();
      }
    });
    setInterval(loop, TICK_MS);
  }

  let initialized = false;

  function activate() {
    if (!initialized) {
      initialized = true;
      initialize();
    }
    initChart();
    updateChart();
    if (!loadedDate) loadDay();
    render();
    if (chart) chart.resize();
  }

  window.SolarSenseFaults = { activate: activate };
})();
