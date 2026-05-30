use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub(crate) struct ToolDisplay {
    pub(crate) kind: &'static str,
    pub(crate) target: String,
}

impl ToolDisplay {
    pub(crate) fn webview(target: impl Into<String>) -> Self {
        Self {
            kind: "webview",
            target: target.into(),
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        json!({
            "kind": self.kind,
            "target": self.target
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ToolResult {
    pub(crate) success: bool,
    pub(crate) text: String,
    pub(crate) data: Value,
    pub(crate) display: Option<ToolDisplay>,
}

impl ToolResult {
    pub(crate) fn success(text: impl Into<String>, data: Value) -> Self {
        Self {
            success: true,
            text: text.into(),
            data,
            display: None,
        }
    }

    pub(crate) fn success_with_display(
        text: impl Into<String>,
        data: Value,
        display: ToolDisplay,
    ) -> Self {
        Self {
            success: true,
            text: text.into(),
            data,
            display: Some(display),
        }
    }

    pub(crate) fn error(text: impl Into<String>, data: Value) -> Self {
        Self {
            success: false,
            text: text.into(),
            data,
            display: None,
        }
    }

    pub(crate) fn to_payload(&self) -> Value {
        json!({
            "success": self.success,
            "text": self.text,
            "data": self.data,
            "display": self.display.as_ref().map(ToolDisplay::to_json)
        })
    }
}
