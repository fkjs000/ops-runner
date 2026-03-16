# ops-runner（OpenClaw 外掛 / Plugin）

`ops-runner` 是一個偏生產環境導向的 OpenClaw Job Runner 外掛。

核心概念是：把實際工作交給 **systemd user transient unit** 執行（`systemd-run --user`），而 OpenClaw cron/agent 只負責「快速交辦（kickoff-only）」。

此 repo **只包含外掛本體**，不包含任何個人化 jobs 與 secrets。

---

## 為什麼需要 ops-runner

在 OpenClaw 裡，cron / agentTurn 很適合做輕量排程；但當任務變長、需要穩定執行時，常見問題包括：

- 長任務容易被 gateway 重啟 / timeout 影響
- systemd 非互動環境（無 TTY）會讓某些工具授權流程卡住
- cron run lifecycle 不適合承載真正的長工作（因此推薦 kickoff-only）

`ops-runner` 的定位是：

- cron 只做交辦（kickoff）
- systemd 才執行真正工作
- plugin 提供可追蹤狀態與觀測工具

---

## 架構

```
cron（kickoff-only）
  -> ops_runner_kickoff(jobKey)
      -> systemd-run --user --unit <unitName> -- <argv...>
          -> 你的 workspace 腳本（可審計）
               -> （可選）產出報告 / 推播訊息

ops_runner_status(jobKey)
  -> 讀取 status json
  -> 查 systemd unit 狀態
  -> unit 結束時 finalize（寫入 finishedAt/exitCode）
  -> （可選）postRunHooks / notify（best-effort、只做一次）
```

---

## 設計理念（重點）

- **registry 驅動**：jobs 存在 state 目錄的 JSON registry，plugin 本體不寫死任何 job。
- **禁止 shell string**：job 命令使用 `string[]` argv，透過 `systemd-run ... -- <argv...>` 執行。
- **allowlist**：`command[0]` 必須是絕對路徑，且符合允許前綴（預設為 workspace scripts）。
- **workspace-only 可審計**：推薦 job 入口皆在 `$WORKSPACE/scripts/ops-runner/*`。
- **cron kickoff-only**：cron 不執行真正工作，避免被長任務/重啟波及。

---

## Registry 與狀態檔

- Registry（典型路徑）：`~/.openclaw/state/ops-runner/jobs.json`
- 可移植空模板：`jobs.json.empty`

簡化 schema：

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

### Registry 寫入安全

為避免同時多筆更新造成 `jobs.json` 被覆蓋或損壞，寫入流程包含：

- **全域 registry lock（flock）**
- **唯一 tmp 檔名**（避免 `.jobs.json.tmp` 打架）
- 壞檔復原：先備份成 `jobs.json.bad.<ts>`，可用時回復最新 `jobs.json.bak.*`

---

## 工具（Tools）

- `ops_runner_job_list/add/update/remove`
- `ops_runner_kickoff`
- `ops_runner_status`
- `ops_runner_journal`
- `ops_runner_monitor`

---

## Reason tokens

`ops_runner_status` 會用短且一致的 reason token（snake_case），例如：

- `created_unit`
- `already_running`
- `restarted_exited_unit`
- `finished_ok`
- `failed_<systemd_result>`
- `suspected_stuck`
- `recovered_from_stale`

---

## 安全提醒

- job 入口建議固定在 workspace scripts，便於審計。
- 不要把 secrets 放在 registry。
- 重啟 gateway / 改設定等高影響操作，請依部署環境的授權機制處理。

---

## License

TBD
