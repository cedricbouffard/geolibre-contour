/**
 * GeoLibre host-plugin contract for the Contour Lines plugin.
 *
 * Based on the documented GeoLibre Plugin API at https://geolibre.app/plugin-api/
 * Extended with the methods needed by the contour plugin.
 */

import type { FeatureCollection } from "geojson";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";

export type GeoLibreMapControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface GeoLibreTileLayerOptions {
  tileSize?: number;
  attribution?: string;
  bounds?: [number, number, number, number];
  minzoom?: number;
  maxzoom?: number;
  scheme?: "xyz" | "tms";
  visible?: boolean;
  opacity?: number;
  beforeLayerId?: string;
}

export interface GeoLibreCogLayerOptions {
  engine?: "maplibre-gl-raster" | "cog-tiler-wasm" | "titiler" | "auto";
  bands?: string;
  colormap?: string;
  rescaleMin?: number;
  rescaleMax?: number;
  nodata?: number;
  opacity?: number;
  beforeLayerId?: string;
}

export interface GeoLibreRightPanelRegistration {
  id: string;
  title: string | (() => string);
  dock?: GeoLibreRightPanelDock;
  icon?: string;
  defaultWidth?: number;
  render: (container: HTMLElement) => void | (() => void);
  onOpen?: () => void;
  onCollapse?: () => void;
  onClose?: () => void;
}

export type GeoLibreRightPanelDock =
  | "left-of-layers"
  | "right-of-layers"
  | "left-of-style"
  | "right-of-style"
  | "replace-style"
  | "replace-layers";

export interface GeoLibreExternalNativeLayerRegistration {
  id: string;
  name: string;
  type?: string;
  source?: Record<string, unknown>;
  nativeLayerIds: string[];
  sourceIds?: string[];
  sourceId?: string;
  opacity?: number;
  metadata?: Record<string, unknown>;
  paintMode?: "geolibre" | "plugin";
}

export interface GeoLibreToolbarMenuItem {
  type?: "action" | "submenu" | "separator";
  id: string;
  label?: string;
  icon?: string;
  disabled?: boolean;
  onSelect?: () => void;
  items?: GeoLibreToolbarMenuItem[];
}

export interface GeoLibreToolbarMenu {
  id: string;
  label: string;
  icon?: string;
  items: GeoLibreToolbarMenuItem[];
}

export interface GeoLibreFloatingPanelRegistration {
  id: string;
  title: string;
  icon?: string;
  defaultWidth?: number;
  render: (container: HTMLElement) => void | (() => void);
  onOpen?: () => void;
  onClose?: () => void;
}

export interface GeoLibreAppAPI {
  getMap?: () => MapLibreMap | null;
  getProjectSnapshot?: () => unknown;
  listLayers?: () => Array<{ id: string; name: string; type: string }>;

  addMapControl: (control: IControl, position?: GeoLibreMapControlPosition) => boolean;
  removeMapControl: (control: IControl) => void;

  addCogLayer?: (
    name: string,
    url: string,
    options?: GeoLibreCogLayerOptions,
  ) => Promise<string>;
  setCogRenderEngine?: (
    engine: "maplibre-gl-raster" | "cog-tiler-wasm" | "titiler",
  ) => Promise<void>;

  addTileLayer?: (
    name: string,
    url: string,
    options?: GeoLibreTileLayerOptions,
  ) => string;

  addGeoJsonLayer?: (
    name: string,
    data: FeatureCollection,
    sourcePath?: string,
  ) => string;

  registerExternalNativeLayer?: (
    layer: GeoLibreExternalNativeLayerRegistration,
  ) => void;
  unregisterExternalNativeLayer?: (id: string) => void;

  registerRightPanel?: (panel: GeoLibreRightPanelRegistration) => () => void;
  unregisterRightPanel?: (id: string) => void;
  openRightPanel?: (id: string) => boolean;
  closeRightPanel?: (id: string) => void;

  registerToolbarMenu?: (menu: GeoLibreToolbarMenu) => () => void;
  unregisterToolbarMenu?: (id: string) => void;

  registerFloatingPanel?: (panel: GeoLibreFloatingPanelRegistration) => () => void;
  unregisterFloatingPanel?: (id: string) => void;
  openFloatingPanel?: (id: string) => boolean;
  closeFloatingPanel?: (id: string) => void;

  setBasemap?: (styleUrl: string) => void;
  getLocale?: () => string;
  onLocaleChange?: (listener: (locale: string) => void) => () => void;
  translate?: (
    key: string,
    defaultValue: string,
    params?: Record<string, string | number>,
  ) => string;
}

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activeByDefault?: boolean;
  engines?: ("maplibre" | "cesium")[];
  urlParameterNames?: string[];
  activate: (app: GeoLibreAppAPI) => boolean | void;
  deactivate: (app: GeoLibreAppAPI) => void;
  handleUrlParameters?: (
    app: GeoLibreAppAPI,
    params: URLSearchParams,
  ) => void | Promise<void>;
  getMapControlPosition?: () => GeoLibreMapControlPosition;
  setMapControlPosition?: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => boolean | void;
  getProjectState?: () => unknown;
  applyProjectState?: (app: GeoLibreAppAPI, state: unknown) => boolean | void;
}
