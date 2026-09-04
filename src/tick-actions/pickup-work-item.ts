import type { TickAction } from "./types.ts";
import type { TicketState } from "../state/types.ts";

export interface PickupWorkItemDeps {
  pickupWorkItem: (url: string, provider: string) => Promise<void>;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
}

export function pickupWorkItemAction(deps: PickupWorkItemDeps): TickAction {
  return {
    label: "Picking up work item",
    applies(ticket: TicketState): boolean {
      return ticket.status === "new" && !ticket.providerPickedUp;
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      try {
        await deps.pickupWorkItem(ticket.url, ticket.provider);
      } catch (e) {
        await deps.appendLog(stateDir, ticket.id, {
          event: "error",
          context: "pickupWorkItem",
          message: String(e),
        });
        return null;
      }
      const updated: TicketState = { ...ticket, providerPickedUp: true };
      await deps.writeTicket(stateDir, updated);
      return updated;
    },
  };
}
