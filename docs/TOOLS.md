# Tool interface

This plugin exposes tools to OpenClaw agents.

## Job registry
- `ops_runner_job_list`
- `ops_runner_job_add`
- `ops_runner_job_update`
- `ops_runner_job_remove`

## Execution
- `ops_runner_kickoff` — start a run for a jobKey

## Observation
- `ops_runner_status` — read merged status (status JSON + systemd unit info)
- `ops_runner_journal` — tail `journalctl --user -u <unit>`

## Monitoring
- `ops_runner_monitor` — enable/disable lightweight monitor heartbeat updates

## Reason tokens

`ops_runner_status.reason` is designed to be a short machine-friendly token.

Common examples:
- `created_unit`
- `already_running`
- `finished_ok`
- `failed_<systemd_result>`
- `suspected_stuck`
- `restarted_stale`
- `recovered_from_stale`
