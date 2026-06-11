export type AgentWorkspaceEntry = {
  name: string;
  path: string;
  relative_path: string;
  kind: "dir" | "file" | "other" | string;
  size_bytes: number | null;
};

export type AgentWorkspaceListing = {
  path: string;
  entries: AgentWorkspaceEntry[];
};

export type AgentWorkspaceFile = {
  name: string;
  path: string;
  relative_path: string;
  size_bytes: number;
  language: string;
  content: string;
  truncated: boolean;
};

export type Agent = {
  id: string;
  handle: string;
  display_name: string;
  role: string;
  status: string;
  runtime: string;
  model: string;
  reasoning_effort: string;
  service_tier: string;
  avatar: string;
  description: string;
  launch_command: string;
  working_directory: string;
  workspace_exists: boolean;
  workspace_memory_path: string;
  workspace_memory_exists: boolean;
  workspace_entries: AgentWorkspaceEntry[];
  daily_budget_micros: number;
};

export type OwnerProfile = {
  display_name: string;
  avatar: string;
  description: string;
};

export type Channel = {
  id: string;
  name: string;
  description: string;
  kind: "channel" | "dm";
  dm_agent_id: string | null;
  unread_count: number;
};

export type ChannelMember = {
  channel_id: string;
  agent_id: string;
  agent_handle: string;
  agent_display_name: string;
  created_at: string;
};

export type Message = {
  id: string;
  channel_id: string;
  thread_root_id: string | null;
  sender_agent_id: string | null;
  sender_name: string;
  sender_role: string;
  body: string;
  is_task: boolean;
  thread_followed: boolean;
  delivery_state: "complete" | "streaming" | "error" | string;
  stream_key: string;
  task_number: number | null;
  task_status: string | null;
  attachments: MessageAttachment[];
  artifacts: Artifact[];
  created_at: string;
  updated_at: string;
};

export type ThreadReplySummary = {
  count: number;
  latest: Message | null;
  participants: ThreadParticipant[];
};

export type ThreadActivity = {
  thread_root_id: string;
  reply_count: number;
  unread_count: number;
  latest_visible_message_id: string | null;
  latest_visible_at: string | null;
  participants: ThreadParticipant[];
};

export type ThreadParticipant = Pick<Message, "sender_agent_id" | "sender_name" | "sender_role">;

export type SavedMessage = {
  id: string;
  message_id: string;
  channel_id: string;
  channel_name: string;
  thread_root_id: string | null;
  sender_name: string;
  sender_role: string;
  body: string;
  message_created_at: string;
  created_at: string;
};

export type TodoItem = {
  id: string;
  message_id: string | null;
  channel_id: string | null;
  channel_name: string | null;
  thread_root_id: string | null;
  summary: string;
  sender_name: string | null;
  sender_role: string | null;
  message_created_at: string | null;
  created_at: string;
  done_at: string | null;
};

export type MessageAttachment = {
  id: string;
  message_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  local_url?: string;
  created_at: string;
};

export type DraftAttachment = {
  id: string;
  file: File;
  original_name: string;
  mime_type: string;
  size_bytes: number;
};

export type Artifact = {
  id: string;
  message_id: string;
  channel_id: string;
  thread_root_id: string | null;
  creator_agent_id: string | null;
  creator_agent_handle: string | null;
  kind: string;
  title: string;
  summary: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type Task = {
  id: string;
  number: number;
  message_id: string;
  channel_id: string;
  title: string;
  status: string;
  version: number;
  channel_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  created_at: string;
  updated_at: string;
};

export type Reminder = {
  id: string;
  channel_id: string | null;
  channel_name: string | null;
  creator_agent_id: string | null;
  creator_agent_handle: string | null;
  thread_root_id: string | null;
  message_id: string | null;
  title: string;
  note: string;
  status: string;
  recurrence: "none" | "daily" | "weekly" | string;
  due_at: string;
  fired_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentSchedule = {
  id: string;
  agent_id: string;
  agent_handle: string;
  channel_id: string;
  channel_name: string;
  channel_kind: "channel" | "dm" | string;
  thread_root_id: string | null;
  title: string;
  prompt: string;
  cadence: "hourly" | "daily" | "weekly" | string;
  status: string;
  next_run_at: string;
  last_run_at: string | null;
  last_work_item_id: string | null;
  created_at: string;
  updated_at: string;
};

export type EventHook = {
  id: string;
  agent_id: string;
  agent_handle: string;
  channel_id: string;
  channel_name: string;
  thread_root_id: string | null;
  title: string;
  body_preview: string;
  external_resources: unknown[];
  ingress_token: string | null;
  scheduled: boolean;
  schedule_cadence: string;
  next_run_at: string | null;
  status: string;
  fired_count: number;
  max_fires: number;
  created_at: string;
  updated_at: string;
};

export type AgentRun = {
  id: string;
  agent_id: string;
  agent_handle: string;
  work_item_id: string | null;
  command: string;
  working_directory: string;
  status: string;
  pid: number | null;
  exit_code: number | null;
  log: string;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  started_at: string;
  stopped_at: string | null;
};

export type AgentWorkItem = {
  id: string;
  agent_id: string;
  agent_handle: string;
  channel_id: string | null;
  channel_name: string | null;
  thread_root_id: string | null;
  source_message_id: string | null;
  inbox_item_id?: string | null;
  task_id: string | null;
  task_number: number | null;
  call_session_id: string | null;
  call_utterance_id: string | null;
  call_dispatch_id: string | null;
  source_kind: string;
  title: string;
  context: string;
  result_body?: string;
  status: string;
  run_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type CallSession = {
  id: string;
  channel_id: string | null;
  thread_root_id: string | null;
  mode?: "call" | "wake_word" | string;
  wake_words?: string;
  status: "active" | "ended" | "error" | string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
};

export type CallUtterance = {
  id: string;
  session_id: string;
  thread_root_utterance_id: string | null;
  source_message_id?: string | null;
  sequence: number;
  transcript: string;
  language: string;
  transcription_provider: string;
  transcription_error: string;
  audio_mime_type: string;
  audio_original_name: string | null;
  audio_duration_ms: number | null;
  status: "transcribing" | "transcribed" | "dispatching" | "dispatched" | "failed" | "ignored" | string;
  created_at: string;
  updated_at: string;
};

export type CallDispatch = {
  id: string;
  session_id: string;
  utterance_id: string;
  utterance_sequence: number;
  intent: string;
  ack_status: "heard" | "understood" | "needs_target" | "needs_confirmation" | "refused" | "unsupported" | string;
  ack_text: string;
  speech_topic: string;
  confidence: "high" | "medium" | "low" | string;
  target_agent_id: string | null;
  work_item_id: string | null;
  compensated_work_item_id: string | null;
  long_task_id: string | null;
  status: "acknowledged" | "queued" | "needs_user" | "failed" | "compensated" | "ignored" | string;
  outcome:
    | "acknowledged"
    | "acknowledged_pending_work"
    | "work_queued"
    | "work_cancel_requested"
    | "long_task_queued"
    | "needs_user"
    | "dispatch_failed"
    | "work_link_compensated"
    | "work_link_compensation_failed"
    | "ignored"
    | string;
  status_text: string;
  correlation_key: string;
  correlation_trail: string[];
  error: string;
  created_at: string;
  updated_at: string;
};

export type CallUtteranceSubmitResult = {
  session: CallSession;
  utterance: CallUtterance;
  dispatch: CallDispatch;
  ack_text: string;
  work_item_id: string | null;
  long_task_id: string | null;
};

export type CallHistoryPage = {
  utterances: CallUtterance[];
  dispatches: CallDispatch[];
  work_items: AgentWorkItem[];
};

export type AgentActivity = {
  id: string;
  agent_id: string | null;
  agent_handle: string;
  run_id: string | null;
  kind: string;
  phase: string;
  status: string;
  title: string;
  summary: string;
  detail: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type SupervisorStatus = {
  pid: number | null;
  status: string;
  updated_at: string | null;
};

export type LaunchAgentStatus = {
  label: string;
  plist_path: string;
  installed: boolean;
  loaded: boolean;
};

export type RuntimeCheck = {
  runtime: string;
  command: string;
  available: boolean;
  detail: string;
};

export type Bootstrap = {
  db_url: string;
  web_base_url: string | null;
  owner_profile: OwnerProfile;
  channels: Channel[];
  channel_members: ChannelMember[];
  agents: Agent[];
  messages: Message[];
  thread_activities: ThreadActivity[];
  saved_messages: SavedMessage[];
  todo_items: TodoItem[];
  dismissed_inbox_items: Record<string, string>;
  read_inbox_items: Record<string, string>;
  artifacts: Artifact[];
  tasks: Task[];
  long_tasks: LongTask[];
  reminders: Reminder[];
  agent_schedules: AgentSchedule[];
  event_hooks: EventHook[];
  agent_runs: AgentRun[];
  agent_work_items: AgentWorkItem[];
  call_sessions: CallSession[];
  call_utterances: CallUtterance[];
  call_dispatches: CallDispatch[];
  agent_activities: AgentActivity[];
  supervisor: SupervisorStatus;
  launch_agent: LaunchAgentStatus;
};

export type LongTask = {
  id: string;
  workspace: string;
  title: string;
  createdAt: string;
};

export type LongTaskMonitor = {
  taskId: string | null;
  workspace: string;
  title: string;
  status: string;
  current: string;
  loopCount?: number;
  progress: string;
  updatedAt: string | null;
};

export type LongTaskListItem = LongTask & {
  monitor: LongTaskMonitor | null;
  error: string | null;
  archived: boolean;
};

export type LongTaskCreateResult = LongTask & {
  monitor: LongTaskMonitor | null;
};

export type LongTaskChecklistItem = {
  id?: string;
  title?: string;
  status?: string;
  progress?: string;
  children?: LongTaskChecklistItem[];
};

export type LongTaskInspectDetail = {
  taskId?: string | null;
  loopCount?: number;
  currentJudgment?: string;
  recentOutput?: unknown;
  checklist?: LongTaskChecklistItem[];
  risks?: string[];
  approval?: {
    status?: string;
    loop?: number | null;
    requestedAt?: string | null;
    title?: string;
    instructions?: string;
    checklistItemIds?: string[];
    action?: unknown;
  } | null;
  actions?: {
    canSteer?: boolean;
    canApprove?: boolean;
    canReject?: boolean;
    canSetApprovalMode?: boolean;
    canStop?: boolean;
  };
};

export type LongTaskInspectResult = LongTask & {
  monitor: LongTaskMonitor | null;
  detail: LongTaskInspectDetail;
};

export type SearchScope = "all" | "messages" | "channels" | "tasks" | "agents" | "activity" | "artifacts";

export type SearchTimeRange = "any" | "today" | "7d" | "30d";

export type SearchResult = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  excerpt: string;
  createdAt: string | null;
  channelId: string | null;
  threadId: string | null;
  agentId: string | null;
  senderRole?: string | null;
};

export type ActivityFeedKind =
  | "mention"
  | "dm"
  | "thread"
  | "task"
  | "reminder"
  | "channel"
  | "schedule"
  | "hook"
  | "activity";

export type ActivityFeedItem = {
  id: string;
  dismissId: string;
  kind: ActivityFeedKind;
  title: string;
  excerpt: string;
  surface: string;
  actor: string;
  timestamp: string;
  unread: boolean;
  actorAgentId?: string | null;
  actorRole?: string | null;
  channelId: string | null;
  threadId: string | null;
  messageId: string | null;
  taskId: string | null;
  reminderId: string | null;
  scheduleId: string | null;
  hookId: string | null;
  replyCount: number;
  newCount: number;
};

export type AgentForm = {
  handle: string;
  displayName: string;
  role: string;
  avatar: string;
  runtime: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  description: string;
  launchCommand: string;
  workingDirectory: string;
  dailyBudgetUsd: string;
};

export const EMPTY_AGENT_FORM: AgentForm = {
  handle: "",
  displayName: "",
  role: "agent",
  avatar: "",
  runtime: "codex",
  model: "gpt-5.5",
  reasoningEffort: "medium",
  serviceTier: "",
  description: "",
  launchCommand: "",
  workingDirectory: "",
  dailyBudgetUsd: "",
};

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done"] as const;

export const ACTIVE_RUN_STATUSES = new Set(["starting", "running", "stopping"]);

export const RUNTIME_PRESETS: Record<string, { label: string; defaultModel: string; commandName: string; models: string[] }> = {
  codex: {
    label: "Codex",
    defaultModel: "gpt-5.5",
    commandName: "codex",
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark"],
  },
  claude: {
    label: "Claude",
    defaultModel: "sonnet",
    commandName: "claude",
    models: ["sonnet", "opus", "haiku"],
  },
};

const MODEL_LABELS: Record<string, string> = {
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
};

export const CODEX_REASONING_EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
] as const;

export const CLAUDE_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.filter((effort) => effort.value !== "xhigh");

export function reasoningEffortsForRuntime(runtime: string) {
  return runtime === "claude" ? CLAUDE_REASONING_EFFORTS : CODEX_REASONING_EFFORTS;
}

export function normalizedReasoningEffortForRuntime(runtime: string, value: string) {
  const options = reasoningEffortsForRuntime(runtime);
  const normalized = value.trim() || "medium";
  if (options.some((effort) => effort.value === normalized)) return normalized;
  return "medium";
}

export const CODEX_SERVICE_TIERS = [
  { value: "", label: "Standard" },
  { value: "fast", label: "Fast" },
] as const;

export function modelOptionsForRuntime(runtime: string, currentModel = "") {
  const models = RUNTIME_PRESETS[runtime]?.models ?? [];
  if (!currentModel || models.includes(currentModel)) return models;
  return [currentModel, ...models];
}

export function modelLabel(model: string) {
  return MODEL_LABELS[model] ?? model;
}
