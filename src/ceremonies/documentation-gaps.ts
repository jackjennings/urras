import { join } from "@std/path";
import { compactTimestamp } from "../timestamp.ts";
import type { Ceremony } from "./types.ts";
import type { CommandRunner } from "../apfel.ts";
import { mkdir, readDir, readTextFile, writeTextFile } from "../filesystem.ts";
import { ClaudeLanguageModel } from "../models/claude.ts";

export interface DocumentationGapsCeremonyDeps {
  stateDir: string;
  repoDir: string;
  run: CommandRunner;
  commitState(): Promise<void>;
  notify?: (title: string, message: string) => Promise<void>;
}

const SYSTEM_PROMPT =
  `You are a documentation-gap analyst for a software project.

Cluster the provided Open Questions semantically — questions that ask the same thing in different words belong in one cluster. For each cluster:
- Count how many times it appears across tickets
- Select up to 3 representative verbatim quotes
- Identify which file in the doc corpus the answer should land in (AGENTS.md, a specific phase prompt file, or "unknown")

Drop any cluster whose answer is already directly present in the doc corpus. Coverage is binary: a cluster is covered only if the corpus directly answers it, not merely mentions the topic.

Drop any cluster whose theme semantically matches a heading from the Previously Reported Gaps list.

Return surviving clusters ranked by occurrence count descending, in the exact output format specified in the user message.

If no clusters survive filtering, return exactly: NO_GAPS`;

const OUTPUT_FORMAT_TEMPLATE = `# Documentation Gap Report

_N clusters across M tickets_

## {Cluster Theme}

**Occurrences:** N
**Suggested doc target:** {filename}

> {representative quote 1}
> {representative quote 2}`;

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
  const userMessage = [
    `## Questions\n${questionsBlock}`,
    `## Documentation Corpus\n${corpus}`,
    `## Previously Reported Gaps\n${priorBlock}`,
    `## Required Output Format\n\`\`\`\n${OUTPUT_FORMAT_TEMPLATE}\n\`\`\`\nwhere \`N clusters across M tickets\` are computed from the surviving clusters.`,
  ].join("\n\n");

  const model = new ClaudeLanguageModel(run, { model: "claude-sonnet-4-6" });
  const text = await model.generateText({
    systemPrompt: SYSTEM_PROMPT,
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
