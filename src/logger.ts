import { join } from "@std/path";
import { urrasDir } from "./paths.ts";
import { mkdir, writeTextFile } from "./filesystem.ts";

export async function appendTickLog(entry: object): Promise<void> {
  const lazyDir = urrasDir();
  const ts = Temporal.Now.instant().toString();
  await mkdir(lazyDir, { recursive: true });
  await writeTextFile(
    join(lazyDir, "tick.ndjson"),
    JSON.stringify({ ts, ...entry }) + "\n",
    { append: true },
  );
  try {
    await writeTextFile(
      join(lazyDir, "log.ndjson"),
      JSON.stringify({ ts, ...entry }) + "\n",
      { append: true },
    );
  } catch {
    // combined log failure must not interrupt tick log writes
  }
}
