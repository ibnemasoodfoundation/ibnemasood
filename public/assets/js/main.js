/* Jamia Arabia Abdullah Bin Masood — site scripts */
(function () {
  "use strict";
  var WA_NUMBER = "14244416410";

  /* Sticky header shadow */
  var header = document.querySelector(".site-header");
  var onScroll = function () { if (header) header.classList.toggle("scrolled", window.scrollY > 8); };
  window.addEventListener("scroll", onScroll, { passive: true }); onScroll();

  /* Mobile menu */
  var toggle = document.querySelector(".menu-toggle");
  var nav = document.getElementById("site-nav");
  var scrim = document.querySelector(".scrim");
  function setMenu(open) {
    if (!nav || !toggle) return;
    nav.classList.toggle("open", open);
    document.body.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    toggle.innerHTML = open
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
  }
  if (toggle) toggle.addEventListener("click", function () { setMenu(!nav.classList.contains("open")); });
  if (scrim) scrim.addEventListener("click", function () { setMenu(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setMenu(false); });
  if (nav) nav.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () { setMenu(false); }); });

  /* Photo slots: show the patterned frame if a photo is missing */
  document.querySelectorAll(".ph img").forEach(function (img) {
    var mark = function () {
      var fb = img.getAttribute("data-fallback");
      if (fb && img.getAttribute("src") !== fb) { img.src = fb; return; }
      img.closest(".ph").classList.add("missing");
    };
    if (img.complete && img.naturalWidth === 0) mark();
    img.addEventListener("error", mark);
  });

  /* Toast */
  var toast = document.createElement("div");
  toast.className = "toast"; toast.setAttribute("role", "status"); toast.setAttribute("aria-live", "polite");
  document.body.appendChild(toast);
  var tTimer;
  function showToast(msg) {
    toast.textContent = msg; toast.classList.add("show");
    clearTimeout(tTimer); tTimer = setTimeout(function () { toast.classList.remove("show"); }, 2200);
  }

  /* Copy account numbers */
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var value = btn.getAttribute("data-copy");
      var done = function () {
        var label = btn.querySelector("span");
        if (label) { label.textContent = "Copied"; setTimeout(function () { label.textContent = "Copy"; }, 1800); }
        showToast("Account number copied");
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(value).then(done, fallback);
      } else { fallback(); }
      function fallback() {
        var ta = document.createElement("textarea"); ta.value = value; ta.setAttribute("readonly", "");
        ta.style.position = "absolute"; ta.style.left = "-9999px"; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) { showToast("Select the number to copy it"); }
        document.body.removeChild(ta);
      }
    });
  });

  /* Tabs (Education page) */
  var tabs = document.querySelectorAll('[role="tab"]');
  function activate(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      var panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
    if (history.replaceState) history.replaceState(null, "", "#" + tab.id.replace("tab-", ""));
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { activate(tab); });
    tab.addEventListener("keydown", function (e) {
      var dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (dir) { e.preventDefault(); activate(tabs[(i + dir + tabs.length) % tabs.length], true); }
    });
  });
  if (tabs.length && location.hash) {
    var fromHash = document.getElementById("tab-" + location.hash.slice(1));
    if (fromHash) activate(fromHash);
  }

  /* Contact form → opens WhatsApp with the message filled in */
  var form = document.getElementById("contact-form");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var ok = true;
      form.querySelectorAll("[required]").forEach(function (input) {
        var field = input.closest(".field");
        var valid = input.value.trim() !== "" && (input.type !== "tel" || /^[+\d][\d\s-]{6,}$/.test(input.value.trim()));
        field.classList.toggle("invalid", !valid);
        if (!valid && ok) { input.focus(); ok = false; }
      });
      if (!ok) return;
      var d = new FormData(form);
      var text =
        "Assalamu Alaikum,\n" +
        "Name: " + d.get("name") + "\n" +
        "Phone: " + d.get("phone") + "\n" +
        "Subject: " + d.get("topic") + "\n\n" +
        d.get("message");
      // Also save the message for the office dashboard; WhatsApp opens either way
      if (window.fetch) {
        fetch("/api/contact", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: d.get("name"), phone: d.get("phone"), topic: d.get("topic"), message: d.get("message") })
        }).catch(function () {});
      }
      window.open("https://wa.me/" + WA_NUMBER + "?text=" + encodeURIComponent(text), "_blank", "noopener");
      showToast("Opening WhatsApp…");
      form.reset();
    });
    form.querySelectorAll("input, textarea").forEach(function (el) {
      el.addEventListener("input", function () { el.closest(".field").classList.remove("invalid"); });
    });
  }

  /* Account link: "Sign in", or "Dashboard" when already signed in */
  var account = document.querySelector("[data-account]");
  if (account && window.fetch) {
    fetch("/api/me", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.user) { account.textContent = "Dashboard"; account.href = "/app"; }
      })
      .catch(function () {});
  }

  /* Footer year */
  document.querySelectorAll("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });
})();
