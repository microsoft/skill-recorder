import { z } from "zod";

export const BUILD_KINDS = ["skill", "automation"] as const;
export const BuildKind = z.enum(BUILD_KINDS);
export type BuildKind = z.infer<typeof BuildKind>;

export interface ArchitectureTargetDefinition {
  kind: BuildKind;
  label: string;
  enabled: boolean;
  note: string;
}

export interface ArchitectureDefinition<Id extends string = string> {
  id: Id;
  label: string;
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
    }
  }

  return definitions;
}

export const ARCHITECTURE_MANIFEST = defineArchitectures([
  {
    id: "scout",
    label: "Scout",
    note: "Microsoft Scout: native WorkIQ, browser, files, and built-in skills.",
    targets: [
      {
        kind: "skill",
        label: "Scout skill",
        enabled: true,
        note: "An on-demand skill Scout runs when its description matches the task.",
      },
      {
        kind: "automation",
        label: "Scout automation",
        enabled: true,
        note: "A scheduled, multi-step automation Scout runs on a trigger.",
      },
    ],
  },
  {
    id: "cowork",
    label: "Cowork",
    note:
      "Microsoft 365 Copilot (Cowork): native Teams, Outlook, Calendar, " +
      "SharePoint, files, and built-in skills.",
    targets: [
      {
        kind: "skill",
        label: "Cowork skill",
        enabled: true,
        note: "An on-demand skill for Microsoft 365 Copilot (Cowork) you export and install.",
      },
    ],
  },
  {
    id: "copilot-studio",
    label: "Copilot Studio",
    note: "Coming soon.",
    targets: [
      {
        kind: "skill",
        label: "Copilot Studio",
        enabled: false,
        note: "Coming soon.",
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
  ({ id, targets }) =>
    targets.map((target) => ({
      kind: target.kind,
      architecture: id,
      label: target.label,
      enabled: target.enabled,
      note: target.note,
    })),
);

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
