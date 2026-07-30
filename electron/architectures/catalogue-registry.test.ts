import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ARCHITECTURE_MANIFEST,
  defineArchitectures,
} from "../../common/architecture-registry";
import {
  createCatalogueRegistry,
  defineCatalogueProvider,
  providersFromModules,
} from "./catalogue-provider";
import coworkCatalogueProvider from "./catalogues/cowork-catalogue";
import scoutCatalogueProvider from "./catalogues/scout-catalogue";

const scoutProvider = defineCatalogueProvider({
  architecture: "scout",
  skill: { version: "scout-skill-v1", content: "Scout skill catalogue" },
  automation: {
    version: "scout-automation-v1",
    content: "Scout automation catalogue",
  },
});

const coworkProvider = defineCatalogueProvider({
  architecture: "cowork",
  skill: { version: "cowork-skill-v1", content: "Cowork skill catalogue" },
});

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function providersWithScoutSkill(skill: unknown): readonly unknown[] {
  return [
    {
      architecture: "scout",
      skill,
      automation: scoutProvider.automation,
    },
    coworkProvider,
  ];
}

test("the registry resolves enabled catalogues and derives unavailable errors", () => {
  const registry = createCatalogueRegistry([scoutProvider, coworkProvider]);

  assert.deepEqual(registry.catalogueFor("scout", "skill"), scoutProvider.skill);
  assert.deepEqual(
    registry.catalogueFor("scout", "automation"),
    scoutProvider.automation,
  );
  assert.deepEqual(registry.catalogueFor("cowork", "skill"), coworkProvider.skill);
  assert.equal(registry.catalogueFor("cowork", "automation"), null);
  assert.throws(
    () => registry.requireCatalogue("cowork", "automation"),
    /That target architecture isn't available yet\. Choose Scout\./,
  );
});

test("disabled targets stay unavailable even when catalogue content is staged", () => {
  const stagedCopilotStudioProvider = defineCatalogueProvider({
    architecture: "copilot-studio",
    skill: {
      version: "copilot-studio-v1",
      content: "Copilot Studio skill catalogue",
    },
  });
  const registry = createCatalogueRegistry([
    scoutProvider,
    coworkProvider,
    stagedCopilotStudioProvider,
  ]);

  assert.equal(registry.catalogueFor("copilot-studio", "skill"), null);
  assert.throws(
    () => registry.requireCatalogue("copilot-studio", "skill"),
    /That target architecture isn't available yet\. Choose Scout or Cowork\./,
  );
});

test("the registry rejects missing, duplicate, unknown, and undeclared providers", () => {
  assert.throws(
    () => createCatalogueRegistry([scoutProvider]),
    /Enabled target "Cowork skill" \(cowork:skill\) is missing a catalogue payload/,
  );
  assert.throws(
    () => createCatalogueRegistry([scoutProvider, scoutProvider, coworkProvider]),
    /Duplicate catalogue provider for architecture "scout"/,
  );

  const scoutOnlyManifest = defineArchitectures([ARCHITECTURE_MANIFEST[0]]);
  assert.throws(
    () => createCatalogueRegistry([coworkProvider], scoutOnlyManifest),
    /Unknown architecture "cowork" in catalogue provider/,
  );

  assert.throws(
    () =>
      createCatalogueRegistry([
        scoutProvider,
        {
          ...coworkProvider,
          automation: {
            version: "cowork-automation-v1",
            content: "Cowork automation catalogue",
          },
        },
      ]),
    /Architecture "cowork" does not declare target kind "automation"/,
  );
});

test("provider payloads and discovered module shapes are validated strictly", () => {
  for (const [skill, error] of [
    [
      { version: "", content: "Scout skill catalogue" },
      /skill\.version: must not be empty/,
    ],
    [
      { version: "scout-skill-v1", content: "   " },
      /skill\.content: must not be empty/,
    ],
  ] as const) {
    assert.throws(
      () => createCatalogueRegistry(providersWithScoutSkill(skill)),
      error,
    );
  }

  assert.throws(
    () => createCatalogueRegistry([{ architecture: "copilot-studio" }]),
    /must provide at least one catalogue payload/,
  );
  assert.throws(
    () =>
      createCatalogueRegistry([
        scoutProvider,
        {
          architecture: "cowork",
          skills: coworkProvider.skill,
        },
      ]),
    /Unrecognized key: "skills"/,
  );
  assert.throws(
    () => providersFromModules({ "./missing-default.catalogue.ts": {} }),
    /Invalid catalogue provider module ".\/missing-default\.catalogue\.ts"/,
  );
  assert.throws(
    () =>
      providersFromModules({
        "./unknown.catalogue.ts": {
          default: {
            architecture: "generic",
            skill: { version: "generic-v1", content: "Generic catalogue" },
          },
        },
      }),
    /Invalid catalogue provider module ".\/unknown\.catalogue\.ts"/,
  );
});

test("real providers preserve versions, content, and the support matrix", () => {
  const registry = createCatalogueRegistry([
    scoutCatalogueProvider,
    coworkCatalogueProvider,
  ]);

  // These hashes prove catalogue moves are byte-for-byte. Intentional catalogue
  // changes must bump the corresponding version and update its hash here.
  const scoutSkill = registry.requireCatalogue("scout", "skill");
  assert.equal(scoutSkill.version, "2026-07-26");
  assert.equal(
    sha256(scoutSkill.content),
    "2621869fe246edf1244a528824853ab5bc455811442d26c24485e48e1c2e30a7",
  );
  const scoutAutomation = registry.requireCatalogue("scout", "automation");
  assert.equal(scoutAutomation.version, "2026-07-26");
  assert.equal(
    sha256(scoutAutomation.content),
    "0fbad5a4324b270bcec5a1c8eb21c4584991093beb5802e9af99caefeb4bd475",
  );

  const coworkSkill = registry.requireCatalogue("cowork", "skill");
  assert.equal(coworkSkill.version, "2026-07-28");
  assert.equal(
    sha256(coworkSkill.content),
    "39ffbdf3225ce47eecd735252558cffe860eb6a207782a2f604a8a57fb9a0f68",
  );
});
