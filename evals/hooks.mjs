// A Node module-resolution hook that lets the eval harness run the app's
// TypeScript source directly (no bundler), by:
//   1. redirecting the lone `electron` dependency to a headless stub, and
//   2. redirecting Vite-only catalogue discovery to a Node filesystem adapter, and
//   3. resolving extensionless relative/absolute imports to their `.ts` file
//      (the project is authored Vite-style, without extensions).
// Node itself strips/transforms the TypeScript (run with
// `--experimental-transform-types`). Registered via register.mjs.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_STUB = pathToFileURL(path.join(here, "electron-stub.mjs")).href;
const CATALOGUE_REGISTRY = path.resolve(
  here,
  "..",
  "electron",
  "architectures",
  "catalogue-registry.ts",
);
const EVAL_CATALOGUE_REGISTRY = pathToFileURL(
  path.join(here, "lib", "catalogue-registry.ts"),
).href;

export async function resolve(specifier, context, next) {
  if (specifier === "electron") {
    return { url: ELECTRON_STUB, shortCircuit: true };
  }

  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (isRelative && context.parentURL && !path.extname(specifier)) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
      if (existsSync(candidate)) {
        return {
          url:
            candidate === CATALOGUE_REGISTRY
              ? EVAL_CATALOGUE_REGISTRY
              : pathToFileURL(candidate).href,
          shortCircuit: true,
        };
      }
    }
  }

  return next(specifier, context);
}
