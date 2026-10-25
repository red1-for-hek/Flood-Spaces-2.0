# Project Guidelines

## Stack

- `frontend/` — React 18 + TypeScript + Vite, MapLibre GL (CARTO raster basemap, no API key), Recharts, lucide-react.
- `backend/` — FastAPI + APScheduler, httpx, numpy/pandas.
- AI — **Groq** chat completions (`openai/gpt-oss-20b`, configured by `GROQ_API_KEY` / `GROQ_MODEL`).
- Bot — Telegram Bot API with auto-subscribe on `/start` and an automatic 5-minute alert sweep.

## Build & run

```bash
# backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8004

# frontend
cd frontend
npm install
npm run dev        # proxies /api -> http://127.0.0.1:8004
npm run build      # tsc --noEmit && vite build
npm run typecheck
```

## Conventions

- Do not reintroduce OpenRouter. AI calls go through `groq_chat_completion`.
- Do not add keyed map providers (MapTiler/Mapbox). The map must work with zero API keys.
- Keep bot subscribers persisted through `save_telegram_state()`.
- Keep the UI dark-premium design tokens in `frontend/src/styles.css`; avoid ad-hoc colors.
- Frontend must never hardcode a backend host — use `VITE_API_BASE_URL` or same-origin `/api`.

## Deployment

Frontend on Vercel (`frontend/vercel.json`), backend as a long-running service on Render (`render.yaml`)
because the alert scheduler cannot live in serverless functions. See `DEPLOYMENT.md`.
