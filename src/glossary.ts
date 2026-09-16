import { join } from "@std/path";
import { exists } from "./filesystem.ts";

export function glossaryPath(
  stateDir: string,
  org: string,
  repo: string,
): string {
  return join(stateDir, "glossary", org, `${repo}.md`);
}

export async function bootstrapGlossaryEntry(
  stateDir: string,
  org: string,
  repo: string,
): Promise<void> {
  const path = glossaryPath(stateDir, org, repo);
  if (await exists(path)) return;
  await Deno.mkdir(join(stateDir, "glossary", org), { recursive: true });
  await Deno.writeTextFile(path, "");
}
