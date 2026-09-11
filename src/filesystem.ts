export { existsSync } from "@std/fs";
import Handlebars from "handlebars";

export async function renderPrompt(
  templateUrl: URL,
  vars?: Record<string, unknown>,
): Promise<string> {
  const source = await readTextFile(templateUrl);
  const template = Handlebars.compile(source, { noEscape: true });
  return template(vars ?? {});
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

export const stat = (path: string) => Deno.stat(path);
export const readFile = (path: string | URL) => Deno.readFile(path);
export const readDir = (path: string) => Deno.readDir(path);
export const readDirSync = (path: string) => Deno.readDirSync(path);
export const remove = (path: string, options?: Deno.RemoveOptions) =>
  Deno.remove(path, options);
export const removeSync = (path: string, options?: Deno.RemoveOptions) =>
  Deno.removeSync(path, options);
export const readTextFile = (path: string | URL) => Deno.readTextFile(path);
export const readTextFileSync = (path: string) => Deno.readTextFileSync(path);
export const mkdir = (path: string, options?: Deno.MkdirOptions) =>
  Deno.mkdir(path, options);
export const writeTextFile = (
  path: string,
  data: string,
  options?: Deno.WriteFileOptions,
) => Deno.writeTextFile(path, data, options);
export const rename = (oldPath: string, newPath: string) =>
  Deno.rename(oldPath, newPath);
export const open = (path: string | URL, options?: Deno.OpenOptions) =>
  Deno.open(path, options);
export const readLink = (path: string | URL) => Deno.readLink(path);
export const realPath = (path: string | URL) => Deno.realPath(path);
