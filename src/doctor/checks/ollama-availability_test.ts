import { assertEquals, assertStringIncludes } from "@std/assert";
import { ollamaAvailabilityCheck } from "./ollama-availability.ts";
import type { Config } from "../../state/types.ts";

function makeConfig(ollama?: Config["ollama"]): Config {
  return {
    github: { repos: [] },
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
    ollama,
  };
}

function makeFetch(status: number): typeof fetch {
  return (_url, _init) => Promise.resolve(new Response("", { status }));
}

function makeThrowingFetch(): typeof fetch {
  return (_url, _init) =>
    Promise.reject(new Error("connection refused")) as unknown as Promise<
      Response
    >;
}

Deno.test("ollamaAvailabilityCheck: ollama not configured → pass", async () => {
  const result = await ollamaAvailabilityCheck({
    config: makeConfig(undefined),
    fetch: makeFetch(200),
  }).run();
  assertEquals(result.status, "pass");
});

Deno.test(
  "ollamaAvailabilityCheck: ollama configured and reachable → pass",
  async () => {
    const result = await ollamaAvailabilityCheck({
      config: makeConfig({ models: ["qwen2.5:7b"] }),
      fetch: makeFetch(200),
    }).run();
    assertEquals(result.status, "pass");
  },
);

Deno.test(
  "ollamaAvailabilityCheck: ollama configured but unreachable → fail",
  async () => {
    const result = await ollamaAvailabilityCheck({
      config: makeConfig({ models: ["qwen2.5:7b"] }),
      fetch: makeFetch(503),
    }).run();
    assertEquals(result.status, "fail");
    assertStringIncludes(result.detail, "localhost:11434");
  },
);

Deno.test(
  "ollamaAvailabilityCheck: fetch throws → fail",
  async () => {
    const result = await ollamaAvailabilityCheck({
      config: makeConfig({ models: ["qwen2.5:7b"] }),
      fetch: makeThrowingFetch(),
    }).run();
    assertEquals(result.status, "fail");
  },
);

Deno.test(
  "ollamaAvailabilityCheck: uses configured url in detail",
  async () => {
    const result = await ollamaAvailabilityCheck({
      config: makeConfig({
        models: ["qwen2.5:7b"],
        url: "http://myserver:11434",
      }),
      fetch: makeFetch(503),
    }).run();
    assertStringIncludes(result.detail, "myserver:11434");
  },
);
