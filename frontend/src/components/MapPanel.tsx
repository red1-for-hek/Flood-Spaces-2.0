import { useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import type { GlobalFloodEvent, RiskPoint } from "../types";

type MapMode = "risk" | "rain" | "wind";

type Props = {
  points: RiskPoint[];
  densePoints: RiskPoint[];
  riverWatchPoints: RiskPoint[];
  onSelect: (point: RiskPoint) => void;
  onMapClick: (lat: number, lon: number, name?: string) => void | Promise<unknown>;
  selectedName: string | null;
  highlightPoint: { lat: number; lon: number; name: string } | null;
  highlightAccuracyMeters: number | null;
  mode: MapMode;
  globalFloodEvents: GlobalFloodEvent[];
  countryBoundary: Record<string, unknown> | null;
  districtBoundaries: Record<string, unknown> | null;
  upazilaBoundaries: Record<string, unknown> | null;
};

type GenericFeature = {
  type: "Feature";
  geometry: {
    type: string;
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
};

type GenericFeatureCollection = {
  type: "FeatureCollection";
  features: GenericFeature[];
};

const levelColor: Record<string, string> = {
  low: "#22c55e",
  moderate: "#f59e0b",
  high: "#f97316",
  severe: "#dc2626",
  flood: "#7f1d1d"
};

const noDataColor = "#9ca3af";

function gradientColorByValue(value: number, min: number, max: number): string {
  const ratio = Math.max(0, Math.min(1, (value - min) / Math.max(1, max - min)));
  const r = Math.round(46 + ratio * 208);
  const g = Math.round(194 - ratio * 140);
  const b = Math.round(126 - ratio * 80);
  return `rgb(${r}, ${g}, ${b})`;
}

function destinationPoint(lat: number, lon: number, bearingRad: number, distanceM: number): [number, number] {
  const radius = 6378137;
  const delta = distanceM / radius;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lon * Math.PI) / 180;

  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(bearingRad)
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );

  return [((lambda2 * 180) / Math.PI + 540) % 360 - 180, (phi2 * 180) / Math.PI];
}

function viewportWidthKm(map: Map): number {
  const bounds = map.getBounds();
  let lonSpan = Math.abs(bounds.getEast() - bounds.getWest());
  if (lonSpan > 180) {
    lonSpan = 360 - lonSpan;
  }
  const latitudeFactor = Math.cos((map.getCenter().lat * Math.PI) / 180);
  return Math.max(0, lonSpan * 111.32 * Math.max(0.1, latitudeFactor));
}

function emptyFeatureCollection(): GenericFeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return fallback;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return Boolean(value);
}

function nearestRiskPoint(lat: number, lon: number, points: RiskPoint[]): RiskPoint | null {
  if (!points.length) {
    return null;
  }

  let nearest = points[0];
  let minDistance = Number.POSITIVE_INFINITY;

  for (const point of points) {
    const dLat = lat - point.lat;
    const dLon = lon - point.lon;
    const distance = dLat * dLat + dLon * dLon;
    if (distance < minDistance) {
      minDistance = distance;
      nearest = point;
    }
  }

  return nearest;
}

function centroidFromRing(ring: Array<[number, number]>): [number, number] | null {
  if (ring.length < 3) {
    return null;
  }

  let twiceArea = 0;
  let xAccumulator = 0;
  let yAccumulator = 0;

  for (let idx = 0; idx < ring.length - 1; idx += 1) {
    const [x1, y1] = ring[idx];
    const [x2, y2] = ring[idx + 1];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    xAccumulator += (x1 + x2) * cross;
    yAccumulator += (y1 + y2) * cross;
  }

  if (Math.abs(twiceArea) < 1e-9) {
    const sum = ring.reduce<[number, number]>((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return [sum[0] / ring.length, sum[1] / ring.length];
  }

  return [xAccumulator / (3 * twiceArea), yAccumulator / (3 * twiceArea)];
}

function asRing(rawRing: unknown): Array<[number, number]> {
  if (!Array.isArray(rawRing)) {
    return [];
  }

  const ring: Array<[number, number]> = [];
  for (const entry of rawRing) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const lon = toNumber(entry[0], Number.NaN);
    const lat = toNumber(entry[1], Number.NaN);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      ring.push([lon, lat]);
    }
  }
  return ring;
}

function areaMagnitude(ring: Array<[number, number]>): number {
  let area = 0;
  for (let idx = 0; idx < ring.length - 1; idx += 1) {
    const [x1, y1] = ring[idx];
    const [x2, y2] = ring[idx + 1];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

function geometryCentroid(geometry: unknown): [number, number] | null {
  if (!geometry || typeof geometry !== "object") {
    return null;
  }

  const typed = geometry as { type?: unknown; coordinates?: unknown };
  const geometryType = String(typed.type || "");

  if (geometryType === "Polygon") {
    if (!Array.isArray(typed.coordinates) || !typed.coordinates.length) {
      return null;
    }
    const outerRing = asRing((typed.coordinates as unknown[])[0]);
    return centroidFromRing(outerRing);
  }

  if (geometryType === "MultiPolygon") {
    if (!Array.isArray(typed.coordinates) || !typed.coordinates.length) {
      return null;
    }

    let bestRing: Array<[number, number]> | null = null;
    let bestArea = -1;

    for (const polygon of typed.coordinates as unknown[]) {
      if (!Array.isArray(polygon) || !polygon.length) {
        continue;
      }
      const ring = asRing((polygon as unknown[])[0]);
      const area = areaMagnitude(ring);
      if (area > bestArea) {
        bestArea = area;
        bestRing = ring;
      }
    }

    return bestRing ? centroidFromRing(bestRing) : null;
  }

  if (geometryType === "Point") {
    if (!Array.isArray(typed.coordinates) || typed.coordinates.length < 2) {
      return null;
    }
    const lon = toNumber((typed.coordinates as unknown[])[0], Number.NaN);
    const lat = toNumber((typed.coordinates as unknown[])[1], Number.NaN);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return null;
    }
    return [lon, lat];
  }

  return null;
}

function pointColor(point: RiskPoint | null, mode: MapMode): string {
  if (!point || point.is_no_data) {
    return noDataColor;
  }
  if (mode === "rain") {
    return gradientColorByValue(point.rainfall_24h_mm, 0, 120);
  }
  if (mode === "wind") {
    return gradientColorByValue(point.wind_kmh, 0, 80);
  }
  return levelColor[point.risk_level] || levelColor.low;
}

function featureName(properties: Record<string, unknown>, index: number, prefix: string): string {
  const named =
    properties.shapeName || properties.name || properties.district || properties.upazila || properties.NAME_2 || properties.NAME_3;
  const value = String(named || "").trim();
  if (value) {
    return value;
  }
  return `${prefix} ${index + 1}`;
}

function buildBoundaryIndicatorData(
  boundaryGeojson: Record<string, unknown> | null,
  fallbackPoints: RiskPoint[],
  mode: MapMode,
  prefix: string
): GenericFeatureCollection {
  const maybeFeatures =
    boundaryGeojson && typeof boundaryGeojson === "object"
      ? (boundaryGeojson as { features?: unknown }).features
      : undefined;
  const rawFeatures = Array.isArray(maybeFeatures) ? (maybeFeatures as Array<Record<string, unknown>>) : [];

  const features: GenericFeature[] = rawFeatures
    .map((feature, index) => {
      const geometry = (feature.geometry as unknown) || null;
      const centroid = geometryCentroid(geometry);
      if (!centroid) {
        return null;
      }

      const [lon, lat] = centroid;
      const nearest = nearestRiskPoint(lat, lon, fallbackPoints);
      const properties = (feature.properties as Record<string, unknown>) || {};
      const name = featureName(properties, index, prefix);

      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [lon, lat]
        },
        properties: {
          name,
          lat,
          lon,
          risk_score: nearest?.risk_score ?? 0,
          risk_level: nearest?.risk_level ?? "low",
          confidence_pct: nearest?.confidence_pct ?? 0,
          rainfall_24h_mm: nearest?.rainfall_24h_mm ?? 0,
          river_discharge_m3s: nearest?.river_discharge_m3s ?? 0,
          satellite_precip_mm: nearest?.satellite_precip_mm ?? 0,
          wind_kmh: nearest?.wind_kmh ?? 0,
          is_no_data: nearest?.is_no_data ?? true,
          source_point: nearest?.name ?? null,
          color: pointColor(nearest, mode)
        }
      } as GenericFeature;
    })
    .filter((feature): feature is GenericFeature => Boolean(feature));

  if (features.length) {
    return {
      type: "FeatureCollection",
      features
    };
  }

  return {
    type: "FeatureCollection",
    features: fallbackPoints.map((point) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [point.lon, point.lat]
      },
      properties: {
        ...point,
        color: pointColor(point, mode),
        source_point: point.name
      }
    }))
  };
}

function buildHexData(sourceData: GenericFeatureCollection): GenericFeatureCollection {
  const features = sourceData.features
    .map((feature) => {
      if (feature.geometry.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) {
        return null;
      }

      const point = feature.geometry.coordinates as unknown[];
      const lon = toNumber(point[0], Number.NaN);
      const lat = toNumber(point[1], Number.NaN);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return null;
      }

      const riskScore = toNumber(feature.properties.risk_score, 0);
      const isNoData = toBoolean(feature.properties.is_no_data);
      const hexRadiusM = isNoData ? 11000 : 13000 + riskScore * 110;
      const ring: Array<[number, number]> = [];

      for (let step = 0; step <= 6; step += 1) {
        const bearing = (step * Math.PI) / 3 + Math.PI / 6;
        ring.push(destinationPoint(lat, lon, bearing, hexRadiusM));
      }

      return {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [ring]
        },
        properties: {
          ...feature.properties,
          hex_radius_m: Math.round(hexRadiusM)
        }
      } as GenericFeature;
    })
    .filter((feature): feature is GenericFeature => Boolean(feature));

  return {
    type: "FeatureCollection",
    features
  };
}

function popupMarkup(properties: Record<string, unknown>): string {
  const name = String(properties.name || "Selected Area");
  const riverName = properties.river_name ? String(properties.river_name) : "";
  const rawLevel = String(properties.risk_level || "low").toLowerCase();
  const level = rawLevel === "low" ? "NORMAL" : rawLevel.toUpperCase();
  const score = toNumber(properties.risk_score, 0);
  const confidence = toNumber(properties.confidence_pct, 0);
  const rain = toNumber(properties.rainfall_24h_mm, 0);
  const river = toNumber(properties.river_discharge_m3s, 0);
  const nasa = toNumber(properties.satellite_precip_mm, 0);
  const wind = toNumber(properties.wind_kmh, 0);
  const sourcePoint = properties.source_point ? `<br/>Nearest forecast point: ${String(properties.source_point)}` : "";

  const riverTag = riverName ? `<br/>River: ${riverName}` : "";
  return `<strong>${name}</strong>${riverTag}<br/>Risk: ${level} (${score})<br/>Confidence: ${confidence}%<br/>Rain 24h: ${rain} mm<br/>River: ${river} m3/s<br/>NASA Precip: ${nasa} mm<br/>Wind: ${wind} km/h${sourcePoint}`;
}

export default function MapPanel({
  points,
  densePoints,
  riverWatchPoints,
  onSelect,
  onMapClick,
  selectedName,
  highlightPoint,
  highlightAccuracyMeters,
  mode,
  globalFloodEvents,
  countryBoundary,
  districtBoundaries,
  upazilaBoundaries
}: Props) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const onSelectRef = useRef(onSelect);
  const onMapClickRef = useRef(onMapClick);

  useEffect(() => {
    onSelectRef.current = onSelect;
    onMapClickRef.current = onMapClick;
  }, [onMapClick, onSelect]);

  const baseStyle = useMemo(
    () => ({
      version: 8,
      glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
      sources: {
        cartoLight: {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
          ],
          tileSize: 256,
          attribution: "OpenStreetMap contributors, CARTO"
        }
      },
      layers: [{ id: "carto-light", type: "raster", source: "cartoLight" }]
    }),
    []
  );

  const countryVisibleNames = useMemo(
    () =>
      new Set(
        points
          .filter((p) => !p.is_no_data)
          .sort((a, b) => b.risk_score - a.risk_score)
          .slice(0, 6)
          .map((p) => p.name)
      ),
    [points]
  );

  const sourceData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: points.map((p) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [p.lon, p.lat]
        },
        properties: {
          ...p,
          country_visible: countryVisibleNames.has(p.name),
          color: p.is_no_data
            ? noDataColor
            : mode === "rain"
              ? gradientColorByValue(p.rainfall_24h_mm, 0, 120)
              : mode === "wind"
                ? gradientColorByValue(p.wind_kmh, 0, 80)
                : levelColor[p.risk_level],
          radius: p.is_true_flood_signal ? 22 : Math.max(10, p.risk_score / 5.5)
        }
      }))
    }),
    [countryVisibleNames, mode, points]
  ) as GenericFeatureCollection;

  const denseData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: densePoints.map((p) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [p.lon, p.lat]
        },
        properties: {
          ...p,
          color: p.is_no_data
            ? noDataColor
            : mode === "rain"
              ? gradientColorByValue(p.rainfall_24h_mm, 0, 120)
              : mode === "wind"
                ? gradientColorByValue(p.wind_kmh, 0, 80)
                : levelColor[p.risk_level],
          radius: Math.max(4.5, p.risk_score / 10)
        }
      }))
    }),
    [densePoints, mode]
  );

  const riverWatchData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: riverWatchPoints.map((point) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [point.lon, point.lat]
        },
        properties: {
          ...point,
          color: "#0ea5e9",
          radius: Math.max(5.5, point.risk_score / 8.5),
          river_name: point.river_name || "River Watch"
        }
      }))
    }),
    [riverWatchPoints]
  );

  const districtIndicatorData = useMemo(
    () => buildBoundaryIndicatorData(districtBoundaries, points, mode, "District"),
    [districtBoundaries, mode, points]
  );

  const upazilaIndicatorData = useMemo(() => {
    const upazilaReference = densePoints.length ? [...densePoints, ...points] : points;
    return buildBoundaryIndicatorData(upazilaBoundaries, upazilaReference, mode, "Upazila");
  }, [densePoints, mode, points, upazilaBoundaries]);

  const districtRenderData = useMemo(
    () => (districtIndicatorData.features.length ? districtIndicatorData : sourceData),
    [districtIndicatorData, sourceData]
  );

  const upazilaRenderData = useMemo(
    () => (upazilaIndicatorData.features.length ? upazilaIndicatorData : districtRenderData),
    [districtRenderData, upazilaIndicatorData]
  );

  const hexData = useMemo(() => buildHexData(districtRenderData), [districtRenderData]);

  const highlightData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: highlightPoint
        ? [
            {
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: [highlightPoint.lon, highlightPoint.lat]
              },
              properties: {
                name: highlightPoint.name
              }
            }
          ]
        : []
    }),
    [highlightPoint]
  );

  const highlightAccuracyData = useMemo(() => {
    if (!highlightPoint || !highlightAccuracyMeters || highlightAccuracyMeters <= 0) {
      return { type: "FeatureCollection", features: [] };
    }

    const ring: Array<[number, number]> = [];
    const steps = 40;
    for (let idx = 0; idx <= steps; idx += 1) {
      const bearing = (idx / steps) * Math.PI * 2;
      ring.push(destinationPoint(highlightPoint.lat, highlightPoint.lon, bearing, highlightAccuracyMeters));
    }

    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [ring]
          },
          properties: {
            radius_m: Math.round(highlightAccuracyMeters)
          }
        }
      ]
    };
  }, [highlightAccuracyMeters, highlightPoint]);

  const globalFloodEventData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: globalFloodEvents.map((event) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [event.lon, event.lat]
        },
        properties: {
          name: event.title,
          title: event.title,
          source: event.source,
          observed_at: event.observed_at,
          severity: event.severity,
          risk_score: Math.max(88, event.risk_hint || 88),
          risk_level: "flood",
          confidence_pct: 95,
          rainfall_1h_mm: 0,
          rainfall_6h_mm: 0,
          rainfall_24h_mm: 0,
          river_discharge_m3s: 0,
          satellite_precip_mm: 0,
          wind_kmh: 0,
          is_no_data: false,
          is_true_flood_signal: true,
          source_point: String(event.source || "Live Flood Feed"),
          color: "#7f1d1d",
          radius: event.severity === "emergency" ? 16 : event.severity === "warning" ? 13 : 11
        }
      }))
    }),
    [globalFloodEvents]
  ) as GenericFeatureCollection;

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: baseStyle as never,
      center: [15, 20],
      zoom: 2.2,
      minZoom: 1,
      maxZoom: 18
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    mapRef.current = map;

    map.on("load", () => {
      const empty = emptyFeatureCollection();
      map.addSource("country-boundary", { type: "geojson", data: empty as never });
      map.addSource("district-boundaries", { type: "geojson", data: empty as never });
      map.addSource("upazila-boundaries", { type: "geojson", data: empty as never });
      map.addSource("risk-points", { type: "geojson", data: empty as never });
      map.addSource("district-indicators", { type: "geojson", data: empty as never });
      map.addSource("upazila-indicators", { type: "geojson", data: empty as never });
      map.addSource("risk-hexes", { type: "geojson", data: empty as never });
      map.addSource("dense-risk-points", { type: "geojson", data: empty as never });
      map.addSource("river-watch-points", { type: "geojson", data: empty as never });
      map.addSource("global-flood-events", { type: "geojson", data: empty as never });
      map.addSource("highlight-point", { type: "geojson", data: empty as never });
      map.addSource("highlight-accuracy", { type: "geojson", data: empty as never });

      map.addLayer({
        id: "upazila-boundary-line",
        type: "line",
        source: "upazila-boundaries",
        minzoom: 8.7,
        paint: {
          "line-color": "#1f2937",
          "line-width": 0.55,
          "line-opacity": 0.32,
          "line-dasharray": [1.6, 1.6]
        }
      });

      map.addLayer({
        id: "district-boundary-line",
        type: "line",
        source: "district-boundaries",
        minzoom: 5,
        maxzoom: 9.25,
        paint: {
          "line-color": "#111827",
          "line-width": 1.05,
          "line-opacity": 0.72
        }
      });

      map.addLayer({
        id: "country-boundary-line",
        type: "line",
        source: "country-boundary",
        minzoom: 4,
        maxzoom: 11.6,
        paint: {
          "line-color": "#020617",
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.2, 7, 3.1, 11, 2],
          "line-opacity": 0.96
        }
      });

      map.addLayer({
        id: "district-label",
        type: "symbol",
        source: "district-boundaries",
        minzoom: 5.7,
        maxzoom: 9.1,
        layout: {
          "text-field": ["get", "shapeName"],
          "text-font": ["Noto Sans Bengali Regular", "Noto Sans Regular"],
          "text-size": 10
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2
        }
      });

      map.addLayer({
        id: "upazila-label",
        type: "symbol",
        source: "upazila-boundaries",
        minzoom: 9.2,
        layout: {
          "text-field": ["get", "shapeName"],
          "text-font": ["Noto Sans Bengali Regular", "Noto Sans Regular"],
          "text-size": 9
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1
        }
      });

      map.addLayer({
        id: "risk-hex-fill",
        type: "fill",
        source: "risk-hexes",
        minzoom: 3.8,
        filter: ["all", ["!", ["get", "is_no_data"]], [">=", ["get", "risk_score"], 45]],
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": ["case", ["==", ["get", "is_no_data"], true], 0.2, 0.5]
        }
      });

      map.addLayer({
        id: "risk-hex-outline",
        type: "line",
        source: "risk-hexes",
        minzoom: 3.8,
        filter: ["all", ["!", ["get", "is_no_data"]], [">=", ["get", "risk_score"], 45]],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 1.1,
          "line-opacity": 0.62
        }
      });

      map.addLayer({
        id: "global-risk-dot",
        type: "circle",
        source: "risk-points",
        minzoom: 1,
        maxzoom: 4.8,
        filter: ["all", ["!", ["get", "is_no_data"]], [">=", ["get", "risk_score"], 45]],
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3.2, 4.8, 6.5],
          "circle-opacity": 0.86,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 0.95
        }
      });

      map.addLayer({
        id: "district-risk-dot",
        type: "circle",
        source: "district-indicators",
        minzoom: 5.8,
        maxzoom: 9.15,
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["linear"], ["get", "risk_score"], 0, 6, 100, 14],
          "circle-opacity": ["case", ["==", ["get", "is_no_data"], true], 0.52, 0.9],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.45
        }
      });

      map.addLayer({
        id: "risk-overview-dot",
        type: "circle",
        source: "district-indicators",
        minzoom: 4,
        maxzoom: 6.3,
        filter: ["all", ["!", ["get", "is_no_data"]], [">=", ["get", "risk_score"], 45]],
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3.5, 6.3, 5.5],
          "circle-opacity": ["case", ["==", ["get", "is_no_data"], true], 0.22, 0.75],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 0.9
        }
      });

      map.addLayer({
        id: "dense-risk",
        type: "circle",
        source: "dense-risk-points",
        minzoom: 8.8,
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["get", "radius"],
          "circle-opacity": 0.24,
          "circle-blur": 0.45
        }
      });

      map.addLayer({
        id: "river-watch-dot",
        type: "circle",
        source: "river-watch-points",
        minzoom: 5.5,
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5.5, 5.5, 12, 10],
          "circle-opacity": 0.85,
          "circle-stroke-color": "#0369a1",
          "circle-stroke-width": 1.6
        }
      });

      map.addLayer({
        id: "upazila-risk-pin-tail",
        type: "symbol",
        source: "upazila-indicators",
        minzoom: 9.15,
        layout: {
          "text-field": "▼",
          "text-font": ["Noto Sans Bengali Bold", "Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 9.2, 12.5, 12, 16],
          "text-offset": [0, 0.65],
          "text-anchor": "top",
          "text-allow-overlap": true,
          "text-ignore-placement": true
        },
        paint: {
          "text-color": ["get", "color"],
          "text-halo-color": "rgba(255, 255, 255, 0.86)",
          "text-halo-width": 0.75,
          "text-opacity": ["case", ["==", ["get", "is_no_data"], true], 0.45, 0.95]
        }
      });

      map.addLayer({
        id: "upazila-risk-pin-head",
        type: "circle",
        source: "upazila-indicators",
        minzoom: 9.15,
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9.2, 6.5, 12, 9.5],
          "circle-opacity": ["case", ["==", ["get", "is_no_data"], true], 0.55, 0.95],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.25
        }
      });

      map.addLayer({
        id: "upazila-risk-pin-core",
        type: "circle",
        source: "upazila-indicators",
        minzoom: 9.15,
        paint: {
          "circle-color": "#ffffff",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9.2, 1.3, 12, 2.25],
          "circle-opacity": 0.92
        }
      });

      map.addLayer({
        id: "global-flood-halo",
        type: "circle",
        source: "global-flood-events",
        paint: {
          "circle-color": "rgba(127, 29, 29, 0.22)",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 24, 5, 38, 10, 56],
          "circle-opacity": 0.9,
          "circle-blur": 0.68,
          "circle-stroke-color": "rgba(127, 29, 29, 0.36)",
          "circle-stroke-width": 1.3
        }
      });

      map.addLayer({
        id: "global-flood-spread",
        type: "circle",
        source: "global-flood-events",
        paint: {
          "circle-color": "rgba(120, 18, 18, 0.12)",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 32, 5, 52, 10, 72],
          "circle-opacity": 0.88,
          "circle-blur": 0.58
        }
      });

      map.addLayer({
        id: "global-flood-core",
        type: "circle",
        source: "global-flood-events",
        paint: {
          "circle-color": "#991b1b",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 9, 5, 14, 10, 21],
          "circle-opacity": 0.92,
          "circle-stroke-color": "#fee2e2",
          "circle-stroke-width": 1.6
        }
      });

      const setVisibility = (layerId: string, isVisible: boolean) => {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, "visibility", isVisible ? "visible" : "none");
        }
      };

      const syncRiskSignalRendering = () => {
        const compactView = viewportWidthKm(map) <= 300;
        const riskDotLayers = [
          "global-risk-dot",
          "district-risk-dot",
          "risk-overview-dot",
          "dense-risk",
          "river-watch-dot",
          "upazila-risk-pin-tail",
          "upazila-risk-pin-head",
          "upazila-risk-pin-core"
        ];
        const riskHexLayers = ["risk-hex-fill", "risk-hex-outline"];

        for (const layerId of riskDotLayers) {
          setVisibility(layerId, !compactView);
        }
        for (const layerId of riskHexLayers) {
          setVisibility(layerId, compactView);
        }
      };

      syncRiskSignalRendering();
      map.on("zoomend", syncRiskSignalRendering);
      map.on("moveend", syncRiskSignalRendering);

      map.addLayer({
        id: "highlight-accuracy-fill",
        type: "fill",
        source: "highlight-accuracy",
        paint: {
          "fill-color": "#38bdf8",
          "fill-opacity": 0.12
        }
      });

      map.addLayer({
        id: "highlight-accuracy-outline",
        type: "line",
        source: "highlight-accuracy",
        paint: {
          "line-color": "#0284c7",
          "line-width": 1.4,
          "line-opacity": 0.65
        }
      });

      map.addLayer({
        id: "highlight-ring",
        type: "circle",
        source: "highlight-point",
        paint: {
          "circle-color": "rgba(14, 165, 233, 0.2)",
          "circle-radius": 18,
          "circle-opacity": 0.9,
          "circle-stroke-color": "#0f172a",
          "circle-stroke-width": 1.5
        }
      });

      map.addLayer({
        id: "highlight-label",
        type: "symbol",
        source: "highlight-point",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Bengali Regular", "Noto Sans Regular"],
          "text-size": 12,
          "text-offset": [0, 1.4],
          "text-anchor": "top"
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5
        }
      });

      const interactiveLayers = [
        "global-flood-core",
        "global-risk-dot",
        "risk-hex-fill",
        "risk-overview-dot",
        "district-risk-dot",
        "river-watch-dot",
        "upazila-risk-pin-head",
        "upazila-risk-pin-tail"
      ];
      const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

      interactiveLayers.forEach((layerId) => {
        map.on("mousemove", layerId, (event) => {
          const feature = event.features?.[0];
          if (!feature) {
            return;
          }

          const properties = (feature.properties || {}) as Record<string, unknown>;
          map.getCanvas().style.cursor = "pointer";
          hoverPopup.setLngLat(event.lngLat).setHTML(popupMarkup(properties)).addTo(map);
        });

        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
          hoverPopup.remove();
        });

        map.on("click", layerId, (event) => {
          const feature = event.features?.[0];
          if (!feature) {
            return;
          }

          const properties = (feature.properties || {}) as Record<string, unknown>;
          const selected = {
            name: String(properties.name || "Selected Area"),
            lat: event.lngLat.lat,
            lon: event.lngLat.lng,
            rainfall_1h_mm: toNumber(properties.rainfall_1h_mm, 0),
            rainfall_6h_mm: toNumber(properties.rainfall_6h_mm, 0),
            rainfall_24h_mm: toNumber(properties.rainfall_24h_mm, 0),
            satellite_precip_mm: toNumber(properties.satellite_precip_mm, 0),
            river_discharge_m3s: toNumber(properties.river_discharge_m3s, 0),
            temperature_c: toNumber(properties.temperature_c, 0),
            wind_kmh: toNumber(properties.wind_kmh, 0),
            risk_score: toNumber(properties.risk_score, 0),
            risk_level: String(properties.risk_level || "low") as RiskPoint["risk_level"],
            confidence_pct: toNumber(properties.confidence_pct, 0),
            satellite_water_anomaly: toNumber(properties.satellite_water_anomaly, 0),
            forecast_steps: [],
            has_live_data: true,
            is_no_data: toBoolean(properties.is_no_data),
            is_true_flood_signal: String(properties.risk_level || "").toLowerCase() === "flood"
          } satisfies RiskPoint;

          onSelectRef.current(selected);
          onMapClickRef.current(event.lngLat.lat, event.lngLat.lng, selected.name);
        });
      });

      map.on("click", (event) => {
        const hits = map.queryRenderedFeatures(event.point, { layers: interactiveLayers });
        if (hits.length) {
          return;
        }
        onMapClickRef.current(event.lngLat.lat, event.lngLat.lng);
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [baseStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const syncSources = () => {
      const countrySource = map.getSource("country-boundary") as maplibregl.GeoJSONSource | undefined;
      countrySource?.setData((countryBoundary || emptyFeatureCollection()) as never);

      const districtBoundarySource = map.getSource("district-boundaries") as maplibregl.GeoJSONSource | undefined;
      districtBoundarySource?.setData((districtBoundaries || emptyFeatureCollection()) as never);

      const upazilaBoundarySource = map.getSource("upazila-boundaries") as maplibregl.GeoJSONSource | undefined;
      upazilaBoundarySource?.setData((upazilaBoundaries || emptyFeatureCollection()) as never);

      const districtIndicatorSource = map.getSource("district-indicators") as maplibregl.GeoJSONSource | undefined;
      districtIndicatorSource?.setData(districtRenderData as never);

      const sourcePoints = map.getSource("risk-points") as maplibregl.GeoJSONSource | undefined;
      sourcePoints?.setData(sourceData as never);

      const upazilaIndicatorSource = map.getSource("upazila-indicators") as maplibregl.GeoJSONSource | undefined;
      upazilaIndicatorSource?.setData(upazilaRenderData as never);

      const hexSource = map.getSource("risk-hexes") as maplibregl.GeoJSONSource | undefined;
      hexSource?.setData(hexData as never);

      const denseSource = map.getSource("dense-risk-points") as maplibregl.GeoJSONSource | undefined;
      denseSource?.setData(denseData as never);

      const riverSource = map.getSource("river-watch-points") as maplibregl.GeoJSONSource | undefined;
      riverSource?.setData(riverWatchData as never);

      const floodEventSource = map.getSource("global-flood-events") as maplibregl.GeoJSONSource | undefined;
      floodEventSource?.setData(globalFloodEventData as never);

      const highlightSource = map.getSource("highlight-point") as maplibregl.GeoJSONSource | undefined;
      highlightSource?.setData(highlightData as never);

      const accuracySource = map.getSource("highlight-accuracy") as maplibregl.GeoJSONSource | undefined;
      accuracySource?.setData(highlightAccuracyData as never);

    };

    if (map.isStyleLoaded()) {
      syncSources();
      return;
    }

    map.once("load", syncSources);
  }, [
    countryBoundary,
    denseData,
    districtBoundaries,
    districtRenderData,
    globalFloodEventData,
    hexData,
    highlightAccuracyData,
    highlightData,
    points,
    riverWatchData,
    sourceData,
    selectedName,
    upazilaBoundaries,
    upazilaRenderData
  ]);

  return <div className="map-panel" ref={mapContainerRef} />;
}
