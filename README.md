# Flood Spaces

Flood Spaces is a Bangladesh-focused real-time flood forecasting dashboard for academic demo use.

## Highlights
- Live map with risk-zone markers for 16 major Bangladesh regions (denser coverage)
- Click-anywhere risk inspection with reverse-geocoded area names and a highlighted focus ring
- My-location tracking with an accuracy radius overlay (Google Maps style approximate zone)
- 5km local dynamic risk cells around selected map areas
- Upazila, district, and country boundary overlays for Bangladesh
- Zoom-adaptive boundary detail: country (far), district (mid), upazila (close)
- Map mode switching (`Risk`, `Rain`, `Wind`) with clear indicator colors
- Risk levels with professional color indicators: low, moderate, high, severe, flood
- Hover details on map: rainfall, wind, river discharge, confidence, satellite anomaly indicators
- **NASA satellite water anomaly detection** for real-time flood accuracy
- **1-month forecast outlook** for Bangladesh forecast zones
- **3-day selected-area forecast panel** for quick local planning
- **Bangladesh river watch indicators** along major rivers (Surma, Kushiyara, Jamuna, Padma, Meghna, Brahmaputra, Teesta, Karnaphuli)
- Telegram alert subscription for nearby high-risk zones
- Automatic server-side alert checks every 5 minutes
- **Enhanced AI risk briefing** powered by OpenRouter with satellite evidence
- **General AI chat mode** beside area analysis for flood questions and map help
- Clean map-first light UI optimized for readability
- Bengali + English search support for place names, upazilas, and districts
- Emergency contact panel for Bangladesh

## Data Sources (free-first)
- Open-Meteo forecast API (no key) — hourly weather and precipitation
- Open-Meteo Flood API river discharge (no key) — real-time river water data
- NASA POWER precipitation (no key) — satellite-sensed precipitation from MODIS
- **NASA satellite water anomaly detection** — derived from extreme precipitation + discharge patterns
- **1-month forecast outlook** — generated from Open-Meteo daily forecast windows
- OpenStreetMap map tiles (no key, fair-use) — base map
- Nominatim geocoding/reverse geocoding (no key, fair-use) — place search
- Photon geocoding fallback (no key) — additional search resilience
- geoBoundaries API (no key) — upazila, district, and country boundaries
- OpenWeather current weather (optional key) — temperature blending
- OpenRouter (optional key) — AI risk analysis with satellite context
- Telegram Bot API (token required) — alert delivery

## Project Structure
- frontend: Vite + React + TypeScript dashboard
- backend: FastAPI risk engine and alert service

## Local Setup

### 1) Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
	uvicorn app.main:app --reload --port 8004
```

### 2) Frontend
```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173

## Environment Variables

### backend/.env
- TELEGRAM_BOT_TOKEN: token from BotFather
- OPENROUTER_API_KEY: optional key for AI summaries
- OPENROUTER_MODEL: OpenRouter model name, defaults to a free chat model
- OPENWEATHER_API_KEY: optional key for temperature blending
- ALERT_RADIUS_KM: default alert radius
- FRONTEND_ORIGIN: CORS origin, default http://localhost:5173

### frontend/.env
- VITE_API_BASE_URL: backend URL, default http://localhost:8004

## Telegram Quick Start
1. Create bot with BotFather and get token.
2. Start chat with your bot.
3. Get your chat id (from @userinfobot or Telegram API updates).
4. In web app, select a zone and input chat id.
5. Set threshold + radius and activate alerts.

## Deploy (Free) with Vercel + Backend Host
- Deploy frontend to Vercel.
- Deploy backend to a free Python host (for example Render/Railway free options when available).
- Set VITE_API_BASE_URL in Vercel to backend URL.
- Set backend env vars in backend host dashboard.

## Notes
- This project is an educational forecast assistant, not an official disaster warning system.
- Risk score is an explainable weighted model for demo purposes.
