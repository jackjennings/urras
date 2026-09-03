import { assertEquals } from "@std/assert";

const script = new URL("../scripts/commit-signed.sh", import.meta.url)
  .pathname;

async function checkSigned(status: string): Promise<number> {
  const { code } = await new Deno.Command("bash", {
    args: [script, status, "deadbeef"],
    stderr: "null",
  }).output();
  return code;
}

Deno.test("commit-signed: rejects commit with no signature", async () => {
  assertEquals(await checkSigned("N"), 1);
});

Deno.test("commit-signed: accepts good signature", async () => {
  assertEquals(await checkSigned("G"), 0);
});

Deno.test("commit-signed: accepts good signature with unknown validity", async () => {
  assertEquals(await checkSigned("U"), 0);
});

Deno.test("commit-signed: accepts signature that could not be checked", async () => {
  assertEquals(await checkSigned("E"), 0);
});
