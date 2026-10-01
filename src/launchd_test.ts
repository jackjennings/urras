import { assert, assertFalse, assertStringIncludes } from "@std/assert";
import { detectLaunchdEnabled, plistContent } from "./launchd.ts";
import type { LaunchctlRunner } from "./launchd.ts";

Deno.test("plistContent: includes the label", () => {
  assertStringIncludes(
    plistContent("/home/user/.lazyboy"),
    "com.jackjennings.urras",
  );
});

Deno.test("plistContent: KeepAlive is true", () => {
  assertStringIncludes(
    plistContent("/home/user/.lazyboy"),
    "<key>KeepAlive</key>",
  );
});

Deno.test("plistContent: RunAtLoad is true", () => {
  assertStringIncludes(plistContent("/home/user/.lazyboy"), "<true/>");
});

Deno.test("plistContent: sets AbandonProcessGroup so detached phase agents survive tick exit", () => {
  assertStringIncludes(
    plistContent("/home/user/.lazyboy"),
    "<key>AbandonProcessGroup</key>",
  );
});

Deno.test("plistContent: references daemon.sh at lazboyDir", () => {
  assertStringIncludes(
    plistContent("/home/user/.lazyboy"),
    "/home/user/.lazyboy/scripts/daemon.sh",
  );
});

Deno.test("plistContent: does not contain tick.ndjson", () => {
  assertFalse(plistContent("/home/user/.lazyboy").includes("tick.ndjson"));
});

Deno.test("plistContent: does not contain StandardOutPath", () => {
  assertFalse(plistContent("/home/user/.lazyboy").includes("StandardOutPath"));
});

Deno.test("plistContent: does not contain StandardErrorPath", () => {
  assertFalse(
    plistContent("/home/user/.lazyboy").includes("StandardErrorPath"),
  );
});

Deno.test("plistContent: does not contain ExitTimeOut", () => {
  assertFalse(plistContent("/home/user/.lazyboy").includes("ExitTimeOut"));
});

Deno.test(
  "detectLaunchdEnabled: returns false when launchctl is not found",
  async () => {
    const notFound: LaunchctlRunner = (_args) => {
      throw new Deno.errors.NotFound("launchctl");
    };
    assertFalse(await detectLaunchdEnabled(notFound));
  },
);

Deno.test(
  "detectLaunchdEnabled: returns true when launchctl print exits 0",
  async () => {
    const success: LaunchctlRunner = (_args) => Promise.resolve({ code: 0 });
    assert(await detectLaunchdEnabled(success));
  },
);

Deno.test(
  "detectLaunchdEnabled: returns false when launchctl print exits non-zero",
  async () => {
    const notLoaded: LaunchctlRunner = (_args) =>
      Promise.resolve({ code: 113 });
    assertFalse(await detectLaunchdEnabled(notLoaded));
  },
);
