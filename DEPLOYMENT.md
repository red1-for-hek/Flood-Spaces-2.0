# Deployment guide — Vercel frontend + Render backend + Telegram alerts

## TL;DR

| Component | Host | Plan |
| --- | --- | --- |
| React dashboard | **Vercel** | Hobby (free) |
| FastAPI + alert scheduler + bot | **Render** web service | **Free Hobby (no card)** + 5-min ping, or Starter ($7/mo) for a disk |
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

### Deploying the FastAPI backend as its own Vercel project

This is possible — Vercel now auto-detects FastAPI — but it is **degraded mode**, not a
replacement for a long-running host:

1. Vercel → **Add New → Project** → same repo → **Root Directory `backend`** → Framework **FastAPI**.
2. Env: `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
   `TELEGRAM_WEBHOOK_URL=https://<backend>.vercel.app`, `TELEGRAM_WEBHOOK_SECRET=<random>`,
   `TELEGRAM_STATE_PATH=/tmp/telegram_store.json`, `FRONTEND_ORIGIN=https://floodspaces.vercel.app`.
3. After deploy, register the webhook once: `POST https://<backend>.vercel.app/api/telegram/setup-webhook`.
4. Create a free cron on cron-job.org hitting
   `https://<backend>.vercel.app/api/cron/alerts?secret=<CRON_SECRET>` every 5 minutes.
5. Set `VITE_API_BASE_URL=https://<backend>.vercel.app` on the frontend project and redeploy.

What you lose: the in-process 5-minute scheduler (cron replaces it), Telegram long-polling (webhook
replaces it) and durable subscribers (`/tmp` resets on cold starts — users may need to press Start
again). Hobby plan function limits also apply to the 16-city forecast sweep.

---

## 1) Prepare the repository

```bash
git push origin main
```

Files already included:

- `render.yaml` — backend blueprint on the **free** plan (no card); comments show the paid upgrade for a persistent disk
- `backend/Dockerfile` — image for Railway / Fly / any container host
- `frontend/vercel.json` — SPA routing + asset caching

---

## 2) Deploy the backend (Render)

1. **Render Dashboard → New → Blueprint** and choose your fork of this repo.
   The blueprint requests `plan: free`, so the estimate is **$0/month** and Render asks for **no card**.
   If an older service from this repo is already on your account, delete it first — it was created with
   the paid Starter plan + disk.
2. Render reads `render.yaml`:
   - root directory `backend`
   - `pip install -r requirements.txt`
   - `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - health check `/api/health`
   - **Free** instance type — no payment method required
   - no disk on free (add one only after upgrading to Starter)
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

> **Build error `python-env.sh: line 38: …/Python-3.11.2/bin/python3.11: No such file or directory`?**
> The old blueprint pinned `PYTHON_VERSION=3.11.2`. Render only provisions a fixed set of Python
> builds, and that old patch is no longer among them, so the interpreter path never exists.
> The blueprint no longer sets `PYTHON_VERSION`; a `.python-version` file at the repo root asks for
> **3.13** (latest patch), and every dependency has manylinux wheels for it. If you prefer the env
> var, use a fully-qualified recent patch such as `3.13.5`.

> Run a **single** uvicorn worker (the default). Multiple workers would each poll Telegram
> and duplicate alerts. If you scale out, switch to webhook mode and move state to a shared store.

### Free forever?

| Option | Cost | 24/7 alerts? | Subscribers survive restarts? |
| --- | --- | --- | --- |
| **Vercel serverless** | free | ❌ scheduler dies after each request | ❌ `/tmp` only |
| **Render Free + 5-min pinger** | free | ⚠️ only while pings keep it awake (UptimeRobot / cron-job.org) | ❌ no disk on free |
| **Render Starter + 1 GB disk** | ~$7/mo | ✅ | ✅ |
| **Oracle Cloud Always Free VM** | free | ✅ (self-managed docker) | ✅ (volume) |

The checked-in `render.yaml` already does this: `plan: free`, no disk, and a free UptimeRobot
monitor on `https://<your-service>.onrender.com/api/health` every 5 minutes keeps the instance awake.
Alerts keep flowing while it stays awake; subscribers are re-created only if Render restarts the
instance — the bot replies to `/start` so anyone can re-subscribe in one tap.

**Watch the 750-hour pool.** Free workspaces get 750 instance-hours per month shared by every free
service. One always-on service uses ~730. If you already run a second always-on free service, the
workspace will exhaust its hours near month-end and Render suspends both until the 1st.

**Render still asking for a card?** That happens when the blueprint asks for a paid instance or a
disk. Make sure the service shows **Free** in its Settings → Instance Type, and that no `disk:` block
exists. If your account is genuinely gated, use the Vercel fallback below.

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
- [ ] UptimeRobot 5-min monitor on `/api/health` is green (keeps the free instance awake)
- [ ] (Paid + disk only) Subscribers persist after a backend restart
- [ ] Vercel build succeeds with `npm run build`
- [ ] `FRONTEND_ORIGIN` contains the Vercel domain
