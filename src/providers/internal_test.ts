import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { InternalProvider } from "./internal.ts";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

function makeEntry(
  id = `internal/${UUID}`,
  title = "Fix bug",
  body = "Description",
): string {
  return JSON.stringify({ id, title, body, createdAt: "2026-01-01T00:00:00Z" });
}

Deno.test("fetchNew returns [] when queue does not exist", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const provider = new InternalProvider(join(dir, "queue.ndjson"));
    assertEquals(await provider.fetchNew(new Set()), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchNew returns entries with correct WorkItem shape", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const queuePath = join(dir, "queue.ndjson");
    await Deno.writeTextFile(queuePath, makeEntry() + "\n");
    const provider = new InternalProvider(queuePath);
    const items = await provider.fetchNew(new Set());
    assertEquals(items.length, 1);
    assertEquals(items[0].id, `internal/${UUID}`);
    assertEquals(items[0].provider, "internal");
    assertEquals(items[0].title, "Fix bug");
    assertEquals(items[0].description, "Description");
    assertEquals(items[0].url, `internal://${UUID}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchNew skips entries whose id is in knownIds", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const queuePath = join(dir, "queue.ndjson");
    await Deno.writeTextFile(queuePath, makeEntry() + "\n");
    const provider = new InternalProvider(queuePath);
    const items = await provider.fetchNew(new Set([`internal/${UUID}`]));
    assertEquals(items, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchNew reads only new bytes when cursor is present", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const queuePath = join(dir, "queue.ndjson");
    const firstEntry = makeEntry(`internal/${UUID}`, "First", "First body");
    await Deno.writeTextFile(queuePath, firstEntry + "\n");
    const provider = new InternalProvider(queuePath);

    const firstItems = await provider.fetchNew(new Set());
    assertEquals(firstItems.length, 1);
    assertEquals(firstItems[0].title, "First");

    const secondUUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const secondEntry = makeEntry(
      `internal/${secondUUID}`,
      "Second",
      "Second body",
    );
    await Deno.writeTextFile(queuePath, secondEntry + "\n", { append: true });

    const secondItems = await provider.fetchNew(new Set([`internal/${UUID}`]));
    assertEquals(secondItems.length, 1);
    assertEquals(secondItems[0].title, "Second");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchNew returns [] when file size equals cursor offset", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const queuePath = join(dir, "queue.ndjson");
    await Deno.writeTextFile(queuePath, makeEntry() + "\n");
    const provider = new InternalProvider(queuePath);

    await provider.fetchNew(new Set());
    const secondItems = await provider.fetchNew(new Set());
    assertEquals(secondItems, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchNew skips malformed JSON lines", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const queuePath = join(dir, "queue.ndjson");
    await Deno.writeTextFile(
      queuePath,
      "not valid json\n" + makeEntry() + "\n",
    );
    const provider = new InternalProvider(queuePath);
    const items = await provider.fetchNew(new Set());
    assertEquals(items.length, 1);
    assertEquals(items[0].title, "Fix bug");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchNew writes cursor with file size after reading", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const queuePath = join(dir, "queue.ndjson");
    const entry = makeEntry() + "\n";
    await Deno.writeTextFile(queuePath, entry);
    const provider = new InternalProvider(queuePath);
    await provider.fetchNew(new Set());
    const cursor = await Deno.readTextFile(queuePath + ".cursor");
    assertEquals(cursor, String(new TextEncoder().encode(entry).length));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchNew treats absent cursor as offset 0", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const queuePath = join(dir, "queue.ndjson");
    await Deno.writeTextFile(queuePath, makeEntry() + "\n");
    const provider = new InternalProvider(queuePath);
    const items = await provider.fetchNew(new Set());
    assertEquals(items.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("close resolves without error", async () => {
  const provider = new InternalProvider("/nonexistent/queue.ndjson");
  await provider.close(`internal://${UUID}`);
});
