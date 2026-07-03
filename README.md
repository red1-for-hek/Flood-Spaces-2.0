# 🌊 Flood Spaces 2.0

> **A real-time, Bangladesh-focused flood forecasting and alert platform** built with a modern full-stack architecture.

[![Live Demo](https://img.shields.io/badge/Live-Demo-00b894?style=for-the-badge&logo=vercel&logoColor=white)](https://floodspaces.vercel.app)
[![Backend](https://img.shields.io/badge/Backend-FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](backend)
[![Frontend](https://img.shields.io/badge/Frontend-React%20%2B%20TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](frontend)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=for-the-badge)](LICENSE)

Flood Spaces 2.0 is a **working flood prediction model** that can estimate flood risk across Bangladesh, visualize risk on an interactive map, and send automated alerts (Telegram) for potentially dangerous zones.

---

## ✨ Core Features

- 🗺️ **Interactive Bangladesh risk map** with flood-risk markers across major regions
- 📍 **Click-anywhere flood risk inspection** with reverse geocoded location name
- 🧭 **My-location tracking** with visualized accuracy radius
- 🧩 **Dynamic local risk cells** (5 km style local grid behavior)
- 🌐 **Administrative boundaries** (country / district / upazila overlays)
- 🔎 **Zoom-adaptive map detail** for better readability and context
- 🌧️ **Map mode switching**: `Risk`, `Rain`, `Wind`
- 🎨 **Color-coded severity levels**: low → flood
- 📊 **Hover diagnostics**: rainfall, wind, discharge, confidence, anomaly hints
- 🛰️ **Satellite anomaly-assisted scoring** for better flood awareness
- 📅 **1-month outlook** for forecast zones
- ⏱️ **3-day local forecast panel** for selected area planning
- 🏞️ **Bangladesh river watch indicators** for major rivers
- 🚨 **Telegram alert subscriptions** for high-risk nearby zones
- 🤖 **AI risk briefing mode** (OpenRouter-powered, optional)
- 💬 **General AI chat mode** for flood questions and map help
- 🌍 **Bengali + English place search** support
- ☎️ **Emergency contact panel** for quick access

---

## 🇧🇩 Why This Project Matters

Bangladesh is highly vulnerable to flood events. This project combines weather forecast, hydrological signals, and map-based UX into a single dashboard to support:

- rapid risk awareness,
- local-level interpretation,
- and early alert delivery.

> ⚠️ **Disclaimer:** This is an educational and research-grade forecasting assistant. It is **not** an official disaster-warning authority.

---

## 🧱 Tech Stack

### Frontend
- **React + TypeScript + Vite**
- CSS-based UI
- Interactive map rendering and overlays

### Backend
- **FastAPI (Python)**
- Flood risk engine + alert service
- Scheduled server-side alert checks (every 5 minutes)

---

## 📡 Data Sources

- **Open-Meteo Forecast API** — hourly weather/precipitation
- **Open-Meteo Flood API** — river discharge data
- **NASA POWER precipitation data** — satellite-informed precipitation context
- **Derived satellite anomaly signal** — used in risk interpretation
- **OpenStreetMap tiles** — map base layer
- **Nominatim + Photon** — geocoding and reverse geocoding
- **geoBoundaries** — Bangladesh admin boundary layers
- **OpenWeather** *(optional key)* — additional weather blending
- **OpenRouter** *(optional key)* — AI analysis/chat
- **Telegram Bot API** — alert delivery

---

## 📁 Project Structure

```text
Flood-Spaces-2.0/
├── backend/    # FastAPI service, risk logic, alert engine
├── frontend/   # React + TypeScript flood dashboard
└── README.md
```

---

## 🚀 Quick Start (Local Development)

### 1) Run Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate   # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8004
```

### 2) Run Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Open: **http://localhost:5173**

---

## 🔐 Environment Variables

### `backend/.env`

| Variable | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes (for alerts) | Telegram bot token from BotFather |
| `OPENROUTER_API_KEY` | Optional | Enables AI summaries/chat |
| `OPENROUTER_MODEL` | Optional | Model name for OpenRouter |
| `OPENWEATHER_API_KEY` | Optional | Additional weather blending |
| `ALERT_RADIUS_KM` | Optional | Default alert radius |
| `FRONTEND_ORIGIN` | Optional | CORS origin (e.g., `http://localhost:5173`) |

### `frontend/.env`

| Variable | Required | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | Yes | Backend base URL (e.g., `http://localhost:8004`) |

---

## 🤖 Telegram Alert Setup (Quick)

1. Create a bot with **@BotFather** and copy the token.
2. Start a conversation with your new bot.
3. Obtain your Telegram chat ID.
4. In the app, choose area + threshold + radius.
5. Activate subscription to receive high-risk alerts.

---

## ☁️ Deployment (Free-Friendly)

- Deploy **frontend** on **Vercel**.
- Deploy **backend** on a Python host (e.g., Render/Railway options as available).
- Set `VITE_API_BASE_URL` in frontend deployment.
- Configure backend env variables on server.

---

## 🧪 Model Philosophy

The risk engine uses an explainable weighted approach combining meteorological and hydrological signals. The objective is transparent, understandable risk scoring suitable for demonstration and practical educational use.

---

## 📄 License

Licensed under the **Apache-2.0 License**. See [LICENSE](LICENSE).

---

## 🙌 Contributing

Contributions, suggestions, and issue reports are welcome.
If you are working on flood resilience tools for Bangladesh, feel free to collaborate.
