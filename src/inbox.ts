import { join } from "@std/path";
import {
  mkdir,
  readDir,
  readTextFile,
  remove,
  rename,
  writeTextFile,
} from "./filesystem.ts";
import { urrasDir } from "./paths.ts";

export const DEFAULT_HANDLED_RETENTION_DAYS = 7;
export const DEFAULT_UNREAD_RETENTION_DAYS = 30;
const TEMPORARY_RETENTION_HOURS = 36;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

export interface StatusChange {
  ticket: string;
  phase: string;
  status: string;
  previousPhase: string;
  previousStatus: string;
  approver: string;
  reason: string;
}

export type InboxEventPayload =
  | { event: "tick-start" | "tick-end" }
  | ({ event: "status-change" } & StatusChange);

export type InboxEvent = InboxEventPayload & { ts: string };

export interface InboxEntry {
  name: string;
  event: InboxEvent;
}

export interface RetentionWindows {
  handledDays?: number;
  unreadDays?: number;
}

export function inboxDir(): string {
  return join(urrasDir(), "inbox");
}

export function pendingInboxDir(): string {
  return join(inboxDir(), "new");
}

let sequence = 0;

function nextEntryName(nowMilliseconds: number): string {
  sequence = (sequence + 1) % 10_000;
  return `${String(nowMilliseconds).padStart(13, "0")}-${
    String(sequence).padStart(4, "0")
  }-${crypto.randomUUID().slice(0, 8)}.json`;
}

function entryAgeReference(name: string): number | null {
  const milliseconds = Number(name.slice(0, 13));
  return Number.isInteger(milliseconds) ? milliseconds : null;
}

export async function mkdirInbox(): Promise<void> {
  await Promise.all(
    ["tmp", "new", "cur"].map((directory) =>
      mkdir(join(inboxDir(), directory), { recursive: true })
    ),
  );
}

export async function publishInboxEvent(
  payload: InboxEventPayload,
): Promise<void> {
  const now = Temporal.Now.instant();
  const name = nextEntryName(now.epochMilliseconds);
  const temporaryPath = join(inboxDir(), "tmp", name);
  await mkdirInbox();
  const event: InboxEvent = { ...payload, ts: now.toString() };
  await writeTextFile(temporaryPath, `${JSON.stringify(event)}\n`);
  await rename(temporaryPath, join(pendingInboxDir(), name));
}

async function listNames(directory: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of readDir(directory)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        names.push(entry.name);
      }
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  return names.sort();
}

export async function readPendingInbox(): Promise<InboxEntry[]> {
  const entries: InboxEntry[] = [];
  for (const name of await listNames(pendingInboxDir())) {
    try {
      const raw = await readTextFile(join(pendingInboxDir(), name));
      entries.push({ name, event: JSON.parse(raw) as InboxEvent });
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  return entries;
}

export async function acknowledgeInbox(names: string[]): Promise<void> {
  await mkdir(join(inboxDir(), "cur"), { recursive: true });
  for (const name of names) {
    try {
      await rename(
        join(pendingInboxDir(), name),
        join(inboxDir(), "cur", name),
      );
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}

async function removeOlderThan(
  opts: { directory: string; cutoffMilliseconds: number },
): Promise<number> {
  let removed = 0;
  for (const name of await listNames(opts.directory)) {
    const created = entryAgeReference(name);
    if (created === null || created >= opts.cutoffMilliseconds) continue;
    try {
      await remove(join(opts.directory, name));
      removed++;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  return removed;
}

export async function sweepInbox(
  opts: { now: Temporal.Instant; windows?: RetentionWindows },
): Promise<{ droppedUnread: number }> {
  const nowMilliseconds = opts.now.epochMilliseconds;
  const handledMilliseconds =
    (opts.windows?.handledDays ?? DEFAULT_HANDLED_RETENTION_DAYS) * 24 *
    MILLISECONDS_PER_HOUR;
  const unreadMilliseconds =
    (opts.windows?.unreadDays ?? DEFAULT_UNREAD_RETENTION_DAYS) * 24 *
    MILLISECONDS_PER_HOUR;
  await removeOlderThan({
    directory: join(inboxDir(), "tmp"),
    cutoffMilliseconds: nowMilliseconds -
      TEMPORARY_RETENTION_HOURS * MILLISECONDS_PER_HOUR,
  });
  await removeOlderThan({
    directory: join(inboxDir(), "cur"),
    cutoffMilliseconds: nowMilliseconds - handledMilliseconds,
  });
  const droppedUnread = await removeOlderThan({
    directory: pendingInboxDir(),
    cutoffMilliseconds: nowMilliseconds - unreadMilliseconds,
  });
  return { droppedUnread };
}
