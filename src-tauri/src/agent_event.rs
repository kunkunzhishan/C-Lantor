use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub(crate) struct AgentAttachmentFile {
    #[serde(alias = "local_path")]
    pub(crate) path: String,
    pub(crate) name: Option<String>,
    #[serde(alias = "mime")]
    pub(crate) mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum AgentEvent {
    Message {
        channel: Option<String>,
        channel_id: Option<Uuid>,
        thread_root_id: Option<Uuid>,
        body: String,
        as_task: Option<bool>,
    },
    ChannelMessageCreate {
        channel: Option<String>,
        channel_id: Option<Uuid>,
        thread_root_id: Option<Uuid>,
        body: String,
    },
    Activity {
        kind: Option<String>,
        title: String,
        detail: Option<String>,
    },
    TaskCreate {
        channel: Option<String>,
        channel_id: Option<Uuid>,
        title: String,
        body: Option<String>,
        thread_body: Option<String>,
        assign_self: Option<bool>,
        status: Option<String>,
    },
    TaskStatus {
        task_number: i64,
        status: String,
    },
    TaskClaim {
        task_number: i64,
        assignee_handle: Option<String>,
    },
    TaskHandoff {
        #[serde(alias = "target_handle")]
        target_agent: String,
        #[serde(default)]
        task_number: Option<i64>,
        reason: String,
        #[serde(default)]
        body: Option<String>,
    },
    Silent {
        reason: Option<String>,
    },
    ReminderCreate {
        channel: Option<String>,
        channel_id: Option<Uuid>,
        thread_root_id: Option<Uuid>,
        message_id: Option<Uuid>,
        title: String,
        note: Option<String>,
        #[serde(alias = "when", alias = "dueAt", default)]
        due_at: Option<String>,
        #[serde(alias = "cadence", default)]
        recurrence: Option<String>,
    },
    ReminderCancel {
        reminder_id: Uuid,
    },
    HookCreate {
        channel: Option<String>,
        channel_id: Option<Uuid>,
        thread_root_id: Option<Uuid>,
        title: String,
        body_preview: Option<String>,
        code_language: Option<String>,
        code_body: String,
        hook_context: Option<Value>,
        external_resources: Option<Value>,
        fixture_request: Option<Value>,
        timeout_ms: Option<i64>,
        max_output_bytes: Option<i64>,
        max_fires: Option<i64>,
    },
    HookDelete {
        hook_id: Uuid,
    },
    Usage {
        #[serde(default)]
        input_tokens: Option<i64>,
        #[serde(default)]
        output_tokens: Option<i64>,
        #[serde(default)]
        total_tokens: Option<i64>,
        #[serde(default)]
        cost_micros: Option<i64>,
        #[serde(default)]
        cost_usd: Option<f64>,
    },
    MemoryRunSummary {
        title: Option<String>,
        #[serde(alias = "summary", alias = "content")]
        body: String,
    },
    ChannelCreate {
        name: String,
        description: Option<String>,
        agent_handles: Option<Vec<String>>,
    },
    ChannelInvite {
        channel: Option<String>,
        channel_id: Option<Uuid>,
        agent_handles: Vec<String>,
    },
    ProfileUpdate {
        display_name: Option<String>,
        role: Option<String>,
        avatar: Option<String>,
        description: Option<String>,
    },
    OwnerProfileUpdate {
        display_name: Option<String>,
        avatar: Option<String>,
        description: Option<String>,
    },
    ArtifactCreate {
        channel: Option<String>,
        channel_id: Option<Uuid>,
        thread_root_id: Option<Uuid>,
        kind: String,
        title: String,
        summary: Option<String>,
        content: String,
        metadata: Option<Value>,
    },
    AttachmentCreate {
        channel: Option<String>,
        channel_id: Option<Uuid>,
        thread_root_id: Option<Uuid>,
        body: Option<String>,
        files: Vec<AgentAttachmentFile>,
    },
    HandoffCreate {
        #[serde(alias = "target_handle")]
        target_agent: String,
        channel: Option<String>,
        channel_id: Option<Uuid>,
        thread_root_id: Uuid,
        reason: Option<String>,
        body: String,
    },
    InterruptedActionResolve {
        stream_key: String,
        action: String,
    },
}
