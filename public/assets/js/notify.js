/* Notifications in the portal: keeps the bell count current and, when the person allows it, shows new ones
   as browser notifications while the portal (or the installed app) is open. */
(function () {
  "use strict";
  var badge = document.querySelector("[data-bell-count]");
  var KEY = "jaabm-last-note";
  var canNotify = "Notification" in window;

  function lastSeen() { try { return Number(localStorage.getItem(KEY) || 0); } catch (e) { return 0; } }
  function setSeen(id) { try { localStorage.setItem(KEY, String(id)); } catch (e) { /* storage blocked */ } }

  function show(n) {
    var opts = { body: n.body || "", icon: "/assets/images/logo-sm.jpg", tag: "jaabm-" + n.id, data: { url: "/app/notifications/" + n.id + "/open" } };
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(function (reg) { reg.showNotification(n.title, opts); });
    } else {
      var note = new Notification(n.title, opts);
      note.onclick = function () { window.focus(); location.href = opts.data.url; };
    }
  }

  function check() {
    if (!navigator.onLine || document.hidden) return;
    fetch("/app/notifications.json", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (badge) { badge.textContent = d.unread > 99 ? "99+" : String(d.unread); badge.hidden = !d.unread; }
        var seen = lastSeen(), newest = d.latest.length ? d.latest[0].id : seen;
        if (canNotify && Notification.permission === "granted" && seen) {
          d.latest.filter(function (n) { return n.id > seen; }).reverse().forEach(show);
        }
        if (newest > seen) setSeen(newest);
      })
      .catch(function () {});
  }
  check();
  setInterval(check, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });

  // "Turn on browser notifications" (on the Notifications page)
  var btn = document.querySelector("[data-enable-browser-notes]");
  if (btn && canNotify && Notification.permission === "default") {
    btn.hidden = false;
    btn.addEventListener("click", function () {
      Notification.requestPermission().then(function (p) {
        btn.hidden = true;
        if (p === "granted") show({ id: 0, title: "Notifications are on", body: "New messages, fee notices and results will appear here while the portal is open." });
      });
    });
  }
})();
