import { join } from "@std/path";
import type { PhaseModelUsage } from "./state/types.ts";
import { stat, writeTextFile } from "./filesystem.ts";

export interface AnthropicModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

export type AnthropicPricingModels = Record<string, AnthropicModelPricing>;

export interface AnthropicPricingCache {
  fetchedAt: string;
  models: AnthropicPricingModels;
}

const MONTH_NAMES: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

function parsePricingValue(cell: string): number | null {
  const match = cell.match(/\$(\d+(?:\.\d+)?)\s*\/\s*MTok/);
  if (!match) return null;
  return parseFloat(match[1]);
}

function normalizeAlias(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/\./g, "-");
}

function parseQualifierSuffix(
  text: string,
): { qualifier: "through" | "starting"; date: Temporal.PlainDate } | null {
  const match = text.match(
    /\s(through|starting)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})$/,
  );
  if (!match) return null;
  const qualifier = match[1] as "through" | "starting";
  const month = MONTH_NAMES[match[2]];
  const day = parseInt(match[3], 10);
  const year = parseInt(match[4], 10);
  return { qualifier, date: new Temporal.PlainDate(year, month, day) };
}

type RowCandidate = {
  pricing: AnthropicModelPricing;
  qualifier: "through" | "starting" | null;
  date: Temporal.PlainDate | null;
};

export function parseAnthropicPricingPage(
  markdown: string,
  today: Temporal.PlainDate,
): AnthropicPricingModels {
  const lines = markdown.split("\n");
  const candidates = new Map<string, RowCandidate[]>();
  let inModelTable = false;

  for (const line of lines) {
    if (!line.trim().startsWith("|")) {
      inModelTable = false;
      continue;
    }

    const parts = line.split("|");
    const cells = parts
      .slice(1, parts.length - 1)
      .map((c) => c.trim());

    if (cells.length < 6) continue;

    if (/^[-: ]+$/.test(cells[0])) continue;

    if (
      cells[0].toLowerCase().includes("model") &&
      cells[1].toLowerCase().includes("base input") &&
      cells[5].toLowerCase().includes("output")
    ) {
      inModelTable = true;
      continue;
    }

    if (!inModelTable) continue;

    const inputPerMTok = parsePricingValue(cells[1]);
    const cacheWritePerMTok = parsePricingValue(cells[2]);
    const cacheReadPerMTok = parsePricingValue(cells[4]);
    const outputPerMTok = parsePricingValue(cells[5]);

    if (
      inputPerMTok === null ||
      cacheWritePerMTok === null ||
      cacheReadPerMTok === null ||
      outputPerMTok === null
    ) continue;

    let modelText = cells[0];
    modelText = modelText.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    modelText = modelText.replace(/\s*\([^)]*\)/g, "");

    const qualifierResult = parseQualifierSuffix(modelText.trim());
    let qualifier: "through" | "starting" | null = null;
    let qualDate: Temporal.PlainDate | null = null;

    if (qualifierResult) {
      qualifier = qualifierResult.qualifier;
      qualDate = qualifierResult.date;
      modelText = modelText.replace(
        /\s(through|starting)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/,
        "",
      );
    }

    const alias = normalizeAlias(modelText.trim());
    if (!alias) continue;

    const existing = candidates.get(alias) ?? [];
    existing.push({
      pricing: {
        inputPerMTok,
        outputPerMTok,
        cacheWritePerMTok,
        cacheReadPerMTok,
      },
      qualifier,
      date: qualDate,
    });
    candidates.set(alias, existing);
  }

  const result: AnthropicPricingModels = {};

  for (const [alias, rows] of candidates) {
    if (rows.length === 1) {
      result[alias] = rows[0].pricing;
      continue;
    }

    const throughRow = rows.find(
      (r) => r.qualifier === "through" && r.date !== null,
    );
    if (throughRow && throughRow.date !== null) {
      if (Temporal.PlainDate.compare(today, throughRow.date) <= 0) {
        result[alias] = throughRow.pricing;
        continue;
      }
    }

    const noQualifier = rows.find((r) => r.qualifier === null);
    if (noQualifier) {
      result[alias] = noQualifier.pricing;
      continue;
    }

    const startingRow = rows.find(
      (r) =>
        r.qualifier === "starting" &&
        r.date !== null &&
        Temporal.PlainDate.compare(today, r.date!) >= 0,
    );
    if (startingRow) {
      result[alias] = startingRow.pricing;
    }
  }

  return result;
}

export function calculateAnthropicCost(
  usage: PhaseModelUsage,
  models: AnthropicPricingModels,
): number | null {
  let pricing = models[usage.model];
  if (!pricing) {
    const stripped = usage.model.replace(/-\d{8}$/, "");
    pricing = models[stripped];
  }
  if (!pricing) return null;
  return (
    (usage.input * pricing.inputPerMTok / 1_000_000) +
    (usage.output * pricing.outputPerMTok / 1_000_000) +
    (usage.cacheRead * pricing.cacheReadPerMTok / 1_000_000) +
    (usage.cacheWrite * pricing.cacheWritePerMTok / 1_000_000)
  );
}

export async function refreshAnthropicPricingIfStale(
  homeDir: string,
  fetcher: typeof fetch,
): Promise<void> {
  const cachePath = join(homeDir, ".urras", "anthropic-pricing.json");

  try {
    const fileInfo = await stat(cachePath);
    if (fileInfo.mtime) {
      const ageMs = Temporal.Now.instant().epochMilliseconds -
        fileInfo.mtime.getTime();
      if (ageMs < 24 * 60 * 60 * 1000) return;
    }
  } catch {
    // file absent or unreadable; proceed to fetch
  }

  let response: Response;
  try {
    response = await fetcher(
      "https://platform.claude.com/docs/en/about-claude/pricing.md",
    );
  } catch (e) {
    console.error(
      `Warning: Failed to fetch Anthropic pricing: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return;
  }

  if (!response.ok) {
    console.error(
      `Warning: Failed to fetch Anthropic pricing: HTTP ${response.status}`,
    );
    return;
  }

  let text: string;
  try {
    text = await response.text();
  } catch (e) {
    console.error(
      `Warning: Failed to read Anthropic pricing response: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return;
  }

  const today = Temporal.Now.plainDateISO("UTC");
  const models = parseAnthropicPricingPage(text, today);
  const cache: AnthropicPricingCache = {
    fetchedAt: Temporal.Now.instant().toString(),
    models,
  };

  try {
    await writeTextFile(cachePath, JSON.stringify(cache));
  } catch (e) {
    console.error(
      `Warning: Failed to write Anthropic pricing cache: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
