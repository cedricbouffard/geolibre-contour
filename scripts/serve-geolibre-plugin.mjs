import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "geolibre-plugin");
const port = parseInt(process.argv[2], 10) || 8000;

const MIME = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".html": "text/html",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
};

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = req.url === "/" ? "/plugin.json" : req.url;
  const filePath = join(rootDir, urlPath);

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const content = readFileSync(filePath);
  const ext = extname(filePath);
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  res.setHeader("Content-Length", content.length);
  res.writeHead(200);
  res.end(content);
}).listen(port, () => {
  console.log(`Serving plugin at http://localhost:${port}/`);
  console.log(`Manifest URL: http://localhost:${port}/plugin.json`);
});
