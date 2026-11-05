(function () {
  const $ = function (id) { return document.getElementById(id); };
  let initialised = false;
  let loaded = false;
  let chart = null;
  let actions = [];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fmt(value, digits) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "–";
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits === undefined ? 1 : digits });
  }

  function signed(value, suffix) {
    if (value === null || value === undefined) return "–";
    const number = Number(value);
    return (number > 0 ? "+" : "") + fmt(number, 2) + (suffix || "");
  }

  function themeColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue("--text").trim() || "#1f2a37",
      muted: style.getPropertyValue("--muted").trim() || "#5b6675",
      border: style.getPropertyValue("--border").trim() || "#d6d2c4",
      accent: style.getPropertyValue("--accent").trim() || "#2e8b57",
      red: style.getPropertyValue("--red").trim() || "#b42318"
    };
  }

  function setStatus(message, isError) {
    const node = $("recovery-status");
    node.textContent = message || "";
    node.classList.toggle("is-error", !!isError);
  }

  function verdictClass(verdict) {
    const v = String(verdict || "").toLowerCase();
    if (v.startsWith("improved")) return "verdict-improved";
    if (v.startsWith("declined")) return "verdict-declined";
    if (v.startsWith("weather")) return "verdict-weather";
    if (v.startsWith("inconclusive")) return "verdict-inconclusive";
    return "verdict-nochange";
  }

  function renderCoverage(data) {
    const box = $("recovery-coverage");
    box.replaceChildren();
    const grid = el("div", "module-kv");
    const cov = data.data_coverage;
    [
      ["Plant", data.plant.name],
      ["Capacity", fmt(data.plant.capacity_kw, 0) + " kW"],
      ["Complete days", fmt(cov.complete_days, 0)],
      ["Data range", cov.first_day && cov.last_day ? cov.first_day + " to " + cov.last_day : "–"]
    ].forEach(function (item) {
      const cell = el("div");
      cell.appendChild(el("span", "", item[0]));
      cell.appendChild(el("strong", "", item[1]));
      grid.appendChild(cell);
    });
    box.appendChild(grid);
  }

  function renderSelect(data) {
    const select = $("recovery-type");
    select.replaceChildren();
    data.action_types.forEach(function (type) {
      select.appendChild(el("option", "", type));
    });
    const dateInput = $("recovery-form").elements.performed_on;
    dateInput.max = new Date().toISOString().slice(0, 10);
  }

  function renderHistory() {
    const body = $("recovery-rows");
    body.replaceChildren();
    if (!actions.length) {
      const row = el("tr");
      const cell = el("td", "chart-caption", "No maintenance actions recorded yet. Record one above to start verification.");
      cell.colSpan = 9;
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }
    actions.forEach(function (action) {
      const v = action.verification;
      const row = el("tr");
      row.appendChild(el("td", "", action.performed_on));
      row.appendChild(el("td", "", action.action_type));

      const verdictCell = el("td");
      verdictCell.appendChild(el("span", "verdict-badge " + verdictClass(v.verdict), v.verdict));
      row.appendChild(verdictCell);

      row.appendChild(el("td", "", v.performance_ratio_before === null ? "–" : fmt(v.performance_ratio_before * 100, 1) + "%"));
      row.appendChild(el("td", "", v.performance_ratio_after === null ? "–" : fmt(v.performance_ratio_after * 100, 1) + "%"));
      row.appendChild(el("td", "", signed(v.performance_ratio_change_pct, "%")));
      row.appendChild(el("td", "", signed(v.irradiation_change_pct, "%")));
      row.appendChild(el("td", "", signed(v.observed_kwh_per_day_difference, " kWh")));

      const notesCell = el("td", "is-wrap", action.notes || "–");
      const explain = el("div", "chart-caption", v.explanation);
      notesCell.appendChild(explain);
      const button = el("button", "secondary-button", "View window");
      button.type = "button";
      button.addEventListener("click", function () { drawWindow(action); });
      notesCell.appendChild(button);
      row.appendChild(notesCell);
      body.appendChild(row);
    });
  }

  function drawWindow(action) {
    const v = action.verification;
    const colors = themeColors();
    const before = v.daily_before || [];
    const after = v.daily_after || [];
    const labels = before.map(function (d) { return d.date; }).concat(after.map(function (d) { return d.date; }));
    const beforeData = before.map(function (d) { return d.performance_ratio; }).concat(after.map(function () { return null; }));
    const afterData = before.map(function () { return null; }).concat(after.map(function (d) { return d.performance_ratio; }));

    $("recovery-chart-caption").textContent =
      "Action on " + action.performed_on + " (" + action.action_type + "). Daily performance ratio = actual kWh ÷ (irradiation × capacity). " +
      "Gaps mark days with no complete data.";

    if (chart) chart.destroy();
    chart = new Chart($("recovery-chart"), {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          { label: "Before action", data: beforeData, borderColor: colors.muted, backgroundColor: colors.muted, pointRadius: 3, spanGaps: false, fill: false },
          { label: "After action", data: afterData, borderColor: colors.accent, backgroundColor: colors.accent, pointRadius: 3, spanGaps: false, fill: false }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: colors.text } } },
        scales: {
          x: { ticks: { color: colors.muted, maxRotation: 45 }, grid: { color: colors.border } },
          y: {
            title: { display: true, text: "Performance ratio", color: colors.muted },
            ticks: { color: colors.muted, callback: function (value) { return (value * 100).toFixed(0) + "%"; } },
            grid: { color: colors.border }
          }
        }
      }
    });
  }

  function load() {
    setStatus("Loading maintenance history…", false);
    return window.SolarSenseApi.recoveryActions()
      .then(function (data) {
        actions = data.actions || [];
        renderCoverage(data);
        if (!$("recovery-type").options.length) renderSelect(data);
        $("recovery-method").textContent = data.method;
        renderHistory();
        loaded = true;
        setStatus("", false);
      })
      .catch(function (error) {
        $("recovery-rows").replaceChildren();
        setStatus(error.message || "Maintenance history could not be loaded.", true);
      });
  }

  function submit(event) {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const payload = {
      action_type: data.get("action_type"),
      performed_on: data.get("performed_on"),
      notes: data.get("notes") || ""
    };
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    window.SolarSenseApi.createRecoveryAction(payload)
      .then(function () {
        form.elements.notes.value = "";
        setStatus("Action recorded. Verification is shown in the history below.", false);
        return load();
      })
      .catch(function (error) {
        setStatus(error.message || "The action could not be recorded.", true);
      })
      .finally(function () { button.disabled = false; });
  }

  function init() {
    initialised = true;
    $("recovery-form").addEventListener("submit", submit);
  }

  function activate() {
    if (!initialised) init();
    if (!loaded) load();
  }

  window.SolarSenseRecovery = { activate: activate };
})();
