import { assert, assertEquals, assertFalse } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { checkApfelAvailable } from "./apfel.ts";

Deno.test(
  "checkApfelAvailable: returns true when runner exits with code 0",
  async () => {
    const run = spy((_args: string[]) =>
      Promise.resolve({ code: 0, stdout: "" })
    );
    assert(await checkApfelAvailable(run));
    assertSpyCalls(run, 1);
  },
);

Deno.test(
  "checkApfelAvailable: returns false when runner exits with code 5",
  async () => {
    const run = spy((_args: string[]) =>
      Promise.resolve({ code: 5, stdout: "" })
    );
    assertFalse(await checkApfelAvailable(run));
  },
);

Deno.test(
  "checkApfelAvailable: returns false when runner exits with code 127",
  async () => {
    const run = spy((_args: string[]) =>
      Promise.resolve({ code: 127, stdout: "" })
    );
    assertFalse(await checkApfelAvailable(run));
  },
);

Deno.test("checkApfelAvailable: runs apfel --model-info", async () => {
  const run = spy((_args: string[]) =>
    Promise.resolve({ code: 0, stdout: "" })
  );
  await checkApfelAvailable(run);
  assertEquals(run.calls[0].args[0], ["apfel", "--model-info"]);
});
