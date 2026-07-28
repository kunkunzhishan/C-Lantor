# 上游 Lantor 必要同步 Feature 评估

日期：2026-05-24

本文件只记录满足三个条件的上游更新：

1. 上游 `chenzl25/lantor` 已经做了；
2. 当前 fork `xxhZs/lantor-long-task` 没做，或只做了一部分；
3. 对系统行为、稳定性、可用性、性能或移动端体验有明确优化，值得同步。

纯重构、纯样式、文档更新、merge wrapper、以及当前 fork 已经独立实现的功能，不写入候选清单。

## 对比基准

- 本地项目：`/Users/xxhx/new_sort/lantor-long-task`
- 本地分支：`codex/new`
- 本地 HEAD：`c2a1c9f`，`Add long task founder mode option`
- 上游 ref：`upstream/main`
- 上游 HEAD：`c79e648`，`clippy`
- 共同祖先：`465be81`
- 分叉情况：本地有 23 个 fork-only commit；上游有 107 个本地没有的 commit。

注意：检查时本地工作区已有未提交改动。这里判断“有没有做”主要依据 commit 差异和当前源码中的实现痕迹，不把未提交脏改动当成稳定基线。

## 结论

不要直接 merge upstream。上游把后端拆成了大量模块，而且没有我们的 `long_task`、`founder mode`、voice/transcription 相关能力；整合 merge 会把这些 fork 功能卷进大冲突。

建议只同步下面这些 feature/优化点。优先级从高到低排列。

## P0：应该优先同步

### 1. 更健壮的 `LANTOR_EVENT` 控制事件解析

- 上游来源：`f3828f8`，PR `#68`，`Harden streaming control event parsing`
- 执行状态：已在当前工作区手动同步必要 parser/lifecycle 行为；保留在 P0 清单中作为完成记录和回归验证入口。
- 可追溯证据：
  - 上游引用：commit `f3828f8` / PR `#68`，行为参考为 hardened streaming control-event parsing，不直接套用上游重构。
  - 校正后的本地 gap：本 fork 已经有 `extract_agent_event_json`、JSON object boundary parsing、log-prefix support 和部分测试，旧候选文本把 gap 误写成“只有简单 exact-prefix parsing”。
  - 本地改动点：`src-tauri/src/main.rs` 中的 `strip_agent_event_prefix` / `find_agent_event_prefix` / terminal incomplete-tail stripping；支持 `LANTOR_EVENT` 后任意空白、下一行 JSON、JSON 后可见文本、false-positive 过滤。
  - 定向验证：`cargo test --manifest-path src-tauri/Cargo.toml agent_event -- --nocapture`、`control_event`、`incomplete_control`；并跑过 `cargo check --manifest-path src-tauri/Cargo.toml`、`cargo fmt --manifest-path src-tauri/Cargo.toml`、`git diff --check`。
  - 完成证据：parser 与 streaming lifecycle 测试覆盖严格前缀、日志前缀、JSON 后续文本、split/partial control event、裸 `LANTOR_EVENT` prose 和 `LANTOR_EVENTxxx` false positive。
- 当前 fork 现状：`src-tauri/src/main.rs` 已有上述 parser/lifecycle 修复，并补充了 parser 与 streaming lifecycle 测试。
- 上游做了什么：允许更稳健地识别控制事件，避免误把普通文本里的 `LANTOR_EVENTxxx` 当控制行，也能正确处理 JSON 对象后面跟可见文本、日志前缀、未完整输出的事件片段。
- 对系统的优化：降低 agent 输出被错误解析的概率，减少 side effect 丢失、错误创建任务/提醒/artifact、或把控制行泄露到聊天里的风险。
- 同步建议：已完成；后续改 streaming/message 生命周期时继续跑相关 parser 测试，避免协议层回退。

### 2. 修复 warm Codex 启动失败后的陈旧状态

- 上游来源：`24b884c`，PR `#75`，`Fix stale warm Codex start state`
- 当前 fork 状态：已在当前工作区手动同步必要 pre-turn cleanup 行为。
- 当前 fork 现状：`src-tauri/src/main.rs` 已有 `cleanup_failed_warm_codex_start`，并在 warm Codex run/work item 标记为 running 之后、`CodexActiveTurn` 建立之前的失败路径中调用。
- 上游做了什么：如果 warm Codex 在 turn start 前失败，会把 run 标 failed，按情况把 work item 重新排队或标 failed，并恢复 agent 状态，防止 UI 和调度器卡住。
- 本地改动点：`ensure_streaming_agent_message`、`effective_codex_cwd`、runtime already-exited、runtime became-busy 这几类 pre-active 失败不再直接返回；它们会终止当前 run 状态、恢复 work item，并记录 activity。busy-before-start 保留现有 active turn，把新 work item 重新排队；不可恢复的 start failure 把 work item 标 failed、agent 标 error。
- 定向验证：`cargo test --manifest-path src-tauri/Cargo.toml busy_warm_codex_start -- --nocapture` 与 `cargo test --manifest-path src-tauri/Cargo.toml failed_warm_codex_start -- --nocapture` 覆盖 requeue 与 terminal failure 两条路径。
- 对系统的优化：减少“任务看起来还在跑但实际 runner 死了”的情况。我们现在有 long-task/founder，这类长运行流程尤其需要这个修复。
- 同步建议：已完成；后续改 warm Codex turn lifecycle 时保留“pre-active cleanup”和“active-turn finish”两类路径的边界。

### 3. 隐藏 Codex 中间 draft 回复

- 上游来源：`ddfc2dd`，PR `#86`，`Hide intermediate Codex draft replies`
- 当前 fork 状态：已在当前工作区手动同步必要 streaming lifecycle 行为。
- 当前 fork 现状：`src-tauri/src/main.rs` 已有 `completed_agent_message_stream_keys`、deferred completion/deferred mentions、same-run intermediate message deletion，并保留现有空 placeholder、silent reply、control event 消费能力。
- 本地改动点：Codex `agentMessage` delta/completed 使用 deferred streaming completion；非 agentMessage item started/completed 时删除同 run 已输出的中间 draft；turn finish 只对最终 completed agent message 触发 mention dispatch，避免 draft 提前派活或污染聊天。
- 定向验证：`cargo test --manifest-path src-tauri/Cargo.toml streaming_ -- --nocapture`、`cargo test --manifest-path src-tauri/Cargo.toml deferred_final_reply_dispatches_mentions_only_after_turn_finish -- --nocapture`、`cargo test --manifest-path src-tauri/Cargo.toml deferred_truncated_intermediate_reply_stays_streaming_until_deleted -- --nocapture`、`cargo test --manifest-path src-tauri/Cargo.toml codex_deleted_intermediate_reply_does_not_dispatch_mentions_or_leave_artifacts -- --nocapture` 覆盖中间 draft 删除、truncated deferred draft 生命周期、最终 reply 保留、deferred mention dispatch、已删除 draft 不派发 mention、control event/silent reply 生命周期。
- 上游做了什么：区分真正最终回复和 Codex 中间 draft，把中间 draft 留在运行过程内部，不作为普通聊天消息污染会话。
- 对系统的优化：聊天界面更干净，长任务/founder 多轮内部思考不会把用户可见线程刷成一堆半成品。
- 同步建议：已完成；后续改 warm Codex streaming 时保留“中间 draft 可删除、最终 reply 才 dispatch mention”的边界。

### 4. error 状态 agent 暂停接新任务

- 上游来源：`b9b5288`，PR `#52`，`Pause dispatch to error agents`
- 当前 fork 状态：已在当前工作区手动同步必要 dispatch guard。
- 当前 fork 现状：`src-tauri/src/main.rs` 已有统一 `agent_accepts_new_work`，并用于 manual dispatch、queued scheduling、inbox wake、task assignment/claim/forward/reassign、task availability、task/handoff control events、reminder/schedule wake；`src-tauri/src/dispatch.rs` 的 thread/channel auto-target 查询也排除 error agent。
- 本地改动点：error agent 不再生成新的 supervisor start command，不再接 owner channel root/mention 自动派发，不再被手动 claim/forward/reassign/handoff 选为新 work target；manual `start_agent` 保留作为用户恢复入口。
- 定向验证：`cargo test --manifest-path src-tauri/Cargo.toml error_agent -- --nocapture`、`cargo test --manifest-path src-tauri/Cargo.toml task_handoff_rejects_error_target_agent_without_reassigning -- --nocapture` 覆盖 error-agent auto dispatch、queued scheduling、manual claim、task handoff guard。
- 上游做了什么：手动 dispatch、task assignment、unassigned task availability 都避开 error agent；用户会看到更明确的错误。
- 对系统的优化：避免把新任务持续塞给坏掉的 agent，减少队列堆积和重复失败。
- 同步建议：已完成；后续新增 dispatch 入口时先接入 `agent_accepts_new_work` 或显式说明它是恢复入口。

#### Milestone A validation（2026-05-24）

- 覆盖范围：复核 P0 1-4 与当前 `src-tauri/src/main.rs` / `src-tauri/src/dispatch.rs` / focused tests 的实现对应关系；确认本 fork 的 long_task / founder / voice / todo 相关能力没有被上游重构式替换。
- 验证结果：`agent_event`、`control_event`、`incomplete_control`、`busy_warm_codex_start`、`failed_warm_codex_start`、`supervisor_warm_codex_pre_active_failure`、`streaming_`、`deferred_final_reply_dispatches_mentions_only_after_turn_finish`、`deferred_truncated_intermediate_reply_stays_streaming_until_deleted`、`codex_deleted_intermediate_reply_does_not_dispatch_mentions_or_leave_artifacts`、`error_agent`、`task_handoff_rejects_error_target_agent_without_reassigning` focused tests 均通过。
- 结论：Milestone A P0 覆盖可视为已完成；下一步进入 P0 5-8（Milestone B）前无需再补 A 组实现，除非后续 review 指出新增 dispatch/streaming 入口未接入现有 guard。

### 5. progress-only 完成消息不计入未读

- 上游来源：`55c7118`，PR `#74`，`Exclude progress-only messages from channel unread`
- 当前 fork 状态：已在当前工作区手动同步 unread 侧可见消息语义。
- 当前 fork 现状：`load_channels` 通过后端 `backend_visible_message_sql("m")` 统一排除 complete 状态、空 body、有 stream_key、且没有附件/artifact 的进度消息；空 body 但有附件或 artifact 的消息仍计入未读。
- 上游做了什么：把这类“只有进度意义、没有用户可读内容”的 complete 消息排除在 channel unread 之外。
- 对系统的优化：避免 long-task/founder 的进度消息把频道刷成未读，降低误提醒。
- 本地验证：`channel_unread_count_ignores_progress_only_completed_messages` 覆盖 progress-only complete 不计入、streaming 不计入、普通文本计入、空 body 附件/artifact 仍计入；保留为 P0 8 thread activity 复用入口。

### 6. DM 附件事件可以用 agent id 解析到 DM channel

- 上游来源：`14289cf`，`Fix DM attachment file handling`
- 当前 fork 状态：已手动同步。
- 当前 fork 现状：`resolve_event_channel` 传入 `channel_id` 时优先查 `channels.id = channel_id`，找不到真 channel 时会在 DM 场景下按 `channels.kind = 'dm' and dm_agent_id = channel_id` 解析；如果 control event 在 DM 里误传/沿用 agent id，附件/产物事件仍能落到正确 DM channel。
- 上游做了什么：`channel_id` 既可以是真 channel id，也可以在 DM 场景下解析为 `channels.kind = 'dm' and dm_agent_id = channel_id`。
- 对系统的优化：agent 在 DM 中创建附件更可靠，尤其是生成图片、报告、patch、录音转写产物时不容易失败。
- 本地验证：`attachment_create_event_accepts_dm_agent_id_as_channel_id` 覆盖 attachment control event 把 agent id 放入 `channel_id` 时仍解析到该 agent 的 DM channel 并持久化附件。

### 7. 移动端 web streaming 延迟修复

- 上游来源：open PR `#8`，`Fix mobile web streaming reply latency`
- 当前 fork 状态：已手动同步。
- 当前 fork 现状：`web.rs` 的 `/api/events` SSE response 明确设置 `Cache-Control: no-cache, no-store, must-revalidate, no-transform`、`Pragma: no-cache`、`Expires: 0`、`Connection: keep-alive`、`X-Accel-Buffering: no`；共享前端 progress-only 过滤只隐藏仍无可见内容的 run-id streaming/complete 消息；主聊天和 thread 面板在 streaming message 已有非空可见 body 时立即渲染 markdown，不再等 delivery_state 变成 complete。
- 上游做了什么：移动端 web 里更早显示 agent streaming 回复，同时给 SSE endpoint 加防缓存、防转换、防代理缓冲的 headers。
- 对系统的优化：手机/Tailscale/代理路径下，agent 回复不会长时间憋住才出现。
- 本地验证：`cargo test --manifest-path src-tauri/Cargo.toml sse_no_buffer_headers_disable_client_and_proxy_buffering -- --nocapture` 覆盖 SSE 防缓冲 headers；临时编译并执行 `message-grouping.ts` 覆盖 valid run-id streaming empty 仍过滤、valid run-id streaming non-empty body/attachment/artifact 不过滤、complete empty 仍过滤、owner/system/invalid stream key 不过滤；`npm run build` 覆盖 streaming body 渲染改动的 TypeScript/build 集成。

### 8. thread unread/latest visible activity 后端数据

- 上游来源：open PR `#89`，`Add backend thread unread activity bootstrap data`
- 当前 fork 状态：已手动同步。
- 当前 fork 现状：`load_bootstrap` 现在返回 `thread_activities`，后端按共享 visible-message 语义计算每个 thread 的 `reply_count`、`unread_count`、`latest_visible_message_id` 和 `latest_visible_at`；前端类型和 thread entry/activity feed 入口消费该 bootstrap 数据，同时打开 thread 时持久化 `thread:<root_id>` read marker，避免刷新后未读 badge 回弹。
- 上游做了什么：后端给每个 thread 计算未读数和最新可见活动，并沿用 progress-only 消息隐藏规则。
- 对系统的优化：线程列表、activity feed、移动端 thread 入口能更准确地显示“哪个 thread 真有新内容”。
- 本地验证：`cargo test --manifest-path src-tauri/Cargo.toml thread_activity_bootstrap_counts_unread_latest_visible_replies -- --nocapture` 覆盖 thread bootstrap 忽略 progress-only reply、附件/非空 streaming reply 计入可见活动、owner reply 不增加未读、latest 指向最新可见 reply；`cargo test --manifest-path src-tauri/Cargo.toml channel_unread_count_ignores_progress_only_completed_messages -- --nocapture` 回归共享 visible SQL 仍保持 channel unread 语义；`npm run build` 覆盖 typed bootstrap/frontend entry surface 集成。

## P1：建议同步，但可以排在 P0 后面

### 9. activity feed 未读优先排序和未读高亮

- 上游来源：`e9b8b29`，PR `#73`，`Sort activity feed unread items first`
- 当前 fork 状态：未做。
- 当前 fork 现状：`ActivityFeedModal` 直接使用传入 items，没有 `sortActivityFeedItems`，未读项不会稳定排在前面。
- 上游做了什么：activity feed 打开时先显示未读，再按时间排序；thread 未读行有更明显的新活动提示。
- 对系统的优化：用户能优先处理真正需要注意的 agent 回复、thread 更新、任务提醒。
- 同步建议：在未读语义修正后同步，否则排序会放大错误未读的噪音。

### 10. thread feed 按最新回复排序

- 上游来源：`c27bc1b`，PR `#66`，`Sort thread feed items by latest reply`
- 当前 fork 状态：未做完整版本。
- 当前 fork 现状：已有 `threadReplySummaries` 前端聚合，但没有看到上游的 thread feed 最新回复排序策略完整落地。
- 上游做了什么：有新回复的 thread 会按最新回复时间上浮，而不是只按 root message 的时间。
- 对系统的优化：长讨论或 agent 后续回复不会沉在旧位置，降低漏看。
- 同步建议：和第 8 项后端 thread activity 一起做，避免前后端排序语义冲突。

### 11. 频道创建/改名禁止重复名称

- 上游来源：`7fe18c0`，`ban duplicate channel name & fix agent page`
- 当前 fork 状态：未做完整版本。
- 当前 fork 现状：`create_channel_in_pool` 使用 `on conflict(name) do update`，重复创建会复用/修改旧频道；`update_channel_in_pool` 也没有先检查目标名称是否已被其他频道占用。
- 上游做了什么：重复频道名直接拒绝，避免误把“新建频道”变成“改旧频道描述”。
- 对系统的优化：频道是 agent 协作和任务上下文边界，重复名复用会导致上下文混淆。
- 同步建议：同步名称可用性检查，并确认现有数据迁移不会破坏已有频道。

### 12. 桌面聊天滚动跟随修复

- 上游来源：`f572a70`，`Fix desktop message bottom-follow behavior`
- 当前 fork 状态：未做完整版本。
- 当前 fork 现状：`Conversation` 和 `ThreadPanel` 有自动滚动逻辑，但未包含上游完整的 bottom-follow 修复。
- 上游做了什么：只有用户本来在底部时才跟随新消息；读历史时不强行把滚动拉回底部。
- 对系统的优化：agent 长输出时阅读历史不被打断。
- 同步建议：和 streaming/draft 相关 UI 改动一起 port，避免重复改滚动状态。

### 13. 搜索结果 pane 关闭行为修复

- 上游来源：`8e603ac`，`Fix search result pane close behavior`
- 当前 fork 状态：未做。
- 上游做了什么：修搜索结果打开/关闭后的 pane 状态，避免残留错误视图。
- 对系统的优化：搜索跳转后界面状态更可预测。
- 同步建议：小修，低风险，可穿插同步。

### 14. 移动端图片预览与频道布局优化

- 上游来源：`88d792b` / PR `#72`，`3f025f5`
- 当前 fork 状态：未做完整版本。
- 当前 fork 现状：`MessageAttachments` 里的 lightbox 没有上游的 mobile safe-area、stopPropagation、popstate 关闭等处理。
- 上游做了什么：移动端图片预览不会和 thread open 手势冲突，关闭按钮和图片高度适配手机安全区。
- 对系统的优化：手机上看 agent 生成图片/附件更稳定。
- 同步建议：先检查与我们 voice/mobile composer 的 CSS 是否冲突，再同步。

### 15. thread 底部跟随和回到底部按钮位置优化

- 上游来源：`d9a04da` / PR `#48`，`dda4ca3` / PR `#49`
- 当前 fork 状态：未做完整版本。
- 上游做了什么：当用户在 thread 底部时保持 follow；“回到底部”按钮放到滚动区域外，避免被内容挤压。
- 对系统的优化：线程里 agent 连续回复时更不容易漏消息，按钮也更稳定。
- 同步建议：和第 12 项一起处理。

## P2：有价值，但不急

### 16. UI refresh metrics / Diagnostics

- 上游来源：open PR `#46`，open PR `#47`
- 当前 fork 状态：未做。
- 上游做了什么：Settings 里加 UI refresh metrics；同时把刷新原因、频率、耗时写入 `ui-refresh-metrics.jsonl`，并暴露浏览器调试对象。
- 对系统的优化：定位“为什么 UI 一直刷新、为什么输入卡顿、为什么 stream 很慢”会更容易。
- 同步建议：适合性能专项时同步。它本身不是用户主流程功能，所以排 P2。

### 17. 高频 stream/activity/run usage 更新批处理

- 上游来源：open PR `#83`，`Batch ephemeral UI updates from stream, activity, and run usage`
- 当前 fork 状态：未做。
- 上游做了什么：把 `stream_event_consumed`、`superseded_progress_status`、`activity_upsert`、`run_usage` 这类短时间内高频更新合并到约 50ms 窗口。
- 对系统的优化：减少前端 render 压力，尤其 agent 流式输出、长任务频繁 activity 时更有用。
- 同步建议：先同步 P0 的 streaming 正确性，再做这个性能优化；否则 batching 可能掩盖生命周期 bug。

### 18. 4 档 UI 字号设置

- 上游来源：`31ab7f0`，PR `#35`，`Add 4-step UI text scale setting`
- 当前 fork 状态：未做。
- 上游做了什么：Settings 增加文字大小档位，CSS 用变量统一控制。
- 对系统的优化：可读性和可访问性更好，尤其移动端或长文本 agent 输出。
- 同步建议：可在 UI polish 阶段同步；不是运行正确性问题。

## 已确认不写入同步候选的类型

以下上游更新我看过，但不放入必要同步清单：

- 后端大拆分：`runtime/*`、`events/*`、`commands/*`、`agent_work_dispatch.rs`、`db.rs` 等模块化改动。它们是架构重构，不是单独 feature；直接同步会和我们的 `long_task` / `founder` / voice 大冲突。
- 主题 token 大迁移和 raw color CI：有价值，但主要是设计系统治理，不是当前要同步的 feature。
- README、截图、纯 docs、merge commit、`clippy`、纯边框/hover/padding 样式。
- 当前 fork 已经做过或基本等价的功能：composer draft 按 channel/thread 隔离、manual agent start/backend start 命令、基础 unread_count、基础 streaming placeholder 删除、voice/transcription 相关能力。

## 建议执行顺序

1. 先同步 P0 的 1-4：控制事件解析、warm Codex start 清理、隐藏中间 draft、error agent 暂停派活。
2. 再同步 P0 的 5-8：progress-only 未读、DM 附件解析、移动端 streaming、thread unread/latest activity。
3. 再处理 P1 的 thread/activity/feed/滚动/搜索/移动端附件体验。
4. 最后按需要做 P2 的 diagnostics、ephemeral update batching、字号设置。

## 2026-06-17 每日上游检查

- 检查范围：`c6955075859ee22a44fb21afd54b0452799a30aa..upstream/main`
- fetch 后 upstream HEAD：`c6955075859ee22a44fb21afd54b0452799a30aa` (`Add --surface-recessed and migrate modal/avatar tokens (#119)`)
- 新增 commit：0
- 新增 feature 候选：无
- 同步动作：不创建 `USYNC-0016`；cursor 仍保持 `c6955075859ee22a44fb21afd54b0452799a30aa`。
- 备注：提醒中的旧 `/Users/xxhx/new_sort/lantor-long-task-voice` 目录已不存在；本次记录写入现存 `/Users/xxhx/new_sort/lantor-long-task/docs/`。

## 2026-06-18 每日上游检查

- 检查范围：`c6955075859ee22a44fb21afd54b0452799a30aa..upstream/main`
- fetch 后 upstream HEAD：`c6955075859ee22a44fb21afd54b0452799a30aa` (`Add --surface-recessed and migrate modal/avatar tokens (#119)`)
- 新增 commit：0
- 新增 feature 候选：无
- 同步动作：不创建 `USYNC-0016`；cursor 仍保持 `c6955075859ee22a44fb21afd54b0452799a30aa`。
- 备注：提醒中的旧 `/Users/xxhx/new_sort/lantor-long-task-voice` 目录已不存在；本次记录写入现存 `/Users/xxhx/new_sort/lantor-long-task/docs/`。

## USYNC-0016（2026-06-19）

- 检查范围：`c6955075859ee22a44fb21afd54b0452799a30aa..03a15b22983e4eeafb635d9028972b24809ed621`
- 新增 commit：6 个非 merge commit
- upstream HEAD：`03a15b22983e4eeafb635d9028972b24809ed621` (`Add web-only dev mode (#125)`)

### USYNC-0016-F01：Markdown 表格渲染与横向滚动稳定化

- 上游来源：`def95db` (`Polish markdown table rendering (#120)`)
- 上游做了什么：为 Markdown 表格增加专门的 scroll wrapper、边框/聚焦样式、单元格换行策略，并用 `scrollKey` 保存表格横向滚动位置，避免父组件重渲染后表格横向滚动被重置。
- 当前 fork 状态：未同步。当前 `MessageMarkdown.tsx` 没有 `markdown-table-scroll` / `tableScrollPositions` / `scrollKey` 机制，Conversation/ThreadPanel 调用也未传表格滚动 key。
- 价值：agent 输出宽表格、评估矩阵、价格表或日志表时，移动端/窄屏阅读更稳；重渲染不会把用户正在横向查看的表格拉回开头。
- 同步建议：P1 UI 可读性。和 markdown/link 相关改动冲突面中等，需注意本 fork 已有 `agentMentionLabels`、`onLocalLink` 等本地扩展。

### USYNC-0016-F02：composer 高度变化时减少底部跟随抖动

- 上游来源：`7c6d93f` (`Fix follow-bottom jitter on composer growth (#121)`)
- 上游做了什么：Conversation/ThreadPanel 区分内容 resize 与 viewport-only resize；当 composer 增高只改变可视区高度、scrollHeight 不变时，只更新 metrics，不强制 scroll-to-bottom。
- 当前 fork 状态：未同步。当前 `Conversation.tsx` / `ThreadPanel.tsx` 的 `ResizeObserver` 仍直接调用 `keepBottomVisible()`，没有 `isMessageListViewportOnlyResize` / `isThreadViewportOnlyResize` 判断。
- 价值：输入框换行、附件/语音控件展开时，聊天列表底部不再反复跳动；长回复阅读时不容易被 composer 布局变化打断。
- 同步建议：P1。可单独 port，风险较低，但要回归 channel/thread 自动跟随和“回到底部”按钮。

### USYNC-0016-F03：侧边栏、频道标题和品牌区域视觉整理

- 上游来源：`007140b` (`Polish sidebar navigation layout (#122)`)、`f31eb9f` (`Enlarge channel header hash icon (#123)`)、`ad2cda6` (`Align sidebar brand label (#124)`)
- 上游做了什么：简化侧边栏 scroll/layout 和 quick actions 样式，移除 sidebar section resize handle / raw color baseline 旧项，调整 channel/dm 行高与圆角；频道标题 hash icon 变大，品牌 label 对齐微调。
- 当前 fork 状态：未同步完整版本。当前 fork 侧边栏结构和样式已有本地改动，仍保留旧 quick action/card 化样式、section resize 逻辑和较小 header icon。
- 价值：降低侧边栏视觉噪音和布局复杂度，让导航更像稳定产品 UI。
- 同步建议：P2 UI polish。建议先截图对比本 fork 当前移动/桌面状态，再选择性 port，避免覆盖本地 voice/tool-browser 相关布局。

### USYNC-0016-F04：Web-only dev mode / 无桌面窗口后端模式

- 上游来源：`03a15b2` (`Add web-only dev mode (#125)`)
- 上游做了什么：新增 `--web-only` 入口，把 DB 初始化、supervisor、web server、reminder worker、ui event pruner 抽成共享 backend；新增 `npm run web:backend` 和 `npm run web:dev`；Vite dev server 代理 `/api` 到本地 web backend；README 补浏览器开发流程。
- 当前 fork 状态：未同步。当前 `package.json` 没有 `web:backend` / `web:dev`，`vite.config.ts` 没有 `/api` proxy，`src-tauri/src/main.rs` 没有 `--web-only` 分支。
- 价值：可以只跑浏览器 UI + 本地后端，不打开 Tauri 桌面窗口；适合移动 Web、远程访问、Chrome/browser surface 和前端热更新调试。
- 同步建议：P0/P1 之间。它和我们正在讨论的 Browser Surface / View Tools / Chrome 插件路线高度相关，建议优先评估移植，但要确认不要和当前 Lantor 运行实例抢同一个 SQLite/supervisor owner。

## USYNC-0017（2026-06-22）

- 检查范围：`03a15b22983e4eeafb635d9028972b24809ed621..8251c349021df86fc1b8e7e1d29d3cf07a0530d2`
- 新增 commit：10 个非 merge commit
- upstream HEAD：`8251c349021df86fc1b8e7e1d29d3cf07a0530d2` (`Fix local mention link boundaries (#134)`)

### USYNC-0017-F01：图片附件缩略图显示设置与附件卡片整理

- 上游来源：`817bf0a` (`Add image thumbnail display setting (#126)`)、`1ff2f47` (`Add lightbox image zoom (#130)`)、`2626120` (`Polish attachment tile layout (#129)`)
- 上游做了什么：Settings 增加图片缩略图显示开关；图片附件可在缩略图和紧凑文件卡之间切换；lightbox 支持更完整的图片预览/缩放体验；附件 tile 样式统一化。
- 当前 fork 状态：部分已有。当前 `MessageAttachments.tsx` 已有基础图片 lightbox，但没有 `showImageThumbnails` 设置、紧凑图片卡模式，也没有上游这一轮的 tile polish/zoom 完整样式。
- 价值：图片多的 thread 不会被大缩略图撑开；同时需要看图时仍能打开大图预览。对移动端和截图/附件密集工作流比较有用。
- 同步建议：P1。建议和现有 `DraftAttachmentsPreview` lightbox 测试一起评估，避免破坏本 fork 已有的附件预览行为。

### USYNC-0017-F02：设置项 label 间距微调

- 上游来源：`76afdf7` (`Add spacing below settings field labels`)
- 上游做了什么：给 Settings 表单 label 增加更清楚的下间距。
- 当前 fork 状态：未单独同步。
- 价值：低风险 UI polish，改善 Settings 可读性。
- 同步建议：P3，可并入下一次设置页/视觉整理，不建议单独排期。

### USYNC-0017-F03：关闭 composer 输入建议

- 上游来源：`cdc354a` (`Disable composer writing suggestions (#128)`)
- 上游做了什么：在 Conversation 和 ThreadPanel composer 输入框上关闭浏览器写作建议/自动修正类行为。
- 当前 fork 状态：未同步。当前只在部分表单输入如 Create Channel 里有 `autoCorrect="off"` / `spellCheck={false}`，主 composer 仍缺对应处理。
- 价值：减少浏览器/系统输入建议对 agent prompt、代码片段、路径和命令的干扰。
- 同步建议：P1，改动小且风险低，可优先同步。

### USYNC-0017-F04：thread mention / inbox wake 上下文恢复加强

- 上游来源：`641a417` (`Clarify thread mention history prompt (#131)`)、`ad84ba6` (`Fix inbox wake thread context recovery`)
- 上游做了什么：明确 agent 第一次被拉进已有 thread 时必须读 thread history；修复 inbox wake 恢复 thread context 时的上下文注入边界，并补测试覆盖。
- 当前 fork 状态：部分已有提示语。本 fork prompt 已有“current injected thread context and memory”要求，但 `agent_inbox_wake.rs` 仍未见上游这轮针对 first mention/thread recovery 的完整逻辑和测试。
- 价值：减少 agent 在长 thread 里只看最新 mention 就误判上下文的问题；也能降低 warm runtime 跨 surface 旧上下文污染。
- 同步建议：P0/P1。和 Lantor 当前多 thread 调度可靠性直接相关，建议优先审计并按本 fork 的 prompt/policy 拆分结构适配。

### USYNC-0017-F05：Markdown 数学公式渲染与本地 mention 边界修复

- 上游来源：`b9bd2f5` (`Add markdown math rendering`)、`8251c34` (`Fix local mention link boundaries (#134)`)
- 上游做了什么：引入 `remark-math` / `rehype-katex` / `katex`，支持 Markdown 数学公式渲染，禁用单美元内联数学；同时修复折叠预览渲染、fenced block 检测和本地 `@agent`/`#channel` mention linkify 边界。
- 当前 fork 状态：未同步数学公式依赖。当前 `MessageMarkdown.tsx` 只有 `remark-gfm`；已有本地 linkify 和 inline/fence 分段逻辑，但还没有上游这轮的边界修复。
- 价值：agent 输出公式、模型推导、量化/统计分析时可读性更好；mention 边界修复能避免代码/路径/标点附近误链接或漏链接。
- 同步建议：P1。数学公式是新增依赖，需评估 bundle 体积和样式；mention 边界修复可优先单独 port。

### USYNC-0017-F06：Modal 可通过背景/Escape 关闭

- 上游来源：`b97355e` (`Make modals dismissible (#133)`)
- 上游做了什么：移除多个 Modal 的 `closeOnBackdrop={false}` / `closeOnEscape={false}`，并给 SearchModal 补关闭按钮，让 modal 行为更符合常规桌面/Web 预期。
- 当前 fork 状态：未同步。当前 `AgentFormModal`、`ChannelSettingsModal`、`CreateChannelModal`、`OwnerProfileModal`、`ReminderModal` 等仍显式禁用 backdrop/Escape 关闭。
- 价值：提升日常操作效率，尤其移动/窄屏下更容易退出弹窗。
- 同步建议：P2。需要先确认未保存表单是否有丢失风险；对创建 agent/channel、提醒编辑这类表单，可能需要 dirty-state 确认而不是直接照搬。

## USYNC-0018（2026-06-23）

- 检查范围：`8251c349021df86fc1b8e7e1d29d3cf07a0530d2..4363d861d5878dbe31a009c85be9ce56cbc723c4`
- 新增 commit：1 个非 merge commit
- upstream HEAD：`4363d861d5878dbe31a009c85be9ce56cbc723c4` (`Add thread expand and fold controls (#135)`)

### USYNC-0018-F01：Thread 面板一键展开/折叠长消息

- 上游来源：`4363d86` (`Add thread expand and fold controls (#135)`)
- 上游做了什么：在 `ThreadPanel` 顶部工具区新增 expand all / fold all 按钮，复用长消息折叠判断，批量展开或折叠当前 thread 中所有非 streaming 且超过预览阈值的长消息；按钮用 `Maximize2` / `Minimize2` 图标和 tooltip 展示状态，并在无可折叠消息或已经全展开/全折叠时变为弱化不可操作状态。
- 当前 fork 状态：未同步。当前本 fork 有 per-message 的长消息展开/折叠和 `expandedThreadMessageIds` 状态，但 thread header 只有 locate root / close 等按钮，没有批量展开/折叠入口。
- 价值：长 thread 中包含多个长 agent 回复、日志或分析报告时，可以一次性展开阅读全文，也可以快速折叠回扫描模式，减少逐条点击。
- 同步建议：P1。改动集中在 `ThreadPanel.tsx` 和 thread header tooltip CSS，风险较低；同步时要注意本 fork 已有 thread header/resizer/移动端返回按钮样式，避免按钮在窄屏溢出。

## USYNC-0019（2026-06-24）

- 检查范围：`4363d861d5878dbe31a009c85be9ce56cbc723c4..4e44ddaa6cdacd0543715cbd8326ae421f316cff`
- 新增 commit：3 个非 merge commit
- upstream HEAD：`4e44ddaa6cdacd0543715cbd8326ae421f316cff` (`fix(dev): pin vite dev server port`)

### USYNC-0019-F01：Thread SVG 导出与附件下载能力

- 上游来源：`b9db941` (`Add thread SVG export and attachment downloads (#136)`)
- 上游做了什么：新增 `thread-svg-export.ts`，在 Thread 面板提供 SVG 导出入口；桌面端新增 `download_attachment` Tauri command，把本地 attachment 文件复制到 Downloads，并对文件名做安全清理和重名避让；前端 `MessageAttachments` 为图片/文件卡和 lightbox 增加下载按钮。
- 当前 fork 状态：未同步。当前 fork 没有 `src/thread-svg-export.ts`，`ThreadPanel` 未见 SVG 导出入口，`apiClient.ts` 没有 `downloadAttachment`，`src-tauri/src/main.rs` 仍只有 attachment asset serving，没有桌面下载命令；`MessageAttachments.tsx` 也只有打开/预览附件，没有下载按钮。
- 价值：可以把长 thread 离线归档成 SVG，也能把 agent/owner 附件从应用存储明确下载到本机 Downloads，适合审阅、转发、留证和长期保存。
- 同步建议：P1。附件下载改动有明确用户价值且范围可控；SVG 导出涉及消息渲染快照和样式一致性，建议先单独 port 下载，再评估 SVG 导出的渲染质量和中文/长文本/附件展示。

### USYNC-0019-F02：桌面附件下载反馈 Toast

- 上游来源：`86f9d06` (`Add desktop attachment download feedback (#138)`)
- 上游做了什么：在 attachment 下载成功后显示 `Saved to Downloads: ...`，失败时显示错误 toast；toast 会自动消失，也可手动 dismiss；同时把 lightbox 下载按钮和 attachment 下载 hover 样式改为语义 token。
- 当前 fork 状态：未同步。当前 `MessageAttachments.tsx` 没有 `DownloadNotice`/toast 状态，`styles.css` 没有 `attachment-download-toast` 相关样式。
- 价值：桌面下载不再是静默动作，用户能知道文件是否真的落盘以及保存后的文件名；失败时也能直接看到原因。
- 同步建议：P1，建议和 `USYNC-0019-F01` 的下载命令一起同步；如果只做浏览器端下载，toast 仍可复用，但桌面成功路径需要 Tauri command 返回目标路径。

### USYNC-0019-F03：固定 Vite dev server 地址和端口

- 上游来源：`4e44dda` (`fix(dev): pin vite dev server port`)
- 上游做了什么：在 `vite.config.ts` 里设置 `server.host = "127.0.0.1"`、`port = 5173`、`strictPort = true`，避免 dev server 随机换端口或监听范围不明确。
- 当前 fork 状态：已具备。本地 `vite.config.ts` 当前已经包含这三个配置。
- 价值：Web-only/dev proxy、本地浏览器和工具浏览器调试时 URL 稳定，不会因为端口漂移导致后端代理或自动化脚本失效。
- 同步建议：已满足；只记录为本轮 upstream 维护项，不需要再单独 port。
