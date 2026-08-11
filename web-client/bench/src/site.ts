/**
 * Building and serving the page under measurement.
 *
 * The page is a real production Vite build, not a dev server: a dev server
 * ships hundreds of unbundled modules, which would dominate the cold-cache
 * numbers with a cost the deployed site never pays.
 *
 * The server sets cacheable headers on purpose. AC3 wants cold and warm cache
 * recorded separately, and "warm" can only mean anything if the assets were
 * cacheable in the first place — scripts/serve-site.mjs sends `no-store`, which
 * is right for that job and would make every run here a cold one.
 */

import { createServer, type Server } from "node:http";
import { cp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = join(HERE, "..", "page");
const WEB_CLIENT_DIR = join(HERE, "..", "..");

/** Cesium fetches these at runtime from `window.CESIUM_BASE_URL`. */
const CESIUM_RUNTIME_DIRS = ["Assets", "ThirdParty", "Widgets", "Workers"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ktx2": "image/ktx2",
  ".glb": "model/gltf-binary",
  ".xml": "application/xml",
};

export async function buildBenchPage(outDir: string): Promise<void> {
  await build({
    root: PAGE_DIR,
    // No config file: web-client/vite.config.ts builds the product in library
    // mode, which is not what this page is.
    configFile: false,
    base: "./",
    logLevel: "warn",
    build: { outDir, emptyOutDir: true },
  });

  // Copied straight from the package rather than from web-client/dist, so the
  // bench does not silently depend on `npm run build` having been run first.
  const require = createRequire(join(WEB_CLIENT_DIR, "package.json"));
  const cesiumBuild = join(dirname(require.resolve("cesium/package.json")), "Build", "Cesium");
  await Promise.all(
    CESIUM_RUNTIME_DIRS.map((dir) =>
      cp(join(cesiumBuild, dir), join(outDir, "cesium", dir), { recursive: true }),
    ),
  );
}

export interface BenchSite {
  url: string;
  close(): Promise<void>;
}

export function serveBenchPage(root: string, port = 0): Promise<BenchSite> {
  const rootResolved = resolve(root);

  const server: Server = createServer((request, response) => {
    const rawPath = (request.url ?? "/").split("?")[0] ?? "/";
    const decoded = decodeURIComponent(rawPath);
    const relative = decoded === "/" ? "/index.html" : decoded;
    const target = resolve(join(rootResolved, normalize(relative)));

    if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
      response.writeHead(403).end("forbidden");
      return;
    }

    readFile(target)
      .then((body) => {
        response.writeHead(200, {
          "content-type": MIME[extname(target)] ?? "application/octet-stream",
          // The point of the whole file — see the header.
          "cache-control": "public, max-age=3600",
        });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(404).end(`not found: ${relative}`);
      });
  });

  return new Promise<BenchSite>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPromise(new Error("bench server 沒有取得 port"));
        return;
      }
      resolvePromise({
        url: `http://127.0.0.1:${address.port}/`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
