import type { AIChatMessage, BoundaryResponse, GeocodeResult, RiskGridResponse, RiskPoint } from "../types";

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

function codespacesPortOrigins(origin: string): string[] {
  const match = origin.match(/^(https?:\/\/[^-]+-)(\d+)(\.app\.github\.dev)$/);
  if (!match) {
    return [];
  }
  const [, prefix, , suffix] = match;
  return [8004, 8003, 8000].map((port) => `${prefix}${port}${suffix}`);
}

const configuredBases = splitConfiguredBases(import.meta.env.VITE_API_BASE_URL || "");
const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";

const API_BASES = Array.from(
  new Set(
    [
      ...configuredBases,
      "",
      browserOrigin,
      ...codespacesPortOrigins(browserOrigin),
      "http://localhost:8004",
      "http://localhost:8003",
      "http://localhost:8000"
    ]
      .map(normalizeBase)
      .filter((v) => v !== "undefined")
  )
) as string[];

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const errors: string[] = [];
  for (const base of API_BASES) {
    try {
      const target = `${base}${path}`;
      const response = await fetch(target, init);
      if (!response.ok) {
        errors.push(`${base}: ${response.status}`);
        continue;
      }
      return response.json();
    } catch (error) {
      errors.push(`${base}: ${(error as Error).message}`);
    }
  }

  throw new Error(errors.length ? `Failed to fetch data (${errors.join("; ")})` : "Failed to fetch data");
}

export async function fetchRiskGrid(): Promise<RiskGridResponse> {
  return requestJson<RiskGridResponse>("/api/risk-grid");
}

export async function subscribeTelegram(input: {
  chat_id: string;
  lat: number;
  lon: number;
  threshold: number;
  radius_km: number;
}): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>("/api/alerts/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function runAlertCheck(): Promise<{ ok: boolean; alerts_sent: number }> {
  return requestJson<{ ok: boolean; alerts_sent: number }>("/api/alerts/check", { method: "POST" });
}

export async function fetchAiSummary(point: RiskPoint): Promise<string> {
  const data = await requestJson<{ summary: string }>("/api/ai/summary", {
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
  return data.summary;
}

export async function fetchAiChat(messages: AIChatMessage[], areaName?: string): Promise<string> {
  const data = await requestJson<{ reply: string }>("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      area_name: areaName ?? null
    })
  });
  return data.reply;
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
