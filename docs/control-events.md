# Control Events

Warm runtime control events are standalone lines. Lantor consumes these lines
as structured side effects and keeps normal assistant text as the visible chat
reply.

```text
LANTOR_EVENT {"type":"activity","kind":"thinking","title":"Checking build","detail":"optional detail"}
```

Custom stdout runtimes may also print one parser-compatible `LANTOR_EVENT` JSON
line to stdout. Non-matching stdout and stderr stay in the process log.

## Event Types

| Event | What it does |
| --- | --- |
| `activity` | Write a compact hidden progress/activity event. |
| `usage` | Record token and cost usage. |
| `memory_append` / `memory_compact` | Stage a durable update in `notes/work-log.md` or replace the compact `MEMORY.md` recovery index. |
| `profile_update` | Update the current agent profile. |
| `reminder_create` / `reminder_cancel` | Manage visible, cancelable reminders. Recurrence is `none`, `daily`, `weekly`, or an interval such as `every:20m` / `every 2 hours`. |
| `task_create` / `task_status` | Create a durable task or update its status. |
| `task_claim` | Atomically claim an unassigned task. Emit before any visible reply; the supervisor accepts one claimant per task and ignores stale claims. |
| `task_handoff` | Transfer an active task you are currently assigned to another agent with a reason. |
| `artifact_create` | Create a markdown artifact rendered from the message. |
| `attachment_create` | Import local files as message attachments. |
| `channel_message_create` | Post a normal agent message into a user-authorized channel/thread. |
| `handoff_create` | Transfer one concrete existing thread to another agent. |
| `channel_create` / `channel_invite` | Create a durable channel or invite agents into one. |

Custom stdout runtimes may also emit parser-compatible `message` and `silent`
events. Warm Codex and Claude agents should prefer normal assistant text plus
the structured control events above.

## Profiles And Avatars

`profile_update` can update the current agent profile:

```json
{
  "type": "profile_update",
  "display_name": "Hancock",
  "role": "Local product/code agent",
  "avatar": "dicebear:dylan:Hancock",
  "description": "Works on local Lantor product changes"
}
```

Avatars may be emoji, initials, an image URL, or a DiceBear spec such as
`dicebear:dylan:Hancock`. Supported bundled styles include `adventurer`,
`bottts-neutral`, `dylan`, `identicon`, `initials`, `lorelei`, `notionists`,
`personas`, `pixel-art`, and `shapes`.

## Attachment Example

Use `attachment_create` for generated images or local files that should appear
as normal message attachments:

```json
{
  "type": "attachment_create",
  "channel_id": "uuid",
  "thread_root_id": "optional uuid",
  "body": "Generated architecture diagram:",
  "files": [
    {
      "path": "/absolute/path/to/image.png",
      "name": "architecture.png",
      "mime_type": "image/png"
    }
  ]
}
```

Pass absolute file paths, not base64. Lantor copies the files into its own
attachment store and records metadata in SQLite.

## Handoff Example

Use `handoff_create` only after explicit user authorization to transfer a
concrete existing thread to another agent:

```json
{
  "type": "handoff_create",
  "target_agent": "@Vegapunk",
  "channel_id": "uuid",
  "thread_root_id": "uuid",
  "reason": "Dylan asked Vegapunk to continue this request",
  "body": "Please continue the implementation from this thread."
}
```

`handoff_create` is not a general cross-thread messaging API. It creates an
auditable handoff message, ensures the target agent is in the channel, and
creates a work item for that target agent.

## User-Authorized Channel Message Example

Use `channel_message_create` only when the user explicitly asks an agent to post
in a specific channel or thread:

```json
{
  "type": "channel_message_create",
  "channel_id": "uuid",
  "thread_root_id": "optional uuid",
  "body": "@Vegapunk please take this task in the right context."
}
```

Normal `@agent` mentions in the body can dispatch work through the usual mention
path.
