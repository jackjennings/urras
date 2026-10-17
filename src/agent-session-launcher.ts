import type { CommandRunner } from "./apfel.ts";

export async function checkRexAvailable(
  run: CommandRunner,
): Promise<boolean> {
  const { code } = await run(["which", "rex"]);
  return code === 0;
}
