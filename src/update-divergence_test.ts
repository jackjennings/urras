import { assertEquals, assertStringIncludes } from "@std/assert";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import {
  formatDivergenceMessage,
  makeDivergenceNotifier,
  readLastDivergence,
  writeLastDivergence,
} from "./update-divergence.ts";
import type { Divergence } from "./commands/update.ts";
import { withUrrasDir } from "./test-support.ts";

function makeStore(initial: Divergence | null = null) {
  let stored = initial;
  return {
    readLast: () => Promise.resolve(stored),
    writeLast: (d: Divergence | null) => {
      stored = d;
      return Promise.resolve();
    },
    current: () => stored,
  };
}

Deno.test("makeDivergenceNotifier: notifies on first divergence", async () => {
  const notify = spy((_t: string, _m: string) => Promise.resolve());
  const store = makeStore();
  const notifier = makeDivergenceNotifier({ notify, ...store });

  await notifier({ ahead: 2, behind: 1 });

  assertSpyCalls(notify, 1);
  assertEquals(store.current(), { ahead: 2, behind: 1 });
});

Deno.test(
  "makeDivergenceNotifier: stays silent when counts are unchanged",
  async () => {
    const notify = spy((_t: string, _m: string) => Promise.resolve());
    const store = makeStore({ ahead: 2, behind: 1 });
    const notifier = makeDivergenceNotifier({ notify, ...store });

    await notifier({ ahead: 2, behind: 1 });

    assertSpyCalls(notify, 0);
  },
);

Deno.test("makeDivergenceNotifier: notifies when counts change", async () => {
  const notify = spy((_t: string, _m: string) => Promise.resolve());
  const store = makeStore({ ahead: 2, behind: 1 });
  const notifier = makeDivergenceNotifier({ notify, ...store });

  await notifier({ ahead: 3, behind: 1 });

  assertSpyCalls(notify, 1);
  assertEquals(store.current(), { ahead: 3, behind: 1 });
});

Deno.test(
  "makeDivergenceNotifier: clears stored state when divergence resolves",
  async () => {
    const notify = spy((_t: string, _m: string) => Promise.resolve());
    const store = makeStore({ ahead: 2, behind: 1 });
    const notifier = makeDivergenceNotifier({ notify, ...store });

    await notifier(null);

    assertSpyCalls(notify, 0);
    assertEquals(store.current(), null);
  },
);

Deno.test(
  "makeDivergenceNotifier: re-notifies the same counts after resolution",
  async () => {
    const notify = spy((_t: string, _m: string) => Promise.resolve());
    const store = makeStore({ ahead: 2, behind: 1 });
    const notifier = makeDivergenceNotifier({ notify, ...store });

    await notifier(null);
    await notifier({ ahead: 2, behind: 1 });

    assertSpyCalls(notify, 1);
  },
);

Deno.test("makeDivergenceNotifier: message carries both counts", async () => {
  const notify = spy((_t: string, _m: string) => Promise.resolve());
  const notifier = makeDivergenceNotifier({ notify, ...makeStore() });

  await notifier({ ahead: 3, behind: 2 });

  const [, message] = notify.calls[0].args;
  assertStringIncludes(message, "3 commits ahead");
  assertStringIncludes(message, "2 commits behind");
});

Deno.test("formatDivergenceMessage: singular commit wording", () => {
  assertStringIncludes(
    formatDivergenceMessage({ ahead: 1, behind: 1 }),
    "1 commit ahead",
  );
});

Deno.test("readLastDivergence: returns null when no state file exists", async () => {
  using _dir = withUrrasDir();
  assertEquals(await readLastDivergence(), null);
});

Deno.test("writeLastDivergence: round-trips through the runtime dir", async () => {
  using _dir = withUrrasDir();
  await writeLastDivergence({ ahead: 4, behind: 2 });
  assertEquals(await readLastDivergence(), { ahead: 4, behind: 2 });
});

Deno.test("writeLastDivergence: null clears the stored state", async () => {
  using _dir = withUrrasDir();
  await writeLastDivergence({ ahead: 4, behind: 2 });
  await writeLastDivergence(null);
  assertEquals(await readLastDivergence(), null);
});

Deno.test("readLastDivergence: returns null when the state file is corrupt", async () => {
  using dir = withUrrasDir();
  await Deno.writeTextFile(`${dir.path}/update-divergence.json`, "not json");
  assertEquals(await readLastDivergence(), null);
});

Deno.test(
  "makeDivergenceNotifier: notify failure does not throw",
  async () => {
    const notify = spy(() => Promise.reject(new Error("osascript failed")));
    const store = makeStore();
    const notifier = makeDivergenceNotifier({ notify, ...store });

    await notifier({ ahead: 1, behind: 1 });

    assertSpyCall(notify, 0);
  },
);
