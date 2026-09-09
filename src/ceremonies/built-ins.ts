import { AgentsMdConsolidationCeremony } from "./agents-md-consolidation.ts";
import { DocumentationGapsCeremony } from "./documentation-gaps.ts";

export const BUILT_IN_CEREMONY_NAMES = [
  DocumentationGapsCeremony.NAME,
  AgentsMdConsolidationCeremony.NAME,
] as const;
