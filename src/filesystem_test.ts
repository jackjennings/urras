import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { renderPrompt } from "./filesystem.ts";

Deno.test("renderPrompt: returns static template content", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "t.prompt.hbs");
    await Deno.writeTextFile(path, "Hello world");
    assertEquals(await renderPrompt(new URL(`file://${path}`)), "Hello world");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderPrompt: substitutes variables", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "t.prompt.hbs");
    await Deno.writeTextFile(path, "Hello {{name}}");
    assertEquals(
      await renderPrompt(new URL(`file://${path}`), { name: "world" }),
      "Hello world",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderPrompt: does not HTML-escape variable values", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "t.prompt.hbs");
    await Deno.writeTextFile(path, "{{content}}");
    assertEquals(
      await renderPrompt(new URL(`file://${path}`), {
        content: "a < b & c > d",
      }),
      "a < b & c > d",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
