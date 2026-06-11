use super::memory;

pub(super) fn context_tools_prompt() -> &'static str {
    r##"Agent context tools:
- inbox list: "$LANTOR_CONTEXT_TOOL" --agent-context-tool inbox-list --state active --limit 20
- inbox read: "$LANTOR_CONTEXT_TOOL" --agent-context-tool inbox-read --inbox-id "<uuid-or-prefix>"
- inbox archive: "$LANTOR_CONTEXT_TOOL" --agent-context-tool inbox-archive --inbox-id "<uuid-or-prefix>"
- workspace info: "$LANTOR_CONTEXT_TOOL" --agent-context-tool workspace-info
- workspace files: "$LANTOR_CONTEXT_TOOL" --agent-context-tool workspace-list --max-depth 2 --limit 80
- history: "$LANTOR_CONTEXT_TOOL" --agent-context-tool history-read --target "#channel[:thread_id]" --limit 20
- search: "$LANTOR_CONTEXT_TOOL" --agent-context-tool message-search --query "text" --target "#channel" --limit 20
- attachment: "$LANTOR_CONTEXT_TOOL" --agent-context-tool attachment-info --attachment-id "<uuid>"
- artifact: "$LANTOR_CONTEXT_TOOL" --agent-context-tool artifact-read --artifact-id "<uuid>"
- run: "$LANTOR_CONTEXT_TOOL" --agent-context-tool run-read --run-id "<uuid-or-prefix>" --limit 12000
- agent introspection: "$LANTOR_CONTEXT_TOOL" --agent-context-tool agent-inspect --target "@handle"
- long task create: "$LANTOR_CONTEXT_TOOL" --agent-context-tool long-task-create --workspace "<absolute target project path>" --title "<short title>" --task "<full instruction>" [--funder-mode worker|founder]
- long task list: "$LANTOR_CONTEXT_TOOL" --agent-context-tool long-task-list
- long task inspect/control: "$LANTOR_CONTEXT_TOOL" --agent-context-tool long-task-inspect --task-id "lt_xxx"; use long-task-monitor, long-task-steer, long-task-approve, long-task-reject, long-task-approval, or long-task-stop with the same --task-id when needed.
Inbox and workspace commands default to your own LANTOR_AGENT_ID; add --target "@handle" only when inspecting another visible agent.
For long tasks, ask clarifying questions first, then create only after you can provide workspace, title, and a complete task instruction. Before using long-task-steer, ask the user for explicit confirmation in the current thread. Refer to existing long tasks by Lantor task id, not by workspace, and do not read or edit .agent2long files directly.
Inbox, history, and search message rows use `[target=... msg=... time=... type=...] sender: body` headers. The target is the message surface, and msg is the short source message id.
When a turn contains a default inbox item or source_message, handle that item directly from the provided context when possible. Use inbox-list or inbox-read when you need missing details, need to choose among multiple active items, or are handling a different item. Current work-item inbox items are archived automatically when this work item finishes; use inbox-archive only for unrelated or extra active items you intentionally clear."##
}

pub(super) fn dynamic_tools_prompt() -> String {
    [
        "Lantor dynamic tools:",
        "- Codex runtimes may have these app-server dynamic tools pre-registered at thread/start. They are direct tool calls, not deferred tools discovered through `tool_search`.",
        "- `lantor.search_tools`: list the available Lantor Codex tools. It returns tool ids, descriptions, schemas, side effects, display hints, and examples for `lantor.call_tool`; use the returned list to decide which tool fits the request.",
        "- `lantor.call_tool`: execute a Lantor Codex tool by `tool_id` with structured `arguments`.",
        "- Prefer `lantor.search_tools` followed by `lantor.call_tool` for Lantor Codex tools. Do not call Codex `tool_search` first for these names; `tool_search` searches Codex deferred tools and will not list Lantor dynamic tools.",
        memory::dynamic_tools_memory_rule(),
    ]
    .join("\n")
}

pub(super) fn control_api_prompt() -> &'static str {
    r#"Standalone LANTOR_EVENT control lines:
LANTOR_EVENT {"type":"activity","kind":"thinking|command|file_edit|tools|acting","title":"<short user-facing status>","detail":"<optional compact detail>"}
LANTOR_EVENT {"type":"usage","input_tokens":1234,"output_tokens":567,"cost_usd":0.0123}
LANTOR_EVENT {"type":"memory_run_summary","title":"<short title>","body":"<concise markdown realtime note>"}
LANTOR_EVENT {"type":"profile_update","display_name":"<optional>","role":"<optional concise role>","avatar":"<optional emoji, initials, URL, or dicebear:style[:seed]>","description":"<optional capability summary>"}
LANTOR_EVENT {"type":"owner_profile_update","display_name":"<optional>","avatar":"<optional emoji, initials, URL, or dicebear:style[:seed]>","description":"<optional>"}
LANTOR_EVENT {"type":"reminder_create","when":"<ISO8601 timestamp>","title":"<title>","note":"<optional note>","recurrence":"none|daily|weekly|every:20m"}
LANTOR_EVENT {"type":"reminder_cancel","reminder_id":"<uuid>"}
LANTOR_EVENT {"type":"hook_create","title":"<title>","code_body":"return request?.body?.ready === true;","hook_context":{},"external_resources":[{"kind":"github_webhook","id":"<provider id>","url":"<provider console url>","cleanup":"delete provider webhook when deleting this Lantor hook"}],"fixture_request":{"method":"POST","headers":{},"query":{},"body":{"ready":true}},"ingress_enabled":true,"scheduled":false,"schedule_cadence":"every:5m","next_run_at":"<ISO8601 optional>"}
LANTOR_EVENT {"type":"hook_delete","hook_id":"<uuid>"}
LANTOR_EVENT {"type":"task_create","channel_id":"<channel uuid>","title":"<short task title>","body":"<root task message>","thread_body":"<first execution update in the task thread>","assign_self":true,"status":"in_progress"}
LANTOR_EVENT {"type":"task_status","task_number":1,"status":"in_review"}
LANTOR_EVENT {"type":"task_claim","task_number":1}
LANTOR_EVENT {"type":"task_handoff","target_agent":"@OtherAgent","task_number":1,"reason":"<why the new assignee should continue>","body":"<optional visible note in the task thread>"}
LANTOR_EVENT {"type":"artifact_create","channel_id":"<channel uuid>","thread_root_id":"<optional uuid>","kind":"markdown","title":"<short title>","summary":"<short chat summary>","content":"<full markdown content>","metadata":{}}
LANTOR_EVENT {"type":"attachment_create","channel_id":"<channel uuid>","thread_root_id":"<optional uuid>","body":"<short message>","files":[{"path":"/absolute/path/to/image.png","name":"image.png","mime_type":"image/png"}]}
LANTOR_EVENT {"type":"channel_message_create","channel_id":"<channel uuid>","thread_root_id":"<optional uuid>","body":"<message body>"}
LANTOR_EVENT {"type":"handoff_create","target_agent":"@OtherAgent","channel_id":"<channel uuid>","thread_root_id":"<thread uuid>","reason":"<why this handoff is needed>","body":"<specific request for the target agent>"}
LANTOR_EVENT {"type":"interrupted_action_resolve","stream_key":"<held stream_key>","action":"yield|revise|force_send"}
LANTOR_EVENT {"type":"channel_create","name":"short-topic","description":"<why this channel exists>","agent_handles":["@OtherAgent"]}
LANTOR_EVENT {"type":"channel_invite","channel":"existing-channel","agent_handles":["@OtherAgent"]}
For activity events, write title/detail as user-facing progress, for example: title='Reading the stream parser', detail='I am checking where control lines become inline progress before changing the prompt contract.'
For profile_update avatar, you may use emoji/initials, an image URL, or a DiceBear spec like `dicebear:dylan:Hancock`. Choose a stable seed from your handle or memory. Generated DiceBear profile avatars should use the dylan style. Use owner_profile_update only when the owner explicitly asks you to update their profile or avatar.
Use task_create only for durable globally tracked work. Use task_claim only when you received an unassigned task opportunity and can start it now; for those competitive claim opportunities, emit the hidden task_claim control line first and avoid visible replies/activity until Lantor sends you the follow-up task_assigned turn. Lantor accepts at most one claimant atomically and ignores stale claims without chat noise. Use task_handoff when you are the current task assignee and need to transfer an active task to another agent with a reason; omit task_number only when the current turn is tied to the task. Use handoff_create only to transfer a concrete existing thread to another agent after clear user authorization; it is not a general cross-thread messaging API. Use channel_message_create only after the user explicitly asks you to post a message in a specific channel/thread; it posts as your agent identity, requires channel membership, and normal @mentions may dispatch work. Use interrupted_action_resolve only when the inbox item is an interrupted_action; resolve it yourself using one of the item's allowed_actions and do not ask the user to decide. Prefer revise for stale public replies when allowed, use yield for obsolete outputs, and reserve force_send for explicit/debug cases. Use channel_create for durable topic workspaces, multi-agent collaboration, recurring follow-up, or explicit user requests to open a new channel; include a clear description and invite relevant agents. Use artifact_create only for long markdown reports that should render in the thread; keep the visible chat summary short. Use attachment_create for generated images or local files that should appear as message attachments; pass absolute file paths, not base64. Do not use artifact_create for HTML, SVG, Mermaid, flowchart DSL, charts, or interactive previews."#
}
