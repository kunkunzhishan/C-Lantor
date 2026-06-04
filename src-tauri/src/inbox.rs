use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};
use uuid::Uuid;

use crate::publish_guard::inbox_payload_with_base_thread_version;
use crate::{
    compact_chars_middle, prompts, short_id, CommandResult, DISPATCH_MESSAGE_BODY_LIMIT,
    INBOX_WAKE_BATCH_LIMIT, INBOX_WAKE_OTHER_SUMMARY_LIMIT,
};

pub(crate) struct AgentInboxItemInput<'a> {
    pub(crate) agent_id: Uuid,
    pub(crate) channel_id: Option<Uuid>,
    pub(crate) thread_root_id: Option<Uuid>,
    pub(crate) source_message_id: Option<Uuid>,
    pub(crate) task_id: Option<Uuid>,
    pub(crate) kind: &'a str,
    pub(crate) priority: i32,
    pub(crate) title: &'a str,
    pub(crate) body_preview: &'a str,
    pub(crate) payload: Value,
}

#[derive(Clone)]
pub(crate) struct InboxWakeItem {
    pub(crate) id: Uuid,
    pub(crate) channel_id: Option<Uuid>,
    pub(crate) channel_name: Option<String>,
    pub(crate) channel_description: Option<String>,
    pub(crate) channel_kind: Option<String>,
    pub(crate) thread_root_id: Option<Uuid>,
    pub(crate) source_message_id: Option<Uuid>,
    pub(crate) task_id: Option<Uuid>,
    pub(crate) kind: String,
    pub(crate) priority: i32,
    pub(crate) title: String,
    pub(crate) body_preview: String,
    pub(crate) payload: String,
    pub(crate) message_created_at: Option<DateTime<Utc>>,
    pub(crate) sender_name: Option<String>,
    pub(crate) sender_role: Option<String>,
}

impl InboxWakeItem {
    pub(crate) fn target(&self) -> String {
        format_inbox_target(
            self.channel_kind.as_deref(),
            self.channel_name.as_deref(),
            self.thread_root_id,
        )
    }

    pub(crate) fn message_header(&self) -> String {
        let msg = self
            .source_message_id
            .map(short_id)
            .unwrap_or_else(|| short_id(self.id));
        let time = self
            .message_created_at
            .map(|time| time.to_rfc3339())
            .unwrap_or_else(|| "-".to_owned());
        let sender_role = self.sender_role.as_deref().unwrap_or("unknown");
        let sender = self
            .sender_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("unknown");
        let preview = compact_chars_middle(&self.body_preview, DISPATCH_MESSAGE_BODY_LIMIT)
            .replace('\n', " ");
        format!(
            "[target={} msg={} time={} type={}] {}: {}",
            self.target(),
            msg,
            time,
            sender_role,
            sender,
            preview
        )
    }

    fn context_detail_lines(&self) -> Vec<String> {
        if self.kind != "interrupted_action" {
            return Vec::new();
        }
        let Ok(payload) = serde_json::from_str::<Value>(&self.payload) else {
            return Vec::new();
        };
        let allowed_actions: Vec<String> = payload
            .get("allowed_actions")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|| {
                vec![
                    "revise".to_owned(),
                    "yield".to_owned(),
                    "force_send".to_owned(),
                ]
            });
        let can_revise = allowed_actions.iter().any(|action| action == "revise");
        let mut lines = vec![
            "   interrupted_action: agent-only recovery for held public output.".to_owned(),
            "   decision: resolve this yourself using allowed_actions; do not ask the user to choose.".to_owned(),
        ];
        for key in [
            "reason",
            "stream_key",
            "interrupted_action",
            "action_kind",
            "base_version",
            "current_version",
            "base_thread_version",
        ] {
            if let Some(value) = payload.get(key) {
                lines.push(format!("   {key}: {}", compact_payload_value(value, 512)));
            }
        }
        if let Some(actions) = payload.get("allowed_actions") {
            lines.push(format!(
                "   allowed_actions: {}",
                compact_payload_value(actions, 512)
            ));
        }
        if let Some(draft) = payload.get("draft_body").and_then(Value::as_str) {
            lines.push(format!(
                "   draft_body: {}",
                compact_chars_middle(draft, DISPATCH_MESSAGE_BODY_LIMIT).replace('\n', "\\n")
            ));
        }
        if let Some(events) = payload.get("held_visible_events").and_then(Value::as_array) {
            lines.push(format!("   held_visible_events_count: {}", events.len()));
        }
        lines.push("   protocol: for yield or force_send, emit LANTOR_EVENT {\"type\":\"interrupted_action_resolve\",\"stream_key\":\"<stream_key>\",\"action\":\"yield|force_send\"} and do not also post a normal reply.".to_owned());
        if can_revise {
            lines.push("   protocol: prefer revise for stale public replies when it is allowed; emit LANTOR_EVENT {\"type\":\"interrupted_action_resolve\",\"stream_key\":\"<stream_key>\",\"action\":\"revise\"}, then continue with the revised visible reply in this same turn.".to_owned());
        } else {
            lines.push("   protocol: revise is not allowed for this interruption (no draft reply to rewrite); resolve with yield or force_send yourself.".to_owned());
        }
        lines
    }
}

fn compact_payload_value(value: &Value, limit: usize) -> String {
    let rendered = match value {
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    };
    compact_chars_middle(&rendered, limit).replace('\n', "\\n")
}

pub(crate) struct InboxWakeSummary {
    pub(crate) target: String,
    pub(crate) count: i64,
}

pub(crate) async fn create_agent_inbox_item(
    pool: &SqlitePool,
    input: AgentInboxItemInput<'_>,
) -> CommandResult<Uuid> {
    let payload = if input.kind == "call_mode" {
        input.payload.clone()
    } else {
        inbox_payload_with_base_thread_version(
            pool,
            &input.payload,
            input.channel_id,
            input.thread_root_id,
        )
        .await?
    };
    if let Some(source_message_id) = input.source_message_id {
        let existing_id: Option<Uuid> = sqlx::query_scalar(
            r#"
            select id
            from agent_inbox_items
            where agent_id = $1 and source_message_id = $2 and kind = $3
            limit 1
            "#,
        )
        .bind(input.agent_id)
        .bind(source_message_id)
        .bind(input.kind)
        .fetch_optional(pool)
        .await
        .map_err(|err| err.to_string())?;
        if let Some(existing_id) = existing_id {
            sqlx::query(
                r#"
                update agent_inbox_items
                set channel_id = $2,
                    thread_root_id = $3,
                    task_id = $4,
                    priority = max(priority, $5),
                    state = case when state = 'archived' then 'unread' else state end,
                    title = $6,
                    body_preview = $7,
                    payload = $8,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now'),
                    archived_at = case when state = 'archived' then null else archived_at end
                where id = $1
                "#,
            )
            .bind(existing_id)
            .bind(input.channel_id)
            .bind(input.thread_root_id)
            .bind(input.task_id)
            .bind(input.priority)
            .bind(input.title)
            .bind(compact_chars_middle(
                input.body_preview,
                DISPATCH_MESSAGE_BODY_LIMIT,
            ))
            .bind(payload.to_string())
            .execute(pool)
            .await
            .map_err(|err| err.to_string())?;
            return Ok(existing_id);
        }
    }

    let inbox_item_id: Uuid = sqlx::query_scalar(
        r#"
        insert into agent_inbox_items (
            agent_id, channel_id, thread_root_id, source_message_id, task_id,
            kind, priority, state, title, body_preview, payload
        )
        values ($1, $2, $3, $4, $5, $6, $7, 'unread', $8, $9, $10)
        returning id
        "#,
    )
    .bind(input.agent_id)
    .bind(input.channel_id)
    .bind(input.thread_root_id)
    .bind(input.source_message_id)
    .bind(input.task_id)
    .bind(input.kind)
    .bind(input.priority)
    .bind(input.title)
    .bind(compact_chars_middle(
        input.body_preview,
        DISPATCH_MESSAGE_BODY_LIMIT,
    ))
    .bind(payload.to_string())
    .fetch_one(pool)
    .await
    .map_err(|err| err.to_string())?;
    Ok(inbox_item_id)
}

pub(crate) async fn attach_work_item_to_inbox(
    pool: &SqlitePool,
    inbox_item_id: Uuid,
    work_item_id: Uuid,
) -> CommandResult<()> {
    attach_work_item_to_inboxes(pool, &[inbox_item_id], work_item_id).await
}

pub(crate) async fn attach_work_item_to_inboxes(
    pool: &SqlitePool,
    inbox_item_ids: &[Uuid],
    work_item_id: Uuid,
) -> CommandResult<()> {
    if inbox_item_ids.is_empty() {
        return Ok(());
    }
    for inbox_item_id in inbox_item_ids {
        sqlx::query(
            r#"
            update agent_inbox_items
            set work_item_id = $2,
                state = 'processing',
                updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now'),
                archived_at = null
            where id = $1
            "#,
        )
        .bind(*inbox_item_id)
        .bind(work_item_id)
        .execute(pool)
        .await
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn inbox_wake_item_from_row(row: &SqliteRow) -> InboxWakeItem {
    InboxWakeItem {
        id: row.get("id"),
        channel_id: row.get("channel_id"),
        channel_name: row.get("channel_name"),
        channel_description: row.get("channel_description"),
        channel_kind: row.get("channel_kind"),
        thread_root_id: row.get("thread_root_id"),
        source_message_id: row.get("source_message_id"),
        task_id: row.get("task_id"),
        kind: row.get("kind"),
        priority: row.get("priority"),
        title: row.get("title"),
        body_preview: row.get("body_preview"),
        payload: row.get("payload"),
        message_created_at: row.get("message_created_at"),
        sender_name: row.get("sender_name"),
        sender_role: row.get("sender_role"),
    }
}

pub(crate) async fn next_unread_inbox_wake_item(
    pool: &SqlitePool,
    agent_id: Uuid,
) -> CommandResult<Option<InboxWakeItem>> {
    let row = sqlx::query(
        r#"
        select
            i.id,
            i.channel_id,
            c.name as channel_name,
            c.description as channel_description,
            c.kind as channel_kind,
            i.thread_root_id,
            i.source_message_id,
            i.task_id,
            i.kind,
            i.priority,
            i.title,
            i.body_preview,
            i.payload,
            m.created_at as message_created_at,
            m.sender_name,
            m.sender_role
        from agent_inbox_items i
        left join channels c on c.id = i.channel_id
        left join messages m on m.id = i.source_message_id
        where i.agent_id = $1
          and i.state = 'unread'
        order by i.priority desc, i.created_at asc
        limit 1
        "#,
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await
    .map_err(|err| err.to_string())?;

    Ok(row.as_ref().map(inbox_wake_item_from_row))
}

pub(crate) async fn load_unread_inbox_wake_batch(
    pool: &SqlitePool,
    agent_id: Uuid,
    channel_id: Option<Uuid>,
    thread_root_id: Option<Uuid>,
) -> CommandResult<Vec<InboxWakeItem>> {
    let rows = sqlx::query(
        r#"
        select
            i.id,
            i.channel_id,
            c.name as channel_name,
            c.description as channel_description,
            c.kind as channel_kind,
            i.thread_root_id,
            i.source_message_id,
            i.task_id,
            i.kind,
            i.priority,
            i.title,
            i.body_preview,
            i.payload,
            m.created_at as message_created_at,
            m.sender_name,
            m.sender_role
        from agent_inbox_items i
        left join channels c on c.id = i.channel_id
        left join messages m on m.id = i.source_message_id
        where i.agent_id = $1
          and i.state = 'unread'
          and i.channel_id is not distinct from $2
          and i.thread_root_id is not distinct from $3
        order by i.priority desc, i.created_at asc
        limit $4
        "#,
    )
    .bind(agent_id)
    .bind(channel_id)
    .bind(thread_root_id)
    .bind(INBOX_WAKE_BATCH_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())?;

    Ok(rows.iter().map(inbox_wake_item_from_row).collect())
}

pub(crate) async fn load_inbox_wake_items_for_work_item(
    pool: &SqlitePool,
    work_item_id: Uuid,
) -> CommandResult<Vec<InboxWakeItem>> {
    let rows = sqlx::query(
        r#"
        select
            i.id,
            i.channel_id,
            c.name as channel_name,
            c.description as channel_description,
            c.kind as channel_kind,
            i.thread_root_id,
            i.source_message_id,
            i.task_id,
            i.kind,
            i.priority,
            i.title,
            i.body_preview,
            i.payload,
            m.created_at as message_created_at,
            m.sender_name,
            m.sender_role
        from agent_inbox_items i
        left join channels c on c.id = i.channel_id
        left join messages m on m.id = i.source_message_id
        where i.work_item_id = $1
        order by i.priority desc, i.created_at asc
        "#,
    )
    .bind(work_item_id)
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())?;

    Ok(rows.iter().map(inbox_wake_item_from_row).collect())
}

pub(crate) async fn load_other_active_inbox_summary(
    pool: &SqlitePool,
    agent_id: Uuid,
    channel_id: Option<Uuid>,
    thread_root_id: Option<Uuid>,
) -> CommandResult<Vec<InboxWakeSummary>> {
    let rows = sqlx::query(
        r#"
        select
            i.channel_id,
            c.name as channel_name,
            c.kind as channel_kind,
            i.thread_root_id,
            count(*) as item_count,
            max(i.priority) as max_priority,
            min(i.created_at) as oldest_created_at
        from agent_inbox_items i
        left join channels c on c.id = i.channel_id
        where i.agent_id = $1
          and i.state in ('unread', 'processing')
          and not (
              i.channel_id is not distinct from $2
              and i.thread_root_id is not distinct from $3
          )
        group by i.channel_id, c.name, c.kind, i.thread_root_id
        order by max_priority desc, oldest_created_at asc
        limit $4
        "#,
    )
    .bind(agent_id)
    .bind(channel_id)
    .bind(thread_root_id)
    .bind(INBOX_WAKE_OTHER_SUMMARY_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let channel_name: Option<String> = row.get("channel_name");
            let channel_kind: Option<String> = row.get("channel_kind");
            let thread_root_id: Option<Uuid> = row.get("thread_root_id");
            InboxWakeSummary {
                target: format_inbox_target(
                    channel_kind.as_deref(),
                    channel_name.as_deref(),
                    thread_root_id,
                ),
                count: row.get("item_count"),
            }
        })
        .collect())
}

pub(crate) async fn find_queued_inbox_wake_work_item_for_surface(
    pool: &SqlitePool,
    agent_id: Uuid,
    channel_id: Option<Uuid>,
    thread_root_id: Option<Uuid>,
) -> CommandResult<Option<Uuid>> {
    sqlx::query_scalar(
        r#"
        select id
        from agent_work_items
        where agent_id = $1
          and source_kind = 'inbox_wake'
          and status = 'queued'
          and channel_id is not distinct from $2
          and thread_root_id is not distinct from $3
        order by created_at asc
        limit 1
        "#,
    )
    .bind(agent_id)
    .bind(channel_id)
    .bind(thread_root_id)
    .fetch_optional(pool)
    .await
    .map_err(|err| err.to_string())
}

pub(crate) fn format_inbox_target(
    channel_kind: Option<&str>,
    channel_name: Option<&str>,
    thread_root_id: Option<Uuid>,
) -> String {
    match (channel_kind, channel_name, thread_root_id) {
        (Some("dm"), Some(name), Some(thread_root_id)) => {
            format!("dm:{name}:{}", short_id(thread_root_id))
        }
        (Some("dm"), Some(name), None) => format!("dm:{name}"),
        (_, Some(name), Some(thread_root_id)) => format!("#{name}:{}", short_id(thread_root_id)),
        (_, Some(name), None) => format!("#{name}"),
        _ => "unknown target".to_owned(),
    }
}

pub(crate) fn inbox_wake_work_item_title(items: &[InboxWakeItem]) -> String {
    let Some(primary) = items.first() else {
        return "Process inbox".to_owned();
    };
    if items.len() == 1 {
        format!("Process inbox: {}", primary.title)
    } else {
        format!(
            "Process inbox: {} (+{} more)",
            primary.title,
            items.len() - 1
        )
    }
}

pub(crate) fn inbox_wake_context(
    items: &[InboxWakeItem],
    other_active: &[InboxWakeSummary],
) -> String {
    let Some(primary) = items.first() else {
        return "Lantor agent inbox wake.".to_owned();
    };
    let target = primary.target();
    let has_task_available = items.iter().any(|item| item.kind == "task_available");
    let mut lines = vec![
        "Lantor agent inbox wake.".to_owned(),
        if items.len() == 1 {
            "The default inbox item below is already selected for this turn. Handle it directly from this context when enough detail is present.".to_owned()
        } else {
            format!(
                "This turn batches {} inbox items from the same channel/thread target. Handle them together when possible.",
                items.len()
            )
        },
        "The message headers below include target, source message id, created time, sender type/name, and preview. Handle directly from them when enough detail is present.".to_owned(),
        "Warm-runtime guard: the inbox item and its thread are authoritative over older context from other channels or tasks.".to_owned(),
        prompts::inbox::thread_followup_context_rule().to_owned(),
        "Use \"$LANTOR_CONTEXT_TOOL\" --agent-context-tool inbox-read --inbox-id <id> only if the preview/header is insufficient and you need a full source message or metadata.".to_owned(),
        "Use \"$LANTOR_CONTEXT_TOOL\" --agent-context-tool inbox-list --state active --limit 20 only if you need to inspect or choose among other active inbox items.".to_owned(),
        "Current work-item inbox item(s) are archived automatically when this work item finishes; use inbox-archive only for unrelated or extra active items you intentionally clear.".to_owned(),
        String::new(),
        format!("Default reply target for normal assistant text: {target}"),
        "If you handle another inbox item in this same turn with a different target, post to that item's channel/thread with channel_message_create instead of relying on the default route.".to_owned(),
        String::new(),
    ];
    if has_task_available {
        lines.extend([
            "Task claim opportunity mode:".to_owned(),
            "- This is a competitive, unassigned task opportunity sent to multiple agents.".to_owned(),
            "- If you can start now, emit only the standalone `LANTOR_EVENT {\"type\":\"task_claim\",\"task_number\":...}` control line, then finish with `LANTOR_SILENT_REPLY: claim attempted`.".to_owned(),
            "- Do not post a visible reply, do not narrate that you are queued/starting, and do not emit activity events for the claim attempt.".to_owned(),
            "- Lantor atomically accepts one claimant, ignores stale claims, and will send a separate task_assigned inbox turn to the winning agent to do the work visibly.".to_owned(),
            String::new(),
        ]);
    }

    if items.len() == 1 {
        lines.push("Default inbox item:".to_owned());
    } else {
        lines.push("Batched inbox items:".to_owned());
    }
    for (index, item) in items.iter().enumerate() {
        if items.len() > 1 {
            lines.push(format!("{}. {}", index + 1, item.message_header()));
        } else {
            lines.push(item.message_header());
        }
        lines.push(format!("   inbox_id: {}", item.id));
        lines.push(format!(
            "   kind: {}, priority: {}, title: {}",
            item.kind, item.priority, item.title
        ));
        lines.extend(item.context_detail_lines());
        if index + 1 < items.len() {
            lines.push(String::new());
        }
    }

    if !other_active.is_empty() {
        lines.push(String::new());
        lines.push("Other active inbox targets:".to_owned());
        for summary in other_active {
            lines.push(format!("- {}: {} active", summary.target, summary.count));
        }
        lines.push("Stay focused on the selected item(s) above unless another active target is clearly higher priority.".to_owned());
    }

    lines.join("\n")
}

pub(crate) fn build_steer_followup_prompt(items: &[InboxWakeItem]) -> String {
    let Some(primary) = items.first() else {
        return "Same-channel/thread live inbox follow-up.".to_owned();
    };
    let target = primary.target();
    let mut lines = vec![
        "Same-channel/thread live inbox follow-up.".to_owned(),
        "Treat the message header(s) below as newer input for the active turn.".to_owned(),
        "If the latest owner message explicitly mentions another agent and does not mention you, stop that newly assigned work and reply silently unless directly asked to acknowledge.".to_owned(),
        format!("Default reply target for normal assistant text: {target}"),
    ];
    if let Some(channel_description) = primary
        .channel_description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("channel_description: {channel_description}"));
    }
    lines.extend([
        "Current work-item inbox item(s) are archived automatically when the active turn finishes; use inbox-archive only for unrelated or extra active items you intentionally clear.".to_owned(),
        String::new(),
    ]);

    if items.len() == 1 {
        lines.push("New inbox message:".to_owned());
    } else {
        lines.push("New inbox messages:".to_owned());
    }
    for (index, item) in items.iter().enumerate() {
        if items.len() > 1 {
            lines.push(format!("{}. {}", index + 1, item.message_header()));
        } else {
            lines.push(item.message_header());
        }
        lines.push(format!("   inbox_id: {}", item.id));
        lines.extend(item.context_detail_lines());
        if index + 1 < items.len() {
            lines.push(String::new());
        }
    }

    lines.join("\n")
}

pub(crate) fn prepend_inbox_context(inbox_item_id: Uuid, kind: &str, context: &str) -> String {
    let mut lines = vec![
        "Agent inbox item:".to_owned(),
        format!("id: {inbox_item_id}"),
        format!("kind: {kind}"),
        "decision: decide whether this inbox item needs a visible reply, a task claim/create, a reminder, a handoff, or a silent_reply.".to_owned(),
    ];
    if !context.trim().is_empty() {
        lines.push(String::new());
        lines.push(context.trim().to_owned());
    }
    lines.join("\n")
}
