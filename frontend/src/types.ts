export type RiskLevel = "low" | "moderate" | "high" | "severe" | "flood";

export type ForecastStep = {
  time: string;
  rain_mm: number;
  temp_c?: number;
  wind_kmh?: number;
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

export type GlobalFloodEvent = {
  id: string;
  title: string;
  lat: number;
  lon: number;
  observed_at: string;
  source: string;
  severity: "watch" | "warning" | "emergency";
  risk_hint: number;
};

export type RiskDataSources = {
  forecast_live: boolean;
  forecast_source: string;
  open_meteo_live: boolean;
  openweather_forecast_fallback_live: boolean;
  nasa_live: boolean;
  nasa_observed_day?: string | null;
  river_live: boolean;
  temp_live: boolean;
};

export type RiskGridSourceSummary = {
  forecast_live_pct: number;
  open_meteo_live_pct: number;
  openweather_fallback_pct: number;
  nasa_live_pct: number;
  river_live_pct: number;
  temperature_live_pct: number;
};

export type UpstreamStatus = {
  sample_area: string;
  timestamp: string;
  open_meteo: {
    live: boolean;
    forecast_source: string;
  };
  openweather_forecast_fallback: {
    live: boolean;
  };
  nasa_power: {
    live: boolean;
    value_mm: number;
    observed_day?: string | null;
    reason?: string | null;
  };
  open_meteo_flood: {
    live: boolean;
    value_m3s: number;
    reason?: string | null;
  };
  openrouter: {
    configured: boolean;
    live: boolean;
    provider?: string | null;
    model?: string | null;
    reason?: string | null;
  };
  forecast_pipeline_live: boolean;
  core_data_live: boolean;
};

export type AIProviderResponse = {
  provider?: string | null;
  provider_live: boolean;
  provider_model?: string | null;
  provider_reason?: string | null;
};

export type AISummaryResponse = AIProviderResponse & {
  summary: string;
};

export type AIChatResponse = AIProviderResponse & {
  reply: string;
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
  short_forecast_steps?: ForecastStep[];
  has_live_data: boolean;
  is_no_data: boolean;
  is_true_flood_signal: boolean;
  river_name?: string;
  is_river_watch?: boolean;
  distance_to_seed_km?: number;
  data_sources?: RiskDataSources;
};

export type RiskGridResponse = {
  country_focus: string;
  source: string[];
  source_status?: RiskGridSourceSummary;
  items: RiskPoint[];
};

export type BoundaryResponse = {
  country: Record<string, unknown>;
  districts: Record<string, unknown>;
  upazilas: Record<string, unknown>;
};

export type GlobalFloodEventsResponse = {
  source: string[];
  status?: "live" | "unavailable";
  updated_at: string;
  items: GlobalFloodEvent[];
};

export type RiverWatchResponse = {
  source: string[];
  updated_at: string;
  items: RiskPoint[];
};
