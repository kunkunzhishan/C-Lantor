use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::CommandResult;

pub(crate) fn mask_markdown_code_for_mentions(body: &str) -> String {
    let mut masked = String::with_capacity(body.len());
    let mut in_fenced_code = false;
    let mut fence_marker = "";

    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let is_backtick_fence = trimmed.starts_with("```");
        let is_tilde_fence = trimmed.starts_with("~~~");
        let starts_active_fence = !fence_marker.is_empty() && trimmed.starts_with(fence_marker);

        if in_fenced_code {
            masked.extend(line.chars().map(|ch| if ch == '\n' { '\n' } else { ' ' }));
            if starts_active_fence {
                in_fenced_code = false;
                fence_marker = "";
            }
            continue;
        }

        if is_backtick_fence || is_tilde_fence {
            fence_marker = if is_backtick_fence { "```" } else { "~~~" };
            in_fenced_code = true;
            masked.extend(line.chars().map(|ch| if ch == '\n' { '\n' } else { ' ' }));
            continue;
        }

        let mut in_inline_code = false;
        let mut quote_until: Option<char> = None;
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            if let Some(end_quote) = quote_until {
                masked.push(' ');
                if ch == end_quote {
                    quote_until = None;
                }
                continue;
            }
            if ch == '`' {
                masked.push(' ');
                while chars.peek().copied() == Some('`') {
                    chars.next();
                    masked.push(' ');
                }
                in_inline_code = !in_inline_code;
                continue;
            }
            if !in_inline_code {
                let end_quote = match ch {
                    '"' => Some('"'),
                    '“' => Some('”'),
                    '‘' => Some('’'),
                    _ => None,
                };
                if let Some(end_quote) = end_quote {
                    quote_until = Some(end_quote);
                    masked.push(' ');
                    continue;
                }
            }
            masked.push(if in_inline_code && ch != '\n' {
                ' '
            } else {
                ch
            });
        }
    }

    masked
}

pub(crate) fn extract_agent_mentions(body: &str) -> Vec<String> {
    let mut handles = Vec::new();
    let searchable = mask_markdown_code_for_mentions(body);
    let mut chars = searchable.char_indices().peekable();
    while let Some((idx, ch)) = chars.next() {
        if ch != '@' {
            continue;
        }
        if searchable[..idx]
            .chars()
            .next_back()
            .map(|prev| prev.is_ascii_alphanumeric() || prev == '_' || prev == '-')
            .unwrap_or(false)
        {
            continue;
        }
        let mut handle = String::new();
        while let Some((_, next)) = chars.peek().copied() {
            if next.is_ascii_alphanumeric() || next == '_' || next == '-' {
                handle.push(next);
                chars.next();
            } else {
                break;
            }
        }
        if !handle.is_empty() && !handles.contains(&handle) {
            handles.push(handle);
        }
    }
    handles
}

#[derive(Clone, Copy)]
pub(crate) enum MentionDispatchOrigin {
    Owner,
    Agent {
        sender_agent_id: Uuid,
        allow_channel_member_invite: bool,
    },
}

impl MentionDispatchOrigin {
    pub(crate) fn sender_agent_id(self) -> Option<Uuid> {
        match self {
            MentionDispatchOrigin::Owner => None,
            MentionDispatchOrigin::Agent {
                sender_agent_id, ..
            } => Some(sender_agent_id),
        }
    }

    pub(crate) fn allows_dm_auto_dispatch(self) -> bool {
        matches!(self, MentionDispatchOrigin::Owner)
    }

    pub(crate) fn is_agent(self) -> bool {
        matches!(self, MentionDispatchOrigin::Agent { .. })
    }

    pub(crate) fn allows_channel_member_invite(self) -> bool {
        match self {
            MentionDispatchOrigin::Owner => true,
            MentionDispatchOrigin::Agent {
                allow_channel_member_invite,
                ..
            } => allow_channel_member_invite,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DispatchKind {
    ChannelMessage,
    Mention,
    Dm,
    ThreadFollowUp,
}

pub(crate) async fn load_task_thread_followup_targets(
    pool: &SqlitePool,
    channel_id: Uuid,
    thread_root_id: Uuid,
) -> CommandResult<Vec<(Uuid, String)>> {
    let rows = sqlx::query(
        r#"
        select a.id, a.handle
        from tasks t
        join agents a on a.id = t.assignee_agent_id
        join channel_members cm on cm.channel_id = $1 and cm.agent_id = a.id
        where t.channel_id = $1
          and t.message_id = $2
          and t.assignee_agent_id is not null
          and a.status <> 'error'
        limit 1
        "#,
    )
    .bind(channel_id)
    .bind(thread_root_id)
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())?;

    Ok(rows
        .into_iter()
        .map(|row| (row.get("id"), row.get("handle")))
        .collect())
}

pub(crate) async fn load_agent_thread_followup_targets(
    pool: &SqlitePool,
    channel_id: Uuid,
    thread_root_id: Uuid,
) -> CommandResult<Vec<(Uuid, String)>> {
    let rows = sqlx::query(
        r#"
        with participants as (
            select distinct sender_agent_id as agent_id
            from messages
            where channel_id = $1
              and (id = $2 or thread_root_id = $2)
              and sender_agent_id is not null
        )
        select a.id, a.handle
        from participants p
        join agents a on a.id = p.agent_id
        join channel_members cm on cm.channel_id = $1 and cm.agent_id = a.id
        where exists (
              select 1
              from messages root
              where root.channel_id = $1
                and root.id = $2
                and root.thread_root_id is null
                and root.is_task = false
          )
          and a.status <> 'error'
        order by lower(a.handle)
        "#,
    )
    .bind(channel_id)
    .bind(thread_root_id)
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())?;

    Ok(rows
        .into_iter()
        .map(|row| (row.get("id"), row.get("handle")))
        .collect())
}

pub(crate) async fn load_channel_root_delivery_targets(
    pool: &SqlitePool,
    channel_id: Uuid,
) -> CommandResult<Vec<(Uuid, String)>> {
    let rows = sqlx::query(
        r#"
        select a.id, a.handle
        from channel_members cm
        join agents a on a.id = cm.agent_id
        where cm.channel_id = $1
          and a.status <> 'error'
        order by lower(a.handle)
        "#,
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get("id"), row.get("handle")))
        .collect())
}

pub(crate) async fn inter_agent_thread_message_count_since_last_owner(
    pool: &SqlitePool,
    channel_id: Uuid,
    thread_root_id: Uuid,
) -> CommandResult<i64> {
    let last_owner_created_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        r#"
        select max(created_at)
        from messages
        where channel_id = $1
          and (id = $2 or thread_root_id = $2)
          and sender_role = 'owner'
        "#,
    )
    .bind(channel_id)
    .bind(thread_root_id)
    .fetch_one(pool)
    .await
    .map_err(|err| err.to_string())?;

    let count = if let Some(last_owner_created_at) = last_owner_created_at {
        sqlx::query_scalar(
            r#"
            select count(*)
            from messages
            where channel_id = $1
              and (id = $2 or thread_root_id = $2)
              and sender_agent_id is not null
              and julianday(created_at) > julianday($3)
            "#,
        )
        .bind(channel_id)
        .bind(thread_root_id)
        .bind(last_owner_created_at)
        .fetch_one(pool)
        .await
        .map_err(|err| err.to_string())?
    } else {
        sqlx::query_scalar(
            r#"
            select count(*)
            from messages
            where channel_id = $1
              and (id = $2 or thread_root_id = $2)
              and sender_agent_id is not null
            "#,
        )
        .bind(channel_id)
        .bind(thread_root_id)
        .fetch_one(pool)
        .await
        .map_err(|err| err.to_string())?
    };
    Ok(count)
}
