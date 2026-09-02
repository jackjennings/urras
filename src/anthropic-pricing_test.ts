import {
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import {
  calculateAnthropicCost,
  parseAnthropicPricingPage,
  refreshAnthropicPricingIfStale,
} from "./anthropic-pricing.ts";
import type { PhaseModelUsage } from "./state/types.ts";

// ── parseAnthropicPricingPage ────────────────────────────────────────────────

const HEADER =
  `| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| --- | --- | --- | --- | --- | --- |`;

function wrapTable(rows: string): string {
  return `## Model pricing\n\n${HEADER}\n${rows}\n`;
}

const TODAY = new Temporal.PlainDate(2026, 7, 22);

Deno.test("parseAnthropicPricingPage: parses a standard model row", () => {
  const md = wrapTable(
    "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
  );
  const models = parseAnthropicPricingPage(md, TODAY);
  assertEquals(models["claude-haiku-4-5"], {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheWritePerMTok: 1.25,
    cacheReadPerMTok: 0.10,
  });
});

Deno.test(
  "parseAnthropicPricingPage: matches header regardless of cell capitalization",
  () => {
    const md =
      `## Model pricing\n\n| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |\n| --- | --- | --- | --- | --- | --- |\n| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |\n`;
    const models = parseAnthropicPricingPage(md, TODAY);
    assertEquals(models["claude-haiku-4-5"], {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheWritePerMTok: 1.25,
      cacheReadPerMTok: 0.10,
    });
  },
);

Deno.test(
  "parseAnthropicPricingPage: strips markdown links from model cell",
  () => {
    const md = wrapTable(
      "| Claude Mythos 5 ([limited availability](https://anthropic.com/glasswing)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |",
    );
    const models = parseAnthropicPricingPage(md, TODAY);
    assertEquals(models["claude-mythos-5"]?.inputPerMTok, 10);
  },
);

Deno.test(
  "parseAnthropicPricingPage: strips parenthetical expressions from model cell",
  () => {
    const md = wrapTable(
      "| Claude Opus 4.1 ([deprecated](/docs/deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |",
    );
    const models = parseAnthropicPricingPage(md, TODAY);
    assertEquals(models["claude-opus-4-1"]?.inputPerMTok, 15);
  },
);

Deno.test(
  "parseAnthropicPricingPage: uses 'through' row when today <= qualifier date",
  () => {
    const md = wrapTable(
      [
        "| Claude Sonnet 5 [through August 31, 2026](/docs/pricing) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |",
        "| Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |",
      ].join("\n"),
    );
    const models = parseAnthropicPricingPage(
      md,
      new Temporal.PlainDate(2026, 7, 22),
    );
    assertEquals(models["claude-sonnet-5"]?.inputPerMTok, 2);
    assertEquals(models["claude-sonnet-5"]?.outputPerMTok, 10);
  },
);

Deno.test(
  "parseAnthropicPricingPage: uses 'starting' row when today > through qualifier date",
  () => {
    const md = wrapTable(
      [
        "| Claude Sonnet 5 [through August 31, 2026](/docs/pricing) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |",
        "| Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |",
      ].join("\n"),
    );
    const models = parseAnthropicPricingPage(
      md,
      new Temporal.PlainDate(2026, 9, 15),
    );
    assertEquals(models["claude-sonnet-5"]?.inputPerMTok, 3);
    assertEquals(models["claude-sonnet-5"]?.outputPerMTok, 15);
  },
);

Deno.test(
  "parseAnthropicPricingPage: uses 'through' row on the exact boundary date",
  () => {
    const md = wrapTable(
      [
        "| Claude Sonnet 5 [through August 31, 2026](/docs/pricing) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |",
        "| Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |",
      ].join("\n"),
    );
    const models = parseAnthropicPricingPage(
      md,
      new Temporal.PlainDate(2026, 8, 31),
    );
    assertEquals(models["claude-sonnet-5"]?.inputPerMTok, 2);
  },
);

Deno.test(
  "parseAnthropicPricingPage: normalizes name (lowercase, spaces to dash, dots to dash)",
  () => {
    const md = wrapTable(
      "| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
    );
    const models = parseAnthropicPricingPage(md, TODAY);
    assertEquals(models["claude-opus-4-8"]?.inputPerMTok, 5);
  },
);

Deno.test(
  "parseAnthropicPricingPage: cacheWritePerMTok is from 5m Cache Writes column",
  () => {
    const md = wrapTable(
      "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
    );
    const models = parseAnthropicPricingPage(md, TODAY);
    assertEquals(models["claude-haiku-4-5"]?.cacheWritePerMTok, 1.25);
  },
);

Deno.test(
  "parseAnthropicPricingPage: cacheReadPerMTok is from Cache Hits & Refreshes column",
  () => {
    const md = wrapTable(
      "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
    );
    const models = parseAnthropicPricingPage(md, TODAY);
    assertEquals(models["claude-haiku-4-5"]?.cacheReadPerMTok, 0.10);
  },
);

Deno.test(
  "parseAnthropicPricingPage: silently skips rows with unparseable pricing",
  () => {
    const md = wrapTable(
      [
        "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
        "| Claude Unknown | contact us | contact us | contact us | contact us | contact us |",
      ].join("\n"),
    );
    const models = parseAnthropicPricingPage(md, TODAY);
    assertFalse(Object.keys(models).includes("claude-unknown"));
    assertArrayIncludes(Object.keys(models), ["claude-haiku-4-5"]);
  },
);

Deno.test(
  "parseAnthropicPricingPage: does not parse rows from batch processing table",
  () => {
    const md = `
## Model pricing

${HEADER}
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |

## Batch processing

| Model | Batch input | Batch output |
| --- | --- | --- |
| Claude Haiku 4.5 | $0.50 / MTok | $2.50 / MTok |
`;
    const models = parseAnthropicPricingPage(md, TODAY);
    assertEquals(models["claude-haiku-4-5"]?.inputPerMTok, 1);
  },
);

// ── calculateAnthropicCost ───────────────────────────────────────────────────

function makeModelUsage(
  overrides: Partial<PhaseModelUsage> = {},
): PhaseModelUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    model: "claude-haiku-4-5",
    ...overrides,
  };
}

const HAIKU_PRICING = {
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheWritePerMTok: 1.25,
    cacheReadPerMTok: 0.10,
  },
};

Deno.test(
  "calculateAnthropicCost: exact model match returns correct cost",
  () => {
    const usage = makeModelUsage({
      input: 1_000_000,
      output: 1_000_000,
      model: "claude-haiku-4-5",
    });
    const cost = calculateAnthropicCost(usage, HAIKU_PRICING);
    assertEquals(cost, 6);
  },
);

Deno.test(
  "calculateAnthropicCost: includes all token types in calculation",
  () => {
    const usage = makeModelUsage({
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      model: "claude-haiku-4-5",
    });
    const cost = calculateAnthropicCost(usage, HAIKU_PRICING);
    assertEquals(cost, 1 + 5 + 0.10 + 1.25);
  },
);

Deno.test(
  "calculateAnthropicCost: strips 8-digit date suffix for lookup",
  () => {
    const usage = makeModelUsage({ model: "claude-haiku-4-5-20251001" });
    const cost = calculateAnthropicCost(usage, HAIKU_PRICING);
    assertNotEquals(cost, null);
  },
);

Deno.test(
  "calculateAnthropicCost: returns null when model not found after stripping",
  () => {
    const usage = makeModelUsage({ model: "claude-unknown-model" });
    const cost = calculateAnthropicCost(usage, HAIKU_PRICING);
    assertEquals(cost, null);
  },
);

Deno.test(
  "calculateAnthropicCost: returns null for empty models map",
  () => {
    const usage = makeModelUsage({ model: "claude-haiku-4-5" });
    const cost = calculateAnthropicCost(usage, {});
    assertEquals(cost, null);
  },
);

// ── refreshAnthropicPricingIfStale ───────────────────────────────────────────

const noopLogFn = (_entry: object) => Promise.resolve();

const MINIMAL_PRICING_MARKDOWN = `## Model pricing

| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |
`;

Deno.test(
  "refreshAnthropicPricingIfStale: skips fetch when cache file is fresh",
  async () => {
    const tempHome = await Deno.makeTempDir();
    try {
      const lazyboyDir = join(tempHome, ".urras");
      await Deno.mkdir(lazyboyDir);
      await Deno.writeTextFile(
        join(lazyboyDir, "anthropic-pricing.json"),
        JSON.stringify({
          fetchedAt: Temporal.Now.instant().toString(),
          models: {},
        }),
      );
      const fetcherSpy = spy((_url: string) =>
        Promise.resolve(new Response(MINIMAL_PRICING_MARKDOWN, { status: 200 }))
      );
      await refreshAnthropicPricingIfStale({
        homeDir: tempHome,
        fetcher: fetcherSpy as typeof fetch,
        logFn: noopLogFn,
      });
      assertSpyCalls(fetcherSpy, 0);
    } finally {
      await Deno.remove(tempHome, { recursive: true });
    }
  },
);

Deno.test(
  "refreshAnthropicPricingIfStale: fetches and writes cache when file is absent",
  async () => {
    const tempHome = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(tempHome, ".urras"));
      const fetcherSpy = spy((_url: string) =>
        Promise.resolve(new Response(MINIMAL_PRICING_MARKDOWN, { status: 200 }))
      );
      await refreshAnthropicPricingIfStale({
        homeDir: tempHome,
        fetcher: fetcherSpy as typeof fetch,
        logFn: noopLogFn,
      });
      assertSpyCalls(fetcherSpy, 1);
      const raw = await Deno.readTextFile(
        join(tempHome, ".urras", "anthropic-pricing.json"),
      );
      const cache = JSON.parse(raw);
      assertEquals(typeof cache.fetchedAt, "string");
      assertEquals(typeof cache.models["claude-haiku-4-5"], "object");
    } finally {
      await Deno.remove(tempHome, { recursive: true });
    }
  },
);

Deno.test(
  "refreshAnthropicPricingIfStale: fetches and overwrites when cache is stale",
  async () => {
    const tempHome = await Deno.makeTempDir();
    try {
      const lazyboyDir = join(tempHome, ".urras");
      await Deno.mkdir(lazyboyDir);
      const cachePath = join(lazyboyDir, "anthropic-pricing.json");
      await Deno.writeTextFile(
        cachePath,
        JSON.stringify({ fetchedAt: "old", models: {} }),
      );
      const staleTimeSec = Math.floor(
        (Date.now() - 25 * 60 * 60 * 1000) / 1000,
      );
      await Deno.utime(cachePath, staleTimeSec, staleTimeSec);
      const fetcherSpy = spy((_url: string) =>
        Promise.resolve(new Response(MINIMAL_PRICING_MARKDOWN, { status: 200 }))
      );
      await refreshAnthropicPricingIfStale({
        homeDir: tempHome,
        fetcher: fetcherSpy as typeof fetch,
        logFn: noopLogFn,
      });
      assertSpyCalls(fetcherSpy, 1);
      const raw = await Deno.readTextFile(cachePath);
      const cache = JSON.parse(raw);
      assertEquals(typeof cache.models["claude-haiku-4-5"], "object");
    } finally {
      await Deno.remove(tempHome, { recursive: true });
    }
  },
);

Deno.test(
  "refreshAnthropicPricingIfStale: does not throw when fetch returns non-200",
  async () => {
    const tempHome = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(tempHome, ".urras"));
      const logFnSpy = spy((_entry: object) => Promise.resolve());
      const fetcher = (_url: string) =>
        Promise.resolve(new Response("", { status: 500 }));
      await refreshAnthropicPricingIfStale({
        homeDir: tempHome,
        fetcher: fetcher as typeof fetch,
        logFn: logFnSpy,
      });
      assertSpyCalls(logFnSpy, 1);
      assertEquals(logFnSpy.calls[0].args[0], {
        event: "pricing-fetch-failed",
        reason: "http-error",
        status: 500,
      });
      let exists = false;
      try {
        await Deno.stat(join(tempHome, ".urras", "anthropic-pricing.json"));
        exists = true;
      } catch { /* not found */ }
      assertFalse(exists);
    } finally {
      await Deno.remove(tempHome, { recursive: true });
    }
  },
);

Deno.test(
  "refreshAnthropicPricingIfStale: does not throw when fetch throws",
  async () => {
    const tempHome = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(tempHome, ".urras"));
      const logFnSpy = spy((_entry: object) => Promise.resolve());
      const fetcher = (_url: string) =>
        Promise.reject(new Error("network failure"));
      await refreshAnthropicPricingIfStale({
        homeDir: tempHome,
        fetcher: fetcher as typeof fetch,
        logFn: logFnSpy,
      });
      assertSpyCalls(logFnSpy, 1);
      assertEquals(logFnSpy.calls[0].args[0], {
        event: "pricing-fetch-failed",
        reason: "network-error",
        error: "network failure",
      });
    } finally {
      await Deno.remove(tempHome, { recursive: true });
    }
  },
);

Deno.test(
  "refreshAnthropicPricingIfStale: leaves stale cache intact when fetch fails",
  async () => {
    const tempHome = await Deno.makeTempDir();
    try {
      const lazyboyDir = join(tempHome, ".urras");
      await Deno.mkdir(lazyboyDir);
      const cachePath = join(lazyboyDir, "anthropic-pricing.json");
      const staleContent = JSON.stringify({
        fetchedAt: "stale",
        models: { "old": {} },
      });
      await Deno.writeTextFile(cachePath, staleContent);
      const staleTimeSec = Math.floor(
        (Date.now() - 25 * 60 * 60 * 1000) / 1000,
      );
      await Deno.utime(cachePath, staleTimeSec, staleTimeSec);
      const fetcher = (_url: string) =>
        Promise.resolve(new Response("", { status: 503 }));
      await refreshAnthropicPricingIfStale({
        homeDir: tempHome,
        fetcher: fetcher as typeof fetch,
        logFn: noopLogFn,
      });
      const raw = await Deno.readTextFile(cachePath);
      assertEquals(raw, staleContent);
    } finally {
      await Deno.remove(tempHome, { recursive: true });
    }
  },
);

Deno.test(
  "refreshAnthropicPricingIfStale: fetches from the Anthropic pricing URL",
  async () => {
    const tempHome = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(tempHome, ".urras"));
      let capturedUrl = "";
      const fetcher = (url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(MINIMAL_PRICING_MARKDOWN, { status: 200 }),
        );
      };
      await refreshAnthropicPricingIfStale({
        homeDir: tempHome,
        fetcher: fetcher as typeof fetch,
        logFn: noopLogFn,
      });
      assertEquals(
        capturedUrl,
        "https://platform.claude.com/docs/en/about-claude/pricing.md",
      );
    } finally {
      await Deno.remove(tempHome, { recursive: true });
    }
  },
);
