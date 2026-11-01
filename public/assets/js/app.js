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

  /* Upload as soon as a file is picked */
  document.querySelectorAll("input[type=file][data-autosubmit]").forEach(function (input) {
    input.addEventListener("change", function () {
      if (!input.files.length) return;
      var label = input.closest(".upload-pick");
      if (label) { label.classList.add("is-busy"); label.querySelector("span").textContent = "Uploading…"; }
      input.form.submit();
    });
  });

  /* Profile photo: preview immediately, upload with a progress bar, then reload */
  document.querySelectorAll("[data-photo-upload]").forEach(function (form) {
    var input = form.querySelector("input[type=file]");
    var box = form.closest("[data-photo-box]");
    var img = box.querySelector("[data-photo-img]");
    var msg = form.querySelector("[data-photo-msg]");
    var bar = form.querySelector("[data-progress]");
    var fill = form.querySelector("[data-progress-bar]");
    var MAX = 5 * 1024 * 1024, TYPES = ["image/jpeg", "image/png", "image/webp"];
    var say = function (text, bad) { msg.textContent = text; msg.classList.toggle("photo-msg--err", !!bad); };

    input.addEventListener("change", function () {
      var file = input.files[0];
      if (!file) return;
      if (TYPES.indexOf(file.type) === -1) { say("Please choose a JPG, PNG or WebP image.", true); input.value = ""; return; }
      if (file.size > MAX) { say("That photo is larger than 5 MB. Please choose a smaller one.", true); input.value = ""; return; }
      // Preview before the upload finishes
      var reader = new FileReader();
      reader.onload = function () {
        img.src = reader.result; img.hidden = false;
        var initials = box.querySelector(".photo-initials"); if (initials) initials.hidden = true;
        box.querySelector(".photo-frame").classList.remove("photo-frame--empty");
      };
      reader.readAsDataURL(file);

      var data = new FormData(form);
      var xhr = new XMLHttpRequest();
      xhr.open("POST", form.action);
      xhr.setRequestHeader("X-Requested-With", "fetch");
      bar.hidden = false; fill.style.width = "0%"; say("Uploading…");
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) fill.style.width = Math.round((e.loaded / e.total) * 100) + "%"; };
      xhr.onload = function () {
        var res = {}; try { res = JSON.parse(xhr.responseText); } catch (err) { /* not JSON */ }
        if (xhr.status === 200 && res.ok) { fill.style.width = "100%"; say("Photo saved."); setTimeout(function () { location.reload(); }, 400); }
        else { bar.hidden = true; say(res.error || "The upload failed. Please try again.", true); input.value = ""; }
      };
      xhr.onerror = function () { bar.hidden = true; say("Network error. Check your connection and try again.", true); };
      xhr.send(data);
    });
  });

  /* Attendance registers: mark everyone with one click (only fills blanks) */
  document.querySelectorAll("[data-mark-all]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var form = btn.closest("form"), value = btn.getAttribute("data-mark-all"), names = {};
      form.querySelectorAll("input[type=radio]").forEach(function (r) { names[r.name] = names[r.name] || r.checked; });
      Object.keys(names).forEach(function (name) {
        if (names[name]) return;
        var r = form.querySelector('input[name="' + name + '"][value="' + value + '"]');
        if (r) r.checked = true;
      });
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
