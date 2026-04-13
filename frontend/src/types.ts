export type RiskLevel = "low" | "moderate" | "high" | "severe" | "flood";

export type ForecastStep = {
  time: string;
  rain_mm: number;
  trend: number;
};

export type AIChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type GeocodeResult = {
  name: string;
  name_bn?: string | null;
  name_en?: string | null;
  lat: number;
  lon: number;
  source?: string;
};

export type RiskPoint = {
  name: string;
  lat: number;
  lon: number;
  rainfall_1h_mm: number;
  rainfall_6h_mm: number;
  rainfall_24h_mm: number;
  satellite_precip_mm: number;
  river_discharge_m3s: number;
  temperature_c: number | null;
  wind_kmh: number;
  risk_score: number;
  risk_level: RiskLevel;
  confidence_pct: number;
  satellite_water_anomaly: number;
  forecast_steps: ForecastStep[];
  has_live_data: boolean;
  is_no_data: boolean;
  is_true_flood_signal: boolean;
};

export type RiskGridResponse = {
  country_focus: string;
  source: string[];
  items: RiskPoint[];
};

export type BoundaryResponse = {
  country: Record<string, unknown>;
  districts: Record<string, unknown>;
  upazilas: Record<string, unknown>;
};
