import { parse } from "@std/toml";
import { join } from "@std/path";

// Prints [tick].interval_seconds without loadConfig, which requires the
// tick-time GitHub token env vars to be set.
const path = join(Deno.env.get("HOME")!, ".config", "urras", "config.toml");
const tick = (parse(await Deno.readTextFile(path)) as {
  tick?: { interval_seconds?: unknown };
}).tick;
const value = tick?.interval_seconds;
console.log(Number.isInteger(value) && (value as number) > 0 ? value : 300);
