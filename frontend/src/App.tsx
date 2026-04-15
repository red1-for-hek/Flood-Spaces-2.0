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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  { name: "National Emergency", value: "999", link: "tel:999" },
  { name: "Fire Service & Civil Defence", value: "16163", link: "tel:16163" },
  { name: "Disaster Management Hotline", value: "1090", link: "tel:1090" },
  { name: "Police Emergency", value: "100", link: "tel:100" },
  { name: "Ambulance Service", value: "199", link: "tel:199" },
  { name: "Bangladesh Meteorological Dept", value: "+880-2-8130305", link: "tel:+88028130305" },
  { name: "Flood Forecasting & Warning Centre", value: "+880-2-9552629", link: "tel:+88029552629" },
  { name: "Coast Guard Emergency", value: "01769-690690", link: "tel:01769690690" }
];

function levelClass(level: RiskPoint["risk_level"]) {
  return `risk risk-${level}`;
}

function riskLabel(level: RiskPoint["risk_level"] | "low" | "moderate" | "high" | "severe") {
  return level === "low" ? "NORMAL" : level.toUpperCase();
}

function formatForecastLabel(time: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(time)) {
    const [year, month, day] = time.split("-").map((value) => Number(value));
    const localDate = new Date(year, month - 1, day, 12, 0, 0, 0);
    return localDate.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  }

  const parsed = new Date(time);
  if (Number.isNaN(parsed.getTime())) {
    return time;
  }
  return parsed.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

function forecastIsoFromTodayOffset(offset: number): string {
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  base.setDate(base.getDate() + offset);
  return base.toISOString();
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
    {
      role: "assistant",
      content:
        "Ask anything you want: math, coding, writing, general knowledge, online-style research summaries, or Flood Spaces project data."
    }
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
    if (!selected) {
      return [];
    }
    
    const uniqueAreas = new Map<string, RiskPoint>();
    
    for (const point of points) {
      const key = point.name.toLowerCase();
      if (!key.includes("local") && !key.includes("cell") && !uniqueAreas.has(key)) {
        uniqueAreas.set(key, point);
      }
    }

    return Array.from(uniqueAreas.values())
      .map((point) => {
        return {
          name: point.name,
          monthlySignal: Math.round(point.risk_score),
          monthlyLevel: riskBandFromScore(point.risk_score),
          peakTime: "N/A"
        };
      })
      .sort((a, b) => b.monthlySignal - a.monthlySignal)
      .slice(0, 10);
  }, [points, selected]);

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
    return steps.map((step, idx) => {
      return {
        ...step,
        display_time: forecastIsoFromTodayOffset(idx),
        temp_c: typeof step.temp_c === "number" ? step.temp_c : src.temperature_c,
        wind_kmh: typeof step.wind_kmh === "number" ? step.wind_kmh : src.wind_kmh,
        ...weatherVisual(step.trend, typeof step.wind_kmh === "number" ? step.wind_kmh : src.wind_kmh)
      };
    });
  }, [points, selected]);

  const forecastTrendData = useMemo(() => {
    const src = selected || points[0];
    if (!src) {
      return [];
    }

    const steps = src.forecast_steps.slice(0, 7);

    return steps.map((step, idx) => {
      return {
        label: formatForecastLabel(forecastIsoFromTodayOffset(idx)),
        risk: Math.round(step.trend)
      };
    });
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

  const liveFloodLastSeen = useMemo(() => {
    const parsedTimes = globalFloodEvents
      .map((event) => Date.parse(event.observed_at))
      .filter((value) => Number.isFinite(value));

    if (!parsedTimes.length) {
      return null;
    }

    return new Date(Math.max(...parsedTimes)).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
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
      setSelected((prev) => {
        if (!prev) {
          return initial;
        }

        const match = ranked.find(
          (point) =>
            point.name.toLowerCase() === prev.name.toLowerCase() ||
            (Math.abs(point.lat - prev.lat) < 0.03 && Math.abs(point.lon - prev.lon) < 0.03)
        );

        return match || prev;
      });
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
      const actualName = name && !name.includes("Local") && !name.includes("Cell") ? name : undefined;
      const [point, local] = await Promise.all([
        fetchLocationRisk(lat, lon, actualName || "Selected Area"),
        fetchAreaGrid(lat, lon, 20, 5)
      ]);
      setSelected(point);
      setLocationAccuracyMeters(accuracyMeters ?? null);
      setDensePoints(local.filter((p: RiskPoint) => !p.name.includes("Cell") && !p.name.includes("Local")));
      setPoints((prev) => {
        const filtered = prev.filter((p) => 
          !(Math.abs(p.lat - point.lat) < 0.0001 && Math.abs(p.lon - point.lon) < 0.0001) &&
          !p.name.includes("Cell") &&
          !p.name.includes("Local")
        );
        const uniqueNames = new Set(filtered.map(p => p.name.toLowerCase()));
        if (!uniqueNames.has(point.name.toLowerCase())) {
          return [point, ...filtered].slice(0, 16);
        }
        return filtered;
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
          setSearchStatus(`📍 ${point.name} (±${Math.round(accuracy || 0)}m accuracy)`);
          setSearchResults([]);
          
          const nearest = points.reduce((prev, curr) => {
            const prevDist = Math.abs(prev.lat - pos.coords.latitude) + Math.abs(prev.lon - pos.coords.longitude);
            const currDist = Math.abs(curr.lat - pos.coords.latitude) + Math.abs(curr.lon - pos.coords.longitude);
            return currDist < prevDist ? curr : prev;
          }, points[0]);
          
          if (nearest) {
            setSelected(nearest);
          }
        } else {
          setSearchStatus("Unable to detect a usable location.");
        }
      },
      () => setSearchStatus("❌ Unable to detect your location. Please enable location services."),
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  }

  async function handleSearch() {
    if (!searchText.trim()) {
      return;
    }
    try {
      setSearchStatus("🔍 Searching...");
      const results = await geocodePlace(searchText);
      if (!results.length) {
        setSearchStatus("❌ No results found. Try different keywords.");
        setSearchResults([]);
        return;
      }
      if (results.length === 1) {
        const point = await handleMapClick(results[0].lat, results[0].lon, results[0].name);
        if (point) {
          setSearchText(results[0].name);
          setSearchStatus(`✅ Showing: ${results[0].name}`);
          setSearchResults([]);
        }
        return;
      }
      setSearchResults(results);
      setSearchStatus(`📍 Found ${results.length} results - select one:`);
    } catch (err) {
      setSearchStatus(`❌ ${(err as Error).message}`);
    }
  }

  async function handleSearchResultClick(result: GeocodeResult) {
    const point = await handleMapClick(result.lat, result.lon, result.name);
    if (point) {
      setSearchText(result.name);
      setSearchResults([]);
      setSearchStatus(`✅ Showing: ${result.name}`);
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
      const enrichedData = {
        ...selected,
        nearby_areas: forecastHotspots.slice(0, 5).map(h => `${h.name}: ${h.monthlySignal}% risk`).join(", "),
        river_watch: riverWatchTop.slice(0, 3).map(r => `${r.river_name || r.name}: ${Math.round(r.river_discharge_m3s)} m³/s`).join(", ")
      };
      const summary = await fetchAiSummary(enrichedData);
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
      const wantsSelectedAreaContext = /\b(this area|selected area|current area|this zone|current zone|here)\b/i.test(message);
      const reply = await fetchAiChat(nextMessages, wantsSelectedAreaContext ? selected?.name : undefined);
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
        <div className="topbar-brand">
          <img src="/logo.png" alt="Flood Spaces" className="logo" />
          <div>
            <h1>Flood Spaces</h1>
            <p>Live global flood watch with Bangladesh-focused monthly forecasting</p>
          </div>
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
                    <label>Forecasting Model</label>
                    <strong>{upstreamStatus.open_meteo.live || upstreamStatus.openweather_forecast_fallback.live ? "LIVE" : "DOWN"}</strong>
                  </div>
                  <div>
                    <label>NASA</label>
                    <strong>{upstreamStatus.nasa_power.live ? "LIVE" : "DELAYED"}</strong>
                  </div>
                  <div>
                    <label>ML Analysis</label>
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
              <p className="hint flood-severity-guide">
                Severity colors: WATCH = green (early signal), WARNING = orange (active risk), EMERGENCY = red (critical event).
              </p>
              <p className="hint">Auto-refresh: every 5 minutes in app. NASA and GDACS sources update continuously or daily by source feed.</p>
              {liveFloodLastSeen ? <p className="hint">Latest observed event: {liveFloodLastSeen}</p> : null}
              {liveFloodTop.length ? (
                <div className="flood-event-list">
                  {liveFloodTop.map((event) => (
                    <div key={`${event.id}-${event.lat}-${event.lon}`} className="flood-event-item">
                      <strong>{event.title}</strong>
                      <div className="flood-event-meta">
                        <span>{event.source}</span>
                        <span className={`flood-severity ${event.severity}`}>{event.severity.toUpperCase()}</span>
                      </div>
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
            {!selected ? (
              <p className="hint">Select an area from the map first.</p>
            ) : forecastHotspots.length ? (
              <div className="forecast-timeline">
                {forecastHotspots.map((spot) => (
                  <div key={spot.name} className="forecast-step">
                    <div className="step-time">{spot.name}</div>
                    <div className="step-bar">
                      <div className="step-fill" style={{ width: `${spot.monthlySignal}%` }} />
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
              <CloudRain size={16} /> Bangladesh River Watch (Discharge in m³/s)
            </h3>
            <p className="hint">m³/s = cubic meters per second (water flow volume). Higher = more flood risk.</p>
            {!selected ? (
              <p className="hint">Select an area from the map first.</p>
            ) : riverWatchTop.length ? (
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
                          width: `${Math.max(0, Math.min(100, spot.risk_score))}%`
                        }}
                      />
                    </div>
                    <div className="step-rain">{Math.round(spot.river_discharge_m3s)} m³/s</div>
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
            {!selected ? (
              <p className="hint">Select an area from the map first.</p>
            ) : (
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
                    <strong>{selected.wind_kmh > 0 ? `${selected.wind_kmh} km/h` : "n/a"}</strong>
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
                    <strong>{selected.temperature_c !== null && selected.temperature_c !== undefined ? `${selected.temperature_c}°C` : "n/a"}</strong>
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

            <div className="card span-2 ai-card">
            <h3>
              <Bot size={16} /> AI Risk Brief
            </h3>
            {aiProviderStatus ? <p className="hint">{aiProviderStatus}</p> : null}
            <div className="ai-mode-switch">
              <button className={aiMode === "analysis" ? "active" : ""} onClick={() => setAiMode("analysis")}>
                📊 Area Analysis
              </button>
              <button className={aiMode === "chat" ? "active" : ""} onClick={() => setAiMode("chat")}>
                💬 General Chat
              </button>
            </div>
            {aiMode === "analysis" ? (
              <div className="ai-analysis-panel">
                <div className="ai-response markdown-render">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{aiSummary}</ReactMarkdown>
                </div>
                <div className="ai-actions">
                  <button className="primary" onClick={handleAiSummary}>
                    Generate AI Summary
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="chat-container">
                  {chatMessages.map((message, index) => (
                    <div key={`${message.role}-${index}`} className={message.role === "user" ? "chat-message user" : "chat-message assistant"}>
                      <div className="chat-content markdown-render">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="chat-input-area">
                  <textarea
                    className="input chat-input"
                    rows={3}
                    placeholder="Ask anything: general topics, math, coding, online-style summaries, or project data"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleChatSend();
                      }
                    }}
                  />
                  <button className="primary" onClick={handleChatSend}>
                    Send
                  </button>
                </div>
                {chatStatus ? <p className="hint">{chatStatus}</p> : null}
              </>
            )}
            </div>


        </div>
      </section>

      <section className="bottom-strip">
        <div className="bottom-main">
          <div className="card chart-card">
            <h3>7 Day Risk Trend Analysis (Selected Area)</h3>
            {selected ? (
              <>
                <p className="hint">{selected.name} - Risk Score: {selected.risk_score}/100</p>
                <p className="chart-formula">Risk = f(Rain₁ₕ×6 + Rain₆ₕ×1.8 + Rain₂₄ₕ×0.7 + Wind×0.8 + NASA×0.9 + River×0.03)</p>
              </>
            ) : null}
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={forecastTrendData} margin={{ top: 14, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15, 23, 42, 0.2)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} />
                  <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} label={{ value: 'Risk %', angle: -90, position: 'insideLeft' }} />
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
                    <div className="weather-day">{formatForecastLabel(item.display_time)}</div>
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
          <h3>🚨 Bangladesh Emergency Contacts</h3>
          <div className="emergency-grid">
            {bdEmergencyContacts.map((c) => (
              <a key={c.name} href={c.link} className="emergency-item">
                <div className="emergency-name">{c.name}</div>
                <div className="emergency-value">{c.value}</div>
              </a>
            ))}
          </div>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-content">
          <div className="footer-team">
            <div className="team-member">
              <strong>Developer:</strong> <a href="https://redoyanulhaque.me" target="_blank" rel="noopener noreferrer">Redoyanul Haque</a>
            </div>
            <div className="team-member">
              <strong>Teammate:</strong> Debmalya Dutta Teertha
            </div>
          </div>
          <div className="footer-note">
            Educational flood forecasting assistant - Not an official disaster warning system
          </div>
        </div>
      </footer>
    </div>
  );
}
