import { open, readTextFile, stat, writeTextFile } from "../filesystem.ts";
import type { Provider, WorkItem } from "./types.ts";

export class InternalProvider implements Provider {
  readonly #queuePath: string;
  readonly #cursorPath: string;

  constructor(queuePath: string) {
    this.#queuePath = queuePath;
    this.#cursorPath = queuePath + ".cursor";
  }

  async fetchNew(knownIds: Set<string>): Promise<WorkItem[]> {
    let fileSize: number;
    try {
      const info = await stat(this.#queuePath);
      fileSize = info.size;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return [];
      throw e;
    }

    let offset = 0;
    try {
      const cursorText = await readTextFile(this.#cursorPath);
      const parsed = parseInt(cursorText.trim(), 10);
      if (!isNaN(parsed) && parsed >= 0) {
        offset = parsed;
      }
    } catch {
      // absent or unreadable: use offset 0
    }

    if (fileSize <= offset) return [];

    const newByteCount = fileSize - offset;
    const buffer = new Uint8Array(newByteCount);
    const file = await open(this.#queuePath);
    try {
      await file.seek(offset, Deno.SeekMode.Start);
      let bytesRead = 0;
      while (bytesRead < newByteCount) {
        const n = await file.read(buffer.subarray(bytesRead));
        if (n === null) break;
        bytesRead += n;
      }
    } finally {
      file.close();
    }

    await writeTextFile(this.#cursorPath, String(fileSize));

    const text = new TextDecoder().decode(buffer);
    const items: WorkItem[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          id?: string;
          title?: string;
          body?: string;
        };
        if (typeof parsed.id !== "string" || knownIds.has(parsed.id)) continue;
        const uuid = parsed.id.replace(/^internal\//, "");
        items.push({
          id: parsed.id,
          provider: "internal",
          title: parsed.title ?? "",
          description: parsed.body ?? "",
          url: `internal://${uuid}`,
        });
      } catch {
        continue;
      }
    }
    return items;
  }

  close(_url: string): Promise<void> {
    return Promise.resolve();
  }
}
