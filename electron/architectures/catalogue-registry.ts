/// <reference types="vite/client" />

import {
  createCatalogueRegistry,
  providersFromModules,
} from "./catalogue-provider";

const providerModules = import.meta.glob("./catalogues/*-catalogue.ts", {
  eager: true,
});

const registry = createCatalogueRegistry(
  providersFromModules(providerModules),
);

export const catalogueFor = registry.catalogueFor;
export const requireCatalogue = registry.requireCatalogue;
