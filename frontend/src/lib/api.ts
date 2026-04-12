import type { RiskGridResponse, RiskPoint } from "../types";

const API_BASES = Array.from(
  new Set([
    import.meta.env.VITE_API_BASE_URL || "",
    "",
    typeof window !== "undefined" ? window.location.origin : "",
    "http://localhost:8004",
    "http://localhost:8003",
    "http://localhost:8000"
  ].filter((v) => v !== "undefined"))
) as string[];

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const errors: string[] = [];
  for (const base of API_BASES) {
    try {
      const response = await fetch(`${base}${path}`, init);
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

export async function geocodePlace(query: string): Promise<Array<{ name: string; lat: number; lon: number }>> {
  const params = new URLSearchParams({ q: query });
  const data = await requestJson<{ items: Array<{ name: string; lat: number; lon: number }> }>(`/api/geocode?${params.toString()}`);
  return data.items || [];
}

export async function fetchBoundaries(): Promise<{ country: Record<string, unknown>; districts: Record<string, unknown> }> {
  return requestJson<{ country: Record<string, unknown>; districts: Record<string, unknown> }>("/api/boundaries");
}
