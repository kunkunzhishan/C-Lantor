# Agent Runtime Model

Lantor runs agents as local processes. Each agent profile stores runtime
configuration, a model, Codex reasoning and speed preferences, an optional
custom launch command, an optional working directory, and profile metadata. The
desktop app starts the same binary in
`--supervisor` mode; the supervisor owns process launch, stop commands, run
logs, event ingestion, and work-item scheduling.

## Dispatch

Dispatch is work-item based:

- Human messages create work items by mentioning an agent handle, such as `@Hancock`.
- DMs, thread follow-ups, reminders, tasks, channel messages, and handoffs can wake agents.
- One active run is allowed per agent. Extra mentions, retries, and manual dispatches stay queued.
- The supervisor schedules the oldest queued work item for each idle agent.
- Cancellation marks queued work as cancelled or sends a stop command for a running run.
- Retry creates a new queued work item instead of mutating historical state.

Call Mode is also dispatch-backed, but call utterances are not normal chat
messages. A call session records utterances and immediate ACKs in Call Mode
tables, then links accepted background work to existing `agent_work_items` or
long tasks. See [Call Mode Contract](call-mode-contract.md) for the MVP command,
data, ACK, and UI contracts.

Warm Codex and Claude runtimes reply with normal assistant text for the current
channel or thread. Lantor routes that text into the correct chat surface. They
may also emit standalone `LANTOR_EVENT` control lines for structured side
effects.

Stdout-command runtimes are still supported for custom scripts. They can print
one line to stdout with the `LANTOR_EVENT ` prefix followed by JSON. Non-matching
stdout and stderr are preserved only in the run log.

## Context Tools

The supervisor injects `LANTOR_CONTEXT_TOOL` for read-only context access.
Agents use it to inspect the current workspace, recover after restart, and
process inbox wakeups.

```bash
"$LANTOR_CONTEXT_TOOL" --agent-context-tool inbox-list --state active --limit 20
"$LANTOR_CONTEXT_TOOL" --agent-context-tool inbox-read --inbox-id "<uuid-or-prefix>"
"$LANTOR_CONTEXT_TOOL" --agent-context-tool inbox-archive --inbox-id "<uuid-or-prefix>"
"$LANTOR_CONTEXT_TOOL" --agent-context-tool workspace-info
"$LANTOR_CONTEXT_TOOL" --agent-context-tool workspace-list --max-depth 2 --limit 80
"$LANTOR_CONTEXT_TOOL" --agent-context-tool history-read --target "#channel[:thread_id]" --limit 20
"$LANTOR_CONTEXT_TOOL" --agent-context-tool message-search --query "<text>" --target "#channel" --limit 20
"$LANTOR_CONTEXT_TOOL" --agent-context-tool attachment-info --attachment-id "<uuid>"
"$LANTOR_CONTEXT_TOOL" --agent-context-tool artifact-read --artifact-id "<uuid>"
"$LANTOR_CONTEXT_TOOL" --agent-context-tool call-utterance-read --utterance-id "<uuid>"
"$LANTOR_CONTEXT_TOOL" --agent-context-tool agent-inspect --target "@handle"
```

Inbox and workspace commands default to the current agent. Use
`--target "@handle"` only when inspecting another visible agent.

## Agent Memory

Each agent has a persistent working directory. By default Lantor uses
`~/Library/Application Support/Lantor/agents/<handle>/`, but the agent profile
can point at any directory you prefer. Lantor stores agent memory under that
workspace's `memory/` directory.

Realtime continuity notes live under `memory/realtime/<agent_id>/`. Older
realtime segments can be ingested into durable event memory under
`memory/events/<agent_id>/`. Agents can also keep artifacts and task-specific
files in their workspace when work needs durable context.

Memory-related control events:

- `memory_run_summary`: append a concise realtime note for the current run.
- `profile_update`: update display name, role, avatar, or description.

Memory prompts intentionally follow a file-based memory model: raw dialog/tool
output stays out of realtime notes, and long-term event memory is maintained by
event ingestion from older realtime segments.
