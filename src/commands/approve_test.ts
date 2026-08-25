import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import { writeTicket } from "../state/store.ts";
import { makeTicket } from "../test-support.ts";
import { performApprove, performApproveCeremony } from "./approve.ts";
import type { ApprovalRecord } from "../ceremonies/approvals.ts";

Deno.test(
  "performApprove: appends entry with actor human and current phase",
  async () => {
    const ticket = makeTicket({ phase: "enrichment", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performApprove(stateDir, ticket.id, { commitFn });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "actor: human");
      assertStringIncludes(meta, "phase: enrichment");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test("performApprove: does not write approved key", async () => {
  const ticket = makeTicket({ phase: "intake", status: "waiting" });
  const stateDir = await Deno.makeTempDir();
  await writeTicket(stateDir, ticket);
  const commitFn = spy(() => Promise.resolve());
  try {
    await performApprove(stateDir, ticket.id, { commitFn });
    const meta = await Deno.readTextFile(
      join(stateDir, ticket.id, "meta.md"),
    );
    assertFalse(meta.includes("approved:"));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("performApprove: accumulates multiple approvals", async () => {
  const ticket = makeTicket({
    phase: "spec",
    status: "waiting",
    approvals: [{
      timestamp: "2026-01-01T00:00:00Z",
      actor: "agent",
      phase: "intake",
    }],
  });
  const stateDir = await Deno.makeTempDir();
  await writeTicket(stateDir, ticket);
  const commitFn = spy(() => Promise.resolve());
  try {
    await performApprove(stateDir, ticket.id, { commitFn });
    const meta = await Deno.readTextFile(
      join(stateDir, ticket.id, "meta.md"),
    );
    assertStringIncludes(meta, "actor: agent");
    assertStringIncludes(meta, "actor: human");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test(
  "performApprove: calls commitFn with stateDir, id, and approve message",
  async () => {
    const ticket = makeTicket({ phase: "plan", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performApprove(stateDir, ticket.id, { commitFn });
      assertSpyCalls(commitFn, 1);
      assertEquals(commitFn.calls[0].args, [
        stateDir,
        ticket.id,
        `approve: ${ticket.id}`,
      ]);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

async function makeTestDirs(
  name: string,
): Promise<{ stateDir: string; extensionsDir: string }> {
  const stateDir = await Deno.makeTempDir();
  const extensionsDir = await Deno.makeTempDir();
  const dir = join(extensionsDir, "ceremonies", name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "prompt.md"), "x\n");
  return { stateDir, extensionsDir };
}

Deno.test("performApproveCeremony: writes the hash and timestamp", async () => {
  const { stateDir, extensionsDir } = await makeTestDirs("digest");
  try {
    let written: ApprovalRecord = {};
    await performApproveCeremony(stateDir, extensionsDir, "digest", {
      readApprovalsFn: () => Promise.resolve({}),
      writeApprovalsFn: (record) => {
        written = record;
        return Promise.resolve();
      },
      hashFn: () => Promise.resolve("sha256:deadbeef"),
    });
    assertEquals(written.digest.hash, "sha256:deadbeef");
    assertEquals(typeof written.digest.approvedAt, "string");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test("performApproveCeremony: preserves other entries", async () => {
  const { stateDir, extensionsDir } = await makeTestDirs("digest");
  try {
    let written: ApprovalRecord = {};
    await performApproveCeremony(stateDir, extensionsDir, "digest", {
      readApprovalsFn: () => Promise.resolve({ other: { hash: "sha256:1" } }),
      writeApprovalsFn: (record) => {
        written = record;
        return Promise.resolve();
      },
      hashFn: () => Promise.resolve("sha256:2"),
    });
    assertEquals(written.other.hash, "sha256:1");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test("performApproveCeremony: rejects an unknown ceremony", async () => {
  const stateDir = await Deno.makeTempDir();
  const extensionsDir = await Deno.makeTempDir();
  try {
    const writeApprovalsFn = spy(() => Promise.resolve());
    await assertRejects(
      () =>
        performApproveCeremony(stateDir, extensionsDir, "missing", {
          readApprovalsFn: () => Promise.resolve({}),
          writeApprovalsFn,
          hashFn: () => Promise.resolve("sha256:x"),
        }),
      Error,
      "missing",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test("performApproveCeremony: rejects a built-in ceremony", async () => {
  const { stateDir, extensionsDir } = await makeTestDirs("documentation-gaps");
  try {
    await assertRejects(
      () =>
        performApproveCeremony(stateDir, extensionsDir, "documentation-gaps", {
          readApprovalsFn: () => Promise.resolve({}),
          writeApprovalsFn: () => Promise.resolve(),
          hashFn: () => Promise.resolve("sha256:x"),
        }),
      Error,
      "built-in",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test(
  "performApproveCeremony: rejects an empty name even when a ceremony exists",
  async () => {
    const { stateDir, extensionsDir } = await makeTestDirs("digest");
    try {
      const writeApprovalsFn = spy(() => Promise.resolve());
      await assertRejects(
        () =>
          performApproveCeremony(stateDir, extensionsDir, "", {
            readApprovalsFn: () => Promise.resolve({}),
            writeApprovalsFn,
            hashFn: () => Promise.resolve("sha256:x"),
          }),
        Error,
        "empty",
      );
      assertSpyCalls(writeApprovalsFn, 0);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(extensionsDir, { recursive: true });
    }
  },
);

Deno.test("performApproveCeremony: rejects a name containing /", async () => {
  const { stateDir, extensionsDir } = await makeTestDirs("digest");
  try {
    const writeApprovalsFn = spy(() => Promise.resolve());
    await assertRejects(
      () =>
        performApproveCeremony(stateDir, extensionsDir, "foo/bar", {
          readApprovalsFn: () => Promise.resolve({}),
          writeApprovalsFn,
          hashFn: () => Promise.resolve("sha256:x"),
        }),
      Error,
      "Invalid ceremony name",
    );
    assertSpyCalls(writeApprovalsFn, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test("performApproveCeremony: rejects a name containing ..", async () => {
  const { stateDir, extensionsDir } = await makeTestDirs("digest");
  try {
    const writeApprovalsFn = spy(() => Promise.resolve());
    await assertRejects(
      () =>
        performApproveCeremony(stateDir, extensionsDir, "..", {
          readApprovalsFn: () => Promise.resolve({}),
          writeApprovalsFn,
          hashFn: () => Promise.resolve("sha256:x"),
        }),
      Error,
      "Invalid ceremony name",
    );
    assertSpyCalls(writeApprovalsFn, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test(
  "performApproveCeremony: clears a stale lastWarnedWindow on approval",
  async () => {
    const { stateDir, extensionsDir } = await makeTestDirs("digest");
    try {
      let written: ApprovalRecord = {};
      await performApproveCeremony(stateDir, extensionsDir, "digest", {
        readApprovalsFn: () =>
          Promise.resolve({
            digest: { hash: "sha256:old", lastWarnedWindow: "2026-08-01" },
          }),
        writeApprovalsFn: (record) => {
          written = record;
          return Promise.resolve();
        },
        hashFn: () => Promise.resolve("sha256:new"),
      });
      assertEquals(written.digest.hash, "sha256:new");
      assertEquals(typeof written.digest.approvedAt, "string");
      assertEquals(written.digest.lastWarnedWindow, undefined);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(extensionsDir, { recursive: true });
    }
  },
);

Deno.test('performApproveCeremony: rejects the name "."', async () => {
  const { stateDir, extensionsDir } = await makeTestDirs("digest");
  try {
    const writeApprovalsFn = spy(() => Promise.resolve());
    await assertRejects(
      () =>
        performApproveCeremony(stateDir, extensionsDir, ".", {
          readApprovalsFn: () => Promise.resolve({}),
          writeApprovalsFn,
          hashFn: () => Promise.resolve("sha256:x"),
        }),
      Error,
      "Invalid ceremony name",
    );
    assertSpyCalls(writeApprovalsFn, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test("performApproveCeremony: rejects a name with a quote", async () => {
  const { stateDir, extensionsDir } = await makeTestDirs("digest");
  try {
    const writeApprovalsFn = spy(() => Promise.resolve());
    await assertRejects(
      () =>
        performApproveCeremony(
          stateDir,
          extensionsDir,
          'x" & (do shell script "id") & "y',
          {
            readApprovalsFn: () => Promise.resolve({}),
            writeApprovalsFn,
            hashFn: () => Promise.resolve("sha256:x"),
          },
        ),
      Error,
      "Invalid ceremony name",
    );
    assertSpyCalls(writeApprovalsFn, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test("performApproveCeremony: rejects a directory that can never run", async () => {
  const stateDir = await Deno.makeTempDir();
  const extensionsDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(extensionsDir, "ceremonies", "empty"), {
      recursive: true,
    });
    const writeApprovalsFn = spy(() => Promise.resolve());
    await assertRejects(
      () =>
        performApproveCeremony(stateDir, extensionsDir, "empty", {
          readApprovalsFn: () => Promise.resolve({}),
          writeApprovalsFn,
          hashFn: () => Promise.resolve("sha256:x"),
        }),
      Error,
      "can never run",
    );
    assertSpyCalls(writeApprovalsFn, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test("performApproveCeremony: accepts a directory with only an index.ts", async () => {
  const stateDir = await Deno.makeTempDir();
  const extensionsDir = await Deno.makeTempDir();
  try {
    const dir = join(extensionsDir, "ceremonies", "coded");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "index.ts"), "export default () => {};");
    const writeApprovalsFn = spy(() => Promise.resolve());
    await performApproveCeremony(stateDir, extensionsDir, "coded", {
      readApprovalsFn: () => Promise.resolve({}),
      writeApprovalsFn,
      hashFn: () => Promise.resolve("sha256:x"),
    });
    assertSpyCalls(writeApprovalsFn, 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test("performApproveCeremony: returns the recorded hash and hashed paths", async () => {
  const { stateDir, extensionsDir } = await makeTestDirs("digest");
  try {
    const result = await performApproveCeremony(
      stateDir,
      extensionsDir,
      "digest",
      {
        readApprovalsFn: () => Promise.resolve({}),
        writeApprovalsFn: () => Promise.resolve(),
        hashFn: () => Promise.resolve("sha256:deadbeef"),
      },
    );
    assertEquals(result.hash, "sha256:deadbeef");
    assertEquals(result.lines.length, 1);
    assertStringIncludes(result.lines[0], "prompt.md ");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test(
  "performApproveCeremony: rejects when manifest contains an out-of-root directory symlink",
  async () => {
    const { stateDir, extensionsDir } = await makeTestDirs("my-ceremony");
    try {
      const writeApprovalsFn = spy(() => Promise.resolve());
      await assertRejects(
        () =>
          performApproveCeremony(stateDir, extensionsDir, "my-ceremony", {
            readApprovalsFn: () => Promise.resolve({}),
            writeApprovalsFn,
            hashFn: () => Promise.resolve("sha256:x"),
            manifestFn: () =>
              Promise.resolve([
                { path: "index.ts", detail: "abc123" },
                { path: "lib", detail: "-> /tmp/out <unsupported>" },
              ]),
          }),
        Error,
        "Ceremony my-ceremony contains an out-of-root directory symlink and cannot be approved",
      );
      assertSpyCalls(writeApprovalsFn, 0);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(extensionsDir, { recursive: true });
    }
  },
);
