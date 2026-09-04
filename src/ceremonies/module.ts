import { join, toFileUrl } from "@std/path";
import { parse } from "@std/toml";
import { mkdir, readTextFile, writeTextFile } from "../filesystem.ts";
import { compactTimestamp } from "../timestamp.ts";
import type { LanguageModelRequest } from "../models/types.ts";
import type { TicketState } from "../state/types.ts";
import type { Ceremony, CeremonyContext } from "./types.ts";

export interface ModuleCeremonyDeps {
  name: string;
  stateDir: string;
  ceremonyDir: string;
  appendTickLog(entry: object): Promise<void>;
  listTickets(): Promise<string[]>;
  readTicket(id: string): Promise<TicketState>;
  generateText(request: LanguageModelRequest): Promise<string | null>;
  commitState(): Promise<void>;
  notify?(title: string, message: string): Promise<void>;
  pushTicket(ticket: { title: string; body: string }): Promise<void>;
}

export class ModuleCeremony implements Ceremony {
  readonly name: string;
  readonly #deps: ModuleCeremonyDeps;

  constructor(deps: ModuleCeremonyDeps) {
    this.name = deps.name;
    this.#deps = deps;
  }

  async #fail(): Promise<void> {
    await this.#deps.appendTickLog({
      event: "ceremony-warning",
      ceremony: this.name,
      reason: "ceremony-failed",
    });
  }

  async run(now: Temporal.ZonedDateTime, outputDir: string): Promise<void> {
    let entry: { default?: unknown };
    try {
      entry = await import(
        toFileUrl(join(this.#deps.ceremonyDir, "index.ts")).href
      );
    } catch {
      await this.#fail();
      return;
    }

    if (typeof entry.default !== "function") {
      await this.#fail();
      return;
    }

    let config: Record<string, unknown> = {};
    try {
      config = parse(
        await readTextFile(join(this.#deps.ceremonyDir, "config.toml")),
      ) as Record<string, unknown>;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        await this.#fail();
        return;
      }
    }

    const context: CeremonyContext = {
      now,
      stateDir: this.#deps.stateDir,
      ceremonyDir: this.#deps.ceremonyDir,
      outputDir,
      config,
      listTickets: () => this.#deps.listTickets(),
      readTicket: (id) => this.#deps.readTicket(id),
      generateText: (request) => this.#deps.generateText(request),
      writeOutput: async (content) => {
        await mkdir(outputDir, { recursive: true });
        await writeTextFile(
          join(outputDir, `${compactTimestamp(now)}-${this.name}.md`),
          content,
        );
      },
      commitState: () => this.#deps.commitState(),
      notify: async (title, message) => {
        await this.#deps.notify?.(title, message);
      },
      log: (fields) =>
        this.#deps.appendTickLog({ ...fields, ceremony: this.name }),
      pushTicket: (ticket) => this.#deps.pushTicket(ticket),
    };

    try {
      await (entry.default as (context: CeremonyContext) => Promise<void>)(
        context,
      );
    } catch {
      await this.#fail();
    }
  }
}
