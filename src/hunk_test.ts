import { assert, assertEquals, assertFalse } from "@std/assert";
import { spy } from "@std/testing/mock";
import { checkHunkAvailable } from "./hunk.ts";

Deno.test(
  "checkHunkAvailable: returns true when runner exits with code 0",
  async () => {
    const run = spy((_args: string[]) =>
      Promise.resolve({ code: 0, stdout: "" })
    );
    assert(await checkHunkAvailable(run));
  },
);

Deno.test(
  "checkHunkAvailable: returns false when runner exits with non-zero code",
  async () => {
    const run = spy((_args: string[]) =>
      Promise.resolve({ code: 127, stdout: "" })
    );
    assertFalse(await checkHunkAvailable(run));
  },
);

Deno.test("checkHunkAvailable: runs which hunk", async () => {
  const run = spy((_args: string[]) =>
    Promise.resolve({ code: 0, stdout: "" })
  );
  await checkHunkAvailable(run);
  assertEquals(run.calls[0].args[0], ["which", "hunk"]);
});
