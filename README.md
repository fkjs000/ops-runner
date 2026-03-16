# ops-runner (OpenClaw plugin)

A production-oriented **job runner** plugin for OpenClaw.

It delegates real work to **systemd user transient units** (via `systemd-run --user`) and provides a safe, registry-driven interface for:

- job registry CRUD
- kickoff (run) control
- status + journal inspection
- optional monitor/heartbeat + stale detection
- optional post-run hooks and notifications

This repo contains **only the plugin** (no per-user jobs, no secrets).

---

## Why ops-runner

OpenClaw cron and agent turns are great for lightweight orchestration, but they can be impacted by:

- long-running tasks
- gateway restarts
- tool timeouts
- interactive auth prompts (no TTY)

`ops-runner` moves execution to systemd, keeping cron runs short (**kickoff-only**) while still providing reliable job supervision.

---

## Architecture

```
cron (kickoff-only)
  -> ops_runner_kickoff(jobKey)
      -> systemd-run --user --unit <unitName> -- <argv...>
          -> your workspace script (auditable)
               -> (optional) writes report / pushes message

ops_runner_status(jobKey)
  -> reads status json
  -> queries systemd unit state
  -> finalizes state when unit has exited
  -> (optional) postRunHooks / notify (best-effort, once)
```

### Key design choices

- **Registry-driven jobs**: jobs are stored in a JSON registry (state directory). Plugin code does not hardcode jobs.
- **No shell string execution**: job commands are `string[]` argv, passed to `systemd-run ... -- <argv...>`.
- **Allowlist for commands**: `command[0]` must be an absolute path and must match allowed prefixes (default: workspace scripts).
- **Workspace-auditable entrypoints**: recommended pattern is a wrapper script in `$WORKSPACE/scripts/ops-runner/*`.
- **Kickoff-only cron**: cron should only enqueue work, not do the actual work.

---

## State & registry

- Registry file (example path on a typical deployment):
  - `~/.openclaw/state/ops-runner/jobs.json`
- Portable empty registry template:
  - `jobs.json.empty`

Registry schema (simplified):

```jsonc
{
  "schemaVersion": 1,
  "jobs": {
    "my-job": {
      "jobKey": "my-job",
      "unitBase": "my-job",
      "mode": "singleton",
      "command": ["/abs/path/to/script.sh"],

      "maxRuntimeSec": 900,
      "heartbeatIntervalSec": 30,
      "heartbeatTtlSec": 240,
      "staleGraceSec": 30,
      "restartPolicy": "safe",

      "postRunHooks": ["/abs/path/to/hook.sh"],
      "notify": {
        "mode": "on_error",
        "channel": "telegram",
        "target": "<chat_id>",
        "title": "my-job",
        "includeJournalTailLines": 120
      }
    }
  }
}
```

### Registry write safety

The registry is written using:

- a **global registry lock** (flock)
- a **unique tmp filename** per write
- recovery behavior: if registry is corrupted, it is backed up and the latest `jobs.json.bak.*` is restored when available

This prevents data loss when multiple updates happen concurrently.

---

## Tools

The plugin exposes OpenClaw tools (names may depend on your OpenClaw config):

- `ops_runner_job_list`
- `ops_runner_job_add`
- `ops_runner_job_update`
- `ops_runner_job_remove`
- `ops_runner_kickoff`
- `ops_runner_status`
- `ops_runner_journal`
- `ops_runner_monitor`

---

## Reason strings

`ops_runner_status` uses short, consistent reason tokens (snake_case), e.g.

- `created_unit`
- `already_running`
- `restarted_exited_unit`
- `finished_ok`
- `failed_<systemd_result>`
- `suspected_stuck`
- `recovered_from_stale`

---

## Security notes

- Prefer **workspace scripts** as entrypoints.
- Do not store secrets in the registry.
- Treat gateway restarts / system changes as privileged operations (deployment-specific auth).

---

## License

TBD
