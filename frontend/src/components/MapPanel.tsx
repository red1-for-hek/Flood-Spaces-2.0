import { useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import type { RiskPoint } from "../types";

type Props = {
  points: RiskPoint[];
  densePoints: RiskPoint[];
  onSelect: (point: RiskPoint) => void;
  onMapClick: (lat: number, lon: number) => void;
  selectedName: string | null;
  highlightPoint: { lat: number; lon: number; name: string } | null;
  highlightAccuracyMeters: number | null;
  mode: "risk" | "rain" | "wind";
  countryBoundary: Record<string, unknown> | null;
  districtBoundaries: Record<string, unknown> | null;
  upazilaBoundaries: Record<string, unknown> | null;
};

const levelColor: Record<string, string> = {
  low: "#2ec27e",
  moderate: "#f6d32d",
  high: "#ff7800",
  severe: "#e01b24",
  flood: "#c01c28"
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

export default function MapPanel({
  points,
  densePoints,
  onSelect,
  onMapClick,
  selectedName,
  highlightPoint,
  highlightAccuracyMeters,
  mode,
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
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "OpenStreetMap contributors"
        }
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }]
    }),
    []
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
          color: p.is_no_data
            ? noDataColor
            : mode === "rain"
              ? gradientColorByValue(p.rainfall_24h_mm, 0, 120)
              : mode === "wind"
                ? gradientColorByValue(p.wind_kmh, 0, 80)
                : levelColor[p.risk_level],
          radius: p.is_true_flood_signal ? 18 : Math.max(8, p.risk_score / 6)
        }
      }))
    }),
    [mode, points]
  );

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
          radius: Math.max(4, p.risk_score / 11)
        }
      }))
    }),
    [densePoints, mode]
  );

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

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: baseStyle as never,
      center: [90.3563, 23.685],
      zoom: 6.2,
      minZoom: 2,
      maxZoom: 18
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    mapRef.current = map;

    map.on("load", () => {
      const empty = { type: "FeatureCollection", features: [] };
      map.addSource("country-boundary", { type: "geojson", data: empty as never });
      map.addSource("district-boundaries", { type: "geojson", data: empty as never });
      map.addSource("upazila-boundaries", { type: "geojson", data: empty as never });
      map.addSource("risk-points", { type: "geojson", data: empty as never });
      map.addSource("dense-risk-points", { type: "geojson", data: empty as never });
      map.addSource("highlight-point", { type: "geojson", data: empty as never });
      map.addSource("highlight-accuracy", { type: "geojson", data: empty as never });

      map.addLayer({
        id: "upazila-boundary-line",
        type: "line",
        source: "upazila-boundaries",
        minzoom: 8,
        paint: {
          "line-color": "#0ea5e9",
          "line-width": 0.45,
          "line-opacity": 0.24,
          "line-dasharray": [1.5, 1.5]
        }
      });

      map.addLayer({
        id: "district-boundary-line",
        type: "line",
        source: "district-boundaries",
        minzoom: 5,
        maxzoom: 9,
        paint: {
          "line-color": "#2563eb",
          "line-width": 0.7,
          "line-opacity": 0.3
        }
      });

      map.addLayer({
        id: "district-label",
        type: "symbol",
        source: "district-boundaries",
        minzoom: 5.5,
        maxzoom: 9,
        layout: {
          "text-field": ["get", "shapeName"],
          "text-font": ["Noto Sans Bengali Regular", "Noto Sans Regular"],
          "text-size": 10
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.1
        }
      });

      map.addLayer({
        id: "upazila-label",
        type: "symbol",
        source: "upazila-boundaries",
        minzoom: 9,
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

      map.addLayer({
        id: "country-boundary-line",
        type: "line",
        source: "country-boundary",
        maxzoom: 6.5,
        paint: {
          "line-color": "#1d4ed8",
          "line-width": 2,
          "line-opacity": 0.8
        }
      });

      map.addLayer({
        id: "dense-risk",
        type: "circle",
        source: "dense-risk-points",
        minzoom: 8,
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["get", "radius"],
          "circle-opacity": 0.24,
          "circle-blur": 0.45
        }
      });

      map.addLayer({
        id: "risk-points-fill",
        type: "circle",
        source: "risk-points",
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["get", "radius"],
          "circle-opacity": [
            "case",
            ["<", ["zoom"], 6.5],
            ["case", ["all", [">=", ["get", "risk_score"], 55], ["==", ["get", "is_no_data"], false]], 0.9, 0],
            ["case", ["==", ["get", "is_no_data"], true], 0.4, 0.86]
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5
        }
      });

      map.on("mousemove", "risk-points-fill", (e) => {
        const feature = e.features?.[0];
        if (!feature) {
          return;
        }
        const p = feature.properties as unknown as RiskPoint;
        map.getCanvas().style.cursor = "pointer";
        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false })
          .setLngLat((feature.geometry as { coordinates: [number, number] }).coordinates)
          .setHTML(
            `<strong>${p.name}</strong><br/>Risk: ${p.is_no_data ? "NO DATA" : p.risk_level.toUpperCase()} (${p.risk_score})<br/>Confidence: ${p.confidence_pct}%<br/>Rain 24h: ${p.rainfall_24h_mm} mm<br/>River: ${p.river_discharge_m3s} m3/s<br/>NASA Precip: ${p.satellite_precip_mm} mm<br/>Wind: ${p.wind_kmh} km/h`
          )
          .addTo(map);

        map.once("mousemove", () => popup.remove());
      });

      map.on("click", "risk-points-fill", (e) => {
        const feature = e.features?.[0];
        if (!feature) {
          return;
        }
        onSelectRef.current(feature.properties as unknown as RiskPoint);
      });

      map.on("click", (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ["risk-points-fill"] });
        if (hits.length) {
          return;
        }
        onMapClickRef.current(e.lngLat.lat, e.lngLat.lng);
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [baseStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) {
      return;
    }

    const source = map.getSource("risk-points") as maplibregl.GeoJSONSource | undefined;
    source?.setData(sourceData as never);

    const denseSource = map.getSource("dense-risk-points") as maplibregl.GeoJSONSource | undefined;
    denseSource?.setData(denseData as never);

    const countrySource = map.getSource("country-boundary") as maplibregl.GeoJSONSource | undefined;
    countrySource?.setData((countryBoundary || { type: "FeatureCollection", features: [] }) as never);

    const districtSource = map.getSource("district-boundaries") as maplibregl.GeoJSONSource | undefined;
    districtSource?.setData((districtBoundaries || { type: "FeatureCollection", features: [] }) as never);

    const upazilaSource = map.getSource("upazila-boundaries") as maplibregl.GeoJSONSource | undefined;
    upazilaSource?.setData((upazilaBoundaries || { type: "FeatureCollection", features: [] }) as never);

    const highlightSource = map.getSource("highlight-point") as maplibregl.GeoJSONSource | undefined;
    highlightSource?.setData(highlightData as never);

    const accuracySource = map.getSource("highlight-accuracy") as maplibregl.GeoJSONSource | undefined;
    accuracySource?.setData(highlightAccuracyData as never);

    if (selectedName) {
      const selected = points.find((p) => p.name === selectedName);
      if (selected) {
        map.flyTo({ center: [selected.lon, selected.lat], zoom: 7.6, speed: 0.6 });
      }
    }
  }, [countryBoundary, denseData, districtBoundaries, highlightAccuracyData, highlightData, points, selectedName, sourceData, upazilaBoundaries]);

  return <div className="map-panel" ref={mapContainerRef} />;
}
