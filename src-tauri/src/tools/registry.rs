use std::{future::Future, pin::Pin};

use serde_json::{json, Value};

use super::{
    calendar, schema, tool_browser, ToolHost, ToolResult, CALENDAR_PREVIEW_ID, TOOL_BROWSER_OPEN_ID,
};
use crate::CommandResult;

type ToolFuture<'a> = Pin<Box<dyn Future<Output = CommandResult<ToolResult>> + Send + 'a>>;
type CodexToolHandler = for<'a> fn(&'a ToolHost<'a>, &'a Value) -> ToolFuture<'a>;

#[derive(Clone, Copy)]
pub(crate) struct CodexToolDefinition {
    pub(crate) id: &'static str,
    pub(crate) title: &'static str,
    pub(crate) description: &'static str,
    pub(crate) handler: CodexToolHandler,
    pub(crate) tool_app_entry: Option<&'static str>,
    pub(crate) input_schema: fn() -> Value,
    pub(crate) output_schema: fn() -> Value,
    pub(crate) side_effects: &'static [&'static str],
    pub(crate) display: Option<&'static str>,
    pub(crate) enabled: bool,
}

impl CodexToolDefinition {
    pub(crate) fn to_search_result(self) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "input_schema": (self.input_schema)(),
            "output_schema": (self.output_schema)(),
            "side_effects": self.side_effects,
            "display": self.display,
            "tool_app_entry": self.tool_app_entry,
            "enabled": self.enabled,
            "method": "lantor.call_tool",
            "call": {
                "namespace": "lantor",
                "tool": "call_tool",
                "arguments": {
                    "tool_id": self.id,
                    "arguments": {}
                }
            }
        })
    }

    pub(crate) async fn execute(
        self,
        host: &ToolHost<'_>,
        arguments: &Value,
    ) -> CommandResult<ToolResult> {
        (self.handler)(host, arguments).await
    }
}

pub(crate) fn tool_definitions() -> &'static [CodexToolDefinition] {
    &[
        CodexToolDefinition {
            id: CALENDAR_PREVIEW_ID,
            title: "Calendar Preview",
            description: "Render an isolated calendar tool view for reminders, schedules, or optional dated events in Lantor Tool Browser.",
            handler: calendar_preview_handler,
            tool_app_entry: Some("/tool/calendar"),
            input_schema: schema::calendar_preview_input,
            output_schema: schema::calendar_preview_output,
            side_effects: &["ui", "network"],
            display: Some("webview"),
            enabled: true,
        },
        CodexToolDefinition {
            id: TOOL_BROWSER_OPEN_ID,
            title: "Open Tool Browser",
            description: "Open an absolute http/https URL in Lantor's embedded Tool Browser panel.",
            handler: tool_browser_open_handler,
            tool_app_entry: None,
            input_schema: schema::tool_browser_open_input,
            output_schema: schema::tool_browser_open_output,
            side_effects: &["ui", "network"],
            display: Some("webview"),
            enabled: true,
        },
    ]
}

pub(crate) fn find_tool(tool_id: &str) -> Option<CodexToolDefinition> {
    tool_definitions()
        .iter()
        .copied()
        .find(|tool| tool.enabled && tool.id == tool_id)
}

pub(crate) fn search(_arguments: &Value) -> ToolResult {
    let tools = tool_definitions()
        .iter()
        .copied()
        .filter(|tool| tool.enabled)
        .map(CodexToolDefinition::to_search_result)
        .collect::<Vec<_>>();

    ToolResult::success(
        format!("Listed {} Lantor Codex tool(s).", tools.len()),
        json!({ "tools": tools }),
    )
}

fn calendar_preview_handler<'a>(host: &'a ToolHost<'a>, arguments: &'a Value) -> ToolFuture<'a> {
    Box::pin(calendar::preview(host, arguments))
}

fn tool_browser_open_handler<'a>(host: &'a ToolHost<'a>, arguments: &'a Value) -> ToolFuture<'a> {
    Box::pin(tool_browser::open(host, arguments))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_exposes_codex_tools_and_tool_app_entry() {
        let calendar = find_tool(CALENDAR_PREVIEW_ID).expect("calendar tool");
        assert_eq!(calendar.tool_app_entry, Some("/tool/calendar"));

        let browser = find_tool(TOOL_BROWSER_OPEN_ID).expect("tool browser");
        assert_eq!(browser.tool_app_entry, None);
    }

    #[test]
    fn search_returns_full_codex_tool_list_without_filtering() {
        let result = search(&json!({ "query": "open url tool browser" }));
        let tools = result
            .data
            .get("tools")
            .and_then(Value::as_array)
            .expect("tools");

        assert_eq!(tools.len(), 2);
        assert!(tools.iter().any(|tool| {
            tool.get("id").and_then(Value::as_str) == Some(CALENDAR_PREVIEW_ID)
                && tool.get("tool_app_entry").and_then(Value::as_str) == Some("/tool/calendar")
                && tool.get("method").and_then(Value::as_str) == Some("lantor.call_tool")
        }));
        assert!(tools
            .iter()
            .any(|tool| tool.get("id").and_then(Value::as_str) == Some(TOOL_BROWSER_OPEN_ID)));
    }
}
