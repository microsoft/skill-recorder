import assert from "node:assert/strict";
import test from "node:test";

import {
  constrainAllowedTools,
  isSubsumedBy,
  parseToolPattern,
} from "./allowed-tools";

test("tool patterns parse into a tool name and an optional argument pattern", () => {
  // A bare tool name places no restriction on arguments.
  assert.deepEqual(parseToolPattern("Read"), { tool: "Read", arg: null });
  // The common gated-shell shape.
  assert.deepEqual(parseToolPattern("Bash(gh *)"), { tool: "Bash", arg: "gh *" });
  // Surrounding whitespace is incidental formatting, never part of the grant.
  assert.deepEqual(parseToolPattern("  Bash( gh * ) "), { tool: "Bash", arg: "gh *" });
  // A command may legitimately contain parentheses; only the outermost pair delimits.
  assert.deepEqual(parseToolPattern("Bash(echo (hi))"), { tool: "Bash", arg: "echo (hi)" });
  // Unparseable input is not a grant — callers must drop it rather than guess.
  assert.equal(parseToolPattern(""), null);
  assert.equal(parseToolPattern("   "), null);
  assert.equal(parseToolPattern("(gh *)"), null);
});

test("narrowing an approved pattern is preserved", () => {
  // THE REGRESSION THIS MODULE EXISTS FOR. The builder's contract explicitly allows the
  // agent to tighten allowed-tools to the steps it actually emitted. A plain string
  // comparison would reject every one of these, silently discarding the narrowing and
  // falling back to the broader approved pattern.
  assert.equal(isSubsumedBy("Bash(gh pr list)", "Bash(gh *)"), true);
  assert.equal(isSubsumedBy("Bash(gh pr *)", "Bash(gh *)"), true);
  assert.equal(isSubsumedBy("Bash(gh issue create --title x)", "Bash(gh *)"), true);
  // Self-subsumption: an unchanged pattern is trivially within itself.
  assert.equal(isSubsumedBy("Bash(gh *)", "Bash(gh *)"), true);
  assert.equal(isSubsumedBy("Read", "Read"), true);
});

test("broadening past the approved pattern is rejected", () => {
  // The whole point of the gate: the model must not hand itself a wider shell.
  assert.equal(isSubsumedBy("Bash(*)", "Bash(gh *)"), false);
  assert.equal(isSubsumedBy("Bash(rm -rf /)", "Bash(gh *)"), false);
  assert.equal(isSubsumedBy("Bash(git push)", "Bash(gh *)"), false);
  // Subsumption is directional — a wider pattern is not covered by a narrower one.
  assert.equal(isSubsumedBy("Bash(gh *)", "Bash(gh pr *)"), false);
  // A different tool is never covered, however similar the argument pattern.
  assert.equal(isSubsumedBy("Write", "Read"), false);
  assert.equal(isSubsumedBy("Bash(gh *)", "Shell(gh *)"), false);
});

test("a bare tool name is the unrestricted form of that tool", () => {
  // `Bash` places no argument restriction, so it covers any gated form of itself.
  assert.equal(isSubsumedBy("Bash(gh *)", "Bash"), true);
  assert.equal(isSubsumedBy("Bash(*)", "Bash"), true);
  // …and conversely, dropping the restriction is a broadening, so it must be refused.
  assert.equal(isSubsumedBy("Bash", "Bash(gh *)"), false);
});

test("argument patterns match literally except for `*`", () => {
  // Regex metacharacters in a command must not silently widen the match: `a.b` is a
  // literal dot, so `axb` is a different command and must not be treated as covered.
  assert.equal(isSubsumedBy("Bash(echo a.b)", "Bash(echo a.b)"), true);
  assert.equal(isSubsumedBy("Bash(echo axb)", "Bash(echo a.b)"), false);
  assert.equal(isSubsumedBy("Bash(echo a+b)", "Bash(echo a+b)"), true);
  // `*` is the only wildcard, and it may appear anywhere in the pattern.
  assert.equal(isSubsumedBy("Bash(gh pr list --json x)", "Bash(gh * --json *)"), true);
  assert.equal(isSubsumedBy("Bash(gh pr list --yaml x)", "Bash(gh * --json *)"), false);
});

test("tool names compare case-insensitively, argument patterns do not", () => {
  // Tool names are identifiers — a case slip should not silently drop a valid narrowing.
  assert.equal(isSubsumedBy("bash(gh pr list)", "Bash(gh *)"), true);
  // Shell arguments are case-sensitive: `GH` is not the `gh` CLI.
  assert.equal(isSubsumedBy("Bash(GH pr list)", "Bash(gh *)"), false);
});

test("an approved literal cannot partially match the wildcard sentinel", () => {
  // The submitted `*` is substituted with a sentinel before matching. If that sentinel
  // were multi-character, an approved pattern whose literal segment is a PREFIX of it
  // would match part of the substitution and wrongly report the grant as covered —
  // failing OPEN, the one direction this must never fail in. These are the cases that
  // caught it; they only pass while the sentinel is a single character.
  assert.equal(isSubsumedBy("Bash(a*)", "Bash(a@@skill*)"), false);
  assert.equal(isSubsumedBy("Bash(x*)", "Bash(x@@*)"), false);
  assert.equal(isSubsumedBy("Bash(*)", "Bash(@@skill-recorder-wildcard*)"), false);
  // A literal that merely starts the same way is not coverage either.
  assert.equal(isSubsumedBy("Bash(deploy *)", "Bash(deploy-prod *)"), false);
});

test("constrain keeps the covered patterns and reports the rest", () => {
  // The realistic case: the agent narrows one step correctly and invents another.
  const result = constrainAllowedTools(
    ["Bash(gh pr list)", "Bash(rm -rf /)", "Read"],
    ["Bash(gh *)", "Read", "Write"],
  );
  assert.deepEqual(result.allowed, ["Bash(gh pr list)", "Read"]);
  assert.deepEqual(result.dropped, ["Bash(rm -rf /)"]);
});

test("constrain falls back to the approved set rather than emitting an empty list", () => {
  // An omitted `allowed-tools` means "use the agent's DEFAULT set", which can be WIDER
  // than what the human approved. So when nothing survives, we must re-assert the
  // approved patterns instead of shipping an empty (= unrestricted-by-default) list.
  const rejected = constrainAllowedTools(["Bash(rm -rf /)"], ["Bash(gh *)"]);
  assert.deepEqual(rejected.allowed, ["Bash(gh *)"]);
  assert.deepEqual(rejected.dropped, ["Bash(rm -rf /)"]);

  // The agent declining to restate the tools is not a narrowing — keep what was approved.
  const empty = constrainAllowedTools([], ["Bash(gh *)"]);
  assert.deepEqual(empty.allowed, ["Bash(gh *)"]);
  assert.deepEqual(empty.dropped, []);
});

test("an approved-empty plan stays on the default set", () => {
  // The plan declared no `allowed-tools`, so the human approved "whatever the agent
  // normally has". We cannot prove an explicit pattern is narrower than an unknown
  // default set, so nothing is accepted and the frontmatter stays omitted.
  const result = constrainAllowedTools(["Bash(gh *)"], []);
  assert.deepEqual(result.allowed, []);
  assert.deepEqual(result.dropped, ["Bash(gh *)"]);
});

test("constrain is robust to blank and duplicate entries", () => {
  // Blank entries carry no grant and must not survive into the frontmatter.
  const result = constrainAllowedTools(
    ["Bash(gh pr list)", "  ", "Bash(gh pr list)"],
    ["Bash(gh *)"],
  );
  assert.deepEqual(result.allowed, ["Bash(gh pr list)"]);
  assert.deepEqual(result.dropped, []);
});

test("patterns that differ only in spelling collapse to one entry", () => {
  // Same grant, different whitespace or tool-name casing — emitting all of them would
  // put visibly redundant lines in the SKILL.md frontmatter. The first spelling wins.
  const result = constrainAllowedTools(
    ["Bash(gh pr list)", "Bash( gh pr list )", "bash(gh pr list)"],
    ["Bash(gh *)"],
  );
  assert.deepEqual(result.allowed, ["Bash(gh pr list)"]);

  // Argument patterns stay case-sensitive, so these are genuinely different grants and
  // must not be collapsed — only the one the plan covers survives.
  const cased = constrainAllowedTools(["Bash(gh pr)", "Bash(GH pr)"], ["Bash(gh *)"]);
  assert.deepEqual(cased.allowed, ["Bash(gh pr)"]);
  assert.deepEqual(cased.dropped, ["Bash(GH pr)"]);
});
