/* Portal scripts: sidebar, password toggle, confirmations, programme picker */
(function () {
  "use strict";

  /* Mobile sidebar */
  var side = document.getElementById("side");
  var toggle = document.querySelector(".side-toggle");
  function setSide(open) {
    if (!side || !toggle) return;
    side.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (toggle) toggle.addEventListener("click", function () { setSide(!side.classList.contains("open")); });
  document.querySelectorAll("[data-close-side]").forEach(function (el) { el.addEventListener("click", function () { setSide(false); }); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setSide(false); });

  /* Show / hide password */
  document.querySelectorAll("[data-pw]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var input = document.getElementById(btn.getAttribute("data-pw"));
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
    });
  });

  /* Confirm before destructive actions */
  document.querySelectorAll("form[data-confirm]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      if (!window.confirm(form.getAttribute("data-confirm"))) e.preventDefault();
    });
  });

  /* Show / hide a section */
  document.querySelectorAll("[data-toggle]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var el = document.getElementById(btn.getAttribute("data-toggle"));
      if (!el) return;
      el.hidden = !el.hidden;
      if (!el.hidden) { var first = el.querySelector("input"); if (first) first.focus(); }
    });
  });

  /* Admission form: programme options follow the chosen branch */
  var branch = document.getElementById("branch");
  var programme = document.getElementById("programme");
  if (branch && programme) {
    var map = JSON.parse(branch.getAttribute("data-programmes") || "{}");
    var fill = function (keep) {
      var list = map[branch.value] || [];
      var current = keep || programme.value;
      programme.innerHTML = "";
      var first = document.createElement("option");
      first.value = ""; first.textContent = list.length ? "Choose a programme" : "Choose a branch first";
      programme.appendChild(first);
      list.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p; o.textContent = p; if (p === current) o.selected = true;
        programme.appendChild(o);
      });
    };
    branch.addEventListener("change", function () { fill(""); });
    fill(programme.getAttribute("data-value"));
  }
})();
