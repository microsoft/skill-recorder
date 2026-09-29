import { buildTargetFor, type BuildTarget, type SkillArchitecture } from "../common/architecture-registry";
import type { SkillPlacement } from "../common/ipc";
import { message, type Translator, type UiLocale } from "../common/locales";

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

export function skillPlacementModel(target: BuildTarget, t?: Translator, locale: UiLocale = "en"): SkillPlacementModel {
  if (target.placements.length === 0) {
    throw new Error(`Skill target "${target.label}" must declare at least one placement.`);
  }

  const defaultPlacement = target.placements[0];
  const placements = [...target.placements.slice(1), defaultPlacement];
  const tt: Translator = t ?? ((key, params) => message(locale, key, params));
  const actions = placements.map((placement) => {
    const primary = placement === defaultPlacement;
    const label =
      placement === "install"
        ? tt("addToTarget", { target: target.installTargetLabel })
        : primary
          ? tt("exportSkillAction")
          : tt("exportEllipsis");
    const title =
      placement === "install"
        ? tt("addSkillToTargetHelp", { target: target.installTargetLabel })
        : tt("downloadSkillToFolderHelp");
    return { placement, primary, label, title };
  });

  return {
    defaultPlacement,
    actions,
    installDoneTitle: tt("addedToTarget", { target: target.installTargetLabel }),
    installDoneMessage: tt("loadsAutomatically", { target: target.installTargetLabel }),
  };
}
