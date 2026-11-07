import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  createBranchWorktreesAction,
  type CreateBranchWorktreesDeps,
} from "./create-branch-worktrees.ts";
import { makeTicket } from "../test-support.ts";

const BASE = {
  id: "github/org/repo/1",
  url: "https://github.com/org/repo/issues/1",
  phase: "implementation" as const,
  status: "waiting" as const,
  worktrees: {},
  prs: [{
    url: "https://github.com/org/repo/pull/10",
    title: "feat",
    dependsOn: [],
    merged: false,
    branch: "feature/abc",
  }],
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-01T00:00:00Z",
};

function makeDeps(
  overrides: Partial<CreateBranchWorktreesDeps> = {},
): CreateBranchWorktreesDeps {
  return {
    findLocalRepo: () => Promise.resolve("/repos/org/repo"),
    createWorktree: () =>
      Promise.resolve({
        path: "/wt/org/repo/feature%2Fabc",
        branch: "feature/abc",
      }),
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    isProcessAlive: () => false,
    roots: ["/repos"],
    ...overrides,
  };
}

Deno.test(
  "createBranchWorktreesAction: applies when unmerged PR has branch with no matching worktree key",
  () => {
    assert(createBranchWorktreesAction(makeDeps()).applies(makeTicket(BASE)));
  },
);

Deno.test(
  "createBranchWorktreesAction: does not apply when worktree already exists for branch key",
  () => {
    assertFalse(
      createBranchWorktreesAction(makeDeps()).applies(
        makeTicket({
          ...BASE,
          worktrees: {
            "org/repo:feature/abc": { path: "/wt", branch: "feature/abc" },
          },
        }),
      ),
    );
  },
);

Deno.test(
  "createBranchWorktreesAction: does not apply when PR has no branch set",
  () => {
    assertFalse(
      createBranchWorktreesAction(makeDeps()).applies(
        makeTicket({
          ...BASE,
          prs: [{
            url: "https://github.com/org/repo/pull/10",
            title: "feat",
            dependsOn: [],
            merged: false,
          }],
        }),
      ),
    );
  },
);

Deno.test(
  "createBranchWorktreesAction: does not apply when status is running",
  () => {
    assertFalse(
      createBranchWorktreesAction(makeDeps()).applies(
        makeTicket({ ...BASE, status: "running" }),
      ),
    );
  },
);

Deno.test(
  "createBranchWorktreesAction: does not apply when status is needs-attention",
  () => {
    assertFalse(
      createBranchWorktreesAction(makeDeps()).applies(
        makeTicket({ ...BASE, status: "needs-attention" }),
      ),
    );
  },
);

Deno.test(
  "createBranchWorktreesAction: does not apply when process is alive",
  () => {
    assertFalse(
      createBranchWorktreesAction(makeDeps({ isProcessAlive: () => true }))
        .applies(makeTicket(BASE)),
    );
  },
);

Deno.test(
  "createBranchWorktreesAction: does not apply when all PRs are merged",
  () => {
    assertFalse(
      createBranchWorktreesAction(makeDeps()).applies(
        makeTicket({
          ...BASE,
          prs: [{
            url: "https://github.com/org/repo/pull/10",
            title: "feat",
            dependsOn: [],
            merged: true,
            branch: "feature/abc",
          }],
        }),
      ),
    );
  },
);

Deno.test(
  "createBranchWorktreesAction: run creates worktree and sets worktreeKey on PR",
  async () => {
    const written: object[] = [];
    const logged: object[] = [];
    const created: { slug: string; branch: string }[] = [];

    const result = await createBranchWorktreesAction(
      makeDeps({
        createWorktree: (_repoPath, _ticketId, slug, branch) => {
          created.push({ slug, branch });
          return Promise.resolve({
            path: `/wt/${slug}/${encodeURIComponent(branch)}`,
            branch,
          });
        },
        writeTicket: (_dir, t) => {
          written.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logged.push(entry);
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE), "/state");

    assertEquals(created, [{ slug: "org/repo", branch: "feature/abc" }]);
    assertEquals(
      (result as { worktrees: Record<string, unknown> }).worktrees[
        "org/repo:feature/abc"
      ],
      {
        path: "/wt/org/repo/feature%2Fabc",
        branch: "feature/abc",
      },
    );
    assertEquals(
      (result as { prs: { worktreeKey: string }[] }).prs[0].worktreeKey,
      "org/repo:feature/abc",
    );
    assertEquals(written.length, 1);
    const logEntry = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "branch-worktrees-created",
    );
    assertEquals(logEntry?.count, 1);
  },
);

Deno.test(
  "createBranchWorktreesAction: no local repo found parks as needs-attention",
  async () => {
    const logged: object[] = [];
    const result = await createBranchWorktreesAction(
      makeDeps({
        findLocalRepo: () => Promise.resolve(null),
        appendLog: (_dir, _id, entry) => {
          logged.push(entry);
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE), "/state");

    assertEquals(
      (result as { status: string } | null)?.status,
      "needs-attention",
    );
    const entry = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "needs-attention",
    );
    assertEquals(entry?.reason, "no-local-repo");
  },
);

Deno.test(
  "createBranchWorktreesAction: createWorktree failure parks as needs-attention",
  async () => {
    const logged: object[] = [];
    const result = await createBranchWorktreesAction(
      makeDeps({
        createWorktree: () => Promise.reject(new Error("disk full")),
        appendLog: (_dir, _id, entry) => {
          logged.push(entry);
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE), "/state");

    assertEquals(
      (result as { status: string } | null)?.status,
      "needs-attention",
    );
    const entry = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "needs-attention",
    );
    assertEquals(entry?.reason, "worktree-creation-failed");
  },
);

Deno.test(
  "createBranchWorktreesAction: ticket with two unmatched PR branches creates two worktrees",
  async () => {
    const created: string[] = [];
    const result = await createBranchWorktreesAction(
      makeDeps({
        createWorktree: (_repoPath, _ticketId, slug, branch) => {
          created.push(branch);
          return Promise.resolve({ path: `/wt/${slug}/${branch}`, branch });
        },
      }),
    ).run(
      makeTicket({
        ...BASE,
        prs: [
          {
            url: "https://github.com/org/repo/pull/10",
            title: "A",
            dependsOn: [],
            merged: false,
            branch: "feature/a",
          },
          {
            url: "https://github.com/org/repo/pull/11",
            title: "B",
            dependsOn: [],
            merged: false,
            branch: "feature/b",
          },
        ],
      }),
      "/state",
    );

    assertEquals(created.sort(), ["feature/a", "feature/b"]);
    assertEquals(
      (result as { worktrees: Record<string, { branch: string }> }).worktrees[
        "org/repo:feature/a"
      ]?.branch,
      "feature/a",
    );
    assertEquals(
      (result as { worktrees: Record<string, { branch: string }> }).worktrees[
        "org/repo:feature/b"
      ]?.branch,
      "feature/b",
    );
  },
);
