import type { TickAction } from "./types.ts";
import type { LanguageModel } from "../models/types.ts";
import type { ExecutorOptions } from "../executor.ts";

type CommandRunner = (
  cmd: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;
type SpawnFn = (opts: ExecutorOptions) => Promise<void>;

declare const _brand: unique symbol;

export interface AgentAccess {
  readonly [_brand]: true;
  spawn: SpawnFn;
  model: LanguageModel;
  run: CommandRunner;
}

export function agentAction<T extends TickAction & { usesAgent: true }>(
  access: AgentAccess,
  build: (access: AgentAccess) => T,
): T {
  return build(access);
}
