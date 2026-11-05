(function () {
  const $ = function (id) { return document.getElementById(id); };
  let loaded = false;
  let chart = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fmt(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "NA";
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function themeColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue("--text").trim() || "#1f2a37",
      muted: style.getPropertyValue("--muted").trim() || "#5b6675",
      border: style.getPropertyValue("--border").trim() || "#d6d2c4"
    };
  }

  function renderChart(rows) {
    const colors = themeColors();
    if (chart) chart.destroy();
    chart = new Chart($("gov-capacity-chart"), {
      type: "bar",
      data: {
        labels: rows.map(function (r) { return r.state; }),
        datasets: [
          { label: "Solar", data: rows.map(function (r) { return r.solar_mw || 0; }), backgroundColor: "#2e8b57", stack: "mw" },
          { label: "Wind", data: rows.map(function (r) { return r.wind_mw || 0; }), backgroundColor: "#3b82f6", stack: "mw" },
          { label: "Bio power", data: rows.map(function (r) { return r.bio_mw || 0; }), backgroundColor: "#b7791f", stack: "mw" },
          { label: "Small hydro", data: rows.map(function (r) { return r.small_hydro_mw || 0; }), backgroundColor: "#0ea5b7", stack: "mw" }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: colors.text } } },
        scales: {
          x: { stacked: true, ticks: { color: colors.muted, maxRotation: 70, minRotation: 45 }, grid: { color: colors.border } },
          y: {
            stacked: true,
            title: { display: true, text: "Installed capacity (MW)", color: colors.muted },
            ticks: { color: colors.muted },
            grid: { color: colors.border }
          }
        }
      }
    });
  }

  function renderTable(rows) {
    const body = $("gov-capacity-body");
    body.replaceChildren();
    rows.forEach(function (r) {
      const tr = el("tr");
      tr.appendChild(el("td", "", r.state));
      [r.solar_mw, r.wind_mw, r.bio_mw, r.small_hydro_mw, r.total_mw].forEach(function (value) {
        tr.appendChild(el("td", "", fmt(value)));
      });
      body.appendChild(tr);
    });
  }

  function renderCapacity(data) {
    $("gov-capacity-source").textContent = "Source: " + data.source;
    const t = data.totals || {};
    $("gov-capacity-total").textContent = "All-India total: " + fmt(t.total_mw) + " MW (solar " + fmt(t.solar_mw) + " MW)";
    renderChart(data.rows);
    renderTable(data.rows);
  }

  function load() {
    return window.SolarSenseApi.governmentStateCapacity()
      .then(function (data) { renderCapacity(data); })
      .catch(function (error) {
        $("gov-capacity-total").textContent = error.message || "State capacity data could not be loaded.";
      })
      .then(function () { loaded = true; });
  }

  function activate() {
    if (!loaded) load();
  }

  window.SolarSenseGovernment = { activate: activate };
})();
