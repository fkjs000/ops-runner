# Security model

## Command execution
- Commands are executed as `argv[]` via `systemd-run ... -- <argv...>`.
- `command[0]` must be an **absolute path**.
- Commands must match an allowlisted prefix set in plugin defaults.

This prevents arbitrary `bash -lc "..."` injection patterns.

## Hooks
- `postRunHooks` are **absolute paths only** and validated against allowlisted prefixes.

## Secrets
- The registry must not store secrets.
- Prefer loading secrets at runtime inside your workspace script (deployment-specific), e.g. from an encrypted env file.

## Notification targets
- Treat chat IDs / webhook URLs as deployment config.
- Keep examples in docs as placeholders (`<chat_id>`).
