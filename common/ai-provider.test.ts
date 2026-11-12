import assert from "node:assert/strict";
import test from "node:test";
import { parseApiKey, parseByomConfig, sameCredentialDestination } from "./ai-provider";

const config = { provider: "foundry", baseUrl: "https://example.openai.azure.com/openai/v1/", model: "my-deployment", wireApi: "responses" };

test("Foundry and native Azure require their distinct endpoint formats", () => {
  const foundry = parseByomConfig(config);
  assert.equal(foundry.baseUrl, "https://example.openai.azure.com/openai/v1");
  assert.equal(foundry.model, "my-deployment");
  assert.throws(() => parseByomConfig({ ...config, baseUrl: "https://example.openai.azure.com" }), /openai\/v1/);
  assert.throws(() => parseByomConfig({ ...config, provider: "azure", apiVersion: "2024-10-21" }), /without an API path/);
  assert.equal(parseByomConfig({
    ...config, provider: "azure", baseUrl: "https://example.openai.azure.com", apiVersion: "2024-10-21",
  }).apiVersion, "2024-10-21");
});

test("rejects unsafe URLs, operation URLs, missing models, and header injection", () => {
  for (const baseUrl of [
    "http://example.com/v1", "https://key@example.com/v1", "https://example.com/v1?key=secret",
    "https://example.com/v1#secret", "https://example.com/v1/responses", "not a url",
  ]) assert.throws(() => parseByomConfig({ ...config, provider: "custom", baseUrl }));
  assert.throws(() => parseByomConfig({ ...config, model: "" }));
  assert.throws(() => parseApiKey("key\r\nAuthorization: injected"));
  assert.throws(() => parseApiKey(" "));
});

test("a saved key cannot be reused for a different endpoint or protocol", () => {
  const a = parseByomConfig(config);
  assert.equal(sameCredentialDestination(a, { ...a, model: "another-model" }), true);
  assert.equal(sameCredentialDestination(a, { ...a, baseUrl: "https://another.example/v1" }), false);
  assert.equal(sameCredentialDestination(a, { ...a, provider: "custom" }), false);
});
