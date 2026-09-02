import {
  assertArrayIncludes,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  collectScopes,
  inferProvider,
  performCapture,
  validateScope,
} from "./capture.ts";
import type { Config } from "../state/types.ts";

const baseConfig: Config = {
  github: { repos: ["org/alpha", "org/beta"] },
  state: { dir: "~/projects" },
  extensions: { dir: "~/.lazyboy/extensions" },
  tick: {
    concurrency: 1,
    resolveCIFailures: true,
    principles: true,
    agentsMdMaxTokens: 1000,
    maxTurns: 10,
  },
  codebase: { roots: [] },
  pi: { provider: "anthropic", packages: [] },
  agent: { type: "pi" },
};

Deno.test("inferProvider: org/repo returns github", () => {
  assertEquals(inferProvider("org/repo"), "github");
});

Deno.test("inferProvider: bare project key returns jira", () => {
  assertEquals(inferProvider("PROJ"), "jira");
});

Deno.test("collectScopes: github repos only", () => {
  assertEquals(collectScopes(baseConfig), ["org/alpha", "org/beta"]);
});

Deno.test("collectScopes: github + jira appends project keys", () => {
  const config: Config = {
    ...baseConfig,
    jira: {
      nw: { baseUrl: "https://nw.atlassian.net", project: "NW" },
      acme: { baseUrl: "https://acme.atlassian.net", project: "ACME" },
    },
  };
  const scopes = collectScopes(config);
  assertArrayIncludes(scopes, ["org/alpha", "org/beta", "NW", "ACME"]);
});

Deno.test("validateScope: known scope returns null", () => {
  assertEquals(validateScope("org/alpha", ["org/alpha", "org/beta"]), null);
});

Deno.test("validateScope: unknown scope returns error listing valid scopes", () => {
  const result = validateScope("org/unknown", ["org/alpha", "org/beta"]);
  assertStringIncludes(result!, "org/unknown");
  assertStringIncludes(result!, "org/alpha");
  assertStringIncludes(result!, "org/beta");
});

Deno.test("validateScope: jira project key matches exactly", () => {
  assertEquals(validateScope("MYPROJ", ["org/alpha", "MYPROJ"]), null);
});

Deno.test("performCapture: calls gh with --assignee @me", async () => {
  const calls: string[][] = [];
  const config: Config = {
    ...baseConfig,
    agent: { type: "claude-code" },
    github: { repos: ["org/repo"] },
  };
  await performCapture(
    { title: "test", scope: "org/repo", body: "", artifact: "code" },
    {
      loadConfig: () => Promise.resolve(config),
      runGh: ({ args }) => {
        calls.push(args);
        return Promise.resolve({
          code: 0,
          stdout: "https://github.com/org/repo/issues/1",
        });
      },
    },
  );
  assertArrayIncludes(calls[0], ["--assignee", "@me"]);
});

Deno.test("performCapture: uses matching jira project entry by scope", async () => {
  const fetchCalls: string[] = [];
  const config: Config = {
    ...baseConfig,
    jira: {
      nw: { baseUrl: "https://nw.atlassian.net", project: "NW" },
      acme: { baseUrl: "https://acme.atlassian.net", project: "ACME" },
    },
  };
  await performCapture(
    { title: "test issue", scope: "NW", body: "", artifact: "code" },
    {
      loadConfig: () => Promise.resolve(config),
      jiraEmail: "test@example.com",
      jiraApiToken: "test-token",
      fetch: (url) => {
        fetchCalls.push(url as string);
        if ((url as string).includes("/myself")) {
          return Promise.resolve(
            new Response(JSON.stringify({ accountId: "user1" }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ key: "NW-1" }), { status: 200 }),
        );
      },
    },
  );
  assertStringIncludes(fetchCalls[0], "nw.atlassian.net");
});

Deno.test("performCapture: throws on unknown scope", async () => {
  const config: Config = {
    ...baseConfig,
    github: { repos: ["org/alpha"] },
  };
  await assertRejects(
    () =>
      performCapture(
        { title: "t", scope: "org/unknown", body: "", artifact: "code" },
        { loadConfig: () => Promise.resolve(config) },
      ),
    Error,
    "org/unknown",
  );
});
