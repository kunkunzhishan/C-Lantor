# USYNC-0002 commit-by-commit review

Date: 2026-05-28
Local commit reviewed: `1cc0636` `Port upstream sync safeguards`
Upstream main range reviewed: `c79e648..7fe2c45`

Scope: main implementation paths first. Tests are noted only where they show obvious coverage gaps.

## Summary

No main-code gap found for the 12 non-merge commits in `upstream/main` range `c79e648..7fe2c45`.

The most important finding is expectation-related: `b68a7d5` / `7fe2c45` implement a publish freshness gate, not a strict speaker queue. The local code is aligned with upstream main for that behavior, so "agents always speak in order" is not something this upstream-main window provides.

There are two follow-up risks:

1. Upstream `b68a7d5` added many `runtime_streaming` regression tests. The local tree has the #98 side-effect-only tests and several existing streaming tests, but many #95 test names are not ported as named coverage.
2. Loose local git objects `3a1dc78` (`Add agent room coordination safeguards`) and `1f97615` (`Publish revalidated held drafts in final order`) look related to stricter room/order behavior, but they are not contained by `upstream/main` or any current remote ref according to `git branch --all --contains`. I did not count them as part of the `upstream/main` sync window.

## Commit review

Strict pass note: this section reviews 12 non-merge upstream commits one by one. The range also contains merge commit `f88312a`, but it only merges `a0e277e` and has no separate feature beyond that commit.

| Upstream commit | Verdict | Notes |
| --- | --- | --- |
| `e33c46b` Fix mobile channel management flows | Aligned | Local `CreateChannelModal`, `main.tsx`, and mobile styles include channel creation with selected agents and mobile-safe create flow. |
| `50aad3a` fix mobile home | Aligned | Local `main.tsx` has mobile sidebar focus/home handling and reset paths. |
| `40ffe1f` Surface trigger source in Activity view and dock chip (#11) | Aligned | Local activity dock/drawer show source-kind metadata; backend/work item source fields already feed the UI. |
| `8028d11` Coalesce ephemeral activity/run upserts on the frontend (#82) | Aligned | Local `main.tsx` buffers ephemeral activity/run events and flushes them together. |
| `95ef9be` optimize mobile UX | Aligned | Mobile nav/sidebar/thread/agent-panel behavior is present, with local call-mode additions layered on top. |
| `c1cdb24` Increase message preview limits | Aligned | Channel and thread preview limits are `24` lines / `4000` chars. |
| `311a3d9` Close agent detail when switching channels | Aligned | Channel navigation paths clear `selectedAgentId`. |
| `23c000b` Wire thread activity bootstrap into frontend (#92) | Aligned, fork-enhanced | Local backend/frontend use `thread_activities`; schema differs from upstream by using `reply_count`, `latest_visible_message_id`, and `latest_visible_at`, which matches the local UI's needs. |
| `f30d91a` Improve recent activity run collapsing (#93) | Aligned | Local agent drawer groups activity by run and uses source-kind display. |
| `a0e277e` Scroll collapsed thread messages into view | Aligned | Local thread panel tracks collapsed message ids and calls `scrollIntoView` after collapse. |
| `b68a7d5` Implement agent publish gate MVP (#95) | Main code aligned; coverage gap | `publish_guard.rs` matches upstream main apart from local import structure and the intentional call-dispatch bypass. Streaming append/finish hooks, `agent_output_buffers`, visible side-effect buffering, prompts, and control event handling are present. Missing named #95 regression tests remain a risk. |
| `7fe2c45` Guard revise resolution for side-effect-only interrupted actions (#98) | Aligned | Local `InterruptedActionKind` rejects `revise` for side-effect-only buffers before state mutation, and the inbox prompt exposes only allowed actions. |

## Strict per-commit evidence

| Commit | Upstream changed | Local evidence checked | Gap |
| --- | --- | --- | --- |
| `e33c46b` | Create-channel modal mobile flow: no keyboard auto-focus on touch, create-agent escape hatch, selected agents during creation, duplicate/submitting states, mobile home return. | `CreateChannelModal.tsx` has touch-safe autofocus, submitting/error state, create-first-agent flow, Add/Added agent rows. `main.tsx` has `returnToCreateChannelAfterAgent`, `createChannelOpenedFromMobileHomeRef`, duplicate name guard, preferred active channel refresh, and mobile-home return. CSS has modal picker/error/mobile input support. | No main-code gap found. Local version is a superset because it also layers later duplicate-name and call-mode changes. |
| `50aad3a` | Mobile home/history behavior: avoid desktop history stack on mobile, keep modal/sidebar navigation sane, return to mobile home instead of accidentally opening panels. | `main.tsx` disables app-history back/forward on mobile, resets browser state on mobile, has `isMobileHomeOpen` / `returnToMobileHome`, preserves mobile home when opening settings/diagnostics/profile, and routes create-agent/create-channel returns explicitly. | No main-code gap found. |
| `40ffe1f` | Surface trigger source in activity dock/drawer: source kind icon/label, contextual path, source message preview, jump to source, missing-source fallback. | `ActivityProgressDock.tsx` exposes `sourceKindMeta`, jumpable dock button, queued surface work, and source-kind coloring. `AgentDetailDrawer.tsx` groups recent activity runs with trigger metadata and preview. `main.tsx` `openWorkItem(item, focusedMessageIdOverride)` focuses source messages or reports missing source. `Conversation.tsx` and `ThreadPanel.tsx` pass `onOpenWorkItem`. | No main-code gap found. |
| `8028d11` | Coalesce ephemeral `activity_upsert` and non-terminal `agent_run_upsert` frontend updates by RAF / 80 ms fallback; terminal run states still immediate. | `main.tsx` has `ephemeralActivityBufferRef`, `ephemeralRunBufferRef`, `scheduleEphemeralFlush`, `EPHEMERAL_FLUSH_FALLBACK_MS = 80`, and `RUN_TERMINAL_STATUSES`. Handler buffers activity/non-terminal run events and immediately applies terminal runs, messages, work items, artifacts, and call events. | No main-code gap found. Local terminal set additionally includes `exited`, which is a fork-safe superset. |
| `95ef9be` | Mobile UX polish: side panel swipe/back behavior, no browser history on mobile, better channel/agent/create flows, mobile input sizing. | `main.tsx` has `mobileDragSurface`, right-panel active classes, panel/sidebar drag split, mobile `navigateBack` fallback behavior, create-channel/create-agent mobile return refs, and selected-agent clearing. CSS has mobile input `font-size: 16px`, right-panel transform during drag, and compact mobile action controls. | No main-code gap found. This overlaps with `e33c46b` / `50aad3a` in local code. |
| `c1cdb24` | Increase collapsed message preview limits. | `Conversation.tsx` and `ThreadPanel.tsx` use larger preview limits: 24 lines and 4000 chars for channel/thread previews. | No gap. |
| `311a3d9` | Close agent detail when switching channels. | `main.tsx::selectChannel` calls `setSelectedAgentId(null)` before switching channel and hiding sidebar. DM open path also clears selected agent. | No gap. |
| `23c000b` | Thread activity bootstrap: backend `thread_activities`, unread/activity ordering, visible message filtering, NULL-safe read markers, persisted thread read markers from Activity Feed. | Local fork keeps this in `main.rs` / `models.rs` instead of upstream's split `bootstrap.rs` / `channels.rs`. Checked `load_thread_activities`, `ThreadActivity` model, bootstrap payload, `types.ts`, `threadReplySummaries`, thread sorting by `latest_visible_at`, unread logic, `persistThreadRead`, and `persistThreadReads` from Activity Feed mark-read paths. | No main-code gap found. Schema differs intentionally: local uses `reply_count`, `latest_visible_message_id`, and `latest_visible_at`, which fit the current UI. |
| `f30d91a` | Improve recent activity run collapsing in agent drawer. | `AgentDetailDrawer.tsx` groups activity by run/work item, shows source kind, path, preview, retrying state, jump/open action, and queue notes. CSS contains `activity-run-*` styles and source-kind colors. | No gap. Local implementation includes richer source metadata from `40ffe1f`. |
| `a0e277e` | Scroll collapsed thread messages into view after "Show less". | `ThreadPanel.tsx` tracks `pendingCollapsedThreadMessageId`, stores message refs, and uses `scrollIntoView` after collapse. Merge commit `f88312a` contains the same feature and needs no separate port. | No gap. |
| `b68a7d5` | Publish gate MVP: base thread version in inbox payloads, `agent_output_buffers`, public output freshness/ownership checks, streaming hold path, visible control-event buffering, interrupted-action inbox item, revise/yield/force-send resolution. | Local `publish_guard.rs` is equivalent to upstream after #95/#98, with only import reshaping and an intentional `call_dispatch_id` bypass. `inbox.rs` adds base thread version and interrupted-action context. `main.rs` creates `agent_output_buffers`, gates streaming append/control events through `can_publish_public_output`, buffers visible side effects, resolves `interrupted_action_resolve`, and bumps thread versions. Runtime turn files call into the local streaming path through the fork's existing architecture. | Main code aligned. Not a strict speaker queue. Named upstream #95 runtime-streaming tests are not all ported. |
| `7fe2c45` | Prevent `revise` on side-effect-only interrupted actions; prompt only lists allowed actions; preserve held side effects on invalid resolve. | `publish_guard.rs` has `InterruptedActionKind`, derives `allowed_actions` from buffer shape, rejects disallowed actions before mutating state, and keeps `held_visible_events` intact. `inbox.rs` renders allowed actions and omits revise protocol for visible-control-event interruptions. `prompts.rs` instructs agents to choose only from `allowed_actions`. Local tests for this behavior exist in `main.rs` because the fork has relocated tests. | No main-code gap found. |

## Main-code checks

Publish gate:

- `src-tauri/src/publish_guard.rs` is effectively upstream-main equivalent, plus local `work_item_is_call_dispatch` bypass so call-mode dispatches are not held by this gate.
- `can_publish_public_output` gates only visible actions and checks task ownership plus thread version. It does not serialize speakers beyond freshness/version checks.
- `append_streaming_agent_message_inner` gates before creating the first visible streaming message. Once a visible streaming message exists, deltas append to that message; upstream main behaves the same.
- `finish_streaming_agent_message_inner` finalizes existing visible streams and only continues buffering if an `agent_output_buffers` entry already exists for that stream key.

Side-effect-only revise guard:

- `resolve_interrupted_action` now derives the held buffer kind from body/events and rejects actions not in `allowed_actions` before clearing `held_visible_events`.
- This covers the #98 bug: side-effect-only interrupted actions cannot be revised in a way that drops held visible events.

Thread activity bootstrap:

- Local implementation uses `backend_visible_message_sql`, excludes invisible/held/empty runtime messages, counts visible replies, and reports latest visible message metadata.
- This is compatible with the local `ActivityFeed` / thread summary model even though the field names differ from upstream #92.

## Gaps / risks

### P1: Strict ordered speaking is not in this synced upstream-main window

The current local implementation can hold stale output when the thread version changed, but it is not a room/speaker queue. This is visible in `can_publish_public_output`: the decision is based on ownership and base/current thread version, not on a global "who gets to speak next" queue.

Expected behavior from this sync: fewer stale replies and fewer mismatched visible side effects.

Not guaranteed by this sync: all agents in the same room taking turns in final display order.

### P2: #95 test coverage was not fully ported

Upstream #95 contains named runtime-streaming tests for placeholder gating, revise on same stream key, side-effect holding, source-surface freshness, repeated held event aggregation, and force-send replay. Local code appears to implement the corresponding main paths, but the tests are not present as the same named coverage.

User said tests are not the priority for this review, so this is not a main-code blocker. It is still worth adding if this feature becomes central.

### P2: Non-main order/revalidation commits need a separate decision

These commits exist in the local object database:

- `3a1dc78` `Add agent room coordination safeguards`
- `1f97615` `Publish revalidated held drafts in final order`
- `24ced84` `Sync current layout control count`

They are not in `upstream/main`, and `git branch --all --contains` did not find a branch containing `3a1dc78` or `1f97615`. They look like an older/experimental held-draft/revalidation line, not the current `publish_guard` mainline. If the desired upstream experience is specifically "按顺序说话", these should be reviewed as a separate target instead of treating `b68a7d5` as sufficient.

## Follow-up review: loose local room/revalidation commits

Reviewed after the first pass because they are the closest match to the "按顺序说话" expectation:

| Commit | Status in current tree | Review |
| --- | --- | --- |
| `3a1dc78` `Add agent room coordination safeguards` | Not ported as-is | This is a local `xxhx` commit from 2026-05-27, not an upstream-main commit. It implements an older `agent_held_drafts` design with `held_draft_action`, `needs_revalidation`, hidden `delivery_state = 'held'` messages, and revalidation work items. Current tree does not have `agent_held_drafts` or `held_draft_action`; the equivalent mainline concept is now `publish_guard` + `agent_output_buffers` + `interrupted_action_resolve`. |
| `1f97615` `Publish revalidated held drafts in final order` | Not ported as-is | This is a fix on top of the old `agent_held_drafts` design. It publishes revised / send-as-is drafts as final visible messages after interleaving messages, so stale text does not appear in its original older position. Current `publish_guard` revise path repins base thread version and asks the agent to emit a fresh visible reply, which also appears at the later order. The exact old held-draft final-order code is absent because the old held-draft storage model is absent. |
| `24ced84` `Sync current layout control count` | Not relevant to coordination | CSS-only layout count update. No agent coordination behavior. |

### What current mainline has instead

Current tree has:

- `agent_output_buffers` table, not `agent_held_drafts`.
- `interrupted_action` inbox items, not `held_draft_revalidation` work items.
- `interrupted_action_resolve` events, not `held_draft_action`.
- `base_thread_version` freshness markers on inbox payloads, not `reply_basis_message_id` / `reply_basis_message_rowid` columns on work items.
- side-effect buffering for visible control events, which the old held-draft design did not cover as generally.

So the old room-coordination commits are not missing from `upstream/main`; they are a different earlier design line. Porting them literally would conflict with / duplicate the newer publish-guard architecture.

### Real missing pieces from `3a1dc78` if we want that full UX

Current tree does not appear to have these auxiliary parts from `3a1dc78`:

1. `agent-inspect` diagnostics for `running_turn_followups`.
   - Old commit surfaced follow-up work items attached to a still-running turn in the context tool output.
   - Current tree only has the newer inbox wake machinery; I did not find the same `running_turn_followups:` diagnostic output.

2. `agent-inspect` diagnostics for `suspected_suspended_runtime`.
   - Old commit surfaced a stuck/suspended warm runtime state in context-tool inspection.
   - Current tree does not have that diagnostic string/path.

3. The exact `held_draft_action` protocol.
   - This is intentionally superseded by `interrupted_action_resolve`, but if any prompt/post still expects `held_draft_action`, it will not work in current mainline.

### Conclusion for "按顺序说话"

The closest old-line behavior was: finish draft -> hide stale draft -> queue revalidation -> later publish revised/send-as-is at the current end of the thread. That can feel more ordered because stale drafts do not appear in their original position.

Current publish-guard design should get similar behavior only when the stale output is held before visible streaming begins, or when the agent revises through `interrupted_action_resolve`. It still does not provide a strict speaker queue. If strict room turn-taking is the desired product behavior, it needs a new implementation on top of publish guard, not a literal cherry-pick of `3a1dc78`.

## Follow-up review: USYNC-0001 stale candidate list

`docs/upstream-sync-candidates.md` was written against local `c2a1c9f` and is stale for current `codex/new`. I checked the previously marked P1/P2 items against current main paths:

| Candidate | Old status in candidate doc | Current review |
| --- | --- | --- |
| `F09` activity feed unread-first sorting | `未做` | Done. `ActivityFeedModal` has `sortActivityFeedItems`, pending-new-activity handling, and unread row styling. |
| `F10` thread feed latest-reply sorting | `未做完整版本` | Done. `main.tsx` uses `threadReplySummaries` plus `thread_activities.latest_visible_at` to sort thread roots by latest reply/activity. |
| `F11` duplicate channel name guard | `未做完整版本` | Done. `create_channel_in_pool` / `update_channel_in_pool` call `ensure_channel_name_available`, with duplicate create/rename tests. |
| `F12` desktop bottom-follow behavior | `未做完整版本` | Done enough. `Conversation` has bottom anchor, `ResizeObserver`, at-bottom checks, and guarded follow behavior. |
| `F13` search result pane close behavior | `未做` | Done. `main.tsx` tracks `searchResultAgentIdRef` and clears search modal/pane state on close/navigation. |
| `F14` mobile image preview / channel layout polish | `未做完整版本` | Done. `MessageAttachments` has stopPropagation, popstate close, and lightbox safe-area CSS. Mobile channel/agent layout also exists in the current tree. |
| `F15` thread bottom follow / back-to-bottom placement | `未做完整版本` | Done. `ThreadPanel` has thread bottom anchor, `ResizeObserver`, bottom-follow state, and a `thread-back-to-bottom` button outside the scroll content. |
| `F16` UI refresh metrics / diagnostics | `未做` | Done. `main.tsx` records refresh metrics and exposes `window.__LANTOR_REFRESH_METRICS__`; backend writes `ui-refresh-metrics.jsonl` via `record_ui_refresh_metric`. |
| `F17` ephemeral stream/activity/run update batching | `未做` | Done. `main.tsx` buffers activity/run upserts with RAF + timer; backend also coalesces adjacent message deltas. |
| `F18` 4-step UI text scale | `未做` | Done. `SettingsModal` exposes chat text size, `main.tsx` persists `lantor.chatTextSize`, and CSS has the settings controls. |

### Updated conclusion for USYNC-0001

The old candidate doc should no longer be used as a truth source for "what remains". For current `codex/new`, the listed USYNC-0001 P1/P2 items are implemented or superseded. I did not find a fresh main-code gap in this pass.

The remaining risks from this whole review are now narrower:

1. `#95` test coverage is still weaker than upstream's named regression suite.
2. Strict room/speaker queue behavior is not provided by either the synced upstream-main publish gate or the current local code.
3. The old `3a1dc78` diagnostics (`running_turn_followups`, `suspected_suspended_runtime`) are not present in current context-tool output and may be worth restoring independently if useful.
