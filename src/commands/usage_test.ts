import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  aggregateAncillaryUsage,
  aggregateUsage,
  formatAncillaryUsageOutput,
  formatUsageOutput,
  usage,
} from "./usage.ts";
import type { AncillaryUsageRecord } from "../ancillary-usage.ts";
import type { PhaseUsage } from "../state/types.ts";

function makeUsage({
  model,
  input,
  output,
  cacheRead,
  cacheWrite,
  costUsd,
  tools,
}: {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  tools?: Record<string, number>;
}): PhaseUsage {
  return {
    durationMs: 0,
    ...(tools !== undefined ? { tools } : {}),
    models: [{
      model,
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(costUsd !== undefined ? { costUsd } : {}),
    }],
  };
}

// ── aggregateUsage ─────────────────────────────────────────────────────────────

Deno.test("aggregateUsage: returns empty map for empty input", () => {
  assertEquals(aggregateUsage([]).size, 0);
});

Deno.test("aggregateUsage: strips date suffix from model name", () => {
  const result = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5-20251001",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  assert(result.has("claude-haiku-4-5"));
  assertFalse(result.has("claude-haiku-4-5-20251001"));
});

Deno.test("aggregateUsage: groups by stripped model name and sums token fields", () => {
  const result = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5-20251001",
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 50,
    }),
    makeUsage({
      model: "claude-haiku-4-5-20260101",
      input: 20,
      output: 8,
      cacheRead: 200,
      cacheWrite: 30,
    }),
  ]);
  assertEquals(result.size, 1);
  const g = result.get("claude-haiku-4-5")!;
  assertEquals(g.input, 30);
  assertEquals(g.output, 13);
  assertEquals(g.cacheRead, 300);
  assertEquals(g.cacheWrite, 80);
});

Deno.test("aggregateUsage: tracks costCount — none have cost", () => {
  const result = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  const g = result.get("claude-haiku-4-5")!;
  assertEquals(g.count, 1);
  assertEquals(g.costCount, 0);
});

Deno.test("aggregateUsage: tracks costCount — all have cost", () => {
  const result = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.50,
    }),
    makeUsage({
      model: "claude-haiku-4-5",
      input: 2,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.75,
    }),
  ]);
  const g = result.get("claude-haiku-4-5")!;
  assertEquals(g.count, 2);
  assertEquals(g.costCount, 2);
  assertEquals(g.cost, 1.25);
});

Deno.test("aggregateUsage: tracks costCount — some have cost", () => {
  const result = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.50,
    }),
    makeUsage({
      model: "claude-haiku-4-5",
      input: 2,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  const g = result.get("claude-haiku-4-5")!;
  assertEquals(g.count, 2);
  assertEquals(g.costCount, 1);
});

Deno.test("aggregateUsage: sums tool counts across records for the same tool name", () => {
  const result = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      tools: { read: 10 },
    }),
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      tools: { read: 5, bash: 2 },
    }),
  ]);
  const g = result.get("claude-haiku-4-5")!;
  assertEquals(g.tools, { read: 15, bash: 2 });
});

Deno.test("aggregateUsage: records without tools contribute nothing to tool counts", () => {
  const result = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      tools: { read: 3 },
    }),
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  const g = result.get("claude-haiku-4-5")!;
  assertEquals(g.tools, { read: 3 });
});

Deno.test("aggregateUsage: initializes tools to empty object when no record has tools", () => {
  const result = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  const g = result.get("claude-haiku-4-5")!;
  assertEquals(g.tools, {});
});

Deno.test("aggregateUsage: two-model record sums tokens per model separately", () => {
  const result = aggregateUsage([{
    durationMs: 0,
    models: [
      {
        model: "claude-haiku-4-5",
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
      },
      {
        model: "claude-sonnet-4-6",
        input: 100,
        output: 50,
        cacheRead: 1000,
        cacheWrite: 0,
      },
    ],
  }]);
  assertEquals(result.size, 2);
  const haiku = result.get("claude-haiku-4-5")!;
  assertEquals(haiku.input, 10);
  assertEquals(haiku.output, 5);
  const sonnet = result.get("claude-sonnet-4-6")!;
  assertEquals(sonnet.input, 100);
  assertEquals(sonnet.output, 50);
  assertEquals(sonnet.cacheRead, 1000);
});

Deno.test(
  "aggregateUsage: tools attributed to primary model (highest input+output)",
  () => {
    const result = aggregateUsage([{
      durationMs: 0,
      tools: { read: 5, bash: 2 },
      models: [
        {
          model: "claude-haiku-4-5",
          input: 5,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          model: "claude-sonnet-4-6",
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
    }]);
    const haiku = result.get("claude-haiku-4-5")!;
    const sonnet = result.get("claude-sonnet-4-6")!;
    assertEquals(haiku.tools, {});
    assertEquals(sonnet.tools, { read: 5, bash: 2 });
  },
);

// ── formatUsageOutput ──────────────────────────────────────────────────────────

Deno.test("formatUsageOutput: empty state line when no groups", () => {
  assertEquals(formatUsageOutput(new Map()), "Total cost:  —");
});

Deno.test("formatUsageOutput: em-dash total cost when no records have cost", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 541,
      output: 23,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  assertStringIncludes(formatUsageOutput(groups).split("\n")[0], "—");
});

Deno.test("formatUsageOutput: exact total cost when all records have cost", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 541,
      output: 23,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 8.71,
    }),
  ]);
  const line0 = formatUsageOutput(groups).split("\n")[0];
  assertStringIncludes(line0, "$8.71");
  assertFalse(line0.includes("~"));
});

Deno.test("formatUsageOutput: tilde total cost when some records have cost", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 1.00,
    }),
    makeUsage({
      model: "claude-opus-4-8",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  assertStringIncludes(formatUsageOutput(groups).split("\n")[0], "~$1.00");
});

Deno.test("formatUsageOutput: aligns value column at max name length + 7", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5-20251001",
      input: 541,
      output: 23,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.50,
    }),
    makeUsage({
      model: "claude-opus-4-8-20261001",
      input: 86,
      output: 90900,
      cacheRead: 2200000,
      cacheWrite: 853600,
      costUsd: 8.21,
    }),
  ]);
  const lines = formatUsageOutput(groups).split("\n");
  assertEquals(lines[0], "Total cost:            $8.71");
});

Deno.test("formatUsageOutput: right-aligns shorter model names within max width", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5-20251001",
      input: 541,
      output: 23,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.50,
    }),
    makeUsage({
      model: "claude-opus-4-8-20261001",
      input: 86,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 8.21,
    }),
  ]);
  const lines = formatUsageOutput(groups).split("\n");
  assertStringIncludes(lines[2], "    claude-haiku-4-5:  ");
  assertStringIncludes(lines[3], "     claude-opus-4-8:  ");
});

Deno.test("formatUsageOutput: sorts models alphabetically", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-opus-4-8",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  const lines = formatUsageOutput(groups).split("\n");
  assertStringIncludes(lines[2], "claude-haiku-4-5");
  assertStringIncludes(lines[3], "claude-opus-4-8");
});

Deno.test("formatUsageOutput: exact per-model cost when all records have cost", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 1.23,
    }),
  ]);
  assertStringIncludes(formatUsageOutput(groups), "($1.23)");
});

Deno.test("formatUsageOutput: tilde per-model cost when some records lack cost", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 1.23,
    }),
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  assertStringIncludes(formatUsageOutput(groups), "(~$1.23)");
});

Deno.test("formatUsageOutput: em-dash per-model cost when no records have cost", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  assertStringIncludes(formatUsageOutput(groups), "(—)");
});

Deno.test("formatUsageOutput: m suffix for million-range token counts", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-opus-4-8",
      input: 0,
      output: 0,
      cacheRead: 2_200_000,
      cacheWrite: 0,
    }),
  ]);
  assertStringIncludes(formatUsageOutput(groups), "2.2m cache read");
});

Deno.test("formatUsageOutput: appends Tool usage section when tools are present", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      tools: { read: 10, bash: 2, write: 1 },
    }),
  ]);
  assertStringIncludes(
    formatUsageOutput(groups),
    "Tool usage:\n    bash: 2\n    read: 10\n    write: 1",
  );
});

Deno.test("formatUsageOutput: omits Tool usage section when no records have tools", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ]);
  assertFalse(formatUsageOutput(groups).includes("Tool usage:"));
});

Deno.test("formatUsageOutput: sums tools cross-model in Tool usage section", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      tools: { read: 10 },
    }),
    makeUsage({
      model: "claude-opus-4-8",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      tools: { read: 5, bash: 2 },
    }),
  ]);
  const output = formatUsageOutput(groups);
  assertStringIncludes(output, "    bash: 2");
  assertStringIncludes(output, "    read: 15");
});

Deno.test("formatUsageOutput: existing sections are unchanged when tools are present", () => {
  const groups = aggregateUsage([
    makeUsage({
      model: "claude-haiku-4-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 1.23,
      tools: { read: 5 },
    }),
  ]);
  const lines = formatUsageOutput(groups).split("\n");
  assertStringIncludes(lines[0], "$1.23");
  assertEquals(lines[1], "Usage by model:");
});

// ── aggregateAncillaryUsage ───────────────────────────────────────────────────

function makeAncillary(
  opts: Partial<AncillaryUsageRecord> & {
    callSite: string;
    adapter: "apfel" | "ollama" | "claude";
    model: string;
  },
): AncillaryUsageRecord {
  return {
    ts: "2026-01-01T00:00:00Z",
    ...opts,
  };
}

Deno.test("aggregateAncillaryUsage: returns empty map for empty input", () => {
  assertEquals(aggregateAncillaryUsage([]).size, 0);
});

Deno.test("aggregateAncillaryUsage: groups by callSite and model", () => {
  const result = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "judgePrinciples",
      adapter: "apfel",
      model: "apfel",
      input: 10,
      output: 5,
      estimated: true,
    }),
    makeAncillary({
      callSite: "judgePrinciples",
      adapter: "claude",
      model: "claude-haiku-4-5",
      input: 100,
      output: 20,
      cost: 0.01,
    }),
  ]);
  assertEquals(result.size, 1);
  const siteGroup = result.get("judgePrinciples")!;
  assertEquals(siteGroup.size, 2);
  assertEquals(siteGroup.get("apfel")!.input, 10);
  assertEquals(siteGroup.get("claude-haiku-4-5")!.cost, 0.01);
});

Deno.test("aggregateAncillaryUsage: sums tokens and counts across multiple records for same model", () => {
  const result = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "judgeComment",
      adapter: "apfel",
      model: "apfel",
      input: 5,
      output: 2,
      estimated: true,
    }),
    makeAncillary({
      callSite: "judgeComment",
      adapter: "apfel",
      model: "apfel",
      input: 8,
      output: 3,
      estimated: true,
    }),
  ]);
  const g = result.get("judgeComment")!.get("apfel")!;
  assertEquals(g.input, 13);
  assertEquals(g.output, 5);
  assertEquals(g.count, 2);
  assertEquals(g.estimated, true);
});

Deno.test("aggregateAncillaryUsage: estimated true when any record has estimated", () => {
  const result = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "test",
      adapter: "claude",
      model: "claude-haiku-4-5",
      input: 10,
      output: 5,
    }),
    makeAncillary({
      callSite: "test",
      adapter: "apfel",
      model: "apfel",
      estimated: true,
    }),
  ]);
  assertFalse(result.get("test")!.get("claude-haiku-4-5")!.estimated);
  assert(result.get("test")!.get("apfel")!.estimated);
});

Deno.test("aggregateAncillaryUsage: tracks costCount correctly", () => {
  const result = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "applyLearning",
      adapter: "claude",
      model: "claude-sonnet-4-6",
      cost: 0.05,
    }),
    makeAncillary({
      callSite: "applyLearning",
      adapter: "claude",
      model: "claude-sonnet-4-6",
    }),
  ]);
  const g = result.get("applyLearning")!.get("claude-sonnet-4-6")!;
  assertEquals(g.count, 2);
  assertEquals(g.costCount, 1);
  assertEquals(g.cost, 0.05);
});

// ── formatAncillaryUsageOutput ────────────────────────────────────────────────

Deno.test("formatAncillaryUsageOutput: returns null for empty groups", () => {
  assertEquals(formatAncillaryUsageOutput(new Map()), null);
});

Deno.test("formatAncillaryUsageOutput: includes Ancillary usage header", () => {
  const groups = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "judgePrinciples",
      adapter: "apfel",
      model: "apfel",
      input: 100,
      output: 50,
      estimated: true,
    }),
  ]);
  const output = formatAncillaryUsageOutput(groups)!;
  assertStringIncludes(output, "Ancillary usage:");
});

Deno.test("formatAncillaryUsageOutput: prefixes token counts with ~ when estimated", () => {
  const groups = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "judgePrinciples",
      adapter: "apfel",
      model: "apfel",
      input: 100,
      output: 50,
      estimated: true,
    }),
  ]);
  const output = formatAncillaryUsageOutput(groups)!;
  assertStringIncludes(output, "~100 input");
  assertStringIncludes(output, "~50 output");
});

Deno.test("formatAncillaryUsageOutput: no tilde prefix when not estimated", () => {
  const groups = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "applyLearning",
      adapter: "claude",
      model: "claude-sonnet-4-6",
      input: 100,
      output: 50,
      cost: 0.01,
    }),
  ]);
  const output = formatAncillaryUsageOutput(groups)!;
  assertStringIncludes(output, "100 input");
  assertFalse(output.includes("~100"));
});

Deno.test("formatAncillaryUsageOutput: shows exact cost when all records have cost", () => {
  const groups = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "applyLearning",
      adapter: "claude",
      model: "claude-sonnet-4-6",
      input: 100,
      output: 50,
      cost: 0.05,
    }),
  ]);
  const output = formatAncillaryUsageOutput(groups)!;
  assertStringIncludes(output, "($0.05)");
  assertFalse(output.includes("~$0.05"));
});

Deno.test("formatAncillaryUsageOutput: shows approximate cost when some records lack cost", () => {
  const groups = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "applyLearning",
      adapter: "claude",
      model: "claude-sonnet-4-6",
      cost: 0.05,
    }),
    makeAncillary({
      callSite: "applyLearning",
      adapter: "claude",
      model: "claude-sonnet-4-6",
    }),
  ]);
  const output = formatAncillaryUsageOutput(groups)!;
  assertStringIncludes(output, "(~$0.05)");
});

Deno.test("formatAncillaryUsageOutput: omits cost when no records have cost", () => {
  const groups = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "judgeComment",
      adapter: "ollama",
      model: "qwen2.5:7b",
      input: 42,
      output: 18,
    }),
  ]);
  const output = formatAncillaryUsageOutput(groups)!;
  assertFalse(output.includes("$"));
});

Deno.test("formatAncillaryUsageOutput: sorts callSites alphabetically", () => {
  const groups = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "judgePrinciples",
      adapter: "apfel",
      model: "apfel",
    }),
    makeAncillary({
      callSite: "applyLearning",
      adapter: "claude",
      model: "claude-sonnet-4-6",
    }),
  ]);
  const output = formatAncillaryUsageOutput(groups)!;
  const applyIdx = output.indexOf("applyLearning");
  const judgeIdx = output.indexOf("judgePrinciples");
  assert(applyIdx < judgeIdx);
});

Deno.test("formatAncillaryUsageOutput: shows singular call for count of 1", () => {
  const groups = aggregateAncillaryUsage([
    makeAncillary({
      callSite: "test",
      adapter: "apfel",
      model: "apfel",
    }),
  ]);
  const output = formatAncillaryUsageOutput(groups)!;
  assertStringIncludes(output, "(1 call)");
  assertFalse(output.includes("(1 calls)"));
});

Deno.test("formatAncillaryUsageOutput: shows plural calls for count > 1", () => {
  const groups = aggregateAncillaryUsage([
    makeAncillary({ callSite: "test", adapter: "apfel", model: "apfel" }),
    makeAncillary({ callSite: "test", adapter: "apfel", model: "apfel" }),
  ]);
  const output = formatAncillaryUsageOutput(groups)!;
  assertStringIncludes(output, "(2 calls)");
});

// ── usage command ─────────────────────────────────────────────────────────────

Deno.test("usage command name is 'usage'", () => {
  assertEquals(usage.name, "usage");
});

Deno.test("usage command reads usage files from all ticket directories", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "a", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(ticketDir, "20260715T190000-intake.usage.json"),
      JSON.stringify(
        makeUsage({
          model: "claude-haiku-4-5-20251001",
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0.01,
        }),
      ),
    );

    const originalEnv = Deno.env.get("HOME");
    const fakeHome = await Deno.makeTempDir();
    Deno.env.set("HOME", fakeHome);
    const configDir = join(fakeHome, ".config", "urras");
    await Deno.mkdir(configDir, { recursive: true });
    await Deno.writeTextFile(
      join(configDir, "config.toml"),
      `[github]\nrepos = []\n\n[state]\ndir = "${stateDir}"\n`,
    );

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => lines.push(s);
    try {
      await usage.run([]);
    } finally {
      console.log = origLog;
      if (originalEnv !== undefined) Deno.env.set("HOME", originalEnv);
      else Deno.env.delete("HOME");
      await Deno.remove(fakeHome, { recursive: true });
    }
    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0], "claude-haiku-4-5");
    assertStringIncludes(lines[0], "$0.01");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
