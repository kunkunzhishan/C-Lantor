use serde_json::{json, Value};

pub(crate) fn search_tools_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Optional caller hint. The tool currently returns the full available tool list so the agent can choose."
            }
        },
        "additionalProperties": false
    })
}

pub(crate) fn call_tool_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tool_id": {
                "type": "string",
                "description": "Lantor Codex tool id returned by lantor.search_tools."
            },
            "arguments": {
                "type": "object",
                "description": "Arguments for the selected Lantor tool."
            }
        },
        "required": ["tool_id", "arguments"],
        "additionalProperties": false
    })
}

pub(crate) fn memory_search_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search text for prior decisions, task state, files, blockers, or context."
            },
            "scope_type": {
                "type": "string",
                "enum": ["agent", "channel", "thread", "task"],
                "description": "Optional memory scope filter."
            },
            "scope": {
                "type": "string",
                "enum": ["agent", "channel", "thread", "task"],
                "description": "Alias for scope_type."
            },
            "scope_id": {
                "type": "string",
                "description": "Optional scope id filter, such as the current thread/task/channel id."
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 20,
                "description": "Maximum candidates to return. Defaults to 8."
            }
        },
        "required": ["query"],
        "additionalProperties": false
    })
}

pub(crate) fn memory_read_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "Memory item id returned by memory_search."
            }
        },
        "required": ["id"],
        "additionalProperties": false
    })
}

pub(crate) fn tool_browser_open_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "target": {
                "type": "string",
                "description": "Absolute http or https URL to open."
            },
            "url": {
                "type": "string",
                "description": "Alias for target."
            }
        },
        "additionalProperties": false
    })
}

pub(crate) fn tool_browser_open_output() -> Value {
    json!({
        "type": "object",
        "properties": {
            "opened": { "type": "boolean" },
            "target": { "type": "string" },
            "host": { "type": "string" },
            "is_loopback": { "type": "boolean" }
        },
        "required": ["opened", "target", "host", "is_loopback"],
        "additionalProperties": false
    })
}

pub(crate) fn calendar_preview_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "month": {
                "type": "string",
                "description": "Month to display in YYYY-MM format. Defaults to the current month."
            },
            "selected_date": {
                "type": "string",
                "description": "Optional selected day in YYYY-MM-DD format."
            },
            "title": {
                "type": "string",
                "description": "Optional calendar title."
            },
            "view": {
                "type": "string",
                "enum": ["month", "day", "agenda"],
                "description": "Initial isolated calendar view. Defaults to month."
            },
            "events": {
                "type": "array",
                "description": "Optional ad hoc events to render on matching days. Omit this to show Lantor reminders from the database.",
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {
                            "type": "string",
                            "description": "Event date in YYYY-MM-DD format."
                        },
                        "title": {
                            "type": "string",
                            "description": "Short event label."
                        },
                        "kind": {
                            "type": "string",
                            "description": "Optional visual category such as focus, review, release, or note."
                        }
                    },
                    "required": ["date", "title"],
                    "additionalProperties": false
                }
            }
        },
        "additionalProperties": false
    })
}

pub(crate) fn calendar_preview_output() -> Value {
    json!({
        "type": "object",
        "properties": {
            "opened": { "type": "boolean" },
            "target": { "type": "string" },
            "month": { "type": "string" },
            "selected_date": { "type": "string" },
            "view": { "type": "string" },
            "event_count": { "type": "integer" }
            ,
            "source": { "type": "string" }
        },
        "required": ["opened", "target", "month", "event_count", "source"],
        "additionalProperties": false
    })
}
