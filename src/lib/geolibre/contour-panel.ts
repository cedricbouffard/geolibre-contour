import type { GeoLibreAppAPI } from "./host-api";
import type { ContourConfig, ContourManager } from "../contour/ContourManager";
import "../styles/contour.css";

export const CONTOUR_PANEL_ID = "geolibre-contour-panel";

const FRENCH_TEXT: Record<string, string> = {
  title: "Courbes de niveau",
  heading: "Courbes COG dynamiques",
  description: "Lire l’altitude depuis un GeoTIFF optimisé et afficher uniquement les courbes dynamiques.",
  source: "Raster DEM chargé",
  raster: "Raster",
  refreshRaster: "Actualiser les rasters chargés",
  noRaster: "Aucun raster COG chargé",
  settings: "Paramètres des courbes",
  cogUrl: "URL du COG",
  interval: "Intervalle (m)",
  majorEvery: "Une ligne majeure toutes les N lignes",
  gridSize: "Grille d’échantillonnage",
  resampling: "Interpolation",
  majorWidth: "Épaisseur des lignes majeures",
  minorWidth: "Épaisseur des lignes mineures",
  labelSize: "Taille des étiquettes",
  apply: "Appliquer les courbes",
  clear: "Effacer",
  errorCogRequired: "Une URL COG est requise.",
  errorRasterRequired: "Chargez d’abord un raster COG dans GeoLibre.",
  errorCogInvalid: "L’URL COG est invalide.",
  errorHttps: "Seules les URL COG HTTPS sont acceptées.",
  errorMap: "La carte n’est pas disponible.",
  applied: "Courbes appliquées. Elles se mettent à jour lorsque la carte se déplace.",
  errorPrefix: "Erreur",
  cleared: "Courbes supprimées.",
};

function field(
  label: string,
  id: string,
  type: string,
  value: string,
  placeholder: string,
  attrs: Record<string, string> = {},
): { row: HTMLElement; input: HTMLInputElement; label: HTMLLabelElement } {
  const row = document.createElement("div");
  row.className = "contour-field";
  const labelElement = document.createElement("label");
  labelElement.className = "contour-label";
  labelElement.htmlFor = id;
  labelElement.textContent = label;
  const input = document.createElement("input");
  input.className = "contour-input";
  input.id = id;
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  for (const [key, attrValue] of Object.entries(attrs)) input.setAttribute(key, attrValue);
  row.append(labelElement, input);
  return { row, input, label: labelElement };
}

function selectField(
  label: string,
  id: string,
): { row: HTMLElement; select: HTMLSelectElement; label: HTMLLabelElement } {
  const row = document.createElement("div");
  row.className = "contour-field";
  const labelElement = document.createElement("label");
  labelElement.className = "contour-label";
  labelElement.htmlFor = id;
  labelElement.textContent = label;
  const select = document.createElement("select");
  select.className = "contour-select";
  select.id = id;
  row.append(labelElement, select);
  return { row, select, label: labelElement };
}

type LoadedRaster = { id: string; name: string; url: string };

function findLoadedRasters(app: GeoLibreAppAPI): LoadedRaster[] {
  const found = new Map<string, LoadedRaster>();
  const layerNames = new Map((app.listLayers?.() ?? []).map((layer) => [layer.id, layer.name]));
  const add = (url: unknown, id: string, name: string): void => {
    if (typeof url !== "string" || !/^https:\/\//i.test(url) || !/\.(tif|tiff)(?:$|[?#])/i.test(url)) return;
    const fallbackName = url.split("/").pop()?.split("?")[0] || "Loaded raster";
    found.set(url, { id, name: layerNames.get(id) ?? (name === "Source" ? fallbackName : name), url });
  };
  const visit = (value: unknown, path: string[], depth: number, parentName = "Loaded raster"): void => {
    if (!value || depth > 5 || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)], depth + 1, parentName));
      return;
    }
    const record = value as Record<string, unknown>;
    const type = String(record.type ?? record.kind ?? "").toLowerCase();
    const name = String(record.name ?? record.title ?? parentName ?? path.at(-1) ?? "Loaded raster");
    const id = String(record.id ?? path.join("/"));
    if (type.includes("raster") || type.includes("cog") || record.url || record.sourcePath) {
      add(record.url, id, name);
      add(record.sourcePath, id, name);
      if (record.source && typeof record.source === "object") {
        const source = record.source as Record<string, unknown>;
        add(source.url, id, name);
        add(source.sourcePath, id, name);
      }
    }
    for (const [key, child] of Object.entries(record)) visit(child, [...path, key], depth + 1, name);
  };
  visit(app.getProjectSnapshot?.(), ["project"], 0);
  const style = app.getMap?.()?.getStyle?.();
  for (const [id, source] of Object.entries(style?.sources ?? {})) {
    const record = source as Record<string, unknown>;
    add(record.url, id, id);
    if (Array.isArray(record.tiles)) record.tiles.forEach((url) => add(url, id, id));
  }
  return [...found.values()];
}

function populateRasterSelect(select: HTMLSelectElement, rasters: LoadedRaster[], emptyLabel: string): void {
  select.replaceChildren();
  if (rasters.length === 0) {
    const option = document.createElement("option");
    option.textContent = emptyLabel;
    option.value = "";
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
    return;
  }
  for (const raster of rasters) {
    const option = document.createElement("option");
    option.value = raster.url;
    option.textContent = raster.name;
    select.appendChild(option);
  }
}

function applyTheme(container: HTMLElement): void {
  const dark = document.documentElement.classList.contains("dark");
  container.style.setProperty("--contour-bg", dark ? "#1e1e2e" : "#ffffff");
  container.style.setProperty("--contour-text", dark ? "#cdd6f4" : "#1e1e24");
  container.style.setProperty("--contour-border", dark ? "#313244" : "#d1d5db");
  container.style.setProperty("--contour-input-bg", dark ? "#313244" : "#f3f4f6");
  container.style.setProperty("--contour-accent", dark ? "#89b4fa" : "#3b82f6");
}

export function registerContourPanel(
  app: GeoLibreAppAPI,
  manager: ContourManager,
): (() => void) | null {
  if (!app.registerRightPanel) return null;
  const t = (key: string, fallback: string, params?: Record<string, string | number>): string =>
    (app.getLocale?.().toLowerCase().startsWith("fr")
      ? FRENCH_TEXT[key] ?? fallback
      : app.translate?.(`plugin.geolibre-contour.${key}`, fallback, params) ?? fallback);
  let panelContainer: HTMLElement | null = null;
  let unregister: (() => void) | null = null;

  unregister = app.registerRightPanel({
    id: CONTOUR_PANEL_ID,
    title: () => t("title", "Contour Lines"),
    dock: "replace-style",
    defaultWidth: 360,
    render(container) {
      panelContainer = container;
      applyTheme(container);
      const config = manager.getConfig();
      const wrapper = document.createElement("div");
      wrapper.className = "contour-panel";

      const heading = document.createElement("h3");
      heading.className = "contour-heading";
      heading.textContent = "Dynamic COG contours";
      wrapper.appendChild(heading);

      const description = document.createElement("p");
      description.className = "contour-description";
      description.textContent = "Read elevation from a Cloud-Optimized GeoTIFF and display only dynamic contour lines.";
      wrapper.appendChild(description);

      const sourceSection = document.createElement("div");
      sourceSection.className = "contour-section";
      const sourceTitle = document.createElement("h4");
      sourceTitle.className = "contour-section-title";
      sourceTitle.textContent = "Loaded DEM raster";
      sourceSection.appendChild(sourceTitle);
      const raster = selectField("Raster", "contour-loaded-raster");
      const refresh = document.createElement("button");
      refresh.className = "contour-btn contour-btn-secondary";
      refresh.type = "button";
      const refreshRasters = (): void => {
        populateRasterSelect(raster.select, findLoadedRasters(app), t("noRaster", "No loaded COG raster found"));
      };
      refreshRasters();
      refresh.addEventListener("click", refreshRasters);
      sourceSection.append(raster.row, refresh);
      wrapper.appendChild(sourceSection);

      const styleSection = document.createElement("div");
      styleSection.className = "contour-section";
      const styleTitle = document.createElement("h4");
      styleTitle.className = "contour-section-title";
      styleTitle.textContent = "Contour settings";
      styleSection.appendChild(styleTitle);
      const interval = field("Interval (m)", "contour-interval", "number", String(config.interval), "25", { min: "0.1", step: "0.1" });
      const majorEvery = field("Major every N lines", "contour-major-every", "number", String(config.majorEvery), "5", { min: "1", step: "1" });
      const gridSize = field("Sampling grid", "contour-grid-size", "number", String(config.gridSize), "128", { min: "32", max: "512", step: "1" });
      const resampling = selectField("Interpolation", "contour-resampling");
      for (const [value, label] of [["nearest", "Nearest neighbor"], ["bilinear", "Bilinear"]] as const) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = value === config.resampling;
        resampling.select.appendChild(option);
      }
      const majorWidth = field("Major line width", "contour-major-width", "number", String(config.majorWidth), "1.8", { min: "0.1", step: "0.1" });
      const minorWidth = field("Minor line width", "contour-minor-width", "number", String(config.minorWidth), "0.8", { min: "0.1", step: "0.1" });
      const labelSize = field("Label size", "contour-label-size", "number", String(config.labelSize), "10", { min: "6", max: "24", step: "1" });
      for (const row of [interval, majorEvery, gridSize, resampling, majorWidth, minorWidth, labelSize]) styleSection.appendChild(row.row);
      wrapper.appendChild(styleSection);

      const buttons = document.createElement("div");
      buttons.className = "contour-buttons";
      const apply = document.createElement("button");
      apply.className = "contour-btn contour-btn-primary";
      apply.textContent = "Apply contours";
      const clear = document.createElement("button");
      clear.className = "contour-btn contour-btn-secondary";
      clear.textContent = "Clear";
      buttons.append(apply, clear);
      wrapper.appendChild(buttons);

      const status = document.createElement("div");
      status.className = "contour-status";
      wrapper.appendChild(status);
      container.appendChild(wrapper);

      const updateText = (): void => {
        heading.textContent = t("heading", "Dynamic COG contours");
        description.textContent = t("description", "Read elevation from a Cloud-Optimized GeoTIFF and display only dynamic contour lines.");
        sourceTitle.textContent = t("source", "Loaded DEM raster");
        styleTitle.textContent = t("settings", "Contour settings");
        raster.label.textContent = t("raster", "Raster");
        refresh.textContent = t("refreshRaster", "Refresh loaded rasters");
        interval.label.textContent = t("interval", "Interval (m)");
        majorEvery.label.textContent = t("majorEvery", "Major every N lines");
        gridSize.label.textContent = t("gridSize", "Sampling grid");
        resampling.label.textContent = t("resampling", "Interpolation");
        majorWidth.label.textContent = t("majorWidth", "Major line width");
        minorWidth.label.textContent = t("minorWidth", "Minor line width");
        labelSize.label.textContent = t("labelSize", "Label size");
        apply.textContent = t("apply", "Apply contours");
        clear.textContent = t("clear", "Clear");
      };
      updateText();
      const stopLocale = app.onLocaleChange?.(() => updateText());
      manager.setStatusListener((text, kind) => showStatus(status, text, kind));

      apply.addEventListener("click", () => {
        const cogUrl = raster.select.value.trim();
        if (!cogUrl) {
          showStatus(status, t("errorRasterRequired", "Load a COG raster in GeoLibre first."), "error");
          return;
        }
        let parsed: URL;
        try {
          parsed = new URL(cogUrl);
        } catch {
          showStatus(status, t("errorCogInvalid", "The COG URL is invalid."), "error");
          return;
        }
        if (parsed.protocol !== "https:") {
          showStatus(status, t("errorHttps", "Only HTTPS COG URLs are accepted."), "error");
          return;
        }
        manager.updateConfig({
          cogUrl: parsed.href,
          interval: positive(interval.input.value, config.interval),
          majorEvery: Math.max(1, integer(majorEvery.input.value, config.majorEvery)),
          gridSize: Math.min(512, Math.max(32, integer(gridSize.input.value, config.gridSize))),
          resampling: resampling.select.value as "nearest" | "bilinear",
          majorWidth: positive(majorWidth.input.value, config.majorWidth),
          minorWidth: positive(minorWidth.input.value, config.minorWidth),
          labelSize: Math.min(24, Math.max(6, integer(labelSize.input.value, config.labelSize))),
        });
        const map = app.getMap?.();
        if (!map) {
          showStatus(status, t("errorMap", "The map is not available."), "error");
          return;
        }
        showStatus(status, "Reading the COG and generating contour lines...", "loading");
        manager.setup(map)
          .then(() => showStatus(status, t("applied", "Contours applied. They update when the map moves."), "success"))
          .catch((error: unknown) => showStatus(status, `${t("errorPrefix", "Error")}: ${errorMessage(error)}`, "error"));
      });

      clear.addEventListener("click", () => {
        manager.teardown();
        showStatus(status, t("cleared", "Contours removed."), "success");
      });

      return () => {
        manager.setStatusListener(null);
        stopLocale?.();
        wrapper.remove();
      };
    },
    onOpen() {
      if (panelContainer) applyTheme(panelContainer);
    },
  });
  app.openRightPanel?.(CONTOUR_PANEL_ID);

  return () => {
    app.closeRightPanel?.(CONTOUR_PANEL_ID);
    unregister?.();
    unregister = null;
  };
}

function integer(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function showStatus(element: HTMLElement, text: string, kind: "success" | "error" | "loading"): void {
  element.textContent = text;
  element.className = `contour-status contour-status-${kind}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
