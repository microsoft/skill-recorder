import { z } from "zod";

import {
  ARCHITECTURE_MANIFEST,
  BUILD_KINDS,
  SkillArchitecture,
  defineArchitectures,
  enabledArchitectureLabels,
  type ArchitectureDefinition,
  type BuildKind,
} from "../../common/architecture-registry";

const NonEmptyCatalogueString = z.string().refine(
  (value) => value.trim().length > 0,
  "must not be empty",
);

export const CataloguePayloadSchema = z
  .object({
    version: NonEmptyCatalogueString,
    content: NonEmptyCatalogueString,
  })
  .strict();
export type CataloguePayload = z.infer<typeof CataloguePayloadSchema>;

export const ArchitectureCatalogueProviderSchema = z
  .object({
    architecture: SkillArchitecture,
    skill: CataloguePayloadSchema.optional(),
    automation: CataloguePayloadSchema.optional(),
  })
  .strict()
  .refine((provider) => provider.skill || provider.automation, {
    message: "must provide at least one catalogue payload",
  });
export type ArchitectureCatalogueProvider = z.infer<
  typeof ArchitectureCatalogueProviderSchema
>;

const CatalogueModuleSchema = z.object({
  default: ArchitectureCatalogueProviderSchema,
});

export function defineCatalogueProvider<
  const T extends ArchitectureCatalogueProvider,
>(provider: T): T {
  ArchitectureCatalogueProviderSchema.parse(provider);
  return provider;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
    .join("; ");
}

export function providersFromModules(
  modules: Readonly<Record<string, unknown>>,
): ArchitectureCatalogueProvider[] {
  return Object.entries(modules).map(([path, module]) => {
    const parsed = CatalogueModuleSchema.safeParse(module);
    if (!parsed.success) {
      throw new Error(
        `Invalid catalogue provider module "${path}": ${formatIssues(parsed.error)}`,
      );
    }
    return parsed.data.default;
  });
}

export interface CatalogueRegistry {
  catalogueFor(
    architecture: SkillArchitecture,
    kind: BuildKind,
  ): CataloguePayload | null;
  requireCatalogue(
    architecture: SkillArchitecture,
    kind: BuildKind,
  ): CataloguePayload;
}

function formatChoices(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

export function createCatalogueRegistry(
  providerInputs: readonly unknown[],
  manifest: readonly ArchitectureDefinition<SkillArchitecture>[] =
    ARCHITECTURE_MANIFEST,
): CatalogueRegistry {
  defineArchitectures(manifest);

  const definitions = new Map(
    manifest.map((definition) => [definition.id, definition]),
  );
  const providers = new Map<
    SkillArchitecture,
    ArchitectureCatalogueProvider
  >();

  for (const [index, input] of providerInputs.entries()) {
    const parsed = ArchitectureCatalogueProviderSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(
        `Invalid catalogue provider at index ${index}: ${formatIssues(parsed.error)}`,
      );
    }

    const provider = parsed.data;
    const definition = definitions.get(provider.architecture);
    if (!definition) {
      throw new Error(
        `Unknown architecture "${provider.architecture}" in catalogue provider.`,
      );
    }
    if (providers.has(provider.architecture)) {
      throw new Error(
        `Duplicate catalogue provider for architecture "${provider.architecture}".`,
      );
    }

    for (const kind of BUILD_KINDS) {
      if (
        provider[kind] &&
        !definition.targets.some((target) => target.kind === kind)
      ) {
        throw new Error(
          `Architecture "${provider.architecture}" does not declare target kind "${kind}".`,
        );
      }
    }

    providers.set(provider.architecture, provider);
  }

  for (const definition of manifest) {
    const provider = providers.get(definition.id);
    for (const target of definition.targets) {
      if (target.enabled && !provider?.[target.kind]) {
        throw new Error(
          `Enabled target "${target.label}" (${definition.id}:${target.kind}) ` +
            "is missing a catalogue payload.",
        );
      }
    }
  }

  const catalogueFor = (
    architecture: SkillArchitecture,
    kind: BuildKind,
  ): CataloguePayload | null => {
    const target = definitions
      .get(architecture)
      ?.targets.find((candidate) => candidate.kind === kind);
    if (!target?.enabled) return null;
    return providers.get(architecture)?.[kind] ?? null;
  };

  const requireCatalogue = (
    architecture: SkillArchitecture,
    kind: BuildKind,
  ): CataloguePayload => {
    const catalogue = catalogueFor(architecture, kind);
    if (catalogue) return catalogue;

    const labels = enabledArchitectureLabels(kind, manifest);
    const choices = labels.length ? ` Choose ${formatChoices(labels)}.` : "";
    throw new Error(`That target architecture isn't available yet.${choices}`);
  };

  return { catalogueFor, requireCatalogue };
}
