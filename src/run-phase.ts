import { parseArgs } from "@std/cli/parse-args";
import { CONTEXT_PHASE_SEQUENCE } from "./phases/types.ts";
import { join } from "@std/path";
import type { CodeAgent } from "./agents/types.ts";
import { PiCodeAgent } from "./agents/pi.ts";
import { ClaudeCodeAgent } from "./agents/claude-code.ts";
import type { PhaseModelUsage, PhaseUsage } from "./state/types.ts";
import {
  type AnthropicPricingCache,
  calculateAnthropicCost,
} from "./anthropic-pricing.ts";
import {
  mkdir,
  readDir,
  readTextFile,
  remove,
  stat,
  writeTextFile,
} from "./filesystem.ts";
import { deriveProjectPath } from "./phases/project-path.ts";
import matter from "gray-matter";
import { captureCommandRunner, type CommandRunner } from "./apfel.ts";
import { filterPrinciples } from "./judge-principles.ts";
import type { OllamaLanguageModel } from "./models/ollama.ts";

export function getPiEnvironmentVariables(
  home: string,
): Record<string, string> {
  return {
    PI_CODING_AGENT_DIR: join(home, ".urras", "pi"),
    PI_CODING_AGENT_SESSION_DIR: join(home, ".urras", "pi", "sessions"),
  };
}

export async function setupPiDirectories(home: string): Promise<void> {
  const sessionsDir = join(home, ".urras", "pi", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const extensionsDir = join(home, ".urras", "pi", "extensions");
  await mkdir(extensionsDir, { recursive: true });
  const extensionsSourceDir = new URL(
    "./pi-extensions/",
    import.meta.url,
  ).pathname;
  for await (const entry of readDir(extensionsSourceDir)) {
    if (!entry.isFile) continue;
    const sourcePath = join(extensionsSourceDir, entry.name);
    const symlinkPath = join(extensionsDir, entry.name);
    try {
      await remove(symlinkPath);
    } catch { /* may not exist */ }
    await Deno.symlink(sourcePath, symlinkPath);
  }
}

export async function setupClaudeCodeDirectories(home: string): Promise<void> {
  const claudeCodeDir = join(home, ".urras", "claude-code");
  await mkdir(claudeCodeDir, { recursive: true });
  const settingsPath = join(claudeCodeDir, "settings.json");
  try {
    await stat(settingsPath);
  } catch {
    await writeTextFile(
      settingsPath,
      JSON.stringify({ attribution: { commit: "", pr: "" } }),
    );
  }
}

function selectLatestPhaseFiles(
  sortedFiles: string[],
  phase: string,
): string[] {
  if (sortedFiles.length === 0) return [];
  const docSuffix = `-${phase}.md`;
  const latest = sortedFiles[sortedFiles.length - 1];
  if (latest.endsWith(docSuffix)) {
    return [latest];
  }
  for (let i = sortedFiles.length - 2; i >= 0; i--) {
    if (sortedFiles[i].endsWith(docSuffix)) {
      return [sortedFiles[i], latest];
    }
  }
  return [latest];
}

const PRINCIPLES_THRESHOLD = 20;
const PRINCIPLES_TOP_K = 5;

export async function buildContextFiles(
  {
    ticketDir,
    stateDir,
    includePrinciples = true,
    run,
    ollamaModels,
  }: {
    ticketDir: string;
    stateDir: string;
    includePrinciples?: boolean;
    run?: CommandRunner;
    ollamaModels?: OllamaLanguageModel[];
  },
): Promise<{ contextFiles: string[]; tempPrinciplesFile?: string }> {
  const principlesPath = join(stateDir, "principles.md");
  const contextFiles: string[] = [];
  let tempPrinciplesFile: string | undefined;

  if (includePrinciples) {
    let principlesText: string | null = null;
    try {
      principlesText = await readTextFile(principlesPath);
    } catch {
      /* principles.md doesn't exist yet */
    }

    if (principlesText !== null) {
      const allEntries = parsePrincipleEntries(principlesText);
      if (run !== undefined && allEntries.length > PRINCIPLES_THRESHOLD) {
        let filtered = false;
        try {
          const metaRaw = await readTextFile(join(ticketDir, "meta.md"));
          const { data, content } = matter(metaRaw);
          const title = typeof data.title === "string" ? data.title : "";
          const problemMatch = content.match(
            /## Problem\n([\s\S]*?)(?=\n## |\s*$)/,
          );
          const problem = problemMatch
            ? problemMatch[1].trim()
            : content.trim();
          const filterContext = [title, problem].filter(Boolean).join("\n\n");

          const indices = await filterPrinciples(
            allEntries.map((e) => e.raw),
            filterContext,
            PRINCIPLES_TOP_K,
            run,
            ollamaModels,
          );
          if (indices === null) throw new Error("llm-failed");

          const selected = [...indices]
            .sort((a, b) => a - b)
            .map((i) => allEntries[i].raw)
            .join("\n");

          tempPrinciplesFile = join(ticketDir, "principles-filtered.md");
          await writeTextFile(tempPrinciplesFile, selected);
          contextFiles.push(`@${tempPrinciplesFile}`);
          await appendPhaseLog(ticketDir, {
            event: "principles-filtered",
            total: allEntries.length,
            included: indices.length,
          });
          filtered = true;
        } catch (e) {
          const reason = e instanceof Error && e.message === "llm-failed"
            ? "llm-failed"
            : "meta-unreadable";
          await appendPhaseLog(ticketDir, {
            event: "principles-filter-failed",
            reason,
          }).catch(() => {});
        }
        if (!filtered) {
          contextFiles.push(`@${principlesPath}`);
        }
      } else {
        contextFiles.push(`@${principlesPath}`);
      }
    }

    if (stateDir) {
      const relative = ticketDir.slice(stateDir.length + 1);
      const provider = relative.split("/")[0];
      if (provider) {
        const projectPath = deriveProjectPath(provider, relative);
        if (projectPath) {
          const localPath = join(
            stateDir,
            "principles",
            provider,
            `${projectPath}.md`,
          );
          try {
            await stat(localPath);
            contextFiles.push(`@${localPath}`);
          } catch {
            /* local principles file doesn't exist yet */
          }
        }
      }
    }
  }

  contextFiles.push(`@${ticketDir}/meta.md`);
  for (const phase of CONTEXT_PHASE_SEQUENCE) {
    const phaseFiles: string[] = [];
    const prefixPattern = new RegExp(`^\\d{8}T\\d{6}-${phase}[.-]`);
    try {
      for await (const entry of readDir(ticketDir)) {
        if (
          entry.isFile &&
          prefixPattern.test(entry.name) &&
          entry.name.endsWith(".md")
        ) {
          phaseFiles.push(entry.name);
        }
      }
    } catch {
      /* ticketDir not found */
    }
    phaseFiles.sort();
    for (const f of selectLatestPhaseFiles(phaseFiles, phase)) {
      contextFiles.push(`@${ticketDir}/${f}`);
    }
  }

  return { contextFiles, tempPrinciplesFile };
}

export async function appendPhaseLog(
  ticketDir: string,
  entry: object,
): Promise<void> {
  await writeTextFile(
    join(ticketDir, "log.ndjson"),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    { append: true },
  );
}

export function extractSessionId(ndjson: string): string | null {
  const lines = ndjson.split("\n").filter(Boolean);
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === "session" && typeof event.id === "string") {
      return event.id;
    }
  }
  return null;
}

export function extractUsageAndText(
  ndjson: string,
  durationMs: number,
): { text: string; usage: PhaseUsage | null } {
  const lines = ndjson.split("\n").filter(Boolean);
  const events = lines.map((l) => JSON.parse(l));
  const agentEnd = events.find((e) => e.type === "agent_end");
  if (!agentEnd) {
    return { text: "", usage: null };
  }
  const assistantMessages = (agentEnd.messages as {
    role: string;
    model?: string;
    content: { type: string; text?: string; name?: string }[];
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
  }[]).filter((m) => m.role === "assistant");

  let lastText = "";
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let model = "";
  const tools: Record<string, number> = {};

  for (const msg of assistantMessages) {
    const msgText = msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    if (msgText) lastText = msgText;
    if (msg.usage) {
      input += msg.usage.input;
      output += msg.usage.output;
      cacheRead += msg.usage.cacheRead;
      cacheWrite += msg.usage.cacheWrite;
    }
    if (msg.model) model = msg.model;
    for (const item of msg.content) {
      if (item.type === "tool_use" && item.name) {
        const name = item.name.toLowerCase();
        tools[name] = (tools[name] ?? 0) + 1;
      }
    }
  }

  return {
    text: lastText,
    usage: {
      durationMs,
      turns: assistantMessages.length,
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
      models: [{ model, input, output, cacheRead, cacheWrite }],
    },
  };
}

export function extractClaudeCodeSessionId(ndjson: string): string | null {
  const lines = ndjson.split("\n").filter(Boolean);
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === "system" && typeof event.session_id === "string") {
      return event.session_id;
    }
  }
  return null;
}

export function extractClaudeCodeUsageAndText(
  ndjson: string,
  durationMs: number,
  requestedModel: string,
): { text: string; usage: PhaseUsage | null } {
  const lines = ndjson.split("\n").filter(Boolean);
  const events = lines.map((l) => JSON.parse(l));
  const tools: Record<string, number> = {};
  for (const event of events) {
    if (event.type === "assistant") {
      const content = (event.message?.content ?? []) as {
        type: string;
        name?: string;
      }[];
      for (const item of content) {
        if (item.type === "tool_use" && item.name) {
          const name = item.name.toLowerCase();
          tools[name] = (tools[name] ?? 0) + 1;
        }
      }
    }
  }
  const result = events.find((e) => e.type === "result");
  if (!result) {
    return { text: "", usage: null };
  }
  // `result.usage` is per-run, not cumulative across a `--resume`: a resumed
  // turn reports only that invocation's tokens, so this is the phase's usage
  // even for implementation-revision runs. Verified empirically against the
  // claude CLI's stream-json output.
  const usage = result.usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | undefined;

  const modelUsage = result.modelUsage as
    | Record<string, { inputTokens?: number; outputTokens?: number }>
    | undefined;

  let models: PhaseModelUsage[];
  if (!modelUsage || Object.keys(modelUsage).length === 0) {
    models = [{
      model: "",
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    }];
  } else {
    const entries = Object.entries(modelUsage).map(([key, val]) => ({
      model: key.replace(/\[[^\]]*\]$/, ""),
      input: val.inputTokens ?? 0,
      output: val.outputTokens ?? 0,
    }));
    const cacheTarget = entries.find((e) => e.model === requestedModel) ??
      entries.reduce((a, b) =>
        a.input + a.output >= b.input + b.output ? a : b
      );
    models = entries.map((e) => ({
      model: e.model,
      input: e.input,
      output: e.output,
      cacheRead: e.model === cacheTarget.model
        ? (usage?.cache_read_input_tokens ?? 0)
        : 0,
      cacheWrite: e.model === cacheTarget.model
        ? (usage?.cache_creation_input_tokens ?? 0)
        : 0,
    }));
  }

  return {
    text: typeof result.result === "string" ? result.result : "",
    usage: {
      durationMs,
      turns: typeof result.num_turns === "number"
        ? result.num_turns
        : undefined,
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
      models,
    },
  };
}

export function extractPrinciples(content: string): string | null {
  const match = content.match(
    /(?:^|\n)## Principles\n([\s\S]*?)(?=\n## |\n*$)/,
  );
  if (!match) return null;
  const body = match[1].trim();
  if (body.length === 0) return null;
  return body;
}

function parsePrincipleEntries(
  content: string,
): { raw: string; normalized: string }[] {
  const entries: string[][] = [];
  let current: string[] | null = null;
  for (const line of content.split("\n")) {
    if (/^\s*-\s/.test(line)) {
      if (current) entries.push(current);
      current = [line];
    } else if (line.trim() === "") {
      if (current) entries.push(current);
      current = null;
    } else if (current) {
      current.push(line);
    } else {
      current = [line];
    }
  }
  if (current) entries.push(current);
  return entries.map((lines) => {
    const raw = lines.join("\n");
    return { raw, normalized: raw.replace(/\s+/g, " ").trim() };
  });
}

export function dedupePrinciples(
  existing: string,
  extracted: string,
): string | null {
  const seen = new Set(
    parsePrincipleEntries(existing).map((e) => e.normalized),
  );
  const novel: string[] = [];
  for (const entry of parsePrincipleEntries(extracted)) {
    if (seen.has(entry.normalized)) continue;
    seen.add(entry.normalized);
    novel.push(entry.raw);
  }
  return novel.length > 0 ? novel.join("\n") : null;
}

export async function executePhase(
  opts: {
    ticketDir: string;
    stateDir: string;
    outputFile: string;
    phase: string;
    scopeDirs: string[];
    prompt: string;
    worktrees: Record<string, { path: string; branch: string }>;
    homeDir: string;
    provider: string;
    model: string;
    thinking: string;
    agentType: "pi" | "claude-code";
    contextFiles?: string[];
    sessionId?: string;
    resume?: boolean;
    includePrinciples?: boolean;
    run?: CommandRunner;
  },
  agent: CodeAgent,
): Promise<number> {
  let env: Record<string, string> = {
    ...Deno.env.toObject(),
    ANTHROPIC_API_KEY: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  };

  if (opts.agentType === "pi") {
    await setupPiDirectories(opts.homeDir);
    const piEnv = getPiEnvironmentVariables(opts.homeDir);
    env = { ...env, ...piEnv };
  } else {
    await setupClaudeCodeDirectories(opts.homeDir);
  }

  const run = opts.run ?? captureCommandRunner();
  const { contextFiles } = opts.contextFiles
    ? { contextFiles: opts.contextFiles }
    : await buildContextFiles({
      ticketDir: opts.ticketDir,
      stateDir: opts.stateDir,
      includePrinciples: opts.includePrinciples,
      run,
    });

  const allPaths = [
    ...opts.scopeDirs,
    ...Object.values(opts.worktrees).map((w) => w.path),
  ];
  const outputFilePath = join(opts.ticketDir, opts.outputFile);
  const pathContext = `\n\nOutput file: ${outputFilePath}` +
    `\n\nTicket directory: ${opts.ticketDir}` +
    (allPaths.length > 0
      ? `\n\nAvailable directories:\n${
        allPaths.map((p) => `- ${p}`).join("\n")
      }`
      : "");

  const worktreePaths = Object.values(opts.worktrees).map((w) => w.path);
  const cwd = worktreePaths[0] ?? opts.ticketDir;

  await appendPhaseLog(opts.ticketDir, {
    event: "phase-start",
    phase: opts.phase,
  });

  try {
    await remove(outputFilePath);
  } catch {
    // file didn't exist; nothing to do
  }

  const startMs = Temporal.Now.instant().epochMilliseconds;
  const result = await agent.runPhase({
    prompt: opts.prompt + pathContext,
    contextFiles,
    cwd,
    env,
    provider: opts.provider,
    model: opts.model,
    thinking: opts.thinking,
    sessionId: opts.sessionId,
    resume: opts.resume,
  });
  const durationMs = Temporal.Now.instant().epochMilliseconds - startMs;

  const { usage } = opts.agentType === "claude-code"
    ? extractClaudeCodeUsageAndText(result.stdout, durationMs, opts.model)
    : extractUsageAndText(result.stdout, durationMs);

  if (usage !== null) {
    try {
      const cacheText = await readTextFile(
        join(opts.homeDir, ".urras", "anthropic-pricing.json"),
      );
      const pricingCache = JSON.parse(cacheText) as AnthropicPricingCache;
      for (const modelEntry of usage.models) {
        const cost = calculateAnthropicCost(modelEntry, pricingCache.models);
        if (cost !== null) modelEntry.costUsd = cost;
      }
    } catch {
      // pricing unavailable
    }
    await writeTextFile(
      join(opts.ticketDir, opts.outputFile.replace(/\.md$/, ".usage.json")),
      JSON.stringify(usage),
    );
  }

  const sessionId = opts.agentType === "claude-code"
    ? extractClaudeCodeSessionId(result.stdout)
    : extractSessionId(result.stdout);

  await appendPhaseLog(opts.ticketDir, {
    event: "phase-end",
    phase: opts.phase,
    exitCode: result.code,
    output: result.stderr,
    ...(sessionId !== null ? { sessionId } : {}),
  });

  try {
    await writeTextFile(
      join(opts.ticketDir, opts.outputFile + ".exit"),
      String(result.code),
    );
  } catch {
    // sidecar write failure does not affect the returned exit code
  }

  if (sessionId !== null) {
    try {
      await writeTextFile(
        join(opts.ticketDir, opts.outputFile + ".session"),
        sessionId,
      );
    } catch {
      // sidecar write failure does not affect the returned exit code
    }
  }

  return result.code;
}

export async function readPhaseSessionId(
  ticketDir: string,
  phase: string,
): Promise<string | null> {
  const pattern = new RegExp(`^\\d{8}T\\d{6}-${phase}\\.md\\.session$`);
  const matches: string[] = [];
  try {
    for await (const entry of readDir(ticketDir)) {
      if (entry.isFile && pattern.test(entry.name)) {
        matches.push(entry.name);
      }
    }
  } catch {
    // dir missing
  }
  if (matches.length === 0) return null;
  matches.sort();
  try {
    return await readTextFile(join(ticketDir, matches[matches.length - 1]));
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: [
      "ticket-dir",
      "output-file",
      "phase",
      "scope",
      "prompt",
      "worktrees",
      "provider",
      "model",
      "thinking",
      "context-files",
      "agent",
      "session-id",
      "state-dir",
    ],
    boolean: ["skip-principles", "resume"],
  });

  const ticketDir = args["ticket-dir"]!;
  const outputFile = args["output-file"]!;
  const phase = args["phase"]!;
  const scopeDirs = args["scope"]
    ? args["scope"].split(",").filter(Boolean)
    : [];
  const prompt = args["prompt"]!;
  const worktrees = args["worktrees"]
    ? (JSON.parse(args["worktrees"]) as Record<
      string,
      { path: string; branch: string }
    >)
    : {};

  const homeDir = Deno.env.get("HOME");
  if (!homeDir) {
    throw new Error("HOME environment variable is not set");
  }

  const contextFiles = args["context-files"]
    ? args["context-files"].split(",").filter(Boolean)
    : undefined;

  const agentType = (args["agent"] as "pi" | "claude-code" | undefined) ??
    "pi";

  const stateDir = args["state-dir"] ?? "";

  const code = await executePhase(
    {
      ticketDir,
      stateDir,
      outputFile,
      phase,
      scopeDirs,
      prompt,
      worktrees,
      homeDir,
      provider: args["provider"]!,
      model: args["model"]!,
      thinking: args["thinking"]!,
      agentType,
      contextFiles,
      sessionId: args["session-id"] ?? undefined,
      resume: args["resume"] ?? false,
      includePrinciples: !args["skip-principles"],
    },
    agentType === "claude-code"
      ? new ClaudeCodeAgent(
        join(homeDir, ".urras", "claude-code", "settings.json"),
      )
      : new PiCodeAgent(),
  );
  Deno.exit(code);
}
