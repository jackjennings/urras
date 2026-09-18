import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type AncillaryUsageRecord,
  appendAncillaryUsage,
  readAncillaryUsageFile,
} from "./ancillary-usage.ts";
import { withUrrasDir } from "./test-support.ts";

Deno.test("appendAncillaryUsage: writes record as NDJSON with callSite to ancillary-usage.ndjson", async () => {
  using dir = withUrrasDir();
  await appendAncillaryUsage("test")({
    ts: "2026-01-01T00:00:00Z",
    adapter: "claude",
    model: "claude-haiku-4-5",
    input: 10,
    output: 5,
    cost: 0.01,
  });
  const content = await Deno.readTextFile(
    join(dir.path, "ancillary-usage.ndjson"),
  );
  const expected: AncillaryUsageRecord = {
    ts: "2026-01-01T00:00:00Z",
    adapter: "claude",
    model: "claude-haiku-4-5",
    input: 10,
    output: 5,
    cost: 0.01,
    callSite: "test",
  };
  assertEquals(JSON.parse(content.trim()), expected);
});

Deno.test("appendAncillaryUsage: appends multiple records as separate lines", async () => {
  using dir = withUrrasDir();
  await appendAncillaryUsage("judgePrinciples")({
    ts: "2026-01-01T00:00:00Z",
    adapter: "apfel",
    model: "apfel",
    input: 5,
    output: 2,
    estimated: true,
  });
  await appendAncillaryUsage("applyLearning")({
    ts: "2026-01-01T00:01:00Z",
    adapter: "claude",
    model: "claude-sonnet-4-6",
    input: 100,
    output: 50,
    cost: 0.05,
  });
  const content = await Deno.readTextFile(
    join(dir.path, "ancillary-usage.ndjson"),
  );
  const lines = content.trim().split("\n");
  assertEquals(lines.length, 2);
  const r1: AncillaryUsageRecord = {
    ts: "2026-01-01T00:00:00Z",
    adapter: "apfel",
    model: "apfel",
    input: 5,
    output: 2,
    estimated: true,
    callSite: "judgePrinciples",
  };
  const r2: AncillaryUsageRecord = {
    ts: "2026-01-01T00:01:00Z",
    adapter: "claude",
    model: "claude-sonnet-4-6",
    input: 100,
    output: 50,
    cost: 0.05,
    callSite: "applyLearning",
  };
  assertEquals(JSON.parse(lines[0]), r1);
  assertEquals(JSON.parse(lines[1]), r2);
});

Deno.test("readAncillaryUsageFile: returns empty array when file does not exist", async () => {
  using _dir = withUrrasDir();
  const records = await readAncillaryUsageFile();
  assertEquals(records, []);
});

Deno.test("readAncillaryUsageFile: returns parsed records from file", async () => {
  using dir = withUrrasDir();
  const record: AncillaryUsageRecord = {
    ts: "2026-01-01T00:00:00Z",
    callSite: "judgeComment",
    adapter: "ollama",
    model: "qwen2.5:7b",
    input: 42,
    output: 18,
  };
  await Deno.writeTextFile(
    join(dir.path, "ancillary-usage.ndjson"),
    JSON.stringify(record) + "\n",
  );
  const records = await readAncillaryUsageFile();
  assertEquals(records.length, 1);
  assertEquals(records[0], record);
});
