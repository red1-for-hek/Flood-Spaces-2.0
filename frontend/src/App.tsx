import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Bot,
  ChevronRight,
  Clock3,
  CloudLightning,
  CloudRain,
  CloudSun,
  Compass,
  Droplets,
  ExternalLink,
  Gauge,
  Layers3,
  LocateFixed,
  Map as MapIcon,
  MessageSquare,
  Moon,
  Phone,
  Radio,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Sun,
  Waves,
  Wind,
  X,
  Zap
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MapPanel from "./components/MapPanel";
import ErrorBoundary from "./components/ErrorBoundary";
import RiskGauge from "./components/RiskGauge";
import LoadingScreen from "./components/LoadingScreen";
import {
  fetchAiChat,
  fetchAiSummary,
  fetchAreaGrid,
  fetchBdRiverWatch,
  fetchBotInfo,
  fetchBoundaries,
  fetchGlobalFloodEvents,
  fetchLocationRisk,
  fetchRiskGrid,
  fetchUpstreamStatus,
  geocodePlace,
  sendTestAlert,
  streamAiChat,
  subscribeTelegram
} from "./lib/api";
import type { BotInfo, GeocodeResult, GlobalFloodEvent, RiskPoint, UpstreamStatus } from "./types";

const bdEmergencyContacts = [
  { name: "National Emergency", value: "999", link: "tel:999" },
  { name: "Fire Service & Civil Defence", value: "16163", link: "tel:16163" },
  { name: "Disaster Management Hotline", value: "1090", link: "tel:1090" },
  { name: "Police Emergency", value: "100", link: "tel:100" },
  { name: "Ambulance Service", value: "199", link: "tel:199" },
  { name: "Flood Forecasting & Warning Centre", value: "02-9552629", link: "tel:+88029552629" },
  { name: "Coast Guard Emergency", value: "01769-690690", link: "tel:01769690690" },
  { name: "Bangladesh Meteorological Dept", value: "02-8130305", link: "tel:+88028130305" }
];

type MapMode = "risk" | "rain" | "wind";
type ChatRole = "assistant" | "user";

const quickPrompts = [
  "Explain the current risk in my area",
  "Is it safe to travel today?",
  "What should I pack in an emergency bag?",
  "How does the flood model work?"
];

function levelText(level: RiskPoint["risk_level"] | "low" | "moderate" | "high" | "severe") {
  return level === "low" ? "Normal" : level.charAt(0).toUpperCase() + level.slice(1);
}

function riskBandFromScore(score: number): "low" | "moderate" | "high" | "severe" {
  if (score < 45) return "low";
  if (score < 68) return "moderate";
  if (score < 84) return "high";
  return "severe";
}

function formatForecastLabel(time: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(time)) {
    const [year, month, day] = time.split("-").map((value) => Number(value));
    return new Date(year, month - 1, day, 12).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric"
    });
  }
  const parsed = new Date(time);
  return Number.isNaN(parsed.getTime())
    ? time
    : parsed.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

function forecastIsoFromTodayOffset(offset: number): string {
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  base.setDate(base.getDate() + offset);
  return base.toISOString();
}

function formatEventTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function timeAgo(value: Date | null): string {
  if (!value) return "waiting for sync";
  const seconds = Math.round((Date.now() - value.getTime()) / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function weatherVisual(trend: number, windKmh: number): { label: string; tone: string; Icon: typeof Sun } {
  if (trend >= 80 || windKmh >= 55) return { label: "Storm", tone: "storm", Icon: CloudLightning };
  if (trend >= 55) return { label: "Thunder", tone: "storm", Icon: CloudLightning };
  if (trend >= 35) return { label: "Rain", tone: "rain", Icon: CloudRain };
  if (trend >= 18) return { label: "Cloudy", tone: "cloudy", Icon: CloudSun };
  return { label: "Clear", tone: "clear", Icon: Sun };
}

function fallbackPoint(): RiskPoint {
  const steps = Array.from({ length: 7 }).map((_, idx) => ({ time: `Day ${idx + 1}`, rain_mm: 0, trend: 0 }));
  return {
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
    forecast_steps: steps,
    has_live_data: false,
    is_no_data: true,
    is_true_flood_signal: false
  };
}

export default function App() {
  const [points, setPoints] = useState<RiskPoint[]>([]);
  const [selected, setSelected] = useState<RiskPoint | null>(null);
  const [densePoints, setDensePoints] = useState<RiskPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [booted, setBooted] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    const saved = window.localStorage.getItem("fs.theme");
    return saved === "light" ? "light" : "dark";
  });
  const [error, setError] = useState<string | null>(null);

  const [countryBoundary, setCountryBoundary] = useState<Record<string, unknown> | null>(null);
  const [districtBoundaries, setDistrictBoundaries] = useState<Record<string, unknown> | null>(null);
  const [upazilaBoundaries, setUpazilaBoundaries] = useState<Record<string, unknown> | null>(null);
  const [locationAccuracyMeters, setLocationAccuracyMeters] = useState<number | null>(null);
  const [userLocation, setUserLocation] = useState<{
    lat: number;
    lon: number;
    accuracy: number;
    nonce: number;
  } | null>(null);
  const [focusPoint, setFocusPoint] = useState<{ lat: number; lon: number; name: string; nonce: number } | null>(null);

  const [mapMode, setMapMode] = useState<MapMode>("risk");
  const [searchText, setSearchText] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);

  const [upstreamStatus, setUpstreamStatus] = useState<UpstreamStatus | null>(null);
  const [globalFloodEvents, setGlobalFloodEvents] = useState<GlobalFloodEvent[]>([]);
  const [globalFloodStatus, setGlobalFloodStatus] = useState<"live" | "unavailable" | "unknown">("unknown");
  const [riverWatchPoints, setRiverWatchPoints] = useState<RiskPoint[]>([]);
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);

  const [aiMode, setAiMode] = useState<"analysis" | "chat">("analysis");
  const [aiSummary, setAiSummary] = useState(
    "Select a hotspot on the map, then generate a briefing. The copilot reads live rainfall, river discharge, satellite anomaly and forecast signals."
  );
  const [aiProviderStatus, setAiProviderStatus] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: ChatRole; content: string }>>([
    {
      role: "assistant",
      content:
        "I'm **FloodSpaces AI** — ask me about risk in your area, evacuation planning, weather interpretation, or anything else."
    }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStreaming, setChatStreaming] = useState(false);
  const chatAbortRef = useRef<AbortController | null>(null);

  const [chatId, setChatId] = useState(() => {
    try {
      return localStorage.getItem("fs.telegramChatId") || "";
    } catch {
      return "";
    }
  });
  const [threshold, setThreshold] = useState(55);
  const [radiusKm, setRadiusKm] = useState(100);
  const [alertStatus, setAlertStatus] = useState("");
  const [testingAlert, setTestingAlert] = useState(false);
  const [showAdvancedAlerts, setShowAdvancedAlerts] = useState(false);

  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const aiSectionRef = useRef<HTMLElement | null>(null);
  const mapSectionRef = useRef<HTMLElement | null>(null);
  const alertsSectionRef = useRef<HTMLElement | null>(null);

  const forecastHotspots = useMemo(() => {
    const unique = new Map<string, RiskPoint>();
    for (const point of points) {
      const key = point.name.toLowerCase();
      if (!key.includes("local") && !key.includes("cell") && !unique.has(key)) unique.set(key, point);
    }
    return [...unique.values()]
      .map((point) => ({
        name: point.name,
        score: Math.round(point.risk_score),
        level: riskBandFromScore(point.risk_score)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [points]);

  const riverWatchTop = useMemo(() => {
    const best = new Map<string, RiskPoint>();
    for (const point of riverWatchPoints) {
      const key = String(point.river_name || point.name || "Unknown").trim().toLowerCase();
      const existing = best.get(key);
      if (!existing || point.risk_score > existing.risk_score) best.set(key, point);
    }
    return [...best.values()].sort((a, b) => b.risk_score - a.risk_score).slice(0, 6);
  }, [riverWatchPoints]);

  const weatherForecast = useMemo(() => {
    const src = selected || points[0];
    if (!src) return [];
    return src.forecast_steps.slice(0, 7).map((step, idx) => {
      const wind = typeof step.wind_kmh === "number" ? step.wind_kmh : src.wind_kmh;
      return {
        ...step,
        display_time: forecastIsoFromTodayOffset(idx),
        temp_c: typeof step.temp_c === "number" ? step.temp_c : src.temperature_c,
        wind_kmh: wind,
        ...weatherVisual(step.trend, wind)
      };
    });
  }, [points, selected]);

  const forecastTrendData = useMemo(() => {
    const src = selected || points[0];
    if (!src) return [];
    return src.forecast_steps.slice(0, 7).map((step, idx) => ({
      label: formatForecastLabel(forecastIsoFromTodayOffset(idx)),
      risk: Math.round(step.trend)
    }));
  }, [points, selected]);

  const liveFloodTop = useMemo(() => {
    const rank = { emergency: 3, warning: 2, watch: 1 } as const;
    return [...globalFloodEvents]
      .sort((a, b) => rank[b.severity] - rank[a.severity] || String(b.observed_at).localeCompare(String(a.observed_at)))
      .slice(0, 6);
  }, [globalFloodEvents]);

  const nationalIndex = useMemo(() => {
    if (!points.length) return 0;
    const top = [...points].slice(0, 8);
    return Math.round(top.reduce((sum, point) => sum + point.risk_score, 0) / top.length);
  }, [points]);

  const peakPoint = useMemo(
    () => [...points].sort((a, b) => b.risk_score - a.risk_score)[0] || null,
    [points]
  );

  // 68 is where the backend risk model switches a zone from "moderate" to
  // "high" (see risk_level() in backend/app/main.py), so this is the alert cut.
  const HIGH_RISK_SCORE = 68;
  const alertZoneCount = useMemo(
    () => points.filter((point) => point.risk_score >= HIGH_RISK_SCORE).length,
    [points]
  );

  const dataLooksEmpty = useMemo(() => {
    if (!points.length) return true;
    return points.every(
      (point) => !point.has_live_data && point.rainfall_24h_mm === 0 && point.risk_score === 0
    );
  }, [points]);

  const pipelineHealthy = Boolean(upstreamStatus?.core_data_live) && !dataLooksEmpty;

  const liveSourceCount = useMemo(() => {
    if (!upstreamStatus) return 0;
    return [
      upstreamStatus.open_meteo.live ||
        upstreamStatus.openweather_forecast_fallback.live ||
        Boolean(upstreamStatus.nasa_forecast_fallback?.live),
      upstreamStatus.nasa_power.live,
      upstreamStatus.open_meteo_flood.live,
      upstreamStatus.ai?.live
    ].filter(Boolean).length;
  }, [upstreamStatus]);

  const feedHealth = useMemo(
    () => [
      {
        key: "open_meteo",
        label: "Open-Meteo",
        live: Boolean(
          upstreamStatus?.open_meteo.live ||
            upstreamStatus?.openweather_forecast_fallback.live ||
            upstreamStatus?.nasa_forecast_fallback?.live
        )
      },
      { key: "nasa", label: "NASA", live: Boolean(upstreamStatus?.nasa_power.live) },
      { key: "river", label: "river", live: Boolean(upstreamStatus?.open_meteo_flood.live) },
      { key: "ai", label: "Groq", live: Boolean(upstreamStatus?.ai?.live) }
    ],
    [upstreamStatus]
  );

  const downFeeds = feedHealth.filter((feed) => !feed.live).map((feed) => feed.label);
  const warmingUp = dataLooksEmpty && recoveryAttempt < 12;
  const pipelineState: "nominal" | "partial" | "warming" | "degraded" = warmingUp
    ? "warming"
    : liveSourceCount >= 4
      ? "nominal"
      : liveSourceCount >= 3
        ? "partial"
        : "degraded";

  const aiModelLabel = botInfo?.ai_model || "openai/gpt-oss-20b";
  const telegramUsername = (botInfo?.username || import.meta.env.VITE_TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
  const telegramLink = telegramUsername ? `https://t.me/${telegramUsername}` : "";

  useEffect(() => {
    try {
      localStorage.setItem("fs.telegramChatId", chatId);
    } catch {
      /* storage can be blocked in private mode */
    }
  }, [chatId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [chatMessages, chatBusy]);

  async function loadGrid(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    // Only the first load shows the full-screen map skeleton; background
    // recovery polls must not flash the overlay over live numbers.
    if (!isRefresh) setLoading(true);

    try {
      // Primary payload first: the dashboard lights up as soon as risk data lands.
      const data = await fetchRiskGrid();
      const ranked = [...data.items].sort((a, b) => b.risk_score - a.risk_score);
      setPoints(ranked);
      setSelected((prev) => {
        if (!prev) return ranked[0] || null;
        return (
          ranked.find(
            (point) =>
              point.name.toLowerCase() === prev.name.toLowerCase() ||
              (Math.abs(point.lat - prev.lat) < 0.03 && Math.abs(point.lon - prev.lon) < 0.03)
          ) || prev
        );
      });
      setLastSync(new Date());
      setError(null);
      setLoading(false);

      const focus = ranked[0];
      if (focus) {
        fetchAreaGrid(focus.lat, focus.lon, 20, 5)
          .then((local) => setDensePoints(local.filter((p) => !p.name.includes("Cell"))))
          .catch(() => setDensePoints([]));
      }

      // Secondary feeds stream in independently so they never block the map.
      fetchUpstreamStatus().then(setUpstreamStatus).catch(() => null);
      fetchGlobalFloodEvents()
        .then((eventData) => {
          setGlobalFloodEvents(eventData?.items || []);
          setGlobalFloodStatus(eventData?.status || (eventData?.items?.length ? "live" : "unknown"));
        })
        .catch(() => null);
      fetchBdRiverWatch()
        .then((riverData) => setRiverWatchPoints(riverData?.items || []))
        .catch(() => null);
      fetchBotInfo().then(setBotInfo).catch(() => null);
    } catch (err) {
      const fallback = fallbackPoint();
      setPoints([fallback]);
      setSelected((prev) => prev || fallback);
      setDensePoints([]);
      setGlobalFloodEvents([]);
      setGlobalFloodStatus("unknown");
      setRiverWatchPoints([]);
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
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
      setDensePoints(local.filter((p) => !p.name.includes("Cell")));
      setPoints((prev) => {
        const filtered = prev.filter(
          (p) =>
            !(Math.abs(p.lat - point.lat) < 0.0001 && Math.abs(p.lon - point.lon) < 0.0001) &&
            !p.name.includes("Cell") &&
            !p.name.includes("Local")
        );
        if (!filtered.some((p) => p.name.toLowerCase() === point.name.toLowerCase())) {
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
      setSearchStatus("Geolocation is not supported in this browser.");
      return;
    }
    setSearchStatus("Detecting your location…");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const accuracy = Number.isFinite(pos.coords.accuracy)
          ? Math.min(Math.max(pos.coords.accuracy, 30), 5000)
          : undefined;
        setUserLocation({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: accuracy ?? 250,
          nonce: Date.now()
        });
        const point = await handleMapClick(pos.coords.latitude, pos.coords.longitude, undefined, accuracy);
        if (point) {
          setFocusPoint({ lat: point.lat, lon: point.lon, name: point.name, nonce: Date.now() });
          setSearchText(point.name);
          setSearchStatus(`Pinned ${point.name} · ±${Math.round(accuracy || 0)} m`);
          setSearchResults([]);
        } else {
          setSearchStatus("Could not resolve a usable location.");
        }
      },
      () => setSearchStatus("Location permission denied. Enable it in your browser settings."),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  async function handleSearch() {
    if (!searchText.trim()) return;
    try {
      setSearchStatus("Searching…");
      const results = await geocodePlace(searchText);
      if (!results.length) {
        setSearchStatus("No matching place. Try a district or upazila name.");
        setSearchResults([]);
        return;
      }
      setSearchResults(results);
      setSearchStatus(`${results.length} matches`);
    } catch (err) {
      setSearchStatus((err as Error).message);
    }
  }

  async function handleSearchResultClick(result: GeocodeResult) {
    const point = await handleMapClick(result.lat, result.lon, result.name);
    if (point) {
      setFocusPoint({ lat: point.lat, lon: point.lon, name: point.name, nonce: Date.now() });
      setSearchText(result.name);
      setSearchResults([]);
      setSearchStatus(`Showing ${result.name}`);
    }
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("fs.theme", theme);
    } catch {
      /* storage can be blocked in private mode */
    }
  }, [theme]);

  useEffect(() => {
    loadGrid();
    const timer = setInterval(() => loadGrid(true), 5 * 60 * 1000);
    const bootTimer = setTimeout(() => setBooted(true), 2200);
    return () => {
      clearInterval(timer);
      clearTimeout(bootTimer);
    };
  }, []);

  // Self-healing: a cold backend can answer with zeros while it warms its
  // upstream feeds. Poll faster until real data lands, then stop.
  useEffect(() => {
    if (loading || booted === false) return;
    if (pipelineHealthy || recoveryAttempt >= 12) return;
    const timer = setTimeout(() => {
      setRecoveryAttempt((attempt) => attempt + 1);
      loadGrid(true);
    }, 8000);
    return () => clearTimeout(timer);
  }, [booted, loading, pipelineHealthy, recoveryAttempt, points.length]);

  useEffect(() => {
    if (pipelineHealthy) {
      setRecoveryAttempt(0);
    }
  }, [pipelineHealthy]);

  useEffect(() => {
    fetchBotInfo().then(setBotInfo).catch(() => null);
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

  async function handleAiSummary() {
    if (!selected || aiBusy) return;
    setAiMode("analysis");
    setAiBusy(true);
    setAiSummary("Analysing rainfall, river discharge, satellite anomaly and the 7-day outlook…");
    try {
      const enriched = {
        ...selected,
        nearby_areas: forecastHotspots
          .slice(0, 5)
          .map((spot) => `${spot.name}: ${spot.score}% risk`)
          .join(", "),
        river_watch: riverWatchTop
          .slice(0, 3)
          .map((river) => `${river.river_name || river.name}: ${Math.round(river.river_discharge_m3s)} m³/s`)
          .join(", ")
      };
      const summary = await fetchAiSummary(enriched);
      setAiSummary(summary.summary);
      setAiProviderStatus(
        summary.provider_live
          ? `Groq live · ${summary.provider_model || aiModelLabel}`
          : `Local fallback · ${summary.provider_reason || "AI unavailable"}`
      );
    } catch (err) {
      setAiSummary((err as Error).message);
      setAiProviderStatus("AI request failed");
    } finally {
      setAiBusy(false);
    }
  }

  async function handleTestAlert() {
    if (testingAlert) return;
    setTestingAlert(true);
    setAlertStatus("Sending test alert…");
    try {
      const result = await sendTestAlert(chatId);
      if (result.ok) {
        setAlertStatus(`Test alert delivered to ${result.sent} chat${result.sent === 1 ? "" : "s"}.`);
      } else if (result.reason === "no_subscribers") {
        setAlertStatus("No subscribers yet — press Start in the bot, or add a chat ID below.");
      } else {
        setAlertStatus("Test alert could not be delivered. Check the bot token on the backend.");
      }
    } catch (err) {
      setAlertStatus((err as Error).message);
    } finally {
      setTestingAlert(false);
    }
  }

  async function handleChatSend(override?: string) {
    const message = (override ?? chatInput).trim();
    if (!message || chatBusy) return;

    const history = [...chatMessages, { role: "user" as const, content: message }].map(({ role, content }) => ({
      role,
      content
    }));
    setChatMessages([...chatMessages, { role: "user", content: message }, { role: "assistant", content: "" }]);
    setChatInput("");
    setChatBusy(true);
    setChatStreaming(true);

    const wantsArea = /\b(this area|selected area|current area|this zone|current zone|here|my area)\b/i.test(message);
    const controller = new AbortController();
    chatAbortRef.current = controller;

    const writeAssistant = (text: string) => {
      setChatMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: "assistant", content: text };
        return next;
      });
    };

    try {
      const reply = await streamAiChat(
        history,
        wantsArea ? selected?.name : undefined,
        (partial) => writeAssistant(partial),
        controller.signal
      );
      if (!reply.trim()) {
        writeAssistant("⚠️ The model returned an empty response. Please try again.");
      }
      setAiProviderStatus(`Groq live · ${aiModelLabel}`);
    } catch (err) {
      if (controller.signal.aborted) {
        setAiProviderStatus("Stopped");
      } else {
        try {
          // Streaming can be blocked by proxies — fall back to the JSON endpoint.
          const reply = await fetchAiChat(history, wantsArea ? selected?.name : undefined);
          writeAssistant(reply.reply);
          setAiProviderStatus(
            reply.provider_live
              ? `Groq live · ${reply.provider_model || aiModelLabel}`
              : `Local fallback · ${reply.provider_reason || "AI unavailable"}`
          );
        } catch (fallbackErr) {
          writeAssistant(`⚠️ ${(fallbackErr as Error).message}`);
        }
      }
    } finally {
      chatAbortRef.current = null;
      setChatBusy(false);
      setChatStreaming(false);
    }
  }

  function handleChatStop() {
    chatAbortRef.current?.abort();
    setChatBusy(false);
    setChatStreaming(false);
  }

  async function handleSubscribe() {
    if (!chatId.trim()) {
      setAlertStatus("Enter your Telegram chat ID, or simply press Start in the bot.");
      return;
    }
    try {
      await subscribeTelegram({
        chat_id: chatId.trim(),
        lat: selected?.lat,
        lon: selected?.lon,
        threshold,
        radius_km: radiusKm
      });
      setAlertStatus("Alerts enabled. This account is now subscribed automatically.");
    } catch (err) {
      setAlertStatus((err as Error).message);
    }
  }

  function scrollTo(ref: { current: HTMLElement | null }) {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const initialLoading = loading && !points.length;
  // While a cold backend warms its upstreams, show skeletons instead of a
  // misleading wall of zeros.
  const kpiSkeleton = initialLoading || warmingUp;

  if (initialLoading && !booted) {
    return <LoadingScreen />;
  }

  return (
    <div className="app-shell">
      <div className="ambient" aria-hidden="true" />

      <aside className="rail">
        <div className="rail-brand" title="Flood Spaces">
          <img src="/logo.png" alt="Flood Spaces" />
        </div>
        <nav className="rail-nav" aria-label="Sections">
          <button className="rail-btn is-active" title="Overview" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
            <Activity size={19} />
          </button>
          <button className="rail-btn" title="Map" onClick={() => scrollTo(mapSectionRef)}>
            <MapIcon size={19} />
          </button>
          <button className="rail-btn" title="AI copilot" onClick={() => scrollTo(aiSectionRef)}>
            <Sparkles size={19} />
          </button>
          <button className="rail-btn" title="Alerts" onClick={() => scrollTo(alertsSectionRef)}>
            <Bell size={19} />
          </button>
        </nav>
        <div className="rail-foot">
          <span className="rail-pulse" title="Live data stream">
            <Radio size={16} />
          </span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="eyebrow">
              <span className="eyebrow-dot" /> Bangladesh · live intelligence
            </span>
            <h1>Flood Spaces</h1>
          </div>

          <div className="search-shell">
            <Search size={17} className="search-icon" />
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleSearch();
                }
              }}
              placeholder="Search district, city or upazila…"
              aria-label="Search location"
            />
            {searchText ? (
              <button className="search-clear" onClick={() => setSearchText("")} aria-label="Clear search">
                <X size={15} />
              </button>
            ) : null}
            <button className="search-submit" onClick={handleSearch} aria-label="Search">
              <ChevronRight size={16} />
            </button>

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
                    <span className="search-source">{result.source || "geo"}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="topbar-actions">
            <button className="ghost-btn locate-btn" onClick={handleUseMyLocation} title="Use my location">
              <LocateFixed size={16} />
              <span>My area</span>
            </button>
            <button
              className={`theme-toggle ${theme === "dark" ? "is-dark" : "is-light"}`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <div
              className={`live-pill ${pipelineHealthy ? "" : "is-syncing"}`}
              title={lastSync ? `Last sync ${lastSync.toLocaleTimeString()}` : "Contacting the forecast pipeline"}
            >
              <span className="live-dot" />
              {lastSync ? `Live · ${timeAgo(lastSync)}` : "Syncing feeds…"}
            </div>
            <button className="primary-btn" onClick={() => loadGrid(true)} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? "spin" : ""} />
              <span>{refreshing ? "Syncing" : "Refresh"}</span>
            </button>
          </div>
        </header>

        {searchStatus ? (
          <div className="inline-status">
            <Compass size={14} /> {searchStatus}
          </div>
        ) : null}

        <section className="kpi-row" aria-label="Key indicators">
          <article className={`kpi-card risk-${riskBandFromScore(nationalIndex)}`}>
            <div className="kpi-head">
              <span>National risk index</span>
              <Gauge size={17} />
            </div>
            <div className="kpi-value">
              {kpiSkeleton ? <span className="value-skeleton" /> : nationalIndex}
              {kpiSkeleton ? null : <small>/100</small>}
            </div>
            <div className="kpi-foot">
              <span className="chip subtle">{levelText(riskBandFromScore(nationalIndex))}</span>
              <span>
                {points.length} zones monitored
                {pipelineState === "warming" ? " · warming upstreams" : ""}
              </span>
            </div>
            <div className="kpi-spark">
              <span style={{ width: `${nationalIndex}%` }} />
            </div>
          </article>

          <article className="kpi-card">
            <div className="kpi-head">
              <span>Peak hotspot</span>
              <AlertTriangle size={17} />
            </div>
            <div className="kpi-value compact">
              {kpiSkeleton ? <span className="value-skeleton wide" /> : peakPoint?.name || "—"}
            </div>
            <div className="kpi-foot">
              {peakPoint ? (
                <>
                  <span className={`chip risk-chip-${riskBandFromScore(peakPoint.risk_score)}`}>
                    {Math.round(peakPoint.risk_score)}/100
                  </span>
                  <span>rain {peakPoint.rainfall_24h_mm} mm / 24h</span>
                </>
              ) : (
                <span>Awaiting data</span>
              )}
            </div>
          </article>

          <article className="kpi-card">
            <div className="kpi-head">
              <span title="Zones whose risk score has reached the high band">Zones at high risk</span>
              <Bell size={17} />
            </div>
            <div className="kpi-value">
              {kpiSkeleton ? <span className="value-skeleton" /> : alertZoneCount}
              {kpiSkeleton ? null : <small>of {points.length} zones</small>}
            </div>
            <div className="kpi-foot">
              <span
                className="chip subtle"
                title={`Risk score ${HIGH_RISK_SCORE} and above = high (bands: 0-44 low, 45-67 moderate, 68-83 high, 84-93 severe, 94+ flood)`}
              >
                score ≥ {HIGH_RISK_SCORE} · high
              </span>
              <span>{globalFloodEvents.length} flood events</span>
            </div>
          </article>

          <article className="kpi-card">
            <div className="kpi-head">
              <span>Data pipeline</span>
              <Layers3 size={17} />
            </div>
            <div className="kpi-value">
              {kpiSkeleton ? <span className="value-skeleton" /> : liveSourceCount}
              {kpiSkeleton ? null : <small>/4 live</small>}
            </div>
            <div className="kpi-foot">
              <span
                className={`chip ${
                  pipelineState === "nominal"
                    ? "ok"
                    : pipelineState === "warming"
                      ? "syncing"
                      : "warn"
                }`}
              >
                {pipelineState === "nominal"
                  ? "Nominal"
                  : pipelineState === "warming"
                    ? "Warming up"
                    : pipelineState === "partial"
                      ? "Partial"
                      : "Degraded"}
              </span>
              <span title={downFeeds.length ? `Down: ${downFeeds.join(", ")}` : "All feeds live"}>
                {downFeeds.length ? `Down: ${downFeeds.join(" · ")}` : "Open-Meteo · NASA · river · Groq"}
              </span>
            </div>
          </article>

          <article className="kpi-card accent">
            <div className="kpi-head">
              <span>Auto-alert subscribers</span>
              <ShieldCheck size={17} />
            </div>
            <div className="kpi-value">
              {initialLoading ? <span className="value-skeleton" /> : botInfo?.subscribers ?? 0}
              {initialLoading ? null : <small>chat ids</small>}
            </div>
            <div className="kpi-foot">
              <span className={`chip ${botInfo?.configured ? "ok" : "warn"}`}>
                {botInfo?.configured ? "Bot online" : "Bot key missing"}
              </span>
              <span>{botInfo?.webhook_mode ? "webhook" : "polling"} mode</span>
            </div>
          </article>
        </section>

        {error ? (
          <div className="banner error-banner">
            <AlertTriangle size={16} />
            <span>Live backend unreachable. Showing cached shell — {error}</span>
            <button className="ghost-btn" onClick={() => loadGrid(true)}>
              Retry
            </button>
          </div>
        ) : null}

        {!error && !initialLoading && pipelineState === "warming" ? (
          <div className="banner info-banner">
            <RefreshCw size={16} className="spin" />
            <span>
              Waking the forecast pipeline{recoveryAttempt ? ` · attempt ${recoveryAttempt}` : ""}. A cold backend can take
              ~30 s to reach Open-Meteo and NASA — live numbers replace the zeros automatically.
            </span>
            <button className="ghost-btn" onClick={() => loadGrid(true)}>
              Retry now
            </button>
          </div>
        ) : null}

        {!error && !initialLoading && pipelineState === "partial" ? (
          <div className="banner info-banner">
            <Radio size={16} />
            <span>
              {liveSourceCount}/4 feeds live — {downFeeds.join(", ")} hasn&apos;t reported yet. Everything else is
              streaming normally; this is usually a delayed satellite or AI feed, not an outage.
            </span>
          </div>
        ) : null}

        {!error && !initialLoading && pipelineState === "degraded" ? (
          <div className="banner warn-banner">
            <Radio size={16} />
            <span>
              {downFeeds.length ? `${downFeeds.join(", ")} unreachable right now.` : "Some feeds are degraded."} Risk cells
              keep the last known values and the dashboard retries every few seconds.
              {upstreamStatus?.grid?.stale ? " Showing the last good snapshot from before the outage." : ""}
            </span>
            <button className="ghost-btn" onClick={() => loadGrid(true)}>
              Retry feeds
            </button>
          </div>
        ) : null}

        <section className="workspace" ref={mapSectionRef}>
          <div className="panel map-card">
            <div className="panel-head">
              <div>
                <span className="panel-eyebrow">Geospatial intelligence</span>
                <h2>Risk surface · Bangladesh</h2>
              </div>
              <div className="map-toolbar">
                <div className="segmented" role="tablist" aria-label="Map metric">
                  {(["risk", "rain", "wind"] as MapMode[]).map((mode) => (
                    <button
                      key={mode}
                      className={mapMode === mode ? "is-active" : ""}
                      onClick={() => setMapMode(mode)}
                      role="tab"
                      aria-selected={mapMode === mode}
                      title={
                        mode === "risk"
                          ? "Colour the hex grid by composite flood risk"
                          : mode === "rain"
                            ? "Colour the hex grid by 24-hour rainfall"
                            : "Colour the hex grid by wind speed"
                      }
                    >
                      {mode === "risk" ? "Risk" : mode === "rain" ? "Rain" : "Wind"}
                    </button>
                  ))}
                </div>
                <button className="ghost-btn compact" onClick={handleUseMyLocation} title="Jump to my location">
                  <LocateFixed size={15} />
                </button>
              </div>
            </div>

            <div className="map-canvas-wrap">
              {loading && !points.length ? (
                <div className="map-loading">
                  <div className="spinner" /> Loading risk surface…
                </div>
              ) : null}
              <ErrorBoundary
                compact
                title="Map failed to render"
                description="The risk data below is unaffected."
                onReset={() => window.location.reload()}
              >
                <MapPanel
                  points={points}
                  densePoints={densePoints}
                  riverWatchPoints={riverWatchPoints}
                  onSelect={setSelected}
                  onMapClick={handleMapClick}
                  selectedName={selected?.name || null}
                  highlightPoint={selected ? { lat: selected.lat, lon: selected.lon, name: selected.name } : null}
                  focusPoint={focusPoint}
                  highlightAccuracyMeters={locationAccuracyMeters}
                  userLocation={userLocation}
                  mode={mapMode}
                  globalFloodEvents={globalFloodEvents}
                  countryBoundary={countryBoundary}
                  districtBoundaries={districtBoundaries}
                  upazilaBoundaries={upazilaBoundaries}
                />
              </ErrorBoundary>
              <div className={`map-mode-chip mode-${mapMode}`}>
                <span className="map-mode-swatch" />
                {mapMode === "risk"
                  ? "Risk index · 0–100"
                  : mapMode === "rain"
                    ? "24h rainfall · mm"
                    : "Wind · km/h"}
              </div>
              {mapMode === "risk" ? (
                <div className="map-legend">
                  <span><i className="dot low" /> Normal</span>
                  <span><i className="dot moderate" /> Moderate</span>
                  <span><i className="dot high" /> High</span>
                  <span><i className="dot severe" /> Severe</span>
                  <span><i className="dot active-flood" /> Active flood</span>
                  <span><i className="dot river-watch" /> River watch</span>
                </div>
              ) : (
                <div className="map-legend">
                  <span>{mapMode === "rain" ? "24h rain" : "Wind"}</span>
                  <span className="gradient-legend" aria-hidden="true" />
                  <span>{mapMode === "rain" ? "0 mm → 120+ mm" : "0 → 80+ km/h"}</span>
                </div>
              )}
              <div className="map-hint">Click anywhere to inspect a location · scroll to zoom</div>
            </div>
          </div>

          <div className="side-col">
            <section className="panel selected-card">
              <div className="panel-head tight">
                <div>
                  <span className="panel-eyebrow">Selected zone</span>
                  <h2>{selected?.name || "No zone selected"}</h2>
                </div>
                {selected ? (
                  <span className={`level-badge level-${selected.risk_level}`}>{levelText(selected.risk_level)}</span>
                ) : null}
              </div>

              {selected ? (
                <>
                  <div className="gauge-wrap">
                    <RiskGauge score={selected.risk_score} level={selected.risk_level} />
                    <div className="gauge-side">
                      <div className="mini-stat">
                        <span>Confidence</span>
                        <strong>{selected.confidence_pct}%</strong>
                      </div>
                      <div className="mini-stat">
                        <span>NASA anomaly</span>
                        <strong>{Math.round(selected.satellite_water_anomaly * 100)}%</strong>
                      </div>
                      <div className="mini-stat">
                        <span>Temperature</span>
                        <strong>
                          {selected.temperature_c !== null && selected.temperature_c !== undefined
                            ? `${selected.temperature_c}°C`
                            : "n/a"}
                        </strong>
                      </div>
                      <div className="mini-stat">
                        <span>Signal</span>
                        <strong>{selected.is_true_flood_signal ? "Flood" : selected.is_no_data ? "No data" : "Watch"}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="metric-grid">
                    <div><span>Rain 1h</span><strong>{selected.rainfall_1h_mm} mm</strong></div>
                    <div><span>Rain 24h</span><strong>{selected.rainfall_24h_mm} mm</strong></div>
                    <div><span>Wind</span><strong>{selected.wind_kmh} km/h</strong></div>
                    <div><span>River flow</span><strong>{Math.round(selected.river_discharge_m3s)} m³/s</strong></div>
                    <div><span>NASA precip</span><strong>{selected.satellite_precip_mm} mm</strong></div>
                    <div><span>Coordinates</span><strong>{selected.lat.toFixed(2)}, {selected.lon.toFixed(2)}</strong></div>
                  </div>

                  <div className="selected-actions">
                    <button className="primary-btn full" onClick={handleAiSummary} disabled={aiBusy}>
                      <Sparkles size={16} />
                      {aiBusy ? "Generating briefing…" : "Generate AI briefing"}
                    </button>
                  </div>

                  {selected.data_sources ? (
                    <p className="source-line">
                      forecast {selected.data_sources.forecast_source} · NASA {selected.data_sources.nasa_live ? "live" : "delayed"} ·
                      river {selected.data_sources.river_live ? "live" : "unavailable"}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="empty-note">
                  {initialLoading ? "Loading the live risk surface…" : "Tap any marker or the map to load a zone briefing."}
                </p>
              )}
            </section>

            <section className="panel telegram-card" ref={alertsSectionRef}>
              <div className="panel-head tight">
                <div>
                  <span className="panel-eyebrow">Automatic alerts</span>
                  <h2>Telegram flood bot</h2>
                </div>
                <span className={`status-dot ${botInfo?.configured ? "online" : "offline"}`} />
              </div>

              <p className="muted-copy">
                Anyone who opens the bot and presses <strong>Start</strong> is subscribed instantly — every high-risk alert is
                delivered automatically, no dashboard needed.
              </p>

              <div className="telegram-stats">
                <div><span>Subscribers</span><strong>{botInfo?.subscribers ?? 0}</strong></div>
                <div><span>Delivery</span><strong>{botInfo?.webhook_mode ? "Webhook" : "Auto-poll"}</strong></div>
              </div>

              {telegramLink ? (
                <a className="primary-btn full" href={telegramLink} target="_blank" rel="noreferrer">
                  <Send size={16} /> Open @{telegramUsername}
                  <ArrowUpRight size={14} />
                </a>
              ) : (
                <div className="banner small warn-banner">
                  <AlertTriangle size={15} /> Set <code>TELEGRAM_BOT_TOKEN</code> on the backend to activate the bot.
                </div>
              )}

              <div className="telegram-actions">
                <button className="ghost-btn" onClick={handleTestAlert} disabled={testingAlert}>
                  <Zap size={15} /> {testingAlert ? "Sending…" : "Send test alert"}
                </button>
                {botInfo?.configured ? (
                  <span className="source-line inline">Bot token detected</span>
                ) : (
                  <span className="source-line inline">Bot token missing</span>
                )}
              </div>

              <button className="link-btn" onClick={() => setShowAdvancedAlerts((prev) => !prev)}>
                {showAdvancedAlerts ? "Hide manual linking" : "Link a chat ID manually"}
                <ChevronRight size={14} className={showAdvancedAlerts ? "rotated" : ""} />
              </button>

              {showAdvancedAlerts ? (
                <div className="advanced-alerts">
                  <label>
                    Telegram chat ID
                    <input
                      className="input"
                      placeholder="e.g. 123456789"
                      value={chatId}
                      onChange={(event) => setChatId(event.target.value)}
                    />
                  </label>
                  <label>
                    Risk threshold · {threshold}
                    <input
                      type="range"
                      min={25}
                      max={95}
                      value={threshold}
                      onChange={(event) => setThreshold(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    Radius · {radiusKm} km
                    <input
                      type="range"
                      min={20}
                      max={300}
                      step={10}
                      value={radiusKm}
                      onChange={(event) => setRadiusKm(Number(event.target.value))}
                    />
                  </label>
                  <button className="primary-btn full" onClick={handleSubscribe}>
                    <Bell size={15} /> Enable alerts for {selected?.name || "my area"}
                  </button>
                </div>
              ) : null}

              {alertStatus ? <p className="source-line">{alertStatus}</p> : null}
            </section>
          </div>
        </section>

        <section className="split-grid" ref={aiSectionRef}>
          <div className="panel ai-panel">
            <div className="panel-head">
              <div>
                <span className="panel-eyebrow">Copilot</span>
                <h2>FloodSpaces AI</h2>
              </div>
              <div className="ai-meta">
                <span className="ai-chip"><Zap size={13} /> Groq</span>
                <span className="ai-model">{aiModelLabel}</span>
              </div>
            </div>

            <div className="ai-tabs">
              <button className={aiMode === "analysis" ? "is-active" : ""} onClick={() => setAiMode("analysis")}>
                <Gauge size={15} /> Area briefing
              </button>
              <button className={aiMode === "chat" ? "is-active" : ""} onClick={() => setAiMode("chat")}>
                <MessageSquare size={15} /> Chat
              </button>
            </div>

            {aiMode === "analysis" ? (
              <div className="ai-analysis">
                <div className={`ai-brief markdown-render ${aiBusy ? "is-busy" : ""}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{aiSummary}</ReactMarkdown>
                </div>
                <div className="ai-analysis-foot">
                  <span className="source-line">{aiProviderStatus || "Groq-backed briefing engine"}</span>
                  <button className="primary-btn" onClick={handleAiSummary} disabled={aiBusy || !selected}>
                    <Sparkles size={16} /> {aiBusy ? "Thinking…" : "Generate briefing"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="chat-shell">
                <div className="chat-stream">
                  {chatMessages.map((message, index) => (
                    <div key={`${message.role}-${index}`} className={`bubble ${message.role}`}>
                      <div className="bubble-avatar">{message.role === "user" ? "You" : <Bot size={15} />}</div>
                      <div className="bubble-content markdown-render">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      </div>
                    </div>
                  ))}
                  {chatBusy && !chatStreaming ? (
                    <div className="bubble assistant">
                      <div className="bubble-avatar"><Bot size={15} /></div>
                      <div className="typing"><span /><span /><span /></div>
                    </div>
                  ) : null}
                  <div ref={chatEndRef} />
                </div>

                <div className="quick-prompts">
                  {quickPrompts.map((prompt) => (
                    <button key={prompt} onClick={() => handleChatSend(prompt)} disabled={chatBusy}>
                      {prompt}
                    </button>
                  ))}
                </div>

                <div className="composer">
                  <textarea
                    rows={1}
                    placeholder="Ask about risk, safety, weather, or anything else…"
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        handleChatSend();
                      }
                    }}
                  />
                  {chatBusy ? (
                    <button className="primary-btn stop" onClick={handleChatStop} title="Stop generating">
                      <X size={16} />
                    </button>
                  ) : (
                    <button className="primary-btn" onClick={() => handleChatSend()} disabled={!chatInput.trim()}>
                      <Send size={16} />
                    </button>
                  )}
                </div>
                <span className="source-line">{aiProviderStatus || "Powered by Groq · openai/gpt-oss-20b"}</span>
              </div>
            )}
          </div>

          <div className="panel events-panel">
            <div className="panel-head">
              <div>
                <span className="panel-eyebrow">Global feed</span>
                <h2>Live flood events</h2>
              </div>
              <span className={`chip ${globalFloodStatus === "live" ? "ok" : "warn"}`}>
                {globalFloodStatus === "live" ? "Live" : "Feed delayed"}
              </span>
            </div>
            <p className="muted-copy">NASA EONET + GDACS, refreshed continuously.</p>

            <div className="event-list">
              {liveFloodTop.length ? (
                liveFloodTop.map((event) => (
                  <article key={`${event.id}-${event.lat}-${event.lon}`} className="event-item">
                    <span className={`severity-bar ${event.severity}`} />
                    <div className="event-body">
                      <strong>{event.title}</strong>
                      <div className="event-meta">
                        <span>{event.source}</span>
                        <time>{formatEventTime(event.observed_at)}</time>
                      </div>
                    </div>
                    <span className={`severity-chip ${event.severity}`}>{event.severity}</span>
                  </article>
                ))
              ) : (
                <p className="empty-note">No live flood events in the current feed.</p>
              )}
            </div>
          </div>
        </section>

        <section className="tri-grid">
          <div className="panel">
            <div className="panel-head">
              <div>
                <span className="panel-eyebrow">Forecast</span>
                <h2>1-month outlook</h2>
              </div>
              <Clock3 size={17} className="panel-icon" />
            </div>
            <div className="outlook-list">
              {forecastHotspots.map((spot) => (
                <div key={spot.name} className="outlook-row">
                  <span className="outlook-name">{spot.name}</span>
                  <div className="bar-track">
                    <div className={`bar-fill tone-${spot.level}`} style={{ width: `${spot.score}%` }} />
                  </div>
                  <span className="outlook-score">{spot.score}%</span>
                </div>
              ))}
              {!forecastHotspots.length ? <p className="empty-note">Outlook arrives with the next forecast cycle.</p> : null}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <span className="panel-eyebrow">Hydrology</span>
                <h2>River watch</h2>
              </div>
              <Waves size={17} className="panel-icon" />
            </div>
            <div className="river-list">
              {riverWatchTop.map((river) => (
                <div key={`${river.name}-${river.lat}`} className="river-row">
                  <div className="river-name">
                    <strong>{river.river_name || "River"}</strong>
                    <span>{river.name}</span>
                  </div>
                  <div className="river-values">
                    <strong>{Math.round(river.river_discharge_m3s)} <small>m³/s</small></strong>
                    <span className={`chip risk-chip-${riskBandFromScore(river.risk_score)}`}>
                      {levelText(riskBandFromScore(river.risk_score))}
                    </span>
                  </div>
                </div>
              ))}
              {!riverWatchTop.length ? <p className="empty-note">River gauges are loading.</p> : null}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <span className="panel-eyebrow">Weather</span>
                <h2>7-day outlook</h2>
              </div>
              <CloudSun size={17} className="panel-icon" />
            </div>
            <div className="weather-strip">
              {weatherForecast.map((item, idx) => (
                <div key={`${item.time}-${idx}`} className={`weather-cell tone-${item.tone}`}>
                  <span>{formatForecastLabel(item.display_time)}</span>
                  <item.Icon size={20} />
                  <strong>{item.label}</strong>
                  <small>{Math.round(item.rain_mm)} mm</small>
                </div>
              ))}
              {!weatherForecast.length ? <p className="empty-note">Weather forecast unavailable.</p> : null}
            </div>
          </div>
        </section>

        <section className="bottom-grid">
          <div className="panel chart-panel">
            <div className="panel-head">
              <div>
                <span className="panel-eyebrow">Trend</span>
                <h2>7-day risk trajectory</h2>
              </div>
              {selected ? <span className="chip subtle">{selected.name}</span> : null}
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={forecastTrendData} margin={{ top: 12, right: 12, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="riskArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.55} />
                      <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 6" stroke="rgba(148, 163, 184, 0.14)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#7c8aa0" }} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#7c8aa0" }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(9, 16, 28, 0.94)",
                      border: "1px solid rgba(148, 163, 184, 0.25)",
                      borderRadius: 12,
                      color: "#e6edf7",
                      fontSize: 12
                    }}
                    labelStyle={{ color: "#94a3b8" }}
                    formatter={(value: number) => [`${value}%`, "Risk trend"]}
                  />
                  <Area type="monotone" dataKey="risk" stroke="#22d3ee" strokeWidth={2.6} fill="url(#riskArea)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="source-line">Blended rainfall, wind, NASA precipitation and river discharge signals.</p>
          </div>

          <div className="panel emergency-panel">
            <div className="panel-head">
              <div>
                <span className="panel-eyebrow">Emergency</span>
                <h2>Bangladesh helplines</h2>
              </div>
              <Phone size={17} className="panel-icon" />
            </div>
            <div className="emergency-grid">
              {bdEmergencyContacts.map((contact) => (
                <a key={contact.name} href={contact.link} className="emergency-item">
                  <span>{contact.name}</span>
                  <strong>{contact.value}</strong>
                </a>
              ))}
            </div>
          </div>
        </section>

        <footer className="footer">
          <div className="footer-brand">
            <img src="/logo.png" alt="" />
            <div>
              <strong>Flood Spaces 2.0</strong>
              <span>Real-time flood intelligence for Bangladesh</span>
            </div>
          </div>

          <div className="footer-meta">
            <span><Droplets size={14} /> Built by Redoyanul Haque · Debmalya Dutta Teertha</span>
            <span><Wind size={14} /> Open-Meteo · NASA · GDACS · Groq</span>
            <span><ShieldCheck size={14} /> Educational forecasting — not an official warning authority</span>
          </div>

          <div className="footer-links">
            <a href="https://redoyanulhaque.me" target="_blank" rel="noreferrer">
              Developer <ExternalLink size={13} />
            </a>
            <span className="footer-sep" />
            <span className="footer-model"><Bot size={14} /> gpt-oss-20b</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
