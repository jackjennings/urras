import { join } from "@std/path";
import type { PhaseUsage } from "./state/types.ts";
import { readDir, readTextFile } from "./filesystem.ts";

export function formatLargeTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(Math.round(n / 100) / 10).toFixed(1)}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}m`;
}

const FILENAME_TIMESTAMP = /^(\d{8}T\d{6})-/;

function usageFileInstant(name: string): Temporal.Instant | null {
  const match = FILENAME_TIMESTAMP.exec(name);
  if (!match) return null;
  try {
    return Temporal.PlainDateTime.from(match[1]).toZonedDateTime("UTC")
      .toInstant();
  } catch {
    return null;
  }
}

export async function readUsageFiles(
  ticketDir: string,
  options: { since?: Temporal.Instant } = {},
): Promise<PhaseUsage[] | null> {
  const files: PhaseUsage[] = [];
  try {
    for await (const entry of readDir(ticketDir)) {
      if (!entry.isFile || !entry.name.endsWith(".usage.json")) continue;
      if (options.since) {
        const instant = usageFileInstant(entry.name);
        if (!instant || Temporal.Instant.compare(instant, options.since) < 0) {
          continue;
        }
      }
      try {
        const raw = await readTextFile(join(ticketDir, entry.name));
        files.push(JSON.parse(raw) as PhaseUsage);
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
  return files;
}
