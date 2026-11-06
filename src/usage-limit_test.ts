import { assert, assertEquals, assertExists } from "@std/assert";
import { detectUsageLimit } from "./usage-limit.ts";

const SESSION_STDOUT =
  `{"type":"assistant","message":{"model":"<synthetic>","stop_reason":"stop_sequence","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":"You've hit your session limit · resets 12am (America/Los_Angeles)"}]}}`;

const HTTP_STDOUT =
  `{"type":"result","result":"You've hit your session limit · resets 5:50pm (America/Los_Angeles) (error type rate_limit, HTTP 429, request id req_011CfeBa2CHNzthSTW2J4omM, model sent to the API: claude-sonnet-5)","is_error":true}`;

Deno.test("detectUsageLimit: session limit synthetic event", () => {
  const now = Temporal.ZonedDateTime.from(
    "2026-10-17T10:00:00[America/New_York]",
  );
  const hit = detectUsageLimit({ stdout: SESSION_STDOUT, stderr: "", now });
  assertExists(hit);
  assertEquals(hit!.scope, "session");
  assertExists(hit!.resetAt);
});

Deno.test("detectUsageLimit: session limit http error event", () => {
  const now = Temporal.ZonedDateTime.from(
    "2026-10-17T10:00:00[America/New_York]",
  );
  const hit = detectUsageLimit({ stdout: HTTP_STDOUT, stderr: "", now });
  assertExists(hit);
  assertEquals(hit!.scope, "session");
  assertExists(hit!.resetAt);
});

Deno.test("detectUsageLimit: reset time in the past rolls to next day", () => {
  const now = Temporal.ZonedDateTime.from(
    "2026-10-17T09:00:00[America/Los_Angeles]",
  );
  const stdout =
    `{"type":"assistant","message":{"content":[{"type":"text","text":"You've hit your session limit · resets 12am (America/Los_Angeles)"}]}}`;
  const hit = detectUsageLimit({ stdout, stderr: "", now });
  assertExists(hit);
  assertExists(hit!.resetAt);
  const resetAt = Temporal.Instant.from(hit!.resetAt!);
  assert(Temporal.Instant.compare(resetAt, now.toInstant()) > 0);
});

Deno.test("detectUsageLimit: unparseable time yields null resetAt", () => {
  const stdout =
    `{"type":"assistant","message":{"content":[{"type":"text","text":"You've hit your session limit"}]}}`;
  const hit = detectUsageLimit({
    stdout,
    stderr: "",
    now: Temporal.Now.zonedDateTimeISO(),
  });
  assertExists(hit);
  assertEquals(hit!.resetAt, null);
});

Deno.test("detectUsageLimit: non-limit output returns null", () => {
  const hit = detectUsageLimit({
    stdout: '{"type":"result","result":"done"}',
    stderr: "",
    now: Temporal.Now.zonedDateTimeISO(),
  });
  assertEquals(hit, null);
});

Deno.test("detectUsageLimit: weekly limit yields weekly scope", () => {
  const stdout =
    `You've hit your weekly limit · resets 5pm (America/Los_Angeles)`;
  const hit = detectUsageLimit({
    stdout,
    stderr: "",
    now: Temporal.Now.zonedDateTimeISO(),
  });
  assertExists(hit);
  assertEquals(hit!.scope, "weekly");
});
