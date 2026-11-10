import type { HooksConfig } from "./state/types.ts";

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 10;

export type HookEvent =
  | { hook: "on_tick_start" | "on_tick_end" }
  | { hook: "on_status_change"; ticket: string; env: Record<string, string> };

export type HookRunner = (event: HookEvent) => Promise<void>;

type HookFailureReason = "non-zero-exit" | "timeout" | "spawn-failed";

function commandFor(
  hooks: HooksConfig,
  hook: HookEvent["hook"],
): string | undefined {
  switch (hook) {
    case "on_tick_start":
      return hooks.onTickStart;
    case "on_tick_end":
      return hooks.onTickEnd;
    case "on_status_change":
      return hooks.onStatusChange;
  }
}

export function makeHookRunner(opts: {
  hooks: HooksConfig | undefined;
  log: (entry: object) => Promise<void>;
}): HookRunner {
  const hooks = opts.hooks;
  if (!hooks) return () => Promise.resolve();
  const timeoutMs = (hooks.timeoutSeconds ?? DEFAULT_HOOK_TIMEOUT_SECONDS) *
    1000;

  return async (event) => {
    const command = commandFor(hooks, event.hook);
    if (!command) return;
    const failure = await execute({
      command,
      env: {
        URRAS_HOOK: event.hook,
        ...(event.hook === "on_status_change" ? event.env : {}),
      },
      timeoutMs,
    });
    if (failure === null) return;
    try {
      await opts.log({
        event: "hook-failed",
        hook: event.hook,
        reason: failure.reason,
        ...(failure.code !== undefined ? { code: failure.code } : {}),
        ...(event.hook === "on_status_change" ? { ticket: event.ticket } : {}),
      });
    } catch {
      // a logging failure must not fail the tick
    }
  };
}

async function execute(
  opts: { command: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ reason: HookFailureReason; code?: number } | null> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("sh", {
      args: ["-c", opts.command],
      env: opts.env,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
  } catch {
    return { reason: "spawn-failed" };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, opts.timeoutMs);
  try {
    const status = await child.status;
    if (timedOut) return { reason: "timeout" };
    return status.success
      ? null
      : { reason: "non-zero-exit", code: status.code };
  } catch {
    return { reason: "spawn-failed" };
  } finally {
    clearTimeout(timer);
  }
}
