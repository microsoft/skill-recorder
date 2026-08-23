export interface ScreenSource {
  id: string;
  label: string;
  displayId: string;
}

export interface ScreenPreference {
  id: string;
  label: string;
  displayId: string;
}

export interface ResolvedScreenPreference {
  source: ScreenSource | null;
  preference: ScreenPreference | null;
  unavailable: boolean;
  changed: boolean;
}

/** Replace generic capture names with platform-provided monitor model labels. */
export function applyDisplayLabels(
  sources: readonly ScreenSource[],
  displayLabels: ReadonlyMap<string, string>,
): ScreenSource[] {
  const baseLabels = sources.map((source, index) => {
    const displayLabel = displayLabels.get(source.displayId)?.trim();
    return displayLabel || source.label.trim() || `Screen ${index + 1}`;
  });
  const counts = new Map<string, number>();
  for (const label of baseLabels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const occurrences = new Map<string, number>();
  return sources.map((source, index) => {
    const base = baseLabels[index];
    if ((counts.get(base) ?? 0) === 1) return { ...source, label: base };
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { ...source, label: `${base} (${occurrence})` };
  });
}

/**
 * Resolve a persisted preference against Electron's current screen sources.
 * Source ids may change between launches, while display ids generally remain
 * stable for the same connected monitor.
 */
export function resolveScreenPreference(
  preference: ScreenPreference | null,
  sources: readonly ScreenSource[],
): ResolvedScreenPreference {
  if (sources.length === 0) {
    return {
      source: null,
      preference,
      unavailable: true,
      changed: false,
    };
  }

  if (!preference) {
    const source = sources[0];
    return {
      source,
      preference: screenPreference(source),
      unavailable: false,
      changed: true,
    };
  }

  const displayMatch = preference.displayId
    ? uniqueMatch(sources.filter((source) => source.displayId === preference.displayId))
    : null;
  // Electron source ids are sequential and can be reassigned after a topology
  // change. Only trust an id by itself for legacy/platform sources without a
  // stable display id.
  const exact =
    displayMatch ??
    (!preference.displayId
      ? sources.find((source) => source.id === preference.id) ?? null
      : null);
  const labelMatch =
    exact ??
    (!preference.displayId && preference.label
      ? uniqueMatch(sources.filter((source) => source.label === preference.label))
      : null);

  if (labelMatch) {
    return {
      source: labelMatch,
      preference: screenPreference(labelMatch),
      unavailable: false,
      changed: !samePreference(preference, labelMatch),
    };
  }

  return {
    source: sources[0],
    preference,
    unavailable: true,
    changed: false,
  };
}

export function screenPreference(source: ScreenSource): ScreenPreference {
  return {
    id: source.id,
    label: source.label,
    displayId: source.displayId,
  };
}

function uniqueMatch(sources: readonly ScreenSource[]): ScreenSource | null {
  return sources.length === 1 ? sources[0] : null;
}

function samePreference(
  preference: ScreenPreference,
  source: ScreenSource,
): boolean {
  return (
    preference.id === source.id &&
    preference.label === source.label &&
    preference.displayId === source.displayId
  );
}
