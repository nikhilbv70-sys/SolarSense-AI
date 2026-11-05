(function () {
  var IDLE_MS = 2 * 60 * 1000;
  var timer;
  var screen;

  function build() {
    screen = document.createElement("div");
    screen.className = "intro sleep-screen";
    screen.hidden = true;
    screen.innerHTML =
      '<img class="intro-logo" src="/assets/logo.jpg" alt="">' +
      '<h1 class="intro-name">SolarSense<span>AI</span></h1>' +
      '<p class="intro-tag">ENERGY INTELLIGENCE</p>' +
      '<p class="intro-hint">Sleeping — move the mouse or press any key to wake</p>';
    document.body.appendChild(screen);
  }

  function wake() {
    if (!screen.hidden) screen.hidden = true;
    clearTimeout(timer);
    timer = setTimeout(function () { screen.hidden = false; }, IDLE_MS);
  }

  var link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/js/css/intro.css";
  document.head.appendChild(link);

  build();
  ["mousemove", "mousedown", "keydown", "touchstart", "scroll"].forEach(function (name) {
    window.addEventListener(name, wake, { passive: true });
  });
  wake();
})();
