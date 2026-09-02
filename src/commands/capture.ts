import { loadConfig as defaultLoadConfig } from "../config.ts";
import type { Config } from "../state/types.ts";
import type { Command } from "./types.ts";

export function inferProvider(scope: string): "github" | "jira" {
  return scope.includes("/") ? "github" : "jira";
}

export function collectScopes(config: Config): string[] {
  const scopes = [...config.github.repos];
  if (config.jira) {
    scopes.push(...Object.values(config.jira).map((e) => e.project));
  }
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

type GhRunner = (
  opts: { args: string[]; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string }>;

export async function performCapture(
  opts: { title: string; scope: string; body: string; artifact: string },
  deps?: {
    loadConfig?: () => Promise<Config>;
    runGh?: GhRunner;
    fetch?: typeof globalThis.fetch;
  },
): Promise<number> {
  const config = await (deps?.loadConfig ?? defaultLoadConfig)();
  const validScopes = collectScopes(config);
  const scopeError = validateScope(opts.scope, validScopes);
  if (scopeError) {
    throw new Error(scopeError);
  }

  const provider = inferProvider(opts.scope);

  if (provider === "github") {
    const org = opts.scope.split("/")[0];
    const env: Record<string, string> = { ...Deno.env.toObject() };
    if (config.github.accounts && config.github.orgs) {
      const accountName = config.github.orgs[org];
      if (accountName) {
        const account = config.github.accounts[accountName];
        if (account) {
          const token = Deno.env.get(account.tokenEnv);
          if (token) env["GH_TOKEN"] = token;
        }
      }
    }
    const runGh: GhRunner = deps?.runGh ?? (async ({ args, env: e }) => {
      const result = await new Deno.Command("gh", {
        args,
        env: e,
        stdout: "piped",
        stderr: "inherit",
      }).output();
      return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout).trim(),
      };
    });
    const { code, stdout } = await runGh({
      args: [
        "issue",
        "create",
        "--repo",
        opts.scope,
        "--title",
        opts.title,
        "--assignee",
        "@me",
        "--body",
        opts.body,
      ],
      env,
    });
    if (code !== 0) return code;
    console.log(stdout);
    return 0;
  }

  if (!config.jira) {
    throw new Error("capture: Jira is not configured");
  }
  const jiraEntry = Object.values(config.jira).find(
    (e) => e.project === opts.scope,
  );
  if (!jiraEntry) {
    throw new Error("capture: unknown Jira project");
  }
  const email = Deno.env.get("JIRA_EMAIL");
  const apiToken = Deno.env.get("JIRA_API_TOKEN");
  if (!email || !apiToken) {
    throw new Error("capture: JIRA_EMAIL and JIRA_API_TOKEN must be set");
  }
  const auth = btoa(`${email}:${apiToken}`);
  const fetchFn = deps?.fetch ?? globalThis.fetch;

  let accountId: string | undefined;
  try {
    const myselfRes = await fetchFn(
      `${jiraEntry.baseUrl}/rest/api/3/myself`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      },
    );
    if (myselfRes.ok) {
      const myselfData = (await myselfRes.json()) as { accountId: string };
      accountId = myselfData.accountId;
    } else {
      console.error(
        `capture: could not fetch Jira current user (${myselfRes.status}); issue will be unassigned`,
      );
    }
  } catch {
    console.error(
      "capture: could not fetch Jira current user; issue will be unassigned",
    );
  }

  const url = `${jiraEntry.baseUrl}/rest/api/3/issue`;
  const fields: Record<string, unknown> = {
    project: { key: jiraEntry.project },
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
  };
  if (accountId) {
    fields.assignee = { accountId };
  }
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`capture: Jira API error ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { key: string };
  console.log(`${jiraEntry.baseUrl}/browse/${data.key}`);
  return 0;
}

export const capture: Command = {
  name: "capture",
  description: "create a ticket in the configured provider",
  usage:
    "ur capture --title <title> --scope <org/repo|project-key> [--body <text>] [--artifact code|document|work]",
  async run(args) {
    const flags = parseFlags(args);
    if (!flags.title || !flags.scope) {
      console.error(
        "Usage: ur capture --title <title> --scope <org/repo|project-key> [--body <text>] [--artifact code|document|work]",
      );
      Deno.exit(1);
    }
    try {
      const code = await performCapture({
        title: flags.title,
        scope: flags.scope,
        body: flags.body ?? "",
        artifact: flags.artifact ?? "code",
      });
      Deno.exit(code);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
};
