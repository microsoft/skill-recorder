import { readdir } from "node:fs/promises";

import {
  createCatalogueRegistry,
  providersFromModules,
} from "../../electron/architectures/catalogue-provider";

const cataloguesDirectory = new URL(
  "../../electron/architectures/catalogues/",
  import.meta.url,
);
const catalogueFiles = (
  await readdir(cataloguesDirectory, { withFileTypes: true })
)
  .filter((entry) => entry.isFile() && entry.name.endsWith("-catalogue.ts"))
  .sort((left, right) => left.name.localeCompare(right.name));

const providerModules = Object.fromEntries(
  await Promise.all(
    catalogueFiles.map(
      async (entry) =>
        [
          `./catalogues/${entry.name}`,
          await import(new URL(entry.name, cataloguesDirectory).href),
        ] as const,
    ),
  ),
);
const registry = createCatalogueRegistry(providersFromModules(providerModules));

export const catalogueFor = registry.catalogueFor;
export const requireCatalogue = registry.requireCatalogue;
