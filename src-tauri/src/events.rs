use std::time::Duration;

use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use tokio::time::sleep;
use uuid::Uuid;

use crate::{
    models::{
        Agent, AgentActivity, AgentRunPatch, AgentWorkItemPatch, Artifact, CallDispatch,
        CallSession, CallUtterance, Channel, ChannelMember, Message,
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

#[derive(Debug)]
struct PendingUpsert {
    key: String,
    value: Value,
    raw: String,
    merged: bool,
}

impl PendingUpsert {
    fn into_payload(self) -> String {
        if self.merged {
            self.value.to_string()
        } else {
            self.raw
        }
    }
}

#[derive(Debug)]
enum PendingUiEvent {
    MessageDelta(PendingMessageDelta),
    Upsert(PendingUpsert),
}

impl PendingUiEvent {
    fn into_payload(self) -> String {
        match self {
            PendingUiEvent::MessageDelta(delta) => delta.into_payload(),
            PendingUiEvent::Upsert(upsert) => upsert.into_payload(),
        }
    }
}

fn message_delta_id(value: &Value) -> Option<&str> {
    if value.get("type").and_then(Value::as_str) != Some("message_delta") {
        return None;
    }
    value.get("message_id").and_then(Value::as_str)
}

fn coalescible_upsert_key(value: &Value) -> Option<String> {
    match value.get("type").and_then(Value::as_str)? {
        "activity_upsert" => value
            .pointer("/activity/id")
            .and_then(Value::as_str)
            .map(|id| format!("activity:{id}")),
        "agent_run_upsert" => value
            .pointer("/run/id")
            .and_then(Value::as_str)
            .map(|id| format!("agent_run:{id}")),
        _ => None,
    }
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

fn merge_agent_run_upsert(target: &mut Value, current: &Value) {
    let Some(current_run) = current.get("run").and_then(Value::as_object) else {
        *target = current.clone();
        return;
    };
    let Some(target_object) = target.as_object_mut() else {
        *target = current.clone();
        return;
    };
    if let Some(value) = current.get("reason") {
        target_object.insert("reason".to_owned(), value.clone());
    }
    let Some(target_run) = target_object.get_mut("run").and_then(Value::as_object_mut) else {
        *target = current.clone();
        return;
    };
    for (field, value) in current_run {
        target_run.insert(field.clone(), value.clone());
    }
}

fn merge_coalescible_upsert(target: &mut Value, current: &Value) {
    match current.get("type").and_then(Value::as_str) {
        Some("agent_run_upsert") => merge_agent_run_upsert(target, current),
        Some("activity_upsert") => *target = current.clone(),
        _ => {}
    }
}

fn coalesce_ui_event_payloads(payloads: Vec<String>) -> Vec<String> {
    let mut coalesced = Vec::with_capacity(payloads.len());
    let mut pending_event: Option<PendingUiEvent> = None;

    fn flush_pending(coalesced: &mut Vec<String>, pending_event: &mut Option<PendingUiEvent>) {
        if let Some(event) = pending_event.take() {
            coalesced.push(event.into_payload());
        }
    }

    for payload in payloads {
        let parsed = serde_json::from_str::<Value>(&payload);
        let Ok(value) = parsed else {
            flush_pending(&mut coalesced, &mut pending_event);
            coalesced.push(payload);
            continue;
        };

        if let Some(message_id) = message_delta_id(&value).map(str::to_owned) {
            if let Some(PendingUiEvent::MessageDelta(delta)) = pending_event.as_mut() {
                if delta.message_id == message_id {
                    merge_message_delta(&mut delta.value, &value);
                    delta.merged = true;
                    continue;
                }
            }
            flush_pending(&mut coalesced, &mut pending_event);
            pending_event = Some(PendingUiEvent::MessageDelta(PendingMessageDelta {
                message_id,
                value,
                raw: payload,
                merged: false,
            }));
            continue;
        }

        if let Some(key) = coalescible_upsert_key(&value) {
            if let Some(PendingUiEvent::Upsert(upsert)) = pending_event.as_mut() {
                if upsert.key == key {
                    merge_coalescible_upsert(&mut upsert.value, &value);
                    upsert.merged = true;
                    continue;
                }
            }
            flush_pending(&mut coalesced, &mut pending_event);
            pending_event = Some(PendingUiEvent::Upsert(PendingUpsert {
                key,
                value,
                raw: payload,
                merged: false,
            }));
            continue;
        }

        flush_pending(&mut coalesced, &mut pending_event);
        coalesced.push(payload);
    }

    flush_pending(&mut coalesced, &mut pending_event);

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

pub(crate) async fn load_ui_backend_event_payload(
    pool: &SqlitePool,
    last_id: &mut i64,
    limit: i64,
    coalesce_window: Duration,
) -> CommandResult<Option<String>> {
    let rows = sqlx::query(
        r#"
        select id, event_json
        from ui_events
        where id > $1
        order by id asc
        limit $2
        "#,
    )
    .bind(*last_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())?;

    if rows.is_empty() {
        return Ok(None);
    }

    let mut payloads = Vec::with_capacity(rows.len());
    for row in rows {
        *last_id = row.get("id");
        payloads.push(row.get::<String, _>("event_json"));
    }

    if coalesce_window > Duration::ZERO && (payloads.len() as i64) < limit {
        sleep(coalesce_window).await;
        let remaining_limit = limit - payloads.len() as i64;
        let rows = sqlx::query(
            r#"
            select id, event_json
            from ui_events
            where id > $1
            order by id asc
            limit $2
            "#,
        )
        .bind(*last_id)
        .bind(remaining_limit)
        .fetch_all(pool)
        .await
        .map_err(|err| err.to_string())?;

        for row in rows {
            *last_id = row.get("id");
            payloads.push(row.get::<String, _>("event_json"));
        }
    }

    Ok(ui_backend_event_payload(payloads))
}

pub(crate) async fn notify_ui_refresh(pool: &SqlitePool, reason: &str) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "refresh", "reason": reason }).to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_channel_upsert(
    pool: &SqlitePool,
    channel: &Channel,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "channel_upsert", "reason": reason, "channel": channel }).to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_channel_member_upsert(
    pool: &SqlitePool,
    member: &ChannelMember,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({ "type": "channel_member_upsert", "reason": reason, "member": member }).to_string(),
    )
    .await
}

pub(crate) async fn notify_ui_channel_member_delete(
    pool: &SqlitePool,
    channel_id: Uuid,
    agent_id: Uuid,
    reason: &str,
) -> CommandResult<()> {
    notify_database_event(
        pool,
        UI_REFRESH_CHANNEL,
        &json!({
            "type": "channel_member_delete",
            "reason": reason,
            "channel_id": channel_id,
            "agent_id": agent_id
        })
        .to_string(),
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
    fn ui_backend_event_payload_preserves_channel_member_events() {
        let payload = ui_backend_event_payload(vec![
            r#"{"type":"channel_member_upsert","channel_id":"one","agent_id":"two"}"#.to_owned(),
            r#"{"type":"channel_member_delete","channel_id":"one","agent_id":"three"}"#.to_owned(),
        ])
        .expect("multiple events should produce a payload");
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();

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
                r#"{"type":"channel_member_upsert","channel_id":"one","agent_id":"two"}"#,
                r#"{"type":"channel_member_delete","channel_id":"one","agent_id":"three"}"#,
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

    #[test]
    fn ui_backend_event_payload_coalesces_adjacent_activity_upserts() {
        let payload = ui_backend_event_payload(vec![
            r#"{"type":"activity_upsert","reason":"activity","activity":{"id":"activity-1","title":"Thinking"}}"#.to_owned(),
            r#"{"type":"activity_upsert","reason":"activity_update","activity":{"id":"activity-1","title":"Running command"}}"#.to_owned(),
        ])
        .expect("coalesced activity should produce a payload");
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();

        assert_eq!(
            value.get("type").and_then(serde_json::Value::as_str),
            Some("activity_upsert")
        );
        assert_eq!(
            value.get("reason").and_then(serde_json::Value::as_str),
            Some("activity_update")
        );
        assert_eq!(
            value
                .pointer("/activity/title")
                .and_then(serde_json::Value::as_str),
            Some("Running command")
        );
    }

    #[test]
    fn ui_backend_event_payload_coalesces_adjacent_agent_run_upserts() {
        let payload = ui_backend_event_payload(vec![
            r#"{"type":"agent_run_upsert","reason":"run_usage","run":{"id":"run-1","status":"running","input_tokens":10,"output_tokens":1}}"#.to_owned(),
            r#"{"type":"agent_run_upsert","reason":"run_usage","run":{"id":"run-1","status":"running","input_tokens":20,"output_tokens":3}}"#.to_owned(),
        ])
        .expect("coalesced run should produce a payload");
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();

        assert_eq!(
            value.get("type").and_then(serde_json::Value::as_str),
            Some("agent_run_upsert")
        );
        assert_eq!(
            value
                .pointer("/run/input_tokens")
                .and_then(serde_json::Value::as_i64),
            Some(20)
        );
        assert_eq!(
            value
                .pointer("/run/output_tokens")
                .and_then(serde_json::Value::as_i64),
            Some(3)
        );
    }

    #[test]
    fn ui_backend_event_payload_preserves_non_adjacent_upsert_order() {
        let payload = ui_backend_event_payload(vec![
            r#"{"type":"activity_upsert","activity":{"id":"activity-1","title":"one"}}"#.to_owned(),
            r#"{"type":"message_delta","message_id":"message-1","append":"x"}"#.to_owned(),
            r#"{"type":"activity_upsert","activity":{"id":"activity-1","title":"two"}}"#.to_owned(),
        ])
        .expect("non-adjacent events should produce a batch");
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let events = value
            .get("events")
            .and_then(serde_json::Value::as_array)
            .expect("batch events");

        assert_eq!(events.len(), 3);
        assert_eq!(
            events
                .first()
                .and_then(serde_json::Value::as_str)
                .and_then(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
                .and_then(|value| {
                    value
                        .pointer("/activity/title")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                })
                .as_deref(),
            Some("one")
        );
        assert_eq!(
            events
                .last()
                .and_then(serde_json::Value::as_str)
                .and_then(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
                .and_then(|value| {
                    value
                        .pointer("/activity/title")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                })
                .as_deref(),
            Some("two")
        );
    }
}
