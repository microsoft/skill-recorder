// Secret/credential detection layer. Wraps `@secretlint/core` — an
// offline, in-process linter — behind a small async surface that returns
// {@link SensitiveMatch}es for a single string. The engine and rule creators are
// imported dynamically so secretlint (and its large rule set) is only loaded the
// first time a scan actually runs, not at app startup.

import type { SecretLintCoreConfig, SecretLintCoreResult } from "@secretlint/types";

import type { SensitiveMatch } from "../../common/sensitive";
import { createLogger } from "../logger";
import { buildSecretlintConfig, mapSecretlintMessage } from "./secretlint-config";

const log = createLogger("Sensitive/secrets");

type LintSource = (args: {
  source: { content: string; filePath: string; ext?: string; contentType: "text" };
  options: { config: SecretLintCoreConfig; maskSecrets?: boolean };
}) => Promise<SecretLintCoreResult>;

interface Engine {
  lintSource: LintSource;
  config: SecretLintCoreConfig;
}

let enginePromise: Promise<Engine | null> | null = null;

/** Load the core engine + rule creators once and build the config. Memoized; on
 *  failure it resolves null and future calls retry from scratch. */
async function getEngine(): Promise<Engine | null> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [core, preset, pattern] = await Promise.all([
        import("@secretlint/core"),
        import("@secretlint/secretlint-rule-preset-recommend"),
        import("@secretlint/secretlint-rule-pattern"),
      ]);
      const config = buildSecretlintConfig(preset.creator, pattern.creator);
      return { lintSource: core.lintSource as LintSource, config };
    })().catch((err) => {
      log.warn("secretlint failed to load:", err instanceof Error ? err.message : err);
      enginePromise = null;
      return null;
    });
  }
  return enginePromise;
}

/**
 * Scan one string for secrets/credentials. Best-effort and non-throwing: any
 * engine failure yields no matches (the structured-PII layer still
 * runs). Returns raw matches (rank 90); the caller merges layers and resolves
 * overlaps. Never logs or returns the raw value except inside the match's
 * in-memory `value` field.
 */
export async function scanSecrets(text: string): Promise<SensitiveMatch[]> {
  if (!text || !text.trim()) return [];
  const engine = await getEngine();
  if (!engine) return [];
  try {
    const result = await engine.lintSource({
      source: { content: text, filePath: "session.txt", ext: ".txt", contentType: "text" },
      options: { config: engine.config, maskSecrets: true },
    });
    const matches: SensitiveMatch[] = [];
    for (const message of result.messages) {
      const match = mapSecretlintMessage(message, text);
      if (match) matches.push(match);
    }
    return matches;
  } catch (err) {
    log.warn("secret scan failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
