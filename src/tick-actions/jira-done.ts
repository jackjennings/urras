import type { TickAction } from "./types.ts";
import type { TicketState } from "../state/types.ts";
import { jiraTransition } from "./jira-transition.ts";
import { HttpClient } from "../http-client.ts";

export interface JiraDoneDeps {
  baseUrl: string;
  email: string;
  apiToken: string;
  project: string;
  targetStatusName: string;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  http: HttpClient;
}

export function jiraDoneAction(opts: JiraDoneDeps): TickAction {
  return {
    label: "Updating Jira",
    applies(ticket: TicketState): boolean {
      const projectKey = ticket.id.match(
        /^jira\/([A-Za-z][A-Za-z0-9]*)-\d+/,
      )?.[1];
      return (
        ticket.provider === "jira" &&
        ticket.phase === "merge" &&
        ticket.status === "done" &&
        !ticket.providerDone &&
        projectKey === opts.project
      );
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const issueKey = ticket.id.replace(/^jira\//, "");
      try {
        await jiraTransition({
          baseUrl: opts.baseUrl,
          email: opts.email,
          apiToken: opts.apiToken,
          issueKey,
          targetStatusName: opts.targetStatusName,
          http: opts.http,
        });
      } catch (e) {
        await opts.appendLog(stateDir, ticket.id, {
          event: "error",
          context: "jiraDone",
          message: String(e),
        });
        return null;
      }
      const updated: TicketState = { ...ticket, providerDone: true };
      await opts.writeTicket(stateDir, updated);
      return updated;
    },
  };
}
