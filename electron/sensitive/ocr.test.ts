import assert from "node:assert/strict";
import test from "node:test";

import { Ocr } from "./ocr";

// The pool works with tesseract's Worker type; fakes are cast to it. Type-only import,
// so tesseract.js is never actually loaded when these tests run.
type Tesseract = typeof import("tesseract.js");
type TWorker = Awaited<ReturnType<Tesseract["createWorker"]>>;

interface TermLog {
  terminated: number;
}

function fakeWorker(log: TermLog, recognizeImpl?: () => Promise<unknown>): TWorker {
  return {
    terminate: async () => {
      log.terminated += 1;
    },
    recognize: recognizeImpl ?? (async () => ({ data: { blocks: [] } })),
    setParameters: async () => undefined,
  } as unknown as TWorker;
}

const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("ensureInit rolls back partially-built workers when one fails to spawn", async () => {
  const log: TermLog = { terminated: 0 };
  let spawns = 0;

  class PartialOcr extends Ocr {
    override isLanguageDataPresent(): boolean {
      return true;
    }
    protected override async spawnWorker(): Promise<TWorker> {
      spawns += 1;
      if (spawns === 2) throw new Error("spawn boom");
      return fakeWorker(log);
    }
  }

  const ocr = new PartialOcr({ langPath: "/unused", poolSize: 2 });
  await assert.rejects(ocr.warm(), /spawn boom/);
  // The worker built before the failure must be torn down, not left leaked in the pool.
  assert.equal(log.terminated, 1);
  assert.equal(spawns, 2);
});

test("ensureInit retries cleanly after a failed warm (no duplicated pool)", async () => {
  const log: TermLog = { terminated: 0 };
  let spawns = 0;
  let failNext = true;

  class RetryOcr extends Ocr {
    override isLanguageDataPresent(): boolean {
      return true;
    }
    protected override async spawnWorker(): Promise<TWorker> {
      spawns += 1;
      if (failNext && spawns === 2) throw new Error("spawn boom");
      return fakeWorker(log);
    }
  }

  const ocr = new RetryOcr({ langPath: "/unused", poolSize: 2 });
  await assert.rejects(ocr.warm(), /spawn boom/); // 1 built + rolled back, then boom
  assert.equal(log.terminated, 1);

  failNext = false;
  await ocr.warm(); // builds a fresh pool of exactly 2
  await ocr.terminate();
  // 1 rolled-back worker + exactly 2 in the live pool. A duplicated pool would be higher.
  assert.equal(log.terminated, 3);
});

test("terminate() rejects a queued recognition instead of hanging", async () => {
  const log: TermLog = { terminated: 0 };
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  class GatedOcr extends Ocr {
    override isLanguageDataPresent(): boolean {
      return true;
    }
    protected override async spawnWorker(): Promise<TWorker> {
      // A single worker whose recognize blocks on the gate, forcing a second
      // concurrent recognize to queue behind it.
      return fakeWorker(log, async () => {
        await gate;
        return { data: { blocks: [] } };
      });
    }
  }

  const ocr = new GatedOcr({ langPath: "/unused", poolSize: 1 });
  const img = Buffer.from([1, 2, 3, 4]); // not a real image → preprocessing falls back

  const first = ocr.recognize(img); // acquires the only worker, blocks on the gate
  await settle();
  const second = ocr.recognize(img); // no idle worker → queues as a waiter
  await settle();

  await ocr.terminate(); // must fail the queued recognition rather than leave it pending
  await assert.rejects(second, /terminated/);

  openGate();
  await first.catch(() => undefined); // let the in-flight recognition unwind
});
