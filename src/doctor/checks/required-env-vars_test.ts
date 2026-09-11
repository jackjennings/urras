import { assertEquals, assertStringIncludes } from "@std/assert";
import { requiredEnvVarsCheck } from "./required-env-vars.ts";
import type { Config } from "../../state/types.ts";

function makeConfig(
  accounts?: Record<string, { tokenEnv: string; login: string }>,
): Config {
  return {
    github: { repos: [], accounts },
    state: { dir: "/state" },
    extensions: { dir: "/ext" },
    tick: {
      concurrency: 1,
      resolveCIFailures: true,
      principles: true,
      agentsMdMaxTokens: 0,
      maxTurns: 50,
    },
    codebase: { roots: [] },
    pi: { provider: "anthropic", packages: [] },
    agent: { type: "pi" },
  };
}

Deno.test("requiredEnvVarsCheck: all vars set → pass", async () => {
  const result = await requiredEnvVarsCheck({
    getEnv: (name) => {
      if (name === "ANTHROPIC_API_KEY") return "sk-key";
      if (name === "GITHUB_TOKEN_WORK") return "ghp_work";
      return undefined;
    },
    config: makeConfig({
      work: { tokenEnv: "GITHUB_TOKEN_WORK", login: "user" },
    }),
  }).run();
  assertEquals(result.status, "pass");
});

Deno.test("requiredEnvVarsCheck: ANTHROPIC_API_KEY missing → fail", async () => {
  const result = await requiredEnvVarsCheck({
    getEnv: () => undefined,
    config: makeConfig(),
  }).run();
  assertEquals(result.status, "fail");
  assertStringIncludes(result.detail, "ANTHROPIC_API_KEY");
});

Deno.test(
  "requiredEnvVarsCheck: account token env missing → fail",
  async () => {
    const result = await requiredEnvVarsCheck({
      getEnv: (name) => name === "ANTHROPIC_API_KEY" ? "sk" : undefined,
      config: makeConfig({
        personal: { tokenEnv: "GITHUB_TOKEN_PERSONAL", login: "user" },
      }),
    }).run();
    assertEquals(result.status, "fail");
    assertStringIncludes(result.detail, "GITHUB_TOKEN_PERSONAL");
  },
);

Deno.test(
  "requiredEnvVarsCheck: empty string treated as unset → fail",
  async () => {
    const result = await requiredEnvVarsCheck({
      getEnv: () => "",
      config: makeConfig(),
    }).run();
    assertEquals(result.status, "fail");
  },
);

Deno.test(
  "requiredEnvVarsCheck: agent.type claude-code, ANTHROPIC_API_KEY unset → pass",
  async () => {
    const result = await requiredEnvVarsCheck({
      getEnv: () => undefined,
      config: { ...makeConfig(), agent: { type: "claude-code" } },
    }).run();
    assertEquals(result.status, "pass");
  },
);
