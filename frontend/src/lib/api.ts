import type {
  AIChatMessage,
  AIChatResponse,
  AISummaryResponse,
  BotInfo,
  BoundaryResponse,
  GeocodeResult,
  GlobalFloodEventsResponse,
  RiverWatchResponse,
  RiskGridResponse,
  RiskPoint,
  UpstreamStatus
} from "../types";

const REQUEST_TIMEOUT_MS = 60000;

function splitConfiguredBases(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeBase(base: string): string {
  if (!base || base === "undefined") {
    return "";
  }
  return base.replace(/\/+$/, "");
}

const configuredBases = splitConfiguredBases(import.meta.env.VITE_API_BASE_URL || "");
const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";

// If a backend URL is configured we use it exclusively. Otherwise stay same-origin:
// Vite proxies /api in development and Vercel can rewrite in production.
const API_BASES = (
  configuredBases.length ? configuredBases : [browserOrigin ? "" : "http://127.0.0.1:8004"]
)
  .map(normalizeBase)
  .filter((v) => v !== "undefined");

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const errors: string[] = [];

  for (const base of API_BASES) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${path}`, { ...init, signal: init?.signal ?? controller.signal });
      if (!response.ok) {
        errors.push(`${base || "same-origin"}: HTTP ${response.status}`);
        continue;
      }
      return (await response.json()) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${base || "same-origin"}: ${message}`);
    } finally {
      window.clearTimeout(timer);
    }
  }

  throw new Error(errors.length ? `Backend unreachable (${errors.join("; ")})` : "Backend unreachable");
}

export async function fetchRiskGrid(): Promise<RiskGridResponse> {
  return requestJson<RiskGridResponse>("/api/risk-grid");
}

export async function subscribeTelegram(input: {
  chat_id: string;
  lat?: number;
  lon?: number;
  threshold: number;
  radius_km: number;
}): Promise<{ ok: boolean; total_subscriptions?: number }> {
  return requestJson<{ ok: boolean; total_subscriptions?: number }>("/api/alerts/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function runAlertCheck(): Promise<{ ok: boolean; alerts_sent: number }> {
  return requestJson<{ ok: boolean; alerts_sent: number }>("/api/alerts/check", { method: "POST" });
}

export async function fetchAiSummary(point: RiskPoint): Promise<AISummaryResponse> {
  return requestJson<AISummaryResponse>("/api/ai/summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      area_name: point.name,
      risk_score: point.risk_score,
      rainfall_24h_mm: point.rainfall_24h_mm,
      wind_kmh: point.wind_kmh,
      satellite_water_anomaly: point.satellite_water_anomaly,
      river_discharge_m3s: point.river_discharge_m3s,
      confidence_pct: point.confidence_pct,
      forecast_steps: point.forecast_steps
    })
  });
}

export async function fetchAiChat(messages: AIChatMessage[], areaName?: string): Promise<AIChatResponse> {
  return requestJson<AIChatResponse>("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      area_name: areaName ?? null
    })
  });
}

export async function fetchLocationRisk(lat: number, lon: number, name = "Selected Area"): Promise<RiskPoint> {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon), name });
  return requestJson<RiskPoint>(`/api/location-risk?${params.toString()}`);
}

export async function fetchAreaGrid(
  centerLat: number,
  centerLon: number,
  radiusKm = 25,
  stepKm = 5
): Promise<RiskPoint[]> {
  const params = new URLSearchParams({
    center_lat: String(centerLat),
    center_lon: String(centerLon),
    radius_km: String(radiusKm),
    step_km: String(stepKm)
  });
  const data = await requestJson<{ items: RiskPoint[] }>(`/api/area-grid?${params.toString()}`);
  return data.items;
}

export async function geocodePlace(query: string): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({ q: query });
  const data = await requestJson<{ items: GeocodeResult[] }>(`/api/geocode?${params.toString()}`);
  return data.items || [];
}

export async function fetchBoundaries(): Promise<BoundaryResponse> {
  return requestJson<BoundaryResponse>("/api/boundaries");
}

export async function fetchUpstreamStatus(): Promise<UpstreamStatus> {
  return requestJson<UpstreamStatus>("/api/upstream-status");
}

export async function fetchGlobalFloodEvents(): Promise<GlobalFloodEventsResponse> {
  return requestJson<GlobalFloodEventsResponse>("/api/global-flood-events");
}

export async function fetchBdRiverWatch(): Promise<RiverWatchResponse> {
  return requestJson<RiverWatchResponse>("/api/bd-river-watch");
}

export async function fetchBotInfo(): Promise<BotInfo> {
  return requestJson<BotInfo>("/api/telegram/bot-info");
}
