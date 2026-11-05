(function () {
  function showTab(name) {
    document.querySelectorAll(".gov-tab").forEach(function (button) {
      const active = button.dataset.tab === name;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".gov-tab-panel").forEach(function (panel) {
      panel.classList.toggle("is-active", panel.dataset.panel === name);
    });
    if (name === "analytics") window.SolarSenseGovernment.activate();
    if (name === "prediction") window.SolarSensePrediction.activate();
  }

  function initTabs() {
    document.querySelectorAll(".gov-tab").forEach(function (button) {
      button.addEventListener("click", function () { showTab(button.dataset.tab); });
    });
  }

  function loadNationalKpi() {
    window.SolarSenseApi.governmentStateCapacity()
      .then(function (data) {
        const total = data.totals && data.totals.solar_mw;
        document.getElementById("kpi-national").textContent = total === null || total === undefined
          ? "NA"
          : Number(total).toLocaleString(undefined, { maximumFractionDigits: 0 }) + " MW";
      })
      .catch(function () {
        document.getElementById("kpi-national").textContent = "Unavailable";
      });
  }

  function init() {
    window.SolarSenseApi.currentUser()
      .then(function (response) {
        if (response.redirect !== "/js/government.html") {
          window.location.replace(response.redirect);
          return;
        }
        document.getElementById("gov-user").textContent = response.user.full_name;
        window.SolarSenseFleet.init();
        initTabs();
        loadNationalKpi();
      })
      .catch(function () {
        window.location.replace("/js/login.html");
      });

    document.getElementById("gov-signout").addEventListener("click", function () {
      window.SolarSenseApi.logout().finally(function () {
        window.location.replace("/js/login.html");
      });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
