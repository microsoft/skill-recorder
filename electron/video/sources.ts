import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { app, desktopCapturer, screen } from "electron";

import type {
  ScreenSettingsResult,
  ScreenSettingsStatus,
  StartOptions,
} from "../../common/ipc";
import {
  applyDisplayLabels,
  resolveScreenPreference,
  screenPreference,
  type ScreenPreference,
  type ScreenSource,
} from "../../common/screen";
import { createLogger } from "../logger";

const log = createLogger("Screen sources");
const PREFERENCES_FILE = "screen-preferences.json";

interface StoredPreferences {
  screen: ScreenPreference | null;
}

export class ScreenSourceService {
  private preferencesLoaded = false;
  private preferencesFile = "";
  private preferenceWrites: Promise<void> = Promise.resolve();
  private operation: Promise<void> = Promise.resolve();
  private preference: ScreenPreference | null = null;
  private sources: ScreenSource[] = [];
  private settingsError: string | null = null;

  constructor(
    private readonly onSettingsChanged: (
      status: ScreenSettingsStatus,
    ) => void = () => undefined,
  ) {}

  initialize(): Promise<void> {
    return this.run(async () => {
      await this.loadPreferences();
      await this.refreshSources();
    });
  }

  refresh(): Promise<ScreenSettingsStatus> {
    return this.run(async () => {
      await this.loadPreferences();
      await this.refreshSources();
      return this.settings();
    });
  }

  selectSource(sourceId: string): Promise<ScreenSettingsResult> {
    return this.run(async () => {
      await this.loadPreferences();
      await this.refreshSources(false);
      const source = this.sources.find((candidate) => candidate.id === sourceId);
      if (!source) {
        const error = "That screen is no longer available.";
        this.settingsError = error;
        this.emitSettings();
        return { ok: false, status: this.settings(), error };
      }

      const previous = this.preference;
      this.preference = screenPreference(source);
      this.settingsError = null;
      try {
        await this.persistPreferences();
      } catch (error) {
        this.preference = previous;
        return this.settingsFailure(error, "Could not save the screen selection");
      }
      this.emitSettings();
      return { ok: true, status: this.settings() };
    });
  }

  startOptions(): Promise<StartOptions> {
    return this.run(async () => {
      await this.loadPreferences();
      await this.refreshSources();
      const source = resolveScreenPreference(this.preference, this.sources).source;
      return source
        ? {
            screenSourceId: source.id,
            screenDisplayId: source.displayId || undefined,
          }
        : {};
    });
  }

  settings(): ScreenSettingsStatus {
    const resolved = resolveScreenPreference(this.preference, this.sources);
    const preferredLabel =
      this.preference?.label || resolved.source?.label || "Selected screen";
    return {
      screens: this.sources.map((source) => ({ ...source })),
      preferredSourceId: this.preference?.id ?? resolved.source?.id ?? "",
      preferredSourceLabel: preferredLabel,
      selectedSourceId: resolved.source?.id ?? "",
      selectedSourceLabel: resolved.source?.label ?? "No screen available",
      preferredSourceUnavailable: this.preference != null && resolved.unavailable,
      fallback:
        this.preference && resolved.unavailable && resolved.source
          ? `${preferredLabel} is unavailable. ${resolved.source.label} will be recorded.`
          : null,
      error: this.settingsError,
    };
  }

  whenSettingsSettled(): Promise<void> {
    return this.operation;
  }

  private async refreshSources(emit = true): Promise<void> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      });
      const displayLabels = new Map(
        screen.getAllDisplays().map((display) => [
          String(display.id),
          display.label,
        ]),
      );
      this.sources = applyDisplayLabels(sources.map((source) => ({
        id: source.id,
        label: source.name,
        displayId: source.display_id,
      })), displayLabels);
      this.settingsError =
        this.sources.length === 0 ? "No screens are available to record." : null;

      const resolved = resolveScreenPreference(this.preference, this.sources);
      if (resolved.changed) {
        this.preference = resolved.preference;
        try {
          await this.persistPreferences();
        } catch (error) {
          this.settingsError =
            `Could not save the restored screen selection: ${errorMessage(error)}`;
        }
      }
    } catch (error) {
      this.sources = [];
      this.settingsError = `Could not list screens: ${errorMessage(error)}`;
      log.warn(this.settingsError);
    }
    if (emit) this.emitSettings();
  }

  private async loadPreferences(): Promise<void> {
    if (this.preferencesLoaded) return;
    this.preferencesLoaded = true;
    this.preferencesFile = path.join(app.getPath("userData"), PREFERENCES_FILE);
    try {
      const raw = JSON.parse(await readFile(this.preferencesFile, "utf8")) as unknown;
      this.preference = readPreferences(raw).screen;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      this.settingsError =
        `Saved screen preferences could not be read: ${errorMessage(error)}`;
      log.warn(this.settingsError);
    }
  }

  private persistPreferences(): Promise<void> {
    if (!this.preferencesFile) {
      this.preferencesFile = path.join(app.getPath("userData"), PREFERENCES_FILE);
    }
    const file = this.preferencesFile;
    const contents = JSON.stringify({ screen: this.preference }, null, 2);
    const write = this.preferenceWrites.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
      try {
        await writeFile(temp, contents);
        await rename(temp, file);
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.preferenceWrites = write.catch(() => undefined);
    return write;
  }

  private settingsFailure(
    error: unknown,
    prefix: string,
  ): ScreenSettingsResult {
    const message = `${prefix}: ${errorMessage(error)}`;
    this.settingsError = message;
    this.emitSettings();
    return { ok: false, status: this.settings(), error: message };
  }

  private emitSettings(): void {
    this.onSettingsChanged(this.settings());
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operation.then(task, task);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function readPreferences(value: unknown): StoredPreferences {
  if (!value || typeof value !== "object") {
    throw new Error("Expected an object.");
  }
  const rawScreen =
    "screen" in value && value.screen && typeof value.screen === "object"
      ? value.screen
      : null;
  if (!rawScreen) return { screen: null };

  const id =
    "id" in rawScreen && typeof rawScreen.id === "string"
      ? rawScreen.id
      : "";
  if (!id) throw new Error("The saved screen id is invalid.");
  return {
    screen: {
      id,
      label:
        "label" in rawScreen && typeof rawScreen.label === "string"
          ? rawScreen.label
          : "",
      displayId:
        "displayId" in rawScreen && typeof rawScreen.displayId === "string"
          ? rawScreen.displayId
          : "",
    },
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
