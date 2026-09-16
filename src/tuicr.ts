import type { CommandRunner } from "./apfel.ts";

export async function checkTuicrAvailable(
  run: CommandRunner,
): Promise<boolean> {
  const { code } = await run(["which", "tuicr"]);
  return code === 0;
}
