# Upstream Gap Final Status

This document is a bounded implementation/evidence backfill for the confirmed real upstream gaps completed in the `lantor-long-task` main workspace. It is not a new upstream audit.

Scope:

- Workspace: `/Users/xxhx/new_sort/lantor-long-task`
- Source audit context: `docs/upstream-sync-candidates.md` and `docs/upstream-sync-review-20260528.md`
- Gap range: GAP-F10 through GAP-F18
- Status date: 2026-06-03

## Summary

All confirmed GAP-F10 through GAP-F18 implementation gaps are complete in the working tree. Focused checks, full frontend tests, targeted backend tests where relevant, production builds, and UI-specific fallback visual checks were run as each gap was closed.

The only recurring residual issue is the existing Vite large-chunk warning during `npm run build`; it did not block any build. The in-app Browser backend was unavailable for GAP-F14 visual verification, so that gap used a fallback headless Chrome/CDP mobile viewport check against the local dev server.

## Gap Evidence

| Gap | Implemented behavior | Primary files | Verification evidence | Residual risk |
| --- | --- | --- | --- | --- |
| GAP-F10 | Thread feed and related activity surfaces sort thread roots by latest reply/activity instead of root creation time. | `src/threadActivity.ts`, `src/threadActivity.test.ts`, `src/main.tsx` | `npm test -- src/threadActivity.test.ts` passed with 3 tests; later full `npm test` passed. | Low-priority coverage gap: dedicated bootstrap `latest_visible_at` comparator coverage is not present. The active comparator tests cover latest reply/activity ordering and the implementation uses `thread_activities.latest_visible_at`, so this is not a delivery blocker. |
| GAP-F11 | Duplicate channel names are blocked on create and rename, including backend enforcement and UI feedback. | `src-tauri/src/main.rs`, `src/components/ChannelSettingsModal.tsx`, `src/main.tsx`, `src/styles.css` | Backend duplicate-name tests were added/run during implementation; later full frontend tests and build passed. | None known. |
| GAP-F12 | Desktop conversation bottom-follow behavior keeps the chat pinned when appropriate and exposes stable back-to-bottom behavior when the user has scrolled away. | `src/components/Conversation.tsx`, `src/styles.css` | Focused implementation checks plus later full `npm test` and `npm run build` passed. | No separate browser visual regression was retained for desktop bottom-follow. |
| GAP-F13 | Closing search results clears search-result panel provenance so agent/thread panes do not remain incorrectly open from search navigation. | `src/main.tsx` | Focused source/behavior checks plus later full `npm test` and `npm run build` passed. | None known. |
| GAP-F14 | Mobile image preview and channel layout polish: attachment preview event isolation, popstate/Escape close behavior, safe-area lightbox sizing, compact mobile thumbnails, focused composer spacing, and visible bottom nav. | `src/components/MessageAttachments.tsx`, `src/styles.css` | Source checks passed; `npm test`, `npm run build`, and fallback Chrome/CDP mobile verification at `390x844` passed. Evidence included bottom nav visible, composer/nav overlap `0`, thumbnail `218x124`, and lightbox fitting viewport. | In-app Browser was unavailable, so visual verification used fallback Chrome/CDP rather than the Codex in-app browser. |
| GAP-F15 | Thread panel bottom-follow and back-to-bottom placement were stabilized with bottom anchor/resize observation and a `thread-back-to-bottom` control outside the scroll content. | `src/components/ThreadPanel.tsx`, `src/styles.css` | Focused implementation checks plus later full `npm test` and `npm run build` passed. | None known. |
| GAP-F16 | UI refresh metrics/diagnostics now track refresh requests, coalescing, queued refreshes, state updates, bootstrap counts/reasons/sources, last and average refresh duration, expose `window.__LANTOR_REFRESH_METRICS__`, and persist metrics to `ui-refresh-metrics.jsonl`. | `src/main.tsx`, `src/components/DiagnosticsModal.tsx`, `src/components/DiagnosticsModal.test.tsx`, `src-tauri/src/main.rs`, `src-tauri/src/web.rs` | `npm test -- src/components/DiagnosticsModal.test.tsx` passed with 2 tests; source check confirmed debug object/backend write/duration fields; `cargo test ui_refresh_metrics --manifest-path src-tauri/Cargo.toml` passed with 3 tests; full `npm test` and `npm run build` passed. | Existing build large-chunk warning remains unrelated. |
| GAP-F17 | High-frequency stream/activity/run usage updates are batched/coalesced to reduce render pressure, including frontend buffered ephemeral updates and backend adjacent event coalescing. | `src/main.tsx`, `src-tauri/src/events.rs`, `src-tauri/src/usage.rs`, `src-tauri/src/main.rs` | Focused event batching/usage tests were added/run during implementation; later full `npm test` and `npm run build` passed. | None known. |
| GAP-F18 | Four-level UI text-size setting is implemented with shared options, storage validation, keyboard stepping/reset, app-level CSS variables, and Settings UI choices. | `src/chatTextSize.ts`, `src/chatTextSize.test.ts`, `src/components/SettingsModal.tsx`, `src/components/SettingsModal.test.tsx`, `src/main.tsx`, `src/styles.css` | `npm test -- src/chatTextSize.test.ts src/components/SettingsModal.test.tsx` passed with 5 tests; source check confirmed four levels/storage/style/shortcuts/shared Settings options; full `npm test` passed with 14 files / 108 tests; `npm run build` passed; Chrome rendered check confirmed `--type-size-message: 18px` produces `font-size: 18px`. | None known. |

## Final Verification Set

The latest cumulative verification evidence after completing GAP-F18:

- `npm test -- src/chatTextSize.test.ts src/components/SettingsModal.test.tsx`: passed, 2 files / 5 tests.
- `npm test`: passed, 14 files / 108 tests.
- `npm run build`: passed with the existing large-chunk warning.
- Chrome rendered sanity check: `--type-size-message: 18px` produced computed `font-size: 18px`.

Additional focused evidence retained from earlier gap closures:

- `npm test -- src/threadActivity.test.ts`: passed, 3 tests.
- `npm test -- src/components/DiagnosticsModal.test.tsx`: passed, 2 tests.
- `cargo test ui_refresh_metrics --manifest-path src-tauri/Cargo.toml`: passed, 3 tests.
- GAP-F14 fallback mobile visual verification with Chrome/CDP passed at `390x844`.

## Dylan Parity Restart Frontend Slice

This section tracks the restarted parity task against `upstream/main` `203a6ef984e374967338ac95f231a89aa70d33ee`, without replacing the completed GAP-F10 through GAP-F18 evidence above.

| Item | Status | Upstream evidence | Local implementation / evidence | Verification |
| --- | --- | --- | --- | --- |
| Draft image lightbox | Implemented | `3ec1da2` `Open draft image attachments in lightbox preview (#101)` | `src/components/DraftAttachmentsPreview.tsx` now opens draft image thumbnails in an isolated `attachment-lightbox`, supports backdrop/close/Escape/popstate close, and keeps remove clicks separate from preview clicks. Added `src/components/DraftAttachmentsPreview.test.tsx`. | `npm test -- src/components/DraftAttachmentsPreview.test.tsx` passed, 1 file / 2 tests. Full `npm test` passed, 15 files / 111 tests. `npm run build` passed with the existing large-chunk warning. |
| Thread root locate | Implemented | `9f899f2` `Locate thread root message in channel from thread panel (#104)` | `src/components/ThreadPanel.tsx` adds a Crosshair header action that calls `onLocateRoot`; `src/main.tsx` focuses the root message and closes the thread panel on mobile so the channel timeline is visible. | `npm test` and `npm run build` passed. Source check confirmed `onLocateRoot={locateThreadRoot}` and `data-jump-focused` reuse. |
| Task root open | Implemented | `8b9c534` `Scroll channel to task root when opening task (#105)` | `openTask` in `src/main.tsx` now focuses the task root message after revealing the task thread and switching to chat. | `npm test` and `npm run build` passed. Source check confirmed `focusMessage(task.message_id)` in `openTask`. |
| Locate from bottom fix | Implemented | `d887509` `Fix thread locate jump from channel bottom (#110)` | `src/components/Conversation.tsx` now cancels pending bottom-follow scrolls, temporarily disables follow mode, scrolls focused messages to center, and updates scroll metrics/back-to-bottom state. | `npm test` and `npm run build` passed. Source check confirmed focused-message scroll bypasses bottom-follow timers. |

Additional frontend-slice verification: `git diff --check` passed. The existing Vite server on `127.0.0.1:5173` returned HTTP 200 and the Lantor HTML shell. The in-app Browser backend was unavailable (`iab` not available), so no Browser visual smoke was captured for this slice.

## Dylan Parity Restart Desktop/Runtime UX Slice

This section tracks the second restarted parity implementation slice against `upstream/main` `203a6ef984e374967338ac95f231a89aa70d33ee`.

| Item | Status | Upstream evidence | Local implementation / evidence | Verification |
| --- | --- | --- | --- | --- |
| Main window size/position persistence | Implemented | `72eaa74` `Persist main window size and position (#93)` | `src-tauri/src/main.rs` now persists the main window outer size/position to `main-window-state.json`, restores it on startup, clamps restored geometry to the active monitor set, drops invalid saved state, and keeps first-launch config defaults when no saved state exists. | `cargo test --manifest-path src-tauri/Cargo.toml sanitize_window_state` passed, 2 tests. |
| Channel member incremental notification | Implemented | `7992a8b` `Notify UI on channel member changes (#99)` | `src-tauri/src/events.rs` adds `channel_member_upsert` and `channel_member_delete` UI events; `set_channel_agent_membership_in_pool` emits targeted membership events on real row changes instead of a broad membership refresh; `src/main.tsx` applies those events directly to `Bootstrap.channel_members` without breaking existing refresh coalescing. | `cargo test --manifest-path src-tauri/Cargo.toml ui_backend_event_payload_preserves_channel_member_events` passed, 1 test. `cargo test --manifest-path src-tauri/Cargo.toml channel_membership_emits_targeted_ui_events` passed, 1 test. |

## Dylan Parity Restart Context/Runtime Agent Slice

This section tracks the third restarted parity implementation slice against `upstream/main` `203a6ef984e374967338ac95f231a89aa70d33ee`.

| Item | Status | Upstream evidence | Local implementation / evidence | Verification |
| --- | --- | --- | --- | --- |
| `run-read` context tool | Implemented | `6a24048` `Add run-read context tool for Codex rotation` | `src-tauri/src/context_tool.rs` adds `run-read --run-id <uuid-or-prefix> --limit <chars>` with run metadata, bounded log output, and missing/ambiguous prefix errors. `src-tauri/src/prompts.rs` and `docs/agent-runtime.md` list the tool for agents. | `cargo test --manifest-path src-tauri/Cargo.toml run_read_context_tool` passed, 2 tests. |
| Claude reasoning effort | Implemented | `448ba43` `Support Claude reasoning effort in agent settings` | `src/components/AgentFormModal.tsx` exposes Intelligence for Claude as well as Codex; `src/components/AgentDetailDrawer.tsx` displays Claude intelligence; `src/main.tsx` preserves the setting on runtime changes; `src-tauri/src/main.rs` stores Claude reasoning effort and passes `--effort` only for non-default Claude runs. | `cargo test --manifest-path src-tauri/Cargo.toml claude_streaming_command_includes_non_default_effort_only` passed, 1 test. |
| Codex active-turn reaper | Implemented | `203a6ef` `fix: reap stalled codex turn that never completes` | `src-tauri/src/main.rs` now reaps both pre-turn-id stalls and post-turn-id silent active turns using the existing active-turn idle timeout, finalizing the run/work item and removing the warm runtime before waking the supervisor. | `cargo test --manifest-path src-tauri/Cargo.toml codex_active_turn_with_turn_id_reaps_only_after_idle_timeout` passed, 1 test. |

## Dylan Parity Restart Publish-Guard / Interrupted-Action Slice

This section tracks the final restarted parity implementation slice. The upstream publish-gate deletion in `c977822` is intentionally not ported because this workspace keeps the local `publish_guard` / `interrupted_action` architecture and only adapts recovery fixes that still apply.

| Item | Status | Upstream evidence | Local implementation / evidence | Verification |
| --- | --- | --- | --- | --- |
| Orphaned `interrupted_action` recovery | Implemented | `d947465` `fix: requeue orphaned interrupted_action inbox items`; related startup wake recovery in `f1ac0a3` | `src-tauri/src/publish_guard.rs` adds `recover_orphaned_interrupted_actions`, which detaches held buffers from terminal/missing work items, recreates or reopens their `interrupted_action` inbox item as unread, clears the dead work item link, preserves the held buffer, and emits a refresh. `src-tauri/src/main.rs` runs this after startup orphan-run cleanup. | `cargo test --manifest-path src-tauri/Cargo.toml orphaned_interrupted_action_is_requeued_without_dead_work_item` passed, 1 test. |
| Off-surface held replies in inbox context | Already covered with evidence | `72cbac8` `fix: surface off-surface held replies in inbox wake context` | Existing `src-tauri/src/inbox.rs` renders interrupted-action target, stream key, reason, versions, allowed actions, draft body, held event count, and resolve protocol from payload; the orphan recovery regression confirms the unread wake context includes target and stream key. | `cargo test --manifest-path src-tauri/Cargo.toml interrupted_action_context` passed, 2 tests. Orphan recovery test also checked target/stream key in wake context. |
| Control-only held output | Implemented / covered | `0a6fba6` `fix: consume split control-only held output`; `5302451` `Fix control-only streaming events bypassing publish gate` | Existing streaming finish/publish-guard paths hold visible control events as `visible_control_event` buffers. The regression now force-sends a held control-only `channel_message_create`, verifies the side effect is delivered exactly once, the raw held streaming message is gone, and the interrupted-action inbox item is archived. | `cargo test --manifest-path src-tauri/Cargo.toml streaming_event_only_buffer_advertises_side_effect_only_actions` passed, 1 test. |
| Side-effect-only revise guard | Already covered with evidence | `7fe2c45` `Guard revise resolution for side-effect-only interrupted actions (#98)` | Existing `InterruptedActionKind` / `allowed_actions` rejects `revise` for side-effect-only buffers before mutating state, preserving held visible events for `yield` or `force_send`. | `cargo test --manifest-path src-tauri/Cargo.toml side_effect_only_buffer_rejects_revise_and_preserves_held_events` passed, 1 test. |
| Publish gate revert | Intentionally not ported | `c977822` `Revert agent publish gate changes (#114)` | The local fork intentionally keeps `publish_guard` and `interrupted_action`; deleting that architecture would regress the local recovery protocol. | Source decision documented here; no code deletion performed. |
| Old held draft route | Intentionally not ported | Older `agent_held_drafts` / `held_draft_action` route from loose-line commits | The old held-draft storage/protocol is superseded locally by `agent_output_buffers` and `interrupted_action_resolve`. No old storage or route was revived. | Source decision documented here; no code added. |

## Dylan Parity Integrated Verification

Latest integrated verification after all four restarted Dylan parity slices:

- `cargo test --manifest-path src-tauri/Cargo.toml`: passed, 238 tests.
- `npm test`: passed, 16 files / 113 tests.
- `npm run build`: passed with the existing Vite large-chunk warning.
- `git diff --check`: passed.
- Local dev server smoke: `http://127.0.0.1:5173/` returned HTTP 200 and served the Lantor HTML shell.
- Browser visual smoke: attempted through the Codex in-app Browser plugin, but the `iab` backend was unavailable. Local Playwright was also unavailable, so visual verification remains covered by focused component tests, source checks, build, and the served HTML shell rather than an interactive browser capture.

During the first full Cargo run, two stale test expectations failed and were repaired before the successful integrated rerun:

- `bootstrap_loaders_keep_all_call_rows_in_chronological_order` now asserts the documented bootstrap cap while preserving chronological order of the retained newest call rows.
- `load_agent_activities_compares_mixed_timezone_timestamps_by_instant` now asserts all 81 inserted rows returned under the 160-row activity cap while still verifying the timezone ordering behavior.

## Upstream Commit Checkpoint

This checkpoint records the Dylan upstream commits used for the June 3, 2026 sync, so the next audit does not need to rediscover the range from chat history.

- Workspace: `/Users/xxhx/new_sort/lantor-long-task`
- Upstream remote: `upstream=https://github.com/chenzl25/lantor.git`
- Latest fetched upstream head: `64c4e587cd7ee49410008f8379c4ec2a11da4792`
- Previous parity audit head: `203a6ef984e374967338ac95f231a89aa70d33ee`
- Commit range reviewed after the earlier baseline: `7fe2c45..64c4e58`
- Important correction: `64c4e58` arrived after the earlier `203a6ef` audit and was ported as the mobile `/api/start_agent` endpoint.
- Remaining known parity item as of this checkpoint: `4c2139d` desktop message preview collapse threshold is still pending unless fixed in a later change.

| Upstream commit | Subject | Local status |
| --- | --- | --- |
| `7fe2c45` | Guard revise resolution for side-effect-only interrupted actions (#98) | Covered by local `publish_guard` / `interrupted_action` tests. |
| `3ec1da2` | Open draft image attachments in lightbox preview (#101) | Implemented in `DraftAttachmentsPreview`. |
| `72eaa74` | Remember window size across launches (#97) | Implemented in `main-window-state.json` window restore/persist logic. |
| `9f899f2` | Locate thread root message in channel from thread panel (#104) | Implemented with thread root locate action. |
| `7992a8b` | fix mobile member ui notifications | Implemented with targeted channel member UI events. |
| `473d0f0` | Fix publish gate stuck loop (#106) | Covered by local `publish_guard` recovery architecture. |
| `8b9c534` | Scroll channel to task root when opening task (#105) | Implemented in task open/focus flow. |
| `5302451` | Fix control-only streaming events bypassing publish gate (#107) | Covered by held visible control event tests. |
| `f1ac0a3` | fix: requeue orphaned inbox wake work on startup (#108) | Covered by startup/orphan recovery behavior. |
| `d947465` | fix: requeue orphaned interrupted_action inbox items | Implemented in `recover_orphaned_interrupted_actions`. |
| `72cbac8` | fix: surface off-surface held replies in inbox wake context | Covered by interrupted-action wake context evidence. |
| `34a7f8a` | fix: harden publish gate recovery edges (#109) | Covered by local recovery tests and architecture. |
| `d887509` | Fix thread locate jump from channel bottom (#110) | Implemented in focused-message scroll behavior. |
| `0a6fba6` | fix: consume split control-only held output (#112) | Covered by control-only held output force-send test. |
| `4c2139d` | fix: relax desktop message preview collapse | Pending: local thresholds still need parity with Dylan's 48 lines / 8000 chars behavior. |
| `6a24048` | Add run-read context tool for Codex rotation | Implemented as `run-read`. |
| `c977822` | Revert agent publish gate changes (#114) | Intentionally not ported; local fork keeps `publish_guard`. |
| `cdd0c4f` | Support selecting reasoning effort when creating Claude agents | Implemented for Claude reasoning effort. |
| `203a6ef` | fix: reap stalled codex turn that never completes | Implemented, then fixed with active-turn heartbeat refresh after review. |
| `64c4e58` | fix: enable mobile agent restart | Implemented by adding Web/mobile `/api/start_agent` routed to `start_agent_in_pool`. |

## Final Notes

- Do not continue the mistaken `lantor-long-task-voice` workspace; all work summarized here applies to `/Users/xxhx/new_sort/lantor-long-task`.
- Checklist item `2.10` can be closed against this document.
- Final delivery item `4.1` can cite this document plus the latest full test/build evidence.
