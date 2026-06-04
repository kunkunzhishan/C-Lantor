use std::{fs, path::PathBuf};

use uuid::Uuid;

use crate::CommandResult;

pub(crate) mod call;
pub(crate) mod event_ingest;
pub(crate) mod inbox;
mod memory;
mod policy;
mod tools;

pub(crate) const WORK_ITEM_FINISH_PROMPT: &str = "Finish behavior: warm streaming runtimes should answer with normal assistant text; stdout command runtimes should use the visible reply event template from the turn context. Only update task status when this request is tied to an explicit task number.";

fn build_work_item_prompt_inner(
    work_item_id: Uuid,
    title: &str,
    context: &str,
    channel_name: Option<&str>,
    channel_description: Option<&str>,
    task_number: Option<i64>,
    thread_root_id: Option<Uuid>,
    available_agents: &[String],
    agent_profile_hint: Option<&str>,
    include_standing_context: bool,
) -> String {
    let mut lines = vec![
        "Current Lantor inbox processing turn:".to_owned(),
        format!("id: {work_item_id}"),
        format!("title: {title}"),
    ];
    if let Some(channel_name) = channel_name {
        lines.push(format!("channel: #{channel_name}"));
    }
    if let Some(channel_description) = channel_description
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("channel_description: {channel_description}"));
    }
    if let Some(task_number) = task_number {
        lines.push(format!("task: #{task_number}"));
    }
    if let Some(thread_root_id) = thread_root_id {
        lines.push(format!("thread_root_id: {thread_root_id}"));
    }
    if !available_agents.is_empty() {
        lines.push("available_agents_in_channel:".to_owned());
        for agent in available_agents {
            lines.push(format!("- {agent}"));
        }
        lines.push(
            "If you need input from another agent, mention their @handle in your visible reply. Lantor will dispatch them in this same thread. Use this sparingly, and never mention yourself for delegation."
            .to_owned(),
        );
    }
    if include_standing_context {
        lines.push(policy::operating_policy_prompt().to_owned());
        lines.push(memory::memory_management_prompt().to_owned());
    } else {
        lines.push("Standing instructions are already installed for this warm runtime. Handle the current request directly, but treat the inbox message and its thread as authoritative over older warm-runtime context. Same-channel/thread follow-ups may be delivered into this active turn; treat them as newer input for this live conversation. If the latest owner message explicitly mentions another agent and does not mention you, do not perform the requested work; treat it as assigned to the mentioned agent and reply silently unless directly asked to acknowledge. Use Lantor context tools only when needed, archive handled inbox items, and keep visible replies concise.".to_owned());
    }
    if let Some(agent_profile_hint) = agent_profile_hint {
        let agent_profile_hint = agent_profile_hint.trim();
        if !agent_profile_hint.is_empty() {
            lines.push("agent_profile_hint:".to_owned());
            lines.push(agent_profile_hint.to_owned());
        }
    }
    if !context.trim().is_empty() {
        lines.push("context:".to_owned());
        lines.push(context.trim().to_owned());
    }
    if include_standing_context {
        lines.push(tools::context_tools_prompt().to_owned());
        lines.push(tools::dynamic_tools_prompt());
        lines.push(tools::control_api_prompt().to_owned());
    }
    lines.push(WORK_ITEM_FINISH_PROMPT.to_owned());
    lines.join("\n")
}

pub(crate) fn build_work_item_prompt(
    work_item_id: Uuid,
    title: &str,
    context: &str,
    channel_name: Option<&str>,
    channel_description: Option<&str>,
    task_number: Option<i64>,
    thread_root_id: Option<Uuid>,
    available_agents: &[String],
    agent_profile_hint: Option<&str>,
) -> String {
    build_work_item_prompt_inner(
        work_item_id,
        title,
        context,
        channel_name,
        channel_description,
        task_number,
        thread_root_id,
        available_agents,
        agent_profile_hint,
        true,
    )
}

pub(crate) fn build_streaming_work_item_prompt(
    work_item_id: Uuid,
    title: &str,
    context: &str,
    channel_name: Option<&str>,
    channel_description: Option<&str>,
    task_number: Option<i64>,
    thread_root_id: Option<Uuid>,
    available_agents: &[String],
    agent_profile_hint: Option<&str>,
) -> String {
    build_work_item_prompt_inner(
        work_item_id,
        title,
        context,
        channel_name,
        channel_description,
        task_number,
        thread_root_id,
        available_agents,
        agent_profile_hint,
        false,
    )
}

pub(crate) fn ensure_agent_workspace(working_directory: &str, handle: &str) -> CommandResult<()> {
    let working_directory = working_directory.trim();
    if working_directory.is_empty() {
        return Ok(());
    }
    let workspace = PathBuf::from(working_directory);
    fs::create_dir_all(&workspace).map_err(|err| err.to_string())?;
    let notes = workspace.join("notes");
    fs::create_dir_all(&notes).map_err(|err| err.to_string())?;
    let _ = handle;
    Ok(())
}

fn build_runtime_standing_prompt(
    handle: &str,
    transport_note: &str,
    memory_context: Option<&str>,
) -> String {
    let mut prompt = format!(
        "You are @{handle}, a local agent running inside Lantor.\n\
         You collaborate with one local human through channels, threads, tasks, and DMs.\n\
         {transport_note}\n\
         Lantor keeps one warm runtime session per agent so previous turns remain in provider context; channel and thread are delivered as message envelope fields, not as separate runtime sessions.\n\
         Each wake turn may contain a compact inbox processing prompt instead of a full request. Handle the default inbox item directly from that prompt when it has enough detail; use inbox-read only for missing source details, and inbox-list only when you need to choose among multiple active items. Current work-item inbox items are archived automatically when the work item finishes; use inbox-archive only for unrelated or extra active items you intentionally clear. Do not assume the wake prompt is an exhaustive transcript; rely on the active runtime session and injected memory when older durable context is needed. Use history/search only for evidence retrieval or exact source verification. Use workspace-info or workspace-list when you need to recover your current Lantor md memory path beyond the injected prompt excerpt.\n\
         \n\
         {}\n\
         \n\
         {}\n\
         \n\
         {}\n\
         \n\
         {}\n\
         \n\
         {}\n\
         \n\
         {}\n\
         \n\
         {}\n\
         \n\
         Keep user-visible replies concise and include concrete results or blockers. Non-message LANTOR_EVENT control lines are allowed as standalone lines. Do not print LANTOR_EVENT message lines unless explicitly asked to debug the stdout command path.",
        policy::operating_policy_prompt(),
        policy::turn_startup_sequence_prompt(),
        memory::memory_management_prompt(),
        tools::context_tools_prompt(),
        &tools::dynamic_tools_prompt(),
        policy::live_delivery_prompt(),
        tools::control_api_prompt(),
    );
    if let Some(memory_context) = memory_context.filter(|context| !context.trim().is_empty()) {
        prompt.push_str("\n\n");
        prompt.push_str(memory_context.trim());
    }
    prompt
}

pub(crate) fn build_codex_streaming_prompt(prompt: &str) -> String {
    if prompt.trim().is_empty() {
        return "No current Lantor agent request is assigned. Reply with a short ready status."
            .to_owned();
    }
    let prompt = prompt.replace(
        WORK_ITEM_FINISH_PROMPT,
        &policy::streaming_reply_contract_prompt("Codex"),
    );
    format!(
        "{prompt}\n\n{}",
        policy::streaming_activity_guidance_prompt()
    )
}

pub(crate) fn build_claude_streaming_prompt(prompt: &str) -> String {
    if prompt.trim().is_empty() {
        return "No current Lantor agent request is assigned. Reply with a short ready status."
            .to_owned();
    }
    let prompt = prompt.replace(
        WORK_ITEM_FINISH_PROMPT,
        &policy::streaming_reply_contract_prompt("Claude"),
    );
    format!(
        "{prompt}\n\n{}",
        policy::streaming_activity_guidance_prompt()
    )
}

pub(crate) fn codex_developer_instructions(handle: &str, memory_context: Option<&str>) -> String {
    build_runtime_standing_prompt(
        handle,
        "Lantor is connected to Codex through the official app-server JSON protocol and streams your assistant text into chat automatically.",
        memory_context,
    )
}

pub(crate) fn claude_system_prompt(handle: &str, memory_context: Option<&str>) -> String {
    build_runtime_standing_prompt(
        handle,
        "Lantor is connected to Claude through Claude Code stream-json and streams your assistant text into chat automatically.",
        memory_context,
    )
}
