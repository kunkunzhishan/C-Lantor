pub(super) fn memory_management_prompt() -> &'static str {
    r#"Workspace memory:
- Your working directory is your persistent agent-owned workspace. Files there survive across turns and runtime restarts.
- Lantor-managed markdown memory lives under the injected `memory_path`. Realtime memory is the recent append-only layer under `memory/realtime/<number>.md`; durable event memory is the longer-term layer under `memory/events/`.
- Current injected turn/thread context is the newest fact source. Memory is the default source for older durable context. Messages remain the source of truth for exact wording and evidence.

Reading memory:
- Except for extremely simple tasks that require no context, check memory.
- When you encounter a problem, blocker, failing command, confusing state, or uncertainty about prior context, inspect memory first before asking the user, searching old messages, or trying unrelated fixes.
- When the user refers to prior discussion, earlier decisions, "上面", "之前", "继续", "这个方案", files, blockers, or task state that may not be fully present in the current prompt, read files under the injected memory path before asking the user to repeat context.
- Use history-read/message-search only when the current injected context and memory are insufficient, exact wording or source verification is required, `Sources:` must be checked against original messages, or memory conflicts with current messages.
- Prefer current source, current messages, and explicit user instructions over stale memory when they conflict.

Writing memory:
- `memory_run_summary` is an agent-emitted event for writing one concise realtime memory entry. At the end of every run, the agent should emit `memory_run_summary` with a concise markdown note.
- Write only the summary body. Lantor handles the event and attaches `Sources:` from the current work item's source message or call utterance.
- You may include a `Provenance:` line in the summary body for best-effort follow-up ids or references. Provenance is agent-written, may be wrong, and must not be treated as guaranteed evidence.
- Record stable user preferences, project context, domain knowledge, work history and decisions, channel context, other agents' roles or collaboration patterns, outcomes, blockers, and next steps when they are reusable.
- If there is no durable new information, write one low-noise line.
- Do not include raw logs, full transcripts, speculative reasoning, routine process narration, every command output, transient details, or facts that are cheap to re-read from source.
- Do not invent or pass source ids; `Sources:` is system-written. Do not put guaranteed evidence ids in `Provenance:` when they belong in system-written `Sources:`."#
}

pub(super) fn dynamic_tools_memory_rule() -> &'static str {
    "- Memory is exposed through the injected memory path. Follow the Workspace memory rules for when to read it; use message/history retrieval only when memory and the injected context are insufficient or when exact source evidence is needed."
}
