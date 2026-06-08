use std::{collections::HashSet, env, process::Stdio, sync::OnceLock, time::Duration};

use chrono::{DateTime, Utc};
use pinyin::ToPinyin;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex as AsyncMutex,
    task::JoinHandle,
    time::timeout,
};
use uuid::Uuid;

use crate::{
    cancel_agent_work_in_pool, dispatch_agent_work_in_pool,
    events::{
        notify_ui_call_dispatch_upsert, notify_ui_call_session_upsert,
        notify_ui_call_utterance_upsert, notify_ui_message_upsert,
    },
    models::{
        CallDispatch, CallHistoryPage, CallSession, CallUtterance, CallUtteranceSubmitResult,
        Message,
    },
    prompts::call::{
        call_worker_brief_header, call_worker_brief_intro, CALL_COORDINATOR_SYSTEM_PROMPT,
    },
    publish_guard::bump_thread_version,
    text::compact_chars_middle,
    to_string, voice, AgentWorkDispatchInput, AgentWorkDispatchProvenance, CommandResult,
};

const CALL_WORK_TRANSCRIPT_EXCERPT_LIMIT: usize = 4 * 1024;
const CALL_WORK_SPOKEN_REQUEST_PAYLOAD_BUDGET: usize = 16 * 1024;
const CALL_COORDINATOR_COMMAND_ENV: &str = "LANTOR_CALL_COORDINATOR_COMMAND";
const CALL_COORDINATOR_MODEL_ENV: &str = "LANTOR_CALL_COORDINATOR_MODEL";
const CALL_COORDINATOR_REASONING_EFFORT_ENV: &str = "LANTOR_CALL_COORDINATOR_REASONING_EFFORT";
const DEFAULT_CALL_COORDINATOR_MODEL: &str = "gpt-5.5";
const DEFAULT_CALL_COORDINATOR_REASONING_EFFORT: &str = "low";
const CALL_COORDINATOR_TIMEOUT: Duration = Duration::from_secs(60);
const CALL_COORDINATOR_RUNTIME_KEY: &str = "codex_call_coordinator";
const CALL_DISPATCH_QUEUE_LEASE_SECONDS: i64 = 120;
const CALL_COORDINATOR_TRANSCRIPT_CONTEXT_LIMIT: usize = 12;
const CALL_COORDINATOR_MESSAGE_CONTEXT_LIMIT: usize = 16;
const CALL_SESSION_MODE_CALL: &str = "call";
const CALL_SESSION_MODE_WAKE_WORD: &str = "wake_word";
const DEFAULT_CALL_WAKE_WORDS: &[&str] = &["兰托", "蓝托", "lantor"];
const CALL_SYSTEM_CHANNEL_NAME: &str = "voice-console";
const CALL_BOOTSTRAP_SESSION_LIMIT: i64 = 20;
const CALL_BOOTSTRAP_UTTERANCE_LIMIT: i64 = 600;
const CALL_BOOTSTRAP_DISPATCH_LIMIT: i64 = 160;
const DEFAULT_FETCH_CALL_HISTORY_LIMIT: i64 = 160;
const MAX_FETCH_CALL_HISTORY_LIMIT: i64 = 300;
#[derive(Clone, Copy)]
enum CallVoiceLanguage {
    ZhCn,
    EnUs,
}

impl CallVoiceLanguage {
    fn from_hint(value: Option<&str>) -> Self {
        let normalized = value.unwrap_or("").trim().to_ascii_lowercase();
        if normalized.starts_with("en") {
            Self::EnUs
        } else {
            Self::ZhCn
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::ZhCn => "zh-CN",
            Self::EnUs => "en-US",
        }
    }

    fn no_speech(self) -> &'static str {
        match self {
            Self::ZhCn => "这段没有检测到说话，我先忽略了。",
            Self::EnUs => "I did not detect speech, so I ignored that segment.",
        }
    }

    fn transcription_failed(self) -> &'static str {
        match self {
            Self::ZhCn => "这段话我没有转写成功，请再试一次。",
            Self::EnUs => "I could not transcribe that. Please try again.",
        }
    }

    fn queued(self) -> &'static str {
        match self {
            Self::ZhCn => "收到，已进入调度队列。",
            Self::EnUs => "Got it. I queued that for dispatch.",
        }
    }

    fn heard(self) -> &'static str {
        match self {
            Self::ZhCn => "我听到了。",
            Self::EnUs => "I heard you.",
        }
    }

    fn wake_word_only(self) -> &'static str {
        match self {
            Self::ZhCn => "我在，您说。",
            Self::EnUs => "I'm here. Please continue.",
        }
    }

    fn wake_word_required(self) -> &'static str {
        match self {
            Self::ZhCn => "等待唤醒词。",
            Self::EnUs => "Waiting for the wake word.",
        }
    }

    fn ignored_tail(self) -> &'static str {
        match self {
            Self::ZhCn => "我捕捉到一小段尾音，已经忽略。",
            Self::EnUs => "I caught a short trailing sound and ignored it.",
        }
    }

    fn dispatch_failed(self) -> &'static str {
        match self {
            Self::ZhCn => "这个任务没有成功派出去，请再说一遍或换个 agent。",
            Self::EnUs => {
                "I could not dispatch that task. Please repeat it or choose another agent."
            }
        }
    }

    fn coordinator_unavailable(self) -> &'static str {
        match self {
            Self::ZhCn => "我听到了，但电话调度 Agent 现在没有响应。请稍后再试。",
            Self::EnUs => "I heard you, but the call dispatcher is not responding right now. Please try again later.",
        }
    }

    fn unavailable_target(self) -> &'static str {
        match self {
            Self::ZhCn => "我听到了，但需要一个可用的 agent 目标。",
            Self::EnUs => "I heard the request, but I need an available agent target.",
        }
    }

    fn low_confidence_dispatch(self) -> &'static str {
        match self {
            Self::ZhCn => "我可能听错了。请先确认目标和请求内容，我再分配。",
            Self::EnUs => "I may have misheard that. Please confirm the target and request before I assign it.",
        }
    }

    fn assigned_to(self, handle: &str) -> String {
        match self {
            Self::ZhCn => format!("收到，我已分配给 @{handle}。"),
            Self::EnUs => format!("Got it. I assigned this to @{handle}."),
        }
    }

    fn cancel_request(self) -> &'static str {
        match self {
            Self::ZhCn => "我会尝试停止这个通话请求。",
            Self::EnUs => "I will try to stop that call request.",
        }
    }

    fn need_more_detail(self) -> &'static str {
        match self {
            Self::ZhCn => "我听到了，但需要更多细节才能分配。",
            Self::EnUs => {
                "I heard the request, but I need a little more detail before assigning it."
            }
        }
    }
}

pub(crate) async fn migrate_call_mode_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    for statement in [
        r#"
        create table if not exists call_sessions (
            id blob primary key not null default (randomblob(16)),
            channel_id blob references channels(id) on delete set null,
            thread_root_id blob references messages(id) on delete set null,
            mode text not null default 'call',
            wake_words text not null default '',
            status text not null default 'active',
            title text,
            started_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
            ended_at text,
            updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now'))
        )
        "#,
        r#"
        create table if not exists provider_runtime_sessions (
            runtime text primary key not null,
            provider_thread_id text not null,
            status text not null default 'idle',
            created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
            updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now'))
        )
        "#,
        r#"
        create table if not exists call_utterances (
            id blob primary key not null default (randomblob(16)),
            session_id blob not null references call_sessions(id) on delete cascade,
            thread_root_utterance_id blob references call_utterances(id) on delete set null,
            source_message_id blob references messages(id) on delete set null,
            sequence integer not null,
            transcript text not null default '',
            language text not null default '',
            transcription_provider text not null default '',
            transcription_error text not null default '',
            audio_mime_type text not null default '',
            audio_original_name text,
            audio_duration_ms integer,
            status text not null default 'transcribing',
            created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
            updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
            unique(session_id, sequence)
        )
        "#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }

    let rows = sqlx::query("pragma table_info(agent_work_items)")
        .fetch_all(pool)
        .await?;
    let work_item_columns = rows
        .iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<HashSet<_>>();
    for (column, column_type) in [
        ("call_session_id", "blob"),
        ("call_utterance_id", "blob"),
        ("call_dispatch_id", "blob"),
        ("result_body", "text not null default ''"),
    ] {
        if !work_item_columns.contains(column) {
            sqlx::query(&format!(
                "alter table agent_work_items add column {column} {column_type}"
            ))
            .execute(pool)
            .await?;
        }
    }

    let rows = sqlx::query("pragma table_info(call_sessions)")
        .fetch_all(pool)
        .await?;
    let session_columns = rows
        .iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<HashSet<_>>();
    if !session_columns.contains("mode") {
        sqlx::query("alter table call_sessions add column mode text not null default 'call'")
            .execute(pool)
            .await?;
    }
    if !session_columns.contains("wake_words") {
        sqlx::query("alter table call_sessions add column wake_words text not null default ''")
            .execute(pool)
            .await?;
    }

    let rows = sqlx::query("pragma table_info(call_utterances)")
        .fetch_all(pool)
        .await?;
    let utterance_columns = rows
        .iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<HashSet<_>>();
    if !utterance_columns.contains("thread_root_utterance_id") {
        sqlx::query(
            "alter table call_utterances add column thread_root_utterance_id blob references call_utterances(id) on delete set null",
        )
        .execute(pool)
        .await?;
    }
    if !utterance_columns.contains("source_message_id") {
        sqlx::query(
            "alter table call_utterances add column source_message_id blob references messages(id) on delete set null",
        )
        .execute(pool)
        .await?;
    }
    if !utterance_columns.contains("language") {
        sqlx::query("alter table call_utterances add column language text not null default ''")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        create table if not exists call_dispatches (
            id blob primary key not null default (randomblob(16)),
            session_id blob not null references call_sessions(id) on delete cascade,
            utterance_id blob not null references call_utterances(id) on delete cascade,
            intent text not null,
            ack_status text not null,
            ack_text text not null,
            speech_topic text not null default '',
            confidence text not null default 'low',
            target_agent_id blob references agents(id) on delete set null,
            work_item_id blob references agent_work_items(id) on delete set null,
            compensated_work_item_id blob references agent_work_items(id) on delete set null,
            long_task_id text references long_tasks(id) on delete set null,
            status text not null default 'acknowledged',
            error text not null default '',
            created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
            updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now'))
        )
        "#,
    )
    .execute(pool)
    .await?;

    let rows = sqlx::query("pragma table_info(call_dispatches)")
        .fetch_all(pool)
        .await?;
    let dispatch_columns = rows
        .iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<HashSet<_>>();
    if !dispatch_columns.contains("compensated_work_item_id") {
        sqlx::query(
            "alter table call_dispatches add column compensated_work_item_id blob references agent_work_items(id) on delete set null",
        )
        .execute(pool)
        .await?;
    }
    if !dispatch_columns.contains("speech_topic") {
        sqlx::query("alter table call_dispatches add column speech_topic text not null default ''")
            .execute(pool)
            .await?;
    }

    for statement in [
        "create index if not exists call_sessions_status_updated_idx on call_sessions(status, updated_at desc)",
        "create index if not exists call_sessions_channel_idx on call_sessions(channel_id, started_at desc)",
        "create index if not exists call_utterances_session_sequence_idx on call_utterances(session_id, sequence)",
        "create index if not exists call_utterances_thread_root_idx on call_utterances(session_id, thread_root_utterance_id, sequence)",
        "create index if not exists call_dispatches_session_created_idx on call_dispatches(session_id, created_at)",
        "create index if not exists call_dispatches_work_item_idx on call_dispatches(work_item_id) where work_item_id is not null",
        "create index if not exists agent_work_items_call_session_idx on agent_work_items(call_session_id, created_at desc) where call_session_id is not null",
    ] {
        sqlx::query(statement).execute(pool).await?;
    }

    sqlx::query(
        r#"
        update call_dispatches
        set status = 'queued',
            ack_status = 'queued',
            ack_text = 'Recovered stale dispatcher claim and restored this to the dispatch queue.',
            error = 'recovered stale dispatcher claim on startup',
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where intent = 'coordinator_pending'
          and status = 'dispatching'
        "#,
    )
    .execute(pool)
    .await?;

    backfill_call_work_item_result_bodies(pool).await?;
    Ok(())
}

async fn backfill_call_work_item_result_bodies(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let run_columns = sqlx::query("pragma table_info(agent_runs)")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<HashSet<_>>();
    if !run_columns.contains("log") {
        return Ok(());
    }

    let rows = sqlx::query(
        r#"
        select w.id, r.log
        from agent_work_items w
        join agent_runs r on r.id = w.run_id
        where w.call_session_id is not null
          and coalesce(w.result_body, '') = ''
          and r.log like '%"phase":"final_answer"%'
        "#,
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let work_item_id: Uuid = row.get("id");
        let log: String = row.get("log");
        let Some(result_body) = final_answer_text_from_run_log(&log) else {
            continue;
        };
        sqlx::query(
            r#"
            update agent_work_items
            set result_body = $2
            where id = $1
              and coalesce(result_body, '') = ''
            "#,
        )
        .bind(work_item_id)
        .bind(result_body)
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn final_answer_text_from_run_log(log: &str) -> Option<String> {
    let mut result = None;
    for line in log.lines() {
        if !line.contains("\"phase\":\"final_answer\"") {
            continue;
        }
        let Some((_, payload)) = line
            .split_once("[codex] ")
            .or_else(|| line.split_once("[claude] "))
        else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        let Some(item) = value.pointer("/params/item") else {
            continue;
        };
        if item.get("phase").and_then(Value::as_str) != Some("final_answer") {
            continue;
        }
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            if !text.trim().is_empty() {
                result = Some(text.to_owned());
            }
        }
    }
    result
}

pub(crate) async fn load_call_sessions(pool: &SqlitePool) -> CommandResult<Vec<CallSession>> {
    let rows = sqlx::query(
        r#"
        select id, channel_id, thread_root_id, mode, wake_words, status, title, started_at, ended_at, updated_at
        from call_sessions
        order by case when status = 'active' then 0 else 1 end, updated_at desc, started_at desc
        limit $1
        "#,
    )
    .bind(CALL_BOOTSTRAP_SESSION_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    Ok(rows.into_iter().map(call_session_from_row).collect())
}

pub(crate) async fn load_call_utterances(pool: &SqlitePool) -> CommandResult<Vec<CallUtterance>> {
    let rows = sqlx::query(
        r#"
        select
            id, session_id, thread_root_utterance_id, source_message_id, sequence, transcript, language, transcription_provider,
            transcription_error, audio_mime_type, audio_original_name,
            audio_duration_ms, status, created_at, updated_at
        from (
            select *
            from call_utterances
            order by created_at desc, sequence desc
            limit $1
        ) recent
        order by created_at asc, sequence asc
        "#,
    )
    .bind(CALL_BOOTSTRAP_UTTERANCE_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    Ok(rows.into_iter().map(call_utterance_from_row).collect())
}

pub(crate) async fn load_call_dispatches(pool: &SqlitePool) -> CommandResult<Vec<CallDispatch>> {
    let rows = sqlx::query(
        r#"
        select
            d.id, d.session_id, d.utterance_id, u.sequence as utterance_sequence,
            d.intent, d.ack_status,
            d.ack_text, d.speech_topic, d.confidence, d.target_agent_id, d.work_item_id,
            d.compensated_work_item_id, d.long_task_id, d.status, d.error, d.created_at, d.updated_at
        from (
            select *
            from call_dispatches
            order by created_at desc, id desc
            limit $1
        ) d
        join call_utterances u on u.id = d.utterance_id
        order by d.created_at asc, d.id asc
        "#,
    )
    .bind(CALL_BOOTSTRAP_DISPATCH_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    Ok(rows.into_iter().map(call_dispatch_from_row).collect())
}

fn normalized_fetch_call_history_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(DEFAULT_FETCH_CALL_HISTORY_LIMIT)
        .clamp(1, MAX_FETCH_CALL_HISTORY_LIMIT)
}

pub(crate) async fn fetch_call_history_page(
    pool: &SqlitePool,
    before: DateTime<Utc>,
    limit: Option<i64>,
) -> CommandResult<CallHistoryPage> {
    let limit = normalized_fetch_call_history_limit(limit);
    let rows = sqlx::query(
        r#"
        select
            id, session_id, thread_root_utterance_id, source_message_id, sequence, transcript, language, transcription_provider,
            transcription_error, audio_mime_type, audio_original_name,
            audio_duration_ms, status, created_at, updated_at
        from (
            select *
            from call_utterances
            where julianday(created_at) < julianday($1)
            order by created_at desc, sequence desc
            limit $2
        ) recent
        order by created_at asc, sequence asc
        "#,
    )
    .bind(before)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    let utterances: Vec<CallUtterance> = rows.into_iter().map(call_utterance_from_row).collect();
    if utterances.is_empty() {
        return Ok(CallHistoryPage {
            utterances,
            dispatches: Vec::new(),
        });
    }

    let mut builder: QueryBuilder<Sqlite> = QueryBuilder::new(
        r#"
        select
            d.id, d.session_id, d.utterance_id, u.sequence as utterance_sequence,
            d.intent, d.ack_status,
            d.ack_text, d.speech_topic, d.confidence, d.target_agent_id, d.work_item_id,
            d.compensated_work_item_id, d.long_task_id, d.status, d.error, d.created_at, d.updated_at
        from call_dispatches d
        join call_utterances u on u.id = d.utterance_id
        where d.utterance_id in (
        "#,
    );
    let mut separated = builder.separated(", ");
    for utterance in &utterances {
        separated.push_bind(utterance.id);
    }
    separated.push_unseparated(
        r#")
        order by d.created_at asc, d.id asc
        "#,
    );

    let dispatch_rows = builder.build().fetch_all(pool).await.map_err(to_string)?;

    Ok(CallHistoryPage {
        utterances,
        dispatches: dispatch_rows
            .into_iter()
            .map(call_dispatch_from_row)
            .collect(),
    })
}

#[cfg(test)]
pub(crate) async fn call_session_start_in_pool(
    pool: &SqlitePool,
    channel_id: Option<Uuid>,
    thread_root_id: Option<Uuid>,
    title: Option<String>,
) -> CommandResult<CallSession> {
    call_session_start_with_options_in_pool(pool, channel_id, thread_root_id, title, None, None)
        .await
}

pub(crate) async fn call_session_start_with_options_in_pool(
    pool: &SqlitePool,
    channel_id: Option<Uuid>,
    thread_root_id: Option<Uuid>,
    title: Option<String>,
    mode: Option<String>,
    wake_words: Option<String>,
) -> CommandResult<CallSession> {
    let channel_id = resolve_call_session_channel(pool, channel_id, thread_root_id).await?;
    validate_call_surface(pool, Some(channel_id), thread_root_id).await?;
    let title = title
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let mode = normalize_call_session_mode(mode.as_deref());
    let wake_words = normalize_call_wake_words(wake_words.as_deref());
    let session_id: Uuid = sqlx::query_scalar(
        r#"
        insert into call_sessions (channel_id, thread_root_id, title, mode, wake_words)
        values ($1, $2, $3, $4, $5)
        returning id
        "#,
    )
    .bind(channel_id)
    .bind(thread_root_id)
    .bind(title)
    .bind(mode)
    .bind(wake_words)
    .fetch_one(pool)
    .await
    .map_err(to_string)?;
    let session = load_call_session(pool, session_id).await?;
    notify_ui_call_session_upsert(pool, &session, "call_session_started").await?;
    Ok(session)
}

pub(crate) async fn call_session_stop_in_pool(
    pool: &SqlitePool,
    session_id: Uuid,
) -> CommandResult<CallSession> {
    let affected = sqlx::query(
        r#"
        update call_sessions
        set status = case when status = 'active' then 'ended' else status end,
            ended_at = case when ended_at is null then strftime('%Y-%m-%dT%H:%M:%f+00:00','now') else ended_at end,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(session_id)
    .execute(pool)
    .await
    .map_err(to_string)?
    .rows_affected();
    if affected == 0 {
        return Err("call session not found".to_owned());
    }
    let session = load_call_session(pool, session_id).await?;
    notify_ui_call_session_upsert(pool, &session, "call_session_stopped").await?;
    Ok(session)
}

pub(crate) async fn call_dispatch_cancel_work_in_pool(
    pool: &SqlitePool,
    session_id: Uuid,
    work_item_id: Uuid,
    language: Option<String>,
) -> CommandResult<CallUtteranceSubmitResult> {
    let (session, utterance) = create_call_control_utterance(
        pool,
        session_id,
        &format!("Cancel call work {work_item_id}"),
        None,
        language.as_deref(),
        "call_control",
        "application/x-lantor-call-control",
    )
    .await?;
    let utterance = ensure_call_utterance_owner_message(pool, &utterance).await?;
    notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_acknowledged").await?;
    let dispatch = cancel_call_work_for_utterance(
        pool,
        &session,
        &utterance,
        Some(work_item_id),
        None,
        None,
        "high".to_owned(),
    )
    .await?;
    let utterance = load_call_utterance(pool, utterance.id).await?;
    call_submit_result(pool, session.id, utterance, dispatch).await
}

pub(crate) async fn call_dispatch_resolve_confirmation_in_pool(
    pool: &SqlitePool,
    session_id: Uuid,
    transcript: String,
    language: Option<String>,
) -> CommandResult<CallUtteranceSubmitResult> {
    submit_text_call_utterance_in_pool(
        pool,
        session_id,
        transcript,
        None,
        language.as_deref(),
        "call_control",
        "application/x-lantor-call-control",
        "confirmation response cannot be empty",
    )
    .await
}

pub(crate) async fn call_session_submit_text_utterance_in_pool(
    pool: &SqlitePool,
    session_id: Uuid,
    transcript: String,
    thread_root_utterance_id: Option<Uuid>,
    language: Option<String>,
) -> CommandResult<CallUtteranceSubmitResult> {
    submit_text_call_utterance_in_pool(
        pool,
        session_id,
        transcript,
        thread_root_utterance_id,
        language.as_deref(),
        "typed_simulation",
        "application/x-lantor-typed-utterance",
        "typed call utterance cannot be empty",
    )
    .await
}

async fn submit_text_call_utterance_in_pool(
    pool: &SqlitePool,
    session_id: Uuid,
    transcript: String,
    thread_root_utterance_id: Option<Uuid>,
    language: Option<&str>,
    transcription_provider: &str,
    audio_mime_type: &str,
    empty_error: &str,
) -> CommandResult<CallUtteranceSubmitResult> {
    let transcript = transcript.trim();
    if transcript.is_empty() {
        return Err(empty_error.to_owned());
    }
    let (session, utterance) = create_call_control_utterance(
        pool,
        session_id,
        transcript,
        thread_root_utterance_id,
        language,
        transcription_provider,
        audio_mime_type,
    )
    .await?;
    let utterance = ensure_call_utterance_owner_message(pool, &utterance).await?;
    notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_acknowledged").await?;
    if let Some(result) = apply_call_wake_word_gate(pool, &session, &utterance).await? {
        return Ok(result);
    }
    let queued_dispatch = queue_transcribed_call_utterance(pool, &session, &utterance).await?;
    let processed_dispatch =
        process_call_dispatch_queue(pool, session.id, Some(utterance.id)).await?;
    let fallback_dispatch = load_latest_call_dispatch_for_utterance(pool, utterance.id).await?;
    let dispatch = processed_dispatch
        .or(fallback_dispatch)
        .unwrap_or(queued_dispatch);
    let utterance = load_call_utterance(pool, utterance.id).await?;
    call_submit_result(pool, session.id, utterance, dispatch).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallUtteranceSubmitRequest {
    pub(crate) session_id: Uuid,
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime_type: String,
    #[serde(default)]
    pub(crate) original_name: Option<String>,
    #[serde(default)]
    pub(crate) duration_ms: Option<u32>,
    #[serde(default)]
    pub(crate) language: Option<String>,
    #[serde(default)]
    pub(crate) final_fragment_reason: Option<String>,
}

pub(crate) async fn call_session_submit_utterance_in_pool(
    pool: &SqlitePool,
    request: CallUtteranceSubmitRequest,
) -> CommandResult<CallUtteranceSubmitResult> {
    let final_fragment_reason = request.final_fragment_reason.clone();
    let voice_language = CallVoiceLanguage::from_hint(request.language.as_deref());
    let (session, utterance) = create_transcribing_utterance(
        pool,
        request.session_id,
        &request.mime_type,
        request.original_name.as_deref(),
        request.duration_ms,
        request.language.as_deref(),
    )
    .await?;
    notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_created").await?;

    let transcription = voice::transcribe_voice_audio(voice::VoiceTranscriptionRequest {
        bytes: request.bytes,
        mime_type: request.mime_type,
        original_name: request.original_name,
        duration_ms: request.duration_ms,
        language: request.language,
    })
    .await;

    let (utterance, dispatch) = match transcription {
        Ok(transcription) => {
            let utterance = update_utterance_transcribed(
                pool,
                utterance.id,
                &transcription.text,
                &transcription.provider,
            )
            .await?;
            notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_transcribed").await?;
            if should_ignore_low_value_final_fragment(
                utterance.transcript.trim(),
                final_fragment_reason.as_deref(),
            ) {
                let dispatch = dispatch_transcribed_call_utterance(
                    pool,
                    &session,
                    &utterance,
                    final_fragment_reason.as_deref(),
                )
                .await?;
                let utterance =
                    update_utterance_status(pool, utterance.id, "ignored", &dispatch.error).await?;
                notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_ignored").await?;
                return call_submit_result(pool, session.id, utterance, dispatch).await;
            }
            if let Some(result) = apply_call_wake_word_gate(pool, &session, &utterance).await? {
                return Ok(result);
            }
            let queued_dispatch =
                queue_transcribed_call_utterance(pool, &session, &utterance).await?;
            let processed_dispatch =
                process_call_dispatch_queue(pool, session.id, Some(utterance.id)).await?;
            let fallback_dispatch =
                load_latest_call_dispatch_for_utterance(pool, utterance.id).await?;
            let dispatch = processed_dispatch
                .or(fallback_dispatch)
                .unwrap_or(queued_dispatch);
            let utterance = load_call_utterance(pool, utterance.id).await?;
            (utterance, dispatch)
        }
        Err(err) => {
            let error = err.command_message();
            if is_no_speech_transcription_error(&err) {
                let utterance =
                    update_utterance_status(pool, utterance.id, "ignored", &error).await?;
                notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_ignored").await?;
                let dispatch = create_spoken_ack_dispatch(
                    pool,
                    &session,
                    utterance.id,
                    NewDispatch {
                        intent: "ack_only",
                        ack_status: "heard",
                        ack_text: voice_language.no_speech(),
                        speech_topic: "",
                        confidence: "low",
                        target_agent_id: None,
                        work_item_id: None,
                        long_task_id: None,
                        status: "ignored",
                        error: &error,
                    },
                    "call_dispatch_ignored",
                )
                .await?;
                (utterance, dispatch)
            } else {
                let utterance =
                    update_utterance_status(pool, utterance.id, "failed", &error).await?;
                notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_failed").await?;
                let dispatch = create_spoken_ack_dispatch(
                    pool,
                    &session,
                    utterance.id,
                    NewDispatch {
                        intent: "ack_only",
                        ack_status: "unsupported",
                        ack_text: voice_language.transcription_failed(),
                        speech_topic: "",
                        confidence: "high",
                        target_agent_id: None,
                        work_item_id: None,
                        long_task_id: None,
                        status: "failed",
                        error: &error,
                    },
                    "call_dispatch_acknowledged",
                )
                .await?;
                (utterance, dispatch)
            }
        }
    };

    call_submit_result(pool, session.id, utterance, dispatch).await
}

fn is_no_speech_transcription_error(err: &voice::VoiceTranscriptionError) -> bool {
    if err.code == "emptyTranscript" {
        return true;
    }
    let message = err.message.to_ascii_lowercase();
    message.contains("no speech") || message.contains("speech was not detected")
}

async fn call_submit_result(
    pool: &SqlitePool,
    session_id: Uuid,
    utterance: CallUtterance,
    dispatch: CallDispatch,
) -> CommandResult<CallUtteranceSubmitResult> {
    let session = load_call_session(pool, session_id).await?;
    let utterance = load_call_utterance(pool, utterance.id).await?;
    Ok(CallUtteranceSubmitResult {
        session,
        utterance,
        dispatch: dispatch.clone(),
        ack_text: dispatch.ack_text,
        work_item_id: dispatch.work_item_id,
        long_task_id: dispatch.long_task_id,
    })
}

fn normalize_call_session_mode(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some(CALL_SESSION_MODE_WAKE_WORD) => CALL_SESSION_MODE_WAKE_WORD,
        _ => CALL_SESSION_MODE_CALL,
    }
}

fn call_wake_words(raw: &str) -> Vec<String> {
    let parsed = raw
        .split([',', '\n', '，', '、'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if parsed.is_empty() {
        DEFAULT_CALL_WAKE_WORDS
            .iter()
            .map(|value| (*value).to_owned())
            .collect()
    } else {
        parsed
    }
}

fn normalize_call_wake_words(value: Option<&str>) -> String {
    call_wake_words(value.unwrap_or_default()).join(",")
}

fn trim_call_wake_separators(value: &str) -> &str {
    value.trim_start_matches(|ch: char| {
        ch.is_whitespace()
            || matches!(
                ch,
                ',' | '.' | ':' | ';' | '，' | '。' | '、' | '：' | '；' | '！' | '!'
            )
    })
}

fn normalize_call_wake_match_text(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

fn call_wake_filler_char(ch: char) -> bool {
    matches!(ch, '啊' | '呀' | '呢' | '呐' | '吧' | '哈' | '哦' | '喂')
}

fn trim_call_wake_remainder(value: &str) -> &str {
    let mut rest = trim_call_wake_separators(value);
    loop {
        let Some(ch) = rest.chars().next() else {
            return rest;
        };
        if !call_wake_filler_char(ch) {
            return rest;
        }
        rest = trim_call_wake_separators(&rest[ch.len_utf8()..]);
    }
}

fn call_wake_word_end_at(transcript: &str, start_byte: usize, wake_word: &str) -> Option<usize> {
    let mut transcript_chars = transcript[start_byte..].char_indices();
    let mut end_byte = None;
    for word_ch in wake_word.chars() {
        loop {
            let (offset, transcript_ch) = transcript_chars.next()?;
            let absolute_byte = start_byte + offset;
            if transcript_ch.is_whitespace() {
                continue;
            }
            if transcript_ch == word_ch {
                end_byte = Some(absolute_byte + transcript_ch.len_utf8());
                break;
            }
            return None;
        }
    }
    end_byte
}

fn call_wake_phonetic_tokens(value: &str) -> Vec<String> {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .filter_map(|ch| {
            ch.to_pinyin()
                .map(|pinyin| pinyin.plain().to_owned())
                .or_else(|| {
                    ch.is_ascii_alphanumeric()
                        .then(|| ch.to_ascii_lowercase().to_string())
                })
        })
        .collect()
}

fn call_wake_phonetic_candidate_end_at(
    transcript: &str,
    start_byte: usize,
    wake_tokens: &[String],
) -> Option<usize> {
    let mut matched = 0usize;
    for (offset, transcript_ch) in transcript[start_byte..].char_indices() {
        if transcript_ch.is_whitespace() {
            continue;
        }
        let Some(token) = transcript_ch
            .to_pinyin()
            .map(|pinyin| pinyin.plain().to_owned())
            .or_else(|| {
                transcript_ch
                    .is_ascii_alphanumeric()
                    .then(|| transcript_ch.to_ascii_lowercase().to_string())
            })
        else {
            return None;
        };
        if token != wake_tokens[matched] {
            return None;
        }
        matched += 1;
        let end_byte = start_byte + offset + transcript_ch.len_utf8();
        if matched == wake_tokens.len() {
            return Some(end_byte);
        }
    }
    None
}

fn call_wake_word_is_phonetic_match_candidate(word: &str, tokens: &[String]) -> bool {
    let char_count = word.chars().filter(|ch| !ch.is_whitespace()).count();
    (2..=4).contains(&char_count) && tokens.len() == char_count
}

fn call_wake_phonetic_search_prefix_limit(transcript: &str) -> usize {
    let mut seen = 0usize;
    for (byte, ch) in transcript.char_indices() {
        if ch.is_whitespace()
            || matches!(
                ch,
                ',' | '.' | ':' | ';' | '，' | '。' | '、' | '：' | '；' | '！' | '!' | '?' | '？'
            )
        {
            continue;
        }
        if seen >= 4 {
            return byte;
        }
        seen += 1;
    }
    transcript.len()
}

fn find_call_wake_word(transcript: &str, wake_words: &str) -> Option<(usize, usize)> {
    let lower = transcript.to_lowercase();
    let words = call_wake_words(wake_words)
        .into_iter()
        .map(|word| normalize_call_wake_match_text(&word))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let mut best: Option<(usize, usize)> = None;
    for (start_byte, ch) in lower.char_indices() {
        if ch.is_whitespace() {
            continue;
        }
        for word in &words {
            let Some(end_byte) = call_wake_word_end_at(&lower, start_byte, word) else {
                continue;
            };
            let candidate = (start_byte, end_byte);
            if best.is_none_or(|current| {
                candidate.0 < current.0 || (candidate.0 == current.0 && candidate.1 > current.1)
            }) {
                best = Some(candidate);
            }
        }
    }
    let phonetic_search_end = call_wake_phonetic_search_prefix_limit(&lower);
    for (start_byte, ch) in lower.char_indices() {
        if start_byte > phonetic_search_end {
            break;
        }
        if ch.is_whitespace() {
            continue;
        }
        for word in &words {
            let wake_tokens = call_wake_phonetic_tokens(word);
            if !call_wake_word_is_phonetic_match_candidate(word, &wake_tokens) {
                continue;
            }
            let Some(end_byte) =
                call_wake_phonetic_candidate_end_at(&lower, start_byte, &wake_tokens)
            else {
                continue;
            };
            let candidate = (start_byte, end_byte);
            if best.is_none_or(|current| {
                candidate.0 < current.0 || (candidate.0 == current.0 && candidate.1 > current.1)
            }) {
                best = Some(candidate);
            }
        }
    }
    best
}

fn strip_call_wake_word(transcript: &str, wake_words: &str) -> Option<String> {
    let transcript = transcript.trim();
    let (_, mut remaining_start) = find_call_wake_word(transcript, wake_words)?;
    loop {
        let rest = trim_call_wake_remainder(&transcript[remaining_start..]);
        let skipped = transcript.len().saturating_sub(rest.len());
        if let Some((start, end)) = find_call_wake_word(rest, wake_words) {
            if start == 0 {
                remaining_start = skipped + end;
                continue;
            }
        }
        return Some(rest.to_owned());
    }
}

async fn call_session_has_recent_wake_only_ack(
    pool: &SqlitePool,
    session: &CallSession,
    utterance: &CallUtterance,
) -> CommandResult<bool> {
    let prior_transcript: Option<String> = sqlx::query_scalar(
        r#"
        select transcript
        from call_utterances
        where session_id = $1
          and sequence < $2
          and status = 'acknowledged'
          and updated_at >= strftime('%Y-%m-%dT%H:%M:%f+00:00','now','-45 seconds')
        order by sequence desc
        limit 1
        "#,
    )
    .bind(session.id)
    .bind(utterance.sequence)
    .fetch_optional(pool)
    .await
    .map_err(to_string)?;
    Ok(prior_transcript
        .and_then(|transcript| strip_call_wake_word(&transcript, &session.wake_words))
        .is_some_and(|stripped| stripped.trim().is_empty()))
}

async fn apply_call_wake_word_gate(
    pool: &SqlitePool,
    session: &CallSession,
    utterance: &CallUtterance,
) -> CommandResult<Option<CallUtteranceSubmitResult>> {
    if session.mode != CALL_SESSION_MODE_WAKE_WORD {
        return Ok(None);
    }
    let voice_language = CallVoiceLanguage::from_hint(Some(&utterance.language));
    let Some(stripped_transcript) =
        strip_call_wake_word(&utterance.transcript, &session.wake_words)
    else {
        if call_session_has_recent_wake_only_ack(pool, session, utterance).await? {
            return Ok(None);
        }
        let error = format!("wake word required: {}", session.wake_words);
        let utterance = update_utterance_status(pool, utterance.id, "ignored", &error).await?;
        notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_ignored").await?;
        let dispatch = create_spoken_ack_dispatch(
            pool,
            session,
            utterance.id,
            NewDispatch {
                intent: "ack_only",
                ack_status: "heard",
                ack_text: voice_language.wake_word_required(),
                speech_topic: "",
                confidence: "high",
                target_agent_id: None,
                work_item_id: None,
                long_task_id: None,
                status: "ignored",
                error: &error,
            },
            "call_dispatch_ignored",
        )
        .await?;
        return call_submit_result(pool, session.id, utterance, dispatch)
            .await
            .map(Some);
    };
    if stripped_transcript.trim().is_empty() {
        let utterance = update_utterance_status(pool, utterance.id, "acknowledged", "").await?;
        notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_acknowledged").await?;
        let dispatch = create_spoken_ack_dispatch(
            pool,
            session,
            utterance.id,
            NewDispatch {
                intent: "ack_only",
                ack_status: "heard",
                ack_text: voice_language.wake_word_only(),
                speech_topic: "",
                confidence: "high",
                target_agent_id: None,
                work_item_id: None,
                long_task_id: None,
                status: "acknowledged",
                error: "",
            },
            "call_dispatch_acknowledged",
        )
        .await?;
        return call_submit_result(pool, session.id, utterance, dispatch)
            .await
            .map(Some);
    }
    let utterance = update_utterance_transcript(pool, utterance.id, &stripped_transcript).await?;
    notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_transcribed").await?;
    Ok(None)
}

async fn validate_call_surface(
    pool: &SqlitePool,
    channel_id: Option<Uuid>,
    thread_root_id: Option<Uuid>,
) -> CommandResult<()> {
    if let Some(channel_id) = channel_id {
        let exists: bool =
            sqlx::query_scalar("select exists(select 1 from channels where id = $1)")
                .bind(channel_id)
                .fetch_one(pool)
                .await
                .map_err(to_string)?;
        if !exists {
            return Err("channel not found".to_owned());
        }
    }
    if let Some(thread_root_id) = thread_root_id {
        let row =
            sqlx::query("select channel_id from messages where id = $1 and thread_root_id is null")
                .bind(thread_root_id)
                .fetch_optional(pool)
                .await
                .map_err(to_string)?;
        let Some(row) = row else {
            return Err("thread root not found".to_owned());
        };
        let thread_channel_id: Uuid = row.get("channel_id");
        if channel_id.is_some_and(|channel_id| channel_id != thread_channel_id) {
            return Err("thread root does not belong to the selected channel".to_owned());
        }
    }
    Ok(())
}

async fn resolve_call_session_channel(
    pool: &SqlitePool,
    channel_id: Option<Uuid>,
    thread_root_id: Option<Uuid>,
) -> CommandResult<Uuid> {
    if let Some(channel_id) = channel_id {
        return Ok(channel_id);
    }
    if let Some(thread_root_id) = thread_root_id {
        let channel_id: Option<Uuid> =
            sqlx::query_scalar("select channel_id from messages where id = $1")
                .bind(thread_root_id)
                .fetch_optional(pool)
                .await
                .map_err(to_string)?;
        if let Some(channel_id) = channel_id {
            return Ok(channel_id);
        }
    }
    ensure_call_system_channel(pool).await
}

async fn ensure_call_system_channel(pool: &SqlitePool) -> CommandResult<Uuid> {
    let existing_channel_id: Option<Uuid> =
        sqlx::query_scalar("select id from channels where name = $1")
            .bind(CALL_SYSTEM_CHANNEL_NAME)
            .fetch_optional(pool)
            .await
            .map_err(to_string)?;
    if let Some(channel_id) = existing_channel_id {
        sqlx::query("update channels set kind = 'voice' where id = $1 and kind <> 'voice'")
            .bind(channel_id)
            .execute(pool)
            .await
            .map_err(to_string)?;
        return Ok(channel_id);
    }
    let channel_id: Uuid = sqlx::query_scalar(
        r#"
        insert into channels (name, kind)
        values ($1, 'voice')
        returning id
        "#,
    )
    .bind(CALL_SYSTEM_CHANNEL_NAME)
    .fetch_one(pool)
    .await
    .map_err(to_string)?;
    Ok(channel_id)
}

async fn ensure_existing_call_session_channel(
    pool: &SqlitePool,
    session_id: Uuid,
) -> CommandResult<Option<CallSession>> {
    let row = sqlx::query(
        r#"
        select id, channel_id, thread_root_id, mode, wake_words, status, title, started_at, ended_at, updated_at
        from call_sessions
        where id = $1
        "#,
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(to_string)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let session = call_session_from_row(row);
    if session.channel_id.is_some() {
        return Ok(Some(session));
    }

    let channel_id = resolve_call_session_channel(pool, None, session.thread_root_id).await?;
    validate_call_surface(pool, Some(channel_id), session.thread_root_id).await?;
    sqlx::query(
        r#"
        update call_sessions
        set channel_id = $2,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
          and channel_id is null
        "#,
    )
    .bind(session_id)
    .bind(channel_id)
    .execute(pool)
    .await
    .map_err(to_string)?;

    let session = load_call_session(pool, session_id).await?;
    notify_ui_call_session_upsert(pool, &session, "call_session_channel_bound").await?;
    Ok(Some(session))
}

async fn load_call_session(pool: &SqlitePool, session_id: Uuid) -> CommandResult<CallSession> {
    let row = sqlx::query(
        r#"
        select id, channel_id, thread_root_id, mode, wake_words, status, title, started_at, ended_at, updated_at
        from call_sessions
        where id = $1
        "#,
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .map_err(to_string)?;
    Ok(call_session_from_row(row))
}

async fn create_transcribing_utterance(
    pool: &SqlitePool,
    session_id: Uuid,
    mime_type: &str,
    original_name: Option<&str>,
    duration_ms: Option<u32>,
    language: Option<&str>,
) -> CommandResult<(CallSession, CallUtterance)> {
    ensure_existing_call_session_channel(pool, session_id).await?;
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(to_string)?;
    let session_row = sqlx::query(
        r#"
        select id, channel_id, thread_root_id, mode, wake_words, status, title, started_at, ended_at, updated_at
        from call_sessions
        where id = $1
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(to_string)?;
    let Some(session_row) = session_row else {
        return Err("call session not found".to_owned());
    };
    let session = call_session_from_row(session_row);
    if session.status != "active" {
        return Err("call session is not active".to_owned());
    }
    let sequence: i64 = sqlx::query_scalar(
        "select coalesce(max(sequence), 0) + 1 from call_utterances where session_id = $1",
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(to_string)?;
    let utterance_id: Uuid = sqlx::query_scalar(
        r#"
        insert into call_utterances (
            session_id, sequence, audio_mime_type, audio_original_name,
            audio_duration_ms, language, status
        )
        values ($1, $2, $3, $4, $5, $6, 'transcribing')
        returning id
        "#,
    )
    .bind(session_id)
    .bind(sequence)
    .bind(mime_type.trim().to_ascii_lowercase())
    .bind(
        original_name
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(duration_ms.map(i64::from))
    .bind(CallVoiceLanguage::from_hint(language).code())
    .fetch_one(&mut *tx)
    .await
    .map_err(to_string)?;
    sqlx::query(
        "update call_sessions set updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now') where id = $1",
    )
    .bind(session_id)
    .execute(&mut *tx)
    .await
    .map_err(to_string)?;
    tx.commit().await.map_err(to_string)?;
    Ok((session, load_call_utterance(pool, utterance_id).await?))
}

async fn create_call_control_utterance(
    pool: &SqlitePool,
    session_id: Uuid,
    transcript: &str,
    thread_root_utterance_id: Option<Uuid>,
    language: Option<&str>,
    transcription_provider: &str,
    audio_mime_type: &str,
) -> CommandResult<(CallSession, CallUtterance)> {
    ensure_existing_call_session_channel(pool, session_id).await?;
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(to_string)?;
    let session_row = sqlx::query(
        r#"
        select id, channel_id, thread_root_id, mode, wake_words, status, title, started_at, ended_at, updated_at
        from call_sessions
        where id = $1
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(to_string)?;
    let Some(session_row) = session_row else {
        return Err("call session not found".to_owned());
    };
    let session = call_session_from_row(session_row);
    if session.status != "active" {
        return Err("call session is not active".to_owned());
    }
    if let Some(thread_root_utterance_id) = thread_root_utterance_id {
        let root_session_id: Option<Uuid> = sqlx::query_scalar(
            "select session_id from call_utterances where id = $1 and thread_root_utterance_id is null",
        )
        .bind(thread_root_utterance_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(to_string)?;
        if root_session_id != Some(session_id) {
            return Err("voice thread root not found for this call session".to_owned());
        }
    }
    let sequence: i64 = sqlx::query_scalar(
        "select coalesce(max(sequence), 0) + 1 from call_utterances where session_id = $1",
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(to_string)?;
    let utterance_id: Uuid = sqlx::query_scalar(
        r#"
        insert into call_utterances (
            session_id, thread_root_utterance_id, sequence, transcript, language, transcription_provider,
            audio_mime_type, status
        )
        values ($1, $2, $3, $4, $5, $6, $7, 'acknowledged')
        returning id
        "#,
    )
    .bind(session_id)
    .bind(thread_root_utterance_id)
    .bind(sequence)
    .bind(transcript.trim())
    .bind(CallVoiceLanguage::from_hint(language).code())
    .bind(transcription_provider.trim())
    .bind(audio_mime_type.trim().to_ascii_lowercase())
    .fetch_one(&mut *tx)
    .await
    .map_err(to_string)?;
    sqlx::query(
        "update call_sessions set updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now') where id = $1",
    )
    .bind(session_id)
    .execute(&mut *tx)
    .await
    .map_err(to_string)?;
    tx.commit().await.map_err(to_string)?;
    Ok((session, load_call_utterance(pool, utterance_id).await?))
}

async fn load_call_utterance(
    pool: &SqlitePool,
    utterance_id: Uuid,
) -> CommandResult<CallUtterance> {
    let row = sqlx::query(
        r#"
        select
            id, session_id, thread_root_utterance_id, source_message_id, sequence, transcript, language, transcription_provider,
            transcription_error, audio_mime_type, audio_original_name,
            audio_duration_ms, status, created_at, updated_at
        from call_utterances
        where id = $1
        "#,
    )
    .bind(utterance_id)
    .fetch_one(pool)
    .await
    .map_err(to_string)?;
    Ok(call_utterance_from_row(row))
}

async fn update_utterance_transcribed(
    pool: &SqlitePool,
    utterance_id: Uuid,
    transcript: &str,
    provider: &str,
) -> CommandResult<CallUtterance> {
    sqlx::query(
        r#"
        update call_utterances
        set transcript = $2,
            transcription_provider = $3,
            transcription_error = '',
            status = 'transcribed',
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(utterance_id)
    .bind(transcript)
    .bind(provider)
    .execute(pool)
    .await
    .map_err(to_string)?;
    let utterance = load_call_utterance(pool, utterance_id).await?;
    ensure_call_utterance_owner_message(pool, &utterance).await
}

async fn update_utterance_status(
    pool: &SqlitePool,
    utterance_id: Uuid,
    status: &str,
    error: &str,
) -> CommandResult<CallUtterance> {
    sqlx::query(
        r#"
        update call_utterances
        set status = $2,
            transcription_error = $3,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(utterance_id)
    .bind(status)
    .bind(error)
    .execute(pool)
    .await
    .map_err(to_string)?;
    load_call_utterance(pool, utterance_id).await
}

async fn update_utterance_transcript(
    pool: &SqlitePool,
    utterance_id: Uuid,
    transcript: &str,
) -> CommandResult<CallUtterance> {
    sqlx::query(
        r#"
        update call_utterances
        set transcript = $2,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(utterance_id)
    .bind(transcript.trim())
    .execute(pool)
    .await
    .map_err(to_string)?;
    let utterance = load_call_utterance(pool, utterance_id).await?;
    ensure_call_utterance_owner_message(pool, &utterance).await
}

async fn queue_transcribed_call_utterance(
    pool: &SqlitePool,
    session: &CallSession,
    utterance: &CallUtterance,
) -> CommandResult<CallDispatch> {
    let voice_language = CallVoiceLanguage::from_hint(Some(&utterance.language));
    let utterance = update_utterance_status(pool, utterance.id, "queued", "").await?;
    notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_queued").await?;
    let dispatch = create_dispatch(
        pool,
        session.id,
        utterance.id,
        NewDispatch {
            intent: "coordinator_pending",
            ack_status: "queued",
            ack_text: voice_language.queued(),
            speech_topic: "",
            confidence: "medium",
            target_agent_id: None,
            work_item_id: None,
            long_task_id: None,
            status: "queued",
            error: "",
        },
    )
    .await?;
    notify_ui_call_dispatch_upsert(pool, &dispatch, "call_dispatch_queued").await?;
    Ok(dispatch)
}

async fn process_call_dispatch_queue(
    pool: &SqlitePool,
    session_id: Uuid,
    return_dispatch_for_utterance_id: Option<Uuid>,
) -> CommandResult<Option<CallDispatch>> {
    let mut target_dispatch = None;
    while let Some((session, utterance, queued_dispatch)) =
        claim_next_call_dispatch_queue_item(pool, session_id).await?
    {
        let result = dispatch_transcribed_call_utterance(pool, &session, &utterance, None).await;
        match result {
            Ok(dispatch) => {
                if return_dispatch_for_utterance_id == Some(utterance.id) {
                    target_dispatch = Some(dispatch.clone());
                }
                mark_queued_call_dispatch_resolved(pool, queued_dispatch.id, &dispatch).await?;
                let utterance_status = if dispatch.status == "ignored" {
                    "ignored"
                } else if dispatch.intent == "agent_work" {
                    "dispatched"
                } else {
                    "acknowledged"
                };
                let utterance =
                    update_utterance_status(pool, utterance.id, utterance_status, "").await?;
                let reason = if dispatch.status == "ignored" {
                    "call_utterance_ignored"
                } else if dispatch.intent == "agent_work" {
                    "call_utterance_dispatched"
                } else {
                    "call_utterance_acknowledged"
                };
                notify_ui_call_utterance_upsert(pool, &utterance, reason).await?;
            }
            Err(err) => {
                let dispatch =
                    update_dispatch_failure(pool, queued_dispatch.id, "failed", &err).await?;
                if return_dispatch_for_utterance_id == Some(utterance.id) {
                    target_dispatch = Some(dispatch.clone());
                }
                notify_ui_call_dispatch_upsert(pool, &dispatch, "call_dispatch_failed").await?;
                let utterance = update_utterance_status(pool, utterance.id, "failed", &err).await?;
                notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_failed").await?;
            }
        }
    }
    Ok(target_dispatch)
}

async fn claim_next_call_dispatch_queue_item(
    pool: &SqlitePool,
    session_id: Uuid,
) -> CommandResult<Option<(CallSession, CallUtterance, CallDispatch)>> {
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(to_string)?;
    let stale_modifier = format!("-{} seconds", CALL_DISPATCH_QUEUE_LEASE_SECONDS);
    sqlx::query(
        r#"
        update call_dispatches
        set status = 'queued',
            ack_status = 'queued',
            ack_text = 'Recovered stale dispatcher claim and restored this to the dispatch queue.',
            error = 'recovered stale dispatcher claim',
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where session_id = $1
          and intent = 'coordinator_pending'
          and status = 'dispatching'
          and updated_at < strftime('%Y-%m-%dT%H:%M:%f+00:00','now', $2)
        "#,
    )
    .bind(session_id)
    .bind(&stale_modifier)
    .execute(&mut *tx)
    .await
    .map_err(to_string)?;

    let active_dispatching: bool = sqlx::query_scalar(
        r#"
        select exists(
            select 1
            from call_dispatches
            where session_id = $1
              and intent = 'coordinator_pending'
              and status = 'dispatching'
        )
        "#,
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(to_string)?;
    if active_dispatching {
        tx.commit().await.map_err(to_string)?;
        return Ok(None);
    }

    let row = sqlx::query(
        r#"
        select d.id as dispatch_id, u.id as utterance_id
        from call_dispatches d
        join call_utterances u on u.id = d.utterance_id
        where d.session_id = $1
          and d.intent = 'coordinator_pending'
          and d.status = 'queued'
        order by u.sequence asc, d.created_at asc
        limit 1
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(to_string)?;
    let Some(row) = row else {
        tx.commit().await.map_err(to_string)?;
        return Ok(None);
    };
    let dispatch_id: Uuid = row.get("dispatch_id");
    let utterance_id: Uuid = row.get("utterance_id");

    sqlx::query(
        r#"
        update call_dispatches
        set status = 'dispatching',
            ack_text = 'Dispatching.',
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(dispatch_id)
    .execute(&mut *tx)
    .await
    .map_err(to_string)?;
    sqlx::query(
        r#"
        update call_utterances
        set status = 'dispatching',
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(utterance_id)
    .execute(&mut *tx)
    .await
    .map_err(to_string)?;
    tx.commit().await.map_err(to_string)?;

    let session = load_call_session(pool, session_id).await?;
    let utterance = load_call_utterance(pool, utterance_id).await?;
    let dispatch = load_call_dispatch(pool, dispatch_id).await?;
    notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_dispatching").await?;
    notify_ui_call_dispatch_upsert(pool, &dispatch, "call_dispatch_dispatching").await?;
    Ok(Some((session, utterance, dispatch)))
}

async fn mark_queued_call_dispatch_resolved(
    pool: &SqlitePool,
    queued_dispatch_id: Uuid,
    final_dispatch: &CallDispatch,
) -> CommandResult<()> {
    sqlx::query(
        r#"
        update call_dispatches
        set status = 'superseded',
            ack_status = 'resolved',
            ack_text = $2,
            error = $3,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(queued_dispatch_id)
    .bind(&final_dispatch.ack_text)
    .bind(format!("resolved by call dispatch {}", final_dispatch.id))
    .execute(pool)
    .await
    .map_err(to_string)?;
    let queued_dispatch = load_call_dispatch(pool, queued_dispatch_id).await?;
    notify_ui_call_dispatch_upsert(pool, &queued_dispatch, "call_dispatch_queue_resolved").await?;
    Ok(())
}

async fn load_latest_call_dispatch_for_utterance(
    pool: &SqlitePool,
    utterance_id: Uuid,
) -> CommandResult<Option<CallDispatch>> {
    let row = sqlx::query(
        r#"
        select
            d.id, d.session_id, d.utterance_id, u.sequence as utterance_sequence,
            d.intent, d.ack_status, d.ack_text, d.speech_topic, d.confidence, d.target_agent_id,
            d.work_item_id, d.compensated_work_item_id, d.long_task_id,
            d.status, d.error, d.created_at, d.updated_at
        from call_dispatches d
        join call_utterances u on u.id = d.utterance_id
        where d.utterance_id = $1
          and not (d.intent = 'coordinator_pending' and d.status = 'superseded')
        order by d.created_at desc, d.updated_at desc, d.id desc
        limit 1
        "#,
    )
    .bind(utterance_id)
    .fetch_optional(pool)
    .await
    .map_err(to_string)?;
    Ok(row.map(call_dispatch_from_row))
}

#[derive(Clone)]
struct CallDispatchTarget {
    agent_id: Uuid,
    agent_handle: String,
    agent_display_name: String,
}

enum CallCoordinatorDecision {
    AnswerDirectly {
        ack_text: String,
    },
    Dispatch {
        target: CallDispatchTarget,
        confidence: String,
        ack_text: String,
        speech_topic: String,
        request_transcript: Option<String>,
    },
    CancelWork {
        work_item_id: Option<Uuid>,
        request_number: Option<i64>,
        ack_text: String,
        confidence: String,
    },
    Clarify {
        ack_text: String,
        error: String,
        confidence: String,
        ack_status: String,
        target: Option<CallDispatchTarget>,
    },
}

#[derive(Serialize)]
struct CallCoordinatorDecisionRequest {
    schema: &'static str,
    system_prompt: &'static str,
    session: CallCoordinatorSessionContext,
    current_utterance: CallCoordinatorUtteranceContext,
    available_agents: Vec<CallCoordinatorAgentContext>,
    active_call_work: Vec<CallCoordinatorActiveWorkContext>,
    pending_confirmations: Vec<CallCoordinatorPendingConfirmationContext>,
    recent_voice_thread_turns: Vec<CallCoordinatorTurnContext>,
    recent_call_turns: Vec<CallCoordinatorTurnContext>,
    recent_thread_messages: Vec<CallCoordinatorMessageContext>,
    output_contract: CallCoordinatorOutputContract,
}

#[derive(Serialize)]
struct CallCoordinatorSessionContext {
    id: Uuid,
    channel_id: Option<Uuid>,
    thread_root_id: Option<Uuid>,
    title: Option<String>,
}

#[derive(Serialize)]
struct CallCoordinatorUtteranceContext {
    id: Uuid,
    sequence: i64,
    thread_root_utterance_id: Option<Uuid>,
    thread_root_sequence: i64,
    voice_language: String,
    transcript: String,
}

#[derive(Clone, Serialize)]
struct CallCoordinatorAgentContext {
    id: Uuid,
    handle: String,
    display_name: String,
    status: String,
}

#[derive(Serialize)]
struct CallCoordinatorActiveWorkContext {
    work_item_id: Uuid,
    request_number: i64,
    agent_handle: String,
    status: String,
    request_transcript: String,
}

#[derive(Serialize)]
struct CallCoordinatorPendingConfirmationContext {
    dispatch_id: Uuid,
    utterance_id: Uuid,
    request_number: i64,
    target_agent_handle: String,
    request_transcript: String,
}

#[derive(Serialize)]
struct CallCoordinatorTurnContext {
    sequence: i64,
    transcript: String,
    dispatch_intent: Option<String>,
    dispatch_ack_status: Option<String>,
    dispatch_ack_text: Option<String>,
    dispatch_target_agent_handle: Option<String>,
    dispatch_status: Option<String>,
    created_at: String,
}

#[derive(Serialize)]
struct CallCoordinatorMessageContext {
    sender_name: String,
    sender_role: String,
    body: String,
    created_at: String,
}

#[derive(Serialize)]
struct CallCoordinatorOutputContract {
    allowed_actions: &'static [&'static str],
    required_json_shape: &'static str,
}

#[derive(Deserialize)]
struct CallCoordinatorDecisionResponse {
    tool: String,
    say: Option<String>,
    confidence: Option<String>,
    target_agent_id: Option<Uuid>,
    target_agent_handle: Option<String>,
    target_work_item_id: Option<Uuid>,
    target_request_number: Option<i64>,
    request_transcript: Option<String>,
    speech_topic: Option<String>,
    error: Option<String>,
}

struct CallCoordinatorAppServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    thread_id: String,
    next_request_id: i64,
}

static CALL_COORDINATOR_APP_SERVER: OnceLock<AsyncMutex<Option<CallCoordinatorAppServer>>> =
    OnceLock::new();

#[cfg(test)]
const TEST_ASYNC_ENQUEUE_FAILURE_MARKER: &str = "LANTOR_TEST_FAIL_ASYNC_ENQUEUE";
#[cfg(test)]
const TEST_LINK_DRIFT_MARKER: &str = "LANTOR_TEST_LINK_DRIFT";
#[cfg(test)]
const TEST_STARTED_LINK_DRIFT_MARKER: &str = "LANTOR_TEST_STARTED_LINK_DRIFT";

async fn dispatch_transcribed_call_utterance(
    pool: &SqlitePool,
    session: &CallSession,
    utterance: &CallUtterance,
    final_fragment_reason: Option<&str>,
) -> CommandResult<CallDispatch> {
    let transcript = utterance.transcript.trim();
    let voice_language = CallVoiceLanguage::from_hint(Some(&utterance.language));
    if transcript.is_empty() {
        let dispatch = create_spoken_ack_dispatch(
            pool,
            session,
            utterance.id,
            NewDispatch {
                intent: "ack_only",
                ack_status: "heard",
                ack_text: voice_language.heard(),
                speech_topic: "",
                confidence: "medium",
                target_agent_id: None,
                work_item_id: None,
                long_task_id: None,
                status: "acknowledged",
                error: "",
            },
            "call_dispatch_acknowledged",
        )
        .await?;
        return Ok(dispatch);
    }

    if should_ignore_low_value_final_fragment(transcript, final_fragment_reason) {
        let reason = final_fragment_reason
            .and_then(normalize_final_fragment_reason)
            .unwrap_or("stop");
        let error = format!("low_value_final_fragment:{reason}");
        let dispatch = create_spoken_ack_dispatch(
            pool,
            session,
            utterance.id,
            NewDispatch {
                intent: "ack_only",
                ack_status: "heard",
                ack_text: voice_language.ignored_tail(),
                speech_topic: "",
                confidence: "low",
                target_agent_id: None,
                work_item_id: None,
                long_task_id: None,
                status: "ignored",
                error: &error,
            },
            "call_dispatch_ignored",
        )
        .await?;
        return Ok(dispatch);
    }

    let decision = call_coordinator_decision(pool, session, utterance, transcript).await?;
    let CallCoordinatorDecision::Dispatch {
        target,
        confidence,
        ack_text,
        speech_topic,
        request_transcript,
    } = decision
    else {
        let (ack_text, error, confidence, ack_status, target) = match decision {
            CallCoordinatorDecision::AnswerDirectly { ack_text } => (
                ack_text,
                String::new(),
                "medium".to_owned(),
                "heard".to_owned(),
                None,
            ),
            CallCoordinatorDecision::Clarify {
                ack_text,
                error,
                confidence,
                ack_status,
                target,
            } => (ack_text, error, confidence, ack_status, target),
            CallCoordinatorDecision::CancelWork {
                work_item_id,
                request_number,
                ack_text,
                confidence,
            } => {
                let dispatch = cancel_call_work_for_utterance(
                    pool,
                    session,
                    utterance,
                    work_item_id,
                    request_number,
                    Some(ack_text),
                    confidence,
                )
                .await?;
                expire_stale_pending_after_call_turn(
                    pool,
                    session.id,
                    utterance.sequence,
                    &dispatch,
                )
                .await?;
                return Ok(dispatch);
            }
            CallCoordinatorDecision::Dispatch { .. } => unreachable!(),
        };
        let is_clarify = !error.is_empty();
        let dispatch = create_spoken_ack_dispatch(
            pool,
            session,
            utterance.id,
            NewDispatch {
                intent: if is_clarify { "clarify" } else { "ack_only" },
                ack_status: if is_clarify { &ack_status } else { "heard" },
                ack_text: &ack_text,
                speech_topic: "",
                confidence: &confidence,
                target_agent_id: target.as_ref().map(|target| target.agent_id),
                work_item_id: None,
                long_task_id: None,
                status: if is_clarify {
                    "needs_user"
                } else {
                    "acknowledged"
                },
                error: &error,
            },
            "call_dispatch_acknowledged",
        )
        .await?;
        expire_stale_pending_after_call_turn(pool, session.id, utterance.sequence, &dispatch)
            .await?;
        return Ok(dispatch);
    };

    let dispatch = create_spoken_ack_dispatch(
        pool,
        session,
        utterance.id,
        NewDispatch {
            intent: "agent_work",
            ack_status: "understood",
            ack_text: &ack_text,
            speech_topic: &speech_topic,
            confidence: &confidence,
            target_agent_id: Some(target.agent_id),
            work_item_id: None,
            long_task_id: None,
            status: "acknowledged",
            error: "",
        },
        "call_dispatch_acknowledged",
    )
    .await?;
    expire_stale_pending_after_call_turn(pool, session.id, utterance.sequence, &dispatch).await?;
    spawn_call_dispatch_work_enqueue(
        pool.clone(),
        session.clone(),
        utterance.clone(),
        dispatch.clone(),
        target,
        request_transcript,
    );

    Ok(dispatch)
}

async fn expire_stale_pending_after_call_turn(
    pool: &SqlitePool,
    session_id: Uuid,
    sequence: i64,
    dispatch: &CallDispatch,
) -> CommandResult<()> {
    if dispatch.status != "ignored" {
        expire_stale_pending_call_confirmation_candidates(pool, session_id, sequence + 1).await?;
    }
    Ok(())
}

fn spawn_call_dispatch_work_enqueue(
    pool: SqlitePool,
    session: CallSession,
    utterance: CallUtterance,
    dispatch: CallDispatch,
    target: CallDispatchTarget,
    request_transcript: Option<String>,
) {
    let transcript = request_transcript
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| utterance.transcript.trim().to_owned());
    spawn_call_dispatch_work_enqueue_with_transcript(
        pool, session, utterance, dispatch, target, transcript,
    );
}

fn spawn_call_dispatch_work_enqueue_with_transcript(
    pool: SqlitePool,
    session: CallSession,
    utterance: CallUtterance,
    dispatch: CallDispatch,
    target: CallDispatchTarget,
    request_transcript: String,
) {
    tokio::spawn(async move {
        let failure_session = session.clone();
        let failure_utterance = utterance.clone();
        let failure_dispatch = dispatch.clone();
        let failure_target = target.clone();
        if let Err(err) = enqueue_and_link_call_dispatch_work(
            &pool,
            session,
            utterance,
            dispatch,
            target,
            request_transcript,
        )
        .await
        {
            eprintln!("failed to enqueue call dispatch work: {err}");
            if let Err(report_err) = insert_call_dispatch_work_enqueue_failure(
                &pool,
                &failure_session,
                &failure_utterance,
                &failure_dispatch,
                &failure_target,
                &err,
            )
            .await
            {
                eprintln!("failed to report call dispatch work enqueue failure: {report_err}");
            }
        }
    });
}

async fn insert_call_dispatch_work_enqueue_failure(
    pool: &SqlitePool,
    session: &CallSession,
    utterance: &CallUtterance,
    dispatch: &CallDispatch,
    target: &CallDispatchTarget,
    error: &str,
) -> CommandResult<()> {
    let voice_language = CallVoiceLanguage::from_hint(Some(&utterance.language));
    let failed_dispatch = update_dispatch_failure(pool, dispatch.id, "failed", error).await?;
    notify_ui_call_dispatch_upsert(pool, &failed_dispatch, "call_dispatch_failed").await?;
    let failure = create_dispatch(
        pool,
        session.id,
        utterance.id,
        NewDispatch {
            intent: "agent_work_enqueue_failed",
            ack_status: "failed",
            ack_text: voice_language.dispatch_failed(),
            speech_topic: "",
            confidence: "high",
            target_agent_id: Some(target.agent_id),
            work_item_id: None,
            long_task_id: None,
            status: "failed",
            error,
        },
    )
    .await?;
    notify_ui_call_dispatch_upsert(pool, &failure, "call_dispatch_work_enqueue_failed").await?;
    Ok(())
}

async fn enqueue_and_link_call_dispatch_work(
    pool: &SqlitePool,
    session: CallSession,
    utterance: CallUtterance,
    dispatch: CallDispatch,
    target: CallDispatchTarget,
    request_transcript: String,
) -> CommandResult<()> {
    let transcript = request_transcript.trim();
    let work_title = call_work_title(transcript);
    let work_context = call_work_context(&session, &utterance, &dispatch, &target, transcript);
    let thread_root_id = utterance.source_message_id.or(session.thread_root_id);
    #[cfg(test)]
    let work = if transcript.contains(TEST_ASYNC_ENQUEUE_FAILURE_MARKER) {
        Err("test async enqueue failure after ack".to_owned())
    } else {
        dispatch_agent_work_in_pool(
            pool,
            AgentWorkDispatchInput {
                agent_id: target.agent_id,
                channel_id: session.channel_id,
                thread_root_id,
                source_message_id: utterance.source_message_id,
                task_id: None,
                title: &work_title,
                context: &work_context,
                provenance: Some(AgentWorkDispatchProvenance {
                    call_session_id: session.id,
                    call_utterance_id: utterance.id,
                    call_dispatch_id: dispatch.id,
                }),
            },
        )
        .await
    };

    #[cfg(not(test))]
    let work = dispatch_agent_work_in_pool(
        pool,
        AgentWorkDispatchInput {
            agent_id: target.agent_id,
            channel_id: session.channel_id,
            thread_root_id,
            source_message_id: utterance.source_message_id,
            task_id: None,
            title: &work_title,
            context: &work_context,
            provenance: Some(AgentWorkDispatchProvenance {
                call_session_id: session.id,
                call_utterance_id: utterance.id,
                call_dispatch_id: dispatch.id,
            }),
        },
    )
    .await;

    match work {
        Ok(work) => {
            #[cfg(test)]
            if transcript.contains(TEST_LINK_DRIFT_MARKER)
                || transcript.contains(TEST_STARTED_LINK_DRIFT_MARKER)
            {
                drift_call_work_link_for_test(pool, work.work_item_id).await?;
            }
            #[cfg(test)]
            if transcript.contains(TEST_STARTED_LINK_DRIFT_MARKER) {
                mark_call_work_started_for_test(pool, target.agent_id, work.work_item_id).await?;
            }

            match update_dispatch_work_item(
                pool,
                dispatch.id,
                session.id,
                utterance.id,
                work.work_item_id,
                "queued",
                "",
            )
            .await
            {
                Ok(dispatch) => {
                    notify_ui_call_dispatch_upsert(pool, &dispatch, "call_dispatch_work_linked")
                        .await?;
                }
                Err(err) => {
                    let dispatch = compensate_unlinked_call_dispatch_work(
                        pool,
                        dispatch.id,
                        work.work_item_id,
                        &err,
                    )
                    .await?;
                    let reason = if dispatch.status == "compensated" {
                        "call_dispatch_work_compensated"
                    } else {
                        "call_dispatch_failed"
                    };
                    notify_ui_call_dispatch_upsert(pool, &dispatch, reason).await?;
                }
            }
            Ok(())
        }
        Err(err) => {
            let dispatch = update_dispatch_failure(pool, dispatch.id, "failed", &err).await?;
            notify_ui_call_dispatch_upsert(pool, &dispatch, "call_dispatch_failed").await?;
            Ok(())
        }
    }
}

struct CallCancelableWork {
    id: Uuid,
    agent_id: Uuid,
    agent_handle: String,
    request_number: i64,
    status: String,
}

enum CallCancelResolution {
    Target(CallCancelableWork),
    NoActiveWork,
    NoMatchingHandle(i64),
    Ambiguous(Vec<CallCancelableWork>),
    NotCallLinked,
}

async fn finalize_pending_call_confirmation_candidate(
    pool: &SqlitePool,
    dispatch_id: Uuid,
    reason: &str,
    resolved_ack_text: &str,
) -> CommandResult<()> {
    sqlx::query(
        r#"
        update call_dispatches
        set ack_status = 'understood',
            ack_text = $3,
            status = 'superseded',
            error = $2,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
          and ack_status = 'needs_confirmation'
          and status = 'needs_user'
        "#,
    )
    .bind(dispatch_id)
    .bind(reason)
    .bind(resolved_ack_text)
    .execute(pool)
    .await
    .map_err(to_string)?;
    let dispatch = load_call_dispatch(pool, dispatch_id).await?;
    notify_ui_call_dispatch_upsert(pool, &dispatch, "call_dispatch_confirmation_resolved").await?;
    Ok(())
}

async fn expire_stale_pending_call_confirmation_candidates(
    pool: &SqlitePool,
    session_id: Uuid,
    before_sequence: i64,
) -> CommandResult<()> {
    let rows = sqlx::query(
        r#"
        select d.id as dispatch_id, u.id as utterance_id
        from call_dispatches d
        join call_utterances u on u.id = d.utterance_id
        where d.session_id = $1
          and u.sequence < $2
          and d.ack_status = 'needs_confirmation'
          and d.status = 'needs_user'
          and d.target_agent_id is not null
          and d.work_item_id is null
          and exists (
              select 1
              from call_utterances newer
              where newer.session_id = d.session_id
                and newer.sequence > u.sequence
                and newer.sequence < $2
                and newer.status <> 'ignored'
          )
        order by u.sequence asc, d.created_at asc
        "#,
    )
    .bind(session_id)
    .bind(before_sequence)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    for row in rows {
        let dispatch_id: Uuid = row.get("dispatch_id");
        let utterance_id: Uuid = row.get("utterance_id");
        finalize_pending_call_confirmation_candidate(
            pool,
            dispatch_id,
            &format!(
                "expired before call utterance sequence {}; pending utterance {}",
                before_sequence, utterance_id
            ),
            "Resolved. Confirmation expired after a newer call turn.",
        )
        .await?;
    }

    Ok(())
}

async fn cancel_call_work_for_utterance(
    pool: &SqlitePool,
    session: &CallSession,
    utterance: &CallUtterance,
    work_item_id: Option<Uuid>,
    request_number: Option<i64>,
    coordinator_ack_text: Option<String>,
    confidence: String,
) -> CommandResult<CallDispatch> {
    let resolution =
        resolve_cancelable_call_work(pool, session.id, work_item_id, request_number).await?;
    let CallCancelResolution::Target(work) = resolution else {
        let (ack_text, error) = match resolution {
            CallCancelResolution::NoActiveWork => (
                "I do not see active call work to cancel.".to_owned(),
                "no active call-linked work item matched the cancel request".to_owned(),
            ),
            CallCancelResolution::NoMatchingHandle(request_number) => (
                format!("I could not find active call request number {request_number}."),
                format!("spoken cancel did not match active call request number {request_number}"),
            ),
            CallCancelResolution::Ambiguous(works) => {
                let handles = cancelable_work_handle_list(&works);
                (
                    format!("Which call request should I cancel? I see {handles} active."),
                    "spoken cancel matched multiple active call-linked work items".to_owned(),
                )
            }
            CallCancelResolution::NotCallLinked => (
                "I could not find that active request in this call.".to_owned(),
                "requested work item is not an active work item linked to this call session"
                    .to_owned(),
            ),
            CallCancelResolution::Target(_) => unreachable!(),
        };
        return create_spoken_ack_dispatch(
            pool,
            session,
            utterance.id,
            NewDispatch {
                intent: "cancel_work",
                ack_status: "needs_target",
                ack_text: &ack_text,
                speech_topic: "",
                confidence: "high",
                target_agent_id: None,
                work_item_id: None,
                long_task_id: None,
                status: "needs_user",
                error: &error,
            },
            "call_dispatch_acknowledged",
        )
        .await;
    };

    if utterance.transcription_provider == "call_control" {
        let utterance = update_utterance_transcript(
            pool,
            utterance.id,
            &format!("Cancel call request number {}", work.request_number),
        )
        .await?;
        notify_ui_call_utterance_upsert(pool, &utterance, "call_utterance_acknowledged").await?;
    }

    let cancel_result = cancel_agent_work_in_pool(pool, work.id).await;
    let (ack_status, ack_text, status, error) = match cancel_result {
        Ok(()) if work.status == "cancelling" => (
            "understood",
            format!(
                "Cancellation is already in progress for request number {} with @{}.",
                work.request_number, work.agent_handle
            ),
            "queued",
            String::new(),
        ),
        Ok(()) => (
            "understood",
            format!(
                "Got it. I asked @{} to stop call request number {}.",
                work.agent_handle, work.request_number
            ),
            "queued",
            String::new(),
        ),
        Err(err) => (
            "unsupported",
            format!("I could not cancel that call request: {err}"),
            "failed",
            err,
        ),
    };

    create_spoken_ack_dispatch(
        pool,
        session,
        utterance.id,
        NewDispatch {
            intent: "cancel_work",
            ack_status,
            ack_text: coordinator_ack_text
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&ack_text),
            speech_topic: "",
            confidence: &confidence,
            target_agent_id: Some(work.agent_id),
            work_item_id: Some(work.id),
            long_task_id: None,
            status,
            error: &error,
        },
        "call_dispatch_acknowledged",
    )
    .await
}

async fn resolve_cancelable_call_work(
    pool: &SqlitePool,
    session_id: Uuid,
    work_item_id: Option<Uuid>,
    request_number: Option<i64>,
) -> CommandResult<CallCancelResolution> {
    if let Some(work_item_id) = work_item_id {
        let row = sqlx::query(
            r#"
            select w.id, w.agent_id, w.status, a.handle as agent_handle, u.sequence as request_number
            from agent_work_items w
            join agents a on a.id = w.agent_id
            join call_utterances u on u.id = w.call_utterance_id
            where w.id = $1
              and w.call_session_id = $2
              and w.status in ('queued', 'running', 'cancelling')
            limit 1
            "#,
        )
        .bind(work_item_id)
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .map_err(to_string)?;
        return row
            .map(call_cancelable_work_from_row)
            .transpose()
            .map(|work| {
                work.map(CallCancelResolution::Target)
                    .unwrap_or(CallCancelResolution::NotCallLinked)
            });
    }

    if let Some(request_number) = request_number {
        let rows = sqlx::query(
            r#"
            select w.id, w.agent_id, w.status, a.handle as agent_handle, u.sequence as request_number
            from agent_work_items w
            join agents a on a.id = w.agent_id
            join call_utterances u on u.id = w.call_utterance_id
            where w.call_session_id = $1
              and w.status in ('queued', 'running', 'cancelling')
              and u.sequence = $2
            order by w.updated_at desc, w.created_at desc
            limit 2
            "#,
        )
        .bind(session_id)
        .bind(request_number)
        .fetch_all(pool)
        .await
        .map_err(to_string)?;

        return match rows.len() {
            0 => Ok(CallCancelResolution::NoMatchingHandle(request_number)),
            1 => call_cancelable_work_from_row(rows.into_iter().next().unwrap())
                .map(CallCancelResolution::Target),
            _ => rows
                .into_iter()
                .map(call_cancelable_work_from_row)
                .collect::<CommandResult<Vec<_>>>()
                .map(CallCancelResolution::Ambiguous),
        };
    }

    let rows = sqlx::query(
        r#"
        select w.id, w.agent_id, w.status, a.handle as agent_handle, u.sequence as request_number
        from agent_work_items w
        join agents a on a.id = w.agent_id
        join call_utterances u on u.id = w.call_utterance_id
        where w.call_session_id = $1
          and w.status in ('queued', 'running', 'cancelling')
        order by u.sequence asc, w.created_at asc
        limit 6
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    match rows.len() {
        0 => Ok(CallCancelResolution::NoActiveWork),
        1 => call_cancelable_work_from_row(rows.into_iter().next().unwrap())
            .map(CallCancelResolution::Target),
        _ => rows
            .into_iter()
            .map(call_cancelable_work_from_row)
            .collect::<CommandResult<Vec<_>>>()
            .map(CallCancelResolution::Ambiguous),
    }
}

fn call_cancelable_work_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> CommandResult<CallCancelableWork> {
    Ok(CallCancelableWork {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        agent_handle: row.get("agent_handle"),
        request_number: row.get("request_number"),
        status: row.get("status"),
    })
}

#[cfg(test)]
async fn drift_call_work_link_for_test(pool: &SqlitePool, work_item_id: Uuid) -> CommandResult<()> {
    sqlx::query("update agent_work_items set call_dispatch_id = $2 where id = $1")
        .bind(work_item_id)
        .bind(Uuid::new_v4())
        .execute(pool)
        .await
        .map_err(to_string)?;
    Ok(())
}

#[cfg(test)]
async fn mark_call_work_started_for_test(
    pool: &SqlitePool,
    agent_id: Uuid,
    work_item_id: Uuid,
) -> CommandResult<()> {
    let run_id: Uuid = sqlx::query_scalar(
        "insert into agent_runs (agent_id, work_item_id, status) values ($1, $2, 'running') returning id",
    )
    .bind(agent_id)
    .bind(work_item_id)
    .fetch_one(pool)
    .await
    .map_err(to_string)?;

    sqlx::query(
        r#"
        update agent_work_items
        set status = 'running',
            run_id = $2,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(work_item_id)
    .bind(run_id)
    .execute(pool)
    .await
    .map_err(to_string)?;
    Ok(())
}

async fn call_coordinator_decision(
    pool: &SqlitePool,
    session: &CallSession,
    utterance: &CallUtterance,
    transcript: &str,
) -> CommandResult<CallCoordinatorDecision> {
    let voice_language = CallVoiceLanguage::from_hint(Some(&utterance.language));
    match call_coordinator_system_agent_decision(pool, session, utterance, transcript).await {
        Ok(decision) => Ok(decision),
        Err(err) => Ok(CallCoordinatorDecision::Clarify {
            ack_text: voice_language.coordinator_unavailable().to_owned(),
            error: err,
            confidence: "high".to_owned(),
            ack_status: "needs_target".to_owned(),
            target: None,
        }),
    }
}

async fn call_coordinator_system_agent_decision(
    pool: &SqlitePool,
    session: &CallSession,
    utterance: &CallUtterance,
    transcript: &str,
) -> CommandResult<CallCoordinatorDecision> {
    let available_agents = load_call_coordinator_agents(pool, session.channel_id).await?;
    let thread_root_utterance_id = utterance.thread_root_utterance_id.unwrap_or(utterance.id);
    let thread_root_sequence = if thread_root_utterance_id == utterance.id {
        utterance.sequence
    } else {
        load_call_utterance(pool, thread_root_utterance_id)
            .await
            .map(|root| root.sequence)
            .unwrap_or(utterance.sequence)
    };
    let request = CallCoordinatorDecisionRequest {
        schema: "lantor.call.coordinator_decision.v1",
        system_prompt: CALL_COORDINATOR_SYSTEM_PROMPT,
        session: CallCoordinatorSessionContext {
            id: session.id,
            channel_id: session.channel_id,
            thread_root_id: session.thread_root_id,
            title: session.title.clone(),
        },
        current_utterance: CallCoordinatorUtteranceContext {
            id: utterance.id,
            sequence: utterance.sequence,
            thread_root_utterance_id: utterance.thread_root_utterance_id,
            thread_root_sequence,
            voice_language: utterance.language.clone(),
            transcript: transcript.to_owned(),
        },
        available_agents: available_agents.clone(),
        active_call_work: load_call_coordinator_active_work_context(pool, session.id).await?,
        pending_confirmations: load_call_coordinator_pending_confirmation_context(
            pool,
            session.id,
            utterance.sequence,
        )
        .await?,
        recent_voice_thread_turns: load_call_coordinator_voice_thread_turn_context(
            pool,
            session.id,
            thread_root_utterance_id,
            utterance.sequence,
        )
        .await?,
        recent_call_turns: load_call_coordinator_turn_context(pool, session.id, utterance.sequence)
            .await?,
        recent_thread_messages: load_call_coordinator_message_context(
            pool,
            session.channel_id,
            session.thread_root_id,
        )
        .await?,
        output_contract: CallCoordinatorOutputContract {
            allowed_actions: &[
                "speak_to_user",
                "dispatch_agent_work",
                "cancel_call_work",
                "ask_user",
            ],
            required_json_shape: r#"{"tool":"speak_to_user|dispatch_agent_work|cancel_call_work|ask_user","say":"spoken response","confidence":"high|medium|low","target_agent_handle":"handle for dispatch_agent_work","target_work_item_id":"uuid for cancel_call_work","target_request_number":1,"request_transcript":"optional worker brief text chosen by the dispatcher","speech_topic":"required for dispatch_agent_work, <=10 Chinese characters or <=4 short English words","error":"optional diagnostic"}"#,
        },
    };
    let request_json = serde_json::to_vec(&request).map_err(to_string)?;
    let stdout = match env_call_coordinator_command() {
        Some(command_line) => {
            match run_call_coordinator_command(
                &command_line,
                &request_json,
                CALL_COORDINATOR_TIMEOUT,
            )
            .await
            {
                Ok(stdout) => stdout,
                Err(err) => return Err(format!("Call Mode coordinator command failed: {err}")),
            }
        }
        None => {
            match run_call_coordinator_app_server(pool, &request_json, CALL_COORDINATOR_TIMEOUT)
                .await
            {
                Ok(stdout) => stdout,
                Err(err) => return Err(format!("Call Mode coordinator app-server failed: {err}")),
            }
        }
    };
    let voice_language = CallVoiceLanguage::from_hint(Some(&utterance.language));
    match parse_call_coordinator_decision_response(
        pool,
        session,
        &available_agents,
        voice_language,
        &stdout,
    )
    .await
    {
        Ok(decision) => Ok(decision),
        Err(err) => Err(format!(
            "Call Mode coordinator command returned an invalid decision: {err}"
        )),
    }
}

fn env_call_coordinator_command() -> Option<String> {
    env::var(CALL_COORDINATOR_COMMAND_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

async fn load_call_coordinator_agents(
    pool: &SqlitePool,
    channel_id: Option<Uuid>,
) -> CommandResult<Vec<CallCoordinatorAgentContext>> {
    let use_channel_members = if let Some(channel_id) = channel_id {
        !is_call_system_channel(pool, channel_id).await?
    } else {
        false
    };
    let rows = if let (Some(channel_id), true) = (channel_id, use_channel_members) {
        sqlx::query(
            r#"
        select a.id, a.handle, coalesce(a.display_name, '') as display_name, a.status
        from channel_members cm
        join agents a on a.id = cm.agent_id
        where cm.channel_id = $1
          and a.status <> 'error'
        order by
          case when lower(a.status) = 'idle' then 0 else 1 end,
          lower(a.handle)
        "#,
        )
        .bind(channel_id)
        .fetch_all(pool)
        .await
        .map_err(to_string)?
    } else {
        sqlx::query(
            r#"
            select id, handle, coalesce(display_name, '') as display_name, status
            from agents
            where status <> 'error'
            order by
              case when lower(status) = 'idle' then 0 else 1 end,
              lower(handle)
            "#,
        )
        .fetch_all(pool)
        .await
        .map_err(to_string)?
    };

    Ok(rows
        .into_iter()
        .map(|row| CallCoordinatorAgentContext {
            id: row.get("id"),
            handle: row.get("handle"),
            display_name: row.get("display_name"),
            status: row.get("status"),
        })
        .collect())
}

async fn is_call_system_channel(pool: &SqlitePool, channel_id: Uuid) -> CommandResult<bool> {
    let name: Option<String> = sqlx::query_scalar("select name from channels where id = $1")
        .bind(channel_id)
        .fetch_optional(pool)
        .await
        .map_err(to_string)?;
    Ok(name.as_deref() == Some(CALL_SYSTEM_CHANNEL_NAME))
}

async fn load_call_coordinator_active_work_context(
    pool: &SqlitePool,
    session_id: Uuid,
) -> CommandResult<Vec<CallCoordinatorActiveWorkContext>> {
    let rows = sqlx::query(
        r#"
        select
            w.id as work_item_id,
            u.sequence as request_number,
            a.handle as agent_handle,
            w.status,
            u.transcript as request_transcript
        from agent_work_items w
        join call_utterances u on u.id = w.call_utterance_id
        join agents a on a.id = w.agent_id
        where w.call_session_id = $1
          and w.status in ('queued', 'running', 'cancelling')
        order by u.sequence asc, w.created_at asc
        limit 12
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    Ok(rows
        .into_iter()
        .map(|row| CallCoordinatorActiveWorkContext {
            work_item_id: row.get("work_item_id"),
            request_number: row.get("request_number"),
            agent_handle: row.get("agent_handle"),
            status: row.get("status"),
            request_transcript: row.get("request_transcript"),
        })
        .collect())
}

async fn load_call_coordinator_pending_confirmation_context(
    pool: &SqlitePool,
    session_id: Uuid,
    before_sequence: i64,
) -> CommandResult<Vec<CallCoordinatorPendingConfirmationContext>> {
    let rows = sqlx::query(
        r#"
        select
            d.id as dispatch_id,
            u.id as utterance_id,
            u.sequence as request_number,
            a.handle as target_agent_handle,
            u.transcript as request_transcript
        from call_dispatches d
        join call_utterances u on u.id = d.utterance_id
        join agents a on a.id = d.target_agent_id
        where d.session_id = $1
          and u.sequence < $2
          and d.ack_status = 'needs_confirmation'
          and d.status = 'needs_user'
          and d.work_item_id is null
        order by u.sequence desc, d.created_at desc
        limit 5
        "#,
    )
    .bind(session_id)
    .bind(before_sequence)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    Ok(rows
        .into_iter()
        .map(|row| CallCoordinatorPendingConfirmationContext {
            dispatch_id: row.get("dispatch_id"),
            utterance_id: row.get("utterance_id"),
            request_number: row.get("request_number"),
            target_agent_handle: row.get("target_agent_handle"),
            request_transcript: row.get("request_transcript"),
        })
        .collect())
}

async fn load_call_coordinator_turn_context(
    pool: &SqlitePool,
    session_id: Uuid,
    before_sequence: i64,
) -> CommandResult<Vec<CallCoordinatorTurnContext>> {
    let rows = sqlx::query(
        r#"
        select
            u.sequence,
            u.transcript,
            u.created_at,
            d.intent as dispatch_intent,
            d.ack_status as dispatch_ack_status,
            d.ack_text as dispatch_ack_text,
            d.status as dispatch_status,
            a.handle as dispatch_target_agent_handle
        from call_utterances u
        left join call_dispatches d on d.utterance_id = u.id
        left join agents a on a.id = d.target_agent_id
        where u.session_id = $1
          and u.sequence < $2
        order by u.sequence desc
        limit $3
        "#,
    )
    .bind(session_id)
    .bind(before_sequence)
    .bind(CALL_COORDINATOR_TRANSCRIPT_CONTEXT_LIMIT as i64)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    let mut turns = rows
        .into_iter()
        .map(|row| CallCoordinatorTurnContext {
            sequence: row.get("sequence"),
            transcript: row.get("transcript"),
            dispatch_intent: row.get("dispatch_intent"),
            dispatch_ack_status: row.get("dispatch_ack_status"),
            dispatch_ack_text: row.get("dispatch_ack_text"),
            dispatch_target_agent_handle: row.get("dispatch_target_agent_handle"),
            dispatch_status: row.get("dispatch_status"),
            created_at: row.get("created_at"),
        })
        .collect::<Vec<_>>();
    turns.reverse();
    Ok(turns)
}

async fn load_call_coordinator_voice_thread_turn_context(
    pool: &SqlitePool,
    session_id: Uuid,
    thread_root_utterance_id: Uuid,
    before_sequence: i64,
) -> CommandResult<Vec<CallCoordinatorTurnContext>> {
    let rows = sqlx::query(
        r#"
        select
            u.sequence,
            u.transcript,
            u.created_at,
            d.intent as dispatch_intent,
            d.ack_status as dispatch_ack_status,
            d.ack_text as dispatch_ack_text,
            d.status as dispatch_status,
            a.handle as dispatch_target_agent_handle
        from call_utterances u
        left join call_dispatches d on d.utterance_id = u.id
        left join agents a on a.id = d.target_agent_id
        where u.session_id = $1
          and u.sequence < $3
          and (u.id = $2 or u.thread_root_utterance_id = $2)
        order by u.sequence desc
        limit $4
        "#,
    )
    .bind(session_id)
    .bind(thread_root_utterance_id)
    .bind(before_sequence)
    .bind(CALL_COORDINATOR_TRANSCRIPT_CONTEXT_LIMIT as i64)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    let mut turns = rows
        .into_iter()
        .map(|row| CallCoordinatorTurnContext {
            sequence: row.get("sequence"),
            transcript: row.get("transcript"),
            dispatch_intent: row.get("dispatch_intent"),
            dispatch_ack_status: row.get("dispatch_ack_status"),
            dispatch_ack_text: row.get("dispatch_ack_text"),
            dispatch_target_agent_handle: row.get("dispatch_target_agent_handle"),
            dispatch_status: row.get("dispatch_status"),
            created_at: row.get("created_at"),
        })
        .collect::<Vec<_>>();
    turns.reverse();
    Ok(turns)
}

async fn load_call_coordinator_message_context(
    pool: &SqlitePool,
    channel_id: Option<Uuid>,
    thread_root_id: Option<Uuid>,
) -> CommandResult<Vec<CallCoordinatorMessageContext>> {
    let Some(channel_id) = channel_id else {
        return Ok(Vec::new());
    };
    let rows = sqlx::query(
        r#"
        select sender_name, sender_role, body, created_at
        from messages
        where channel_id = $1
          and (($2 is null and thread_root_id is null) or thread_root_id = $2)
          and trim(body) <> ''
        order by created_at desc
        limit $3
        "#,
    )
    .bind(channel_id)
    .bind(thread_root_id)
    .bind(CALL_COORDINATOR_MESSAGE_CONTEXT_LIMIT as i64)
    .fetch_all(pool)
    .await
    .map_err(to_string)?;

    let mut messages = rows
        .into_iter()
        .map(|row| CallCoordinatorMessageContext {
            sender_name: row.get("sender_name"),
            sender_role: row.get("sender_role"),
            body: row.get("body"),
            created_at: row.get("created_at"),
        })
        .collect::<Vec<_>>();
    messages.reverse();
    Ok(messages)
}

async fn parse_call_coordinator_decision_response(
    pool: &SqlitePool,
    session: &CallSession,
    available_agents: &[CallCoordinatorAgentContext],
    voice_language: CallVoiceLanguage,
    stdout: &str,
) -> CommandResult<CallCoordinatorDecision> {
    let value: Value = serde_json::from_str(stdout.trim()).map_err(to_string)?;
    let response: CallCoordinatorDecisionResponse =
        serde_json::from_value(value).map_err(to_string)?;
    let ack_text = normalize_call_coordinator_ack_text(response.say);
    let confidence = normalize_call_coordinator_confidence(response.confidence);
    match response.tool.trim().to_ascii_lowercase().as_str() {
        "speak_to_user" => Ok(CallCoordinatorDecision::AnswerDirectly {
            ack_text: ack_text.unwrap_or_else(|| voice_language.heard().to_owned()),
        }),
        "dispatch_agent_work" => {
            let target = resolve_call_coordinator_response_target(
                pool,
                session.channel_id,
                available_agents,
                response.target_agent_id,
                response.target_agent_handle.as_deref(),
            )
            .await?;
            let Some(target) = target else {
                return Ok(CallCoordinatorDecision::Clarify {
                    ack_text: ack_text
                        .unwrap_or_else(|| voice_language.unavailable_target().to_owned()),
                    error: "coordinator decision target was unavailable".to_owned(),
                    confidence: "high".to_owned(),
                    ack_status: "needs_target".to_owned(),
                    target: None,
                });
            };
            if confidence == "low" {
                return Ok(CallCoordinatorDecision::Clarify {
                    ack_text: ack_text
                        .unwrap_or_else(|| voice_language.low_confidence_dispatch().to_owned()),
                    error:
                        "coordinator returned low-confidence dispatch; waiting for user correction"
                            .to_owned(),
                    confidence,
                    ack_status: "needs_confirmation".to_owned(),
                    target: Some(target),
                });
            }
            Ok(CallCoordinatorDecision::Dispatch {
                ack_text: ack_text
                    .unwrap_or_else(|| voice_language.assigned_to(&target.agent_handle)),
                speech_topic: normalize_call_speech_topic(
                    response.speech_topic.as_deref().unwrap_or(""),
                ),
                target,
                confidence,
                request_transcript: response
                    .request_transcript
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty()),
            })
        }
        "cancel_call_work" => Ok(CallCoordinatorDecision::CancelWork {
            work_item_id: response.target_work_item_id,
            request_number: response.target_request_number,
            ack_text: ack_text.unwrap_or_else(|| voice_language.cancel_request().to_owned()),
            confidence,
        }),
        "ask_user" => Ok(CallCoordinatorDecision::Clarify {
            ack_text: ack_text.unwrap_or_else(|| voice_language.need_more_detail().to_owned()),
            error: response
                .error
                .unwrap_or_else(|| "coordinator requested clarification".to_owned()),
            confidence,
            ack_status: "needs_target".to_owned(),
            target: None,
        }),
        other => Err(format!("unsupported coordinator tool: {other}")),
    }
}

async fn resolve_call_coordinator_response_target(
    pool: &SqlitePool,
    channel_id: Option<Uuid>,
    available_agents: &[CallCoordinatorAgentContext],
    target_agent_id: Option<Uuid>,
    target_agent_handle: Option<&str>,
) -> CommandResult<Option<CallDispatchTarget>> {
    if let Some(target_agent_id) = target_agent_id {
        if let Some(agent) = available_agents
            .iter()
            .find(|agent| agent.id == target_agent_id)
            .cloned()
        {
            let agent_display_name = agent_display_name(&agent.display_name, &agent.handle);
            return Ok(Some(CallDispatchTarget {
                agent_id: agent.id,
                agent_handle: agent.handle,
                agent_display_name,
            }));
        }
    }

    if let Some(handle) = target_agent_handle {
        let handle = handle.trim().trim_start_matches('@');
        if handle.is_empty() {
            return Ok(None);
        }
        if let Some(agent) = available_agents
            .iter()
            .find(|agent| agent.handle.eq_ignore_ascii_case(handle))
            .cloned()
        {
            let agent_display_name = agent_display_name(&agent.display_name, &agent.handle);
            return Ok(Some(CallDispatchTarget {
                agent_id: agent.id,
                agent_handle: agent.handle,
                agent_display_name,
            }));
        }
        return resolve_explicit_call_target(pool, channel_id, handle).await;
    }

    Ok(None)
}

fn normalize_call_coordinator_ack_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.chars().take(500).collect())
    })
}

fn normalize_call_coordinator_confidence(value: Option<String>) -> String {
    match value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("high") => "high".to_owned(),
        Some("medium") => "medium".to_owned(),
        Some("low") => "low".to_owned(),
        _ => "medium".to_owned(),
    }
}

fn normalize_call_speech_topic(value: &str) -> String {
    let normalized = value
        .replace(['\r', '\n', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let normalized = normalized
        .trim_matches(|ch: char| {
            ch.is_ascii_punctuation() || "，。！？、；：“”‘’（）()【】[]".contains(ch)
        })
        .trim();
    if normalized.is_empty() {
        return String::new();
    }
    let has_cjk = normalized
        .chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch));
    if has_cjk {
        normalized.chars().take(10).collect()
    } else {
        normalized
            .split_whitespace()
            .take(4)
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(40)
            .collect()
    }
}

fn call_coordinator_model_value() -> String {
    env::var(CALL_COORDINATOR_MODEL_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CALL_COORDINATOR_MODEL.to_owned())
}

fn call_coordinator_reasoning_effort() -> String {
    env::var(CALL_COORDINATOR_REASONING_EFFORT_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CALL_COORDINATOR_REASONING_EFFORT.to_owned())
}

fn call_coordinator_cwd() -> String {
    env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_owned())
}

fn call_coordinator_app_server_slot() -> &'static AsyncMutex<Option<CallCoordinatorAppServer>> {
    CALL_COORDINATOR_APP_SERVER.get_or_init(|| AsyncMutex::new(None))
}

async fn run_call_coordinator_app_server(
    pool: &SqlitePool,
    input: &[u8],
    timeout_duration: Duration,
) -> CommandResult<String> {
    let slot = call_coordinator_app_server_slot();
    let mut runtime = slot.lock().await;
    let mut last_error = None;

    for _ in 0..2 {
        if runtime.is_none() {
            *runtime = Some(
                timeout(timeout_duration, spawn_call_coordinator_app_server(pool))
                    .await
                    .map_err(|_| "coordinator app-server timed out during startup".to_owned())??,
            );
        }

        let Some(server) = runtime.as_mut() else {
            return Err("coordinator app-server was not initialized".to_owned());
        };
        match timeout(timeout_duration, server.run_turn(input)).await {
            Ok(Ok(output)) => return Ok(output),
            Ok(Err(err)) => {
                last_error = Some(err);
                if let Some(mut stale) = runtime.take() {
                    let _ = stop_call_coordinator_app_server(&mut stale).await;
                }
            }
            Err(_) => {
                last_error = Some("coordinator app-server timed out".to_owned());
                if let Some(mut stale) = runtime.take() {
                    let _ = stop_call_coordinator_app_server(&mut stale).await;
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "coordinator app-server failed".to_owned()))
}

async fn spawn_call_coordinator_app_server(
    pool: &SqlitePool,
) -> CommandResult<CallCoordinatorAppServer> {
    let model_reasoning_effort = serde_json::to_string(&call_coordinator_reasoning_effort())
        .map_err(to_string)
        .map(|value| format!("model_reasoning_effort={value}"))?;
    let mut command = Command::new("codex");
    command.args([
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "notify=[]",
        "-c",
        &model_reasoning_effort,
    ]);
    #[cfg(unix)]
    command.process_group(0);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to start coordinator app-server: {err}"))?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill().await;
        return Err("coordinator app-server stdin unavailable".to_owned());
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return Err("coordinator app-server stdout unavailable".to_owned());
    };
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(discard_call_coordinator_stderr(stderr));
    }

    let mut stdout = BufReader::new(stdout);
    let initialize_id = 1_i64;
    write_call_coordinator_json(
        &mut stdin,
        json!({
            "method": "initialize",
            "id": initialize_id,
            "params": {
                "clientInfo": {
                    "name": "lantor-call-coordinator",
                    "title": "Lantor Call Coordinator",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true
                }
            }
        }),
    )
    .await?;
    write_call_coordinator_json(&mut stdin, json!({ "method": "initialized" })).await?;
    read_call_coordinator_response(&mut stdout, initialize_id)
        .await
        .and_then(|value| match call_coordinator_request_error(&value) {
            Some(error) => Err(format!("coordinator app-server initialize failed: {error}")),
            None => Ok(value),
        })?;

    let mut next_request_id = initialize_id + 1;
    let thread_id =
        open_call_coordinator_thread(pool, &mut stdin, &mut stdout, &mut next_request_id).await?;

    Ok(CallCoordinatorAppServer {
        child,
        stdin,
        stdout,
        thread_id,
        next_request_id,
    })
}

async fn load_call_coordinator_thread_id(pool: &SqlitePool) -> CommandResult<Option<String>> {
    let thread_id: Option<String> = sqlx::query_scalar(
        r#"
        select provider_thread_id
        from provider_runtime_sessions
        where runtime = $1
        "#,
    )
    .bind(CALL_COORDINATOR_RUNTIME_KEY)
    .fetch_optional(pool)
    .await
    .map_err(to_string)?;
    Ok(thread_id.filter(|thread_id| !thread_id.trim().is_empty()))
}

async fn upsert_call_coordinator_thread_id(
    pool: &SqlitePool,
    provider_thread_id: &str,
    status: &str,
) -> CommandResult<()> {
    sqlx::query(
        r#"
        insert into provider_runtime_sessions (runtime, provider_thread_id, status)
        values ($1, $2, $3)
        on conflict (runtime) do update set
            provider_thread_id = excluded.provider_thread_id,
            status = excluded.status,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        "#,
    )
    .bind(CALL_COORDINATOR_RUNTIME_KEY)
    .bind(provider_thread_id)
    .bind(status)
    .execute(pool)
    .await
    .map_err(to_string)?;
    Ok(())
}

async fn stop_call_coordinator_app_server(
    server: &mut CallCoordinatorAppServer,
) -> CommandResult<()> {
    if let Some(pid) = server.child.id().map(|id| id as i32) {
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(format!("-{pid}"))
                .status()
                .await;
        }
    }
    let _ = server.child.kill().await;
    let _ = server.child.wait().await;
    Ok(())
}

async fn discard_call_coordinator_stderr<R>(stream: R)
where
    R: AsyncRead + Send + Unpin + 'static,
{
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(_line)) = lines.next_line().await {}
}

impl CallCoordinatorAppServer {
    async fn run_turn(&mut self, input: &[u8]) -> CommandResult<String> {
        let request_json = String::from_utf8(input.to_vec())
            .map_err(|_| "coordinator request was not valid UTF-8".to_owned())?;
        let thread_id = self.thread_id.clone();
        self.start_turn(&thread_id, &request_json).await
    }

    async fn start_turn(&mut self, thread_id: &str, request_json: &str) -> CommandResult<String> {
        let request_id = self.next_request_id;
        self.next_request_id += 1;
        let prompt = format!(
            "Read the Lantor Call Mode coordinator request JSON below. Decide one bounded action using the request's system_prompt and output_contract. Return only the raw JSON decision object, with no Markdown or commentary.\n\nCoordinator request JSON:\n{request_json}"
        );
        let mut params = json!({
            "threadId": thread_id,
            "input": [{
                "type": "text",
                "text": prompt,
                "text_elements": []
            }],
            "cwd": call_coordinator_cwd(),
            "approvalPolicy": "never",
            "model": call_coordinator_model_value()
        });
        apply_call_coordinator_runtime_options(&mut params, &call_coordinator_reasoning_effort());
        write_call_coordinator_json(
            &mut self.stdin,
            json!({
                "method": "turn/start",
                "id": request_id,
                "params": params
            }),
        )
        .await?;

        let mut output = String::new();
        loop {
            let value = read_call_coordinator_line(&mut self.stdout).await?;
            if value.get("id").and_then(Value::as_i64) == Some(request_id) {
                if let Some(error) = call_coordinator_request_error(&value) {
                    return Err(format!("coordinator app-server turn/start failed: {error}"));
                }
                continue;
            }
            match value.get("method").and_then(Value::as_str) {
                Some("item/agentMessage/delta") => {
                    if call_coordinator_event_matches_thread(&value, thread_id) {
                        if let Some(delta) = value.pointer("/params/delta").and_then(Value::as_str)
                        {
                            output.push_str(delta);
                        }
                    }
                }
                Some("item/completed") => {
                    if call_coordinator_event_matches_thread(&value, thread_id)
                        && value.pointer("/params/item/type").and_then(Value::as_str)
                            == Some("agentMessage")
                    {
                        if let Some(text) =
                            value.pointer("/params/item/text").and_then(Value::as_str)
                        {
                            output = text.to_owned();
                        }
                    }
                }
                Some("turn/completed") => {
                    if call_coordinator_event_matches_thread(&value, thread_id) {
                        let output = output.trim().to_owned();
                        if output.is_empty() {
                            return Err("coordinator app-server returned empty output".to_owned());
                        }
                        return Ok(output);
                    }
                }
                Some("error") => {
                    if value.pointer("/params/willRetry").and_then(Value::as_bool) != Some(true) {
                        return Err(value
                            .pointer("/params/error/message")
                            .or_else(|| value.pointer("/params/message"))
                            .and_then(Value::as_str)
                            .unwrap_or("coordinator app-server emitted error")
                            .to_owned());
                    }
                }
                _ => {}
            }
        }
    }
}

async fn start_call_coordinator_thread(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    next_request_id: &mut i64,
) -> CommandResult<String> {
    let request_id = *next_request_id;
    *next_request_id += 1;
    let mut params = json!({
        "model": call_coordinator_model_value(),
        "cwd": call_coordinator_cwd(),
        "approvalPolicy": "never",
        "sandbox": "danger-full-access",
        "developerInstructions": CALL_COORDINATOR_SYSTEM_PROMPT,
        "experimentalRawEvents": false,
        "persistExtendedHistory": true
    });
    apply_call_coordinator_runtime_options(&mut params, &call_coordinator_reasoning_effort());
    write_call_coordinator_json(
        stdin,
        json!({
            "method": "thread/start",
            "id": request_id,
            "params": params
        }),
    )
    .await?;
    let value = read_call_coordinator_response(stdout, request_id).await?;
    if let Some(error) = call_coordinator_request_error(&value) {
        return Err(format!(
            "coordinator app-server thread/start failed: {error}"
        ));
    }
    value
        .pointer("/result/thread/id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "coordinator app-server thread/start missing thread id".to_owned())
}

async fn resume_call_coordinator_thread(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    next_request_id: &mut i64,
    thread_id: &str,
) -> CommandResult<String> {
    let request_id = *next_request_id;
    *next_request_id += 1;
    let mut params = json!({
        "threadId": thread_id,
        "model": call_coordinator_model_value(),
        "cwd": call_coordinator_cwd(),
        "approvalPolicy": "never",
        "sandbox": "danger-full-access",
        "developerInstructions": CALL_COORDINATOR_SYSTEM_PROMPT,
        "persistExtendedHistory": true
    });
    apply_call_coordinator_runtime_options(&mut params, &call_coordinator_reasoning_effort());
    write_call_coordinator_json(
        stdin,
        json!({
            "method": "thread/resume",
            "id": request_id,
            "params": params
        }),
    )
    .await?;
    let value = read_call_coordinator_response(stdout, request_id).await?;
    if let Some(error) = call_coordinator_request_error(&value) {
        return Err(format!(
            "coordinator app-server thread/resume failed: {error}"
        ));
    }
    value
        .pointer("/result/thread/id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "coordinator app-server thread/resume missing thread id".to_owned())
}

async fn open_call_coordinator_thread(
    pool: &SqlitePool,
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    next_request_id: &mut i64,
) -> CommandResult<String> {
    if let Some(thread_id) = load_call_coordinator_thread_id(pool).await? {
        if let Ok(resumed_thread_id) =
            resume_call_coordinator_thread(stdin, stdout, next_request_id, &thread_id).await
        {
            upsert_call_coordinator_thread_id(pool, &resumed_thread_id, "idle").await?;
            return Ok(resumed_thread_id);
        }
    }

    let thread_id = start_call_coordinator_thread(stdin, stdout, next_request_id).await?;
    upsert_call_coordinator_thread_id(pool, &thread_id, "idle").await?;
    Ok(thread_id)
}

fn call_coordinator_event_matches_thread(value: &Value, thread_id: &str) -> bool {
    value
        .pointer("/params/threadId")
        .and_then(Value::as_str)
        .map(|value| value == thread_id)
        .unwrap_or(true)
}

fn apply_call_coordinator_runtime_options(params: &mut Value, reasoning_effort: &str) {
    if let Some(object) = params.as_object_mut() {
        object.insert("reasoningEffort".to_owned(), json!(reasoning_effort.trim()));
    }
}

async fn write_call_coordinator_json(stdin: &mut ChildStdin, value: Value) -> CommandResult<()> {
    let mut line = serde_json::to_vec(&value).map_err(to_string)?;
    line.push(b'\n');
    stdin.write_all(&line).await.map_err(to_string)?;
    stdin.flush().await.map_err(to_string)
}

async fn read_call_coordinator_response(
    stdout: &mut BufReader<ChildStdout>,
    request_id: i64,
) -> CommandResult<Value> {
    loop {
        let value = read_call_coordinator_line(stdout).await?;
        if value.get("id").and_then(Value::as_i64) == Some(request_id) {
            return Ok(value);
        }
    }
}

async fn read_call_coordinator_line(stdout: &mut BufReader<ChildStdout>) -> CommandResult<Value> {
    let mut line = String::new();
    let bytes = stdout.read_line(&mut line).await.map_err(to_string)?;
    if bytes == 0 {
        return Err("coordinator app-server closed stdout".to_owned());
    }
    serde_json::from_str(line.trim_end_matches(['\r', '\n'])).map_err(to_string)
}

fn call_coordinator_request_error(value: &Value) -> Option<String> {
    value.get("error").map(|error| {
        error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| error.to_string())
    })
}

async fn run_call_coordinator_command(
    command_line: &str,
    input: &[u8],
    timeout_duration: Duration,
) -> CommandResult<String> {
    let mut command = call_coordinator_shell_command(command_line);
    command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to start coordinator command: {err}"))?;

    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill().await;
        return Err("failed to open coordinator command stdin".to_owned());
    };
    match timeout(timeout_duration, stdin.write_all(input)).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let _ = child.kill().await;
            return Err(format!("failed to write coordinator request: {err}"));
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err("coordinator command timed out while reading request".to_owned());
        }
    }
    drop(stdin);

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return Err("failed to open coordinator command stdout".to_owned());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill().await;
        return Err("failed to open coordinator command stderr".to_owned());
    };
    let stdout_task = read_call_coordinator_pipe_to_end(stdout);
    let stderr_task = read_call_coordinator_pipe_to_end(stderr);
    let status = match timeout(timeout_duration, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(err)) => {
            let _ = child.kill().await;
            return Err(format!("failed to wait for coordinator command: {err}"));
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_task.abort();
            stderr_task.abort();
            return Err("coordinator command timed out".to_owned());
        }
    };

    let stdout = collect_call_coordinator_pipe(stdout_task, "stdout").await?;
    let stderr = collect_call_coordinator_pipe(stderr_task, "stderr").await?;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            format!("coordinator command exited with status {status}")
        } else {
            detail
        });
    }
    String::from_utf8(stdout).map_err(|_| "coordinator stdout was not valid UTF-8".to_owned())
}

fn read_call_coordinator_pipe_to_end<R>(mut pipe: R) -> JoinHandle<std::io::Result<Vec<u8>>>
where
    R: AsyncRead + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut output = Vec::new();
        pipe.read_to_end(&mut output).await?;
        Ok(output)
    })
}

async fn collect_call_coordinator_pipe(
    task: JoinHandle<std::io::Result<Vec<u8>>>,
    label: &str,
) -> CommandResult<Vec<u8>> {
    task.await
        .map_err(|err| format!("coordinator command {label} reader failed: {err}"))?
        .map_err(|err| format!("coordinator command {label} read failed: {err}"))
}

#[cfg(not(target_os = "windows"))]
fn call_coordinator_shell_command(command_line: &str) -> Command {
    let mut command = Command::new("sh");
    command.arg("-c").arg(command_line);
    command
}

#[cfg(target_os = "windows")]
fn call_coordinator_shell_command(command_line: &str) -> Command {
    let mut command = Command::new("cmd");
    command.arg("/C").arg(command_line);
    command
}

async fn resolve_explicit_call_target(
    pool: &SqlitePool,
    channel_id: Option<Uuid>,
    handle: &str,
) -> CommandResult<Option<CallDispatchTarget>> {
    let row = if let Some(channel_id) = channel_id {
        sqlx::query(
            r#"
            select a.id, a.handle, coalesce(a.display_name, '') as display_name, a.status
            from channel_members cm
            join agents a on a.id = cm.agent_id
            where cm.channel_id = $1
              and lower(a.handle) = lower($2)
              and a.status <> 'error'
            limit 1
            "#,
        )
        .bind(channel_id)
        .bind(handle)
        .fetch_optional(pool)
        .await
        .map_err(to_string)?
    } else {
        sqlx::query(
            r#"
            select id, handle, coalesce(display_name, '') as display_name, status
            from agents
            where lower(handle) = lower($1)
              and status <> 'error'
            limit 1
            "#,
        )
        .bind(handle)
        .fetch_optional(pool)
        .await
        .map_err(to_string)?
    };
    row.map(call_target_from_agent_row).transpose()
}

fn cancelable_work_handle_list(works: &[CallCancelableWork]) -> String {
    let handles = works
        .iter()
        .map(|work| format!("request number {}", work.request_number))
        .collect::<Vec<_>>();
    match handles.as_slice() {
        [] => "more than one request".to_owned(),
        [only] => only.clone(),
        [first, second] => format!("{first} and {second}"),
        _ => {
            let (last, rest) = handles.split_last().expect("non-empty handles");
            format!("{}, and {last}", rest.join(", "))
        }
    }
}

async fn ensure_call_utterance_owner_message(
    pool: &SqlitePool,
    utterance: &CallUtterance,
) -> CommandResult<CallUtterance> {
    if utterance.source_message_id.is_some() || utterance.transcript.trim().is_empty() {
        return Ok(utterance.clone());
    }
    let session = load_call_session(pool, utterance.session_id).await?;
    let Some(channel_id) = session.channel_id else {
        return Ok(utterance.clone());
    };
    let thread_root_id = if let Some(thread_root_utterance_id) = utterance.thread_root_utterance_id
    {
        sqlx::query_scalar("select source_message_id from call_utterances where id = $1")
            .bind(thread_root_utterance_id)
            .fetch_optional(pool)
            .await
            .map_err(to_string)?
            .flatten()
    } else {
        session.thread_root_id
    };
    let message_id: Uuid = sqlx::query_scalar(
        r#"
        insert into messages (channel_id, thread_root_id, sender_name, sender_role, body, is_task)
        values ($1, $2, $3, 'owner', $4, false)
        returning id
        "#,
    )
    .bind(channel_id)
    .bind(thread_root_id)
    .bind("You")
    .bind(utterance.transcript.trim())
    .fetch_one(pool)
    .await
    .map_err(to_string)?;
    sqlx::query(
        r#"
        update call_utterances
        set source_message_id = $2,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(utterance.id)
    .bind(message_id)
    .execute(pool)
    .await
    .map_err(to_string)?;
    bump_call_message_thread_version(pool, channel_id, thread_root_id).await?;
    let message = load_call_coordinator_message(pool, message_id).await?;
    notify_ui_message_upsert(pool, &message, "call_utterance_message").await?;
    load_call_utterance(pool, utterance.id).await
}

async fn insert_call_coordinator_message(
    pool: &SqlitePool,
    session: &CallSession,
    utterance_id: Uuid,
    body: &str,
) -> CommandResult<()> {
    let Some(channel_id) = session.channel_id else {
        return Ok(());
    };
    let body = body.trim();
    if body.is_empty() {
        return Ok(());
    }

    let thread_root_id =
        sqlx::query_scalar("select source_message_id from call_utterances where id = $1")
            .bind(utterance_id)
            .fetch_optional(pool)
            .await
            .map_err(to_string)?
            .flatten()
            .or(session.thread_root_id);

    let message_id: Uuid = sqlx::query_scalar(
        r#"
        insert into messages (channel_id, thread_root_id, sender_name, sender_role, body, is_task)
        values ($1, $2, 'System Agent', 'system', $3, false)
        returning id
        "#,
    )
    .bind(channel_id)
    .bind(thread_root_id)
    .bind(body)
    .fetch_one(pool)
    .await
    .map_err(to_string)?;

    bump_call_message_thread_version(pool, channel_id, thread_root_id).await?;
    let message = load_call_coordinator_message(pool, message_id).await?;
    notify_ui_message_upsert(pool, &message, "call_coordinator_reply").await?;
    Ok(())
}

async fn bump_call_message_thread_version(
    pool: &SqlitePool,
    channel_id: Uuid,
    thread_root_id: Option<Uuid>,
) -> CommandResult<()> {
    match bump_thread_version(pool, channel_id, thread_root_id).await {
        Ok(()) => Ok(()),
        Err(err) if err.contains("no such table: thread_versions") => Ok(()),
        Err(err) => Err(err),
    }
}

async fn load_call_coordinator_message(
    pool: &SqlitePool,
    message_id: Uuid,
) -> CommandResult<Message> {
    let row = sqlx::query(
        r#"
        select
            m.id,
            m.channel_id,
            m.thread_root_id,
            m.sender_agent_id,
            m.sender_name,
            m.sender_role,
            m.body,
            m.is_task,
            m.thread_followed,
            m.delivery_state,
            m.stream_key,
            t.number as task_number,
            t.status as task_status,
            m.created_at,
            m.updated_at
        from messages m
        left join tasks t on t.message_id = m.id
        where m.id = $1
        "#,
    )
    .bind(message_id)
    .fetch_one(pool)
    .await
    .map_err(to_string)?;

    Ok(Message {
        id: row.get("id"),
        channel_id: row.get("channel_id"),
        thread_root_id: row.get("thread_root_id"),
        sender_agent_id: row.get("sender_agent_id"),
        sender_name: row.get("sender_name"),
        sender_role: row.get("sender_role"),
        body: row.get("body"),
        is_task: row.get("is_task"),
        thread_followed: row.get("thread_followed"),
        delivery_state: row.get("delivery_state"),
        stream_key: row.get("stream_key"),
        task_number: row.get("task_number"),
        task_status: row.get("task_status"),
        attachments: Vec::new(),
        artifacts: Vec::new(),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn should_ignore_low_value_final_fragment(transcript: &str, reason: Option<&str>) -> bool {
    if reason.and_then(normalize_final_fragment_reason).is_none() {
        return false;
    }

    let tokens = low_value_fragment_tokens(transcript);
    if tokens.is_empty() {
        return true;
    }

    let token_chars: usize = tokens.iter().map(|token| token.chars().count()).sum();
    token_chars <= 8 || (tokens.len() == 1 && token_chars <= 14)
}

fn low_value_fragment_tokens(value: &str) -> Vec<String> {
    value
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_owned())
        .collect()
}

fn normalize_final_fragment_reason(reason: &str) -> Option<&'static str> {
    match reason.trim() {
        "mute" => Some("mute"),
        "end_call" => Some("end_call"),
        _ => None,
    }
}

fn call_target_from_agent_row(row: sqlx::sqlite::SqliteRow) -> CommandResult<CallDispatchTarget> {
    let handle: String = row.get("handle");
    let display_name: String = row.get("display_name");
    let status: String = row.get("status");
    if status.eq_ignore_ascii_case("error") {
        return Err(format!(
            "agent @{handle} is in error state and cannot accept new work"
        ));
    }
    let agent_display_name = agent_display_name(&display_name, &handle);
    Ok(CallDispatchTarget {
        agent_id: row.get("id"),
        agent_handle: handle,
        agent_display_name,
    })
}

fn agent_display_name(display_name: &str, handle: &str) -> String {
    let display_name = display_name.trim();
    if display_name.is_empty() {
        handle.trim_start_matches('@').to_owned()
    } else {
        display_name.to_owned()
    }
}

fn call_work_title(transcript: &str) -> String {
    transcript
        .lines()
        .next()
        .map(|line| line.chars().take(120).collect::<String>())
        .filter(|line| !line.trim().is_empty())
        .unwrap_or_else(|| "Call Mode request".to_owned())
}

#[derive(Serialize)]
struct CallSpokenRequestPayload {
    schema: &'static str,
    encoding: &'static str,
    inline_budget_chars: usize,
    original_char_length: usize,
    original_byte_length: usize,
    original_sha256: String,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    retrieval_ref: Option<CallSpokenRequestRetrievalRef>,
    included_source_char_budget: usize,
    included_text_char_length: usize,
    text: String,
}

#[derive(Clone, Serialize)]
struct CallSpokenRequestRetrievalRef {
    source: &'static str,
    call_session_id: Uuid,
    call_utterance_id: Uuid,
    call_dispatch_id: Uuid,
    turn_handle: String,
    context_tool_command: String,
}

impl CallSpokenRequestRetrievalRef {
    fn new(session: &CallSession, utterance: &CallUtterance, dispatch: &CallDispatch) -> Self {
        Self {
            source: "call_utterances.transcript",
            call_session_id: session.id,
            call_utterance_id: utterance.id,
            call_dispatch_id: dispatch.id,
            turn_handle: format!("call-turn-{}", utterance.sequence),
            context_tool_command: format!(
                "$LANTOR_CONTEXT_TOOL --agent-context-tool call-utterance-read --utterance-id {}",
                utterance.id
            ),
        }
    }
}

fn compact_chars_middle_preserve_edges(value: &str, limit: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= limit {
        return value.to_owned();
    }

    let head_len = limit.saturating_mul(2) / 3;
    let tail_len = limit.saturating_sub(head_len);
    let omitted = chars.len().saturating_sub(head_len + tail_len);
    let head = chars.iter().take(head_len).collect::<String>();
    let tail = chars
        .iter()
        .skip(chars.len().saturating_sub(tail_len))
        .collect::<String>();
    format!(
        "{head}\n\n[... Lantor omitted {omitted} chars to keep spoken_request within the inline budget ...]\n\n{tail}"
    )
}

fn call_spoken_request_payload_json(
    transcript: &str,
    retrieval_ref: Option<CallSpokenRequestRetrievalRef>,
) -> String {
    let original_char_length = transcript.chars().count();
    let original_sha256 = format!("{:x}", Sha256::digest(transcript.as_bytes()));
    let full_payload = call_spoken_request_payload(
        transcript.to_owned(),
        original_char_length,
        original_char_length,
        transcript.len(),
        original_sha256.clone(),
        false,
        None,
    );
    let full_json = serde_json::to_string_pretty(&full_payload).unwrap_or_else(|_| "{}".to_owned());
    if full_json.chars().count() <= CALL_WORK_SPOKEN_REQUEST_PAYLOAD_BUDGET {
        return full_json;
    }

    let mut low = 0usize;
    let mut high = original_char_length.saturating_sub(1);
    let mut best_json = None;

    while low <= high {
        let included_source_char_budget = low + (high - low) / 2;
        let text = compact_chars_middle_preserve_edges(transcript, included_source_char_budget);
        let payload = call_spoken_request_payload(
            text,
            included_source_char_budget,
            original_char_length,
            transcript.len(),
            original_sha256.clone(),
            true,
            retrieval_ref.clone(),
        );
        let json = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned());
        if json.chars().count() <= CALL_WORK_SPOKEN_REQUEST_PAYLOAD_BUDGET {
            best_json = Some(json);
            low = included_source_char_budget.saturating_add(1);
        } else if included_source_char_budget == 0 {
            break;
        } else {
            high = included_source_char_budget - 1;
        }
    }

    best_json.unwrap_or_else(|| {
        let payload = call_spoken_request_payload(
            String::new(),
            0,
            original_char_length,
            transcript.len(),
            original_sha256,
            true,
            retrieval_ref,
        );
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned())
    })
}

fn call_spoken_request_payload(
    text: String,
    included_source_char_budget: usize,
    original_char_length: usize,
    original_byte_length: usize,
    original_sha256: String,
    truncated: bool,
    retrieval_ref: Option<CallSpokenRequestRetrievalRef>,
) -> CallSpokenRequestPayload {
    let included_text_char_length = text.chars().count();
    CallSpokenRequestPayload {
        schema: "lantor.call.spoken_request.v1",
        encoding: "json_escaped_utf8",
        inline_budget_chars: CALL_WORK_SPOKEN_REQUEST_PAYLOAD_BUDGET,
        original_char_length,
        original_byte_length,
        original_sha256,
        truncated,
        retrieval_ref,
        included_source_char_budget,
        included_text_char_length,
        text,
    }
}

fn call_work_context(
    session: &CallSession,
    utterance: &CallUtterance,
    dispatch: &CallDispatch,
    target: &CallDispatchTarget,
    transcript: &str,
) -> String {
    let transcript_excerpt = compact_chars_middle(transcript, CALL_WORK_TRANSCRIPT_EXCERPT_LIMIT);
    let mut lines = vec![
        call_worker_brief_header().to_owned(),
        call_worker_brief_intro().to_owned(),
        format!("session_id: {}", session.id),
        format!(
            "session_title: {}",
            session.title.as_deref().unwrap_or("Untitled call")
        ),
        format!("dispatch_id: {}", dispatch.id),
        format!("utterance_id: {}", utterance.id),
        format!("utterance_sequence: {}", utterance.sequence),
        format!("turn_handle: call-turn-{}", utterance.sequence),
        format!("target_agent: @{}", target.agent_handle),
        format!("target_agent_id: {}", target.agent_id),
        format!("target_agent_display_name: {}", target.agent_display_name),
        format!("ack_status: {}", dispatch.ack_status),
        format!("ack_text: {}", dispatch.ack_text),
        format!("speech_topic: {}", dispatch.speech_topic),
    ];
    if let Some(channel_id) = session.channel_id {
        lines.push(format!("channel_id: {channel_id}"));
    }
    if let Some(thread_root_id) = session.thread_root_id {
        lines.push(format!("thread_root_id: {thread_root_id}"));
    }
    lines.push(String::new());
    lines.push("transcript_excerpt:".to_owned());
    lines.push(transcript_excerpt);
    lines.push(String::new());
    lines.push("spoken_request:".to_owned());
    let retrieval_ref = (transcript.trim() == utterance.transcript.trim())
        .then(|| CallSpokenRequestRetrievalRef::new(session, utterance, dispatch));
    lines.push(call_spoken_request_payload_json(transcript, retrieval_ref));
    if !dispatch.speech_topic.trim().is_empty() {
        let voice_language = CallVoiceLanguage::from_hint(Some(&utterance.language));
        lines.push(String::new());
        lines.push("call_mode_voice_reply_contract:".to_owned());
        lines.push(call_mode_voice_reply_contract(
            voice_language,
            dispatch.speech_topic.trim(),
            &target.agent_display_name,
        ));
    }
    lines.join("\n")
}

fn call_mode_voice_reply_contract(
    voice_language: CallVoiceLanguage,
    speech_topic: &str,
    agent_display_name: &str,
) -> String {
    match voice_language {
        CallVoiceLanguage::ZhCn => format!(
            "This request was delegated from a live voice call. Your final visible reply will be spoken to the user directly. Start the final reply exactly with `关于{}，{}说，` using no space after `关于` and the Chinese comma after `说`. Use this source prefix once only, and do not repeat `关于...说` again in the answer body. Then give the readable answer the user asked for. In the final spoken reply, the only allowed punctuation marks are Chinese commas `，` and Chinese periods `。`; do not use colons, semicolons, exclamation marks, question marks, parentheses, bullets, Markdown, quotes, slashes, dashes, or numbered-list punctuation. Do not output a JSON object, code block, command log, internal status, database id, stream key, or implementation note unless the user explicitly asked for that. If the user asked for a list, summary, lookup result, recommendation, or concrete answer, include the core result itself instead of only saying that you prepared it. Keep it concise and easy to hear on a phone.",
            speech_topic,
            agent_display_name
        ),
        CallVoiceLanguage::EnUs => format!(
            "This request was delegated from a live voice call. Your final visible reply will be spoken to the user directly. Start the final reply exactly with `About {}, {} says, ` and use this source prefix once only. Then give the readable answer the user asked for in concise spoken English. Do not output a JSON object, code block, command log, internal status, database id, stream key, or implementation note unless the user explicitly asked for that. If the user asked for a list, summary, lookup result, recommendation, or concrete answer, include the core result itself instead of only saying that you prepared it. Keep it concise and easy to hear on a phone.",
            speech_topic,
            agent_display_name
        ),
    }
}

#[derive(Clone, Copy)]
struct NewDispatch<'a> {
    intent: &'a str,
    ack_status: &'a str,
    ack_text: &'a str,
    speech_topic: &'a str,
    confidence: &'a str,
    target_agent_id: Option<Uuid>,
    work_item_id: Option<Uuid>,
    long_task_id: Option<&'a str>,
    status: &'a str,
    error: &'a str,
}

async fn create_spoken_ack_dispatch(
    pool: &SqlitePool,
    session: &CallSession,
    utterance_id: Uuid,
    dispatch: NewDispatch<'_>,
    reason: &str,
) -> CommandResult<CallDispatch> {
    let dispatch = create_dispatch(pool, session.id, utterance_id, dispatch).await?;
    notify_ui_call_dispatch_upsert(pool, &dispatch, reason).await?;
    if dispatch.status != "ignored" {
        insert_call_coordinator_message(pool, session, utterance_id, dispatch.ack_text.trim())
            .await?;
    }
    Ok(dispatch)
}

async fn create_dispatch(
    pool: &SqlitePool,
    session_id: Uuid,
    utterance_id: Uuid,
    dispatch: NewDispatch<'_>,
) -> CommandResult<CallDispatch> {
    let dispatch_id: Uuid = sqlx::query_scalar(
        r#"
        insert into call_dispatches (
            session_id, utterance_id, intent, ack_status, ack_text, speech_topic,
            confidence, target_agent_id, work_item_id, long_task_id, status, error
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        returning id
        "#,
    )
    .bind(session_id)
    .bind(utterance_id)
    .bind(dispatch.intent)
    .bind(dispatch.ack_status)
    .bind(dispatch.ack_text)
    .bind(normalize_call_speech_topic(dispatch.speech_topic))
    .bind(dispatch.confidence)
    .bind(dispatch.target_agent_id)
    .bind(dispatch.work_item_id)
    .bind(dispatch.long_task_id)
    .bind(dispatch.status)
    .bind(dispatch.error)
    .fetch_one(pool)
    .await
    .map_err(to_string)?;
    load_call_dispatch(pool, dispatch_id).await
}

async fn update_dispatch_work_item(
    pool: &SqlitePool,
    dispatch_id: Uuid,
    session_id: Uuid,
    utterance_id: Uuid,
    work_item_id: Uuid,
    status: &str,
    error: &str,
) -> CommandResult<CallDispatch> {
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(to_string)?;
    let dispatch_row =
        sqlx::query("select session_id, utterance_id from call_dispatches where id = $1")
            .bind(dispatch_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(to_string)?;
    let Some(dispatch_row) = dispatch_row else {
        return Err("call dispatch not found".to_owned());
    };
    if dispatch_row.get::<Uuid, _>("session_id") != session_id
        || dispatch_row.get::<Uuid, _>("utterance_id") != utterance_id
    {
        return Err("call dispatch does not belong to the submitted utterance".to_owned());
    }

    let work_row = sqlx::query(
        r#"
        select call_session_id, call_utterance_id, call_dispatch_id
        from agent_work_items
        where id = $1
        "#,
    )
    .bind(work_item_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(to_string)?;
    let Some(work_row) = work_row else {
        return Err("agent work item not found".to_owned());
    };
    if work_row.get::<Option<Uuid>, _>("call_session_id") != Some(session_id)
        || work_row.get::<Option<Uuid>, _>("call_utterance_id") != Some(utterance_id)
        || work_row.get::<Option<Uuid>, _>("call_dispatch_id") != Some(dispatch_id)
    {
        return Err("agent work item is not correlated to the call dispatch".to_owned());
    }

    sqlx::query(
        r#"
        update call_dispatches
        set work_item_id = $2,
            compensated_work_item_id = null,
            status = $3,
            error = $4,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(dispatch_id)
    .bind(work_item_id)
    .bind(status)
    .bind(error)
    .execute(&mut *tx)
    .await
    .map_err(to_string)?;
    tx.commit().await.map_err(to_string)?;
    load_call_dispatch(pool, dispatch_id).await
}

async fn update_dispatch_failure(
    pool: &SqlitePool,
    dispatch_id: Uuid,
    status: &str,
    error: &str,
) -> CommandResult<CallDispatch> {
    sqlx::query(
        r#"
        update call_dispatches
        set status = $2,
            error = $3,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(dispatch_id)
    .bind(status)
    .bind(error)
    .execute(pool)
    .await
    .map_err(to_string)?;
    load_call_dispatch(pool, dispatch_id).await
}

async fn compensate_unlinked_call_dispatch_work(
    pool: &SqlitePool,
    dispatch_id: Uuid,
    work_item_id: Uuid,
    link_error: &str,
) -> CommandResult<CallDispatch> {
    let compensation = cancel_agent_work_in_pool(pool, work_item_id).await;
    let (status, error) = match compensation {
        Ok(()) => match load_agent_work_item_status(pool, work_item_id).await? {
            Some(work_status) if work_status == "cancelled" => (
                "compensated",
                format!(
                    "{link_error}; cancelled unlinked work item {work_item_id} so it cannot continue without a call dispatch link"
                ),
            ),
            Some(work_status) => (
                "failed",
                format!(
                    "{link_error}; cancellation requested for already-started unlinked work item {work_item_id}, but it is still {work_status} and may continue until the worker stops"
                ),
            ),
            None => (
                "failed",
                format!(
                    "{link_error}; compensation could not verify unlinked work item {work_item_id} after cancellation"
                ),
            ),
        },
        Err(compensation_error) => (
            "failed",
            format!(
                "{link_error}; compensation failed for unlinked work item {work_item_id}: {compensation_error}"
            ),
        ),
    };
    update_dispatch_compensation(pool, dispatch_id, work_item_id, status, &error).await
}

async fn load_agent_work_item_status(
    pool: &SqlitePool,
    work_item_id: Uuid,
) -> CommandResult<Option<String>> {
    sqlx::query_scalar("select status from agent_work_items where id = $1")
        .bind(work_item_id)
        .fetch_optional(pool)
        .await
        .map_err(to_string)
}

async fn update_dispatch_compensation(
    pool: &SqlitePool,
    dispatch_id: Uuid,
    compensated_work_item_id: Uuid,
    status: &str,
    error: &str,
) -> CommandResult<CallDispatch> {
    sqlx::query(
        r#"
        update call_dispatches
        set work_item_id = null,
            compensated_work_item_id = $2,
            status = $3,
            error = $4,
            updated_at = strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
        where id = $1
        "#,
    )
    .bind(dispatch_id)
    .bind(compensated_work_item_id)
    .bind(status)
    .bind(error)
    .execute(pool)
    .await
    .map_err(to_string)?;
    load_call_dispatch(pool, dispatch_id).await
}

pub(crate) async fn load_call_dispatch(
    pool: &SqlitePool,
    dispatch_id: Uuid,
) -> CommandResult<CallDispatch> {
    let row = sqlx::query(
        r#"
        select
            d.id, d.session_id, d.utterance_id, u.sequence as utterance_sequence,
            d.intent, d.ack_status, d.ack_text, d.speech_topic, d.confidence, d.target_agent_id,
            d.work_item_id, d.compensated_work_item_id, d.long_task_id,
            d.status, d.error, d.created_at, d.updated_at
        from call_dispatches d
        join call_utterances u on u.id = d.utterance_id
        where d.id = $1
        "#,
    )
    .bind(dispatch_id)
    .fetch_one(pool)
    .await
    .map_err(to_string)?;
    Ok(call_dispatch_from_row(row))
}

fn call_session_from_row(row: sqlx::sqlite::SqliteRow) -> CallSession {
    CallSession {
        id: row.get("id"),
        channel_id: row.get("channel_id"),
        thread_root_id: row.get("thread_root_id"),
        mode: row.get("mode"),
        wake_words: row.get("wake_words"),
        status: row.get("status"),
        title: row.get("title"),
        started_at: row.get("started_at"),
        ended_at: row.get("ended_at"),
        updated_at: row.get("updated_at"),
    }
}

fn call_utterance_from_row(row: sqlx::sqlite::SqliteRow) -> CallUtterance {
    CallUtterance {
        id: row.get("id"),
        session_id: row.get("session_id"),
        thread_root_utterance_id: row.get("thread_root_utterance_id"),
        source_message_id: row.get("source_message_id"),
        sequence: row.get("sequence"),
        transcript: row.get("transcript"),
        language: row.get("language"),
        transcription_provider: row.get("transcription_provider"),
        transcription_error: row.get("transcription_error"),
        audio_mime_type: row.get("audio_mime_type"),
        audio_original_name: row.get("audio_original_name"),
        audio_duration_ms: row
            .get::<Option<i64>, _>("audio_duration_ms")
            .map(|value| value as u32),
        status: row.get("status"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn call_dispatch_from_row(row: sqlx::sqlite::SqliteRow) -> CallDispatch {
    let id: Uuid = row.get("id");
    let session_id: Uuid = row.get("session_id");
    let utterance_id: Uuid = row.get("utterance_id");
    let utterance_sequence: i64 = row.get("utterance_sequence");
    let intent: String = row.get("intent");
    let ack_status: String = row.get("ack_status");
    let target_agent_id: Option<Uuid> = row.get("target_agent_id");
    let work_item_id: Option<Uuid> = row.get("work_item_id");
    let compensated_work_item_id: Option<Uuid> = row.get("compensated_work_item_id");
    let long_task_id: Option<String> = row.get("long_task_id");
    let status: String = row.get("status");
    let outcome = call_dispatch_outcome(
        &intent,
        &status,
        work_item_id,
        compensated_work_item_id,
        long_task_id.as_deref(),
    );
    let status_text = call_dispatch_status_text(&status, &outcome);
    let correlation_key = format!("call:{session_id}:utterance:{utterance_sequence}:dispatch:{id}");
    let mut correlation_trail = vec![
        format!("call_session:{session_id}"),
        format!("utterance:{utterance_id}"),
        format!("utterance_sequence:{utterance_sequence}"),
        format!("dispatch:{id}"),
    ];
    if let Some(target_agent_id) = target_agent_id {
        correlation_trail.push(format!("target_agent:{target_agent_id}"));
    }
    if let Some(work_item_id) = work_item_id {
        correlation_trail.push(format!("work_item:{work_item_id}"));
    }
    if let Some(compensated_work_item_id) = compensated_work_item_id {
        correlation_trail.push(format!("compensated_work_item:{compensated_work_item_id}"));
    }
    if let Some(long_task_id) = &long_task_id {
        correlation_trail.push(format!("long_task:{long_task_id}"));
    }

    CallDispatch {
        id,
        session_id,
        utterance_id,
        utterance_sequence,
        intent,
        ack_status,
        ack_text: row.get("ack_text"),
        speech_topic: row.get("speech_topic"),
        confidence: row.get("confidence"),
        target_agent_id,
        work_item_id,
        compensated_work_item_id,
        long_task_id,
        status,
        outcome,
        status_text,
        correlation_key,
        correlation_trail,
        error: row.get("error"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn call_dispatch_outcome(
    intent: &str,
    status: &str,
    work_item_id: Option<Uuid>,
    compensated_work_item_id: Option<Uuid>,
    long_task_id: Option<&str>,
) -> String {
    match status {
        "compensated" => "work_link_compensated",
        "queued" if intent == "cancel_work" && work_item_id.is_some() => "work_cancel_requested",
        "queued" if work_item_id.is_some() => "work_queued",
        "queued" if long_task_id.is_some() => "long_task_queued",
        "failed" if compensated_work_item_id.is_some() => "work_link_compensation_failed",
        "failed" => "dispatch_failed",
        "needs_user" => "needs_user",
        "ignored" => "ignored",
        "acknowledged" if intent == "ack_only" => "acknowledged",
        "acknowledged" => "acknowledged_pending_work",
        _ => status,
    }
    .to_owned()
}

fn call_dispatch_status_text(status: &str, outcome: &str) -> String {
    match outcome {
        "acknowledged" => "Heard and acknowledged.",
        "acknowledged_pending_work" => "Acknowledged; background work is being created.",
        "work_queued" => "Background work queued.",
        "work_cancel_requested" => "Cancellation requested.",
        "long_task_queued" => "Long task queued.",
        "needs_user" => "Needs user clarification.",
        "dispatch_failed" => "Dispatch failed.",
        "work_link_compensated" => "Work creation was rolled back after the call link failed.",
        "work_link_compensation_failed" => {
            "Work link failed and automatic rollback did not complete."
        }
        "superseded" => "Pending confirmation resolved.",
        "ignored" => "Ignored.",
        _ => status,
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use std::{env, future::Future};

    use sqlx::sqlite::SqlitePoolOptions;
    use tokio::{
        sync::Mutex,
        time::{sleep, Duration},
    };

    use super::*;

    static VOICE_ENV_LOCK: Mutex<()> = Mutex::const_new(());

    #[tokio::test]
    async fn default_call_coordinator_uses_dedicated_app_server_unless_command_is_overridden() {
        let _guard = VOICE_ENV_LOCK.lock().await;
        let previous_command = env::var(CALL_COORDINATOR_COMMAND_ENV).ok();
        let previous_model = env::var(CALL_COORDINATOR_MODEL_ENV).ok();
        let previous_reasoning = env::var(CALL_COORDINATOR_REASONING_EFFORT_ENV).ok();

        env::remove_var(CALL_COORDINATOR_COMMAND_ENV);
        env::set_var(CALL_COORDINATOR_MODEL_ENV, "gpt-test");
        env::set_var(CALL_COORDINATOR_REASONING_EFFORT_ENV, "medium");

        assert!(env_call_coordinator_command().is_none());
        assert_eq!(call_coordinator_model_value(), "gpt-test");
        assert_eq!(call_coordinator_reasoning_effort(), "medium");

        env::set_var(CALL_COORDINATOR_COMMAND_ENV, "coordinator-test-command");
        assert_eq!(
            env_call_coordinator_command().as_deref(),
            Some("coordinator-test-command")
        );

        match previous_command {
            Some(value) => env::set_var(CALL_COORDINATOR_COMMAND_ENV, value),
            None => env::remove_var(CALL_COORDINATOR_COMMAND_ENV),
        }
        match previous_model {
            Some(value) => env::set_var(CALL_COORDINATOR_MODEL_ENV, value),
            None => env::remove_var(CALL_COORDINATOR_MODEL_ENV),
        }
        match previous_reasoning {
            Some(value) => env::set_var(CALL_COORDINATOR_REASONING_EFFORT_ENV, value),
            None => env::remove_var(CALL_COORDINATOR_REASONING_EFFORT_ENV),
        }
    }

    #[tokio::test]
    async fn default_call_coordinator_runtime_uses_stronger_low_reasoning_model() {
        let _guard = VOICE_ENV_LOCK.lock().await;
        let previous_model = env::var(CALL_COORDINATOR_MODEL_ENV).ok();
        let previous_reasoning = env::var(CALL_COORDINATOR_REASONING_EFFORT_ENV).ok();

        env::remove_var(CALL_COORDINATOR_MODEL_ENV);
        env::remove_var(CALL_COORDINATOR_REASONING_EFFORT_ENV);

        assert_eq!(call_coordinator_model_value(), "gpt-5.5");
        assert_eq!(call_coordinator_reasoning_effort(), "low");

        match previous_model {
            Some(value) => env::set_var(CALL_COORDINATOR_MODEL_ENV, value),
            None => env::remove_var(CALL_COORDINATOR_MODEL_ENV),
        }
        match previous_reasoning {
            Some(value) => env::set_var(CALL_COORDINATOR_REASONING_EFFORT_ENV, value),
            None => env::remove_var(CALL_COORDINATOR_REASONING_EFFORT_ENV),
        }
    }

    #[tokio::test]
    async fn call_coordinator_thread_id_persists_without_agent_row() {
        let pool = test_pool().await;

        assert_eq!(load_call_coordinator_thread_id(&pool).await.unwrap(), None);

        upsert_call_coordinator_thread_id(&pool, "thread-a", "idle")
            .await
            .unwrap();
        assert_eq!(
            load_call_coordinator_thread_id(&pool)
                .await
                .unwrap()
                .as_deref(),
            Some("thread-a")
        );

        let agent_count: i64 = sqlx::query_scalar("select count(*) from agents")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(agent_count, 0);

        upsert_call_coordinator_thread_id(&pool, "thread-b", "idle")
            .await
            .unwrap();
        let rows: i64 = sqlx::query_scalar("select count(*) from provider_runtime_sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(
            load_call_coordinator_thread_id(&pool)
                .await
                .unwrap()
                .as_deref(),
            Some("thread-b")
        );
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for statement in [
            "create table channels (id blob primary key not null default (randomblob(16)), name text not null default '', kind text not null default 'channel', dm_agent_id blob)",
            "create table messages (id blob primary key not null default (randomblob(16)), channel_id blob not null, thread_root_id blob, sender_agent_id blob, sender_name text not null default 'Me', sender_role text not null default 'owner', body text not null default '', is_task boolean not null default 0, thread_followed boolean not null default 1, delivery_state text not null default 'complete', stream_key text not null default '', created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')), updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')))",
            "create table agents (id blob primary key not null default (randomblob(16)), handle text not null, display_name text not null default '', status text not null default 'idle', runtime text not null default 'codex')",
            "create table tasks (id blob primary key not null default (randomblob(16)), number integer, channel_id blob, message_id blob, title text not null default '', assignee_agent_id blob, status text not null default 'open', version integer not null default 1, updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')))",
            "create table long_tasks (id text primary key)",
            "create table agent_work_items (id blob primary key not null default (randomblob(16)), agent_id blob not null, channel_id blob, thread_root_id blob, source_message_id blob, inbox_item_id blob, task_id blob, source_kind text not null default 'manual', title text not null, context text not null default '', status text not null default 'queued', run_id blob, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')), updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')), completed_at text)",
            "create table agent_inbox_items (id blob primary key not null default (randomblob(16)), agent_id blob not null, channel_id blob, thread_root_id blob, source_message_id blob, task_id blob, kind text not null, priority integer not null default 50, state text not null default 'unread', title text not null, body_preview text not null default '', payload text not null default '{}', work_item_id blob, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')), updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')), archived_at text)",
            "create table supervisor_commands (id blob primary key not null default (randomblob(16)), command_type text not null, agent_id blob, work_item_id blob, run_id blob, status text not null default 'pending', error text not null default '', created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')), updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')))",
            "create table agent_runs (id blob primary key not null default (randomblob(16)), agent_id blob not null, work_item_id blob, stopped_at text, status text not null default 'starting')",
            "create table agent_activities (id blob primary key not null default (randomblob(16)), agent_id blob, agent_handle text not null default '', run_id blob, kind text not null, phase text not null default 'event', status text not null default 'info', title text not null, summary text not null default '', detail text not null default '', metadata text not null default '{}', created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')))",
            "create table channel_members (channel_id blob not null, agent_id blob not null, primary key (channel_id, agent_id))",
            "create table agent_thread_subscriptions (agent_id blob not null, channel_id blob not null, thread_root_id blob not null, source_kind text not null default 'manual', last_source_message_id blob, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')), updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')), primary key (agent_id, thread_root_id))",
            "create table ui_events (id integer primary key autoincrement, event_json text not null, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')))",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        migrate_call_mode_schema(&pool).await.unwrap();
        pool
    }

    async fn with_deterministic_transcription_provider<T, F, Fut>(run: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let _guard = VOICE_ENV_LOCK.lock().await;
        let previous_provider = env::var("LANTOR_TRANSCRIPTION_PROVIDER").ok();
        let previous_command = env::var("LANTOR_TRANSCRIPTION_COMMAND").ok();
        let previous_coordinator = env::var(CALL_COORDINATOR_COMMAND_ENV).ok();

        env::set_var("LANTOR_TRANSCRIPTION_PROVIDER", "deterministic");
        env::remove_var("LANTOR_TRANSCRIPTION_COMMAND");
        env::set_var(
            CALL_COORDINATOR_COMMAND_ENV,
            test_call_coordinator_command(),
        );

        let result = run().await;

        match previous_provider {
            Some(value) => env::set_var("LANTOR_TRANSCRIPTION_PROVIDER", value),
            None => env::remove_var("LANTOR_TRANSCRIPTION_PROVIDER"),
        }
        match previous_command {
            Some(value) => env::set_var("LANTOR_TRANSCRIPTION_COMMAND", value),
            None => env::remove_var("LANTOR_TRANSCRIPTION_COMMAND"),
        }
        match previous_coordinator {
            Some(value) => env::set_var(CALL_COORDINATOR_COMMAND_ENV, value),
            None => env::remove_var(CALL_COORDINATOR_COMMAND_ENV),
        }

        result
    }

    async fn with_command_transcription_provider<T, F, Fut>(command: &str, run: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let _guard = VOICE_ENV_LOCK.lock().await;
        let previous_provider = env::var("LANTOR_TRANSCRIPTION_PROVIDER").ok();
        let previous_command = env::var("LANTOR_TRANSCRIPTION_COMMAND").ok();
        let previous_coordinator = env::var(CALL_COORDINATOR_COMMAND_ENV).ok();

        env::set_var("LANTOR_TRANSCRIPTION_PROVIDER", "command");
        env::set_var("LANTOR_TRANSCRIPTION_COMMAND", command);
        env::set_var(
            CALL_COORDINATOR_COMMAND_ENV,
            test_call_coordinator_command(),
        );

        let result = run().await;

        match previous_provider {
            Some(value) => env::set_var("LANTOR_TRANSCRIPTION_PROVIDER", value),
            None => env::remove_var("LANTOR_TRANSCRIPTION_PROVIDER"),
        }
        match previous_command {
            Some(value) => env::set_var("LANTOR_TRANSCRIPTION_COMMAND", value),
            None => env::remove_var("LANTOR_TRANSCRIPTION_COMMAND"),
        }
        match previous_coordinator {
            Some(value) => env::set_var(CALL_COORDINATOR_COMMAND_ENV, value),
            None => env::remove_var(CALL_COORDINATOR_COMMAND_ENV),
        }

        result
    }

    fn test_call_coordinator_command() -> &'static str {
        r#"python3 -c 'import json,sys
p=json.load(sys.stdin)
t=p.get("current_utterance",{}).get("transcript","")
low=t.lower()
stripped=low.strip()
agents=p.get("available_agents",[])
if stripped in ["hello","hi","hey","are you there"] or any(s in t for s in ["在吗","有人"]):
    say="我在，继续说。" if any(ord(ch)>127 for ch in t) else "I'\''m here and listening."
    print(json.dumps({"tool":"speak_to_user","say":say,"confidence":"medium"}))
    raise SystemExit
for a in agents:
    h=a.get("handle","")
    if ("@"+h).lower() in low or h.lower() in low:
        print(json.dumps({"tool":"dispatch_agent_work","target_agent_handle":h,"confidence":"high","say":"Got it. I assigned this to @%s."%h}))
        raise SystemExit
if agents:
    h=agents[0].get("handle","")
    print(json.dumps({"tool":"dispatch_agent_work","target_agent_handle":h,"confidence":"low","say":"Got it. I assigned this to @%s."%h}))
else:
    print(json.dumps({"tool":"ask_user","say":"I heard the request, but there is no available agent in this channel.","confidence":"high","error":"channel has no dispatchable agents"}))
'"#
    }

    async fn with_command_call_coordinator<T, F, Fut>(command: &str, run: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let _guard = VOICE_ENV_LOCK.lock().await;
        let previous_provider = env::var("LANTOR_TRANSCRIPTION_PROVIDER").ok();
        let previous_transcription_command = env::var("LANTOR_TRANSCRIPTION_COMMAND").ok();
        let previous_coordinator = env::var(CALL_COORDINATOR_COMMAND_ENV).ok();

        env::set_var("LANTOR_TRANSCRIPTION_PROVIDER", "deterministic");
        env::remove_var("LANTOR_TRANSCRIPTION_COMMAND");
        env::set_var(CALL_COORDINATOR_COMMAND_ENV, command);

        let result = run().await;

        match previous_provider {
            Some(value) => env::set_var("LANTOR_TRANSCRIPTION_PROVIDER", value),
            None => env::remove_var("LANTOR_TRANSCRIPTION_PROVIDER"),
        }
        match previous_transcription_command {
            Some(value) => env::set_var("LANTOR_TRANSCRIPTION_COMMAND", value),
            None => env::remove_var("LANTOR_TRANSCRIPTION_COMMAND"),
        }
        match previous_coordinator {
            Some(value) => env::set_var(CALL_COORDINATOR_COMMAND_ENV, value),
            None => env::remove_var(CALL_COORDINATOR_COMMAND_ENV),
        }

        result
    }

    async fn wait_for_dispatch_work_link(pool: &SqlitePool, dispatch_id: Uuid) -> CallDispatch {
        for _ in 0..50 {
            let dispatch = load_call_dispatch(pool, dispatch_id).await.unwrap();
            if dispatch.work_item_id.is_some()
                || matches!(dispatch.status.as_str(), "failed" | "compensated")
            {
                return dispatch;
            }
            sleep(Duration::from_millis(10)).await;
        }
        load_call_dispatch(pool, dispatch_id).await.unwrap()
    }

    async fn pending_low_confidence_confirmation_fixture(
        channel_name: &str,
    ) -> (
        SqlitePool,
        CallSession,
        Uuid,
        Uuid,
        CallUtteranceSubmitResult,
    ) {
        let pool = test_pool().await;
        let ada_id: Uuid = sqlx::query_scalar(
            "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let bob_id: Uuid = sqlx::query_scalar(
            "insert into agents (handle, status, runtime) values ('Bob', 'idle', 'codex') returning id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let channel_id: Uuid = sqlx::query_scalar(
            "insert into channels (name, kind) values ($1, 'channel') returning id",
        )
        .bind(channel_name)
        .fetch_one(&pool)
        .await
        .unwrap();
        for agent_id in [ada_id, bob_id] {
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        let session = call_session_start_in_pool(
            &pool,
            Some(channel_id),
            None,
            Some(channel_name.to_owned()),
        )
        .await
        .unwrap();
        let candidate = call_session_submit_utterance_in_pool(
            &pool,
            CallUtteranceSubmitRequest {
                session_id: session.id,
                bytes: b"LANTOR_TRANSCRIPT:maybe send this over there".to_vec(),
                mime_type: "audio/webm".to_owned(),
                original_name: Some("low-confidence.webm".to_owned()),
                duration_ms: Some(1800),
                language: Some("en".to_owned()),
                final_fragment_reason: None,
            },
        )
        .await
        .unwrap();

        (pool, session, ada_id, bob_id, candidate)
    }

    async fn ui_event_values(pool: &SqlitePool) -> Vec<serde_json::Value> {
        sqlx::query_scalar::<_, String>("select event_json from ui_events order by id asc")
            .fetch_all(pool)
            .await
            .unwrap()
            .into_iter()
            .map(|event_json| serde_json::from_str(&event_json).unwrap())
            .collect()
    }

    fn ui_event_reason(event: &serde_json::Value) -> Option<&str> {
        event.get("reason").and_then(|reason| reason.as_str())
    }

    fn ui_event_dispatch_id(event: &serde_json::Value) -> Option<Uuid> {
        event
            .get("dispatch")
            .and_then(|dispatch| dispatch.get("id"))
            .and_then(|id| id.as_str())
            .and_then(|id| Uuid::parse_str(id).ok())
    }

    fn spoken_request_payload_from_context(context: &str) -> serde_json::Value {
        let payload = context
            .split_once("spoken_request:\n")
            .map(|(_, payload)| payload.trim())
            .expect("spoken request payload");
        serde_json::from_str(payload).expect("structured spoken request payload")
    }

    #[tokio::test]
    async fn submit_empty_audio_persists_failed_utterance_and_ack() {
        let pool = test_pool().await;
        let session = call_session_start_in_pool(&pool, None, None, Some("Standup".to_owned()))
            .await
            .unwrap();

        let result = call_session_submit_utterance_in_pool(
            &pool,
            CallUtteranceSubmitRequest {
                session_id: session.id,
                bytes: Vec::new(),
                mime_type: "audio/webm".to_owned(),
                original_name: Some("empty.webm".to_owned()),
                duration_ms: Some(0),
                language: None,
                final_fragment_reason: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(result.utterance.sequence, 1);
        assert_eq!(result.utterance.status, "failed");
        assert!(result.utterance.transcription_error.contains("emptyAudio"));
        assert_eq!(result.dispatch.status, "failed");
        assert_eq!(result.dispatch.ack_status, "unsupported");
        assert_eq!(result.ack_text, result.dispatch.ack_text);

        let utterance_count: i64 =
            sqlx::query_scalar("select count(*) from call_utterances where session_id = $1")
                .bind(session.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let dispatch_count: i64 =
            sqlx::query_scalar("select count(*) from call_dispatches where session_id = $1")
                .bind(session.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(utterance_count, 1);
        assert_eq!(dispatch_count, 1);
    }

    #[tokio::test]
    async fn submit_short_no_speech_transcription_is_ignored_without_failed_dispatch() {
        with_command_transcription_provider("cat >/dev/null; printf ''", || async {
            let pool = test_pool().await;
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('quiet-call', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Quiet segment".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"valid container but provider hears no words".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("quiet.webm".to_owned()),
                    duration_ms: Some(1500),
                    language: None,
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.utterance.sequence, 1);
            assert_eq!(result.utterance.status, "ignored");
            assert!(result
                .utterance
                .transcription_error
                .contains("emptyTranscript"));
            assert_eq!(result.dispatch.intent, "ack_only");
            assert_eq!(result.dispatch.ack_status, "heard");
            assert_eq!(result.dispatch.status, "ignored");
            assert_eq!(result.dispatch.work_item_id, None);
            assert_eq!(result.work_item_id, None);

            let coordinator_reply_count: i64 = sqlx::query_scalar(
                "select count(*) from messages where sender_name = 'System Agent'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(coordinator_reply_count, 0);
        })
        .await;
    }

    #[tokio::test]
    async fn submit_long_no_speech_transcription_is_ignored() {
        with_command_transcription_provider("cat >/dev/null; printf ''", || async {
            let pool = test_pool().await;
            let session = call_session_start_in_pool(
                &pool,
                None,
                None,
                Some("Long noisy segment".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"long noisy audio that provider misclassified".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("long-no-speech.webm".to_owned()),
                    duration_ms: Some(32_000),
                    language: None,
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.utterance.sequence, 1);
            assert_eq!(result.utterance.status, "ignored");
            assert!(result
                .utterance
                .transcription_error
                .contains("emptyTranscript"));
            assert_eq!(result.dispatch.intent, "ack_only");
            assert_eq!(result.dispatch.ack_status, "heard");
            assert_eq!(result.dispatch.status, "ignored");
            assert_eq!(result.dispatch.work_item_id, None);
            assert!(result.dispatch.ack_text.contains("没有检测到说话"));
        })
        .await;
    }

    #[tokio::test]
    async fn submit_rejects_ended_session_before_creating_utterance() {
        let pool = test_pool().await;
        let session = call_session_start_in_pool(&pool, None, None, Some("Closed".to_owned()))
            .await
            .unwrap();
        call_session_stop_in_pool(&pool, session.id).await.unwrap();

        let err = call_session_submit_utterance_in_pool(
            &pool,
            CallUtteranceSubmitRequest {
                session_id: session.id,
                bytes: b"LANTOR_TRANSCRIPT:@Ada ignored".to_vec(),
                mime_type: "audio/webm".to_owned(),
                original_name: Some("closed.webm".to_owned()),
                duration_ms: Some(1000),
                language: None,
                final_fragment_reason: None,
            },
        )
        .await
        .unwrap_err();

        assert_eq!(err, "call session is not active");
        let utterance_count: i64 =
            sqlx::query_scalar("select count(*) from call_utterances where session_id = $1")
                .bind(session.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let dispatch_count: i64 =
            sqlx::query_scalar("select count(*) from call_dispatches where session_id = $1")
                .bind(session.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(utterance_count, 0);
        assert_eq!(dispatch_count, 0);
    }

    #[tokio::test]
    async fn wake_word_mode_ignores_transcripts_without_wake_word() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let session = call_session_start_with_options_in_pool(
                &pool,
                None,
                None,
                Some("Wake console".to_owned()),
                Some("wake_word".to_owned()),
                Some("兰托,Lantor".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:@Ada do this".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("no-wake.webm".to_owned()),
                    duration_ms: Some(1600),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.session.mode, "wake_word");
            assert_eq!(result.utterance.status, "ignored");
            assert_eq!(result.dispatch.status, "ignored");
            assert_eq!(result.dispatch.intent, "ack_only");
            assert_eq!(result.work_item_id, None);
            let coordinator_reply_count: i64 = sqlx::query_scalar(
                "select count(*) from messages where sender_name = 'System Agent'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(coordinator_reply_count, 0);
        })
        .await;
    }

    #[test]
    fn wake_word_matching_uses_first_wake_word_and_normalizes_spacing() {
        assert_eq!(
            strip_call_wake_word("小 帅 帮我找 kunk", "小帅,小美,Lantor").as_deref(),
            Some("帮我找 kunk")
        );
        assert_eq!(
            strip_call_wake_word("你好小帅帮我找 kunk", "小帅,小美,Lantor").as_deref(),
            Some("帮我找 kunk")
        );
        assert_eq!(
            strip_call_wake_word("小帅小帅", "小帅,小美,Lantor").as_deref(),
            Some("")
        );
        assert_eq!(
            strip_call_wake_word("小帅啊", "小帅,小美,Lantor").as_deref(),
            Some("")
        );
    }

    #[test]
    fn wake_word_matching_accepts_configured_short_homophones() {
        assert_eq!(
            strip_call_wake_word("小妹小妹", "小美").as_deref(),
            Some("")
        );
        assert_eq!(
            strip_call_wake_word("小妹帮我找 kunk", "小美").as_deref(),
            Some("帮我找 kunk")
        );
        assert_eq!(
            strip_call_wake_word("你好小妹帮我找 kunk", "小美").as_deref(),
            Some("帮我找 kunk")
        );
        assert_eq!(
            strip_call_wake_word("阿墙帮我整理", "阿强").as_deref(),
            Some("帮我整理")
        );
    }

    #[test]
    fn wake_word_phonetic_matching_stays_near_transcript_start() {
        assert_eq!(strip_call_wake_word("这句话后面才提到小妹", "小美"), None);
        assert_eq!(strip_call_wake_word("小明帮我找 kunk", "小美"), None);
    }

    #[tokio::test]
    async fn wake_word_mode_strips_wake_word_before_dispatch() {
        let coordinator_command = r#"python3 -c 'import json,sys
p=json.load(sys.stdin)
t=p.get("current_utterance",{}).get("transcript","")
if t=="@Ada do this":
    print(json.dumps({"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"high","say":"Assigned stripped request."}))
else:
    print(json.dumps({"tool":"ask_user","say":"unexpected transcript: "+t,"confidence":"low","error":t}))
'"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, display_name, status, runtime) values ('Ada', 'Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('wake-word-call', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_with_options_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Wake console".to_owned()),
                Some("wake_word".to_owned()),
                Some("兰托,Lantor".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: "LANTOR_TRANSCRIPT:兰托 @Ada do this".as_bytes().to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("wake.webm".to_owned()),
                    duration_ms: Some(1600),
                    language: Some("zh-CN".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.utterance.transcript, "@Ada do this");
            assert_eq!(result.dispatch.intent, "agent_work");
            assert_eq!(result.dispatch.target_agent_id, Some(agent_id));
            assert_eq!(result.dispatch.work_item_id, None);
            let linked_dispatch = wait_for_dispatch_work_link(&pool, result.dispatch.id).await;
            assert!(linked_dispatch.work_item_id.is_some());
        })
        .await;
    }

    #[tokio::test]
    async fn wake_word_mode_treats_repeated_wake_word_as_wake_only() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let session = call_session_start_with_options_in_pool(
                &pool,
                None,
                None,
                Some("Wake console".to_owned()),
                Some("wake_word".to_owned()),
                Some("小帅,小美,Lantor".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: "LANTOR_TRANSCRIPT:小帅小帅".as_bytes().to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("wake-repeat.webm".to_owned()),
                    duration_ms: Some(1600),
                    language: Some("zh-CN".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.utterance.status, "acknowledged");
            assert_eq!(result.dispatch.intent, "ack_only");
            assert_eq!(result.dispatch.ack_text, "我在，您说。");
            let queued_dispatch_count: i64 = sqlx::query_scalar(
                "select count(*) from call_dispatches where session_id = $1 and intent = 'coordinator_pending'",
            )
            .bind(session.id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(queued_dispatch_count, 0);
        })
        .await;
    }

    #[tokio::test]
    async fn wake_word_mode_allows_one_followup_after_wake_only_ack() {
        let coordinator_command = r#"python3 -c 'import json,sys
p=json.load(sys.stdin)
t=p.get("current_utterance",{}).get("transcript","")
if t=="@Ada do this":
    print(json.dumps({"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"high","say":"Assigned follow-up."}))
else:
    print(json.dumps({"tool":"ask_user","say":"unexpected transcript: "+t,"confidence":"low","error":t}))
'"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, display_name, status, runtime) values ('Ada', 'Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('wake-followup-call', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_with_options_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Wake console".to_owned()),
                Some("wake_word".to_owned()),
                Some("小美".to_owned()),
            )
            .await
            .unwrap();

            let wake = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: "LANTOR_TRANSCRIPT:小美小美".as_bytes().to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("wake-only.webm".to_owned()),
                    duration_ms: Some(1600),
                    language: Some("zh-CN".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();
            assert_eq!(wake.dispatch.ack_text, "我在，您说。");

            let followup = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: "LANTOR_TRANSCRIPT:@Ada do this".as_bytes().to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("followup.webm".to_owned()),
                    duration_ms: Some(1800),
                    language: Some("zh-CN".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(followup.utterance.transcript, "@Ada do this");
            assert_eq!(followup.dispatch.intent, "agent_work");
            assert_eq!(followup.dispatch.target_agent_id, Some(agent_id));
            assert_eq!(followup.dispatch.work_item_id, None);
            let linked_dispatch = wait_for_dispatch_work_link(&pool, followup.dispatch.id).await;
            assert!(linked_dispatch.work_item_id.is_some());
        })
        .await;
    }

    #[tokio::test]
    async fn submit_marker_audio_persists_successful_utterance_ack_and_bootstrap_state() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let session =
                call_session_start_in_pool(&pool, None, None, Some("Dispatch prep".to_owned()))
                    .await
                    .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:send the prep notes to Ada".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("marker.webm".to_owned()),
                    duration_ms: Some(1800),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.utterance.sequence, 1);
            assert_eq!(result.utterance.status, "acknowledged");
            assert_eq!(result.utterance.transcript, "send the prep notes to Ada");
            assert_eq!(result.utterance.transcription_provider, "deterministic");
            assert_eq!(result.dispatch.status, "needs_user");
            assert_eq!(result.dispatch.intent, "clarify");
            assert_eq!(result.dispatch.ack_status, "needs_target");
            assert_eq!(
                result.dispatch.ack_text,
                "I heard the request, but there is no available agent in this channel."
            );
            assert_eq!(result.dispatch.error, "channel has no dispatchable agents");
            assert_eq!(result.work_item_id, None);

            let bootstrap_utterances = load_call_utterances(&pool).await.unwrap();
            let bootstrap_dispatches = load_call_dispatches(&pool).await.unwrap();

            assert_eq!(bootstrap_utterances.len(), 1);
            assert_eq!(bootstrap_utterances[0].id, result.utterance.id);
            assert_eq!(
                bootstrap_utterances[0].transcript,
                result.utterance.transcript
            );
            assert_eq!(bootstrap_dispatches.len(), 2);
            assert!(bootstrap_dispatches
                .iter()
                .any(|dispatch| dispatch.id == result.dispatch.id
                    && dispatch.utterance_id == result.utterance.id));
            assert!(bootstrap_dispatches.iter().any(|dispatch| {
                dispatch.intent == "coordinator_pending"
                    && dispatch.status == "superseded"
                    && dispatch.utterance_id == result.utterance.id
            }));
        })
        .await;
    }

    #[tokio::test]
    async fn submit_targeted_marker_audio_returns_ack_before_async_work_link() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('targeted-dispatch', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Dispatch to agent".to_owned()),
            )
            .await
            .unwrap();

            let full_request_marker = "preserve-this-middle-call-request-detail";
            let transcript = format!(
                "@Ada prepare the launch checklist {} {full_request_marker} {}",
                "front context ".repeat(300),
                "rear context ".repeat(300)
            );
            let audio_bytes = format!("LANTOR_TRANSCRIPT:{transcript}").into_bytes();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: audio_bytes,
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("targeted.webm".to_owned()),
                    duration_ms: Some(2100),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.dispatch.intent, "agent_work");
            assert_eq!(result.dispatch.ack_status, "understood");
            assert_eq!(result.dispatch.status, "acknowledged");
            assert_eq!(result.dispatch.target_agent_id, Some(agent_id));
            assert_eq!(result.dispatch.work_item_id, None);
            assert_eq!(result.work_item_id, None);
            assert_eq!(result.ack_text, "Got it. I assigned this to @Ada.");

            let linked_dispatch = wait_for_dispatch_work_link(&pool, result.dispatch.id).await;
            let work_item_id = linked_dispatch
                .work_item_id
                .expect("async call dispatch work item");
            assert_eq!(linked_dispatch.status, "queued");
            assert_eq!(linked_dispatch.utterance_sequence, result.utterance.sequence);
            assert_eq!(linked_dispatch.outcome, "work_queued");
            assert_eq!(linked_dispatch.status_text, "Background work queued.");
            assert!(linked_dispatch
                .correlation_key
                .contains(&format!("utterance:{}", result.utterance.sequence)));
            assert!(linked_dispatch
                .correlation_trail
                .contains(&format!("dispatch:{}", result.dispatch.id)));
            assert!(linked_dispatch
                .correlation_trail
                .contains(&format!("work_item:{work_item_id}")));

            let row = sqlx::query(
                r#"
                select agent_id, source_kind, title, context, status,
                       call_session_id, call_utterance_id, call_dispatch_id
                from agent_work_items
                where id = $1
                "#,
            )
            .bind(work_item_id)
            .fetch_one(&pool)
            .await
            .unwrap();

            assert_eq!(row.get::<Uuid, _>("agent_id"), agent_id);
            assert_eq!(row.get::<String, _>("source_kind"), "call_mode");
            assert_eq!(
                row.get::<String, _>("title"),
                transcript.chars().take(120).collect::<String>()
            );
            let work_context = row.get::<String, _>("context");
            assert!(work_context.contains("Call Mode worker brief:"));
            assert!(work_context.contains(&format!("session_id: {}", session.id)));
            assert!(work_context.contains("session_title: Dispatch to agent"));
            assert!(work_context.contains(&format!("dispatch_id: {}", result.dispatch.id)));
            assert!(work_context.contains(&format!("utterance_id: {}", result.utterance.id)));
            assert!(work_context.contains(&format!(
                "utterance_sequence: {}",
                result.utterance.sequence
            )));
            assert!(work_context.contains(&format!(
                "turn_handle: call-turn-{}",
                result.utterance.sequence
            )));
            assert!(work_context.contains("target_agent: @Ada"));
            assert!(work_context.contains(&format!("target_agent_id: {agent_id}")));
            assert!(work_context.contains("ack_status: understood"));
            assert!(work_context.contains("ack_text: Got it. I assigned this to @Ada."));
            assert!(work_context.contains("transcript_excerpt:"));
            assert!(work_context.contains("spoken_request:"));
            let persisted_transcript = result.utterance.transcript.as_str();
            let spoken_payload = spoken_request_payload_from_context(&work_context);
            assert_eq!(
                spoken_payload.get("schema").and_then(|value| value.as_str()),
                Some("lantor.call.spoken_request.v1")
            );
            assert_eq!(
                spoken_payload
                    .get("encoding")
                    .and_then(|value| value.as_str()),
                Some("json_escaped_utf8")
            );
            assert_eq!(
                spoken_payload
                    .get("inline_budget_chars")
                    .and_then(|value| value.as_u64()),
                Some(CALL_WORK_SPOKEN_REQUEST_PAYLOAD_BUDGET as u64)
            );
            assert_eq!(
                spoken_payload
                    .get("original_char_length")
                    .and_then(|value| value.as_u64()),
                Some(persisted_transcript.chars().count() as u64)
            );
            assert_eq!(
                spoken_payload
                    .get("original_byte_length")
                    .and_then(|value| value.as_u64()),
                Some(persisted_transcript.len() as u64)
            );
            assert_eq!(
                spoken_payload
                    .get("original_sha256")
                    .and_then(|value| value.as_str()),
                Some(format!("{:x}", Sha256::digest(persisted_transcript.as_bytes())).as_str())
            );
            assert_eq!(
                spoken_payload
                    .get("truncated")
                    .and_then(|value| value.as_bool()),
                Some(false)
            );
            assert!(spoken_payload.get("retrieval_ref").is_none());
            assert_eq!(
                spoken_payload.get("text").and_then(|value| value.as_str()),
                Some(persisted_transcript)
            );
            assert!(spoken_payload
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap()
                .contains(full_request_marker));
            assert_eq!(row.get::<String, _>("status"), "queued");
            assert_eq!(row.get::<Uuid, _>("call_session_id"), session.id);
            assert_eq!(row.get::<Uuid, _>("call_utterance_id"), result.utterance.id);
            assert_eq!(row.get::<Uuid, _>("call_dispatch_id"), result.dispatch.id);

            let dispatch_refs = sqlx::query(
                r#"
                select d.session_id, d.utterance_id, d.work_item_id,
                       w.call_session_id, w.call_utterance_id, w.call_dispatch_id
                from call_dispatches d
                join agent_work_items w on w.id = d.work_item_id
                where d.id = $1
                "#,
            )
            .bind(result.dispatch.id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(dispatch_refs.get::<Uuid, _>("session_id"), session.id);
            assert_eq!(
                dispatch_refs.get::<Uuid, _>("utterance_id"),
                result.utterance.id
            );
            assert_eq!(
                dispatch_refs.get::<Uuid, _>("work_item_id"),
                work_item_id
            );
            assert_eq!(
                dispatch_refs.get::<Uuid, _>("call_session_id"),
                dispatch_refs.get::<Uuid, _>("session_id")
            );
            assert_eq!(
                dispatch_refs.get::<Uuid, _>("call_utterance_id"),
                dispatch_refs.get::<Uuid, _>("utterance_id")
            );
            assert_eq!(
                dispatch_refs.get::<Uuid, _>("call_dispatch_id"),
                result.dispatch.id
            );

            let event_reasons: Vec<String> =
                sqlx::query_scalar::<_, String>("select event_json from ui_events order by id asc")
                    .fetch_all(&pool)
                    .await
                    .unwrap()
                    .into_iter()
                    .filter_map(|event_json| {
                        let event: serde_json::Value = serde_json::from_str(&event_json).ok()?;
                        event
                            .get("reason")
                            .and_then(|reason| reason.as_str())
                            .map(str::to_owned)
                    })
                    .collect();
            let ack_index = event_reasons
                .iter()
                .position(|reason| reason == "call_dispatch_acknowledged")
                .expect("dispatch ack event");
            let work_created_index = event_reasons
                .iter()
                .position(|reason| reason == "work_item_created")
                .expect("work item event");
            let work_linked_index = event_reasons
                .iter()
                .position(|reason| reason == "call_dispatch_work_linked")
                .expect("dispatch work link event");
            assert!(
                ack_index < work_created_index,
                "call ack must be emitted before work item creation: {event_reasons:?}"
            );
            assert!(
                ack_index < work_linked_index,
                "call ack must be emitted before the dispatch/work link update: {event_reasons:?}"
            );

            let supervisor_count: i64 = sqlx::query_scalar(
                "select count(*) from supervisor_commands where agent_id = $1 and work_item_id = $2",
            )
            .bind(agent_id)
            .bind(work_item_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(supervisor_count, 1);
        })
        .await;
    }

    #[tokio::test]
    async fn ui_call_cancel_records_dispatch_and_cancels_call_linked_work() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('ui-cancel', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Cancel UI".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:@Ada prepare a cancellable note".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("targeted.webm".to_owned()),
                    duration_ms: Some(2100),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            let linked_dispatch = wait_for_dispatch_work_link(&pool, result.dispatch.id).await;
            let work_item_id = linked_dispatch.work_item_id.expect("work item");

            let cancel = call_dispatch_cancel_work_in_pool(
                &pool,
                session.id,
                work_item_id,
                None,
            )
            .await
            .unwrap();
            let cancel_dispatch = cancel.dispatch;
            assert_eq!(cancel.utterance.transcript, "Cancel call request number 1");

            assert_eq!(cancel_dispatch.intent, "cancel_work");
            assert_eq!(cancel_dispatch.ack_status, "understood");
            assert_eq!(cancel_dispatch.status, "queued");
            assert_eq!(cancel_dispatch.outcome, "work_cancel_requested");
            assert_eq!(cancel_dispatch.target_agent_id, Some(agent_id));
            assert_eq!(cancel_dispatch.work_item_id, Some(work_item_id));
            assert_eq!(
                cancel_dispatch.ack_text,
                "Got it. I asked @Ada to stop call request number 1."
            );

            let work_status: String =
                sqlx::query_scalar("select status from agent_work_items where id = $1")
                    .bind(work_item_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(work_status, "cancelled");
        })
        .await;
    }

    #[tokio::test]
    async fn coordinator_cancel_tool_cancels_call_linked_work() {
        let coordinator_command = r#"python3 -c 'import json,sys
p=json.load(sys.stdin)
t=p.get("current_utterance",{}).get("transcript","")
if t=="prepare a cancellable note":
    print(json.dumps({"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"high","say":"I assigned that to Ada."}))
elif t=="please stop request one" and p.get("active_call_work"):
    print(json.dumps({"tool":"cancel_call_work","target_request_number":1,"confidence":"high","say":"I asked Ada to stop request one."}))
else:
    print(json.dumps({"tool":"ask_user","say":"missing dispatcher context","confidence":"low","error":"expected active call work context"}))
'"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('coordinator-cancel', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Coordinator cancel".to_owned()),
            )
            .await
            .unwrap();

            let first = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:prepare a cancellable note".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("first.webm".to_owned()),
                    duration_ms: Some(2100),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();
            let linked_dispatch = wait_for_dispatch_work_link(&pool, first.dispatch.id).await;
            let work_item_id = linked_dispatch.work_item_id.expect("work item");

            let cancel = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:please stop request one".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("cancel.webm".to_owned()),
                    duration_ms: Some(900),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(cancel.dispatch.intent, "cancel_work");
            assert_eq!(cancel.dispatch.target_agent_id, Some(agent_id));
            assert_eq!(cancel.dispatch.work_item_id, Some(work_item_id));
            assert_eq!(cancel.work_item_id, Some(work_item_id));
            assert_eq!(cancel.dispatch.outcome, "work_cancel_requested");
            assert_eq!(cancel.dispatch.ack_text, "I asked Ada to stop request one.");

            let work_status: String =
                sqlx::query_scalar("select status from agent_work_items where id = $1")
                    .bind(work_item_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(work_status, "cancelled");
        })
        .await;
    }

    #[tokio::test]
    async fn submit_uses_system_agent_coordinator_ack_for_dispatch() {
        let coordinator_command = r#"payload=$(cat); if printf '%s' "$payload" | grep -q '"handle":"Ada"' && printf '%s' "$payload" | grep -q '"transcript":"please route this by AI"'; then printf '%s' '{"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"high","say":"I have Ada handling that now.","speech_topic":"AI路由"}'; else printf '%s' '{"tool":"ask_user","say":"I need a target.","confidence":"low","error":"missing expected coordinator context"}'; fi"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('ai-dispatch', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("AI dispatch".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:please route this by AI".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("ai-dispatch.webm".to_owned()),
                    duration_ms: Some(2100),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.dispatch.intent, "agent_work");
            assert_eq!(result.dispatch.target_agent_id, Some(agent_id));
            assert_eq!(result.dispatch.confidence, "high");
            assert_eq!(result.ack_text, "I have Ada handling that now.");

            let coordinator_reply: String =
                sqlx::query_scalar("select body from messages where sender_name = 'System Agent'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(coordinator_reply, "I have Ada handling that now.");

            let linked_dispatch = wait_for_dispatch_work_link(&pool, result.dispatch.id).await;
            let work_item_id = linked_dispatch.work_item_id.expect("work item");
            let work_context: String =
                sqlx::query_scalar("select context from agent_work_items where id = $1")
                    .bind(work_item_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert!(work_context.contains("ack_text: I have Ada handling that now."));
            assert!(work_context.contains("About AI"));
        })
        .await;
    }

    #[tokio::test]
    async fn low_confidence_system_agent_dispatch_requests_confirmation_without_work() {
        let coordinator_command = r#"payload=$(cat); if printf '%s' "$payload" | grep -q '"handle":"Ada"'; then printf '%s' '{"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"low","say":"I think this is for Ada, but please confirm before I assign it."}'; else printf '%s' '{"tool":"ask_user","say":"I need a target.","confidence":"low","error":"missing target"}'; fi"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('ai-confirm', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("AI confirm".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:maybe send this over there".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("low-confidence.webm".to_owned()),
                    duration_ms: Some(1800),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.dispatch.intent, "clarify");
            assert_eq!(result.dispatch.ack_status, "needs_confirmation");
            assert_eq!(result.dispatch.status, "needs_user");
            assert_eq!(result.dispatch.confidence, "low");
            assert_eq!(result.dispatch.target_agent_id, Some(agent_id));
            assert_eq!(result.dispatch.work_item_id, None);
            assert!(result.dispatch.error.contains("low-confidence dispatch"));

            let work_count: i64 =
                sqlx::query_scalar("select count(*) from agent_work_items")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(work_count, 0);
        })
        .await;
    }

    #[tokio::test]
    async fn dispatcher_receives_pending_confirmation_context_and_can_dispatch_worker_brief() {
        let coordinator_command = r#"payload=$(cat); if printf '%s' "$payload" | grep -Eq '"current_utterance":\{[^}]*"transcript":"maybe send this over there"'; then printf '%s' '{"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"low","say":"I think this is for Ada, but please confirm before I assign it."}'; elif printf '%s' "$payload" | grep -q '"pending_confirmations":\[' && printf '%s' "$payload" | grep -q '"request_transcript":"maybe send this over there"'; then printf '%s' '{"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"high","say":"Confirmed. I assigned that to Ada.","request_transcript":"maybe send this over there"}'; else printf '%s' '{"tool":"ask_user","say":"missing pending confirmation context","confidence":"low","error":"expected pending confirmation context"}'; fi"#;
        with_command_call_coordinator(coordinator_command, || async {
            let (pool, session, ada_id, _bob_id, candidate) =
                pending_low_confidence_confirmation_fixture("ai-confirm-agent-context").await;
            assert_eq!(candidate.dispatch.ack_status, "needs_confirmation");
            assert_eq!(candidate.dispatch.target_agent_id, Some(ada_id));

            let confirmed = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:yes send it".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("confirm.webm".to_owned()),
                    duration_ms: Some(900),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(confirmed.dispatch.intent, "agent_work");
            assert_eq!(confirmed.dispatch.target_agent_id, Some(ada_id));
            assert_eq!(
                confirmed.dispatch.ack_text,
                "Confirmed. I assigned that to Ada."
            );

            let linked_dispatch = wait_for_dispatch_work_link(&pool, confirmed.dispatch.id).await;
            let work_item_id = linked_dispatch.work_item_id.expect("work item");
            let work_context: String =
                sqlx::query_scalar("select context from agent_work_items where id = $1")
                    .bind(work_item_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert!(work_context.contains("maybe send this over there"));
            assert!(!work_context.contains("spoken_request:\\n\"yes send it\""));
        })
        .await;
    }

    #[tokio::test]
    async fn call_control_confirmation_text_goes_through_dispatcher_context() {
        let coordinator_command = r#"python3 -c 'import json,sys
p=json.load(sys.stdin)
t=p.get("current_utterance",{}).get("transcript","")
if t=="maybe send this over there":
    print(json.dumps({"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"low","say":"I think this is for Ada, but please confirm before I assign it."}))
elif t=="yes" and p.get("pending_confirmations"):
    print(json.dumps({"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"high","say":"Confirmed from call controls.","request_transcript":"maybe send this over there"}))
else:
    print(json.dumps({"tool":"ask_user","say":"missing call-control confirmation context","confidence":"low","error":"expected call-control context"}))
'"#;
        with_command_call_coordinator(coordinator_command, || async {
            let (pool, session, ada_id, _bob_id, candidate) =
                pending_low_confidence_confirmation_fixture("ai-confirm-control").await;
            assert_eq!(candidate.dispatch.ack_status, "needs_confirmation");

            let confirmed = call_dispatch_resolve_confirmation_in_pool(
                &pool,
                session.id,
                " yes ".to_owned(),
                None,
            )
            .await
            .unwrap();

            assert_eq!(confirmed.utterance.transcription_provider, "call_control");
            assert_eq!(confirmed.utterance.transcript, "yes");
            assert_eq!(confirmed.dispatch.intent, "agent_work");
            assert_eq!(confirmed.dispatch.target_agent_id, Some(ada_id));
            assert_eq!(confirmed.dispatch.ack_text, "Confirmed from call controls.");
        })
        .await;
    }

    #[tokio::test]
    async fn typed_call_utterance_goes_through_dispatcher_context() {
        let coordinator_command = r#"python3 -c 'import json,sys
p=json.load(sys.stdin)
t=p.get("current_utterance",{}).get("transcript","")
if t=="typed smoke request":
    print(json.dumps({"tool":"speak_to_user","say":"Typed path heard.","confidence":"high"}))
else:
    print(json.dumps({"tool":"ask_user","say":"missing typed utterance","confidence":"low","error":"expected typed utterance context"}))
'"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('typed-call-utterance', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("typed-call-utterance".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_text_utterance_in_pool(
                &pool,
                session.id,
                " typed smoke request ".to_owned(),
                None,
                None,
            )
            .await
            .unwrap();

            assert_eq!(result.utterance.transcription_provider, "typed_simulation");
            assert_eq!(result.utterance.audio_mime_type, "application/x-lantor-typed-utterance");
            assert_eq!(result.utterance.transcript, "typed smoke request");
            assert_eq!(result.dispatch.intent, "ack_only");
            assert_eq!(result.dispatch.ack_text, "Typed path heard.");
        })
        .await;
    }

    #[tokio::test]
    async fn typed_voice_thread_reply_persists_root_and_reaches_coordinator_context() {
        let coordinator_command = r#"python3 -c 'import json,sys
p=json.load(sys.stdin)
t=p.get("current_utterance",{}).get("transcript","")
if t=="root request":
    print(json.dumps({"tool":"speak_to_user","say":"Root heard.","confidence":"high"}))
elif t=="thread reply" and p.get("current_utterance",{}).get("thread_root_utterance_id") and any(turn.get("transcript")=="root request" for turn in p.get("recent_voice_thread_turns",[])):
    print(json.dumps({"tool":"speak_to_user","say":"Thread reply heard.","confidence":"high"}))
else:
    print(json.dumps({"tool":"ask_user","say":"missing voice thread context","confidence":"low","error":json.dumps(p.get("current_utterance",{}))}))
'"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let session = call_session_start_in_pool(
                &pool,
                None,
                None,
                Some("workspace voice thread".to_owned()),
            )
            .await
            .unwrap();

            let root = call_session_submit_text_utterance_in_pool(
                &pool,
                session.id,
                " root request ".to_owned(),
                None,
                None,
            )
            .await
            .unwrap();
            let reply = call_session_submit_text_utterance_in_pool(
                &pool,
                session.id,
                " thread reply ".to_owned(),
                Some(root.utterance.id),
                None,
            )
            .await
            .unwrap();

            assert_eq!(
                reply.utterance.thread_root_utterance_id,
                Some(root.utterance.id)
            );
            assert_eq!(reply.dispatch.ack_text, "Thread reply heard.");

            let persisted_root: Option<Uuid> = sqlx::query_scalar(
                "select thread_root_utterance_id from call_utterances where id = $1",
            )
            .bind(reply.utterance.id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(persisted_root, Some(root.utterance.id));
        })
        .await;
    }

    #[tokio::test]
    async fn workspace_call_coordinator_sees_workspace_agents_from_system_call_channel() {
        let coordinator_command = r#"python3 -c 'import json,sys
p=json.load(sys.stdin)
handles=[a.get("handle") for a in p.get("available_agents",[])]
if "Ada" in handles:
    print(json.dumps({"tool":"dispatch_agent_work","target_agent_handle":"Ada","say":"Assigning Ada from Voice.","confidence":"high","request_transcript":"global voice request"}))
else:
    print(json.dumps({"tool":"ask_user","say":"missing global agents","confidence":"low","error":str(handles)}))
'"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let ada_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                None,
                None,
                Some("workspace voice".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_text_utterance_in_pool(
                &pool,
                session.id,
                " global voice request ".to_owned(),
                None,
                None,
            )
            .await
            .unwrap();

            assert!(result.session.channel_id.is_some());
            assert_eq!(result.dispatch.intent, "agent_work");
            assert_eq!(result.dispatch.target_agent_id, Some(ada_id));
            assert_eq!(result.dispatch.ack_text, "Assigning Ada from Voice.");
        })
        .await;
    }

    #[tokio::test]
    async fn global_call_dispatch_uses_system_channel_message_thread() {
        let coordinator_command = r#"python3 -c 'import json,sys
p=json.load(sys.stdin)
print(json.dumps({"tool":"dispatch_agent_work","target_agent_handle":"Ada","say":"Assigning Ada from Voice.","confidence":"high","request_transcript":p.get("current_utterance",{}).get("transcript","voice request")}))
'"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let _ada_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                None,
                None,
                Some("workspace voice".to_owned()),
            )
            .await
            .unwrap();
            let channel_name: String = sqlx::query_scalar("select name from channels where id = $1")
                .bind(session.channel_id)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(channel_name, CALL_SYSTEM_CHANNEL_NAME);

            let result = call_session_submit_text_utterance_in_pool(
                &pool,
                session.id,
                "global voice request".to_owned(),
                None,
                None,
            )
            .await
            .unwrap();
            let source_message_id = result
                .utterance
                .source_message_id
                .expect("call utterance should be backed by an owner message");
            let message_row = sqlx::query(
                "select channel_id, thread_root_id, sender_role, body from messages where id = $1",
            )
            .bind(source_message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(message_row.get::<Uuid, _>("channel_id"), session.channel_id.unwrap());
            assert_eq!(message_row.get::<Option<Uuid>, _>("thread_root_id"), None);
            assert_eq!(message_row.get::<String, _>("sender_role"), "owner");
            assert_eq!(message_row.get::<String, _>("body"), "global voice request");

            let work_row = sqlx::query(
                "select channel_id, thread_root_id, source_message_id from agent_work_items where call_utterance_id = $1",
            )
            .bind(result.utterance.id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(work_row.get::<Option<Uuid>, _>("channel_id"), session.channel_id);
            assert_eq!(
                work_row.get::<Option<Uuid>, _>("thread_root_id"),
                Some(source_message_id)
            );
            assert_eq!(
                work_row.get::<Option<Uuid>, _>("source_message_id"),
                Some(source_message_id)
            );
        })
        .await;
    }

    #[tokio::test]
    async fn legacy_global_call_session_binds_system_channel_on_submit() {
        let coordinator_command = r#"python3 -c 'import json,sys
p=json.load(sys.stdin)
print(json.dumps({"tool":"dispatch_agent_work","target_agent_handle":"Ada","say":"Assigning Ada from legacy Voice.","confidence":"high","request_transcript":p.get("current_utterance",{}).get("transcript","voice request")}))
'"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let _ada_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let session_id: Uuid = sqlx::query_scalar(
                "insert into call_sessions (title, status) values ('legacy voice', 'active') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();

            let result = call_session_submit_text_utterance_in_pool(
                &pool,
                session_id,
                "legacy voice request".to_owned(),
                None,
                None,
            )
            .await
            .unwrap();

            let channel_id = result
                .session
                .channel_id
                .expect("legacy session should be bound to the system channel");
            let channel_name: String = sqlx::query_scalar("select name from channels where id = $1")
                .bind(channel_id)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(channel_name, CALL_SYSTEM_CHANNEL_NAME);
            let source_message_id = result
                .utterance
                .source_message_id
                .expect("legacy utterance should get an owner message");
            let work_row = sqlx::query(
                "select channel_id, thread_root_id, source_message_id from agent_work_items where call_utterance_id = $1",
            )
            .bind(result.utterance.id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(work_row.get::<Option<Uuid>, _>("channel_id"), Some(channel_id));
            assert_eq!(
                work_row.get::<Option<Uuid>, _>("thread_root_id"),
                Some(source_message_id)
            );
            assert_eq!(
                work_row.get::<Option<Uuid>, _>("source_message_id"),
                Some(source_message_id)
            );
        })
        .await;
    }

    #[tokio::test]
    async fn stale_pending_confirmation_does_not_bind_future_yes_after_unrelated_turn() {
        let coordinator_command = r#"payload=$(cat); if printf '%s' "$payload" | grep -Eq '"current_utterance":\{[^}]*"transcript":"maybe send this over there"'; then printf '%s' '{"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"low","say":"I think this is for Ada, but please confirm before I assign it."}'; elif printf '%s' "$payload" | grep -Eq '"current_utterance":\{[^}]*"transcript":"thanks for the update"'; then printf '%s' '{"tool":"speak_to_user","say":"Thanks noted.","confidence":"medium"}'; elif printf '%s' "$payload" | grep -Eq '"current_utterance":\{[^}]*"transcript":"yes send it"'; then printf '%s' '{"tool":"ask_user","say":"coordinator handled stale yes","confidence":"low","error":"stale confirmation should not bind"}'; else printf '%s' '{"tool":"ask_user","say":"unexpected route","confidence":"low","error":"unexpected"}'; fi"#;
        with_command_call_coordinator(coordinator_command, || async {
            let (pool, session, _ada_id, _bob_id, candidate) =
                pending_low_confidence_confirmation_fixture("ai-confirm-stale").await;

            let unrelated = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:thanks for the update".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("thanks.webm".to_owned()),
                    duration_ms: Some(900),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();
            assert_eq!(unrelated.dispatch.ack_text, "Thanks noted.");

            let stale_yes = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:yes send it".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("stale-yes.webm".to_owned()),
                    duration_ms: Some(900),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(stale_yes.dispatch.intent, "clarify");
            assert_eq!(stale_yes.dispatch.ack_text, "coordinator handled stale yes");

            let pending_row: (String, String) =
                sqlx::query_as("select status, ack_text from call_dispatches where id = $1")
                    .bind(candidate.dispatch.id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(pending_row.0, "superseded");
            assert_eq!(
                pending_row.1,
                "Resolved. Confirmation expired after a newer call turn."
            );
            let work_count: i64 = sqlx::query_scalar("select count(*) from agent_work_items")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(work_count, 0);
        })
        .await;
    }

    #[tokio::test]
    async fn submit_coordinator_failure_does_not_silently_rule_dispatch() {
        with_command_call_coordinator("printf 'coordinator unavailable' >&2; exit 2", || async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('ai-failure', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("AI failure".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:please route this by AI".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("ai-failure.webm".to_owned()),
                    duration_ms: Some(2100),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.dispatch.intent, "clarify");
            assert_eq!(result.dispatch.ack_status, "needs_target");
            assert_eq!(result.dispatch.status, "needs_user");
            assert_eq!(result.dispatch.target_agent_id, None);
            assert_eq!(result.dispatch.work_item_id, None);
            assert!(result.dispatch.error.contains("coordinator unavailable"));
            assert_eq!(
                result.ack_text,
                "I heard you, but the call dispatcher is not responding right now. Please try again later."
            );

            let work_count: i64 =
                sqlx::query_scalar("select count(*) from agent_work_items")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(work_count, 0);
            let coordinator_reply: String =
                sqlx::query_scalar("select body from messages where sender_name = 'System Agent'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(coordinator_reply, result.ack_text);
        })
        .await;
    }

    #[tokio::test]
    async fn submit_system_agent_coordinator_sees_prior_call_context() {
        let coordinator_command = r#"payload=$(cat); if printf '%s' "$payload" | grep -q 'second actionable' && printf '%s' "$payload" | grep -q 'prior system ack'; then printf '%s' '{"tool":"dispatch_agent_work","target_agent_handle":"Ada","confidence":"high","say":"I am continuing the call and assigning Ada."}'; elif printf '%s' "$payload" | grep -q 'first context check'; then printf '%s' '{"tool":"speak_to_user","confidence":"medium","say":"prior system ack"}'; else printf '%s' '{"tool":"ask_user","say":"I need prior context.","confidence":"low","error":"prior context missing"}'; fi"#;
        with_command_call_coordinator(coordinator_command, || async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('ai-context', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("AI context".to_owned()),
            )
            .await
            .unwrap();

            let first = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:first context check".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("first-context.webm".to_owned()),
                    duration_ms: Some(1200),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();
            assert_eq!(first.dispatch.intent, "ack_only");
            assert_eq!(first.ack_text, "prior system ack");

            let second = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:second actionable follow-up".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("second-context.webm".to_owned()),
                    duration_ms: Some(1800),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(second.dispatch.intent, "agent_work");
            assert_eq!(second.dispatch.target_agent_id, Some(agent_id));
            assert_eq!(
                second.ack_text,
                "I am continuing the call and assigning Ada."
            );

            let messages: Vec<String> =
                sqlx::query_scalar("select body from messages where sender_name = 'System Agent' order by created_at asc")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                messages,
                vec![
                    "prior system ack".to_owned(),
                    "I am continuing the call and assigning Ada.".to_owned()
                ]
            );
        })
        .await;
    }

    #[tokio::test]
    async fn submit_simple_presence_check_is_answered_without_agent_work() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('smoke-agent', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('call-smoke', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Presence check".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: "LANTOR_TRANSCRIPT:有人在吗？".as_bytes().to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("presence-check.webm".to_owned()),
                    duration_ms: Some(1100),
                    language: Some("zh-CN".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.dispatch.intent, "ack_only");
            assert_eq!(result.dispatch.ack_status, "heard");
            assert_eq!(result.dispatch.status, "acknowledged");
            assert_eq!(result.dispatch.ack_text, "我在，继续说。");
            assert_eq!(result.dispatch.target_agent_id, None);
            assert_eq!(result.dispatch.work_item_id, None);

            let work_item_count: i64 =
                sqlx::query_scalar("select count(*) from agent_work_items")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(work_item_count, 0);

            let coordinator_reply: String =
                sqlx::query_scalar("select body from messages where sender_name = 'System Agent'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(coordinator_reply, "我在，继续说。");
        })
        .await;
    }

    #[tokio::test]
    async fn submit_low_value_mute_final_fragment_is_recorded_without_needs_target_work() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let session = call_session_start_in_pool(
                &pool,
                None,
                None,
                Some("Mute trailing fragment".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:Common".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("mute-final.webm".to_owned()),
                    duration_ms: Some(450),
                    language: Some("en".to_owned()),
                    final_fragment_reason: Some("mute".to_owned()),
                },
            )
            .await
            .unwrap();

            assert_eq!(result.utterance.status, "ignored");
            assert_eq!(result.utterance.transcript, "Common");
            assert_eq!(result.dispatch.intent, "ack_only");
            assert_eq!(result.dispatch.ack_status, "heard");
            assert_eq!(result.dispatch.status, "ignored");
            assert_eq!(result.dispatch.outcome, "ignored");
            assert_eq!(result.dispatch.status_text, "Ignored.");
            assert_eq!(result.dispatch.work_item_id, None);
            assert_eq!(result.dispatch.long_task_id, None);
            assert!(result.dispatch.error.contains("low_value_final_fragment:mute"));

            let work_link_count: i64 = sqlx::query_scalar(
                "select count(*) from call_dispatches where session_id = $1 and work_item_id is not null",
            )
            .bind(session.id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(work_link_count, 0);
        })
        .await;
    }

    #[tokio::test]
    async fn submit_low_value_mute_final_fragment_does_not_fall_back_to_dm_target() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let dm_agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind, dm_agent_id) values ('Ada', 'dm', $1) returning id",
            )
            .bind(dm_agent_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("DM mute trailing fragment".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: b"LANTOR_TRANSCRIPT:Common".to_vec(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("dm-mute-final.webm".to_owned()),
                    duration_ms: Some(450),
                    language: Some("en".to_owned()),
                    final_fragment_reason: Some("mute".to_owned()),
                },
            )
            .await
            .unwrap();

            assert_eq!(result.utterance.status, "ignored");
            assert_eq!(result.dispatch.intent, "ack_only");
            assert_eq!(result.dispatch.ack_status, "heard");
            assert_eq!(result.dispatch.status, "ignored");
            assert_eq!(result.dispatch.target_agent_id, None);
            assert_eq!(result.dispatch.work_item_id, None);
            assert!(result.dispatch.error.contains("low_value_final_fragment:mute"));

            let work_item_count: i64 =
                sqlx::query_scalar("select count(*) from agent_work_items")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(work_item_count, 0);
        })
        .await;
    }

    #[tokio::test]
    async fn truncated_spoken_request_payload_retrieves_full_persisted_utterance() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('oversized-dispatch', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Oversized dispatch".to_owned()),
            )
            .await
            .unwrap();

            let omitted_marker = "middle-detail-only-in-persisted-utterance";
            let transcript = format!(
                "@Ada {} {omitted_marker} {}",
                "front context ".repeat(3000),
                "tail context ".repeat(3000)
            );
            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: format!("LANTOR_TRANSCRIPT:{transcript}").into_bytes(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("oversized-targeted.webm".to_owned()),
                    duration_ms: Some(4200),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();
            let linked_dispatch = wait_for_dispatch_work_link(&pool, result.dispatch.id).await;
            let work_item_id = linked_dispatch.work_item_id.expect("work item");
            let work_context: String =
                sqlx::query_scalar("select context from agent_work_items where id = $1")
                    .bind(work_item_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let payload = spoken_request_payload_from_context(&work_context);

            assert_eq!(
                payload.get("truncated").and_then(|value| value.as_bool()),
                Some(true)
            );
            let inline_text = payload.get("text").and_then(|value| value.as_str()).unwrap();
            assert!(!inline_text.contains(omitted_marker));
            assert_eq!(
                payload
                    .get("original_sha256")
                    .and_then(|value| value.as_str()),
                Some(format!("{:x}", Sha256::digest(result.utterance.transcript.as_bytes())).as_str())
            );

            let retrieval_ref = payload.get("retrieval_ref").expect("retrieval ref");
            assert_eq!(
                retrieval_ref
                    .get("call_session_id")
                    .and_then(|value| value.as_str()),
                Some(session.id).map(|id| id.to_string()).as_deref()
            );
            assert_eq!(
                retrieval_ref
                    .get("call_utterance_id")
                    .and_then(|value| value.as_str()),
                Some(result.utterance.id)
                    .map(|id| id.to_string())
                    .as_deref()
            );
            assert_eq!(
                retrieval_ref
                    .get("call_dispatch_id")
                    .and_then(|value| value.as_str()),
                Some(result.dispatch.id).map(|id| id.to_string()).as_deref()
            );
            assert_eq!(
                retrieval_ref
                    .get("context_tool_command")
                    .and_then(|value| value.as_str()),
                Some(format!(
                    "$LANTOR_CONTEXT_TOOL --agent-context-tool call-utterance-read --utterance-id {}",
                    result.utterance.id
                ))
                .as_deref()
            );

            let retrieved = crate::context_tool::agent_context_call_utterance_read_in_pool(
                &pool,
                &[
                    "call-utterance-read".to_owned(),
                    "--utterance-id".to_owned(),
                    result.utterance.id.to_string(),
                ],
            )
            .await
            .unwrap();
            assert!(retrieved.contains(&format!("session_id={}", session.id)));
            assert!(retrieved.contains(&format!("dispatch_id={}", result.dispatch.id)));
            assert!(retrieved.contains(&format!(
                "transcript_char_length={}",
                result.utterance.transcript.chars().count()
            )));
            assert!(retrieved.contains(omitted_marker));
            assert!(retrieved.ends_with(&result.utterance.transcript));
        })
        .await;
    }

    #[test]
    fn spoken_request_payload_bounds_oversized_transcripts() {
        let transcript = format!(
            "start-call {} preserve-tail",
            "quoted \"context\" with newline\n".repeat(2000)
        );

        let session_id = Uuid::new_v4();
        let utterance_id = Uuid::new_v4();
        let dispatch_id = Uuid::new_v4();
        let payload_json = call_spoken_request_payload_json(
            &transcript,
            Some(CallSpokenRequestRetrievalRef {
                source: "call_utterances.transcript",
                call_session_id: session_id,
                call_utterance_id: utterance_id,
                call_dispatch_id: dispatch_id,
                turn_handle: "call-turn-7".to_owned(),
                context_tool_command: format!(
                    "$LANTOR_CONTEXT_TOOL --agent-context-tool call-utterance-read --utterance-id {utterance_id}"
                ),
            }),
        );
        assert!(payload_json.chars().count() <= CALL_WORK_SPOKEN_REQUEST_PAYLOAD_BUDGET);

        let payload: serde_json::Value = serde_json::from_str(&payload_json).unwrap();
        assert_eq!(
            payload.get("schema").and_then(|value| value.as_str()),
            Some("lantor.call.spoken_request.v1")
        );
        assert_eq!(
            payload.get("truncated").and_then(|value| value.as_bool()),
            Some(true)
        );
        let retrieval_ref = payload
            .get("retrieval_ref")
            .expect("truncated payload retrieval ref");
        assert_eq!(
            retrieval_ref.get("source").and_then(|value| value.as_str()),
            Some("call_utterances.transcript")
        );
        assert_eq!(
            retrieval_ref
                .get("call_session_id")
                .and_then(|value| value.as_str()),
            Some(session_id).map(|id| id.to_string()).as_deref()
        );
        assert_eq!(
            retrieval_ref
                .get("call_utterance_id")
                .and_then(|value| value.as_str()),
            Some(utterance_id).map(|id| id.to_string()).as_deref()
        );
        assert_eq!(
            retrieval_ref
                .get("call_dispatch_id")
                .and_then(|value| value.as_str()),
            Some(dispatch_id).map(|id| id.to_string()).as_deref()
        );
        assert_eq!(
            retrieval_ref
                .get("turn_handle")
                .and_then(|value| value.as_str()),
            Some("call-turn-7")
        );
        assert_eq!(
            retrieval_ref
                .get("context_tool_command")
                .and_then(|value| value.as_str()),
            Some(format!(
                "$LANTOR_CONTEXT_TOOL --agent-context-tool call-utterance-read --utterance-id {utterance_id}"
            ))
            .as_deref()
        );
        assert_eq!(
            payload
                .get("original_char_length")
                .and_then(|value| value.as_u64()),
            Some(transcript.chars().count() as u64)
        );
        assert_eq!(
            payload
                .get("original_byte_length")
                .and_then(|value| value.as_u64()),
            Some(transcript.len() as u64)
        );
        assert_eq!(
            payload
                .get("original_sha256")
                .and_then(|value| value.as_str()),
            Some(format!("{:x}", Sha256::digest(transcript.as_bytes())).as_str())
        );
        let text = payload
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap();
        assert!(text.starts_with("start-call"));
        assert!(text.ends_with("preserve-tail"));
        assert!(text.contains("Lantor omitted"));
    }

    #[tokio::test]
    async fn submit_targeted_marker_audio_returns_ack_then_records_async_enqueue_failure() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('dispatch-failure', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Dispatch failure".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: format!(
                        "LANTOR_TRANSCRIPT:@Ada prepare the launch checklist {TEST_ASYNC_ENQUEUE_FAILURE_MARKER}"
                    )
                    .into_bytes(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("targeted-fail.webm".to_owned()),
                    duration_ms: Some(2100),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.dispatch.intent, "agent_work");
            assert_eq!(result.dispatch.ack_status, "understood");
            assert_eq!(result.dispatch.status, "acknowledged");
            assert_eq!(result.dispatch.target_agent_id, Some(agent_id));
            assert_eq!(result.dispatch.work_item_id, None);
            assert_eq!(result.work_item_id, None);
            assert_eq!(result.ack_text, "Got it. I assigned this to @Ada.");

            let failed_dispatch = wait_for_dispatch_work_link(&pool, result.dispatch.id).await;
            assert_eq!(failed_dispatch.status, "failed");
            assert_eq!(failed_dispatch.work_item_id, None);
            assert!(failed_dispatch
                .error
                .contains("test async enqueue failure after ack"));

            let work_item_count: i64 =
                sqlx::query_scalar("select count(*) from agent_work_items where agent_id = $1")
                    .bind(agent_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(work_item_count, 0);

            let events = ui_event_values(&pool).await;
            let ack_index = events
                .iter()
                .position(|event| {
                    ui_event_reason(event) == Some("call_dispatch_acknowledged")
                        && ui_event_dispatch_id(event) == Some(result.dispatch.id)
                })
                .expect("dispatch ack event");
            let failed_index = events
                .iter()
                .position(|event| {
                    ui_event_reason(event) == Some("call_dispatch_failed")
                        && ui_event_dispatch_id(event) == Some(result.dispatch.id)
                })
                .expect("dispatch failed event");
            assert!(
                ack_index < failed_index,
                "call ack must be emitted before async failure: {events:?}"
            );

            let failed_event = &events[failed_index];
            let failed_event_dispatch = failed_event.get("dispatch").unwrap();
            assert_eq!(
                failed_event_dispatch
                    .get("status")
                    .and_then(|status| status.as_str()),
                Some("failed")
            );
            assert!(failed_event_dispatch
                .get("error")
                .and_then(|error| error.as_str())
                .unwrap()
                .contains("test async enqueue failure after ack"));
        })
        .await;
    }

    #[tokio::test]
    async fn submit_targeted_marker_audio_returns_ack_then_rejects_drifted_work_link() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('dispatch-link-drift', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Dispatch link drift".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: format!(
                        "LANTOR_TRANSCRIPT:@Ada prepare the launch checklist {TEST_LINK_DRIFT_MARKER}"
                    )
                    .into_bytes(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("targeted-drift.webm".to_owned()),
                    duration_ms: Some(2100),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.dispatch.intent, "agent_work");
            assert_eq!(result.dispatch.ack_status, "understood");
            assert_eq!(result.dispatch.status, "acknowledged");
            assert_eq!(result.dispatch.work_item_id, None);
            assert_eq!(result.work_item_id, None);
            assert_eq!(result.ack_text, "Got it. I assigned this to @Ada.");

            let compensated_dispatch = wait_for_dispatch_work_link(&pool, result.dispatch.id).await;
            assert_eq!(compensated_dispatch.status, "compensated");
            assert_eq!(compensated_dispatch.outcome, "work_link_compensated");
            assert_eq!(
                compensated_dispatch.status_text,
                "Work creation was rolled back after the call link failed."
            );
            assert_eq!(compensated_dispatch.work_item_id, None);
            assert!(compensated_dispatch.compensated_work_item_id.is_some());
            assert!(compensated_dispatch
                .error
                .contains("agent work item is not correlated to the call dispatch"));
            assert!(compensated_dispatch
                .error
                .contains("cancelled unlinked work item"));

            let work_row = sqlx::query(
                r#"
                select id, status, call_session_id, call_utterance_id, call_dispatch_id
                from agent_work_items
                where agent_id = $1
                "#,
            )
            .bind(agent_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(work_row.get::<Uuid, _>("call_session_id"), session.id);
            assert_eq!(
                work_row.get::<Uuid, _>("call_utterance_id"),
                result.utterance.id
            );
            assert_ne!(
                work_row.get::<Uuid, _>("call_dispatch_id"),
                result.dispatch.id
            );
            assert_eq!(work_row.get::<String, _>("status"), "cancelled");
            assert_eq!(
                compensated_dispatch.compensated_work_item_id,
                Some(work_row.get::<Uuid, _>("id"))
            );
            assert!(compensated_dispatch
                .correlation_trail
                .contains(&format!("compensated_work_item:{}", work_row.get::<Uuid, _>("id"))));

            let linked_count: i64 = sqlx::query_scalar(
                "select count(*) from call_dispatches where id = $1 and work_item_id = $2",
            )
            .bind(result.dispatch.id)
            .bind(work_row.get::<Uuid, _>("id"))
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(linked_count, 0);

            let supervisor_command = sqlx::query(
                "select status, error from supervisor_commands where work_item_id = $1",
            )
            .bind(work_row.get::<Uuid, _>("id"))
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(supervisor_command.get::<String, _>("status"), "done");
            assert_eq!(supervisor_command.get::<String, _>("error"), "cancelled");

            let events = ui_event_values(&pool).await;
            let ack_index = events
                .iter()
                .position(|event| {
                    ui_event_reason(event) == Some("call_dispatch_acknowledged")
                        && ui_event_dispatch_id(event) == Some(result.dispatch.id)
                })
                .expect("dispatch ack event");
            let work_created_index = events
                .iter()
                .position(|event| ui_event_reason(event) == Some("work_item_created"))
                .expect("work item event");
            let failed_index = events
                .iter()
                .position(|event| {
                    ui_event_reason(event) == Some("call_dispatch_work_compensated")
                        && ui_event_dispatch_id(event) == Some(result.dispatch.id)
                })
                .expect("dispatch compensation event");
            assert!(
                ack_index < work_created_index,
                "call ack must be emitted before work item creation: {events:?}"
            );
            assert!(
                work_created_index < failed_index,
                "drift compensation must be reported after the work item exists: {events:?}"
            );
            assert!(
                events
                    .iter()
                    .all(|event| ui_event_reason(event) != Some("call_dispatch_work_linked")
                        || ui_event_dispatch_id(event) != Some(result.dispatch.id)),
                "drifted work item must not emit a linked dispatch event: {events:?}"
            );
        })
        .await;
    }

    #[tokio::test]
    async fn submit_targeted_marker_audio_reports_started_drift_as_failed_compensation() {
        with_deterministic_transcription_provider(|| async {
            let pool = test_pool().await;
            let agent_id: Uuid = sqlx::query_scalar(
                "insert into agents (handle, status, runtime) values ('Ada', 'idle', 'codex') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let channel_id: Uuid = sqlx::query_scalar(
                "insert into channels (name, kind) values ('started-dispatch-link-drift', 'channel') returning id",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("insert into channel_members (channel_id, agent_id) values ($1, $2)")
                .bind(channel_id)
                .bind(agent_id)
                .execute(&pool)
                .await
                .unwrap();
            let session = call_session_start_in_pool(
                &pool,
                Some(channel_id),
                None,
                Some("Started dispatch link drift".to_owned()),
            )
            .await
            .unwrap();

            let result = call_session_submit_utterance_in_pool(
                &pool,
                CallUtteranceSubmitRequest {
                    session_id: session.id,
                    bytes: format!(
                        "LANTOR_TRANSCRIPT:@Ada prepare the launch checklist {TEST_STARTED_LINK_DRIFT_MARKER}"
                    )
                    .into_bytes(),
                    mime_type: "audio/webm".to_owned(),
                    original_name: Some("targeted-started-drift.webm".to_owned()),
                    duration_ms: Some(2100),
                    language: Some("en".to_owned()),
                    final_fragment_reason: None,
                },
            )
            .await
            .unwrap();

            assert_eq!(result.dispatch.intent, "agent_work");
            assert_eq!(result.dispatch.status, "acknowledged");
            assert_eq!(result.dispatch.target_agent_id, Some(agent_id));
            assert_eq!(result.dispatch.work_item_id, None);
            assert_eq!(result.work_item_id, None);

            let failed_dispatch = wait_for_dispatch_work_link(&pool, result.dispatch.id).await;
            assert_eq!(failed_dispatch.status, "failed");
            assert_eq!(failed_dispatch.outcome, "work_link_compensation_failed");
            assert_eq!(
                failed_dispatch.status_text,
                "Work link failed and automatic rollback did not complete."
            );
            assert_eq!(failed_dispatch.work_item_id, None);
            assert!(failed_dispatch.compensated_work_item_id.is_some());
            assert!(failed_dispatch
                .error
                .contains("agent work item is not correlated to the call dispatch"));
            assert!(failed_dispatch
                .error
                .contains("cancellation requested for already-started unlinked work item"));
            assert!(failed_dispatch
                .error
                .contains("may continue until the worker stops"));

            let work_item_id = failed_dispatch.compensated_work_item_id.unwrap();
            let work_row = sqlx::query(
                r#"
                select status, run_id, call_session_id, call_utterance_id, call_dispatch_id
                from agent_work_items
                where id = $1
                "#,
            )
            .bind(work_item_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(work_row.get::<String, _>("status"), "cancelling");
            assert!(work_row.get::<Option<Uuid>, _>("run_id").is_some());
            assert_eq!(work_row.get::<Uuid, _>("call_session_id"), session.id);
            assert_eq!(
                work_row.get::<Uuid, _>("call_utterance_id"),
                result.utterance.id
            );
            assert_ne!(
                work_row.get::<Uuid, _>("call_dispatch_id"),
                result.dispatch.id
            );
            assert!(failed_dispatch
                .correlation_trail
                .contains(&format!("compensated_work_item:{work_item_id}")));

            let stop_command_count: i64 = sqlx::query_scalar(
                "select count(*) from supervisor_commands where command_type = 'stop_run' and work_item_id = $1 and status = 'pending'",
            )
            .bind(work_item_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(stop_command_count, 1);

            let events = ui_event_values(&pool).await;
            let ack_index = events
                .iter()
                .position(|event| {
                    ui_event_reason(event) == Some("call_dispatch_acknowledged")
                        && ui_event_dispatch_id(event) == Some(result.dispatch.id)
                })
                .expect("dispatch ack event");
            let failed_index = events
                .iter()
                .position(|event| {
                    ui_event_reason(event) == Some("call_dispatch_failed")
                        && ui_event_dispatch_id(event) == Some(result.dispatch.id)
                })
                .expect("dispatch failed compensation event");
            assert!(
                ack_index < failed_index,
                "call ack must be emitted before started-work compensation failure: {events:?}"
            );
            assert!(
                events
                    .iter()
                    .all(|event| ui_event_reason(event) != Some("call_dispatch_work_compensated")
                        || ui_event_dispatch_id(event) != Some(result.dispatch.id)),
                "started drift must not claim completed compensation: {events:?}"
            );
        })
        .await;
    }

    #[tokio::test]
    async fn bootstrap_loaders_keep_all_call_rows_in_chronological_order() {
        let pool = test_pool().await;
        let session = call_session_start_in_pool(&pool, None, None, Some("Long call".to_owned()))
            .await
            .unwrap();

        for sequence in 1..=405 {
            let timestamp = format!(
                "2026-01-01T00:{:02}:{:02}.000+00:00",
                sequence / 60,
                sequence % 60
            );
            let utterance_id = Uuid::new_v4();
            let dispatch_id = Uuid::new_v4();

            sqlx::query(
                r#"
                insert into call_utterances (
                    id, session_id, sequence, transcript, transcription_provider,
                    audio_mime_type, status, created_at, updated_at
                )
                values ($1, $2, $3, $4, 'deterministic', 'audio/webm', 'dispatched', $5, $5)
                "#,
            )
            .bind(utterance_id)
            .bind(session.id)
            .bind(sequence)
            .bind(format!("utterance {sequence}"))
            .bind(&timestamp)
            .execute(&pool)
            .await
            .unwrap();

            sqlx::query(
                r#"
                insert into call_dispatches (
                    id, session_id, utterance_id, intent, ack_status, ack_text,
                    confidence, status, created_at, updated_at
                )
                values ($1, $2, $3, 'ack_only', 'heard', $4, 'medium', 'acknowledged', $5, $5)
                "#,
            )
            .bind(dispatch_id)
            .bind(session.id)
            .bind(utterance_id)
            .bind(format!("ack {sequence}"))
            .bind(&timestamp)
            .execute(&pool)
            .await
            .unwrap();
        }

        let utterances = load_call_utterances(&pool).await.unwrap();
        let dispatches = load_call_dispatches(&pool).await.unwrap();

        assert_eq!(utterances.len(), 405);
        assert_eq!(utterances.first().unwrap().sequence, 1);
        assert_eq!(utterances.last().unwrap().sequence, 405);
        assert_eq!(utterances.first().unwrap().transcript, "utterance 1");
        assert_eq!(utterances.last().unwrap().transcript, "utterance 405");

        assert_eq!(dispatches.len(), CALL_BOOTSTRAP_DISPATCH_LIMIT as usize);
        assert_eq!(dispatches.first().unwrap().ack_text, "ack 246");
        assert_eq!(dispatches.last().unwrap().ack_text, "ack 405");

        let page = fetch_call_history_page(
            &pool,
            DateTime::parse_from_rfc3339("2026-01-01T00:04:06.000+00:00")
                .unwrap()
                .with_timezone(&Utc),
            Some(5),
        )
        .await
        .unwrap();
        assert_eq!(page.utterances.len(), 5);
        assert_eq!(page.utterances.first().unwrap().sequence, 241);
        assert_eq!(page.utterances.last().unwrap().sequence, 245);
        assert_eq!(page.dispatches.len(), 5);
        assert_eq!(page.dispatches.first().unwrap().ack_text, "ack 241");
        assert_eq!(page.dispatches.last().unwrap().ack_text, "ack 245");
    }
}
