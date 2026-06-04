pub(super) fn memory_management_prompt() -> &'static str {
    r#"Workspace memory:
- Your working directory is your persistent agent-owned workspace. Files there survive across turns and runtime restarts; use it for artifacts, code checkouts, and Lantor-managed `memory/**/*.md` files.
- Realtime memory is a time-ordered append-only segment log under `memory/realtime/<number>.md`. Lantor writes the newest segment until it reaches the size limit, then opens the next numbered segment. When enough old segments accumulate, an async event-ingest job can preserve the newest segments and move older segment content into long-term event memory.
- `memory_run_summary` is an agent-emitted event that writes one concise realtime entry. The agent emits the event and writes only the summary body; Lantor handles that event, calls the memory writer, and automatically attaches `Sources:` from the current work item's source message or call utterance. If useful, the agent may include a `Provenance:` line in the body as best-effort follow-up context. Do not include raw logs, full transcripts, or routine process narration.
- Durable event memory is file-backed markdown under `memory/events/`. It has no manifest; agents read memory files directly from the injected memory path.
- Memory is an important context source; except for extremely simple tasks that require no context, check memory.
- Current injected turn/thread context is the newest fact source. Memory is the default source for older durable context. `Sources:` and message/history tools are for exact source verification, evidence retrieval, or conflict resolution; do not use message search as the default memory recovery path.
- Actively observe and record stable user preferences, project context, domain knowledge, work history and decisions, channel context, and other agents' roles or collaboration patterns.
- Do not memorize transient reasoning, every chat turn, raw logs, command transcripts, or one-off intermediate details. Prefer current source, current messages, and explicit user instructions over stale memory when they conflict.

Memory operation procedure:
1. Use the injected memory path or current thread context before relying on user recollection when prior context matters. Use history-read/message-search only when memory is insufficient, exact wording is needed, `Sources:` must be verified, or current messages conflict with memory.
2. At the end of every run, the agent should emit `memory_run_summary` with a short markdown note. Prefer 2-5 bullets or a short paragraph when there is reusable continuity; if there is no durable new information, write a one-line low-noise summary saying that. Do not invent or pass source ids; `Sources:` is system-written.
3. Long-term event memory is maintained by event ingestion from older realtime segments; do not treat realtime segments as durable event memory after they are ingested.
4. Keep generated memory concise and reusable. Do not store secrets, full raw logs, speculative reasoning, every command output, or facts that are cheap to re-read from source."#
}

pub(super) fn dynamic_tools_memory_rule() -> &'static str {
    "- Memory is exposed through the injected memory path. Read files under that path directly when the user refers to prior discussion, earlier decisions, \"上面\", \"之前\", \"继续\", \"这个方案\", files, blockers, or task state that may not be fully present in the current prompt. Do not ask the user to repeat context before checking memory. Use message/history retrieval only when memory and the injected context are insufficient or when exact source evidence is needed."
}
