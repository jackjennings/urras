import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import type { Config } from "../state/types.ts";
import { withUrrasDir } from "../test-support.ts";
import {
  buildRexSupervisorArgs,
  buildSupervisorPrompt,
  launchSupervisorPane,
  performSupervisor,
  supervisorPidPath,
} from "./supervisor.ts";

function configWithStateDir(stateDir: string): Config {
  return {
    github: { repos: ["org/my-repo"] },
    state: { dir: stateDir },
    extensions: { dir: "~/.lazyboy/extensions" },
    tick: {
      concurrency: 1,
      resolveCIFailures: true,
      principles: true,
      agentsMdMaxTokens: 1000,
      maxTurns: 10,
    },
    codebase: { roots: [] },
    pi: { provider: "anthropic", packages: [] },
    agent: { type: "claude-code" },
  };
}

Deno.test("buildSupervisorPrompt: uses the built-in bootstrap prompt", async () => {
  const stateDir = await Deno.makeTempDir();
  const prompt = await buildSupervisorPrompt(stateDir);
  assertStringIncludes(prompt, "You are the supervisor");
});

Deno.test("buildSupervisorPrompt: appends the state-dir overlay", async () => {
  const stateDir = await Deno.makeTempDir();
  await Deno.mkdir(join(stateDir, "prompts"));
  await Deno.writeTextFile(
    join(stateDir, "prompts", "supervisor.md"),
    "Overlay rule.",
  );
  const prompt = await buildSupervisorPrompt(stateDir);
  assertStringIncludes(prompt, "You are the supervisor");
  assert(prompt.endsWith("Overlay rule."));
});

Deno.test("performSupervisor: spawns the agent and clears the pid file afterwards", async () => {
  using _urras = withUrrasDir();
  const stateDir = await Deno.makeTempDir();
  const spawn = spy((_prompt: string) => {
    assertEquals(Deno.readTextFileSync(supervisorPidPath()), "4242");
    return Promise.resolve(0);
  });
  const code = await performSupervisor({
    loadConfig: () => Promise.resolve(configWithStateDir(stateDir)),
    spawn,
    pid: 4242,
  });
  assertEquals(code, 0);
  assertSpyCalls(spawn, 1);
  assertStringIncludes(spawn.calls[0].args[0], "You are the supervisor");
  assertFalse(
    await Deno.stat(supervisorPidPath()).then(() => true, () => false),
  );
});

Deno.test("performSupervisor: refuses a second supervisor while one is alive", async () => {
  using _urras = withUrrasDir();
  await Deno.writeTextFile(supervisorPidPath(), "4242");
  const spawn = spy((_prompt: string) => Promise.resolve(0));
  const code = await performSupervisor({
    loadConfig: () => Promise.resolve(configWithStateDir("/unused")),
    spawn,
    isPidAlive: (pid) => pid === 4242,
  });
  assertEquals(code, 1);
  assertSpyCalls(spawn, 0);
  assertEquals(await Deno.readTextFile(supervisorPidPath()), "4242");
});

Deno.test("performSupervisor: replaces a stale pid file", async () => {
  using _urras = withUrrasDir();
  const stateDir = await Deno.makeTempDir();
  await Deno.writeTextFile(supervisorPidPath(), "4242");
  const spawn = spy((_prompt: string) => Promise.resolve(0));
  const code = await performSupervisor({
    loadConfig: () => Promise.resolve(configWithStateDir(stateDir)),
    spawn,
    isPidAlive: () => false,
    pid: 7,
  });
  assertEquals(code, 0);
  assertSpyCalls(spawn, 1);
});

Deno.test("buildRexSupervisorArgs: splits right of the current block inside a session", () => {
  assertEquals(
    buildRexSupervisorArgs({ session: "session:a", block: "block:b" }),
    [
      "split",
      "-s",
      "session:a",
      "-b",
      "block:b",
      "--split=right",
      "--",
      "ur",
      "supervisor",
    ],
  );
});

Deno.test("buildRexSupervisorArgs: opens a new tab without a session", () => {
  assertEquals(buildRexSupervisorArgs({}), ["run", "--", "ur", "supervisor"]);
});

Deno.test("launchSupervisorPane: runs rex when no supervisor is running", async () => {
  using _urras = withUrrasDir();
  const runRex = spy((_args: string[]) => Promise.resolve());
  const result = await launchSupervisorPane({ env: {}, runRex });
  assertEquals(result, "started");
  assertEquals(runRex.calls[0].args[0], [
    "run",
    "--",
    "ur",
    "supervisor",
  ]);
});

Deno.test("launchSupervisorPane: does nothing when rex is not installed", async () => {
  using _urras = withUrrasDir();
  const result = await launchSupervisorPane({
    env: {},
    runRex: () => Promise.reject(new Deno.errors.NotFound("rex")),
  });
  assertEquals(result, "no-rex");
});

Deno.test("launchSupervisorPane: reports an existing supervisor instead of starting another", async () => {
  using _urras = withUrrasDir();
  await Deno.writeTextFile(supervisorPidPath(), "4242");
  const runRex = spy((_args: string[]) => Promise.resolve());
  const result = await launchSupervisorPane({
    env: {},
    runRex,
    isPidAlive: () => true,
  });
  assertEquals(result, "already-running");
  assertSpyCalls(runRex, 0);
});

Deno.test("performSupervisor: only one of two concurrent launches runs the agent", async () => {
  using _urras = withUrrasDir();
  const stateDir = await Deno.makeTempDir();
  const spawn = spy(async (_prompt: string) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 0;
  });
  const options = {
    loadConfig: () => Promise.resolve(configWithStateDir(stateDir)),
    spawn,
    isPidAlive: () => true,
    pid: 4242,
  };
  const codes = await Promise.all([
    performSupervisor(options),
    performSupervisor(options),
  ]);
  assertEquals(codes.toSorted(), [0, 1]);
  assertSpyCalls(spawn, 1);
});
