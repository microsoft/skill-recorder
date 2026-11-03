import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { build } from "vite";
import { sanitizeElectronEnvironment, verifyReviewedRuntime } from "./run-reviewed-electron.mjs";

const root = process.cwd();
const executable = await verifyReviewedRuntime(root);
const output = await mkdtemp(path.join(tmpdir(), "skill-recorder-import-check-"));
try {
  await build({
    configFile: false,
    logLevel: "error",
    build: {
      ssr: path.join(root, "electron", "imports", "runtime-check.ts"),
      outDir: output,
      target: "node24",
      rolldownOptions: {
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "check.cjs" },
      },
    },
    ssr: { noExternal: true, external: ["electron"] },
  });
  await mkdir(path.join(output, "imports"));
  for (const file of ["media.html", "media-preload.cjs"]) {
    await copyFile(path.join(root, "electron", "imports", file), path.join(output, "imports", file));
  }
  const child = spawn(executable, [
    path.join(output, "check.cjs"), "--disable-gpu",
    ...(process.argv.includes("--large") ? ["--large"] : []),
  ], {
    env: sanitizeElectronEnvironment(process.env), stdio: "inherit",
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await rm(output, { recursive: true, force: true });
}
