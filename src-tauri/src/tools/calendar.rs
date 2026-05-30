use std::{
    env,
    net::{IpAddr, SocketAddr},
};

use chrono::{Datelike, NaiveDate, Utc};
use serde_json::{json, Value};

use crate::{
    tools::{ToolDisplay, ToolHost, ToolResult},
    web, CommandResult,
};

pub(crate) async fn preview(host: &ToolHost<'_>, arguments: &Value) -> CommandResult<ToolResult> {
    let month = argument_string(arguments, "month")
        .and_then(normalize_month)
        .unwrap_or_else(current_month);
    let selected_date = argument_string(arguments, "selected_date")
        .and_then(normalize_date)
        .unwrap_or_else(|| current_date_for_month(&month));
    let title = argument_string(arguments, "title").unwrap_or("Reminder calendar");
    let view = argument_string(arguments, "view")
        .and_then(normalize_view)
        .unwrap_or("month");
    let events = calendar_events(arguments);
    let target = match local_web_base_url() {
        Some(base_url) => {
            calendar_preview_url(&base_url, &month, &selected_date, title, view, &events)
        }
        None => {
            return Ok(ToolResult::error(
                "calendar.preview requires Lantor web access to be enabled.",
                json!({ "error": "web_access_disabled" }),
            ))
        }
    };

    host.open_tool_view(&target, "calendar_preview").await?;
    Ok(ToolResult::success_with_display(
        format!("Opened calendar preview for {month}."),
        json!({
            "opened": true,
            "target": target,
            "month": month,
            "selected_date": selected_date,
            "view": view,
            "event_count": events.len(),
            "source": if events.is_empty() { "reminders" } else { "arguments" }
        }),
        ToolDisplay::webview(target),
    ))
}

fn argument_string<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn normalize_month(value: &str) -> Option<String> {
    let mut parts = value.split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) {
        return None;
    }
    Some(format!("{year:04}-{month:02}"))
}

fn normalize_date(value: &str) -> Option<String> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn normalize_view(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "month" => Some("month"),
        "day" => Some("day"),
        "agenda" => Some("agenda"),
        _ => None,
    }
}

fn current_month() -> String {
    let today = Utc::now().date_naive();
    format!("{:04}-{:02}", today.year(), today.month())
}

fn current_date_for_month(month: &str) -> String {
    let today = Utc::now().date_naive();
    if month == format!("{:04}-{:02}", today.year(), today.month()) {
        today.format("%Y-%m-%d").to_string()
    } else {
        format!("{month}-01")
    }
}

fn calendar_events(arguments: &Value) -> Vec<CalendarEvent> {
    let Some(events) = arguments.get("events").and_then(Value::as_array) else {
        return Vec::new();
    };
    events
        .iter()
        .filter_map(|event| {
            let date = event.get("date").and_then(Value::as_str)?.trim();
            let title = event.get("title").and_then(Value::as_str)?.trim();
            if normalize_date(date).is_none() || title.is_empty() {
                return None;
            }
            let kind = event
                .get("kind")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("note");
            Some(CalendarEvent {
                date: date.to_owned(),
                title: title.chars().take(48).collect(),
                kind: kind.chars().take(24).collect(),
            })
        })
        .take(24)
        .collect()
}

fn local_web_base_url() -> Option<String> {
    if let Ok(value) = env::var("LANTOR_WEB_PUBLIC_URL") {
        let trimmed = value.trim().trim_end_matches('/').to_owned();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    let bind = web::resolve_web_bind()?;
    let addr = bind.parse::<SocketAddr>().ok()?;
    let host = match addr.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => "127.0.0.1".to_owned(),
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) if ip.is_unspecified() => "[::1]".to_owned(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    Some(format!("http://{host}:{}", addr.port()))
}

fn calendar_preview_url(
    base_url: &str,
    month: &str,
    selected_date: &str,
    title: &str,
    view: &str,
    events: &[CalendarEvent],
) -> String {
    let mut target = format!(
        "{}/tool/calendar?month={}&selected={}&view={}&title={}",
        base_url.trim_end_matches('/'),
        percent_encode(month),
        percent_encode(selected_date),
        percent_encode(view),
        percent_encode(title)
    );
    if events.is_empty() {
        target.push_str("&source=reminders");
    } else {
        let encoded_events = events
            .iter()
            .map(|event| format!("{}|{}|{}", event.date, event.title, event.kind))
            .collect::<Vec<_>>()
            .join(";");
        target.push_str("&events=");
        target.push_str(&percent_encode(&encoded_events));
    }
    target
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

#[derive(Debug, Clone)]
struct CalendarEvent {
    date: String,
    title: String,
    kind: String,
}
