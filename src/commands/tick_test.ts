import { assertEquals } from "@std/assert";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import { performTickUpdate } from "./tick.ts";
import type { Divergence, UpdateOutcome } from "./update.ts";

function makeDeps(
  overrides: Partial<Parameters<typeof performTickUpdate>[0]> = {},
) {
  return {
    update: () => Promise.resolve({ status: "current" as const }),
    log: () => Promise.resolve(),
    reexec: () => Promise.resolve(),
    notifyDivergence: () => Promise.resolve(),
    updateExtensions: (): Promise<UpdateOutcome | null> =>
      Promise.resolve(null),
    ...overrides,
  };
}

Deno.test("performTickUpdate: up to date does not log", async () => {
  const logSpy = spy(() => Promise.resolve());
  const result = await performTickUpdate(makeDeps({ log: logSpy }));
  assertSpyCalls(logSpy, 0);
  assertEquals(result, true);
});

Deno.test(
  "performTickUpdate: up to date clears any stored divergence",
  async () => {
    const notifySpy = spy((_d: Divergence | null) => Promise.resolve());
    await performTickUpdate(makeDeps({ notifyDivergence: notifySpy }));
    assertSpyCall(notifySpy, 0, { args: [null] });
  },
);

Deno.test(
  "performTickUpdate: real failure logs update-failed and continues",
  async () => {
    const logSpy = spy(() => Promise.resolve());
    const result = await performTickUpdate(makeDeps({
      update: () => Promise.resolve({ status: "failed" as const, code: 1 }),
      log: logSpy,
    }));
    assertSpyCall(logSpy, 0, { args: [{ event: "update-failed", code: 1 }] });
    assertEquals(result, true);
  },
);

Deno.test(
  "performTickUpdate: dirty tree logs update-skipped and continues",
  async () => {
    const logSpy = spy(() => Promise.resolve());
    const result = await performTickUpdate(makeDeps({
      update: () => Promise.resolve({ status: "dirty" as const }),
      log: logSpy,
    }));
    assertSpyCall(logSpy, 0, {
      args: [{ event: "update-skipped", reason: "dirty" }],
    });
    assertEquals(result, true);
  },
);

Deno.test(
  "performTickUpdate: divergence logs update-skipped with ahead/behind counts",
  async () => {
    const logSpy = spy(() => Promise.resolve());
    const result = await performTickUpdate(makeDeps({
      update: () =>
        Promise.resolve({
          status: "diverged" as const,
          divergence: { ahead: 3, behind: 2 },
        }),
      log: logSpy,
    }));
    assertSpyCall(logSpy, 0, {
      args: [{
        event: "update-skipped",
        reason: "diverged",
        ahead: 3,
        behind: 2,
      }],
    });
    assertEquals(result, true);
  },
);

Deno.test(
  "performTickUpdate: divergence is handed to the notifier",
  async () => {
    const notifySpy = spy((_d: Divergence | null) => Promise.resolve());
    await performTickUpdate(makeDeps({
      update: () =>
        Promise.resolve({
          status: "diverged" as const,
          divergence: { ahead: 3, behind: 2 },
        }),
      notifyDivergence: notifySpy,
    }));
    assertSpyCall(notifySpy, 0, { args: [{ ahead: 3, behind: 2 }] });
  },
);

Deno.test(
  "performTickUpdate: dirty tree leaves stored divergence untouched",
  async () => {
    const notifySpy = spy((_d: Divergence | null) => Promise.resolve());
    await performTickUpdate(makeDeps({
      update: () => Promise.resolve({ status: "dirty" as const }),
      notifyDivergence: notifySpy,
    }));
    assertSpyCalls(notifySpy, 0);
  },
);

Deno.test(
  "performTickUpdate: pulled invokes reexec and returns false",
  async () => {
    const reexecSpy = spy((_indexPath: string) => Promise.resolve());
    const result = await performTickUpdate(makeDeps({
      update: () => Promise.resolve({ status: "pulled" as const }),
      reexec: reexecSpy,
    }));
    assertSpyCalls(reexecSpy, 1);
    assertEquals(result, false);
  },
);

Deno.test(
  "performTickUpdate: updateExtensions not called when self-update is pulled",
  async () => {
    const extSpy = spy((): Promise<UpdateOutcome | null> =>
      Promise.resolve(null)
    );
    await performTickUpdate(makeDeps({
      update: () => Promise.resolve({ status: "pulled" as const }),
      updateExtensions: extSpy,
    }));
    assertSpyCalls(extSpy, 0);
  },
);

Deno.test(
  "performTickUpdate: updateExtensions called when self-update is current",
  async () => {
    const extSpy = spy((): Promise<UpdateOutcome | null> =>
      Promise.resolve(null)
    );
    await performTickUpdate(makeDeps({ updateExtensions: extSpy }));
    assertSpyCalls(extSpy, 1);
  },
);

Deno.test(
  "performTickUpdate: updateExtensions called when self-update is dirty",
  async () => {
    const extSpy = spy((): Promise<UpdateOutcome | null> =>
      Promise.resolve(null)
    );
    await performTickUpdate(makeDeps({
      update: () => Promise.resolve({ status: "dirty" as const }),
      updateExtensions: extSpy,
    }));
    assertSpyCalls(extSpy, 1);
  },
);

Deno.test(
  "performTickUpdate: updateExtensions called when self-update is diverged",
  async () => {
    const extSpy = spy((): Promise<UpdateOutcome | null> =>
      Promise.resolve(null)
    );
    await performTickUpdate(makeDeps({
      update: () =>
        Promise.resolve({
          status: "diverged" as const,
          divergence: { ahead: 1, behind: 1 },
        }),
      updateExtensions: extSpy,
    }));
    assertSpyCalls(extSpy, 1);
  },
);

Deno.test(
  "performTickUpdate: updateExtensions called when self-update is failed",
  async () => {
    const extSpy = spy((): Promise<UpdateOutcome | null> =>
      Promise.resolve(null)
    );
    await performTickUpdate(makeDeps({
      update: () => Promise.resolve({ status: "failed" as const, code: 1 }),
      updateExtensions: extSpy,
    }));
    assertSpyCalls(extSpy, 1);
  },
);

Deno.test(
  "performTickUpdate: null from updateExtensions does not log",
  async () => {
    const logSpy = spy(() => Promise.resolve());
    await performTickUpdate(makeDeps({
      log: logSpy,
      updateExtensions: () => Promise.resolve(null),
    }));
    assertSpyCalls(logSpy, 0);
  },
);

Deno.test(
  "performTickUpdate: dirty extensions logs update-skipped with target extensions",
  async () => {
    const logSpy = spy(() => Promise.resolve());
    await performTickUpdate(makeDeps({
      log: logSpy,
      updateExtensions: (): Promise<UpdateOutcome | null> =>
        Promise.resolve({ status: "dirty" }),
    }));
    assertSpyCall(logSpy, 0, {
      args: [{
        event: "update-skipped",
        reason: "dirty",
        target: "extensions",
      }],
    });
  },
);

Deno.test(
  "performTickUpdate: diverged extensions logs update-skipped with target extensions",
  async () => {
    const logSpy = spy(() => Promise.resolve());
    await performTickUpdate(makeDeps({
      log: logSpy,
      updateExtensions: (): Promise<UpdateOutcome | null> =>
        Promise.resolve({
          status: "diverged",
          divergence: { ahead: 3, behind: 2 },
        }),
    }));
    assertSpyCall(logSpy, 0, {
      args: [{
        event: "update-skipped",
        reason: "diverged",
        ahead: 3,
        behind: 2,
        target: "extensions",
      }],
    });
  },
);

Deno.test(
  "performTickUpdate: failed extensions logs update-failed with target extensions",
  async () => {
    const logSpy = spy(() => Promise.resolve());
    await performTickUpdate(makeDeps({
      log: logSpy,
      updateExtensions: (): Promise<UpdateOutcome | null> =>
        Promise.resolve({ status: "failed", code: 1 }),
    }));
    assertSpyCall(logSpy, 0, {
      args: [{ event: "update-failed", code: 1, target: "extensions" }],
    });
  },
);
