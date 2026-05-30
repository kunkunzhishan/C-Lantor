pub(crate) mod registry;
pub(crate) mod result;
pub(crate) mod schema;

mod calendar;
mod host;
mod tool_browser;

use serde_json::Value;
use sqlx::SqlitePool;

use crate::CommandResult;

pub(crate) use host::{ToolEvent, ToolHost};
pub(crate) use registry::search;
pub(crate) use result::{ToolDisplay, ToolResult};

pub(crate) const TOOL_BROWSER_OPEN_ID: &str = "tool_browser.open";
pub(crate) const CALENDAR_PREVIEW_ID: &str = "calendar.preview";

pub(crate) async fn execute(
    pool: &SqlitePool,
    tool_id: &str,
    arguments: &Value,
) -> CommandResult<ToolResult> {
    let Some(tool) = registry::find_tool(tool_id) else {
        return Ok(ToolResult::error(
            format!("Unknown Lantor tool: {tool_id}"),
            serde_json::json!({ "error": "unknown_tool", "tool_id": tool_id }),
        ));
    };
    let host = ToolHost::new(pool);
    tool.execute(&host, arguments).await
}
