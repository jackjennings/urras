import type { Provider, WorkItem } from "./types.ts";
import { readTextFile, writeTextFile } from "../filesystem.ts";

type ReadFileFn = (path: string) => Promise<string>;
type WriteFileFn = (path: string, content: string) => Promise<void>;

async function hashLine(line: string): Promise<string> {
  const bytes = new TextEncoder().encode(line);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

function stripTitle(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^\([A-Z]\)\s+/, "");
  s = s.replace(/(^|\s)\+\S+/g, "$1");
  s = s.replace(/(^|\s)@\S+/g, "$1");
  s = s.replace(/(^|\s)\S+:\S+/g, "$1");
  return s.replace(/\s+/g, " ").trim();
}

export class TodoTxtProvider implements Provider {
  private file: string;
  private _readTextFile: ReadFileFn;
  private _writeTextFile: WriteFileFn;

  constructor(opts: {
    file: string;
    _readTextFile?: ReadFileFn;
    _writeTextFile?: WriteFileFn;
  }) {
    this.file = opts.file;
    this._readTextFile = opts._readTextFile ?? readTextFile;
    this._writeTextFile = opts._writeTextFile ?? writeTextFile;
  }

  async fetchNew(knownIds: Set<string>): Promise<WorkItem[]> {
    let content: string;
    try {
      content = await this._readTextFile(this.file);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return [];
      throw e;
    }
    const lines = content.split("\n");
    const items: WorkItem[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith("x ")) continue;
      const hash = await hashLine(line.trim());
      const id = `todo-txt/${hash}`;
      if (knownIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        provider: "todo-txt",
        title: stripTitle(line),
        description: line,
        url: `todo-txt://${this.file}#${hash}`,
      });
    }
    return items;
  }

  pickup(_url: string): Promise<void> {
    return Promise.resolve();
  }

  async close(url: string): Promise<void> {
    const match = url.match(/^todo-txt:\/\/(.+)#([0-9a-f]{8})$/);
    if (!match) throw new Error(`Cannot parse todo-txt URL: ${url}`);
    const filePath = match[1];
    const hash = match[2];
    const content = await this._readTextFile(filePath);
    const lines = content.split("\n");
    let matchIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("x ")) continue;
      const h = await hashLine(lines[i].trim());
      if (h === hash) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx === -1) return;
    const today = Temporal.Now.plainDateISO("UTC").toString();
    lines[matchIdx] = `x ${today} ${lines[matchIdx]}`;
    await this._writeTextFile(filePath, lines.join("\n"));
  }

  static toSortable(id: string): Array<string | number> {
    return [id];
  }
}
