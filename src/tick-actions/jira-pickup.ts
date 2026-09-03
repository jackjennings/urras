import type { TickAction } from "./types.ts";
import type { TicketState } from "../state/types.ts";
import { jiraTransition } from "./jira-transition.ts";
import { HttpClient } from "../http-client.ts";

export interface JiraPickupDeps {
  baseUrl: string;
  email: string;
  apiToken: string;
  project: string;
  targetStatusName: string;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  http: HttpClient;
}

export function jiraPickupAction(opts: JiraPickupDeps): TickAction {
  return {
    label: "Picking up Jira",
    applies(ticket: TicketState): boolean {
      const projectKey = ticket.id.match(
        /^jira\/([A-Za-z][A-Za-z0-9]*)-\d+/,
      )?.[1];
      return (
        ticket.provider === "jira" &&
        ticket.status === "new" &&
        !ticket.providerPickedUp &&
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
          context: "jiraPickup",
          message: String(e),
        });
        return null;
      }
      const updated: TicketState = { ...ticket, providerPickedUp: true };
      await opts.writeTicket(stateDir, updated);
      return updated;
    },
  };
}
