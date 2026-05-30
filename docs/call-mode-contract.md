# Call Mode Contract

Call Mode is a live command center for one human directing Lantor agents by
voice. It is not a composer dictation feature. A call session continuously
accepts utterances, transcribes each accepted utterance, hands the transcript
and call state to the Call Dispatcher Agent, records the Dispatcher response,
and links any delegated background work without waiting for that work to finish.

The architectural boundary is:

```text
Call Shell -> STT text + call state -> Call Dispatcher Agent -> Lantor tools
```

The Call Shell owns audio capture, utterance persistence, TTS, UI state, and
session lifecycle. It does not infer business intent from natural-language
phrases. The Dispatcher Agent reads the utterance, active call work, pending
confirmations, recent call turns, thread context, and available agents, then
chooses a tool. Lantor tools provide generic capabilities such as speaking to
the call, asking the user, dispatching agent work, and cancelling call-linked
work.

This document locks the MVP product and data decisions that later schema,
backend, and UI work should implement.

## MVP Decisions

- Call utterances are persisted in Call Mode tables only. They do not become
  normal channel messages by default.
- A coordinator-created agent work item may still create the usual inbox/work
  item records. The call timeline links to that work item through the dispatch
  row instead of duplicating the utterance as chat.
- The accepted Call Mode path is Start Call -> active microphone listening ->
  live utterance capture -> transcript/ACK/work updates. Users do not press a
  per-utterance Record or Commit control during the primary flow.
- The first live utterance boundary is short browser `MediaRecorder` segments
  submitted automatically while the call is active. Automatic VAD can replace
  the segmenter after the contract is stable.
- The MVP transcription provider reuses the existing voice transcription
  backend. Primary acceptance evidence should use real microphone capture and a
  non-deterministic provider. Deterministic `LANTOR_TRANSCRIPT:` payloads remain
  available only for automated backend tests.
- The default Call Mode STT language hint is `en-US`, matching the primary
  smoke script and browser TTS language choice for English ACKs. Product-localized
  call languages can be passed explicitly later.
- The reproducible final MVP smoke setup is documented in
  [Call Mode Smoke Recipe](call-mode-smoke.md).
- Continuous capture uses a browser `MediaRecorder` provider in the Tauri
  WebView or secure local browser and submits live audio segments to
  `call_session_submit_utterance`. Native code owns desktop microphone and
  speech-recognition permission prompts; it does not own the live capture loop
  in the MVP.
- The first user-visible surface is a first-class call session view with a call
  timeline and work board. It is entered from the conversation surface but is
  not the textarea draft.
- Every accepted utterance creates exactly one Dispatcher response before worker
  completion is observed.
- The Dispatcher may wait for transcription, database inserts, and enqueueing a
  work item or long task request. It must not wait for an agent run, CodexLoop,
  or any other background worker to complete.
- Mid-call edits, cancellation, and reassignment are interpreted by the
  Dispatcher Agent using call state. Backend code must not hardcode spoken
  phrase tables for these intents.

## Core Records

`call_sessions`

| Field | Contract |
| --- | --- |
| `id` | Stable UUID. |
| `channel_id` | Optional channel context where the call was started. |
| `thread_root_id` | Optional thread context where the call was started. |
| `status` | `active`, `ended`, or `error`. Only `active` sessions accept utterances. |
| `title` | Optional user-facing label. |
| `started_at`, `ended_at`, `updated_at` | Local audit and recovery timestamps. |

`call_utterances`

| Field | Contract |
| --- | --- |
| `id` | Stable UUID. |
| `session_id` | Parent call session. |
| `sequence` | Monotonic 1-based sequence within the session. |
| `transcript` | Final transcript text for the captured live utterance segment. |
| `transcription_provider` | Provider name returned by the voice backend. |
| `transcription_error` | Recoverable STT diagnostic when transcription fails. |
| `audio_mime_type`, `audio_original_name`, `audio_duration_ms` | Metadata only; MVP does not store audio bytes. |
| `status` | `transcribing`, `transcribed`, `dispatching`, `dispatched`, `failed`, or `ignored`. |
| `created_at`, `updated_at` | Timestamp for timeline ordering and recovery. |

`call_dispatches`

| Field | Contract |
| --- | --- |
| `id` | Stable UUID. |
| `session_id`, `utterance_id`, `utterance_sequence` | Parent call, source utterance, and timeline sequence. |
| `intent` | Durable tool outcome such as `ack_only`, `agent_work`, `long_task`, `cancel_work`, `reassign_work`, `clarify`, `unsupported`, or `refused`. |
| `ack_status` | One of the ACK states below. |
| `ack_text` | Text-first acknowledgement to show and later speak. |
| `confidence` | `high`, `medium`, or `low` coordinator confidence. |
| `target_agent_id` | Agent selected for work, cancellation, or reassignment when known. |
| `work_item_id` | Linked `agent_work_items.id` after async agent work is created and linked; nullable in the immediate submit ACK. |
| `compensated_work_item_id` | Work item created during async dispatch whose call link failed or drifted; present for both successful rollback and failed compensation diagnostics. |
| `long_task_id` | Linked long task id when a long task is created. |
| `status` | `acknowledged`, `queued`, `needs_user`, `failed`, `compensated`, or `ignored`. |
| `outcome` | Typed timeline taxonomy such as `acknowledged_pending_work`, `work_queued`, `work_link_compensated`, or `dispatch_failed`. |
| `status_text` | Operator-grade display copy for the timeline row. |
| `correlation_key`, `correlation_trail` | Stable visible correlation identifiers connecting call session, utterance sequence, dispatch, target agent, work item, compensated work item, and long task. |
| `error` | Recoverable diagnostic for failed dispatches. |
| `created_at`, `updated_at` | Timeline and audit timestamps. |

`agent_work_items`

Call-created or call-controlled work items expose nullable provenance fields:
`call_session_id`, `call_utterance_id`, and `call_dispatch_id`. These links are
the durable join between the Call Timeline and the existing worker queue.

Call-created work item context is the worker brief. It must include the call
session id/title, dispatch id, utterance id and sequence or turn handle,
transcript excerpt, structured `spoken_request` payload, target agent
id/handle, and Dispatcher response status/text so a worker can execute the request
without reconstructing call state from the UI. The `spoken_request` payload is
JSON-escaped UTF-8 with schema `lantor.call.spoken_request.v1`, original
char/byte lengths, original SHA-256, truncation metadata, and an inline JSON
budget. Normal utterances are preserved in full; oversized utterances are
bounded with an explicit middle omission marker while the checksum continues to
identify the original transcript. When `truncated=true`, the payload must also
include `retrieval_ref` with `call_session_id`, `call_utterance_id`,
`call_dispatch_id`, `turn_handle`, source `call_utterances.transcript`, and a
`call-utterance-read` context-tool command so the worker can fetch the full
persisted transcript without re-inlining omitted text.

If a work item is created but the dispatch-to-work link fails validation or
drifts, Call Mode attempts to cancel the unlinked work item and records the
created item on `compensated_work_item_id`. Queued work that is durably
cancelled emits `work_link_compensated`. Work that has already started must not
be labeled rolled back; it emits `work_link_compensation_failed` with a visible
diagnostic because the worker may still run until the stop request completes.

## ACK States

ACKs are part of the API contract. UI and speech output should render the same
state consistently.

| `ack_status` | Meaning | Worker side effect |
| --- | --- | --- |
| `heard` | Transcript was accepted and the coordinator answered directly. | None. |
| `understood` | Intent has been assigned to a target agent. | May enqueue agent work, create a long task, cancel, or reassign. |
| `needs_target` | The call cannot be assigned because there is no channel agent or no executable request. | None. |
| `needs_confirmation` | The coordinator found a risky or policy-gated operation. | None until the user confirms. |
| `refused` | The utterance requests an action Lantor must not perform. | None. |
| `unsupported` | The intent is plausible but outside the MVP capability. | None. |

Recommended ACK text examples:

- `understood`: `Got it. I assigned this to @Hancock.`
- `needs_target`: `I heard the request, but there is no available agent in this channel.`
- `needs_confirmation`: `I can prepare that change, but I need confirmation before steering an existing long task.`
- `unsupported`: `I heard you, but Call Mode cannot reassign a running work item yet.`

## Command Boundary

The same logical commands should be exposed through Tauri invokes and the local
web API:

```text
call_session_start(channel_id?, thread_root_id?, title?) -> CallSession
call_session_stop(session_id) -> CallSession
call_session_submit_utterance(session_id, bytes, mime_type, original_name?, duration_ms?, language?, final_fragment_reason?) -> CallUtteranceSubmitResult
call_dispatch_resolve_confirmation(session_id, transcript) -> CallUtteranceSubmitResult
call_dispatch_cancel_work(session_id, work_item_id) -> CallUtteranceSubmitResult
call_dispatch_reassign_work(session_id, work_item_id, target_agent_id, reason?) -> CallUtteranceSubmitResult
```

`call_session_submit_utterance` must:

1. reject inactive or unknown sessions;
2. insert one `call_utterances` row before STT with enough metadata to recover
   the timeline if transcription fails;
3. transcribe with the existing voice backend;
4. update the utterance with transcript/provider or a durable failure state;
5. run the Dispatcher Agent when a transcript exists, or create a failed
   ACK dispatch for STT failure;
6. insert one `call_dispatches` row with an ACK;
7. spawn accepted background agent work asynchronously without waiting for
   enqueue/link completion;
8. return the utterance, dispatch, ACK, and any immediately known linked ids.

`final_fragment_reason` is optional and currently accepts `mute` or `end_call`
from the browser `MediaRecorder` final flush. When such a final flush produces a
tiny non-target transcript fragment, Call Mode must preserve the utterance and
create an `ignored` diagnostic dispatch instead of creating a confusing
`needs_target` item. Explicit targets, active work references, confirmations,
and normal live segment rotation are interpreted by the Dispatcher Agent from
context.

The frontend continuous-capture provider boundary is:

```text
browser MediaRecorder -> live segment Blob/bytes -> call_session_submit_utterance -> existing voice backend STT
```

Call entry requests capture permissions and starts live listening as part of
Start Call. The owner-facing path is microphone first; typed deterministic
submissions are not exposed in the Call Mode UI.
In Tauri, the permission preflight requests native microphone permission and
speech recognition permission before asking the WebView for `getUserMedia`.
Outside Tauri, permission is requested through browser `getUserMedia` on HTTPS
or localhost only.

For `agent_work` dispatches, the submit command returns the ACK immediately after
the Dispatcher accepts the utterance. The initial `dispatch.status` is
`acknowledged`, and `work_item_id` is normally `null` until the async worker
enqueue updates the dispatch to `queued` or `failed` through a later
`call_dispatch_*` event.

`call_dispatch_resolve_confirmation` records the user's confirmation text as a
call-control utterance and sends it through the same Dispatcher Agent path as a
spoken utterance. The backend does not parse yes/no/correction phrases.

The return shape is:

```text
CallUtteranceSubmitResult {
  session: CallSession,
  utterance: CallUtterance,
  dispatch: CallDispatch,
  ack_text: string,
  work_item_id: string | null,
  long_task_id: string | null
}
```

## Dispatcher Tools

The Dispatcher Agent chooses tools from call state, not backend phrase rules.
The current tool contract is:

- `speak_to_user`: respond in the call without worker side effects.
- `ask_user`: request missing detail or disambiguation.
- `dispatch_agent_work`: create agent work. It must select a listed agent and
  may provide `request_transcript` when the latest utterance is only a
  confirmation or correction.
- `cancel_call_work`: cancel active call-linked work by `target_work_item_id`
  or `target_request_number` from `active_call_work`.

Backend code validates tool arguments, records durable dispatch rows, and
executes the selected capability. It does not classify natural-language intents
with hardcoded phrase tables.

## UI Contract

The first Call Mode view uses phone-call controls:

- Start Call in the conversation header creates or resumes a call session and
  immediately starts microphone listening.
- The active call surface shows mic state, a mute/unmute control, and End Call.
  It does not show Record/Commit as the primary utterance action.
- The call surface has no typed deterministic utterance control.
- The MVP interruption policy is no-barge during assistant speech. Assistant TTS
  pauses live capture to avoid echo, the surface shows the mic as paused for
  speech, and capture resumes automatically after playback ends.

The view shows two live regions:

- Call Timeline: ordered utterances with transcript, ACK state, ACK text,
  dispatch status, and any failure.
- Work Board: call-linked agent work items and long tasks with current status,
  assignee, cancellation/reassignment affordances, and links to deeper detail.

Ending a call stops recording and marks the session ended; it does not cancel
background work. Work continues to update through existing work item and long
task status events.

## Event Contract

The backend should emit or refresh after these changes:

```text
call_session_upsert
call_utterance_upsert
call_dispatch_upsert
```

Unknown call events may fall back to a full bootstrap refresh during the MVP,
but the payload contracts above remain the source of truth for later typed
frontend state.
