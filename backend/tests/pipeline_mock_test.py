"""End-to-end check of the batched risk pipeline against mock upstreams.

Verifies:
  * one Open-Meteo request covers all 16 cities (no fan-out)
  * all 16 zones come back live with non-zero rainfall
  * /api/upstream-status reports healthy sources
  * a second call is served from cache
  * when upstreams fail entirely, the last good snapshot is served (not zeros)
"""
import json
import os
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 8899
BASE = f"http://127.0.0.1:{PORT}"
state = {"forecast_calls": 0, "flood_calls": 0, "multi_calls": 0, "fail": False, "reject_multi": False, "forecast_down": False}


def forecast_row(days: int) -> dict:
    day = datetime.now(timezone.utc).date()
    return {
        "hourly": {
            "time": [f"{(day).isoformat()}T{h:02d}:00" for h in range(24)],
            "precipitation": [4.2] * 24,
            "wind_speed_10m": [22.0] * 24,
        },
        "daily": {
            "time": [(day + timedelta(days=i)).isoformat() for i in range(days)],
            "precipitation_sum": [38.0] * days,
            "temperature_2m_max": [31.0] * days,
            "wind_speed_10m_max": [24.0] * days,
        },
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _send(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if state["fail"]:
            self._send({"error": "upstream down"}, 503)
            return

        if parsed.path == "/forecast":
            state["forecast_calls"] += 1
            if state["forecast_down"]:
                self._send({"error": "service unavailable"}, 503)
                return
            lat = query.get("latitude", ["0"])[0]
            count = len(lat.split(","))
            if count > 1:
                state["multi_calls"] += 1
                if state["reject_multi"]:
                    # Simulates hosts/networks where multi-location is refused.
                    self._send({"error": "Too many locations"}, 400)
                    return
            days = int(query.get("forecast_days", ["16"])[0])
            rows = [forecast_row(days) for _ in range(count)]
            self._send(rows if count > 1 else rows[0])
            return

        if parsed.path == "/flood":
            state["flood_calls"] += 1
            lat = query.get("latitude", ["0"])[0]
            count = len(lat.split(","))
            if count > 1 and state["reject_multi"]:
                self._send({"error": "Too many locations"}, 400)
                return
            rows = [{"daily": {"river_discharge_max": [640.5, 610.0]}} for _ in range(count)]
            self._send(rows if count > 1 else rows[0])
            return

        if parsed.path == "/nasa":
            today = datetime.now(timezone.utc).date()
            keys = [(today - timedelta(days=i)).strftime("%Y%m%d") for i in range(5, -1, -1)]
            self._send(
                {
                    "properties": {
                        "parameter": {"PRECTOTCORR": {k: 12.5 for k in keys}}
                    }
                }
            )
            return

        if parsed.path == "/eonet":
            self._send({"events": []})
            return

        if parsed.path == "/gdacs":
            now = "Mon, 20 Oct 2026 10:00:00 GMT"
            xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:georss="http://www.georss.org/georss">
  <channel>
    <item>
      <title>Green flood in Bangladesh</title>
      <guid>gdacs-flood-1</guid>
      <pubDate>{now}</pubDate>
      <georss:point>23.8 90.4</georss:point>
    </item>
    <item>
      <title>Orange earthquake in Nepal</title>
      <guid>gdacs-quake-1</guid>
      <pubDate>{now}</pubDate>
      <georss:point>27.7 85.3</georss:point>
    </item>
  </channel>
</rss>"""
            body = xml.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path.startswith("/geoboundaries"):
            self._send({"type": "FeatureCollection", "features": []})
            return

        self._send({}, 404)


server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

os.environ.update(
    {
        "OPEN_METEO_FORECAST_URL": f"{BASE}/forecast",
        "OPEN_METEO_FLOOD_URL": f"{BASE}/flood",
        "NASA_POWER_URL": f"{BASE}/nasa",
        "NASA_EONET_URL": f"{BASE}/eonet",
        "GDACS_URL": f"{BASE}/gdacs",
        "RISK_SNAPSHOT_PATH": "/tmp/risk_snapshot_test.json",
        "TELEGRAM_STATE_PATH": "/tmp/telegram_test.json",
        "GROQ_API_KEY": "",
    }
)
if os.path.exists("/tmp/risk_snapshot_test.json"):
    os.remove("/tmp/risk_snapshot_test.json")

import sys

sys.path.insert(0, "backend")
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

checks = []
with TestClient(app) as client:
    grid = client.get("/api/risk-grid").json()
    live = sum(1 for item in grid["items"] if item.get("has_live_data"))
    rain = sum(item["rainfall_24h_mm"] for item in grid["items"])
    checks.append(("16 zones in grid", len(grid["items"]) == 16))
    checks.append((f"all zones live ({live}/16)", live == 16))
    checks.append((f"rainfall non-zero ({rain:.0f} mm)", rain > 0))
    # 16 cities / chunk size 8 -> 2 batched calls (not 16 fan-out calls).
    checks.append((f"forecast batched into 2 calls (got {state['forecast_calls']})", state["forecast_calls"] == 2))
    checks.append((f"river batched into 2 calls (got {state['flood_calls']})", state["flood_calls"] == 2))

    events = client.get("/api/global-flood-events").json()["items"]
    titles = [event["title"] for event in events]
    checks.append(("flood event kept", any("flood" in title.lower() for title in titles)))
    checks.append(("earthquake filtered out", not any("earthquake" in title.lower() for title in titles)))

    status = client.get("/api/upstream-status").json()
    checks.append(("status open_meteo live", status["open_meteo"]["live"] is True))
    checks.append(("status nasa live", status["nasa_power"]["live"] is True))
    checks.append(("status river live", status["open_meteo_flood"]["live"] is True))
    checks.append(("grid computed_at present", bool(status["grid"]["computed_at"])))
    checks.append(("grid not stale", status["grid"]["stale"] is False))

    before = state["forecast_calls"]
    client.get("/api/risk-grid")
    checks.append(("second call cached", state["forecast_calls"] == before))
    checks.append(("snapshot written", os.path.exists("/tmp/risk_snapshot_test.json")))

    # Multi-location calls rejected but single-point calls work: the per-city
    # rescue must still deliver a fully live grid (this is the Render symptom).
    import app.main as main_mod

    state["reject_multi"] = True
    state["multi_calls"] = 0
    main_mod.grid_cache.clear()
    main_mod.upstream_circuit.update({"open_meteo": 0.0, "river": 0.0, "nasa": 0.0})
    rescued = client.get("/api/risk-grid").json()
    rescued_live = sum(1 for item in rescued["items"] if item.get("has_live_data"))
    checks.append((f"multi-location rejection rescued ({rescued_live}/16)", rescued_live == 16))
    checks.append((f"rescue used multi-location first ({state['multi_calls']} attempts)", state["multi_calls"] >= 2))
    state["reject_multi"] = False

    # Open-Meteo and the river API are unreachable, but NASA still answers:
    # the grid must be built from satellite rainfall instead of zeros.
    state["fail"] = False
    state["reject_multi"] = True
    state["forecast_down"] = True
    main_mod.grid_cache.clear()
    main_mod.source_status_cache.clear()
    main_mod.upstream_circuit.update({"open_meteo": 0.0, "river": 0.0, "nasa": 0.0})
    nasa_only = client.get("/api/risk-grid").json()
    nasa_live = sum(1 for item in nasa_only["items"] if item.get("has_live_data"))
    rain_total = sum(item["rainfall_24h_mm"] for item in nasa_only["items"])
    checks.append((f"NASA satellite fallback keeps grid live ({nasa_live}/16)", nasa_live == 16))
    checks.append((f"NASA fallback produces real rainfall ({rain_total:.0f} mm)", rain_total > 0))
    status_fallback = client.get("/api/upstream-status").json()
    checks.append(("status reports satellite fallback", status_fallback["open_meteo"]["forecast_source"] == "nasa-power-fallback"))
    state["forecast_down"] = False
    state["reject_multi"] = False

    # Upstreams go dark -> snapshot must be served instead of zeros.
    state["fail"] = True
    main_mod.grid_cache.clear()
    main_mod.upstream_circuit.update({"open_meteo": 0.0, "river": 0.0, "nasa": 0.0})
    fallback = client.get("/api/risk-grid").json()
    fallback_live = sum(1 for item in fallback["items"] if item.get("has_live_data"))
    checks.append(("fallback serves snapshot", fallback_live == 16))
    checks.append(("fallback flagged stale", fallback.get("stale") is True))

server.shutdown()

failed = 0
for label, ok in checks:
    failed += 0 if ok else 1
    print(("PASS  " if ok else "FAIL  ") + label)
print(f"\n{'PIPELINE OK' if failed == 0 else 'PIPELINE FAILED'} ({failed} failed)")
sys.exit(0 if failed == 0 else 1)
