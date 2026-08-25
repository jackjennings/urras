# Pipeline templates

## Problem

Every ticket runs the same five-phase pipeline
(`intake → enrichment → spec → plan → implementation`) regardless of how
trivial or how consequential the change is. A one-line config fix burns the
same phase count as a multi-file architectural change. There's already a
narrow escape hatch — the spec agent can set `phases.plan.skip: true` in
`meta.md` to skip planning for a trivial change — but nothing generalizes it,
and nothing exists on the other end of the spectrum for high-stakes tickets
that would benefit from more scrutiny than the fixed pipeline gives them (e.g.
generating multiple candidate plans and judging between them).

Goal: let a ticket run a pipeline shaped to its complexity — fewer phases for
simple work, more (eventually, wider) for consequential work — without hiding
that shape inside prompt wording that only a full read of five different
phases' judgment calls could reconstruct.

## Approach

Pipelines are named, pluggable templates: an ordered list of phase steps,
loaded from the extensions directory the same way ceremonies already are.
urras core ships exactly one built-in template (`default`, equivalent to
today's fixed phase sequence) and defers everything else — `fast`, `thorough`,
an org-specific shape — to `{extensionsDir}/pipelines/<name>/pipeline.toml`.
Intake judges which template a ticket needs and records its choice in its own
output; after self-review approves, a dedicated tick action resolves,
validates, and pins the template's steps onto the ticket. From then on, the
existing phase-sequencing logic in `advancePhase` walks the ticket's pinned
steps instead of the global phase-sequence constant.

Best-of-N generation (running multiple candidate plans and judging between
them) is a real, wanted future capability but is **not** designed here beyond
making sure this mechanism doesn't preclude it — see Deferred below.

### Rejected alternatives

- **Generalize the existing skip mechanism into a cascade.** Instead of named
  templates, let every phase locally decide (via the same self-assessment
  idiom `spec.md` already uses for `phases.plan.skip`) whether to skip or
  expand the phase after it. This composes more freely and reuses proven
  machinery, but a pipeline's shape becomes emergent — scattered across up to
  five independent judgment calls with no single artifact that "is" the fast
  pipeline. That directly conflicts with the goal of being able to move
  pipeline definitions into the extensions directory as self-contained,
  pluggable units, the way ceremonies already are. Named templates keep the
  shape as one first-class artifact; rejected in favor of that.
- **Resolve the pipeline before intake runs**, from ticket source/label alone
  (e.g. a Jira project always maps to `fast`). Removes a judgment call, but
  loses the ability to route based on the ticket's actual content, and was
  explicitly not the direction chosen — intake's own judgment, self-reviewed,
  is the classification mechanism.
- **Design the best-of-N judge mechanism now, alongside pipeline switching.**
  Explicitly out of scope per the project's own scoping decision — see
  Deferred.

## Template artifact

A pipeline template is a TOML file (not YAML — `@std/toml` is already a
dependency for `config.toml`; there is no standalone YAML parser in this repo,
only `gray-matter`'s frontmatter parsing, which doesn't apply to a
free-standing file):

```toml
# {extensionsDir}/pipelines/fast/pipeline.toml
name = "fast"
description = "Skips enrichment, spec, and plan for a single, self-contained change with no interface changes."

[[steps]]
phase = "intake"

[[steps]]
phase = "implementation"
```

```toml
# {extensionsDir}/pipelines/thorough/pipeline.toml
name = "thorough"
description = "Full pipeline, reserved as the extension point for future best-of-N plan generation."

[[steps]]
phase = "intake"

[[steps]]
phase = "enrichment"

[[steps]]
phase = "spec"

[[steps]]
phase = "plan"

[[steps]]
phase = "implementation"
```

`PipelineTemplate = { name: string; description?: string; steps: PipelineStep[] }`,
`PipelineStep = { phase: ActivePhase }` — deliberately minimal today (see
Deferred for why `variants` is not part of this schema yet).

### Validation (at load time)

`loadPipelineTemplate(extensionsDir, name)` parses the TOML and validates:

- Every `steps[].phase` is a member of `PHASE_SEQUENCE`.
- `steps` starts with `intake` and ends with `implementation` — intake is
  where the template gets chosen (it can't skip itself), and `implementation`
  is what `advancePhase`'s merge-transition already keys off explicitly
  (`ticket.phase === "implementation"`, `src/phases/advance.ts:590-623`).
  `merge`/`wont-do` are never part of a declared template, same as today —
  they're appended by the state machine, not the template.
- The remaining phases (`enrichment`, `spec`, `plan`) may be omitted but must
  appear in the same relative order as `PHASE_SEQUENCE` — no reordering, no
  duplicates.

Any violation — bad phase name, wrong order, missing anchor, unparseable TOML,
file not found — returns `null`; the caller falls back to the built-in
`default` template and logs it (see Selection below). `PHASE_SEQUENCE` itself
is unchanged and stays the canonical master list of valid phase names in
canonical order, used for `ur status` sorting and for validating template
content — a template's `steps` is a subsequence view of that list, never a
replacement for it.

## Selection, extraction, and pinning

### Resolution order

Same three-layer shape `resolvePhaseModel` already uses for model/thinking:

1. The name intake itself chose (see Extraction below).
2. `config.pipelines?.default` — an operator-wide fallback in `config.toml`.
3. `"default"` — the built-in template.

### Intake records its choice in its own output, not in `meta.md`

`selfReview` (`src/self-review.ts:29-30`) reads only the phase's own output
file — never `meta.md`. A skip-style direct frontmatter edit by the agent
would therefore be invisible to self-review, which defeats the point of
self-review acting as a safety net on this decision (see below). Instead,
intake follows the exact pattern already used for artifact type
(`intake.md:59-90`): a fenced YAML block under a `##` heading, omitted
entirely to mean "use the default," parsed out of the output file *after*
approval rather than written to `meta.md` directly:

```yaml
pipeline: fast
reason: Single-file config change, no interface changes, one acceptance criterion.
```

Included in the output body as `## Pipeline` only when a non-default template
is warranted — same "absence is the default" convention as `## Artifact
type`.

`intake.md` gains a paragraph modeled on its existing artifact-type
instruction, plus a dynamically generated block listing the templates
currently available (name + description) so intake knows what it can choose
from. This block is generated at prompt-build time from
`listAvailablePipelines(extensionsDir)` — unlike the `{{partial-name}}`
markers (`{{principles}}`, `{{notion}}`), which are always static file
content, this is dynamic per-tick content specific to the intake phase. It's
appended the same way the existing supplements are (empty when no templates
are configured, so it costs nothing on an install with no `pipelines/`
directory), but it is *not* a new general-purpose partial type — no other
phase needs it, and the `{{partial-name}}` mechanism's "always static, never
from the state dir" invariant is unchanged.

### Extraction

Mirrors `extractIntakeArtifacts` (`src/extract-artifacts.ts`) exactly, not a
regex/section parse — the existing code already treats structured-looking
agent prose as unreliable for exact-format parsing even when explicitly
instructed, which is why artifact type goes through a small classifier call
rather than string matching:

```ts
// src/extract-pipeline.ts
export async function extractIntakePipeline(
  content: string,
  run: CommandRunner,
  availableNames: string[],
): Promise<string | null>
```

Same `FallbackLanguageModel([ApfelLanguageModel, ClaudeLanguageModel])`
pattern, `claude-haiku-4-5`, a JSON schema constraining the result to one of
`availableNames` or `null` (`null` meaning "use the default"). `availableNames`
comes from `listAvailablePipelines(extensionsDir)` — the same list injected
into the prompt, kept in sync because both come from the same reader.

### Pinning: a new `TickAction`, not inline `advancePhase` logic

Per this project's own dependency-injection rule, "new per-tick behavior that
mutates `TicketState` belongs in a `TickAction`, not inline in `advancePhase`;
keep `advancePhase` to phase/status transitions and their recovery." Pipeline
resolution mutates `TicketState` (writes `pipeline` and `pipelineSteps`), so it
is its own action:

```ts
// src/tick-actions/resolve-pipeline.ts
export interface ResolvePipelineDeps {
  readIntakeOutput: (ticketDir: string) => Promise<string | null>;
  run: CommandRunner;
  extensionsDir: string;
  defaultPipelineName?: string; // from config.pipelines.default
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
}
```

`applies(ticket)`: `ticket.phase === "intake" && ticket.status === "waiting" &&
isApproved(ticket) && ticket.pipelineSteps === undefined` — the same
fires-exactly-once, never-overwrites-populated-data discipline
`reconcilePRsAction` already follows for `ticket.prs`. Deliberately **not**
gated on `ticket.artifacts.includes("code")` the way `createWorktreeAction`
is — sequencing applies to every ticket regardless of artifact type, including
`document`/`work` tickets with no code changes at all.

`run()`: reads intake's output, calls `listAvailablePipelines` +
`extractIntakePipeline` to get the requested name (or `null`), resolves via
the three-layer order above, calls `loadPipelineTemplate` to validate it, and
writes the result. Three outcomes, three log events (mirroring
`artifact-corrected`/`artifact-defaulted`):

| Event                | When                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| `pipeline-corrected` | A non-default name was requested, resolved, and validated. Carries `pipeline`. |
| `pipeline-defaulted` | No name requested (intake omitted the section, or extraction returned `null`) — used the resolved default silently. Carries `pipeline`. |
| `pipeline-invalid`   | A name was requested but failed to load or validate — fell back to default anyway. Carries `requestedName` and `reason` (`template-not-found` / `template-parse-failed` / `template-invalid-shape` / `template-invalid-order`). |

Registered in `composeTickDeps` alongside `createWorktreeAction`; the two have
no ordering dependency (disjoint fields), so registration order between them
doesn't matter.

### `TicketState` additions

```ts
pipeline?: string;                                  // resolved template name, for display/audit
pipelineSteps?: { phase: ActivePhase }[];            // pinned resolved steps, authoritative for sequencing
```

Both fields must be added to the explicit allowlists in **both**
`writeTicket` and `readTicket` (`src/state/store.ts`) — this is the exact
failure mode already documented in this project for `providerDone`: adding a
field to the `TicketState` type alone compiles fine and then silently drops on
every write.

Tickets with no `pipelineSteps` (everything captured before this ships, and
any tick between intake completing and `resolvePipelineAction` firing) are
treated as using `DEFAULT_PIPELINE_STEPS` — a constant derived once from
`PHASE_SEQUENCE`, byte-for-byte equivalent to today's fixed sequence. No
migration needed.

## Self-review update

`intake-self-review.md` gains a criterion in the same style as
`spec-self-review.md`'s triviality check — an independent re-derivation, not a
cross-check of a value it can't see:

> 7. If a `## Pipeline` section is present naming a template other than the
>    default, independently verify it is justified: the ticket must describe a
>    single, self-contained change with no interface or API changes implied
>    and no more than one distinct acceptance criterion. If not justified,
>    respond: `REJECT Pipeline choice "<name>" is not justified — <reason>.`

This is only possible because the choice lives in intake's own output text,
which self-review already reads in full — a direct `meta.md` edit (the
skip-style pattern) would have been invisible to it entirely.

## Sequencing engine

`nextPhase(current: ActivePhase): ActivePhase | "done"` (`src/phases/runners.ts:125`)
is a pure function over the global `PHASE_SEQUENCE`. It's replaced (for
sequencing purposes) by:

```ts
// src/phases/pipeline.ts
export function nextPipelinePhase(
  steps: PipelineStep[],
  current: ActivePhase,
): ActivePhase | "done"
```

`advance.ts` call sites pass `ticket.pipelineSteps ?? DEFAULT_PIPELINE_STEPS`.
The other hardcoded read of `PHASE_SEQUENCE` at `advance.ts:625`
(`activePhases = PHASE_SEQUENCE.filter(p => p !== "implementation")`, gating
which waiting phases are eligible to advance) gets the same treatment, derived
from the ticket's own steps instead of the constant.

The existing `phases.plan.skip` special case (`advance.ts:634-638`) is
**unchanged** — kept as-is alongside the new mechanism, not folded into
templates, per explicit decision. A ticket can therefore have both a pinned
template *and* a spec-level plan skip on top of it.

## Config

```toml
[pipelines]
default = "thorough"   # optional; falls back to "default" (today's fixed sequence) if absent
```

Not validated at `loadConfig` startup time against the extensions directory —
extensions-dir content is filesystem-pluggable and can legitimately differ
across machines/deployments, so validation stays lazy, at resolution time,
with the existing fallback-and-log discipline.

## Deferred / future extensions

Explicitly not designed here, by project decision:

- **Best-of-N generation** (multiple candidate outputs at a phase, judged down
  to one). `PipelineStep` is deliberately a small, additive TOML table
  (`{ phase }`) specifically so a future `variants?: number` is a
  backward-compatible schema addition, not a breaking change — no dead field
  is being shipped now. The sequencing engine walks steps by phase name and
  doesn't assume one-agent-per-step, so special-casing `variants > 1` later
  (a coordinator subprocess running N agents + a judge call, writing to the
  same canonical output filename so nothing downstream needs to change) is
  additive to this design, not a rework of it. Applying it to a
  worktree-mutating phase (e.g. `implementation`) would additionally need
  per-variant worktree isolation — out of scope for whichever follow-up
  ticket takes this on.
- **Reordering and new phase names.** Today's validation requires templates to
  select an in-order subsequence of the existing five phase names, anchored at
  `intake`/`implementation`. This is a deliberate v1 simplification, not a
  ceiling — the longer-term direction is for a pipeline plugin to define
  entirely new phase names (new prompts, new self-review criteria, arbitrary
  ordering), which would require `ActivePhase` to stop being a closed enum.
  That's a much bigger change (self-review dispatch, per-phase model config,
  context-file building, and `ur status` sorting all currently assume a closed,
  known phase set) and is intentionally not part of this design.

## Testing

`src/phases/pipeline_test.ts`:

- `nextPipelinePhase` walks a short step list correctly, including a
  two-step (`intake`, `implementation`) template.
- `loadPipelineTemplate` rejects: unknown phase name, out-of-order phases,
  missing `intake`/`implementation` anchor, duplicate phase, unparseable TOML,
  missing file — each returns `null`.
- `listAvailablePipelines` returns an empty list when no `pipelines/`
  directory exists.

`src/tick-actions/resolve-pipeline_test.ts` (pattern: `check-merged-pr.ts`'s
test file):

- Fires exactly once: does not apply when `pipelineSteps` is already set.
- Does not apply before `isApproved(ticket)`.
- Fires regardless of `ticket.artifacts` (a `document`-only ticket still
  resolves a pipeline).
- A valid non-default name logs `pipeline-corrected` and pins the resolved
  steps.
- No `## Pipeline` section (or extraction returns `null`) logs
  `pipeline-defaulted` with the resolved fallback name.
- A named-but-invalid template logs `pipeline-invalid` with the specific
  `reason` and still pins the default steps.

`src/extract-pipeline_test.ts`: stubs `CommandRunner`, mirrors
`extract-artifacts_test.ts`'s shape — valid name in `availableNames` returned
verbatim, name not in `availableNames` rejected, absent section returns
`null`.

Regression coverage for the historical `TicketState` field-drop bug: a
round-trip test (`writeTicket` then `readTicket`) asserting `pipeline` and
`pipelineSteps` survive, same shape as any other frontmatter-persistence test
in `src/state/store_test.ts`.

## Documentation

- `AGENTS.md`: new "Pipeline templates" section (artifact format, resolution
  order, validation rules, the `pipeline-corrected`/`pipeline-defaulted`/
  `pipeline-invalid` log events, the deferred-extensions notes above).
- Update the "Phase state machine" section to note that `PHASE_SEQUENCE` is
  now the canonical master list a template's `steps` subsequences, not
  necessarily a given ticket's actual path.
- Update the "Phase prompts" section to document the new intake-only dynamic
  supplement (available-pipelines listing) as a deliberate, singular exception
  to "partials are always static file content."
- Add the three new events to the per-ticket `log.ndjson` event table and the
  four new `template-*` reason labels to the reason-label list.
