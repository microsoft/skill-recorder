import assert from "node:assert/strict";
import test from "node:test";

import { planToolLabel } from "./plan-tools";
import { PlanStepSchema } from "./skill";

test("PlanStepSchema migrates a legacy tool string", () => {
  const step = PlanStepSchema.parse({
    kind: "calculation",
    title: "Find projects",
    text: "Find matching project folders.",
    tool: "glob",
  });

  assert.deepEqual(step.tools, ["glob"]);
  assert.equal("tool" in step, false);
});

test("PlanStepSchema preserves ordered tools and removes duplicates", () => {
  const step = PlanStepSchema.parse({
    kind: "action",
    title: "Message myself",
    text: "Find my self-chat and send the result.",
    tools: [
      "workiq_get_my_profile",
      "workiq_search_chats",
      "workiq_send_chat_message",
      "workiq_search_chats",
    ],
  });

  assert.deepEqual(step.tools, [
    "workiq_get_my_profile",
    "workiq_search_chats",
    "workiq_send_chat_message",
  ]);
});

test("planToolLabel explains implementation-oriented runtime identifiers", () => {
  assert.equal(planToolLabel("glob"), "Find local paths");
  assert.equal(planToolLabel("workiq_send_chat_message"), "Send Teams message");
  assert.equal(planToolLabel("browser_fill_form"), "Fill form · Browser");
});
