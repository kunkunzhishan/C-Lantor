use std::path::Path;

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Value};
use sqlx::Row;
use sqlx::SqlitePool;

use crate::{
    events::notify_ui_tool_browser_open,
    to_string, tool_browser,
    tools::monitoring::{empty_monitoring_summary, monitoring_since},
    CommandResult,
};

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

    pub(crate) async fn query_monitoring_summary(
        &self,
        scope: &str,
        agent: Option<&str>,
        window: &str,
        limit: usize,
    ) -> CommandResult<Value> {
        let since = monitoring_since(window);
        let limit = limit.clamp(1, 25) as i64;
        let scope = match scope {
            "agent" => "agent",
            "compare" => "compare",
            _ => "global",
        };
        let mut summary = empty_monitoring_summary(scope, window, since.as_deref());
        let agent_handle = agent
            .map(|value| value.trim().trim_start_matches('@').to_owned())
            .filter(|value| !value.is_empty());

        let global = sqlx::query(
            r#"
            select
                count(*) as runs,
                coalesce(sum(case when r.status in ('running', 'starting', 'stopping', 'cancelling') then 1 else 0 end), 0) as running_runs,
                coalesce(sum(case when r.status in ('failed', 'cancelled', 'unknown') then 1 else 0 end), 0) as failed_runs,
                coalesce(sum(case when r.stopped_at is not null and r.status not in ('failed', 'cancelled', 'unknown') then 1 else 0 end), 0) as completed_runs,
                coalesce(sum(r.input_tokens), 0) as input_tokens,
                coalesce(sum(r.output_tokens), 0) as output_tokens,
                coalesce(sum(r.cost_micros), 0) as cost_micros
            from agent_runs r
            where ($1 is null or r.started_at >= $1)
            "#,
        )
        .bind(since.as_deref())
        .fetch_one(self.pool)
        .await
        .map_err(to_string)?;
        summary["global"] = run_summary_row_to_json(&global);

        let agent_rows = sqlx::query(
            r#"
            select
                a.handle,
                a.display_name,
                count(r.id) as runs,
                coalesce(sum(case when r.status in ('running', 'starting', 'stopping', 'cancelling') then 1 else 0 end), 0) as running_runs,
                coalesce(sum(case when r.status in ('failed', 'cancelled', 'unknown') then 1 else 0 end), 0) as failed_runs,
                coalesce(sum(case when r.stopped_at is not null and r.status not in ('failed', 'cancelled', 'unknown') then 1 else 0 end), 0) as completed_runs,
                coalesce(sum(r.input_tokens), 0) as input_tokens,
                coalesce(sum(r.output_tokens), 0) as output_tokens,
                coalesce(sum(r.cost_micros), 0) as cost_micros,
                max(r.started_at) as last_run_at
            from agents a
            left join agent_runs r on r.agent_id = a.id and ($1 is null or r.started_at >= $1)
            group by a.id
            having runs > 0
            order by (coalesce(sum(r.input_tokens), 0) + coalesce(sum(r.output_tokens), 0)) desc, last_run_at desc
            limit $2
            "#,
        )
        .bind(since.as_deref())
        .bind(limit)
        .fetch_all(self.pool)
        .await
        .map_err(to_string)?;
        summary["agents"] = Value::Array(
            agent_rows
                .iter()
                .map(agent_run_summary_row_to_json)
                .collect::<Vec<_>>(),
        );

        summary["memory_reads"] = self
            .query_monitoring_memory_reads(since.as_deref(), agent_handle.as_deref(), limit)
            .await?;
        summary["memory_inventory"] = self
            .query_monitoring_memory_inventory(agent_handle.as_deref())
            .await?;
        summary["time_series"] = self
            .query_monitoring_time_series(
                since.as_deref(),
                agent_handle.as_deref(),
                "day",
                "total_tokens",
            )
            .await?;

        if scope == "agent" {
            summary["agent"] = match agent_handle.as_deref() {
                Some(handle) => self
                    .query_monitoring_agent_summary(handle, since.as_deref())
                    .await?
                    .unwrap_or_else(|| json!({ "handle": format!("@{handle}"), "missing": true })),
                None => json!({ "missing": true, "error": "agent scope requires agent" }),
            };
        }

        Ok(summary)
    }

    async fn query_monitoring_agent_summary(
        &self,
        handle: &str,
        since: Option<&str>,
    ) -> CommandResult<Option<Value>> {
        let row = sqlx::query(
            r#"
            select
                a.handle,
                a.display_name,
                count(r.id) as runs,
                coalesce(sum(case when r.status in ('running', 'starting', 'stopping', 'cancelling') then 1 else 0 end), 0) as running_runs,
                coalesce(sum(case when r.status in ('failed', 'cancelled', 'unknown') then 1 else 0 end), 0) as failed_runs,
                coalesce(sum(case when r.stopped_at is not null and r.status not in ('failed', 'cancelled', 'unknown') then 1 else 0 end), 0) as completed_runs,
                coalesce(sum(r.input_tokens), 0) as input_tokens,
                coalesce(sum(r.output_tokens), 0) as output_tokens,
                coalesce(sum(r.cost_micros), 0) as cost_micros,
                max(r.started_at) as last_run_at
            from agents a
            left join agent_runs r on r.agent_id = a.id and ($2 is null or r.started_at >= $2)
            where lower(a.handle) = lower($1)
            group by a.id
            "#,
        )
        .bind(handle)
        .bind(since)
        .fetch_optional(self.pool)
        .await
        .map_err(to_string)?;
        Ok(row.as_ref().map(agent_run_summary_row_to_json))
    }

    pub(crate) async fn query_monitoring_time_series(
        &self,
        since: Option<&str>,
        handle: Option<&str>,
        bucket: &str,
        metric: &str,
    ) -> CommandResult<Value> {
        if monitoring_metric_is_memory(metric) {
            return self
                .query_monitoring_memory_time_series(since, handle, bucket)
                .await;
        }
        let bucket_expr = if bucket == "week" {
            "strftime('%Y-W%W', r.started_at)"
        } else {
            "date(r.started_at)"
        };
        let query = format!(
            r#"
            select
                {bucket_expr} as bucket,
                count(*) as runs,
                coalesce(sum(r.input_tokens), 0) as input_tokens,
                coalesce(sum(r.output_tokens), 0) as output_tokens,
                coalesce(sum(r.cost_micros), 0) as cost_micros
            from agent_runs r
            left join agents a on a.id = r.agent_id
            where ($1 is null or r.started_at >= $1)
              and ($2 is null or lower(a.handle) = lower($2))
            group by bucket
            order by bucket asc
            limit 120
            "#
        );
        let rows = sqlx::query(&query)
            .bind(since)
            .bind(handle)
            .fetch_all(self.pool)
            .await
            .map_err(to_string)?;
        Ok(Value::Array(
            rows.iter().map(time_series_row_to_json).collect::<Vec<_>>(),
        ))
    }

    pub(crate) async fn query_monitoring_agent_time_series(
        &self,
        since: Option<&str>,
        bucket: &str,
        metric: &str,
    ) -> CommandResult<Value> {
        if monitoring_metric_is_memory(metric) {
            return self
                .query_monitoring_agent_memory_time_series(since, bucket)
                .await;
        }
        let bucket_expr = if bucket == "week" {
            "strftime('%Y-W%W', r.started_at)"
        } else {
            "date(r.started_at)"
        };
        let query = format!(
            r#"
            select
                {bucket_expr} as bucket,
                a.handle,
                a.display_name,
                count(*) as runs,
                coalesce(sum(r.input_tokens), 0) as input_tokens,
                coalesce(sum(r.output_tokens), 0) as output_tokens,
                coalesce(sum(r.cost_micros), 0) as cost_micros
            from agent_runs r
            join agents a on a.id = r.agent_id
            where ($1 is null or r.started_at >= $1)
            group by bucket, a.id
            order by bucket asc, lower(a.display_name) asc, lower(a.handle) asc
            limit 600
            "#
        );
        let rows = sqlx::query(&query)
            .bind(since)
            .fetch_all(self.pool)
            .await
            .map_err(to_string)?;
        Ok(Value::Array(
            rows.iter()
                .map(agent_time_series_row_to_json)
                .collect::<Vec<_>>(),
        ))
    }

    async fn query_monitoring_memory_reads(
        &self,
        since: Option<&str>,
        handle: Option<&str>,
        limit: i64,
    ) -> CommandResult<Value> {
        let totals = sqlx::query(
            r#"
            select
                count(*) as count,
                coalesce(sum(mo.output_chars), 0) as output_chars,
                coalesce(sum(mo.output_bytes), 0) as output_bytes,
                coalesce(sum(case when confidence = 'direct' then 1 else 0 end), 0) as direct,
                coalesce(sum(case when confidence = 'weak' then 1 else 0 end), 0) as weak,
                coalesce(sum(case when layer = 'realtime' then 1 else 0 end), 0) as realtime,
                coalesce(sum(case when layer = 'events' then 1 else 0 end), 0) as events
            from agent_memory_observations mo
            left join agents a on a.id = mo.agent_id
            where ($1 is null or mo.created_at >= $1)
              and ($2 is null or lower(a.handle) = lower($2))
            "#,
        )
        .bind(since)
        .bind(handle)
        .fetch_one(self.pool)
        .await
        .map_err(to_string)?;

        let recent_rows = sqlx::query(
            r#"
            select
                mo.created_at,
                a.handle,
                mo.run_id,
                mo.tool_item_id,
                mo.command_preview,
                mo.output_chars,
                mo.output_bytes,
                mo.confidence,
                mo.layer
            from agent_memory_observations mo
            left join agents a on a.id = mo.agent_id
            where ($1 is null or mo.created_at >= $1)
              and ($2 is null or lower(a.handle) = lower($2))
            order by mo.created_at desc
            limit $3
            "#,
        )
        .bind(since)
        .bind(handle)
        .bind(limit)
        .fetch_all(self.pool)
        .await
        .map_err(to_string)?;

        Ok(json!({
            "count": totals.get::<i64, _>("count"),
            "memory_reads": totals.get::<i64, _>("count"),
            "output_chars": totals.get::<i64, _>("output_chars"),
            "output_bytes": totals.get::<i64, _>("output_bytes"),
            "memory_read_bytes": totals.get::<i64, _>("output_bytes"),
            "direct": totals.get::<i64, _>("direct"),
            "weak": totals.get::<i64, _>("weak"),
            "layers": {
                "realtime": totals.get::<i64, _>("realtime"),
                "events": totals.get::<i64, _>("events")
            },
            "recent": recent_rows.iter().map(memory_read_row_to_json).collect::<Vec<_>>()
        }))
    }

    async fn query_monitoring_memory_time_series(
        &self,
        since: Option<&str>,
        handle: Option<&str>,
        bucket: &str,
    ) -> CommandResult<Value> {
        let bucket_expr = if bucket == "week" {
            "strftime('%Y-W%W', mo.created_at)"
        } else {
            "date(mo.created_at)"
        };
        let query = format!(
            r#"
            select
                {bucket_expr} as bucket,
                count(*) as memory_reads,
                coalesce(sum(mo.output_bytes), 0) as memory_read_bytes
            from agent_memory_observations mo
            left join agents a on a.id = mo.agent_id
            where ($1 is null or mo.created_at >= $1)
              and ($2 is null or lower(a.handle) = lower($2))
            group by bucket
            order by bucket asc
            limit 120
            "#
        );
        let rows = sqlx::query(&query)
            .bind(since)
            .bind(handle)
            .fetch_all(self.pool)
            .await
            .map_err(to_string)?;
        Ok(Value::Array(
            rows.iter()
                .map(memory_time_series_row_to_json)
                .collect::<Vec<_>>(),
        ))
    }

    async fn query_monitoring_agent_memory_time_series(
        &self,
        since: Option<&str>,
        bucket: &str,
    ) -> CommandResult<Value> {
        let bucket_expr = if bucket == "week" {
            "strftime('%Y-W%W', mo.created_at)"
        } else {
            "date(mo.created_at)"
        };
        let query = format!(
            r#"
            select
                {bucket_expr} as bucket,
                a.handle,
                a.display_name,
                count(*) as memory_reads,
                coalesce(sum(mo.output_bytes), 0) as memory_read_bytes
            from agent_memory_observations mo
            join agents a on a.id = mo.agent_id
            where ($1 is null or mo.created_at >= $1)
            group by bucket, a.id
            order by bucket asc, lower(a.display_name) asc, lower(a.handle) asc
            limit 600
            "#
        );
        let rows = sqlx::query(&query)
            .bind(since)
            .fetch_all(self.pool)
            .await
            .map_err(to_string)?;
        Ok(Value::Array(
            rows.iter()
                .map(agent_memory_time_series_row_to_json)
                .collect::<Vec<_>>(),
        ))
    }

    pub(crate) async fn query_monitoring_memory_layer_time_series(
        &self,
        since: Option<&str>,
        handle: Option<&str>,
        bucket: &str,
    ) -> CommandResult<Value> {
        let bucket_expr = if bucket == "week" {
            "strftime('%Y-W%W', mo.created_at)"
        } else {
            "date(mo.created_at)"
        };
        let query = format!(
            r#"
            select
                {bucket_expr} as bucket,
                coalesce(sum(case when mo.layer = 'realtime' then 1 else 0 end), 0) as realtime,
                coalesce(sum(case when mo.layer = 'events' then 1 else 0 end), 0) as events
            from agent_memory_observations mo
            left join agents a on a.id = mo.agent_id
            where ($1 is null or mo.created_at >= $1)
              and ($2 is null or lower(a.handle) = lower($2))
            group by bucket
            order by bucket asc
            limit 120
            "#
        );
        let rows = sqlx::query(&query)
            .bind(since)
            .bind(handle)
            .fetch_all(self.pool)
            .await
            .map_err(to_string)?;
        Ok(Value::Array(
            rows.iter()
                .map(memory_layer_time_series_row_to_json)
                .collect::<Vec<_>>(),
        ))
    }

    async fn query_monitoring_memory_inventory(
        &self,
        handle: Option<&str>,
    ) -> CommandResult<Value> {
        let rows = sqlx::query(
            r#"
            select handle, display_name, working_directory
            from agents
            where trim(working_directory) <> ''
              and ($1 is null or lower(handle) = lower($1))
            order by lower(display_name), lower(handle)
            "#,
        )
        .bind(handle)
        .fetch_all(self.pool)
        .await
        .map_err(to_string)?;

        let mut realtime_files = 0_i64;
        let mut event_files = 0_i64;
        let mut agents = Vec::new();
        for row in rows {
            let handle = row.get::<String, _>("handle");
            let display_name = row.get::<String, _>("display_name");
            let working_directory = row.get::<String, _>("working_directory");
            let memory_root = Path::new(&working_directory).join("memory");
            let agent_realtime = count_files_under(&memory_root.join("realtime"));
            let agent_events = count_files_under(&memory_root.join("events"));
            realtime_files += agent_realtime;
            event_files += agent_events;
            if agent_realtime > 0 || agent_events > 0 {
                agents.push(json!({
                    "handle": format!("@{handle}"),
                    "display_name": display_name,
                    "realtime_files": agent_realtime,
                    "event_files": agent_events
                }));
            }
        }

        Ok(json!({
            "realtime_files": realtime_files,
            "event_files": event_files,
            "agents": agents
        }))
    }
}

fn monitoring_metric_is_memory(metric: &str) -> bool {
    matches!(metric, "memory_reads" | "memory_read_bytes")
}

fn run_summary_row_to_json(row: &sqlx::sqlite::SqliteRow) -> Value {
    let input_tokens = row.get::<i64, _>("input_tokens");
    let output_tokens = row.get::<i64, _>("output_tokens");
    let cost_micros = row.get::<i64, _>("cost_micros");
    json!({
        "runs": row.get::<i64, _>("runs"),
        "running_runs": row.get::<i64, _>("running_runs"),
        "completed_runs": row.get::<i64, _>("completed_runs"),
        "failed_runs": row.get::<i64, _>("failed_runs"),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "cost_micros": cost_micros,
        "cost_usd": cost_micros as f64 / 1_000_000.0
    })
}

fn agent_run_summary_row_to_json(row: &sqlx::sqlite::SqliteRow) -> Value {
    let mut value = run_summary_row_to_json(row);
    value["handle"] = json!(format!("@{}", row.get::<String, _>("handle")));
    value["display_name"] = json!(row.get::<String, _>("display_name"));
    value["last_run_at"] = json!(row.get::<Option<String>, _>("last_run_at"));
    value
}

fn time_series_row_to_json(row: &sqlx::sqlite::SqliteRow) -> Value {
    let input_tokens = row.get::<i64, _>("input_tokens");
    let output_tokens = row.get::<i64, _>("output_tokens");
    let cost_micros = row.get::<i64, _>("cost_micros");
    json!({
        "bucket": row.get::<String, _>("bucket"),
        "runs": row.get::<i64, _>("runs"),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "cost_micros": cost_micros,
        "cost_usd": cost_micros as f64 / 1_000_000.0
    })
}

fn agent_time_series_row_to_json(row: &sqlx::sqlite::SqliteRow) -> Value {
    let mut value = time_series_row_to_json(row);
    value["handle"] = json!(format!("@{}", row.get::<String, _>("handle")));
    value["display_name"] = json!(row.get::<String, _>("display_name"));
    value
}

fn memory_time_series_row_to_json(row: &sqlx::sqlite::SqliteRow) -> Value {
    let memory_reads = row.get::<i64, _>("memory_reads");
    let memory_read_bytes = row.get::<i64, _>("memory_read_bytes");
    json!({
        "bucket": row.get::<String, _>("bucket"),
        "memory_reads": memory_reads,
        "memory_read_bytes": memory_read_bytes
    })
}

fn memory_layer_time_series_row_to_json(row: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "bucket": row.get::<String, _>("bucket"),
        "realtime": row.get::<i64, _>("realtime"),
        "events": row.get::<i64, _>("events")
    })
}

fn agent_memory_time_series_row_to_json(row: &sqlx::sqlite::SqliteRow) -> Value {
    let mut value = memory_time_series_row_to_json(row);
    value["handle"] = json!(format!("@{}", row.get::<String, _>("handle")));
    value["display_name"] = json!(row.get::<String, _>("display_name"));
    value
}

fn memory_read_row_to_json(row: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "created_at": row.get::<String, _>("created_at"),
        "agent": row.get::<Option<String>, _>("handle").map(|handle| format!("@{handle}")),
        "run_id": row.get::<Option<uuid::Uuid>, _>("run_id").map(|id| id.to_string()),
        "tool_item_id": row.get::<Option<String>, _>("tool_item_id"),
        "command_preview": row.get::<Option<String>, _>("command_preview"),
        "output_chars": row.get::<Option<i64>, _>("output_chars").unwrap_or_default(),
        "output_bytes": row.get::<Option<i64>, _>("output_bytes").unwrap_or_default(),
        "confidence": row.get::<Option<String>, _>("confidence").unwrap_or_else(|| "unknown".to_owned()),
        "layer": row.get::<Option<String>, _>("layer").unwrap_or_else(|| "unknown".to_owned())
    })
}

fn count_files_under(root: &Path) -> i64 {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                count_files_under(&path)
            } else if path.is_file() {
                1
            } else {
                0
            }
        })
        .sum()
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
