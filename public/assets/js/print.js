/* Print and PDF download for profiles, ID cards, certificates, attendance sheets and reports.
   The PDF is rendered from the page itself, so Urdu text keeps its Nastaliq shaping. */
(function () {
  "use strict";
  // Inside the Android app (window.JAABMApp) printing and saving go through the phone; in a browser, as usual
  var app = window.JAABMApp;
  var printBtn = document.querySelector("[data-print]");
  if (printBtn) printBtn.addEventListener("click", function () { if (app) app.print(document.title); else window.print(); });

  /* PDF settings for the page being exported. Certificates are one page each: the Alimiyyah on landscape A4,
     the school documents on portrait A4, always scaled to fit (never cut off at the edge). */
  window.jaabmPdfOptions = function (area, filename) {
    var has = function (c) { return area.classList.contains(c); };
    var single = has("print-page--alim") || has("print-page--slc") || has("print-page--adm") || has("print-page--cert");
    var landscape = has("print-page--landscape") || has("print-page--wide") || has("print-page--alim");
    var cards = has("print-page--cards");
    return {
      margin: single ? 5 : cards ? 6 : 8,
      filename: (filename || "document") + ".pdf",
      image: { type: "jpeg", quality: 0.96 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff", scrollX: 0, scrollY: 0 },
      jsPDF: { unit: "mm", format: "a4", orientation: landscape ? "landscape" : "portrait" },
      pagebreak: single ? { mode: [] } : { mode: ["css", "legacy"], avoid: ["tr", ".pp-section", ".id-card"] },
    };
  };

  /* A certificate must fit one page: shrink the picture to the page if it is taller than the page */
  function fitOnePage(worker, opts) {
    var canvas;
    return worker.toPdf().get("canvas").then(function (c) {
      canvas = c;
      return worker.get("pdf");
    }).then(function (pdf) {
      // Reuse html2pdf's own document (jsPDF is not exposed globally): one fresh page, the drafts removed
      pdf.addPage("a4", opts.jsPDF.orientation);
      for (var n = pdf.internal.getNumberOfPages() - 1; n >= 1; n--) pdf.deletePage(n);
      pdf.setPage(1);
      var pw = pdf.internal.pageSize.getWidth() - opts.margin * 2, ph = pdf.internal.pageSize.getHeight() - opts.margin * 2;
      var ratio = Math.min(pw / canvas.width, ph / canvas.height);
      var w = canvas.width * ratio, h = canvas.height * ratio;
      pdf.addImage(canvas.toDataURL("image/jpeg", opts.image.quality), "JPEG", (pw - w) / 2 + opts.margin, (ph - h) / 2 + opts.margin, w, h);
      return pdf;
    });
  }
  /* The PDF tool draws inline SVG badly (curved text, mirrored ornaments). Before exporting, let the browser draw
     each SVG as a sharp picture in its place; the originals are put back afterwards. */
  function rasterizeSvgs(area) {
    var swaps = [];
    var jobs = Array.prototype.slice.call(area.querySelectorAll("svg")).map(function (svg) {
      var r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      var clone = svg.cloneNode(true);
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", r.width);
      clone.setAttribute("height", r.height);
      clone.setAttribute("color", getComputedStyle(svg).color);
      var src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
      return new Promise(function (resolve) {
        var im = new Image();
        im.onload = function () {
          var k = 3, c = document.createElement("canvas");
          c.width = Math.round(r.width * k); c.height = Math.round(r.height * k);
          c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
          var img = document.createElement("img");
          img.src = c.toDataURL("image/png");
          img.className = svg.getAttribute("class") || "";
          img.style.width = r.width + "px"; img.style.height = r.height + "px";
          svg.parentNode.replaceChild(img, svg);
          swaps.push([img, svg]);
          resolve();
        };
        im.onerror = function () { resolve(); };
        im.src = src;
      });
    });
    return Promise.all(jobs).then(function () {
      return function restore() { swaps.forEach(function (s) { s[0].parentNode.replaceChild(s[1], s[0]); }); };
    });
  }

  window.jaabmBuildPdf = function (area, filename) {
    var opts = window.jaabmPdfOptions(area, filename);
    var single = opts.pagebreak.mode.length === 0;
    return rasterizeSvgs(area).then(function (restore) {
      var worker = window.html2pdf().set(opts).from(area);
      var made = single ? fitOnePage(worker, opts) : worker.toPdf().get("pdf");
      return made.then(function (pdf) { restore(); return pdf; }, function (err) { restore(); throw err; });
    });
  };

  var pdfBtn = document.querySelector("[data-pdf]");
  if (!pdfBtn) return;
  pdfBtn.addEventListener("click", function () {
    if (!window.html2pdf) { alert("The PDF tool did not load. Use Print and choose \"Save as PDF\" instead."); return; }
    var area = document.getElementById("print-area");
    var label = pdfBtn.textContent, name = pdfBtn.getAttribute("data-pdf") || "document";
    pdfBtn.disabled = true; pdfBtn.textContent = "Preparing…";
    document.body.classList.add("is-exporting");
    // Wait for web fonts so Urdu renders in Nastaliq, not a fallback font
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () {
      return window.jaabmBuildPdf(area, name);
    }).then(function (pdf) {
      if (app) app.saveFile(pdf.output("datauristring").split(",")[1], "application/pdf", name + ".pdf");
      else pdf.save(name + ".pdf");
    }).catch(function () {
      alert("The PDF could not be created. Use Print and choose \"Save as PDF\" instead.");
    }).then(function () {
      document.body.classList.remove("is-exporting");
      pdfBtn.disabled = false; pdfBtn.textContent = label;
    });
  });
})();
