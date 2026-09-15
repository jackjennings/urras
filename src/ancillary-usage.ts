import { join } from "@std/path";
import { readTextFile, writeTextFile } from "./filesystem.ts";
import { urrasDir } from "./paths.ts";

export type AncillaryUsageRecord = {
  ts: string;
  callSite: string;
  adapter: "apfel" | "ollama" | "claude";
  model: string;
  input?: number;
  output?: number;
  cost?: number;
  estimated?: true;
};

export async function appendAncillaryUsage(
  record: AncillaryUsageRecord,
): Promise<void> {
  await writeTextFile(
    join(urrasDir(), "ancillary-usage.ndjson"),
    JSON.stringify(record) + "\n",
    { append: true },
  );
}

export async function readAncillaryUsageFile(): Promise<
  AncillaryUsageRecord[]
> {
  try {
    const content = await readTextFile(
      join(urrasDir(), "ancillary-usage.ndjson"),
    );
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AncillaryUsageRecord);
  } catch {
    return [];
  }
}
