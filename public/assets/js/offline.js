/* Portal offline support: registers the service worker, shows the connection / sync status,
   sends saved changes when the internet returns, and keeps the menu pages ready for offline use. */
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;

  var bar = document.createElement("div");
  bar.className = "net-status";
  bar.setAttribute("role", "status");
  bar.hidden = true;
  document.body.appendChild(bar);
  var hideTimer;
  function show(text, kind, sticky) {
    bar.textContent = text;
    bar.className = "net-status net-status--" + kind;
    bar.hidden = false;
    clearTimeout(hideTimer);
    if (!sticky) hideTimer = setTimeout(function () { bar.hidden = true; }, 6000);
  }

  var pending = 0;
  function render() {
    if (!navigator.onLine) show("Offline. You can keep working: changes are saved on this device" + (pending ? " (" + pending + " waiting)." : "."), "off", true);
    else if (pending) show("Sending " + pending + " saved change" + (pending === 1 ? "" : "s") + "…", "sync", true);
    else bar.hidden = true;
  }
  function whenControlled(fn) {
    if (navigator.serviceWorker.controller) fn();
    else navigator.serviceWorker.addEventListener("controllerchange", fn, { once: true });
  }
  function ask(type, extra) { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage(Object.assign({ type: type }, extra || {})); }

  navigator.serviceWorker.register("/sw.js").then(function () {
    return navigator.serviceWorker.ready;
  }).then(function () {
    ask("count");
    if (navigator.onLine) ask("sync");
    // The very first page was loaded before the worker took over, so keep it (and the menu pages) once it is in charge
    whenControlled(function () {
      if (navigator.onLine) fetch(location.pathname + location.search, { credentials: "same-origin" }).catch(function () {});
      warmUp();
    });
  }).catch(function () {});

  navigator.serviceWorker.addEventListener("message", function (e) {
    var m = e.data || {};
    if (m.type === "count" || m.type === "queued") { pending = m.left; render(); }
    if (m.type === "warmed" && m.saved) { try { localStorage.setItem("jaabm-saved-pages", String(m.saved)); } catch (err) { /* ignore */ } }
    if (m.type === "synced") {
      pending = m.left;
      if (m.login) show("Sign in again to send the " + m.left + " saved change" + (m.left === 1 ? "" : "s") + ".", "warn", true);
      else if (m.sent || m.failed) {
        show((m.sent ? m.sent + " saved change" + (m.sent === 1 ? " was" : "s were") + " sent." : "") +
          (m.failed ? " " + m.failed + " could not be accepted (the form expired or was not allowed); please enter it again." : ""), m.failed ? "warn" : "ok");
        if (m.sent && !m.left) setTimeout(function () { location.reload(); }, 1500);
      } else render();
    }
  });
  window.addEventListener("online", function () { render(); ask("sync"); try { localStorage.removeItem("jaabm-warm"); } catch (err) { /* ignore */ } warmUp(); });
  window.addEventListener("offline", render);

  /* Save the whole portal for offline use (online, at most every 30 minutes): the service worker opens the
     menu pages and the pages they link to in the background */
  function warmUp() {
    if (!navigator.onLine) return;
    try {
      var last = Number(localStorage.getItem("jaabm-warm") || 0);
      if (Date.now() - last < 30 * 60 * 1000) return;
      localStorage.setItem("jaabm-warm", String(Date.now()));
    } catch (err) { /* storage blocked: save anyway */ }
    var links = Array.prototype.slice.call(document.querySelectorAll(".side-nav a[href^='/app'], .content a[href^='/app']"))
      .map(function (a) { return a.getAttribute("href"); })
      .filter(function (h, i, all) { return all.indexOf(h) === i; });
    links.unshift(location.pathname + location.search);
    ask("warm", { start: links });
  }

  /* Signing out removes saved pages from this device; warn if changes are still waiting */
  document.querySelectorAll('form[action="/logout"]').forEach(function (f) {
    f.addEventListener("submit", function (e) {
      if (pending && !confirm(pending + " change" + (pending === 1 ? " is" : "s are") + " still waiting to be sent. If you sign out now they will be sent only after you sign in again on this device. Sign out anyway?")) { e.preventDefault(); return; }
      ask("logout");
      try { localStorage.removeItem("jaabm-warm"); } catch (err) { /* ignore */ }
    });
  });
})();
