# GeoLibre Contour

GeoLibre plugin for generating dynamic contour lines from Cloud-Optimized GeoTIFF elevation data.

The plugin reads the loaded COG for the current map view, selects an appropriate overview, handles GeoTIFF coordinate systems, masks NoData values, and generates contour lines in a Web Worker. Contours are updated as the map moves.

## Features

- Dynamic contour generation from remote COG DEMs.
- Uses already loaded GeoLibre raster layers when their COG source is available.
- Automatic overview selection based on the current view.
- Generic GeoTIFF projection support through GeoTIFF GeoKeys and Proj4.
- NoData masking and border-artifact filtering.
- Worker-based contour and GeoJSON generation.
- Major/minor contours, repeated labels, label halos, and configurable intervals.
- French UI fallback with GeoLibre locale integration.
- No raster layer is added by the plugin; it only creates the contour layer.

## Installation

Build the plugin archive:

```bash
npm install
npm run package
```

Install `geolibre-plugin/geolibre-contour-0.3.7.zip` from GeoLibre's **Manage Plugins → Install from file** dialog.

The plugin expects a COG raster to be loaded in GeoLibre first. Open the Contour Lines panel, refresh the loaded raster list, select the DEM, and apply the contour settings.

## Development

Run type checking and build the external plugin bundle:

```bash
npm run typecheck
npm run build
```

Serve the unpacked plugin locally with CORS enabled:

```bash
npm run serve 8090
```

The local manifest is available at `http://localhost:8090/plugin.json`.

## Plugin Layout

The packaged archive follows the GeoLibre external plugin contract:

```text
plugin.json
dist/index.js
dist/style.css
```

The JavaScript entry is a self-contained ES module and exports both a named `plugin` and a default plugin export. The plugin does not use `activeByDefault`, as required for external plugins.

## Data Processing

COG data is read only for the current view plus a small sampling margin. The selected overview is resampled to the configured grid, transformed to WGS84, and processed by `maplibre-contour` in a Web Worker. The resulting GeoJSON source is registered with GeoLibre as an external native layer.

The default interpolation method is nearest-neighbor because it preserves NoData sentinels. Bilinear interpolation is available in the panel but can blend invalid edge values in rasters with incomplete NoData metadata.

## License

MIT
