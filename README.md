# urras

Automates software development so human time is spent only on tasks requiring
specialized judgement. Polls for assigned work, runs each ticket through a phase
pipeline via an AI agent, and pauses at each phase boundary that requires human
approval.

The goal of `urras` is aim an engineer's focus at tasks that require expertise
or taste, and allow the coding agent to handle all rote tasks in between.

> [!NOTE]
> This software is under active development, and should be considered an alpha
> release at best. urras is currently dogfooding itself, which means the code
> quality is limited by the small number of controls currently built into the
> tool. As the ability for the harness to self-improve itself improves, expect
> the quality of the code, prompts, documentation, etc. to be fixed.

## How it works

Each ticket moves through six phases:

| Phase              | What runs                                                      | Human gate      |
| ------------------ | -------------------------------------------------------------- | --------------- |
| **intake**         | Proposes which repos the ticket needs access to                | Approve scope   |
| **enrichment**     | Gathers context from the codebase                              | Review context  |
| **spec**           | Writes a precise specification                                 | Validate spec   |
| **plan**           | Writes a TDD implementation plan                               | Approve plan    |
| **implementation** | Creates the artifact (code / document)                         | Review diff     |
| **merge**          | Calls GitHub API to merge PR, removes worktree, deletes branch | Authorize merge |

Each phase runs the configured agent (either [pi](https://pi.dev) or
[claude-code](https://claude.com/product/claude-code)) as a host subprocess with
`cwd` set to the worktree(s) under development, and the relevant context files
passed in as `@/path` arguments.

`urras` runs `tick` every 5 minutes as a background job. Tickets advance
automatically until they hit a gate, then wait for `ur approve <id>`. Phases can
self-approve or be skipped under certain circumstances, depending on the work
being performed; this is dictated by a default prompt for each phase, each of
which can be extended by the user.

`scripts/tick.sh` handles GitHub token capture and env setup. To override env
vars (e.g. `ANTHROPIC_API_KEY`), add them to `~/.config/urras/env`.

`urras` tracks state in a git repository, storing a log of each ticket and all
related outputs. This same git repository stores user-maintained prompts that
extend the default set bundled with `urras`.

As work moves through phases, `urras` will self-reflect on tasks that were more
difficult than expected, or required user intervention to get right. This
self-reflection results automated updates to prompts in the state repository
(scoped either to a specific repository, organization, or globally), as well as
proposals to update the documentation or AGENT.md instructions of projects under
modification.

### New repository scope

When a ticket's purpose is to create a new GitHub repository, intake can mark it
with a `(new)` suffix in `## Proposed Scope`:

```yaml
scope:
  - jackjennings/urras
  - jackjennings/urras-extensions (new)
```

`urras` initializes the repository locally at intake (no GitHub action yet), so
the ticket runs through enrichment → spec → plan normally. Plan approval is the
human gate before any remote is created. Once the plan is approved, `urras`
creates the GitHub repository, adds the remote, and pushes `main` before
implementation begins.

## Usage

```bash
ur tick               # advance all active tickets (run automatically)
ur approve <id>       # approve the current phase gate
ur status [id]        # show all active tickets or the status of a single ticket
ur hud                # live status display
ur retry <id>         # reset a needs-attention ticket
ur decline <id> [why] # permanently exclude a ticket from the queue
ur review <id>        # review the latest phase output
ur shell <id>         # open a shell in the ticket's worktree
ur tail [id]          # stream the tick log or a ticket's event log
ur enable             # start the scheduler
ur disable            # stop the scheduler
ur update             # pull latest urras source
```

## Config

`~/.config/urras/config.toml`:

```toml
[github]
repos = ["jackjennings/urras"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 2

[codebase]
# List of directories the intake phase can look through when proposing scope.
# A top-level directory listing of each root is passed to the intake agent so
# it can propose paths that actually exist rather than plausible-sounding guesses.
# Without this, intake proposes scope from ticket text alone — still useful,
# but the human approval gate will more often need to correct wrong directory names.
roots = ["~/code"]

[agent]
# Selects which CLI runs every phase — `"pi"` (default) for the `pi` CLI, or
# `"claude-code"` to run the `claude` CLI instead. This is orthogonal to
# `[pi].provider` below, which only takes effect when `agent.type` is `"pi"`.
type = "pi"

[pi]
# Selects which backend `pi` talks to for every phase — `"anthropic"` (default)
# for the direct Console API, or `"bedrock"` for Amazon Bedrock. When using
# `"bedrock"`, model IDs configured under `[phases.defaults]` must already carry
# Bedrock's `anthropic.` prefix (e.g. `anthropic.claude-opus-4-8`, not
# `claude-opus-4-8`), and `AWS_REGION` plus AWS credentials must be available in
# urras's own environment (env vars, a shared profile, or an instance role) —
# urras does not manage AWS auth itself. Every phase must be explicitly
# configured under `[phases.defaults]` when using Bedrock — any phase left
# unconfigured falls back to urras's built-in default model IDs, which are
# unprefixed and will fail against Bedrock. This includes the conflict-resolution
# phase (triggered by rebase conflicts), configurable under
# `[phases.defaults."conflict-resolution"]` like any other phase.
provider = "anthropic"
packages = ["agent-browser"]

# Adds a local [todo.txt](https://todotxt.org) file as a work provider. Every
# non-completed task becomes a ticket. When a ticket closes, the task is marked
# done in-place with an `x YYYY-MM-DD` prefix. The `file` key is required when
# the section is present; `~/` is expanded to the home directory.
[todo_txt]
file = "~/todo.txt"
```

### GitHub token configuration

**Single-account mode:** Set `GITHUB_TOKEN` and `GITHUB_LOGIN` in the
environment. No additional `config.toml` entries are required. These variables
also act as the fallback for any org not mapped via `[github.orgs]` when
multi-account mode is active.

**Multi-account mode:** Define named accounts under `[github.accounts.*]` and
map org slugs to account names under `[github.orgs]`:

```toml
[github.accounts.personal]
token_env = "GITHUB_TOKEN_PERSONAL"
login     = "alice"

[github.accounts.work]
token_env = "GITHUB_TOKEN_WORK"
login     = "alice-corp"

[github.orgs]
myorg    = "personal"
mycompany = "work"
```

Each account's `token_env` names the environment variable holding the token;
`login` is the GitHub username. `[github.orgs]` maps org slugs to account names.
Any org not listed falls back to `GITHUB_TOKEN`/`GITHUB_LOGIN`.

**Startup validation:** urras validates at startup that every `token_env` named
in `[github.accounts.*]` is set in the environment, and that every account name
referenced in `[github.orgs]` is defined. A misconfiguration causes an immediate
startup error rather than a per-ticket failure.

**`gh` CLI compatibility:** urras injects `GH_TOKEN` (and `GITHUB_TOKEN`) as
environment variables before each phase subprocess. `gh auth login` state is
ignored — do not rely on it.

**Cron and LaunchAgent contexts:** Environment variables are not available from
the keychain in cron. Set `GITHUB_TOKEN`, `GITHUB_LOGIN`, and any per-account
token variables (e.g. `GITHUB_TOKEN_PERSONAL`, `GITHUB_TOKEN_WORK`) in
`~/.config/urras/env`; `scripts/tick.sh` sources this file before the tick loop.

## Artifacts

Not all tickets produce pull requests. The `artifact` field in `meta.md`
controls what the implementation phase produces and what "merge" means:

| Value          | Implementation produces               | Merge step                                   |
| -------------- | ------------------------------------- | -------------------------------------------- |
| `pr` (default) | Code diff                             | Opens GitHub PR                              |
| `notion`       | Written document (RFC, proposal, ADR) | Posts to Notion                              |
| `work` (TODO)  | New work tickets                      | Posts to ticket tracker (Jira, Linear, etc.) |

## Ceremonies

Ceremonies are time- or event-triggered automations that use the system's state
as input and produce an output (Slack standup, weekly digest, sprint report)
without a ticket or human gate. They are configured separately from the ticket
pipeline:

```
{stateDir}/ceremonies/
  summary/
    config.toml     # time = "HH:MM"; optional: model = "...", thinking = <budget_tokens>
    prompt.md       # ceremony behavior; receives current date as system context
    output/
  digest/
    config.toml
    index.ts        # alternative to prompt.md: ceremony behavior as code
    output/
```

Each ceremony directory under `{stateDir}/ceremonies/{name}/` activates the
named ceremony. The directory contains a `config.toml` with scheduling keys:

| Key              | Required | Description                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------ |
| `time`           | yes      | Earliest wall-clock time to run (`"HH:MM"` in local timezone)                        |
| `interval_hours` | no       | Run repeatedly, at most once per this many hours after `time`; omit for once-per-day |
| `workdays_only`  | no       | When `true`, skip Saturday and Sunday (default `false`)                              |

A ceremony's behavior is either a prompt (`prompt.md`) or code (`index.ts`);
when both are present, `index.ts` wins. `index.ts` default-exports a function
that receives a `CeremonyContext`:

```ts
export default async function (context) {
  const ids = await context.listTickets();
  await context.writeOutput(`# Report\n\n${ids.length} tickets\n`);
}
```

| Member                                           | Purpose                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `now: Temporal.ZonedDateTime`                    | Scheduled run time                                                  |
| `stateDir`, `ceremonyDir`, `outputDir`           | Paths                                                               |
| `config: Record<string, unknown>`                | Parsed `config.toml`                                                |
| `listTickets(): Promise<string[]>`               | Ticket IDs                                                          |
| `readTicket(id): Promise<TicketState>`           | One ticket                                                          |
| `generateText(options): Promise<string \| null>` | Ancillary LLM call via `LanguageModel`, default `claude-sonnet-4-6` |
| `writeOutput(content): Promise<void>`            | Writes `${compactTimestamp(now)}-${name}.md` into `outputDir`       |
| `commitState(): Promise<void>`                   | Commit the state repo                                               |
| `notify(title, message): Promise<void>`          | Desktop notification                                                |
| `log(entry): Promise<void>`                      | `appendTickLog` with `ceremony` filled in                           |

Ceremonies defined in the state dir do not run until an operator approves them:

```bash
ur approve ceremony/digest
```

Approval records a hash of the ceremony directory in
`~/.urras/ceremony-approvals.json` — a recursive walk of every file, except the
ceremony's own top-level `output/`. Any later edit to `config.toml`,
`prompt.md`, or `index.ts` revokes the approval; the ceremony stops running,
logs `ceremony-warning` with `reason: not-approved`, and fires a desktop
notification naming the `ur approve` command to run, both throttled to once per
scheduled occurrence rather than once per tick, until it is approved again.
`ur approve ceremony/<name>` prints the recorded hash and every path it hashed,
so you can see exactly what you vouched for. Built-in ceremonies
(`documentation-gaps`) need no approval.

Upgrading from a version without the gate: an existing working `prompt.md`
ceremony stops running on the first tick after this lands, and keeps warning
once per scheduled occurrence, until you run `ur approve ceremony/<name>` for
it.

The hash is the only control — ceremony code runs with the tick process's full
permissions and live credentials, and there is no sandbox. Two consequences to
check when reviewing a ceremony before approving it:

- The `output/` exclusion is what lets a ceremony write its own results without
  revoking itself, so **approved code that imports or evaluates anything under
  `outputDir` — or anywhere else in the state dir — voids the guarantee**, since
  that content is outside the hash and can change freely afterwards. The
  exclusion is applied before the walk decides an entry's type, so a _symlinked_
  `output` pointing anywhere is excluded too. Read a ceremony for code that
  loads further code, not just for what the code itself does.
- The walk records but does not follow a symlink to a directory outside the
  ceremony, and it refuses to hash a directory holding more than 2000 files or
  64 MiB; a ceremony over either cap can never be approved. A ceremony
  containing a directory symlink whose target is outside the ceremony root can
  also never be approved.

A particularly valuable ceremony type is **meta-review**: a recurring analysis
of recently completed tickets that extracts learnings and writes them to
`principles.md` in the state repo. Each completed ticket already produces a
`log.md` recording what happened at each phase — what feedback was given, what
corrections were made, what needed human intervention. The meta-review ceremony
reads these logs across a batch of tickets, identifies patterns, and proposes
additions to `principles.md` as improved LLM instructions for future runs. This
closes the learning loop automatically rather than requiring per-ticket
curation.

### Prior art

- [Devin](https://devin.ai) — commercial autonomous coding agent; assigns via
  Linear/Slack/API and ships a PR. One human gate (PR review). urras differs in
  having five deliberate phase gates and owned infrastructure.
- [OpenHands](https://openhands.dev) — open source autonomous coding SDK and
  platform with GitHub/Jira/Linear integrations. Similar execution model to
  Devin; self-hostable.
- [Goose](https://goose-docs.ai) — open source multi-provider AI agent with
  MCP-based extensibility and semantic codebase understanding. Runs
  interactively or headlessly; no built-in phase gates or pipeline model.

## Zsh plugin

The `plugin/urras.plugin.zsh` file defines three-character aliases and sources
tab completions automatically. To install:

**Oh My Zsh:**

```zsh
git clone https://github.com/jackjennings/urras \
  ~/.oh-my-zsh/custom/plugins/urras
```

Then add `urras` to the `plugins` array in `~/.zshrc`:

```zsh
plugins=(... urras)
```

The plugin sources `ur completion zsh` at shell startup, so no separate
completion setup is needed when using the plugin.

| Alias | Command         |
| ----- | --------------- |
| `utk` | `ur tick`       |
| `uap` | `ur approve`    |
| `ust` | `ur status`     |
| `uen` | `ur enable`     |
| `udi` | `ur disable`    |
| `udo` | `ur doctor`     |
| `uco` | `ur completion` |
| `urt` | `ur retry`      |
| `udc` | `ur decline`    |
| `urw` | `ur rewind`     |
| `urv` | `ur review`     |
| `ush` | `ur shell`      |
| `uta` | `ur tail`       |
| `uup` | `ur update`     |
| `uhd` | `ur hud`        |
| `uus` | `ur usage`      |
| `uca` | `ur capture`    |
| `ubr` | `ur brainstorm` |

---

## Opportunities

Ideas worth exploring but not yet scheduled:

- **LLM-determined packages:** rather than a global package list, the intake
  phase proposes which packages a specific ticket needs (e.g. `agent-browser`
  for UI work, nothing for a pure backend change). This becomes part of the
  scope approval gate — the human confirms both directory access and tool access
  before any codebase-touching phase runs.

- **Network access per phase:** the enrichment phase needs open network access
  to read documentation and external resources; all other phases are locked to
  `api.anthropic.com` and `api.github.com`. Currently all phases use the same
  tight allowlist. The right design is to pass the phase name into
  `run-phase.ts` and skip `createHttpHooks` for enrichment, leaving network
  unrestricted while still injecting credentials as plain env vars. Longer term,
  the intake phase could propose a network allowlist alongside the filesystem
  scope, with human approval at the same gate.

- **On-device Apple Intelligence:** low-reasoning phases (intake, enrichment)
  could run against Apple's on-device Foundation Models via
  [apfel](https://github.com/Arthur-Ficial/apfel), eliminating API cost and
  latency for those steps entirely. Pairs with the per-phase model config
  already planned for sub-project 5. Pi supports any OpenAI-compatible provider
  via `models.json`, and apfel exposes an OpenAI-compatible interface — so this
  is a supported pi configuration path with no urras code changes required.

- **Self-hosted models for low-reasoning phases:** intake and enrichment don't
  require frontier models — they read text and follow instructions. A
  locally-run model (Ollama, llama.cpp) could handle these phases at near-zero
  marginal cost, reserving paid API calls for spec, plan, and implementation.
  The model selection config above makes this a per-phase swap rather than a
  system-wide change.

- **Work item creation:** any phase that identifies deferred work — a bug found
  during enrichment, a prerequisite surfaced during spec, a refactor noted
  during implementation — should be able to create a new ticket in the
  originating system rather than expanding scope or losing the finding. This
  requires a `createWorkItem()` method on the `Provider` interface alongside
  `fetchNew()`. The new ticket enters the queue like any other and is processed
  on a future tick. This is the primary mechanism for keeping individual tickets
  focused and avoiding scope creep.

- **`ur ps` and real-time monitoring:** `ps` would scan all `meta.md` files for
  `phase: running-*` tickets and print the active agent processes with their
  PID, phase, and ticket title. A `top`-style TUI would extend this with live
  refresh, showing ticket progression, phase durations, and concurrency
  utilisation in real-time.

- **Dynamic credentials:** `~/.config/urras/env` is a static file, but some
  credentials have short lifespans and need refreshing on a cadence (e.g. AWS
  CodeArtifact tokens, short-lived OAuth tokens). A future extension could allow
  env entries to specify a refresh command alongside the value — urras would
  re-run the command before each tick and inject the fresh value. Format could
  follow the pattern of shell credential helpers (similar to `credential.helper`
  in git config).

- **MCP support:** once Pi gains MCP client support, the host-side pre-fetch
  approach for external sources (Slack, Notion, GitHub) can be replaced with MCP
  servers running on the host and exposed to the enrichment VM. This gives the
  agent interactive query capability — follow links, ask follow-up questions,
  paginate results — rather than working from a static snapshot. The same
  mechanism would enable MCP-based tool use in other phases (e.g. posting to
  Slack from a ceremony, updating a Jira ticket on merge).

- **Work dependencies:** some tickets can't start until others are complete. A
  `depends_on` field in `meta.md` would let the tick loop skip tickets whose
  dependencies aren't yet in `done` state. The intake phase is a natural place
  to propose dependencies — it already reads the ticket and has enough context
  to identify blocking relationships. Dependencies could also be sourced
  directly from the provider (GitHub Issues and Jira both support
  linked/blocked-by relationships).
