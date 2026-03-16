# ops-runner — Architecture

`ops-runner` is an OpenClaw plugin that runs operational jobs via **systemd user transient units**.

## High-level flow

```
cron (kickoff-only)
  -> ops_runner_kickoff(jobKey)
      -> systemd-run --user --unit <unitName> -- <argv...>
          -> your workspace script

observe
  -> ops_runner_status(jobKey)
  -> ops_runner_journal(jobKey)
```

### Why systemd-run
- isolates long jobs from gateway lifecycle (gateway restarts do not kill the unit)
- gives reliable supervision & journal logs
- supports dedupe (singleton mode) and stale detection

## Core concepts

### Job
A job is defined in the registry and contains:
- `jobKey` (unique)
- `unitBase` (systemd unit base name)
- `mode`:
  - `singleton`: do not start a new run when an active unit already exists
  - `restart`: restart an existing unit (deployment-specific behavior)
- `command`: argv array; `command[0]` must be an **absolute path** and pass allowlist

### Run
A run is identified by a `runId` and has a persisted `JobStatusV1` record.

Typical fields:
- `startedAt`, `heartbeatAt`, `finishedAt`
- `mainPid`
- `exitCode`
- `reason` (short token, snake_case preferred)

## Stale detection (overview)

When enabled by job config:
- `heartbeatIntervalSec` controls how frequently ops-runner will consider a unit “alive”
- `heartbeatTtlSec` is the maximum time without heartbeat before considering “stale”
- `staleGraceSec` provides buffer before acting

If a run is suspected stale, ops-runner may attempt a safe restart (depending on `restartPolicy`).

## Post-run hooks & notifications (overview)

On unit exit, ops-runner can (optional):
- run `postRunHooks` (absolute paths; allowlisted)
- send a notification (`notify` policy)

To prevent duplicates, `postRunDoneAt` / `notifyDoneAt` markers are written to status.
