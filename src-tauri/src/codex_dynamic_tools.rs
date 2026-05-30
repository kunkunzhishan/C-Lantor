use serde_json::{json, Value};

use crate::tools::{self, schema, ToolResult};

pub(crate) const NAMESPACE: &str = "lantor";
pub(crate) const SEARCH_TOOLS: &str = "search_tools";
pub(crate) const CALL_TOOL: &str = "call_tool";

#[derive(Debug, Clone)]
pub(crate) struct DynamicToolResult {
    pub(crate) success: bool,
    pub(crate) text: String,
    pub(crate) structured_content: Value,
}

impl DynamicToolResult {
    pub(crate) fn error(text: impl Into<String>, structured_content: Value) -> Self {
        Self {
            success: false,
            text: text.into(),
            structured_content,
        }
    }

    pub(crate) fn into_app_server_response(self) -> Value {
        app_server_text_response(&self.text, self.structured_content, self.success)
    }
}

impl From<ToolResult> for DynamicToolResult {
    fn from(result: ToolResult) -> Self {
        Self {
            success: result.success,
            text: result.text.clone(),
            structured_content: result.to_payload(),
        }
    }
}

pub(crate) fn definitions() -> Value {
    json!([
        {
            "namespace": NAMESPACE,
            "name": SEARCH_TOOLS,
            "description": "List built-in Lantor Codex tools. Returns tool ids, descriptions, schemas, side effects, display hints, and call examples.",
            "inputSchema": schema::search_tools_input()
        },
        {
            "namespace": NAMESPACE,
            "name": CALL_TOOL,
            "description": "Call a Lantor Codex tool returned by lantor.search_tools.",
            "inputSchema": schema::call_tool_input()
        }
    ])
}

pub(crate) fn register(params: &mut Value) -> bool {
    let Some(object) = params.as_object_mut() else {
        return false;
    };
    object.insert("dynamicTools".to_owned(), definitions());
    true
}

pub(crate) fn search(arguments: &Value) -> DynamicToolResult {
    tools::search(arguments).into()
}

pub(crate) fn call_tool_arguments(arguments: &Value) -> Result<(&str, &Value), DynamicToolResult> {
    let tool_id = arguments
        .get("tool_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            DynamicToolResult::error(
                "lantor.call_tool requires a non-empty tool_id.",
                json!({ "error": "missing_tool_id" }),
            )
        })?;
    let tool_arguments = arguments.get("arguments").unwrap_or(&Value::Null);
    Ok((tool_id, tool_arguments))
}

fn app_server_text_response(text: &str, structured_content: Value, success: bool) -> Value {
    let content_text = if structured_content.is_null() {
        text.to_owned()
    } else {
        format!("{text}\n{}", structured_content)
    };
    json!({
        "contentItems": [{ "type": "inputText", "text": content_text }],
        "success": success
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_server_text_response_matches_dynamic_tool_schema() {
        let result = DynamicToolResult::from(ToolResult::success(
            "Found 2 Lantor tool(s).",
            json!({ "tools": [] }),
        ))
        .into_app_server_response();

        assert_eq!(result.get("success").and_then(Value::as_bool), Some(true));
        assert!(result.get("content").is_none());
        assert!(result.get("structuredContent").is_none());
        assert!(result.get("isError").is_none());

        let content_items = result
            .get("contentItems")
            .and_then(Value::as_array)
            .expect("contentItems array");
        assert_eq!(content_items.len(), 1);
        assert_eq!(
            content_items[0].get("type").and_then(Value::as_str),
            Some("inputText")
        );
        assert!(content_items[0]
            .get("text")
            .and_then(Value::as_str)
            .expect("text")
            .contains("\"tools\""));
    }

    #[test]
    fn search_lists_catalog_for_agent_selection() {
        let result = search(&json!({ "query": "open url tool browser" }));

        assert!(result.success);
        let tools = result
            .structured_content
            .get("data")
            .and_then(|data| data.get("tools"))
            .and_then(Value::as_array)
            .expect("tools");
        assert_eq!(tools.len(), 2);
        assert!(tools.iter().any(|tool| {
            tool.get("id").and_then(Value::as_str) == Some(tools::TOOL_BROWSER_OPEN_ID)
                && tool.get("method").and_then(Value::as_str) == Some("lantor.call_tool")
        }));
    }

    #[test]
    fn register_inserts_dynamic_tools_schema() {
        let mut params = json!({ "model": "gpt-5" });

        assert!(register(&mut params));
        let tools = params
            .get("dynamicTools")
            .and_then(Value::as_array)
            .expect("dynamicTools");
        assert_eq!(tools.len(), 2);
        assert_eq!(
            tools[0].get("namespace").and_then(Value::as_str),
            Some(NAMESPACE)
        );
    }
}
