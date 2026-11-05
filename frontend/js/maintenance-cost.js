(function () {
  const $ = function (id) { return document.getElementById(id); };
  const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  const numbers = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });
  const BANDS = ["Critical", "High", "Medium", "Low"];
  let loaded = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function setStatus(message, isError) {
    const node = $("cost-status");
    node.textContent = message || "";
    node.classList.toggle("is-error", !!isError);
  }

  function setOverview(data, message) {
    const total = $("overview-cost-total");
    if (!total) return;
    if (!data) {
      total.textContent = "--";
      $("overview-cost-loss").textContent = "--";
      $("overview-cost-net").textContent = "--";
      $("overview-cost-status").textContent = message || "Sign in to load maintenance costs.";
      return;
    }
    total.textContent = rupees.format(data.totals.maintenance_cost_inr);
    $("overview-cost-loss").textContent = rupees.format(data.totals.lost_value_inr);
    $("overview-cost-net").textContent = rupees.format(data.totals.net_recovery_inr);
    $("overview-cost-status").textContent =
      data.totals.open_alerts + " open of " + data.totals.alerts + " alerts · rupee estimates from planning rates.";
  }

  function renderKpis(data) {
    const wrap = $("cost-kpis");
    wrap.replaceChildren();
    const cards = [
      ["Energy lost", numbers.format(data.totals.lost_kwh) + " kWh", "Sustained underperformance in daylight"],
      ["Lost energy value", rupees.format(data.totals.lost_value_inr), "Lost kWh × ₹" + data.assumptions.tariff_per_kwh_inr + "/kWh (" + data.assumptions.tariff_source + ")"],
      ["Maintenance cost", rupees.format(data.totals.maintenance_cost_inr), "Inspection and corrective work for all alerts"],
      ["Open items cost", rupees.format(data.totals.open_maintenance_cost_inr), data.totals.open_alerts + " alerts not yet resolved"],
      ["Net recovery", rupees.format(data.totals.net_recovery_inr), "Lost value minus maintenance cost"],
      ["Routine O&M (annual)", rupees.format(data.totals.routine_om_annual_inr), "₹" + data.assumptions.om_rate_inr_per_kwp_year + " per kWp × " + numbers.format(data.plant.capacity_kw) + " kWp"]
    ];
    cards.forEach(function (card) {
      const box = el("article", "cost-kpi");
      box.appendChild(el("span", "cost-kpi-label", card[0]));
      box.appendChild(el("strong", "cost-kpi-value", card[1]));
      box.appendChild(el("span", "cost-kpi-note", card[2]));
      wrap.appendChild(box);
    });
  }

  function renderBands(data) {
    const wrap = $("cost-bands");
    wrap.replaceChildren();
    BANDS.forEach(function (band) {
      const info = data.by_priority[band];
      const card = el("div", "priority-count priority-" + band.toLowerCase());
      card.appendChild(el("span", "priority-count-label", band + " · " + info.count + " alerts"));
      card.appendChild(el("strong", "priority-count-value", rupees.format(info.cost_inr)));
      wrap.appendChild(card);
    });
  }

  function renderRows(data) {
    const tbody = $("cost-rows");
    tbody.replaceChildren();
    if (!data.items.length) {
      const row = el("tr");
      const cell = el("td", "priority-empty", "No sustained underperformance windows were found, so there are no maintenance costs to estimate.");
      cell.colSpan = 9;
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }
    data.items.forEach(function (item) {
      const row = el("tr");
      const priorityCell = el("td");
      priorityCell.appendChild(el("span", "priority-badge priority-" + item.priority.toLowerCase(), item.priority));
      row.appendChild(priorityCell);
      row.appendChild(el("td", "", item.date + " " + item.window));
      row.appendChild(el("td", "", numbers.format(item.loss_kwh) + " kWh"));
      row.appendChild(el("td", "", rupees.format(item.loss_value_inr)));
      row.appendChild(el("td", "", rupees.format(item.inspection_cost_inr)));
      row.appendChild(el("td", "", rupees.format(item.action_cost_inr)));
      row.appendChild(el("td", "", rupees.format(item.total_cost_inr)));
      const net = el("td", "", rupees.format(item.net_recovery_inr));
      net.classList.toggle("is-error", item.net_recovery_inr < 0);
      row.appendChild(net);
      row.appendChild(el("td", "", item.status));
      tbody.appendChild(row);
    });
  }

  function render(data) {
    $("cost-subtitle").textContent =
      "Rupee estimates for " + data.plant.plant_name + " (" + numbers.format(data.plant.capacity_kw) + " kWp), built from the same imported-reading alerts as Maintenance Priority.";
    renderKpis(data);
    renderBands(data);
    renderRows(data);
    $("cost-assumptions").textContent =
      "Tariff ₹" + data.assumptions.tariff_per_kwh_inr + "/kWh (" + data.assumptions.tariff_source + "). " +
      "Inspection visit ₹" + data.assumptions.inspection_visit_inr + " per alert. Corrective work: Critical ₹" +
      data.assumptions.action_cost_inr.Critical + ", High ₹" + data.assumptions.action_cost_inr.High +
      ", Medium ₹" + data.assumptions.action_cost_inr.Medium + ", Low ₹" + data.assumptions.action_cost_inr.Low +
      " per alert. Routine O&M ₹" + data.assumptions.om_rate_inr_per_kwp_year + " per kWp per year. " +
      data.assumptions.note;
  }

  function load() {
    setStatus("Calculating costs from the imported readings…", false);
    return window.SolarSenseApi.maintenanceCost()
      .then(function (data) {
        render(data);
        setOverview(data);
        loaded = true;
        setStatus("", false);
      })
      .catch(function (error) {
        $("cost-rows").replaceChildren();
        $("cost-kpis").replaceChildren();
        $("cost-bands").replaceChildren();
        setOverview(null, error.message || "Maintenance costs could not be loaded.");
        setStatus(error.message || "Maintenance costs could not be loaded.", true);
      });
  }

  function activate() {
    if (!loaded) load();
  }

  document.addEventListener("DOMContentLoaded", function () {
    const refresh = $("cost-refresh");
    if (refresh) refresh.addEventListener("click", load);
    if ($("overview-cost-total")) load();
  });

  window.SolarSenseCost = { activate: activate };
})();
