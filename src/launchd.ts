import { join } from "@std/path";
import { writeTextFile } from "./filesystem.ts";

const LABEL = "com.jackjennings.urras";

export function plistPath(): string {
  return join(
    Deno.env.get("HOME")!,
    "Library",
    "LaunchAgents",
    `${LABEL}.plist`,
  );
}

export function plistContent(lazboyDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${lazboyDir}/scripts/daemon.sh</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
</dict>
</plist>
`;
}

export type LaunchctlRunner = (args: string[]) => Promise<{ code: number }>;

async function defaultLaunchctlRunner(
  args: string[],
): Promise<{ code: number }> {
  const result = await new Deno.Command("launchctl", {
    args,
    stdout: "null",
    stderr: "null",
  }).output();
  return { code: result.code };
}

export async function detectLaunchdEnabled(
  runLaunchctl: LaunchctlRunner = defaultLaunchctlRunner,
): Promise<boolean> {
  try {
    const { code } = await runLaunchctl([
      "print",
      `gui/${Deno.uid()}/${LABEL}`,
    ]);
    return code === 0;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

export function isLaunchdEnabled(): Promise<boolean> {
  return detectLaunchdEnabled();
}

export async function enableLaunchd(lazboyDir: string): Promise<void> {
  if (await detectLaunchdEnabled()) {
    console.log("Already enabled.");
    return;
  }
  const path = plistPath();
  await writeTextFile(path, plistContent(lazboyDir));
  await new Deno.Command("launchctl", {
    args: ["bootstrap", `gui/${Deno.uid()}`, path],
  }).output();
  console.log("Enabled.");
}

export async function disableLaunchd(): Promise<void> {
  if (!(await detectLaunchdEnabled())) {
    console.log("Not loaded.");
    return;
  }
  await new Deno.Command("launchctl", {
    args: ["bootout", `gui/${Deno.uid()}/${LABEL}`],
  }).output();
  console.log("Disabled.");
}
