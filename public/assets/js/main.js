/* Jamia Arabia Abdullah Bin Masood — site scripts */
(function () {
  "use strict";
  var WA_NUMBER = "923003948748";

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

  /* Language switcher (public pages only). Uses Google's page translation, which reads the "googtrans" cookie.
     Urdu and Arabic text, the founder's name and Quranic verses are marked translate="no" so they stay exactly as written. */
  var LANGS = [["en", "English"], ["ur", "اردو"], ["sd", "سنڌي"], ["ar", "العربية"]];
  var cookieLang = (document.cookie.match(/(?:^|;\s*)googtrans=\/en\/([a-z-]+)/) || [])[1] || "en";
  document.querySelectorAll('[lang="ur"], [lang="ar"], .bismillah, .brand .name').forEach(function (el) {
    el.classList.add("notranslate"); el.setAttribute("translate", "no");
  });

  function setLang(code) {
    var host = location.hostname, past = "Thu, 01 Jan 1970 00:00:00 GMT";
    // Clear on this host and on the parent domain (Google may set either)
    ["", "; domain=" + host, "; domain=." + host.replace(/^www\./, "")].forEach(function (d) {
      document.cookie = "googtrans=; expires=" + past + "; path=/" + d;
    });
    if (code !== "en") document.cookie = "googtrans=/en/" + code + "; path=/";
    location.reload();
  }

  var headerWrap = document.querySelector(".site-header .wrap");
  if (headerWrap) {
    var pick = document.createElement("div");
    pick.className = "lang-pick notranslate";
    pick.setAttribute("translate", "no");
    var current = LANGS.filter(function (l) { return l[0] === cookieLang; })[0] || LANGS[0];
    pick.innerHTML =
      '<button type="button" class="lang-btn" aria-haspopup="true" aria-expanded="false" aria-label="Language: ' + current[1] + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.8 4 6 4 9.5s-1.4 6.7-4 9.5c-2.6-2.8-4-6-4-9.5s1.4-6.7 4-9.5z"/></svg>' +
      '<span>' + current[1] + '</span></button>' +
      '<ul class="lang-menu" hidden>' + LANGS.map(function (l) {
        return '<li><button type="button" data-lang="' + l[0] + '" lang="' + l[0] + '"' + (l[0] === cookieLang ? ' aria-current="true"' : "") + ">" + l[1] + "</button></li>";
      }).join("") + "</ul>";
    headerWrap.insertBefore(pick, headerWrap.querySelector(".menu-toggle"));
    var btn = pick.querySelector(".lang-btn"), menu = pick.querySelector(".lang-menu");
    var openMenu = function (open) { menu.hidden = !open; btn.setAttribute("aria-expanded", open ? "true" : "false"); };
    btn.addEventListener("click", function (e) { e.stopPropagation(); openMenu(menu.hidden); });
    document.addEventListener("click", function () { openMenu(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") openMenu(false); });
    menu.querySelectorAll("[data-lang]").forEach(function (b) {
      b.addEventListener("click", function () { if (b.getAttribute("data-lang") !== cookieLang) setLang(b.getAttribute("data-lang")); else openMenu(false); });
    });
  }

  if (cookieLang !== "en") {
    var holder = document.createElement("div");
    holder.id = "gt-holder"; holder.hidden = true;
    document.body.appendChild(holder);
    window.jaabmTranslateInit = function () {
      new window.google.translate.TranslateElement({ pageLanguage: "en", autoDisplay: false }, "gt-holder");
    };
    var s = document.createElement("script");
    s.src = "https://translate.google.com/translate_a/element.js?cb=jaabmTranslateInit";
    s.async = true;
    document.body.appendChild(s);
  }
})();

/* Inside the Android app, hide the "Download the app" buttons */
if (window.JAABMApp) document.querySelectorAll(".app-dl, .app-dl-side, .app-download").forEach(function (el) { el.remove(); });
