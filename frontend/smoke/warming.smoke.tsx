import { JSDOM } from "jsdom";

// Reproduces a cold Render instance: the API answers with sixteen all-zero
// zones while it warms Open-Meteo/NASA. The dashboard must say “warming up”,
// show skeletons instead of fake zeros, and recover on its own.

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost:5173/",
  pretendToBeVisual: true
});

const win = dom.window as unknown as Window & typeof globalThis;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = win.document;
Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
(globalThis as Record<string, unknown>).HTMLElement = win.HTMLElement;
(globalThis as Record<string, unknown>).Node = win.Node;
(globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as Record<string, unknown>).localStorage = win.localStorage;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
win.HTMLCanvasElement.prototype.getContext = ((type: string) =>
  type === "webgl2" ? ({ getExtension: () => ({ loseContext: () => {} }) } as unknown) : null) as never;

const zeroPoint = (name: string, lat: number, lon: number) => ({
  name,
  lat,
  lon,
  rainfall_1h_mm: 0,
  rainfall_6h_mm: 0,
  rainfall_24h_mm: 0,
  satellite_precip_mm: 0,
  river_discharge_m3s: 0,
  temperature_c: null,
  wind_kmh: 0,
  risk_score: 0,
  risk_level: "low",
  confidence_pct: 0,
  satellite_water_anomaly: 0,
  forecast_steps: [],
  has_live_data: false,
  is_no_data: true,
  is_true_flood_signal: false
});

const coldGrid = {
  country_focus: "Bangladesh",
  source: ["Open-Meteo"],
  items: [
    zeroPoint("Dhaka", 23.8103, 90.4125),
    zeroPoint("Chattogram", 22.3569, 91.7832),
    zeroPoint("Sylhet", 24.8949, 91.8687)
  ]
};

let gridCalls = 0;
let served = false;

const degradedStatus = {
  sample_area: "Dhaka",
  timestamp: new Date().toISOString(),
  open_meteo: { live: false, forecast_source: "unavailable", reason: "no_live_forecast_in_grid" },
  openweather_forecast_fallback: { live: false },
  nasa_power: { live: false, value_mm: 0, reason: "no_live_satellite_data_in_grid" },
  open_meteo_flood: { live: false, value_m3s: 0, reason: "no_live_river_data_in_grid" },
  ai: { configured: true, live: true, provider: "groq", model: "openai/gpt-oss-20b" },
  telegram: { configured: true, webhook_mode: false, subscribers: 0 },
  forecast_pipeline_live: false,
  core_data_live: false,
  grid: { zones: 3, live_zones: 0, stale: false, computing: true }
};

const healthyStatus = {
  ...degradedStatus,
  open_meteo: { live: true, forecast_source: "open-meteo" },
  nasa_power: { live: true, value_mm: 12 },
  open_meteo_flood: { live: true, value_m3s: 720 },
  forecast_pipeline_live: true,
  core_data_live: true,
  grid: { zones: 3, live_zones: 3, stale: false, computing: false }
};

const liveGrid = {
  ...coldGrid,
  computed_at: new Date().toISOString(),
  stale: false,
  items: coldGrid.items.map((point, index) => ({
    ...point,
    rainfall_24h_mm: 96.4 + index,
    rainfall_6h_mm: 24,
    rainfall_1h_mm: 6,
    river_discharge_m3s: 812,
    wind_kmh: 34,
    risk_score: 78 - index * 4,
    risk_level: "high",
    confidence_pct: 82,
    has_live_data: true,
    is_no_data: false
  }))
};

const fixtures: Record<string, unknown> = {
  "/api/upstream-status": degradedStatus,
  "/api/global-flood-events": { source: [], status: "live", updated_at: new Date().toISOString(), items: [] },
  "/api/bd-river-watch": { source: [], updated_at: new Date().toISOString(), items: [] },
  "/api/telegram/bot-info": {
    configured: true,
    username: "FloodSpacesBot",
    webhook_mode: false,
    subscribers: 0,
    profiles: 0,
    ai_provider: "groq",
    ai_model: "openai/gpt-oss-20b"
  },
  "/api/boundaries": {
    country: { type: "FeatureCollection", features: [] },
    districts: { type: "FeatureCollection", features: [] },
    upazilas: { type: "FeatureCollection", features: [] }
  },
  "/api/area-grid": { items: [] }
};

(globalThis as Record<string, unknown>).fetch = async (input: RequestInfo | URL) => {
  const path = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  if (path === "/api/risk-grid") {
    gridCalls += 1;
    // First two polls are cold, then the backend warms up.
    const warm = gridCalls > 2;
    return { ok: true, status: 200, json: async () => (warm ? liveGrid : coldGrid) } as Response;
  }
  if (path === "/api/upstream-status" && gridCalls > 2) {
    return { ok: true, status: 200, json: async () => healthyStatus } as Response;
  }
  const body = fixtures[path];
  return body === undefined
    ? ({ ok: false, status: 404, json: async () => ({}) } as Response)
    : ({ ok: true, status: 200, json: async () => body } as Response);
};

const checks: Array<[string, boolean]> = [];

async function main() {
  await import("../src/main");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const html = win.document.body.innerHTML;
  checks.push(
    ["dashboard renders while cold", html.includes("Flood Spaces</h1>")],
    ["warming banner shown", html.includes("Waking the forecast pipeline")],
    ["pipeline reports warming", html.includes("Warming up")],
    ["zeros replaced by skeletons", html.includes("value-skeleton")],
    ["feeds named in the KPI", html.includes("Down:")],
    ["no fake 0/4 live", !html.includes("/4 live")],
    ["page not blanked", html.length > 4000]
  );

  // Wait for the automatic recovery poll (8 s) to bring live data in.
  await new Promise((resolve) => setTimeout(resolve, 10000));
  const recovered = win.document.body.innerHTML;
  checks.push(
    ["recovered without a manual refresh", recovered.includes("Live ·")],
    ["live zone shown after recovery", recovered.includes("Sylhet") || recovered.includes("Dhaka")],
    ["warming banner cleared", !recovered.includes("Waking the forecast pipeline")]
  );

  let failed = 0;
  for (const [label, ok] of checks) {
    failed += ok ? 0 : 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  console.log(`\n${failed === 0 ? "WARMING SMOKE OK" : "WARMING SMOKE FAILED"} (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
