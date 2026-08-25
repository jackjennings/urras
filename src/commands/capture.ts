import { loadConfig as defaultLoadConfig } from "../config.ts";
import type { Config } from "../state/types.ts";
import type { Command } from "./types.ts";

export function inferProvider(scope: string): "github" | "jira" {
  return scope.includes("/") ? "github" : "jira";
}

export function collectScopes(config: Config): string[] {
  const scopes = [...config.github.repos];
  if (config.jira) scopes.push(config.jira.project);
  return scopes;
}

export function validateScope(
  scope: string,
  validScopes: string[],
): string | null {
  if (validScopes.includes(scope)) return null;
  return `capture: unknown scope "${scope}". Valid scopes:\n${
    validScopes.map((s) => `  ${s}`).join("\n")
  }`;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

type GhRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

export async function performCapture(
  opts: { title: string; scope: string; body: string; artifact: string },
  deps?: {
    loadConfig?: () => Promise<Config>;
    runGh?: GhRunner;
    fetch?: typeof globalThis.fetch;
  },
): Promise<void> {
  const config = await (deps?.loadConfig ?? defaultLoadConfig)();
  const validScopes = collectScopes(config);
  const scopeError = validateScope(opts.scope, validScopes);
  if (scopeError) {
    console.error(scopeError);
    Deno.exit(1);
  }

  const provider = inferProvider(opts.scope);

  if (provider === "github") {
    const runGh: GhRunner = deps?.runGh ?? (async (args) => {
      const result = await new Deno.Command("gh", {
        args,
        stdout: "piped",
        stderr: "inherit",
      }).output();
      return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout).trim(),
      };
    });
    const { code, stdout } = await runGh([
      "issue",
      "create",
      "--repo",
      opts.scope,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ]);
    if (code !== 0) Deno.exit(code);
    console.log(stdout);
    return;
  }

  if (!config.jira) {
    console.error("capture: Jira is not configured");
    Deno.exit(1);
  }
  const email = Deno.env.get("JIRA_EMAIL");
  const apiToken = Deno.env.get("JIRA_API_TOKEN");
  if (!email || !apiToken) {
    console.error("capture: JIRA_EMAIL and JIRA_API_TOKEN must be set");
    Deno.exit(1);
  }
  const auth = btoa(`${email}:${apiToken}`);
  const url = `${config.jira.baseUrl}/rest/api/3/issue`;
  const fetchFn = deps?.fetch ?? globalThis.fetch;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: config.jira.project },
        summary: opts.title,
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: opts.body || opts.title }],
            },
          ],
        },
        issuetype: { name: "Task" },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`capture: Jira API error ${res.status}: ${text}`);
    Deno.exit(1);
  }
  const data = (await res.json()) as { key: string };
  console.log(`${config.jira.baseUrl}/browse/${data.key}`);
}

export const capture: Command = {
  name: "capture",
  description: "create a ticket in the configured provider",
  usage:
    "--title <title> --scope <org/repo|project-key> [--body <text>] [--artifact code|document|work]",
  async run(args) {
    const flags = parseFlags(args);
    if (!flags.title || !flags.scope) {
      console.error(
        "Usage: lazyboy capture --title <title> --scope <org/repo|project-key> [--body <text>] [--artifact code|document|work]",
      );
      Deno.exit(1);
    }
    await performCapture({
      title: flags.title,
      scope: flags.scope,
      body: flags.body ?? "",
      artifact: flags.artifact ?? "code",
    });
  },
};
