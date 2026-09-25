// Narration capture preload — CommonJS, runs in the hidden capture window's
// isolated world. It has both Web APIs (navigator.mediaDevices, MediaRecorder)
// and ipcRenderer, so it does the whole microphone capture here and streams webm
// chunks back to the main process, which writes them to disk. Channel names
// mirror electron/audio/recorder.ts.
const { ipcRenderer } = require("electron");
const { readFile } = require("node:fs/promises");
const { handleRecorderStop, serializeError } = require("./capture-preload-utils.cjs");

/** @type {MediaRecorder | null} */
let recorder = null;
/** @type {MediaStream | null} */
let stream = null;
/** @type {string | null} */
let captureId = null;
let requestedStopEpoch = 0;
// Serialises chunk sends so the final blob (dispatched just before `stop`) is
// fully forwarded before we tell main the recording stopped — otherwise the last
// cluster is lost and the webm ends prematurely.
let sendChain = Promise.resolve();

function microphoneConstraints(deviceId) {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    channelCount: 1,
    ...(typeof deviceId === "string" && deviceId && deviceId !== "default"
      ? { deviceId: { exact: deviceId } }
      : {}),
  };
}

async function enumerateMicrophones() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => ({
      id: device.deviceId,
      label: device.label,
      groupId: device.groupId,
    }));
}

async function publishMicrophones() {
  try {
    ipcRenderer.send("audio:devices", await enumerateMicrophones());
  } catch (error) {
    const detail = serializeError(error);
    ipcRenderer.send("audio:devices", []);
    ipcRenderer.send("audio:device-error", detail.message, detail.name);
  }
}

if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void publishMicrophones();
  });
  void publishMicrophones();
}

function cleanup() {
  try {
    if (stream) for (const track of stream.getTracks()) track.stop();
  } catch {
    // ignore
  }
  stream = null;
  recorder = null;
  captureId = null;
  requestedStopEpoch = 0;
}

ipcRenderer.on("audio:start", async (_event, opts) => {
  const { id, bitsPerSecond, deviceId } = opts || {};
  if (typeof id !== "string" || !id) {
    ipcRenderer.send("audio:error", "", "Invalid microphone segment id.");
    return;
  }
  if (recorder && recorder.state !== "inactive") {
    ipcRenderer.send("audio:error", id, "Microphone capture is already active.");
    return;
  }
  try {
    captureId = id;
    requestedStopEpoch = 0;
    sendChain = Promise.resolve();
    // A plain microphone request. Echo cancellation / noise suppression keep the
    // narration clean for the transcriber without us touching the samples.
    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio: microphoneConstraints(deviceId),
      video: false,
    });
    if (captureId !== id) {
      for (const track of nextStream.getTracks()) track.stop();
      return;
    }
    stream = nextStream;
    void publishMicrophones();
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (!requestedStopEpoch) {
          ipcRenderer.send("audio:error", id, "The microphone disconnected.");
        }
      }, { once: true });
    }

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: bitsPerSecond });

    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      const segmentId = id;
      // Preserve order and completion; Uint8Array survives IPC structured clone.
      sendChain = sendChain.then(async () => {
        const buf = await e.data.arrayBuffer();
        ipcRenderer.send("audio:chunk", segmentId, new Uint8Array(buf));
      });
    };
    recorder.onstart = () => {
      const track = stream && stream.getAudioTracks()[0];
      const settings = track ? track.getSettings() : {};
      ipcRenderer.send("audio:started", id, epochNow(), {
        id: settings.deviceId || deviceId || "default",
        label: (track && track.label) || "Microphone",
        groupId: settings.groupId || "",
      });
    };
    recorder.onstop = () => {
      // Wait for every queued chunk (including the final one) to be sent.
      void handleRecorderStop({
        sendChain,
        id,
        getStopEpoch: () => requestedStopEpoch || epochNow(),
        cleanup,
        send: (...args) => ipcRenderer.send(...args),
      });
    };
    recorder.onerror = (e) => {
      const detail = serializeError((e && e.error) || e);
      ipcRenderer.send("audio:error", id, detail.message, detail.name);
    };

    // Emit a chunk every second so long sessions stream to disk incrementally.
    recorder.start(1000);
  } catch (err) {
    if (captureId === id) cleanup();
    const detail = serializeError(err);
    ipcRenderer.send("audio:error", id, detail.message, detail.name);
    ipcRenderer.send("audio:stopped", id, epochNow());
  }
});

ipcRenderer.on("audio:probe", async (_event, opts) => {
  const { requestId, deviceId } = opts || {};
  if (typeof requestId !== "string" || !requestId) return;
  let probeStream = null;
  try {
    if (recorder && recorder.state !== "inactive") {
      throw new Error("The microphone is already recording.");
    }
    probeStream = await navigator.mediaDevices.getUserMedia({
      audio: microphoneConstraints(deviceId),
      video: false,
    });
    for (const track of probeStream.getTracks()) track.stop();
    probeStream = null;
    const devices = await enumerateMicrophones();
    ipcRenderer.send("audio:probe-result", requestId, { ok: true, devices });
    ipcRenderer.send("audio:devices", devices);
  } catch (error) {
    if (probeStream) {
      for (const track of probeStream.getTracks()) track.stop();
    }
    const detail = serializeError(error);
    ipcRenderer.send("audio:probe-result", requestId, {
      ok: false,
      error: detail.message,
      errorName: detail.name,
    });
  }
});

ipcRenderer.on("audio:stop", (_event, opts) => {
  const id = opts && opts.id;
  if (typeof id !== "string" || id !== captureId) return;
  try {
    if (recorder && recorder.state !== "inactive") {
      requestedStopEpoch = epochNow();
      recorder.requestData();
      recorder.stop();
    } else {
      const stopEpoch = requestedStopEpoch || epochNow();
      cleanup();
      ipcRenderer.send("audio:stopped", id, stopEpoch);
    }
  } catch (err) {
    const stopEpoch = requestedStopEpoch || epochNow();
    cleanup();
    const detail = serializeError(err);
    ipcRenderer.send("audio:error", id, detail.message, detail.name);
    ipcRenderer.send("audio:stopped", id, stopEpoch);
  }
});

function epochNow() {
  return performance.timeOrigin + performance.now();
}

ipcRenderer.on("audio:decode", async (_event, opts) => {
  const { id, audioPath, sampleRate, chunkSamples } = opts || {};
  let context = null;
  try {
    if (
      typeof id !== "string" ||
      typeof audioPath !== "string" ||
      !Number.isSafeInteger(sampleRate) ||
      !Number.isSafeInteger(chunkSamples)
    ) {
      throw new Error("Invalid audio decode request.");
    }
    const encoded = await readFile(audioPath);
    const input = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    );
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Chromium AudioContext is unavailable.");
    // Let Chromium's audio pipeline perform the band-limited resample. Linear
    // interpolation here would alias frequencies above the 8 kHz Nyquist limit.
    context = new AudioContextClass({ sampleRate });
    const decoded = await context.decodeAudioData(input);
    if (decoded.sampleRate !== sampleRate) {
      throw new Error(
        `Chromium decoded narration at ${decoded.sampleRate} Hz instead of ${sampleRate} Hz.`,
      );
    }
    const outputLength = decoded.length;
    if (outputLength <= 0) throw new Error("Narration audio decoded to zero samples.");

    const channels = Array.from(
      { length: decoded.numberOfChannels },
      (_unused, index) => decoded.getChannelData(index),
    );
    ipcRenderer.send("audio:decode-meta", id, outputLength);
    for (let offset = 0; offset < outputLength; offset += chunkSamples) {
      const length = Math.min(chunkSamples, outputLength - offset);
      const output = new Float32Array(length);
      for (let index = 0; index < length; index++) {
        let value = 0;
        for (const channel of channels) {
          value += channel[offset + index];
        }
        output[index] = value / channels.length;
      }
      ipcRenderer.send("audio:decode-chunk", id, offset, output);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    ipcRenderer.send("audio:decode-done", id);
  } catch (err) {
    ipcRenderer.send(
      "audio:decode-error",
      id,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (context) await context.close().catch(() => undefined);
  }
});
