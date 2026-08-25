import { assertRejects, assertStringIncludes } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { buildSystemPrompt, performBrainstorm } from "./brainstorm.ts";
import type { Config } from "../state/types.ts";

const baseConfig: Config = {
  github: { repos: ["org/my-repo"] },
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
  agent: { type: "claude-code" },
};

Deno.test("buildSystemPrompt: includes scope", () => {
  const prompt = buildSystemPrompt({
    scope: "org/my-repo",
    provider: "github",
  });
  assertStringIncludes(prompt, "org/my-repo");
});

Deno.test("buildSystemPrompt: includes ur capture with correct scope flag", () => {
  const prompt = buildSystemPrompt({
    scope: "org/my-repo",
    provider: "github",
  });
  assertStringIncludes(prompt, "ur capture");
  assertStringIncludes(prompt, "--scope org/my-repo");
});

Deno.test("buildSystemPrompt: mentions GitHub for github provider", () => {
  const prompt = buildSystemPrompt({
    scope: "org/my-repo",
    provider: "github",
  });
  assertStringIncludes(prompt, "GitHub");
});

Deno.test("buildSystemPrompt: mentions Jira for jira provider", () => {
  const prompt = buildSystemPrompt({ scope: "PROJ", provider: "jira" });
  assertStringIncludes(prompt, "Jira");
  assertStringIncludes(prompt, "PROJ");
});

Deno.test("buildSystemPrompt: includes initial idea when provided", () => {
  const prompt = buildSystemPrompt({
    scope: "org/my-repo",
    provider: "github",
    initialIdea: "add retry logic to webhooks",
  });
  assertStringIncludes(prompt, "add retry logic to webhooks");
});

Deno.test("buildSystemPrompt: includes body format guidance", () => {
  const prompt = buildSystemPrompt({
    scope: "org/my-repo",
    provider: "github",
  });
  assertStringIncludes(prompt, "## Problem");
  assertStringIncludes(prompt, "## Proposed Solution");
});

Deno.test("performBrainstorm: throws for non-claude-code agent type", async () => {
  const config: Config = { ...baseConfig, agent: { type: "pi" } };
  await assertRejects(
    () =>
      performBrainstorm(
        {},
        { loadConfig: () => Promise.resolve(config) },
      ),
    Error,
    'agent type "pi"',
  );
});

Deno.test("performBrainstorm: throws when no scopes configured", async () => {
  const config: Config = {
    ...baseConfig,
    github: { repos: [] },
  };
  await assertRejects(
    () =>
      performBrainstorm(
        {},
        { loadConfig: () => Promise.resolve(config) },
      ),
    Error,
    "no scopes configured",
  );
});

Deno.test("performBrainstorm: auto-selects single scope and passes it to spawn", async () => {
  let capturedPrompt = "";
  const spawnSpy = spy((_prompt: string) => {
    capturedPrompt = _prompt;
    return Promise.resolve(0);
  });
  await performBrainstorm(
    {},
    {
      loadConfig: () => Promise.resolve(baseConfig),
      spawn: spawnSpy,
    },
  );
  assertSpyCalls(spawnSpy, 1);
  assertStringIncludes(capturedPrompt, "org/my-repo");
});

Deno.test("performBrainstorm: throws on stdin EOF during scope selection", async () => {
  const config: Config = {
    ...baseConfig,
    github: { repos: ["org/a", "org/b"] },
  };
  await assertRejects(
    () =>
      performBrainstorm(
        {},
        {
          loadConfig: () => Promise.resolve(config),
          prompt: () => Promise.resolve(null),
          spawn: () => Promise.resolve(0),
        },
      ),
    Error,
    "stdin closed",
  );
});
