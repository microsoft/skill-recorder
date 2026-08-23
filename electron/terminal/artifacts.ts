import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";

import {
  TERMINAL_ARTIFACTS,
  type TerminalCommandIndex,
} from "../../common/terminal";

export interface TerminalCommandPage {
  commands: TerminalCommandIndex[];
  nextCursor: number | null;
}

export interface TerminalOutputQuery {
  query?: string;
  commandId?: string;
  fromMs?: number;
  toMs?: number;
  cursor?: number;
  limit?: number;
}

export interface TerminalOutputHit {
  cursor: number;
  atMs: number;
  commandId: string | null;
  text: string;
}

export interface TerminalOutputPage {
  hits: TerminalOutputHit[];
  nextCursor: number | null;
}

function artifact(sessionDir: string, file: string): string {
  return path.join(sessionDir, TERMINAL_ARTIFACTS.directory, file);
}

function parseCommand(line: string): TerminalCommandIndex | null {
  try {
    const value = JSON.parse(line) as Partial<TerminalCommandIndex>;
    if (
      typeof value.id !== "string" ||
      typeof value.command !== "string" ||
      typeof value.cwd !== "string" ||
      typeof value.startAtMs !== "number" ||
      typeof value.endAtMs !== "number"
    ) {
      return null;
    }
    return value as TerminalCommandIndex;
  } catch {
    return null;
  }
}

export async function listTerminalCommands(
  sessionDir: string,
  cursor = 0,
  limit = 100,
): Promise<TerminalCommandPage> {
  const file = artifact(sessionDir, TERMINAL_ARTIFACTS.commands);
  if (!existsSync(file)) return { commands: [], nextCursor: null };
  const start = Math.max(0, Math.floor(cursor));
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const commands: TerminalCommandIndex[] = [];
  let row = 0;
  let more = false;
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (row++ < start) continue;
    const command = parseCommand(line);
    if (!command) continue;
    if (commands.length < boundedLimit) commands.push(command);
    else {
      more = true;
      break;
    }
  }
  lines.close();
  return {
    commands,
    nextCursor: more ? start + commands.length : null,
  };
}

async function commandRange(
  sessionDir: string,
  commandId: string,
): Promise<TerminalCommandIndex | null> {
  let cursor = 0;
  while (true) {
    const page = await listTerminalCommands(sessionDir, cursor, 200);
    const found = page.commands.find((command) => command.id === commandId);
    if (found) return found;
    if (page.nextCursor === null) return null;
    cursor = page.nextCursor;
  }
}

function excerpt(text: string, query?: string): string {
  const clean = stripVTControlCharacters(text).replaceAll("\u0000", "");
  if (!query) return clean.slice(0, 2000);
  const lower = clean.toLocaleLowerCase();
  const at = lower.indexOf(query.toLocaleLowerCase());
  if (at < 0) return "";
  const start = Math.max(0, at - 500);
  return clean.slice(start, Math.min(clean.length, at + query.length + 1000));
}

/** Streams the asciicast transcript and returns only bounded matching excerpts. */
export async function searchTerminalOutput(
  sessionDir: string,
  input: TerminalOutputQuery,
): Promise<TerminalOutputPage> {
  if (
    !input.query?.trim() &&
    !input.commandId &&
    input.fromMs == null &&
    input.toMs == null
  ) {
    throw new Error("Search terminal output by query, command, or time window.");
  }
  const file = artifact(sessionDir, TERMINAL_ARTIFACTS.transcript);
  if (!existsSync(file)) return { hits: [], nextCursor: null };
  const range = input.commandId
    ? await commandRange(sessionDir, input.commandId)
    : null;
  if (input.commandId && !range) return { hits: [], nextCursor: null };
  const fromMs = Math.max(
    0,
    input.fromMs ?? range?.startAtMs ?? 0,
  );
  const toMs = Math.max(
    fromMs,
    input.toMs ?? range?.endAtMs ?? Number.POSITIVE_INFINITY,
  );
  const startCursor = Math.max(0, Math.floor(input.cursor ?? 0));
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 20)));
  const hits: TerminalOutputHit[] = [];
  let outputCursor = 0;
  let more = false;
  let activeCommand: string | null = null;
  let commandCursor = 0;
  let commandsPage = await listTerminalCommands(sessionDir, 0, 200);
  let commands = commandsPage.commands;
  let commandIndex = 0;

  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let first = true;
  for await (const line of lines) {
    if (first) {
      first = false;
      continue;
    }
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !Array.isArray(row) ||
      row[1] !== "o" ||
      typeof row[0] !== "number" ||
      typeof row[2] !== "string"
    ) {
      continue;
    }
    const atMs = Math.max(0, Math.round(row[0] * 1000));
    while (commands[commandIndex] && atMs > commands[commandIndex].endAtMs) {
      commandIndex++;
      if (commandIndex >= commands.length && commandsPage.nextCursor !== null) {
        commandCursor = commandsPage.nextCursor;
        commandsPage = await listTerminalCommands(sessionDir, commandCursor, 200);
        commands = commandsPage.commands;
        commandIndex = 0;
      }
    }
    const command = commands[commandIndex];
    activeCommand =
      command && atMs >= command.startAtMs && atMs <= command.endAtMs
        ? command.id
        : null;
    if (atMs < fromMs || atMs > toMs) continue;
    const text = excerpt(row[2], input.query?.trim());
    if (!text) continue;
    const cursor = outputCursor++;
    if (cursor < startCursor) continue;
    if (hits.length < limit) {
      hits.push({ cursor, atMs, commandId: activeCommand, text });
    } else {
      more = true;
      break;
    }
  }
  lines.close();
  return {
    hits,
    nextCursor: more ? startCursor + hits.length : null,
  };
}
