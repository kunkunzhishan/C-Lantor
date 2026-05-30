use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    models::{
        Agent, AgentActivity, AgentRunPatch, AgentWorkItemPatch, Artifact, CallDispatch,
        CallSession, CallUtterance, Message,
    },
    CommandResult, SUPERVISOR_WAKE_CHANNEL, UI_REFRESH_CHANNEL,
};

const UI_EVENTS_RETAIN_COUNT: i64 = 10_000;
const UI_EVENTS_PRUNE_INTERVAL: i64 = 500;

pub(crate) async fn notify_database_event(
    pool: &SqlitePool,
    channel: &str,
    payload: &str,
) -> CommandResult<()> {
    if channel != UI_REFRESH_CHANNEL {
        return Ok(());
    }
    let result = sqlx::query("insert into ui_events (event_json) values ($1)")
        .bind(payload)
        .execute(pool)
        .await
        .map_err(|err| err.to_string())?;
    let event_id = result.last_insert_rowid();
    if event_id > UI_EVENTS_RETAIN_COUNT && event_id % UI_EVENTS_PRUNE_INTERVAL == 0 {
        let cutoff = event_id - UI_EVENTS_RETAIN_COUNT;
        sqlx::query("delete from ui_events where id < $1")
            .bind(cutoff)
            .execute(pool)
            .await
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

#[derive(Debug)]
struct PendingMessageDelta {
    message_id: String,
    value: Value,
    raw: String,
    merged: bool,
}

impl PendingMessageDelta {
    fn into_payload(self) -> String {
        if self.merged {
            self.value.to_string()
        } else {
            self.raw
        }
    }
}

fn message_delta_id(value: &Value) -> Option<&str> {
    if value.get("type").and_then(Value::as_str) != Some("message_delta") {
        return None;
    }
    value.get("message_id").and_then(Value::as_str)
}

fn merge_message_delta(target: &mut Value, current: &Value) {
    let next_append = current.get("append").and_then(Value::as_str).unwrap_or("");
    let combined_append = format!(
        "{}{}",
        target.get("append").and_then(Value::as_str).unwrap_or(""),
        next_append
    );
    if let Some(target_object) = target.as_object_mut() {
        target_object.insert("append".to_owned(), Value::String(combined_append));
        for field in ["delivery_state", "reason"] {
            if let Some(value) = current.get(field) {
                target_object.insert(field.to_owned(), value.clone());
            }
        }
    }
}

fn coalesce_ui_event_payloads(payloads: Vec<String>) -> Vec<String> {
    let mut coalesced = Vec::with_capacity(payloads.len());
    let mut pending_delta: Option<PendingMessageDelta> = None;

    for payload in payloads {
        let parsed = serde_json::from_str::<Value>(&payload);
        let Ok(value) = parsed else {
            if let Some(delta) = pending_delta.take() {
                coalesced.push(delta.into_payload());
            }
            coalesced.push(payload);
            continue;
        };

        let Some(message_id) = message_delta_id(&value).map(str::to_owned) else {
            if let Some(delta) = pending_delta.take() {
                coalesced.push(delta.into_payload());
            }
            coalesced.push(payload);
            continue;
        };

        if let Some(delta) = pending_delta.as_mut() {
            if delta.message_id == message_id {
                merge_message_delta(&mut delta.value, &value);
                delta.merged = true;
                continue;
            }
            if let Some(delta) = pending_delta.take() {
                coalesced.push(delta.into_payload());
            }
        }

        pending_delta = Some(PendingMessageDelta {
            message_id,
            value,
            raw: payload,
            merged: false,
        });
    }

    if let Some(delta) = pending_delta {
        coalesced.push(delta.into_payload());
    }

    coalesced
}

pub(crate) fn ui_backend_event_payload(payloads: Vec<String>) -> Option<String> {
    let mut payloads = coalesce_ui_event_payloads(payloads);
    match payloads.len() {
        0 => None,
        1 => payloads.pop(),
        _ => Some(json!({ "type": "batch", "events": payloads }).to_string()),
    }
}

pub(crate) async fn notify_ui_refresh(pool: &SqlitePool, reason: &str) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "refresh", "reason": reason }).to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_message_upsert(
    pool: &SqlitePool,
    message: &Message,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "message_upsert", "reason": reason, "message": message }).to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_message_delta(
    pool: &SqlitePool,
    message_id: Uuid,
    append: &str,
    delivery_state: &str,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({
            "type": "message_delta",
            "reason": reason,
            "message_id": message_id,
            "append": append,
            "delivery_state": delivery_state
        })
        .to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_message_delete(
    pool: &SqlitePool,
    message_id: Uuid,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "message_delete", "reason": reason, "message_id": message_id })
            .to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_activity_upsert(
    pool: &SqlitePool,
    activity: &AgentActivity,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "activity_upsert", "reason": reason, "activity": activity }).to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_agent_upsert(
    pool: &SqlitePool,
    agent: &Agent,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "agent_upsert", "reason": reason, "agent": agent }).to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_agent_run_upsert(
    pool: &SqlitePool,
    run: &AgentRunPatch,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "agent_run_upsert", "reason": reason, "run": run }).to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_work_item_upsert(
    pool: &SqlitePool,
    work_item: &AgentWorkItemPatch,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "work_item_upsert", "reason": reason, "work_item": work_item })
            .to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_call_session_upsert(
    pool: &SqlitePool,
    session: &CallSession,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "call_session_upsert", "reason": reason, "session": session }).to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_call_utterance_upsert(
    pool: &SqlitePool,
    utterance: &CallUtterance,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "call_utterance_upsert", "reason": reason, "utterance": utterance })
            .to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_call_dispatch_upsert(
    pool: &SqlitePool,
    dispatch: &CallDispatch,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "call_dispatch_upsert", "reason": reason, "dispatch": dispatch })
            .to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_artifact_upsert(
    pool: &SqlitePool,
    artifact: &Artifact,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "artifact_upsert", "reason": reason, "artifact": artifact }).to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_tool_browser_open(
    pool: &SqlitePool,
    target: &str,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "tool_browser_open", "reason": reason, "target": target }).to_string(),
    )
    .await
}

pub(crate) async fn notify_supervisor_wake(pool: &SqlitePool) -> CommandResult<()> {
    notify_database_event(pool, SUPERVISOR_WAKE_CHANNEL, "wake").await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_backend_event_payload_preserves_single_event() {
        assert_eq!(
            ui_backend_event_payload(vec![r#"{"type":"refresh","reason":"stream"}"#.to_owned()]),
            Some(r#"{"type":"refresh","reason":"stream"}"#.to_owned())
        );
    }

    #[test]
    fn ui_backend_event_payload_batches_multiple_events_in_order() {
        let payload = ui_backend_event_payload(vec![
            r#"{"type":"message_delta","message_id":"one"}"#.to_owned(),
            r#"{"type":"activity_upsert","activity":{"id":"two"}}"#.to_owned(),
        ])
        .expect("multiple events should produce a payload");
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();

        assert_eq!(
            value.get("type").and_then(serde_json::Value::as_str),
            Some("batch")
        );
        assert_eq!(
            value
                .get("events")
                .and_then(serde_json::Value::as_array)
                .unwrap()
                .iter()
                .map(serde_json::Value::as_str)
                .collect::<Option<Vec<_>>>()
                .unwrap(),
            vec![
                r#"{"type":"message_delta","message_id":"one"}"#,
                r#"{"type":"activity_upsert","activity":{"id":"two"}}"#,
            ]
        );
    }

    #[test]
    fn ui_backend_event_payload_coalesces_adjacent_message_deltas() {
        let payload = ui_backend_event_payload(vec![
            r#"{"type":"message_delta","reason":"stream_delta","message_id":"one","append":"hel","delivery_state":"streaming"}"#.to_owned(),
            r#"{"type":"message_delta","reason":"stream_delta","message_id":"one","append":"lo","delivery_state":"complete"}"#.to_owned(),
        ])
        .expect("coalesced deltas should produce a payload");
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();

        assert_eq!(
            value.get("type").and_then(serde_json::Value::as_str),
            Some("message_delta")
        );
        assert_eq!(
            value.get("message_id").and_then(serde_json::Value::as_str),
            Some("one")
        );
        assert_eq!(
            value.get("append").and_then(serde_json::Value::as_str),
            Some("hello")
        );
        assert_eq!(
            value
                .get("delivery_state")
                .and_then(serde_json::Value::as_str),
            Some("complete")
        );
    }
}
