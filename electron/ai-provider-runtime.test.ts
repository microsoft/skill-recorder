import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { approveAll } from "@github/copilot-sdk";
import sharp from "sharp";
import { parseByomConfig } from "../common/ai-provider";
import { byomRuntimeConfig, connectAiClient, createAiSession } from "./ai-provider";

test("bundled runtime runs a synthetic BYOM image/tool turn without GitHub auth or persisted keys", { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-recorder-byom-runtime-"));
  const key = "test-only-byom-runtime-credential-not-a-real-key";
  const instructionMarker = "test-only-unrelated-cli-context";
  await mkdir(path.join(dir, ".github"));
  await writeFile(path.join(dir, ".github", "copilot-instructions.md"), instructionMarker);
  const bodies: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString());
    authorizations.push(request.headers.authorization);
    const tool = bodies.length === 1;
    const message = tool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_image", type: "function", function: { name: "connection_image", arguments: "{}" } }] }
      : { role: "assistant", content: "Connection OK." };
    const body: unknown = JSON.parse(bodies[bodies.length - 1]);
    if (typeof body === "object" && body !== null && "stream" in body && body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = tool
        ? { role: "assistant", tool_calls: [{ index: 0, id: "call_image", type: "function", function: { name: "connection_image", arguments: "{}" } }] }
        : { role: "assistant", content: "Connection OK." };
      response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "gpt-4.1", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "gpt-4.1", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "test", object: "chat.completion", model: "gpt-4.1",
        choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }] }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const profile = parseByomConfig({
    provider: "custom", baseUrl: "https://127.0.0.1:1/v1", model: "gpt-4.1", wireApi: "completions",
  });
  // The product requires HTTPS. Only this in-process, synthetic transport fixture uses loopback HTTP.
  const config = byomRuntimeConfig({ ...profile, baseUrl: `http://127.0.0.1:${address.port}/v1` }, key, dir);
  try {
    const client = await connectAiClient(config, "BYOM runtime smoke");
    try {
      let called = false;
      const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: "red" } }).png().toBuffer();
      const session = await createAiSession(client, {
        onPermissionRequest: approveAll, availableTools: ["connection_image"],
        enableHostGitOperations: false, infiniteSessions: { enabled: false }, workingDirectory: dir,
        tools: [{
          name: "connection_image", description: "Return a synthetic image.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          handler: () => {
            called = true;
            return { resultType: "success", textResultForLlm: "Synthetic image.",
              binaryResultsForLlm: [{ type: "image", mimeType: "image/png", data: image.toString("base64") }] };
          },
        }],
      }, config);
      assert.ok(session.sessionId);
      await session.sendAndWait({ prompt: "Call connection_image, inspect its image, then finish." }, 45_000);
      assert.equal(called, true);
      assert.equal(bodies.length, 2);
      assert.ok(/data:image\/(?:png|jpeg|webp);base64,/.test(bodies[1]),
        `The SDK must forward tool images. Image fields: ${JSON.stringify(bodies[1].match(/.{0,25}(?:image|base64).{0,60}/g))}`);
      assert.equal(bodies.some((body) => body.includes(instructionMarker)), false, "BYOM must not load unrelated CLI instructions.");
      assert.deepEqual(authorizations, [`Bearer ${key}`, `Bearer ${key}`]);
      await session.disconnect();
    } finally { await client.forceStop(); }
    const check = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await check(file);
        else if (entry.isFile()) {
          const contents = await readFile(file);
          assert.equal(contents.includes(Buffer.from(key)), false, `Credential leaked in ${entry.name}`);
          assert.equal(contents.includes(Buffer.from(Buffer.from(key).toString("base64"))), false, `Encoded credential leaked in ${entry.name}`);
        }
      }
    };
    await check(dir);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
