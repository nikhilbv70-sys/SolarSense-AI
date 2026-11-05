(function () {
  const $ = function (id) { return document.getElementById(id); };
  let loaded = false;
  let displayPrefs = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function setStatus(message, isError) {
    const node = $("priority-status");
    node.textContent = message || "";
    node.classList.toggle("is-error", !!isError);
  }

  function renderCounts(counts) {
    const wrap = $("priority-counts");
    wrap.replaceChildren();
    ["Critical", "High", "Medium", "Low"].forEach(function (band) {
      const card = el("div", "priority-count priority-" + band.toLowerCase());
      card.appendChild(el("span", "priority-count-label", band));
      card.appendChild(el("strong", "priority-count-value", String(counts[band] || 0)));
      wrap.appendChild(card);
    });
  }

  function renderRow(alert, index, statuses) {
    const row = el("tr");
    row.appendChild(el("td", "", String(index + 1)));

    const priorityCell = el("td");
    priorityCell.appendChild(el("span", "priority-badge priority-" + alert.priority.toLowerCase(), alert.priority));
    priorityCell.appendChild(el("span", "priority-score", "Score " + alert.priority_score));
    row.appendChild(priorityCell);

    row.appendChild(el("td", "", alert.date + " " + alert.start_time + "–" + alert.end_time + " (" + alert.duration_min + " min)"));
    row.appendChild(el("td", "", alert.mean_deviation_pct + "%"));

    const lossCell = el("td");
    const display = displayPrefs || { energy_unit: "kWh", tariff_per_kwh: null };
    const lossValue = display.energy_unit === "MWh" ? alert.estimated_loss_kwh / 1000 : alert.estimated_loss_kwh;
    lossCell.appendChild(el("span", "", lossValue.toLocaleString(undefined, { maximumFractionDigits: 3 }) + " " + display.energy_unit));
    lossCell.appendChild(el("span", "priority-score", alert.estimated_loss_share_pct + "% of day's expected"));
    if (alert.estimated_loss_value != null) {
      lossCell.appendChild(el("span", "priority-score", "Tariff estimate: " + alert.estimated_loss_value.toLocaleString(undefined, { maximumFractionDigits: 2 })));
    }
    row.appendChild(lossCell);

    row.appendChild(el("td", "priority-reason", alert.reason));
    row.appendChild(el("td", "priority-reason", alert.recommended_inspection));

    const statusCell = el("td");
    const select = el("select", "priority-status-select");
    select.setAttribute("aria-label", "Status for alert " + alert.alert_key);
    statuses.forEach(function (status) {
      const option = el("option", "", status);
      option.value = status;
      select.appendChild(option);
    });
    select.value = alert.status;
    select.addEventListener("change", function () {
      const previous = alert.status;
      select.disabled = true;
      window.SolarSenseApi.updateAlertStatus(alert.alert_key, select.value)
        .then(function (result) {
          alert.status = result.status;
          setStatus("Saved: " + alert.date + " " + alert.start_time + " is now " + result.status + ".", false);
        })
        .catch(function (error) {
          select.value = previous;
          setStatus(error.message || "Could not save the status.", true);
        })
        .finally(function () { select.disabled = false; });
    });
    statusCell.appendChild(select);
    row.appendChild(statusCell);
    return row;
  }

  function render(data) {
    displayPrefs = data.display || null;
    $("priority-subtitle").textContent =
      "Ranked from " + data.plant.plant_name + " imported readings. Priorities are rule-based, not confirmed faults.";
    renderCounts(data.counts);
    $("priority-rules").textContent =
      "Daylight only (irradiance ≥ " + data.rules.irradiance_min_wm2 + " W/m²). Output at least " +
      Math.abs(data.rules.deviation_threshold_pct) + "% below expected for at least " +
      data.rules.min_run_intervals + " consecutive 15-minute intervals. " +
      "Score weights: " + data.rules.score_weights + ". Expected output uses performance ratio " +
      data.performance_ratio + ".";

    const tbody = $("priority-rows");
    tbody.replaceChildren();
    if (!data.alerts.length) {
      const row = el("tr");
      const cell = el("td", "priority-empty", "No sustained underperformance windows were found in the imported readings.");
      cell.colSpan = 8;
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }
    data.alerts.forEach(function (alert, index) {
      tbody.appendChild(renderRow(alert, index, data.statuses));
    });
  }

  function load() {
    setStatus("Loading alerts from the imported readings…", false);
    return window.SolarSenseApi.maintenancePriority()
      .then(function (data) {
        render(data);
        loaded = true;
        setStatus("", false);
      })
      .catch(function (error) {
        $("priority-rows").replaceChildren();
        $("priority-counts").replaceChildren();
        setStatus(error.message || "Maintenance priorities could not be loaded.", true);
      });
  }

  function activate() {
    if (!loaded) load();
  }

  document.addEventListener("DOMContentLoaded", function () {
    const refresh = $("priority-refresh");
    if (refresh) refresh.addEventListener("click", load);
  });

  window.SolarSensePriority = { activate: activate };
})();
