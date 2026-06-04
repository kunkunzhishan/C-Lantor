use std::{
    env,
    net::{IpAddr, SocketAddr},
};

use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Value};

use crate::{
    tools::{ToolDisplay, ToolHost, ToolResult},
    web, CommandResult,
};

pub(crate) async fn preview(host: &ToolHost<'_>, arguments: &Value) -> CommandResult<ToolResult> {
    let scope = argument_string(arguments, "scope")
        .and_then(normalize_scope)
        .unwrap_or("global");
    let window = argument_string(arguments, "window")
        .and_then(normalize_window)
        .unwrap_or("24h");
    let bucket = argument_string(arguments, "bucket")
        .and_then(normalize_bucket)
        .unwrap_or("day");
    let metric = argument_string(arguments, "metric")
        .and_then(normalize_metric)
        .unwrap_or("total_tokens");
    let limit = argument_usize(arguments, "limit").unwrap_or(8).clamp(1, 25);
    let agent = argument_string(arguments, "agent").map(normalize_agent_handle);
    let Some(base_url) = local_web_base_url() else {
        return Ok(ToolResult::error(
            "monitoring.preview requires Lantor web access to be enabled.",
            json!({ "error": "web_access_disabled" }),
        ));
    };
    let target = monitoring_preview_url(
        &base_url,
        scope,
        agent.as_deref(),
        window,
        bucket,
        metric,
        limit,
    );
    host.open_tool_view(&target, "monitoring_preview").await?;
    Ok(ToolResult::success_with_display(
        format!("Opened monitoring preview for {scope} over {window}."),
        json!({
            "opened": true,
            "target": target,
            "scope": scope,
            "window": window,
            "bucket": bucket,
            "metric": metric,
            "agent": agent
        }),
        ToolDisplay::webview(target),
    ))
}

pub(crate) async fn summary(host: &ToolHost<'_>, arguments: &Value) -> CommandResult<ToolResult> {
    let scope = argument_string(arguments, "scope")
        .and_then(normalize_scope)
        .unwrap_or("global");
    let window = argument_string(arguments, "window")
        .and_then(normalize_window)
        .unwrap_or("24h");
    let limit = argument_usize(arguments, "limit").unwrap_or(8).clamp(1, 25);
    let agent = argument_string(arguments, "agent").map(normalize_agent_handle);
    let data = host
        .query_monitoring_summary(scope, agent.as_deref(), window, limit)
        .await?;
    let text = match scope {
        "agent" => format!(
            "Monitoring summary for {} over {}.",
            agent.as_deref().unwrap_or("selected agent"),
            window
        ),
        _ => format!("Global monitoring summary over {window}."),
    };
    Ok(ToolResult::success(text, data))
}

fn argument_string<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn argument_usize(arguments: &Value, key: &str) -> Option<usize> {
    arguments
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn normalize_scope(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "global" => Some("global"),
        "agent" => Some("agent"),
        _ => None,
    }
}

fn normalize_window(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "24h" => Some("24h"),
        "7d" => Some("7d"),
        "30d" => Some("30d"),
        "all" => Some("all"),
        _ => None,
    }
}

fn normalize_bucket(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "day" | "daily" | "days" => Some("day"),
        "week" | "weekly" | "weeks" => Some("week"),
        _ => None,
    }
}

fn normalize_metric(value: &str) -> Option<&'static str> {
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

fn normalize_agent_handle(value: &str) -> String {
    let handle = value.trim().trim_start_matches('@');
    if handle.is_empty() {
        String::new()
    } else {
        format!("@{handle}")
    }
}

pub(crate) fn monitoring_since(window: &str) -> Option<String> {
    let now = Utc::now();
    match window {
        "24h" => Some((now - ChronoDuration::hours(24)).to_rfc3339()),
        "7d" => Some((now - ChronoDuration::days(7)).to_rfc3339()),
        "30d" => Some((now - ChronoDuration::days(30)).to_rfc3339()),
        "all" => None,
        _ => Some((now - ChronoDuration::hours(24)).to_rfc3339()),
    }
}

pub(crate) fn empty_monitoring_summary(scope: &str, window: &str, since: Option<&str>) -> Value {
    json!({
        "scope": scope,
        "window": window,
        "since": since,
        "global": {
            "runs": 0,
            "running_runs": 0,
            "completed_runs": 0,
            "failed_runs": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cost_micros": 0,
            "cost_usd": 0.0
        },
        "agents": [],
        "agent": null,
        "memory_reads": {
            "count": 0,
            "memory_reads": 0,
            "output_chars": 0,
            "output_bytes": 0,
            "memory_read_bytes": 0,
            "direct": 0,
            "weak": 0,
            "layers": {
                "realtime": 0,
                "events": 0
            },
            "recent": []
        },
        "memory_inventory": {
            "realtime_files": 0,
            "event_files": 0,
            "agents": []
        },
        "memory_layer_time_series": [],
        "time_series": []
    })
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

fn monitoring_preview_url(
    base_url: &str,
    scope: &str,
    agent: Option<&str>,
    window: &str,
    bucket: &str,
    metric: &str,
    limit: usize,
) -> String {
    let mut target = format!(
        "{}/tool/monitoring?scope={}&window={}&bucket={}&metric={}&limit={}",
        base_url.trim_end_matches('/'),
        percent_encode(scope),
        percent_encode(window),
        percent_encode(bucket),
        percent_encode(metric),
        limit
    );
    if let Some(agent) = agent.filter(|value| !value.trim().is_empty()) {
        target.push_str("&agent=");
        target.push_str(&percent_encode(agent));
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
