// Minimal MapLibre stub so the React tree can render under jsdom (no WebGL).
type Handler = (...args: unknown[]) => void;

export class Map {
  private handlers: Record<string, Handler[]> = {};
  private layers: unknown[] = [];
  constructor(opts: unknown) {
    // Exposed so smoke tests can assert which basemap the panel requested.
    (globalThis as Record<string, unknown>).__maplibreLastStyle = (
      opts as { style?: unknown } | undefined
    )?.style;
  }
  addControl() {}
  addSource() {}
  addLayer(layer: unknown) {
    this.layers.push(layer);
    (globalThis as Record<string, unknown>).__maplibreLayers = this.layers;
  }
  getSource(id?: string) {
    return {
      setData: (data: unknown) => {
        const store = ((globalThis as Record<string, unknown>).__maplibreSourceData ||= {}) as Record<
          string,
          unknown
        >;
        store[String(id)] = data;
      },
      setTiles: () => {}
    };
  }
  getLayer() {
    return {};
  }
  setLayoutProperty() {}
  setPaintProperty() {}
  isStyleLoaded() {
    return true;
  }
  on(event: string, ...rest: unknown[]) {
    const handler = rest[rest.length - 1] as Handler;
    this.handlers[event] = [...(this.handlers[event] || []), handler];
    if (event === "load") handler();
  }
  once(event: string, handler: Handler) {
    if (event === "load") handler();
  }
  off() {}
  flyTo() {}
  getZoom() {
    return 6.25;
  }
  getBounds() {
    return {
      getEast: () => 93,
      getWest: () => 88,
      getCenter: () => ({ lat: 23.7, lon: 90.3 })
    };
  }
  getCenter() {
    return { lat: 23.7, lon: 90.3 };
  }
  getCanvas() {
    return { style: {} as CSSStyleDeclaration };
  }
  queryRenderedFeatures() {
    return [];
  }
  remove() {}
}

export class Popup {
  setLngLat() {
    return this;
  }
  setHTML() {
    return this;
  }
  addTo() {
    return this;
  }
  remove() {}
}

export class NavigationControl {}
export class ScaleControl {}
export class AttributionControl {}
export class RasterTileSource {}
export class GeoJSONSource {}

export default { Map, Popup, NavigationControl, ScaleControl, AttributionControl };
