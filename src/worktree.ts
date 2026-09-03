import { join } from "@std/path";
import { type WorktreeInfo } from "./state/types.ts";
import { mkdir, readDir, stat } from "./filesystem.ts";
import {
  extractGitHubSlug,
  parseRemoteSlug,
  resolveGitHubSlug,
} from "./providers/github/identity.ts";

export { extractGitHubSlug, parseRemoteSlug, resolveGitHubSlug };

export const GIT_TIMEOUT_MS = 120_000;

const SSH_KEEPALIVE_COMMAND =
  "ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=30";

export async function runGit(
  args: string[],
  cwd: string,
  { timeoutMs = GIT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...Deno.env.toObject(),
    ...(Deno.env.get("GIT_SSH_COMMAND") === undefined
      ? { GIT_SSH_COMMAND: SSH_KEEPALIVE_COMMAND }
      : {}),
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = () => {
    const secs = Math.round(timeoutMs / 1000);
    return { code: 1, stdout: "", stderr: `git: timed out after ${secs}s` };
  };
  try {
    const result = await new Deno.Command("git", {
      args,
      cwd,
      env,
      signal: controller.signal,
    }).output();
    if (controller.signal.aborted) return timedOut();
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
    };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return timedOut();
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function findLocalRepo(
  roots: string[],
  slug: string,
  aliasesForSlug: (slug: string) => string[] = (s) => [s],
): Promise<string | null> {
  for (const root of roots) {
    try {
      for await (const orgEntry of readDir(root)) {
        if (!orgEntry.isDirectory) continue;
        const orgPath = join(root, orgEntry.name);
        try {
          for await (const repoEntry of readDir(orgPath)) {
            if (!repoEntry.isDirectory) continue;
            const candidatePath = join(orgPath, repoEntry.name);
            const { code, stdout } = await runGit(
              ["remote", "get-url", "origin"],
              candidatePath,
            );
            if (code === 0) {
              const remoteSlug = parseRemoteSlug(stdout);
              if (remoteSlug && aliasesForSlug(slug).includes(remoteSlug)) {
                return candidatePath;
              }
            }
          }
        } catch {
          // org-level directory is not readable — skip
        }
      }
    } catch {
      // root doesn't exist or isn't readable — skip
    }
  }
  return null;
}

export interface RepoCandidate {
  slug: string;
  localPath: string | null;
}

export async function listRepoCorpus(
  roots: string[],
  configuredRepos: string[],
): Promise<RepoCandidate[]> {
  const bySlug = new Map<string, RepoCandidate>();

  for (const root of roots) {
    try {
      for await (const orgEntry of readDir(root)) {
        if (!orgEntry.isDirectory) continue;
        const orgPath = join(root, orgEntry.name);
        try {
          for await (const repoEntry of readDir(orgPath)) {
            if (!repoEntry.isDirectory) continue;
            const repoPath = join(orgPath, repoEntry.name);
            const { code, stdout } = await runGit(
              ["remote", "get-url", "origin"],
              repoPath,
            );
            if (code !== 0) continue;
            const slug = parseRemoteSlug(stdout);
            if (!slug) continue;
            bySlug.set(slug, { slug, localPath: repoPath });
          }
        } catch {
          // org-level directory is not readable — skip
        }
      }
    } catch {
      // root doesn't exist or isn't readable — skip
    }
  }

  for (const slug of configuredRepos) {
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { slug, localPath: null });
    }
  }

  return [...bySlug.values()];
}

export function formatRepoCorpus(candidates: RepoCandidate[]): string {
  if (candidates.length === 0) return "";
  const lines = candidates.map((c) =>
    c.localPath
      ? `- ${c.slug} (checked out at ${c.localPath})`
      : `- ${c.slug} (not checked out locally)`
  );
  return ["## Available Repositories", "", ...lines].join("\n") + "\n";
}

function parseScopeSection(
  content: string,
  headingPattern: RegExp,
): Array<{ entry: string; isNew: boolean }> {
  const sectionStart = content.search(headingPattern);
  if (sectionStart === -1) return [];
  const afterSection = content.slice(sectionStart);
  const codeBlockMatch = afterSection.match(/```yaml\n([\s\S]*?)```/);
  if (!codeBlockMatch) return [];
  const yaml = codeBlockMatch[1];
  const lines = yaml.split("\n");
  let inScope = false;
  const results: Array<{ entry: string; isNew: boolean }> = [];
  for (const line of lines) {
    if (/^scope:\s*$/.test(line)) {
      inScope = true;
      continue;
    }
    if (inScope) {
      const itemMatch = line.match(/^\s+-\s+(.+)$/);
      if (itemMatch) {
        const raw = itemMatch[1].trim();
        const isNew = /\s+\(new\)\s*$/.test(raw);
        const entry = isNew ? raw.replace(/\s+\(new\)\s*$/, "").trim() : raw;
        results.push({ entry, isNew });
      } else if (line.trim() && !/^\s/.test(line)) {
        break;
      }
    }
  }
  return results;
}

export function parseIntakeScope(
  content: string,
): Array<{ entry: string; isNew: boolean }> {
  return parseScopeSection(content, /^## Proposed Scope$/m);
}

export function parseEnrichmentScope(
  content: string,
): Array<{ entry: string; isNew: boolean }> {
  return parseScopeSection(content, /^## Revised Scope$/m);
}

export async function cloneRemoteRepo(
  slug: string,
  clone: (slug: string, destDir: string, cwd: string) => Promise<void>,
  aliasesForSlug: (slug: string) => string[] = (s) => [s],
): Promise<string> {
  const home = Deno.env.get("HOME")!;

  for (const alias of aliasesForSlug(slug)) {
    const [aOrg, aRepo] = alias.split("/");
    const aliasDir = join(home, ".urras", "repositories", aOrg, aRepo);
    try {
      await stat(aliasDir);
      return aliasDir;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  const [org, repo] = slug.split("/");
  const orgDir = join(home, ".urras", "repositories", org);
  const repoDir = join(orgDir, repo);
  await mkdir(orgDir, { recursive: true });
  await clone(slug, repo, orgDir);
  return repoDir;
}

export async function createWorktree(
  repoPath: string,
  ticketId: string,
  slug: string,
): Promise<WorktreeInfo> {
  const home = Deno.env.get("HOME")!;
  const [org, repo] = slug.split("/");
  const worktreePath = join(home, ".urras", "worktrees", ticketId, org, repo);
  await mkdir(join(home, ".urras", "worktrees", ticketId, org), {
    recursive: true,
  });

  const { code: verifyCode } = await runGit(
    ["rev-parse", "--verify", "origin/main"],
    repoPath,
  );
  const baseRef = verifyCode === 0 ? "origin/main" : "main";
  const { code } = await runGit(
    ["worktree", "add", "-b", ticketId, worktreePath, baseRef],
    repoPath,
  );
  if (code !== 0) {
    throw new Error(
      `git worktree add failed for ticket ${ticketId} in ${repoPath}`,
    );
  }

  return { path: worktreePath, branch: ticketId };
}

export async function initLocalRepo(slug: string): Promise<string> {
  const home = Deno.env.get("HOME")!;
  const [org, repo] = slug.split("/");
  const orgDir = join(home, ".urras", "repositories", org);
  const repoDir = join(orgDir, repo);
  await mkdir(orgDir, { recursive: true });
  try {
    await stat(repoDir);
    return repoDir;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const { code: initCode, stderr: initErr } = await runGit(
    ["init", "-b", "main", repoDir],
    orgDir,
  );
  if (initCode !== 0) throw new Error(`git init failed: ${initErr}`);
  const { code: commitCode, stderr: commitErr } = await runGit(
    [
      "-c",
      "user.name=urras",
      "-c",
      "user.email=urras@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ],
    repoDir,
  );
  if (commitCode !== 0) throw new Error(`git commit failed: ${commitErr}`);
  return repoDir;
}

export async function removeWorktree(wt: WorktreeInfo): Promise<void> {
  const { code: revParseCode, stdout: gitDir } = await runGit(
    ["rev-parse", "--git-common-dir"],
    wt.path,
  );
  if (revParseCode !== 0) {
    throw new Error(`git rev-parse --git-common-dir failed for ${wt.path}`);
  }
  const mainRepoPath = gitDir.replace(/[/\\]\.git$/, "");

  const { code: removeCode, stderr: removeErr } = await runGit(
    ["worktree", "remove", wt.path],
    mainRepoPath,
  );
  if (removeCode !== 0) {
    throw new Error(`git worktree remove failed: ${removeErr}`);
  }

  const { code: branchCode, stderr: branchErr } = await runGit(
    ["branch", "-D", wt.branch],
    mainRepoPath,
  );
  if (branchCode !== 0) {
    throw new Error(`git branch -D failed: ${branchErr}`);
  }
}
