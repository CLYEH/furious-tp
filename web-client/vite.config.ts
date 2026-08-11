import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Cesium ships its workers, shaders, textures and widget CSS as files it fetches
// at runtime from `window.CESIUM_BASE_URL`, so they have to land next to the
// bundle rather than inside it.
const CESIUM_BUILD = path.join(HERE, "node_modules/cesium/Build/Cesium");
const CESIUM_RUNTIME_DIRS = ["Assets", "ThirdParty", "Widgets", "Workers"];

/**
 * Library mode, on purpose.
 *
 * `.github/workflows/test-deploy.yml` assembles the site as
 * `cp public/. site/` + `cp -r dist site/dist`, and that file is governance —
 * this ticket may not touch it. So the build has to keep producing exactly what
 * it produced before: `public/index.html` as the page, `dist/index.js` as the
 * module it loads. An HTML-entry build would move the page into dist/ and the
 * deploy would ship the un-built source page instead.
 */
export default defineConfig({
  // `public/` is the deployed page, not a static-asset folder to be copied into
  // the bundle — Vite would otherwise place a second copy of index.html inside
  // dist/, where its relative "./dist/index.js" no longer resolves.
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: path.join(HERE, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
  plugins: [
    {
      name: "ftp-copy-cesium-runtime",
      async closeBundle() {
        await Promise.all(
          CESIUM_RUNTIME_DIRS.map((dir) =>
            cp(path.join(CESIUM_BUILD, dir), path.join(HERE, "dist/cesium", dir), {
              recursive: true,
            }),
          ),
        );
      },
    },
  ],
});
