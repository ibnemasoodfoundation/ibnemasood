/* Dashboard charts: single-series bars in the Jamia's lapis blue, with hover tooltips */
(function () {
  "use strict";
  var source = document.getElementById("chart-data");
  if (!source || !window.Chart) return;
  var data = JSON.parse(source.textContent);
  var css = getComputedStyle(document.documentElement);
  var ink = css.getPropertyValue("--muted").trim() || "#5B6178";
  var grid = "rgba(30,47,122,.08)";
  var bar = css.getPropertyValue("--lapis").trim() || "#1E2F7A";
  var font = { family: "Jost, 'Segoe UI', system-ui, sans-serif", size: 12 };
  var rupees = function (n) { return "Rs " + Number(n).toLocaleString("en-PK"); };

  Chart.defaults.font = font;
  Chart.defaults.color = ink;

  document.querySelectorAll("canvas[data-chart]").forEach(function (canvas) {
    var d = data[canvas.getAttribute("data-chart")];
    var horizontal = canvas.getAttribute("data-kind") === "bar-h";
    var fmt = d.money ? rupees : function (n) { return Number(n).toLocaleString("en-PK"); };
    var valueAxis = {
      beginAtZero: true,
      grid: { color: grid, drawTicks: false },
      border: { display: false },
      ticks: { precision: 0, padding: 6, callback: function (v) { return d.money ? (v >= 1000 ? "Rs " + v / 1000 + "k" : "Rs " + v) : v; } },
    };
    var labelAxis = { grid: { display: false }, border: { color: grid }, ticks: { padding: 4, autoSkip: !horizontal } };

    new Chart(canvas, {
      type: "bar",
      data: {
        labels: d.labels,
        datasets: [{
          data: d.values,
          backgroundColor: bar,
          hoverBackgroundColor: css.getPropertyValue("--gold").trim() || "#C99A2E",
          borderRadius: { topLeft: horizontal ? 0 : 4, topRight: 4, bottomRight: horizontal ? 4 : 0 },
          borderSkipped: "start",
          maxBarThickness: horizontal ? 20 : 28,
          categoryPercentage: 0.7,
        }],
      },
      options: {
        indexAxis: horizontal ? "y" : "x",
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#0F1842", padding: 10, cornerRadius: 8, displayColors: false,
            callbacks: { label: function (c) { return fmt(c.parsed[horizontal ? "x" : "y"]); } },
          },
        },
        scales: horizontal ? { x: valueAxis, y: labelAxis } : { x: labelAxis, y: valueAxis },
      },
    });
  });
})();
