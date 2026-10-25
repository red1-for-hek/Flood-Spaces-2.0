# Deployment guide — Vercel frontend + Render backend + Telegram alerts

## TL;DR

| Component | Host | Plan |
| --- | --- | --- |
| React dashboard | **Vercel** | Hobby (free) |
| FastAPI + alert scheduler + bot | **Render** web service | Starter ($7/mo) recommended, or Free + uptime pings |
| AI | **Groq** API | Free tier is generous |

**Vercel cannot host this backend for 24/7 alerts.** Serverless functions are killed after each request, so the APScheduler job that sweeps risk every 5 minutes never runs, and the JSON subscriber store is wiped. Keep Vercel for the frontend and move the API to a long-running host.

### Environment variables at a glance

**Backend — Render (or Railway / Fly), secrets, never on Vercel:**

```env
GROQ_API_KEY=gsk_...                    # AI chat (gpt-oss-20b)
TELEGRAM_BOT_TOKEN=123456:AA...         # from @BotFather
TELEGRAM_BOT_USERNAME=YourFloodBot      # used by the dashboard deep link
FRONTEND_ORIGIN=https://floodspaces.vercel.app
GROQ_MODEL=openai/gpt-oss-20b           # default, optional
GROQ_REASONING_EFFORT=low               # fastest replies, optional
TELEGRAM_STATE_PATH=/opt/render/project/src/backend/data/telegram_store.json
```

**Frontend — Vercel, Project Settings → Environment Variables:**

```env
VITE_API_BASE_URL=https://<your-service>.onrender.com
VITE_TELEGRAM_BOT_USERNAME=YourFloodBot
# optional: VITE_CARTO_KEY=<free carto key>
```

`VITE_*` values are compiled into the bundle — **redeploy after editing them**.


---

## 0) “Can I just keep the backend on Vercel?”

Short answer: **you can host the API there, but Vercel cannot deliver 24/7 alerts by itself.**

Why:

| Requirement | Vercel serverless | Long-running host |
| --- | --- | --- |
| 5-minute alert scheduler (APScheduler) | ❌ function dies after the request | ✅ stays alive |
| Telegram long-polling (`getUpdates`) | ❌ no background loop | ✅ |
| Subscriber persistence on disk | ❌ read-only FS (only `/tmp`, wiped on cold start) | ✅ disk/volume |
| Response time after idle | 🐢 cold start (3–10 s) for a 16-city forecast sweep | ⚡ warm |

### Temporary setup that *does* work on Vercel

If your backend is already deployed there, you can run in **webhook mode** and let an external
cron do the alert sweep:

1. Set these env vars on Vercel and redeploy:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_URL=https://<your-vercel-app>.vercel.app
TELEGRAM_WEBHOOK_SECRET=<random-string>
TELEGRAM_STATE_PATH=/tmp/telegram_store.json
CRON_SECRET=<random-string>
GROQ_API_KEY=...
```

2. Register the webhook (once):

```bash
curl -X POST https://<your-vercel-app>.vercel.app/api/telegram/setup-webhook
```

3. Add an external scheduler (cron-job.org, UptimeRobot, GitHub Actions) hitting this URL
   **every 5 minutes**:

```
GET https://<your-vercel-app>.vercel.app/api/cron/alerts?secret=<CRON_SECRET>
```

4. Press Start in the bot and confirm with **Send test alert** in the dashboard.

### What still breaks on Vercel

- **Subscribers vanish on cold start** because `/tmp` is per-instance. Users must re-press Start.
- **Alerts fire only when the cron hits** the function, and each hit pays a cold start.
- Free-plan function limits (invocations/duration) can throttle a 16-city forecast sweep.

So: keep Vercel for the **frontend**, move the backend to Render/Railway/Fly when you need
reliable alerting. `/api/cron/alerts` exists precisely so a temporary Vercel deployment can
still push alerts until you migrate.

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

### Free forever?

| Option | Cost | 24/7 alerts? | Subscribers survive restarts? |
| --- | --- | --- | --- |
| **Vercel serverless** | free | ❌ scheduler dies after each request | ❌ `/tmp` only |
| **Render Free + 5-min pinger** | free | ⚠️ only while pings keep it awake (UptimeRobot / cron-job.org) | ❌ no disk on free |
| **Render Starter + 1 GB disk** | ~$7/mo | ✅ | ✅ |
| **Oracle Cloud Always Free VM** | free | ✅ (self-managed docker) | ✅ (volume) |

For a free build: choose Render **Free**, delete the `disk:` block from `render.yaml`, set
`TELEGRAM_STATE_PATH` to the default (inside the app folder), and add a free UptimeRobot monitor
hitting `https://<your-service>.onrender.com/api/health` every 5 minutes. Alerts keep flowing while
the instance stays awake; subscribers are re-created only if Render restarts the instance — the bot
replies to `/start` so anyone can re-subscribe in one tap.

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
2. Root directory: `frontend` ← this matters; the repo root has no frontend app
3. Framework preset: **Vite** (auto-detected; `frontend/vercel.json` also sets it)
4. Environment variables (Settings → Environment Variables → Production **and** Preview):

| Name | Value | Required |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `https://<your-service>.onrender.com` (no trailing slash) | ✅ |
| `VITE_TELEGRAM_BOT_USERNAME` | `YourFloodBot` | optional |
| `VITE_CARTO_KEY` | free key from <https://carto.com/basemaps/apikey> | optional |
| `VITE_MAP_THEME` | `light` (default) or `dark` | optional |
| `VITE_MAP_TILES` | any raster template, e.g. OSM | optional |

> `VITE_*` variables are **build-time**. After adding or changing one you must redeploy
> (Deployments → ⋯ → Redeploy) — saving the variable alone changes nothing.
>
> Do **not** put `GROQ_API_KEY` or `TELEGRAM_BOT_TOKEN` in Vercel: they belong to the backend only.

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

## 6) Map basemap keys (why you saw “API KEY REQUIRED”)

CARTO added a key requirement to its public raster CDN on **25 September 2026**. Keyless requests
still return **HTTP 200**, but the PNG is stamped *“API KEY REQUIRED · carto.com/basemaps/apikey”*.
Because it is a 200, MapLibre raises no error, so no automatic fallback can fire.

The app is built for this:

- **Default (no env vars):** keyless **light** basemap — Esri World Light Gray + label layer, with an
  automatic switch to OpenStreetMap if Esri is unreachable. **No key needed.** Prefer the dark canvas?
  Set `VITE_MAP_THEME=dark`.
- **Optional CARTO look:** request the free key (5M tiles/month, no account) at
  <https://carto.com/basemaps/apikey> and set `VITE_CARTO_KEY=…` on Vercel, then redeploy.
- **Fully custom:** `VITE_MAP_TILES=https://…/{z}/{x}/{y}.png`, comma-separate multiple templates.

A CARTO URL configured **without** a key is detected and skipped, so the watermark cannot return.

```env
# optional — OSM only
VITE_MAP_TILES=https://tile.openstreetmap.org/{z}/{x}/{y}.png

# optional — CARTO Dark Matter with a free key
VITE_CARTO_KEY=your_key
```

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
