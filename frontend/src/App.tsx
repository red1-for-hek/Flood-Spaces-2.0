import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Bot,
  Clock3,
  CloudLightning,
  CloudRain,
  CloudSun,
  LocateFixed,
  RefreshCw,
  Search,
  Sun
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import MapPanel from "./components/MapPanel";
import LoadingScreen from "./components/LoadingScreen";
import {
  fetchAiChat,
  fetchAiSummary,
  fetchAreaGrid,
  fetchBdRiverWatch,
  fetchBoundaries,
  fetchGlobalFloodEvents,
  fetchLocationRisk,
  fetchRiskGrid,
  fetchUpstreamStatus,
  geocodePlace,
  runAlertCheck,
  subscribeTelegram
} from "./lib/api";
import type { GeocodeResult, GlobalFloodEvent, RiskPoint, UpstreamStatus } from "./types";

const bdEmergencyContacts = [
  { name: "National Emergency", value: "999" },
  { name: "Fire Service", value: "16163" },
  { name: "Disaster Hotline", value: "1090" }
];

function levelClass(level: RiskPoint["risk_level"]) {
  return `risk risk-${level}`;
}

function riskLabel(level: RiskPoint["risk_level"] | "low" | "moderate" | "high" | "severe") {
  return level === "low" ? "NORMAL" : level.toUpperCase();
}

function formatForecastLabel(time: string): string {
  const parsed = new Date(time);
  if (Number.isNaN(parsed.getTime())) {
    return time;
  }
  return parsed.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

function trendBand(trend: number): "low" | "moderate" | "high" | "severe" {
  if (trend < 30) {
    return "low";
  }
  if (trend < 55) {
    return "moderate";
  }
  if (trend < 75) {
    return "high";
  }
  return "severe";
}

function riskBandFromScore(score: number): "low" | "moderate" | "high" | "severe" {
  if (score < 45) {
    return "low";
  }
  if (score < 68) {
    return "moderate";
  }
  if (score < 84) {
    return "high";
  }
  return "severe";
}

function formatEventTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function weatherVisual(trend: number, windKmh: number): { label: string; tone: "clear" | "cloudy" | "rain" | "storm"; Icon: typeof Sun } {
  if (trend >= 80 || windKmh >= 55) {
    return { label: "Storm", tone: "storm", Icon: CloudLightning };
  }
  if (trend >= 55) {
    return { label: "Thunder", tone: "storm", Icon: CloudLightning };
  }
  if (trend >= 35) {
    return { label: "Rain", tone: "rain", Icon: CloudRain };
  }
  if (trend >= 18) {
    return { label: "Partly Cloudy", tone: "cloudy", Icon: CloudSun };
  }
  return { label: "Sunny", tone: "clear", Icon: Sun };
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
  const [aiMode, setAiMode] = useState<"analysis" | "chat">("analysis");
  const [chatMessages, setChatMessages] = useState<Array<{ role: "assistant" | "user"; content: string }>>([
    { role: "assistant", content: "Ask anything about flood risk, weather, search, alerts, or Bangladesh map usage." }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatStatus, setChatStatus] = useState("");
  const [countryBoundary, setCountryBoundary] = useState<Record<string, unknown> | null>(null);
  const [districtBoundaries, setDistrictBoundaries] = useState<Record<string, unknown> | null>(null);
  const [upazilaBoundaries, setUpazilaBoundaries] = useState<Record<string, unknown> | null>(null);
  const [locationAccuracyMeters, setLocationAccuracyMeters] = useState<number | null>(null);

  const [chatId, setChatId] = useState("");
  const [threshold, setThreshold] = useState(70);
  const [radiusKm, setRadiusKm] = useState(100);
  const [alertStatus, setAlertStatus] = useState("");
  const [searchText, setSearchText] = useState("Dhaka, Bangladesh");
  const [searchStatus, setSearchStatus] = useState("");
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [upstreamStatus, setUpstreamStatus] = useState<UpstreamStatus | null>(null);
  const [aiProviderStatus, setAiProviderStatus] = useState("");
  const [globalFloodEvents, setGlobalFloodEvents] = useState<GlobalFloodEvent[]>([]);
  const [globalFloodStatus, setGlobalFloodStatus] = useState<"live" | "unavailable" | "unknown">("unknown");
  const [riverWatchPoints, setRiverWatchPoints] = useState<RiskPoint[]>([]);

  const forecastHotspots = useMemo(() => {
    return points
      .map((point) => {
        const steps = point.forecast_steps || [];
        const sample = steps.slice(0, 10);
        const avgTrend = sample.length
          ? sample.reduce((sum, step) => sum + step.trend, 0) / sample.length
          : 0;
        const peakTrend = sample.length ? Math.max(...sample.map((step) => step.trend)) : 0;
        const monthSignal = Math.round(Math.max(point.risk_score, (avgTrend * 0.62) + (peakTrend * 0.38)));
        return {
          name: point.name,
          monthlySignal: monthSignal,
          monthlyLevel: riskBandFromScore(monthSignal),
          peakTime: sample.length ? sample[0].time : "N/A"
        };
      })
      .sort((a, b) => b.monthlySignal - a.monthlySignal)
      .slice(0, 10);
  }, [points]);

  const riverWatchTop = useMemo(() => {
    const bestByRiver = new Map<string, RiskPoint>();
    for (const point of riverWatchPoints) {
      const key = String(point.river_name || point.name || "Unknown River").trim().toLowerCase();
      const existing = bestByRiver.get(key);
      if (!existing || point.risk_score > existing.risk_score) {
        bestByRiver.set(key, point);
      }
    }

    return [...bestByRiver.values()]
      .sort((a, b) => b.risk_score - a.risk_score)
      .slice(0, 8);
  }, [riverWatchPoints]);

  const riverWatchScale = useMemo(() => {
    if (!riverWatchTop.length) {
      return { min: 0, max: 100 };
    }
    const scores = riverWatchTop.map((spot) => spot.risk_score);
    return {
      min: Math.min(...scores),
      max: Math.max(...scores)
    };
  }, [riverWatchTop]);

  const weatherForecast = useMemo(() => {
    const src = selected || points[0];
    if (!src) {
      return [];
    }
    const steps = src.forecast_steps.slice(0, 7);
    return steps.map((step) => ({
      ...step,
      temp_c: typeof step.temp_c === "number" ? step.temp_c : src.temperature_c,
      wind_kmh: typeof step.wind_kmh === "number" ? step.wind_kmh : src.wind_kmh,
      ...weatherVisual(step.trend, typeof step.wind_kmh === "number" ? step.wind_kmh : src.wind_kmh)
    }));
  }, [points, selected]);

  const forecastTrendData = useMemo(() => {
    const src = selected || points[0];
    if (!src) {
      return [];
    }

    const steps = src.short_forecast_steps?.length ? src.short_forecast_steps : src.forecast_steps.slice(0, 3);

    return steps.map((step) => ({
      label: formatForecastLabel(step.time),
      risk: Math.round(step.trend)
    }));
  }, [points, selected]);

  const liveFloodTop = useMemo(() => {
    const severityRank = { emergency: 3, warning: 2, watch: 1 } as const;
    return [...globalFloodEvents]
      .sort((a, b) => {
        const bySeverity = severityRank[b.severity] - severityRank[a.severity];
        if (bySeverity !== 0) {
          return bySeverity;
        }
        return String(b.observed_at).localeCompare(String(a.observed_at));
      })
      .slice(0, 8);
  }, [globalFloodEvents]);

  async function loadGrid() {
    try {
      setLoading(true);
      const [data, status, eventData, riverData] = await Promise.all([
        fetchRiskGrid(),
        fetchUpstreamStatus().catch(() => null),
        fetchGlobalFloodEvents().catch(() => null),
        fetchBdRiverWatch().catch(() => null)
      ]);
      const ranked = [...data.items].sort((a, b) => b.risk_score - a.risk_score);
      setPoints(ranked);
      const initial = ranked[0] || null;
      setSelected((prev) => prev || initial);
      if (status) {
        setUpstreamStatus(status);
      }
      setGlobalFloodEvents(eventData?.items || []);
      setGlobalFloodStatus(eventData?.status || (eventData?.items?.length ? "live" : "unknown"));
      setRiverWatchPoints(riverData?.items || []);
      if (initial) {
        const local = await fetchAreaGrid(initial.lat, initial.lon, 20, 5);
        setDensePoints(local);
      }
      setError(null);
      setSearchStatus((prev) => (prev.startsWith("Live API unavailable") ? "" : prev));
    } catch (err) {
      const fallback = fallbackPoints();
      setPoints(fallback);
      setSelected(fallback[0]);
      setDensePoints([]);
      setGlobalFloodEvents([]);
      setGlobalFloodStatus("unknown");
      setRiverWatchPoints([]);
      setError(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleMapClick(lat: number, lon: number, name?: string, accuracyMeters?: number) {
    try {
      const [point, local] = await Promise.all([
        fetchLocationRisk(lat, lon, name || "Selected Area"),
        fetchAreaGrid(lat, lon, 20, 5)
      ]);
      setSelected(point);
      setLocationAccuracyMeters(accuracyMeters ?? null);
      setDensePoints(local);
      setPoints((prev) => {
        const filtered = prev.filter((p) => !(Math.abs(p.lat - point.lat) < 0.0001 && Math.abs(p.lon - point.lon) < 0.0001));
        return [point, ...filtered].slice(0, 16);
      });
      return point;
    } catch (err) {
      setError((err as Error).message);
      return null;
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
        const accuracy = Number.isFinite(pos.coords.accuracy)
          ? Math.min(Math.max(pos.coords.accuracy, 30), 5000)
          : undefined;
        const point = await handleMapClick(pos.coords.latitude, pos.coords.longitude, undefined, accuracy);
        if (point) {
          setSearchText(point.name);
          setSearchStatus(`Location loaded: ${point.name} (±${Math.round(accuracy || 0)}m)`);
          setSearchResults([]);
        } else {
          setSearchStatus("Unable to detect a usable location.");
        }
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
        setSearchResults([]);
        return;
      }
      if (results.length === 1) {
        const point = await handleMapClick(results[0].lat, results[0].lon, results[0].name);
        if (point) {
          setSearchText(results[0].name);
          setSearchStatus(`Showing: ${results[0].name}`);
          setSearchResults([]);
        }
        return;
      }
      setSearchResults(results);
      setSearchStatus("Choose a result from the list.");
    } catch (err) {
      setSearchStatus((err as Error).message);
    }
  }

  async function handleSearchResultClick(result: GeocodeResult) {
    const point = await handleMapClick(result.lat, result.lon, result.name);
    if (point) {
      setSearchText(result.name);
      setSearchResults([]);
      setSearchStatus(`Showing: ${result.name}`);
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
        setUpazilaBoundaries(data.upazilas);
      } catch {
        setCountryBoundary(null);
        setDistrictBoundaries(null);
        setUpazilaBoundaries(null);
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
      setAiSummary(summary.summary);
      if (summary.provider_live) {
        setAiProviderStatus(`AI provider live (${summary.provider_model || summary.provider || "openrouter"})`);
      } else {
        setAiProviderStatus(`AI fallback active (${summary.provider_reason || "openrouter unavailable"})`);
      }
    } catch (err) {
      setAiSummary((err as Error).message);
      setAiProviderStatus("AI provider check failed.");
    }
  }

  async function handleChatSend() {
    const message = chatInput.trim();
    if (!message) {
      return;
    }

    const nextMessages = [...chatMessages, { role: "user" as const, content: message }];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatStatus("Thinking...");

    try {
      const reply = await fetchAiChat(nextMessages, selected?.name);
      setChatMessages((prev) => [...prev, { role: "assistant", content: reply.reply }]);
      if (reply.provider_live) {
        setAiProviderStatus(`AI provider live (${reply.provider_model || reply.provider || "openrouter"})`);
      } else {
        setAiProviderStatus(`AI fallback active (${reply.provider_reason || "openrouter unavailable"})`);
      }
      setChatStatus("");
    } catch (err) {
      setChatMessages((prev) => [...prev, { role: "assistant", content: (err as Error).message }]);
      setChatStatus("AI chat unavailable.");
      setAiProviderStatus("AI provider check failed.");
    }
  }

  if (loading && !points.length) {
    return <LoadingScreen />;
  }

  return (
    <div className="theme-light app">
      <header className="topbar compact-topbar">
        <div>
          <h1>Flood Spaces</h1>
          <p>Live global flood watch with Bangladesh-focused monthly forecasting</p>
        </div>
        <div className="top-actions">
          <button onClick={loadGrid} className="icon-btn">
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
      </header>

      <section className="map-section">
        <div className="map-wrap">
          <div className="map-controls">
            <div className="place-controls">
              <input
                className="input"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
                placeholder="Search a place in English or Bengali"
              />
              <button className="icon-btn" onClick={handleSearch}>
                <Search size={16} /> Search
              </button>
              <button className="icon-btn" onClick={handleUseMyLocation}>
                <LocateFixed size={16} /> My Location
              </button>
            </div>
          </div>
          {searchStatus ? <div className="map-status">{searchStatus}</div> : null}
          {searchResults.length ? (
            <div className="search-results">
              {searchResults.map((result) => (
                <button
                  key={`${result.lat}-${result.lon}-${result.name}`}
                  className="search-result"
                  onClick={() => handleSearchResultClick(result)}
                >
                  <span className="search-main">
                    <strong>{result.name_en || result.name}</strong>
                    {result.name_bn && result.name_bn !== result.name ? <small>{result.name_bn}</small> : null}
                  </span>
                  <span>{result.source || "search"}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="map-canvas-wrap">
            {loading ? <div className="loading">Loading map data...</div> : null}
            {error ? <div className="error">{error}</div> : null}
            <MapPanel
              points={points}
              densePoints={densePoints}
              riverWatchPoints={riverWatchPoints}
              onSelect={setSelected}
              onMapClick={handleMapClick}
              selectedName={selected?.name || null}
              highlightPoint={selected ? { lat: selected.lat, lon: selected.lon, name: selected.name } : null}
              highlightAccuracyMeters={locationAccuracyMeters}
              mode="risk"
              globalFloodEvents={globalFloodEvents}
              countryBoundary={countryBoundary}
              districtBoundaries={districtBoundaries}
              upazilaBoundaries={upazilaBoundaries}
            />
            <div className="legend">
              <span className="dot low" /> Normal
              <span className="dot moderate" /> Moderate
              <span className="dot high" /> High
              <span className="dot severe" /> Severe
              <span className="dot flood" /> Flood
              <span className="dot active-flood" /> Active Global Flood
              <span className="dot river-watch" /> River Watch
            </div>
          </div>
        </div>
      </section>

      <section className="cards-section">
        <div className="cards-grid">
          <div className="card">
            <h3>
              <RefreshCw size={16} /> Data Pipeline
            </h3>
            {upstreamStatus ? (
              <>
                <div className="stats-grid source-health-grid">
                  <div>
                    <label>Forecast API</label>
                    <strong>{upstreamStatus.open_meteo.live || upstreamStatus.openweather_forecast_fallback.live ? "LIVE" : "DOWN"}</strong>
                  </div>
                  <div>
                    <label>NASA</label>
                    <strong>{upstreamStatus.nasa_power.live ? "LIVE" : "DELAYED"}</strong>
                  </div>
                  <div>
                    <label>River API</label>
                    <strong>{upstreamStatus.open_meteo_flood.live ? "LIVE" : "DOWN"}</strong>
                  </div>
                  <div>
                    <label>OpenRouter</label>
                    <strong>{upstreamStatus.openrouter.live ? "LIVE" : "FALLBACK"}</strong>
                  </div>
                </div>
                <p className="hint">Sample check zone: {upstreamStatus.sample_area}</p>
                <p className="hint">
                  Active global flood events: {globalFloodEvents.length} ({globalFloodStatus === "live" ? "live" : "feed delayed"})
                </p>
              </>
            ) : (
              <p className="hint">Source status unavailable. Press refresh.</p>
            )}
            </div>

            <div className="card">
              <h3>
                <AlertTriangle size={16} /> Live Global Flood Locations
              </h3>
              {liveFloodTop.length ? (
                <div className="flood-event-list">
                  {liveFloodTop.map((event) => (
                    <div key={`${event.id}-${event.lat}-${event.lon}`} className="flood-event-item">
                      <strong>{event.title}</strong>
                      <span>{event.source} - {event.severity.toUpperCase()}</span>
                      <small>{formatEventTime(event.observed_at)}</small>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="hint">No live global flood event in feed right now.</p>
              )}
            </div>

            <div className="card">
            <h3>
              <Clock3 size={16} /> 1 Month Bangladesh Outlook
            </h3>
            {forecastHotspots.length ? (
              <div className="forecast-timeline">
                {forecastHotspots.map((spot) => (
                  <div key={spot.name} className="forecast-step">
                    <div className="step-time">{spot.name}</div>
                    <div className="step-bar">
                      <div className="step-fill" style={{ width: `${Math.max(14, Math.min(spot.monthlySignal, 100))}%` }} />
                    </div>
                    <div className="step-rain">{spot.monthlySignal}%</div>
                    <div className={`step-level ${spot.monthlyLevel}`}>
                      {riskLabel(spot.monthlyLevel)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">No forecast hotspots yet.</p>
            )}
            </div>

            <div className="card">
            <h3>
              <CloudRain size={16} /> Bangladesh River Watch
            </h3>
            {riverWatchTop.length ? (
              <div className="forecast-timeline river-watch-list">
                {riverWatchTop.map((spot) => (
                  <div key={`${spot.name}-${spot.lat}-${spot.lon}`} className="forecast-step">
                    <div className="step-time">
                      {spot.river_name || "River"}
                      <small>{spot.name}</small>
                    </div>
                    <div className="step-bar">
                      <div
                        className="step-fill"
                        style={{
                          width: `${Math.max(
                            14,
                            Math.min(
                              100,
                              Math.round(
                                (((spot.risk_score - riverWatchScale.min) / Math.max(1, riverWatchScale.max - riverWatchScale.min)) * 82) + 18
                              )
                            )
                          )}%`
                        }}
                      />
                    </div>
                    <div className="step-rain">{Math.round(spot.risk_score)}%</div>
                    <div className={`step-level ${riskBandFromScore(spot.risk_score)}`}>{riskLabel(riskBandFromScore(spot.risk_score))}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">River watch data is loading or temporarily unavailable.</p>
            )}
            </div>

            <div className="card span-2">
            <h3>
              <AlertTriangle size={16} /> Selected Zone
            </h3>
            {selected ? (
              <>
                <p className="zone-name">{selected.name}</p>
                <p className={levelClass(selected.risk_level)}>
                  {riskLabel(selected.risk_level)} - {selected.risk_score}/100
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
                {selected.data_sources ? (
                  <p className="hint">
                    Sources: Forecast={selected.data_sources.forecast_source} | NASA={selected.data_sources.nasa_live ? "live" : "delayed"} | River={selected.data_sources.river_live ? "live" : "down"}
                  </p>
                ) : null}
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

            <div className="card span-2">
            <h3>
              <Bot size={16} /> AI Risk Brief
            </h3>
            {aiProviderStatus ? <p className="hint">{aiProviderStatus}</p> : null}
            <div className="mode-switch ai-switch">
              <button className={aiMode === "analysis" ? "mode-btn active" : "mode-btn"} onClick={() => setAiMode("analysis")}>
                Area analysis
              </button>
              <button className={aiMode === "chat" ? "mode-btn active" : "mode-btn"} onClick={() => setAiMode("chat")}>
                General chat
              </button>
            </div>
            {aiMode === "analysis" ? (
              <>
                <button className="primary" onClick={handleAiSummary}>
                  Generate AI Summary
                </button>
                <pre className="ai-box">{aiSummary}</pre>
              </>
            ) : (
              <>
                <div className="chat-box">
                  {chatMessages.map((message, index) => (
                    <div key={`${message.role}-${index}`} className={message.role === "user" ? "chat-bubble user" : "chat-bubble assistant"}>
                      {message.content}
                    </div>
                  ))}
                </div>
                <textarea
                  className="input chat-input"
                  rows={4}
                  placeholder="Ask about floods, weather, map search, or anything else"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                />
                <button className="primary" onClick={handleChatSend}>
                  Send
                </button>
                {chatStatus ? <p className="hint">{chatStatus}</p> : null}
              </>
            )}
            </div>

            <div className="card span-2">
            <h3>
              <Clock3 size={16} /> 3 Day Flood Forecast (Selected Area)
            </h3>
            {selected?.forecast_steps && selected.forecast_steps.length > 0 ? (
              <div className="forecast-timeline">
                {(selected.short_forecast_steps?.length ? selected.short_forecast_steps : selected.forecast_steps.slice(0, 3)).map((step, idx) => (
                  <div key={idx} className="forecast-step">
                    <div className="step-time">{formatForecastLabel(step.time)}</div>
                    <div className="step-bar">
                      <div
                        className="step-fill"
                        style={{ width: `${Math.max(14, Math.min(step.trend, 100))}%` }}
                      />
                    </div>
                    <div className="step-rain">{Math.round(step.trend)}%</div>
                    <div className={`step-level ${trendBand(step.trend)}`}>{riskLabel(trendBand(step.trend))}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">No forecast data available</p>
            )}
          </div>
        </div>
      </section>

      <section className="bottom-strip">
        <div className="bottom-main">
          <div className="card chart-card">
            <h3>3 Day Risk Graph (Selected Area)</h3>
            {selected ? <p className="hint">{selected.name}</p> : null}
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={forecastTrendData} margin={{ top: 14, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15, 23, 42, 0.2)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} />
                  <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                  <Tooltip
                    formatter={(value: number) => [`${value}%`, "Risk trend"]}
                    labelFormatter={(label) => `Day: ${label}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="risk"
                    stroke="#dc2626"
                    strokeWidth={3}
                    dot={{ r: 3.5, fill: "#dc2626" }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card weather-card">
            <h3>
              <CloudSun size={16} /> 7 Day Weather & Rain Forecast (Selected Area)
            </h3>
            {selected ? <p className="hint">{selected.name}</p> : null}
            {weatherForecast.length ? (
              <div className="weather-grid">
                {weatherForecast.map((item, idx) => (
                  <div key={`${item.time}-${idx}`} className={`weather-item ${item.tone}`}>
                    <div className="weather-day">{formatForecastLabel(item.time)}</div>
                    <item.Icon size={18} className="weather-icon" />
                    <div className="weather-label">{item.label}</div>
                    <div className="weather-meta">
                      <div>{typeof item.temp_c === "number" ? `${Math.round(item.temp_c)} C` : "Temp n/a"}</div>
                      <div>{typeof item.wind_kmh === "number" ? `${Math.round(item.wind_kmh)} km/h` : "Wind n/a"}</div>
                      <div>{Math.round(item.rain_mm)} mm rain</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">Weather forecast currently unavailable.</p>
            )}
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
