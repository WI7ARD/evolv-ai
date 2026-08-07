// The lab display's data feed.
//
// Weather goes through the existing get_weather tool rather than a second
// Open-Meteo client. That is not laziness about code reuse: the tool carries
// the outbound host allowlist and writes a tool-run record, so a panel quietly
// refreshing in the background stays as visible and as bounded as a request the
// user typed. A private copy here would be neither.
//
// The page cannot fetch Open-Meteo itself — the CSP is connect-src 'self' — so
// this route is also the only way the display can know the weather at all.

const WEATHER_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function fail(message, status = 400, code = "HUD_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

export async function handleHudRoutes(context) {
  const { req, res, url, json, toolRegistry, projectService } = context;
  if (req.method !== "GET" || url.pathname !== "/api/hud") return false;

  const place = String(url.searchParams.get("location") || "").trim();
  const units = url.searchParams.get("units") === "celsius" ? "celsius" : "fahrenheit";
  const projectId = String(url.searchParams.get("projectId") || "").trim();
  if (place.length > 120) throw fail("Location is too long.");

  // Tasks are local and cheap; weather is neither. They are fetched
  // independently so a failing network never blanks the whole display.
  let tasks = [];
  try {
    tasks = projectService && projectId
      ? projectService.listTasks(projectId, "").filter((task) => task.status !== "done" && task.status !== "archived").slice(0, 12)
      : [];
  } catch { tasks = []; }

  let weather = null;
  let weatherError = "";
  if (place) {
    const key = `${place.toLowerCase()}:${units}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < WEATHER_TTL_MS) {
      weather = cached.weather;
    } else {
      try {
        const run = await toolRegistry.execute("get_weather", { location: place, units, forecast_days: 3 }, {});
        if (!run.ok) throw new Error(JSON.parse(run.output)?.error || "Weather is unavailable.");
        const payload = JSON.parse(run.output);
        weather = {
          place: [payload.location?.name, payload.location?.admin1].filter(Boolean).join(", "),
          conditions: payload.current?.conditions || "",
          temperature: payload.current?.temperature,
          feelsLike: payload.current?.feelsLike,
          windSpeed: payload.current?.windSpeed,
          isDay: payload.current?.isDay,
          unit: payload.units?.temperature || "°",
          windUnit: payload.units?.windSpeed || "",
          forecast: (payload.forecast || []).slice(0, 3).map((day) => ({
            date: day.date, conditions: day.conditions, high: day.high, low: day.low
          })),
          attribution: payload.attribution || ""
        };
        cache.set(key, { at: Date.now(), weather });
      } catch (error) {
        // A stale reading beats an empty panel, and saying it is stale beats
        // pretending it is current.
        weatherError = error.message || "Weather is unavailable.";
        if (cached) weather = { ...cached.weather, stale: true };
      }
    }
  }

  json(res, 200, { tasks, weather, weatherError, generatedAt: new Date().toISOString() });
  return true;
}
