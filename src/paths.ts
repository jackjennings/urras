import { join } from "@std/path";

export function urrasDir(): string {
  const override = Deno.env.get("URRAS_DIR");
  if (override) return override;
  const home = Deno.env.get("HOME")!;
  return join(home, ".urras");
}

export function bootId(): string {
  if (Deno.build.os === "linux") {
    const stat = new TextDecoder().decode(
      Deno.readFileSync("/proc/stat"),
    );
    const match = stat.match(/^btime\s+(\d+)/m);
    if (!match) throw new Error(`bootId: btime not found in /proc/stat`);
    return match[1];
  }
  const result = new Deno.Command("sysctl", {
    args: ["-n", "kern.boottime"],
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  const raw = new TextDecoder().decode(result.stdout).trim();
  const match = raw.match(/sec\s*=\s*(\d+)/);
  if (!match) throw new Error(`bootId: unexpected sysctl output: ${raw}`);
  return match[1];
}

const BOOT_ID_TOLERANCE_SECONDS = 120;

export function isSameBoot(left: string, right: string): boolean {
  if (left === right) return true;
  const leftSeconds = Number(left);
  const rightSeconds = Number(right);
  if (!Number.isInteger(leftSeconds) || !Number.isInteger(rightSeconds)) {
    return false;
  }
  return Math.abs(leftSeconds - rightSeconds) <= BOOT_ID_TOLERANCE_SECONDS;
}
