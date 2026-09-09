import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  ceremonyHash,
  ceremonyManifest,
  CeremonyManifestLimitError,
  CorruptApprovalsError,
  isCeremonyApproved,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_FILES,
  readApprovals,
  writeApprovals,
} from "./approvals.ts";
import { urrasDir } from "../paths.ts";
import { withUrrasDir } from "../test-support.ts";

async function makeCeremonyDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  return dir;
}

async function makeFifo(path: string): Promise<boolean> {
  const result = await new Deno.Command("mkfifo", { args: [path] }).output();
  return result.code === 0;
}

Deno.test("ceremonyHash: stable across calls", async () => {
  const dir = await makeCeremonyDir({
    "config.toml": 'time = "09:00"\n',
    "prompt.md": "do the thing\n",
  });
  try {
    assertEquals(await ceremonyHash(dir), await ceremonyHash(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyHash: changes when a file changes", async () => {
  const dir = await makeCeremonyDir({ "prompt.md": "before\n" });
  try {
    const before = await ceremonyHash(dir);
    await Deno.writeTextFile(join(dir, "prompt.md"), "after\n");
    assert(await ceremonyHash(dir) !== before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyHash: covers nested files outside output", async () => {
  const dir = await makeCeremonyDir({ "lib/helper.ts": "export const a = 1;" });
  try {
    const before = await ceremonyHash(dir);
    await Deno.writeTextFile(
      join(dir, "lib", "helper.ts"),
      "export const a=2;",
    );
    assert(await ceremonyHash(dir) !== before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readApprovals: missing file reads as empty", async () => {
  using _dir = withUrrasDir();
  assertEquals(await readApprovals(), {});
});

Deno.test("writeApprovals: round-trips", async () => {
  using _dir = withUrrasDir();
  await writeApprovals({ standup: { hash: "sha256:abc" } });
  assertEquals(await readApprovals(), { standup: { hash: "sha256:abc" } });
});

Deno.test("isCeremonyApproved: true when the hash matches", async () => {
  using _lazyboy = withUrrasDir();
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  try {
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    assert(await isCeremonyApproved("digest", dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isCeremonyApproved: false after the directory changes", async () => {
  using _lazyboy = withUrrasDir();
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  try {
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    await Deno.writeTextFile(join(dir, "prompt.md"), "y\n");
    assertFalse(await isCeremonyApproved("digest", dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isCeremonyApproved: false when the entry has no hash", async () => {
  using _lazyboy = withUrrasDir();
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  try {
    await writeApprovals({ digest: { lastWarnedWindow: "20260811" } });
    assertFalse(await isCeremonyApproved("digest", dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyHash: retargeting a symlink changes the hash", async () => {
  const dir = await makeCeremonyDir({
    "file1.ts": "identical\n",
    "file2.ts": "identical\n",
  });
  try {
    await Deno.symlink(join(dir, "file1.ts"), join(dir, "link.ts"));
    const before = await ceremonyHash(dir);
    await Deno.remove(join(dir, "link.ts"));
    await Deno.symlink(join(dir, "file2.ts"), join(dir, "link.ts"));
    assert(await ceremonyHash(dir) !== before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyHash: editing a symlink target changes the hash", async () => {
  const dir = await makeCeremonyDir({ "target.ts": "before\n" });
  try {
    await Deno.symlink(join(dir, "target.ts"), join(dir, "link.ts"));
    const before = await ceremonyHash(dir);
    await Deno.writeTextFile(join(dir, "target.ts"), "after\n");
    assert(await ceremonyHash(dir) !== before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyHash: broken symlink is stable", async () => {
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  try {
    await Deno.symlink("/nonexistent/path", join(dir, "broken.ts"));
    const before = await ceremonyHash(dir);
    const after = await ceremonyHash(dir);
    assertEquals(before, after);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyHash: does not descend a symlink to a directory outside the root", async () => {
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  const linkedDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(linkedDir, "nested.ts"), "content\n");
    await Deno.symlink(linkedDir, join(dir, "linked-dir"));
    const before = await ceremonyHash(dir);
    await Deno.writeTextFile(join(linkedDir, "nested.ts"), "changed\n");
    assertEquals(await ceremonyHash(dir), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(linkedDir, { recursive: true });
  }
});

Deno.test("ceremonyHash: records the target of a symlink to an outside directory", async () => {
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  const first = await Deno.makeTempDir();
  const second = await Deno.makeTempDir();
  try {
    await Deno.symlink(first, join(dir, "linked-dir"));
    const before = await ceremonyHash(dir);
    await Deno.remove(join(dir, "linked-dir"));
    await Deno.symlink(second, join(dir, "linked-dir"));
    assert(await ceremonyHash(dir) !== before);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(first, { recursive: true });
    await Deno.remove(second, { recursive: true });
  }
});

Deno.test("ceremonyHash: descends a symlink to a directory inside the root", async () => {
  const dir = await makeCeremonyDir({ "inner/nested.ts": "content\n" });
  try {
    await Deno.symlink(join(dir, "inner"), join(dir, "alink"));
    const manifest = await ceremonyManifest(dir);
    const paths = manifest.map((entry) => entry.path);
    assertArrayIncludes(paths, [join("alink", "nested.ts")]);
    assertFalse(paths.includes(join("inner", "nested.ts")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyHash: editing through an in-root symlink changes the hash", async () => {
  const dir = await makeCeremonyDir({ "inner/nested.ts": "content\n" });
  try {
    await Deno.symlink(join(dir, "inner"), join(dir, "alink"));
    const before = await ceremonyHash(dir);
    await Deno.writeTextFile(
      join(dir, "alink", "nested.ts"),
      "through the link\n",
    );
    assert(await ceremonyHash(dir) !== before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyHash: a FIFO entry does not hash as an empty directory", async () => {
  const emptyDir = await Deno.makeTempDir();
  const fifoDir = await Deno.makeTempDir();
  try {
    assert(
      await makeFifo(join(fifoDir, "index.ts")),
      "mkfifo must succeed for this regression test to mean anything",
    );
    assert(await ceremonyHash(fifoDir) !== await ceremonyHash(emptyDir));
  } finally {
    await Deno.remove(emptyDir, { recursive: true });
    await Deno.remove(fifoDir, { recursive: true });
  }
});

Deno.test("ceremonyManifest: an unclassifiable entry is recorded as unsupported", async () => {
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  try {
    assert(await makeFifo(join(dir, "pipe")));
    const manifest = await ceremonyManifest(dir);
    const pipe = manifest.find((entry) => entry.path === "pipe");
    assertEquals(pipe?.detail, "<unsupported>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isCeremonyApproved: adding a FIFO index.ts to an approved ceremony revokes it", async () => {
  using _lazyboy = withUrrasDir();
  const dir = await makeCeremonyDir({
    "config.toml": 'time = "09:00"\n',
    "prompt.md": "summarize the day\n",
  });
  try {
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    assert(await isCeremonyApproved("digest", dir));
    assert(await makeFifo(join(dir, "index.ts")));
    assertFalse(await isCeremonyApproved("digest", dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyHash: a symlink to a FIFO is recorded as unsupported", async () => {
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  const fifoHome = await Deno.makeTempDir();
  try {
    const fifoPath = join(fifoHome, "pipe");
    assert(await makeFifo(fifoPath));
    await Deno.symlink(fifoPath, join(dir, "index.ts"));
    const manifest = await ceremonyManifest(dir);
    const link = manifest.find((entry) => entry.path === "index.ts");
    assertStringIncludes(link?.detail ?? "", "<unsupported>");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(fifoHome, { recursive: true });
  }
});

Deno.test("ceremonyHash: distinct non-UTF-8 files hash differently", async () => {
  const first = await Deno.makeTempDir();
  const second = await Deno.makeTempDir();
  try {
    await Deno.writeFile(
      join(first, "blob.bin"),
      new Uint8Array([0xff, 0xfe, 0x00, 0x41]),
    );
    await Deno.writeFile(
      join(second, "blob.bin"),
      new Uint8Array([0xfe, 0xff, 0x00, 0x41]),
    );
    assert(await ceremonyHash(first) !== await ceremonyHash(second));
  } finally {
    await Deno.remove(first, { recursive: true });
    await Deno.remove(second, { recursive: true });
  }
});

Deno.test("isCeremonyApproved: swapping a non-UTF-8 blob revokes approval", async () => {
  using _lazyboy = withUrrasDir();
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  try {
    const blob = join(dir, "data.wasm");
    await Deno.writeFile(blob, new Uint8Array([0xff, 0xfe, 0x00, 0x41]));
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    assert(await isCeremonyApproved("digest", dir));
    await Deno.writeFile(blob, new Uint8Array([0xfe, 0xff, 0x00, 0x41]));
    assertFalse(await isCeremonyApproved("digest", dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readApprovals: unparseable file throws instead of reading as empty", async () => {
  using _lazyboy = withUrrasDir();
  await writeApprovals({ digest: { hash: "sha256:abc" } });
  await Deno.writeTextFile(
    join(urrasDir(), "ceremony-approvals.json"),
    "{ not json",
  );
  await assertRejects(() => readApprovals(), CorruptApprovalsError);
});

Deno.test("readApprovals: a JSON array is rejected as corrupt", async () => {
  using _lazyboy = withUrrasDir();
  await Deno.mkdir(urrasDir(), { recursive: true });
  await Deno.writeTextFile(
    join(urrasDir(), "ceremony-approvals.json"),
    "[]",
  );
  await assertRejects(() => readApprovals(), CorruptApprovalsError);
});

Deno.test("isCeremonyApproved: a corrupt approvals file denies approval", async () => {
  using _lazyboy = withUrrasDir();
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  try {
    await Deno.mkdir(urrasDir(), { recursive: true });
    await Deno.writeTextFile(
      join(urrasDir(), "ceremony-approvals.json"),
      "{ not json",
    );
    assertFalse(await isCeremonyApproved("digest", dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeApprovals: leaves no temporary files behind", async () => {
  using _lazyboy = withUrrasDir();
  await writeApprovals({ digest: { hash: "sha256:abc" } });
  const names: string[] = [];
  for await (const entry of Deno.readDir(urrasDir())) names.push(entry.name);
  assertEquals(names, ["ceremony-approvals.json"]);
});

Deno.test("ceremonyHash: exceeding the file cap fails closed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (let index = 0; index <= MAX_MANIFEST_FILES; index += 1) {
      await Deno.writeTextFile(join(dir, `file-${index}.txt`), "x");
    }
    await assertRejects(() => ceremonyHash(dir), CeremonyManifestLimitError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isCeremonyApproved: exceeding the file cap denies approval", async () => {
  using _lazyboy = withUrrasDir();
  const dir = await makeCeremonyDir({ "prompt.md": "x\n" });
  try {
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    assert(await isCeremonyApproved("digest", dir));
    for (let index = 0; index <= MAX_MANIFEST_FILES; index += 1) {
      await Deno.writeTextFile(join(dir, `file-${index}.txt`), "x");
    }
    assertFalse(await isCeremonyApproved("digest", dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyHash: exceeding the byte cap fails closed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "large.bin");
    await Deno.writeTextFile(file, "");
    await Deno.truncate(file, MAX_MANIFEST_BYTES + 1);
    await assertRejects(() => ceremonyHash(dir), CeremonyManifestLimitError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ceremonyManifest: entry order does not depend on directory iteration order", async () => {
  const dir = await makeCeremonyDir({
    "inner/nested.ts": "content\n",
    "prompt.md": "x\n",
  });
  try {
    await Deno.symlink(join(dir, "inner"), join(dir, "linked-dir"));
    const first = await ceremonyManifest(dir);
    const second = await ceremonyManifest(dir);
    assertEquals(first.map((entry) => entry.path), second.map((e) => e.path));
    assertArrayIncludes(first.map((entry) => entry.path), [
      join("inner", "nested.ts"),
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
