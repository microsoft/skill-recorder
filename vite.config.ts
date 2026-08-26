import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** Ship the CommonJS preloads + hidden capture page verbatim (they run in the
 *  renderer's isolated world and must not go through the ESM main pipeline). */
function copyStaticAssets(): void {
  const out = path.join(rootDir, "dist-electron");
  mkdirSync(out, { recursive: true });
  mkdirSync(path.join(out, "video"), { recursive: true });
  mkdirSync(path.join(out, "audio"), { recursive: true });
  const icons = path.join(out, "assets", "icons");
  mkdirSync(icons, { recursive: true });
  const iconSrc = path.join(rootDir, "electron", "assets", "icons");
  for (const file of readdirSync(iconSrc)) {
    copyFileSync(path.join(iconSrc, file), path.join(icons, file));
  }
  copyFileSync(path.join(rootDir, "electron", "preload.cjs"), path.join(out, "preload.cjs"));
  copyFileSync(
    path.join(rootDir, "electron", "video", "capture.html"),
    path.join(out, "video", "capture.html"),
  );
  copyFileSync(
    path.join(rootDir, "electron", "video", "capture-preload.cjs"),
    path.join(out, "video", "capture-preload.cjs"),
  );
  copyFileSync(
    path.join(rootDir, "electron", "audio", "capture.html"),
    path.join(out, "audio", "capture.html"),
  );
  copyFileSync(
    path.join(rootDir, "electron", "audio", "capture-preload.cjs"),
    path.join(out, "audio", "capture-preload.cjs"),
  );
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: "electron/main.ts",
        onstart(args) {
          copyStaticAssets();
          // A parent Electron host (e.g. the launcher) can leak ELECTRON_RUN_AS_NODE,
          // which would start our process as a bare Node runtime instead of a GUI app.
          const env = { ...process.env };
          delete env.ELECTRON_RUN_AS_NODE;
          void args.startup([".", "--no-sandbox"], { env });
        },
        vite: {
          build: {
            outDir: "dist-electron",
            rolldownOptions: {
              // Native / binary deps must be required from node_modules at runtime,
              // never inlined into the main bundle. archiver is pure-JS but pulls a
              // large CJS dependency graph, so it's required at runtime too.
              external: [
                "electron",
                "@github/copilot-sdk",
                "archiver",
                "get-windows",
                "koffi",
                "sharp",
                "@huggingface/transformers",
                "onnxruntime-node",
                "tesseract.js",
              ],
            },
          },
          plugins: [
            {
              name: "copy-preload",
              closeBundle() {
                copyStaticAssets();
              },
            },
          ],
        },
      },
    ]),
  ],
});
