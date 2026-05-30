# Agent Activity Feed

Lantor persists agent activity in `agent_activities` instead of deriving it from
run logs. The feed is queryable product state and can link activity to an agent,
run, message, task, artifact, reminder, or handoff.

It records:

- profile changes
- queued starts, spawned runs, stop requests, and final run status
- accepted or rejected control events
- messages, tasks, artifacts, attachments, reminders, and handoffs created by agents
- task status and assignee changes

Run logs remain useful for process-level debugging. The activity feed is the
product-level audit trail.
