import { join } from "@std/path";
import { compactTimestamp } from "../timestamp.ts";
import type { Ceremony } from "./types.ts";
import type { CommandRunner } from "../apfel.ts";
import { mkdir, readTextFile, writeTextFile } from "../filesystem.ts";
import { ClaudeLanguageModel } from "../models/claude.ts";

export interface AgentsMdConsolidationCeremonyDeps {
  repoDir: string;
  run: CommandRunner;
  commitState(): Promise<void>;
  notify?: (title: string, message: string) => Promise<void>;
}

const BRANCH = "ceremony/agents-md-consolidation";

function parseGitHubSlug(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = remoteUrl.match(
    /https:\/\/github\.com\/(.+?)(?:\.git)?(?:\/)?$/,
  );
  if (httpsMatch) return httpsMatch[1];
  return null;
}

async function loadSystemPrompt(): Promise<string> {
  return await readTextFile(
    new URL("./agents-md-consolidation.md", import.meta.url),
  );
}

export class AgentsMdConsolidationCeremony implements Ceremony {
  static readonly NAME = "agents-md-consolidation";
  readonly name = AgentsMdConsolidationCeremony.NAME;
  readonly #deps: AgentsMdConsolidationCeremonyDeps;

  constructor(deps: AgentsMdConsolidationCeremonyDeps) {
    this.#deps = deps;
  }

  async run(now: Temporal.ZonedDateTime, outputDir: string): Promise<void> {
    await mkdir(outputDir, { recursive: true });
    const agentsMdPath = join(this.#deps.repoDir, "AGENTS.md");
    const outputPath = join(
      outputDir,
      `${compactTimestamp(now)}-agents-md-consolidation.md`,
    );

    let agentsMdContent: string;
    try {
      agentsMdContent = await readTextFile(agentsMdPath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        await writeTextFile(outputPath, "skipped: AGENTS.md not found\n");
        await this.#deps.commitState();
        return;
      }
      throw e;
    }

    const { code: branchCode } = await this.#deps.run([
      "git",
      "-C",
      this.#deps.repoDir,
      "rev-parse",
      "--verify",
      BRANCH,
    ]);
    if (branchCode === 0) {
      await writeTextFile(outputPath, "skipped: pending PR\n");
      await this.#deps.commitState();
      return;
    }

    const beforeLineCount = agentsMdContent.split("\n").length;
    const systemPrompt = await loadSystemPrompt();
    const model = new ClaudeLanguageModel(this.#deps.run, {
      model: "claude-sonnet-4-6",
    });
    const result = await model.generateText({
      systemPrompt,
      prompt: agentsMdContent,
    });

    if (result === null) {
      await writeTextFile(outputPath, "error: LLM call failed\n");
      await this.#deps.commitState();
      return;
    }

    if (result.trim() === "NO_CHANGES") {
      await writeTextFile(outputPath, "no changes needed\n");
      await this.#deps.commitState();
      return;
    }

    let branchCreated = false;
    try {
      const checkoutResult = await this.#deps.run([
        "git",
        "-C",
        this.#deps.repoDir,
        "checkout",
        "-b",
        BRANCH,
      ]);
      if (checkoutResult.code !== 0) {
        throw new Error(`git checkout failed: code ${checkoutResult.code}`);
      }
      branchCreated = true;

      await writeTextFile(agentsMdPath, result);

      const addResult = await this.#deps.run([
        "git",
        "-C",
        this.#deps.repoDir,
        "add",
        "AGENTS.md",
      ]);
      if (addResult.code !== 0) {
        throw new Error(`git add failed: code ${addResult.code}`);
      }

      const commitResult = await this.#deps.run([
        "git",
        "-C",
        this.#deps.repoDir,
        "commit",
        "-m",
        "ceremony: consolidate AGENTS.md",
      ]);
      if (commitResult.code !== 0) {
        throw new Error(`git commit failed: code ${commitResult.code}`);
      }

      const pushResult = await this.#deps.run([
        "git",
        "-C",
        this.#deps.repoDir,
        "push",
        "origin",
        BRANCH,
      ]);
      if (pushResult.code !== 0) {
        throw new Error(`git push failed: code ${pushResult.code}`);
      }

      const remoteResult = await this.#deps.run([
        "git",
        "-C",
        this.#deps.repoDir,
        "remote",
        "get-url",
        "origin",
      ]);
      const repoSlug = parseGitHubSlug(remoteResult.stdout.trim());

      const prArgs = [
        "gh",
        "pr",
        "create",
        "--draft",
        "--title",
        "Consolidate AGENTS.md",
        "--body",
        "Automated consolidation pass: removed duplicate bullets and implementation-narration content.",
      ];
      if (repoSlug) {
        prArgs.push("--repo", repoSlug);
      }

      const prResult = await this.#deps.run(prArgs);
      if (prResult.code !== 0) {
        throw new Error(`gh pr create failed: code ${prResult.code}`);
      }
      const prUrl = prResult.stdout.trim();

      const afterLineCount = result.split("\n").length;
      const linesRemoved = beforeLineCount - afterLineCount;
      const summary = [
        `PR: ${prUrl}`,
        `Lines before: ${beforeLineCount}`,
        `Lines after: ${afterLineCount}`,
        `Lines removed: ${linesRemoved}`,
        "",
      ].join("\n");

      await writeTextFile(outputPath, summary);
      await this.#deps.commitState();

      try {
        await this.#deps.notify?.(
          "urras",
          "AGENTS.md consolidation PR opened",
        );
      } catch {
        // notification failures must not abort the ceremony run
      }
    } catch (e) {
      if (branchCreated) {
        try {
          await this.#deps.run([
            "git",
            "-C",
            this.#deps.repoDir,
            "checkout",
            "-",
          ]);
          await this.#deps.run([
            "git",
            "-C",
            this.#deps.repoDir,
            "branch",
            "-D",
            BRANCH,
          ]);
        } catch {
          // best-effort cleanup
        }
      }
      const errorMsg = e instanceof Error ? e.message : String(e);
      await writeTextFile(outputPath, `error: ${errorMsg}\n`);
      await this.#deps.commitState();
      throw e;
    }
  }
}
