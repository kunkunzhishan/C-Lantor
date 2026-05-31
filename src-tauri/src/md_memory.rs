use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{
    prompts::ensure_agent_workspace, text::compact_chars_middle, to_string, CommandResult,
};

const MANIFEST_FILE: &str = "manifest.json";
const SEARCH_SNIPPET_LIMIT: usize = 360;
const READ_CONTENT_LIMIT: usize = 24_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MemoryManifest {
    items: Vec<MemoryManifestItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MemoryManifestItem {
    id: String,
    kind: String,
    scope_type: String,
    scope_id: String,
    title: String,
    path: String,
    created_at: String,
    token_count: usize,
    source_ids: Vec<String>,
    parent_ids: Vec<String>,
}

struct MemoryRoot {
    root: PathBuf,
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

    let (scope_type, scope_id, mut derived_sources) = run_scope(pool, agent_id, run_id).await?;
    derived_sources.extend(
        source_ids
            .iter()
            .filter(|value| !value.trim().is_empty())
            .cloned(),
    );
    derived_sources.sort();
    derived_sources.dedup();

    let now = Utc::now();
    let id = format!(
        "run_{}_{}",
        now.format("%Y%m%d_%H%M%S"),
        short_uuid(Uuid::new_v4())
    );
    let title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Agent run summary");
    let rel_path = format!("runs/{}/{}.md", now.format("%Y-%m-%d"), id);
    let path = root.root.join(&rel_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(to_string)?;
    }
    let token_count = estimate_tokens(body);
    let created_at = now.to_rfc3339();
    let content = format_memory_markdown(
        &id,
        "run",
        &scope_type,
        &scope_id,
        title,
        &created_at,
        token_count,
        &derived_sources,
        &[],
        body,
    );
    fs::write(&path, content).map_err(to_string)?;

    let item = MemoryManifestItem {
        id: id.clone(),
        kind: "run".to_owned(),
        scope_type,
        scope_id,
        title: title.to_owned(),
        path: rel_path,
        created_at,
        token_count,
        source_ids: derived_sources,
        parent_ids: Vec::new(),
    };
    upsert_manifest_item(&root.root, item)?;
    Ok(id)
}

pub(crate) async fn append_summary(
    pool: &SqlitePool,
    agent_id: Uuid,
    run_id: Uuid,
    title: Option<&str>,
    body: &str,
    scope_type: Option<&str>,
    scope_id: Option<&str>,
    parent_ids: &[String],
    source_ids: &[String],
) -> CommandResult<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("memory_summary body is empty".to_owned());
    }
    let root = memory_root(pool, agent_id).await?;
    fs::create_dir_all(&root.root).map_err(to_string)?;

    let (derived_scope_type, derived_scope_id, mut derived_sources) =
        run_scope(pool, agent_id, run_id).await?;
    let scope_type = scope_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&derived_scope_type)
        .to_owned();
    let scope_id = scope_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&derived_scope_id)
        .to_owned();
    derived_sources.extend(
        source_ids
            .iter()
            .filter(|value| !value.trim().is_empty())
            .cloned(),
    );
    derived_sources.sort();
    derived_sources.dedup();

    let now = Utc::now();
    let id = format!(
        "summary_{}_{}",
        now.format("%Y%m%d_%H%M%S"),
        short_uuid(Uuid::new_v4())
    );
    let title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Memory summary");
    let rel_path = format!("summaries/{}/{}.md", safe_path_segment(&scope_type), id);
    let path = root.root.join(&rel_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(to_string)?;
    }
    let token_count = estimate_tokens(body);
    let created_at = now.to_rfc3339();
    let content = format_memory_markdown(
        &id,
        "summary",
        &scope_type,
        &scope_id,
        title,
        &created_at,
        token_count,
        &derived_sources,
        parent_ids,
        body,
    );
    fs::write(&path, content).map_err(to_string)?;

    let item = MemoryManifestItem {
        id: id.clone(),
        kind: "summary".to_owned(),
        scope_type,
        scope_id,
        title: title.to_owned(),
        path: rel_path,
        created_at,
        token_count,
        source_ids: derived_sources,
        parent_ids: parent_ids.to_vec(),
    };
    upsert_manifest_item(&root.root, item)?;
    Ok(id)
}

pub(crate) async fn search(
    pool: &SqlitePool,
    agent_id: Uuid,
    arguments: &Value,
) -> CommandResult<Value> {
    let root = memory_root(pool, agent_id).await?;
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let scope_type = arguments
        .get("scope_type")
        .or_else(|| arguments.get("scope"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let scope_id = arguments
        .get("scope_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(8)
        .clamp(1, 20) as usize;

    let manifest = read_manifest(&root.root)?;
    let mut matches = Vec::new();
    for item in manifest.items {
        if scope_type.is_some_and(|scope_type| scope_type != item.scope_type) {
            continue;
        }
        if scope_id.is_some_and(|scope_id| scope_id != item.scope_id) {
            continue;
        }
        let content = read_item_content(&root.root, &item.path).unwrap_or_default();
        let haystack = format!("{} {}", item.title, content).to_lowercase();
        if !query.is_empty() && !haystack.contains(&query) {
            continue;
        }
        let snippet = memory_snippet(&content, &query);
        matches.push(json!({
            "id": item.id,
            "kind": item.kind,
            "title": item.title,
            "snippet": snippet,
            "scope_type": item.scope_type,
            "scope_id": item.scope_id,
            "created_at": item.created_at,
            "token_count": item.token_count,
            "source_ids": item.source_ids
        }));
    }
    matches.sort_by(|left, right| {
        right
            .get("created_at")
            .and_then(Value::as_str)
            .cmp(&left.get("created_at").and_then(Value::as_str))
    });
    matches.truncate(limit);
    Ok(json!({ "items": matches }))
}

pub(crate) async fn read(
    pool: &SqlitePool,
    agent_id: Uuid,
    arguments: &Value,
) -> CommandResult<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "memory_read requires id".to_owned())?;
    let root = memory_root(pool, agent_id).await?;
    let manifest = read_manifest(&root.root)?;
    let item = manifest
        .items
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("unknown memory item: {id}"))?;
    let content = read_item_content(&root.root, &item.path)?;
    Ok(json!({
        "id": item.id,
        "kind": item.kind,
        "title": item.title,
        "content": compact_chars_middle(&strip_frontmatter(&content), READ_CONTENT_LIMIT),
        "scope_type": item.scope_type,
        "scope_id": item.scope_id,
        "created_at": item.created_at,
        "source_ids": item.source_ids,
        "parent_ids": item.parent_ids,
        "path": item.path
    }))
}

pub(crate) async fn rebuild_manifest(pool: &SqlitePool, agent_id: Uuid) -> CommandResult<usize> {
    let root = memory_root(pool, agent_id).await?;
    let items = rebuild_manifest_from_markdown(&root.root)?;
    let count = items.len();
    write_manifest(&root.root, &MemoryManifest { items })?;
    Ok(count)
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

fn read_manifest(root: &Path) -> CommandResult<MemoryManifest> {
    let path = root.join(MANIFEST_FILE);
    if !path.exists() {
        return Ok(MemoryManifest { items: Vec::new() });
    }
    let content = fs::read_to_string(path).map_err(to_string)?;
    serde_json::from_str(&content).map_err(to_string)
}

fn write_manifest(root: &Path, manifest: &MemoryManifest) -> CommandResult<()> {
    fs::create_dir_all(root).map_err(to_string)?;
    let path = root.join(MANIFEST_FILE);
    let tmp = root.join(format!("{MANIFEST_FILE}.tmp"));
    let content = serde_json::to_string_pretty(manifest).map_err(to_string)?;
    fs::write(&tmp, format!("{content}\n")).map_err(to_string)?;
    fs::rename(tmp, path).map_err(to_string)
}

fn upsert_manifest_item(root: &Path, item: MemoryManifestItem) -> CommandResult<()> {
    let mut manifest = read_manifest(root)?;
    manifest.items.retain(|existing| existing.id != item.id);
    manifest.items.push(item);
    manifest
        .items
        .sort_by(|left, right| right.created_at.cmp(&left.created_at));
    write_manifest(root, &manifest)
}

fn rebuild_manifest_from_markdown(root: &Path) -> CommandResult<Vec<MemoryManifestItem>> {
    let mut items = Vec::new();
    if !root.exists() {
        return Ok(items);
    }
    collect_markdown_manifest_items(root, root, &mut items)?;
    items.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(items)
}

fn collect_markdown_manifest_items(
    root: &Path,
    dir: &Path,
    items: &mut Vec<MemoryManifestItem>,
) -> CommandResult<()> {
    for entry in fs::read_dir(dir).map_err(to_string)? {
        let entry = entry.map_err(to_string)?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(to_string)?;
        if file_type.is_dir() {
            collect_markdown_manifest_items(root, &path, items)?;
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let content = fs::read_to_string(&path).map_err(to_string)?;
        let Some(mut item) = parse_manifest_item_from_markdown(&content)? else {
            continue;
        };
        let rel_path = path
            .strip_prefix(root)
            .map_err(to_string)?
            .to_string_lossy()
            .replace('\\', "/");
        item.path = rel_path;
        items.push(item);
    }
    Ok(())
}

fn parse_manifest_item_from_markdown(content: &str) -> CommandResult<Option<MemoryManifestItem>> {
    let Some(frontmatter) = extract_frontmatter(content) else {
        return Ok(None);
    };
    let token_count = frontmatter_scalar(frontmatter, "token_count")
        .unwrap_or_else(|| estimate_tokens(&strip_frontmatter(content)).to_string())
        .parse::<usize>()
        .map_err(to_string)?;
    let Some(id) = frontmatter_scalar(frontmatter, "id") else {
        return Ok(None);
    };
    let Some(kind) = frontmatter_scalar(frontmatter, "kind") else {
        return Ok(None);
    };
    let Some(scope_type) = frontmatter_scalar(frontmatter, "scope_type") else {
        return Ok(None);
    };
    let Some(scope_id) = frontmatter_scalar(frontmatter, "scope_id") else {
        return Ok(None);
    };
    let Some(title) = frontmatter_scalar(frontmatter, "title") else {
        return Ok(None);
    };
    let Some(created_at) = frontmatter_scalar(frontmatter, "created_at") else {
        return Ok(None);
    };
    Ok(Some(MemoryManifestItem {
        id,
        kind,
        scope_type,
        scope_id,
        title,
        path: String::new(),
        created_at,
        token_count,
        source_ids: frontmatter_list(frontmatter, "source_ids"),
        parent_ids: frontmatter_list(frontmatter, "parent_ids"),
    }))
}

fn read_item_content(root: &Path, rel_path: &str) -> CommandResult<String> {
    let path = root.join(rel_path);
    let canonical_root = root.canonicalize().map_err(to_string)?;
    let canonical_path = path.canonicalize().map_err(to_string)?;
    if !canonical_path.starts_with(canonical_root) {
        return Err("memory item path escapes memory root".to_owned());
    }
    fs::read_to_string(canonical_path).map_err(to_string)
}

fn format_memory_markdown(
    id: &str,
    kind: &str,
    scope_type: &str,
    scope_id: &str,
    title: &str,
    created_at: &str,
    token_count: usize,
    source_ids: &[String],
    parent_ids: &[String],
    body: &str,
) -> String {
    format!(
        "---\n\
         id: {}\n\
         kind: {}\n\
         scope_type: {}\n\
         scope_id: {}\n\
         title: {}\n\
         created_at: {}\n\
         {}\n\
         {}\n\
         token_count: {}\n\
         ---\n\n\
         # {}\n\n{}\n",
        yaml_escape(id),
        yaml_escape(kind),
        yaml_escape(scope_type),
        yaml_escape(scope_id),
        yaml_escape(title),
        yaml_escape(created_at),
        yaml_list_field("source_ids", source_ids),
        yaml_list_field("parent_ids", parent_ids),
        token_count,
        title,
        body.trim()
    )
}

fn strip_frontmatter(content: &str) -> String {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---\n") {
        return content.trim().to_owned();
    }
    let rest = &trimmed[4..];
    if let Some(end) = rest.find("\n---\n") {
        return rest[end + 5..].trim().to_owned();
    }
    content.trim().to_owned()
}

fn extract_frontmatter(content: &str) -> Option<&str> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---\n") {
        return None;
    }
    let rest = &trimmed[4..];
    rest.find("\n---\n").map(|end| &rest[..end])
}

fn frontmatter_scalar(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    frontmatter.lines().find_map(|line| {
        let line = line.trim();
        line.strip_prefix(&prefix)
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "[]")
            .map(yaml_unescape)
    })
}

fn frontmatter_list(frontmatter: &str, key: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut in_list = false;
    let prefix = format!("{key}:");
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if in_list {
            if let Some(value) = trimmed.strip_prefix("- ") {
                values.push(yaml_unescape(value.trim()));
                continue;
            }
            if !trimmed.is_empty() {
                break;
            }
        }
        if let Some(value) = trimmed.strip_prefix(&prefix) {
            let value = value.trim();
            if value == "[]" {
                return Vec::new();
            }
            if !value.is_empty() {
                values.push(yaml_unescape(value));
                return values;
            }
            in_list = true;
        }
    }
    values
}

fn memory_snippet(content: &str, query: &str) -> String {
    let content = strip_frontmatter(content);
    if query.is_empty() {
        return compact_chars_middle(content.trim(), SEARCH_SNIPPET_LIMIT);
    }
    if let Some(idx) = find_case_insensitive_boundary(&content, query) {
        let start = retreat_char_boundary(&content, idx, 120);
        let end = advance_char_boundary(&content, idx, query.chars().count() + 240);
        return compact_chars_middle(content[start..end].trim(), SEARCH_SNIPPET_LIMIT);
    }
    compact_chars_middle(content.trim(), SEARCH_SNIPPET_LIMIT)
}

fn yaml_list_field(name: &str, items: &[String]) -> String {
    if items.is_empty() {
        return format!("{name}: []");
    }
    let values = items
        .iter()
        .map(|item| format!("  - {}", yaml_escape(item)))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{name}:\n{values}")
}

fn find_case_insensitive_boundary(content: &str, query: &str) -> Option<usize> {
    let query = query.trim();
    if query.is_empty() {
        return Some(0);
    }
    content.char_indices().find_map(|(idx, _)| {
        content[idx..]
            .to_lowercase()
            .starts_with(query)
            .then_some(idx)
    })
}

fn retreat_char_boundary(content: &str, idx: usize, chars: usize) -> usize {
    let mut start = idx;
    for _ in 0..chars {
        let Some((prev_idx, _)) = content[..start].char_indices().next_back() else {
            return 0;
        };
        start = prev_idx;
    }
    start
}

fn advance_char_boundary(content: &str, idx: usize, chars: usize) -> usize {
    let mut end = idx;
    for _ in 0..chars {
        let Some(ch) = content[end..].chars().next() else {
            return content.len();
        };
        end += ch.len_utf8();
    }
    end
}

fn estimate_tokens(value: &str) -> usize {
    (value.chars().count() / 4).max(1)
}

fn short_uuid(id: Uuid) -> String {
    id.to_string().chars().take(8).collect()
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

fn yaml_escape(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn yaml_unescape(value: &str) -> String {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value);
    let mut output = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                output.push(next);
            }
        } else {
            output.push(ch);
        }
    }
    output
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
            "create table agent_work_items (id blob primary key not null, agent_id blob not null, channel_id blob, thread_root_id blob, task_id blob)",
            "create table agent_runs (id blob primary key not null, agent_id blob not null, work_item_id blob)",
        ] {
            sqlx::query(statement)
                .execute(&pool)
                .await
                .expect("create test table");
        }
        pool
    }

    #[test]
    fn frontmatter_formats_empty_arrays_inline() {
        let markdown = format_memory_markdown(
            "run_1",
            "run",
            "thread",
            "thread_1",
            "Title",
            "2026-06-01T00:00:00Z",
            10,
            &[],
            &[],
            "Body",
        );

        assert!(markdown.contains("\nsource_ids: []\n"));
        assert!(markdown.contains("\nparent_ids: []\n"));
        assert!(!markdown.contains("source_ids:\n[]"));
    }

    #[test]
    fn frontmatter_formats_non_empty_arrays_as_yaml_lists() {
        let markdown = format_memory_markdown(
            "summary_1",
            "summary",
            "task",
            "task_1",
            "Title",
            "2026-06-01T00:00:00Z",
            10,
            &["msg:1".to_owned()],
            &["run:1".to_owned()],
            "Body",
        );

        assert!(markdown.contains("\nsource_ids:\n  - \"msg:1\"\n"));
        assert!(markdown.contains("\nparent_ids:\n  - \"run:1\"\n"));
    }

    #[test]
    fn memory_snippet_handles_non_ascii_query_without_panicking() {
        let snippet = memory_snippet("前文包含一些中文内容，然后讨论这个方案继续推进。", "方案");

        assert!(snippet.contains("方案"));
    }

    #[test]
    fn read_item_content_rejects_paths_outside_memory_root() {
        let base = std::env::temp_dir().join(format!("lantor-md-memory-test-{}", Uuid::new_v4()));
        let root = base.join("memory");
        fs::create_dir_all(&root).expect("create memory root");
        fs::write(root.join("inside.md"), "inside").expect("write inside");
        fs::write(base.join("outside.md"), "outside").expect("write outside");

        assert!(read_item_content(&root, "inside.md").is_ok());
        assert!(read_item_content(&root, "../outside.md").is_err());

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn rebuild_manifest_from_markdown_indexes_generated_files() {
        let base = std::env::temp_dir().join(format!("lantor-md-memory-test-{}", Uuid::new_v4()));
        let root = base.join("memory");
        let run_dir = root.join("runs/2026-06-01");
        fs::create_dir_all(&run_dir).expect("create run dir");
        fs::write(
            run_dir.join("run_1.md"),
            format_memory_markdown(
                "run_1",
                "run",
                "thread",
                "thread_1",
                "Title",
                "2026-06-01T00:00:00Z",
                10,
                &["msg:1".to_owned()],
                &[],
                "Body",
            ),
        )
        .expect("write run");

        let items = rebuild_manifest_from_markdown(&root).expect("rebuild manifest items");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "run_1");
        assert_eq!(items[0].path, "runs/2026-06-01/run_1.md");
        assert_eq!(items[0].source_ids, vec!["msg:1"]);

        let _ = fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn append_search_read_and_rebuild_round_trip() {
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

        let memory_id = append_run_summary(
            &pool,
            agent_id,
            run_id,
            Some("记忆方案"),
            "本轮讨论了 md 记忆方案继续推进。",
            &["msg:1".to_owned()],
        )
        .await
        .expect("append run summary");
        let found = search(
            &pool,
            agent_id,
            &json!({
                "query": "方案",
                "scope_type": "thread",
                "scope_id": thread_root_id.to_string()
            }),
        )
        .await
        .expect("search memory");
        assert_eq!(found["items"][0]["id"], memory_id);
        assert!(found["items"][0]["snippet"]
            .as_str()
            .expect("snippet")
            .contains("方案"));

        let loaded = read(&pool, agent_id, &json!({ "id": memory_id }))
            .await
            .expect("read memory");
        assert!(loaded["content"]
            .as_str()
            .expect("content")
            .contains("md 记忆方案"));

        fs::remove_file(base.join("memory/manifest.json")).expect("remove manifest");
        let rebuilt = rebuild_manifest(&pool, agent_id)
            .await
            .expect("rebuild manifest");
        assert_eq!(rebuilt, 1);
        let found_after_rebuild = search(&pool, agent_id, &json!({ "query": "继续" }))
            .await
            .expect("search rebuilt memory");
        assert_eq!(found_after_rebuild["items"][0]["id"], memory_id);

        let _ = fs::remove_dir_all(base);
    }
}
