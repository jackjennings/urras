import { assertEquals } from "@std/assert";
import { runUpdate, updateExtensionsIfRemote } from "./update.ts";

function makeRunGit(
  responses: Array<{ code: number; stdout: string; stderr: string }>,
) {
  const calls: string[][] = [];
  const fn = (args: string[], _cwd: string) => {
    calls.push(args);
    return Promise.resolve(responses[calls.length - 1]);
  };
  return { fn, calls };
}

Deno.test("runUpdate: dirty tree reports dirty", async () => {
  const { fn } = makeRunGit([
    { code: 0, stdout: "M src/foo.ts", stderr: "" },
  ]);
  assertEquals(await runUpdate("/repo", fn), { status: "dirty" });
});

Deno.test("runUpdate: already up to date reports current", async () => {
  const sha = "abc123";
  const { fn } = makeRunGit([
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: sha, stderr: "" },
    { code: 0, stdout: "Already up to date.", stderr: "" },
    { code: 0, stdout: sha, stderr: "" },
  ]);
  assertEquals(await runUpdate("/repo", fn), { status: "current" });
});

Deno.test("runUpdate: new commits report pulled", async () => {
  const { fn } = makeRunGit([
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "abc123", stderr: "" },
    { code: 0, stdout: "Updating abc123..def456", stderr: "" },
    { code: 0, stdout: "def456", stderr: "" },
  ]);
  assertEquals(await runUpdate("/repo", fn), { status: "pulled" });
});

Deno.test(
  "runUpdate: refused fast-forward reports diverged with ahead/behind counts",
  async () => {
    const { fn, calls } = makeRunGit([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "abc123", stderr: "" },
      {
        code: 128,
        stdout: "",
        stderr: "fatal: Not possible to fast-forward, aborting.",
      },
      { code: 0, stdout: "2\t3", stderr: "" },
    ]);
    assertEquals(await runUpdate("/repo", fn), {
      status: "diverged",
      divergence: { ahead: 3, behind: 2 },
    });
    assertEquals(calls[3], [
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]);
  },
);

Deno.test(
  "runUpdate: pull failure with no divergence reports failed",
  async () => {
    const { fn } = makeRunGit([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "abc123", stderr: "" },
      { code: 1, stdout: "", stderr: "fatal: could not read from remote" },
      { code: 0, stdout: "0\t0", stderr: "" },
    ]);
    assertEquals(await runUpdate("/repo", fn), { status: "failed", code: 1 });
  },
);

Deno.test(
  "runUpdate: pull failure with unreadable upstream reports failed",
  async () => {
    const { fn } = makeRunGit([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "abc123", stderr: "" },
      { code: 128, stdout: "", stderr: "fatal: not a git repository" },
      { code: 128, stdout: "", stderr: "fatal: no upstream configured" },
    ]);
    assertEquals(await runUpdate("/repo", fn), { status: "failed", code: 128 });
  },
);

Deno.test(
  "runUpdate: behind-only pull failure reports failed, not diverged",
  async () => {
    const { fn } = makeRunGit([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "abc123", stderr: "" },
      { code: 1, stdout: "", stderr: "fatal: unrelated" },
      { code: 0, stdout: "4\t0", stderr: "" },
    ]);
    assertEquals(await runUpdate("/repo", fn), { status: "failed", code: 1 });
  },
);

Deno.test(
  "updateExtensionsIfRemote: no remote returns null without further calls",
  async () => {
    const { fn, calls } = makeRunGit([
      { code: 128, stdout: "", stderr: "error: No such remote 'origin'" },
    ]);
    const result = await updateExtensionsIfRemote("/ext", fn);
    assertEquals(result, null);
    assertEquals(calls, [["remote", "get-url", "origin"]]);
  },
);

Deno.test(
  "updateExtensionsIfRemote: remote present delegates to runUpdate",
  async () => {
    const sha = "abc123";
    const { fn } = makeRunGit([
      { code: 0, stdout: "git@github.com:user/repo.git", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: sha, stderr: "" },
      { code: 0, stdout: "Already up to date.", stderr: "" },
      { code: 0, stdout: sha, stderr: "" },
    ]);
    const result = await updateExtensionsIfRemote("/ext", fn);
    assertEquals(result, { status: "current" });
  },
);
