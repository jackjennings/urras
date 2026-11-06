import { assertEquals } from "@std/assert";
import migration from "./1792185175-backfill-pr-branch.ts";
import { makeTicket } from "../src/test-support.ts";

Deno.test(
  "backfill-pr-branch: sets branch from worktree when PR has worktreeKey",
  async () => {
    const ticket = makeTicket({
      id: "github/org/repo/1",
      worktrees: {
        "org/repo": { path: "/wt/org/repo", branch: "github/org/repo/1" },
      },
      prs: [{
        url: "https://github.com/org/repo/pull/1",
        title: "feat",
        dependsOn: [],
        merged: false,
        worktreeKey: "org/repo",
      }],
    });
    const result = await migration.run(ticket, "/state");
    assertEquals(result.prs?.[0].branch, "github/org/repo/1");
  },
);

Deno.test(
  "backfill-pr-branch: leaves branch undefined when PR has no worktreeKey",
  async () => {
    const ticket = makeTicket({
      id: "github/org/repo/2",
      prs: [{
        url: "https://github.com/org/repo/pull/2",
        title: "feat",
        dependsOn: [],
        merged: false,
      }],
    });
    const result = await migration.run(ticket, "/state");
    assertEquals(result.prs?.[0].branch, undefined);
  },
);

Deno.test(
  "backfill-pr-branch: leaves branch undefined when worktreeKey points to absent entry",
  async () => {
    const ticket = makeTicket({
      id: "github/org/repo/3",
      worktrees: {},
      prs: [{
        url: "https://github.com/org/repo/pull/3",
        title: "feat",
        dependsOn: [],
        merged: false,
        worktreeKey: "org/repo",
      }],
    });
    const result = await migration.run(ticket, "/state");
    assertEquals(result.prs?.[0].branch, undefined);
  },
);

Deno.test(
  "backfill-pr-branch: skips PR that already has branch set",
  async () => {
    const ticket = makeTicket({
      id: "github/org/repo/4",
      worktrees: {
        "org/repo": { path: "/wt/org/repo", branch: "old-branch" },
      },
      prs: [{
        url: "https://github.com/org/repo/pull/4",
        title: "feat",
        dependsOn: [],
        merged: false,
        worktreeKey: "org/repo",
        branch: "already-set",
      }],
    });
    const result = await migration.run(ticket, "/state");
    assertEquals(result.prs?.[0].branch, "already-set");
  },
);

Deno.test(
  "backfill-pr-branch: ticket with no prs is returned unchanged",
  async () => {
    const ticket = makeTicket({ id: "github/org/repo/5" });
    const result = await migration.run(ticket, "/state");
    assertEquals(result.prs, undefined);
  },
);
