# Agent Instructions

This file provides guidance to coding agents (Claude Code, Pi, etc.) working in
this repository.

## Non-Deno dependencies

These must be present on the host; they are not managed by Deno.

| Dependency                    | Purpose                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git`                         | Worktree management, rebase/push, state repo commits                                                                                                             |
| `pi`                          | Runs phase prompts; checks/installs agent packages                                                                                                               |
| `launchctl`                   | Loads and unloads the tick LaunchAgent (`com.jackjennings.urras`)                                                                                                |
| GitHub API (`api.github.com`) | Fetches assigned issues; checks PR merge status                                                                                                                  |
| `apfel`                       | Runs local LLM server for approval classification in review mode; also generates short titles at ticket ingestion (optional; skipped when absent or unavailable) |
| `git-worktreeinclude`         | Copies declared files from main checkout into new worktrees                                                                                                      |

Runtime env vars (tick only): `ANTHROPIC_API_KEY`, plus either
`GITHUB_TOKEN`/`GITHUB_LOGIN` (single-account) or the `token_env` vars named in
`[github.accounts.*]` (multi-account — see `resolveGitHubAccount` in
`src/compose.ts`). `JIRA_EMAIL`/`JIRA_API_TOKEN` are read directly from the env.
Config is read from `~/.config/urras/config.toml`.

## Commands

```bash
deno task test                          # run all tests
deno task test:file src/foo_test.ts     # run a single test file
deno task start tick                    # run the tick loop once
deno run --allow-all src/index.ts status

notion page <url>           # fetch a Notion page as Markdown (requires NOTION_TOKEN)
notion database <url>       # fetch a Notion database as a Markdown table
notion search <query>       # search the Notion workspace
notion create <parent-url> <title>  # create a child Notion page (prints new URL)
notion append <page-url>            # append Markdown from stdin to a Notion page
```

Every new subcommand must have a 3-character zsh alias (`u` + first two unique
letters of the subcommand name) in `plugin/urras.plugin.zsh` and a matching row
in the `README.md` alias table. Add a `compdef <alias>=ur` line only if the
subcommand takes a ticket ID argument.

## Architecture

urras is a LaunchAgent-driven pipeline. `TickService` (`src/tick.ts`) owns the
tick workflow: acquire lock → install packages → fetch work → migrate → action
pass → advance pass → commit.

- `composeTickDeps` (`src/compose.ts`) is the single site where concrete
  adapters are constructed. No adapter construction happens inside
  `TickService`, and no other module reads adapter credentials from `Deno.env`.
- `advancePhase` is pure except for its injected `TickDeps` — keep it that way
  for testability.
- `spawnPhase` (`src/executor.ts`) runs each phase as a detached subprocess; the
  next tick detects completion via `isPhaseAlive(ticketDir)`. `run.pid` is
  gitignored at the state-repo root and never committed.
- The state dir is a separate git repo (`~/code/jackjennings/projects` by
  default). Each ticket is a directory in it; `meta.md` holds YAML frontmatter
  (via `gray-matter`) and phase output files (`intake.md`, …) live alongside.
  `commitState` runs `git add -A && git commit` there after each tick.
- `writeTicket` (`src/state/store.ts`) serializes an explicit allowlist of
  frontmatter keys, and `readTicket` parses one. A new `TicketState` field that
  must survive across ticks has to be added to **both** — adding it to the type
  alone compiles fine and then silently drops on every write. This produced a
  live bug: `providerDone` was never persisted, so `jiraDoneAction` re-fired
  every tick and transitioned already-Done Jira issues to Done again.

## Phase state machine

Tickets carry `phase: TicketPhase` and `status: TicketStatus`.

- `PHASE_SEQUENCE` covers only the five runner phases (`intake` →
  `implementation`), cycling `new → running → waiting → (approved) → running`;
  `merge` is handled explicitly in `advancePhase`.
- Implementation agents leave the ticket in `implementation/waiting` for review;
  once approved it moves to `merge/waiting`.
- Any phase can transition to `needs-attention` on subprocess failure.
- `{ phase: "merge", status: "done" }` is the terminal state.

When a phase agent exits without creating its output file
(`phase-output-invalid: missing`), `advancePhase` attempts one recovery before
transitioning to `needs-attention`: it resumes the phase's recorded session
(`ticket.phaseSessionIds[phase]`, populated from the sidecar by
`TickDeps.readPhaseSessionId`) with a corrective prompt, and writes
`outputRetries: 1` on `TicketState`. On the next tick, if the file is now
present, `outputRetries` is cleared to `undefined` when the ticket is written to
`waiting`. If the file is still absent, the ticket transitions to
`needs-attention` as normal. Recovery is skipped when no session ID was recorded
for the phase.

## Approval log

`TicketState.approvals` is an `ApprovalEntry[]` (`src/state/types.ts`); each
entry records `timestamp`, `actor` (`"human"`/`"agent"`/`"unknown"`), and
`phase`. `isApproved` gates advancement: `true` iff the last entry's `phase`
matches `ticket.phase`. Human approvals come from `performApprove`
(`src/commands/approve.ts`); agent approvals are appended by `advancePhase`
after a successful self-review. There is no single boolean `approved` field — do
not add one.

## Usage sidecar files

Each phase run writes `<timestampedPhase>.usage.json` alongside the phase output
`.md`, holding the fields of the `PhaseUsage` type (`src/state/types.ts`).
Non-obvious rules:

- Optional fields (`costUsd`, `tools`, …) are omitted when absent — never
  written as `null` or `{}`; `reasoning` tokens are excluded.
- The file is written only when the agent exits with a complete `agent_end`
  event.
- Directory scanners (e.g. `ur status`) identify these by the `.usage.json`
  suffix.

## Phase output extraction

`extractUsageAndText` (`src/run-phase.ts`) builds both the phase output `.md`
and the usage sidecar from the `agent_end` event's assistant messages. Text and
usage are derived differently, and the asymmetry is deliberate:

- **Text is the last assistant turn that produced any text** — earlier turns are
  discarded. Coding agents narrate before each tool call ("Now I have everything
  I need", "Let me check X"); joining every turn's text puts that narration at
  the top of the stored output, above the real answer.
- **Usage aggregates across every assistant turn** (`input`, `output`,
  `cacheRead`, `cacheWrite`, `tools`, `turns`).

Unwanted narration in a phase output is therefore an extraction-layer bug, not a
prompt-engineering problem. Prompt instructions ("No preamble", "Begin directly
with the heading") were added to the intake/enrichment/spec/plan/implementation
prompts in `73e9237` and did not work — per-turn narration is normal agentic
behavior and no wording aimed at the final answer suppresses it. If narration
reappears, look for a new code path that re-joins multi-turn text before
touching any prompt.

## Phase prompts

One template per phase in `src/phases/prompts/*.md`, loaded by
`src/phases/runners.ts`. Prompt filenames must match the `ActivePhase` values in
`src/phases/types.ts` (`intake`, `enrichment`, `spec`, `plan`,
`implementation`). Prompt files may contain `{{partial-name}}` markers (double
curly braces, kebab-case, no spaces); each is replaced with the contents of
`src/phases/prompts/partials/<partial-name>.md` at load time. State-dir prompts
may use the same markers — partials always resolve from the built-in
`src/phases/prompts/partials/` directory, never from the state dir.

Do not write `_test.ts` files for prompt `.md` files. Prompt content is plain
text with no executable logic to test.

`advancePhase` appends up to three optional supplements (in order) when present,
each loader returning `""` when absent so no code change is needed to add one:

- **Provider** (`<provider>-<phase>.md`, via `loadProviderPrompt`). Supplement
  files must not contain `gh pr create` — the implementation-revision path
  reuses the same supplement and handles PR creation differently. Currently only
  `github-implementation.md` exists.
- **Artifact** (`<artifact>-<phase>.md`, via `loadArtifactPrompt`). Loaded after
  the provider supplement. Currently only `notion-{spec,plan,implementation}.md`
  exist.
- **State dir** (`{stateDir}/prompts/{phase}.md`, via `loadStatePrompt`),
  appended last. For `implementation` the same file applies to both the normal
  and revision runs.
- **Self-review** — see below.

The state-dir prompts directory lives at the state-repo root, not inside a
ticket directory:

```
{stateDir}/
  prompts/{intake,enrichment,spec,plan,implementation}.md
  {ticket.id}/…
```

## Self-review

`selfReview` (`src/self-review.ts`) is the only module that reads
`*-self-review.md` prompts and makes automated-approval calls — do not add
automated-approval calls anywhere else. When a prompt is present for a phase, an
`APPROVE` response makes `advancePhase` append an `ApprovalEntry` with
`actor: "agent"`; when absent, the ticket waits for human approval. To add
support for a phase, create `src/phases/prompts/<phase>-self-review.md`
instructing the model to answer exactly `APPROVE` or `REJECT` — no code change.
Prompts currently exist for `intake`, `enrichment`, `spec`.

## Principles file

Opt-out via `[tick] principles` in `config.toml` (default `true`). When `false`,
`composeTickDeps` makes `appendPrinciples` a no-op and passes
`includePrinciples: false` so `buildContextFiles` skips `@principles.md`.

`{stateDir}/principles.md` is a scratchpad accumulated across tickets.
`buildContextFiles` (`src/run-phase.ts`) prepends it to every phase's context
when the file exists. When the global corpus exceeds 20 entries,
`buildContextFiles` makes a single LLM call (same `FallbackLanguageModel`
pattern as `judgePrinciples`) to select the 5 most relevant entries against the
ticket's title and `## Problem` body, writes them to a temp file, and passes
that instead. The full corpus is used as a fallback on any error; both outcomes
are logged (`principles-filtered` / `principles-filter-failed`). The relevance
filter (`filterPrinciples`) lives in `src/judge-principles.ts`. When a phase
output contains a `## Principles` section, `advancePhase` extracts it, dedupes
against the existing file, and — if novel — appends and commits `principles.md`
alone via `commitPrinciples`. The parsing and dedup logic (`extractPrinciples`,
`dedupePrinciples`) lives in `src/run-phase.ts`.

`judgePrinciples` tries `apfel` first and falls back to the `claude` CLI. Both
calls constrain the model to the same `{ "verdict": "KEEP" | "SKIP" }` JSON
schema — `apfel --schema` takes a file path (written to a temp file per call),
`claude --json-schema` takes the schema inline. Non-JSON or unrecognized output
from `apfel` falls through to `claude` rather than being parsed loosely. The
body is passed after a `--` separator in both calls — a principles block starts
with `-`, which either CLI otherwise rejects as an unknown option.

## Ceremonies

Ceremony source lives in `{extensionsDir}/ceremonies/<name>/` (from
`[extensions] dir` in `config.toml`, defaulting to `~/.urras/extensions`).
Ceremony output is written to `{stateDir}/ceremonies/<name>/output/` — always
the state dir, never the extensions dir.

Each ceremony directory may define its behavior as `prompt.md` (existing) or
`index.ts` (`CeremonyModule`, `src/ceremonies/types.ts`) — a default-exported
function receiving a `CeremonyContext`. `index.ts` wins when both are present.

The approval gate (`CeremonyRunner#runCeremony`, `src/ceremonies.ts`) runs after
the schedule check and before `ceremony.run()`. `ModuleCeremony.run()`
(`src/ceremonies/module.ts`) performs its `await import(...)` of `index.ts`
inside `run()` — never in a constructor, a field initializer, or the runner's
resolution path — so an unapproved ceremony's `index.ts` is never imported and
its top-level code never executes. **This ordering is load-bearing: any change
that moves the import earlier executes unapproved, agent-authored code and is a
security regression.** Do not refactor around it.

A ceremony directory is exempt from the gate only when its name matches an entry
in the ceremonies array `composeTickDeps` passes to `CeremonyRunner`'s
constructor (`StandupCeremony`, `DocumentationGapsCeremony` — compiled into the
binary); every other directory that resolves to a `PromptCeremony` or
`ModuleCeremony` is gated. The exemption comes from that code-constructed
registry, not from matching the directory name against a string constant —
`BUILT_IN_CEREMONY_NAMES` (`src/ceremonies/types.ts`) has two consumers:
`performApproveCeremony` (`src/commands/approve.ts`) rejects
`ur approve ceremony/standup`, and `listCeremonyIds` (`src/commands/ids.ts`)
filters built-ins out of `ur _ids` so they never appear in shell completion.
Both call sites depend on the constant staying in sync with the ceremonies array
`composeTickDeps` actually registers.

`readApprovals`/`writeApprovals` (`src/ceremonies/approvals.ts`) resolve
`~/.urras/ceremony-approvals.json` through `urrasDir()`, never
`join(HOME, ".urras", …)` inline — same rule as the runtime dir below.

`ceremony-warning` (an existing `tick.ndjson` event) gains five `reason` values:
`not-approved` (gate rejection), `ceremony-failed` (import failure, a
non-function default export, or a throw from the ceremony function itself),
`invalid-name` (a ceremony directory name outside `[A-Za-z0-9._-]+`),
`approvals-unreadable` (`ceremony-approvals.json` exists but does not parse),
and `timeout` (`ceremony.run()` did not resolve within the timeout window),
joining the event's existing reasons (`prompt.md missing`, `claude-failed`,
`empty-response`, and the `config.toml` parsing/validation messages).

### The hash must never over-report

`ceremonyHash` is a security control, so it must never return "approved" about a
directory it could not fully characterize. Three rules follow, and a change that
breaks any of them is a security regression:

- **Every entry contributes a manifest line.** `collectManifestEntries` emits
  `<unsupported>` for anything that is not a regular file or a directory (FIFO,
  socket, device), and for a symlink whose resolved target is neither. An entry
  that pushed no line would let a file appear inside an approved directory
  without changing the hash.
- **Contents are digested as bytes.** `readFile` plus `crypto.subtle.digest`,
  never `readTextFile` — lossy UTF-8 decoding maps distinct byte sequences to
  the same string, so decoded text would let any non-UTF-8 blob be swapped
  freely.
- **The walk is bounded and fails closed.** `MAX_MANIFEST_FILES` /
  `MAX_MANIFEST_BYTES` raise `CeremonyManifestLimitError`, and a symlink to a
  directory outside the ceremony root is recorded but not descended, so an
  unapproved ceremony cannot make the tick read the operator's whole home
  directory. `isCeremonyApproved` turns any throw into a denial. A ceremony
  containing a directory symlink whose target is outside the ceremony root also
  cannot be approved.

`isValidCeremonyName` (`src/ceremonies/types.ts`) is the single charset check
(`[A-Za-z0-9._-]+`, rejecting `.` and `..`), shared by `CeremonyRunner.run()`
and `performApproveCeremony`. A rejected name must reach neither the notifier
nor a filesystem path builder; only the NDJSON log, which is a safe sink.

Desktop notifications go through `makeDesktopNotifier` (`src/notify.ts`), which
passes the title and message as `osascript` **arguments** after a `--`
separator, read via `on run argv`. Never interpolate a value into AppleScript
source — a ceremony directory name is state-dir-controlled text and macOS
permits `"` and `&` in it, so interpolation is arbitrary command execution from
the warning path. All notification call sites route through this one helper.

`readApprovals` distinguishes a missing file (returns `{}`) from an unparseable
one (throws `CorruptApprovalsError`). The warning path must never write a record
it did not successfully read, or one bad parse would replace every approval with
a single `lastWarnedWindow` entry. `writeApprovals` writes a temp file in the
same directory and `rename`s it, so a partial write cannot corrupt the file.

`CeremonyContext` (`src/ceremonies/types.ts`) is the only surface state-dir code
depends on. Treat widening it as a compatibility commitment: add members
deliberately, and never expose `TickDeps`, `runGit`, or a raw `CommandRunner`
through it — state-dir code is agent-authored and untrusted until approved.

## Runtime dir (`urrasDir`)

Anything that writes under the runtime dir — the combined `log.ndjson`,
`tick.ndjson`, and future logging — must resolve its base path via `urrasDir()`
(`src/paths.ts`), never `join(HOME, ".urras", …)` inline. It returns
`$URRAS_DIR` when set, else `$HOME/.urras` (with filesystem fallback to
`$HOME/.lazyboy`). This is the single seam that keeps tests from writing to the
operator's real `~/.urras`: `deno task
test` sets `URRAS_DIR=$(mktemp -d)`, so
any code routed through `urrasDir()` is isolated automatically with no per-test
setup. Single-file runs go through `deno task test:file <path>`, which sets it
the same way — do not invoke `deno test` directly (see Commands). A test that
inspects the combined/tick log directly uses `withLazyboyDir()`
(`src/test-support.ts`) for its own scratch dir.

Non-log paths (`worktrees/`, `pi/`, `claude-code/`, `anthropic-pricing.json`,
`tick.pid`, `last-worked.json`) still read `HOME`/`opts.homeDir` directly; their
tests isolate via `HOME`. Do not route them through `urrasDir()` — it would
defeat that per-test `HOME` isolation.

## `tick.ndjson` format

`~/.urras/tick.ndjson` is NDJSON — one object per line with `ts` (ISO 8601 UTC)
and `event`. Events: `tick-start`, `tick-end`, `tick-already-running`,
`stale-lock`, `lock-failed`, `tick-failed`, `update-skipped`, `update-failed`,
`repo-renamed`, `repo-identity-collision`, `repo-identity-reconcile-failed`,
`repo-identity-unavailable`, `repo-org-unmapped`, `pricing-fetch-failed`.
`appendTickLog` (`src/tick.ts`) writes it directly; it is not `appendTicketLog`
(`src/state/store.ts`).

| Event                            | Trigger                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo-renamed`                   | `currentSlug` changed for a confirmed repo identity entry                                                                                                      |
| `repo-identity-collision`        | A canonical slug's freed name was re-registered by another repo                                                                                                |
| `repo-identity-reconcile-failed` | Network error, 5xx, or timeout on a reconciler API call                                                                                                        |
| `repo-identity-unavailable`      | `repos.json` could not be parsed; capture skipped for this tick                                                                                                |
| `repo-org-unmapped`              | Org after a transfer is absent from `[github.orgs]`                                                                                                            |
| `pricing-fetch-failed`           | `refreshAnthropicPricingIfStale` failed to refresh the pricing cache; `reason` is `network-error`, `http-error`, `response-read-error`, or `cache-write-error` |

The plist from `plistContent()` must **not** include `StandardOutPath` or
`StandardErrorPath` pointing to `tick.ndjson` — the tick process owns its own
writes.

## Self-update reporting

`runUpdate` (`src/commands/update.ts`) returns a classified `UpdateOutcome`
(`pulled` / `current` / `dirty` / `diverged` / `failed`), not an exit code. The
distinction exists because this repo sets `pull.ff only`: with unpushed local
commits `git pull` exits **128** by design
(`fatal: Not possible to
fast-forward`), which is a refusal to touch the
checkout, not a broken update. Collapsing it into `update-failed` hid the fact
that self-update had silently stopped — and a migration then sat unapplied
across ticks.

- Divergence is measured **after** the failed pull, with
  `git rev-list --left-right --count @{upstream}...HEAD`. `pull.ff only` fetches
  before refusing, so the counts are current. Left is `behind`, right is
  `ahead`; an outcome is `diverged` only when both are non-zero, otherwise it is
  a genuine `failed`.
- `performTickUpdate` (`src/commands/tick.ts`) logs `update-skipped` with
  `reason: "dirty" | "diverged"` (plus `ahead`/`behind`) and reserves
  `update-failed` for real errors. Both let the tick proceed on local code.
- Notification dedup lives in `src/update-divergence.ts`. It fires only when the
  counts change, storing the last notified pair in
  `{urrasDir()}/update-divergence.json`. `current` clears that state so a later
  divergence re-notifies; `dirty` and `failed` deliberately leave it untouched,
  since neither establishes whether the checkout has diverged.
- The notification goes through `makeDesktopNotifier`, like every other one.

## Per-ticket `log.ndjson` format

`<stateDir>/<ticket.id>/log.ndjson` is the per-ticket event log (distinct from
the runtime `tick.ndjson` above). Every entry is written by `appendTicketLog`
(`src/state/store.ts`) — do not append to it inline elsewhere — and carries a
`ts` (ISO 8601 UTC), an `event`, and event-specific fields. Reuse an existing
event rather than coining a synonym:

| `event`                                                                            | Written by / meaning                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ticket-captured`                                                                  | A new ticket was written for the first time; carries `title`.                                              |
| `phase-start` / `phase-end`                                                        | A phase subprocess is spawned / completes.                                                                 |
| `phase-transition`                                                                 | `phase` changes.                                                                                           |
| `status-transition`                                                                | `status` changes.                                                                                          |
| `needs-attention`                                                                  | Ticket parked for a human; carries a `reason`.                                                             |
| `phase-output-invalid`                                                             | Agent produced no/invalid output; carries a `reason`.                                                      |
| `phase-output-retry`                                                               | Recovery resume attempted after invalid output.                                                            |
| `self-approved`                                                                    | Self-review appended an agent `ApprovalEntry`.                                                             |
| `principles-filtered`                                                              | LLM selected a subset of global principles; carries `total` (corpus size) and `included` (selected count). |
| `principles-filter-failed`                                                         | Relevance filter could not run; carries `reason` (`meta-unreadable` or `llm-failed`). Full corpus used.    |
| `conflict-resolution-started` / `conflict-resolution-failed` / `conflict-resolved` | Conflict-resolution lifecycle.                                                                             |
| `branch-pushed`                                                                    | A worktree branch was successfully force-pushed to origin.                                                 |
| `ci-fix-resolved`                                                                  | A CI-fix run's verdict was applied.                                                                        |
| `worktree-include-failed`                                                          | `git-worktreeinclude` copy failed (non-fatal).                                                             |
| `reconciled-prs`                                                                   | `reconcilePRsAction` populated `prs`; carries `count`.                                                     |
| `artifact-corrected`                                                               | Intake artifact parsed; `artifacts` corrected in `meta.md`; carries `artifacts`.                           |
| `artifact-defaulted`                                                               | Artifact type absent in intake output; default `["code"]` applied.                                         |
| `error`                                                                            | An action or phase threw; carries the error message.                                                       |

A `reason` field, where present, is a lowercase kebab-case label naming the
cause (`agent-failed`, `non-zero-exit`, `missing`, `output-file-missing`,
`empty`, `no-prs`, `no-pages`, `no-worktrees`, `no-github-repos`,
`github-slug-extraction-failed`, `clone-failed`, `worktree-creation-failed`,
`push-failed`, `no-verdict-line`, `incomplete`, `pr-fetch-failed`,
`ci-unfixable`, `rerun-failed`, `infra-rerun-exhausted`, `no-commit`,
`context-file-unreadable`, `new-marker-on-local-path`, `local-repo-init-failed`,
`repo-creation-failed`, `meta-unreadable`, `llm-failed`). Reuse an existing
label when it fits; add a new one only for a genuinely new cause, and never put
free prose in `reason` (that belongs in a separate field or the `error`
message). Work-item identity is the ticket directory itself — do not add an `id`
or `ticketId` field to per-ticket entries.

## Failure handling

The default response to a failure is decided by where it happens, not per-caller
— do not re-derive this for each new action:

- **Phase subprocess failure or invalid output** → `needs-attention`, with a
  `reason`. This is the only path that parks a ticket for a human (see the phase
  state machine and the one-shot output recovery above).
- **`TickAction` side-effect failure** (push, rebase, worktree cleanup, closing
  the upstream issue, notification) → log it to `log.ndjson` and continue;
  **never block the state machine or throw out of the action.** An action may
  set `needs-attention` only when the failure means the ticket genuinely cannot
  proceed — and then its `applies` must exclude `status === "needs-attention"`
  to avoid a retry loop (with the documented `resolveCIFixAction` exception —
  see Tick actions and CI fix).
- **Background analysis subprocess** → fire-and-forget; its failure must never
  touch ticket state (see Background analysis subprocesses).

New per-tick behavior that mutates `TicketState` belongs in a `TickAction`, not
inline in `advancePhase`; keep `advancePhase` to phase/status transitions and
their recovery. Inline logic in `advancePhase` is reserved for the state-machine
transitions themselves.

## Dependency injection

Modules expose `*Deps` interfaces for testing (`TickDeps`, `TickServiceDeps`,
`InstallDeps`, `PidFileLockDeps`). Keep the surface minimal — inject only what
tests substitute. `TickServiceDeps` is the full surface of `TickService`.

Members are **required by default**. Mark one optional only when `undefined`
carries meaning of its own — an unset config knob with a documented fallback
(`TickDeps.maxPromptTokens` → `DEFAULT_MAX_PROMPT_TOKENS`,
`TickServiceDeps.agentsMdMaxTokens` → feature off). An optional _function_ means
a `composeTickDeps` omission silently disables a whole behavior with no error
and no log entry, so a new injected function is required, called
unconditionally, and wired in `composeTickDeps` — do not reintroduce
`deps.thing?.()` as a "test degradation path".

Tests build both interfaces with `makeTickDeps` / `makeTickServiceDeps`
(`src/test-support.ts`), passing only the members under test as overrides; the
factories supply inert defaults and touch no filesystem, git, or network. Adding
a required member means adding one default there, not editing call sites. Do not
hand-roll a deps literal in a test.

Production helpers that satisfy a `*Deps` interface live in the same module as
the interface and are named tool-agnostically (e.g. `isPackageInstalled` in
`src/packages.ts` — that it shells to `pi` is not part of the name).

`PidFileLockDeps` (`{ log, isPidAlive? }`, `src/lock.ts`) is the deliberate
exception: `PidFileLock` must have zero knowledge of `tick.ndjson` or any
tick-specific concept, so its `log` implementation (`appendTickLog`) lives in
`src/tick.ts` and `composeTickDeps` wires the two together.

Command functions that internally call `commitTicket` take a deps object
`{ commitFn?, readTicketFn?, writeTicketFn?, ... }` with additional fields as
needed. `performDecline` and `performRewind` also accept `killFn?`. Tests pass
spy implementations to avoid a real git repo.

## CodeAgent adapters

Phase runtimes implement `CodeAgent` (`src/agents/types.ts`). Two adapters
exist: `PiCodeAgent` (`src/agents/pi.ts`, shells to `pi`) and `ClaudeCodeAgent`
(`src/agents/claude-code.ts`, shells to `claude`). The `pi` CLI must not be
referenced by name outside `pi.ts`; the `claude` CLI must not be invoked via
`Deno.Command` outside `claude-code.ts`. Ancillary functions that shell to CLIs
via an injected `CommandRunner` are exempt from this restriction — they go
through `src/models/` adapters (see below). New CodeAgent adapters go in
`src/agents/<name>.ts` and implement `CodeAgent`.

### Ancillary LLM calls

Non-phase LLM calls use the `LanguageModel` interface (`src/models/types.ts`).
`ApfelLanguageModel` and `ClaudeLanguageModel` implement it via `CommandRunner`;
`FallbackLanguageModel` composes them. Callers: `judgePrinciples`,
`judgeComment`, `selfReview`, `applyLearning`, `callLlm`, `generateShortTitle`.
`checkApfelAvailable` (`src/apfel.ts`) is not a `LanguageModel` — it remains for
non-LLM availability checks used by `src/compose.ts` and `src/review.ts`.

- `[agent].type` (default `"pi"`) selects the adapter, orthogonal to
  `[pi].provider` (which applies only when `agent.type === "pi"`). Resolved once
  in `composeTickDeps` and threaded through `ExecutorOptions.agent`.
- Arg-builders (`buildPiArgs`, `buildClaudeCodeArgs`) take a single named-key
  options object, not positional params. New adapters follow the same style.
- `ClaudeCodeAgent` is Anthropic-direct only (ignores `provider`) and maps
  `thinking` to `--effort` (`off`/`minimal` omit the flag). It has no `@file`
  mechanism — `contextFiles` are listed in the prompt text and their parent dirs
  passed via `--add-dir`. It always passes `--setting-sources project,local`
  (otherwise a nested `claude` loads the operator's personal
  hooks/skills/plugins/MCP into the phase) and `--verbose` (required with
  `--print` + `--output-format stream-json`).

### Bedrock support

`[pi] provider = "bedrock"` runs every phase through `pi --provider bedrock`.
Two things are the user's responsibility, not urras's: model IDs in
`config.toml` must already carry the Bedrock `anthropic.` prefix (urras does not
rewrite model strings), and `AWS_REGION` plus AWS credentials must be present in
the environment (`executePhase` spreads `Deno.env.toObject()` into the
subprocess). `PHASE_MODEL_DEFAULTS` is unprefixed, so Bedrock users must
override every phase in `[phases.defaults]`, including `"conflict-resolution"`.

## Per-phase model configuration

Model and thinking are resolved independently, in order, by
`resolvePhaseModel(config, phase, ticket)` (`src/phases/model.ts`; wrapped by
`TickDeps.resolveModelConfig`):

1. `ticket.phases?.[phase]?.{model,thinking}` frontmatter (set by the plan agent
   for `implementation`; available for any phase).
2. `config.phases?.defaults?.[phase]?.{model,thinking}`.
3. `PHASE_MODEL_DEFAULTS` (exported from `src/phases/model.ts`).

```toml
[phases.defaults.intake]
model = "claude-haiku-4-5"
thinking = "off"
```

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

Ancillary (non-phase) LLM calls — approval classification (`src/review.ts`),
self-review (`src/self-review.ts`), the review Q&A overlay, short-title
generation — are **not** routed through `resolvePhaseModel` and are not
per-phase configurable. They pin their model at the call site: cheap
classification and validation use `claude-haiku-4-5`; a call that must reason
over a diff (e.g. `apply-learning.ts`) uses `claude-sonnet-4-6`. A new ancillary
call follows this split rather than adding a config knob.

## Tick actions

Per-tick behaviors are `TickAction` implementations in `src/tick-actions/`. Each
exports a `*Deps` interface, a factory, and a `*_test.ts` (pattern:
`check-merged-pr.ts`). Register them in `src/compose.ts` (not `src/tick.ts` —
`TickService` receives them via `TickServiceDeps`).

- An action's `applies` predicate must exclude tickets where a phase agent is
  live (`isPhaseAlive(ticketDir)` true) — rebasing or pushing under a live agent
  corrupts its git state. Actions that can set `needs-attention` must also
  exclude `status === "needs-attention"` to avoid a retry loop. The one
  exception is `resolveCIFixAction`, which is gated on the presence of a context
  file it consumes — see the CI fix section for why the guard is deliberately
  omitted there. Do not add it.
- An action that touches a worktree or spawns an agent must also exclude
  `status === "running"`. `isPhaseAlive` alone is not enough: a `running` ticket
  whose process is dead is a crashed phase awaiting recovery, and the action
  pass runs **before** the advance pass, so acting on it pre-empts
  `advancePhase`'s boot-restart resume and missing-output retry. Parking the
  ticket there is worse than doing nothing — `needs-attention` drops it out of
  the advance pass entirely, so the recovery never runs on any later tick
  either. This guard cannot strand a ticket, because `advancePhase` always
  transitions a `running` ticket out. `checkConflictsAction` and
  `spawnCIFixAction` carry it; `checkNewCommentsAction` gets it for free from
  its `status === "waiting"` requirement. `resolveConflictsAction` must **not**
  have it — `checkConflictsAction` sets `running` when it spawns the resolution
  agent, so the guard would make the completed run unresolvable.
- `TicketState.ciHandledRunIds?: string[]` records `${runId}-${attempt}` keys
  `spawnCIFixAction` has already handled (append-only; never removed). Use it
  only for CI-failure dedup.
- `spawnCIFixAction` is opt-out via `[tick] resolve_ci_failures` (default
  `true`); when `false`, `composeTickDeps` omits it.

## Background analysis subprocesses

Non-phase background agents run alongside a ticket's phase agent without
participating in the state machine. The tick loop tracks liveness only via
`run.pid`, so a subprocess must write a **distinct** PID file to stay invisible
to ticket state (see `spawnOutlierAnalysis` in `TickDeps` for the existing
example).

To add one:

- Give it a distinct `pidFile` name (not `run.pid`).
- Add a required method to `TickDeps` and a default to `makeTickDeps`.
- Wire it in `composeTickDeps`.
- Never write `ticket.status` or `ticket.phase` from the subprocess.

## PR tracking

`TicketState.prs?: PrEntry[]` (`src/state/types.ts`) tracks pull requests. Each
`PrEntry` carries `url`, `title`, `dependsOn` (PR URLs that must merge first),
`merged`, and `worktreeKey`. When the implementation agent creates a PR, it
appends a `PrEntry` to `prs` in `meta.md`.

If the agent does not write `prs`, `reconcilePRsAction` fires on the next tick
for any `implementation/waiting` ticket with an empty or absent `prs` array. It
scans the latest `*-implementation.md` output file for GitHub PR URLs, calls
`GitHubProvider.prMetadata` (which resolves the per-org token) for each, derives
`dependsOn` from `baseRefName`/`headRefName` chaining, and writes the populated
`prs` array. If no PR URLs are found in the output file, the ticket transitions
to `needs-attention` with reason `no-prs`; if a PR metadata fetch fails, it
parks with reason `pr-fetch-failed` rather than retrying indefinitely. The
action is idempotent: once `prs` is non-empty it never fires again.

`checkMergedPRAction` checks each PR only once all its `dependsOn` are
`merged: true`, cleans up the worktree on merge, and reaches `done` only when
every entry is merged. Do not introduce a `prUrl` field or any other single-PR
field.

## `runGit` in `src/worktree.ts`

`runGit` is the shared git-shelling helper (returns `{ code, stdout, stderr }`),
exported so `TickAction`s can inject it and test against a stub. Do not
introduce a second git-shelling helper — use or inject `runGit`.

## Conflict resolution

On a rebase conflict, `checkConflictsAction` writes a
`${timestamp}-conflict-context-<branch>.md` sentinel and spawns a
conflict-resolution agent (phase name `"conflict-resolution"`, same per-phase
model resolution as runner phases, defaulting to `claude-opus-4-7`/`high`). The
context and output (`${timestamp}-conflict-resolution.md`) files share the
timestamp. The agent receives only `@meta.md` and the context file; the worktree
is left mid-rebase.

`resolveConflictsAction` detects finished runs by a `*-conflict-context-*.md`
suffix match when the PID dies, and must be registered **before**
`checkConflictsAction` so a just-finished resolution is handled before the
conflict check can re-fire.

To spawn with a non-default model or explicit context files, set `model` /
`contextFiles` on `ExecutorOptions`; `run-phase.ts` reads `--model` (default
`claude-sonnet-4-6`) and `--context-files` (comma-separated `@file`; omit to use
`buildContextFiles`). Do not hardcode the model elsewhere.

## Migrations

Migration data files live at
`migrations/<UNIX_TIMESTAMP_SECONDS>-<kebab-slug>.ts` (root-level, sibling to
`src/`), each with a companion `<timestamp>-<slug>_test.ts` that tests
`migration.run()` against a real temp directory. The runner (`src/migrations/`)
filters `/^\d+-[a-z0-9-]+\.ts$/` and sorts lexicographically; the numeric prefix
is the ordering and identity key. Applied IDs are recorded globally in
`<stateDir>/.migrations` (one per line); there is no per-ticket log and no
rollback.

Two migration interfaces exist in `src/migrations/types.ts`:

- **`Migration`** — `run(ticket, stateDir)`: per-ticket; receives one
  `TicketState` and returns an updated one. No `type` field required.
- **`StoreMigration`** — `type: "store"; run(stateDir)`: whole-store; receives
  only the stateDir path and returns `void`. Use when the change cannot be
  scoped to a single ticket directory.

The runner dispatches on `migration.type === "store"` after loading each file. A
per-ticket migration that changes `ticket.id` must **move** the on-disk
directory with `Deno.rename` (creating the parent via
`Deno.mkdir(..., { recursive: true })` first), never `Deno.remove` — the runner
only writes `meta.md` back, so every other file (`log.ndjson`, phase outputs,
`.usage.json`) survives only because the migration moved it. Its test must
assert file contents exist at the new path, not merely that the old directory is
gone (a prior migration destroyed history because its test only checked the
latter).

## GitHub identity module

`src/providers/github/identity.ts` is the single seam for all GitHub identity
string parsing and formatting. Use its exports (`parsePrUrl`, `parseIssueUrl`,
`parseTicketId`, `ticketIdFor`, `slugOf`, `extractGitHubSlug`,
`parseRemoteSlug`, `resolveGitHubSlug`) rather than inline regex patterns. Do
not add new GitHub identity regexes at call sites.

## Per-org GitHub credentials

`resolveGitHubAccount(slug, config, currentSlug?)` (`src/compose.ts`) is the
single mapping from org slug to `{ token, login }`. The first parameter is a
full `org/repo` slug (bare org strings also work); `currentSlug` is the
reconciler-confirmed current slug used to resolve the org after a transfer.
`composeTickDeps` wraps it as `resolveAccount(slug)` which passes the confirmed
current slug automatically.

- `config.github.accounts` absent → `GITHUB_TOKEN`/`GITHUB_LOGIN` from the env.
- present and org in `config.github.orgs` → token from `account.tokenEnv` plus
  the configured `login`.
- present but org unmapped → falls back to `GITHUB_TOKEN`/`GITHUB_LOGIN`.

`GitHubProvider` takes `accountResolver: (slug) => { token, login }`, not a
single token/login. `spawnPhase` sets both `GITHUB_TOKEN` and `GH_TOKEN` so the
`gh` CLI (which prefers `GH_TOKEN`) uses the right account. `loadConfig`
validates at startup that every `token_env` is set and every `[github.orgs]`
entry names a known account.

```toml
[github.accounts.personal]
token_env = "GITHUB_TOKEN_PERSONAL"
login     = "jackjennings"

[github.accounts.work]
token_env = "GITHUB_TOKEN_WORK"
login     = "jack-jennings-sdx"

[github.orgs]
jackjennings = "personal"
smarterdx    = "work"
```

## Ticket ID format

IDs are POSIX relative paths (`join(stateDir, id, …)` resolves them); the
slashes create the namespaced directory structure under `stateDir`.

- **GitHub**: `github/<org>/<repo>/<issue-number>` (e.g.
  `github/jackjennings/lazyboy/23`).
- **Jira**: `jira/<issue-key>` (e.g. `jira/PROJ-123`; keys are globally unique
  per instance).

Do not introduce ID formats that omit the provider prefix or use a flat
single-segment string.

Ticket ids are pinned to the **canonical slug** — the name in use at first
capture — and never rewritten on rename. `{stateDir}/repos.json` maps canonical
slugs to current names; `fetchNew` uses the canonical slug for the id and the
current slug for API requests. `src/providers/github/repo-identity.ts` owns the
table I/O and the `canonicalSlugFor`/`currentSlugFor`/`aliasesFor` lookups.

## Shell completion

`src/completion.zsh` is a static, generic dispatcher — it does **not** hardcode
command names, flags, or IDs. It reads `ur _completions` (name, description, and
`completesWith` per command) and `ur _ids` at runtime. So a new command or flag
becomes completable by declaring its metadata on the `Command` (set
`completesWith: "_ids"` for a command that takes a ticket ID, or a
comma-separated literal list for fixed choices) — **do not edit
`completion.zsh`** for a new command, flag, status value, or phase.

## `codebase.roots` semantics

Entries must be base code directories (e.g. `~/code`), not org-scoped
(`~/code/myorg`). `findLocalRepo` searches exactly two levels deep:
`root/<org>/<repo>`. Config examples and fixtures must use org-less paths.

## Remote repository cache

When a scope entry is a GitHub slug/URL with no local checkout,
`cloneRemoteRepo` (`src/worktree.ts`) clones to
`~/.urras/repositories/<org>/<repo>`, delegating the `gh repo clone` subprocess
to `GitHubProvider.clone`, which forwards only `PATH`, `HOME`, and `GH_TOKEN`.
Existing clones are reused — no `git fetch` or `git pull` is ever run on them
(they are persistent snapshots). `createWorktreeAction` fires at
`phase === "intake" && status === "waiting" && isApproved(ticket)`.

## Imports

Use the project's import conventions from `deno.json`. For test assertions, use
`@std/assert` (bare specifier) — not `jsr:@std/assert` or
`https://deno.land/std@...` URLs.

Reach for the most specific `@std/assert` assertion the check allows; a bare
`assertEquals` against a boolean, comparison, or containment hides intent and
produces a worse diff on failure. Match the assertion to the check — booleans
(`assert`/`assertFalse`), presence (`assertExists`), substring/element
membership (`assertStringIncludes`/`assertArrayIncludes`), ordering
(`assertGreater`/`assertLess`), errors (`assertRejects`/`assertThrows`), etc.
Reserve `assertEquals` for genuine value equality. Do not fold a comparison or
containment into a boolean just to `assertEquals(..., true)`.

For test doubles (spies, stubs), use `spy` and `stub` from `@std/testing/mock`
(bare specifier). Do not write hand-rolled stub functions for the same purpose.
Access recorded calls via `spy.calls` and assert call counts with
`assertSpyCalls`.

CLI format functions (`formatGlobalHelp`, `formatCommandHelp`) live in
`src/commands/help.ts` and are pure — no `Deno.args`, no `console.log`, no
`Deno.exit`. Tests that assert on `--help` output import these functions
directly. Tests that assert on `Deno.exit` behavior use subprocess via
`runIndex`. Do not add `Deno.args`, `console.log`, or `Deno.exit` to `help.ts`.

## Filesystem

All filesystem operations go through `src/filesystem.ts` — call `stat`,
`readFile`, `readDir`, etc. from there, never `Deno.*` directly.

## Date and time

Use the Temporal API (`Temporal.Now`, `Temporal.PlainDate`, `Temporal.Instant`,
etc.) in preference to `Date`. Avoid `new Date()` or `Date.now()` unless
interfacing with an API that requires a legacy `Date` object.

For generating compact filename timestamps (`YYYYMMDDTHHMMSS`), use
`compactTimestamp` from `src/timestamp.ts`. Do not inline the year/month/day
padding logic at call sites.

## Code style

Do not add comments or docblocks. The code should be self-explanatory through
naming. Only add a comment when explaining a non-obvious constraint or
workaround.

Do not abbreviate words in identifiers, names, or user-visible strings. Write
`DocumentationGapsCeremony`, not `DocGapsCeremony`;
`"Documentation gaps ready"`, not `"Doc gaps ready"`.

Functions with more than three parameters, or parameters whose positional
ordering is non-obvious, take a single named-key options object rather than
positional params.

## Formatting

Run `deno fmt` and `deno lint` after writing all files and before committing,
including when the only files changed are Markdown (`.md`). `deno fmt` formats
Markdown as well as source — do not skip it just because no `.ts` files changed.
Do not manually adjust indentation or spacing — let the formatter handle it.

## Commits

All commits to the urras source repo must use
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) format:
`<type>[(<scope>)][!]: <description>`

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`

`chore` is for changes that produce no functional change to the urras executable
(e.g. updating `.gitignore`); when any more specific type applies, use it
instead.

Description rules: imperative mood, lowercase after the colon, no trailing
period, ≤72 characters on the subject line.

Scope is optional; use it when it meaningfully narrows the context (e.g.
`fix(tick): …`).

`git revert`-generated subjects (`Revert "…"`) are exempt from the format. When
manually authoring a revert commit, use `revert: …`.

`scripts/commit-lint.sh` enforces this format and can be symlinked as
`.git/hooks/commit-msg` for local enforcement. CI validates all commits on pull
requests and direct pushes to main.

## Planning

Every task in a plan must produce a code change and a commit. Do not create
tasks that only run verification commands without making changes.

## CI fix

When `spawnCIFixAction` encounters a failing GitHub Actions run (`failure` or
`action_required` conclusion) on an unmerged PR, it writes a context file and
spawns an agent that fixes the branch. The agent commits; the tick loop pushes.
There is no deterministic pattern matching on the failing job and no direct
fmt/lint auto-fixing — every failure goes through the agent. This is an async
two-tick pattern identical in structure to conflict resolution.

**Tick 1 (spawn):** `spawnCIFixAction` queries
`/repos/{repo}/actions/runs?head_sha=<pr head sha>` and writes
`${timestamp}-ci-fix-context-${runId}-${attempt}.md` to the ticket directory,
holding the PR URL, repo, run ID, attempt, branch, head SHA, worktree path, and
the names of the failing jobs. It does not include the PR diff — the agent has
the worktree. It calls `spawnPhase` with the context file, records
`${runId}-${attempt}` in `ciHandledRunIds`, writes the ticket, and returns.

The `Head-SHA` header is the PR head SHA the failing run was queued against. It
is what the resolve action pins its `--force-with-lease` to and what it compares
the worktree HEAD against, so it must keep being written.

The dedup key is `${runId}-${attempt}`, not the run ID alone: re-running the
failed jobs keeps the same run ID and only increments the attempt, so a
run-ID-only key would silently swallow every re-run failure.

If the PR's `worktreeKey` resolves to nothing in `ticket.worktrees`, the ticket
transitions to `needs-attention` with reason `no-worktrees` and nothing is
spawned — the agent cannot commit or push without a worktree, and worktree
creation is `createWorktreeAction`'s job. If `writeContextFile` or `spawn`
throws, the key is removed from `ciHandledRunIds` and processing continues to
the next PR.

**Tick 2 (resolve):** `resolveCIFixAction` detects completed runs by checking
for `*-ci-fix-context-*.md` files when no live process is present. For each
context file it derives the output filename by replacing `-ci-fix-context-` with
`-ci-fix-` (the same timestamp prefix is shared) and parses the verdict from the
first line matching `/^VERDICT:\s*(FIXED|INFRA|UNFIXABLE)/im`.

| Verdict     | Effect                                                                                                                                                                                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIXED`     | `git push --force-with-lease=refs/heads/<branch>:<Head-SHA> origin <branch>` from the worktree, logging `branch-pushed`. A push failure parks the ticket (`push-failed`).                                                                                                                                                                          |
| `INFRA`     | On attempt 1, `POST /actions/runs/{runId}/rerun-failed-jobs`; no push, no code change. A failed re-run is logged (`rerun-failed`) and never parks. On attempt 2 or higher, no re-run is attempted — the ticket parks with `needs-attention` and reason `infra-rerun-exhausted`. A missing or non-numeric `Attempt` header is treated as attempt 1. |
| `UNFIXABLE` | `needs-attention`, reason `ci-unfixable`.                                                                                                                                                                                                                                                                                                          |

The lease is pinned to the head SHA rather than left bare because the agent is
told to rewrite history and may run `git fetch`, which advances the worktree's
`origin/<branch>` and makes a bare lease compare against a ref that already
contains someone else's commits. Before pushing, the action also compares the
worktree HEAD (`git rev-parse HEAD` through the injected `runGit`) against the
head SHA: equal means the agent claimed `FIXED` without committing, which would
push nothing and leave the PR red forever with no new run to trigger another
attempt, so the ticket parks with reason `no-commit`. A context file written
before the `Head-SHA` header existed has neither behavior — the push falls back
to a bare `--force-with-lease` and the did-it-move check is skipped, so
in-flight tickets are not stranded across a deploy.

A missing output file parks with `output-file-missing`; a missing verdict line
parks with `no-verdict-line`; a context file that cannot be read is logged
(`context-file-unreadable`) and deleted without parking, since leaving it in
place would re-fire the action and rewrite the ticket on every subsequent tick.
Both the context and output files are deleted after resolution in every path,
and a `ci-fix-resolved` entry records `prUrl`, `runId`, `attempt`, and
`verdict`.

The action does not otherwise touch `ticket.phase` or `ticket.status`: on
`FIXED` and on `INFRA` at attempt 1, the ticket stays `implementation/waiting`,
and the next tick observes the new CI run. `UNFIXABLE` and the INFRA attempt cap
are the only brakes — otherwise a still-red PR is picked up again on the next
tick, since re-running the failed jobs bumps the attempt and produces a fresh
dedup key. The attempt cap exists because an uncapped INFRA path would otherwise
spawn a fix agent every tick forever against a permanently broken CI
environment.

`writeLearning` fires only on `FIXED` when the agent emitted a `LEARNING:` line,
and a failure there cannot affect the fix path. The pipeline never creates
GitHub issues.

**Phase key:** `"ci-fix"` in `PHASE_MODEL_DEFAULTS` (`src/phases/model.ts`).
Default: `{ model: "claude-sonnet-4-6", thinking: "high" }`. Override via
`config.toml` `[phases.defaults.ci-fix]` or `ticket.phases["ci-fix"]`. Bedrock
users must override this phase the same way as `"conflict-resolution"`.

**Agent prompt:** lives inline in `compose.ts`, consistent with
`conflict-resolution`. It tells the agent to fetch the log with
`gh run view --log-failed`, reproduce the failure with the job's own command,
fix and verify locally, commit but never push, and end with the verdict line. It
names three common cases explicitly: lint/format violations left by conflict
resolution; commit messages rejected by commitlint (reword via
`git commit --amend` or a non-interactive rebase, never a new commit); and
commits rejected by the "Check commits are signed" CI step (see below), where
the prompt explicitly forbids running `git config commit.gpgsign false` or
otherwise weakening signing — CI's job is to catch exactly that shortcut, so the
agent is told to verdict `UNFIXABLE` instead when signing itself is broken in
its environment.

**Commit signature enforcement:** `.github/workflows/ci.yml`'s "Check commits
are signed" step runs `scripts/commit-signed.sh <%G?> <sha>` over every commit
in the push/PR range and fails on `N` (no signature at all). It deliberately
does not require a valid/verifiable signature (`G`) — CI has no contributor
public keys imported, so a genuinely signed commit normally reports `E` ("good
signature, can't check, no public key"), which the script treats as passing.
This exists because a repo-local `commit.gpgsign = false` in `.git/config`
silently disables signing for every worktree of the repository (linked worktrees
share the common `.git/config` unless a setting is written with `--worktree`),
and an agent that hits a signing failure has previously "fixed" it that way
instead of surfacing the real problem.

`resolveCIFixAction` must be registered **before** `spawnCIFixAction` in the
`tickActions` array so a completed fix run is resolved before the spawn action
can re-evaluate the same ticket. Both are gated on
`config.tick.resolveCIFailures`.

`resolveCIFixAction.applies` deliberately does **not** exclude
`status === "needs-attention"`, unlike every other action that can park a
ticket. Its guard is the presence of a context file, and every path — including
`park` — deletes the context file it consumed, so `applies` goes false on its
own and there is no retry loop. Adding the status guard would instead strand any
unprocessed sibling context file on an already-parked ticket, because no later
tick would ever revisit it. Do not add the guard.

Actions that reconcile missing data (e.g. `reconcilePRsAction`) must guard their
`applies` predicate so they fire only when the data is absent and never
overwrite a non-empty field. The `prs.length === 0` guard in
`reconcilePRsAction` follows the same discipline as `createWorktreeAction`'s
`Object.keys(ticket.worktrees).length === 0` guard.

## `wont-do` phase

Terminal phase (alongside `merge/done`) that permanently excludes a ticket from
the tick queue; its only valid status is `"done"`.

- Not in `PHASE_SEQUENCE` or `ActivePhase` — never run as an agent phase.
- In `FULL_PHASE_SEQUENCE` (after `merge`) so it sorts last in `ur status`.
- The advance pass filters `t.phase !== "wont-do"` so status expansions cannot
  re-admit it.
- `ur decline <id> [reason]` sets `wont-do/done` and appends
  `\n\n---\nDeclined: <reason>` to the body; the upstream provider ticket is
  **not** closed.
