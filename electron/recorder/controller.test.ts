import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
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

    test("selected screen source is passed to the video recorder", async () => {
      await withSessionsRoot(async () => {
        let selectedSourceId: string | undefined;
        let selectedDisplayId: string | undefined;
        const controller = new RecorderController({
          resolveConfig: () => ({ ...FULL_CAPTURE }),
          buildCollectors: () => [],
          createVideoRecorder: () => ({
            start: async (_dir, sourceId, displayId) => {
              selectedSourceId = sourceId;
              selectedDisplayId = displayId;
            },
            stop: async () => null,
          }),
          deleteSession: async () => undefined,
        });

        assert.equal(
          (
            await controller.start({
              screenSourceId: "screen:2:0",
              screenDisplayId: "202",
            })
          ).ok,
          true,
        );
        assert.equal(selectedSourceId, "screen:2:0");
        assert.equal(selectedDisplayId, "202");
        assert.equal((await controller.stop()).ok, true);
      });
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

test("stop recovers to idle when finalizing the session fails", async () => {
  await withSessionsRoot(async (root) => {
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => [],
      deleteSession: async () => undefined,
    });

    const started = await controller.start();
    assert.equal(started.ok, true);
    const id = started.sessionId;
    assert.ok(id);

    // Force finalize() to throw the way a real disk failure would: replace the
    // metadata file with a directory so writeMeta()'s writeFileSync hits EISDIR.
    // A regression here leaves the state machine wedged in "stopping" forever.
    await rm(path.join(root, id, "session.json"), { force: true });
    await mkdir(path.join(root, id, "session.json"));

    const stopped = await controller.stop();
    assert.equal(stopped.ok, false);
    assert.match(stopped.error ?? "", /finaliz/i);
    assert.equal(controller.status().state, "idle");
    assert.equal(controller.status().transition, "none");

    // The recorder must accept a brand-new recording afterwards (not stay wedged).
    const restarted = await controller.start();
    assert.equal(restarted.ok, true);
    assert.equal(controller.status().state, "recording");
    assert.equal((await controller.stop()).ok, true);
  });
});

test("start recovers to idle when collector setup throws", async () => {
  await withSessionsRoot(async () => {
    let attempts = 0;
    const controller = new RecorderController({
      resolveConfig: () => ({ ...FULL_CAPTURE, video: false }),
      buildCollectors: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("collector build failed");
        return [];
      },
      deleteSession: async () => undefined,
    });

    // The throw lands after the store is attached and the transition is "starting";
    // a regression leaves the machine reporting "recording" with no way to recover.
    const first = await controller.start();
    assert.equal(first.ok, false);
    assert.match(first.error ?? "", /collector build failed/i);
    assert.equal(controller.status().state, "idle");
    assert.equal(controller.status().transition, "none");

    const second = await controller.start();
    assert.equal(second.ok, true);
    assert.equal(controller.status().state, "recording");
    assert.equal((await controller.stop()).ok, true);
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
