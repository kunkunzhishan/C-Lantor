use std::{
    env,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::{db_connect, db_url, expand_home_path, notify_ui_refresh, to_string, CommandResult};

const CODEXLOOP_BIN_ENV: &str = "LANTOR_CODEXLOOP_BIN";
const LEGACY_DONE_STATUS: &str = "完成";
const LEGACY_FAILED_STATUS: &str = "失败";
const LEGACY_BLOCKED_STATUS: &str = "阻塞";
const LEGACY_STOPPING_STATUS: &str = "停止中";
const LEGACY_STOPPED_STATUS: &str = "已停止";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LongTask {
    pub(crate) id: String,
    pub(crate) workspace: String,
    pub(crate) title: String,
    pub(crate) created_at: String,
    #[serde(skip_serializing)]
    pub(crate) monitor_snapshot: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LongTaskListItem {
    #[serde(flatten)]
    pub(crate) task: LongTask,
    pub(crate) monitor: Option<Value>,
    pub(crate) error: Option<String>,
    pub(crate) archived: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LongTaskInspectResult {
    #[serde(flatten)]
    pub(crate) task: LongTask,
    pub(crate) monitor: Option<Value>,
    pub(crate) detail: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LongTaskCreateResult {
    #[serde(flatten)]
    pub(crate) task: LongTask,
    pub(crate) monitor: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LongTaskCreateOptions {
    pub(crate) workspace: String,
    pub(crate) title: String,
    pub(crate) task: String,
    pub(crate) max_loops: Option<i64>,
    pub(crate) approval: Option<bool>,
    pub(crate) task_mode: Option<String>,
    pub(crate) funder_mode: Option<String>,
}

fn normalize_workspace(workspace: &str) -> CommandResult<String> {
    let expanded = expand_home_path(workspace);
    let trimmed = expanded.trim();
    if trimmed.is_empty() {
        return Err("workspace is required".to_owned());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("workspace must be an absolute path".to_owned());
    }
    if !path.exists() {
        return Err(format!("workspace does not exist: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("workspace is not a directory: {}", path.display()));
    }
    path.canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|err| format!("failed to canonicalize workspace {}: {err}", path.display()))
}

fn canonicalize_workspace_lossy(workspace: &str) -> String {
    let expanded = expand_home_path(workspace);
    let trimmed = expanded.trim();
    if trimmed.is_empty() {
        return workspace.to_owned();
    }
    let path = PathBuf::from(trimmed);
    path.canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| trimmed.to_owned())
}

fn normalize_task_mode(value: Option<&str>) -> CommandResult<String> {
    let mode = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("restart");
    if !matches!(mode, "continue" | "restart") {
        return Err("taskMode must be continue or restart".to_owned());
    }
    Ok(mode.to_owned())
}

fn normalize_funder_mode(value: Option<&str>) -> CommandResult<String> {
    let mode = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("worker");
    if !matches!(mode, "worker" | "founder") {
        return Err("funderMode must be worker or founder".to_owned());
    }
    Ok(mode.to_owned())
}

fn normalize_max_loops(value: Option<i64>) -> CommandResult<i64> {
    let value = value.unwrap_or(20);
    if value < 1 {
        return Err("maxLoops must be a positive integer".to_owned());
    }
    Ok(value)
}

fn new_long_task_id() -> String {
    let stamp = Utc::now().format("%Y%m%d").to_string();
    let suffix = uuid::Uuid::new_v4()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>();
    format!("lt_{stamp}_{suffix}")
}

fn row_to_long_task(row: &sqlx::sqlite::SqliteRow) -> LongTask {
    let workspace: String = row.get("workspace");
    LongTask {
        id: row.get("id"),
        workspace: canonicalize_workspace_lossy(&workspace),
        title: row.get("title"),
        created_at: row.get("created_at"),
        monitor_snapshot: row.get("monitor_snapshot"),
    }
}

pub(crate) async fn load_long_tasks(pool: &SqlitePool) -> CommandResult<Vec<LongTask>> {
    let rows = sqlx::query(
        r#"
        select id, workspace, title, created_at, monitor_snapshot
        from long_tasks
        order by workspace asc, created_at desc, id desc
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(to_string)?;
    let mut tasks = rows.iter().map(row_to_long_task).collect::<Vec<_>>();
    tasks.sort_by(|left, right| {
        left.workspace
            .cmp(&right.workspace)
            .then_with(|| right.created_at.cmp(&left.created_at))
            .then_with(|| right.id.cmp(&left.id))
    });
    Ok(tasks)
}

pub(crate) async fn resolve_long_task(pool: &SqlitePool, task_id: &str) -> CommandResult<LongTask> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err("taskId is required".to_owned());
    }
    let row = sqlx::query(
        r#"
        select id, workspace, title, created_at, monitor_snapshot
        from long_tasks
        where id = $1
        "#,
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await
    .map_err(to_string)?;
    row.as_ref()
        .map(row_to_long_task)
        .ok_or_else(|| format!("unknown long task id: {task_id}"))
}

fn env_codexloop_candidate() -> Option<PathBuf> {
    let value = env::var(CODEXLOOP_BIN_ENV).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(expand_home_path(trimmed));
    if path.is_dir() {
        return Some(path.join("bin").join("codexloop.js"));
    }
    Some(path)
}

fn sibling_codexloop_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        if let Some(parent) = cwd.parent() {
            candidates.push(
                parent
                    .join("agent2long-dev")
                    .join("bin")
                    .join("codexloop.js"),
            );
            candidates.push(parent.join("agent2long").join("bin").join("codexloop.js"));
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(repo_dir) = manifest_dir.parent() {
        if let Some(parent) = repo_dir.parent() {
            candidates.push(
                parent
                    .join("agent2long-dev")
                    .join("bin")
                    .join("codexloop.js"),
            );
            candidates.push(parent.join("agent2long").join("bin").join("codexloop.js"));
        }
    }
    candidates
}

fn resolve_codexloop_bin() -> String {
    if let Some(path) = env_codexloop_candidate().filter(|path| path.exists()) {
        return path.to_string_lossy().to_string();
    }
    for candidate in sibling_codexloop_candidates() {
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }
    "codexloop".to_owned()
}

fn build_codexloop_command(args: &[String]) -> Command {
    let bin = resolve_codexloop_bin();
    let mut command = if bin.ends_with(".js") {
        let mut command = Command::new("node");
        command.arg(bin);
        command
    } else {
        Command::new(bin)
    };
    command.args(args);
    command.env("LANTOR_DATABASE_URL", db_url());
    command
}

fn build_background_codexloop_command(args: &[String]) -> Command {
    let mut command = build_codexloop_command(args);
    #[cfg(unix)]
    command.process_group(0);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

async fn run_codexloop_json(args: Vec<String>) -> CommandResult<Value> {
    let output = build_codexloop_command(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(to_string)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            format!("codexloop failed: {stdout}")
        } else {
            stderr
        });
    }
    serde_json::from_str(&stdout).map_err(|err| {
        format!(
            "codexloop returned invalid JSON: {err}; stdout={}",
            stdout.chars().take(800).collect::<String>()
        )
    })
}

async fn run_codexloop_control(args: Vec<String>) -> CommandResult<Value> {
    run_codexloop_json(args).await
}

fn event_command(task_id: &str) -> CommandResult<String> {
    let exe = env::current_exe().map_err(to_string)?;
    Ok(format!(
        "\"{}\" --agent-context-tool long-task-event --task-id {}",
        exe.to_string_lossy().replace('"', "\\\""),
        task_id
    ))
}

fn long_task_active(monitor: Option<&Value>) -> bool {
    let Some(monitor) = monitor else {
        return true;
    };
    let status = monitor
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    !matches!(
        status,
        LEGACY_DONE_STATUS
            | LEGACY_FAILED_STATUS
            | LEGACY_BLOCKED_STATUS
            | LEGACY_STOPPED_STATUS
            | "done"
            | "failed"
            | "blocked"
            | "stopped"
    )
}

fn monitor_status(monitor: &Value) -> &str {
    monitor
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn monitor_snapshot(task: &LongTask) -> Option<Value> {
    task.monitor_snapshot
        .as_deref()
        .and_then(|snapshot| serde_json::from_str(snapshot).ok())
}

fn stop_pending_snapshot(task: &LongTask) -> Option<Value> {
    monitor_snapshot(task).filter(|snapshot| {
        matches!(
            monitor_status(snapshot),
            LEGACY_STOPPING_STATUS | "stopping"
        ) && long_task_active(Some(snapshot))
    })
}

fn with_stop_pending_status(mut monitor: Value) -> Value {
    if let Some(object) = monitor.as_object_mut() {
        object.insert("status".to_owned(), Value::String("stopping".to_owned()));
        object.insert(
            "updatedAt".to_owned(),
            Value::String(Utc::now().to_rfc3339()),
        );
    }
    monitor
}

fn apply_stop_pending_snapshot(task: &LongTask, live_monitor: Value) -> Value {
    if stop_pending_snapshot(task).is_some() && long_task_active(Some(&live_monitor)) {
        return with_stop_pending_status(live_monitor);
    }
    live_monitor
}

fn archived_monitor(task: &LongTask) -> Value {
    if let Some(snapshot) = monitor_snapshot(task) {
        return snapshot;
    }
    json!({
        "taskId": Value::Null,
        "workspace": task.workspace,
        "title": task.title,
        "status": "done",
        "current": "Archived because a newer long task exists in the same directory.",
        "loopCount": 0,
        "progress": "-",
        "updatedAt": task.created_at
    })
}

async fn save_monitor_snapshot(
    pool: &SqlitePool,
    task_id: &str,
    monitor: &Value,
) -> CommandResult<()> {
    let snapshot = serde_json::to_string(monitor).map_err(to_string)?;
    sqlx::query(
        r#"
        update long_tasks
        set monitor_snapshot = $1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $2
        "#,
    )
    .bind(snapshot)
    .bind(task_id)
    .execute(pool)
    .await
    .map_err(to_string)?;
    Ok(())
}

async fn latest_task_id_for_workspace(
    pool: &SqlitePool,
    workspace: &str,
) -> CommandResult<Option<String>> {
    let workspace = canonicalize_workspace_lossy(workspace);
    Ok(load_long_tasks(pool)
        .await?
        .into_iter()
        .find(|task| task.workspace == workspace)
        .map(|task| task.id))
}

async fn task_is_latest(pool: &SqlitePool, task: &LongTask) -> CommandResult<bool> {
    Ok(latest_task_id_for_workspace(pool, &task.workspace)
        .await?
        .as_deref()
        == Some(task.id.as_str()))
}

async fn monitor_workspace(workspace: &str) -> CommandResult<Value> {
    run_codexloop_json(vec![
        "monitor".to_owned(),
        "--workspace".to_owned(),
        workspace.to_owned(),
        "--json".to_owned(),
        "--lang".to_owned(),
        "en".to_owned(),
    ])
    .await
}

async fn inspect_workspace(workspace: &str) -> CommandResult<Value> {
    run_codexloop_json(vec![
        "inspect".to_owned(),
        "--workspace".to_owned(),
        workspace.to_owned(),
        "--json".to_owned(),
        "--lang".to_owned(),
        "en".to_owned(),
    ])
    .await
}

pub(crate) async fn long_task_list_in_pool(
    pool: &SqlitePool,
) -> CommandResult<Vec<LongTaskListItem>> {
    let tasks = load_long_tasks(pool).await?;
    let mut items = Vec::with_capacity(tasks.len());
    let mut seen_workspaces = std::collections::HashSet::new();
    for task in tasks {
        let is_latest = seen_workspaces.insert(task.workspace.clone());
        if !is_latest {
            items.push(LongTaskListItem {
                monitor: Some(archived_monitor(&task)),
                task,
                error: None,
                archived: true,
            });
            continue;
        }
        match monitor_workspace(&task.workspace).await {
            Ok(monitor) => {
                let monitor = apply_stop_pending_snapshot(&task, monitor);
                let _ = save_monitor_snapshot(pool, &task.id, &monitor).await;
                items.push(LongTaskListItem {
                    task,
                    monitor: Some(monitor),
                    error: None,
                    archived: false,
                });
            }
            Err(error) => items.push(LongTaskListItem {
                task,
                monitor: None,
                error: Some(error),
                archived: false,
            }),
        }
    }
    Ok(items)
}

async fn long_task_monitor_in_pool(pool: &SqlitePool, task_id: &str) -> CommandResult<Value> {
    let task = resolve_long_task(pool, task_id).await?;
    if !task_is_latest(pool, &task).await? {
        return Ok(archived_monitor(&task));
    }
    let monitor = apply_stop_pending_snapshot(&task, monitor_workspace(&task.workspace).await?);
    let _ = save_monitor_snapshot(pool, &task.id, &monitor).await;
    Ok(monitor)
}

pub(crate) async fn long_task_inspect_in_pool(
    pool: &SqlitePool,
    task_id: &str,
) -> CommandResult<LongTaskInspectResult> {
    let task = resolve_long_task(pool, task_id).await?;
    if !task_is_latest(pool, &task).await? {
        let monitor = archived_monitor(&task);
        let detail = json!({
            "taskId": monitor.get("taskId").cloned().unwrap_or(Value::Null),
            "loopCount": monitor.get("loopCount").and_then(Value::as_i64).unwrap_or(0),
            "currentJudgment": monitor.get("current").and_then(Value::as_str).unwrap_or("Archived."),
            "recentOutput": Value::Null,
            "checklist": [],
            "risks": ["This task is archived because a newer long task exists in the same directory."],
            "archived": true,
            "actions": {
                "canSteer": false,
                "canApprove": false,
                "canReject": false,
                "canSetApprovalMode": false,
                "canStop": false
            }
        });
        return Ok(LongTaskInspectResult {
            task,
            monitor: Some(monitor),
            detail,
        });
    }
    let monitor = monitor_workspace(&task.workspace)
        .await
        .ok()
        .map(|monitor| apply_stop_pending_snapshot(&task, monitor));
    if let Some(monitor) = monitor.as_ref() {
        let _ = save_monitor_snapshot(pool, &task.id, monitor).await;
    }
    let detail = inspect_workspace(&task.workspace).await?;
    Ok(LongTaskInspectResult {
        task,
        monitor,
        detail,
    })
}

pub(crate) async fn long_task_create_in_pool(
    pool: &SqlitePool,
    options: LongTaskCreateOptions,
) -> CommandResult<LongTaskCreateResult> {
    let workspace = normalize_workspace(&options.workspace)?;
    let title = options.title.trim();
    if title.is_empty() {
        return Err("title is required".to_owned());
    }
    let task_text = options.task.trim();
    if task_text.is_empty() {
        return Err("task is required".to_owned());
    }
    let max_loops = normalize_max_loops(options.max_loops)?;
    let task_mode = normalize_task_mode(options.task_mode.as_deref())?;
    let funder_mode = normalize_funder_mode(options.funder_mode.as_deref())?;
    let approval = options.approval.unwrap_or(true);

    if let Some(existing_id) = latest_task_id_for_workspace(pool, &workspace).await? {
        let existing_task = resolve_long_task(pool, &existing_id).await?;
        let monitor = monitor_workspace(&existing_task.workspace).await.ok();
        let active = if let Some(monitor) = monitor.as_ref() {
            long_task_active(Some(monitor))
        } else {
            long_task_active(monitor_snapshot(&existing_task).as_ref())
        };
        if active {
            return Err(format!(
                "workspace already has active long task {}",
                existing_task.id
            ));
        }
        if let Some(monitor) = monitor.as_ref() {
            let _ = save_monitor_snapshot(pool, &existing_task.id, monitor).await;
        }
    }

    let id = new_long_task_id();
    sqlx::query(
        r#"
        insert into long_tasks (id, workspace, title)
        values ($1, $2, $3)
        "#,
    )
    .bind(&id)
    .bind(&workspace)
    .bind(title)
    .execute(pool)
    .await
    .map_err(to_string)?;

    let mut args = vec![
        "start".to_owned(),
        "--task".to_owned(),
        task_text.to_owned(),
        "--workspace".to_owned(),
        workspace.clone(),
        "--max-loops".to_owned(),
        max_loops.to_string(),
        "--task-mode".to_owned(),
        task_mode,
        "--funder-mode".to_owned(),
        funder_mode,
        "--event-command".to_owned(),
        event_command(&id)?,
        "--json".to_owned(),
        "--lang".to_owned(),
        "en".to_owned(),
    ];
    if approval {
        args.push("--approval".to_owned());
    }

    let spawn_result = build_background_codexloop_command(&args).spawn();

    let mut child = match spawn_result {
        Ok(child) => child,
        Err(err) => {
            let _ = sqlx::query("delete from long_tasks where id = $1")
                .bind(&id)
                .execute(pool)
                .await;
            return Err(err.to_string());
        }
    };
    match timeout(Duration::from_millis(750), child.wait()).await {
        Ok(Ok(status)) => {
            let _ = sqlx::query("delete from long_tasks where id = $1")
                .bind(&id)
                .execute(pool)
                .await;
            return Err(format!("codexloop exited immediately with status {status}"));
        }
        Ok(Err(err)) => {
            let _ = sqlx::query("delete from long_tasks where id = $1")
                .bind(&id)
                .execute(pool)
                .await;
            return Err(err.to_string());
        }
        Err(_) => {}
    }

    let task = LongTask {
        id,
        workspace,
        title: title.to_owned(),
        created_at: Utc::now().to_rfc3339(),
        monitor_snapshot: None,
    };
    let _ = notify_ui_refresh(pool, "long_task_created").await;
    Ok(LongTaskCreateResult {
        task,
        monitor: None,
    })
}

pub(crate) async fn long_task_steer_in_pool(
    pool: &SqlitePool,
    task_id: &str,
    instruction: &str,
) -> CommandResult<Value> {
    let task = resolve_long_task(pool, task_id).await?;
    if !task_is_latest(pool, &task).await? {
        return Err("archived long task cannot be steered".to_owned());
    }
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return Err("instruction is required".to_owned());
    }
    let args = vec![
        "steer".to_owned(),
        "--workspace".to_owned(),
        task.workspace,
        "--instruction".to_owned(),
        instruction.to_owned(),
    ];
    build_background_codexloop_command(&args)
        .spawn()
        .map_err(to_string)?;
    let _ = notify_ui_refresh(pool, "long_task_steer").await;
    Ok(json!({ "queued": true }))
}

pub(crate) async fn long_task_control_in_pool(
    pool: &SqlitePool,
    task_id: &str,
    command: &str,
    reason: Option<&str>,
    mode: Option<&str>,
) -> CommandResult<Value> {
    let task = resolve_long_task(pool, task_id).await?;
    if !task_is_latest(pool, &task).await? {
        return Err("archived long task cannot be controlled".to_owned());
    }
    let workspace = task.workspace.clone();
    let mut args = vec![
        command.to_owned(),
        "--workspace".to_owned(),
        workspace,
        "--json".to_owned(),
    ];
    match command {
        "reject" => {
            let reason = reason
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "reason is required".to_owned())?;
            args.push("--reason".to_owned());
            args.push(reason.to_owned());
        }
        "approval" => {
            let mode = mode
                .map(str::trim)
                .filter(|value| matches!(*value, "auto" | "manual"))
                .ok_or_else(|| "mode must be auto or manual".to_owned())?;
            args.push("--mode".to_owned());
            args.push(mode.to_owned());
        }
        "approve" | "stop" => {}
        other => return Err(format!("unsupported long task control command: {other}")),
    }
    let result = run_codexloop_control(args).await?;
    if command == "stop" {
        let monitor = monitor_workspace(&task.workspace)
            .await
            .ok()
            .or_else(|| monitor_snapshot(&task))
            .map(|monitor| {
                if long_task_active(Some(&monitor)) {
                    with_stop_pending_status(monitor)
                } else {
                    monitor
                }
            });
        if let Some(monitor) = monitor.as_ref() {
            let _ = save_monitor_snapshot(pool, &task.id, monitor).await;
        }
    }
    let _ = notify_ui_refresh(pool, "long_task_control").await;
    Ok(result)
}

pub(crate) async fn handle_long_task_event(task_id: &str) -> CommandResult<String> {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let pool = db_connect(2).await.map_err(to_string)?;
    let _ = resolve_long_task(&pool, task_id).await?;
    notify_ui_refresh(&pool, "long_task_event").await?;
    Ok(format!("long task event accepted for {task_id}"))
}

pub(crate) async fn context_tool_long_task(args: &[String]) -> CommandResult<String> {
    let pool = db_connect(2).await.map_err(to_string)?;
    let command = args.first().map(String::as_str).unwrap_or("");
    match command {
        "long-task-create" => {
            let options = LongTaskCreateOptions {
                workspace: arg_value(args, "--workspace")
                    .ok_or_else(|| "--workspace is required".to_owned())?,
                title: arg_value(args, "--title")
                    .ok_or_else(|| "--title is required".to_owned())?,
                task: arg_value(args, "--task").ok_or_else(|| "--task is required".to_owned())?,
                max_loops: arg_value(args, "--max-loops")
                    .map(|value| value.parse::<i64>())
                    .transpose()
                    .map_err(|_| "--max-loops must be an integer".to_owned())?,
                approval: Some(!has_arg(args, "--no-approval")),
                task_mode: arg_value(args, "--task-mode"),
                funder_mode: arg_value(args, "--funder-mode"),
            };
            serde_json::to_string_pretty(&long_task_create_in_pool(&pool, options).await?)
                .map_err(to_string)
        }
        "long-task-list" => {
            serde_json::to_string_pretty(&long_task_list_in_pool(&pool).await?).map_err(to_string)
        }
        "long-task-monitor" => {
            let task_id =
                arg_value(args, "--task-id").ok_or_else(|| "--task-id is required".to_owned())?;
            serde_json::to_string_pretty(&long_task_monitor_in_pool(&pool, &task_id).await?)
                .map_err(to_string)
        }
        "long-task-inspect" => {
            let task_id =
                arg_value(args, "--task-id").ok_or_else(|| "--task-id is required".to_owned())?;
            serde_json::to_string_pretty(&long_task_inspect_in_pool(&pool, &task_id).await?)
                .map_err(to_string)
        }
        "long-task-steer" => {
            let task_id =
                arg_value(args, "--task-id").ok_or_else(|| "--task-id is required".to_owned())?;
            let instruction = arg_value(args, "--instruction")
                .ok_or_else(|| "--instruction is required".to_owned())?;
            serde_json::to_string_pretty(
                &long_task_steer_in_pool(&pool, &task_id, &instruction).await?,
            )
            .map_err(to_string)
        }
        "long-task-approve" => {
            let task_id =
                arg_value(args, "--task-id").ok_or_else(|| "--task-id is required".to_owned())?;
            serde_json::to_string_pretty(
                &long_task_control_in_pool(&pool, &task_id, "approve", None, None).await?,
            )
            .map_err(to_string)
        }
        "long-task-reject" => {
            let task_id =
                arg_value(args, "--task-id").ok_or_else(|| "--task-id is required".to_owned())?;
            let reason =
                arg_value(args, "--reason").ok_or_else(|| "--reason is required".to_owned())?;
            serde_json::to_string_pretty(
                &long_task_control_in_pool(&pool, &task_id, "reject", Some(&reason), None).await?,
            )
            .map_err(to_string)
        }
        "long-task-approval" => {
            let task_id =
                arg_value(args, "--task-id").ok_or_else(|| "--task-id is required".to_owned())?;
            let mode = arg_value(args, "--mode").ok_or_else(|| "--mode is required".to_owned())?;
            serde_json::to_string_pretty(
                &long_task_control_in_pool(&pool, &task_id, "approval", None, Some(&mode)).await?,
            )
            .map_err(to_string)
        }
        "long-task-stop" => {
            let task_id =
                arg_value(args, "--task-id").ok_or_else(|| "--task-id is required".to_owned())?;
            serde_json::to_string_pretty(
                &long_task_control_in_pool(&pool, &task_id, "stop", None, None).await?,
            )
            .map_err(to_string)
        }
        "long-task-event" => {
            let task_id =
                arg_value(args, "--task-id").ok_or_else(|| "--task-id is required".to_owned())?;
            handle_long_task_event(&task_id).await
        }
        _ => Err(format!("unknown long task context tool command: {command}")),
    }
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|window| (window[0] == name).then(|| window[1].clone()))
}

fn has_arg(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

#[allow(dead_code)]
fn _is_path_like(value: &str) -> bool {
    value.contains('/') || Path::new(value).is_absolute()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use std::{env, fs};

    use super::{
        apply_stop_pending_snapshot, long_task_active, normalize_max_loops, normalize_task_mode,
        normalize_workspace, LongTask,
    };

    #[test]
    fn normalize_task_mode_defaults_to_restart() {
        assert_eq!(normalize_task_mode(None).unwrap(), "restart");
        assert_eq!(normalize_task_mode(Some("continue")).unwrap(), "continue");
        assert!(normalize_task_mode(Some("new")).is_err());
    }

    #[test]
    fn normalize_max_loops_requires_positive_integer() {
        assert_eq!(normalize_max_loops(None).unwrap(), 20);
        assert_eq!(normalize_max_loops(Some(3)).unwrap(), 3);
        assert!(normalize_max_loops(Some(0)).is_err());
    }

    #[test]
    fn normalize_workspace_canonicalizes_dot_segments() {
        let root = env::temp_dir().join(format!("lantor-long-task-test-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        let input = workspace.join(".");
        assert_eq!(
            normalize_workspace(input.to_string_lossy().as_ref()).unwrap(),
            workspace
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .to_string()
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn long_task_active_treats_terminal_statuses_as_inactive() {
        assert!(long_task_active(None));
        assert!(long_task_active(Some(&json!({ "status": "运行中" }))));
        assert!(long_task_active(Some(&json!({ "status": "停止中" }))));
        assert!(!long_task_active(Some(&json!({ "status": "完成" }))));
        assert!(!long_task_active(Some(&json!({ "status": "阻塞" }))));
        assert!(!long_task_active(Some(&json!({ "status": "已停止" }))));
        assert!(!long_task_active(Some(&json!({ "status": "blocked" }))));
        assert!(!long_task_active(Some(&json!({ "status": "failed" }))));
        assert!(!long_task_active(Some(&json!({ "status": "stopped" }))));
    }

    #[test]
    fn stop_pending_snapshot_overlays_active_live_monitor() {
        let task = LongTask {
            id: "lt_test".to_owned(),
            workspace: "/tmp".to_owned(),
            title: "Task".to_owned(),
            created_at: "2026-05-24T00:00:00Z".to_owned(),
            monitor_snapshot: Some(json!({ "status": "停止中" }).to_string()),
        };
        let monitor = apply_stop_pending_snapshot(
            &task,
            json!({
                "status": "运行中",
                "current": "Still draining",
                "updatedAt": "2026-05-24T00:00:01Z"
            }),
        );

        assert_eq!(
            monitor.get("status").and_then(|value| value.as_str()),
            Some("stopping")
        );
        assert_eq!(
            monitor.get("current").and_then(|value| value.as_str()),
            Some("Still draining")
        );
    }

    #[test]
    fn stop_pending_snapshot_does_not_mask_terminal_live_monitor() {
        let task = LongTask {
            id: "lt_test".to_owned(),
            workspace: "/tmp".to_owned(),
            title: "Task".to_owned(),
            created_at: "2026-05-24T00:00:00Z".to_owned(),
            monitor_snapshot: Some(json!({ "status": "停止中" }).to_string()),
        };
        let monitor = apply_stop_pending_snapshot(&task, json!({ "status": "已停止" }));

        assert_eq!(
            monitor.get("status").and_then(|value| value.as_str()),
            Some("已停止")
        );
    }
}
