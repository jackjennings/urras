import { join } from "@std/path";
import type { ActivePhase } from "./types.ts";
import type { ArtifactType } from "../state/types.ts";
import { readTextFile } from "../filesystem.ts";
import { deriveProjectPath } from "./project-path.ts";

const PROMPT_DIR = new URL("./prompts/", import.meta.url).pathname;

async function renderTemplate(content: string): Promise<string> {
  const markers = [...content.matchAll(/\{\{([a-z][a-z0-9-]*)\}\}/g)];
  if (markers.length === 0) return content;

  const partials = new Map<string, string>();
  for (const [, name] of markers) {
    if (partials.has(name)) continue;
    const partialPath = join(PROMPT_DIR, "partials", `${name}.md`);
    try {
      partials.set(name, await readTextFile(partialPath));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new Error(`Unknown partial: {{${name}}}`);
      }
      throw e;
    }
  }

  return content.replace(
    /\{\{([a-z][a-z0-9-]*)\}\}/g,
    (_, name) => partials.get(name)!,
  );
}

export function loadPrompt(phase: ActivePhase): Promise<string> {
  return readTextFile(join(PROMPT_DIR, `${phase}.md`)).then(renderTemplate);
}

export function loadPromptFile(filename: string): Promise<string> {
  return readTextFile(join(PROMPT_DIR, filename)).then(renderTemplate);
}

export async function loadProviderPrompt(
  phase: string,
  provider: string,
): Promise<string> {
  try {
    const content = await readTextFile(
      join(PROMPT_DIR, `${provider}-${phase}.md`),
    );
    return renderTemplate(content);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "";
    throw e;
  }
}

export async function loadArtifactPrompt(
  phase: string,
  artifacts: ArtifactType[],
): Promise<string> {
  const parts: string[] = [];
  for (const artifact of artifacts) {
    try {
      const content = await readTextFile(
        join(PROMPT_DIR, `${artifact}-${phase}.md`),
      );
      parts.push(await renderTemplate(content));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  return parts.join("\n");
}

export async function loadRevisionPrompt(phase: string): Promise<string> {
  try {
    const content = await readTextFile(
      join(PROMPT_DIR, `${phase}-revision.md`),
    );
    return renderTemplate(content);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "";
    throw e;
  }
}

async function readPromptFile(path: string): Promise<string> {
  let content: string;
  try {
    content = await readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "";
    throw e;
  }
  return renderTemplate(content);
}

export async function loadStatePrompt(
  phase: string,
  stateDir: string,
  provider?: string,
  ticketId?: string,
): Promise<string> {
  const paths: string[] = [join(stateDir, "prompts", `${phase}.md`)];

  if (provider && ticketId) {
    paths.push(join(stateDir, "prompts", provider, `${phase}.md`));
    const projectPath = deriveProjectPath(provider, ticketId);
    if (projectPath) {
      paths.push(
        join(stateDir, "prompts", provider, projectPath, `${phase}.md`),
      );
    }
  }

  const parts: string[] = [];
  for (const path of paths) {
    const rendered = await readPromptFile(path);
    if (rendered.length > 0) parts.push(rendered);
  }

  return parts.join("\n\n");
}
