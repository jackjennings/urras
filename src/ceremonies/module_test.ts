import { assertEquals, assertRejects } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import { ModuleCeremony } from "./module.ts";
import { makeTicket } from "../test-support.ts";

const TEST_NOW = Temporal.ZonedDateTime.from(
  "2026-07-27T10:00:00[America/New_York]",
);

async function makeModuleDir(source: string): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "config.toml"), 'time = "09:00"\n');
  await Deno.writeTextFile(join(dir, "index.ts"), source);
  return dir;
}

function makeCeremony(
  ceremonyDir: string,
  overrides: Partial<ConstructorParameters<typeof ModuleCeremony>[0]> = {},
): ModuleCeremony {
  return new ModuleCeremony({
    name: "digest",
    stateDir: "/state",
    ceremonyDir,
    appendTickLog: () => Promise.resolve(),
    listTickets: () => Promise.resolve(["github/org/repo/1"]),
    readTicket: () => Promise.resolve(makeTicket()),
    generateText: () => Promise.resolve("text"),
    generateObject: () => Promise.resolve(null),
    runGit: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
    runGh: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
    commitState: () => Promise.resolve(),
    ...overrides,
  });
}

Deno.test("ModuleCeremony: runs the default export and writes output", async () => {
  const dir = await makeModuleDir(
    `export default async function (context) {
      const ids = await context.listTickets();
      await context.writeOutput("# Report\\n\\n" + ids.length + " tickets\\n");
    }`,
  );
  try {
    const outputDir = join(dir, "output");
    await makeCeremony(dir).run(TEST_NOW, outputDir);
    const written = await Deno.readTextFile(
      join(outputDir, "20260727T100000-digest.md"),
    );
    assertEquals(written, "# Report\n\n1 tickets\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ModuleCeremony: exposes the parsed config", async () => {
  const dir = await makeModuleDir(
    `export default async function (context) {
      await context.writeOutput(String(context.config.time));
    }`,
  );
  try {
    const outputDir = join(dir, "output");
    await makeCeremony(dir).run(TEST_NOW, outputDir);
    assertEquals(
      await Deno.readTextFile(join(outputDir, "20260727T100000-digest.md")),
      "09:00",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ModuleCeremony: a throwing module is contained and logged", async () => {
  const dir = await makeModuleDir(
    `export default function () { throw new Error("boom"); }`,
  );
  try {
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    await makeCeremony(dir, { appendTickLog }).run(
      TEST_NOW,
      join(dir, "output"),
    );
    assertEquals(appendTickLog.calls[0].args[0], {
      event: "ceremony-warning",
      ceremony: "digest",
      reason: "ceremony-failed",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ModuleCeremony: a module with no default export is logged", async () => {
  const dir = await makeModuleDir(`export const notDefault = 1;`);
  try {
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    await makeCeremony(dir, { appendTickLog }).run(
      TEST_NOW,
      join(dir, "output"),
    );
    assertEquals(appendTickLog.calls[0].args[0], {
      event: "ceremony-warning",
      ceremony: "digest",
      reason: "ceremony-failed",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ModuleCeremony: a module that fails to parse is logged", async () => {
  const dir = await makeModuleDir(`export default function ( {`);
  try {
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    await makeCeremony(dir, { appendTickLog }).run(
      TEST_NOW,
      join(dir, "output"),
    );
    assertEquals(appendTickLog.calls[0].args[0], {
      event: "ceremony-warning",
      ceremony: "digest",
      reason: "ceremony-failed",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ModuleCeremony: a malformed config.toml is contained and logged", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "config.toml"), "not = [valid");
  await Deno.writeTextFile(
    join(dir, "index.ts"),
    `export default async function (context) {
      await context.writeOutput("should not be written");
    }`,
  );
  try {
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    const outputDir = join(dir, "output");
    await makeCeremony(dir, { appendTickLog }).run(TEST_NOW, outputDir);
    assertEquals(appendTickLog.calls[0].args[0], {
      event: "ceremony-warning",
      ceremony: "digest",
      reason: "ceremony-failed",
    });
    await assertRejects(
      () => Deno.readTextFile(join(outputDir, "20260727T100000-digest.md")),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ModuleCeremony: log always identifies the ceremony by its own name", async () => {
  const dir = await makeModuleDir(
    `export default async function (context) {
      await context.log({ event: "custom", ceremony: "attacker" });
      await context.writeOutput("x");
    }`,
  );
  try {
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    await makeCeremony(dir, { appendTickLog }).run(
      TEST_NOW,
      join(dir, "output"),
    );
    assertEquals(appendTickLog.calls[0].args[0], {
      event: "custom",
      ceremony: "digest",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ModuleCeremony: notify is reachable from the context", async () => {
  const dir = await makeModuleDir(
    `export default async function (context) {
      await context.notify("lazyboy", "digest is ready");
    }`,
  );
  try {
    const notify = spy((_title: string, _message: string) => Promise.resolve());
    await makeCeremony(dir, { notify }).run(TEST_NOW, join(dir, "output"));
    assertSpyCalls(notify, 1);
    assertEquals(notify.calls[0].args, ["lazyboy", "digest is ready"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ModuleCeremony: notify without an injected notifier does not fail the ceremony", async () => {
  const dir = await makeModuleDir(
    `export default async function (context) {
      await context.notify("lazyboy", "digest is ready");
      await context.writeOutput("ran to completion");
    }`,
  );
  try {
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    const outputDir = join(dir, "output");
    await makeCeremony(dir, { appendTickLog, notify: undefined }).run(
      TEST_NOW,
      outputDir,
    );
    assertSpyCalls(appendTickLog, 0);
    assertEquals(
      await Deno.readTextFile(join(outputDir, "20260727T100000-digest.md")),
      "ran to completion",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ModuleCeremony: commitState is reachable from the context", async () => {
  const dir = await makeModuleDir(
    `export default async function (context) {
      await context.writeOutput("x");
      await context.commitState();
    }`,
  );
  try {
    const commitState = spy(() => Promise.resolve());
    await makeCeremony(dir, { commitState }).run(TEST_NOW, join(dir, "output"));
    assertSpyCalls(commitState, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
