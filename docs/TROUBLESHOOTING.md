# Troubleshooting

## unknown_jobKey
- The registry does not contain that jobKey.
- Verify with `ops_runner_job_list`.
- If a registry write failed previously, check for:
  - `jobs.json.bad.<ts>`
  - `jobs.json.bak.*`

## Registry unexpectedly empty
This typically indicates a write race or a bad recovery strategy.

Ensure:
- global registry lock (not per-job lock)
- unique tmp files
- do not overwrite with an empty registry on JSON parse error

## Job seems "stuck"
Use:
- `ops_runner_status(jobKey)` to confirm timestamps (`heartbeatAt`) and unit state
- `ops_runner_journal(jobKey, lines=200)` to inspect last logs

If stale detection is enabled:
- confirm `heartbeatTtlSec`/`staleGraceSec` values are reasonable

## systemd PATH issues
In systemd user units, PATH can be minimal.

Mitigation:
- use an absolute path in `command[0]`
- use a wrapper (e.g., `scripts/bin/openclaw`) if you need to call OpenClaw CLI from jobs
