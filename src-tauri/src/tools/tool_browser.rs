use serde_json::{json, Value};

use crate::{
    tool_browser,
    tools::{ToolDisplay, ToolHost, ToolResult},
    CommandResult,
};

pub(crate) async fn open(host: &ToolHost<'_>, arguments: &Value) -> CommandResult<ToolResult> {
    let Some(target) = argument_string(arguments, &["target", "url"]) else {
        return Ok(ToolResult::error(
            "tool_browser.open requires a target or url argument.",
            json!({ "error": "missing_target" }),
        ));
    };
    let target = match tool_browser::validate_tool_browser_target(target) {
        Ok(target) => target,
        Err(error) => {
            return Ok(ToolResult::error(
                error.clone(),
                json!({ "error": "invalid_target", "message": error }),
            ));
        }
    };

    host.open_tool_view(&target.url, "tool_browser_open")
        .await?;
    Ok(ToolResult::success_with_display(
        format!("Opened {} in Lantor Tool Browser.", target.url),
        json!({
            "opened": true,
            "target": target.url,
            "host": target.host,
            "is_loopback": target.is_loopback
        }),
        ToolDisplay::webview(target.url),
    ))
}

fn argument_string<'a>(arguments: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| arguments.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
