import { assertEquals, assertStringIncludes } from "@std/assert";
import { tickFreshnessCheck } from "./tick-freshness.ts";

const NOW = 1_000_000;

function makeLog(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

function ts(secondsAgo: number): string {
  return new Date((NOW - secondsAgo) * 1000).toISOString();
}

function makeDeps(
  log: string | null,
  overrides: Partial<Parameters<typeof tickFreshnessCheck>[0]> = {},
): Parameters<typeof tickFreshnessCheck>[0] {
  return {
    readTextFile: log === null
      ? () => Promise.reject(new Deno.errors.NotFound())
      : () => Promise.resolve(log),
    urrasDir: "/urras",
    now: () => NOW,
    ...overrides,
  };
}

Deno.test("tickFreshnessCheck: tick.ndjson absent → warn", async () => {
  const result = await tickFreshnessCheck(makeDeps(null)).run();
  assertEquals(result.status, "warn");
});

Deno.test("tickFreshnessCheck: recent tick-start → pass", async () => {
  const log = makeLog([{ ts: ts(100), event: "tick-start" }]);
  const result = await tickFreshnessCheck(makeDeps(log)).run();
  assertEquals(result.status, "pass");
});

Deno.test("tickFreshnessCheck: tick-start >600s ago → warn", async () => {
  const log = makeLog([{ ts: ts(700), event: "tick-start" }]);
  const result = await tickFreshnessCheck(makeDeps(log)).run();
  assertEquals(result.status, "warn");
});

Deno.test("tickFreshnessCheck: tick-start >1800s ago → fail", async () => {
  const log = makeLog([{ ts: ts(1900), event: "tick-start" }]);
  const result = await tickFreshnessCheck(makeDeps(log)).run();
  assertEquals(result.status, "fail");
});

Deno.test("tickFreshnessCheck: tick-failed in last 3 entries → warn", async () => {
  const log = makeLog([
    { ts: ts(200), event: "tick-start" },
    { ts: ts(100), event: "tick-failed" },
  ]);
  const result = await tickFreshnessCheck(makeDeps(log)).run();
  assertEquals(result.status, "warn");
  assertStringIncludes(result.detail, "tick-failed");
});

Deno.test("tickFreshnessCheck: stale-lock entry older than 600s → fail", async () => {
  const log = makeLog([
    { ts: ts(100), event: "tick-start" },
    { ts: ts(700), event: "stale-lock" },
  ]);
  const result = await tickFreshnessCheck(makeDeps(log)).run();
  assertEquals(result.status, "fail");
  assertStringIncludes(result.detail, "stale lock");
});

Deno.test(
  "tickFreshnessCheck: stale-lock followed by tick-start → pass",
  async () => {
    const log = makeLog([
      { ts: ts(700), event: "stale-lock" },
      { ts: ts(100), event: "tick-start" },
    ]);
    const result = await tickFreshnessCheck(makeDeps(log)).run();
    assertEquals(result.status, "pass");
  },
);
