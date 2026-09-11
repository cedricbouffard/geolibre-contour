import type { FeatureCollection } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import * as geotiff from "geotiff";
import proj4 from "proj4";
import { toProj4 } from "geotiff-geokeys-to-proj4";
import ContourWorker from "./contour-worker?worker&inline";
import type { GeoLibreAppAPI } from "../geolibre/host-api";

export interface ContourConfig {
  cogUrl: string;
  interval: number;
  majorEvery: number;
  gridSize: number;
  resampling: "nearest" | "bilinear";
  lineColor: string;
  majorWidth: number;
  minorWidth: number;
  labelSize: number;
  nodata?: number;
}

const CONTOUR_SOURCE_ID = "gc-contour-source";
const MAJOR_LAYER_ID = "gc-contour-major";
const MINOR_LAYER_ID = "gc-contour-minor";
const LABEL_LAYER_ID = "gc-contour-labels";
const HOST_LAYER_ID = "geolibre-contours";
const MIN_CONTOUR_ZOOM = 10;
const COMMON_NODATA_VALUES = new Set([-999, -9999, -32767, -32768]);

type ContourMap = MapLibreMap & {
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
  getZoom(): number;
};

type CogImage = {
  getBoundingBox(): number[];
  getGeoKeys(): Record<string, number>;
  getFileDirectory(): Record<string, unknown>;
  getWidth(): number;
  getHeight(): number;
  readRasters(options: Record<string, unknown>): Promise<ArrayLike<number>[]>;
};

type CogFile = {
  getImage(index?: number): Promise<CogImage>;
  getImageCount(): Promise<number>;
};

type ProjectionDefinition = string;
type StatusKind = "success" | "error" | "loading";

export class ContourManager {
  private config: ContourConfig = {
    cogUrl: "",
    interval: 25,
    majorEvery: 5,
    gridSize: 128,
    resampling: "nearest",
    lineColor: "#8b4513",
    majorWidth: 1.8,
    minorWidth: 0.8,
    labelSize: 10,
  };
  private map: ContourMap | null = null;
  private app: GeoLibreAppAPI;
  private moveEndListener: (() => void) | null = null;
  private moveListener: (() => void) | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private styleDataListener: (() => void) | null = null;
  private requestId = 0;
  private cogUrl = "";
  private cogPromise: Promise<CogFile> | null = null;
  private contourWorker: Worker | null = null;
  private statusListener: ((text: string, kind: StatusKind) => void) | null = null;

  constructor(app: GeoLibreAppAPI) {
    this.app = app;
  }

  getConfig(): ContourConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<ContourConfig>): void {
    this.config = { ...this.config, ...config };
  }

  setStatusListener(listener: ((text: string, kind: StatusKind) => void) | null): void {
    this.statusListener = listener;
  }

  async setup(map: MapLibreMap): Promise<void> {
    console.info("[geolibre-contour] setup", {
      cogUrl: this.config.cogUrl,
      zoom: (map as ContourMap).getZoom(),
    });
    this.teardown();
    if (!this.config.cogUrl) return;

    this.map = map as ContourMap;
    this.addMapLayers();

    this.map.on("moveend", this.onMoveEnd);
    this.moveEndListener = this.onMoveEnd;
    this.map.on("move", this.onMove);
    this.moveListener = this.onMove;
    this.map.on("styledata", this.onStyleData);
    this.styleDataListener = this.onStyleData;
    console.info("[geolibre-contour] listeners attached", {
      move: true,
      moveend: true,
      styledata: true,
    });
    await this.generateForView();
  }

  teardown(): void {
    this.requestId += 1;
    if (this.map && this.moveEndListener) {
      this.map.off("moveend", this.moveEndListener);
    }
    this.moveEndListener = null;
    if (this.map && this.moveListener) {
      this.map.off("move", this.moveListener);
    }
    this.moveListener = null;
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    if (this.map && this.styleDataListener) {
      this.map.off("styledata", this.styleDataListener);
    }
    this.styleDataListener = null;
    if (!this.map) return;

    for (const layerId of [LABEL_LAYER_ID, MAJOR_LAYER_ID, MINOR_LAYER_ID]) {
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    }
    if (this.map.getSource(CONTOUR_SOURCE_ID)) {
      this.map.removeSource(CONTOUR_SOURCE_ID);
    }
    this.app.unregisterExternalNativeLayer?.(HOST_LAYER_ID);
    this.contourWorker?.terminate();
    this.contourWorker = null;
    this.map = null;
  }

  private onMoveEnd = (): void => {
    console.info("[geolibre-contour] moveend", { zoom: this.map?.getZoom() });
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    void this.generateForView().catch((error: unknown) => {
      this.setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
      console.error("[geolibre-contour] moveend generation failed", error);
    });
  };

  private onMove = (): void => {
    console.info("[geolibre-contour] move", { zoom: this.map?.getZoom() });
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      void this.generateForView().catch((error: unknown) => {
        this.setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
        console.error("[geolibre-contour] move generation failed", error);
      });
    }, 180);
  };

  private onStyleData = (): void => {
    if (!this.map) return;
    if (!this.map.getSource(CONTOUR_SOURCE_ID)) {
      console.warn("[geolibre-contour] contour source missing after styledata; rebuilding");
      this.addMapLayers();
      void this.generateForView().catch((error: unknown) => {
        console.error("[geolibre-contour] styledata generation failed", error);
      });
    }
    this.bringContoursToFront();
    this.updatePaintProperties();
  };

  private bringContoursToFront(): void {
    if (!this.map) return;
    for (const layerId of [MINOR_LAYER_ID, MAJOR_LAYER_ID, LABEL_LAYER_ID]) {
      if (this.map.getLayer(layerId)) this.map.moveLayer(layerId);
    }
  }

  private addMapLayers(): void {
    if (!this.map) return;
    const map = this.map;
    if (map.getSource(CONTOUR_SOURCE_ID)) return;
    map.addSource(CONTOUR_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
    map.addLayer({
      id: MINOR_LAYER_ID,
      type: "line",
      source: CONTOUR_SOURCE_ID,
      filter: ["==", ["get", "major"], 0],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": this.config.lineColor, "line-width": this.config.minorWidth },
    });
    map.addLayer({
      id: MAJOR_LAYER_ID,
      type: "line",
      source: CONTOUR_SOURCE_ID,
      filter: ["==", ["get", "major"], 1],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": this.config.lineColor, "line-width": this.config.majorWidth },
    });
    map.addLayer({
      id: LABEL_LAYER_ID,
      type: "symbol",
      source: CONTOUR_SOURCE_ID,
      filter: ["==", ["get", "major"], 1],
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 120,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-size": this.config.labelSize,
        "text-field": ["get", "label"],
      },
      paint: { "text-halo-color": "white", "text-halo-width": 1 },
    });
    this.app.registerExternalNativeLayer?.({
      id: HOST_LAYER_ID,
      name: "Contour lines",
      type: "geojson",
      nativeLayerIds: [MINOR_LAYER_ID, MAJOR_LAYER_ID, LABEL_LAYER_ID],
      source: { type: "geojson", sourceId: CONTOUR_SOURCE_ID },
      sourceIds: [CONTOUR_SOURCE_ID],
      sourceId: CONTOUR_SOURCE_ID,
    });
  }

  private async generateForView(): Promise<void> {
    if (!this.map || !this.config.cogUrl) return;
    const started = performance.now();
    const requestId = ++this.requestId;
    const zoom = this.map.getZoom();
    const source = this.map.getSource(CONTOUR_SOURCE_ID) as { setData(data: FeatureCollection): void } | undefined;
    if (zoom < MIN_CONTOUR_ZOOM) {
      source?.setData(emptyFeatureCollection());
      this.setStatus(`Zoom ${zoom.toFixed(1)}: zoom in to ${MIN_CONTOUR_ZOOM}+ for contours.`, "loading");
      console.info("[geolibre-contour] skipped below minimum zoom", {
        zoom,
        minimumZoom: MIN_CONTOUR_ZOOM,
      });
      return;
    }
    const bounds = this.map.getBounds();
    const viewBbox: [number, number, number, number] = [
      bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
    ];
    // Read a few extra sample cells so contour segments do not terminate at
    // the viewport edge, without multiplying the requested COG area.
    const bbox = expandBbox(viewBbox, Math.max(0.015, 2 / this.config.gridSize));
    this.setStatus(`Reading COG at zoom ${zoom.toFixed(1)}...`, "loading");
    const cog = await this.getCogFile();
    const region = await readCogRegion(
      cog,
      bbox,
      this.config.gridSize,
      this.config.nodata,
      zoom <= 11,
      AbortSignal.timeout(30_000),
      this.config.resampling,
    );
    console.info("[geolibre-contour] COG region read", {
      requestId,
      zoom,
      viewBbox,
      fullExtent: zoom <= 11,
      region: region
        ? {
          sourceBBox: region.sourceBBox,
          grid: [region.width, region.height],
          overview: [region.imageWidth, region.imageHeight],
          pixelWindow: region.pixelWindow,
        }
        : null,
      elapsedMs: Math.round(performance.now() - started),
    });
    this.setStatus(
      region
        ? `Generating contours at zoom ${zoom.toFixed(1)} using overview ${region.imageWidth}x${region.imageHeight}...`
        : "No COG data in the current view.",
      region ? "loading" : "error",
    );
    if (requestId !== this.requestId || !this.map) return;

    const features = region
      ? await calculateContours(
        this.getContourWorker(),
        region,
        this.config.interval,
        this.config.majorEvery,
        viewBbox,
      )
      : emptyFeatureCollection();
    source?.setData(features);
    this.bringContoursToFront();
    this.updatePaintProperties();
    this.setStatus(
      `${features.features.length} contour features updated in ${Math.round(performance.now() - started)} ms.`,
      "success",
    );
    console.info("[geolibre-contour] GeoJSON updated", {
      requestId,
      featureCount: features.features.length,
      elapsedMs: Math.round(performance.now() - started),
    });
  }

  private getCogFile(): Promise<CogFile> {
    if (this.cogPromise && this.cogUrl === this.config.cogUrl) return this.cogPromise;
    this.cogUrl = this.config.cogUrl;
    const promise = geotiff.fromUrl(
      this.config.cogUrl,
      {},
      AbortSignal.timeout(30_000),
    ) as Promise<CogFile>;
    this.cogPromise = promise;
    void promise.catch(() => {
      if (this.cogPromise === promise) this.cogPromise = null;
    });
    return this.cogPromise;
  }

  private getContourWorker(): Worker {
    if (!this.contourWorker) this.contourWorker = new ContourWorker();
    return this.contourWorker;
  }

  private setStatus(text: string, kind: StatusKind): void {
    this.statusListener?.(text, kind);
  }

  private updatePaintProperties(): void {
    if (!this.map) return;
    this.map.setPaintProperty(MINOR_LAYER_ID, "line-width", this.config.minorWidth);
    this.map.setPaintProperty(MAJOR_LAYER_ID, "line-width", this.config.majorWidth);
    this.map.setLayoutProperty(LABEL_LAYER_ID, "text-size", this.config.labelSize);
  }
}

function emptyFeatureCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

async function readCogRegion(
  cog: CogFile,
  bbox: [number, number, number, number],
  targetSize: number,
  nodataOverride?: number,
  fullExtent = false,
  signal?: AbortSignal,
  resampling: "nearest" | "bilinear" = "nearest",
): Promise<{
  data: Float32Array;
  width: number;
  height: number;
  sourceBBox: [number, number, number, number];
  projection: ProjectionDefinition;
  imageWidth: number;
  imageHeight: number;
  pixelWindow: [number, number, number, number];
} | null> {
  const baseImage = await cog.getImage(0);
  const rawBBox = baseImage.getBoundingBox();
  if (rawBBox.length < 4) return null;
  const rawNodata = baseImage.getFileDirectory().GDAL_NODATA;
  const metadataNodata = rawNodata == null ? undefined : Number.parseFloat(String(rawNodata));
  const nodata = nodataOverride ?? metadataNodata;
  const projection = getProjection(baseImage.getGeoKeys());
  const sourceBBox = rawBBox as [number, number, number, number];
  const cogBBox = transformBBox(sourceBBox, projection.toWgs84);
  const viewInSource = transformBBox(bbox, projection.fromWgs84);
  const overlap: [number, number, number, number] = [
    Math.max(viewInSource[0], sourceBBox[0]), Math.max(viewInSource[1], sourceBBox[1]),
    Math.min(viewInSource[2], sourceBBox[2]), Math.min(viewInSource[3], sourceBBox[3]),
  ];
  if (
    overlap[0] >= overlap[2] ||
    overlap[1] >= overlap[3] ||
    cogBBox[2] <= bbox[0] ||
    cogBBox[0] >= bbox[2] ||
    cogBBox[3] <= bbox[1] ||
    cogBBox[1] >= bbox[3]
  ) return null;

  const readBBox = fullExtent ? sourceBBox : overlap;

  const xFraction1 = (readBBox[0] - sourceBBox[0]) / (sourceBBox[2] - sourceBBox[0]);
  const yFraction1 = (sourceBBox[3] - readBBox[3]) / (sourceBBox[3] - sourceBBox[1]);
  const xFraction2 = (readBBox[2] - sourceBBox[0]) / (sourceBBox[2] - sourceBBox[0]);
  const yFraction2 = (sourceBBox[3] - readBBox[1]) / (sourceBBox[3] - sourceBBox[1]);
  const imageCount = await cog.getImageCount();
  let image = baseImage;
  for (let index = 1; index < imageCount; index += 1) {
    const candidate = await cog.getImage(index);
    const candidateWindowWidth = (xFraction2 - xFraction1) * candidate.getWidth();
    const candidateWindowHeight = (yFraction2 - yFraction1) * candidate.getHeight();
    if (candidateWindowWidth < targetSize || candidateWindowHeight < targetSize) break;
    image = candidate;
  }
  const imageWidth = image.getWidth();
  const imageHeight = image.getHeight();
  const pixelX1 = Math.max(0, Math.floor(xFraction1 * imageWidth));
  const pixelY1 = Math.max(0, Math.floor(yFraction1 * imageHeight));
  const pixelX2 = Math.min(imageWidth, Math.ceil(xFraction2 * imageWidth));
  const pixelY2 = Math.min(imageHeight, Math.ceil(yFraction2 * imageHeight));
  if (pixelX2 - pixelX1 < 2 || pixelY2 - pixelY1 < 2) return null;

  const width = targetSize;
  const height = targetSize;
  const rasters = await image.readRasters({
    samples: [0],
    window: [pixelX1, pixelY1, pixelX2, pixelY2],
    width,
    height,
    signal,
    resampleMethod: resampling,
  });
  const values = rasters[0] as ArrayLike<number>;
  const inferredNodata = nodata ?? inferBorderNodata(values, width, height);
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i += 1) {
    const value = Number(values[i]);
    data[i] = Number.isFinite(value) && value > -1e5 && value < 1e6 && value !== inferredNodata && !isCommonNodata(value) ? value : NaN;
  }
  return {
    data,
    width,
    height,
    sourceBBox: [
      sourceBBox[0] + (pixelX1 / imageWidth) * (sourceBBox[2] - sourceBBox[0]),
      sourceBBox[3] - (pixelY2 / imageHeight) * (sourceBBox[3] - sourceBBox[1]),
      sourceBBox[0] + (pixelX2 / imageWidth) * (sourceBBox[2] - sourceBBox[0]),
      sourceBBox[3] - (pixelY1 / imageHeight) * (sourceBBox[3] - sourceBBox[1]),
    ],
    projection: projection.definition,
    imageWidth,
    imageHeight,
    pixelWindow: [pixelX1, pixelY1, pixelX2, pixelY2],
  };
}

function isCommonNodata(value: number): boolean {
  // DTM/DEM files commonly use negative sentinels such as -999, -9999 or
  // -32767. Values above 9000 are likewise outside the expected range for
  // the supported elevation rasters and are treated as fill values.
  return COMMON_NODATA_VALUES.has(value) || value <= -900 || value >= 9000;
}

function inferBorderNodata(values: ArrayLike<number>, width: number, height: number): number | undefined {
  const borderCounts = new Map<number, number>();
  const innerCounts = new Map<number, number>();
  let borderTotal = 0;
  let innerTotal = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Number(values[y * width + x]);
      if (!Number.isFinite(value)) continue;
      const border = x < 3 || y < 3 || x >= width - 3 || y >= height - 3;
      const counts = border ? borderCounts : innerCounts;
      counts.set(value, (counts.get(value) ?? 0) + 1);
      if (border) borderTotal += 1;
      else innerTotal += 1;
    }
  }
  const candidates = [...borderCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [value, count] of candidates) {
    const innerCount = innerCounts.get(value) ?? 0;
    const repeatedOnBorder = count >= Math.max(8, borderTotal * 0.15);
    const absentInside = innerCount <= Math.max(1, innerTotal * 0.002);
    const sentinelRange = value <= -900 || value >= 9000 || value === 0;
    if (repeatedOnBorder && absentInside && sentinelRange) return value;
  }
  return undefined;
}

interface Projection {
  toWgs84: (x: number, y: number) => [number, number];
  fromWgs84: (x: number, y: number) => [number, number];
  definition: ProjectionDefinition;
}

function getProjection(geoKeys: Record<string, number>): Projection {
  const converted = toProj4(geoKeys as never);
  if (!converted.proj4 || Object.keys(converted.errors).length > 0) {
    throw new Error(
      `Unsupported GeoTIFF projection: ${Object.keys(converted.errors).join(", ") || "missing GeoKeys"}`,
    );
  }
  const definition = converted.proj4;
  const toWgs84 = (x: number, y: number): [number, number] => proj4(definition, "EPSG:4326", [x, y]) as [number, number];
  const fromWgs84 = (x: number, y: number): [number, number] => proj4("EPSG:4326", definition, [x, y]) as [number, number];
  return { toWgs84, fromWgs84, definition };
}

function transformBBox(
  bbox: [number, number, number, number],
  transform: (x: number, y: number) => [number, number],
): [number, number, number, number] {
  const points = [
    transform(bbox[0], bbox[1]), transform(bbox[0], bbox[3]),
    transform(bbox[2], bbox[1]), transform(bbox[2], bbox[3]),
  ];
  return [
    Math.min(...points.map(([x]) => x)), Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)), Math.max(...points.map(([, y]) => y)),
  ];
}

function expandBbox(
  bbox: [number, number, number, number],
  ratio: number,
): [number, number, number, number] {
  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  return [
    bbox[0] - width * ratio,
    Math.max(-85, bbox[1] - height * ratio),
    bbox[2] + width * ratio,
    Math.min(85, bbox[3] + height * ratio),
  ];
}

function calculateContours(
  worker: Worker,
  region: {
    data: Float32Array;
    width: number;
    height: number;
    sourceBBox: [number, number, number, number];
    projection: ProjectionDefinition;
  },
  interval: number,
  majorEvery: number,
  clipBBox: [number, number, number, number],
): Promise<FeatureCollection> {
  const id = Date.now() + Math.random();
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<{ id: number; features: FeatureCollection }>) => {
      if (event.data.id !== id) return;
      cleanup();
      resolve(event.data.features);
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(
      {
        id,
        data: region.data.buffer,
        width: region.width,
        height: region.height,
        interval,
        majorEvery,
        sourceBBox: region.sourceBBox,
        projection: region.projection,
        clipBBox,
      },
      [region.data.buffer],
    );
  });
}
