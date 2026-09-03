import { join } from "@std/path";
import type { CommandRunner } from "./apfel.ts";
import type { LearningState, WorktreeInfo } from "./state/types.ts";

export interface LearningPrDeps {
  roots: string[];
  findLocalRepo: (roots: string[], slug: string) => Promise<string | null>;
  createWorktree: (
    repoPath: string,
    branch: string,
    repoName: string,
  ) => Promise<WorktreeInfo>;
  removeWorktree: (wt: WorktreeInfo) => Promise<void>;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
  applyLearning: (
    currentContent: string,
    intent: string,
    run: CommandRunner,
  ) => Promise<string | null>;
  captureCommandRunner: () => CommandRunner;
  resolveAccount: (slug: string) => { token: string; login: string };
  run: (
    cmd: string[],
    opts: { cwd: string; env: Record<string, string> },
  ) => Promise<{ code: number; stdout: string }>;
}

export async function applyLearningToRepo(
  learning: LearningState,
  intent: string,
  deps: LearningPrDeps,
): Promise<{ url: string; title: string }> {
  const localRepoPath = await deps.findLocalRepo(deps.roots, learning.repo);
  if (localRepoPath === null) {
    throw new Error("local-repo-not-found");
  }

  const wt = await deps
    .createWorktree(localRepoPath, `learnings-${learning.id}`, learning.repo)
    .catch(() => {
      throw new Error("worktree-creation-failed");
    });

  try {
    const targetPath = join(wt.path, learning.targetFile);
    const currentContent = await deps.readTextFile(targetPath).catch(() => "");
    const applied = await deps.applyLearning(
      currentContent,
      intent,
      deps.captureCommandRunner(),
    );
    if (applied === null) {
      throw new Error("apply-learning-failed");
    }
    await deps.mkdir(
      join(wt.path, ...learning.targetFile.split("/").slice(0, -1)),
      { recursive: true },
    );
    await deps.writeTextFile(targetPath, applied);

    const title = `docs: apply learning to ${learning.targetFile}`;
    const body = `${intent}\n\nOriginated from ${learning.ticketId}.`;
    const { token } = deps.resolveAccount(learning.repo);
    const env = {
      ...Deno.env.toObject(),
      GITHUB_TOKEN: token,
      GH_TOKEN: token,
    };

    await deps.run(["git", "add", learning.targetFile], { cwd: wt.path, env });
    const commit = await deps.run(["git", "commit", "-m", title], {
      cwd: wt.path,
      env,
    });
    if (commit.code !== 0) {
      throw new Error("git-commit-failed");
    }

    const created = await deps.run(
      ["gh", "pr", "create", "--draft", "--title", title, "--body", body],
      { cwd: wt.path, env },
    );
    const url = created.stdout
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("http"))
      .pop();
    if (created.code !== 0 || url === undefined) {
      throw new Error("pr-create-failed");
    }

    return { url, title };
  } finally {
    await deps.removeWorktree(wt).catch(() => {});
  }
}
