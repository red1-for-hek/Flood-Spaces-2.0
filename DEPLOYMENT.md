# Deployment guide — Vercel frontend + Render backend + Telegram alerts

## TL;DR

| Component | Host | Plan |
| --- | --- | --- |
| React dashboard | **Vercel** | Hobby (free) |
| FastAPI + alert scheduler + bot | **Render** web service | Starter ($7/mo) recommended, or Free + uptime pings |
| AI | **Groq** API | Free tier is generous |

**Vercel cannot host this backend for 24/7 alerts.** Serverless functions are killed after each request, so the APScheduler job that sweeps risk every 5 minutes never runs, and the JSON subscriber store is wiped. Keep Vercel for the frontend and move the API to a long-running host.

---

## 1) Prepare the repository

```bash
git push origin main
```

Files already included:

- `render.yaml` — backend blueprint with a persistent disk
- `backend/Dockerfile` — image for Railway / Fly / any container host
- `frontend/vercel.json` — SPA routing + asset caching

---

## 2) Deploy the backend (Render)

1. **Render Dashboard → New → Blueprint** and choose your fork of this repo.
2. Render reads `render.yaml`:
   - root directory `backend`
   - `pip install -r requirements.txt`
   - `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - health check `/api/health`
   - 1 GB disk mounted at `backend/data`
3. Fill in environment variables:

```
GROQ_API_KEY=gsk_...
GROQ_MODEL=openai/gpt-oss-20b
TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_BOT_USERNAME=YourFloodBot
FRONTEND_ORIGIN=https://your-frontend.vercel.app
TELEGRAM_STATE_PATH=/opt/render/project/src/backend/data/telegram_store.json
```

4. Deploy and open:

```
https://<your-service>.onrender.com/api/health
https://<your-service>.onrender.com/api/telegram/bot-info
```

`bot-info` should return `"configured": true` and the resolved `username`.

> Run a **single** uvicorn worker (the default). Multiple workers would each poll Telegram
> and duplicate alerts. If you scale out, switch to webhook mode and move state to a shared store.

### Why Starter, not Free?

Render's free web services sleep after ~15 minutes of inactivity. When asleep:

- the 5-minute alert scheduler stops,
- Telegram polling stops,
- alerts only resume after someone opens the API again.

If you must stay free: add a pinging monitor (e.g. UptimeRobot) every 5 minutes to `/api/health` **and** accept that Render may still restart the instance. For reliable disaster alerts, use the paid instance.

### Railway / Fly.io alternative

```bash
cd backend
docker build -t flood-spaces-api .
docker run -p 8004:8004 --env-file .env -v $(pwd)/data:/app/data flood-spaces-api
```

Mount a volume at `/app/data` so subscribers survive restarts.

---

## 3) Deploy the frontend (Vercel)

1. **Vercel → Add New Project → Import repo**
2. Root directory: `frontend`
3. Framework preset: **Vite** (auto-detected; `frontend/vercel.json` also sets it)
4. Environment variable:

```
VITE_API_BASE_URL=https://<your-service>.onrender.com
VITE_TELEGRAM_BOT_USERNAME=YourFloodBot
```

5. Deploy, then add the Vercel URL to the backend's `FRONTEND_ORIGIN` and redeploy the backend.

> CORS is permissive for `localhost` + GitHub Codespaces; add your production domain to `FRONTEND_ORIGIN` (comma separated for multiple origins).

---

## 4) Connect the Telegram bot

### Option A — polling (default, zero extra setup)

Leave `TELEGRAM_WEBHOOK_URL` empty. The backend long-polls Telegram every 5 seconds.

### Option B — webhook (lowest latency)

1. Set `TELEGRAM_WEBHOOK_URL=https://<your-service>.onrender.com`
2. Optionally set `TELEGRAM_WEBHOOK_SECRET` to a random string.
3. Restart the service, or call:

```bash
curl -X POST https://<your-service>.onrender.com/api/telegram/setup-webhook
```

The backend registers `POST /api/telegram/webhook` with Telegram automatically at startup when the env var is present.

### Verify auto-subscription

1. Open `https://t.me/<your_bot>` and press **Start**.
2. The bot replies “Automatic flood alerts are ON”.
3. Check subscribers:

```bash
curl https://<your-service>.onrender.com/api/telegram/bot-info
```

4. Send a test alert straight to that chat:

```bash
curl -X POST "https://<your-service>.onrender.com/api/alerts/test?chat_id=<chat_id>"
```

Or press **Send test alert** in the dashboard's Telegram card (it broadcasts to all subscribers).

Alerts respect the subscriber's radius and threshold, plus a 60-minute cooldown (`ALERT_COOLDOWN_MINUTES`) and only re-notify early when risk escalates.

---

## 5) Groq configuration

1. Create a key at <https://console.groq.com/keys>.
2. Set `GROQ_API_KEY` on the backend (never in the frontend).
3. Default model: `openai/gpt-oss-20b`, fallback `llama-3.1-8b-instant`.
4. Speed knobs:
   - `GROQ_REASONING_EFFORT=low`
   - `GROQ_FALLBACK_MODEL=llama-3.1-8b-instant`

Check it:

```bash
curl https://<your-service>.onrender.com/api/upstream-status
# -> "ai": { "configured": true, "live": true, "provider": "groq", "model": "openai/gpt-oss-20b" }
```

If `live` is `false`, read `reason`: `missing_groq_api_key`, `http_401`, `http_429`, etc. The UI gracefully falls back to local safety guidance.

---

## 6) Map keys

No map key is required. The dashboard uses CARTO dark raster tiles and falls back to OpenStreetMap automatically. If you prefer another free provider:

```
VITE_MAP_TILES=https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

Do not use MapTiler/Mapbox styles that require a key — those are what produced the “API key required” map error.

---

## 7) Operations checklist

- [ ] `/api/health` returns `ok`
- [ ] `/api/upstream-status` shows `forecast_pipeline_live: true`
- [ ] `/api/telegram/bot-info` shows `configured: true`
- [ ] Starting the bot sends the welcome message
- [ ] `POST /api/alerts/check` returns `{"ok": true, ...}`
- [ ] Subscribers persist after a backend restart (disk mounted)
- [ ] Vercel build succeeds with `npm run build`
- [ ] `FRONTEND_ORIGIN` contains the Vercel domain
