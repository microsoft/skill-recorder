// Pure configuration + message-mapping for the secretlint detection layer.
//
// This module has NO runtime dependency on secretlint — it only imports types —
// so it can be unit-tested in isolation. `secrets.ts` dynamically imports the
// actual `@secretlint/core` engine and the rule creators, passes the creators to
// {@link buildSecretlintConfig}, and maps each reported message back to a
// {@link SensitiveMatch} via {@link mapSecretlintMessage}.

import type {
  SecretLintCoreConfig,
  SecretLintCoreResultMessage,
  SecretLintRuleCreator,
  SecretLintRulePresetCreator,
} from "@secretlint/types";

import type { SensitiveCategory, SensitiveMatch, SensitiveSeverity } from "../../common/sensitive";

/** Secrets always outrank structured PII (40–55) when two matches overlap the
 *  same span — a leaked credential is the worst case. */
const SECRET_RANK = 90;
const SECRET_SEVERITY: SensitiveSeverity = "high";

const PRESET_RULE_ID = "@secretlint/secretlint-rule-preset-recommend";
const PATTERN_RULE_ID = "@secretlint/secretlint-rule-pattern";
const AWS_RULE_ID = "@secretlint/secretlint-rule-aws";

/**
 * JSON Web Token: `header.payload.signature`, each a base64url segment, the first
 * two beginning with the `{"` prefix that base64url-encodes to `eyJ`. The preset
 * does not catch bare JWTs, so we add this via the pattern rule.
 */
const JWT_PATTERN = "eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}";
const JWT_PATTERN_NAME = "JSON Web Token";

interface CategoryLabel {
  category: SensitiveCategory;
  label: string;
}

/**
 * Map a secretlint rule id to our category + human label. The preset bundles 28
 * provider rules; nearly all are API keys/tokens. Private keys and credential
 * pairs get their own categories so the review UI can group them meaningfully.
 * Unknown ids fall back to a generic API-key label.
 */
const RULE_MAP: Record<string, CategoryLabel> = {
  "@secretlint/secretlint-rule-privatekey": { category: "private-key", label: "Private key" },
  "@secretlint/secretlint-rule-basicauth": { category: "password", label: "Basic-auth credentials" },
  "@secretlint/secretlint-rule-database-connection-string": {
    category: "password",
    label: "Database connection string",
  },
  [PATTERN_RULE_ID]: { category: "jwt", label: JWT_PATTERN_NAME },
  [AWS_RULE_ID]: { category: "api-key", label: "AWS credential" },
  "@secretlint/secretlint-rule-gcp": { category: "api-key", label: "Google Cloud key" },
  "@secretlint/secretlint-rule-github": { category: "api-key", label: "GitHub token" },
  "@secretlint/secretlint-rule-gitlab": { category: "api-key", label: "GitLab token" },
  "@secretlint/secretlint-rule-openai": { category: "api-key", label: "OpenAI API key" },
  "@secretlint/secretlint-rule-anthropic": { category: "api-key", label: "Anthropic API key" },
  "@secretlint/secretlint-rule-slack": { category: "api-key", label: "Slack token" },
  "@secretlint/secretlint-rule-stripe": { category: "api-key", label: "Stripe key" },
  "@secretlint/secretlint-rule-sendgrid": { category: "api-key", label: "SendGrid API key" },
  "@secretlint/secretlint-rule-npm": { category: "api-key", label: "npm token" },
  "@secretlint/secretlint-rule-shopify": { category: "api-key", label: "Shopify token" },
  "@secretlint/secretlint-rule-huggingface": { category: "api-key", label: "Hugging Face token" },
  "@secretlint/secretlint-rule-notion": { category: "api-key", label: "Notion token" },
  "@secretlint/secretlint-rule-linear": { category: "api-key", label: "Linear API key" },
  "@secretlint/secretlint-rule-figma": { category: "api-key", label: "Figma token" },
  "@secretlint/secretlint-rule-cloudflare": { category: "api-key", label: "Cloudflare token" },
  "@secretlint/secretlint-rule-databricks": { category: "api-key", label: "Databricks token" },
  "@secretlint/secretlint-rule-docker": { category: "password", label: "Docker credentials" },
  "@secretlint/secretlint-rule-grafana": { category: "api-key", label: "Grafana token" },
  "@secretlint/secretlint-rule-groq": { category: "api-key", label: "Groq API key" },
  "@secretlint/secretlint-rule-hashicorp-vault": {
    category: "api-key",
    label: "HashiCorp Vault token",
  },
  "@secretlint/secretlint-rule-tailscale": { category: "api-key", label: "Tailscale key" },
  "@secretlint/secretlint-rule-vercel": { category: "api-key", label: "Vercel token" },
  "@secretlint/secretlint-rule-1password": { category: "api-key", label: "1Password token" },
};

/** Best category + label for a reported message, preferring the specific rule id
 *  and falling back to the preset parent, then to a generic secret label. */
function categoryFor(message: SecretLintCoreResultMessage): CategoryLabel {
  return (
    RULE_MAP[message.ruleId] ??
    (message.ruleParentId ? RULE_MAP[message.ruleParentId] : undefined) ?? {
      category: "api-key",
      label: "Secret or token",
    }
  );
}

/**
 * Convert one secretlint result message into a {@link SensitiveMatch}, slicing the
 * raw value straight out of the scanned `content` via the message range so we never
 * depend on secretlint's (possibly masked) message text. Returns null for an empty
 * or out-of-bounds range.
 */
export function mapSecretlintMessage(
  message: SecretLintCoreResultMessage,
  content: string,
): SensitiveMatch | null {
  const [start, end] = message.range;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end > content.length ||
    end <= start
  ) {
    return null;
  }
  const value = content.slice(start, end);
  if (!value.trim()) return null;
  const { category, label } = categoryFor(message);
  return { category, label, severity: SECRET_SEVERITY, value, start, end, rank: SECRET_RANK };
}

/**
 * Build the in-process secretlint config from the dynamically-imported rule
 * creators. Enables the preset's AWS access-key-ID scan (off by default) — with
 * non-blocking auto-redaction a false positive is cheap and a missed AWS key is
 * expensive — and adds a JWT pattern the preset doesn't cover.
 */
export function buildSecretlintConfig(
  presetCreator: SecretLintRulePresetCreator,
  patternCreator: SecretLintRuleCreator,
): SecretLintCoreConfig {
  return {
    rules: [
      {
        id: PRESET_RULE_ID,
        rule: presetCreator,
        rules: [{ id: AWS_RULE_ID, options: { enableIDScanRule: true } }],
      },
      {
        id: PATTERN_RULE_ID,
        rule: patternCreator,
        options: { patterns: [{ name: JWT_PATTERN_NAME, pattern: `/${JWT_PATTERN}/g` }] },
      },
    ],
  };
}
