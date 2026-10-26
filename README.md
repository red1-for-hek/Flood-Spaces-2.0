# 🌊 Flood Spaces 2.0

> **Real-time AI flood intelligence for Bangladesh** — live risk mapping, river watch, NASA/GDACS event feeds, a Groq-powered copilot and a Telegram bot that alerts every subscriber automatically.

[![Frontend](https://img.shields.io/badge/Frontend-React%20%2B%20TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](frontend)
[![Backend](https://img.shields.io/badge/Backend-FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](backend)
[![AI](https://img.shields.io/badge/AI-Groq%20%C2%B7%20gpt--oss--20b-f55036?style=for-the-badge&logo=openai&logoColor=white)](https://groq.com)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=for-the-badge)](LICENSE)

---

## ✨ What's inside

| Area | Highlights |
| --- | --- |
| 🗺️ **Risk map** | Keyless basemap, **country-wide hex grid (Flood Hub style)**, risk/rain/wind layers, district/upazila overlays, river-watch pins, live global flood events, click-anywhere inspection, **"Your location" marker** with GPS accuracy radius |
| 🧠 **AI copilot** | Groq `openai/gpt-oss-20b`, token-streamed chat with stop button, plus area briefings |
| 🚨 **Automatic Telegram alerts** | Anyone who presses **Start** is subscribed instantly — alerts are pushed with no dashboard open |
| 📊 **Dashboard UI** | KPI strip, risk gauge, confidence, 1-month outlook, river discharge, 7-day trend + weather |
| 🛰️ **Data pipeline** | Open-Meteo forecast & flood API (keyless, batched — 16 zones in 2 calls), NASA POWER precipitation (also the automatic fallback when Open-Meteo is unreachable), NASA EONET + GDACS flood-only events, OpenWeather fallback |
| 🌍 **Search** | English + Bengali place search, geolocation, reverse-geocoded names |

> ⚠️ Educational / research-grade forecasting assistant. **Not** an official disaster-warning authority.

---

## 🧱 Stack

- **Frontend:** React 18, TypeScript, Vite, MapLibre GL, Recharts, lucide-react
- **Backend:** FastAPI, APScheduler, httpx, numpy/pandas
- **AI:** Groq Chat Completions API — `openai/gpt-oss-20b` (fallback: `llama-3.1-8b-instant`)
- **Bot:** Telegram Bot API (auto-subscribe + automatic alert scheduler)

---

## 🚀 Local development

### 1) Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # add GROQ_API_KEY + TELEGRAM_BOT_TOKEN
uvicorn app.main:app --reload --port 8004
```

### 2) Frontend

```bash
cd frontend
npm install
cp .env.example .env               # VITE_API_BASE_URL=http://localhost:8004
npm run dev
```

Open **http://localhost:5173** (the dev server proxies `/api` to `http://127.0.0.1:8004`).

---

## 🔐 Environment variables

### `backend/.env`

| Variable | Required | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | **Yes** (for AI) | Groq API key from [console.groq.com](https://console.groq.com/keys) |
| `GROQ_MODEL` | Optional | Defaults to `openai/gpt-oss-20b` |
| `GROQ_FALLBACK_MODEL` | Optional | Defaults to `llama-3.1-8b-instant` |
| `GROQ_REASONING_EFFORT` | Optional | `low` (default), `medium`, `high` — low = fastest replies |
| `TELEGRAM_BOT_TOKEN` | **Yes** (for alerts) | Token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_BOT_USERNAME` | Optional | Shown in the dashboard deep-link button |
| `TELEGRAM_WEBHOOK_URL` | Optional | Public backend URL; switches bot to webhook mode |
| `TELEGRAM_WEBHOOK_SECRET` | Optional | Secret validated on the webhook endpoint |
| `TELEGRAM_STATE_PATH` | Optional | Where subscribers are persisted (default `backend/data/telegram_store.json`) |
| `ALERT_DEFAULT_THRESHOLD` | Optional | Default alert threshold (50) |
| `ALERT_RADIUS_KM` | Optional | Default alert radius (100) |
| `ALERT_CHECK_INTERVAL_MINUTES` | Optional | Scheduler cycle (5) |
| `ALERT_COOLDOWN_MINUTES` | Optional | Anti-spam window per chat (60) |
| `OPENWEATHER_API_KEY` | Optional | Temperature blending + forecast fallback |
| `NASA_API_KEY` | **Not needed** | NASA POWER and EONET are keyless. Setting it only raises EONET's rate limit |
| `FRONTEND_ORIGIN` | Optional | Comma-separated allowed origins |

### `frontend/.env`

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | Yes (prod) | Backend URL, e.g. `https://flood-spaces-api.onrender.com` |
| `VITE_TELEGRAM_BOT_USERNAME` | Optional | Bot username for the “Open bot” button |
| `VITE_MAP_TILES` | Optional | Custom raster tile template(s), comma-separated — keyless providers work out of the box |
| `VITE_CARTO_KEY` | Optional | Free CARTO basemap key — switches the basemap to CARTO Dark Matter |
| `VITE_MAP_THEME` | Optional | `light` (default) or `dark` for the keyless Esri canvas |

---

## 🤖 Telegram bot — automatic alerts for everyone

**Map controls:** the **Risk / Rain / Wind** tabs recolour the entire hex surface (and the legend) live; the **◎ My area** button asks the browser for GPS, drops a *“Your location”* pin with its accuracy radius and flies there. Zooming in refines the hexes down to 16 km cells across the whole country — the Google Flood Hub pattern.

The flow is intentionally zero-friction:

1. User opens your bot → presses **Start**.
2. Backend subscribes that chat automatically (`alerts_enabled = true`) and persists it.
3. User may share a location (or type a district) for local alerts — otherwise they get **nationwide Bangladesh** alerts.
4. Every 5 minutes the scheduler evaluates the risk grid and pushes an alert if a zone in range crosses the subscriber's threshold.
5. Alerts are de-duplicated with a cooldown window and only escalate when risk rises.

### Setup (10 minutes, once)

1. **@BotFather → `/newbot`** → pick a name and a username → copy the token (`123456:AA…`).
2. On the **backend host** (Render → Environment) set:

```env
TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_BOT_USERNAME=YourFloodBot     # without the @
GROQ_API_KEY=gsk_...                   # AI chat
FRONTEND_ORIGIN=https://floodspaces.vercel.app
```

3. Leave `TELEGRAM_WEBHOOK_URL` **empty on Render** — the bot long-polls Telegram every 5 s and needs no public webhook. (Vercel mode is different: see [DEPLOYMENT.md §0](DEPLOYMENT.md#0-can-i-just-keep-the-backend-on-vercel).)
4. Redeploy the service, then verify:

```bash
curl https://<your-api>/api/telegram/bot-info
# -> {"configured": true, "username": "YourFloodBot", "webhook_mode": false}
```

5. Open `https://t.me/YourFloodBot` → press **Start**. That *is* the subscription: the chat is stored automatically and starts receiving alerts. No dashboard visit, no chat-ID copy/paste.
6. Confirm delivery with **Send test alert** in the dashboard, or:

```bash
curl -X POST "https://<your-api>/api/alerts/test?chat_id=<chat_id>"
```

Only when you run the backend behind a public URL **with** `TELEGRAM_WEBHOOK_URL` set, register the webhook once:

```bash
curl -X POST https://<your-api>/api/telegram/setup-webhook
```

Bot commands: `/start`, `/stop`, `/help`, `/settings`, `/summary`.

Verify delivery any time with **Send test alert** in the dashboard, or:

```bash
curl -X POST "https://your-api.onrender.com/api/alerts/test?chat_id=123456789"
```

Manual linking is still possible from the dashboard via **Link a chat ID manually** (uses `/api/alerts/subscribe`).

### Persistence

Subscribers live in `backend/data/telegram_store.json`. On Render's **paid** plan you can mount a disk there so they survive restarts; on the **free** plan the filesystem is ephemeral, so a redeploy or restart clears the list and users re-press **Start**. Keeping the service awake with a 5-minute ping (below) avoids restarts while it runs.

---

## 🗺️ The map “API key required” watermark — explained

**Nothing is broken in your build.** CARTO changed its free raster basemap CDN: since **25 September 2026**, tile requests without a key return HTTP **200** with a watermark reading **“API KEY REQUIRED · carto.com/basemaps/apikey”**. A 200 response raises no MapLibre error, so the old automatic fallback could never notice it.

This build therefore **does not use CARTO by default**. It renders a genuinely keyless, quiet basemap (**Esri World Light Gray** + its label layer) so the risk colours are the only loud thing on screen, and switches to **OpenStreetMap** automatically if that provider is blocked. You need **no key at all** — not CARTO, MapTiler, Mapbox or Stadia.

Want the map dark instead of light? Set `VITE_MAP_THEME=dark` (uses the keyless Esri dark canvas).

Want CARTO's exact look back? Request the free key (5M tiles/month, no account) at <https://carto.com/basemaps/apikey>, then set on Vercel:

```env
VITE_CARTO_KEY=your_carto_key
```

The dashboard appends `?key=…` for you. Any custom template also works:

```env
VITE_MAP_TILES=https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}@2x.png?key=YOUR_KEY
```

If a CARTO URL is configured **without** a key, the app detects it, ignores it and keeps the keyless dark basemap — so the watermark cannot come back.

---

## 🎨 Themes

Dark is the default. The sun/moon button in the top bar switches to a light theme; the choice is
stored in `localStorage` (`fs.theme`) and applied before first paint via `data-theme` on `<html>`.
Both themes share one design-token set (`--bg`, `--panel`, `--text`, `--shell-glow-*`), so the map,
charts and cards stay legible in either mode.

## 🔎 Data pipeline diagnostics

`GET /api/upstream-status` now answers from the **grid that is on screen** (no extra upstream call),
so the KPI can never disagree with the map:

```json
{
  "open_meteo":   { "live": true,  "coverage_pct": 100 },
  "nasa_power":   { "live": true,  "coverage_pct": 100, "observed_day": "20261025" },
  "open_meteo_flood": { "live": true, "coverage_pct": 100 },
  "ai":           { "live": true,  "provider": "groq", "model": "openai/gpt-oss-20b" },
  "grid": {
    "zones": 16, "live_zones": 16,
    "compute_seconds": 1.9,
    "stale": false,
    "last_reason": null
  }
}
```

Healthy reports cache for 3 minutes; degraded ones for 15 seconds, so recovery is visible fast.

## ☁️ Deployment — the important bit

**Do not run this backend on Vercel.** Vercel functions are short-lived and stateless: the 5-minute scheduler dies between requests and subscribers disappear. Use:

| Piece | Host | Why |
| --- | --- | --- |
| Frontend | **Vercel** | Static Vite build, free, global CDN (config included in `frontend/vercel.json`) |
| Backend + bot scheduler | **Render (free Hobby plan, no card)** | Long-running process needed for 24/7 alerts; the free plan needs a 5-min ping |

> **Already on Vercel?** You can keep the API there in webhook mode with an external 5-minute
> cron hitting `/api/cron/alerts`, but subscribers are lost on cold starts. See
> [DEPLOYMENT.md → “Can I just keep the backend on Vercel?”](DEPLOYMENT.md#0-can-i-just-keep-the-backend-on-vercel).

### Vercel environment variables (frontend)

Project → **Settings → Environment Variables** (add to *Production* and *Preview*), then **Deployments → Redeploy**. `VITE_*` values are baked in at build time, so changing one only takes effect after a new build.

| Variable | Value | Required |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `https://flood-spaces-api.onrender.com` — your backend URL, no trailing slash | ✅ |
| `VITE_TELEGRAM_BOT_USERNAME` | `YourFloodBot` | optional |
| `VITE_CARTO_KEY` | free CARTO basemap key | optional |
| `VITE_MAP_TILES` | custom tile template | optional |

Project **Root Directory must be `frontend`**, Framework preset **Vite**, Build `npm run build`, Output `dist` (all set by `frontend/vercel.json`).

### Render (recommended, free, no card)

`render.yaml` deploys on the **free** plan — Render does **not** ask for a card on free. (If you saw a payment prompt, it was the old blueprint, which requested the $7 Starter plan and a disk. Delete that service and redeploy from the updated blueprint.)

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → select the repo. `render.yaml` is detected, cost shows **$0/month**.
3. Set secret env vars: `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `FRONTEND_ORIGIN=https://floodspaces.vercel.app`.
4. Copy the service URL, then on Vercel set `VITE_API_BASE_URL=https://your-service.onrender.com` and redeploy.
5. **Keep it awake (free):** create an UptimeRobot (or cron-job.org) monitor for `https://your-service.onrender.com/api/health` every **5 minutes**. Free Render services spin down after 15 idle minutes — the ping keeps the bot polling and the alert scheduler running around the clock.
6. Leave `TELEGRAM_WEBHOOK_URL` empty so the bot keeps long-polling (no extra setup).

> The free plan shares **750 instance-hours per workspace per month**. One service running 24/7 uses ~730, so keep only this one always-on; if you already run another always-on free service, pause it or move it elsewhere.

Full walkthrough: [DEPLOYMENT.md](DEPLOYMENT.md).

---

## 📡 API reference (short)

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness |
| `GET` | `/api/risk-grid` | Bangladesh risk grid |
| `GET` | `/api/location-risk?lat&lon` | Point risk inspection |
| `GET` | `/api/bd-river-watch` | River discharge watch |
| `GET` | `/api/global-flood-events` | NASA EONET + GDACS |
| `POST` | `/api/ai/summary` | Groq area briefing |
| `POST` | `/api/ai/chat` | Groq general chat |
| `POST` | `/api/ai/chat/stream` | Token-streamed Groq chat (used by the dashboard) |
| `POST` | `/api/alerts/subscribe` | Link a Telegram chat manually |
| `POST` | `/api/alerts/test` | Send a one-off test alert (optional `?chat_id=`) |
| `GET` | `/api/cron/alerts` | Cron-friendly alert sweep |
| `GET` | `/api/telegram/bot-info` | Bot status for the dashboard |
| `POST` | `/api/telegram/webhook` | Telegram webhook |
| `POST` | `/api/telegram/setup-webhook` | Register the webhook |

---

## 🩺 Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Toast: "A background request failed — … 'M_ID'" | A **third-party** script (preview harness / browser extension / analytics) rejects a promise. That identifier does not exist in this codebase or its bundle. | Harmless — dismiss it, or open the site in a clean tab. Errors are also stored in `window.__floodSpacesErrors` |
| Intro shows, then a blank page | WebGL blocked (sandboxed iframe, disabled GPU acceleration) — MapLibre used to throw and unmount React | Fixed: the map now detects WebGL2 and renders a *zone list* fallback; an error boundary + crash overlay keep the rest of the dashboard alive |
| "Map view unavailable" panel | Same WebGL limitation | Enable hardware acceleration / open outside the embedded frame, or keep using the zone list |
| Everything is `0/100`, `0 mm`, `0/4 live` | A **cold instance** was still warming its upstream feeds (common on free hosts with a fractional CPU) | Fixed: the grid is now built with **one batched Open-Meteo request** instead of 16 fan-out calls, retried at boot, cached to disk, and the dashboard retries every 8 s. `/api/upstream-status` → `grid.compute_seconds` shows the real cost |
| Pipeline says `3/4 live` | One feed is delayed. NASA POWER publishes with a lag; Groq is off without `GROQ_API_KEY` | Hover the KPI to see which feed is down; `3/4` now reads **Partial**, not Degraded. Only OpenWeather and Groq need keys — the rest are keyless |
| `Degraded` banner right after a deploy | First request hit a sleeping/spinning-up container | Wait ~30 s; the banner clears itself. `GET /api/upstream-status` shows `grid.last_reason` |
| Everything shows `n/a` / 0 mm | Backend can't reach Open-Meteo / NASA from its host | Check `/api/upstream-status`; the banner tells you when feeds are degraded |
| "Live backend unreachable" | `VITE_API_BASE_URL` missing or wrong | Set it to your Render URL and redeploy the frontend |
| Bot never replies | `TELEGRAM_BOT_TOKEN` missing | `/api/telegram/bot-info` shows `configured: false` until it is set |
| Preview/dev server dies after a while | Sandbox restarts (not an app bug) | Restart `npm run dev` + `uvicorn`; production hosts are unaffected |

Run all checks:

```bash
cd frontend
npm run typecheck && npm run smoke:all
```

## 🧪 Tests

```bash
cd frontend
npm run typecheck   # strict TS
npm run build       # production bundle
npm run smoke        # renders the app tree with mocked APIs
npm run smoke:nowebgl# same, with WebGL blocked (map fallback path)
npm run smoke:entry  # boots the real src/main.tsx (StrictMode + boundaries)
npm run smoke:crash  # injects a third-party rejection: toast, never a blank page
npm run smoke:all    # all three
```

## 🧪 Model philosophy

An explainable weighted blend of rainfall intensity, 24-hour accumulation, wind, NASA satellite precipitation proxy and river discharge. Risk is capped and calibrated to avoid over-reporting severe conditions in normal weather. Global flood events add a proximity-based boost.

---

## 📄 License

Apache-2.0 — see [LICENSE](LICENSE).

## 🙌 Credits

Built by **Redoyanul Haque** and **Debmalya Dutta Teertha**.
Data: Open-Meteo (no key) · NASA POWER / EONET (no key) · GDACS flood feed · OpenStreetMap · CARTO.

Google FloodHub has no keyless API — it needs a Google Maps Platform key with billing on it. The card-free equivalent used here is the Open-Meteo Flood API (river discharge) blended with NASA POWER rainfall.
