import { assert, assertEquals, assertFalse } from "@std/assert";
import { spy } from "@std/testing/mock";
import { checkTuicrAvailable } from "./tuicr.ts";

Deno.test(
  "checkTuicrAvailable: returns true when runner exits with code 0",
  async () => {
    const run = spy((_args: string[]) =>
      Promise.resolve({ code: 0, stdout: "" })
    );
    assert(await checkTuicrAvailable(run));
  },
);

Deno.test(
  "checkTuicrAvailable: returns false when runner exits with non-zero code",
  async () => {
    const run = spy((_args: string[]) =>
      Promise.resolve({ code: 127, stdout: "" })
    );
    assertFalse(await checkTuicrAvailable(run));
  },
);

Deno.test("checkTuicrAvailable: runs which tuicr", async () => {
  const run = spy((_args: string[]) =>
    Promise.resolve({ code: 0, stdout: "" })
  );
  await checkTuicrAvailable(run);
  assertEquals(run.calls[0].args[0], ["which", "tuicr"]);
});
