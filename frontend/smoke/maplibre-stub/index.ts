// Minimal MapLibre stub so the React tree can render under jsdom (no WebGL).
type Handler = (...args: unknown[]) => void;

export class Map {
  private handlers: Record<string, Handler[]> = {};
  constructor(_opts: unknown) {}
  addControl() {}
  addSource() {}
  addLayer() {}
  getSource() {
    return { setData: () => {}, setTiles: () => {} };
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
