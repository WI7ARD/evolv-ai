import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleHudRoutes } from "../server/hud-routes.mjs";

function harness({ weather, tasks = [], throws = false } = {}) {
  const sent = [];
  const toolRegistry = {
    calls: [],
    async execute(name, args) {
      this.calls.push({ name, args });
      if (throws) throw new Error("network down");
      return { ok: Boolean(weather), output: JSON.stringify(weather || { error: "No matching weather location was found." }) };
    }
  };
  const projectService = { listTasks: () => tasks };
  const call = (query = "") => handleHudRoutes({
    req: { method: "GET" },
    res: {},
    url: new URL(`http://x/api/hud${query}`),
    json: (_res, status, payload) => sent.push({ status, payload }),
    toolRegistry,
    projectService
  });
  return { call, sent, toolRegistry };
}

const WEATHER = {
  attribution: "Weather data by Open-Meteo (CC BY 4.0)",
  location: { name: "Austin", admin1: "Texas" },
  units: { temperature: "°F", windSpeed: "mph" },
  current: { conditions: "clear sky", temperature: 88, feelsLike: 91, windSpeed: 7, isDay: true },
  forecast: [
    { date: "2026-08-07", conditions: "clear sky", high: 99, low: 74 },
    { date: "2026-08-08", conditions: "partly cloudy", high: 97, low: 75 }
  ]
};

test("the display reads weather through the existing tool rather than its own client", async () => {
  const { call, sent, toolRegistry } = harness({ weather: WEATHER });
  assert.equal(await call("?location=Austin&units=fahrenheit"), true);

  // Going through the tool is what keeps the outbound host allowlist and the
  // tool-run record in play; a private fetch here would have neither.
  assert.equal(toolRegistry.calls[0].name, "get_weather");
  assert.deepEqual(toolRegistry.calls[0].args, { location: "Austin", units: "fahrenheit", forecast_days: 3 });

  const { status, payload } = sent[0];
  assert.equal(status, 200);
  assert.equal(payload.weather.place, "Austin, Texas");
  assert.equal(payload.weather.temperature, 88);
  assert.equal(payload.weather.forecast.length, 2);
  assert.match(payload.weather.attribution, /Open-Meteo/);
});

test("a repeated request is served from cache instead of hitting the network again", async () => {
  // Its own place name: the cache is module-level on purpose — the key fully
  // determines the value, so a public forecast is shared rather than fetched
  // once per profile — which also means a shared name would leak between tests.
  const { call, toolRegistry } = harness({ weather: WEATHER });
  await call("?location=Reykjavik");
  await call("?location=reykjavik");
  // A display refreshing on a timer must not turn into a request per tick.
  assert.equal(toolRegistry.calls.length, 1, "the same place and units should not be fetched twice");
});

test("weather failing never blanks the rest of the display", async () => {
  const tasks = [{ id: "t1", title: "Calibrate sensors", status: "open" }];
  const { call, sent } = harness({ throws: true, tasks });
  await call("?location=Nowhere&projectId=p1");

  const { status, payload } = sent[0];
  assert.equal(status, 200, "a dead network is not a failed request");
  assert.equal(payload.weather, null);
  assert.match(payload.weatherError, /network down/);
  assert.equal(payload.tasks.length, 1, "local tasks must survive a network failure");
});

test("no location means no outbound request at all", async () => {
  const { call, sent, toolRegistry } = harness({ weather: WEATHER });
  await call("");
  assert.equal(toolRegistry.calls.length, 0, "an unset location must not reach the network");
  assert.equal(sent[0].payload.weather, null);
});

test("finished work is not shown as outstanding", async () => {
  const tasks = [
    { id: "1", title: "Upload firmware", status: "open" },
    { id: "2", title: "Old thing", status: "done" },
    { id: "3", title: "Archived thing", status: "archived" },
    { id: "4", title: "Review logs", status: "in-progress" }
  ];
  const { call, sent } = harness({ tasks });
  await call("?projectId=p1");
  assert.deepEqual(sent[0].payload.tasks.map((task) => task.title), ["Upload firmware", "Review logs"]);
});

test("the lab display shows the camera without ever sending it anywhere", async () => {
  const [html, lab, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/lab.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);

  assert.match(app, /name: "\/lab"/);
  assert.match(html, /id="lab-view"/);
  for (const panel of ["lab-panel-time", "lab-panel-weather", "lab-panel-tasks", "lab-panel-system"]) {
    assert.match(html, new RegExp(`id="${panel}"`), `${panel} is missing`);
  }
  assert.match(html, /id="lab-clock"/);
  assert.match(html, /id="lab-calendar"/);
  assert.match(html, /id="lab-hand"/);

  // The camera is read in the page. Nothing may post a frame, a canvas dump, or
  // a landmark set anywhere — that is the whole basis of the privacy claim the
  // panel makes on screen.
  assert.doesNotMatch(lab, /toDataURL|toBlob|FormData|captureStream/);
  const posts = lab.match(/method:\s*"POST"/g) || [];
  assert.equal(posts.length, 0, "the display only reads; it must never post");

  // One recognizer, injected, rather than a second MediaPipe instance — two
  // would mean two camera streams, and most webcams refuse the second.
  assert.doesNotMatch(lab, /vision_bundle|GestureRecognizer\.createFromOptions/);
  assert.match(lab, /ensureRecognizer/);
  assert.match(app, /await ensureGestureRecognizer\(\)/);

  // Leaving must release the camera and stop the clocks.
  assert.match(lab, /export function suspendLab/);
  assert.match(lab, /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(app, /suspendLab\(\)/);
});

test("every gesture the display advertises is one it actually handles", async () => {
  const [html, lab] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/lab.js", import.meta.url), "utf8")
  ]);
  const advertised = html.match(/Point up to move the focus ring[^<]*/)?.[0] || "";
  assert.ok(advertised, "the gesture hint must be on the page");

  for (const gesture of ["Pointing_Up", "Thumb_Up", "Closed_Fist", "Victory"]) {
    assert.match(lab, new RegExp(gesture), `${gesture} is advertised but not handled`);
  }
  // Open palm is the resting pose, so it must stay inert or the display would
  // fire an action every time someone simply holds a hand up.
  assert.match(lab, /name !== "Open_Palm"/);
});
