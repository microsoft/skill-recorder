import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FULL_CAPTURE } from "../../common/config";
import type { NarrationLanguage } from "../../common/narration";
import type { MicrophoneDevice } from "../../common/microphone";
import { RecorderController, type SessionAudioRecorder } from "./controller";

class FakeAudioRecorder implements SessionAudioRecorder {
  readonly calls: string[] = [];
  readonly deviceIds: string[] = [];
  finishVideoStartEpoch: number | null | undefined;
  narrationLanguage: NarrationLanguage | null = null;
  failEnable = false;

  async start(
    _sessionDir: string,
    _sessionStartedAt: number,
    narrationLanguage: NarrationLanguage,
  ): Promise<void> {
    this.calls.push("start");
    this.narrationLanguage = narrationLanguage;
  }

  async enable(deviceId = "default"): Promise<MicrophoneDevice> {
    this.calls.push("enable");
    this.deviceIds.push(deviceId);
    if (this.failEnable) throw new Error("Microphone permission denied.");
    return {
      id: deviceId,
      label: deviceId === "default" ? "System microphone" : `Microphone ${deviceId}`,
      groupId: "",
    };
  }

  async disable(): Promise<void> {
    this.calls.push("disable");
  }

  async finish(videoStartEpoch: number | null): Promise<void> {
    this.calls.push("finish");
    this.finishVideoStartEpoch = videoStartEpoch;
  }
}

test("microphone toggles are serialized and finalized on save", async () => {
  await withSessionsRoot(async () => {
    const audio = new FakeAudioRecorder();
    let processed = 0;
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE }),
      buildCollectors: () => [],
      createVideoRecorder: () => ({
        start: async () => undefined,
        stop: async () => ({ startEpoch: 1_234 }),
      }),
      createAudioRecorder: () => audio,
      deleteSession: async () => undefined,
      postProcess: async () => {
        processed++;
      },
    });

    const started = await controller.start();
    assert.equal(started.ok, true);
    assert.equal(audio.narrationLanguage, "en");
    assert.equal(controller.status().microphone.state, "off");

    assert.equal((await controller.setMicrophoneEnabled(true)).ok, true);
    assert.equal(controller.status().microphone.state, "on");
    assert.equal((await controller.setMicrophoneEnabled(false)).ok, true);
    assert.equal((await controller.setMicrophoneEnabled(true)).ok, true);

    const stopped = await controller.stop();
    assert.equal(stopped.ok, true);
    assert.equal(controller.status().state, "idle");
    assert.equal(controller.status().transition, "none");
    assert.equal(controller.status().lastSession?.id, started.sessionId);
    assert.deepEqual(controller.status().lastFinish, {
      sessionId: started.sessionId,
      outcome: "saved",
    });
    assert.deepEqual(audio.calls, [
      "start",
      "enable",
      "disable",
      "enable",
      "disable",
      "finish",
    ]);
    assert.equal(audio.finishVideoStartEpoch, 1_234);

    await controller.whenProcessed();
    assert.equal(processed, 1);
  });
});

test("marker is rejected when not recording and persisted when recording", async () => {
  await withSessionsRoot(async (root) => {
    const audio = new FakeAudioRecorder();
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      createAudioRecorder: () => audio,
      deleteSession: async () => undefined,
    });

    const rejected = controller.marker("too early");
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /not recording/i);

    const started = await controller.start();
    assert.equal(started.ok, true);

    const accepted = controller.marker("checkpoint reached");
    assert.equal(accepted.ok, true);

    assert.equal((await controller.stop()).ok, true);

    assert.ok(started.sessionId, "expected session ID");
    const events = await readFile(
      path.join(root, started.sessionId, "events.jsonl"),
      "utf8",
    );
    const marker = events
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: { note: string } })
      .find((event) => event.type === "marker");
    assert.ok(marker, "expected a persisted marker event");
    assert.equal(marker?.payload.note, "checkpoint reached");
  });
});

test("preferred narration language is reused by optionless recording starts", async () => {
  await withSessionsRoot(async () => {
    const audio = new FakeAudioRecorder();
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      createAudioRecorder: () => audio,
      deleteSession: async () => undefined,
    });

    assert.deepEqual(await controller.setNarrationLanguage("it"), {
      ok: true,
      language: "it",
    });
    const started = await controller.start({ narration: true });
    assert.equal(started.ok, true);
    assert.equal(audio.narrationLanguage, "it");
    assert.equal(controller.status().narrationLanguage, "it");
    const changeWhileRecording = await controller.setNarrationLanguage("fr");
    assert.equal(changeWhileRecording.ok, false);
    assert.match(changeWhileRecording.error ?? "", /cannot change while recording/i);
    assert.equal((await controller.stop()).ok, true);
  });
});

test("discard removes the active session and skips post-processing", async () => {
  await withSessionsRoot(async (root) => {
    const audio = new FakeAudioRecorder();
    let processed = 0;
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      createAudioRecorder: () => audio,
      deleteSession: async (id) => rm(path.join(root, id), { recursive: true }),
      postProcess: async () => {
        processed++;
      },
    });

    const started = await controller.start({
      narration: true,
      microphoneDeviceId: "usb-desk",
    });
    assert.equal(started.ok, true);
    const id = started.sessionId;
    assert.ok(id);
    assert.equal(controller.status().microphone.state, "on");
    assert.equal(controller.status().microphone.activeDevice?.id, "usb-desk");
    assert.deepEqual(audio.deviceIds, ["usb-desk"]);

    const discarded = await controller.discard();
    assert.equal(discarded.ok, true);
    assert.equal(discarded.sessionId, id);
    assert.equal(controller.status().state, "idle");
    assert.equal(controller.status().lastSession, null);
    assert.deepEqual(controller.status().lastFinish, {
      sessionId: id,
      outcome: "discarded",
    });
    assert.equal(processed, 0);
    await assert.rejects(access(path.join(root, id)), { code: "ENOENT" });
    assert.deepEqual(audio.calls, ["start", "enable", "disable", "finish"]);
  });
});

test("failed discard retains and post-processes the finalized session", async () => {
  await withSessionsRoot(async () => {
    let processed = 0;
    let releaseProcessing: () => void = () => undefined;
    const processingGate = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      deleteSession: async () => {
        throw new Error("Access denied.");
      },
      postProcess: async () => {
        processed++;
        await processingGate;
      },
    });

    const started = await controller.start();
    assert.equal(started.ok, true);

    const discarded = await controller.discard();
    assert.equal(discarded.ok, false);
    assert.match(discarded.error ?? "", /could not be discarded.*access denied/i);
    assert.deepEqual(controller.status().lastFinish, {
      sessionId: started.sessionId,
      outcome: "saved",
    });
    assert.deepEqual(controller.status().lastSession, {
      id: started.sessionId,
      processed: false,
    });

    assert.equal(processed, 1);
    const drained = controller.whenProcessed();
    releaseProcessing();
    await drained;
    assert.deepEqual(controller.status().lastSession, {
      id: started.sessionId,
      processed: true,
    });
  });
});

test("unexpected microphone termination updates live status without ending video capture", async () => {
  await withSessionsRoot(async () => {
    const audio = new FakeAudioRecorder();
    let notifyEnded: (event: { error: string | null }) => void = () => {
      throw new Error("Microphone callback was not registered.");
    };
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      createAudioRecorder: (notify) => {
        notifyEnded = notify;
        return audio;
      },
      deleteSession: async () => undefined,
    });

    assert.equal((await controller.start()).ok, true);
    assert.equal((await controller.setMicrophoneEnabled(true)).ok, true);
    notifyEnded({ error: "The microphone disconnected." });
    assert.equal(controller.status().state, "recording");
    assert.deepEqual(controller.status().microphone, {
      state: "error",
      error: "The microphone disconnected.",
      activeDevice: null,
    });
    assert.equal((await controller.stop()).ok, true);
  });
});

test("shutdown rejects queued and future recording starts", async () => {
  await withSessionsRoot(async () => {
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      deleteSession: async () => undefined,
    });

    controller.beginShutdown();
    const result = await controller.start();
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /shutting down/i);
    assert.equal(controller.status().state, "idle");
  });
});

test("discard outcome is not confused with an earlier saved session", async () => {
  await withSessionsRoot(async (root) => {
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      deleteSession: async (id) => rm(path.join(root, id), { recursive: true }),
    });

    const saved = await controller.start();
    assert.equal(saved.ok, true);
    assert.equal((await controller.stop()).ok, true);

    const discarded = await controller.start();
    assert.equal(discarded.ok, true);
    assert.equal((await controller.discard()).ok, true);
    assert.equal(controller.status().lastSession?.id, saved.sessionId);
    assert.deepEqual(controller.status().lastFinish, {
      sessionId: discarded.sessionId,
      outcome: "discarded",
    });
  });
});

test("microphone failure is surfaced without stopping screen capture", async () => {
  await withSessionsRoot(async () => {
    const audio = new FakeAudioRecorder();
    audio.failEnable = true;
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      createAudioRecorder: () => audio,
      deleteSession: async () => undefined,
    });

    assert.equal((await controller.start()).ok, true);
    const result = await controller.setMicrophoneEnabled(true);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /permission denied/i);
    assert.equal(controller.status().state, "recording");
    assert.equal(controller.status().microphone.state, "error");
    assert.equal((await controller.stop()).ok, true);
  });
});

test("switching an active microphone closes one segment before starting the next", async () => {
  await withSessionsRoot(async () => {
    const audio = new FakeAudioRecorder();
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      createAudioRecorder: () => audio,
      deleteSession: async () => undefined,
    });

    assert.equal((await controller.start()).ok, true);
    assert.equal(
      (await controller.setMicrophoneEnabled(true, "built-in")).ok,
      true,
    );
    assert.equal((await controller.setMicrophoneDevice("usb-desk")).ok, true);
    assert.deepEqual(audio.calls, ["start", "enable", "disable", "enable"]);
    assert.deepEqual(audio.deviceIds, ["built-in", "usb-desk"]);
    assert.equal(controller.status().microphone.state, "on");
    assert.equal(controller.status().microphone.activeDevice?.id, "usb-desk");

    assert.equal((await controller.stop()).ok, true);
  });
});

test("stop waits behind an in-flight microphone enable", async () => {
  await withSessionsRoot(async () => {
    let releaseEnable: () => void = () => undefined;
    const enableGate = new Promise<void>((resolve) => {
      releaseEnable = resolve;
    });
    const calls: string[] = [];
    const audio: SessionAudioRecorder = {
      start: async () => {
        calls.push("start");
      },
      enable: async () => {
        calls.push("enable:start");
        await enableGate;
        calls.push("enable:end");
      },
      disable: async () => {
        calls.push("disable");
      },
      finish: async () => {
        calls.push("finish");
      },
    };
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      createAudioRecorder: () => audio,
      deleteSession: async () => undefined,
    });

    assert.equal((await controller.start()).ok, true);
    const enabling = controller.setMicrophoneEnabled(true);
    const stopping = controller.stop();
    await Promise.resolve();
    assert.deepEqual(calls, ["start", "enable:start"]);

    releaseEnable();
    assert.equal((await enabling).ok, true);
    assert.equal((await stopping).ok, true);
    assert.deepEqual(calls, ["start", "enable:start", "enable:end", "disable", "finish"]);
  });
});

async function withSessionsRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-controller-"));
  const previousRoot = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  try {
    await run(root);
  } finally {
    if (previousRoot === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}
