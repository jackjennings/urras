import { join } from "@std/path";
import { parse } from "@std/toml";
import { isRegularFile, readDir, readTextFile, stat } from "./filesystem.ts";
import type { Ceremony, ModelChainEntry } from "./ceremonies/types.ts";
import { isValidCeremonyName } from "./ceremonies/types.ts";
import { PromptCeremony } from "./ceremonies/prompt.ts";
import { ModuleCeremony } from "./ceremonies/module.ts";
import {
  isCeremonyApproved,
  readApprovals,
  writeApprovals,
} from "./ceremonies/approvals.ts";
import type { ApprovalRecord } from "./ceremonies/approvals.ts";
import { compactTimestamp } from "./timestamp.ts";
import type { TicketState } from "./state/types.ts";
import type { LanguageModel, LanguageModelRequest } from "./models/types.ts";

export type { Ceremony } from "./ceremonies/types.ts";
import { BUILT_IN_CEREMONY_NAMES } from "./ceremonies/built-ins.ts";

const CEREMONY_TIMEOUT_MS = 300_000;

export interface CeremonyRunnerDeps {
  stateDir: string;
  extensionsDir: string;
  appendTickLog(entry: object): Promise<void>;
  now?: () => Temporal.ZonedDateTime;
  runClaude?: (args: string[]) => Promise<{ stdout: string; code: number }>;
  notify?(title: string, message: string): Promise<void>;
  listTickets(): Promise<string[]>;
  readTicket(id: string): Promise<TicketState>;
  generateText(
    request: LanguageModelRequest,
    callSite?: string,
  ): Promise<string | null>;
  generateObject<T>(
    request: LanguageModelRequest & { schema: object },
    callSite?: string,
  ): Promise<T | null>;
  runGit(
    args: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }>;
  runGh(
    args: string[],
    token: string,
  ): Promise<{ success: boolean; stdout: string; stderr: string }>;
  commitState(): Promise<void>;
  pushTicket(ticket: { title: string; body: string }): Promise<void>;
  timeoutMs?: number;
  getModel(chain: ModelChainEntry[], callSite?: string): LanguageModel;
}

function parseTimestampPrefix(filename: string): Temporal.PlainDateTime | null {
  if (filename.length < 15 || filename[8] !== "T") return null;
  const year = parseInt(filename.slice(0, 4), 10);
  const month = parseInt(filename.slice(4, 6), 10);
  const day = parseInt(filename.slice(6, 8), 10);
  const hour = parseInt(filename.slice(9, 11), 10);
  const minute = parseInt(filename.slice(11, 13), 10);
  const second = parseInt(filename.slice(13, 15), 10);
  if (
    isNaN(year) || isNaN(month) || isNaN(day) ||
    isNaN(hour) || isNaN(minute) || isNaN(second)
  ) return null;
  try {
    return Temporal.PlainDateTime.from({
      year,
      month,
      day,
      hour,
      minute,
      second,
    });
  } catch {
    return null;
  }
}

export async function nextCeremonyRunTime(opts: {
  config: Record<string, unknown>;
  now: Temporal.ZonedDateTime;
  outputDir: string;
  name: string;
}): Promise<Temporal.ZonedDateTime | null> {
  const { config, now, outputDir, name } = opts;

  const timeStr = config.time;
  if (typeof timeStr !== "string" || !/^\d{2}:\d{2}$/.test(timeStr)) {
    return null;
  }
  const hour = parseInt(timeStr.slice(0, 2), 10);
  const minute = parseInt(timeStr.slice(3), 10);
  if (hour > 23 || minute > 59) return null;

  const intervalHours = typeof config.interval_hours === "number"
    ? config.interval_hours
    : null;
  const workdaysOnly = config.workdays_only === true;

  const threshold = now.with({
    hour,
    minute,
    second: 0,
    millisecond: 0,
    microsecond: 0,
    nanosecond: 0,
  });

  if (intervalHours !== null) {
    if (workdaysOnly && now.dayOfWeek > 5) {
      return threshold.add({ days: 8 - now.dayOfWeek });
    }

    let mostRecent: Temporal.PlainDateTime | null = null;
    try {
      for await (const entry of readDir(outputDir)) {
        if (!entry.isFile || !entry.name.includes(name)) continue;
        const dt = parseTimestampPrefix(entry.name);
        if (
          dt !== null &&
          (mostRecent === null ||
            Temporal.PlainDateTime.compare(dt, mostRecent) > 0)
        ) {
          mostRecent = dt;
        }
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    if (mostRecent === null) return threshold;
    const eligible = mostRecent.add({
      seconds: Math.round(intervalHours * 3600),
    });
    return eligible.toZonedDateTime(now.timeZoneId);
  }

  // Daily
  if (workdaysOnly && now.dayOfWeek > 5) {
    return threshold.add({ days: 8 - now.dayOfWeek });
  }

  const todayPrefix = String(now.year) +
    String(now.month).padStart(2, "0") +
    String(now.day).padStart(2, "0");

  let todayFileExists = false;
  try {
    for await (const entry of readDir(outputDir)) {
      if (entry.isFile && entry.name.startsWith(todayPrefix)) {
        todayFileExists = true;
        break;
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  if (!todayFileExists) return threshold;

  let next = threshold.add({ days: 1 });
  if (workdaysOnly) {
    while (next.dayOfWeek > 5) next = next.add({ days: 1 });
  }
  return next;
}

export interface CeremonyStatus {
  name: string;
  kind: "built-in" | "custom";
  approval: string;
  nextRun: string;
}

export async function listCeremonyStatuses(opts: {
  extensionsDir: string;
  stateDir: string;
  now: Temporal.ZonedDateTime;
}): Promise<CeremonyStatus[]> {
  const { extensionsDir, stateDir, now } = opts;
  const ceremoniesDir = join(extensionsDir, "ceremonies");

  const builtInSet = new Set<string>(BUILT_IN_CEREMONY_NAMES);
  const fsDirs = new Map<string, string>();

  try {
    for await (const entry of readDir(ceremoniesDir)) {
      if (!entry.isDirectory) continue;
      if (!isValidCeremonyName(entry.name)) continue;
      fsDirs.set(entry.name, join(ceremoniesDir, entry.name));
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  const nameSet = new Set<string>([...builtInSet, ...fsDirs.keys()]);
  const results: CeremonyStatus[] = [];

  for (const name of nameSet) {
    const isBuiltIn = builtInSet.has(name);
    const ceremonyDir = fsDirs.get(name);
    const kind: "built-in" | "custom" = isBuiltIn ? "built-in" : "custom";

    let approval: string;
    if (isBuiltIn) {
      approval = "—";
    } else if (ceremonyDir !== undefined) {
      try {
        approval = (await isCeremonyApproved(name, ceremonyDir)) ? "yes" : "no";
      } catch {
        approval = "no";
      }
    } else {
      approval = "no";
    }

    let nextRun: string;
    if (ceremonyDir === undefined) {
      nextRun = "no config";
    } else {
      let config: Record<string, unknown> | null = null;
      try {
        const raw = await readTextFile(join(ceremonyDir, "config.toml"));
        config = parse(raw) as Record<string, unknown>;
      } catch {
        config = null;
      }
      if (config === null) {
        nextRun = "no config";
      } else {
        const outputDir = join(stateDir, "ceremonies", name, "output");
        const next = await nextCeremonyRunTime({
          config,
          now,
          outputDir,
          name,
        });
        nextRun = next !== null ? compactTimestamp(next) : "no config";
      }
    }

    results.push({ name, kind, approval, nextRun });
  }

  return results;
}

export class CeremonyRunner {
  readonly #deps: CeremonyRunnerDeps;
  readonly #ceremonies: Map<string, Ceremony>;

  constructor(deps: CeremonyRunnerDeps, ceremonies: Ceremony[]) {
    this.#deps = deps;
    this.#ceremonies = new Map(ceremonies.map((c) => [c.name, c]));
  }

  async run(): Promise<void> {
    const ceremoniesDir = join(this.#deps.extensionsDir, "ceremonies");
    const dirEntries: Deno.DirEntry[] = [];
    try {
      for await (const entry of readDir(ceremoniesDir)) {
        dirEntries.push(entry);
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
    for (const entry of dirEntries) {
      if (!entry.isDirectory) continue;
      if (!isValidCeremonyName(entry.name)) {
        await this.#deps.appendTickLog({
          event: "ceremony-warning",
          ceremony: entry.name,
          reason: "invalid-name",
        });
        continue;
      }
      try {
        await this.#dispatchCeremony(ceremoniesDir, entry.name);
      } catch (e) {
        await this.#deps.appendTickLog({
          event: "ceremony-warning",
          ceremony: entry.name,
          reason: "ceremony-failed",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  async #dispatchCeremony(
    ceremoniesDir: string,
    name: string,
  ): Promise<void> {
    const ceremonyDir = join(ceremoniesDir, name);
    const builtin = this.#ceremonies.get(name);
    if (builtin) {
      await this.#runCeremony(builtin, ceremonyDir, false);
      return;
    }
    if (await isRegularFile(join(ceremonyDir, "index.ts"))) {
      await this.#runCeremony(
        new ModuleCeremony({
          name,
          stateDir: this.#deps.stateDir,
          ceremonyDir,
          appendTickLog: this.#deps.appendTickLog,
          listTickets: this.#deps.listTickets,
          readTicket: this.#deps.readTicket,
          generateText: (request) =>
            this.#deps.generateText(request, `ceremony:${name}`),
          generateObject: (request) =>
            this.#deps.generateObject(request, `ceremony:${name}`),
          runGit: this.#deps.runGit,
          runGh: this.#deps.runGh,
          commitState: this.#deps.commitState,
          notify: this.#deps.notify,
          getModel: (chain) => this.#deps.getModel(chain, `ceremony:${name}`),
          pushTicket: this.#deps.pushTicket,
        }),
        ceremonyDir,
        true,
      );
      return;
    }
    if (!await isRegularFile(join(ceremonyDir, "prompt.md"))) return;
    await this.#runCeremony(
      new PromptCeremony({
        name,
        ceremonyDir,
        appendTickLog: this.#deps.appendTickLog,
        runClaude: this.#deps.runClaude,
      }),
      ceremonyDir,
      true,
    );
  }

  async #runCeremony(
    ceremony: Ceremony,
    ceremonyDir: string,
    gated: boolean,
  ): Promise<void> {
    const configPath = join(ceremonyDir, "config.toml");
    let configStat: Deno.FileInfo;
    try {
      configStat = await stat(configPath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
    if (!configStat.isFile) {
      await this.#deps.appendTickLog({
        event: "ceremony-warning",
        ceremony: ceremony.name,
        reason: "config.toml is not a regular file",
      });
      return;
    }
    let raw: string;
    try {
      raw = await readTextFile(configPath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }

    let config: Record<string, unknown>;
    try {
      config = parse(raw) as Record<string, unknown>;
    } catch {
      await this.#deps.appendTickLog({
        event: "ceremony-warning",
        ceremony: ceremony.name,
        reason: "could not parse config.toml",
      });
      return;
    }

    const timeStr = config.time;
    if (typeof timeStr !== "string" || !/^\d{2}:\d{2}$/.test(timeStr)) {
      await this.#deps.appendTickLog({
        event: "ceremony-warning",
        ceremony: ceremony.name,
        reason: `invalid time: ${String(timeStr)}`,
      });
      return;
    }
    const hour = parseInt(timeStr.slice(0, 2), 10);
    const minute = parseInt(timeStr.slice(3), 10);
    if (hour > 23 || minute > 59) {
      await this.#deps.appendTickLog({
        event: "ceremony-warning",
        ceremony: ceremony.name,
        reason: `invalid time: ${timeStr}`,
      });
      return;
    }

    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = (this.#deps.now ??
      (() => Temporal.Now.zonedDateTimeISO(localTz)))();

    const outputDir = join(
      this.#deps.stateDir,
      "ceremonies",
      ceremony.name,
      "output",
    );
    const window = await this.#dueWindow({
      config,
      now,
      outputDir,
      name: ceremony.name,
    });
    if (window === null) return;

    if (gated && !await isCeremonyApproved(ceremony.name, ceremonyDir)) {
      await this.#warnUnapproved(ceremony.name, window);
      return;
    }

    const timeoutMs = this.#deps.timeoutMs ?? CEREMONY_TIMEOUT_MS;
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });
    const runPromise = ceremony.run(now, outputDir);
    try {
      await Promise.race([runPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
    if (timedOut) {
      runPromise.catch(() => {});
      await this.#deps.appendTickLog({
        event: "ceremony-warning",
        ceremony: ceremony.name,
        reason: "timeout",
      });
    }
  }

  async #warnUnapproved(name: string, window: string): Promise<void> {
    let approvals: ApprovalRecord | null = null;
    try {
      approvals = await readApprovals();
    } catch (e) {
      await this.#deps.appendTickLog({
        event: "ceremony-warning",
        ceremony: name,
        reason: "approvals-unreadable",
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (approvals?.[name]?.lastWarnedWindow === window) return;

    await this.#deps.appendTickLog({
      event: "ceremony-warning",
      ceremony: name,
      reason: "not-approved",
    });
    try {
      await this.#deps.notify?.(
        "urras",
        `Ceremony ${name} needs approval: run ur approve ceremony/${name}`,
      );
    } catch {
      // notification failures must not abort the run
    }

    if (approvals === null) return;
    approvals[name] = { ...approvals[name], lastWarnedWindow: window };
    await writeApprovals(approvals);
  }

  async #dueWindow(opts: {
    config: Record<string, unknown>;
    now: Temporal.ZonedDateTime;
    outputDir: string;
    name: string;
  }): Promise<string | null> {
    const { config, now, outputDir, name } = opts;
    const next = await nextCeremonyRunTime({ config, now, outputDir, name });
    if (next === null) return null;
    if (Temporal.ZonedDateTime.compare(now, next) < 0) return null;

    const intervalHours = typeof config.interval_hours === "number"
      ? config.interval_hours
      : null;
    if (intervalHours !== null) {
      return compactTimestamp(next);
    }
    return String(now.year) +
      String(now.month).padStart(2, "0") +
      String(now.day).padStart(2, "0");
  }
}
