use std::{
    collections::{BTreeMap, HashMap},
    convert::Infallible,
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    body::{to_bytes, Body},
    extract::{DefaultBodyLimit, Path as AxumPath, Query, Request, State},
    http::{header, HeaderValue, StatusCode, Uri},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use tokio::{
    net::TcpListener,
    sync::Notify,
    time::{sleep, Duration},
};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
};
use uuid::Uuid;

use crate::call_mode::{
    call_dispatch_cancel_work_in_pool, call_dispatch_resolve_confirmation_in_pool,
    call_session_start_with_options_in_pool, call_session_stop_in_pool,
    call_session_submit_text_utterance_in_pool, call_session_submit_utterance_in_pool,
    fetch_call_history_page, CallUtteranceSubmitRequest,
};
use crate::launch_agent;
use crate::long_task::{
    long_task_control_in_pool, long_task_create_in_pool, long_task_inspect_in_pool,
    long_task_list_in_pool, long_task_steer_in_pool, LongTaskCreateOptions,
};
use crate::models::AttachmentUpload;
use crate::tools::{ToolEvent, ToolHost};
use crate::tts::{self, TtsSynthesisRequest};
use crate::voice::{self, VoiceTranscriptionError, VoiceTranscriptionRequest};
use crate::{
    add_agent_to_channel, agent_workspace_list_in_pool, agent_workspace_read_file_in_pool,
    append_ui_refresh_metrics_log, cancel_agent_work_in_pool, cancel_reminder_in_pool,
    check_runtime_in_env, claim_task_in_pool, complete_reminder_in_pool,
    complete_todo_item_in_pool, create_agent_in_pool, create_channel_in_pool,
    create_todo_item_in_pool, delete_agent_in_pool, delete_channel_in_pool,
    delete_event_hook_in_pool, delete_todo_item_in_pool, dismiss_inbox_items_in_pool,
    fetch_messages_in_pool, forward_task_in_pool, load_artifact, load_bootstrap,
    load_ui_backend_event_payload, mark_all_owner_inbox_read_in_pool, mark_channel_read_in_pool,
    mark_inbox_items_read_in_pool, notify_ui_refresh, open_dm_with_agent_in_pool,
    process_hook_ingress_in_pool, reassign_agent_work_in_pool, retry_agent_work_in_pool,
    send_owner_message_in_pool, set_channel_agent_membership_in_pool, set_message_saved_in_pool,
    set_message_todo_in_pool, start_agent_in_pool, to_string, update_agent_in_pool,
    update_agent_schedule_status_in_pool, update_channel_in_pool, update_owner_profile_in_pool,
    update_task_status_in_pool, update_task_title_in_pool, FetchMessagesRequest,
};

const WEB_SEND_MESSAGE_BODY_LIMIT: usize = 128 * 1024 * 1024;
const WEB_TRANSCRIBE_VOICE_AUDIO_BODY_LIMIT: usize = 128 * 1024 * 1024;
const WEB_HOOK_INGRESS_BODY_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone)]
struct WebState {
    pool: SqlitePool,
    db_url: String,
    web_token: Option<String>,
    trigger_notifier: Arc<Notify>,
}

#[derive(Serialize)]
struct ApiError {
    ok: bool,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageRequest {
    channel_id: Uuid,
    thread_root_id: Option<Uuid>,
    body: String,
    as_task: bool,
    attachments: Option<Vec<AttachmentUpload>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCheckRequest {
    runtime: String,
}

#[derive(Deserialize)]
struct RecordUiRefreshMetricRequest {
    metric: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelIdRequest {
    channel_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateChannelRequest {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    agent_ids: Option<Vec<Uuid>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateChannelRequest {
    channel_id: Uuid,
    name: String,
    description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetChannelAgentMembershipRequest {
    channel_id: Uuid,
    agent_id: Uuid,
    member: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReminderIdRequest {
    reminder_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleStatusRequest {
    schedule_id: Uuid,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookIdRequest {
    hook_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DismissInboxItemRequest {
    item_id: String,
    dismissed_until: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DismissInboxItemsRequest {
    items: Vec<DismissInboxItemRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactReadRequest {
    artifact_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetMessageSavedRequest {
    message_id: Uuid,
    saved: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetMessageTodoRequest {
    message_id: Uuid,
    todo: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteTodoItemRequest {
    todo_id: Uuid,
    done: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteTodoItemRequest {
    todo_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTodoItemRequest {
    summary: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdRequest {
    agent_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkItemIdRequest {
    work_item_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReassignAgentWorkRequest {
    work_item_id: Uuid,
    target_agent_id: Uuid,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LongTaskIdRequest {
    task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LongTaskSteerRequest {
    task_id: String,
    instruction: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LongTaskRejectRequest {
    task_id: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LongTaskApprovalRequest {
    task_id: String,
    mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskStatusRequest {
    task_id: Uuid,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskTitleRequest {
    task_id: Uuid,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimTaskRequest {
    task_id: Uuid,
    agent_id: Option<Uuid>,
    expected_version: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForwardTaskRequest {
    task_id: Uuid,
    target_agent_id: Uuid,
    interrupt_current: bool,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAgentRequest {
    handle: String,
    display_name: String,
    role: Option<String>,
    runtime: String,
    model: String,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    avatar: Option<String>,
    description: Option<String>,
    launch_command: String,
    working_directory: String,
    daily_budget_micros: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAgentRequest {
    agent_id: Uuid,
    handle: String,
    display_name: String,
    role: Option<String>,
    runtime: String,
    model: String,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    avatar: Option<String>,
    description: String,
    launch_command: String,
    working_directory: String,
    daily_budget_micros: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentWorkspaceRequest {
    agent_id: Uuid,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerProfileRequest {
    display_name: String,
    avatar: String,
    description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallSessionStartRequest {
    #[serde(default)]
    channel_id: Option<Uuid>,
    #[serde(default)]
    thread_root_id: Option<Uuid>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    wake_words: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallSessionIdRequest {
    session_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchCallHistoryRequest {
    before: DateTime<Utc>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallDispatchCancelWorkRequest {
    session_id: Uuid,
    work_item_id: Uuid,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallDispatchResolveConfirmationRequest {
    session_id: Uuid,
    transcript: String,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallTextUtteranceSubmitRequest {
    session_id: Uuid,
    transcript: String,
    #[serde(default)]
    thread_root_utterance_id: Option<Uuid>,
    #[serde(default)]
    language: Option<String>,
}

pub(crate) const DEFAULT_LANTOR_WEB_BIND: &str = "0.0.0.0:8787";

pub(crate) fn resolve_web_bind() -> Option<String> {
    match env::var("LANTOR_WEB_BIND") {
        Ok(value) => {
            let trimmed = value.trim().to_owned();
            if trimmed.is_empty() {
                return Some(DEFAULT_LANTOR_WEB_BIND.to_owned());
            }
            if matches!(
                trimmed.to_ascii_lowercase().as_str(),
                "off" | "none" | "disabled" | "false" | "0"
            ) {
                return None;
            }
            Some(trimmed)
        }
        Err(_) => Some(DEFAULT_LANTOR_WEB_BIND.to_owned()),
    }
}

pub(crate) fn spawn_web_server_if_configured(
    pool: SqlitePool,
    db_url: String,
    trigger_notifier: Arc<Notify>,
) {
    let Some(bind) = resolve_web_bind() else {
        return;
    };
    let Ok(addr) = bind.parse::<SocketAddr>() else {
        eprintln!("Lantor web access disabled: invalid LANTOR_WEB_BIND={bind}");
        return;
    };

    let dist_dir = web_dist_dir();
    tauri::async_runtime::spawn(async move {
        let state = Arc::new(WebState {
            pool,
            db_url,
            web_token: web_token(),
            trigger_notifier,
        });
        let app = web_router(state, dist_dir);
        match TcpListener::bind(addr).await {
            Ok(listener) => {
                eprintln!("Lantor web access listening on http://{addr}");
                if let Err(err) = axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .await
                {
                    eprintln!("Lantor web access stopped: {err}");
                }
            }
            Err(err) => {
                eprintln!("Lantor web access failed to bind {addr}: {err}");
            }
        }
    });
}

fn web_router(state: Arc<WebState>, dist_dir: PathBuf) -> Router {
    let index = dist_dir.join("index.html");
    let api = Router::new()
        .route("/api/health", get(api_health))
        .route("/api/bootstrap", get(api_bootstrap))
        .route("/api/fetch_messages", post(api_fetch_messages))
        .route("/api/fetch_call_history", post(api_fetch_call_history))
        .route("/api/check_runtime", post(api_check_runtime))
        .route(
            "/api/record_ui_refresh_metric",
            post(api_record_ui_refresh_metric),
        )
        .route("/api/events", get(api_events))
        .route("/api/attachments/{attachment_id}", get(api_attachment))
        .route(
            "/api/send_message",
            post(api_send_message).layer(DefaultBodyLimit::max(WEB_SEND_MESSAGE_BODY_LIMIT)),
        )
        .route(
            "/api/transcribe_voice_audio",
            post(api_transcribe_voice_audio)
                .layer(DefaultBodyLimit::max(WEB_TRANSCRIBE_VOICE_AUDIO_BODY_LIMIT)),
        )
        .route("/api/synthesize_tts_audio", post(api_synthesize_tts_audio))
        .route("/api/call_session_start", post(api_call_session_start))
        .route("/api/call_session_stop", post(api_call_session_stop))
        .route(
            "/api/call_dispatch_cancel_work",
            post(api_call_dispatch_cancel_work),
        )
        .route(
            "/api/call_dispatch_resolve_confirmation",
            post(api_call_dispatch_resolve_confirmation),
        )
        .route(
            "/api/call_session_submit_utterance",
            post(api_call_session_submit_utterance)
                .layer(DefaultBodyLimit::max(WEB_TRANSCRIBE_VOICE_AUDIO_BODY_LIMIT)),
        )
        .route(
            "/api/call_session_submit_text_utterance",
            post(api_call_session_submit_text_utterance),
        )
        .route("/api/create_channel", post(api_create_channel))
        .route("/api/update_channel", post(api_update_channel))
        .route("/api/delete_channel", post(api_delete_channel))
        .route("/api/create_agent", post(api_create_agent))
        .route("/api/update_agent", post(api_update_agent))
        .route("/api/delete_agent", post(api_delete_agent))
        .route("/api/start_agent", post(api_start_agent))
        .route(
            "/api/set_channel_agent_membership",
            post(api_set_channel_agent_membership),
        )
        .route("/api/set_message_saved", post(api_set_message_saved))
        .route("/api/set_message_todo", post(api_set_message_todo))
        .route("/api/create_todo_item", post(api_create_todo_item))
        .route("/api/delete_todo_item", post(api_delete_todo_item))
        .route("/api/complete_todo_item", post(api_complete_todo_item))
        .route("/api/update_owner_profile", post(api_update_owner_profile))
        .route("/api/dismiss_inbox_items", post(api_dismiss_inbox_items))
        .route(
            "/api/mark_inbox_items_read",
            post(api_mark_inbox_items_read),
        )
        .route("/api/mark_all_inbox_read", post(api_mark_all_inbox_read))
        .route("/api/mark_channel_read", post(api_mark_channel_read))
        .route("/api/complete_reminder", post(api_complete_reminder))
        .route("/api/cancel_reminder", post(api_cancel_reminder))
        .route(
            "/api/update_agent_schedule_status",
            post(api_update_agent_schedule_status),
        )
        .route("/api/delete_event_hook", post(api_delete_event_hook))
        .route("/api/update_task_status", post(api_update_task_status))
        .route("/api/update_task_title", post(api_update_task_title))
        .route("/api/claim_task", post(api_claim_task))
        .route("/api/forward_task", post(api_forward_task))
        .route("/api/long_task_create", post(api_long_task_create))
        .route("/api/long_task_list", post(api_long_task_list))
        .route("/api/long_task_inspect", post(api_long_task_inspect))
        .route("/api/long_task_steer", post(api_long_task_steer))
        .route("/api/long_task_approve", post(api_long_task_approve))
        .route("/api/long_task_reject", post(api_long_task_reject))
        .route("/api/long_task_approval", post(api_long_task_approval))
        .route("/api/long_task_stop", post(api_long_task_stop))
        .route("/api/cancel_agent_work", post(api_cancel_agent_work))
        .route("/api/reassign_agent_work", post(api_reassign_agent_work))
        .route("/api/retry_agent_work", post(api_retry_agent_work))
        .route(
            "/api/install_supervisor_service",
            post(api_install_supervisor_service),
        )
        .route(
            "/api/uninstall_supervisor_service",
            post(api_uninstall_supervisor_service),
        )
        .route("/api/artifact_read", post(api_artifact_read))
        .route("/api/open_dm_with_agent", post(api_open_dm_with_agent))
        .route("/api/agent_workspace_list", post(api_agent_workspace_list))
        .route(
            "/api/agent_workspace_read_file",
            post(api_agent_workspace_read_file),
        )
        .route("/tool/calendar", get(tool_calendar_preview))
        .route("/tool/monitoring", get(tool_monitoring_preview))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_web_auth,
        ))
        .route(
            "/api/hooks/{ingress_token}/ingress",
            post(api_hook_ingress).layer(DefaultBodyLimit::max(WEB_HOOK_INGRESS_BODY_LIMIT)),
        )
        .with_state(state);

    let router = if index.is_file() {
        let root_index = index.clone();
        let named_index = index.clone();
        api.route("/", get(move || serve_index(root_index.clone())))
            .route("/index.html", get(move || serve_index(named_index.clone())))
            .fallback_service(ServeDir::new(&dist_dir).fallback(ServeFile::new(index)))
    } else {
        api.fallback(get(move || missing_dist(dist_dir)))
    };
    router.layer(CompressionLayer::new())
}

#[derive(Debug, Deserialize)]
struct CalendarPreviewQuery {
    month: Option<String>,
    selected: Option<String>,
    view: Option<String>,
    title: Option<String>,
    events: Option<String>,
}

type CalendarPreviewEvent = ToolEvent;

#[derive(Debug, Deserialize)]
struct MonitoringPreviewQuery {
    scope: Option<String>,
    agent: Option<String>,
    window: Option<String>,
    bucket: Option<String>,
    metric: Option<String>,
    limit: Option<usize>,
}

async fn tool_monitoring_preview(
    State(state): State<Arc<WebState>>,
    Query(query): Query<MonitoringPreviewQuery>,
) -> Response {
    let scope = query
        .scope
        .as_deref()
        .and_then(normalize_monitoring_scope)
        .unwrap_or("global");
    let window = query
        .window
        .as_deref()
        .and_then(normalize_monitoring_window)
        .unwrap_or("24h");
    let bucket = query
        .bucket
        .as_deref()
        .and_then(normalize_monitoring_bucket)
        .unwrap_or("day");
    let metric = query
        .metric
        .as_deref()
        .and_then(normalize_monitoring_metric)
        .unwrap_or("total_tokens");
    let token_metric = if monitoring_metric_is_memory(metric) {
        "total_tokens"
    } else {
        metric
    };
    let limit = query.limit.unwrap_or(8).clamp(1, 25);
    let agent = query
        .agent
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut summary = ToolHost::new(&state.pool)
        .query_monitoring_summary(scope, agent, window, limit)
        .await
        .unwrap_or_else(|err| json!({ "error": err, "scope": scope, "window": window }));
    let handle = if scope == "agent" {
        agent.map(|value| value.trim().trim_start_matches('@'))
    } else {
        None
    };
    if scope == "compare" {
        if let Ok(series) = ToolHost::new(&state.pool)
            .query_monitoring_agent_time_series(
                summary.get("since").and_then(Value::as_str),
                bucket,
                token_metric,
            )
            .await
        {
            summary["agent_time_series"] = series;
        }
    } else if let Ok(series) = ToolHost::new(&state.pool)
        .query_monitoring_time_series(
            summary.get("since").and_then(Value::as_str),
            handle,
            bucket,
            token_metric,
        )
        .await
    {
        summary["time_series"] = series;
    }
    if let Ok(series) = ToolHost::new(&state.pool)
        .query_monitoring_memory_layer_time_series(
            summary.get("since").and_then(Value::as_str),
            handle,
            bucket,
        )
        .await
    {
        summary["memory_layer_time_series"] = series;
    }
    summary["bucket"] = json!(bucket);
    summary["metric"] = json!(token_metric);
    let html = monitoring_preview_html(&summary);
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-cache, no-store, must-revalidate"),
            ),
        ],
        html,
    )
        .into_response()
}

fn normalize_monitoring_scope(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "global" => Some("global"),
        "agent" => Some("agent"),
        "compare" => Some("compare"),
        _ => None,
    }
}

fn normalize_monitoring_window(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "24h" => Some("24h"),
        "7d" => Some("7d"),
        "30d" => Some("30d"),
        "all" => Some("all"),
        _ => None,
    }
}

fn normalize_monitoring_bucket(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "day" | "daily" | "days" => Some("day"),
        "week" | "weekly" | "weeks" => Some("week"),
        _ => None,
    }
}

fn normalize_monitoring_metric(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "total" | "total_tokens" | "tokens" => Some("total_tokens"),
        "input" | "input_tokens" => Some("input_tokens"),
        "output" | "output_tokens" => Some("output_tokens"),
        "cost" | "cost_usd" => Some("cost_usd"),
        "runs" => Some("runs"),
        "memory" | "memory_reads" | "memory_accesses" => Some("memory_reads"),
        "memory_bytes" | "memory_read_bytes" => Some("memory_read_bytes"),
        _ => None,
    }
}

fn monitoring_metric_is_memory(metric: &str) -> bool {
    matches!(metric, "memory_reads" | "memory_read_bytes")
}

async fn tool_calendar_preview(
    State(state): State<Arc<WebState>>,
    Query(query): Query<CalendarPreviewQuery>,
) -> Response {
    let today = Utc::now().date_naive();
    let month = query
        .month
        .as_deref()
        .and_then(parse_month)
        .unwrap_or_else(|| {
            first_day_of_month(today.year(), today.month()).expect("current month is valid")
        });
    let selected = query
        .selected
        .as_deref()
        .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
        .unwrap_or(today);
    let title = query
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Reminder calendar");
    let view = query
        .view
        .as_deref()
        .and_then(normalize_calendar_view)
        .unwrap_or("month");
    let weekday_offset = month.weekday().num_days_from_monday() as i64;
    let grid_start = month - chrono::Duration::days(weekday_offset);
    let grid_end = grid_start + chrono::Duration::days(41);
    let events = if let Some(events) = query.events.as_deref() {
        parse_calendar_preview_events(events)
    } else {
        ToolHost::new(&state.pool)
            .query_calendar_events(grid_start, grid_end)
            .await
            .unwrap_or_default()
    };
    let html = calendar_preview_html(month, selected, view, title, &events);
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-cache, no-store, must-revalidate"),
            ),
        ],
        html,
    )
        .into_response()
}

fn parse_month(value: &str) -> Option<NaiveDate> {
    let mut parts = value.trim().split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    first_day_of_month(year, month)
}

fn first_day_of_month(year: i32, month: u32) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(year, month, 1)
}

fn normalize_calendar_view(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "month" => Some("month"),
        "day" => Some("day"),
        "agenda" => Some("agenda"),
        _ => None,
    }
}

fn parse_calendar_preview_events(value: &str) -> Vec<CalendarPreviewEvent> {
    value
        .split(';')
        .filter_map(|part| {
            let mut fields = part.splitn(3, '|');
            let date = NaiveDate::parse_from_str(fields.next()?.trim(), "%Y-%m-%d").ok()?;
            let title = fields.next()?.trim();
            if title.is_empty() {
                return None;
            }
            let kind = fields
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("note");
            Some(CalendarPreviewEvent {
                date,
                time_label: String::new(),
                title: title.chars().take(48).collect(),
                kind: kind.chars().take(24).collect(),
                detail: String::new(),
            })
        })
        .take(24)
        .collect()
}

fn monitoring_preview_html(summary: &Value) -> String {
    let scope = summary
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("global");
    let window = summary
        .get("window")
        .and_then(Value::as_str)
        .unwrap_or("24h");
    let bucket = summary
        .get("bucket")
        .and_then(Value::as_str)
        .unwrap_or("day");
    let metric = summary
        .get("metric")
        .and_then(Value::as_str)
        .unwrap_or("total_tokens");
    let agents = summary
        .get("agents")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let selected_agent = summary.get("agent").unwrap_or(&Value::Null);
    let current_agent = selected_agent
        .get("handle")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let totals = if scope == "agent" {
        selected_agent
    } else {
        summary.get("global").unwrap_or(&Value::Null)
    };
    let series = summary
        .get("time_series")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let metric_label = monitoring_metric_label(metric);
    let metric_sum_label = monitoring_metric_sum_label(metric);
    let metric_total = monitoring_metric_display(totals, metric);
    let max_metric = series
        .iter()
        .map(|point| monitoring_metric_value(point, metric))
        .fold(0.0_f64, f64::max)
        .max(1.0);
    let compare_series = summary
        .get("agent_time_series")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let compare_model = if scope == "compare" {
        Some(monitoring_compare_model(compare_series, metric))
    } else {
        None
    };
    let chart_bars = match compare_model.as_ref() {
        Some(model) => monitoring_compare_chart_bars(model, metric),
        None => monitoring_chart_bars(series, metric, max_metric),
    };
    let memory_series = summary
        .get("memory_layer_time_series")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let memory_chart_bars = monitoring_memory_layer_chart_bars(memory_series);
    let memory_legend = monitoring_memory_layer_legend();
    let memory_inventory = summary.get("memory_inventory").unwrap_or(&Value::Null);
    let memory_inventory_chips = monitoring_memory_inventory_chips(memory_inventory);
    let legend = compare_model
        .as_ref()
        .map(monitoring_compare_legend)
        .unwrap_or_default();
    let subject = match scope {
        "agent" => monitoring_agent_label(selected_agent),
        "compare" => "Agent compare".to_owned(),
        _ => "All agents".to_owned(),
    };
    let window_controls = render_monitoring_dropdown(
        "Time",
        monitoring_control_label(window),
        render_monitoring_links(
            ["24h", "7d", "30d", "all"].as_slice(),
            window,
            |candidate| monitoring_view_url(scope, current_agent, candidate, bucket, metric, 12),
        ),
    );
    let bucket_controls = render_monitoring_dropdown(
        "Bucket",
        monitoring_control_label(bucket),
        render_monitoring_links(["day", "week"].as_slice(), bucket, |candidate| {
            monitoring_view_url(scope, current_agent, window, candidate, metric, 12)
        }),
    );
    let metric_controls = render_monitoring_dropdown(
        "Metric",
        monitoring_control_label(metric),
        render_monitoring_links(
            [
                "total_tokens",
                "input_tokens",
                "output_tokens",
                "cost_usd",
                "runs",
            ]
            .as_slice(),
            metric,
            |candidate| monitoring_view_url(scope, current_agent, window, bucket, candidate, 12),
        ),
    );
    let mut agent_links = vec![format!(
        r#"<a class="{}" href="{}">All</a>"#,
        if scope == "global" {
            "control active"
        } else {
            "control"
        },
        html_escape(&monitoring_view_url(
            "global", None, window, bucket, metric, 12
        ))
    )];
    agent_links.push(format!(
        r#"<a class="{}" href="{}">Compare</a>"#,
        if scope == "compare" {
            "control active"
        } else {
            "control"
        },
        html_escape(&monitoring_view_url(
            "compare", None, window, bucket, metric, 12
        ))
    ));
    let mut sorted_agents = agents.iter().collect::<Vec<_>>();
    sorted_agents.sort_by_key(|agent| monitoring_agent_label(agent).to_ascii_lowercase());
    agent_links.extend(sorted_agents.into_iter().map(|agent| {
        let handle = value_str(agent, "handle");
        let label = monitoring_agent_label(agent);
        let class = if scope == "agent" && current_agent == Some(handle) {
            "control active"
        } else {
            "control"
        };
        format!(
            r#"<a class="{class}" href="{}">{}</a>"#,
            html_escape(&monitoring_view_url(
                "agent",
                Some(handle),
                window,
                bucket,
                metric,
                12
            )),
            html_escape(&label)
        )
    }));
    let agent_controls = render_monitoring_dropdown("Agent", subject.clone(), agent_links.join(""));
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lantor Monitoring</title>
<style>
:root {{ color-scheme: light; --ink:#17202a; --muted:#64748b; --line:#d9dee7; --panel:#fff; --bg:#f5f7fb; --accent:#0f766e; --accent-2:#2563eb; --axis:#eef2f7; }}
* {{ box-sizing: border-box; }}
body {{ margin:0; min-height:100vh; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }}
.shell {{ width:100%; max-width:1120px; margin:0 auto; padding:28px; overflow:hidden; }}
.toolbar {{ display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:16px; }}
h1 {{ margin:0; font-size:24px; line-height:1.15; letter-spacing:0; }}
.muted {{ color:var(--muted); }}
.chip {{ border:1px solid var(--line); background:var(--panel); border-radius:7px; padding:5px 8px; font-size:12px; color:var(--muted); white-space:nowrap; }}
.controls {{ display:flex; flex-wrap:nowrap; gap:8px; margin-bottom:12px; align-items:start; overflow:visible; padding-bottom:2px; }}
.filter {{ position:relative; min-width:0; flex:1 1 0; }}
.filter summary {{ list-style:none; display:flex; align-items:center; justify-content:space-between; gap:8px; border:1px solid var(--line); background:#fff; border-radius:7px; padding:6px 8px; cursor:pointer; min-width:0; }}
.filter summary::-webkit-details-marker {{ display:none; }}
.filter-label {{ color:var(--muted); font-size:12px; line-height:1; white-space:nowrap; }}
.filter-label::after {{ content:":"; }}
.filter-value {{ color:#1f2937; font-size:13px; line-height:1; font-weight:680; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }}
.filter-current {{ display:flex; align-items:center; gap:5px; min-width:0; }}
.filter-arrow {{ color:#64748b; font-size:12px; line-height:1; transition:transform .12s ease; }}
.filter[open] .filter-arrow {{ transform:rotate(180deg); }}
.filter-menu {{ position:absolute; z-index:10; top:calc(100% + 5px); left:0; right:0; display:grid; gap:5px; min-width:170px; max-height:260px; overflow:auto; border:1px solid var(--line); background:#fff; border-radius:8px; padding:6px; box-shadow:0 14px 34px rgba(15,23,42,.14); }}
.control {{ flex:0 0 auto; border:1px solid var(--line); background:#fff; color:#334155; border-radius:7px; padding:7px 10px; font-size:13px; text-decoration:none; line-height:1; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
.filter-menu .control {{ display:block; max-width:none; width:100%; }}
.control.active {{ border-color:#0f766e; background:#e7f5f1; color:#0f4f49; font-weight:720; }}
.total {{ display:flex; margin:12px 0 14px; }}
.sum-chip {{ display:inline-flex; align-items:baseline; gap:10px; border:1px solid #b8d8d2; background:#f2fbf8; border-radius:7px; padding:8px 11px; }}
.sum-chip span {{ color:#0f4f49; font-size:12px; font-weight:720; text-transform:uppercase; }}
.sum-chip strong {{ color:#12302e; font-size:18px; line-height:1; font-variant-numeric: tabular-nums; }}
.chart {{ border:1px solid var(--line); background:#fff; border-radius:8px; padding:16px; min-height:382px; overflow:hidden; }}
.charts {{ display:grid; grid-template-columns:1fr; gap:14px; }}
.chart-title {{ display:flex; justify-content:space-between; gap:12px; align-items:baseline; margin-bottom:14px; }}
.chart-title h2 {{ margin:0; font-size:15px; }}
.legend {{ display:flex; flex-wrap:wrap; gap:8px 12px; margin:-4px 0 12px; color:#53657d; font-size:12px; }}
.stat-row {{ display:flex; flex-wrap:wrap; gap:8px; margin:-2px 0 12px; }}
.stat-chip {{ border:1px solid var(--line); border-radius:7px; padding:6px 8px; color:#334155; font-size:12px; background:#f8fafc; }}
.stat-chip strong {{ font-variant-numeric:tabular-nums; }}
.legend-item {{ display:inline-flex; align-items:center; gap:6px; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
.legend-swatch {{ width:10px; height:10px; border-radius:2px; flex:0 0 auto; }}
.plot {{ display:flex; align-items:stretch; gap:14px; min-width:0; height:292px; padding:0 6px 0 10px; border-left:1px solid var(--line); border-bottom:1px solid var(--line); overflow-x:auto; background:linear-gradient(to top, var(--axis) 1px, transparent 1px) 0 26px/100% 56px repeat-y; }}
.bar-col {{ display:grid; grid-template-rows:254px 38px; justify-items:center; align-items:end; min-width:54px; height:100%; }}
.bar-track {{ position:relative; display:flex; align-items:flex-end; height:254px; width:100%; justify-content:center; }}
.bar-value {{ position:absolute; bottom:calc(var(--bar-height) + 6px); color:#334155; font-size:11px; line-height:1; font-variant-numeric: tabular-nums; }}
.bar {{ width:32px; height:var(--bar-height); min-height:2px; border-radius:5px 5px 0 0; background:linear-gradient(180deg, var(--accent-2), var(--accent)); box-shadow: inset 0 1px 0 rgba(255,255,255,.22); overflow:hidden; }}
.group-col {{ display:grid; grid-template-rows:254px 38px; justify-items:center; align-items:end; min-width:var(--group-width); height:100%; padding:0 7px; border-right:1px solid rgba(217,222,231,.7); }}
.group-col:last-child {{ border-right:0; }}
.group-track {{ display:flex; align-items:flex-end; justify-content:center; gap:4px; height:254px; width:100%; }}
.mini-bar-wrap {{ position:relative; display:flex; align-items:flex-end; justify-content:center; height:254px; width:25px; }}
.mini-bar {{ width:15px; height:var(--bar-height); min-height:2px; border-radius:4px 4px 0 0; background:var(--segment-color); }}
.mini-value {{ position:absolute; left:50%; bottom:calc(var(--bar-height) + 6px); transform:translateX(-50%); color:#334155; font-size:9px; line-height:1; font-variant-numeric: tabular-nums; white-space:nowrap; }}
.axis-label {{ align-self:start; color:#53657d; font-size:11px; line-height:1.1; white-space:nowrap; padding-top:8px; font-variant-numeric: tabular-nums; }}
.empty {{ margin:auto; color:var(--muted); }}
@media (max-width: 760px) {{ .shell {{ padding:16px; }} .toolbar {{ display:block; }} .chip {{ display:inline-block; margin-top:8px; }} .filter {{ flex-basis:0; }} .filter-menu {{ min-width:150px; }} .plot {{ gap:12px; }} .bar-col {{ min-width:50px; }} }}
</style>
</head>
<body>
<main class="shell">
  <header class="toolbar"><div><h1>Lantor Monitoring</h1><div class="muted">Token and cost trend by time bucket.</div></div><span class="chip">{} · {} · {} · {}</span></header>
  <nav class="controls" aria-label="Monitoring filters">
    {}
    {}
    {}
    {}
  </nav>
  <section class="total" aria-label="Selected period total">
    <div class="sum-chip"><span>{}</span><strong>{}</strong></div>
  </section>
  <div class="charts">
    <section class="chart" aria-label="Token monitoring bar chart"><div class="chart-title"><h2>{} by {}</h2><span class="muted">{}</span></div>{}<div class="plot">{}</div></section>
    <section class="chart" aria-label="Memory monitoring bar chart"><div class="chart-title"><h2>Memory by {}</h2><span class="muted">reads by layer</span></div>{}{}<div class="plot">{}</div></section>
  </div>
</main>
</body>
</html>"#,
        html_escape(&subject),
        html_escape(scope),
        html_escape(window),
        html_escape(bucket),
        window_controls,
        bucket_controls,
        metric_controls,
        agent_controls,
        html_escape(metric_sum_label),
        html_escape(&metric_total),
        html_escape(metric_label),
        html_escape(bucket),
        html_escape(&subject),
        legend,
        chart_bars,
        html_escape(bucket),
        memory_inventory_chips,
        memory_legend,
        memory_chart_bars
    )
}

fn monitoring_view_url(
    scope: &str,
    agent: Option<&str>,
    window: &str,
    bucket: &str,
    metric: &str,
    limit: usize,
) -> String {
    let mut url = format!(
        "/tool/monitoring?scope={}&window={}&bucket={}&metric={}&limit={}",
        percent_encode(scope),
        percent_encode(window),
        percent_encode(bucket),
        percent_encode(metric),
        limit
    );
    if let Some(agent) = agent.filter(|value| !value.trim().is_empty()) {
        url.push_str("&agent=");
        url.push_str(&percent_encode(agent));
    }
    url
}

fn render_monitoring_dropdown(label: &str, active_label: String, options: String) -> String {
    format!(
        r#"<details class="filter"><summary><span class="filter-current"><span class="filter-label">{}</span><span class="filter-value">{}</span></span><span class="filter-arrow">&#9662;</span></summary><div class="filter-menu">{}</div></details>"#,
        html_escape(label),
        html_escape(&active_label),
        options
    )
}

fn render_monitoring_links<F>(values: &[&str], active: &str, url_for: F) -> String
where
    F: Fn(&str) -> String,
{
    values
        .iter()
        .map(|value| {
            let class = if *value == active {
                "control active"
            } else {
                "control"
            };
            format!(
                r#"<a class="{class}" href="{}">{}</a>"#,
                html_escape(&url_for(value)),
                html_escape(&monitoring_control_label(value))
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

fn monitoring_chart_bars(series: &[Value], metric: &str, max_metric: f64) -> String {
    if series.is_empty() {
        return r#"<div class="empty">No runs in this selection.</div>"#.to_owned();
    }
    series
        .iter()
        .map(|point| {
            let value = monitoring_metric_value(point, metric);
            let height = ((value / max_metric) * 88.0).round().clamp(1.0, 88.0);
            format!(
                r#"<div class="bar-col"><div class="bar-track" style="--bar-height:{}%"><div class="bar-value">{}</div><div class="bar"></div></div><div class="axis-label">{}</div></div>"#,
                height,
                html_escape(&monitoring_metric_display(point, metric)),
                html_escape(&monitoring_bucket_label(value_str(point, "bucket")))
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

#[derive(Debug, Clone)]
struct MonitoringCompareAgent {
    key: String,
    label: String,
    color: &'static str,
}

#[derive(Debug, Clone)]
struct MonitoringCompareSegment {
    key: String,
    value: f64,
}

#[derive(Debug, Clone)]
struct MonitoringCompareBucket {
    bucket: String,
    segments: Vec<MonitoringCompareSegment>,
}

#[derive(Debug, Clone)]
struct MonitoringCompareModel {
    agents: Vec<MonitoringCompareAgent>,
    buckets: Vec<MonitoringCompareBucket>,
    max_value: f64,
}

fn monitoring_compare_model(series: &[Value], metric: &str) -> MonitoringCompareModel {
    const COLORS: [&str; 6] = [
        "#2563eb", "#0f766e", "#dc6b19", "#7c3aed", "#be123c", "#64748b",
    ];

    let mut agent_totals: HashMap<String, (String, f64)> = HashMap::new();
    for point in series {
        let handle = value_str(point, "handle");
        if handle.is_empty() {
            continue;
        }
        let label = monitoring_agent_label(point);
        let entry = agent_totals
            .entry(handle.to_owned())
            .or_insert((label, 0.0));
        entry.1 += monitoring_metric_value(point, metric);
    }

    let mut ranked = agent_totals
        .into_iter()
        .collect::<Vec<(String, (String, f64))>>();
    ranked.sort_by(|left, right| {
        let left_total = (left.1).1;
        let right_total = (right.1).1;
        let left_label = (left.1).0.to_lowercase();
        let right_label = (right.1).0.to_lowercase();
        right_total
            .partial_cmp(&left_total)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left_label.cmp(&right_label))
    });

    let mut top_keys = ranked
        .iter()
        .take(5)
        .map(|(key, _)| key.to_owned())
        .collect::<Vec<_>>();
    top_keys.sort();
    let top_key_set = top_keys
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();

    let mut agents = ranked
        .iter()
        .filter(|(key, _)| top_key_set.contains(key))
        .map(|(key, (label, _))| (key.to_owned(), label.to_owned()))
        .collect::<Vec<_>>();
    agents.sort_by_key(|(_, label)| label.to_lowercase());
    let has_others = ranked.iter().any(|(key, _)| !top_key_set.contains(key));
    let mut legend_agents = agents
        .iter()
        .enumerate()
        .map(|(index, (key, label))| MonitoringCompareAgent {
            key: key.to_owned(),
            label: label.to_owned(),
            color: COLORS[index],
        })
        .collect::<Vec<_>>();
    if has_others {
        legend_agents.push(MonitoringCompareAgent {
            key: "__others__".to_owned(),
            label: "Others".to_owned(),
            color: COLORS[5],
        });
    }

    let color_keys = legend_agents
        .iter()
        .map(|agent| agent.key.clone())
        .collect::<Vec<_>>();
    let mut bucket_values: BTreeMap<String, HashMap<String, f64>> = BTreeMap::new();
    for point in series {
        let bucket = value_str(point, "bucket");
        let handle = value_str(point, "handle");
        if bucket.is_empty() || handle.is_empty() {
            continue;
        }
        let key = if top_key_set.contains(handle) {
            handle
        } else {
            "__others__"
        };
        *bucket_values
            .entry(bucket.to_owned())
            .or_default()
            .entry(key.to_owned())
            .or_default() += monitoring_metric_value(point, metric);
    }

    let buckets = bucket_values
        .into_iter()
        .map(|(bucket, values)| {
            let segments = color_keys
                .iter()
                .filter_map(|key| {
                    let value = values.get(key).copied().unwrap_or_default();
                    (value > 0.0).then(|| MonitoringCompareSegment {
                        key: key.to_owned(),
                        value,
                    })
                })
                .collect::<Vec<_>>();
            MonitoringCompareBucket { bucket, segments }
        })
        .collect::<Vec<_>>();
    let max_value = buckets
        .iter()
        .flat_map(|bucket| bucket.segments.iter().map(|segment| segment.value))
        .fold(0.0_f64, f64::max)
        .max(1.0);
    MonitoringCompareModel {
        agents: legend_agents,
        buckets,
        max_value,
    }
}

fn monitoring_compare_chart_bars(model: &MonitoringCompareModel, metric: &str) -> String {
    if model.buckets.is_empty() {
        return r#"<div class="empty">No runs in this selection.</div>"#.to_owned();
    }
    let color_by_key = model
        .agents
        .iter()
        .map(|agent| (agent.key.as_str(), agent.color))
        .collect::<HashMap<_, _>>();
    model
        .buckets
        .iter()
        .map(|bucket| {
            let segment_count = bucket.segments.len().max(1);
            let group_width = (segment_count * 25 + segment_count.saturating_sub(1) * 4 + 14)
                .max(108);
            let bars = bucket
                .segments
                .iter()
                .map(|segment| {
                    let height = ((segment.value / model.max_value) * 82.0)
                        .round()
                        .clamp(1.0, 82.0);
                    format!(
                        r#"<div class="mini-bar-wrap" style="--bar-height:{}%;--segment-color:{}"><div class="mini-value">{}</div><div class="mini-bar"></div></div>"#,
                        height,
                        color_by_key
                            .get(segment.key.as_str())
                            .copied()
                            .unwrap_or("#64748b"),
                        html_escape(&monitoring_metric_display_value(segment.value, metric))
                    )
                })
                .collect::<Vec<_>>()
                .join("");
            format!(
                r#"<div class="group-col" style="--group-width:{}px"><div class="group-track">{}</div><div class="axis-label">{}</div></div>"#,
                group_width,
                bars,
                html_escape(&monitoring_bucket_label(&bucket.bucket))
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

fn monitoring_compare_legend(model: &MonitoringCompareModel) -> String {
    if model.agents.is_empty() {
        return String::new();
    }
    let items = model
        .agents
        .iter()
        .map(|agent| {
            format!(
                r#"<span class="legend-item"><span class="legend-swatch" style="background:{}"></span>{}</span>"#,
                agent.color,
                html_escape(&agent.label)
            )
        })
        .collect::<Vec<_>>()
        .join("");
    format!(r#"<div class="legend">{items}</div>"#)
}

fn monitoring_memory_layer_chart_bars(series: &[Value]) -> String {
    if series.is_empty() {
        return r#"<div class="empty">No memory observations in this selection.</div>"#.to_owned();
    }
    const LAYERS: [(&str, &str); 2] = [("realtime", "#2563eb"), ("events", "#0f766e")];
    let max_value = series
        .iter()
        .flat_map(|point| LAYERS.iter().map(|(key, _)| value_i64(point, key) as f64))
        .fold(0.0_f64, f64::max)
        .max(1.0);
    series
        .iter()
        .map(|point| {
            let segments = LAYERS
                .iter()
                .filter_map(|(key, color)| {
                    let value = value_i64(point, key);
                    (value > 0).then(|| {
                        let height = ((value as f64 / max_value) * 82.0).round().clamp(1.0, 82.0);
                        format!(
                            r#"<div class="mini-bar-wrap" style="--bar-height:{}%;--segment-color:{}"><div class="mini-value">{}</div><div class="mini-bar"></div></div>"#,
                            height,
                            color,
                            html_escape(&format_compact_i64(value))
                        )
                    })
                })
                .collect::<Vec<_>>();
            let segment_count = segments.len().max(1);
            let group_width =
                (segment_count * 25 + segment_count.saturating_sub(1) * 4 + 14).max(108);
            format!(
                r#"<div class="group-col" style="--group-width:{}px"><div class="group-track">{}</div><div class="axis-label">{}</div></div>"#,
                group_width,
                segments.join(""),
                html_escape(&monitoring_bucket_label(value_str(point, "bucket")))
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

fn monitoring_memory_layer_legend() -> String {
    let items = [
        ("Realtime", "#2563eb"),
        ("Events", "#0f766e"),
    ]
    .iter()
    .map(|(label, color)| {
        format!(
            r#"<span class="legend-item"><span class="legend-swatch" style="background:{}"></span>{}</span>"#,
            color,
            html_escape(label)
        )
    })
    .collect::<Vec<_>>()
    .join("");
    format!(r#"<div class="legend">{items}</div>"#)
}

fn monitoring_memory_inventory_chips(inventory: &Value) -> String {
    let realtime = value_i64(inventory, "realtime_files");
    let events = value_i64(inventory, "event_files");
    format!(
        r#"<div class="stat-row"><span class="stat-chip">Realtime files <strong>{}</strong></span><span class="stat-chip">Event files <strong>{}</strong></span></div>"#,
        html_escape(&format_compact_i64(realtime)),
        html_escape(&format_compact_i64(events))
    )
}

fn monitoring_agent_label(agent: &Value) -> String {
    let display_name = value_str(agent, "display_name")
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(28)
        .collect::<String>();
    if !display_name.is_empty() {
        return display_name;
    }
    let handle = value_str(agent, "handle");
    if handle.is_empty() {
        "Missing agent".to_owned()
    } else {
        handle.to_owned()
    }
}

fn monitoring_bucket_label(bucket: &str) -> String {
    if let Ok(date) = NaiveDate::parse_from_str(bucket, "%Y-%m-%d") {
        return date.format("%-m/%-d").to_string();
    }
    if let Some((_, week)) = bucket.split_once("-W") {
        if !week.trim().is_empty() {
            return format!("W{}", week.trim_start_matches('0'));
        }
    }
    bucket.to_owned()
}

fn monitoring_metric_label(metric: &str) -> &'static str {
    match metric {
        "input_tokens" => "Input tokens",
        "output_tokens" => "Output tokens",
        "cost_usd" => "Cost",
        "runs" => "Runs",
        "memory_reads" => "Memory reads",
        "memory_read_bytes" => "Memory bytes",
        _ => "Total tokens",
    }
}

fn monitoring_metric_sum_label(metric: &str) -> &'static str {
    match metric {
        "input_tokens" => "Input sum",
        "output_tokens" => "Output sum",
        "cost_usd" => "Cost sum",
        "runs" => "Run sum",
        "memory_reads" => "Memory read sum",
        "memory_read_bytes" => "Memory byte sum",
        _ => "Token sum",
    }
}

fn monitoring_control_label(value: &str) -> String {
    match value {
        "24h" => "24h".to_owned(),
        "7d" => "7d".to_owned(),
        "30d" => "30d".to_owned(),
        "all" => "All".to_owned(),
        "day" => "Day".to_owned(),
        "week" => "Week".to_owned(),
        other => monitoring_metric_label(other).to_owned(),
    }
}

fn monitoring_metric_value(value: &Value, metric: &str) -> f64 {
    if metric == "cost_usd" {
        value_f64(value, "cost_usd")
    } else {
        value_i64(value, metric) as f64
    }
}

fn monitoring_metric_display(value: &Value, metric: &str) -> String {
    if metric == "cost_usd" {
        format!("${:.4}", value_f64(value, "cost_usd"))
    } else {
        format_compact_i64(value_i64(value, metric))
    }
}

fn monitoring_metric_display_value(value: f64, metric: &str) -> String {
    if metric == "cost_usd" {
        format!("${value:.4}")
    } else {
        format_compact_i64(value.round() as i64)
    }
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn format_compact_i64(value: i64) -> String {
    let abs = value.abs();
    if abs >= 1_000_000 {
        if abs >= 10_000_000 {
            format!("{}m", value / 1_000_000)
        } else {
            format!("{:.1}m", value as f64 / 1_000_000.0)
        }
    } else if abs >= 1_000 {
        if abs >= 10_000 {
            format!("{}k", value / 1_000)
        } else {
            format!("{:.1}k", value as f64 / 1_000.0)
        }
    } else {
        value.to_string()
    }
}

fn value_i64<'a>(value: &'a Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn value_f64<'a>(value: &'a Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or_default()
}

fn value_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn calendar_preview_html(
    month: NaiveDate,
    selected: NaiveDate,
    view: &str,
    title: &str,
    events: &[CalendarPreviewEvent],
) -> String {
    let month_title = month.format("%B %Y").to_string();
    let weekday_offset = month.weekday().num_days_from_monday() as i64;
    let grid_start = month - chrono::Duration::days(weekday_offset);
    let today = Utc::now().date_naive();
    let mut cells = String::new();
    for offset in 0..42 {
        let day = grid_start + chrono::Duration::days(offset);
        let muted = day.month() != month.month();
        let is_today = day == today;
        let is_selected = day == selected;
        let day_events = events
            .iter()
            .filter(|event| event.date == day)
            .collect::<Vec<_>>();
        cells.push_str(&format!(
            r#"<section class="day{}{}{}"><a class="day-link" href="{}"><span>{}</span>{}</a>{}</section>"#,
            if muted { " muted" } else { "" },
            if is_today { " today" } else { "" },
            if is_selected { " selected" } else { "" },
            html_escape(&calendar_view_url(month_for_date(day), "day", day, title)),
            day.day(),
            if is_today { "<b>Today</b>" } else { "" },
            render_calendar_signals(&day_events)
        ));
    }
    let selected_day_events = events
        .iter()
        .filter(|event| event.date == selected)
        .collect::<Vec<_>>();
    let selected_day_detail = render_selected_day_detail(selected, &selected_day_events);
    let agenda_events = events.iter().collect::<Vec<_>>();
    let agenda = if agenda_events.is_empty() {
        r#"<p class="empty-state">No reminders, schedules, or tool events in this range.</p>"#
            .to_owned()
    } else {
        agenda_events
            .iter()
            .map(|event| {
                let recurrence_label = calendar_agenda_recurrence_label(event)
                    .map(|label| {
                        format!(
                            r#"<span class="agenda-repeat-label">{}</span>"#,
                            html_escape(label)
                        )
                    })
                    .unwrap_or_default();
                format!(
                    r#"<section class="agenda-row"><div class="agenda-row-meta"><time>{}</time>{}</div>{}</section>"#,
                    html_escape(&event.date.format("%b %-d").to_string()),
                    recurrence_label,
                    render_calendar_events(&[*event], true)
                )
            })
            .collect::<Vec<_>>()
            .join("")
    };
    let month_panel = format!(
        r#"<section class="view-panel{}" id="month-view">
  <div class="calendar-layout">
    <section class="month-board">
      <div class="weekdays" aria-hidden="true">
        <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
      </div>
      <div class="grid" role="grid" aria-label="{}">{}</div>
    </section>
    {}
  </div>
</section>"#,
        if view == "month" { " active" } else { "" },
        html_escape(&month_title),
        cells,
        selected_day_detail
    );
    let day_panel = format!(
        r#"<section class="view-panel{} day-view" id="day-view" aria-label="{}"><section class="agenda-day selected"><header><div><h2>{}</h2><span>Times are shown in UTC.</span></div></header>{}</section></section>"#,
        if view == "day" { " active" } else { "" },
        html_escape(&selected.format("%B %-d, %Y").to_string()),
        html_escape(&selected.format("%A, %B %-d").to_string()),
        render_timed_calendar_events(&selected_day_events)
    );
    let agenda_panel = format!(
        r#"<section class="view-panel{} agenda-list" id="agenda-view" aria-label="Agenda">{}</section>"#,
        if view == "agenda" { " active" } else { "" },
        agenda
    );
    let nav = ["month", "day", "agenda"]
        .iter()
        .map(|candidate| {
            format!(
                r#"<a class="view-tab{}" href="{}">{}</a>"#,
                if *candidate == view { " active" } else { "" },
                html_escape(&calendar_view_url(month, candidate, selected, title)),
                candidate
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let previous_month = add_months(month, -1);
    let next_month = add_months(month, 1);
    let previous_day = selected - chrono::Duration::days(1);
    let next_day = selected + chrono::Duration::days(1);
    let period_nav = if view == "day" {
        render_calendar_period_nav(
            "Previous day",
            &previous_day.format("%b %-d").to_string(),
            &calendar_view_url(month_for_date(previous_day), "day", previous_day, title),
            "Next day",
            &next_day.format("%b %-d").to_string(),
            &calendar_view_url(month_for_date(next_day), "day", next_day, title),
        )
    } else {
        render_calendar_period_nav(
            "Previous month",
            &previous_month.format("%B").to_string(),
            &calendar_view_url(
                previous_month,
                view,
                clamp_date_to_month(selected, previous_month),
                title,
            ),
            "Next month",
            &next_month.format("%B").to_string(),
            &calendar_view_url(
                next_month,
                view,
                clamp_date_to_month(selected, next_month),
                title,
            ),
        )
    };
    let today_events = events
        .iter()
        .filter(|event| event.date == today)
        .collect::<Vec<_>>();
    let current_month_count = events
        .iter()
        .filter(|event| event.date.year() == month.year() && event.date.month() == month.month())
        .count();
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{}</title>
<style>
:root {{
  color-scheme: light;
  --ink: #17202a;
  --muted: #6b7280;
  --line: #d9dee7;
  --panel: #ffffff;
  --bg: #f4f7fb;
  --accent: #0f766e;
  --accent-2: #b45309;
  --accent-3: #2563eb;
  --danger: #b91c1c;
}}
* {{ box-sizing: border-box; }}
body {{
  margin: 0;
  min-height: 100vh;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--bg);
}}
.shell {{
  max-width: 1180px;
  margin: 0 auto;
  padding: 28px;
}}
.month-chip {{
  border: 1px solid var(--line);
  background: var(--panel);
  padding: 5px 8px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}}
.toolbar {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}}
.tabs {{
  display: inline-flex;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  overflow: hidden;
}}
.view-tab {{
  color: var(--muted);
  padding: 5px 9px;
  text-decoration: none;
  font-size: 12px;
  text-transform: capitalize;
  border-right: 1px solid var(--line);
}}
.view-tab:last-child {{ border-right: 0; }}
.view-tab.active {{
  color: #fff;
  background: var(--accent);
}}
.period-nav {{
  display: inline-flex;
  align-items: center;
  gap: 6px;
}}
.period-nav a {{
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  text-decoration: none;
  border-radius: 7px;
  padding: 5px 8px;
  font-size: 12px;
  line-height: 1;
}}
.period-nav span {{
  color: var(--muted);
}}
.summary-grid {{
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}}
.stat {{
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 999px;
  padding: 4px 8px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1;
}}
.stat strong {{
  color: var(--ink);
  font-size: 12px;
  line-height: 1;
}}
.stat-icon {{
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
  flex: 0 0 auto;
}}
.view-panel {{ display: none; }}
.view-panel.active {{ display: block; }}
.weekdays,
.grid {{
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}}
.weekdays {{
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  margin-bottom: 8px;
}}
.weekdays span {{ padding: 0 10px; }}
.calendar-layout {{
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
  gap: 14px;
  align-items: start;
}}
.month-board {{
  min-width: 0;
}}
.grid {{
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--line);
  gap: 1px;
}}
.day {{
  min-height: 118px;
  background: var(--panel);
  padding: 10px;
}}
.day:hover {{
  background: #fbfdff;
}}
.day-link {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
  margin-bottom: 8px;
  color: inherit;
  text-decoration: none;
}}
.day-link span {{
  width: 26px;
  height: 26px;
  display: inline-grid;
  place-items: center;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 680;
}}
.day-link b {{
  color: var(--accent);
  font-size: 11px;
}}
.day.muted {{ background: #f8fafc; color: #9aa3af; }}
.day.today .day-link span {{ outline: 2px solid rgba(15, 118, 110, 0.3); }}
.day.selected .day-link span {{ background: var(--accent); color: #fff; }}
.signals {{
  display: grid;
  gap: 5px;
}}
.signal {{
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: #475569;
  font-size: 11px;
  line-height: 1.2;
}}
.signal i {{
  width: 18px;
  height: 4px;
  border-radius: 999px;
  background: #94a3b8;
  flex: 0 0 auto;
}}
.signal span {{
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}}
.signal[data-kind="review"] i,
.event[data-kind="review"] {{ border-left-color: #2563eb; }}
.signal[data-kind="review"] i {{ background: #2563eb; }}
.signal[data-kind="release"] i,
.event[data-kind="release"] {{ border-left-color: #16a34a; }}
.signal[data-kind="release"] i {{ background: #16a34a; }}
.signal[data-kind="call"] i,
.event[data-kind="call"] {{ border-left-color: #7c3aed; }}
.signal[data-kind="call"] i {{ background: #7c3aed; }}
.signal[data-kind="deadline"] i,
.event[data-kind="deadline"] {{ border-left-color: #dc2626; }}
.signal[data-kind="deadline"] i {{ background: #dc2626; }}
.signal[data-kind="schedule"] i,
.event[data-kind="schedule"] {{ border-left-color: #9333ea; }}
.signal[data-kind="schedule"] i {{ background: #9333ea; }}
.signal[data-kind="repeat"] i,
.event[data-kind="repeat"] {{ border-left-color: var(--accent); }}
.signal[data-kind="repeat"] i {{ background: var(--accent); }}
.signal[data-kind="fired"] i,
.event[data-kind="fired"] {{ border-left-color: #64748b; }}
.signal[data-kind="fired"] i {{ background: #64748b; }}
.more-signal {{
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  padding-left: 23px;
}}
.day-detail {{
  position: sticky;
  top: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255,255,255,0.88);
  padding: 14px;
}}
.day-detail header {{
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}}
.day-detail h2 {{
  margin: 0;
  font-size: 17px;
  line-height: 1.2;
}}
.day-detail header span {{
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}}
.day-detail-list {{
  display: grid;
  gap: 9px;
}}
.event {{
  display: block;
  width: 100%;
  border: 0;
  border-left: 3px solid var(--accent-3);
  background: #eff6ff;
  color: #1e3a8a;
  border-radius: 6px;
  padding: 6px 7px;
  margin-top: 6px;
  font: inherit;
  font-size: 12px;
  line-height: 1.25;
  text-align: left;
  overflow-wrap: anywhere;
}}
.event.expanded {{
  padding: 9px 10px;
  margin-top: 0;
  font-size: 13px;
}}
.event span,
.event small {{
  display: block;
}}
.event small {{
  color: inherit;
  opacity: 0.72;
  font-size: 10px;
  line-height: 1.25;
  margin-top: 3px;
}}
.event[data-kind="focus"] {{ border-left-color: var(--accent); background: #ecfdf5; color: #14532d; }}
.event[data-kind="review"] {{ background: #eff6ff; color: #1e3a8a; }}
.event[data-kind="release"] {{ background: #ecfdf5; color: #14532d; }}
.event[data-kind="call"] {{ background: #f5f3ff; color: #4c1d95; }}
.event[data-kind="deadline"] {{ background: #fef2f2; color: #7f1d1d; }}
.event[data-kind="reminder"] {{ border-left-color: var(--accent-3); background: #eff6ff; color: #1e3a8a; }}
.event[data-kind="repeat"] {{ border-left-color: var(--accent); background: #ecfdf5; color: #14532d; }}
.event[data-kind="fired"] {{ border-left-color: #64748b; background: #f1f5f9; color: #334155; }}
.event[data-kind="schedule"] {{ border-left-color: #9333ea; background: #faf5ff; color: #581c87; }}
.event[data-kind="schedule-paused"] {{ border-left-color: var(--danger); background: #fef2f2; color: #7f1d1d; }}
.day-view .agenda-day header {{
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}}
.day-view .agenda-day header span {{
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-top: 4px;
}}
.timed-event {{
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  border-top: 1px solid var(--line);
  padding: 10px 0;
}}
.timed-event:first-of-type {{
  border-top: 0;
  padding-top: 0;
}}
.timed-event > time {{
  color: var(--muted);
  font-size: 12px;
  font-weight: 760;
  line-height: 1.2;
  padding-top: 9px;
}}
.stack-view,
.agenda-list {{
  display: none;
  gap: 10px;
}}
.stack-view.active,
.agenda-list.active {{
  display: grid;
}}
.agenda-day,
.agenda-row {{
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  padding: 12px;
}}
.agenda-day.selected {{
  border-color: rgba(15, 118, 110, 0.45);
}}
.agenda-day h2 {{
  margin: 0 0 10px;
  font-size: 15px;
  line-height: 1.2;
}}
.agenda-day h2 a {{
  color: inherit;
  text-decoration: none;
}}
.agenda-row {{
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: start;
  gap: 12px;
}}
.agenda-row time {{
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  padding-top: 9px;
  text-transform: uppercase;
}}
.agenda-row-meta {{
  display: grid;
  gap: 6px;
  justify-items: start;
}}
.agenda-repeat-label {{
  border: 1px solid rgba(15, 118, 110, 0.28);
  border-radius: 999px;
  color: var(--accent-strong);
  font-size: 11px;
  font-weight: 760;
  line-height: 1;
  padding: 4px 7px;
}}
.empty-state {{
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 18px;
  margin: 0;
  background: rgba(255,255,255,0.65);
}}
@media (max-width: 760px) {{
  .shell {{ padding: 16px; }}
  .toolbar {{ align-items: stretch; flex-direction: column; }}
  .tabs {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }}
  .view-tab {{ text-align: center; padding: 6px 7px; }}
  .period-nav {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }}
  .period-nav a {{ justify-content: center; }}
  .summary-grid {{ flex-wrap: wrap; }}
  .calendar-layout {{ grid-template-columns: 1fr; }}
  .day-detail {{ position: static; }}
  .day {{ min-height: 92px; padding: 7px; }}
  .event {{ font-size: 11px; padding: 5px; }}
  .event.expanded {{ font-size: 12px; padding: 8px; }}
  .timed-event {{ grid-template-columns: 52px minmax(0, 1fr); gap: 8px; }}
  .agenda-row {{ grid-template-columns: 1fr; gap: 6px; }}
}}
</style>
</head>
<body>
<main class="shell">
  <div class="toolbar">
    <div class="month-chip">{}</div>
    <nav class="tabs" aria-label="Calendar views">{}</nav>
    {}
  </div>
  <div class="summary-grid" aria-label="Calendar item totals">
    <div class="stat"><i class="stat-icon"></i><strong>{}</strong><span>Today</span></div>
    <div class="stat"><i class="stat-icon"></i><strong>{}</strong><span>This month</span></div>
  </div>
  {}{}{}
</main>
</body>
</html>"#,
        html_escape(title),
        html_escape(&month_title),
        nav,
        period_nav,
        today_events.len(),
        current_month_count,
        month_panel,
        day_panel,
        agenda_panel
    )
}

fn render_calendar_events(events: &[&CalendarPreviewEvent], expanded: bool) -> String {
    if events.is_empty() {
        return if expanded {
            r#"<p class="empty-state">No items.</p>"#.to_owned()
        } else {
            String::new()
        };
    }
    events
        .iter()
        .map(|event| {
            let visual_kind = calendar_visual_kind(event);
            let display_title = display_calendar_title(event);
            let detail = calendar_event_detail(event);
            format!(
                r#"<button class="event{}" data-kind="{}" title="{}" type="button"><span>{}</span>{}</button>"#,
                if expanded { " expanded" } else { "" },
                html_escape(visual_kind),
                html_escape(&detail),
                html_escape(&display_title),
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(r#"<small>{}</small>"#, html_escape(&detail))
                }
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

fn render_timed_calendar_events(events: &[&CalendarPreviewEvent]) -> String {
    if events.is_empty() {
        return r#"<p class="empty-state">No reminders or schedules on this day.</p>"#.to_owned();
    }
    let mut sorted = events.to_vec();
    sorted.sort_by(|left, right| left.time_label.cmp(&right.time_label));
    sorted
        .iter()
        .map(|event| {
            let time = if event.time_label.trim().is_empty() {
                "All day"
            } else {
                event.time_label.trim()
            };
            format!(
                r#"<div class="timed-event"><time>{}</time><div>{}</div></div>"#,
                html_escape(time),
                render_calendar_events(&[*event], true)
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

fn render_calendar_signals(events: &[&CalendarPreviewEvent]) -> String {
    if events.is_empty() {
        return String::new();
    }
    let visible = events
        .iter()
        .take(3)
        .map(|event| {
            format!(
                r#"<div class="signal" data-kind="{}" title="{}"><i></i><span>{}</span></div>"#,
                html_escape(calendar_visual_kind(event)),
                html_escape(&calendar_event_detail(event)),
                html_escape(&display_calendar_title(event))
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let overflow = events.len().saturating_sub(3);
    let more = if overflow > 0 {
        format!(r#"<div class="more-signal">+{overflow}</div>"#)
    } else {
        String::new()
    };
    format!(r#"<div class="signals">{visible}{more}</div>"#)
}

fn render_calendar_period_nav(
    previous_label: &str,
    previous_text: &str,
    previous_url: &str,
    next_label: &str,
    next_text: &str,
    next_url: &str,
) -> String {
    format!(
        r#"<nav class="period-nav" aria-label="Calendar period"><a href="{}" aria-label="{}">&lsaquo; <span>{}</span></a><a href="{}" aria-label="{}"><span>{}</span> &rsaquo;</a></nav>"#,
        html_escape(previous_url),
        html_escape(previous_label),
        html_escape(previous_text),
        html_escape(next_url),
        html_escape(next_label),
        html_escape(next_text)
    )
}

fn month_for_date(date: NaiveDate) -> NaiveDate {
    first_day_of_month(date.year(), date.month()).expect("date month is valid")
}

fn add_months(month: NaiveDate, delta: i32) -> NaiveDate {
    let month_index = month.year() * 12 + month.month0() as i32 + delta;
    let year = month_index.div_euclid(12);
    let month0 = month_index.rem_euclid(12) as u32;
    first_day_of_month(year, month0 + 1).expect("shifted month is valid")
}

fn clamp_date_to_month(date: NaiveDate, month: NaiveDate) -> NaiveDate {
    let first = month_for_date(month);
    let next = add_months(first, 1);
    let last_day = (next - chrono::Duration::days(1)).day();
    let day = date.day().min(last_day);
    NaiveDate::from_ymd_opt(first.year(), first.month(), day).expect("clamped date is valid")
}

fn render_selected_day_detail(selected: NaiveDate, events: &[&CalendarPreviewEvent]) -> String {
    let body = if events.is_empty() {
        r#"<p class="empty-state">No reminders or schedules on this day.</p>"#.to_owned()
    } else {
        format!(
            r#"<div class="day-detail-list">{}</div>"#,
            render_calendar_events(events, true)
        )
    };
    format!(
        r#"<aside class="day-detail" aria-label="Selected day details"><header><h2>{}</h2><span>{} item{}</span></header>{}</aside>"#,
        html_escape(&selected.format("%A, %B %-d").to_string()),
        events.len(),
        if events.len() == 1 { "" } else { "s" },
        body
    )
}

fn display_calendar_title(event: &CalendarPreviewEvent) -> String {
    let trimmed = event.title.trim();
    let mut title = trimmed.to_owned();
    for prefix in [
        "提醒我",
        "提醒",
        "记得",
        "到时候",
        "帮我",
        "please",
        "remind me to",
        "remind me",
    ] {
        let next = title.trim_start();
        if next.to_ascii_lowercase().starts_with(prefix) {
            title = next[prefix.len()..]
                .trim_start_matches([' ', '，', ',', ':', '：'])
                .to_owned();
        }
    }
    for token in [
        "今天", "明天", "后天", "上午", "下午", "晚上", "凌晨", "中午", "tonight", "today",
        "tomorrow",
    ] {
        title = title.replace(token, "");
    }
    let title = title.trim();
    let fallback = if trimmed.is_empty() {
        "Reminder"
    } else {
        trimmed
    };
    let source = if title.is_empty() { fallback } else { title };
    let mut chars = source.chars();
    let short = chars.by_ref().take(18).collect::<String>();
    if chars.next().is_some() {
        format!("{short}...")
    } else {
        short
    }
}

fn calendar_event_detail(event: &CalendarPreviewEvent) -> String {
    if event.detail.trim().is_empty() {
        event.title.trim().to_owned()
    } else {
        format!("{} · {}", event.title.trim(), event.detail.trim())
    }
}

fn calendar_agenda_recurrence_label(event: &CalendarPreviewEvent) -> Option<&'static str> {
    if event.kind != "repeat" {
        return None;
    }
    let detail = event.detail.to_ascii_lowercase();
    if detail.contains("repeats daily") {
        Some("每日")
    } else if detail.contains("repeats weekly") {
        Some("每周")
    } else if detail.contains("repeats ") {
        Some("重复")
    } else {
        None
    }
}

fn calendar_visual_kind(event: &CalendarPreviewEvent) -> &'static str {
    match event.kind.as_str() {
        "schedule" => return "schedule",
        "schedule-paused" => return "schedule-paused",
        "repeat" => return "repeat",
        "fired" => return "fired",
        "focus" => return "focus",
        _ => {}
    }
    let text = format!("{} {}", event.title, event.detail).to_ascii_lowercase();
    if text.contains("deadline")
        || text.contains("due")
        || text.contains("截止")
        || text.contains("到期")
    {
        "deadline"
    } else if text.contains("release")
        || text.contains("build")
        || text.contains("deploy")
        || text.contains("发布")
        || text.contains("构建")
        || text.contains("部署")
    {
        "release"
    } else if text.contains("call")
        || text.contains("meeting")
        || text.contains("sync")
        || text.contains("会议")
        || text.contains("电话")
        || text.contains("同步")
    {
        "call"
    } else if text.contains("review")
        || text.contains("check")
        || text.contains("复查")
        || text.contains("检查")
        || text.contains("看看")
    {
        "review"
    } else {
        "reminder"
    }
}

fn calendar_view_url(month: NaiveDate, view: &str, selected: NaiveDate, title: &str) -> String {
    format!(
        "/tool/calendar?month={}&selected={}&view={}&title={}",
        month.format("%Y-%m"),
        selected.format("%Y-%m-%d"),
        url_encode(view),
        url_encode(title)
    )
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

async fn serve_index(index: PathBuf) -> Response {
    match tokio::fs::read(index).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, HeaderValue::from_static("text/html")),
                (
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("no-cache, no-store, must-revalidate"),
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

fn web_token() -> Option<String> {
    env::var("LANTOR_WEB_TOKEN")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn query_token(uri: &Uri) -> Option<&str> {
    uri.query()?.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == "token").then_some(value)
    })
}

fn request_web_token(request: &Request) -> Option<&str> {
    if let Some(value) = request.headers().get(header::AUTHORIZATION) {
        let value = value.to_str().ok()?.trim();
        if let Some(token) = value.strip_prefix("Bearer ") {
            return Some(token.trim());
        }
    }
    if let Some(value) = request.headers().get("x-lantor-web-token") {
        return value
            .to_str()
            .ok()
            .map(str::trim)
            .filter(|value| !value.is_empty());
    }
    query_token(request.uri())
}

async fn require_web_auth(
    State(state): State<Arc<WebState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(expected) = state.web_token.as_deref() else {
        return next.run(request).await;
    };
    if request_web_token(&request).is_some_and(|token| token == expected) {
        return next.run(request).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "application/json")],
        Json(json!({
            "ok": false,
            "message": "Web token required."
        })),
    )
        .into_response()
}

fn web_dist_dir() -> PathBuf {
    if let Ok(path) = env::var("LANTOR_WEB_DIST") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            return path;
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("../dist"),
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("dist"),
    ];
    candidates
        .into_iter()
        .find(|path| path.join("index.html").is_file())
        .unwrap_or_else(|| manifest_dir.join("../dist"))
}

async fn missing_dist(dist_dir: PathBuf) -> impl IntoResponse {
    let body = format!(
        r#"<!doctype html>
<html>
  <head><title>Lantor Web</title></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 32px;">
    <h1>Lantor Web build not found</h1>
    <p>Expected <code>{}</code>.</p>
    <p>Run <code>npm run build</code>, then restart Lantor.</p>
  </body>
</html>"#,
        dist_dir.display()
    );
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body,
    )
}

async fn api_health() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn api_bootstrap(State(state): State<Arc<WebState>>) -> Result<impl IntoResponse, Response> {
    load_bootstrap(&state.pool, state.db_url.clone())
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_fetch_messages(
    State(state): State<Arc<WebState>>,
    Json(request): Json<FetchMessagesRequest>,
) -> Result<impl IntoResponse, Response> {
    fetch_messages_in_pool(&state.pool, request)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_fetch_call_history(
    State(state): State<Arc<WebState>>,
    Json(request): Json<FetchCallHistoryRequest>,
) -> Result<impl IntoResponse, Response> {
    fetch_call_history_page(&state.pool, request.before, request.limit)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_check_runtime(
    Json(request): Json<RuntimeCheckRequest>,
) -> Result<impl IntoResponse, Response> {
    check_runtime_in_env(request.runtime)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_record_ui_refresh_metric(
    State(state): State<Arc<WebState>>,
    Json(request): Json<RecordUiRefreshMetricRequest>,
) -> Result<impl IntoResponse, Response> {
    append_ui_refresh_metrics_log(&state.db_url, request.metric)
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_hook_ingress(
    State(state): State<Arc<WebState>>,
    AxumPath(ingress_token): AxumPath<String>,
    Query(query): Query<HashMap<String, String>>,
    request: Request<Body>,
) -> Result<impl IntoResponse, Response> {
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let headers = request
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_owned()))
        })
        .collect::<BTreeMap<_, _>>();
    let body_bytes = to_bytes(request.into_body(), WEB_HOOK_INGRESS_BODY_LIMIT)
        .await
        .map_err(|err| api_error(err.to_string()))?;
    let body = if body_bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice::<Value>(&body_bytes).unwrap_or_else(|_| {
            json!({
                "text": String::from_utf8_lossy(&body_bytes).to_string()
            })
        })
    };
    let result = process_hook_ingress_in_pool(
        &state.pool,
        &ingress_token,
        &method,
        &path,
        json!(query),
        json!(headers),
        body,
    )
    .await
    .map_err(api_error)?;
    state.trigger_notifier.notify_one();
    Ok(Json(result))
}

async fn api_send_message(
    State(state): State<Arc<WebState>>,
    Json(request): Json<SendMessageRequest>,
) -> Result<impl IntoResponse, Response> {
    send_owner_message_in_pool(
        &state.pool,
        request.channel_id,
        request.thread_root_id,
        &request.body,
        request.as_task,
        request.attachments.unwrap_or_default(),
    )
    .await
    .map(Json)
    .map_err(api_error)
}

async fn api_transcribe_voice_audio(
    Json(request): Json<VoiceTranscriptionRequest>,
) -> Result<impl IntoResponse, Response> {
    voice::transcribe_voice_audio(request)
        .await
        .map(Json)
        .map_err(voice_api_error)
}

async fn api_synthesize_tts_audio(
    Json(request): Json<TtsSynthesisRequest>,
) -> Result<impl IntoResponse, Response> {
    tts::synthesize_tts_audio(request)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_call_session_start(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CallSessionStartRequest>,
) -> Result<impl IntoResponse, Response> {
    call_session_start_with_options_in_pool(
        &state.pool,
        request.channel_id,
        request.thread_root_id,
        request.title,
        request.mode,
        request.wake_words,
    )
    .await
    .map(Json)
    .map_err(api_error)
}

async fn api_call_session_stop(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CallSessionIdRequest>,
) -> Result<impl IntoResponse, Response> {
    call_session_stop_in_pool(&state.pool, request.session_id)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_call_dispatch_cancel_work(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CallDispatchCancelWorkRequest>,
) -> Result<impl IntoResponse, Response> {
    call_dispatch_cancel_work_in_pool(
        &state.pool,
        request.session_id,
        request.work_item_id,
        request.language,
    )
    .await
    .map(Json)
    .map_err(api_error)
}

async fn api_call_dispatch_resolve_confirmation(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CallDispatchResolveConfirmationRequest>,
) -> Result<impl IntoResponse, Response> {
    call_dispatch_resolve_confirmation_in_pool(
        &state.pool,
        request.session_id,
        request.transcript,
        request.language,
    )
    .await
    .map(Json)
    .map_err(api_error)
}

async fn api_call_session_submit_utterance(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CallUtteranceSubmitRequest>,
) -> Result<impl IntoResponse, Response> {
    call_session_submit_utterance_in_pool(&state.pool, request)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_call_session_submit_text_utterance(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CallTextUtteranceSubmitRequest>,
) -> Result<impl IntoResponse, Response> {
    call_session_submit_text_utterance_in_pool(
        &state.pool,
        request.session_id,
        request.transcript,
        request.thread_root_utterance_id,
        request.language,
    )
    .await
    .map(Json)
    .map_err(api_error)
}

async fn api_create_channel(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CreateChannelRequest>,
) -> Result<impl IntoResponse, Response> {
    let description = request.description.unwrap_or_default();
    let channel_id = create_channel_in_pool(&state.pool, &request.name, &description)
        .await
        .map_err(api_error)?;
    if let Some(ids) = request.agent_ids {
        let mut seen = std::collections::HashSet::new();
        for agent_id in ids {
            if !seen.insert(agent_id) {
                continue;
            }
            add_agent_to_channel(&state.pool, channel_id, agent_id)
                .await
                .map_err(api_error)?;
        }
    }
    Ok(Json(json!({ "ok": true, "channelId": channel_id })))
}

async fn api_update_channel(
    State(state): State<Arc<WebState>>,
    Json(request): Json<UpdateChannelRequest>,
) -> Result<impl IntoResponse, Response> {
    update_channel_in_pool(
        &state.pool,
        request.channel_id,
        request.name,
        request.description,
    )
    .await
    .map(|_| Json(json!({ "ok": true })))
    .map_err(api_error)
}

async fn api_delete_channel(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ChannelIdRequest>,
) -> Result<impl IntoResponse, Response> {
    delete_channel_in_pool(&state.pool, request.channel_id)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_create_agent(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CreateAgentRequest>,
) -> Result<impl IntoResponse, Response> {
    create_agent_in_pool(
        &state.pool,
        request.handle,
        request.display_name,
        request.role,
        request.runtime,
        request.model,
        request.reasoning_effort,
        request.service_tier,
        request.avatar,
        request.description,
        request.launch_command,
        request.working_directory,
        request.daily_budget_micros,
    )
    .await
    .map(|agent_id| Json(agent_id.to_string()))
    .map_err(api_error)
}

async fn api_update_agent(
    State(state): State<Arc<WebState>>,
    Json(request): Json<UpdateAgentRequest>,
) -> Result<impl IntoResponse, Response> {
    update_agent_in_pool(
        &state.pool,
        request.agent_id,
        request.handle,
        request.display_name,
        request.role,
        request.runtime,
        request.model,
        request.reasoning_effort,
        request.service_tier,
        request.avatar,
        request.description,
        request.launch_command,
        request.working_directory,
        request.daily_budget_micros,
    )
    .await
    .map(|_| Json(json!({ "ok": true })))
    .map_err(api_error)
}

async fn api_delete_agent(
    State(state): State<Arc<WebState>>,
    Json(request): Json<AgentIdRequest>,
) -> Result<impl IntoResponse, Response> {
    delete_agent_in_pool(&state.pool, request.agent_id)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_start_agent(
    State(state): State<Arc<WebState>>,
    Json(request): Json<AgentIdRequest>,
) -> Result<impl IntoResponse, Response> {
    start_agent_in_pool(&state.pool, request.agent_id)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_set_channel_agent_membership(
    State(state): State<Arc<WebState>>,
    Json(request): Json<SetChannelAgentMembershipRequest>,
) -> Result<impl IntoResponse, Response> {
    set_channel_agent_membership_in_pool(
        &state.pool,
        request.channel_id,
        request.agent_id,
        request.member,
    )
    .await
    .map(|_| Json(json!({ "ok": true })))
    .map_err(api_error)
}

async fn api_update_owner_profile(
    State(state): State<Arc<WebState>>,
    Json(request): Json<OwnerProfileRequest>,
) -> Result<impl IntoResponse, Response> {
    update_owner_profile_in_pool(
        &state.pool,
        request.display_name,
        request.avatar,
        request.description,
    )
    .await
    .map(|_| Json(json!({ "ok": true })))
    .map_err(api_error)
}

async fn api_mark_channel_read(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ChannelIdRequest>,
) -> Result<impl IntoResponse, Response> {
    mark_channel_read_in_pool(&state.pool, request.channel_id)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_dismiss_inbox_items(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DismissInboxItemsRequest>,
) -> Result<impl IntoResponse, Response> {
    dismiss_inbox_items_in_pool(
        &state.pool,
        request
            .items
            .into_iter()
            .map(|item| (item.item_id, item.dismissed_until)),
    )
    .await
    .map(|_| Json(json!({ "ok": true })))
    .map_err(api_error)
}

async fn api_mark_inbox_items_read(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DismissInboxItemsRequest>,
) -> Result<impl IntoResponse, Response> {
    mark_inbox_items_read_in_pool(
        &state.pool,
        request
            .items
            .into_iter()
            .map(|item| (item.item_id, item.dismissed_until)),
    )
    .await
    .map(|_| Json(json!({ "ok": true })))
    .map_err(api_error)
}

async fn api_mark_all_inbox_read(
    State(state): State<Arc<WebState>>,
) -> Result<impl IntoResponse, Response> {
    mark_all_owner_inbox_read_in_pool(&state.pool)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_set_message_saved(
    State(state): State<Arc<WebState>>,
    Json(request): Json<SetMessageSavedRequest>,
) -> Result<impl IntoResponse, Response> {
    set_message_saved_in_pool(&state.pool, request.message_id, request.saved)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_set_message_todo(
    State(state): State<Arc<WebState>>,
    Json(request): Json<SetMessageTodoRequest>,
) -> Result<impl IntoResponse, Response> {
    set_message_todo_in_pool(&state.pool, request.message_id, request.todo)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_create_todo_item(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CreateTodoItemRequest>,
) -> Result<impl IntoResponse, Response> {
    create_todo_item_in_pool(&state.pool, request.summary)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_delete_todo_item(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DeleteTodoItemRequest>,
) -> Result<impl IntoResponse, Response> {
    delete_todo_item_in_pool(&state.pool, request.todo_id)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_complete_todo_item(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CompleteTodoItemRequest>,
) -> Result<impl IntoResponse, Response> {
    complete_todo_item_in_pool(&state.pool, request.todo_id, request.done)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_complete_reminder(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ReminderIdRequest>,
) -> Result<impl IntoResponse, Response> {
    complete_reminder_in_pool(&state.pool, request.reminder_id)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_cancel_reminder(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ReminderIdRequest>,
) -> Result<impl IntoResponse, Response> {
    cancel_reminder_in_pool(&state.pool, request.reminder_id)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_update_agent_schedule_status(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ScheduleStatusRequest>,
) -> Result<impl IntoResponse, Response> {
    let should_notify_trigger_worker = request.status.trim() == "active";
    update_agent_schedule_status_in_pool(&state.pool, request.schedule_id, request.status)
        .await
        .map_err(api_error)?;
    if should_notify_trigger_worker {
        crate::notify_trigger_worker(&state.trigger_notifier);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn api_delete_event_hook(
    State(state): State<Arc<WebState>>,
    Json(request): Json<HookIdRequest>,
) -> Result<impl IntoResponse, Response> {
    let result = delete_event_hook_in_pool(&state.pool, None, request.hook_id)
        .await
        .map_err(api_error)?;
    let _ = notify_ui_refresh(&state.pool, "event_hook_deleted").await;
    Ok(Json(json!({ "ok": true, "result": result })))
}

async fn api_update_task_status(
    State(state): State<Arc<WebState>>,
    Json(request): Json<TaskStatusRequest>,
) -> Result<impl IntoResponse, Response> {
    update_task_status_in_pool(&state.pool, request.task_id, request.status)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_update_task_title(
    State(state): State<Arc<WebState>>,
    Json(request): Json<TaskTitleRequest>,
) -> Result<impl IntoResponse, Response> {
    update_task_title_in_pool(&state.pool, request.task_id, request.title)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_claim_task(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ClaimTaskRequest>,
) -> Result<impl IntoResponse, Response> {
    claim_task_in_pool(
        &state.pool,
        request.task_id,
        request.agent_id,
        request.expected_version,
    )
    .await
    .map(|_| Json(json!({ "ok": true })))
    .map_err(api_error)
}

async fn api_forward_task(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ForwardTaskRequest>,
) -> Result<impl IntoResponse, Response> {
    forward_task_in_pool(
        &state.pool,
        request.task_id,
        request.target_agent_id,
        request.interrupt_current,
        request.reason,
    )
    .await
    .map(|_| Json(json!({ "ok": true })))
    .map_err(api_error)
}

async fn api_long_task_create(
    State(state): State<Arc<WebState>>,
    Json(request): Json<LongTaskCreateOptions>,
) -> Result<impl IntoResponse, Response> {
    long_task_create_in_pool(&state.pool, request)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_long_task_list(
    State(state): State<Arc<WebState>>,
) -> Result<impl IntoResponse, Response> {
    long_task_list_in_pool(&state.pool)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_long_task_inspect(
    State(state): State<Arc<WebState>>,
    Json(request): Json<LongTaskIdRequest>,
) -> Result<impl IntoResponse, Response> {
    long_task_inspect_in_pool(&state.pool, &request.task_id)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_long_task_steer(
    State(state): State<Arc<WebState>>,
    Json(request): Json<LongTaskSteerRequest>,
) -> Result<impl IntoResponse, Response> {
    long_task_steer_in_pool(&state.pool, &request.task_id, &request.instruction)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_long_task_approve(
    State(state): State<Arc<WebState>>,
    Json(request): Json<LongTaskIdRequest>,
) -> Result<impl IntoResponse, Response> {
    long_task_control_in_pool(&state.pool, &request.task_id, "approve", None, None)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_long_task_reject(
    State(state): State<Arc<WebState>>,
    Json(request): Json<LongTaskRejectRequest>,
) -> Result<impl IntoResponse, Response> {
    long_task_control_in_pool(
        &state.pool,
        &request.task_id,
        "reject",
        Some(&request.reason),
        None,
    )
    .await
    .map(Json)
    .map_err(api_error)
}

async fn api_long_task_approval(
    State(state): State<Arc<WebState>>,
    Json(request): Json<LongTaskApprovalRequest>,
) -> Result<impl IntoResponse, Response> {
    long_task_control_in_pool(
        &state.pool,
        &request.task_id,
        "approval",
        None,
        Some(&request.mode),
    )
    .await
    .map(Json)
    .map_err(api_error)
}

async fn api_long_task_stop(
    State(state): State<Arc<WebState>>,
    Json(request): Json<LongTaskIdRequest>,
) -> Result<impl IntoResponse, Response> {
    long_task_control_in_pool(&state.pool, &request.task_id, "stop", None, None)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_cancel_agent_work(
    State(state): State<Arc<WebState>>,
    Json(request): Json<WorkItemIdRequest>,
) -> Result<impl IntoResponse, Response> {
    cancel_agent_work_in_pool(&state.pool, request.work_item_id)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn api_reassign_agent_work(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ReassignAgentWorkRequest>,
) -> Result<impl IntoResponse, Response> {
    reassign_agent_work_in_pool(
        &state.pool,
        request.work_item_id,
        request.target_agent_id,
        request.reason,
    )
    .await
    .map(|_| Json(json!({ "ok": true })))
    .map_err(api_error)
}

async fn api_retry_agent_work(
    State(state): State<Arc<WebState>>,
    Json(request): Json<WorkItemIdRequest>,
) -> Result<impl IntoResponse, Response> {
    retry_agent_work_in_pool(&state.pool, request.work_item_id)
        .await
        .map(|work_item_id| Json(json!({ "workItemId": work_item_id })))
        .map_err(api_error)
}

async fn api_install_supervisor_service(
    State(state): State<Arc<WebState>>,
) -> Result<impl IntoResponse, Response> {
    let status = launch_agent::install_supervisor_service(&state.db_url).map_err(api_error)?;
    let _ = notify_ui_refresh(&state.pool, "supervisor_service_installed").await;
    Ok(Json(status))
}

async fn api_uninstall_supervisor_service(
    State(state): State<Arc<WebState>>,
) -> Result<impl IntoResponse, Response> {
    let status = launch_agent::uninstall_supervisor_service().map_err(api_error)?;
    sqlx::query("update supervisor_state set status = 'offline', updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now') where id = 1")
        .execute(&state.pool)
        .await
        .map_err(to_string)
        .map_err(api_error)?;
    let _ = notify_ui_refresh(&state.pool, "supervisor_service_uninstalled").await;
    Ok(Json(status))
}

async fn api_artifact_read(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ArtifactReadRequest>,
) -> Result<impl IntoResponse, Response> {
    load_artifact(&state.pool, request.artifact_id)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_open_dm_with_agent(
    State(state): State<Arc<WebState>>,
    Json(request): Json<AgentIdRequest>,
) -> Result<impl IntoResponse, Response> {
    open_dm_with_agent_in_pool(&state.pool, request.agent_id)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_agent_workspace_list(
    State(state): State<Arc<WebState>>,
    Json(request): Json<AgentWorkspaceRequest>,
) -> Result<impl IntoResponse, Response> {
    agent_workspace_list_in_pool(&state.pool, request.agent_id, &request.path)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_agent_workspace_read_file(
    State(state): State<Arc<WebState>>,
    Json(request): Json<AgentWorkspaceRequest>,
) -> Result<impl IntoResponse, Response> {
    agent_workspace_read_file_in_pool(&state.pool, request.agent_id, &request.path)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn api_events(State(state): State<Arc<WebState>>) -> Result<impl IntoResponse, Response> {
    let pool = state.pool.clone();
    let stream = async_stream::stream! {
        let mut last_id: i64 = sqlx::query_scalar("select coalesce(max(id), 0) from ui_events")
            .fetch_one(&pool)
            .await
            .unwrap_or(0);
        loop {
            match load_ui_backend_event_payload(&pool, &mut last_id, 80, Duration::from_millis(40))
                .await
            {
                Ok(None) => {
                    sleep(Duration::from_millis(500)).await;
                }
                Ok(Some(payload)) => {
                    yield Ok::<Event, Infallible>(
                        Event::default().event("lantor").data(payload)
                    );
                },
                Err(err) => {
                    yield Ok(Event::default().event("error").data(err.to_string()));
                    sleep(Duration::from_secs(2)).await;
                },
            }
        }
    };
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response();
    apply_sse_no_buffer_headers(&mut response);
    Ok(response)
}

async fn api_attachment(
    State(state): State<Arc<WebState>>,
    AxumPath(attachment_id): AxumPath<Uuid>,
) -> Result<Response, Response> {
    let row = sqlx::query(
        r#"
        select original_name, mime_type, storage_path
        from message_attachments
        where id = $1
        "#,
    )
    .bind(attachment_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(to_string)
    .map_err(api_error)?
    .ok_or_else(|| api_error("attachment does not exist".to_owned()))?;

    let original_name: String = row.get("original_name");
    let mime_type: String = row.get("mime_type");
    let storage_path: String = row.get("storage_path");
    let bytes = tokio::fs::read(Path::new(&storage_path))
        .await
        .map_err(to_string)
        .map_err(api_error)?;
    let content_type = if mime_type.trim().is_empty() {
        mime_guess::from_path(&storage_path)
            .first_or_octet_stream()
            .to_string()
    } else {
        mime_type
    };
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "inline; filename=\"{}\"",
            original_name.replace('"', "")
        ))
        .unwrap_or(HeaderValue::from_static("inline")),
    );
    Ok(response)
}

fn apply_sse_no_buffer_headers(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate, no-transform"),
    );
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(header::EXPIRES, HeaderValue::from_static("0"));
    headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
}

fn api_error(message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError { ok: false, message }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_no_buffer_headers_disable_client_and_proxy_buffering() {
        let mut response = Response::new(Body::empty());

        apply_sse_no_buffer_headers(&mut response);

        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache, no-store, must-revalidate, no-transform"
        );
        assert_eq!(response.headers().get(header::PRAGMA).unwrap(), "no-cache");
        assert_eq!(response.headers().get(header::EXPIRES).unwrap(), "0");
        assert_eq!(
            response.headers().get(header::CONNECTION).unwrap(),
            "keep-alive"
        );
        assert_eq!(response.headers().get("x-accel-buffering").unwrap(), "no");
    }

    #[test]
    fn monitoring_bucket_labels_omit_year_for_chart_axis() {
        assert_eq!(monitoring_bucket_label("2026-06-03"), "6/3");
        assert_eq!(monitoring_bucket_label("2026-W09"), "W9");
    }

    #[test]
    fn monitoring_agent_label_prefers_display_name() {
        let agent = json!({
            "handle": "@agent-id-like",
            "display_name": "  蕾姆   "
        });
        assert_eq!(monitoring_agent_label(&agent), "蕾姆");

        let missing_name = json!({
            "handle": "@fallback",
            "display_name": ""
        });
        assert_eq!(monitoring_agent_label(&missing_name), "@fallback");
    }

    #[test]
    fn monitoring_agent_controls_put_compare_second_then_sort_names() {
        let html = monitoring_preview_html(&json!({
            "scope": "compare",
            "window": "30d",
            "bucket": "day",
            "metric": "total_tokens",
            "global": {
                "runs": 3,
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
                "cost_usd": 0.1
            },
            "agents": [
                { "handle": "@beta", "display_name": "Beta", "runs": 1, "input_tokens": 1, "output_tokens": 1, "total_tokens": 2, "cost_usd": 0.0 },
                { "handle": "@alpha", "display_name": "Alpha", "runs": 1, "input_tokens": 1, "output_tokens": 1, "total_tokens": 2, "cost_usd": 0.0 }
            ],
            "agent_time_series": [
                { "bucket": "2026-06-03", "handle": "@alpha", "display_name": "Alpha", "runs": 1, "input_tokens": 100, "output_tokens": 0, "total_tokens": 100, "cost_usd": 0.0 },
                { "bucket": "2026-06-03", "handle": "@beta", "display_name": "Beta", "runs": 1, "input_tokens": 50, "output_tokens": 0, "total_tokens": 50, "cost_usd": 0.0 }
            ]
        }));
        let all = html.find(">All</a>").expect("all control");
        let compare = html.find(">Compare</a>").expect("compare control");
        let alpha = html.find(">Alpha</a>").expect("alpha control");
        let beta = html.find(">Beta</a>").expect("beta control");
        assert!(all < compare);
        assert!(compare < alpha);
        assert!(alpha < beta);
        assert!(html.contains("Agent compare"));
        assert!(html.contains("legend-item"));
        assert!(html.contains(
            ".controls { display:flex; flex-wrap:nowrap; gap:8px; margin-bottom:12px; align-items:start; overflow:visible;"
        ));
    }
}

fn voice_api_error(err: VoiceTranscriptionError) -> Response {
    let status = match err.code {
        "providerTimedOut" => StatusCode::GATEWAY_TIMEOUT,
        "providerNotConfigured" => StatusCode::SERVICE_UNAVAILABLE,
        "providerStartFailed"
        | "providerIoFailed"
        | "providerFailed"
        | "providerInvalidOutput"
        | "emptyTranscript" => StatusCode::BAD_GATEWAY,
        _ => StatusCode::BAD_REQUEST,
    };
    (
        status,
        Json(json!({
            "ok": false,
            "code": err.code,
            "message": err.message,
        })),
    )
        .into_response()
}
