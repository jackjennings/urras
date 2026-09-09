import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { appendTickLog } from "./logger.ts";
import { withUrrasDir } from "./test-support.ts";

Deno.test("appendTickLog: writes to combined log without id field", async () => {
  using lazy = withUrrasDir();
  await appendTickLog({ event: "tick-failed", error: "boom" });
  const combined = await Deno.readTextFile(
    join(lazy.path, "log.ndjson"),
  );
  const parsed = JSON.parse(combined.trim());
  assertEquals(parsed.event, "tick-failed");
  assertEquals(parsed.id, undefined);
});

Deno.test("appendTickLog: tick log entry is unchanged", async () => {
  using lazy = withUrrasDir();
  await appendTickLog({ event: "stale-lock" });
  const tick = await Deno.readTextFile(
    join(lazy.path, "tick.ndjson"),
  );
  const parsed = JSON.parse(tick.trim());
  assertEquals(parsed.event, "stale-lock");
  assertEquals(parsed.id, undefined);
});

Deno.test("appendTickLog: tick log write succeeds when combined log write fails", async () => {
  using lazy = withUrrasDir();
  await Deno.mkdir(join(lazy.path, "log.ndjson"), { recursive: true });
  await appendTickLog({ event: "tick-already-running" });
  const tick = await Deno.readTextFile(
    join(lazy.path, "tick.ndjson"),
  );
  assertEquals(JSON.parse(tick.trim()).event, "tick-already-running");
});
