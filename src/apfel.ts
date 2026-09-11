export type CommandRunner = (
  args: string[],
) => Promise<{ code: number; stdout: string }>;

export async function checkApfelAvailable(
  run: CommandRunner,
): Promise<boolean> {
  const { code } = await run(["apfel", "--model-info"]);
  return code === 0;
}

export function defaultCommandRunner(): CommandRunner {
  return async (args) => {
    const out = await new Deno.Command(args[0], {
      args: args.slice(1),
      stdout: "null",
      stderr: "null",
    }).output();
    return { code: out.code, stdout: "" };
  };
}

export function captureCommandRunner(): CommandRunner {
  return async (args) => {
    const out = await new Deno.Command(args[0], {
      args: args.slice(1),
      stdout: "piped",
      stderr: "null",
    }).output();
    return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
  };
}
