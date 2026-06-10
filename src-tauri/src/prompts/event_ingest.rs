pub(crate) fn memory_event_ingest_task(
    created_at: &str,
    agent_id: &str,
    events_dir: &str,
    inputs: &[String],
) -> String {
    let summary_path = format!("{events_dir}/summary.md");
    let mut lines = vec![
        "# Memory Event Ingest Task".to_owned(),
        String::new(),
        format!("Created: {created_at}"),
        format!("Agent: {agent_id}"),
        String::new(),
        "## Directories".to_owned(),
        String::new(),
        "- Realtime input segments: `memory/realtime/`".to_owned(),
        format!("- Long-term event memory: `memory/{events_dir}/`"),
        format!("- Event summary index: `memory/{summary_path}`"),
        "- Event detail files live under the long-term event memory directory. Create or update one markdown file per event as needed.".to_owned(),
        String::new(),
        "## Input Segments".to_owned(),
        String::new(),
    ];
    lines.extend(inputs.iter().map(|input| format!("- {input}")));
    lines.push(String::new());
    lines.push("## Codex Task".to_owned());
    lines.push(String::new());
    lines.push(
        "Read the input realtime segments and merge them into the event memory directory."
            .to_owned(),
    );
    lines.push(String::new());
    lines.push("The realtime segments are the source of truth for this task. They contain agent-written run summaries plus `Sources:` references. `Sources:` is system-written and should contain only `message:<uuid>` or `call_utterance:<uuid>` entries. Agents may include `Provenance:` lines inside the item body as best-effort follow-up hints; provenance is agent-written and should not be treated as guaranteed evidence. Do not fetch raw source messages from the database; use the realtime items as written.".to_owned());
    lines.push(String::new());
    lines.push("Use `summary.md` as the event index. Each compression must compress the existing summary together with the new incoming content. Content for the same event must be merged into one summary, while new events must create new summaries. Keep the event timeline and context coherent. Keep one start time and one end time, and generate a merged event summary.".to_owned());
    lines.push("Use event detail markdown files for the event body. If the input belongs to an existing event, move the matching realtime items into that event's detail file one by one without rewriting or shortening them. If the input describes a new event, create a new event detail markdown file in the event memory directory and add it to `summary.md` as a new event.".to_owned());
    lines.push("Convert from realtime order to event order. One input segment can contribute to multiple events, and multiple input segments can update the same event. Do not move content just because it is recent; merge by matching the same event.".to_owned());
    lines.push("After all event writes succeed, delete the input realtime segment files. If anything is uncertain or fails, leave the inputs in place so a later event_ingest work item can retry.".to_owned());
    lines.push(String::new());
    lines.push("## `summary.md` Event Format".to_owned());
    lines.push(String::new());
    lines.push("Keep one section per event. Use this simple shape:".to_owned());
    lines.push(String::new());
    lines.push("```md".to_owned());
    lines.push("## <event title>".to_owned());
    lines.push("Start: <first relevant time>".to_owned());
    lines.push("End: <last relevant time>".to_owned());
    lines.push(
        "Sources: <deduplicated `message:<uuid>` or `call_utterance:<uuid>` values from the matching realtime items>"
            .to_owned(),
    );
    lines.push(
        "Summary: <merged concise event summary. Preserve event causality, timeline, and what you think a compressed memory summary should contain>"
            .to_owned(),
    );
    lines.push("```".to_owned());
    lines.push(String::new());
    lines.push("## Event Detail Item Format".to_owned());
    lines.push(String::new());
    lines.push("Move matching realtime items into the matching event detail file one by one. Keep each moved item unchanged. Do not synthesize `Provenance:`; only preserve provenance if the agent already wrote it in the realtime item body:".to_owned());
    lines.push(String::new());
    lines.push("```md".to_owned());
    lines.push("<full realtime item, unchanged>".to_owned());
    lines.push("```".to_owned());
    lines.push(String::new());
    lines.join("\n")
}
