import { assertEquals } from "@std/assert";
import { PHASE_MODEL_DEFAULTS, resolvePhaseModel } from "./model.ts";
import type { Config } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    github: { repos: [] },
    state: { dir: "" },
    extensions: { dir: "" },
    tick: {
      concurrency: 1,
      resolveCIFailures: true,
      principles: true,
      agentsMdMaxTokens: 8000,
      maxTurns: 100,
    },
    codebase: { roots: [] },
    pi: { provider: "anthropic", packages: [] },
    agent: { type: "pi" },
    ...overrides,
  };
}

Deno.test("resolvePhaseModel: returns hardcoded defaults when no overrides", () => {
  const config = makeConfig();
  const ticket = makeTicket();
  assertEquals(resolvePhaseModel(config, "intake", ticket), {
    model: "claude-haiku-4-5",
    thinking: "off",
  });
  assertEquals(resolvePhaseModel(config, "spec", ticket), {
    model: "claude-sonnet-4-6",
    thinking: "high",
  });
  assertEquals(resolvePhaseModel(config, "conflict-resolution", ticket), {
    model: "claude-opus-4-7",
    thinking: "high",
  });
});

Deno.test("resolvePhaseModel: ci-fix defaults to claude-sonnet-4-6 / high", () => {
  const config = makeConfig();
  const ticket = makeTicket();
  assertEquals(resolvePhaseModel(config, "ci-fix", ticket), {
    model: "claude-sonnet-4-6",
    thinking: "high",
  });
});

Deno.test("resolvePhaseModel: config default overrides hardcoded for ci-fix", () => {
  const config = makeConfig({
    phases: { defaults: { "ci-fix": { model: "claude-haiku-4-5" } } },
  });
  const ticket = makeTicket();
  assertEquals(resolvePhaseModel(config, "ci-fix", ticket), {
    model: "claude-haiku-4-5",
    thinking: "high",
  });
});

Deno.test("resolvePhaseModel: config default overrides hardcoded for conflict-resolution", () => {
  const config = makeConfig({
    phases: {
      defaults: { "conflict-resolution": { model: "claude-sonnet-4-6" } },
    },
  });
  const ticket = makeTicket();
  assertEquals(resolvePhaseModel(config, "conflict-resolution", ticket), {
    model: "claude-sonnet-4-6",
    thinking: "high",
  });
});

Deno.test("resolvePhaseModel: ticket phases override config for conflict-resolution", () => {
  const config = makeConfig({
    phases: {
      defaults: { "conflict-resolution": { model: "claude-sonnet-4-6" } },
    },
  });
  const ticket = makeTicket({
    phases: {
      "conflict-resolution": { model: "claude-haiku-4-5", thinking: "off" },
    },
  });
  assertEquals(resolvePhaseModel(config, "conflict-resolution", ticket), {
    model: "claude-haiku-4-5",
    thinking: "off",
  });
});

Deno.test("resolvePhaseModel: config default overrides hardcoded", () => {
  const config = makeConfig({
    phases: { defaults: { intake: { model: "claude-opus-4-5" } } },
  });
  const ticket = makeTicket();
  assertEquals(resolvePhaseModel(config, "intake", ticket), {
    model: "claude-opus-4-5",
    thinking: "off",
  });
});

Deno.test("resolvePhaseModel: config default sets thinking only", () => {
  const config = makeConfig({
    phases: { defaults: { intake: { thinking: "high" } } },
  });
  const ticket = makeTicket();
  assertEquals(resolvePhaseModel(config, "intake", ticket), {
    model: "claude-haiku-4-5",
    thinking: "high",
  });
});

Deno.test("resolvePhaseModel: ticket phases override config for implementation", () => {
  const config = makeConfig({
    phases: { defaults: { implementation: { model: "claude-haiku-4-5" } } },
  });
  const ticket = makeTicket({
    phases: { implementation: { model: "claude-opus-4-7", thinking: "max" } },
  });
  assertEquals(resolvePhaseModel(config, "implementation", ticket), {
    model: "claude-opus-4-7",
    thinking: "max",
  });
});

Deno.test("resolvePhaseModel: ticket phases override config for any phase", () => {
  const config = makeConfig();
  const ticket = makeTicket({
    phases: { intake: { model: "claude-opus-4-7", thinking: "max" } },
  });
  assertEquals(resolvePhaseModel(config, "intake", ticket), {
    model: "claude-opus-4-7",
    thinking: "max",
  });
});

Deno.test("resolvePhaseModel: ticket phases model-only, thinking from hardcoded", () => {
  const config = makeConfig();
  const ticket = makeTicket({
    phases: { intake: { model: "claude-opus-4-7" } },
  });
  assertEquals(resolvePhaseModel(config, "intake", ticket), {
    model: "claude-opus-4-7",
    thinking: "off",
  });
});

Deno.test("PHASE_MODEL_DEFAULTS: critique entry defaults to claude-sonnet-4-6 with thinking off", () => {
  assertEquals(PHASE_MODEL_DEFAULTS.critique.model, "claude-sonnet-4-6");
  assertEquals(PHASE_MODEL_DEFAULTS.critique.thinking, "off");
});

Deno.test("resolvePhaseModel: critique uses defaults when no overrides are configured", () => {
  const config = makeConfig();
  const ticket = makeTicket();
  const result = resolvePhaseModel(config, "critique", ticket);
  assertEquals(result.model, "claude-sonnet-4-6");
  assertEquals(result.thinking, "off");
});

Deno.test("resolvePhaseModel: critique respects config-level model override", () => {
  const config = makeConfig({
    phases: {
      defaults: { critique: { model: "claude-haiku-4-5", thinking: "low" } },
    },
  });
  const ticket = makeTicket();
  const result = resolvePhaseModel(config, "critique", ticket);
  assertEquals(result.model, "claude-haiku-4-5");
  assertEquals(result.thinking, "low");
});
