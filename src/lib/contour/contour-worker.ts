import mlcontour from "maplibre-contour";
import proj4 from "proj4";

type ContourRequest = {
  id: number;
  data: ArrayBuffer;
  width: number;
  height: number;
  interval: number;
  majorEvery: number;
  sourceBBox: [number, number, number, number];
  projection: string;
  clipBBox: [number, number, number, number];
};

const EXTENT = 4096;
const MAX_FEATURES = 20000;
const EDGE_BUFFER = 64;

self.onmessage = (event: MessageEvent<ContourRequest>) => {
  const { id, data, width, height, interval, majorEvery, sourceBBox, projection, clipBBox } = event.data;
  const values = new Float32Array(data);
  const tile = new mlcontour.HeightTile(width, height, (x, y) => values[y * width + x]);
  const contours = mlcontour.generateIsolines(interval, tile);
  const features = [];
  const precision = decimalPlaces(interval);

  outer: for (const [elevation, lines] of Object.entries(contours)) {
    const roundedElevation = Number(Number(elevation).toFixed(precision));
    const major = Math.round(roundedElevation / interval) % majorEvery === 0;
    const linesToRender = major ? mergeNearbyLines(lines) : lines;
    for (const line of linesToRender) {
      if (isEdgeArtifact(line)) continue;
      const coordinates: [number, number][] = [];
      for (let index = 0; index < line.length; index += 2) {
        const x = sourceBBox[0] + (line[index] / EXTENT) * (sourceBBox[2] - sourceBBox[0]);
        const y = sourceBBox[3] - (line[index + 1] / EXTENT) * (sourceBBox[3] - sourceBBox[1]);
        coordinates.push(toWgs84(x, y, projection));
      }
      if (coordinates.length >= 2) {
        const clippedLines = clipLine(coordinates, clipBBox);
        for (const clipped of clippedLines) {
          if (clipped.length < 2) continue;
        features.push({
          type: "Feature",
          properties: {
            ele: roundedElevation,
            label: `${roundedElevation.toFixed(precision)} m`,
            major: major ? 1 : 0,
          },
            geometry: { type: "LineString", coordinates: clipped },
        });
        if (features.length >= MAX_FEATURES) break outer;
        }
      }
    }
  }
  self.postMessage({ id, features: { type: "FeatureCollection", features } });
};

function mergeNearbyLines(lines: number[][]): number[][] {
  const remaining = lines.map((line) => [...line]);
  const merged: number[][] = [];
  const maxGap = 64;
  while (remaining.length > 0) {
    let current = remaining.pop()!;
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        const joined = findJoin(current, remaining[index], maxGap);
        if (!joined) continue;
        remaining.splice(index, 1);
        current = joined;
        changed = true;
      }
    }
    merged.push(current);
  }
  return merged;
}

function findJoin(first: number[], second: number[], maxGap: number): number[] | null {
  const firstStart = [first[0], first[1]];
  const firstEnd = [first[first.length - 2], first[first.length - 1]];
  const secondStart = [second[0], second[1]];
  const secondEnd = [second[second.length - 2], second[second.length - 1]];
  if (distance(firstEnd, secondStart) <= maxGap) return [...first, ...second.slice(2)];
  if (distance(firstEnd, secondEnd) <= maxGap) return [...first, ...reverseLine(second).slice(2)];
  if (distance(firstStart, secondEnd) <= maxGap) return [...second, ...first.slice(2)];
  if (distance(firstStart, secondStart) <= maxGap) return [...reverseLine(second), ...first.slice(2)];
  return null;
}

function reverseLine(line: number[]): number[] {
  const reversed: number[] = [];
  for (let index = line.length - 2; index >= 0; index -= 2) {
    reversed.push(line[index], line[index + 1]);
  }
  return reversed;
}

function distance(first: number[], second: number[]): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1]);
}

function clipLine(
  line: [number, number][],
  bbox: [number, number, number, number],
): [number, number][][] {
  const result: [number, number][][] = [];
  let current: [number, number][] = [];
  for (let index = 1; index < line.length; index += 1) {
    const segment = clipSegment(line[index - 1], line[index], bbox);
    if (!segment) {
      if (current.length >= 2) result.push(current);
      current = [];
      continue;
    }
    if (current.length === 0) current.push(segment[0], segment[1]);
    else if (samePoint(current[current.length - 1], segment[0])) current.push(segment[1]);
    else {
      if (current.length >= 2) result.push(current);
      current = [segment[0], segment[1]];
    }
  }
  if (current.length >= 2) result.push(current);
  return result;
}

function clipSegment(
  first: [number, number],
  second: [number, number],
  bbox: [number, number, number, number],
): [[number, number], [number, number]] | null {
  const dx = second[0] - first[0];
  const dy = second[1] - first[1];
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [first[0] - bbox[0], bbox[2] - first[0], first[1] - bbox[1], bbox[3] - first[1]];
  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index] < 0) return null;
      continue;
    }
    const ratio = q[index] / p[index];
    if (p[index] < 0) {
      if (ratio > t1) return null;
      if (ratio > t0) t0 = ratio;
    } else {
      if (ratio < t0) return null;
      if (ratio < t1) t1 = ratio;
    }
  }
  return [
    [first[0] + t0 * dx, first[1] + t0 * dy],
    [first[0] + t1 * dx, first[1] + t1 * dy],
  ];
}

function samePoint(first: [number, number], second: [number, number]): boolean {
  return Math.abs(first[0] - second[0]) < 1e-10 && Math.abs(first[1] - second[1]) < 1e-10;
}

function isEdgeArtifact(line: number[]): boolean {
  let edgePoints = 0;
  const pointCount = line.length / 2;
  for (let index = 0; index < line.length; index += 2) {
    const x = line[index];
    const y = line[index + 1];
    if (
      x <= EDGE_BUFFER ||
      y <= EDGE_BUFFER ||
      x >= EXTENT - EDGE_BUFFER ||
      y >= EXTENT - EDGE_BUFFER
    ) {
      edgePoints += 1;
    }
  }
  return pointCount >= 3 && edgePoints / pointCount >= 0.75;
}

function toWgs84(x: number, y: number, projection: string): [number, number] {
  return proj4(projection, "EPSG:4326", [x, y]) as [number, number];
}

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase();
  if (text.includes("e-")) return Math.min(6, Number.parseInt(text.split("e-")[1], 10));
  return Math.min(6, Math.max(0, text.split(".")[1]?.length ?? 0));
}
