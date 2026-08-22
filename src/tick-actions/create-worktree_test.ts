import { assertEquals } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { createWorktreeAction } from "./create-worktree.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";

const BASE = {
  id: "github/myorg/myrepo/1",
  url: "https://github.com/myorg/myrepo/issues/1",
  status: "waiting" as const,
  approvals: [{
    timestamp: "2026-06-23T00:00:00Z",
    actor: "human" as const,
    phase: "intake" as const,
  }],
  created: "2026-06-23T00:00:00Z",
  updated: "2026-06-23T00:00:00Z",
};

function makeAction(
  overrides: Partial<Parameters<typeof createWorktreeAction>[0]> = {},
) {
  return createWorktreeAction({
    roots: ["/code"],
    run: () => Promise.resolve({ code: 1, stdout: "" }),
    canonicalSlugFor: (s) => s,
    findLocalRepo: () => Promise.resolve("/code/myorg/myrepo"),
    createWorktree: (_repo, _id, slug) =>
      Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" }),
    writeTicket: () => Promise.resolve(),
    readIntakeOutput: () => Promise.resolve(null),
    cloneRemoteRepo: () => Promise.reject(new Error("no clone")),
    initLocalRepo: () => Promise.resolve("/repos/org/new-repo"),
    stat: () => Promise.resolve(false),
    appendLog: () => Promise.resolve(),
    applyWorktreeInclude: () => Promise.resolve(),
    ...overrides,
  });
}

// ── applies ──────────────────────────────────────────────────────────────────

Deno.test(
  "createWorktreeAction: applies to intake/waiting/approved ticket with no worktrees",
  () => {
    assertEquals(
      makeAction().applies(makeTicket(BASE)),
      true,
    );
  },
);

Deno.test("createWorktreeAction: does not apply when status is new", () => {
  assertEquals(
    makeAction().applies(makeTicket({ ...BASE, status: "new", approvals: [] })),
    false,
  );
});

Deno.test("createWorktreeAction: does not apply when not approved", () => {
  assertEquals(
    makeAction().applies(makeTicket({ ...BASE, approvals: [] })),
    false,
  );
});

Deno.test(
  "createWorktreeAction: does not apply when worktrees already present",
  () => {
    assertEquals(
      makeAction().applies(
        makeTicket({
          ...BASE,
          worktrees: { "myorg/myrepo": { path: "/wt", branch: "b" } },
        }),
      ),
      false,
    );
  },
);

Deno.test(
  "createWorktreeAction: does not apply when phase is not intake",
  () => {
    assertEquals(
      makeAction().applies(
        makeTicket({ ...BASE, phase: "enrichment", status: "waiting" }),
      ),
      false,
    );
  },
);

Deno.test(
  "createWorktreeAction: does not apply when artifact requires no worktrees",
  () => {
    assertEquals(
      makeAction().applies(makeTicket({ ...BASE, artifacts: ["work"] })),
      false,
    );
  },
);

// ── run: GitHub ticket ───────────────────────────────────────────────────────

Deno.test(
  "createWorktreeAction: GitHub ticket, no intake output → uses URL slug, finds locally",
  async () => {
    const written: TicketState[] = [];
    const result = await makeAction({
      findLocalRepo: () => Promise.resolve("/code/myorg/myrepo"),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.worktrees, {
      "myorg/myrepo": { path: "/wt/myorg/myrepo", branch: "gh-1" },
    });
    assertEquals(result?.scope, []);
    assertEquals(result?.status, "waiting");
    assertEquals(result?.approvals.length, 1);
    assertEquals(written.length, 1);
    assertEquals(written[0].worktrees["myorg/myrepo"].path, "/wt/myorg/myrepo");
  },
);

Deno.test(
  "createWorktreeAction: GitHub ticket, local not found → clones remote",
  async () => {
    const cloneSpy = spy((_slug: string) =>
      Promise.resolve("/clones/myorg/myrepo")
    );
    const createWorktreeSpy = spy(
      (_repo: string, _id: string, slug: string) =>
        Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" }),
    );
    const result = await makeAction({
      findLocalRepo: () => Promise.resolve(null),
      cloneRemoteRepo: cloneSpy,
      createWorktree: createWorktreeSpy,
    }).run(makeTicket(BASE), "/state");

    assertSpyCalls(cloneSpy, 1);
    assertEquals(cloneSpy.calls[0].args[0], "myorg/myrepo");
    assertEquals(result?.worktrees["myorg/myrepo"].path, "/wt/myorg/myrepo");
  },
);

Deno.test(
  "createWorktreeAction: GitHub ticket, clone fails → needs-attention",
  async () => {
    const written: TicketState[] = [];
    const result = await makeAction({
      findLocalRepo: () => Promise.resolve(null),
      cloneRemoteRepo: () => Promise.reject(new Error("clone failed")),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "needs-attention");
    assertEquals(written[0].status, "needs-attention");
  },
);

Deno.test(
  "createWorktreeAction: GitHub ticket, intake adds extra GitHub repo → two worktrees",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - other/repo\n```\n\n## Reasoning\n\nText.\n";
    const createdSlugs: string[] = [];
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      findLocalRepo: (_, slug) => Promise.resolve(`/code/${slug}`),
      createWorktree: (_repo, _id, slug) => {
        createdSlugs.push(slug);
        return Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" });
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(createdSlugs.sort(), ["myorg/myrepo", "other/repo"]);
    assertEquals(Object.keys(result?.worktrees ?? {}).sort(), [
      "myorg/myrepo",
      "other/repo",
    ]);
  },
);

Deno.test(
  "createWorktreeAction: GitHub ticket, same slug in URL and intake → resolved once",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - myorg/myrepo\n```\n\n## Reasoning\n\nText.\n";
    const createdSlugs: string[] = [];
    await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      findLocalRepo: () => Promise.resolve("/code/myorg/myrepo"),
      createWorktree: (_repo, _id, slug) => {
        createdSlugs.push(slug);
        return Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" });
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(createdSlugs, ["myorg/myrepo"]);
  },
);

Deno.test(
  "createWorktreeAction: GitHub ticket, intake has GitHub URL → resolved as slug",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - https://github.com/other/repo/issues/5\n```\n\n## Reasoning\n\nText.\n";
    const createdSlugs: string[] = [];
    await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      findLocalRepo: (_, slug) => Promise.resolve(`/code/${slug}`),
      createWorktree: (_repo, _id, slug) => {
        createdSlugs.push(slug);
        return Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" });
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(createdSlugs.sort(), ["myorg/myrepo", "other/repo"]);
  },
);

Deno.test(
  "createWorktreeAction: intake local path exists → added to ticket.scope, no worktree",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - /usr/local/myproject\n```\n\n## Reasoning\n\nText.\n";
    const createdSlugs: string[] = [];
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      stat: (p) => Promise.resolve(p === "/usr/local/myproject"),
      createWorktree: (_repo, _id, slug) => {
        createdSlugs.push(slug);
        return Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" });
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.scope, ["/usr/local/myproject"]);
    assertEquals(createdSlugs, ["myorg/myrepo"]);
  },
);

Deno.test(
  "createWorktreeAction: intake local path does not exist → omitted from scope",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - /does/not/exist\n```\n\n## Reasoning\n\nText.\n";
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      stat: () => Promise.resolve(false),
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.scope, []);
    assertEquals(result?.status, "waiting");
  },
);

Deno.test(
  "createWorktreeAction: createWorktree throws for one repo → needs-attention, no partial write",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - other/repo\n```\n\n## Reasoning\n\nText.\n";
    const written: TicketState[] = [];
    const callCount = { n: 0 };
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      findLocalRepo: (_, slug) => Promise.resolve(`/code/${slug}`),
      createWorktree: (_repo, _id, _slug) => {
        callCount.n++;
        if (callCount.n === 2) throw new Error("worktree add failed");
        return Promise.resolve({ path: `/wt/myorg/myrepo`, branch: "gh-1" });
      },
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "needs-attention");
    assertEquals(written[0].worktrees, {});
  },
);

// ── run: appendLog on error paths ────────────────────────────────────────────

Deno.test(
  "createWorktreeAction: GitHub ticket, extractGitHubSlug throws → logs github-slug-extraction-failed",
  async () => {
    const logged: object[] = [];
    await makeAction({
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(
      makeTicket({ ...BASE, url: "https://github.com/not-a-valid-issue-url" }),
      "/state",
    );
    assertEquals(logged.length, 1);
    assertEquals(
      (logged[0] as Record<string, unknown>).event,
      "needs-attention",
    );
    assertEquals(
      (logged[0] as Record<string, unknown>).reason,
      "github-slug-extraction-failed",
    );
  },
);

Deno.test(
  "createWorktreeAction: non-GitHub ticket with no GitHub repos → logs no-github-repos",
  async () => {
    const logged: object[] = [];
    await makeAction({
      readIntakeOutput: () => Promise.resolve(null),
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(
      makeTicket({
        ...BASE,
        id: "jira/PROJ-1",
        provider: "jira",
        url: "https://myco.atlassian.net/browse/PROJ-1",
      }),
      "/state",
    );
    assertEquals(logged.length, 1);
    assertEquals(
      (logged[0] as Record<string, unknown>).reason,
      "no-github-repos",
    );
  },
);

Deno.test(
  "createWorktreeAction: clone fails → logs clone-failed",
  async () => {
    const logged: object[] = [];
    await makeAction({
      findLocalRepo: () => Promise.resolve(null),
      cloneRemoteRepo: () => Promise.reject(new Error("clone failed")),
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(logged.length, 1);
    assertEquals(
      (logged[0] as Record<string, unknown>).reason,
      "clone-failed",
    );
    assertEquals(
      (logged[0] as Record<string, unknown>).slug,
      "myorg/myrepo",
    );
    assertEquals(
      (logged[0] as Record<string, unknown>).message,
      "Error: clone failed",
    );
  },
);

Deno.test(
  "createWorktreeAction: createWorktree throws → logs worktree-creation-failed",
  async () => {
    const logged: object[] = [];
    await makeAction({
      findLocalRepo: () => Promise.resolve("/code/myorg/myrepo"),
      createWorktree: () => Promise.reject(new Error("worktree add failed")),
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(logged.length, 1);
    assertEquals(
      (logged[0] as Record<string, unknown>).reason,
      "worktree-creation-failed",
    );
  },
);

// ── run: Jira ticket ─────────────────────────────────────────────────────────

Deno.test(
  "createWorktreeAction: Jira ticket, GitHub slug in intake → creates worktree",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - org/repo\n```\n\n## Reasoning\n\nText.\n";
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      findLocalRepo: () => Promise.resolve("/code/org/repo"),
      createWorktree: (_repo, _id, slug) =>
        Promise.resolve({ path: `/wt/${slug}`, branch: "jira-1" }),
    }).run(
      makeTicket({
        ...BASE,
        id: "jira/PROJ-1",
        provider: "jira",
        url: "https://myco.atlassian.net/browse/PROJ-1",
      }),
      "/state",
    );

    assertEquals(result?.worktrees, {
      "org/repo": { path: "/wt/org/repo", branch: "jira-1" },
    });
    assertEquals(result?.status, "waiting");
  },
);

Deno.test(
  "createWorktreeAction: Jira ticket, no GitHub repos in intake → needs-attention",
  async () => {
    const written: TicketState[] = [];
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(null),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(
      makeTicket({
        ...BASE,
        id: "jira/PROJ-1",
        provider: "jira",
        url: "https://myco.atlassian.net/browse/PROJ-1",
      }),
      "/state",
    );

    assertEquals(result?.status, "needs-attention");
    assertEquals(written[0].status, "needs-attention");
  },
);

Deno.test(
  "createWorktreeAction: Jira ticket, only local paths in intake → needs-attention",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - /local/path\n```\n\n## Reasoning\n\nText.\n";
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      stat: () => Promise.resolve(true),
    }).run(
      makeTicket({
        ...BASE,
        id: "jira/PROJ-1",
        provider: "jira",
        url: "https://myco.atlassian.net/browse/PROJ-1",
      }),
      "/state",
    );

    assertEquals(result?.status, "needs-attention");
  },
);

// ── run: applyWorktreeInclude ─────────────────────────────────────────────────

Deno.test(
  "createWorktreeAction: applyWorktreeInclude called with worktree path and repo path",
  async () => {
    const applySpy = spy((_wt: string, _src: string) => Promise.resolve());
    await makeAction({
      findLocalRepo: () => Promise.resolve("/code/myorg/myrepo"),
      applyWorktreeInclude: applySpy,
    }).run(makeTicket(BASE), "/state");

    assertSpyCalls(applySpy, 1);
    assertEquals(applySpy.calls[0].args[0], "/wt/myorg/myrepo");
    assertEquals(applySpy.calls[0].args[1], "/code/myorg/myrepo");
  },
);

Deno.test(
  "createWorktreeAction: applyWorktreeInclude failure is logged but does not block writeTicket",
  async () => {
    const logged: object[] = [];
    const written: TicketState[] = [];
    const result = await makeAction({
      applyWorktreeInclude: () =>
        Promise.reject(new Error("permission denied")),
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "waiting");
    assertEquals(written.length, 1);
    assertEquals(logged.length, 1);
    assertEquals(
      (logged[0] as Record<string, unknown>).event,
      "worktree-include-failed",
    );
  },
);

Deno.test(
  "createWorktreeAction: applyWorktreeInclude called once per worktree",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - other/repo\n```\n\n## Reasoning\n\nText.\n";
    const applySpy = spy((_wt: string, _src: string) => Promise.resolve());
    await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      findLocalRepo: (_, slug) => Promise.resolve(`/code/${slug}`),
      createWorktree: (_repo, _id, slug) =>
        Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" }),
      applyWorktreeInclude: applySpy,
    }).run(makeTicket(BASE), "/state");

    assertSpyCalls(applySpy, 2);
    const srcPaths = applySpy.calls.map((c) => c.args[1] as string).sort();
    assertEquals(srcPaths, ["/code/myorg/myrepo", "/code/other/repo"]);
  },
);

// ── run: (new) marker ────────────────────────────────────────────────────────

Deno.test(
  "createWorktreeAction: (new) slug calls initLocalRepo and writes newRepos",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - other/new-repo (new)\n```\n\n## Reasoning\n\nText.\n";
    const initSpy = spy((_slug: string) =>
      Promise.resolve("/repos/other/new-repo")
    );
    const written: TicketState[] = [];
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      initLocalRepo: initSpy,
      findLocalRepo: (_, slug) =>
        slug === "myorg/myrepo"
          ? Promise.resolve("/code/myorg/myrepo")
          : Promise.resolve(null),
      createWorktree: (_repo, _id, slug) =>
        Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" }),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertSpyCalls(initSpy, 1);
    assertEquals(initSpy.calls[0].args[0], "other/new-repo");
    assertEquals(result?.newRepos, ["other/new-repo"]);
    assertEquals(written[0].newRepos, ["other/new-repo"]);
    assertEquals(result?.status, "waiting");
  },
);

Deno.test(
  "createWorktreeAction: (new) on local path → needs-attention with new-marker-on-local-path",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - /usr/local/myproject (new)\n```\n\n## Reasoning\n\nText.\n";
    const logged: object[] = [];
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "needs-attention");
    assertEquals(
      (logged[1] as Record<string, unknown>).reason,
      "new-marker-on-local-path",
    );
  },
);

Deno.test(
  "createWorktreeAction: GitHub ticket, intake extra GitHub slug → slug persisted in scope",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - other/repo\n```\n\n## Reasoning\n\nText.\n";
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      findLocalRepo: (_, slug) => Promise.resolve(`/code/${slug}`),
      createWorktree: (_repo, _id, slug) =>
        Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" }),
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.scope, ["other/repo"]);
  },
);

Deno.test(
  "createWorktreeAction: GitHub ticket, intake GitHub URL as extra scope → resolved slug persisted",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - https://github.com/other/repo/issues/5\n```\n\n## Reasoning\n\nText.\n";
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      findLocalRepo: (_, slug) => Promise.resolve(`/code/${slug}`),
      createWorktree: (_repo, _id, slug) =>
        Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" }),
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.scope, ["other/repo"]);
  },
);

Deno.test(
  "createWorktreeAction: alias collision — URL slug and scope alias resolve to same canonical slug → one createWorktree call, worktrees keyed on canonical slug, scope uses canonical slug",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - org/repo-old\n```\n\n## Reasoning\n\nText.\n";
    const createdSlugs: string[] = [];
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      canonicalSlugFor: (s) =>
        s === "org/repo-old" || s === "org/repo-new" ? "org/repo-new" : s,
      findLocalRepo: () => Promise.resolve("/code/org/repo-new"),
      createWorktree: (_repo, _id, slug) => {
        createdSlugs.push(slug);
        return Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" });
      },
    }).run(
      makeTicket({
        ...BASE,
        id: "github/org/repo-new/1",
        url: "https://github.com/org/repo-new/issues/1",
      }),
      "/state",
    );

    assertEquals(createdSlugs, ["org/repo-new"]);
    assertEquals(Object.keys(result?.worktrees ?? {}), ["org/repo-new"]);
    assertEquals(result?.scope, ["org/repo-new"]);
  },
);

Deno.test(
  "createWorktreeAction: initLocalRepo failure → needs-attention with local-repo-init-failed",
  async () => {
    const intakeContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - other/new-repo (new)\n```\n\n## Reasoning\n\nText.\n";
    const logged: object[] = [];
    const result = await makeAction({
      readIntakeOutput: () => Promise.resolve(intakeContent),
      initLocalRepo: () => Promise.reject(new Error("git init failed")),
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "needs-attention");
    assertEquals(
      (logged[1] as Record<string, unknown>).reason,
      "local-repo-init-failed",
    );
    assertEquals(
      (logged[1] as Record<string, unknown>).slug,
      "other/new-repo",
    );
  },
);
