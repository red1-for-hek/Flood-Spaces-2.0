import { useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import type { RiskPoint } from "../types";

type Props = {
  points: RiskPoint[];
  densePoints: RiskPoint[];
  onSelect: (point: RiskPoint) => void;
  onMapClick: (lat: number, lon: number) => void;
  selectedName: string | null;
  mode: "risk" | "rain" | "wind";
  countryBoundary: Record<string, unknown> | null;
  districtBoundaries: Record<string, unknown> | null;
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

export default function MapPanel({
  points,
  densePoints,
  onSelect,
  onMapClick,
  selectedName,
  mode,
  countryBoundary,
  districtBoundaries
}: Props) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);

  const baseStyle = useMemo(
    () => ({
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: [
            "https://a.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
            "https://b.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
            "https://c.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png"
          ],
          tileSize: 256,
          attribution: "OpenStreetMap France"
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
      map.addSource("country-boundary", { type: "geojson", data: (countryBoundary || { type: "FeatureCollection", features: [] }) as never });
      map.addSource("district-boundaries", { type: "geojson", data: (districtBoundaries || { type: "FeatureCollection", features: [] }) as never });
      map.addSource("risk-points", { type: "geojson", data: sourceData as never });
      map.addSource("dense-risk-points", { type: "geojson", data: denseData as never });

      map.addLayer({
        id: "district-boundary-line",
        type: "line",
        source: "district-boundaries",
        paint: {
          "line-color": "#2563eb",
          "line-width": 0.8,
          "line-opacity": 0.38
        }
      });

      map.addLayer({
        id: "country-boundary-line",
        type: "line",
        source: "country-boundary",
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
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["get", "radius"],
          "circle-opacity": 0.34,
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
          "circle-opacity": 0.88,
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
        onSelect(feature.properties as unknown as RiskPoint);
      });

      map.on("click", (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ["risk-points-fill"] });
        if (hits.length) {
          return;
        }
        onMapClick(e.lngLat.lat, e.lngLat.lng);
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [baseStyle, countryBoundary, denseData, districtBoundaries, onMapClick, onSelect, sourceData]);

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

    if (selectedName) {
      const selected = points.find((p) => p.name === selectedName);
      if (selected) {
        map.flyTo({ center: [selected.lon, selected.lat], zoom: 7.6, speed: 0.6 });
      }
    }
  }, [countryBoundary, denseData, districtBoundaries, points, selectedName, sourceData]);

  return <div className="map-panel" ref={mapContainerRef} />;
}
