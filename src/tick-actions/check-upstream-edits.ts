import { join } from "@std/path";
import type { TickAction } from "./types.ts";
import type { Config, TicketState } from "../state/types.ts";

export interface CheckUpstreamEditsDeps {
  isProcessAlive: (ticketId: string) => boolean;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  fetchGitHubIssue: (
    ticketId: string,
  ) => Promise<{ title: string; body: string | null } | null>;
  writeUpstreamEditContextFile: (
    ticketDir: string,
    content: string,
  ) => Promise<void>;
  judgeUpstreamEdit: (
    oldTitle: string,
    newTitle: string,
    oldBody: string,
    newBody: string,
  ) => Promise<boolean | null>;
  generateShortTitle: (title: string, body: string) => Promise<string | null>;
  config: Config;
}

const MONITORED_PHASES = new Set(["spec", "plan", "implementation", "merge"]);
const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000;

function hourElapsed(timestamp: string): boolean {
  try {
    const then = Temporal.Instant.from(timestamp);
    const diffMs = Temporal.Now.instant().epochMilliseconds -
      then.epochMilliseconds;
    return diffMs >= MIN_SYNC_INTERVAL_MS;
  } catch {
    return true;
  }
}

export function checkUpstreamEditsAction(
  deps: CheckUpstreamEditsDeps,
): TickAction {
  return {
    label: "Checking upstream edits",
    applies(ticket: TicketState): boolean {
      return (
        ticket.provider === "github" &&
        MONITORED_PHASES.has(ticket.phase) &&
        ticket.status === "waiting" &&
        !deps.isProcessAlive(ticket.id) &&
        deps.config.tick.checkUpstreamEdits !== false &&
        (ticket.lastUpstreamSyncTimestamp === undefined ||
          hourElapsed(ticket.lastUpstreamSyncTimestamp))
      );
    },

    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const ticketDir = join(stateDir, ticket.id);

      const fetched = await deps.fetchGitHubIssue(ticket.id);
      if (fetched === null) return null;

      const fetchedTitle = fetched.title;
      const fetchedBody = fetched.body ?? "";
      const storedBody = ticket.body;

      const titleChanged = fetchedTitle !== ticket.title;
      const bodyChanged = fetchedBody !== storedBody;

      const now = Temporal.Now.instant().toString();

      if (!titleChanged && !bodyChanged) {
        const updated: TicketState = {
          ...ticket,
          lastUpstreamSyncTimestamp: now,
          updated: now,
        };
        await deps.writeTicket(stateDir, updated);
        return updated;
      }

      let newShortTitle = ticket.shortTitle;
      if (titleChanged) {
        const generated = await deps.generateShortTitle(
          fetchedTitle,
          fetchedBody,
        );
        if (generated !== null) {
          newShortTitle = generated;
        }
      }

      const substantive = await deps.judgeUpstreamEdit(
        ticket.title,
        fetchedTitle,
        storedBody,
        fetchedBody,
      );
      const isSubstantive = substantive ?? true;

      let updatedStatus = ticket.status;
      if (isSubstantive) {
        const content = `## Upstream edit detected on ${ticket.url}\n\n` +
          `**Old title:** ${ticket.title}\n\n` +
          `**New title:** ${fetchedTitle}\n\n` +
          `**Old body:**\n\n${storedBody}\n\n` +
          `**New body:**\n\n${fetchedBody}`;
        await deps.writeUpstreamEditContextFile(ticketDir, content);
        updatedStatus = "revising";
      }

      await deps.appendLog(stateDir, ticket.id, {
        action: "check-upstream-edits",
        titleChanged,
        bodyChanged,
        substantive,
      });

      const updated: TicketState = {
        ...ticket,
        title: fetchedTitle,
        body: fetchedBody,
        shortTitle: newShortTitle,
        status: updatedStatus,
        lastUpstreamSyncTimestamp: now,
        updated: now,
      };
      await deps.writeTicket(stateDir, updated);
      return updated;
    },
  };
}
