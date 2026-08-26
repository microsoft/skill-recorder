// Realistic fixtures for the degraded-frame OCR eval. Each fixture is authored as
// an SVG that mimics a real app surface (a spreadsheet with tinted cells, a dark
// terminal, a billing form, a code editor) at a "native display" width, with small
// UI-sized fonts — NOT the clean, oversized black-on-white text the older
// ocr-images eval renders. The SVG is rendered then downscaled to a ~1108px capture
// (see degrade.ts) before OCR, so the eval stresses exactly what broke in
// production: small on-screen text going to OCR garbage.
//
// Ground truth is derived from the layout geometry itself (the rect we allocate for
// each value), so it can never drift from what's drawn — no hand-maintained label
// file. Every sensitive region carries an `entityType` for per-type recall, and may
// carry an `xfail` reason for a known, accepted OCR gap.

import type { GtRect } from "./degrade";

export type SharpModule = (typeof import("sharp"))["default"];

/** Entity taxonomy mirrored from common/sensitive.ts SensitiveCategory, used to
 *  break recall down per detail type. */
export type EntityType =
  | "ssn"
  | "credit-card"
  | "phone"
  | "email"
  | "api-key"
  | "jwt"
  | "private-key"
  | "password";

export interface FixtureRegion {
  /** The literal on-screen text (for reporting + as a `knownValue` seed if needed). */
  text: string;
  /** Ground-truth rectangle in the fixture's hi-res coordinate space. */
  rect: GtRect;
  /** True when this region MUST be covered by a blur box before the frame ships. */
  sensitive: boolean;
  /** Detail type — required for sensitive regions (drives per-type recall). */
  entityType?: EntityType;
  /** When set, this sensitive region is a KNOWN OCR gap: a miss is reported XFAIL
   *  (not a hard failure) and an unexpected catch is reported XPASS. */
  xfail?: string;
}

export interface RealisticFixture {
  id: string;
  about: string;
  hiResWidth: number;
  hiResHeight: number;
  svg: string;
  regions: FixtureRegion[];
  /** Values already known from the session's text channel (cross-feed blur). */
  knownValues?: string[];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const SANS = "Arial, 'Helvetica Neue', Helvetica, sans-serif";
const MONO = "'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace";

interface TextOpts {
  size: number;
  fill?: string;
  family?: string;
  weight?: number | "bold" | "normal";
}
interface RectOpts {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

/** Tiny imperative SVG builder that keeps drawn geometry and ground-truth regions
 *  in lock-step. Text is placed by its cell so a value's ground-truth rect is the
 *  cell we drew it in (robust to per-platform font-metric variance). */
class Canvas {
  private readonly parts: string[] = [];
  readonly regions: FixtureRegion[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    background: string,
  ) {
    this.parts.push(`<rect width="${width}" height="${height}" fill="${background}"/>`);
  }

  rect(x: number, y: number, w: number, h: number, opts: RectOpts = {}): void {
    const fill = opts.fill ?? "none";
    const stroke = opts.stroke ? ` stroke="${opts.stroke}" stroke-width="${opts.strokeWidth ?? 1}"` : "";
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${stroke}/>`);
  }

  /** Draw text with its LEFT edge at x and BASELINE at y. */
  text(x: number, y: number, s: string, opts: TextOpts): void {
    const family = opts.family ?? SANS;
    const weight = opts.weight ? ` font-weight="${opts.weight}"` : "";
    this.parts.push(
      `<text x="${x}" y="${y}" font-family="${family}" font-size="${opts.size}" fill="${opts.fill ?? "#111"}"${weight}>${escapeXml(s)}</text>`,
    );
  }

  /** Draw a value inside a cell [cx,cy,cw,ch] and record its ground-truth rect as
   *  that cell (optionally sensitive). Text is vertically centered on the cell. */
  cell(
    cx: number,
    cy: number,
    cw: number,
    ch: number,
    value: string,
    text: TextOpts,
    region?: Omit<FixtureRegion, "rect" | "text">,
  ): void {
    const padX = Math.round(ch * 0.22);
    const baseline = cy + Math.round(ch * 0.5 + text.size * 0.35);
    this.text(cx + padX, baseline, value, text);
    if (region) {
      this.regions.push({ text: value, rect: { x0: cx, y0: cy, x1: cx + cw, y1: cy + ch }, ...region });
    }
  }

  svg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">${this.parts.join("")}</svg>`;
  }
}

/* -------------------------------------------------------------------------- */
/* Fixture: payroll spreadsheet — SSNs + phones in a tinted grid.             */
/* -------------------------------------------------------------------------- */

function spreadsheetPayroll(): RealisticFixture {
  const W = 1920;
  const rowH = 58;
  const top = 150;
  const cols = [
    { key: "name", x: 40, w: 460, label: "Employee" },
    { key: "ssn", x: 520, w: 420, label: "SSN" },
    { key: "phone", x: 960, w: 520, label: "Phone" },
  ];
  const rows: Array<{ name: string; ssn: string; phone: string }> = [
    { name: "Ava Chen", ssn: "123-45-6789", phone: "(415) 555-0132" },
    { name: "Liam Ortiz", ssn: "234-56-7890", phone: "(212) 555-0147" },
    { name: "Noah Kim", ssn: "345-67-8901", phone: "(650) 555-0188" },
    { name: "Mia Patel", ssn: "456-78-9012", phone: "(312) 555-0164" },
    { name: "Emma Ruiz", ssn: "567-89-0123", phone: "(646) 555-0175" },
  ];
  const H = top + rows.length * rowH + 40;
  const c = new Canvas(W, H, "#ffffff");
  c.text(40, 70, "Q3 Payroll — Confidential", { size: 34, weight: "bold" });

  // Header row (tinted, like a real sheet).
  c.rect(40, top - rowH, 1440, rowH, { fill: "#e8eef5", stroke: "#c3ccd6" });
  for (const col of cols) {
    c.rect(col.x, top - rowH, col.w, rowH, { stroke: "#c3ccd6" });
    c.text(col.x + 14, top - rowH + Math.round(rowH * 0.62), col.label, { size: 24, fill: "#444", weight: "bold" });
  }

  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const band = i % 2 === 0 ? "#ffffff" : "#f5f8fb"; // alternating rows
    for (const col of cols) c.rect(col.x, y, col.w, rowH, { fill: band, stroke: "#dfe5ec" });
    c.cell(cols[0].x, y, cols[0].w, rowH, r.name, { size: 24 }); // clean name
    c.regions.push({ text: r.name, rect: { x0: cols[0].x, y0: y, x1: cols[0].x + cols[0].w, y1: y + rowH }, sensitive: false });
    c.cell(cols[1].x, y, cols[1].w, rowH, r.ssn, { size: 24 }, { sensitive: true, entityType: "ssn" });
    c.cell(cols[2].x, y, cols[2].w, rowH, r.phone, { size: 24 }, { sensitive: true, entityType: "phone" });
  });

  return { id: "spreadsheet-payroll", about: "Payroll grid: SSNs + phones in small tinted cells", hiResWidth: W, hiResHeight: H, svg: c.svg(), regions: c.regions };
}

/* -------------------------------------------------------------------------- */
/* Fixture: billing form — email + Visa + Amex (Amex is a known OCR gap).      */
/* -------------------------------------------------------------------------- */

function billingForm(): RealisticFixture {
  const W = 1680;
  const c = new Canvas(W, 620, "#f2f4f7");
  c.rect(120, 60, 1440, 500, { fill: "#ffffff", stroke: "#d7dce3" });
  c.text(160, 130, "Billing details", { size: 30, weight: "bold" });

  const fieldX = 160;
  const inputX = 520;
  const inputW = 900;
  const rows: Array<{ label: string; value: string; sensitive?: EntityType; tint?: string; xfail?: string }> = [
    { label: "Cardholder", value: "Jordan Blake" },
    { label: "Email", value: "jordan.blake@example.com", sensitive: "email" },
    { label: "Card (Visa)", value: "4111 1111 1111 1111", sensitive: "credit-card" },
    {
      label: "Card (Amex)",
      value: "3782 822463 10005",
      sensitive: "credit-card",
      tint: "#fdecea", // red-tinted highlighted cell — the documented hard case
      xfail: "Amex in a red-tinted cell: global-threshold OCR garbles the digits (known gap)",
    },
  ];
  const startY = 190;
  const rowH = 78;
  rows.forEach((r, i) => {
    const y = startY + i * rowH;
    c.text(fieldX, y + 44, r.label, { size: 24, fill: "#555" });
    c.rect(inputX, y + 12, inputW, 52, { fill: r.tint ?? "#fbfcfd", stroke: "#c9d0d8" });
    if (r.sensitive) {
      c.cell(inputX, y + 12, inputW, 52, r.value, { size: 24 }, { sensitive: true, entityType: r.sensitive, xfail: r.xfail });
    } else {
      c.cell(inputX, y + 12, inputW, 52, r.value, { size: 24 });
      c.regions.push({ text: r.value, rect: { x0: inputX, y0: y + 12, x1: inputX + inputW, y1: y + 64 }, sensitive: false });
    }
  });
  c.rect(inputX, startY + rows.length * rowH + 10, 200, 52, { fill: "#2d6cdf" });
  c.text(inputX + 46, startY + rows.length * rowH + 44, "Save", { size: 24, fill: "#ffffff", weight: "bold" });

  return { id: "billing-form", about: "Payment form: email + Visa + Amex (Amex tinted-cell = xfail)", hiResWidth: W, hiResHeight: 620, svg: c.svg(), regions: c.regions };
}

/* -------------------------------------------------------------------------- */
/* Fixture: terminal — GitHub token + AWS key amid ordinary logs.             */
/* -------------------------------------------------------------------------- */

function terminalSecrets(): RealisticFixture {
  const W = 1760;
  const lineH = 46;
  const top = 60;
  const lines: Array<{ pre: string; secret?: { value: string; entityType: EntityType } }> = [
    { pre: "$ ./deploy.sh --env production" },
    { pre: "[info] authenticating to registry" },
    { pre: "export GITHUB_TOKEN=", secret: { value: "ghp_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R", entityType: "api-key" } },
    { pre: "[info] uploading build artifacts" },
    { pre: "AWS_ACCESS_KEY_ID=", secret: { value: "AKIA5XYQ7WZ3PLMN8RTV", entityType: "api-key" } },
    { pre: "[info] deployment complete in 42s" },
  ];
  const H = top + lines.length * lineH + 30;
  const c = new Canvas(W, H, "#1e1e1e");
  lines.forEach((ln, i) => {
    const y = top + i * lineH;
    const baseline = y + 30;
    c.text(30, baseline, ln.pre, { size: 24, family: MONO, fill: "#d6d6d6" });
    if (ln.secret) {
      // Monospace: advance width ≈ 0.6em per char, so the secret starts right after
      // the prefix. Its ground-truth rect is that trailing span of the line.
      const startX = 30 + Math.round(ln.pre.length * 24 * 0.6);
      const secretW = Math.round(ln.secret.value.length * 24 * 0.6) + 20;
      c.text(startX, baseline, ln.secret.value, { size: 24, family: MONO, fill: "#d6d6d6" });
      // These high-entropy secrets are now caught reading-independently: OCR
      // garbles the exact glyphs (and may split the token across a space), but the
      // structural detector (frame-heuristics.ts) blurs them by shape — a long,
      // high-entropy, mixed character-class run (plus credential-assignment
      // context), with no vendor/prefix list. So they're expected-detect, not a gap.
      c.regions.push({ text: ln.secret.value, rect: { x0: startX - 6, y0: y + 4, x1: startX + secretW, y1: y + lineH }, sensitive: true, entityType: ln.secret.entityType });
    } else {
      c.regions.push({ text: ln.pre, rect: { x0: 24, y0: y + 4, x1: 30 + Math.round(ln.pre.length * 24 * 0.6), y1: y + lineH }, sensitive: false });
    }
  });
  return { id: "terminal-secrets", about: "Dark terminal: GitHub token + AWS key amid logs", hiResWidth: W, hiResHeight: H, svg: c.svg(), regions: c.regions };
}

/* -------------------------------------------------------------------------- */
/* Fixture: code editor — Stripe key + JWT in a config file.                   */
/* -------------------------------------------------------------------------- */

function codeConfig(): RealisticFixture {
  const W = 1760;
  const lineH = 46;
  const top = 60;
  const gutter = 90;
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJKb2UifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const lines: Array<{ text: string; secret?: { value: string; entityType: EntityType } }> = [
    { text: "# config/production.yaml" },
    { text: "service: recorder-api" },
    { text: "stripe_secret_key: ", secret: { value: "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dcABCDEFGH1234", entityType: "api-key" } },
    { text: "retries: 3" },
    { text: "session_jwt: ", secret: { value: jwt, entityType: "jwt" } },
    { text: "log_level: info" },
  ];
  const H = top + lines.length * lineH + 30;
  const c = new Canvas(W, H, "#1e1e2e");
  c.rect(0, 0, gutter, H, { fill: "#181825" });
  lines.forEach((ln, i) => {
    const y = top + i * lineH;
    const baseline = y + 30;
    c.text(24, baseline, String(i + 1), { size: 22, family: MONO, fill: "#6c7086" });
    const keyColor = ln.text.startsWith("#") ? "#7f849c" : "#a6adc8";
    c.text(gutter + 20, baseline, ln.text, { size: 24, family: MONO, fill: keyColor });
    if (ln.secret) {
      const startX = gutter + 20 + Math.round(ln.text.length * 24 * 0.6);
      const secretW = Math.round(ln.secret.value.length * 24 * 0.6) + 20;
      c.text(startX, baseline, ln.secret.value, { size: 24, family: MONO, fill: "#a6e3a1" });
      // Caught reading-independently by the structural detector (see the terminal
      // fixture): a Stripe key / JWT is high-entropy, so even when OCR misreads a
      // glyph or injects a space it's blurred by shape (length + character-class
      // entropy + credential-assignment context, no prefix list). Expected-detect.
      c.regions.push({ text: ln.secret.value, rect: { x0: startX - 6, y0: y + 4, x1: startX + secretW, y1: y + lineH }, sensitive: true, entityType: ln.secret.entityType });
    } else {
      c.regions.push({ text: ln.text, rect: { x0: gutter + 14, y0: y + 4, x1: gutter + 20 + Math.round(ln.text.length * 24 * 0.6), y1: y + lineH }, sensitive: false });
    }
  });
  return { id: "code-config", about: "Code editor: Stripe key + JWT in a YAML config", hiResWidth: W, hiResHeight: H, svg: c.svg(), regions: c.regions };
}

export const realisticFixtures: RealisticFixture[] = [
  spreadsheetPayroll(),
  billingForm(),
  terminalSecrets(),
  codeConfig(),
];
