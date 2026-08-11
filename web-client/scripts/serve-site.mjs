// Serves the built site the way the test environment serves it.
//
// `.github/workflows/test-deploy.yml` assembles the deployed site as:
//
//     mkdir -p site
//     cp -r web-client/public/. site/
//     cp -r web-client/dist site/dist
//
// so the deployed tree is `public/` at the root with `dist/` beside it. This
// server maps those two directories to the same two locations instead of
// copying them, which resolves identically as long as `public/` contains no
// entry called `dist` — asserted at startup rather than assumed.
//
// Serving the real build artifact is the point: the acceptance screenshot then
// shows what the test environment will show, not a separate dev-only page.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, "public");
const DIST_DIR = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT ?? 4173);

const MIME = {
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
  ".b3dm": "application/octet-stream",
  ".xml": "application/xml",
};

if (!fs.existsSync(DIST_DIR)) {
  console.error(`no build at ${DIST_DIR} — run \`npm run build\` first`);
  process.exit(1);
}
if (fs.existsSync(path.join(PUBLIC_DIR, "dist"))) {
  console.error("public/dist exists — this server's mapping no longer matches the deploy");
  process.exit(1);
}

function resolve(urlPath) {
  const clean = path.posix.normalize(decodeURIComponent(urlPath.split("?")[0]));
  if (clean.includes("..")) return null;
  const rel = clean === "/" ? "/index.html" : clean;
  const target = rel.startsWith("/dist/")
    ? path.join(DIST_DIR, rel.slice("/dist/".length))
    : path.join(PUBLIC_DIR, rel);
  const base = rel.startsWith("/dist/") ? DIST_DIR : PUBLIC_DIR;
  return path.resolve(target).startsWith(path.resolve(base)) ? target : null;
}

const server = http.createServer((req, res) => {
  const file = resolve(req.url ?? "/");
  if (file === null) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fsp
    .readFile(file)
    .then((body) => {
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    })
    .catch(() => {
      res.writeHead(404).end(`not found: ${req.url}`);
    });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`serving the assembled site on http://127.0.0.1:${PORT}/`);
});
