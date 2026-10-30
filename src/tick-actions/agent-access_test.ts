import type { AgentAccess } from "./agent-access.ts";

// @ts-expect-error — AgentAccess has no exported constructor; object literal lacks brand
const _bad: AgentAccess = {
  spawn: () => Promise.resolve(),
  model: {} as never,
  run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
};
