import { commands } from "./commands/registry.ts";
import { formatCommandHelp, formatGlobalHelp } from "./commands/help.ts";
import { readTextFile } from "./filesystem.ts";

try {
  const content = await readTextFile(
    `${Deno.env.get("HOME")}/.config/urras/env`,
  );
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (Deno.env.get(key) === undefined) {
      Deno.env.set(key, value);
    }
  }
} catch (err) {
  if (!(err instanceof Deno.errors.NotFound)) {
    throw err;
  }
}

const publicCommands = commands
  .filter((c) => !c.name.startsWith("_"))
  .sort((a, b) => a.name.localeCompare(b.name));

if (Deno.args[0] === "--help") {
  console.log(formatGlobalHelp(commands));
  Deno.exit(0);
}

const name = Deno.args[0];
const command = commands.find((c) => c.name === name);

if (!command) {
  const usage = publicCommands.map((c) => c.name).join("|");
  console.error(`Usage: ur <${usage}>`);
  Deno.exit(1);
}

if (Deno.args[1] === "--help") {
  console.log(formatCommandHelp(command));
  Deno.exit(0);
}

try {
  await command.run(Deno.args.slice(1));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  Deno.exit(1);
}
