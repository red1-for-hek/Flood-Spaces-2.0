import math
import os
import asyncio
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Literal, Tuple
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import httpx
import numpy as np
import openmeteo_requests
import pandas as pd
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from requests_cache import CachedSession
from retry_requests import retry

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

app = FastAPI(title="Flood Spaces API", version="0.1.0")

def configured_frontend_origins() -> List[str]:
    raw = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
    configured = [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]
    defaults = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ]

    merged: List[str] = []
    for origin in [*configured, *defaults]:
        if origin and origin not in merged:
            merged.append(origin)
    return merged


frontend_origins = configured_frontend_origins()
frontend_origin = frontend_origins[0] if frontend_origins else "http://localhost:5173"

app.add_middleware(
    CORSMiddleware,
    allow_origins=frontend_origins,
    allow_origin_regex=r"https://.*\.(app\.github\.dev|githubpreview\.dev)$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

BANGLADESH_BOUNDS = {
    "lat_min": 20.6,
    "lat_max": 26.7,
    "lon_min": 88.0,
    "lon_max": 92.7,
}

CITY_SEEDS = [
    {"name": "Dhaka", "lat": 23.8103, "lon": 90.4125},
    {"name": "Chattogram", "lat": 22.3569, "lon": 91.7832},
    {"name": "Sylhet", "lat": 24.8949, "lon": 91.8687},
    {"name": "Khulna", "lat": 22.8456, "lon": 89.5403},
    {"name": "Rajshahi", "lat": 24.3745, "lon": 88.6042},
    {"name": "Barishal", "lat": 22.701, "lon": 90.3535},
    {"name": "Rangpur", "lat": 25.7439, "lon": 89.2752},
    {"name": "Mymensingh", "lat": 24.7471, "lon": 90.4203},
    {"name": "Cumilla", "lat": 23.1604, "lon": 91.1758},
    {"name": "Narail", "lat": 23.1728, "lon": 89.3394},
    {"name": "Narayanganj", "lat": 23.6019, "lon": 90.5034},
    {"name": "Tangail", "lat": 24.2506, "lon": 89.9271},
    {"name": "Pabna", "lat": 23.9995, "lon": 89.2408},
    {"name": "Bogra", "lat": 24.8949, "lon": 89.3667},
    {"name": "Dinajpur", "lat": 25.6217, "lon": 88.6409},
    {"name": "Jashore", "lat": 23.1644, "lon": 89.2081},
]

MONTHLY_FORECAST_DAYS = 30
SHORT_FORECAST_DAYS = 3


class TelegramSubscription(BaseModel):
    chat_id: str
    lat: float
    lon: float
    radius_km: float = Field(default=100, ge=5, le=300)
    threshold: int = Field(default=70, ge=30, le=95)


class AIRequest(BaseModel):
    area_name: str
    risk_score: float
    rainfall_24h_mm: float
    wind_kmh: float
    satellite_water_anomaly: float = 0.0
    river_discharge_m3s: float = 0.0
    confidence_pct: int = 50
    forecast_steps: List[Dict] = Field(default_factory=list)


class AIChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class AIChatRequest(BaseModel):
    messages: List[AIChatMessage] = Field(default_factory=list)
    area_name: str | None = None


subscriptions: List[TelegramSubscription] = []
scheduler = AsyncIOScheduler()
location_cache: Dict[str, Dict] = {}
grid_cache: Dict[str, Dict] = {}
boundary_cache: Dict[str, Dict] = {}
source_status_cache: Dict[str, Dict] = {}
global_flood_cache: Dict[str, Dict] = {}
river_watch_cache: Dict[str, Dict] = {}


def build_openmeteo_client() -> openmeteo_requests.Client | None:
    try:
        cache_dir = Path(__file__).resolve().parent.parent / ".cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_session = CachedSession(str(cache_dir / "openmeteo_cache"), expire_after=900)
        retry_session = retry(cache_session, retries=3, backoff_factor=0.35)
        return openmeteo_requests.Client(session=retry_session)
    except Exception:
        return None


openmeteo_client = build_openmeteo_client()


RIVER_WATCH_POINTS: List[Dict[str, float | str]] = [
    {"river_name": "Surma", "name": "Surma - Sylhet", "lat": 24.8949, "lon": 91.8687},
    {"river_name": "Surma", "name": "Surma - Sunamganj", "lat": 25.0658, "lon": 91.3950},
    {"river_name": "Kushiyara", "name": "Kushiyara - Beanibazar", "lat": 24.7830, "lon": 92.0630},
    {"river_name": "Kushiyara", "name": "Kushiyara - Fenchuganj", "lat": 24.7035, "lon": 91.9780},
    {"river_name": "Jamuna", "name": "Jamuna - Sirajganj", "lat": 24.4539, "lon": 89.7007},
    {"river_name": "Jamuna", "name": "Jamuna - Tangail", "lat": 24.3917, "lon": 89.9948},
    {"river_name": "Padma", "name": "Padma - Rajbari", "lat": 23.7574, "lon": 89.6445},
    {"river_name": "Padma", "name": "Padma - Shariatpur", "lat": 23.2459, "lon": 90.2112},
    {"river_name": "Meghna", "name": "Meghna - Chandpur", "lat": 23.2330, "lon": 90.6713},
    {"river_name": "Meghna", "name": "Meghna - Bhola", "lat": 22.6859, "lon": 90.6482},
    {"river_name": "Brahmaputra", "name": "Brahmaputra - Jamalpur", "lat": 24.9375, "lon": 89.9378},
    {"river_name": "Brahmaputra", "name": "Brahmaputra - Gaibandha", "lat": 25.3288, "lon": 89.5430},
    {"river_name": "Teesta", "name": "Teesta - Lalmonirhat", "lat": 25.9923, "lon": 89.2847},
    {"river_name": "Teesta", "name": "Teesta - Rangpur", "lat": 25.6856, "lon": 89.2492},
    {"river_name": "Karnaphuli", "name": "Karnaphuli - Rangamati", "lat": 22.6531, "lon": 92.1752},
    {"river_name": "Karnaphuli", "name": "Karnaphuli - Chattogram", "lat": 22.3252, "lon": 91.8140},
]


def empty_geojson() -> Dict:
    return {"type": "FeatureCollection", "features": []}


def build_default_payload() -> Dict:
    base_day = datetime.now(timezone.utc).date()
    days = [(base_day + timedelta(days=offset)).isoformat() for offset in range(MONTHLY_FORECAST_DAYS)]
    total_hours = MONTHLY_FORECAST_DAYS * 24
    return {
        "hourly": {
            "time": [],
            "precipitation": [0.0] * total_hours,
            "wind_speed_10m": [0.0] * total_hours,
        },
        "daily": {
            "time": days,
            "precipitation_sum": [0.0] * MONTHLY_FORECAST_DAYS,
            "temperature_2m_max": [0.0] * MONTHLY_FORECAST_DAYS,
            "wind_speed_10m_max": [0.0] * MONTHLY_FORECAST_DAYS,
        },
        "_meta": {"live": False, "source": "default-no-data"},
    }


def normalize_search_query(query: str) -> str:
    return re.sub(r"\s+", " ", query.strip())


def format_place_label(address: Dict) -> str:
    parts = [
        address.get("suburb"),
        address.get("city_district"),
        address.get("town") or address.get("city") or address.get("village"),
        address.get("county"),
        address.get("state"),
        address.get("country"),
    ]
    labels = [str(part) for part in parts if part]
    if labels:
        return ", ".join(dict.fromkeys(labels))
    return "Unknown"


def dedupe_geocode_results(items: List[Dict]) -> List[Dict]:
    seen = set()
    results = []
    for item in items:
        key = (round(float(item["lat"]), 5), round(float(item["lon"]), 5), item["name"])
        if key in seen:
            continue
        seen.add(key)
        results.append(item)
    return results


def local_ai_fallback(messages: List[Dict[str, str]]) -> str:
    last_user = ""
    for message in reversed(messages):
        if message.get("role") == "user":
            last_user = str(message.get("content", "")).lower()
            break

    if "risk score" in last_user or "flood" in last_user or "evacu" in last_user:
        return (
            "Local AI fallback (OpenRouter unavailable):\n"
            "1) Monitor rainfall and waterlogging alerts every 2-3 hours.\n"
            "2) If roads are already waterlogged, move early to higher ground.\n"
            "3) Keep emergency phone, power bank, clean water, and dry food ready for 24-48h.\n"
            "4) Avoid crossing fast-moving water, even if depth looks low."
        )

    return (
        "Local AI fallback (OpenRouter unavailable): I can still help with flood safety, map interpretation, "
        "risk levels, and alert setup. Ask for area-specific guidance and I will provide practical steps."
    )


def safe_error_message(error: Exception | None) -> str:
    if error is None:
        return ""
    message = str(error).replace("\n", " ").strip()
    return message[:220]


def normalize_source_status(payload_meta: Dict, nasa_meta: Dict, river_meta: Dict, weather_meta: Dict) -> Dict:
    forecast_source = str(payload_meta.get("source", "default-no-data"))
    return {
        "forecast_live": bool(payload_meta.get("live", False)),
        "forecast_source": forecast_source,
        "open_meteo_live": forecast_source == "open-meteo",
        "openweather_forecast_fallback_live": forecast_source == "openweather-forecast-fallback",
        "nasa_live": bool(nasa_meta.get("live", False)),
        "nasa_observed_day": nasa_meta.get("observed_day"),
        "river_live": bool(river_meta.get("live", False)),
        "temp_live": bool(weather_meta.get("live", False)),
    }


def summarize_source_health(items: List[Dict]) -> Dict:
    total = max(1, len(items))

    def pct(key: str) -> int:
        count = sum(1 for item in items if bool(item.get("data_sources", {}).get(key)))
        return int(round((count / total) * 100))

    return {
        "forecast_live_pct": pct("forecast_live"),
        "open_meteo_live_pct": pct("open_meteo_live"),
        "openweather_fallback_pct": pct("openweather_forecast_fallback_live"),
        "nasa_live_pct": pct("nasa_live"),
        "river_live_pct": pct("river_live"),
        "temperature_live_pct": pct("temp_live"),
    }


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def nearest_city_seed(lat: float, lon: float) -> Dict[str, float]:
    return min(CITY_SEEDS, key=lambda city: haversine_km(lat, lon, city["lat"], city["lon"]))


def average_lon_lat(coords: List[List[float]]) -> tuple[float, float] | None:
    if not coords:
        return None
    lon_sum = 0.0
    lat_sum = 0.0
    valid = 0
    for pair in coords:
        if not isinstance(pair, list) or len(pair) < 2:
            continue
        lon = pair[0]
        lat = pair[1]
        if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
            lon_sum += float(lon)
            lat_sum += float(lat)
            valid += 1
    if valid == 0:
        return None
    return (lon_sum / valid, lat_sum / valid)


def event_geometry_point(geometry: Dict | None) -> tuple[float, float] | None:
    if not isinstance(geometry, dict):
        return None

    geo_type = str(geometry.get("type", ""))
    coords = geometry.get("coordinates")

    if geo_type == "Point" and isinstance(coords, list) and len(coords) >= 2:
        lon = coords[0]
        lat = coords[1]
        if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
            return (float(lon), float(lat))
        return None

    if geo_type == "Polygon" and isinstance(coords, list) and coords:
        outer_ring = coords[0] if isinstance(coords[0], list) else []
        return average_lon_lat(outer_ring)

    if geo_type == "MultiPolygon" and isinstance(coords, list) and coords:
        first_poly = coords[0] if isinstance(coords[0], list) else []
        outer_ring = first_poly[0] if first_poly and isinstance(first_poly[0], list) else []
        return average_lon_lat(outer_ring)

    return None


def classify_event_severity(title: str) -> tuple[str, int]:
    lowered = title.lower()
    if any(token in lowered for token in ["catastrophic", "extreme", "major", "severe"]):
        return ("emergency", 96)
    if any(token in lowered for token in ["watch", "minor", "advisory"]):
        return ("watch", 86)
    return ("warning", 91)


def flood_event_proximity_bonus(lat: float, lon: float, events: List[Dict]) -> float:
    if not events:
        return 0.0

    nearest_km = min(haversine_km(lat, lon, float(event["lat"]), float(event["lon"])) for event in events)
    if nearest_km > 520:
        return 0.0
    if nearest_km <= 65:
        return 26.0
    if nearest_km <= 150:
        return 17.0
    if nearest_km <= 300:
        return 10.0
    return 4.0


def apply_flood_event_signal(point: Dict, events: List[Dict]) -> Dict:
    bonus = flood_event_proximity_bonus(float(point["lat"]), float(point["lon"]), events)
    if bonus <= 0:
        return point

    patched = {**point}
    boosted_score = round(min(100.0, float(point["risk_score"]) + bonus), 1)
    patched["risk_score"] = boosted_score
    patched["risk_level"] = risk_level(boosted_score)
    patched["is_true_flood_signal"] = bool(point.get("is_true_flood_signal")) or boosted_score >= 92
    patched["event_boost"] = round(bonus, 1)

    if isinstance(point.get("forecast_steps"), list):
        boosted_steps = []
        for idx, step in enumerate(point["forecast_steps"]):
            if not isinstance(step, dict):
                continue
            trend = float(step.get("trend", 0.0))
            decayed = max(0.0, bonus - (idx * 1.6))
            boosted_steps.append(
                {
                    **step,
                    "trend": round(min(100.0, trend + decayed), 1),
                }
            )
        patched["forecast_steps"] = boosted_steps

    return patched


def derive_model_flood_events(points: List[Dict], max_items: int = 4) -> List[Dict]:
    if not points:
        return []

    ranked = sorted(points, key=lambda item: float(item.get("risk_score", 0.0)), reverse=True)
    candidates = [item for item in ranked if float(item.get("risk_score", 0.0)) >= 62][:max_items]
    if not candidates:
        candidates = ranked[: min(2, len(ranked))]

    events = []
    now = datetime.now(timezone.utc).isoformat()
    for idx, point in enumerate(candidates):
        score = float(point.get("risk_score", 0.0))
        if score >= 90:
            severity = "emergency"
            risk_hint = 96
        elif score >= 75:
            severity = "warning"
            risk_hint = 91
        else:
            severity = "watch"
            risk_hint = 86

        title = f"Model flood watch near {point.get('name', f'Zone {idx + 1}') }"
        events.append(
            {
                "id": f"model-{idx}-{round(float(point.get('lat', 0.0)), 2)}-{round(float(point.get('lon', 0.0)), 2)}",
                "title": title,
                "lat": round(float(point.get("lat", 0.0)), 4),
                "lon": round(float(point.get("lon", 0.0)), 4),
                "observed_at": now,
                "source": "Model Auto-Detection",
                "severity": severity,
                "risk_hint": risk_hint,
            }
        )

    return events


def risk_level(score: float) -> str:
    if score < 45:
        return "low"
    if score < 68:
        return "moderate"
    if score < 84:
        return "high"
    if score < 94:
        return "severe"
    return "flood"


def compute_risk_score(
    rain_1h: float,
    rain_6h: float,
    rain_24h: float,
    wind_kmh: float,
    satellite_precip_mm: float,
    river_discharge: float,
    temperature_c: float | None,
) -> float:
    # Calibrated weighted model to avoid over-reporting severe risk in normal weather.
    heat_storm_bonus = 0.0
    if temperature_c is not None and temperature_c >= 30:
        heat_storm_bonus = 2.0

    score = (
        min(rain_1h * 4.0, 18)
        + min(rain_6h * 1.1, 16)
        + min(rain_24h * 0.45, 22)
        + min(max(wind_kmh - 20, 0) * 0.55, 8)
        + min(satellite_precip_mm * 0.5, 8)
        + min(river_discharge * 0.015, 10)
        + heat_storm_bonus
    )
    return round(min(score, 100), 1)


def compute_confidence(payload: Dict, source_status: Dict) -> int:
    rain = payload.get("hourly", {}).get("precipitation", [])
    wind = payload.get("hourly", {}).get("wind_speed_10m", [])
    has_optional_temp_source = bool(os.getenv("OPENWEATHER_API_KEY", "").strip())
    checks = [
        len(rain) >= 24,
        len(wind) >= 24,
        bool(source_status.get("forecast_live", False)),
        bool(source_status.get("nasa_live", False)),
        bool(source_status.get("river_live", False)),
        (not has_optional_temp_source) or bool(source_status.get("temp_live", False)),
    ]
    return int(round((sum(1 for ok in checks if ok) / len(checks)) * 100))


def compute_satellite_water_anomaly(satellite_precip_mm: float, river_discharge: float) -> float:
    # NASA satellite (MODIS/POWER) water anomaly signal: extreme precip + high discharge = flooding.
    precip_signal = min(satellite_precip_mm / 50.0, 1.0) * 60
    discharge_signal = min(river_discharge / 2000.0, 1.0) * 40
    anomaly = (precip_signal + discharge_signal) / 100.0
    return round(min(anomaly, 1.0), 2)


def sanitize_numeric_series(values: List, size: int, default: float = 0.0) -> np.ndarray:
    result = np.full(size, default, dtype=float)
    for idx in range(min(size, len(values))):
        value = values[idx]
        if value is None:
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if np.isfinite(numeric):
            result[idx] = numeric
    return result


def extend_daily_series(values: np.ndarray, horizon: int, *, decay: bool = False) -> np.ndarray:
    if horizon <= 0:
        return np.array([], dtype=float)

    if values.size >= horizon:
        return values[:horizon]

    result = np.zeros(horizon, dtype=float)
    if values.size == 0:
        return result

    result[: values.size] = values
    window = values[max(0, values.size - 7) : values.size]
    window_size = max(1, window.size)

    for idx in range(values.size, horizon):
        offset = idx - values.size
        projected = float(window[offset % window_size])
        if decay:
            projected *= max(0.35, 1.0 - (0.02 * offset))
        result[idx] = max(0.0, projected)

    return result


def generate_forecast_steps(payload: Dict, horizon_days: int = MONTHLY_FORECAST_DAYS) -> List[Dict]:
    horizon_days = max(1, int(horizon_days))
    daily = payload.get("daily", {})
    dates = list(daily.get("time", []))
    rain_raw = daily.get("precipitation_sum", [])
    temp_raw = daily.get("temperature_2m_max", [])
    wind_raw = daily.get("wind_speed_10m_max", [])

    if not dates:
        base_day = datetime.now(timezone.utc).date()
        dates = [
            ts.strftime("%Y-%m-%d")
            for ts in pd.date_range(base_day, periods=horizon_days, freq="D")
        ]
    elif len(dates) < horizon_days:
        last_day = pd.to_datetime(dates[-1], errors="coerce", utc=True)
        if pd.isna(last_day):
            last_date = datetime.now(timezone.utc).date()
        else:
            last_date = last_day.date()

        while len(dates) < horizon_days:
            last_date = last_date + timedelta(days=1)
            dates.append(last_date.isoformat())

    horizon = min(horizon_days, len(dates))
    if horizon <= 0:
        return []

    rain_source = sanitize_numeric_series(rain_raw, min(len(rain_raw), horizon))
    temp_source = sanitize_numeric_series(temp_raw, min(len(temp_raw), horizon))
    wind_source = sanitize_numeric_series(wind_raw, min(len(wind_raw), horizon))

    rain = extend_daily_series(rain_source, horizon, decay=True)
    temp = extend_daily_series(temp_source, horizon)
    wind = extend_daily_series(wind_source, horizon)

    steps = []
    for idx in range(horizon):
        rain_value = float(rain[idx])
        wind_value = float(wind[idx])
        temp_value = float(temp[idx])
        trend = float(np.clip(rain_value * 3.5 + max(wind_value - 18, 0) * 0.7 + max(temp_value - 30, 0) * 0.6, 0, 100))

        steps.append(
            {
                "time": str(dates[idx]),
                "rain_mm": round(rain_value, 2),
                "temp_c": round(temp_value, 1),
                "wind_kmh": round(wind_value, 1),
                "trend": round(trend, 1),
            }
        )
    return steps


async def openrouter_chat_completion(messages: List[Dict[str, str]], temperature: float = 0.2, max_tokens: int = 450) -> Dict:
    key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not key:
        return {
            "text": local_ai_fallback(messages),
            "provider": "local-fallback",
            "provider_live": False,
            "provider_model": None,
            "provider_reason": "missing_openrouter_api_key",
        }

    models = [
        os.getenv("OPENROUTER_MODEL", "openrouter/auto").strip() or "openrouter/auto",
        "openrouter/auto",
        "qwen/qwen-2.5-7b-instruct:free",
        "google/gemma-2-9b-it:free",
    ]
    referer = os.getenv("OPENROUTER_SITE_URL", frontend_origin).strip() or "http://localhost:5173"
    title = os.getenv("OPENROUTER_APP_NAME", "Flood Spaces").strip() or "Flood Spaces"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": title,
    }
    last_error = "openrouter_unavailable"

    async with httpx.AsyncClient(timeout=12) as client:
        for model in dict.fromkeys(models):
            payload = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            try:
                response = await client.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
                text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                if isinstance(text, str) and text.strip():
                    return {
                        "text": text.strip(),
                        "provider": "openrouter",
                        "provider_live": True,
                        "provider_model": model,
                        "provider_reason": "ok",
                    }
                last_error = "empty_openrouter_response"
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                body = exc.response.text.replace("\n", " ").strip()
                last_error = f"http_{status}:{body[:180]}"
                if status in (401, 403):
                    break
            except Exception as exc:
                last_error = safe_error_message(exc) or "openrouter_exception"

    return {
        "text": local_ai_fallback(messages),
        "provider": "local-fallback",
        "provider_live": False,
        "provider_model": None,
        "provider_reason": last_error,
    }


async def fetch_openweather_forecast_payload(lat: float, lon: float) -> Dict | None:
    key = os.getenv("OPENWEATHER_API_KEY", "")
    if not key:
        return None

    params = {
        "lat": lat,
        "lon": lon,
        "appid": key,
        "units": "metric",
    }
    url = "https://api.openweathermap.org/data/2.5/forecast"

    now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    days = [(now_utc.date() + timedelta(days=offset)).isoformat() for offset in range(MONTHLY_FORECAST_DAYS)]
    total_hours = MONTHLY_FORECAST_DAYS * 24

    try:
        async with httpx.AsyncClient(timeout=12) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()

        hourly_precip = [0.0] * total_hours
        hourly_wind = [0.0] * total_hours
        daily_rain = {day: 0.0 for day in days}
        daily_temp = {day: 0.0 for day in days}
        daily_wind = {day: 0.0 for day in days}

        for row in data.get("list", []):
            ts = row.get("dt")
            if not isinstance(ts, int):
                continue

            point_time = datetime.fromtimestamp(ts, timezone.utc).replace(minute=0, second=0, microsecond=0)
            hour_index = int((point_time - now_utc).total_seconds() // 3600)
            rain_3h = float(row.get("rain", {}).get("3h", 0.0) or 0.0)
            wind_kmh = float(row.get("wind", {}).get("speed", 0.0) or 0.0) * 3.6
            temp_max = float(row.get("main", {}).get("temp_max", 0.0) or 0.0)

            for step in range(3):
                idx = hour_index + step
                if 0 <= idx < total_hours:
                    hourly_precip[idx] += rain_3h / 3.0
                    hourly_wind[idx] = max(hourly_wind[idx], wind_kmh)

            day_key = point_time.date().isoformat()
            if day_key in daily_rain:
                daily_rain[day_key] += rain_3h
                daily_temp[day_key] = max(daily_temp[day_key], temp_max)
                daily_wind[day_key] = max(daily_wind[day_key], wind_kmh)

        seen_days = [day for day in days if daily_rain[day] > 0 or daily_temp[day] > 0 or daily_wind[day] > 0]
        if seen_days:
            avg_rain = float(np.mean([daily_rain[day] for day in seen_days]))
            avg_temp = float(np.mean([daily_temp[day] for day in seen_days]))
            avg_wind = float(np.mean([daily_wind[day] for day in seen_days]))
            for day in days:
                if day not in seen_days:
                    daily_rain[day] = max(0.0, avg_rain * 0.65)
                    daily_temp[day] = max(0.0, avg_temp)
                    daily_wind[day] = max(0.0, avg_wind * 0.9)

        return {
            "hourly": {
                "time": [(now_utc + timedelta(hours=idx)).isoformat() for idx in range(total_hours)],
                "precipitation": [round(v, 3) for v in hourly_precip],
                "wind_speed_10m": [round(v, 3) for v in hourly_wind],
            },
            "daily": {
                "time": days,
                "precipitation_sum": [round(daily_rain[day], 3) for day in days],
                "temperature_2m_max": [round(daily_temp[day], 3) for day in days],
                "wind_speed_10m_max": [round(daily_wind[day], 3) for day in days],
            },
            "_meta": {
                "live": True,
                "source": "openweather-forecast-fallback",
                "forecast_days": len(days),
            },
        }
    except Exception:
        return None


def openmeteo_sdk_to_payload(response) -> Dict:
    hourly = response.Hourly()
    daily = response.Daily()

    hourly_precip_values = np.nan_to_num(
        np.array(hourly.Variables(0).ValuesAsNumpy(), dtype=float),
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )
    hourly_wind_values = np.nan_to_num(
        np.array(hourly.Variables(1).ValuesAsNumpy(), dtype=float),
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )

    daily_precip_values = np.nan_to_num(
        np.array(daily.Variables(0).ValuesAsNumpy(), dtype=float),
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )
    daily_temp_values = np.nan_to_num(
        np.array(daily.Variables(1).ValuesAsNumpy(), dtype=float),
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )
    daily_wind_values = np.nan_to_num(
        np.array(daily.Variables(2).ValuesAsNumpy(), dtype=float),
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )

    hourly_start = pd.to_datetime(hourly.Time(), unit="s", utc=True)
    hourly_times = pd.date_range(
        start=hourly_start,
        periods=len(hourly_precip_values),
        freq=pd.Timedelta(seconds=int(hourly.Interval())),
    )

    daily_start = pd.to_datetime(daily.Time(), unit="s", utc=True)
    daily_times = pd.date_range(
        start=daily_start,
        periods=len(daily_precip_values),
        freq=pd.Timedelta(seconds=int(daily.Interval())),
    )

    return {
        "hourly": {
            "time": [ts.isoformat() for ts in hourly_times],
            "precipitation": [round(float(value), 3) for value in hourly_precip_values],
            "wind_speed_10m": [round(float(value), 3) for value in hourly_wind_values],
        },
        "daily": {
            "time": [ts.strftime("%Y-%m-%d") for ts in daily_times],
            "precipitation_sum": [round(float(value), 3) for value in daily_precip_values],
            "temperature_2m_max": [round(float(value), 3) for value in daily_temp_values],
            "wind_speed_10m_max": [round(float(value), 3) for value in daily_wind_values],
        },
    }


async def fetch_open_meteo(lat: float, lon: float) -> Dict:
    base_params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": ["precipitation", "wind_speed_10m"],
        "daily": ["precipitation_sum", "temperature_2m_max", "wind_speed_10m_max"],
        "timezone": "auto",
    }
    url = "https://api.open-meteo.com/v1/forecast"
    headers = {"User-Agent": "Flood-Spaces/1.0"}

    if openmeteo_client is not None:
        for attempt in range(3):
            for forecast_days in (MONTHLY_FORECAST_DAYS, 16, 7):
                params = {**base_params, "forecast_days": forecast_days}
                try:
                    responses = await asyncio.to_thread(openmeteo_client.weather_api, url, params=params)
                    if not responses:
                        continue
                    payload = openmeteo_sdk_to_payload(responses[0])
                    payload["_meta"] = {
                        "live": True,
                        "source": "open-meteo",
                        "forecast_days": len(payload.get("daily", {}).get("time", [])),
                    }
                    return payload
                except Exception:
                    continue
            await asyncio.sleep(0.4 * (attempt + 1))

    httpx_days = [MONTHLY_FORECAST_DAYS, 16, 7]
    for attempt in range(3):
        for forecast_days in httpx_days:
            params = {
                "latitude": lat,
                "longitude": lon,
                "hourly": "precipitation,wind_speed_10m",
                "daily": "precipitation_sum,temperature_2m_max,wind_speed_10m_max",
                "forecast_days": forecast_days,
                "timezone": "auto",
            }
            try:
                async with httpx.AsyncClient(timeout=12, headers=headers) as client:
                    response = await client.get(url, params=params)
                    response.raise_for_status()
                    payload = response.json()
                    payload["_meta"] = {
                        "live": True,
                        "source": "open-meteo",
                        "forecast_days": len(payload.get("daily", {}).get("time", [])),
                    }
                    return payload
            except Exception:
                continue
        await asyncio.sleep(0.5 * (attempt + 1))

    fallback = await fetch_openweather_forecast_payload(lat, lon)
    if fallback:
        return fallback
    return build_default_payload()


async def fetch_nasa_power_precip(lat: float, lon: float) -> Dict:
    today = datetime.now(timezone.utc).date()
    lookback_days = 15
    start_day = today - timedelta(days=lookback_days)
    params = {
        "parameters": "PRECTOTCORR",
        "community": "AG",
        "longitude": lon,
        "latitude": lat,
        "start": start_day.strftime("%Y%m%d"),
        "end": today.strftime("%Y%m%d"),
        "format": "JSON",
    }
    url = "https://power.larc.nasa.gov/api/temporal/daily/point"
    headers = {"User-Agent": "Flood-Spaces/1.0"}
    nasa_api_key = os.getenv("NASA_API_KEY", "").strip()
    if nasa_api_key:
        headers["X-Api-Key"] = nasa_api_key
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=12, headers=headers) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                data = response.json()

            precip = data.get("properties", {}).get("parameter", {}).get("PRECTOTCORR", {})
            valid_rows = []
            for day_key, value in sorted(precip.items()):
                if not isinstance(value, (int, float)):
                    continue
                numeric = float(value)
                if 0 <= numeric < 500:
                    valid_rows.append((day_key, numeric))

            if not valid_rows:
                return {
                    "value_mm": 0.0,
                    "live": False,
                    "source": "nasa-power",
                    "observed_day": None,
                    "reason": "no_valid_recent_observation",
                }

            trailing = [row[1] for row in valid_rows[-3:]]
            smoothed = sum(trailing) / len(trailing)
            return {
                "value_mm": round(smoothed, 2),
                "live": True,
                "source": "nasa-power",
                "observed_day": valid_rows[-1][0],
            }
        except Exception as exc:
            if attempt == 2:
                return {
                    "value_mm": 0.0,
                    "live": False,
                    "source": "nasa-power",
                    "observed_day": None,
                    "reason": safe_error_message(exc),
                }
            await asyncio.sleep(0.5 * (attempt + 1))

    return {
        "value_mm": 0.0,
        "live": False,
        "source": "nasa-power",
        "observed_day": None,
        "reason": "unknown_nasa_failure",
    }


async def fetch_open_meteo_river_discharge(lat: float, lon: float) -> Dict:
    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": "river_discharge_max",
        "forecast_days": 2,
        "timezone": "auto",
    }
    url = "https://flood-api.open-meteo.com/v1/flood"
    headers = {"User-Agent": "Flood-Spaces/1.0"}
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=10, headers=headers) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                data = response.json()

            values = data.get("daily", {}).get("river_discharge_max", [])
            if not values:
                return {
                    "value_m3s": 0.0,
                    "live": False,
                    "source": "open-meteo-flood",
                    "reason": "empty_response",
                }
            val = values[0]
            if val is None:
                return {
                    "value_m3s": 0.0,
                    "live": False,
                    "source": "open-meteo-flood",
                    "reason": "null_discharge",
                }
            return {
                "value_m3s": float(val),
                "live": True,
                "source": "open-meteo-flood",
            }
        except Exception as exc:
            if attempt == 2:
                return {
                    "value_m3s": 0.0,
                    "live": False,
                    "source": "open-meteo-flood",
                    "reason": safe_error_message(exc),
                }
            await asyncio.sleep(0.5 * (attempt + 1))

    return {
        "value_m3s": 0.0,
        "live": False,
        "source": "open-meteo-flood",
        "reason": "unknown_flood_api_failure",
    }


async def fetch_openweather_current(lat: float, lon: float) -> Dict:
    key = os.getenv("OPENWEATHER_API_KEY", "").strip()
    if not key:
        return {
            "value_c": None,
            "live": False,
            "source": "openweather-current",
            "reason": "missing_api_key",
        }

    params = {
        "lat": lat,
        "lon": lon,
        "appid": key,
        "units": "metric",
    }
    url = "https://api.openweathermap.org/data/2.5/weather"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
        temp = data.get("main", {}).get("temp")
        if not isinstance(temp, (int, float)):
            return {
                "value_c": None,
                "live": False,
                "source": "openweather-current",
                "reason": "temp_missing",
            }
        return {
            "value_c": float(temp),
            "live": True,
            "source": "openweather-current",
        }
    except Exception as exc:
        return {
            "value_c": None,
            "live": False,
            "source": "openweather-current",
            "reason": safe_error_message(exc),
        }


async def check_openrouter_status() -> Dict:
    result = await openrouter_chat_completion(
        [{"role": "user", "content": "Reply only with: OK"}],
        temperature=0.0,
        max_tokens=8,
    )
    return {
        "configured": bool(os.getenv("OPENROUTER_API_KEY", "").strip()),
        "live": bool(result.get("provider_live", False)),
        "provider": result.get("provider"),
        "model": result.get("provider_model"),
        "reason": result.get("provider_reason"),
    }


async def fetch_nasa_eonet_flood_events() -> List[Dict]:
    cache_key = "nasa-eonet-flood-events"
    cached = global_flood_cache.get(cache_key)
    if cached:
        age = datetime.now(timezone.utc).timestamp() - cached["ts"]
        if age < 900:
            return cached["data"]

    url = "https://eonet.gsfc.nasa.gov/api/v3/events"
    params = {
        "status": "open",
        "category": "floods",
        "limit": 120,
    }
    headers = {"User-Agent": "Flood-Spaces/1.0"}
    nasa_api_key = os.getenv("NASA_API_KEY", "").strip()
    if nasa_api_key:
        headers["X-Api-Key"] = nasa_api_key

    try:
        async with httpx.AsyncClient(timeout=10, headers=headers) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            payload = response.json()

        events = []
        for event in payload.get("events", []):
            title = str(event.get("title", "Flood Event")).strip() or "Flood Event"
            geometries = event.get("geometry", []) if isinstance(event.get("geometry", []), list) else []
            if not geometries:
                continue

            latest_geometry = geometries[-1] if isinstance(geometries[-1], dict) else None
            point = event_geometry_point(latest_geometry)
            if not point:
                continue

            lon, lat = point
            severity, risk_hint = classify_event_severity(title)
            sources = event.get("sources", []) if isinstance(event.get("sources", []), list) else []
            source_label = "NASA EONET"
            if sources and isinstance(sources[0], dict) and sources[0].get("id"):
                source_label = str(sources[0].get("id"))

            observed_at = ""
            if isinstance(latest_geometry, dict) and latest_geometry.get("date"):
                observed_at = str(latest_geometry.get("date"))
            if not observed_at:
                observed_at = datetime.now(timezone.utc).isoformat()

            events.append(
                {
                    "id": str(event.get("id", f"eonet-{len(events)}")),
                    "title": title,
                    "lat": round(lat, 4),
                    "lon": round(lon, 4),
                    "observed_at": observed_at,
                    "source": source_label,
                    "severity": severity,
                    "risk_hint": risk_hint,
                }
            )

        global_flood_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "data": events}
        return events
    except Exception:
        global_flood_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "data": []}
        return []


def normalize_event_timestamp(value: str | None) -> str:
    if not value:
        return datetime.now(timezone.utc).isoformat()

    raw = str(value).strip()
    if not raw:
        return datetime.now(timezone.utc).isoformat()

    try:
        parsed = parsedate_to_datetime(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()
    except Exception:
        pass

    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


async def fetch_gdacs_flood_events() -> List[Dict]:
    cache_key = "gdacs-flood-events"
    cached = global_flood_cache.get(cache_key)
    if cached:
        age = datetime.now(timezone.utc).timestamp() - cached["ts"]
        if age < 900:
            return cached["data"]

    url = "https://www.gdacs.org/xml/rss_fl_7d.xml"
    headers = {"User-Agent": "Flood-Spaces/1.0"}

    try:
        async with httpx.AsyncClient(timeout=12, headers=headers) as client:
            response = await client.get(url)
            response.raise_for_status()
            xml_payload = response.text

        root = ET.fromstring(xml_payload)
        events: List[Dict] = []
        for idx, item in enumerate(root.findall("./channel/item")):
            title = str(item.findtext("title", "GDACS Flood Event")).strip() or "GDACS Flood Event"
            guid = str(item.findtext("guid") or item.findtext("link") or f"gdacs-{idx}").strip()

            lat = None
            lon = None
            point_text = item.findtext("{http://www.georss.org/georss}point")
            if point_text:
                parts = point_text.strip().split()
                if len(parts) >= 2:
                    try:
                        lat = float(parts[0])
                        lon = float(parts[1])
                    except Exception:
                        lat = None
                        lon = None

            if lat is None or lon is None:
                lat_text = item.findtext("{http://www.w3.org/2003/01/geo/wgs84_pos#}lat")
                lon_text = item.findtext("{http://www.w3.org/2003/01/geo/wgs84_pos#}long") or item.findtext("{http://www.w3.org/2003/01/geo/wgs84_pos#}lon")
                try:
                    if lat_text and lon_text:
                        lat = float(lat_text)
                        lon = float(lon_text)
                except Exception:
                    lat = None
                    lon = None

            if lat is None or lon is None:
                continue

            lowered = title.lower()
            if "red" in lowered or "extreme" in lowered:
                severity = "emergency"
                risk_hint = 96
            elif "orange" in lowered or "high" in lowered:
                severity = "warning"
                risk_hint = 91
            elif "green" in lowered:
                severity = "watch"
                risk_hint = 85
            else:
                severity = "warning"
                risk_hint = 89

            observed_at = normalize_event_timestamp(item.findtext("pubDate"))
            events.append(
                {
                    "id": guid,
                    "title": title,
                    "lat": round(float(lat), 4),
                    "lon": round(float(lon), 4),
                    "observed_at": observed_at,
                    "source": "GDACS",
                    "severity": severity,
                    "risk_hint": risk_hint,
                }
            )

        global_flood_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "data": events}
        return events
    except Exception:
        global_flood_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "data": []}
        return []


def dedupe_global_events(events: List[Dict], max_items: int = 200) -> List[Dict]:
    seen = set()
    deduped: List[Dict] = []

    ordered = sorted(events, key=lambda event: str(event.get("observed_at", "")), reverse=True)
    for event in ordered:
        try:
            lat = round(float(event.get("lat", 0.0)), 2)
            lon = round(float(event.get("lon", 0.0)), 2)
        except Exception:
            continue

        title = str(event.get("title", "Flood Event")).strip() or "Flood Event"
        key = (lat, lon, title.lower()[:80])
        if key in seen:
            continue

        seen.add(key)
        deduped.append(
            {
                "id": str(event.get("id", f"event-{len(deduped)}")),
                "title": title,
                "lat": round(float(event.get("lat", 0.0)), 4),
                "lon": round(float(event.get("lon", 0.0)), 4),
                "observed_at": normalize_event_timestamp(str(event.get("observed_at", ""))),
                "source": str(event.get("source", "Live Flood Feed")),
                "severity": str(event.get("severity", "warning")),
                "risk_hint": int(float(event.get("risk_hint", 90))),
            }
        )

        if len(deduped) >= max_items:
            break

    return deduped


async def fetch_global_flood_events() -> List[Dict]:
    cache_key = "global-live-flood-events"
    cached = global_flood_cache.get(cache_key)
    if cached:
        age = datetime.now(timezone.utc).timestamp() - cached["ts"]
        if age < 600:
            return cached["data"]

    nasa_rows, gdacs_rows = await asyncio.gather(
        fetch_nasa_eonet_flood_events(),
        fetch_gdacs_flood_events(),
        return_exceptions=True,
    )

    nasa_events = nasa_rows if isinstance(nasa_rows, list) else []
    gdacs_events = gdacs_rows if isinstance(gdacs_rows, list) else []
    merged = dedupe_global_events([*nasa_events, *gdacs_events], max_items=220)

    global_flood_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "data": merged}
    return merged


async def reverse_geocode_name(lat: float, lon: float) -> str:
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {
        "lat": lat,
        "lon": lon,
        "format": "jsonv2",
        "zoom": 10,
        "addressdetails": 1,
    }
    headers = {"User-Agent": "Flood-Spaces/1.0"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(url, params=params, headers=headers)
            response.raise_for_status()
            data = response.json()
        address = data.get("address", {}) if isinstance(data, dict) else {}
        return format_place_label(address) if address else str(data.get("display_name", "Selected Area")).split(",")[0]
    except Exception:
        return "Selected Area"


async def geocode_nominatim(query: str, limit: int = 5, bd_only: bool = True) -> List[Dict]:
    url = "https://nominatim.openstreetmap.org/search"
    params = {
        "q": query,
        "format": "jsonv2",
        "limit": limit,
        "addressdetails": 1,
        "namedetails": 1,
    }
    if bd_only:
        params["countrycodes"] = "bd"

    headers = {
        "User-Agent": "Flood-Spaces/1.0",
        "Accept-Language": "bn,en",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(url, params=params, headers=headers)
            response.raise_for_status()
            data = response.json()
        results = []
        for item in data:
            if "lat" not in item or "lon" not in item:
                continue
            address = item.get("address", {}) if isinstance(item, dict) else {}
            namedetails = item.get("namedetails", {}) if isinstance(item, dict) else {}
            name_bn = namedetails.get("name:bn") or namedetails.get("official_name:bn")
            name_en = namedetails.get("name:en") or namedetails.get("official_name:en")
            results.append(
                {
                    "name": format_place_label(address) if address else item.get("display_name", "Unknown"),
                    "name_bn": name_bn,
                    "name_en": name_en,
                    "lat": float(item["lat"]),
                    "lon": float(item["lon"]),
                    "source": "nominatim",
                }
            )
        return dedupe_geocode_results(results)
    except Exception:
        return []


async def geocode_photon(query: str, limit: int = 5) -> List[Dict]:
    url = "https://photon.komoot.io/api/"
    params = {
        "q": query,
        "lang": "en",
        "limit": limit,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
        features = data.get("features", [])
        items = []
        for feature in features:
            geometry = feature.get("geometry", {})
            coords = geometry.get("coordinates", [])
            if len(coords) != 2:
                continue
            props = feature.get("properties", {})
            display_name = ", ".join(
                [part for part in [props.get("name"), props.get("city"), props.get("district"), props.get("state"), props.get("country")] if part]
            )
            items.append(
                {
                    "name": display_name or "Unknown",
                    "name_en": props.get("name") or display_name or "Unknown",
                    "name_bn": None,
                    "lat": float(coords[1]),
                    "lon": float(coords[0]),
                    "source": "photon",
                }
            )
        return dedupe_geocode_results(items)
    except Exception:
        return []


async def fetch_geo_boundaries(adm: str) -> Dict:
    cache_key = f"boundary-{adm}"
    cached = boundary_cache.get(cache_key)
    if cached:
        age = datetime.now(timezone.utc).timestamp() - cached["ts"]
        if age < 86400:
            return cached["data"]

    try:
        meta_url = f"https://www.geoboundaries.org/api/current/gbOpen/BGD/{adm}/"
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            meta_response = await client.get(meta_url)
            meta_response.raise_for_status()
            meta = meta_response.json()

            geo_url = meta.get("simplifiedGeometryGeoJSON") or meta.get("gjDownloadURL")
            if not geo_url:
                return empty_geojson()

            geo_response = await client.get(geo_url)
            geo_response.raise_for_status()
            geojson = geo_response.json()

        boundary_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "data": geojson}
        return geojson
    except Exception:
        return empty_geojson()


def summarize_forecast(
    name: str,
    lat: float,
    lon: float,
    payload: Dict,
    satellite_precip_mm: float,
    river_discharge: float,
    temperature_c: float | None,
    source_status: Dict | None = None,
) -> Dict:
    rain = payload.get("hourly", {}).get("precipitation", [])
    wind = payload.get("hourly", {}).get("wind_speed_10m", [])
    has_live_data = bool(payload.get("_meta", {}).get("live", False))
    source_status = source_status or {}

    if len(rain) < 24 or len(wind) < 6:
        payload = build_default_payload()
        rain = payload.get("hourly", {}).get("precipitation", [])
        wind = payload.get("hourly", {}).get("wind_speed_10m", [])
        has_live_data = False

    rain_1h = float(rain[0])
    rain_6h = float(sum(rain[:6]))
    rain_24h = float(sum(rain[:24]))
    max_wind_6h = float(max(wind[:6]))

    score = compute_risk_score(
        rain_1h,
        rain_6h,
        rain_24h,
        max_wind_6h,
        satellite_precip_mm,
        river_discharge,
        temperature_c,
    )
    level = risk_level(score)
    confidence_pct = compute_confidence(payload, source_status)
    satellite_anomaly = compute_satellite_water_anomaly(satellite_precip_mm, river_discharge)
    forecast_steps = generate_forecast_steps(payload, horizon_days=MONTHLY_FORECAST_DAYS)
    short_forecast_steps = forecast_steps[:SHORT_FORECAST_DAYS]

    return {
        "name": name,
        "lat": lat,
        "lon": lon,
        "rainfall_1h_mm": round(rain_1h, 2),
        "rainfall_6h_mm": round(rain_6h, 2),
        "rainfall_24h_mm": round(rain_24h, 2),
        "satellite_precip_mm": round(satellite_precip_mm, 2),
        "river_discharge_m3s": round(river_discharge, 2),
        "temperature_c": None if temperature_c is None else round(temperature_c, 1),
        "wind_kmh": round(max_wind_6h, 2),
        "risk_score": score,
        "risk_level": level,
        "confidence_pct": confidence_pct,
        "satellite_water_anomaly": satellite_anomaly,
        "forecast_steps": forecast_steps,
        "short_forecast_steps": short_forecast_steps,
        "has_live_data": has_live_data,
        "is_no_data": not has_live_data,
        "is_true_flood_signal": level == "flood",
        "data_sources": source_status,
    }


async def summarize_city(city: Dict[str, float]) -> Dict:
    payload_task = fetch_open_meteo(city["lat"], city["lon"])
    nasa_task = fetch_nasa_power_precip(city["lat"], city["lon"])
    river_task = fetch_open_meteo_river_discharge(city["lat"], city["lon"])
    weather_task = fetch_openweather_current(city["lat"], city["lon"])
    payload, nasa_meta, river_meta, weather_meta = await asyncio.gather(
        payload_task, nasa_task, river_task, weather_task
    )
    source_status = normalize_source_status(payload.get("_meta", {}), nasa_meta, river_meta, weather_meta)
    return summarize_forecast(
        city["name"],
        city["lat"],
        city["lon"],
        payload,
        float(nasa_meta.get("value_mm", 0.0)),
        float(river_meta.get("value_m3s", 0.0)),
        weather_meta.get("value_c"),
        source_status=source_status,
    )


@app.get("/api/health")
def health() -> Dict:
    return {"status": "ok", "project": "Flood Spaces"}


@app.get("/api/upstream-status")
async def upstream_status() -> Dict:
    cache_key = "upstream-status"
    cached = source_status_cache.get(cache_key)
    if cached:
        age = datetime.now(timezone.utc).timestamp() - cached["ts"]
        if age < 180:
            return cached["data"]

    sample = CITY_SEEDS[0]
    payload, nasa_meta, river_meta, ai_meta = await asyncio.gather(
        fetch_open_meteo(sample["lat"], sample["lon"]),
        fetch_nasa_power_precip(sample["lat"], sample["lon"]),
        fetch_open_meteo_river_discharge(sample["lat"], sample["lon"]),
        check_openrouter_status(),
    )

    payload_meta = payload.get("_meta", {})
    forecast_source = str(payload_meta.get("source", "default-no-data"))
    data = {
        "sample_area": sample["name"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "open_meteo": {
            "live": forecast_source == "open-meteo",
            "forecast_source": forecast_source,
        },
        "openweather_forecast_fallback": {
            "live": forecast_source == "openweather-forecast-fallback",
        },
        "nasa_power": {
            "live": bool(nasa_meta.get("live", False)),
            "value_mm": nasa_meta.get("value_mm", 0.0),
            "observed_day": nasa_meta.get("observed_day"),
            "reason": nasa_meta.get("reason"),
        },
        "open_meteo_flood": {
            "live": bool(river_meta.get("live", False)),
            "value_m3s": river_meta.get("value_m3s", 0.0),
            "reason": river_meta.get("reason"),
        },
        "openrouter": ai_meta,
        "forecast_pipeline_live": bool(payload_meta.get("live", False)) and bool(river_meta.get("live", False)),
        "core_data_live": bool(payload_meta.get("live", False)) and bool(nasa_meta.get("live", False)) and bool(river_meta.get("live", False)),
    }

    source_status_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "data": data}
    return data


@app.get("/api/risk-grid")
async def risk_grid() -> Dict:
    cache_key = "risk-grid"
    cached = grid_cache.get(cache_key)
    if cached:
        age = datetime.now(timezone.utc).timestamp() - cached["ts"]
        if age < cached.get("ttl", 600):
            return cached["data"]

    summaries = await asyncio.gather(*[summarize_city(city) for city in CITY_SEEDS], return_exceptions=True)
    results = []
    for city, summary in zip(CITY_SEEDS, summaries):
        if isinstance(summary, Exception):
            fallback_payload = build_default_payload()
            fallback_sources = {
                "forecast_live": False,
                "forecast_source": "default-no-data",
                "open_meteo_live": False,
                "openweather_forecast_fallback_live": False,
                "nasa_live": False,
                "nasa_observed_day": None,
                "river_live": False,
                "temp_live": False,
            }
            results.append(
                summarize_forecast(
                    city["name"],
                    city["lat"],
                    city["lon"],
                    fallback_payload,
                    0.0,
                    0.0,
                    None,
                    source_status=fallback_sources,
                )
            )
        else:
            results.append(summary)

    events = await fetch_global_flood_events()
    if events:
        results = [apply_flood_event_signal(item, events) for item in results]

    data = {
        "country_focus": "Bangladesh forecast focus",
        "source": ["Open-Meteo", "OpenWeather fallback", "Open-Meteo Flood", "NASA POWER", "NASA EONET Floods", "GDACS Floods"],
        "source_status": summarize_source_health(results),
        "active_flood_events_count": len(events),
        "active_flood_events_source": "NASA EONET + GDACS",
        "items": results,
    }
    live_count = sum(1 for item in results if item.get("has_live_data"))
    cache_ttl = 600 if live_count >= max(4, len(results) // 3) else 120
    grid_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "ttl": cache_ttl, "data": data}
    return data


@app.get("/api/location-risk")
async def location_risk(lat: float, lon: float, name: str = "Selected Area") -> Dict:
    cache_key = f"{round(lat, 3)}:{round(lon, 3)}"
    cached = location_cache.get(cache_key)
    if cached:
        age = datetime.now(timezone.utc).timestamp() - cached["ts"]
        if age < 300:
            return cached["data"]

    payload, nasa_meta, river_meta, weather_meta = await asyncio.gather(
        fetch_open_meteo(lat, lon),
        fetch_nasa_power_precip(lat, lon),
        fetch_open_meteo_river_discharge(lat, lon),
        fetch_openweather_current(lat, lon),
    )

    # Some coordinates have sparse river/satellite coverage; borrow nearest seed signal
    # instead of returning hard no-data for those two sources.
    if not bool(nasa_meta.get("live", False)) or not bool(river_meta.get("live", False)):
        seed = nearest_city_seed(lat, lon)
        if not bool(nasa_meta.get("live", False)):
            fallback_nasa = await fetch_nasa_power_precip(seed["lat"], seed["lon"])
            if bool(fallback_nasa.get("live", False)):
                nasa_meta = {
                    **fallback_nasa,
                    "source": f"{fallback_nasa.get('source', 'nasa-power')}-nearest-seed",
                }
        if not bool(river_meta.get("live", False)):
            fallback_river = await fetch_open_meteo_river_discharge(seed["lat"], seed["lon"])
            if bool(fallback_river.get("live", False)):
                river_meta = {
                    **fallback_river,
                    "source": f"{fallback_river.get('source', 'open-meteo-flood')}-nearest-seed",
                }

    source_status = normalize_source_status(payload.get("_meta", {}), nasa_meta, river_meta, weather_meta)
    area_name = name
    if not name or name == "Selected Area":
        area_name = await reverse_geocode_name(lat, lon)

    result = summarize_forecast(
        area_name,
        lat,
        lon,
        payload,
        float(nasa_meta.get("value_mm", 0.0)),
        float(river_meta.get("value_m3s", 0.0)),
        weather_meta.get("value_c"),
        source_status=source_status,
    )
    result["is_bd_focus"] = (
        BANGLADESH_BOUNDS["lat_min"] <= lat <= BANGLADESH_BOUNDS["lat_max"]
        and BANGLADESH_BOUNDS["lon_min"] <= lon <= BANGLADESH_BOUNDS["lon_max"]
    )

    if result["is_no_data"]:
        proxy = await summarize_city(nearest_city_seed(lat, lon))
        if proxy.get("is_no_data"):
            grid = await risk_grid()
            items = grid.get("items", [])
            if items:
                proxy = min(items, key=lambda item: haversine_km(lat, lon, float(item["lat"]), float(item["lon"])))
        proxy["name"] = area_name
        proxy["lat"] = lat
        proxy["lon"] = lon
        proxy["is_proxy_data"] = True
        proxy["is_bd_focus"] = result["is_bd_focus"]
        result = proxy

    events = await fetch_global_flood_events()
    if events:
        result = apply_flood_event_signal(result, events)

    location_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "data": result}
    return result


@app.get("/api/global-flood-events")
async def global_flood_events() -> Dict:
    events = await fetch_global_flood_events()
    sources = sorted({str(event.get("source", "Live Flood Feed")) for event in events})

    return {
        "source": sources or ["NASA EONET", "GDACS"],
        "status": "live" if events else "unavailable",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "items": events,
    }


@app.get("/api/geocode")
async def geocode(q: str) -> Dict:
    query = normalize_search_query(q)
    if not query:
        raise HTTPException(status_code=400, detail="Search query required")

    lowered = query.lower()

    bd_candidates = [query]
    if "bangladesh" not in lowered:
        bd_candidates.append(f"{query}, Bangladesh")

    bd_results: List[Dict] = []
    for candidate in bd_candidates:
        bd_results = await geocode_nominatim(candidate, limit=8, bd_only=True)
        if bd_results:
            break

    if bd_results:
        return {"items": bd_results}

    if not bd_results:
        for candidate in bd_candidates:
            bd_results = await geocode_nominatim(candidate, limit=8, bd_only=False)
            if bd_results:
                break

    if not bd_results:
        for candidate in bd_candidates:
            bd_results = await geocode_photon(candidate, limit=8)
            if bd_results:
                break

    return {"items": bd_results}


@app.get("/api/boundaries")
async def boundaries() -> Dict:
    country, districts, upazilas = await asyncio.gather(
        fetch_geo_boundaries("ADM0"),
        fetch_geo_boundaries("ADM2"),
        fetch_geo_boundaries("ADM3"),
    )
    return {
        "country": country,
        "districts": districts,
        "upazilas": upazilas,
    }


@app.get("/api/area-grid")
async def area_grid(center_lat: float, center_lon: float, radius_km: float = 25, step_km: float = 5) -> Dict:
    # Fast local grid for deeper map zoom and area-level details.
    radius_km = max(10, min(radius_km, 150))
    adaptive_step = 5 if radius_km <= 35 else 10 if radius_km <= 90 else 15
    step_km = max(5, min(step_km, adaptive_step))

    center_summary = await location_risk(center_lat, center_lon, name="Local Center")

    lat_step = step_km / 111.0
    lon_step = step_km / (111.0 * max(math.cos(math.radians(center_lat)), 0.2))

    points: List[Dict[str, float]] = []
    lat = center_lat - (radius_km / 111.0)
    while lat <= center_lat + (radius_km / 111.0):
        lon = center_lon - (radius_km / (111.0 * max(math.cos(math.radians(center_lat)), 0.2)))
        while lon <= center_lon + (radius_km / (111.0 * max(math.cos(math.radians(center_lat)), 0.2))):
            if haversine_km(center_lat, center_lon, lat, lon) <= radius_km:
                points.append({"lat": round(lat, 4), "lon": round(lon, 4)})
            lon += lon_step
        lat += lat_step

    max_points = 80 if radius_km <= 50 else 150 if radius_km <= 100 else 220
    if len(points) > max_points:
        points = points[:max_points]

    def calc_point(p: Dict[str, float]) -> Dict:
        distance = haversine_km(center_lat, center_lon, p["lat"], p["lon"])
        distance_factor = max(0.0, 1.0 - (distance / radius_km))
        localized_score = min(100.0, max(0.0, center_summary["risk_score"] * (0.78 + (0.22 * distance_factor))))
        localized_level = risk_level(localized_score)
        return {
            "name": f"Cell {p['lat']},{p['lon']}",
            "lat": p["lat"],
            "lon": p["lon"],
            "rainfall_1h_mm": round(center_summary["rainfall_1h_mm"] * (0.9 + distance_factor * 0.1), 2),
            "rainfall_6h_mm": round(center_summary["rainfall_6h_mm"] * (0.9 + distance_factor * 0.1), 2),
            "rainfall_24h_mm": round(center_summary["rainfall_24h_mm"] * (0.9 + distance_factor * 0.1), 2),
            "satellite_precip_mm": center_summary["satellite_precip_mm"],
            "river_discharge_m3s": center_summary["river_discharge_m3s"],
            "temperature_c": center_summary["temperature_c"],
            "wind_kmh": center_summary["wind_kmh"],
            "risk_score": round(localized_score, 1),
            "risk_level": localized_level,
            "confidence_pct": max(55, center_summary["confidence_pct"] - int(distance * 0.7)),
            "satellite_water_anomaly": center_summary["satellite_water_anomaly"],
            "forecast_steps": center_summary["forecast_steps"],
            "short_forecast_steps": center_summary.get("short_forecast_steps", center_summary["forecast_steps"][:SHORT_FORECAST_DAYS]),
            "has_live_data": center_summary["has_live_data"],
            "is_no_data": center_summary["is_no_data"],
            "is_true_flood_signal": localized_score >= 92,
        }

    items = [calc_point(p) for p in points]
    return {
        "center": {"lat": center_lat, "lon": center_lon},
        "radius_km": radius_km,
        "step_km": step_km,
        "items": items,
    }


def nearest_grid_item(lat: float, lon: float, items: List[Dict]) -> Dict | None:
    if not items:
        return None
    return min(items, key=lambda item: haversine_km(lat, lon, float(item["lat"]), float(item["lon"])))


@app.get("/api/bd-river-watch")
async def bd_river_watch() -> Dict:
    cache_key = "bd-river-watch"
    cached = river_watch_cache.get(cache_key)
    if cached:
        age = datetime.now(timezone.utc).timestamp() - cached["ts"]
        if age < 900:
            return cached["data"]

    grid = await risk_grid()
    items = grid.get("items", []) if isinstance(grid, dict) else []

    async def summarize_watch_point(point: Dict[str, float | str]) -> Dict:
        lat = float(point["lat"])
        lon = float(point["lon"])
        seed = nearest_grid_item(lat, lon, items)

        if seed is None:
            seed = await location_risk(lat, lon, name=str(point["name"]))

        river_meta = await fetch_open_meteo_river_discharge(lat, lon)
        river_live = bool(river_meta.get("live", False))
        river_value = float(river_meta.get("value_m3s", 0.0))
        river_bonus = min(max(river_value * 0.011, 0.0), 14.0) if river_live else 0.0
        distance = haversine_km(lat, lon, float(seed["lat"]), float(seed["lon"]))
        distance_penalty = min(distance * 0.22, 10.0)

        adjusted_score = round(min(100.0, max(0.0, float(seed["risk_score"]) + river_bonus - distance_penalty)), 1)
        adjusted_level = risk_level(adjusted_score)

        return {
            **seed,
            "name": str(point["name"]),
            "river_name": str(point["river_name"]),
            "lat": lat,
            "lon": lon,
            "risk_score": adjusted_score,
            "risk_level": adjusted_level,
            "river_discharge_m3s": round(river_value if river_live else float(seed.get("river_discharge_m3s", 0.0)), 2),
            "short_forecast_steps": seed.get("short_forecast_steps", seed.get("forecast_steps", [])[:SHORT_FORECAST_DAYS]),
            "is_true_flood_signal": adjusted_level == "flood" or adjusted_score >= 92,
            "is_river_watch": True,
            "distance_to_seed_km": round(distance, 1),
            "data_sources": {
                **seed.get("data_sources", {}),
                "river_live": river_live or bool(seed.get("data_sources", {}).get("river_live", False)),
            },
        }

    watch_rows = await asyncio.gather(*[summarize_watch_point(point) for point in RIVER_WATCH_POINTS], return_exceptions=True)
    river_items = [row for row in watch_rows if isinstance(row, dict)]
    river_items.sort(key=lambda row: float(row.get("risk_score", 0.0)), reverse=True)

    data = {
        "source": ["Open-Meteo", "Open-Meteo Flood", "NASA POWER", "OpenWeather"],
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "items": river_items,
    }
    river_watch_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "data": data}
    return data


@app.post("/api/alerts/subscribe")
def alerts_subscribe(body: TelegramSubscription) -> Dict:
    subscriptions.append(body)
    return {"ok": True, "total_subscriptions": len(subscriptions)}


async def send_telegram(chat_id: str, text: str) -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    if not token:
        return

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(url, json={"chat_id": chat_id, "text": text})


async def process_alert_checks() -> Dict:
    if not subscriptions:
        return {"ok": True, "alerts_sent": 0}

    grid = await risk_grid()
    sent = 0
    for sub in subscriptions:
        near_points = []
        for point in grid["items"]:
            distance = haversine_km(sub.lat, sub.lon, point["lat"], point["lon"])
            if distance <= sub.radius_km:
                near_points.append((distance, point))

        if not near_points:
            continue

        top = sorted(near_points, key=lambda x: x[1]["risk_score"], reverse=True)[0]
        point = top[1]
        if point["risk_score"] >= sub.threshold:
            message = (
                f"Flood Alert: {point['name']} risk is {point['risk_level'].upper()} ({point['risk_score']}/100).\n"
                f"Rain 24h: {point['rainfall_24h_mm']} mm | Wind: {point['wind_kmh']} km/h\n"
                f"Distance from your location: {round(top[0], 1)} km"
            )
            await send_telegram(sub.chat_id, message)
            sent += 1

    return {"ok": True, "alerts_sent": sent}


@app.post("/api/alerts/check")
async def alerts_check() -> Dict:
    return await process_alert_checks()


@app.on_event("startup")
async def startup_event() -> None:
    # Background checks keep alerts automatic without manual trigger.
    if not scheduler.running:
        scheduler.add_job(process_alert_checks, "interval", minutes=5)
        scheduler.start()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)


@app.post("/api/ai/summary")
async def ai_summary(body: AIRequest) -> Dict:
    forecast_preview = "; ".join(
        f"{step.get('time', 'day')}: {step.get('rain_mm', 0)}mm"
        for step in body.forecast_steps[:3]
        if isinstance(step, dict)
    )
    if not forecast_preview:
        forecast_preview = "No short-term forecast steps available"
    prompt = (
        "You are a flood safety expert for Bangladesh. Provide a professional risk briefing using NASA satellite data. "
        f"Area: {body.area_name}. Risk score: {body.risk_score}/100 (Confidence: {body.confidence_pct}%). "
        f"Rainfall 24h: {body.rainfall_24h_mm} mm | Wind: {body.wind_kmh} km/h | "
        f"River Discharge: {body.river_discharge_m3s} m³/s | NASA Satellite Water Anomaly: {body.satellite_water_anomaly:.0%}. "
        f"1 Month Forecast Outlook (first days preview): {forecast_preview}. "
        "Format response as: "
        "🚨 RISK REASON (why this area is at risk, satellite evidence?) "
        "✅ CONFIDENCE (data source reliability) "
        "🛑 IMMEDIATE ACTION (evacuation? shelter? leave area?) "
        "📍 SAFETY LEVEL (safe/vulnerable/dangerous)."
    )
    summary = await openrouter_chat_completion([{"role": "user", "content": prompt}], max_tokens=550)
    return {
        "summary": summary.get("text", "No summary returned."),
        "provider": summary.get("provider"),
        "provider_live": summary.get("provider_live", False),
        "provider_model": summary.get("provider_model"),
        "provider_reason": summary.get("provider_reason"),
    }


@app.post("/api/ai/chat")
async def ai_chat(body: AIChatRequest) -> Dict:
    user_messages = [message.model_dump() for message in body.messages if message.content.strip()]
    if not user_messages:
        raise HTTPException(status_code=400, detail="Chat message required")

    system_prompt = (
        "You are a concise flood intelligence assistant for Bangladesh. "
        "Answer clearly and practically. If the user asks about floods, weather, search, boundaries, alerts, or map usage, "
        "respond with actionable guidance. If the question is general, answer normally."
    )
    if body.area_name:
        system_prompt += f" Current area context: {body.area_name}."

    reply = await openrouter_chat_completion(
        [{"role": "system", "content": system_prompt}, *user_messages],
        temperature=0.4,
        max_tokens=450,
    )
    return {
        "reply": reply.get("text", "No reply returned."),
        "provider": reply.get("provider"),
        "provider_live": reply.get("provider_live", False),
        "provider_model": reply.get("provider_model"),
        "provider_reason": reply.get("provider_reason"),
    }
