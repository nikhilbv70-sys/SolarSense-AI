(function () {
  const providerNames = {
    "nasa-power": "NASA POWER",
    "pvgis": "PVGIS"
  };
  const statusLabels = {
    connected: "Connected",
    configured: "Key found",
    not_configured: "Not configured",
    authentication_required: "Key rejected",
    api_unavailable: "Unavailable",
    rate_limited: "Rate limited",
    invalid_request: "Invalid request"
  };

  let initialised = false;
  let charts = [];
  function $(id) {
    return document.getElementById(id);
  }

  function setError(message) {
    const box = $("external-error");
    box.textContent = message || "";
    box.hidden = !message;
  }

  function renderProviders(providers) {
    const container = $("external-providers");
    container.textContent = "";
    providers.forEach(function (provider) {
      const card = document.createElement("article");
      card.className = "metric-card external-provider";
      const name = document.createElement("strong");
      name.textContent = provider.name || providerNames[provider.id] || provider.id;
      const state = document.createElement("span");
      state.className = "external-status external-status-" + provider.status;
      state.textContent = statusLabels[provider.status] || provider.status;
      card.append(name, state);
      container.appendChild(card);
    });
  }

  const SERIES_COLORS = ["#2e8b57", "#1f6fb2", "#c77d12", "#8e44ad", "#b42318", "#0e7490", "#4d7c0f", "#be185d"];
  const TYPICAL_YEAR = "Typical year";

  function fmtValue(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "–";
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function cell(text, className) {
    const td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = String(text);
    return td;
  }

  function headCell(text) {
    const th = document.createElement("th");
    th.textContent = text;
    return th;
  }

  function themeColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue("--text").trim() || "#1f2a37",
      muted: style.getPropertyValue("--muted").trim() || "#5b6675",
      border: style.getPropertyValue("--border").trim() || "#d6d2c4"
    };
  }

  // Groups records into one series per source and parameter, keyed by date.
  function buildSeries(records) {
    const series = new Map();
    const dates = new Set();
    records.forEach(function (record) {
      if (record.value === null || record.value === undefined) return;
      const date = record.timestamp ? String(record.timestamp).slice(0, 10) : TYPICAL_YEAR;
      const key = record.source + " · " + record.parameter;
      if (!series.has(key)) {
        series.set(key, { key: key, source: record.source, parameter: record.parameter, unit: record.unit || "", points: new Map() });
      }
      series.get(key).points.set(date, Number(record.value));
      dates.add(date);
    });
    const sortedDates = Array.from(dates).sort(function (a, b) {
      if (a === TYPICAL_YEAR) return 1;
      if (b === TYPICAL_YEAR) return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return { series: Array.from(series.values()), dates: sortedDates };
  }

  function renderSummary(series) {
    const body = $("external-summary-rows");
    body.textContent = "";
    if (!series.length) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.textContent = "No records returned for this request.";
      row.appendChild(td);
      body.appendChild(row);
      return;
    }
    series.forEach(function (item) {
      const values = Array.from(item.points.values());
      const total = values.reduce(function (sum, v) { return sum + v; }, 0);
      const row = document.createElement("tr");
      row.append(
        cell(item.source),
        cell(item.parameter),
        cell(item.unit),
        cell(fmtValue(total / values.length), "is-number"),
        cell(fmtValue(Math.min.apply(null, values)), "is-number"),
        cell(fmtValue(Math.max.apply(null, values)), "is-number"),
        cell(values.length, "is-number")
      );
      body.appendChild(row);
    });
  }

  function renderPivot(built) {
    const table = $("external-pivot");
    table.textContent = "";
    const body = document.createElement("tbody");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.appendChild(headCell("Date"));
    built.series.forEach(function (item) {
      headRow.appendChild(headCell(item.source + " · " + item.parameter + (item.unit ? " (" + item.unit + ")" : "")));
    });
    head.appendChild(headRow);
    table.appendChild(head);

    if (!built.dates.length) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = Math.max(built.series.length + 1, 1);
      td.textContent = "No records returned for this request.";
      row.appendChild(td);
      body.appendChild(row);
    }
    built.dates.slice(0, 366).forEach(function (date) {
      const row = document.createElement("tr");
      row.appendChild(cell(date));
      built.series.forEach(function (item) {
        row.appendChild(cell(item.points.has(date) ? fmtValue(item.points.get(date)) : "–", "is-number"));
      });
      body.appendChild(row);
    });
    table.appendChild(body);
  }

  // One linear chart per unit so values on different scales are not compared on one axis.
  function renderCharts(built) {
    const container = $("external-charts");
    charts.forEach(function (c) { c.destroy(); });
    charts = [];
    container.textContent = "";
    const colors = themeColors();
    const units = {};
    built.series.forEach(function (item) {
      const unit = item.unit || "value";
      (units[unit] = units[unit] || []).push(item);
    });
    const unitNames = Object.keys(units);
    if (!unitNames.length || !window.Chart) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    unitNames.forEach(function (unit, unitIndex) {
      const block = document.createElement("div");
      block.className = "external-chart-block";
      const title = document.createElement("h4");
      title.textContent = "Comparison in " + unit;
      const canvas = document.createElement("canvas");
      canvas.height = 120;
      canvas.setAttribute("aria-label", "Line chart comparing " + unit + " across sources");
      block.append(title, canvas);
      container.appendChild(block);

      const labels = built.dates.map(function (d) { return d === TYPICAL_YEAR ? "Typical year" : d; });
      charts.push(new Chart(canvas, {
        type: "line",
        data: {
          labels: labels,
          datasets: units[unit].map(function (item, index) {
            const color = SERIES_COLORS[(unitIndex * 3 + index) % SERIES_COLORS.length];
            return {
              label: item.source + " · " + item.parameter,
              data: built.dates.map(function (d) { return item.points.has(d) ? item.points.get(d) : null; }),
              borderColor: color,
              backgroundColor: color,
              tension: 0.25,
              pointRadius: 2,
              spanGaps: true
            };
          })
        },
        options: {
          responsive: true,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { labels: { color: colors.text } } },
          scales: {
            x: { ticks: { color: colors.muted, maxTicksLimit: 12 }, grid: { color: colors.border } },
            y: {
              title: { display: true, text: unit, color: colors.muted },
              ticks: { color: colors.muted },
              grid: { color: colors.border }
            }
          }
        }
      }));
    });
  }

  function renderRecords(records) {
    const built = buildSeries(records);
    renderSummary(built.series);
    renderPivot(built);
    renderCharts(built);
  }

  async function loadStatus() {
    const result = await window.SolarSenseApi.external("status");
    if (result.ok && result.body.providers) renderProviders(result.body.providers);
  }

  async function fetchData(event) {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const params = {
      latitude: data.get("latitude"),
      longitude: data.get("longitude"),
      start: data.get("start"),
      end: data.get("end")
    };
    const size = data.get("peak_power_kw");
    setError("");
    $("external-summary-rows").textContent = "";
    $("external-pivot").textContent = "";
    const loading = document.createElement("tr");
    const loadingCell = document.createElement("td");
    loadingCell.colSpan = 7;
    loadingCell.textContent = "Loading...";
    loading.appendChild(loadingCell);
    $("external-summary-rows").appendChild(loading);

    const [nasa, pvgis] = await Promise.all([
      window.SolarSenseApi.external("nasa-power", params),
      window.SolarSenseApi.external("pvgis", Object.assign({}, params, { peak_power_kw: size }))
    ]);

    const records = [];
    [nasa, pvgis].forEach(function (result) {
      if (!result.ok) {
        setError(result.body.error || "The request was rejected.");
        return;
      }
      if (result.body.status !== "connected") {
        setError(result.body.error || "This provider is unavailable right now.");
      }
      (result.body.records || []).forEach(function (r) { records.push(r); });
    });

    renderRecords(records);
    loadStatus();
  }

  function activate() {
    if (!initialised) {
      initialised = true;
      $("external-form").addEventListener("submit", fetchData);
      const end = new Date();
      end.setDate(end.getDate() - 2);
      const start = new Date(end);
      start.setDate(start.getDate() - 6);
      const iso = function (d) { return d.toISOString().slice(0, 10); };
      $("external-form").elements.start.value = iso(start);
      $("external-form").elements.end.value = iso(end);
    }
    loadStatus();
  }

  window.SolarSenseDataHub = { activate: activate };
})();
