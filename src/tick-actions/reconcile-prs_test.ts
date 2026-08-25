import { assertEquals } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { reconcilePRsAction } from "./reconcile-prs.ts";
import type { TicketState } from "../state/types.ts";

function makeTicket(overrides: Partial<TicketState> = {}): TicketState {
  return {
    id: "github/myorg/myrepo/42",
    provider: "github",
    title: "T",
    url: "https://github.com/myorg/myrepo/issues/42",
    phase: "implementation",
    status: "waiting",
    approvals: [],
    scope: [],
    worktrees: {
      "myorg/myrepo": { path: "/wt/myorg/myrepo", branch: "gh-42" },
    },
    created: "2026-06-23T00:00:00Z",
    updated: "2026-06-23T00:00:00Z",
    body: "",
    artifacts: ["code"],
    ...overrides,
  };
}

function makeAction(
  overrides: Partial<Parameters<typeof reconcilePRsAction>[0]> = {},
) {
  return reconcilePRsAction({
    readImplementationOutput: () => Promise.resolve(null),
    getPRInfo: () =>
      Promise.resolve({
        url: "",
        title: "",
        baseRefName: "",
        headRefName: "",
      }),
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    ...overrides,
  });
}

// ── applies ──────────────────────────────────────────────────────────────────

Deno.test(
  "reconcilePRsAction: applies when implementation/waiting and prs absent",
  () => {
    assertEquals(makeAction().applies(makeTicket()), true);
  },
);

Deno.test(
  "reconcilePRsAction: applies when implementation/waiting and prs is empty array",
  () => {
    assertEquals(makeAction().applies(makeTicket({ prs: [] })), true);
  },
);

Deno.test(
  "reconcilePRsAction: does not apply when prs is already populated",
  () => {
    assertEquals(
      makeAction().applies(
        makeTicket({
          prs: [{
            url: "https://github.com/myorg/myrepo/pull/1",
            title: "A",
            dependsOn: [],
            merged: false,
          }],
        }),
      ),
      false,
    );
  },
);

Deno.test(
  "reconcilePRsAction: does not apply when phase is not implementation",
  () => {
    assertEquals(
      makeAction().applies(makeTicket({ phase: "merge", status: "waiting" })),
      false,
    );
  },
);

Deno.test(
  "reconcilePRsAction: does not apply when status is not waiting",
  () => {
    assertEquals(
      makeAction().applies(makeTicket({ status: "running" })),
      false,
    );
  },
);

// ── no-PR cases → needs-attention ────────────────────────────────────────────

Deno.test(
  "reconcilePRsAction: missing implementation output → needs-attention with no-prs",
  async () => {
    const written: TicketState[] = [];
    const logged: object[] = [];
    const result = await makeAction({
      readImplementationOutput: () => Promise.resolve(null),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(), "/state");
    assertEquals(result?.status, "needs-attention");
    assertEquals(written.length, 1);
    assertEquals(written[0].status, "needs-attention");
    const attention = (logged as Record<string, string>[]).find((e) =>
      e.event === "needs-attention"
    );
    assertEquals(attention?.reason, "no-prs");
  },
);

Deno.test(
  "reconcilePRsAction: output with no GitHub PR URLs → needs-attention",
  async () => {
    const written: TicketState[] = [];
    const result = await makeAction({
      readImplementationOutput: () =>
        Promise.resolve("Implementation complete, no PRs."),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(makeTicket(), "/state");
    assertEquals(result?.status, "needs-attention");
  },
);

// ── getPRInfo error → parks ──────────────────────────────────────────────────

Deno.test(
  "reconcilePRsAction: getPRInfo throws → parks needs-attention with pr-fetch-failed",
  async () => {
    const written: TicketState[] = [];
    const logged: object[] = [];
    const result = await makeAction({
      readImplementationOutput: () =>
        Promise.resolve("https://github.com/myorg/myrepo/pull/99"),
      getPRInfo: () => {
        throw new Error("network error");
      },
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(), "/state");
    assertEquals(result?.status, "needs-attention");
    assertEquals(written.length, 1);
    assertEquals(written[0].status, "needs-attention");
    const errors = (logged as Record<string, string>[]).filter((e) =>
      e.event === "error"
    );
    assertEquals(errors.length, 1);
    assertEquals(errors[0].context, "reconcilePRs");
    const attention = (logged as Record<string, string>[]).find((e) =>
      e.event === "needs-attention"
    );
    assertEquals(attention?.reason, "pr-fetch-failed");
  },
);

// ── single PR ─────────────────────────────────────────────────────────────────

Deno.test(
  "reconcilePRsAction: single PR — prs populated, dependsOn empty, worktreeKey matched",
  async () => {
    const written: TicketState[] = [];
    const logged: object[] = [];
    const result = await makeAction({
      readImplementationOutput: () =>
        Promise.resolve(
          "## PR\n\nhttps://github.com/myorg/myrepo/pull/99\n",
        ),
      getPRInfo: (url) =>
        Promise.resolve({
          url,
          title: "feat: my change",
          baseRefName: "main",
          headRefName: "gh-42",
        }),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(), "/state");
    assertEquals(result?.prs?.length, 1);
    assertEquals(
      result?.prs?.[0].url,
      "https://github.com/myorg/myrepo/pull/99",
    );
    assertEquals(result?.prs?.[0].title, "feat: my change");
    assertEquals(result?.prs?.[0].dependsOn, []);
    assertEquals(result?.prs?.[0].merged, false);
    assertEquals(result?.prs?.[0].worktreeKey, "myorg/myrepo");
    assertEquals(written.length, 1);
    const reconciled = (logged as Record<string, unknown>[]).find((e) =>
      e.event === "reconciled-prs"
    );
    assertEquals(reconciled?.count, 1);
  },
);

Deno.test(
  "reconcilePRsAction: single PR — worktreeKey derived from PR URL slug",
  async () => {
    const result = await makeAction({
      readImplementationOutput: () =>
        Promise.resolve("https://github.com/myorg/myrepo/pull/99"),
      getPRInfo: (url) =>
        Promise.resolve({
          url,
          title: "T",
          baseRefName: "main",
          headRefName: "some-other-branch",
        }),
    }).run(
      makeTicket({
        worktrees: {
          "myorg/myrepo": { path: "/wt", branch: "gh-42" },
        },
      }),
      "/state",
    );
    assertEquals(result?.prs?.[0].worktreeKey, "myorg/myrepo");
  },
);

Deno.test(
  "reconcilePRsAction: two PRs from different repos — each gets its own worktreeKey",
  async () => {
    const result = await makeAction({
      readImplementationOutput: () =>
        Promise.resolve(
          "https://github.com/myorg/repo-a/pull/1\nhttps://github.com/myorg/repo-b/pull/2",
        ),
      getPRInfo: (url) =>
        Promise.resolve({
          url,
          title: "T",
          baseRefName: "main",
          headRefName: "github/myorg/myrepo/42",
        }),
    }).run(
      makeTicket({
        worktrees: {
          "myorg/repo-a": {
            path: "/wt/repo-a",
            branch: "github/myorg/myrepo/42",
          },
          "myorg/repo-b": {
            path: "/wt/repo-b",
            branch: "github/myorg/myrepo/42",
          },
        },
      }),
      "/state",
    );
    assertEquals(result?.prs?.length, 2);
    assertEquals(result?.prs?.[0].worktreeKey, "myorg/repo-a");
    assertEquals(result?.prs?.[1].worktreeKey, "myorg/repo-b");
  },
);

Deno.test(
  "reconcilePRsAction: duplicate PR URLs in output — deduplicated to one entry",
  async () => {
    const fetchedUrls: string[] = [];
    const result = await makeAction({
      readImplementationOutput: () =>
        Promise.resolve(
          "https://github.com/myorg/myrepo/pull/99\nhttps://github.com/myorg/myrepo/pull/99",
        ),
      getPRInfo: (url) => {
        fetchedUrls.push(url);
        return Promise.resolve({
          url,
          title: "T",
          baseRefName: "main",
          headRefName: "gh-42",
        });
      },
    }).run(makeTicket(), "/state");
    assertEquals(result?.prs?.length, 1);
    assertEquals(fetchedUrls.length, 1);
  },
);

// ── stacked PRs ───────────────────────────────────────────────────────────────

Deno.test(
  "reconcilePRsAction: stacked PRs — base-first order, dependsOn chained",
  async () => {
    const written: TicketState[] = [];
    const result = await makeAction({
      readImplementationOutput: () =>
        Promise.resolve(
          "- PR 1: https://github.com/myorg/myrepo/pull/1\n" +
            "- PR 2: https://github.com/myorg/myrepo/pull/2\n",
        ),
      getPRInfo: (url) => {
        if (url.endsWith("/1")) {
          return Promise.resolve({
            url,
            title: "A",
            baseRefName: "main",
            headRefName: "gh-42",
          });
        }
        return Promise.resolve({
          url,
          title: "B",
          baseRefName: "gh-42",
          headRefName: "gh-42-hud",
        });
      },
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(makeTicket(), "/state");
    assertEquals(result?.prs?.length, 2);
    assertEquals(
      result?.prs?.[0].url,
      "https://github.com/myorg/myrepo/pull/1",
    );
    assertEquals(result?.prs?.[0].dependsOn, []);
    assertEquals(
      result?.prs?.[1].url,
      "https://github.com/myorg/myrepo/pull/2",
    );
    assertEquals(result?.prs?.[1].dependsOn, [
      "https://github.com/myorg/myrepo/pull/1",
    ]);
    assertEquals(result?.prs?.[0].worktreeKey, "myorg/myrepo");
    assertEquals(result?.prs?.[1].worktreeKey, "myorg/myrepo");
    assertEquals(written.length, 1);
  },
);

Deno.test(
  "reconcilePRsAction: stacked PRs listed in reverse order — still sorted base-first",
  async () => {
    const result = await makeAction({
      readImplementationOutput: () =>
        Promise.resolve(
          "https://github.com/myorg/myrepo/pull/2\nhttps://github.com/myorg/myrepo/pull/1",
        ),
      getPRInfo: (url) => {
        if (url.endsWith("/1")) {
          return Promise.resolve({
            url,
            title: "A",
            baseRefName: "main",
            headRefName: "gh-42",
          });
        }
        return Promise.resolve({
          url,
          title: "B",
          baseRefName: "gh-42",
          headRefName: "gh-42-hud",
        });
      },
    }).run(makeTicket(), "/state");
    assertEquals(
      result?.prs?.[0].url,
      "https://github.com/myorg/myrepo/pull/1",
    );
    assertEquals(
      result?.prs?.[1].url,
      "https://github.com/myorg/myrepo/pull/2",
    );
  },
);

Deno.test(
  "reconcilePRsAction: applies when artifacts is ['code', 'document'] and prs absent",
  () => {
    assertEquals(
      makeAction().applies(makeTicket({ artifacts: ["code", "document"] })),
      true,
    );
  },
);

Deno.test(
  "reconcilePRsAction: does not apply when artifacts is ['document']",
  () => {
    assertEquals(
      makeAction().applies(makeTicket({ artifacts: ["document"] })),
      false,
    );
  },
);

Deno.test(
  "reconcilePRsAction: cyclic base/head chain terminates instead of hanging",
  async () => {
    const result = await makeAction({
      readImplementationOutput: () =>
        Promise.resolve(
          "https://github.com/myorg/myrepo/pull/1\nhttps://github.com/myorg/myrepo/pull/2",
        ),
      getPRInfo: (url) =>
        url.endsWith("/1")
          ? Promise.resolve({
            url,
            title: "A",
            baseRefName: "b",
            headRefName: "a",
          })
          : Promise.resolve({
            url,
            title: "B",
            baseRefName: "a",
            headRefName: "b",
          }),
    }).run(makeTicket(), "/state");
    assertEquals(result?.prs?.length, 2);
  },
);

// ── out-of-scope PR → worktreeKey undefined ───────────────────────────────────

Deno.test(
  "reconcilePRsAction: PR from repo not in worktrees and no branch match → worktreeKey undefined",
  async () => {
    const result = await makeAction({
      readImplementationOutput: () =>
        Promise.resolve(
          "https://github.com/myorg/main-repo/pull/1\nhttps://github.com/myorg/dep-repo/pull/2",
        ),
      getPRInfo: (url) =>
        url.includes("main-repo")
          ? Promise.resolve({
            url,
            title: "Main PR",
            baseRefName: "main",
            headRefName: "gh-42",
          })
          : Promise.resolve({
            url,
            title: "Dep PR",
            baseRefName: "main",
            headRefName: "dep-branch",
          }),
    }).run(
      makeTicket({
        worktrees: {
          "myorg/main-repo": { path: "/wt/main-repo", branch: "gh-42" },
        },
      }),
      "/state",
    );
    assertEquals(result?.prs?.length, 2);
    const mainPr = result?.prs?.find((p) => p.url.includes("main-repo"));
    const depPr = result?.prs?.find((p) => p.url.includes("dep-repo"));
    assertEquals(mainPr?.worktreeKey, "myorg/main-repo");
    assertEquals(depPr?.worktreeKey, undefined);
  },
);

// ── writeTicket called exactly once ──────────────────────────────────────────

Deno.test(
  "reconcilePRsAction: writeTicket called exactly once on success",
  async () => {
    const writeTicketSpy = spy(() => Promise.resolve());
    await makeAction({
      readImplementationOutput: () =>
        Promise.resolve("https://github.com/myorg/myrepo/pull/99"),
      getPRInfo: (url) =>
        Promise.resolve({
          url,
          title: "T",
          baseRefName: "main",
          headRefName: "gh-42",
        }),
      writeTicket: writeTicketSpy,
    }).run(makeTicket(), "/state");
    assertSpyCalls(writeTicketSpy, 1);
  },
);

Deno.test(
  "reconcilePRsAction: worktree-key resolved via alias when PR URL carries renamed slug",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      worktrees: {
        "org/old-name": { path: "/wt", branch: "github/org/old-name/1" },
      },
      prs: [],
    });
    let resolvedKey = "";
    await reconcilePRsAction({
      readImplementationOutput: () =>
        Promise.resolve("https://github.com/org/new-name/pull/5"),
      getPRInfo: () =>
        Promise.resolve({
          url: "https://github.com/org/new-name/pull/5",
          title: "PR",
          baseRefName: "main",
          headRefName: "github/org/old-name/1",
        }),
      writeTicket: (_stateDir, t) => {
        resolvedKey = t.prs![0].worktreeKey ?? "";
        return Promise.resolve();
      },
      appendLog: () => Promise.resolve(),
      aliasesForSlug: (slug) =>
        slug === "org/new-name" ? ["org/old-name", "org/new-name"] : [slug],
    }).run(ticket, "/state");
    assertEquals(resolvedKey, "org/old-name");
  },
);
