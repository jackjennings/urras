import type { TicketState } from "../state/types.ts";
import type { LanguageModelRequest } from "../models/types.ts";

export interface Ceremony {
  readonly name: string;
  run(now: Temporal.ZonedDateTime, outputDir: string): Promise<void>;
}

export interface CeremonyContext {
  now: Temporal.ZonedDateTime;
  stateDir: string;
  ceremonyDir: string;
  outputDir: string;
  config: Record<string, unknown>;
  listTickets(): Promise<string[]>;
  readTicket(id: string): Promise<TicketState>;
  generateText(request: LanguageModelRequest): Promise<string | null>;
  generateObject<T>(
    request: LanguageModelRequest & { schema: object },
  ): Promise<T | null>;
  runGit(
    args: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }>;
  runGh(
    args: string[],
    token: string,
  ): Promise<{ success: boolean; stdout: string; stderr: string }>;
  writeOutput(content: string): Promise<void>;
  commitState(): Promise<void>;
  notify(title: string, message: string): Promise<void>;
  log(entry: object): Promise<void>;
}

export type CeremonyModule = (
  context: CeremonyContext,
) => Promise<void> | void;

export const BUILT_IN_CEREMONY_NAMES = [
  "documentation-gaps",
  "agents-md-consolidation",
];

const CEREMONY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidCeremonyName(name: string): boolean {
  if (name === "." || name === "..") return false;
  return CEREMONY_NAME_PATTERN.test(name);
}
