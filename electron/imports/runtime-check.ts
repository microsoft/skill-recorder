import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { app, BrowserWindow } from "electron";

import { IMPORT_LIMITS } from "../../common/import";
import { ImportManager } from "./manager";
import { readImport } from "./metadata";
import { ImportedFrames } from "./frames";
import { inspectImportTracks } from "./tracks";

// Generates only synthetic test media through Chromium; no external encoder or recording is needed.
async function fixtures(window: BrowserWindow): Promise<Array<{ name: string; bytes: number[] }>> {
  return window.webContents.executeJavaScript(`(async () => {
    const fixtures = [];
    for (const [name, type, hasAudio, silent] of [
      ["demo.webm", "video/webm;codecs=vp8,opus", true, false],
      ["silent.webm", "video/webm;codecs=vp8,opus", true, true],
      ["no-audio.webm", "video/webm;codecs=vp8", false, false],
      ["demo.mp4", "video/mp4;codecs=avc1.42001E,mp4a.40.2", true, false],
    ]) {
      if (!MediaRecorder.isTypeSupported(type)) throw new Error("Fixture encoder unavailable: " + type);
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 360;
      const drawing = canvas.getContext("2d");
      const stream = canvas.captureStream(10);
      let audio;
      if (hasAudio) {
        audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        gain.gain.value = silent ? 0 : 0.1;
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(gain); gain.connect(destination); oscillator.start();
        stream.addTrack(destination.stream.getAudioTracks()[0]);
      }
      const recorder = new MediaRecorder(stream, {mimeType: type});
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => recorder.onstop = resolve);
      recorder.start();
      for (let index = 0; index < 20; index++) {
        drawing.fillStyle = index < 10 ? "red" : "blue";
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      recorder.stop(); await stopped;
      stream.getTracks().forEach(track => track.stop());
      if (audio) await audio.close();
      fixtures.push({name, bytes: [...new Uint8Array(await new Blob(chunks, {type}).arrayBuffer())]});
    }
    return fixtures;
  })()`);
}

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-import-runtime-"));
  process.env.SKILL_RECORDER_SESSIONS_DIR = path.join(root, "sessions");
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const manager = new ImportManager();
  let failed = false;
  try {
    await mkdir(process.env.SKILL_RECORDER_SESSIONS_DIR);
    await window.loadURL("about:blank");
    const samples = await fixtures(window);
    for (const fixture of samples) {
      const file = path.join(root, fixture.name);
      const bytes = Buffer.from(fixture.bytes);
      await writeFile(file, bytes);
      const id = await manager.run("selection", (signal) => manager.select(file, signal));
      const dir = path.join(process.env.SKILL_RECORDER_SESSIONS_DIR, id);
      const imported = readImport(dir);
      assert.ok(imported);
      assert.equal(imported.hasAudio, fixture.name !== "no-audio.webm");
      assert.ok(imported.durationMs > 1000 && imported.durationMs < 5000);
      await manager.saveDetails(id, { details: "Demo near the end. Supplemental explanation.", language: "en" });
      await manager.run(id, (signal) => manager.prepare(id, signal));
      const frames = new ImportedFrames(dir, imported, imported.importedAt);
      assert.ok(frames.manifest.some((frame) => frame.offsetSec * 1000 > imported.durationMs * 0.8));
      const later = await frames.extractWindow({
        startMs: imported.importedAt + 1200, endMs: imported.importedAt + 1700,
        crop: { x: 0, y: 0, w: 200, h: 150 },
      });
      assert.ok(later.length > 0);
      assert.ok(later.every((frame) => frame.offsetSec >= 1.2 && frame.offsetSec <= 1.7));
      frames.dispose();
      assert.equal(readImport(dir)?.details, "Demo near the end. Supplemental explanation.");
      assert.deepEqual(await readFile(file), bytes);
      await rm(dir, { recursive: true });
      assert.deepEqual(await readFile(file), bytes, "deleting an import must not affect its source");
      console.log(`PASS ${fixture.name}: decoded tracks, copied source, overview, late crop, details, deletion`);
    }

    const mp4 = Buffer.from(samples.find((sample) => sample.name === "demo.mp4")!.bytes);
    if (process.argv.includes("--large")) {
      const file = path.join(root, "large.mp4");
      const output = await open(file, "w");
      try {
        await output.write(mp4);
        const padding = Buffer.alloc(8);
        padding.writeUInt32BE(IMPORT_LIMITS.bytes - mp4.length);
        padding.write("free", 4, "ascii");
        await output.write(padding);
        await output.truncate(IMPORT_LIMITS.bytes);
      } finally { await output.close(); }
      const id = await manager.run("selection", (signal) => manager.select(file, signal));
      const dir = path.join(process.env.SKILL_RECORDER_SESSIONS_DIR, id);
      assert.equal(readImport(dir)?.bytes, 512 * 1024 * 1024);
      await rm(dir, { recursive: true });
      const oversized = await open(file, "r+");
      try { await oversized.truncate(IMPORT_LIMITS.bytes + 1); }
      finally { await oversized.close(); }
      await assert.rejects(manager.run("selection", (signal) => manager.select(file, signal)), /import limits/);
      console.log("PASS exact 512 MiB MP4 import and 512 MiB + 1 byte rejection");
    }
    for (const [name, codec] of [["bad-video.mp4", "avc1"], ["bad-audio.mp4", "mp4a"]] as const) {
      const bytes = Buffer.from(mp4);
      let replaced = 0;
      for (let index = bytes.indexOf(codec); index >= 0; index = bytes.indexOf(codec, index + 4)) {
        bytes.write("zzzz", index, "ascii");
        replaced++;
      }
      assert.ok(replaced, `fixture contains ${codec}`);
      const file = path.join(root, name);
      await writeFile(file, bytes);
      await assert.rejects(manager.run("selection", (signal) => manager.select(file, signal)));
      console.log(`PASS ${name}: rejected before creating a session`);
    }
    const corrupt = path.join(root, "corrupt.mp4");
    await writeFile(corrupt, mp4.subarray(0, Math.floor(mp4.length / 2)));
    await assert.rejects(manager.run("selection", (signal) => manager.select(corrupt, signal)));
    assert.throws(() => inspectImportTracks(mp4, ".webm"));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(manager.select(path.join(root, "demo.mp4"), controller.signal));
    assert.deepEqual(await readdir(process.env.SKILL_RECORDER_SESSIONS_DIR), [], "failed/canceled imports leave no staging sessions");
    console.log("PASS corruption, extension mismatch, cancellation, and staging cleanup");
    console.log(`Runtime checks passed on ${process.platform}-${process.arch}, Electron ${process.versions.electron}.`);
  } catch (error) {
    console.error(error);
    failed = true;
  } finally {
    manager.dispose();
    window.destroy();
    await rm(root, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
setTimeout(() => { console.error("Runtime import checks timed out."); app.exit(1); }, 180_000).unref();
