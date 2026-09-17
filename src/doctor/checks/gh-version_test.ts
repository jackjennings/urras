import { assertEquals } from "@std/assert";
import { ghVersionCheck } from "./gh-version.ts";

function makeRunner(code: number, stdout: string) {
  return (_args: string[]) => Promise.resolve({ code, stdout });
}

Deno.test("ghVersionCheck: gh absent (non-zero exit) returns fail", async () => {
  const check = ghVersionCheck({ runCommand: makeRunner(1, "") });
  const result = await check.run();
  assertEquals(result.status, "fail");
  assertEquals(result.detail, "gh not found");
  assertEquals(result.remedy, "brew install gh");
});

Deno.test(
  "ghVersionCheck: version below 2.99.0 returns fail with version in detail",
  async () => {
    const check = ghVersionCheck({
      runCommand: makeRunner(
        0,
        "gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli/releases/tag/v2.96.0",
      ),
    });
    const result = await check.run();
    assertEquals(result.status, "fail");
    assertEquals(result.detail, "gh 2.99.0 or later required, found 2.96.0");
    assertEquals(result.remedy, "brew upgrade gh");
  },
);

Deno.test("ghVersionCheck: version exactly 2.99.0 returns pass", async () => {
  const check = ghVersionCheck({
    runCommand: makeRunner(
      0,
      "gh version 2.99.0 (2026-09-01)\nhttps://github.com/cli/cli/releases/tag/v2.99.0",
    ),
  });
  const result = await check.run();
  assertEquals(result.status, "pass");
});

Deno.test("ghVersionCheck: version above 2.99.0 returns pass", async () => {
  const check = ghVersionCheck({
    runCommand: makeRunner(
      0,
      "gh version 3.0.0 (2026-10-01)\nhttps://github.com/cli/cli/releases/tag/v3.0.0",
    ),
  });
  const result = await check.run();
  assertEquals(result.status, "pass");
});
