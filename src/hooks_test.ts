import { assertEquals, assertLess, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { makeHookRunner } from "./hooks.ts";

function logCollector() {
  const entries: Record<string, unknown>[] = [];
  return {
    entries,
    log: (entry: object) => {
      entries.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  };
}

Deno.test("makeHookRunner: runs the command with the event in its environment", async () => {
  const dir = await Deno.makeTempDir();
  const outputPath = join(dir, "out.txt");
  const { entries, log } = logCollector();
  await makeHookRunner({
    hooks: {
      onStatusChange:
        `printf '%s %s %s' "$URRAS_HOOK" "$URRAS_TICKET" "$URRAS_STATUS" > "${outputPath}"`,
    },
    log,
  })({
    hook: "on_status_change",
    ticket: "jira/PROJ-1",
    env: { URRAS_TICKET: "jira/PROJ-1", URRAS_STATUS: "waiting" },
  });
  assertEquals(
    await Deno.readTextFile(outputPath),
    "on_status_change jira/PROJ-1 waiting",
  );
  assertEquals(entries, []);
});

Deno.test("makeHookRunner: does nothing when the hook is unset", async () => {
  const { entries, log } = logCollector();
  await makeHookRunner({ hooks: { onTickEnd: "exit 1" }, log })({
    hook: "on_tick_start",
  });
  await makeHookRunner({ hooks: undefined, log })({ hook: "on_tick_end" });
  assertEquals(entries, []);
});

Deno.test("makeHookRunner: logs hook-failed on a non-zero exit without throwing", async () => {
  const { entries, log } = logCollector();
  await makeHookRunner({ hooks: { onTickEnd: "exit 3" }, log })({
    hook: "on_tick_end",
  });
  assertEquals(entries, [{
    event: "hook-failed",
    hook: "on_tick_end",
    reason: "non-zero-exit",
    code: 3,
  }]);
});

Deno.test("makeHookRunner: kills a slow hook and logs a timeout", async () => {
  const { entries, log } = logCollector();
  const startedAt = performance.now();
  await makeHookRunner({
    hooks: { onTickStart: "sleep 30", timeoutSeconds: 1 },
    log,
  })({ hook: "on_tick_start" });
  assertEquals(entries.length, 1);
  assertEquals(entries[0].reason, "timeout");
  assertLess(performance.now() - startedAt, 10_000);
});

Deno.test("makeHookRunner: names the ticket in a failed status hook entry", async () => {
  const { entries, log } = logCollector();
  await makeHookRunner({ hooks: { onStatusChange: "exit 1" }, log })({
    hook: "on_status_change",
    ticket: "jira/PROJ-2",
    env: {},
  });
  assertStringIncludes(JSON.stringify(entries[0]), "jira/PROJ-2");
});
