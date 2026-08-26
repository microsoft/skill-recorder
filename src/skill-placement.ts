import {
  buildTargetFor,
  type BuildTarget,
  type SkillArchitecture,
} from "../common/architecture-registry";
import type { SkillPlacement } from "../common/ipc";

export interface SkillPlacementAction {
  placement: SkillPlacement;
  primary: boolean;
  label: string;
  title: string;
}

export interface SkillPlacementModel {
  defaultPlacement: SkillPlacement;
  actions: readonly SkillPlacementAction[];
  installDoneTitle: string;
  installDoneMessage: string;
}

export function skillTargetFor(architecture: SkillArchitecture): BuildTarget {
  return buildTargetFor(architecture, "skill");
}

export function skillPlacementModel(target: BuildTarget): SkillPlacementModel {
  if (target.placements.length === 0) {
    throw new Error(`Skill target "${target.label}" must declare at least one placement.`);
  }

  const defaultPlacement = target.placements[0];
  const placements = [...target.placements.slice(1), defaultPlacement];
  const actions = placements.map((placement) => {
    const primary = placement === defaultPlacement;
    const label =
      placement === "install"
        ? `Add to ${target.installTargetLabel}`
        : primary
          ? "Export skill"
          : "Export…";
    const title =
      placement === "install"
        ? `Add the skill to ${target.installTargetLabel} so it loads automatically`
        : "Download the skill to a folder you choose";
    return { placement, primary, label, title };
  });

  return {
    defaultPlacement,
    actions,
    installDoneTitle: `Added to ${target.installTargetLabel}`,
    installDoneMessage: `is now in ${target.installTargetLabel} — it loads automatically.`,
  };
}
