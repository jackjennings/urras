import { assertEquals, assertStringIncludes } from "@std/assert";
import plugin from "./no-undeclared-agent-use.ts";

function lint(filename: string, source: string) {
  return Deno.lint.runPlugin(plugin, filename, source);
}

Deno.test("no-undeclared-agent-use: reports spawnPhase import in tick-actions", () => {
  const d = lint(
    "src/tick-actions/bad.ts",
    `import { spawnPhase } from "../executor.ts";`,
  );
  assertEquals(d.length, 1);
  assertStringIncludes(d[0].message, "spawnPhase");
});

Deno.test("no-undeclared-agent-use: reports ClaudeLanguageModel import", () => {
  const d = lint(
    "src/tick-actions/bad.ts",
    `import { ClaudeLanguageModel } from "../models/claude.ts";`,
  );
  assertEquals(d.length, 1);
});

Deno.test("no-undeclared-agent-use: reports buildAncillaryChain import", () => {
  const d = lint(
    "src/tick-actions/bad.ts",
    `import { buildAncillaryChain } from "../models/ancillary-chain.ts";`,
  );
  assertEquals(d.length, 1);
});

Deno.test("no-undeclared-agent-use: reports new Deno.Command with 'claude'", () => {
  const d = lint(
    "src/tick-actions/bad.ts",
    `new Deno.Command("claude", { args: [] });`,
  );
  assertEquals(d.length, 1);
});

Deno.test("no-undeclared-agent-use: reports new Deno.Command with 'pi'", () => {
  const d = lint(
    "src/tick-actions/bad.ts",
    `new Deno.Command("pi", { args: [] });`,
  );
  assertEquals(d.length, 1);
});

Deno.test("no-undeclared-agent-use: no report outside tick-actions", () => {
  const d = lint(
    "src/executor.ts",
    `import { spawnPhase } from "./executor.ts";`,
  );
  assertEquals(d.length, 0);
});

Deno.test("no-undeclared-agent-use: no report for allowed imports in tick-actions", () => {
  const d = lint(
    "src/tick-actions/allowed.ts",
    `import { writeTicket } from "../state/store.ts";`,
  );
  assertEquals(d.length, 0);
});

Deno.test("no-undeclared-agent-use: agent-access.ts itself is exempt", () => {
  const d = lint(
    "src/tick-actions/agent-access.ts",
    `import { spawnPhase } from "../executor.ts";`,
  );
  assertEquals(d.length, 0);
});
