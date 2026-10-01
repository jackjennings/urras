import type { CommandRunner } from "./apfel.ts";

export async function checkHunkAvailable(
  run: CommandRunner,
): Promise<boolean> {
  const { code } = await run(["which", "hunk"]);
  return code === 0;
}
