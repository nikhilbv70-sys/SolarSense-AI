(function () {
  const $ = function (id) { return document.getElementById(id); };
  const PRIORITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const ACTIONS = {
    Critical: "Inspect inverters and string currents first",
    High: "Check soiling, shading and inverter logs",
    Medium: "Review sensor readings and cleaning schedule",
    Low: "Routine check only"
  };

  // SIMULATED sample plants. Replace with registry data in Phase 6.
  const SAMPLE_PLANTS = [
    { id: "GOV-001", name: "Jaipur North Rooftop Array", state: "Rajasthan", district: "Jaipur", capacityKw: 500, expectedKwh: 2600, actualKwh: 2410, lastService: "2026-09-12" },
    { id: "GOV-002", name: "Jodhpur Solar Park Block A", state: "Rajasthan", district: "Jodhpur", capacityKw: 1000, expectedKwh: 5200, actualKwh: 3900, lastService: "2026-06-30" },
    { id: "GOV-003", name: "Kutch Ground Mount", state: "Gujarat", district: "Kutch", capacityKw: 750, expectedKwh: 3900, actualKwh: 3700, lastService: "2026-10-02" },
    { id: "GOV-004", name: "Ahmedabad Industrial Roof", state: "Gujarat", district: "Ahmedabad", capacityKw: 300, expectedKwh: 1550, actualKwh: 1260, lastService: "2026-07-18" },
    { id: "GOV-005", name: "Bhopal Water Works Array", state: "Madhya Pradesh", district: "Bhopal", capacityKw: 400, expectedKwh: 2080, actualKwh: 2000, lastService: "2026-10-21" },
    { id: "GOV-006", name: "Indore Municipal Rooftop", state: "Madhya Pradesh", district: "Indore", capacityKw: 600, expectedKwh: 3120, actualKwh: 2400, lastService: "2026-05-14" },
    { id: "GOV-007", name: "Bengaluru Rural Farm Array", state: "Karnataka", district: "Bengaluru Rural", capacityKw: 250, expectedKwh: 1300, actualKwh: 1270, lastService: "2026-10-09" },
    { id: "GOV-008", name: "Lucknow Govt Office Array", state: "Uttar Pradesh", district: "Lucknow", capacityKw: 900, expectedKwh: 4680, actualKwh: 3600, lastService: "2026-04-27" }
  ];

  // SIMULATED sample audit entries. Real audit history is added in Phase 7.
  const AUDIT_SAMPLE = [
    { time: "2026-11-05 18:10", user: "Government admin", action: "Signed in", target: "Government portal" },
    { time: "2026-11-04 11:42", user: "Government admin", action: "Viewed state capacity", target: "State-wise capacity CSV" },
    { time: "2026-11-03 09:15", user: "District officer (sample)", action: "Marked alert Under Investigation", target: "GOV-002" }
  ];

  function derive(p) {
    const ratio = p.actualKwh / p.expectedKwh;
    let priority = "Low";
    if (ratio < 0.8) priority = "Critical";
    else if (ratio < 0.88) priority = "High";
    else if (ratio < 0.94) priority = "Medium";
    return Object.assign({}, p, { ratio: ratio, priority: priority, underperforming: ratio < 0.94 });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function num(value, digits) {
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits === undefined ? 0 : digits });
  }

  function pct(ratio) {
    return (ratio * 100).toFixed(1) + "%";
  }

  function badge(priority) {
    return el("span", "gov-badge gov-badge-" + priority.toLowerCase(), priority);
  }

  function row(cells) {
    const tr = el("tr");
    cells.forEach(function (cell) {
      const td = el("td");
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell;
      tr.appendChild(td);
    });
    return tr;
  }

  function fill(id, rows) {
    const body = $(id);
    body.replaceChildren.apply(body, rows);
  }

  function renderOverview(plants) {
    const capacity = plants.reduce(function (s, p) { return s + p.capacityKw; }, 0);
    const actual = plants.reduce(function (s, p) { return s + p.actualKwh; }, 0);
    const under = plants.filter(function (p) { return p.underperforming; }).length;
    $("kpi-plants").textContent = String(plants.length);
    $("kpi-capacity").textContent = num(capacity / 1000, 2) + " MW";
    $("kpi-generation").textContent = num(actual / 1000, 1) + " MWh";
    $("kpi-under").textContent = under + " of " + plants.length;
  }

  function renderRegistry(plants, state) {
    const rows = plants
      .filter(function (p) { return state === "all" || p.state === state; })
      .map(function (p) {
        return row([p.id, p.name, p.state, p.district, num(p.capacityKw), num(p.expectedKwh), num(p.actualKwh), badge(p.priority)]);
      });
    fill("registry-body", rows);
  }

  function populateStates(selectId, plants) {
    const select = $(selectId);
    const states = Array.from(new Set(plants.map(function (p) { return p.state; }))).sort();
    select.replaceChildren();
    select.appendChild(el("option", "", "All states"));
    select.firstChild.value = "all";
    states.forEach(function (s) {
      const option = el("option", "", s);
      option.value = s;
      select.appendChild(option);
    });
  }

  let districtChart = null;

  function renderDistricts(plants, state) {
    const scoped = state && state !== "all" ? plants.filter(function (p) { return p.state === state; }) : plants;
    const groups = {};
    scoped.forEach(function (p) {
      const key = p.state + "|" + p.district;
      if (!groups[key]) groups[key] = { state: p.state, district: p.district, count: 0, capacity: 0, expected: 0, actual: 0 };
      const g = groups[key];
      g.count += 1; g.capacity += p.capacityKw; g.expected += p.expectedKwh; g.actual += p.actualKwh;
    });
    const list = Object.keys(groups).sort().map(function (key) { return groups[key]; });
    fill("district-body", list.map(function (g) {
      return row([g.state, g.district, num(g.count), num(g.capacity), pct(g.actual / g.expected)]);
    }));
    drawDistrictChart(list);
  }

  function drawDistrictChart(list) {
    if (!window.Chart || !$("gov-district-chart")) return;
    if (districtChart) districtChart.destroy();
    districtChart = new Chart($("gov-district-chart"), {
      type: "bar",
      data: {
        labels: list.map(function (g) { return g.district; }),
        datasets: [{
          label: "Simulated capacity (kW)",
          data: list.map(function (g) { return g.capacity; }),
          backgroundColor: list.map(function (g) { return g.actual / g.expected >= 0.94 ? "#16A34A" : "#D97706"; })
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  }

  function renderRanking(plants) {
    const sorted = plants.slice().sort(function (a, b) { return a.ratio - b.ratio; });
    const rows = sorted.map(function (p, i) {
      const reason = p.underperforming
        ? "Output " + pct(p.ratio) + " of expected"
        : "Within expected range";
      return row([String(i + 1), p.name, p.state, pct(p.ratio), badge(p.priority), reason]);
    });
    fill("ranking-body", rows);
  }

  function renderMaintenance(plants) {
    const open = plants
      .filter(function (p) { return p.priority !== "Low"; })
      .sort(function (a, b) { return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]; });
    const count = function (level) { return plants.filter(function (p) { return p.priority === level; }).length; };
    $("maint-summary").textContent = "Critical: " + count("Critical") + " · High: " + count("High") + " · Medium: " + count("Medium") + " · Low: " + count("Low");
    const rows = open.map(function (p) {
      return row([p.id + " · " + p.name, badge(p.priority), ACTIONS[p.priority], p.lastService, "Open (sample)"]);
    });
    fill("maint-body", rows);
  }

  function renderAudit() {
    const rows = AUDIT_SAMPLE.map(function (a) {
      return row([a.time, a.user, a.action, a.target]);
    });
    fill("audit-body", rows);
  }

  function csvCell(value) {
    return '"' + String(value).replace(/"/g, '""') + '"';
  }

  function downloadReport(plants) {
    const lines = [
      ["SIMULATED SAMPLE DATA - for demonstration only"].map(csvCell).join(","),
      ["Plant ID", "Plant name", "State", "District", "Capacity (kW)", "Expected daily (kWh)", "Actual daily (kWh)", "Performance (%)", "Priority", "Recommended inspection"].map(csvCell).join(",")
    ];
    plants.forEach(function (p) {
      lines.push([p.id, p.name, p.state, p.district, p.capacityKw, p.expectedKwh, p.actualKwh, (p.ratio * 100).toFixed(1), p.priority, ACTIONS[p.priority]].map(csvCell).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = el("a");
    link.href = url;
    link.download = "solarsense-fleet-sample-report.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function init() {
    const plants = SAMPLE_PLANTS.map(derive);
    renderOverview(plants);
    populateStates("gov-state-filter", plants);
    populateStates("gov-district-state", plants);
    renderRegistry(plants, "all");
    renderDistricts(plants, "all");
    renderRanking(plants);
    renderMaintenance(plants);
    renderAudit();
    $("gov-state-filter").addEventListener("change", function (event) {
      renderRegistry(plants, event.target.value);
    });
    $("gov-district-state").addEventListener("change", function (event) {
      renderDistricts(plants, event.target.value);
    });
    $("report-download").addEventListener("click", function () { downloadReport(plants); });
  }

  window.SolarSenseFleet = { init: init };
})();
