const { ipcRenderer } = require("electron");
const { readFile } = require("node:fs/promises");

let video;
let mediaUrl;
let mediaOptions;

function waitFor(target, name, action) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      target.removeEventListener(name, ready);
      target.removeEventListener("error", failed);
      error ? reject(error) : resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error("Chromium could not decode this recording's video codec or media data."));
    const timer = setTimeout(() => finish(new Error("The recording could not be decoded or seeked in time.")), 30000);
    target.addEventListener(name, ready, { once: true });
    target.addEventListener("error", failed, { once: true });
    try { action(); } catch (error) { finish(error); }
  });
}

async function frame(offsetMs, crop) {
  const target = Math.min(Math.max(0, offsetMs / 1000), Math.max(0, video.duration - 0.1));
  if (Math.abs(video.currentTime - target) > 0.001) {
    await waitFor(video, "seeked", () => { video.currentTime = target; });
  }
  if (video.readyState < 2) throw new Error("The recording did not provide a decoded video frame.");
  const rect = crop || { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
      rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 ||
      rect.x + rect.w > video.videoWidth || rect.y + rect.h > video.videoHeight) {
    throw new Error("The requested crop is outside the recording.");
  }
  const scale = Math.min(1, 1920 / rect.w, 1080 / rect.h);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.w * scale));
  canvas.height = Math.max(1, Math.round(rect.h * scale));
  const context = canvas.getContext("2d");
  context.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("Could not extract a recording frame.");
  return { data: new Uint8Array(await blob.arrayBuffer()), offsetMs: Math.round(video.currentTime * 1000) };
}

ipcRenderer.on("import:media-request", async (_event, request) => {
  const { id, action, input } = request;
  try {
    let result;
    if (action === "open") {
      mediaOptions = input;
      const encoded = await readFile(input.file);
      if (encoded.byteLength > input.maxBytes) throw new Error("Recording exceeds the import size limit.");
      mediaUrl = URL.createObjectURL(new Blob([encoded]));
      video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      await waitFor(video, "loadeddata", () => { video.src = mediaUrl; video.load(); });
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration * 1000 > input.maxDurationMs) {
        throw new Error("The recording must have a known duration of at most 15 minutes.");
      }
      if (!video.videoWidth || !video.videoHeight || video.videoWidth * video.videoHeight > input.maxPixels) {
        throw new Error("The recording must contain video no larger than 3840 x 2160 pixels.");
      }
      await frame(0);
      await frame(video.duration * 500);
      await frame(Math.max(0, video.duration * 1000 - 100));
      if (input.hasAudio && input.checkAudio) {
        const context = new AudioContext({ sampleRate: 16000 });
        try {
          const decoded = await context.decodeAudioData(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
          if (decoded.numberOfChannels > 2 || !decoded.length || decoded.duration * 1000 > input.maxDurationMs) {
            throw new Error("Imported audio must be mono or stereo and no longer than 15 minutes.");
          }
        } catch (error) {
          throw new Error(`Chromium could not decode this recording's audio: ${error.message}`);
        } finally { await context.close(); }
      }
      result = { durationMs: video.duration * 1000, width: video.videoWidth, height: video.videoHeight };
    } else if (action === "frame" && video && mediaOptions) {
      result = await frame(input.offsetMs, input.crop);
    } else throw new Error("Invalid recording media request.");
    ipcRenderer.send("import:media-result", id, { ok: true, result });
  } catch (error) {
    ipcRenderer.send("import:media-result", id, { ok: false, error: error.message || String(error) });
  }
});

window.addEventListener("unload", () => {
  if (video) { video.removeAttribute("src"); video.load(); }
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
});
