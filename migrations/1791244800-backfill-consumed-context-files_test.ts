import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import migration from "./1791244800-backfill-consumed-context-files.ts";
import { advancePhase } from "../src/phases/advance.ts";
import { makeTickDeps, makeTicket } from "../src/test-support.ts";
import type { TicketState } from "../src/state/types.ts";

Deno.test(
  "migration backfill-consumed-context-files: marks all but newest as consumed",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const id = "github/org/repo/1";
      const ticketDir = join(stateDir, id);
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "20260101T120000-comment-context.md"),
        "Oldest comment",
      );
      await Deno.writeTextFile(
        join(ticketDir, "20260201T080000-comment-context.md"),
        "Middle comment",
      );
      await Deno.writeTextFile(
        join(ticketDir, "20260301T090000-upstream-edit-context.md"),
        "Newest edit",
      );
      const ticket = makeTicket({ id });
      const result = await migration.run(ticket, stateDir);
      assertEquals(result.consumedContextFiles, [
        "20260101T120000-comment-context.md",
        "20260201T080000-comment-context.md",
      ]);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "migration backfill-consumed-context-files: skips ticket with existing consumedContextFiles",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const id = "github/org/repo/2";
      const ticketDir = join(stateDir, id);
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "20260101T120000-comment-context.md"),
        "Old comment",
      );
      const ticket = makeTicket({
        id,
        consumedContextFiles: ["20260101T120000-comment-context.md"],
      });
      const result = await migration.run(ticket, stateDir);
      assertEquals(result.consumedContextFiles, [
        "20260101T120000-comment-context.md",
      ]);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "migration backfill-consumed-context-files: ticket with one context file gets empty consumedContextFiles",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const id = "github/org/repo/3";
      const ticketDir = join(stateDir, id);
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "20260101T120000-comment-context.md"),
        "Only comment",
      );
      const ticket = makeTicket({ id });
      const result = await migration.run(ticket, stateDir);
      assertEquals(result.consumedContextFiles, []);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "migration backfill-consumed-context-files: ticket with no context files gets empty consumedContextFiles",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const id = "github/org/repo/4";
      const ticketDir = join(stateDir, id);
      await Deno.mkdir(ticketDir, { recursive: true });
      const ticket = makeTicket({ id });
      const result = await migration.run(ticket, stateDir);
      assertEquals(result.consumedContextFiles, []);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "migration backfill-consumed-context-files: after migration, revising prompt includes only newest context file",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const id = "github/org/repo/5";
      const ticketDir = join(stateDir, id);
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "20260101T120000-comment-context.md"),
        "Already addressed feedback",
      );
      await Deno.writeTextFile(
        join(ticketDir, "20260201T080000-comment-context.md"),
        "Pending new feedback",
      );
      const ticket = makeTicket({
        id,
        phase: "plan",
        status: "revising",
      });
      const migrated = await migration.run(ticket, stateDir);
      const spawnedPrompts: string[] = [];
      await advancePhase(
        migrated,
        stateDir,
        makeTickDeps({
          spawn: (opts) => {
            spawnedPrompts.push(opts.prompt);
            return Promise.resolve();
          },
          writeTicket: (_dir: string, _t: TicketState) => Promise.resolve(),
          resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        }),
      );
      assertFalse(spawnedPrompts[0].includes("Already addressed feedback"));
      assertStringIncludes(spawnedPrompts[0], "Pending new feedback");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);
