import { assertEquals, assertStringIncludes } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import {
  createProgramStatusReporter,
  formatProgramStatus,
} from "./program-status.ts";

Deno.test("formatProgramStatus: encodes state, app and base64 message", () => {
  assertEquals(
    formatProgramStatus({ state: "working", app: "urras", message: "hi" }),
    `\x1b]7501;state=working:app=urras:msg=${btoa("hi")}\x1b\\`,
  );
});

Deno.test("formatProgramStatus: clamps progress", () => {
  assertStringIncludes(
    formatProgramStatus({ state: "working", progress: 140 }),
    "progress=100",
  );
});

Deno.test("formatProgramStatus: replaces control characters in text", () => {
  assertStringIncludes(
    formatProgramStatus({ state: "error", message: "a\x1b[31mb" }),
    `msg=${btoa("a [31mb")}`,
  );
});

Deno.test("formatProgramStatus: truncates message to 2048 bytes on a character boundary", () => {
  const sequence = formatProgramStatus({
    state: "error",
    message: "é".repeat(2000),
  });
  const encoded = sequence.match(/msg=([A-Za-z0-9+/=]+)/)![1];
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
  );
  assertEquals(decoded, "é".repeat(1024));
});

Deno.test("formatProgramStatus: stays within the sequence limit", () => {
  const sequence = formatProgramStatus({
    state: "error",
    title: "t".repeat(192),
    message: "m".repeat(2048),
  });
  assertEquals(new TextEncoder().encode(sequence).length <= 4096, true);
});

Deno.test("createProgramStatusReporter: skips repeated identical reports", () => {
  const write = spy((_data: string) => {});
  const report = createProgramStatusReporter({ write, app: "urras" });
  report({ state: "idle" });
  report({ state: "idle" });
  report({ state: "working" });
  assertSpyCalls(write, 2);
});
