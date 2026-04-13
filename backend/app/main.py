import math
import os
import asyncio
import re
from typing import Dict, List, Literal
from datetime import datetime, timedelta, timezone

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

app = FastAPI(title="Flood Spaces API", version="0.1.0")

frontend_origin = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_origin, "http://127.0.0.1:5173"],
    allow_credentials=True,
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


def empty_geojson() -> Dict:
    return {"type": "FeatureCollection", "features": []}


def build_default_payload() -> Dict:
    base_day = datetime.now(timezone.utc).date()
    days = [(base_day + timedelta(days=offset)).isoformat() for offset in range(7)]
    return {
        "hourly": {
            "time": [],
            "precipitation": [0.0] * 168,
            "wind_speed_10m": [0.0] * 168,
        },
        "daily": {
            "time": days,
            "precipitation_sum": [0.0] * 7,
            "temperature_2m_max": [0.0] * 7,
            "wind_speed_10m_max": [0.0] * 7,
        },
        "_meta": {"live": False},
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


def risk_level(score: float) -> str:
    if score < 30:
        return "low"
    if score < 55:
        return "moderate"
    if score < 75:
        return "high"
    if score < 90:
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
    # Explainable weighted model for quick demo deployment.
    heat_storm_bonus = 0.0
    if temperature_c is not None and temperature_c >= 30:
        heat_storm_bonus = 4.0

    score = (
        min(rain_1h * 6.0, 30)
        + min(rain_6h * 1.8, 25)
        + min(rain_24h * 0.7, 35)
        + min(max(wind_kmh - 15, 0) * 0.8, 10)
        + min(satellite_precip_mm * 0.9, 12)
        + min(river_discharge * 0.03, 12)
        + heat_storm_bonus
    )
    return round(min(score, 100), 1)


def compute_confidence(payload: Dict, satellite_precip_mm: float, river_discharge: float) -> int:
    rain = payload.get("hourly", {}).get("precipitation", [])
    wind = payload.get("hourly", {}).get("wind_speed_10m", [])
    checks = [
        len(rain) >= 24,
        len(wind) >= 24,
        satellite_precip_mm >= 0,
        river_discharge >= 0,
    ]
    return int(round((sum(1 for ok in checks if ok) / len(checks)) * 100))


def compute_satellite_water_anomaly(satellite_precip_mm: float, river_discharge: float) -> float:
    # NASA satellite (MODIS/POWER) water anomaly signal: extreme precip + high discharge = flooding.
    precip_signal = min(satellite_precip_mm / 50.0, 1.0) * 60
    discharge_signal = min(river_discharge / 2000.0, 1.0) * 40
    anomaly = (precip_signal + discharge_signal) / 100.0
    return round(min(anomaly, 1.0), 2)


def generate_forecast_steps(payload: Dict) -> List[Dict]:
    daily = payload.get("daily", {})
    dates = daily.get("time", [])
    rain = daily.get("precipitation_sum", [])
    temp = daily.get("temperature_2m_max", [])
    wind = daily.get("wind_speed_10m_max", [])
    steps = []
    if not dates:
        base_day = datetime.now(timezone.utc).date()
        dates = [(base_day + timedelta(days=offset)).isoformat() for offset in range(7)]

    for idx, label in enumerate(dates[:7]):
        rain_value = float(rain[idx]) if idx < len(rain) else 0.0
        wind_value = float(wind[idx]) if idx < len(wind) else 0.0
        temp_value = float(temp[idx]) if idx < len(temp) else 0.0
        trend = min(rain_value * 5.0 + max(wind_value - 20, 0) * 0.8 + max(temp_value - 30, 0) * 0.7, 100.0)
        steps.append(
            {
                "time": label,
                "rain_mm": round(rain_value, 2),
                "trend": round(trend, 1),
            }
        )
    return steps


async def openrouter_chat_completion(messages: List[Dict[str, str]], temperature: float = 0.2) -> str:
    key = os.getenv("OPENROUTER_API_KEY", "")
    if not key:
        return local_ai_fallback(messages)

    models = [
        os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.1-8b-instruct:free"),
        "qwen/qwen-2.5-7b-instruct:free",
        "google/gemma-2-9b-it:free",
    ]
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    last_error: Exception | None = None

    async with httpx.AsyncClient(timeout=20) as client:
        for model in dict.fromkeys(models):
            payload = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
            }
            try:
                response = await client.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
                return data.get("choices", [{}])[0].get("message", {}).get("content", "No summary returned.")
            except Exception as exc:
                last_error = exc

    if last_error is not None:
        return local_ai_fallback(messages)

    return local_ai_fallback(messages)


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
    days = [(now_utc.date() + timedelta(days=offset)).isoformat() for offset in range(7)]

    try:
        async with httpx.AsyncClient(timeout=12) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()

        hourly_precip = [0.0] * 168
        hourly_wind = [0.0] * 168
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
                if 0 <= idx < 168:
                    hourly_precip[idx] += rain_3h / 3.0
                    hourly_wind[idx] = max(hourly_wind[idx], wind_kmh)

            day_key = point_time.date().isoformat()
            if day_key in daily_rain:
                daily_rain[day_key] += rain_3h
                daily_temp[day_key] = max(daily_temp[day_key], temp_max)
                daily_wind[day_key] = max(daily_wind[day_key], wind_kmh)

        return {
            "hourly": {
                "time": [(now_utc + timedelta(hours=idx)).isoformat() for idx in range(168)],
                "precipitation": [round(v, 3) for v in hourly_precip],
                "wind_speed_10m": [round(v, 3) for v in hourly_wind],
            },
            "daily": {
                "time": days,
                "precipitation_sum": [round(daily_rain[day], 3) for day in days],
                "temperature_2m_max": [round(daily_temp[day], 3) for day in days],
                "wind_speed_10m_max": [round(daily_wind[day], 3) for day in days],
            },
            "_meta": {"live": True, "source": "openweather-forecast-fallback"},
        }
    except Exception:
        return None


async def fetch_open_meteo(lat: float, lon: float) -> Dict:
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "precipitation,wind_speed_10m",
        "daily": "precipitation_sum,temperature_2m_max,wind_speed_10m_max",
        "forecast_days": 7,
        "timezone": "auto",
    }
    url = "https://api.open-meteo.com/v1/forecast"
    headers = {"User-Agent": "Flood-Spaces/1.0"}
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=12, headers=headers) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                payload = response.json()
                payload["_meta"] = {"live": True}
                return payload
        except Exception:
            await asyncio.sleep(0.5 * (attempt + 1))

    fallback = await fetch_openweather_forecast_payload(lat, lon)
    if fallback:
        return fallback
    return build_default_payload()


async def fetch_nasa_power_precip(lat: float, lon: float) -> float:
    today = datetime.now(timezone.utc).date()
    yesterday = today - timedelta(days=1)
    params = {
        "parameters": "PRECTOTCORR",
        "community": "AG",
        "longitude": lon,
        "latitude": lat,
        "start": yesterday.strftime("%Y%m%d"),
        "end": today.strftime("%Y%m%d"),
        "format": "JSON",
    }
    url = "https://power.larc.nasa.gov/api/temporal/daily/point"
    headers = {"User-Agent": "Flood-Spaces/1.0"}
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=12, headers=headers) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                data = response.json()
            precip = data.get("properties", {}).get("parameter", {}).get("PRECTOTCORR", {})
            values = [v for v in precip.values() if isinstance(v, (int, float))]
            if not values:
                return 0.0
            value = float(values[-1])
            return value if value > 0 else 0.0
        except Exception:
            if attempt == 2:
                return 0.0
            await asyncio.sleep(0.5 * (attempt + 1))


async def fetch_open_meteo_river_discharge(lat: float, lon: float) -> float:
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
                return 0.0
            val = values[0]
            if val is None:
                return 0.0
            return float(val)
        except Exception:
            if attempt == 2:
                return 0.0
            await asyncio.sleep(0.5 * (attempt + 1))


async def fetch_openweather_current(lat: float, lon: float) -> float | None:
    key = os.getenv("OPENWEATHER_API_KEY", "")
    if not key:
        return None

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
        return float(data.get("main", {}).get("temp"))
    except Exception:
        return None


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
            country_name = str(props.get("country", "")).lower()
            if "bangladesh" not in display_name.lower() and props.get("countrycode", "").lower() != "bd" and "bangladesh" not in country_name:
                continue
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
) -> Dict:
    rain = payload.get("hourly", {}).get("precipitation", [])
    wind = payload.get("hourly", {}).get("wind_speed_10m", [])
    has_live_data = bool(payload.get("_meta", {}).get("live", False))

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
    confidence_pct = compute_confidence(payload, satellite_precip_mm, river_discharge)
    satellite_anomaly = compute_satellite_water_anomaly(satellite_precip_mm, river_discharge)
    forecast_steps = generate_forecast_steps(payload)

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
        "has_live_data": has_live_data,
        "is_no_data": not has_live_data,
        "is_true_flood_signal": level == "flood",
    }


async def summarize_city(city: Dict[str, float]) -> Dict:
    payload_task = fetch_open_meteo(city["lat"], city["lon"])
    nasa_task = fetch_nasa_power_precip(city["lat"], city["lon"])
    river_task = fetch_open_meteo_river_discharge(city["lat"], city["lon"])
    weather_task = fetch_openweather_current(city["lat"], city["lon"])
    payload, sat_precip, river_discharge, temperature_c = await asyncio.gather(
        payload_task, nasa_task, river_task, weather_task
    )
    return summarize_forecast(city["name"], city["lat"], city["lon"], payload, sat_precip, river_discharge, temperature_c)


@app.get("/api/health")
def health() -> Dict:
    return {"status": "ok", "project": "Flood Spaces"}


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
            results.append(
                summarize_forecast(city["name"], city["lat"], city["lon"], fallback_payload, 0.0, 0.0, None)
            )
        else:
            results.append(summary)

    data = {
        "country_focus": "Bangladesh",
        "source": ["Open-Meteo", "OpenWeather fallback", "Open-Meteo Flood", "NASA POWER"],
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

    payload, sat_precip, river_discharge, temperature_c = await asyncio.gather(
        fetch_open_meteo(lat, lon),
        fetch_nasa_power_precip(lat, lon),
        fetch_open_meteo_river_discharge(lat, lon),
        fetch_openweather_current(lat, lon),
    )
    area_name = name
    if not name or name == "Selected Area":
        area_name = await reverse_geocode_name(lat, lon)

    result = summarize_forecast(area_name, lat, lon, payload, sat_precip, river_discharge, temperature_c)
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

    location_cache[cache_key] = {"ts": datetime.now(timezone.utc).timestamp(), "data": result}
    return result


@app.get("/api/geocode")
async def geocode(q: str) -> Dict:
    query = normalize_search_query(q)
    if not query:
        raise HTTPException(status_code=400, detail="Search query required")

    queries = [query]
    if "bangladesh" not in query.lower():
        queries.append(f"{query}, Bangladesh")

    bd_results: List[Dict] = []
    for candidate in queries:
        bd_results = await geocode_nominatim(candidate, limit=8, bd_only=True)
        if bd_results:
            break

    if not bd_results:
        for candidate in queries:
            bd_results = await geocode_nominatim(candidate, limit=8, bd_only=False)
            if bd_results:
                break

    if not bd_results:
        for candidate in queries:
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
        localized_score = min(
            100.0,
            max(
                0.0,
                center_summary["risk_score"] - (distance * 1.9) + ((p["lat"] + p["lon"]) % 0.03) * 100,
            ),
        )
        localized_level = risk_level(localized_score)
        return {
            "name": f"Cell {p['lat']},{p['lon']}",
            "lat": p["lat"],
            "lon": p["lon"],
            "rainfall_1h_mm": round(center_summary["rainfall_1h_mm"] * (0.85 + (1 - distance_factor) * 0.25), 2),
            "rainfall_6h_mm": round(center_summary["rainfall_6h_mm"] * (0.88 + (1 - distance_factor) * 0.18), 2),
            "rainfall_24h_mm": round(center_summary["rainfall_24h_mm"] * (0.9 + (1 - distance_factor) * 0.12), 2),
            "satellite_precip_mm": center_summary["satellite_precip_mm"],
            "river_discharge_m3s": center_summary["river_discharge_m3s"],
            "temperature_c": center_summary["temperature_c"],
            "wind_kmh": center_summary["wind_kmh"],
            "risk_score": round(localized_score, 1),
            "risk_level": localized_level,
            "confidence_pct": max(50, center_summary["confidence_pct"] - int(distance * 1.3)),
            "satellite_water_anomaly": center_summary["satellite_water_anomaly"],
            "forecast_steps": center_summary["forecast_steps"],
            "has_live_data": center_summary["has_live_data"],
            "is_no_data": center_summary["is_no_data"],
            "is_true_flood_signal": localized_score >= 90,
        }

    items = [calc_point(p) for p in points]
    return {
        "center": {"lat": center_lat, "lon": center_lon},
        "radius_km": radius_km,
        "step_km": step_km,
        "items": items,
    }


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
    forecast_preview = "; ".join(f"{step['time']}: {step['rain_mm']}mm" for step in body.forecast_steps[:3])
    prompt = (
        "You are a flood safety expert for Bangladesh. Provide a professional risk briefing using NASA satellite data. "
        f"Area: {body.area_name}. Risk score: {body.risk_score}/100 (Confidence: {body.confidence_pct}%). "
        f"Rainfall 24h: {body.rainfall_24h_mm} mm | Wind: {body.wind_kmh} km/h | "
        f"River Discharge: {body.river_discharge_m3s} m³/s | NASA Satellite Water Anomaly: {body.satellite_water_anomaly:.0%}. "
        f"72h Forecast: {forecast_preview}. "
        "Format response as: "
        "🚨 RISK REASON (why this area is at risk, satellite evidence?) "
        "✅ CONFIDENCE (data source reliability) "
        "🛑 IMMEDIATE ACTION (evacuation? shelter? leave area?) "
        "📍 SAFETY LEVEL (safe/vulnerable/dangerous)."
    )
    summary = await openrouter_chat_completion([{ "role": "user", "content": prompt }])
    return {"summary": summary}


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
    )
    return {"reply": reply}
