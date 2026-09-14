import type { GeoLibreAppAPI, GeoLibrePlugin } from "./lib/geolibre/host-api";
import { ContourManager } from "./lib/contour/ContourManager";
import { registerContourPanel } from "./lib/geolibre/contour-panel";

import "./lib/styles/contour.css";

let manager: ContourManager;
let disposePanel: (() => void) | null = null;

export const plugin: GeoLibrePlugin = {
  id: "geolibre-contour",
  name: "Contour Lines from DEM",
  version: "0.3.8",
  engines: ["maplibre"],
  urlParameterNames: ["contourCogUrl"],

  activate(app: GeoLibreAppAPI) {
    manager = new ContourManager(app);
    disposePanel = registerContourPanel(app, manager);
  },

  deactivate(app: GeoLibreAppAPI) {
    if (disposePanel) {
      disposePanel();
      disposePanel = null;
    }
    if (manager) {
      manager.teardown();
    }
  },

  async handleUrlParameters(
    app: GeoLibreAppAPI,
    params: URLSearchParams,
  ) {
    const cogUrl = params.get("contourCogUrl");
    if (!cogUrl) return;
    const parsed = new URL(cogUrl);
    if (parsed.protocol !== "https:") return;
    manager.updateConfig({ cogUrl: parsed.href });
    const map = app.getMap?.();
    if (!map) return;
    await manager.setup(map);
  },
};

export default plugin;
