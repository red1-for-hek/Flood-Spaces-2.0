import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bell, Bot, Clock3, LocateFixed, RefreshCw, Search } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import MapPanel from "./components/MapPanel";
import {
  fetchAiSummary,
  fetchAreaGrid,
  fetchBoundaries,
  fetchLocationRisk,
  fetchRiskGrid,
  geocodePlace,
  runAlertCheck,
  subscribeTelegram
} from "./lib/api";
import type { RiskPoint } from "./types";

const bdEmergencyContacts = [
  { name: "National Emergency", value: "999" },
  { name: "Fire Service", value: "16163" },
  { name: "Disaster Hotline", value: "1090" }
];

function levelClass(level: RiskPoint["risk_level"]) {
  return `risk risk-${level}`;
}

function fallbackPoints(): RiskPoint[] {
  const baseSteps = Array.from({ length: 7 }).map((_, idx) => ({
    time: `Day ${idx + 1}`,
    rain_mm: 0,
    trend: 0
  }));
  return [
    {
      name: "Dhaka",
      lat: 23.8103,
      lon: 90.4125,
      rainfall_1h_mm: 0,
      rainfall_6h_mm: 0,
      rainfall_24h_mm: 0,
      satellite_precip_mm: 0,
      river_discharge_m3s: 0,
      temperature_c: null,
      wind_kmh: 0,
      risk_score: 0,
      risk_level: "low",
      confidence_pct: 0,
      satellite_water_anomaly: 0,
      forecast_steps: baseSteps,
      has_live_data: false,
      is_no_data: true,
      is_true_flood_signal: false
    }
  ];
}

export default function App() {
  const [points, setPoints] = useState<RiskPoint[]>([]);
  const [selected, setSelected] = useState<RiskPoint | null>(null);
  const [densePoints, setDensePoints] = useState<RiskPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aiSummary, setAiSummary] = useState("Select a zone to generate AI explanation.");
  const [mapMode, setMapMode] = useState<"risk" | "rain" | "wind">("risk");
  const [countryBoundary, setCountryBoundary] = useState<Record<string, unknown> | null>(null);
  const [districtBoundaries, setDistrictBoundaries] = useState<Record<string, unknown> | null>(null);

  const [chatId, setChatId] = useState("");
  const [threshold, setThreshold] = useState(70);
  const [radiusKm, setRadiusKm] = useState(100);
  const [alertStatus, setAlertStatus] = useState("");
  const [searchText, setSearchText] = useState("Dhaka, Bangladesh");
  const [searchStatus, setSearchStatus] = useState("");

  const forecastSeries = useMemo(() => {
    const src = selected || points[0];
    if (!src) {
      return [];
    }

    return src.forecast_steps.map((step) => ({
      t: step.time,
      risk: step.trend
    }));
  }, [points, selected]);

  async function loadGrid() {
    try {
      setLoading(true);
      const data = await fetchRiskGrid();
      setPoints(data.items);
      const initial = data.items[0] || null;
      setSelected((prev) => prev || initial);
      if (initial) {
        const local = await fetchAreaGrid(initial.lat, initial.lon, 20, 5);
        setDensePoints(local);
      }
      setError(null);
    } catch (err) {
      const fallback = fallbackPoints();
      setPoints(fallback);
      setSelected(fallback[0]);
      setDensePoints([]);
      setError(null);
      setSearchStatus("Live API unavailable. Showing no-data fallback.");
    } finally {
      setLoading(false);
    }
  }

  async function handleMapClick(lat: number, lon: number) {
    try {
      const [point, local] = await Promise.all([
        fetchLocationRisk(lat, lon),
        fetchAreaGrid(lat, lon, 20, 5)
      ]);
      setSelected(point);
      setDensePoints(local);
      setPoints((prev) => {
        const filtered = prev.filter((p) => !(Math.abs(p.lat - point.lat) < 0.0001 && Math.abs(p.lon - point.lon) < 0.0001));
        return [point, ...filtered].slice(0, 16);
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleUseMyLocation() {
    if (!navigator.geolocation) {
      setSearchStatus("Geolocation is not supported on this browser.");
      return;
    }
    setSearchStatus("Detecting your location...");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        await handleMapClick(pos.coords.latitude, pos.coords.longitude);
        setSearchStatus("Location loaded.");
      },
      () => setSearchStatus("Unable to detect your location."),
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0
      }
    );
  }

  async function handleSearch() {
    if (!searchText.trim()) {
      return;
    }
    try {
      setSearchStatus("Searching area...");
      const results = await geocodePlace(searchText);
      if (!results.length) {
        setSearchStatus("No results found.");
        return;
      }
      await handleMapClick(results[0].lat, results[0].lon);
      setSearchStatus(`Showing: ${results[0].name}`);
    } catch (err) {
      setSearchStatus((err as Error).message);
    }
  }

  useEffect(() => {
    loadGrid();
    const timer = setInterval(loadGrid, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    async function loadBoundaries() {
      try {
        const data = await fetchBoundaries();
        setCountryBoundary(data.country);
        setDistrictBoundaries(data.districts);
      } catch {
        setCountryBoundary(null);
        setDistrictBoundaries(null);
      }
    }

    loadBoundaries();
  }, []);

  async function handleSubscribe() {
    if (!selected) {
      setAlertStatus("Pick a location first.");
      return;
    }
    try {
      await subscribeTelegram({
        chat_id: chatId,
        lat: selected.lat,
        lon: selected.lon,
        threshold,
        radius_km: radiusKm
      });
      const check = await runAlertCheck();
      setAlertStatus(`Subscribed. Alerts sent now: ${check.alerts_sent}`);
    } catch (err) {
      setAlertStatus((err as Error).message);
    }
  }

  async function handleAiSummary() {
    if (!selected) {
      return;
    }
    setAiSummary("Generating AI flood explanation...");
    try {
      const summary = await fetchAiSummary(selected);
      setAiSummary(summary);
    } catch (err) {
      setAiSummary((err as Error).message);
    }
  }

  return (
    <div className="theme-light app">
      <header className="topbar compact-topbar">
        <div>
          <h1>Flood Spaces</h1>
          <p>Bangladesh flood intelligence with live map forecasting</p>
        </div>
        <div className="top-actions">
          <button onClick={loadGrid} className="icon-btn">
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
      </header>

      <section className="map-shell">
        <section className="map-wrap">
          {loading ? <div className="loading">Loading map data...</div> : null}
          {error ? <div className="error">{error}</div> : null}
          <div className="map-toolbar">
            <input
              className="input"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search any area"
            />
            <button className="icon-btn" onClick={handleSearch}>
              <Search size={16} /> Search
            </button>
            <button className="icon-btn" onClick={handleUseMyLocation}>
              <LocateFixed size={16} /> My Location
            </button>
            <div className="mode-switch">
              <button
                className={mapMode === "risk" ? "mode-btn active" : "mode-btn"}
                onClick={() => setMapMode("risk")}
              >
                Risk
              </button>
              <button
                className={mapMode === "rain" ? "mode-btn active" : "mode-btn"}
                onClick={() => setMapMode("rain")}
              >
                Rain
              </button>
              <button
                className={mapMode === "wind" ? "mode-btn active" : "mode-btn"}
                onClick={() => setMapMode("wind")}
              >
                Wind
              </button>
            </div>
          </div>
          {searchStatus ? <div className="map-status">{searchStatus}</div> : null}
          <MapPanel
            points={points}
            densePoints={densePoints}
            onSelect={setSelected}
            onMapClick={handleMapClick}
            selectedName={selected?.name || null}
            mode={mapMode}
            countryBoundary={countryBoundary}
            districtBoundaries={districtBoundaries}
          />
          <div className="legend">
            <span className="dot low" /> Low
            <span className="dot moderate" /> Moderate
            <span className="dot high" /> High
            <span className="dot severe" /> Severe
            <span className="dot flood" /> Flood
            <span className="dot no-data" /> No Data
            <span className="dot dense" /> 5km cells
          </div>
        </section>

        <aside className="side-panel">
          <div className="card">
            <h3>
              <AlertTriangle size={16} /> Selected Zone
            </h3>
            {selected ? (
              <>
                <p className="zone-name">{selected.name}</p>
                <p className={levelClass(selected.risk_level)}>
                  {selected.risk_level.toUpperCase()} - {selected.risk_score}/100
                </p>
                <p className="hint">Confidence: {selected.confidence_pct}%</p>
                <div className="stats-grid">
                  <div>
                    <label>Rain 1h</label>
                    <strong>{selected.rainfall_1h_mm} mm</strong>
                  </div>
                  <div>
                    <label>Rain 24h</label>
                    <strong>{selected.rainfall_24h_mm} mm</strong>
                  </div>
                  <div>
                    <label>Wind</label>
                    <strong>{selected.wind_kmh} km/h</strong>
                  </div>
                  <div>
                    <label>NASA Precip</label>
                    <strong>{selected.satellite_precip_mm} mm</strong>
                  </div>
                  <div>
                    <label>River Discharge</label>
                    <strong>{selected.river_discharge_m3s} m3/s</strong>
                  </div>
                  <div>
                    <label>Temperature</label>
                    <strong>{selected.temperature_c ?? "n/a"} C</strong>
                  </div>
                  <div>
                    <label>Satellite Anomaly</label>
                    <strong>{Math.round(selected.satellite_water_anomaly * 100)}%</strong>
                  </div>
                  <div>
                    <label>Signal</label>
                    <strong>{selected.is_true_flood_signal ? "Flood Dot" : "Watch"}</strong>
                  </div>
                </div>
              </>
            ) : (
              <p>Select a map marker.</p>
            )}
          </div>

          <div className="card">
            <h3>
              <Bell size={16} /> Telegram Alert
            </h3>
            <input
              className="input"
              placeholder="Telegram Chat ID"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
            />
            <label>Risk Threshold: {threshold}</label>
            <input type="range" min={30} max={95} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
            <label>Radius (km): {radiusKm}</label>
            <input type="range" min={20} max={200} value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))} />
            <button className="primary" onClick={handleSubscribe}>
              Activate Alerts
            </button>
            {alertStatus ? <p className="hint">{alertStatus}</p> : null}
          </div>

          <div className="card">
            <h3>
              <Bot size={16} /> AI Risk Brief
            </h3>
            <button className="primary" onClick={handleAiSummary}>
              Generate AI Summary
            </button>
            <pre className="ai-box">{aiSummary}</pre>
          </div>

          <div className="card">
            <h3>
              <Clock3 size={16} /> 7 Day Forecast
            </h3>
            {selected?.forecast_steps && selected.forecast_steps.length > 0 ? (
              <div className="forecast-timeline">
                {selected.forecast_steps.map((step, idx) => (
                  <div key={idx} className="forecast-step">
                    <div className="step-time">{step.time}</div>
                    <div className="step-bar">
                      <div
                        className="step-fill"
                        style={{ width: `${Math.min(step.trend, 100)}%` }}
                      />
                    </div>
                    <div className="step-rain">{step.rain_mm}mm</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">No forecast data available</p>
            )}
          </div>
        </aside>
      </section>

      <section className="bottom-strip">
        <div className="card chart-card">
          <h3>7 Day Risk Trend</h3>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={forecastSeries}>
                <defs>
                  <linearGradient id="riskGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ef4444" stopOpacity={0.8} />
                    <stop offset="100%" stopColor="#f97316" stopOpacity={0.1} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" />
                <YAxis domain={[0, 100]} />
                <Tooltip />
                <Area type="monotone" dataKey="risk" stroke="#ef4444" fill="url(#riskGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card emergency-card">
          <h3>Bangladesh Emergency Contacts</h3>
          {bdEmergencyContacts.map((c) => (
            <p key={c.name}>
              <strong>{c.name}:</strong> {c.value}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}
