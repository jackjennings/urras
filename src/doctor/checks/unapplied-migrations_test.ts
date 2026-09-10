import { assertEquals, assertStringIncludes } from "@std/assert";
import { unappliedMigrationsCheck } from "./unapplied-migrations.ts";

function makeDeps(
  files: string[],
  applied: string | null,
): Parameters<typeof unappliedMigrationsCheck>[0] {
  return {
    readDir: async function* () {
      for (const name of files) yield { name, isFile: true };
    },
    readTextFile: applied === null
      ? () => Promise.reject(new Deno.errors.NotFound())
      : () => Promise.resolve(applied),
    stateDir: "/state",
    migrationsDir: "/migrations",
  };
}

Deno.test("unappliedMigrationsCheck: all migrations applied → pass", async () => {
  const result = await unappliedMigrationsCheck(
    makeDeps(["123-foo.ts"], "123-foo.ts\n"),
  ).run();
  assertEquals(result.status, "pass");
});

Deno.test(
  "unappliedMigrationsCheck: unapplied migration → fail with id in detail",
  async () => {
    const result = await unappliedMigrationsCheck(
      makeDeps(["123-foo.ts"], ""),
    ).run();
    assertEquals(result.status, "fail");
    assertStringIncludes(result.detail, "123-foo");
  },
);

Deno.test(
  "unappliedMigrationsCheck: .migrations absent treated as empty list",
  async () => {
    const result = await unappliedMigrationsCheck(
      makeDeps(["123-foo.ts"], null),
    ).run();
    assertEquals(result.status, "fail");
  },
);

Deno.test(
  "unappliedMigrationsCheck: non-migration .ts files are ignored",
  async () => {
    const result = await unappliedMigrationsCheck(
      makeDeps(["README.ts", "123_bad.ts", "foo.ts"], ""),
    ).run();
    assertEquals(result.status, "pass");
  },
);
