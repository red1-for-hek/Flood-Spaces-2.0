import { JSDOM } from "jsdom";

// Entry smoke: boots the real src/main.tsx (StrictMode, ErrorBoundary, crash overlay,
// Router-free app shell) exactly as the browser does, with mocked API responses.

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

const fixtures: Record<string, unknown> = {
  "/api/risk-grid": {
    country_focus: "Bangladesh",
    source: ["Open-Meteo"],
    items: [
      {
        name: "Sunamganj",
        lat: 25.0658,
        lon: 91.395,
        rainfall_1h_mm: 8.1,
        rainfall_6h_mm: 31.2,
        rainfall_24h_mm: 128.6,
        satellite_precip_mm: 58.4,
        river_discharge_m3s: 1180,
        temperature_c: 27.1,
        wind_kmh: 41,
        risk_score: 91.2,
        risk_level: "severe",
        confidence_pct: 86,
        satellite_water_anomaly: 0.74,
        forecast_steps: [],
        has_live_data: true,
        is_no_data: false,
        is_true_flood_signal: true
      }
    ]
  },
  "/api/upstream-status": {
    sample_area: "Dhaka",
    timestamp: new Date().toISOString(),
    open_meteo: { live: true, forecast_source: "open-meteo" },
    openweather_forecast_fallback: { live: false },
    nasa_power: { live: true, value_mm: 20, observed_day: "2026-10-24" },
    open_meteo_flood: { live: true, value_m3s: 900 },
    ai: { configured: true, live: true, provider: "groq", model: "openai/gpt-oss-20b" },
    telegram: { configured: true, webhook_mode: true, subscribers: 4 },
    forecast_pipeline_live: true,
    core_data_live: true
  },
  "/api/global-flood-events": { source: ["GDACS"], status: "live", updated_at: new Date().toISOString(), items: [] },
  "/api/bd-river-watch": { source: ["Open-Meteo Flood"], updated_at: new Date().toISOString(), items: [] },
  "/api/telegram/bot-info": {
    configured: true,
    username: "FloodSpacesBot",
    webhook_mode: true,
    subscribers: 4,
    profiles: 6,
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

const errors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
  originalError(...args);
};

async function main() {
  await import("../src/main");

  await new Promise((resolve) => setTimeout(resolve, 3500));
  const html = win.document.body.innerHTML;

  const checks: Array<[string, boolean]> = [
    ["root has content", (win.document.getElementById("root")?.innerHTML.length ?? 0) > 2000],
    ["intro cleared", !html.includes("loading-screen")],
    ["dashboard rendered", html.includes("Flood command center")],
    ["severe zone shown", html.includes("Sunamganj")],
    ["boundary not triggered", !html.includes("hit an unexpected error")],
    ["crash overlay not shown", !html.includes("flood-spaces-crash-overlay")]
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }

  const realErrors = errors.filter((line) => !/not wrapped in act|width\(0\) and height\(0\)/i.test(line));
  for (const line of realErrors.slice(0, 8)) console.log("  console:", line.slice(0, 300));

  console.log(`\n${failed === 0 && realErrors.length === 0 ? "ENTRY SMOKE OK" : "ENTRY SMOKE FAILED"}`);
  process.exit(failed === 0 && realErrors.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("ENTRY SMOKE CRASH", err);
  process.exit(1);
});
