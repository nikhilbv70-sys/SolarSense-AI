(function () {
  const sectionDetails = {
    overview: { title: "Overview", description: "" },
    monitoring: { title: "Plant Monitoring", description: "Inspect simulated operating readings and plant-level conditions." },
    faults: { title: "Fault Detection", description: "Review abnormal patterns and the evidence that supports further investigation." },
    prediction: { title: "Energy Prediction", description: "Explore simulated generation estimates and the assumptions behind them." },
    "time-machine": { title: "Solar Energy Time Machine", description: "Compare current performance, continued underperformance, and an assumed maintenance scenario." },
    cost: { title: "Maintenance Cost", description: "Estimate rupee costs for inspections, corrective work and energy lost to sustained underperformance." },
    priority: { title: "Maintenance Priority", description: "Rank sustained underperformance windows from real readings and track each alert through review." },
    recovery: { title: "Recovery Verification", description: "Compare daily performance before and after a recorded maintenance action." },
    data: { title: "Data Management", description: "Review and validate plant readings before analysis." },
    external: { title: "External Data Hub", description: "Pull public solar and weather datasets for a location. Each provider is shown separately with its status." },
    settings: { title: "Settings", description: "Manage demonstration preferences and workspace details." }
  };

  const PROTECTED_SECTIONS = { faults: true, "time-machine": true, priority: true, cost: true, recovery: true };
  const MODULE_VIEWS = { prediction: "prediction-view", recovery: "recovery-view", settings: "settings-view" };
  let authPromise = null;
  let authFailure = null;
  let signedIn = false;

  function selectSection(sectionId) {
    const section = sectionDetails[sectionId];
    if (!section) return;

    if (PROTECTED_SECTIONS[sectionId] && !signedIn) {
      authPromise.then(function (ok) {
        if (ok) selectSection(sectionId);
        else if (authFailure && authFailure.status === 401) window.location.assign("/js/login.html");
        else window.alert(authFailure ? authFailure.message : "Sign-in status could not be confirmed.");
      });
      return;
    }

    const overview = document.getElementById("overview-view");
    const monitoring = document.getElementById("monitoring-view");
    const timeMachine = document.getElementById("time-machine-view");
    const dataView = document.getElementById("data-view");
    const externalView = document.getElementById("external-view");
    const faultView = document.getElementById("fault-view");
    const priorityView = document.getElementById("priority-view");
    const costView = document.getElementById("cost-view");
    const secondary = document.getElementById("secondary-view");
    const isOverview = sectionId === "overview";
    const isMonitoring = sectionId === "monitoring";
    const isTimeMachine = sectionId === "time-machine";
    const isData = sectionId === "data";
    const isExternal = sectionId === "external";
    const isFaults = sectionId === "faults";
    const isPriority = sectionId === "priority";
    const isCost = sectionId === "cost";
    const moduleViewId = MODULE_VIEWS[sectionId];

    overview.hidden = !isOverview;
    monitoring.hidden = !isMonitoring;
    timeMachine.hidden = !isTimeMachine;
    dataView.hidden = !isData;
    externalView.hidden = !isExternal;
    faultView.hidden = !isFaults;
    priorityView.hidden = !isPriority;
    costView.hidden = !isCost;
    Object.keys(MODULE_VIEWS).forEach(function (key) {
      document.getElementById(MODULE_VIEWS[key]).hidden = key !== sectionId;
    });
    secondary.hidden = isOverview || isMonitoring || isTimeMachine || isData || isExternal || isFaults || isPriority || isCost || !!moduleViewId;
    document.getElementById("breadcrumb-current").textContent = section.title;
    document.title = "SolarSense AI | " + section.title;

    if (!isOverview && !isMonitoring) {
      document.getElementById("secondary-title").textContent = section.title;
      document.getElementById("secondary-description").textContent = section.description;
      const stage = sectionId === "time-machine" ? "Signature feature · planned stage 4" : "Module build · planned for a later stage";
      document.getElementById("secondary-stage").textContent = stage;
    }
    if (isMonitoring && window.SolarSenseMonitoring) window.SolarSenseMonitoring.activate();
    if (isTimeMachine && window.SolarSenseTimeMachine) window.SolarSenseTimeMachine.activate();
    if (isData && window.SolarSenseDataManagement) window.SolarSenseDataManagement.activate();
    if (isExternal && window.SolarSenseDataHub) window.SolarSenseDataHub.activate();
    if (isFaults && window.SolarSenseFaults) window.SolarSenseFaults.activate();
    if (isPriority && window.SolarSensePriority) window.SolarSensePriority.activate();
    if (isCost && window.SolarSenseCost) window.SolarSenseCost.activate();
    if (sectionId === "prediction" && window.SolarSensePrediction) window.SolarSensePrediction.activate();
    if (sectionId === "recovery" && window.SolarSenseRecovery) window.SolarSenseRecovery.activate();
    if (sectionId === "settings" && window.SolarSenseSettings) window.SolarSenseSettings.activate();

    document.querySelectorAll("[data-section]").forEach(function (button) {
      const selected = button.dataset.section === sectionId;
      if (button.classList.contains("nav-item")) {
        button.classList.toggle("is-active", selected);
        if (selected) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function initialize() {
    document.querySelectorAll("[data-section]").forEach(function (button) {
      button.addEventListener("click", function () {
        selectSection(button.dataset.section);
      });
    });

    document.querySelectorAll("[data-section-link]").forEach(function (button) {
      button.addEventListener("click", function () {
        selectSection(button.dataset.sectionLink);
      });
    });

    document.querySelector("[data-home]").addEventListener("click", function (event) {
      event.preventDefault();
      selectSection("overview");
    });

    const notificationButton = document.getElementById("notification-button");
    const notificationPopover = document.getElementById("notification-popover");
    notificationButton.addEventListener("click", function (event) {
      event.stopPropagation();
      const isExpanded = notificationButton.getAttribute("aria-expanded") === "true";
      notificationButton.setAttribute("aria-expanded", String(!isExpanded));
      notificationPopover.hidden = isExpanded;
    });
    document.addEventListener("click", function (event) {
      if (!event.target.closest(".notification-wrap")) {
        notificationButton.setAttribute("aria-expanded", "false");
        notificationPopover.hidden = true;
      }
    });

    document.getElementById("dismiss-notice").addEventListener("click", function () {
      document.querySelector(".notice-banner").hidden = true;
    });

    const profileButton = document.getElementById("profile-button");
    const signoutButton = document.getElementById("signout-button");
    async function signOut() {
      if (!window.confirm("Sign out of your SolarSense account?")) return;
      try {
        await window.SolarSenseApi.logout();
        window.location.assign("/js/login.html");
      } catch (error) {
        window.alert(error.message);
      }
    }
    signoutButton.addEventListener("click", signOut);
    profileButton.addEventListener("click", async function () {
      if (profileButton.dataset.authenticated !== "true") {
        window.alert("You are viewing the demo profile. Sign in to use your PostgreSQL-backed account.");
        return;
      }
      await signOut();
    });

    authPromise = window.SolarSenseApi.currentUser().then(function (response) {
      signedIn = true;
      const user = response.user;
      if (response.redirect && response.redirect !== "/js/index.html") {
        window.location.replace(response.redirect);
        return true;
      }
      const initials = user.full_name.split(/\s+/).slice(0, 2).map(function (part) {
        return part.charAt(0).toUpperCase();
      }).join("");
      profileButton.dataset.authenticated = "true";
      profileButton.setAttribute("aria-label", "Sign out " + user.full_name);
      profileButton.querySelector(".avatar").textContent = initials;
      profileButton.querySelector(".profile-copy strong").textContent = user.full_name;
      profileButton.querySelector(".profile-copy small").textContent = user.email;
      signoutButton.hidden = false;
      return true;
    }).catch(function (error) {
      authFailure = error;
      profileButton.dataset.authenticated = "false";
      profileButton.querySelector(".profile-copy small").textContent =
        error.status === 401 ? "Demo mode" : "Backend unavailable";
      return false;
    });

    document.getElementById("chart-info-button").addEventListener("click", function () {
      window.alert("This chart compares simulated generation with a simulated expected profile. It is not a forecast or a validated model output.");
    });

    if (window.SolarSenseDashboard) window.SolarSenseDashboard.initialize();
  }

  initialize();
})();
