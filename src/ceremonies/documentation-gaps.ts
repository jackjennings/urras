import { join } from "@std/path";
import { compactTimestamp } from "../timestamp.ts";
import type { Ceremony } from "./types.ts";
import type { CommandRunner } from "../apfel.ts";
import {
  mkdir,
  readDir,
  readTextFile,
  renderPrompt,
  writeTextFile,
} from "../filesystem.ts";
import { ClaudeLanguageModel } from "../models/claude.ts";

export interface DocumentationGapsCeremonyDeps {
  stateDir: string;
  repoDir: string;
  run: CommandRunner;
  commitState(): Promise<void>;
  notify?: (title: string, message: string) => Promise<void>;
}


function extractOpenQuestions(content: string): string | null {
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => l === "## Open Questions");
  if (headingIdx === -1) return null;
  const nextHeading = lines.findIndex(
    (l, i) => i > headingIdx && l.startsWith("## "),
  );
  const bodyLines = nextHeading === -1
    ? lines.slice(headingIdx + 1)
    : lines.slice(headingIdx + 1, nextHeading);
  if (bodyLines.every((l) => l.trim() === "")) return null;
  return ["## Open Questions", ...bodyLines].join("\n");
}

async function collectOpenQuestions(
  stateDir: string,
): Promise<Array<{ ticketId: string; questions: string }>> {
  const results: Array<{ ticketId: string; questions: string }> = [];
  const SKIP = new Set(["ceremonies", "prompts", ".git"]);

  async function walk(dir: string): Promise<void> {
    try {
      for await (const entry of readDir(dir)) {
        if (entry.isDirectory && !SKIP.has(entry.name)) {
          await walk(join(dir, entry.name));
        } else if (entry.isFile && entry.name.endsWith("-enrichment.md")) {
          const content = await readTextFile(join(dir, entry.name));
          const questions = extractOpenQuestions(content);
          if (!questions) continue;
          results.push({ ticketId: dir.slice(stateDir.length + 1), questions });
        }
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  await walk(stateDir);
  return results;
}

async function readMdFiles(dir: string): Promise<string[]> {
  const contents: string[] = [];
  try {
    for await (const entry of readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        contents.push(await readTextFile(join(dir, entry.name)));
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return contents;
}

async function readCorpus(repoDir: string, stateDir: string): Promise<string> {
  const parts: string[] = [];
  try {
    parts.push(await readTextFile(join(repoDir, "AGENTS.md")));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  parts.push(...await readMdFiles(join(repoDir, "src", "phases", "prompts")));
  parts.push(...await readMdFiles(join(stateDir, "prompts")));
  return parts.join("\n\n---\n\n");
}

async function readPriorHeadings(outputDir: string): Promise<string[]> {
  const headings: string[] = [];
  try {
    for await (const entry of readDir(outputDir)) {
      if (!entry.isFile || !entry.name.endsWith("-documentation-gaps.md")) {
        continue;
      }
      const content = await readTextFile(join(outputDir, entry.name));
      for (const line of content.split("\n")) {
        if (line.startsWith("## ")) headings.push(line.slice(3));
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return headings;
}

async function callLlm(
  questions: Array<{ ticketId: string; questions: string }>,
  corpus: string,
  priorHeadings: string[],
  run: CommandRunner,
): Promise<string> {
  const questionsBlock = questions
    .map((q) => `### ${q.ticketId}\n${q.questions}`)
    .join("\n\n");
  const priorBlock = priorHeadings.length > 0
    ? priorHeadings.map((h) => `- ${h}`).join("\n")
    : "None.";
  const outputFormat = await renderPrompt(
    new URL("./documentation-gaps-output-format.prompt.hbs", import.meta.url),
  );
  const userMessage = [
    `## Questions\n${questionsBlock}`,
    `## Documentation Corpus\n${corpus}`,
    `## Previously Reported Gaps\n${priorBlock}`,
    `## Required Output Format\n\`\`\`\n${outputFormat}\n\`\`\`\nwhere \`N clusters across M tickets\` are computed from the surviving clusters.`,
  ].join("\n\n");

  const model = new ClaudeLanguageModel(run, { model: "claude-sonnet-4-6" });
  const systemPrompt = await renderPrompt(
    new URL("./documentation-gaps.prompt.hbs", import.meta.url),
  );
  const text = await model.generateText({
    systemPrompt,
    prompt: userMessage,
  });
  if (text == null) {
    return "# Documentation Gap Report\n\nError: LLM call failed.\n";
  }
  return text.trim() === "NO_GAPS"
    ? "# Documentation Gap Report\n\nNo uncovered gaps found.\n"
    : `${text}\n`;
}

export class DocumentationGapsCeremony implements Ceremony {
  static readonly NAME = "documentation-gaps";
  readonly name = DocumentationGapsCeremony.NAME;
  readonly #deps: DocumentationGapsCeremonyDeps;

  constructor(deps: DocumentationGapsCeremonyDeps) {
    this.#deps = deps;
  }

  async run(now: Temporal.ZonedDateTime, outputDir: string): Promise<void> {
    await mkdir(outputDir, { recursive: true });

    const questions = await collectOpenQuestions(this.#deps.stateDir);
    const outputPath = join(
      outputDir,
      `${compactTimestamp(now)}-documentation-gaps.md`,
    );

    let content: string;
    if (questions.length === 0) {
      content = "# Documentation Gap Report\n\nNo uncovered gaps found.\n";
    } else {
      const corpus = await readCorpus(this.#deps.repoDir, this.#deps.stateDir);
      const priorHeadings = await readPriorHeadings(outputDir);
      content = await callLlm(
        questions,
        corpus,
        priorHeadings,
        this.#deps.run,
      );
    }

    await writeTextFile(outputPath, content);
    await this.#deps.commitState();

    try {
      await this.#deps.notify?.("urras", "Documentation gaps ready");
    } catch {
      // notification failures must not abort the ceremony run
    }
  }
}
