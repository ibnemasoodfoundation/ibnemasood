/* Print and PDF download for profiles, ID cards, attendance sheets and reports.
   The PDF is rendered from the page itself, so Urdu text keeps its Nastaliq shaping. */
(function () {
  "use strict";
  var printBtn = document.querySelector("[data-print]");
  if (printBtn) printBtn.addEventListener("click", function () { window.print(); });

  var pdfBtn = document.querySelector("[data-pdf]");
  if (!pdfBtn) return;
  pdfBtn.addEventListener("click", function () {
    if (!window.html2pdf) { alert("The PDF tool did not load. Use Print and choose \"Save as PDF\" instead."); return; }
    var area = document.getElementById("print-area");
    var landscape = area.classList.contains("print-page--landscape") || area.classList.contains("print-page--wide");
    var cards = area.classList.contains("print-page--cards");
    var label = pdfBtn.textContent;
    pdfBtn.disabled = true; pdfBtn.textContent = "Preparing…";
    document.body.classList.add("is-exporting");
    // Wait for web fonts so Urdu renders in Nastaliq, not a fallback font
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () {
      return window.html2pdf().set({
        margin: cards ? 6 : 8,
        filename: (pdfBtn.getAttribute("data-pdf") || "document") + ".pdf",
        image: { type: "jpeg", quality: 0.96 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "mm", format: "a4", orientation: landscape ? "landscape" : "portrait" },
        pagebreak: { mode: ["css", "legacy"], avoid: ["tr", ".pp-section", ".id-card"] },
      }).from(area).save();
    }).catch(function () {
      alert("The PDF could not be created. Use Print and choose \"Save as PDF\" instead.");
    }).then(function () {
      document.body.classList.remove("is-exporting");
      pdfBtn.disabled = false; pdfBtn.textContent = label;
    });
  });
})();
