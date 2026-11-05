(function () {
  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("pending-signout").addEventListener("click", function () {
      window.SolarSenseApi.logout().finally(function () {
        window.location.replace("/js/login.html");
      });
    });
  });
})();
