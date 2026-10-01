const API_BASE = "http://localhost:8000";

const form = document.getElementById("query-form");
const status = document.getElementById("status");
const metricsDiv = document.getElementById("metrics");
const telemetryLabel = document.getElementById("telemetry-lap-label");

// one Chart.js instance per canvas, kept so we can destroy/redraw on each submit
let lapChart = null;
let degradationChart = null;
let speedChart = null;
let throttleBrakeChart = null;
let gearChart = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault(); // stop the browser from reloading the page on submit

  const year = document.getElementById("year").value;
  const track = document.getElementById("track").value;
  const driver = document.getElementById("driver").value;
  const sessionType = document.getElementById("sessionType").value;
  const lapNumber = document.getElementById("lapNumber").value;

  status.textContent = "Loading… first request can be slow while FastF1 caches data.";
  metricsDiv.innerHTML = "";

  try {
    const lapsUrl = `${API_BASE}/laps?year=${year}&track=${track}&driver=${driver}&session_type=${sessionType}`;
    const telemetryUrl = `${API_BASE}/telemetry?year=${year}&track=${track}&driver=${driver}&session_type=${sessionType}&lap_number=${lapNumber}`;

    // fire both requests together instead of waiting on one before starting the other
    const [lapsResponse, telemetryResponse] = await Promise.all([
      fetch(lapsUrl),
      fetch(telemetryUrl),
    ]);

    if (!lapsResponse.ok) {
      throw new Error(`Laps request failed (${lapsResponse.status}): ${await lapsResponse.text()}`);
    }
    if (!telemetryResponse.ok) {
      throw new Error(`Telemetry request failed (${telemetryResponse.status}): ${await telemetryResponse.text()}`);
    }

    const lapsData = await lapsResponse.json();
    const telemetryData = await telemetryResponse.json();

    status.textContent = `Loaded ${lapsData.laps.length} laps for ${lapsData.driver}.`;

    showMetrics(lapsData.laps);
    drawLapChart(lapsData.laps);
    drawDegradationChart(lapsData.laps);

    telemetryLabel.textContent = telemetryData.lap_number;
    if (telemetryData.points.length === 0) {
      status.textContent += ` No telemetry found for lap ${lapNumber}.`;
    } else {
      drawTelemetryCharts(telemetryData.points);
    }
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
});

function formatLapTime(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds % 60).toFixed(3);
  return `${minutes}:${rest.padStart(6, "0")}`;
}

function showMetrics(laps) {
  // find the fastest lap (ignoring laps with no time)
  const validLaps = laps.filter((lap) => lap.lap_time !== null);
  const bestLap = validLaps.reduce(
    (best, lap) => (!best || lap.lap_time < best.lap_time ? lap : best),
    null
  );
  const lastLap = laps[laps.length - 1];

  const cards = [
    { label: "Best lap", value: bestLap ? `${formatLapTime(bestLap.lap_time)} (Lap ${bestLap.lap_number})` : "—" },
    { label: "Last lap", value: formatLapTime(lastLap?.lap_time) },
    { label: "Tyre compound", value: lastLap?.compound ?? "—" },
    { label: "Tyre life", value: lastLap?.tyre_life ? `${lastLap.tyre_life} laps` : "—" },
  ];

  metricsDiv.innerHTML = cards
    .map(
      (card) => `
      <div class="metric-card">
        <p class="label">${card.label}</p>
        <p class="value">${card.value}</p>
      </div>
    `
    )
    .join("");
}

function drawLapChart(laps) {
  const ctx = document.getElementById("lap-chart");

  const labels = laps.map((lap) => lap.lap_number);
  const times = laps.map((lap) => lap.lap_time);

  if (lapChart) {
    lapChart.destroy(); // remove the old chart before drawing a new one
  }

  lapChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Lap time",
          data: times,
          borderColor: "#d1352b",
          spanGaps: true, // skip over laps with no time instead of breaking the line
        },
      ],
    },
    options: {
      plugins: {
        tooltip: {
          callbacks: {
            // show "1:29.953" in the tooltip instead of the raw seconds value
            label: (context) => formatLapTime(context.parsed.y),
          },
        },
      },
      scales: {
        y: {
          ticks: {
            // same formatting on the axis labels themselves
            callback: (value) => formatLapTime(value),
          },
        },
      },
    },
  });
}

// Groups consecutive laps into "stints" — a stint is a run of laps on one
// set of tyres. A new stint starts whenever the compound changes, or
// tyre_life drops below the previous lap (a pit stop).
function groupIntoStints(laps) {
  const stints = [];
  let currentStint = null;

  for (const lap of laps) {
    // skip laps with no time or no tyre data — usually in/out laps or gaps
    if (lap.lap_time === null || lap.tyre_life === null || lap.compound === null) {
      continue;
    }

    const isNewStint =
      !currentStint ||
      lap.compound !== currentStint.compound ||
      lap.tyre_life < currentStint.lastTyreLife; // strictly less than, not <=

    if (isNewStint) {
      currentStint = { compound: lap.compound, laps: [], lastTyreLife: -1 };
      stints.push(currentStint);
    }

    currentStint.laps.push(lap);
    currentStint.lastTyreLife = lap.tyre_life;
  }

  console.log("groupIntoStints: found", stints.length, "stint(s)", stints);
  return stints;
}

// One line color per compound, so e.g. every "SOFT" stint is the same color
// even if the driver goes onto softs twice in one race.
const COMPOUND_COLORS = {
  SOFT: "#d1352b",
  MEDIUM: "#c9a94f",
  HARD: "#e8eaed",
  INTERMEDIATE: "#3fb56d",
  WET: "#4f9df7",
};

function drawDegradationChart(laps) {
  const stints = groupIntoStints(laps);

  if (stints.length === 0) {
    console.warn("drawDegradationChart: no stints to plot — check tyre_life/compound values on the laps data");
    if (degradationChart) degradationChart.destroy();
    degradationChart = null;
    return;
  }

  const datasets = stints.map((stint, i) => ({
    label: `${stint.compound} (stint ${i + 1})`,
    data: stint.laps.map((lap) => ({ x: lap.tyre_life, y: lap.lap_time })),
    borderColor: COMPOUND_COLORS[stint.compound] ?? "#8b929c",
    pointRadius: 3,
    borderWidth: 1.5,
    showLine: true,
  }));

  console.log("drawDegradationChart: datasets", datasets);

  if (degradationChart) degradationChart.destroy();

  degradationChart = new Chart(document.getElementById("degradation-chart"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#8b929c" } },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatLapTime(context.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Tyre life (laps)", color: "#8b929c" },
          ticks: { color: "#8b929c" },
          grid: { color: "#23272d" },
        },
        y: {
          title: { display: true, text: "Lap time", color: "#8b929c" },
          ticks: { color: "#8b929c", callback: (value) => formatLapTime(value) },
          grid: { color: "#23272d" },
        },
      },
    },
  });
}
// This is what makes it meaningful to later overlay a second lap on the same
// axis and compare them point-for-point, even if the two laps took different
// amounts of time.
function telemetryChartOptions(yLabel) {
  return {
    responsive: true,
    animation: false,
    plugins: { legend: { display: true, labels: { color: "#8b929c" } } },
    scales: {
      x: {
        type: "linear",
        title: { display: true, text: "Distance (m)", color: "#8b929c" },
        ticks: { color: "#8b929c" },
        grid: { color: "#23272d" },
      },
      y: {
        title: { display: true, text: yLabel, color: "#8b929c" },
        ticks: { color: "#8b929c" },
        grid: { color: "#23272d" },
      },
    },
  };
}

function drawTelemetryCharts(points) {
  // Build {x, y} pairs (rather than separate labels/data arrays) so Chart.js
  // treats distance as a real numeric axis instead of evenly-spaced category
  // ticks — points aren't evenly spaced in distance, so this matters.
  const speedSeries = points.map((p) => ({ x: p.distance, y: p.speed }));
  const throttleSeries = points.map((p) => ({ x: p.distance, y: p.throttle }));
  const brakeSeries = points.map((p) => ({ x: p.distance, y: p.brake ? 100 : 0 }));
  const gearSeries = points.map((p) => ({ x: p.distance, y: p.gear }));

  if (speedChart) speedChart.destroy();
  if (throttleBrakeChart) throttleBrakeChart.destroy();
  if (gearChart) gearChart.destroy();

  speedChart = new Chart(document.getElementById("speed-chart"), {
    type: "line",
    data: {
      datasets: [
        { label: "Speed (km/h)", data: speedSeries, borderColor: "#4f9df7", pointRadius: 0, borderWidth: 1.5 },
      ],
    },
    options: telemetryChartOptions("km/h"),
  });

  throttleBrakeChart = new Chart(document.getElementById("throttle-brake-chart"), {
    type: "line",
    data: {
      datasets: [
        { label: "Throttle (%)", data: throttleSeries, borderColor: "#3fb56d", pointRadius: 0, borderWidth: 1.5 },
        { label: "Brake", data: brakeSeries, borderColor: "#d1352b", pointRadius: 0, borderWidth: 1.5, stepped: true },
      ],
    },
    options: telemetryChartOptions("%"),
  });

  gearChart = new Chart(document.getElementById("gear-chart"), {
    type: "line",
    data: {
      datasets: [
        { label: "Gear", data: gearSeries, borderColor: "#c9a94f", pointRadius: 0, borderWidth: 1.5, stepped: true },
      ],
    },
    options: telemetryChartOptions("Gear"),
  });
}

