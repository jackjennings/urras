import { join } from "@std/path";
import { exists } from "./filesystem.ts";

export function glossaryPath(
  stateDir: string,
  org: string,
  repo: string,
): string {
  return join(stateDir, "glossary", org, `${repo}.md`);
}

export function glossaryDir(stateDir: string): string {
  return join(stateDir, "glossary");
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

function splitSections(output: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = output.split(/^(?=## )/m);
  for (const part of parts) {
    const heading = part.match(/^## ([^\n]+)/);
    if (heading) sections[heading[1].trim()] = part.slice(heading[0].length);
  }
  return sections;
}

function parseIntakeScope(output: string): string[] {
  const sections = splitSections(output);
  const scopeContent = sections["Proposed Scope"];
  if (!scopeContent) return [];

  const codeBlock = scopeContent.match(/```yaml\s*\n([\s\S]*?)```/);
  if (!codeBlock) return [];

  const items: string[] = [];
  let inScope = false;
  for (const line of codeBlock[1].split("\n")) {
    if (/^\s*scope:\s*\[\s*\]\s*$/.test(line)) return [];
    if (/^\s*scope:\s*$/.test(line)) {
      inScope = true;
      continue;
    }
    if (inScope) {
      const m = line.match(/^\s*-\s+(.+)/);
      if (m) items.push(m[1].trim());
      else if (/\S/.test(line)) inScope = false;
    }
  }
  return items;
}

export type GlossaryViolation = {
  approved: false;
  reason: string;
};

function isOrgRepoSlug(entry: string): boolean {
  return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry.trim());
}

export function validateGlossaryRequirement(
  output: string,
): GlossaryViolation | null {
  const scope = parseIntakeScope(output);
  if (scope.length === 0) return null;

  const first = scope[0].trim();
  if (!isOrgRepoSlug(first)) return null;

  const firstSlug = first.toLowerCase();
  const rejectMsg =
    `REJECT: Missing glossary entry for "${firstSlug}". The output must include a ## Glossary Entry section containing a ### ${firstSlug} heading followed by a description.`;

  const sections = splitSections(output);
  const glossaryContent = sections["Glossary Entry"];
  if (!glossaryContent) return { approved: false, reason: rejectMsg };

  const slugMatch = glossaryContent.match(/^### (.+)$/m);
  if (!slugMatch || slugMatch[1].trim().toLowerCase() !== firstSlug) {
    return { approved: false, reason: rejectMsg };
  }

  const afterHeading = glossaryContent
    .slice(glossaryContent.indexOf(slugMatch[0]) + slugMatch[0].length)
    .trim();
  if (!afterHeading) return { approved: false, reason: rejectMsg };

  return null;
}
