(function () {
  function showFeedback(element, message, isError) {
    element.textContent = message;
    element.classList.toggle("is-error", Boolean(isError));
  }

  function setSubmitting(form, isSubmitting) {
    const button = form.querySelector(".submit-button");
    button.disabled = isSubmitting;
    button.setAttribute("aria-busy", String(isSubmitting));
    if (isSubmitting) button.dataset.originalLabel = button.textContent;
    button.textContent = isSubmitting ? "Please wait…" : button.dataset.originalLabel;
  }

  function setupPasswordToggles() {
    document.querySelectorAll(".password-toggle").forEach(function (button) {
      button.addEventListener("click", function () {
        const input = button.parentElement.querySelector("input");
        const reveal = input.type === "password";
        input.type = reveal ? "text" : "password";
        button.textContent = reveal ? "Hide" : "Show";
        button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
        button.setAttribute("aria-pressed", String(reveal));
      });
    });
  }

  const captchas = new WeakMap();

  async function setupCaptcha(form) {
    const box = form.querySelector("[data-captcha]");
    if (!box) return;
    try {
      const config = await window.SolarSenseApi.authConfig();
      const siteKey = config.recaptcha_site_key;
      if (!siteKey) return;

      await new Promise(function (resolve, reject) {
        window.onRecaptchaLoaded = resolve;
        const script = document.createElement("script");
        script.src = "https://www.google.com/recaptcha/api.js?onload=onRecaptchaLoaded&render=explicit";
        script.async = true;
        script.onerror = reject;
        document.head.appendChild(script);
      });
      captchas.set(form, window.grecaptcha.render(box, { sitekey: siteKey }));
    } catch {
      // The backend still enforces verification when it is configured.
    }
  }

  function captchaToken(form, feedback) {
    if (!captchas.has(form)) return "";
    const token = window.grecaptcha.getResponse(captchas.get(form));
    if (!token) showFeedback(feedback, "Please confirm you are not a robot.", true);
    return token;
  }

  async function submitAuthForm(form, feedback, operation, payload, fallbackDestination) {
    setSubmitting(form, true);
    showFeedback(feedback, "", false);
    try {
      const response = await operation(payload);
      window.location.assign((response && response.redirect) || fallbackDestination);
    } catch (error) {
      showFeedback(feedback, error.message, true);
      setSubmitting(form, false);
      if (captchas.has(form)) window.grecaptcha.reset(captchas.get(form));
    }
  }

  function initializeLogin() {
    const form = document.getElementById("login-form");
    if (!form) return;

    const feedback = document.getElementById("login-feedback");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!form.reportValidity()) return;

      const captcha = captchaToken(form, feedback);
      if (captchas.has(form) && !captcha) return;

      const values = new FormData(form);
      submitAuthForm(form, feedback, window.SolarSenseApi.login, {
        email: values.get("email"),
        password: values.get("password"),
        captcha: captcha
      }, "/js/index.html");
    });
    setupCaptcha(form);

    const registered = new URLSearchParams(window.location.search).get("registered");
    if (new URLSearchParams(window.location.search).get("reset")) {
      showFeedback(feedback, "Password updated. Sign in with your new password.", false);
    } else if (registered === "pending") {
      showFeedback(feedback, "Government access request received. Sign in after an administrator approves it.", false);
    } else if (registered) {
      showFeedback(feedback, "Account created. Please sign in.", false);
    }

    document.querySelector("[data-forgot-password]").addEventListener("click", function () {
      window.location.assign("/js/forgot-password.html");
    });
  }

  function initializeForgotPassword() {
    const requestForm = document.getElementById("forgot-request-form");
    const resetForm = document.getElementById("forgot-reset-form");
    if (!requestForm || !resetForm) return;

    const feedback = document.getElementById("forgot-feedback");
    const emailInput = document.getElementById("forgot-email");
    const sentTo = document.getElementById("forgot-sent-to");
    let currentEmail = "";

    function showStep(step) {
      requestForm.hidden = step !== "request";
      resetForm.hidden = step !== "reset";
      document.getElementById("forgot-title").textContent = step === "request" ? "Reset your password" : "Enter your code";
      document.getElementById("forgot-intro").textContent = step === "request"
        ? "We will email a 6-digit code to your account address."
        : "Enter the code we emailed you and choose a new password.";
    }

    requestForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!requestForm.reportValidity()) return;
      const captcha = captchaToken(requestForm, feedback);
      if (captchas.has(requestForm) && !captcha) return;

      currentEmail = emailInput.value.trim();
      setSubmitting(requestForm, true);
      showFeedback(feedback, "", false);
      window.SolarSenseApi.forgotPassword({ email: currentEmail, captcha: captcha })
        .then(function (response) {
          sentTo.textContent = currentEmail;
          showFeedback(feedback, response.message, false);
          showStep("reset");
        })
        .catch(function (error) {
          showFeedback(feedback, error.message, true);
        })
        .finally(function () {
          setSubmitting(requestForm, false);
          if (captchas.has(requestForm)) window.grecaptcha.reset(captchas.get(requestForm));
        });
    });

    resetForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!resetForm.reportValidity()) return;
      const password = document.getElementById("reset-password");
      const confirmation = document.getElementById("reset-confirm");
      if (password.value !== confirmation.value) {
        confirmation.setCustomValidity("Passwords do not match.");
        confirmation.reportValidity();
        confirmation.addEventListener("input", function clearMismatch() {
          confirmation.setCustomValidity("");
          confirmation.removeEventListener("input", clearMismatch);
        });
        return;
      }

      const values = new FormData(resetForm);
      setSubmitting(resetForm, true);
      showFeedback(feedback, "", false);
      window.SolarSenseApi.resetPassword({
        email: currentEmail,
        code: values.get("code"),
        password: values.get("password")
      })
        .then(function () {
          window.location.assign("/js/login.html?reset=1");
        })
        .catch(function (error) {
          showFeedback(feedback, error.message, true);
          setSubmitting(resetForm, false);
        });
    });

    document.getElementById("forgot-change-email").addEventListener("click", function () {
      showFeedback(feedback, "", false);
      showStep("request");
    });
    setupCaptcha(requestForm);
  }

  function initializeSignup() {
    const form = document.getElementById("signup-form");
    if (!form) return;

    const password = document.getElementById("signup-password");
    const confirmation = document.getElementById("signup-confirm");
    const feedback = document.getElementById("signup-feedback");

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!form.reportValidity()) return;

      if (password.value !== confirmation.value) {
        confirmation.setCustomValidity("Passwords do not match.");
        confirmation.reportValidity();
        confirmation.addEventListener("input", function clearPasswordMismatch() {
          confirmation.setCustomValidity("");
          confirmation.removeEventListener("input", clearPasswordMismatch);
        });
        return;
      }

      const captcha = captchaToken(form, feedback);
      if (captchas.has(form) && !captcha) return;

      const values = new FormData(form);
      submitAuthForm(form, feedback, window.SolarSenseApi.register, {
        name: values.get("name"),
        email: values.get("email"),
        password: values.get("password"),
        access: values.get("access") || "normal_user",
        organisation: values.get("organisation") || "",
        captcha: captcha
      }, "/js/login.html?registered=1");
    });
    setupCaptcha(form);
  }

  setupPasswordToggles();
  initializeLogin();
  initializeSignup();
  initializeForgotPassword();
})();
