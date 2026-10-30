---
name: debug-tick
description: Use when the tick is not running or not appearing to run, tick.ndjson shows errors or is silent, the lock is stuck or missing, GitHub returns 401s under launchd or cron, or macOS keeps prompting for permissions on tick runs. Per-ticket problems — wrong output, unexpected park, missing PRs — belong to triage-ticket, not here.
---

# Debugging the lazyboy tick

## Overview

The tick's own evidence lives in `~/.urras/tick.ndjson`, one JSON object per
line with `ts` (ISO 8601 UTC) and `event`. It is written by `appendTickLog`
(`src/tick.ts`) — distinct from `appendTicketLog`, which writes the per-ticket
log. The runtime dir is resolved by `urrasDir()` (`src/paths.ts`): `$URRAS_DIR`
when set, otherwise `$HOME/.urras`.

The LaunchAgent runs the tick every 5 minutes. The plist must never point
`StandardOutPath` or `StandardErrorPath` at `tick.ndjson` — the tick owns its
own writes; a plist that does this means someone broke that invariant.

For problems with a specific ticket — wrong output, unexpected park, missing PR
— use `triage-ticket` instead.

## Procedure

1. **Run `lazyboy doctor` first.** It automates the most common checks:
   LaunchAgent loaded and healthy, tick freshness and stale-lock detection,
   required env vars set and non-empty, and launchd non-demand spawn
   suppression. If doctor surfaces a clear fail with a remedy, follow the remedy
   before continuing. The manual steps below are for when doctor output is
   ambiguous or you need to drill deeper into the raw evidence.
2. **Is the LaunchAgent loaded?** Check with
   `launchctl print gui/<uid>/com.jackjennings.lazyboy` (`detectLaunchdEnabled`
   in `src/launchd.ts`). Use `lazyboy enable` / `lazyboy disable` to manage it.
   These operate the LaunchAgent only and are unrelated to `config.toml`, which
   is re-read on every tick with nothing to restart.
3. **What do the last lines of `tick.ndjson` say?** Tail the file; each line has
   `ts` (ISO 8601 UTC) and `event`.
4. **Is there a live or stale `tick.pid`?** The pid file is `~/.urras/tick.pid`.
   Lock behavior: if the pid file exists and the recorded pid is alive, and the
   file's mtime is under 30 minutes (`STALE_LOCK_MS = 30 * 60 * 1000` at
   `src/lock.ts:20`), the tick logs `tick-already-running` and returns silently.
   Past 30 minutes it logs `stale-lock` (with `thresholdMinutes`) and takes the
   lock anyway. Any throw during acquisition logs `lock-failed`. The pid file is
   removed in a `finally`, so a leftover `tick.pid` means the process died hard.
   A run of consecutive `tick-already-running` lines is the normal symptom of
   one wedged tick blocking all subsequent ones for up to 30 minutes.
5. **Did the tick reach `tick-end` or log `tick-failed`?** Both events are in
   `tick.ndjson`.
6. **Do credentials resolve in a non-GUI context?** See the Credentials section
   below.
7. **Is the symptom actually per-ticket?** For problems with a specific ticket —
   wrong output, unexpected park, missing PR — use `triage-ticket` instead.

## Events reference

| `event`                | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `tick-start`           | Tick loop began                                                |
| `tick-end`             | Tick loop completed normally                                   |
| `tick-failed`          | Tick loop threw an unhandled error                             |
| `tick-already-running` | Pid file exists, pid alive, age < 30 min; tick exited silently |
| `stale-lock`           | Pid file exists but age ≥ 30 min; lock taken anyway            |
| `lock-failed`          | Lock acquisition threw; tick exited                            |

## Credentials under launchd and cron

In a non-GUI session the login keychain is locked, so `gh auth token` returns
empty. The tick then sends `Authorization: Bearer` (empty) and GitHub answers
401. Rotating a token cannot fix this.

Credentials must come from `~/.config/urras/env`, which `scripts/tick.sh`
sources (lines 12–17) and `bin/lazyboy` also sources. `config.toml` startup
validation checks only that each `[github.accounts.*].token_env` is _set_, not
that its value is non-empty, so an empty-but-set variable passes validation and
fails per-request. (`lazyboy doctor` check 9 tests both conditions — set and
non-empty.)

To diagnose: reproduce the non-GUI environment rather than trusting an
interactive shell, and confirm the token variable resolves to the expected value
before blaming the pipeline.

## Recurring macOS permission prompts

The prompts are `kTCCServiceSystemPolicyAppData` ("wants to access data from
other applications"). The responsible binary is Deno, but the actual requesters
are child processes (`op`, `claude`, `find`, `zsh`). TCC keys grants by the
responsible binary's absolute path; these live at version-numbered Homebrew
paths (`/opt/homebrew/Cellar/deno/<version>/bin/deno`), so every `brew upgrade`
invalidates the grant and re-prompts.

Fix directions: grant Full Disk Access to `/opt/homebrew/bin/deno` (re-grant
after upgrades), or grant `op` access once. Deno's `--allow-read` flag and macOS
TCC are orthogonal enforcement layers; scoping `--allow-read` cannot affect what
a spawned subprocess reads.

## Gotchas

- **Log timestamps are UTC; `ls`/`stat` mtimes are local.** Convert before
  claiming one event preceded another.
- **Hard constraint: `--allow-sys=kill` is not a valid `--allow-sys` kind.** It
  causes Deno to fail at startup, breaking every command including the tick.
- **Hard constraint: `Deno.kill` requires unscoped `--allow-run`.** `Deno.kill`
  is used by `isProcessAlive` (`src/executor.ts`), which `PidFileLock` and
  `src/commands/decline.ts` depend on. Scoped `--allow-run=git,deno,…` makes it
  throw `NotCapable`; `isProcessAlive` swallows the throw, and then every live
  phase agent looks dead. Any future permission-scoping work must leave
  `--allow-run` unscoped.
