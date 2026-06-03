use chrono::{DateTime, NaiveDate, Utc};
use sqlx::Row;
use sqlx::SqlitePool;

use crate::{events::notify_ui_tool_browser_open, to_string, tool_browser, CommandResult};

#[derive(Debug, Clone)]
pub(crate) struct ToolEvent {
    pub(crate) date: NaiveDate,
    pub(crate) time_label: String,
    pub(crate) title: String,
    pub(crate) kind: String,
    pub(crate) detail: String,
}

pub(crate) struct ToolHost<'a> {
    pool: &'a SqlitePool,
}

impl<'a> ToolHost<'a> {
    pub(crate) fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub(crate) async fn open_tool_view(&self, target: &str, source: &str) -> CommandResult<()> {
        let target = tool_browser::validate_tool_browser_target(target)?;
        notify_ui_tool_browser_open(self.pool, &target.url, source).await
    }

    pub(crate) async fn query_calendar_events(
        &self,
        start: NaiveDate,
        end: NaiveDate,
    ) -> CommandResult<Vec<ToolEvent>> {
        let start_at = format!("{}T00:00:00+00:00", start.format("%Y-%m-%d"));
        let end_at = format!("{}T23:59:59+00:00", end.format("%Y-%m-%d"));
        let reminder_rows = sqlx::query(
            r#"
            select
                r.title,
                r.note,
                r.status,
                r.recurrence,
                r.due_at,
                c.name as channel_name,
                a.handle as creator_agent_handle
            from reminders r
            left join channels c on c.id = r.channel_id
            left join agents a on a.id = r.creator_agent_id
            where r.status in ('scheduled', 'fired')
              and r.due_at >= $1
              and r.due_at <= $2
            order by r.due_at asc
            limit 100
            "#,
        )
        .bind(&start_at)
        .bind(&end_at)
        .fetch_all(self.pool)
        .await
        .map_err(to_string)?;

        let mut events = reminder_rows
            .into_iter()
            .map(|row| {
                let due_at: DateTime<Utc> = row.get("due_at");
                let title: String = row.get("title");
                let note: String = row.get("note");
                let status: String = row.get("status");
                let recurrence: String = row.get("recurrence");
                let channel_name: Option<String> = row.get("channel_name");
                let creator_agent_handle: Option<String> = row.get("creator_agent_handle");
                let detail = calendar_reminder_detail(
                    due_at,
                    &note,
                    &status,
                    &recurrence,
                    channel_name.as_deref(),
                    creator_agent_handle.as_deref(),
                );
                ToolEvent {
                    date: due_at.date_naive(),
                    time_label: due_at.format("%H:%M").to_string(),
                    title: if title.trim().is_empty() {
                        "Reminder".to_owned()
                    } else {
                        title.chars().take(48).collect()
                    },
                    kind: calendar_reminder_kind(&status, &recurrence).to_owned(),
                    detail,
                }
            })
            .collect::<Vec<_>>();

        let schedule_rows = sqlx::query(
            r#"
            select
                s.title,
                s.cadence,
                s.status,
                s.next_run_at,
                c.name as channel_name,
                a.handle as agent_handle
            from agent_schedules s
            join channels c on c.id = s.channel_id
            join agents a on a.id = s.agent_id
            where s.status in ('active', 'paused')
              and s.next_run_at >= $1
              and s.next_run_at <= $2
            order by s.next_run_at asc
            limit 100
            "#,
        )
        .bind(&start_at)
        .bind(&end_at)
        .fetch_all(self.pool)
        .await
        .map_err(to_string)?;

        events.extend(schedule_rows.into_iter().map(|row| {
            let next_run_at: DateTime<Utc> = row.get("next_run_at");
            let title: String = row.get("title");
            let cadence: String = row.get("cadence");
            let status: String = row.get("status");
            let channel_name: String = row.get("channel_name");
            let agent_handle: String = row.get("agent_handle");
            ToolEvent {
                date: next_run_at.date_naive(),
                time_label: next_run_at.format("%H:%M").to_string(),
                title: if title.trim().is_empty() {
                    "Agent schedule".to_owned()
                } else {
                    title.chars().take(48).collect()
                },
                kind: if status == "paused" {
                    "schedule-paused".to_owned()
                } else {
                    "schedule".to_owned()
                },
                detail: calendar_schedule_detail(
                    next_run_at,
                    &cadence,
                    &status,
                    &channel_name,
                    &agent_handle,
                ),
            }
        }));
        events.sort_by_key(|event| (event.date, event.time_label.clone()));
        Ok(events.into_iter().take(160).collect())
    }
}

fn calendar_schedule_detail(
    next_run_at: DateTime<Utc>,
    cadence: &str,
    status: &str,
    channel_name: &str,
    agent_handle: &str,
) -> String {
    let mut parts = vec![format!("Next {}", next_run_at.format("%H:%M UTC"))];
    parts.push(format!("schedule {status}"));
    if !cadence.trim().is_empty() {
        parts.push(cadence.trim().chars().take(40).collect());
    }
    if !channel_name.trim().is_empty() {
        parts.push(format!("#{channel_name}"));
    }
    if !agent_handle.trim().is_empty() {
        parts.push(format!("@{agent_handle}"));
    }
    parts.join(" · ")
}

fn calendar_reminder_kind(status: &str, recurrence: &str) -> &'static str {
    if status == "fired" {
        "fired"
    } else if recurrence != "none" {
        "repeat"
    } else {
        "reminder"
    }
}

fn calendar_reminder_detail(
    due_at: DateTime<Utc>,
    note: &str,
    status: &str,
    recurrence: &str,
    channel_name: Option<&str>,
    creator_agent_handle: Option<&str>,
) -> String {
    let mut parts = vec![format!("Due {}", due_at.format("%H:%M UTC"))];
    if status == "fired" {
        parts.push("fired".to_owned());
    }
    if recurrence != "none" {
        parts.push(format!("repeats {recurrence}"));
    }
    if let Some(channel_name) = channel_name.filter(|value| !value.trim().is_empty()) {
        parts.push(format!("#{channel_name}"));
    }
    if let Some(handle) = creator_agent_handle.filter(|value| !value.trim().is_empty()) {
        parts.push(format!("@{handle}"));
    }
    if !note.trim().is_empty() {
        parts.push(note.trim().chars().take(80).collect());
    }
    parts.join(" · ")
}
