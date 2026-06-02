use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{
    events::notify_supervisor_wake, prompts::ensure_agent_workspace, text::compact_chars_middle,
    to_string, CommandResult,
};

const REALTIME_SEGMENT_LIMIT_BYTES: u64 = 16 * 1024;
const REALTIME_MAX_SEGMENTS: usize = 12;
const REALTIME_KEEP_RECENT_SEGMENTS: usize = 4;
const REALTIME_SEGMENT_NAME_WIDTH: usize = 6;
struct MemoryRoot {
    root: PathBuf,
}

struct RealtimeAppendResult {
    path: String,
    ingest_inputs: Option<Vec<String>>,
}

pub(crate) async fn append_run_summary(
    pool: &SqlitePool,
    agent_id: Uuid,
    run_id: Uuid,
    title: Option<&str>,
    body: &str,
    source_ids: &[String],
) -> CommandResult<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("memory_run_summary body is empty".to_owned());
    }
    let root = memory_root(pool, agent_id).await?;
    fs::create_dir_all(&root.root).map_err(to_string)?;

    let (_, _, mut derived_sources) = run_scope(pool, agent_id, run_id).await?;
    derived_sources.extend(
        source_ids
            .iter()
            .filter(|value| !value.trim().is_empty())
            .cloned(),
    );
    derived_sources.sort();
    derived_sources.dedup();

    let now = Utc::now();
    let title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Agent run summary");
    let entry = format_realtime_entry(
        &now.to_rfc3339(),
        title,
        &agent_id.to_string(),
        &derived_sources,
        body,
    );
    let result = append_realtime_entry(&root.root, &agent_id.to_string(), &entry)?;
    if let Some(inputs) = result.ingest_inputs.as_deref() {
        enqueue_event_ingest_work_item(pool, agent_id, inputs).await?;
    }
    Ok(result.path)
}

async fn enqueue_event_ingest_work_item(
    pool: &SqlitePool,
    agent_id: Uuid,
    inputs: &[String],
) -> CommandResult<()> {
    let Some(first_input) = inputs.first() else {
        return Ok(());
    };
    let existing: Option<Uuid> = sqlx::query_scalar(
        r#"
        select id
        from agent_work_items
        where agent_id = $1
          and source_kind = 'event_ingest'
          and status in ('queued', 'running')
          and context like $2
        limit 1
        "#,
    )
    .bind(agent_id)
    .bind(format!("%- {first_input}%"))
    .fetch_optional(pool)
    .await
    .map_err(to_string)?;
    if existing.is_some() {
        return Ok(());
    }

    let title = "Process memory event ingest task";
    let context =
        format_realtime_ingest_task(&Utc::now().to_rfc3339(), &agent_id.to_string(), inputs);

    sqlx::query(
        r#"
        insert into agent_work_items (agent_id, source_kind, title, context, status)
        values ($1, 'event_ingest', $2, $3, 'queued')
        "#,
    )
    .bind(agent_id)
    .bind(title)
    .bind(context)
    .execute(pool)
    .await
    .map_err(to_string)?;
    let _ = notify_supervisor_wake(pool).await;
    Ok(())
}

pub(crate) async fn runtime_context(
    pool: &SqlitePool,
    agent_id: Uuid,
    limit: usize,
) -> CommandResult<Option<String>> {
    let root = memory_root(pool, agent_id).await?;
    let body = [
        "Persistent Lantor md memory for this agent is available on disk.".to_owned(),
        format!("memory_path=\"{}\"", root.root.display()),
        "Read files under this path directly only when older durable context is needed.".to_owned(),
    ]
    .join("\n");
    Ok(Some(compact_chars_middle(body.trim(), limit)))
}

async fn memory_root(pool: &SqlitePool, agent_id: Uuid) -> CommandResult<MemoryRoot> {
    let row = sqlx::query("select handle, working_directory from agents where id = $1")
        .bind(agent_id)
        .fetch_one(pool)
        .await
        .map_err(to_string)?;
    let handle: String = row.get("handle");
    let working_directory: String = row.get("working_directory");
    let working_directory = working_directory.trim();
    if working_directory.is_empty() {
        return Err(format!("@{handle} has no working_directory for md memory"));
    }
    ensure_agent_workspace(working_directory, &handle)?;
    Ok(MemoryRoot {
        root: PathBuf::from(working_directory).join("memory"),
    })
}

async fn run_scope(
    pool: &SqlitePool,
    agent_id: Uuid,
    run_id: Uuid,
) -> CommandResult<(String, String, Vec<String>)> {
    let row = sqlx::query(
        r#"
        select r.work_item_id, w.channel_id, w.thread_root_id, w.task_id
        from agent_runs r
        left join agent_work_items w on w.id = r.work_item_id
        where r.id = $1 and r.agent_id = $2
        "#,
    )
    .bind(run_id)
    .bind(agent_id)
    .fetch_optional(pool)
    .await
    .map_err(to_string)?;

    let mut sources = vec![format!("run:{run_id}")];
    let Some(row) = row else {
        return Ok(("agent".to_owned(), agent_id.to_string(), sources));
    };
    let work_item_id: Option<Uuid> = row.get("work_item_id");
    if let Some(work_item_id) = work_item_id {
        sources.push(format!("work_item:{work_item_id}"));
    }
    let task_id: Option<Uuid> = row.get("task_id");
    if let Some(task_id) = task_id {
        sources.push(format!("task:{task_id}"));
        return Ok(("task".to_owned(), task_id.to_string(), sources));
    }
    let thread_root_id: Option<Uuid> = row.get("thread_root_id");
    if let Some(thread_root_id) = thread_root_id {
        sources.push(format!("thread:{thread_root_id}"));
        return Ok(("thread".to_owned(), thread_root_id.to_string(), sources));
    }
    let channel_id: Option<Uuid> = row.get("channel_id");
    if let Some(channel_id) = channel_id {
        sources.push(format!("channel:{channel_id}"));
        return Ok(("channel".to_owned(), channel_id.to_string(), sources));
    }
    Ok(("agent".to_owned(), agent_id.to_string(), sources))
}

fn append_realtime_entry(
    root: &Path,
    agent_id: &str,
    entry: &str,
) -> CommandResult<RealtimeAppendResult> {
    let dir = root.join("realtime").join(safe_path_segment(agent_id));
    fs::create_dir_all(&dir).map_err(to_string)?;

    let entry = format!("\n\n{}\n", entry.trim());
    let entry_len = entry.as_bytes().len() as u64;

    let mut segments = realtime_segments_in_dir(&dir)?;
    let segment = if let Some(segment) = segments.last().copied() {
        let current_len = fs::metadata(realtime_segment_path(&dir, segment))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current_len == 0 || current_len + entry_len <= REALTIME_SEGMENT_LIMIT_BYTES {
            segment
        } else {
            segment + 1
        }
    } else {
        1
    };
    let path = realtime_segment_path(&dir, segment);
    append_to_file(&path, &entry)?;

    if !segments.contains(&segment) {
        segments.push(segment);
    }
    let ingest_inputs = maybe_prepare_realtime_ingest_inputs(root, agent_id, &segments)?;

    Ok(RealtimeAppendResult {
        path: realtime_segment_relative_path(agent_id, segment),
        ingest_inputs,
    })
}

fn realtime_segments_in_dir(dir: &Path) -> CommandResult<Vec<usize>> {
    let mut segments = Vec::new();
    if !dir.exists() {
        return Ok(segments);
    }
    for entry in fs::read_dir(dir).map_err(to_string)? {
        let entry = entry.map_err(to_string)?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let Ok(segment) = stem.parse::<usize>() else {
            continue;
        };
        segments.push(segment);
    }
    segments.sort_unstable();
    Ok(segments)
}

fn realtime_segment_path(dir: &Path, segment: usize) -> PathBuf {
    dir.join(format!(
        "{segment:0width$}.md",
        width = REALTIME_SEGMENT_NAME_WIDTH
    ))
}

fn realtime_segment_relative_path(agent_id: &str, segment: usize) -> String {
    format!(
        "realtime/{}/{segment:0width$}.md",
        safe_path_segment(agent_id),
        width = REALTIME_SEGMENT_NAME_WIDTH
    )
}

fn append_to_file(path: &Path, body: &str) -> CommandResult<()> {
    use std::io::Write;

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(to_string)?;
    file.write_all(body.as_bytes()).map_err(to_string)
}

fn maybe_prepare_realtime_ingest_inputs(
    root: &Path,
    agent_id: &str,
    segments: &[usize],
) -> CommandResult<Option<Vec<String>>> {
    if segments.len() <= REALTIME_MAX_SEGMENTS {
        return Ok(None);
    }
    let ingest_count = segments.len().saturating_sub(REALTIME_KEEP_RECENT_SEGMENTS);
    if ingest_count == 0 {
        return Ok(None);
    }
    let inputs = segments
        .iter()
        .take(ingest_count)
        .map(|segment| realtime_segment_relative_path(agent_id, *segment))
        .collect::<Vec<_>>();
    if inputs.is_empty() {
        return Ok(None);
    }

    ensure_event_memory_scaffold(root, agent_id)?;
    Ok(Some(inputs))
}

fn format_realtime_ingest_task(created_at: &str, agent_id: &str, inputs: &[String]) -> String {
    let events_dir = event_memory_relative_dir(agent_id);
    let summary_path = format!("{events_dir}/summary.md");
    let mut lines = vec![
        "# Memory Event Ingest Task".to_owned(),
        String::new(),
        format!("Created: {created_at}"),
        format!("Agent: {agent_id}"),
        String::new(),
        "## Directories".to_owned(),
        String::new(),
        format!(
            "- Realtime input segments: `memory/realtime/{}/`",
            safe_path_segment(agent_id)
        ),
        format!("- Long-term event memory: `memory/{events_dir}/`"),
        format!("- Event summary index: `memory/{summary_path}`"),
        "- Event detail files live under the long-term event memory directory. Create or update one markdown file per event as needed.".to_owned(),
        String::new(),
        "## Input Segments".to_owned(),
        String::new(),
    ];
    lines.extend(inputs.iter().map(|input| format!("- {input}")));
    lines.push(String::new());
    lines.push("## Codex Task".to_owned());
    lines.push(String::new());
    lines.push(
        "Read the input realtime segments and merge them into the event memory directory."
            .to_owned(),
    );
    lines.push(String::new());
    lines.push("The realtime segments are the source of truth for this task. They contain agent-written run summaries plus `Source:` references such as run/thread/message ids. Do not fetch raw source messages from the database; use the realtime items as written.".to_owned());
    lines.push(String::new());
    lines.push("Use `summary.md` as the event index. For each event, merge the new input with the existing summary so the event timeline and context stay coherent. Keep one start time, one end time, and a concise merged event summary.".to_owned());
    lines.push("Use event detail markdown files for the event body. If the input belongs to an existing event, move the matching realtime items into that event's detail file one by one without rewriting or shortening them. If the input describes a new event, create a new event detail markdown file in the event memory directory and add it to `summary.md` as a new event.".to_owned());
    lines.push("Convert from realtime order to event order. One input segment can contribute to multiple events, and multiple input segments can update the same event. Do not move content just because it is recent; merge by matching the same event.".to_owned());
    lines.push("After all event writes succeed, delete the input realtime segment files. If anything is uncertain or fails, leave the inputs in place so a later event_ingest work item can retry.".to_owned());
    lines.push(String::new());
    lines.push("## `summary.md` Event Format".to_owned());
    lines.push(String::new());
    lines.push("Keep one section per event. Use this simple shape:".to_owned());
    lines.push(String::new());
    lines.push("```md".to_owned());
    lines.push("## <event title>".to_owned());
    lines.push("Start: <first relevant time>".to_owned());
    lines.push("End: <last relevant time>".to_owned());
    lines.push(
        "Summary: <merged concise event summary, preserving the event timeline and context>"
            .to_owned(),
    );
    lines.push("```".to_owned());
    lines.push(String::new());
    lines.push("## Event Detail Item Format".to_owned());
    lines.push(String::new());
    lines.push("Move matching realtime items into the matching event detail file one by one. Keep each moved item unchanged:".to_owned());
    lines.push(String::new());
    lines.push("```md".to_owned());
    lines.push("<full realtime item, unchanged>".to_owned());
    lines.push("```".to_owned());
    lines.push(String::new());
    lines.join("\n")
}

fn event_memory_relative_dir(agent_id: &str) -> String {
    format!("events/{}", safe_path_segment(agent_id))
}

fn ensure_event_memory_scaffold(root: &Path, agent_id: &str) -> CommandResult<()> {
    let dir = root.join(event_memory_relative_dir(agent_id));
    fs::create_dir_all(&dir).map_err(to_string)?;
    let summary_path = dir.join("summary.md");
    if summary_path.exists() {
        return Ok(());
    }
    let body = [
        "# Event Memory Summary",
        "",
        "This file is the long-term event index for this agent.",
        "",
        "Each event should record its start time, end time, and merged event summary.",
        "",
        "## Events",
        "",
        "Use this format for each event:",
        "",
        "```md",
        "## <event title>",
        "Start: <first relevant time>",
        "End: <last relevant time>",
        "Summary: <merged concise event summary, preserving the event timeline and context>",
        "```",
        "",
    ]
    .join("\n");
    fs::write(summary_path, body).map_err(to_string)
}

fn format_realtime_entry(
    created_at: &str,
    title: &str,
    agent_id: &str,
    source_ids: &[String],
    body: &str,
) -> String {
    let mut sources = vec![format!("agent:{agent_id}")];
    sources.extend(source_ids.iter().cloned());
    sources.sort();
    sources.dedup();
    format!(
        "## {created_at} · {title}\n\nSource: {}\n\n{}",
        sources.join("; "),
        body.trim()
    )
}

fn safe_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite");
        for statement in [
            "create table agents (id blob primary key not null, handle text not null, working_directory text not null default '')",
            "create table agent_work_items (id blob primary key not null default (randomblob(16)), agent_id blob not null, channel_id blob, thread_root_id blob, task_id blob, source_kind text not null default 'manual', title text not null default '', context text not null default '', status text not null default 'queued')",
            "create table agent_runs (id blob primary key not null, agent_id blob not null, work_item_id blob)",
        ] {
            sqlx::query(statement)
                .execute(&pool)
                .await
                .expect("create test table");
        }
        pool
    }

    #[tokio::test]
    async fn append_run_summary_writes_realtime_segment() {
        let pool = test_pool().await;
        let base = std::env::temp_dir().join(format!("lantor-md-memory-test-{}", Uuid::new_v4()));
        let agent_id = Uuid::new_v4();
        let work_item_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let thread_root_id = Uuid::new_v4();

        sqlx::query("insert into agents (id, handle, working_directory) values ($1, 'Ada', $2)")
            .bind(agent_id)
            .bind(base.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .expect("insert agent");
        sqlx::query(
            "insert into agent_work_items (id, agent_id, thread_root_id) values ($1, $2, $3)",
        )
        .bind(work_item_id)
        .bind(agent_id)
        .bind(thread_root_id)
        .execute(&pool)
        .await
        .expect("insert work item");
        sqlx::query("insert into agent_runs (id, agent_id, work_item_id) values ($1, $2, $3)")
            .bind(run_id)
            .bind(agent_id)
            .bind(work_item_id)
            .execute(&pool)
            .await
            .expect("insert run");

        let memory_path = append_run_summary(
            &pool,
            agent_id,
            run_id,
            Some("记忆方案"),
            "本轮讨论了 md 记忆方案继续推进。",
            &["msg:1".to_owned()],
        )
        .await
        .expect("append run summary");
        assert_eq!(memory_path, format!("realtime/{agent_id}/000001.md"));
        let content = fs::read_to_string(base.join("memory").join(&memory_path))
            .expect("read realtime segment");
        assert!(content.contains("记忆方案"));
        assert!(content.contains("thread:"));
        assert!(content.contains("本轮讨论了 md 记忆方案继续推进。"));

        let _ = fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn append_run_summary_queues_event_ingest_work_item_when_inputs_are_ready() {
        let pool = test_pool().await;
        let base = std::env::temp_dir().join(format!("lantor-md-memory-test-{}", Uuid::new_v4()));
        let agent_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();

        sqlx::query("insert into agents (id, handle, working_directory) values ($1, 'Ada', $2)")
            .bind(agent_id)
            .bind(base.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .expect("insert agent");
        sqlx::query("insert into agent_runs (id, agent_id) values ($1, $2)")
            .bind(run_id)
            .bind(agent_id)
            .execute(&pool)
            .await
            .expect("insert run");

        let large_body = "x".repeat(REALTIME_SEGMENT_LIMIT_BYTES as usize);
        for idx in 1..=13 {
            append_run_summary(
                &pool,
                agent_id,
                run_id,
                Some(&format!("entry-{idx}")),
                &large_body,
                &[],
            )
            .await
            .expect("append run summary");
        }

        let work = sqlx::query(
            "select source_kind, title, context, status from agent_work_items where agent_id = $1",
        )
        .bind(agent_id)
        .fetch_one(&pool)
        .await
        .expect("event ingest work item");
        assert_eq!(work.get::<String, _>("source_kind"), "event_ingest");
        assert_eq!(
            work.get::<String, _>("title"),
            "Process memory event ingest task"
        );
        assert_eq!(work.get::<String, _>("status"), "queued");
        let context: String = work.get("context");
        assert!(context.contains("## Input Segments"));
        assert!(context.contains(&format!("realtime/{agent_id}/000001.md")));
        assert!(context.contains(&format!("realtime/{agent_id}/000009.md")));
        assert!(!context.contains(&format!("realtime/{agent_id}/000010.md")));

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn realtime_segments_grow_and_prepare_ingest_inputs_without_pending() {
        let root = std::env::temp_dir().join(format!("lantor-realtime-test-{}", Uuid::new_v4()));
        let agent_id = Uuid::new_v4().to_string();
        let large_entry = "x".repeat(REALTIME_SEGMENT_LIMIT_BYTES as usize);

        for idx in 1..=13 {
            let result =
                append_realtime_entry(&root, &agent_id, &format!("entry-{idx} {large_entry}"))
                    .expect("append realtime entry");
            assert_eq!(result.path, format!("realtime/{agent_id}/{idx:06}.md"));
            if idx < 13 {
                assert!(result.ingest_inputs.is_none());
            } else {
                assert_eq!(
                    result.ingest_inputs.as_deref(),
                    Some(
                        [
                            format!("realtime/{agent_id}/000001.md"),
                            format!("realtime/{agent_id}/000002.md"),
                            format!("realtime/{agent_id}/000003.md"),
                            format!("realtime/{agent_id}/000004.md"),
                            format!("realtime/{agent_id}/000005.md"),
                            format!("realtime/{agent_id}/000006.md"),
                            format!("realtime/{agent_id}/000007.md"),
                            format!("realtime/{agent_id}/000008.md"),
                            format!("realtime/{agent_id}/000009.md"),
                        ]
                        .as_slice()
                    )
                );
            }
        }

        let first = fs::read_to_string(root.join(format!("realtime/{agent_id}/000001.md")))
            .expect("read first segment");
        let thirteenth = fs::read_to_string(root.join(format!("realtime/{agent_id}/000013.md")))
            .expect("read thirteenth segment");
        assert!(first.contains("entry-1"));
        assert!(thirteenth.contains("entry-13"));
        assert!(!root.join("realtime_pending").exists());
        let event_summary = fs::read_to_string(root.join(format!("events/{agent_id}/summary.md")))
            .expect("read event summary scaffold");
        assert!(event_summary.contains("# Event Memory Summary"));
        assert!(event_summary.contains("start time, end time, and merged event summary"));
        assert!(event_summary.contains("Use this format for each event"));

        let _ = fs::remove_dir_all(root);
    }
}
