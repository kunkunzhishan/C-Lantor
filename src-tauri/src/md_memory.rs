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
) -> CommandResult<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("memory_run_summary body is empty".to_owned());
    }
    let root = memory_root(pool, agent_id).await?;
    fs::create_dir_all(&root.root).map_err(to_string)?;

    let mut derived_sources = run_message_sources(pool, agent_id, run_id).await?;
    derived_sources.sort();
    derived_sources.dedup();

    let now = Utc::now();
    let title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Agent run summary");
    let entry = format_realtime_entry(&now.to_rfc3339(), title, &derived_sources, body);
    let result = append_realtime_entry(&root.root, &entry)?;
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
    let lines = vec![
        "Persistent Lantor md memory for this agent is available on disk.".to_owned(),
        format!("memory_path=\"{}\"", root.root.display()),
        "Memory is an important context source; except for extremely simple tasks that require no context, check memory."
            .to_owned(),
    ];
    let body = lines.join("\n");
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
    let root = MemoryRoot {
        root: PathBuf::from(working_directory).join("memory"),
    };
    migrate_legacy_agent_memory(&root.root, &agent_id.to_string())?;
    Ok(root)
}

async fn run_message_sources(
    pool: &SqlitePool,
    agent_id: Uuid,
    run_id: Uuid,
) -> CommandResult<Vec<String>> {
    let row = sqlx::query(
        r#"
        select w.source_message_id, w.call_utterance_id
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

    let Some(row) = row else {
        return Ok(Vec::new());
    };
    let source_message_id: Option<Uuid> = row.get("source_message_id");
    if let Some(id) = source_message_id {
        return Ok(vec![format!("message:{id}")]);
    }
    let call_utterance_id: Option<Uuid> = row.get("call_utterance_id");
    Ok(call_utterance_id
        .map(|id| vec![format!("call_utterance:{id}")])
        .unwrap_or_default())
}

fn migrate_legacy_agent_memory(root: &Path, agent_id: &str) -> CommandResult<()> {
    let legacy_agent = safe_path_segment(agent_id);
    migrate_legacy_realtime_memory(root, &legacy_agent)?;
    migrate_legacy_event_memory(root, &legacy_agent)?;
    Ok(())
}

fn migrate_legacy_realtime_memory(root: &Path, legacy_agent: &str) -> CommandResult<()> {
    let dir = root.join("realtime");
    let legacy_dir = dir.join(legacy_agent);
    if !legacy_dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(&dir).map_err(to_string)?;
    let mut next_segment = realtime_segments_in_dir(&dir)?.last().copied().unwrap_or(0) + 1;
    for source in realtime_segment_files_in_dir(&legacy_dir)? {
        let target = realtime_segment_path(&dir, next_segment);
        fs::rename(&source, &target).map_err(to_string)?;
        next_segment += 1;
    }
    fs::remove_dir_all(&legacy_dir).map_err(to_string)
}

fn realtime_segment_files_in_dir(dir: &Path) -> CommandResult<Vec<PathBuf>> {
    let mut segments: Vec<(usize, PathBuf)> = Vec::new();
    if !dir.exists() {
        return Ok(Vec::new());
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
        segments.push((segment, path));
    }
    segments.sort_by_key(|(segment, _)| *segment);
    Ok(segments.into_iter().map(|(_, path)| path).collect())
}

fn migrate_legacy_event_memory(root: &Path, legacy_agent: &str) -> CommandResult<()> {
    let dir = root.join("events");
    let legacy_dir = dir.join(legacy_agent);
    if !legacy_dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(&dir).map_err(to_string)?;
    let mut entries = fs::read_dir(&legacy_dir)
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source = entry.path();
        if source.is_dir() {
            continue;
        }
        let Some(file_name) = source.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let target = dir.join(file_name);
        if file_name == "summary.md" && target.exists() {
            let legacy_summary = fs::read_to_string(&source).map_err(to_string)?;
            append_to_file(
                &target,
                &format!(
                    "\n\n<!-- Migrated from legacy events/{legacy_agent}/summary.md -->\n\n{}",
                    legacy_summary.trim()
                ),
            )?;
            fs::remove_file(&source).map_err(to_string)?;
        } else {
            let target = unique_migrated_path(&dir, file_name, legacy_agent);
            fs::rename(&source, target).map_err(to_string)?;
        }
    }
    fs::remove_dir_all(&legacy_dir).map_err(to_string)
}

fn unique_migrated_path(dir: &Path, file_name: &str, legacy_agent: &str) -> PathBuf {
    let target = dir.join(file_name);
    if !target.exists() {
        return target;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("event");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    let mut counter = 1;
    loop {
        let candidate = dir.join(format!(
            "{stem}.legacy-{legacy_agent}-{counter}.{extension}"
        ));
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

fn append_realtime_entry(root: &Path, entry: &str) -> CommandResult<RealtimeAppendResult> {
    let dir = root.join("realtime");
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
    let ingest_inputs = maybe_prepare_realtime_ingest_inputs(root, &segments)?;

    Ok(RealtimeAppendResult {
        path: realtime_segment_relative_path(segment),
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

fn realtime_segment_relative_path(segment: usize) -> String {
    format!(
        "realtime/{segment:0width$}.md",
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
        .map(|segment| realtime_segment_relative_path(*segment))
        .collect::<Vec<_>>();
    if inputs.is_empty() {
        return Ok(None);
    }

    ensure_event_memory_scaffold(root)?;
    Ok(Some(inputs))
}

fn format_realtime_ingest_task(created_at: &str, agent_id: &str, inputs: &[String]) -> String {
    let events_dir = event_memory_relative_dir();
    let summary_path = format!("{events_dir}/summary.md");
    let mut lines = vec![
        "# Memory Event Ingest Task".to_owned(),
        String::new(),
        format!("Created: {created_at}"),
        format!("Agent: {agent_id}"),
        String::new(),
        "## Directories".to_owned(),
        String::new(),
        "- Realtime input segments: `memory/realtime/`".to_owned(),
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
    lines.push("The realtime segments are the source of truth for this task. They contain agent-written run summaries plus `Sources:` references. `Sources:` is system-written and should contain only `message:<uuid>` or `call_utterance:<uuid>` entries. Agents may include `Provenance:` lines inside the item body as best-effort follow-up hints; provenance is agent-written and should not be treated as guaranteed evidence. Do not fetch raw source messages from the database; use the realtime items as written.".to_owned());
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
        "Sources: <deduplicated `message:<uuid>` or `call_utterance:<uuid>` values from the matching realtime items>"
            .to_owned(),
    );
    lines.push(
        "Summary: <merged concise event summary, preserving the event timeline and context>"
            .to_owned(),
    );
    lines.push("```".to_owned());
    lines.push(String::new());
    lines.push("## Event Detail Item Format".to_owned());
    lines.push(String::new());
    lines.push("Move matching realtime items into the matching event detail file one by one. Keep each moved item unchanged. Do not synthesize `Provenance:`; only preserve provenance if the agent already wrote it in the realtime item body:".to_owned());
    lines.push(String::new());
    lines.push("```md".to_owned());
    lines.push("<full realtime item, unchanged>".to_owned());
    lines.push("```".to_owned());
    lines.push(String::new());
    lines.join("\n")
}

fn event_memory_relative_dir() -> String {
    "events".to_owned()
}

fn ensure_event_memory_scaffold(root: &Path) -> CommandResult<()> {
    let dir = root.join(event_memory_relative_dir());
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
        "Sources: <deduplicated `message:<uuid>` or `call_utterance:<uuid>` values from the matching realtime items>",
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
    source_ids: &[String],
    body: &str,
) -> String {
    let mut sources = source_ids.to_vec();
    sources.sort();
    sources.dedup();
    format!(
        "## {created_at} · {title}\n\nSources: {}\n\n{}",
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
            "create table agent_work_items (id blob primary key not null default (randomblob(16)), agent_id blob not null, channel_id blob, thread_root_id blob, source_message_id blob, task_id blob, source_kind text not null default 'manual', title text not null default '', context text not null default '', status text not null default 'queued', call_utterance_id blob)",
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
        let source_message_id = Uuid::new_v4();

        sqlx::query("insert into agents (id, handle, working_directory) values ($1, 'Ada', $2)")
            .bind(agent_id)
            .bind(base.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .expect("insert agent");
        sqlx::query(
            "insert into agent_work_items (id, agent_id, thread_root_id, source_message_id) values ($1, $2, $3, $4)",
        )
        .bind(work_item_id)
        .bind(agent_id)
        .bind(thread_root_id)
        .bind(source_message_id)
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
        )
        .await
        .expect("append run summary");
        assert_eq!(memory_path, "realtime/000001.md");
        let content = fs::read_to_string(base.join("memory").join(&memory_path))
            .expect("read realtime segment");
        assert!(content.contains("记忆方案"));
        assert!(content.contains("Sources:"));
        assert!(content.contains(&format!("message:{source_message_id}")));
        assert!(!content.contains("thread:"));
        assert!(content.contains("本轮讨论了 md 记忆方案继续推进。"));

        let _ = fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn append_run_summary_uses_call_utterance_source_when_message_source_is_absent() {
        let pool = test_pool().await;
        let base = std::env::temp_dir().join(format!("lantor-md-memory-test-{}", Uuid::new_v4()));
        let agent_id = Uuid::new_v4();
        let work_item_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let call_utterance_id = Uuid::new_v4();

        sqlx::query("insert into agents (id, handle, working_directory) values ($1, 'Ada', $2)")
            .bind(agent_id)
            .bind(base.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .expect("insert agent");
        sqlx::query(
            "insert into agent_work_items (id, agent_id, source_kind, call_utterance_id) values ($1, $2, 'call_mode', $3)",
        )
        .bind(work_item_id)
        .bind(agent_id)
        .bind(call_utterance_id)
        .execute(&pool)
        .await
        .expect("insert call work item");
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
            Some("Call note"),
            "Handled the call-dispatched request.",
        )
        .await
        .expect("append run summary");
        let content = fs::read_to_string(base.join("memory").join(&memory_path))
            .expect("read realtime segment");
        assert!(content.contains(&format!("call_utterance:{call_utterance_id}")));
        assert!(!content.contains("Sources: message:"));

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
        assert!(context.contains("realtime/000001.md"));
        assert!(context.contains("realtime/000009.md"));
        assert!(!context.contains("realtime/000010.md"));
        assert!(!context.contains(&format!("realtime/{agent_id}/")));

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn realtime_segments_grow_and_prepare_ingest_inputs_without_pending() {
        let root = std::env::temp_dir().join(format!("lantor-realtime-test-{}", Uuid::new_v4()));
        let large_entry = "x".repeat(REALTIME_SEGMENT_LIMIT_BYTES as usize);

        for idx in 1..=13 {
            let result = append_realtime_entry(&root, &format!("entry-{idx} {large_entry}"))
                .expect("append realtime entry");
            assert_eq!(result.path, format!("realtime/{idx:06}.md"));
            if idx < 13 {
                assert!(result.ingest_inputs.is_none());
            } else {
                assert_eq!(
                    result.ingest_inputs.as_deref(),
                    Some(
                        [
                            "realtime/000001.md".to_owned(),
                            "realtime/000002.md".to_owned(),
                            "realtime/000003.md".to_owned(),
                            "realtime/000004.md".to_owned(),
                            "realtime/000005.md".to_owned(),
                            "realtime/000006.md".to_owned(),
                            "realtime/000007.md".to_owned(),
                            "realtime/000008.md".to_owned(),
                            "realtime/000009.md".to_owned(),
                        ]
                        .as_slice()
                    )
                );
            }
        }

        let first =
            fs::read_to_string(root.join("realtime/000001.md")).expect("read first segment");
        let thirteenth =
            fs::read_to_string(root.join("realtime/000013.md")).expect("read thirteenth segment");
        assert!(first.contains("entry-1"));
        assert!(thirteenth.contains("entry-13"));
        assert!(!root.join("realtime_pending").exists());
        let event_summary = fs::read_to_string(root.join("events/summary.md"))
            .expect("read event summary scaffold");
        assert!(event_summary.contains("# Event Memory Summary"));
        assert!(event_summary.contains("start time, end time, and merged event summary"));
        assert!(event_summary
            .contains("Sources: <deduplicated `message:<uuid>` or `call_utterance:<uuid>` values"));
        assert!(event_summary.contains("Use this format for each event"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrates_legacy_agent_memory_directories() {
        let root = std::env::temp_dir().join(format!("lantor-memory-migrate-{}", Uuid::new_v4()));
        let agent_id = Uuid::new_v4().to_string();
        let legacy_realtime = root.join("realtime").join(&agent_id);
        let legacy_events = root.join("events").join(&agent_id);
        fs::create_dir_all(&legacy_realtime).expect("legacy realtime dir");
        fs::create_dir_all(&legacy_events).expect("legacy events dir");
        fs::write(root.join("realtime/000001.md"), "new segment").expect("existing segment");
        fs::write(legacy_realtime.join("000001.md"), "legacy one").expect("legacy segment one");
        fs::write(legacy_realtime.join("000002.md"), "legacy two").expect("legacy segment two");
        fs::write(legacy_events.join("summary.md"), "# Legacy summary").expect("legacy summary");
        fs::write(legacy_events.join("event.md"), "# Legacy event").expect("legacy event");

        migrate_legacy_agent_memory(&root, &agent_id).expect("migrate memory");

        assert!(root.join("realtime/000001.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("realtime/000002.md")).expect("migrated first"),
            "legacy one"
        );
        assert_eq!(
            fs::read_to_string(root.join("realtime/000003.md")).expect("migrated second"),
            "legacy two"
        );
        assert!(root.join("events/summary.md").exists());
        assert!(root.join("events/event.md").exists());
        assert!(!root.join("realtime").join(&agent_id).exists());
        assert!(!root.join("events").join(&agent_id).exists());

        let _ = fs::remove_dir_all(root);
    }
}
