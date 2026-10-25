import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost:5173/",
  pretendToBeVisual: true
});

const win = dom.window as unknown as Window & typeof globalThis;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = win.document;
Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
(globalThis as Record<string, unknown>).HTMLElement = win.HTMLElement;
(globalThis as Record<string, unknown>).Node = win.Node;
(globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
(win as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

// SMOKE_NO_WEBGL=1 simulates browsers/iframes where WebGL is blocked, which
// previously made MapLibre throw and unmount the whole dashboard.
const noWebgl = process.env.NO_WEBGL === "1";
if (noWebgl) {
  win.HTMLCanvasElement.prototype.getContext = (() => null) as never;
} else {
  // Pretend WebGL2 exists so the map init path runs (the real renderer is stubbed).
  win.HTMLCanvasElement.prototype.getContext = ((type: string) =>
    type === "webgl2"
      ? ({ getExtension: () => ({ loseContext: () => {} }) } as unknown)
      : null) as never;
}

const fixtures: Record<string, unknown> = {
  "/api/risk-grid": {
    country_focus: "Bangladesh forecast focus",
    source: ["Open-Meteo"],
    items: [
      {
        name: "Sylhet",
        lat: 24.8949,
        lon: 91.8687,
        rainfall_1h_mm: 6.2,
        rainfall_6h_mm: 24.1,
        rainfall_24h_mm: 96.4,
        satellite_precip_mm: 41.2,
        river_discharge_m3s: 812.5,
        temperature_c: 28.4,
        wind_kmh: 34.2,
        risk_score: 78.4,
        risk_level: "high",
        confidence_pct: 83,
        satellite_water_anomaly: 0.62,
        forecast_steps: Array.from({ length: 7 }).map((_, i) => ({
          time: `2026-10-${String(25 + i).padStart(2, "0")}`,
          rain_mm: 12 + i * 2,
          temp_c: 29,
          wind_kmh: 22,
          trend: 40 + i * 4
        })),
        has_live_data: true,
        is_no_data: false,
        is_true_flood_signal: false,
        data_sources: {
          forecast_live: true,
          forecast_source: "open-meteo",
          open_meteo_live: true,
          openweather_forecast_fallback_live: false,
          nasa_live: true,
          river_live: true,
          temp_live: true
        }
      },
      {
        name: "Dhaka",
        lat: 23.8103,
        lon: 90.4125,
        rainfall_1h_mm: 1.2,
        rainfall_6h_mm: 6.1,
        rainfall_24h_mm: 22.4,
        satellite_precip_mm: 12.2,
        river_discharge_m3s: 220.5,
        temperature_c: 31.4,
        wind_kmh: 12.2,
        risk_score: 42.4,
        risk_level: "low",
        confidence_pct: 90,
        satellite_water_anomaly: 0.2,
        forecast_steps: [],
        has_live_data: true,
        is_no_data: false,
        is_true_flood_signal: false
      }
    ]
  },
  "/api/upstream-status": {
    sample_area: "Dhaka",
    timestamp: new Date().toISOString(),
    open_meteo: { live: true, forecast_source: "open-meteo" },
    openweather_forecast_fallback: { live: false },
    nasa_power: { live: true, value_mm: 12.2, observed_day: "2026-10-24" },
    open_meteo_flood: { live: true, value_m3s: 220.5 },
    ai: { configured: true, live: true, provider: "groq", model: "openai/gpt-oss-20b" },
    telegram: { configured: true, webhook_mode: false, subscribers: 12 },
    forecast_pipeline_live: true,
    core_data_live: true
  },
  "/api/global-flood-events": {
    source: ["NASA EONET", "GDACS"],
    status: "live",
    updated_at: new Date().toISOString(),
    items: [
      {
        id: "e1",
        title: "Flood in Sylhet Division",
        lat: 24.9,
        lon: 91.8,
        observed_at: new Date().toISOString(),
        source: "GDACS",
        severity: "warning",
        risk_hint: 91
      }
    ]
  },
  "/api/bd-river-watch": {
    source: ["Open-Meteo Flood"],
    updated_at: new Date().toISOString(),
    items: [
      {
        name: "Surma - Sylhet",
        river_name: "Surma",
        lat: 24.8949,
        lon: 91.8687,
        rainfall_1h_mm: 0,
        rainfall_6h_mm: 0,
        rainfall_24h_mm: 0,
        satellite_precip_mm: 0,
        river_discharge_m3s: 640,
        temperature_c: null,
        wind_kmh: 0,
        risk_score: 71,
        risk_level: "high",
        confidence_pct: 80,
        satellite_water_anomaly: 0.4,
        forecast_steps: [],
        has_live_data: true,
        is_no_data: false,
        is_true_flood_signal: false
      }
    ]
  },
  "/api/telegram/bot-info": {
    configured: true,
    username: "FloodSpacesBot",
    webhook_mode: false,
    subscribers: 12,
    profiles: 14,
    ai_provider: "groq",
    ai_model: "openai/gpt-oss-20b"
  },
  "/api/boundaries": { country: { type: "FeatureCollection", features: [] }, districts: { type: "FeatureCollection", features: [] }, upazilas: { type: "FeatureCollection", features: [] } },
  "/api/area-grid": { items: [] },
  "/api/location-risk": {
    name: "Sylhet",
    lat: 24.8949,
    lon: 91.8687,
    rainfall_1h_mm: 6.2,
    rainfall_6h_mm: 24.1,
    rainfall_24h_mm: 96.4,
    satellite_precip_mm: 41.2,
    river_discharge_m3s: 812.5,
    temperature_c: 28.4,
    wind_kmh: 34.2,
    risk_score: 78.4,
    risk_level: "high",
    confidence_pct: 83,
    satellite_water_anomaly: 0.62,
    forecast_steps: [],
    has_live_data: true,
    is_no_data: false,
    is_true_flood_signal: false
  }
};

(globalThis as Record<string, unknown>).fetch = async (input: RequestInfo | URL) => {
  const url = String(input).replace(/^https?:\/\/[^/]+/, "");
  const path = url.split("?")[0];
  const body = fixtures[path];
  if (body === undefined) {
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }
  return { ok: true, status: 200, json: async () => body } as Response;
};

const errors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
  originalError(...args);
};

async function main() {
  const { default: App } = await import("../src/App");
  const rootEl = win.document.getElementById("root")!;
  const root = createRoot(rootEl);
  root.render(React.createElement(App));

  await new Promise((resolve) => setTimeout(resolve, 3500));

  const html = win.document.body.innerHTML;
  const checks: Array<[string, boolean]> = [
    ...(noWebgl
      ? ([
          ["webgl fallback shown", html.includes("Map view unavailable")],
          ["fallback lists zones", html.includes("map-fallback-inner")],
          ["dashboard still alive", html.includes("National risk index") && html.includes("Telegram flood bot")],
          ["no crash overlay", !html.includes("Runtime error")]
        ] as Array<[string, boolean]>)
      : []),
    ["shell rendered", html.includes("app-shell")],
    ["title", html.includes("Flood Spaces</h1>")],
    ["KPI strip", html.includes("National risk index")],
    ["peak hotspot name", html.includes("Sylhet")],
    ["risk gauge", html.includes("risk-gauge-value")],
    ["AI panel", html.includes("FloodSpaces AI")],
    ["groq model label", html.includes("openai/gpt-oss-20b")],
    ["telegram card", html.includes("Telegram flood bot")],
    ["bot deep link", html.includes("https://t.me/FloodSpacesBot")],
    ["river watch row", html.includes("Surma")],
    ["events feed", html.includes("Flood in Sylhet Division")],
    ["emergency helplines", html.includes("16163")],
    ["no degraded banner", !html.includes("Upstream feeds are degraded")],
    ["no error banner", !html.includes("Live backend unreachable")],
    ["no CARTO key watermark text", !/API KEY REQUIRED|basemaps\/apikey/i.test(html)]
  ];

  if (!noWebgl) {
    const style = (globalThis as Record<string, unknown>).__maplibreLastStyle as
      | { sources?: Record<string, { tiles?: string[] }> }
      | undefined;
    const tiles = style?.sources?.basemap?.tiles || [];
    checks.push(
      ["basemap needs no API key", !tiles.some((url) => /cartocdn\.com/i.test(url))],
      ["keyless dark basemap configured", tiles.some((url) => /arcgisonline\.com/i.test(url))],
      ["basemap label layer present", Boolean(style?.sources?.["basemap-labels"])]
    );
  }

  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }

  const realErrors = errors.filter(
    (line) => !/not wrapped in act|ReactDOMTestUtils|Warning: .*act\(/i.test(line)
  );
  if (realErrors.length) {
    console.log("\nConsole errors:");
    for (const line of realErrors.slice(0, 12)) console.log("  -", line.slice(0, 400));
  }

  console.log(`\n${failed === 0 && realErrors.length === 0 ? "SMOKE OK" : "SMOKE FAILED"} (${failed} failed checks, ${realErrors.length} console errors)`);
  process.exit(failed === 0 && realErrors.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SMOKE CRASH", err);
  process.exit(1);
});
