# Call Mode Smoke Recipe

This is the reproducible setup for the owner-facing Call Mode smoke. The
primary proof must use microphone capture through `MediaRecorder`; deterministic
transcription is only for backend tests and is not sufficient for acceptance.
The primary spoken script is English. Call Mode submits live audio with an
`en-US` STT language hint by default, and browser TTS should select an English
voice for ASCII coordinator ACKs and feedback.

## Isolated Backend

Run the backend from a clean shell and keep it running for the UI smoke:

```bash
cd /Users/xxhx/new_sort/lantor-long-task-voice
npm run build

SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lantor-call-mode-smoke.XXXXXX")"
printf 'SMOKE_ROOT=%q\n' "$SMOKE_ROOT"
mkdir -p "$SMOKE_ROOT/attachments" "$SMOKE_ROOT/workspaces/smoke-agent"

export LANTOR_DATABASE_URL="sqlite://$SMOKE_ROOT/lantor.sqlite"
export LANTOR_ATTACHMENT_DIR="$SMOKE_ROOT/attachments"
export LANTOR_WEB_BIND="127.0.0.1:8787"
export LANTOR_WEB_PUBLIC_URL="http://127.0.0.1:8787"
export LANTOR_WEB_DIST="$PWD/dist"

# Primary smoke: use Apple Speech on macOS by leaving the provider unset, or
# configure a real command provider. Do not set deterministic for acceptance.
unset LANTOR_TRANSCRIPTION_PROVIDER
unset LANTOR_TRANSCRIPTION_COMMAND

# Primary smoke: use the default AI-backed Call Mode System Agent coordinator
# and generated feedback. Set *_COMMAND only when testing a compatible local
# generator that reads request JSON on stdin and returns the documented JSON.
unset LANTOR_CALL_COORDINATOR_COMMAND
export LANTOR_CALL_COORDINATOR_MODEL="gpt-5.4-mini"
export LANTOR_CALL_COORDINATOR_REASONING_EFFORT="low"

unset LANTOR_CALL_FEEDBACK_COMMAND
export LANTOR_CALL_FEEDBACK_MODEL="gpt-5.4-mini"
export LANTOR_CALL_FEEDBACK_REASONING_EFFORT="low"

npm run tauri:dev
```

Use a different port in `LANTOR_WEB_BIND` and `LANTOR_WEB_PUBLIC_URL` if
`127.0.0.1:8787` is already occupied. On non-macOS hosts, configure a real
`LANTOR_TRANSCRIPTION_PROVIDER=command` and `LANTOR_TRANSCRIPTION_COMMAND`
before launching.

## Seed Surface

In a second shell, seed the smoke agent and channel through the local API. First
paste and run the exact `SMOKE_ROOT=...` line printed by the backend shell, then
run the commands below:

```bash
BASE="http://127.0.0.1:8787"
: "${SMOKE_ROOT:?paste and run the SMOKE_ROOT=... line printed by the backend shell first}"

AGENT_ID="$(
  curl -fsS "$BASE/api/create_agent" \
    -H "content-type: application/json" \
    -d "{
      \"handle\":\"smoke-agent\",
      \"displayName\":\"Smoke Agent\",
      \"role\":\"Call Mode smoke target\",
      \"runtime\":\"codex\",
      \"model\":\"gpt-5.4-mini\",
      \"reasoningEffort\":\"low\",
      \"serviceTier\":null,
      \"avatar\":null,
      \"description\":\"Call Mode smoke target\",
      \"launchCommand\":\"codex\",
      \"workingDirectory\":\"$SMOKE_ROOT/workspaces/smoke-agent\",
      \"dailyBudgetMicros\":null
    }" | tr -d '"'
)"

CHANNEL_ID="$(
  curl -fsS "$BASE/api/create_channel" \
    -H "content-type: application/json" \
    -d "{
      \"name\":\"call-smoke\",
      \"description\":\"Call Mode MVP smoke channel\",
      \"agentIds\":[\"$AGENT_ID\"]
    }" | sed -n 's/.*"channelId":"\([^"]*\)".*/\1/p'
)"

printf 'seeded call-smoke channel: %s\nseeded @smoke-agent: %s\n' "$CHANNEL_ID" "$AGENT_ID"
```

## UI Smoke

Open `http://127.0.0.1:8787/`, select the seeded `call-smoke` channel, and run
the phone-style Call Mode scenario:

1. Click Start Call from the phone entry in the conversation header.
2. Approve microphone and speech-recognition permissions when prompted.
3. Verify the panel enters the live state and the mic status says Listening.
4. Speak this utterance into the microphone:

   ```text
   @smoke-agent prepare a Call Mode smoke dispatch verification note.
   ```

5. Wait for the live segment to submit automatically. Do not press a
   per-utterance Record or Commit control.
6. Verify the transcript appears in the Call Timeline and the ACK is spoken
   once, after the submitted utterance sequence is available.
7. Verify the immediate coordinator ACK assigns the request to `@smoke-agent`.
8. Verify the Call Work Board shows the call-linked work item and its cancel
   affordance.
9. While the assistant ACK or feedback is speaking, verify the cockpit shows
   `Speaking` / `Mic paused for speech`. The MVP policy is no-barge: caller
   speech during assistant playback is intentionally ignored until playback
   finishes, then continuous capture resumes.
10. Wait for `@smoke-agent` to post a worker reply and verify a generated
   System Agent feedback message appears after that reply.
11. Wait for the call-linked work item to complete and verify a generated
    System Agent completion feedback message appears.
12. Use mute/unmute once and verify the mic state changes without ending the
    call. If the final mute flush captures a tiny trailing word or filler
    fragment, it may appear as an ignored diagnostic timeline row; it must not
    create a `needs_target` dispatch or work-board item.
13. Speak a short presence check and verify the coordinator answers directly
    without creating work.
14. Speak an actionable request without naming an agent and verify the
    coordinator assigns it to a current-channel agent instead of asking which
    agent should handle it.
15. Create a pending-confirmation turn with a long-task steering phrase:

    ```text
    Before you change the current long task, prepare to switch it to a risky new direction.
    ```

    Verify the pending confirmation card appears, then click Confirm and verify
    the result is inserted through `call_dispatch_resolve_confirmation`.
16. Create another pending-confirmation turn, enter this correction in the
    correction field, and submit it:

    ```text
    @smoke-agent instead keep it as a smoke verification note
    ```

    Verify the correction is inserted through the same call-control path and
    the timeline shows the recovery ACK instead of a raw command error.
17. Speak or click cancel for the live call-linked work item:

    ```text
    cancel the smoke-agent request
    ```

    Verify cancellation uses `call_dispatch_cancel_work` or the coordinator
    `cancel_work` dispatch path, and that the work board/timeline show the
    cancelled or stop-requested state.
18. Capture visual evidence at normal width and narrow width. Each screenshot
    should include the cockpit readiness states, pending-confirmation or
    recovery state, and the work board or timeline without clipped controls.
19. End the call session and verify the panel shows the ended state.

## Backend Spot Check

After the UI smoke, this query should show one ended call, at least one
non-deterministic utterance, an acknowledged or queued dispatch, one
call-linked work item, and generated System Agent feedback records with
`call-feedback:` stream keys after worker-reply and completion flows:

```bash
sqlite3 "$SMOKE_ROOT/lantor.sqlite" "
select 'sessions', status, count(*) from call_sessions group by status;
select 'utterance', sequence, transcription_provider, status, transcript from call_utterances order by sequence;
select 'provider_check', count(*) from call_utterances where transcription_provider <> 'deterministic';
select 'dispatch', intent, ack_status, status, work_item_id is not null from call_dispatches order by created_at;
select 'control_path', intent, ack_status, status, error
from call_dispatches
where intent in ('cancel_work', 'reassign_work', 'ack_only')
   or ack_status = 'needs_confirmation'
order by created_at;
select 'work', status, call_session_id is not null, call_utterance_id is not null, call_dispatch_id is not null
from agent_work_items
order by created_at;
select 'feedback', sender_name, sender_role, delivery_state, stream_key, body
from messages
where sender_name = 'System Agent'
  and stream_key like 'call-feedback:%'
order by created_at;
select 'feedback_completion_check', count(*)
from messages
where sender_name = 'System Agent'
  and sender_role = 'system'
  and stream_key like 'call-feedback:%:completion:%';
select 'feedback_worker_reply_check', count(*)
from messages
where sender_name = 'System Agent'
  and sender_role = 'system'
  and stream_key like 'call-feedback:%:worker-reply:%';
"
```

The `provider_check`, `feedback_completion_check`, and
`feedback_worker_reply_check` counts must all be greater than zero for the
primary feedback smoke. Any feedback row must have
`sender_name = 'System Agent'`, `sender_role = 'system'`, and a `stream_key`
beginning with `call-feedback:`.

Stop the dev process when finished, then remove the isolated smoke directory:

```bash
npm run dev:stop
rm -rf "$SMOKE_ROOT"
```
