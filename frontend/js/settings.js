(function () {
  const $ = function (id) { return document.getElementById(id); };
  let initialised = false;

  function setStatus(message, isError) {
    const node = $("settings-status");
    node.textContent = message || "";
    node.classList.toggle("is-error", !!isError);
  }

  function fillForm(settings) {
    const form = $("settings-form");
    form.elements.latitude.value = settings.latitude;
    form.elements.longitude.value = settings.longitude;
    form.elements.default_horizon.value = settings.default_horizon;
    form.elements.timezone.value = settings.timezone || "";
    form.elements.plant_id.value = settings.plant_id == null ? "" : String(settings.plant_id);
    form.elements.alert_threshold_pct.value = settings.alert_threshold_pct;
    form.elements.tariff_per_kwh.value = settings.tariff_per_kwh == null ? "" : settings.tariff_per_kwh;
    form.elements.energy_unit.value = settings.energy_unit || "kWh";
  }

  function fillPlants(plants) {
    const select = $("settings-form").elements.plant_id;
    const selected = select.value;
    select.innerHTML = "";
    const fallback = document.createElement("option");
    fallback.value = "";
    fallback.textContent = "Default (first plant)";
    select.appendChild(fallback);
    (plants || []).forEach(function (plant) {
      const option = document.createElement("option");
      option.value = String(plant.id);
      option.textContent = plant.plant_name + (plant.capacity_kw ? " (" + plant.capacity_kw + " kW)" : "");
      select.appendChild(option);
    });
    select.value = selected;
  }

  function setFormDisabled(disabled) {
    $("settings-form").querySelectorAll("input, select, button").forEach(function (node) { node.disabled = disabled; });
  }

  function load() {
    return Promise.all([window.SolarSenseApi.getSettings(), window.SolarSenseApi.getPlants()])
      .then(function (results) {
        const data = results[0];
        $("settings-name").textContent = data.account.full_name;
        $("settings-email").textContent = data.account.email;
        fillPlants(results[1].plants);
        fillForm(data.settings);
        setFormDisabled(false);
        setStatus("", false);
      })
      .catch(function (error) {
        $("settings-name").textContent = "Not signed in";
        $("settings-email").textContent = "–";
        setFormDisabled(true);
        setStatus(error.status === 401 ? "Sign in to change these settings." : (error.message || "Settings could not be loaded."), true);
      });
  }

  function save(event) {
    event.preventDefault();
    const form = event.target;
    const tariff = form.elements.tariff_per_kwh.value;
    const payload = {
      latitude: Number(form.elements.latitude.value),
      longitude: Number(form.elements.longitude.value),
      default_horizon: form.elements.default_horizon.value,
      timezone: form.elements.timezone.value.trim(),
      plant_id: form.elements.plant_id.value === "" ? null : Number(form.elements.plant_id.value),
      alert_threshold_pct: Number(form.elements.alert_threshold_pct.value),
      tariff_per_kwh: tariff === "" ? null : Number(tariff),
      energy_unit: form.elements.energy_unit.value
    };
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    window.SolarSenseApi.saveSettings(payload)
      .then(function (data) {
        fillForm(data.settings || payload);
        setStatus("Settings saved to PostgreSQL.", false);
      })
      .catch(function (error) {
        setStatus(error.message || "Settings could not be saved.", true);
      })
      .finally(function () { button.disabled = false; });
  }

  function init() {
    initialised = true;
    $("settings-form").addEventListener("submit", save);
  }

  function activate() {
    if (!initialised) init();
    load();
  }

  window.SolarSenseSettings = { activate: activate };
})();
