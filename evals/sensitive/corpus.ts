// Fixed corpus for the sensitive-detail detection + redaction evals.
//
// Each case is a single outgoing text string plus two ground-truth lists:
//   - mustRedact: raw substrings that MUST be detected and masked out before the
//     text could be sent to GitHub Copilot (recall).
//   - mustKeep: non-sensitive substrings that MUST survive redaction untouched
//     (precision — guards against over-masking ordinary prose).
//
// All secrets/PII here are FAKE, shaped only to trip the detectors.

export interface SensitiveCase {
  id: string;
  /** What this case exercises, for the report. */
  about: string;
  text: string;
  mustRedact: string[];
  mustKeep: string[];
}

const GH_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const OPENAI = "sk-" + "A".repeat(20) + "T3BlbkFJ" + "B".repeat(20);
const SLACK = "xoxb-" + "1".repeat(12) + "-" + "2".repeat(12) + "-" + "abcdefghijklmnopqrstuvwx";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ." +
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

export const sensitiveCorpus: SensitiveCase[] = [
  {
    id: "github-token",
    about: "GitHub token in a terminal command (secretlint)",
    text: `git push && echo ${GH_TOKEN} | pbcopy`,
    mustRedact: [GH_TOKEN],
    mustKeep: ["git push", "pbcopy"],
  },
  {
    id: "openai-key",
    about: "OpenAI API key in an env assignment (secretlint)",
    text: `export OPENAI_API_KEY=${OPENAI} && run agent`,
    mustRedact: [OPENAI],
    mustKeep: ["export OPENAI_API_KEY=", "run agent"],
  },
  {
    id: "slack-token",
    about: "Slack bot token (secretlint)",
    text: `curl -H "Authorization: Bearer ${SLACK}" https://slack.com/api/auth.test`,
    mustRedact: [SLACK],
    mustKeep: ["slack.com/api/auth.test"],
  },
  {
    id: "jwt",
    about: "JSON Web Token in an Authorization header (secretlint)",
    text: `Authorization: Bearer ${JWT}`,
    mustRedact: [JWT],
    mustKeep: ["Authorization: Bearer"],
  },
  {
    id: "basic-auth-url",
    about: "Credentials embedded in a URL (secretlint)",
    text: "clone https://svc:S3cretPass99@git.internal.example.com/repo.git now",
    mustRedact: ["S3cretPass99"],
    mustKeep: ["clone ", "/repo.git now"],
  },
  {
    id: "email",
    about: "Email address (structured PII)",
    text: "ping the owner at jane.doe@example.com about the incident",
    mustRedact: ["jane.doe@example.com"],
    mustKeep: ["ping the owner at", "about the incident"],
  },
  {
    id: "credit-card",
    about: "Luhn-valid payment card number (structured PII)",
    text: "Order #1024 paid with card 4111 1111 1111 1111 on file",
    mustRedact: ["4111 1111 1111 1111"],
    mustKeep: ["Order #1024", "on file"],
  },
  {
    id: "ssn",
    about: "US Social Security number (structured PII)",
    text: "employee SSN 123-45-6789 recorded in the HR sheet",
    mustRedact: ["123-45-6789"],
    mustKeep: ["employee", "recorded in the HR sheet"],
  },
  {
    id: "phone",
    about: "North-American phone number (structured PII)",
    text: "call the desk at 415-555-0132 before noon",
    mustRedact: ["415-555-0132"],
    mustKeep: ["call the desk at", "before noon"],
  },
  {
    id: "phone-e164",
    about: "International E.164 phone number (structured PII)",
    text: "reach the London office at +44 20 7946 0958 anytime",
    mustRedact: ["+44 20 7946 0958"],
    mustKeep: ["reach the London office at", "anytime"],
  },
  {
    id: "credit-card-invalid",
    about: "Card-shaped number that fails the Luhn check — NOT flagged (precision)",
    text: "internal ref 4111 1111 1111 1112 logged for the batch job",
    mustRedact: [],
    mustKeep: ["4111 1111 1111 1112", "logged for the batch job"],
  },
  {
    id: "ssn-invalid",
    about: "SSN-shaped number with an invalid area (666) — NOT flagged (precision)",
    text: "tracking code 666-12-3456 is just an internal id",
    mustRedact: [],
    mustKeep: ["666-12-3456", "is just an internal id"],
  },
  {
    id: "mixed-multi",
    about: "Several structured detectors in one string (recall + ordering)",
    text: "Email jane.doe@example.com or call 415-555-0132 for Ada Lovelace",
    mustRedact: ["jane.doe@example.com", "415-555-0132"],
    mustKeep: ["Email", "or call", "for", "Ada Lovelace"],
  },
  {
    id: "names-not-redacted",
    about: "Personal names, orgs, and places are NOT redacted (names layer dropped)",
    text: "Met with Ada Lovelace from Contoso in Seattle to review the plan",
    mustRedact: [],
    mustKeep: ["Ada Lovelace", "Contoso", "Seattle", "Met with", "to review the plan"],
  },
  {
    id: "clean-prose",
    about: "Ordinary prose — no findings (precision)",
    text: "Opened the quarterly planning doc and reviewed the roadmap for Q3.",
    mustRedact: [],
    mustKeep: ["Opened the quarterly planning doc and reviewed the roadmap for Q3."],
  },
  {
    id: "clean-url-and-hash",
    about: "URL, commit hash, and a bare number are not secrets (precision)",
    text: "Visited https://github.com/microsoft/skill-recorder at 9c1e6f2a4b7d8e0f1a2b3c4d5e6f7a8b9c0d1e2f build 1234567890",
    mustRedact: [],
    mustKeep: [
      "https://github.com/microsoft/skill-recorder",
      "9c1e6f2a4b7d8e0f1a2b3c4d5e6f7a8b9c0d1e2f",
      "build 1234567890",
    ],
  },
];
