import type { TicketState } from "../state/types.ts";

export interface TickAction {
  label?: string;
  usesAgent: boolean;
  applies(ticket: TicketState): boolean;
  run(ticket: TicketState, stateDir: string): Promise<TicketState | null>;
}
