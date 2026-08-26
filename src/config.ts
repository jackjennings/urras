import { parse } from "@std/toml";
import { join } from "@std/path";
import type { Config, PhaseModelConfig } from "./state/types.ts";
import { readTextFile } from "./filesystem.ts";
import { urrasDir } from "./paths.ts";

export async function loadConfig(path?: string): Promise<Config> {
  const configPath = path ??
    join(Deno.env.get("HOME")!, ".config", "urras", "config.toml");
  const raw = await readTextFile(configPath);
  const parsed = parse(raw) as Record<string, unknown>;
  const codebaseRaw = parsed.codebase as Record<string, unknown> | undefined;
  const jiraRaw = parsed.jira as Record<string, unknown> | undefined;
  let jira: Config["jira"];
  if (jiraRaw !== undefined) {
    if (typeof jiraRaw.base_url !== "string") {
      throw new Error("config.toml: [jira].base_url is required");
    }
    if (typeof jiraRaw.project !== "string") {
      throw new Error("config.toml: [jira].project is required");
    }
    let jiraStatuses: { pickup: string; done: string } | undefined;
    const statusesRaw = jiraRaw.statuses as Record<string, unknown> | undefined;
    if (statusesRaw !== undefined) {
      if (typeof statusesRaw.pickup !== "string") {
        throw new Error("config.toml: [jira.statuses].pickup must be a string");
      }
      if (typeof statusesRaw.done !== "string") {
        throw new Error("config.toml: [jira.statuses].done must be a string");
      }
      jiraStatuses = { pickup: statusesRaw.pickup, done: statusesRaw.done };
    }
    jira = {
      baseUrl: jiraRaw.base_url,
      project: jiraRaw.project,
      statuses: jiraStatuses,
    };
  }
  const todoTxtRaw = parsed.todo_txt as Record<string, unknown> | undefined;
  let todoTxt: Config["todoTxt"];
  if (todoTxtRaw !== undefined) {
    if (typeof todoTxtRaw.file !== "string") {
      throw new Error("config.toml: [todo_txt].file is required");
    }
    todoTxt = { file: expandHome(todoTxtRaw.file) };
  }
  const ollamaRaw = parsed.ollama as Record<string, unknown> | undefined;
  let ollama: Config["ollama"];
  if (ollamaRaw !== undefined) {
    const modelsRaw = ollamaRaw.models;
    if (
      !Array.isArray(modelsRaw) ||
      (modelsRaw as unknown[]).length === 0 ||
      !(modelsRaw as unknown[]).every((m) => typeof m === "string")
    ) {
      throw new Error(
        "config.toml: [ollama].models must be a non-empty array of strings",
      );
    }
    const urlRaw = ollamaRaw.url;
    if (urlRaw !== undefined && typeof urlRaw !== "string") {
      throw new Error("config.toml: [ollama].url must be a string");
    }
    ollama = {
      models: modelsRaw as string[],
      url: urlRaw as string | undefined,
    };
  }
  const piRaw = parsed.pi as Record<string, unknown> | undefined;
  if (piRaw?.provider !== undefined && typeof piRaw.provider !== "string") {
    throw new Error("config.toml: [pi].provider must be a string");
  }
  const piProvider = (piRaw?.provider as string | undefined) ?? "anthropic";
  const piPackagesRaw = piRaw?.packages;
  if (piPackagesRaw !== undefined && !Array.isArray(piPackagesRaw)) {
    throw new Error("config.toml: [pi].packages must be an array");
  }
  const piPackages = (piPackagesRaw as string[] | undefined) ?? [];
  const agentRaw = parsed.agent as Record<string, unknown> | undefined;
  if (
    agentRaw?.type !== undefined && typeof agentRaw.type !== "string"
  ) {
    throw new Error("config.toml: [agent].type must be a string");
  }
  const agentType = (agentRaw?.type as "pi" | "claude-code" | undefined) ??
    "pi";
  const phasesRaw = parsed.phases as
    | { defaults?: Record<string, unknown> }
    | undefined;
  const phasesDefaults = phasesRaw?.defaults as PhaseModelConfig | undefined;

  const tickRaw = parsed.tick as Record<string, unknown> | undefined;
  const resolveCIFailuresRaw = tickRaw?.resolve_ci_failures;
  if (
    resolveCIFailuresRaw !== undefined &&
    typeof resolveCIFailuresRaw !== "boolean"
  ) {
    throw new Error(
      "config.toml: [tick].resolve_ci_failures must be a boolean",
    );
  }
  const principlesRaw = tickRaw?.principles;
  if (principlesRaw !== undefined && typeof principlesRaw !== "boolean") {
    throw new Error("config.toml: [tick].principles must be a boolean");
  }
  const agentsMdMaxTokensRaw = tickRaw?.agents_md_max_tokens;
  if (agentsMdMaxTokensRaw !== undefined) {
    if (
      typeof agentsMdMaxTokensRaw !== "number" ||
      !Number.isInteger(agentsMdMaxTokensRaw) ||
      agentsMdMaxTokensRaw < 0
    ) {
      throw new Error(
        "config.toml: [tick].agents_md_max_tokens must be a non-negative integer",
      );
    }
  }
  const maxPromptTokensRaw = tickRaw?.max_prompt_tokens;
  if (
    maxPromptTokensRaw !== undefined &&
    typeof maxPromptTokensRaw !== "number"
  ) {
    throw new Error("config.toml: [tick].max_prompt_tokens must be a number");
  }
  const maxTurnsRaw = tickRaw?.max_turns;
  if (maxTurnsRaw !== undefined) {
    if (
      typeof maxTurnsRaw !== "number" ||
      !Number.isInteger(maxTurnsRaw) ||
      maxTurnsRaw < 0
    ) {
      throw new Error(
        "config.toml: [tick].max_turns must be a non-negative integer",
      );
    }
  }
  const checkNewCommentsRaw = tickRaw?.check_new_comments;
  if (
    checkNewCommentsRaw !== undefined &&
    typeof checkNewCommentsRaw !== "boolean"
  ) {
    throw new Error(
      "config.toml: [tick].check_new_comments must be a boolean",
    );
  }

  const githubRaw = parsed.github as Record<string, unknown>;
  const accountsRaw = githubRaw.accounts as
    | Record<string, Record<string, unknown>>
    | undefined;
  let accounts: Config["github"]["accounts"];
  if (accountsRaw !== undefined) {
    accounts = {};
    for (const [name, entry] of Object.entries(accountsRaw)) {
      if (typeof entry.token_env !== "string") {
        throw new Error(
          `config.toml: [github.accounts.${name}].token_env must be a string`,
        );
      }
      if (typeof entry.login !== "string") {
        throw new Error(
          `config.toml: [github.accounts.${name}].login must be a string`,
        );
      }
      const envVal = Deno.env.get(entry.token_env);
      if (!envVal) {
        throw new Error(
          `config.toml: [github.accounts.${name}].token_env "${entry.token_env}" is not set`,
        );
      }
      accounts[name] = { tokenEnv: entry.token_env, login: entry.login };
    }
  }
  const orgsRaw = githubRaw.orgs as Record<string, string> | undefined;
  let orgs: Config["github"]["orgs"];
  if (orgsRaw !== undefined) {
    orgs = {};
    for (const [org, accountName] of Object.entries(orgsRaw)) {
      if (accounts && !accounts[accountName]) {
        throw new Error(
          `config.toml: [github.orgs] references unknown account "${accountName}"`,
        );
      }
      orgs[org] = accountName;
    }
  }

  const extensionsRaw = parsed.extensions as
    | Record<string, unknown>
    | undefined;
  const extensionsDir = typeof extensionsRaw?.dir === "string"
    ? expandHome(extensionsRaw.dir)
    : join(urrasDir(), "extensions");

  return {
    github: {
      repos: githubRaw.repos as string[],
      accounts,
      orgs,
    },
    state: {
      dir: expandHome((parsed.state as Record<string, unknown>).dir as string),
    },
    extensions: { dir: extensionsDir },
    tick: {
      concurrency: (tickRaw?.concurrency as number) ?? 1,
      resolveCIFailures: (resolveCIFailuresRaw as boolean | undefined) ?? true,
      principles: (principlesRaw as boolean | undefined) ?? true,
      agentsMdMaxTokens: (agentsMdMaxTokensRaw as number | undefined) ?? 8000,
      maxPromptTokens: maxPromptTokensRaw as number | undefined,
      maxTurns: (maxTurnsRaw as number | undefined) ?? 100,
      checkNewComments: checkNewCommentsRaw as boolean | undefined,
    },
    codebase: { roots: (codebaseRaw?.roots as string[]) ?? [] },
    pi: { provider: piProvider, packages: piPackages },
    agent: { type: agentType },
    jira,
    todoTxt,
    ollama,
    phases: phasesDefaults !== undefined
      ? { defaults: phasesDefaults }
      : undefined,
  };
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(Deno.env.get("HOME")!, p.slice(2)) : p;
}
