import {
  assert,
  assertEquals,
  assertFalse,
  assertGreater,
  assertLess,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import type { WorktreeInfo } from "./state/types.ts";
import type { RepoCandidate } from "./worktree.ts";
import {
  cloneRemoteRepo,
  createWorktree,
  createWorktreeTestable,
  extractGitHubSlug,
  findLocalRepo,
  formatRepoCorpus,
  initLocalRepo,
  listRepoCorpus,
  parseIntakeScope,
  parseRemoteSlug,
  removeWorktree,
  resolveGitHubSlug,
  runGit,
} from "./worktree.ts";

// ── extractGitHubSlug ────────────────────────────────────────────────────────

Deno.test("extractGitHubSlug: extracts slug from issue URL", () => {
  assertEquals(
    extractGitHubSlug("https://github.com/jackjennings/lazyboy/issues/42"),
    "jackjennings/lazyboy",
  );
});

Deno.test("extractGitHubSlug: works with PR URLs", () => {
  assertEquals(
    extractGitHubSlug("https://github.com/myorg/myrepo/pull/7"),
    "myorg/myrepo",
  );
});

Deno.test("extractGitHubSlug: throws on non-GitHub URL", () => {
  assertThrows(
    () => extractGitHubSlug("https://example.com/foo"),
    Error,
    "Cannot extract GitHub slug",
  );
});

// ── parseRemoteSlug ──────────────────────────────────────────────────────────

Deno.test("parseRemoteSlug: extracts slug from HTTPS remote with .git suffix", () => {
  assertEquals(
    parseRemoteSlug("https://github.com/jackjennings/lazyboy.git"),
    "jackjennings/lazyboy",
  );
});

Deno.test("parseRemoteSlug: extracts slug from HTTPS remote without .git suffix", () => {
  assertEquals(
    parseRemoteSlug("https://github.com/jackjennings/lazyboy"),
    "jackjennings/lazyboy",
  );
});

Deno.test("parseRemoteSlug: extracts slug from SSH remote with .git suffix", () => {
  assertEquals(
    parseRemoteSlug("git@github.com:jackjennings/lazyboy.git"),
    "jackjennings/lazyboy",
  );
});

Deno.test("parseRemoteSlug: extracts slug from SSH remote without .git suffix", () => {
  assertEquals(
    parseRemoteSlug("git@github.com:jackjennings/lazyboy"),
    "jackjennings/lazyboy",
  );
});

Deno.test("parseRemoteSlug: extracts slug from non-GitHub remote", () => {
  assertEquals(
    parseRemoteSlug("https://gitlab.com/jackjennings/lazyboy.git"),
    "jackjennings/lazyboy",
  );
});

Deno.test("parseRemoteSlug: returns null for empty string", () => {
  assertEquals(parseRemoteSlug(""), null);
});

Deno.test("parseRemoteSlug: extracts slug from SSH alias remote with .git suffix", () => {
  assertEquals(
    parseRemoteSlug("git@github-sdx:smarterdx/impression-ui.git"),
    "smarterdx/impression-ui",
  );
});

Deno.test("parseRemoteSlug: extracts slug from SSH alias remote without .git suffix", () => {
  assertEquals(
    parseRemoteSlug("git@github-sdx:org/repo"),
    "org/repo",
  );
});

Deno.test("parseRemoteSlug: extracts slug from different SSH alias remote", () => {
  assertEquals(
    parseRemoteSlug("git@github-work:myorg/repo.git"),
    "myorg/repo",
  );
});

// ── findLocalRepo ────────────────────────────────────────────────────────────

Deno.test("findLocalRepo: finds repo by matching origin remote", async () => {
  const root = await Deno.makeTempDir();
  const orgDir = join(root, "jackjennings");
  const repoDir = join(orgDir, "lazyboy");
  await Deno.mkdir(repoDir, { recursive: true });
  await new Deno.Command("git", { args: ["init"], cwd: repoDir }).output();
  await new Deno.Command("git", {
    args: [
      "remote",
      "add",
      "origin",
      "https://github.com/jackjennings/lazyboy.git",
    ],
    cwd: repoDir,
  }).output();

  const result = await findLocalRepo([root], "jackjennings/lazyboy");
  assertEquals(result, repoDir);

  await Deno.remove(root, { recursive: true });
});

Deno.test("findLocalRepo: skips non-git org-level directories", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "someorg"));
  const result = await findLocalRepo([root], "jackjennings/lazyboy");
  assertEquals(result, null);
  await Deno.remove(root, { recursive: true });
});

Deno.test("findLocalRepo: returns null when no repo matches", async () => {
  const root = await Deno.makeTempDir();
  const result = await findLocalRepo([root], "jackjennings/lazyboy");
  assertEquals(result, null);
  await Deno.remove(root, { recursive: true });
});

Deno.test("findLocalRepo: skips non-git directories", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "notarepo"));
  const result = await findLocalRepo([root], "jackjennings/lazyboy");
  assertEquals(result, null);
  await Deno.remove(root, { recursive: true });
});

Deno.test("findLocalRepo: returns null for nonexistent root", async () => {
  const result = await findLocalRepo(
    ["/nonexistent/path"],
    "jackjennings/lazyboy",
  );
  assertEquals(result, null);
});

// ── listRepoCorpus ───────────────────────────────────────────────────────────

async function initRepoWithRemote(
  repoPath: string,
  remoteUrl: string,
): Promise<void> {
  await Deno.mkdir(repoPath, { recursive: true });
  await new Deno.Command("git", { args: ["init"], cwd: repoPath }).output();
  await new Deno.Command("git", {
    args: ["remote", "add", "origin", remoteUrl],
    cwd: repoPath,
  }).output();
}

Deno.test("listRepoCorpus: finds local repo and derives slug from remote", async () => {
  const root = await Deno.makeTempDir();
  const repoPath = join(root, "jackjennings", "lazyboy");
  await initRepoWithRemote(
    repoPath,
    "https://github.com/jackjennings/lazyboy.git",
  );

  const result: RepoCandidate[] = await listRepoCorpus([root], []);
  assertEquals(result, [
    { slug: "jackjennings/lazyboy", localPath: repoPath },
  ]);

  await Deno.remove(root, { recursive: true });
});

Deno.test("listRepoCorpus: includes repos from non-GitHub remotes", async () => {
  const root = await Deno.makeTempDir();
  const repoPath = join(root, "jackjennings", "internal");
  await initRepoWithRemote(
    repoPath,
    "https://gitlab.com/jackjennings/internal.git",
  );

  const result = await listRepoCorpus([root], []);
  assertEquals(result, [
    { slug: "jackjennings/internal", localPath: repoPath },
  ]);

  await Deno.remove(root, { recursive: true });
});

Deno.test("listRepoCorpus: skips directories with no git remote", async () => {
  const root = await Deno.makeTempDir();
  const repoPath = join(root, "jackjennings", "norepo");
  await Deno.mkdir(repoPath, { recursive: true });
  await new Deno.Command("git", { args: ["init"], cwd: repoPath }).output();

  const result = await listRepoCorpus([root], []);
  assertEquals(result, []);

  await Deno.remove(root, { recursive: true });
});

Deno.test("listRepoCorpus: tolerates a nonexistent root", async () => {
  const result = await listRepoCorpus(["/nonexistent/path"], []);
  assertEquals(result, []);
});

Deno.test("listRepoCorpus: adds configuredRepos not found locally, with null localPath", async () => {
  const root = await Deno.makeTempDir();

  const result = await listRepoCorpus([root], ["myorg/frontend"]);
  assertEquals(result, [{ slug: "myorg/frontend", localPath: null }]);

  await Deno.remove(root, { recursive: true });
});

Deno.test("listRepoCorpus: local match wins over configuredRepos duplicate", async () => {
  const root = await Deno.makeTempDir();
  const repoPath = join(root, "myorg", "frontend");
  await initRepoWithRemote(repoPath, "git@github.com:myorg/frontend.git");

  const result = await listRepoCorpus([root], ["myorg/frontend"]);
  assertEquals(result, [{ slug: "myorg/frontend", localPath: repoPath }]);

  await Deno.remove(root, { recursive: true });
});

Deno.test("listRepoCorpus: returns empty array when no roots and no configuredRepos", async () => {
  const result = await listRepoCorpus([], []);
  assertEquals(result, []);
});

Deno.test("listRepoCorpus: finds repo cloned via SSH host alias", async () => {
  const root = await Deno.makeTempDir();
  const repoPath = join(root, "myorg", "myrepo");
  await initRepoWithRemote(repoPath, "git@github-sdx:myorg/myrepo.git");

  const result = await listRepoCorpus([root], []);
  assertEquals(result, [{ slug: "myorg/myrepo", localPath: repoPath }]);

  await Deno.remove(root, { recursive: true });
});

// ── formatRepoCorpus ─────────────────────────────────────────────────────────

Deno.test("formatRepoCorpus: returns empty string for empty input", () => {
  assertEquals(formatRepoCorpus([]), "");
});

Deno.test("formatRepoCorpus: renders a local candidate with its path", () => {
  const result = formatRepoCorpus([
    { slug: "jackjennings/lazyboy", localPath: "/code/jackjennings/lazyboy" },
  ]);
  assertEquals(
    result,
    "## Available Repositories\n\n" +
      "- jackjennings/lazyboy (checked out at /code/jackjennings/lazyboy)\n",
  );
});

Deno.test("formatRepoCorpus: renders a remote-only candidate", () => {
  const result = formatRepoCorpus([
    { slug: "myorg/frontend", localPath: null },
  ]);
  assertEquals(
    result,
    "## Available Repositories\n\n" +
      "- myorg/frontend (not checked out locally)\n",
  );
});

Deno.test("formatRepoCorpus: renders multiple candidates in order given", () => {
  const result = formatRepoCorpus([
    { slug: "jackjennings/lazyboy", localPath: "/code/jackjennings/lazyboy" },
    { slug: "myorg/frontend", localPath: null },
  ]);
  assertEquals(
    result,
    "## Available Repositories\n\n" +
      "- jackjennings/lazyboy (checked out at /code/jackjennings/lazyboy)\n" +
      "- myorg/frontend (not checked out locally)\n",
  );
});

// ── createWorktree ───────────────────────────────────────────────────────────

Deno.test("createWorktree: creates branch and worktree directory", async () => {
  const repoDir = await Deno.makeTempDir();
  const ticketId = `gh-test-${Date.now()}`;
  let info: WorktreeInfo | undefined;

  try {
    await new Deno.Command("git", { args: ["init"], cwd: repoDir }).output();
    await new Deno.Command("git", {
      args: ["config", "user.email", "test@test.com"],
      cwd: repoDir,
    }).output();
    await new Deno.Command("git", {
      args: ["config", "user.name", "Test"],
      cwd: repoDir,
    }).output();
    await new Deno.Command("git", {
      args: ["config", "commit.gpgsign", "false"],
      cwd: repoDir,
    }).output();
    await Deno.writeTextFile(join(repoDir, "README.md"), "test");
    await new Deno.Command("git", { args: ["add", "."], cwd: repoDir })
      .output();
    await new Deno.Command("git", {
      args: ["commit", "-m", "init"],
      cwd: repoDir,
    }).output();
    await new Deno.Command("git", {
      args: ["branch", "-m", "main"],
      cwd: repoDir,
    }).output();
    const { stdout: sha } = await runGit(["rev-parse", "HEAD"], repoDir);
    await runGit(["update-ref", "refs/remotes/origin/main", sha], repoDir);

    info = await createWorktree(repoDir, ticketId, "jackjennings/lazyboy");

    const stat = await Deno.stat(info.path);
    assert(stat.isDirectory);
    assertEquals(info.branch, ticketId);
    assert(info.path.endsWith("jackjennings/lazyboy"));
  } finally {
    // cleanup
    if (info) {
      await new Deno.Command("git", {
        args: ["worktree", "remove", "--force", info.path],
        cwd: repoDir,
      }).output();
    }
    await Deno.remove(
      join(Deno.env.get("HOME")!, ".urras", "worktrees", ticketId),
      { recursive: true },
    );
    await Deno.remove(repoDir, { recursive: true });
  }
});

// ── createWorktreeTestable ───────────────────────────────────────────────────

Deno.test(
  "createWorktreeTestable: with branch uses encodeURIComponent(branch) as path segment and branch as git branch name",
  async () => {
    const gitCalls: { args: string[]; cwd: string }[] = [];
    const mkdirCalls: string[] = [];

    const wt = await createWorktreeTestable({
      repoPath: "/repos/org/repo",
      ticketId: "github/org/repo/1",
      slug: "org/repo",
      branch: "feature/my-work",
      runGit: (args, cwd) => {
        gitCalls.push({ args, cwd });
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      mkdir: (path) => {
        mkdirCalls.push(path);
        return Promise.resolve();
      },
    });

    assert(
      wt.path.endsWith(`/org/repo/${encodeURIComponent("feature/my-work")}`),
    );
    assertEquals(wt.branch, "feature/my-work");

    const addCall = gitCalls.find((c) => c.args[0] === "worktree");
    assertNotEquals(addCall, undefined);
    assertEquals(addCall!.args[3], "feature/my-work");
  },
);

Deno.test(
  "createWorktreeTestable: without branch uses existing behavior",
  async () => {
    const gitCalls: { args: string[]; cwd: string }[] = [];

    const wt = await createWorktreeTestable({
      repoPath: "/repos/org/repo",
      ticketId: "github/org/repo/1",
      slug: "org/repo",
      branch: undefined,
      runGit: (args, cwd) => {
        gitCalls.push({ args, cwd });
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      mkdir: () => Promise.resolve(),
    });

    assert(wt.path.endsWith("/org/repo"));
    assertEquals(wt.branch, "github/org/repo/1");
    const addCall = gitCalls.find((c) => c.args[0] === "worktree");
    assertEquals(addCall!.args[3], "github/org/repo/1");
  },
);

// ── parseIntakeScope ─────────────────────────────────────────────────────────

Deno.test("parseIntakeScope: returns [] for empty string", () => {
  assertEquals(parseIntakeScope(""), []);
});

Deno.test(
  "parseIntakeScope: returns [] when Proposed Scope section is absent",
  () => {
    assertEquals(parseIntakeScope("## Reasoning\n\nSome text.\n"), []);
  },
);

Deno.test(
  "parseIntakeScope: returns [] when fenced code block is absent",
  () => {
    assertEquals(
      parseIntakeScope("## Proposed Scope\n\nNo code block here.\n"),
      [],
    );
  },
);

Deno.test("parseIntakeScope: returns [] for empty scope list", () => {
  assertEquals(
    parseIntakeScope(
      "## Proposed Scope\n\n```yaml\nscope: []\n```\n\n## Reasoning\n\nText.\n",
    ),
    [],
  );
});

Deno.test("parseIntakeScope: extracts single local path entry", () => {
  const content =
    "## Proposed Scope\n\n```yaml\nscope:\n  - /code/myorg/repo\n```\n\n## Reasoning\n\nText.\n";
  assertEquals(parseIntakeScope(content), [
    { entry: "/code/myorg/repo", isNew: false },
  ]);
});

Deno.test("parseIntakeScope: extracts multiple entries", () => {
  const content =
    "## Proposed Scope\n\n```yaml\nscope:\n  - ~/code/org/a\n  - org/repo\n```\n\n## Reasoning\n\nText.\n";
  assertEquals(parseIntakeScope(content), [
    { entry: "~/code/org/a", isNew: false },
    { entry: "org/repo", isNew: false },
  ]);
});

Deno.test("parseIntakeScope: ignores content after the section", () => {
  const content =
    "## Proposed Scope\n\n```yaml\nscope:\n  - /code/repo\n```\n\n## Reasoning\n\nAnother section with ```yaml\nscope:\n  - /other\n````.\n";
  assertEquals(parseIntakeScope(content), [
    { entry: "/code/repo", isNew: false },
  ]);
});

Deno.test("parseIntakeScope: detects (new) suffix on GitHub slug", () => {
  const content =
    "## Proposed Scope\n\n```yaml\nscope:\n  - org/new-repo (new)\n```\n\n## Reasoning\n\nText.\n";
  assertEquals(parseIntakeScope(content), [
    { entry: "org/new-repo", isNew: true },
  ]);
});

Deno.test("parseIntakeScope: handles (new) with extra whitespace", () => {
  const content =
    "## Proposed Scope\n\n```yaml\nscope:\n  - org/new-repo  (new)\n```\n\n## Reasoning\n\nText.\n";
  assertEquals(parseIntakeScope(content), [
    { entry: "org/new-repo", isNew: true },
  ]);
});

Deno.test("parseIntakeScope: (new) on local path is detected with isNew: true", () => {
  const content =
    "## Proposed Scope\n\n```yaml\nscope:\n  - /usr/local/myproject (new)\n```\n\n## Reasoning\n\nText.\n";
  assertEquals(parseIntakeScope(content), [
    { entry: "/usr/local/myproject", isNew: true },
  ]);
});

Deno.test("parseIntakeScope: mixes (new) and plain entries", () => {
  const content =
    "## Proposed Scope\n\n```yaml\nscope:\n  - org/existing\n  - org/new-repo (new)\n```\n\n## Reasoning\n\nText.\n";
  assertEquals(parseIntakeScope(content), [
    { entry: "org/existing", isNew: false },
    { entry: "org/new-repo", isNew: true },
  ]);
});

// ── resolveGitHubSlug ────────────────────────────────────────────────────────

Deno.test("resolveGitHubSlug: returns null for local absolute path", () => {
  assertEquals(resolveGitHubSlug("/code/myorg/repo"), null);
});

Deno.test("resolveGitHubSlug: returns null for tilde-prefixed path", () => {
  assertEquals(resolveGitHubSlug("~/code/myorg/repo"), null);
});

Deno.test("resolveGitHubSlug: returns slug for valid org/repo entry", () => {
  assertEquals(resolveGitHubSlug("myorg/myrepo"), "myorg/myrepo");
});

Deno.test(
  "resolveGitHubSlug: slug components allow dots, hyphens, underscores",
  () => {
    assertEquals(
      resolveGitHubSlug("my-org.v2/my_repo.v2"),
      "my-org.v2/my_repo.v2",
    );
  },
);

Deno.test(
  "resolveGitHubSlug: returns null for slug with more than two components",
  () => {
    assertEquals(resolveGitHubSlug("org/repo/extra"), null);
  },
);

Deno.test(
  "resolveGitHubSlug: returns null for single-component string",
  () => {
    assertEquals(resolveGitHubSlug("justarepo"), null);
  },
);

Deno.test(
  "resolveGitHubSlug: extracts slug from full github.com issue URL",
  () => {
    assertEquals(
      resolveGitHubSlug("https://github.com/myorg/myrepo/issues/1"),
      "myorg/myrepo",
    );
  },
);

Deno.test(
  "resolveGitHubSlug: extracts slug from bare github.com repo URL",
  () => {
    assertEquals(
      resolveGitHubSlug("https://github.com/myorg/myrepo"),
      "myorg/myrepo",
    );
  },
);

Deno.test(
  "resolveGitHubSlug: returns null for github.com URL with only org",
  () => {
    assertEquals(resolveGitHubSlug("https://github.com/myorg"), null);
  },
);

Deno.test(
  "resolveGitHubSlug: returns null for non-github https URL",
  () => {
    assertEquals(resolveGitHubSlug("https://gitlab.com/org/repo"), null);
  },
);

// ── cloneRemoteRepo ──────────────────────────────────────────────────────────

Deno.test(
  "cloneRemoteRepo: returns existing path without calling clone",
  async () => {
    const home = await Deno.makeTempDir();
    const orgDir = join(home, ".urras", "repositories", "org");
    const repoDir = join(orgDir, "repo");
    await Deno.mkdir(repoDir, { recursive: true });

    const originalHome = Deno.env.get("HOME")!;
    Deno.env.set("HOME", home);
    try {
      const result = await cloneRemoteRepo(
        "org/repo",
        () => Promise.reject(new Error("clone should not be called")),
      );
      assertEquals(result, repoDir);
    } finally {
      Deno.env.set("HOME", originalHome);
      await Deno.remove(home, { recursive: true });
    }
  },
);

Deno.test("cloneRemoteRepo: calls clone when repo does not exist", async () => {
  const home = await Deno.makeTempDir();
  const cloneCalls: Array<{ slug: string; destDir: string; cwd: string }> = [];

  const originalHome = Deno.env.get("HOME")!;
  Deno.env.set("HOME", home);
  try {
    const result = await cloneRemoteRepo(
      "org/repo",
      (slug, destDir, cwd) => {
        cloneCalls.push({ slug, destDir, cwd });
        return Promise.resolve();
      },
    );
    assertEquals(cloneCalls.length, 1);
    assertEquals(cloneCalls[0].slug, "org/repo");
    assertEquals(cloneCalls[0].destDir, "repo");
    assertEquals(
      result,
      join(home, ".urras", "repositories", "org", "repo"),
    );
  } finally {
    Deno.env.set("HOME", originalHome);
    await Deno.remove(home, { recursive: true });
  }
});

// ── removeWorktree ───────────────────────────────────────────────────────────

Deno.test("removeWorktree: removes the worktree directory and its branch", async () => {
  const repoDir = await Deno.makeTempDir();
  const wtParent = await Deno.makeTempDir();
  const wtPath = join(wtParent, "my-branch");

  try {
    await new Deno.Command("git", { args: ["init"], cwd: repoDir }).output();
    await new Deno.Command("git", {
      args: ["config", "user.email", "test@test.com"],
      cwd: repoDir,
    }).output();
    await new Deno.Command("git", {
      args: ["config", "user.name", "Test"],
      cwd: repoDir,
    }).output();
    await new Deno.Command("git", {
      args: ["config", "commit.gpgsign", "false"],
      cwd: repoDir,
    }).output();
    await Deno.writeTextFile(join(repoDir, "README.md"), "test");
    await new Deno.Command("git", { args: ["add", "."], cwd: repoDir })
      .output();
    await new Deno.Command("git", {
      args: ["commit", "-m", "init"],
      cwd: repoDir,
    }).output();
    await new Deno.Command("git", {
      args: ["branch", "-m", "main"],
      cwd: repoDir,
    }).output();
    await new Deno.Command("git", {
      args: ["worktree", "add", "-b", "my-branch", wtPath, "main"],
      cwd: repoDir,
    }).output();

    await removeWorktree({ path: wtPath, branch: "my-branch" });

    let exists = true;
    try {
      await Deno.stat(wtPath);
    } catch {
      exists = false;
    }
    assertFalse(exists);

    const { stdout } = await runGit(
      ["branch", "--list", "my-branch"],
      repoDir,
    );
    assertEquals(stdout, "");
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(wtParent, { recursive: true }).catch(() => {});
  }
});

Deno.test("removeWorktree: throws when worktree path does not exist", async () => {
  await assertRejects(
    () => removeWorktree({ path: "/nonexistent/path", branch: "any" }),
    Error,
  );
});

Deno.test(
  "createWorktree: falls back to main when origin/main does not exist",
  async () => {
    const repoDir = await Deno.makeTempDir();
    const ticketId = `gh-noremote-${Date.now()}`;
    let info: WorktreeInfo | undefined;

    try {
      await new Deno.Command("git", {
        args: ["init", "-b", "main"],
        cwd: repoDir,
      })
        .output();
      await new Deno.Command("git", {
        args: ["config", "user.email", "test@test.com"],
        cwd: repoDir,
      }).output();
      await new Deno.Command("git", {
        args: ["config", "user.name", "Test"],
        cwd: repoDir,
      }).output();
      await new Deno.Command("git", {
        args: ["config", "commit.gpgsign", "false"],
        cwd: repoDir,
      }).output();
      await new Deno.Command("git", {
        args: [
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
        cwd: repoDir,
      }).output();

      info = await createWorktree(repoDir, ticketId, "jackjennings/lazyboy");

      const stat = await Deno.stat(info.path);
      assert(stat.isDirectory);
      assertEquals(info.branch, ticketId);
    } finally {
      if (info) {
        await new Deno.Command("git", {
          args: ["worktree", "remove", "--force", info.path],
          cwd: repoDir,
        }).output();
      }
      await Deno.remove(
        join(Deno.env.get("HOME")!, ".urras", "worktrees", ticketId),
        { recursive: true },
      );
      await Deno.remove(repoDir, { recursive: true });
    }
  },
);

// ── initLocalRepo ─────────────────────────────────────────────────────────────

Deno.test("initLocalRepo: creates repo with main branch and empty commit", async () => {
  const home = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME")!;
  Deno.env.set("HOME", home);
  try {
    const repoDir = await initLocalRepo("myorg/my-new-repo");
    assertEquals(
      repoDir,
      join(home, ".urras", "repositories", "myorg", "my-new-repo"),
    );
    const stat = await Deno.stat(repoDir);
    assert(stat.isDirectory);
    const { code, stdout } = await runGit(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      repoDir,
    );
    assertEquals(code, 0);
    assertEquals(stdout, "main");
  } finally {
    Deno.env.set("HOME", originalHome);
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("initLocalRepo: is idempotent when repo already exists", async () => {
  const home = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME")!;
  Deno.env.set("HOME", home);
  try {
    const first = await initLocalRepo("myorg/my-new-repo");
    const second = await initLocalRepo("myorg/my-new-repo");
    assertEquals(first, second);
    const { code } = await runGit(["status"], first);
    assertEquals(code, 0);
  } finally {
    Deno.env.set("HOME", originalHome);
    await Deno.remove(home, { recursive: true });
  }
});

// ── runGit ───────────────────────────────────────────────────────────────────

Deno.test("runGit: returns stderr alongside stdout and code", async () => {
  const result = await runGit(
    ["invalid-subcommand-that-does-not-exist"],
    Deno.cwd(),
  );
  assertNotEquals(result.code, 0);
  assertEquals(typeof result.stderr, "string");
  assertGreater(result.stderr.length, 0);
});

Deno.test("runGit: returns timeout shape when git subprocess hangs", async () => {
  const tmpDir = await Deno.makeTempDir();
  const fakeGit = join(tmpDir, "git");
  await Deno.writeTextFile(fakeGit, "#!/bin/sh\nexec sleep 9999\n");
  await Deno.chmod(fakeGit, 0o755);

  const originalPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${tmpDir}:${originalPath}`);

  const timeoutMs = 1_000;

  try {
    const start = performance.now();
    const result = await runGit(["fetch", "origin"], tmpDir, { timeoutMs });
    const elapsed = performance.now() - start;

    assertEquals(result.code, 1);
    assertEquals(result.stdout, "");
    assertEquals(result.stderr, "git: timed out after 1s");
    assertGreater(elapsed, timeoutMs * 0.9);
    assertLess(elapsed, timeoutMs + 10_000);
  } finally {
    Deno.env.set("PATH", originalPath);
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── alias-aware findLocalRepo ─────────────────────────────────────────────────

Deno.test("findLocalRepo: matches a checkout whose remote is any alias", async () => {
  const home = await Deno.makeTempDir();
  const orgDir = join(home, "code", "org");
  const repoDir = join(orgDir, "old-name");
  await Deno.mkdir(repoDir, { recursive: true });
  await runGit(["init", "-b", "main", repoDir], orgDir);
  await runGit(
    ["remote", "add", "origin", "https://github.com/org/new-name.git"],
    repoDir,
  );
  const result = await findLocalRepo(
    [join(home, "code")],
    "org/old-name",
    (slug) =>
      slug === "org/old-name" ? ["org/old-name", "org/new-name"] : [slug],
  );
  assertEquals(result, repoDir);
  await Deno.remove(home, { recursive: true });
});

Deno.test(
  "findLocalRepo: org/lazyboy does not match a remote for org/lazyboy-core",
  async () => {
    const home = await Deno.makeTempDir();
    const orgDir = join(home, "code", "org");
    const repoDir = join(orgDir, "lazyboy-core");
    await Deno.mkdir(repoDir, { recursive: true });
    await runGit(["init", "-b", "main", repoDir], orgDir);
    await runGit(
      ["remote", "add", "origin", "https://github.com/org/lazyboy-core.git"],
      repoDir,
    );
    const result = await findLocalRepo([join(home, "code")], "org/lazyboy");
    assertEquals(result, null);
    await Deno.remove(home, { recursive: true });
  },
);

Deno.test("cloneRemoteRepo: reuses existing cache directory for any alias", async () => {
  const home = await Deno.makeTempDir();
  const savedHome = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    const existingDir = join(
      home,
      ".urras",
      "repositories",
      "org",
      "old-name",
    );
    await Deno.mkdir(existingDir, { recursive: true });
    let cloneCalled = false;
    const result = await cloneRemoteRepo(
      "org/new-name",
      () => {
        cloneCalled = true;
        return Promise.resolve();
      },
      (slug) =>
        slug === "org/new-name" ? ["org/old-name", "org/new-name"] : [slug],
    );
    assertFalse(cloneCalled);
    assertEquals(result, existingDir);
  } finally {
    if (savedHome !== undefined) Deno.env.set("HOME", savedHome);
    else Deno.env.delete("HOME");
    await Deno.remove(home, { recursive: true });
  }
});
