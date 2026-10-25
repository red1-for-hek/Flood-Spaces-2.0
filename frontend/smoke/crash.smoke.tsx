import { JSDOM } from "jsdom";

// Reproduces the real-world report:
//   "A background request failed — TypeError: Cannot read properties of undefined (reading 'M_ID')"
// which came from a third-party script, not our bundle. It must never blank the page.

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

const grid = {
  country_focus: "Bangladesh",
  source: ["Open-Meteo"],
  items: [
    {
      name: "Kurigram",
      lat: 25.8072,
      lon: 89.6295,
      rainfall_1h_mm: 5,
      rainfall_6h_mm: 20,
      rainfall_24h_mm: 84,
      satellite_precip_mm: 33,
      river_discharge_m3s: 940,
      temperature_c: 26.9,
      wind_kmh: 33,
      risk_score: 82.5,
      risk_level: "high",
      confidence_pct: 81,
      satellite_water_anomaly: 0.58,
      forecast_steps: [],
      has_live_data: true,
      is_no_data: false,
      is_true_flood_signal: false
    }
  ]
};

const fixtures: Record<string, unknown> = {
  "/api/risk-grid": grid,
  "/api/upstream-status": {
    sample_area: "Dhaka",
    timestamp: new Date().toISOString(),
    open_meteo: { live: true, forecast_source: "open-meteo" },
    openweather_forecast_fallback: { live: false },
    nasa_power: { live: true, value_mm: 10 },
    open_meteo_flood: { live: true, value_m3s: 800 },
    ai: { configured: true, live: true, provider: "groq", model: "openai/gpt-oss-20b" },
    telegram: { configured: true, webhook_mode: false, subscribers: 3 },
    forecast_pipeline_live: true,
    core_data_live: true
  },
  "/api/global-flood-events": { source: [], status: "live", updated_at: new Date().toISOString(), items: [] },
  "/api/bd-river-watch": { source: [], updated_at: new Date().toISOString(), items: [] },
  "/api/telegram/bot-info": {
    configured: true,
    username: "FloodSpacesBot",
    webhook_mode: false,
    subscribers: 3,
    profiles: 3,
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
  const body = fixtures[path];
  return body === undefined
    ? ({ ok: false, status: 404, json: async () => ({}) } as Response)
    : ({ ok: true, status: 200, json: async () => body } as Response);
};

async function main() {
  await import("../src/main");
  await new Promise((resolve) => setTimeout(resolve, 3200));

  const before = win.document.body.innerHTML;
  if (!before.includes("Flood command center")) {
    console.log("FAIL  dashboard did not render before the error");
    process.exit(1);
  }

  // Fire the exact third-party rejection the user saw.
  const rejection = new win.Event("unhandledrejection") as Event & { reason?: unknown };
  Object.defineProperty(rejection, "reason", {
    value: new TypeError("Cannot read properties of undefined (reading 'M_ID')")
  });
  win.dispatchEvent(rejection);

  // Fire another one to check de-duplication.
  win.dispatchEvent(rejection);

  await new Promise((resolve) => setTimeout(resolve, 400));

  const html = win.document.body.innerHTML;
  const toasts = win.document.querySelectorAll("#flood-spaces-toast [data-message]");

  const checks: Array<[string, boolean]> = [
    ["dashboard still rendered", html.includes("Flood command center")],
    ["toast shown", toasts.length === 1],
    ["toast names the error", (toasts[0]?.getAttribute("data-message") || "").includes("M_ID")],
    ["duplicate toast suppressed", toasts.length < 2],
    ["no blocking overlay", !html.includes("Runtime error") && !html.includes("Reload dashboard")],
    [
      "error recorded for debugging",
      ((((win as never) as unknown as { __floodSpacesErrors?: unknown[] }).__floodSpacesErrors || []).length ?? 0) >= 1
    ],
    ["page not blanked", win.document.body.textContent!.length > 500]
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }

  console.log(`\n${failed === 0 ? "CRASH SMOKE OK" : "CRASH SMOKE FAILED"}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("CRASH SMOKE CRASH", err);
  process.exit(1);
});
