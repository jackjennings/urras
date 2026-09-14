import { join } from "@std/path";
import { listTickets } from "../state/store.ts";
import { expandHome, loadConfig } from "../config.ts";
import { formatLargeTokens, readUsageFiles } from "../usage.ts";
import {
  type AncillaryUsageRecord,
  readAncillaryUsageFile,
} from "../ancillary-usage.ts";
import type { PhaseUsage } from "../state/types.ts";
import type { Command } from "./types.ts";

type ModelGroup = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  count: number;
  costCount: number;
  tools: Record<string, number>;
};

export function aggregateUsage(records: PhaseUsage[]): Map<string, ModelGroup> {
  const groups = new Map<string, ModelGroup>();

  function getOrCreate(key: string): ModelGroup {
    let g = groups.get(key);
    if (!g) {
      g = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        count: 0,
        costCount: 0,
        tools: {},
      };
      groups.set(key, g);
    }
    return g;
  }

  for (const r of records) {
    for (const m of r.models) {
      const key = m.model.replace(/-\d{8}$/, "");
      const g = getOrCreate(key);
      g.input += m.input;
      g.output += m.output;
      g.cacheRead += m.cacheRead;
      g.cacheWrite += m.cacheWrite;
      g.count++;
      if (m.costUsd !== undefined) {
        g.cost += m.costUsd;
        g.costCount++;
      }
    }
    if (r.tools && r.models.length > 0) {
      const primary = r.models.reduce((a, b) =>
        a.input + a.output >= b.input + b.output ? a : b
      );
      const g = getOrCreate(primary.model.replace(/-\d{8}$/, ""));
      for (const [name, count] of Object.entries(r.tools)) {
        g.tools[name] = (g.tools[name] ?? 0) + count;
      }
    }
  }
  return groups;
}

export function formatUsageOutput(groups: Map<string, ModelGroup>): string {
  if (groups.size === 0) return "Total cost:  —";

  const names = [...groups.keys()].sort();
  const maxLen = Math.max(...names.map((n) => n.length));
  const col = maxLen + 7;

  const toolTotals: Record<string, number> = {};
  let totalCost = 0;
  let totalCount = 0;
  let totalCostCount = 0;
  for (const g of groups.values()) {
    totalCost += g.cost;
    totalCount += g.count;
    totalCostCount += g.costCount;
    for (const [name, count] of Object.entries(g.tools)) {
      toolTotals[name] = (toolTotals[name] ?? 0) + count;
    }
  }

  const totalCostStr = totalCostCount === 0
    ? "—"
    : totalCostCount === totalCount
    ? `$${totalCost.toFixed(2)}`
    : `~$${totalCost.toFixed(2)}`;

  const lines: string[] = [];
  lines.push("Total cost:".padEnd(col) + totalCostStr);
  lines.push("Usage by model:");

  for (const name of names) {
    const g = groups.get(name)!;
    const tokens =
      `${formatLargeTokens(g.input)} input, ${
        formatLargeTokens(g.output)
      } output, ` +
      `${formatLargeTokens(g.cacheRead)} cache read, ${
        formatLargeTokens(g.cacheWrite)
      } cache write`;
    const costStr = g.costCount === 0
      ? "(—)"
      : g.costCount === g.count
      ? `($${g.cost.toFixed(2)})`
      : `(~$${g.cost.toFixed(2)})`;
    lines.push(`    ${name.padStart(maxLen)}:  ${tokens} ${costStr}`);
  }

  const toolNames = Object.keys(toolTotals).sort();
  if (toolNames.length > 0) {
    lines.push("Tool usage:");
    for (const name of toolNames) {
      lines.push(`    ${name}: ${toolTotals[name]}`);
    }
  }

  return lines.join("\n");
}

type AncillaryModelGroup = {
  input: number;
  output: number;
  cost: number;
  count: number;
  costCount: number;
  estimated: boolean;
};

export function aggregateAncillaryUsage(
  records: AncillaryUsageRecord[],
): Map<string, Map<string, AncillaryModelGroup>> {
  const groups = new Map<string, Map<string, AncillaryModelGroup>>();

  for (const r of records) {
    let siteGroup = groups.get(r.callSite);
    if (!siteGroup) {
      siteGroup = new Map();
      groups.set(r.callSite, siteGroup);
    }
    let modelGroup = siteGroup.get(r.model);
    if (!modelGroup) {
      modelGroup = {
        input: 0,
        output: 0,
        cost: 0,
        count: 0,
        costCount: 0,
        estimated: false,
      };
      siteGroup.set(r.model, modelGroup);
    }
    if (r.input !== undefined) modelGroup.input += r.input;
    if (r.output !== undefined) modelGroup.output += r.output;
    modelGroup.count++;
    if (r.cost !== undefined) {
      modelGroup.cost += r.cost;
      modelGroup.costCount++;
    }
    if (r.estimated) modelGroup.estimated = true;
  }

  return groups;
}

export function formatAncillaryUsageOutput(
  groups: Map<string, Map<string, AncillaryModelGroup>>,
): string | null {
  if (groups.size === 0) return null;

  const lines: string[] = ["Ancillary usage:"];
  const callSites = [...groups.keys()].sort();

  for (const callSite of callSites) {
    lines.push(`  ${callSite}`);
    const modelGroups = groups.get(callSite)!;
    const models = [...modelGroups.keys()].sort();

    for (const model of models) {
      const g = modelGroups.get(model)!;
      const prefix = g.estimated ? "~" : "";
      const inputStr = `${prefix}${formatLargeTokens(g.input)} input`;
      const outputStr = `${prefix}${formatLargeTokens(g.output)} output`;
      const callWord = g.count === 1 ? "call" : "calls";
      const countStr = `(${g.count} ${callWord})`;
      const costStr = g.costCount === 0
        ? ""
        : g.costCount === g.count
        ? `($${g.cost.toFixed(2)}) `
        : `(~$${g.cost.toFixed(2)}) `;
      lines.push(
        `    ${model}: ${inputStr}, ${outputStr} ${costStr}${countStr}`,
      );
    }
  }

  return lines.join("\n");
}

export const usage: Command = {
  name: "usage",
  description: "show aggregate usage statistics",
  async run(_args) {
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    const ids = await listTickets(stateDir);
    const allRecords: PhaseUsage[] = [];
    await Promise.all(
      ids.map(async (id) => {
        const records = await readUsageFiles(join(stateDir, id));
        if (records) allRecords.push(...records);
      }),
    );
    let output = formatUsageOutput(aggregateUsage(allRecords));
    const ancillaryRecords = await readAncillaryUsageFile();
    if (ancillaryRecords.length > 0) {
      const ancillaryOutput = formatAncillaryUsageOutput(
        aggregateAncillaryUsage(ancillaryRecords),
      );
      if (ancillaryOutput) output += "\n" + ancillaryOutput;
    }
    console.log(output);
  },
};
