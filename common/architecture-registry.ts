import { z } from "zod";

export const BUILD_KINDS = ["skill", "automation"] as const;
export const BuildKind = z.enum(BUILD_KINDS);
export type BuildKind = z.infer<typeof BuildKind>;

export const TARGET_PLACEMENTS = ["install", "export"] as const;
export type TargetPlacement = (typeof TARGET_PLACEMENTS)[number];

export interface ArchitectureTargetDefinition {
  kind: BuildKind;
  label: string;
  enabled: boolean;
  note: string;
  /** Ordered delivery capabilities; the first entry is the primary/default placement. */
  placements: readonly TargetPlacement[];
}

export interface ArchitectureDefinition<Id extends string = string> {
  id: Id;
  label: string;
  installTargetLabel: string;
  note: string;
  targets: readonly ArchitectureTargetDefinition[];
}

export function defineArchitectures<
  const T extends readonly ArchitectureDefinition[],
>(definitions: T): T {
  if (definitions.length === 0) {
    throw new Error("Architecture manifest must contain at least one architecture.");
  }

  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new Error(`Duplicate architecture id "${definition.id}".`);
    }
    ids.add(definition.id);

    if (!definition.installTargetLabel.trim()) {
      throw new Error(
        `Architecture "${definition.id}" must declare an install target label.`,
      );
    }

    if (definition.targets.length === 0) {
      throw new Error(`Architecture "${definition.id}" must declare at least one target.`);
    }

    const kinds = new Set<BuildKind>();
    for (const target of definition.targets) {
      if (kinds.has(target.kind)) {
        throw new Error(
          `Architecture "${definition.id}" declares "${target.kind}" more than once.`,
        );
      }
      kinds.add(target.kind);

      if (target.placements.length === 0) {
        throw new Error(
          `Architecture "${definition.id}" target "${target.kind}" must declare at least one placement.`,
        );
      }

      const placements = new Set<TargetPlacement>();
      for (const placement of target.placements) {
        if (placements.has(placement)) {
          throw new Error(
            `Architecture "${definition.id}" target "${target.kind}" declares placement "${placement}" more than once.`,
          );
        }
        placements.add(placement);
      }
    }
  }

  return definitions;
}

export const ARCHITECTURE_MANIFEST = defineArchitectures([
  {
    id: "scout",
    label: "Scout",
    installTargetLabel: "Scout",
    note: "Microsoft Scout: native WorkIQ, browser, files, and built-in skills.",
    targets: [
      {
        kind: "skill",
        label: "Scout skill",
        enabled: true,
        note: "An on-demand skill Scout runs when its description matches the task.",
        placements: ["install", "export"],
      },
      {
        kind: "automation",
        label: "Scout automation",
        enabled: true,
        note: "A scheduled, multi-step automation Scout runs on a trigger.",
        placements: ["install"],
      },
    ],
  },
  {
    id: "cowork",
    label: "Cowork",
    installTargetLabel: "Microsoft 365 Copilot",
    note:
      "Microsoft 365 Copilot (Cowork): native Teams, Outlook, Calendar, " +
      "SharePoint, files, and built-in skills.",
    targets: [
      {
        kind: "skill",
        label: "Cowork skill",
        enabled: true,
        note: "An on-demand skill for Microsoft 365 Copilot (Cowork) you export and install.",
        placements: ["export"],
      },
    ],
  },
  {
    id: "copilot-studio",
    label: "Copilot Studio",
    installTargetLabel: "Copilot Studio",
    note: "Coming soon.",
    targets: [
      {
        kind: "skill",
        label: "Copilot Studio",
        enabled: false,
        note: "Coming soon.",
        placements: ["export"],
      },
    ],
  },
] as const);

export type SkillArchitecture = (typeof ARCHITECTURE_MANIFEST)[number]["id"];

// The manifest validator guarantees a non-empty list; map preserves the ID union.
const architectureIds = ARCHITECTURE_MANIFEST.map(({ id }) => id) as [
  SkillArchitecture,
  ...SkillArchitecture[],
];

export const SkillArchitecture = z.enum(architectureIds);

export interface ArchitectureOption {
  id: SkillArchitecture;
  label: string;
  enabled: boolean;
  note: string;
}

export interface BuildTarget {
  kind: BuildKind;
  architecture: SkillArchitecture;
  label: string;
  enabled: boolean;
  note: string;
  placements: readonly TargetPlacement[];
  installTargetLabel: string;
}

export const ARCHITECTURES: readonly ArchitectureOption[] = ARCHITECTURE_MANIFEST.map(
  ({ id, label, note, targets }) => ({
    id,
    label,
    enabled: targets.some((target) => target.enabled),
    note,
  }),
);

/**
 * Build targets shown up front, in order. Automation support is architecture-specific,
 * so the target kind and architecture are chosen together before planning begins.
 */
export const TARGETS: readonly BuildTarget[] = ARCHITECTURE_MANIFEST.flatMap(
  ({ id, installTargetLabel, targets }) =>
    targets.map((target) => ({
      kind: target.kind,
      architecture: id,
      label: target.label,
      enabled: target.enabled,
      note: target.note,
      placements: target.placements,
      installTargetLabel,
    })),
);

export function buildTargetFor(
  architecture: SkillArchitecture,
  kind: BuildKind,
): BuildTarget {
  const target = TARGETS.find(
    (candidate) => candidate.architecture === architecture && candidate.kind === kind,
  );
  if (!target) {
    throw new Error(
      `No "${kind}" target is configured for architecture "${architecture}".`,
    );
  }
  return target;
}

export function requireTargetPlacement(
  architecture: SkillArchitecture,
  kind: BuildKind,
  placement: TargetPlacement,
): BuildTarget {
  const target = buildTargetFor(architecture, kind);
  if (!target.enabled) {
    throw new Error(`Architecture "${architecture}" target "${kind}" is not enabled.`);
  }
  if (!target.placements.includes(placement)) {
    throw new Error(
      `Architecture "${architecture}" target "${kind}" does not support "${placement}" placement.`,
    );
  }
  return target;
}

const defaultTarget = TARGETS.find((target) => target.enabled);
if (!defaultTarget) {
  throw new Error("Architecture manifest must contain at least one enabled target.");
}
export const DEFAULT_TARGET: BuildTarget = defaultTarget;

export function enabledArchitectureLabels(
  kind: BuildKind,
  definitions: readonly ArchitectureDefinition<SkillArchitecture>[] =
    ARCHITECTURE_MANIFEST,
): string[] {
  return definitions
    .filter((definition) =>
      definition.targets.some((target) => target.kind === kind && target.enabled),
    )
    .map((definition) => definition.label);
}
