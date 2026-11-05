(function () {
  const preference = localStorage.getItem("solarsense-theme");
  const initialTheme = preference === "dark" ? "dark" : "light";

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("solarsense-theme", theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = theme === "dark" ? "#07120F" : "#F7F3E8";

    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      const nextTheme = theme === "dark" ? "light" : "dark";
      button.setAttribute("aria-label", "Switch to " + nextTheme + " mode");
      button.setAttribute("aria-pressed", String(theme === "dark"));
      const label = button.querySelector(".theme-toggle-label");
      if (label) label.textContent = nextTheme === "dark" ? "Dark mode" : "Light mode";
    });
  }

  applyTheme(initialTheme);
  document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
    button.addEventListener("click", function () {
      applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  });
})();
