import { assertEquals, assertStringIncludes } from "@std/assert";
import { collectScopes, inferProvider, validateScope } from "./capture.ts";
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

Deno.test("collectScopes: github + jira appends project key", () => {
  const config: Config = {
    ...baseConfig,
    jira: { baseUrl: "https://example.atlassian.net", project: "MYPROJ" },
  };
  assertEquals(collectScopes(config), ["org/alpha", "org/beta", "MYPROJ"]);
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
