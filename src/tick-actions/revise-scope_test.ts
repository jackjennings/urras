import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { reviseScopeAction } from "./revise-scope.ts";
import type { ReviseScopeDeps } from "./revise-scope.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";

const ENRICHMENT_REVISED =
  "## Relevant Code\n\nSome text.\n\n## Revised Scope\n\n```yaml\nscope:\n  - new/repo\n```\n\n## Open Questions\n\nNone.\n";

const ENRICHMENT_NO_REVISION =
  "## Relevant Code\n\nSome text.\n\n## Open Questions\n\nNone.\n";

const BASE = {
  id: "github/myorg/myrepo/1",
  url: "https://github.com/myorg/myrepo/issues/1",
  phase: "enrichment" as const,
  status: "waiting" as const,
  approvals: [{
    timestamp: "2026-06-23T00:00:00Z",
    actor: "human" as const,
    phase: "enrichment" as const,
  }],
  worktrees: {
    "myorg/myrepo": {
      path: "/wt/myorg/myrepo",
      branch: "github/myorg/myrepo/1",
    },
  },
  scope: ["myorg/myrepo"],
  created: "2026-06-23T00:00:00Z",
  updated: "2026-06-23T00:00:00Z",
};

function makeAction(
  overrides: Partial<ReviseScopeDeps> = {},
): ReturnType<typeof reviseScopeAction> {
  return reviseScopeAction({
    roots: ["/code"],
    canonicalSlugFor: (s) => s,
    findLocalRepo: () => Promise.resolve("/code/new/repo"),
    createWorktree: (_repo, _id, slug) =>
      Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" }),
    removeWorktree: () => Promise.resolve(),
    cloneRemoteRepo: () => Promise.reject(new Error("no clone")),
    applyWorktreeInclude: () => Promise.resolve(),
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    readEnrichmentOutput: () => Promise.resolve(ENRICHMENT_REVISED),
    ...overrides,
  });
}

// ── applies ───────────────────────────────────────────────────────────────────

Deno.test(
  "reviseScopeAction: applies to enrichment/waiting/approved ticket with worktrees",
  () => {
    assertEquals(makeAction().applies(makeTicket(BASE)), true);
  },
);

Deno.test("reviseScopeAction: does not apply when phase is not enrichment", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, phase: "intake" })),
  );
});

Deno.test("reviseScopeAction: does not apply when status is not waiting", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, status: "running" })),
  );
});

Deno.test("reviseScopeAction: does not apply when not approved", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, approvals: [] })),
  );
});

Deno.test("reviseScopeAction: does not apply when no worktrees exist", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, worktrees: {} })),
  );
});

// ── run: early exits ──────────────────────────────────────────────────────────

Deno.test("reviseScopeAction: returns null when no enrichment output", async () => {
  assertEquals(
    await makeAction({
      readEnrichmentOutput: () => Promise.resolve(null),
    }).run(makeTicket(BASE), "/state"),
    null,
  );
});

Deno.test(
  "reviseScopeAction: returns null when enrichment has no Revised Scope section",
  async () => {
    assertEquals(
      await makeAction({
        readEnrichmentOutput: () => Promise.resolve(ENRICHMENT_NO_REVISION),
      }).run(makeTicket(BASE), "/state"),
      null,
    );
  },
);

Deno.test(
  "reviseScopeAction: returns null when revised scope matches existing worktree keys",
  async () => {
    const sameScope =
      "## Revised Scope\n\n```yaml\nscope:\n  - myorg/myrepo\n```\n";
    assertEquals(
      await makeAction({
        readEnrichmentOutput: () => Promise.resolve(sameScope),
      }).run(makeTicket(BASE), "/state"),
      null,
    );
  },
);

// ── run: scope revision ───────────────────────────────────────────────────────

Deno.test(
  "reviseScopeAction: creates new worktree, removes old, updates scope and worktrees",
  async () => {
    const written: TicketState[] = [];
    const logged: object[] = [];
    const removeWorktreeSpy = spy(() => Promise.resolve());
    const createWorktreeSpy = spy((_repo: string, _id: string, slug: string) =>
      Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" })
    );

    const result = await makeAction({
      createWorktree: createWorktreeSpy,
      removeWorktree: removeWorktreeSpy,
      writeTicket: (_sd, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertSpyCalls(createWorktreeSpy, 1);
    assertEquals(createWorktreeSpy.calls[0].args[2], "new/repo");
    assertSpyCalls(removeWorktreeSpy, 1);
    assertEquals(result?.worktrees, {
      "new/repo": { path: "/wt/new/repo", branch: "gh-1" },
    });
    assertEquals(result?.scope, ["new/repo"]);
    assertEquals(result?.status, "waiting");
    assertEquals(written.length, 1);
    assertEquals(
      (logged[0] as Record<string, unknown>).event,
      "scope-revised",
    );
    assertEquals(
      (logged[0] as Record<string, unknown>).removed,
      ["myorg/myrepo"],
    );
    assertEquals(
      (logged[0] as Record<string, unknown>).added,
      ["new/repo"],
    );
  },
);

Deno.test(
  "reviseScopeAction: local paths in existing scope are preserved",
  async () => {
    const result = await makeAction().run(
      makeTicket({ ...BASE, scope: ["myorg/myrepo", "/local/path"] }),
      "/state",
    );
    assertEquals(result?.scope, ["/local/path", "new/repo"]);
  },
);

Deno.test(
  "reviseScopeAction: revised scope with GitHub URL resolves to slug",
  async () => {
    const urlScope =
      "## Revised Scope\n\n```yaml\nscope:\n  - https://github.com/new/repo/issues/5\n```\n";
    const result = await makeAction({
      readEnrichmentOutput: () => Promise.resolve(urlScope),
    }).run(makeTicket(BASE), "/state");
    assertEquals(result?.scope, ["new/repo"]);
    assertEquals(Object.keys(result?.worktrees ?? {}), ["new/repo"]);
  },
);

Deno.test(
  "reviseScopeAction: applyWorktreeInclude failure is logged but does not block",
  async () => {
    const logged: object[] = [];
    const result = await makeAction({
      applyWorktreeInclude: () =>
        Promise.reject(new Error("permission denied")),
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "waiting");
    const events = (logged as Record<string, unknown>[]).map((e) => e.event);
    assertStringIncludes(events.join(","), "worktree-include-failed");
  },
);

// ── run: blocked by open PR ───────────────────────────────────────────────────

Deno.test(
  "reviseScopeAction: parks when an open PR targets a slug being retired",
  async () => {
    const written: TicketState[] = [];
    const logged: object[] = [];
    const removeWorktreeSpy = spy(() => Promise.resolve());

    const result = await makeAction({
      removeWorktree: removeWorktreeSpy,
      writeTicket: (_sd, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(
      makeTicket({
        ...BASE,
        prs: [{
          url: "https://github.com/myorg/myrepo/pull/1",
          title: "feat",
          dependsOn: [],
          merged: false,
          worktreeKey: "myorg/myrepo",
        }],
      }),
      "/state",
    );

    assertEquals(result?.status, "needs-attention");
    assertSpyCalls(removeWorktreeSpy, 0);
    assertEquals(
      (logged[0] as Record<string, unknown>).reason,
      "scope-revision-blocked-by-open-pr",
    );
    assertEquals(written[0].status, "needs-attention");
  },
);

Deno.test(
  "reviseScopeAction: merged PR targeting retired slug does not block",
  async () => {
    const result = await makeAction().run(
      makeTicket({
        ...BASE,
        prs: [{
          url: "https://github.com/myorg/myrepo/pull/1",
          title: "feat",
          dependsOn: [],
          merged: true,
          worktreeKey: "myorg/myrepo",
        }],
      }),
      "/state",
    );
    assertEquals(result?.status, "waiting");
  },
);

// ── run: failure handling ─────────────────────────────────────────────────────

Deno.test(
  "reviseScopeAction: createWorktree failure parks without removing old worktrees",
  async () => {
    const removeWorktreeSpy = spy(() => Promise.resolve());
    const logged: object[] = [];

    const result = await makeAction({
      createWorktree: () =>
        Promise.reject(new Error("git worktree add failed")),
      removeWorktree: removeWorktreeSpy,
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "needs-attention");
    assertSpyCalls(removeWorktreeSpy, 0);
    assertEquals(
      (logged[0] as Record<string, unknown>).reason,
      "worktree-creation-failed",
    );
  },
);

Deno.test(
  "reviseScopeAction: clone failure parks and returns before worktree creation",
  async () => {
    const logged: object[] = [];
    const result = await makeAction({
      findLocalRepo: () => Promise.resolve(null),
      cloneRemoteRepo: () => Promise.reject(new Error("clone failed")),
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "needs-attention");
    assertEquals(
      (logged[0] as Record<string, unknown>).reason,
      "clone-failed",
    );
    assertEquals(
      (logged[0] as Record<string, unknown>).slug,
      "new/repo",
    );
  },
);

Deno.test(
  "reviseScopeAction: removeWorktree failure is logged but does not park",
  async () => {
    const logged: object[] = [];
    const result = await makeAction({
      removeWorktree: () => Promise.reject(new Error("git error")),
      appendLog: (_sd, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "waiting");
    const events = (logged as Record<string, unknown>[]).map((e) => e.event);
    assertStringIncludes(events.join(","), "error");
  },
);

Deno.test(
  "reviseScopeAction: canonicalSlugFor is applied to revised scope slugs",
  async () => {
    const createdSlugs: string[] = [];
    const result = await makeAction({
      canonicalSlugFor: (s) => s === "new/repo-old" ? "new/repo-canonical" : s,
      readEnrichmentOutput: () =>
        Promise.resolve(
          "## Revised Scope\n\n```yaml\nscope:\n  - new/repo-old\n```\n",
        ),
      findLocalRepo: () => Promise.resolve("/code/new/repo-canonical"),
      createWorktree: (_repo, _id, slug) => {
        createdSlugs.push(slug);
        return Promise.resolve({ path: `/wt/${slug}`, branch: "gh-1" });
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(createdSlugs, ["new/repo-canonical"]);
    assertEquals(Object.keys(result?.worktrees ?? {}), ["new/repo-canonical"]);
  },
);
