import {
  acknowledgeInbox,
  type InboxEntry,
  mkdirInbox,
  pendingInboxDir,
  readPendingInbox,
} from "../inbox.ts";
import type { Command } from "./types.ts";

const IDLE_MILLISECONDS = 5_000;
const SAFETY_POLL_MILLISECONDS = 5_000;

export interface DirectoryWatcher {
  changed(timeoutMilliseconds: number): Promise<boolean>;
  close(): void;
}

export function watchDirectory(directory: string): DirectoryWatcher {
  const watcher = Deno.watchFs(directory);
  const iterator = watcher[Symbol.asyncIterator]();
  let pendingChange: Promise<unknown> | null = null;
  return {
    async changed(timeoutMilliseconds) {
      pendingChange ??= iterator.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMilliseconds);
      });
      const change = pendingChange.then(() => true as const);
      const result = await Promise.race([change, timeout]);
      clearTimeout(timer);
      if (result) pendingChange = null;
      return result;
    },
    close() {
      watcher.close();
    },
  };
}

function hasStatusChange(entries: InboxEntry[]): boolean {
  return entries.some((entry) => entry.event.event === "status-change");
}

export async function waitForInboxBatch(deps?: {
  readPending?: () => Promise<InboxEntry[]>;
  acknowledge?: (names: string[]) => Promise<void>;
  watch?: () => DirectoryWatcher;
  idleMilliseconds?: number;
}): Promise<InboxEntry[]> {
  const readPending = deps?.readPending ?? readPendingInbox;
  const acknowledge = deps?.acknowledge ?? acknowledgeInbox;
  const idleMilliseconds = deps?.idleMilliseconds ?? IDLE_MILLISECONDS;
  if (!deps?.watch) await mkdirInbox();
  const watcher = deps?.watch?.() ?? watchDirectory(pendingInboxDir());
  try {
    while (true) {
      const pending = await readPending();
      const lastTickEnd = pending.findLastIndex((entry) =>
        entry.event.event === "tick-end"
      );
      if (lastTickEnd >= 0) {
        const batch = pending.slice(0, lastTickEnd + 1);
        await acknowledge(batch.map((entry) => entry.name));
        if (hasStatusChange(batch)) return batch;
        continue;
      }
      if (hasStatusChange(pending)) {
        if (await watcher.changed(idleMilliseconds)) continue;
        await acknowledge(pending.map((entry) => entry.name));
        return pending;
      }
      await watcher.changed(SAFETY_POLL_MILLISECONDS);
    }
  } finally {
    watcher.close();
  }
}

export const wait: Command = {
  name: "wait",
  description: "block until a tick changes a ticket, then print the events",
  usage: "ur wait",
  async run() {
    try {
      const batch = await waitForInboxBatch();
      for (const entry of batch) {
        console.log(JSON.stringify(entry.event));
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
};
