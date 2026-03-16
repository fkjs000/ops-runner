# Registry design

The ops-runner registry is a JSON file stored in the OpenClaw state directory.

Typical path:
- `~/.openclaw/state/ops-runner/jobs.json`

## Schema (simplified)

```jsonc
{
  "schemaVersion": 1,
  "jobs": {
    "<jobKey>": {
      "jobKey": "<jobKey>",
      "unitBase": "<unitBase>",
      "mode": "singleton",
      "command": ["/abs/path/to/script.sh", "--arg"],

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
        "title": "<jobKey>",
        "includeJournalTailLines": 120
      }
    }
  }
}
```

## Write-safety requirements

Registry writes must be safe under concurrent updates.

Recommended properties (implemented in this plugin):

1) **Global registry lock**
- lock file: `registry.lock`
- use `flock` to ensure only one writer at a time

2) **Unique tmp filename per write**
- avoids `.jobs.json.tmp` collisions

3) **No silent "reset to empty" on read errors**
- if the file is corrupted, back it up (`jobs.json.bad.<ts>`) and attempt recovery from the latest `jobs.json.bak.*`
- if recovery is not possible, surface an error rather than wiping

## Backups

The plugin keeps point-in-time backup snapshots:
- `jobs.json.bak.<timestamp>`

Backups are used to recover from partial writes or filesystem issues.
