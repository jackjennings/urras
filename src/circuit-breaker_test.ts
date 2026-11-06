import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { JsonFileBreaker } from "./circuit-breaker.ts";

function makeBreaker(dir: string) {
  return new JsonFileBreaker("test", join(dir, "breakers"), {
    defaultPauseMinutes: 60,
    appendTickLog: () => Promise.resolve(),
  });
}

Deno.test("JsonFileBreaker: trip then status is open", async () => {
  const dir = await Deno.makeTempDir();
  const breaker = await makeBreaker(dir);
  const future = Temporal.Now.instant().add({ hours: 1 }).toString();
  await breaker.trip({ retryAt: future, reason: "test" });
  const status = await breaker.status(Temporal.Now.instant());
  assertEquals(status.state, "open");
});

Deno.test("JsonFileBreaker: past retryAt status is half-open, never closed", async () => {
  const dir = await Deno.makeTempDir();
  const breaker = await makeBreaker(dir);
  const past = Temporal.Now.instant().subtract({ minutes: 1 }).toString();
  await breaker.trip({ retryAt: past, reason: "test" });
  const status = await breaker.status(Temporal.Now.instant());
  assertEquals(status.state, "half-open");
});

Deno.test("JsonFileBreaker: succeed from half-open closes breaker", async () => {
  const dir = await Deno.makeTempDir();
  const breaker = await makeBreaker(dir);
  const past = Temporal.Now.instant().subtract({ minutes: 1 }).toString();
  await breaker.trip({ retryAt: past, reason: "test" });
  await breaker.succeed();
  const status = await breaker.status(Temporal.Now.instant());
  assertEquals(status.state, "closed");
});

Deno.test("JsonFileBreaker: second trip inside same window does not increment trips", async () => {
  const dir = await Deno.makeTempDir();
  const breaker = await makeBreaker(dir);
  const future = Temporal.Now.instant().add({ hours: 2 }).toString();
  await breaker.trip({ retryAt: future, reason: "first" });
  await breaker.trip({ retryAt: future, reason: "second" });
  const status = await breaker.status(Temporal.Now.instant());
  if (status.state !== "open") throw new Error("expected open");
  assertEquals(status.trips, 1);
});

Deno.test("JsonFileBreaker: trip with retryAt null backs off exponentially", async () => {
  const dir = await Deno.makeTempDir();
  const breaker = await makeBreaker(dir);
  const beforeTrip = Temporal.Now.instant();
  await breaker.trip({ retryAt: null, reason: "auto" });
  const status = await breaker.status(Temporal.Now.instant());
  if (status.state !== "open") throw new Error("expected open");
  const retryAt = Temporal.Instant.from(status.retryAt);
  assert(
    Temporal.Instant.compare(retryAt, beforeTrip.add({ minutes: 59 })) > 0,
    "retry window should be at least ~60 minutes",
  );
});

Deno.test("JsonFileBreaker: corrupt file reports open", async () => {
  const dir = await Deno.makeTempDir();
  const breakersDir = join(dir, "breakers");
  await Deno.mkdir(breakersDir, { recursive: true });
  await Deno.writeTextFile(join(breakersDir, "test.json"), "not json{{{");
  const logs: object[] = [];
  const breaker = new JsonFileBreaker("test", breakersDir, {
    defaultPauseMinutes: 60,
    appendTickLog: (e) => {
      logs.push(e);
      return Promise.resolve();
    },
  });
  const status = await breaker.status(Temporal.Now.instant());
  assertEquals(status.state, "open");
  assert(
    logs.some((l) =>
      (l as Record<string, unknown>).event === "usage-limit-state-unreadable"
    ),
  );
});

Deno.test("JsonFileBreaker: reset closes breaker", async () => {
  const dir = await Deno.makeTempDir();
  const breaker = await makeBreaker(dir);
  await breaker.trip({
    retryAt: Temporal.Now.instant().add({ hours: 1 }).toString(),
    reason: "test",
  });
  await breaker.reset();
  const status = await breaker.status(Temporal.Now.instant());
  assertEquals(status.state, "closed");
});

Deno.test("JsonFileBreaker: re-trip after window expired increments trips", async () => {
  const dir = await Deno.makeTempDir();
  const breaker = await makeBreaker(dir);
  const past = Temporal.Now.instant().subtract({ minutes: 1 }).toString();
  await breaker.trip({ retryAt: past, reason: "first" });
  await breaker.trip({
    retryAt: Temporal.Now.instant().add({ hours: 2 }).toString(),
    reason: "second",
  });
  const status = await breaker.status(Temporal.Now.instant());
  if (status.state !== "open") throw new Error("expected open");
  assertEquals(status.trips, 2);
  assertStringIncludes(status.reason, "second");
});
